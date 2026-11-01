import express from 'express';
import fetch from 'node-fetch';
import { readSecret, SECRET_KEYS } from './secrets.js';
import { isProviderUrlValidationError, validateMiniMaxApiHost } from './provider-url-validation.js';
import { normalizeImageSource } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { MAX_AUDIO_BYTES } from '../jobs/audio-artifacts.js';
import { safeFetchFollowRedirects } from '../safe-http.js';

export const router = express.Router();

// Audio format MIME type mapping
const getAudioMimeType = (format) => {
    const mimeTypes = {
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'pcm': 'audio/pcm',
        'flac': 'audio/flac',
        'aac': 'audio/aac',
    };
    return mimeTypes[format] || 'audio/mpeg';
};

/**
 * Validates that a returned MiniMax audio download URL is a public HTTPS resource
 * without embedded credentials or private/loopback hostnames.
 * @param {unknown} rawUrl
 * @param {string} apiOrigin
 * @param {string[]} sensitiveValues
 * @returns {string}
 */
export function validateMiniMaxAudioOutputUrl(rawUrl, apiOrigin, sensitiveValues = []) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > 8192) {
        throw new Error('The returned MiniMax audio URL is missing or invalid.');
    }
    let parsed;
    try {
        parsed = new URL(rawUrl.trim(), apiOrigin);
    } catch {
        throw new Error('The returned MiniMax audio URL is invalid.');
    }
    if (
        parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || parsed.hash
        || sensitiveValues.some(secret => secret && parsed.href.includes(secret))
    ) {
        throw new Error('The returned MiniMax audio URL is invalid or contains credentials.');
    }
    if (
        parsed.origin !== apiOrigin
        && !normalizeImageSource(parsed.href, { allowHttp: false, allowRelative: false, blockPrivateHosts: true })
    ) {
        throw new Error('The returned MiniMax audio URL is not a public HTTPS resource.');
    }
    return parsed.href;
}

router.post('/generate-voice', async (request, response) => {
    try {
        const {
            text,
            voiceId,
            apiHost = 'https://api.minimax.io',
            model = 'speech-02-hd',
            speed = 1.0,
            volume = 1.0,
            pitch = 1.0,
            audioSampleRate = 32000,
            bitrate = 128000,
            format = 'mp3',
            language,
        } = request.body ?? {};

        const validatedApiOrigin = validateMiniMaxApiHost(apiHost);

        const apiKey = readSecret(request.user.directories, SECRET_KEYS.MINIMAX);
        const groupId = readSecret(request.user.directories, SECRET_KEYS.MINIMAX_GROUP_ID);

        // Validate required parameters
        if (!text || !voiceId || !apiKey || !groupId) {
            console.warn('MiniMax TTS: Missing required parameters');
            return response.status(400).json({ error: 'Some details are missing. Enter the text, voice, API key and group ID, then try again.' });
        }

        const requestBody = {
            model: model,
            text: text,
            stream: false,
            voice_setting: {
                voice_id: voiceId,
                speed: Number(speed),
                vol: Number(volume),
                pitch: Number(pitch),
            },
            audio_setting: {
                sample_rate: Number(audioSampleRate),
                bitrate: Number(bitrate),
                format: format,
                channel: 1,
            },
        };

        // Add language parameter if provided
        if (language) {
            requestBody.lang = language;
        }

        const apiUrl = `${validatedApiOrigin}/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;

        console.debug('MiniMax TTS Request:', {
            url: apiUrl,
            body: { ...requestBody, voice_setting: { ...requestBody.voice_setting, voice_id: '[REDACTED]' } },
        });

        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'MM-API-Source': 'SillyTavern-TTS',
            },
            body: JSON.stringify(requestBody),
        });

        if (!apiResponse.ok) {
            let errorMessage = `HTTP ${apiResponse.status}`;

            try {
                // Try to parse JSON error response
                /** @type {any} */
                const errorData = await apiResponse.json();
                console.error('MiniMax TTS API error (JSON):', errorData);

                // Check for MiniMax specific error format
                const baseResp = errorData?.base_resp;
                if (baseResp && baseResp.status_code !== 0) {
                    if (baseResp.status_code === 1004) {
                        errorMessage = 'Authentication failed - Please check your API key and API host';
                    } else {
                        errorMessage = `API Error: ${baseResp.status_msg}`;
                    }
                } else {
                    errorMessage = errorData.error?.message || errorData.message || errorData.detail || `HTTP ${apiResponse.status}`;
                }
            } catch (jsonError) {
                // If not JSON, try to read text
                try {
                    const errorText = await apiResponse.text();
                    console.error('MiniMax TTS API error (Text):', errorText);
                    if (errorText && errorText.length > 500) {
                        errorMessage = `HTTP ${apiResponse.status}: Response too large (${errorText.length} characters)`;
                    } else {
                        errorMessage = errorText || `HTTP ${apiResponse.status}`;
                    }
                } catch (textError) {
                    console.error('MiniMax TTS: Failed to read error response:', textError);
                    errorMessage = `HTTP ${apiResponse.status}: Unable to read error details`;
                }
            }

            console.error('MiniMax TTS API request failed:', errorMessage);
            return response.status(500).json({ error: errorMessage });
        }

        // Parse the response
        /** @type {any} */
        let responseData;
        try {
            responseData = await apiResponse.json();
            console.debug('MiniMax TTS Response received');
        } catch (jsonError) {
            console.error('MiniMax TTS: Failed to parse response as JSON:', jsonError);
            return response.status(500).json({ error: 'MiniMax sent back a reply that could not be read. Try again.' });
        }

        // Check for API error codes in response data
        const baseResp = responseData?.base_resp;
        if (baseResp && baseResp.status_code !== 0) {
            let errorMessage;
            if (baseResp.status_code === 1004) {
                errorMessage = 'Authentication failed - Please check your API key and API host';
            } else {
                errorMessage = `API Error: ${baseResp.status_msg}`;
            }
            console.error('MiniMax TTS API error:', baseResp);
            return response.status(500).json({ error: errorMessage });
        }

        // Process the audio data
        if (responseData.data && responseData.data.audio) {
            // Process hex-encoded audio data
            const hexAudio = responseData.data.audio;

            if (!hexAudio || typeof hexAudio !== 'string') {
                console.error('MiniMax TTS: Invalid audio data format');
                return response.status(500).json({ error: 'MiniMax sent audio that could not be read. Try again.' });
            }

            // Remove possible prefix and spaces
            const cleanHex = hexAudio.replace(/^0x/, '').replace(/\s/g, '');

            // Validate hex string format
            if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
                console.error('MiniMax TTS: Invalid hex string format');
                return response.status(500).json({ error: 'MiniMax sent audio that could not be read. Try again.' });
            }

            // Ensure hex string length is even
            const paddedHex = cleanHex.length % 2 === 0 ? cleanHex : '0' + cleanHex;

            try {
                // Convert hex string to byte array
                const hexMatches = paddedHex.match(/.{1,2}/g);
                if (!hexMatches) {
                    console.error('MiniMax TTS: Failed to parse hex string');
                    return response.status(500).json({ error: 'MiniMax sent audio that could not be read. Try again.' });
                }
                const audioBytes = new Uint8Array(hexMatches.map(byte => parseInt(byte, 16)));

                if (audioBytes.length === 0) {
                    console.error('MiniMax TTS: Audio conversion resulted in empty array');
                    return response.status(500).json({ error: 'The audio could not be converted. Try again.' });
                }

                console.debug(`MiniMax TTS: Converted ${paddedHex.length} hex characters to ${audioBytes.length} bytes`);

                // Set appropriate headers and send audio data
                const mimeType = getAudioMimeType(format);
                response.setHeader('Content-Type', mimeType);
                response.setHeader('Content-Length', audioBytes.length);

                return response.send(Buffer.from(audioBytes));
            } catch (conversionError) {
                console.error('MiniMax TTS: Audio conversion error:', conversionError);
                return response.status(500).json({ error: 'The audio could not be converted. Try again.' });
            }
        } else if (responseData.data && responseData.data.url) {
            // Handle URL-based audio response
            console.debug('MiniMax TTS: Received audio URL:', responseData.data.url);

            try {
                const safeAudioUrl = validateMiniMaxAudioOutputUrl(
                    responseData.data.url,
                    validatedApiOrigin,
                    [apiKey, groupId],
                );
                const audioResponse = await safeFetchFollowRedirects(safeAudioUrl, {
                    method: 'GET',
                    allowPrivate: false,
                    disallowIpLiterals: true,
                    standardPortsOnly: true,
                    maxRedirects: 0,
                    maxBytes: MAX_AUDIO_BYTES,
                    isAllowedHost: (_host, url) => url.protocol === 'https:',
                    lookupAddresses: request.lookupAddresses,
                    fetchImpl: request.fetch || fetch,
                });
                if (!audioResponse.ok) {
                    console.error('MiniMax TTS: Failed to fetch audio from URL:', audioResponse.status);
                    return response.status(500).json({ error: 'The audio could not be downloaded from MiniMax. Try again.' });
                }

                const contentType = String(audioResponse.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
                if (contentType && !['application/octet-stream', 'binary/octet-stream'].includes(contentType) && !/^audio\/[a-z0-9.+-]+$/.test(contentType)) {
                    audioResponse.body?.destroy?.();
                    console.error('MiniMax TTS: Audio URL returned non-audio content-type:', contentType);
                    return response.status(500).json({ error: 'The audio could not be downloaded from MiniMax. Try again.' });
                }

                const declaredLength = Number(audioResponse.headers?.get?.('content-length'));
                if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
                    audioResponse.body?.destroy?.();
                    return response.status(500).json({ error: 'The audio could not be downloaded from MiniMax. Try again.' });
                }

                const audioBuffer = await audioResponse.arrayBuffer();
                if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
                    return response.status(500).json({ error: 'The audio could not be downloaded from MiniMax. Try again.' });
                }
                const mimeType = getAudioMimeType(format);

                response.setHeader('Content-Type', mimeType);
                response.setHeader('Content-Length', audioBuffer.byteLength);

                return response.send(Buffer.from(audioBuffer));
            } catch (urlError) {
                console.error('MiniMax TTS: Error fetching audio from URL:', urlError);
                return response.status(500).json({ error: 'The audio could not be downloaded from MiniMax. Try again.' });
            }
        } else {
            // Handle error response
            const errorMessage = responseData.base_resp?.status_msg || responseData.error?.message || 'Unknown error';
            console.error('MiniMax TTS: No valid audio data in response:', responseData);
            return response.status(500).json({ error: `MiniMax returned an error: ${errorMessage}` });
        }
    } catch (error) {
        if (isProviderUrlValidationError(error)) {
            console.warn('MiniMax TTS: Invalid API host:', error.message);
            return response.status(400).json({ error: error.message });
        }
        console.error('MiniMax TTS generation failed:', error);
        return response.status(500).json({ error: 'Could not generate the speech. Try again in a moment.' });
    }
});
