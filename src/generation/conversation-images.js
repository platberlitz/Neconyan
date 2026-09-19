import { getCharacterData } from '../endpoints/conversation-generation.js';
import { DEFAULT_SETTINGS } from '../../public/scripts/neconyan-conversation/constants.js';
import { formatPromptText } from '../../public/scripts/neconyan-conversation/shared-helpers.js';
import { buildSelfieImagePromptTemplate } from '../../public/scripts/neconyan-conversation/generation-utils.js';
import { parsePositiveInt } from '../endpoints/conversation-utils.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { appendConversationJobMessage, commitConversationEffect, readConversationTarget } from './conversation-effects.js';
import { generateQuickImageGenImage, saveQuickImageToUserImages } from './quick-image-gen.js';

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

async function loadCharacter(directories, avatar) {
    return await getCharacterData({ user: { directories } }, avatar, { allowOverride: false, requireExisting: false });
}

/**
 * Build the server-side `generateImage` dependency for Conversation participant jobs.
 * The image itself always comes from the account's configured Quick Image Gen provider.
 * ponytail: the browser also runs an extra LLM pass to enrich the prompt; the configured
 * selfie template plus the model's request text is enough until that fidelity is needed.
 */
export function createConversationImageGenerator() {
    return async function generateConversationImage(context, snapshot, requestText, speaker, delivery = {}) {
        const settings = snapshot?.settings || {};
        if (!settings.image_gen_enabled) return false;
        const directories = context.directories;
        const effectName = `image:${delivery.chunk ?? 0}:${delivery.image ?? 0}`;
        const request = { user: { directories } };
        const cached = readArtifact(directories, context.job.id, effectName);
        let imageUrl = typeof cached?.url === 'string' ? cached.url : '';
        let prompt = typeof cached?.prompt === 'string' ? cached.prompt : '';
        if (!imageUrl) {
            const branch = readConversationTarget(request, snapshot.target).branch;
            if (cooldownRemainingMs(branch, settings, Date.now()) > 0) return false;
            const character = await loadCharacter(directories, speaker.avatar);
            const scene = String(requestText || '').trim() || SELFIE_SCENE;
            const template = buildSelfieImagePromptTemplate(
                '',
                settings.selfie_prompt || DEFAULT_SETTINGS.selfie_prompt,
                scene,
            );
            prompt = buildConversationImagePrompt(template, scene, character);
            const image = await generateQuickImageGenImage({
                directories,
                prompt,
                negative: settings.image_gen_negative || '',
                signal: context.signal,
            });
            imageUrl = await saveQuickImageToUserImages(directories, {
                base64: image.base64,
                format: image.format,
                chName: speaker.name,
            });
            context.signal.throwIfAborted();
            writeArtifact(directories, context.job.id, effectName, { url: imageUrl, prompt });
            await commitConversationEffect(context, snapshot.target, `image-mark:${effectName}`, branchState => {
                branchState.sessionMarkers = { ...(branchState.sessionMarkers || {}), image_at: Date.now() };
                return true;
            });
        }
        const partner = speaker.avatar !== snapshot.target.avatar;
        await appendConversationJobMessage(context, snapshot.target, effectName, {
            role: partner ? 'partner' : 'character',
            name: speaker.name,
            mes: 'Here, I can show you.',
            extra: {
                ...(delivery.extra || {}),
                conversation_mode_image: true,
                image_url: imageUrl,
                image_prompt: prompt,
                ...(delivery.attachReplyReference && snapshot.replyReference ? { conversation_reply_to: snapshot.replyReference } : {}),
                ...(partner ? { partner_avatar: speaker.avatar } : {}),
            },
        });
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
