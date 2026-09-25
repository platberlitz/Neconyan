import { Blob } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';

import { providerNotDispatched, providerStep, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { getJob } from '../jobs/store.js';
import { roleplayHash } from '../roleplay-store.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { buildComfyBuiltinWorkflow, buildComfyPromptRequest, getComfyWorkflowCapabilities,
    normalizeComfySettings, parseComfyPromptResponse, parseComfyWorkflow, pollComfyHistory,
} from '../../public/scripts/extensions/quick-image-gen/lib/comfyui-backend.js';
import { createHostedProviderDeadline } from '../../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';
import { MAX_IMAGE_BYTES, readResponseArrayBuffer, readResponseText } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { prepareQuickImageReference } from './quick-image-gen-reference.js';

const invalid = (message, code = 'QIG_COMFY_INVALID') => Object.assign(new Error(message), { status: 409, code });
const recovery = message => invalid(message, 'QIG_RESULT_RECOVERY');
const samplerNames = {
    euler_a: 'euler_ancestral', 'dpm++_2m': 'dpmpp_2m', 'dpm++_sde': 'dpmpp_sde',
    'dpm++_2m_sde': 'dpmpp_2m_sde', 'dpm++_3m_sde': 'dpmpp_3m_sde',
    'dpm++_2s_ancestral': 'dpmpp_2s_ancestral', plms: 'euler',
};

export function comfyImageBaseUrl(settings) {
    const value = String(settings.localUrl || '').trim().replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(value); } catch { throw invalid('A saved ComfyUI address is required.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
        throw invalid('The saved ComfyUI address is invalid.');
    }
    return parsed.href.replace(/\/+$/, '');
}

function parameters(settings, input, clientId, uploadedReference = '') {
    const normal = normalizeComfySettings(settings);
    const sampler = String(settings.sampler || 'euler').trim();
    const denoise = Number(settings.comfyDenoise);
    const clipSkip = Number.parseInt(settings.comfyClipSkip, 10);
    return {
        prompt: input.prompt, negativePrompt: input.negative, seed: input.seed,
        width: Number(settings.width) || 1024, height: Number(settings.height) || 1024,
        steps: Number(settings.steps) || 25, cfgScale: Number(settings.cfgScale) || 7,
        denoise: Number.isFinite(denoise) && denoise > 0 ? denoise : 1,
        clipSkip: Number.isSafeInteger(clipSkip) && clipSkip > 0 ? clipSkip : 1,
        samplerName: samplerNames[sampler] || sampler.replaceAll('++', 'pp'),
        schedulerName: settings.comfyScheduler || 'normal', modelName: settings.localModel || 'model.safetensors',
        referenceImages: uploadedReference ? [uploadedReference] : [],
        batchIndex: input.batch?.index ?? 0, batchCount: input.batch?.count ?? 1, clientId, filenamePrefix: 'qig',
        modelLoader: normal.comfyModelLoader, vaeModel: normal.comfyFluxVaeModel,
    };
}

function addBuiltinControls(nodes, refs, settings, values, reference) {
    let nextId = Math.max(...Object.keys(nodes).map(Number).filter(Number.isFinite)) + 1;
    const allocate = () => String(nextId++);
    let model = refs.model;
    let clip = refs.clip;
    for (const item of String(settings.comfyLoras || '').split(',').map(value => value.trim()).filter(Boolean)) {
        const split = item.lastIndexOf(':');
        const maybeWeight = split > 0 ? Number.parseFloat(item.slice(split + 1)) : NaN;
        const name = Number.isFinite(maybeWeight) ? item.slice(0, split).trim() : item;
        if (!name || name.length > 1024) throw invalid('The saved ComfyUI LoRA is invalid.');
        const id = allocate();
        nodes[id] = { class_type: 'LoraLoader', inputs: { lora_name: name,
            strength_model: Number.isFinite(maybeWeight) ? maybeWeight : 0.8,
            strength_clip: Number.isFinite(maybeWeight) ? maybeWeight : 0.8, model, clip } };
        model = [id, 0];
        clip = [id, 1];
    }
    nodes['3'].inputs.model = model;
    if (values.clipSkip > 1) nodes['10'].inputs.clip = clip;
    else {
        nodes['6'].inputs.clip = clip;
        if (nodes['7']) nodes['7'].inputs.clip = clip;
    }
    if (reference && values.denoise < 1) {
        nodes['5'] = { class_type: 'LoadImage', inputs: { image: reference } };
        const id = allocate();
        nodes[id] = { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: refs.vae } };
        nodes['3'].inputs.latent_image = [id, 0];
    }
    if (settings.comfyUpscale && settings.comfyUpscaleModel) {
        const loader = allocate();
        const scale = allocate();
        nodes[loader] = { class_type: 'UpscaleModelLoader', inputs: { model_name: settings.comfyUpscaleModel } };
        nodes[scale] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: [loader, 0], image: ['8', 0] } };
        nodes['9'].inputs.images = [scale, 0];
    }
    parseComfyWorkflow(nodes);
    return { prompt: nodes };
}

export function buildComfyImageWorkflow(settings, input, clientId, uploadedReference = '') {
    if (!Number.isSafeInteger(input.seed) || input.seed < 0 || typeof clientId !== 'string' || !clientId) {
        throw invalid('The ComfyUI image request has invalid saved inputs.');
    }
    const values = parameters(settings, input, clientId, uploadedReference);
    const custom = typeof settings.comfyWorkflow === 'string' && !!settings.comfyWorkflow.trim();
    if (custom) {
        const capability = getComfyWorkflowCapabilities(settings.comfyWorkflow, values, settings.comfyWorkflowComponentOverrides);
        const needsReference = !!settings.localRefImage && capability.referenceImages;
        const body = buildComfyPromptRequest(settings.comfyWorkflow, values, settings.comfyWorkflowComponentOverrides);
        return { body: { ...body, client_id: clientId }, needsReference };
    }
    const built = buildComfyBuiltinWorkflow({ modelLoader: values.modelLoader, modelName: values.modelName,
        clipModel1: settings.comfyFluxClipModel1, clipModel2: settings.comfyFluxClipModel2,
        vaeModel: values.vaeModel, clipType: settings.comfyFluxClipType,
        skipNegativePrompt: settings.comfySkipNegativePrompt, clipSkip: values.clipSkip,
        prompt: values.prompt, negativePrompt: values.negativePrompt, seed: values.seed,
        width: values.width, height: values.height, steps: values.steps, cfgScale: values.cfgScale,
        samplerName: values.samplerName, schedulerName: values.schedulerName, denoise: values.denoise });
    const needsReference = !!settings.localRefImage && values.denoise < 1;
    return { body: { ...addBuiltinControls(built.workflow, built.refs, settings, values, uploadedReference), client_id: clientId }, needsReference };
}

export function assertComfyImageConfigured(settings, prompt, negative, seed) {
    comfyImageBaseUrl(settings);
    buildComfyImageWorkflow(settings, { prompt, negative, seed }, 'preflight', settings.localRefImage ? 'qig_ref_preflight.png' : '');
}

function checkPreviousStep(context, name) {
    const step = `provider:${name}`;
    if (readArtifact(context.directories, context.job.id, step) === undefined
        && getJob(context.directories, context.job.id)?.resume === step) {
        throw recovery('The previous ComfyUI request outcome is unknown and cannot be repeated automatically.');
    }
}

function validateDescriptor(result, expected) {
    const name = typeof result?.name === 'string' ? result.name : expected;
    const subfolder = typeof result?.subfolder === 'string' ? result.subfolder : '';
    const type = typeof result?.type === 'string' && result.type ? result.type : 'input';
    if (!/^qig_ref_[a-f0-9]{24}(?:_\d+)?\.(?:png|jpg|jpeg|webp|gif|bmp|tiff|avif)$/.test(name)
        || subfolder.length > 512 || subfolder.split('/').some(part => part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))
        || !['input', 'temp'].includes(type)) throw invalid('ComfyUI returned an invalid reference image name.');
    return { name, subfolder, type };
}

/** Upload and workflow POST each keep their own paid outcome; history and output GET can resume. */
export async function generateComfyImageJob(context, { effectId, input, settings, fingerprint, fetchImpl,
    readSettings, readSettingsLocked, withAccount, wait } = {}) {
    const baseUrl = comfyImageBaseUrl(settings);
    const sourceHash = roleplayHash({ fingerprint, effectId, prompt: input.prompt, negative: input.negative,
        seed: input.seed, baseUrl, ...(input.batch ? { batch: input.batch } : {}) });
    const manifestName = `input:quick-image:${effectId}:comfy`;
    const manifest = withAccount(() => {
        const previous = readArtifact(context.directories, context.job.id, manifestName);
        if (previous !== undefined) {
            if (previous?.sourceHash !== sourceHash || !/^[0-9a-f-]{36}$/.test(previous?.clientId)
                || previous?.hash !== roleplayHash({ sourceHash, clientId: previous.clientId })) {
                throw recovery('The ComfyUI input changed after it was saved.');
            }
            return previous;
        }
        const data = { sourceHash, clientId: randomUUID() };
        writeArtifact(context.directories, context.job.id, manifestName, { ...data, hash: roleplayHash(data) });
        return data;
    });
    const preview = buildComfyImageWorkflow(settings, input, manifest.clientId, settings.localRefImage ? 'qig_ref_preflight.png' : '');
    const deadline = createHostedProviderDeadline(context.signal, settings.comfyTimeout, 'comfyui');
    const checkSettings = () => {
        if (roleplayHash(readSettings()) !== fingerprint) throw invalid('The saved ComfyUI settings changed before submission.', 'QIG_SETTINGS_CHANGED');
    };
    const safeFetch = (url, options) => {
        withAccount(() => {});
        return fetchImpl(url, { ...options, redirect: 'error' });
    };
    try {
        let referencePath = '';
        if (preview.needsReference) {
            const referenceName = `input:quick-image:${effectId}:comfy:reference`;
            const reference = await prepareQuickImageReference(context, { name: referenceName, source: settings.localRefImage,
                fingerprint, fetchImpl: safeFetch, withAccount, readSettingsLocked });
            const filename = `qig_ref_${createHash('sha256').update(JSON.stringify([context.job.id, effectId, reference.bytes.length]))
                .digest('hex').slice(0, 24)}.${reference.format.ext === 'jpeg' ? 'jpg' : reference.format.ext}`;
            const uploadName = `quick-image:${effectId}:comfy-upload`;
            checkPreviousStep(context, uploadName);
            const descriptor = await providerStep(context, uploadName, async () => {
                try { checkSettings(); } catch (error) { throw providerNotDispatched(error); }
                const form = new FormData();
                form.append('image', new Blob([reference.bytes], { type: reference.format.mime }), filename);
                const response = await safeFetch(`${baseUrl}/upload/image`, { method: 'POST', body: form, signal: deadline.signal });
                if (!response.ok) throw invalid(`ComfyUI reference upload failed with HTTP ${response.status}.`);
                let data;
                try { data = JSON.parse(await readResponseText(response, 1024 * 1024)); } catch {
                    throw invalid('ComfyUI reference upload returned invalid JSON.');
                }
                return { ...validateDescriptor(data, filename), sourceHash };
            });
            if (descriptor?.sourceHash !== sourceHash) throw recovery('The saved ComfyUI reference upload does not match the accepted input.');
            referencePath = descriptor.subfolder ? `${descriptor.subfolder.replace(/^\/+|\/+$/g, '')}/${descriptor.name}` : descriptor.name;
        }
        const body = buildComfyImageWorkflow(settings, input, manifest.clientId, referencePath).body;
        const bodyText = JSON.stringify(body);
        if (Buffer.byteLength(bodyText) > 1024 * 1024) throw invalid('The saved ComfyUI workflow exceeds its limit.');
        const bodyDigest = createHash('sha256').update(bodyText).digest('hex');
        const bodyName = `input:quick-image:${effectId}:comfy:workflow`;
        withAccount(() => {
            const saved = readArtifact(context.directories, context.job.id, bodyName);
            const data = { sourceHash, bodyDigest, byteLength: Buffer.byteLength(bodyText) };
            if (saved && saved.hash !== roleplayHash(data)) throw recovery('The saved ComfyUI workflow changed.');
            if (!saved) writeArtifact(context.directories, context.job.id, bodyName, { ...data, hash: roleplayHash(data) });
        });
        const submitName = `quick-image:${effectId}:comfy-submit`;
        checkPreviousStep(context, submitName);
        const submission = await providerStep(context, submitName, async () => {
            try { checkSettings(); } catch (error) { throw providerNotDispatched(error); }
            const response = await safeFetch(`${baseUrl}/prompt`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: bodyText, signal: deadline.signal });
            if (!response.ok) throw invalid(`ComfyUI submission failed with HTTP ${response.status}.`);
            let data;
            try { data = JSON.parse(await readResponseText(response, 1024 * 1024)); } catch {
                throw invalid('ComfyUI submission returned invalid JSON.');
            }
            let id;
            try { id = parseComfyPromptResponse(data).prompt_id; } catch { throw invalid('ComfyUI submission returned no prompt ID.'); }
            if (id.length > 256 || /[\r\n]/.test(id)) throw invalid('ComfyUI returned an invalid prompt ID.');
            return { promptId: id, sourceHash, bodyDigest };
        });
        if (submission?.sourceHash !== sourceHash || submission.bodyDigest !== bodyDigest
            || typeof submission.promptId !== 'string' || !submission.promptId) throw recovery('The saved ComfyUI submission needs recovery.');
        const outputNodeIds = String(settings.comfyOutputNodeIds || '').split(',').map(value => value.trim()).filter(Boolean);
        const configuredIndex = Number(settings.comfyOutputImageIndex);
        const imageIndex = Number.isSafeInteger(configuredIndex) && configuredIndex >= 0 ? configuredIndex : undefined;
        let result;
        try {
            result = await pollComfyHistory(submission.promptId, { baseUrl, fetchImpl: safeFetch,
                signal: deadline.signal, timeoutMs: Math.max(1, deadline.seconds * 1000),
                outputNodeIds: outputNodeIds.length ? outputNodeIds : undefined,
                imageIndex, ...(wait ? { sleep: wait } : {}) });
        } catch (error) {
            if (context.signal.aborted) throw error;
            throw invalid('ComfyUI history polling did not return an image.');
        }
        const output = result.images[0];
        if (!output?.url || !output.url.startsWith(`${baseUrl}/view?`)) throw invalid('ComfyUI returned an invalid image view.');
        let response;
        try { response = await safeFetch(output.url, { method: 'GET', signal: deadline.signal }); } catch (error) {
            if (context.signal.aborted) throw error;
            throw invalid('ComfyUI output could not be downloaded.');
        }
        if (!response.ok) throw invalid(`ComfyUI output download failed with HTTP ${response.status}.`);
        const bytes = Buffer.from(await readResponseArrayBuffer(response, MAX_IMAGE_BYTES));
        const format = detectImageFormat(bytes);
        if (!format) throw invalid('ComfyUI returned an unsupported image.');
        return { base64: bytes.toString('base64'), format: format.ext === 'jpeg' ? 'jpg' : format.ext };
    } finally {
        deadline.dispose();
    }
}
