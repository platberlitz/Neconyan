// Every call into the Neconyan host lives here. Nothing in this file touches the DOM.

import {
    EXT_PROMPT_KEY,
    KIND_AMBIENT,
    KIND_CHARACTER,
    KIND_PERSONA,
    SETTINGS_KEY,
    buildCarryoverBlock,
    buildCorrectionMessage,
    buildProfileMessages,
    buildRefreshMessages,
    deriveAccounts,
    digestLines,
    inertText,
    materializeRefresh,
    normalizeSettings,
    parseProfileResponse,
    parseRefreshResponse,
    selectParticipants,
    MAX_NEW_STRANGERS_PER_REFRESH,
    MAX_POLLS_PER_REFRESH,
    reasoningOverridesFrom,
    reconcileInteractions,
} from './core.js';
import { createStorageClient } from './storage-client.js';
import { createStorageTransport } from './storage-transport.js';

// getContext() copies chatId / characterId / chatMetadata by value, so a cached reference
// silently reads the wrong chat. Always resolve it fresh.
function ctx() {
    return globalThis.SillyTavern.getContext();
}

// Host magic numbers, named locally rather than deep-imported.
const EXTENSION_PROMPT_TYPE_IN_CHAT = 1;
const EXTENSION_PROMPT_ROLE_SYSTEM = 0;

/** How much of the open roleplay chat a character may react to, when the user turns that on. */
const SCENE_MESSAGE_LIMIT = 12;
const SCENE_CHAR_BUDGET = 4000;
const REQUEST_TIMEOUT_MS = 30_000;

function requestSignal(signal) {
    if (AbortSignal.timeout && (!signal || AbortSignal.any)) {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        return signal ? AbortSignal.any([signal, timeout]) : timeout;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    const timer = setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }, { once: true });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    return controller.signal;
}

// --- settings -------------------------------------------------------------

const storageClients = new WeakMap();
const storageTransports = new WeakMap();
const bootstrapSettings = new WeakMap();
const liveClients = new Set();
function storage() {
    const key = ctx().extensionSettings;
    let client = storageClients.get(key);
    if (!client) {
        const transport = createStorageTransport({
            request: (url, options) => fetch(url, { ...options, headers: ctx().getRequestHeaders(), cache: 'no-store',
                credentials: 'same-origin', redirect: 'error', signal: requestSignal() }),
            readJson,
        });
        client = createStorageClient({ request: transport.request });
        storageClients.set(key, client);
        storageTransports.set(client, transport);
        liveClients.add(client);
    }
    return client;
}

globalThis.addEventListener?.('beforeunload', event => {
    if ([...liveClients].some(client => client.needsUnloadWarning())) {
        event.preventDefault();
        event.returnValue = '';
    }
});

export async function initializeStorage() { return storage().initialise(); }
export function getStorageMode() { return storageTransports.get(storage()).mode; }
export function getSaveStatus(_sessionId) { return storage().getSaveStatus(); }
export function subscribeSaveStatus(callback) { return storage().subscribeSaveStatus(callback); }
export function readDraft(sessionId, personaId) { return storage().readDraft(sessionId, personaId); }
export function saveDraft(sessionId, personaId, value) { return storage().saveDraft(sessionId, personaId, value); }
export function clearDraft(sessionId, personaId) { return storage().clearDraft(sessionId, personaId); }
export function resolveDraft(sessionId, personaId, value) { return storage().resolveDraft(sessionId, personaId, value); }
export function exportRecovery() { return storage().exportRecovery(); }
export function discardRecoveryAndReload() { return storage().discardRecoveryAndReload(); }

export function getSettings() {
    if (storage().initialised) return storage().settings;
    const context = ctx();
    return normalizeSettings(bootstrapSettings.get(context.extensionSettings) ?? context.extensionSettings?.[SETTINGS_KEY]);
}

export function updateSettings(patch) {
    if (patch.carry?.enabled === false) clearCarryover();
    if (storage().initialised) return storage().updateSettings(patch);
    const context = ctx();
    const next = normalizeSettings({ ...getSettings(), ...patch });
    bootstrapSettings.set(context.extensionSettings, next);
    // Bootstrap only. Storage owns migration; never write legacy host settings.
    return next;
}

export function listSessions() {
    return Object.values(getSettings().sessions);
}

export function getSession(sessionId) {
    const sessions = getSettings().sessions;
    return Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : null;
}

export function updateSession(sessionId, patch) {
    const settings = getSettings();
    const current = Object.hasOwn(settings.sessions, sessionId) ? settings.sessions[sessionId] : null;
    if (!current) {
        throw new Error('That timeline session no longer exists.');
    }
    const sessions = { ...settings.sessions, [sessionId]: { ...current, ...patch, id: sessionId } };
    const next = updateSettings({ sessions });
    const session = next.sessions[sessionId];
    if (next.activeSessionId === sessionId && session.personaId) {
        return updateSettings({
            activeSessionByPersona: { ...next.activeSessionByPersona, [session.personaId]: sessionId },
        }).sessions[sessionId];
    }
    return session;
}

export function ensureActiveSession(personaId = ctx().userAvatar ?? '') {
    const settings = getSettings();
    const sessions = settings.sessions;
    let session = sessions[settings.activeSessionByPersona[personaId]];
    if (!session && settings.activeSessionId) {
        const active = sessions[settings.activeSessionId];
        session = active?.personaId === personaId ? active : null;
    }
    session ??= Object.values(sessions).find(item => item.personaId === personaId);
    if (!session) {
        const unowned = Object.values(sessions).find(item => !item.personaId);
        if (unowned) {
            session = updateSession(unowned.id, {
                personaId,
                personaProfile: settings.profiles[`${KIND_PERSONA}:${personaId}`] ?? unowned.personaProfile,
            });
        }
    }
    if (!session) {
        session = createSession({ personaId });
    }
    const fresh = getSettings();
    if (fresh.activeSessionId !== session.id || fresh.activeSessionByPersona[personaId] !== session.id) {
        updateSettings({
            activeSessionId: session.id,
            activeSessionByPersona: { ...fresh.activeSessionByPersona, [personaId]: session.id },
        });
    }
    return getSession(session.id);
}

export function createSession({ name = '', type = '', personaId = '', invited = [], ambient = false } = {}) {
    const context = ctx();
    const settings = getSettings();
    let id = String(context.uuidv4?.() ?? `${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || `${Date.now()}`;
    while (settings.sessions[id]) {
        id = `${id}x`;
    }
    const session = {
        id,
        name: name || `Timeline ${Object.keys(settings.sessions).length + 1}`,
        type: type || 'Open timeline',
        personaId: personaId || context.userAvatar || '',
        invited,
        ambient,
        scenarioNoteIds: [],
        personaProfile: {},
        follows: {},
        lastRefreshAt: 0,
        feedPath: '',
    };
    const next = updateSettings({
        sessions: { ...settings.sessions, [id]: session },
        activeSessionId: id,
        activeSessionByPersona: session.personaId
            ? { ...settings.activeSessionByPersona, [session.personaId]: id }
            : settings.activeSessionByPersona,
    });
    return next.sessions[id];
}

/**
 * Removes a timeline's feed and session entry together. Legacy files are untouched. If it was
 * the last one, the next open creates a fresh empty timeline.
 */
export async function deleteSession(sessionId) {
    await initializeStorage();
    const settings = getSettings();
    const session = settings.sessions[sessionId];
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const fresh = getSettings();
    const sessions = { ...fresh.sessions };
    delete sessions[sessionId];
    updateSettings({
        sessions,
        activeSessionId: fresh.activeSessionId === sessionId ? '' : fresh.activeSessionId,
        activeSessionByPersona: Object.fromEntries(Object.entries(fresh.activeSessionByPersona).filter(([, id]) => id !== sessionId)),
        ...(sessionId === 'legacy' ? { shards: [] } : {}),
    });
    await flushFeed();
}

export async function selectSession(sessionId, { personaId = null } = {}) {
    const before = getSettings();
    const session = before.sessions[sessionId];
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const targetPersonaId = personaId ?? session.personaId;
    if (targetPersonaId && !listPersonas().some(persona => persona.entityId === targetPersonaId)) {
        throw new Error('That persona is no longer available.');
    }
    const changedPersona = targetPersonaId !== session.personaId;
    const sessions = changedPersona
        ? {
            ...before.sessions,
            [sessionId]: {
                ...session,
                personaId: targetPersonaId,
                scenarioNoteIds: [],
                personaProfile: {},
            },
        }
        : before.sessions;
    const activeSessionByPersona = Object.fromEntries(
        Object.entries(before.activeSessionByPersona).filter(([, id]) => id !== sessionId),
    );
    if (targetPersonaId) {
        activeSessionByPersona[targetPersonaId] = sessionId;
    }
    updateSettings({
        sessions,
        activeSessionId: sessionId,
        activeSessionByPersona,
    });
    if (targetPersonaId && targetPersonaId !== ctx().userAvatar) {
        try {
            const { setUserAvatar } = await import('/scripts/personas.js');
            await setUserAvatar(targetPersonaId, { toastPersonaNameChange: false });
        } catch (error) {
            if (ctx().userAvatar !== targetPersonaId) {
                const fresh = getSettings();
                const freshSession = fresh.sessions[sessionId];
                const rolledBackSession = changedPersona && freshSession?.personaId === targetPersonaId
                    ? {
                        ...freshSession,
                        personaId: session.personaId,
                        scenarioNoteIds: session.scenarioNoteIds,
                        personaProfile: session.personaProfile,
                    }
                    : freshSession;
                const rolledBackByPersona = { ...fresh.activeSessionByPersona };
                if (targetPersonaId && rolledBackByPersona[targetPersonaId] === sessionId) {
                    if (before.activeSessionByPersona[targetPersonaId]) {
                        rolledBackByPersona[targetPersonaId] = before.activeSessionByPersona[targetPersonaId];
                    } else {
                        delete rolledBackByPersona[targetPersonaId];
                    }
                }
                if (session.personaId && before.activeSessionByPersona[session.personaId]) {
                    rolledBackByPersona[session.personaId] = before.activeSessionByPersona[session.personaId];
                }
                updateSettings({
                    sessions: rolledBackSession
                        ? { ...fresh.sessions, [sessionId]: rolledBackSession }
                        : fresh.sessions,
                    activeSessionId: fresh.activeSessionId === sessionId ? before.activeSessionId : fresh.activeSessionId,
                    activeSessionByPersona: rolledBackByPersona,
                });
                throw new Error(`The host could not switch to that persona (${error.message}).`);
            }
            console.warn('[Meower] the host switched persona but a listener reported an error', error);
        }
    }
    return getSession(sessionId);
}

// --- characters and personas ---------------------------------------------

/**
 * context.characters is [] until getCharacters() has been awaited - and [] passes a
 * truthiness check, so an unrefreshed read looks exactly like "no characters installed".
 */
export async function ensureCharacters() {
    const context = ctx();
    if (!Array.isArray(context.characters) || context.characters.length === 0) {
        await context.getCharacters();
    }
    return ctx().characters ?? [];
}

export function listPersonas() {
    const context = ctx();
    const personas = context.powerUserSettings?.personas ?? {};
    const list = Object.entries(personas).map(([entityId, name]) => ({ entityId, name: String(name || 'You') }));
    if (context.userAvatar && !list.some(persona => persona.entityId === context.userAvatar)) {
        list.push({ entityId: context.userAvatar, name: context.name1 || 'You' });
    }
    return list;
}

export function getScenarioNotes(personaId) {
    const appendices = ctx().powerUserSettings?.persona_descriptions?.[personaId]?.appendices;
    if (!Array.isArray(appendices)) {
        return [];
    }
    return appendices.map((note, index) => ({
        id: String(note?.id || `scenario-note-${index}`),
        name: String(note?.name || `Scenario Note ${index + 1}`),
        description: String(note?.description ?? ''),
    })).filter(note => note.id);
}

export function getPersona(personaId = ctx().userAvatar, scenarioNoteIds = []) {
    const context = ctx();
    const entityId = personaId;
    if (!entityId) {
        return null;
    }
    const descriptor = context.powerUserSettings?.persona_descriptions?.[entityId] ?? {};
    const selected = new Set(scenarioNoteIds);
    const description = [String(descriptor.description ?? '').trim()];
    for (const note of getScenarioNotes(entityId)) {
        if (selected.has(note.id) && note.description.trim()) {
            description.push(`(${note.name})\n${note.description.trim()}`);
        }
    }
    return {
        entityId,
        name: context.powerUserSettings?.personas?.[entityId] || (entityId === context.userAvatar ? context.name1 : '') || 'You',
        description: description.filter(Boolean).join('\n\n'),
    };
}

export async function currentAccounts(sessionId = ensureActiveSession().id) {
    const settings = getSettings();
    const session = settings.sessions[sessionId];
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const characters = await ensureCharacters();
    const persona = getPersona(session.personaId, session.scenarioNoteIds);
    const profiles = { ...settings.profiles };
    if (persona?.entityId) {
        profiles[`${KIND_PERSONA}:${persona.entityId}`] = session.personaProfile;
    }
    return deriveAccounts({
        characters,
        invited: session.invited,
        persona,
        ambient: session.ambient,
        strangers: session.strangers,
        profiles,
    });
}

export function avatarUrl(account) {
    const context = ctx();
    if (!account || account.kind === KIND_AMBIENT || !account.entityId) {
        return '';
    }
    const type = account.kind === KIND_PERSONA ? 'persona' : 'avatar';
    const url = context.getThumbnailUrl(type, account.entityId);
    // A feed paints a lot of avatars at 44px; the mobile preset is the same image, smaller.
    return context.isMobile?.() ? `${url}&preset=mobile` : url;
}

// --- feed storage ---------------------------------------------------------

export async function loadFeed(sessionId) {
    await initializeStorage();
    sessionId ??= ensureActiveSession().id;
    return storage().feed(sessionId);
}

function parseJson(text) {
    try {
        return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

/** Reads a JSON response, and says what actually arrived when the body is not JSON. */
async function readJson(response, what) {
    const text = await response.text();
    const parsed = parseJson(text);
    if (parsed === null) {
        console.error(`[Meower] ${what} did not answer with JSON`, response.url, text.slice(0, 300));
        throw new Error(`${what} answered with "${text.trim().slice(0, 40)}" instead of data. Is this Neconyan tab still signed in?`);
    }
    return parsed;
}

// The picker's accept="image/*" is advisory only; validate before buffering anything.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
]);

function hasImageSignature(bytes, type) {
    if (type === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (type === 'image/gif') return String.fromCharCode(...bytes.slice(0, 4)) === 'GIF8';
    return String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
}

/** Attaches a picture the user picked from their device to a post they are writing. */
export async function uploadImage(file) {
    const context = ctx();
    const extension = IMAGE_TYPES.get(file?.type);
    if (!extension) {
        throw new Error('That file is not a supported image.');
    }
    if (file.size > MAX_IMAGE_BYTES) {
        throw new Error('That image is too large - the limit is 10 MB.');
    }
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (!hasImageSignature(bytes, file.type)) {
        throw new Error('That file does not match its image type.');
    }
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    const name = `twitterlike-${context.uuidv4()}.${extension}`;
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name, data: btoa(binary) }),
        signal: requestSignal(),
    });
    if (!response.ok) {
        throw new Error(`Could not upload that image (${response.status})`);
    }
    const { path } = await readJson(response, 'The image upload');
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
        throw new Error('The image upload did not return a valid path.');
    }
    return path;
}

function snapshotFeed(feed) {
    return structuredClone({ version: 1, posts: feed.posts, interactions: feed.interactions, ...(feed.epoch !== undefined ? { epoch: feed.epoch } : {}) });
}

export function queueFeed(feed, sessionId = ensureActiveSession().id) {
    storage().queue(feed, sessionId);
}

/** Saves pending visible edits first, then commits this exact transactional snapshot. */
export async function writeFeed(feed, sessionId, options = {}) {
    const snapshot = snapshotFeed(feed);
    await initializeStorage();
    sessionId ??= ensureActiveSession().id;
    return storage().write(snapshot, sessionId, { baseFeed: feed, ...options });
}

export async function replaceFeed(feed, sessionId) {
    await initializeStorage();
    sessionId ??= ensureActiveSession().id;
    const committed = await storage().write(snapshotFeed(feed), sessionId, { replace: true });
    Object.assign(feed, committed);
    return feed;
}

export async function syncFeed(feed, sessionId) {
    await initializeStorage();
    sessionId ??= ensureActiveSession().id;
    return storage().sync(feed, sessionId);
}

/** Liking three posts in a row should be one write, not three. */
export function saveFeedDebounced(feed, delay = 1200, sessionId = ensureActiveSession().id) {
    storage().queue(feed, sessionId, delay);
}

/** Waits out any in-flight write, then writes whatever is still unsaved. */
export async function flushFeed(_sessionId = '') {
    return storage().flush();
}

// --- generation -----------------------------------------------------------

export function listConnectionProfiles({ throwOnError = false } = {}) {
    const context = ctx();
    const service = context.ConnectionManagerRequestService;
    if (!service) {
        return [];
    }
    try {
        return service.getSupportedProfiles() ?? [];
    } catch (error) {
        if (throwOnError) {
            throw new Error('Connection Manager profiles could not be read.', { cause: error });
        }
        return [];
    }
}

/**
 * ConnectionManagerRequestService takes a message array verbatim - no chat history, no
 * character card, no macro substitution. generateQuietPrompt cannot be used here: its
 * skipWIAN only skips World Info and the Author's Note, so the open chat would leak into
 * every post, and its forceChId only works in group chats.
 */
/** The reasoning settings of the chosen profile's preset, for the fields the profile leaves unset. */
function reasoningOverrides(service, profileId) {
    try {
        const profile = service.getProfile?.(profileId);
        if (!profile?.preset) {
            return {};
        }
        const preset = ctx().getPresetManager?.('openai')?.getCompletionPresetByName?.(profile.preset);
        return reasoningOverridesFrom(profile, preset);
    } catch (error) {
        console.warn('[Meower] could not read the reasoning settings of that connection profile', error);
        return {};
    }
}

// ponytail: serialise Meower's fallback calls; other host extensions can still change the
// shared response length. generateRawData uses the same global state as generateRaw.
let rawGenerationChain = Promise.resolve();

async function runGeneration(messages, maxTokens, signal) {
    signal?.throwIfAborted();
    const context = ctx();
    const settings = getSettings();
    const service = context.ConnectionManagerRequestService;

    if (settings.profileId) {
        if (!service || !listConnectionProfiles({ throwOnError: true }).some(profile => profile?.id === settings.profileId)) {
            throw new Error('The selected connection profile is unavailable. Choose another connection in Meower settings.');
        }
        const result = await service.sendRequest(settings.profileId, messages, maxTokens, {
            stream: false,
            signal,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        }, reasoningOverrides(service, settings.profileId));
        signal?.throwIfAborted();
        return typeof result === 'string' ? result : (result?.content ?? '');
    }

    // Fallback: also history-free, but it prefixes turns with name1/name2 and runs
    // substituteParams with the globals, so the caller must not rely on {{macros}}.
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const prompt = messages.filter(message => message.role !== 'system').map(message => message.content).join('\n\n');
    const request = rawGenerationChain.then(() => {
        signal?.throwIfAborted();
        return context.generateRaw({ prompt, systemPrompt: system, responseLength: maxTokens, signal });
    });
    // Keep the lock until the host settles, even if it ignores cancellation.
    rawGenerationChain = request.then(() => {}, () => {});
    const result = await request;
    signal?.throwIfAborted();
    return result;
}

async function generateProfilesFor(accounts, allAccounts, signal, { avoid = null } = {}) {
    signal?.throwIfAborted();
    if (!accounts.length) {
        return {};
    }
    const targets = new Set(accounts.map(account => account.key));
    const others = allAccounts.filter(account => !targets.has(account.key));
    const avoided = avoid ?? others.map(account => account.handle);
    const messages = buildProfileMessages(accounts, { avoid: avoided });
    const raw = await runGeneration(messages, getSettings().maxTokens, signal);
    signal?.throwIfAborted();
    try {
        return parseProfileResponse(raw, accounts, others, avoided);
    } catch (error) {
        console.warn('[Meower] profile generation returned unusable JSON', error);
        return {};
    }
}

function saveGeneratedProfiles(profiles, previous, signal) {
    signal?.throwIfAborted();
    const current = getSettings().profiles;
    const unchanged = Object.fromEntries(Object.entries(profiles).filter(([key]) =>
        JSON.stringify(previous[key]) === JSON.stringify(current[key])));
    if (Object.keys(unchanged).length) {
        updateSettings({ profiles: { ...current, ...unchanged } });
    }
    return unchanged;
}

/**
 * Generates the persona's timeline profile (name, handle, bio, location) with the same
 * connection that writes posts, from the persona description. Returns the profile or null.
 */
export async function generatePersonaProfile(sessionId, { signal } = {}) {
    signal?.throwIfAborted();
    sessionId ??= ensureActiveSession().id;
    const previous = getSession(sessionId);
    const accounts = await currentAccounts(sessionId);
    signal?.throwIfAborted();
    const persona = accounts.find(account => account.kind === KIND_PERSONA) ?? null;
    if (!persona) {
        throw new Error('Set a persona for this timeline first.');
    }
    const profiles = await generateProfilesFor([persona], accounts, signal);
    signal?.throwIfAborted();
    const current = getSession(sessionId);
    if (!current) {
        throw new Error('That timeline session no longer exists.');
    }
    if (previous.personaId !== current.personaId
        || JSON.stringify(previous.personaProfile) !== JSON.stringify(current.personaProfile)
        || JSON.stringify(previous.scenarioNoteIds) !== JSON.stringify(current.scenarioNoteIds)) {
        throw new Error('The persona or its profile changed while generation was running. Your edits were kept.');
    }
    const profile = profiles[persona.key];
    if (!profile) {
        return null;
    }
    return { name: profile.name, handle: profile.handle, bio: profile.bio, location: profile.location };
}

/**
 * Writes a character a fresh timeline profile (name, handle, bio, location), ruling out its
 * current handle and everyone else's, and saves it. Returns the profile or null.
 */
export async function regenerateProfile(accountKey, sessionId, { signal } = {}) {
    signal?.throwIfAborted();
    sessionId ??= ensureActiveSession().id;
    const previous = getSettings().profiles;
    const accounts = await currentAccounts(sessionId);
    signal?.throwIfAborted();
    const account = accounts.find(item => item.key === accountKey) ?? null;
    if (!account || account.kind !== KIND_CHARACTER) {
        throw new Error('Only characters can be given a new profile here.');
    }
    const profiles = await generateProfilesFor([account], accounts, signal, { avoid: accounts.map(item => item.handle) });
    signal?.throwIfAborted();
    const profile = profiles[account.key];
    if (!profile) {
        return null;
    }
    const saved = saveGeneratedProfiles(profiles, previous, signal);
    if (!saved[account.key]) {
        throw new Error('That profile changed while generation was running. Your edits were kept.');
    }
    return profile;
}

/**
 * Fresh profiles for every invited character of a timeline, in one request. Every current
 * handle is ruled out, so they all change. Returns how many profiles were written.
 */
export async function regenerateAllProfiles(sessionId, { signal } = {}) {
    signal?.throwIfAborted();
    sessionId ??= ensureActiveSession().id;
    const previous = getSettings().profiles;
    const accounts = await currentAccounts(sessionId);
    signal?.throwIfAborted();
    const characters = accounts.filter(account => account.kind === KIND_CHARACTER);
    if (!characters.length) {
        throw new Error('Invite at least one character first.');
    }
    const profiles = await generateProfilesFor(characters, accounts, signal, { avoid: accounts.map(account => account.handle) });
    const written = Object.keys(saveGeneratedProfiles(profiles, previous, signal)).length;
    if (!written && Object.keys(profiles).length) {
        throw new Error('The profiles changed while generation was running. Your edits were kept.');
    }
    return written;
}

/**
 * Quick Image Gen 3.3+ advertises a quiet /qig that hands back the saved image path; before
 * that, or without it, the Image Generation extension's /imagine is the only way to a picture.
 */
function imageCommandFor(context, quoted) {
    const qig = context.SlashCommandParser?.commands?.qig;
    const quiet = Array.isArray(qig?.namedArgumentList) && qig.namedArgumentList.some(argument => argument?.name === 'quiet');
    return quiet ? `/qig quiet=true mode=direct ${quoted}` : `/imagine quiet=true gallery=false ${quoted}`;
}

/**
 * Forgets a timeline's passers-by, so the next refresh invents new ones. Their old posts keep
 * the name and avatar they were written under; only the cast that keeps coming back is dropped.
 */
export function clearStrangers(sessionId = ensureActiveSession().id) {
    const session = getSession(sessionId);
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const cleared = session.strangers.length;
    if (cleared) {
        updateSession(sessionId, { strangers: [] });
    }
    return cleared;
}

export async function generatePostImage(prompt, signal, onProgress = () => {}) {
    signal?.throwIfAborted();
    const context = ctx();
    if (typeof context.executeSlashCommandsWithOptions !== 'function') {
        return '';
    }
    const controller = new AbortController();
    let command = '';
    const onAbort = () => {
        controller.abort();
        onProgress(command.startsWith('/qig ')
            ? 'Quick Image Gen cannot cancel this request from Meower. Waiting for it to finish; its image will be discarded.'
            : 'Image cancellation requested. Waiting for the provider; its image will be discarded.');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        // The prompt is model output, so it is quoted and escaped: unquoted, its text could
        // parse as named flags (quiet=false gallery=true ...) instead of the image
        // description. quiet=true returns the path instead of posting into the open chat.
        const quoted = `"${inertText(prompt).replace(/[\\"]/g, '\\$&').replace(/\s+/g, ' ').trim()}"`;
        command = imageCommandFor(context, quoted);
        // The slash runner reads a controller, not an AbortSignal option. /imagine listens
        // on that controller only after preparing its prompt, so replay an earlier abort.
        const abortController = {
            signal: { get aborted() { return controller.signal.aborted; }, isQuiet: true, reason: 'Meower stopped.' },
            addEventListener(type, listener) {
                controller.signal.addEventListener(type, listener, { once: true });
                if (type === 'abort' && controller.signal.aborted) {
                    listener(new Event('abort'));
                }
            },
            removeEventListener: (...args) => controller.signal.removeEventListener(...args),
        };
        signal?.throwIfAborted();
        const result = await context.executeSlashCommandsWithOptions(
            command,
            { handleParserErrors: false, handleExecutionErrors: false, abortController },
        );
        signal?.throwIfAborted();
        const pipe = typeof result?.pipe === 'string' ? result.pipe.trim() : '';
        // Anything that is not a path or URL is a status line ("QIG failed: ..."), not a picture.
        if (!/^(\/|https?:\/\/|data:image\/|blob:)/i.test(pipe)) {
            if (pipe) {
                console.warn('[Meower] image generation returned no image:', pipe);
            }
            return '';
        }
        return pipe;
    } catch (error) {
        signal?.throwIfAborted();
        if (error?.name === 'AbortError') {
            throw error;
        }
        console.warn('[Meower] image generation failed, publishing text only', error);
        return '';
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * One refresh: pick the cast, give anyone new a profile, ask for a batch of activity, then
 * re-check every quota locally before storing anything. The model is never trusted to have
 * obeyed the prompt.
 */
/**
 * The roleplay scene the user has open, for the accounts who are in it. Only read when the
 * user asks for it: this is chat text leaving the chat, and it goes wherever the timeline's
 * connection profile points.
 */
function currentScene(settings) {
    if (!settings.scene.enabled) {
        return null;
    }
    const context = ctx();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const lines = [];
    const names = new Set();
    let budget = SCENE_CHAR_BUDGET;
    for (const message of chat.slice(-SCENE_MESSAGE_LIMIT * 2).reverse()) {
        if (!message || message.is_system || typeof message.mes !== 'string' || !message.mes.trim()) {
            continue;
        }
        const who = message.name || (message.is_user ? context.name1 : context.name2) || 'Someone';
        const line = `${who}: ${message.mes.trim().replace(/\s+/g, ' ')}`;
        if (lines.length >= SCENE_MESSAGE_LIMIT || line.length > budget) {
            break;
        }
        budget -= line.length + 1;
        lines.unshift(line);
        // Who is in the scene is who speaks in it: a name the model can match to an account.
        if (!message.is_user) {
            names.add(who);
        }
    }
    // Without a name there is nobody the scene belongs to, and no way to say who may mention
    // it - so it is not worth sending the chat at all.
    if (!lines.length || !names.size) {
        return null;
    }
    return { names: [...names], lines };
}

export async function runRefresh({ sessionId, feed, signal, onProgress = () => {}, onPartial = () => {}, topic = '' } = {}) {
    signal?.throwIfAborted();
    sessionId ??= ensureActiveSession().id;
    const settings = getSettings();
    const session = settings.sessions[sessionId];
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const accounts = await currentAccounts(sessionId);
    signal?.throwIfAborted();
    const persona = accounts.find(account => account.kind === KIND_PERSONA) ?? null;

    const active = selectParticipants(accounts, settings, {
        posts: feed.posts,
        interactions: feed.interactions,
    });
    if (!active.length && !session.ambient) {
        throw new Error('Invite a character first, or let strangers join in.');
    }

    // Only the selected cast gets a profile, so an install with 200 characters does not
    // send 200 cards on the first refresh.
    const needProfiles = active.filter(account => account.kind === KIND_CHARACTER && !account.hasProfile);
    let profilesWritten = 0;
    if (needProfiles.length) {
        onProgress('Writing profiles...');
        const profiles = await generateProfilesFor(needProfiles, accounts, signal);
        profilesWritten = Object.keys(saveGeneratedProfiles(profiles, settings.profiles, signal)).length;
    }

    // Re-derive so freshly generated handles are the ones the prompt advertises.
    const freshAccounts = await currentAccounts(sessionId);
    signal?.throwIfAborted();
    const freshPersona = freshAccounts.find(account => account.kind === KIND_PERSONA) ?? persona;
    const current = getSettings();
    const currentSession = current.sessions[sessionId];
    if (!currentSession) {
        throw new Error('That timeline session no longer exists.');
    }
    const freshByKey = new Map(freshAccounts.map(account => [account.key, account]));
    const freshActive = active
        .map(account => freshByKey.get(account.key))
        .filter(account => account && (account.kind !== KIND_AMBIENT || currentSession.ambient));
    if (!freshActive.length && !currentSession.ambient) {
        throw new Error('Invite a character first, or let strangers join in.');
    }
    const activeKeys = new Set(freshActive.map(account => account.key));

    const scene = currentScene(current);
    const newId = () => ctx().uuidv4();
    const batch = {
        sessionId, feed, signal, onProgress, onPartial,
        accounts: freshAccounts, active: freshActive, persona: freshPersona, session: currentSession, settings: current,
        activeKeys, newId, topic, scene,
    };

    if (current.incremental) {
        const result = await runIncrementalRefresh(batch);
        result.profilesWritten = profilesWritten;
        return result;
    }

    onProgress(topic ? `Writing posts about ${topic}...` : 'Writing posts...');
    const messages = buildRefreshMessages({
        accounts: freshAccounts,
        active: freshActive,
        persona: freshPersona,
        session: currentSession,
        posts: feed.posts,
        interactions: feed.interactions,
        settings: current,
        now: Date.now(),
        localTime: new Date().toLocaleString(),
        strangers: currentSession.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
        // A topic refresh keeps the trending bar as it is; a plain one writes a fresh set.
        trends: !topic,
        topic,
        scene,
    });
    const parsed = await generateBatch(messages, current.maxTokens, batch, { throwOnFailure: true });
    const result = materializeRefresh(parsed, {
        accounts: freshAccounts,
        // The prompt asks for active accounts only; this enforces it locally, so a
        // malformed batch cannot act through an invited-but-deactivated character.
        allowedActorKeys: [...activeKeys],
        allowedPostAuthorKeys: [...activeKeys],
        settings: current,
        posts: feed.posts,
        interactions: feed.interactions,
        newId,
        now: Date.now(),
        strangerLimit: currentSession.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
        requiredTopic: topic,
        allowTrends: !topic,
    });
    await commitBatch(result, batch);
    result.profilesWritten = profilesWritten;
    return result;
}

/** Asks the model once, retrying a malformed answer once with a correction. Null when it gives up and throwOnFailure is off. */
async function generateBatch(messages, maxTokens, { signal, onProgress, active }, { throwOnFailure = false } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptMessages = attempt === 0
            ? messages
            : [...messages, { role: 'user', content: buildCorrectionMessage(lastError, active.map(a => a.handle)) }];
        const raw = await runGeneration(attemptMessages, maxTokens, signal);
        signal?.throwIfAborted();
        try {
            const parsed = parseRefreshResponse(raw);
            if (parsed.salvaged) {
                onProgress('That came back cut off, keeping the complete part...');
            }
            return parsed;
        } catch (error) {
            lastError = error.message;
            if (attempt === 1) {
                if (throwOnFailure) {
                    throw new Error(`The model did not return usable JSON (${error.message}).`);
                }
                return null;
            }
            onProgress('That came back malformed, asking again...');
        }
    }
    return null;
}

/**
 * Draws any images, writes the whole future feed (the commit point), then mirrors the
 * new rows into the in-memory feed and the session. Shared by the batch and the
 * activity-at-a-time paths so both persist the same way.
 */
async function commitBatch(result, { sessionId, feed, signal, onProgress, onPartial, settings }) {
    signal?.throwIfAborted();
    if (settings.images.enabled) {
        const withPrompts = result.posts.filter(post => post.image?.prompt);
        for (const [index, post] of withPrompts.entries()) {
            signal?.throwIfAborted();
            onProgress(`Drawing image ${index + 1} of ${withPrompts.length}...`);
            const url = await generatePostImage(post.image.prompt, signal, onProgress);
            signal?.throwIfAborted();
            // A failed image publishes a clean text-only post rather than exposing the prompt.
            post.image = url ? { url, prompt: post.image.prompt } : null;
            if (!url) {
                result.warnings.push(`image: could not be drawn for @${post.authorSnapshot?.handle ?? 'someone'}, posted as text`);
            }
        }
    }

    signal?.throwIfAborted();

    const reconcile = posts => {
        const generatedIds = new Set(result.interactions.map(item => item.id));
        const interactions = reconcileInteractions(posts, [...feed.interactions, ...result.interactions]);
        const kept = interactions.filter(item => generatedIds.has(item.id));
        if (kept.length < result.interactions.length) {
            result.warnings.push('reactions: skipped activity whose target changed while the refresh was running');
        }
        result.interactions = kept;
        return interactions;
    };

    // Persist the whole future state before touching anything the user can see: a failed
    // save must not leave phantom posts that vanish on reload while lastRefreshAt claims
    // the refresh happened.
    const posts = [...feed.posts, ...result.posts];
    const candidate = {
        version: 1,
        posts,
        interactions: reconcile(posts),
    };
    const freshSession = getSession(sessionId);
    const sessionPatch = { lastRefreshAt: Date.now() };
    if (result.strangers.length) {
        // Strangers are session records: a stranger a later refresh talks to must still exist.
        sessionPatch.strangers = [...(freshSession?.strangers ?? []), ...result.strangers];
    }

    if (result.trends?.length) {
        // Made-up trending topics: the newest set replaces the last one.
        sessionPatch.trends = result.trends;
    }

    if (result.follows.length) {
        // Merge into the freshest settings so a follow made manually while the model was
        // thinking is not overwritten by this refresh's snapshot.
        const follows = { ...freshSession.follows };
        for (const { actorKey, targetKey } of result.follows) {
            follows[actorKey] = [...new Set([...(follows[actorKey] ?? []), targetKey])];
        }
        sessionPatch.follows = follows;
    }
    onProgress('Saving generated activity...');
    const generatedInteractionIds = result.interactions.map(item => item.id);
    const committed = await writeFeed(candidate, sessionId, { signal, sessionPatch, baseFeed: feed, generatedInteractionIds });
    // Feed, strangers, follows and refresh time share one commit, including concurrent edits.
    Object.assign(feed, committed);
    const savedInteractions = new Map(committed.interactions.map(item => [item.id, item]));
    result.interactions = generatedInteractionIds.flatMap(id => savedInteractions.has(id) ? [savedInteractions.get(id)] : []);
    if (result.interactions.length < generatedInteractionIds.length) {
        result.warnings.push('reactions: skipped activity whose target changed while the refresh was running');
    }
    const savedPosts = new Map(committed.posts.map(item => [item.id, item]));
    result.posts = result.posts.flatMap(post => savedPosts.has(post.id) ? [savedPosts.get(post.id)] : []);

    try {
        onPartial(result);
    } catch (error) {
        console.error('[Meower] refresh observer failed after commit', error);
    }
}

function authorKeysForTurn(author, accounts, activeKeys) {
    return author
        ? [author.key]
        : accounts.filter(account => account.kind === KIND_AMBIENT && activeKeys.has(account.key)).map(account => account.key);
}

function settingsForActivity(settings, job) {
    const quotas = { posts: 0, replies: 0, reposts: 0, likes: 0 };
    const key = { post: 'posts', reply: 'replies', repost: 'reposts', like: 'likes' }[job.kind];
    quotas[key] = 1;
    return {
        ...settings,
        quotas,
        images: { ...settings.images, perRefresh: job.kind === 'post' ? job.imageLimit : 0 },
    };
}

function scopeActivity(parsed, job) {
    const scoped = { posts: [], interactions: [], follows: [], strangers: [], trends: [], salvaged: parsed.salvaged };
    if (job.kind === 'post') {
        scoped.posts = parsed.posts.slice(0, 1);
        scoped.strangers = job.strangers > 0 ? parsed.strangers.slice(0, job.strangers) : [];
        scoped.trends = job.trends ? parsed.trends : [];
        return scoped;
    }
    const allowed = job.kind === 'like' ? new Set(['like', 'vote']) : new Set([job.kind]);
    const interaction = parsed.interactions.find(item => allowed.has(String(item?.type ?? '').toLowerCase()));
    if (interaction) {
        scoped.interactions.push(interaction);
    }
    return scoped;
}

async function runActivity(batch, job, liveAccounts) {
    const { feed, persona, session, topic, scene, activeKeys, settings } = batch;
    const active = liveAccounts.filter(account => activeKeys.has(account.key));
    const turnSettings = settingsForActivity(settings, job);
    const messages = buildRefreshMessages({
        accounts: liveAccounts,
        active,
        persona,
        session,
        posts: feed.posts,
        interactions: feed.interactions,
        settings: turnSettings,
        now: Date.now(),
        localTime: new Date().toLocaleString(),
        strangers: job.strangers,
        pollLimit: job.pollLimit,
        scene,
        turn: job,
        trends: job.trends,
        topic,
    });
    const parsed = await generateBatch(messages, settings.maxTokens, { ...batch, active });
    return parsed ? { parsed: scopeActivity(parsed, job), turnSettings } : null;
}

/** Generates one item per request. Posts finish first, then tiny interaction requests run against them. */
async function runIncrementalRefresh(batch) {
    const { sessionId, feed, signal, onProgress, active, session, settings, activeKeys, newId, topic } = batch;
    const cast = active.filter(account => account.kind === KIND_CHARACTER);
    const width = Math.max(1, settings.concurrency);
    const all = { posts: [], interactions: [], follows: [], strangers: [], trends: [], warnings: [] };
    let commits = Promise.resolve();
    let committedRequests = 0;
    let firstTransportError = null;

    const runJobs = async (jobs, phaseWidth, phase) => {
        for (let start = 0; start < jobs.length; start += phaseWidth) {
            signal?.throwIfAborted();
            const wave = jobs.slice(start, start + phaseWidth);
            const requestAccounts = await currentAccounts(sessionId);
            signal?.throwIfAborted();
            onProgress(wave.length > 1
                ? `Writing ${wave.length} ${phase} ${settings.profileId ? 'at once' : 'one at a time'}...`
                : `${wave[0].kind === 'like' ? 'Like or vote' : `${wave[0].kind[0].toUpperCase()}${wave[0].kind.slice(1)}`} ${wave[0].index} of ${wave[0].total}...`);

            const outcomes = await Promise.allSettled(wave.map(async (baseJob) => {
                const job = baseJob.kind === 'post' && !cast.length
                    ? { ...baseJob, strangers: session.ambient ? Math.max(0, MAX_NEW_STRANGERS_PER_REFRESH - all.strangers.length) : 0 }
                    : baseJob;
                let generated;
                try {
                    generated = await runActivity(batch, job, requestAccounts);
                } catch (error) {
                    if (signal?.aborted) {
                        throw error;
                    }
                    console.warn(`[Meower] ${job.kind} ${job.index} of ${job.total} failed`, error);
                    firstTransportError ??= error;
                    all.warnings.push(`${job.kind} ${job.index}: ${error.message || 'request failed'}`);
                    return;
                }
                if (!generated) {
                    all.warnings.push(`${job.kind} ${job.index}: nothing usable came back, skipped`);
                    return;
                }
                const commit = commits.then(async () => {
                    signal?.throwIfAborted();
                    const liveAccounts = await currentAccounts(sessionId);
                    signal?.throwIfAborted();
                    const result = materializeRefresh(generated.parsed, {
                        accounts: liveAccounts,
                        allowedActorKeys: [...activeKeys],
                        allowedPostAuthorKeys: job.kind === 'post' ? authorKeysForTurn(job.author, liveAccounts, activeKeys) : null,
                        allowNewStrangerPosts: job.kind === 'post' && !job.author,
                        settings: generated.turnSettings,
                        posts: feed.posts,
                        interactions: feed.interactions,
                        newId,
                        now: Date.now(),
                        strangerLimit: job.strangers,
                        strangerPostLimit: job.kind === 'post'
                            ? Math.max(0, 1 - all.posts.filter(post => post.authorSnapshot?.kind === KIND_AMBIENT).length)
                            : 0,
                        pollLimit: job.pollLimit,
                        imageLimit: job.imageLimit,
                        requiredTopic: topic,
                        allowTrends: job.trends,
                    });
                    const changed = ['posts', 'interactions', 'follows', 'strangers', 'trends']
                        .some(key => result[key]?.length);
                    if (changed) {
                        await commitBatch(result, batch);
                        committedRequests += 1;
                    } else if (!result.warnings.length) {
                        result.warnings.push(`${job.kind} ${job.index}: requested activity was missing, skipped`);
                    }
                    for (const stranger of result.strangers) {
                        activeKeys.add(`${KIND_AMBIENT}:${stranger.id}`);
                    }
                    for (const key of ['posts', 'interactions', 'follows', 'strangers', 'trends', 'warnings']) {
                        all[key].push(...result[key]);
                    }
                });
                commits = commit;
                await commit;
            }));
            const failed = outcomes.find(outcome => outcome.status === 'rejected');
            if (failed) {
                throw failed.reason;
            }
        }
    };

    const postCount = cast.length ? settings.quotas.posts : Math.min(settings.quotas.posts, 1);
    const postJobs = Array.from({ length: postCount }, (_, offset) => {
        const index = offset + 1;
        return {
            kind: 'post',
            index,
            total: postCount,
            author: cast.length ? cast[offset % cast.length] : null,
            strangers: index === 1 && session.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
            pollLimit: index === 1 ? MAX_POLLS_PER_REFRESH : 0,
            trends: index === 1 && !topic,
            imageLimit: settings.images.enabled && index <= settings.images.perRefresh ? 1 : 0,
        };
    });
    await runJobs(postJobs, cast.length ? width : 1, 'posts');

    const counts = { reply: settings.quotas.replies, repost: settings.quotas.reposts, like: settings.quotas.likes };
    if (!activeKeys.size && Object.values(counts).some(Boolean)) {
        all.warnings.push('reactions: skipped, no active account exists');
        counts.reply = 0;
        counts.repost = 0;
        counts.like = 0;
    }
    const interactionJobs = [];
    for (let offset = 0; offset < Math.max(...Object.values(counts)); offset += 1) {
        for (const kind of ['reply', 'repost', 'like']) {
            if (offset < counts[kind]) {
                interactionJobs.push({ kind, index: offset + 1, total: counts[kind], strangers: 0, pollLimit: 0, trends: false, imageLimit: 0 });
            }
        }
    }
    await runJobs(interactionJobs, width, 'reactions');
    await commits;

    if (!committedRequests && firstTransportError) {
        throw firstTransportError;
    }
    return all;
}

// --- carryover ------------------------------------------------------------

function chatAccountKeys(accounts) {
    const context = ctx();
    const keys = new Set();
    const persona = accounts.find(account => account.kind === KIND_PERSONA);
    if (persona) {
        keys.add(persona.key);
    }
    const characters = context.characters ?? [];
    const active = characters[context.characterId];
    if (active?.avatar) {
        keys.add(`${KIND_CHARACTER}:${active.avatar}`);
    }
    const group = (context.groups ?? []).find(item => String(item.id) === String(context.groupId));
    for (const member of group?.members ?? []) {
        keys.add(`${KIND_CHARACTER}:${member}`);
    }
    return keys;
}

export function clearCarryover() {
    ctx().setExtensionPrompt(EXT_PROMPT_KEY, '', EXTENSION_PROMPT_TYPE_IN_CHAT, 1, false, EXTENSION_PROMPT_ROLE_SYSTEM);
}

/**
 * Injects a "Recent Social Media Activity" block into the current chat's prompt. Off by
 * default; clears itself whenever it has nothing to say, so a disabled or empty feed never
 * leaves a stale block behind.
 */
export async function applyCarryover(feed, sessionId, { isCurrent = () => true } = {}) {
    const settings = getSettings();
    if (!settings.carry.enabled) {
        if (isCurrent()) {
            clearCarryover();
        }
        return '';
    }

    sessionId ??= ensureActiveSession().id;
    const carrySnapshot = JSON.stringify(settings.carry);
    const stillCurrent = () => {
        if (!isCurrent()) {
            return false;
        }
        const current = getSettings();
        if (!current.carry.enabled) {
            clearCarryover();
            return false;
        }
        return carrySnapshot === JSON.stringify(current.carry);
    };
    const accounts = await currentAccounts(sessionId);
    if (!stillCurrent()) {
        return '';
    }
    const since = Date.now() - settings.carry.hours * 3600 * 1000;
    const lines = digestLines(feed.posts, feed.interactions, accounts, {
        since,
        limit: settings.carry.items,
        keys: [...chatAccountKeys(accounts)],
    });

    let block = buildCarryoverBlock(lines);
    const context = ctx();
    if (block && typeof context.getTokenCountAsync === 'function') {
        let kept = [...lines];
        while (kept.length) {
            const tokens = await context.getTokenCountAsync(buildCarryoverBlock(kept));
            if (!stillCurrent()) {
                return '';
            }
            if (tokens <= 1024) {
                break;
            }
            kept.shift();
        }
        block = buildCarryoverBlock(kept);
    }

    if (!stillCurrent()) {
        return '';
    }
    if (!block) {
        clearCarryover();
        return '';
    }
    context.setExtensionPrompt(
        EXT_PROMPT_KEY, block, EXTENSION_PROMPT_TYPE_IN_CHAT, settings.carry.depth, false, EXTENSION_PROMPT_ROLE_SYSTEM,
    );
    return block;
}
