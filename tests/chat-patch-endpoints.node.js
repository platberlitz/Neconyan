/* eslint playwright/expect-expect: off -- Uses node:assert against a real router and disposable storage. */
// The page's own save chain talking to the real chat router: a large chat is saved as patches, a patch the server
// cannot build on is answered with 409 and then saved whole, and the routes answer as a save does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';
import { router } from '../src/endpoints/chats.js';
import { clearChatPatchIndexes } from '../src/chat-patch.js';
import { readRoleplayFile } from '../src/roleplay-store.js';
import { CHAT_PATCH_MIN_CHARS, fingerprintMessages, forgetChatPatchBases, rememberChatPatchBase, snapshotChatMessages } from '../public/scripts/chat-patch-save.js';
import { beginRoleplaySave, bindRoleplayAccount, finishRoleplaySave, parseRoleplayRead, rememberRoleplayRead, sendRoleplaySave } from '../public/scripts/roleplay-save-chain.js';

const big = index => ({ name: index % 2 ? 'Nova' : 'User', is_user: index % 2 === 0, mes: `Message ${index} ` + 'x'.repeat(Math.ceil(CHAT_PATCH_MIN_CHARS / 4)), extra: {} });

async function start(t, group, name) {
    clearChatPatchIndexes();
    forgetChatPatchBases();
    const f = fixture(t, group, name);
    const records = [structuredClone(f.records[0]), ...Array.from({ length: 6 }, (_, index) => big(index))];
    fs.writeFileSync(f.filename, records.map(record => JSON.stringify(record)).join('\n'));
    const app = express();
    app.use(express.json({ limit: '100mb' }));
    app.use((request, _response, next) => { request.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories }; next(); });
    app.use('/api/chats', router);
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const fields = group ? { id: f.locator.chat } : { avatar_url: f.locator.avatar, file_name: f.locator.chat };
    const sent = [];
    const post = (route, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/chats/${group ? 'group/' : ''}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neconyan-Account': f.scope.owner, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const read = await post('get', fields);
    bindRoleplayAccount(f.scope.owner, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch });
    const evidence = parseRoleplayRead(read, f.locator);
    const loaded = await read.json();
    assert.equal(rememberRoleplayRead(f.locator, evidence), true);
    // What the page does when it loads a chat.
    rememberChatPatchBase(evidence.source, fingerprintMessages(loaded, 1));
    async function save(chat, extra = {}) {
        const token = beginRoleplaySave(f.locator, { operationKey: crypto.randomUUID() });
        const result = await sendRoleplaySave(token, { ...fields, chat: [loaded[0], ...snapshotChatMessages(chat)], force: false, deferBackup: true, allowShrink: false, ...extra },
            (body, _stamp, kind) => { sent.push({ kind, bytes: body.length }); return post(kind === 'patch' ? 'patch' : 'save', body); });
        await finishRoleplaySave(token);
        return result;
    }
    return { f, post, fields, loaded, evidence, save, sent };
}

const saved = f => fs.readFileSync(f.filename, 'utf8').split('\n').slice(1).map(line => JSON.parse(line));

for (const group of [false, true]) {
    test(`${group ? 'group' : 'solo'} chat: a large chat is saved as patches that carry only what changed`, async t => {
        const { f, loaded, save, sent } = await start(t, group, `patch-endpoint-${group}`);
        let messages = loaded.slice(1);
        const wholeSize = JSON.stringify(messages).length;
        for (let step = 0; step < 3; step++) {
            messages = [...messages, big(10 + step)];
            const result = await save(messages);
            assert.equal(result.ok, true, JSON.stringify(result.data));
            assert.equal(result.data.roleplay.changed, true);
            assert.equal(sent.at(-1).kind, 'patch');
            assert.ok(sent.at(-1).bytes < wholeSize / 4, `patch of ${sent.at(-1).bytes} bytes for a chat of ${wholeSize}`);
            assert.deepEqual(saved(f), messages);
        }
        messages = messages.map((message, index) => index === 2 ? { ...message, mes: 'edited in the middle' } : message);
        const edited = await save(messages);
        assert.equal(edited.ok, true);
        assert.deepEqual(sent.map(request => request.kind), ['patch', 'patch', 'patch', 'patch']);
        assert.deepEqual(saved(f), messages);
        const none = await save(messages);
        assert.equal(none.data.roleplay.changed, false);
        assert.equal(sent.at(-1).kind, 'patch');
        assert.deepEqual(saved(f), messages);
        // Nothing is lost between the pieces: the file is exactly what a whole save of the same chat writes.
        const written = fs.readFileSync(f.filename, 'utf8').split('\n');
        assert.equal(written.length, messages.length + 1);
        assert.equal(readRoleplayFile(f.filename).bytes.length, Buffer.byteLength(written.join('\n')));
    });

    test(`${group ? 'group' : 'solo'} chat: a patch whose base the server does not hold is answered with 409 and the chat is saved whole`, async t => {
        const { f, loaded, save, sent, evidence } = await start(t, group, `patch-refused-${group}`);
        // The page believes the file holds a different fourth message than it does, and keeps that message as it believes it to be.
        const believed = loaded.slice(1).map((message, index) => index === 3 ? { ...message, mes: 'a message the file never held' } : message);
        rememberChatPatchBase(evidence.source, fingerprintMessages([loaded[0], ...believed], 1));
        const next = [...believed, big(10)];
        const result = await save(next);
        assert.equal(result.ok, true, JSON.stringify(result.data));
        assert.deepEqual(sent.map(request => request.kind), ['patch', 'save']);
        assert.deepEqual(saved(f), next);
        // The whole save made a version the page knows, so the next one is a patch.
        const after = [...next, big(11)];
        assert.equal((await save(after)).ok, true);
        assert.equal(sent.at(-1).kind, 'patch');
        assert.deepEqual(saved(f), after);
    });

    test(`${group ? 'group' : 'solo'} chat: the patch route answers as the save route does`, async t => {
        const { f, post, fields, loaded, evidence } = await start(t, group, `patch-routes-${group}`);
        const base = fingerprintMessages(loaded, 1);
        const { digestKeptFingerprints } = await import('../public/scripts/chat-patch-fingerprint.js');
        const roleplay = () => ({ account: evidence.account, source: evidence.source, operationKey: crypto.randomUUID() });
        const patch = (overrides = {}) => ({ header: loaded[0], prefix: 6, suffix: 0, baseCount: 6, count: 7, kept: digestKeptFingerprints(base, 6, 6, 0), messages: [big(10)], ...overrides });
        const wrong = async (body, status, expected) => {
            const response = await post('patch', { ...fields, deferBackup: true, roleplay: roleplay(), ...body });
            assert.equal(response.status, status);
            const data = await response.json();
            assert.equal(data.error, expected.error, JSON.stringify(data));
            if (expected.reason) assert.equal(data.reason, expected.reason);
        };
        const before = fs.readFileSync(f.filename);
        await wrong({ patch: patch({ kept: 'a'.repeat(32) }) }, 409, { error: 'patch_base_mismatch', reason: 'kept' });
        await wrong({ patch: patch({ baseCount: 5, prefix: 5, count: 6 }) }, 409, { error: 'patch_base_mismatch', reason: 'count' });
        await wrong({ patch: patch({ extra: 1 }) }, 409, { error: 'patch_base_mismatch', reason: 'shape' });
        await wrong({ patch: patch(), force: true }, 409, { error: 'patch_base_mismatch', reason: 'unsupported' });
        await wrong({ patch: patch(), mewmoryHidePolicy: { type: 'manual', lastDisableId: 'x' } }, 409, { error: 'patch_base_mismatch', reason: 'unsupported' });
        await wrong({ patch: patch(), roleplay: { account: evidence.account, vacancy: 0, operationKey: crypto.randomUUID() } }, 409, { error: 'patch_base_mismatch', reason: 'create' });
        await wrong({ patch: patch({ prefix: 0, suffix: 0, count: 0, messages: [], kept: digestKeptFingerprints(base, 6, 0, 0) }) }, 409, { error: 'destructive', reason: 'emptied' });
        await wrong({ patch: patch({ messages: [null] }) }, 400, { error: 'Invalid prepared chat records.' });
        await wrong({}, 409, { error: 'patch_base_mismatch', reason: 'shape' });
        await wrong({ patch: patch(), roleplay: { account: { ...evidence.account, dataEpoch: evidence.account.dataEpoch + 1 }, source: evidence.source, operationKey: crypto.randomUUID() } }, 409, { error: 'account_changed' });
        assert.deepEqual(fs.readFileSync(f.filename), before, 'every refusal left the file as it was');
        // And the same patch, sent properly, is accepted.
        const accepted = await post('patch', { ...fields, deferBackup: true, roleplay: roleplay(), patch: patch() });
        assert.equal(accepted.status, 200);
        const data = await accepted.json();
        assert.equal(data.ok, true);
        assert.equal(data.roleplay.changed, true);
        assert.equal(data.roleplay.source.revision, evidence.source.revision + 1);
        assert.equal(typeof data.integrity, 'string');
        assert.equal(saved(f).length, 7);
    });
}
