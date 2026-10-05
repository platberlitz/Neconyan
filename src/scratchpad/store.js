import path from 'node:path';
import crypto from 'node:crypto';

import { readAuthoringFileLocked, writeAuthoringFileLocked, deleteAuthoringFileLocked } from '../authoring-store.js';
import { roleplayAccountBase, roleplayAccountStamp, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';

export const SCRATCHPAD_SCHEMA = 1;
export const ASSISTANT_IDS = Object.freeze(['miso', 'taro', 'nori']);
export const ASSISTANT_GENDERS = Object.freeze(['male', 'female', 'neutral']);
export const SOURCE_KINDS = Object.freeze(['roleplay', 'conversation']);
export const MAX_SESSIONS = 40;
export const MAX_MESSAGES = 400;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_REASONING_BYTES = 64 * 1024;
export const MAX_NAME_LENGTH = 80;
export const MAX_PICKED = 400;
export const MAX_LORE_OVERRIDES = 1000;
export const MIN_MAX_TOKENS = 64;
export const MAX_MAX_TOKENS = 32000;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_DEPTH = 15;
export const MAX_DEPTH = 200;
const FILE_LIMIT = 16 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class ScratchpadError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const fail = (code, message, status = 400) => new ScratchpadError(code, message, status);

function now() {
    return new Date().toISOString();
}

export function newScratchpadId() {
    return crypto.randomUUID().replaceAll('-', '').slice(0, 24);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, max, { trim = false } = {}) {
    if (typeof value !== 'string') return '';
    const text = trim ? value.trim() : value;
    return text.length > max ? text.slice(0, max) : text;
}

function byteLength(value) {
    return Buffer.byteLength(String(value ?? ''), 'utf8');
}

export function requireId(value, label = 'item') {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw fail('SCRATCHPAD_ID_INVALID', `The ${label} id is invalid.`);
    return value;
}

/** The chat a Scratchpad belongs to. The key comes from the page; it is hashed before it reaches a path. */
export function normaliseSource(input) {
    if (!isPlainObject(input)) throw fail('SCRATCHPAD_SOURCE_INVALID', 'Open a chat before using Scratchpad.');
    const kind = SOURCE_KINDS.includes(input.kind) ? input.kind : null;
    const key = typeof input.key === 'string' ? input.key : '';
    if (!kind || !key || key.length > 1024) throw fail('SCRATCHPAD_SOURCE_INVALID', 'Open a chat before using Scratchpad.');
    return { kind, key, label: boundedString(input.label, 200, { trim: true }) };
}

export function normaliseAssistant(value) {
    return ASSISTANT_IDS.includes(value) ? value : 'miso';
}

export function normaliseGender(value) {
    return ASSISTANT_GENDERS.includes(value) ? value : 'neutral';
}

export function normaliseConnection(value) {
    if (isPlainObject(value) && value.kind === 'profile' && typeof value.profileId === 'string' && value.profileId && value.profileId.length <= 128) {
        return { kind: 'profile', profileId: value.profileId };
    }
    return { kind: 'current' };
}

export function normaliseMaxTokens(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return DEFAULT_MAX_TOKENS;
    return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, number));
}

export function defaultSettings() {
    return {
        depth: DEFAULT_DEPTH,
        picked: [],
        include: { card: true, persona: true, authorsNote: true, lore: true, hidden: false },
        loreOverrides: {},
        connection: { kind: 'current' },
        maxTokens: DEFAULT_MAX_TOKENS,
    };
}

export function normaliseSettings(input, previous = defaultSettings()) {
    const source = isPlainObject(input) ? input : {};
    const settings = structuredClone(previous);
    if (source.depth !== undefined) {
        const depth = Math.round(Number(source.depth));
        settings.depth = Number.isFinite(depth) ? Math.min(MAX_DEPTH, Math.max(0, depth)) : DEFAULT_DEPTH;
    }
    if (source.picked !== undefined) {
        settings.picked = Array.isArray(source.picked)
            ? [...new Set(source.picked.filter(item => typeof item === 'string' && item && item.length <= 128))].slice(0, MAX_PICKED)
            : [];
    }
    if (isPlainObject(source.include)) {
        for (const key of Object.keys(settings.include)) {
            if (typeof source.include[key] === 'boolean') settings.include[key] = source.include[key];
        }
    }
    if (source.loreOverrides !== undefined) {
        const overrides = {};
        if (isPlainObject(source.loreOverrides)) {
            for (const [key, value] of Object.entries(source.loreOverrides).slice(0, MAX_LORE_OVERRIDES)) {
                if (key.length <= 512 && (value === 'always' || value === 'never')) overrides[key] = value;
            }
        }
        settings.loreOverrides = overrides;
    }
    if (source.connection !== undefined) settings.connection = normaliseConnection(source.connection);
    if (source.maxTokens !== undefined) settings.maxTokens = normaliseMaxTokens(source.maxTokens);
    return settings;
}

function normaliseProposals(value) {
    const proposals = {};
    if (!isPlainObject(value)) return proposals;
    for (const [key, state] of Object.entries(value).slice(0, 64)) {
        if (/^\d{1,3}$/.test(key) && ['applied', 'rejected'].includes(state)) proposals[key] = state;
    }
    return proposals;
}

function normaliseMessage(input) {
    if (!isPlainObject(input)) return null;
    const role = input.role === 'assistant' ? 'assistant' : input.role === 'user' ? 'user' : null;
    if (!role) return null;
    const text = typeof input.text === 'string' ? input.text : '';
    if (byteLength(text) > MAX_MESSAGE_BYTES) return null;
    const message = {
        id: typeof input.id === 'string' && ID_PATTERN.test(input.id) ? input.id : newScratchpadId(),
        role,
        text,
        created: typeof input.created === 'string' ? input.created.slice(0, 40) : now(),
    };
    if (role === 'assistant') {
        message.state = ['pending', 'done', 'failed'].includes(input.state) ? input.state : 'done';
        if (typeof input.jobId === 'string' && input.jobId.length <= 128) message.jobId = input.jobId;
        if (typeof input.error === 'string' && input.error) message.error = input.error.slice(0, 1000);
        if (typeof input.reasoning === 'string' && input.reasoning && byteLength(input.reasoning) <= MAX_REASONING_BYTES) message.reasoning = input.reasoning;
        if (typeof input.assistant === 'string') message.assistant = normaliseAssistant(input.assistant);
        const proposals = normaliseProposals(input.proposals);
        if (Object.keys(proposals).length) message.proposals = proposals;
    }
    if (input.edited === true) message.edited = true;
    return message;
}

function normaliseSession(input) {
    if (!isPlainObject(input)) return null;
    const id = typeof input.id === 'string' && ID_PATTERN.test(input.id) ? input.id : newScratchpadId();
    const messages = Array.isArray(input.messages) ? input.messages.map(normaliseMessage).filter(Boolean).slice(-MAX_MESSAGES) : [];
    return {
        id,
        name: boundedString(input.name, MAX_NAME_LENGTH, { trim: true }) || 'Scratchpad',
        assistant: normaliseAssistant(input.assistant),
        gender: normaliseGender(input.gender),
        temporary: input.temporary === true,
        created: typeof input.created === 'string' ? input.created.slice(0, 40) : now(),
        updated: typeof input.updated === 'string' ? input.updated.slice(0, 40) : now(),
        settings: normaliseSettings(input.settings),
        messages,
    };
}

export function emptyBucket(source) {
    return { version: SCRATCHPAD_SCHEMA, source, activeSessionId: null, sessions: [] };
}

export function normaliseBucket(input, source) {
    if (!isPlainObject(input) || input.version !== SCRATCHPAD_SCHEMA) return emptyBucket(source);
    const sessions = Array.isArray(input.sessions) ? input.sessions.map(normaliseSession).filter(Boolean).slice(0, MAX_SESSIONS) : [];
    const activeSessionId = sessions.some(session => session.id === input.activeSessionId) ? input.activeSessionId : (sessions[0]?.id ?? null);
    return { version: SCRATCHPAD_SCHEMA, source: { ...source, label: source.label || input.source?.label || '' }, activeSessionId, sessions };
}

export function scratchpadFile(root, source) {
    const digest = crypto.createHash('sha256').update(`${source.kind}\n${source.key}`).digest('hex').slice(0, 40);
    return path.join(root, 'scratchpad', `${digest}.json`);
}

function rootOf(lease) {
    return roleplayLease(lease).scope.directories.root;
}

export function readBucketLocked(lease, source) {
    const file = readAuthoringFileLocked(lease, scratchpadFile(rootOf(lease), source), FILE_LIMIT);
    if (!file) return emptyBucket(source);
    let parsed;
    try {
        parsed = JSON.parse(file.bytes.toString('utf8'));
    } catch {
        throw fail('SCRATCHPAD_DAMAGED', 'This Scratchpad file could not be read.', 500);
    }
    if (parsed?.source?.kind !== source.kind || parsed?.source?.key !== source.key) {
        throw fail('SCRATCHPAD_DAMAGED', 'This Scratchpad file belongs to another chat.', 500);
    }
    return normaliseBucket(parsed, source);
}

export function writeBucketLocked(lease, bucket) {
    const filename = scratchpadFile(rootOf(lease), bucket.source);
    if (!bucket.sessions.length) {
        deleteAuthoringFileLocked(lease, filename);
        return;
    }
    writeAuthoringFileLocked(lease, filename, `${JSON.stringify(bucket, null, 2)}\n`, { limit: FILE_LIMIT });
}

export function scratchpadAccountBase(request) {
    const handle = request.user?.profile?.handle;
    const base = roleplayAccountBase(request.user?.directories);
    if (!base) throw fail('SCRATCHPAD_UNAVAILABLE', 'Scratchpad is not ready for this account yet.', 503);
    const accountChanged = () => fail('ACCOUNT_CHANGED', 'The signed-in account changed. Reload the page and try again.', 409);
    if (!handle || base.owner !== handle) throw accountChanged();
    const expected = request.get?.('X-Neconyan-Account');
    if (expected !== undefined && expected !== base.owner) throw accountChanged();
    return base;
}

export function withScratchpad(base, operation) {
    return withRoleplayAccount(base, roleplayAccountStamp(base), operation);
}

/** Read, change and save one chat's Scratchpad in a single account-locked step. */
export function mutateBucket(base, source, change) {
    return withScratchpad(base, lease => {
        const bucket = readBucketLocked(lease, source);
        const result = change(bucket, lease);
        writeBucketLocked(lease, bucket);
        return result === undefined ? bucket : result;
    });
}

export function findSession(bucket, sessionId) {
    const session = bucket.sessions.find(item => item.id === sessionId);
    if (!session) throw fail('SCRATCHPAD_SESSION_MISSING', 'This Scratchpad session no longer exists.', 404);
    return session;
}

export function findMessage(session, messageId) {
    const message = session.messages.find(item => item.id === messageId);
    if (!message) throw fail('SCRATCHPAD_MESSAGE_MISSING', 'This message no longer exists.', 404);
    return message;
}

function touch(session) {
    session.updated = now();
}

/** Temporary sessions last until another session is opened. */
function dropTemporary(bucket, keepId) {
    bucket.sessions = bucket.sessions.filter(session => !session.temporary || session.id === keepId
        || session.messages.some(message => message.state === 'pending'));
}

function nextName(bucket, assistant) {
    const label = assistant.charAt(0).toUpperCase() + assistant.slice(1);
    const used = new Set(bucket.sessions.map(session => session.name));
    for (let index = 1; index <= MAX_SESSIONS + 1; index++) {
        const name = index === 1 ? `${label}'s notes` : `${label}'s notes ${index}`;
        if (!used.has(name)) return name;
    }
    return `${label}'s notes`;
}

export function createSession(bucket, input = {}) {
    if (bucket.sessions.length >= MAX_SESSIONS) {
        throw fail('SCRATCHPAD_SESSION_LIMIT', `This chat already has ${MAX_SESSIONS} Scratchpad sessions. Delete one to start another.`, 409);
    }
    const assistant = normaliseAssistant(input.assistant);
    const previous = bucket.sessions.find(item => item.id === bucket.activeSessionId);
    const session = {
        id: newScratchpadId(),
        name: boundedString(input.name, MAX_NAME_LENGTH, { trim: true }) || nextName(bucket, assistant),
        assistant,
        gender: normaliseGender(input.gender),
        temporary: input.temporary === true,
        created: now(),
        updated: now(),
        settings: normaliseSettings(input.settings, previous ? { ...previous.settings, picked: [] } : defaultSettings()),
        messages: [],
    };
    if (Array.isArray(input.messages)) {
        session.messages = input.messages.map(item => normaliseMessage({ ...item, id: undefined, state: 'done', jobId: undefined }))
            .filter(Boolean).slice(-MAX_MESSAGES);
    }
    bucket.sessions.unshift(session);
    bucket.activeSessionId = session.id;
    dropTemporary(bucket, session.id);
    return session;
}

export function updateSession(bucket, sessionId, input = {}) {
    const session = findSession(bucket, sessionId);
    if (input.name !== undefined) {
        const name = boundedString(input.name, MAX_NAME_LENGTH, { trim: true });
        if (!name) throw fail('SCRATCHPAD_NAME_REQUIRED', 'Give the session a name.');
        session.name = name;
    }
    if (input.assistant !== undefined) session.assistant = normaliseAssistant(input.assistant);
    if (input.gender !== undefined) session.gender = normaliseGender(input.gender);
    if (typeof input.temporary === 'boolean') session.temporary = input.temporary;
    if (input.settings !== undefined) session.settings = normaliseSettings(input.settings, session.settings);
    touch(session);
    return session;
}

export function deleteSession(bucket, sessionId) {
    const session = findSession(bucket, sessionId);
    if (session.messages.some(message => message.state === 'pending')) {
        throw fail('SCRATCHPAD_REPLY_PENDING', 'Stop the reply in progress before deleting this session.', 409);
    }
    bucket.sessions = bucket.sessions.filter(item => item.id !== sessionId);
    if (bucket.activeSessionId === sessionId) bucket.activeSessionId = bucket.sessions[0]?.id ?? null;
}

export function activateSession(bucket, sessionId) {
    findSession(bucket, sessionId);
    bucket.activeSessionId = sessionId;
    dropTemporary(bucket, sessionId);
}

export function clearSession(bucket, sessionId) {
    const session = findSession(bucket, sessionId);
    if (session.messages.some(message => message.state === 'pending')) {
        throw fail('SCRATCHPAD_REPLY_PENDING', 'Stop the reply in progress before clearing this session.', 409);
    }
    session.messages = [];
    touch(session);
}

export function updateMessage(bucket, sessionId, messageId, text) {
    const session = findSession(bucket, sessionId);
    const message = findMessage(session, messageId);
    if (message.state === 'pending') throw fail('SCRATCHPAD_REPLY_PENDING', 'Wait for the reply to finish before editing it.', 409);
    if (typeof text !== 'string' || !text.trim()) throw fail('SCRATCHPAD_TEXT_REQUIRED', 'A message needs some text.');
    if (byteLength(text) > MAX_MESSAGE_BYTES) throw fail('SCRATCHPAD_TEXT_TOO_LARGE', 'That message is too long.', 413);
    message.text = text;
    message.edited = true;
    if (message.role === 'assistant') {
        message.state = 'done';
        delete message.error;
        delete message.proposals;
    }
    touch(session);
    return message;
}

export function deleteMessage(bucket, sessionId, messageId) {
    const session = findSession(bucket, sessionId);
    const message = findMessage(session, messageId);
    if (message.state === 'pending') throw fail('SCRATCHPAD_REPLY_PENDING', 'Stop the reply before deleting it.', 409);
    session.messages = session.messages.filter(item => item.id !== messageId);
    touch(session);
}

export function markProposal(bucket, sessionId, messageId, index, state) {
    const session = findSession(bucket, sessionId);
    const message = findMessage(session, messageId);
    const key = String(index);
    if (message.role !== 'assistant' || !/^\d{1,3}$/.test(key)) throw fail('SCRATCHPAD_PROPOSAL_INVALID', 'That change is not part of this reply.');
    if (!['applied', 'rejected', null].includes(state)) throw fail('SCRATCHPAD_PROPOSAL_INVALID', 'That change state is not valid.');
    message.proposals = { ...message.proposals };
    if (state === null) delete message.proposals[key];
    else message.proposals[key] = state;
    if (!Object.keys(message.proposals).length) delete message.proposals;
    touch(session);
    return message;
}

/** Fold the reply job's current state into a pending placeholder for display. Nothing is saved. */
export function projectPending(bucket, readJob) {
    for (const session of bucket.sessions) {
        for (const message of session.messages) {
            if (message.state !== 'pending') continue;
            const job = message.jobId ? readJob(message.jobId) : null;
            if (!job) {
                Object.assign(message, { state: 'failed', error: 'This reply stopped before it finished.' });
            } else if (job.state === 'completed') {
                Object.assign(message, { state: 'failed', error: 'This reply finished but could not be saved. Try again.' });
            } else if (['cancelled', 'failed', 'interrupted', 'conflict'].includes(job.state)) {
                Object.assign(message, { state: 'failed', error: job.state === 'cancelled' ? 'Stopped.' : (job.error?.message || 'This reply stopped before it finished.') });
            }
        }
    }
    return bucket;
}

export function publicBucket(bucket) {
    return {
        source: bucket.source,
        activeSessionId: bucket.activeSessionId,
        sessions: bucket.sessions,
        limits: { sessions: MAX_SESSIONS, messages: MAX_MESSAGES, messageBytes: MAX_MESSAGE_BYTES, maxTokens: MAX_MAX_TOKENS, depth: MAX_DEPTH },
    };
}

export const testExports = { normaliseBucket, normaliseMessage, normaliseSession, dropTemporary };
