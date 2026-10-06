import { runChatProfile, validateActiveGenerationContext } from '../generation/service.js';
import { captureGenerationBinding, resolveGenerationProfile } from '../generation/profiles.js';
import { createMacroEnvironment } from '../macros/index.js';
import { hash } from '../mewmory/core.js';
import { createProviderScope, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { acceptJob, canonical, getJob, listJobs, releaseJob, requestCancellation, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { roleplayAccountBase } from '../roleplay-store.js';
import {
    MAX_MESSAGE_BYTES,
    MAX_MESSAGES,
    MAX_REASONING_BYTES,
    ASSISTANT_IDS,
    ScratchpadError,
    assistantConnection,
    findSession,
    newScratchpadId,
    normaliseGender,
    normaliseSource,
    projectPending,
    publicBucket,
    readBucketLocked,
    requireId,
    scratchpadAccountBase,
    sessionAssistants,
    withScratchpad,
    writeBucketLocked,
} from './store.js';
import { buildScratchpadMessages, buildScratchpadSystemPrompt } from './prompt.js';
import { clearScratchpadPreview, publishScratchpadPreview } from './preview.js';

export const SCRATCHPAD_JOB_TYPE = 'scratchpad.reply';
const MAX_CONTEXT_BYTES = 1536 * 1024;
const MAX_HELP_BYTES = 96 * 1024;
const MAX_HISTORY_MESSAGES = 50;
const MAX_HISTORY_BYTES = 512 * 1024;
const PREPARE_TIMEOUT_MS = 60 * 1000;

const fail = (code, message, status = 400) => new ScratchpadError(code, message, status);
// Scratchpad assistants never speak as the chat character, so its output scripts do not apply.
const scratchpadMacroEnvironment = names => createMacroEnvironment({ names, extra: { characterScope: 'none' } }, {}, { readOnly: true });
const bytes = value => Buffer.byteLength(String(value ?? ''), 'utf8');

function boundedText(value, max, label, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw fail('SCRATCHPAD_TEXT_REQUIRED', `${label} is empty.`);
        return '';
    }
    if (typeof value !== 'string') throw fail('SCRATCHPAD_REQUEST_INVALID', `${label} is not text.`);
    if (bytes(value) > max) throw fail('SCRATCHPAD_TEXT_TOO_LARGE', `${label} is too long.`, 413);
    return value;
}

function normaliseCapabilities(input) {
    const value = input && typeof input === 'object' ? input : {};
    const members = Array.isArray(value.members)
        ? value.members.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim().slice(0, 200)).slice(0, 2000)
        : [];
    return { lore: value.lore === true, character: value.character === true, chat: value.chat === true, members };
}

function normaliseNames(input) {
    const value = input && typeof input === 'object' ? input : {};
    const user = typeof value.user === 'string' ? value.user.trim().slice(0, 100) : '';
    const character = typeof value.character === 'string' ? value.character.trim().slice(0, 200) : '';
    return { user: user || 'User', character };
}

/** Validate the browser request without touching storage. */
export function normaliseReplyRequest(body = {}) {
    const submissionKey = typeof body.submissionKey === 'string' ? body.submissionKey.trim() : '';
    if (!submissionKey || submissionKey.length > 256) throw fail('SCRATCHPAD_REQUEST_INVALID', 'The send request is missing its identity. Reload the page and try again.');
    const source = normaliseSource(body.source);
    const sessionId = requireId(body.sessionId, 'session');
    const regenerate = body.regenerate ? requireId(body.regenerate, 'reply') : null;
    const text = regenerate ? '' : boundedText(body.text, MAX_MESSAGE_BYTES, 'The message', { required: true });
    if (!regenerate && !text.trim()) throw fail('SCRATCHPAD_TEXT_REQUIRED', 'Write a message first.');
    return {
        submissionKey,
        source,
        sessionId,
        regenerate,
        text,
        context: boundedText(body.context, MAX_CONTEXT_BYTES, 'The shared context'),
        help: boundedText(body.help, MAX_HELP_BYTES, 'The help reference'),
        capabilities: normaliseCapabilities(body.capabilities),
        names: normaliseNames(body.names),
        chatProfileId: source.kind === 'conversation' ? boundedText(body.chatProfileId, 256, 'The chat connection profile').trim() : '',
        genders: Object.fromEntries(ASSISTANT_IDS.filter(id => Object.hasOwn(body.genders ?? {}, id)).map(id => [id, normaliseGender(body.genders[id])])),
    };
}

function hasPending(session) {
    return session.messages.some(message => message.state === 'pending');
}

function historyFrom(messages) {
    const usable = messages.filter(message => message.role === 'user' || (message.state === 'done' && message.text.trim()));
    const history = [];
    let total = 0;
    for (let index = usable.length - 1; index >= 0 && history.length < MAX_HISTORY_MESSAGES; index--) {
        const size = bytes(usable[index].text);
        if (total + size > MAX_HISTORY_BYTES) break;
        total += size;
        history.unshift({ role: usable[index].role, text: usable[index].text, ...(usable[index].assistant ? { assistant: usable[index].assistant } : {}) });
    }
    while (history.length && history[0].role !== 'user') history.shift();
    return history;
}

/** Work out what the model sees for a new message or a regenerated reply. */
export function planReply(session, request) {
    if (hasPending(session)) throw fail('SCRATCHPAD_REPLY_PENDING', 'This session is still replying. Wait for it or press Stop.', 409);
    const messages = session.messages;
    if (!request.regenerate) {
        const assistants = sessionAssistants(session);
        if (messages.length + 1 + assistants.length > MAX_MESSAGES) throw fail('SCRATCHPAD_SESSION_FULL', 'This session is full. Start a new session to keep talking.', 409);
        return { prompt: request.text, history: historyFrom(messages), replace: null, assistants };
    }
    const userIndex = messages.findLastIndex(message => message.role === 'user');
    const replyIndex = messages.findIndex(message => message.id === request.regenerate && message.role === 'assistant');
    if (userIndex < 0 || replyIndex <= userIndex) {
        throw fail('SCRATCHPAD_REGENERATE_INVALID', 'Only replies to the latest message can be regenerated.', 409);
    }
    const reply = messages[replyIndex];
    return { prompt: messages[userIndex].text, history: historyFrom(messages.slice(0, userIndex)), replace: reply.id, assistants: [reply.assistant || session.assistant] };
}

function existingSubmission(directories, owner, request, requestHash) {
    const job = listJobs(directories, { owner, includeDismissed: true }).find(item => item.submissionKey === request.submissionKey);
    if (!job) return null;
    if (job.type !== SCRATCHPAD_JOB_TYPE || job.intent?.requestHash !== requestHash) {
        throw fail('JOB_SUBMISSION_CONFLICT', 'This submission key already belongs to another operation.', 409);
    }
    return job;
}

function readProjectedBucket(base, source) {
    return withScratchpad(base, lease => {
        const bucket = readBucketLocked(lease, source);
        return publicBucket(projectPending(bucket, id => getJob(base.directories, id)));
    });
}

/** Accept one Scratchpad reply as a server job. The reply keeps running if the page closes. */
export async function acceptScratchpadReply(request, body = {}) {
    const base = scratchpadAccountBase(request);
    const { directories, owner } = base;
    const input = normaliseReplyRequest(body);
    const requestHash = hash({ source: input.source, sessionId: input.sessionId, regenerate: input.regenerate, text: input.text,
        context: input.context, help: input.help, capabilities: input.capabilities, names: input.names, chatProfileId: input.chatProfileId, genders: input.genders });
    const duplicate = existingSubmission(directories, owner, input, requestHash);
    if (duplicate) return { created: false, job: duplicate, bucket: readProjectedBucket(base, input.source) };

    const planned = withScratchpad(base, lease => {
        const bucket = readBucketLocked(lease, input.source);
        projectPending(bucket, id => getJob(directories, id));
        const session = findSession(bucket, input.sessionId);
        const plan = planReply(session, input);
        writeBucketLocked(lease, bucket);
        return { ...plan, revision: hash(canonical(session)), maxTokens: session.settings.maxTokens,
            participants: sessionAssistants(session),
            speakers: plan.assistants.map(assistant => ({ assistant, customPrompt: session.settings.assistantPrompts?.[assistant], gender: input.genders[assistant] ?? (assistant === session.assistant ? session.gender : 'neutral'), connection: assistantConnection(session.settings, assistant) })) };
    });

    const replies = await Promise.all(planned.speakers.map(async speaker => {
        const profileId = speaker.connection.kind === 'profile' ? speaker.connection.profileId : input.chatProfileId;
        const selection = profileId ? { kind: 'profile', profileId } : { kind: 'active' };
        const binding = captureGenerationBinding(directories, selection, body.acknowledgement);
        const system = buildScratchpadSystemPrompt({ ...speaker, userName: input.names.user, participants: planned.participants,
            characterName: input.names.character, capabilities: input.capabilities, help: input.help });
        const messages = buildScratchpadMessages({ system: system.text, context: input.context, history: planned.history, text: planned.prompt, assistant: speaker.assistant });
        const rawOptions = binding.kind === 'active' ? { trimNames: false } : {};
        const preparedMessages = !binding.backend || binding.backend === 'chat';
        const names = { user: input.names.user, char: system.persona.name };
        await validateActiveGenerationContext(resolveGenerationProfile(directories, binding), scratchpadMacroEnvironment(names),
            messages, rawOptions, { maxTokens: planned.maxTokens, preparedMessages });
        return { replyId: newScratchpadId(), assistant: speaker.assistant, gender: speaker.gender, binding, messages, maxTokens: planned.maxTokens,
            userName: names.user, characterName: names.char, rawOptions, preparedMessages };
    }));
    const { job, created } = acceptJob(directories, {
        owner,
        type: SCRATCHPAD_JOB_TYPE,
        submissionKey: input.submissionKey,
        intent: { kind: 'scratchpad', source: { kind: input.source.kind, key: input.source.key }, sessionId: input.sessionId, requestHash },
        automatic: false,
        paused: true,
        coalesce: { deadline: 0, members: [] },
        target: { kind: 'scratchpad', id: input.sessionId },
        credentialRef: replies.length === 1 ? replies[0].binding : { participants: replies.map(reply => ({ assistant: reply.assistant, binding: reply.binding })) },
        config: { requestHash },
        label: `Scratchpad ${replies.length > 1 ? 'round table' : 'reply'} from ${replies.map(reply => reply.characterName).join(', ')}`,
    });
    noteOwner(owner);
    if (!created) return { created: false, job, bucket: readProjectedBucket(base, input.source) };

    let bucket;
    try {
        bucket = withScratchpad(base, lease => {
            const current = readBucketLocked(lease, input.source);
            const session = findSession(current, input.sessionId);
            if (hasPending(session) || hash(canonical(session)) !== planned.revision) {
                throw fail('SCRATCHPAD_CHANGED', 'This session changed while the message was being sent. Try again.', 409);
            }
            const created = new Date().toISOString();
            if (!input.regenerate) session.messages.push({ id: newScratchpadId(), role: 'user', text: input.text, created });
            const pending = replies.map(reply => ({ id: reply.replyId, role: 'assistant', text: '', created, state: 'pending', jobId: job.id, assistant: reply.assistant, gender: reply.gender }));
            if (planned.replace) session.messages.splice(session.messages.findIndex(message => message.id === planned.replace), 1, ...pending);
            else session.messages.push(...pending);
            session.updated = created;
            current.activeSessionId = session.id;
            writeBucketLocked(lease, current);
            return publicBucket(current);
        });
        writeArtifact(directories, job.id, 'request', { source: input.source, sessionId: input.sessionId,
            ...(replies.length === 1 ? replies[0] : { replies }) });
    } catch (error) {
        requestCancellation(directories, job.id, { reason: 'scratchpad-preparation-failed' });
        updateJob(directories, job.id, current => ['cancelled', 'completed', 'failed'].includes(current.state) ? current : {
            ...current, state: 'failed', stage: null, finishedAt: Date.now(),
            error: { message: error.message || 'The reply could not be prepared.', code: error.code || 'SCRATCHPAD_PREPARE_FAILED' }, recoverability: 'needs-retry',
        });
        throw error;
    }
    releaseJob(directories, job.id);
    return { created: true, job: getJob(directories, job.id) ?? job, bucket };
}

function settleReply(context, request, patch) {
    const base = roleplayAccountBase(context.directories);
    if (!base) return false;
    return withScratchpad(base, lease => {
        const bucket = readBucketLocked(lease, request.source);
        const session = bucket.sessions.find(item => item.id === request.sessionId);
        const message = session?.messages.find(item => item.id === request.replyId && item.jobId === context.job.id);
        if (!message) return false;
        if (message.state !== 'pending') {
            return patch.state === 'done' && message.state === 'done' && message.text === patch.text && (message.reasoning || '') === (patch.reasoning || '');
        }
        Object.assign(message, patch);
        if (patch.state === 'done') delete message.error;
        if (!message.reasoning) delete message.reasoning;
        session.updated = new Date().toISOString();
        writeBucketLocked(lease, bucket);
        return true;
    });
}

function clipBytes(text, max) {
    const value = String(text ?? '');
    if (bytes(value) <= max) return value;
    return Buffer.from(value, 'utf8').subarray(0, max).toString('utf8').replace(/\uFFFD+$/, '');
}

function reasoningFrom(response, streamed) {
    const message = response?.choices?.[0]?.message;
    const value = message?.reasoning_content || message?.reasoning || response?.thinking || streamed || '';
    return typeof value === 'string' ? clipBytes(value, MAX_REASONING_BYTES) : '';
}

async function runScratchpadReply(context, { generate }) {
    const { directories, job } = context;
    const request = readArtifact(directories, job.id, 'request');
    if (!request) throw fail('SCRATCHPAD_REQUEST_MISSING', 'The saved Scratchpad request is missing.', 409);
    const saved = readArtifact(directories, job.id, 'result');
    if (saved) return { artifact: true };
    try {
        if (!request.replies) {
            await runParticipant(context, request, { generate });
            writeArtifact(directories, job.id, 'result', { replyId: request.replyId, sessionId: request.sessionId });
        } else {
            const scoped = { ...context, providerScope: createProviderScope(context) };
            const results = await Promise.allSettled(request.replies.map(reply => runParticipant(scoped,
                { source: request.source, sessionId: request.sessionId, ...reply }, { generate, grouped: true })));
            const failed = results.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
            writeArtifact(directories, job.id, 'result', { replyIds: request.replies.map(reply => reply.replyId), sessionId: request.sessionId });
        }
        return { artifact: true };
    } finally {
        setTimeout(() => clearScratchpadPreview(job.owner, job.id), 30 * 1000).unref?.();
    }
}

async function runParticipant(context, request, { generate, grouped = false }) {
    const { directories, job, signal } = context;
    const artifact = grouped ? `reply:${request.replyId}` : 'reply';
    const outcome = grouped ? `outcome:${request.replyId}` : 'outcome';
    const publish = patch => publishScratchpadPreview(job.owner, job.id, { ...patch, ...(grouped ? { replyId: request.replyId } : {}) });
    let streamedReasoning = '';
    const stopped = () => signal?.aborted || getJob(directories, job.id)?.cancellation?.requested;
    const requireRunning = () => {
        if (stopped()) throw fail('SCRATCHPAD_STOPPED', 'Stopped before it finished.', 409);
    };
    try {
        requireRunning();
        const failure = readArtifact(directories, job.id, outcome);
        if (failure?.error) throw fail('SCRATCHPAD_REPLY_FAILED', failure.error, 502);
        let reply = readArtifact(directories, job.id, artifact);
        if (!reply) {
            publish({ stage: 'generating', text: '', reasoning: '' });
            const response = await generate({
                binding: request.binding,
                messages: request.messages,
                maxTokens: request.maxTokens,
                macroEnvironment: scratchpadMacroEnvironment({ user: request.userName, char: request.characterName }),
                userName: request.userName,
                characterName: request.characterName,
                groupNames: [],
                rawOptions: request.rawOptions,
                preparedMessages: request.preparedMessages,
                stream: true,
                stepNamespace: grouped ? `scratchpad:${request.replyId}` : '',
                onStream: value => {
                    if (typeof value?.reasoning === 'string' && value.reasoning) streamedReasoning = value.reasoning;
                    publish({ stage: 'generating', text: value?.text ?? '', reasoning: value?.reasoning ?? '' });
                },
                context,
                jobContext: context,
            });
            requireRunning();
            const text = String(response?.text ?? '').trim();
            if (!text) throw fail('SCRATCHPAD_EMPTY_REPLY', 'The model returned no text. Try again or pick another connection.', 502);
            reply = { text: clipBytes(text, MAX_MESSAGE_BYTES), reasoning: reasoningFrom(response?.response, streamedReasoning) };
            writeArtifact(directories, job.id, artifact, reply);
        }
        requireRunning();
        if (!settleReply(context, request, { state: 'done', text: reply.text, reasoning: reply.reasoning })) {
            throw fail('SCRATCHPAD_CHANGED', 'The saved reply changed before this result could be saved.', 409);
        }
        publish({ stage: 'done', text: reply.text, reasoning: reply.reasoning });
    } catch (error) {
        const cancelled = stopped();
        const message = cancelled ? 'Stopped before it finished.' : (error?.message || 'The reply failed.');
        try {
            settleReply(context, request, { state: 'failed', error: message });
            writeArtifact(directories, job.id, outcome, { error: message });
        } catch {
            // The job state still reports the failure if the session file cannot be updated.
        }
        publish({ stage: 'failed', error: message });
        throw error;
    }
}

/** Release a reply whose request was saved before a restart, or fail one that never finished preparing. */
export function finalizeScratchpadSubmission(context) {
    const { directories, job } = context;
    if (job.type !== SCRATCHPAD_JOB_TYPE || job.state !== 'waiting' || job.stage !== 'preparing' || job.cancellation?.requested) return false;
    if (readArtifact(directories, job.id, 'request')) {
        releaseJob(directories, job.id);
        return true;
    }
    if (Date.now() - Number(job.createdAt || 0) < PREPARE_TIMEOUT_MS) return false;
    updateJob(directories, job.id, current => current.state !== 'waiting' ? current : {
        ...current, state: 'failed', stage: null, finishedAt: Date.now(),
        error: { message: 'The reply could not be prepared. Send it again.', code: 'SCRATCHPAD_PREPARE_FAILED' }, recoverability: 'needs-retry',
    });
    return true;
}

export function registerScratchpadJobs({ generate = runChatProfile } = {}) {
    registerHandler(SCRATCHPAD_JOB_TYPE, context => runScratchpadReply(context, { generate }));
}

registerScratchpadJobs();

export const testExports = { historyFrom, planReply, normaliseReplyRequest, runScratchpadReply, settleReply };
