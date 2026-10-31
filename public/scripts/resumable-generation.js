/**
 * Neconyan: generation requests that survive the connection dropping.
 *
 * The server keeps a copy of every tagged reply (src/resumable-generations.js). This wrapper tags
 * each generation request with an id and, when the connection dies or the page wakes up with a
 * stalled stream, reattaches from the last byte it received. The streaming code above it sees one
 * uninterrupted response. Aborting the request's signal cancels the generation for real.
 */
import { createReplyKeepAlive } from './background-keep-alive.js';
import { GENERATION_CONNECTION_LOST } from './generation-outcome.js';

const GENERATION_ID_HEADER = 'X-Generation-Id';
const GENERATION_CONTEXT_HEADER = 'X-Generation-Context';
const RESUME_URL = '/api/resumable-generations/resume';
const CANCEL_URL = '/api/resumable-generations/cancel';
const LIST_URL = '/api/resumable-generations/list';
const DISCARD_URL = '/api/resumable-generations/discard';
const STATUS_URL = '/api/resumable-generations/status';
const RESUME_RETRY_DELAYS_MS = Object.freeze([0, 1000, 2000, 5000]);
/** About a minute and a half of failed attempts; then the reply stops and says the connection was lost. */
const MAX_RESUME_ATTEMPTS = 20;
/** A stream with no bytes for this long when the page becomes visible again gets reconnected. */
const STALE_STREAM_MS = 5000;
/** On a visible page, a connection with no bytes for this long is checked with the server. */
const QUIET_STREAM_MS = 15000;
const WATCHDOG_INTERVAL_MS = 5000;
const STATUS_TIMEOUT_MS = 10000;
const SKIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

/** @type {Map<string, ResumableRequest>} */
const activeRequests = new Map();
/** Replies still being parsed or saved by this page, including after the last byte. */
const ownedReplies = new Map();
/** @type {Set<(busy: boolean) => void>} */
const activityListeners = new Set();
let generationBusy = false;
/** @type {ReturnType<typeof setInterval>|null} */
let watchdogTimer = null;
/**
 * Chat/message-slot descriptions keyed by the abort signal the generation will be sent with.
 * Generate() fills this right before the request goes out; the wrapper reads it once.
 * @type {WeakMap<AbortSignal, Record<string, unknown>>}
 */
const pendingContexts = new WeakMap();

/**
 * Tells the next request sent with `signal` which chat and message slot its reply belongs to, so
 * a page that gets killed mid-reply can find the finished reply later (see recoverGenerations in
 * script.js). Header values must be ASCII, hence base64 of the UTF-8 JSON.
 * @param {AbortSignal|null|undefined} signal Signal the request will be sent with
 * @param {Record<string, unknown>|null} context Small JSON-serialisable object, or null to clear
 */
export function setGenerationContext(signal, context) {
    if (!signal) {
        return;
    }
    if (context) {
        pendingContexts.set(signal, context);
    } else {
        pendingContexts.delete(signal);
    }
}

/**
 * @param {Record<string, unknown>} context Context object
 * @returns {string} base64 of the UTF-8 JSON
 */
function encodeContext(context) {
    const bytes = new TextEncoder().encode(JSON.stringify(context));
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

/**
 * @returns {string} Random id; crypto.randomUUID needs a secure context, this does not.
 */
function notifyGenerationActivity() {
    const busy = activeRequests.size + ownedReplies.size > 0;
    if (busy === generationBusy) {
        return;
    }
    generationBusy = busy;
    for (const listener of activityListeners) {
        try {
            listener(busy);
        } catch (error) {
            console.warn('A generation activity listener failed:', error);
        }
    }
}

/**
 * Calls `listener(true)` when this page starts streaming or saving a reply and `listener(false)` once
 * nothing is left, with the current state straight away.
 * @param {(busy: boolean) => void} listener
 * @returns {() => void} Unsubscribe
 */
export function onGenerationActivity(listener) {
    activityListeners.add(listener);
    listener(generationBusy);
    return () => activityListeners.delete(listener);
}

function createGenerationId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {AbortSignal|null} signal Aborted signal
 * @returns {any} What fetch would have rejected with
 */
function abortError(signal) {
    return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * @param {number} ms Delay
 * @param {AbortSignal|null} signal Cuts the wait short
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    return new Promise(resolve => {
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
    });
}

/**
 * @param {HeadersInit|undefined|null} headers Request headers in any fetch-accepted shape
 * @returns {Record<string, string>}
 */
function headersToObject(headers) {
    if (!headers) {
        return {};
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }
    return { ...headers };
}

/**
 * @param {Headers} headers Response headers
 * @returns {Record<string, string>} The same headers minus the ones that describe the wire, not the body
 */
function copyResponseHeaders(headers) {
    /** @type {Record<string, string>} */
    const copy = {};
    headers?.forEach?.((value, name) => {
        if (!SKIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
            copy[name] = value;
        }
    });
    return copy;
}

class ResumableRequest {
    /**
     * @param {string} url Generation endpoint
     * @param {RequestInit} init Fetch options as the caller passed them
     */
    constructor(url, init) {
        this.id = createGenerationId();
        this.url = url;
        this.init = init;
        this.outerSignal = init.signal ?? null;
        this.requestHeaders = { ...headersToObject(init.headers), [GENERATION_ID_HEADER]: this.id };
        // Same CSRF token for the resume/cancel calls, but no generation id: that would register a new one.
        this.controlHeaders = Object.fromEntries(Object.entries(this.requestHeaders)
            .filter(([name]) => name.toLowerCase() !== GENERATION_ID_HEADER.toLowerCase()));
        this.controlHeaders['Content-Type'] = 'application/json';
        const context = this.outerSignal ? pendingContexts.get(this.outerSignal) : null;
        this.hasContext = Boolean(context);
        if (context) {
            context.id = this.id;
            ownedReplies.set(this.id, this);
            pendingContexts.delete(this.outerSignal);
            this.requestHeaders[GENERATION_CONTEXT_HEADER] = encodeContext(context);
        }
        this.received = 0;
        this.lastByteAt = Date.now();
        /** Whether the current connection has answered with headers */
        this.hasResponse = false;
        this.nextCheckAt = 0;
        this.checking = false;
        /** The server does not know this id (served without resume support), so there is nothing to check */
        this.untracked = false;
        /** The resume loop gave up; what the server holds is left for recovery, not cancelled */
        this.connectionLost = false;
        this.finished = false;
        /** @type {AbortController|null} */
        this.connection = null;
        this.handleAbort = () => this.cancel();
        this.outerSignal?.addEventListener('abort', this.handleAbort, { once: true });
        activeRequests.set(this.id, this);
        updateWatchdog();
        notifyGenerationActivity();
    }

    get aborted() {
        return Boolean(this.outerSignal?.aborted);
    }

    /**
     * Opens a connection this request can drop on its own, without touching the caller's signal.
     * @param {string} url URL
     * @param {RequestInit} init Fetch options
     * @returns {Promise<Response>}
     */
    connect(url, init) {
        this.connection?.abort();
        const connection = new AbortController();
        this.connection = connection;
        this.hasResponse = false;
        this.lastByteAt = Date.now();
        if (this.aborted) {
            connection.abort(abortError(this.outerSignal));
        }
        return fetch(url, { ...init, signal: connection.signal });
    }

    /**
     * @returns {Promise<Response>} Response whose body reconnects on its own
     */
    async open() {
        let response;
        try {
            response = await this.connect(this.url, { ...this.init, headers: this.requestHeaders });
            this.hasResponse = true;
        } catch (error) {
            if (this.aborted) {
                this.finish();
                throw error;
            }
            // Nothing came back, but the server may well be working on it: a non-streaming reply
            // sends nothing until the whole answer is in. Ask for it rather than giving up.
            response = await this.resume(error);
        }
        return this.wrap(response);
    }

    /**
     * @param {{ status: number, statusText: string, headers: Headers, body: ReadableStream<Uint8Array>|null }} response First answer
     * @returns {Response}
     */
    wrap(response) {
        if (!response.body) {
            this.finish();
            return response instanceof Response ? response : new Response(null, { status: response.status, statusText: response.statusText });
        }

        let reader = response.body.getReader();
        const body = new ReadableStream({
            pull: async (controller) => {
                while (true) {
                    let result;
                    try {
                        result = await reader.read();
                    } catch (error) {
                        if (this.aborted) {
                            this.finish();
                            controller.error(error);
                            return;
                        }
                        let resumed;
                        try {
                            resumed = await this.resume(error);
                        } catch (resumeError) {
                            this.finish();
                            controller.error(resumeError);
                            return;
                        }
                        reader = resumed.body.getReader();
                        continue;
                    }
                    if (result.done) {
                        this.finish();
                        controller.close();
                        return;
                    }
                    this.received += result.value.byteLength;
                    this.lastByteAt = Date.now();
                    controller.enqueue(result.value);
                    return;
                }
            },
            cancel: (reason) => {
                this.finish();
                this.connection?.abort(reason);
            },
        });

        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: copyResponseHeaders(response.headers),
        });
    }

    /**
     * Reattaches from the last byte received.
     * @param {any} cause What broke the previous connection; rethrown if the server no longer has the reply
     * @returns {Promise<{ status: number, statusText: string, headers: Headers, body: ReadableStream<Uint8Array> }>}
     */
    async resume(cause) {
        for (let attempt = 0; attempt < MAX_RESUME_ATTEMPTS; attempt++) {
            const delay = RESUME_RETRY_DELAYS_MS[Math.min(attempt, RESUME_RETRY_DELAYS_MS.length - 1)];
            if (delay) {
                await sleep(delay, this.outerSignal);
            }
            if (this.aborted) {
                this.finish();
                throw abortError(this.outerSignal);
            }

            let response;
            try {
                response = await this.connect(RESUME_URL, {
                    method: 'POST',
                    headers: this.controlHeaders,
                    body: JSON.stringify({ id: this.id, offset: this.received }),
                    cache: 'no-store',
                });
            } catch (error) {
                if (this.aborted) {
                    this.finish();
                    throw abortError(this.outerSignal);
                }
                continue;
            }

            if (response.ok && response.body) {
                this.hasResponse = true;
                return {
                    status: Number(response.headers.get('X-Generation-Status')) || 200,
                    statusText: response.headers.get('X-Generation-Status-Text') ?? '',
                    headers: response.headers,
                    body: response.body,
                };
            }
            if (response.status >= 500) {
                continue;
            }
            // The reply is gone, or never arrived. Let the original failure surface.
            this.finish();
            throw cause;
        }

        // Neconyan: the server could not be reached for any attempt. Stop waiting and say why.
        this.connectionLost = true;
        this.finish();
        throw Object.assign(new Error('The connection to the server was lost before the reply finished.', { cause }), { code: GENERATION_CONNECTION_LOST });
    }

    /**
     * Stops the generation server-side and drops the connection.
     */
    cancel() {
        if (this.finished && !this.hasContext) {
            return;
        }
        this.finish();
        this.release();
        this.hasContext = false;
        this.connection?.abort(abortError(this.outerSignal));
        if (this.connectionLost) {
            // Neconyan: the resume loop already gave up, so this abort is the page's own clean-up after
            // saving what arrived. Cancelling would hide the server's copy from recovery for good.
            return;
        }
        fetch(CANCEL_URL, {
            method: 'POST',
            headers: this.controlHeaders,
            body: JSON.stringify({ id: this.id }),
            keepalive: true,
        }).catch(() => undefined);
    }

    release() {
        ownedReplies.delete(this.id);
        this.outerSignal?.removeEventListener('abort', this.handleAbort);
        notifyGenerationActivity();
    }

    finish() {
        if (this.finished) {
            return;
        }
        this.finished = true;
        activeRequests.delete(this.id);
        updateWatchdog();
        if (!this.hasContext) {
            this.release();
        }
        notifyGenerationActivity();
    }

    /**
     * Drops a connection that has gone quiet, so the reader falls into resume().
     * @param {number} [now] Current time
     */
    reconnectIfStale(now = Date.now()) {
        if (this.finished || this.aborted || now - this.lastByteAt < STALE_STREAM_MS) {
            return;
        }
        this.connection?.abort();
    }

    /**
     * Neconyan: asks the server whether a quiet connection has fallen behind and drops it if so, so
     * the reader falls into resume(). A provider that is still thinking is left alone.
     * @param {number} [now] Current time
     * @returns {Promise<void>}
     */
    async checkIfQuiet(now = Date.now()) {
        if (this.finished || this.aborted || this.checking || this.untracked
            || now - this.lastByteAt < QUIET_STREAM_MS || now < this.nextCheckAt) {
            return;
        }
        this.checking = true;
        this.nextCheckAt = now + QUIET_STREAM_MS;
        const connection = this.connection;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), STATUS_TIMEOUT_MS);
        let behind;
        try {
            const response = await fetch(STATUS_URL, {
                method: 'POST',
                headers: this.controlHeaders,
                body: JSON.stringify({ id: this.id }),
                cache: 'no-store',
                signal: timeout.signal,
            });
            if (response.status === 404) {
                this.untracked = true;
                return;
            }
            const status = response.ok ? await response.json() : null;
            behind = Boolean(status) && (Number(status.size) > this.received || (status.headersReady && !this.hasResponse) || status.done);
        } catch {
            // The server cannot be reached either: let resume() retry it.
            behind = true;
        } finally {
            clearTimeout(timer);
            this.checking = false;
        }
        if (behind && this.connection === connection && !this.finished) {
            connection?.abort();
        }
    }
}

/**
 * Reconnects every in-flight generation that has not received anything for a while.
 * @param {number} [now] Current time
 */
export function reconnectStaleGenerations(now = Date.now()) {
    for (const request of [...activeRequests.values()]) {
        request.reconnectIfStale(now);
    }
}

/**
 * Neconyan: checks every in-flight generation that has gone quiet while the page is visible. It runs
 * on a timer while anything is in flight, because a connection that dies without an error is
 * otherwise only noticed when the page becomes visible again.
 * @param {number} [now] Current time
 */
function checkQuietGenerations(now = Date.now()) {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
    }
    for (const request of [...activeRequests.values()]) {
        request.checkIfQuiet(now).catch(() => undefined);
    }
}

function updateWatchdog() {
    if (activeRequests.size > 0 && !watchdogTimer) {
        watchdogTimer = setInterval(() => checkQuietGenerations(), WATCHDOG_INTERVAL_MS);
        watchdogTimer.unref?.();
    } else if (activeRequests.size === 0 && watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
}

/**
 * @param {string} url Control endpoint
 * @param {Record<string, string>} headers Request headers (CSRF token); must not carry a generation id
 * @param {object} body JSON body
 * @returns {Promise<Response>}
 */
function postControl(url, headers, body) {
    return fetch(url, {
        method: 'POST',
        headers: { ...headersToObject(headers), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
    });
}

/**
 * Replies the server still holds for this profile that know which chat they belong to, minus the
 * ones this page is itself still reading.
 * @param {Record<string, string>} headers Request headers (CSRF token)
 * @returns {Promise<Array<{ id: string, status: 'running'|'finished'|'failed', attached: boolean, context: Record<string, any>, createdAt: number, finishedAt: number|null, size: number, statusCode: number|null, contentType: string|null }>>}
 */
export async function listRecoverableGenerations(headers) {
    const response = await postControl(LIST_URL, headers, {});
    if (response.status >= 500) {
        throw new Error(`Held reply lookup failed (${response.status})`);
    }
    if (!response.ok) {
        return [];
    }
    const data = await response.json();
    return (Array.isArray(data?.jobs) ? data.jobs : []).filter(job => !activeRequests.has(job.id) && !ownedReplies.has(job.id));
}

/**
 * Neconyan: whether the server holds more of this page's reply than the page received, or is still
 * writing it. A failed lookup counts as more, so the server copy is kept rather than lost.
 * @param {Record<string, any>|null} context The context passed to setGenerationContext
 * @param {Record<string, string>} headers Request headers (CSRF token)
 * @returns {Promise<boolean>}
 */
export async function heldReplyHasMore(context, headers) {
    const request = ownedReplies.get(context?.id);
    if (!request) {
        return false;
    }
    try {
        const response = await postControl(LIST_URL, headers, {});
        if (!response.ok) {
            return true;
        }
        const data = await response.json();
        const job = (Array.isArray(data?.jobs) ? data.jobs : []).find(entry => entry?.id === request.id);
        return Boolean(job) && (job.status === 'running' || Number(job.size) > request.received);
    } catch {
        return true;
    }
}

/**
 * The caller has finished processing this reply. A failed chat save leaves the server copy available.
 * @param {Record<string, any>|null} context The context passed to setGenerationContext
 */
export function releaseGenerationContext(context) {
    ownedReplies.get(context?.id)?.release();
}

/**
 * Drops a held reply the page no longer needs.
 * @param {string} id Generation id
 * @param {Record<string, string>} headers Request headers (CSRF token)
 * @returns {Promise<Response>}
 */
export function discardGeneration(id, headers) {
    return postControl(DISCARD_URL, headers, { id });
}

/**
 * Reads a held reply from its first byte, as a Response with the original status and content type.
 * The body follows the reply live if it is still being written.
 * @param {string} id Generation id
 * @param {Record<string, string>} headers Request headers (CSRF token)
 * @returns {Promise<Response>}
 */
export async function openHeldGeneration(id, headers) {
    const response = await postControl(RESUME_URL, headers, { id, offset: 0 });
    if (!response.ok) {
        throw new Error(`Held reply ${id} is gone (${response.status})`);
    }
    return new Response(response.body, {
        status: Number(response.headers.get('X-Generation-Status')) || 200,
        statusText: response.headers.get('X-Generation-Status-Text') ?? '',
        headers: copyResponseHeaders(response.headers),
    });
}

/**
 * fetch() for generation endpoints: the reply survives the connection dropping and the page being
 * frozen in the background. Abort the signal in `init` to cancel the generation for real.
 * @param {string} url Generation endpoint
 * @param {RequestInit} [init] Fetch options; `headers` must be a plain object or Headers instance
 * @returns {Promise<Response>}
 */
export function fetchResumable(url, init = {}) {
    return new ResumableRequest(url, init).open();
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            reconnectStaleGenerations();
        }
    });
    // The iPhone app freezes a hidden page within seconds; this keeps it writing replies instead.
    const nativeBackground = globalThis.webkit?.messageHandlers?.neconyanBackground;
    if (nativeBackground) {
        createReplyKeepAlive({
            subscribe: onGenerationActivity,
            notifyNative: busy => nativeBackground.postMessage({ busy }),
        });
    }
}

// Deliberately no beforeunload/pagehide cancel: a reply keeps running server-side when the page
// is reloaded, closed or killed, and recoverGenerations() in script.js applies it on the next
// visit to that chat. Stop button and explicit aborts still cancel through the request signal.
