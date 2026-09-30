import { EXTENSION_LABEL } from './constants.js';

const OPENAI_URL = '/scripts/openai.js';
const TOKEN_COUNTS_URL = '/scripts/prompt-token-counts.js';
const UTILS_URL = '/scripts/utils.js';

let loaded = null;
let loading = null;

export function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

/**
 * Resolves a host reference to a usable context.
 *
 * Neconyan builds a fresh context object on every getContext() call and
 * copies characterId, userAvatar, chatId and mainApi into it *by value*. A
 * context held across a character switch therefore reports the old character
 * for ever. Anything that reads those fields after changing state must pass the
 * getContext function itself rather than one of its results, so callers accept
 * either and resolve through here.
 */
export function ctxOf(source) {
    if (typeof source === 'function') {
        return source() ?? {};
    }
    return source ?? {};
}

function missing(module, exports) {
    return exports.filter(name => module?.[name] === undefined);
}

/**
 * Loads the host modules Prompting Lab reads from and reports, in plain
 * language, anything this Neconyan build does not provide.
 */
export async function loadHost() {
    if (loaded?.ok) {
        return loaded;
    }
    if (!loading) {
        loading = (async () => {
            try {
                const [openai, tokenCounts, utils] = await Promise.all([
                    import(OPENAI_URL),
                    import(TOKEN_COUNTS_URL).catch(() => null),
                    import(UTILS_URL),
                ]);
                const required = [
                    ...missing(openai, ['ChatCompletion', 'oai_settings']),
                    ...missing(utils, ['getStringHash']),
                ];
                if (typeof globalThis.diff_match_patch !== 'function') {
                    required.push('diff_match_patch');
                }
                if (!globalThis.localforage?.createInstance) {
                    required.push('localforage');
                }
                if (required.length) {
                    return {
                        ok: false,
                        reason: `${EXTENSION_LABEL} is not compatible with this Neconyan build. Missing tools: ${required.join(', ')}.`,
                    };
                }
                const warnings = [];
                if (typeof tokenCounts?.getPromptDisplayTokenCounts !== 'function') {
                    warnings.push('Per-section token counts use a simpler calculation on this Neconyan build.');
                }
                loaded = {
                    ok: true,
                    openai,
                    tokenCounts,
                    utils,
                    warnings,
                };
                return loaded;
            } catch (error) {
                return {
                    ok: false,
                    reason: `${EXTENSION_LABEL} could not load Neconyan's prompt tools. Technical details: ${error?.message ?? error}`,
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

/**
 * Per-section token counts. Falls back to summing the collection totals when
 * the fork-specific helper is absent.
 */
export function displayTokenCounts(host, messages) {
    const helper = host?.tokenCounts?.getPromptDisplayTokenCounts;
    if (typeof helper === 'function') {
        try {
            return helper(messages) ?? {};
        } catch {
            // Fall through to the local calculation below.
        }
    }
    const counts = {};
    for (const collection of messages?.getCollection?.() ?? []) {
        if (collection?.identifier) {
            counts[collection.identifier] = Number(collection.getTokens?.() ?? 0);
        }
    }
    return counts;
}

export function stringHash(host, text) {
    const hash = host?.utils?.getStringHash;
    return typeof hash === 'function' ? String(hash(String(text ?? ''))) : '';
}

/**
 * Counts tokens for a piece of text. No padding argument is passed: the host
 * treats a padding value equal to its own default as a signal to use the
 * rough estimator instead of the real tokenizer.
 */
export async function countTokens(text) {
    const context = getContext();
    if (typeof context?.getTokenCountAsync !== 'function') {
        return null;
    }
    try {
        return await context.getTokenCountAsync(String(text ?? ''));
    } catch {
        return null;
    }
}

/**
 * Sends a JSON request to Neconyan's own API with its request headers.
 *
 * The security token can expire while the page is open. Neconyan refreshes
 * it from script.js, so one retry is attempted before giving up.
 */
export async function requestJson(url, body, { signal } = {}) {
    const context = getContext();
    const send = async () => fetch(url, {
        method: 'POST',
        headers: context?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    let response = await send();
    if (response.status === 403) {
        try {
            const script = await import('/script.js');
            await script.refreshCsrfToken?.();
            response = await send();
        } catch {
            signal?.throwIfAborted();
            // Keep the original response so the caller reports the real problem.
        }
    }
    if (!response.ok) {
        throw new Error(`Neconyan refused the request (${response.status}).`);
    }
    const text = await response.text();
    return text && text.trim() !== 'OK' ? JSON.parse(text) : {};
}

function parseMaybeJson(value) {
    if (typeof value !== 'string') {
        return value ?? null;
    }
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function pairUp(payloads, names) {
    const list = [];
    for (let index = 0; index < names.length; index += 1) {
        const payload = parseMaybeJson(payloads[index]);
        if (payload && typeof payload === 'object') {
            list.push({ name: String(names[index]), payload });
        }
    }
    return list;
}

/**
 * Reads every installed preset straight from Neconyan's own settings
 * endpoint. This is the only way to see what is actually saved on disk, which
 * is what publishing has to check against.
 */
export async function readPresetCatalog({ signal } = {}) {
    const data = await requestJson('/api/settings/get', { sections: ['presets'] }, { signal });
    return {
        openai: pairUp(data.openai_settings ?? [], data.openai_setting_names ?? []),
        textgenerationwebui: pairUp(data.textgenerationwebui_presets ?? [], data.textgenerationwebui_preset_names ?? []),
        context: namedList(data.context),
        instruct: namedList(data.instruct),
        sysprompt: namedList(data.sysprompt),
        reasoning: namedList(data.reasoning),
    };
}

function namedList(entries) {
    return (Array.isArray(entries) ? entries : [])
        .filter(entry => entry && typeof entry === 'object' && entry.name)
        .map(entry => ({ name: String(entry.name), payload: entry }));
}

/**
 * Lists the preset names Neconyan currently has loaded for one API.
 */
export function listInstalledPresets(apiId, source = getContext) {
    const manager = ctxOf(source).getPresetManager?.(apiId);
    const names = manager?.getAllPresets?.() ?? [];
    return Array.isArray(names) ? names.map(String) : [];
}

/**
 * Copies one installed preset. The host hands back its live object, so it is
 * cloned immediately: editing it in place would rewrite Neconyan's settings.
 */
export function readInstalledPreset(apiId, name, source = getContext) {
    const manager = ctxOf(source).getPresetManager?.(apiId);
    const payload = manager?.getCompletionPresetByName?.(name);
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    return structuredClone(payload);
}

export function notify(level, message) {
    const method = globalThis.toastr?.[level];
    if (typeof method === 'function') {
        method(message, EXTENSION_LABEL);
    } else if (typeof globalThis.alert === 'function') {
        globalThis.alert(`${EXTENSION_LABEL}\n\n${message}`);
    }
}

export function __setHostForTests(value) {
    loaded = value;
    loading = null;
}
