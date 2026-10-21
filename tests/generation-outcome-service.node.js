import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { runTextGeneration, runChatProfile } = await import('../src/generation/service.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');

for (const source of ['openrouter', 'nanogpt']) for (const stream of [false, true]) {
    test(`${source} structured HTTP policy rejection survives ${stream ? 'streaming' : 'JSON'} transport`, async t => {
        const f = fixture(t);
        writeSecret(f.scope.directories, source === 'openrouter' ? SECRET_KEYS.OPENROUTER : SECRET_KEYS.NANOGPT, 'fake-fixture-key');
        let calls = 0;
        const result = await runTextGeneration({ context: f.scope, backend: 'chat',
            payload: { chat_completion_source: source, model: 'fixture', messages: [{ role: 'user', content: 'Hello' }], stream },
            fetch: async () => {
                calls++;
                return { ok: false, status: 400, statusText: 'Bad Request', headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify({ error: { code: 'content_policy_violation', message: 'Fixture policy' } }),
                    body: Readable.from([JSON.stringify({ error: { code: 'content_policy_violation', message: 'Fixture policy' } })]) };
            } });
        assert.equal(result.outcome?.status, 'blocked');
        assert.equal(result.text, '');
        assert.equal(calls, 1);
    });
}

test('shared profile clean-up preserves blocked incomplete sentences and saves empty blocked results', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({ power_user: { trim_sentences: true },
        extension_settings: { connectionManager: { profiles: [{ id: 'fixture', mode: 'cc', api: 'custom', model: 'fixture', 'api-url': 'http://provider.invalid/v1' }] } },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://provider.invalid/v1' } }));
    const binding = { kind: 'profile', ...captureChatProfile(f.scope.directories, 'fixture') };
    for (const text of ['An unfinished sentence with', '']) {
        const result = await runChatProfile({ context: f.scope, binding, messages: [{ role: 'user', content: 'Hello' }], maxTokens: 32,
            fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: text }, finish_reason: 'content_filter' }] }) }) });
        assert.equal(result.text, text);
        assert.equal(result.outcome.status, 'blocked');
    }
});
