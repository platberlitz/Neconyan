import { Buffer } from 'node:buffer';

import { providerNotDispatched, providerStep, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { getJob } from '../jobs/store.js';
import { roleplayHash } from '../roleplay-store.js';
import { extractProviderImageSource } from '../../public/scripts/extensions/quick-image-gen/lib/provider-adapters.js';
import { validateReplicateSdxlVersion } from '../../public/scripts/extensions/quick-image-gen/lib/provider-capabilities.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { abortableSleep, buildCivitaiWorkflowBody, createHostedProviderDeadline, fetchCivitaiOutput,
    getCivitaiWorkflowImageUrls, getRetryAfterMs, isTransientProviderStatus, parseCivitaiLoras,
} from '../../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';
import { readResponseArrayBuffer, readResponseText } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';

const fail = (message, code = 'QIG_PROVIDER_ERROR') => Object.assign(new Error(message), { status: 409, code });
const endpoint = Object.freeze({
    replicate: 'https://api.replicate.com/v1/predictions',
    civitai: 'https://orchestration.civitai.com/v2/consumer/workflows',
});

/** Build only the input that may be persisted, never the account's private API key. */
export function buildQueuedImageRequest(provider, settings, prompt, negative) {
    const seed = settings.seed;
    if (!Number.isSafeInteger(seed) || seed < 0) throw fail('The saved image seed is invalid.', 'QIG_INVALID_INPUT');
    if (provider === 'replicate') {
        return { version: validateReplicateSdxlVersion(settings.replicateModel), input: {
            prompt, negative_prompt: negative,
            width: Number(settings.width) || 1024, height: Number(settings.height) || 1024,
            num_inference_steps: Number(settings.steps) || 25, guidance_scale: Number(settings.cfgScale) || 7,
            seed, num_outputs: 1,
            scheduler: ({ euler_a: 'K_EULER_ANCESTRAL', euler: 'K_EULER',
                'dpm++_2m': 'DPMSolverMultistep', 'dpm++_sde': 'DPM++SDE',
                ddim: 'DDIM', lms: 'K_LMS', heun: 'K_HEUN' })[settings.sampler] || 'K_EULER',
        } };
    }
    if (provider === 'civitai') {
        return buildCivitaiWorkflowBody({ model: settings.civitaiModel, prompt, negativePrompt: negative,
            sampler: settings.civitaiScheduler || settings.sampler, steps: Number(settings.steps) || 25,
            cfgScale: Number(settings.cfgScale) || 7, width: Number(settings.width) || 1024,
            height: Number(settings.height) || 1024, seed, loras: parseCivitaiLoras(settings.civitaiLoras) });
    }
    throw fail('This provider cannot submit a queued image.', 'QIG_PROVIDER_UNSUPPORTED');
}

function providerKey(provider, settings) {
    const value = provider === 'replicate' ? settings.replicateKey : settings.civitaiKey;
    if (typeof value !== 'string' || !value.trim()) throw fail('The saved image provider key is unavailable.', 'QIG_MISSING_KEY');
    return value.trim();
}

function imageFromResponse(response) {
    return readResponseArrayBuffer(response).then(value => {
        const bytes = Buffer.from(value);
        const format = detectImageFormat(bytes);
        if (!format) throw fail('The queued provider returned an unsupported image.', 'QIG_BAD_IMAGE');
        return { base64: bytes.toString('base64'), format: format.ext === 'jpeg' ? 'jpg' : format.ext };
    });
}

async function json(response) {
    try { return JSON.parse(await readResponseText(response, 1024 * 1024)); } catch {
        throw fail('The queued provider returned invalid JSON.');
    }
}

function checkResponse(response, action) {
    if (!response.ok) throw fail(`The queued provider ${action} failed with HTTP ${response.status}.`);
}

/** The submit receipt is separate from subsequent read-only polling. */
export async function generateQueuedImageJob(context, { effectId, input, settings, fingerprint, fetchImpl,
    readSettings, materializeSource, wait = abortableSleep } = {}) {
    const provider = input.provider;
    const name = `quick-image:${effectId}`;
    const body = buildQueuedImageRequest(provider, { ...settings, seed: input.seed }, input.prompt, input.negative);
    const sourceHash = roleplayHash({ fingerprint, provider, prompt: input.prompt, negative: input.negative, body });
    const inputName = `input:${name}:queued`;
    const savedInput = readArtifact(context.directories, context.job.id, inputName);
    if (savedInput !== undefined) {
        const { hash, ...data } = savedInput ?? {};
        if (data.sourceHash !== sourceHash || data.provider !== provider || hash !== roleplayHash(data)) {
            throw fail('The queued image input does not match the accepted request.', 'QIG_RESULT_RECOVERY');
        }
    } else {
        const data = { sourceHash, provider, body };
        writeArtifact(context.directories, context.job.id, inputName, { ...data, hash: roleplayHash(data) });
    }
    const submitStep = `${name}:submit`;
    if (readArtifact(context.directories, context.job.id, `provider:${submitStep}`) === undefined
        && getJob(context.directories, context.job.id)?.resume === `provider:${submitStep}`) {
        throw fail('The queued image submission outcome is unknown and cannot be repeated automatically.', 'QIG_RESULT_RECOVERY');
    }
    const deadline = createHostedProviderDeadline(context.signal, settings.hostedTimeout, provider);
    try {
        const submission = await providerStep(context, submitStep, async () => {
            if (roleplayHash(readSettings()) !== fingerprint) {
                throw providerNotDispatched(fail('The queued provider settings changed before submission.', 'QIG_SETTINGS_CHANGED'));
            }
            const url = `${endpoint[provider]}${provider === 'civitai' ? '?wait=0' : ''}`;
            const response = await fetchImpl(url, { method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${providerKey(provider, settings)}` },
                body: JSON.stringify(savedInput?.body ?? body), signal: deadline.signal, redirect: 'error' });
            checkResponse(response, 'submission');
            const result = await json(response);
            const id = result?.id;
            if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\r\n]/.test(id)) {
                throw fail('The queued provider did not return an image request ID.');
            }
            return { id, sourceHash };
        });
        if (submission?.sourceHash !== sourceHash || typeof submission.id !== 'string' || !submission.id) {
            throw fail('The saved queued image submission needs recovery.', 'QIG_RESULT_RECOVERY');
        }
        const key = providerKey(provider, settings);
        while (true) {
            await wait(1500, deadline.signal);
            const url = `${endpoint[provider]}/${encodeURIComponent(submission.id)}`;
            const status = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` },
                signal: deadline.signal, redirect: 'error' });
            if (!status.ok && isTransientProviderStatus(status.status)) {
                await wait(getRetryAfterMs(status), deadline.signal);
                continue;
            }
            checkResponse(status, 'polling');
            const result = await json(status);
            const state = String(result?.status || '').toLowerCase();
            if (state === 'succeeded') {
                // Await the image body before finally removes timeout and cancellation protection.
                if (provider === 'replicate') {
                    const source = extractProviderImageSource({ output: result.output });
                    if (!source) throw fail('Replicate completed without an image.', 'QIG_BAD_IMAGE');
                    return await materializeSource(source, fetchImpl, deadline.signal, provider, key);
                }
                const url = getCivitaiWorkflowImageUrls(result)[0];
                if (!url) throw fail('CivitAI completed without an image.', 'QIG_BAD_IMAGE');
                const output = await fetchCivitaiOutput(url, key, { fetchImpl, signal: deadline.signal });
                checkResponse(output, 'download');
                return await imageFromResponse(output);
            }
            if (['failed', 'expired', 'canceled', 'cancelled'].includes(state)) throw fail(`The queued image request ${state}.`);
        }
    } finally {
        deadline.dispose();
    }
}
