import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { bootstrapRoleplayAccount, commitSingleChatWrite } from '../src/roleplay-lifecycle.js';
import { captureRoleplayStorageSource, readRoleplayEntity } from '../src/generation/roleplay-source.js';
import { roleplayNativeHost } from '../src/endpoints/chats.js';
import { readRoleplayAccount, roleplayLease, roleplayStoreDirectory,
    saveRoleplayAccount, withRoleplayAccount, resetRoleplayAccount } from '../src/roleplay-store.js';
import { FILE_WRITE_RECOVERY_SUFFIX } from '../src/util.js';
import { captureChatProfile, captureProfilePresetBinding } from '../src/generation/profiles.js';
import { acceptJob, getJob } from '../src/jobs/store.js';

const marker = '_termux-file-identity.json';
const config = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const moduleUrl = name => new URL('../src/' + name + '.js', import.meta.url).href;
const locators = [{ group: false, chat: 'Source', avatar: 'Nova.png' }, { group: true, chat: 'Source' }];

function base(root, owner = 'fixture') {
    return { owner, directories: Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE)
        .map(([key, relative]) => [key, path.join(root, owner, relative)])) };
}

function account(t, owner = 'fixture') {
    const f = fixture(t, false, owner);
    f.records[0].chat_metadata = { topic: 'Preserved metadata' };
    const current = base(f.root, owner);
    fs.renameSync(f.scope.directories.groupChats, current.directories.groupChats);
    f.scope.directories = current.directories;
    fs.writeFileSync(path.join(current.directories.groupChats, 'Source.jsonl'), f.records.map(record => JSON.stringify(record)).join('\n'));
    const scope = bootstrapRoleplayAccount(current, roleplayNativeHost);
    readRoleplayEntity(scope, 'character', 'Nova.png');
    readRoleplayEntity(scope, 'group', 'group');
    for (const [index, locator] of locators.entries()) {
        commitSingleChatWrite(scope, { operationKey: 'original-' + index, mode: 'update', sourceKind: 'storage',
            source: captureRoleplayStorageSource(scope, locator), records: f.records, backup: { deferBackup: true } }, roleplayNativeHost);
    }
    return { ...f, scope, before: readRoleplayAccount(scope) };
}

function copy(t, root) {
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-handoff-'));
    t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
    fs.cpSync(root, destination, { recursive: true });
    return destination;
}

function statePath(root, owner = 'fixture') {
    return path.join(roleplayStoreDirectory(base(root, owner)), 'state.json');
}

function alter(root, change, owner = 'fixture') {
    withRoleplayAccount(base(root, owner), null, lease => {
        change(roleplayLease(lease).state);
        saveRoleplayAccount(lease);
    });
}

/** Fresh processes reproduce S21 stats, then run normal policy selection and bootstrap. No zero-policy preload. */
function boot(root, options = {}) {
    const script = `
        import fs from 'node:fs'; import path from 'node:path';
        const root = ${JSON.stringify(root)}, options = ${JSON.stringify(options)}, marker = path.join(root, ${JSON.stringify(marker)});
        const output = { warnings: [], logs: [] };
        console.info = text => output.logs.push(text); console.warn = text => output.warnings.push(text);
        const originalNodeOptions = process.env.NODE_OPTIONS;
        const filenames = new Map();
        const originalOpen = fs.openSync;
        fs.openSync = (...args) => { const fd = originalOpen(...args); filenames.set(fd, args[0]); return fd; };
        if (!options.native) for (const method of ['statSync', 'lstatSync', 'fstatSync']) {
            const original = fs[method]; fs[method] = (...args) => {
                const stat = original(...args);
                if (stat && typeof stat.dev === 'bigint') {
                    stat.birthtimeNs = stat.ctimeNs; stat.birthtimeMs = stat.ctimeMs; stat.birthtime = stat.ctime;
                    const filename = typeof args[0] === 'number' ? filenames.get(args[0]) : args[0];
                    if (options.collision && typeof filename === 'string' && /Source\\.jsonl$/.test(filename)) {
                        stat.ino = 999999999n;
                        if (options.collision === 'raw') stat.birthtimeNs = 123n;
                        else stat.birthtimeNs = filename.includes('group chats') ? 123n : 456n;
                    }
                }
                return stat;
            };
        }
        const { setConfigFilePath } = await import(${JSON.stringify(moduleUrl('util'))}); setConfigFilePath(${JSON.stringify(config)});
        const { configureTermuxStartup } = await import(${JSON.stringify(moduleUrl('termux-startup'))});
        const { USER_DIRECTORY_TEMPLATE } = await import(${JSON.stringify(moduleUrl('constants'))});
        const { bootstrapRoleplayAccount, commitSingleChatWrite } = await import(${JSON.stringify(moduleUrl('roleplay-lifecycle'))});
        const { roleplayNativeHost } = await import(${JSON.stringify(moduleUrl('endpoints/chats'))});
        const { captureRoleplayStorageSource } = await import(${JSON.stringify(moduleUrl('generation/roleplay-source'))});
        const { readRoleplayAccount, readRoleplayFile } = await import(${JSON.stringify(moduleUrl('roleplay-store'))});
        const oldReaddir = fs.readdirSync;
        let accountScans = 0;
        fs.readdirSync = (...args) => {
            if (args[0] === path.join(root, '_roleplay') && ++accountScans === 3 && options.changeInventory) {
                fs.mkdirSync(path.join(root, '_roleplay', '.appeared'));
            }
            return oldReaddir(...args);
        };
        const { createRequire } = await import('node:module');
        const graceful = createRequire(${JSON.stringify(moduleUrl('chat-file-lock'))})('graceful-fs');
        const oldOpen = fs.openSync, oldFsync = fs.fsyncSync, oldRmdir = graceful.rmdirSync;
        let markerFd;
        fs.openSync = (...args) => {
            if (args[0] === marker && args[1] === 'wx' && options.failure === 'before-marker') throw new Error('injected before marker');
            const fd = oldOpen(...args);
            if (args[0] === marker && args[1] === 'wx') markerFd = fd;
            return fd;
        };
        fs.fsyncSync = fd => {
            oldFsync(fd);
            if (fd === markerFd && options.failure === 'marker-fsync') throw new Error('injected marker fsync');
        };
        graceful.rmdirSync = (...args) => {
            if (String(args[0]).endsWith('.lock') && ((options.failure === 'lock-cleanup' && fs.existsSync(marker))
                || options.failure === 'early-lock-cleanup')) throw new Error('injected lock cleanup');
            return oldRmdir(...args);
        };
        try {
            output.result = await configureTermuxStartup({ dataRoot: root }, { termux: !options.native, bun: false,
                wakeLock: () => ({ status: 0 }), log: console.info, warn: console.warn });
            if (options.stopAfterMarker) throw new Error('interrupted after marker');
            output.accounts = [];
            for (const owner of options.owners || ['fixture']) {
                if (options.skipBootstrap) break;
                const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, relative]) => [key, path.join(root, owner, relative)]));
                const scope = bootstrapRoleplayAccount({ owner, directories }, roleplayNativeHost);
                const sources = [], records = [];
                for (const [index, locator] of ${JSON.stringify(locators)}.entries()) {
                    let source = captureRoleplayStorageSource(scope, locator);
                    const filename = locator.group ? path.join(directories.groupChats, 'Source.jsonl') : path.join(directories.chats, 'Nova', 'Source.jsonl');
                    if (options.save) {
                        const rows = fs.readFileSync(filename, 'utf8').trim().split('\\n').map(row => JSON.parse(row));
                        rows.push({ name: 'Nova', is_user: false, mes: options.save + '-' + index });
                        commitSingleChatWrite(scope, { operationKey: options.save + '-' + index, mode: 'update', sourceKind: 'storage', source,
                            records: rows, backup: { deferBackup: true } }, roleplayNativeHost);
                        source = captureRoleplayStorageSource(scope, locator);
                    }
                    sources.push(source); records.push(fs.readFileSync(filename, 'utf8').trim().split('\\n').map(row => JSON.parse(row)));
                }
                output.accounts.push({ state: readRoleplayAccount(scope), sources, records });
                if (options.interruptAfterAccount) throw new Error('interrupted between accounts');
            }
            if (options.checkBinding) {
                const { getJob } = await import(${JSON.stringify(moduleUrl('jobs/store'))});
                const { resolveGenerationProfile } = await import(${JSON.stringify(moduleUrl('generation/profiles'))});
                const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, relative]) => [key, path.join(root, 'fixture', relative)]));
                const job = getJob(directories, options.checkBinding);
                try { resolveGenerationProfile(directories, job.intent.binding); }
                catch (error) { output.dependencyRefusal = error.message; }
                output.binding = job.intent.binding;
            }
        } catch (error) { output.error = error.message; output.code = error.code; }
        output.workerDevice = process.env.NECONYAN_TERMUX_ZERO_BIRTHTIME_DEVICE;
        output.nodeOptionsUnchanged = originalNodeOptions === process.env.NODE_OPTIONS;
        process.stdout.write(JSON.stringify(output));
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8', env: { ...process.env, NECONYAN_TERMUX_ZERO_BIRTHTIME_DEVICE: '' },
    }));
}

function unchangedRefusal(root, options = {}, owners = ['fixture']) {
    const states = owners.map(owner => fs.readFileSync(statePath(root, owner)));
    const result = boot(root, { ...options, skipBootstrap: true });
    assert.equal(result.error, undefined);
    assert.equal(result.result.mode, 'legacy');
    assert.equal(fs.existsSync(path.join(root, marker)), false);
    assert.match(result.warnings[0], /clean handoff could not be verified/);
    owners.forEach((owner, index) => assert.deepEqual(fs.readFileSync(statePath(root, owner)), states[index]));
}

test('copied native ledgers select stable identities before solo/group saves, restarts and a second Termux entry', t => {
    const f = account(t);
    const phone = copy(t, f.root);
    const first = boot(phone, { save: 'phone-first' });
    assert.equal(first.error, undefined);
    assert.equal(first.result.mode, 'zero');
    assert.equal(first.nodeOptionsUnchanged, true);
    assert.ok(first.workerDevice);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(phone, marker))), { version: 1, birthtime: 'zero' });
    for (const [id, resource] of Object.entries(f.before.resources)) {
        const after = first.accounts[0].state.resources[id];
        assert.equal(after.revision, resource.revision + Number(resource.kind === 'chat'));
        assert.equal(after.head.physical.birthtimeNs, '0');
    }
    assert.equal(first.accounts[0].state.accountId, f.before.accountId);
    assert.equal(first.accounts[0].state.dataEpoch, f.before.dataEpoch);
    for (const records of first.accounts[0].records) {
        assert.deepEqual(records.slice(1, f.records.length), f.records.slice(1));
        const header = structuredClone(records[0]);
        delete header.chat_metadata.integrity; delete header.chat_metadata.neconyan_roleplay;
        assert.deepEqual(header, f.records[0]);
    }
    const restarted = boot(phone);
    assert.equal(restarted.error, undefined);
    assert.deepEqual(restarted.accounts, first.accounts);
    const desktop = copy(t, phone);
    const returned = boot(desktop, { native: true, save: 'desktop-return' });
    assert.equal(returned.error, undefined);
    assert.equal(returned.result.mode, 'unchanged');
    assert.equal(boot(desktop, { native: true }).error, undefined);
    const secondPhone = copy(t, desktop);
    const second = boot(secondPhone, { save: 'phone-second' });
    assert.equal(second.error, undefined);
    assert.equal(second.result.mode, 'zero');
    assert.equal(second.accounts[0].state.accountId, f.before.accountId);
    assert.deepEqual(boot(secondPhone).accounts, second.accounts);
    for (const [index, source] of second.accounts[0].sources.entries()) assert.equal(source.revision, first.accounts[0].sources[index].revision + 2);
});

test('in-place, birthtime-only, absent-placement and same-path replacement evidence cannot select a policy', t => {
    for (const variation of ['in-place', 'birthtime-only', 'absent', 'replacement']) {
        const f = account(t);
        if (variation === 'birthtime-only') alter(f.root, state => { state.placement.birthtimeNs = '1'; });
        if (variation === 'absent') alter(f.root, state => { delete state.placement; });
        if (variation === 'replacement') { fs.copyFileSync(f.filename, f.filename + '.copy'); fs.renameSync(f.filename + '.copy', f.filename); }
        unchangedRefusal(variation === 'absent' ? copy(t, f.root) : f.root);
    }
});

for (const variation of ['changed', 'missing', 'journal', 'untracked-journal', 'lock-named-chat-journal', 'hardlink', 'symlink', 'malformed', 'partial', 'missing-root', 'pending', 'reset', 'raw-collision', 'zero-collision']) {
    test('clean handoff refuses ' + variation + ' without changing policy or ledger', t => {
        const f = account(t);
        if (variation === 'pending') {
            assert.throws(() => commitSingleChatWrite(f.scope, { ...f.input(), operationKey: 'pending' },
                { ...roleplayNativeHost, publish() { throw new Error('interrupted'); } }));
        }
        if (variation === 'reset') {
            const original = fs.rmSync;
            fs.rmSync = (...args) => {
                if (!String(args[0]).includes('_roleplay')) throw Object.assign(new Error('interrupted reset'), { code: 'EBUSY' });
                return original(...args);
            };
            try { assert.throws(() => resetRoleplayAccount(f.scope, null, 'reset'), { code: 'EBUSY' }); }
            finally { fs.rmSync = original; }
        }
        const root = copy(t, f.root);
        const filename = f.filename.replace(f.root, root);
        const store = roleplayStoreDirectory(base(root));
        if (variation === 'changed') fs.appendFileSync(filename, '\n{}');
        if (variation === 'missing') fs.unlinkSync(filename);
        if (variation === 'journal' || variation === 'untracked-journal') {
            fs.writeFileSync((variation === 'journal' ? filename : path.join(base(root).directories.groupChats, 'Untracked.jsonl')) + FILE_WRITE_RECOVERY_SUFFIX, '{}');
        }
        if (variation === 'lock-named-chat-journal') {
            const directory = path.join(base(root).directories.chats, 'Nova.lock'); fs.mkdirSync(directory);
            fs.copyFileSync(path.join(base(root).directories.characters, 'Nova.png'), path.join(base(root).directories.characters, 'Nova.lock.png'));
            fs.writeFileSync(path.join(directory, 'Untracked.jsonl') + FILE_WRITE_RECOVERY_SUFFIX, '{}');
        }
        if (variation === 'hardlink') fs.linkSync(filename, filename + '.link');
        if (variation === 'symlink') { fs.renameSync(filename, filename + '.target'); fs.symlinkSync(filename + '.target', filename); }
        if (variation === 'malformed') fs.writeFileSync(statePath(root), '{}');
        if (variation === 'partial') fs.unlinkSync(path.join(store, 'identity.json'));
        if (variation === 'missing-root') fs.rmSync(base(root).directories.root, { recursive: true });
        unchangedRefusal(root, variation.endsWith('collision') ? { collision: variation.split('-')[0] } : {});
    });
}

function twoAccounts(t) {
    const first = account(t);
    const hidden = account(t, 'disabled-user');
    fs.cpSync(path.join(hidden.root, 'disabled-user'), path.join(first.root, 'disabled-user'), { recursive: true });
    const hiddenStore = roleplayStoreDirectory(base(hidden.root, 'disabled-user'));
    fs.cpSync(hiddenStore, roleplayStoreDirectory(base(first.root, 'disabled-user')), { recursive: true });
    return copy(t, first.root);
}

test('physical discovery includes disabled accounts and one unsafe or unknown child blocks every account', t => {
    const root = twoAccounts(t);
    const selected = boot(root, { owners: ['fixture', 'disabled-user'] });
    assert.equal(selected.error, undefined);
    assert.equal(selected.accounts.length, 2);
    for (const variation of ['unsafe', 'unknown']) {
        const refused = twoAccounts(t);
        if (variation === 'unsafe') fs.appendFileSync(path.join(base(refused, 'disabled-user').directories.groupChats, 'Source.jsonl'), '\n{}');
        else fs.mkdirSync(path.join(refused, '_roleplay', '.unknown'));
        unchangedRefusal(refused, {}, ['fixture', 'disabled-user']);
    }
});

test('account inventory is checked again while all account locks remain held', t => {
    const f = account(t); const root = copy(t, f.root);
    unchangedRefusal(root, { changeInventory: true });
    assert.ok(fs.existsSync(path.join(root, '_roleplay', '.appeared')));
});

test('historical backup journals are not active library journals', t => {
    const f = account(t); const root = copy(t, f.root);
    const backup = path.join(roleplayStoreDirectory(base(root)), 'transfer-backup'); fs.mkdirSync(backup);
    fs.writeFileSync(path.join(backup, 'Old.jsonl') + FILE_WRITE_RECOVERY_SUFFIX, '{}');
    fs.writeFileSync(path.join(base(root).directories.backups, 'Older.jsonl') + FILE_WRITE_RECOVERY_SUFFIX, '{}');
    assert.equal(boot(root).error, undefined);
    assert.equal(fs.existsSync(path.join(root, marker)), true);
});

test('marker publication failures abort before process and worker policy activation', t => {
    for (const failure of ['before-marker', 'marker-fsync', 'lock-cleanup']) {
        const f = account(t); const root = copy(t, f.root);
        const ledger = fs.readFileSync(statePath(root));
        const result = boot(root, { failure });
        assert.ok(result.error, failure);
        assert.equal(result.workerDevice, '');
        assert.deepEqual(fs.readFileSync(statePath(root)), ledger);
        assert.equal(fs.existsSync(path.join(root, marker)), failure !== 'before-marker');
    }
});

test('an account load refusal combined with lock cleanup failure aborts startup', t => {
    const f = account(t); const root = copy(t, f.root);
    fs.writeFileSync(statePath(root), '{}');
    const result = boot(root, { failure: 'early-lock-cleanup' });
    assert.equal(result.code, 'ROLEPLAY_STORE_DAMAGED');
    assert.ok(result.error);
    assert.equal(result.workerDevice, '');
    assert.equal(fs.existsSync(path.join(root, marker)), false);
    assert.equal(fs.readFileSync(statePath(root), 'utf8'), '{}');
});

test('interruption after marker or between account bootstraps resumes in a fresh process', t => {
    for (const stopAfterMarker of [true, false]) {
        const root = twoAccounts(t);
        const firstUntouched = fs.readFileSync(statePath(root));
        const untouched = fs.readFileSync(statePath(root, 'disabled-user'));
        const interrupted = boot(root, { stopAfterMarker, interruptAfterAccount: true });
        assert.match(interrupted.error, /interrupted/);
        assert.deepEqual(fs.readFileSync(statePath(root, 'disabled-user')), untouched);
        if (stopAfterMarker) assert.deepEqual(fs.readFileSync(statePath(root)), firstUntouched);
        const resumed = boot(root, { owners: ['fixture', 'disabled-user'], save: 'resumed' });
        assert.equal(resumed.error, undefined);
        assert.equal(resumed.result.mode, 'zero');
        assert.deepEqual(boot(root, { owners: ['fixture', 'disabled-user'] }).accounts, resumed.accounts);
    }
});

test('a resource changed after durable marker publication remains refused on resume', t => {
    const f = account(t); const root = copy(t, f.root);
    assert.match(boot(root, { stopAfterMarker: true }).error, /interrupted/);
    fs.appendFileSync(f.filename.replace(f.root, root), '\n{}');
    const result = boot(root);
    assert.equal(result.result.mode, 'zero');
    assert.equal(result.code, 'ROLEPLAY_SOURCE_CHANGED');
});

test('the preflight does not rewrite previously captured physical evidence for other files', t => {
    const f = account(t);
    const directories = f.scope.directories;
    fs.mkdirSync(directories.openAI_Settings);
    fs.writeFileSync(path.join(directories.openAI_Settings, 'Auxiliary.json'), '{"openai_max_context":8192,"temp_openai":0.5}');
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1' },
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'custom', model: 'fixture',
            'api-url': 'http://127.0.0.1:18000/v1' }] } },
    }));
    const binding = captureProfilePresetBinding(directories, captureChatProfile(directories, 'saved'), 'Auxiliary');
    const { job } = acceptJob(directories, { owner: 'fixture', type: 'test.preset', submissionKey: 'saved-preset', intent: { binding }, label: 'Saved preset' });
    const root = copy(t, f.root);
    const result = boot(root, { checkBinding: job.id });
    assert.equal(result.error, undefined);
    assert.match(result.dependencyRefusal, /preset or connection changed after acceptance/);
    assert.deepEqual(result.binding, binding);
    assert.deepEqual(getJob(base(root).directories, job.id).intent.binding, binding);
});
