import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withChatFileLocks } from './chat-file-lock.js';
import { createCharacterChatTarget, createGroupChatTarget, parseChatJsonl, restoreChatSnapshotIfMatches } from './chat-recovery.js';
import { assertRoleplaySourceLocked, assertPendingRoleplayDependencies, captureRoleplayDependenciesLocked, normaliseRoleplayLocator,
    roleplayChatPath, roleplayContentHash, roleplayPathKey, roleplayGroupContentHash, normaliseRoleplayGroupId,
    assertRoleplayGroupData, readRoleplayEntityLocked } from './generation/roleplay-source.js';
import { assertRoleplayTransactionCapacity, confirmRoleplayAccount, createRoleplayDirectory, readRoleplayFile, readRoleplayPayload,
    roleplayError, roleplayHash, roleplayLease, saveRoleplayAccount, stageRoleplayPayload, withRoleplayAccountLock, ROLEPLAY_LARGEST_PHYSICAL,
    largestRoleplayJournal, roleplayPayloadDirectory, initialiseRoleplayAccount, readRoleplayWriteJournal, roleplayAvatarOwner } from './roleplay-store.js';
import { applyPreparedBranchMemoryCapture, assertPreparedBranchMemory, prepareBranchMemoryCapture } from './mewmory/prepared-branch.js';
import { MAX_ARCHIVE_BYTES } from './mewmory/store.js';
import { decodeFileWriteRecovery, fsyncDirectorySync, tryWriteFileSync, FILE_WRITE_RECOVERY_SUFFIX } from './util.js';

const CHAT_LIMIT = 64 * 1024 * 1024;
const EFFECT_KEY = roleplayHash('chat-write');
const GROUP_EFFECT_KEY = roleplayHash('group-update');
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
        const file = readRoleplayFile(filename, ['chat.after.jsonl', 'group.after.json'].includes(name) ? CHAT_LIMIT : MAX_ARCHIVE_BYTES, { allowMissingParent: true });
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
    Object.assign(state, final);
    try { saveRoleplayAccount(lease); } catch (error) { throw Object.assign(error, { chatCommitted: true, integrity: pending.after.integrity }); }
    cleanupRoleplayReceiptsLocked(lease, pending.operationKeyHash);
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
    if (!file || !isDeepStrictEqual(file.physical, pending.before.physical)
        || (pending.phase === 'group-applied' && file.rawHash !== pending.after.rawHash)
        || (pending.appliedPhysical && !isDeepStrictEqual(file.physical, pending.appliedPhysical))) throw conflict();
    if (file.rawHash === pending.before.rawHash && pending.rawChanged) {
        const payload = groupUpdatePayload(lease, pending);
        file = withChatFileLocks([filename], () => {
            const current = readRoleplayFile(filename, CHAT_LIMIT);
            if (!sameObservation(current, pending.before)) throw conflict();
            tryWriteFileSync(filename, payload.bytes, { mode: 0o600 }, {
                preserveFileIdentity: true, invalidateBeforeWrite: true, preserveOnWriteError: true,
                expectedFileIdentity: { dev: BigInt(current.physical.dev), ino: BigInt(current.physical.ino),
                    birthtimeNs: BigInt(current.physical.birthtimeNs) },
                expectedFileHash: current.rawHash, maxFileBytes: CHAT_LIMIT,
            });
            const written = readRoleplayFile(filename, CHAT_LIMIT, { flush: true });
            if (!written || written.rawHash !== pending.after.rawHash
                || !isDeepStrictEqual(written.physical, pending.before.physical)) throw conflict();
            return written;
        });
    } else if (file.rawHash !== pending.after.rawHash) {
        // A deleted, replaced, corrupt, or third-state file is retained with its pending evidence.
        throw conflict();
    } else {
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

export function reconcilePendingChatWrite(scope, host) {
    return withRoleplayAccountLock(scope, lease => {
        confirmRoleplayAccount(lease);
        const pending = roleplayLease(lease).state.pending;
        const result = pending ? pending.kind === 'group-update' ? applyPendingGroupUpdate(lease) : applyPending(lease, host) : null;
        cleanupRoleplayReceiptsLocked(lease);
        return result;
    });
}

/** Explicit startup/account-creation work, never invoked by a missing-store lookup. */
export function bootstrapRoleplayAccount(base, host) {
    const scope = initialiseRoleplayAccount(base);
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
