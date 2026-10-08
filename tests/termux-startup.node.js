import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveTermuxRecovery } from '../src/termux-startup.js';

const startup = new URL('../src/termux-startup.js', import.meta.url).href;
const util = new URL('../src/util.js', import.meta.url).href;
const preparation = new URL('../src/notebooks/preparation.js', import.meta.url).href;
const config = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const marker = '_termux-file-identity.json';

function fixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-startup-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const installation = path.join(home, 'Neconyan'); fs.mkdirSync(installation);
    const recovery = path.join(home, 'neconyan-import-recovery'); fs.mkdirSync(recovery);
    const pin = path.join(home, '.neconyan-import-folder');
    const input = { dataRoot: path.join(installation, 'data'), port: 4433 };
    const options = { home, installation, termux: true };
    return { home, installation, recovery, pin, input, options };
}

test('normal startup follows the saved recovery folder and keeps the browser origin', t => {
    const f = fixture(t); fs.writeFileSync(f.pin, f.recovery + '\n');
    assert.deepEqual(resolveTermuxRecovery(f.input, f.options), { dataRoot: f.recovery, port: 5534, recovery: true });
    assert.equal(fs.existsSync(f.input.dataRoot), false);
    assert.equal(resolveTermuxRecovery({ ...f.input, port: 6000, explicitPort: true }, f.options).port, 6000);
});

test('explicit data choices, global mode and another installation keep their own data', t => {
    const f = fixture(t); fs.writeFileSync(f.pin, f.recovery);
    const other = path.join(f.home, 'Another'); fs.mkdirSync(other);
    for (const [input, options] of [
        [{ ...f.input, explicitDataRoot: true }, f.options],
        [{ ...f.input, dataRoot: path.join(f.home, 'custom-data') }, f.options],
        [{ ...f.input, global: true }, f.options],
        [f.input, { ...f.options, installation: other }],
        [f.input, { ...f.options, termux: false }],
    ]) assert.deepEqual(resolveTermuxRecovery(input, options), { dataRoot: input.dataRoot, port: input.port, recovery: false });
    assert.equal(resolveTermuxRecovery({ ...f.input, dataRoot: f.recovery, explicitDataRoot: true }, f.options).recovery, true);
});

test('normal startup never guesses between unselected recovery folders or replaces a missing saved folder', t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.home, 'neconyan-import-second'));
    assert.equal(resolveTermuxRecovery(f.input, f.options).dataRoot, f.input.dataRoot);
    fs.writeFileSync(f.pin, f.recovery); fs.rmdirSync(f.recovery);
    assert.throws(() => resolveTermuxRecovery(f.input, f.options), /missing or unsafe/);
    assert.equal(fs.existsSync(f.recovery), false);
    assert.equal(resolveTermuxRecovery({ ...f.input, explicitDataRoot: true }, f.options).dataRoot, f.input.dataRoot);
});

test('a recovery pin cannot select arbitrary or linked data directories', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t);
    fs.writeFileSync(f.pin, f.installation);
    assert.throws(() => resolveTermuxRecovery(f.input, f.options), /needs inspection/);
    fs.unlinkSync(f.pin);
    const target = path.join(f.home, 'target'); fs.writeFileSync(target, f.recovery);
    fs.symlinkSync(target, f.pin);
    assert.throws(() => resolveTermuxRecovery(f.input, f.options));
});

function boot(root, { mode = 'ctime', recovery = false, worker = false, termux = true, bun = false } = {}) {
    const script = `
        import fs from 'node:fs'; import path from 'node:path';
        const mode = ${JSON.stringify(mode)}, root = ${JSON.stringify(root)};
        if (mode === 'ctime') for (const method of ['statSync','lstatSync','fstatSync']) {
            const original = fs[method]; fs[method] = (...args) => {
                const stat = original(...args);
                if (stat && typeof stat.dev === 'bigint') stat.birthtimeNs = stat.ctimeNs;
                return stat;
            };
        }
        const { setConfigFilePath } = await import(${JSON.stringify(util)});
        setConfigFilePath(${JSON.stringify(config)});
        const { configureTermuxStartup } = await import(${JSON.stringify(startup)});
        const warnings = []; const logs = []; let wakes = 0;
        const output = {};
        const originalNodeOptions = process.env.NODE_OPTIONS;
        try {
            output.result = await configureTermuxStartup({dataRoot:root, termuxRecovery:${recovery}}, {
                termux:${termux}, bun:${bun}, wakeLock:()=>{wakes++;return {status:0};},
                log:text=>logs.push(text), warn:text=>warnings.push(text),
            });
            const file = path.join(root,'saved-file');
            if (!fs.existsSync(file)) fs.writeFileSync(file,'Saved data');
            const stat = fs.statSync(file,{bigint:true});
            output.physical = {dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)};
            output.workerDevice = process.env.NECONYAN_TERMUX_ZERO_BIRTHTIME_DEVICE;
            output.nodeOptionsUnchanged = originalNodeOptions === process.env.NODE_OPTIONS;
            if (${worker}) {
                const { Worker } = await import('node:worker_threads'); const { once } = await import('node:events');
                const code = "import fs from 'node:fs';import {parentPort} from 'node:worker_threads';parentPort.postMessage(String(fs.statSync("+JSON.stringify(file)+",{bigint:true}).birthtimeNs));";
                const {termuxWorkerOptions} = await import(${JSON.stringify(new URL('../src/termux-file-identity.js', import.meta.url).href)});
                const child = new Worker(new URL('data:text/javascript,'+encodeURIComponent(code)), termuxWorkerOptions());
                output.workerBirthtime = (await once(child,'message'))[0];
                const notes = path.join(root,'notes'); fs.mkdirSync(notes,{recursive:true}); fs.writeFileSync(path.join(notes,'note.md'),'# Note\\nSaved note');
                const { prepareInWorker } = await import(${JSON.stringify(preparation)});
                output.notebookBirthtime = (await prepareInWorker('scan',{contentRoot:notes})).files[0].evidence.physical.birthtimeNs;
            }
        } catch(error) { output.error = error.message; }
        Object.assign(output,{warnings,logs,wakes});
        process.stdout.write(JSON.stringify(output));
    `;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-boot-probe-'));
    try {
        const filename = path.join(directory, 'boot.mjs'); fs.writeFileSync(filename, script);
        return JSON.parse(execFileSync(process.execPath, [filename], {
            encoding: 'utf8', env: { ...process.env, TERMUX_VERSION: 'fixture' },
        }));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('new Termux data automatically keeps stable identities in the server and workers', t => {
    const f = fixture(t);
    const first = boot(f.recovery, { worker: true });
    assert.equal(first.error, undefined);
    assert.equal(first.result.mode, 'zero');
    assert.equal(first.physical.birthtimeNs, '0');
    assert.equal(first.workerBirthtime, '0');
    assert.equal(first.notebookBirthtime, '0');
    assert.equal(first.wakes, 1);
    assert.equal(first.nodeOptionsUnchanged, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.recovery, marker))), { version: 1, birthtime: 'zero' });
    // A runtime upgrade may expose real creation times; the existing data policy must still win.
    fs.writeFileSync(path.join(f.recovery, marker), '{"birthtime":"zero","version":1}');
    const restarted = boot(f.recovery, { mode: 'native', worker: true });
    assert.equal(restarted.error, undefined);
    assert.deepEqual(restarted.physical, first.physical);
    assert.equal(restarted.workerBirthtime, '0');
    assert.equal(restarted.notebookBirthtime, '0');
});

test('a selected 1.2.1 recovery is recognised without a new-install marker', t => {
    const f = fixture(t); const protectedRoot = path.join(f.recovery, '_roleplay'); fs.mkdirSync(protectedRoot);
    const evidence = path.join(protectedRoot, 'kept.json'); fs.writeFileSync(evidence, '{"birthtimeNs":"0"}');
    const result = boot(f.recovery, { recovery: true, mode: 'native' });
    assert.equal(result.result.mode, 'zero');
    assert.equal(result.physical.birthtimeNs, '0');
    assert.equal(fs.readFileSync(evidence, 'utf8'), '{"birthtimeNs":"0"}');
});

test('older unmarked protected data is not silently converted or given new authority', t => {
    const f = fixture(t); const protectedRoot = path.join(f.recovery, '_roleplay'); fs.mkdirSync(protectedRoot);
    fs.writeFileSync(path.join(protectedRoot, 'kept.json'), '{"birthtimeNs":"123"}');
    const result = boot(f.recovery);
    assert.equal(result.result.mode, 'legacy');
    assert.notEqual(result.physical.birthtimeNs, '0');
    assert.equal(fs.existsSync(path.join(f.recovery, marker)), false);
    assert.match(result.warnings[0], /kept unchanged/);
    assert.equal(fs.readFileSync(path.join(protectedRoot, 'kept.json'), 'utf8'), '{"birthtimeNs":"123"}');
});

test('native creation times and unrelated runtimes stay unchanged', t => {
    const f = fixture(t);
    const native = boot(f.recovery, { mode: 'native' });
    assert.equal(native.result.mode, 'native'); assert.notEqual(native.physical.birthtimeNs, '0');
    const desktop = boot(f.recovery, { termux: false });
    assert.equal(desktop.result.mode, 'unchanged'); assert.equal(desktop.wakes, 0);
    const bun = boot(f.recovery, { bun: true });
    assert.equal(bun.result.mode, 'unchanged'); assert.equal(bun.wakes, 0);
});

test('malformed policies and incompatible runtimes stop instead of changing saved identities', t => {
    const f = fixture(t); const filename = path.join(f.recovery, marker);
    fs.writeFileSync(filename, '{broken');
    assert.match(boot(f.recovery).error, /policy needs inspection/);
    assert.equal(fs.readFileSync(filename, 'utf8'), '{broken');
    fs.writeFileSync(filename, '{"version":1,"birthtime":"zero"}');
    assert.match(boot(f.recovery, { bun: true }).error, /Start Neconyan with Node/);
});
