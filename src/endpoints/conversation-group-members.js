/**
 * Conversation Mode REST API - group DM members
 *
 * Adding and removing the members of a Conversation-owned group DM edits the server's own latest
 * copy of the store in one write and takes no client version, so a page that has fallen behind
 * still changes what it shows and nothing it holds is trusted. The group keeps its history: every
 * thread key of the group is folded into one member who stays (the holder), the removed members'
 * messages are rewritten to keep their speaker, the group's reminders follow the holder, and open
 * jobs that can no longer land are cancelled.
 */

import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';

import { getSettingsVersion } from '../settings-version.js';
import {
    getConversationThreadKey,
    readConversationStoreForWrite,
    readUserSettingsWithStatus,
    saveConversationStore,
} from './conversation-store.js';
import { normalizeConversationGroupRecord } from './conversation-groups.js';
import { normalizeConversationSettings } from './conversation-generation.js';
import { getGroupThreadRank, mergeGroupThreadStore } from './conversation-threads.js';
import { cancelConversationJobsWhere } from './conversation-delete.js';
import {
    getConversationPersonaId,
    isObject,
    scopeConversationStorageKey,
    unScopeConversationStorageKey,
    validateAvatar,
} from './conversation-utils.js';

const normalizeGroupRecord = group => normalizeConversationGroupRecord(group, normalizeConversationSettings);
const CANCEL_REASON = 'The Conversation group members changed.';
const MAX_MEMBERS = 128;
const MAX_NAME_LENGTH = 512;

const refuse = (status, error) => ({ ok: false, status, body: { error } });

/** An avatar the page may name: a valid storage part that is also a plain file name. */
function isPlainAvatar(value) {
    if (!validateAvatar(value).valid) return false;
    const name = value.trim();
    return name === value && name === path.basename(name) && name === sanitize(name) && name !== '.' && name !== '..';
}

/** The member list an edit names: at most 128 plain avatars. Returns null when it is not one. */
function readAvatarList(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_MEMBERS || !value.every(isPlainAvatar)) return null;
    return [...new Set(value)];
}

/** What the server tests to say a card exists, as `conversation-generation.js` does. */
function hasCharacterCard(request, avatar) {
    const file = sanitize(path.basename(avatar));
    return path.extname(file).toLowerCase() === '.png' && fs.existsSync(path.join(request.user.directories.characters, file));
}

const hasHistory = rank => Number(rank.hasHistory);

/**
 * Rewrite one member's thread so it reads right in the holder's thread: the member's own turns (role
 * 'character') become that member's partner turns, and the holder's partner turns become the character's.
 * Ids, order, names and every other field stay as they are. Returns a copy.
 */
function retargetConversationGroupThread(thread, from, to) {
    // A JSON copy, not structuredClone: the store holds plain JSON, and a structured clone is not a plain object to every realm that reads it.
    const copy = JSON.parse(JSON.stringify(thread));
    if (from === to) return copy;
    for (const branch of Object.values(isObject(copy.branches) ? copy.branches : {})) {
        if (!Array.isArray(branch?.messages)) continue;
        branch.messages = branch.messages.map(message => {
            if (!isObject(message)) return message;
            const partner = isObject(message.extra) ? String(message.extra.partner_avatar || '').trim() : '';
            if (message.role === 'character' && !partner) {
                return { ...message, role: 'partner', extra: { ...(isObject(message.extra) ? message.extra : {}), partner_avatar: from } };
            }
            if (message.role === 'partner' && partner === to) {
                const extra = { ...message.extra };
                delete extra.partner_avatar;
                return { ...message, role: 'character', extra };
            }
            return message;
        });
    }
    return copy;
}

/**
 * Add and remove members of a Conversation-owned group DM.
 * @returns {Promise<object | { ok: false, status: number, body: object }>} `{ changed, scope, store, version, group, anchor }`
 */
export async function updateConversationGroupMembers(request, { groupId = '', personaId = '', add = [], remove = [], rename = null } = {}) {
    const persona = getConversationPersonaId(personaId);
    const safeGroupId = String(groupId || '').trim();
    const added = readAvatarList(add);
    const removed = readAvatarList(remove);
    if (!added || !removed || added.some(avatar => removed.includes(avatar))) return refuse(400, 'invalid_members');
    if (rename !== null && rename !== undefined) {
        if (!isObject(rename) || typeof rename.from !== 'string' || typeof rename.to !== 'string'
            || rename.from.length > MAX_NAME_LENGTH || rename.to.length > MAX_NAME_LENGTH || !rename.to) {
            return refuse(400, 'invalid_group_name');
        }
    }

    const settings = readUserSettingsWithStatus(request);
    if (!settings.ok) return refuse(500, 'settings_read_failed');
    const version = getSettingsVersion(settings.data);
    // This read, the edit and the save below run in one tick, so there is nothing to retry.
    const context = readConversationStoreForWrite(request, version, normalizeGroupRecord);
    if (!context.ok) return context;
    const { store } = context;

    const group = store.groups.find(item => String(item?.id) === safeGroupId && getConversationPersonaId(item?.personaId) === persona);
    if (!group || group.is_conversation_group !== true) return refuse(404, 'group_not_found');
    for (const avatar of added) {
        if (!hasCharacterCard(request, avatar)) return refuse(400, 'member_not_found');
    }

    const members = group.members;
    const next = members.filter(member => !removed.includes(member));
    for (const avatar of added) if (!next.includes(avatar)) next.push(avatar);
    const disabled = (Array.isArray(group.disabled_members) ? group.disabled_members : [])
        .filter(member => next.includes(member) && !added.includes(member));
    if (next.length < 2) return refuse(400, 'members_required');
    if (next.length > MAX_MEMBERS) return refuse(400, 'too_many_members');

    const scope = { removeKeys: [], keyPrefix: '', groupId: '', personaId: persona, reminderIds: [], replaceKeys: {} };
    const sameList = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    const holderKeyFor = avatar => getConversationThreadKey(avatar, safeGroupId, persona);
    if (sameList(next, members) && sameList(disabled, group.disabled_members || [])) {
        // A rename alone changes nothing: renaming groups is not part of this route.
        return { changed: false, scope, store, version, group, anchor: null };
    }

    const candidates = next.filter(member => !disabled.includes(member) && hasCharacterCard(request, member));
    if (!candidates.length) return refuse(400, 'no_available_members');

    // Every thread key of this group for this persona: the scoped keys, and unscoped legacy keys assigned to the persona.
    const unscopedPrefix = `group:${safeGroupId}:`;
    const groupPrefix = scopeConversationStorageKey(unscopedPrefix, persona);
    const assignments = isObject(store.legacyThreadPersonaAssignments) ? store.legacyThreadPersonaAssignments : {};
    const entries = [];
    for (const [key, thread] of Object.entries(store.characters)) {
        if (!isObject(thread)) continue;
        const local = unScopeConversationStorageKey(key, persona);
        const scoped = local !== null && local.startsWith(unscopedPrefix);
        const legacy = !scoped && Boolean(persona) && unScopeConversationStorageKey(key, '') !== null && key.startsWith(unscopedPrefix)
            && String(assignments[key] || '').trim() === persona;
        if (!scoped && !legacy) continue;
        const avatar = (scoped ? local : key).slice(unscopedPrefix.length);
        const order = members.indexOf(avatar);
        entries.push({ key, avatar, thread, legacy, order: order < 0 ? members.length : order, rank: getGroupThreadRank(thread) });
    }
    // The best thread first, as canonicalizeConversationGroupThread ranks them; a scoped key before a legacy one at a tie.
    entries.sort((left, right) => hasHistory(right.rank) - hasHistory(left.rank)
        || right.rank.updatedAt - left.rank.updatedAt
        || left.order - right.order
        || Number(left.legacy) - Number(right.legacy));
    const holderEntry = entries.find(entry => candidates.includes(entry.avatar));
    const holder = holderEntry ? holderEntry.avatar : candidates[0];
    const holderKey = holderKeyFor(holder);
    if (!holderKey) return refuse(400, 'invalid_members');

    const moves = [];
    const folded = [];
    const sources = entries.filter(entry => entry.key !== holderKey);
    let base = isObject(store.characters[holderKey]) ? store.characters[holderKey] : null;
    if (!base && sources.length) {
        const first = sources.shift();
        base = retargetConversationGroupThread(first.thread, first.avatar, holder);
        store.characters[holderKey] = base;
        delete store.characters[first.key];
        delete assignments[first.key];
        moves.push({ from: first.key, to: holderKey });
        folded.push(first.key);
    }
    for (const source of sources) {
        if (base) mergeGroupThreadStore(base, retargetConversationGroupThread(source.thread, source.avatar, holder), source.avatar);
        delete store.characters[source.key];
        delete assignments[source.key];
        folded.push(source.key);
    }
    if (base) {
        base.threadAvatar = holder;
        base.groupId = safeGroupId;
    }
    if (folded.length) {
        scope.keyPrefix = groupPrefix;
        scope.removeKeys = folded;
    }

    for (const reminder of store.reminders) {
        if (String(reminder?.groupId || '') === safeGroupId && String(reminder?.personaId || '') === persona) reminder.avatar = holder;
    }

    group.members = next;
    group.disabled_members = disabled;
    if (rename && group.name === rename.from) group.name = rename.to;
    group.updatedAt = Date.now();

    // Trusted: this route edits the server's own copy, read and saved in this tick, with no store from the browser in it.
    // Its moves are declared, so the thread keeps its navigation identity and its server records at the new key.
    const saved = await saveConversationStore(request, store, version, {
        trustedConversationEffects: true,
        navigationMoves: moves,
        settingsSnapshot: context.snapshot,
    });
    if (!saved.ok) return { ok: false, status: saved.status || 500, body: saved.body || { error: 'save_failed' } };

    const foldedKeys = new Set(folded);
    const gone = new Set(members.filter(member => !next.includes(member)));
    cancelConversationJobsWhere(request, job => {
        const id = job.target.id;
        if (foldedKeys.has(id)) return true;
        return job.type === 'conversation.participant' && id.startsWith(groupPrefix) && gone.has(String(job.config?.speakerAvatar || ''));
    }, { reason: CANCEL_REASON });

    const savedGroup = (saved.store.groups || []).find(item => String(item?.id) === safeGroupId && getConversationPersonaId(item?.personaId) === persona) || group;
    return { changed: true, scope, store: saved.store, version: saved.version, group: savedGroup, anchor: { avatar: holder, threadKey: holderKey } };
}
