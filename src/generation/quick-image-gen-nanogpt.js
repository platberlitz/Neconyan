import { Buffer } from 'node:buffer';

import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayHash } from '../roleplay-store.js';
import { buildNanoGptReferenceFields, getNanoGptEffectiveResolution, getNanoGptModelCapabilities,
    getNanoGptReferenceConstraints } from '../../public/scripts/extensions/quick-image-gen/lib/provider-capabilities.js';
import { readResponseText } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { prepareQuickImageReference } from './quick-image-gen-reference.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const invalid = message => Object.assign(new Error(message), { status: 409, code: 'QIG_INVALID_INPUT' });

async function discoverModel(model, signal, fetchImpl) {
    try {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        const response = await fetchImpl(`https://nano-gpt.com/api/v1/images/models/${encodeURIComponent(model)}/endpoints`, {
            signal: deadline, redirect: 'error',
        });
        if (!response.ok) return null;
        const data = JSON.parse(await readResponseText(response, 1024 * 1024));
        return { endpoints: Array.isArray(data?.endpoints) ? data.endpoints : [] };
    } catch (error) {
        if (signal?.aborted) throw error;
        return null; // Browser discovery also falls back to conservative model controls.
    }
}

/** Read-only metadata and reference downloads are saved before the paid image submission. */
export async function prepareNanoGptPayload(context, { effectId, settings, fingerprint, prompt, negative, fetchImpl, readSettings,
    withAccount, readSettingsLocked }) {
    const model = String(settings.nanogptModel || 'flux-schnell').trim() || 'flux-schnell';
    const inputHash = roleplayHash({ fingerprint, model, prompt, negative, seed: settings.seed });
    const artifact = `input:quick-image:${effectId}:nanogpt`;
    const saved = withAccount(() => readArtifact(context.directories, context.job.id, artifact));
    if (saved !== undefined) {
        const { hash, ...data } = saved ?? {};
        if (data.inputHash !== inputHash || hash !== roleplayHash(data) || data.body?.model !== model) {
            throw invalid('The saved NanoGPT request has different inputs.');
        }
        return data.body;
    }
    const metadataName = `${artifact}:model`;
    let modelRecord = withAccount(() => readArtifact(context.directories, context.job.id, metadataName));
    if (modelRecord === undefined) {
        const data = { inputHash, metadata: await discoverModel(model, context.signal, fetchImpl) };
        modelRecord = { ...data, hash: roleplayHash(data) };
        withAccount(() => writeArtifact(context.directories, context.job.id, metadataName, modelRecord));
    }
    const { hash: modelHash, ...modelData } = modelRecord ?? {};
    if (modelData.inputHash !== inputHash || modelHash !== roleplayHash(modelData)) throw invalid('The saved NanoGPT model controls changed.');
    const metadata = modelData.metadata;
    const capabilities = getNanoGptModelCapabilities(model, metadata);
    const constraints = getNanoGptReferenceConstraints(metadata);
    const { resolution } = getNanoGptEffectiveResolution(settings.width, settings.height, metadata);
    const body = { model, prompt: negative ? `${prompt}\n\nAvoid in the image: ${negative}` : prompt,
        resolution, n: 1 };
    const supported = metadata?.endpoints?.[0]?.supported_parameters || {};
    if (capabilities.steps) {
        body[Object.hasOwn(supported, 'steps') ? 'steps' : 'num_inference_steps'] = Math.max(1, Math.min(100, Math.trunc(Number(settings.steps) || 25)));
    }
    if (capabilities.cfgScale) {
        const key = Object.hasOwn(supported, 'guidance') ? 'guidance' : Object.hasOwn(supported, 'cfg_scale') ? 'cfg_scale' : 'guidance_scale';
        body[key] = Math.max(0, Math.min(20, Number.isFinite(Number(settings.cfgScale)) ? Number(settings.cfgScale) : 7));
    }
    if (capabilities.seed) body.seed = settings.seed;
    const references = settings.nanogptRefImages || [];
    if (!Array.isArray(references) || references.length > constraints.maxImages
        || references.length && !capabilities.referenceImages) throw invalid('The saved NanoGPT model cannot use these reference images.');
    const materialized = [];
    for (const [index, reference] of references.entries()) {
        const maxEncoded = constraints.maxBytes
            ? Math.min(MAX_BODY_BYTES, Math.ceil(constraints.maxBytes * 4 / 3) + 128) : MAX_BODY_BYTES;
        let result;
        try {
            result = await prepareQuickImageReference(context, { name: `${artifact}:reference:${index}`,
                source: reference, fingerprint, withAccount, readSettingsLocked, fetchImpl,
                maxBytes: Math.floor((maxEncoded - 128) * 3 / 4) });
        } catch (error) { if (error.code === 'QIG_INVALID_REFERENCE') throw invalid(error.message); throw error; }
        const dataUrl = `data:${result.format.mime};base64,${result.bytes.toString('base64')}`;
        if (Buffer.byteLength(dataUrl) > maxEncoded) throw invalid('A NanoGPT reference exceeds its model input limit.');
        const mime = dataUrl.match(/^data:([^;,]+);base64,/i)?.[1]?.toLowerCase();
        if (constraints.mimeTypes.length && !constraints.mimeTypes.includes(mime)) throw invalid('A NanoGPT reference format is not accepted by this model.');
        materialized.push(dataUrl);
    }
    Object.assign(body, buildNanoGptReferenceFields(materialized, settings.nanogptStrength, metadata));
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw invalid('The NanoGPT request exceeds the 4 MiB input limit.');
    // Saved settings can change while reference URLs are read. No paid work has happened yet.
    if (roleplayHash(readSettings()) !== fingerprint) throw invalid('The accepted NanoGPT settings changed before dispatch.');
    const data = { inputHash, body };
    withAccount(() => writeArtifact(context.directories, context.job.id, artifact, { ...data, hash: roleplayHash(data) }));
    return body;
}
