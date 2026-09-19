import { getJob, listJobs, updateJob } from '../jobs/store.js';
import { getConversationSettings, normalizeConversationSettings } from '../endpoints/conversation-generation.js';
import { normalizeConversationGroupRecord } from '../endpoints/conversation-groups.js';
import { ensureConversationStore, readUserSettingsWithStatus, saveConversationStore } from '../endpoints/conversation-store.js';
import { unScopeConversationStorageKey } from '../endpoints/conversation-utils.js';
import { getCharacterData } from '../endpoints/conversation-generation.js';
import { getSettingsVersion } from '../settings-version.js';
import { acceptConversationAutonomousReply, finalizeConversationSubmission } from './conversation-jobs.js';
import { acceptConversationSummary } from './conversation-maintenance.js';
import { resolveAutomationActivity, selectConversationReminder, selectNextConversationThreadAutomation } from './conversation-auto-policy.js';

const DEFAULT_INTERVAL_MS = 1000;
const AUTO_SCAN_INTERVAL_MS = 30000;
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']);
const normalizeGroup = group => normalizeConversationGroupRecord(group, normalizeConversationSettings);

/** Decode a saved character slot key into its avatar and destination group. */
function splitThreadKey(localKey) {
    if (typeof localKey !== 'string' || !localKey) return null;
    if (!localKey.startsWith('group:')) return { avatar: localKey, groupId: '' };
    const rest = localKey.slice('group:'.length);
    const separator = rest.indexOf(':');
    if (separator === -1) return { avatar: rest, groupId: '' };
    return { avatar: rest.slice(separator + 1), groupId: rest.slice(0, separator) };
}

/** Every active branch for a persona, with settings and partner records resolved. */
async function buildAutomationFrames(request, store, personaId) {
    const characters = {};
    for (const [key, value] of Object.entries(store.characters || {})) {
        const local = unScopeConversationStorageKey(key, personaId);
        if (local !== null) characters[local] = value;
    }
    const frames = [];
    for (const [key, characterStore] of Object.entries(store.characters || {})) {
        const local = unScopeConversationStorageKey(key, personaId);
        const split = splitThreadKey(local);
        if (!split || !characterStore) continue;
        const branchId = characterStore.activeBranchId;
        const branch = characterStore.branches?.[branchId];
        if (!branch || !Array.isArray(branch.messages)) continue;
        const target = { avatar: split.avatar, groupId: split.groupId, personaId, branchId };
        const settings = getConversationSettings(request, store, target.avatar, target.groupId, {}, { personaId });
        const partners = [];
        if (target.groupId) {
            const group = (store.groups || []).find(item => String(item.id) === String(target.groupId));
            for (const avatar of [...new Set(group?.members || [])]) {
                if (avatar === target.avatar || group?.disabled_members?.includes(avatar)) continue;
                const member = await getCharacterData(request, avatar, { allowOverride: false });
                partners.push({ avatar, name: member.name, status: 'online' });
            }
        }
        frames.push({
            target, branch, settings, partners,
            activity: resolveAutomationActivity(characters, target.avatar, personaId, store.runtimeStatusOverrides, Date.now(), store.automation?.timeZone || 'UTC'),
        });
    }
    frames.sort((a, b) => (Number(b.branch.updatedAt) || 0) - (Number(a.branch.updatedAt) || 0));
    return { characters, frames };
}

/**
 * Close a Conversation family whose participants have all stopped. The root
 * records each participant's outcome; a failed participant never cancels a
 * healthy sibling, and an interrupted one needs an explicit retry.
 */
export function reconcileConversationJob(directories, job, { now } = {}) {
    if (!Number.isFinite(now) || now <= 0) now = Date.now();
    const children = (job.children || []).map(id => getJob(directories, id)).filter(Boolean);
    if (!children.length) return false;
    if (children.some(child => !TERMINAL_STATES.has(child.state))) return false;
    const participants = children.map(child => ({
        id: child.id, participant: child.intent?.participantKey || '',
        state: child.state, skipped: child.result?.skipped || null,
    }));
    let state = 'completed';
    if (job.cancellation?.requested) state = 'cancelled';
    else if (children.some(child => child.state === 'interrupted' || child.state === 'conflict')) state = 'interrupted';
    else if (children.some(child => child.state === 'failed')) state = 'failed';
    else if (children.some(child => child.state === 'cancelled')) state = 'cancelled';
    updateJob(directories, job.id, {
        state, stage: null, result: { participants }, progress: { completed: children.length, total: children.length },
        finishedAt: now, recoverability: state === 'completed' ? 'terminal' : 'needs-retry',
    });
    return true;
}

/**
 * Close Conversation submission batches whose coalescing window has passed,
 * repair any paused job left behind by a crash, and finalise a family whose
 * participants have all finished. The runner only dispatches `queued` jobs, so
 * a paused job is invisible to it until it is finalised here.
 */
export async function runConversationWorkerTick({ directoriesFor, owners, now = Date.now() }) {
    const ownerList = typeof owners === 'function' ? await owners() : owners;
    if (!Array.isArray(ownerList)) return;
    for (const owner of ownerList) {
        let directories;
        try {
            directories = directoriesFor(owner);
        } catch {
            continue;
        }
        let jobs;
        try {
            jobs = listJobs(directories, { owner, includeDismissed: true });
        } catch {
            continue;
        }
        for (const job of jobs) {
            if (job.type !== 'conversation.reply') continue;
            try {
                if (job.stage === 'preparing' && job.state === 'waiting' && !job.cancellation?.requested && !(Number(job.coalesce?.deadline) > now)) {
                    await finalizeConversationSubmission({ user: { profile: { handle: owner }, directories } }, job);
                } else if (job.stage === 'children' && !job.result) {
                    // A cancelled root is terminal but still needs its aggregate.
                    reconcileConversationJob(directories, job, { now });
                }
            } catch (error) {
                console.error(`[Conversation] Could not reconcile job ${job.id}:`, error?.message ?? error);
            }
        }
    }
}

/**
 * Decide and accept at most one autonomous message per owner. Only owners that
 * switched native automation on are considered, and only when no Conversation
 * family is still open. A reminder is handled (or invalidated) before threads.
 */
export async function scanConversationAutonomy({ directoriesFor, owners, now = Date.now(), random = Math.random } = {}) {
    const ownerList = typeof owners === 'function' ? await owners() : owners;
    if (!Array.isArray(ownerList)) return { accepted: [], invalidated: [] };
    const accepted = [];
    const invalidated = [];
    for (const owner of ownerList) {
        let directories;
        try { directories = directoriesFor(owner); } catch { continue; }
        const request = { user: { profile: { handle: owner }, directories } };
        let jobs;
        try { jobs = listJobs(directories, { owner, includeDismissed: true }); } catch { continue; }
        if (jobs.some(job => job.type === 'conversation.reply' && !TERMINAL_STATES.has(job.state))) continue;
        let saved;
        try { saved = readUserSettingsWithStatus(request); } catch { continue; }
        if (!saved.ok || !saved.data) continue;
        let store;
        try { store = ensureConversationStore(saved.data, normalizeGroup); } catch { continue; }
        if (store.automation?.mode !== 'server') continue;
        const timeZone = store.automation?.timeZone || 'UTC';
        const personaId = String(saved.data.user_avatar || '');
        const userStatus = String(store.userStatus || 'online');
        const { characters, frames } = await buildAutomationFrames(request, store, personaId);
        const byBranch = new Map();
        const byThread = new Map();
        for (const frame of frames) {
            byBranch.set(`${frame.target.avatar}\u001f${frame.target.groupId}\u001f${frame.target.branchId}`, frame);
            const thread = `${frame.target.avatar}\u001f${frame.target.groupId}`;
            if (!byThread.has(thread)) byThread.set(thread, frame);
        }
        const targets = new Map();
        for (const reminder of store.reminders || []) {
            const fallback = byThread.get(`${reminder.avatar}\u001f${reminder.groupId || ''}`);
            const branchId = reminder.branchId || fallback?.target.branchId;
            const frame = byBranch.get(`${reminder.avatar}\u001f${reminder.groupId || ''}\u001f${branchId}`);
            if (frame && branchId) targets.set(reminder, { target: { ...frame.target, branchId }, settings: frame.settings });
        }
        let occurrence = selectConversationReminder({ reminders: store.reminders || [], targets, personaId, now });
        if (occurrence?.action === 'invalidate' || occurrence?.action === 'skip') {
            const reminder = (store.reminders || []).find(item => item.id === occurrence.reminderId);
            if (reminder) {
                if (occurrence.action === 'invalidate') {
                    reminder.invalidAt = now;
                    reminder.invalidReason = occurrence.reason;
                } else {
                    reminder.fired = true;
                    reminder.skippedAt = now;
                }
                try {
                    const savedResult = await saveConversationStore(request, store, getSettingsVersion(saved.data), { trustedConversationEffects: true });
                    if (savedResult.ok) invalidated.push(reminder.id);
                } catch (error) {
                    console.error(`[Conversation] Could not update reminder ${reminder.id}:`, error?.message ?? error);
                }
            }
            continue;
        }
        if (!occurrence) {
            for (const frame of frames) {
                occurrence = selectNextConversationThreadAutomation({
                    settings: frame.settings, branch: frame.branch, target: frame.target, partners: frame.partners,
                    characters, personaId, overrides: store.runtimeStatusOverrides || {}, userStatus, now, timeZone, random,
                });
                if (occurrence) break;
            }
        }
        if (occurrence?.target) {
            try {
                await acceptConversationAutonomousReply(request, { ...occurrence, timeZone });
                accepted.push(occurrence.key);
                continue;
            } catch (error) {
                console.error('[Conversation] Could not accept automatic message:', error?.message ?? error);
            }
        }
        for (const frame of frames) {
            const messages = (frame.branch.messages || []).filter(message => message.role !== 'system' && String(message.mes || '').trim());
            const throughId = messages.at(-1)?.id;
            if (!throughId) continue;
            try {
                const summary = await acceptConversationSummary(request, {
                    submissionKey: `summary:${frame.target.avatar}:${frame.target.groupId}:${frame.target.branchId}:${throughId}`,
                    target: frame.target,
                }, { automatic: true });
                if (summary.created) {
                    accepted.push(summary.job?.id || throughId);
                    break;
                }
            } catch (error) {
                console.error('[Conversation] Could not accept automatic summary:', error?.message ?? error);
            }
        }
    }
    return { accepted, invalidated };
}

/** Start the reconciler. Returns a stop function. Overlapping ticks are skipped. */
export function startConversationWorker({ directoriesFor, owners, intervalMs = DEFAULT_INTERVAL_MS, autoIntervalMs = AUTO_SCAN_INTERVAL_MS } = {}) {
    const list = async () => (typeof owners === 'function' ? await owners() : owners || []);
    let ticking = false;
    let lastScan = 0;
    const tick = async () => {
        if (ticking) return;
        ticking = true;
        try {
            const listNow = await list();
            await runConversationWorkerTick({ directoriesFor, owners: listNow, now: Date.now() });
            const now = Date.now();
            if (now - lastScan >= autoIntervalMs) {
                lastScan = now;
                await scanConversationAutonomy({ directoriesFor, owners: listNow, now });
            }
        } catch (error) {
            console.error('[Conversation] Scan failed:', error);
        } finally {
            ticking = false;
        }
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    void tick();
    return () => clearInterval(timer);
}

export const testExports = { runConversationWorkerTick, reconcileConversationJob, scanConversationAutonomy };
