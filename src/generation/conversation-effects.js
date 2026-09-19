import { createHash } from 'node:crypto';
import { MAX_THREAD_MESSAGES, STATUS_NOTICE_COOLDOWN_MS } from '../../public/scripts/neconyan-conversation/constants.js';
import { resolveConversationScheduleUpdate } from '../../public/scripts/neconyan-conversation/generation-utils.js';
import { parseReminderDelayToMs } from '../../public/scripts/neconyan-conversation/reminder-time.js';
import { authorizeConversationGroup, normalizeConversationGroupRecord } from '../endpoints/conversation-groups.js';
import { normalizeConversationSettings } from '../endpoints/conversation-generation.js';
import { createConversationMessage, refreshBranchPreview } from '../endpoints/conversation-messages.js';
import { ensureConversationStore, getConversationThreadKey, readUserSettingsWithStatus, saveConversationStore } from '../endpoints/conversation-store.js';
import { getJob } from '../jobs/store.js';
import { getSettingsVersion } from '../settings-version.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = message => { throw Object.assign(new Error(message), { status: 409, recoverable: true }); };
const normalizeGroup = group => normalizeConversationGroupRecord(group, normalizeConversationSettings);

export function readConversationTarget(request, target) {
    const key = getConversationThreadKey(target.avatar, target.groupId, target.personaId);
    if (!key || typeof target.branchId !== 'string' || !target.branchId || Object.hasOwn(Object.prototype, target.branchId)) {
        conflict('The Conversation target is invalid.');
    }
    const saved = readUserSettingsWithStatus(request);
    if (!saved.ok) conflict('The Conversation settings could not be read.');
    const store = ensureConversationStore(saved.data, normalizeGroup);
    const branch = store.characters[key]?.branches?.[target.branchId];
    if (!branch || !Array.isArray(branch.messages)) conflict('The Conversation branch no longer exists.');
    const permission = authorizeConversationGroup(request, store, target.avatar, target.groupId, target.personaId, normalizeConversationSettings);
    if (!permission.authorized) conflict('The Conversation group is no longer available to this persona.');
    return { store, branch, group: permission.group, settings: saved.data, version: getSettingsVersion(saved.data) };
}

/** Capture an existing branch, without creating or repairing a deleted target. */
export function captureConversationTarget(request, target) {
    const normalized = { avatar: target.avatar, groupId: target.groupId || '', personaId: target.personaId || '', branchId: target.branchId };
    const { branch } = readConversationTarget(request, normalized);
    return { ...normalized, createdAt: branch.createdAt, messagesHash: digest(branch.messages) };
}

/** Write a native effect and its receipt in the same settings-file replacement. */
export async function commitConversationEffect(context, target, effectId, mutate) {
    context.signal?.throwIfAborted();
    const currentJob = getJob(context.directories, context.job.id);
    if (!currentJob || currentJob.owner !== context.owner) conflict('The Conversation job is no longer available.');
    if (currentJob.cancellation?.requested) throw Object.assign(new Error('The Conversation job was cancelled.'), { name: 'AbortError' });
    // A participant child shares its root's message checkpoint: the root records
    // the expected thread hash, so two siblings can append without seeing each
    // other as a conflicting third-party edit, while a user edit still fails.
    const rootJob = currentJob.parentId ? getJob(context.directories, currentJob.parentId) : currentJob;
    if (!rootJob || rootJob.owner !== context.owner) conflict('The Conversation job family is no longer available.');
    if (rootJob.cancellation?.requested) throw Object.assign(new Error('The Conversation job was cancelled.'), { name: 'AbortError' });
    const request = { user: { directories: context.directories, profile: { handle: context.owner } } };
    const current = readConversationTarget(request, target);
    if (current.branch.createdAt !== target.createdAt) conflict('The Conversation branch was replaced.');
    const jobKey = digest(rootJob.id);
    // The root keeps its historical effect key so already-saved receipts remain
    // valid; a child namespaces its own effects below the shared checkpoint.
    const effectKey = currentJob.parentId ? digest([currentJob.id, effectId]) : digest(effectId);
    const receipt = current.branch.serverOperations?.[jobKey];
    if (receipt && Object.hasOwn(receipt.effects, effectKey)) return receipt.effects[effectKey];
    if (digest(current.branch.messages) !== (receipt?.messagesHash || target.messagesHash)) {
        conflict('The Conversation messages changed before this reply could be saved.');
    }
    const result = mutate(current.branch, current.store, current.settings);
    if (result?.then) throw new TypeError('A Conversation effect must finish before releasing its settings write.');
    current.branch.serverOperations ??= {};
    current.branch.serverOperations[jobKey] = {
        messagesHash: digest(current.branch.messages),
        effects: { ...receipt?.effects, [effectKey]: result ?? null },
    };
    const saved = await saveConversationStore(request, current.store, current.version, { trustedConversationEffects: true });
    if (!saved.ok) throw Object.assign(new Error(saved.body?.error || 'Conversation save failed.'), { status: saved.status });
    return result;
}

export function appendConversationJobMessage(context, target, effectId, value, { mutate } = {}) {
    return commitConversationEffect(context, target, effectId, (branch, store, settings) => {
        const message = createConversationMessage({ ...value, id: `job_${digest([context.job.id, effectId]).slice(0, 32)}` });
        if (!message) throw Object.assign(new Error('The generated Conversation message is invalid.'), { status: 400 });
        branch.messages.push(message);
        branch.messages = branch.messages.slice(-MAX_THREAD_MESSAGES);
        if (message.role === 'user') {
            branch.lastActivity = Date.now();
            branch.followupCount = 0;
        }
        refreshBranchPreview(branch);
        mutate?.(branch, store, settings);
        return { id: message.id };
    });
}

/**
 * Apply an autonomous occurrence's bookkeeping once. The claim marker lives on
 * the branch so a delivered occurrence stays consumed even after its job is
 * pruned from the bounded ledger, and so two sibling participants cannot both
 * increment the same counter.
 */
export function applyConversationBookkeeping(branch, store, patch, occurrenceKey, now = Date.now()) {
    if (!patch || !occurrenceKey) return false;
    branch.automationClaims ??= {};
    if (Object.hasOwn(branch.automationClaims, occurrenceKey)) return false;
    branch.automationClaims[occurrenceKey] = now;
    if (patch.reminder?.id) {
        const reminder = (store.reminders || []).find(item => item?.id === patch.reminder.id);
        if (reminder) {
            reminder.fired = true;
            reminder.firedAt = patch.reminder.firedAt || now;
            delete reminder.retryAfter;
        }
    }
    for (const key of patch.scheduleTriggers || []) {
        branch.scheduleTriggers = { ...(branch.scheduleTriggers || {}), [key]: now };
    }
    if (patch.sessionMarkers && typeof patch.sessionMarkers === 'object') {
        branch.sessionMarkers = { ...(branch.sessionMarkers || {}), ...patch.sessionMarkers };
    }
    if (Array.isArray(patch.sessionMarkersAtDelivery)) {
        branch.sessionMarkers = { ...(branch.sessionMarkers || {}) };
        for (const key of patch.sessionMarkersAtDelivery) branch.sessionMarkers[key] = now;
    }
    if (Number.isFinite(patch.followupCount)) branch.followupCount = patch.followupCount;
    if (patch.markAutoMessage) branch.lastAutoMessageAt = now;
    if (Number.isFinite(patch.lastAutoMessageAt)) branch.lastAutoMessageAt = patch.lastAutoMessageAt;
    if (patch.groupAside?.key) {
        store.groupAsideLastSent = { ...(store.groupAsideLastSent || {}) };
        store.groupAsideLastSent[String(patch.groupAside.key)] = now;
    }
    return true;
}

/**
 * Post the one "replies may be slow" notice a busy branch is allowed within the
 * cooldown. Eligibility is checked inside the same write that saves the notice,
 * so two participants sharing a branch cannot both decide the coast is clear.
 */
export function commitConversationReplyNotice(context, target, speaker, activity, { noticeText, now = Date.now() }) {
    return commitConversationEffect(context, target, `notice:${speaker.avatar}`, branch => {
        const last = Number(branch.lastReplyNoticeAt) || 0;
        if (last && now - last < STATUS_NOTICE_COOLDOWN_MS) return { skipped: true };
        const message = createConversationMessage({ role: 'system', name: 'Status', mes: noticeText,
            extra: { conversation_mode_notice: true, availability: activity.status, partner_avatar: speaker.avatar } });
        if (!message) return { skipped: true };
        branch.messages.push(message);
        branch.messages = branch.messages.slice(-MAX_THREAD_MESSAGES);
        branch.lastReplyNoticeAt = now;
        refreshBranchPreview(branch);
        return { id: message.id };
    });
}

export function commitConversationJobCommands(context, target, effectId, parts, speakerAvatar, timeZone, now = Date.now()) {
    return commitConversationEffect(context, target, effectId, (_branch, store) => {
        const reminders = [];
        for (const [index, reminder] of parts.reminders.entries()) {
            const delay = parseReminderDelayToMs(reminder.delay, now, timeZone);
            if (delay <= 0 || now + delay > 8640000000000000) continue;
            const id = `rem_${digest([context.job.id, effectId, index]).slice(0, 32)}`;
            store.reminders.push({ id, avatar: target.avatar, groupId: target.groupId, personaId: target.personaId,
                branchId: target.branchId, triggerAt: now + delay, text: reminder.memo, fired: false, createdAt: now });
            reminders.push(id);
        }
        for (const raw of parts.scheduleUpdates) {
            const update = resolveConversationScheduleUpdate(raw, now);
            if (!update) continue;
            store.runtimeStatusOverrides ??= {};
            store.runtimeStatusOverrides[`${target.personaId}\u001f${speakerAvatar}`] = update;
        }
        return { reminders };
    });
}

/** Save a native memory summary on the branch, receipt-protected like any other effect. */
export function commitConversationMemorySummary(context, target, { summary, throughId = '', count = 0 } = {}) {
    const text = String(summary || '').trim();
    if (!text) throw conflict('The new memory summary was empty.');
    return commitConversationEffect(context, target, 'memory-summary', (branch, store) => {
        const updatedAt = Date.now();
        branch.memorySummary = text;
        branch.memoryMessageCount = Number.isFinite(count) && count > 0 ? count : (branch.messages || []).length;
        branch.memoryUpdatedAt = updatedAt;
        if (throughId) branch.memorySummaryThrough = String(throughId);
        const thread = store.characters?.[getConversationThreadKey(target.avatar, target.groupId, target.personaId)];
        if (thread) {
            thread.memorySummary = text;
            thread.memoryUpdatedAt = updatedAt;
            thread.memoryMessageCount = branch.memoryMessageCount;
            if (throughId) thread.memorySummaryThrough = String(throughId);
        }
        return { summary: text };
    });
}

/** Branch-independent store effect for character-scoped writes such as a generated schedule. */
export async function commitConversationStoreEffect(context, effectId, mutate) {
    context.signal?.throwIfAborted();
    const job = getJob(context.directories, context.job.id);
    if (!job || job.owner !== context.owner) throw conflict('The job no longer belongs to this account.');
    if (job.cancellation?.requested) {
        const error = new Error('The job was cancelled.');
        error.name = 'AbortError';
        throw error;
    }
    const scopedRequest = { user: { directories: context.directories, profile: { handle: context.owner } } };
    const saved = readUserSettingsWithStatus(scopedRequest);
    if (!saved?.ok) throw conflict(saved?.error || 'Settings could not be read.');
    const store = ensureConversationStore(saved.data, normalizeGroup);
    const effectKey = digest([job.id, effectId]);
    const receipt = store.serverOperations?.[effectKey];
    if (receipt && Object.hasOwn(receipt, 'result')) return receipt.result;
    const result = mutate(store, saved.data);
    if (result && typeof result.then === 'function') throw new TypeError('Conversation effects must be synchronous.');
    store.serverOperations = { ...(store.serverOperations || {}), [effectKey]: { result: result ?? null, at: Date.now() } };
    const receiptKeys = Object.keys(store.serverOperations);
    if (receiptKeys.length > 100) {
        receiptKeys.sort((left, right) => (store.serverOperations[left]?.at || 0) - (store.serverOperations[right]?.at || 0));
        for (const key of receiptKeys.slice(0, receiptKeys.length - 100)) delete store.serverOperations[key];
    }
    const saveResult = await saveConversationStore(scopedRequest, store, getSettingsVersion(saved.data), { trustedConversationEffects: true });
    if (!saveResult?.ok) throw Object.assign(new Error(saveResult?.body?.error || 'Conversation save failed.'), { status: saveResult?.status || 500, recoverable: true });
    return result;
}
