/**
 * The native acceptance of one named Roleplay workflow, and the owner's readback
 * of its permanent receipt.
 *
 * The browser names a workflow, names the saved chat it answers, and hands over
 * only the text a user typed. Everything else - the anchor, the prompt window,
 * the World Info trigger, the prompt contributions, the connection and the
 * durable write - is captured here under the account lock, so one accepted
 * request is one bounded server workflow whose receipt outlives its job.
 *
 * Replaying an accepted key never repeats paid work: the media receipt is
 * reserved under the same key, so a second submission returns the first
 * acceptance and later reads return its finished result.
 */
import sanitize from 'sanitize-filename';
import { normalizeLocator } from '../mewmory/store.js';
import { roleplayAccountBase, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { releaseJob } from '../jobs/store.js';
import { captureRoleplaySourceLocked, readRoleplayChatLocked } from './roleplay-source.js';
import { captureGenerationBinding, getChatProfileContextLimit } from './profiles.js';
import { readNativeMediaJobResultForOwner } from './media-jobs.js';
import { captureRoleplayNamedWorkflow, ROLEPLAY_WORKFLOW_NAMES } from './roleplay-workflow-named.js';
import { admitRoleplayWorkflowJob, captureRoleplayWorkflowRequest } from './roleplay-workflow.js';
import { getRoleplaySourceMessageRevision } from '../../public/scripts/neconyan-conversation/roleplay-source.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_KEY_LENGTH = 256;
const MAX_REVISION_BYTES = 512 * 1024;
const MAX_TOKENS = 8192;
const DEFAULT_TOKENS = 512;
const SUBMISSION = ['key', 'name', 'intent', 'source', 'anchor', 'messageRevision', 'groupRevision', 'maxTokens', 'account', 'acknowledgement'];
const ANCHOR_FIELDS = ['messageIndex', 'chosen'];

const invalid = (message, code = 'roleplay_workflow_invalid') => Object.assign(new Error(message), { status: 400, apiError: code });
const changed = (message, code = 'roleplay_workflow_changed') => Object.assign(new Error(message), { status: 409, apiError: code });

function assertKeys(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`Invalid ${label}.`);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw invalid(`Unexpected ${label} field: ${key}`);
    }
}

function identifier(value, label) {
    const parsed = typeof value === 'string' ? value.trim() : '';
    if (!parsed || parsed === '__proto__' || parsed === 'prototype' || parsed === 'constructor') throw invalid(`Invalid ${label}.`);
    return parsed;
}

function revision(value, label) {
    if (typeof value !== 'string' || !value) throw invalid(`Invalid ${label}.`);
    if (Buffer.byteLength(value, 'utf8') > MAX_REVISION_BYTES) throw invalid(`Oversized ${label}.`);
    return value;
}

function chatName(value) {
    let chat = identifier(value, 'chat name');
    while (/\.jsonl$/i.test(chat)) chat = chat.replace(/\.jsonl$/i, '');
    if (!chat || sanitize(chat) !== chat) throw invalid('Invalid chat name.');
    return chat;
}

function accountStamp(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['accountId', 'dataEpoch'].includes(key))
        || typeof value.accountId !== 'string' || !UUID.test(value.accountId)
        || !Number.isSafeInteger(value.dataEpoch) || value.dataEpoch < 1) {
        throw changed('Reload the page before submitting a Roleplay workflow.', 'roleplay_account_changed');
    }
    return { accountId: value.accountId, dataEpoch: value.dataEpoch };
}

/**
 * One named workflow submission. The anchor kind is the server's own: `end`
 * appends after the saved chat, `last` answers the chat's own final model
 * message, and `chosen` answers the message the browser named, which is a
 * deliberate user choice rather than sampling.
 */
export function normalizeRoleplayWorkflowSubmission(body = {}) {
    assertKeys(body, SUBMISSION, 'workflow submission');
    assertKeys(body.source, ['locator'], 'workflow source');
    assertKeys(body.source.locator, ['chat', 'avatar', 'group'], 'workflow locator');
    const key = identifier(body.key, 'workflow key');
    if (key.length > MAX_KEY_LENGTH) throw invalid('The workflow key is too long.');
    const name = identifier(body.name, 'workflow name');
    if (!ROLEPLAY_WORKFLOW_NAMES[name]) throw invalid('Unknown named Roleplay workflow.');
    if (typeof body.source.locator.group !== 'boolean') throw invalid('Invalid workflow locator group flag.');
    if (body.source.locator.group) throw invalid('A named workflow answers one speaker, not a group turn.');
    const avatar = body.source.locator.avatar === undefined || body.source.locator.avatar === ''
        ? '' : identifier(body.source.locator.avatar, 'character file');
    if (!avatar || sanitize(avatar) !== avatar) throw invalid('A chat workflow needs a character file.');
    const named = captureRoleplayNamedWorkflow(name, body.intent ?? {});
    assertKeys(body.anchor, ANCHOR_FIELDS, 'workflow anchor');
    // The browser names the message the user was looking at. `chosen` says it was
    // a deliberate pick; otherwise the server's own anchor derivation must agree
    // with it, so a chat that moved on is refused rather than answered elsewhere.
    if (typeof body.anchor.chosen !== 'boolean') throw invalid('Invalid workflow anchor choice.');
    if (named.anchor === 'chosen' && body.anchor.chosen !== true) throw invalid('This workflow needs a message the user chose.');
    if (named.anchor !== 'chosen' && body.anchor.chosen) throw invalid('This workflow answers the chat itself, not a chosen message.');
    const messageIndex = body.anchor.messageIndex;
    if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) throw invalid('Invalid workflow message index.');
    const maxTokens = body.maxTokens === undefined || body.maxTokens === null ? null : body.maxTokens;
    if (maxTokens !== null && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS)) throw invalid('Invalid workflow token limit.');
    return { key, name, named, locator: { chat: chatName(body.source.locator.chat), avatar, group: false },
        messageIndex, chosen: body.anchor.chosen === true, messageRevision: revision(body.messageRevision, 'message revision'),
        maxTokens, account: accountStamp(body.account),
        acknowledgement: { account: identifier(body.acknowledgement?.account, 'account handle'),
            settingsRevision: body.acknowledgement?.settingsRevision } };
}

/**
 * A workflow with no stated token limit still needs one the saved context can
 * hold, so the limit comes from the acknowledged connection rather than a guess.
 */
function workflowTokenLimit(directories, binding, requested) {
    if (requested !== null) return requested;
    const contextLimit = getChatProfileContextLimit(directories, binding);
    if (!Number.isSafeInteger(contextLimit) || contextLimit <= 128) throw changed('The saved connection has no room for a Roleplay workflow.', 'roleplay_workflow_context');
    return Math.max(64, Math.min(DEFAULT_TOKENS, Math.floor((contextLimit - 128) / 2)));
}

function submissionScope(request) {
    const owner = request?.user?.profile?.handle;
    const directories = request?.user?.directories;
    if (!owner || !directories?.root) throw Object.assign(new Error('An authenticated account is required.'), { status: 401 });
    const base = roleplayAccountBase(directories);
    if (!base) throw changed('This account has no protected Roleplay storage yet.', 'roleplay_account_unavailable');
    return { base, owner, directories };
}

/** The saved chat's own final model message, so a miscounted browser cannot retarget a write. */
function lastModelIndex(records) {
    const messages = records.slice(1);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.is_user !== true && message?.role !== 'user' && message?.is_system !== true) return index;
    }
    return null;
}

/**
 * Resolve the anchor and capture the protected source under one account lock, so
 * the message the named effect writes is the message the saved chat had when the
 * lock was taken.
 */
function captureWorkflowSource(base, account, submission) {
    return withRoleplayAccount(base, account, lease => {
        const locator = normalizeLocator(submission.locator);
        const saved = readRoleplayChatLocked(lease, locator);
        const messages = saved.records.slice(1);
        let index = null;
        if (submission.named.anchor === 'chosen') {
            index = submission.messageIndex;
        } else if (submission.named.anchor === 'end') {
            if (!messages.length) throw changed('The saved Roleplay chat has no message to answer.', 'roleplay_workflow_anchor');
            index = messages.length - 1;
        } else {
            index = lastModelIndex(saved.records);
            if (index === null) throw changed('The saved Roleplay chat has no model message to answer.', 'roleplay_workflow_anchor');
        }
        // The server's own anchor must be the message the user was looking at, so a
        // chat that moved on cannot absorb a different intent.
        if (index !== submission.messageIndex) {
            throw changed('The saved Roleplay chat moved on after this workflow was captured.', 'roleplay_workflow_anchor');
        }
        if (!messages[index] || getRoleplaySourceMessageRevision(messages[index]) !== submission.messageRevision) {
            throw changed('The saved Roleplay message changed after this workflow was captured.', 'roleplay_workflow_changed');
        }
        // An append anchors the whole chat, so its source carries no message anchor.
        const captured = captureRoleplaySourceLocked(lease, { locator,
            ...(submission.named.effect === 'append' ? {}
                : submission.named.effect === 'replace'
                    ? { range: { start: index, count: 1 } } : { message: index }) });
        if (saved.changed || captured.changed) saveRoleplayAccount(lease);
        return { source: captured.source, index };
    });
}

/**
 * Accept one named workflow. The connection and the bounded request are captured
 * after the source, and the admission re-asserts the source under its own lock,
 * so a chat that changed in between is refused before any paid work starts.
 */
export async function acceptRoleplayNamedWorkflow(request, body = {}) {
    const { base, owner, directories } = submissionScope(request);
    const submission = normalizeRoleplayWorkflowSubmission(body);
    if (submission.acknowledgement.account !== owner) throw changed('This account does not match the saved one.');
    const captured = captureWorkflowSource(base, submission.account, submission);
    let binding;
    try {
        binding = captureGenerationBinding(directories, { kind: 'active' }, submission.acknowledgement);
    } catch (error) {
        // A stale acknowledgement is the one refusal a caller can clear for itself.
        if (error?.status !== 409) throw error;
        throw changed('The active connection settings are not acknowledged. Save them before generating a reply.', 'roleplay_settings_ack_required');
    }
    const maxTokens = workflowTokenLimit(directories, binding, submission.maxTokens);
    const workflow = captureRoleplayWorkflowRequest(base, submission.account, captured.source,
        { avatar: submission.locator.avatar, binding, maxTokens, named: submission.named });
    const accepted = admitRoleplayWorkflowJob(base, submission.account,
        { operationKey: submission.key, source: captured.source, request: workflow });
    if (accepted.jobId) releaseJob(directories, accepted.jobId);
    return { key: submission.key, name: submission.name, jobId: accepted.jobId ?? null,
        created: accepted.created !== false, state: accepted.state ?? null,
        ...(accepted.result ? { result: accepted.result } : {}),
        write: { instanceId: captured.source.instanceId, revision: captured.source.revision } };
}

/**
 * The owner's readback for one submitted key. A pruned job, a finished write and
 * a never-accepted key are all answered without new work, which is what lets a
 * reopened page recover its result instead of replaying the submission.
 */
export function readRoleplayWorkflowReceipt(request, key) {
    const { base } = submissionScope(request);
    const operationKey = typeof key === 'string' ? key.trim() : '';
    if (!operationKey || operationKey.length > MAX_KEY_LENGTH) throw invalid('Invalid workflow key.');
    const receipt = readNativeMediaJobResultForOwner(base, { operationKey });
    return { key: operationKey, accepted: Boolean(receipt), state: receipt?.state ?? null,
        jobId: receipt?.jobId ?? null, result: receipt?.result ?? null };
}
