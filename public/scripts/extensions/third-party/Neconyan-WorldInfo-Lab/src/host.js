const WORLD_INFO_URL = '/scripts/world-info.js';
const SCAN_CORE_URL = '/scripts/world-info-scan-core.js';
const CHARACTER_BOOK_URL = '/scripts/world-info-character-book.js';
const REGEX_ENGINE_URL = '/scripts/extensions/regex/engine.js';
const UTILS_URL = '/scripts/utils.js';
const TAGS_URL = '/scripts/tags.js';
const SCRIPT_URL = '/script.js';

let loaded = null;
let loading = null;
const worldInfoWrites = new Map();
const freshWorldInfoRevisions = new WeakMap();

export function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function missing(module, exports) {
    return exports.filter(name => module?.[name] === undefined);
}

export async function loadHost() {
    if (loaded?.ok) {
        return loaded;
    }
    if (!loading) {
        loading = (async () => {
            try {
                const [worldInfo, scanCore, characterBook, regex, utils, tags, script] = await Promise.all([
                    import(WORLD_INFO_URL),
                    import(SCAN_CORE_URL),
                    import(CHARACTER_BOOK_URL),
                    import(REGEX_ENGINE_URL).catch(() => null),
                    import(UTILS_URL),
                    import(TAGS_URL).catch(() => null),
                    import(SCRIPT_URL),
                ]);
                const required = [
                    ...missing(worldInfo, [
                        'getWorldInfoSettings',
                        'parseRegexFromString',
                        'selected_world_info',
                        'world_info_position',
                    ]),
                    ...missing(scanCore, [
                        'normalizeWorldInfoProbability',
                    ]),
                    ...missing(characterBook, ['normalizeWorldInfoPosition']),
                    ...missing(utils, ['getStringHash', 'getCharaFilename']),
                    ...missing(script, ['getMaxPromptTokens']),
                ];
                const context = getContext();
                required.push(...['loadWorldInfo', 'getTokenCountAsync']
                    .filter(name => typeof context?.[name] !== 'function')
                    .map(name => `context.${name}`));
                if (required.length) {
                    return {
                        ok: false,
                        reason: `World Info Lab is incompatible with this Neconyan build. Missing tools: ${required.join(', ')}.`,
                    };
                }
                loaded = {
                    ok: true,
                    worldInfo,
                    scanCore,
                    characterBook,
                    regex,
                    utils,
                    tags,
                    script,
                    warnings: regex ? [] : ['Lorebook regex scripts could not be applied, so inserted content may differ from an actual reply.'],
                };
                return loaded;
            } catch (error) {
                return {
                    ok: false,
                    reason: `World Info Lab could not load Neconyan's lorebook tools. Technical details: ${error?.message ?? error}`,
                };
            }
        })();
    }
    try {
        return await loading;
    } finally {
        loading = null;
    }
}

export async function countTokens(text) {
    const context = getContext();
    if (typeof context?.getTokenCountAsync !== 'function') {
        throw new Error('The scan could not count lorebook tokens because no tokenizer is available. Load or select a model tokenizer, then try again.');
    }
    return context.getTokenCountAsync(String(text ?? ''));
}

export function substitute(text, postProcessFn) {
    const context = getContext();
    const input = String(text ?? '');
    if (typeof context?.substituteParams !== 'function') {
        return input;
    }
    const output = typeof postProcessFn === 'function'
        ? context.substituteParams(input, { postProcessFn })
        : context.substituteParams(input);
    return String(output ?? '');
}

export async function loadWorldInfoFresh(name, { signal } = {}) {
    const context = getContext();
    if (typeof context?.getRequestHeaders !== 'function' || typeof globalThis.fetch !== 'function') {
        throw new Error('World Info Lab could not verify the latest saved lorebook, so nothing was saved. Reload Neconyan and try again.');
    }
    const response = await globalThis.fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name }),
        cache: 'no-cache',
        signal,
    });
    if (!response.ok) {
        throw new Error(`"${name}" could not be reloaded from the server (HTTP ${response.status}). Nothing was saved; check the server and preview again.`);
    }
    const revision = response.headers?.get?.('X-World-Info-Revision');
    if (!revision) {
        throw new Error('World Info Lab could not verify this lorebook revision. Nothing was saved; reload Neconyan and try again.');
    }
    const data = await response.json();
    freshWorldInfoRevisions.set(data, revision);
    return data;
}

function checkAbort(signal) {
    if (signal?.aborted) {
        throw new DOMException('Lorebook update canceled. Nothing was saved.', 'AbortError');
    }
}

function sameBook(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function mutateWorldInfoNow(name, mutation, signal) {
    const context = getContext();
    if (typeof context?.loadWorldInfo !== 'function' || typeof context?.saveWorldInfo !== 'function') {
        throw new Error('Neconyan cannot save lorebooks in this session. Nothing was saved.');
    }
    checkAbort(signal);
    const [cached, fresh] = await Promise.all([
        context.loadWorldInfo(name),
        loadWorldInfoFresh(name, { signal }),
    ]);
    checkAbort(signal);
    if (!sameBook(cached, fresh)) {
        throw new Error(`"${name}" has unsaved or newer changes. Nothing was saved; reload it and try again.`);
    }

    const baseline = JSON.stringify(fresh);
    const next = structuredClone(fresh);
    const result = await mutation(next);
    checkAbort(signal);
    if (JSON.stringify(next) === baseline) {
        return result;
    }

    const [cachedAgain, freshAgain] = await Promise.all([
        context.loadWorldInfo(name),
        loadWorldInfoFresh(name, { signal }),
    ]);
    checkAbort(signal);
    if (JSON.stringify(cachedAgain) !== baseline || JSON.stringify(freshAgain) !== baseline) {
        throw new Error(`"${name}" changed while the update was being checked. Nothing was saved; reload it and try again.`);
    }
    await context.saveWorldInfo(name, next, true, { revision: freshWorldInfoRevisions.get(fresh) });
    return result;
}

export function mutateWorldInfo(name, mutation, { signal } = {}) {
    const bookName = String(name ?? '').trim();
    if (!bookName || typeof mutation !== 'function') {
        return Promise.reject(new TypeError('A lorebook and mutation are required.'));
    }
    const previous = worldInfoWrites.get(bookName) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => mutateWorldInfoNow(bookName, mutation, signal));
    worldInfoWrites.set(bookName, operation);
    const clean = () => {
        if (worldInfoWrites.get(bookName) === operation) {
            worldInfoWrites.delete(bookName);
        }
    };
    operation.then(clean, clean);
    return operation;
}

export function notify(level, message) {
    const method = globalThis.toastr?.[level];
    if (typeof method === 'function') {
        method(message, 'World Info Lab');
    } else if (typeof globalThis.alert === 'function') {
        globalThis.alert(`World Info Lab\n\n${message}`);
    }
}

export function __setHostForTests(value) {
    loaded = value;
    loading = null;
}
