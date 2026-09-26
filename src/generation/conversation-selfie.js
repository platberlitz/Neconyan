import { DEFAULT_SETTINGS } from '../../public/scripts/neconyan-conversation/constants.js';
import { formatPromptText } from '../../public/scripts/neconyan-conversation/shared-helpers.js';
import { buildSelfieImagePromptTemplate, normalizeConversationOutputText } from '../../public/scripts/neconyan-conversation/generation-utils.js';
import { isConversationGroupSpeakerEligible, stripSpeakerPrefixText } from '../../public/scripts/neconyan-conversation/partners-utils.js';
import { runChatProfile, validateActiveGenerationContext } from './service.js';
import { resolveGenerationProfile } from './profiles.js';
import { normalizeBindingRequest, normalizeSubmissionAnchors, preflightConversationBindings } from './conversation-jobs.js';
import { buildConversationParticipantSnapshot } from './conversation-participants.js';
import { buildConversationImagePrompt, characterImageDetails, renderConversationImage } from './conversation-images.js';
import { createMacroEnvironment } from '../macros/index.js';
import { hash } from '../mewmory/core.js';
import { readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { acceptJob, getJob, listJobs, releaseJob, setJobResume, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { getConversationThreadKey } from '../endpoints/conversation-store.js';
import { appendConversationJobMessage, captureConversationTarget, commitConversationEffect, readConversationTarget } from './conversation-effects.js';
import { withRoleplayAccount } from '../roleplay-store.js';
import { createConversationNarrator } from './conversation-narration.js';

const SELFIE_SCENE = 'a casual selfie in the current moment';
const FALLBACK_CAPTION = 'Here, I took this for you.';
const MAX_CONTEXT_CHARS = 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const PROMPT_SYSTEM = 'You output only a raw image generation prompt with no preamble.';
const CAPTION_SYSTEM = 'You write only a short in-character chat caption. No speaker labels, no stage directions, no preamble.';

function fail(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

function scopedRequest(context) {
    return { user: { profile: { handle: context.owner }, directories: context.directories } };
}

function selfieRequestHash(body) {
    const target = body.target || {};
    return hash({
        kind: 'selfie',
        target: { avatar: target.avatar || '', groupId: target.groupId || '', personaId: target.personaId || '', branchId: target.branchId || '' },
        anchors: normalizeSubmissionAnchors(body), speakerAvatar: body.speakerAvatar || '', context: body.context ?? '',
        sourceMessageId: body.sourceMessageId || '', bindingRequest: normalizeBindingRequest(body.bindingRequest) || null,
        acknowledgement: body.acknowledgement ?? null,
    });
}

function imagePromptRequest(snapshot) {
    const details = characterImageDetails(snapshot.macros?.extra?.character);
    return [
        'You are an image prompt generator. Write a concise, detailed image generation prompt for a selfie photo.',
        `Character name: ${snapshot.characterName}.`,
        details ? `Appearance: ${details}` : '',
        snapshot.context ? `Photo context: ${snapshot.context}` : `Photo context: ${SELFIE_SCENE}.`,
        'Include appearance, clothing, expression and selfie pose, setting/background, and lighting. Output ONLY the prompt text, nothing else.',
    ].filter(Boolean).join('\n');
}

function captionRequest(snapshot, imagePrompt) {
    const character = snapshot.macros?.extra?.character || {};
    return [
        `Character name: ${snapshot.characterName}.`,
        character.description ? `Description: ${formatPromptText(character.description, 900)}` : '',
        character.personality ? `Personality: ${formatPromptText(character.personality, 700)}` : '',
        snapshot.context ? `Selfie context: ${formatPromptText(snapshot.context, 400)}` : `Selfie context: ${SELFIE_SCENE}.`,
        imagePrompt ? `Generated image prompt: ${formatPromptText(imagePrompt, 600)}` : '',
        'Write one short in-character chat message to accompany this selfie. Keep it natural, under 25 words, and output only the message text.',
    ].filter(Boolean).join('\n');
}

function generationOptions(snapshot, system, prompt, maxTokens) {
    const active = snapshot.binding.kind === 'active';
    return {
        binding: snapshot.binding,
        messages: active ? [{ role: 'user', content: prompt }] : [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        maxTokens,
        macroEnvironment: createMacroEnvironment(snapshot.macros || {}),
        userName: snapshot.userName || 'User',
        characterName: snapshot.characterName || 'Character',
        groupNames: snapshot.groupNames || [],
        rawOptions: active ? { systemPrompt: system } : {},
    };
}

/**
 * A selfie is a new message, so it depends only on its branch and speaker.
 * Other messages arriving or changing while the image renders keep it valid.
 */
function verifySelfieSource(current, snapshot) {
    if (String(current.branch.createdAt) !== String(snapshot.target.createdAt)) {
        throw fail('The Conversation branch was replaced before the selfie was posted.', 409);
    }
    if (snapshot.target.groupId && !isConversationGroupSpeakerEligible(current.group, snapshot.speakerAvatar)) {
        throw fail('The selfie speaker is no longer available in this group.', 409);
    }
    return current;
}

async function finalizeSelfieSubmission(request, job, preparedSnapshot) {
    try {
        const snapshot = preparedSnapshot || readArtifact(request.user.directories, job.id, 'request');
        if (!snapshot) throw fail('The selfie request was not saved before the server stopped. Try again.', 409);
        if (job.config?.requestHash && hash(snapshot) !== job.config.requestHash) throw fail('The accepted selfie request changed during preparation.', 409);
        writeArtifact(request.user.directories, job.id, 'request', snapshot);
    } catch (error) {
        updateJob(request.user.directories, job.id, {
            state: 'failed', stage: null, finishedAt: Date.now(),
            error: { message: error?.message || 'The selfie request could not be prepared.', code: error?.code || 'SELFIE_PREPARE_FAILED' },
            recoverability: 'needs-retry',
        });
        return getJob(request.user.directories, job.id);
    }
    releaseJob(request.user.directories, job.id);
    return getJob(request.user.directories, job.id);
}

/**
 * Accept a manual selfie: the server writes the image prompt with the captured
 * connection, renders it through Quick Image Gen, writes a caption and posts
 * the picture, all without the page staying open.
 */
export async function acceptConversationSelfie(request, body = {}) {
    const owner = request.user?.profile?.handle;
    const directories = request.user?.directories;
    if (!owner || !directories?.root) throw fail('An authenticated account is required.', 401);
    if (typeof body.submissionKey !== 'string' || !body.submissionKey || body.submissionKey.length > 256) throw fail('A submission key is required.');
    if (!body.target || typeof body.target !== 'object' || Array.isArray(body.target)) throw fail('A Conversation target is required.');
    if (body.context !== undefined && typeof body.context !== 'string') throw fail('The selfie description is invalid.');
    if (String(body.context || '').length > MAX_CONTEXT_CHARS) throw fail('The selfie description is too long.');
    if (body.sourceMessageId !== undefined && (typeof body.sourceMessageId !== 'string' || body.sourceMessageId.length > 256)) {
        throw fail('The selfie source message is invalid.');
    }
    const requestHash = selfieRequestHash(body);
    const recorded = listJobs(directories, { owner, includeDismissed: true }).find(item => item.submissionKey === body.submissionKey);
    if (recorded) {
        if (recorded.type !== 'conversation.selfie' || recorded.intent?.requestHash !== requestHash) throw fail('This submission key already belongs to another operation.', 409);
        return { created: false, job: recorded };
    }
    const submitted = normalizeBindingRequest(body.bindingRequest);
    if (!submitted) throw fail('A captured connection is required.');
    const anchors = normalizeSubmissionAnchors(body);
    if (!anchors.branchCreatedAt) throw fail('The Conversation branch was not captured.');
    if (body.sourceMessageId && !anchors.triggers.some(anchor => anchor.messageId === body.sourceMessageId)) {
        throw fail('The selfie request message must be part of the captured context.');
    }
    const target = captureConversationTarget(request, body.target);
    const speakerAvatar = String(body.speakerAvatar || target.avatar);
    const captured = await preflightConversationBindings(request, { ...body, speakerAvatar, bindingOnly: true, acknowledgement: submitted.acknowledgement });
    if (hash(normalizeBindingRequest(captured)) !== hash(submitted)) throw fail('The captured connection changed. Try again.', 409);
    const binding = submitted.participants[speakerAvatar];
    if (!binding) throw fail('The selected speaker has no captured connection.', 409);
    const current = readConversationTarget(request, target);
    const participant = await buildConversationParticipantSnapshot(request, current, target, { avatar: speakerAvatar },
        { binding, directive: '', timeZone: 'UTC', image: true });
    const imageSnapshot = { ...participant };
    delete imageSnapshot.messages;
    const partner = speakerAvatar !== target.avatar;
    const snapshot = {
        ...imageSnapshot,
        kind: 'selfie', target, anchors, speakerAvatar, binding,
        context: String(body.context || '').trim(),
        characterName: participant.speaker.name || 'Character',
        role: partner ? 'partner' : 'character',
        extra: partner ? { partner_avatar: speakerAvatar } : {},
    };
    const options = generationOptions(snapshot, PROMPT_SYSTEM, imagePromptRequest(snapshot), 200);
    await validateActiveGenerationContext(resolveGenerationProfile(directories, binding), options.macroEnvironment, options.messages, options.rawOptions,
        { maxTokens: options.maxTokens, groupNames: options.groupNames });
    const accepted = acceptJob(directories, {
        owner, type: 'conversation.selfie', submissionKey: body.submissionKey,
        intent: { kind: 'selfie', target, speakerAvatar, requestHash },
        automatic: false, paused: true, coalesce: { deadline: 0, members: [] },
        target: { kind: 'conversation', id: getConversationThreadKey(target.avatar, target.groupId, target.personaId), branchId: target.branchId },
        credentialRef: binding, config: { requestHash: hash(snapshot) },
        label: 'Conversation selfie',
    });
    noteOwner(owner);
    if (!accepted.created) return { created: false, job: accepted.job };
    const job = await finalizeSelfieSubmission(request, accepted.job, snapshot);
    return { created: true, job };
}

async function generateOnce(context, snapshot, name, options, assertSource, generate) {
    const saved = readArtifact(context.directories, context.job.id, name);
    if (saved) return String(saved.text ?? '');
    assertSource();
    const response = await generate({ ...options, context, jobContext: context, beforeDispatch: assertSource });
    const text = String(response?.text ?? '');
    writeArtifact(context.directories, context.job.id, name, { text: Buffer.byteLength(text) > MAX_RESPONSE_BYTES ? '' : text });
    return text;
}

async function runConversationSelfieJob(context, { generate, fetchImpl, narrate }) {
    const { directories, job } = context;
    const snapshot = readArtifact(directories, job.id, 'request');
    if (!snapshot) throw fail('The selfie request is missing.', 409);
    const finished = readArtifact(directories, job.id, 'result');
    if (finished) return { artifact: true };
    const request = scopedRequest(context);
    const verify = current => verifySelfieSource(current, snapshot);
    const assertSourceLocked = () => verify(readConversationTarget(request, snapshot.target));
    const assertSource = () => withRoleplayAccount({ owner: context.owner, directories }, snapshot.quickImageGenAccount ?? null, assertSourceLocked);
    const speaker = { avatar: snapshot.speakerAvatar, name: snapshot.characterName };
    const scene = snapshot.context || SELFIE_SCENE;

    let image = readArtifact(directories, job.id, 'selfie-image');
    if (!image?.url) {
        const rawPrompt = await generateOnce(context, snapshot, 'prompt-reply',
            generationOptions(snapshot, PROMPT_SYSTEM, imagePromptRequest(snapshot), 200), assertSourceLocked, generate);
        const prompt = buildConversationImagePrompt(
            buildSelfieImagePromptTemplate(formatPromptText(rawPrompt, 600), snapshot.settings?.selfie_prompt || DEFAULT_SETTINGS.selfie_prompt, scene),
            scene, snapshot.macros?.extra?.character);
        assertSource();
        const url = await renderConversationImage(context, snapshot, { effectName: 'selfie-image', prompt, speaker, assertSourceLocked, fetchImpl });
        image = { url, prompt };
    }
    await commitConversationEffect(context, snapshot.target, 'selfie-mark', branch => {
        branch.sessionMarkers = { ...(branch.sessionMarkers || {}), image_at: Date.now() };
        return true;
    }, { verify });

    let caption = '';
    try {
        const raw = await generateOnce(context, snapshot, 'caption-reply',
            generationOptions(snapshot, CAPTION_SYSTEM, captionRequest(snapshot, image.prompt), 80), assertSourceLocked, generate);
        caption = normalizeConversationOutputText(stripSpeakerPrefixText(formatPromptText(raw, 240), snapshot.characterName, normalizeConversationOutputText));
    } catch (error) {
        // The picture is already paid for; a refused caption falls back to the
        // stock line instead of discarding it. Cancellation, changed context
        // and an unknown caption outcome still stop the post, keeping the
        // picture for an explicit retry.
        if (error?.name === 'AbortError' || error?.status === 409 || context.signal?.aborted
            || unresolvedProviderStep(directories, job.id)) throw error;
        writeArtifact(directories, job.id, 'caption-reply', { text: '', error: String(error?.message || 'Caption failed.').slice(0, 500) });
    }
    const text = caption || FALLBACK_CAPTION;
    const narration = narrate ? await narrate(context, snapshot, text, speaker, { effectId: 'selfie', verify }) : null;
    setJobResume(directories, job.id, 'apply');
    const posted = await appendConversationJobMessage(context, snapshot.target, 'selfie', {
        role: snapshot.role,
        name: snapshot.characterName,
        mes: text,
        extra: { ...snapshot.extra, conversation_mode_image: true, image_url: image.url, image_prompt: image.prompt },
    }, { verify, presentation: { narration } });
    writeArtifact(directories, job.id, 'result', { messageId: posted?.id || '', url: image.url });
    return { artifact: true };
}

/** Finish a paused selfie the worker found after a crash. */
export function finalizeConversationSelfieSubmission(request, job) {
    return finalizeSelfieSubmission(request, job);
}

export function registerConversationSelfieJobs({ generate = runChatProfile, fetchImpl, narrate = createConversationNarrator() } = {}) {
    registerHandler('conversation.selfie', context => runConversationSelfieJob(context, { generate, fetchImpl, narrate }));
}

registerConversationSelfieJobs();

export const testExports = { runConversationSelfieJob, verifySelfieSource };
