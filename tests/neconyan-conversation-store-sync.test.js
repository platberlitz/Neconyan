import { describe, expect, test } from '@jest/globals';

import {
    conversationValuesEqual,
    isSameConversationBranchIdentity,
    mergeConversationStore,
} from '../public/scripts/neconyan-conversation/store-sync-utils.js';

function message(id, mes, role = 'character', extra = {}) {
    return { id, role, name: role === 'user' ? 'You' : 'Alice', mes, created_at: 1, extra: { conversation_mode_user: role === 'user', ...extra } };
}

function branch(id, messages, createdAt, extra = {}) {
    return { id, name: 'Main', messages, preview: '', unread: 0, lastActivity: 1, followupCount: 0, createdAt, ...extra };
}

function thread(branches, extra = {}) {
    return { activeBranchId: 'main', branches, ...extra };
}

function store(characters, extra = {}) {
    return { version: 1, localStorageMigrated: true, settings: {}, characters, groups: [], reminders: [], ...extra };
}

describe('conversation store sync merge', () => {
    test('a repeated server unread count wins over a stale local clear', () => {
        const wrap = (messages, unread, readThrough) => store({ alice: thread({ main: branch('main', messages, 10, { unread, readThrough }) }) });
        const messages = [message('read', 'Seen'), message('a', 'First')];
        const saved = wrap(messages, 1, 'read');
        const local = wrap(messages, 0, 'read');
        const server = wrap([...messages, message('b', 'New')], 1, 'a');
        const merged = mergeConversationStore(server, local, saved).characters.alice.branches.main;
        expect(merged.unread).toBe(1);
        expect(merged.readThrough).toBe('a');
    });
    test('legacy occurrences survive local edits, native appends and repeated refreshes without duplication', () => {
        const legacy = { role: 'user', mes: 'Repeated without an id or timestamp', extra: { b: 2, a: 1 } };
        const wrap = messages => store({ alice: thread({ main: branch('main', messages, 10) }) });
        const saved = wrap([legacy, legacy, message('known', 'Original')]);
        const local = wrap([{ extra: { a: 1, b: 2 }, mes: legacy.mes, role: 'user' }, legacy, message('known', 'Local edit')]);
        const server = wrap([legacy, legacy, message('known', 'Original'), message('native', 'Native append')]);
        const first = mergeConversationStore(server, local, saved);
        const second = mergeConversationStore(server, first, server);
        expect(second.characters.alice.branches.main.messages).toEqual([legacy, legacy, message('known', 'Local edit'), message('native', 'Native append')]);
    });

    test('legacy deletions and distinct concurrent additions retain their occurrence counts', () => {
        const a = { mes: 'Repeat', role: 'user' };
        const localNew = { mes: 'Local addition', role: 'user' };
        const serverNew = { mes: 'Server addition', role: 'character' };
        const wrap = messages => store({ alice: thread({ main: branch('main', messages, 10) }) });
        expect(mergeConversationStore(wrap([a, a, serverNew]), wrap([a]), wrap([a, a])).characters.alice.branches.main.messages).toEqual([a, serverNew]);
        expect(mergeConversationStore(wrap([a, serverNew]), wrap([a, localNew]), wrap([a])).characters.alice.branches.main.messages).toEqual([a, serverNew, localNew]);
    });

    test('ambiguous legacy changes and colliding new branches refuse to guess', () => {
        const a = { mes: 'Original' };
        const b = { mes: 'Repeated addition' };
        const wrap = messages => store({ alice: thread({ main: branch('main', messages, 10) }) });
        const saved = wrap([a]);
        const local = wrap([{ mes: 'Local replacement' }]);
        expect(mergeConversationStore(wrap([{ mes: 'Server replacement' }]), local, saved)).toBeNull();
        expect(mergeConversationStore(wrap([a, b, message('native', 'New')]), wrap([a, b]), saved)).toBeNull();
        expect(mergeConversationStore(wrap([a, b]), wrap([a, b]), saved)).toBeNull();
        expect(mergeConversationStore(wrap([a, message('native', 'New')]), local, saved)).toBeNull();
        expect(mergeConversationStore(wrap([message('normalised', 'Original')]), local, saved)).toBeNull();
        expect(mergeConversationStore(wrap([a]), local, store({}))).toBeNull();
        expect(mergeConversationStore(wrap([a, message('b', 'Middle')]), wrap([message('b', 'Middle'), a]), wrap([a, message('b', 'Middle'), a]))).toBeNull();
        expect(local.characters.alice.branches.main.messages).toEqual([{ mes: 'Local replacement' }]);
    });

    test('an unchanged local store accepts the server value', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const local = JSON.parse(JSON.stringify(saved));
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('b', 'native')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages).toHaveLength(2);
    });

    test('a local-only edit is kept while native messages are added', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const edited = message('a', 'one');
        edited.extra.conversation_reply_to = { messageId: 'x' };
        const local = store({ alice: thread({ main: branch('main', [edited], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('b', 'native')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        const messages = merged.characters.alice.branches.main.messages;
        expect(messages).toHaveLength(2);
        expect(messages[0].extra.conversation_reply_to).toEqual({ messageId: 'x' });
        expect(messages[1].id).toBe('b');
    });

    test('identical changes on both sides are accepted once', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'two')], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'two')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages).toHaveLength(1);
        expect(merged.characters.alice.branches.main.messages[0].mes).toBe('two');
    });

    test('a local message deletion is kept when it existed in the baseline', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('b', 'two')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('b', 'two')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages.map(item => item.id)).toEqual(['a']);
    });

    test('a local deletion stands while the server appends another message', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('b', 'two')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('b', 'two'), message('native', 'hi')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages.map(item => item.id)).toEqual(['a', 'native']);
    });

    test('a server deletion stands while the browser copy is unchanged', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('b', 'two')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('b', 'two')], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages.map(item => item.id)).toEqual(['a']);
    });

    test('an unseen native message is not treated as a local deletion', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('native', 'hi')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages.map(item => item.id)).toEqual(['a', 'native']);
    });

    test('a local edit of a server-owned message is kept', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('native', 'hi')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('native', 'tampered')], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('native', 'hi')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages[0].mes).toBe('tampered');
    });

    test('a browser edit of a message it never saw loses to the server copy', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('native', 'tampered')], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('native', 'hi')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        const messages = merged.characters.alice.branches.main.messages;
        expect(messages.map(item => item.id)).toEqual(['a', 'native']);
        expect(messages[1].mes).toBe('hi');
    });

    test('a local reset against a concurrent server change is a conflict', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('fresh', 'new thread')], 20) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one'), message('b', 'native')], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged).toBeNull();
    });

    test('a branch deleted locally against a concurrent server change is a conflict', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10), side: branch('side', [], 11) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10), side: branch('side', [message('c', 'new')], 11) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged).toBeNull();
    });

    test('a local-only branch addition survives a merge', () => {
        const saved = store({ alice: thread({ main: branch('main', [], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [], 10), draft: branch('draft', [message('d', 'mine')], 12) }) });
        const server = store({ alice: thread({ main: branch('main', [], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.draft).toBeTruthy();
        expect(merged.characters.alice.branches.draft.messages[0].id).toBe('d');
    });

    test('server ordering is preserved rather than sorted by timestamps', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const first = message('b', 'later-id-created-earlier');
        first.created_at = 1;
        const second = message('c', 'earlier-id-created-later');
        second.created_at = 99;
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one'), first, second], 10) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages.map(item => item.id)).toEqual(['a', 'b', 'c']);
    });

    test('an intact branch keeps its local receipts during a message edit', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10, { serverOperations: { job: { messagesHash: 'x', effects: { e: 1 } } } }) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'edited')], 10, { serverOperations: { job: { messagesHash: 'x', effects: { e: 1 } } } }) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10, { serverOperations: { job: { messagesHash: 'x', effects: { e: 1 } } } }) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.serverOperations).toEqual({ job: { messagesHash: 'x', effects: { e: 1 } } });
    });

    test('a reset branch (new createdAt) does not carry the old receipts', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10, { serverOperations: { job: { messagesHash: 'x', effects: {} } } }) }) });
        const local = store({ alice: thread({ main: branch('main', [message('fresh', 'new thread')], 20) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10, { serverOperations: { job: { messagesHash: 'x', effects: {} } } }) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages[0].id).toBe('fresh');
        expect(merged.characters.alice.branches.main.serverOperations).toBeUndefined();
    });

    test('a server-consumed presentation claim is not resurrected from a stale local copy', () => {
        const claims = { 'msg-1': { at: 1, narration: null } };
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10, { serverOperations: { job: {} }, pendingPresentations: claims }) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10, { serverOperations: { job: {} }, pendingPresentations: claims }) }) });
        const server = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10, { serverOperations: { job: {} } }) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.pendingPresentations).toBeUndefined();

        const replaced = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10, { serverOperations: { job: {} }, pendingPresentations: { 'msg-2': { at: 2, narration: null } } }) }) });
        const second = mergeConversationStore(replaced, local, saved);
        expect(second.characters.alice.branches.main.pendingPresentations).toEqual({ 'msg-2': { at: 2, narration: null } });
    });

    test('unknown store fields and unrelated groups are preserved', () => {
        const saved = store({ alice: thread({ main: branch('main', [], 10) }) }, { automation: { mode: 'server' }, customField: 7 });
        const local = store({ alice: thread({ main: branch('main', [], 10) }) }, { automation: { mode: 'server' }, customField: 7 });
        const server = store({ alice: thread({ main: branch('main', [message('n', 'hi')], 10) }) }, { automation: { mode: 'server' }, customField: 7 });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.automation.mode).toBe('server');
        expect(merged.customField).toBe(7);
        expect(merged.characters.alice.branches.main.messages[0].id).toBe('n');
    });

    test('a server reset does not resurrect a locally edited message', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const edited = message('a', 'edited locally');
        const local = store({ alice: thread({ main: branch('main', [edited], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [], 20) }) });
        expect(mergeConversationStore(server, local, saved)).toBeNull();
    });

    test('a server reset replaces an untouched local branch', () => {
        const saved = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const local = store({ alice: thread({ main: branch('main', [message('a', 'one')], 10) }) });
        const server = store({ alice: thread({ main: branch('main', [message('fresh', 'new')], 20) }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.main.messages[0].id).toBe('fresh');
        expect(merged.characters.alice.branches.main.createdAt).toBe(20);
    });

    test('canonical comparison ignores key order and branch identity compares createdAt', () => {
        expect(conversationValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
        expect(conversationValuesEqual([{ x: 1 }], [{ x: 2 }])).toBe(false);
        expect(isSameConversationBranchIdentity({ createdAt: 5 }, { createdAt: 5 })).toBe(true);
        expect(isSameConversationBranchIdentity({ createdAt: 5 }, { createdAt: 6 })).toBe(false);
        expect(isSameConversationBranchIdentity(null, { createdAt: 5 })).toBe(false);
    });
});
