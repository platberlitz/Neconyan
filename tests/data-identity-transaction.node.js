import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, writeJournal } from './roleplay-transactions-fixture.js';
import { resetRoleplayAccount, roleplayStoreDirectory } from '../src/roleplay-store.js';

const cli = fileURLToPath(new URL('../scripts/repair-data-identity.js', import.meta.url));
const preload = fileURLToPath(new URL('./termux-ctime-fixture.js', import.meta.url));
const child = fileURLToPath(new URL('./data-identity-repair-child.js', import.meta.url));
const crashChild = fileURLToPath(new URL('./data-identity-crash-child.js', import.meta.url));
function run(script, args) {
    return spawnSync(process.execPath, ['--import', preload, script, ...args], {
        encoding: 'utf8', env: { ...process.env, NECONYAN_CONVERSATION_TEST_DISPOSABLE: '1' }, timeout: 60000,
    });
}
function output(result) {
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('\n{') + 1));
}

test('offline repair, fresh verification, save and another restart preserve the account', t => {
    const f = fixture(t);
    f.source();
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-outside-'));
    t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
    const before = fs.readFileSync(f.filename);
    const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
    const applied = output(run(cli, ['apply', '--dataRoot', f.root, '--backupRoot', backup, '--token', check.token]));
    assert.equal(applied.phase, 'policy-installed');
    assert.ok(fs.existsSync(path.join(f.root, '_neconyan-policy-repair')));
    const resumed = output(run(cli, ['resume', '--dataRoot', f.root]));
    assert.ok(fs.existsSync(resumed.backup));
    assert.equal(fs.existsSync(path.join(f.root, '_neconyan-policy-repair')), false);
    assert.deepEqual(fs.readFileSync(f.filename), before);
    const saved = output(run(child, [f.root, f.scope.owner, 'save']));
    const read = output(run(child, [f.root, f.scope.owner, 'read']));
    assert.equal(saved.policy, 'zero');
    assert.equal(saved.accountId, f.scope.accountId);
    assert.equal(saved.dataEpoch, f.scope.dataEpoch + 1);
    assert.equal(read.instanceId, saved.instanceId);
    assert.equal(read.content, true);
});

for (const point of ['orphan', 'prepared', 'ledger-after', 'policy-installed']) {
    test(`durable source comparison tolerates ctime-only drift at ${point}`, t => {
        const f = fixture(t); f.source();
        const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-ctime-'));
        t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
        const original = fs.readFileSync(f.filename);
        const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
        if (point === 'policy-installed') output(run(cli, ['apply', '--dataRoot', f.root, '--backupRoot', backup, '--token', check.token]));
        else if (point === 'orphan') assert.equal(run(crashChild, [f.root, backup, check.token, 'gate-before']).signal, 'SIGKILL');
        else {
            assert.equal(run(crashChild, [f.root, backup, check.token, 'prepare']).status, 0);
            if (point === 'ledger-after') assert.equal(run(crashChild, [f.root, backup, check.token, point]).signal, 'SIGKILL');
        }
        const before = fs.statSync(f.filename, { bigint: true });
        fs.chmodSync(f.filename, Number(before.mode & 0o777n));
        const after = fs.statSync(f.filename, { bigint: true });
        assert.notEqual(after.ctimeNs, before.ctimeNs, 'fixture must actually change ctime');
        for (const field of ['dev', 'ino', 'mode', 'size', 'mtimeNs']) assert.equal(after[field], before[field], field);
        assert.deepEqual(fs.readFileSync(f.filename), original);
        if (point !== 'policy-installed') assert.equal(output(run(cli, ['resume', '--dataRoot', f.root])).phase, 'policy-installed');
        output(run(cli, ['resume', '--dataRoot', f.root]));
        assert.deepEqual(fs.readFileSync(f.filename), original);
        const saved = output(run(child, [f.root, f.scope.owner, 'save']));
        assert.equal(saved.accountId, f.scope.accountId); assert.equal(saved.dataEpoch, f.scope.dataEpoch + 1);
        assert.equal(output(run(child, [f.root, f.scope.owner, 'read'])).content, true);
    });
}

for (const change of ['bytes', 'inode', 'mode', 'mtime', 'size']) {
    test(`durable source comparison rejects changed ${change}`, t => {
        const f = fixture(t); f.source();
        if (change === 'bytes' || change === 'inode') fs.utimesSync(f.filename, 1700000000, 1700000000);
        const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-mismatch-'));
        t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
        const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
        output(run(cli, ['apply', '--dataRoot', f.root, '--backupRoot', backup, '--token', check.token]));
        const before = fs.statSync(f.filename, { bigint: true });
        if (change === 'bytes') {
            const bytes = fs.readFileSync(f.filename); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(f.filename, bytes);
            fs.utimesSync(f.filename, 1700000000, 1700000000);
            const after = fs.statSync(f.filename, { bigint: true }); assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ino, before.ino);
        } else if (change === 'inode') {
            const replacement = f.filename + '.replacement'; fs.writeFileSync(replacement, fs.readFileSync(f.filename)); fs.chmodSync(replacement, Number(before.mode & 0o777n)); fs.utimesSync(replacement, 1700000000, 1700000000); fs.renameSync(replacement, f.filename);
            const after = fs.statSync(f.filename, { bigint: true }); assert.notEqual(after.ino, before.ino); assert.equal(after.size, before.size); assert.equal(after.mode, before.mode); assert.equal(after.mtimeNs, before.mtimeNs);
        } else if (change === 'mode') fs.chmodSync(f.filename, Number(before.mode & 0o777n) ^ 0o100);
        else if (change === 'mtime') fs.utimesSync(f.filename, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9 + 5);
        else fs.appendFileSync(f.filename, 'x');
        const resumed = run(cli, ['resume', '--dataRoot', f.root]);
        assert.notEqual(resumed.status, 0, resumed.stdout); assert.match(resumed.stderr + resumed.stdout, /A source file changed/); assert.ok(fs.existsSync(path.join(f.root, '_neconyan-policy-repair')));
    });
}

test('ctime change after check invalidates its approval token', t => {
    const f = fixture(t); f.source();
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-approval-'));
    t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
    const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
    const before = fs.statSync(f.filename, { bigint: true }); fs.chmodSync(f.filename, Number(before.mode & 0o777n));
    assert.notEqual(fs.statSync(f.filename, { bigint: true }).ctimeNs, before.ctimeNs);
    assert.notEqual(run(cli, ['apply', '--dataRoot', f.root, '--backupRoot', backup, '--token', check.token]).status, 0);
    assert.equal(fs.existsSync(path.join(f.root, '_neconyan-policy-repair')), false);
});

test('ctime mutation during a held inventory read is refused', t => {
    const f = fixture(t); f.source();
    const inspection = new URL('../src/data-identity-repair-inspection.js', import.meta.url).href;
    const script = `import fs from 'node:fs';
        import { inventoryIdentityRepairRoot } from ${JSON.stringify(inspection)};
        const [root, filename] = process.argv.slice(1), target = fs.statSync(filename, { bigint: true });
        const original = fs.readSync; let changed = false;
        fs.readSync = function(fd, ...args) {
            const result = original.call(this, fd, ...args), stat = fs.fstatSync(fd, { bigint: true });
            if (!changed && stat.dev === target.dev && stat.ino === target.ino) {
                fs.chmodSync(filename, Number(target.mode & 0o777n)); changed = true;
            }
            return result;
        };
        try { inventoryIdentityRepairRoot(root); process.exitCode = 2; }
        catch (error) { if (!changed || !/File changed during inspection/.test(error.message)) throw error; }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.root, f.filename], { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('durable comparison refuses malformed ctime and retains strict off-device comparison', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../src/data-identity-repair-transaction.js', import.meta.url)), 'utf8');
    const body = source.match(/function sameDurableSourceFile\([\s\S]*?\n}\n/);
    assert.ok(body);
    const compare = vm.runInNewContext(`(${body[0].trim()})`);
    const expected = { relative: 'a', dev: '1', ino: '2', mode: '3', size: '4', mtimeNs: '5', ctimeNs: '6', hash: 'h' };
    assert.equal(compare({ ...expected, ctimeNs: '7' }, expected, '1'), true);
    assert.equal(compare({ ...expected, ctimeNs: 7 }, expected, '1'), false);
    assert.equal(compare({ ...expected, ctimeNs: '7x' }, expected, '1'), false);
    assert.equal(compare({ ...expected, ctimeNs: '7' }, expected, '9'), false);
    assert.equal(compare({ ...expected, ctimeNs: '7', extra: true }, expected, '1'), false);
});

for (const point of ['ledger-before', 'ledger-after', 'marker-before', 'marker-after']) {
    test(`a killed publisher resumes safely ${point}`, t => {
        const f = fixture(t);
        f.source();
        const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-crash-'));
        t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
        const before = fs.readFileSync(f.filename);
        const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
        const prepared = run(crashChild, [f.root, backup, check.token, 'prepare']);
        assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
        const killed = run(crashChild, [f.root, backup, check.token, point]);
        assert.equal(killed.signal, 'SIGKILL', killed.stderr + killed.stdout);
        const published = output(run(cli, ['resume', '--dataRoot', f.root]));
        assert.equal(published.phase, 'policy-installed');
        const completed = output(run(cli, ['resume', '--dataRoot', f.root]));
        assert.ok(fs.existsSync(completed.backup));
        assert.deepEqual(fs.readFileSync(f.filename), before);
        const saved = output(run(child, [f.root, f.scope.owner, 'save']));
        assert.equal(saved.accountId, f.scope.accountId);
        assert.equal(saved.dataEpoch, f.scope.dataEpoch + 1);
        assert.equal(output(run(child, [f.root, f.scope.owner, 'read'])).content, true);
    });
}

for (const point of ['gate-before', 'gate-after']) {
    test(`a killed preparation resumes safely ${point}`, t => {
        const f = fixture(t); f.source();
        const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-gate-'));
        t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
        const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
        const killed = run(crashChild, [f.root, backup, check.token, point]);
        assert.equal(killed.signal, 'SIGKILL', killed.stderr + killed.stdout);
        const status = output(run(cli, ['status', '--dataRoot', f.root]));
        assert.equal(status.activeRepair.phase, point === 'gate-before' ? 'prepared-candidate' : 'prepared');
        const gate = point === 'gate-before'
            ? path.join(f.root, `_neconyan-policy-repair-preparing-${status.activeRepair.operationId}`)
            : path.join(f.root, '_neconyan-policy-repair');
        const journal = JSON.parse(fs.readFileSync(path.join(gate, 'journal.json')));
        const expected = journal.accounts[0].newStateHash;
        assert.equal(output(run(cli, ['resume', '--dataRoot', f.root])).phase, 'policy-installed');
        output(run(cli, ['resume', '--dataRoot', f.root]));
        const stateBytes = fs.readFileSync(path.join(roleplayStoreDirectory(f.scope), 'state.json'));
        assert.equal(crypto.createHash('sha256').update(stateBytes).digest('hex'), expected);
        assert.equal(output(run(child, [f.root, f.scope.owner, 'save'])).content, true);
    });
}

test('multiple prepared candidates are preserved and never guessed between', t => {
    const f = fixture(t); f.source();
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-orphans-'));
    t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
    const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
    assert.equal(run(crashChild, [f.root, backup, check.token, 'gate-before']).signal, 'SIGKILL');
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const before = fs.readFileSync(statePath);
    const name = fs.readdirSync(f.root).find(item => item.startsWith('_neconyan-policy-repair-preparing-'));
    const duplicate = `_neconyan-policy-repair-preparing-${crypto.randomUUID()}`;
    fs.cpSync(path.join(f.root, name), path.join(f.root, duplicate), { recursive: true });
    assert.equal(output(run(cli, ['status', '--dataRoot', f.root])).activeRepair.phase, 'needs-inspection');
    assert.notEqual(run(cli, ['resume', '--dataRoot', f.root]).status, 0);
    assert.deepEqual(fs.readFileSync(statePath), before);
    assert.ok(fs.existsSync(path.join(f.root, name)) && fs.existsSync(path.join(f.root, duplicate)));
});

test('an incomplete preparation stays preserved and permits a new check', t => {
    const f = fixture(t); f.source();
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-incomplete-'));
    t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
    const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
    assert.equal(run(crashChild, [f.root, backup, check.token, 'gate-before']).signal, 'SIGKILL');
    const name = fs.readdirSync(f.root).find(item => item.startsWith('_neconyan-policy-repair-preparing-'));
    fs.renameSync(path.join(f.root, name, 'journal.json'), path.join(f.root, name, 'journal.retained'));
    assert.equal(output(run(cli, ['status', '--dataRoot', f.root])).activeRepair.phase, 'preparation-incomplete');
    assert.notEqual(run(cli, ['resume', '--dataRoot', f.root]).status, 0);
    assert.ok(output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup])).token);
    assert.ok(fs.existsSync(path.join(f.root, name, 'journal.retained')));
});

test('multiple ready, empty and retired accounts resume once after a partial publication', t => {
    const first = fixture(t, false, 'first'); first.source();
    const second = fixture(t, false, 'second'); second.source();
    const empty = fixture(t, false, 'empty');
    fs.unlinkSync(empty.filename);
    fs.unlinkSync(path.join(empty.scope.directories.characters, 'Nova.png'));
    fs.unlinkSync(path.join(empty.scope.directories.groups, 'group.json'));
    const retired = fixture(t, false, 'retired'); retired.source();
    resetRoleplayAccount({ owner: retired.scope.owner, directories: retired.scope.directories }, retired.scope, 'retire');
    for (const other of [second, empty, retired]) {
        fs.cpSync(other.scope.directories.root, path.join(first.root, other.scope.owner), { recursive: true });
        fs.cpSync(roleplayStoreDirectory(other.scope), path.join(first.root, '_roleplay', path.basename(roleplayStoreDirectory(other.scope))), { recursive: true });
    }
    fs.rmSync(path.join(first.root, retired.scope.owner), { recursive: true });
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-multi-'));
    t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
    const check = output(run(cli, ['check', '--dataRoot', first.root, '--backupRoot', backup]));
    assert.equal(check.accounts.length, 4);
    const prepared = run(crashChild, [first.root, backup, check.token, 'prepare']);
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    const killed = run(crashChild, [first.root, backup, check.token, 'second-ledger-before']);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr + killed.stdout);
    assert.equal(output(run(cli, ['resume', '--dataRoot', first.root])).phase, 'policy-installed');
    assert.ok(fs.existsSync(output(run(cli, ['resume', '--dataRoot', first.root])).backup));
    for (const item of [first, second, empty, retired]) {
        const filename = path.join(first.root, '_roleplay', path.basename(roleplayStoreDirectory(item.scope)), 'state.json');
        const state = JSON.parse(fs.readFileSync(filename)).state;
        assert.equal(state.accountId, item.scope.accountId);
        assert.equal(state.dataEpoch, item.scope.dataEpoch + (item === retired ? 2 : 1));
        assert.equal(state.status, item === retired ? 'deleted' : 'ready');
        if (item === empty || item === retired) assert.deepEqual(state.resources, {});
    }
    assert.equal(fs.existsSync(path.join(first.root, retired.scope.owner)), false, 'repair never recreates the retired user folder');
    assert.equal(output(run(child, [first.root, first.scope.owner, 'save'])).content, true);
});

test('changed source after check refuses without creating a repair gate or changing its ledger', t => {
    const f = fixture(t); f.source();
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-source-change-'));
    t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
    const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const state = fs.readFileSync(statePath);
    fs.appendFileSync(f.filename, '\n' + JSON.stringify({ name: 'User', is_user: true, mes: 'A later change' }));
    const result = run(cli, ['apply', '--dataRoot', f.root, '--backupRoot', backup, '--token', check.token]);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readFileSync(statePath), state);
    assert.match(fs.readFileSync(f.filename, 'utf8'), /A later change/);
    assert.equal(fs.existsSync(path.join(f.root, '_neconyan-policy-repair')), false);
    assert.equal(fs.existsSync(path.join(f.root, '_termux-file-identity.json')), false);
});

test('a damaged later publication copy prevents every account publication', t => {
    const first = fixture(t, false, 'first'); first.source();
    const second = fixture(t, false, 'second'); second.source();
    fs.cpSync(second.scope.directories.root, path.join(first.root, second.scope.owner), { recursive: true });
    fs.cpSync(roleplayStoreDirectory(second.scope), path.join(first.root, '_roleplay', path.basename(roleplayStoreDirectory(second.scope))), { recursive: true });
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-candidate-change-'));
    t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
    const check = output(run(cli, ['check', '--dataRoot', first.root, '--backupRoot', backup]));
    const prepared = run(crashChild, [first.root, backup, check.token, 'prepare']);
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    const active = path.join(first.root, '_neconyan-policy-repair');
    const journal = JSON.parse(fs.readFileSync(path.join(active, 'journal.json')));
    const original = journal.accounts.map(item => fs.readFileSync(path.join(first.root, '_roleplay', item.accountHash, 'state.json')));
    fs.appendFileSync(path.join(active, 'publication', journal.accounts[1].accountHash + '.json'), 'changed');
    const resumed = run(cli, ['resume', '--dataRoot', first.root]);
    assert.notEqual(resumed.status, 0);
    journal.accounts.forEach((item, index) => assert.deepEqual(fs.readFileSync(path.join(first.root, '_roleplay', item.accountHash, 'state.json')), original[index]));
    assert.ok(fs.existsSync(active));
    assert.equal(fs.existsSync(path.join(first.root, '_termux-file-identity.json')), false);
});

test('a changed backup blocks publication and leaves the original ledger untouched', t => {
    const f = fixture(t); f.source();
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-backup-change-'));
    t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
    const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
    const prepared = run(crashChild, [f.root, backup, check.token, 'prepare']);
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    const active = path.join(f.root, '_neconyan-policy-repair');
    const journal = JSON.parse(fs.readFileSync(path.join(active, 'journal.json')));
    const statePath = path.join(roleplayStoreDirectory(f.scope), 'state.json');
    const state = fs.readFileSync(statePath);
    const backupChat = path.join(journal.backup, 'files', f.scope.owner, 'chats', 'Nova', 'Source.jsonl');
    fs.appendFileSync(backupChat, 'changed');
    const resumed = run(cli, ['resume', '--dataRoot', f.root]);
    assert.notEqual(resumed.status, 0);
    assert.deepEqual(fs.readFileSync(statePath), state);
    assert.ok(fs.existsSync(active));
    assert.equal(fs.existsSync(path.join(f.root, '_termux-file-identity.json')), false);
});

for (const point of ['retire-before', 'retire-after', 'archive-before', 'archive-after']) {
    test(`a killed verifier preserves evidence ${point}`, t => {
        const f = fixture(t); f.source();
        const journal = writeJournal(f);
        const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-identity-verify-crash-'));
        t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
        const check = output(run(cli, ['check', '--dataRoot', f.root, '--backupRoot', backup]));
        const applied = output(run(cli, ['apply', '--dataRoot', f.root, '--backupRoot', backup, '--token', check.token]));
        assert.equal(applied.phase, 'policy-installed');
        const killed = run(crashChild, [f.root, backup, check.token, point]);
        assert.equal(killed.signal, 'SIGKILL', killed.stderr + killed.stdout);
        if (point === 'archive-after') {
            const archive = path.join(f.root, `_neconyan-policy-repair-complete-${applied.operationId}`, 'operation');
            const saved = JSON.parse(fs.readFileSync(path.join(archive, 'journal.json')));
            assert.equal(saved.phase, 'complete');
            assert.equal(fs.existsSync(path.join(f.root, '_neconyan-policy-repair')), false);
        } else {
            assert.ok(fs.existsSync(output(run(cli, ['resume', '--dataRoot', f.root])).backup));
        }
        assert.equal(fs.existsSync(journal.filename), false);
        assert.equal(output(run(child, [f.root, f.scope.owner, 'save'])).content, true);
        assert.equal(output(run(child, [f.root, f.scope.owner, 'read'])).content, true);
    });
}
