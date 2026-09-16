/**
 * Neconyan: generation requests that survive the connection dropping.
 *
 * The server keeps a copy of every tagged reply (src/resumable-generations.js). This wrapper tags
 * each generation request with an id and, when the connection dies or the page wakes up with a
 * stalled stream, reattaches from the last byte it received. The streaming code above it sees one
 * uninterrupted response. Aborting the request's signal cancels the generation for real.
 */

const GENERATION_ID_HEADER = 'X-Generation-Id';
const GENERATION_CONTEXT_HEADER = 'X-Generation-Context';
const RESUME_URL = '/api/resumable-generations/resume';
const CANCEL_URL = '/api/resumable-generations/cancel';
const LIST_URL = '/api/resumable-generations/list';
const DISCARD_URL = '/api/resumable-generations/discard';
const RESUME_RETRY_DELAYS_MS = Object.freeze([0, 1000, 2000, 5000]);
const MAX_RESUME_ATTEMPTS = 60;
/** A stream with no bytes for this long when the page becomes visible again gets reconnected. */
const STALE_STREAM_MS = 5000;
const SKIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

/** @type {Map<string, ResumableRequest>} */
const activeRequests = new Map();
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
            pendingContexts.delete(this.outerSignal);
            this.requestHeaders[GENERATION_CONTEXT_HEADER] = encodeContext(context);
        }
        this.received = 0;
        this.lastByteAt = Date.now();
        this.finished = false;
        /** @type {AbortController|null} */
        this.connection = null;
        this.handleAbort = () => this.cancel();
        this.outerSignal?.addEventListener('abort', this.handleAbort, { once: true });
        activeRequests.set(this.id, this);
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
                        this.discard();
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
            break;
        }

        // The reply is gone, or never arrived. Let the original failure surface.
        this.finish();
        throw cause;
    }

    /**
     * Stops the generation server-side and drops the connection.
     */
    cancel() {
        if (this.finished) {
            return;
        }
        this.finish();
        this.connection?.abort(abortError(this.outerSignal));
        fetch(CANCEL_URL, {
            method: 'POST',
            headers: this.controlHeaders,
            body: JSON.stringify({ id: this.id }),
            keepalive: true,
        }).catch(() => undefined);
    }

    /**
     * The page has the whole reply, so the server copy kept for recovery is no longer needed.
     */
    discard() {
        if (!this.hasContext) {
            return;
        }
        this.hasContext = false;
        discardGeneration(this.id, this.controlHeaders).catch(() => undefined);
    }

    finish() {
        if (this.finished) {
            return;
        }
        this.finished = true;
        activeRequests.delete(this.id);
        this.outerSignal?.removeEventListener('abort', this.handleAbort);
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
    if (!response.ok) {
        return [];
    }
    const data = await response.json();
    return (Array.isArray(data?.jobs) ? data.jobs : []).filter(job => !activeRequests.has(job.id));
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
}

// Deliberately no beforeunload/pagehide cancel: a reply keeps running server-side when the page
// is reloaded, closed or killed, and recoverGenerations() in script.js applies it on the next
// visit to that chat. Stop button and explicit aborts still cancel through the request signal.
