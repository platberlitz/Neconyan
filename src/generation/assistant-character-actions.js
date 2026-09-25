import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { write as writeCharacterCard } from '../character-card-parser.js';
import { decodeServerImage, encodeServerImage } from '../media-codecs.js';
import { commitRoleplayLifecycleLocked } from '../roleplay-lifecycle.js';
import { readRoleplayFile, roleplayError, roleplayHash, roleplayLease } from '../roleplay-store.js';
import { readRoleplayEntityLocked, captureRoleplayStorageSourceLocked } from './roleplay-source.js';
import { generateQuickImageGenJobImage } from './quick-image-gen-job.js';
import { withNativeMediaReceipt } from './media-jobs.js';
import { readBoundAssistantContextLocked, captureAssistantToolSourceLocked } from './assistant-tool-sources.js';
import { projectAssistantCharacter } from './assistant-tool-data.js';

const invalid = message => roleplayError('ASSISTANT_CHARACTER_RECOVERY', message, 409);
const MAX_CARD = 64 * 1024 * 1024;
const rawHash = bytes => createHash('sha256').update(bytes).digest('hex');
const account = media => ({ accountId: media.accountId, dataEpoch: media.dataEpoch });
const evidence = file => file ? { rawHash: file.rawHash, physical: file.physical } : null;

export function planAssistantCharacter(context, request) {
    return withNativeMediaReceipt(context, ({ lease }) => {
        const stored = captureAssistantToolSourceLocked(lease, context.job.intent.source,
            { avatar: request.avatar, name: request.name, args: request.args, callId: request.callId });
        if (roleplayHash(stored) !== roleplayHash(request)) throw invalid('The accepted character edit changed before review.');
        const visible = request.tool === 'create-character'
            ? { status: 'success', avatar: request.resource.id, name: request.change.character.name }
            : { status: 'success', avatar: request.resource.id, field: request.change.field,
                before: request.change.before, after: request.change.after };
        const values = { identity: roleplayHash(context.job.intent), requestHash: roleplayHash(request), bytes: '',
            afterHash: roleplayHash({ resource: request.resource, change: request.change }), visible };
        return { ...values, hash: roleplayHash(values) };
    });
}

export function assertApprovedCharacterEffectLocked(lease, context, request, plan, receipt) {
    const effect = receipt.effects[roleplayHash(['character', request.resource.id])];
    if (!effect || effect.state !== 'done' || effect.planHash !== plan.hash || effect.id !== request.resource.id) {
        throw invalid('The approved character change does not have a completed physical receipt.');
    }
    assertCharacterSource(lease, context, request, effect);
    const { scope } = roleplayLease(lease);
    const saved = readRoleplayEntityLocked(lease, 'character', request.resource.id);
    const file = readRoleplayFile(path.join(scope.directories.characters, request.resource.id), MAX_CARD);
    if (!file || saved.changed || file.rawHash !== effect.rawHash || roleplayHash(file.physical) !== roleplayHash(effect.after)
        || roleplayHash(saved.physical) !== roleplayHash(effect.after)) {
        throw invalid('The approved character card was replaced after publication.');
    }
}

function createdCard(change, createdAt) {
    const data = change.character;
    const name = data.name;
    const fields = Object.fromEntries(['description', 'personality', 'scenario', 'first_mes', 'mes_example']
        .map(key => [key, data[key] ?? '']));
    const card = { name, ...fields, creatorcomment: data.creator_notes ?? '', avatar: 'none',
        chat: `${name} - ${new Date(createdAt).toISOString()}`, talkativeness: 0.5, fav: false, tags: [],
        spec: 'chara_card_v2', spec_version: '2.0',
        data: { name, ...fields, creator_notes: data.creator_notes ?? '', system_prompt: data.system_prompt ?? '',
            post_history_instructions: data.post_history_instructions ?? '', tags: [], creator: '', character_version: '',
            alternate_greetings: change.alternateGreetings,
            extensions: { talkativeness: 0.5, fav: false, world: '',
                depth_prompt: { prompt: change.characterNote, depth: 4, role: 'system' } } } };
    return card;
}

/** An owned character edit may update the assistant card itself; its chat and settings must still be identical. */
function assertCharacterSource(lease, context, request, ownEffect = null) {
    if (!ownEffect) {
        const bound = captureAssistantToolSourceLocked(lease, context.job.intent.source,
            { avatar: request.avatar, name: request.name, args: request.args, callId: request.callId });
        if (roleplayHash(bound) !== roleplayHash(request)) throw invalid('The character source changed after approval.');
        return;
    }
    if (request.resource.id !== request.avatar) {
        const current = readBoundAssistantContextLocked(lease, context.job.intent.source, request.avatar);
        if (roleplayHash(current.assistant) !== roleplayHash(request.assistant) || current.assistantId !== request.assistantId
            || current.settingsHash !== request.settingsHash
            || roleplayHash(current.settingsEvidence) !== roleplayHash(request.settingsEvidence)) {
            throw invalid('The assistant or its saved settings changed after the approved character action.');
        }
        return;
    }
    const source = context.job.intent.source;
    if (source.dependencies.length !== 1 || source.dependencies[0].locator.avatar !== request.avatar) {
        throw invalid('The selected assistant has unexpected protected dependencies.');
    }
    const current = captureRoleplayStorageSourceLocked(lease, source.locator).source;
    if (roleplayHash({ accountId: current.accountId, dataEpoch: current.dataEpoch, instanceId: current.instanceId,
        revision: current.revision, rawHash: current.rawHash, locator: current.locator })
        !== roleplayHash({ accountId: source.accountId, dataEpoch: source.dataEpoch, instanceId: source.instanceId,
            revision: source.revision, rawHash: source.rawHash, locator: source.locator })) {
        throw invalid('The assistant chat changed while its character was being edited.');
    }
    const { scope } = roleplayLease(lease);
    const file = readRoleplayFile(path.join(scope.directories.root, 'settings.json'), 8 * 1024 * 1024);
    if (roleplayHash(evidence(file)) !== roleplayHash(request.settingsEvidence)) throw invalid('The saved account settings changed.');
    const selected = readRoleplayEntityLocked(lease, 'character', request.avatar);
    const actual = readRoleplayFile(path.join(scope.directories.characters, request.avatar), MAX_CARD);
    if (ownEffect.state === 'done' && (actual?.rawHash !== ownEffect.rawHash
        || roleplayHash(actual.physical) !== roleplayHash(ownEffect.after))) throw invalid('The completed character card was replaced.');
    const assistantId = selected.data?.data?.extensions?.neconyan_assistant?.id
        ?? selected.data?.extensions?.neconyan_assistant?.id;
    if (assistantId !== request.assistantId) throw invalid('The saved assistant identity changed.');
}

function characterBytes(lease, context, request, plan, imageBytes) {
    const { scope } = roleplayLease(lease);
    let sourceImage;
    let card;
    if (request.tool === 'edit-character') {
        const selected = readRoleplayEntityLocked(lease, 'character', request.resource.id);
        const file = readRoleplayFile(path.join(scope.directories.characters, request.resource.id), MAX_CARD);
        if (!file || file.rawHash !== request.resource.rawHash
            || roleplayHash(file.physical) !== roleplayHash(request.resource.physical)
            || selected.contentHash !== request.resource.contentHash) throw invalid('The original character card changed before publication.');
        card = structuredClone(selected.data);
        const field = request.change.field;
        if (projectAssistantCharacter(card, request.resource.id)[field] !== request.change.before) throw invalid('The character field changed.');
        card[field] = request.change.after;
        card.data ??= {};
        card.data[field] = request.change.after;
        if (field === 'creator_notes') card.creatorcomment = request.change.after;
        sourceImage = file.bytes;
    } else {
        const filename = path.join(scope.directories.characters, request.resource.id);
        if (readRoleplayFile(filename, MAX_CARD, { allowMissingParent: true })) throw invalid('The approved character filename is no longer free.');
        card = createdCard(request.change, context.job.createdAt);
        sourceImage = imageBytes ?? fs.readFileSync(new URL('../../public/img/ai4.png', import.meta.url));
    }
    let bytes;
    try { bytes = writeCharacterCard(sourceImage, JSON.stringify(card)); } catch { throw invalid('The approved character image or card metadata could not be saved.'); }
    if (bytes.length > MAX_CARD || plan.afterHash !== roleplayHash({ resource: request.resource, change: request.change })) {
        throw invalid('The approved character card differs from its saved plan.');
    }
    return bytes;
}

/** Use the existing protected lifecycle journal, with one independently retained media intent. */
export async function executeApprovedCharacterAction(context, { request, plan, beforePublish, afterCommit, fetchImpl } = {}) {
    const intent = context.job.intent;
    const operationKey = `assistant-character:${context.job.id}`;
    const effectKey = roleplayHash(['character', request.resource.id]);
    let imageBytes = null;
    const avatarNeeded = withNativeMediaReceipt(context, ({ lease, value }) => {
        const prior = value.effects[effectKey] ?? null;
        if (!prior) {
            if (roleplayLease(lease).state.pending) throw invalid('An unrelated protected operation is unfinished.');
            return true;
        }
        if (prior.state === 'done' || roleplayLease(lease).state.pending) return false;
        const { scope } = roleplayLease(lease);
        const current = readRoleplayFile(path.join(scope.directories.characters, request.resource.id), MAX_CARD,
            { allowMissingParent: true });
        return current?.rawHash !== prior.rawHash;
    }, { checkSource: false });
    if (avatarNeeded && request.tool === 'create-character' && request.change.avatarPrompt) {
        const originalAccount = account(intent.media);
        const image = await generateQuickImageGenJobImage(context, { effectId: `assistant-avatar:${request.callId}`,
            prompt: request.change.avatarPrompt, settingsFingerprint: request.change.imageSettingsFingerprint,
            expectedAccount: originalAccount, referenceSources: request.change.imageReferences,
            assertSourceLocked: lease => assertCharacterSource(lease, context, request), fetch: fetchImpl });
        try { imageBytes = await encodeServerImage(await decodeServerImage(Buffer.from(image.base64, 'base64'))); } catch {
            throw invalid('The approved avatar image cannot be converted to a character card.');
        }
    }
    return withNativeMediaReceipt(context, ({ lease, value, save }) => {
        let effect = value.effects[effectKey];
        if (effect && (effect.operationKey !== operationKey || effect.planHash !== plan.hash
            || effect.id !== request.resource.id)) throw invalid('The saved character operation differs from the approved change.');
        if (effect?.state === 'done') {
            assertCharacterSource(lease, context, request, effect);
            return { ...plan.visible, effect: { rawHash: effect.rawHash, physical: effect.after } };
        }
        const pending = roleplayLease(lease).state.pending;
        if (!effect) assertCharacterSource(lease, context, request);
        else if (pending && pending.kind !== 'lifecycle') throw invalid('An unrelated protected operation is unfinished.');
        const { scope } = roleplayLease(lease);
        const existing = effect ? readRoleplayFile(path.join(scope.directories.characters, request.resource.id), MAX_CARD,
            { allowMissingParent: true }) : null;
        const writtenByOwnLifecycle = Boolean(effect && existing && existing.rawHash === effect.rawHash);
        const bytes = pending || writtenByOwnLifecycle ? Buffer.alloc(0) : characterBytes(lease, context, request, plan, imageBytes);
        const afterHash = pending || writtenByOwnLifecycle ? effect?.rawHash : rawHash(bytes);
        if (!afterHash || effect && effect.rawHash !== afterHash) throw invalid('The prepared character card changed.');
        if (!effect) {
            effect = { id: request.resource.id, operationKey, planHash: plan.hash, rawHash: afterHash, state: 'prepared' };
            value.effects[effectKey] = effect;
            save();
        }
        beforePublish?.(effect);
        commitRoleplayLifecycleLocked(lease, { operationKey, action: request.tool === 'create-character' ? 'character-create' : 'character-update',
            intent: { planHash: plan.hash, requestHash: roleplayHash(request), rawHash: afterHash },
            steps: [{ op: request.tool === 'create-character' ? 'create' : 'update', kind: 'character',
                locator: { avatar: request.resource.id }, bytes }] });
        const current = readRoleplayFile(path.join(scope.directories.characters, request.resource.id), MAX_CARD);
        if (current?.rawHash !== afterHash) throw invalid('The protected character lifecycle did not confirm its output.');
        const confirmed = readRoleplayEntityLocked(lease, 'character', request.resource.id);
        if (confirmed.changed || roleplayHash(confirmed.physical) !== roleplayHash(current.physical)) {
            throw invalid('The completed character is not the owned protected card.');
        }
        afterCommit?.(current);
        effect.after = current.physical;
        effect.state = 'done';
        save();
        assertCharacterSource(lease, context, request, effect);
        return { ...plan.visible, effect: { rawHash: current.rawHash, physical: current.physical } };
    }, { checkSource: false });
}
