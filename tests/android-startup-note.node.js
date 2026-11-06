import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireDataRootOwner } from '../src/data-root-owner.js';
import { STARTUP_NOTE_PREFIX, startupNoteMessage, writeStartupNote } from '../src/startup-note.js';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const app = 'android/app/src/main/java/io/github/platberlitz/neconyan/';
const activity = read(`${app}MainActivity.java`);
const service = read(`${app}ServerService.java`);
const server = read('server.js');
const bootstrap = read('android/server-bootstrap.mjs');
const payload = read('scripts/build-android-payload.js');
const iosPayload = read('scripts/build-ios-payload.js');
const p = STARTUP_NOTE_PREFIX;

function block(source, start, end) {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `missing ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `missing ${end} after ${start}`);
    return source.slice(from, to);
}

function restore(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

test('the startup note names the failure without a stack', () => {
    const message = startupNoteMessage(new Error('boom'));
    assert.equal(message, 'Could not start Neconyan: boom. Saved data has been kept.');
    assert.doesNotMatch(message, /\n\s+at /);
    const stopped = startupNoteMessage(new Error('The data folder is already owned.'));
    assert.equal(stopped, 'Could not start Neconyan: The data folder is already owned. Saved data has been kept.');
    for (const text of [message, stopped]) assert.doesNotMatch(text, /\.\./);
});

test('a desktop start writes no note', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-note-desktop-'));
    const originalTmpdir = process.env.TMPDIR;
    const originalMarker = process.env.NECONYAN_ANDROID_APP;
    try {
        process.env.TMPDIR = directory;
        delete process.env.NECONYAN_ANDROID_APP;
        assert.equal(writeStartupNote(new Error('desktop')), false);
        assert.equal(fs.existsSync(path.join(directory, 'startup-status.txt')), false);
    } finally {
        restore('TMPDIR', originalTmpdir);
        restore('NECONYAN_ANDROID_APP', originalMarker);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('an Android start writes the note MainActivity reads', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-note-android-'));
    const originalTmpdir = process.env.TMPDIR;
    const originalMarker = process.env.NECONYAN_ANDROID_APP;
    try {
        process.env.NECONYAN_ANDROID_APP = '1';
        process.env.TMPDIR = directory;
        assert.equal(writeStartupNote(new Error('boom')), true);
        const file = path.join(directory, 'startup-status.txt');
        assert.equal(fs.readFileSync(file, 'utf8'), 'Could not start Neconyan: boom. Saved data has been kept.');
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
        restore('TMPDIR', originalTmpdir);
        restore('NECONYAN_ANDROID_APP', originalMarker);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a missing note directory returns false without throwing or creating it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-note-missing-'));
    const originalTmpdir = process.env.TMPDIR;
    const originalMarker = process.env.NECONYAN_ANDROID_APP;
    const nested = path.join(directory, 'missing', 'nested');
    try {
        process.env.NECONYAN_ANDROID_APP = '1';
        process.env.TMPDIR = nested;
        assert.equal(writeStartupNote(new Error('nowhere')), false);
        assert.equal(fs.existsSync(nested), false);
    } finally {
        restore('TMPDIR', originalTmpdir);
        restore('NECONYAN_ANDROID_APP', originalMarker);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('the startup catch writes the note before diagnostics, the log and the single exit', () => {
    const catcher = server.slice(server.indexOf('} catch (error) {\n'));
    const note = catcher.indexOf('writeStartupNote(error);');
    assert.notEqual(note, -1, 'the catch must write the startup note');
    assert.ok(note < catcher.indexOf('recordFatalError'), 'the note must precede diagnostics');
    assert.ok(note < catcher.indexOf('A critical error has occurred'), 'the note must precede the console log');
    assert.ok(note < catcher.indexOf('process.exit(1)'), 'the note must precede the exit');
    assert.equal((catcher.match(/process\.exit\(1\);/g) || []).length, 1);
});

test('the server and the bootstrap share the startup-note module', () => {
    assert.match(server, /import \{ writeStartupNote \} from '\.\/src\/startup-note\.js';/);
    assert.match(bootstrap, /import \{ startupNoteMessage \} from '\.\/src\/startup-note\.js';/);
});

test('the bootstrap monitor keeps its gate and formats with the shared message', () => {
    const monitor = block(bootstrap, 'process.on(\'uncaughtExceptionMonitor\'', 'if (process.platform === \'android\') {');
    assert.match(bootstrap, /if \(process\.platform === 'android'\) process\.on\('uncaughtExceptionMonitor'/);
    assert.match(monitor, /if \(started\) return;/);
    assert.match(monitor, /startupNoteMessage\(error\)/);
    assert.match(monitor, /writeFileAtomicSync\(path\.join\(process\.env\.TMPDIR, 'startup-status\.txt'\)/);
});

test('Java note checks use exactly the shared prefix', () => {
    assert.ok(activity.includes('text.startsWith("' + p + '")'));
    assert.ok(activity.includes('reason.startsWith("' + p + '")'));
    assert.ok(service.includes('"' + p + ' '));
    assert.doesNotMatch(activity, /Could not start Neconyan(?!:)/);
});

test('the failure page prefers the server note and both payloads stage src', () => {
    const summary = block(activity, 'private String failureSummary(String reason)', 'private ApplicationExitInfo lastServerExit');
    const note = summary.indexOf('reason.startsWith("' + p + '")');
    const incident = summary.indexOf('serverIncident != null');
    assert.notEqual(note, -1, 'failureSummary must recognise the note');
    assert.notEqual(incident, -1, 'failureSummary must keep the crash-record fallback');
    assert.ok(note < incident, 'the note reason must win over the crash record');
    assert.ok(fs.existsSync(new URL('../src/startup-note.js', import.meta.url)));
    assert.ok(payload.includes('^(public\\/|src\\/|'));
    assert.ok(iosPayload.includes('^(public\\/|src\\/|'));
});

test('the service preserves a note this start wrote', () => {
    const stop = block(service, 'int exit = startNode(', 'stopSelf();');
    assert.match(stop, /if \(!serverNoteWritten\(\)\) status\("Neconyan stopped \(" \+ exit \+ "\)\. Reopen the app to start it again\."\);/);
    assert.doesNotMatch(stop, /\n\s*status\("Neconyan stopped/);
    const helper = block(service, 'private boolean serverNoteWritten()', 'private File installPayload');
    assert.match(helper, /new File\(getCacheDir\(\), "startup-status\.txt"\)/);
    assert.ok(helper.includes('.startsWith("' + p + '")'));
    assert.ok(service.includes('status("Could not start Neconyan: " + error.getMessage()'));
});

test('a lease refusal reaches the startup note with the lease evidence', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-note-lease-'));
    const held = acquireDataRootOwner(directory, 'server');
    try {
        let refusal;
        try { acquireDataRootOwner(directory, 'server'); } catch (error) { refusal = error; }
        assert.ok(refusal, 'the second acquisition must be refused');
        const message = startupNoteMessage(refusal);
        assert.ok(message.includes(`Lease record: pid=${process.pid}`));
        assert.doesNotMatch(message, /\.\./);
        assert.ok(message.endsWith('Saved data has been kept.'));
    } finally {
        held.release();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('the server asks for the Android lease policy only through the app check', () => {
    assert.ok(server.includes('acquireDataRootOwner(globalThis.DATA_ROOT, \'server\', { androidAppServer: isAndroidAppServer(), iosAppServer })'));
    assert.ok(server.includes('if (lease.reclaimed) console.info(lease.reclaimed.message);'));
    assert.ok(server.includes('error.code === \'DATA_ROOT_OWNED\' && process.env.NECONYAN_ANDROID_APP !== \'1\''));
    const marker = bootstrap.indexOf('process.env.NECONYAN_ANDROID_APP = \'1\'');
    assert.notEqual(marker, -1);
    assert.ok(marker < bootstrap.indexOf('await import(\'./server.js\')'));
});
