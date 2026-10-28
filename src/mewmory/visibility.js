import { randomUUID } from 'node:crypto';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { captureRoleplayStorageSourceLocked } from '../generation/roleplay-source.js';
import { abortJob } from '../jobs/runner.js';
import { listJobs, requestCancellation } from '../jobs/store.js';
import { commitSingleChatWriteLocked, reconcilePendingChatWrite } from '../roleplay-lifecycle.js';
import { confirmRoleplayAccount, roleplayHash, roleplayLease, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { fail, hash, text } from './core.js';
import { abortMewmoryRecall } from './retrieval.js';
import { mutateState, normalizeLocator, readStateShared } from './store.js';
import { abortMewmoryProcessing } from './worker.js';

// These match system_messages' notice types. Narrator and assistant-message
// rows can be ordinary dialogue and are intentionally not included.
const notices = new Set(['help', 'welcome', 'empty', 'generic', 'comment', 'slash_commands',
    'formatting', 'hotkeys', 'macros', 'welcome_prompt', 'assistant_note']);
const protectedLocator = locator => locator.group ? { group: true, chat: locator.chat }
    : { group: false, chat: locator.chat, avatar: locator.avatar };

/** Restore only rows marked by the shipped Mewmory hiding paths. */
export function restoreMewmoryHidden(records) {
    let restored = 0;
    const result = records.map((message, index) => {
        if (!index || message?.is_system !== true || message.extra?.mewmoryKeepHidden !== true
            || typeof message.is_user !== 'boolean' || message.extra?.tool_invocations
            || message.extra?.nn_generation_failed || notices.has(message.extra?.type)) return message;
        const extra = { ...message.extra };
        delete extra.mewmoryKeepHidden;
        restored++;
        return { ...message, is_system: false, extra };
    });
    return { records: result, restored };
}

function cancelMemoryWork(directories, locator, owner) {
    abortMewmoryProcessing(directories, locator);
    abortMewmoryRecall(directories, locator);
    for (const job of listJobs(directories, { owner, includeDismissed: true })) {
        if (!job.type.startsWith('mewmory.') || hash(job.intent?.locator) !== hash(locator)
            || !['queued', 'running', 'waiting'].includes(job.state)) continue;
        requestCancellation(directories, job.id, { reason: 'Mewmory was turned off.' });
        abortJob(job.id);
    }
}

function settlePending(base, account) {
    const pending = withRoleplayAccount(base, account, lease => Boolean(roleplayLease(lease).state.pending));
    if (pending) reconcilePendingChatWrite({ ...base, ...account }, roleplayNativeHost);
}

function restoreLocked(lease, locator, initial) {
    const { state: protectedState, scope } = roleplayLease(lease);
    const restore = initial.visibilityRestore;
    if (!restore || restore.status === 'complete') return initial;
    if (initial.enabled || initial.branchId !== restore.branchId
        || protectedState.accountId !== restore.account.accountId || protectedState.dataEpoch !== restore.account.dataEpoch) {
        fail('This chat or account changed before hidden messages could be restored. Reload and try again.', 409);
    }
    const resource = protectedState.resources[restore.instanceId];
    if (!resource || resource.kind !== 'chat' || resource.status !== 'live'
        || hash(resource.locator) !== hash(protectedLocator(locator))) {
        fail('The saved chat changed or no longer exists. Its hidden messages were not changed.', 409);
    }
    const receiptKey = restore.attemptKey && roleplayHash([protectedState.accountId, 'chat-write', restore.attemptKey]);
    const receipt = receiptKey && protectedState.submissions[receiptKey];
    if (receipt) {
        if (receipt.state !== 'closed') fail('An earlier chat restoration must finish first.', 409);
        return mutateState(scope.directories, locator, current => {
            if (current.visibilityRestore?.operationKey !== restore.operationKey || current.enabled) fail('Mewmory changed while restoring this chat.', 409);
            Object.assign(current.visibilityRestore, { status: 'complete', error: '', restored: restore.attemptCount || 0,
                source: receipt.outcome, finishedAt: Date.now() });
        });
    }
    const captured = captureRoleplayStorageSourceLocked(lease, protectedLocator(locator));
    if (captured.saved.instanceId !== restore.instanceId) fail('The saved chat was replaced before messages could be restored.', 409);
    if (captured.changed) saveRoleplayAccount(lease);
    const changed = restoreMewmoryHidden(captured.saved.records);
    if (!changed.restored) {
        return mutateState(scope.directories, locator, current => {
            if (current.visibilityRestore?.operationKey !== restore.operationKey || current.enabled) fail('Mewmory changed while restoring this chat.', 409);
            Object.assign(current.visibilityRestore, { status: 'complete', error: '', restored: 0, finishedAt: Date.now() });
        });
    }
    // A changed source needs a fresh native attempt key; a key never names two writes.
    const attemptKey = 'mewmory-restore:' + hash([restore.operationKey, captured.source, randomUUID()]);
    mutateState(scope.directories, locator, current => {
        if (current.visibilityRestore?.operationKey !== restore.operationKey || current.enabled) fail('Mewmory changed while restoring this chat.', 409);
        Object.assign(current.visibilityRestore, { status: 'pending', error: '', attemptKey,
            attemptSource: captured.source, attemptCount: changed.restored });
    });
    const result = commitSingleChatWriteLocked(lease, { operationKey: attemptKey, sourceKind: 'storage', mode: 'update',
        source: captured.source, records: changed.records, backup: { deferBackup: true } }, roleplayNativeHost);
    return mutateState(scope.directories, locator, current => {
        if (current.visibilityRestore?.operationKey !== restore.operationKey || current.enabled) fail('Mewmory changed while restoring this chat.', 409);
        Object.assign(current.visibilityRestore, { status: 'complete', error: '', restored: changed.restored,
            source: result, finishedAt: Date.now() });
    });
}

function markFailure(directories, locator, operationKey, error) {
    try {
        mutateState(directories, locator, current => {
            if (!current.enabled && current.visibilityRestore?.operationKey === operationKey
                && current.visibilityRestore.status !== 'complete') {
                Object.assign(current.visibilityRestore, { status: 'failed',
                    error: 'Mewmory is off, but some messages could not be shown. Retry restoration.' });
            }
        }, undefined, { existingOnly: true });
    } catch (saveError) {
        console.warn('[Mewmory] Could not record pending message restoration:', saveError.message);
    }
    if (error) console.warn('[Mewmory] Message restoration needs attention:', error.message);
}

/** Disable and restore as a recoverable, account-bound operation. */
export function disableMewmory(base, locator, { account, branchId, revision, operationKey, sourceInstanceId }) {
    locator = normalizeLocator(locator);
    operationKey = text(operationKey, 'Disable request ID', 256);
    if (!account || !base.owner || typeof sourceInstanceId !== 'string' || !sourceInstanceId) {
        fail('Reload this chat before turning off Mewmory.', 409);
    }
    let admitted = false;
    try {
        settlePending(base, account);
        return withRoleplayAccount(base, account, lease => {
            confirmRoleplayAccount(lease);
            const { state: protectedState } = roleplayLease(lease);
            let memory = readStateShared(base.directories, locator);
            const previous = memory.visibilityRestore;
            if (previous?.operationKey === operationKey) {
                if (previous.instanceId !== sourceInstanceId || previous.branchId !== branchId) fail('This off request belongs to another chat.', 409);
                if (memory.enabled) fail('This earlier off request is no longer current. Reload the chat.', 409);
                admitted = true;
                cancelMemoryWork(base.directories, locator, base.owner);
                return restoreLocked(lease, locator, memory);
            }
            if (previous && previous.status !== 'complete') fail('Finish restoring hidden messages before changing Mewmory.', 409);
            if (!Number.isSafeInteger(revision) || revision !== memory.revision || branchId !== memory.branchId) {
                fail('Mewmory changed somewhere else. Reload before turning it off.', 409);
            }
            const captured = captureRoleplayStorageSourceLocked(lease, protectedLocator(locator));
            if (captured.saved.instanceId !== sourceInstanceId) fail('The saved chat was replaced. Reload before turning off Mewmory.', 409);
            if (captured.changed) saveRoleplayAccount(lease);
            memory = mutateState(base.directories, locator, current => {
                current.enabled = false;
                current.preview = null;
                current.lastDisableId = operationKey;
                if (current.processing?.status === 'running') Object.assign(current.processing, { status: 'cancelled', finishedAt: Date.now() });
                current.visibilityRestore = { status: 'pending', operationKey, branchId: current.branchId,
                    account: { accountId: protectedState.accountId, dataEpoch: protectedState.dataEpoch },
                    instanceId: captured.saved.instanceId, startedAt: Date.now() };
            }, memory.revision);
            admitted = true;
            cancelMemoryWork(base.directories, locator, base.owner);
            return restoreLocked(lease, locator, memory);
        });
    } catch (error) {
        if (admitted) markFailure(base.directories, locator, operationKey, error);
        throw error;
    }
}

/** Retry the single durable unfinished intent; never guess a new account or chat. */
export function resumeVisibilityRestore(base, locator) {
    locator = normalizeLocator(locator);
    const initial = readStateShared(base.directories, locator);
    const pending = initial.visibilityRestore;
    if (!pending || pending.status === 'complete' || initial.enabled) return initial;
    try {
        settlePending(base, pending.account);
        return withRoleplayAccount(base, pending.account, lease => {
            cancelMemoryWork(base.directories, locator, base.owner);
            return restoreLocked(lease, locator, readStateShared(base.directories, locator));
        });
    } catch (error) {
        markFailure(base.directories, locator, pending.operationKey, error);
        throw error;
    }
}
