import fetch from 'node-fetch';
import { Router } from 'express';

import { readSecret, SECRET_KEYS } from './secrets.js';
import { buildAzureSpeechUrl, isProviderUrlValidationError } from './provider-url-validation.js';

export const router = Router();

router.post('/list', async (req, res) => {
    try {
        const region = req.body?.region;

        if (!region) {
            console.warn('Azure TTS region not set');
            return res.sendStatus(400);
        }

        const url = buildAzureSpeechUrl(region, '/cognitiveservices/voices/list');

        const key = readSecret(req.user.directories, SECRET_KEYS.AZURE_TTS);

        if (!key) {
            console.warn('Azure TTS API Key not set');
            return res.sendStatus(403);
        }

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
            },
        });

        if (!response.ok) {
            console.warn('Azure Request failed', response.status, response.statusText);
            return res.sendStatus(500);
        }

        const voices = await response.json();
        return res.json(voices);
    } catch (error) {
        if (isProviderUrlValidationError(error)) {
            console.warn('Invalid Azure TTS region', error.message);
            return res.sendStatus(400);
        }
        console.error('Azure Request failed', error);
        return res.sendStatus(500);
    }
});

router.post('/generate', async (req, res) => {
    try {
        const { text, voice, region } = req.body ?? {};
        if (!text || !voice || !region) {
            console.warn('Missing required parameters');
            return res.sendStatus(400);
        }

        const url = buildAzureSpeechUrl(region, '/cognitiveservices/v1');

        const key = readSecret(req.user.directories, SECRET_KEYS.AZURE_TTS);

        if (!key) {
            console.warn('Azure TTS API Key not set');
            return res.sendStatus(403);
        }

        const lang = String(voice).split('-').slice(0, 2).join('-');
        const escapedText = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice xml:lang='${lang}' name='${voice}'>${escapedText}</voice></speak>`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
                'Content-Type': 'application/ssml+xml',
                'X-Microsoft-OutputFormat': 'webm-24khz-16bit-mono-opus',
            },
            body: ssml,
        });

        if (!response.ok) {
            console.warn('Azure Request failed', response.status, response.statusText);
            return res.sendStatus(500);
        }

        const audio = Buffer.from(await response.arrayBuffer());
        res.set('Content-Type', 'audio/ogg');
        return res.send(audio);
    } catch (error) {
        if (isProviderUrlValidationError(error)) {
            console.warn('Invalid Azure TTS region', error.message);
            return res.sendStatus(400);
        }
        console.error('Azure Request failed', error);
        return res.sendStatus(500);
    }
});
