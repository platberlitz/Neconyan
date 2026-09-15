/**
 * Extension settings.
 *
 * Everything is re-clamped on read with the same discipline the server uses on
 * requests, so a hand-edited settings.json cannot inject an unknown source id or
 * an absurd page size. No secret is ever stored here. BotBooru credentials are
 * sent once to the server-side account route, and its bearer remains in server
 * memory rather than profile settings.
 *
 * The panel is built with createElement rather than from a template, so that
 * client/ contains no HTML parsing of any kind. The only HTML this extension
 * turns into DOM is a static template handed to Popup, which does the insertion
 * itself.
 */

import { SETTINGS_KEY, DOM_IDS, EXTENSION_NAME } from './constants.js';
import { FILTER_LIMITS, IMAGE_MODES, VERSION } from '../shared/schema.js';
import { el, setText } from './render.js';
import {
    AVAILABILITY,
    getAvailability,
    post,
} from './api.js';
import {
    getBotbooruAccount,
    getSaucepanAccount,
    loginBotbooruAccount,
    loginSaucepanAccount,
    logoutBotbooruAccount,
    logoutSaucepanAccount,
    refreshBotbooruAccount,
    refreshSaucepanAccount,
    setBotbooruNsfw,
    setSaucepanToken,
    subscribeBotbooruAccount,
    subscribeSaucepanAccount,
} from './account.js';
import { accountErrorMessage, NAMED_SEARCH_COPY } from './copy.js';

const PAGE_SIZES = [12, 24, 48];

const MAX_ENABLED_SOURCES = 64;
const MAX_SORTS = 64;
const MAX_SOURCE_OPTIONS = 64;
const settingsListeners = new Set();

const AVAILABLE_IMAGE_MODES = IMAGE_MODES;

const IMAGE_MODE_LABELS = {
    proxy: 'Through Neconyan server (image host sees the server IP)',
    direct: 'Direct from card site (image host sees the browser connection)',
    off: 'No thumbnails',
};

/** Sources above this tier are opt-in: they work, but are narrow or unreliable. */
export const DEFAULT_MAX_TIER = 2;

const DEFAULTS = Object.freeze({
    /** null means "whatever is tier <= DEFAULT_MAX_TIER"; an array is an explicit choice. */
    enabledSources: null,
    defaultSource: 'botbooru',
    sfwOnlyDefault: true,
    hideAiDefault: false,
    blurNsfw: true,
    // Avoid direct browser connections to image hosts by default.
    imageMode: 'proxy',
    resultsPerPage: 24,
    sortBySource: Object.freeze({}),
    showTrustPanel: true,
    /** The review screen is the product's trust step, so skipping it is an opt-in. */
    skipReview: false,
    /** Browser-direct fallback changes who sees the user's network address. */
    allowDirectRequests: false,
    /** Search terms can be sensitive, so persistence is an explicit opt-in. */
    saveQueryHistory: false,
    /** Most recent first. Search terms only — never a card name or a filter. */
    queryHistory: Object.freeze([]),
    /** Named searches require their own opt-in, independent of query history. */
    saveNamedSearches: false,
    namedSearches: Object.freeze([]),
    _v: 4,
});

/** Enough to be useful as a dropdown, few enough to stay scannable. */
export const MAX_QUERY_HISTORY = 20;

/** Search terms are user text, so they are capped like any other stored string. */
const MAX_QUERY_LENGTH = 128;
export const MAX_NAMED_SEARCHES = 20;
export const MAX_NAMED_SEARCH_NAME = 64;

// Keep persistence allowlists explicit: server-only adapter modules must not
// be imported by the browser. Regression tests check their declared choices.
const NAMED_SEARCH_SORTS = {
    botbooru: ['latest', 'curated', 'downloads', 'favorites', 'views', 'random'],
    chub: ['default', 'download_count', 'star_count', 'n_favorites', 'rating', 'trending', 'trending_downloads',
        'created_at', 'last_activity_at', 'newcomer', 'n_tokens', 'name', 'random'],
    pygmalion: ['approved_at', 'trending', 'stars', 'downloads', 'views', 'chatCount', 'createdAt',
        'updatedAt', 'token_count', 'display_name', 'random'],
    risurealm: ['recommended', 'download', 'newest', 'trending'],
    quillgen: ['default'],
    wyvern: ['default'],
    charactertavern: ['default'],
    jannyai: ['relevant', 'newest', 'oldest', 'tokens_desc', 'tokens_asc'],
    saucepan: ['default'],
};
const NAMED_SEARCH_FILTERS = {
    botbooru: {
        tags: 'tags', excludeTags: 'tags', writer: 'text', character: 'text', franchise: 'text',
        minTokens: 'number', maxTokens: 'number', uploadedAfter: 'date', uploadedBefore: 'date', ocOnly: 'boolean',
    },
    chub: { tags: 'tags', excludeTags: 'tags', creator: 'text', minTokens: 'number', maxTokens: 'number' },
};

function namedSearchText(value, limit) {
    if (typeof value !== 'string'
        || /[\x00-\x1f\x7f]|[a-z][a-z\d+.-]*:\s*[/\\]|\/\/|www\.|\b(?:https?|ftps?|file|data|javascript|mailto):|\bbearer\s+\S+/i.test(value)) {
        return null;
    }
    return value.trim().slice(0, limit);
}

function normalizeNamedSearch(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
    }
    const read = (key) => Object.hasOwn(entry, key) ? entry[key] : undefined;
    const name = namedSearchText(read('name'), MAX_NAMED_SEARCH_NAME);
    const query = namedSearchText(read('query') ?? '', MAX_QUERY_LENGTH);
    const source = read('source');
    if (!name || query === null || typeof source !== 'string'
        || (source !== '__all__' && !Object.hasOwn(NAMED_SEARCH_SORTS, source))) {
        return null;
    }

    const filters = {};
    const declared = Object.hasOwn(NAMED_SEARCH_FILTERS, source) ? NAMED_SEARCH_FILTERS[source] : {};
    for (const [key, type] of Object.entries(declared)) {
        if (!read('filters') || !Object.hasOwn(entry.filters, key)) {
            continue;
        }
        const value = entry.filters[key];
        if (type === 'tags' && Array.isArray(value)) {
            const tags = value.slice(0, FILTER_LIMITS.tagCount)
                .map((tag) => namedSearchText(tag, FILTER_LIMITS.tagLength)).filter(Boolean);
            if (tags.length > 0) {
                filters[key] = [...new Set(tags)];
            }
        } else if (type === 'text') {
            const text = namedSearchText(value, FILTER_LIMITS.textLength);
            if (text) {
                filters[key] = text;
            }
        } else if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
            filters[key] = Math.min(FILTER_LIMITS.numberMax, Math.max(FILTER_LIMITS.numberMin, Math.floor(value)));
        } else if (type === 'boolean' && typeof value === 'boolean') {
            filters[key] = value;
        } else if (type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
            const date = new Date(`${value}T00:00:00.000Z`);
            if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) {
                filters[key] = value;
            }
        }
    }

    const sorts = {};
    if (read('sorts') && typeof entry.sorts === 'object' && !Array.isArray(entry.sorts)) {
        for (const sourceId of Object.keys(NAMED_SEARCH_SORTS)) {
            if (Object.hasOwn(entry.sorts, sourceId) && NAMED_SEARCH_SORTS[sourceId].includes(entry.sorts[sourceId])) {
                sorts[sourceId] = entry.sorts[sourceId];
            }
        }
    }
    return {
        name, query, source, filters,
        sort: source !== '__all__' && NAMED_SEARCH_SORTS[source].includes(read('sort')) ? entry.sort : '',
        sorts,
        sfwOnly: read('sfwOnly') !== false,
        hideAi: read('hideAi') === true,
    };
}

function normalizeNamedSearches(entries) {
    const result = [];
    const names = new Set();
    for (const raw of Array.isArray(entries) ? entries.slice(0, MAX_NAMED_SEARCHES) : []) {
        const entry = normalizeNamedSearch(raw);
        if (entry && !names.has(entry.name.toLowerCase())) {
            names.add(entry.name.toLowerCase());
            result.push(entry);
        }
    }
    return result;
}

function context() {
    return globalThis.SillyTavern.getContext();
}

/**
 * Reads settings, repairing anything out of range, so no caller has to re-check.
 */
export function getSettings() {
    const ctx = context();
    const store = ctx.extensionSettings;
    const raw = store && typeof store === 'object' && Object.prototype.hasOwnProperty.call(store, SETTINGS_KEY)
        ? store[SETTINGS_KEY]
        : null;
    const settings = normalizeSettings(raw);

    // Purge legacy history and unsafe named-search records from the profile,
    // not just the returned view. Already-clean reads never schedule a save.
    let repair = false;
    for (const [flag, records] of [['saveQueryHistory', 'queryHistory'], ['saveNamedSearches', 'namedSearches']]) {
        if (raw && Object.hasOwn(raw, records)) {
            try {
                repair ||= raw[flag] !== settings[flag]
                    || JSON.stringify(raw[records]) !== JSON.stringify(settings[records]);
            } catch {
                repair = true;
            }
        }
    }
    if (repair) {
        store[SETTINGS_KEY] = settings;
        ctx.saveSettingsDebounced?.();
    }
    return settings;
}

function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const read = (key) => (Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined);

    const enabled = read('enabledSources');
    const rawSorts = read('sortBySource');
    const sortBySource = Object.create(null);
    if (rawSorts && typeof rawSorts === 'object' && !Array.isArray(rawSorts)) {
        let visited = 0;
        for (const sourceId in rawSorts) {
            if (!Object.prototype.hasOwnProperty.call(rawSorts, sourceId)) {
                continue;
            }
            if (visited++ >= MAX_SORTS) {
                break;
            }
            const sort = rawSorts[sourceId];
            if (/^[a-z0-9-]{1,64}$/.test(sourceId) && typeof sort === 'string') {
                sortBySource[sourceId] = sort.slice(0, 32);
            }
        }
    } else if (typeof read('sortDefault') === 'string') {
        // v1 stored one global sort. Preserve it for the source it belonged to.
        const sourceId = typeof read('defaultSource') === 'string'
            ? read('defaultSource').slice(0, 64)
            : DEFAULTS.defaultSource;
        if (/^[a-z0-9-]{1,64}$/.test(sourceId)) {
            sortBySource[sourceId] = read('sortDefault').slice(0, 32);
        }
    }

    return {
        enabledSources: normalizeSourceIds(enabled),
        defaultSource: typeof read('defaultSource') === 'string' ? read('defaultSource').slice(0, 64) : DEFAULTS.defaultSource,
        sfwOnlyDefault: read('sfwOnlyDefault') !== false,
        hideAiDefault: read('hideAiDefault') === true,
        blurNsfw: read('blurNsfw') !== false,
        imageMode: AVAILABLE_IMAGE_MODES.includes(read('imageMode')) ? read('imageMode') : DEFAULTS.imageMode,
        resultsPerPage: PAGE_SIZES.includes(read('resultsPerPage')) ? read('resultsPerPage') : DEFAULTS.resultsPerPage,
        sortBySource: { ...sortBySource },
        showTrustPanel: read('showTrustPanel') !== false,
        skipReview: read('skipReview') === true,
        allowDirectRequests: read('allowDirectRequests') === true,
        saveQueryHistory: read('saveQueryHistory') === true,
        queryHistory: read('saveQueryHistory') === true && Array.isArray(read('queryHistory'))
            ? read('queryHistory').slice(0, MAX_QUERY_HISTORY)
                .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
                .map((entry) => entry.slice(0, MAX_QUERY_LENGTH))
            : [],
        saveNamedSearches: read('saveNamedSearches') === true,
        namedSearches: read('saveNamedSearches') === true ? normalizeNamedSearches(read('namedSearches')) : [],
        _v: DEFAULTS._v,
    };
}

/**
 * Records a search term, most recent first, without duplicates.
 *
 * Only called for a search the user actually submitted, so the catalogue view
 * that runs on open never lands here and the list stays a record of what they
 * asked for rather than of what the dialog did.
 *
 * @param {string} query
 */
export function rememberQuery(query) {
    const settings = getSettings();
    if (!settings.saveQueryHistory) {
        return;
    }
    const trimmed = typeof query === 'string' ? query.trim().slice(0, MAX_QUERY_LENGTH) : '';
    if (trimmed === '') {
        return;
    }

    const previous = settings.queryHistory;
    // Case-insensitive dedupe, but the newest spelling is what gets kept.
    const rest = previous.filter((entry) => entry.toLowerCase() !== trimmed.toLowerCase());
    updateSettings({ queryHistory: [trimmed, ...rest].slice(0, MAX_QUERY_HISTORY) });
}

export function clearQueryHistory() {
    updateSettings({ queryHistory: [] });
}

/**
 * Saves newest first, replacing a case-insensitive name without evicting others.
 * Names are capped at 64 characters, queries at 128; an empty query is valid.
 * Source must be a bundled source id or '__all__'. Filters and sorts retain
 * only declared choices. Read the normalised record from getSettings().
 * @returns {boolean} False for opt-out, invalid input, or a full list with no matching name.
 */
export function saveNamedSearch(raw) {
    const settings = getSettings();
    const entry = normalizeNamedSearch(raw);
    if (!settings.saveNamedSearches || !entry) {
        return false;
    }
    const rest = settings.namedSearches.filter((saved) => saved.name.toLowerCase() !== entry.name.toLowerCase());
    if (rest.length >= MAX_NAMED_SEARCHES) {
        return false;
    }
    updateSettings({ namedSearches: [entry, ...rest] });
    return true;
}

/** Returns true only when an existing name was removed. */
export function removeNamedSearch(name) {
    const key = namedSearchText(name, MAX_NAMED_SEARCH_NAME)?.toLowerCase();
    const previous = getSettings().namedSearches;
    const namedSearches = previous.filter((entry) => entry.name.toLowerCase() !== key);
    if (namedSearches.length === previous.length) {
        return false;
    }
    updateSettings({ namedSearches });
    return true;
}

/** Immediately supplies current settings; the caller owns the unsubscribe. */
export function subscribeSettings(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }
    settingsListeners.add(listener);
    listener(getSettings());
    return () => settingsListeners.delete(listener);
}

/**
 * Whether a source should appear in the picker.
 *
 * With no explicit choice saved, tier decides: tiers 0-2 are sources with a
 * real catalogue and a stable API, tier 3 is everything narrow or fragile
 * enough that it should be asked for rather than assumed.
 *
 * @param {{ id: string, tier: number }} source
 * @param {string[] | null} enabledSources
 */
export function isSourceEnabled(source, enabledSources) {
    if (Array.isArray(enabledSources)) {
        return enabledSources.includes(source.id);
    }
    return typeof source.tier === 'number' && source.tier <= DEFAULT_MAX_TIER;
}

/**
 * @param {Partial<ReturnType<typeof getSettings>>} patch
 */
export function updateSettings(patch) {
    const ctx = context();
    const normalized = normalizeSettings({ ...normalizeSettings(ctx.extensionSettings[SETTINGS_KEY]), ...patch });
    ctx.extensionSettings[SETTINGS_KEY] = normalized;
    ctx.saveSettingsDebounced();
    for (const listener of settingsListeners) {
        listener(normalized);
    }
    return normalized;
}

/**
 * Mounts the settings drawer.
 *
 * Both the unique id and data-extension-name matter: Neconyan watches
 * #extensions_settings with a MutationObserver and silently removes any block
 * whose dedupe key collides with an existing one
 * (public/scripts/extensions.js:890-963).
 */
export async function mountSettings() {
    if (document.getElementById(DOM_IDS.settingsRoot)) {
        return;
    }

    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        return;
    }

    const container = el('div', 'extension_container');
    container.id = DOM_IDS.settingsRoot;
    container.dataset.extensionName = EXTENSION_NAME;

    const drawer = el('div', 'inline-drawer');
    const header = el('button', 'inline-drawer-toggle inline-drawer-header sbbs-settings-toggle');
    header.type = 'button';
    header.setAttribute('aria-expanded', 'false');
    header.setAttribute('aria-controls', 'sbbs_settings_content');
    header.append(el('b', undefined, 'BotSearcher'), el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));

    const content = el('div', 'inline-drawer-content sbbs-settings');
    content.id = 'sbbs_settings_content';
    const settings = getSettings();
    let sources = [];

    content.append(
        el('label', undefined, 'Preferences'),
        checkbox('sbbs_set_sfw', 'Request SFW results by default', settings.sfwOnlyDefault, (v) => updateSettings({ sfwOnlyDefault: v })),
        checkbox('sbbs_set_hide_ai', 'Hide AI-generated cards when the source supports it', settings.hideAiDefault, (v) => updateSettings({ hideAiDefault: v })),
        checkbox('sbbs_set_blur', 'Blur sensitive and unrated thumbnails until revealed', settings.blurNsfw, (v) => updateSettings({ blurNsfw: v })),
        checkbox('sbbs_set_trust', 'Show the Card contents panel', settings.showTrustPanel, (v) => updateSettings({ showTrustPanel: v })),
        checkbox(
            'sbbs_set_skip_review',
            'Import without the review screen',
            settings.skipReview,
            (v) => updateSettings({ skipReview: v }),
            'Import adds the card as soon as you choose it, without a report of its contents. If a character of the same name is already in your collection, the review screen still opens so you can choose to replace it or add a copy.',
        ),
        checkbox(
            'sbbs_set_direct',
            'Request a source from this browser when the server cannot reach it',
            settings.allowDirectRequests,
            (v) => updateSettings({ allowDirectRequests: v }),
            'Some sites refuse connections from servers but not from home connections. With this on, the site sees your browser’s address rather than the server’s. With it off, such a source stays in the list but cannot return results.',
        ),
        checkbox(
            'sbbs_set_history',
            'Save search history in Neconyan profile settings',
            settings.saveQueryHistory,
            (v) => updateSettings({ saveQueryHistory: v }),
            'Search terms can be sensitive. With this off, submitted terms are not added to history. Named searches have a separate opt-in.',
        ),
        checkbox(
            'sbbs_set_named_searches',
            NAMED_SEARCH_COPY.optIn,
            settings.saveNamedSearches,
            (v) => updateSettings({ saveNamedSearches: v }),
            NAMED_SEARCH_COPY.privacy,
        ),
        select(
            'sbbs_set_images',
            'Thumbnails',
            AVAILABLE_IMAGE_MODES.map((mode) => ({ value: mode, label: IMAGE_MODE_LABELS[mode] ?? mode })),
            settings.imageMode,
            (v) => updateSettings({ imageMode: v }),
        ),
        select(
            'sbbs_set_perpage',
            'Results per page',
            PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) })),
            String(settings.resultsPerPage),
            (v) => updateSettings({ resultsPerPage: Number(v) }),
        ),
        historyControl(),
        namedSearchesControl(),
    );

    drawer.append(header, content);
    container.append(drawer);
    host.append(container);

    const refreshControls = (value) => {
        for (const [id, key] of [
            ['sbbs_set_sfw', 'sfwOnlyDefault'], ['sbbs_set_hide_ai', 'hideAiDefault'],
            ['sbbs_set_blur', 'blurNsfw'], ['sbbs_set_trust', 'showTrustPanel'],
            ['sbbs_set_skip_review', 'skipReview'], ['sbbs_set_direct', 'allowDirectRequests'],
            ['sbbs_set_history', 'saveQueryHistory'], ['sbbs_set_named_searches', 'saveNamedSearches'],
        ]) {
            content.querySelector(`#${id}`).checked = value[key];
        }
        content.querySelector('#sbbs_set_images').value = value.imageMode;
        content.querySelector('#sbbs_set_perpage').value = String(value.resultsPerPage);
        for (const input of content.querySelectorAll('[data-source-id]')) {
            const source = sources.find((entry) => entry.id === input.dataset.sourceId);
            input.checked = isSourceEnabled(source, value.enabledSources);
        }
        const history = content.querySelector('#sbbs_clear_history');
        history.disabled = value.queryHistory.length === 0;
        setText(history, history.disabled ? 'No saved history' : `Clear search history (${value.queryHistory.length})`);
        const named = content.querySelector('#sbbs_clear_named_searches');
        named.disabled = value.namedSearches.length === 0;
        setText(named, named.disabled ? NAMED_SEARCH_COPY.empty : `${NAMED_SEARCH_COPY.clear} (${value.namedSearches.length})`);
    };
    const unsubscribeSettings = subscribeSettings(refreshControls);
    const refreshOnOpen = () => requestAnimationFrame(() => {
        if (container.isConnected) {
            header.setAttribute('aria-expanded', String(content.getClientRects().length > 0));
            refreshControls(getSettings());
        }
    });
    header.addEventListener('click', refreshOnOpen);
    refreshOnOpen();
    cleanupOnDetach(container, () => {
        unsubscribeSettings();
        header.removeEventListener('click', refreshOnOpen);
    });

    // Source list comes from the server, so it stays correct as adapters are
    // added. Appended after mounting so a missing plugin does not block the
    // rest of the panel.
    try {
        const availability = await getAvailability();
        if (!container.isConnected) {
            return;
        }
        const { health } = availability;
        sources = Array.isArray(health?.sources) ? health.sources.filter((source) => source && typeof source === 'object') : [];
        if (sources.length > 0) {
            content.append(sourceList(sources));
        }
        const botbooru = sources.find((source) => source?.id === 'botbooru');
        if (availability.status === AVAILABILITY.OK && botbooru?.capabilities?.accountLogin === true) {
            content.append(collapsedAccount(botbooruAccountControl()));
        }
        const saucepan = sources.find((source) => source?.id === 'saucepan');
        if (availability.status === AVAILABILITY.OK && saucepan?.capabilities?.accountLogin === true) {
            content.append(collapsedAccount(saucepanAccountControl()));
        }
        const janny = sources.find((source) => source?.id === 'jannyai');
        if (availability.status === AVAILABILITY.OK && janny?.capabilities?.browserImport === true) {
            content.append(collapsedAccount(jannyBrowserControl('sbbs_janny', health?.capabilities?.jannyBrowser)));
        }
        content.append(serverPluginControl(availability));
        refreshControls(getSettings());
    } catch {
        // Plugin not installed yet; the rest of the panel still works.
    }
}

function collapsedAccount(control) {
    const details = el('details', 'sbbs-account-details');
    const heading = control.firstElementChild;
    details.append(el('summary', undefined, heading.textContent), control);
    heading.hidden = true;
    return details;
}

// Only observe removal, never render from a DOM observer: rendering would
// trigger the observer again. Capture the owning document for late teardown.
function cleanupOnDetach(node, cleanup) {
    const ownerDocument = node.ownerDocument;
    requestAnimationFrame(() => {
        if (!node.isConnected) {
            cleanup();
            return;
        }
        const Observer = ownerDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
        if (typeof Observer !== 'function') {
            return;
        }
        const observer = new Observer(() => {
            if (!node.isConnected) {
                observer.disconnect();
                cleanup();
            }
        });
        observer.observe(ownerDocument.documentElement, { childList: true, subtree: true });
    });
}

/** The drawer and inline recovery share retained account state, not input ids. */
export function botbooruAccountControl(idPrefix = 'sbbs_botbooru') {
    const wrapper = el('section', 'sbbs-setting sbbs-setting-account');
    const heading = el('strong', undefined, 'BotBooru account');
    heading.id = `${idPrefix}_account_heading`;
    wrapper.setAttribute('aria-labelledby', heading.id);

    const status = el('span', 'sbbs-account-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const loginForm = el('form', 'sbbs-account-login');
    const fields = el('div', 'sbbs-account-fields');
    const usernameField = accountField(`${idPrefix}_username`, 'Username', 'text', 'username');
    const passwordField = accountField(`${idPrefix}_password`, 'Password', 'password', 'current-password');
    fields.append(usernameField.wrapper, passwordField.wrapper);

    const login = el('button', 'menu_button', 'Log in');
    login.type = 'submit';
    loginForm.append(fields, login);

    const sessionNote = el(
        'span',
        'sbbs-setting-note',
        'Your password is not retained. BotSearcher keeps the BotBooru bearer in server memory until logout or server restart.',
    );

    const signedIn = el('div', 'sbbs-account-signed-in');
    const nsfwRow = el('label', 'checkbox_label sbbs-account-nsfw');
    const nsfw = document.createElement('input');
    nsfw.type = 'checkbox';
    nsfw.id = `${idPrefix}_nsfw`;
    nsfwRow.append(nsfw, el('span', undefined, 'Allow NSFW results'));

    const nsfwNote = el(
        'span',
        'sbbs-setting-note',
        'This changes the BotBooru account preference on every device using that account.',
    );
    nsfwNote.id = `${idPrefix}_nsfw_note`;
    nsfw.setAttribute('aria-describedby', nsfwNote.id);

    const nsflStatus = el('span', 'sbbs-setting-note sbbs-account-nsfl');
    const logout = el('button', 'menu_button', 'Log out');
    logout.type = 'button';
    const logoutNote = el(
        'span',
        'sbbs-setting-note',
        'Logout removes BotSearcher\'s in-memory copy. BotBooru does not provide token revocation, so this does not revoke the token upstream.',
    );
    signedIn.append(nsfwRow, nsfwNote, nsflStatus, logout, logoutNote);

    wrapper.append(heading, status, loginForm, sessionNote, signedIn);

    let pending = false;
    let message = '';

    const render = (account) => {
        const loggedIn = account.loggedIn === true;
        loginForm.hidden = loggedIn;
        sessionNote.hidden = loggedIn;
        signedIn.hidden = !loggedIn;
        login.disabled = pending;
        usernameField.input.disabled = pending;
        passwordField.input.disabled = pending;
        nsfw.disabled = pending || !loggedIn;
        logout.disabled = pending;
        nsfw.checked = account.nsfwEnabled === true;

        if (message !== '') {
            setText(status, message);
        } else if (account.error) {
            setText(status, accountErrorMessage({ code: account.error }, 'BotBooru'));
        } else if (!account.known) {
            setText(status, 'Checking account...');
        } else if (loggedIn) {
            setText(status, `Logged in as ${account.username}.`);
        } else {
            setText(status, 'Not logged in. Login is required only for non-SFW BotBooru results.');
        }

        if (!loggedIn) {
            setText(nsflStatus, '');
        } else if (!account.nsflEnabled) {
            setText(nsflStatus, 'NSFL is disabled for this BotBooru account.');
        } else if (account.nsflActive === false) {
            setText(nsflStatus, 'NSFL is enabled on the account but currently paused in BotBooru.');
        } else if (account.nsflActive === null) {
            setText(nsflStatus, 'BotBooru did not report whether NSFL is active. Non-SFW searches may include NSFL content.');
        } else {
            setText(nsflStatus, 'NSFL is active for this account. Non-SFW searches may include NSFL content.');
        }
    };

    let renderedLoggedIn = null;
    const unsubscribeAccount = subscribeBotbooruAccount((account) => {
        const hadFocus = wrapper.contains(wrapper.ownerDocument.activeElement);
        const loginStateChanged = renderedLoggedIn !== null && renderedLoggedIn !== account.loggedIn;
        message = '';
        render(account);
        renderedLoggedIn = account.loggedIn;
        if (hadFocus && loginStateChanged) {
            requestAnimationFrame(() => {
                if (wrapper.isConnected) {
                    (account.loggedIn ? logout : usernameField.input).focus();
                }
            });
        }
    });

    // The host can rebuild extension settings without a page navigation. Stop
    // retaining detached inputs, and erase an unsent password if that happens.
    cleanupOnDetach(wrapper, () => {
        passwordField.input.value = '';
        unsubscribeAccount();
    });

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (pending) {
            return;
        }
        pending = true;
        message = 'Logging in to BotBooru...';
        render(getBotbooruAccount());
        try {
            await loginBotbooruAccount(usernameField.input.value, passwordField.input.value);
            message = '';
        } catch (error) {
            message = accountErrorMessage(error, 'BotBooru');
        } finally {
            passwordField.input.value = '';
            pending = false;
            if (wrapper.isConnected) {
                render(getBotbooruAccount());
            }
        }
    });

    nsfw.addEventListener('change', async () => {
        if (pending) {
            return;
        }
        const enabled = nsfw.checked;
        pending = true;
        message = 'Updating the BotBooru account...';
        render(getBotbooruAccount());
        try {
            await setBotbooruNsfw(enabled);
            message = '';
        } catch (error) {
            message = accountErrorMessage(error, 'BotBooru');
        } finally {
            pending = false;
            if (wrapper.isConnected) {
                render(getBotbooruAccount());
            }
        }
    });

    logout.addEventListener('click', async () => {
        if (pending) {
            return;
        }
        pending = true;
        message = 'Removing the BotBooru login...';
        render(getBotbooruAccount());
        try {
            await logoutBotbooruAccount();
            message = '';
        } catch (error) {
            message = accountErrorMessage(error, 'BotBooru');
        } finally {
            pending = false;
            if (wrapper.isConnected) {
                render(getBotbooruAccount());
            }
        }
    });

    void refreshBotbooruAccount().catch((error) => {
        message = accountErrorMessage(error, 'BotBooru');
        if (wrapper.isConnected) {
            render(getBotbooruAccount());
        }
    });

    return wrapper;
}

/**
 * The Saucepan.ai login section.
 *
 * Also embedded in the intake error screen when an import needs a login, so
 * `idPrefix` keeps its input ids unique when the drawer copy exists too.
 */
export function saucepanAccountControl(idPrefix = 'sbbs_saucepan') {
    const wrapper = el('section', 'sbbs-setting sbbs-setting-account');
    const heading = el('strong', undefined, 'Saucepan.ai account');
    heading.id = `${idPrefix}_account_heading`;
    wrapper.setAttribute('aria-labelledby', heading.id);

    const status = el('span', 'sbbs-account-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const loginForm = el('form', 'sbbs-account-login');
    const handleField = accountField(`${idPrefix}_handle`, 'Handle', 'text', 'username');
    const passwordField = accountField(`${idPrefix}_password`, 'Password', 'password', 'current-password');
    const login = el('button', 'menu_button', 'Log in');
    login.type = 'submit';
    const fields = el('div', 'sbbs-account-fields');
    fields.append(handleField.wrapper, passwordField.wrapper);
    loginForm.append(fields, login);

    const tokenForm = el('div', 'sbbs-account-login');
    const tokenField = accountField(`${idPrefix}_token`, 'Bearer token', 'password', 'off');
    tokenField.input.maxLength = 8192;
    const setToken = el('button', 'menu_button', 'Use token');
    setToken.type = 'button';
    const tokenFields = el('div', 'sbbs-account-fields');
    tokenFields.append(tokenField.wrapper, setToken);
    tokenForm.append(tokenFields);

    const logout = el('button', 'menu_button', 'Log out');
    logout.type = 'button';
    const note = el(
        'span',
        'sbbs-setting-note',
        'The password and token are not stored in extension settings. The bearer stays in server memory until logout or restart.',
    );
    const catalogNote = el(
        'span',
        'sbbs-setting-note',
        'Saucepan.ai has no catalog search. Paste a companion URL into BotSearcher\'s search box to review and import it.',
    );
    // Someone reading this inside the import flow has already found the paste
    // gesture; the how-to note is for the drawer only.
    catalogNote.hidden = idPrefix !== 'sbbs_saucepan';
    wrapper.append(heading, catalogNote, status, loginForm, tokenForm, note, logout);

    let pending = false;
    let message = '';

    const render = (account) => {
        const loggedIn = account.loggedIn === true;
        setText(status, message || (account.error ? accountErrorMessage({ code: account.error }, 'Saucepan.ai')
            : !account.known ? 'Checking the Saucepan.ai account...'
                : loggedIn ? 'Saucepan.ai is ready for URL imports.'
                    : 'Not logged in. Saucepan.ai card URLs require an account token.'));
        login.disabled = pending;
        setToken.disabled = pending;
        logout.disabled = pending || !loggedIn;
        handleField.input.disabled = pending;
        passwordField.input.disabled = pending;
        tokenField.input.disabled = pending;
    };

    const unsubscribeAccount = subscribeSaucepanAccount((account) => {
        message = '';
        render(account);
    });
    cleanupOnDetach(wrapper, () => {
        passwordField.input.value = '';
        tokenField.input.value = '';
        unsubscribeAccount();
    });

    const run = async (operation, busyMessage) => {
        if (pending) {
            return;
        }
        pending = true;
        message = busyMessage;
        render(getSaucepanAccount());
        try {
            await operation();
            message = '';
        } catch (error) {
            message = accountErrorMessage(error, 'Saucepan.ai');
        } finally {
            passwordField.input.value = '';
            tokenField.input.value = '';
            pending = false;
            if (wrapper.isConnected) {
                render(getSaucepanAccount());
            }
        }
    };

    loginForm.addEventListener('submit', (event) => {
        event.preventDefault();
        void run(
            () => loginSaucepanAccount(handleField.input.value, passwordField.input.value),
            'Logging in to Saucepan.ai...',
        );
    });
    setToken.addEventListener('click', () => void run(
        () => setSaucepanToken(tokenField.input.value),
        'Saving the Saucepan.ai token in server memory...',
    ));
    logout.addEventListener('click', () => void run(
        () => logoutSaucepanAccount(),
        'Removing the Saucepan.ai login...',
    ));

    void refreshSaucepanAccount().catch((error) => {
        message = accountErrorMessage(error, 'Saucepan.ai');
        if (wrapper.isConnected) {
            render(getSaucepanAccount());
        }
    });
    return wrapper;
}

/**
 * The JannyAI browser-bridge section; also embedded in the intake error screen
 * when a bridge import needs its login finished.
 */
export function jannyBrowserControl(idPrefix = 'sbbs_janny', capability = null) {
    const wrapper = el('section', 'sbbs-setting sbbs-setting-account');
    const heading = el('strong', undefined, 'JannyAI browser import');
    heading.id = `${idPrefix}_browser_heading`;
    wrapper.setAttribute('aria-labelledby', heading.id);
    const status = el('span', 'sbbs-account-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const login = el('button', 'menu_button', 'Open JannyAI login window');
    login.type = 'button';
    const refresh = el('button', 'menu_button', 'Refresh status');
    refresh.type = 'button';
    const logout = el('button', 'menu_button', 'Log out');
    logout.type = 'button';
    const note = el(
        'span',
        'sbbs-setting-note',
        'Only Neconyan administrators can use this shared browser session. It opens a persistent, visible Playwright browser on the Neconyan host. Complete JanitorAI login and Cloudflare verification there; cookies stay on that host.',
    );
    const recoveryNote = el(
        'span',
        'sbbs-setting-note',
        'Refresh status retries restoring the JanitorAI settings. If the window is closed, reopen it, sign in to the same JanitorAI account, then refresh status. The recovery copy exists only in server memory. Do not restart Neconyan until recovery succeeds. If a restart is unavoidable, manually restore the API and generation settings in JanitorAI before another private import.',
    );
    wrapper.append(heading, status, login, refresh, logout, note, recoveryNote);

    let pending = false;
    let forbidden = false;
    let value = {};
    let message = '';
    const capabilityUnavailable = capability?.available === false;
    const render = () => {
        if (capabilityUnavailable) {
            setText(status, 'Optional JannyAI browser bridge is unavailable on this host. Install Playwright and Chromium to enable it.');
        } else if (message) {
            setText(status, message);
        } else if (value.restorePending) {
            setText(status, accountErrorMessage({ code: 'janny_restore_failed' }, 'JannyAI'));
        } else if (value.loggedIn === true) {
            setText(status, 'JannyAI browser session is ready.');
        } else if (value.ready === false) {
            setText(status, 'The JannyAI browser window is not open. Open the login window to continue.');
        } else {
            setText(status, 'Not logged in to JannyAI.');
        }
        login.disabled = capabilityUnavailable || pending || forbidden;
        refresh.disabled = capabilityUnavailable || pending || forbidden;
        logout.disabled = capabilityUnavailable || pending || forbidden || value.loggedIn !== true;
        recoveryNote.hidden = !value.restorePending;
    };

    const request = async (path, busyMessage) => {
        if (capabilityUnavailable || pending || forbidden) {
            return;
        }
        pending = true;
        message = busyMessage;
        render();
        try {
            const result = await post(path, {});
            value = {
                ready: result?.ready,
                loggedIn: result?.loggedIn === true,
                restorePending: result?.restorePending === true || result?.code === 'janny_restore_failed',
            };
            forbidden = result?.code === 'janny_admin_required';
            message = result?.code ? accountErrorMessage({ code: result.code }, 'JannyAI')
                : path === '/janny/logout' && !value.loggedIn && !value.restorePending ? 'Not logged in to JannyAI.' : '';
        } catch (error) {
            if (error?.code === 'janny_restore_failed') {
                value.restorePending = true;
            }
            forbidden = error?.code === 'janny_admin_required' || error?.status === 403;
            message = accountErrorMessage(forbidden ? { code: 'janny_admin_required' } : error, 'JannyAI');
        } finally {
            pending = false;
            if (wrapper.isConnected) {
                render();
            }
        }
    };

    login.addEventListener('click', () => void request('/janny/login', 'Opening the JannyAI browser window...'));
    refresh.addEventListener('click', () => void request('/janny/status', 'Checking the JannyAI browser session...'));
    logout.addEventListener('click', () => void request('/janny/logout', 'Clearing the JannyAI browser session...'));
    if (!capabilityUnavailable) {
        void request('/janny/status', 'Checking the JannyAI browser session...');
    }
    return wrapper;
}

function accountField(id, label, type, autocomplete) {
    const wrapper = el('div', 'sbbs-account-field');
    const caption = el('label', undefined, label);
    caption.htmlFor = id;
    const input = document.createElement('input');
    input.id = id;
    input.className = 'text_pole';
    input.type = type;
    input.autocomplete = autocomplete;
    input.required = true;
    input.maxLength = type === 'password' ? 1024 : 64;
    wrapper.append(caption, input);
    return { wrapper, input };
}

function serverPluginControl(availability) {
    const wrapper = el('div', 'sbbs-setting sbbs-setting-plugin');
    wrapper.append(el('label', undefined, 'Native server service'));

    const status = el('span', 'sbbs-setting-note');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    wrapper.append(status);

    if (availability.status === AVAILABILITY.MISSING) {
        setText(status, 'The Neconyan BotSearcher service is unavailable. Restart Neconyan and check its server log if this continues.');
        return wrapper;
    }
    if (availability.status === AVAILABILITY.ERROR) {
        setText(status, 'The native BotSearcher service could not be reached. Restart Neconyan and try again.');
        return wrapper;
    }
    if (availability.status !== AVAILABILITY.OK) {
        setText(status, 'The native BotSearcher service needs a matching Neconyan update. Restart Neconyan after updating.');
        return wrapper;
    }
    const version = typeof availability.health?.version === 'string' ? availability.health.version : VERSION;
    setText(status, `Included with Neconyan · native service v${version}. Updates arrive with Neconyan.`);
    return wrapper;
}

/**
 * Checkbox per source. Ticking any one switches from "tier default" to an
 * explicit list, so a new adapter never silently turns itself on for someone
 * who has already curated their sources.
 */
function sourceList(sources) {
    const wrapper = el('div', 'sbbs-setting sbbs-setting-sources');
    wrapper.append(el('label', undefined, 'Sources'));

    const settings = getSettings();

    for (const source of sources.slice(0, MAX_SOURCE_OPTIONS)) {
        if (!source || typeof source !== 'object' || !/^[a-z0-9-]{1,64}$/.test(source.id)) {
            continue;
        }
        const enabled = isSourceEnabled(source, settings.enabledSources);
        const row = el('label', 'checkbox_label sbbs-source-row');

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = enabled;
        input.dataset.sourceId = source.id;

        input.addEventListener('change', () => {
            const chosen = [...wrapper.querySelectorAll('input[type=checkbox]')]
                .filter((box) => box.checked)
                .map((box) => box.dataset.sourceId);
            updateSettings({ enabledSources: chosen });
        });

        row.append(input, el('span', undefined, source.label ?? source.id));

        if (source.capabilities?.search !== true && source.capabilities?.urlImport === true) {
            row.append(el('small', 'sbbs-source-note', 'URL import only, no catalog search'));
        } else if (source.tier > DEFAULT_MAX_TIER) {
            row.append(el('small', 'sbbs-source-note', 'limited public catalog'));
        }
        if (source.state === 'down') {
            row.append(el('small', 'sbbs-source-note', 'unavailable'));
        }

        wrapper.append(row);
    }

    return wrapper;
}

/**
 * Search history, with a way to get rid of it.
 *
 * Search terms are kept so the query box can offer them again. They are also a
 * record of what someone looked for on adult catalogues, sitting in a settings
 * file, so clearing them has to be one visible click rather than an edit.
 */
function historyControl() {
    const wrapper = el('div', 'sbbs-setting sbbs-setting-select');

    const caption = el('label', undefined, 'Search history');
    wrapper.append(caption);

    const button = el('button', 'menu_button');
    button.id = 'sbbs_clear_history';
    button.type = 'button';
    button.addEventListener('click', clearQueryHistory);

    wrapper.append(button);
    wrapper.append(el(
        'span',
        'sbbs-setting-note',
        'Saved terms are stored in your Neconyan profile settings and may be included in server backups. Card names are not saved.',
    ));
    return wrapper;
}

function namedSearchesControl() {
    const wrapper = el('div', 'sbbs-setting sbbs-setting-select');
    const button = el('button', 'menu_button');
    button.id = 'sbbs_clear_named_searches';
    button.type = 'button';
    button.addEventListener('click', () => updateSettings({ namedSearches: [] }));
    wrapper.append(el('label', undefined, NAMED_SEARCH_COPY.title), button);
    return wrapper;
}

function normalizeSourceIds(value) {
    if (!Array.isArray(value)) {
        return null;
    }

    const seen = new Set();
    const ids = [];
    for (const id of value.slice(0, MAX_ENABLED_SOURCES)) {
        if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id) || seen.has(id)) {
            continue;
        }
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

function checkbox(id, label, checked, onChange, note) {
    const control = el('label', 'checkbox_label sbbs-setting');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked === true;
    input.addEventListener('change', () => onChange(input.checked));
    control.append(input, el('span', undefined, label));

    if (!note) {
        return control;
    }

    // A setting that changes where a request comes from needs the consequence
    // written down next to it, not left to the label.
    //
    // The note goes OUTSIDE the label. Neconyan's .checkbox_label is a flex
    // row with no flex-wrap (public/style.css:5160), so a full-width child
    // inside it cannot wrap onto its own line — it takes the width and squeezes
    // the label text down to one character per line instead.
    const hint = el('span', 'sbbs-setting-note', note);
    hint.id = `${id}_note`;
    input.setAttribute('aria-describedby', hint.id);

    control.classList.remove('sbbs-setting');
    const wrapper = el('div', 'sbbs-setting sbbs-setting-noted');
    wrapper.append(control, hint);
    return wrapper;
}

function select(id, label, options, value, onChange) {
    const wrapper = el('div', 'sbbs-setting sbbs-setting-select');
    const caption = el('label', undefined, label);
    caption.htmlFor = id;

    const input = document.createElement('select');
    input.id = id;
    input.className = 'text_pole';

    for (const option of options) {
        const node = document.createElement('option');
        node.value = option.value;
        setText(node, option.label);
        input.append(node);
    }

    input.value = value;
    input.addEventListener('change', () => onChange(input.value));

    wrapper.append(caption, input);
    return wrapper;
}
