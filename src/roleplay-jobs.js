/**
 * Private admission of server jobs that will write a protected Roleplay chat.
 *
 * Admission records a permanent receipt under the account lock before any job
 * exists: capacity is reserved first, so a full store refuses before effects.
 * The job is created paused (not dispatchable); execution arrives in a later
 * stage; it stays paused until a complete bound request is released.
 * Each job carries one typed effect bound to exact saved anchors:
 * append (whole chat unchanged), continue, alternative, swipe and caption (one
 * message unchanged) or replace (a message range with unchanged prefix and
 * suffix). Applying the
 * effect is a recorded chat write; a completed receipt replays its outcome and
 * never writes again, and callbacks from another job, a retired job or an older
 * account incarnation are refused.
 */
import { acceptJob, getJob } from './jobs/store.js';
import { readArtifact } from './jobs/artifacts.js';
import { assertRoleplaySourceLocked, captureRoleplayMessage, captureRoleplayRange, captureRoleplayStorageSourceLocked } from './generation/roleplay-source.js';
import { commitSingleChatWriteLocked } from './roleplay-lifecycle.js';
import { applyCaptionRecords } from './generation/caption-records.js';
import { applyAgentCompletionRecords } from './generation/agent-completion-records.js';
import { assertRoleplayQuickReplyProof } from './generation/roleplay-quick-replies.js';
import { applyManualAgentRecords } from './generation/agent-manual-records.js';
import { applyPathfinderNotebookRecords } from './generation/pathfinder-notebook-records.js';
import { assertRoleplayTransactionCapacity, confirmRoleplayAccount, roleplayError, roleplayHash, roleplayLease, saveRoleplayAccount, withRoleplayAccount } from './roleplay-store.js';

export const ROLEPLAY_JOB_EFFECTS = Object.freeze(['append', 'continue', 'swipe', 'alternative', 'replace', 'caption', 'agent', 'notebook']);
// A closed receipt holds one chat-write result twice (outcome and effect) plus its keys.
const RECEIPT_RESERVE_BYTES = 8 * 1024;
// Admission also holds room for the completion's pending chat-write record, so
// provider work never runs for a reply the store could not accept afterwards.
const ADMISSION_RESERVE_BYTES = 64 * 1024 + RECEIPT_RESERVE_BYTES;
const JOB_EFFECT_KEY = roleplayHash('roleplay-job');

const invalid = message => roleplayError('ROLEPLAY_INVALID', message, 400);
const jobKey = (state, operationKey) => roleplayHash([state.accountId, 'roleplay-job', operationKey]);
const writeKey = (state, operationKey) => roleplayHash([state.accountId, 'chat-write', `job:${operationKey}`]);

function assertOperationKey(operationKey) {
    if (typeof operationKey !== 'string' || !operationKey || operationKey.length > 200) throw invalid('Invalid Roleplay job identity.');
}

function assertEffectSource(effect, source) {
    if (!ROLEPLAY_JOB_EFFECTS.includes(effect)) throw invalid('Unknown Roleplay job effect.');
    if (source?.kind !== undefined) throw invalid('A Roleplay job needs a generation source, not a storage source.');
    const needsMessage = ['continue', 'swipe', 'alternative', 'caption', 'agent'].includes(effect);
    if (needsMessage !== (source?.message !== undefined) || (effect === 'replace') !== (source?.range !== undefined)) {
        throw invalid('The Roleplay job source does not carry the anchor its effect needs.');
    }
}

/**
 * Admit a paused job. `source` is a generation source captured by
 * captureRoleplaySource with the anchor its effect needs; `request` is the rest
 * of the complete intent (prompt inputs, provider reference). One operation key
 * names one intent forever.
 */
export function admitRoleplayJob(base, account, { operationKey, effect, source, request = null, type = 'roleplay.reply', label = null }) {
    assertOperationKey(operationKey);
    assertEffectSource(effect, source);
    return withRoleplayAccount(base, account, lease => {
        confirmRoleplayAccount(lease);
        const { state, scope } = roleplayLease(lease);
        const keyHash = jobKey(state, operationKey);
        const intent = { effect, source, request };
        const intentHash = roleplayHash({ accountId: state.accountId, dataEpoch: state.dataEpoch, intent });
        const jobIntent = { roleplay: { accountId: state.accountId, dataEpoch: state.dataEpoch, operationKey }, ...intent };
        const prior = state.submissions[keyHash];
        if (prior && prior.intentHash !== intentHash) throw roleplayError('ROLEPLAY_INTENT_CONFLICT', 'This Roleplay job key already names different work.');
        if (prior && prior.state !== 'preparing') return { jobId: prior.jobId, state: prior.state, created: false };
        if (!prior) {
            if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay operation must settle first.');
            assertRoleplaySourceLocked(lease, source);
            state.submissions[keyHash] = { accountId: state.accountId, dataEpoch: state.dataEpoch, intentHash, jobId: null,
                targetInstanceId: source.instanceId, state: 'preparing', reservedReceiptBytes: ADMISSION_RESERVE_BYTES, effects: {} };
            try {
                assertRoleplayTransactionCapacity(lease, null, state);
                saveRoleplayAccount(lease);
            } catch (error) {
                if (!error.roleplayWriteUncertain) delete state.submissions[keyHash];
                throw error;
            }
        }
        // A crash after the receipt and before the job leaves 'preparing'; the
        // same key finds or creates the one job through its submission key.
        const { job, created } = acceptJob(scope.directories, { owner: scope.owner, type, submissionKey: `roleplay:${operationKey}`,
            intent: jobIntent, label, paused: true });
        state.submissions[keyHash].jobId = job.id;
        state.submissions[keyHash].state = 'accepted';
        saveRoleplayAccount(lease);
        return { jobId: job.id, state: 'accepted', created };
    });
}

function outputMessage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.mes !== 'string') {
        throw invalid('A Roleplay job output message needs text.');
    }
    return structuredClone(value);
}

function effectRecords(records, source, effect, output, request, job, directories) {
    if (effect === 'notebook') return applyPathfinderNotebookRecords(directories, job, records, output);
    if (effect === 'agent') return applyManualAgentRecords(directories, job, records, output);
    const captionPolicy = request?.worldInfo?.captions;
    if (output?.captions && !captionPolicy?.persist) throw invalid('The job did not accept a caption update.');
    const next = captionPolicy?.persist ? applyCaptionRecords(records, captionPolicy.items, output?.captions) : structuredClone(records);
    if (effect === 'caption') {
        if (!captionPolicy?.manual || !captionPolicy.persist || captionPolicy.items.some(item => item.index !== source.message.index)
            || Object.keys(output ?? {}).some(key => key !== 'captions')) throw invalid('A caption effect only updates its accepted media.');
        return next;
    }
    if (output?.inputTranslation) {
        const accepted = request?.worldInfo?.inputTranslation?.item;
        const change = output.inputTranslation;
        const record = Number.isSafeInteger(change.index) && next[change.index + 1];
        if (!accepted || change.index !== accepted.index || change.recordHash !== accepted.recordHash || !record?.is_user
            || roleplayHash(records[change.index + 1]) !== accepted.recordHash || typeof change.text !== 'string' || typeof change.displayText !== 'string'
            || Buffer.byteLength(change.text) > 256 * 1024 || Buffer.byteLength(change.displayText) > 256 * 1024) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The translated user input no longer matches its accepted source.');
        }
        record.mes = change.text;
        record.extra = { ...record.extra, display_text: change.displayText };
    }
    const agentBaseline = output?.quickReply ? structuredClone(next) : next;
    if (output?.quickReply) assertRoleplayQuickReplyProof(directories, job, next, output);
    else if (request?.worldInfo?.hookPolicy?.quickReply?.enabled && output?.quickReply === undefined
        && readArtifact(directories, job.id, 'roleplay-quick-replies') !== undefined) {
        throw invalid('The saved Quick Reply actions were not included with this reply.');
    }
    applyAgentCompletionRecords(directories, job, next, output, agentBaseline);
    if (output?.timedWorldInfo) {
        if (next.length - 1 !== output.timedChatLength
            || roleplayHash(next[0].chat_metadata?.timedWorldInfo ?? {}) !== output.timedBaseline) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved World Info timed effects changed before the reply was delivered.');
        }
        next[0].chat_metadata.timedWorldInfo = structuredClone(output.timedWorldInfo);
    }
    if (effect === 'append') return [...next, outputMessage(output?.message)];
    if (effect === 'replace') {
        if (!Array.isArray(output?.messages) || !output.messages.length) throw invalid('A range replacement needs messages.');
        next.splice(source.range.start + 1, source.range.count, ...output.messages.map(outputMessage));
        return next;
    }
    if (typeof output?.text !== 'string') throw invalid('A Roleplay job output needs text.');
    const message = next[source.message.index + 1];
    const timing = output.gen_started && output.gen_finished
        ? { gen_started: output.gen_started, gen_finished: output.gen_finished } : {};
    const swipes = Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [message.mes];
    if (effect === 'alternative') {
        // A named alternative adds one more unselected swipe. The selected text,
        // its index and the message's own metadata stay exactly as they were.
        const info = Array.isArray(message.swipe_info) ? message.swipe_info.slice(0, swipes.length) : [];
        while (info.length < swipes.length) info.push({});
        message.swipes = [...swipes, output.text];
        message.swipe_info = [...info, { ...timing, ...(output.extra ? { extra: output.extra } : {}) }];
        return next;
    }
    const selected = Number(message.swipe_id ?? 0);
    if (!Number.isInteger(selected) || selected < 0 || selected >= swipes.length) throw invalid('The anchored message has an unreadable swipe selection.');
    if (effect === 'continue') {
        message.mes = output.continuedText ?? message.mes + output.text;
        Object.assign(message, timing);
        if (output.extra) message.extra = { ...message.extra, ...output.extra };
        if (Array.isArray(message.swipes) && message.swipes.length) message.swipes[selected] = message.mes;
        if (output.extra && Array.isArray(message.swipe_info) && message.swipe_info[selected]) {
            message.swipe_info[selected].extra = { ...message.swipe_info[selected].extra, ...output.extra };
            Object.assign(message.swipe_info[selected], timing);
        }
        if (message.swipe_id !== undefined) message.swipe_id = selected;
        return next;
    }
    const info = Array.isArray(message.swipe_info) ? message.swipe_info.slice(0, swipes.length) : [];
    while (info.length < swipes.length) info.push({});
    message.swipes = [...swipes, output.text];
    message.swipe_info = [...info, { ...timing, ...(output.extra ? { extra: output.extra } : {}) }];
    message.swipe_id = message.swipes.length - 1;
    message.mes = output.text;
    Object.assign(message, timing);
    if (output.extra) message.extra = { ...message.extra, ...output.extra };
    return next;
}

/** Build a protected candidate's final chat without publishing a provisional message. */
export function previewRoleplayWorkflowEffect(lease, { source, effect, output, request, job }) {
    if (job?.type !== 'roleplay.candidate' || !job.intent?.request?.workflowCandidate || !source || !output) {
        throw roleplayError('ROLEPLAY_WORKFLOW_INVALID', 'Only a bound workflow candidate can prepare this chat.', 409);
    }
    const { scope } = roleplayLease(lease);
    if (job.owner !== scope.owner || roleplayHash(job.intent) !== roleplayHash({ ...job.intent, source, effect, request })) {
        throw roleplayError('ROLEPLAY_WORKFLOW_INVALID', 'The saved workflow candidate changed.', 409);
    }
    const saved = assertRoleplaySourceLocked(lease, source, { effect });
    return effectRecords(saved.records, source, effect, output, request, job, scope.directories);
}

/** Completed ownership remains available after the replayable job and its artifacts have expired. */
export function readRoleplayJobResult(base, account, { operationKey, jobId, effect, source, request }) {
    assertOperationKey(operationKey);
    return withRoleplayAccount(base, account, lease => {
        const { state } = roleplayLease(lease);
        const receipt = state.submissions[jobKey(state, operationKey)];
        if (!receipt || receipt.jobId !== jobId || receipt.intentHash !== roleplayHash({ accountId: state.accountId,
            dataEpoch: state.dataEpoch, intent: { effect, source, request } })) throw roleplayError('ROLEPLAY_JOB_REJECTED', 'The job does not own this accepted result.', 409);
        return receipt.state === 'closed' ? structuredClone(receipt.outcome) : null;
    });
}

/** Read a completed typed child effect without requiring its pruned job/artifacts. */
export function readRoleplayJobResultByIntentHash(base, account, { operationKey, jobId, intentHash }) {
    assertOperationKey(operationKey);
    if (typeof jobId !== 'string' || !jobId || !/^[a-f0-9]{64}$/u.test(intentHash)) throw invalid('Invalid child Roleplay result ownership.');
    return withRoleplayAccount(base, account, lease => {
        const { state } = roleplayLease(lease);
        const receipt = state.submissions[jobKey(state, operationKey)];
        if (!receipt || receipt.jobId !== jobId || receipt.intentHash !== intentHash) {
            throw roleplayError('ROLEPLAY_JOB_REJECTED', 'The child job does not own this accepted result.', 409);
        }
        return receipt.state === 'closed' ? structuredClone(receipt.outcome) : null;
    });
}

function candidateOwnershipLocked(lease, operationKey, jobId) {
    confirmRoleplayAccount(lease);
    const { state, scope } = roleplayLease(lease);
    const receipt = state.submissions[jobKey(state, operationKey)];
    if (!receipt || receipt.jobId !== jobId) throw roleplayError('ROLEPLAY_JOB_REJECTED', 'This workflow candidate has no accepted receipt.', 409);
    if (receipt.state !== 'accepted' || state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The workflow candidate cannot run during another operation.', 503);
    const job = getJob(scope.directories, jobId);
    const { roleplay, source, request, effect } = job?.intent ?? {};
    const marker = request?.workflowCandidate;
    const parent = marker && getJob(scope.directories, marker.parentJobId);
    const capacity = parent?.intent?.request?.capacity;
    if (job?.type !== 'roleplay.candidate' || job.owner !== scope.owner || job.cancellation?.requested
        || roleplay?.operationKey !== operationKey || !marker || marker.version !== 1
        || parent?.type !== 'media.roleplay-workflow' || parent.owner !== scope.owner || parent.cancellation?.requested
        || !capacity || capacity.version !== 1 || capacity.limitBytes !== 64 * 1024 * 1024
        || capacity.hash !== roleplayHash(Object.fromEntries(Object.entries(capacity).filter(([key]) => key !== 'hash')))
        || capacity.accountId !== state.accountId || capacity.dataEpoch !== state.dataEpoch
        || capacity.sourceHash !== roleplayHash(parent.intent.source)
        || !['waiting', 'queued', 'running'].includes(parent.state) || parent.intent?.media?.accountId !== state.accountId
        || parent.intent.media.dataEpoch !== state.dataEpoch || roleplayHash(parent.intent) !== marker.parentIntentHash
        || job.parentId !== parent.id || !parent.children.includes(jobId)
        || receipt.intentHash !== roleplayHash({ accountId: state.accountId, dataEpoch: state.dataEpoch,
            intent: { effect, source, request } })) {
        throw roleplayError('ROLEPLAY_JOB_REJECTED', 'The candidate is not owned by this accepted workflow.', 409);
    }
    assertRoleplaySourceLocked(lease, source, { effect });
    return { receipt, job, scope };
}

/** Refuse an unowned candidate BEFORE it can spend a model call. */
export function assertRoleplayCandidateOwner(base, account, { operationKey, jobId }) {
    assertOperationKey(operationKey);
    return withRoleplayAccount(base, account, lease => {
        candidateOwnershipLocked(lease, operationKey, jobId);
        return true;
    });
}

/** Complete an owned workflow candidate without exposing a provisional reply in saved chat. */
export function completeRoleplayCandidateJob(base, account, { operationKey, jobId }) {
    assertOperationKey(operationKey);
    return withRoleplayAccount(base, account, lease => {
        const { state } = roleplayLease(lease);
        const receipt = state.submissions[jobKey(state, operationKey)];
        if (!receipt || receipt.jobId !== jobId) throw roleplayError('ROLEPLAY_JOB_REJECTED', 'This workflow candidate has no accepted receipt.', 409);
        if (receipt.state === 'closed') return structuredClone(receipt.outcome);
        const { job, scope } = candidateOwnershipLocked(lease, operationKey, jobId);
        const saved = readArtifact(scope.directories, jobId, 'roleplay-candidate');
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.intentHash !== roleplayHash(job.intent)
            || !['text', 'tool-turn'].includes(saved.kind) || saved.hash !== roleplayHash({
            intentHash: saved.intentHash, kind: saved.kind, providerHash: saved.providerHash,
            ...(saved.kind === 'text' ? { output: saved.output } : { callsHash: saved.callsHash }) })) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved candidate result needs recovery.', 503);
        }
        if (saved.kind === 'text' && (!saved.output || typeof saved.output !== 'object')
            || saved.kind === 'tool-turn' && !/^[a-f0-9]{64}$/u.test(saved.callsHash)) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved candidate result is incomplete.', 503);
        }
        const outcome = { kind: 'candidate', turnKind: saved.kind, candidateArtifact: 'roleplay-candidate', proofHash: saved.hash };
        receipt.state = 'closed';
        receipt.reservedReceiptBytes = 0;
        receipt.outcome = outcome;
        receipt.effects = { [JOB_EFFECT_KEY]: { effectHash: receipt.intentHash, writeId: null,
            instanceId: receipt.targetInstanceId, appliedRevision: state.resources[receipt.targetInstanceId].revision,
            result: outcome } };
        saveRoleplayAccount(lease);
        return structuredClone(outcome);
    });
}

/** The effect's anchor must still hold; unrelated later edits elsewhere are allowed only where the anchor permits. */
function assertAnchor(saved, source, effect) {
    const changed = () => roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved chat moved past this job\'s anchor; the reply was not written.');
    if (saved.instanceId !== source.instanceId) throw changed();
    if (effect === 'append' || effect === 'notebook') {
        if (saved.rawHash !== source.rawHash) throw changed();
        return;
    }
    try {
        const current = effect === 'replace' ? captureRoleplayRange(saved.records, source.range)
            : captureRoleplayMessage(saved.records, source.message.index);
        const expected = effect === 'replace' ? source.range : source.message;
        if (JSON.stringify(current) !== JSON.stringify(expected)) throw changed();
    } catch (error) {
        if (error.code === 'ROLEPLAY_INVALID') throw changed();
        throw error;
    }
}

function closeReceipt(lease, keyHash, result) {
    const receipt = roleplayLease(lease).state.submissions[keyHash];
    receipt.state = 'closed';
    receipt.reservedReceiptBytes = 0;
    receipt.outcome = result;
    receipt.effects = { [JOB_EFFECT_KEY]: { effectHash: receipt.intentHash, writeId: result.writeId, instanceId: result.instanceId,
        appliedRevision: result.revision, result } };
    saveRoleplayAccount(lease);
    return structuredClone(result);
}

/**
 * Apply a finished job's output. `account` is the stamp saved in the job's
 * intent, so a callback after a reset is refused as ROLEPLAY_ACCOUNT_CHANGED.
 */
export function applyRoleplayJobEffect(base, account, { operationKey, jobId, output }, host) {
    assertOperationKey(operationKey);
    return withRoleplayAccount(base, account, lease => {
        confirmRoleplayAccount(lease);
        const { state, scope } = roleplayLease(lease);
        const keyHash = jobKey(state, operationKey);
        const receipt = state.submissions[keyHash];
        const rejected = message => roleplayError('ROLEPLAY_JOB_REJECTED', message, 409);
        if (!receipt || receipt.jobId !== jobId) throw rejected('This job does not own that Roleplay receipt.');
        if (receipt.state === 'closed') return structuredClone(receipt.outcome);
        if (receipt.state !== 'accepted') throw rejected('This Roleplay job was withdrawn.');
        const job = getJob(scope.directories, jobId);
        if (!job || job.cancellation?.requested || job.intent?.roleplay?.operationKey !== operationKey) throw rejected('This Roleplay job is no longer active.');
        const { effect, source, request } = job.intent;
        // The jobs ledger is ordinary storage: its intent must be the one the receipt admitted.
        if (roleplayHash({ accountId: state.accountId, dataEpoch: state.dataEpoch, intent: { effect, source, request } }) !== receipt.intentHash) {
            throw rejected('This Roleplay job no longer carries the intent it was admitted with.');
        }
        // A crash after the chat write but before closing the job receipt: the
        // write's own receipt holds the outcome, so nothing is written twice.
        const written = state.submissions[writeKey(state, operationKey)];
        if (written?.state === 'closed') return closeReceipt(lease, keyHash, written.outcome);
        if (state.pending) throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'An earlier Roleplay operation must settle first.');
        // Follow the chat's identity, so a rename after admission does not strand the job.
        const resource = state.resources[source.instanceId];
        if (resource?.status !== 'live' || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch) {
            throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The chat this job answers no longer exists.', 404);
        }
        const captured = captureRoleplayStorageSourceLocked(lease, resource.locator);
        assertAnchor(captured.saved, source, effect);
        const records = effectRecords(captured.saved.records, source, effect, output, request, job, scope.directories);
        // The admission reservation covers this write's pending record; hand it over.
        receipt.reservedReceiptBytes = RECEIPT_RESERVE_BYTES;
        const result = commitSingleChatWriteLocked(lease, { operationKey: `job:${operationKey}`, mode: 'update', sourceKind: 'storage',
            source: captured.source, records, allowShrink: effect === 'replace', backup: { deferBackup: true } }, host);
        return closeReceipt(lease, keyHash, result);
    });
}

/** Withdraw an accepted job that ended without output; the receipt stays as evidence. */
export function voidRoleplayJob(base, account, { operationKey, jobId }) {
    assertOperationKey(operationKey);
    return withRoleplayAccount(base, account, lease => {
        const { state } = roleplayLease(lease);
        const receipt = state.submissions[jobKey(state, operationKey)];
        if (!receipt || receipt.jobId !== jobId) throw roleplayError('ROLEPLAY_JOB_REJECTED', 'This job does not own that Roleplay receipt.', 409);
        if (receipt.state !== 'accepted') return receipt.state;
        receipt.state = 'void';
        receipt.reservedReceiptBytes = 0;
        saveRoleplayAccount(lease);
        return 'void';
    });
}
