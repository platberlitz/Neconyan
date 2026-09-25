import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayHash } from '../roleplay-store.js';
import { getNanobananaApiUrl, buildNanobananaPayload } from '../../public/scripts/extensions/quick-image-gen/lib/provider-adapters.js';
import { assertSafeConfigurableEndpoint } from '../../public/scripts/extensions/quick-image-gen/lib/network-runtime.js';
import { buildNbpDirectorInstruction, getNanobananaAspectRatio,
    getNanobananaImageSize } from '../../public/scripts/extensions/quick-image-gen/lib/nanobanana-settings.js';
import { MAX_IMAGE_BYTES, MAX_PROVIDER_RESPONSE_BYTES } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { prepareQuickImageReference } from './quick-image-gen-reference.js';

const invalid = message => Object.assign(new Error(message), { status: 409, code: 'QIG_INVALID_INPUT' });
const recovery = message => Object.assign(new Error(message), { status: 409, code: 'QIG_RESULT_RECOVERY' });
const digest = value => createHash('sha256').update(value).digest('hex');

export function nanobananaEndpoint(settings) {
    const model = String(settings.nanobananaModel || 'gemini-3-pro-image').trim();
    if (!model || model.length > 256 || /[/?#\s]/.test(model)) throw invalid('The saved Nanobanana model is invalid.');
    const url = getNanobananaApiUrl(settings.nanobananaProxyUrl, model);
    assertSafeConfigurableEndpoint(url, 'Nanobanana proxy URL');
    return url;
}

/** The reference bytes and exact request digest are saved before the paid Gemini or proxy call. */
export async function prepareNanobananaPayload(context, { effectId, settings, fingerprint, prompt, negative,
    fetchImpl, readSettings, readSettingsLocked, withAccount } = {}) {
    const sources = settings.nanobananaRefImages || [];
    if (!Array.isArray(sources) || sources.length > 15 || sources.some(source => typeof source !== 'string')) {
        throw invalid('Nanobanana accepts at most fifteen saved reference images.');
    }
    const inputHash = roleplayHash({ fingerprint, prompt, negative, sources: sources.map(digest) });
    const manifestName = `input:quick-image:${effectId}:nanobanana`;
    const savedManifest = withAccount(() => readArtifact(context.directories, context.job.id, manifestName));
    if (savedManifest !== undefined) {
        const { hash, ...data } = savedManifest ?? {};
        if (data.inputHash !== inputHash || data.references !== sources.length || hash !== roleplayHash(data)) {
            throw recovery('The saved Nanobanana references have different inputs.');
        }
    } else {
        withAccount(() => {
            if (roleplayHash(readSettingsLocked()) !== fingerprint) throw invalid('The accepted Nanobanana settings changed before preparation.');
            const data = { inputHash, references: sources.length };
            writeArtifact(context.directories, context.job.id, manifestName, { ...data, hash: roleplayHash(data) });
        });
    }

    let total = 0;
    const parts = [];
    for (const [index, source] of sources.entries()) {
        context.signal.throwIfAborted();
        const name = `${manifestName}:reference:${index}`;
        let reference;
        try {
            reference = await prepareQuickImageReference(context, { name, source, fingerprint, withAccount,
                readSettingsLocked, fetchImpl, maxBytes: MAX_IMAGE_BYTES - total });
        } catch (error) { if (error.code === 'QIG_INVALID_REFERENCE') throw invalid(error.message); throw error; }
        const { bytes, format } = reference;
        total += bytes.length;
        if (total > MAX_IMAGE_BYTES) throw invalid('Nanobanana references exceed the aggregate image size limit.');
        parts.push({ inlineData: { mimeType: format.mime, data: bytes.toString('base64') } });
    }

    let finalPrompt = sources.length
        ? `Look at the reference image(s) above. Match their style, composition, and visual characteristics. Now generate a new image with this description: ${prompt}`
        : `Generate an image: ${prompt}`;
    const director = buildNbpDirectorInstruction(settings);
    if (director) finalPrompt += ` ${director}`;
    if (negative) finalPrompt += ` Avoid: ${negative}`;
    if (settings.nanobananaExtraInstructions) finalPrompt += ` Additional user instructions: ${settings.nanobananaExtraInstructions}`;
    parts.push({ text: finalPrompt });

    const imageConfig = { aspectRatio: getNanobananaAspectRatio(settings) };
    const imageSize = getNanobananaImageSize(settings);
    if (imageSize) imageConfig.imageSize = imageSize;
    const payload = buildNanobananaPayload({ endpointUrl: nanobananaEndpoint(settings),
        model: String(settings.nanobananaModel || 'gemini-3-pro-image').trim(),
        parts, generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig },
        safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
            'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_CIVIC_INTEGRITY'].map(category => ({ category, threshold: 'OFF' })) });
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_PROVIDER_RESPONSE_BYTES) throw invalid('The Nanobanana request exceeds the aggregate encoded size limit.');
    if (roleplayHash(readSettings()) !== fingerprint) throw invalid('The accepted Nanobanana settings changed before dispatch.');
    const recordName = `${manifestName}:request`;
    const record = { inputHash, byteLength: Buffer.byteLength(body), digest: digest(body) };
    withAccount(() => {
        if (roleplayHash(readSettingsLocked()) !== fingerprint) throw invalid('The accepted Nanobanana settings changed before dispatch.');
        const saved = readArtifact(context.directories, context.job.id, recordName);
        if (saved !== undefined && roleplayHash(saved) !== roleplayHash(record)) {
            throw recovery('The saved Nanobanana provider request changed.');
        }
        if (saved === undefined) writeArtifact(context.directories, context.job.id, recordName, record);
    });
    return payload;
}
