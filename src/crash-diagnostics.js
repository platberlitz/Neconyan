import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import v8 from 'node:v8';
import { randomUUID } from 'node:crypto';
import '../public/scripts/crash-diagnostics.js';
import { uiText } from '../public/scripts/ui-text.js';
import { isBenignStreamAbort } from './stream-disconnect-guard.js';
import { describeFatalStop, parseCrashBuild, SERVER_CRASH_BUILD_MESSAGE } from './server-crash-evidence.js';

const { describeError, redact } = globalThis.NeconyanCrashDiagnostics;
const MAX_REPORTS = 10;
const MAX_BYTES = 128 * 1024;
// A compact fatal-error report is about 10 KB; anything far larger is not one.
const MAX_FATAL_REPORT_BYTES = 2 * 1024 * 1024;
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
// Report names sort by this stamp, so two reports saved in the same millisecond still keep their order.
let lastReportStamp = 0;

function reportSummary(report) {
    if (report.kind === 'server-out-of-memory') return 'The server ran out of JavaScript memory and stopped.';
    if (report.kind === 'server-fatal-error') return 'The server stopped after Node reported a fatal error.';
    if (report.kind === 'unclean-previous-exit') {
        if (report.fatal?.outOfMemory) return 'The previous server process ran out of JavaScript memory and stopped.';
        if (report.fatal) return 'The previous server process stopped after Node reported a fatal error.';
        return 'The previous server process did not close normally. No definite cause was supplied.';
    }
    return 'A saved server crash report is available.';
}

function reportStatus(report) {
    const preview = redact(report.error?.message || 'No error message was supplied.', 400);
    // The preview carries the explanation, so an out-of-memory report keeps its figures.
    return { id: report.id, at: typeof report.at === 'string' && report.at.length <= 40 ? report.at : null, kind: redact(report.kind, 80), summary: reportSummary(report),
        errorPreview: preview.slice(0, 320) };
}
export function getCrashReportStatus() {
    return { schema: 1, runId, latest: latestStatus ? { ...latestStatus } : null };
}

export function setCrashContext({ requests, activity, appVersion, shutdown } = {}) {
    if (requests) requestSnapshot = requests;
    if (activity) activitySnapshot = activity;
    if (appVersion) {
        version = appVersion;
        const app = parseCrashBuild(appVersion);
        if (app && process.send && process.connected) {
            try { process.send({ type: SERVER_CRASH_BUILD_MESSAGE, app }, () => {}); } catch { /* A disconnected supervisor doesn't block startup. */ }
        }
    }
    if (shutdown) shuttingDown = shutdown;
}

function heapLimit() {
    try { return v8.getHeapStatistics().heap_size_limit; } catch { return undefined; }
}

function runtimeContext() {
    return {
        pid: process.pid, uptimeSeconds: process.uptime(), versions: process.versions,
        platform: process.platform, arch: process.arch, osRelease: os.release(),
        memory: { ...process.memoryUsage(), heapLimit: heapLimit() }, systemMemory: { total: os.totalmem(), free: os.freemem() },
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
        lastReportStamp = Math.max(Date.now(), lastReportStamp + 1);
        const name = `crash-${lastReportStamp}-${randomUUID()}.json`;
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

export const fatalReportName = pid => `fatal-${pid}.json`;

/**
 * Asks Node to write a diagnostic report if it dies from a fatal error such as
 * running out of JavaScript heap, a case where no JavaScript can run afterwards.
 * Only that trigger is enabled; the handlers below cover uncaught errors and
 * signals. Network and environment sections are never written, and the raw file
 * is deleted as soon as consumeFatalReport has read it.
 */
function enableFatalReports(dir) {
    try {
        const report = process.report;
        if (!report) return;
        report.compact = true;
        report.excludeNetwork = true;
        if ('excludeEnv' in report) report.excludeEnv = true;
        report.directory = path.resolve(dir);
        report.filename = fatalReportName(process.pid);
        // Last, so a failure above can never leave reports going to the working directory.
        report.reportOnFatalError = true;
    } catch { /* Bun and unusual runtimes may lack or refuse this. Startup must not depend on it. */ }
}

const wholeNumber = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

// Frames end in the path of the module they ran in, which names the install location and the
// account. Only its file name stays, and frames Node could not name say nothing, so they go.
function nativeFrame(frame) {
    const symbol = typeof frame?.symbol === 'string' ? frame.symbol : '';
    const match = /^(.*?)\s*\[([^\]]*)\]\s*$/s.exec(symbol);
    const name = (match ? match[1] : symbol).trim();
    if (!name) return '';
    return redact(match ? `${name} [${match[2].split(/[\\/]/).pop()}]` : name, 200);
}

// Node writes the dump time as local time marked with a Z, so the epoch timestamp is used.
function dumpTime(header) {
    const stamp = Number(header.dumpEventTimeStamp);
    return Number.isFinite(stamp) && stamp > 0 && stamp < 8.64e15 ? new Date(stamp).toISOString() : null;
}

function fatalExtract(raw) {
    const header = raw?.header;
    if (!header || typeof header !== 'object') return null;
    const event = typeof header.event === 'string' ? header.event : '';
    const trigger = typeof header.trigger === 'string' ? header.trigger : '';
    const heap = raw.javascriptHeap ?? {};
    const usage = raw.resourceUsage ?? {};
    const spaces = {};
    for (const [name, space] of Object.entries(heap.heapSpaces ?? {}).slice(0, 16)) {
        if (!/^[a-z_]{1,40}$/.test(name) || !space || typeof space !== 'object') continue;
        if (space.used > 0 || space.memorySize > 0) spaces[name] = { used: wholeNumber(space.used), size: wholeNumber(space.memorySize) };
    }
    return {
        event: redact(event, 200),
        trigger: redact(trigger, 80),
        at: dumpTime(header),
        outOfMemory: trigger === 'OOMError' || /heap out of memory|Allocation failed/i.test(event),
        heap: { used: wholeNumber(heap.usedMemory), total: wholeNumber(heap.totalMemory), limit: wholeNumber(heap.memoryLimit), available: wholeNumber(heap.availableMemory), spaces },
        rss: wholeNumber(usage.rss),
        maxRss: wholeNumber(usage.maxRss),
        device: { free: wholeNumber(usage.free_memory), total: wholeNumber(usage.total_memory) },
        nativeStack: (Array.isArray(raw.nativeStack) ? raw.nativeStack : []).slice(0, 20).map(nativeFrame).filter(Boolean),
    };
}

/**
 * Reads the report Node wrote when a process died from a fatal error and
 * returns a small extract: the cause, memory figures and the top of the native
 * stack. The raw file also holds the host name, working directory and command
 * line, so none of it is copied, and the file is deleted whatever happens.
 * @param {string} dir Crash report directory
 * @param {number} pid Process id that wrote the report
 * @returns {object|null} The extract, or null when there is no readable report
 */
export function consumeFatalReport(dir, pid) {
    if (!dir || !Number.isInteger(pid) || pid <= 0) return null;
    const file = path.join(dir, fatalReportName(pid));
    let text;
    try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.size <= MAX_FATAL_REPORT_BYTES) text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
    }
    try { fs.unlinkSync(file); } catch { /* Already removed or storage unavailable. */ }
    try { return text === undefined ? null : fatalExtract(JSON.parse(text)); } catch { return null; }
}

/** Raw fatal reports whose process left no marker would otherwise accumulate. */
function removeStaleFatalReports(dir) {
    const names = fs.readdirSync(dir);
    const owned = new Set(names.map(name => /^running-(\d+)\.json$/.exec(name)?.[1]).filter(Boolean));
    for (const name of names) {
        const pid = /^fatal-(\d+)\.json$/.exec(name)?.[1];
        if (pid && !owned.has(pid)) {
            try { fs.unlinkSync(path.join(dir, name)); } catch { /* Already removed. */ }
        }
    }
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
        enableFatalReports(directory);
        for (const name of fs.readdirSync(directory).filter(name => /^running-\d+\.json$/.test(name))) {
            const file = path.join(directory, name);
            try {
                if (fs.statSync(file).size > 16000) continue;
                const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!Number.isInteger(previous.pid) || previous.pid <= 0) continue;
                // EPERM means the PID now belongs to another user's process, so ours is gone.
                try { process.kill(previous.pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') continue; }
                const fatal = consumeFatalReport(directory, previous.pid);
                const stop = fatal && describeFatalStop(fatal, 'The previous server process');
                const saved = writeCrashReport('unclean-previous-exit', stop?.explanation ?? uiText('The previous process ended without running its exit handler. The operating system did not supply a cause; power loss, forced termination and native failures cannot be distinguished.'), {
                    previous, ...(fatal && { fatal }),
                    limitation: `The environment was measured on recovery, not at the time of the previous exit.${fatal ? ' fatal is taken from the report Node wrote as that process stopped.' : ''}`,
                }, directory);
                if (saved) fs.unlinkSync(file);
            } catch { /* One damaged marker must not block startup. */ }
        }
        try { removeStaleFatalReports(directory); } catch { /* Housekeeping only. */ }
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
