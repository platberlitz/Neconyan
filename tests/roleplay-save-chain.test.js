import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    beginRoleplaySave, bindRoleplayAccount, confirmRoleplayOverwrite, finishRoleplaySave,
    getRoleplaySourceId, parseRoleplayRead, rememberRoleplayRead, roleplayAccountStamp, sendRoleplaySave,
} from '../public/scripts/roleplay-save-chain.js';

const account = { accountId: '11111111-1111-4111-8111-111111111111', dataEpoch: 1 };
const locator = { group: false, avatar: 'Nova.png', chat: 'Source' };
const source = { instanceId: '22222222-2222-4222-8222-222222222222', revision: 1, rawHash: 'a'.repeat(64) };
const evidence = { account, source };
const payload = () => ({ avatar_url: locator.avatar, file_name: locator.chat, chat: [{ chat_metadata: {} }, { mes: 'queued text' }] });
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const readResponse = value => ({ ok: true, headers: { get: () => JSON.stringify(value) }, json: async () => [] });
const acknowledged = (body, overrides = {}) => {
    const request = JSON.parse(body);
    return response(200, { ok: true, integrity: 'saved', roleplay: { account: request.roleplay.account,
        operationKey: request.roleplay.operationKey, changed: true,
        source: { instanceId: request.roleplay.source?.instanceId || source.instanceId,
            revision: (request.roleplay.source?.revision || 0) + 1, rawHash: 'b'.repeat(64) }, ...overrides } });
};

let owner;
let run = 0;
beforeEach(() => {
    owner = `save-chain-${++run}`;
    bindRoleplayAccount(owner, account);
});

describe('protected browser save authority', () => {
    test('link evidence is the exact applied editor identity and does not establish missing authority', () => {
        expect(getRoleplaySourceId(locator)).toBeNull();
        rememberRoleplayRead(locator, evidence);
        expect(getRoleplaySourceId(locator)).toBe(source.instanceId);
        expect(getRoleplaySourceId({ ...locator, chat: 'Other' })).toBeNull();
        expect(getRoleplaySourceId({ ...locator, avatar: 'Other.png' })).toBeNull();
    });
    test('validates the read account and exact locator without normalising Unicode names', () => {
        const unicode = { group: true, chat: 'お話 🐾' };
        const read = readResponse({ account, locator: unicode, vacancy: 0 });
        expect(parseRoleplayRead(read, unicode)).toEqual({ account, vacancy: 0 });
        expect(() => parseRoleplayRead(read, { ...unicode, chat: 'Other' })).toThrow();
        expect(() => parseRoleplayRead(readResponse({ account, locator, source: { ...source, revision: '1' } }), locator)).toThrow();
        expect(() => parseRoleplayRead(readResponse({ account, locator, source, vacancy: 0 }), locator)).toThrow();
    });

    test('missing read authority never triggers an automatic load or a save', async () => {
        const token = beginRoleplaySave(locator, { operationKey: 'missing-read' });
        const send = jest.fn();
        const load = jest.fn();
        await expect(sendRoleplaySave(token, payload(), send, load)).rejects.toMatchObject({ code: 'ROLEPLAY_READ_REQUIRED' });
        finishRoleplaySave(token);
        expect(send).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
    });

    test('lost responses retry the immutable body and original operation key', async () => {
        rememberRoleplayRead(locator, evidence);
        const token = beginRoleplaySave(locator, { operationKey: 'same-request' });
        const data = payload();
        const sent = [];
        const result = await sendRoleplaySave(token, data, async body => {
            sent.push(body);
            data.chat[1].mes = 'later edit';
            if (sent.length === 1) throw new Error('lost response');
            return acknowledged(body);
        });
        finishRoleplaySave(token);
        expect(result.ok).toBe(true);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toBe(sent[0]);
        expect(JSON.parse(sent[0])).toMatchObject({ chat: [{}, { mes: 'queued text' }], roleplay: { account, operationKey: 'same-request', source } });
    });

    test('a queued successor advances only from its own fully settled predecessor', async () => {
        rememberRoleplayRead(locator, evidence);
        const first = beginRoleplaySave(locator, { operationKey: 'first' });
        const second = beginRoleplaySave(locator, { operationKey: 'second' });
        expect(rememberRoleplayRead(locator, { account, source: { ...source, revision: 50 } })).toBe(false);
        const sendSecond = jest.fn(async body => acknowledged(body, { source: { ...source, revision: 3, rawHash: 'c'.repeat(64) } }));
        const waiting = sendRoleplaySave(second, payload(), sendSecond);
        await sendRoleplaySave(first, payload(), async body => acknowledged(body));
        await Promise.resolve();
        expect(sendSecond).not.toHaveBeenCalled();
        finishRoleplaySave(first);
        await expect(waiting).resolves.toMatchObject({ ok: true });
        finishRoleplaySave(second);
        expect(JSON.parse(sendSecond.mock.calls[0][0]).roleplay.source).toEqual({ ...source, revision: 2, rawHash: 'b'.repeat(64) });
    });

    test('a definitive refusal does not consume or refresh its original source', async () => {
        rememberRoleplayRead(locator, evidence);
        const first = beginRoleplaySave(locator, { operationKey: 'refused' });
        const second = beginRoleplaySave(locator, { operationKey: 'after-refusal' });
        await expect(sendRoleplaySave(first, payload(), async () => response(409, { error: 'destructive', reason: 'shrink' })))
            .resolves.toMatchObject({ ok: false, status: 409 });
        finishRoleplaySave(first);
        const send = jest.fn(async body => acknowledged(body));
        await sendRoleplaySave(second, payload(), send);
        finishRoleplaySave(second);
        expect(JSON.parse(send.mock.calls[0][0]).roleplay.source).toEqual(source);
    });

    test('a fresh read after the queue settles replaces the old completed source', async () => {
        rememberRoleplayRead(locator, evidence);
        const first = beginRoleplaySave(locator, { operationKey: 'completed' });
        await sendRoleplaySave(first, payload(), async body => acknowledged(body));
        await finishRoleplaySave(first);
        const latest = { ...source, revision: 5, rawHash: 'e'.repeat(64) };
        expect(rememberRoleplayRead(locator, { account, source: latest })).toBe(true);
        const second = beginRoleplaySave(locator, { operationKey: 'from-latest-read' });
        const send = jest.fn(async body => acknowledged(body));
        await sendRoleplaySave(second, payload(), send);
        await finishRoleplaySave(second);
        expect(JSON.parse(send.mock.calls[0][0]).roleplay.source).toEqual(latest);
    });

    test('an undispatched cancellation preserves its predecessor acknowledgement', async () => {
        rememberRoleplayRead(locator, evidence);
        const first = beginRoleplaySave(locator, { operationKey: 'before-cancel' });
        const cancelled = beginRoleplaySave(locator, { operationKey: 'cancelled-before-send' });
        const third = beginRoleplaySave(locator, { operationKey: 'after-cancel' });
        await sendRoleplaySave(first, payload(), async body => acknowledged(body));
        await finishRoleplaySave(first);
        await finishRoleplaySave(cancelled);
        const send = jest.fn(async body => acknowledged(body, { source: { ...source, revision: 3, rawHash: 'c'.repeat(64) } }));
        await sendRoleplaySave(third, payload(), send);
        await finishRoleplaySave(third);
        expect(JSON.parse(send.mock.calls[0][0]).roleplay.source).toEqual({ ...source, revision: 2, rawHash: 'b'.repeat(64) });
    });

    test('explicit overwrite gets a new key and queued successors wait for that final result', async () => {
        rememberRoleplayRead(locator, evidence);
        const first = beginRoleplaySave(locator, { operationKey: 'stale-attempt' });
        const second = beginRoleplaySave(locator, { operationKey: 'after-confirmation' });
        const current = { account, source: { ...source, revision: 7, rawHash: 'd'.repeat(64) } };
        const refused = await sendRoleplaySave(first, payload(), async () => response(400, { error: 'integrity', roleplay: current }));
        expect(refused.status).toBe(400);
        expect(() => confirmRoleplayOverwrite(first, 'stale-attempt')).toThrow();
        confirmRoleplayOverwrite(first, 'confirmed-overwrite');
        const forced = jest.fn(async body => acknowledged(body));
        await sendRoleplaySave(first, payload(), forced);
        const send = jest.fn(async body => acknowledged(body, { source: { ...source, revision: 9, rawHash: 'c'.repeat(64) } }));
        const waiting = sendRoleplaySave(second, payload(), send);
        await Promise.resolve();
        expect(send).not.toHaveBeenCalled();
        finishRoleplaySave(first);
        await waiting;
        finishRoleplaySave(second);
        expect(JSON.parse(forced.mock.calls[0][0])).toMatchObject({ force: true, roleplay: { operationKey: 'confirmed-overwrite', source: current.source } });
        expect(JSON.parse(send.mock.calls[0][0]).roleplay.source.revision).toBe(8);
    });

    test('unknown outcomes block successors, overwrite and fresh reads rather than rebasing', async () => {
        rememberRoleplayRead(locator, evidence);
        const first = beginRoleplaySave(locator, { operationKey: 'unknown' });
        const second = beginRoleplaySave(locator, { operationKey: 'blocked-successor' });
        const failed = jest.fn(async () => { throw new Error('offline'); });
        await expect(sendRoleplaySave(first, payload(), failed)).rejects.toMatchObject({ code: 'ROLEPLAY_SAVE_UNCERTAIN' });
        expect(failed).toHaveBeenCalledTimes(3);
        expect(new Set(failed.mock.calls.map(([body]) => body)).size).toBe(1);
        expect(() => confirmRoleplayOverwrite(first, 'unsafe-force')).toThrow();
        finishRoleplaySave(first);
        expect(rememberRoleplayRead(locator, { account, source: { ...source, revision: 99 } })).toBe(false);
        const send = jest.fn();
        await expect(sendRoleplaySave(second, payload(), send)).rejects.toMatchObject({ code: 'ROLEPLAY_SAVE_UNCERTAIN' });
        finishRoleplaySave(second);
        expect(send).not.toHaveBeenCalled();
    });

    test('explicit background read/edit work keeps that read even after another save', async () => {
        rememberRoleplayRead(locator, evidence);
        const first = beginRoleplaySave(locator, { operationKey: 'queued-first' });
        const second = beginRoleplaySave(locator, { operationKey: 'explicit-background', evidence });
        await sendRoleplaySave(first, payload(), async body => acknowledged(body));
        finishRoleplaySave(first);
        const send = jest.fn(async () => response(400, { error: 'integrity', roleplay: { account, source: { ...source, revision: 2 } } }));
        await sendRoleplaySave(second, payload(), send);
        finishRoleplaySave(second);
        expect(JSON.parse(send.mock.calls[0][0]).roleplay.source).toEqual(source);
    });

    for (const queued of [false, true]) {
        test(`background work never refreshes ${queued ? 'queued' : 'later'} editor authority`, async () => {
            rememberRoleplayRead(locator, evidence);
            const background = beginRoleplaySave(locator, { operationKey: 'background', evidence });
            const editor = queued ? beginRoleplaySave(locator, { operationKey: 'editor' }) : null;
            await sendRoleplaySave(background, payload(), async body => acknowledged(body));
            const active = editor ?? beginRoleplaySave(locator, { operationKey: 'editor' });
            const send = jest.fn(async () => response(400, { error: 'integrity' }));
            const pending = sendRoleplaySave(active, payload(), send);
            await finishRoleplaySave(background);
            await expect(pending).resolves.toMatchObject({ ok: false, status: 400 });
            await finishRoleplaySave(active);
            expect(JSON.parse(send.mock.calls[0][0]).roleplay.source).toEqual(source);
        });
    }

    test('a created destination gives no editor authority before an applied read', async () => {
        const created = beginRoleplaySave(locator, { operationKey: 'create-only', create: true });
        await sendRoleplaySave(created, payload(), async body => acknowledged(body),
            async () => readResponse({ account, locator, vacancy: 0 }));
        await finishRoleplaySave(created);
        const editor = beginRoleplaySave(locator, { operationKey: 'editor-after-create' });
        await expect(sendRoleplaySave(editor, payload(), jest.fn())).rejects.toMatchObject({ code: 'ROLEPLAY_READ_REQUIRED' });
        await finishRoleplaySave(editor);
    });

    test('group navigation changes raw authority without advancing semantic revision', async () => {
        const group = { kind: 'group', groupId: 'group' };
        rememberRoleplayRead(group, evidence);
        const first = beginRoleplaySave(group, { operationKey: 'group-navigation' });
        const send = jest.fn(async body => {
            const request = JSON.parse(body);
            return response(200, { ok: true, roleplay: { account, operationKey: request.roleplay.operationKey,
                changed: false, rawChanged: true, source: { ...source, rawHash: 'b'.repeat(64) } } });
        });
        await expect(sendRoleplaySave(first, { id: 'group', name: 'Same group' }, send)).resolves.toMatchObject({ ok: true });
        await finishRoleplaySave(first);
        const next = beginRoleplaySave(group, { operationKey: 'group-edit' });
        const second = jest.fn(async body => {
            const request = JSON.parse(body);
            return response(200, { ok: true, roleplay: { account, operationKey: request.roleplay.operationKey,
                changed: true, rawChanged: true, source: { ...source, revision: 2, rawHash: 'c'.repeat(64) } } });
        });
        await sendRoleplaySave(next, { id: 'group', name: 'Edited group' }, second);
        await finishRoleplaySave(next);
        expect(JSON.parse(second.mock.calls[0][0]).roleplay.source).toEqual({ ...source, rawHash: 'b'.repeat(64) });
    });

    test('a background group continuation uses its frozen predecessor without advancing editor authority', async () => {
        const group = { kind: 'group', groupId: 'group' };
        rememberRoleplayRead(group, evidence);
        const foreground = beginRoleplaySave(group, { operationKey: 'foreground' });
        const background = beginRoleplaySave(group, { operationKey: 'background', after: foreground });
        const first = async body => {
            const request = JSON.parse(body);
            return response(200, { ok: true, roleplay: { account, operationKey: request.roleplay.operationKey,
                changed: true, rawChanged: true, source: { ...source, revision: 2, rawHash: 'b'.repeat(64) } } });
        };
        const queued = jest.fn(async body => {
            const request = JSON.parse(body);
            return response(200, { ok: true, roleplay: { account, operationKey: request.roleplay.operationKey,
                changed: true, rawChanged: true, source: { ...source, revision: 3, rawHash: 'c'.repeat(64) } } });
        });
        const waiting = sendRoleplaySave(background, { id: 'group' }, queued);
        await sendRoleplaySave(foreground, { id: 'group' }, first);
        await finishRoleplaySave(foreground);
        await waiting;
        await finishRoleplaySave(background);
        expect(JSON.parse(queued.mock.calls[0][0]).roleplay.source).toEqual({ ...source, revision: 2, rawHash: 'b'.repeat(64) });
        const editor = beginRoleplaySave(group, { operationKey: 'stale-editor' });
        const refusal = jest.fn(async () => response(409, { error: 'roleplay_source_changed' }));
        await sendRoleplaySave(editor, { id: 'group' }, refusal);
        await finishRoleplaySave(editor);
        expect(JSON.parse(refusal.mock.calls[0][0]).roleplay.source).toEqual({ ...source, revision: 2, rawHash: 'b'.repeat(64) });
    });

    test('only explicit new destinations can discover a vacancy before writing', async () => {
        const created = beginRoleplaySave(locator, { operationKey: 'create', create: true });
        const load = jest.fn(async () => readResponse({ account, locator, vacancy: 3 }));
        const send = jest.fn(async body => acknowledged(body));
        await sendRoleplaySave(created, payload(), send, load);
        finishRoleplaySave(created);
        expect(load).toHaveBeenCalledTimes(1);
        expect(JSON.parse(send.mock.calls[0][0]).roleplay).toEqual({ account, operationKey: 'create', vacancy: 3 });
    });

    test('an occupied create destination requires explicit confirmation, not automatic overwrite', async () => {
        const token = beginRoleplaySave(locator, { operationKey: 'occupied-create', create: true });
        const send = jest.fn(async body => acknowledged(body));
        const load = jest.fn(async () => readResponse({ account, locator, source }));
        await expect(sendRoleplaySave(token, payload(), send, load)).resolves.toMatchObject({ status: 400, data: { error: 'integrity', roleplay: evidence } });
        expect(send).not.toHaveBeenCalled();
        confirmRoleplayOverwrite(token, 'overwrite-occupied');
        await sendRoleplaySave(token, payload(), send, load);
        finishRoleplaySave(token);
        expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ force: true, roleplay: { source, operationKey: 'overwrite-occupied' } });
        expect(load).toHaveBeenCalledTimes(1);
    });

    test('a same-handle epoch change cannot refresh old queued authority', async () => {
        rememberRoleplayRead(locator, evidence);
        const captured = roleplayAccountStamp();
        const token = beginRoleplaySave(locator, { operationKey: 'old-epoch' });
        expect(bindRoleplayAccount(owner, { ...account, dataEpoch: 2 })).toBe(false);
        expect(bindRoleplayAccount(owner, account)).toBe(false);
        expect(() => parseRoleplayRead(readResponse({ account, locator, source }), locator, captured)).toThrow();
        const send = jest.fn();
        await expect(sendRoleplaySave(token, payload(), send)).rejects.toMatchObject({ code: 'ROLEPLAY_ACCOUNT_CHANGED' });
        finishRoleplaySave(token);
        expect(send).not.toHaveBeenCalled();
    });

    test('an account change while a response is in flight never updates the new account', async () => {
        rememberRoleplayRead(locator, evidence);
        const captured = roleplayAccountStamp();
        const token = beginRoleplaySave(locator, { operationKey: 'in-flight' });
        const send = jest.fn(async body => {
            bindRoleplayAccount('another-profile', account);
            return acknowledged(body);
        });
        await expect(sendRoleplaySave(token, payload(), send)).rejects.toMatchObject({ code: 'ROLEPLAY_ACCOUNT_CHANGED' });
        finishRoleplaySave(token);
        expect(send).toHaveBeenCalledTimes(1);
        expect(() => parseRoleplayRead(readResponse({ account, locator, source }), locator, captured)).toThrow();
    });

    for (const [name, overrides] of [
        ['wrong key', { operationKey: 'someone-else' }],
        ['wrong revision', { source: { ...source, revision: 50 } }],
        ['wrong account', { account: { ...account, dataEpoch: 2 } }],
    ]) {
        test(`a successful HTTP status with ${name} is not an acknowledgement`, async () => {
            rememberRoleplayRead(locator, evidence);
            const token = beginRoleplaySave(locator, { operationKey: 'must-match' });
            const send = jest.fn(async body => acknowledged(body, overrides));
            await expect(sendRoleplaySave(token, payload(), send)).rejects.toMatchObject({ code: 'ROLEPLAY_SAVE_UNCERTAIN' });
            finishRoleplaySave(token);
            expect(send).toHaveBeenCalledTimes(3);
            expect(rememberRoleplayRead(locator, evidence)).toBe(false);
        });
    }
});
