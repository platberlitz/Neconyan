import crypto from 'node:crypto';
import fs from 'node:fs';
import { addChatNavigationCharacterRenameSteps, assertChatNavigationCharacterRename, finishChatNavigationCharacterRename } from './chat-navigation-lifecycle.js';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import sanitize from 'sanitize-filename';
import { withChatFileLocks } from './chat-file-lock.js';
import { clearChatRecoveryState, createCharacterChatTarget, createGroupChatTarget, markChatDeleted, parseChatJsonl,
    rekeyChatRecoveryState, restoreChatSnapshotIfMatches, runChatRecoveryBestEffort } from './chat-recovery.js';
import { assertRoleplaySourceLocked, assertPendingRoleplayDependencies, captureRoleplayDependenciesLocked, normaliseRoleplayLocator,
    roleplayChatPath, roleplayContentHash, roleplayPathKey, roleplayGroupContentHash, normaliseRoleplayGroupId,
    assertRoleplayGroupData, readRoleplayEntityLocked, readRoleplayChatLocked, roleplayEntityContent } from './generation/roleplay-source.js';
import { assertRoleplayTransactionCapacity, confirmRoleplayAccount, createRoleplayDirectory, readRoleplayFile, readRoleplayPayload,
    roleplayError, roleplayHash, roleplayLease, saveRoleplayAccount, stageRoleplayPayload, withRoleplayAccountLock, ROLEPLAY_LARGEST_PHYSICAL,
    largestRoleplayJournal, roleplayPayloadDirectory, initialiseRoleplayAccount, readRoleplayWriteJournal, roleplayAvatarOwner,
    validRoleplayAvatar, ROLEPLAY_IMPORT_MAX_OUTPUTS, ROLEPLAY_LIFECYCLE_MAX_STEPS, roleplayImportPlan, settleRoleplayAccountReset } from './roleplay-store.js';
import { applyPreparedBranchMemoryCapture, assertPreparedBranchMemory, prepareBranchMemoryCapture } from './mewmory/prepared-branch.js';
import { read as readCharacterCard, write as writeCharacterCard } from './character-card-parser.js';
import { MAX_ARCHIVE_BYTES, chatMemoryExists, removeChatMemory, removeSourceMemory, renameCharacterMemory, renameChatMemory } from './mewmory/store.js';
import { createEntityDateAdded, removeEntityDateAdded } from './entity-date-added.js';
import { getJob } from './jobs/store.js';
import { bindRoleplayScratchpadsLocked } from './scratchpad/store.js';
import { decodeFileWriteRecovery, fsyncDirectorySync, humanizedDateTime, tryWriteFileSync, FILE_WRITE_RECOVERY_SUFFIX } from './util.js';

const CHAT_LIMIT = 64 * 1024 * 1024;
const EFFECT_KEY = roleplayHash('chat-write');
const GROUP_EFFECT_KEY = roleplayHash('group-update');
const IMPORT_EFFECT_KEY = roleplayHash('chat-import');
const conflict = () => roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved chat differs from the recorded transaction; its current contents were retained.');

function key(state, operationKey) {
    if (typeof operationKey !== 'string' || !operationKey || operationKey.length > 256) throw roleplayError('ROLEPLAY_INVALID', 'Invalid chat write identity.', 400);
    return roleplayHash([state.accountId, 'chat-write', operationKey]);
}

function target(scope, locator) {
    return locator.group
        ? createGroupChatTarget({ groupChatsDirectory: scope.directories.groupChats, backupDirectory: scope.directories.backups, filename: locator.chat + '.jsonl' })
        : createCharacterChatTarget({ chatsDirectory: scope.directories.chats, backupDirectory: scope.directories.backups, owner: roleplayAvatarOwner(locator.avatar), filename: locator.chat + '.jsonl' });
}

function rejectUndoJournal(filename) {
    const refused = () => roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'A prior undo journal must be reconciled explicitly before this native transaction.');
    try {
        if (!readRoleplayWriteJournal(filename, { allowMissingParent: true })) return;
    } catch (cause) { throw Object.assign(refused(), { cause }); }
    throw refused();
}

function sameObservation(file, expected) {
    return Boolean(file && expected && file.rawHash === expected.rawHash && isDeepStrictEqual(file.physical, expected.physical));
}

function inspectPendingJournal(filename, pending, file, knownAfter, needsFinalisation) {
    const thirdState = nextHash => Boolean(file) && file.rawHash === nextHash
        && file.rawHash !== pending.after.rawHash && file.rawHash !== pending.before?.rawHash;
    if (pending.journal && thirdState(pending.journal.nextHash)) throw conflict();
    const finalised = knownAfter && !needsFinalisation;
    const refused = cause => Object.assign(roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The prior write journal does not match this transaction; its evidence was retained.'), { cause });
    let journal;
    try {
        journal = readRoleplayWriteJournal(filename, { allowMissingParent: true });
    } catch (cause) {
        if (finalised) return null;
        throw refused(cause);
    }
    if (!journal || finalised) return null;
    if ((pending.journal && !sameObservation(journal, pending.journal)) || (knownAfter && !pending.journal)) throw refused();
    const record = decodeFileWriteRecovery(journal.bytes, CHAT_LIMIT);
    if (!record || pending.mode !== 'update' || record.originalHash !== pending.before.rawHash
        || record.dev !== pending.before.physical.dev || record.ino !== pending.before.physical.ino
        || (record.birthtime !== null && record.birthtime !== pending.before.physical.birthtimeNs)
        || (pending.journal && record.nextHash !== pending.journal.nextHash)) throw refused();
    if (thirdState(record.nextHash)) throw conflict();
    return { rawHash: journal.rawHash, physical: journal.physical, originalHash: record.originalHash, nextHash: record.nextHash };
}

function cleanupEffect(lease, effect) {
    const { scope } = roleplayLease(lease);
    const directory = roleplayPayloadDirectory(lease, effect.writeId);
    for (const [name, hash] of Object.entries(effect.cleanup.payloads)) {
        const filename = path.join(directory, name);
        const file = readRoleplayFile(filename, ['chat.after.jsonl', 'group.after.json', 'import.group.after.json'].includes(name)
            || /^import\.chat\.\d+\.jsonl$|^lifecycle\.\d+\.bin$/.test(name) ? CHAT_LIMIT : MAX_ARCHIVE_BYTES, { allowMissingParent: true });
        if (!file) continue;
        if (file.rawHash !== hash) {
            console.warn('Roleplay cleanup retained a changed staged file.');
            continue;
        }
        fs.unlinkSync(filename);
        fsyncDirectorySync(directory);
    }
    try {
        // Validate the entire path again; never follow a replaced staging directory.
        fs.rmdirSync(roleplayPayloadDirectory(lease, effect.writeId));
        fsyncDirectorySync(path.dirname(directory));
    } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    const expected = effect.cleanup.journal;
    if (!expected) return;
    const chat = roleplayChatPath(scope, expected.locator);
    const journalPath = chat + FILE_WRITE_RECOVERY_SUFFIX;
    const read = () => readRoleplayWriteJournal(chat, { allowMissingParent: true });
    // Check before acquiring the chat lock, which may otherwise recreate a deleted directory.
    if (!sameObservation(read(), expected)) return;
    withChatFileLocks([chat], () => {
        if (!sameObservation(read(), expected)) return;
        fs.unlinkSync(journalPath);
        fsyncDirectorySync(path.dirname(journalPath));
    });
}

/** The caller has confirmed its lease or just durably saved it. Mutable state is not cleanup authority. */
export function cleanupRoleplayReceiptsLocked(lease, operationKeyHash = null) {
    const { stateFile } = roleplayLease(lease);
    const persisted = JSON.parse(stateFile.bytes.toString('utf8')).state;
    if (persisted.pending !== null) return;
    const receipts = operationKeyHash === null ? Object.values(persisted.submissions) : [persisted.submissions[operationKeyHash]];
    for (const receipt of receipts) {
        if (receipt?.state !== 'closed') continue;
        for (const effect of Object.values(receipt.effects)) {
            if (!effect.cleanup) continue;
            try { cleanupEffect(lease, effect); } catch (error) {
                console.warn('Roleplay receipt cleanup retained its remaining files:', error?.code || error?.name);
            }
        }
    }
}

export function cleanupRoleplayReceipts(scope) {
    return withRoleplayAccountLock(scope, lease => {
        confirmRoleplayAccount(lease);
        cleanupRoleplayReceiptsLocked(lease);
    });
}

function resultFor(pending) {
    return { instanceId: pending.instanceId, revision: pending.after.revision, rawHash: pending.after.rawHash,
        integrity: pending.after.integrity, writeId: pending.id, changed: pending.changed, mode: pending.mode };
}

function completedResult(receipt) {
    if (receipt.state !== 'closed') throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'This chat write has no completed storage result.');
    return structuredClone(receipt.outcome);
}

function finishedState(state, pending, physical) {
    const next = structuredClone(state);
    const old = next.resources[pending.instanceId];
    next.resources[pending.instanceId] = { ...(old || { accountId: state.accountId, dataEpoch: state.dataEpoch,
        kind: 'chat', locator: pending.locator, status: 'live', busySubmission: null }), revision: pending.after.revision,
    head: { rawHash: pending.after.rawHash, contentHash: pending.after.contentHash, writeId: pending.after.writeId, physical } };
    const pathKey = roleplayPathKey(state, 'chat', pending.locator);
    if (pending.mode === 'create') next.paths[pathKey] = { generation: pending.expectedVacancy + 1, instanceId: pending.instanceId };
    const result = resultFor(pending);
    const cleanup = { payloads: { 'chat.after.jsonl': pending.after.rawHash },
        journal: pending.journal ? { locator: pending.locator, rawHash: pending.journal.rawHash, physical: pending.journal.physical } : null };
    if (pending.memory?.kind === 'create') {
        cleanup.payloads['memory.archive.json'] = pending.memory.archiveHash;
        cleanup.payloads['memory.guard.json'] = pending.memory.guardHash;
    }
    next.submissions[pending.operationKeyHash] = { accountId: state.accountId, dataEpoch: state.dataEpoch, intentHash: pending.intentHash,
        jobId: null, targetInstanceId: pending.instanceId, state: 'closed', reservedReceiptBytes: 0, outcome: result,
        effects: { [EFFECT_KEY]: { effectHash: pending.intentHash, writeId: pending.id, instanceId: pending.instanceId,
            appliedRevision: pending.after.revision, result, cleanup } } };
    next.pending = null;
    return next;
}

/**
 * Every chat save leaves a receipt, and every later load rehashes them all. Once a chat has moved this many
 * revisions past a closed write, replaying that write's key fails its stale source check instead of reapplying it.
 */
const CHAT_RECEIPT_KEEP_REVISIONS = 16;

function prunableChatWriteReceipts(state, scope, keepKeyHash) {
    const kept = new Set([keepKeyHash]);
    for (const resource of Object.values(state.resources)) if (resource.busySubmission) kept.add(resource.busySubmission);
    for (const receipt of Object.values(state.submissions)) {
        if (!receipt.jobId || !['preparing', 'accepted'].includes(receipt.state)) continue;
        // An open Roleplay job finds its finished write by this receipt and would otherwise write again.
        let operationKey;
        try { operationKey = getJob(scope.directories, receipt.jobId)?.intent?.roleplay?.operationKey; } catch { return []; }
        if (typeof operationKey === 'string' && operationKey && operationKey.length <= 200) kept.add(key(state, `job:${operationKey}`));
    }
    return Object.entries(state.submissions).filter(([keyHash, receipt]) => {
        if (kept.has(keyHash) || receipt.state !== 'closed' || receipt.jobId !== null || receipt.outcome?.kind !== undefined) return false;
        const effects = Object.keys(receipt.effects);
        if (effects.length !== 1 || effects[0] !== EFFECT_KEY) return false;
        const resource = state.resources[receipt.targetInstanceId];
        return resource.status !== 'live' || resource.revision - receipt.effects[EFFECT_KEY].appliedRevision >= CHAT_RECEIPT_KEEP_REVISIONS;
    }).map(([keyHash]) => keyHash);
}

function preparedFromPayload(pending, bytes) {
    const parsed = parseChatJsonl(bytes);
    if (parsed.status !== 'ok' || roleplayContentHash(parsed.records) !== pending.after.contentHash) throw conflict();
    const inputRecords = structuredClone(parsed.records);
    if (pending.before?.integrity) inputRecords[0].chat_metadata.integrity = pending.before.integrity;
    else delete inputRecords[0].chat_metadata.integrity;
    return { changed: pending.changed, inputRecords, records: parsed.records, serialized: bytes.toString('utf8'), integrity: pending.after.integrity };
}

function publishPending(lease, host, filename, before, payload, expectedJournal) {
    const { state: { pending }, scope } = roleplayLease(lease);
    const prepared = preparedFromPayload(pending, payload.bytes);
    if (payload.filename === null) {
        prepared.changed = false;
        prepared.inputRecords = structuredClone(prepared.records);
    }
    try {
        return host.publish({ filePath: filename, before, payloadPath: payload.filename,
            payloadHash: pending.after.rawHash, prepared, handle: scope.owner,
            cardName: pending.locator.group ? pending.locator.chat : roleplayAvatarOwner(pending.locator.avatar),
            backupDirectory: scope.directories.backups, recoveryTarget: target(scope, pending.locator),
            force: pending.force === true, allowShrink: pending.allowShrink,
            deferBackup: pending.backup.deferBackup, deferSequenceId: pending.backup.deferSequenceId, expectedJournal }).file;
    } catch (error) {
        if (error.chatCommitted) {
            try {
                const committed = readRoleplayFile(filename, CHAT_LIMIT, { flush: true });
                if (!committed || committed.rawHash !== pending.after.rawHash
                    || (before && !isDeepStrictEqual(committed.physical, before.physical))) throw conflict();
                pending.phase = 'chat-applied';
                pending.appliedPhysical = committed.physical;
                saveRoleplayAccount(lease);
            } catch (confirmationError) { error.confirmationError = confirmationError; }
        }
        throw error;
    }
}

function applyPending(lease, host) {
    const { state, scope } = roleplayLease(lease);
    const pending = state.pending;
    if (!pending || pending.kind !== 'chat-write') throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'There is no matching chat write to reconcile.');
    const filename = roleplayChatPath(scope, pending.locator);
    let file = readRoleplayFile(filename, CHAT_LIMIT, { allowMissingParent: pending.mode === 'create' });
    if (pending.phase !== 'prepared' && file?.rawHash !== pending.after.rawHash) throw conflict();
    const beforeMatches = pending.before && file && file.rawHash === pending.before.rawHash
        && isDeepStrictEqual(file.physical, pending.before.physical);
    // An unacknowledged no-op must still run the existing writer's backup finalisation.
    const knownAfter = file?.rawHash === pending.after.rawHash && (pending.changed || pending.phase !== 'prepared' || Boolean(pending.repair));
    const needsFinalisation = pending.phase === 'prepared' && (Boolean(pending.repair) || !pending.backup.deferBackup);
    const journal = inspectPendingJournal(filename, pending, file, knownAfter, needsFinalisation);
    const expectedJournal = journal ? { rawHash: journal.rawHash, physical: journal.physical } : null;
    if (!knownAfter) {
        assertPendingRoleplayDependencies(lease);
        assertPreparedBranchMemory(scope.directories, pending.locator, pending.memory, { mode: pending.mode });
    }
    if (knownAfter) {
        if (pending.mode !== 'create' && !pending.repair && !isDeepStrictEqual(file.physical, pending.before.physical)) throw conflict();
        if (pending.appliedPhysical && !isDeepStrictEqual(file.physical, pending.appliedPhysical)) throw conflict();
        // A completed after-image is sufficient even if temporary staging was lost after publication.
        const flushed = readRoleplayFile(filename, CHAT_LIMIT, { flush: true });
        if (!flushed || flushed.rawHash !== file.rawHash || !isDeepStrictEqual(flushed.physical, file.physical)) throw conflict();
        file = flushed;
        if (needsFinalisation) {
            file = publishPending(lease, host, filename, file, { filename: null, bytes: file.bytes }, expectedJournal);
        }
    } else if (beforeMatches || (!file && pending.mode === 'create')) {
        const payload = readRoleplayPayload(lease, pending.id, pending.after.payload, pending.after.rawHash, CHAT_LIMIT);
        if (journal && !pending.journal) {
            pending.journal = journal;
            saveRoleplayAccount(lease);
        }
        createRoleplayDirectory(path.dirname(filename), scope.directories.root);
        file = publishPending(lease, host, filename, pending.before, payload, expectedJournal);
    } else {
        if (!file || !pending.before || !isDeepStrictEqual(file.physical, pending.before.physical)
            || parseChatJsonl(file.bytes).status === 'ok') throw conflict();
        const payload = readRoleplayPayload(lease, pending.id, pending.after.payload, pending.after.rawHash, CHAT_LIMIT);
        stageRoleplayPayload(lease, pending.id, 'chat.corrupt.jsonl', file.bytes, CHAT_LIMIT);
        pending.repair = { rawHash: file.rawHash, physical: file.physical };
        if (journal) pending.journal = journal;
        saveRoleplayAccount(lease);
        file = restoreChatSnapshotIfMatches(target(scope, pending.locator), {
            bytes: payload.bytes, expectedSnapshotHash: pending.after.rawHash, expectedActive: pending.repair, expectedJournal,
        });
        file = publishPending(lease, host, filename, file, { filename: null, bytes: file.bytes }, expectedJournal);
    }
    if (!file || file.rawHash !== pending.after.rawHash || roleplayContentHash(parseChatJsonl(file.bytes).records) !== pending.after.contentHash) throw conflict();
    pending.phase = 'chat-applied';
    pending.appliedPhysical = file.physical;
    try { saveRoleplayAccount(lease); } catch (error) { throw Object.assign(error, { chatCommitted: true, integrity: pending.after.integrity }); }
    try {
        applyPreparedBranchMemoryCapture(scope.directories, pending.locator, pending.memory, {
            mode: pending.mode,
            chat: { rawHash: file.rawHash, physical: file.physical },
            payload: (name, hash) => readRoleplayPayload(lease, pending.id, name, hash, MAX_ARCHIVE_BYTES).bytes,
        });
    } catch (error) { throw Object.assign(error, { chatCommitted: true, integrity: pending.after.integrity }); }
    const result = resultFor(pending);
    const final = finishedState(state, pending, file.physical);
    const pruned = prunableChatWriteReceipts(final, scope, pending.operationKeyHash).map(keyHash => {
        const effect = final.submissions[keyHash].effects[EFFECT_KEY];
        delete final.submissions[keyHash];
        return effect;
    });
    Object.assign(state, final);
    try { saveRoleplayAccount(lease); } catch (error) { throw Object.assign(error, { chatCommitted: true, integrity: pending.after.integrity }); }
    cleanupRoleplayReceiptsLocked(lease, pending.operationKeyHash);
    for (const effect of pruned) {
        if (!effect.cleanup) continue;
        try { cleanupEffect(lease, effect); } catch (error) {
            console.warn('Roleplay receipt cleanup retained its remaining files:', error?.code || error?.name);
        }
    }
    return result;
}

function groupUpdateKey(state, operationKey) {
    if (typeof operationKey !== 'string' || !operationKey || operationKey.length > 256) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid group update identity.', 400);
    }
    return roleplayHash([state.accountId, 'group-update', operationKey]);
}

function groupUpdateResult(pending) {
    return { kind: 'group', mode: 'update', instanceId: pending.instanceId, revision: pending.after.revision,
        rawHash: pending.after.rawHash, integrity: '', writeId: pending.id,
        changed: pending.changed, rawChanged: pending.rawChanged };
}

function finishedGroupUpdate(state, pending, physical) {
    const next = JSON.parse(JSON.stringify(state));
    const resource = next.resources[pending.instanceId];
    resource.revision = pending.after.revision;
    resource.head = { rawHash: pending.after.rawHash, contentHash: pending.after.contentHash,
        writeId: pending.after.writeId, physical };
    const result = groupUpdateResult(pending);
    next.submissions[pending.operationKeyHash] = { accountId: state.accountId, dataEpoch: state.dataEpoch,
        intentHash: pending.intentHash, jobId: null, targetInstanceId: pending.instanceId, state: 'closed',
        reservedReceiptBytes: 0, outcome: result,
        effects: { [GROUP_EFFECT_KEY]: { effectHash: pending.intentHash, writeId: pending.id,
            instanceId: pending.instanceId, appliedRevision: pending.after.revision, result,
            cleanup: { payloads: { 'group.after.json': pending.after.rawHash }, journal: null } } } };
    next.pending = null;
    return next;
}

function groupUpdatePath(scope, locator) {
    return path.join(scope.directories.groups, locator.groupId + '.json');
}

function groupUpdatePayload(lease, pending) {
    const payload = readRoleplayPayload(lease, pending.id, pending.after.payload, pending.after.rawHash, CHAT_LIMIT);
    let group;
    try { group = JSON.parse(payload.bytes.toString('utf8')); } catch { throw conflict(); }
    assertRoleplayGroupData(group, pending.locator.groupId, { storage: true });
    if (roleplayGroupContentHash(group) !== pending.after.contentHash) throw conflict();
    return payload;
}

function applyPendingGroupUpdate(lease) {
    const { state, scope } = roleplayLease(lease);
    const pending = state.pending;
    if (pending?.kind !== 'group-update') throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'There is no matching group update.');
    const filename = groupUpdatePath(scope, pending.locator);
    let file = readRoleplayFile(filename, CHAT_LIMIT);
    if (pending.rawChanged) {
        const payload = groupUpdatePayload(lease, pending);
        file = withChatFileLocks([filename], () => publishThroughTemporary(lease, filename, payload.bytes,
            `${pending.id}-group`, pending.before, () => pending.appliedPhysical,
            physical => { pending.appliedPhysical = physical; }));
    } else {
        if (!sameObservation(file, pending.before)) throw conflict();
        file = readRoleplayFile(filename, CHAT_LIMIT, { flush: true });
    }
    if (!file || file.rawHash !== pending.after.rawHash) throw conflict();
    let saved;
    try { saved = JSON.parse(file.bytes.toString('utf8')); } catch { throw conflict(); }
    assertRoleplayGroupData(saved, pending.locator.groupId, { storage: true });
    if (roleplayGroupContentHash(saved) !== pending.after.contentHash) throw conflict();
    pending.phase = 'group-applied';
    pending.appliedPhysical = file.physical;
    saveRoleplayAccount(lease);
    const final = finishedGroupUpdate(state, pending, file.physical);
    Object.assign(state, final);
    saveRoleplayAccount(lease);
    cleanupRoleplayReceiptsLocked(lease, pending.operationKeyHash);
    return groupUpdateResult(pending);
}

export function commitSingleGroupUpdate(scope, input) {
    return withRoleplayAccountLock(scope, lease => commitSingleGroupUpdateLocked(lease, input));
}

export function commitSingleGroupUpdateLocked(lease, input) {
    confirmRoleplayAccount(lease);
    const { state, scope } = roleplayLease(lease);
    const groupId = normaliseRoleplayGroupId(String(input.group?.id));
    const group = assertRoleplayGroupData(JSON.parse(JSON.stringify(input.group)), groupId, { storage: true });
    const source = input.source && JSON.parse(JSON.stringify(input.source));
    const locator = { groupId };
    const operationKeyHash = groupUpdateKey(state, input.operationKey);
    const intentHash = roleplayHash({ accountId: state.accountId, dataEpoch: state.dataEpoch, locator,
        source, group });
    const prior = state.submissions[operationKeyHash];
    if (prior) {
        if (prior.intentHash !== intentHash || prior.dataEpoch !== state.dataEpoch) {
            throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'This group update identity was already used for different work.');
        }
        cleanupRoleplayReceiptsLocked(lease, operationKeyHash);
        return completedResult(prior);
    }
    if (state.pending) {
        if (state.pending.kind !== 'group-update' || state.pending.operationKeyHash !== operationKeyHash) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay operation must settle first.');
        }
        if (state.pending.intentHash !== intentHash) throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'The pending group update has different contents.');
        return applyPendingGroupUpdate(lease);
    }
    const saved = readRoleplayEntityLocked(lease, 'group', groupId, { storage: true });
    if (!source || saved.instanceId !== source.instanceId || saved.revision !== source.revision
        || saved.rawHash !== source.rawHash) throw conflict();
    for (const key of ['chat_metadata', 'past_metadata']) {
        if (Object.hasOwn(saved.data, key) && !isDeepStrictEqual(group[key], saved.data[key])) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'Legacy group metadata must stay with its chat migration.');
        }
    }
    const filename = groupUpdatePath(scope, locator);
    const beforeFile = readRoleplayFile(filename, CHAT_LIMIT);
    if (!beforeFile || beforeFile.rawHash !== saved.rawHash || !isDeepStrictEqual(beforeFile.physical, saved.physical)) throw conflict();
    rejectUndoJournal(filename);
    const bytes = isDeepStrictEqual(group, saved.data) ? beforeFile.bytes : Buffer.from(JSON.stringify(group, null, 4), 'utf8');
    if (bytes.length > CHAT_LIMIT) throw roleplayError('ROLEPLAY_STORE_FULL', 'The group metadata is too large.', 413);
    const rawHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const contentHash = roleplayGroupContentHash(group);
    const id = crypto.randomUUID();
    const before = { ...state.resources[saved.instanceId].head, revision: saved.revision };
    const changed = contentHash !== before.contentHash;
    const rawChanged = rawHash !== before.rawHash;
    if (!Number.isSafeInteger(before.revision + Number(changed))) {
        throw roleplayError('ROLEPLAY_STORE_FULL', 'The group revision cannot advance safely.', 413);
    }
    const pending = { schema: 1, kind: 'group-update', id, operationKeyHash, intentHash,
        accountId: state.accountId, dataEpoch: state.dataEpoch, locator, instanceId: saved.instanceId,
        source: { instanceId: saved.instanceId, revision: saved.revision, rawHash: saved.rawHash }, before,
        after: { revision: before.revision + Number(changed), rawHash, contentHash,
            writeId: rawChanged ? id : before.writeId, byteLength: bytes.length, payload: 'group.after.json' },
        changed, rawChanged, phase: 'prepared', appliedPhysical: null, reservedBytes: 8 * 1024 };
    assertRoleplayTransactionCapacity(lease, pending, finishedGroupUpdate(state, pending, ROLEPLAY_LARGEST_PHYSICAL));
    stageRoleplayPayload(lease, id, pending.after.payload, bytes, CHAT_LIMIT);
    state.pending = pending;
    try {
        saveRoleplayAccount(lease);
        return applyPendingGroupUpdate(lease);
    } catch (error) { throw Object.assign(error, { roleplayWritePending: true }); }
}

export function reconcileSingleGroupUpdate(scope, operationKey) {
    return withRoleplayAccountLock(scope, lease => {
        confirmRoleplayAccount(lease);
        const { state } = roleplayLease(lease);
        const operationKeyHash = groupUpdateKey(state, operationKey);
        const prior = state.submissions[operationKeyHash];
        if (prior) {
            cleanupRoleplayReceiptsLocked(lease, operationKeyHash);
            return completedResult(prior);
        }
        if (state.pending?.kind !== 'group-update' || state.pending.operationKeyHash !== operationKeyHash) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'There is no matching group update.');
        }
        return applyPendingGroupUpdate(lease);
    });
}

function importRequestHash(scope, input) {
    if (typeof input.operationKey !== 'string' || !input.operationKey || input.operationKey.length > 256
        || !Buffer.isBuffer(input.bytes) || input.bytes.length > CHAT_LIMIT || !['json', 'jsonl', 'instance-batch'].includes(input.format)
        || (input.importAsNewInstance !== undefined && typeof input.importAsNewInstance !== 'boolean')
        || (input.format === 'instance-batch' && input.importAsNewInstance !== true)
        || typeof input.originalName !== 'string' || !input.originalName || input.originalName.length > 2048
        || typeof input.userName !== 'string' || typeof input.characterName !== 'string') {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid uploaded chat file or parser options.', 400);
    }
    const target = input.target;
    if (!target || typeof target.group !== 'boolean' || (target.group && input.importAsNewInstance)
        || (target.group ? typeof target.groupId !== 'string' || !target.groupId || !target.source
            : !validRoleplayAvatar(target.avatar))) throw roleplayError('ROLEPLAY_INVALID', 'Invalid chat import target.', 400);
    return roleplayHash({ accountId: scope.accountId, dataEpoch: scope.dataEpoch, target,
        ...(input.importAsNewInstance ? { importAsNewInstance: true } : {}),
        originalName: input.originalName, format: input.format, userName: input.userName, characterName: input.characterName,
        bytes: crypto.createHash('sha256').update(input.bytes).digest('hex'), byteLength: input.bytes.length });
}

function assertImportedOrigin(lease, records) {
    const metadata = records[0].chat_metadata;
    if (!Object.hasOwn(metadata, 'neconyan_roleplay')) return;
    const marker = metadata.neconyan_roleplay;
    const { state } = roleplayLease(lease);
    const resource = marker && state.resources[marker.instanceId];
    if (!resource || resource.kind !== 'chat'
        || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch) {
        throw roleplayError('ROLEPLAY_FOREIGN_SOURCE', 'This chat belongs to another instance. Select Import as new instance to adopt a separate copy.');
    }
    const originChanged = () => roleplayError('ROLEPLAY_IMPORT_ORIGIN_CHANGED',
        'This chat no longer matches its recorded local origin. Select Import as new instance to adopt a separate copy.');
    if (resource.status !== 'live') throw originChanged();
    const saved = readRoleplayChatLocked(lease, resource.locator);
    if (!isDeepStrictEqual(marker, { schema: 1, instanceId: marker.instanceId, revision: resource.revision, writeId: resource.head.writeId })
        || metadata.integrity !== saved.records[0].chat_metadata.integrity
        || roleplayContentHash(records) !== resource.head.contentHash) throw originChanged();
}

function newImportCharacter(lease, character, timestamp) {
    const { scope, state } = roleplayLease(lease);
    // A random owner, not a display name, separates both current and orphaned histories.
    const instanceId = crypto.randomUUID();
    const avatar = `Imported-${instanceId}.png`;
    const locator = { avatar };
    if (state.paths[roleplayPathKey(state, 'character', locator)]
        || Object.values(state.resources).some(resource => resource.locator.avatar === avatar)
        || fs.existsSync(path.join(scope.directories.characters, avatar))
        || fs.existsSync(path.join(scope.directories.chats, roleplayAvatarOwner(avatar)))) throw conflict();
    const { data } = roleplayEntityContent('character', avatar, character.bytes, { storage: true });
    data.create_date = humanizedDateTime(timestamp);
    return { locator, instanceId, expectedVacancy: 0, physical: null, data };
}

function importedChatName(scope, targetValue, characterName, timestamp, reserved, state) {
    const base = targetValue.group ? humanizedDateTime(timestamp)
        : `${sanitize(characterName) || 'Character'} - ${humanizedDateTime(timestamp)} imported`;
    for (let attempt = 0; attempt < 1000; attempt++) {
        const suffix = attempt ? ` (${attempt + 1})` : '';
        let stem = '';
        for (const char of sanitize(base)) {
            if (Buffer.byteLength(stem + char + suffix + '.jsonl') > 255) break;
            stem += char;
        }
        const name = stem + suffix;
        const locator = normaliseRoleplayLocator(targetValue.group ? { group: true, chat: name }
            : { group: false, avatar: targetValue.avatar, chat: name });
        const filename = roleplayChatPath(scope, locator);
        if (!reserved.has(name) && !state.paths[roleplayPathKey(state, 'chat', locator)]
            && !readRoleplayFile(filename, CHAT_LIMIT, { allowMissingParent: true })) {
            reserved.add(name);
            return { locator, filename, expectedVacancy: 0 };
        }
    }
    throw roleplayError('ROLEPLAY_STORE_FULL', 'No safe imported chat name is available.', 413);
}

function legacyGroupMembers(scope, members) {
    const byName = new Map();
    for (const avatar of fs.readdirSync(scope.directories.characters).filter(name => validRoleplayAvatar(name))) {
        const file = readRoleplayFile(path.join(scope.directories.characters, avatar), CHAT_LIMIT);
        if (!file) continue;
        try {
            const card = JSON.parse(readCharacterCard(file.bytes));
            const name = card.data?.name ?? card.name;
            if (typeof name === 'string' && !byName.has(name)) byName.set(name, avatar);
        } catch { /* A damaged unrelated card cannot name a group member. */ }
    }
    return members.map(name => byName.get(name) ?? (validRoleplayAvatar(name) ? name : null)).filter(Boolean);
}

function prepareImportGroupLink(lease, saved, names, transactionId) {
    const { scope, state } = roleplayLease(lease);
    const group = JSON.parse(JSON.stringify(saved.data));
    if (group.chat_id === undefined) {
        group.members = legacyGroupMembers(scope, group.members);
        group.chat_id = String(group.id);
        group.chats = [String(group.id)];
    }
    group.chats = [...new Set([...(Array.isArray(group.chats) ? group.chats.map(String) : []), ...names])];
    const bytes = Buffer.from(JSON.stringify(group, null, 4));
    if (bytes.length > CHAT_LIMIT) throw roleplayError('ROLEPLAY_STORE_FULL', 'Linked group metadata exceeds its storage limit.', 413);
    const before = { ...state.resources[saved.instanceId].head, revision: saved.revision };
    return { locator: { groupId: String(group.id) }, instanceId: saved.instanceId, before,
        after: { revision: before.revision + 1, rawHash: crypto.createHash('sha256').update(bytes).digest('hex'),
            contentHash: roleplayGroupContentHash(group), writeId: transactionId, byteLength: bytes.length, payload: 'import.group.after.json' },
        appliedPhysical: null, bytes };
}

function finishedImportState(state, pending, physical = null) {
    const next = JSON.parse(JSON.stringify(state));
    const payloads = {};
    if (pending.newCharacter) {
        const card = pending.newCharacter;
        next.resources[card.instanceId] = { accountId: state.accountId, dataEpoch: state.dataEpoch,
            kind: 'character', locator: card.locator, status: 'live', revision: 1, busySubmission: null,
            head: { rawHash: card.after.rawHash, contentHash: card.after.contentHash, writeId: null,
                physical: physical ?? card.physical } };
        next.paths[roleplayPathKey(state, 'character', card.locator)] = { generation: 1, instanceId: card.instanceId };
        payloads[card.after.payload] = card.after.rawHash;
    }
    for (const [index, output] of pending.outputs.entries()) {
        const currentPhysical = physical ?? output.physical;
        next.resources[output.instanceId] = { accountId: state.accountId, dataEpoch: state.dataEpoch,
            kind: 'chat', locator: output.locator, status: 'live', revision: 1, busySubmission: null,
            head: { rawHash: output.after.rawHash, contentHash: output.after.contentHash,
                writeId: output.after.writeId, physical: currentPhysical } };
        next.paths[roleplayPathKey(state, 'chat', output.locator)] = { generation: output.expectedVacancy + 1, instanceId: output.instanceId };
        payloads[output.after.payload] = output.after.rawHash;
        for (const item of output.memoryPayloads) payloads[`import.memory.${index}.${item.kind}.json`] = item.hash;
    }
    if (pending.group) {
        const group = next.resources[pending.group.instanceId];
        group.revision = pending.group.after.revision;
        group.head = { rawHash: pending.group.after.rawHash, contentHash: pending.group.after.contentHash,
            writeId: pending.group.after.writeId, physical: physical ?? pending.group.appliedPhysical };
        payloads[pending.group.after.payload] = pending.group.after.rawHash;
    }
    const first = pending.outputs[0];
    const result = { kind: 'import', mode: 'create', instanceId: first.instanceId, revision: 1,
        ...(pending.newCharacter ? { character: { avatar: pending.newCharacter.locator.avatar, instanceId: pending.newCharacter.instanceId } } : {}),
        rawHash: first.after.rawHash, integrity: first.after.integrity, writeId: pending.id, changed: true,
        names: pending.outputs.map(output => output.locator.chat),
        outputs: pending.outputs.map(output => ({ name: output.locator.chat, instanceId: output.instanceId,
            rawHash: output.after.rawHash, writeId: output.after.writeId })),
        group: pending.group ? { id: pending.group.locator.groupId, source: {
            instanceId: pending.group.instanceId, revision: pending.group.after.revision,
            rawHash: pending.group.after.rawHash }, rawHash: pending.group.after.rawHash } : null };
    next.submissions[pending.operationKeyHash] = { accountId: state.accountId, dataEpoch: state.dataEpoch,
        intentHash: pending.planHash, requestHash: pending.requestHash, jobId: null,
        targetInstanceId: first.instanceId, state: 'closed', reservedReceiptBytes: 0, outcome: result,
        effects: { [IMPORT_EFFECT_KEY]: { effectHash: pending.planHash, writeId: pending.id,
            instanceId: first.instanceId, appliedRevision: 1, result,
            cleanup: { payloads, journal: null } } } };
    next.pending = null;
    return next;
}

function prepareChatImport(lease, input, host, convert, requestHash, operationKeyHash) {
    const { scope, state } = roleplayLease(lease);
    const targetValue = input.target;
    let group = null;
    let character = null;
    if (targetValue.group) {
        const saved = readRoleplayEntityLocked(lease, 'group', targetValue.groupId, { storage: true });
        if (saved.instanceId !== targetValue.source?.instanceId || saved.revision !== targetValue.source?.revision
            || saved.rawHash !== targetValue.source?.rawHash) throw conflict();
        group = saved;
    } else {
        const filename = path.join(scope.directories.characters, targetValue.avatar);
        character = readRoleplayFile(filename, CHAT_LIMIT);
        if (!character) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The character owning this imported chat is missing.', 404);
    }
    const timestamp = Date.now();
    const newCharacter = input.importAsNewInstance ? newImportCharacter(lease, character, timestamp) : null;
    const destinationTarget = newCharacter ? { group: false, avatar: newCharacter.locator.avatar } : targetValue;
    const converted = convert(input.bytes, { format: input.format, userName: input.userName,
        characterName: input.characterName, timestamp });
    if (!Array.isArray(converted) || converted.length < 1 || converted.length > ROLEPLAY_IMPORT_MAX_OUTPUTS) {
        throw roleplayError('ROLEPLAY_INVALID', 'The uploaded file has an unsupported number of histories.', 400);
    }
    const reserved = new Set(group?.data.chats?.map(String) ?? []);
    const id = crypto.randomUUID();
    const staged = [];
    const outputs = converted.map((chat, index) => {
        if (typeof chat !== 'string') throw roleplayError('ROLEPLAY_INVALID', 'A converted history is invalid.', 400);
        const parsed = parseChatJsonl(chat);
        if (parsed.status !== 'ok') throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'The uploaded history is malformed.', 422);
        if (newCharacter) {
            // Imported messages survive; links to source histories and inherited memory do not.
            delete parsed.records[0].chat_metadata.main_chat;
            delete parsed.records[0].chat_metadata.chat_id_hash;
            for (const message of parsed.records.slice(1)) {
                const extras = [message.extra, ...(Array.isArray(message.swipe_info) ? message.swipe_info.map(swipe => swipe?.extra) : [])];
                for (const extra of extras) {
                    if (extra && typeof extra === 'object') { delete extra.bookmark_link; delete extra.branches; }
                }
            }
        } else assertImportedOrigin(lease, parsed.records);
        const destination = importedChatName(scope, destinationTarget, input.characterName, timestamp, reserved, state);
        const instanceId = crypto.randomUUID();
        const writeId = crypto.randomUUID();
        const prepared = host.prepare(parsed.records, { marker: { schema: 1, instanceId, revision: 1, writeId } });
        const bytes = Buffer.from(prepared.serialized, 'utf8');
        if (bytes.length > CHAT_LIMIT) throw roleplayError('ROLEPLAY_STORE_FULL', 'An imported history is too large.', 413);
        const memory = prepareBranchMemoryCapture(scope.directories, destination.locator,
            { metadata: prepared.records[0].chat_metadata, messages: prepared.records.slice(1) }, { mode: 'create' });
        const memoryPayloads = memory.payloads.map(payload => ({ kind: payload.name === 'memory.archive.json' ? 'archive' : 'guard',
            hash: crypto.createHash('sha256').update(payload.bytes).digest('hex'), bytes: payload.bytes.length }));
        staged.push({ name: `import.chat.${index}.jsonl`, bytes });
        for (const payload of memory.payloads) staged.push({ name: `import.memory.${index}.${payload.name.slice(7)}`, bytes: payload.bytes });
        return { locator: destination.locator, instanceId, expectedVacancy: destination.expectedVacancy,
            after: { revision: 1, rawHash: crypto.createHash('sha256').update(bytes).digest('hex'),
                contentHash: roleplayContentHash(prepared.records), integrity: prepared.integrity,
                writeId, byteLength: bytes.length, payload: `import.chat.${index}.jsonl` },
            physical: null, memory: memory.plan, memoryPayloads, memoryDone: false };
    });
    const linked = group && prepareImportGroupLink(lease, group, outputs.map(output => output.locator.chat), id);
    if (linked) staged.push({ name: linked.after.payload, bytes: linked.bytes });
    if (newCharacter) {
        newCharacter.data.chat = outputs[0].locator.chat;
        const bytes = writeCharacterCard(character.bytes, JSON.stringify(newCharacter.data));
        const { contentHash } = roleplayEntityContent('character', newCharacter.locator.avatar, bytes, { storage: true });
        newCharacter.after = { revision: 1, rawHash: crypto.createHash('sha256').update(bytes).digest('hex'), contentHash,
            byteLength: bytes.length, payload: 'import.character.png' };
        delete newCharacter.data;
        staged.push({ name: newCharacter.after.payload, bytes });
    }
    const pending = { schema: 1, kind: 'chat-import', id, operationKeyHash, requestHash, planHash: '',
        accountId: state.accountId, dataEpoch: state.dataEpoch,
        target: targetValue.group ? { group: true, groupId: targetValue.groupId }
            : { group: false, avatar: targetValue.avatar, character: { rawHash: character.rawHash, physical: character.physical } },
        ...(newCharacter ? { newCharacter } : {}),
        timestamp, outputs, group: linked && { locator: linked.locator, instanceId: linked.instanceId,
            before: linked.before, after: linked.after, appliedPhysical: null },
        phase: 'prepared', reservedBytes: 32 * 1024 };
    pending.planHash = roleplayHash(roleplayImportPlan(pending));
    assertRoleplayTransactionCapacity(lease, pending, finishedImportState(state, pending, ROLEPLAY_LARGEST_PHYSICAL));
    for (const payload of staged) stageRoleplayPayload(lease, id, payload.name, payload.bytes,
        payload.name.includes('.memory.') ? MAX_ARCHIVE_BYTES : CHAT_LIMIT);
    state.pending = pending;
    try {
        saveRoleplayAccount(lease);
        return applyPendingChatImport(lease, host);
    } catch (error) { throw Object.assign(error, { roleplayWritePending: true }); }
}

function assertImportTarget(lease, pending) {
    const { scope } = roleplayLease(lease);
    if (!pending.target.group) {
        const character = readRoleplayFile(path.join(scope.directories.characters, pending.target.avatar), CHAT_LIMIT);
        if (!sameObservation(character, pending.target.character)) throw conflict();
        return;
    }
    const groupFile = readRoleplayFile(groupUpdatePath(scope, pending.group.locator), CHAT_LIMIT);
    if (!sameObservation(groupFile, pending.group.before)
        && !sameObservation(groupFile, { rawHash: pending.group.after.rawHash, physical: pending.group.appliedPhysical })) throw conflict();
}

function importedOutputFile(lease, output) {
    const file = readRoleplayFile(roleplayChatPath(roleplayLease(lease).scope, output.locator), CHAT_LIMIT, { allowMissingParent: true });
    if (!file || file.rawHash !== output.after.rawHash || (output.physical && !isDeepStrictEqual(file.physical, output.physical))) throw conflict();
    const parsed = parseChatJsonl(file.bytes);
    if (parsed.status !== 'ok' || roleplayContentHash(parsed.records) !== output.after.contentHash
        || !isDeepStrictEqual(parsed.records[0].chat_metadata.neconyan_roleplay,
            { schema: 1, instanceId: output.instanceId, revision: 1, writeId: output.after.writeId })) throw conflict();
    return file;
}

function applyPendingChatImport(lease, host) {
    const { scope, state } = roleplayLease(lease);
    const pending = state.pending;
    if (pending?.kind !== 'chat-import') throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'There is no matching chat import.');
    assertImportTarget(lease, pending);
    for (const [index, output] of pending.outputs.entries()) {
        assertImportTarget(lease, pending);
        for (const prior of pending.outputs.slice(0, index)) {
            if (prior.physical) importedOutputFile(lease, prior);
        }
        const filename = roleplayChatPath(scope, output.locator);
        let file = readRoleplayFile(filename, CHAT_LIMIT, { allowMissingParent: true });
        if (!file) {
            if (output.physical) throw conflict();
            const payload = readRoleplayPayload(lease, pending.id, output.after.payload, output.after.rawHash, CHAT_LIMIT);
            const parsed = parseChatJsonl(payload.bytes);
            if (parsed.status !== 'ok' || roleplayContentHash(parsed.records) !== output.after.contentHash) throw conflict();
            const inputRecords = structuredClone(parsed.records);
            delete inputRecords[0].chat_metadata.neconyan_roleplay;
            delete inputRecords[0].chat_metadata.integrity;
            createRoleplayDirectory(path.dirname(filename), scope.directories.root);
            file = host.publish({ filePath: filename, before: null, payloadPath: payload.filename,
                payloadHash: output.after.rawHash,
                prepared: { changed: true, inputRecords, records: parsed.records,
                    serialized: payload.bytes.toString('utf8'), integrity: output.after.integrity },
                handle: scope.owner, cardName: output.locator.group ? output.locator.chat : roleplayAvatarOwner(output.locator.avatar),
                backupDirectory: scope.directories.backups, recoveryTarget: target(scope, output.locator), deferBackup: true }).file;
        }
        file = importedOutputFile(lease, output);
        if (!output.physical) {
            output.physical = file.physical;
            pending.phase = 'publishing';
            saveRoleplayAccount(lease);
        }
        applyPreparedBranchMemoryCapture(scope.directories, output.locator, output.memory, {
            mode: 'create', chat: { rawHash: file.rawHash, physical: file.physical },
            payload: (name, hash) => readRoleplayPayload(lease, pending.id,
                `import.memory.${index}.${name.slice(7)}`, hash, MAX_ARCHIVE_BYTES).bytes,
        });
        if (!output.memoryDone) {
            output.memoryDone = true;
            saveRoleplayAccount(lease);
        }
    }
    for (const output of pending.outputs) importedOutputFile(lease, output);
    assertImportTarget(lease, pending);
    if (pending.newCharacter) {
        const card = pending.newCharacter;
        const filename = path.join(scope.directories.characters, card.locator.avatar);
        const { bytes } = readRoleplayPayload(lease, pending.id, card.after.payload, card.after.rawHash, CHAT_LIMIT);
        withChatFileLocks([filename], () => publishThroughTemporary(lease, filename, bytes,
            `${pending.id}-import-character`, null, () => card.physical, physical => { card.physical = physical; }));
    }
    pending.phase = 'linking';
    saveRoleplayAccount(lease);
    if (pending.group) {
        assertImportTarget(lease, pending);
        const group = pending.group;
        const filename = groupUpdatePath(scope, group.locator);
        let file = readRoleplayFile(filename, CHAT_LIMIT);
        const payload = readRoleplayPayload(lease, pending.id, group.after.payload, group.after.rawHash, CHAT_LIMIT);
        file = withChatFileLocks([filename], () => publishThroughTemporary(lease, filename, payload.bytes,
            `${pending.id}-import-group`, group.before, () => group.appliedPhysical,
            physical => { group.appliedPhysical = physical; }));
        if (!sameObservation(file, { rawHash: group.after.rawHash, physical: group.appliedPhysical })) throw conflict();
        if (pending.phase !== 'linked') {
            pending.phase = 'linked';
            saveRoleplayAccount(lease);
        }
    } else {
        pending.phase = 'linked';
        saveRoleplayAccount(lease);
    }
    const final = finishedImportState(state, pending);
    Object.assign(state, final);
    saveRoleplayAccount(lease);
    cleanupRoleplayReceiptsLocked(lease, pending.operationKeyHash);
    return final.submissions[pending.operationKeyHash].outcome;
}

export function commitSingleChatImport(scope, input, host, convert) {
    return withRoleplayAccountLock(scope, lease => {
        confirmRoleplayAccount(lease);
        const { state, scope: current } = roleplayLease(lease);
        const requestHash = importRequestHash(current, input);
        const operationKeyHash = roleplayHash([state.accountId, 'chat-import', input.operationKey]);
        const prior = state.submissions[operationKeyHash];
        if (prior) {
            if (prior.requestHash !== requestHash) throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'This import key was used for another file or target.');
            cleanupRoleplayReceiptsLocked(lease, operationKeyHash);
            return completedResult(prior);
        }
        if (state.pending) {
            if (state.pending.kind !== 'chat-import' || state.pending.operationKeyHash !== operationKeyHash) {
                throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'Another Roleplay operation must settle first.');
            }
            if (state.pending.requestHash !== requestHash) throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'The pending import has another request.');
            return applyPendingChatImport(lease, host);
        }
        try {
            return prepareChatImport(lease, input, host, convert, requestHash, operationKeyHash);
        } catch (error) {
            if (!error.roleplayWritePending && state.pending === null) error.roleplayImportUnaccepted = true;
            throw error;
        }
    });
}

/** Private storage transaction; the concrete endpoint host supplies the existing writer, never a client callback. */
export function commitSingleChatWrite(scope, input, host) {
    return withRoleplayAccountLock(scope, lease => commitSingleChatWriteLocked(lease, input, host));
}

function writeIntent(state, input) {
    const mode = input.mode;
    if (!['update', 'create'].includes(mode) || (input.sourceKind !== undefined && input.sourceKind !== 'storage')
        || (mode === 'update' && input.sourceKind !== input.source?.kind)
        || (input.sourceKind === 'storage' && input.groupId !== undefined)
        || (input.force !== undefined && typeof input.force !== 'boolean')) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid chat write intent.', 400);
    }
    const locator = normaliseRoleplayLocator(mode === 'update' ? input.source?.locator : input.destination);
    const backup = { deferBackup: input.backup?.deferBackup === true };
    if (input.backup?.deferSequenceId !== undefined) backup.deferSequenceId = input.backup.deferSequenceId;
    // Keep existing untagged, unforced intent hashes valid across this additive storage cutover.
    const intentHash = roleplayHash({ accountId: state.accountId, dataEpoch: state.dataEpoch, mode, locator,
        source: input.source ?? null, groupId: input.groupId ?? null, expectedVacancy: input.expectedVacancy ?? null,
        records: input.records, allowShrink: input.allowShrink === true, backup,
        ...(input.sourceKind === 'storage' ? { sourceKind: 'storage' } : {}), ...(input.force === true ? { force: true } : {}) });
    return { operationKeyHash: key(state, input.operationKey), intentHash, mode, locator, backup };
}

function prepareAndApplyChatWrite(lease, input, host, intent, { source, before, beforeBytes, instanceId, expectedVacancy = null }) {
    const { state, scope } = roleplayLease(lease);
    const { operationKeyHash, intentHash, mode, locator, backup } = intent;
    let revision = before ? before.revision + 1 : 1;
    if (!Number.isSafeInteger(revision)) throw roleplayError('ROLEPLAY_STORE_FULL', 'The chat revision cannot advance safely.');
    rejectUndoJournal(roleplayChatPath(scope, locator));
    const id = crypto.randomUUID();
    const prepared = host.prepare(input.records, { beforeBytes, marker: { schema: 1, instanceId, revision, writeId: id },
        force: input.force === true, allowShrink: input.allowShrink === true });
    if (!prepared.changed) revision = before.revision;
    const bytes = Buffer.from(prepared.serialized, 'utf8');
    const memory = prepareBranchMemoryCapture(scope.directories, locator, {
        metadata: prepared.records[0].chat_metadata, messages: prepared.records.slice(1),
    }, { mode });
    const pending = { schema: 1, kind: 'chat-write', id, operationKeyHash, intentHash, accountId: state.accountId,
        dataEpoch: state.dataEpoch, mode, locator, instanceId, source, expectedVacancy, before,
        after: { revision, rawHash: crypto.createHash('sha256').update(bytes).digest('hex'), contentHash: roleplayContentHash(prepared.records),
            integrity: prepared.integrity, writeId: prepared.changed ? id : before.writeId, byteLength: bytes.length, payload: 'chat.after.jsonl' },
        changed: prepared.changed, phase: 'prepared', appliedPhysical: null, memory: memory.plan, repair: null, journal: null,
        backup, allowShrink: input.allowShrink === true, reservedBytes: 16 * 1024, ...(input.force === true ? { force: true } : {}) };
    assertRoleplayTransactionCapacity(lease, pending, finishedState(state, { ...pending, journal: largestRoleplayJournal(pending) }, ROLEPLAY_LARGEST_PHYSICAL));
    stageRoleplayPayload(lease, id, pending.after.payload, bytes, CHAT_LIMIT);
    for (const payload of memory.payloads) stageRoleplayPayload(lease, id, payload.name, payload.bytes, MAX_ARCHIVE_BYTES);
    state.pending = pending;
    try {
        saveRoleplayAccount(lease);
        return applyPending(lease, host);
    } catch (error) { throw Object.assign(error, { roleplayWritePending: true }); }
}

/** Reuse an already held account lock; the lease is still checked and confirmed before admission. */
export function commitSingleChatWriteLocked(lease, input, host) {
    if (typeof host?.prepare !== 'function' || typeof host?.publish !== 'function') throw new TypeError('The native chat writer host is required.');
    confirmRoleplayAccount(lease);
    const { state, scope } = roleplayLease(lease);
    const intent = writeIntent(state, input);
    const { operationKeyHash, intentHash, mode, locator } = intent;
    const prior = state.submissions[operationKeyHash];
    if (prior) {
        if (prior.intentHash !== intentHash || prior.dataEpoch !== state.dataEpoch) throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'This chat write identity was already used for different work.');
        cleanupRoleplayReceiptsLocked(lease, operationKeyHash);
        return completedResult(prior);
    }
    if (state.pending) {
        if (state.pending.kind !== 'chat-write' || state.pending.operationKeyHash !== operationKeyHash) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay operation must settle first.');
        }
        if (state.pending.intentHash !== intentHash) throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'The pending chat write has a different intent.');
        return applyPending(lease, host);
    }
    let source, before = null, instanceId, expectedVacancy = null;
    const filename = roleplayChatPath(scope, locator);
    if (mode === 'update') {
        const saved = assertRoleplaySourceLocked(lease, input.source);
        source = structuredClone(input.source);
        instanceId = saved.instanceId;
        const resource = state.resources[instanceId];
        before = { ...resource.head, revision: resource.revision, integrity: saved.records[0].chat_metadata.integrity ?? '' };
    } else {
        const vacancy = state.paths[roleplayPathKey(state, 'chat', locator)];
        const occupied = readRoleplayFile(filename, CHAT_LIMIT, { allowMissingParent: true });
        if (vacancy?.instanceId || input.expectedVacancy !== (vacancy?.generation ?? 0) || occupied) {
            throw Object.assign(conflict(), { current: vacancy?.instanceId || occupied ? null : { vacancy: vacancy?.generation ?? 0 } });
        }
        expectedVacancy = input.expectedVacancy;
        source = { accountId: state.accountId, dataEpoch: state.dataEpoch, locator, dependencies: [] };
        if (input.sourceKind === 'storage') source.kind = 'storage';
        else {
            const captured = captureRoleplayDependenciesLocked(lease, locator, input.groupId);
            source.dependencies = captured.dependencies.map(({ kind, instanceId, revision, contentHash, locator }) => ({ kind, instanceId, revision, contentHash, locator }));
            if (locator.group) source.groupId = input.groupId;
        }
        instanceId = crypto.randomUUID();
    }
    const beforeFile = before ? readRoleplayFile(filename, CHAT_LIMIT) : null;
    if (before && !sameObservation(beforeFile, before)) throw conflict();
    return prepareAndApplyChatWrite(lease, input, host, intent, { source, before, beforeBytes: beforeFile?.bytes ?? null, instanceId, expectedVacancy });
}

/** Repair only the exact recorded head at its existing physical identity, never a changed or deleted chat. */
export function repairSingleChatWriteLocked(lease, { locator: inputLocator, snapshotBytes }, host) {
    if (typeof host?.prepare !== 'function' || typeof host?.publish !== 'function') throw new TypeError('The native chat writer host is required.');
    confirmRoleplayAccount(lease);
    const { state, scope } = roleplayLease(lease);
    if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier chat write must settle first.');
    const locator = normaliseRoleplayLocator(inputLocator);
    const instanceId = state.paths[roleplayPathKey(state, 'chat', locator)]?.instanceId;
    const resource = state.resources[instanceId];
    if (!resource || resource.kind !== 'chat' || resource.status !== 'live' || resource.accountId !== state.accountId
        || resource.dataEpoch !== state.dataEpoch || !Buffer.isBuffer(snapshotBytes) || snapshotBytes.length > CHAT_LIMIT) throw conflict();
    const damaged = readRoleplayFile(roleplayChatPath(scope, locator), CHAT_LIMIT);
    const snapshot = parseChatJsonl(snapshotBytes);
    if (!damaged || !isDeepStrictEqual(damaged.physical, resource.head.physical) || parseChatJsonl(damaged.bytes).status === 'ok'
        || snapshot.status !== 'ok' || crypto.createHash('sha256').update(snapshotBytes).digest('hex') !== resource.head.rawHash
        || roleplayContentHash(snapshot.records) !== resource.head.contentHash) throw conflict();
    const source = { kind: 'storage', accountId: state.accountId, dataEpoch: state.dataEpoch, instanceId,
        revision: resource.revision, rawHash: resource.head.rawHash, locator, dependencies: [] };
    // Physical identity distinguishes a fresh corruption from an earlier repair at the same logical revision.
    const operationKey = 'chat-repair:' + roleplayHash([source, damaged.rawHash, damaged.physical]);
    const input = { operationKey, mode: 'update', sourceKind: 'storage', source, records: snapshot.records, backup: { deferBackup: true } };
    const intent = writeIntent(state, input);
    if (state.submissions[intent.operationKeyHash]) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'This corruption already has recorded repair evidence.');
    const before = { ...resource.head, revision: resource.revision, integrity: snapshot.records[0].chat_metadata.integrity ?? '' };
    return prepareAndApplyChatWrite(lease, input, host, intent, { source, before, beforeBytes: snapshotBytes, instanceId });
}

const LIFECYCLE_EFFECT_KEY = roleplayHash('lifecycle');

export function roleplayEntityPath(scope, kind, locator) {
    if (kind === 'chat') return roleplayChatPath(scope, locator);
    return kind === 'character' ? path.join(scope.directories.characters, locator.avatar)
        : path.join(scope.directories.groups, locator.groupId + '.json');
}

function lifecycleLocator(kind, locator) {
    if (kind === 'chat') return normaliseRoleplayLocator(locator);
    if (kind === 'group') return { groupId: normaliseRoleplayGroupId(locator?.groupId) };
    if (kind === 'character' && validRoleplayAvatar(locator?.avatar)) return { avatar: locator.avatar };
    throw roleplayError('ROLEPLAY_INVALID', 'Invalid Roleplay lifecycle target.', 400);
}

/** The live instance at a protected path, or null when the path has never been recorded as live. */
export function roleplayTrackedInstance(lease, kind, locator) {
    const { state } = roleplayLease(lease);
    return state.paths[roleplayPathKey(state, kind, lifecycleLocator(kind, locator))]?.instanceId ?? null;
}

function lifecycleRecoveryTarget(scope, locator, host) {
    return host.recoveryTarget?.(locator) ?? target(scope, locator);
}

function lifecycleEntityId(kind, locator) {
    return kind === 'character' ? locator.avatar : kind === 'group' ? locator.groupId : locator.chat;
}

function planLifecycleStep(lease, input, index) {
    const { state, scope } = roleplayLease(lease);
    if (!input || !['delete', 'move', 'discard', 'create', 'update'].includes(input.op)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid Roleplay lifecycle step.', 400);
    }
    const locator = lifecycleLocator(input.kind, input.locator);
    const filename = roleplayEntityPath(scope, input.kind, locator);
    const slot = state.paths[roleplayPathKey(state, input.kind, locator)];
    const file = readRoleplayFile(filename, CHAT_LIMIT, { allowMissingParent: true });
    if (input.op === 'discard' || input.op === 'create') {
        if (slot?.instanceId) throw roleplayError('ROLEPLAY_TARGET_EXISTS', 'That protected name is already in use.');
        rejectUndoJournal(filename);
    }
    if (input.op === 'discard') {
        // Ordinary-storage files that were never recorded: retire exactly the observed bytes, or nothing.
        if (!file) return null;
        if (Object.values(state.resources).some(resource => isDeepStrictEqual(resource.head.physical, file.physical))) throw conflict();
        return { op: 'discard', kind: input.kind, locator, before: { rawHash: file.rawHash, physical: file.physical } };
    }
    const after = bytes => {
        if (input.kind === 'chat' || !Buffer.isBuffer(bytes) || bytes.length > CHAT_LIMIT) {
            throw roleplayError('ROLEPLAY_INVALID', 'Invalid Roleplay lifecycle contents.', 400);
        }
        const { contentHash } = roleplayEntityContent(input.kind, lifecycleEntityId(input.kind, locator), bytes, { storage: true });
        return { rawHash: crypto.createHash('sha256').update(bytes).digest('hex'), contentHash, byteLength: bytes.length,
            payload: `lifecycle.${index}.bin` };
    };
    if (input.op === 'create') {
        if (file) throw roleplayError('ROLEPLAY_TARGET_EXISTS', 'That name is already in use.');
        return { op: 'create', kind: input.kind, locator, instanceId: crypto.randomUUID(), expectedVacancy: slot?.generation ?? 0,
            after: { revision: 1, ...after(input.bytes) }, physical: null };
    }
    const instanceId = slot?.instanceId;
    const resource = instanceId && state.resources[instanceId];
    if (!resource || resource.status !== 'live' || resource.kind !== input.kind) {
        throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The protected file is not live.', 404);
    }
    if (resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch || resource.busySubmission) {
        throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The protected file has unsettled work.');
    }
    const before = { revision: resource.revision, ...resource.head };
    // A tracked file removed outside the lock may still be retired; any other difference is retained.
    if ((file || input.op !== 'delete') && !sameObservation(file, before)) {
        throw file ? conflict() : roleplayError('ROLEPLAY_SOURCE_MISSING', 'The protected file is missing.', 404);
    }
    rejectUndoJournal(filename);
    const step = { op: input.op, kind: input.kind, locator, instanceId, before };
    if (input.op === 'update') return { ...step, after: { revision: before.revision + 1, ...after(input.bytes) }, physical: null };
    if (input.op === 'move') {
        const destination = lifecycleLocator(input.kind, input.destination);
        const destinationSlot = state.paths[roleplayPathKey(state, input.kind, destination)];
        const destinationFile = roleplayEntityPath(scope, input.kind, destination);
        if (destinationSlot?.instanceId || fs.existsSync(destinationFile)) {
            throw roleplayError('ROLEPLAY_TARGET_EXISTS', 'The destination name is already in use.');
        }
        rejectUndoJournal(destinationFile);
        Object.assign(step, { destination, destinationVacancy: destinationSlot?.generation ?? 0 });
    }
    return step;
}

function lifecycleResult(pending) {
    const primary = pending.steps.find(step => step.op !== 'discard');
    const head = primary.after ?? primary.before;
    return { kind: 'lifecycle', mode: 'lifecycle', action: pending.action, instanceId: primary.instanceId,
        revision: head.revision, rawHash: head.rawHash, integrity: '', writeId: pending.id, changed: true };
}

function finishedLifecycle(state, pending) {
    const next = JSON.parse(JSON.stringify(state));
    const payloads = {};
    for (const step of pending.steps) {
        const key = roleplayPathKey(state, step.kind, step.locator);
        if (step.op === 'discard') continue;
        if (step.after) payloads[step.after.payload] = step.after.rawHash;
        if (step.op === 'create' || step.op === 'update') {
            const physical = step.physical ?? ROLEPLAY_LARGEST_PHYSICAL;
            const head = { rawHash: step.after.rawHash, contentHash: step.after.contentHash, physical, writeId: null };
            next.resources[step.instanceId] = step.op === 'create'
                ? { accountId: state.accountId, dataEpoch: state.dataEpoch, kind: step.kind, locator: step.locator, status: 'live',
                    revision: 1, head, busySubmission: null }
                : { ...next.resources[step.instanceId], revision: step.after.revision, head };
            next.paths[key] = { generation: step.op === 'create' ? step.expectedVacancy + 1 : next.paths[key].generation, instanceId: step.instanceId };
            continue;
        }
        const resource = next.resources[step.instanceId];
        next.paths[key] = { generation: next.paths[key].generation, instanceId: null };
        if (step.op === 'delete') resource.status = 'deleted';
        if (step.op !== 'move') continue;
        resource.locator = step.destination;
        next.paths[roleplayPathKey(state, step.kind, step.destination)] = { generation: step.destinationVacancy + 1, instanceId: step.instanceId };
    }
    const result = lifecycleResult(pending);
    const effect = { effectHash: pending.intentHash, writeId: pending.id, instanceId: result.instanceId, appliedRevision: result.revision, result };
    if (Object.keys(payloads).length) effect.cleanup = { payloads, journal: null };
    next.submissions[pending.operationKeyHash] = { accountId: state.accountId, dataEpoch: state.dataEpoch,
        intentHash: pending.intentHash, jobId: null, targetInstanceId: result.instanceId, state: 'closed',
        reservedReceiptBytes: 0, outcome: result, effects: { [LIFECYCLE_EFFECT_KEY]: effect } };
    next.pending = null;
    return next;
}

/** The temporary file's physical identity is persisted before publication, so replay cannot adopt a third state. */
function publishThroughTemporary(lease, filename, bytes, tag, before, getPhysical, setPhysical) {
    const temporary = path.join(path.dirname(filename), `.neconyan-roleplay-${tag}.tmp`);
    const rawHash = crypto.createHash('sha256').update(bytes).digest('hex');
    let physical = getPhysical();
    let current = readRoleplayFile(filename, CHAT_LIMIT, { allowMissingParent: true });
    if (physical && sameObservation(current, { rawHash, physical })) return current;
    if (before ? !sameObservation(current, before) : Boolean(current)) throw conflict();
    if (!physical) {
        let staged = readRoleplayFile(temporary, CHAT_LIMIT, { allowMissingParent: true });
        if (!staged) {
            if (tryWriteFileSync(temporary, bytes, { mode: 0o600 }, { expectedFileAbsent: true, durable: true }) === false) {
                throw roleplayError('ROLEPLAY_WRITE_UNCERTAIN', 'The protected file could not be written.', 503);
            }
            staged = readRoleplayFile(temporary, CHAT_LIMIT, { flush: true });
        }
        if (staged?.rawHash !== rawHash) throw conflict();
        physical = staged.physical;
        setPhysical(physical);
        saveRoleplayAccount(lease);
    }
    if (!sameObservation(readRoleplayFile(temporary, CHAT_LIMIT), { rawHash, physical })) throw conflict();
    current = readRoleplayFile(filename, CHAT_LIMIT, { allowMissingParent: true });
    if (before ? !sameObservation(current, before) : Boolean(current)) throw conflict();
    fs.renameSync(temporary, filename);
    fsyncDirectorySync(path.dirname(filename));
    const published = readRoleplayFile(filename, CHAT_LIMIT, { flush: true });
    if (!sameObservation(published, { rawHash, physical })) throw conflict();
    return published;
}

function writeLifecycleContents(lease, pending, step) {
    const { scope } = roleplayLease(lease);
    const filename = roleplayEntityPath(scope, step.kind, step.locator);
    return withChatFileLocks([filename], () => {
        const file = readRoleplayFile(filename, CHAT_LIMIT, { allowMissingParent: true });
        if (step.physical) {
            if (sameObservation(file, { rawHash: step.after.rawHash, physical: step.physical })) return false;
        }
        const { bytes } = readRoleplayPayload(lease, pending.id, step.after.payload, step.after.rawHash, CHAT_LIMIT);
        if (step.op === 'create') createRoleplayDirectory(path.dirname(filename), scope.directories.root);
        publishThroughTemporary(lease, filename, bytes, `${pending.id}-${step.after.payload}`,
            step.op === 'update' ? step.before : null, () => step.physical,
            physical => { step.physical = physical; });
        return true;
    });
}

function applyLifecycleStep(scope, step, host) {
    const source = roleplayEntityPath(scope, step.kind, step.locator);
    const read = filename => readRoleplayFile(filename, CHAT_LIMIT, { allowMissingParent: true });
    if (step.op === 'delete' || step.op === 'discard') {
        withChatFileLocks([source], () => {
            const file = read(source);
            if (!file) return;
            if (!sameObservation(file, step.before)) throw conflict();
            if (step.kind === 'chat' && host.backups) {
                runChatRecoveryBestEffort(() => markChatDeleted(lifecycleRecoveryTarget(scope, step.locator, host)),
                    'Failed to mark chat recovery state for deletion; continuing with chat deletion.');
            }
            fs.unlinkSync(source);
            fsyncDirectorySync(path.dirname(source));
        });
    } else {
        const destination = roleplayEntityPath(scope, step.kind, step.destination);
        withChatFileLocks([source, destination], () => {
            const from = read(source);
            const to = read(destination);
            if (!from && sameObservation(to, step.before)) return;
            if (to || !sameObservation(from, step.before)) throw conflict();
            // ponytail: recovery state is keyed per owner; cross-owner moves (character renames) leave it where it was.
            if (step.kind === 'chat' && host.backups && step.locator.avatar === step.destination.avatar) {
                const sourceTarget = lifecycleRecoveryTarget(scope, step.locator, host);
                const destinationTarget = lifecycleRecoveryTarget(scope, step.destination, host);
                // ponytail: best-effort sidecars; a crash between rekey and rename leaves only recovery snapshots stale.
                if (!runChatRecoveryBestEffort(() => rekeyChatRecoveryState(sourceTarget, destinationTarget),
                    'Failed to move chat recovery state; continuing with renamed chat.').ok) {
                    for (const item of [sourceTarget, destinationTarget]) {
                        runChatRecoveryBestEffort(() => clearChatRecoveryState(item), 'Failed to clear chat recovery state after rename.');
                    }
                }
            }
            createRoleplayDirectory(path.dirname(destination), scope.directories.root);
            // Writers that honour the chat lock cannot create the destination between this check and the rename.
            fs.renameSync(source, destination);
            fsyncDirectorySync(path.dirname(destination));
            if (path.dirname(source) !== path.dirname(destination)) fsyncDirectorySync(path.dirname(source));
        });
    }
    if (step.kind === 'chat') host.clearDeferred?.(source);
}

// Leftovers only: recorded chat files were already moved or deleted by their own steps.
function moveChatFolder(scope, task) {
    const source = path.join(scope.directories.chats, roleplayAvatarOwner(task.from ?? task.avatar));
    if (!fs.existsSync(source)) return;
    if (task.task === 'chat-folder-remove') {
        fs.rmSync(source, { recursive: true, force: true });
        return;
    }
    const destination = path.join(scope.directories.chats, roleplayAvatarOwner(task.to));
    createRoleplayDirectory(destination, scope.directories.root);
    for (const name of fs.readdirSync(source)) {
        // ponytail: an existing destination entry wins; the source copy stays for manual recovery.
        if (!fs.existsSync(path.join(destination, name))) fs.renameSync(path.join(source, name), path.join(destination, name));
    }
    if (!fs.readdirSync(source).length) fs.rmdirSync(source);
}

function applyLifecycleTask(scope, task, host) {
    const dateRoot = scope.directories.root || path.dirname(scope.directories.groups);
    if (task.task === 'chat-memory-remove') removeChatMemory(scope.directories, task.locator);
    else if (task.task === 'loose-card-remove') {
        const filename = roleplayEntityPath(scope, 'character', { avatar: task.avatar });
        withChatFileLocks([filename], () => {
            const stats = fs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
            if (!stats) return;
            const physical = { dev: String(stats.dev), ino: String(stats.ino), birthtimeNs: String(stats.birthtimeNs) };
            if (!isDeepStrictEqual(physical, task.physical)) throw conflict();
            fs.unlinkSync(filename);
            fsyncDirectorySync(path.dirname(filename));
        });
    } else if (task.task === 'source-memory-remove') removeSourceMemory(scope.directories, task);
    else if (task.task === 'date-added-create' || task.task === 'date-added-remove') {
        try {
            if (task.task === 'date-added-create') createEntityDateAdded(dateRoot, task.entity, task.id, task.time);
            else removeEntityDateAdded(dateRoot, task.entity, task.id);
        } catch (error) { console.warn('Could not update date-added metadata.', error); }
    } else if (task.task === 'chat-memory-rename') renameChatMemory(scope.directories, task.from, task.to, { resume: true });
    else if (task.task === 'character-memory-rename') renameCharacterMemory(scope.directories, task.from, task.to, { resume: true });
    else if (task.task === 'chat-folder-move' || task.task === 'chat-folder-remove') moveChatFolder(scope, task);
    else runChatRecoveryBestEffort(() => clearChatRecoveryState(lifecycleRecoveryTarget(scope, task.locator, host)),
        'Failed to clear chat recovery state after deletion.');
}

function applyPendingLifecycle(lease, host = {}) {
    const { state, scope } = roleplayLease(lease);
    const pending = state.pending;
    if (pending?.kind !== 'lifecycle') throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'There is no matching lifecycle operation.');
    if (pending.phase === 'prepared') {
        for (const step of pending.steps) {
            if (step.op !== 'create' && step.op !== 'update') applyLifecycleStep(scope, step, host);
            else if (writeLifecycleContents(lease, pending, step)) saveRoleplayAccount(lease);
        }
        pending.phase = 'files-applied';
        saveRoleplayAccount(lease);
    }
    for (const task of pending.auxiliary) applyLifecycleTask(scope, task, host);
    finishChatNavigationCharacterRename(lease);
    Object.assign(state, finishedLifecycle(state, pending));
    saveRoleplayAccount(lease);
    cleanupRoleplayReceiptsLocked(lease, pending.operationKeyHash);
    return lifecycleResult(pending);
}

/**
 * Drop the closed receipt of a server-generated key that no client holds, after its staged files are gone.
 * Nobody can replay such a key, so keeping it would only grow the ledger every later save rehashes.
 */
export function forgetRoleplayReceiptLocked(lease, kind, operationKey) {
    const { state } = roleplayLease(lease);
    const keyHash = roleplayHash([state.accountId, kind, operationKey]);
    cleanupRoleplayReceiptsLocked(lease, keyHash);
    const persisted = JSON.parse(roleplayLease(lease).stateFile.bytes.toString('utf8')).state;
    if (persisted.pending !== null || persisted.submissions[keyHash]?.state !== 'closed' || state.submissions[keyHash]?.state !== 'closed') return;
    delete state.submissions[keyHash];
    saveRoleplayAccount(lease);
}

/**
 * Records a protected delete or move before touching files. `intent` is the caller's request, so a retry
 * with the same operation key returns the original receipt instead of repeating or recreating anything.
 */
export function commitRoleplayLifecycleLocked(lease, { operationKey, action, intent, steps, auxiliary = [] }, host = {}) {
    // No key: a one-shot server operation whose receipt is dropped once it closes (an interrupted one is finished at startup).
    if (operationKey === undefined) {
        const key = crypto.randomUUID();
        const result = commitRoleplayLifecycleLocked(lease, { operationKey: key, action, intent, steps, auxiliary }, host);
        forgetRoleplayReceiptLocked(lease, 'lifecycle', key);
        return result;
    }
    confirmRoleplayAccount(lease);
    const { state } = roleplayLease(lease);
    if (typeof operationKey !== 'string' || !operationKey || operationKey.length > 256 || !/^[a-z][a-z-]{0,63}$/.test(action)
        || !Array.isArray(steps) || steps.length < 1 || steps.length > ROLEPLAY_LIFECYCLE_MAX_STEPS) throw roleplayError('ROLEPLAY_INVALID', 'Invalid Roleplay lifecycle operation.', 400);
    const operationKeyHash = roleplayHash([state.accountId, 'lifecycle', operationKey]);
    const intentHash = roleplayHash({ accountId: state.accountId, dataEpoch: state.dataEpoch, action, intent: intent ?? null });
    const prior = state.submissions[operationKeyHash];
    if (prior) {
        if (prior.intentHash !== intentHash) throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'This lifecycle identity was already used for different work.');
        return completedResult(prior);
    }
    if (state.pending) {
        if (state.pending.kind !== 'lifecycle' || state.pending.operationKeyHash !== operationKeyHash) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay operation must settle first.');
        }
        if (state.pending.intentHash !== intentHash) throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'The pending lifecycle operation has different contents.');
        return applyPendingLifecycle(lease, host);
    }
    steps = addChatNavigationCharacterRenameSteps(lease, action, steps);
    if (steps.length > ROLEPLAY_LIFECYCLE_MAX_STEPS) throw roleplayError('ROLEPLAY_INVALID', 'Too many linked group updates for one rename.', 400);
    const planned = steps.map((step, index) => planLifecycleStep(lease, step, index)).filter(Boolean);
    assertChatNavigationCharacterRename(lease, { action, steps: planned });
    if (!planned.some(step => step.op !== 'discard')) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'There is no protected file to change.', 404);
    for (const step of planned) {
        if (step.op === 'move' && step.kind === 'chat' && chatMemoryExists(roleplayLease(lease).scope.directories, step.destination)) {
            throw roleplayError('ROLEPLAY_TARGET_EXISTS', 'A Mewmory archive already exists for that chat name.');
        }
    }
    const pending = { schema: 1, kind: 'lifecycle', id: crypto.randomUUID(), operationKeyHash, intentHash,
        accountId: state.accountId, dataEpoch: state.dataEpoch, action, phase: 'prepared', steps: planned,
        auxiliary: JSON.parse(JSON.stringify(auxiliary)), reservedBytes: 8 * 1024 };
    assertRoleplayTransactionCapacity(lease, pending, finishedLifecycle(state, pending));
    // Authoring files must be bound before state.pending makes account writes unavailable.
    bindRoleplayScratchpadsLocked(lease, planned);
    steps.forEach((step, index) => {
        const planStep = planned.find(item => item.after?.payload === `lifecycle.${index}.bin`);
        if (planStep) stageRoleplayPayload(lease, pending.id, planStep.after.payload, step.bytes, CHAT_LIMIT);
    });
    state.pending = pending;
    try {
        saveRoleplayAccount(lease);
        return applyPendingLifecycle(lease, host);
    } catch (error) { throw Object.assign(error, { roleplayWritePending: true }); }
}

export function reconcilePendingChatWrite(scope, host) {
    return withRoleplayAccountLock(scope, lease => {
        confirmRoleplayAccount(lease);
        const pending = roleplayLease(lease).state.pending;
        const result = pending ? pending.kind === 'group-update' ? applyPendingGroupUpdate(lease)
            : pending.kind === 'chat-import' ? applyPendingChatImport(lease, host)
                : pending.kind === 'lifecycle' ? applyPendingLifecycle(lease, host) : applyPending(lease, host) : null;
        cleanupRoleplayReceiptsLocked(lease);
        return result;
    });
}

/** Explicit startup/account-creation work, never invoked by a missing-store lookup. */
export function bootstrapRoleplayAccount(base, host) {
    initialiseRoleplayAccount(base);
    // An interrupted reset settles before any other recovery; a purged account is left retired.
    const scope = settleRoleplayAccountReset(base);
    if (!scope) return null;
    reconcilePendingChatWrite(scope, host);
    return scope;
}

export function reconcileSingleChatWrite(scope, operationKey, host) {
    return withRoleplayAccountLock(scope, lease => {
        confirmRoleplayAccount(lease);
        const { state } = roleplayLease(lease);
        const operationKeyHash = key(state, operationKey);
        const prior = state.submissions[operationKeyHash];
        if (prior) {
            cleanupRoleplayReceiptsLocked(lease, operationKeyHash);
            return completedResult(prior);
        }
        if (state.pending?.kind !== 'chat-write' || state.pending.operationKeyHash !== operationKeyHash) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'There is no matching saved chat write.');
        }
        return applyPending(lease, host);
    });
}
