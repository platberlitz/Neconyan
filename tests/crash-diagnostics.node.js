/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import vm from 'node:vm';
import { getCrashReports, writeCrashReport } from '../src/crash-diagnostics.js';

const { describeError, redact } = globalThis.NeconyanCrashDiagnostics;
const moduleUrl = new URL('../src/crash-diagnostics.js', import.meta.url).href;
const browserSource = fs.readFileSync(new URL('../public/scripts/crash-diagnostics.js', import.meta.url), 'utf8');
function temporary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-crashes-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('retains diagnostic error fields and nested causes while redacting credentials', () => {
    const error = new Error('Write failed password="secret phrase"', { cause: Object.assign(new Error('Disk full'), { code: 'ENOSPC', syscall: 'write' }) });
    error.errors = [new Error('https://alice:pass@host/api?token=query-secret#fragment'), error];
    const result = describeError(error);
    assert.equal(result.cause.code, 'ENOSPC');
    assert.equal(result.cause.syscall, 'write');
    assert.match(result.stack, /crash-diagnostics.node.js/);
    assert.doesNotMatch(JSON.stringify(result), /secret phrase|query-secret|alice:pass|fragment/);
    assert.equal(result.errors[1].omitted, 'Circular cause');
    assert.equal(redact('Authorization: Bearer abcd1234'), 'Authorization: [redacted] [redacted]');
    assert.equal(redact('password="' + 'private phrase '.repeat(2000)), 'password=[redacted]');
    assert.equal(redact('token=private-value'), 'token=[redacted]');
    assert.doesNotThrow(() => describeError(new Proxy({}, { get() { throw new Error('getter'); } })));
});

test('bounds adversarial aggregate errors before serialising them', () => {
    const build = depth => ({ message: 'x'.repeat(20000), errors: depth ? Array.from({ length: 8 }, () => build(depth - 1)) : [] });
    assert.ok(JSON.stringify(describeError(build(3))).length < 50000);
});

test('fatal exceptions and rejections save a report before a nonzero process exit', t => {
    for (const trigger of ['throw new Error(\'outer\', { cause: new Error(\'inner\') })', 'Promise.reject(new Error(\'rejected\'))']) {
        const root = temporary(t);
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {initialiseCrashDiagnostics,installCrashHandlers} from ${JSON.stringify(moduleUrl)}; initialiseCrashDiagnostics(${JSON.stringify(root)}); installCrashHandlers(); setImmediate(() => {${trigger}});`], { encoding: 'utf8' });
        assert.equal(result.status, 1, result.stderr);
        const reports = getCrashReports(path.join(root, 'crash-reports'));
        assert.equal(reports.length, 1);
        assert.ok(reports[0].environment.memory.rss > 0);
        assert.match(reports[0].kind, /uncaught-exception|unhandled-rejection/);
        assert.equal(fs.readdirSync(path.join(root, 'crash-reports')).filter(name => name.startsWith('running-')).length, 0);
    }
});

test('an externally killed process leaves a recoverable record without inventing an OOM cause', async t => {
    const root = temporary(t);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {initialiseCrashDiagnostics,installCrashHandlers} from ${JSON.stringify(moduleUrl)}; initialiseCrashDiagnostics(${JSON.stringify(root)}); installCrashHandlers(); console.log('ready'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await once(child.stdout, 'data');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recover = spawnSync(process.execPath, ['--input-type=module', '-e', `import {initialiseCrashDiagnostics,installCrashHandlers} from ${JSON.stringify(moduleUrl)}; initialiseCrashDiagnostics(${JSON.stringify(root)}); installCrashHandlers();`], { encoding: 'utf8' });
    assert.equal(recover.status, 0, recover.stderr);
    const reports = getCrashReports(path.join(root, 'crash-reports'));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].kind, 'unclean-previous-exit');
    assert.match(reports[0].error.message, /did not supply a cause/);
    assert.equal(reports[0].previous.pid, child.pid);
});

test('a fatal error still prints diagnostic details when its report cannot be saved', t => {
    const root = path.join(temporary(t), 'not-a-directory');
    fs.writeFileSync(root, 'occupied');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {initialiseCrashDiagnostics,installCrashHandlers} from ${JSON.stringify(moduleUrl)}; initialiseCrashDiagnostics(${JSON.stringify(root)}); installCrashHandlers(); throw new Error('Disk failure password=private-value');`], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not save crash diagnostics/);
    assert.match(result.stderr, /Disk failure/);
    assert.doesNotMatch(result.stderr, /private-value/);
});

test('retains ten private reports and ignores damaged files', t => {
    const directory = temporary(t);
    for (let i = 0; i < 12; i++) assert.ok(writeCrashReport('test', new Error(`Failure ${i}`), {}, directory));
    assert.equal(getCrashReports(directory).length, 10);
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, '{');
    assert.equal(getCrashReports(directory).length, 9);
});

function browser(storage, broken = false) {
    const listeners = new Map();
    const context = {
        window: null, document: { addEventListener() {}, getElementById() { return null; }, visibilityState: 'visible' },
        navigator: { userAgent: 'test', onLine: true }, performance: {},
        localStorage: {
            getItem: key => storage.get(key), setItem: (key, value) => { if (broken) throw new Error('Quota'); storage.set(key, value); },
            removeItem: key => storage.delete(key),
        },
        addEventListener: (type, listener) => listeners.set(type, listener),
    };
    context.window = context;
    vm.runInNewContext(browserSource, context);
    return { api: context.NeconyanCrashDiagnostics, listeners, context };
}

test('browser exceptions persist across reload, bounded and independent of the debugger', () => {
    const storage = new Map();
    const first = browser(storage);
    for (let i = 0; i < 7; i++) first.listeners.get('unhandledrejection')({ reason: new Error(`failure ${i}`) });
    const next = browser(storage);
    assert.equal(next.api.getReports().reports.length, 5);
    assert.equal(next.api.getReports().reports.at(-1).error.message, 'failure 6');
    assert.equal(next.api.clear(), true);
    assert.equal(browser(storage).api.getReports().reports.length, 0);
});

test('browser capture survives unavailable storage and reports the loss of persistence', () => {
    const fixture = browser(new Map(), true);
    fixture.listeners.get('error')({ error: new Error('failure'), filename: 'https://host/app.js?key=private', lineno: 10, colno: 20 });
    const result = fixture.api.getReports();
    assert.equal(result.reports.length, 1);
    assert.match(result.storageError, /Could not save/);
    assert.equal(result.reports[0].context.line, 10);
    assert.doesNotMatch(JSON.stringify(result), /key=private/);
});

const hasJava = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;
test('Android report store survives recreation, limits retention and strips secrets', { skip: !hasJava }, t => {
    const root = temporary(t);
    const source = path.resolve('android/app/src/main/java/io/github/platberlitz/neconyan/DiagnosticStore.java');
    const harness = path.join(root, 'StoreTest.java');
    fs.writeFileSync(harness, `package io.github.platberlitz.neconyan;
import java.io.File;
public class StoreTest { public static void main(String[] args) {
    File dir = new File(args[0], "reports"); DiagnosticStore store = new DiagnosticStore(dir);
    for (int i = 0; i < 12; i++) if (!store.save("10000000000" + i, "Failure " + i + " password=secret-value\\n" + "x".repeat(70000))) throw new AssertionError("save failed");
    store = new DiagnosticStore(dir);
    if (store.files().length != 10) throw new AssertionError("retention");
    if (store.readAll().contains("secret-value")) throw new AssertionError("secret");
    if (store.save("../escape", "no")) throw new AssertionError("unsafe name");
    store.saveExit("9999999999999-exit-1", "native trace evidence", true);
    store.saveExit("9999999999999-exit-1", "trace no longer available", false);
    if (!store.readAll().contains("native trace evidence")) throw new AssertionError("lost trace");
    System.out.println("passed");
} }`);
    execFileSync('javac', ['-d', root, source, harness]);
    assert.match(execFileSync('java', ['-cp', root, 'io.github.platberlitz.neconyan.StoreTest', root], { encoding: 'utf8' }), /passed/);
});
