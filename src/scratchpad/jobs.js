import { randomInt } from 'node:crypto';
import { normaliseAttachments } from '../../public/scripts/scratchpad/attachment-data.js';
import { normalisePresetTargets } from '../../public/scripts/scratchpad/preset-fields.js';
import { appendReplySwipe, MAX_REPLY_SWIPES, replySwipes } from '../../public/scripts/scratchpad/swipes.js';
import { scratchpadPrefill, joinScratchpadPrefill } from '../../public/scripts/scratchpad/prefill.js';
import { roundToDiscuss } from '../../public/scripts/scratchpad/discuss.js';
import { canRehearse, REHEARSAL_INSTRUCTIONS, REHEARSAL_REQUEST } from '../../public/scripts/scratchpad/rehearsal.js';
import { runChatProfile, validateActiveGenerationContext } from '../generation/service.js';
import { createMessageTokenCounter } from '../generation/message-token-counts.js';
import { captureGenerationBinding, resolveGenerationProfile } from '../generation/profiles.js';
import { extractProviderReasoning } from '../../public/scripts/generation-format.js';
import { hash } from '../mewmory/core.js';
import { createProviderScope, providerStep, readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { acceptJob, canonical, getJob, listJobs, releaseJob, requestCancellation, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { roleplayAccountBase } from '../roleplay-store.js';
import {
    MAX_INPUT_BYTES,
    MAX_MESSAGE_BYTES,
    MAX_MESSAGES,
    MAX_REASONING_BYTES,
    ASSISTANT_IDS,
    ScratchpadError,
    assistantConnection,
    findSession,
    nameFromFirstMessage,
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
import { instructionsForAssistant, readInstructionsLocked } from './instructions.js';
import { readAssistantsLocked, refreshSessionAssistants, resolveAssistant } from './assistants.js';
import { characterToolReply, scratchpadCharacterTools, scratchpadToolsFor } from './character-tools.js';
import { clearScratchpadPreview, publishScratchpadPreview } from './preview.js';
import { scratchpadMacroEnvironment } from './macros.js';
import { notebookContextLocked, withNotebookPreparation, captureReplyNotebookProposalsLocked, notifyScratchpadNotebookResult } from './notebooks.js';
import { mewmoryContextLocked } from './mewmory.js';
import { MAX_HISTORY_BYTES, MAX_HISTORY_MESSAGE_BYTES, MAX_HISTORY_TEXT_BYTES, MAX_SUMMARY_BYTES, SUMMARY_HISTORY_LIMIT, SUMMARY_MAX_TOKENS, SUMMARY_PLACEHOLDER, normaliseSummary, planSummary, summaryContext, summaryFingerprint, summaryMessages } from './summary.js';
import { sameSourceContext } from '../../public/scripts/scratchpad/source.js';
import { captureImageTargetsLocked, capturePersonaTargetLocked, imagePersonaIdLocked, normaliseImageTargets, normalisePersonaTarget } from './image-targets.js';
import { hasPendingImages } from './image-state.js';
import { readScratchpadImageAvailability } from './images.js';
import { generatedImageReceipts, prepareGeneratedImageHistory } from './image-history.js';
import { WEB_PAGES_PLACEHOLDER, buildWebPagesPrompt, planWebPages, readWebPages, webPagesAcknowledgement, webPagesHistoryLine, webPagesMetadata } from './web-pages.js';
import { MAX_WEB_SEARCH_QUERIES, MAX_WEB_SEARCH_RESULTS, WEB_SEARCH_PLACEHOLDER, buildWebSearchPrompt, performWebSearch, planWebSearch, readWebSearchLocked, webSearchAcknowledgement, webSearchFailure, webSearchHistoryLine, webSearchMetadata } from './web-search.js';
import { MAX_RESEARCH_ROUNDS, RESEARCH_PLAN_MAX_TOKENS, mergeResearchResults, nextResearchQueries, parseResearchPlan, researchPlannerMessages } from './web-research.js';

export const SCRATCHPAD_JOB_TYPE = 'scratchpad.reply';
const MAX_CONTEXT_BYTES = 1536 * 1024;
const MAX_HELP_BYTES = 96 * 1024;
const MAX_HISTORY_MESSAGES = SUMMARY_HISTORY_LIMIT;
const PREPARE_TIMEOUT_MS = 60 * 1000;

const fail = (code, message, status = 400) => new ScratchpadError(code, message, status);
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

export function normaliseCapabilities(input, sourceKind = 'roleplay', source = {}) {
    const value = input && typeof input === 'object' ? input : {};
    const members = Array.isArray(value.members)
        ? value.members.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim().slice(0, 200)).slice(0, 2000)
        : [];
    const general = sourceKind === 'general';
    return { lore: sourceKind !== 'notebook' && value.lore === true, character: value.character === true && (!general || Boolean(source.avatar)),
        ...(sourceKind === 'roleplay' && normalisePresetTargets(value.preset).length ? { preset: normalisePresetTargets(value.preset) } : {}),
        ...(sourceKind !== 'notebook' && normalisePersonaTarget(value.persona) ? { persona: normalisePersonaTarget(value.persona) } : {}),
        chat: !general && value.chat === true, members: general ? [] : members,
        ...(sourceKind !== 'notebook' && value.agents === true ? { agents: true } : {}),
        ...(sourceKind !== 'notebook' && value.regex === true ? { regex: true } : {}),
        ...(sourceKind !== 'notebook' && value.cssSnippets === true ? { cssSnippets: true } : {}),
        ...(sourceKind !== 'notebook' && value.dialogueColors === true ? { dialogueColors: true } : {}),
        ...(sourceKind === 'roleplay' && value.authorsNote === true ? { authorsNote: true } : {}),
        ...(value.image !== undefined ? { image: value.image === true } : {}) };
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
    const attachments = regenerate ? [] : normaliseAttachments(body.attachments);
    const rehearsal = !regenerate && body.rehearsal === true;
    if (rehearsal && (!canRehearse(source) || body.discuss === true)) throw fail('SCRATCHPAD_REHEARSAL_INVALID', 'Open a story chat to rehearse its next reply.');
    const typed = regenerate ? '' : boundedText(body.text, MAX_INPUT_BYTES, 'The message');
    const text = rehearsal && !typed.trim() ? REHEARSAL_REQUEST : typed;
    if (!regenerate && !text.trim() && !attachments.length) throw fail('SCRATCHPAD_TEXT_REQUIRED', 'Write a message or attach a file first.');
    return {
        submissionKey,
        source,
        sessionId,
        regenerate,
        discuss: !regenerate && body.discuss === true,
        rehearsal,
        text,
        attachments,
        context: boundedText(body.context, MAX_CONTEXT_BYTES, 'The shared context'),
        help: boundedText(body.help, MAX_HELP_BYTES, 'The help reference'),
        capabilities: normaliseCapabilities(body.capabilities, source.kind, source),
        names: normaliseNames(body.names),
        ...(body.targets !== undefined ? { targets: normaliseImageTargets(body.targets) } : {}),
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
    let textTotal = 0;
    for (let index = usable.length - 1; index >= 0 && history.length < MAX_HISTORY_MESSAGES; index--) {
        const text = clipBytes(usable[index].text, MAX_HISTORY_MESSAGE_BYTES);
        const attachments = usable[index].attachments ?? [];
        const size = bytes(text) + (attachments.length ? bytes(JSON.stringify(attachments)) : 0);
        if (total + size > MAX_HISTORY_BYTES || textTotal + bytes(text) > MAX_HISTORY_TEXT_BYTES) break;
        total += size;
        textTotal += bytes(text);
        const images = Object.entries(usable[index].images ?? {}).map(([proposal, image]) =>
            `[Server image status: ${image.target === 'avatar' ? `portrait for ${image.characterName || 'shared character'}` : 'image'}; ${image.state === 'done'
                ? usable[index].proposals?.[proposal] === 'applied' ? 'image saved and avatar replacement approved' : 'image saved; no avatar replacement performed' : image.state}.]`).join('\n');
        const webSources = usable[index].role === 'assistant' && usable[index].state === 'done' ? webSearchHistoryLine(usable[index].webSearch) : '';
        const webPages = usable[index].role === 'assistant' && usable[index].state === 'done' ? webPagesHistoryLine(usable[index].webPages) : '';
        const generatedImages = generatedImageReceipts(usable[index]);
        history.unshift({ id: usable[index].id, role: usable[index].role, text: [usable[index].rehearsal ? '[Rehearsal only, not an event in the story.]' : '', text, webSources, webPages, images].filter(Boolean).join('\n'), ...(attachments.length ? { attachments } : {}), ...(generatedImages.length ? { generatedImages } : {}), ...(usable[index].assistant ? { assistant: usable[index].assistant, assistantName: usable[index].assistantName } : {}) });
    }
    while (history.length && history[0].role !== 'user') history.shift();
    return history;
}

/** Work out what the model sees for a new message or a regenerated reply. */
export function planReply(session, request, chooseIndex = randomInt) {
    if (hasPending(session)) throw fail('SCRATCHPAD_REPLY_PENDING', 'This session is still replying. Wait for it or press Stop.', 409);
    const messages = session.messages;
    if (!request.regenerate) {
        const participants = sessionAssistants(session);
        if (request.discuss && !roundToDiscuss(session).length) {
            throw fail('SCRATCHPAD_DISCUSS_INVALID', 'A discussion needs a round table and finished answers from at least two assistants to your latest message.', 409);
        }
        const assistants = session.settings.roundTable && session.settings.randomReply
            ? [participants[chooseIndex(participants.length)]] : participants;
        if (messages.length + 1 + assistants.length > MAX_MESSAGES) throw fail('SCRATCHPAD_SESSION_FULL', 'This session is full. Start a new session to keep talking.', 409);
        const compact = planSummary(session, messages);
        return { userMessageId: newScratchpadId(), prompt: request.text, rehearsal: request.rehearsal === true, attachments: request.attachments ?? [], history: historyFrom(compact.messages), summary: compact.summary, replace: null, assistants };
    }
    const replyIndex = messages.findIndex(message => message.id === request.regenerate && message.role === 'assistant');
    // The message this reply answered, which need not be the latest one. Later messages stay as they are.
    const userIndex = messages.slice(0, Math.max(replyIndex, 0)).findLastIndex(message => message.role === 'user');
    if (userIndex < 0) {
        throw fail('SCRATCHPAD_REGENERATE_INVALID', 'Only a reply to one of your messages can be tried again.', 409);
    }
    const reply = messages[replyIndex];
    const rehearsal = reply.rehearsal === true;
    if (rehearsal && !canRehearse(request.source)) throw fail('SCRATCHPAD_REHEARSAL_INVALID', 'Open the original story chat to rehearse this reply again.');
    if (replySwipes(reply).length >= MAX_REPLY_SWIPES) throw fail('SCRATCHPAD_SWIPE_LIMIT', `This reply has ${MAX_REPLY_SWIPES} versions. Send a new message to keep talking.`, 409);
    if (hasPendingImages(reply)) throw fail('SCRATCHPAD_REGENERATE_INVALID', 'Wait for the image on this reply to finish before trying it again.', 409);
    if ((request.source?.scope || request.source?.kind === 'general') && !sameSourceContext(request.source, reply.contextSource)) {
        throw fail('SCRATCHPAD_REGENERATE_INVALID', request.source.kind === 'general'
            ? 'Return to the original Scratchpad context before trying this reply again.' : 'Open the original chat before trying this reply again.', 409);
    }
    const compact = planSummary(session, messages.slice(0, userIndex));
    return { userMessageId: messages[userIndex].id, prompt: messages[userIndex].text, rehearsal, attachments: messages[userIndex].attachments ?? [], history: historyFrom(compact.messages), summary: compact.summary, replace: reply.id, assistants: [reply.assistant || session.assistant] };
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
    const requestHash = hash({ source: input.source, sessionId: input.sessionId, regenerate: input.regenerate, text: input.text, ...(input.discuss ? { discuss: true } : {}),
        ...(input.attachments.length ? { attachments: input.attachments } : {}),
        ...(input.rehearsal ? { rehearsal: true } : {}),
        context: input.context, help: input.help, capabilities: input.capabilities, names: input.names, chatProfileId: input.chatProfileId, genders: input.genders,
        ...(input.targets !== undefined ? { targets: input.targets } : {}) });
    const duplicate = existingSubmission(directories, owner, input, requestHash);
    if (duplicate) return { created: false, job: duplicate, bucket: readProjectedBucket(base, input.source) };

    const imageAvailability = input.capabilities.image ? readScratchpadImageAvailability(base) : {};
    const images = imageAvailability.image;
    const planned = await withNotebookPreparation(base, lease => {
        const bucket = readBucketLocked(lease, input.source);
        projectPending(bucket, id => getJob(directories, id));
        const session = findSession(bucket, input.sessionId);
        const plan = planReply(session, input);
        // Web search uses only the current message. Its settings and selected key
        // id are snapshotted here; the key value is read only when the job runs.
        // A discussion round has no question of its own to search for.
        const webSearch = session.settings.webSearch && !input.discuss ? planWebSearch(base.directories, readWebSearchLocked(lease), plan.prompt, { history: plan.history }) : null;
        // Only links typed in the current message are read, and only when the session asks for it.
        const webPages = session.settings.readLinks && !input.discuss ? planWebPages(plan.prompt) : null;
        // Target checking only runs when images are available, so a stale or renamed shared card cannot fail a text reply.
        const targets = images && !plan.rehearsal ? captureImageTargetsLocked(lease, bucket.source, input.targets, { shared: session.settings.include.card }) : [];
        const sharedPersona = plan.rehearsal ? null : capturePersonaTargetLocked(lease, bucket.source, input.capabilities.persona, session.settings.include.persona);
        const sharedPreset = session.settings.include.preset ? normalisePresetTargets(input.capabilities.preset) : [];
        const notebook = notebookContextLocked(lease, session.settings);
        const mewmory = mewmoryContextLocked(lease, input.source, session.settings);
        const instructions = readInstructionsLocked(lease);
        const library = readAssistantsLocked(lease);
        const snapshots = refreshSessionAssistants(session, library);
        writeBucketLocked(lease, bucket);
        return { ...plan, targets, sharedPersona, sharedPreset, sharedAgents: session.settings.include.agents === true, sharedAuthorsNote: session.settings.include.authorsNote === true, sharedRegex: session.settings.include.regex === true, sharedCssSnippets: session.settings.include.cssSnippets === true, sharedDialogueColors: session.settings.include.dialogueColors === true, sharedLorebook: bucket.source.kind !== 'general' || Boolean(session.settings.lorebook), imagePersonaId: imagePersonaIdLocked(lease, bucket.source), notebook, webSearch, webPages, revision: hash(canonical(session)), maxTokens: session.settings.maxTokens, stream: session.settings.stream !== false,
            mewmory, pinnedNote: session.pinnedNote, prefill: session.settings.prefill, partialPrefill: session.settings.partialPrefill,
            instructionsRevision: instructions.revision,
            assistantsRevision: library.revision,
            assistantNames: Object.fromEntries(Object.entries(snapshots).map(([id, profile]) => [id, profile.name])),
            participants: sessionAssistants(session),
            randomReply: session.settings.roundTable && session.settings.randomReply,
            speakers: plan.assistants.map(assistant => ({ assistant, userInstructions: instructionsForAssistant(instructions, assistant),
                persona: resolveAssistant(library, assistant, snapshots),
                customPrompt: session.settings.assistantPrompts?.[assistant], gender: input.genders[assistant] ?? (assistant === session.assistant ? session.gender : 'neutral'), connection: assistantConnection(session.settings, assistant) })) };
    });

    const imageHistoryCache = new Map();
    const replies = await Promise.all(planned.speakers.map(async speaker => {
        const profileId = speaker.connection.kind === 'profile' ? speaker.connection.profileId : input.chatProfileId;
        const selection = profileId ? { kind: 'profile', profileId } : { kind: 'active' };
        const binding = captureGenerationBinding(directories, selection, body.acknowledgement);
        const material = resolveGenerationProfile(directories, binding);
        const system = buildScratchpadSystemPrompt({ ...speaker, assistantNames: planned.assistantNames, userName: input.names.user, participants: planned.participants, randomReply: planned.randomReply,
            characterName: input.names.character, sourceKind: input.source.kind, webSearch: Boolean(planned.webSearch), webPages: Boolean(planned.webPages), imageEditing: imageAvailability.edit === true,
            capabilities: { ...input.capabilities, persona: planned.sharedPersona, preset: planned.sharedPreset, agents: input.capabilities.agents === true && planned.sharedAgents, authorsNote: input.capabilities.authorsNote === true && planned.sharedAuthorsNote, regex: input.capabilities.regex === true && planned.sharedRegex, cssSnippets: input.capabilities.cssSnippets === true && planned.sharedCssSnippets, dialogueColors: input.capabilities.dialogueColors === true && planned.sharedDialogueColors, lore: input.capabilities.lore === true && planned.sharedLorebook, image: Boolean(images), avatar: Boolean(images && planned.targets.length), notebook: Boolean(planned.notebook.text), mewmory: planned.mewmory.correctable === true }, help: input.help });
        if (planned.rehearsal) system.text = [REHEARSAL_INSTRUCTIONS, speaker.userInstructions].filter(Boolean).join('\n\n');
        const buildMessages = history => buildScratchpadMessages({ system: system.text, context: input.context, notebookContext: planned.notebook.text, history, text: planned.prompt, attachments: planned.attachments, assistant: speaker.assistant, assistantNames: planned.assistantNames,
            userMessageId: planned.userMessageId, summary: planned.summary ? summaryContext(SUMMARY_PLACEHOLDER) : '',
            pinnedNote: planned.pinnedNote, mewmoryContext: planned.mewmory.text, webSearchPlaceholder: planned.webSearch ? WEB_SEARCH_PLACEHOLDER : '', webPagesPlaceholder: planned.webPages ? WEB_PAGES_PLACEHOLDER : '' });
        let messages = buildMessages(planned.history);
        // Reserve each speaker's share of the request limit before adding optional pictures.
        const imageHistory = await prepareGeneratedImageHistory({ context: { directories, owner }, material, history: planned.history, cache: imageHistoryCache,
            maxBytes: Math.floor((15 * 1024 * 1024 - bytes(JSON.stringify(planned.summary))) / planned.speakers.length) - bytes(JSON.stringify(messages)) - 256 * 1024 });
        if (imageHistory !== planned.history) messages = buildMessages(imageHistory);
        const summaryIndex = planned.summary ? messages.findIndex(message => message.content === summaryContext(SUMMARY_PLACEHOLDER)) : -1;
        const pagesIndex = planned.webPages ? messages.length - 2 : -1;
        const searchIndex = planned.webSearch ? messages.length - (planned.webPages ? 3 : 2) : -1;
        const rawOptions = binding.kind === 'active' ? { trimNames: false } : {};
        const preparedMessages = !binding.backend || binding.backend === 'chat';
        if (!preparedMessages && messages.some(message => Array.isArray(message.content))) {
            throw fail('SCRATCHPAD_IMAGE_CONNECTION', 'Images need a Chat Completion connection with an image-capable model. Choose one in Context before sending.');
        }
        const names = { user: input.names.user, char: system.persona.name };
        const environment = scratchpadMacroEnvironment(names, messages);
        const selectedPrefill = scratchpadPrefill(planned, material.profile?.model || material.active?.model_novel);
        const prefill = scratchpadPrefill({ prefill: environment.evaluate(selectedPrefill.text) }, selectedPrefill.partial ? 'kimi-k3' : '');
        if (prefill.text) {
            if (preparedMessages || binding.kind !== 'active') messages.push({ role: 'assistant', content: prefill.text, ...(prefill.partial ? { partial: true } : {}) });
            else rawOptions.prefill = prefill.text;
        }
        await validateActiveGenerationContext(material, environment,
            messages, rawOptions, { maxTokens: planned.maxTokens, preparedMessages });
        return { replyId: newScratchpadId(), assistant: speaker.assistant, gender: speaker.gender, binding, messages, maxTokens: planned.maxTokens,
            userName: names.user, characterName: names.char, rawOptions, preparedMessages, stream: planned.stream, webSearch: planned.webSearch,
            summaryIndex, searchIndex, webPages: planned.webPages, pagesIndex, prefillReply: prefill.reply,
            ...(planned.rehearsal ? { rehearsal: true } : {}), functionTools: preparedMessages && !planned.rehearsal ? scratchpadCharacterTools() : [] };
    }));
    const savedRequest = { source: input.source, sessionId: input.sessionId, summary: planned.summary, ...(replies.length === 1 ? replies[0] : { replies }) };
    if (bytes(JSON.stringify(savedRequest)) > 15 * 1024 * 1024) {
        throw fail('SCRATCHPAD_ATTACHMENTS_TOO_LARGE', 'This reply has too much attached content. Send fewer files, share less context or start a new session.', 413);
    }
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
        bucket = await withNotebookPreparation(base, lease => {
            const current = readBucketLocked(lease, input.source);
            const session = findSession(current, input.sessionId);
            if (hasPending(session) || hash(canonical(session)) !== planned.revision) {
                throw fail('SCRATCHPAD_CHANGED', 'This session changed while the message was being sent. Try again.', 409);
            }
            if (readInstructionsLocked(lease).revision !== planned.instructionsRevision) {
                throw fail('SCRATCHPAD_INSTRUCTIONS_CHANGED', 'User instructions changed while the message was being sent. Try again.', 409);
            }
            if (readAssistantsLocked(lease).revision !== planned.assistantsRevision) {
                throw fail('SCRATCHPAD_ASSISTANTS_CHANGED', 'An assistant changed while the message was being sent. Try again.', 409);
            }
            if (notebookContextLocked(lease, session.settings).fingerprint !== planned.notebook.fingerprint) {
                throw fail('SCRATCHPAD_NOTES_CHANGED', 'The shared notes or their permissions changed while sending. Check the preview and try again.', 409);
            }
            if (mewmoryContextLocked(lease, input.source, session.settings).fingerprint !== planned.mewmory.fingerprint) {
                throw fail('SCRATCHPAD_MEWMORY_CHANGED', 'The shared memories or their sources changed while sending. Check the preview and try again.', 409);
            }
            const created = new Date().toISOString();
            const contextSource = Object.fromEntries(Object.entries(input.source).filter(([key]) => key !== 'scope'));
            const shared = input.source.kind === 'general' && input.capabilities.character ? { sharedAvatar: input.source.avatar } : {};
            if (!input.regenerate) nameFromFirstMessage(session, input.text);
            const mode = planned.rehearsal ? { rehearsal: true } : {};
            if (!input.regenerate) session.messages.push({ id: planned.userMessageId, role: 'user', text: input.text, ...mode, ...(input.attachments.length ? { attachments: input.attachments } : {}), created, contextSource });
            const pending = replies.map(reply => ({ id: reply.replyId, role: 'assistant', text: '', created, contextSource, ...shared,
                targets: planned.targets, sharedPersona: planned.sharedPersona, sharedPreset: planned.sharedPreset, imageNames: input.names, imagePersonaId: planned.imagePersonaId,
                ...mode, state: 'pending', jobId: job.id, assistant: reply.assistant, assistantName: reply.characterName, gender: reply.gender }));
            if (planned.replace) {
                const index = session.messages.findIndex(message => message.id === planned.replace);
                session.messages[index] = appendReplySwipe(session.messages[index], pending[0]);
            } else session.messages.push(...pending);
            session.updated = created;
            current.activeSessionId = session.id;
            writeBucketLocked(lease, current);
            return publicBucket(current);
        });
        writeArtifact(directories, job.id, 'request', savedRequest);
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

async function settleReply(context, request, patch) {
    const base = roleplayAccountBase(context.directories);
    if (!base) return false;
    let proposals = [];
    const settled = await withNotebookPreparation(base, lease => {
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
        if (patch.state === 'done') proposals = captureReplyNotebookProposalsLocked(lease, bucket, session, message);
        session.updated = new Date().toISOString();
        writeBucketLocked(lease, bucket);
        return true;
    });
    for (const result of proposals) notifyScratchpadNotebookResult(base, result);
    return settled;
}

function clipBytes(text, max) {
    const value = String(text ?? '');
    if (bytes(value) <= max) return value;
    return Buffer.from(value, 'utf8').subarray(0, max).toString('utf8').replace(/\uFFFD+$/, '');
}

function reasoningFrom({ response, generation } = {}, streamed) {
    const message = response?.choices?.[0]?.message;
    const provider = extractProviderReasoning(response, { mainApi: generation?.backend === 'text' ? 'textgenerationwebui' : 'openai',
        textGenType: generation?.source, chatCompletionSource: generation?.source });
    const value = provider || message?.reasoning_content || message?.reasoning || response?.thinking || streamed || '';
    return typeof value === 'string' ? clipBytes(value, MAX_REASONING_BYTES) : '';
}

function publishSearchStage(context, request) {
    const { job } = context;
    const update = { stage: 'searching', text: '', reasoning: '' };
    if (request.replies) {
        for (const reply of request.replies) publishScratchpadPreview(job.owner, job.id, { ...update, replyId: reply.replyId });
    } else {
        publishScratchpadPreview(job.owner, job.id, update);
    }
}

/** Ask the reply's model which queries to search next. Each round's answer is saved, so a restart repeats nothing. */
async function planResearchRound(context, request, generate, plan, state) {
    const { directories, job } = context;
    const artifact = `web-search-plan:${state.round}`;
    const saved = readArtifact(directories, job.id, artifact);
    if (saved !== undefined) return saved;
    const speaker = request.replies?.[0] ?? request;
    let planned;
    try {
        if (typeof generate !== 'function') throw fail('SCRATCHPAD_WEB_SEARCH_PLAN', 'No model is available to plan the search.', 409);
        const messages = researchPlannerMessages(plan, state);
        const environment = scratchpadMacroEnvironment({ user: speaker.userName, char: speaker.characterName }, messages);
        const rawOptions = speaker.binding.kind === 'active' ? { trimNames: false } : {};
        await validateActiveGenerationContext(resolveGenerationProfile(directories, speaker.binding), environment,
            messages, rawOptions, { maxTokens: RESEARCH_PLAN_MAX_TOKENS, preparedMessages: speaker.preparedMessages });
        const response = await generate({ binding: speaker.binding, generationType: 'quiet', messages, maxTokens: RESEARCH_PLAN_MAX_TOKENS,
            macroEnvironment: environment, userName: speaker.userName, characterName: speaker.characterName, groupNames: [],
            rawOptions, preparedMessages: speaker.preparedMessages, functionTools: [], stream: false,
            stepNamespace: `scratchpad-search-plan:${state.round}`, context, jobContext: context });
        planned = parseResearchPlan(characterToolReply(response, []).text) ?? { done: true, queries: [], unreadable: true };
    } catch (error) {
        // An unknown provider outcome or a stop must not turn into a fresh search plan.
        if (error?.code === 'PROVIDER_OUTCOME_UNKNOWN' || context.signal?.aborted || getJob(directories, job.id)?.cancellation?.requested) throw error;
        planned = { done: true, queries: [], failed: true };
    }
    writeArtifact(directories, job.id, artifact, planned);
    return planned;
}

/**
 * One research pass per job, shared by every round-table participant. The
 * model chooses the queries, reads what came back and decides whether to
 * search again, until it is satisfied or the round, query or result limit is
 * reached. The first round falls back to the message itself.
 */
async function resolveWebSearch(context, request, { searchFetch, generate } = {}) {
    const plan = request.webSearch ?? request.replies?.find(reply => reply.webSearch)?.webSearch;
    if (!plan) return null;
    const { directories, job } = context;
    const saved = readArtifact(directories, job.id, 'web-search');
    if (saved !== undefined) return saved;
    const running = () => {
        context.signal?.throwIfAborted();
        if (getJob(directories, job.id)?.cancellation?.requested) throw fail('SCRATCHPAD_STOPPED', 'Stopped before it finished.', 409);
    };
    // A crash during an earlier call leaves its outcome unknown; refuse before
    // the planner spends another model call on a job that cannot finish.
    if (unresolvedProviderStep(directories, job.id, { scope: context.providerScope })) {
        throw Object.assign(new Error('The earlier request to the AI service has an unknown result, so Neconyan will not send it again automatically.'),
            { code: 'PROVIDER_OUTCOME_UNKNOWN', status: 503 });
    }
    publishSearchStage(context, request);
    const limit = Math.min(MAX_WEB_SEARCH_RESULTS, Math.max(1, Number(plan.results) || 5));
    const searched = [];
    const failures = [];
    let results = [];
    for (let round = 0; round < MAX_RESEARCH_ROUNDS && searched.length < MAX_WEB_SEARCH_QUERIES && results.length < limit; round++) {
        running();
        const planned = await planResearchRound(context, request, generate, plan, { round, searched, results });
        let queries = round > 0 && planned.done ? [] : nextResearchQueries(planned, searched);
        if (round === 0 && !queries.length) queries = [plan.query];
        if (!queries.length) break;
        const first = searched.length;
        searched.push(...queries);
        // A search failure is recorded as its provider step's result, so the next
        // model step is not refused as an unresolved call. Cancellation is rethrown
        // and a genuine crash before the result stays unknown and is never replayed.
        const outcomes = await Promise.all(queries.map((query, index) => providerStep(context, `web-search:${first + index}`, async () => {
            try {
                return await performWebSearch({ ...plan, query, results: limit }, { directories, signal: context.signal, fetch: searchFetch });
            } catch (error) {
                if (context.signal?.aborted || getJob(directories, job.id)?.cancellation?.requested) throw error;
                return { ok: false, provider: plan.provider, query, error: webSearchFailure(error) };
            }
        })));
        for (const outcome of outcomes) if (!outcome?.ok) failures.push(outcome?.error || 'The web search could not be completed.');
        results = mergeResearchResults(results, outcomes.map(outcome => outcome?.ok ? outcome.results : []), limit);
        // Rewording will not fix a provider that refused or failed every search.
        if (outcomes.every(outcome => !outcome?.ok)) break;
    }
    running();
    const result = failures.length === searched.length
        ? { ok: false, provider: plan.provider, query: plan.query, queries: searched, error: failures[0] }
        : { ok: true, provider: plan.provider, query: plan.query, queries: searched, results };
    writeArtifact(directories, job.id, 'web-search', result);
    return result;
}

/** One read per job, shared by every round-table participant. Page reads are plain GETs, so a restart may repeat them. */
async function resolveWebPages(context, request, { pageFetch, pageLookup } = {}) {
    const plan = request.webPages ?? request.replies?.find(reply => reply.webPages)?.webPages;
    if (!plan) return null;
    const { directories, job } = context;
    const saved = readArtifact(directories, job.id, 'web-pages');
    if (saved !== undefined) return saved;
    const update = { stage: 'reading', text: '', reasoning: '' };
    if (request.replies) {
        for (const reply of request.replies) publishScratchpadPreview(job.owner, job.id, { ...update, replyId: reply.replyId });
    } else {
        publishScratchpadPreview(job.owner, job.id, update);
    }
    const result = await readWebPages(plan, { signal: context.signal, fetch: pageFetch, lookupAddresses: pageLookup });
    writeArtifact(directories, job.id, 'web-pages', result);
    return result;
}

async function resolveSummary(context, request, generate) {
    const plan = request.summary;
    if (!plan) return '';
    const { directories, job, signal } = context;
    const running = () => {
        signal?.throwIfAborted();
        if (getJob(directories, job.id)?.cancellation?.requested) throw fail('SCRATCHPAD_STOPPED', 'Stopped before it finished.', 409);
    };
    let text = plan.text;
    const speaker = request.replies?.[0] ?? request;
    for (const [index, chunk] of plan.chunks.entries()) {
        running();
        for (const reply of request.replies ?? [request]) {
            publishScratchpadPreview(job.owner, job.id, { stage: 'summarising', text: '', reasoning: '', ...(request.replies ? { replyId: reply.replyId } : {}) });
        }
        const artifact = `summary:${index}`;
        let saved = readArtifact(directories, job.id, artifact);
        if (!saved) {
            const messages = summaryMessages(text, chunk);
            const environment = scratchpadMacroEnvironment({ user: speaker.userName, char: speaker.characterName }, messages);
            const rawOptions = speaker.binding.kind === 'active' ? { trimNames: false } : {};
            await validateActiveGenerationContext(resolveGenerationProfile(directories, speaker.binding), environment,
                messages, rawOptions, { maxTokens: SUMMARY_MAX_TOKENS, preparedMessages: speaker.preparedMessages });
            const response = await generate({ binding: speaker.binding, generationType: 'quiet', messages, maxTokens: SUMMARY_MAX_TOKENS,
                macroEnvironment: environment, userName: speaker.userName, characterName: speaker.characterName, groupNames: [],
                rawOptions, preparedMessages: speaker.preparedMessages, functionTools: [], stream: false,
                stepNamespace: `scratchpad-summary:${index}`, context, jobContext: context });
            running();
            const result = characterToolReply(response, []).text;
            if (!result?.trim() || bytes(summaryContext(result)) > MAX_SUMMARY_BYTES) throw fail('SCRATCHPAD_SUMMARY_FAILED', 'The summary was empty or too long. Try again or turn off Automatic summary in Context.', 502);
            saved = { text: result.trim() };
            writeArtifact(directories, job.id, artifact, saved);
        }
        text = saved.text;
    }
    running();
    const summary = normaliseSummary({ ...plan, text });
    if (!summary) throw fail('SCRATCHPAD_SUMMARY_FAILED', 'The saved summary could not be read. Try again.', 409);
    const base = roleplayAccountBase(directories);
    withScratchpad(base, lease => {
        const bucket = readBucketLocked(lease, request.source);
        const session = findSession(bucket, request.sessionId);
        if (!session.settings.autoSummary || summaryFingerprint(session.messages.slice(0, summary.count)) !== summary.fingerprint) {
            throw fail('SCRATCHPAD_SUMMARY_CHANGED', 'The earlier discussion changed while it was being summarised. Try again.', 409);
        }
        // An older-reply retry must not replace a newer valid summary.
        if (!session.summary || session.summary.count <= summary.count
            || summaryFingerprint(session.messages.slice(0, session.summary.count)) !== session.summary.fingerprint) {
            session.summary = summary;
            writeBucketLocked(lease, bucket);
        }
    });
    return summaryContext(text);
}

async function runScratchpadReply(context, { generate, searchFetch, pageFetch, pageLookup }) {
    const { directories, job } = context;
    const request = readArtifact(directories, job.id, 'request');
    if (!request) throw fail('SCRATCHPAD_REQUEST_MISSING', 'The saved Scratchpad request is missing.', 409);
    const saved = readArtifact(directories, job.id, 'result');
    if (saved) return { artifact: true };
    try {
        const scoped = request.replies || request.webSearch || request.summary ? { ...context, providerScope: createProviderScope(context) } : context;
        const summary = await resolveSummary(scoped, request, generate);
        if (summary) {
            for (const reply of request.replies ?? [request]) {
                if (!Number.isInteger(reply.summaryIndex) || reply.summaryIndex < 0) throw fail('SCRATCHPAD_REQUEST_MISSING', 'The saved summary position is missing. Try again.', 409);
                reply.messages = reply.messages.map((message, index) => index === reply.summaryIndex ? { ...message, content: summary } : message);
            }
        }
        const webSearchResult = await resolveWebSearch(scoped, request, { searchFetch, generate });
        const webPagesResult = await resolveWebPages(scoped, request, { pageFetch, pageLookup });
        if (!request.replies) {
            await runParticipant(scoped, request, { generate, webSearchResult, webPagesResult });
            writeArtifact(directories, job.id, 'result', { replyId: request.replyId, sessionId: request.sessionId });
        } else {
            const results = await Promise.allSettled(request.replies.map(reply => runParticipant(scoped,
                { source: request.source, sessionId: request.sessionId, ...reply }, { generate, grouped: true, webSearchResult, webPagesResult })));
            const failed = results.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
            writeArtifact(directories, job.id, 'result', { replyIds: request.replies.map(reply => reply.replyId), sessionId: request.sessionId });
        }
        return { artifact: true };
    } catch (error) {
        // Preparation failures (including summary calls) must settle every reserved reply too.
        for (const reply of request.replies ?? [request]) {
            await settleReply(context, { source: request.source, sessionId: request.sessionId, ...reply },
                { state: 'failed', error: error?.message || 'The reply could not be prepared.' }).catch(() => {});
        }
        throw error;
    } finally {
        setTimeout(() => clearScratchpadPreview(job.owner, job.id), 30 * 1000).unref?.();
    }
}

async function runParticipant(context, request, { generate, grouped = false, webSearchResult = null, webPagesResult = null }) {
    const { directories, job, signal } = context;
    const artifact = grouped ? `reply:${request.replyId}` : 'reply';
    const outcome = grouped ? `outcome:${request.replyId}` : 'outcome';
    const publish = patch => publishScratchpadPreview(job.owner, job.id, { ...patch, ...(grouped ? { replyId: request.replyId } : {}) });
    // Replace the prepared reservation before the macro environment is built, so
    // fetched {{macros}} inside web text stay literal in the provider prompt.
    if (request.webSearch && !(Number.isInteger(request.searchIndex) && request.searchIndex >= 0)) {
        throw fail('SCRATCHPAD_REQUEST_MISSING', 'The saved web search position is missing. Send the message again.', 409);
    }
    if (request.webPages && !(Number.isInteger(request.pagesIndex) && request.pagesIndex >= 0)) {
        throw fail('SCRATCHPAD_REQUEST_MISSING', 'The saved position of the linked pages is missing. Send the message again.', 409);
    }
    const counter = await createMessageTokenCounter(publish, { signal });
    let streamedReasoning = '';
    const stopped = () => signal?.aborted || getJob(directories, job.id)?.cancellation?.requested;
    const requireRunning = () => {
        if (stopped()) throw fail('SCRATCHPAD_STOPPED', 'Stopped before it finished.', 409);
    };
    const messages = request.webSearch || request.webPages ? (() => {
        const value = [...request.messages];
        // The pages sit after the search results, so they are replaced first and the search position stays valid.
        if (request.webPages) value.splice(request.pagesIndex, 1,
            { role: 'user', content: buildWebPagesPrompt(request.webPages, webPagesResult) },
            { role: 'assistant', content: webPagesAcknowledgement(webPagesResult) });
        if (request.webSearch) value.splice(request.searchIndex, 1,
            { role: 'user', content: buildWebSearchPrompt(request.webSearch, webSearchResult ?? { ok: false, error: 'No web results are available.' }) },
            { role: 'assistant', content: webSearchAcknowledgement(webSearchResult) });
        return value;
    })() : request.messages;
    const webMetadata = request.webSearch ? webSearchMetadata(request.webSearch, webSearchResult ?? { ok: false, error: 'No web results are available.' }) : null;
    const pagesMetadata = request.webPages ? webPagesMetadata(request.webPages, webPagesResult) : null;
    try {
        requireRunning();
        const failure = readArtifact(directories, job.id, outcome);
        if (failure?.error) throw fail('SCRATCHPAD_REPLY_FAILED', failure.error, 502);
        let reply = readArtifact(directories, job.id, artifact);
        if (!reply) {
            publish({ stage: 'generating', text: '', reasoning: '' });
            const functionTools = await scratchpadToolsFor(context, request.binding, request.functionTools,
                { artifactName: grouped ? `model-capabilities:${request.replyId}` : 'model-capabilities' });
            requireRunning();
            const response = await generate({
                binding: request.binding,
                generationType: 'quiet',
                messages,
                maxTokens: request.maxTokens,
                macroEnvironment: scratchpadMacroEnvironment({ user: request.userName, char: request.characterName }, messages),
                userName: request.userName,
                characterName: request.characterName,
                groupNames: [],
                rawOptions: request.rawOptions,
                preparedMessages: request.preparedMessages,
                functionTools,
                stream: request.stream !== false,
                stepNamespace: grouped ? `scratchpad:${request.replyId}` : '',
                onStream: value => {
                    if (typeof value?.reasoning === 'string' && value.reasoning) streamedReasoning = value.reasoning;
                    if (request.stream !== false) {
                        const preview = { stage: 'generating', text: joinScratchpadPrefill(value?.text ?? '', request.prefillReply), reasoning: streamedReasoning };
                        publish(preview);
                        counter.publish(preview);
                    }
                },
                context,
                jobContext: context,
            });
            requireRunning();
            const { text, hasTools } = characterToolReply(response, functionTools);
            if (!text) throw fail('SCRATCHPAD_EMPTY_REPLY', 'The model returned no text. Try again or pick another connection.', 502);
            if (hasTools && bytes(text) > MAX_MESSAGE_BYTES) throw fail('SCRATCHPAD_TEXT_TOO_LARGE', 'The character drafts are too long. Ask for fewer or shorter cards.', 413);
            reply = { text: clipBytes(joinScratchpadPrefill(text, request.prefillReply), MAX_MESSAGE_BYTES), reasoning: reasoningFrom(response, streamedReasoning) };
            writeArtifact(directories, job.id, artifact, reply);
        }
        requireRunning();
        counter.stop();
        const counts = counter.counts(reply.text, reply.reasoning);
        if (!await settleReply(context, request, { state: 'done', text: reply.text, reasoning: reply.reasoning, ...counts, ...(webMetadata ? { webSearch: webMetadata } : {}), ...(pagesMetadata ? { webPages: pagesMetadata } : {}) })) {
            throw fail('SCRATCHPAD_CHANGED', 'The saved reply changed before this result could be saved.', 409);
        }
        publish({ stage: 'done', text: reply.text, reasoning: reply.reasoning, ...counts });
    } catch (error) {
        const cancelled = stopped();
        const message = cancelled ? 'Stopped before it finished.' : (error?.message || 'The reply failed.');
        try {
            await settleReply(context, request, { state: 'failed', error: message, ...(webMetadata ? { webSearch: webMetadata } : {}), ...(pagesMetadata ? { webPages: pagesMetadata } : {}) });
            writeArtifact(directories, job.id, outcome, { error: message });
        } catch {
            // The job state still reports the failure if the session file cannot be updated.
        }
        publish({ stage: 'failed', error: message });
        throw error;
    } finally {
        counter.stop();
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

export function registerScratchpadJobs({ generate = runChatProfile, searchFetch, pageFetch, pageLookup } = {}) {
    registerHandler(SCRATCHPAD_JOB_TYPE, context => runScratchpadReply(context, { generate, searchFetch, pageFetch, pageLookup }));
}

registerScratchpadJobs();

export const testExports = { historyFrom, planReply, normaliseReplyRequest, runScratchpadReply, resolveWebSearch, settleReply, reasoningFrom };
