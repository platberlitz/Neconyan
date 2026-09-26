import { createHash } from 'node:crypto';
import { MAX_THREAD_MESSAGES, STATUS_NOTICE_COOLDOWN_MS } from '../../public/scripts/neconyan-conversation/constants.js';
import { resolveConversationScheduleUpdate } from '../../public/scripts/neconyan-conversation/generation-utils.js';
import { parseReminderDelayToMs } from '../../public/scripts/neconyan-conversation/reminder-time.js';
import { countConversationUnread } from '../../public/scripts/neconyan-conversation/notification-utils.js';
import { isConversationGroupSpeakerEligible } from '../../public/scripts/neconyan-conversation/partners-utils.js';
import { authorizeConversationGroup, normalizeConversationGroupRecord } from '../endpoints/conversation-groups.js';
import { normalizeConversationSettings } from '../endpoints/conversation-generation.js';
import { createConversationMessage, refreshBranchPreview } from '../endpoints/conversation-messages.js';
import { ensureConversationStore, getConversationThreadKey, readUserSettingsWithStatus, saveConversationStore } from '../endpoints/conversation-store.js';
import { repairConversationBranchMessageIds, seedConversationReadBoundary } from '../endpoints/conversation-utils.js';
import { getJob, holdJobPruning } from '../jobs/store.js';
import { readArtifact } from '../jobs/artifacts.js';
import { conversationChimeOccurrenceKey, conversationReminderIdentityKey, getConversationSummarySubmissionKey } from './conversation-auto-policy.js';
import { getConversationMessagesHash, getSettingsVersion } from '../settings-version.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = message => { throw Object.assign(new Error(message), { status: 409, recoverable: true }); };
const normalizeGroup = group => normalizeConversationGroupRecord(group, normalizeConversationSettings);

const MAX_PENDING_PRESENTATIONS = 50;

/** Keep only un-consumed claims whose message still exists, in arrival order, bounded. */
function prunePendingPresentations(entries, messages) {
    const ids = new Set((Array.isArray(messages) ? messages : []).map(message => message?.id).filter(Boolean));
    const kept = Object.entries(entries).filter(([id]) => ids.has(id));
    if (kept.length <= MAX_PENDING_PRESENTATIONS) return Object.fromEntries(kept);
    // Presentation iterates the stored key order, so keep the newest 50 in
    // chronological order; reversing here would narrate later bubbles first.
    kept.sort((left, right) => (Number(left[1]?.at) || 0) - (Number(right[1]?.at) || 0));
    return Object.fromEntries(kept.slice(-MAX_PENDING_PRESENTATIONS));
}

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
    if (branch.messageContentHash && branch.messageContentHash !== getConversationMessagesHash(branch.messages)) conflict('The saved Conversation message fingerprint is stale.');
    // messageCount freezes the length the hash covers. An effect then verifies
    // that prefix instead of the whole array, so a later accepted send may
    // append user bubbles without invalidating an earlier reply, while an edit
    // or deletion inside the captured prefix is still a conflict.
    return { ...normalized, createdAt: branch.createdAt,
        ...(branch.messageContentHash && Number.isSafeInteger(branch.messageEditRevision) ? { messageEditRevision: branch.messageEditRevision } : {}),
        messageCount: branch.messages.length, messagesHash: digest(branch.messages) };
}

/** Stamp legacy history before freezing new work; old frozen requests stay conservative. */
export async function prepareConversationTarget(request, target) {
    const captured = captureConversationTarget(request, target);
    const current = readConversationTarget(request, captured);
    const repaired = repairConversationBranchMessageIds(current.branch);
    const needsBoundary = typeof current.branch.readThrough !== 'string';
    seedConversationReadBoundary(current.branch);
    if (!repaired && !needsBoundary && Number.isSafeInteger(captured.messageEditRevision)) return captured;
    const preparedHash = digest(current.branch.messages);
    const saved = await saveConversationStore(request, current.store, current.version, { trustedConversationEffects: true });
    if (!saved.ok) conflict('The Conversation history could not be prepared.');
    const prepared = captureConversationTarget(request, target);
    if (prepared.createdAt !== captured.createdAt || prepared.messagesHash !== preparedHash) conflict('The Conversation history changed during preparation.');
    return prepared;
}

/** Record acceptance before preparation or cancellation can make a job prunable.
 * Unlike completion bookkeeping, this survives failed attempts and branch resets.
 * Storage limits refuse new work rather than forgetting a paid occurrence. */
export async function retainConversationAutomaticAcceptance(request, job) {
    const keys = [];
    if (job.type === 'conversation.reply') {
        if (job.intent?.mode === 'auto') keys.push(job.submissionKey);
        if (job.intent?.automation?.kind === 'reminder') {
            const id = job.intent.automation.patch?.reminder?.id || job.intent.plan?.[0]?.extra?.reminder_id;
            if (id) keys.push(conversationReminderIdentityKey(id));
        }
        const snapshot = readArtifact(request.user.directories, job.id, 'request');
        const chime = snapshot?.participants?.find(participant => participant.purpose === 'chime');
        const markers = chime?.automation?.patch?.sessionMarkers;
        const activity = markers?.sb_conv_last_chime_session_ ?? markers?.[`sb_conv_last_chime_session_${snapshot?.target?.groupId || 'solo'}`];
        if (activity !== undefined) keys.push(conversationChimeOccurrenceKey(snapshot.target, activity));
    } else if (job.type === 'conversation.summary' && job.automatic) {
        keys.push(job.submissionKey);
        const snapshot = readArtifact(request.user.directories, job.id, 'request');
        if (snapshot?.throughId) keys.push(getConversationSummarySubmissionKey(job.intent.target, snapshot.throughId));
    }
    if (!keys.length) return;
    if (job.owner !== request.user.profile.handle) conflict('The Conversation job belongs to another account.');
    const saved = readUserSettingsWithStatus(request);
    if (!saved.ok) conflict('The Conversation settings could not be read.');
    const store = ensureConversationStore(saved.data, normalizeGroup);
    store.automation ??= {};
    store.automation.acceptedOccurrences ??= {};
    let changed = false;
    for (const value of keys) {
        const key = digest(value);
        // A legacy duplicate cannot replace the first durable owner. Chime
        // dispatch checks that owner, while unrelated Send participants proceed.
        if (store.automation.acceptedOccurrences[key]) continue;
        store.automation.acceptedOccurrences[key] = job.id;
        changed = true;
    }
    if (!changed) return;
    const result = await saveConversationStore(request, store, getSettingsVersion(saved.data), { trustedConversationEffects: true });
    if (!result.ok) conflict('The automatic Conversation acceptance could not be saved.');
}

export function wasConversationAutomaticOccurrenceAccepted(store, key) {
    return Object.hasOwn(store.automation?.acceptedOccurrences || {}, digest(key));
}

export function acceptedConversationOccurrenceOwner(store, key) {
    return store.automation?.acceptedOccurrences?.[digest(key)];
}

/** Upgrade ledger-only ownership before any new automatic selection. */
export async function backfillConversationAutomaticAcceptances(request, jobs) {
    const owner = request.user.profile.handle;
    holdJobPruning(owner);
    const ordered = [...jobs].sort((a, b) => Number(Boolean(b.config?.chimeClaim)) - Number(Boolean(a.config?.chimeClaim)) || a.createdAt - b.createdAt);
    for (const job of ordered) await retainConversationAutomaticAcceptance(request, job);
    // A failed copy deliberately leaves pruning held; the next scan retries it.
    holdJobPruning(owner, false);
}

function readConversationEffectState(context, target, effectId) {
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
    return { request, current, jobKey, effectKey, receipt };
}

export function readConversationEffectReceipt(context, target, effectId) {
    const { receipt, effectKey } = readConversationEffectState(context, target, effectId);
    return receipt && Object.hasOwn(receipt.effects, effectKey) ? receipt.effects[effectKey] : undefined;
}

function assertConversationCheckpoint(current, target, receipt) {
    const currentMessages = current.branch.messages;
    // Verify both the frozen request's captured prefix and this family's
    // advancing receipt. The receipt can be shorter than the frozen request when
    // an earlier send extended the thread before this job froze it, so checking
    // only the receipt would miss an edit of those later messages. A receipt
    // written before messageCount existed falls back to the whole-array hash.
    const prefixMatches = (count, hashValue) => {
        if (!Number.isInteger(count)) {
            return digest(currentMessages) === hashValue;
        }
        if (currentMessages.length < count) return false;
        if (digest(currentMessages.slice(0, count)) === hashValue) return true;
        // Automatic retention trims the oldest messages from the front, so a
        // captured prefix can shift forward while staying contiguous. Match it
        // wherever it now sits; if it was trimmed away, no window matches and
        // the effect is still refused.
        // ponytail: O(n^2) hashing on the fallback path only; n is bounded by
        // MAX_THREAD_MESSAGES (250), so no index is worth keeping.
        for (let start = 1; start + count <= currentMessages.length; start += 1) {
            if (digest(currentMessages.slice(start, start + count)) === hashValue) return true;
        }
        return false;
    };
    const checkpointMatches = checkpoint => Number.isSafeInteger(checkpoint.messageEditRevision) && current.branch.messageContentHash
        ? checkpoint.messageEditRevision === current.branch.messageEditRevision
        : prefixMatches(checkpoint.messageCount, checkpoint.messagesHash);
    const unchanged = (!current.branch.messageContentHash || current.branch.messageContentHash === getConversationMessagesHash(currentMessages))
        && checkpointMatches(target) && (!receipt || checkpointMatches(receipt));
    if (!unchanged) {
        conflict('The Conversation messages changed before this reply could be saved.');
    }
}

/** The same source check protects provider work and the final message write. Caller may hold the account lock. */
export function assertConversationEffectSource(context, target, effectId, { verify } = {}) {
    const state = readConversationEffectState(context, target, effectId);
    if (verify) verify(state.current);
    else assertConversationCheckpoint(state.current, target, state.receipt);
    return state.current;
}

/**
 * Write a native effect and its receipt in the same settings-file replacement.
 * `verify` replaces the whole-branch checkpoint for a write that depends only on
 * the messages it names, such as rewriting one reply.
 */
export async function commitConversationEffect(context, target, effectId, mutate, { verify } = {}) {
    const { request, current, jobKey, effectKey, receipt } = readConversationEffectState(context, target, effectId);
    if (receipt && Object.hasOwn(receipt.effects, effectKey)) return receipt.effects[effectKey];
    if (verify) verify(current);
    else assertConversationCheckpoint(current, target, receipt);
    const result = mutate(current.branch, current.store, current.settings);
    if (result?.then) throw new TypeError('A Conversation effect must finish before releasing its settings write.');
    current.branch.serverOperations ??= {};
    current.branch.serverOperations[jobKey] = {
        ...(current.branch.messageContentHash && Number.isSafeInteger(current.branch.messageEditRevision) ? { messageEditRevision: current.branch.messageEditRevision } : {}),
        messageCount: current.branch.messages.length,
        messagesHash: digest(current.branch.messages),
        effects: { ...receipt?.effects, [effectKey]: result ?? null },
    };
    const saved = await saveConversationStore(request, current.store, current.version, { trustedConversationEffects: true });
    if (!saved.ok) throw Object.assign(new Error(saved.body?.error || 'Conversation save failed.'), { status: saved.status });
    return result;
}

export function appendConversationJobMessage(context, target, effectId, value, { mutate, presentation, verify } = {}) {
    return commitConversationEffect(context, target, effectId, (branch, store, settings) => {
        const message = createConversationMessage({ ...value, id: `job_${digest([context.job.id, effectId]).slice(0, 32)}` });
        if (!message) throw Object.assign(new Error('The generated Conversation message is invalid.'), { status: 400 });
        if (seedConversationReadBoundary(branch) === null) conflict('The Conversation message identities must be prepared before delivery.');
        branch.messages.push(message);
        branch.messages = branch.messages.slice(-MAX_THREAD_MESSAGES);
        branch.unread = countConversationUnread(branch.messages, branch.readThrough);
        if (message.role === 'user') {
            branch.lastActivity = Date.now();
            branch.followupCount = 0;
        }
        if (!['user', 'system'].includes(message.role)) {
            branch.pendingPresentations = prunePendingPresentations({
                ...(branch.pendingPresentations || {}),
                [message.id]: { at: Date.now(), job: context.job.id, narration: presentation?.narration ?? null },
            }, branch.messages);
        }
        refreshBranchPreview(branch);
        mutate?.(branch, store, settings);
        return { id: message.id };
    }, { verify });
}

/**
 * Consume pending presentation claims. Deleting a claim inside the same
 * settings write that saves it is the exactly-once gate: whichever caller's
 * replace lands on disk owns the presentation, and every later caller finds
 * the claim gone. A read boundary clears only messages the caller observed.
 */
export async function claimConversationPresentations(request, { target, messageIds, readThrough } = {}) {
    const current = readConversationTarget(request, target);
    const branch = current.branch;
    if (branch.createdAt !== target.createdAt) conflict('The Conversation branch was replaced.');
    const won = {};
    let changed = false;
    const existing = branch.pendingPresentations;
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        const entries = { ...existing };
        for (const id of Array.isArray(messageIds) ? messageIds : []) {
            if (typeof id !== 'string' || !Object.hasOwn(entries, id)) continue;
            const message = branch.messages.find(item => item.id === id);
            const speaker = message?.extra?.partner_avatar || target.avatar;
            if (message && (!target.groupId || isConversationGroupSpeakerEligible(current.group, speaker))) {
                won[id] = entries[id]?.narration ?? null;
            }
            delete entries[id];
            changed = true;
        }
        if (changed) {
            if (Object.keys(entries).length) branch.pendingPresentations = entries;
            else delete branch.pendingPresentations;
        }
    }
    const readIndex = typeof readThrough === 'string' ? branch.messages.findIndex(message => message.id === readThrough) : -1;
    const previousIndex = branch.messages.findIndex(message => message.id === branch.readThrough);
    if (readIndex >= 0 && readIndex >= previousIndex && branch.readThrough !== readThrough) {
        branch.readThrough = readThrough;
        branch.unread = countConversationUnread(branch.messages, readThrough);
        changed = true;
    }
    if (!changed) return { won: {}, version: current.version, unread: branch.unread, readThrough: branch.readThrough };
    const saved = await saveConversationStore(request, current.store, current.version, { trustedConversationEffects: true });
    if (!saved.ok) throw Object.assign(new Error(saved.body?.error || 'Conversation save failed.'), { status: saved.status, body: saved.body, recoverable: true });
    return { won, version: saved.version, unread: branch.unread, readThrough: branch.readThrough };
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
    return commitConversationEffect(context, target, effectId, (_branch, store) => applyConversationJobCommands(store, target, parts, speakerAvatar,
        { timeZone, now, idSeed: [context.job.id, effectId] }));
}

/** Apply reply commands inside a caller's effect so a rewrite saves its text and commands together. */
export function applyConversationJobCommands(store, target, parts, speakerAvatar, { timeZone, now, idSeed }) {
    const reminders = [];
    for (const [index, reminder] of parts.reminders.entries()) {
        const delay = parseReminderDelayToMs(reminder.delay, now, timeZone);
        if (delay <= 0 || now + delay > 8640000000000000) continue;
        const id = `rem_${digest([...idSeed, index]).slice(0, 32)}`;
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
}

export function getConversationMemoryFingerprint(branch) {
    return digest([branch.memorySummary ?? null, branch.memoryMessageCount ?? null, branch.memoryUpdatedAt ?? null, branch.memorySummaryThrough ?? null]);
}

/** Save a native memory summary on the branch, receipt-protected like any other effect. */
export function commitConversationMemorySummary(context, target, { summary, throughId = '', count = 0, memoryFingerprint } = {}) {
    const text = String(summary || '').trim();
    if (!text) throw conflict('The new memory summary was empty.');
    return commitConversationEffect(context, target, 'memory-summary', (branch, store) => {
        if (memoryFingerprint === undefined || getConversationMemoryFingerprint(branch) !== memoryFingerprint) {
            conflict('The Conversation memory changed before this summary could be saved.');
        }
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
