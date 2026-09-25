import path from 'node:path';
import { normalizeBatchCount } from '../../public/scripts/extensions/quick-image-gen/lib/generation.js';
import { resolveCharacterImageSettings } from '../../public/scripts/extensions/quick-image-gen/lib/character-settings.js';
import { createMacroEnvironment } from '../macros/index.js';
import { readRoleplayFile, roleplayError, roleplayHash, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { captureGenerationBinding, getChatProfileContextLimit } from './profiles.js';
import { captureRoleplayWorldInfo, selectSavedRoleplayPersona } from './world-info.js';
import { quickImageGenSettingsFingerprint } from './quick-image-gen-job.js';
import { captureQuickImageTextSettings } from './quick-image-gen-text.js';
import { resolveSavedImageFilters } from './quick-image-gen-filters.js';
import { mediaDirectoryEvidence } from './media-jobs.js';
import { imageSceneMessage } from './quick-image-gen-scene.js';
import { captureQuickImageReferenceSources } from './quick-image-gen-reference.js';
import { assertQuickImageGenConfigured } from './quick-image-gen.js';
import { buildSavedProxyImageContext } from './quick-image-gen-proxy.js';

const fail = message => roleplayError('QIG_INPUT_INVALID', message, 409);
const copyText = value => typeof value === 'string' ? value : '';
const PROMPT_OPTIONS = ['useLLMPrompt', 'twoStepPrompt', 'twoStepInstruction', 'llmPromptStyle', 'llmCustomInstruction',
    'llmAddQuality', 'llmAddLighting', 'llmAddArtist', 'preserveCharacterIdentity', 'useWorldInfo', 'sequentialSeeds'];

export function readSavedImageSettings(directories) {
    const file = readRoleplayFile(path.join(directories.root, 'settings.json'), 8 * 1024 * 1024);
    try { return JSON.parse(file.bytes.toString('utf8')); } catch { throw fail('The saved image settings are unavailable.'); }
}

function selectedIndices(range, count) {
    if (!count) return [];
    const text = String(range || '-1').trim().toLowerCase();
    if (/^last\d+$/.test(text)) {
        const length = Number(text.slice(4));
        if (!Number.isSafeInteger(length) || length < 1) throw fail('The saved image message range is invalid.');
        return Array.from({ length: Math.min(count, length) }, (_, index) => Math.max(0, count - length) + index);
    }
    const indices = new Set();
    const clamp = value => Math.max(0, Math.min(count - 1, value === -1 ? count - 1 : value));
    for (const part of text.split(',').map(value => value.trim()).filter(Boolean)) {
        if (/^-?\d+$/.test(part)) indices.add(clamp(Number(part)));
        else {
            const match = part.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
            if (!match) throw fail('The saved image message range is invalid.');
            let [start, end] = match.slice(1).map(Number).map(clamp);
            if (start > end) [start, end] = [end, start];
            for (let index = start; index <= end; index++) indices.add(index);
        }
    }
    return [...indices].sort((a, b) => a - b);
}

/** Capture only owner-selected input, saved source context and private-configuration fingerprints. */
export function captureQuickImageRequest(base, account, source, { avatar, mode, messageIndex, selectedText,
    connection, acknowledgement, confirmed = false, reviewed = null } = {}) {
    const request = withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source);
        if (!source.dependencies?.some(item => item.kind === 'character' && item.locator.avatar === avatar)) throw fail('The image character is not in the accepted source.');
        const entity = readRoleplayEntityLocked(lease, 'character', avatar);
        if (entity.changed) saveRoleplayAccount(lease);
        const card = entity.data.data ?? entity.data;
        const settings = readSavedImageSettings(base.directories);
        const characterScope = { avatar };
        const qig = resolveCharacterImageSettings(settings.extension_settings?.['quick-image-gen'] || {}, characterScope);
        const sd = settings.extension_settings?.sd || settings.extension_settings?.['stable-diffusion'] || {};
        mode ??= qig.useLastMessage === false ? 'manual' : 'scene';
        if (!['manual', 'scene'].includes(mode)) throw fail('The image source mode is invalid.');
        if (qig.confirmBeforeGenerate && !confirmed || qig.reviewBeforeGenerate && !reviewed) throw fail('Complete the configured image review before accepting generation.');
        if (reviewed && (typeof reviewed.positive !== 'string' || !reviewed.positive.trim() || typeof reviewed.negative !== 'string')) throw fail('The reviewed image prompts are invalid.');
        const persona = selectSavedRoleplayPersona(settings, saved, source, avatar, base.directories);
        const name = card.name || path.parse(avatar).name;
        const user = persona.name || settings.username || 'User';
        const groupEntity = source.locator.group ? readRoleplayEntityLocked(lease, 'group', source.groupId) : null;
        if (groupEntity?.changed) saveRoleplayAccount(lease);
        const group = groupEntity?.data;
        const members = group ? group.members.map(member => {
            const value = member === avatar ? entity : readRoleplayEntityLocked(lease, 'character', member);
            if (value.changed) saveRoleplayAccount(lease);
            const data = value.data.data ?? value.data;
            return { avatar: member, name: data.name || path.parse(member).name, description: copyText(data.description),
                scenario: copyText(data.scenario), tags: Array.isArray(data.tags) ? data.tags.filter(tag => typeof tag === 'string') : [] };
        }) : [{ avatar, name, description: copyText(card.description), scenario: copyText(card.scenario), tags: Array.isArray(card.tags) ? card.tags : [] }];
        const profile = { charNames: members.map(member => member.name), charNameJoined: members.map(member => member.name).join(', '), userName: user,
            charDescResolved: group ? members.map(member => `${member.name}: ${member.description.slice(0, 1500)}`).join('\n\n') : copyText(card.description),
            charScenarioResolved: group ? members.map(member => member.scenario.slice(0, 600)).filter(Boolean).join('\n') : copyText(card.scenario),
            charTagsResolved: [...new Set(members.flatMap(member => member.tags))].join(', '), userDescResolved: persona.description || '',
            usesCurrentCardContext: !group, useExactNameRequirements: true };
        const macros = { names: { char: name, user, group: profile.charNameJoined, notChar: [...members.filter(member => member.avatar !== avatar).map(member => member.name), user].join(', ') },
            character: { description: profile.charDescResolved, personality: copyText(card.personality), scenario: profile.charScenarioResolved,
                persona: profile.userDescResolved, creatorNotes: copyText(card.creator_notes), charDepthPrompt: copyText(card.extensions?.depth_prompt?.prompt) },
            variables: { local: saved.records[0].chat_metadata?.variables ?? {}, global: settings.extension_settings?.variables?.global ?? {} },
            extra: { character: { ...card, avatar }, characterAvatar: avatar, chat: saved.records.slice(1), chatMetadata: saved.records[0].chat_metadata ?? {} } };
        const environment = createMacroEnvironment(macros, {}, { readOnly: true });
        const evaluate = value => environment.evaluate(value, { strictCapabilities: true });
        const indices = mode !== 'scene' ? [] : messageIndex === undefined ? selectedIndices(qig.messageRange, saved.records.length - 1) : [messageIndex];
        if (messageIndex !== undefined && (mode !== 'scene' || !Number.isSafeInteger(messageIndex) || messageIndex < 0
            || messageIndex >= saved.records.length - 1 || source.message?.index !== messageIndex)) throw fail('The requested image message needs its exact saved anchor.');
        const selected = indices.map(index => ({ index, record: saved.records[index + 1], text: imageSceneMessage(saved.records[index + 1]) })).filter(entry => entry.text);
        let scene = mode === 'manual' ? evaluate(copyText(qig.prompt)) : selected.length === 1 ? selected[0].text
            : selected.map(entry => `${entry.record.name || (entry.record.is_user ? user : name)}: ${entry.text}`).join('\n\n');
        if (selectedText !== undefined) {
            if (mode !== 'scene' || typeof selectedText !== 'string' || !selectedText.trim() || !scene.includes(selectedText)) throw fail('The selected image paragraph is outside the saved scene.');
            scene = selectedText;
        } else if (mode === 'scene' && qig.enableParagraphPicker && !reviewed) throw fail('Select the saved image paragraph before accepting this request.');
        if (!scene.trim() || Buffer.byteLength(scene) > 256 * 1024) throw fail('The saved image scene is empty or too large.');
        const snapshot = { target: { groupId: source.locator.group ? source.groupId : null }, speaker: { avatar, name }, macros,
            quickImageGenCharacterScope: characterScope,
            quickImageGenSettingsFingerprint: quickImageGenSettingsFingerprint(qig), quickImageGenSDSettingsFingerprint: quickImageGenSettingsFingerprint(sd) };
        assertQuickImageGenConfigured({ ...qig, __qigProxyContext: buildSavedProxyImageContext(snapshot) });
        const filters = resolveSavedImageFilters(qig, snapshot, scene, environment);
        const needsText = !reviewed && (qig.useLLMPrompt || filters.llm.length);
        const binding = needsText && !qig.llmOverrideEnabled ? captureGenerationBinding(base.directories, connection, acknowledgement) : null;
        if (needsText) {
            snapshot.quickImageGenTextAI = captureQuickImageTextSettings(base.directories, qig, binding, saved.records,
                selected.length ? Math.max(...selected.map(entry => entry.index)) : null);
            snapshot.binding = snapshot.quickImageGenTextAI.binding;
        }
        const parent = base.directories.userImages ?? path.join(base.directories.root, 'user/images');
        const relativeDirectory = path.relative(base.directories.root, parent).split(path.sep).join('/');
        if (relativeDirectory.split('/').some(part => !part || part === '..' || part === '.') || path.isAbsolute(relativeDirectory)) throw fail('The image destination is outside this account.');
        readRoleplayFile(path.join(parent, '.image-path-check'), 1, { allowMissingParent: true });
        const parents = [];
        let directory = base.directories.root;
        for (const part of relativeDirectory.split('/')) {
            directory = path.join(directory, part);
            parents.push({ relative: path.relative(base.directories.root, directory).split(path.sep).join('/'), before: mediaDirectoryEvidence(directory) });
        }
        const proxyReferences = mode === 'scene' && qig.provider === 'proxy' ? [...new Set(selected.flatMap(({ record }) => [
            ...(record.extra?.media ?? []).filter(media => !media.type || media.type.startsWith('image')).map(media => media.url), record.extra?.image,
        ]).filter(Boolean))] : [];
        snapshot.quickImageGenReferenceSources = captureQuickImageReferenceSources(base.directories, qig, proxyReferences);
        const options = Object.fromEntries(PROMPT_OPTIONS.filter(key => qig[key] !== undefined).map(key => [key, qig[key]]));
        return { version: 1, avatar, mode, scene, provider: qig.provider || '', selected: selected.map(({ index, record }) => ({ index, hash: roleplayHash(record) })),
            isMultiMessage: selected.length > 1, snapshot, profile, settingsHash: roleplayHash(settings), options,
            negative: evaluate(copyText(qig.negativePrompt)), batchCount: normalizeBatchCount(qig.batchCount),
            reviewed: reviewed ? { positive: reviewed.positive.trim(), negative: reviewed.negative } : null,
            seed: qig.provider === 'proxy' ? qig.proxySeed ?? -1 : qig.seed ?? -1, proxyReferences,
            relativeDirectory, parents, binding, account: { accountId: account.accountId, dataEpoch: account.dataEpoch } };
    });
    if (request.options.useWorldInfo && request.options.useLLMPrompt && !request.reviewed) {
        const limit = withRoleplayAccount(base, account, () => getChatProfileContextLimit(base.directories, request.snapshot.quickImageGenTextAI.binding)) ?? 8192;
        request.worldInfo = captureRoleplayWorldInfo(base, account, source, { avatar, maxContext: limit, serverPrompt: false });
        if (request.worldInfo.settingsHash !== request.settingsHash || request.worldInfo.hookPolicy.scanContributors.length) throw fail('The image lore sources need their saved native contributors.');
    }
    if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) throw fail('The accepted image inputs exceed their saved limit.');
    return request;
}
