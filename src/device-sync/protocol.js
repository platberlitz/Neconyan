import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

export const LIMITS = Object.freeze({ entries: 1000, file: 8 * 1024 * 1024, bytes: 32 * 1024 * 1024, envelope: 60 * 1024 * 1024 });
export const CATEGORIES = Object.freeze(['characters', 'lorebooks', 'presets', 'personas', 'backgrounds', 'appearance']);
export const METHODS = Object.freeze(['file', 'webdav', 'gist', 'pairing']);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const fail = (message, status = 400) => Object.assign(new Error(message), { status, syncSafe: true });
const derive = promisify(scrypt);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const AAD = Buffer.from('Neconyan device sync:1:scrypt-16384-8-1:aes-256-gcm');

export function json(bytes) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('The sync data is not valid UTF-8 JSON.'); }
}

export function categories(value) {
    if (!Array.isArray(value) || !value.length || value.length > CATEGORIES.length
        || new Set(value).size !== value.length || value.some(item => !CATEGORIES.includes(item))) throw fail('Choose supported data categories.');
    return [...value];
}

/** Conservative, cross-platform spelling: do not accept names with two interpretations. */
export function categoryFor(relative) {
    if (typeof relative !== 'string' || relative.length > 512 || relative !== relative.normalize('NFC')
        || relative.split('/').some(part => !part || part.startsWith('.') || /[\\\x00-\x1f\x7f:%?#<>"|*]/.test(part)
            || /[. ]$/.test(part) || Buffer.byteLength(part) > 240 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
            || ['__proto__', 'constructor', 'prototype'].includes(part))) throw fail('A sync path has an unsafe or ambiguous name.');
    if (/^characters\/[^/]+\.png$/.test(relative) || /^chats\/[^/]+\/[^/]+\.jsonl$/.test(relative)) return 'characters';
    if (/^worlds\/[^/]+\.json$/.test(relative)) return 'lorebooks';
    if (/^(instruct|context|sysprompt|reasoning)\/[^/]+\.json$/.test(relative)) return 'presets';
    if (/^User Avatars\/[^/]+\.(png|jpg|jpeg|webp|gif)$/.test(relative) || /^portable\/personas\/[^/]+\.json$/.test(relative)) return 'personas';
    if (/^backgrounds\/[^/]+\.(png|jpg|jpeg|webp|gif)$/.test(relative)) return 'backgrounds';
    if (relative === 'portable/appearance.json') return 'appearance';
    throw fail('The package contains an unsupported path or extension.');
}

export function entry(relative, bytes) {
    if (bytes.length > LIMITS.file) throw fail('The sync data exceeds its size limit.', 413);
    return { path: relative, category: categoryFor(relative), size: bytes.length, hash: hash(bytes), data: bytes.toString('base64') };
}

export function decode64(value, max) {
    if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail('Invalid or oversized encoded sync data.', 413);
    const result = Buffer.from(value, 'base64');
    if (result.length > max) throw fail('The sync data exceeds its size limit.', 413);
    return result;
}

export function validateSnapshot(value) {
    if (!plain(value) || value.format !== 'neconyan-device-sync' || value.version !== 1 || !UUID.test(value.deviceId ?? '')
        || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Array.isArray(value.entries) || value.entries.length > LIMITS.entries) throw fail('Unsupported or oversized sync manifest.');
    const selected = categories(value.categories);
    if (value.recovery !== undefined && (!plain(value.recovery) || Object.keys(value.recovery).sort().join(',') !== 'id,sourceDeviceId'
        || !UUID.test(value.recovery.id ?? '') || value.recovery.sourceDeviceId !== value.deviceId)) throw fail('Invalid preserved recovery package.');
    const paths = new Set();
    let size = 0;
    for (const item of value.entries) {
        if (!plain(item) || !['category,data,hash,path,size', 'bases,category,data,hash,path,size'].includes(Object.keys(item).sort().join(','))
            || categoryFor(item.path) !== item.category || !selected.includes(item.category)) throw fail('Invalid sync entry.');
        if (item.bases !== undefined && (!Array.isArray(item.bases) || item.bases.length > 8
            || new Set(item.bases.map(base => base?.deviceId)).size !== item.bases.length
            || item.bases.some(base => !plain(base) || !['deviceId,hash', 'deviceId,hash,sequence'].includes(Object.keys(base).sort().join(','))
                || !UUID.test(base.deviceId ?? '') || !/^[a-f0-9]{64}$/.test(base.hash ?? '')
                || base.sequence !== undefined && (!Number.isSafeInteger(base.sequence) || base.sequence < 1)))) throw fail('Invalid shared sync history.');
        const canonical = item.path.toLowerCase();
        if (paths.has(canonical)) throw fail('The package repeats a canonical path.');
        paths.add(canonical);
        const bytes = decode64(item.data, LIMITS.file);
        size += bytes.length;
        if (size > LIMITS.bytes) throw fail('The package exceeds the 32 MiB expanded limit.', 413);
        if (bytes.length !== item.size || hash(bytes) !== item.hash) throw fail('The package content hash does not match.');
    }
    // Chats must bring their character, rather than creating unreachable chat folders.
    const exact = new Set(value.entries.map(item => item.path));
    for (const item of value.entries) if (item.path.startsWith('chats/')) {
        const owner = item.path.split('/')[1];
        if (!value.entries.some(card => card.path.startsWith('characters/') && card.path.slice(11).replace('.png', '') === owner)) throw fail('A chat is missing its character card.');
    }
    for (const item of value.entries) if (item.path.startsWith('portable/personas/')) {
        if (!exact.has('User Avatars/' + item.path.slice(18, -5))) throw fail('A persona is missing its avatar.');
    }
    return value;
}

function passphrase(value) {
    if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 1024) throw fail('Use a shared passphrase of 12 to 1024 characters. Keep it safe; it cannot be recovered.');
}

export async function encrypt(snapshot, secret) {
    passphrase(secret);
    validateSnapshot(snapshot);
    const salt = randomBytes(16), iv = randomBytes(12);
    const key = await derive(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try {
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(AAD);
        const data = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
        return { format: 'neconyan-encrypted-sync', version: 1, kdf: 'scrypt-16384-8-1', cipher: 'aes-256-gcm',
            salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    } finally { key.fill(0); }
}

export async function decrypt(value, secret) {
    passphrase(secret);
    if (!plain(value) || value.format !== 'neconyan-encrypted-sync' || value.version !== 1 || value.kdf !== 'scrypt-16384-8-1' || value.cipher !== 'aes-256-gcm') throw fail('Unsupported encrypted sync package.');
    const salt = decode64(value.salt, 16), iv = decode64(value.iv, 12), tag = decode64(value.tag, 16);
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw fail('Invalid encryption envelope.');
    const data = decode64(value.data, LIMITS.envelope * 3 / 4);
    const key = await derive(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    let bytes;
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(AAD); decipher.setAuthTag(tag);
        bytes = Buffer.concat([decipher.update(data), decipher.final()]);
    } catch { throw fail('The passphrase is wrong or the encrypted package was changed. No files were imported.'); } finally { key.fill(0); }
    try { return validateSnapshot(json(bytes)); } finally { bytes.fill(0); }
}

/** A three-way comparison; absence is never treated as permission to delete. */
export function reconcile(local, remote, accepted) {
    if (local === remote) return 'equal';
    if (!accepted) return local === null ? 'incoming' : 'conflict';
    if (remote === accepted.remote) return 'local';
    if (local === accepted.local) return local === null ? 'conflict' : 'incoming';
    return 'conflict';
}
