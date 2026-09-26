// Every call into the Neconyan host lives here. Nothing in this file touches the DOM.

import {
    EXT_PROMPT_KEY,
    KIND_AMBIENT,
    KIND_CHARACTER,
    KIND_PERSONA,
    SETTINGS_KEY,
    buildCarryoverBlock,
    deriveAccounts,
    digestLines,
    normalizeSettings,
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

async function runNativeJob(kind, input, options) {
    await flushFeed();
    const [{ createMeowerJobClient }, jobs, host, user] = await Promise.all([
        import('./native-jobs.js'), import('/scripts/jobs.js'), import('/script.js'), import('/scripts/user.js'),
    ]);
    const account = user.getCurrentUserHandle();
    const request = async (url, options = {}) => {
        if (account !== user.getCurrentUserHandle()) throw new Error('account_changed');
        const response = await fetch(url, { ...options, headers: { ...ctx().getRequestHeaders(), 'X-Neconyan-Account': account } });
        const data = await response.json();
        if (account !== user.getCurrentUserHandle()) throw new Error('account_changed');
        if (!response.ok) throw Object.assign(new Error(data.error || 'Meower request failed.'), { status: response.status });
        return data;
    };
    const run = createMeowerJobClient({ request, ...jobs, account, uuid: () => ctx().uuidv4(), pendingStorage: localStorage,
        prepareInput: input => ({ ...input, acknowledgement: getSettings().profileId ? null : host.getActiveGenerationAcknowledgement() }) });
    return run(kind, input, options);
}

export async function hasRunningRefresh(sessionId) {
    const [{ listJobs }, { getCurrentUserHandle }] = await Promise.all([import('/scripts/jobs.js'), import('/scripts/user.js')]);
    return (await listJobs({ account: getCurrentUserHandle() })).some(job => job.type === 'meower.refresh'
        && job.target?.id === sessionId && ['queued', 'running', 'waiting'].includes(job.state));
}

export async function generatePersonaProfile(sessionId = ensureActiveSession().id, { signal } = {}) {
    const client = storage();
    const result = await runNativeJob('profile', { sessionId, mode: 'persona' }, { signal, onSnapshot: () => client.syncStore() });
    return result.profile;
}

export async function regenerateProfile(accountKey, sessionId = ensureActiveSession().id, { signal } = {}) {
    const client = storage();
    const result = await runNativeJob('profile', { sessionId, mode: 'character', accountKey }, { signal, onSnapshot: () => client.syncStore() });
    return result.profiles?.[accountKey] || null;
}

export async function regenerateAllProfiles(sessionId = ensureActiveSession().id, { signal } = {}) {
    const client = storage();
    const result = await runNativeJob('profile', { sessionId, mode: 'all' }, { signal, onSnapshot: () => client.syncStore() });
    return result.written;
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
    sessionId ??= ensureActiveSession().id;
    const client = storage();
    const seenPosts = new Set(feed.posts.map(post => post.id));
    const seenInteractions = new Set(feed.interactions.map(item => item.id));
    return runNativeJob('refresh', { sessionId, topic, scene: currentScene(getSettings()), localTime: new Date().toLocaleString() }, {
        signal,
        onSnapshot: async job => {
            await client.syncStore();
            const saved = await client.feed(sessionId);
            signal?.throwIfAborted();
            if (storage() !== client) throw new Error('account_changed');
            const posts = saved.posts.filter(post => !seenPosts.has(post.id));
            const interactions = saved.interactions.filter(item => !seenInteractions.has(item.id));
            posts.forEach(post => seenPosts.add(post.id));
            interactions.forEach(item => seenInteractions.add(item.id));
            Object.assign(feed, saved);
            onProgress(job.progress?.stage || job.stage || 'Working...');
            if (posts.length || interactions.length) {
                try { onPartial({ posts, interactions, follows: [], strangers: [], trends: [], warnings: [] }); }
                catch (error) { console.error('[Meower] saved activity could not be displayed', error); }
            }
        },
    });
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
