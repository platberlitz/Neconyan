import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { fixture } from './roleplay-transactions-fixture.js';
import { router } from '../src/endpoints/chats.js';
import { readRoleplayFile } from '../src/roleplay-store.js';
import { beginRoleplaySave, bindRoleplayAccount, finishRoleplaySave, parseRoleplayRead, rememberRoleplayRead, sendRoleplaySave } from '../public/scripts/roleplay-save-chain.js';

for (const group of [false, true]) for (const queued of [false, true]) {
    test(`${group ? 'group' : 'solo'} editor keeps its read after ${queued ? 'unsettled' : 'completed'} background write`, async t => {
        const f = fixture(t, group, `editor-lineage-${group}-${queued}`);
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => { req.user = { profile: { handle: f.scope.owner }, directories: f.scope.directories }; next(); });
        app.use('/api/chats', router);
        const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
        t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
        const fields = group ? { id: f.locator.chat } : { avatar_url: f.locator.avatar, file_name: f.locator.chat };
        const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/api/chats/${group ? 'group/' : ''}${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neconyan-Account': f.scope.owner },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        const read = await post('get', fields);
        bindRoleplayAccount(f.scope.owner, { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch });
        const evidence = parseRoleplayRead(read, f.locator);
        const editorRecords = await read.json();
        assert.equal(rememberRoleplayRead(f.locator, evidence), true);
        const backgroundRecords = structuredClone(editorRecords);
        backgroundRecords[1].mes = 'Background-only edit';
        const background = beginRoleplaySave(f.locator, { operationKey: 'background', evidence });
        const queuedEditor = queued ? beginRoleplaySave(f.locator, { operationKey: 'editor' }) : null;
        const bg = await sendRoleplaySave(background, { ...fields, chat: backgroundRecords, deferBackup: true }, body => post('save', body));
        assert.equal(bg.ok, true);
        if (!queued) await finishRoleplaySave(background);
        const editor = queuedEditor ?? beginRoleplaySave(f.locator, { operationKey: 'editor' });
        editorRecords[2].mes = 'Independent editor edit';
        let sent;
        const waiting = sendRoleplaySave(editor, { ...fields, chat: editorRecords, deferBackup: true }, body => {
            sent = JSON.parse(body);
            return post('save', body);
        });
        if (queued) await finishRoleplaySave(background);
        const result = await waiting;
        await finishRoleplaySave(editor);
        assert.equal(sent.roleplay.source.revision, evidence.source.revision);
        assert.equal(result.status, 400);
        assert.equal(result.data.error, 'integrity');
        const saved = readRoleplayFile(f.filename).bytes.toString().split('\n').map(JSON.parse);
        assert.equal(saved[1].mes, 'Background-only edit');
        assert.equal(saved[2].mes, f.records[2].mes);
    });
}
