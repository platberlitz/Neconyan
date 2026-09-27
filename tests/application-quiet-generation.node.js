import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { acceptApplicationOperation, runOperation } = await import('../src/operations/jobs.js');
await import('../src/operations/quiet-generation.js');
const { readOperation } = await import('../src/operations/store.js');
const { initialiseRoleplayAccount } = await import('../src/roleplay-store.js');
const { getJob } = await import('../src/jobs/store.js');
const { providerStep } = await import('../src/jobs/artifacts.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const roots = [];
after(() => { cancelAutoSaves(); roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

function prepared(owner = 'quiet') {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-generation-'));
    roots.push(parent);
    const root = path.join(parent, owner);
    fs.mkdirSync(root);
    const directories = { root };
    for (const name of ['worlds', 'characters', 'groups', 'chats', 'groupChats', 'openAI_Settings']) {
        directories[name] = path.join(root, name);
        fs.mkdirSync(directories[name]);
    }
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    const cardPath = path.join(directories.characters, 'nova.png');
    fs.writeFileSync(cardPath, writeCard(png, JSON.stringify({ name: 'Nova', description: 'An astronaut.' })));
    fs.mkdirSync(path.join(directories.chats, 'nova'));
    const chatPath = path.join(directories.chats, 'nova', 'scene.jsonl');
    fs.writeFileSync(chatPath, [{ user_name: 'User', character_name: 'Nova', chat_metadata: {} },
        { name: 'Nova', mes: 'The moon garden grows roses.', is_user: false }].map(row => JSON.stringify(row)).join('\n'));
    const preset = JSON.parse(fs.readFileSync(new URL('../default/content/presets/openai/Default.json', import.meta.url), 'utf8'));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ name1: 'User', main_api: 'openai', max_context: 4096,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { ...preset, chat_completion_source: 'openai', openai_model: 'gpt-4o' } }));
    const base = { owner, directories };
    initialiseRoleplayAccount(base);
    const request = { user: { profile: { handle: owner }, directories } };
    const context = accepted => ({ ...base, job: getJob(directories, accepted.job.id), signal: new AbortController().signal, progress: async () => {} });
    return { base, request, context, cardPath, chatPath };
}

const body = (key, extra = {}) => ({ key, kind: 'quiet-generation', prompt: 'Choose a location for the scene.', profileId: 'saved',
    locator: { group: false, avatar: 'nova.png', chat: 'scene' }, ...extra });

test('a background prompt runs from the saved chat after the page closes and is never sent twice', async () => {
    const p = prepared();
    const accepted = await acceptApplicationOperation(p.request, body('quiet'));
    fs.rmSync(p.cardPath);
    let calls = 0;
    const generate = async options => {
        calls++;
        const text = options.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
        assert.match(text, /An astronaut\./);
        assert.match(text, /The moon garden grows roses\./);
        assert.deepEqual(options.messages.at(-1), { role: 'system', content: 'Choose a location for the scene.' });
        return { text: 'Moon garden' };
    };
    await runOperation(p.context(accepted), { generate });
    assert.equal(readOperation(p.base, 'quiet').result.text, 'Moon garden');
    fs.rmSync(path.join(p.base.directories.root, 'jobs/index.json'));
    const again = await acceptApplicationOperation(p.request, body('quiet'));
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

test('group chats and missing prompts are refused before any work is accepted', async () => {
    const p = prepared();
    await assert.rejects(acceptApplicationOperation(p.request, body('group', { locator: { group: true, chat: 'scene' } })), /solo chat/);
    await assert.rejects(acceptApplicationOperation(p.request, body('empty', { prompt: '  ' })), /prompt/);
    assert.equal(readOperation(p.base, 'group'), null);
});
