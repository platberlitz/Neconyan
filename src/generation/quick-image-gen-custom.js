import { providerNotDispatched, providerStep, readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { readImageArtifact, writeImageArtifact } from '../jobs/image-artifacts.js';
import { roleplayHash } from '../roleplay-store.js';
import { MAX_IMAGE_BYTES } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { executeCustomBackend } from '../../public/scripts/extensions/quick-image-gen/lib/custom-backend.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { prepareQuickImageReference } from './quick-image-gen-reference.js';
import { createCustomImageRequest } from './quick-image-gen.js';

const recovery = () => Object.assign(new Error('The saved Custom API submission needs recovery.'), { status: 409, code: 'QIG_RESULT_RECOVERY' });

function imageValue(buffer) {
    const bytes = Buffer.from(buffer);
    const format = detectImageFormat(bytes);
    if (!format || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw recovery();
    return { base64: bytes.toString('base64'), format: format.ext === 'jpeg' ? 'jpg' : format.ext };
}

/** Save the paid submission separately; status queries can resume without another image request. */
export async function generateCustomImageJob(context, { effectId, input, settings, references, fingerprint,
    readSettings, withAccount, fetchImpl, wait }) {
    const { config, input: providerInput } = createCustomImageRequest({ ...settings, seed: input.seed,
        __qigCustomReferences: references }, input.prompt, input.negative);
    if (config.mode !== 'async') throw recovery();
    const identity = roleplayHash({ fingerprint, input, providerInput });
    const name = `quick-image:${effectId}:custom-submit`;
    const key = `provider:${name}`;
    const readResult = () => withAccount(() => {
        const saved = readArtifact(context.directories, context.job.id, key);
        if (saved === undefined) return undefined;
        if (!saved || saved.identity !== identity || (saved.image !== true
            && (typeof saved.jobId !== 'string' || !saved.jobId || Buffer.byteLength(saved.jobId) > 4096))) throw recovery();
        if (!saved.image) return saved;
        const image = readImageArtifact(context.directories, context.job.id, `${key}:image`);
        if (!image) throw recovery();
        return { identity, image };
    });
    if (readResult() === undefined && unresolvedProviderStep(context.directories, context.job.id)) throw recovery();
    try {
        const result = await executeCustomBackend(config, providerInput, {
            signal: context.signal, ...(wait ? { sleep: wait } : {}),
            fetchImpl: (url, init) => {
                withAccount(() => {});
                context.signal.throwIfAborted();
                return fetchImpl(url, { ...init, redirect: 'error' });
            },
            runSubmission: async submit => {
                const saved = await providerStep(context, name, async () => {
                    const current = readSettings();
                    if (roleplayHash(current) !== fingerprint) throw providerNotDispatched(Object.assign(
                        new Error('The saved Custom API settings changed before dispatch.'), { status: 409, code: 'QIG_SETTINGS_CHANGED' }));
                    const submitted = await submit();
                    if (submitted.buffer) return { identity, image: imageValue(submitted.buffer) };
                    if (config.apiKey && submitted.jobId.includes(config.apiKey)) throw recovery();
                    return { identity, jobId: submitted.jobId };
                }, {
                    readResult,
                    writeResult: (_directories, _id, _name, value) => withAccount(() => {
                        if (value.image) writeImageArtifact(context.directories, context.job.id, `${key}:image`, value.image);
                        writeArtifact(context.directories, context.job.id, key, { identity,
                            ...(value.image ? { image: true } : { jobId: value.jobId }) });
                    }),
                });
                return saved.image ? { buffer: Buffer.from(saved.image.base64, 'base64') } : { jobId: saved.jobId };
            },
        });
        return imageValue(result.buffer);
    } catch (error) {
        if (error.code === 'QIG_RESULT_RECOVERY' || error.code === 'QIG_SETTINGS_CHANGED') throw error;
        throw Object.assign(new Error('The configured Custom API image request could not finish.'), {
            status: 502, code: 'QIG_CUSTOM_FAILED', ...(context.signal.aborted ? { name: 'AbortError' } : {}),
        });
    }
}

/** Custom templates receive the saved image bytes, not a later version of a URL or account file. */
export async function prepareCustomImageReferences(context, { effectId, settings, fingerprint, input, withAccount,
    readSettingsLocked, fetchImpl }) {
    const sources = settings.customApiRefImages ?? [];
    if (!Array.isArray(sources) || sources.length > 15 || sources.some(source => typeof source !== 'string' || !source)) {
        throw Object.assign(new Error('The saved Custom API references are invalid.'), { status: 409, code: 'QIG_INVALID_REFERENCE' });
    }
    const name = `input:quick-image:${effectId}:custom`;
    const identity = roleplayHash({ fingerprint, input, sources });
    const previous = withAccount(() => readArtifact(context.directories, context.job.id, name));
    const references = [];
    let total = 0;
    for (const [index, source] of sources.entries()) {
        const { bytes, format } = await prepareQuickImageReference(context, { name: `${name}:reference:${index}`, source,
            fingerprint, withAccount, readSettingsLocked, fetchImpl, maxBytes: MAX_IMAGE_BYTES - total });
        total += bytes.length;
        references.push(`data:${format.mime};base64,${bytes.toString('base64')}`);
    }
    const data = { identity, referencesHash: roleplayHash(references) };
    const result = { ...data, hash: roleplayHash(data) };
    withAccount(() => {
        if (roleplayHash(readSettingsLocked()) !== fingerprint) throw Object.assign(new Error('The saved Custom API settings changed.'), { status: 409, code: 'QIG_SETTINGS_CHANGED' });
        if (previous !== undefined && roleplayHash(previous) !== roleplayHash(result)) throw Object.assign(new Error('The saved Custom API reference inputs changed.'), { status: 409, code: 'QIG_RESULT_RECOVERY' });
        if (previous === undefined) writeArtifact(context.directories, context.job.id, name, result);
    });
    return references;
}
