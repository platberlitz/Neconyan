import { isTrueBoolean } from '../../../macro-primitives.js';

// Storage names match LenAnderson's SillyTavern-CssSnippets so existing
// snippets, browser-shared copies and the live style element carry over.
export const SETTINGS_KEY = 'cssSnippets';
export const SYNC_STORAGE_KEY = 'csss--syncedList';
export const STYLE_ELEMENT_ID = 'csss--css-snippets';
export const DEFAULT_WATCH_INTERVAL = 500;
export const FILTER_KEYS = Object.freeze(['disabled', 'theme', 'thisTheme', 'global']);
export const SEARCH_FIELDS = Object.freeze(['name', 'title', 'content', 'css', 'theme']);

const SECTION_HEADERS = Object.freeze({
    global: 'GLOBAL SNIPPETS',
    theme: 'THEME SNIPPETS',
    chat: 'CHAR SNIPPETS',
});

function asStringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter(item => typeof item === 'string' && item.length > 0);
}

function asBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

/**
 * Mirrors the original `isTrueFlag`: a bare named flag (`quiet=`) counts as true.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTrueFlag(value) {
    return isTrueBoolean(String((value ?? 'false') || 'true'));
}

/**
 * Reads a boolean slash-command argument with a default.
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function readBooleanArgument(value, fallback) {
    if (value === undefined || value === null) {
        return fallback;
    }
    return isTrueBoolean(String(value));
}

/**
 * Builds a snippet in the original JSON shape, migrating old fields.
 * @param {object} raw
 * @param {{ makeId: () => string, themeSnippets?: Record<string, string[]> }} options
 */
export function normalizeSnippet(raw, { makeId, themeSnippets = {} }) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const name = typeof source.name === 'string' ? source.name : '';
    const isCollapsed = source.isCollapsed ?? source.isCollapsedd;
    let themeList = source.themeList;
    if (themeList === undefined) {
        themeList = Object.keys(themeSnippets ?? {})
            .filter(theme => Array.isArray(themeSnippets[theme]) && themeSnippets[theme].includes(name));
    }
    return {
        id: typeof source.id === 'string' && source.id ? source.id : makeId(),
        name,
        isDisabled: asBoolean(source.isDisabled, false),
        isGlobal: asBoolean(source.isGlobal, true),
        content: typeof source.content === 'string' ? source.content : '',
        isCollapsed: asBoolean(isCollapsed, false),
        isSynced: asBoolean(source.isSynced, false),
        isDeleted: asBoolean(source.isDeleted, false),
        modifiedOn: Number.isFinite(source.modifiedOn) ? source.modifiedOn : 0,
        themeList: asStringList(themeList),
        charList: asStringList(source.charList),
        groupList: asStringList(source.groupList),
    };
}

/**
 * Normalises `extension_settings.cssSnippets` in place so the saved object
 * stays the one SillyTavern serialises.
 * @param {object} settings
 * @param {{ makeId: () => string }} options
 */
export function normalizeSettings(settings, { makeId }) {
    const target = settings && typeof settings === 'object' ? settings : {};
    const themeSnippets = target.themeSnippets && typeof target.themeSnippets === 'object' && !Array.isArray(target.themeSnippets)
        ? target.themeSnippets
        : {};
    const filters = target.filters && typeof target.filters === 'object' ? target.filters : {};
    target.watchInterval = Number.isFinite(target.watchInterval) && target.watchInterval > 0
        ? target.watchInterval
        : DEFAULT_WATCH_INTERVAL;
    target.themeSnippets = themeSnippets;
    target.filters = Object.fromEntries(FILTER_KEYS.map(key => [key, filters[key] === true]));
    const seen = new Set();
    target.snippetList = (Array.isArray(target.snippetList) ? target.snippetList : [])
        .map(snippet => normalizeSnippet(snippet, { makeId, themeSnippets }))
        .map(snippet => {
            if (seen.has(snippet.id)) {
                snippet.id = makeId();
                snippet.isSynced = false;
            }
            seen.add(snippet.id);
            return snippet;
        });
    return target;
}

/**
 * Parses the browser-shared list stored in localStorage.
 * @param {string|null|undefined} text
 * @returns {object[]}
 */
export function parseSyncedList(text) {
    if (!text) {
        return [];
    }
    try {
        const list = JSON.parse(text);
        return Array.isArray(list) ? list.filter(item => item && typeof item === 'object' && typeof item.id === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * Replaces or appends one snippet in the browser-shared list.
 * @param {object[]} syncedList
 * @param {object} snippet
 * @returns {object[]}
 */
export function upsertSynced(syncedList, snippet) {
    const copy = toSnippetJson(snippet);
    const index = syncedList.findIndex(item => item.id === copy.id);
    const next = syncedList.slice();
    if (index === -1) {
        next.push(copy);
    } else {
        next[index] = copy;
    }
    return next;
}

/**
 * True when the snippet is currently shared with other profiles in this browser.
 * @param {object[]} syncedList
 * @param {object} snippet
 */
export function wasSynced(syncedList, snippet) {
    return syncedList.some(item => item.id === snippet.id && item.isSynced);
}

/**
 * Applies browser-shared copies to the local list using the original rules.
 * @param {object} settings normalised settings
 * @param {object[]} syncedList
 * @param {{ makeId: () => string }} options
 * @returns {{ changed: boolean, touched: object[] }} touched snippets need their shared copy refreshed
 */
export function mergeSyncedList(settings, syncedList, { makeId }) {
    let changed = false;
    const touched = [];
    for (const shared of syncedList) {
        const snippet = settings.snippetList.find(item => item.id === shared.id);
        if (snippet) {
            if (!shared.isSynced) {
                if (snippet.isSynced) {
                    snippet.isSynced = false;
                    changed = true;
                }
                continue;
            }
            if ((snippet.modifiedOn ?? 0) < (shared.modifiedOn ?? 0)) {
                if (shared.isDeleted) {
                    settings.snippetList.splice(settings.snippetList.indexOf(snippet), 1);
                } else {
                    Object.assign(snippet, normalizeSnippet({ ...snippet, ...shared }, { makeId, themeSnippets: settings.themeSnippets }));
                }
                changed = true;
            }
        } else if (shared.isSynced && !shared.isDeleted) {
            const added = normalizeSnippet(shared, { makeId, themeSnippets: settings.themeSnippets });
            settings.snippetList.push(added);
            touched.push(added);
            changed = true;
        }
    }
    return { changed, touched };
}

/**
 * The exported and stored JSON shape, with no runtime-only fields.
 * @param {object} snippet
 */
export function toSnippetJson(snippet) {
    return {
        id: snippet.id,
        name: snippet.name,
        isDisabled: snippet.isDisabled,
        isGlobal: snippet.isGlobal,
        content: snippet.content,
        isCollapsed: snippet.isCollapsed,
        isSynced: snippet.isSynced,
        isDeleted: snippet.isDeleted,
        modifiedOn: snippet.modifiedOn,
        themeList: [...(snippet.themeList ?? [])],
        charList: [...(snippet.charList ?? [])],
        groupList: [...(snippet.groupList ?? [])],
    };
}

/**
 * @param {object} snippet
 * @param {string} theme
 */
export function isForTheme(snippet, theme) {
    return Boolean(theme) && snippet.themeList.includes(theme);
}

/**
 * @param {object} snippet
 * @param {{ avatar?: string|null, groupId?: string|null }} chat
 */
export function isForChat(snippet, chat) {
    return (Boolean(chat?.avatar) && snippet.charList.includes(chat.avatar))
        || (chat?.groupId !== undefined && chat?.groupId !== null && snippet.groupList.includes(String(chat.groupId)));
}

/**
 * Splits enabled snippets into the original three sections.
 * @param {object[]} snippets
 * @param {{ theme: string, chat: { avatar?: string|null, groupId?: string|null } }} current
 */
export function groupActiveSnippets(snippets, { theme, chat }) {
    const used = new Set();
    const take = predicate => snippets.filter(snippet => {
        if (used.has(snippet) || snippet.isDisabled || !predicate(snippet)) {
            return false;
        }
        used.add(snippet);
        return true;
    });
    const global = take(snippet => snippet.isGlobal);
    const themed = take(snippet => isForTheme(snippet, theme)
        && (isForChat(snippet, chat) || snippet.charList.length + snippet.groupList.length === 0));
    const chatOnly = take(snippet => isForChat(snippet, chat)
        && (isForTheme(snippet, theme) || snippet.themeList.length === 0));
    return { global, theme: themed, chat: chatOnly };
}

/**
 * Builds the text of the live style element. Each snippet is cleaned on its
 * own so one unclosed brace cannot swallow the snippets after it.
 * @param {{ global: object[], theme: object[], chat: object[] }} sections
 * @param {(css: string) => string} sanitize
 */
export function buildStylesheet(sections, sanitize = css => css) {
    return Object.entries(SECTION_HEADERS).map(([key, title]) => {
        const body = (sections[key] ?? [])
            .map(snippet => `/* SNIPPET: ${String(snippet.name).replaceAll('*/', '* /')} */\n${sanitize(snippet.content)}`)
            .join('\n\n');
        return ['/*', ` * === ${title} ===`, ' */', body].join('\n');
    }).join('\n\n\n\n\n');
}

/**
 * Original search: `all:`, `name:`/`title:`, `content:`/`css:` and `theme:`
 * prefixes, case-insensitive regular expressions, plain text when the
 * expression is invalid.
 * @param {object} snippet
 * @param {string} rawQuery
 */
export function matchesSearch(snippet, rawQuery) {
    const value = String(rawQuery ?? '').trim();
    if (!value) {
        return true;
    }
    let fields = SEARCH_FIELDS;
    let query = value;
    const match = /^([a-z]+):(.*)$/is.exec(value);
    if (match) {
        const prefix = match[1].toLowerCase();
        if (prefix === 'all') {
            query = match[2].trim();
        } else if (SEARCH_FIELDS.includes(prefix)) {
            fields = [prefix];
            query = match[2].trim();
        }
    }
    if (!query) {
        return true;
    }
    let pattern;
    try {
        pattern = new RegExp(query, 'i');
    } catch {
        pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const values = {
        name: snippet.name,
        title: snippet.name,
        content: snippet.content,
        css: snippet.content,
        theme: snippet.themeList.join(';'),
    };
    return fields.some(field => pattern.test(values[field] ?? ''));
}

/**
 * Original filter rules.
 * @param {object} snippet
 * @param {Record<string, boolean>} filters
 * @param {string} theme
 */
export function isFilteredOut(snippet, filters, theme) {
    const forTheme = isForTheme(snippet, theme);
    return (filters.disabled && snippet.isDisabled)
        || (filters.theme && !forTheme && snippet.themeList.length > 0)
        || (filters.global && snippet.isGlobal)
        || (filters.thisTheme && forTheme);
}

/**
 * Accepts the exported JSON array (or one snippet object); anything else is
 * treated as plain CSS and becomes one unnamed snippet.
 * @param {string} text
 * @param {{ makeId: () => string, now?: number }} options
 * @returns {object[]}
 */
export function parseImport(text, { makeId, now = Date.now() }) {
    const source = String(text ?? '');
    if (!source.trim()) {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch {
        parsed = undefined;
    }
    const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : null);
    if (list && list.every(item => item && typeof item === 'object' && typeof item.content === 'string')) {
        return list.map(item => normalizeSnippet({ ...item, isDeleted: false }, { makeId }));
    }
    return [normalizeSnippet({ content: source, modifiedOn: now }, { makeId })];
}

/**
 * Gives imported snippets fresh ids when the id is already taken.
 * @param {object[]} existing
 * @param {object[]} incoming
 * @param {() => string} makeId
 */
export function dedupeImportedIds(existing, incoming, makeId) {
    const ids = new Set(existing.map(snippet => snippet.id));
    return incoming.map(snippet => {
        if (!ids.has(snippet.id)) {
            ids.add(snippet.id);
            return snippet;
        }
        const id = makeId();
        ids.add(id);
        return { ...snippet, id, isSynced: false };
    });
}

/**
 * @param {object[]} list
 * @param {string} name
 * @param {{ caseInsensitive?: boolean }} [options]
 */
export function findSnippetByName(list, name, { caseInsensitive = false } = {}) {
    const wanted = String(name ?? '');
    if (caseInsensitive) {
        const lower = wanted.toLowerCase();
        return list.find(snippet => snippet.name.toLowerCase() === lower);
    }
    return list.find(snippet => snippet.name === wanted);
}

/**
 * @param {string} [date] ISO timestamp
 */
export function exportFileName(date = new Date().toISOString()) {
    return `SillyTavern-CSS-Snippets-${date}.json`;
}
