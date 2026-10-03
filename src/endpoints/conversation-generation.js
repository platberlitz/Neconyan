/**
 * Conversation Mode REST API - Generation and Prompt Building
 *
 * Functions for building prompts, managing generation requests, and extracting responses.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { assembleGenerationStream, createGenerationStream } from '../generation/stream-result.js';
import sanitize from 'sanitize-filename';

import { parse as parseCharacterCard } from '../character-card-parser.js';
import { recoverFileWriteSync } from '../util.js';
import { handleChatCompletionsGenerate } from './backends/chat-completions.js';
import { handleTextCompletionsGenerate } from './backends/text-completions.js';
import {
    DEFAULT_SETTINGS,
    DEFAULT_CONVERSATION_REPLY_MAX_TOKENS,
    MIN_CONVERSATION_REPLY_MAX_TOKENS,
    MAX_CONVERSATION_REPLY_MAX_TOKENS,
} from '../../public/scripts/neconyan-conversation/constants.js';
import { composeConversationPromptMessages } from '../../public/scripts/neconyan-conversation/prompt-messages.js';
import { composeConversationSystemPrompt } from '../../public/scripts/neconyan-conversation/prompt-system.js';
import {
    normalizeChatroomPromptSettings,
    formatPromptText,
} from '../../public/scripts/neconyan-conversation/shared-helpers.js';
import { getObject, clamp, parsePositiveInt, isObject } from './conversation-utils.js';
import { convertImageUrlsToBase64 } from './conversation-utils.js';
import { getConversationThreadStore } from './conversation-threads.js';
import { getGroupConversationSettings } from './conversation-groups.js';

const GENERATION_BACKENDS = Object.freeze({
    CHAT: 'chat',
    TEXT: 'text',
});
const MAX_GROUP_PROMPT_PARTICIPANTS = 32;
const MAX_GROUP_PROMPT_PARTICIPANT_CHARS = 2048;
const GROUP_PARTICIPANT_READ_CONCURRENCY = 4;

/**
 * Normalize character data from card or override
 */
export function normalizeCharacterData(rawCharacter, avatar = '') {
    const raw = getObject(rawCharacter);
    const data = getObject(raw.data);
    const extensions = getObject(data.extensions || raw.extensions);
    const fallbackName = path.parse(String(avatar || '')).name || 'Character';
    return {
        name: data.name || raw.name || fallbackName,
        description: data.description || raw.description || '',
        personality: data.personality || raw.personality || '',
        scenario: data.scenario || raw.scenario || '',
        first_mes: data.first_mes || raw.first_mes || '',
        mes_example: data.mes_example || raw.mes_example || '',
        creator_notes: data.creator_notes || raw.creator_notes || raw.creatorcomment || '',
        system_prompt: data.system_prompt || raw.system_prompt || '',
        post_history_instructions: data.post_history_instructions || raw.post_history_instructions || '',
        character_version: data.character_version || raw.character_version || '',
        alternate_greetings: data.alternate_greetings || raw.alternate_greetings || [],
        extensions,
    };
}

/**
 * Parsed character cards, keyed by card path. A cached copy is used only while
 * the file on disk still has the same inode, size and modification time, so an
 * edited or replaced card is read again on its next use.
 * @type {Map<string, { ino: number, size: number, mtimeMs: number, bytes: number, data: object }>}
 */
const characterDataCache = new Map();
const CHARACTER_DATA_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let characterDataCacheBytes = 0;

function readCachedCharacterData(avatarPath) {
    const cached = characterDataCache.get(avatarPath);
    if (!cached) return null;
    let stat;
    try {
        stat = fs.statSync(avatarPath);
    } catch {
        characterDataCache.delete(avatarPath);
        characterDataCacheBytes -= cached.bytes;
        return null;
    }
    if (stat.ino !== cached.ino || stat.size !== cached.size || stat.mtimeMs !== cached.mtimeMs) {
        characterDataCache.delete(avatarPath);
        characterDataCacheBytes -= cached.bytes;
        return null;
    }
    // Refresh recency so a scan in progress does not evict cards it still needs.
    characterDataCache.delete(avatarPath);
    characterDataCache.set(avatarPath, cached);
    return cached.data;
}

function storeCachedCharacterData(avatarPath, data, bytes) {
    const previous = characterDataCache.get(avatarPath);
    if (previous) {
        characterDataCache.delete(avatarPath);
        characterDataCacheBytes -= previous.bytes;
    }
    let stat;
    try {
        stat = fs.statSync(avatarPath);
    } catch {
        return;
    }
    characterDataCache.set(avatarPath, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, bytes, data });
    characterDataCacheBytes += bytes;
    while (characterDataCacheBytes > CHARACTER_DATA_CACHE_MAX_BYTES && characterDataCache.size > 1) {
        const oldest = characterDataCache.keys().next().value;
        if (oldest === undefined) break;
        const evicted = characterDataCache.get(oldest);
        characterDataCache.delete(oldest);
        characterDataCacheBytes -= evicted?.bytes || 0;
    }
}

/**
 * Load character data from request body or disk
 */
export async function getCharacterData(request, avatar, { allowOverride = true, requireExisting = false } = {}) {
    if (allowOverride && isObject(request.body?.character)) {
        return normalizeCharacterData(request.body.character, avatar);
    }

    const missing = () => {
        if (requireExisting) throw Object.assign(new Error('A selected participant’s character card no longer exists.'), { status: 409 });
        return normalizeCharacterData({}, avatar);
    };

    try {
        const avatarFile = sanitize(path.basename(avatar));
        const avatarPath = path.join(request.user.directories.characters, avatarFile);
        if (path.extname(avatarFile).toLowerCase() !== '.png' || !fs.existsSync(avatarPath)) {
            return missing();
        }

        recoverFileWriteSync(avatarPath);
        const cached = readCachedCharacterData(avatarPath);
        if (cached) return normalizeCharacterData(cached, avatar);
        const cardText = await parseCharacterCard(avatarPath, 'png');
        const raw = JSON.parse(cardText);
        storeCachedCharacterData(avatarPath, raw, cardText.length);
        return normalizeCharacterData(raw, avatar);
    } catch (error) {
        if (error?.status) throw error;
        console.warn('Conversation REST API: failed to read character card', error);
        return missing();
    }
}

/**
 * Resolve every active group member to a prompt-safe display name.
 */
export async function getConversationGroupParticipantNames(request, group, { avatar = '', character = null } = {}) {
    if (!group || !Array.isArray(group.members)) {
        return [];
    }

    const disabledMembers = new Set((Array.isArray(group.disabled_members) ? group.disabled_members : [])
        .map(member => String(member).trim()));
    const seenMembers = new Set();
    const activeMembers = [];
    for (const rawMember of group.members) {
        const member = typeof rawMember === 'string' ? rawMember.trim() : '';
        if (!member || disabledMembers.has(member) || seenMembers.has(member)) {
            continue;
        }
        seenMembers.add(member);
        activeMembers.push(member);
    }
    const currentIndex = activeMembers.indexOf(avatar);
    if (currentIndex > 0) {
        activeMembers.unshift(activeMembers.splice(currentIndex, 1)[0]);
    }
    activeMembers.splice(MAX_GROUP_PROMPT_PARTICIPANTS);

    const names = new Array(activeMembers.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(GROUP_PARTICIPANT_READ_CONCURRENCY, activeMembers.length) }, async () => {
        while (nextIndex < activeMembers.length) {
            const index = nextIndex;
            nextIndex += 1;
            const member = activeMembers[index];
            const data = member === avatar && character
                ? character
                : await getCharacterData(request, member, { allowOverride: false });
            names[index] = formatPromptText(data?.name || path.parse(member).name, 80);
        }
    });
    await Promise.all(workers);

    const uniqueNames = [];
    const seenNames = new Set();
    let totalCharacters = 0;
    for (const name of names) {
        const key = String(name || '').toLowerCase();
        const nextLength = String(name || '').length + (uniqueNames.length ? 2 : 0);
        if (!key || seenNames.has(key) || totalCharacters + nextLength > MAX_GROUP_PROMPT_PARTICIPANT_CHARS) {
            continue;
        }
        seenNames.add(key);
        uniqueNames.push(name);
        totalCharacters += nextLength;
    }
    return uniqueNames;
}

/**
 * Build system time context string
 */
export function getConversationSystemTimeContext(now = new Date()) {
    const resolvedTimeZone = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch {
            return '';
        }
    })();
    const dateTimeLabel = (() => {
        try {
            return now.toLocaleString([], {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short',
            });
        } catch {
            return now.toString();
        }
    })();

    return [
        `Current system time context: ${dateTimeLabel}.`,
        resolvedTimeZone ? `Timezone: ${resolvedTimeZone}.` : '',
        'Use this as the current server/device time for day of week, time of day, dates, timezones, reminders, scheduling, and natural chat timing.',
    ].filter(Boolean).join(' ');
}

/**
 * Extract text from content (string or multimodal array)
 */
export function getContentText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return String(content || '');
    }

    return content
        .map(part => typeof part === 'string' ? part : part?.text || '')
        .filter(Boolean)
        .join('\n');
}

/**
 * Build conversation prompt messages (async for image conversion)
 */
export async function buildConversationPromptMessages(messages, directive, speakerName, {
    groupId = '',
    userName = 'User',
    signal,
    userDirectories,
} = {}) {
    return composeConversationPromptMessages(messages, directive, speakerName, {
        groupId, userName,
        convertImages: urls => convertImageUrlsToBase64(urls, 3, { signal, userDirectories }),
    });
}

/**
 * Build conversation system prompt
 */
export function buildConversationSystemPrompt({ settings, character, userName, groupId, branch, participantNames = [], context = {} }) {
    return composeConversationSystemPrompt({
        ...context, settings, character, userName, groupId,
        timeContext: context.timeContext ?? getConversationSystemTimeContext(),
        authorNote: settings.authors_note || character.creator_notes,
        memorySummary: branch?.memorySummary || '',
        participantContext: groupId && participantNames.length
            ? `Active group participants: ${participantNames.map(name => formatPromptText(name, 80)).filter(Boolean).join(', ')}.` : '',
    });
}

/**
 * Get default directive if not provided
 */
export function getDefaultDirective(body) {
    return String(body.directive || body.promptDirective || '[System directive: The user sent the latest DM(s). Reply directly to them in the Conversation Mode thread. Output only your message body, without a name prefix.]');
}

/**
 * Normalize conversation settings with defaults and clamping
 */
export function normalizeConversationSettings(settings = {}) {
    const normalized = { ...DEFAULT_SETTINGS, ...normalizeChatroomPromptSettings(getObject(settings)) };
    normalized.reply_max_tokens = clamp(
        parsePositiveInt(normalized.reply_max_tokens, DEFAULT_CONVERSATION_REPLY_MAX_TOKENS, MIN_CONVERSATION_REPLY_MAX_TOKENS),
        MIN_CONVERSATION_REPLY_MAX_TOKENS,
        MAX_CONVERSATION_REPLY_MAX_TOKENS,
    );
    if (normalized.reply_max_tokens === 1024) {
        normalized.reply_max_tokens = DEFAULT_CONVERSATION_REPLY_MAX_TOKENS;
    }
    normalized.selfie_command_enabled = Boolean(normalized.selfie_command_enabled);
    normalized.schedule_command_enabled = Boolean(normalized.schedule_command_enabled);
    normalized.grounded_dialogue_rules_enabled = Boolean(normalized.grounded_dialogue_rules_enabled);
    normalized.grounded_dialogue_rules = typeof normalized.grounded_dialogue_rules === 'string'
        ? normalized.grounded_dialogue_rules
        : DEFAULT_SETTINGS.grounded_dialogue_rules;
    return normalized;
}

/**
 * Get conversation settings with cascade: global -> group -> thread -> overrides
 */
export function getConversationSettings(request, store, avatar, groupId, overrides = {}, { personaId = '' } = {}) {
    const threadStore = getConversationThreadStore(store, avatar, groupId, { create: false, personaId });
    return normalizeConversationSettings({
        ...DEFAULT_SETTINGS,
        ...normalizeChatroomPromptSettings(getObject(store.settings)),
        ...(groupId ? { multi_char: true, auto_character_chat: true } : {}),
        ...getGroupConversationSettings(request, store, groupId, personaId, normalizeConversationSettings),
        ...normalizeChatroomPromptSettings(getObject(threadStore?.settings)),
        ...normalizeChatroomPromptSettings(getObject(overrides)),
    });
}

/**
 * Normalize generation backend type
 */
export function normalizeGenerationBackend(value) {
    const backend = String(value || '').toLowerCase().replace(/[_ ]/g, '-');
    if (['text', 'text-completion', 'text-completions'].includes(backend)) {
        return GENERATION_BACKENDS.TEXT;
    }
    return GENERATION_BACKENDS.CHAT;
}

/**
 * Get generation payload (deep clone to avoid mutation)
 */
export function getGenerationPayload(generation) {
    const source = getObject(generation?.payload || generation?.body || generation);
    // Deep clone to avoid mutating caller's data
    const payload = JSON.parse(JSON.stringify(source));
    delete payload.backend;
    delete payload.body;
    delete payload.payload;
    return payload;
}

/**
 * Build text prompt from system + messages (for text-completion backends)
 */
export function buildTextPrompt(systemPrompt, promptMessages) {
    const transcript = promptMessages
        .map(message => `${message.role.toUpperCase()}: ${getContentText(message.content)}`)
        .join('\n\n');
    return `${systemPrompt}\n\n${transcript}`.trim();
}

/**
 * Build generation request body
 */
export function buildGenerationRequestBody(generation, systemPrompt, promptMessages, responseLength) {
    const backend = normalizeGenerationBackend(generation?.backend || generation?.type);
    const payload = getGenerationPayload(generation);
    payload.stream = false;

    if (backend === GENERATION_BACKENDS.TEXT) {
        payload.prompt = buildTextPrompt(systemPrompt, promptMessages);
    } else {
        payload.messages = [
            { role: 'system', content: systemPrompt, identifier: 'conversation-system-prompt' },
            ...promptMessages,
        ];
    }

    if (payload.max_tokens === undefined && payload.max_completion_tokens === undefined) {
        payload.max_tokens = responseLength;
    }

    return { backend, payload };
}

/**
 * Create a capturing response mock for backend generation
 */
export function createCapturingResponse({ stream = false, onChunk } = {}) {
    let statusCode = 200;
    let payload;
    let headersSent = false;
    let writableEnded = false;
    const headers = {};
    const chunks = [];
    const events = new EventEmitter();
    let streamError = null;
    let streamBytes = 0;
    const decoder = stream ? new TextDecoder('utf-8', { fatal: true }) : null;
    const inertCaptureSocket = stream ? new EventEmitter() : undefined;

    return {
        get statusCode() {
            return statusCode;
        },
        set statusCode(value) {
            statusCode = value;
        },
        get body() {
            return payload;
        },
        get headers() {
            return headers;
        },
        get headersSent() {
            return headersSent;
        },
        get writableEnded() {
            return writableEnded;
        },
        get destroyed() {
            return writableEnded;
        },
        get streamError() {
            return streamError;
        },
        reportStreamError(error) {
            streamError = error;
        },
        get socket() {
            return stream ? inertCaptureSocket : undefined;
        },
        emit(event, ...args) {
            return events.emit(event, ...args);
        },
        on(event, listener) {
            events.on(event, listener);
            return this;
        },
        once(event, listener) {
            events.once(event, listener);
            return this;
        },
        off(event, listener) {
            events.off(event, listener);
            return this;
        },
        removeListener(event, listener) {
            events.removeListener(event, listener);
            return this;
        },
        status(code) {
            statusCode = code;
            return this;
        },
        setHeader(name, value) {
            headers[String(name).toLowerCase()] = value;
            return this;
        },
        getHeader(name) {
            return headers[String(name).toLowerCase()];
        },
        writeHead(code, nextHeaders = {}) {
            statusCode = code;
            Object.assign(headers, nextHeaders);
            headersSent = true;
            return this;
        },
        write(chunk) {
            if (writableEnded) return false;
            const bytes = stream ? (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))) : null;
            if (stream) streamBytes += bytes.length;
            if (stream && streamBytes > 2 * 1024 * 1024) {
                streamError = new Error('The generated stream exceeded the saved result limit.');
                events.emit('close');
                this.end();
                return false;
            }
            let next;
            try { next = stream ? decoder.decode(bytes, { stream: true }) : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''); } catch (error) {
                streamError = error;
                events.emit('close');
                this.end();
                return false;
            }
            try { onChunk?.(next); } catch (error) {
                streamError = error;
                events.emit('close');
                this.end();
                return false;
            }
            chunks.push(next);
            headersSent = true;
            return true;
        },
        send(data) {
            payload = data;
            headersSent = true;
            writableEnded = true;
            events.emit('finish');
            return this;
        },
        json(data) {
            return this.send(data);
        },
        sendStatus(code) {
            statusCode = code;
            payload = { error: true };
            headersSent = true;
            writableEnded = true;
            events.emit('finish');
            return this;
        },
        end(data = undefined) {
            if (data !== undefined) {
                if (stream) {
                    this.write(data);
                    if (writableEnded) return this;
                } else chunks.push(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
            }
            if (stream && !streamError) {
                try { chunks.push(decoder.decode()); } catch (error) { streamError = error; }
            }
            if (payload === undefined && chunks.length) {
                payload = chunks.join('');
            }
            headersSent = true;
            writableEnded = true;
            events.emit('finish');
            return this;
        },
    };
}

/**
 * Only client-error statuses are safe and useful to forward through this API.
 */
export function getSafeConversationGenerationStatus(status) {
    const parsed = Number(status);
    return Number.isInteger(parsed) && parsed >= 400 && parsed < 500 ? parsed : 502;
}

/** Keep provider failures useful when the job stores only the Error message. */
function generationFailureMessage(body, status) {
    const code = body?.error?.code ?? body?.status;
    if (code === 'ECONNRESET') {
        return 'The connection to your model provider closed before a complete reply was received.';
    }
    const message = [body?.error?.message, body?.error, body?.message, body?.response]
        .find(value => typeof value === 'string' && value.trim());
    return message ? message.trim().slice(0, 500) : `The model provider could not complete the reply (HTTP ${status}).`;
}

/**
 * Run backend generation with error handling
 */
export async function runBackendGeneration(request, backend, payload, { signal, fetch, anonymousCustom = false, boundProfile = false, onStream } = {}) {
    const handler = backend === GENERATION_BACKENDS.TEXT ? handleTextCompletionsGenerate : handleChatCompletionsGenerate;
    return runBackendRequest(request, handler, payload, { signal, fetch, anonymousCustom, boundProfile, onStream });
}

/** Invoke an existing provider handler with the same owner and cancellation policy. */
export async function runBackendRequest(request, handler, payload, { signal, fetch, anonymousCustom = false, boundProfile = false, onStream } = {}) {
    if (!Object.keys(payload).length) {
        const error = new Error('generation payload is required');
        error.status = 400;
        throw error;
    }

    if (signal?.aborted) {
        const error = new Error('client disconnected');
        error.status = 499;
        throw error;
    }

    const inertSocket = new EventEmitter();
    inertSocket.destroyed = false;
    const generationRequest = {
        user: request.user,
        headers: request.headers,
        app: request.app,
        query: request.query || {},
        fetch,
        anonymousCustom,
        boundProfile,
        resumableGeneration: request.resumableGeneration,
        generationSignal: signal,
        socket: request.socket || inertSocket,
        get: typeof request.get === 'function' ? request.get.bind(request) : undefined,
        on: typeof request.on === 'function' ? request.on.bind(request) : undefined,
        once: typeof request.once === 'function' ? request.once.bind(request) : undefined,
        off: typeof request.off === 'function' ? request.off.bind(request) : undefined,
        removeListener: typeof request.removeListener === 'function' ? request.removeListener.bind(request) : undefined,
        get aborted() {
            return Boolean(request.aborted || signal?.aborted);
        },
        get readableAborted() {
            return Boolean(request.readableAborted || signal?.aborted);
        },
        get destroyed() {
            return Boolean(request.destroyed || signal?.aborted);
        },
        get complete() {
            return request.complete;
        },
        body: payload,
    };
    const preview = payload.stream === true && onStream ? createGenerationStream(onStream) : null;
    const capture = createCapturingResponse({ stream: payload.stream === true, onChunk: preview ? chunk => preview.push(chunk) : undefined });
    const finished = payload.stream === true && new Promise(resolve => capture.once('finish', resolve));
    const abort = () => {
        capture.emit('close');
        if (!capture.writableEnded) capture.end();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        await handler(generationRequest, capture);
        if (finished) await finished;
    } finally {
        signal?.removeEventListener('abort', abort);
        if (!capture.writableEnded) capture.end();
    }

    if (signal?.aborted) {
        const error = new Error('client disconnected');
        error.status = 499;
        throw error;
    }

    const body = capture.body;
    if (capture.statusCode >= 400 || body?.error) {
        const reportedStatus = capture.statusCode >= 400 ? capture.statusCode : body?.status;
        const status = getSafeConversationGenerationStatus(reportedStatus);
        const error = new Error(generationFailureMessage(body, Number.isInteger(reportedStatus) ? reportedStatus : status));
        error.status = status;
        const upstreamStatus = Number(body?.provider_status ?? body?.status);
        error.providerStatus = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 ? upstreamStatus : Number(reportedStatus) || null;
        error.body = body;
        throw error;
    }

    if (capture.streamError) throw capture.streamError;
    return payload.stream === true && typeof body === 'string' ? assembleGenerationStream(body) : body;
}

/**
 * Extract generated text from various response formats
 */
export function extractGeneratedText(generationResponse) {
    if (typeof generationResponse === 'string') {
        return generationResponse;
    }

    const firstChoice = generationResponse?.choices?.[0];
    return String(
        firstChoice?.message?.content
        ?? firstChoice?.text
        ?? generationResponse?.content
        ?? generationResponse?.response
        ?? generationResponse?.text
        ?? '',
    );
}
