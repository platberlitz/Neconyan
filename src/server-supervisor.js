import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import envPaths from 'env-paths';
import yaml from 'yaml';

import { APP_NAME } from './runtime.js';
import {
    applyServerPluginRelease,
    discardPreparedServerPluginRelease,
    discardQueuedServerPluginRelease,
    finalizeServerPluginRelease,
    recoverInterruptedServerPluginUpdates,
    rollbackServerPluginRelease,
    validateServerPluginUpdatePayload,
} from './server-plugin-update-helper.js';
import {
    SERVER_MEMORY_SAMPLE_MESSAGE,
    SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE,
    SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE,
    SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
    SERVER_STARTUP_READY_MESSAGE,
} from './server-plugin-update-ipc.js';
import { createMemoryEvidence, describeChildStop, parseCrashBuild, SERVER_CRASH_BUILD_MESSAGE } from './server-crash-evidence.js';
import { serverDirectory } from './server-directory.js';

export const RESTART_EXIT_CODE = 75;
export const SERVER_PLUGIN_UPDATE_EXIT_CODE = 76;
export const SUPERVISOR_RELOAD_EXIT_CODE = 77;
export const SUPERVISED_ENV = 'NECONYAN_SUPERVISED';
export const EXTERNAL_HEAP_OVERRIDE_ENV = 'NECONYAN_EXTERNAL_HEAP_OVERRIDE';
export const LAUNCHER_ENV = 'NECONYAN_LAUNCHER';
export const MAX_OLD_SPACE_SIZE_MIN_MB = 512;
export const MAX_OLD_SPACE_SIZE_MAX_MB = 65536;
export const SUPERVISOR_SHUTDOWN_MESSAGE = 'neconyan:shutdown';
export const SUPERVISOR_FORCE_KILL_TIMEOUT_MS = 5000;
export const SERVER_PLUGIN_ACTIVATION_TIMEOUT_MS = 150_000;
export const SERVER_PLUGIN_PREPARE_LEASE_MS = 2 * 60_000;
export const SERVER_AUTO_RESTART_DELAY_MS = 1000;
export const SERVER_CRASH_LOOP_LIMIT = 3;
export const SERVER_CRASH_LOOP_WINDOW_MS = 10 * 60_000;

const HEAP_FLAG = /--max[-_]old[-_]space[-_]size/;
// V8 caps the default heap at about 1 GB on Android whatever the device has.
const ANDROID_HEAP_DEFAULT_MB = 1024;
const ANDROID_HEAP_CEILING_MB = 2048;

/**
 * Validates an integer V8 old-space size limit in MB.
 * @param {unknown} value Candidate value from config.yaml
 * @returns {number|null} Validated integer MB limit, or null for automatic sizing
 */
export function parseMaxOldSpaceSizeMb(value) {
    return typeof value === 'number'
        && Number.isInteger(value)
        && value >= MAX_OLD_SPACE_SIZE_MIN_MB
        && value <= MAX_OLD_SPACE_SIZE_MAX_MB
        ? value
        : null;
}

/**
 * Checks whether Node.js already receives an explicit heap limit via CLI flags or NODE_OPTIONS.
 * @param {object} [options]
 * @param {string[]} [options.execArgv] Runtime flags
 * @param {NodeJS.ProcessEnv} [options.env] Process environment
 * @returns {boolean} True when an external heap flag is present
 */
export function hasExternalHeapFlag({ execArgv = process.execArgv, env = process.env } = {}) {
    return (Array.isArray(execArgv) ? execArgv : []).some(argument => HEAP_FLAG.test(String(argument)))
        || HEAP_FLAG.test(String(env?.NODE_OPTIONS ?? ''));
}

/**
 * Resolves the config.yaml path using the same CLI precedence as CommandLineParser.
 * @param {string[]} [argv] Supervisor process argv
 * @param {string} [baseDir] Server installation directory
 * @returns {string} Resolved config.yaml path
 */
export function resolveSupervisorConfigPath(argv = process.argv, baseDir = serverDirectory) {
    const args = Array.isArray(argv) ? argv.slice(2) : [];
    let cliGlobal;
    let rawConfigPath = null;

    for (let i = 0; i < args.length; i++) {
        const arg = String(args[i] ?? '');
        if (arg === '--') break;
        if (arg === '--global' || arg === '--global=true') {
            cliGlobal = true;
            continue;
        }
        if (arg === '--no-global' || arg === '--global=false') {
            cliGlobal = false;
            continue;
        }
        if (arg === '--configPath' || arg === '--config-path') {
            if (i + 1 < args.length) {
                rawConfigPath = String(args[++i]);
            }
            continue;
        }
        if (arg.startsWith('--configPath=')) {
            rawConfigPath = arg.slice('--configPath='.length);
            continue;
        }
        if (arg.startsWith('--config-path=')) {
            rawConfigPath = arg.slice('--config-path='.length);
            continue;
        }
    }

    const isGlobal = globalThis.FORCE_GLOBAL_MODE ?? cliGlobal ?? false;
    if (isGlobal) {
        return path.join(envPaths(APP_NAME, { suffix: '' }).data, 'config.yaml');
    }
    if (rawConfigPath) {
        return path.resolve(baseDir, rawConfigPath);
    }
    return path.join(baseDir, 'config.yaml');
}

/**
 * Reads performance.maxOldSpaceSizeMb from config.yaml, failing open to null on any error.
 * @param {string|null|undefined} configPath Path to config.yaml
 * @returns {number|null} Configured MB cap or null
 */
export function readConfiguredMaxOldSpaceSizeMb(configPath) {
    if (!configPath) return null;
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const parsed = yaml.parse(content);
        return parseMaxOldSpaceSizeMb(parsed?.performance?.maxOldSpaceSizeMb);
    } catch {
        return null;
    }
}

/**
 * JavaScript heap limit to pass to the server. A valid configured cap applies on
 * all Node.js platforms; otherwise Android (Termux) auto-scales 1024-2048 MB and
 * desktop uses V8 defaults. An explicit setting in the runtime flags or NODE_OPTIONS
 * always wins, and Bun is untouched.
 * @param {object} [options]
 * @param {string} [options.platform] Operating system
 * @param {NodeJS.ProcessVersions} [options.versions] Runtime versions
 * @param {string[]} [options.execArgv] Runtime flags forwarded to the child
 * @param {NodeJS.ProcessEnv} [options.env] Environment the child inherits
 * @param {number} [options.totalMemoryBytes] Device memory
 * @param {number|null} [options.configuredMaxOldSpaceSizeMb] Configured cap from config.yaml
 * @returns {string[]} Nothing, or one --max-old-space-size flag
 */
export function resolveChildHeapArguments({
    platform = process.platform,
    versions = process.versions,
    execArgv = [],
    env = process.env,
    totalMemoryBytes = os.totalmem(),
    configuredMaxOldSpaceSizeMb = null,
} = {}) {
    if (versions?.bun) return [];
    if (hasExternalHeapFlag({ execArgv, env })) return [];
    const configured = parseMaxOldSpaceSizeMb(configuredMaxOldSpaceSizeMb);
    if (configured !== null) return [`--max-old-space-size=${configured}`];
    if (platform !== 'android') return [];
    if (typeof totalMemoryBytes !== 'number' || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) return [];
    const quarter = Math.floor(totalMemoryBytes / 4 / 1048576);
    return [`--max-old-space-size=${Math.max(ANDROID_HEAP_DEFAULT_MB, Math.min(ANDROID_HEAP_CEILING_MB, quarter))}`];
}

function createTimeout(ms, value) {
    let timer;
    const promise = new Promise(resolve => {
        timer = setTimeout(() => resolve(value), ms);
        timer.unref?.();
    });
    return { promise, cancel: () => clearTimeout(timer) };
}

async function stopChildForRollback(child, exitPromise, shutdownMessage) {
    if (child.exitCode !== null) {
        return;
    }

    try {
        if (typeof child.send === 'function' && child.connected !== false) {
            child.send(shutdownMessage, () => { });
        } else {
            child.kill('SIGKILL');
        }
    } catch {
        child.kill('SIGKILL');
    }

    const gracefulTimeout = createTimeout(SUPERVISOR_FORCE_KILL_TIMEOUT_MS, null);
    const gracefulExit = await Promise.race([exitPromise, gracefulTimeout.promise]);
    gracefulTimeout.cancel();
    if (gracefulExit) {
        return;
    }

    child.kill('SIGKILL');
    const forceTimeout = createTimeout(SUPERVISOR_FORCE_KILL_TIMEOUT_MS, null);
    const forcedExit = await Promise.race([exitPromise, forceTimeout.promise]);
    forceTimeout.cancel();
    if (!forcedExit) {
        throw new Error('The updated server did not shut down, so the previous plugin version could not be restored.');
    }
}

/**
 * Whether this process should act as a supervisor instead of booting the server.
 * A supervised child must not supervise again. Launcher scripts may wrap this
 * supervisor so a host-code update can replace the supervisor itself.
 * @param {NodeJS.ProcessEnv} env Environment to inspect
 * @returns {boolean} True when a supervisor loop should run
 */
export function shouldSupervise(env = process.env) {
    return env[SUPERVISED_ENV] !== '1';
}

/**
 * Runs the server as a supervised child and relaunches it whenever it exits
 * with the restart exit code. This makes the in-app "Restart server" action
 * work regardless of how the process was started (bun server.js, node
 * server.js, Docker, systemd) without relying on platform-specific detached
 * relaunch helpers.
 * @param {object} [options] Dependency injection for tests
 * @param {string[]} [options.argv] Command line of this process
 * @param {string[]} [options.execArgv] Runtime flags to forward to the child
 * @param {typeof spawn} [options.spawnFn] Spawn implementation
 * @param {(code: number) => never} [options.exitFn] Exit implementation
 * @param {string[]} [options.heapArguments] Static heap flags override for tests
 * @param {() => string[]} [options.resolveHeapArguments] Per-spawn heap flag resolver
 * @param {number} [options.restartDelayMs] Pause before restarting a server that stopped unexpectedly
 * @param {number} [options.crashLoopLimit] Unexpected stops within the window that end automatic restarts
 * @param {number} [options.crashLoopWindowMs] Length of that window
 * @param {() => number} [options.now] Clock for the window
 * @param {typeof setTimeout} [options.setTimer] Timer used for the restart delay
 * @param {typeof clearTimeout} [options.clearTimer] Cancels a timer made by setTimer
 * @returns {Promise<never>} Never resolves; exits the process instead
 */
export async function runSupervisor({
    argv = process.argv,
    execArgv = process.execArgv ?? [],
    spawnFn = spawn,
    exitFn = process.exit,
    heapArguments = undefined,
    resolveHeapArguments = () => resolveChildHeapArguments({
        execArgv,
        configuredMaxOldSpaceSizeMb: readConfiguredMaxOldSpaceSizeMb(resolveSupervisorConfigPath(argv)),
    }),
    restartDelayMs = SERVER_AUTO_RESTART_DELAY_MS,
    crashLoopLimit = SERVER_CRASH_LOOP_LIMIT,
    crashLoopWindowMs = SERVER_CRASH_LOOP_WINDOW_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    pluginUpdate = {
        apply: applyServerPluginRelease,
        discard: discardQueuedServerPluginRelease,
        discardPrepared: discardPreparedServerPluginRelease,
        finalize: finalizeServerPluginRelease,
        recover: recoverInterruptedServerPluginUpdates,
        rollback: rollbackServerPluginRelease,
        validate: validateServerPluginUpdatePayload,
    },
    activationTimeoutMs = SERVER_PLUGIN_ACTIVATION_TIMEOUT_MS,
    prepareLeaseMs = SERVER_PLUGIN_PREPARE_LEASE_MS,
    pluginsRoot = path.join(serverDirectory, 'plugins'),
} = {}) {
    let child = null;
    let shuttingDown = false;
    let forceKillTimer = null;
    let pendingPluginUpdate = null;
    let pendingPluginUpdateTimer = null;
    let activatingPluginUpdate = null;
    let wakeRestartDelay = null;
    let unexpectedStops = [];

    const recoverPluginUpdates = () => {
        try {
            pluginUpdate.recover?.(pluginsRoot);
            return true;
        } catch (error) {
            console.error('[Neconyan] Failed to recover an interrupted server plugin update.', error);
            return false;
        }
    };

    if (!recoverPluginUpdates()) {
        return exitFn(1);
    }

    const clearPendingPluginUpdate = () => {
        if (pendingPluginUpdateTimer) {
            clearTimeout(pendingPluginUpdateTimer);
            pendingPluginUpdateTimer = null;
        }
        pendingPluginUpdate = null;
    };

    const discardPreparedUpdate = update => {
        const discard = pluginUpdate.discardPrepared ?? pluginUpdate.discard;
        discard(update);
    };

    const leasePendingPluginUpdate = () => {
        if (pendingPluginUpdateTimer) {
            clearTimeout(pendingPluginUpdateTimer);
        }
        pendingPluginUpdateTimer = setTimeout(() => {
            const expired = pendingPluginUpdate;
            clearPendingPluginUpdate();
            if (!expired) {
                return;
            }
            try {
                discardPreparedUpdate(expired);
                console.warn(`[Neconyan] Discarded expired server plugin update ${expired.transactionId}.`);
            } catch (error) {
                console.error('[Neconyan] Failed to discard an expired server plugin update.', error);
            }
        }, prepareLeaseMs);
        pendingPluginUpdateTimer.unref?.();
    };

    const forceStopChild = () => {
        if (child && child.exitCode === null && !child.signalCode) {
            child.kill('SIGKILL');
        }
    };

    // Not unref'd: while this runs the supervisor has no child, so nothing else keeps it alive.
    const waitBeforeRestart = ms => new Promise(resolve => {
        let timer;
        const finish = () => {
            clearTimer(timer);
            wakeRestartDelay = null;
            resolve();
        };
        timer = setTimer(finish, ms);
        wakeRestartDelay = finish;
    });

    const requestShutdown = () => {
        shuttingDown = true;
        wakeRestartDelay?.();
        // A server killed by a signal has no exit code, only a signal code.
        if (!child || child.exitCode !== null || child.signalCode) {
            return;
        }

        forceKillTimer ??= setTimeout(forceStopChild, SUPERVISOR_FORCE_KILL_TIMEOUT_MS);
        forceKillTimer.unref?.();

        if (typeof child.send === 'function' && child.connected !== false) {
            try {
                child.send(SUPERVISOR_SHUTDOWN_MESSAGE, error => error && forceStopChild());
                return;
            } catch {
                // Fall through to the force-stop fallback.
            }
        }

        forceStopChild();
    };

    process.on('SIGINT', requestShutdown);
    process.on('SIGTERM', requestShutdown);
    // Windows delivers SIGHUP/SIGBREAK when the console window is closed or
    // Ctrl+Break is pressed, and it does not kill child processes with their
    // parent. Without this the server survives as an invisible process that
    // keeps holding the listen port.
    process.on('SIGHUP', requestShutdown);
    process.on('SIGBREAK', requestShutdown);
    process.on('exit', () => {
        if (forceKillTimer) {
            clearTimeout(forceKillTimer);
        }
        forceStopChild();
    });

    let isFirstLaunch = true;
    let previousHeapFlag = null;
    for (;;) {
        if (!isFirstLaunch && !pendingPluginUpdate && !activatingPluginUpdate && !recoverPluginUpdates()) {
            return exitFn(1);
        }

        const currentHeapArguments = heapArguments ?? resolveHeapArguments();
        const currentHeapFlag = currentHeapArguments.join(' ');
        const env = {
            ...process.env,
            [SUPERVISED_ENV]: '1',
            [EXTERNAL_HEAP_OVERRIDE_ENV]: hasExternalHeapFlag({ execArgv, env: process.env }) ? '1' : '0',
            [SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV]: SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
        };
        if (!isFirstLaunch) {
            env.NECONYAN_SKIP_BROWSER_AUTO_LAUNCH = '1';
        }

        try {
            if (currentHeapArguments.length && (isFirstLaunch || currentHeapFlag !== previousHeapFlag)) {
                console.info(`[Neconyan] Setting the JavaScript heap limit (${currentHeapArguments.join(' ')}). Change it in the Server panel (Server Memory), or set NODE_OPTIONS=--max-old-space-size=<MB> to override.`);
            }
            previousHeapFlag = currentHeapFlag;
            child = spawnFn(argv[0], [...currentHeapArguments, ...execArgv, ...argv.slice(1)], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env });
            const activeChild = child;
            let crashDirectory;
            let app = null;
            let rollbackRequested = false;
            let startupAnnounced = false;
            const memoryEvidence = createMemoryEvidence();
            let resolveStartup;
            const startupPromise = new Promise(resolve => {
                resolveStartup = resolve;
            });
            const respond = (requestId, response) => {
                try {
                    child.send({ type: SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE, requestId, ...response }, () => {
                        // A disconnect racing this response is handled by the
                        // request lease/cancellation protocol.
                    });
                } catch {
                    // The child may have disconnected while its request was being handled.
                }
            };
            const onMessage = message => {
                if (child !== activeChild) return;
                if (message?.type === 'neconyan:crash-directory' && typeof message.directory === 'string') {
                    crashDirectory = message.directory;
                    return;
                }
                if (message?.type === SERVER_CRASH_BUILD_MESSAGE) {
                    app = parseCrashBuild(message.app) ?? app;
                    return;
                }
                if (message?.type === SERVER_STARTUP_READY_MESSAGE) {
                    startupAnnounced = true;
                    resolveStartup({ plugins: Array.isArray(message.plugins) ? message.plugins : [] });
                    return;
                }
                if (message?.type === SERVER_MEMORY_SAMPLE_MESSAGE) {
                    memoryEvidence.add(message.sample);
                    return;
                }

                if (message?.type === SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE) {
                    try {
                        if (pendingPluginUpdate?.transactionId === message.payload?.transactionId) {
                            leasePendingPluginUpdate();
                            respond(message.requestId, { ok: true });
                            return;
                        }
                        if (pendingPluginUpdate || activatingPluginUpdate) {
                            throw new Error('Another server plugin update is already waiting to run. Wait for it to finish, then try again.');
                        }
                        pluginUpdate.validate(message.payload);
                        pendingPluginUpdate = message.payload;
                        leasePendingPluginUpdate();
                        respond(message.requestId, { ok: true });
                    } catch (error) {
                        respond(message.requestId, { ok: false, code: 'invalid_update_handoff', error: error?.message || String(error) });
                    }
                    return;
                }

                if (message?.type === SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE) {
                    try {
                        if (activatingPluginUpdate?.transactionId === message.payload?.transactionId) {
                            throw new Error('The server plugin is already being switched on. Wait for it to finish.');
                        }
                        if (pendingPluginUpdate?.transactionId === message.payload?.transactionId) {
                            discardPreparedUpdate(pendingPluginUpdate);
                            clearPendingPluginUpdate();
                        } else if (!pendingPluginUpdate) {
                            // This also resolves a PREPARE response that was
                            // lost after the supervisor accepted ownership.
                            pluginUpdate.discardPrepared?.(message.payload);
                        }
                        respond(message.requestId, { ok: true });
                    } catch (error) {
                        respond(message.requestId, { ok: false, code: 'update_cancel_failed', error: error?.message || String(error) });
                    }
                }
            };
            child.on('message', onMessage);
            const exitPromise = once(child, 'exit').then(async ([code, signal]) => {
                const stoppedAt = now();
                const expected = shuttingDown || rollbackRequested || (!signal && [0, RESTART_EXIT_CODE, SERVER_PLUGIN_UPDATE_EXIT_CODE, SUPERVISOR_RELOAD_EXIT_CODE].includes(code));
                // A server that never finished starting is not restarted: a broken config or a busy port would loop.
                const restartable = !expected && startupAnnounced;
                const diagnostics = crashDirectory ? await import('./crash-diagnostics.js') : null;
                // Always read, so the raw file Node wrote is deleted even when no report is needed.
                const fatal = diagnostics?.consumeFatalReport(crashDirectory, activeChild.pid) ?? null;
                const needsReport = Boolean(diagnostics) && (Boolean(fatal) || (!expected && (signal || fs.existsSync(path.join(crashDirectory, `running-${activeChild.pid}.json`)))));
                const stop = needsReport || restartable
                    ? describeChildStop({ pid: activeChild.pid, code, signal, app, fatal, memory: memoryEvidence.snapshot(), heapLimitArgument: currentHeapArguments[0] ?? null, stoppedAt })
                    : null;
                if (restartable) console.error(`[Neconyan] The server stopped unexpectedly: ${stop.headline}.`);
                const saved = needsReport && diagnostics.writeCrashReport(stop.kind, stop.explanation, stop.extra, crashDirectory);
                if (diagnostics && (expected || saved)) diagnostics.clearCrashMarker(crashDirectory, activeChild.pid);
                return { code, signal, restartable };
            });

            if (activatingPluginUpdate) {
                const activationTimeout = createTimeout(activationTimeoutMs, { timedOut: true });
                const activation = await Promise.race([
                    startupPromise.then(startup => ({ startup })),
                    exitPromise.then(exit => ({ exit })),
                    activationTimeout.promise,
                ]);
                activationTimeout.cancel();

                const loaded = activation.startup?.plugins.some(plugin => (
                    plugin?.id === activatingPluginUpdate.expectedPluginId
                    && path.resolve(String(plugin?.directoryPath ?? '')) === activatingPluginUpdate.pluginPath
                ));
                if (!loaded) {
                    const reason = activation.timedOut
                        ? 'server startup timed out'
                        : activation.exit
                            ? 'updated server exited before startup completed'
                            : `plugin ${activatingPluginUpdate.expectedPluginId} did not load`;
                    if (!activation.exit) {
                        rollbackRequested = true;
                        await stopChildForRollback(child, exitPromise, SUPERVISOR_SHUTDOWN_MESSAGE);
                    }
                    pluginUpdate.rollback(activatingPluginUpdate, reason);
                    console.error(`[Neconyan] Server plugin update rolled back: ${reason}.`);
                    activatingPluginUpdate = null;
                    child.off('message', onMessage);
                    if (shuttingDown) {
                        return exitFn(activation.exit?.signal ? 1 : (activation.exit?.code ?? 0));
                    }
                    isFirstLaunch = false;
                    continue;
                }

                try {
                    pluginUpdate.finalize(activatingPluginUpdate);
                    console.info(`[Neconyan] Server plugin ${activatingPluginUpdate.expectedPluginId} update activated successfully.`);
                } catch (error) {
                    console.error('[Neconyan] Server plugin update activated, but final cleanup failed.', error);
                    if (error?.serverPluginActivationRecorded === true && !recoverPluginUpdates()) {
                        console.error('[Neconyan] The healthy plugin is active, but its update lock requires manual cleanup.');
                    } else if (error?.serverPluginActivationRecorded !== true) {
                        console.error('[Neconyan] Activation could not be recorded; restoring the previous plugin now.');
                        rollbackRequested = true;
                        await stopChildForRollback(child, exitPromise, SUPERVISOR_SHUTDOWN_MESSAGE);
                        pluginUpdate.rollback(activatingPluginUpdate, 'activation could not be recorded durably');
                        activatingPluginUpdate = null;
                        child.off('message', onMessage);
                        if (shuttingDown) {
                            return exitFn(0);
                        }
                        isFirstLaunch = false;
                        continue;
                    }
                }
                activatingPluginUpdate = null;
            }

            const { code, signal, restartable } = await exitPromise;
            child.off('message', onMessage);
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
                forceKillTimer = null;
            }

            if (code === SERVER_PLUGIN_UPDATE_EXIT_CODE && !shuttingDown) {
                if (!pendingPluginUpdate) {
                    console.error('[Neconyan] Server plugin update exit requested without a queued transaction.');
                    isFirstLaunch = false;
                    continue;
                }

                if (pendingPluginUpdateTimer) {
                    clearTimeout(pendingPluginUpdateTimer);
                    pendingPluginUpdateTimer = null;
                }
                try {
                    activatingPluginUpdate = pluginUpdate.apply(pendingPluginUpdate);
                } catch (error) {
                    console.error('[Neconyan] Failed to activate the staged server plugin update. Restarting the previous version.', error);
                    if (!error?.preserveServerPluginTransaction && !error?.serverPluginTransactionCleaned) {
                        try {
                            pluginUpdate.discardPrepared?.(pendingPluginUpdate);
                        } catch (discardError) {
                            console.error('[Neconyan] Failed to discard the rejected server plugin update.', discardError);
                        }
                    }
                } finally {
                    clearPendingPluginUpdate();
                }
                isFirstLaunch = false;
                continue;
            }

            if (pendingPluginUpdate) {
                try {
                    discardPreparedUpdate(pendingPluginUpdate);
                } catch (error) {
                    console.error('[Neconyan] Failed to discard a queued server plugin update.', error);
                }
                clearPendingPluginUpdate();
            }

            if (code === RESTART_EXIT_CODE && !shuttingDown) {
                console.info('[Neconyan] Restarting server...');
                isFirstLaunch = false;
                continue;
            }

            if (code === SUPERVISOR_RELOAD_EXIT_CODE && !shuttingDown) {
                console.info('[Neconyan] Host update requires a fresh supervisor process.');
                return exitFn(RESTART_EXIT_CODE);
            }

            if (restartable && !shuttingDown) {
                const time = now();
                unexpectedStops = [...unexpectedStops.filter(at => time - at < crashLoopWindowMs), time];
                if (unexpectedStops.length >= crashLoopLimit) {
                    const minutes = Math.round(crashLoopWindowMs / 60_000);
                    console.error(`[Neconyan] The server stopped ${unexpectedStops.length} times in ${minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : 'a short time'} and is not being restarted. Start it again by hand once the cause is fixed.`);
                    return exitFn(signal ? 1 : (code ?? 0));
                }
                await waitBeforeRestart(restartDelayMs);
                if (shuttingDown) {
                    return exitFn(signal ? 1 : (code ?? 0));
                }
                console.info('[Neconyan] Starting the server again...');
                isFirstLaunch = false;
                continue;
            }

            return exitFn(signal ? 1 : (code ?? 0));
        } catch (error) {
            console.error('[Neconyan] Supervisor failed to launch the server.', error);
            return exitFn(1);
        }
    }
}
