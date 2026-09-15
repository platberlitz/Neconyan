/**
 * Importing a card, and getting hold of its bytes first.
 *
 * Every card now reaches the intake screen as bytes, whichever source it came
 * from, so one report can describe all of them.
 *
 * For a native source those bytes come from Neconyan's own `/api/content/importURL`,
 * which downloads a card and hands it back to the browser rather than importing
 * it (src/endpoints/content-manager.js:1716). That matters more than it looks:
 * the bytes inspected are then the exact bytes imported, the fork's per-site
 * downloaders keep doing the downloading — including the Cloudflare-aware
 * Janitor path — and this plugin gains no new outbound request. `/card` still
 * refuses native sources for the same reason it always did.
 */

import { isAllowedUpstreamUrl } from './render.js';
import { PLUGIN_BASE } from './constants.js';
import { MAX_CARD_BYTES } from '../shared/schema.js';
import { readResponseBytes } from './api.js';

/** Host route that downloads a card and returns it without importing it. */
const HOST_IMPORT_URL = '/api/content/importURL';

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/** Keep this extension's imports, replacements and Undo operations in order. */
let importTail = Promise.resolve();

/**
 * @typedef {object} ImportReceipt
 * @property {string | null} avatar Exact host filename, or null without a valid receipt.
 * @property {string} name
 * @property {true | null} committed Null means the write's outcome is unknown.
 * @property {boolean} canUndo False for replacements or unverifiable additions.
 * @property {string | null} revision SHA-256 of the installed PNG, never card text.
 * @property {boolean} refreshed Whether the host list actually refreshed.
 * @property {boolean} [replaced]
 */

function context() {
    return globalThis.SillyTavern.getContext();
}

/**
 * @param {any} card a normalized CardSummary/CardDetail
 * @param {{ nativeImport?: boolean, clientHosts?: readonly string[] }} source immutable source metadata
 * @param {{ signal?: AbortSignal, onCommitStart?: () => void }} [options]
 * @returns {Promise<ImportReceipt>}
 */
export async function importCard(card, source, { signal, onCommitStart } = {}) {
    // Bypass inspection only, not cancellation or authoritative import receipts.
    const prepared = await fetchNativeCardBytes(card, source, { signal });
    return commitPreparedCardImport(prepared, { signal, onCommitStart });
}

/**
 * Fetches a byte-card without adding it to Neconyan. The caller retains the
 * returned object until the user explicitly confirms the import.
 *
 * @param {any} card
 * @param {{ id: string }} source
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ file: File, kind: 'json' | 'png' }>}
 */
export async function prepareCardImport(card, source, { signal } = {}) {
    const ctx = context();
    const requestSignal = operationSignal(signal, 20_000);
    requestSignal.throwIfAborted();
    const cardResponse = await fetch(`${PLUGIN_BASE}/card`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ source: source?.id, id: card?.id }),
        signal: requestSignal,
    });

    if (!cardResponse.ok) {
        throw await cardResponseError(cardResponse);
    }

    const kind = cardResponse.headers.get('X-SBBS-Card-Kind') === 'json' ? 'json' : 'png';
    const bytes = await readResponseBytes(cardResponse, MAX_CARD_BYTES, requestSignal);
    requestSignal.throwIfAborted();
    const fileName = `${source.id}-${String(card.id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64)}.${kind}`;
    return { file: fileFrom(bytes, fileName, kind), kind };
}

/** Fetches a validated card from one of the server's fixed URL-import bridges. */
export async function fetchUrlCard(url, source, { signal } = {}) {
    if (typeof url !== 'string' || url.trim() === '' || typeof source?.id !== 'string') {
        throw new Error('bad_import_url');
    }

    const ctx = context();
    const requestSignal = operationSignal(signal, 120_000);
    requestSignal.throwIfAborted();
    const response = await fetch(`${PLUGIN_BASE}/url-card`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ source: source.id, url: url.trim() }),
        signal: requestSignal,
    });
    if (!response.ok) {
        throw await cardResponseError(response);
    }

    const kind = response.headers.get('X-SBBS-Card-Kind') === 'png' ? 'png' : 'json';
    const bytes = await readResponseBytes(response, MAX_CARD_BYTES, requestSignal);
    requestSignal.throwIfAborted();
    return { file: fileFrom(bytes, `${source.id}-url.${kind}`, kind), kind };
}

/**
 * Asks Neconyan to download a native source's card and hand back the bytes,
 * so the intake screen can describe what the import would actually bring in.
 *
 * The URL is the one the adapter built and is re-checked here, exactly as the
 * unscanned native import re-checks it. Nothing is imported by this call.
 *
 * @param {any} card
 * @param {{ nativeImport?: boolean, clientHosts?: readonly string[] }} source
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ file: File, kind: 'json' | 'png' }>}
 */
export async function fetchNativeCardBytes(card, source, { signal } = {}) {
    if (source?.nativeImport !== true || typeof card?.importUrl !== 'string') {
        throw new Error('import_unsupported');
    }
    if (!isAllowedUpstreamUrl(card.importUrl, source.clientHosts)) {
        throw new Error('import_url_rejected');
    }

    const ctx = context();
    const requestSignal = operationSignal(signal, 60_000);
    requestSignal.throwIfAborted();
    const response = await fetch(HOST_IMPORT_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ url: card.importUrl }),
        signal: requestSignal,
    });

    if (!response.ok) {
        throw new Error('native_download_failed');
    }
    // The same route serves lorebooks. Only a character may reach the importer.
    if (response.headers.get('X-Custom-Content-Type') !== 'character') {
        throw new Error('not_a_character');
    }

    const bytes = await readResponseBytes(response, MAX_CARD_BYTES, requestSignal);
    requestSignal.throwIfAborted();
    // Magic bytes decide the kind, for the same reason the server ignores the
    // upstream Content-Type: the header is the part nobody here controls.
    const kind = looksPng(bytes) ? 'png' : 'json';
    const slug = String(card.id ?? 'card').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'card';
    return { file: fileFrom(bytes, `${source.id ?? 'card'}-${slug}.${kind}`, kind), kind };
}

/**
 * Reads a card the user chose from their own machine.
 * @param {File} file
 * @returns {Promise<{ file: File, kind: 'json' | 'png' }>}
 */
export async function readLocalCardFile(file, { signal } = {}) {
    signal?.throwIfAborted();
    if (!(file instanceof File)) {
        throw new Error('card_invalid');
    }
    if (file.size > MAX_CARD_BYTES) {
        throw new Error('too_large');
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    signal?.throwIfAborted();
    const kind = looksPng(bytes) ? 'png' : 'json';
    const name = file.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 96) || `card.${kind}`;
    return { file: fileFrom(bytes, name, kind), kind };
}

/**
 * Reports what is inside card bytes. Sends the bytes, receives a description —
 * this route hands nothing back that could be imported.
 *
 * @param {File} file
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object>}
 */
export async function inspectBytes(file, { signal } = {}) {
    const requestSignal = operationSignal(signal, 30_000);
    const response = await postBytes('/inspect', file, requestSignal);
    if (!response.ok) {
        throw await cardResponseError(response);
    }
    const report = await response.json();
    requestSignal.throwIfAborted();
    return report;
}

/**
 * Returns the same card with the fixed clean profile applied.
 *
 * @param {{ file: File, kind: 'json' | 'png' }} prepared
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ file: File, kind: 'json' | 'png' }>}
 */
export async function cleanBytes(prepared, { signal } = {}) {
    const requestSignal = operationSignal(signal, 30_000);
    const response = await postBytes('/clean', prepared.file, requestSignal);
    if (!response.ok) {
        throw await cardResponseError(response);
    }

    const bytes = await readResponseBytes(response, MAX_CARD_BYTES, requestSignal);
    requestSignal.throwIfAborted();
    const name = prepared.file.name.replace(/(\.[^.]+)?$/, `-clean.${prepared.kind}`);
    return { file: fileFrom(bytes, name, prepared.kind), kind: prepared.kind };
}

function postBytes(path, file, signal) {
    signal?.throwIfAborted();
    const ctx = context();
    return fetch(`${PLUGIN_BASE}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        // The CSRF token and session come from the host's own header builder;
        // only the content type differs from every other call we make.
        headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/octet-stream' },
        body: file,
        signal,
    });
}

function looksPng(bytes) {
    return bytes.length >= PNG_SIGNATURE.length
        && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function fileFrom(bytes, name, kind) {
    return new File([bytes], name, { type: kind === 'json' ? 'application/json' : 'image/png' });
}

/**
 * Commits card bytes the intake screen has already described.
 *
 * `replaceAvatar` overwrites an installed character instead of adding a second
 * copy, using the host importer's own `preserved_name` field
 * (src/endpoints/characters.js:1934).
 *
 * Cancellation applies until the POST starts. Once sent, the write settles
 * independently of the screen and returns a receipt, even if refresh fails.
 * @param {{ file: File, kind: 'json' | 'png' }} prepared
 * @param {{ replaceAvatar?: string, expectedRevision?: string, requireNewName?: string, signal?: AbortSignal, onCommitStart?: () => void }} [options]
 * @returns {Promise<ImportReceipt>}
 */
export async function commitPreparedCardImport(prepared, { replaceAvatar, expectedRevision, requireNewName, signal, onCommitStart } = {}) {
    if (!(prepared?.file instanceof File) || (prepared.kind !== 'json' && prepared.kind !== 'png')) {
        throw new Error('card_invalid');
    }
    if (prepared.file.size > MAX_CARD_BYTES) {
        throw new Error('too_large');
    }
    if (replaceAvatar !== undefined && !validAvatar(replaceAvatar)) {
        throw new Error('character_unverified');
    }

    return serializeImport(async () => {
        assertCanWrite(signal);
        let before = null;
        if (replaceAvatar) {
            await verifyRevision(replaceAvatar, expectedRevision, signal);
        } else {
            let collection;
            try {
                collection = await readCollection({ signal });
                before = new Set(collection.map((entry) => entry.avatar));
            } catch {
                signal?.throwIfAborted();
                if (requireNewName !== undefined) {
                    throw new Error('collection_unavailable');
                }
                // Explicit imports can proceed after an unknown collection
                // check, but cannot authorise deletion of a possibly old file.
            }
            if (requireNewName !== undefined) {
                if (typeof requireNewName !== 'string' || requireNewName.trim() === '') {
                    throw new Error('collection_unavailable');
                }
                if (collection.some((entry) => entry.name.trim().toLowerCase() === requireNewName.trim().toLowerCase())) {
                    throw new Error('duplicate_detected');
                }
            }
        }
        const ctx = context();
        const form = new FormData();
        form.append('avatar', prepared.file);
        form.append('file_type', prepared.kind);
        if (typeof replaceAvatar === 'string' && replaceAvatar !== '') {
            form.append('preserved_name', replaceAvatar);
        }

        assertCanWrite(signal);
        onCommitStart?.();
        assertCanWrite(signal);
        // omitContentType so the browser sets the multipart boundary itself.
        let importResponse;
        try {
            importResponse = await fetch('/api/characters/import', {
                method: 'POST',
                credentials: 'same-origin',
                headers: ctx.getRequestHeaders({ omitContentType: true }),
                body: form,
            });
        } catch {
            return { avatar: null, name: '', committed: null, canUndo: false, revision: null, refreshed: false };
        }
        if (!importResponse.ok) {
            throw new Error('import_failed');
        }

        let payload;
        try {
            payload = await importResponse.json();
        } catch { /* A lost receipt must not turn a possible write into a retry. */ }
        if (payload?.error) {
            throw new Error('import_failed');
        }
        const filename = payload?.file_name;
        const avatar = typeof filename === 'string' && filename !== ''
            ? (/\.png$/i.test(filename) ? filename : `${filename}.png`)
            : null;
        if (!validAvatar(avatar) || (replaceAvatar && avatar !== replaceAvatar) || before?.has(avatar)) {
            return { avatar: null, name: '', committed: null, canUndo: false, revision: null, refreshed: false };
        }

        let revision = null;
        try {
            revision = await readCharacterRevision(avatar);
        } catch { /* Import succeeded; an unavailable revision only withholds Undo. */ }
        const refreshed = await refreshCharacterList(avatar);
        return {
            avatar,
            name: context().characters?.find((entry) => entry?.avatar === avatar)?.name ?? '',
            committed: true,
            replaced: Boolean(replaceAvatar),
            revision,
            canUndo: !replaceAvatar && before !== null && revision !== null,
            refreshed,
        };
    });
}

/**
 * Compatibility helper for callers that do not need an inspection pause.
 *
 * @param {any} card
 * @param {{ id: string }} source
 * @returns {Promise<ImportReceipt>}
 */
export async function importCardBytes(card, source, options = {}) {
    return commitPreparedCardImport(await prepareCardImport(card, source, options), options);
}

function serializeImport(operation) {
    const run = importTail.then(operation, operation);
    importTail = run.catch(() => {});
    return run;
}

function operationSignal(signal, timeoutMs) {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

function assertCanWrite(signal) {
    signal?.throwIfAborted();
    // Both flags are supplied by the host, including non-streaming UI requests.
    if (globalThis.document?.body?.dataset.generating === 'true' || context().streamingProcessor) {
        throw new Error('generation_active');
    }
}

/** Unlike the host's UI refresh helper, this read explicitly checks success. */
export async function readCollection({ signal } = {}) {
    const requestSignal = operationSignal(signal, 30_000);
    requestSignal.throwIfAborted();
    const response = await fetch('/api/characters/all', {
        method: 'POST',
        credentials: 'same-origin',
        headers: context().getRequestHeaders(),
        body: '{}',
        signal: requestSignal,
    });
    if (!response.ok) {
        throw new Error('collection_unavailable');
    }
    const characters = await response.json();
    requestSignal.throwIfAborted();
    if (!Array.isArray(characters) || characters.some((entry) => !validAvatar(entry?.avatar) || typeof entry?.name !== 'string')) {
        throw new Error('collection_unavailable');
    }
    return characters;
}

function validAvatar(avatar) {
    return typeof avatar === 'string' && avatar.length <= 512
        && avatar.length > 4 && /\.png$/i.test(avatar) && !/[/\\\x00-\x1f\x7f]/.test(avatar);
}

/** Hash the installed file, including its portrait, without retaining its text. */
export async function readCharacterRevision(avatar, { signal } = {}) {
    if (!validAvatar(avatar)) {
        throw new Error('character_unverified');
    }
    const requestSignal = operationSignal(signal, 30_000);
    requestSignal.throwIfAborted();
    const response = await fetch(`/characters/${encodeURIComponent(avatar)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: requestSignal,
    });
    if (!response.ok) {
        throw new Error(response.status === 404 ? 'character_missing' : 'character_unverified');
    }
    const bytes = await readResponseBytes(response, MAX_CARD_BYTES, requestSignal);
    if (!looksPng(bytes) || !globalThis.crypto?.subtle) {
        throw new Error('character_unverified');
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    requestSignal.throwIfAborted();
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function verifyRevision(avatar, expected, signal) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
        throw new Error('character_unverified');
    }
    // ponytail: preflight detects prior edits; only a conditional host write can
    // close the remaining check/write race with another tab.
    if (await readCharacterRevision(avatar, { signal }) !== expected) {
        throw new Error('character_changed');
    }
}

async function refreshCharacterList(avatar) {
    const previous = context().characters?.find((entry) => entry?.avatar === avatar);
    try {
        await context().getCharacters();
        const current = context().characters?.find((entry) => entry?.avatar === avatar);
        return avatar ? Boolean(current && current !== previous) : true;
    } catch {
        return false;
    }
}

async function cardResponseError(response) {
    let code = `http_${response.status}`;
    let retryAfter;
    try {
        const payload = await response.json();
        if (typeof payload?.error === 'string') {
            code = payload.error;
        }
        // A limiter's answer carries how long to wait; a bulk import obeys it.
        if (Number.isFinite(payload?.retryAfter) && payload.retryAfter > 0) {
            retryAfter = payload.retryAfter;
        }
    } catch {
        // Not JSON; the status is enough.
    }
    const error = new Error(code);
    error.code = code;
    if (retryAfter !== undefined) {
        error.retryAfter = retryAfter;
    }
    return error;
}

/**
 * Removes a character an import just added. Chats are left alone.
 * The filename stays a literal JSON value, never interpreted command text.
 */
export async function removeCharacter(avatar, { expectedRevision, signal } = {}) {
    return serializeImport(async () => {
        assertCanWrite(signal);
        await verifyRevision(avatar, expectedRevision, signal);
        const ctx = context();
        const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
        const index = characters.findIndex((entry) => entry?.avatar === avatar);
        const character = characters[index] ?? { avatar };
        if (ctx.characterId !== undefined && String(ctx.characterId) === String(index)) {
            if (typeof ctx.closeCurrentChat !== 'function' || await ctx.closeCurrentChat() !== true) {
                throw new Error('chat_close_failed');
            }
            await verifyRevision(avatar, expectedRevision, signal);
        }
        assertCanWrite(signal);
        const response = await fetch('/api/characters/delete', {
            method: 'POST',
            credentials: 'same-origin',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, delete_chats: false }),
        });
        if (!response.ok) {
            throw new Error('delete_failed');
        }
        // UI bookkeeping cannot turn a successful deletion into a retry.
        try {
            for (const prefix of ['AlertWI_', 'AlertRegex_', 'mediaWarningShown:']) {
                ctx.accountStorage?.removeItem(`${prefix}${avatar}`);
            }
            if (ctx.tagMap) {
                delete ctx.tagMap[avatar];
            }
            if (index >= 0) {
                await ctx.eventSource?.emit?.(ctx.eventTypes?.CHARACTER_DELETED, { id: index, character });
            }
        } catch { /* The file is already gone; refresh below is still useful. */ }
        await refreshCharacterList();
    });
}

/**
 * Opens a freshly imported character.
 * @param {string} avatar
 */
export async function openCharacter(avatar) {
    if (!validAvatar(avatar)) {
        throw new Error('character_unverified');
    }
    await refreshCharacterList(avatar);
    const ctx = context();
    const index = (Array.isArray(ctx.characters) ? ctx.characters : []).findIndex((entry) => entry?.avatar === avatar);
    if (index >= 0) {
        await ctx.selectCharacterById(index);
    } else {
        throw new Error('collection_unavailable');
    }
}
