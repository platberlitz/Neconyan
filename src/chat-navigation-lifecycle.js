import path from 'node:path';
import { readNavigationState } from './chat-navigation-state.js';
import { readRoleplayFile, roleplayError, roleplayLease, roleplayStoreDirectory } from './roleplay-store.js';
import { getConversationThreadKey } from './endpoints/conversation-store.js';
import { readRoleplayEntityLocked } from './generation/roleplay-source.js';
import { prepareSettingsSave } from './settings-version.js';
import { tryWriteFileSync } from './util.js';

function readSettings(file) {
    try { return JSON.parse(file.bytes.toString('utf8')); } catch {
        throw roleplayError('navigation_retry', 'Saved Conversation storage cannot be read.', 503);
    }
}

/** Include only exact, already-linked group owners in the same rename journal. */
export function addChatNavigationCharacterRenameSteps(lease, action, steps) {
    if (action !== 'character-rename') return steps;
    const from = steps.find(step => step.kind === 'character' && step.op === 'delete')?.locator?.avatar;
    const to = steps.find(step => step.kind === 'character' && step.op === 'create')?.locator?.avatar;
    if (!from || !to) return steps;
    const { state } = roleplayLease(lease);
    const document = readNavigationState(lease);
    const ids = new Set(Object.values(document.aliases).map(alias => alias.kind === 'roleplay' ? alias.ownerId : alias.groupOwner?.kind === 'roleplay' ? alias.groupOwner.id : null));
    const updates = [];
    for (const id of ids) {
        const group = state.resources[id];
        if (group?.kind !== 'group' || group.status !== 'live' || steps.some(step => step.kind === 'group' && step.locator?.groupId === group.locator.groupId)) continue;
        const source = readRoleplayEntityLocked(lease, 'group', group.locator.groupId, { enrolMissing: false });
        if (!source.data.members.includes(from)) continue;
        const value = { ...source.data, members: source.data.members.map(member => member === from ? to : member),
            disabled_members: (source.data.disabled_members || []).map(member => member === from ? to : member) };
        updates.push({ op: 'update', kind: 'group', locator: group.locator, bytes: Buffer.from(JSON.stringify(value)) });
    }
    return [...steps, ...updates];
}

/** Refuse an occupied saved destination before the journal changes any file. */
export function assertChatNavigationCharacterRename(lease, { action, steps }) {
    if (action !== 'character-rename') return;
    const from = steps.find(step => step.kind === 'character' && step.op === 'delete');
    const to = steps.find(step => step.kind === 'character' && step.op === 'create');
    if (!from || !to) return;
    const aliases = Object.values(readNavigationState(lease).aliases).filter(alias => alias.kind === 'conversation' && alias.ownerId === from.instanceId);
    if (!aliases.length) return;
    const { scope } = roleplayLease(lease);
    const file = readRoleplayFile(path.join(scope.directories.root, 'settings.json'), 64 * 1024 * 1024);
    if (!file) throw roleplayError('navigation_retry', 'Saved Conversation storage is unavailable.', 503);
    const store = readSettings(file).extension_settings?.neconyan_conversation;
    for (const alias of aliases) {
        const oldKey = getConversationThreadKey(from.locator.avatar, alias.target.groupId, alias.target.personaId);
        const newKey = getConversationThreadKey(to.locator.avatar, alias.target.groupId, alias.target.personaId);
        if (store?.characters?.[oldKey] && store.characters[newKey]) throw roleplayError('ROLEPLAY_TARGET_EXISTS', 'The renamed Conversation destination is already occupied.', 409);
    }
}

/** Run inside the existing rename journal, while readers see its recovery barrier. */
export function finishChatNavigationCharacterRename(lease) {
    const { state, scope } = roleplayLease(lease);
    const pending = state.pending;
    if (pending.action !== 'character-rename') return;
    const from = pending.steps.find(step => step.kind === 'character' && step.op === 'delete');
    const to = pending.steps.find(step => step.kind === 'character' && step.op === 'create');
    if (!from || !to) return;
    const document = readNavigationState(lease);
    const aliases = Object.values(document.aliases).filter(alias => alias.ownerId === from.instanceId);
    if (!aliases.length) return;
    const conversations = aliases.filter(alias => alias.kind === 'conversation');
    if (conversations.length) {
        const filename = path.join(scope.directories.root, 'settings.json');
        const file = readRoleplayFile(filename, 64 * 1024 * 1024);
        if (!file) throw roleplayError('navigation_retry', 'Saved Conversation storage is unavailable.', 503);
        const before = readSettings(file);
        const next = structuredClone(before);
        const store = next.extension_settings?.neconyan_conversation;
        const moves = [];
        for (const alias of conversations) {
            const oldKey = getConversationThreadKey(from.locator.avatar, alias.target.groupId, alias.target.personaId);
            const newKey = getConversationThreadKey(to.locator.avatar, alias.target.groupId, alias.target.personaId);
            const old = store?.characters?.[oldKey];
            if (!old) continue; // Recovery already moved it, or the branch was deleted.
            if (store.characters[newKey]) throw roleplayError('navigation_conflict', 'The renamed Conversation destination is already occupied.', 409);
            store.characters[newKey] = old;
            old.threadAvatar = to.locator.avatar;
            delete store.characters[oldKey];
            moves.push({ from: oldKey, to: newKey });
        }
        for (const group of store?.groups || []) {
            group.members = group.members?.map(avatar => avatar === from.locator.avatar ? to.locator.avatar : avatar);
            group.disabled_members = group.disabled_members?.map(avatar => avatar === from.locator.avatar ? to.locator.avatar : avatar);
        }
        if (moves.length) {
            const prepared = prepareSettingsSave(next, before, { conversationOnly: true, trustedConversationEffects: true, navigationMoves: moves });
            if (!prepared.ok) throw roleplayError('navigation_conflict', 'Conversation changed during rename.', 409);
            tryWriteFileSync(filename, JSON.stringify(prepared.settings, null, 4));
        }
    }
    for (const alias of aliases) {
        alias.ownerId = to.instanceId;
        if (alias.kind === 'conversation') alias.target.avatar = to.locator.avatar;
    }
    // This write is journalled by the pending lifecycle. Recovery repeats safely
    // before committing the new protected source; ordinary writes cannot do this.
    tryWriteFileSync(path.join(roleplayStoreDirectory(scope), 'navigation.json'), JSON.stringify(document));
}
