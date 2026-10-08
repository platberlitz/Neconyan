import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
import { providerSettings, instructSettings } from './fixtures/text-generation-baseline.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { acceptLabJob, runLabJob } = await import('../src/labs/jobs.js');
const { admitLabJob, readLabRecord, finalizeLabSubmission, refuseLabSubmission, LAB_STORE_LIMIT, LAB_RECORD_LIMIT } = await import('../src/labs/store.js');
const { initialiseRoleplayAccount, withRoleplayAccount, roleplayStoreDirectory } = await import('../src/roleplay-store.js');
const { providerStep, writeArtifact } = await import('../src/jobs/artifacts.js');
const { runChatProfile } = await import('../src/generation/service.js');
const { getJob, updateJob } = await import('../src/jobs/store.js');
const { worldInfoRevision } = await import('../src/world-info-history.js');
const { write: writeCard, read: readCard } = await import('../src/character-card-parser.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { assertNativeMediaTargetIdle } = await import('../src/generation/media-jobs.js');
const { storedCases } = await import('../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/test-case-core.js');
const { listWorldInfoCases } = await import('../src/labs/world-info-cases.js');
const { readPromptingStorage } = await import('../src/labs/prompting-storage.js');
const { mutateState, statePath } = await import('../src/mewmory/store.js');
const { defaultConfig, readConfig } = await import('../src/mewmory/models.js');
const { syncSources, putRecord, validateRecord, refKey } = await import('../src/mewmory/core.js');
const { processingVersion } = await import('../src/mewmory/processing.js');
const { readContextSourcesSync } = await import('../src/mewmory/sources.js');
const { fingerprint } = await import('../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/presets.js');
const { EMBED_KEY } = await import('../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/constants.js');
const { listLabRecovery, recoverLabPublication } = await import('../src/labs/recovery.js');
const { captureLabChat } = await import('../src/labs/sources.js');
const { capturePromptingContext } = await import('../src/labs/prompting-context.js');
const roots = [];
after(() => { cancelAutoSaves(); roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

function fixture(owner = 'tester') {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'labs-jobs-'));
    roots.push(parent);
    const root = path.join(parent, owner);
    fs.mkdirSync(root);
    const directories = { root };
    for (const name of ['worlds', 'characters', 'groups', 'chats', 'groupChats', 'openAI_Settings']) {
        directories[name] = path.join(root, name);
        fs.mkdirSync(directories[name]);
    }
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    fs.writeFileSync(path.join(directories.characters, 'nova.png'), writeCard(png, JSON.stringify({ name: 'Nova', description: 'An astronaut.' })));
    fs.mkdirSync(path.join(directories.chats, 'nova'));
    const chatPath = path.join(directories.chats, 'nova', 'scene.jsonl');
    fs.writeFileSync(chatPath, [{ user_name: 'User', character_name: 'Nova', chat_metadata: {} },
        { name: 'Nova', mes: 'The moon garden grows roses.', is_user: false }].map(row => JSON.stringify(row)).join('\n'));
    const bookPath = path.join(directories.worlds, 'Garden.json');
    fs.writeFileSync(bookPath, JSON.stringify({ entries: { 3: { uid: 3, key: ['earth'], comment: 'Earth', content: 'Earth is blue.' } } }));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ name1: 'User', main_api: 'openai', max_context: 4096,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] } },
        oai_settings: { chat_completion_source: 'openai', openai_model: 'gpt-4o' } }));
    fs.copyFileSync(new URL('./fixtures/openai-default-preset.json', import.meta.url), path.join(directories.openAI_Settings, 'Default.json'));
    const base = { owner, directories };
    initialiseRoleplayAccount(base);
    const account = withRoleplayAccount(base, null, (_lease, account) => account);
    const request = { user: { profile: { handle: owner }, directories } };
    const body = { key: 'distill-one', kind: 'distill', locator: { group: false, avatar: 'nova.png', chat: 'scene' }, book: 'Garden', profileId: 'saved' };
    const context = accepted => ({ ...base, job: accepted.job, signal: new AbortController().signal, progress: async () => {} });
    return { base, account, request, body, context, chatPath, bookPath };
}

const proposals = [{ title: 'Moon garden', keys: ['moon garden'], content: 'Roses grow on the moon.' },
    { title: 'Nova', keys: ['nova'], content: 'Nova tends the garden.' }];
const generate = async () => ({ text: JSON.stringify(proposals) });
async function ready(f) {
    const accepted = await acceptLabJob(f.request, f.body);
    await runLabJob(f.context(accepted), { generate });
    return readLabRecord(f.base, f.body.key);
}
const applyBody = (record, ids = [0], key = 'apply-one') => ({ key, kind: 'apply', proposalKey: record.key, resultHash: record.resultHash,
    selected: ids.map(id => ({ ...record.result.proposals[id], id })) });

async function savedSuite(f) {
    for (const [method, value] of [
        ['saveCase', { id: 'case', name: 'Moon test', pins: { characterAvatar: 'nova.png', connectionProfileId: 'saved' }, userMessage: 'Describe the moon.', assertions: [] }],
        ['saveSuite', { id: 'suite', name: 'Moon suite', caseIds: ['case'] }],
    ]) {
        const accepted = await acceptLabJob(f.request, { key: method, kind: 'prompting.storage', method, args: [value] });
        await runLabJob(f.context(accepted));
    }
}

test('late Stop finalises a known database write and an interrupted cancelled write recovers from its receipt', async () => {
    const f = fixture(), controller = new AbortController();
    const accepted = await acceptLabJob(f.request, { key: 'late-stop', kind: 'prompting.storage', method: 'saveSuite', args: [{ id: 'late', name: 'Saved' }] });
    await runLabJob({ ...f.context(accepted), signal: controller.signal }, { beforeStoragePublish: () => controller.abort('user-stop') });
    assert.equal(readLabRecord(f.base, 'late-stop').state, 'completed');
    const interrupted = await acceptLabJob(f.request, { key: 'lost-stop', kind: 'prompting.storage', method: 'saveSuite', args: [{ id: 'lost', name: 'Also saved' }] });
    await assert.rejects(runLabJob(f.context(interrupted), { beforeStoragePublish: () => { throw new Error('lost after saved write'); } }), /lost after/);
    updateJob(f.base.directories, interrupted.job.id, job => ({ ...job, state: 'cancelled', cancellation: { requested: true, requestedAt: Date.now(), reason: 'user-stop' } }));
    assert.deepEqual(listLabRecovery(f.base).map(record => record.key), ['lost-stop']);
    assert.equal(recoverLabPublication(f.base, 'lost-stop').state, 'completed');
    assert.equal((await readPromptingStorage(f.base, f.account, 'listSuites')).value.length, 2);
    assert.deepEqual(listLabRecovery(f.base), []);
});

test('cancelled physical publication resumes only its saved local operation and excludes provider jobs', async () => {
    const f = fixture(), draft = await presetDraft(f);
    const accepted = await acceptLabJob(f.request, { key: 'recover-preset', kind: 'prompting.publish', draftId: draft.id, version: await fingerprint(draft) });
    await assert.rejects(runLabJob(f.context(accepted), { afterPresetPublication: () => { throw new Error('lost physical acknowledgement'); } }), /lost physical/);
    updateJob(f.base.directories, accepted.job.id, job => ({ ...job, state: 'cancelled', recoverySteps: ['preserve-this-evidence'],
        cancellation: { requested: true, requestedAt: Date.now(), reason: 'user-stop' } }));
    recoverLabPublication(f.base, 'recover-preset');
    const resumed = getJob(f.base.directories, accepted.job.id);
    assert.equal(resumed.state, 'queued');
    assert.equal(resumed.cancellation.requested, false);
    assert.deepEqual(resumed.recoverySteps, ['preserve-this-evidence']);
    await runLabJob({ ...f.context(accepted), job: resumed });
    assert.equal(readLabRecord(f.base, 'recover-preset').state, 'completed');
    const paid = await acceptLabJob(f.request, f.body);
    updateJob(f.base.directories, paid.job.id, job => ({ ...job, state: 'cancelled' }));
    assert.throws(() => recoverLabPublication(f.base, f.body.key), /No interrupted local publication/);
});

test('a failed progress write retains paid comparison replies before a retry', async () => {
    const f = fixture();
    const accepted = await acceptLabJob(f.request, { key: 'progress', kind: 'prompting.requests', operation: 'experiment', profileId: 'saved', promptA: 'A', promptB: 'B' });
    let calls = 0;
    const options = { generate: async () => { calls++; return { text: 'Saved reply' }; } };
    await assert.rejects(runLabJob({ ...f.context(accepted), progress: async () => { throw new Error('progress storage unavailable'); } }, options), /progress storage unavailable/);
    await runLabJob(f.context(accepted), options);
    assert.equal(calls, 2);
    assert.equal(readLabRecord(f.base, 'progress').result.length, 2);
});

test('dry-run pinned templates retain formatting without retaining connection credentials', () => {
    const f = fixture(), filename = path.join(f.base.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(filename));
    settings._settingsRevision = 1;
    settings.active_generation = { api: 'openai', source: 'custom', model: 'gpt-4o' };
    Object.assign(settings.oai_settings, { chat_completion_source: 'custom', custom_model: 'gpt-4o', custom_url: 'http://127.0.0.1:5000/v1' });
    fs.writeFileSync(filename, JSON.stringify(settings));
    const presetFile = path.join(f.base.directories.openAI_Settings, 'Default.json');
    const preset = JSON.parse(fs.readFileSync(presetFile));
    Object.assign(preset, { proxy_password: 'DO-NOT-PERSIST', custom_include_headers: 'Authorization: DO-NOT-PERSIST' });
    fs.writeFileSync(presetFile, JSON.stringify(preset));
    const plan = capturePromptingContext(f.base, f.account, { characterAvatar: 'nova.png', presets: [{ apiId: 'openai', name: 'Default' }] });
    assert.equal(JSON.stringify(plan).includes('DO-NOT-PERSIST'), false);
    assert.deepEqual(plan.templates.sampler.prompts, preset.prompts);
});

test('group persona selection uses the owning group identifier and refuses shared chat ownership', () => {
    const f = fixture(), directories = f.base.directories;
    fs.copyFileSync(f.chatPath, path.join(directories.groupChats, 'different-chat-name.jsonl'));
    fs.writeFileSync(path.join(directories.groups, 'group-one.json'), JSON.stringify({ id: 'group-one', members: ['nova.png'], chats: ['different-chat-name'] }));
    const avatars = path.join(directories.root, 'User Avatars');
    fs.mkdirSync(avatars);
    fs.copyFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url), path.join(avatars, 'botanist.png'));
    const settingsPath = path.join(directories.root, 'settings.json'), settings = JSON.parse(fs.readFileSync(settingsPath));
    settings.power_user = { personas: { 'botanist.png': 'Botanist' }, persona_descriptions: {
        'botanist.png': { description: 'A lunar botanist.', connections: [{ id: 'group-one' }] },
    } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const locator = { group: true, chat: 'different-chat-name' };
    assert.equal(captureLabChat(f.base, f.account, locator).persona.description, 'A lunar botanist.');
    fs.writeFileSync(path.join(directories.groups, 'group-two.json'), JSON.stringify({ id: 'group-two', members: [], chats: ['different-chat-name'] }));
    assert.throws(() => captureLabChat(f.base, f.account, locator), /More than one group/);
});

test('native text scene requests keep the compiled prompt intact while applying the saved sampler', async () => {
    const f = fixture(), directories = f.base.directories;
    directories.textGen_Settings = path.join(directories.root, 'textGen_Settings');
    fs.mkdirSync(directories.textGen_Settings);
    const controls = { ...providerSettings, banned_tokens: '', global_banned_tokens: '', logit_bias: [], send_banned_tokens: true,
        dry_sequence_breakers: '[]', negative_prompt: '', temp: 0.23, dynatemp: false };
    fs.writeFileSync(path.join(directories.textGen_Settings, 'Text fixture.json'), JSON.stringify(controls));
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ max_context: 8192, main_api: 'textgenerationwebui',
        textgenerationwebui_settings: { ...controls, type: 'llamacpp', api_server: 'http://127.0.0.1:5000' },
        power_user: { instruct: { ...instructSettings, enabled: true }, custom_stopping_strings: '[]' },
        extension_settings: { connectionManager: { profiles: [{ id: 'text', mode: 'tc', api: 'llamacpp', model: 'fixture', 'api-url': 'http://127.0.0.1:5000' }] } } }));
    const accepted = await acceptLabJob(f.request, { key: 'text-scene', kind: 'prompting.scene', characterAvatar: 'nova.png',
        connectionProfileId: 'text', presets: [{ apiId: 'textgenerationwebui', name: 'Text fixture' }], turns: ['Hello'], mode: 'scripted' });
    const compiled = '<user>Already formatted</user><assistant>';
    writeArtifact(directories, accepted.job.id, 'scene:0:1:capture', { combinedPrompt: compiled, tokenTable: { total: 12 } });
    let calls = 0;
    await runLabJob(f.context(accepted), { generate: options => runChatProfile({ ...options, fetch: async (_url, request) => {
        calls++;
        const body = JSON.parse(request.body);
        assert.equal(body.prompt, compiled);
        assert.equal(body.temperature, 0.23);
        return new Response(JSON.stringify({ choices: [{ text: 'Saved text reply.' }] }));
    } }) });
    assert.equal(calls, 1);
    assert.equal(readLabRecord(f.base, 'text-scene').result.columns[0].turns[0].text, 'Saved text reply.');
});

test('missing canonical cases produce saved suite errors and cannot be omitted from card proposals', async () => {
    const f = fixture();
    const saved = await acceptLabJob(f.request, { key: 'missing-suite', kind: 'prompting.storage', method: 'saveSuite', args: [{ id: 'suite', name: 'Incomplete', caseIds: ['missing'] }] });
    await runLabJob(f.context(saved));
    const suite = await acceptLabJob(f.request, { key: 'missing-run', kind: 'prompting.suite', suiteId: 'suite' });
    await runLabJob(f.context(suite));
    const result = readLabRecord(f.base, 'missing-run').result;
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].caseId, 'missing');
    assert.ok(result.runs[0].error);
    await assert.rejects(acceptLabJob(f.request, { key: 'missing-embed', kind: 'prompting.embed', operation: 'preview', suiteId: 'suite', avatar: 'nova.png' }), /no longer exists/);
});

test('suite transfer freezes its source and recovers an import without duplicating regenerated identifiers', async () => {
    const f = fixture();
    await savedSuite(f);
    const exported = await acceptLabJob(f.request, { key: 'export', kind: 'prompting.transfer', operation: 'export', suiteId: 'suite' });
    const edit = await acceptLabJob(f.request, { key: 'edit', kind: 'prompting.storage', method: 'saveSuite', args: [{ id: 'suite', name: 'Later suite', caseIds: ['case'] }] });
    await runLabJob(f.context(edit));
    await runLabJob(f.context(exported));
    const text = readLabRecord(f.base, 'export').result.text;
    assert.equal(JSON.parse(text).suite.name, 'Moon suite');
    // Valid JSON whitespace keeps the original 10 MB import allowance meaningful beyond the ordinary 8 MB plan limit.
    const largeText = text + ' '.repeat(8 * 1024 * 1024);
    const imported = await acceptLabJob(f.request, { key: 'import', kind: 'prompting.transfer', operation: 'import', text: largeText });
    await assert.rejects(runLabJob(f.context(imported), { beforeStoragePublish: () => { throw new Error('lost import acknowledgement'); } }), /lost import acknowledgement/);
    const before = (await readPromptingStorage(f.base, f.account, 'listSuites')).value;
    assert.equal(before.length, 2);
    await runLabJob(f.context(imported));
    const afterImport = (await readPromptingStorage(f.base, f.account, 'listSuites')).value;
    assert.deepEqual(afterImport, before);
    const result = readLabRecord(f.base, 'import').result;
    assert.notEqual(result.suite.id, 'suite');
    assert.equal(result.cases.length, 1);
    assert.equal(result.suite.caseIds[0], result.cases[0].id);
});

test('embedded character proposals preserve the card until reviewed and recover without restoring a later deletion', async () => {
    const f = fixture();
    await savedSuite(f);
    const filename = path.join(f.base.directories.characters, 'nova.png');
    const before = fs.readFileSync(filename);
    const preview = await acceptLabJob(f.request, { key: 'embed', kind: 'prompting.embed', operation: 'preview', suiteId: 'suite', avatar: 'nova.png' });
    await runLabJob(f.context(preview));
    assert.deepEqual(fs.readFileSync(filename), before);
    const record = readLabRecord(f.base, 'embed');
    assert.equal(record.result.payload.cases[0].pins.connectionProfileId, '');
    const applied = await acceptLabJob(f.request, { key: 'embed-apply', kind: 'prompting.embed-apply', proposalKey: record.key, resultHash: record.resultHash });
    await assert.rejects(runLabJob(f.context(applied), { afterCardPublication: () => { throw new Error('lost card acknowledgement'); } }), /lost card acknowledgement/);
    const card = JSON.parse(readCard(fs.readFileSync(filename)));
    assert.equal(card.data.description, 'An astronaut.');
    assert.equal(card.data.extensions[EMBED_KEY].cases.length, 1);
    fs.unlinkSync(filename);
    await runLabJob(f.context(applied));
    assert.equal(fs.existsSync(filename), false);
    assert.equal(readLabRecord(f.base, 'embed-apply').state, 'completed');
    const duplicate = await acceptLabJob(f.request, { key: 'another-apply', kind: 'prompting.embed-apply', proposalKey: record.key, resultHash: record.resultHash });
    await runLabJob(f.context(duplicate));
    assert.equal(fs.existsSync(filename), false);
});

test('embedded test adoption saves cases and suite membership together and does not duplicate on recovery', async () => {
    const f = fixture();
    await savedSuite(f);
    const preview = await acceptLabJob(f.request, { key: 'embed', kind: 'prompting.embed', operation: 'preview', suiteId: 'suite', avatar: 'nova.png' });
    await runLabJob(f.context(preview));
    const record = readLabRecord(f.base, 'embed');
    const applied = await acceptLabJob(f.request, { key: 'apply', kind: 'prompting.embed-apply', proposalKey: record.key, resultHash: record.resultHash });
    await runLabJob(f.context(applied));
    const adopted = await acceptLabJob(f.request, { key: 'adopt', kind: 'prompting.embed', operation: 'adopt', suiteId: 'suite', avatar: 'nova.png' });
    await assert.rejects(runLabJob(f.context(adopted), { beforeStoragePublish: () => { throw new Error('lost adoption acknowledgement'); } }), /lost adoption acknowledgement/);
    await runLabJob(f.context(adopted));
    const suite = (await readPromptingStorage(f.base, f.account, 'getSuite', ['suite'])).value;
    assert.equal(suite.caseIds.length, 2);
    assert.equal(new Set(suite.caseIds).size, 2);
    assert.equal((await readPromptingStorage(f.base, f.account, 'getCase', [suite.caseIds[1]])).value.pins.characterAvatar, 'nova.png');
    await runLabJob(f.context(adopted));
    assert.deepEqual((await readPromptingStorage(f.base, f.account, 'getSuite', ['suite'])).value, suite);
});

test('permanent rejection prevents a delayed copy of the same submission from being admitted', () => {
    const f = fixture();
    const body = { key: 'rejected', kind: 'distill', book: 'Missing' };
    assert.equal(refuseLabSubmission(f.base, f.account, body, 'Missing book'), true);
    const admitted = admitLabJob(f.base, f.account, { key: body.key, kind: body.kind, input: { book: body.book }, plan: { capturedLater: true }, label: 'Delayed' });
    assert.equal(admitted.created, false);
    assert.equal(admitted.job, null);
    assert.equal(admitted.record.state, 'refused');
    assert.equal(refuseLabSubmission(f.base, f.account, body, 'A later refusal'), false);
    assert.equal(readLabRecord(f.base, body.key).error, 'Missing book');
});

async function presetDraft(f, name = 'Moon preset') {
    const job = await acceptLabJob(f.request, { key: 'draft', kind: 'prompting.storage', method: 'saveDraft',
        args: [{ id: 'draft', apiId: 'openai', name, payload: { temperature: 0.7 } }] });
    await runLabJob(f.context(job));
    return (await readPromptingStorage(f.base, f.account, 'getDraft', ['draft'])).value;
}

test('preset publication recovers its own physical write and does not restore a later deletion', async () => {
    const f = fixture(), draft = await presetDraft(f);
    const job = await acceptLabJob(f.request, { key: 'publish', kind: 'prompting.publish', draftId: draft.id, version: await fingerprint(draft) });
    const filename = path.join(f.base.directories.openAI_Settings, 'Moon preset.json');
    assert.equal(fs.existsSync(filename), false);
    await assert.rejects(runLabJob(f.context(job), { afterPresetPublication: () => { throw new Error('process lost after rename'); } }), /process lost/);
    assert.equal(JSON.parse(fs.readFileSync(filename)).temperature, 0.7);
    assert.equal(readLabRecord(f.base, 'publish').state, 'accepted');
    assert.throws(() => withRoleplayAccount(f.base, f.account, lease => assertNativeMediaTargetIdle(lease,
        { kind: 'preset', id: path.relative(f.base.directories.root, filename) })), /unfinished reviewed Labs change/);
    await runLabJob(f.context(job));
    assert.equal((await readPromptingStorage(f.base, f.account, 'getDraft', ['draft'])).value.publishedAs, 'Moon preset');
    fs.unlinkSync(filename);
    await runLabJob(f.context(job));
    assert.equal(fs.existsSync(filename), false);
});

test('preset publication refuses competing names and keeps edits made to the draft after acceptance', async () => {
    const f = fixture(), draft = await presetDraft(f);
    const input = { kind: 'prompting.publish', draftId: draft.id, version: await fingerprint(draft) };
    const job = await acceptLabJob(f.request, { ...input, key: 'publish' });
    const edit = await acceptLabJob(f.request, { key: 'edit-draft', kind: 'prompting.storage', method: 'saveDraft', args: [{ ...draft, name: 'Later draft', payload: { temperature: 1.2 } }] });
    await runLabJob(f.context(edit));
    await runLabJob(f.context(job));
    assert.equal((await readPromptingStorage(f.base, f.account, 'getDraft', ['draft'])).value.name, 'Later draft');
    assert.equal(readLabRecord(f.base, 'publish').result.draftChanged, true);
    const g = fixture(), other = await presetDraft(g);
    const competing = await acceptLabJob(g.request, { ...input, key: 'publish', version: await fingerprint(other) });
    const filename = path.join(g.base.directories.openAI_Settings, 'MOON PRESET.json');
    fs.writeFileSync(filename, '{"keep":true}');
    await assert.rejects(runLabJob(g.context(competing)), /name is already in use/);
    assert.equal(readLabRecord(g.base, 'publish').state, 'refused');
    assert.equal(fs.readFileSync(filename, 'utf8'), '{"keep":true}');
});

test('native scene prompts resolve saved lore and retain tool exchanges without expanding tool results', async () => {
    const f = fixture(), directories = f.base.directories;
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    fs.writeFileSync(path.join(directories.characters, 'nova.png'), writeCard(png,
        JSON.stringify({ name: 'Nova', description: 'Home: {{lore::Earth}}', chat: 'scene' })));
    const settingsPath = path.join(directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath));
    settings.world_info = { globalSelect: ['Garden'] };
    settings.power_user = { ...settings.power_user, experimental_macro_engine: true };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const presetPath = path.join(directories.openAI_Settings, 'Default.json');
    const preset = JSON.parse(fs.readFileSync(presetPath));
    preset.function_calling = true;
    fs.writeFileSync(presetPath, JSON.stringify(preset));
    const records = fs.readFileSync(f.chatPath, 'utf8').split('\n').map(line => JSON.parse(line));
    records.push({ name: 'Nova', is_system: true, is_user: false, mes: 'A saved tool exchange', extra: {
        api: 'openai', model: 'gpt-4o', tool_invocations: [{ id: 'call-garden', name: 'read_garden', parameters: '{}', result: 'Literal {{char}} result' }],
    } });
    fs.writeFileSync(f.chatPath, records.map(record => JSON.stringify(record)).join('\n'));
    const accepted = await acceptLabJob(f.request, { key: 'tools-and-lore', kind: 'prompting.scene', characterAvatar: 'nova.png',
        connectionProfileId: 'saved', presets: [{ apiId: 'openai', name: 'Default' }], turns: ['Describe home.'] });
    fs.unlinkSync(f.bookPath);
    await runLabJob(f.context(accepted), { generate: async ({ messages }) => {
        assert.match(JSON.stringify(messages), /Home: Earth is blue/);
        assert.equal(messages.find(message => message.role === 'tool')?.content, 'Literal {{char}} result');
        assert.equal(messages.find(message => message.tool_calls)?.tool_calls[0].id, 'call-garden');
        return { text: 'The saved exchange was retained.' };
    } });
    assert.equal(readLabRecord(f.base, 'tools-and-lore').result.columns[0].turns[0].text, 'The saved exchange was retained.');
});

test('damaged permanent Prompting completion evidence refuses reads and new writes without erasing data', async () => {
    const f = fixture();
    const saved = await acceptLabJob(f.request, { key: 'saved', kind: 'prompting.storage', method: 'saveSuite', args: [{ id: 'suite', name: 'Keep me' }] });
    await runLabJob(f.context(saved));
    const directory = roleplayStoreDirectory(f.base);
    const filename = path.join(directory, fs.readdirSync(directory).find(name => name.startsWith('prompting-')));
    const data = JSON.parse(fs.readFileSync(filename));
    data.applied.saved.hash = 'damaged';
    fs.writeFileSync(filename, JSON.stringify(data));
    const damaged = fs.readFileSync(filename, 'utf8');
    await assert.rejects(readPromptingStorage(f.base, f.account, 'listSuites'), /completion record needs recovery/);
    await assert.rejects(acceptLabJob(f.request, { key: 'new', kind: 'prompting.storage', method: 'clearAll', args: [] }), /completion record needs recovery/);
    assert.equal(fs.readFileSync(filename, 'utf8'), damaged);
});

test('scene prompts freeze Mewmory and preserve its live archive while omitting checkpointed old history', async () => {
    const f = fixture(), directories = f.base.directories;
    const png = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));
    fs.writeFileSync(path.join(directories.characters, 'nova.png'), writeCard(png, JSON.stringify({ name: 'Nova', description: 'An astronaut.', chat: 'scene' })));
    const records = JSON.parse('[' + fs.readFileSync(f.chatPath, 'utf8').split('\n').join(',') + ']');
    records.push({ name: 'User', mes: 'OLD PASSAGE: roses grow on the moon.', is_user: true });
    fs.writeFileSync(f.chatPath, records.map(record => JSON.stringify(record)).join('\n'));
    const config = defaultConfig();
    Object.assign(config, { autoUpdate: false, excludeHistory: true, historyWindow: 1, writerTokenizer: 'o200k_base' });
    fs.mkdirSync(path.join(directories.root, 'mewmory'), { recursive: true });
    fs.writeFileSync(path.join(directories.root, 'mewmory', 'config.json'), JSON.stringify(config));
    mutateState(directories, f.body.locator, state => {
        syncSources(state, records.slice(1), readContextSourcesSync(directories, f.body.locator, state,
            { metadata: records[0].chat_metadata, messages: records.slice(1) }));
        state.enabled = true;
        putRecord(state, validateRecord(state, { id: 'event:roses', kind: 'event', text: 'SAVED MEMORY: Nova planted lunar roses.',
            refs: [state.timeline[0]], subjectIds: [] }, { asOf: 0 }));
        for (const ref of state.timeline) state.checkpoints[refKey(ref)] = processingVersion(readConfig(directories));
    });
    const accepted = await acceptLabJob(f.request, { key: 'memory-scene', kind: 'prompting.scene', characterAvatar: 'nova.png',
        connectionProfileId: 'saved', presets: [{ apiId: 'openai', name: 'Default' }], turns: ['Tell me about lunar roses.'] });
    mutateState(directories, f.body.locator, state => { state.enabled = false; state.records[0].text = 'Later edited memory'; });
    const archive = fs.readFileSync(statePath(directories, f.body.locator), 'utf8');
    await runLabJob(f.context(accepted), { generate: async ({ messages }) => {
        assert.match(JSON.stringify(messages), /SAVED MEMORY: Nova planted lunar roses/);
        assert.doesNotMatch(JSON.stringify(messages), /Later edited memory/);
        assert.equal(messages.some(message => message.role === 'user' && message.content.startsWith('OLD PASSAGE')), false);
        return { text: 'A saved memory was used.' };
    } });
    assert.equal(fs.readFileSync(statePath(directories, f.body.locator), 'utf8'), archive);
    assert.equal(readLabRecord(f.base, 'memory-scene').result.columns[0].turns[0].text, 'A saved memory was used.');
});

test('one native scene retains every paid turn and builds later turns from the saved reply', async () => {
    const f = fixture();
    const accepted = await acceptLabJob(f.request, { key: 'scene', kind: 'prompting.scene', characterAvatar: 'nova.png',
        connectionProfileId: 'saved', presets: [{ apiId: 'openai', name: 'Default' }], turns: ['Describe Earth.', 'What grows there?'] });
    fs.unlinkSync(path.join(f.base.directories.characters, 'nova.png'));
    let calls = 0;
    const generate = async options => {
        calls++;
        assert.equal(options.context.owner, f.base.owner);
        assert.match(JSON.stringify(options.messages), /An astronaut/);
        if (calls === 2) assert.match(JSON.stringify(options.messages), /Blue oceans/);
        return { text: calls === 1 ? 'Blue oceans.' : 'Roses.' };
    };
    await runLabJob(f.context(accepted), { generate });
    const saved = readLabRecord(f.base, 'scene');
    assert.deepEqual(saved.result.columns[0].turns.map(turn => turn.text), ['Blue oceans.', 'Roses.']);
    assert.equal(saved.partial.completedRequests, 2);
    await runLabJob(f.context(accepted), { generate });
    assert.equal(calls, 2);
});

test('an unknown scene turn preserves earlier replies and never sends that turn automatically again', async () => {
    const f = fixture();
    const accepted = await acceptLabJob(f.request, { key: 'unknown-scene', kind: 'prompting.scene', characterAvatar: 'nova.png',
        connectionProfileId: 'saved', presets: [{ apiId: 'openai', name: 'Default' }], turns: ['First.', 'Second.', 'Third.'] });
    let calls = 0;
    const generate = options => providerStep(options.jobContext, options.stepNamespace, async () => {
        calls++;
        if (calls === 2) throw new Error('Connection lost after dispatch');
        return { text: 'Saved first reply.' };
    });
    await assert.rejects(runLabJob(f.context(accepted), { generate }), /Connection lost/);
    assert.equal(readLabRecord(f.base, 'unknown-scene').partial.columns[0].turns[0].text, 'Saved first reply.');
    await assert.rejects(runLabJob(f.context(accepted), { generate }), /unknown|interrupted/i);
    assert.equal(calls, 2);
});

test('native prompt suites compile frozen sources, save checked runs, and do not resurrect a deleted run', async () => {
    const f = fixture();
    const settingsPath = path.join(f.base.directories.root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath));
    settings.oai_settings = { ...JSON.parse(fs.readFileSync(new URL('./fixtures/openai-default-preset.json', import.meta.url))), ...settings.oai_settings };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    for (const [method, value] of [['saveCase', { id: 'case', name: 'Nova prompt', pins: { characterAvatar: 'nova.png', connectionProfileId: 'saved' },
        userMessage: 'Describe the garden.', assertions: [] }], ['saveSuite', { id: 'suite', name: 'Native tests', caseIds: ['case'] }]]) {
        const accepted = await acceptLabJob(f.request, { key: method, kind: 'prompting.storage', method, args: [value] });
        await runLabJob(f.context(accepted));
    }
    const suite = await acceptLabJob(f.request, { key: 'suite-run', kind: 'prompting.suite', suiteId: 'suite' });
    fs.unlinkSync(path.join(f.base.directories.characters, 'nova.png'));
    await runLabJob(f.context(suite));
    const result = readLabRecord(f.base, 'suite-run').result;
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].error, null, JSON.stringify(result.runs[0].error));
    assert.match(JSON.stringify(result.runs[0].capture.messages), /An astronaut/);
    assert.match(JSON.stringify(result.runs[0].capture.messages), /Describe the garden/);
    assert.ok(result.runs[0].capture.tokenTable.total > 0);
    assert.match(JSON.stringify(result.runs[0].capture.messages), /<character_description>/);
    assert.equal(result.runs[0].environment.characterName, 'Nova');
    assert.equal(result.runs[0].environment.model, 'gpt-4o');
    assert.equal((await readPromptingStorage(f.base, f.account, 'getRun', [result.runs[0].id])).value.id, result.runs[0].id);
    const remove = await acceptLabJob(f.request, { key: 'delete-run', kind: 'prompting.storage', method: 'deleteRun', args: ['case', result.runs[0].id] });
    await runLabJob(f.context(remove));
    await runLabJob(f.context(suite));
    assert.equal((await readPromptingStorage(f.base, f.account, 'getRun', [result.runs[0].id])).value, null);
});

test('prompt comparisons capture server characters and retain both paid results for replay', async () => {
    const f = fixture();
    const accepted = await acceptLabJob(f.request, { key: 'experiment', kind: 'prompting.requests', operation: 'experiment',
        profileId: 'saved', characterAvatar: 'nova.png', promptA: 'Be precise.', promptB: 'Be brief.', scenario: 'Describe Earth.' });
    fs.unlinkSync(path.join(f.base.directories.characters, 'nova.png'));
    let calls = 0;
    const generate = async options => {
        calls++;
        assert.match(options.messages[1].content, /An astronaut/);
        return { text: options.messages[0].content };
    };
    await runLabJob(f.context(accepted), { generate });
    assert.deepEqual(readLabRecord(f.base, 'experiment').result.map(reply => reply.text), ['Be precise.', 'Be brief.']);
    await runLabJob(f.context(accepted), { generate });
    assert.equal(calls, 2);
});

test('Prompting Lab storage publishes once after a lost acknowledgement and never restores deleted records', async () => {
    const f = fixture();
    const save = await acceptLabJob(f.request, { key: 'save-suite', kind: 'prompting.storage', method: 'saveSuite', args: [{ id: 'suite', name: 'Moon tests' }] });
    await assert.rejects(runLabJob(f.context(save), { beforeStoragePublish: () => { throw new Error('lost after publication'); } }), /lost after publication/);
    assert.equal((await readPromptingStorage(f.base, f.account, 'getSuite', ['suite'])).value.name, 'Moon tests');
    await runLabJob(f.context(save));
    const remove = await acceptLabJob(f.request, { key: 'delete-suite', kind: 'prompting.storage', method: 'deleteSuite', args: ['suite'] });
    await runLabJob(f.context(remove));
    await runLabJob(f.context(save));
    assert.equal((await readPromptingStorage(f.base, f.account, 'getSuite', ['suite'])).value, null);
});

test('Prompting Lab storage refuses concurrent stale writes and retains legacy input on conflict', async () => {
    const f = fixture();
    const input = { kind: 'prompting.storage', method: 'saveSuite', args: [{ id: 'suite', name: 'First' }] };
    const first = await acceptLabJob(f.request, { ...input, key: 'first' });
    const stale = await acceptLabJob(f.request, { ...input, key: 'stale', args: [{ id: 'suite', name: 'Stale' }] });
    await runLabJob(f.context(first));
    await assert.rejects(runLabJob(f.context(stale)), /changed after/);
    assert.equal(readLabRecord(f.base, 'stale').state, 'refused');
    const legacy = await acceptLabJob(f.request, { key: 'legacy', kind: 'prompting.storage', method: 'importLegacy',
        args: [[['suite:suite', { id: 'suite', name: 'Legacy' }]]] });
    await assert.rejects(runLabJob(f.context(legacy)), /browser copy was retained/);
    assert.equal((await readPromptingStorage(f.base, f.account, 'getSuite', ['suite'])).value.name, 'First');
});

test('saved scan tests use retained server evidence, reviewed metadata writes and frozen native replay batches', async () => {
    const f = fixture();
    const scan = await acceptLabJob(f.request, { key: 'scan', kind: 'world-info.scan', book: 'Garden', mode: 'text', text: 'Earth' });
    await runLabJob(f.context(scan));
    const record = readLabRecord(f.base, 'scan');
    const input = { key: 'save-test', kind: 'world-info.case', operation: 'save', book: 'Garden', name: 'Earth test',
        scanKey: record.key, scanHash: record.resultHash, confirmReplayStorage: true };
    await assert.rejects(acceptLabJob(f.request, { ...input, key: 'forged', scanHash: 'forged' }), /missing or changed/);
    const proposal = await acceptLabJob(f.request, input);
    await runLabJob(f.context(proposal));
    const proposed = readLabRecord(f.base, 'save-test');
    assert.equal(storedCases(JSON.parse(fs.readFileSync(f.bookPath))).length, 0);
    const apply = await acceptLabJob(f.request, { key: 'save-test-apply', kind: 'apply', proposalKey: proposed.key, resultHash: proposed.resultHash });
    await runLabJob(f.context(apply));
    const listed = listWorldInfoCases(f.base, f.account);
    assert.equal(listed.cases.length, 1);
    const reference = { id: listed.cases[0].id, book: 'Garden' };
    const replay = await acceptLabJob(f.request, { key: 'replay', kind: 'world-info.tests', cases: [reference] });
    const changed = JSON.parse(fs.readFileSync(f.bookPath));
    changed.entries[3].content = 'Edited after test acceptance';
    fs.writeFileSync(f.bookPath, JSON.stringify(changed));
    await runLabJob(f.context(replay));
    assert.equal(readLabRecord(f.base, 'replay').result.passed, true);
    const fresh = await acceptLabJob(f.request, { key: 'changed-replay', kind: 'world-info.tests', cases: [reference] });
    await runLabJob(f.context(fresh));
    assert.equal(readLabRecord(f.base, 'changed-replay').result.passed, false);
    const deletion = await acceptLabJob(f.request, { key: 'delete-test', kind: 'world-info.case', operation: 'delete', ...reference });
    await runLabJob(f.context(deletion));
    assert.equal(listWorldInfoCases(f.base, f.account).cases.length, 1);
    const deletionRecord = readLabRecord(f.base, 'delete-test');
    const deleteApply = await acceptLabJob(f.request, { key: 'delete-apply', kind: 'apply', proposalKey: deletionRecord.key, resultHash: deletionRecord.resultHash });
    await runLabJob(f.context(deleteApply));
    assert.equal(listWorldInfoCases(f.base, f.account).cases.length, 0);
    await assert.rejects(acceptLabJob(f.request, { key: 'repeat-delete', kind: 'apply', proposalKey: deletionRecord.key, resultHash: deletionRecord.resultHash }), /already been applied/);
});

test('distillation freezes saved chat, retains proposals after pruning, and never edits the book', async () => {
    const f = fixture();
    const before = fs.readFileSync(f.bookPath, 'utf8');
    const accepted = await acceptLabJob(f.request, f.body);
    fs.writeFileSync(f.chatPath, 'later chat edits');
    let calls = 0;
    await runLabJob(f.context(accepted), { generate: async options => {
        calls++;
        assert.match(options.messages[0].content, /moon garden grows roses/);
        return generate();
    } });
    assert.equal(fs.readFileSync(f.bookPath, 'utf8'), before);
    const result = readLabRecord(f.base, f.body.key);
    assert.equal(result.result.proposals.length, 2);
    fs.rmSync(path.join(f.base.directories.root, 'jobs'), { recursive: true, force: true });
    const duplicate = await acceptLabJob(f.request, f.body);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job, null);
    assert.deepEqual(duplicate.record.result, result.result);
    assert.equal(calls, 1);
});

test('reviewed subsets append once and allow the remaining subset without discarding old entries', async () => {
    const f = fixture();
    const record = await ready(f);
    const first = await acceptLabJob(f.request, applyBody(record));
    await runLabJob(f.context(first));
    await runLabJob(f.context(first));
    const second = await acceptLabJob(f.request, applyBody(record, [1], 'apply-two'));
    await runLabJob(f.context(second));
    const book = JSON.parse(fs.readFileSync(f.bookPath));
    assert.equal(Object.keys(book.entries).length, 3);
    assert.equal(book.entries[3].content, 'Earth is blue.');
    assert.deepEqual(readLabRecord(f.base, record.key).review.usedIds, [0, 1]);
    await assert.rejects(acceptLabJob(f.request, applyBody(record, [0], 'apply-again')), /already been added/);
});

test('a concurrent lorebook edit refuses reviewed apply and keeps both old and proposed content', async () => {
    const f = fixture();
    const record = await ready(f);
    const accepted = await acceptLabJob(f.request, applyBody(record));
    fs.writeFileSync(f.bookPath, JSON.stringify({ entries: { 3: { uid: 3, content: 'A newer edit.' } } }));
    await assert.rejects(runLabJob(f.context(accepted)), /changed while.*reviewed/);
    assert.equal(JSON.parse(fs.readFileSync(f.bookPath)).entries[3].content, 'A newer edit.');
    assert.equal(readLabRecord(f.base, 'apply-one').state, 'refused');
    assert.equal(readLabRecord(f.base, record.key).result.proposals.length, 2);
});

test('a crash after book publication reconciles the physical write and does not append twice', async () => {
    const f = fixture();
    const record = await ready(f);
    const accepted = await acceptLabJob(f.request, applyBody(record));
    await assert.rejects(runLabJob(f.context(accepted), { afterPublication: name => { if (name === 'book') throw new Error('process died'); } }), /process died/);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.bookPath)).entries).length, 2);
    assert.throws(() => withRoleplayAccount(f.base, f.account, lease => assertNativeMediaTargetIdle(lease, { kind: 'world-info', id: 'Garden' })), /unfinished reviewed/);
    await runLabJob(f.context(accepted));
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.bookPath)).entries).length, 2);
    withRoleplayAccount(f.base, f.account, lease => assertNativeMediaTargetIdle(lease, { kind: 'world-info', id: 'Garden' }));
    fs.unlinkSync(f.bookPath);
    await runLabJob(f.context(accepted));
    assert.equal(fs.existsSync(f.bookPath), false, 'completed work must not resurrect a deleted book');
});

test('an unknown paid result is not dispatched again by recovery', async () => {
    const f = fixture();
    const accepted = await acceptLabJob(f.request, f.body);
    const context = f.context(accepted);
    let calls = 0;
    const unknown = () => providerStep(context, 'test-provider', async () => { calls++; throw new Error('connection lost'); });
    await assert.rejects(runLabJob(context, { generate: unknown }), /connection lost/);
    await assert.rejects(runLabJob(context, { generate: unknown }), /unknown/);
    assert.equal(calls, 1);
});

test('paused acceptance recovers its preparing record without reconstructing source data', async () => {
    const f = fixture();
    const accepted = admitLabJob(f.base, f.account, { key: 'prepare', kind: 'distill', input: {}, plan: { frozen: true }, label: 'Test' });
    const directory = path.join(roleplayStoreDirectory(f.base), 'labs');
    const filename = path.join(directory, fs.readdirSync(directory)[0]);
    const record = JSON.parse(fs.readFileSync(filename));
    record.state = 'preparing'; record.jobId = null;
    fs.writeFileSync(filename, JSON.stringify(record));
    finalizeLabSubmission({ ...f.base, job: accepted.job });
    assert.equal(readLabRecord(f.base, 'prepare').jobId, accepted.job.id);
    assert.equal(getJob(f.base.directories, accepted.job.id).state, 'queued');
});

test('account ownership and changed submission keys are enforced', async () => {
    const alice = fixture('alice');
    const bob = fixture('bob');
    const a = await ready(alice);
    const b = await ready(bob);
    assert.notEqual(a.jobId, b.jobId);
    await assert.rejects(acceptLabJob({ ...alice.request, get: () => 'bob' }, alice.body), /account changed/);
    await assert.rejects(acceptLabJob(alice.request, { ...alice.body, book: 'Other' }), /different Labs work/);
});

test('capacity refuses the next operation and retains every existing receipt', () => {
    const f = fixture();
    for (let index = 0; index < LAB_STORE_LIMIT / LAB_RECORD_LIMIT; index++) {
        admitLabJob(f.base, f.account, { key: `capacity-${index}`, kind: 'distill', input: {}, plan: { frozen: true }, label: 'Test' });
    }
    assert.throws(() => admitLabJob(f.base, f.account, { key: 'full', kind: 'distill', input: {}, plan: { frozen: true }, label: 'Test' }), /no room/);
    assert.ok(readLabRecord(f.base, 'capacity-0'));
});

test('LoreStitch computes a retained preview on the server without changing the source', async () => {
    const f = fixture();
    const book = JSON.parse(fs.readFileSync(f.bookPath));
    const accepted = await acceptLabJob(f.request, { key: 'replace', kind: 'lorestitch', book: 'Garden', revision: worldInfoRevision(book),
        operation: 'replace', options: { search: 'blue', replacement: 'green', fields: ['content'] } });
    await runLabJob(f.context(accepted));
    const record = readLabRecord(f.base, 'replace');
    assert.equal(record.result.book.entries[3].content, 'Earth is green.');
    assert.equal(JSON.parse(fs.readFileSync(f.bookPath)).entries[3].content, 'Earth is blue.');
    const apply = await acceptLabJob(f.request, { key: 'apply-replace', kind: 'apply', proposalKey: record.key, resultHash: record.resultHash });
    await runLabJob(f.context(apply));
    assert.equal(JSON.parse(fs.readFileSync(f.bookPath)).entries[3].content, 'Earth is green.');
});

test('native lorebook scan and health checks retain server-derived results without a browser', async () => {
    const f = fixture();
    const settings = JSON.parse(fs.readFileSync(path.join(f.base.directories.root, 'settings.json')));
    settings.world_info = { globalSelect: [] };
    settings.world_info_settings = { world_info: { globalSelect: ['Garden'] } };
    fs.writeFileSync(path.join(f.base.directories.root, 'settings.json'), JSON.stringify(settings));
    for (const kind of ['scan', 'health']) {
        const accepted = await acceptLabJob(f.request, { key: kind, kind: `world-info.${kind}`, mode: 'text', text: 'Earth' });
        await runLabJob(f.context(accepted));
    }
    const scan = readLabRecord(f.base, 'scan').result;
    assert.equal(scan.activated.length, 1);
    assert.equal(scan.activated[0].world, 'Garden');
    assert.ok(scan.budget.used > 0);
    assert.equal(readLabRecord(f.base, 'health').result.entryCount, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.bookPath)).entries[3].content, 'Earth is blue.');
});

test('native batch previews reject stale inputs and apply only their retained proposal', async () => {
    const f = fixture();
    await assert.rejects(acceptLabJob(f.request, { key: 'stale', kind: 'world-info.batch', book: 'Garden', expectedBook: { entries: {} } }), /changed/);
    const accepted = await acceptLabJob(f.request, { key: 'batch', kind: 'world-info.batch', book: 'Garden', operation: 'set-field', field: 'probability', value: 42 });
    await runLabJob(f.context(accepted));
    const record = readLabRecord(f.base, 'batch');
    assert.equal(record.result.changes.length, 1);
    assert.equal(record.result.book.entries[3].probability, 42);
    assert.equal(JSON.parse(fs.readFileSync(f.bookPath)).entries[3].probability, undefined);
    const apply = await acceptLabJob(f.request, { key: 'apply-batch', kind: 'apply', proposalKey: record.key, resultHash: record.resultHash });
    await runLabJob(f.context(apply));
    assert.equal(JSON.parse(fs.readFileSync(f.bookPath)).entries[3].probability, 42);
});

test('a long saved chat with many swipes still scans its lorebooks in the World Info Lab', async () => {
    const f = fixture();
    const filler = 'x'.repeat(2048), swipe = 'y'.repeat(3072);
    const messages = Array.from({ length: 1600 }, (_, index) => ({ name: index % 2 ? 'Nova' : 'User', is_user: index % 2 === 0,
        mes: `${index === 1599 ? 'We can see the earth. ' : ''}${filler}`, swipes: [swipe, swipe], swipe_id: 0 }));
    fs.writeFileSync(f.chatPath, [{ user_name: 'User', character_name: 'Nova', chat_metadata: {} }, ...messages]
        .map(row => JSON.stringify(row)).join('\n'));
    assert.ok(fs.statSync(f.chatPath).size > 8 * 1024 * 1024);
    const locator = { group: false, avatar: 'nova.png', chat: 'scene' };
    const scan = await acceptLabJob(f.request, { key: 'long-scan', kind: 'world-info.scan', book: 'Garden', mode: 'chat', locator });
    await runLabJob(f.context(scan));
    const record = readLabRecord(f.base, 'long-scan');
    assert.deepEqual(record.result.activated.map(entry => entry.uid), [3]);
    const health = await acceptLabJob(f.request, { key: 'long-health', kind: 'world-info.health', book: 'Garden', mode: 'chat', locator });
    await runLabJob(f.context(health));
    assert.equal(readLabRecord(f.base, 'long-health').result.chatMessageCount, 1600);
});
