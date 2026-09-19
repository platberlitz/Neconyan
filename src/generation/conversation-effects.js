import { createHash } from 'node:crypto';
import { MAX_THREAD_MESSAGES } from '../../public/scripts/neconyan-conversation/constants.js';
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
    const request = { user: { directories: context.directories, profile: { handle: context.owner } } };
    const current = readConversationTarget(request, target);
    if (current.branch.createdAt !== target.createdAt) conflict('The Conversation branch was replaced.');
    const jobKey = digest(context.job.id);
    const effectKey = digest(effectId);
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

export function appendConversationJobMessage(context, target, effectId, value) {
    return commitConversationEffect(context, target, effectId, branch => {
        const message = createConversationMessage({ ...value, id: `job_${digest([context.job.id, effectId]).slice(0, 32)}` });
        if (!message) throw Object.assign(new Error('The generated Conversation message is invalid.'), { status: 400 });
        branch.messages.push(message);
        branch.messages = branch.messages.slice(-MAX_THREAD_MESSAGES);
        if (message.role === 'user') {
            branch.lastActivity = Date.now();
            branch.followupCount = 0;
        }
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
