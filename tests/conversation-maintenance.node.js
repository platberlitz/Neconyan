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
const { getJob } = await import('../src/jobs/store.js');
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
