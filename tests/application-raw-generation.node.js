import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
await import('../src/operations/raw-generation.js');
const { readOperation } = await import('../src/operations/store.js');
const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
const { getJob } = await import('../src/jobs/store.js');
const { providerStep } = await import('../src/jobs/artifacts.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const roots = [];
after(() => { cancelAutoSaves(); roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

function prepared(owner = 'raw') {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-generation-'));
    roots.push(parent);
    const root = path.join(parent, owner);
    fs.mkdirSync(root);
    const directories = { root };
    for (const name of ['worlds', 'characters', 'groups', 'chats', 'groupChats', 'openAI_Settings']) {
        directories[name] = path.join(root, name);
        fs.mkdirSync(directories[name]);
    }
    const preset = JSON.parse(fs.readFileSync(new URL('./fixtures/openai-default-preset.json', import.meta.url), 'utf8'));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ name1: 'User', main_api: 'openai', max_context: 4096,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { ...preset, chat_completion_source: 'openai', openai_model: 'gpt-4o' } }));
    const base = { owner, directories };
    initialiseRoleplayAccount(base);
    const request = { user: { profile: { handle: owner }, directories } };
    const context = accepted => ({ ...base, job: getJob(directories, accepted.job.id), signal: new AbortController().signal, progress: async () => {} });
    return { base, request, context };
}

const body = (key, extra = {}) => ({ key, kind: 'raw-generation', systemPrompt: 'Pick one colour.', prompt: 'Red or blue?', profileId: 'saved', ...extra });

test('a plain prompt finishes after the page closes and a lost answer is read back without a second call', async () => {
    const p = prepared();
    const accepted = await acceptApplicationOperation(p.request, body('raw'));
    let calls = 0;
    const generate = async options => {
        calls++;
        assert.deepEqual(options.messages, [{ role: 'system', content: 'Pick one colour.' }, { role: 'user', content: 'Red or blue?' }]);
        return { text: 'Blue' };
    };
    await runOperation(p.context(accepted), { generate });
    assert.equal(readOperation(p.base, 'raw').result.text, 'Blue');
    fs.rmSync(path.join(p.base.directories.root, 'jobs/index.json'));
    const again = await acceptApplicationOperation(p.request, body('raw'));
    assert.equal(again.job, null);
    assert.equal(again.record.state, 'completed');
    assert.equal(calls, 1);
});

test('an unknown model result is not sent again', async () => {
    const p = prepared();
    const accepted = await acceptApplicationOperation(p.request, body('unknown'));
    let calls = 0;
    const generate = options => providerStep(options.jobContext, options.stepNamespace, async () => { calls++; throw new Error('connection lost'); });
    await assert.rejects(runOperation(p.context(accepted), { generate }), /connection lost/);
    await assert.rejects(runOperation(p.context(accepted), { generate }), /unknown/i);
    assert.equal(calls, 1);
});

test('an empty prompt is refused before any work is accepted', async () => {
    const p = prepared();
    await assert.rejects(acceptApplicationOperation(p.request, body('empty', { prompt: ' ', systemPrompt: '' })), /prompt/);
    assert.equal(readOperation(p.base, 'empty'), null);
});
