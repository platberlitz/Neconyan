import { randomUUID } from 'node:crypto';
import '../public/scripts/crash-diagnostics.js';
import { notifyJobsChanged } from './jobs/notifications.js';

const jobs = new Map();
const { templateLabel, safeAgentLabel } = globalThis.NeconyanCrashDiagnostics;
const phases = new Set(['pre', 'post', 'companions', 'synthesis', 'repair', 'regex']);

function prune(now) {
    for (const [key, job] of jobs) if (!job.running.size && now - job.at > 60000) jobs.delete(key);
}
function hint(job) {
    if (job.hintTimer) return;
    job.hintTimer = setTimeout(() => {
        job.hintTimer = null;
        job.notifiedAt = Date.now();
        try { notifyJobsChanged({ owner: job.owner, id: job.root, diagnosticOnly: true }); } catch { /* Observational only. */ }
    }, Math.max(25, 1000 - (Date.now() - job.notifiedAt)));
    job.hintTimer.unref?.();
}

/** Internal identities select a private record. They never enter an exposed sample. */
export function beginDiagnosticAgent(context, descriptor = {}) {
    try {
        const now = Date.now();
        prune(now);
        const owner = context.owner, leaf = context.job.id;
        const root = context.job.intent?.request?.workflowCandidate?.parentJobId || context.job.parentId || leaf;
        const key = JSON.stringify([owner, root]);
        if (!jobs.has(key) && jobs.size >= 128) return null;
        const job = jobs.get(key) || { owner, root, leaves: new Set(), running: new Map(), events: [], labels: new Map(), at: now, notifiedAt: 0 };
        if (job.running.size >= 128) return null;
        if (!job.leaves.has(leaf) && job.leaves.size >= 128) return null;
        job.leaves.add(leaf);
        const builtIn = descriptor.synthesis ? 'Combined reply' : templateLabel(descriptor.sourceTemplateId);
        if (!builtIn && !job.labels.has(descriptor.id) && job.labels.size < 128) job.labels.set(descriptor.id, `Custom agent ${job.labels.size + 1}`);
        const label = builtIn || job.labels.get(descriptor.id) || 'Custom agent 1';
        const handle = randomUUID();
        const phase = phases.has(descriptor.phase) ? descriptor.phase : 'unknown';
        job.running.set(handle, { label: safeAgentLabel(label), phase, location: 'server' });
        job.events.push({ at: now, type: 'agent-start', agentLabel: safeAgentLabel(label) });
        job.events = job.events.slice(-12); job.at = now;
        jobs.set(key, job);
        if (phase !== 'regex') hint(job);
        return { key, handle };
    } catch { return null; }
}

export function endDiagnosticAgent(handle, outcome = 'done') {
    try {
        const job = jobs.get(handle?.key), item = job?.running.get(handle?.handle);
        if (!item) return;
        job.running.delete(handle.handle); job.at = Date.now();
        job.events.push({ at: job.at, type: outcome === 'cancel' ? 'agent-cancel' : outcome === 'error' ? 'agent-error' : 'agent-end', agentLabel: item.label });
        job.events = job.events.slice(-12);
        if (item.phase !== 'regex') hint(job);
    } catch { /* Diagnostics must not affect a paid request. */ }
}

function expose(job) {
    const running = Array.from(job.running.values());
    const phase = running[0]?.phase;
    return { schema: 1, at: job.at, phase: !phase ? 'idle' : phase === 'pre' ? 'pre-agents' : phase === 'companions' ? 'companions' : 'post-agents',
        agents: { enabledCount: null, running: running.slice(0, 8), omittedRunningCount: Math.max(0, running.length - 8) }, events: job.events.slice() };
}

export function getDiagnosticJobActivity(owner, id) {
    try {
        prune(Date.now());
        for (const job of jobs.values()) if (job.owner === owner && (job.root === id || job.leaves.has(id))) return expose(job);
    } catch { /* Optional metadata. */ }
    return null;
}

export function getDiagnosticServerActivity() {
    try {
        prune(Date.now());
        const running = [], events = [];
        for (const job of jobs.values()) { running.push(...job.running.values()); events.push(...job.events); }
        return { schema: 1, at: Date.now(), agents: { enabledCount: null, running: running.slice(0, 8), omittedRunningCount: Math.max(0, running.length - 8) },
            events: events.sort((a, b) => a.at - b.at).slice(-12) };
    } catch { return null; }
}
