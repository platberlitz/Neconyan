/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { CUSTOM_STATUS_TIMEOUT_MS, describeCustomStatusFailure, getCustomSecretIdError } = await import('../src/endpoints/backends/chat-completions.js');
const { secretIdExists, SECRET_KEYS } = await import('../src/endpoints/secrets.js');

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-endpoint-status-'));
    fs.writeFileSync(path.join(root, 'secrets.json'), JSON.stringify({
        [SECRET_KEYS.CUSTOM]: [{ id: 'known-id', value: 'sk-test', label: 'Test', active: true }],
    }));
    return { root };
}

function response(status, contentType, body) {
    return { status, headers: { get: () => contentType }, text: async () => body };
}

test('secret id lookups distinguish known and unknown ids', () => {
    const directories = makeDirectories();
    assert.equal(secretIdExists(directories, SECRET_KEYS.CUSTOM, 'known-id'), true);
    assert.equal(secretIdExists(directories, SECRET_KEYS.CUSTOM, 'missing-id'), false);
});

test('a stale secret id fails loudly instead of sending an empty bearer', () => {
    const directories = makeDirectories();
    assert.equal(getCustomSecretIdError({ body: { secret_id: 'known-id' }, user: { directories } }), '');
    assert.equal(getCustomSecretIdError({ body: {}, user: { directories } }), '');
    assert.match(getCustomSecretIdError({ body: { secret_id: 'missing-id' }, user: { directories } }), /no longer exists/);
});

test('status probe failures explain what the endpoint actually did', async () => {
    assert.equal(CUSTOM_STATUS_TIMEOUT_MS, 15000);

    assert.match(await describeCustomStatusFailure(response(401, 'text/html', '<!doctype html><html>login</html>')), /login page/);
    assert.match(await describeCustomStatusFailure(response(401, 'application/json', '{"error":{"message":"bad key"}}')), /rejected the API key/);
    assert.match(await describeCustomStatusFailure(response(404, 'application/json', '{}')), /no \/models route/);
    assert.match(await describeCustomStatusFailure(response(200, 'text/html; charset=utf-8', '<html><body>hi</body></html>')), /web page/);
    assert.equal(await describeCustomStatusFailure(response(429, 'application/json', '{"error":{"message":"Rate limited"}}')), 'The endpoint returned HTTP 429: Rate limited.');
    assert.equal(await describeCustomStatusFailure(response(500, 'text/plain', 'boom')), 'The endpoint returned HTTP 500: boom.');
});
