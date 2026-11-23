import { describe, expect, test } from '@jest/globals';

import {
    conversationValuesEqual,
    isSameConversationBranchIdentity,
    mergeConversationStore,
} from '../public/scripts/neconyan-conversation/store-sync-utils.js';
import * as storeSyncUtils from '../public/scripts/neconyan-conversation/store-sync-utils.js';

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
    test('a full thread keeps both new messages instead of blocking readback', () => {
        const items = Array.from({ length: 250 }, (_, i) => message(`m${i}`, `Message ${i}`));
        const wrap = messages => store({ alice: thread({ main: branch('main', messages, 10) }) });
        const saved = wrap(items);
        const local = wrap([...items.slice(1), message('local', 'Local note', 'user')]);
        const server = wrap([...items.slice(1), message('native', 'Server reply')]);
        const merged = mergeConversationStore(server, local, saved).characters.alice.branches.main.messages;
        expect(merged.map(item => item.id)).toEqual([...items.slice(2).map(item => item.id), 'native', 'local']);
    });

    test('a firing server reminder and a new local reminder merge by identity', () => {
        const old = { id: 'old', text: 'The server reminder', fired: false };
        const added = { id: 'new', text: 'The local reminder', fired: false };
        const fired = { ...old, fired: true };
        const merged = mergeConversationStore(store({}, { reminders: [fired] }),
            store({}, { reminders: [old, added] }), store({}, { reminders: [old] }));
        expect(merged.reminders).toEqual([fired, added]);
    });

    test('a deleted local thread does not reappear when another character replies', () => {
        const main = thread({ main: branch('main', [], 10) });
        const saved = store({ alice: main, bob: main });
        const local = store({ alice: main });
        const server = store({ alice: thread({ main: branch('main', [message('native', 'Hello')], 10) }), bob: main });
        expect(mergeConversationStore(server, local, saved).characters).toEqual({ alice: server.characters.alice });
    });

    test('a deleted group drops a thread key the page created after its baseline, while a new local group keeps its key', () => {
        const deleted = { id: 'G1', personaId: '', members: ['A', 'B'], conversation_settings: { auto_character_chat: true } };
        const added = { id: 'G2', personaId: '', members: ['A', 'C'], conversation_settings: {} };
        const groupThread = () => thread({ main: branch('main', [message('g', 'History')], 12) });
        const saved = store({}, { groups: [deleted] });
        const local = store({
            'persona:user-default.png:group:G1:A': groupThread(),
            'group:G2:A': groupThread(),
        }, { groups: [deleted, added] });
        const server = store({}, { groups: [] });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.groups.map(group => group.id)).toEqual(['G2']);
        expect(Object.keys(merged.characters)).toEqual(['group:G2:A']);
    });

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

    test('a new branch copied with another chat link ID still merges with the server copy', () => {
        const messages = [message('a', 'Original question.')];
        const main = branch('main', messages, 10, { navigationId: 'main-link' });
        const saved = store({ alice: thread({ main }) });
        const local = store({ alice: thread({ main, recovered: { ...main, id: 'recovered', createdAt: 11 } }) });
        const recovered = branch('recovered', messages, 11, { messageEditRevision: 2, messageContentHash: 'hash' });
        const server = store({ alice: thread({ main, recovered }) });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged.characters.alice.branches.recovered).toEqual(recovered);
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

describe('conversation store sync: local resets and DM delete helpers', () => {
    const wrapped = (characters, extra = {}) => store(characters, extra);

    test('a local reset merges when the server changed only another thread', () => {
        const saved = wrapped({
            alice: thread({ main: branch('main', [message('a', 'one')], 10) }),
            bob: thread({ main: branch('main', [message('b1', 'hi')], 11) }),
        });
        const local = wrapped({
            alice: thread({ main: branch('main', [message('fresh', 'new thread')], 20) }),
            bob: thread({ main: branch('main', [message('b1', 'hi')], 11) }),
        });
        const server = wrapped({
            alice: thread({ main: branch('main', [message('a', 'one')], 10) }),
            bob: thread({ main: branch('main', [message('b1', 'hi'), message('b2', 'native')], 11) }),
        });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged).not.toBeNull();
        expect(merged.characters.alice.branches.main.createdAt).toBe(20);
        expect(merged.characters.alice.branches.main.messages.map(item => item.id)).toEqual(['fresh']);
        expect(merged.characters.bob.branches.main.messages.map(item => item.id)).toEqual(['b1', 'b2']);
    });

    test('a local reset merges when the server changed only bookkeeping on another thread', () => {
        const saved = wrapped({
            alice: thread({ main: branch('main', [message('a', 'one')], 10) }),
            bob: thread({ main: branch('main', [], 11) }),
        });
        const local = wrapped({
            alice: thread({ main: branch('main', [message('fresh', 'new thread')], 20) }),
            bob: thread({ main: branch('main', [], 11) }),
        });
        const server = wrapped({
            alice: thread({ main: branch('main', [message('a', 'one')], 10) }),
            bob: thread({ main: branch('main', [], 11, { lastActivity: 99, followupCount: 1 }) }),
        });
        const merged = mergeConversationStore(server, local, saved);
        expect(merged).not.toBeNull();
        expect(merged.characters.alice.branches.main.createdAt).toBe(20);
        expect(merged.characters.bob.branches.main.lastActivity).toBe(99);
    });

    test('a local unread clear on a branch the server left alone keeps the server value', () => {
        const messages = [message('read', 'Seen'), message('a', 'First')];
        const wrap = (unread, bobMessages) => wrapped({
            alice: thread({ main: branch('main', messages, 10, { unread, readThrough: 'read' }) }),
            bob: thread({ main: branch('main', bobMessages, 11) }),
        });
        const merged = mergeConversationStore(wrap(1, [message('n', 'native')]), wrap(0, []), wrap(1, []));
        expect(merged.characters.alice.branches.main.unread).toBe(1);
    });

    describe('applyConversationDeleteScope with a merge', () => {
        const scope = (over = {}) => ({ removeKeys: [], keyPrefix: '', groupId: '', personaId: '', reminderIds: [], replaceKeys: {}, ...over });
        const edit = (server, local, saved, deleteScope) => mergeConversationStore(
            server,
            storeSyncUtils.applyConversationDeleteScope(local, deleteScope),
            storeSyncUtils.applyConversationDeleteScope(saved, deleteScope),
        );

        test('a group alias key the baseline never had is gone', () => {
            const group = { id: 'G', personaId: '', members: ['A', 'B'] };
            const saved = wrapped({ 'group:G:A': thread({ main: branch('main', [message('a', 'hist')], 10) }), C: thread({ main: branch('main', [], 12) }) }, { groups: [group] });
            const local = wrapped({ 'group:G:B': thread({ main: branch('main', [message('a', 'hist')], 10) }), C: thread({ main: branch('main', [], 12) }) }, { groups: [group] });
            const server = wrapped({ C: thread({ main: branch('main', [], 12) }) });
            const merged = edit(server, local, saved, scope({ removeKeys: ['group:G:A'], keyPrefix: 'group:G:', groupId: 'G' }));
            expect(Object.keys(merged.characters)).toEqual(['C']);
            expect(merged.groups).toEqual([]);
        });

        test('a solo thread that exists only in the page is gone', () => {
            const saved = wrapped({ B: thread({ main: branch('main', [], 11) }) });
            const local = wrapped({ A: thread({ main: branch('main', [], 20) }, { settings: { enabled: true } }), B: thread({ main: branch('main', [], 11) }) });
            const server = wrapped({ B: thread({ main: branch('main', [], 11) }) });
            const merged = edit(server, local, saved, scope({ removeKeys: ['A'] }));
            expect(Object.keys(merged.characters)).toEqual(['B']);
        });

        test('an unsaved edit to another group record is kept', () => {
            const g1 = { id: 'G1', personaId: '', members: ['A', 'B'], conversation_settings: { auto_character_chat: true } };
            const g2 = { id: 'G2', personaId: '', members: ['B', 'C'], conversation_settings: { auto_character_chat: true } };
            const g2edited = { ...g2, conversation_settings: { auto_character_chat: false } };
            const saved = wrapped({ C: thread({ main: branch('main', [], 12) }) }, { groups: [g1, g2] });
            const local = wrapped({ C: thread({ main: branch('main', [], 12) }) }, { groups: [g1, g2edited] });
            const server = wrapped({ C: thread({ main: branch('main', [], 12) }) }, { groups: [g2] });
            const merged = edit(server, local, saved, scope({ keyPrefix: 'group:G1:', groupId: 'G1' }));
            expect(merged.groups.map(group => `${group.id}:${group.conversation_settings.auto_character_chat}`)).toEqual(['G2:false']);
        });

        test('a new local reminder is kept and the deleted one is gone', () => {
            const r1 = { id: 'r1', avatar: 'A', text: 'x' };
            const r2 = { id: 'r2', avatar: 'B', text: 'y' };
            const added = { id: 'r3', avatar: 'B', text: 'z' };
            const saved = wrapped({ A: thread({ main: branch('main', [], 10) }), B: thread({ main: branch('main', [], 11) }) }, { reminders: [r1, r2] });
            const local = wrapped({ A: thread({ main: branch('main', [], 10) }), B: thread({ main: branch('main', [], 11) }) }, { reminders: [r1, r2, added] });
            const server = wrapped({ B: thread({ main: branch('main', [], 11) }) }, { reminders: [r2] });
            const merged = edit(server, local, saved, scope({ removeKeys: ['A'], reminderIds: ['r1'] }));
            expect(Object.keys(merged.characters)).toEqual(['B']);
            expect(merged.reminders.map(reminder => reminder.id)).toEqual(['r2', 'r3']);
        });

        test('an unrelated real conflict still returns null', () => {
            const g1 = { id: 'G1', personaId: '', members: ['A', 'B'], name: 'one' };
            const g2 = { id: 'G2', personaId: '', members: ['B', 'C'], name: 'two' };
            const history = () => thread({ main: branch('main', [message('g', 'hist')], 12) });
            const soloA = (messages, createdAt = 10) => thread({ main: branch('main', messages, createdAt) });
            const saved = wrapped({ A: soloA([message('a', 'one')]), 'group:G1:A': history(), 'group:G1:B': history() }, { groups: [g1, g2] });
            const untouched = wrapped({ A: soloA([message('a', 'one')]), 'group:G1:A': history(), 'group:G1:B': history() }, { groups: [g1, g2] });
            const local = wrapped({ A: soloA([message('fresh', 'new thread')], 20), 'group:G1:A': history(), 'group:G1:B': history() }, { groups: [g1, g2] });
            const server = wrapped({ A: soloA([message('a', 'one'), message('b', 'native')]) }, { groups: [g2] });
            const deleteG1 = scope({ removeKeys: ['group:G1:A', 'group:G1:B'], keyPrefix: 'group:G1:', groupId: 'G1' });
            const clean = edit(server, untouched, saved, deleteG1);
            expect(clean).not.toBeNull();
            expect(Object.keys(clean.characters)).toEqual(['A']);
            expect(clean.groups.map(group => group.id)).toEqual(['G2']);
            expect(edit(server, local, saved, deleteG1)).toBeNull();
        });

        test('a group the server deleted stays deleted when the page had changed its record', () => {
            const g1 = { id: 'G1', personaId: '', members: ['A', 'B'], name: 'one', conversation_settings: { auto_character_chat: true } };
            const g2 = { id: 'G2', personaId: '', members: ['B', 'C'], name: 'two', conversation_settings: { auto_character_chat: true } };
            const g3 = { id: 'G3', personaId: '', members: ['A', 'C'], name: 'three', conversation_settings: {} };
            const others = messages => thread({ main: branch('main', messages, 11) });
            const history = () => thread({ main: branch('main', [message('g', 'hist')], 12) });
            const saved = wrapped({ B: others([message('b1', 'hi')]), 'group:G1:A': history() }, { groups: [g1, g2] });
            const local = wrapped({ B: others([message('b1', 'hi')]), 'group:G1:A': history() }, {
                groups: [
                    { ...g1, name: 'renamed', conversation_settings: { auto_character_chat: false } },
                    { ...g2, conversation_settings: { auto_character_chat: false } },
                    g3,
                ],
            });
            const server = wrapped({ B: others([message('b1', 'hi'), message('b2', 'native')]) }, { groups: [g2] });
            const merged = mergeConversationStore(server, local, saved);
            expect(merged).not.toBeNull();
            expect(merged.groups.map(group => group.id)).toEqual(['G2', 'G3']);
            expect(merged.groups[0].conversation_settings.auto_character_chat).toBe(false);
            expect(Object.keys(merged.characters).filter(key => key.startsWith('group:G1:'))).toEqual([]);
        });

        test('a replaceKeys record replaces A in the deleting tab and wins in a refresh-only tab', () => {
            const schedule = { generatedAt: 5, days: [[{ time: '00:00-23:59', status: 'busy', activity: 'work' }]] };
            const kept = { settings: {}, schedule, activeBranchId: 'main', branches: { main: branch('main', [], 30) } };
            const old = () => thread({ main: branch('main', [message('a', 'one')], 10) }, { settings: { enabled: true }, schedule, memorySummary: 'm' });
            const saved = wrapped({ A: old(), B: thread({ main: branch('main', [], 11) }, { settings: { cooldown: 1 } }) });
            const local = wrapped({ A: old(), B: thread({ main: branch('main', [], 11) }, { settings: { cooldown: 2 } }) });
            const server = wrapped({ A: kept, B: thread({ main: branch('main', [], 11) }, { settings: { cooldown: 1 } }) });
            const merged = edit(server, local, saved, scope({ replaceKeys: { A: kept } }));
            expect(merged.characters.A).toEqual(kept);
            expect(merged.characters.B.settings.cooldown).toBe(2);
            const other = mergeConversationStore(server, saved, saved);
            expect(other.characters.A).toEqual(kept);
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(other.characters.A)).toBe(true);
        });

        test('legacy assignments of removed keys are dropped', () => {
            const saved = wrapped({ A: thread({ main: branch('main', [], 10) }) }, { legacyThreadPersonaAssignments: { A: 'p1', Z: 'p1' } });
            const next = storeSyncUtils.applyConversationDeleteScope(saved, scope({ removeKeys: ['A'] }));
            expect(next.legacyThreadPersonaAssignments).toEqual({ Z: 'p1' });
            expect(saved.legacyThreadPersonaAssignments).toEqual({ A: 'p1', Z: 'p1' });
        });
    });

    describe('a group member edit scope with a merge', () => {
        test('a member-edit scope drops the group keys and adopts the server holder key, keeping the group record and an unsaved edit to another thread', () => {
            const before = { id: 'G', personaId: '', name: 'Group: A, B, C', members: ['A', 'B', 'C'] };
            const after = { ...before, name: 'Group: B, C', members: ['B', 'C'] };
            const history = [message('h1', 'First'), message('h2', 'Second')];
            const solo = cooldown => thread({ main: branch('main', [], 12) }, { settings: { cooldown } });
            const saved = wrapped({ 'group:G:A': thread({ main: branch('main', history, 10) }), D: solo(1) }, { groups: [before] });
            const local = wrapped({ 'group:G:A': thread({ main: branch('main', history, 10) }), D: solo(2) }, { groups: [before] });
            const server = wrapped({ 'group:G:B': thread({ main: branch('main', history, 10) }), D: solo(1) }, { groups: [after] });
            const memberEdit = { removeKeys: ['group:G:A'], keyPrefix: 'group:G:', groupId: '', personaId: '', reminderIds: [], replaceKeys: {} };
            const merged = mergeConversationStore(
                server,
                storeSyncUtils.applyConversationDeleteScope(local, memberEdit),
                storeSyncUtils.applyConversationDeleteScope(saved, memberEdit),
            );
            expect(Object.keys(merged.characters).sort()).toEqual(['D', 'group:G:B']);
            expect(merged.characters['group:G:B'].branches.main.messages.map(item => item.id)).toEqual(['h1', 'h2']);
            expect(merged.characters.D.settings.cooldown).toBe(2);
            expect(merged.groups.map(group => [group.id, group.members])).toEqual([['G', ['B', 'C']]]);
        });

        test('a stale page that changed a group\'s settings keeps the server\'s member change', () => {
            const baseline = { id: 'G', personaId: '', name: 'Group: A, B, C', members: ['A', 'B', 'C'], disabled_members: [], conversation_settings: { auto_chat_cooldown: 1 }, updatedAt: 1 };
            const history = [message('h1', 'First')];
            const keyed = key => ({ [key]: thread({ main: branch('main', history, 10) }) });
            const saved = wrapped(keyed('group:G:A'), { groups: [baseline] });
            const server = wrapped(keyed('group:G:B'), {
                groups: [{ ...baseline, name: 'Group: B, C, D', members: ['B', 'C', 'D'], disabled_members: ['C'], updatedAt: 5 }],
            });
            const expectServerMembers = (merged, settings, updatedAt) => {
                expect(merged).not.toBeNull();
                expect(Object.keys(merged.characters)).toEqual(['group:G:B']);
                const [group] = merged.groups;
                expect(group.members).toEqual(['B', 'C', 'D']);
                expect(group.disabled_members).toEqual(['C']);
                expect(group.name).toBe('Group: B, C, D');
                expect(group.conversation_settings).toEqual(settings);
                expect(group.updatedAt).toBe(updatedAt);
            };
            // (a) The page changed the group's setting and its timestamp.
            const changedSetting = wrapped(keyed('group:G:A'), {
                groups: [{ ...baseline, conversation_settings: { auto_chat_cooldown: 9 }, updatedAt: 7 }],
            });
            expectServerMembers(mergeConversationStore(server, changedSetting, saved), { auto_chat_cooldown: 9 }, 7);
            // (b) The page changed only the timestamp.
            const changedStamp = wrapped(keyed('group:G:A'), { groups: [{ ...baseline, updatedAt: 7 }] });
            expectServerMembers(mergeConversationStore(server, changedStamp, saved), { auto_chat_cooldown: 1 }, 7);
            // Control: the server changed only the group's setting, so the page's whole record stands.
            const settingsOnly = wrapped(keyed('group:G:A'), { groups: [{ ...baseline, conversation_settings: { auto_chat_cooldown: 2 } }] });
            const control = mergeConversationStore(settingsOnly, changedSetting, saved);
            expect(control.groups[0].members).toEqual(['A', 'B', 'C']);
            expect(control.groups[0].conversation_settings.auto_chat_cooldown).toBe(9);
        });
    });

    describe('isScheduleOnlyConversationRecord', () => {
        const schedule = { generatedAt: 5, days: [] };
        const kept = (over = {}) => ({ settings: {}, schedule, activeBranchId: 'main', branches: { main: branch('main', [], 30) }, ...over });

        test('is true for the kept shape, also with an empty-string branch memory summary', () => {
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(kept())).toBe(true);
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(kept({ settings: undefined }))).toBe(true);
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(kept({ branches: { main: branch('main', [], 30, { memorySummary: '' }) } }))).toBe(true);
        });

        test('is false with a thread memory summary, a message, a branch memory summary, settings.enabled or no schedule', () => {
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(kept({ memorySummary: 'Remembers' }))).toBe(false);
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(kept({ branches: { main: branch('main', [message('a', 'one')], 30) } }))).toBe(false);
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(kept({ branches: { main: branch('main', [], 30, { memorySummary: 'Branch' }) } }))).toBe(false);
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(kept({ settings: { enabled: true } }))).toBe(false);
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(kept({ schedule: undefined }))).toBe(false);
            expect(storeSyncUtils.isScheduleOnlyConversationRecord(null)).toBe(false);
        });
    });

    describe('listRemovedConversationTargets and isDeletedConversationThread', () => {
        const schedule = { generatedAt: 5, days: [] };
        const kept = () => ({ settings: {}, schedule, activeBranchId: 'main', branches: { main: branch('main', [], 30) } });
        const solo = (over = {}, messages = []) => thread({ main: branch('main', messages, 10) }, over);

        test('a server-removed solo key is reported and the open DM is left', () => {
            const before = wrapped({ A: solo({}, [message('a', 'one')]), B: solo() });
            const after = wrapped({ B: solo() });
            const removed = storeSyncUtils.listRemovedConversationTargets(before, after);
            expect(removed).toEqual({ threadKeys: ['A'], groupIds: [] });
            expect(storeSyncUtils.isDeletedConversationThread(removed, { activeKey: 'A', groupId: '' })).toBe(true);
            expect(storeSyncUtils.isDeletedConversationThread(removed, { activeKey: 'B', groupId: '' })).toBe(false);
            expect(storeSyncUtils.isDeletedConversationThread(removed, { activeKey: '', groupId: '' })).toBe(false);
        });

        test('a solo record that went from messages, memory or settings to schedule-only is reported', () => {
            const after = wrapped({ A: kept() });
            for (const before of [
                solo({ schedule }, [message('a', 'one')]),
                solo({ schedule, memorySummary: 'Remembers' }),
                solo({ schedule, settings: { enabled: true } }),
                solo({ schedule, settings: { cooldown: 2 } }),
                thread({ main: branch('main', [], 10, { memorySummary: 'Branch' }) }, { schedule }),
            ]) {
                expect(storeSyncUtils.listRemovedConversationTargets(wrapped({ A: before }), after).threadKeys).toEqual(['A']);
            }
        });

        test('an opened, unused DM that exists only in the page is not reported', () => {
            const page = wrapped({ A: solo(), B: solo() });
            const server = wrapped({ B: solo({}, [message('n', 'native')]) });
            expect(storeSyncUtils.listRemovedConversationTargets(wrapped({ B: solo() }), server)).toEqual({ threadKeys: [], groupIds: [] });
            expect(storeSyncUtils.listRemovedConversationTargets(page, page)).toEqual({ threadKeys: [], groupIds: [] });
        });

        test('a record that was already schedule-only, or empty and then gained a schedule, is not reported', () => {
            expect(storeSyncUtils.listRemovedConversationTargets(wrapped({ A: kept() }), wrapped({ A: kept() })).threadKeys).toEqual([]);
            const empty = thread({ main: branch('main', [], 10) });
            expect(storeSyncUtils.listRemovedConversationTargets(wrapped({ A: empty }), wrapped({ A: kept() })).threadKeys).toEqual([]);
            const emptySettings = thread({ main: branch('main', [], 10) }, { settings: {} });
            expect(storeSyncUtils.listRemovedConversationTargets(wrapped({ A: emptySettings }), wrapped({ A: kept() })).threadKeys).toEqual([]);
        });

        test('a removed group is reported by id and decided by group id only', () => {
            const group = { id: 'G', personaId: '', members: ['A', 'B'] };
            const before = wrapped({ 'group:G:A': solo() }, { groups: [group] });
            const gone = storeSyncUtils.listRemovedConversationTargets(before, wrapped({}));
            expect(gone.groupIds).toEqual(['G']);
            expect(storeSyncUtils.isDeletedConversationThread(gone, { activeKey: 'group:G:A', groupId: 'G' })).toBe(true);
            // The server canonicalised the alias key away but kept the record: the group is not left.
            const aliasOnly = storeSyncUtils.listRemovedConversationTargets(
                wrapped({ 'group:G:B': solo() }, { groups: [group] }),
                wrapped({ 'group:G:A': solo() }, { groups: [group] }),
            );
            expect(aliasOnly.groupIds).toEqual([]);
            expect(storeSyncUtils.isDeletedConversationThread(aliasOnly, { activeKey: 'group:G:B', groupId: 'G' })).toBe(false);
        });
    });
});
