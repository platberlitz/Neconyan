import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { readImageArtifact, writeImageArtifact } from '../jobs/image-artifacts.js';
import { readRoleplayFile, roleplayAccountBase, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { MAX_IMAGE_BYTES, MAX_PROVIDER_RESPONSE_BYTES, normalizeImageSource,
    readResponseArrayBuffer } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';

const invalid = message => Object.assign(new Error(message), { status: 409, code: 'QIG_INVALID_REFERENCE' });
const recovery = message => Object.assign(new Error(message), { status: 409, code: 'QIG_RESULT_RECOVERY' });
const changed = () => Object.assign(new Error('The accepted account reference image changed.'), { status: 409, code: 'QIG_REFERENCE_SOURCE_CHANGED' });
const referenceHash = source => createHash('sha256').update(source).digest('hex');

function accountImage(directories, source) {
    if (!source.startsWith('/user/images/') || source.includes('?') || source.includes('#')) {
        throw invalid('Only saved account images can be read from this account.');
    }
    let components;
    try { components = source.slice('/user/images/'.length).split('/').map(decodeURIComponent); } catch {
        throw invalid('The saved account image path is invalid.');
    }
    if (components.length < 1 || components.length > 2 || components.some(part => !part || part === '.' || part === '..'
        || part.includes('/') || part.includes('\\') || part.includes('\0'))) {
        throw invalid('The saved account image path is invalid.');
    }
    return path.join(directories.userImages ?? path.join(directories.root, 'user/images'), ...components);
}

function localReferences(settings, additionalRefs) {
    const field = { proxy: 'proxyRefImages', custom: 'customApiRefImages', nanobanana: 'nanobananaRefImages', nanogpt: 'nanogptRefImages' }[settings.provider];
    let sources = [];
    if (field && !(settings.provider === 'proxy' && settings.proxyComfyMode)) {
        sources = settings[field] ?? [];
        if (!Array.isArray(sources)) throw invalid('The saved image reference list is invalid.');
    } else if (settings.provider === 'local') {
        sources = [settings.localRefImage, ...(settings.a1111ControlNet && settings.a1111ControlNetModel ? [settings.a1111ControlNetImage] : [])].filter(Boolean);
    }
    if (!Array.isArray(additionalRefs) || additionalRefs.length > 15 || sources.length > 15
        || [...sources, ...additionalRefs].some(source => typeof source !== 'string' || !source)) throw invalid('The saved image reference list is invalid.');
    return [...new Set([...sources, ...additionalRefs])].filter(source => source.startsWith('/user/images/'));
}

/** The caller holds the account lock: bind local file identities before accepting an image workflow. */
export function captureQuickImageReferenceSources(directories, settings, additionalRefs = []) {
    return localReferences(settings, additionalRefs).map(source => {
        const filename = accountImage(directories, source);
        const file = readRoleplayFile(filename, MAX_IMAGE_BYTES);
        if (!file || !detectImageFormat(file.bytes)) throw invalid('The saved account reference image is missing or invalid.');
        return { sourceHash: referenceHash(source), rawHash: file.rawHash, physical: file.physical,
            relative: path.relative(directories.root, filename).split(path.sep).join('/') };
    });
}

/** Conversation preparation does not already hold a protected account lease. */
export function captureBoundQuickImageReferenceSources(directories, settings, additionalRefs = []) {
    if (!localReferences(settings, additionalRefs).length) return [];
    const base = roleplayAccountBase(directories);
    if (!base) throw invalid('The saved image references have no protected account.');
    return withRoleplayAccount(base, null, () => captureQuickImageReferenceSources(directories, settings, additionalRefs));
}

const capturedReferenceName = sourceHash => `input:quick-image:reference-source:${sourceHash}`;

/** Hold the account lease while saving local reference bytes, before any prompt or image provider is called. */
export function freezeQuickImageReferenceSources(context) {
    if (context.referenceSources === undefined) return;
    if (!Array.isArray(context.referenceSources) || context.referenceSources.length > 30) throw changed();
    for (const source of context.referenceSources) {
        if (!source || !/^[a-f0-9]{64}$/.test(source.sourceHash) || !/^[a-f0-9]{64}$/.test(source.rawHash)
            || typeof source.relative !== 'string' || /[\\\0]/.test(source.relative)
            || source.relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(source.relative)) throw changed();
        const name = capturedReferenceName(source.sourceHash);
        let image = readImageArtifact(context.directories, context.job.id, name);
        if (image === undefined) {
            const file = readRoleplayFile(path.join(context.directories.root, source.relative), MAX_IMAGE_BYTES);
            if (!file || file.rawHash !== source.rawHash || roleplayHash(file.physical) !== roleplayHash(source.physical)) throw changed();
            const format = detectImageFormat(file.bytes);
            if (!format) throw changed();
            image = { base64: file.bytes.toString('base64'), format: format.ext === 'jpeg' ? 'jpg' : format.ext };
            writeImageArtifact(context.directories, context.job.id, name, image);
        }
        if (createHash('sha256').update(Buffer.from(image.base64, 'base64')).digest('hex') !== source.rawHash) throw changed();
    }
}

function encodedReference(source) {
    const normalized = normalizeImageSource(source, { allowHttp: false, allowRelative: false, maxInlineBytes: MAX_IMAGE_BYTES });
    const encoded = normalized?.match(/^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/i)?.[1];
    if (!encoded) throw invalid('The saved reference image has invalid inline data.');
    return Buffer.from(encoded, 'base64');
}

/** Bind one account image, inline image or public HTTPS reference before submitting a paid image request. */
export async function prepareQuickImageReference(context, { name, source, fingerprint, withAccount, readSettingsLocked,
    fetchImpl, maxBytes = MAX_IMAGE_BYTES } = {}) {
    if (typeof name !== 'string' || !name || typeof source !== 'string' || !source
        || Buffer.byteLength(source) > MAX_PROVIDER_RESPONSE_BYTES) throw invalid('The saved image reference is invalid or too large.');
    const sourceHash = referenceHash(source);
    const local = source.startsWith('/user/images/');
    const expected = local && context.referenceSources !== undefined
        ? context.referenceSources.find(value => value?.sourceHash === sourceHash) : null;
    if (local && context.referenceSources !== undefined && (!expected || !/^[a-f0-9]{64}$/.test(expected.rawHash) || !expected.physical)) throw changed();
    const boundName = `${name}:source`;
    const record = withAccount(() => readArtifact(context.directories, context.job.id, boundName));
    if (record !== undefined && (!record || typeof record !== 'object'
        || record.sourceHash !== sourceHash || record.fingerprint !== fingerprint
        || record.hash !== roleplayHash({ sourceHash, fingerprint, ...(record.evidence ? { evidence: record.evidence } : {}) }))) {
        throw recovery('The saved image reference source changed.');
    }
    if (record && expected && roleplayHash(record.evidence ?? null) !== roleplayHash({ rawHash: expected.rawHash, physical: expected.physical })) throw changed();
    const saved = withAccount(() => readImageArtifact(context.directories, context.job.id, name));
    if (saved !== undefined) {
        if (!record) throw recovery('A saved image reference is missing its source evidence.');
        const bytes = Buffer.from(saved.base64, 'base64');
        if (bytes.length > maxBytes) throw invalid('Saved image references exceed their limit.');
        return { bytes, format: detectImageFormat(bytes) };
    }
    let evidence;
    let bytes;
    if (local) {
        ({ bytes, evidence } = withAccount(() => {
            if (roleplayHash(readSettingsLocked()) !== fingerprint) throw invalid('The accepted reference settings changed.');
            if (expected) {
                freezeQuickImageReferenceSources(context);
                const image = readImageArtifact(context.directories, context.job.id, capturedReferenceName(sourceHash));
                const bytes = Buffer.from(image.base64, 'base64');
                if (bytes.length > maxBytes) throw invalid('Saved image references exceed their limit.');
                return { bytes, evidence: { rawHash: expected.rawHash, physical: expected.physical } };
            }
            const file = readRoleplayFile(accountImage(context.directories, source), maxBytes);
            if (!file) throw invalid('The saved account reference image is missing.');
            return { bytes: file.bytes, evidence: { rawHash: file.rawHash, physical: file.physical } };
        }));
    } else if (/^data:/i.test(source)) {
        bytes = encodedReference(source);
    } else {
        const url = normalizeImageSource(source, { allowHttp: false, allowRelative: false, blockPrivateHosts: true });
        if (!url || !url.startsWith('https://')) throw invalid('Reference images must use saved account paths, inline data or public HTTPS.');
        let response;
        try {
            response = await fetchImpl(url, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]), redirect: 'error' });
        } catch (error) {
            if (context.signal.aborted) throw error;
            throw invalid('The reference image could not be downloaded.');
        }
        if (!response.ok) throw invalid(`The reference request failed with HTTP ${response.status}.`);
        bytes = Buffer.from(await readResponseArrayBuffer(response, maxBytes));
    }
    const format = detectImageFormat(bytes);
    if (!format || !bytes.length || bytes.length > maxBytes) throw invalid('The reference image is unsupported or too large.');
    withAccount(() => {
        if (roleplayHash(readSettingsLocked()) !== fingerprint) throw invalid('The accepted reference settings changed.');
        const data = { sourceHash, fingerprint, ...(evidence ? { evidence } : {}) };
        const current = readArtifact(context.directories, context.job.id, boundName);
        if (current !== undefined && roleplayHash(current) !== roleplayHash({ ...data, hash: roleplayHash(data) })) {
            throw recovery('The saved image reference source changed.');
        }
        if (current === undefined) writeArtifact(context.directories, context.job.id, boundName, { ...data, hash: roleplayHash(data) });
        writeImageArtifact(context.directories, context.job.id, name, {
            base64: bytes.toString('base64'), format: format.ext === 'jpeg' ? 'jpg' : format.ext,
        });
    });
    return { bytes, format };
}
