import path from 'node:path';
import { withChatFileLocks } from '../chat-file-lock.js';
import { fail, hash, putRecord, sourceAt, sourceEligible, validateRecord } from './core.js';
import { readJson, writeJson } from './store.js';
import { brief, namer, usable } from './story.js';

/** Most memories kept in the account-wide shared list; the oldest go first. */
export const SHARED_LIMIT = 500;
export const SHARE_KINDS = ['state', 'event', 'relationship', 'knowledge', 'commitment'];
const BRING_KINDS = ['event', 'relationship', 'commitment'];

function sharedPath(directories) {
    return path.join(directories.root, 'mewmory', 'shared.json');
}

function readShared(directories) {
    const value = readJson(sharedPath(directories), null);
    return Array.isArray(value?.entries) ? value.entries.filter(entry => entry && typeof entry === 'object' && entry.id) : [];
}

function writeShared(directories, change) {
    const filename = sharedPath(directories);
    return withChatFileLocks([filename], () => {
        const entries = change(readShared(directories));
        writeJson(filename, { entries: entries.slice(-SHARED_LIMIT) });
        return entries;
    });
}

/** The characters taking part in this chat, read from their character cards. */
export function characterSources(state) {
    return (state.contextSources || []).filter(ref => state.sources[ref.id]?.type === 'character' && sourceEligible(state, ref))
        .map(ref => ({ ref, id: ref.id, name: sourceAt(state, ref)?.speaker || 'Character' }));
}

function sharedText(state, record, nameOf) {
    const item = brief(state, record, nameOf);
    return record.kind === 'knowledge' && item.owner ? item.owner + ' knows: ' + item.text : item.text;
}

export function shareRecords(directories, state, ids, { chat = '', now = Date.now() } = {}) {
    const wanted = new Set(Array.isArray(ids) ? ids.filter(value => typeof value === 'string') : []);
    if (!wanted.size) fail('Tick at least one memory first.', 400);
    const characters = characterSources(state);
    if (!characters.length) fail('This chat has no character card to share memories with.', 409);
    const nameOf = namer(state);
    const records = usable(state).filter(record => wanted.has(record.id) && SHARE_KINDS.includes(record.kind));
    if (!records.length) fail('Only facts, events, relationships, knowledge and promises can be shared.', 400);
    const shared = records.map(record => ({
        id: hash([state.storyId, record.id].join('\u0000')).slice(0, 24),
        recordId: record.id, storyId: state.storyId, chat: String(chat).slice(0, 200),
        characterIds: characters.map(character => character.id), characterNames: characters.map(character => character.name),
        kind: record.kind, text: sharedText(state, record, nameOf).slice(0, 4000),
        subjects: brief(state, record, nameOf).subjects, sharedAt: now,
    }));
    const keys = new Set(shared.map(entry => entry.id));
    writeShared(directories, entries => [...entries.filter(entry => !keys.has(entry.id)), ...shared]);
    return { shared: shared.length, skipped: wanted.size - shared.length };
}

/** Shared memories for this chat's characters from other stories, plus the ones this chat shared. */
export function listShared(directories, state) {
    const characters = new Set(characterSources(state).map(character => character.id));
    const brought = new Set(state.records.filter(record => record.sharedFrom?.entryId && record.status !== 'invalidated')
        .map(record => record.sharedFrom.entryId));
    const entries = readShared(directories).sort((a, b) => (b.sharedAt || 0) - (a.sharedAt || 0));
    return {
        available: entries.filter(entry => entry.storyId !== state.storyId
            && (entry.characterIds || []).some(value => characters.has(value)))
            .map(entry => ({ ...entry, brought: brought.has(entry.id) })),
        mine: entries.filter(entry => entry.storyId === state.storyId),
        characters: characters.size,
    };
}

export function removeShared(directories, id) {
    if (typeof id !== 'string' || !id) fail('Choose a shared memory first.', 400);
    let found = false;
    writeShared(directories, entries => entries.filter(entry => {
        if (entry.id !== id) return true;
        found = true;
        return false;
    }));
    if (!found) fail('That shared memory is no longer there.', 404);
    return { removed: 1 };
}

/** Copies chosen shared memories into this chat as your own notes, based on the matching character card. */
export function bringShared(directories, state, ids) {
    const wanted = new Set(Array.isArray(ids) ? ids.filter(value => typeof value === 'string') : []);
    if (!wanted.size) fail('Choose at least one shared memory first.', 400);
    const characters = characterSources(state);
    const { available } = listShared(directories, state);
    const chosen = available.filter(entry => wanted.has(entry.id));
    if (chosen.length !== wanted.size) fail('One of those shared memories is no longer there. Reload Mewmory and try again.', 404);
    let added = 0;
    for (const entry of chosen) {
        if (entry.brought) continue;
        const character = characters.find(item => entry.characterIds.includes(item.id));
        const kind = BRING_KINDS.includes(entry.kind) ? entry.kind : 'event';
        const record = validateRecord(state, {
            id: 'shared:' + entry.id, kind, text: entry.text, refs: [character.ref],
            ...(kind === 'commitment' ? { triggerTerms: [] } : { evidenceStatus: 'reported' }),
        }, { asOf: -1, origin: 'author' });
        record.sharedFrom = { entryId: entry.id, chat: entry.chat, sharedAt: entry.sharedAt };
        putRecord(state, record);
        added++;
    }
    return { added, skipped: chosen.length - added };
}
