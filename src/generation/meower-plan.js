import path from 'node:path';
import sanitize from 'sanitize-filename';
import { randomUUID } from 'node:crypto';
import { readJson } from '../mewmory/store.js';
import { hash } from '../mewmory/core.js';
import { readRoleplayFile, withRoleplayAccount } from '../roleplay-store.js';
import { roleplayEntityContent } from './roleplay-source.js';
import { captureGenerationBinding, resolveGenerationProfile } from './profiles.js';
import { validateActiveGenerationContext } from './service.js';
import { createMacroEnvironment } from '../macros/index.js';
import { readQuickImageGenSettings } from './quick-image-gen.js';
import { quickImageGenSettingsFingerprint } from './quick-image-gen-job.js';
import { deriveAccounts, selectParticipants, KIND_CHARACTER, KIND_PERSONA, reasoningOverridesFrom } from '../../public/scripts/extensions/third-party/Neconyan-Hopper/src/core.js';

export const meowerError = (message, status = 409) => Object.assign(new Error(message), { status });
export const receiptKey = (owner, submissionKey) => hash([owner, submissionKey]);
export { checkMeowerReceipts, RECEIPT_LIMIT, RECEIPTS_LIMIT } from '../../public/scripts/extensions/third-party/Neconyan-Hopper/server/job-receipts.js';

export function meowerInput(body, kind) {
    if (typeof body.submissionKey !== 'string' || !body.submissionKey || body.submissionKey.length > 256) throw meowerError('A submission key is required.', 400);
    if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 120) throw meowerError('A Meower timeline is required.', 400);
    if (!['refresh', 'profile'].includes(kind)) throw meowerError('Invalid Meower operation.', 400);
    const input = { kind, sessionId: body.sessionId };
    if (kind === 'profile') {
        if (!['persona', 'character', 'all'].includes(body.mode)) throw meowerError('Invalid Meower profile operation.', 400);
        input.mode = body.mode;
        if (body.mode === 'character') {
            if (typeof body.accountKey !== 'string' || !body.accountKey || body.accountKey.length > 300) throw meowerError('A character account is required.', 400);
            input.accountKey = body.accountKey;
        }
    } else {
        for (const [key, limit] of [['topic', 400], ['localTime', 200]]) {
            if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > limit)) throw meowerError(`Invalid Meower ${key}.`, 400);
            input[key] = body[key] || '';
        }
        if (body.scene != null) {
            const scene = body.scene;
            if (!Array.isArray(scene.lines) || scene.lines.length > 12 || !scene.lines.every(line => typeof line === 'string')
                || scene.lines.join('\n').length > 4000 || !Array.isArray(scene.names) || scene.names.length > 12
                || !scene.names.every(name => typeof name === 'string' && name.length <= 200)) throw meowerError('The Meower scene is too large or invalid.', 400);
            input.scene = { lines: scene.lines, names: scene.names };
        }
    }
    // The acknowledged revision is authority for the active connection, not a secret.
    input.acknowledgement = body.acknowledgement ?? null;
    return input;
}

export function accountsForPlan(plan, profiles = plan.settings.profiles, strangers = plan.session.strangers) {
    const scoped = { ...profiles };
    if (plan.session.personaId) scoped[`${KIND_PERSONA}:${plan.session.personaId}`] = plan.session.personaProfile;
    return deriveAccounts({ characters: plan.characters, invited: plan.session.invited, persona: plan.persona,
        ambient: plan.session.ambient, strangers, profiles: scoped });
}

export function meowerMacros(plan, accounts = plan.accounts) {
    const persona = accounts.find(account => account.kind === KIND_PERSONA);
    const character = accounts.find(account => plan.activeKeys.includes(account.key) && account.kind === KIND_CHARACTER);
    return { names: { user: persona?.name || 'You', char: character?.name || 'Character' },
        character: { ...character, persona: plan.persona?.description || '' }, variables: { local: {}, global: {} },
        extra: { chat: [], chatMetadata: {} } };
}

export async function captureMeowerPlan({ owner, directories }, store, input) {
    const session = store.settings.sessions[input.sessionId];
    if (!session || !store.feeds[input.sessionId]) throw meowerError('That timeline session no longer exists.');
    const saved = readJson(path.join(directories.root, 'settings.json'), {});
    const settings = structuredClone(store.settings);
    delete settings.sessions;
    let binding;
    if (settings.profileId) {
        if (saved.extension_settings?.disabledExtensions?.includes('connection-manager')
            || !saved.extension_settings?.connectionManager?.profiles?.some(profile => profile.id === settings.profileId)) {
            throw meowerError('The selected connection profile is unavailable. Choose another connection in Meower settings.');
        }
        binding = captureGenerationBinding(directories, { kind: 'profile', profileId: settings.profileId });
    } else binding = captureGenerationBinding(directories, { kind: 'active' }, input.acknowledgement);
    const material = resolveGenerationProfile(directories, binding);
    const characters = session.invited.flatMap(avatar => {
        if (typeof avatar !== 'string' || sanitize(avatar) !== avatar) throw meowerError('An invited character has an invalid identity.');
        const file = readRoleplayFile(path.join(directories.characters, avatar), 64 * 1024 * 1024);
        if (!file) return [];
        return [{ ...roleplayEntityContent('character', avatar, file.bytes).data, avatar }];
    });
    const descriptor = saved.power_user?.persona_descriptions?.[session.personaId] || {};
    const descriptions = [String(descriptor.description || '').trim()];
    for (const [index, note] of (descriptor.appendices || []).entries()) {
        if (session.scenarioNoteIds.includes(String(note?.id || `scenario-note-${index}`)) && String(note?.description || '').trim()) {
            descriptions.push(`(${String(note.name || `Scenario Note ${index + 1}`)})\n${String(note.description).trim()}`);
        }
    }
    const persona = session.personaId ? { entityId: session.personaId,
        name: saved.power_user?.personas?.[session.personaId] || saved.name1 || 'You', description: descriptions.filter(Boolean).join('\n\n') } : null;
    const plan = { version: 1, input, now: Date.now(), settings, session: structuredClone(session), characters, persona, binding,
        account: withRoleplayAccount({ owner, directories }, null, (_lease, account) => account),
        overridePayload: binding.kind === 'profile' ? reasoningOverridesFrom(material.profile, material.preset) : {},
        imageFingerprint: settings.images.enabled ? quickImageGenSettingsFingerprint(readQuickImageGenSettings(directories)) : null };
    plan.accounts = accountsForPlan(plan);
    plan.activeKeys = selectParticipants(plan.accounts, settings, store.feeds[input.sessionId]).map(account => account.key);
    if (input.kind === 'refresh' && !plan.activeKeys.length && !session.ambient) throw meowerError('Invite a character first, or let strangers join in.');
    const targets = plan.accounts.filter(account => input.mode === 'persona' ? account.kind === KIND_PERSONA
        : account.kind === KIND_CHARACTER && (input.mode === 'all' || input.accountKey === account.key));
    if (input.kind === 'profile' && !targets.length) throw meowerError(input.mode === 'persona' ? 'Set a persona for this timeline first.' : 'Invite a character before generating its profile.');
    plan.profileKeys = targets.map(account => account.key);
    const macros = meowerMacros(plan);
    await validateActiveGenerationContext(material, createMacroEnvironment(macros), [{ role: 'user', content: 'Meower' }], {}, { maxTokens: settings.maxTokens });
    // Give legacy feeds a reset identity before any accepted work can target them.
    store.feeds[input.sessionId].epoch ||= randomUUID();
    plan.epoch = store.feeds[input.sessionId].epoch;
    if (Buffer.byteLength(JSON.stringify(plan)) > 512 * 1024) throw meowerError('The selected Meower cast is too large to accept safely.', 413);
    return plan;
}
