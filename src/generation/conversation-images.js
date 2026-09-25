import { createHash } from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../public/scripts/neconyan-conversation/constants.js';
import { formatPromptText } from '../../public/scripts/neconyan-conversation/shared-helpers.js';
import { buildSelfieImagePromptTemplate } from '../../public/scripts/neconyan-conversation/generation-utils.js';
import { isConversationGroupSpeakerEligible } from '../../public/scripts/neconyan-conversation/partners-utils.js';
import { parsePositiveInt } from '../endpoints/conversation-utils.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { appendConversationJobMessage, applyConversationBookkeeping, assertConversationEffectSource, commitConversationEffect, readConversationEffectReceipt, readConversationTarget } from './conversation-effects.js';
import { captureConversationRoleplaySource } from './conversation-roleplay-source.js';
import { saveQuickImageToUserImages } from './quick-image-gen.js';
import { generateQuickImageGenJobImage } from './quick-image-gen-job.js';
import { prepareConversationScopedImagePrompt } from './quick-image-gen-scoped.js';
import { withRoleplayAccount } from '../roleplay-store.js';

const IMAGE_KEYWORDS = /\b(send\s*pic|selfie|photo|image|picture|show\s*me)\b/i;
const SELFIE_SCENE = 'a casual selfie in the current moment';
const DEFAULT_IMAGE_COOLDOWN_MINUTES = 10;

function cooldownRemainingMs(branch, settings, now) {
    const minutes = parsePositiveInt(settings.image_gen_cooldown, DEFAULT_IMAGE_COOLDOWN_MINUTES, 0);
    if (!minutes) return 0;
    const lastImageAt = parsePositiveInt(branch?.sessionMarkers?.image_at, 0, 0);
    return Math.max(0, minutes * 60 * 1000 - (now - lastImageAt));
}

function characterImageDetails(character) {
    if (!character) return '';
    return [
        character.description ? `Description: ${character.description}` : '',
        character.personality ? `Personality: ${character.personality}` : '',
        character.scenario ? `Context: ${character.scenario}` : '',
        character.creator_notes ? `Creator notes: ${character.creator_notes}` : '',
    ].filter(Boolean).map(value => formatPromptText(value, 900)).join('\n');
}

/** Port of the browser buildCharacterImagePrompt that runs on a plain character record. */
export function buildConversationImagePrompt(template, scene, character, details = characterImageDetails(character)) {
    const charName = character?.name || 'Character';
    const basePrompt = String(template || DEFAULT_SETTINGS.image_gen_prompt_template)
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{scene\}\}/g, scene)
        .replace(/\{\{appearance\}\}/g, details || `${charName}'s established appearance`);
    return details ? [
        basePrompt,
        `Depict ${charName} specifically, not a generic person. Use these character-card details: ${details}`,
    ].join('\n') : basePrompt;
}

/**
 * Build the server-side `generateImage` dependency for Conversation participant jobs.
 * The image itself always comes from the account's configured Quick Image Gen provider.
 */
export function createConversationImageGenerator({ fetchImpl } = {}) {
    return async function generateConversationImage(context, snapshot, requestText, speaker, delivery = {}, { narrate } = {}) {
        const settings = snapshot?.settings || {};
        if (!settings.image_gen_enabled) return false;
        const directories = context.directories;
        const effectName = `image:${delivery.chunk ?? 0}:${delivery.image ?? 0}`;
        const request = { user: { directories } };
        const base = { owner: context.owner, directories };
        const assertSourceLocked = lease => {
            const current = assertConversationEffectSource(context, snapshot.target, effectName);
            if (snapshot.target.groupId && !isConversationGroupSpeakerEligible(current.group, speaker.avatar)) {
                throw Object.assign(new Error('The image speaker is no longer available.'), { status: 409 });
            }
            if (snapshot.automation?.roleplaySource) captureConversationRoleplaySource(request, snapshot.automation.roleplaySource,
                { characterName: speaker.name, userName: snapshot.userName || 'User', accountLease: lease });
        };
        // Older accepted requests still carry a history checkpoint, even when
        // their image account stamp was not captured until the first image step.
        const assertSource = () => withRoleplayAccount(base, snapshot.quickImageGenAccount ?? null, assertSourceLocked);
        assertSource();
        if (readConversationEffectReceipt(context, snapshot.target, effectName) !== undefined) return true;
        const cached = readArtifact(directories, context.job.id, effectName);
        let imageUrl = typeof cached?.url === 'string' ? cached.url : '';
        let prompt = typeof cached?.prompt === 'string' ? cached.prompt : '';
        if (!imageUrl) {
            const branch = readConversationTarget(request, snapshot.target).branch;
            const savedInput = readArtifact(directories, context.job.id, `input:quick-image:${effectName}`);
            const savedResult = readArtifact(directories, context.job.id, `provider:quick-image:${effectName}`);
            if (!savedInput && !savedResult && cooldownRemainingMs(branch, settings, Date.now()) > 0) return false;
            const character = snapshot.macros?.extra?.character;
            if (!character || snapshot.speaker?.avatar !== speaker.avatar) {
                throw Object.assign(new Error('The accepted image character is unavailable.'), { status: 409 });
            }
            const scene = String(requestText || '').trim() || SELFIE_SCENE;
            const template = buildSelfieImagePromptTemplate(
                '',
                settings.selfie_prompt || DEFAULT_SETTINGS.selfie_prompt,
                scene,
            );
            prompt = buildConversationImagePrompt(template, scene, character);
            const scoped = await prepareConversationScopedImagePrompt(context, {
                effectId: effectName, prompt, negative: settings.image_gen_negative || '', snapshot,
                expectedAccount: snapshot.quickImageGenAccount, assertSourceLocked,
            });
            const image = await generateQuickImageGenJobImage(context, {
                effectId: effectName,
                prompt: scoped.prompt,
                negative: scoped.negative,
                expectedAccount: scoped.account,
                assertSourceLocked: scoped.assertSourceLocked,
                seedOverride: scoped.seedOverride,
                ...(snapshot.quickImageGenProxyContext !== undefined ? { proxyContext: snapshot.quickImageGenProxyContext } : {}),
                // Older accepted snapshots had no image settings identity; their
                // first image step freezes the current account configuration.
                settingsFingerprint: snapshot.quickImageGenSettingsFingerprint,
                characterScope: snapshot.quickImageGenCharacterScope,
                referenceSources: snapshot.quickImageGenReferenceSources,
                fetch: fetchImpl,
            });
            const accepted = readArtifact(directories, context.job.id, `input:quick-image:${effectName}`);
            if (!accepted?.account) throw Object.assign(new Error('The saved image account identity needs recovery.'), { status: 409 });
            imageUrl = await saveQuickImageToUserImages(directories, {
                base64: image.base64,
                format: image.format,
                chName: speaker.name,
                filename: `qig-${createHash('sha256').update(JSON.stringify([context.job.id, effectName])).digest('hex')}`,
                account: accepted.account, owner: context.owner,
                assertSourceLocked,
            });
            context.signal.throwIfAborted();
            writeArtifact(directories, context.job.id, effectName, { url: imageUrl, prompt });
            await commitConversationEffect(context, snapshot.target, `image-mark:${effectName}`, branchState => {
                branchState.sessionMarkers = { ...(branchState.sessionMarkers || {}), image_at: Date.now() };
                return true;
            });
        }
        const partner = speaker.avatar !== snapshot.target.avatar;
        const narration = narrate ? await narrate(context, snapshot, 'Here, I can show you.', speaker, { ...delivery, effectId: effectName }) : null;
        assertSource();
        const group = readConversationTarget(request, snapshot.target).group;
        if (snapshot.target.groupId && !isConversationGroupSpeakerEligible(group, speaker.avatar)) {
            throw Object.assign(new Error('The reply participant is no longer available.'), { status: 409 });
        }
        await appendConversationJobMessage(context, snapshot.target, effectName, {
            role: partner ? 'partner' : 'character',
            name: speaker.name,
            mes: 'Here, I can show you.',
            extra: {
                ...(snapshot.extra || {}),
                ...(delivery.extra || {}),
                conversation_mode_image: true,
                image_url: imageUrl,
                image_prompt: prompt,
                ...(delivery.attachReplyReference && snapshot.replyReference ? { conversation_reply_to: snapshot.replyReference } : {}),
                ...(partner ? { partner_avatar: speaker.avatar } : {}),
            },
        }, { presentation: { narration }, mutate: (branch, store) => {
            if (snapshot.automation) applyConversationBookkeeping(branch, store, snapshot.automation.patch, snapshot.automation.key);
        } });
        return true;
    };
}

/** Browser parity for the keyword/spontaneous selfie that follows an ordinary reply. */
export function conversationReplyWantsImage(settings, userText) {
    if (!settings?.image_gen_enabled) return false;
    if (settings.spontaneous_selfies) return true;
    return IMAGE_KEYWORDS.test(String(userText || ''));
}

export function lastUserMessageText(messages = []) {
    const collected = [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role !== 'user') { if (collected.length) break; continue; }
        collected.unshift(String(message.mes ?? message.content ?? ''));
    }
    return collected.join('\n\n');
}

export const testExports = { characterImageDetails, cooldownRemainingMs };
