import { Buffer } from 'node:buffer';

import fetch from 'node-fetch';

/**
 * Provider TTS transports shared by the settings-facing routes and server-side
 * Conversation narration. Kept as a leaf module (only node-fetch) so job code
 * can reuse it without importing speech.js, which loads transformers.
 * Every transport returns { mimeType, base64 } and throws on failure.
 */

// Neconyan: keep OpenAI TTS proxy content types aligned with the requested audio format.
export const OPENAI_TTS_CONTENT_TYPES = {
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
};

export function getOpenAiTtsResponseFormat(value) {
    const responseFormat = String(value ?? 'wav').toLowerCase();
    return Object.hasOwn(OPENAI_TTS_CONTENT_TYPES, responseFormat) ? responseFormat : 'wav';
}

function audioMimeType(header, fallback) {
    const type = String(header || '').split(';')[0].trim().toLowerCase();
    if (!type || type === 'application/octet-stream') return fallback;
    if (/^audio\/[a-z0-9.+-]+$/.test(type)) return type;
    throw Object.assign(new Error(`Speech provider returned non-audio content: ${type}`), { providerStatus: 502 });
}

async function bufferAudio(result, fallbackContentType) {
    let mimeType;
    try {
        mimeType = audioMimeType(result.headers.get('content-type'), fallbackContentType);
    } catch (error) {
        result.body?.destroy?.();
        throw error;
    }
    const buffer = await result.arrayBuffer();
    return {
        mimeType,
        base64: Buffer.from(buffer).toString('base64'),
    };
}

async function providerError(label, result) {
    const body = await result.text();
    return Object.assign(new Error(`${label} failed with HTTP ${result.status}: ${body}`), {
        providerStatus: result.status,
        providerBody: body,
    });
}

export async function generateOpenAiSpeech({ key, text, voice, speed, model, responseFormat, instructions, signal } = {}, { fetchImpl = fetch } = {}) {
    if (!key) {
        throw Object.assign(new Error('No OpenAI key found'), { status: 400 });
    }

    const format = getOpenAiTtsResponseFormat(responseFormat);
    const requestBody = {
        input: text,
        response_format: format,
        voice: voice ?? 'alloy',
        speed: speed ?? 1,
        model: model ?? 'tts-1',
    };

    if (instructions) {
        requestBody.instructions = instructions;
    }

    const result = await fetchImpl('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(requestBody),
        signal,
    });

    if (!result.ok) {
        throw await providerError('OpenAI TTS request', result);
    }

    return bufferAudio(result, OPENAI_TTS_CONTENT_TYPES[format]);
}

export async function generateOpenAiCompatibleSpeech({ endpoint, key, text, voice, speed, model, responseFormat, signal } = {}, { fetchImpl = fetch } = {}) {
    if (!endpoint) {
        throw Object.assign(new Error('No OpenAI-compatible TTS provider endpoint provided'), { status: 400 });
    }

    const format = getOpenAiTtsResponseFormat(responseFormat);
    const result = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key ?? ''}`,
        },
        body: JSON.stringify({
            input: text ?? '',
            response_format: format,
            voice: voice ?? 'alloy',
            speed: speed ?? 1,
            model: model ?? 'tts-1',
        }),
        signal,
    });

    if (!result.ok) {
        throw await providerError('OpenAI-compatible TTS request', result);
    }

    return bufferAudio(result, OPENAI_TTS_CONTENT_TYPES[format]);
}

export const POLLINATIONS_AUDIO_MODELS_URL = 'https://gen.pollinations.ai/audio/models';

/**
 * Pollinations now files 'openai-audio' under its chat models and gives the bare
 * 'tts-1' alias to the paid ElevenLabs v3 voice, so the saved default resolves to
 * the free OpenAI speech model by its full name.
 * @param {string} [model] Saved Pollinations speech model
 * @returns {string} Model id sent to Pollinations
 */
export function pollinationsSpeechModel(model) {
    return !model || model === 'openai-audio' ? 'openai/tts-1' : model;
}

/**
 * @param {unknown} models Pollinations audio model list
 * @param {string} [model] Saved Pollinations speech model
 * @returns {string[] | null} Voices offered by that model, or null when it is not listed
 */
export function pollinationsModelVoices(models, model) {
    if (!Array.isArray(models)) {
        return null;
    }
    const id = pollinationsSpeechModel(model);
    const match = models.find(item => item?.name === id) ?? models.find(item => Array.isArray(item?.aliases) && item.aliases.includes(id));
    return Array.isArray(match?.voices) ? match.voices : null;
}

export async function generatePollinationsSpeech({ key, text, model, voice, signal } = {}, { fetchImpl = fetch } = {}) {
    if (!key) {
        throw Object.assign(new Error('No API key saved for Pollinations TTS'), { status: 400 });
    }

    // Neconyan divergence: Pollinations TTS must hit the provider's audio endpoint directly so Conversation narration receives literal speech output.
    const speechModel = pollinationsSpeechModel(model);
    const result = await fetchImpl('https://gen.pollinations.ai/v1/audio/speech', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: speechModel,
            input: text,
            voice: voice || 'alloy',
        }),
        signal,
    });

    if (!result.ok) {
        throw await providerError('Pollinations TTS request', result);
    }

    return bufferAudio(result, 'audio/mpeg');
}

export async function synthesizeElevenLabs({ apiKey, voiceId, request, signal } = {}, { fetchImpl = fetch } = {}) {
    if (!apiKey) {
        throw Object.assign(new Error('ElevenLabs API key not found'), { status: 400 });
    }

    if (!voiceId || !request) {
        throw Object.assign(new Error('ElevenLabs synthesis request missing voiceId or request body'), { status: 400 });
    }

    const result = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal,
    });

    if (!result.ok) {
        throw await providerError('ElevenLabs synthesis', result);
    }

    const audio = await bufferAudio(result, 'audio/mpeg');
    // ponytail: the original route always labelled ElevenLabs output audio/mpeg;
    // keep that contract even when the provider sends a generic content type.
    return { mimeType: 'audio/mpeg', base64: audio.base64 };
}

export async function listElevenLabsVoices({ apiKey, signal } = {}, { fetchImpl = fetch } = {}) {
    if (!apiKey) {
        throw Object.assign(new Error('ElevenLabs API key not found'), { status: 400 });
    }

    const result = await fetchImpl('https://api.elevenlabs.io/v1/voices', {
        headers: {
            'xi-api-key': apiKey,
        },
        signal,
    });

    if (!result.ok) {
        throw await providerError('ElevenLabs voices fetch', result);
    }

    return result.json();
}

export async function listElevenLabsHistory({ apiKey, signal } = {}, { fetchImpl = fetch } = {}) {
    if (!apiKey) throw Object.assign(new Error('ElevenLabs API key not found'), { status: 400 });
    const result = await fetchImpl('https://api.elevenlabs.io/v1/history', { headers: { 'xi-api-key': apiKey }, signal });
    if (!result.ok) throw await providerError('ElevenLabs history fetch', result);
    return result.json();
}

export async function fetchElevenLabsHistoryAudio({ apiKey, historyItemId, signal } = {}, { fetchImpl = fetch } = {}) {
    if (!apiKey || !historyItemId) throw Object.assign(new Error('ElevenLabs history audio request is incomplete'), { status: 400 });
    const result = await fetchImpl(`https://api.elevenlabs.io/v1/history/${encodeURIComponent(historyItemId)}/audio`, { headers: { 'xi-api-key': apiKey }, signal });
    if (!result.ok) throw await providerError('ElevenLabs history audio fetch', result);
    const audio = await bufferAudio(result, 'audio/mpeg');
    return { ...audio, mimeType: 'audio/mpeg' };
}
