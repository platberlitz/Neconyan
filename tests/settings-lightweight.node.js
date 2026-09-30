/* eslint playwright/expect-expect: off -- Node assertions exercise the settings route. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { router } = await import('../src/endpoints/settings.js');
const get = router.stack.find(layer => layer.route?.path === '/get').route.stack[0].handle;

test('settings-only reads return the latest disk contents without opening any catalogues', t => {
    const f = fixture(t);
    const file = path.join(f.scope.directories.root, 'settings.json');
    let result;
    const response = { send: body => { result = body; }, sendStatus: status => assert.fail(`Unexpected status ${status}`) };
    // Only root is supplied. Reading any preset/agent directory would fail.
    const request = { body: { settingsOnly: true }, user: { directories: { root: f.scope.directories.root } } };
    for (const version of [1, 2]) {
        const source = JSON.stringify({ _version: version, extension_settings: { example: { lastCommit: String(version) } } });
        fs.writeFileSync(file, source);
        get(request, response);
        assert.deepEqual(result, { settings: source });
    }
});
