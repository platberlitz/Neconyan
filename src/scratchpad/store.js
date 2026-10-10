import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { AUTHORING_FILE_LIMIT, readAuthoringFileLocked, writeAuthoringFileLocked, deleteAuthoringFileLocked } from '../authoring-store.js';
import { roleplayAccountBase, roleplayAccountStamp, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { MAX_GENERATION_TEXT_BYTES } from '../generation/stream-limits.js';

export const SCRATCHPAD_SCHEMA = 1;
export const ASSISTANT_IDS = Object.freeze(['miso', 'taro', 'nori']);
export const ASSISTANT_GENDERS = Object.freeze(['male', 'female', 'neutral']);
export const SOURCE_KINDS = Object.freeze(['roleplay', 'conversation', 'notebook']);
export const MAX_SESSIONS = 40;
export const MAX_MESSAGES = 400;
export const MAX_MESSAGE_BYTES = MAX_GENERATION_TEXT_BYTES;
export const MAX_REASONING_BYTES = MAX_GENERATION_TEXT_BYTES;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_NAME_LENGTH = 80;
export const MAX_PICKED = 400;
export const MAX_NOTE_REFERENCES = 12;
export const MAX_LORE_OVERRIDES = 1000;
export const MIN_MAX_TOKENS = 64;
export const MAX_MAX_TOKENS = 32000;
export const DEFAULT_MAX_TOKENS = 32000;
export const DEFAULT_DEPTH = 15;
export const MAX_DEPTH = 200;
export const DEFAULT_CLEANUP_KEEP = 10;
const FILE_LIMIT = AUTHORING_FILE_LIMIT;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IDENTITY_LIMIT = 4 * 1024 * 1024;
const STABLE_KEY_PATTERN = /^roleplay:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?::group:([^\0\r\n]{1,256}))?$/;
const STORAGE_SOURCE = Symbol('scratchpadStorageSource');

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
    const source = { kind, key, label: boundedString(input.label, 200, { trim: true }) };
    if (input.legacyKey !== undefined) {
        const identity = kind === 'roleplay' && STABLE_KEY_PATTERN.exec(key);
        const prefix = identity?.[2] ? `group:${identity[2]}:` : 'character:';
        if (!identity || typeof input.legacyKey !== 'string' || input.legacyKey.length > 1024
            || !input.legacyKey.startsWith(prefix) || input.legacyKey.length <= prefix.length) {
            throw fail('SCRATCHPAD_SOURCE_INVALID', 'This Scratchpad chat identity is invalid. Reload the chat.');
        }
        source.legacyKey = input.legacyKey;
    }
    return source;
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

export function assistantConnection(settings, assistant) {
    return normaliseConnection(settings.assistantConnections?.[normaliseAssistant(assistant)] ?? settings.connection);
}

export function sessionAssistants(session) {
    return session.settings.roundTable ? session.settings.participants : [session.assistant];
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
        notes: [],
        include: { card: true, persona: true, authorsNote: true, lore: true, hidden: false },
        loreOverrides: {},
        connection: { kind: 'current' },
        assistantConnections: {},
        assistantPrompts: {},
        roundTable: false,
        participants: [...ASSISTANT_IDS],
        maxTokens: DEFAULT_MAX_TOKENS,
        stream: true,
    };
}

export function normaliseSettings(input, previous = defaultSettings()) {
    const source = isPlainObject(input) ? input : {};
    const settings = structuredClone(previous);
    settings.notes ??= [];
    if (source.notes !== undefined) {
        if (!Array.isArray(source.notes) || source.notes.length > MAX_NOTE_REFERENCES) throw fail('SCRATCHPAD_NOTES_INVALID', `Choose up to ${MAX_NOTE_REFERENCES} notes or sections.`);
        const seen = new Set();
        settings.notes = source.notes.map(item => {
            if (!isPlainObject(item)) throw fail('SCRATCHPAD_NOTES_INVALID', 'Choose a saved note or section.');
            const ref = { notebookId: requireId(item.notebookId, 'notebook'), noteId: requireId(item.noteId, 'note') };
            if (item.grantId) ref.grantId = requireId(item.grantId, 'sharing grant');
            if (item.sectionId) {
                if (typeof item.sectionId !== 'string' || item.sectionId.length > 512) throw fail('SCRATCHPAD_NOTES_INVALID', 'That note section is invalid.');
                ref.sectionId = item.sectionId;
            }
            if (item.offset !== undefined) {
                if (!Number.isSafeInteger(item.offset) || item.offset < 0 || item.offset > 4 * 1024 * 1024) throw fail('SCRATCHPAD_NOTES_INVALID', 'That note page is invalid.');
                ref.offset = item.offset;
            }
            return ref;
        }).filter(ref => {
            const key = JSON.stringify(ref);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
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
    if (isPlainObject(source.assistantConnections)) {
        settings.assistantConnections ??= {};
        for (const assistant of ASSISTANT_IDS) {
            if (Object.hasOwn(source.assistantConnections, assistant)) {
                settings.assistantConnections[assistant] = normaliseConnection(source.assistantConnections[assistant]);
            }
        }
    }
    if (source.maxTokens !== undefined) settings.maxTokens = normaliseMaxTokens(source.maxTokens);
    if (typeof source.stream === 'boolean') settings.stream = source.stream;
    if (isPlainObject(source.assistantPrompts)) {
        settings.assistantPrompts ??= {};
        for (const assistant of ASSISTANT_IDS) {
            if (!Object.hasOwn(source.assistantPrompts, assistant)) continue;
            const text = source.assistantPrompts[assistant];
            if (text === null) delete settings.assistantPrompts[assistant];
            else if (typeof text !== 'string' || !text.trim() || byteLength(text) > 64000) {
                throw fail('SCRATCHPAD_PROMPT_INVALID', 'Write a prompt between 1 and 64000 bytes, or reset it to the default.');
            } else settings.assistantPrompts[assistant] = text;
        }
    }
    if (typeof source.roundTable === 'boolean') settings.roundTable = source.roundTable;
    if (source.participants !== undefined) {
        const participants = Array.isArray(source.participants) ? ASSISTANT_IDS.filter(id => source.participants.includes(id)) : [];
        if (!participants.length) throw fail('SCRATCHPAD_PARTICIPANTS_INVALID', 'Choose at least one assistant for the round table.');
        settings.participants = participants;
    }
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
        for (const field of ['token_count', 'reasoning_tokens']) {
            if (Number.isSafeInteger(input[field]) && input[field] >= 0) message[field] = input[field];
        }
        if (typeof input.assistant === 'string') message.assistant = normaliseAssistant(input.assistant);
        if (typeof input.gender === 'string') message.gender = normaliseGender(input.gender);
        const proposals = normaliseProposals(input.proposals);
        if (Object.keys(proposals).length) message.proposals = proposals;
        if (isPlainObject(input.notebookProposals)) {
            const refs = Object.fromEntries(Object.entries(input.notebookProposals).filter(([key, value]) => /^\d{1,3}$/.test(key)
                && isPlainObject(value) && /^p_[a-f0-9]{24}$/.test(value.id) && /^[a-f0-9]{64}$/.test(value.changeHash)).slice(0, 24));
            if (Object.keys(refs).length) message.notebookProposals = refs;
        }
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
        // Older sessions did not record whether the owner had chosen the name.
        automaticName: typeof input.automaticName === 'boolean' ? input.automaticName
            : /^(Miso|Taro|Nori)'s notes(?: [1-9]\d*)?$/.test(input.name),
        assistant: normaliseAssistant(input.assistant),
        gender: normaliseGender(input.gender),
        temporary: input.temporary === true,
        created: typeof input.created === 'string' ? input.created.slice(0, 40) : now(),
        updated: typeof input.updated === 'string' ? input.updated.slice(0, 40) : now(),
        settings: normaliseSettings(input.settings),
        messages,
    };
}

export function defaultCleanup() {
    return { enabled: false, keep: DEFAULT_CLEANUP_KEEP };
}

export function normaliseCleanup(input, previous = defaultCleanup()) {
    const source = isPlainObject(input) ? input : {};
    const cleanup = { ...previous };
    if (typeof source.enabled === 'boolean') cleanup.enabled = source.enabled;
    if (source.keep !== undefined) {
        const keep = Math.round(Number(source.keep));
        if (Number.isFinite(keep)) cleanup.keep = Math.min(MAX_SESSIONS, Math.max(1, keep));
    }
    return cleanup;
}

export function emptyBucket(source) {
    return { version: SCRATCHPAD_SCHEMA, source, activeSessionId: null, cleanup: defaultCleanup(), sessions: [] };
}

export function normaliseBucket(input, source) {
    if (!isPlainObject(input) || input.version !== SCRATCHPAD_SCHEMA) return emptyBucket(source);
    const sessions = Array.isArray(input.sessions) ? input.sessions.map(normaliseSession).filter(Boolean).slice(0, MAX_SESSIONS) : [];
    const activeSessionId = sessions.some(session => session.id === input.activeSessionId) ? input.activeSessionId : (sessions[0]?.id ?? null);
    return { version: SCRATCHPAD_SCHEMA, source: { ...source, label: source.label || input.source?.label || '' }, activeSessionId,
        cleanup: normaliseCleanup(input.cleanup), sessions };
}

/**
 * Sessions automatic cleanup may delete, least recently used first. The open
 * session, the most recently used one and any with a reply in progress stay.
 */
function cleanupCandidates(bucket) {
    const byUpdated = (a, b) => String(a.updated).localeCompare(String(b.updated));
    const newest = [...bucket.sessions].sort(byUpdated).at(-1)?.id;
    return bucket.sessions
        .filter(session => session.id !== bucket.activeSessionId && session.id !== newest
            && !session.messages.some(message => message.state === 'pending'))
        .sort(byUpdated);
}

function removeOldestSessions(bucket, count) {
    if (count <= 0) return 0;
    const doomed = new Set(cleanupCandidates(bucket).slice(0, count).map(session => session.id));
    bucket.sessions = bucket.sessions.filter(session => !doomed.has(session.id));
    return doomed.size;
}

/** With automatic cleanup on, keep only the newest sessions the owner asked for. */
export function applyCleanup(bucket) {
    if (!bucket.cleanup?.enabled) return 0;
    return removeOldestSessions(bucket, bucket.sessions.length - bucket.cleanup.keep);
}

export function updateCleanup(bucket, input) {
    bucket.cleanup = normaliseCleanup(input, bucket.cleanup ?? defaultCleanup());
    return bucket.cleanup;
}

export function scratchpadFile(root, source) {
    const digest = crypto.createHash('sha256').update(`${source.kind}\n${source.key}`).digest('hex').slice(0, 40);
    return path.join(root, 'scratchpad', `${digest}.json`);
}

function rootOf(lease) {
    return roleplayLease(lease).scope.directories.root;
}

function readStoredBucketLocked(lease, source) {
    const file = readAuthoringFileLocked(lease, scratchpadFile(rootOf(lease), source), FILE_LIMIT);
    if (!file) return null;
    let parsed;
    try {
        parsed = JSON.parse(file.bytes.toString('utf8'));
    } catch {
        throw fail('SCRATCHPAD_DAMAGED', 'This Scratchpad file could not be read.', 500);
    }
    if (parsed?.source?.kind !== source.kind || parsed?.source?.key !== source.key) {
        throw fail('SCRATCHPAD_DAMAGED', 'This Scratchpad file belongs to another chat.', 500);
    }
    return parsed;
}

function identityFile(lease) {
    return path.join(rootOf(lease), 'scratchpad', 'identities.json');
}

function readIdentitiesLocked(lease) {
    const file = readAuthoringFileLocked(lease, identityFile(lease), IDENTITY_LIMIT);
    if (!file) return { version: 1, entries: {} };
    try {
        const data = JSON.parse(file.bytes.toString('utf8'));
        if (data.version !== 1 || !isPlainObject(data.entries)) throw new Error('Invalid identity registry.');
        const claimed = new Set();
        for (const [key, source] of Object.entries(data.entries)) {
            if (source?.kind !== 'roleplay') throw new Error('Invalid storage source.');
            normaliseSource({ kind: 'roleplay', key, legacyKey: source.key });
            if (claimed.has(source.key)) throw new Error('Duplicate storage source.');
            claimed.add(source.key);
        }
        return data;
    } catch {
        throw fail('SCRATCHPAD_DAMAGED', 'Scratchpad\'s saved chat identities could not be read. The original files were kept.', 500);
    }
}

function writeIdentitiesLocked(lease, data) {
    writeAuthoringFileLocked(lease, identityFile(lease), `${JSON.stringify(data, null, 2)}\n`, { limit: IDENTITY_LIMIT });
}

function bindLegacyLocked(lease, identities, source, claimed) {
    if (identities.entries[source.key] || !source.legacyKey) return false;
    const root = rootOf(lease);
    // A canonical bucket always wins; never merge two existing sets of sessions.
    if (fs.existsSync(scratchpadFile(root, source)) || claimed.has(source.legacyKey)) return false;
    const legacy = { kind: 'roleplay', key: source.legacyKey };
    if (!fs.existsSync(scratchpadFile(root, legacy)) || !readStoredBucketLocked(lease, legacy)) return false;
    identities.entries[source.key] = legacy;
    claimed.add(legacy.key);
    return true;
}

function storageSourceLocked(lease, source) {
    if (source.kind !== 'roleplay' || !STABLE_KEY_PATTERN.test(source.key)) return source;
    const identities = readIdentitiesLocked(lease);
    const claimed = new Set(Object.values(identities.entries).map(item => item.key));
    if (bindLegacyLocked(lease, identities, source, claimed)) writeIdentitiesLocked(lease, identities);
    return identities.entries[source.key] ?? source;
}

/** Bind old buckets before publishing a chat move. No bucket files or running jobs are moved. */
export function bindRoleplayScratchpadsLocked(lease, steps) {
    const moves = steps.filter(step => step.kind === 'chat' && step.op === 'move');
    if (!moves.length || !fs.existsSync(path.join(rootOf(lease), 'scratchpad'))) return;
    const identities = readIdentitiesLocked(lease);
    const claimed = new Set(Object.values(identities.entries).map(item => item.key));
    let groupIds;
    let changed = false;
    for (const step of moves) {
        if (!step.locator.group) {
            changed = bindLegacyLocked(lease, identities, {
                kind: 'roleplay', key: `roleplay:${step.instanceId}`, legacyKey: `character:${step.locator.avatar}:${step.locator.chat}`,
            }, claimed) || changed;
            continue;
        }
        const directory = roleplayLease(lease).scope.directories.groups;
        groupIds ??= fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(entry => entry.name.slice(0, -5))
            .filter(id => id && id.length <= 256 && !/[\0\r\n]/.test(id));
        for (const groupId of groupIds) {
            changed = bindLegacyLocked(lease, identities, {
                kind: 'roleplay', key: `roleplay:${step.instanceId}:group:${groupId}`, legacyKey: `group:${groupId}:${step.locator.chat}`,
            }, claimed) || changed;
        }
    }
    if (changed) writeIdentitiesLocked(lease, identities);
}

export function readBucketLocked(lease, source) {
    const storage = storageSourceLocked(lease, source);
    const parsed = readStoredBucketLocked(lease, storage);
    const bucket = parsed ? normaliseBucket(parsed, source) : emptyBucket(source);
    Object.defineProperty(bucket, STORAGE_SOURCE, { value: storage });
    return bucket;
}

export function writeBucketLocked(lease, bucket) {
    const storage = bucket[STORAGE_SOURCE] ?? storageSourceLocked(lease, bucket.source);
    const filename = scratchpadFile(rootOf(lease), storage);
    applyCleanup(bucket);
    const cleanup = bucket.cleanup ?? defaultCleanup();
    if (!bucket.sessions.length && !cleanup.enabled && cleanup.keep === DEFAULT_CLEANUP_KEEP) {
        deleteAuthoringFileLocked(lease, filename);
        return;
    }
    const serialise = () => `${JSON.stringify({ ...bucket, source: { kind: storage.kind, key: storage.key, label: bucket.source.label || '' } }, null, 2)}\n`;
    let text = serialise();
    // A full file loses its oldest sessions first when automatic cleanup is on.
    while (cleanup.enabled && Buffer.byteLength(text) > FILE_LIMIT && removeOldestSessions(bucket, 1)) text = serialise();
    try {
        writeAuthoringFileLocked(lease, filename, text, { limit: FILE_LIMIT });
    } catch (error) {
        if (error?.code !== 'AUTHORING_FILE_TOO_LARGE') throw error;
        throw fail('SCRATCHPAD_STORAGE_FULL', cleanup.enabled
            ? 'Scratchpad is full for this chat. Delete long replies from the open session, then try again.'
            : 'Scratchpad is full for this chat. Delete old sessions or long replies, or turn on automatic cleanup in Sessions, then try again.', 413);
    }
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

function nextName(bucket, assistant, excludeId) {
    const label = assistant.charAt(0).toUpperCase() + assistant.slice(1);
    const used = new Set(bucket.sessions.filter(session => session.id !== excludeId).map(session => session.name));
    for (let index = 1; index <= MAX_SESSIONS + 1; index++) {
        const name = index === 1 ? `${label}'s notes` : `${label}'s notes ${index}`;
        if (!used.has(name)) return name;
    }
    return `${label}'s notes`;
}

export function createSession(bucket, input = {}) {
    if (bucket.cleanup?.enabled) removeOldestSessions(bucket, bucket.sessions.length - MAX_SESSIONS + 1);
    if (bucket.sessions.length >= MAX_SESSIONS) {
        throw fail('SCRATCHPAD_SESSION_LIMIT', `This chat already has ${MAX_SESSIONS} Scratchpad sessions. Delete one to start another.`, 409);
    }
    const assistant = normaliseAssistant(input.assistant);
    const previous = bucket.sessions.find(item => item.id === bucket.activeSessionId);
    const name = boundedString(input.name, MAX_NAME_LENGTH, { trim: true });
    const session = {
        id: newScratchpadId(),
        name: name || nextName(bucket, assistant),
        automaticName: !name,
        assistant,
        gender: normaliseGender(input.gender),
        temporary: input.temporary === true,
        created: now(),
        updated: now(),
        settings: normaliseSettings(input.settings, previous ? { ...previous.settings, picked: [], notes: previous.settings.notes.filter(ref => !ref.grantId) } : defaultSettings()),
        messages: [],
    };
    if (Array.isArray(input.messages)) {
        session.messages = input.messages.map(item => normaliseMessage({ ...item, id: undefined, state: 'done', jobId: undefined, proposals: undefined, notebookProposals: undefined }))
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
        session.automaticName = false;
    }
    if (input.assistant !== undefined) {
        const assistant = normaliseAssistant(input.assistant);
        if (assistant !== session.assistant && session.automaticName && !session.messages.length) {
            session.name = nextName(bucket, assistant, session.id);
        }
        session.assistant = assistant;
    }
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
    if (byteLength(text) > (message.role === 'user' ? MAX_INPUT_BYTES : MAX_MESSAGE_BYTES)) throw fail('SCRATCHPAD_TEXT_TOO_LARGE', 'That message is too long.', 413);
    message.text = text;
    delete message.token_count;
    message.edited = true;
    if (message.role === 'assistant') {
        message.state = 'done';
        delete message.error;
        delete message.proposals;
        delete message.notebookProposals;
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
        cleanup: bucket.cleanup ?? defaultCleanup(),
        sessions: bucket.sessions,
        limits: { sessions: MAX_SESSIONS, messages: MAX_MESSAGES, messageBytes: MAX_MESSAGE_BYTES, inputBytes: MAX_INPUT_BYTES, maxTokens: MAX_MAX_TOKENS, depth: MAX_DEPTH, notes: MAX_NOTE_REFERENCES },
    };
}

export const testExports = { normaliseBucket, normaliseMessage, normaliseSession, dropTemporary };
