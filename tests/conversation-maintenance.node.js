import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { SETTINGS_FILE, CONVERSATION_STORE_KEY } = await import('../src/constants.js').then(async constants => ({
    ...constants, CONVERSATION_STORE_KEY: 'sillybunny_conversation',
}));
const { acceptConversationSchedule, acceptConversationSummary, registerConversationMaintenanceJobs } = await import('../src/generation/conversation-maintenance.js');
const { commitConversationStoreEffect } = await import('../src/generation/conversation-effects.js');
const { getJob, listJobs } = await import('../src/jobs/store.js');
const { runChatProfile } = await import('../src/generation/service.js');
const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');

after(() => cancelAutoSaves());

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-maintenance-'));
    for (const name of ['characters', 'groups', 'userImages']) fs.mkdirSync(path.join(root, name), { recursive: true });
    return { root, characters: path.join(root, 'characters'), groups: path.join(root, 'groups'), userImages: path.join(root, 'userImages') };
}

function writeSettings(directories) {
    fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify({
        _version: 0,
        extension_settings: {
            connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] },
            [CONVERSATION_STORE_KEY]: {
                version: 1,
                settings: { connection_profile: 'saved' },
                characters: {
                    'nova.png': {
                        settings: {}, activeBranchId: 'main',
                        branches: {
                            main: {
                                id: 'main', name: 'Main', createdAt: 1,
                                messages: [
                                    { id: 'm1', role: 'user', name: 'User', mes: 'hi' },
                                    { id: 'm2', role: 'character', name: 'Nova', mes: 'hello there' },
                                    { id: 'm3', role: 'user', name: 'User', mes: 'how are you' },
                                ],
                            },
                        },
                    },
                },
                groups: [], reminders: [], legacyThreadPersonaAssignments: {},
            },
        },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    return JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8'));
}

function readBranch(directories) {
    return JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8'))
        .extension_settings[CONVERSATION_STORE_KEY].characters['nova.png'];
}

test('a forced summary runs natively and is saved once with its cursor', async () => {
    const directories = makeDirectories();
    writeSettings(directories);
    const request = { user: { profile: { handle: 'tester' }, directories } };
    setDirectoriesResolver(() => directories);
    registerConversationMaintenanceJobs({ generate: async () => ({ text: '- Nova and the user are friendly.' }) });

    const accepted = await acceptConversationSummary(request, { submissionKey: 'summary-1', force: true, target: { avatar: 'nova.png', branchId: 'main' } }, { automatic: false });
    assert.equal(accepted.created, true);
    await runJob(getJob(directories, accepted.job.id));
    const character = readBranch(directories);
    assert.equal(character.branches.main.memorySummary, '- Nova and the user are friendly.');
    assert.equal(character.branches.main.memorySummaryThrough, 'm3');
    assert.equal(character.branches.main.memoryMessageCount, 3);
    assert.equal(character.memorySummary, '- Nova and the user are friendly.');
    assert.equal(character.memorySummaryThrough, 'm3');
    assert.equal(character.memoryMessageCount, 3);
    assert.equal(typeof character.memoryUpdatedAt, 'number');

    const duplicate = await acceptConversationSummary(request, { submissionKey: 'summary-1', force: true, target: { avatar: 'nova.png', branchId: 'main' } });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, accepted.job.id);
});

test('a schedule runs natively and replaces the character schedule', async () => {
    const directories = makeDirectories();
    writeSettings(directories);
    const request = { user: { profile: { handle: 'tester' }, directories } };
    setDirectoriesResolver(() => directories);
    const schedule = { talkativeness: 40, inactivityThresholdMinutes: 90, generatedAt: 123, days: { 0: [{ time: '08:00-12:00', activity: 'working', status: 'dnd' }] } };
    registerConversationMaintenanceJobs({ generate: async () => ({ text: JSON.stringify(schedule) }) });

    const accepted = await acceptConversationSchedule(request, { submissionKey: 'schedule-1', target: { avatar: 'nova.png', branchId: 'main' } });
    assert.equal(accepted.created, true);
    await runJob(getJob(directories, accepted.job.id));
    const finished = getJob(directories, accepted.job.id);
    assert.equal(finished.state, 'completed', JSON.stringify(finished.error));
    const saved = JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8'));
    assert.deepEqual(readBranch(directories).schedule.days['0'][0], schedule.days['0'][0]);
    assert.equal(readBranch(directories).schedule.talkativeness, 40);
    const character = readBranch(directories);
    const autoSchedule = JSON.parse(character.settings.auto_schedule);
    assert.equal(autoSchedule.talkativeness, 40);
    assert.equal(autoSchedule.days['0'][0].status, 'dnd');
    assert.equal(typeof autoSchedule.generatedAt, 'number');
    assert.equal(character.settings.inactivity_threshold, 90);
    assert.equal(saved.extension_settings[CONVERSATION_STORE_KEY].settings.auto_schedule, undefined);
});

test('a store effect is applied once and remembered across retries', async () => {
    const directories = makeDirectories();
    writeSettings(directories);
    const request = { user: { profile: { handle: 'tester' }, directories } };
    setDirectoriesResolver(() => directories);
    registerConversationMaintenanceJobs({ generate: async () => ({ text: '{}' }) });
    const accepted = await acceptConversationSchedule(request, { submissionKey: 'schedule-effect', target: { avatar: 'nova.png', branchId: 'main' } });
    assert.equal(accepted.created, true);
    const context = { directories, owner: 'tester', job: { id: accepted.job.id } };
    let calls = 0;
    const apply = () => commitConversationStoreEffect(context, 'unit-effect', store => {
        calls += 1;
        store.settings = { ...(store.settings || {}), unit_marker: calls };
        return { calls };
    });
    assert.deepEqual(await apply(), { calls: 1 });
    assert.deepEqual(await apply(), { calls: 1 });
    assert.equal(calls, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8'));
    assert.equal(saved.extension_settings[CONVERSATION_STORE_KEY].settings.unit_marker, 1);
});

for (const kind of ['summary', 'schedule']) {
    test(`native ${kind} validates only its actual active text prompt before acceptance`, async t => {
        const directories = makeDirectories();
        t.after(() => fs.rmSync(directories.root, { recursive: true, force: true }));
        const settings = writeSettings(directories);
        Object.assign(settings, { _settingsRevision: 7, main_api: 'textgenerationwebui', max_context: 8192,
            active_generation: { api: 'textgenerationwebui', source: 'llamacpp', model: '', serverUrl: 'http://127.0.0.1:6000' },
            textgenerationwebui_settings: { type: 'llamacpp' },
            power_user: { experimental_macro_engine: true, instruct: { enabled: true, macro: true,
                input_sequence: '[USER]', output_sequence: '<assistant>', output_suffix: '{{isMobile}}', sequences_as_stop_strings: false } } });
        settings.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = '';
        fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify(settings));
        const request = { user: { profile: { handle: 'tester' }, directories } };
        const body = { submissionKey: `actual-text-${kind}`, force: true, target: { avatar: 'nova.png', branchId: 'main' },
            acknowledgement: { account: 'tester', settingsRevision: 7 } };
        const accept = kind === 'summary' ? acceptConversationSummary : acceptConversationSchedule;
        let calls = 0;
        setDirectoriesResolver(() => directories);
        registerConversationMaintenanceJobs({ generate: options => runChatProfile({ ...options, fetch: async (_url, init) => {
            calls++;
            assert.match(JSON.parse(init.body).prompt, /\[USER\]/);
            return new Response(JSON.stringify({ choices: [{ text: kind === 'summary' ? '- A useful summary.' : JSON.stringify({
                talkativeness: 40, inactivityThresholdMinutes: 90, days: { 0: [{ time: '08:00-12:00', activity: 'working', status: 'dnd' }] },
            }) }] }));
        } }) });
        const accepted = await accept(request, body);
        await runJob(getJob(directories, accepted.job.id));
        assert.equal(getJob(directories, accepted.job.id).state, 'completed');
        assert.equal(calls, 1);
        const changed = JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8'));
        changed.power_user.instruct.input_sequence = '{{isMobile}}';
        fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify(changed));
        const before = listJobs(directories, { owner: 'tester', includeDismissed: true }).length;
        await assert.rejects(accept(request, { ...body, submissionKey: `invalid-text-${kind}` }), /capability|available/i);
        assert.equal(listJobs(directories, { owner: 'tester', includeDismissed: true }).length, before);
        assert.equal(calls, 1);
    });

    test(`native ${kind} captures acknowledged active settings and retains exact replay identity`, async t => {
        const directories = makeDirectories();
        t.after(() => fs.rmSync(directories.root, { recursive: true, force: true }));
        const settings = writeSettings(directories);
        Object.assign(settings, { _settingsRevision: 7, name1: 'Captured user', main_api: 'openai',
            active_generation: { api: 'openai', source: 'custom', model: 'active-model' },
            oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:6000', custom_model: 'active-model' } });
        settings.extension_settings[CONVERSATION_STORE_KEY].settings.connection_profile = '';
        fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify(settings));
        const request = { user: { profile: { handle: 'tester' }, directories } };
        const body = { submissionKey: `active-${kind}`, force: true, target: { avatar: 'nova.png', branchId: 'main' },
            acknowledgement: { account: 'tester', settingsRevision: 7 } };
        const accept = kind === 'summary' ? acceptConversationSummary : acceptConversationSchedule;
        await assert.rejects(accept(request, { ...body, acknowledgement: undefined }), error => error.apiError === 'active_settings_ack_required');
        let calls = 0;
        setDirectoriesResolver(() => directories);
        registerConversationMaintenanceJobs({ generate: async options => {
            calls++;
            assert.equal(options.binding.kind, 'active');
            assert.equal(options.userName, 'Captured user');
            assert.ok(options.rawOptions.systemPrompt);
            assert.equal(options.messages.some(message => message.role === 'system'), false);
            assert.equal(options.macroEnvironment.evaluate('{{user}}'), 'Captured user');
            assert.equal(options.macroEnvironment.extra.chat[0].is_user, true);
            return { text: kind === 'summary' ? '- A captured summary.' : JSON.stringify({ talkativeness: 40,
                inactivityThresholdMinutes: 90, days: { 0: [{ time: '08:00-12:00', activity: 'working', status: 'dnd' }] } }) };
        } });
        const accepted = await accept(request, body);
        await runJob(getJob(directories, accepted.job.id));
        assert.equal(getJob(directories, accepted.job.id).state, 'completed');
        const changed = JSON.parse(fs.readFileSync(path.join(directories.root, SETTINGS_FILE), 'utf8'));
        changed.main_api = 'unsupported';
        fs.writeFileSync(path.join(directories.root, SETTINGS_FILE), JSON.stringify(changed));
        assert.equal((await accept(request, body)).job.id, accepted.job.id);
        await assert.rejects(accept(request, { ...body, acknowledgement: { ...body.acknowledgement, settingsRevision: 8 } }), /submission key/i);
        for (const anchors of [{ branchCreatedAt: 'replacement' }, { triggers: [{ messageId: 'source', revision: 'changed' }] },
            { replyTarget: { messageId: 'target', revision: 'changed' } }]) {
            await assert.rejects(accept(request, { ...body, ...anchors }), /submission key/i);
        }
        assert.equal(calls, 1);
    });
}
