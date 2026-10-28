/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const express = (await import('express')).default;
const { router } = await import('../src/endpoints/mewmory.js');
const { defaultConfig } = await import('../src/mewmory/models.js');

function directories(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-config-account-'));
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const result = { root };
    for (const name of ['chats', 'groupChats', 'groups', 'worlds', 'characters']) {
        result[name] = path.join(root, name);
        fs.mkdirSync(result[name], { recursive: true });
    }
    return result;
}

async function appFor(t, handle) {
    const dirs = directories(t);
    const application = express();
    application.use(express.json());
    application.use((request, response, next) => {
        request.user = { directories: dirs, profile: { handle } };
        next();
    });
    application.use(router);
    const server = await new Promise(resolve => {
        const listener = application.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = async (url, body = {}, headers = {}) => {
        const response = await fetch(base + url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    return { dirs, post };
}

test('config save and get identify the canonical account and reject a stale identity before writing', async t => {
    const { post } = await appFor(t, 'alice');
    const initial = await post('/config/save', { config: defaultConfig() }, { 'X-Neconyan-Account': 'alice' });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.config.account, 'alice');
    const revision = initial.body.config.revision;

    const read = await post('/config/get', {}, { 'X-Neconyan-Account': 'alice' });
    assert.equal(read.status, 200);
    assert.equal(read.body.config.account, 'alice');

    const staleGet = await post('/config/get', {}, { 'X-Neconyan-Account': 'bob' });
    assert.equal(staleGet.status, 403);
    assert.notEqual(staleGet.status, 409);
    assert.equal(staleGet.body.code, 'MEWMORY_ACCOUNT_CHANGED');
    assert.match(staleGet.body.error, /different signed-in account/);

    const staleSave = await post('/config/save', { config: { ...defaultConfig(), autoHide: true } }, { 'X-Neconyan-Account': 'bob' });
    assert.equal(staleSave.status, 403);
    assert.notEqual(staleSave.status, 409);
    assert.equal(staleSave.body.code, 'MEWMORY_ACCOUNT_CHANGED');

    const after = await post('/config/get', {}, { 'X-Neconyan-Account': 'alice' });
    assert.equal(after.body.config.autoHide, false, 'a stale identity never wrote another account settings');
    assert.equal(after.body.config.revision, revision);

    const unheadered = await post('/config/get');
    assert.equal(unheadered.status, 200, 'the read-only panel refresh remains compatible');
    assert.equal(unheadered.body.config.account, 'alice');
});

test('catch-up defaults to reply, validates its choice and preserves wait for a legacy save', async t => {
    const { post } = await appFor(t, 'alice');
    const headers = { 'X-Neconyan-Account': 'alice' };
    assert.equal(defaultConfig().historyCatchUp, 'reply');
    const oldConfig = defaultConfig();
    delete oldConfig.historyCatchUp;
    const legacy = await post('/config/save', { config: oldConfig }, headers);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.config.historyCatchUp, 'reply');

    const selected = await post('/config/save', { config: { ...legacy.body.config, historyCatchUp: 'wait' } }, headers);
    assert.equal(selected.status, 200);
    assert.equal(selected.body.config.historyCatchUp, 'wait');
    const oldClient = { ...selected.body.config };
    delete oldClient.historyCatchUp;
    const preserved = await post('/config/save', { config: oldClient }, headers);
    assert.equal(preserved.status, 200);
    assert.equal(preserved.body.config.historyCatchUp, 'wait');

    const invalid = await post('/config/save', { config: { ...preserved.body.config, historyCatchUp: 'later' } }, headers);
    assert.equal(invalid.status, 400);
    const stale = await post('/config/save', { config: { ...selected.body.config, historyCatchUp: 'reply' } }, headers);
    assert.equal(stale.status, 409);
    const saved = await post('/config/get', {}, headers);
    assert.equal(saved.body.config.historyCatchUp, 'wait');
});
