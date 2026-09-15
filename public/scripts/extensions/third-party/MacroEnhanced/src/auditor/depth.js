/**
 * Cache-depth awareness: reads the server's Claude caching settings when the
 * user is an admin, and mirrors the breakpoint walk from the fork's
 * cachingAtDepthForClaude (src/prompt-converters.js) as a pure approximation
 * over the visible chat.
 */
import { getSettings } from '../settings.js';

/**
 * Reads config.yaml's chat-completion settings through the admin endpoint.
 * Non-admin users get a 403. callers fall back to the manual depth setting.
 */
export async function fetchServerCachingConfig() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.getRequestHeaders !== 'function' || typeof fetch !== 'function') {
        return { ok: false, status: 0 };
    }
    try {
        const response = await fetch('/api/server-admin/config/chat-completions/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            return { ok: false, status: response.status };
        }
        const data = await response.json();
        return { ok: true, claude: data?.settings?.claude ?? {}, lastModifiedMs: data?.lastModifiedMs ?? null };
    } catch {
        return { ok: false, status: 0 };
    }
}

/**
 * The effective caching config: server values when readable, else the manual
 * depth from the extension settings, else "unknown".
 *
 * @param {object} [deps] - {fetchConfig} injectable for tests.
 */
export async function resolveCachingConfig({ fetchConfig = fetchServerCachingConfig } = {}) {
    const server = await fetchConfig();
    if (server.ok) {
        const depth = Number(server.claude?.cachingAtDepth);
        return {
            source: 'server',
            cachingAtDepth: Number.isInteger(depth) && depth >= 0 ? depth : null,
            enableSystemPromptCache: !!server.claude?.enableSystemPromptCache,
            extendedTTL: !!server.claude?.extendedTTL,
            lastModifiedMs: server.lastModifiedMs,
        };
    }
    const manual = getSettings().auditor?.manualCachingAtDepth;
    if (Number.isInteger(manual) && manual >= 0) {
        return { source: 'manual', cachingAtDepth: manual, enableSystemPromptCache: null, extendedTTL: null, lastModifiedMs: null };
    }
    return { source: 'none', cachingAtDepth: null, enableSystemPromptCache: null, extendedTTL: null, lastModifiedMs: null };
}

/**
 * Role-switch depth per message, counted from the end of the chat. the same
 * unit cachingAtDepthForClaude uses for its breakpoints. An approximation: the
 * final converter array can differ (injections, summaries, group formatting),
 * and the outgoing prefill is not part of the visible chat.
 *
 * @param {{isUser: boolean}[]} messages - Chronological.
 * @returns {number[]} depth per message; 0 = the newest role block.
 */
export function computeMessageDepths(messages) {
    const depths = new Array(messages.length).fill(0);
    let depth = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (i < messages.length - 1 && !!messages[i].isUser !== !!messages[i + 1].isUser) {
            depth++;
        }
        depths[i] = depth;
    }
    return depths;
}

/**
 * Whether a volatile macro at this message depth actually costs money:
 * at or above cachingAtDepth it sits inside the cached prefix.
 */
export function messageVerdict(depth, cachingAtDepth) {
    if (cachingAtDepth === null || cachingAtDepth === undefined || cachingAtDepth < 0) {
        return 'no-caching';
    }
    return depth >= cachingAtDepth ? 'costly' : 'harmless';
}
