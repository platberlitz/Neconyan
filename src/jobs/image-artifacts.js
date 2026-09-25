import crypto from 'node:crypto';
import path from 'node:path';
import { createRoleplayDirectory, readRoleplayFile } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';

import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { MAX_IMAGE_BYTES } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { getJob, jobKey } from './store.js';
import { readArtifact, writeArtifact } from './artifacts.js';

const fail = message => Object.assign(new Error(message), { status: 409, code: 'QIG_RESULT_RECOVERY' });

function imageResult(value) {
    const bytes = typeof value?.base64 === 'string' ? Buffer.from(value.base64, 'base64') : null;
    const format = bytes && detectImageFormat(bytes);
    if (!format || !bytes.length || bytes.length > MAX_IMAGE_BYTES
        || value.format !== (format.ext === 'jpeg' ? 'jpg' : format.ext)) throw fail('The saved image bytes need recovery.');
    return bytes;
}

function imagePath(directories, id, name, create = false) {
    if (!getJob(directories, id)) throw fail('The image job no longer exists.');
    const root = path.resolve(directories.root);
    const parent = path.join(root, 'jobs', 'artifacts', jobKey(id));
    if (create) createRoleplayDirectory(parent, root);
    return path.join(parent, `${jobKey(name)}.bin`);
}

/** A small JSON receipt points at a bounded binary result, not a base64 string over the JSON budget. */
export function writeImageArtifact(directories, id, name, value) {
    const bytes = imageResult(value);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const receipt = { imageArtifact: 1, byteLength: bytes.length, digest, format: value.format };
    const previous = readArtifact(directories, id, name);
    if (previous !== undefined) {
        const recorded = readImageArtifact(directories, id, name);
        if (!imageResult(recorded).equals(bytes) || recorded.format !== value.format) throw fail('The saved image receipt differs from this result.');
        return value;
    }
    try {
        const filename = imagePath(directories, id, name, true);
        const existing = readRoleplayFile(filename, MAX_IMAGE_BYTES);
        if (existing && !existing.bytes.equals(bytes)) throw fail('The saved image bytes differ from this result.');
        if (!existing) tryWriteFileSync(filename, bytes, { mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
        const confirmed = readRoleplayFile(filename, MAX_IMAGE_BYTES, { flush: true });
        if (!confirmed || !confirmed.bytes.equals(bytes)) throw fail('The image file could not be confirmed.');
        writeArtifact(directories, id, name, receipt);
    } catch (error) {
        if (error.code === 'QIG_RESULT_RECOVERY') throw error;
        throw fail('The saved image file needs recovery.');
    }
    return value;
}

export function readImageArtifact(directories, id, name) {
    const saved = readArtifact(directories, id, name);
    if (saved === undefined) return undefined;
    if (saved?.imageArtifact !== 1) {
        imageResult(saved); // Older saved image results stored their bytes in the JSON artifact.
        return saved;
    }
    if (!Number.isSafeInteger(saved.byteLength) || saved.byteLength < 1 || saved.byteLength > MAX_IMAGE_BYTES
        || !/^[a-f0-9]{64}$/.test(saved.digest) || !['png', 'jpg', 'webp', 'gif', 'bmp', 'tiff', 'avif'].includes(saved.format)) {
        throw fail('The saved image receipt needs recovery.');
    }
    try {
        const file = readRoleplayFile(imagePath(directories, id, name), MAX_IMAGE_BYTES, { allowMissingParent: true });
        if (!file || file.bytes.length !== saved.byteLength) throw fail('The saved image file needs recovery.');
        const bytes = file.bytes;
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== saved.digest) throw fail('The saved image file changed.');
        const result = { base64: bytes.toString('base64'), format: saved.format };
        imageResult(result);
        return result;
    } catch (error) {
        if (error.code === 'QIG_RESULT_RECOVERY') throw error;
        throw fail('The saved image file needs recovery.');
    }
}

export const imageArtifactStore = Object.freeze({ readResult: readImageArtifact, writeResult: writeImageArtifact });
