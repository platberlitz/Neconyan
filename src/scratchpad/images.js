import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { readImageArtifact } from '../jobs/image-artifacts.js';
import { acceptJob, getJob, listJobs, providerRecoverySteps, releaseJob, requestCancellation, updateJob } from '../jobs/store.js';
import { noteOwner, registerHandler } from '../jobs/runner.js';
import { roleplayAccountBase, roleplayHash, roleplayLease, readRoleplayFile, withRoleplayAccount } from '../roleplay-store.js';
import { captureGenerationBinding } from '../generation/profiles.js';
import { requireJobApproval } from '../generation/job-approvals.js';
import { QUICK_IMAGE_GEN_EXTENSION_ID, assertQuickImageGenConfigured, saveQuickImageToUserImages } from '../generation/quick-image-gen.js';
import { generateQuickImageGenJobImage, quickImageGenSettingsFingerprint } from '../generation/quick-image-gen-job.js';
import { prepareConversationScopedImagePrompt } from '../generation/quick-image-gen-scoped.js';
import { captureQuickImageReferenceSources } from '../generation/quick-image-gen-reference.js';
import { captureQuickImageTextSettings } from '../generation/quick-image-gen-text.js';
import { resolveCharacterImageSettings } from '../../public/scripts/extensions/quick-image-gen/lib/character-settings.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { decodeServerImage } from '../media-codecs.js';
import { createMacroEnvironment } from '../macros/index.js';
import { sameSourceContext } from '../../public/scripts/scratchpad/source.js';
import { ScratchpadError, assistantConnection, findSession, findMessage, normaliseSource, requireId, newScratchpadId,
    scratchpadAccountBase, withScratchpad, readBucketLocked, writeBucketLocked, publicBucket, projectPending } from './store.js';
import { imageChangeHash, imagePart, SCRATCHPAD_IMAGE_URL } from './image-state.js';
import { resolveImageTargetLocked, readImageCardLocked } from './image-targets.js';

export const SCRATCHPAD_IMAGE_JOB = 'scratchpad.image';
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'conflict']);
const IMAGE_HASH = /^[a-f0-9]{64}$/;
const fail = (message, code = 'SCRATCHPAD_IMAGE_INVALID', status = 409) => new ScratchpadError(code, message, status);

// The availability check opens on every send; parsing a large settings file each time is wasteful.
const settingsCache = { path: '', mtimeMs: -1, size: -1, ino: -1, value: null };

function accountSettings(directories) {
    const filename = path.join(directories.root, 'settings.json');
    let stats = null;
    try { stats = fs.statSync(filename); } catch { stats = null; }
    if (stats && settingsCache.value && settingsCache.path === filename
        && settingsCache.mtimeMs === stats.mtimeMs && settingsCache.size === stats.size && settingsCache.ino === stats.ino) return settingsCache.value;
    const file = readRoleplayFile(filename, 32 * 1024 * 1024);
    if (!file) throw fail('Save your Quick Image Gen settings before generating an image.');
    const value = JSON.parse(file.bytes.toString('utf8'));
    if (stats) {
        settingsCache.path = filename;
        settingsCache.mtimeMs = stats.mtimeMs;
        settingsCache.size = stats.size;
        settingsCache.ino = stats.ino;
        settingsCache.value = value;
    }
    return value;
}

function configured(directories, scope = { kind: 'global' }) {
    const saved = accountSettings(directories);
    if (saved.extension_settings?.disabledExtensions?.includes('quick-image-gen')) throw fail('Quick Image Gen is disabled. Enable it before generating an image.');
    // Reuse the already-parsed settings instead of reading settings.json a second time.
    const block = saved.extension_settings?.[QUICK_IMAGE_GEN_EXTENSION_ID];
    const settings = resolveCharacterImageSettings(block && typeof block === 'object' ? block : {}, scope);
    assertQuickImageGenConfigured(settings);
    return { saved, settings };
}

export function readScratchpadImageAvailability(base) {
    try {
        withScratchpad(base, () => configured(base.directories));
        return { image: true, reason: '' };
    } catch {
        return { image: false, reason: 'Quick Image Gen is disabled or not configured for server images. Open Quick Image Gen to check its provider and settings.' };
    }
}

function selection(lease, source, body) {
    const bucket = readBucketLocked(lease, source);
    const session = findSession(bucket, requireId(body.sessionId, 'session'));
    const message = findMessage(session, requireId(body.messageId, 'message'));
    const index = String(body.index);
    if (!/^\d{1,3}$/.test(index) || String(Number(index)) !== index || message.role !== 'assistant' || message.state !== 'done') throw fail('Wait for a finished assistant image suggestion.');
    if (Number(index) > 23) throw fail('Image suggestions below the first 24 change blocks are not supported. Ask for a new suggestion nearer the top of the reply.');
    const part = imagePart(message.text, index);
    if (!part) throw fail('That image suggestion is no longer in this reply.');
    return { bucket, session, message, index, change: part.change, changeHash: imageChangeHash(part.change) };
}

function requireTarget(lease, source, session, message, change) {
    if (!change.character) return null;
    if (!session.settings.include.card) throw fail('Share the character card before generating or reviewing its image.');
    if (source.kind === 'general' && (!sameSourceContext(source, message.contextSource) || message.sharedAvatar !== source.avatar)) {
        throw fail('Return to the original General context and share its selected card before using this suggestion.');
    }
    return resolveImageTargetLocked(lease, source, message, change.character);
}

function assertImageLocked(lease, request, jobId) {
    const current = selection(lease, request.source, request);
    const image = current.message.images?.[request.index];
    if (!image || image.jobId !== jobId || image.changeHash !== request.changeHash || current.changeHash !== request.changeHash) {
        throw fail('The original image suggestion changed. Its provider result was not requested again.', 'SCRATCHPAD_IMAGE_CHANGED');
    }
    return current;
}

function imageSnapshot(lease, source, session, message, target, acknowledgement) {
    const { directories } = roleplayLease(lease).scope;
    const scope = target ? { avatar: target.avatar } : { kind: 'global' };
    const { saved, settings } = configured(directories, scope);
    const sd = saved.extension_settings?.sd || saved.extension_settings?.['stable-diffusion'] || {};
    const personaId = message.imagePersonaId || source.personaId || '';
    const persona = target ? String(saved.power_user?.persona_descriptions?.[personaId]?.description || '').slice(0, 64000) : '';
    const character = target ? { avatar: target.avatar, name: target.name,
        ...Object.fromEntries(['description', 'personality', 'scenario', 'creator_notes'].map(key => [key, String(target.character[key] || '').slice(0, 64000)])),
        data: { extensions: { sd_character_prompt: Object.fromEntries(['positive', 'negative'].map(key => [key,
            String(target.character.data?.extensions?.sd_character_prompt?.[key] || '').slice(0, 10000)])) } } } : null;
    const snapshot = { quickImageGenCharacterScope: scope,
        quickImageGenSettingsFingerprint: quickImageGenSettingsFingerprint(settings),
        quickImageGenSDSettingsFingerprint: quickImageGenSettingsFingerprint(sd),
        quickImageGenReferenceSources: captureQuickImageReferenceSources(directories, settings),
        macros: { names: { user: message.imageNames?.user || 'User', char: target?.name || '' },
            character: { description: character?.description || '', persona }, messages: [],
            extra: { characterScope: target ? 'character' : 'none', ...(target ? { character, characterAvatar: target.avatar } : {}) } },
        ...(target ? { speaker: { avatar: target.avatar }, target: { avatar: target.avatar } } : {}) };
    if (settings._backupContextualFilters?.some(filter => filter.enabled !== false && filter.matchMode === 'LLM'
        && (target || !filter.scope || filter.scope === 'global'))) {
        const chosen = assistantConnection(session.settings, message.assistant || session.assistant);
        const binding = settings.llmOverrideEnabled ? null : captureGenerationBinding(directories,
            chosen.kind === 'profile' ? chosen : { kind: 'active' }, acknowledgement);
        snapshot.quickImageGenTextAI = captureQuickImageTextSettings(directories, settings, binding, []);
    }
    const environment = createMacroEnvironment(snapshot.macros, {}, { readOnly: true });
    // Match Quick Image Gen: the saved negative prompt is macro-evaluated before the provider sees it.
    let negative;
    try {
        negative = String(environment.evaluate(String(settings.negativePrompt ?? ''), { strictCapabilities: true }));
    } catch {
        throw fail('Check your Quick Image Gen negative prompt.');
    }
    return { snapshot, review: Boolean(settings.reviewBeforeGenerate ?? settings.llmEditPrompt), negative };
}

// Provider step names Quick Image Gen may save for one effect, so a stopped or pruned job is never assumed free.
const PROVIDER_STEP_SUFFIXES = ['', ':submit', ':comfy-submit', ':comfy-upload', ':custom-submit'];

function hasSavedProviderResult(directories, jobId, effectId) {
    return PROVIDER_STEP_SUFFIXES.some(suffix => readArtifact(directories, jobId, `provider:quick-image:${effectId}${suffix}`) !== undefined);
}

/**
 * A terminal attempt that never reached the provider costs nothing, so a fresh request may replace it.
 * Any recorded provider step, or any saved provider receipt, means a paid request may have been sent
 * even when no final image was saved (queued, ComfyUI and Custom async providers submit before polling).
 */
function imageAttemptWasFree(directories, job) {
    if (providerRecoverySteps(job).length || (typeof job.resume === 'string' && job.resume.startsWith('provider:'))) return false;
    const request = readArtifact(directories, job.id, 'request');
    if (!request) return true;
    return !hasSavedProviderResult(directories, job.id, request.effectId);
}

/** The saved image receipt records whether the provider was reached; it outlives a pruned job. */
function imageAttemptMayBePaid(directories, job, image) {
    if (image?.providerReached === true) return true;
    return job ? !imageAttemptWasFree(directories, job) : true;
}

/** Accept a user-selected saved proposal; model-provided prompts and targets are never trusted here. */
export async function acceptScratchpadImage(request, body = {}) {
    const base = scratchpadAccountBase(request);
    const source = normaliseSource(body.source);
    const submissionKey = typeof body.submissionKey === 'string' ? body.submissionKey.trim() : '';
    if (!submissionKey || submissionKey.length > 256) throw fail('The image request needs a submission identity.');
    const requestHash = roleplayHash({ source, sessionId: body.sessionId, messageId: body.messageId, index: body.index });
    const duplicate = listJobs(base.directories, { owner: base.owner, includeDismissed: true }).find(job => job.submissionKey === submissionKey);
    if (duplicate) {
        if (duplicate.type !== SCRATCHPAD_IMAGE_JOB || duplicate.intent?.requestHash !== requestHash) throw fail('That image submission belongs to a different operation.');
        return { created: false, job: duplicate, bucket: withScratchpad(base, lease => publicBucket(projectPending(readBucketLocked(lease, source), id => getJob(base.directories, id)))) };
    }
    let accepted;
    withScratchpad(base, (lease, account) => {
        const current = selection(lease, source, body);
        const { bucket, session, message, index, change, changeHash } = current;
        const existing = message.images?.[index];
        if (message.proposals?.[index] === 'rejected') throw fail('Restore the dismissed suggestion before generating its image.');
        if (existing) {
            if (existing.changeHash !== changeHash) throw fail('This image suggestion changed after generation.');
            const previous = getJob(base.directories, existing.jobId);
            // Keep a still-running attempt, and any attempt that may have reached the provider.
            if (previous) {
                if (!TERMINAL.has(previous.state) || imageAttemptMayBePaid(base.directories, previous, existing)) {
                    accepted = { created: false, job: previous, bucket: publicBucket(projectPending(bucket, id => getJob(base.directories, id))) };
                    return;
                }
            } else if (existing.providerReached !== false) {
                // The job record was pruned, so the receipt must prove no provider request was made.
                throw fail('The earlier image request may already have been sent. Check the provider before requesting another image.', 'SCRATCHPAD_IMAGE_OUTCOME_UNKNOWN');
            }
        }
        if (Buffer.byteLength(change.prompt) > 40000 || Buffer.byteLength(change.negative) > 40000) throw fail('This image prompt is too long.');
        const target = requireTarget(lease, bucket.source, session, message, change);
        const captured = imageSnapshot(lease, bucket.source, session, message, target, body.acknowledgement);
        const { job, created } = acceptJob(base.directories, { owner: base.owner, type: SCRATCHPAD_IMAGE_JOB, submissionKey,
            intent: { kind: 'scratchpad', source: { kind: source.kind, key: source.key }, sessionId: session.id, messageId: message.id, index, changeHash, requestHash },
            automatic: false, paused: true, target: { kind: 'scratchpad', id: session.id }, label: change.target === 'avatar' ? `Scratchpad avatar for ${target.name}` : 'Scratchpad image' });
        if (!created) throw fail('The image request changed during acceptance.');
        const image = { id: newScratchpadId(), jobId: job.id, state: 'pending', target: change.target, changeHash, providerReached: false,
            prompt: change.prompt, negative: change.negative, ...(target ? { avatar: target.avatar, characterName: target.name } : {}) };
        const input = { source, sessionId: session.id, messageId: message.id, index, changeHash, account, snapshot: captured.snapshot,
            prompt: change.prompt, negative: [captured.negative, change.negative].filter(Boolean).join(', '), review: captured.review, effectId: `scratchpad-${image.id}` };
        try {
            // The request record is written first, so a crash cannot leave a bucket image pointing at a missing request.
            writeArtifact(base.directories, job.id, 'request', input);
            message.images = { ...message.images, [index]: image };
            writeBucketLocked(lease, bucket);
        } catch (error) {
            requestCancellation(base.directories, job.id, { reason: 'scratchpad-image-preparation-failed' });
            throw error;
        }
        accepted = { created: true, job, bucket: publicBucket(bucket) };
    });
    if (accepted.created) { noteOwner(base.owner); releaseJob(base.directories, accepted.job.id); accepted.job = getJob(base.directories, accepted.job.id); }
    return accepted;
}

/** Whether the job may already have sent a paid request, from its provider steps or saved receipts. */
function providerWorkStarted(directories, jobId) {
    const job = getJob(directories, jobId);
    if (!job) return false;
    if (providerRecoverySteps(job).length || (typeof job.resume === 'string' && job.resume.startsWith('provider:'))) return true;
    const request = readArtifact(directories, jobId, 'request');
    return Boolean(request && hasSavedProviderResult(directories, jobId, request.effectId));
}

function settleImage(context, request, patch) {
    const base = roleplayAccountBase(context.directories);
    const providerReached = providerWorkStarted(context.directories, context.job.id);
    return withRoleplayAccount(base, request.account, lease => {
        const current = assertImageLocked(lease, request, context.job.id);
        Object.assign(current.message.images[request.index], patch, { providerReached });
        current.session.updated = new Date().toISOString();
        writeBucketLocked(lease, current.bucket);
    });
}

export async function runScratchpadImage(context, { generate = generateQuickImageGenJobImage } = {}) {
    const request = readArtifact(context.directories, context.job.id, 'request');
    if (!request) throw fail('The saved image request is missing.');
    const sourceCheck = lease => {
        assertImageLocked(lease, request, context.job.id);
        configured(context.directories, request.snapshot.quickImageGenCharacterScope);
    };
    try {
        context.signal.throwIfAborted();
        const prepared = await prepareConversationScopedImagePrompt(context, { effectId: request.effectId, prompt: request.prompt,
            negative: request.negative, snapshot: request.snapshot, expectedAccount: request.account, assertSourceLocked: sourceCheck });
        if (request.review && !readImageArtifact(context.directories, context.job.id, `provider:quick-image:${request.effectId}`)) {
            const approval = requireJobApproval(context, { account: request.account, key: 'scratchpad-image-prompt',
                proposal: { kind: 'scratchpad-image-prompt', prompt: prepared.prompt, negative: prepared.negative }, assertSourceLocked: sourceCheck });
            if (approval.decision === null) return { waiting: true };
            if (approval.decision === 'deny') { settleImage(context, request, { state: 'cancelled', error: 'Image prompt declined.' }); return { declined: true }; }
        }
        const image = await generate(context, { effectId: request.effectId, prompt: prepared.prompt, negative: prepared.negative,
            settingsFingerprint: request.snapshot.quickImageGenSettingsFingerprint, expectedAccount: request.account,
            assertSourceLocked: sourceCheck, characterScope: request.snapshot.quickImageGenCharacterScope,
            referenceSources: request.snapshot.quickImageGenReferenceSources, seedOverride: prepared.seedOverride });
        const format = detectImageFormat(Buffer.from(image.base64, 'base64'));
        if (!format || image.format !== (format.ext === 'jpeg' ? 'jpg' : format.ext)) throw fail('The image provider returned an invalid picture.');
        const bitmap = await decodeServerImage(Buffer.from(image.base64, 'base64'));
        const url = await saveQuickImageToUserImages(context.directories, { ...image, chName: 'Scratchpad', filename: `scratchpad-${roleplayHash([context.job.id, request.effectId])}`,
            account: request.account, owner: context.owner, assertSourceLocked: lease => assertImageLocked(lease, request, context.job.id) });
        // Record the exact saved bytes so the avatar writer can prove the reviewed picture later.
        const imageHash = createHash('sha256').update(Buffer.from(image.base64, 'base64')).digest('hex');
        settleImage(context, request, { state: 'done', url: url.startsWith('/') ? url : `/${url}`, width: bitmap.width, height: bitmap.height, error: '', imageHash });
        writeArtifact(context.directories, context.job.id, 'result', { url });
        return { url };
    } catch (error) {
        const saved = readImageArtifact(context.directories, context.job.id, `provider:quick-image:${request.effectId}`);
        writeArtifact(context.directories, context.job.id, 'image-failure', { unknown: !saved && Boolean(unresolvedProviderStep(context.directories, context.job.id)) });
        // A retained paid result can be republished by retrying the same job, never by another purchase.
        const message = saved ? 'The image was generated but could not be attached. Retry its saved job to finish saving, without another image request.'
            : context.signal.aborted ? 'Image stopped.' : error.message || 'The image could not be generated.';
        try { settleImage(context, request, { state: context.signal.aborted ? 'cancelled' : 'failed', error: message }); } catch { /* The original job retains the conflict and its result. */ }
        throw error;
    }
}

export function assertScratchpadImageRetry(directories, job) {
    if (job.type === SCRATCHPAD_IMAGE_JOB && (readArtifact(directories, job.id, 'image-failure')?.unknown || unresolvedProviderStep(directories, job.id))) {
        throw fail('The earlier image provider outcome is unknown. This saved job will not purchase the image again. Check the provider before requesting another suggestion.', 'SCRATCHPAD_IMAGE_OUTCOME_UNKNOWN');
    }
}

export async function prepareScratchpadAvatarReview(base, source, body) {
    const captured = withScratchpad(base, (lease, account) => {
        const current = selection(lease, source, body);
        const image = current.message.images?.[current.index];
        if (!image || image.state !== 'done' || image.target !== 'avatar' || !SCRATCHPAD_IMAGE_URL.test(image.url)) throw fail('Generate and save the avatar image before reviewing it.');
        const target = requireTarget(lease, current.bucket.source, current.session, current.message, current.change);
        if (target.avatar !== image.avatar) throw fail('The avatar suggestion belongs to a different card.');
        const filename = path.join(base.directories.root, image.url.replace(/^\//, ''));
        const generated = readRoleplayFile(filename, 20 * 1024 * 1024);
        const format = generated && detectImageFormat(generated.bytes);
        if (!format || !['png', 'jpeg', 'webp'].includes(format.ext)) throw fail('This generated picture cannot be used as a card avatar. Download it separately.');
        if (!IMAGE_HASH.test(image.imageHash) || generated.rawHash !== image.imageHash) throw fail('The saved avatar picture could not be verified. Generate it again.');
        return { avatar: target.avatar, name: target.name, bytes: target.file.bytes, revision: target.file.rawHash, url: image.url, account };
    });
    const previousAvatarUrl = await saveQuickImageToUserImages(base.directories, { base64: captured.bytes.toString('base64'), format: 'png', chName: 'Scratchpad',
        filename: `scratchpad-avatar-before-${roleplayHash([captured.avatar, captured.revision])}`, owner: base.owner, account: captured.account,
        assertSourceLocked: lease => { if (readImageCardLocked(lease, captured.avatar).file.rawHash !== captured.revision) throw fail('The card changed while preserving its previous picture. Review it again.'); } });
    return withRoleplayAccount(base, captured.account, lease => {
        const current = selection(lease, source, body);
        const target = requireTarget(lease, current.bucket.source, current.session, current.message, current.change);
        if (target.avatar !== captured.avatar || target.file.rawHash !== captured.revision) throw fail('The character changed before the avatar review. Review it again.');
        Object.assign(current.message.images[current.index], { previousAvatarUrl: previousAvatarUrl.startsWith('/') ? previousAvatarUrl : `/${previousAvatarUrl}`, previousAvatarRevision: captured.revision });
        writeBucketLocked(lease, current.bucket);
        return { avatar: captured.avatar, name: captured.name, revision: captured.revision, currentUrl: current.message.images[current.index].previousAvatarUrl,
            proposedUrl: captured.url, bucket: publicBucket(current.bucket) };
    });
}

/** Called inside the character writer's account lease, not just when opening the review. */
export function assertScratchpadAvatarWriteLocked(lease, input, avatar, revision) {
    let body;
    try {
        if (typeof input !== 'string' || Buffer.byteLength(input) > 10000) throw new Error();
        body = JSON.parse(input);
    } catch { throw fail('The Scratchpad avatar review identity is invalid.'); }
    const source = normaliseSource(body.source);
    const current = selection(lease, source, body);
    const image = current.message.images?.[current.index];
    if (!image || image.state !== 'done' || image.target !== 'avatar' || image.avatar !== avatar || image.previousAvatarRevision !== revision
        || !SCRATCHPAD_IMAGE_URL.test(image.previousAvatarUrl) || current.message.proposals?.[current.index] === 'rejected') throw fail('Review this saved avatar suggestion again before replacing the card.');
    const target = requireTarget(lease, current.bucket.source, current.session, current.message, current.change);
    if (target.avatar !== avatar) throw fail('The shared avatar target changed.');
    const root = roleplayLease(lease).scope.directories.root;
    const backup = readRoleplayFile(path.join(root, image.previousAvatarUrl.replace(/^\//, '')), 64 * 1024 * 1024);
    if (!backup || backup.rawHash !== revision) throw fail('The saved previous picture could not be verified. Nothing was replaced.');
    // The saved proposal is the only picture the writer may install; browser-supplied bytes are never trusted.
    if (!SCRATCHPAD_IMAGE_URL.test(image.url) || !IMAGE_HASH.test(image.imageHash)) throw fail('The saved avatar picture could not be verified. Generate it again.');
    let proposed;
    try { proposed = readRoleplayFile(path.join(root, image.url.replace(/^\//, '')), 20 * 1024 * 1024); } catch {
        throw fail('The saved avatar picture could not be read. Review the current card again.');
    }
    if (!proposed) throw fail('The saved avatar picture is no longer available. Generate it again.');
    if (proposed.rawHash !== image.imageHash) throw fail('The saved avatar picture changed after review. Review it again.');
    return proposed.bytes;
}

export function finalizeScratchpadImageSubmission(context) {
    const job = context.job;
    if (job.type !== SCRATCHPAD_IMAGE_JOB || job.state !== 'waiting' || job.stage !== 'preparing' || job.cancellation?.requested) return false;
    if (readArtifact(context.directories, job.id, 'request')) { releaseJob(context.directories, job.id); return true; }
    if (Date.now() - job.createdAt < 60000) return false;
    updateJob(context.directories, job.id, { state: 'failed', stage: null, finishedAt: Date.now(), error: { code: 'SCRATCHPAD_IMAGE_PREPARE_FAILED', message: 'The image request could not be prepared. Ask for a new suggestion.' } });
    return true;
}

export function registerScratchpadImageJobs(options = {}) { registerHandler(SCRATCHPAD_IMAGE_JOB, context => runScratchpadImage(context, options)); }
registerScratchpadImageJobs();
