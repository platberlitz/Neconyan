import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { initialiseRoleplayAccount, resetRoleplayAccount, readRoleplayAccountReset, settleRoleplayAccountReset,
    recreateRoleplayAccount, roleplayStoreDirectory, roleplayHash, withRoleplayAccount, roleplayLease,
    saveRoleplayAccount, prepareRoleplayResetContent, ROLEPLAY_STORE_MAX_BYTES } = await import('../src/roleplay-store.js');
const { captureAccountReset } = await import('../src/operations/account-reset.js');
const { admitOperation, readOperation, listOperations } = await import('../src/operations/store.js');
const { runOperation, acceptApplicationOperation } = await import('../src/operations/jobs.js');
const { getJob } = await import('../src/jobs/store.js');
const { captureUserResetContent } = await import('../src/endpoints/content-manager.js');
const { USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-reset-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const base = { owner: 'owner', directories: { root: path.join(directory, 'owner') } };
    fs.mkdirSync(base.directories.root);
    const account = initialiseRoleplayAccount(base);
    const filename = path.join(base.directories.root, 'later.txt');
    return { base, account, filename, statePath: path.join(roleplayStoreDirectory(base), 'state.json') };
}

test('a reset receipt survives later resets and never deletes newer data on replay', t => {
    const f = fixture(t);
    fs.writeFileSync(f.filename, 'original');
    const first = resetRoleplayAccount(f.base, f.account, 'reset', { operationKey: 'first' });
    const second = resetRoleplayAccount(f.base, first, 'reset', { operationKey: 'second' });
    fs.writeFileSync(f.filename, 'newer data');
    assert.deepEqual(resetRoleplayAccount(f.base, f.account, 'reset', { operationKey: 'first' }), first);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'newer data');
    assert.equal(readRoleplayAccountReset(f.base, f.account, 'first').phase, 'complete');
    assert.equal(withRoleplayAccount(f.base, null, (_lease, account) => account.dataEpoch), second.dataEpoch);
    assert.throws(() => resetRoleplayAccount(f.base, first, 'reset', { operationKey: 'first' }), /different work/);
    assert.throws(() => resetRoleplayAccount(f.base, f.account, 'purge', { operationKey: 'first' }), /different work/);
});

test('startup finishes a keyed interrupted reset and its original request reads the same completion', t => {
    const f = fixture(t);
    fs.writeFileSync(f.filename, 'original');
    const remove = fs.rmSync;
    fs.rmSync = (filename, options) => {
        remove(filename, options);
        if (filename === f.filename) throw new Error('interrupted after removal');
    };
    try {
        assert.throws(() => resetRoleplayAccount(f.base, f.account, 'reset', { operationKey: 'interrupted' }), /interrupted after removal/);
    } finally { fs.rmSync = remove; }
    assert.equal(readRoleplayAccountReset(f.base, f.account, 'interrupted').phase, 'accepted');
    const completed = settleRoleplayAccountReset(f.base);
    assert.equal(readRoleplayAccountReset(f.base, f.account, 'interrupted').phase, 'complete');
    fs.writeFileSync(f.filename, 'created after recovery');
    assert.deepEqual(resetRoleplayAccount(f.base, f.account, 'reset', { operationKey: 'interrupted' }), completed);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'created after recovery');
});

test('a reset key cannot recover a different pending reset or a recreated account', t => {
    const f = fixture(t);
    fs.writeFileSync(f.filename, 'original');
    const remove = fs.rmSync;
    fs.rmSync = filename => { if (filename === f.filename) throw new Error('blocked removal'); return remove(filename, { recursive: true, force: true }); };
    try {
        assert.throws(() => resetRoleplayAccount(f.base, f.account, 'purge', { operationKey: 'purge' }), /blocked removal/);
        assert.throws(() => resetRoleplayAccount(f.base, f.account, 'purge', { operationKey: 'different' }), /different account reset/);
    } finally { fs.rmSync = remove; }
    assert.equal(settleRoleplayAccountReset(f.base), null);
    const recreated = recreateRoleplayAccount(f.base);
    fs.writeFileSync(f.filename, 'new incarnation');
    assert.notEqual(recreated.accountId, f.account.accountId);
    assert.throws(() => readRoleplayAccountReset(f.base, f.account, 'purge'), /account was replaced/);
    assert.throws(() => resetRoleplayAccount(f.base, f.account, 'purge', { operationKey: 'purge' }), /account was replaced/);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'new incarnation');
});

test('damaged reset completion evidence refuses further resets without touching current files', t => {
    const f = fixture(t);
    const next = resetRoleplayAccount(f.base, f.account, 'reset', { operationKey: 'saved' });
    fs.writeFileSync(f.filename, 'keep this');
    const envelope = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
    Object.values(envelope.state.accountResets)[0].result.dataEpoch += 1;
    envelope.hash = roleplayHash(envelope.state);
    fs.writeFileSync(f.statePath, JSON.stringify(envelope));
    const damaged = fs.readFileSync(f.statePath);
    assert.throws(() => resetRoleplayAccount(f.base, next, 'reset', { operationKey: 'new' }), { code: 'ROLEPLAY_STORE_DAMAGED' });
    assert.deepEqual(fs.readFileSync(f.statePath), damaged);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'keep this');
});

test('reset refuses before deleting data when its permanent receipt will not fit', t => {
    const f = fixture(t);
    fs.writeFileSync(f.filename, 'keep this');
    withRoleplayAccount(f.base, f.account, lease => {
        const { state } = roleplayLease(lease);
        state.padding = '';
        const current = Buffer.byteLength(JSON.stringify({ hash: roleplayHash(state), state }));
        state.padding = 'x'.repeat(ROLEPLAY_STORE_MAX_BYTES - current - 40);
        saveRoleplayAccount(lease);
    });
    const before = fs.readFileSync(f.statePath);
    assert.throws(() => resetRoleplayAccount(f.base, f.account, 'reset', { operationKey: 'cannot-fit' }), { code: 'ROLEPLAY_STORE_FULL' });
    assert.deepEqual(fs.readFileSync(f.statePath), before);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'keep this');
});

const replacementContent = () => ({ version: 1, directories: ['user/files', 'chats', 'characters'],
    files: [{ relative: 'settings.json', data: Buffer.from('{"fresh":true}').toString('base64') }] });

test('replacement defaults are frozen before reset and damaged payloads prevent all deletion', t => {
    const f = fixture(t);
    const content = replacementContent();
    const contentHash = prepareRoleplayResetContent(f.base, f.account, content);
    content.files[0].data = Buffer.from('later template').toString('base64');
    const next = resetRoleplayAccount(f.base, f.account, 'reset', { operationKey: 'defaults', contentHash });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.base.directories.root, 'settings.json'))), { fresh: true });
    assert.equal(fs.statSync(path.join(f.base.directories.root, 'user/files')).isDirectory(), true);
    fs.writeFileSync(f.filename, 'keep newer data');
    const payload = path.join(roleplayStoreDirectory(f.base), 'reset-content', `${contentHash}.json`);
    fs.writeFileSync(payload, 'damaged');
    assert.throws(() => resetRoleplayAccount(f.base, next, 'reset', { operationKey: 'new', contentHash }), /reset content is unavailable/);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'keep newer data');
    assert.deepEqual(resetRoleplayAccount(f.base, f.account, 'reset', { operationKey: 'defaults', contentHash }), next);
});

test('replacement content rejects paths outside the account and file-directory collisions before publication', t => {
    const f = fixture(t);
    for (const content of [
        { version: 1, directories: [], files: [{ relative: '../other/settings.json', data: '' }] },
        { version: 1, directories: ['jobs'], files: [] },
        { version: 1, directories: ['a/b'], files: [{ relative: 'a', data: '' }] },
    ]) assert.throws(() => prepareRoleplayResetContent(f.base, f.account, content), /manifest|contains another path/);
    assert.deepEqual(fs.readdirSync(f.base.directories.root), []);
});

test('native reset completion remains readable after its own job ledger is retired and never repeats', async t => {
    const f = fixture(t);
    fs.writeFileSync(f.filename, 'old account');
    const account = { accountId: f.account.accountId, dataEpoch: f.account.dataEpoch };
    const plan = captureAccountReset(f.base, account, {}, { content: replacementContent() });
    const accepted = admitOperation(f.base, account, { key: 'native-reset', kind: 'account-reset', input: {}, plan, label: 'Reset account' });
    const context = { ...f.base, job: accepted.job, signal: new AbortController().signal, progress: async () => {} };
    await assert.rejects(runOperation(context, { afterAccountReset() { throw new Error('lost reset acknowledgement'); } }), /lost reset acknowledgement/);
    assert.equal(getJob(f.base.directories, accepted.job.id), null);
    const record = readOperation(f.base, 'native-reset');
    assert.equal(record.state, 'completed');
    assert.equal(record.result.account.dataEpoch, account.dataEpoch + 1);
    assert.equal(listOperations(f.base, 'account-reset')[0].key, 'native-reset');
    assert.equal(fs.existsSync(f.filename), false);
    fs.writeFileSync(f.filename, 'later work');
    await runOperation(context);
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'later work');
});

test('generic application submission cannot bypass reset confirmation and an unrelated reset invalidates queued work', async t => {
    const f = fixture(t);
    const request = { user: { profile: { handle: f.base.owner }, directories: f.base.directories }, get: () => undefined };
    await assert.rejects(acceptApplicationOperation(request, { key: 'unconfirmed', kind: 'account-reset' }), /confirmed account reset control/);
    assert.equal(readOperation(f.base, 'unconfirmed'), null);
    const account = { accountId: f.account.accountId, dataEpoch: f.account.dataEpoch };
    const plan = captureAccountReset(f.base, account, {}, { content: replacementContent() });
    admitOperation(f.base, account, { key: 'queued-reset', kind: 'account-reset', input: {}, plan, label: 'Reset account' });
    resetRoleplayAccount(f.base, account, 'reset', { operationKey: 'different-request' });
    fs.writeFileSync(f.filename, 'later work');
    assert.equal(readOperation(f.base, 'queued-reset').state, 'refused');
    assert.equal(fs.readFileSync(f.filename, 'utf8'), 'later work');
});

test('the real bundled reset manifest maps user content and creates working default settings', t => {
    const f = fixture(t);
    for (const [name, relative] of Object.entries(USER_DIRECTORY_TEMPLATE)) f.base.directories[name] = path.join(f.base.directories.root, relative);
    const content = captureUserResetContent(f.base.directories);
    assert.ok(content.files.some(file => file.relative === 'settings.json'));
    const contentHash = prepareRoleplayResetContent(f.base, f.account, content);
    resetRoleplayAccount(f.base, f.account, 'reset', { operationKey: 'real-defaults', contentHash });
    const settings = JSON.parse(fs.readFileSync(path.join(f.base.directories.root, 'settings.json'), 'utf8'));
    assert.equal(typeof settings.extension_settings, 'object');
    assert.ok(fs.existsSync(f.base.directories.characters));
    assert.ok(fs.existsSync(path.join(f.base.directories.root, 'content.log')));
});
