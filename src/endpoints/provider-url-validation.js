const REGION_LABEL_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
const CHUTES_SUBDOMAIN_LABEL_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
const SAFE_PATH_SEGMENT_PATTERN = /^(?!\.{1,2}$)[a-zA-Z0-9._:@-]+$/;

/**
 * Canonical origins for fixed cloud text-completion providers (matching `public/scripts/text-preset-request.js`
 * and `public/scripts/textgen-settings.js`).
 */
export const CANONICAL_TEXTGEN_CLOUD_ORIGINS = Object.freeze({
    openrouter: new Set(['https://openrouter.ai']),
    togetherai: new Set(['https://api.together.xyz']),
    infermaticai: new Set(['https://api.totalgpt.ai']),
    dreamgen: new Set(['https://dreamgen.com']),
    featherless: new Set(['https://api.featherless.ai']),
    mancer: new Set(['https://neuro.mancer.tech']),
});

/**
 * Canonical origins for MiniMax TTS API (`public/scripts/extensions/tts/minimax.js` & `src/constants.js`).
 */
export const ALLOWED_MINIMAX_API_ORIGINS = new Set([
    'https://api.minimax.io',
    'https://api.minimaxi.chat',
    'https://api.minimax.chat',
    'https://api.minimaxi.com',
]);

/**
 * Canonical endpoint for Volcengine (Doubao) TTS (`public/scripts/extensions/tts/volcengine.js` & `src/generation/speech-config.js`).
 */
export const DEFAULT_VOLCENGINE_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const ALLOWED_VOLCENGINE_TTS_ORIGINS = new Set([
    'https://openspeech.bytedance.com',
]);

/**
 * Creates a client-input validation error that endpoints can map to HTTP 400.
 * @param {string} message Error message
 * @param {string} [code] Error code
 * @returns {Error & { status: number, statusCode: number, code: string }}
 */
export function createProviderUrlValidationError(message, code = 'PROVIDER_URL_INVALID') {
    const error = /** @type {Error & { status: number, statusCode: number, code: string }} */ (new Error(message));
    error.status = 400;
    error.statusCode = 400;
    error.code = code;
    return error;
}

/**
 * Checks whether an error was thrown by provider URL / hostname validation.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isProviderUrlValidationError(error) {
    return Boolean(
        error
        && typeof error === 'object'
        && (/** @type {any} */ (error).status === 400 || /** @type {any} */ (error).code === 'PROVIDER_URL_INVALID'),
    );
}

/**
 * Validates and normalizes an Azure Speech region label and returns the canonical origin.
 * @param {unknown} region
 * @returns {{ region: string, origin: string }}
 */
export function resolveAzureSpeechOrigin(region) {
    if (typeof region !== 'string') {
        throw createProviderUrlValidationError('Invalid Azure TTS region.');
    }
    const normalized = region.trim().toLowerCase();
    if (!REGION_LABEL_PATTERN.test(normalized)) {
        throw createProviderUrlValidationError('Invalid Azure TTS region.');
    }
    const expectedHostname = `${normalized}.tts.speech.microsoft.com`;
    const parsed = new URL(`https://${expectedHostname}`);
    if (parsed.protocol !== 'https:' || parsed.hostname !== expectedHostname || parsed.host !== expectedHostname || parsed.username || parsed.password || parsed.port) {
        throw createProviderUrlValidationError('Invalid Azure TTS region.');
    }
    return { region: normalized, origin: parsed.origin };
}

/**
 * Builds and validates an Azure TTS endpoint URL for a specific path.
 * @param {unknown} region
 * @param {string} pathname
 * @returns {string}
 */
export function buildAzureSpeechUrl(region, pathname) {
    const { origin } = resolveAzureSpeechOrigin(region);
    const url = new URL(pathname, origin);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) {
        throw createProviderUrlValidationError('Invalid Azure TTS URL.');
    }
    return url.toString();
}

/**
 * Validates and normalizes a Chutes subdomain DNS label.
 * @param {unknown} model
 * @param {string} [label]
 * @returns {string}
 */
export function validateChutesSubdomainLabel(model, label = 'Chutes model') {
    if (typeof model !== 'string') {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    const normalized = model.trim().toLowerCase();
    if (!CHUTES_SUBDOMAIN_LABEL_PATTERN.test(normalized)) {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    return normalized;
}

/**
 * Validates and normalizes a Chutes model DNS label and builds a Chutes subdomain URL for the given path.
 * @param {unknown} model
 * @param {string} pathname
 * @param {string} [label]
 * @returns {string}
 */
export function buildChutesModelSubdomainUrl(model, pathname, label = 'Chutes model') {
    const normalized = validateChutesSubdomainLabel(model, label);
    const expectedHostname = `${normalized}.chutes.ai`;
    const url = new URL(`https://${expectedHostname}${pathname}`);
    if (
        url.protocol !== 'https:'
        || url.hostname !== expectedHostname
        || url.host !== expectedHostname
        || url.username
        || url.password
        || url.port
        || url.pathname !== pathname
        || url.search
        || url.hash
    ) {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    return url.toString();
}

/**
 * Validates and normalizes a Chutes model DNS label and builds the transcription URL.
 * @param {unknown} model
 * @returns {string}
 */
export function buildChutesTranscribeUrl(model) {
    return buildChutesModelSubdomainUrl(model, '/transcribe', 'Chutes transcription model');
}

/**
 * Validates and normalizes a Chutes embedding model DNS label and builds the `/v1` base URL.
 * @param {unknown} model
 * @returns {string}
 */
export function buildChutesEmbeddingBaseUrl(model) {
    return buildChutesModelSubdomainUrl(model, '/v1', 'Chutes embedding model');
}

/**
 * Validates a Google Vertex AI region ('global' or a regional label like 'us-central1').
 * @param {unknown} region
 * @returns {string}
 */
export function validateVertexRegion(region) {
    if (region === undefined || region === null || region === '') {
        return 'us-central1';
    }
    if (typeof region !== 'string') {
        throw createProviderUrlValidationError('Invalid Vertex AI region.');
    }
    const normalized = region.trim().toLowerCase();
    if (!normalized) {
        return 'us-central1';
    }
    if (normalized !== 'global' && !REGION_LABEL_PATTERN.test(normalized)) {
        throw createProviderUrlValidationError('Invalid Vertex AI region.');
    }
    return normalized;
}

/**
 * Validates a single URL path segment (such as a project ID, model ID, or deployment name)
 * so it cannot traverse paths or alter the URL authority/query/fragment.
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function validateSafePathSegment(value, label = 'identifier') {
    if (typeof value !== 'string') {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 256 || !SAFE_PATH_SEGMENT_PATTERN.test(trimmed)) {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    return trimmed;
}

/**
 * Validates a Google/Vertex model identifier (which may be a bare model ID like 'gemini-2.5-flash'
 * or a publisher-prefixed ID like 'google/gemini-2.5-flash', never containing '..', '//', '?', '#', or authority characters).
 * @param {unknown} model
 * @returns {string}
 */
export function validateGoogleModelPath(model) {
    if (typeof model !== 'string') {
        throw createProviderUrlValidationError('Invalid Google model identifier.');
    }
    const trimmed = model.trim();
    if (!trimmed || trimmed.length > 256) {
        throw createProviderUrlValidationError('Invalid Google model identifier.');
    }
    const segments = trimmed.split('/');
    if (segments.length > 4 || segments.some(segment => !segment || !SAFE_PATH_SEGMENT_PATTERN.test(segment))) {
        throw createProviderUrlValidationError('Invalid Google model identifier.');
    }
    // Strip leading 'models/' if present so callers appending after '/models/' do not duplicate it,
    // or preserve exact segments if valid.
    return segments.join('/');
}

/**
 * Resolves the canonical Vertex AI base URL ('https://aiplatform.googleapis.com/v1' or 'https://<region>-aiplatform.googleapis.com/v1')
 * and verifies that the parsed URL authority matches the expected Google Cloud hostname.
 * @param {unknown} region
 * @param {{ includeVersion?: boolean }} [options]
 * @returns {{ region: string, origin: string, baseUrl: string }}
 */
export function resolveVertexAiBaseUrl(region, { includeVersion = true } = {}) {
    const normalizedRegion = validateVertexRegion(region);
    const expectedHostname = normalizedRegion === 'global'
        ? 'aiplatform.googleapis.com'
        : `${normalizedRegion}-aiplatform.googleapis.com`;
    const rawUrl = `https://${expectedHostname}${includeVersion ? '/v1' : ''}`;
    const parsed = new URL(rawUrl);
    if (
        parsed.protocol !== 'https:'
        || parsed.hostname !== expectedHostname
        || parsed.host !== expectedHostname
        || parsed.username
        || parsed.password
        || parsed.port
    ) {
        throw createProviderUrlValidationError('Invalid Vertex AI region.');
    }
    return {
        region: normalizedRegion,
        origin: parsed.origin,
        baseUrl: parsed.toString().replace(/\/$/, ''),
    };
}

/**
 * Validates an explicit HTTP(S) base URL (such as a reverse_proxy, custom_url, server_url, or azure_base_url)
 * and ensures that any derived endpoint URL preserves the exact same origin (scheme, hostname, port)
 * without embedded credentials or unexpected authority changes.
 * @param {unknown} baseUrlInput
 * @param {string} [label]
 * @returns {URL}
 */
export function parseHttpBaseUrl(baseUrlInput, label = 'endpoint URL') {
    if (typeof baseUrlInput !== 'string' || !baseUrlInput.trim()) {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    let parsed;
    try {
        parsed = new URL(baseUrlInput.trim());
    } catch {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    if (
        !['http:', 'https:'].includes(parsed.protocol)
        || !parsed.hostname
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash
    ) {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    return parsed;
}

/**
 * Asserts that a constructed target URL has the exact same origin as its intended base URL
 * and contains no embedded credentials or fragment.
 * @param {string | URL} targetUrl
 * @param {string | URL} expectedBaseUrl
 * @param {string} [label]
 * @returns {URL}
 */
export function assertSameOriginHttpUrl(targetUrl, expectedBaseUrl, label = 'endpoint URL') {
    const base = expectedBaseUrl instanceof URL ? expectedBaseUrl : parseHttpBaseUrl(String(expectedBaseUrl), label);
    let parsed;
    try {
        parsed = targetUrl instanceof URL ? new URL(targetUrl.toString()) : new URL(String(targetUrl));
    } catch {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    if (
        parsed.origin !== base.origin
        || parsed.protocol !== base.protocol
        || parsed.hostname !== base.hostname
        || parsed.port !== base.port
        || parsed.username
        || parsed.password
        || parsed.hash
    ) {
        throw createProviderUrlValidationError(`Invalid ${label}.`);
    }
    return parsed;
}

/**
 * Checks whether a candidate server URL matches the canonical origin for a fixed cloud text-completion provider.
 * Returns `true` for local/custom/self-hosted textgen types, and for `huggingface` when pointing at an HTTPS
 * HuggingFace endpoint (`*.huggingface.cloud` or `*.huggingface.co`).
 * @param {string} type Text-completion provider type (`TEXTGEN_TYPES`)
 * @param {unknown} serverUrl Candidate server URL
 * @returns {boolean}
 */
export function isAllowedTextGenSecretTarget(type, serverUrl) {
    if (!type || typeof type !== 'string') {
        return false;
    }
    const normalizedType = type.trim().toLowerCase();
    const canonicalOrigins = CANONICAL_TEXTGEN_CLOUD_ORIGINS[normalizedType];
    if (!canonicalOrigins && normalizedType !== 'huggingface') {
        // Local/custom/self-hosted textgen types (ooba, vllm, llamacpp, koboldcpp, tabby, aphrodite, ollama, generic)
        // intentionally send their own saved credential to the user-configured server URL.
        return true;
    }
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
        return false;
    }
    let parsed;
    try {
        parsed = parseHttpBaseUrl(serverUrl, `${normalizedType} server URL`);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:' || parsed.port) {
        return false;
    }
    if (canonicalOrigins) {
        return canonicalOrigins.has(parsed.origin);
    }
    // HuggingFace Inference Endpoints / API require HTTPS on huggingface.cloud or huggingface.co
    const host = parsed.hostname.toLowerCase();
    return (
        host === 'huggingface.co'
        || host.endsWith('.huggingface.co')
        || host.endsWith('.huggingface.cloud')
    );
}

/**
 * Validates a fixed cloud text-completion provider's `api_server` URL and throws a 400 validation error
 * if a fixed cloud `api_type` is pointed at an untrusted origin.
 * @param {unknown} type
 * @param {unknown} serverUrl
 * @returns {URL}
 */
export function validateTextGenServerUrl(type, serverUrl) {
    const parsed = parseHttpBaseUrl(serverUrl, 'Text Completion server URL');
    const normalizedType = typeof type === 'string' ? type.trim().toLowerCase() : '';
    if (
        (Object.hasOwn(CANONICAL_TEXTGEN_CLOUD_ORIGINS, normalizedType) || normalizedType === 'huggingface')
        && !isAllowedTextGenSecretTarget(normalizedType, parsed.toString())
    ) {
        throw createProviderUrlValidationError(`Invalid ${normalizedType} server URL.`);
    }
    return parsed;
}

/**
 * Validates a MiniMax TTS `apiHost` against the official MiniMax API origins.
 * @param {unknown} apiHost
 * @returns {string} Canonical origin without trailing slash
 */
export function validateMiniMaxApiHost(apiHost = 'https://api.minimax.io') {
    const parsed = parseHttpBaseUrl(apiHost, 'MiniMax API host');
    if (
        parsed.protocol !== 'https:'
        || parsed.port
        || (parsed.pathname && parsed.pathname !== '/')
        || !ALLOWED_MINIMAX_API_ORIGINS.has(parsed.origin)
    ) {
        throw createProviderUrlValidationError('Invalid MiniMax API host.');
    }
    return parsed.origin;
}

/**
 * Validates a Volcengine (Doubao) TTS `provider_endpoint` against the official Volcengine speech origin.
 * @param {unknown} endpointInput
 * @returns {string} Validated Volcengine TTS endpoint URL
 */
export function validateVolcengineTtsEndpoint(endpointInput = DEFAULT_VOLCENGINE_TTS_ENDPOINT) {
    const raw = (endpointInput === undefined || endpointInput === null || endpointInput === '')
        ? DEFAULT_VOLCENGINE_TTS_ENDPOINT
        : endpointInput;
    const parsed = parseHttpBaseUrl(raw, 'Volcengine TTS endpoint');
    if (
        parsed.protocol !== 'https:'
        || parsed.port
        || !ALLOWED_VOLCENGINE_TTS_ORIGINS.has(parsed.origin)
        || !parsed.pathname.startsWith('/api/')
    ) {
        throw createProviderUrlValidationError('Invalid Volcengine TTS endpoint.');
    }
    return parsed.toString();
}
