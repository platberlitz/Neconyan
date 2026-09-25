import { createHash } from 'node:crypto';

import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayHash } from '../roleplay-store.js';
import { getOpenAICompatibleApiUrl, isOpenAIChatCompletionsEndpoint,
    extractProviderImageSource } from '../../public/scripts/extensions/quick-image-gen/lib/provider-adapters.js';
import { looksLikeSsePayload, readSseDataStream } from '../../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';
import { assertSafeConfigurableEndpoint } from '../../public/scripts/extensions/quick-image-gen/lib/network-runtime.js';
import { MAX_IMAGE_BYTES, MAX_PROVIDER_RESPONSE_BYTES, normalizeImageSource,
    readResponseArrayBuffer, readResponseText } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { prepareQuickImageReference } from './quick-image-gen-reference.js';
import { imageReferenceBaseUrl, publishImageReferenceLink } from './image-reference-links.js';

const fail = (message, code = 'QIG_PROXY_ERROR') => Object.assign(new Error(message), { status: 409, code });
const imageInstruction = 'You are a visual image generation assistant. Use the user\'s text as the image instruction and any attached images as visual references. Return the generated image in the provider\'s supported image format.';
const oneOf = (value, options, fallback) => options.includes(value) ? value : fallback;
const hashText = value => createHash('sha256').update(value).digest('hex');

export function buildSavedProxyImageContext(snapshot) {
    const fields = snapshot?.macros?.character || {};
    const names = snapshot?.macros?.names || {};
    const card = snapshot?.macros?.extra?.character?.data ?? snapshot?.macros?.extra?.character ?? {};
    const text = [];
    if (names.char) text.push(`Character names: ${names.group || names.char}`);
    if (fields.description) text.push(`Character appearance/personality: ${fields.description.slice(0, 2200)}`);
    if (fields.scenario) text.push(`Scenario: ${fields.scenario.slice(0, 900)}`);
    if (Array.isArray(card.tags) && card.tags.length) text.push(`Character tags: ${card.tags.join(', ').slice(0, 600)}`);
    if (fields.persona) text.push(`User/persona description: ${fields.persona.slice(0, 700)}`);
    return text.join('\n');
}

function endpointMode(settings) {
    if (settings.proxyChatImageMode && !settings.proxyChatImageAllowImagesEndpoint) return 'chat_completions';
    const configured = oneOf(settings.proxyEndpointMode, ['auto', 'chat_completions', 'images_generations'], 'auto');
    return configured === 'auto'
        ? isOpenAIChatCompletionsEndpoint(settings.proxyUrl) ? 'chat_completions' : 'images_generations' : configured;
}

/** A proxy URL with a query token stays in memory; no full request URL is saved in an artifact. */
export function proxyImageEndpoint(settings) {
    const source = String(settings.proxyUrl || '').trim();
    if (!source) throw fail('The Quick Image Gen proxy URL is missing.', 'QIG_MISSING_URL');
    try {
        if (!/^https?:$/.test(new URL(source).protocol)) throw new Error('Invalid protocol');
    } catch { throw fail('The image proxy needs an explicit HTTP or HTTPS URL.', 'QIG_MISSING_URL'); }
    if (settings.proxyComfyMode) {
        const base = assertSafeConfigurableEndpoint(source, 'Image proxy URL').replace(/\/$/, '');
        const parsed = new URL(base);
        if (parsed.search || parsed.hash) throw fail('The configured Comfy proxy URL must not contain a query or fragment.');
        const workflow = String(settings.proxyComfyWorkflow || '').trim();
        if (workflow) {
            if (Buffer.byteLength(workflow) > 1024 * 1024) throw fail('The configured proxy workflow is too large.');
            try { JSON.parse(workflow); } catch { throw fail('The configured proxy workflow is not JSON.'); }
        }
        return { base, mode: 'comfy', workflow };
    }
    const mode = endpointMode(settings);
    const url = getOpenAICompatibleApiUrl(source, mode);
    if (!url) throw fail('The Quick Image Gen proxy URL is invalid.', 'QIG_MISSING_URL');
    assertSafeConfigurableEndpoint(url, 'Image proxy URL');
    const payloadMode = oneOf(settings.proxyPayloadMode, ['extended', 'openai_strict'], 'extended');
    const refMode = oneOf(settings.proxyRefImageMode, ['auto', 'url_only', 'inline_or_url'], 'auto');
    const sse = oneOf(settings.proxySse, ['auto', 'on', 'off'], 'auto');
    if (settings.proxyChatImageMode && settings.proxyChatImageIncludePersonality && typeof settings.__qigProxyContext !== 'string') {
        throw fail('Chat Image personality needs a saved character and persona context before provider dispatch.', 'QIG_CONTEXT_MISSING');
    }
    return { url, mode, payloadMode, refMode, sse: mode === 'images_generations'
        && (sse === 'on' || sse === 'auto' && payloadMode !== 'openai_strict') };
}

function proxyRefSources(settings) {
    if (!Array.isArray(settings.proxyRefImages ?? []) || !Array.isArray(settings.__qigProxyReferences ?? [])) {
        throw fail('The configured proxy references are invalid.', 'QIG_INVALID_REFERENCE');
    }
    const sources = [...(settings.proxyRefImages ?? []), ...(settings.__qigProxyReferences ?? [])];
    if (!Array.isArray(sources) || sources.length > 15
        || sources.some(value => typeof value !== 'string' || !value.trim()
            || Buffer.byteLength(value) > MAX_PROVIDER_RESPONSE_BYTES)) {
        throw fail('The configured proxy references are invalid or too large.', 'QIG_INVALID_REFERENCE');
    }
    return [...new Set(sources.map(value => value.trim()))];
}

export function assertProxyImageConfigured(settings, prompt, negative, seed) {
    const request = proxyImageEndpoint(settings);
    if (!Number.isSafeInteger(seed) || seed < 0) throw fail('The saved proxy image seed is invalid.');
    if (request.mode !== 'comfy') {
        const refs = proxyRefSources(settings);
        if (request.mode === 'images_generations' && request.payloadMode === 'openai_strict' && refs.length) {
            throw fail('OpenAI-strict proxy images do not accept reference images.', 'QIG_INVALID_REFERENCE');
        }
        if (request.refMode === 'url_only' && refs.some(value =>
            !normalizeImageSource(value, { allowHttp: false, allowRelative: false, blockPrivateHosts: true })?.startsWith('https://'))) {
            throw fail('URL-only proxy references must be public HTTPS images without credentials.', 'QIG_INVALID_REFERENCE');
        }
    }
    void prompt;
    void negative;
    return request;
}

function proxyLoras(value) {
    return String(value || '').split(',').map(item => {
        const trimmed = item.trim();
        const index = trimmed.lastIndexOf(':');
        const weight = index > 0 ? Number.parseFloat(trimmed.slice(index + 1)) : NaN;
        return { id: index > 0 && Number.isFinite(weight) ? trimmed.slice(0, index).trim() : trimmed,
            weight: Number.isFinite(weight) ? weight : 0.8 };
    }).filter(item => item.id);
}

function proxyBody(request, settings, prompt, negative, refs, seed) {
    const fallback = refs.length ? 'Create a new image that matches the provided reference image(s).' : 'Create a new image.';
    const text = String(prompt || '').trim() || fallback;
    const width = Number(settings.width) || 1024;
    const height = Number(settings.height) || 1024;
    let body;
    if (request.mode === 'chat_completions') {
        const content = [
            ...refs.map(url => ({ type: 'image_url', image_url: { url } })),
            { type: 'text', text: `${refs.length ? `Look at the reference image(s) provided. Match their style, composition, and visual characteristics. ${text}` : `Generate an image: ${text}`}${negative ? `\nAvoid: ${negative}` : ''}${settings.proxyExtraInstructions ? `\n${settings.proxyExtraInstructions}` : ''}` },
        ];
        const messages = [];
        if (settings.proxyChatImageMode) messages.push({ role: 'system',
            content: (String(settings.proxyChatImageSystemPrompt || imageInstruction).trim() || imageInstruction)
                + (settings.proxyChatImageIncludePersonality && settings.__qigProxyContext
                    ? `\n\nUse this chat personality context when it helps preserve identity, tone, outfit, and scene continuity:\n${settings.__qigProxyContext}` : '') });
        messages.push({ role: 'user', content });
        const rawMax = Number(settings.proxyChatImageMaxTokens);
        body = { model: settings.proxyModel, messages,
            max_tokens: settings.proxyChatImageMode ? Math.trunc(Number.isFinite(rawMax) && rawMax > 0
                ? Math.max(1, Math.min(65536, rawMax)) : 16384) : 4096 };
    } else {
        body = { model: settings.proxyModel,
            prompt: request.payloadMode === 'openai_strict'
                ? [text, negative ? `Avoid: ${negative}` : '', settings.proxyExtraInstructions || ''].filter(Boolean).join('\n')
                : [text, settings.proxyExtraInstructions || ''].filter(Boolean).join('\n'),
            n: 1, size: `${width}x${height}` };
    }
    if (request.payloadMode === 'extended') {
        Object.assign(body, { width, height, steps: settings.proxySteps ?? 25,
            cfg_scale: settings.proxyCfg ?? 6, sampler: settings.proxySampler || 'Euler a', seed,
            negative_prompt: negative, loras: proxyLoras(settings.proxyLoras), facefix: settings.proxyFacefix || undefined });
        if (request.mode === 'images_generations') Object.assign(body, { sse: request.sse,
            ...(refs.length ? { image_urls: refs, image: refs } : {}) });
        if (request.mode === 'chat_completions' && /gemini.*image|gemini.*preview/i.test(settings.proxyModel)) {
            body.response_modalities = ['TEXT', 'IMAGE'];
            body.generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
        }
    }
    return body;
}

function sourceFromString(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (/^(?:https?:\/\/|data:image\/)/i.test(text)) return text;
    const embedded = text.match(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/i)
        || text.match(/https?:\/\/[^\s<>"']+/i);
    if (embedded) return embedded[0].replace(/[)\],.;]+$/, '');
    return /^[A-Za-z0-9+/]{100,}={0,2}$/.test(text) ? `data:image/png;base64,${text}` : '';
}

function sourceFromJson(value) {
    return extractProviderImageSource(value) || sourceFromString(value?.choices?.[0]?.message?.content)
        || sourceFromString(value?.image);
}

async function proxyResponse(response, request, signal) {
    if (!response.ok) throw fail(`The proxy image request failed with HTTP ${response.status}.`);
    const mime = (response.headers.get('content-type') || '').toLowerCase().split(';', 1)[0];
    if (mime.startsWith('image/') || mime === 'application/octet-stream') {
        return Buffer.from(await readResponseArrayBuffer(response, MAX_IMAGE_BYTES));
    }
    if (request.mode === 'comfy') throw fail('The Comfy proxy returned no image.', 'QIG_BAD_IMAGE');
    const plain = mime === 'text/event-stream' ? null : await readResponseText(response, MAX_PROVIDER_RESPONSE_BYTES);
    if (mime === 'text/event-stream' || plain !== null && looksLikeSsePayload(plain)) {
        const stream = plain === null ? response : new Response(plain, { headers: { 'content-type': 'text/event-stream' } });
        let completed;
        try {
            completed = await readSseDataStream(stream, async (data, eventName) => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { /* A final event may be a bare image URL. */ }
                const status = String(parsed?.status || parsed?.type || parsed?.event || '').toLowerCase();
                const event = String(eventName || '').toLowerCase();
                const failed = /(?:^|[._-])(?:failed|error|expired|timeout|timed_out|canceled|cancelled)$/i;
                if (failed.test(status) || failed.test(event)) throw fail('The image proxy reported a failed generation.');
                const terminal = parsed?.done === true || /(?:^|[._-])(?:done|complete|completed|succeeded|success)$/i.test(status)
                    || /(?:^|[._-])(?:done|complete|completed|succeeded|success)$/i.test(event);
                const provisional = !terminal && /(?:^|[._-])(?:queued|pending|processing|running|preview|partial_image|progress)$/i.test(status || event);
                return { value: parsed ? sourceFromJson(parsed) : sourceFromString(data), provisional, terminal };
            }, { signal, maxBytes: MAX_PROVIDER_RESPONSE_BYTES });
        } catch (error) {
            if (signal?.aborted) throw error;
            throw fail('The proxy image stream did not return a final image.');
        }
        if (!completed.value) throw fail('The proxy image stream did not return a final image.', 'QIG_BAD_IMAGE');
        return completed.value;
    }
    if (plain !== null) {
        if (sourceFromString(plain)) return sourceFromString(plain);
        let parsed;
        try { parsed = JSON.parse(plain); } catch { throw fail('The proxy returned no image.', 'QIG_BAD_IMAGE'); }
        const result = sourceFromJson(parsed);
        if (!result) throw fail('The proxy returned no image.', 'QIG_BAD_IMAGE');
        return result;
    }
    let json;
    try { json = JSON.parse(await readResponseText(response, MAX_PROVIDER_RESPONSE_BYTES)); } catch {
        throw fail('The proxy returned invalid image data.', 'QIG_BAD_IMAGE');
    }
    const result = sourceFromJson(json);
    if (!result) throw fail('The proxy returned no image.', 'QIG_BAD_IMAGE');
    return result;
}

/** Only input hashes, never saved proxy keys or signed reference URLs, are persisted. */
export async function prepareProxyImageRequest(context, { effectId, settings, fingerprint, input, fetchImpl,
    withAccount, readSettingsLocked } = {}) {
    const request = assertProxyImageConfigured(settings, input.prompt, input.negative, input.proxySeed);
    const name = `input:quick-image:${effectId}:proxy`;
    const refs = request.mode === 'comfy' ? [] : proxyRefSources(settings);
    const referenceBase = refs.length && request.refMode === 'url_only' ? imageReferenceBaseUrl() : null;
    const sourceHash = roleplayHash({ fingerprint, effectId, prompt: input.prompt, negative: input.negative,
        seed: input.proxySeed, endpoint: hashText(settings.proxyUrl), refs: refs.map(hashText),
        ...(settings.__qigProxyContext !== undefined ? { context: hashText(settings.__qigProxyContext) } : {}) });
    const previous = withAccount(() => readArtifact(context.directories, context.job.id, name));
    if (previous !== undefined && (previous?.sourceHash !== sourceHash || previous.hash !== roleplayHash({
        sourceHash, bodyDigest: previous.bodyDigest, byteLength: previous.byteLength }))) {
        throw fail('The saved proxy request needs recovery.', 'QIG_RESULT_RECOVERY');
    }
    const bound = [];
    let bytes = 0;
    for (const [index, source] of refs.entries()) {
        const referenceName = `${name}:reference:${index}`;
        const reference = await prepareQuickImageReference(context, { name: referenceName,
            source, fingerprint, withAccount, readSettingsLocked, fetchImpl, maxBytes: MAX_IMAGE_BYTES - bytes });
        bytes += reference.bytes.length;
        if (bytes > MAX_IMAGE_BYTES) throw fail('The proxy reference images exceed their saved limit.', 'QIG_INVALID_REFERENCE');
        bound.push(referenceBase ? withAccount(lease => publishImageReferenceLink(lease, context, referenceName, referenceBase))
            : `data:${reference.format.mime};base64,${reference.bytes.toString('base64')}`);
    }
    const body = request.mode === 'comfy' ? request.workflow : JSON.stringify(proxyBody(request, settings,
        input.prompt, input.negative, bound, input.proxySeed));
    const byteLength = Buffer.byteLength(body);
    if (byteLength > MAX_PROVIDER_RESPONSE_BYTES) throw fail('The proxy request body is too large.', 'QIG_INVALID_REFERENCE');
    const data = { sourceHash, bodyDigest: hashText(body), byteLength };
    withAccount(() => {
        if (roleplayHash(readSettingsLocked()) !== fingerprint) throw fail('The saved image proxy settings changed.', 'QIG_SETTINGS_CHANGED');
        if (previous === undefined) writeArtifact(context.directories, context.job.id, name, { ...data, hash: roleplayHash(data) });
        else if (previous.bodyDigest !== data.bodyDigest || previous.byteLength !== data.byteLength) {
            throw fail('The saved image proxy request changed.', 'QIG_RESULT_RECOVERY');
        }
    });
    return { request, body };
}

/** Both Comfy proxy GET and POST generate an image; the caller marks uncertainty first. */
export async function generateProxyImage({ settings, input, prepared, fetchImpl, signal } = {}) {
    if (!prepared) throw fail('The proxy image request was not saved before dispatch.', 'QIG_INPUT_MISSING');
    const { request, body } = prepared;
    let url = request.mode === 'comfy' ? `${request.base}/prompt/${encodeURIComponent(input.prompt)}` : request.url;
    const init = { signal, redirect: 'error' };
    if (request.mode === 'comfy') {
        const params = new URLSearchParams();
        if (settings.proxyKey) params.set('token', settings.proxyKey);
        if (settings.proxyComfyNodeId) params.set('node_id', settings.proxyComfyNodeId);
        if (params.size) url += `?${params}`;
        if (request.workflow) Object.assign(init, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } else Object.assign(init, { method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(settings.proxyKey ? { Authorization: `Bearer ${settings.proxyKey}` } : {}) }, body });
    let response;
    try { response = await fetchImpl(url, init); } catch (error) {
        if (signal?.aborted) throw error;
        throw fail('The image proxy request did not return a result.');
    }
    return proxyResponse(response, request, signal);
}
