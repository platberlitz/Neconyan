import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { fail, json, LIMITS } from './protocol.js';

function forbidden(address) {
    const value = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (!net.isIP(value)) return false;
    const parsed = ipaddr.process(value);
    return ['unspecified', 'linkLocal', 'multicast', 'broadcast', 'carrierGradeNat', 'reserved'].includes(parsed.range())
        || parsed.toNormalizedString().startsWith('fd00:ec2:') || parsed.toString() === '168.63.129.16';
}
function local(address) {
    return ['loopback', 'private', 'uniqueLocal'].includes(ipaddr.process(address).range());
}

function lookup(hostname, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const aborted = () => reject(fail('The sync address lookup failed or timed out.', 502));
        signal.addEventListener('abort', aborted, { once: true });
        dns.lookup(hostname, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
}

export function targetUrl(value, { pairing = false } = {}) {
    let url;
    try { url = new URL(value); } catch { throw fail('Enter a complete server URL.'); }
    if (url.username || url.password || url.hash || url.search || !['https:', ...(pairing ? ['http:'] : [])].includes(url.protocol)
        || /(^|\.)(metadata|metadata\.google\.internal)$/.test(url.hostname) || forbidden(url.hostname)) throw fail('Use an HTTPS URL without embedded credentials, query or fragment. LAN pairing may use HTTP.');
    return url;
}

/** DNS results are checked and pinned to this one connection; redirects are never followed. */
export async function request(context, value, { method = 'GET', headers = {}, body, pairing = false, max = LIMITS.envelope } = {}) {
    context.guard();
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(20000)]);
    signal.throwIfAborted();
    const url = targetUrl(value, { pairing });
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await lookup(hostname, signal);
    context.guard();
    if (!addresses.length || addresses.some(item => forbidden(item.address)) || url.protocol === 'http:' && addresses.some(item => !local(item.address))) throw fail('This network address is not an allowed sync target.');
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    if (data && data.length > max) throw fail('The outgoing encrypted package exceeds the transport limit.', 413);
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, { method, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...headers,
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, signal,
        lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
        }, response => {
            const length = Number(response.headers['content-length']);
            if (length > max || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
                response.destroy(); reject(fail('The sync server returned an oversized or compressed response.', 413)); return;
            }
            const chunks = []; let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > max) { response.destroy(); reject(fail('The sync response exceeds its size limit.', 413)); } else chunks.push(chunk);
            });
            response.on('error', () => reject(fail('The sync response was interrupted. Retry manually.', 502)));
            response.on('end', () => {
                try {
                    context.guard();
                    if (response.statusCode >= 300 && response.statusCode < 400) throw fail('Sync redirects are not followed. Configure the final URL directly.', 502);
                    resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks), value: () => json(Buffer.concat(chunks)) });
                } catch (error) { reject(error); }
            });
        });
        req.on('error', () => reject(fail('The sync connection failed or timed out. Check the address and credentials, then retry manually.', 502)));
        if (data) req.write(data);
        req.end();
    });
}

export function checkResponse(response, statuses) {
    if (statuses.includes(response.status)) return response;
    if (response.status === 401 || response.status === 403) throw fail('The sync server refused these credentials or permissions.', 502);
    if (response.status === 429 || response.status === 422) throw fail('The provider rejected this request or reached a rate/file limit. Wait, check its limits and retry manually.', 502);
    if (response.status === 409 || response.status === 412) throw fail('Another device changed the remote package. Nothing was overwritten. Sync again to reconcile it.', 409);
    throw fail('The sync server returned an unexpected response. Nothing was published; retry manually.', 502);
}
