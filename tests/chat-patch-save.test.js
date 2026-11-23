import { beforeEach, describe, expect, test } from '@jest/globals';
import { FINGERPRINT_WIDTH, commonAffixLengths, digestKeptFingerprints, fingerprintText } from '../public/scripts/chat-patch-fingerprint.js';
import {
    CHAT_PATCH_MIN_CHARS, SavedMessage, chatPatchBaseFor, composeFullBody, composePatchBody, fingerprintMessages, forgetChatPatchBases, planChatPatch,
    rememberChatPatchBase, savedMessageFingerprints, savedMessagesOf, snapshotChatMessages,
} from '../public/scripts/chat-patch-save.js';
import {
    beginRoleplaySave, bindRoleplayAccount, confirmRoleplayOverwrite, finishRoleplaySave, rememberRoleplayRead, sendRoleplaySave,
} from '../public/scripts/roleplay-save-chain.js';

const words = texts => {
    const out = new Uint32Array(texts.length * FINGERPRINT_WIDTH);
    texts.forEach((text, index) => fingerprintText(text, out, index * FINGERPRINT_WIDTH));
    return out;
};

describe('message fingerprints', () => {
    test('are three words that depend on every character, their order and the length', () => {
        const base = fingerprintText.bind(null);
        const of = text => { const out = new Uint32Array(3); base(text, out, 0); return Array.from(out); };
        expect(of('')).toEqual(of(''));
        const seen = new Set();
        const texts = ['', 'a', 'b', 'ab', 'ba', 'aa', 'abc', 'abcd', 'abcde', '\ud83d\ude00', '\ud83d', '\ude00', 'caf\u00e9', 'cafe\u0301', '\u65e5\u672c', '\u672c\u65e5', ' ', '  ', '\u0000', '\u0000\u0000'];
        for (const text of texts) seen.add(of(text).join(','));
        expect(seen.size).toBe(texts.length);
        expect(of('abc')[2]).toBe(3);
        // A single changed character anywhere in a long text changes the fingerprint.
        const long = 'x'.repeat(4001);
        const original = of(long);
        for (const at of [0, 1, 2, 1999, 2000, 4000]) {
            expect(of(long.slice(0, at) + 'y' + long.slice(at + 1))).not.toEqual(original);
        }
        // And no two of many near-identical messages collide.
        const near = new Set();
        for (let index = 0; index < 20000; index++) near.add(of(`{"mes":"line ${index}","n":${index % 7}}`).join(','));
        expect(near.size).toBe(20000);
    });

    test('are pinned, because the page and the server must always compute the same ones', () => {
        const out = new Uint32Array(3);
        fingerprintText('{"name":"Nova","mes":"Hello caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00"}', out, 0);
        expect(Array.from(out)).toEqual([609945345, 1581814134, 41]);
        fingerprintText('', out, 0);
        expect(Array.from(out)).toEqual([3954623016, 782447033, 0]);
    });

    test('a snapshot keeps each message as it was when it was taken', () => {
        const chat = [{ mes: 'one', extra: { a: [1, 2] } }, { mes: 'two' }];
        const saved = snapshotChatMessages(chat);
        chat[0].mes = 'changed later';
        chat[0].extra.a.push(3);
        expect(saved.map(message => message.json)).toEqual(['{"mes":"one","extra":{"a":[1,2]}}', '{"mes":"two"}']);
        expect(saved[0]).toBeInstanceOf(SavedMessage);
        expect(JSON.parse(JSON.stringify({ chat: saved }))).toEqual({ chat: [{ mes: 'one', extra: { a: [1, 2] } }, { mes: 'two' }] });
        expect(Array.from(savedMessageFingerprints(saved))).toEqual(Array.from(words(saved.map(message => message.json))));
        expect(Array.from(fingerprintMessages([{ header: true }, ...chat.slice(1)], 1))).toEqual(Array.from(words(['{"mes":"two"}'])));
        expect(savedMessagesOf([{ chat_metadata: {} }, ...saved])).toHaveLength(2);
        expect(savedMessagesOf([{ chat_metadata: {} }, { mes: 'plain' }])).toBeNull();
    });
});

describe('the unchanged start and end of a chat', () => {
    const affix = (base, next) => commonAffixLengths(words(base), base.length, words(next), next.length);
    test.each([
        ['an append', ['a', 'b', 'c'], ['a', 'b', 'c', 'd'], { prefix: 3, suffix: 0 }],
        ['a change in the middle', ['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'], { prefix: 1, suffix: 2 }],
        ['a deletion', ['a', 'b', 'c', 'd'], ['a', 'c', 'd'], { prefix: 1, suffix: 2 }],
        ['a first message', ['b', 'c'], ['a', 'b', 'c'], { prefix: 0, suffix: 2 }],
        ['nothing changed', ['a', 'b'], ['a', 'b'], { prefix: 2, suffix: 0 }],
        ['everything changed', ['a', 'b'], ['x', 'y'], { prefix: 0, suffix: 0 }],
        ['an empty chat', [], ['a'], { prefix: 0, suffix: 0 }],
        ['an emptied chat', ['a', 'b'], [], { prefix: 0, suffix: 0 }],
        ['repeated messages, where the ends would overlap', ['a', 'a', 'a'], ['a', 'a'], { prefix: 2, suffix: 0 }],
        ['a message repeated and inserted', ['a', 'a'], ['a', 'a', 'a'], { prefix: 2, suffix: 0 }],
        ['a swap', ['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd'], { prefix: 1, suffix: 1 }],
    ])('%s', (_name, base, next, expected) => {
        const found = affix(base, next);
        expect(found).toEqual(expected);
        expect(found.prefix + found.suffix).toBeLessThanOrEqual(Math.min(base.length, next.length));
        for (let index = 0; index < found.prefix; index++) expect(next[index]).toBe(base[index]);
        for (let index = 1; index <= found.suffix; index++) expect(next[next.length - index]).toBe(base[base.length - index]);
    });

    test('the kept digest names the kept fingerprints and nothing else', () => {
        const base = words(['a', 'b', 'c', 'd', 'e']);
        const digest = (prefix, suffix, source = base, count = 5) => digestKeptFingerprints(source, count, prefix, suffix);
        expect(digest(2, 1)).toMatch(/^[a-f0-9]{32}$/);
        expect(digest(2, 1)).toBe(digest(2, 1));
        expect(new Set([digest(0, 0), digest(1, 0), digest(2, 0), digest(0, 1), digest(0, 2), digest(1, 1), digest(2, 1), digest(2, 2)]).size).toBe(8);
        // Changing a kept message changes it; changing one that is not kept does not.
        expect(digest(2, 1, words(['a', 'b', 'X', 'd', 'e']))).toBe(digest(2, 1));
        expect(digest(2, 1, words(['a', 'X', 'c', 'd', 'e']))).not.toBe(digest(2, 1));
        expect(digest(2, 1, words(['a', 'b', 'c', 'd', 'X']))).not.toBe(digest(2, 1));
        expect(digest(2, 1, words(['b', 'a', 'c', 'd', 'e']))).not.toBe(digest(2, 1));
    });
});

describe('request bodies', () => {
    const header = { chat_metadata: { note: 'caf\u00e9' }, user_name: 'unused', character_name: 'unused' };
    const rest = { ch_name: 'Nova', file_name: 'Chat', avatar_url: 'Nova.png', force: false, deferBackup: true, allowShrink: false, roleplay: { operationKey: 'k' } };
    const saved = snapshotChatMessages([{ mes: 'one' }, { mes: 'two \ud83d\ude00' }, { mes: 'three' }]);

    test('a whole body is the request a plain payload gives, without parsing a message again', () => {
        const body = composeFullBody(rest, header, saved);
        expect(JSON.parse(body)).toEqual({ ...rest, chat: [header, { mes: 'one' }, { mes: 'two \ud83d\ude00' }, { mes: 'three' }] });
        expect(body).toBe(JSON.stringify({ ...rest, chat: [header, ...saved] }));
    });

    test('a patch body names its base and carries only the messages between the kept ends', () => {
        const body = composePatchBody(rest, header, saved, { prefix: 1, suffix: 1, kept: 'f'.repeat(32) }, 4);
        expect(JSON.parse(body)).toEqual({ ...rest, patch: { header, prefix: 1, suffix: 1, baseCount: 4, count: 3, kept: 'f'.repeat(32), messages: [{ mes: 'two \ud83d\ude00' }] } });
        expect(JSON.parse(composePatchBody(rest, header, saved, { prefix: 3, suffix: 0, kept: 'a'.repeat(32) }, 3)).patch.messages).toEqual([]);
    });
});

describe('sending a save as a patch', () => {
    const account = { accountId: '11111111-1111-4111-8111-111111111111', dataEpoch: 1 };
    const locator = { group: false, avatar: 'Nova.png', chat: 'Source' };
    const groupLocator = { group: true, chat: 'group-chat' };
    const instanceId = '22222222-2222-4222-8222-222222222222';
    const evidenceOf = (revision, rawHash) => ({ account, source: { instanceId, revision, rawHash } });
    const hash = number => String(number).repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, 'a');
    const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
    const acknowledge = (body, { revision, rawHash, changed = true } = {}) => {
        const request = JSON.parse(body);
        return response(200, { ok: true, integrity: 'saved', roleplay: { account: request.roleplay.account, operationKey: request.roleplay.operationKey, changed,
            source: { instanceId, revision: revision ?? request.roleplay.source.revision + Number(changed), rawHash: rawHash ?? (changed ? hash(request.roleplay.source.revision + 1) : request.roleplay.source.rawHash) } } });
    };
    // Each message is a little over a quarter of the patch threshold, so five of them make a chat that is worth patching.
    const big = index => ({ name: 'Nova', is_user: false, mes: `Message ${index} ` + 'x'.repeat(Math.ceil(CHAT_PATCH_MIN_CHARS / 4)), extra: {} });
    const messages = Array.from({ length: 5 }, (_, index) => big(index));
    const header = { chat_metadata: { note: 'n' }, user_name: 'unused', character_name: 'unused' };
    const fields = { ch_name: 'Nova', file_name: locator.chat, avatar_url: locator.avatar, force: false, deferBackup: false, allowShrink: false };
    const payloadOf = list => ({ ...fields, chat: [header, ...snapshotChatMessages(list)] });
    const sentKinds = [];
    const sender = handler => async (body, _stamp, kind) => { sentKinds.push(kind); return handler(body, kind); };
    let owner = 0;

    beforeEach(() => {
        forgetChatPatchBases();
        sentKinds.length = 0;
        bindRoleplayAccount(`patch-${++owner}`, account);
    });

    const loadBase = (list, revision = 1, rawHash = hash(1), where = locator) => {
        rememberRoleplayRead(where, evidenceOf(revision, rawHash));
        rememberChatPatchBase({ instanceId, revision, rawHash }, fingerprintMessages(list));
    };

    async function save(list, { sendWith, operationKey = `k${Math.random()}`, where = locator, extra = {}, begin = {} } = {}) {
        const token = beginRoleplaySave(where, { operationKey, ...begin });
        const bodies = [];
        const payload = { ...payloadOf(list), ...extra };
        if (where.group) { payload.id = where.chat; delete payload.file_name; delete payload.avatar_url; }
        const result = await sendRoleplaySave(token, payload, sender(sendWith ?? (async body => { bodies.push(body); return acknowledge(body); })));
        await finishRoleplaySave(token);
        return { result, bodies };
    }

    test('an append to a loaded chat is a patch that carries only the new message', async () => {
        loadBase(messages);
        const next = [...messages, big(5)];
        const { result, bodies } = await save(next);
        expect(result.ok).toBe(true);
        expect(sentKinds).toEqual(['patch']);
        const request = JSON.parse(bodies[0]);
        expect(request.chat).toBeUndefined();
        expect(request.patch).toMatchObject({ prefix: 5, suffix: 0, baseCount: 5, count: 6, header });
        expect(request.patch.messages).toEqual([next[5]]);
        expect(request.roleplay).toMatchObject({ account, source: { instanceId, revision: 1, rawHash: hash(1) } });
        expect(bodies[0].length).toBeLessThan(CHAT_PATCH_MIN_CHARS);
    });

    test('an edit in the middle sends the edited message and names both kept ends', async () => {
        loadBase(messages);
        const next = messages.map((message, index) => index === 2 ? { ...message, mes: 'edited' } : message);
        const { bodies } = await save(next);
        expect(sentKinds).toEqual(['patch']);
        expect(JSON.parse(bodies[0]).patch).toMatchObject({ prefix: 2, suffix: 2, baseCount: 5, count: 5, messages: [next[2]] });
    });

    test('the base is the file version the server confirmed, so a save after a save patches from the new version', async () => {
        loadBase(messages);
        const first = [...messages, big(5)];
        const second = [...first, big(6)];
        const bodies = [];
        await save(first, { sendWith: async body => { bodies.push(body); return acknowledge(body); } });
        await save(second, { sendWith: async body => { bodies.push(body); return acknowledge(body); } });
        expect(sentKinds).toEqual(['patch', 'patch']);
        expect(JSON.parse(bodies[1]).patch).toMatchObject({ prefix: 6, suffix: 0, baseCount: 6, count: 7 });
        expect(JSON.parse(bodies[1]).roleplay.source).toMatchObject({ revision: 2, rawHash: hash(2) });
        expect(chatPatchBaseFor({ instanceId, revision: 3, rawHash: hash(3) }).count).toBe(7);
    });

    test('a save the server judged a no-op leaves the base as it was, because the file did', async () => {
        loadBase(messages);
        const same = messages.map(message => ({ ...message }));
        const changedInMemory = [...same.slice(0, 4), { ...same[4], mes: same[4].mes.replace('Message 4', 'Message  4') }];
        await save(changedInMemory, { sendWith: async body => acknowledge(body, { changed: false }) });
        expect(chatPatchBaseFor({ instanceId, revision: 1, rawHash: hash(1) }).count).toBe(5);
        const next = [...messages, big(5)];
        const { bodies } = await save(next);
        expect(JSON.parse(bodies[0]).patch).toMatchObject({ prefix: 5, suffix: 0, baseCount: 5, count: 6 });
    });

    test.each([
        ['a small chat', () => { loadBase([{ mes: 'a' }]); return [{ mes: 'a' }, { mes: 'b' }]; }, 'save'],
        ['a chat with no base', () => { rememberRoleplayRead(locator, evidenceOf(1, hash(1))); return [...messages, big(5)]; }, 'save'],
        ['a chat whose base is another file version', () => { loadBase(messages, 7, hash(7)); rememberRoleplayRead(locator, evidenceOf(1, hash(1))); return [...messages, big(5)]; }, 'save'],
        ['a chat with nothing in common with its base', () => { loadBase(messages); return messages.map((message, index) => ({ ...message, mes: `different ${index} ` + 'y'.repeat(CHAT_PATCH_MIN_CHARS / 4) })); }, 'save'],
    ])('%s is saved whole', async (_name, prepare, kind) => {
        const next = prepare();
        const { bodies } = await save(next);
        expect(sentKinds).toEqual([kind]);
        expect(JSON.parse(bodies[0]).chat).toHaveLength(next.length + 1);
        expect(JSON.parse(bodies[0]).patch).toBeUndefined();
    });

    test('saves that hide messages, or overwrite after a conflict, or create a chat, are whole saves', async () => {
        loadBase(messages);
        const next = [...messages, big(5)];
        await save(next, { extra: { mewmoryHidePolicy: { type: 'manual', lastDisableId: 'x' } } });
        await save(next, { extra: { force: true } });
        expect(sentKinds).toEqual(['save', 'save']);
        // An overwrite the person confirmed after an integrity refusal.
        sentKinds.length = 0;
        const token = beginRoleplaySave(locator, { operationKey: 'conflicted' });
        const refused = await sendRoleplaySave(token, payloadOf(next), sender(async () => response(400, { error: 'integrity', roleplay: evidenceOf(9, hash(9)) })));
        expect(refused).toMatchObject({ ok: false });
        confirmRoleplayOverwrite(token, 'confirmed');
        const bodies = [];
        await sendRoleplaySave(token, { ...payloadOf(next), force: true }, sender(async body => { bodies.push(body); return acknowledge(body); }));
        await finishRoleplaySave(token);
        expect(sentKinds).toEqual(['patch', 'save']);
        expect(JSON.parse(bodies[0])).toMatchObject({ force: true, roleplay: { operationKey: 'confirmed' } });
        expect(JSON.parse(bodies[0]).chat).toHaveLength(next.length + 1);
    });

    test('a patch the server refuses is sent as the whole chat at once, with the same key, and the base is kept for the next version', async () => {
        loadBase(messages);
        const next = [...messages, big(5)];
        const sent = [];
        const result = (await save(next, { operationKey: 'refused-once', sendWith: async (body, kind) => {
            sent.push({ kind, body });
            return kind === 'patch' ? response(409, { error: 'patch_base_mismatch', reason: 'kept' }) : acknowledge(body);
        } })).result;
        expect(result.ok).toBe(true);
        expect(sent.map(request => request.kind)).toEqual(['patch', 'save']);
        const whole = JSON.parse(sent[1].body);
        expect(whole.chat).toHaveLength(7);
        expect(whole.roleplay.operationKey).toBe('refused-once');
        expect(whole.roleplay.source).toEqual(JSON.parse(sent[0].body).roleplay.source);
        // The version the whole save made has a base again, so the next save is a patch.
        const { bodies } = await save([...next, big(6)]);
        expect(JSON.parse(bodies[0]).patch).toMatchObject({ prefix: 6, baseCount: 6, count: 7 });
        expect(sentKinds.slice(-1)).toEqual(['patch']);
    });

    test('a file version the server would not patch is not offered a patch again', async () => {
        loadBase(messages);
        const next = [...messages, big(5)];
        const noOp = async (body, kind) => kind === 'patch' ? response(409, { error: 'patch_base_mismatch', reason: 'format' }) : acknowledge(body, { changed: false });
        await save(next, { sendWith: noOp });
        await save(next, { sendWith: noOp });
        expect(sentKinds).toEqual(['patch', 'save', 'save']);
    });

    test('an older server with no patch route gets the whole chat, once, and is not asked again', async () => {
        loadBase(messages);
        const next = [...messages, big(5)];
        const notFound = async (body, kind) => kind === 'patch' ? { ok: false, status: 404, json: async () => { throw new Error('<html>'); } } : acknowledge(body);
        await save(next, { sendWith: notFound });
        expect(sentKinds).toEqual(['patch', 'save']);
        await save([...next, big(6)], { sendWith: notFound });
        expect(sentKinds).toEqual(['patch', 'save', 'save']);
    });

    test('a refusal that is not about the base is the answer, as for any save', async () => {
        loadBase(messages);
        const { result } = await save([...messages, big(5)], { sendWith: async () => response(409, { error: 'destructive', reason: 'shrink' }) });
        expect(result).toMatchObject({ ok: false, status: 409, data: { error: 'destructive' } });
        expect(sentKinds).toEqual(['patch']);
    });

    test('a lost response is retried with the same patch and the same key', async () => {
        loadBase(messages);
        const sent = [];
        const { result } = await save([...messages, big(5)], { operationKey: 'lost', sendWith: async body => {
            sent.push(body);
            if (sent.length === 1) throw new Error('lost response');
            return acknowledge(body);
        } });
        expect(result.ok).toBe(true);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toBe(sent[0]);
        expect(sentKinds).toEqual(['patch', 'patch']);
    });

    test('a group chat is patched on the same terms', async () => {
        loadBase(messages, 1, hash(1), groupLocator);
        const { bodies } = await save([...messages, big(5)], { where: groupLocator });
        expect(sentKinds).toEqual(['patch']);
        expect(JSON.parse(bodies[0])).toMatchObject({ id: 'group-chat', patch: { prefix: 5, count: 6 } });
    });

    test('a payload of plain messages is sent as it always was', async () => {
        loadBase(messages);
        const token = beginRoleplaySave(locator, { operationKey: 'plain' });
        const bodies = [];
        await sendRoleplaySave(token, { ...fields, chat: [header, ...messages, big(5)] }, sender(async body => { bodies.push(body); return acknowledge(body); }));
        await finishRoleplaySave(token);
        expect(sentKinds).toEqual(['save']);
        expect(JSON.parse(bodies[0]).chat).toHaveLength(7);
    });

    test('planning is nothing for a chat below the threshold or with a base it cannot use', () => {
        const small = snapshotChatMessages([{ mes: 'a' }, { mes: 'b' }]);
        expect(planChatPatch(small, { words: fingerprintMessages([{ mes: 'a' }]), count: 1 })).toBeNull();
        const large = snapshotChatMessages([...messages, big(5)]);
        expect(planChatPatch(large, { words: fingerprintMessages(messages), count: 5 })).toMatchObject({ prefix: 5, suffix: 0 });
        expect(planChatPatch(large, { words: fingerprintMessages(messages.map(message => ({ ...message, mes: 'z' }))), count: 5 })).toBeNull();
    });
});
