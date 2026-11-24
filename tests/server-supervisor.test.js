/* global globalThis */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCrashReports } from '../src/crash-diagnostics.js';
import { SERVER_CRASH_BUILD_MESSAGE } from '../src/server-crash-evidence.js';
import { FATAL_REPORT_PRIVATE_TEXT, nodeFatalReport } from './fatal-report-fixture.js';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import envPaths from 'env-paths';
import {
    EXTERNAL_HEAP_OVERRIDE_ENV,
    hasExternalHeapFlag,
    parseMaxOldSpaceSizeMb,
    readConfiguredMaxOldSpaceSizeMb,
    resolveSupervisorConfigPath,
    RESTART_EXIT_CODE,
    resolveChildHeapArguments,
    runSupervisor as startSupervisor,
    SERVER_AUTO_RESTART_DELAY_MS,
    SERVER_PLUGIN_PREPARE_LEASE_MS,
    SERVER_PLUGIN_UPDATE_EXIT_CODE,
    shouldSupervise,
    SUPERVISOR_FORCE_KILL_TIMEOUT_MS,
    SUPERVISOR_RELOAD_EXIT_CODE,
    SUPERVISOR_SHUTDOWN_MESSAGE,
} from '../src/server-supervisor.js';
import {
    SERVER_MEMORY_SAMPLE_MESSAGE,
    SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE,
    SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
    SERVER_STARTUP_READY_MESSAGE,
} from '../src/server-plugin-update-ipc.js';

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.connected = true;
        this.exitCode = null;
        this.kill = jest.fn();
        this.send = jest.fn((_message, callback) => callback?.());
    }
}

function createSpawnPlan(exits) {
    const children = [];
    const spawnFn = jest.fn(() => {
        const child = new FakeChild();
        children.push(child);
        const exit = exits.shift() ?? [0, null];
        if (exit !== 'manual') {
            setImmediate(() => {
                child.exitCode = exit[0];
                child.emit('exit', exit[0], exit[1]);
            });
        }
        return child;
    });

    return { children, spawnFn };
}

function createPluginUpdateOperations() {
    return {
        validate: jest.fn(),
        apply: jest.fn(payload => ({ ...payload, backupPath: '/backup', logPath: '/update.log' })),
        discard: jest.fn(),
        discardPrepared: jest.fn(),
        finalize: jest.fn(),
        recover: jest.fn(),
        rollback: jest.fn(),
    };
}

function updatePayload() {
    return {
        transactionId: '11111111-1111-4111-8111-111111111111',
        expectedPluginId: 'example-plugin',
        pluginPath: '/plugins/ExamplePlugin',
    };
}

async function tick() {
    await new Promise(resolve => setImmediate(resolve));
}

// Bounded by wall-clock time, not by a count of event-loop turns: how many turns fit in a
// millisecond depends on the machine, and a real timer or module load can need more.
async function waitFor(condition, label, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

/** Restart-delay timers that only fire when the test says so, whatever the speed of the machine. */
function createManualTimers() {
    let last = 0;
    const scheduled = new Map();
    return {
        setTimer: (callback, ms) => {
            scheduled.set(++last, { callback, ms });
            return last;
        },
        clearTimer: handle => { scheduled.delete(handle); },
        get pending() { return Array.from(scheduled.values()); },
        async fireNext(label = 'the restart delay') {
            await waitFor(() => scheduled.size > 0, label);
            const [handle, timer] = scheduled.entries().next().value;
            scheduled.delete(handle);
            timer.callback();
        },
    };
}

const supervisors = [];

/** Starts a supervisor that endSupervisors can stop again if the test fails or gives up. */
function supervise(plan, options) {
    const entry = { plan, settled: false };
    entry.promise = Promise.resolve(startSupervisor(options)).finally(() => { entry.settled = true; });
    supervisors.push(entry);
    return entry.promise;
}

// Every test in this file starts its supervisor through here, so none can leave one behind.
// Default tests isolate from any host config.yaml unless useRealConfig is set.
function runSupervisor({ useRealConfig = false, ...options }) {
    const supervisorOptions = !useRealConfig && options.heapArguments === undefined && options.resolveHeapArguments === undefined
        ? { ...options, resolveHeapArguments: () => resolveChildHeapArguments({ execArgv: options.execArgv }) }
        : options;
    return supervise({ get children() { return options.spawnFn?.mock?.results?.map(result => result.value) ?? []; } }, supervisorOptions);
}

/**
 * A supervisor left running keeps its timers and signal handlers and prints into whichever test
 * runs next. Stop any that are left, then fail the test that left them.
 */
async function endSupervisors() {
    const leaked = supervisors.splice(0).filter(entry => !entry.settled);
    if (!leaked.length) return;
    process.emit('SIGTERM');
    for (const { plan } of leaked) {
        for (const child of plan.children) {
            if (child.exitCode === null && !child.signalCode) stopChild(child, 0, null);
        }
    }
    await waitFor(() => leaked.every(entry => entry.settled), 'a leaked supervisor to stop');
    throw new Error(`${leaked.length} supervisor(s) were still running when the test ended`);
}

const MIB = 1024 * 1024;

function memorySample(overrides = {}) {
    return {
        at: new Date().toISOString(), uptimeSeconds: 30, rss: 300 * MIB, heapUsed: 200 * MIB, heapTotal: 250 * MIB, heapLimit: 1024 * MIB,
        external: 10 * MIB, arrayBuffers: 2 * MIB, deviceAvailable: 4096 * MIB, deviceTotal: 12288 * MIB, ...overrides,
    };
}

function announceStartup(child) {
    child.emit('message', { type: SERVER_STARTUP_READY_MESSAGE, plugins: [] });
}

function stopChild(child, code, signal) {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
}

const TRACKED_EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'exit'];

describe('server supervisor', () => {
    const savedListeners = new Map();

    beforeEach(() => {
        for (const signal of TRACKED_EVENTS) {
            savedListeners.set(signal, process.listeners(signal));
            process.removeAllListeners(signal);
        }
    });

    // eslint-disable-next-line playwright/no-duplicate-hooks -- this is a Jest suite; the Playwright rule misclassifies the signal tests below
    afterEach(async () => {
        jest.useRealTimers();
        try {
            await endSupervisors();
        } finally {
            restoreSignalListeners();
        }
    });

    function restoreSignalListeners() {
        for (const signal of TRACKED_EVENTS) {
            process.removeAllListeners(signal);
            for (const listener of savedListeners.get(signal) ?? []) {
                process.on(signal, listener);
            }
        }
    }

    test('shouldSupervise lets launchers wrap one built-in supervisor', () => {
        expect(shouldSupervise({})).toBe(true);
        expect(shouldSupervise({ NECONYAN_LAUNCHER: '1' })).toBe(true);
        expect(shouldSupervise({ NECONYAN_SUPERVISED: '1' })).toBe(false);
        expect(shouldSupervise({ NECONYAN_LAUNCHER: '', NECONYAN_SUPERVISED: '' })).toBe(true);
    });

    test('marks the child as supervised and forwards runtime flags', async () => {
        const { spawnFn } = createSpawnPlan([[0, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['bun', 'server.js', '--listen'], execArgv: ['--smol'], spawnFn, exitFn });

        expect(spawnFn).toHaveBeenCalledTimes(1);
        const [command, args, options] = spawnFn.mock.calls[0];
        expect(command).toBe('bun');
        expect(args).toEqual(['--smol', 'server.js', '--listen']);
        expect(options.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
        expect(options.env.NECONYAN_SUPERVISED).toBe('1');
        expect(options.env[SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV]).toBe(SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION);
        expect(options.env.NECONYAN_SKIP_BROWSER_AUTO_LAUNCH).toBeUndefined();
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test.each([
        [false, 'SIGKILL', null, true],
        [true, 'SIGKILL', null, true],
        [false, null, 2, true],
        [false, null, 2, false],
    ])('handles a stopped child without duplicate reports (requested: %s, signal: %s, code: %s, marker: %s)', async (requested, signal, code, markerPresent) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-supervisor-crash-'));
        try {
            const { children, spawnFn } = createSpawnPlan(['manual']);
            const exitFn = jest.fn();
            const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
            await tick();
            children[0].pid = 123456;
            if (markerPresent) fs.writeFileSync(path.join(directory, 'running-123456.json'), '{}');
            children[0].emit('message', { type: 'neconyan:crash-directory', directory });
            if (requested) process.emit('SIGTERM');
            children[0].emit('exit', code, signal);
            await run;
            expect(exitFn).toHaveBeenCalledWith(signal ? 1 : code);
            expect(getCrashReports(directory)).toHaveLength(requested || !markerPresent ? 0 : 1);
            expect(getCrashReports(directory).map(report => report.child)).toEqual(requested || !markerPresent ? [] : [{ pid: 123456, signal, exitCode: code }]);
            expect(fs.existsSync(path.join(directory, 'running-123456.json'))).toBe(false);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    test('recovers interrupted plugin transactions before launching the server', async () => {
        const { spawnFn } = createSpawnPlan([[0, null]]);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();

        await runSupervisor({
            argv: ['node', 'server.js'],
            execArgv: [],
            spawnFn,
            exitFn,
            pluginUpdate,
            pluginsRoot: '/managed/plugins',
        });

        expect(pluginUpdate.recover).toHaveBeenCalledWith('/managed/plugins');
        expect(pluginUpdate.recover.mock.invocationCallOrder[0]).toBeLessThan(spawnFn.mock.invocationCallOrder[0]);
    });

    test('respawns on the restart exit code and suppresses the browser auto-launch', async () => {
        const { spawnFn } = createSpawnPlan([[RESTART_EXIT_CODE, null], [RESTART_EXIT_CODE, null], [0, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        expect(spawnFn).toHaveBeenCalledTimes(3);
        expect(spawnFn.mock.calls[0][2].env.NECONYAN_SKIP_BROWSER_AUTO_LAUNCH).toBeUndefined();
        expect(spawnFn.mock.calls[1][2].env.NECONYAN_SKIP_BROWSER_AUTO_LAUNCH).toBe('1');
        expect(spawnFn.mock.calls[2][2].env.NECONYAN_SKIP_BROWSER_AUTO_LAUNCH).toBe('1');
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('applies a queued plugin update after cleanup and finalizes it only after the plugin loads', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: ['--max-old-space-size=2048'], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-1', payload });
        expect(pluginUpdate.validate).toHaveBeenCalledWith(payload);
        expect(children[0].send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'prepare-1', ok: true }), expect.any(Function));

        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();

        expect(pluginUpdate.apply).toHaveBeenCalledWith(payload);
        expect(spawnFn).toHaveBeenCalledTimes(2);
        expect(spawnFn.mock.calls[1][1]).toEqual(['--max-old-space-size=2048', 'server.js']);
        children[1].emit('message', {
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins: [{ id: 'example-plugin', directoryPath: '/plugins/ExamplePlugin' }],
        });
        await tick();
        expect(pluginUpdate.finalize).toHaveBeenCalledWith(expect.objectContaining({ expectedPluginId: 'example-plugin' }));

        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
        await run;
        expect(pluginUpdate.rollback).not.toHaveBeenCalled();
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('survives an asynchronous IPC response failure', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();
        children[0].send.mockImplementation((_message, callback) => callback(new Error('IPC closed')));

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-closed', payload });
        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;

        expect(pluginUpdate.discardPrepared).toHaveBeenCalledWith(payload);
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('keeps the activated server running when final lock cleanup fails', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        pluginUpdate.finalize.mockImplementation(() => {
            const error = new Error('lock cleanup failed');
            error.serverPluginActivationRecorded = true;
            throw error;
        });
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-cleanup', payload });
        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();
        children[1].emit('message', {
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins: [{ id: 'example-plugin', directoryPath: '/plugins/ExamplePlugin' }],
        });
        await tick();

        expect(exitFn).not.toHaveBeenCalled();
        expect(pluginUpdate.recover).toHaveBeenCalledTimes(2);
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
        await run;
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('immediately rolls back when durable activation recording fails', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        pluginUpdate.finalize.mockImplementation(() => {
            const error = new Error('journal fsync failed');
            error.serverPluginActivationRecorded = false;
            throw error;
        });
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-journal', payload });
        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();
        children[1].emit('message', {
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins: [{ id: 'example-plugin', directoryPath: '/plugins/ExamplePlugin' }],
        });
        await tick();

        expect(children[1].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
        await tick();

        expect(pluginUpdate.rollback).toHaveBeenCalledWith(
            expect.objectContaining({ expectedPluginId: 'example-plugin' }),
            expect.stringContaining('durably'),
        );
        expect(spawnFn).toHaveBeenCalledTimes(3);
        children[2].exitCode = 0;
        children[2].emit('exit', 0, null);
        await run;
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('stops the updated child, rolls back, and starts the previous plugin when activation fails', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-2', payload });
        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();

        children[1].emit('message', {
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins: [{ id: 'example-plugin', directoryPath: '/plugins/DifferentPlugin' }],
        });
        await tick();
        expect(children[1].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
        await tick();

        expect(pluginUpdate.rollback).toHaveBeenCalledWith(expect.objectContaining({ expectedPluginId: 'example-plugin' }), expect.stringContaining('did not load'));
        expect(spawnFn).toHaveBeenCalledTimes(3);
        children[2].exitCode = 0;
        children[2].emit('exit', 0, null);
        await run;
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('rolls back without respawning when the supervisor is stopped during activation', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-stop', payload });
        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();
        process.emit('SIGTERM');
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);

        await run;
        expect(pluginUpdate.rollback).toHaveBeenCalled();
        expect(spawnFn).toHaveBeenCalledTimes(2);
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('discards a queued update when the request is cancelled before shutdown', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-3', payload });
        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE, requestId: 'cancel-3', payload });
        expect(pluginUpdate.discardPrepared).toHaveBeenCalledWith(payload);
        expect(children[0].send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'cancel-3', ok: true }), expect.any(Function));

        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
        expect(pluginUpdate.apply).not.toHaveBeenCalled();
    });

    test('treats repeated PREPARE messages for one transaction as idempotent', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-a', payload });
        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-b', payload });
        expect(pluginUpdate.validate).toHaveBeenCalledTimes(1);
        expect(children[0].send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'prepare-a', ok: true }), expect.any(Function));
        expect(children[0].send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'prepare-b', ok: true }), expect.any(Function));

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE, requestId: 'cancel', payload });
        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
    });

    test('discards a prepared update when its handoff lease expires', async () => {
        jest.useFakeTimers();
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-lease', payload });
        jest.advanceTimersByTime(SERVER_PLUGIN_PREPARE_LEASE_MS);
        expect(pluginUpdate.discardPrepared).toHaveBeenCalledWith(payload);

        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
    });

    test('exits to the outer launcher when host code requires a fresh supervisor', async () => {
        const { spawnFn } = createSpawnPlan([[SUPERVISOR_RELOAD_EXIT_CODE, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(exitFn).toHaveBeenCalledWith(RESTART_EXIT_CODE);
    });

    test('mirrors a non-restart exit code', async () => {
        const { spawnFn } = createSpawnPlan([[3, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(exitFn).toHaveBeenCalledWith(3);
    });

    test('exits non-zero when the child dies from a signal', async () => {
        const { spawnFn } = createSpawnPlan([[null, 'SIGKILL']]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        expect(exitFn).toHaveBeenCalledWith(1);
    });

    test('requests graceful child shutdown over IPC and does not respawn afterwards', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();

        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
        await new Promise(resolve => setImmediate(resolve));
        children[0].emit('message', { type: SERVER_STARTUP_READY_MESSAGE, plugins: [] });

        process.emit('SIGTERM');
        expect(children[0].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
        expect(children[0].kill).not.toHaveBeenCalled();

        children[0].exitCode = RESTART_EXIT_CODE;
        children[0].emit('exit', RESTART_EXIT_CODE, null);
        await run;

        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(exitFn).toHaveBeenCalledWith(RESTART_EXIT_CODE);
    });

    // Windows raises these when the console window is closed or Ctrl+Break is
    // pressed, and it does not kill children with their parent.
    for (const signal of ['SIGHUP', 'SIGBREAK']) {
        test(`requests graceful shutdown on ${signal} so the console close does not orphan the server`, async () => {
            const { children, spawnFn } = createSpawnPlan(['manual']);
            const exitFn = jest.fn();

            const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
            await new Promise(resolve => setImmediate(resolve));
            children[0].emit('message', { type: SERVER_STARTUP_READY_MESSAGE, plugins: [] });

            process.emit(signal);
            expect(children[0].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
            expect(children[0].kill).not.toHaveBeenCalled();

            children[0].exitCode = RESTART_EXIT_CODE;
            children[0].emit('exit', RESTART_EXIT_CODE, null);
            await run;

            expect(spawnFn).toHaveBeenCalledTimes(1);
        });
    }

    for (const announced of [true, false]) {
        test(`uses graceful shutdown whether or not the child announced startup: ${announced}`, async () => {
            const { children, spawnFn } = createSpawnPlan(['manual']);
            const exitFn = jest.fn();
            const pluginUpdate = createPluginUpdateOperations();
            const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
            await tick();
            if (announced) children[0].emit('message', { type: SERVER_STARTUP_READY_MESSAGE, plugins: [] });
            try {
                process.emit('SIGTERM');
                expect(children[0].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
                expect(children[0].kill).not.toHaveBeenCalled();
            } finally {
                children[0].exitCode = 0;
                children[0].emit('exit', 0, null);
                await run;
            }
        });
    }

    test('acknowledges prepare and cancel requests from the child', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const pluginUpdate = createPluginUpdateOperations();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn: jest.fn(), pluginUpdate });
        await tick();
        const payload = updatePayload();
        try {
            for (const action of ['prepare', 'cancel']) {
                children[0].emit('message', { type: `neconyan:server-plugin-update:${action}`, requestId: action, payload });
                expect(children[0].send).toHaveBeenCalledWith({ type: 'neconyan:server-plugin-update:response', requestId: action, ok: true }, expect.any(Function));
            }
            expect(pluginUpdate.validate).toHaveBeenCalledWith(payload);
            expect(pluginUpdate.discardPrepared).toHaveBeenCalledWith(payload);
        } finally {
            children[0].exitCode = 0;
            children[0].emit('exit', 0, null);
            await run;
        }
    });

    test('force-kills the child only when the IPC shutdown request fails', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const run = runSupervisor({ argv: ['bun', 'server.js'], execArgv: [], spawnFn, exitFn });
        await new Promise(resolve => setImmediate(resolve));
        children[0].send.mockImplementation((_message, callback) => callback(new Error('IPC closed')));

        process.emit('SIGHUP');

        expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
    });

    test('force-kills the child when graceful shutdown exceeds the timeout', async () => {
        jest.useFakeTimers();
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        process.emit('SIGTERM');
        expect(children[0].kill).not.toHaveBeenCalled();

        jest.advanceTimersByTime(SUPERVISOR_FORCE_KILL_TIMEOUT_MS);
        expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');

        children[0].exitCode = null;
        children[0].emit('exit', null, 'SIGKILL');
        await run;
    });

    test('kills a running child when the supervisor itself exits', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();

        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
        await new Promise(resolve => setImmediate(resolve));

        process.emit('exit', 0);
        expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');

        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
    });

    test('does not kill a child that already exited', async () => {
        const { children, spawnFn } = createSpawnPlan([[0, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        process.emit('exit', 0);

        expect(children[0].kill).not.toHaveBeenCalled();
    });

    describe('JavaScript heap limit on Android', () => {
        const android = { platform: 'android', versions: { node: '24.13.0' }, execArgv: [], env: {} };

        test.each([
            ['a 12 GB phone', 12 * 1024 ** 3, '--max-old-space-size=2048'],
            ['an 8 GB phone, exactly at the ceiling', 8 * 1024 ** 3, '--max-old-space-size=2048'],
            ['a 6 GB phone', 6 * 1024 ** 3, '--max-old-space-size=1536'],
            ['a 3 GB phone, never below the V8 default', 3 * 1024 ** 3, '--max-old-space-size=1024'],
            ['a 512 MB device', 512 * 1024 ** 2, '--max-old-space-size=1024'],
        ])('sets the limit for %s', (_name, totalMemoryBytes, expected) => {
            expect(resolveChildHeapArguments({ ...android, totalMemoryBytes })).toEqual([expected]);
        });

        test.each([
            ['a flag in execArgv', { execArgv: ['--max-old-space-size=3000'] }],
            ['the underscore spelling in execArgv', { execArgv: ['--max_old_space_size=3000'] }],
            ['the flag in NODE_OPTIONS', { env: { NODE_OPTIONS: '--max-old-space-size=3000' } }],
            ['the underscore spelling in NODE_OPTIONS', { env: { NODE_OPTIONS: '--no-warnings --max_old_space_size=3000' } }],
            ['Bun', { versions: { bun: '1.4.0' } }],
            ['Linux', { platform: 'linux' }],
            ['macOS', { platform: 'darwin' }],
            ['Windows', { platform: 'win32' }],
        ])('leaves the limit alone with %s', (_name, change) => {
            expect(resolveChildHeapArguments({ ...android, ...change, totalMemoryBytes: 12 * 1024 ** 3 })).toEqual([]);
        });

        test.each([
            ['zero', 0], ['negative', -1], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['a string', '12884901888'], ['null', null],
        ])('sets nothing when the total memory is %s', (_name, totalMemoryBytes) => {
            expect(resolveChildHeapArguments({ ...android, totalMemoryBytes })).toEqual([]);
        });

        test('puts the flag before the forwarded runtime flags and records it in the crash report', async () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-supervisor-heap-'));
            const info = jest.spyOn(console, 'info').mockImplementation(() => { });
            jest.spyOn(console, 'error').mockImplementation(() => { });
            try {
                const { children, spawnFn } = createSpawnPlan(['manual']);
                const exitFn = jest.fn();
                const run = runSupervisor({ argv: ['node', 'server.js', '--listen'], execArgv: ['--trace-warnings'], heapArguments: ['--max-old-space-size=2048'], spawnFn, exitFn });
                await tick();
                expect(spawnFn.mock.calls[0][1]).toEqual(['--max-old-space-size=2048', '--trace-warnings', 'server.js', '--listen']);
                expect(info).toHaveBeenCalledWith(expect.stringContaining('--max-old-space-size=2048'));
                children[0].pid = 5150;
                children[0].emit('message', { type: 'neconyan:crash-directory', directory });
                stopChild(children[0], null, 'SIGABRT');
                await run;
                expect(getCrashReports(directory)[0].child.heapLimitArgument).toBe('--max-old-space-size=2048');
            } finally { fs.rmSync(directory, { recursive: true, force: true }); }
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        test('uses the same decision by default, which adds nothing off Android', async () => {
            const { spawnFn } = createSpawnPlan([[0, null]]);
            await runSupervisor({ argv: ['node', 'server.js'], execArgv: ['--trace-warnings'], spawnFn, exitFn: jest.fn() });
            expect(spawnFn.mock.calls[0][1]).toEqual([...resolveChildHeapArguments({ execArgv: ['--trace-warnings'] }), '--trace-warnings', 'server.js']);
            expect(resolveChildHeapArguments({ platform: 'linux', execArgv: [] })).toEqual([]);
        });

        test('applies configured maxOldSpaceSizeMb on desktop and Android while yielding to external flags and Bun', () => {
            expect(parseMaxOldSpaceSizeMb(512)).toBe(512);
            expect(parseMaxOldSpaceSizeMb(65536)).toBe(65536);
            expect(parseMaxOldSpaceSizeMb(511)).toBeNull();
            expect(parseMaxOldSpaceSizeMb(65537)).toBeNull();
            expect(parseMaxOldSpaceSizeMb(2048.5)).toBeNull();
            expect(parseMaxOldSpaceSizeMb('2048')).toBeNull();

            for (const platform of ['linux', 'darwin', 'win32', 'android']) {
                expect(resolveChildHeapArguments({
                    platform,
                    versions: { node: '24.18.0' },
                    execArgv: [],
                    env: {},
                    totalMemoryBytes: 12 * 1024 ** 3,
                    configuredMaxOldSpaceSizeMb: 4096,
                })).toEqual(['--max-old-space-size=4096']);
            }

            expect(resolveChildHeapArguments({
                platform: 'linux',
                versions: { node: '24.18.0' },
                execArgv: ['--max-old-space-size=3072'],
                env: {},
                configuredMaxOldSpaceSizeMb: 4096,
            })).toEqual([]);

            expect(resolveChildHeapArguments({
                platform: 'linux',
                versions: { node: '24.18.0' },
                execArgv: [],
                env: { NODE_OPTIONS: '--max_old_space_size=3072' },
                configuredMaxOldSpaceSizeMb: 4096,
            })).toEqual([]);

            expect(resolveChildHeapArguments({
                platform: 'linux',
                versions: { bun: '1.4.0' },
                execArgv: [],
                env: {},
                configuredMaxOldSpaceSizeMb: 4096,
            })).toEqual([]);

            expect(resolveChildHeapArguments({
                platform: 'linux',
                versions: { node: '24.18.0' },
                execArgv: [],
                env: {},
                configuredMaxOldSpaceSizeMb: 100,
            })).toEqual([]);

            expect(resolveChildHeapArguments({
                platform: 'android',
                versions: { node: '24.18.0' },
                execArgv: [],
                env: {},
                totalMemoryBytes: 6 * 1024 ** 3,
                configuredMaxOldSpaceSizeMb: 'invalid',
            })).toEqual(['--max-old-space-size=1536']);
        });

        test('resolves config path flags and reads configured heap caps safely', () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-supervisor-config-'));
            const previousForceGlobal = globalThis.FORCE_GLOBAL_MODE;
            try {
                delete globalThis.FORCE_GLOBAL_MODE;
                expect(resolveSupervisorConfigPath(['node', 'server.js'], directory)).toBe(path.join(directory, 'config.yaml'));
                expect(resolveSupervisorConfigPath(['node', 'server.js', '--configPath', 'first.yaml', '--config-path=second.yaml'], directory)).toBe(path.resolve(directory, 'second.yaml'));
                expect(resolveSupervisorConfigPath(['node', 'server.js', '--configPath=chosen.yaml', '--', '--configPath', 'ignored.yaml'], directory)).toBe(path.resolve(directory, 'chosen.yaml'));

                const expectedGlobalPath = path.join(envPaths('Neconyan', { suffix: '' }).data, 'config.yaml');
                expect(resolveSupervisorConfigPath(['node', 'server.js', '--global', '--configPath', 'ignored.yaml'], directory)).toBe(expectedGlobalPath);
                expect(resolveSupervisorConfigPath(['node', 'server.js', '--global', '--no-global', '--configPath', 'local.yaml'], directory)).toBe(path.resolve(directory, 'local.yaml'));

                const validConfig = path.join(directory, 'valid.yaml');
                fs.writeFileSync(validConfig, 'performance:\n  maxOldSpaceSizeMb: 4096\n');
                expect(readConfiguredMaxOldSpaceSizeMb(validConfig)).toBe(4096);

                const malformedConfig = path.join(directory, 'broken.yaml');
                fs.writeFileSync(malformedConfig, 'performance:\n  maxOldSpaceSizeMb: [\n');
                expect(readConfiguredMaxOldSpaceSizeMb(malformedConfig)).toBeNull();
                expect(readConfiguredMaxOldSpaceSizeMb(path.join(directory, 'missing.yaml'))).toBeNull();
                expect(readConfiguredMaxOldSpaceSizeMb(null)).toBeNull();
                expect(hasExternalHeapFlag({ execArgv: ['--max-old-space-size=2048'], env: {} })).toBe(true);
                expect(hasExternalHeapFlag({ execArgv: [], env: { NODE_OPTIONS: '--max_old_space_size=2048' } })).toBe(true);
                expect(hasExternalHeapFlag({ execArgv: ['--trace-warnings'], env: {} })).toBe(false);
            } finally {
                if (previousForceGlobal === undefined) {
                    delete globalThis.FORCE_GLOBAL_MODE;
                } else {
                    globalThis.FORCE_GLOBAL_MODE = previousForceGlobal;
                }
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });

        test('re-reads config.yaml on exit-75 respawn, tracks external override env, and logs again after Auto', async () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-supervisor-respawn-'));
            const configPath = path.join(directory, 'config.yaml');
            const info = jest.spyOn(console, 'info').mockImplementation(() => { });
            const previousNodeOptions = process.env.NODE_OPTIONS;
            delete process.env.NODE_OPTIONS;
            try {
                fs.writeFileSync(configPath, 'performance:\n  maxOldSpaceSizeMb: 2048\n');
                const { children, spawnFn } = createSpawnPlan(['manual', 'manual', 'manual', 'manual']);
                const exitFn = jest.fn();
                const run = runSupervisor({
                    argv: ['node', 'server.js', '--configPath', configPath],
                    execArgv: [],
                    spawnFn,
                    exitFn,
                    useRealConfig: true,
                });

                await waitFor(() => children.length === 1, 'first spawn');
                expect(spawnFn.mock.calls[0][1]).toEqual(['--max-old-space-size=2048', 'server.js', '--configPath', configPath]);
                expect(spawnFn.mock.calls[0][2].env[EXTERNAL_HEAP_OVERRIDE_ENV]).toBe('0');

                fs.writeFileSync(configPath, 'performance:\n  maxOldSpaceSizeMb: 4096\n');
                stopChild(children[0], RESTART_EXIT_CODE, null);
                await waitFor(() => children.length === 2, 'second spawn');
                expect(spawnFn.mock.calls[1][1]).toEqual(['--max-old-space-size=4096', 'server.js', '--configPath', configPath]);
                expect(spawnFn.mock.calls[1][2].env[EXTERNAL_HEAP_OVERRIDE_ENV]).toBe('0');

                fs.writeFileSync(configPath, 'performance:\n  maxOldSpaceSizeMb: null\n');
                stopChild(children[1], RESTART_EXIT_CODE, null);
                await waitFor(() => children.length === 3, 'third spawn');
                expect(spawnFn.mock.calls[2][1]).toEqual(['server.js', '--configPath', configPath]);

                fs.writeFileSync(configPath, 'performance:\n  maxOldSpaceSizeMb: 4096\n');
                stopChild(children[2], RESTART_EXIT_CODE, null);
                await waitFor(() => children.length === 4, 'fourth spawn');
                expect(spawnFn.mock.calls[3][1]).toEqual(['--max-old-space-size=4096', 'server.js', '--configPath', configPath]);

                stopChild(children[3], 0, null);
                await run;
                expect(exitFn).toHaveBeenCalledWith(0);

                const heapLogCalls = info.mock.calls.filter(([line]) => String(line).includes('Setting the JavaScript heap limit'));
                expect(heapLogCalls).toHaveLength(3);
                expect(heapLogCalls[0][0]).toContain('--max-old-space-size=2048');
                expect(heapLogCalls[1][0]).toContain('--max-old-space-size=4096');
                expect(heapLogCalls[2][0]).toContain('--max-old-space-size=4096');

                const { spawnFn: overrideSpawn } = createSpawnPlan([[0, null]]);
                await runSupervisor({
                    argv: ['node', 'server.js', '--configPath', configPath],
                    execArgv: ['--max-old-space-size=3072'],
                    spawnFn: overrideSpawn,
                    exitFn: jest.fn(),
                    useRealConfig: true,
                });
                expect(overrideSpawn.mock.calls[0][1]).toEqual(['--max-old-space-size=3072', 'server.js', '--configPath', configPath]);
                expect(overrideSpawn.mock.calls[0][2].env[EXTERNAL_HEAP_OVERRIDE_ENV]).toBe('1');
            } finally {
                if (previousNodeOptions === undefined) {
                    delete process.env.NODE_OPTIONS;
                } else {
                    process.env.NODE_OPTIONS = previousNodeOptions;
                }
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
    });

    describe('automatic restart after an unexpected stop', () => {
        let error;
        let info;
        let timers;

        beforeEach(() => {
            error = jest.spyOn(console, 'error').mockImplementation(() => { });
            info = jest.spyOn(console, 'info').mockImplementation(() => { });
            timers = createManualTimers();
        });

        afterEach(async () => {
            try {
                await endSupervisors();
            } finally {
                jest.restoreAllMocks();
            }
        });

        // The restart delay is left at its default and fired by hand, so no test depends on timing.
        const options = () => ({ argv: ['node', 'server.js'], execArgv: [], heapArguments: [], setTimer: timers.setTimer, clearTimer: timers.clearTimer });

        test('starts the server again after a ready server dies from a signal, without reopening the browser', async () => {
            const plan = createSpawnPlan(['manual', 'manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            const run = supervise(plan, { ...options(), spawnFn, exitFn });
            announceStartup(children[0]);
            stopChild(children[0], null, 'SIGABRT');

            await waitFor(() => timers.pending.length === 1, 'the restart delay');
            expect(timers.pending[0].ms).toBe(SERVER_AUTO_RESTART_DELAY_MS);
            expect(spawnFn).toHaveBeenCalledTimes(1);
            expect(info).not.toHaveBeenCalledWith('[Neconyan] Starting the server again...');
            await timers.fireNext();
            await waitFor(() => spawnFn.mock.calls.length === 2, 'the second start');
            expect(exitFn).not.toHaveBeenCalled();
            expect(spawnFn.mock.calls[0][2].env.NECONYAN_SKIP_BROWSER_AUTO_LAUNCH).toBeUndefined();
            expect(spawnFn.mock.calls[1][2].env.NECONYAN_SKIP_BROWSER_AUTO_LAUNCH).toBe('1');
            expect(error).toHaveBeenCalledWith('[Neconyan] The server stopped unexpectedly: it was terminated by SIGABRT.');
            expect(info).toHaveBeenCalledWith('[Neconyan] Starting the server again...');

            stopChild(children[1], 0, null);
            await run;
            expect(exitFn).toHaveBeenCalledWith(0);
            expect(spawnFn).toHaveBeenCalledTimes(2);
        });

        test('waits with the real timers by default', async () => {
            const plan = createSpawnPlan(['manual', 'manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            const run = supervise(plan, { argv: ['node', 'server.js'], execArgv: [], heapArguments: [], restartDelayMs: 1, spawnFn, exitFn });
            announceStartup(children[0]);
            stopChild(children[0], null, 'SIGABRT');
            await waitFor(() => spawnFn.mock.calls.length === 2, 'the second start');
            expect(spawnFn.mock.calls[1][2].env.NECONYAN_SKIP_BROWSER_AUTO_LAUNCH).toBe('1');
            stopChild(children[1], 0, null);
            await run;
            expect(exitFn).toHaveBeenCalledWith(0);
        });

        test('restarts after a ready server exits with an error code', async () => {
            const plan = createSpawnPlan(['manual', 'manual']);
            const { children, spawnFn } = plan;
            const run = supervise(plan, { ...options(), spawnFn, exitFn: jest.fn() });
            announceStartup(children[0]);
            stopChild(children[0], 1, null);
            await timers.fireNext();
            await waitFor(() => spawnFn.mock.calls.length === 2, 'the second start');
            expect(error).toHaveBeenCalledWith('[Neconyan] The server stopped unexpectedly: it exited with code 1.');
            stopChild(children[1], 0, null);
            await run;
        });

        test('never restarts a server that died before announcing startup', async () => {
            const plan = createSpawnPlan(['manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            const run = supervise(plan, { ...options(), spawnFn, exitFn });
            stopChild(children[0], null, 'SIGKILL');
            await run;
            expect(spawnFn).toHaveBeenCalledTimes(1);
            expect(exitFn).toHaveBeenCalledWith(1);
            expect(timers.pending).toHaveLength(0);
            expect(error).not.toHaveBeenCalledWith(expect.stringContaining('stopped unexpectedly'));
            expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Starting the server again'));
        });

        test('a ready server that exits cleanly is not treated as a crash', async () => {
            const plan = createSpawnPlan(['manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            const run = supervise(plan, { ...options(), spawnFn, exitFn });
            announceStartup(children[0]);
            stopChild(children[0], 0, null);
            await run;
            expect(spawnFn).toHaveBeenCalledTimes(1);
            expect(exitFn).toHaveBeenCalledWith(0);
            expect(timers.pending).toHaveLength(0);
            expect(error).not.toHaveBeenCalledWith(expect.stringContaining('stopped unexpectedly'));
        });

        test('stops on the third unexpected stop inside the window', async () => {
            const plan = createSpawnPlan(['manual', 'manual', 'manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            let time = 1_000_000;
            const run = supervise(plan, { ...options(), spawnFn, exitFn, now: () => time });
            for (let index = 0; index < 3; index++) {
                await waitFor(() => children.length === index + 1, `start ${index + 1}`);
                announceStartup(children[index]);
                time += 60_000;
                stopChild(children[index], null, 'SIGSEGV');
                if (index < 2) await timers.fireNext();
            }
            await run;
            expect(spawnFn).toHaveBeenCalledTimes(3);
            expect(exitFn).toHaveBeenCalledWith(1);
            expect(timers.pending).toHaveLength(0);
            expect(error).toHaveBeenCalledWith(expect.stringContaining('The server stopped 3 times in 10 minutes and is not being restarted.'));
        });

        test('allows a restart again once earlier stops fall outside the window', async () => {
            const plan = createSpawnPlan(['manual', 'manual', 'manual', 'manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            let time = 1_000_000;
            const run = supervise(plan, { ...options(), spawnFn, exitFn, now: () => time });
            const crash = async index => {
                await waitFor(() => children.length === index + 1, `start ${index + 1}`);
                announceStartup(children[index]);
                stopChild(children[index], null, 'SIGSEGV');
                await timers.fireNext();
                await waitFor(() => children.length === index + 2, `restart ${index + 2}`);
            };
            await crash(0);
            time += 1000;
            await crash(1);
            time += 11 * 60_000;
            await crash(2);
            expect(exitFn).not.toHaveBeenCalled();
            stopChild(children[3], 0, null);
            await run;
            expect(spawnFn).toHaveBeenCalledTimes(4);
            expect(exitFn).toHaveBeenCalledWith(0);
        });

        test('a shutdown signal during the restart delay stops without starting another server', async () => {
            const plan = createSpawnPlan(['manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            const run = supervise(plan, { ...options(), spawnFn, exitFn });
            announceStartup(children[0]);
            stopChild(children[0], null, 'SIGABRT');
            await waitFor(() => timers.pending.length === 1, 'the restart delay');
            expect(spawnFn).toHaveBeenCalledTimes(1);

            process.emit('SIGINT');
            await run;
            // The delay was cancelled rather than waited out, and nothing was started or told to stop.
            expect(timers.pending).toHaveLength(0);
            expect(spawnFn).toHaveBeenCalledTimes(1);
            expect(exitFn).toHaveBeenCalledWith(1);
            expect(children[0].send).not.toHaveBeenCalled();
            expect(children[0].kill).not.toHaveBeenCalled();
            expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Starting the server again'));
        });

        test('a shutdown request does not restart a ready server that then dies from a signal', async () => {
            const plan = createSpawnPlan(['manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            const run = supervise(plan, { ...options(), spawnFn, exitFn });
            announceStartup(children[0]);
            process.emit('SIGTERM');
            stopChild(children[0], null, 'SIGKILL');
            await run;
            expect(spawnFn).toHaveBeenCalledTimes(1);
            expect(exitFn).toHaveBeenCalledWith(1);
            expect(timers.pending).toHaveLength(0);
            expect(error).not.toHaveBeenCalledWith(expect.stringContaining('stopped unexpectedly'));
        });

        test('leaves the plugin update exit and rollback paths alone', async () => {
            const plan = createSpawnPlan(['manual', 'manual', 'manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            const pluginUpdate = createPluginUpdateOperations();
            const run = supervise(plan, { ...options(), spawnFn, exitFn, pluginUpdate });
            announceStartup(children[0]);
            children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare', payload: updatePayload() });
            stopChild(children[0], SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
            await waitFor(() => children.length === 2, 'the updated server');
            // The updated server dies before announcing startup: rolled back, never counted as an unexpected stop.
            stopChild(children[1], null, 'SIGSEGV');
            await waitFor(() => children.length === 3, 'the rolled-back server');
            expect(pluginUpdate.rollback).toHaveBeenCalledWith(expect.objectContaining({ expectedPluginId: 'example-plugin' }), expect.stringContaining('exited before startup'));
            expect(timers.pending).toHaveLength(0);
            expect(error).not.toHaveBeenCalledWith(expect.stringContaining('stopped unexpectedly'));
            stopChild(children[2], 0, null);
            await run;
            expect(exitFn).toHaveBeenCalledWith(0);
        });

        test('a test that leaves a supervisor running is stopped and reported, not carried into the next test', async () => {
            const plan = createSpawnPlan(['manual']);
            const { children, spawnFn } = plan;
            const run = supervise(plan, { ...options(), spawnFn, exitFn: jest.fn() });
            announceStartup(children[0]);
            stopChild(children[0], null, 'SIGABRT');
            await waitFor(() => timers.pending.length === 1, 'the restart delay');

            await expect(endSupervisors()).rejects.toThrow('1 supervisor(s) were still running when the test ended');
            await run;
            expect(spawnFn).toHaveBeenCalledTimes(1);
            expect(timers.pending).toHaveLength(0);
            expect(info).not.toHaveBeenCalledWith(expect.stringContaining('Starting the server again'));
        });
    });

    describe('what the crash report says about a stopped server', () => {
        let directory;
        let crashFiles;
        let timers;

        beforeEach(() => {
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-supervisor-evidence-'));
            crashFiles = () => fs.readdirSync(directory).sort();
            jest.spyOn(console, 'error').mockImplementation(() => { });
            jest.spyOn(console, 'info').mockImplementation(() => { });
            timers = createManualTimers();
        });

        afterEach(async () => {
            try {
                await endSupervisors();
            } finally {
                jest.restoreAllMocks();
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });

        const options = () => ({ argv: ['node', 'server.js'], execArgv: [], heapArguments: [], setTimer: timers.setTimer, clearTimer: timers.clearTimer });

        async function startChild(children, index, pid) {
            await waitFor(() => children.length === index + 1, `start ${index + 1}`);
            const child = children[index];
            child.pid = pid;
            fs.writeFileSync(path.join(directory, `running-${pid}.json`), '{}');
            child.emit('message', { type: 'neconyan:crash-directory', directory });
            announceStartup(child);
            return child;
        }

        // Writing the report involves a real asynchronous module load, so the restart delay is only
        // scheduled once it is done: wait for that, then let the restart go ahead.
        async function restartAfterReport(children, count) {
            await timers.fireNext();
            await waitFor(() => children.length === count, `start ${count}`);
        }

        test('an out-of-memory stop is reported as one, with the figures, readings and no private text', async () => {
            const plan = createSpawnPlan(['manual', 'manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            const run = supervise(plan, { ...options(), spawnFn, exitFn });
            const child = await startChild(children, 0, 4242);
            for (let index = 0; index < 15; index++) {
                child.emit('message', { type: SERVER_MEMORY_SAMPLE_MESSAGE, sample: memorySample({ heapUsed: (100 + (index === 1 ? 600 : index)) * MIB }) });
            }
            child.emit('message', { type: SERVER_MEMORY_SAMPLE_MESSAGE, sample: memorySample({ rss: -1 }) });
            child.emit('message', { type: SERVER_MEMORY_SAMPLE_MESSAGE, sample: 'not a sample' });
            fs.writeFileSync(path.join(directory, 'fatal-4242.json'), JSON.stringify(nodeFatalReport()));
            stopChild(child, null, 'SIGABRT');

            await restartAfterReport(children, 2);
            const [report] = getCrashReports(directory);
            expect(report.kind).toBe('server-out-of-memory');
            expect(report.error.message).toBe('The server ran out of JavaScript memory and stopped. It was using 1010 MB of its 1014 MB limit when Node reported: Allocation failed - JavaScript heap out of memory.');
            expect(report.child).toMatchObject({ pid: 4242, signal: 'SIGABRT', exitCode: null });
            expect(report.child.fatal).toMatchObject({ outOfMemory: true, trigger: 'OOMError', heap: { used: 1010 * MIB, limit: 1014 * MIB } });
            expect(report.child.fatal.heap.spaces).toEqual({ new_space: { used: 2 * MIB, size: 16 * MIB }, old_space: { used: 890 * MIB, size: 900 * MIB } });
            expect(report.child.memory.samples).toHaveLength(12);
            expect(report.child.memory.samples.at(-1).heapUsed).toBe(114 * MIB);
            expect(report.child.memory.peak.heapUsed).toBe(700 * MIB);
            expect(report.limitation).toContain('child.memory holds the server');
            expect(report.nextStep).toContain('NODE_OPTIONS=--max-old-space-size=<MB>');
            const text = JSON.stringify(report);
            for (const secret of Object.values(FATAL_REPORT_PRIVATE_TEXT)) expect(text).not.toContain(secret);
            expect(crashFiles().filter(name => !name.startsWith('crash-'))).toEqual([]);

            stopChild(children[1], 0, null);
            await run;
            expect(exitFn).toHaveBeenCalledWith(0);
        });

        test('another fatal error is quoted rather than called out of memory', async () => {
            const plan = createSpawnPlan(['manual', 'manual']);
            const { children } = plan;
            const run = supervise(plan, { ...options(), spawnFn: plan.spawnFn, exitFn: jest.fn() });
            const child = await startChild(children, 0, 4243);
            fs.writeFileSync(path.join(directory, 'fatal-4243.json'), JSON.stringify(nodeFatalReport({ header: { event: 'Check failed: handle->IsEmpty()', trigger: 'FatalError' } })));
            stopChild(child, null, 'SIGABRT');
            await restartAfterReport(children, 2);
            const [report] = getCrashReports(directory);
            expect(report.kind).toBe('server-fatal-error');
            expect(report.error.message).toBe('The server stopped after Node reported a fatal error: Check failed: handle->IsEmpty().');
            expect(report.nextStep).toBeUndefined();
            stopChild(children[1], 0, null);
            await run;
        });

        test('without a fatal report the cause stays unestablished, with readings attached as an observation', async () => {
            const plan = createSpawnPlan(['manual', 'manual']);
            const { children } = plan;
            const run = supervise(plan, { ...options(), spawnFn: plan.spawnFn, exitFn: jest.fn() });
            const child = await startChild(children, 0, 4244);
            child.emit('message', { type: SERVER_MEMORY_SAMPLE_MESSAGE, sample: memorySample({ heapUsed: 980 * MIB, heapLimit: 1000 * MIB }) });
            stopChild(child, null, 'SIGKILL');
            await restartAfterReport(children, 2);
            const [report] = getCrashReports(directory);
            expect(report.kind).toBe('child-process-signal');
            expect(report.error.message).toMatch(/^The operating system terminated the server with SIGKILL\. A signal alone does not establish why it was sent\. The last reading, \d+ seconds? before it stopped, showed the JavaScript heap at 98% of its 1000 MB limit\.$/);
            expect(report.error.message).not.toMatch(/ran out/i);
            expect(report.child.fatal).toBeUndefined();
            expect(report.child.memory.samples).toHaveLength(1);
            expect(report.nextStep).toBeUndefined();
            stopChild(children[1], 0, null);
            await run;
        });

        test('readings and build details belong to one server: the next one starts empty', async () => {
            const plan = createSpawnPlan(['manual', 'manual', 'manual']);
            const { children } = plan;
            const run = supervise(plan, { ...options(), spawnFn: plan.spawnFn, exitFn: jest.fn() });
            const first = await startChild(children, 0, 4245);
            first.emit('message', { type: SERVER_MEMORY_SAMPLE_MESSAGE, sample: memorySample() });
            first.emit('message', { type: SERVER_CRASH_BUILD_MESSAGE, app: { version: '1.5.7.1', revision: 'a1b2c3d4', branch: 'private-branch', directory: '/private/checkout' } });
            stopChild(first, null, 'SIGKILL');
            await restartAfterReport(children, 2);
            const second = await startChild(children, 1, 4246);
            second.emit('message', { type: SERVER_CRASH_BUILD_MESSAGE, app: { version: '1.5.7 /private/checkout', revision: 'a'.repeat(65) } });
            stopChild(second, null, 'SIGKILL');
            await restartAfterReport(children, 3);
            const reports = getCrashReports(directory);
            expect(reports).toHaveLength(2);
            const firstReport = reports.find(report => report.child.pid === 4245);
            const secondReport = reports.find(report => report.child.pid === 4246);
            expect(firstReport.child.memory.samples).toHaveLength(1);
            expect(firstReport.child.app).toEqual({ version: '1.5.7.1', revision: 'a1b2c3d4' });
            expect(secondReport.child).not.toHaveProperty('memory');
            expect(secondReport.child).not.toHaveProperty('app');
            expect(secondReport.limitation).toContain('No memory reading arrived from the server before it stopped.');
            stopChild(children[2], 0, null);
            await run;
        });

        test('a stale raw fatal report is deleted even when the stop was requested, and still reported as fatal', async () => {
            const plan = createSpawnPlan(['manual']);
            const { children, spawnFn } = plan;
            const exitFn = jest.fn();
            const run = supervise(plan, { ...options(), spawnFn, exitFn });
            const child = await startChild(children, 0, 4247);
            process.emit('SIGTERM');
            fs.writeFileSync(path.join(directory, 'fatal-4247.json'), JSON.stringify(nodeFatalReport()));
            stopChild(child, null, 'SIGABRT');
            await run;
            expect(fs.existsSync(path.join(directory, 'fatal-4247.json'))).toBe(false);
            expect(getCrashReports(directory).map(report => report.kind)).toEqual(['server-out-of-memory']);
            expect(spawnFn).toHaveBeenCalledTimes(1);
            expect(timers.pending).toHaveLength(0);
        });

        test('a damaged fatal report is deleted and the signal is reported as before', async () => {
            const plan = createSpawnPlan(['manual']);
            const { children } = plan;
            const run = supervise(plan, { ...options(), spawnFn: plan.spawnFn, exitFn: jest.fn() });
            const child = await startChild(children, 0, 4248);
            process.emit('SIGTERM');
            fs.writeFileSync(path.join(directory, 'fatal-4248.json'), '{"header": ');
            stopChild(child, null, 'SIGABRT');
            await run;
            expect(fs.existsSync(path.join(directory, 'fatal-4248.json'))).toBe(false);
            expect(getCrashReports(directory)).toEqual([]);
        });
    });
});
