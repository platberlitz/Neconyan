import express from 'express';
import path from 'node:path';
import { validateOwner } from '../jobs/store.js';
import { roleplayAccountBase, roleplayLease, roleplayError, saveRoleplayAccount, withRoleplayAccount, readRoleplayFile } from '../roleplay-store.js';
import { captureRoleplayDependenciesLocked, normaliseRoleplayLocator, readRoleplayChatLocked, readRoleplayEntityLocked } from '../generation/roleplay-source.js';
import { acceptNavigationPointer, clearNavigationPointer, enrolNavigationAlias, navigationPersona, navigationUnavailable, readNavigationState, validateNavigationDestination, writeNavigationState } from '../chat-navigation-state.js';
import { getConversationThreadKey, readUserSettingsWithStatus, saveConversationStore } from './conversation-store.js';
import { authorizeConversationGroup } from './conversation-groups.js';
import { getConversationSettings, normalizeConversationSettings } from './conversation-generation.js';
import { getSettingsVersion, prepareSettingsSave } from '../settings-version.js';
import { tryWriteFileSync } from '../util.js';
import { CHAT_LINK_ID } from '../../public/scripts/chat-navigation-policy.js';

export const router = express.Router();
router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    try {
        const owner = validateOwner(request.user?.profile?.handle);
        if (request.get('X-Neconyan-Account') && request.get('X-Neconyan-Account') !== owner) throw roleplayError('navigation_account_changed', 'The account changed. Reload this page.', 409);
        if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw roleplayError('navigation_invalid', 'Invalid request.', 400);
        next();
    } catch (error) { respondError(response, error); }
});

function respondError(response, error) {
    const status = error.status || 503;
    // Never return an owner, path, transcript, or a parser error containing saved text.
    response.status(status).send({ error: status === 404 ? 'navigation_unavailable' : status === 400 ? 'navigation_invalid' : status === 409 ? 'navigation_conflict' : 'navigation_retry' });
}

function account(request, operation, { write = false } = {}) {
    const base = roleplayAccountBase(request.user.directories);
    if (!base) throw roleplayError('navigation_retry', 'Account storage is not ready.', 503);
    if (write && !request.body.account) throw roleplayError('navigation_invalid', 'Account evidence is required.', 400);
    return withRoleplayAccount(base, request.body.account || null, lease => {
        const { state } = roleplayLease(lease);
        if (state.pending) throw roleplayError('navigation_retry', 'Saved content needs recovery.', 503);
        return operation(lease);
    });
}

function settings(request) {
    const result = readUserSettingsWithStatus(request);
    if (!result.ok) throw roleplayError('navigation_retry', 'Settings cannot be read.', 503);
    return result.data;
}

function resource(lease, id, kind) {
    const { state } = roleplayLease(lease);
    const value = state.resources[id];
    if (!value || value.kind !== kind || value.status !== 'live' || value.accountId !== state.accountId || value.dataEpoch !== state.dataEpoch) throw navigationUnavailable();
    return value;
}

function conversationTarget(request, input, { establish = false, lease, document, allowDisabled = false, checkExpected = true, snapshot = null } = {}) {
    if (!input || Object.keys(input).some(key => !['avatar', 'groupId', 'personaId', 'branchId'].includes(key))
        || typeof input.avatar !== 'string' || typeof input.personaId !== 'string' || !input.personaId
        || typeof input.branchId !== 'string' || !input.branchId || input.branchId.length > 256
        || typeof (input.groupId ?? '') !== 'string') throw roleplayError('navigation_invalid', 'Invalid Conversation target.', 400);
    const groupId = input.groupId || '';
    const threadKey = getConversationThreadKey(input.avatar, groupId, input.personaId);
    if (!threadKey || input.personaId.includes('/') || input.personaId.includes('\\') || input.personaId.includes('\0')) throw roleplayError('navigation_invalid', 'Invalid Conversation target.', 400);
    const savedSettings = snapshot || settings(request);
    const store = savedSettings.extension_settings?.neconyan_conversation;
    const thread = store?.characters?.[threadKey];
    const branch = Object.hasOwn(thread?.branches || {}, input.branchId) ? thread.branches[input.branchId] : null;
    if (!branch || !Array.isArray(branch.messages)) throw navigationUnavailable();
    if (establish && checkExpected && request.body.expectedBranch) {
        const expected = request.body.expectedBranch;
        if (typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).some(key => !['navigationId', 'lifetimeSeed', 'createdAt'].includes(key))
            || !(expected.navigationId === null || (typeof expected.navigationId === 'string' && CHAT_LINK_ID.test(expected.navigationId))) || typeof expected.lifetimeSeed !== 'string'
            || expected.lifetimeSeed.length > 256 || typeof expected.createdAt !== 'string' || expected.createdAt.length > 64) throw roleplayError('navigation_invalid', 'Invalid saved branch evidence.', 400);
        if ((expected.navigationId && expected.navigationId !== branch.navigationId) || expected.lifetimeSeed !== (branch.lifetimeSeed || '')
            || expected.createdAt !== String(branch.createdAt || '')) throw navigationUnavailable();
    }
    const authorization = authorizeConversationGroup(request, store, input.avatar, groupId, input.personaId, normalizeConversationSettings);
    if (!authorization.authorized && !allowDisabled) {
        if (authorization.status >= 500) throw roleplayError('navigation_retry', 'Group storage cannot be read.', 503);
        throw navigationUnavailable();
    }
    if (groupId && (thread.threadAvatar !== input.avatar || String(thread.groupId || '') !== groupId)) throw navigationUnavailable();
    if (!allowDisabled && !getConversationSettings(request, store, input.avatar, groupId, {}, { personaId: input.personaId }).enabled) throw navigationUnavailable();
    if (!readRoleplayFile(path.join(request.user.directories.avatars, input.personaId), 32 * 1024 * 1024)) throw navigationUnavailable();
    const owner = readRoleplayEntityLocked(lease, 'character', input.avatar, { enrolMissing: establish });
    let ownersChanged = owner.changed;
    if (establish && groupId && Array.isArray(authorization.group?.members)) {
        for (const member of authorization.group.members) {
            if (authorization.group.disabled_members?.includes(member)) continue;
            ownersChanged = readRoleplayEntityLocked(lease, 'character', member).changed || ownersChanged;
        }
    }
    if (ownersChanged) saveRoleplayAccount(lease);
    const persona = navigationPersona(document, input.personaId, { establish });
    if (!persona) throw navigationUnavailable();
    return { branch, store, version: getSettingsVersion(savedSettings), threadKey, ownerId: owner.instanceId, persona, input: { ...input, groupId } };
}

function resolve(request, lease, document, destination, { allowDisabled = false } = {}) {
    validateNavigationDestination(destination);
    const alias = document.aliases[destination.id];
    if (!alias || (alias.kind === 'conversation') !== (destination.mode === 'conversation')) throw navigationUnavailable();
    if (alias.kind === 'roleplay') {
        const chat = resource(lease, destination.id, 'chat');
        const saved = readRoleplayChatLocked(lease, chat.locator, { enrolMissing: false });
        if (saved.instanceId !== destination.id) throw navigationUnavailable();
        let groupId = '';
        if (chat.locator.group) {
            const groupResource = resource(lease, alias.ownerId, 'group');
            groupId = groupResource.locator.groupId;
            const group = readRoleplayEntityLocked(lease, 'group', groupId, { enrolMissing: false });
            if (!group.data.chats?.map(String).includes(chat.locator.chat)) throw navigationUnavailable();
            for (const avatar of group.data.members || []) readRoleplayEntityLocked(lease, 'character', avatar, { enrolMissing: false });
        } else {
            const owner = resource(lease, alias.ownerId, 'character');
            if (owner.locator.avatar !== chat.locator.avatar) throw navigationUnavailable();
            readRoleplayEntityLocked(lease, 'character', chat.locator.avatar, { enrolMissing: false });
        }
        return { ...destination, locator: saved.locator, groupId };
    }
    if (alias.kind !== 'conversation') throw navigationUnavailable();
    const owner = alias.target.groupId ? null : resource(lease, alias.ownerId, 'character');
    const snapshot = settings(request);
    const store = snapshot.extension_settings?.neconyan_conversation;
    const index = store?.navigationTargets?.[destination.id];
    const currentThread = index && store?.characters?.[index.threadKey];
    const avatar = alias.target.groupId ? currentThread?.threadAvatar : owner.locator.avatar;
    if (typeof avatar !== 'string') throw navigationUnavailable();
    const target = conversationTarget(request, { ...alias.target, avatar }, { lease, document, allowDisabled, snapshot });
    if (target.branch.navigationId !== destination.id || target.persona !== alias.persona
        || target.store.navigationTargets?.[destination.id]?.threadKey !== target.threadKey
        || target.store.navigationTargets?.[destination.id]?.branchId !== alias.target.branchId) throw navigationUnavailable();
    if (alias.target.groupId) {
        if (alias.groupOwner?.kind === 'conversation') {
            if (target.store.groups?.find(group => group.id === alias.target.groupId)?.navigationId !== alias.groupOwner.id) throw navigationUnavailable();
        } else {
            const group = resource(lease, alias.groupOwner?.id, 'group');
            readRoleplayEntityLocked(lease, 'group', group.locator.groupId, { enrolMissing: false });
            if (String(group.locator.groupId) !== alias.target.groupId) throw navigationUnavailable();
        }
    }
    return { ...destination, target: target.input };
}

function route(url, operation, { write = false } = {}) {
    router.post(url, async (request, response) => {
        try {
            const result = account(request, lease => operation(request, lease), { write });
            response.send(result.promise ? await result.promise : result);
        } catch (error) { respondError(response, error); }
    });
}

route('/state', (request, lease) => {
    const document = readNavigationState(lease);
    return { account: { accountId: document.accountId, dataEpoch: document.dataEpoch }, pointer: document.pointer, migration: document.migration };
});

route('/resolve', (request, lease) => resolve(request, lease, readNavigationState(lease), request.body.destination));

route('/establish', (request, lease) => {
    const document = readNavigationState(lease);
    const mode = request.body.mode;
    if (!['roleplay', 'story', 'conversation'].includes(mode)) throw roleplayError('navigation_invalid', 'Invalid mode.', 400);
    if (mode !== 'conversation') {
        const locator = normaliseRoleplayLocator(request.body.locator);
        const saved = readRoleplayChatLocked(lease, locator);
        if (request.body.sourceId !== undefined) {
            if (typeof request.body.sourceId !== 'string' || !CHAT_LINK_ID.test(request.body.sourceId)) throw roleplayError('navigation_invalid', 'Invalid source identity.', 400);
            if (request.body.sourceId !== saved.instanceId) throw navigationUnavailable();
        }
        const { dependencies, changed } = captureRoleplayDependenciesLocked(lease, locator, locator.group ? request.body.groupId : undefined);
        if (saved.changed || changed) saveRoleplayAccount(lease);
        const alias = { kind: 'roleplay', ownerId: dependencies.find(item => item.kind === (locator.group ? 'group' : 'character')
            && (locator.group || item.locator?.avatar === locator.avatar)).instanceId };
        if (enrolNavigationAlias(document, saved.instanceId, alias)) writeNavigationState(lease, document);
        return { id: saved.instanceId, mode };
    }
    const savedPersona = document.personas[request.body.target?.personaId];
    const target = conversationTarget(request, request.body.target, { establish: true, lease, document });
    // Keep the persona incarnation authoritative during the backup await too.
    // A delete/reuse in that interval must not establish a different persona.
    if (!savedPersona) writeNavigationState(lease, document);
    const finish = (expectedId, expectedGroupOwner) => account(request, currentLease => {
        const current = readNavigationState(currentLease);
        const snapshot = settings(request);
        const branch = snapshot.extension_settings?.neconyan_conversation?.characters?.[target.threadKey]?.branches?.[target.input.branchId];
        if (!branch || branch.navigationId !== expectedId || (branch.lifetimeSeed || '') !== (target.branch.lifetimeSeed || '')
            || String(branch.createdAt || '') !== String(target.branch.createdAt || '') || current.personas[target.input.personaId] !== target.persona) throw navigationUnavailable();
        const verified = conversationTarget(request, request.body.target, { establish: true, lease: currentLease, document: current, checkExpected: false, snapshot });
        if (verified.ownerId !== target.ownerId) throw navigationUnavailable();
        const id = verified.branch.navigationId;
        if (!id) throw roleplayError('navigation_retry', 'Identity enrolment did not finish.', 503);
        const verifiedAlias = conversationAlias(currentLease, verified, current);
        if (JSON.stringify(verifiedAlias.groupOwner) !== JSON.stringify(expectedGroupOwner)) throw navigationUnavailable();
        if (enrolNavigationAlias(current, id, verifiedAlias)) writeNavigationState(currentLease, current);
        return { id, mode, version: verified.version };
    }, { write: true });
    const ownGroup = target.store.groups?.find(group => group.id === target.input.groupId);
    const alias = (!ownGroup || ownGroup.navigationId) ? conversationAlias(lease, target, document) : null;
    const previousAlias = document.aliases[target.branch.navigationId];
    const replace = Boolean(previousAlias && (alias ? JSON.stringify(previousAlias) !== JSON.stringify(alias) : ownGroup && !ownGroup.navigationId));
    if (target.branch.navigationId && alias && !replace) {
        if (enrolNavigationAlias(document, target.branch.navigationId, alias)) writeNavigationState(lease, document);
        return { id: target.branch.navigationId, mode, version: target.version };
    }
    // saveConversationStore performs its version check and disk write synchronously
    // before awaiting a backup. No lease crosses that await, and no transcript is saved.
    const promise = saveConversationStore(request, target.store, target.version, { navigationEnrolment: { threadKey: target.threadKey, branchId: target.input.branchId, groupId: ownGroup?.id, replace } })
        .then(result => {
            if (!result.ok) throw roleplayError('navigation_conflict', 'Settings changed. Retry.', result.status || 503);
            const groupOwner = target.input.groupId
                ? ownGroup ? { kind: 'conversation', id: result.store?.groups?.find(group => group.id === ownGroup.id)?.navigationId } : alias.groupOwner
                : null;
            return finish(result.store?.characters?.[target.threadKey]?.branches?.[target.input.branchId]?.navigationId, groupOwner);
        });
    return { promise };
}, { write: true });

function conversationAlias(lease, target, document) {
    let groupOwner = null;
    if (target.input.groupId) {
        const own = target.store.groups?.find(group => group.id === target.input.groupId);
        if (own) groupOwner = { kind: 'conversation', id: own.navigationId };
        else {
            const group = readRoleplayEntityLocked(lease, 'group', target.input.groupId);
            if (group.changed) saveRoleplayAccount(lease);
            groupOwner = { kind: 'roleplay', id: group.instanceId };
        }
    }
    const old = document.aliases[target.branch.navigationId];
    if (old && target.input.groupId && old.kind === 'conversation' && old.persona === target.persona
        && old.target.groupId === target.input.groupId && old.target.personaId === target.input.personaId
        && old.target.branchId === target.input.branchId && JSON.stringify(old.groupOwner) === JSON.stringify(groupOwner)) return old;
    return { kind: 'conversation', ownerId: target.ownerId, persona: target.persona, target: target.input, groupOwner };
}

route('/remember', (request, lease) => {
    const document = readNavigationState(lease);
    if (!settings(request).power_user?.auto_load_chat) return { accepted: false, pointer: document.pointer };
    resolve(request, lease, document, request.body.destination);
    const accepted = acceptNavigationPointer(document, request.body);
    if (accepted) writeNavigationState(lease, document);
    return { accepted, pointer: document.pointer };
}, { write: true });

route('/clear-stale', (request, lease) => {
    const document = readNavigationState(lease);
    if (!document.pointer || document.pointer.revision !== request.body.revision) return { cleared: false };
    try { resolve(request, lease, document, { id: document.pointer.id, mode: document.pointer.mode }, { allowDisabled: true }); return { cleared: false }; } catch (error) { if (error.status !== 404) throw error; }
    const cleared = clearNavigationPointer(document, request.body.revision);
    if (cleared) writeNavigationState(lease, document);
    return { cleared };
}, { write: true });

route('/migrate', (request, lease) => {
    const document = readNavigationState(lease);
    if (document.migration || document.pointer) return { pointer: document.pointer, migrated: false };
    if (request.body.destination && settings(request).power_user?.auto_load_chat) {
        resolve(request, lease, document, request.body.destination);
        acceptNavigationPointer(document, request.body);
    }
    document.migration = 1;
    writeNavigationState(lease, document);
    return { pointer: document.pointer, migrated: true };
}, { write: true });

/** Retire before deleting a persona, so a crash cannot resurrect its links on name reuse. */
export function retireNavigationPersona(request, avatar, remove) {
    const base = roleplayAccountBase(request.user.directories);
    if (!base) return remove();
    return withRoleplayAccount(base, null, lease => {
        const document = readNavigationState(lease);
        if (document.personas[avatar]) {
            const before = settings(request);
            const prepared = prepareSettingsSave(structuredClone(before), before, { conversationOnly: true, navigationRetirePersona: avatar });
            if (!prepared.ok) throw roleplayError('navigation_conflict', 'Conversation changed during persona deletion.', 409);
            tryWriteFileSync(path.join(request.user.directories.root, 'settings.json'), JSON.stringify(prepared.settings, null, 4));
            delete document.personas[avatar];
            writeNavigationState(lease, document);
        }
        return remove();
    });
}
