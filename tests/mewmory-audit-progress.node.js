/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const {
    POLICY_VERSION, hash, newState, putRecord, refKey, syncSources, validateRecord,
} = await import('../src/mewmory/core.js');
const { defaultConfig, legacyRoleVersion, publicConfig, readConfig, resolvedRoleIdentity, roleVersion, saveConfig } = await import('../src/mewmory/models.js');
const { pendingSources, processBatch, processingVersion } = await import('../src/mewmory/processing.js');
const { scanProcessing, waitForProcessing } = await import('../src/mewmory/worker.js');
const { applyOverflowHiding } = await import('../src/mewmory/hiding.js');
const { prepareMewmoryPrompt } = await import('../src/mewmory/prepare.js');
const { recall } = await import('../src/mewmory/retrieval.js');
const { mergeVectorIndex, searchDocuments } = await import('../src/mewmory/search.js');
const { loadCurrentState, loadCurrentStateSync } = await import('../src/mewmory/sources.js');
const { mutateState, readChatShared, readState, synchronize, writeJson } = await import('../src/mewmory/store.js');

const locator = { chat: 'Gift', avatar: 'Mara.png', group: false };

function messages(count = 4) {
    return Array.from({ length: count }, (_, index) => ({
        is_user: index % 2 === 0, name: index % 2 ? 'Mara' : 'You',
        send_date: 'message-' + index, mewmory_id: 'm' + index,
        mes: 'The harbour scene contains detail number ' + index + '.',
    }));
}

function disk(t, records = messages()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-audit-progress-'));
    const directories = Object.fromEntries(['chats', 'groupChats', 'groups', 'worlds', 'characters', 'files']
        .map(name => [name, path.join(root, name)]));
    directories.root = root;
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.join(directories.chats, 'Mara'), { recursive: true });
    const filename = path.join(directories.chats, 'Mara', 'Gift.jsonl');
    fs.writeFileSync(filename, [{ chat_metadata: {} }, ...records].map(value => JSON.stringify(value)).join('\n'));
    writeJson(path.join(root, 'settings.json'), {});
    t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    return { directories, filename };
}

function rememberAll(directories, config) {
    const policy = processingVersion(config);
    return mutateState(directories, locator, state => {
        state.enabled = true;
        for (const ref of state.timeline) state.coverage[refKey(ref)] = state.checkpoints[refKey(ref)] = policy;
    });
}

function writeProfiles(directories, profiles) {
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles } } });
}

function storedIdentity(state, config, name = 'extractor') {
    const stored = state.roleIdentities?.[name];
    return typeof stored === 'string' ? stored : stored?.[roleVersion(config, name)];
}

function prepareFixture(count = 20) {
    const records = Array.from({ length: count }, (_, index) => ({
        name: index % 2 ? 'Peter' : 'Mara', is_user: Boolean(index % 2),
        send_date: 'message-' + index, mes: 'The harbour scene contains detail number ' + index + '.',
    }));
    const state = newState(locator);
    state.enabled = true;
    syncSources(state, records, []);
    const config = defaultConfig();
    Object.assign(config, { writerTokenizer: 'cl100k_base', historyMode: 'messages', recentMessages: 10, historyBatchMessages: 5 });
    for (const ref of state.timeline) state.checkpoints[refKey(ref)] = processingVersion(config);
    return { records, state, config };
}

function prepareInput(records) {
    return { locator, history: records.map((message, index) => ({ index, text: message.mes })) };
}

test('operational role settings do not re-open finished memories, while identity changes do', () => {
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1234/v1', model: 'extractor' });
    const original = roleVersion(config, 'extractor');
    for (const change of [
        role => { role.maxOutputTokens = 64000; },
        role => { role.contextTokens = 1000000; },
        role => { role.tokenizer = 'cl100k_base'; },
        role => { role.allowedData = ['chat', 'character', 'lore', 'memory']; },
        role => { role.allowRemote = false; },
        role => { role.timeoutMs = 120000; },
        role => { role.queryPrefix = 'only-for-embeddings: '; },
        role => {
            role.error = 'The chosen connection profile is temporarily unavailable.';
            role.connection = { payload: { reverse_proxy: 'https://proxy.example.test/', proxy_password: 'transient-secret' } };
        },
    ]) {
        const next = structuredClone(config);
        change(next.roles.extractor);
        assert.equal(roleVersion(next, 'extractor'), original, 'an operational setting must not invalidate extraction coverage');
    }
    for (const change of [
        role => { role.enabled = false; },
        role => { role.profileId = 'profile-one'; },
        role => { role.modelOverride = 'another-model'; },
        role => { role.model = 'another-model'; },
        role => { role.modelRevision = 'revision-two'; },
        role => { role.endpoint = 'http://127.0.0.1:5678/v1'; },
    ]) {
        const next = structuredClone(config);
        change(next.roles.extractor);
        assert.notEqual(roleVersion(next, 'extractor'), original, 'a model, endpoint, profile or revision change must invalidate extraction coverage');
    }
    const localOnly = structuredClone(config);
    localOnly.localOnly = true;
    assert.equal(roleVersion(localOnly, 'extractor'), original, 'switching local-only mode alone must not invalidate coverage');
});

test('a temporarily broken connection profile keeps progress and repairing it restores the identity', async t => {
    const { directories } = disk(t);
    const profile = { id: 'p1', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [profile] } } });
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'p1' });
    saveConfig(directories, config);
    const healthy = readConfig(directories);
    const healthyVersion = roleVersion(healthy, 'extractor');
    await loadCurrentState(directories, locator);
    rememberAll(directories, healthy);

    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [] } } });
    const broken = readConfig(directories);
    assert.match(broken.roles.extractor.error, /no longer exists/);
    assert.equal(roleVersion(broken, 'extractor'), healthyVersion, 'a missing profile must not look like a new model');
    let state = loadCurrentStateSync(directories, locator);
    assert.equal(pendingSources(state, broken, { checkpoint: true }).length, 0, 'a broken profile must not make every message unread');
    assert.equal(pendingSources(state, broken).length, 0);

    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [profile] } } });
    const repaired = readConfig(directories);
    assert.equal(roleVersion(repaired, 'extractor'), healthyVersion, 'repairing the same profile restores the same identity');
    state = loadCurrentStateSync(directories, locator);
    assert.equal(pendingSources(state, repaired, { checkpoint: true }).length, 0);
});

test('a temporarily broken shared profile keeps progress for every role following it', async t => {
    const { directories } = disk(t);
    const profile = { id: 'shared', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [profile] } } });
    const settings = publicConfig(directories);
    Object.assign(settings, { sharedProfileId: 'shared' });
    Object.assign(settings.roles.extractor, { enabled: true, useShared: true });
    saveConfig(directories, settings);
    await loadCurrentState(directories, locator);
    const healthy = readConfig(directories);
    const healthyVersion = roleVersion(healthy, 'extractor');
    rememberAll(directories, healthy);

    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [] } } });
    const broken = readConfig(directories);
    assert.match(broken.roles.extractor.error, /no longer exists/);
    assert.equal(roleVersion(broken, 'extractor'), healthyVersion, 'a shared profile must not lose its identity while broken');
    let state = loadCurrentStateSync(directories, locator);
    assert.equal(pendingSources(state, broken, { checkpoint: true }).length, 0);
    assert.equal(pendingSources(state, broken).length, 0);

    writeJson(path.join(directories.root, 'settings.json'), { extension_settings: { connectionManager: { profiles: [profile] } } });
    const repaired = readConfig(directories);
    assert.equal(roleVersion(repaired, 'extractor'), healthyVersion);
    state = loadCurrentStateSync(directories, locator);
    assert.equal(pendingSources(state, repaired, { checkpoint: true }).length, 0);
});

test('a same profile id with a changed model or endpoint invalidates processed marks', async t => {
    const base = { id: 'p1', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    for (const change of [
        profile => ({ ...profile, model: 'model-two' }),
        profile => ({ ...profile, 'api-url': 'http://127.0.0.1:6000/v1' }),
    ]) {
        const { directories } = disk(t);
        writeProfiles(directories, [base]);
        const config = defaultConfig();
        Object.assign(config.roles.extractor, { enabled: true, profileId: 'p1' });
        saveConfig(directories, config);
        await loadCurrentState(directories, locator);
        const beforeConfig = readConfig(directories);
        rememberAll(directories, beforeConfig);
        const before = storedIdentity(readState(directories, locator), beforeConfig);
        assert.ok(before);

        writeProfiles(directories, [change(base)]);
        const changed = readConfig(directories);
        const state = loadCurrentStateSync(directories, locator);
        assert.notEqual(storedIdentity(state, changed), before, 'the stored connection identity follows the resolved profile');
        assert.deepEqual(state.coverage, {});
        assert.deepEqual(state.checkpoints, {});
        assert.equal(pendingSources(state, changed).length, state.timeline.length);
    }
});

test('a shared profile with a changed model or endpoint also invalidates processed marks', async t => {
    const base = { id: 'shared', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    for (const change of [
        profile => ({ ...profile, model: 'model-two' }),
        profile => ({ ...profile, 'api-url': 'http://127.0.0.1:6000/v1' }),
    ]) {
        const { directories } = disk(t);
        writeProfiles(directories, [base]);
        const settings = publicConfig(directories);
        Object.assign(settings, { sharedProfileId: 'shared' });
        Object.assign(settings.roles.extractor, { enabled: true, useShared: true });
        saveConfig(directories, settings);
        await loadCurrentState(directories, locator);
        const beforeConfig = readConfig(directories);
        rememberAll(directories, beforeConfig);
        const before = storedIdentity(readState(directories, locator), beforeConfig);

        writeProfiles(directories, [change(base)]);
        const changed = readConfig(directories);
        const state = loadCurrentStateSync(directories, locator);
        assert.notEqual(storedIdentity(state, changed), before);
        assert.deepEqual(state.coverage, {});
        assert.deepEqual(state.checkpoints, {});
        assert.equal(pendingSources(state, changed).length, state.timeline.length);
    }
});

test('a model override change makes the new version pending while keeping the old marks', async t => {
    const { directories } = disk(t);
    const profile = { id: 'p1', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    writeProfiles(directories, [profile]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'p1' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const beforeConfig = readConfig(directories);
    rememberAll(directories, beforeConfig);
    const before = storedIdentity(readState(directories, locator), beforeConfig);

    const changedConfig = readConfig(directories);
    changedConfig.roles.extractor.modelOverride = 'override-model';
    saveConfig(directories, changedConfig);
    const changed = readConfig(directories);
    const state = loadCurrentStateSync(directories, locator);
    assert.notEqual(storedIdentity(state, changed), before);
    assert.equal(pendingSources(state, changed).length, state.timeline.length, 'the new override version must be read');
    assert.equal(pendingSources(state, changed, { checkpoint: true }).length, state.timeline.length);
    assert.ok(state.timeline.every(ref => state.coverage[refKey(ref)] === processingVersion(beforeConfig)),
        'the old override version keeps its marks for a later switch back');
});

test('an archive without a stored identity seeds one without invalidating progress', async t => {
    const { directories } = disk(t);
    const profile = { id: 'p1', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    writeProfiles(directories, [profile]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'p1' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    rememberAll(directories, readConfig(directories));
    mutateState(directories, locator, state => { delete state.roleIdentities; });

    writeProfiles(directories, [{ ...profile, model: 'model-two' }]);
    const changed = readConfig(directories);
    const state = loadCurrentStateSync(directories, locator);
    assert.equal(storedIdentity(state, changed), resolvedRoleIdentity(changed, 'extractor'), 'an old archive starts from the live connection');
    assert.equal(pendingSources(state, changed).length, 0, 'seeding an old archive must not reread history');
    assert.equal(pendingSources(state, changed, { checkpoint: true }).length, 0);
});

test('automatic hiding waits for a changed profile identity to be reconciled', async t => {
    const records = [
        { is_user: true, name: 'You', send_date: 'h1', mewmory_id: 'h1', mes: 'a'.repeat(20) },
        { is_user: false, name: 'Mara', send_date: 'h2', mewmory_id: 'h2', mes: 'b'.repeat(20) },
        { is_user: true, name: 'You', send_date: 'h3', mewmory_id: 'h3', mes: 'c'.repeat(20) },
        { is_user: false, name: 'Mara', send_date: 'h4', mewmory_id: 'h4', mes: 'latest reply' },
    ];
    const { directories } = disk(t, records);
    const profile = { id: 'p1', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    writeProfiles(directories, [profile]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'p1' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        const policy = processingVersion(readConfig(directories));
        for (const ref of state.timeline) state.coverage[refKey(ref)] = state.checkpoints[refKey(ref)] = policy;
    });
    writeProfiles(directories, [{ ...profile, model: 'model-two' }]);
    const chatRecords = [{ chat_metadata: {} }, ...structuredClone(records)];
    const policy = { limit: 15, count: value => value.length, directories, locator };
    assert.equal(applyOverflowHiding(chatRecords, policy).hidden, 0, 'old marks must not hide messages for a different resolved model');
    const reconciled = loadCurrentStateSync(directories, locator);
    assert.deepEqual(reconciled.coverage, {});
    assert.equal(applyOverflowHiding(chatRecords, policy).hidden, 0);
});

test('a profile change during processing discards the batch instead of marking old coverage', async t => {
    const { directories } = disk(t, messages(2));
    const profile = { id: 'p1', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    writeProfiles(directories, [profile]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'p1' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });

    await assert.rejects(processBatch(directories, locator, { checkpoint: true }, async (_directories, _config, role) => {
        writeProfiles(directories, [{ ...profile, model: 'model-two' }]);
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role } };
    }), error => {
        assert.equal(error.status, 409);
        return true;
    });
    const state = readState(directories, locator);
    assert.deepEqual(state.coverage, {});
    assert.deepEqual(state.checkpoints, {});
    assert.equal(storedIdentity(state, readConfig(directories)), resolvedRoleIdentity(readConfig(directories), 'extractor'));
});

test('switching profile A to B and back preserves the marks that belong to A', async t => {
    const { directories } = disk(t, messages(4));
    const profileA = { id: 'pa', name: 'A', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-a' };
    const profileB = { id: 'pb', name: 'B', api: 'custom', 'api-url': 'http://127.0.0.1:6000/v1', model: 'model-b' };
    writeProfiles(directories, [profileA, profileB]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'pa' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const versionA = readConfig(directories);
    const stateA = rememberAll(directories, versionA);
    const refs = stateA.timeline.slice();
    const policyA = processingVersion(versionA);

    const toB = readConfig(directories);
    toB.roles.extractor.profileId = 'pb';
    saveConfig(directories, toB);
    const versionB = readConfig(directories);
    loadCurrentStateSync(directories, locator);
    const policyB = processingVersion(versionB);
    mutateState(directories, locator, state => {
        for (const ref of refs.slice(0, 2)) state.coverage[refKey(ref)] = state.checkpoints[refKey(ref)] = policyB;
    });

    const backToA = readConfig(directories);
    backToA.roles.extractor.profileId = 'pa';
    saveConfig(directories, backToA);
    const returned = readConfig(directories);
    const state = loadCurrentStateSync(directories, locator);
    assert.equal(processingVersion(returned), policyA);
    for (const ref of refs.slice(2)) {
        assert.equal(state.coverage[refKey(ref)], policyA, 'untouched A marks survive the round trip');
        assert.equal(state.checkpoints[refKey(ref)], policyA);
    }
    assert.equal(pendingSources(state, returned, { checkpoint: true }).length, 2, 'only the B batch remains pending under A');
    assert.equal(Object.keys(state.roleIdentities.extractor).length, 2, 'both semantic profile versions keep their resolved identity');
});

test('switching model override A to B and back preserves the marks that belong to A', async t => {
    const { directories } = disk(t, messages(4));
    const profile = { id: 'p1', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    writeProfiles(directories, [profile]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'p1' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const versionA = readConfig(directories);
    const stateA = rememberAll(directories, versionA);
    const refs = stateA.timeline.slice();
    const policyA = processingVersion(versionA);

    const toB = readConfig(directories);
    toB.roles.extractor.modelOverride = 'override-b';
    saveConfig(directories, toB);
    const versionB = readConfig(directories);
    loadCurrentStateSync(directories, locator);
    const policyB = processingVersion(versionB);
    mutateState(directories, locator, state => {
        for (const ref of refs.slice(0, 2)) state.coverage[refKey(ref)] = state.checkpoints[refKey(ref)] = policyB;
    });

    const backToA = readConfig(directories);
    backToA.roles.extractor.modelOverride = '';
    saveConfig(directories, backToA);
    const returned = readConfig(directories);
    const state = loadCurrentStateSync(directories, locator);
    assert.equal(processingVersion(returned), policyA);
    for (const ref of refs.slice(2)) assert.equal(state.coverage[refKey(ref)], policyA);
    assert.equal(pendingSources(state, returned, { checkpoint: true }).length, 2);
});

test('a same-profile model edit clears only the active version marks', async t => {
    const { directories } = disk(t, messages(4));
    const profileA = { id: 'pa', name: 'A', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-a' };
    const profileB = { id: 'pb', name: 'B', api: 'custom', 'api-url': 'http://127.0.0.1:6000/v1', model: 'model-b' };
    writeProfiles(directories, [profileA, profileB]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'pa' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const versionA = readConfig(directories);
    const stateA = rememberAll(directories, versionA);
    const refs = stateA.timeline.slice();

    const toB = readConfig(directories);
    toB.roles.extractor.profileId = 'pb';
    saveConfig(directories, toB);
    const versionB = readConfig(directories);
    loadCurrentStateSync(directories, locator);
    const policyB = processingVersion(versionB);
    mutateState(directories, locator, state => {
        for (const ref of refs.slice(0, 2)) state.coverage[refKey(ref)] = state.checkpoints[refKey(ref)] = policyB;
    });

    const backToA = readConfig(directories);
    backToA.roles.extractor.profileId = 'pa';
    saveConfig(directories, backToA);
    loadCurrentStateSync(directories, locator);

    writeProfiles(directories, [{ ...profileA, model: 'model-a-edited' }, profileB]);
    const edited = readConfig(directories);
    const state = loadCurrentStateSync(directories, locator);
    for (const ref of refs.slice(0, 2)) assert.equal(state.coverage[refKey(ref)], policyB, 'marks from another semantic version are not cleared');
    for (const ref of refs.slice(2)) assert.equal(state.coverage[refKey(ref)], undefined, 'the edited active version has no old marks left');
    assert.equal(pendingSources(state, edited, { checkpoint: true }).length, 4);
    assert.equal(storedIdentity(state, edited), resolvedRoleIdentity(edited, 'extractor'));
    assert.notEqual(storedIdentity(state, edited), storedIdentity(stateA, versionA));
});

test('a broken profile keeps its last known policy identity for a later model change', async t => {
    const { directories } = disk(t);
    const profileA = { id: 'pa', name: 'A', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-a' };
    writeProfiles(directories, [profileA]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'pa' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const versionA = readConfig(directories);
    const stateA = rememberAll(directories, versionA);
    const refs = stateA.timeline.slice();
    const policyA = processingVersion(versionA);

    writeProfiles(directories, []);
    const broken = loadCurrentStateSync(directories, locator);
    assert.ok(refs.every(ref => broken.coverage[refKey(ref)] === policyA), 'a temporary profile failure keeps progress');

    // Change the other processing role while the profile is still broken. This creates a new
    // policy whose identity snapshot starts null, without touching the extractor role version.
    const configPath = path.join(directories.root, 'mewmory', 'config.json');
    const switched = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    switched.roles.pawspective.enabled = true;
    writeJson(configPath, switched);
    const policyB = processingVersion(readConfig(directories));
    assert.notEqual(policyB, policyA);
    loadCurrentStateSync(directories, locator);

    // Repair the same profile with a different model while the other role is still switched on.
    writeProfiles(directories, [{ ...profileA, model: 'model-a-edited' }]);
    const repaired = readConfig(directories);
    assert.equal(processingVersion(repaired), policyB);
    const afterRepair = loadCurrentStateSync(directories, locator);
    assert.ok(refs.every(ref => afterRepair.coverage[refKey(ref)] === undefined), 'the old model marks are cleared when its identity changes');
    assert.ok(refs.every(ref => afterRepair.checkpoints[refKey(ref)] === undefined));

    // Returning to the original policy must not resurrect those old marks.
    switched.roles.pawspective.enabled = false;
    writeJson(configPath, switched);
    const returned = readConfig(directories);
    assert.equal(processingVersion(returned), policyA);
    const state = loadCurrentStateSync(directories, locator);
    assert.equal(pendingSources(state, returned).length, refs.length);
    assert.equal(pendingSources(state, returned, { checkpoint: true }).length, refs.length);
});

test('saving a higher output limit keeps every message checkpointed', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'extractor' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const saved = readConfig(directories);
    const state = rememberAll(directories, saved);
    assert.equal(pendingSources(state, saved, { checkpoint: true }).length, 0);

    const raised = readConfig(directories);
    Object.assign(raised.roles.extractor, { maxOutputTokens: 64000, contextTokens: 1000000 });
    saveConfig(directories, raised);
    const next = readConfig(directories);
    assert.equal(processingVersion(next), processingVersion(saved), 'raising limits keeps the same processing policy');
    const current = loadCurrentStateSync(directories, locator);
    assert.equal(pendingSources(current, next, { checkpoint: true }).length, 0, 'no message needs to be read again');
    for (const ref of current.timeline) assert.equal(current.checkpoints[refKey(ref)], processingVersion(next));
});

test('archives written with either earlier policy formula migrate without rereading history', async t => {
    const { directories } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'extractor' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const saved = readConfig(directories);
    const policy = processingVersion(saved);
    const legacyCurrent = hash([POLICY_VERSION, ...['extractor', 'pawspective'].map(name => legacyRoleVersion(saved, name))]);
    const legacyOldest = hash([POLICY_VERSION, ...['extractor', 'pawspective'].map(name => hash([saved.localOnly, saved.roles[name]]))]);
    assert.notEqual(legacyCurrent, legacyOldest);
    assert.notEqual(legacyCurrent, policy);
    mutateState(directories, locator, state => {
        state.enabled = true;
        state.timeline.forEach((ref, index) => {
            const value = index % 2 ? legacyCurrent : legacyOldest;
            state.coverage[refKey(ref)] = value;
            state.checkpoints[refKey(ref)] = value;
        });
        state.coverage.unrelated = 'different-policy';
    });

    const migrated = loadCurrentStateSync(directories, locator);
    for (const ref of migrated.timeline) {
        const key = refKey(ref);
        if (migrated.coverage[key] !== 'different-policy') assert.equal(migrated.coverage[key], policy);
    }
    assert.equal(migrated.coverage.unrelated, 'different-policy');
    assert.ok(migrated.timeline.every(ref => !migrated.checkpoints[refKey(ref)] || migrated.checkpoints[refKey(ref)] === policy));
    assert.equal(pendingSources(migrated, saved).length, 0);
    assert.equal(pendingSources(migrated, saved, { checkpoint: true }).length, 0);
});

test('migrating an old policy and syncing a new message share one archive write', async t => {
    const { directories, filename } = disk(t);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'extractor' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    const saved = readConfig(directories);
    const legacyCurrent = hash([POLICY_VERSION, ...['extractor', 'pawspective'].map(name => legacyRoleVersion(saved, name))]);
    mutateState(directories, locator, state => {
        state.enabled = true;
        for (const ref of state.timeline) {
            state.coverage[refKey(ref)] = legacyCurrent;
            state.checkpoints[refKey(ref)] = legacyCurrent;
        }
    });
    fs.appendFileSync(filename, '\n' + JSON.stringify({ is_user: false, name: 'Mara', send_date: 'later', mewmory_id: 'later', mes: 'A later reply.' }));
    const before = readState(directories, locator).revision;
    const synced = loadCurrentStateSync(directories, locator);
    assert.equal(synced.revision, before + 1, 'the source sync and policy migration must not clone and write the archive twice');
    const oldRefs = synced.timeline.slice(0, -1);
    assert.ok(oldRefs.every(ref => synced.coverage[refKey(ref)] === processingVersion(saved)));
    assert.equal(pendingSources(synced, saved).length, 1, 'only the newly appended message still needs reading');
});

test('synchronize folds archive upkeep into the same write as the chat sync', async t => {
    const { directories } = disk(t);
    const source = readChatShared(directories, locator);
    const synced = synchronize(directories, locator, [], source, state => {
        assert.equal(state.timeline.length, source.messages.length, 'upkeep runs after the source sync');
        state.coverage.upkeep = 'same-write';
        return state;
    });
    assert.equal(synced.coverage.upkeep, 'same-write');
    assert.equal(readState(directories, locator).coverage.upkeep, 'same-write');
    // The callback is optional; direct chat-mutation callers still use the four-argument form.
    assert.equal(synchronize(directories, locator, [], source).timeline.length, source.messages.length);
});

test('prompt preparation loads the archive twice and writes once, including history usage', async () => {
    const { records, state, config } = prepareFixture();
    let loads = 0;
    let writes = 0;
    const result = await prepareMewmoryPrompt({}, prepareInput(records), undefined, {
        loadState: async () => { loads++; return state; },
        mutate: (_directories, _locator, operate) => { writes++; return operate(state) || state; },
        readSource: () => ({ metadata: {}, messages: records }), readConfiguration: () => config,
        scheduleBackground: false, deterministicMarker: true,
    });
    assert.equal(loads, 2, 'one initial read and one final check, with no duplicate read inside recall');
    assert.equal(writes, 1, 'recall commits the preview and history in one archive write');
    assert.deepEqual(state.preview.history, result.history);
    assert.equal(result.history.retainedMessages, 10);
    assert.equal(result.excludedIndices.length, 10);
});

test('preparation switched off while waiting returns a clean 409 instead of crashing', async () => {
    const { records, state, config } = prepareFixture();
    let loads = 0;
    await assert.rejects(prepareMewmoryPrompt({}, prepareInput(records), undefined, {
        loadState: async () => { loads++; return loads === 1 ? state : { ...state, enabled: false }; },
        mutate: (_directories, _locator, operate) => operate(state) || state,
        readSource: () => ({ metadata: {}, messages: records }), readConfiguration: () => config,
        scheduleBackground: false, deterministicMarker: true,
    }), error => {
        assert.equal(error.status, 409);
        assert.ok(!(error instanceof TypeError));
        assert.match(error.message, /turned off/);
        return true;
    });
    assert.equal(loads, 2);
});

test('the final preparation check also rejects an archive switched off after recall commits', async () => {
    const { records, state, config } = prepareFixture();
    await assert.rejects(prepareMewmoryPrompt({}, prepareInput(records), undefined, {
        loadState: async () => state,
        mutate: (_directories, _locator, operate) => {
            const result = operate(state) || state;
            state.enabled = false;
            return result;
        },
        readSource: () => ({ metadata: {}, messages: records }), readConfiguration: () => config,
        scheduleBackground: false, deterministicMarker: true,
    }), error => {
        assert.equal(error.status, 409);
        assert.match(error.message, /turned off/);
        return true;
    });
});

test('the final preparation check rejects a source that changed after recall', async () => {
    const { records, state, config } = prepareFixture();
    let loads = 0;
    const changedSource = structuredClone(state);
    changedSource.sources[changedSource.timeline[0].id].revisions.at(-1).hash = 'changed-after-recall';
    await assert.rejects(prepareMewmoryPrompt({}, prepareInput(records), undefined, {
        loadState: async () => { loads++; return loads === 1 ? state : changedSource; },
        mutate: (_directories, _locator, operate) => operate(state) || state,
        readSource: () => ({ metadata: {}, messages: records }), readConfiguration: () => config,
        scheduleBackground: false, deterministicMarker: true,
    }), error => {
        assert.equal(error.status, 409);
        assert.match(error.message, /changed while the reply was being prepared/);
        return true;
    });
    assert.equal(state.preview, null, 'a rejected preparation must not leave its stale preview on display');
});

test('a background recall cannot restore vectors cleared by an index reset', async t => {
    const { directories } = disk(t, messages(3));
    const config = defaultConfig();
    Object.assign(config.roles.embedding, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'embedding' });
    config.retrieval.mode = 'keyword';
    config.writerTokenizer = 'cl100k_base';
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const saved = readConfig(directories);
    const documents = searchDocuments(readState(directories, locator), Infinity, saved);
    assert.equal(documents.length, 3);
    const oldDocument = documents[0];
    const version = roleVersion(saved, 'embedding');
    mutateState(directories, locator, state => {
        state.index = { version, vectors: {
            [oldDocument.id]: { textHash: hash(oldDocument.searchText), vector: [1, 0] },
        }, pending: true };
    });

    let reset = false;
    const embedFn = async (_directories, _config, texts) => {
        if (!reset) {
            reset = true;
            mutateState(directories, locator, state => {
                state.index = { version: '', vectors: {}, pending: true };
                state.indexOperation = 'rebuild';
            });
        }
        return { vectors: texts.map(() => [0, 1]), usage: { role: 'embedding', input: texts.length } };
    };
    await recall(directories, locator, { asOf: 2, background: true, tokenizer: {} },
        { embedFn, scheduleBackground: false });

    let state = readState(directories, locator);
    let paidIds = Object.keys(state.index.build?.vectors || {});
    assert.equal(paidIds.length, 2, 'the two vectors paid for by this recall are retained in the staged build');
    assert.ok(!paidIds.includes(oldDocument.id), 'a vector loaded before the reset is not restored');
    assert.equal(state.index.version, '', 'the reset working index is not replaced by a partial new model');
    assert.ok(state.index.pending);

    const stale = { version, vectors: { [oldDocument.id]: { textHash: 'stale-text', vector: [9, 9] } } };
    const fresh = { version, vectors: { [oldDocument.id]: { textHash: hash(oldDocument.searchText), vector: [1, 0] } } };
    const merged = mergeVectorIndex(state, saved, [stale, fresh]);
    assert.deepEqual(merged.vectors[oldDocument.id].vector, [1, 0], 'a fresh matching entry wins over a stale one for the same document');
});

test('a switched-off Pawspective suggestion is ignored without a skipped warning', async t => {
    const { directories } = disk(t, messages(2));
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'extractor' });
    config.roles.pawspective.enabled = false;
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    let calls = 0;
    const state = await processBatch(directories, locator, { checkpoint: true }, async (_directories, _config, role) => {
        calls++;
        assert.equal(role, 'extractor');
        return { value: { records: [], interviews: [null], activeNpcIds: [] }, usage: { role } };
    });
    assert.equal(calls, 1, 'the disabled interview role is never called');
    assert.equal(state.jobs.at(-1).status, 'complete');
    assert.equal(state.jobs.at(-1).skipped, 0, 'an intentionally ignored suggestion is not a skipped interview');
    assert.deepEqual(state.jobs.at(-1).skippedReasons, []);
});

test('a corrected Connection Manager model retries a failed automatic batch on the next scan', async t => {
    const { directories } = disk(t, messages(2));
    const profile = { id: 'p1', name: 'Local', api: 'custom', 'api-url': 'http://127.0.0.1:5000/v1', model: 'model-one' };
    writeProfiles(directories, [profile]);
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, profileId: 'p1' });
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });

    const failure = Object.assign(new Error('The model could not be reached.'), { status: 502 });
    await scanProcessing(directories, async () => { throw failure; });
    const failed = await waitForProcessing(directories, locator);
    assert.equal(failed.processing.status, 'failed');
    assert.ok(failed.processing.fingerprint);

    writeProfiles(directories, [{ ...profile, model: 'model-two' }]);
    let calls = 0;
    await scanProcessing(directories, async (_directories, _config, role) => {
        calls++;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role } };
    });
    const retried = await waitForProcessing(directories, locator);
    assert.equal(calls, 1, 'the corrected resolved model makes the failed story eligible again');
    assert.equal(retried.processing.status, 'complete');
    assert.equal(pendingSources(retried, readConfig(directories), { checkpoint: true }).length, 0);
});

test('a rejected preparation does not erase a newer preview with the same fingerprint', async () => {
    const { records, state, config } = prepareFixture();
    let loads = 0;
    const changedSource = structuredClone(state);
    changedSource.sources[changedSource.timeline[0].id].revisions.at(-1).hash = 'changed-after-recall';
    await assert.rejects(prepareMewmoryPrompt({}, prepareInput(records), undefined, {
        loadState: async () => {
            loads++;
            if (loads === 2 && state.preview) state.preview = { ...state.preview, previewId: 'concurrent-preparation' };
            return loads === 1 ? state : changedSource;
        },
        mutate: (_directories, _locator, operate) => operate(state) || state,
        readSource: () => ({ metadata: {}, messages: records }), readConfiguration: () => config,
        scheduleBackground: false, deterministicMarker: true,
    }), error => {
        assert.equal(error.status, 409);
        return true;
    });
    assert.equal(state.preview?.previewId, 'concurrent-preparation', 'cleanup is tied to its own preview, not a shared fingerprint');
});

test('a partial new embedding model stays staged until a full rebuild completes', async t => {
    const { directories } = disk(t, messages(40));
    const config = defaultConfig();
    Object.assign(config.roles.embedding, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'embedding' });
    config.retrieval.mode = 'keyword';
    config.writerTokenizer = 'cl100k_base';
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => { state.enabled = true; });
    const saved = readConfig(directories);
    const documents = searchDocuments(readState(directories, locator), Infinity, saved);
    assert.equal(documents.length, 40);
    const oldDocument = documents[0];
    mutateState(directories, locator, state => {
        state.index = { version: 'old-embedding-version',
            vectors: { [oldDocument.id]: { textHash: hash(oldDocument.searchText), vector: [9, 9] } }, pending: true };
    });

    const embedFn = async (_directories, _config, texts) =>
        ({ vectors: texts.map(() => [1, 0]), usage: { role: 'embedding', input: texts.length } });
    await recall(directories, locator, { asOf: 39, background: true, tokenizer: {} },
        { embedFn, scheduleBackground: false });

    let state = readState(directories, locator);
    assert.equal(state.index.version, 'old-embedding-version', 'the working index stays active');
    assert.deepEqual(state.index.vectors[oldDocument.id].vector, [9, 9]);
    assert.equal(state.index.build.version, roleVersion(saved, 'embedding'));
    assert.equal(Object.keys(state.index.build.vectors).length, 32, 'only the paid batch is staged');
    assert.equal(state.index.pending, true);

    await recall(directories, locator, { asOf: 39, background: true, tokenizer: {} },
        { embedFn, scheduleBackground: false });
    state = readState(directories, locator);
    assert.equal(state.index.version, roleVersion(saved, 'embedding'), 'the next batch completes and publishes the new model');
    assert.equal(Object.keys(state.index.vectors).length, 40);
    assert.equal(state.index.pending, false);
});

test('a background recall keeps vectors it already paid for when a record changes during embedding', async t => {
    const { directories } = disk(t, messages(3));
    const config = defaultConfig();
    Object.assign(config.roles.embedding, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'embedding' });
    config.retrieval.mode = 'keyword';
    config.writerTokenizer = 'cl100k_base';
    saveConfig(directories, config);
    await loadCurrentState(directories, locator);
    mutateState(directories, locator, state => {
        state.enabled = true;
        putRecord(state, validateRecord(state, {
            id: 'event:key', kind: 'event', text: 'Mara took the silver key.',
            refs: [state.timeline[0]], subjectIds: ['npc:mara'],
        }, { asOf: 0, origin: 'objective_extractor' }), { automatic: true });
    });

    const vector = value => Array.from({ length: 8 }, (_, index) => ((hash(value).charCodeAt(index) % 13) + 1) / 13);
    let changed = false;
    const changedDuringEmbedding = async (directories, config, texts) => {
        if (!changed) {
            changed = true;
            mutateState(directories, locator, state => {
                const record = state.records.find(item => item.id === 'event:key');
                record.text = 'Mara hid the silver key in her coat.';
                record.version += 1;
                record.createdAt = Date.now();
            });
        }
        return { vectors: texts.map(vector), usage: { role: 'embedding', input: texts.length } };
    };
    await recall(directories, locator, { asOf: 2, background: true, tokenizer: {} },
        { embedFn: changedDuringEmbedding, scheduleBackground: false });

    let state = readState(directories, locator);
    let ids = Object.keys(state.index.build?.vectors || {});
    assert.equal(ids.length, 3, 'the three unchanged message vectors are staged for the new model');
    assert.ok(!ids.includes('event:key'), 'the changed record is not served from its stale vector');
    assert.equal(state.index.version, '', 'the incomplete new model is not published as the active index');
    assert.equal(mergeVectorIndex(state, readConfig(directories), [state.index.build]).remaining, 1);
    assert.ok(state.index.pending);
    const otherVersion = structuredClone(readConfig(directories));
    otherVersion.roles.embedding.modelRevision = 'next-revision';
    assert.equal(mergeVectorIndex(state, otherVersion, [state.index.build]).remaining, 4,
        'vectors from a different embedding revision are never reused');
    const chatOnly = structuredClone(readConfig(directories));
    chatOnly.roles.embedding.allowedData = ['chat'];
    const allowed = mergeVectorIndex(state, chatOnly, [state.index.build]);
    assert.equal(allowed.remaining, 0);
    assert.equal(Object.keys(allowed.vectors).length, 3, 'only data types the role may read keep their vectors');

    const embedded = [];
    const recordingEmbed = async (directories, config, texts) => {
        embedded.push(...texts);
        return { vectors: texts.map(vector), usage: { role: 'embedding', input: texts.length } };
    };
    await recall(directories, locator, { asOf: 2, background: true, tokenizer: {} },
        { embedFn: recordingEmbed, scheduleBackground: false });
    state = readState(directories, locator);
    assert.equal(embedded.length, 1, 'the next recall only embeds the changed record, not the unchanged messages');
    assert.ok(embedded[0].includes('Mara hid the silver key'));
    ids = Object.keys(state.index.vectors);
    assert.equal(ids.length, 4);
    assert.ok(ids.includes('event:key'));
    assert.equal(state.index.pending, false);
});
