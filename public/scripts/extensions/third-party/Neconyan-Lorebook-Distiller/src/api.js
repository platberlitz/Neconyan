// The extension's entire host and network surface.

export const MODEL_RESPONSE_TOKENS = 1500;

const MAX_WORLD_INFO_NAME_BYTES = 234;

async function post(ctx, url, body, signal) {
    const response = await fetch(url, {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        let message;
        try {
            message = (await response.json())?.message;
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw error;
            }
        }
        const error = new Error(message || `${url} failed with status ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

async function postArray(ctx, url, body, signal) {
    const data = await post(ctx, url, body, signal);
    if (!Array.isArray(data)) {
        throw new Error(`${url} returned an invalid response`);
    }
    return data;
}

/**
 * Recent chats the distiller can actually read: character chats only.
 * Group chats use a different loader and root orphans cannot be read
 * through the app at all, so both are left out rather than half-supported.
 */
export async function listReadableChats(ctx, signal) {
    const rows = await postArray(ctx, '/api/chats/recent', { max: 100 }, signal);
    return rows.filter(row => row && typeof row === 'object' && row.avatar && row.file_name);
}

/** Reads the full messages of a character chat file that is not open. */
export async function readChatFile(ctx, { avatar, fileName }, signal) {
    const character = (ctx.characters ?? []).find(item => item?.avatar === avatar);
    const rows = await postArray(ctx, '/api/chats/get', {
        ch_name: character?.name ?? '',
        file_name: String(fileName ?? '').replace(/\.jsonl$/, ''),
        avatar_url: avatar,
    }, signal);
    // The first row is the chat's metadata header, not a message.
    return rows.filter(row => row && typeof row.mes === 'string');
}

export function currentChatMessages(ctx) {
    return (ctx.chat ?? []).filter(message => message && typeof message.mes === 'string');
}

export function listBooks(ctx) {
    const names = ctx.getWorldInfoNames?.();
    return Array.isArray(names) ? [...names] : [];
}

async function loadBook(ctx, name, signal) {
    const data = await post(ctx, '/api/worldinfo/get', { name }, signal);
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        throw new Error(`Lorebook "${name}" contains invalid data.`);
    }
    return data;
}

async function canonicalBookName(ctx, name, signal) {
    const response = await post(ctx, '/api/files/sanitize-filename', { fileName: name }, signal);
    const encoder = new TextEncoder();
    let result = '';
    let bytes = 0;
    for (const character of String(response?.fileName ?? '')) {
        const size = encoder.encode(character).length;
        if (bytes + size > MAX_WORLD_INFO_NAME_BYTES) {
            break;
        }
        result += character;
        bytes += size;
    }
    if (!result) {
        throw new Error('The lorebook name contains no usable filename characters.');
    }
    return result;
}

async function requireMissingBook(ctx, name, signal) {
    const names = await postArray(ctx, '/api/worldinfo/list', {}, signal);
    if (names.some(existing => String(existing?.file_id ?? '').localeCompare(name, undefined, { sensitivity: 'base' }) === 0)) {
        throw new Error(`Lorebook "${name}" already exists.`);
    }
    try {
        await post(ctx, '/api/worldinfo/get', { name }, signal);
        throw new Error(`Lorebook "${name}" already exists.`);
    } catch (error) {
        if (error?.status !== 404) {
            throw error;
        }
    }
}

export async function prepareBook(ctx, name, { create = false, signal } = {}) {
    let bookName = String(name ?? '').trim();
    if (!bookName) {
        throw new Error('A lorebook name is required.');
    }
    if (create) {
        bookName = await canonicalBookName(ctx, bookName, signal);
        await requireMissingBook(ctx, bookName, signal);
        return { name: bookName, entries: [] };
    }
    return { name: bookName, entries: Object.values((await loadBook(ctx, bookName, signal)).entries) };
}

/** Appends approved proposals, failing closed unless creation was explicit. */
export async function appendEntries(ctx, name, proposals, { create = false } = {}) {
    let bookName = String(name ?? '').trim();
    if (!bookName) {
        throw new Error('A lorebook name is required.');
    }

    let data;
    if (create) {
        // ponytail: the host has no atomic create-if-absent, so recheck immediately before its upsert.
        bookName = (await prepareBook(ctx, bookName, { create: true })).name;
        data = { entries: {} };
    } else {
        data = await loadBook(ctx, bookName);
    }

    for (const proposal of proposals) {
        const entry = ctx.createWorldInfoEntry(bookName, data);
        entry.comment = proposal.title;
        entry.content = proposal.content;
        entry.key = [...proposal.keys];
    }
    await ctx.saveWorldInfo(bookName, data, true);

    let refreshError = null;
    try {
        await ctx.updateWorldInfoList?.();
    } catch (error) {
        refreshError = error;
    }
    return { name: bookName, refreshError };
}

export function listConnectionProfiles(ctx) {
    try {
        const profiles = ctx.ConnectionManagerRequestService?.getSupportedProfiles?.();
        return Array.isArray(profiles)
            ? profiles.filter(profile => profile?.id && profile?.name)
            : [];
    } catch {
        return [];
    }
}

/** One isolated model call through a named profile or the current connection. */
export async function runModel(ctx, prompt, {
    profileId = '',
    responseLength = MODEL_RESPONSE_TOKENS,
    signal,
} = {}) {
    if (profileId) {
        const service = ctx.ConnectionManagerRequestService;
        if (typeof service?.sendRequest !== 'function') {
            throw new Error('Connection profiles are unavailable in this Neconyan build. Use the current connection instead.');
        }
        const result = await service.sendRequest(profileId, prompt, responseLength, { signal });
        return typeof result === 'string' ? result : String(result?.content ?? '');
    }
    if (typeof ctx.generateRaw !== 'function') {
        throw new Error('This Neconyan build cannot run isolated background requests.');
    }
    return String(await ctx.generateRaw({
        prompt,
        responseLength,
        trimNames: false,
        signal,
    }) ?? '');
}
