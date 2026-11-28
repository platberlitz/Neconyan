/* eslint playwright/expect-expect: off -- Uses node:assert against HTTP responses, logs and saved files. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';

const { readRoleplayAccount, roleplayLease, withRoleplayAccountLock } = await import('../src/roleplay-store.js');
const { commitSingleChatWrite, settleRoleplayPendingLocked } = await import('../src/roleplay-lifecycle.js');
const { prepareNativeChatWrite, publishNativeChatWrite, roleplayErrorLogEntry, roleplayNativeHost, router } = await import('../src/endpoints/chats.js');

const SECRET = 'Words only the chat itself should hold';

// A publish that fails before touching the chat, as a crash or a full disk would, leaves the staged write behind.
function leaveUnfinishedWrite(f, operationKey = 'crashed-write') {
    const input = { ...f.input(), operationKey };
    input.records[input.records.length - 1].mes = SECRET;
    const failing = { prepare: prepareNativeChatWrite, publish() { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); } };
    assert.throws(() => commitSingleChatWrite(f.scope, input, failing), error => error.roleplayWritePending === true);
    const { pending } = readRoleplayAccount(f.scope);
    assert.equal(pending?.kind, 'chat-write');
    assert.equal(pending.phase, 'prepared');
    return input;
}

async function endpointFixture(t, group = false) {
    const f = fixture(t, group);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories };
        next();
    });
    app.use('/api/chats', router);
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    }));
    const base = `http://127.0.0.1:${server.address().port}/api/chats`;
    const fields = group ? { id: f.locator.chat } : { avatar_url: f.locator.avatar, file_name: f.locator.chat };
    async function post(route, body) {
        const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json(), evidence: JSON.parse(response.headers.get('X-Neconyan-Roleplay') || 'null') };
    }
    const route = name => `${group ? '/group' : ''}/${name}`;
    const load = () => post(route('get'), fields);
    const save = body => post(route('save'), body);
    const write = (evidence, chat, operationKey = crypto.randomUUID()) => ({
        ...fields, chat, deferBackup: true,
        roleplay: { account: evidence.account, operationKey, ...(evidence.source ? { source: evidence.source } : { vacancy: evidence.vacancy }) },
    });
    return { ...f, fields, load, save, write };
}

function quietConsole(t) {
    return { warn: t.mock.method(console, 'warn', () => {}), error: t.mock.method(console, 'error', () => {}) };
}

const calls = (spy, prefix) => spy.mock.calls.filter(call => String(call.arguments[0]).startsWith(prefix)).map(call => call.arguments);

for (const group of [false, true]) {
    const kind = group ? 'group' : 'solo';

    test(`${kind} reads finish a write a crash left unfinished instead of refusing until a restart`, async t => {
        const f = await endpointFixture(t, group);
        leaveUnfinishedWrite(f);
        const log = quietConsole(t);
        const loaded = await f.load();
        assert.equal(loaded.status, 200);
        assert.equal(loaded.body.at(-1).mes, SECRET);
        assert.equal(loaded.evidence.source.revision, 2);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
        const finished = calls(log.warn, 'Finished earlier Roleplay work');
        assert.equal(finished.length, 1);
        assert.deepEqual(finished[0][1], { kind: 'chat-write', accountId: f.scope.accountId });
        assert.equal(log.error.mock.callCount(), 0);
        assert.doesNotMatch(JSON.stringify(log.warn.mock.calls.map(call => call.arguments)), new RegExp(SECRET));
    });

    test(`${kind} saves under another key finish the earlier write, then check their own base against it`, async t => {
        const f = await endpointFixture(t, group);
        const before = await f.load();
        leaveUnfinishedWrite(f);
        const log = quietConsole(t);
        const stale = await f.save(f.write(before.evidence, [...f.records, { name: 'Nova', mes: 'Edited on the old base' }]));
        // The earlier write landed, so this save is told about it rather than locked out or rebased.
        assert.equal(stale.status, 400);
        assert.equal(stale.body.error, 'integrity');
        assert.equal(stale.body.roleplay.source.revision, 2);
        assert.equal(readRoleplayAccount(f.scope).pending, null);
        assert.equal(calls(log.warn, 'Finished earlier Roleplay work').length, 1);
        const refused = calls(log.warn, 'Protected chat request refused:');
        assert.equal(refused.length, 1);
        assert.equal(refused[0][1].status, 400);
        assert.equal(refused[0][1].error, 'integrity');
        assert.equal(refused[0][1].code, 'ROLEPLAY_SOURCE_CHANGED');
        assert.deepEqual(refused[0][1].expected, { instanceId: before.evidence.source.instanceId, revision: 1 });
        const current = await f.load();
        const saved = await f.save(f.write(current.evidence, [...current.body, { name: 'Nova', mes: 'Edited on the new base' }]));
        assert.equal(saved.status, 200);
        assert.equal(saved.body.roleplay.source.revision, 3);
        assert.doesNotMatch(JSON.stringify(log.warn.mock.calls.map(call => call.arguments)), /Edited on the|Original|Answer/);
    });

    test(`${kind} unfinished work that no longer matches the chat still refuses, and says so in the log`, async t => {
        const f = await endpointFixture(t, group);
        leaveUnfinishedWrite(f);
        // Someone replaced the chat file outside Neconyan after the write was staged.
        const replacement = f.filename + '.outside';
        fs.writeFileSync(replacement, [...f.records, { name: 'Nova', mes: 'Written elsewhere' }].map(row => JSON.stringify(row)).join('\n'));
        fs.renameSync(replacement, f.filename);
        const outside = fs.readFileSync(f.filename);
        const log = quietConsole(t);
        const loaded = await f.load();
        assert.equal(loaded.status, 503);
        assert.equal(loaded.body.error, 'roleplay_recovery_required');
        assert.equal(loaded.body.code, 'ROLEPLAY_RECOVERY_REQUIRED');
        assert.equal(readRoleplayAccount(f.scope).pending?.kind, 'chat-write');
        assert.deepEqual(fs.readFileSync(f.filename), outside);
        const unfinished = calls(log.error, 'Earlier Roleplay work could not be finished');
        assert.equal(unfinished.length, 1);
        assert.deepEqual(unfinished[0][1], { kind: 'chat-write', accountId: f.scope.accountId, code: 'ROLEPLAY_SOURCE_CHANGED' });
        const failed = calls(log.error, 'Protected chat request could not finish:');
        assert.equal(failed.length, 1);
        assert.equal(failed[0][1].status, 503);
        assert.equal(failed[0][1].code, 'ROLEPLAY_RECOVERY_REQUIRED');
        assert.equal(failed[0][1].route, `POST /api/chats/${group ? 'group/' : ''}get`);
        assert.equal(failed[0][1].user, f.scope.owner);
        assert.equal(failed[0][1].chat, f.locator.chat);
        assert.doesNotMatch(JSON.stringify(log.error.mock.calls.map(call => call.arguments)), new RegExp(`${SECRET}|Written elsewhere`));
    });
}

test('settling leaves a write to the request that owns it and leaves account resets to startup', async t => {
    const f = fixture(t);
    leaveUnfinishedWrite(f, 'mine');
    const log = quietConsole(t);
    const host = { prepare: prepareNativeChatWrite, publish: publishNativeChatWrite };
    assert.equal(withRoleplayAccountLock(f.scope, lease => settleRoleplayPendingLocked(lease, host, { operationKey: 'mine' })), false);
    assert.equal(readRoleplayAccount(f.scope).pending?.kind, 'chat-write');
    const reset = withRoleplayAccountLock(f.scope, lease => {
        const { state } = roleplayLease(lease);
        const staged = state.pending;
        state.pending = { ...staged, kind: 'account-reset' };
        try { return settleRoleplayPendingLocked(lease, host); } finally { state.pending = staged; }
    });
    assert.equal(reset, false);
    assert.equal(log.warn.mock.callCount(), 0);
    assert.equal(withRoleplayAccountLock(f.scope, lease => settleRoleplayPendingLocked(lease, roleplayNativeHost, { operationKey: 'someone-else' })), true);
    assert.equal(readRoleplayAccount(f.scope).pending, null);
    assert.equal(calls(log.warn, 'Finished earlier Roleplay work').length, 1);
});

test('refused chat requests are logged with their ids and codes, never their messages', () => {
    const request = {
        method: 'POST', originalUrl: '/api/chats/patch', user: { profile: { handle: 'nova-user' } },
        body: { avatar_url: 'Nova.png', file_name: 'Source', chat: [{ mes: SECRET }], messages: [{ mes: SECRET }],
            roleplay: { account: { accountId: 'account-1', dataEpoch: 1 }, operationKey: 'key-1',
                source: { instanceId: 'instance-1', revision: 4, rawHash: 'a'.repeat(64) } } },
    };
    const error = Object.assign(new Error('The saved chat changed.'), { code: 'ROLEPLAY_RECOVERY_REQUIRED', roleplayWritePending: true });
    assert.deepEqual(roleplayErrorLogEntry(request, error, 503, { error: 'roleplay_recovery_required', code: 'ROLEPLAY_RECOVERY_REQUIRED' }), {
        status: 503, error: 'roleplay_recovery_required', code: 'ROLEPLAY_RECOVERY_REQUIRED', route: 'POST /api/chats/patch',
        user: 'nova-user', accountId: 'account-1', chat: 'Source', character: 'Nova.png', operationKey: 'key-1',
        expected: { instanceId: 'instance-1', revision: 4 }, writeUncertain: true, detail: 'The saved chat changed.',
    });
    const group = roleplayErrorLogEntry({ method: 'POST', url: '/group/save', body: { id: 'Group chat', chat: [{ mes: SECRET }],
        roleplay: { operationKey: 'key-2', vacancy: 0 } } }, new Error(SECRET), 409, { error: 'patch_base_mismatch', reason: 'stale' });
    assert.deepEqual(group, { status: 409, error: 'patch_base_mismatch', reason: 'stale', route: 'POST /group/save', chat: 'Group chat',
        operationKey: 'key-2', expected: { vacancy: 0 } });
    assert.deepEqual(roleplayErrorLogEntry(undefined, {}, 503, { error: 'roleplay_recovery_required', code: 'ROLEPLAY_IO_ERROR' }),
        { status: 503, error: 'roleplay_recovery_required', code: 'ROLEPLAY_IO_ERROR' });
});
