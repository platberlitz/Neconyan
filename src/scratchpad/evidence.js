import process from 'node:process';

import { getCrashReports } from '../crash-diagnostics.js';
import { listJobs } from '../jobs/store.js';
import { shouldServeFrontendAssets } from '../middleware/frontend-assets.js';
import { getRecentRequestEntries } from '../request-trace.js';
import { formatRuntimeLabel } from '../runtime.js';
import { getServerLogSnapshot } from '../server-log-buffer.js';
import { getVersion } from '../util.js';
import { redactEvidenceText } from '../../public/scripts/scratchpad/evidence.js';

const ITEM_LIMIT = 50;
const SLOW_REQUEST_MS = 10000;
const FAILED_JOB_STATES = new Set(['failed', 'interrupted', 'conflict']);
const LOG_PROBLEM = /\b(?:error|warn(?:ing)?|fail(?:ed|ure|s)?|fatal|exception|unhandled|uncaught|crash(?:ed)?|panic|timed? ?out|timeout|denied|refused|reset|econn\w*|enoent|eacces|eperm|enospc|emfile|rejected|invalid|cannot|could not|unable)\b/i;

function bounded(entries) {
    return { items: entries.slice(0, ITEM_LIMIT), total: entries.length };
}

function isoTime(value) {
    const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
    return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : '';
}

/**
 * Failed or slow API requests made by one account, newest first. The trace holds
 * every account's requests, so anything without a matching handle is dropped here.
 * @param {string} owner The signed-in account's handle
 */
export function ownRequestEvidence(owner) {
    if (typeof owner !== 'string' || !owner) return { items: [], total: 0 };
    const entries = getRecentRequestEntries()
        .filter(entry => entry.handle === owner)
        .filter(entry => entry.status >= 400 || (entry.closed && !entry.long) || (!entry.long && entry.ms >= SLOW_REQUEST_MS))
        .map(entry => ({ at: isoTime(entry.at), method: entry.method, path: redactEvidenceText(entry.path, 120), status: entry.status, ms: entry.ms, closed: entry.closed }));
    return bounded(entries);
}

/**
 * Jobs of one account that failed. Only the type, state, stage and error are read:
 * a job's intent, label, config and result can hold prompts and chat text.
 * @param {{ directories: object, owner: string }} base
 */
export function ownJobEvidence(base) {
    if (!base?.directories || typeof base.owner !== 'string' || !base.owner) return { items: [], total: 0 };
    const entries = listJobs(base.directories, { owner: base.owner, includeDismissed: true })
        .filter(job => FAILED_JOB_STATES.has(job.state))
        .map(job => ({
            at: isoTime(job.finishedAt ?? job.updatedAt ?? job.createdAt),
            type: redactEvidenceText(job.type, 60),
            state: redactEvidenceText(job.state, 30),
            stage: redactEvidenceText(job.stage, 60),
            code: redactEvidenceText(job.error?.code, 80),
            message: redactEvidenceText(job.error?.message),
        }));
    return bounded(entries);
}

async function environmentEvidence() {
    let version = null;
    try { version = await getVersion(); } catch { /* The version is a nicety; the rest still helps. */ }
    let frontendBuild;
    try { frontendBuild = shouldServeFrontendAssets(); } catch { frontendBuild = undefined; }
    return {
        version: version?.pkgVersion || '',
        build: version?.gitRevision ? String(version.gitRevision).slice(0, 12) : '',
        branch: version?.gitBranch || '',
        runtime: formatRuntimeLabel(),
        platform: `${process.platform} ${process.arch}`,
        frontendBuild,
    };
}

/**
 * Evidence any signed-in account may read about itself.
 * @param {{ directories: object, owner: string }} base From scratchpadAccountBase
 */
export async function collectAccountEvidence(base) {
    return {
        environment: await environmentEvidence(),
        requests: ownRequestEvidence(base?.owner),
        jobs: ownJobEvidence(base),
    };
}

/**
 * Evidence about the whole server. Only the admin route may call this, because
 * crash reports and log lines can mention other accounts.
 */
export function collectAdminEvidence() {
    const reports = getCrashReports().map(report => ({
        at: typeof report?.at === 'string' ? report.at : '',
        kind: redactEvidenceText(report?.kind, 60),
        name: redactEvidenceText(report?.error?.name, 80),
        message: redactEvidenceText(report?.error?.message),
        stack: typeof report?.error?.stack === 'string' ? report.error.stack.split('\n').slice(0, 8).map(line => redactEvidenceText(line, 200)).join('\n') : '',
        version: redactEvidenceText(report?.environment?.app?.version, 40),
    }));
    const snapshot = getServerLogSnapshot({ limit: 600 });
    // Ordinary log lines can echo what was typed or sent, so only problems are shared.
    const lines = snapshot.entries
        .filter(entry => entry.stream === 'stderr' || LOG_PROBLEM.test(entry.message))
        .reverse()
        .map(entry => ({ at: isoTime(entry.timestamp), stream: entry.stream, message: redactEvidenceText(entry.message, 300) }));
    return { serverCrashes: bounded(reports), logLines: bounded(lines) };
}
