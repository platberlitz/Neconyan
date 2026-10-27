#!/usr/bin/env bun
import path from 'node:path';
import fs from 'node:fs';
import { runSupervisor, shouldSupervise } from './src/server-supervisor.js';

// Supervise a child copy so restarts and transactional plugin replacement are
// owned by one process. Launcher scripts may wrap this supervisor so host-code
// updates can reload it; the supervised child boots the application.
if (shouldSupervise()) {
    await runSupervisor();
}

// The log buffer must evaluate before anything else writes to the console.
await import('./src/server-log-buffer.js');
const { installCrashHandlers, initialiseCrashDiagnostics, recordFatalError } = await import('./src/crash-diagnostics.js');
installCrashHandlers();
const { CommandLineParser } = await import('./src/command-line.js');
const { APP_NAME, formatRuntimeLabel } = await import('./src/runtime.js');
const { serverDirectory } = await import('./src/server-directory.js');

process.env.NODE_ENV ??= 'production';
console.log(`${APP_NAME} startup on ${formatRuntimeLabel()}. Environment: ${process.env.NODE_ENV ?? 'development'}. Server directory: ${serverDirectory}`);
process.chdir(serverDirectory);

// config.yaml will be set when parsing command line arguments
const cliArgs = new CommandLineParser().parse(process.argv);
globalThis.DATA_ROOT = path.resolve(cliArgs.dataRoot);
globalThis.COMMAND_LINE_ARGS = cliArgs;

let diagnosticsReady = false;
try {
    const { acquireDataRootOwner } = await import('./src/data-root-owner.js');
    acquireDataRootOwner(globalThis.DATA_ROOT, 'server');
    try {
        fs.lstatSync(path.join(globalThis.DATA_ROOT, '_neconyan-policy-repair'));
        throw Object.assign(new Error(`An identity repair is unfinished for ${globalThis.DATA_ROOT}. Run node scripts/repair-data-identity.js status --dataRoot "${globalThis.DATA_ROOT}" and resume it before starting Neconyan.`),
            { code: 'DATA_IDENTITY_REPAIR_REQUIRED' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    initialiseCrashDiagnostics(globalThis.DATA_ROOT);
    diagnosticsReady = true;
    const { configureTermuxStartup } = await import('./src/termux-startup.js');
    await configureTermuxStartup(cliArgs);
    await import('./src/server-main.js');
} catch (error) {
    if (diagnosticsReady) recordFatalError('startup-failure', error);
    console.error('A critical error has occurred while starting the server:', error);
    if (error.code === 'DATA_ROOT_OWNED') {
        console.error(`Stop every Neconyan installation, then inspect ownership with node scripts/repair-data-identity.js status --dataRoot "${globalThis.DATA_ROOT}".`);
    }
    process.exit(1);
}
