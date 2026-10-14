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

function runModule(script) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `import {initialiseCrashDiagnostics,installCrashHandlers,setCrashContext} from ${JSON.stringify(moduleUrl)}; ${script}`], { encoding: 'utf8' });
}

test('errors during a fatal shutdown are printed without replacing the original report', t => {
    const root = temporary(t);
    const result = runModule(`initialiseCrashDiagnostics(${JSON.stringify(root)}); installCrashHandlers();
        setCrashContext({ shutdown: () => new Promise(() => setTimeout(() => process.exit(1), 200)) });
        setImmediate(() => { for (let i = 0; i < 12; i++) setTimeout(() => { throw new Error('later ' + i); }, 10); throw new Error('original'); });`);
    assert.equal(result.status, 1, result.stderr);
    const reports = getCrashReports(path.join(root, 'crash-reports'));
    assert.deepEqual(reports.map(report => report.error.message), ['original']);
    assert.match(result.stderr, /Further uncaught-exception while shutting down/);
    assert.match(result.stderr, /later 11/);
});

test('client disconnects are logged as ignored instead of crashing or saving reports', t => {
    const root = temporary(t);
    const result = runModule(`initialiseCrashDiagnostics(${JSON.stringify(root)}); installCrashHandlers();
        setImmediate(() => { throw Object.assign(new Error('socket hang up token=private-value'), { code: 'ECONNRESET' }); });
        setTimeout(() => process.exit(0), 50);`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Ignored streaming disconnect error: socket hang up/);
    assert.doesNotMatch(result.stderr, /private-value/);
    assert.equal(getCrashReports(path.join(root, 'crash-reports')).length, 0);
});

test('an exit before the data folder is known writes nothing into the install folder', t => {
    const cwd = temporary(t);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {installCrashHandlers} from ${JSON.stringify(moduleUrl)}; installCrashHandlers(); process.exit(2);`], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(fs.readdirSync(cwd), []);
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

function browser(storage, broken = false, session = new Map(), options = {}) {
    const listeners = new Map();
    const add = (type, listener) => {
        const old = listeners.get(type);
        listeners.set(type, (...args) => { old?.(...args); listener(...args); });
    };
    const context = {
        window: null, document: { addEventListener: add, getElementById() { return null; }, visibilityState: 'visible', wasDiscarded: options.discarded === true },
        navigator: { userAgent: 'test', onLine: true }, performance: {},
        TextEncoder,
        localStorage: {
            getItem: key => storage.get(key), setItem: (key, value) => { if (broken) throw new Error('Quota'); storage.set(key, value); },
            removeItem: key => storage.delete(key),
            get length() { return storage.size; }, key: index => Array.from(storage.keys())[index],
        },
        sessionStorage: { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value) },
        addEventListener: add,
    };
    if (options.clock) Object.assign(context, options.clock.globals);
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

test('a repeating browser error is counted on one report instead of evicting earlier ones', () => {
    const storage = new Map();
    const first = browser(storage);
    first.listeners.get('unhandledrejection')({ reason: new Error('first failure') });
    const loop = new Error('render loop');
    first.listeners.get('error')({ error: loop, filename: 'https://host/b.js', lineno: 1, colno: 1 });
    for (let i = 0; i < 50; i++) first.listeners.get('error')({ error: loop, filename: 'https://host/a.js', lineno: 1, colno: 1 });
    // 50 is not a power of two, so only the page-hide save stores the final count.
    first.listeners.get('pagehide')();
    const reports = browser(storage).api.getReports().reports;
    assert.deepEqual(Array.from(reports, report => [report.error.message, report.context.source, report.repeats]), [
        ['first failure', '', undefined],
        ['render loop', 'https://host/b.js', undefined],
        ['render loop', 'https://host/a.js', 50],
    ]);
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
    if (store.needsExit("9999999999999-exit-1", "NO TRACE")) throw new AssertionError("decoded twice");
    store.saveExit("9999999999998-exit-2", "NO TRACE", false);
    if (!store.needsExit("9999999999998-exit-2", "NO TRACE")) throw new AssertionError("trace never retried");
    if (store.needsExit("0000000000001-exit-3", "NO TRACE")) throw new AssertionError("evicted report recreated");
    if (!store.needsExit("9999999999997-exit-4", "NO TRACE")) throw new AssertionError("new exit skipped");
    System.out.println("passed");
} }`);
    execFileSync('javac', ['-d', root, source, path.resolve('android/app/src/main/java/io/github/platberlitz/neconyan/CrashReport.java'), harness]);
    assert.match(execFileSync('java', ['-cp', root, 'io.github.platberlitz.neconyan.StoreTest', root], { encoding: 'utf8' }), /passed/);
});

test('activity allowlist does not invoke getters or retain application secrets', () => {
    let accessed = false;
    const api = globalThis.NeconyanCrashDiagnostics;
    const result = api.validateActivity({ mode: 'roleplay', character: 'private character', prompt: 'private prompt',
        get view() { accessed = true; throw new Error('getter'); },
        chat: { messageCount: -1, estimatedTextBytes: Infinity, title: 'private title' },
        agents: { running: Array.from({ length: 100 }, () => ({ label: 'private agent name', phase: 'post', location: 'server' })) } });
    assert.equal(accessed, false);
    assert.equal(result.chat.messageCount, null);
    assert.equal(result.chat.estimatedTextBytes, null);
    assert.equal(result.agents.running.length, 8);
    assert.equal(result.agents.omittedRunningCount, 92);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
    assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('parallel browser Agent handles preserve peers and expose only trusted labels', () => {
    const { api } = browser(new Map());
    const first = api.beginAgent({ id: 'secret-id', name: 'secret name', sourceTemplateId: 'tpl-format-fixer', phase: 'post' });
    const second = api.beginAgent({ id: 'another-secret', sourceTemplateId: 'tpl-proofreader', phase: 'post' });
    api.endAgent(first);
    assert.equal(api.getActivity().snapshot.agents.running[0].label, 'Proofreader');
    api.endAgent(second, 'cancel');
    assert.equal(api.getActivity().snapshot.agents.running.length, 0);
    assert.doesNotMatch(JSON.stringify(api.getActivity()), /secret/);
});

test('same-tab recovery retains the old sample, while clean reload and other tabs stay silent', () => {
    const storage = new Map(), session = new Map();
    const first = browser(storage, false, session);
    first.api.updateActivity({ mode: 'roleplay', chat: { messageCount: 58, estimatedTextBytes: 24000 } });
    first.api.beginAgent({ id: 'a', sourceTemplateId: 'tpl-proofreader', phase: 'post' });
    first.api.flushActivity('test');
    const second = browser(storage, false, session);
    const report = second.api.getReports().recoveries.at(-1);
    assert.equal(report.kind, 'unclean-previous-page');
    assert.equal(report.lastKnownActivity.snapshot.chat.messageCount, 58);
    assert.equal(report.lastKnownActivity.snapshot.agents.running[0].label, 'Proofreader');
    assert.match(report.error.message, /did not provide a definite cause/);
    // Device details measured when the page reopened, bounded and labelled.
    assert.equal(report.environment.measured, 'on-recovery');
    assert.equal(report.environment.userAgent, 'test');
    assert.equal(report.environment.deviceMemory, null);
    assert.ok(JSON.stringify(report).length < 8192);
    const count = second.api.getReports().recoveries.length;
    second.listeners.get('pagehide')({ persisted: false });
    const third = browser(storage, false, session);
    assert.equal(third.api.getReports().recoveries.length, count);
    assert.equal(browser(storage).api.getReports().recoveries.length, count);
});

test('BFCache suspends the marker and reactivates the same document without a recovery report', () => {
    const storage = new Map(), session = new Map();
    const first = browser(storage, false, session);
    first.api.flushActivity('test');
    first.listeners.get('pagehide')({ persisted: true });
    const key = 'neconyan.crash-session.v1:' + session.get('neconyan.crash-tab.v1');
    assert.equal(JSON.parse(storage.get(key)).state, 'suspended');
    first.listeners.get('pageshow')({ persisted: true });
    first.api.flushActivity('test');
    assert.equal(JSON.parse(storage.get(key)).state, 'running');
});

test('legacy reports receive stable IDs and discard evidence works without a previous marker', () => {
    const storage = new Map([['neconyan.crash-reports.v1', JSON.stringify([{ schema: 1, runtime: 'browser', kind: 'old', at: '2026-10-13', startedAt: 1, error: { message: 'Legacy error' } }])]]);
    assert.equal(browser(storage).api.getReports().reports[0].id, browser(storage).api.getReports().reports[0].id);
    const discarded = browser(new Map(), false, new Map(), { discarded: true }).api.getReports().recoveries[0];
    assert.equal(discarded.kind, 'discarded-previous-page');
    assert.equal(discarded.lastKnownActivity.snapshot.at, null);
    assert.equal(discarded.lastKnownActivity.relationship, 'unavailable');
});

test('forty unclean launches retain no more than eight newest tab records', () => {
    const storage = new Map();
    for (let index = 0; index < 40; index++) browser(storage).api.flushActivity('fixture');
    assert.ok(Array.from(storage.keys()).filter(key => key.startsWith('neconyan.crash-session.v1:')).length <= 8);
    storage.set('neconyan.crash-session.v1:expired', JSON.stringify({ schema: 1, documentId: 'expired', state: 'running', heartbeatAt: Date.now() - 8 * 86400000 }));
    browser(storage);
    assert.equal(storage.has('neconyan.crash-session.v1:expired'), false);
});

test('background recovery stays separate from five retained real errors', () => {
    const storage = new Map(), session = new Map();
    const first = browser(storage, false, session);
    for (let index = 0; index < 5; index++) first.api.capture('error', new Error(`real error ${index}`));
    first.context.document.visibilityState = 'hidden'; first.api.flushActivity('fixture');
    const next = browser(storage, false, session);
    assert.equal(next.api.getReports().reports.length, 5);
    assert.equal(next.api.getReports().reports[0].error.message, 'real error 0');
    assert.equal(next.api.getReports().recoveries.length, 1);
    assert.equal(next.api.getReports().recoveries[0].lastKnownActivity.snapshot.visibility, 'hidden');
});

test('JS visibility and custom Agent numbering agree with the native validator', () => {
    const { api } = browser(new Map());
    assert.equal(api.validateActivity({}).visibility, 'unknown');
    api.beginAgent({ id: 'builtin', sourceTemplateId: 'tpl-proofreader', phase: 'post' });
    api.beginAgent({ id: 'combined', synthesis: true, phase: 'synthesis' });
    api.beginAgent({ id: 'private-custom', phase: 'post' });
    assert.equal(api.getActivity().snapshot.agents.running.at(-1).label, 'Custom agent 1');
    const phases = browser(new Map()).api;
    for (let index = 0; index < 32; index++) phases.observePhase(index, 'generating');
    phases.observePhase(31, 'saving');
    assert.equal(phases.getActivity().snapshot.generation.phase, 'saving');
    phases.observePhase(32, 'generating');
    assert.equal(phases.getActivity().snapshot.generation.phase, 'saving');
});

test('job observers deduplicate peers and main generation end cannot clear a running post Agent', () => {
    const { api } = browser(new Map());
    const a = {}, b = {}, state = { schema: 1, agents: { running: [{ label: 'Proofreader', phase: 'post', location: 'server' }] } };
    api.observeJobActivity('job', a, state); api.observeJobActivity('job', b, state);
    api.updateActivity({ generation: { phase: 'idle' } });
    assert.equal(api.getActivity().snapshot.generation.phase, 'post-agents');
    assert.equal(api.getActivity().snapshot.agents.running.length, 1);
    api.observeJobActivity('job', a, null);
    assert.equal(api.getActivity().snapshot.agents.running.length, 1);
    api.observeJobActivity('job', b, null);
    assert.equal(api.getActivity().snapshot.agents.running.length, 0);
});

test('normal writes coalesce at five seconds; visible heartbeat and hidden/BFCache suspension are bounded', () => {
    let now = 10000, id = 0;
    const timers = new Map(), storage = new Map(), session = new Map();
    const clock = { globals: {
        Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
        setTimeout: (callback, delay) => { const handle = ++id; timers.set(handle, { at: now + delay, callback }); return handle; },
        clearTimeout: handle => timers.delete(handle),
    } };
    const advance = duration => {
        const end = now + duration;
        for (;;) {
            const next = Array.from(timers.entries()).filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at; timers.delete(next[0]); next[1].callback();
        }
        now = end;
    };
    const fixture = browser(storage, false, session, { clock });
    const key = 'neconyan.crash-session.v1:' + session.get('neconyan.crash-tab.v1');
    advance(0); assert.equal(JSON.parse(storage.get(key)).heartbeatAt, 10000);
    for (let index = 0; index < 100; index++) fixture.api.noteActivity('generation-start');
    advance(4999); assert.equal(JSON.parse(storage.get(key)).heartbeatAt, 10000);
    advance(1); assert.equal(JSON.parse(storage.get(key)).heartbeatAt, 15000);
    fixture.context.document.visibilityState = 'hidden'; fixture.listeners.get('visibilitychange')();
    advance(60000); assert.equal(JSON.parse(storage.get(key)).heartbeatAt, 15000);
    fixture.context.document.visibilityState = 'visible'; fixture.listeners.get('visibilitychange')(); advance(0);
    advance(30000); assert.equal(JSON.parse(storage.get(key)).heartbeatAt, 105000);
    fixture.listeners.get('pagehide')({ persisted: true }); advance(60000);
    assert.equal(JSON.parse(storage.get(key)).state, 'suspended');
    fixture.listeners.get('pageshow')({ persisted: true }); advance(0);
    assert.equal(JSON.parse(storage.get(key)).state, 'running');
});
