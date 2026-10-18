import {
    SETTINGS_KEY,
    STYLE_ELEMENT_ID,
    SYNC_STORAGE_KEY,
    buildStylesheet,
    groupActiveSnippets,
    mergeSyncedList,
    normalizeSettings,
    normalizeSnippet,
    parseSyncedList,
    toSnippetJson,
    upsertSynced,
    wasSynced,
} from './store.js';

const listeners = new Set();
const sanitizeCache = new Map();
const SANITIZE_CACHE_LIMIT = 200;

const THEME_SELECT_ID = 'themes';
// Silent programmatic theme setters can change power_user.theme without firing a
// control event or mutating a watched attribute. Keep a visible-only safety net
// at one tenth of the old 500ms poll instead of reading context on hidden pages.
const FALLBACK_WATCH_MS = 5000;
const SETTINGS_EVENT_KEYS = ['SETTINGS_LOADED_AFTER', 'EXTENSION_SETTINGS_LOADED', 'SETTINGS_LOADED'];

let loaded = false;
let contextObserver = null;
let contextCheckFrame = null;
let lastContextKey = null;
let chatHandler = null;
let wakeHandler = null;
let themeObserver = null;
let themeSelectElement = null;
let themeControlHandler = null;
let settingsHandlers = [];
let fallbackTimer = null;

export function getCtx() {
    return globalThis.SillyTavern.getContext();
}

export function tr(text) {
    return getCtx().translate?.(text) ?? text;
}

export function makeId() {
    const ctx = getCtx();
    if (typeof ctx.uuidv4 === 'function') {
        return ctx.uuidv4();
    }
    return globalThis.crypto?.randomUUID?.() ?? `csss-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getSettings() {
    const ctx = getCtx();
    const extensionSettings = ctx.extensionSettings;
    if (!extensionSettings[SETTINGS_KEY] || typeof extensionSettings[SETTINGS_KEY] !== 'object') {
        extensionSettings[SETTINGS_KEY] = {};
        loaded = false;
    }
    if (!loaded) {
        normalizeSettings(extensionSettings[SETTINGS_KEY], { makeId });
        loaded = true;
    }
    return extensionSettings[SETTINGS_KEY];
}

function readSynced() {
    try {
        return parseSyncedList(globalThis.localStorage?.getItem(SYNC_STORAGE_KEY));
    } catch {
        return [];
    }
}

function writeSynced(list) {
    try {
        globalThis.localStorage?.setItem(SYNC_STORAGE_KEY, JSON.stringify(list));
    } catch (error) {
        console.warn('[CSS Snippets] could not update the browser-shared list:', error);
    }
}

/**
 * Loads settings and pulls in snippets shared from other profiles in this browser.
 */
export function loadSettings() {
    loaded = false;
    const settings = getSettings();
    const { changed, touched } = mergeSyncedList(settings, readSynced(), { makeId });
    if (touched.length) {
        let synced = readSynced();
        for (const snippet of touched) {
            synced = upsertSynced(synced, snippet);
        }
        writeSynced(synced);
    }
    if (changed) {
        getCtx().saveSettingsDebounced();
    }
    return settings;
}

export function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function notify(reason) {
    for (const listener of [...listeners]) {
        try {
            listener(reason);
        } catch (error) {
            console.error('[CSS Snippets] listener failed:', error);
        }
    }
}

/**
 * Saves settings and reapplies styles without touching snippet timestamps.
 * @param {string} [reason]
 */
export function persist(reason = 'settings') {
    getCtx().saveSettingsDebounced();
    applyCss();
    notify(reason);
}

/**
 * Original `Snippet.save()`: stamp, share with this browser when shared, persist.
 * @param {object} snippet
 * @param {{ skipSync?: boolean, reason?: string }} [options]
 */
export function saveSnippet(snippet, { skipSync = false, reason = 'snippet' } = {}) {
    snippet.modifiedOn = Date.now();
    if (!skipSync) {
        const synced = readSynced();
        if (snippet.isSynced || wasSynced(synced, snippet)) {
            writeSynced(upsertSynced(synced, snippet));
        }
    }
    persist(reason);
}

/**
 * @param {{ name?: string, content?: string, disabled?: boolean, global?: boolean, theme?: boolean }} [options]
 */
export function createSnippet({ name = '', content = '', disabled = false, global = true, theme = false } = {}) {
    const settings = getSettings();
    const current = getCurrentContext();
    const snippet = normalizeSnippet({
        name,
        content,
        isDisabled: disabled,
        isGlobal: global,
        themeList: theme && current.theme ? [current.theme] : [],
    }, { makeId });
    settings.snippetList.push(snippet);
    saveSnippet(snippet, { reason: 'list' });
    return snippet;
}

export function deleteSnippet(snippet) {
    const settings = getSettings();
    const index = settings.snippetList.indexOf(snippet);
    if (index === -1) {
        return false;
    }
    snippet.isDeleted = true;
    settings.snippetList.splice(index, 1);
    saveSnippet(snippet, { reason: 'list' });
    return true;
}

/**
 * @param {object[]} incoming normalised snippets
 */
export function addSnippets(incoming) {
    const settings = getSettings();
    for (const snippet of incoming) {
        settings.snippetList.push(snippet);
        snippet.modifiedOn = Date.now();
        const synced = readSynced();
        if (snippet.isSynced) {
            writeSynced(upsertSynced(synced, snippet));
        }
    }
    persist('list');
}

export function exportSnippets(list) {
    return JSON.stringify(list.map(toSnippetJson), null, 4);
}

export function getCurrentContext() {
    const ctx = getCtx();
    const theme = ctx.powerUserSettings?.theme ?? '';
    const characterId = ctx.characterId;
    const groupId = ctx.groupId ?? null;
    const character = characterId !== undefined && characterId !== null && characterId !== ''
        ? ctx.characters?.[characterId]
        : undefined;
    const group = groupId !== null && groupId !== undefined
        ? ctx.groups?.find(item => String(item.id) === String(groupId))
        : undefined;
    const hasChat = Boolean(group || character?.avatar);
    return {
        theme: String(theme ?? ''),
        chat: {
            avatar: group ? null : (character?.avatar ?? null),
            groupId: group ? String(group.id) : null,
        },
        chatName: group?.name ?? character?.name ?? '',
        isGroup: Boolean(group),
        hasChat,
    };
}

function contextKey(current = getCurrentContext()) {
    return JSON.stringify([current.theme, current.chat.avatar, current.chat.groupId]);
}

function parseRules(css) {
    const probe = document.createElement('style');
    probe.textContent = css;
    probe.media = 'not all';
    document.head.append(probe);
    const sheet = probe.sheet;
    probe.remove();
    return Array.from(sheet?.cssRules ?? []);
}

/**
 * Original sanitise step: keep only the rules the browser can read.
 * @param {string} css
 */
export function sanitizeCss(css) {
    const source = String(css ?? '');
    if (sanitizeCache.has(source)) {
        return sanitizeCache.get(source);
    }
    const result = parseRules(source).map(rule => rule.cssText ?? '').join('\n');
    if (sanitizeCache.size >= SANITIZE_CACHE_LIMIT) {
        sanitizeCache.delete(sanitizeCache.keys().next().value);
    }
    sanitizeCache.set(source, result);
    return result;
}

/**
 * True when the snippet has text the browser could not turn into any rule.
 * @param {string} css
 */
export function hasNoReadableRules(css) {
    const withoutComments = String(css ?? '').replace(/\/\*[\s\S]*?(\*\/|$)/g, '').trim();
    return withoutComments.length > 0 && sanitizeCss(css).trim().length === 0;
}

export function getActiveSections() {
    return groupActiveSnippets(getSettings().snippetList, getCurrentContext());
}

export function applyCss() {
    let style = document.getElementById(STYLE_ELEMENT_ID);
    if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ELEMENT_ID;
        document.head.append(style);
    }
    style.textContent = buildStylesheet(getActiveSections(), sanitizeCss);
}

export function removeCss() {
    document.getElementById(STYLE_ELEMENT_ID)?.remove();
}

function checkContext() {
    const key = contextKey();
    if (key === lastContextKey) {
        return;
    }
    lastContextKey = key;
    applyCss();
    notify('context');
}

function scheduleContextCheck() {
    if (contextCheckFrame !== null) return;
    contextCheckFrame = requestAnimationFrame(() => {
        contextCheckFrame = null;
        if (document.visibilityState === 'hidden') return;
        checkContext();
    });
}

function installThemeObserver() {
    if (typeof MutationObserver !== 'function') return;
    const select = document.getElementById(THEME_SELECT_ID);
    if (!select || (themeObserver && themeSelectElement === select)) return;
    themeObserver?.disconnect();
    themeSelectElement = select;
    themeObserver = new MutationObserver(scheduleContextCheck);
    themeObserver.observe(select, { childList: true, subtree: true });
}

function handleThemeControl(event) {
    const target = event?.target;
    if (!target) return;
    if (target.id === THEME_SELECT_ID || target.closest?.(`#${THEME_SELECT_ID}`)) {
        installThemeObserver();
        // The host's own select handler writes power_user.theme after capture
        // listeners run, so read context on the next frame instead of too early.
        scheduleContextCheck();
    }
}

function refreshFromSettings(reason) {
    // SETTINGS_LOADED_AFTER arrives before extension_settings is replaced.
    // Reapply the current (old) list without merging or saving, then let the
    // final events below load the replacement. This avoids writing old
    // extension settings over the settings file that is still being loaded.
    if (reason === 'settings_loaded_after') {
        lastContextKey = contextKey();
        applyCss();
        notify(reason);
        return;
    }
    loaded = false;
    loadSettings();
    lastContextKey = contextKey();
    applyCss();
    notify(reason);
}

function startFallback() {
    if (fallbackTimer !== null || document.visibilityState !== 'visible') return;
    // Safety net for a silent setter that changes power_user.theme while the
    // theme select's selected option and the root CSS variables stay identical.
    // It exists only while the page is visible, so hidden pages do no polling.
    fallbackTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        installThemeObserver();
        checkContext();
    }, FALLBACK_WATCH_MS);
}

function stopFallback() {
    if (fallbackTimer === null) return;
    clearInterval(fallbackTimer);
    fallbackTimer = null;
}

export function startWatching() {
    stopWatching();
    lastContextKey = contextKey();
    const ctx = getCtx();
    chatHandler = () => checkContext();
    ctx.eventSource?.on?.(ctx.eventTypes.CHAT_CHANGED, chatHandler);
    ctx.eventSource?.on?.(ctx.eventTypes.SETTINGS_UPDATED, chatHandler);

    settingsHandlers = SETTINGS_EVENT_KEYS
        .map(key => ctx.eventTypes?.[key])
        .filter((name, index, list) => typeof name === 'string' && list.indexOf(name) === index)
        .map(name => {
            const handler = () => refreshFromSettings(name);
            ctx.eventSource?.on?.(name, handler);
            return [name, handler];
        });

    // Theme previews change the root CSS variables before the debounced
    // settings save fires, so watch the two elements themes actually mutate.
    if (typeof MutationObserver === 'function') {
        contextObserver = new MutationObserver(scheduleContextCheck);
        contextObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['style', 'class', 'data-theme', 'data-neconyan-ui-theme', 'data-neconyan-palette', 'data-neconyan-accent'],
        });
        if (document.body) {
            contextObserver.observe(document.body, {
                attributes: true,
                attributeFilter: ['class', 'data-theme', 'data-neconyan-ui-theme', 'data-neconyan-palette', 'data-neconyan-accent'],
            });
        }
    }

    installThemeObserver();
    themeControlHandler = handleThemeControl;
    document.addEventListener('change', themeControlHandler, true);
    document.addEventListener('input', themeControlHandler, true);

    startFallback();

    wakeHandler = () => {
        if (document.visibilityState !== 'visible') {
            stopFallback();
            return;
        }
        startFallback();
        installThemeObserver();
        checkContext();
    };
    document.addEventListener('visibilitychange', wakeHandler);
    window.addEventListener('focus', wakeHandler);
    window.addEventListener('pageshow', wakeHandler);
}

export function stopWatching() {
    if (contextObserver) {
        contextObserver.disconnect();
        contextObserver = null;
    }
    if (themeObserver) {
        themeObserver.disconnect();
        themeObserver = null;
    }
    themeSelectElement = null;
    if (contextCheckFrame !== null) {
        cancelAnimationFrame(contextCheckFrame);
        contextCheckFrame = null;
    }
    stopFallback();
    if (chatHandler) {
        const ctx = getCtx();
        ctx.eventSource?.removeListener?.(ctx.eventTypes.CHAT_CHANGED, chatHandler);
        ctx.eventSource?.removeListener?.(ctx.eventTypes.SETTINGS_UPDATED, chatHandler);
        chatHandler = null;
    }
    if (settingsHandlers.length) {
        const ctx = getCtx();
        for (const [name, handler] of settingsHandlers) {
            ctx.eventSource?.removeListener?.(name, handler);
        }
        settingsHandlers = [];
    }
    if (themeControlHandler) {
        document.removeEventListener('change', themeControlHandler, true);
        document.removeEventListener('input', themeControlHandler, true);
        themeControlHandler = null;
    }
    if (wakeHandler) {
        document.removeEventListener('visibilitychange', wakeHandler);
        window.removeEventListener('focus', wakeHandler);
        window.removeEventListener('pageshow', wakeHandler);
        wakeHandler = null;
    }
}

export function listThemeNames() {
    const options = document.querySelectorAll('#themes option');
    const names = Array.from(options, option => option.value).filter(Boolean);
    return [...new Set(names)];
}
