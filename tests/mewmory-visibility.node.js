/* eslint playwright/expect-expect: off -- Uses node:assert against saved chat records. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { disableMewmory, restoreMewmoryHidden, resumeVisibilityRestore } = await import('../src/mewmory/visibility.js');
const { mutateState, readState } = await import('../src/mewmory/store.js');
const { readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { generationFingerprint } = await import('../src/mewmory/context.js');
const { defaultConfig, saveConfig } = await import('../src/mewmory/models.js');
const { loadCurrentState } = await import('../src/mewmory/sources.js');
const { startProcessing, waitForProcessing } = await import('../src/mewmory/worker.js');

test('restoration selects owned ordinary rows, including empty companion carriers, without changing manual hides or tools', () => {
    const records = [{ chat_metadata: {} },
        { name: 'User', is_user: true, is_system: true, mes: 'owned', extra: { mewmoryKeepHidden: true, media: [{ title: 'note' }] } },
        { name: 'User', is_user: true, is_system: true, mes: 'manual', extra: {} },
        { name: 'Nova', is_user: false, is_system: true, mes: '', extra: { mewmoryKeepHidden: true, inChatAgentCompanionResults: { agent: { output: 'hello' } } } },
        { name: 'Nova', is_user: false, is_system: true, mes: '', extra: { mewmoryKeepHidden: true, tool_invocations: [{}] } },
        { name: 'System', is_user: false, is_system: true, mes: 'notice', extra: { mewmoryKeepHidden: true, type: 'generic' } }];
    const { records: actual, restored } = restoreMewmoryHidden(records);
    assert.equal(restored, 2);
    assert.equal(actual[1].is_system, false);
    assert.deepEqual(actual[1].extra, { media: [{ title: 'note' }] });
    assert.equal(actual[3].is_system, false);
    assert.ok(actual[3].extra.inChatAgentCompanionResults);
    assert.deepEqual(actual[2], records[2]);
    assert.deepEqual(actual[4], records[4]);
    assert.deepEqual(actual[5], records[5]);
    assert.equal(records[1].is_system, true, 'the input vector is not mutated');
});

for (const group of [false, true]) {
    test(`${group ? 'group' : 'character'} disable restores marked chat through its protected source and replays safely`, t => {
        const f = fixture(t, group, `mewmory-visibility-${group}`);
        f.records[1].is_system = true;
        f.records[1].extra.mewmoryKeepHidden = true;
        f.records[2].is_system = true;
        f.records[2].extra = { manual: true };
        fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
        const locator = { ...f.locator, avatar: group ? '' : f.locator.avatar };
        const memory = mutateState(f.scope.directories, locator, state => { state.enabled = true; });
        const source = readRoleplayChat(f.scope, f.locator);
        const oldFingerprint = generationFingerprint(memory, {});
        const body = { account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
            branchId: memory.branchId, revision: memory.revision, operationKey: 'disable-' + group, sourceInstanceId: source.instanceId };
        const result = disableMewmory(f.scope, locator, body);
        assert.equal(result.enabled, false);
        assert.equal(result.visibilityRestore.status, 'complete');
        assert.equal(result.visibilityRestore.restored, 1);
        const saved = readRoleplayChat(f.scope, f.locator);
        assert.equal(saved.records[1].is_system, false);
        assert.equal(saved.records[1].extra.mewmoryKeepHidden, undefined);
        assert.equal(saved.records[1].extra.file, 'attachment.txt');
        assert.equal(saved.records[2].is_system, true);
        assert.equal(saved.records[2].extra.manual, true);
        assert.equal(disableMewmory(f.scope, locator, body).visibilityRestore.restored, 1);
        assert.equal(readRoleplayChat(f.scope, f.locator).rawHash, saved.rawHash, 'retry does not publish a second write');
        const enabled = mutateState(f.scope.directories, locator, state => { state.enabled = true; });
        assert.notEqual(generationFingerprint(enabled, {}), oldFingerprint, 'a pre-disable generation cannot survive off then on');
        assert.throws(() => disableMewmory(f.scope, locator, body), /earlier off request is no longer current/);
        assert.equal(readState(f.scope.directories, locator).enabled, true);
    });
}

test('a durable incomplete restore can resume without requiring a model', t => {
    const f = fixture(t, false, 'mewmory-visibility-recovery');
    f.records[1].is_system = true;
    f.records[1].extra.mewmoryKeepHidden = true;
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    const locator = { ...f.locator };
    const saved = readRoleplayChat(f.scope, f.locator);
    mutateState(f.scope.directories, locator, state => {
        state.enabled = false;
        state.lastDisableId = 'pending-disable';
        state.visibilityRestore = { status: 'failed', operationKey: 'pending-disable', branchId: state.branchId,
            account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch }, instanceId: saved.instanceId };
    });
    const result = resumeVisibilityRestore(f.scope, locator);
    assert.equal(result.visibilityRestore.status, 'complete');
    assert.equal(result.visibilityRestore.restored, 1);
    assert.equal(readRoleplayChat(f.scope, f.locator).records[1].is_system, false);
});

test('disabling during a held extraction prevents a second batch and stale memory publication', async t => {
    const f = fixture(t, false, 'mewmory-visibility-held');
    const locator = { ...f.locator };
    const config = defaultConfig();
    config.batchMessages = 1;
    config.retrieval.includeFiles = false;
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'fixture' });
    saveConfig(f.scope.directories, config);
    await loadCurrentState(f.scope.directories, locator);
    mutateState(f.scope.directories, locator, state => { state.enabled = true; });
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const call = async () => {
        calls++;
        entered();
        await held;
        return { value: { records: [], interviews: [], activeNpcIds: [] }, usage: { role: 'extractor' } };
    };
    await startProcessing(f.scope.directories, locator, { all: true }, call);
    await started;
    const before = readState(f.scope.directories, locator);
    const saved = readRoleplayChat(f.scope, f.locator);
    disableMewmory(f.scope, locator, { account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
        branchId: before.branchId, revision: before.revision, operationKey: 'held-disable', sourceInstanceId: saved.instanceId });
    release();
    const after = await waitForProcessing(f.scope.directories, locator);
    assert.equal(calls, 1);
    assert.equal(after.enabled, false);
    assert.deepEqual(after.coverage, {});
    assert.equal(after.processing.status, 'cancelled');
});
