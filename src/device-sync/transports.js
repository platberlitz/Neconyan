import { randomBytes } from 'node:crypto';
import { exportEnvelope, importEnvelope } from './service.js';
import { fail, LIMITS, plain } from './protocol.js';
import { request, checkResponse, targetUrl } from './network.js';
import { withSync } from './store.js';

export function validateConfig(method, value) {
    if (!plain(value)) throw fail('Sync configuration must be an object.');
    const text = (field, max = 4096) => {
        if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length > max || /[\r\n\0]/.test(value[field]))) throw fail('A sync configuration field is invalid.');
        return value[field];
    };
    if (method === 'webdav') {
        const url = text('url');
        if (url !== undefined) targetUrl(url);
        return Object.fromEntries(['url', 'username', 'password'].filter(key => value[key] !== undefined).map(key => [key, text(key)]));
    }
    if (method === 'gist') {
        const gistId = text('gistId', 64), token = text('token');
        if (gistId && !/^[a-f0-9]{5,64}$/.test(gistId)) throw fail('Enter a valid secret Gist ID.');
        return { ...(gistId !== undefined ? { gistId } : {}), ...(token !== undefined ? { token } : {}) };
    }
    if (method === 'pairing') {
        const code = text('code', 8192);
        if (!code?.startsWith('neconyan-sync:')) throw fail('Paste the pairing code created by the receiving installation.');
        let peer;
        try { peer = JSON.parse(Buffer.from(code.slice(14), 'base64url').toString('utf8')); } catch { throw fail('Invalid pairing code.'); }
        if (!plain(peer) || !/^[a-f0-9]{32}$/.test(peer.id) || !/^[A-Za-z0-9_-]{43}$/.test(peer.token)
            || typeof peer.owner !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(peer.owner)) throw fail('Invalid pairing code.');
        const url = targetUrl(peer.url, { pairing: true });
        return { peer: { url: url.href.replace(/\/$/, ''), owner: peer.owner, id: peer.id, token: peer.token } };
    }
    return {};
}

export async function webdavSync(context, send = request) {
    const config = context.config;
    if (!config.url) throw fail('Save a WebDAV file URL first.');
    const headers = config.username || config.password ? { Authorization: 'Basic ' + Buffer.from(`${config.username ?? ''}:${config.password ?? ''}`).toString('base64') } : {};
    const remote = checkResponse(await send(context, config.url, { headers }), [200, 404]);
    const etag = remote.headers.etag;
    if (remote.status === 200 && (typeof etag !== 'string' || !/^"[^"\r\n]+"$/.test(etag))) throw fail('This WebDAV server did not supply a strong ETag. Safe overwrite is unavailable; use a server with conditional PUT support.', 502);
    const result = remote.status === 200 ? await importEnvelope(context, remote.value(), 'webdav:' + config.url) : { imported: 0, conflicts: 0, unchanged: 0 };
    const envelope = await exportEnvelope(context);
    // PUT is conditional even for creation. A 412 is never retried as an unconditional write.
    checkResponse(await send(context, config.url, { method: 'PUT', body: envelope, headers: { ...headers, ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) } }), [200, 201, 204]);
    // Read-back detects servers that discard the encrypted object or alter its bytes.
    const verify = checkResponse(await send(context, config.url, { headers }), [200]);
    if (!verify.headers.etag || JSON.stringify(verify.value()) !== JSON.stringify(envelope)) throw fail('The WebDAV publication could not be verified. Sync again before assuming it reached the other installation.', 502);
    return { ...result, published: true };
}

const GIST_LIMIT = 900 * 1024;
const gistFile = /^neconyan-sync-[a-f0-9-]{36}-[a-f0-9]{32}\.json$/;
const gistHeaders = token => ({ Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Neconyan-device-sync', Accept: 'application/vnd.github+json' });

export async function gistSync(context, { create = false, send = request } = {}) {
    if (!context.config.token) throw fail('Save a GitHub token with Gist permission first.');
    const headers = gistHeaders(context.config.token);
    const envelope = await exportEnvelope(context);
    const content = JSON.stringify(envelope);
    if (Buffer.byteLength(content) > GIST_LIMIT) throw fail('This encrypted selection exceeds the 900 KiB Gist limit. Choose fewer categories or another method.', 413);
    const deviceId = withSync(context.base, context.account, ({ state }) => state.deviceId);
    const filename = `neconyan-sync-${deviceId}-${randomBytes(16).toString('hex')}.json`;
    let id = context.config.gistId;
    if (create) {
        if (id) throw fail('A Gist is already configured. Clear its ID before creating another.');
        const response = checkResponse(await send(context, 'https://api.github.com/gists', { method: 'POST', headers,
            body: { public: false, description: 'Encrypted Neconyan device sync', files: { [filename]: { content } } }, max: 2 * 1024 * 1024 }), [201]);
        id = response.value().id;
        if (typeof id !== 'string' || !/^[a-f0-9]{5,64}$/.test(id)) throw fail('GitHub returned an invalid Gist ID.', 502);
        context.guard();
        withSync(context.base, context.account, ({ state, save }) => { state.methods.gist.gistId = id; save(); });
        return { imported: 0, conflicts: 0, published: true, gistId: id };
    }
    if (!id) throw fail('Choose an existing secret Gist or create one explicitly.');
    const url = 'https://api.github.com/gists/' + id;
    const response = checkResponse(await send(context, url, { headers, max: 4 * 1024 * 1024 }), [200]);
    const gist = response.value();
    if (gist.public !== false || !plain(gist.files)) throw fail('Choose a secret Gist, not a public one. Secret Gists are unlisted, not private.');
    const files = Object.entries(gist.files).filter(([name]) => gistFile.test(name));
    if (files.length >= 32 || Object.keys(gist.files).length >= 90) throw fail('This Gist reached the retained snapshot limit. Create a new secret Gist; existing versions were left intact.', 413);
    // Validate all encrypted files before applying any. GitHub raw_url is intentionally never fetched.
    const packages = [];
    for (const [, file] of files) {
        if (file.truncated || typeof file.content !== 'string' || file.size > GIST_LIMIT || Buffer.byteLength(file.content) > GIST_LIMIT) throw fail('GitHub truncated a sync file or it exceeds the Gist limit. Use another method; no raw URL was followed.', 413);
        try { packages.push(JSON.parse(file.content)); } catch { throw fail('A Gist sync file is not valid JSON.'); }
    }
    const { decrypt } = await import('./protocol.js');
    const { validateData } = await import('./data.js');
    for (const item of packages) validateData(await decrypt(item, context.passphrase));
    let result = { imported: 0, conflicts: 0, unchanged: 0 };
    for (const item of packages) {
        const next = await importEnvelope(context, item, 'gist:' + id);
        for (const key of ['imported', 'conflicts', 'unchanged']) result[key] += next[key] ?? 0;
    }
    // Regenerate after reconciliation. Each publication has a unique name; never patch/delete another file.
    const merged = JSON.stringify(await exportEnvelope(context));
    if (Buffer.byteLength(merged) > GIST_LIMIT) throw fail('The reconciled encrypted selection exceeds the 900 KiB Gist limit.', 413);
    checkResponse(await send(context, url, { method: 'PATCH', headers, body: { files: { [filename]: { content: merged } } }, max: 4 * 1024 * 1024 }), [200]);
    const verify = checkResponse(await send(context, url, { headers, max: 4 * 1024 * 1024 }), [200]).value();
    if (verify.files?.[filename]?.truncated || verify.files?.[filename]?.content !== merged) throw fail('The new immutable Gist file could not be verified. Retry manually; existing files were not overwritten.', 502);
    return { ...result, published: true, gistId: id };
}

export async function pairingSync(context, send = request) {
    const peer = context.config.peer;
    if (!peer) throw fail('Save a pairing code from the receiving installation first.');
    const url = `${peer.url}/api/device-sync/pair/${encodeURIComponent(peer.owner)}/${peer.id}`;
    const headers = { Authorization: 'NeconyanPair ' + peer.token };
    const envelope = await exportEnvelope(context);
    // A grant authenticates exactly this encrypted exchange, never settings or general account APIs.
    const response = checkResponse(await send(context, url, { method: 'POST', headers, body: { envelope }, pairing: true, max: LIMITS.envelope }), [200]);
    const value = response.value();
    const imported = await importEnvelope(context, value.envelope, 'pair:' + peer.url + ':' + peer.id);
    return { ...imported, published: true };
}
