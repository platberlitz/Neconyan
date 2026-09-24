/* eslint playwright/expect-expect: off -- Node assertions exercise protected hook policy. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { assertRoleplayWorldInfoCurrent, captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { runRoleplayReplyJob } = await import('../src/generation/roleplay-execution.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { getJob, releaseJob } = await import('../src/jobs/store.js');

const controls = { prompts: [{ identifier: 'main', role: 'system', system_prompt: true, content: '' },
    { identifier: 'chatHistory', marker: true, system_prompt: true }], prompt_order: [{ character_id: 100001,
    order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }] };

function prepared(t, { automationId = undefined, extension_settings = {}, quickReplySet,
    extraQuickReplySets = [], malformedUnlinked = false } = {}) {
    const f = fixture(t);
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    f.scope.directories.worlds = path.join(f.scope.directories.root, 'worlds');
    fs.mkdirSync(f.scope.directories.worlds);
    fs.writeFileSync(path.join(f.scope.directories.worlds, 'Town.json'), JSON.stringify({ entries: {
        1: { uid: 1, key: ['Original'], content: 'Safe harbour', position: 0,
            ...(automationId ? { automationId } : {}) },
    } }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        world_info_settings: { world_info: { globalSelect: ['Town'] }, world_info_budget: 100 }, extension_settings,
    }));
    if (quickReplySet || extraQuickReplySets.length || malformedUnlinked) {
        f.scope.directories.quickreplies = path.join(f.scope.directories.root, 'QuickReplies');
        fs.mkdirSync(f.scope.directories.quickreplies);
        if (quickReplySet) fs.writeFileSync(path.join(f.scope.directories.quickreplies, 'Actions.json'), JSON.stringify(quickReplySet));
        for (const set of extraQuickReplySets) {
            fs.writeFileSync(path.join(f.scope.directories.quickreplies, `${set.name}.json`), JSON.stringify(set));
        }
        if (malformedUnlinked) fs.writeFileSync(path.join(f.scope.directories.quickreplies, 'Broken.json'), '{unfinished');
    }
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const worldInfo = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'hook-policy', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, maxTokens: 32, characterName: 'Nova', worldInfo,
            historyStart: 0, messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }] } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    return { f, account, source, worldInfo, jobId, context };
}

test('disabled Quick Reply does not block activated lore; enabled linked actions save exact hashes then refuse', async t => {
    const disabled = prepared(t, { automationId: 'qr-one' });
    assert.equal(disabled.worldInfo.hookPolicy.quickReply.enabled, false);
    let calls = 0;
    await runRoleplayReplyJob(disabled.context, { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls }),
        generate: async ({ beforeDispatch }) => { beforeDispatch(); calls++; return { text: 'Safe' }; } });
    assert.equal(calls, 1);
    assert.equal(readRoleplayChat(disabled.f.scope, disabled.f.locator).records.at(-1).mes, 'Safe');

    const matched = prepared(t, { automationId: 'qr-one', extension_settings: { quickReplyV2: {
        isEnabled: true, config: { setList: [{ set: 'Actions' }] },
    } }, quickReplySet: {
        version: 2, name: 'Actions', qrList: [{ id: 7, automationId: 'qr-one', message: '/setvar secret=1' }],
    } });
    calls = 0;
    await assert.rejects(runRoleplayReplyJob(matched.context, { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls }),
        generate: async () => { calls++; return { text: 'Wrong' }; } }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(calls, 0);
    assert.deepEqual(readArtifact(matched.f.scope.directories, matched.jobId, 'roleplay-world-info')
        .hookEvents.actions.map(action => [action.kind, action.set, action.id, action.automationId]),
    [['quick-reply', 'Actions', 7, 'qr-one']]);
    assert.equal(JSON.stringify(readArtifact(matched.f.scope.directories, matched.jobId, 'roleplay-world-info'))
        .includes('/setvar secret=1'), false);
    fs.writeFileSync(path.join(matched.f.scope.directories.quickreplies, 'Actions.json'), JSON.stringify({
        version: 2, name: 'Actions', qrList: [{ id: 7, automationId: 'qr-one', message: '/setvar secret=2' }],
    }));
    assert.throws(() => assertRoleplayWorldInfoCurrent(matched.f.scope, matched.worldInfo),
        { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('enabled Quick Reply with no linked matching action keeps ordinary lore generation available', async t => {
    const f = prepared(t, { automationId: 'qr-one', extension_settings: { quickReplyV2: {
        isEnabled: true, config: { setList: [{ set: 'Actions' }] },
    } }, quickReplySet: { version: 2, name: 'Actions',
        qrList: [{ id: 7, automationId: 'another', message: '/setvar secret=1' }] } });
    let calls = 0;
    await runRoleplayReplyJob(f.context, { contextLimit: () => 4096,
        promptBackend: () => ({ backend: 'chat', active: controls }),
        generate: async ({ beforeDispatch }) => { beforeDispatch(); calls++; return { text: 'Available' }; } });
    assert.equal(calls, 1);
    assert.deepEqual(readArtifact(f.f.scope.directories, f.jobId, 'roleplay-world-info').hookEvents.actions, []);
});

test('Quick Reply hook actions retain the saved link order rather than the preset filename order', async t => {
    const f = prepared(t, { automationId: 'qr-one', extension_settings: { quickReplyV2: {
        isEnabled: true, config: { setList: [{ set: 'Zoo' }, { set: 'Actions' }] },
    } }, quickReplySet: { version: 2, name: 'Actions', qrList: [{ id: 2, automationId: 'qr-one', message: '/second' }] },
    extraQuickReplySets: [{ version: 2, name: 'Zoo', qrList: [{ id: 1, automationId: 'qr-one', message: '/first' }] }] });
    await assert.rejects(runRoleplayReplyJob(f.context, { contextLimit: () => 4096,
        generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_INVALID' });
    assert.deepEqual(readArtifact(f.f.scope.directories, f.jobId, 'roleplay-world-info').hookEvents.actions
        .map(action => action.set), ['Zoo', 'Actions']);
});

test('malformed unrelated Quick Reply presets do not block linked saved actions', async t => {
    const f = prepared(t, { automationId: 'qr-one', extension_settings: { quickReplyV2: {
        isEnabled: true, config: { setList: [{ set: 'Actions' }] },
    } }, quickReplySet: { version: 2, name: 'Actions', qrList: [{ id: 2, automationId: 'qr-one', message: '/linked' }] },
    malformedUnlinked: true });
    await assert.rejects(runRoleplayReplyJob(f.context, { contextLimit: () => 4096,
        generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_INVALID' });
    assert.deepEqual(readArtifact(f.f.scope.directories, f.jobId, 'roleplay-world-info').hookEvents.actions
        .map(action => action.set), ['Actions']);
    assert.doesNotThrow(() => assertRoleplayWorldInfoCurrent(f.f.scope, f.worldInfo));
});

test('disabled extension aliases and linked Quick Reply file aliases cannot cross protected hook authority', t => {
    const disabled = prepared(t, { automationId: 'qr-one', extension_settings: {
        disabledExtensions: ['third-party/quick-reply'], quickReplyV2: {
            isEnabled: true, config: { setList: [{ set: 'Actions' }] },
        },
    }, quickReplySet: { version: 2, name: 'Actions',
        qrList: [{ id: 7, automationId: 'qr-one', message: '/setvar secret=1' }] } });
    assert.equal(disabled.worldInfo.hookPolicy.quickReply.enabled, false);
    const linked = prepared(t, { automationId: 'qr-one', extension_settings: { quickReplyV2: {
        isEnabled: true, config: { setList: [{ set: 'Actions' }] },
    } } });
    linked.f.scope.directories.quickreplies = path.join(linked.f.scope.directories.root, 'QuickReplies');
    fs.mkdirSync(linked.f.scope.directories.quickreplies);
    fs.symlinkSync(path.join(disabled.f.scope.directories.quickreplies, 'Actions.json'),
        path.join(linked.f.scope.directories.quickreplies, 'Actions.json'));
    assert.throws(() => captureRoleplayWorldInfo(linked.f.scope, linked.account, linked.source,
        { avatar: 'Nova.png', maxContext: 200 }), { code: 'ROLEPLAY_STORE_DAMAGED' });
});

test('enabled Pathfinder sidecar retrieval is bound and refuses before scanning or provider work', async t => {
    const f = fixture(t);
    f.scope.directories.inChatAgents = path.join(f.scope.directories.root, 'InChatAgents');
    fs.mkdirSync(f.scope.directories.inChatAgents);
    fs.writeFileSync(path.join(f.scope.directories.inChatAgents, 'pathfinder.json'), JSON.stringify({
        id: 'pathfinder', category: 'tool', name: 'Pathfinder', enabled: true,
        settings: { sidecarEnabled: true },
    }));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        extension_settings: { inChatAgents: { globalSettings: { enabled: true, pathfinderEnabled: true } } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = captureRoleplaySource(f.scope, { locator: f.locator });
    const snapshot = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    assert.equal(snapshot.hookPolicy.pathfinder[0].id, 'pathfinder');
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'pathfinder', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, maxTokens: 32, characterName: 'Nova',
            worldInfo: snapshot, messages: [] } });
    releaseJob(f.scope.directories, jobId);
    const context = { job: getJob(f.scope.directories, jobId), directories: f.scope.directories,
        owner: f.scope.owner, signal: new AbortController().signal };
    await assert.rejects(runRoleplayReplyJob(context, { contextLimit: () => 4096,
        generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'), undefined);
    fs.writeFileSync(path.join(f.scope.directories.inChatAgents, 'pathfinder.json'), JSON.stringify({
        id: 'pathfinder', category: 'tool', name: 'Pathfinder', enabled: false,
        settings: { sidecarEnabled: true },
    }));
    assert.throws(() => assertRoleplayWorldInfoCurrent(f.scope, snapshot), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a Pathfinder agent enabled after admission invalidates the accepted hook policy', async t => {
    const f = fixture(t);
    f.scope.directories.inChatAgents = path.join(f.scope.directories.root, 'InChatAgents');
    fs.mkdirSync(f.scope.directories.inChatAgents);
    const filename = path.join(f.scope.directories.inChatAgents, 'pathfinder.json');
    const record = { id: 'pathfinder', category: 'tool', name: 'Pathfinder', enabled: false,
        settings: { sidecarEnabled: true } };
    fs.writeFileSync(filename, JSON.stringify(record));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 200 });
    assert.deepEqual(snapshot.hookPolicy.pathfinder, []);
    record.enabled = true;
    fs.writeFileSync(filename, JSON.stringify(record));
    assert.throws(() => assertRoleplayWorldInfoCurrent(f.scope, snapshot), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('a non-tool Pathfinder name does not claim a browser tool hook', t => {
    const f = fixture(t);
    f.scope.directories.inChatAgents = path.join(f.scope.directories.root, 'InChatAgents');
    fs.mkdirSync(f.scope.directories.inChatAgents);
    fs.writeFileSync(path.join(f.scope.directories.inChatAgents, 'companion.json'), JSON.stringify({
        id: 'companion', category: 'companion', name: 'Pathfinder', enabled: true,
        settings: { sidecarEnabled: true },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 200 });
    assert.deepEqual(snapshot.hookPolicy.pathfinder, []);
});

test('replacing an enabled Pathfinder record with identical bytes changes the captured hook source', t => {
    const f = fixture(t);
    f.scope.directories.inChatAgents = path.join(f.scope.directories.root, 'InChatAgents');
    fs.mkdirSync(f.scope.directories.inChatAgents);
    const filename = path.join(f.scope.directories.inChatAgents, 'pathfinder.json');
    const contents = JSON.stringify({ id: 'pathfinder', category: 'tool', name: 'Pathfinder', enabled: true,
        settings: { sidecarEnabled: true } });
    fs.writeFileSync(filename, contents);
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const snapshot = captureRoleplayWorldInfo(f.scope, account, f.source(), { avatar: 'Nova.png', maxContext: 200 });
    fs.renameSync(filename, `${filename}.old`);
    fs.writeFileSync(filename, contents);
    assert.throws(() => assertRoleplayWorldInfoCurrent(f.scope, snapshot), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});

test('malformed enabled Quick Reply settings cannot silently disable an activation hook', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        extension_settings: { quickReplyV2: { isEnabled: 'true', config: { setList: [] } } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    assert.throws(() => captureRoleplayWorldInfo(f.scope, account, f.source(),
        { avatar: 'Nova.png', maxContext: 200 }), { code: 'ROLEPLAY_INVALID' });
});

test('enabled vector lore activation and scan injection refuse before provider work', async t => {
    const vector = prepared(t, { extension_settings: { vectors: { enabled_world_info: true } } });
    assert.deepEqual(vector.worldInfo.hookPolicy.scanContributors.map(value => value.kind), ['vectors']);
    await assert.rejects(runRoleplayReplyJob(vector.context, { contextLimit: () => 4096,
        generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(readArtifact(vector.f.scope.directories, vector.jobId, 'roleplay-world-info'), undefined);

    const disabled = prepared(t, { extension_settings: { disabledExtensions: ['third-party/vectors'],
        vectors: { enabled_world_info: true, include_wi: true, enabled_chats: true } } });
    assert.deepEqual(disabled.worldInfo.hookPolicy.scanContributors, []);
    const injected = prepared(t, { extension_settings: { vectors: { include_wi: true, enabled_chats: true } } });
    assert.deepEqual(injected.worldInfo.hookPolicy.scanContributors.map(value => value.kind), ['vectors']);
});

test('saved Agent scan prompts are bound and refuse before a World Info scan', async t => {
    const f = fixture(t);
    f.scope.directories.inChatAgents = path.join(f.scope.directories.root, 'InChatAgents');
    fs.mkdirSync(f.scope.directories.inChatAgents);
    const filename = path.join(f.scope.directories.inChatAgents, 'scan-agent.json');
    const agent = { id: 'scan-agent', category: 'content', name: 'Scan Agent', enabled: true, phase: 'pre',
        prompt: 'The hidden trigger', injection: { scan: true, position: 1, depth: 2, role: 0 } };
    fs.writeFileSync(filename, JSON.stringify(agent));
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify({
        extension_settings: { inChatAgents: { globalSettings: { enabled: true, pathfinderEnabled: false } } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const source = f.source();
    const snapshot = captureRoleplayWorldInfo(f.scope, account, source, { avatar: 'Nova.png', maxContext: 200 });
    assert.deepEqual(snapshot.hookPolicy.scanContributors.map(value => value.kind), ['agent']);
    const { jobId } = admitRoleplayJob(f.scope, account, { operationKey: 'scan-agent', effect: 'append', source,
        request: { binding: { profileId: 'saved', fingerprint: 'bound' }, maxTokens: 32, characterName: 'Nova',
            worldInfo: snapshot, messages: [] } });
    releaseJob(f.scope.directories, jobId);
    await assert.rejects(runRoleplayReplyJob({ job: getJob(f.scope.directories, jobId),
        directories: f.scope.directories, owner: f.scope.owner, signal: new AbortController().signal },
    { contextLimit: () => 4096, generate: () => { throw Error('Provider called'); } }), { code: 'ROLEPLAY_INVALID' });
    assert.equal(readArtifact(f.scope.directories, jobId, 'roleplay-world-info'), undefined);
    agent.prompt = 'Changed scan';
    fs.writeFileSync(filename, JSON.stringify(agent));
    assert.throws(() => assertRoleplayWorldInfoCurrent(f.scope, snapshot), { code: 'ROLEPLAY_SOURCE_CHANGED' });
});
