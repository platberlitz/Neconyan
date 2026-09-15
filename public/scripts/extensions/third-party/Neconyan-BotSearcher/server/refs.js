/**
 * Signed, opaque thumbnail references.
 *
 * The whole point of the thumbnail proxy is privacy, and the naive way to build
 * one — /thumb?url=https://... — would be a full server-side request forgery,
 * and strictly worse than loading the image directly. So /thumb never accepts a
 * URL. It accepts a token that THIS process minted during a search, carrying
 * only the few opaque fields the adapter needs to rebuild the URL from its own
 * fixed base.
 *
 * Even a compromised upstream cannot steer us: the payload holds no host and no
 * path separator, the adapter re-validates every field, and a token this process
 * did not mint fails the signature check before it is ever parsed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The signing secret, kept in private application data across restarts.
 * If that directory is not writable, use a fresh in-memory secret.
 *
 * It used to be per-process, which meant every restart invalidated every
 * outstanding cursor and turned an ordinary "Load more" into "the result page
 * expired". This stack restarts often enough for that to be a routine
 * annoyance rather than an edge case.
 *
 * Persisting it is cheap in risk terms because a token is not a capability:
 * every field inside one is re-validated by the adapter that consumes it — a
 * cursor against its page-range check, a thumbnail ref against the adapter's own
 * id pattern — so forging one buys an attacker a request they could already have
 * made. The signature exists to stop /thumb being turned into a URL fetcher, and
 * that property does not depend on the secret being new each boot.
 *
 * Any failure falls back to a random in-memory secret, which is exactly the old
 * behaviour. A read-only install therefore still works.
 */
const SECRET = loadOrCreateSecret();

function loadOrCreateSecret() {
    const dataRoot = typeof globalThis.DATA_ROOT === 'string' && path.isAbsolute(globalThis.DATA_ROOT)
        ? globalThis.DATA_ROOT
        : path.join(process.cwd(), 'data');
    const directory = path.join(dataRoot, 'neconyan-botsearcher');
    const file = path.join(directory, '.cursor-key');

    try {
        const existing = fs.readFileSync(file);
        if (existing.length === 32) {
            return existing;
        }
    } catch {
        // Not there yet, or unreadable. Fall through and try to create it.
    }

    const fresh = crypto.randomBytes(32);
    try {
        // Owner-only, and never overwrite: two workers racing here must end up
        // agreeing on one secret rather than each clobbering the other's.
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, fresh, { mode: 0o600, flag: 'wx' });
        return fresh;
    } catch {
        try {
            const raced = fs.readFileSync(file);
            if (raced.length === 32) {
                return raced;
            }
        } catch {
            // Read-only install. In-memory it is.
        }
    }

    return fresh;
}

const SIGNATURE_LENGTH = 22;
// Merged cursors also carry a bounded set of opaque dedupe fingerprints.
const MAX_TOKEN_LENGTH = 2048;

function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(scope, payloadPart) {
    // The source is inside the signed material, so a ref minted for one source
    // cannot be replayed against another adapter's URL builder.
    return base64url(
        crypto.createHmac('sha256', SECRET).update(`${scope}|${payloadPart}`).digest(),
    ).slice(0, SIGNATURE_LENGTH);
}

/**
 * @param {string} source
 * @param {Record<string, string | number>} payload small and flat
 * @returns {string | null}
 */
export function mintToken(scope, payload) {
    if (typeof scope !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }

    let payloadPart;
    try {
        payloadPart = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    } catch {
        return null;
    }

    if (payloadPart.length > MAX_TOKEN_LENGTH - SIGNATURE_LENGTH - 1) {
        return null;
    }

    return `${payloadPart}.${sign(scope, payloadPart)}`;
}

/**
 * Verifies then parses. In that order — an unsigned ref is never JSON.parse'd.
 *
 * @param {string} source
 * @param {unknown} ref
 * @returns {Record<string, unknown> | null}
 */
export function verifyToken(scope, ref) {
    if (typeof scope !== 'string' || typeof ref !== 'string' || ref === '' || ref.length > MAX_TOKEN_LENGTH) {
        return null;
    }

    const separator = ref.lastIndexOf('.');
    if (separator <= 0 || separator === ref.length - 1) {
        return null;
    }

    const payloadPart = ref.slice(0, separator);
    const provided = ref.slice(separator + 1);

    if (!/^[A-Za-z0-9_-]+$/.test(payloadPart) || !/^[A-Za-z0-9_-]+$/.test(provided)) {
        return null;
    }

    const expected = sign(scope, payloadPart);

    // Constant-time compare. timingSafeEqual throws on a length mismatch, so
    // check that first.
    if (provided.length !== expected.length) {
        return null;
    }
    if (!crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }

    return parsed;
}

export function mintRef(source, payload) {
    return mintToken(`thumb:${source}`, payload);
}

export function verifyRef(source, ref) {
    return verifyToken(`thumb:${source}`, ref);
}

export function mintCursor(source, payload) {
    return mintToken(`cursor:${source}`, payload);
}

export function verifyCursor(source, cursor) {
    return verifyToken(`cursor:${source}`, cursor);
}
