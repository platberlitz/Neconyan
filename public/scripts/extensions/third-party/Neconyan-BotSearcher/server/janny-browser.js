/**
 * Small JanitorAI browser bridge, based on JAR's Playwright flow.
 *
 * Playwright is loaded only when the user asks to use this bridge. The browser
 * is headful and persistent so its cookies and Cloudflare clearance live in a
 * server-side profile; no cookie or bearer is returned to the client.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import nodeFetch from 'node-fetch';

import { detectImageType } from './imagetype.js';

const ORIGIN = 'https://janitorai.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_ENV = 'SBBS_JANNY_PROFILE_DIR';
const REQUEST_TIMEOUT_MS = 30000;
const CLOSE_TIMEOUT_MS = 5000;

let playwrightImport;

export class JannyBrowserError extends Error {
    constructor(code, status = 503, detail = undefined) {
        super(code);
        this.name = 'JannyBrowserError';
        this.code = code;
        this.status = status;
        // Server-log context only; never sent to the client.
        this.detail = detail;
    }
}

/** Accepts only the fixed public JannyAI/JanitorAI character URL forms. */
export function parseJannyUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 512) {
        return null;
    }
    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || !['jannyai.com', 'janitorai.com'].includes(url.hostname)
        || (url.port !== '' && url.port !== '443')
        || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
        return null;
    }
    const match = url.pathname.match(/^\/characters\/([0-9a-f-]{36})(?:_[A-Za-z0-9-]{1,160})?\/?$/i);
    if (!match || !UUID.test(match[1])) {
        return null;
    }
    return {
        id: match[1],
        url: `${ORIGIN}/characters/${match[1]}`,
    };
}

function profileDir() {
    const configured = typeof process.env[PROFILE_ENV] === 'string'
        ? process.env[PROFILE_ENV].trim()
        : '';
    // Keep browser cookies outside the release-owned public tree. Deployments
    // can still choose a dedicated location through SBBS_JANNY_PROFILE_DIR.
    const dataRoot = typeof globalThis.DATA_ROOT === 'string' && path.isAbsolute(globalThis.DATA_ROOT)
        ? globalThis.DATA_ROOT
        : path.join(process.cwd(), 'data');
    return path.resolve(configured || path.join(dataRoot, 'neconyan-janny-profile'));
}
async function importPlaywright() {
    if (!playwrightImport) {
        playwrightImport = import('playwright').catch(() => null);
    }
    return playwrightImport;
}

async function loadPlaywright() {
    const module = await importPlaywright();
    if (!module?.chromium) {
        throw new JannyBrowserError('janny_browser_unavailable', 503);
    }
    return module;
}

async function browserCapability() {
    const module = await importPlaywright();
    if (!module?.chromium) {
        return { available: false, reason: 'playwright-missing' };
    }
    try {
        const executablePath = module.chromium.executablePath?.();
        return typeof executablePath === 'string' && executablePath !== '' && fs.existsSync(executablePath)
            ? { available: true }
            : { available: false, reason: 'chromium-missing' };
    } catch {
        return { available: false, reason: 'chromium-missing' };
    }
}

async function openPersistentContext(directory) {
    const { chromium } = await loadPlaywright();
    try {
        return await chromium.launchPersistentContext(directory, {
            headless: false,
            viewport: null,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--window-position=80,60',
                '--window-size=1100,820',
            ],
        });
    } catch {
        throw new JannyBrowserError('janny_browser_unavailable', 503);
    }
}

async function pageFor(context) {
    const existing = context.pages().find((page) => page.url().includes('janitorai.com'));
    const page = existing ?? context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout?.(15000);
    return page;
}

async function withTimeout(promise, timeoutMs = REQUEST_TIMEOUT_MS) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new JannyBrowserError('janny_browser_request_failed', 502, `timed out after ${timeoutMs} ms`)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function inPageFetch(page, url, init = {}) {
    const pending = page.evaluate(async ({ target, request, timeoutMs }) => {
        function decode(raw) {
            try {
                return decodeURIComponent(raw);
            } catch {
                return raw;
            }
        }

        function tokenFrom(raw) {
            if (!raw) {
                return null;
            }
            let value = decode(raw);
            if (value.startsWith('base64-')) {
                value = value.slice(7);
            }
            if (value.startsWith('eyJ') && value.split('.').length === 3) {
                return value;
            }
            for (const candidate of [value, (() => {
                try {
                    return atob(value.replace(/-/g, '+').replace(/_/g, '/'));
                } catch {
                    return '';
                }
            })()]) {
                if (!candidate) {
                    continue;
                }
                const match = candidate.match(/"access_token":"(eyJ[^"]+)"/);
                if (match) {
                    return match[1];
                }
                try {
                    const parsed = JSON.parse(candidate);
                    const token = parsed?.access_token ?? parsed?.accessToken ?? parsed?.token
                        ?? parsed?.currentSession?.access_token;
                    if (typeof token === 'string' && token.startsWith('eyJ')) {
                        return token;
                    }
                } catch {
                    // Try the next storage value.
                }
            }
            return null;
        }

        let token = null;
        try {
            const parts = {};
            for (const cookie of (document.cookie || '').split('; ')) {
                const separator = cookie.indexOf('=');
                if (separator < 0) {
                    continue;
                }
                const match = cookie.slice(0, separator).match(/^(sb-.*-auth-token)(?:\.(\d+))?$/);
                if (match) {
                    const base = match[1];
                    const index = Number(match[2] ?? 0);
                    (parts[base] ||= {})[index] = cookie.slice(separator + 1);
                }
            }
            for (const base of Object.keys(parts)) {
                const joined = Object.keys(parts[base])
                    .map(Number)
                    .sort((left, right) => left - right)
                    .map((index) => parts[base][index])
                    .join('');
                token = tokenFrom(joined);
                if (token) {
                    break;
                }
            }
        } catch {
            // Local storage is the usual Supabase path.
        }
        if (!token) {
            try {
                for (let index = 0; index < localStorage.length; index += 1) {
                    token = tokenFrom(localStorage.getItem(localStorage.key(index)));
                    if (token) {
                        break;
                    }
                }
            } catch {
                // Let the request answer the actual authentication state.
            }
        }

        const headers = { accept: 'application/json, text/plain, */*', ...(request.headers || {}) };
        if (token) {
            headers.authorization = `Bearer ${token}`;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(target, {
                ...request,
                credentials: 'include',
                headers,
                signal: controller.signal,
            });
            return { status: response.status, body: await response.text() };
        } finally {
            clearTimeout(timer);
        }
    }, { target: url, request: init, timeoutMs: REQUEST_TIMEOUT_MS });
    try {
        // Also bound an unresponsive renderer, whose own abort timer cannot run.
        return await withTimeout(pending, REQUEST_TIMEOUT_MS + 1000);
    } catch (error) {
        if (error instanceof JannyBrowserError) {
            await withTimeout(page.close(), CLOSE_TIMEOUT_MS).catch(() => {});
        }
        throw new JannyBrowserError('janny_browser_request_failed', 502, error?.detail ?? error?.message);
    }
}

async function jsonFromPage(page, url, init = {}) {
    const result = await inPageFetch(page, url, init);
    if (result.status === 401 || result.status === 403) {
        throw new JannyBrowserError('janny_login_required', 401, `JanitorAI answered HTTP ${result.status}`);
    }
    if (result.status >= 400) {
        throw new JannyBrowserError('janny_card_unavailable', 502, `JanitorAI answered HTTP ${result.status}`);
    }
    try {
        return JSON.parse(result.body);
    } catch {
        throw new JannyBrowserError('janny_card_unavailable', 502, 'JanitorAI answer was not JSON');
    }
}

const AVATAR_HOST = 'ella.janitorai.com';
const AVATAR_FILE = /^[A-Za-z0-9_-]{1,120}\.(?:avif|gif|jfif|jpe?g|png|webp)$/;
const MAX_AVATAR_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_AVATAR_PNG_BYTES = 6 * 1024 * 1024;
// ponytail: fixed pixel ceiling keeps the PNG under the card cap; make it a
// setting if users ask for full-resolution portraits.
const MAX_AVATAR_PIXELS = 2_000_000;

/**
 * Picks the avatar URL to download, or null. Only the fixed JanitorAI image
 * host is ever returned, so metadata cannot point the browser at an internal
 * or attacker-chosen address.
 *
 * @param {object} meta character metadata from /hampter/characters/:id
 * @param {string | null} [renderedSrc] the avatar <img> the page rendered
 */
export function resolveAvatarUrl(meta, renderedSrc = null) {
    if (typeof renderedSrc === 'string') {
        try {
            const url = new URL(renderedSrc);
            if (url.protocol === 'https:' && url.hostname === AVATAR_HOST && url.port === ''
                && url.username === '' && url.password === ''
                && /^\/(?:bot-avatars|chats)\/[A-Za-z0-9_./-]{1,200}$/.test(url.pathname)) {
                url.hash = '';
                return url.href;
            }
        } catch {
            // Fall through to the metadata fields.
        }
    }
    for (const value of [meta?.avatar, meta?.profile_image]) {
        if (typeof value === 'string' && AVATAR_FILE.test(value)) {
            return `https://${AVATAR_HOST}/bot-avatars/${value}?width=1200`;
        }
    }
    return null;
}

async function renderedAvatarSrc(page) {
    return withTimeout(page.evaluate((host) => {
        const img = Array.from(document.querySelectorAll('img'))
            .find((candidate) => candidate.src.startsWith(`https://${host}/`)
                && (candidate.src.includes('/bot-avatars/') || candidate.src.includes('/chats/')));
        return img?.src ?? null;
    }, AVATAR_HOST)).catch(() => null);
}

/**
 * Downloads the avatar through the browser's session and re-encodes it as a
 * static PNG with Chromium's own decoders, so JPEG/WebP/AVIF/GIF sources all
 * become a picture the card can live inside. Returns null when anything about
 * the avatar is unusable; the caller then falls back to a JSON card.
 *
 * @returns {Promise<Buffer | null>}
 */
async function avatarPngFrom(page, url, fetchAvatar) {
    try {
        return await transcodeAvatar(page, url, fetchAvatar);
    } catch (error) {
        console.warn(`[BotSearcher] JanitorAI avatar skipped (${error?.message ?? error}); the card imports without its portrait`);
        return null;
    }
}

async function transcodeAvatar(page, url, fetchAvatar) {
    const controller = new AbortController();
    const context = page.context();
    const abort = () => controller.abort();
    context.on('close', abort);
    const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
    let source;
    try {
        const userAgent = await withTimeout(page.evaluate(() => navigator.userAgent));
        for (let hop = 0; hop <= 3; hop += 1) {
            url = resolveAvatarUrl(null, url);
            if (!url) {
                throw new Error('avatar redirect is not allowed');
            }
            const cookies = await withTimeout(context.cookies(url));
            let response;
            try {
                // Playwright buffers the whole response before returning it.
                // node-fetch enforces this cap while reading decoded chunks.
                response = await fetchAvatar(url, {
                    redirect: 'manual',
                    size: MAX_AVATAR_SOURCE_BYTES,
                    signal: controller.signal,
                    headers: {
                        'user-agent': userAgent,
                        cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
                    },
                });
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                    const location = response.headers.get('location');
                    if (!location || hop === 3) {
                        throw new Error('avatar redirect limit or missing destination');
                    }
                    url = new URL(location, url).href;
                    continue;
                }
                if (!response.ok) {
                    throw new Error(`avatar HTTP ${response.status}`);
                }
                if (Number(response.headers.get('content-length')) > MAX_AVATAR_SOURCE_BYTES) {
                    throw new Error('avatar exceeds the download size cap');
                }
                source = Buffer.from(await response.arrayBuffer());
                break;
            } finally {
                response?.body?.destroy();
            }
        }
    } finally {
        clearTimeout(timer);
        context.off('close', abort);
        controller.abort();
    }
    const type = detectImageType(source);
    if (source.length === 0 || source.length > MAX_AVATAR_SOURCE_BYTES || !type) {
        throw new Error(`unusable download: ${source.length} bytes, ${type ?? 'not a known image type'}`);
    }
    // The bytes cross into the page as base64 and become a Blob directly:
    // janitorai.com's Content-Security-Policy has no data: in connect-src, so
    // fetch('data:...') would be refused there.
    const encoded = await withTimeout(page.evaluate(async ({ base64, type, maxPixels, maxBytes }) => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        const bitmap = await createImageBitmap(new Blob([bytes], { type }));
        try {
            if (bitmap.width === 0 || bitmap.height === 0) {
                throw new Error('decoded picture is empty');
            }
            let scale = Math.min(1, Math.sqrt(maxPixels / (bitmap.width * bitmap.height)));
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
                if (png && png.size <= maxBytes) {
                    const reader = new FileReader();
                    return new Promise((resolve, reject) => {
                        reader.onloadend = () => resolve(String(reader.result).split(',')[1] ?? '');
                        reader.onerror = () => reject(new Error('could not read the PNG back'));
                        reader.readAsDataURL(png);
                    });
                }
                scale /= 2;
            }
            throw new Error('PNG stays over the size cap even at reduced scale');
        } finally {
            bitmap.close();
        }
    }, {
        base64: source.toString('base64'),
        type,
        maxPixels: MAX_AVATAR_PIXELS,
        maxBytes: MAX_AVATAR_PNG_BYTES,
    }));
    const png = Buffer.from(typeof encoded === 'string' ? encoded : '', 'base64');
    if (detectImageType(png) !== 'image/png') {
        throw new Error('browser returned something other than a PNG');
    }
    return png;
}

async function settingsRequest(page, url, init = {}) {
    const result = await inPageFetch(page, url, init);
    if (result.status === 401 || result.status === 403) {
        throw new JannyBrowserError('janny_login_required', 401);
    }
    if (result.status >= 400) {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
    if (result.body.trim() === '') {
        return null;
    }
    try {
        return JSON.parse(result.body);
    } catch {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
}

async function captureProfileId(page) {
    try {
        const profile = await jsonFromPage(page, `${ORIGIN}/hampter/profiles/mine`, { cache: 'no-store' });
        if (typeof profile?.id !== 'string' || profile.id.trim() === '') {
            throw new JannyBrowserError('janny_restore_failed', 502);
        }
        return profile.id;
    } catch {
        throw new JannyBrowserError('janny_restore_failed', 502);
    }
}

async function captureRequest(page, snapshot, url, init) {
    if (await captureProfileId(page) !== snapshot.profileId) {
        throw new JannyBrowserError('janny_restore_failed', 502);
    }
    return settingsRequest(page, url, init);
}

async function enterCaptureMode(page, recovery) {
    const url = `${ORIGIN}/hampter/api-settings`;
    const profileId = await captureProfileId(page);
    const before = await settingsRequest(page, url);
    // A visible login can change while settings are being read. Do not retain
    // another account's settings under the first account's identity.
    if (await captureProfileId(page) !== profileId) {
        throw new JannyBrowserError('janny_restore_failed', 502);
    }
    const settings = before?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || !Object.hasOwn(settings, 'selected_proxy_config_id')
        || (settings.selected_proxy_config_id !== null && !['string', 'number'].includes(typeof settings.selected_proxy_config_id))
        || (settings.source !== undefined && settings.source !== null && typeof settings.source !== 'string')
        || (settings.generation_settings !== undefined && settings.generation_settings !== null
            && (typeof settings.generation_settings !== 'object' || Array.isArray(settings.generation_settings)))) {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
    const original = { selected_proxy_config_id: settings.selected_proxy_config_id };
    for (const key of ['source', 'generation_settings']) {
        if (Object.hasOwn(settings, key)) {
            original[key] = settings[key];
        }
    }
    const preset = {
        api_key: `sk-${crypto.randomBytes(36).toString('base64url')}`,
        api_url: `http://127.0.0.1:${crypto.randomInt(8001, 65001)}/v1/chat/completions`,
        model: 'gpt-4o',
        name: crypto.randomBytes(9).toString('base64url'),
        prompt_id: null,
        client_id: crypto.randomUUID(),
    };
    // Keep the original settings before the first mutation, including when a
    // request succeeds remotely but its response is lost. Never write to disk.
    const snapshot = { original, profileId, clientId: preset.client_id, serverId: null, chatId: null };
    recovery.snapshot = snapshot;
    await captureRequest(page, snapshot, `${url}/proxy-configs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(preset),
    });
    const after = await settingsRequest(page, url);
    const created = (Array.isArray(after?.proxy_configs) ? after.proxy_configs : [])
        .find((candidate) => candidate?.client_id === preset.client_id);
    if (created?.id === undefined || created?.id === null) {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
    snapshot.serverId = String(created.id);
    await captureRequest(page, snapshot, url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selected_proxy_config_id: snapshot.serverId }),
    });
    // Older accounts may reject these fields. Do not change fields whose
    // original value the settings response did not supply.
    if (Object.hasOwn(original, 'source')) {
        await captureRequest(page, snapshot, url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: 'proxy' }),
        }).catch((error) => {
            if (error.code === 'janny_restore_failed') {
                throw error;
            }
        });
    }
    if (Object.hasOwn(original, 'generation_settings')) {
        await captureRequest(page, snapshot, url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                generation_settings: { ...(original.generation_settings ?? {}), context_length: 0 },
            }),
        }).catch((error) => {
            if (error.code === 'janny_restore_failed') {
                throw error;
            }
        });
    }
    return snapshot;
}

async function restoreCaptureMode(page, recovery) {
    const snapshot = recovery.snapshot;
    if (!snapshot) {
        return;
    }
    const url = `${ORIGIN}/hampter/api-settings`;
    try {
        await captureRequest(page, snapshot, url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(snapshot.original),
        });
        const restored = await settingsRequest(page, url);
        if (!restored?.settings || !Array.isArray(restored.proxy_configs)
            || Object.entries(snapshot.original).some(([key, value]) =>
                !Object.hasOwn(restored.settings, key) || !isDeepStrictEqual(restored.settings[key], value))) {
            throw new JannyBrowserError('janny_restore_failed', 502);
        }
        const preset = restored.proxy_configs.find((candidate) => candidate?.client_id === snapshot.clientId
            || (snapshot.serverId !== null && String(candidate?.id) === snapshot.serverId));
        if (preset) {
            if (preset.id === null || preset.id === undefined
                || String(restored.settings.selected_proxy_config_id) === String(preset.id)) {
                throw new JannyBrowserError('janny_restore_failed', 502);
            }
            await captureRequest(page, snapshot, `${url}/proxy-configs/${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
        }
        if (snapshot.chatId !== null) {
            await captureRequest(page, snapshot, `${ORIGIN}/hampter/chats/${encodeURIComponent(snapshot.chatId)}`, { method: 'DELETE' }).catch((error) => {
                // Chat removal remains best-effort, but never across accounts.
                if (error.code === 'janny_restore_failed') {
                    throw error;
                }
            });
            snapshot.chatId = null;
        }
        if (await captureProfileId(page) !== snapshot.profileId) {
            throw new JannyBrowserError('janny_restore_failed', 502);
        }
        recovery.snapshot = null;
    } catch {
        throw new JannyBrowserError('janny_restore_failed', 502);
    }
}

function characterOf(payload) {
    return payload?.character && typeof payload.character === 'object' ? payload.character : payload;
}

function text(value, max = 32768) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function greetingsOf(meta) {
    const values = [];
    const add = (value) => {
        const item = text(value).trim();
        if (item !== '' && !values.includes(item)) {
            values.push(item);
        }
    };
    if (Array.isArray(meta?.first_messages)) {
        meta.first_messages.forEach(add);
    }
    add(meta?.first_message);
    if (Array.isArray(meta?.alternate_greetings)) {
        meta.alternate_greetings.forEach(add);
    }
    return values;
}

function buildPublicCard(meta) {
    const greetings = greetingsOf(meta);
    const personality = text(meta?.personality).trim();
    const scenario = text(meta?.scenario).trim();
    if (!meta?.showdefinition || (personality === '' && scenario === '')) {
        throw new JannyBrowserError('janny_private_card_unsupported', 422);
    }

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: text(meta?.name, 200) || 'Unnamed',
            description: personality,
            personality: '',
            scenario,
            first_mes: greetings[0] ?? '',
            mes_example: text(meta?.example_dialogs),
            creator_notes: text(meta?.description),
            system_prompt: text(meta?.system_prompt),
            post_history_instructions: text(meta?.post_history_instructions),
            alternate_greetings: greetings.slice(1),
            tags: Array.isArray(meta?.custom_tags)
                ? meta.custom_tags.filter((tag) => typeof tag === 'string').slice(0, 32)
                : [],
            creator: text(meta?.creator_name ?? meta?.creator ?? meta?.user?.username, 200),
            character_version: '',
            extensions: {},
        },
    };
}

function systemContent(payload) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const message = messages.find((candidate) => candidate?.role === 'system') ?? messages[0];
    if (typeof message?.content === 'string') {
        return message.content;
    }
    if (Array.isArray(message?.content)) {
        return message.content
            .map((part) => typeof part === 'string' ? part : part?.text)
            .filter((part) => typeof part === 'string')
            .join('');
    }
    return '';
}

function cardTextFromCapture(payload) {
    const content = systemContent(payload);
    const pattern = /<([^<>\n]*?)Persona>([\s\S]*?)<\/[^<>\n]*?Persona>/gi;
    let match;
    while ((match = pattern.exec(content)) !== null) {
        if (/^user(?:\s*persona)?$/i.test(match[1].trim())) {
            continue;
        }
        return {
            name: match[1].replace(/['’]s\s*$/i, '').trim(),
            text: match[2].trim(),
        };
    }
    return null;
}

function taggedText(payload, tag) {
    const match = systemContent(payload).match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? match[1].trim() : '';
}

function assistantText(payload) {
    const message = (Array.isArray(payload?.messages) ? payload.messages : [])
        .find((candidate) => candidate?.role === 'assistant' && typeof candidate.content === 'string');
    return message?.content?.trim() ?? '';
}

export function buildPrivateCard(payload, meta) {
    const captured = cardTextFromCapture(payload);
    if (!captured?.text) {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }
    const greetings = greetingsOf(meta);
    const firstMessage = greetings[0] ?? assistantText(payload);
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: text(meta?.name, 200) || captured.name || 'Unnamed',
            description: captured.text,
            personality: '',
            scenario: text(meta?.scenario) || taggedText(payload, 'Scenario'),
            first_mes: firstMessage,
            mes_example: text(meta?.example_dialogs) || taggedText(payload, 'Example'),
            creator_notes: text(meta?.description),
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: greetings.slice(1),
            tags: Array.isArray(meta?.custom_tags)
                ? meta.custom_tags.filter((tag) => typeof tag === 'string').slice(0, 32)
                : [],
            creator: text(meta?.creator_name ?? meta?.creator ?? meta?.user?.username, 200),
            character_version: '',
            extensions: {},
        },
    };
}

async function capturedResponseBody(response) {
    try {
        return await response.json();
    } catch {
        const raw = await response.text().catch(() => '');
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) {
            return null;
        }
        try {
            return JSON.parse(raw.slice(start, end + 1));
        } catch {
            return null;
        }
    }
}

async function sendMessage(page, message) {
    const inputs = ['textarea[placeholder]', 'form textarea', 'textarea', 'div[contenteditable="true"]'];
    const deadline = Date.now() + 15000;
    let input = null;
    while (Date.now() < deadline && !input) {
        for (const selector of inputs) {
            const candidate = page.locator(selector).last();
            if (await candidate.count() > 0 && await candidate.isVisible().catch(() => false)) {
                input = candidate;
                break;
            }
        }
        if (!input) {
            await page.waitForTimeout(300);
        }
    }
    if (!input) {
        throw new JannyBrowserError('janny_private_capture_failed', 502);
    }

    await input.click();
    if (await input.getAttribute('contenteditable') === 'true') {
        await input.evaluate((element) => { element.textContent = ''; });
        await page.keyboard.insertText(message);
    } else {
        await input.fill(message);
    }

    const buttons = [
        'button[aria-label*="send" i]',
        'button[class*="sendButton" i]',
        'button[type="submit"]',
    ];
    for (const selector of buttons) {
        const button = page.locator(selector).last();
        if (await button.count() > 0 && await button.isVisible().catch(() => false)
            && await button.isEnabled().catch(() => false)) {
            await button.click();
            return;
        }
    }
    await input.press('Enter');
}

async function createChat(page, id, snapshot) {
    const data = await captureRequest(page, snapshot, `${ORIGIN}/hampter/chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ character_id: id }),
    });
    return data?.id === null || data?.id === undefined ? null : String(data.id);
}

/**
 * A creator who turns proxies off limits the card to JanitorAI's own models,
 * so the capture, which reads the prompt a proxy would receive, can never see
 * it. Refusing first leaves the account settings and chat list untouched.
 */
export function assertCardCapturable(meta) {
    if (meta?.allow_proxy === false) {
        throw new JannyBrowserError('janny_proxy_disabled', 422);
    }
}

async function capturePrivateCard(page, id, meta, recovery) {
    assertCardCapturable(meta);
    try {
        const snapshot = await enterCaptureMode(page, recovery);
        const chatId = await createChat(page, id, snapshot);
        snapshot.chatId = chatId;
        if (!chatId) {
            throw new JannyBrowserError('janny_private_capture_failed', 502);
        }
        await page.goto(`${ORIGIN}/chats/${encodeURIComponent(chatId)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        const [response] = await Promise.all([
            page.waitForResponse((response) => response.url().includes('/generateAlpha')
                && response.request().method() === 'POST', { timeout: 120000 }),
            sendMessage(page, '.'),
        ]);
        const payload = await withTimeout(capturedResponseBody(response));
        return buildPrivateCard(payload, meta);
    } catch (error) {
        if (error instanceof JannyBrowserError) {
            throw error;
        }
        throw new JannyBrowserError('janny_private_capture_failed', 502, error?.message);
    } finally {
        await restoreCaptureMode(page, recovery);
    }
}

/**
 * @param {{ profileDir?: string, launchContext?: typeof openPersistentContext, fetchAvatar?: typeof nodeFetch }} [options]
 */
export function createJannyBrowser({
    profileDir: configuredProfileDir,
    launchContext = openPersistentContext,
    fetchAvatar = nodeFetch,
} = {}) {
    const directory = path.resolve(configuredProfileDir || profileDir());
    let context = null;
    let starting = null;
    let closing = null;
    let stopped = false;
    const recovery = { snapshot: null };
    // ponytail: one persistent page is shared by the browser bridge; serialize
    // navigation and capture until a multi-page pool is actually needed.
    let operationTail = Promise.resolve();

    function exclusive(operation) {
        const run = operationTail.then(() => {
            if (stopped) {
                throw new JannyBrowserError('janny_browser_unavailable', 503);
            }
            return operation();
        });
        operationTail = run.catch(() => {});
        return run;
    }

    async function ensureContext() {
        if (stopped) {
            throw new JannyBrowserError('janny_browser_unavailable', 503);
        }
        if (context) {
            return context;
        }
        if (starting) {
            return starting;
        }
        starting = launchContext(directory)
            .then(async (opened) => {
                if (stopped) {
                    await withTimeout(opened.close(), CLOSE_TIMEOUT_MS).catch(() => {});
                    throw new JannyBrowserError('janny_browser_unavailable', 503);
                }
                context = opened;
                starting = null;
                opened.on?.('close', () => {
                    if (context === opened) {
                        context = null;
                    }
                });
                return opened;
            })
            .catch((error) => {
                starting = null;
                throw error;
            });
        return starting;
    }

    async function status() {
        const result = { ready: Boolean(context), loggedIn: false };
        if (context) {
            try {
                const page = await pageFor(context);
                if (new URL(page.url()).origin !== ORIGIN) {
                    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
                }
                const payload = await jsonFromPage(page, `${ORIGIN}/hampter/profiles/mine`);
                result.loggedIn = payload !== null;
                if (result.loggedIn) {
                    await restoreCaptureMode(page, recovery);
                }
            } catch (error) {
                if (!(error instanceof JannyBrowserError) || error.code !== 'janny_login_required') {
                    result.code = 'janny_browser_request_failed';
                }
            }
        }
        return {
            ...result,
            restorePending: recovery.snapshot !== null,
            ...(recovery.snapshot ? { code: 'janny_restore_failed' } : {}),
        };
    }

    return Object.freeze({
        async capability() {
            return browserCapability();
        },

        async status() {
            return exclusive(status);
        },

        async login() {
            return exclusive(async () => {
                const opened = await ensureContext();
                const page = await pageFor(opened);
                await page.goto(`${ORIGIN}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                return status();
            });
        },

        async logout() {
            return exclusive(async () => {
                const opened = await ensureContext();
                // Restore while credentials still exist. A failed restore must
                // not discard the only session that can retry it.
                if (recovery.snapshot) {
                    try {
                        const page = await pageFor(opened);
                        if (new URL(page.url()).origin !== ORIGIN) {
                            await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        }
                        await restoreCaptureMode(page, recovery);
                    } catch {
                        throw new JannyBrowserError('janny_restore_failed', 502);
                    }
                }
                try {
                    try {
                        await withTimeout((async () => {
                            await opened.setOffline(true);
                            await Promise.all(opened.pages().map((page) => page.goto('about:blank', { timeout: 15000 })));
                            // Include JanitorAI explicitly: a newly opened saved
                            // profile need not have visited the origin this run.
                            await opened.setStorageState({
                                cookies: [],
                                origins: [{ origin: ORIGIN, localStorage: [] }],
                            });
                        })());
                    } finally {
                        await withTimeout(opened.close(), CLOSE_TIMEOUT_MS);
                    }
                } catch {
                    throw new JannyBrowserError('janny_browser_request_failed', 502);
                }
                return { ready: false, loggedIn: false, restorePending: false };
            });
        },

        async fetchCard(rawUrl) {
            return exclusive(async () => {
                const parsed = parseJannyUrl(rawUrl);
                if (!parsed) {
                    throw new JannyBrowserError('bad_import_url', 400);
                }
                const opened = await ensureContext();
                const page = await pageFor(opened);
                await page.goto(parsed.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await restoreCaptureMode(page, recovery);
                const payload = await jsonFromPage(page, `${ORIGIN}/hampter/characters/${encodeURIComponent(parsed.id)}`);
                const meta = characterOf(payload);
                // The portrait is fetched first: the private capture below
                // navigates away from the character page.
                const avatarUrl = resolveAvatarUrl(meta, await renderedAvatarSrc(page));
                const avatarPng = avatarUrl ? await avatarPngFrom(page, avatarUrl, fetchAvatar) : null;
                return {
                    id: parsed.id,
                    card: meta?.showdefinition && (text(meta?.personality).trim() !== '' || text(meta?.scenario).trim() !== '')
                        ? buildPublicCard(meta)
                        : await capturePrivateCard(page, parsed.id, meta, recovery),
                    avatarPng,
                };
            });
        },

        async frontpage(section = 'popular', mode = 'all') {
            if (!['popular', 'trending24', 'trending', 'latest'].includes(section) || !['all', 'sfw'].includes(mode)) {
                throw new Error('Unsupported public JanitorAI filter.');
            }
            return exclusive(async () => {
                const page = await pageFor(await ensureContext());
                if (new URL(page.url()).origin !== ORIGIN) {
                    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
                }
                const query = new URLSearchParams({ page: '1', language: 'en', mode, count_mode: 'bounded', include_top_custom_tags: 'false' });
                query.set(section.startsWith('trending') ? 'special_mode' : 'sort', section);
                return jsonFromPage(page, `${ORIGIN}/hampter/characters?${query}`);
            });
        },

        async close() {
            if (!closing) {
                stopped = true;
                closing = (async () => {
                    // Allow capture cleanup briefly, then close out of queue so
                    // a stalled page cannot prevent server shutdown.
                    await withTimeout((async () => {
                        await operationTail;
                        if (context && recovery.snapshot) {
                            await restoreCaptureMode(await pageFor(context), recovery);
                        }
                    })(), CLOSE_TIMEOUT_MS).catch(() => {});
                    const opened = context;
                    context = null;
                    await withTimeout(opened?.close(), CLOSE_TIMEOUT_MS).catch(() => {});
                    if (recovery.snapshot) {
                        console.warn('[BotSearcher] JanitorAI settings were not restored (janny_restore_failed); check the settings in JanitorAI before another private import');
                    }
                })();
            }
            return closing;
        },
    });
}
