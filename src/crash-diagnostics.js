import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import '../public/scripts/crash-diagnostics.js';
import { isBenignStreamAbort } from './stream-disconnect-guard.js';

const { describeError, redact } = globalThis.NeconyanCrashDiagnostics;
const MAX_REPORTS = 10;
const MAX_BYTES = 128 * 1024;
let directory;
let marker;
let fatalRecorded = false;
let installed = false;
let shuttingDown;
let requestSnapshot = () => [];
let activitySnapshot = () => null;
let version = {};
const runId = randomUUID();
let latestStatus = null;

function reportStatus(report) {
    const preview = redact(report.error?.message || 'No error message was supplied.', 400);
    return { id: report.id, at: typeof report.at === 'string' && report.at.length <= 40 ? report.at : null, kind: redact(report.kind, 80), summary: report.kind === 'unclean-previous-exit'
        ? 'The previous server process did not close normally. No definite cause was supplied.' : 'A saved server crash report is available.',
    errorPreview: preview.slice(0, 200) };
}
export function getCrashReportStatus() {
    return { schema: 1, runId, latest: latestStatus ? { ...latestStatus } : null };
}

export function setCrashContext({ requests, activity, appVersion, shutdown } = {}) {
    if (requests) requestSnapshot = requests;
    if (activity) activitySnapshot = activity;
    if (appVersion) version = appVersion;
    if (shutdown) shuttingDown = shutdown;
}

function runtimeContext() {
    return {
        pid: process.pid, uptimeSeconds: process.uptime(), versions: process.versions,
        platform: process.platform, arch: process.arch, osRelease: os.release(),
        memory: process.memoryUsage(), systemMemory: { total: os.totalmem(), free: os.freemem() },
        resourceUsage: process.resourceUsage?.(), activeResourceTypes: process.getActiveResourcesInfo?.(), app: version,
    };
}

function reportFiles(dir) {
    return fs.readdirSync(dir).filter(name => /^crash-[\w.-]+\.json$/.test(name)).sort();
}

/** Synchronous and bounded: also works inside an exit/fatal handler. */
export function writeCrashReport(kind, error, extra = {}, dir = directory) {
    try {
        dir ||= path.resolve('data', 'crash-reports');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const name = `crash-${Date.now()}-${randomUUID()}.json`;
        const report = {
            schema: 1, id: name.slice(0, -5), runtime: 'server', kind, at: new Date().toISOString(),
            error: describeError(error), environment: runtimeContext(),
            requests: requestSnapshot(), ...extra,
            privacy: 'No environment variables, command-line arguments, request bodies, headers or console values are collected. Review error text before sharing.',
        };
        try {
            const activity = activitySnapshot();
            if (activity) report.activity = { ...globalThis.NeconyanCrashDiagnostics.validateActivity(activity), events: globalThis.NeconyanCrashDiagnostics.validateEvents(activity.events) };
        } catch { /* Preserve the original error even if an activity provider fails. */ }
        let text = JSON.stringify(report, null, 2);
        if (Buffer.byteLength(text) > MAX_BYTES) {
            report.error = { message: report.error.message, stack: report.error.stack, omitted: 'Nested causes exceeded report size limit' };
            text = JSON.stringify(report, null, 2);
        }
        if (Buffer.byteLength(text) > MAX_BYTES) text = JSON.stringify({ schema: 1, id: report.id, runtime: 'server', kind, at: report.at, error: report.error, omitted: 'Context exceeded report size limit' });
        fs.writeFileSync(path.join(dir, name), text, { mode: 0o600, flush: true });
        if (dir === directory) latestStatus = reportStatus(report);
        const files = reportFiles(dir);
        for (const old of files.slice(0, -MAX_REPORTS)) fs.unlinkSync(path.join(dir, old));
        console.error(`[Neconyan] Crash diagnostics saved: ${path.join(dir, name)}`);
        return name;
    } catch (failure) {
        try { process.stderr.write(`[Neconyan] Could not save crash diagnostics: ${redact(failure?.message)}\n`); } catch { /* Nothing else can be written. */ }
        return null;
    }
}

export function getCrashReports(dir = directory) {
    if (!dir || !fs.existsSync(dir)) return [];
    let files;
    try { files = reportFiles(dir); } catch { return []; }
    return files.slice(-MAX_REPORTS).reverse().flatMap(name => {
        try {
            const file = path.join(dir, name);
            if (fs.statSync(file).size > MAX_BYTES) return [];
            const report = JSON.parse(fs.readFileSync(file, 'utf8'));
            report.id = name.slice(0, -5);
            return [report];
        } catch { return []; }
    });
}

function removeMarker() {
    try { if (marker) fs.unlinkSync(marker); } catch { /* Already removed or storage unavailable. */ }
}

export function clearCrashMarker(dir, pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try { fs.unlinkSync(path.join(dir, `running-${pid}.json`)); } catch { /* Already removed. */ }
}

export function initialiseCrashDiagnostics(dataRoot) {
    if (directory === path.join(dataRoot, 'crash-reports')) return;
    directory = path.join(dataRoot, 'crash-reports');
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        for (const name of fs.readdirSync(directory).filter(name => /^running-\d+\.json$/.test(name))) {
            const file = path.join(directory, name);
            try {
                if (fs.statSync(file).size > 16000) continue;
                const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!Number.isInteger(previous.pid) || previous.pid <= 0) continue;
                // EPERM means the PID now belongs to another user's process, so ours is gone.
                try { process.kill(previous.pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') continue; }
                const saved = writeCrashReport('unclean-previous-exit', 'The previous process ended without running its exit handler. The operating system did not supply a cause; power loss, forced termination and native failures cannot be distinguished.', { previous, limitation: 'The environment was measured on recovery, not at the time of the previous exit.' }, directory);
                if (saved) fs.unlinkSync(file);
            } catch { /* One damaged marker must not block startup. */ }
        }
        marker = path.join(directory, `running-${process.pid}.json`);
        fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), versions: process.versions }), { mode: 0o600 });
        const latest = getCrashReports(directory)[0];
        latestStatus = latest ? reportStatus(latest) : null;
        if (process.send) process.send({ type: 'neconyan:crash-directory', directory }, () => {});
    } catch (error) {
        console.error('[Neconyan] Crash report storage unavailable:', redact(error?.message));
    }
}

export function recordFatalError(kind, error) {
    fatalRecorded = true;
    try { console.error(`[Neconyan] ${kind}:`, JSON.stringify(describeError(error), null, 2)); } catch { /* The terminal may also be unavailable. */ }
    const file = writeCrashReport(kind, error);
    if (file) removeMarker();
    return file;
}

export function installCrashHandlers() {
    if (installed) return;
    installed = true;
    const fatal = (kind, error) => {
        try {
            if (isBenignStreamAbort(error)) {
                console.warn(`Ignored streaming disconnect ${kind === 'unhandled-rejection' ? 'rejection' : 'error'}:`, redact(String(error?.message ?? error)));
                return;
            }
        } catch { /* A hostile rejection object is still fatal. */ }
        if (fatalRecorded) {
            // Later failures during shutdown must not evict the original report from retention.
            try { console.error(`[Neconyan] Further ${kind} while shutting down:`, JSON.stringify(describeError(error), null, 2)); } catch { /* Terminal unavailable. */ }
            return;
        }
        recordFatalError(kind, error);
        process.exitCode = 1;
        const timer = setTimeout(() => process.exit(1), 5000);
        timer.unref?.();
        if (shuttingDown) Promise.resolve(shuttingDown(1)).catch(() => process.exit(1));
        else process.exit(1);
    };
    process.on('uncaughtException', error => fatal('uncaught-exception', error));
    process.on('unhandledRejection', error => fatal('unhandled-rejection', error));
    process.on('exit', code => {
        // Before the data root is known there is nowhere private to save a generic exit report.
        if (directory && code !== 0 && ![75, 76, 77].includes(code) && !fatalRecorded) {
            writeCrashReport('process-exit', `Process exited with code ${code} without an exception. No further cause was supplied.`, { exitCode: code });
        }
        removeMarker();
    });
}
