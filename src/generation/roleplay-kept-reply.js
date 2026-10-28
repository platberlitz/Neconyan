/**
 * Keep a paid Roleplay reply that the job lifecycle could not deliver through
 * its own effect.
 *
 * The ordinary write path owns a chat for one workflow receipt. When that path
 * ends first - the owner stops mid-stream, a later Agent step fails, the chat is
 * edited while postprocessing runs, or the final receipt write is refused - the
 * model text used to exist only in the display preview (in memory) and in an
 * optional job artifact. This module is the single writer that captures the
 * longest saved text first, then places it safely in the same protected chat:
 *
 * - an ordinary reply appends one new message;
 * - a continuation extends its unchanged target, or appends when the user
 *   edited that target instead of overwriting them;
 * - a swipe or regeneration adds and selects one new swipe on its original
 *   target; a Deep Swipe alternative stays unselected;
 * - a group speaker keeps its own avatar and generation id.
 *
 * At most one keeper record exists per reply job. The chat write uses the
 * account lock and the ordinary single-write transaction, so a second call
 * adopts the saved message instead of appending it again. A refusal (full
 * store, deleted chat, changed account) leaves the captured text in the job
 * artifact and reports that failure to the owner's receipt.
 */
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { getJob, listJobs, registerJobRecoveryLifecycle, TERMINAL_STATES } from '../jobs/store.js';
import { roleplayError, roleplayHash, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { captureRoleplayStorageSourceLocked } from './roleplay-source.js';
import { commitSingleChatWriteLocked, reconcileRoleplayChatWriteIfPending } from '../roleplay-lifecycle.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { withNativeMediaReceipt } from './media-jobs.js';
import { readRoleplayPreview } from './roleplay-preview.js';

export const KEPT_REPLY_ARTIFACT = 'roleplay-kept-reply';
export const MAIN_COMPLETE_ARTIFACT = 'roleplay-main-complete';
/** Advertised with submissions and receipts so a page never saves its own stale preview. */
export const ROLEPLAY_REPLY_CAPABILITY = Object.freeze({ keptReply: 1 });
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_WITNESS_BYTES = 256 * 1024;
const REPLAY_JOB_TYPES = new Set(['roleplay.candidate', 'roleplay.reply']);
const WORKFLOW_TEXT_PREFIX = 'roleplay-workflow-assembled:';

function workflowOutputText(output) {
    const message = messageOf(output);
    if (typeof message?.mes === 'string') return message.mes;
    if (typeof output?.continuedText === 'string') return output.continuedText;
    if (typeof output?.text === 'string') return output.text;
    return '';
}

/**
 * Persist the full reply the workflow has assembled so far. An automatic
 * continuation publishes only at the end, so without this record a later turn's
 * stop would keep only that turn's chunk and lose every completed turn before it.
 */
export function recordWorkflowReplyText(context, job, turn, output, { selected = true, speakerIndex = null, chunk = null, continuation = null } = {}) {
    if (!Number.isSafeInteger(turn) || turn < 0 || turn >= 16) return null;
    const keptContinuation = selected && continuation
        && typeof continuation.prefix === 'string' && typeof continuation.suffix === 'string'
        ? { prefix: continuation.prefix, suffix: continuation.suffix } : null;
    const text = selected ? keptContinuation
        ? keptContinuation.prefix + keptContinuation.suffix : workflowOutputText(output) : '';
    const selectedText = selected ? textOf(output, job.intent?.request?.effect ?? job.intent?.effect) : null;
    const record = { version: 1, parentIntentHash: roleplayHash(job.intent), turn, selected: selected === true,
        ...(Number.isSafeInteger(speakerIndex) ? { speakerIndex } : {}),
        ...(selected ? { output: structuredClone(output), text,
            chunk: keptContinuation ? false : chunk === null ? selectedText?.chunk === true : chunk === true,
            ...(keptContinuation ? { continuation: keptContinuation } : {}) } : {}),
        textHash: roleplayHash(text) };
    const value = { ...record, hash: roleplayHash(record) };
    const filename = WORKFLOW_TEXT_PREFIX + turn;
    const existing = readArtifact(context.directories, job.id, filename);
    if (existing !== undefined && roleplayHash(existing) !== roleplayHash(value)) {
        throw roleplayError('ROLEPLAY_WORKFLOW_RECOVERY', 'The saved progressive workflow text changed.', 409);
    }
    if (existing === undefined) writeArtifact(context.directories, job.id, filename, value);
    return value;
}

/** Read one saved progressive step. Only a matching root intent and turn can supply text. */
export function readWorkflowReplyText({ directories, rootJobId, turn }) {
    if (typeof rootJobId !== 'string' || !rootJobId || !Number.isSafeInteger(turn) || turn < 0) return null;
    let root;
    try { root = getJob(directories, rootJobId); } catch { return null; }
    if (!root) return null;
    let saved;
    try { saved = readArtifact(directories, rootJobId, WORKFLOW_TEXT_PREFIX + turn); } catch { return null; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    const { hash, ...record } = saved;
    if (hash !== roleplayHash(record) || record.parentIntentHash !== roleplayHash(root.intent)
        || record.turn !== turn || typeof record.selected !== 'boolean') return null;
    return record;
}

/** Read the saved automatic choice for one turn. Only a matching swipe decision can be trusted. */
function readWorkflowDecision({ directories, rootJobId, turn }) {
    if (typeof rootJobId !== 'string' || !rootJobId || !Number.isSafeInteger(turn) || turn < 0) return null;
    let root;
    try { root = getJob(directories, rootJobId); } catch { return null; }
    if (!root) return null;
    let saved;
    try { saved = readArtifact(directories, rootJobId, 'roleplay-workflow-decision:' + turn); } catch { return null; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    const { hash, ...record } = saved;
    if (hash !== roleplayHash(record) || record.parentIntentHash !== roleplayHash(root.intent)
        || record.turn !== turn || record.decision?.kind !== 'swipe'
        || typeof record.decision?.textHash !== 'string') return null;
    return record;
}

/**
 * Whether the saved swipe decision rejected the whole accumulated reply rather
 * than only this turn's new alternative. The decision stores only a hash, so
 * compare every text the workflow could have passed to it: the prior accepted
 * text itself, the prior continuation suffix, and each of those with this
 * turn's selected or raw text. No character overlap is guessed.
 */
function rejectedAccumulatedOutput({ decision, prior, output, effect }) {
    if (!decision) return false;
    const selected = textOf(output, effect)?.text;
    const raw = typeof output?.text === 'string' ? output.text : '';
    const starts = [prior.text];
    const continuation = prior.continuation;
    if (continuation && typeof continuation.suffix === 'string') starts.push(continuation.suffix);
    const rejected = new Set(starts);
    for (const start of starts) {
        for (const tail of [selected, raw]) {
            if (typeof tail !== 'string' || !tail) continue;
            rejected.add(start + tail);
            if (tail.startsWith(start)) rejected.add(tail);
        }
    }
    return [...rejected].some(text => roleplayHash(text) === decision.decision.textHash);
}

/** A frozen display snapshot must be a plain, bounded, independent object. */
function previewAgentSnapshot(preview) {
    const value = preview?.inChatAgents;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    try {
        const cloned = structuredClone(value);
        return textBytes(JSON.stringify(cloned)) <= MAX_WITNESS_BYTES ? cloned : undefined;
    } catch {
        return undefined;
    }
}

const textBytes = text => Buffer.byteLength(text ?? '');
const isText = value => typeof value === 'string' && value.trim().length > 0 && textBytes(value) <= MAX_TEXT_BYTES;

function messageOf(output) {
    return output?.message ?? output?.messages?.[0] ?? output;
}

function textOf(output, effect) {
    const message = messageOf(output);
    if (effect === 'continue') {
        if (typeof output?.continuedText === 'string') return { text: output.continuedText, chunk: false };
        if (typeof output?.text === 'string') return { text: output.text, chunk: true };
        return null;
    }
    if (typeof message?.mes === 'string') return { text: message.mes, chunk: false };
    if (typeof output?.text === 'string') return { text: output.text, chunk: false };
    return null;
}

function extraOf(output) {
    return { ...(messageOf(output)?.extra ?? {}), ...(output?.extra ?? {}) };
}

function timingsOf(output) {
    const message = messageOf(output);
    const timings = {};
    for (const key of ['gen_started', 'gen_finished', 'send_date']) {
        if (typeof message?.[key] === 'string' && message[key]) timings[key] = message[key];
        else if (typeof output?.[key] === 'string' && output[key]) timings[key] = output[key];
    }
    return timings;
}

function cleanExtra(extra) {
    return Object.fromEntries(Object.entries(extra ?? {})
        .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'function'));
}

function readPreviewFor({ directories, owner, rootJobId, childJobId }) {
    if (typeof rootJobId !== 'string' || !rootJobId) return null;
    try {
        const preview = readRoleplayPreview({ owner, directories, job: { id: rootJobId } });
        if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
        // A group or multi-turn reply can be cancelled before its next child
        // publishes. The retained frame then still belongs to the previous
        // speaker, and must never be adopted as this child's text.
        if (preview.childId !== childJobId) return null;
        const text = typeof preview.text === 'string' && textBytes(preview.text) <= MAX_WITNESS_BYTES ? preview.text : '';
        return { ...preview, text };
    } catch {
        return null;
    }
}

function readSavedOutput({ directories, job }) {
    const output = readArtifact(directories, job.id, 'roleplay-output');
    return output && typeof output === 'object' && !Array.isArray(output) ? output : null;
}

function readCandidateOutput({ directories, job }) {
    const saved = readArtifact(directories, job.id, 'roleplay-candidate');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
    const { hash, ...content } = saved;
    if (hash !== roleplayHash(content) || content.intentHash !== roleplayHash(job.intent)) return null;
    return { hash, kind: content.kind, output: content.output };
}

function readAgentBaseText({ directories, job }) {
    const saved = readArtifact(directories, job.id, 'roleplay-agent-output-base');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)
        || saved.intentHash !== roleplayHash(job.intent) || typeof saved.value !== 'string') return '';
    const { hash, ...data } = saved;
    return hash === roleplayHash(data) ? saved.value : '';
}

function readProviderText({ directories, job }) {
    const reference = readArtifact(directories, job.id, 'roleplay-main-provider');
    if (reference?.intentHash !== roleplayHash(job.intent) || !/^provider:[a-f0-9]{64}$/.test(reference?.step ?? '')) return '';
    const completed = readArtifact(directories, job.id, reference.step);
    const result = job.intent?.request?.binding?.backend === 'horde' && completed?.id
        ? readArtifact(directories, job.id, 'horde-result:' + reference.step.slice(9)) : completed;
    return typeof result?.text === 'string' && isText(result.text) ? result.text : '';
}

function capturedFromOutput(output, effect, source) {
    const value = textOf(output, effect);
    if (!value || !isText(value.text)) return null;
    return { ...value, ...(effect === 'continue' && typeof output?.text === 'string' ? { rawChunk: output.text } : {}),
        source, reasoning: typeof extraOf(output).reasoning === 'string' ? extraOf(output).reasoning : '',
        extra: cleanExtra(extraOf(output)), timings: timingsOf(output),
        model: extraOf(output).model, api: extraOf(output).api,
        tokenCount: extraOf(output).token_count, reasoningTokens: extraOf(output).reasoning_tokens,
        reasoningDuration: extraOf(output).reasoning_duration };
}

function outputWasRefused(output) {
    return Boolean(messageOf(output)?.extra?.generation_outcome || output?.extra?.generation_outcome);
}

function sameSpeaker(value, speakerIndex) {
    const saved = value?.speakerIndex;
    if (Number.isSafeInteger(saved) || Number.isSafeInteger(speakerIndex)) return saved === speakerIndex;
    return true;
}

/**
 * The longest text the reply already produced, in order of authority: the
 * workflow's assembled turn, its candidate or finished output, the pre-Agent
 * main value, the paid provider result, then this child's display preview.
 * For a later automatic turn, the assembled text for this turn is the complete
 * reply; a failed turn combines the previous assembled text with its own chunk.
 */
export function collectRoleplayKeptReply({ directories, job, rootJobId = null }) {
    const effect = job.intent?.effect;
    const preview = readPreviewFor({ directories, owner: job.owner, rootJobId, childJobId: job.id });
    const candidate = readCandidateOutput({ directories, job });
    const candidateHash = candidate?.hash ?? null;
    const output = readSavedOutput({ directories, job }) ?? candidate?.output;
    let source = 'preview';
    let captured = null;
    if (output) {
        captured = capturedFromOutput(output, effect, 'output');
        if (captured) source = 'output';
    }
    if (!captured) {
        const base = readAgentBaseText({ directories, job });
        if (isText(base)) {
            source = 'main';
            captured = { text: base, chunk: false, reasoning: '', extra: {}, timings: {},
                model: undefined, api: undefined, tokenCount: undefined, reasoningTokens: undefined, reasoningDuration: undefined };
        }
    }
    if (!captured) {
        const provider = readProviderText({ directories, job });
        if (provider) {
            source = 'provider';
            captured = { text: provider, chunk: effect === 'continue', reasoning: '', extra: {}, timings: {},
                model: undefined, api: undefined, tokenCount: undefined, reasoningTokens: undefined, reasoningDuration: undefined };
        }
    }
    if (!captured && preview && isText(preview.text)) {
        source = 'preview';
        const inChatAgents = previewAgentSnapshot(preview);
        const extra = cleanExtra({ reasoning: preview.reasoning, reasoning_duration: preview.reasoning_duration,
            reasoning_tokens: preview.reasoning_tokens, token_count: preview.token_count, model: preview.generation?.model,
            api: preview.generation?.source, ...(inChatAgents ? { inChatAgents } : {}) });
        captured = { text: preview.text, chunk: effect === 'continue', reasoning: preview.reasoning || '',
            extra, timings: { ...(preview.gen_started ? { gen_started: preview.gen_started } : {}),
                ...(preview.gen_finished ? { gen_finished: preview.gen_finished } : {}) },
            model: preview.generation?.model, api: preview.generation?.source,
            tokenCount: preview.token_count, reasoningTokens: preview.reasoning_tokens,
            reasoningDuration: preview.reasoning_duration };
    }
    if (captured && preview) {
        // The display preview carries reasoning and response metadata even
        // when the saved main value is only text.
        if (!captured.reasoning && typeof preview.reasoning === 'string') captured.reasoning = preview.reasoning;
        if (!captured.timings.gen_started && preview.gen_started) captured.timings = { ...captured.timings, gen_started: preview.gen_started };
        if (!captured.timings.gen_finished && preview.gen_finished) captured.timings = { ...captured.timings, gen_finished: preview.gen_finished };
        if (captured.model === undefined) captured.model = preview.generation?.model;
        if (captured.api === undefined) captured.api = preview.generation?.source;
        if (captured.tokenCount === undefined) captured.tokenCount = preview.token_count;
        if (captured.reasoningTokens === undefined) captured.reasoningTokens = preview.reasoning_tokens;
        if (captured.reasoningDuration === undefined) captured.reasoningDuration = preview.reasoning_duration;
    }

    const marker = job.intent?.request?.workflowCandidate;
    const turn = marker ? (Number.isSafeInteger(marker.turn) ? marker.turn : 0) : null;
    const speakerIndex = marker?.speakerIndex;
    const currentAssembled = Number.isSafeInteger(turn)
        ? readWorkflowReplyText({ directories, rootJobId, turn }) : null;
    const priorAssembled = Number.isSafeInteger(turn) && turn > 0
        ? readWorkflowReplyText({ directories, rootJobId, turn: turn - 1 }) : null;
    const usable = value => value?.selected && sameSpeaker(value, speakerIndex) && isText(value.text)
        && !outputWasRefused(value.output);
    const continuationOf = value => {
        const continuation = value?.continuation;
        return continuation && typeof continuation.prefix === 'string' && typeof continuation.suffix === 'string'
            ? continuation : null;
    };
    // A decision of `swipe` rejects this candidate on purpose. Its raw text is
    // an alternative that was never selected and must not become the reply.
    const currentRejected = currentAssembled?.selected === false;
    if (currentRejected) {
        // Drop the rejected alternative itself, but keep the last accepted
        // automatic-continuation step when this turn alone was discarded.
        captured = null;
        if (!usable(priorAssembled)) return null;
        const decision = readWorkflowDecision({ directories, rootJobId, turn });
        if (rejectedAccumulatedOutput({ decision, prior: priorAssembled, output, effect })) return null;
    }
    if (usable(currentAssembled)) {
        const capturedTurn = capturedFromOutput(currentAssembled.output, effect, 'assembled');
        const continuation = continuationOf(currentAssembled);
        captured = continuation
            ? { ...capturedTurn, text: continuation.prefix + continuation.suffix, chunk: false }
            : { ...capturedTurn, chunk: currentAssembled.chunk === true };
        source = 'assembled';
    } else if (usable(priorAssembled)) {
        const priorContinuation = continuationOf(priorAssembled);
        if (!captured || outputWasRefused(output)) {
            const capturedPrior = capturedFromOutput(priorAssembled.output, effect, 'assembled-prior');
            captured = priorContinuation
                ? { ...capturedPrior, text: priorContinuation.prefix + priorContinuation.suffix, chunk: false }
                : { ...capturedPrior, chunk: priorAssembled.chunk === true };
            source = 'assembled-prior';
        } else if (isText(captured.text)) {
            if (priorContinuation) {
                const priorFull = priorContinuation.prefix + priorContinuation.suffix;
                let suffix = null;
                if (captured.chunk === true) suffix = captured.text;
                else if (captured.text.startsWith(priorFull)) {
                    // A full Agent output can already contain every accepted
                    // turn, even before this turn's decision is recorded.
                    suffix = captured.text.slice(priorFull.length);
                } else if (captured.text.startsWith(priorContinuation.prefix)) {
                    suffix = captured.text.slice(priorContinuation.prefix.length);
                } else if (typeof captured.rawChunk === 'string') suffix = captured.rawChunk;
                captured = suffix === null
                    ? { ...captured, text: captured.text.startsWith(priorFull) ? captured.text : priorFull }
                    : { ...captured, text: priorFull + suffix, chunk: false };
            } else if (priorAssembled.chunk === true && captured.chunk === true) {
                // Both saved parts are continuation chunks. Concatenate them
                // literally and keep them as a chunk so placement adds the
                // message prefix exactly once.
                captured = { ...captured, text: priorAssembled.text + captured.text, chunk: true };
            } else if (priorAssembled.chunk === true && typeof captured.rawChunk === 'string') {
                // A full Agent continuedText repeats the original message
                // prefix. Append this turn's raw chunk and let placement add
                // that authoritative prefix once.
                captured = { ...captured, text: priorAssembled.text + captured.rawChunk, chunk: true };
            } else if (priorAssembled.chunk === true) {
                const suffix = captured.text.startsWith(priorAssembled.text)
                    ? captured.text.slice(priorAssembled.text.length) : null;
                captured = suffix === null
                    ? { ...captured, chunk: false }
                    : { ...captured, text: priorAssembled.text + suffix, chunk: true };
            } else {
                // Both sides are full representations. Only adopt current when
                // it already contains the earlier text; otherwise append this
                // turn's raw chunk instead of repeating a guessed overlap.
                if (!captured.text.startsWith(priorAssembled.text)) {
                    captured = typeof captured.rawChunk === 'string'
                        ? { ...captured, text: priorAssembled.text + captured.rawChunk, chunk: false }
                        : { ...captured, text: priorAssembled.text + captured.text, chunk: false };
                }
            }
        }
    }
    if (!captured) return null;
    const displayPreview = currentRejected ? null : preview;
    const witness = displayPreview?.text && textBytes(displayPreview.text) <= MAX_WITNESS_BYTES ? displayPreview.text : '';
    const capturedAgents = captured.extra?.inChatAgents;
    const missingAgents = !(capturedAgents && Array.isArray(capturedAgents.nativeRegexScripts)) && displayPreview
        ? previewAgentSnapshot(displayPreview) : undefined;
    return { ...captured, source, witness, candidateHash,
        name: typeof preview?.name === 'string' && preview.name ? preview.name : job.intent?.request?.characterName || 'Reply',
        avatar: typeof preview?.avatar === 'string' && preview.avatar ? preview.avatar
            : job.intent?.request?.worldInfo?.avatar || '',
        reasoning: typeof captured.reasoning === 'string' ? captured.reasoning : '',
        extra: cleanExtra({ ...(captured.extra && typeof captured.extra === 'object' ? captured.extra : {}),
            ...(missingAgents ? { inChatAgents: missingAgents } : {}),
            ...(captured.reasoning ? { reasoning: captured.reasoning } : {}),
            ...(captured.reasoningDuration !== undefined ? { reasoning_duration: captured.reasoningDuration } : {}),
            ...(captured.tokenCount !== undefined ? { token_count: captured.tokenCount } : {}),
            ...(captured.reasoningTokens !== undefined ? { reasoning_tokens: captured.reasoningTokens } : {}),
            ...(captured.model ? { model: captured.model } : {}), ...(captured.api ? { api: captured.api } : {}) }),
    };
}

/**
 * Record that the paid main reply finished, before optional postprocessing can
 * hold it. The stop endpoint uses this record to turn a late Stop into a soft
 * stop instead of cancelling a completed main reply.
 */
export function recordRoleplayMainReplyComplete(context, output) {
    const { directories, job } = context;
    const message = messageOf(output);
    const value = { version: 1, intentHash: roleplayHash(job.intent), at: new Date().toISOString(),
        outputHash: roleplayHash(output), textHash: roleplayHash(typeof message?.mes === 'string' ? message.mes
            : typeof output?.text === 'string' ? output.text : '') };
    const saved = readArtifact(directories, job.id, MAIN_COMPLETE_ARTIFACT);
    if (saved !== undefined) {
        if (saved?.version !== 1 || saved.intentHash !== value.intentHash) {
            throw roleplayError('ROLEPLAY_RECOVERY_REQUIRED', 'The saved completed reply marker changed.', 503);
        }
        // A resumed or retried pass may reconstruct the same paid main reply
        // with different postprocessing evidence. Refresh only its text proof.
        if (saved.textHash !== value.textHash) writeArtifact(directories, job.id, MAIN_COMPLETE_ARTIFACT, value);
        return value;
    }
    writeArtifact(directories, job.id, MAIN_COMPLETE_ARTIFACT, value);
    return value;
}

function keptMarker({ reason, rootJobId, childJobId, textHash }) {
    return { version: 1, reason, rootJobId, childJobId, textHash };
}

function sameMarker(marker, identity) {
    return marker?.version === 1 && marker.rootJobId === identity.rootJobId
        && marker.childJobId === identity.childJobId;
}

function markedElsewhere(message, identity) {
    const direct = message?.extra?.roleplay_kept_reply;
    if (sameMarker(direct, identity)) return direct;
    // The ordinary workflow write carries the same root/child identity, so a
    // keeper that runs after an uncertain publication never adds a second copy.
    const workflow = message?.extra?.roleplay_workflow_reply;
    if (workflow?.version === 1 && workflow.rootJobId === identity.rootJobId
        && workflow.childJobId === identity.childJobId) return workflow;
    for (const info of Array.isArray(message?.swipe_info) ? message.swipe_info : []) {
        const kept = info?.extra?.roleplay_kept_reply;
        if (sameMarker(kept, identity)) return kept;
        const written = info?.extra?.roleplay_workflow_reply;
        if (written?.version === 1 && written.rootJobId === identity.rootJobId
            && written.childJobId === identity.childJobId) return written;
    }
    return null;
}

function isModelRecord(record) {
    return Boolean(record) && record.is_user !== true && record.is_system !== true;
}

/**
 * Whether a saved message carries this reply's own generation start. Text alone
 * is never enough: an unrelated model message can be identical or share a long
 * opening, and must be preserved beside the reply rather than mistaken for it.
 */
function isWitnessed(reply, message) {
    return Boolean(reply.witness) && typeof message === 'object' && Boolean(message)
        && typeof message.gen_started === 'string' && typeof reply.timings?.gen_started === 'string'
        && message.gen_started === reply.timings.gen_started;
}

function appendRecord(records, reply, identity) {
    const extra = cleanExtra({ ...reply.extra, ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
        ...(reply.reasoningDuration !== undefined ? { reasoning_duration: reply.reasoningDuration } : {}) });
    const userMessage = reply.userAlternative === true;
    const message = { name: userMessage ? reply.userName || records[0]?.user_name || 'User' : reply.name,
        is_user: userMessage, mes: reply.text, send_date: new Date().toISOString(),
        ...reply.timings, extra: { ...extra, roleplay_kept_reply: keptMarker(identity) } };
    if (reply.group && !userMessage) {
        if (reply.avatar) {
            message.original_avatar = reply.avatar;
            message.force_avatar = reply.avatar;
        }
        message.extra.gen_id = reply.group.generationId;
    }
    records.push(message);
    return { index: records.length - 2, placement: 'append' };
}

function extendRecord(records, record, index, reply, identity, { swipe = false, select = true } = {}) {
    const extra = cleanExtra({ ...record.extra, ...reply.extra, ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
        ...(reply.reasoningDuration !== undefined ? { reasoning_duration: reply.reasoningDuration } : {}) });
    const marker = keptMarker(identity);
    if (swipe) {
        const swipes = Array.isArray(record.swipes) && record.swipes.length ? [...record.swipes] : [record.mes];
        const info = Array.isArray(record.swipe_info) ? structuredClone(record.swipe_info.slice(0, swipes.length)) : [];
        while (info.length < swipes.length) info.push({});
        let selected = isWitnessed(reply, record) ? swipes.findIndex(value => value === reply.text) : -1;
        if (selected < 0) selected = swipes.findIndex(value => typeof value === 'string'
            && isWitnessed(reply, record) && value.startsWith(reply.witness)
            && (reply.text.startsWith(value) || value.startsWith(reply.text)));
        if (selected < 0) {
            swipes.push(reply.text);
            info.push({ ...reply.timings, extra: { ...extra, roleplay_kept_reply: marker } });
            selected = swipes.length - 1;
        } else {
            // Never shorten a longer saved tail from the same reply.
            const value = swipes[selected];
            if (!value || value.length < reply.text.length) swipes[selected] = reply.text;
            info[selected] = { ...info[selected], ...reply.timings,
                extra: { ...(info[selected]?.extra ?? {}), ...extra, roleplay_kept_reply: marker } };
        }
        record.swipes = swipes;
        record.swipe_info = info;
        if (select) {
            record.swipe_id = selected;
            record.mes = swipes[selected];
            Object.assign(record, reply.timings);
        }
        record.extra = { ...record.extra, ...extra, roleplay_kept_reply: marker };
        return { index, placement: 'swipe' };
    }
    // A continuation extends its own message; a longer saved tail is kept.
    const currentText = typeof record.mes === 'string' ? record.mes : '';
    if (currentText.length <= reply.text.length) record.mes = reply.text;
    Object.assign(record, reply.timings);
    const selected = Number(record.swipe_id ?? 0);
    if (Array.isArray(record.swipes) && record.swipes.length && Number.isSafeInteger(selected)
        && selected >= 0 && selected < record.swipes.length
        && (typeof record.swipes[selected] !== 'string' || record.swipes[selected].length <= reply.text.length)) {
        record.swipes[selected] = record.mes;
    }
    record.extra = { ...record.extra, ...extra, roleplay_kept_reply: marker };
    return { index, placement: 'continue' };
}

function adoptRecord(records, record, index, placement) {
    // The chat already holds this exact reply, from this same job or from an
    // older page. Never touch it, and never append a second copy.
    return { index, placement: placement === 'swipe' ? 'swipe' : placement, unchanged: true };
}

function placeReply(records, reply, intent, identity) {
    const effect = intent.effect;
    const targetIndex = Number.isSafeInteger(intent.source?.message?.index) ? intent.source.message.index
        : Number.isSafeInteger(intent.source?.range?.start) ? intent.source.range.start : null;
    if (effect === 'append' || targetIndex === null) {
        const last = records.at(-1);
        if (isModelRecord(last)) {
            const marked = markedElsewhere(last, identity);
            if (marked) return adoptRecord(records, last, records.length - 2, 'append');
            // An older page saved this same reply itself. Only the final model
            // message is compared, and only with evidence from this reply's own
            // preview, so unrelated similar prose is never suppressed.
            if (typeof last.mes === 'string' && isWitnessed(reply, last)
                && last.mes.startsWith(reply.witness)
                && (last.mes === reply.text || reply.text.startsWith(last.mes) || last.mes.startsWith(reply.text))) {
                if (last.mes.startsWith(reply.text) && last.mes.length > reply.text.length) {
                    return adoptRecord(records, last, records.length - 2, 'append');
                }
                return extendRecord(records, last, records.length - 2, reply, identity);
            }
            if (last.mes === reply.text && isWitnessed(reply, last)) {
                return adoptRecord(records, last, records.length - 2, 'append');
            }
        }
        return appendRecord(records, reply, identity);
    }
    const record = records[targetIndex + 1];
    const marked = record && markedElsewhere(record, identity);
    if (marked) return adoptRecord(records, record, targetIndex, effect === 'continue' ? 'continue' : 'swipe');
    if (!isModelRecord(record) && !(reply.userAlternative && record?.is_user === true)) {
        // A deleted or replaced target is never recreated or overwritten. An
        // unsupported user alternative keeps its role rather than becoming a
        // character message.
        return appendRecord(records, reply, identity);
    }
    if (effect === 'continue') {
        const unchanged = intent.source?.message?.recordHash
            && roleplayHash(record) === intent.source.message.recordHash;
        if (!unchanged) return appendRecord(records, reply, identity);
        const prefix = String(record.mes ?? '');
        const full = reply.chunk ? prefix + reply.text : reply.text;
        if (full === prefix) return { index: targetIndex, placement: 'empty' };
        if (full.startsWith(prefix)) {
            if (record.mes === full) return adoptRecord(records, record, targetIndex, 'continue');
            if (record.mes.length > prefix.length) {
                // Someone already saved a partial or longer tail. Keep the
                // longer copy; only extend when the saved text is a prefix.
                if (record.mes.startsWith(full) && record.mes.length > full.length) {
                    return adoptRecord(records, record, targetIndex, 'continue');
                }
                if (!full.startsWith(record.mes)) return appendRecord(records, { ...reply, text: full, chunk: false }, identity);
            }
            return extendRecord(records, record, targetIndex, { ...reply, text: full, chunk: false }, identity);
        }
        // The user edited the original message; append the generated text
        // instead of replacing what they wrote.
        return appendRecord(records, { ...reply, text: full, chunk: false }, identity);
    }
    return extendRecord(records, record, targetIndex, reply, identity, { swipe: true, select: effect !== 'alternative' });
}

function keptReplySummary(value) {
    if (!value || value.version !== 1) return null;
    return { state: value.state, reason: value.reason ?? null, messageIndex: value.messageIndex ?? null,
        textHash: value.textHash ?? null, committedAt: value.committedAt ?? null,
        ...(value.error ? { error: value.error } : {}) };
}

/** Receipt readback: the owner's page learns that the server already kept the text. */
export function readRoleplayKeptReply({ directories, jobId }) {
    if (typeof jobId !== 'string' || !jobId) return null;
    const read = id => {
        try { return keptReplySummary(readArtifact(directories, id, KEPT_REPLY_ARTIFACT)); } catch { return null; }
    };
    const own = read(jobId);
    if (own) return own;
    try {
        const job = getJob(directories, jobId);
        for (const id of [...(job?.children ?? [])].reverse()) {
            const child = read(id);
            if (child) return child;
        }
    } catch { /* A pruned root has no children to read. */ }
    return null;
}

/**
 * True while a terminal workflow root still has a running child or a keeper
 * record that has not finished its chat write. A page that reads the receipt
 * during this window must wait rather than decide the reply is already kept.
 */
export function roleplayKeptReplyPending({ directories, jobId }) {
    if (typeof jobId !== 'string' || !jobId) return false;
    let job;
    try { job = getJob(directories, jobId); } catch { return false; }
    if (!job) return false;
    for (const id of job.children ?? []) {
        let child;
        try { child = getJob(directories, id); } catch { continue; }
        if (child && !TERMINAL_STATES.includes(child.state)) return true;
    }
    for (const id of [job.id, ...(job.children ?? [])]) {
        try {
            const value = readArtifact(directories, id, KEPT_REPLY_ARTIFACT);
            if (value?.state === 'captured' || value?.state === 'writing') return true;
        } catch { /* An unreadable record cannot claim to be pending. */ }
    }
    return false;
}

function failureOf(error) {
    return { message: error?.message ?? 'The stopped reply could not be saved.', code: error?.code ?? null,
        status: typeof error?.status === 'number' ? error.status : null };
}

function replyIdentity({ job, rootJobId, intentHash, reason, text, previewText }) {
    return { version: 1, state: 'captured', jobId: job.id, rootJobId, intentHash, reason,
        text, textHash: roleplayHash(text), previewText: previewText ?? '',
        account: { accountId: job.intent.roleplay.accountId, dataEpoch: job.intent.roleplay.dataEpoch },
        createdAt: new Date().toISOString() };
}

function capturedValue(value) {
    if (!value || value.version !== 1 || typeof value.text !== 'string' || !value.text.trim()) return null;
    return value;
}

function existingText(value, reply) {
    if (!capturedValue(value)) return reply;
    return { ...reply, text: value.text, witness: typeof value.previewText === 'string' ? value.previewText : reply.witness };
}

/** Rebuild a reply from the durable keeper record when its preview is gone. */
function replyFromKeeperRecord(value) {
    if (!capturedValue(value)) return null;
    return { text: value.text, chunk: value.chunk === true, source: value.source ?? 'captured',
        witness: typeof value.previewText === 'string' ? value.previewText : '',
        name: typeof value.name === 'string' && value.name ? value.name : 'Reply',
        avatar: typeof value.avatar === 'string' ? value.avatar : '',
        reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
        extra: value.extra && typeof value.extra === 'object' ? value.extra : {},
        timings: value.timings && typeof value.timings === 'object' ? value.timings : {},
        ...(typeof value.candidateHash === 'string' ? { candidateHash: value.candidateHash } : {}) };
}

function isPendingWriteError(error) {
    return error?.roleplayWritePending === true
        || ['ROLEPLAY_RECOVERY_REQUIRED', 'ROLEPLAY_STORE_UNCERTAIN', 'ROLEPLAY_WRITE_UNCERTAIN']
            .includes(String(error?.code ?? ''));
}


function rootJobFor({ directories, job, rootJobId }) {
    if (rootJobId && rootJobId !== job.id) {
        try {
            const root = getJob(directories, rootJobId);
            if (root) return root;
        } catch { /* The keeper still owns the identity it carries. */ }
    }
    return job;
}

function rootGroup({ directories, job, rootJobId }) {
    return rootJobFor({ directories, job, rootJobId })?.intent?.request?.group ?? null;
}

function rootNamed({ directories, job, rootJobId }) {
    return rootJobFor({ directories, job, rootJobId })?.intent?.request?.named ?? job.intent?.request?.named ?? null;
}

/**
 * Keep one reply at most once. Returns the keeper record, or null when there is
 * nothing to keep. A chat-write refusal is reported, never thrown, so the
 * original job failure stays the caller's error.
 */
export function keepRoleplayReply(context, { reason = 'stopped', rootJobId = null } = {}) {
    const { directories, owner } = context;
    const job = getJob(directories, context.job.id) ?? context.job;
    if (!job || job.owner !== owner || !REPLAY_JOB_TYPES.has(job.type)) return null;
    const intent = job.intent ?? {};
    const account = intent.roleplay;
    if (!account || !intent.source || !intent.effect) return null;
    const effectiveRoot = intent.request?.workflowCandidate?.parentJobId || job.id;
    const root = typeof rootJobId === 'string' && rootJobId ? rootJobId : effectiveRoot;
    const identity = roleplayHash(job.intent);
    let saved = null;
    try { saved = readArtifact(directories, job.id, KEPT_REPLY_ARTIFACT); } catch { saved = null; }
    if (saved?.state === 'done' || saved?.state === 'failed') return keptReplySummary(saved);
    // A pending durable record is authoritative. The preview may be gone after
    // a restart, but the captured text, reasoning and presentation identity are
    // already on disk and must still become the keeper write.
    const pendingRecord = saved?.state === 'captured' || saved?.state === 'writing' ? saved : null;
    let collected;
    if (pendingRecord) {
        collected = replyFromKeeperRecord(pendingRecord);
        const keeperOperation = `roleplay-kept:${job.id}`;
        try {
            const reconciled = reconcileRoleplayChatWriteIfPending({ owner, directories,
                accountId: account.accountId, dataEpoch: account.dataEpoch }, keeperOperation, roleplayNativeHost);
            if (reconciled) {
                const done = { ...pendingRecord, state: 'done', placement: pendingRecord.placement ?? 'reconciled',
                    messageIndex: pendingRecord.messageIndex ?? null, committedAt: new Date().toISOString(),
                    writeId: reconciled.writeId ?? null, revision: reconciled.revision ?? null };
                writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, done);
                return keptReplySummary(done);
            }
        } catch (error) {
            // The matching unfinished write is still uncertain. Leave the
            // keeper record pending instead of declaring the text lost.
            const pending = { ...pendingRecord, state: 'writing', error: failureOf(error) };
            try { writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, pending); } catch { /* The captured text remains. */ }
            return keptReplySummary(pending);
        }
    } else {
        collected = collectRoleplayKeptReply({ directories, job, rootJobId: root });
    }
    if (!collected) {
        // Nothing paid and nothing shown: a refusal, an empty stop or a wait
        // before the first token. Do not invent a chat message.
        return null;
    }
    if (collected.extra?.generation_outcome) return null;
    let record = existingText(saved, collected);
    if (!isText(record.text)) return null;
    if (intent.effect === 'continue' && record.chunk && record.text.trim() === '') return null;
    const captured = { ...replyIdentity({ job, rootJobId: root, intentHash: identity, reason,
        text: record.text, previewText: record.witness }), source: record.source,
    name: record.name, avatar: record.avatar, reasoning: record.reasoning,
    extra: record.extra, timings: record.timings, chunk: record.chunk === true,
    ...(record.candidateHash ? { candidateHash: record.candidateHash } : {}) };
    try {
        if (!saved) writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, captured);
        else if (saved.state !== 'captured' && saved.state !== 'writing') writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, captured);
    } catch (error) {
        return { state: 'failed', reason, messageIndex: null, error: failureOf(error) };
    }
    let result;
    try {
        result = withRoleplayAccount({ owner, directories }, account, lease => {
            const latest = readArtifact(directories, job.id, KEPT_REPLY_ARTIFACT) ?? captured;
            if (latest.state === 'done' || latest.state === 'failed') return keptReplySummary(latest);
            const reply = existingText(latest, record);
            if (!isText(reply.text)) return null;
            const { state } = roleplayLease(lease);
            const resource = state.resources[intent.source.instanceId];
            if (resource?.status !== 'live' || resource.accountId !== state.accountId
                || resource.dataEpoch !== state.dataEpoch) {
                throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The chat this reply belongs to no longer exists.', 404);
            }
            const capturedSource = captureRoleplayStorageSourceLocked(lease, resource.locator);
            const records = structuredClone(capturedSource.saved.records);
            const group = rootGroup({ directories, job, rootJobId: root });
            const speakerIndex = intent.request?.workflowCandidate?.speakerIndex;
            const speaker = Number.isSafeInteger(speakerIndex) ? group?.speakers?.[speakerIndex] : null;
            const avatar = intent.request?.worldInfo?.avatar || speaker?.avatar || reply.avatar || '';
            const named = rootNamed({ directories, job, rootJobId: root });
            const placed = placeReply(records, { ...reply, group, avatar,
                userAlternative: named?.name === 'deep-swipe.user',
                userName: capturedSource.saved.records[0]?.user_name || '' }, intent, {
                reason, rootJobId: root, childJobId: job.id, textHash: '' });
            if (placed.placement === 'empty') return null;
            const present = records[placed.index + 1];
            const presentText = typeof present?.mes === 'string' ? present.mes : reply.text;
            if (placed.unchanged) {
                // The chat already held this exact reply. Record the keeper
                // result without rewriting or re-marking the user's saved text.
                const done = { ...latest, state: 'done', messageIndex: placed.index, placement: placed.placement,
                    textHash: roleplayHash(presentText), committedAt: new Date().toISOString() };
                writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, done);
                return keptReplySummary(done);
            }
            const rootJob = root === job.id ? job : getJob(directories, root);
            const capacityLimit = rootJob?.intent?.request?.capacity?.limitBytes;
            if (Number.isSafeInteger(capacityLimit) && capacityLimit > 0
                && Buffer.byteLength(records.map(record => JSON.stringify(record)).join('\n')) > capacityLimit) {
                throw roleplayError('ROLEPLAY_WORKFLOW_CAPACITY',
                    'The stopped reply does not fit the protected chat capacity.', 507);
            }
            const kept = present;
            const keptText = presentText;
            const marker = keptMarker({ reason, rootJobId: root, childJobId: job.id, textHash: roleplayHash(keptText) });
            if (kept?.extra) kept.extra = { ...kept.extra, roleplay_kept_reply: marker };
            if (Array.isArray(kept?.swipe_info) && Number.isInteger(kept.swipe_id) && kept.swipe_info[kept.swipe_id]) {
                const info = kept.swipe_info[kept.swipe_id];
                kept.swipe_info[kept.swipe_id] = { ...info, extra: { ...(info?.extra ?? {}), roleplay_kept_reply: marker } };
            }
            const writing = { ...latest, state: 'writing', messageIndex: placed.index, placement: placed.placement,
                textHash: roleplayHash(keptText), committedAt: null };
            writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, writing);
            try {
                const committed = commitSingleChatWriteLocked(lease, { operationKey: `roleplay-kept:${job.id}`,
                    mode: 'update', sourceKind: 'storage', source: capturedSource.source, records,
                    backup: { deferBackup: true } }, roleplayNativeHost);
                const done = { ...writing, state: 'done', committedAt: new Date().toISOString(),
                    messageIndex: placed.index, placement: placed.placement,
                    writeId: committed.writeId ?? null, revision: committed.revision ?? null };
                writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, done);
                return keptReplySummary(done);
            } catch (error) {
                if (isPendingWriteError(error)) {
                    // The account still owns an uncertain write. Leave the
                    // keeper record pending so recovery can finish or adopt it.
                    const pending = { ...writing, state: 'writing', error: failureOf(error) };
                    try { writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, pending); } catch { /* The captured text remains. */ }
                    return keptReplySummary(pending);
                }
                const failed = { ...writing, state: 'failed', error: failureOf(error) };
                try { writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, failed); } catch { /* The captured text remains. */ }
                console.warn('[Roleplay] The stopped reply could not be saved to its chat.', error?.message ?? error);
                return keptReplySummary(failed);
            }
        });
    } catch (error) {
        // An unfinished account write or recovery block is not a permanent
        // failure. Keep the captured text pending so the next recovery or
        // receipt read can finish it.
        if (isPendingWriteError(error)) {
            const pending = { ...(saved ?? captured), state: 'writing', error: failureOf(error) };
            try { writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, pending); } catch { /* The captured text remains. */ }
            return keptReplySummary(pending);
        }
        // The account lock itself was refused for another reason (changed
        // account, damaged store). Keep the captured copy and report why.
        const failed = { ...captured, state: 'failed', error: failureOf(error) };
        try { writeArtifact(directories, job.id, KEPT_REPLY_ARTIFACT, failed); } catch { /* The captured text remains. */ }
        return keptReplySummary(failed);
    }
    return result ?? null;
}

function workflowPriorText({ directories, job, rootJobId }) {
    const marker = job.intent?.request?.workflowCandidate;
    const turn = marker?.turn;
    const speakerIndex = marker?.speakerIndex;
    if (!Number.isSafeInteger(turn) || turn < 1) return null;
    const prior = readWorkflowReplyText({ directories, rootJobId, turn: turn - 1 });
    if (!prior?.selected || !sameSpeaker(prior, speakerIndex) || !isText(prior.text)) return null;
    return prior;
}

function isToolTurnOnly({ directories, job }) {
    const candidate = readArtifactSafe(directories, job.id, 'roleplay-candidate');
    return candidate?.kind === 'tool-turn'
        && readArtifactSafe(directories, job.id, 'roleplay-output') === undefined;
}


function parentPublication({ directories, owner, rootJob, candidateHash }) {
    if (!rootJob || !candidateHash) return { state: 'unknown' };
    try {
        return { state: withNativeMediaReceipt({ owner, directories, job: rootJob }, ({ value }) => {
            const effects = Object.values(value.effects ?? {}).filter(effect => effect?.candidateHash === candidateHash);
            if (effects.some(effect => effect.state === 'writing')) return 'writing';
            if (effects.some(effect => effect.state === 'done')) return 'done';
            return 'none';
        }, { checkSource: false }) };
    } catch {
        return { state: 'unknown' };
    }
}

/**
 * Finish a keeper record left between capture and commit, or adopt the message a
 * completed keeper or ordinary publication already wrote. A normal publication
 * with a `writing` effect keeps ownership, so reconciliation does nothing.
 */
export function reconcileRoleplayKeptReply({ directories, owner, jobId }) {
    const job = getJob(directories, jobId);
    if (!job || job.owner !== owner || !TERMINAL_STATES.includes(job.state)) return null;
    let saved;
    try { saved = readArtifact(directories, jobId, KEPT_REPLY_ARTIFACT); } catch { return null; }
    if (saved?.state !== 'captured' && saved?.state !== 'writing') return keptReplySummary(saved);
    const rootJobId = job.intent?.request?.workflowCandidate?.parentJobId ?? job.id;
    const candidate = rootJobId !== job.id ? readArtifactSafe(directories, job.id, 'roleplay-candidate') : null;
    const candidateHash = saved.candidateHash ?? candidate?.hash ?? null;
    const rootJob = rootJobId !== job.id ? getJob(directories, rootJobId) : null;
    const publication = parentPublication({ directories, owner, rootJob, candidateHash });
    if (publication.state === 'writing') return keptReplySummary(saved);
    if (publication.state === 'done') {
        const done = { ...saved, state: 'done', placement: 'published', messageIndex: null,
            committedAt: new Date().toISOString(), published: true };
        writeArtifact(directories, jobId, KEPT_REPLY_ARTIFACT, done);
        return keptReplySummary(done);
    }
    return keepRoleplayReply({ owner, directories, job },
        { reason: saved.reason ?? (job.cancellation?.requested ? 'stopped' : 'failed'), rootJobId });
}

/** Reconcile a workflow root and every child that has a pending keeper record. */
export function reconcileRoleplayKeptReplyFamily({ directories, owner, jobId }) {
    const job = getJob(directories, jobId);
    if (!job) return null;
    let summary = null;
    for (const id of [job.id, ...(job.children ?? [])]) {
        const value = reconcileRoleplayKeptReply({ directories, owner, jobId: id });
        if (value) summary = value;
    }
    return summary;
}

/** Start-up recovery entry point; only pending keeper records do any work. */
export function reconcileRoleplayKeptReplies({ directories, hold = false, owner = null }) {
    if (hold) return 0;
    let jobs;
    try { jobs = listJobs(directories, owner ? { owner, includeDismissed: true } : { includeDismissed: true }); } catch { return 0; }
    let reconciled = 0;
    for (const job of jobs) {
        if (!REPLAY_JOB_TYPES.has(job.type) || !TERMINAL_STATES.includes(job.state)) continue;
        let saved;
        try { saved = readArtifact(directories, job.id, KEPT_REPLY_ARTIFACT); } catch { continue; }
        if (saved?.state !== 'captured' && saved?.state !== 'writing') continue;
        try {
            reconcileRoleplayKeptReply({ directories, owner: job.owner, jobId: job.id });
            reconciled += 1;
        } catch (error) {
            console.warn('[Roleplay] A saved stopped reply still needs reconciliation.', error?.message ?? error);
        }
    }
    return reconciled;
}

registerJobRecoveryLifecycle((directories, { hold = false } = {}) => reconcileRoleplayKeptReplies({ directories, hold }));

/** The reply job's own terminal failure: keep what was paid or streamed. */
export function preserveInterruptedRoleplayReply(context, error) {
    const job = getJob(context.directories, context.job.id) ?? context.job;
    if (!job || !REPLAY_JOB_TYPES.has(job.type)) return null;
    if (job.intent?.effect === 'caption' || job.intent?.effect === 'agent' || job.intent?.effect === 'notebook') return null;
    if (isToolTurnOnly({ directories: context.directories, job })) return null;
    const code = String(error?.code ?? '');
    if (code.startsWith('MEWMORY_WAIT_')) return null;
    // A refused proof or an uncertain write stays a protected recovery: the
    // saved main text is in job history, and only the normal retry may deliver
    // it with its proof.
    const protectedRecovery = ['ROLEPLAY_AGENT_RECOVERY', 'ROLEPLAY_WORKFLOW_RECOVERY', 'ROLEPLAY_RECOVERY_REQUIRED',
        'ROLEPLAY_STORE_UNCERTAIN', 'ROLEPLAY_WRITE_UNCERTAIN'].includes(code)
        && !(job.cancellation?.requested && code === 'ROLEPLAY_WORKFLOW_RECOVERY');
    if (protectedRecovery) return null;
    let blocked = code === 'GENERATION_BLOCKED' || code === 'ROLEPLAY_BLOCKED_RECOVERY';
    try {
        if (readArtifact(context.directories, job.id, 'roleplay-blocked-output') !== undefined) blocked = true;
    } catch { /* A missing artifact is the ordinary case. */ }
    // An abort without a durable cancellation is a server restart or shutdown,
    // not the owner stopping this reply. Its job history and Retry stay.
    if (context.signal?.aborted && !job.cancellation?.requested) return null;
    // A restart-interrupted job is retryable and its paid request must remain
    // in job history. Only a live owner stop or a live failure keeps text now.
    if (!job.cancellation?.requested && (job.recoverability === 'needs-retry'
        || job.state === 'interrupted')) return null;
    const rootJobId = job.intent?.request?.workflowCandidate?.parentJobId ?? job.id;
    const prior = workflowPriorText({ directories: context.directories, job, rootJobId });
    // A refusal with no earlier completed turn has no paid text to keep. With
    // one, the accepted prefix survives and the refused chunk is not written.
    if (blocked && !prior) return null;
    // A saved delivery proof can be replayed by the ordinary finish path, so a
    // plain worker failure is Retry, not a kept partial.
    if (!blocked && !job.cancellation?.requested && !isDeliveryConflict(error)
        && hasSavedDeliveryProof(context.directories, job)) return null;
    return keepRoleplayReply({ ...context, job }, { reason: job.cancellation?.requested ? 'stopped' : 'failed', rootJobId });
}

const DELIVERY_CONFLICT_CODES = new Set(['ROLEPLAY_SOURCE_CHANGED', 'ROLEPLAY_JOB_REJECTED',
    'ROLEPLAY_AGENT_RECOVERY', 'ROLEPLAY_WORKFLOW_RECOVERY', 'ROLEPLAY_RECOVERY_REQUIRED',
    'ROLEPLAY_STORE_FULL', 'ROLEPLAY_STORE_UNCERTAIN', 'ROLEPLAY_WRITE_UNCERTAIN',
    'ROLEPLAY_SOURCE_MISSING', 'ROLEPLAY_SOURCE_DAMAGED']);

function isDeliveryConflict(error) {
    return DELIVERY_CONFLICT_CODES.has(String(error?.code ?? ''));
}

function hasSavedDeliveryProof(directories, job) {
    try {
        if (readArtifact(directories, job.id, 'roleplay-output') !== undefined) return true;
        const reference = readArtifact(directories, job.id, 'roleplay-main-provider');
        if (reference?.intentHash !== roleplayHash(job.intent) || !/^provider:[a-f0-9]{64}$/.test(reference?.step ?? '')) return false;
        const completed = readArtifact(directories, job.id, reference.step);
        const result = job.intent?.request?.binding?.backend === 'horde' && completed?.id
            ? readArtifact(directories, job.id, 'horde-result:' + reference.step.slice(9)) : completed;
        return typeof result?.text === 'string' && Boolean(result.text.trim());
    } catch {
        return false;
    }
}

/** A workflow root that could not publish its candidate: keep that speaker's reply. */
export function preserveRoleplayWorkflowReply(context, error) {
    const job = getJob(context.directories, context.job.id) ?? context.job;
    if (!job || job.type !== 'media.roleplay-workflow') return null;
    // A server restart or shutdown owns its retry state. It must not write a
    // candidate now and make the later retry find a changed chat.
    if (context.signal?.aborted && !job.cancellation?.requested) return null;
    const children = (job.children ?? []).map(id => getJob(context.directories, id)).filter(Boolean);
    const candidate = children.reverse().find(child => child.type === 'roleplay.candidate'
        && child.state === 'completed' && readArtifactSafe(context.directories, child.id, 'roleplay-candidate')?.kind === 'text');
    if (!candidate) return null;
    if (isToolTurnOnly({ directories: context.directories, job: candidate })) return null;
    const saved = readArtifactSafe(context.directories, candidate.id, 'roleplay-candidate');
    const code = String(error?.code ?? '');
    const blocked = code === 'GENERATION_BLOCKED' || code === 'ROLEPLAY_BLOCKED_RECOVERY';
    const prior = workflowPriorText({ directories: context.directories, job: candidate, rootJobId: job.id });
    const protectedRecovery = ['ROLEPLAY_AGENT_RECOVERY', 'ROLEPLAY_WORKFLOW_RECOVERY', 'ROLEPLAY_RECOVERY_REQUIRED',
        'ROLEPLAY_STORE_UNCERTAIN', 'ROLEPLAY_WRITE_UNCERTAIN'].includes(code)
        && !(job.cancellation?.requested && code === 'ROLEPLAY_WORKFLOW_RECOVERY');
    if (protectedRecovery) return null;
    if (blocked && !prior) return null;
    // If this candidate's own protected publication already started, the
    // ordinary write owns the reply and its recovery. Never write a second copy.
    try {
        const published = withNativeMediaReceipt(context, ({ value }) => Object.values(value.effects ?? {})
            .some(effect => effect?.candidateHash === saved.hash && ['writing', 'done'].includes(effect.state)),
        { checkSource: false });
        if (published) return null;
    } catch { /* No readable receipt: the keeper may still capture the reply. */ }
    return keepRoleplayReply({ ...context, job: candidate }, { reason: job.cancellation?.requested ? 'stopped' : 'failed',
        rootJobId: job.id });
}

function readArtifactSafe(directories, id, name) {
    try { return readArtifact(directories, id, name); } catch { return undefined; }
}
