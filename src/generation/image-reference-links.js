import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import storage from 'node-persist';
import { getUserDirectories, KEY_PREFIX } from '../users.js';
import { getJob } from '../jobs/store.js';
import { readImageArtifact } from '../jobs/image-artifacts.js';
import { createRoleplayDirectory, readRoleplayFile, roleplayError, roleplayHash, roleplayLease,
    roleplayStoreDirectory, withRoleplayAccount } from '../roleplay-store.js';
import { getConfigValue, tryWriteFileSync } from '../util.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { normalizeImageSource } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';

const HEX = /^[a-f0-9]{64}$/;
const MAX_RECORD = 4096;
const MAX_REFERENCES = 4096;
const fail = message => roleplayError('QIG_REFERENCE_LINK_INVALID', message);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function imageReferenceBaseUrl(value = getConfigValue('media.referenceBaseUrl', '')) {
    const safe = normalizeImageSource(value, { allowHttp: false, allowRelative: false, blockPrivateHosts: true });
    let url;
    try { url = new URL(safe); } catch { throw fail('URL-only image references require a saved public HTTPS reference address.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw fail('The public image reference address is invalid.');
    return url.href.replace(/\/+$/, '');
}

function readRecord(filename) {
    const file = readRoleplayFile(filename, MAX_RECORD, { allowMissingParent: true });
    if (!file) return undefined;
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch { throw fail('The saved image reference link needs recovery.'); }
    const { hash, ...data } = value ?? {};
    if (data.version !== 1 || hash !== roleplayHash(data) || !HEX.test(data.digest)
        || !HEX.test(data.intentHash) || typeof data.name !== 'string' || !data.name || data.name.length > 512
        || typeof data.jobId !== 'string' || typeof data.owner !== 'string' || !data.account) {
        throw fail('The saved image reference link needs recovery.');
    }
    return value;
}

function secret(directory, create) {
    const filename = path.join(directory, 'link-key');
    let file = readRoleplayFile(filename, 32, { allowMissingParent: true });
    if (!file && create) {
        tryWriteFileSync(filename, crypto.randomBytes(32), { mode: 0o600 }, { expectedFileAbsent: true, durable: true });
        file = readRoleplayFile(filename, 32, { flush: true });
    }
    if (file?.bytes.length !== 32) throw fail('The saved image reference key is unavailable.');
    return file.bytes;
}

const signature = (key, value) => crypto.createHmac('sha256', key).update(value.hash).digest('hex');

/** A capability exposes only these immutable bytes, while account cookies and provider keys stay private. */
export function publishImageReferenceLink(lease, context, name, baseUrl = imageReferenceBaseUrl()) {
    const { scope } = roleplayLease(lease);
    if (context.owner !== scope.owner || context.directories.root !== scope.directories.root) throw fail('The image reference belongs to another account.');
    const job = getJob(scope.directories, context.job.id);
    if (!job || job.owner !== scope.owner || roleplayHash(job.intent) !== roleplayHash(context.job.intent)) throw fail('The image reference job changed.');
    const image = readImageArtifact(scope.directories, job.id, name);
    if (!image) throw fail('The image reference bytes must be saved before publication.');
    const account = { accountId: scope.accountId, dataEpoch: scope.dataEpoch };
    const root = roleplayStoreDirectory(scope);
    const directory = path.join(root, 'references');
    createRoleplayDirectory(directory, root);
    const id = roleplayHash({ account, jobId: job.id, name });
    const filename = path.join(directory, `${id}.json`);
    const data = { version: 1, owner: scope.owner, account, jobId: job.id, name, intentHash: roleplayHash(job.intent),
        digest: digest(Buffer.from(image.base64, 'base64')), baseUrl: imageReferenceBaseUrl(baseUrl) };
    const value = { ...data, hash: roleplayHash(data) };
    const previous = readRecord(filename);
    if (previous !== undefined && roleplayHash(previous) !== roleplayHash(value)) throw fail('The saved image reference link changed.');
    const names = fs.readdirSync(directory).filter(entry => /^[a-f0-9]{64}\.json$/.test(entry));
    const key = secret(directory, names.length === 0);
    if (previous === undefined) {
        if (names.length >= MAX_REFERENCES) {
            throw fail('Image reference storage is full; earlier reference ownership was retained.');
        }
        const content = JSON.stringify(value);
        if (Buffer.byteLength(content) > MAX_RECORD) throw fail('The image reference link is too large.');
        tryWriteFileSync(filename, content, { encoding: 'utf8', mode: 0o600 }, { expectedFileAbsent: true, durable: true });
        if (readRoleplayFile(filename, MAX_RECORD, { flush: true })?.bytes.toString('utf8') !== content) throw fail('The image reference link was not confirmed.');
    }
    return `${data.baseUrl}/api/media-reference/${path.basename(root)}/${id}/${signature(key, value)}`;
}

/** The opaque link is authorised for one image, not for a user account or its other files. */
export function createImageReferenceHandler({ dataRoot = () => globalThis.DATA_ROOT, directoriesFor = getUserDirectories,
    userEnabled = async owner => Boolean((await storage.getItem(KEY_PREFIX + owner))?.enabled) } = {}) {
    return async (request, response) => {
        try {
            const { store, id, token } = request.params;
            if (![store, id, token].every(value => HEX.test(value))) return response.sendStatus(404);
            const directory = path.join(dataRoot(), '_roleplay', store, 'references');
            const value = readRecord(path.join(directory, `${id}.json`));
            if (!value || !crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(signature(secret(directory, false), value), 'hex'))) return response.sendStatus(404);
            if (!await userEnabled(value.owner)) return response.sendStatus(404);
            const base = { owner: value.owner, directories: directoriesFor(value.owner) };
            if (path.dirname(roleplayStoreDirectory(base)) !== path.join(dataRoot(), '_roleplay')
                || path.basename(roleplayStoreDirectory(base)) !== store) return response.sendStatus(404);
            const { bytes, mime } = withRoleplayAccount(base, value.account, () => {
                const current = readRecord(path.join(directory, `${id}.json`));
                if (!current || roleplayHash(current) !== roleplayHash(value)) throw fail('The image reference changed.');
                const job = getJob(base.directories, value.jobId);
                if (!job || job.owner !== value.owner || job.cancellation?.requested || job.state === 'cancelled'
                    || roleplayHash(job.intent) !== value.intentHash) throw fail('The image reference is no longer available.');
                const image = readImageArtifact(base.directories, value.jobId, value.name);
                const bytes = image && Buffer.from(image.base64, 'base64');
                if (!bytes || digest(bytes) !== value.digest) throw fail('The image reference bytes changed.');
                return { bytes, mime: detectImageFormat(bytes).mime };
            });
            response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
            response.type(mime).send(bytes);
        } catch { response.sendStatus(404); }
    };
}
