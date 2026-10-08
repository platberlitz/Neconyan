import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const adapter = new URL('../src/termux-file-stats.js', import.meta.url).href;
const fixture = new URL('./roleplay-transactions-fixture.js', import.meta.url).href;
const inputs = new URL('../src/operations/input-files.js', import.meta.url).href;
const store = new URL('../src/roleplay-store.js', import.meta.url).href;

function run(mode, { worker = false, preload = true } = {}) {
    const script = `
        import fs, { fstatSync as namedFstat } from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        const mode = ${JSON.stringify(mode)};
        const originals = Object.fromEntries(['statSync', 'lstatSync', 'fstatSync'].map(name => [name, fs[name]]));
        for (const [name, original] of Object.entries(originals)) fs[name] = (...args) => {
            const stat = original(...args);
            if (stat && typeof stat.dev === 'bigint') {
                if (mode !== 'native') stat.birthtimeNs = mode === 'zero' ? 0n : stat.ctimeNs + (mode === 'inconsistent' ? 1n : 0n);
                stat.birthtimeMs = stat.birthtimeNs / 1000000n;
                if (String(args[0]).endsWith('other-device')) stat.dev += 1000n;
            }
            return stat;
        };
        if (mode === 'bun') globalThis.Bun = {};
        const result = {};
        const cleanup = [];
        const info = console.info; console.info = () => {};
        try {
            ${preload ? `await import(${JSON.stringify(adapter)});` : ''}
            const { fixture } = await import(${JSON.stringify(fixture)});
            const { retainUploadedArchive, readUploadedArchive } = await import(${JSON.stringify(inputs)});
            const { inspectRoleplayFile } = await import(${JSON.stringify(store)});
            const f = fixture({ after: fn => cleanup.push(fn) });
            const file = path.join(f.root, 'upload.zip');
            const bytes = Buffer.from('Complete uploaded bytes');
            fs.writeFileSync(file, bytes);
            const fd = fs.openSync(file, 'r');
            const initial = fs.statSync(file, { bigint: true });
            result.plainStatUntouched = typeof fs.statSync(file).birthtimeMs === 'number';
            fs.renameSync(file, file + '.moved');
            fs.appendFileSync(file + '.moved', 'more');
            fs.chmodSync(file + '.moved', 0o600);
            const moved = fs.lstatSync(file + '.moved', { bigint: true });
            result.birthtimes = [initial, moved, fs.fstatSync(fd, { bigint: true }), namedFstat(fd, { bigint: true })]
                .map(stat => String(stat.birthtimeNs));
            fs.closeSync(fd);
            result.sameInode = initial.ino === moved.ino;
            result.changedCtime = initial.ctimeNs !== moved.ctimeNs;
            const other = path.join(f.root, 'other-device'); fs.writeFileSync(other, 'other');
            result.otherDeviceUntouched = fs.statSync(other, { bigint: true }).birthtimeNs !== 0n;
            const base = { owner: 'fixture', directories: f.scope.directories };
            try {
                const saved = await retainUploadedArchive(base, f.scope, 'new-upload', file + '.moved');
                result.retained = fs.readFileSync(saved.filename).equals(Buffer.concat([bytes, Buffer.from('more')]));
                result.readback = readUploadedArchive(base, f.scope, 'new-upload').id === saved.id;
                fs.writeFileSync(saved.filename, 'different bytes');
                try { readUploadedArchive(base, f.scope, 'new-upload'); } catch { result.refusedChangedBytes = true; }
                const source = path.join(f.root, 'source'); fs.writeFileSync(source, 'same bytes');
                const original = inspectRoleplayFile(source, 100);
                fs.renameSync(source, source + '.old'); fs.writeFileSync(source, 'same bytes');
                const replacement = inspectRoleplayFile(source, 100);
                result.replacementStillDifferent = original.physical.ino !== replacement.physical.ino;
            } catch (error) { result.uploadError = error.message; }
        } catch (error) { result.setupError = error.message; }
        finally { Object.assign(fs, originals); for (const fn of cleanup.reverse()) fn(); console.info = info; }
        process.stdout.write(JSON.stringify(result));
    `;
    const launch = worker ? `import { Worker } from 'node:worker_threads'; new Worker(new URL('data:text/javascript,' + encodeURIComponent(${JSON.stringify(script)})));` : script;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', launch], {
        encoding: 'utf8', env: { ...process.env, TERMUX_VERSION: mode === 'desktop' ? '' : 'fixture' },
    }));
}

for (const options of [{}, { worker: true }]) {
    test(`Termux preload preserves imports and byte/identity checks (${JSON.stringify(options)})`, () => {
        const result = run('ctime', options);
        assert.equal(result.setupError, undefined);
        assert.equal(result.uploadError, undefined);
        assert.deepEqual(result.birthtimes, ['0', '0', '0', '0']);
        for (const key of ['plainStatUntouched', 'sameInode', 'changedCtime', 'otherDeviceUntouched', 'retained', 'readback',
            'refusedChangedBytes', 'replacementStillDifferent']) assert.equal(result[key], true, key);
    });
}

test('the unpatched Termux timestamp behaviour reproduces the reported import failure', () => {
    const result = run('ctime', { preload: false });
    assert.match(result.uploadError, /retained upload was replaced or is incomplete/);
});

test('Termux with real creation times keeps them unchanged', () => {
    const result = run('native');
    assert.equal(result.setupError, undefined);
    assert.equal(result.retained, true);
    assert.notEqual(result.birthtimes[0], '0');
    assert.equal(new Set(result.birthtimes).size, 1);
});

test('Termux which already reports zero creation times imports without another fallback', () => {
    const result = run('zero');
    assert.equal(result.setupError, undefined);
    assert.equal(result.retained, true);
    assert.deepEqual(result.birthtimes.slice(0, 3), ['0', '0', '0']);
});

for (const mode of ['desktop', 'bun']) {
    test(`the adapter does not replace ${mode} file timestamps`, () => {
        const result = run(mode);
        assert.notEqual(result.birthtimes[0], '0');
        assert.notEqual(result.birthtimes[0], result.birthtimes[1]);
        assert.match(result.uploadError, /retained upload was replaced or is incomplete/);
    });
}

test('unexplained creation-time changes stop startup instead of discarding identity checks', () => {
    const result = run('inconsistent');
    assert.match(result.setupError, /inconsistent file creation times/);
});
