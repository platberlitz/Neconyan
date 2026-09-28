import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fileStats = new URL('../android/file-stats.mjs', import.meta.url).href;

// file-stats.mjs patches fs for the whole process, so each case runs in its own
// Node process that pretends to be Android with a stand-in native binding.
function runAsAndroid(mode, statePath) {
    const script = `
        Object.defineProperty(process, 'platform', { value: 'android' });
        const fs = (await import('node:fs')).default;
        const path = (await import('node:path')).default;
        const real = { statSync: fs.statSync, lstatSync: fs.lstatSync, fstatSync: fs.fstatSync };
        const mode = ${JSON.stringify(mode)};
        process._linkedBinding = () => ({ physical(target, follow) {
            if (mode === 'no-creation-times') return null;
            const stat = typeof target === 'number' ? real.fstatSync(target, { bigint: true }) : real[follow ? 'statSync' : 'lstatSync'](target, { bigint: true });
            return { dev: String(stat.dev), ino: String(mode === 'swapped' ? stat.ino + 1n : stat.ino), birthtimeNs: '1700000000123456789' };
        } });
        const { verifyAndroidStorage } = await import(${JSON.stringify(fileStats)});
        const statePath = ${JSON.stringify(statePath)};
        const result = {};
        try { result.storage = verifyAndroidStorage(statePath, process._linkedBinding()); } catch (error) { result.storageError = error.message; }
        result.leftovers = fs.readdirSync(statePath);
        const file = path.join(statePath, 'chat.jsonl');
        fs.writeFileSync(file, 'first');
        try {
            const fd = fs.openSync(file, 'r');
            const first = fs.statSync(file, { bigint: true });
            fs.renameSync(file, file + '.moved');
            fs.appendFileSync(file + '.moved', 'second');
            fs.chmodSync(file + '.moved', 0o600);
            const moved = fs.lstatSync(file + '.moved', { bigint: true });
            const described = fs.fstatSync(fd, { bigint: true });
            fs.closeSync(fd);
            result.birthtimes = [first, moved, described].map(stat => String(stat.birthtimeNs));
            result.birthtimeMs = String(moved.birthtimeMs);
            result.sameInode = first.ino === moved.ino && moved.ino === described.ino;
            result.changedCtime = first.ctimeNs !== moved.ctimeNs;
            result.plainStatUntouched = typeof fs.statSync(file + '.moved').birthtimeMs === 'number';
        } catch (error) { result.statError = error.code; }
        process.stdout.write(JSON.stringify(result));
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
}

function withStatePath(run) {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-android-stats-'));
    try { return run(statePath); } finally { fs.rmSync(statePath, { recursive: true, force: true }); }
}

test('Android storage without creation times starts and keeps a stable zero birthtime', () => withStatePath(statePath => {
    const result = runAsAndroid('no-creation-times', statePath);
    assert.equal(result.storageError, undefined);
    assert.deepEqual(result.storage, { creationTimes: false });
    assert.deepEqual(result.leftovers, []);
    assert.deepEqual(result.birthtimes, ['0', '0', '0']);
    assert.equal(result.birthtimeMs, '0');
    assert.equal(result.sameInode, true);
    assert.equal(result.changedCtime, true, 'the rename, append and chmod should move ctime, which libuv would otherwise report');
    assert.equal(result.plainStatUntouched, true);
}));

test('Android storage with creation times reports the native birthtime', () => withStatePath(statePath => {
    const result = runAsAndroid('creation-times', statePath);
    assert.deepEqual(result.storage, { creationTimes: true });
    assert.deepEqual(result.leftovers, []);
    assert.deepEqual(result.birthtimes, ['1700000000123456789', '1700000000123456789', '1700000000123456789']);
    assert.equal(result.birthtimeMs, '1700000000123');
}));

test('Android stats refuse a native answer for a different inode', () => withStatePath(statePath => {
    const result = runAsAndroid('swapped', statePath);
    assert.match(result.storageError, /identity changed/);
    assert.deepEqual(result.leftovers, []);
    assert.equal(result.statError, 'ESTALE');
}));
