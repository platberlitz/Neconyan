/**
 * The browse dialog.
 *
 * One Popup holds both views, switched by `data-view` on `.sbbs-root`; there is
 * no second popup and no history stack. Popup supplies the focus trap, the
 * backdrop and Esc handling.
 *
 * Grid cards are built with createElement and setText. The link between a card
 * element and its record is a Map, not a data-* attribute, so no untrusted
 * string is ever serialized into the DOM and parsed back out.
 */

import { EXTENSION_PATH, LOG_TAG } from './constants.js';
import {
    AVAILABILITY,
    getAvailability,
    invalidateAvailability,
    post,
    postRouted,
    thumbSrc,
} from './api.js';
import { el, setText, setImgSafe } from './render.js';
import {
    getSettings, updateSettings, isSourceEnabled, rememberQuery,
    saveNamedSearch, removeNamedSearch, subscribeSettings, MAX_NAMED_SEARCH_NAME,
    jannyBrowserControl,
} from './settings.js';
import { createResultCache } from './cache.js';
import { showDetail } from './detail.js';
import { showBulkImport, showIntake } from './intake.js';
import {
    availabilityCopy,
    directRoutingNotice,
    emptyResultMessage,
    formatCount,
    formatResultCount,
    JANNY_CLOUDFLARE_HINT_TITLE,
    jannyCloudflareHint,
    NAMED_SEARCH_COPY,
    searchErrorMessage,
    searchUnavailableMessage,
    sortLabel,
    sourceStatLine,
    unreachableReason,
    urlImportDisabledMessage,
    urlImportReadyMessage,
    urlImportUnsupportedMessage,
} from './copy.js';
import { buildFilters } from './filters.js';
import { createVocabularyLoader } from './vocabulary.js';
import {
    getBotbooruAccount,
    noteBotbooruAccountError,
    subscribeBotbooruAccount,
} from './account.js';
import { PROTOCOL_VERSION, VERSION, MAX_FANOUT } from '../shared/schema.js';

/**
 * The value of the synthetic "All sources" entry in the picker.
 *
 * Not a source id: no adapter answers to it, and the server is never sent it.
 * A merged search sends the real ids in `sources`.
 */
const ALL_SOURCES = '__all__';

/** How long to wait after the last keystroke before searching. */
const TYPEAHEAD_DELAY_MS = 500;

/** Shorter than this and a search matches most of the catalogue anyway. */
const MIN_TYPEAHEAD_LENGTH = 3;

/**
 * Builds the pseudo-source that stands for a merged search.
 *
 * Most capabilities are the intersection of the sources behind it. SFW is the
 * exception: when any member can enforce it, send the value and state plainly
 * that sources without a reliable filter remain outside that guarantee. Omitting
 * it would turn BotBooru into an authenticated non-SFW search while the checkbox
 * still looked enabled.
 */
function mergedSourceEntry(usable) {
    const members = usable.slice(0, MAX_FANOUT);
    return {
        id: ALL_SOURCES,
        // Lands mid-sentence ("Searching all sources...") and must not claim
        // more than the fan-out cap actually sends.
        label: usable.length > MAX_FANOUT ? `the first ${MAX_FANOUT} sources` : 'all sources',
        merged: members,
        clientHosts: [...new Set(members.flatMap((entry) => entry.clientHosts ?? []))],
        capabilities: {
            search: true,
            paging: 'cursor',
            sorts: [],
            sfwToggle: members.some((entry) => entry.capabilities?.sfwToggle === true),
            sfwComplete: members.every((entry) => entry.capabilities?.sfwToggle === true),
            hideAiToggle: false,
            detail: true,
            filters: [],
        },
    };
}

let openingPromise = null;
let nextCardDescriptionId = 0;

function context() {
    return globalThis.SillyTavern.getContext();
}

/**
 * @param {{ query?: string }} [options]
 */
export function openBrowser(options = {}) {
    if (openingPromise) {
        return openingPromise;
    }
    openingPromise = openBrowserOnce(options).finally(() => {
        openingPromise = null;
    });
    return openingPromise;
}

async function openBrowserOnce(options) {

    const ctx = context();
    const availability = await getAvailability();
    const connected = availability.status === AVAILABILITY.OK;

    const templateName = connected ? 'templates/browser' : 'templates/plugin-missing';
    let html;
    try {
        html = await ctx.renderExtensionTemplateAsync(EXTENSION_PATH, templateName);
    } catch (error) {
        console.error(`[${LOG_TAG}] failed to render ${templateName}:`, error);
        toastr.error('Could not open the browser.', 'BotSearcher');
        return;
    }

    // Popup assigns a string body itself (public/scripts/popup.js:529), which is
    // how this extension stays free of HTML parsing in its own code.
    let dispose = () => {};
    let reopenAfterClose = false;
    const popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        leftAlign: true,
        allowVerticalScrolling: !connected,
        okButton: false,
        cancelButton: 'Close',
        // Esc from a subview steps back to the results instead of tearing the
        // whole dialog down with them. Only the Esc path (CANCELLED) is
        // intercepted: the close button still closes from anywhere, and
        // complete() sets popup.result before consulting this hook
        // (public/scripts/popup.js:784).
        onClosing: () => {
            if (popup.result !== ctx.POPUP_RESULT.CANCELLED) {
                return true;
            }
            const root = popup.content?.querySelector?.('.sbbs-root');
            const view = root?.dataset.view;
            if (view === 'detail' || view === 'intake') {
                popup.content.querySelector(`.sbbs-${view} .sbbs-back`)?.click();
                return false;
            }
            // Selecting cards is a mode of the grid; Esc leaves the mode before
            // it leaves the dialog.
            if (root?.dataset.selecting === 'true') {
                popup.content.querySelector('#sbbs_select_toggle')?.click();
                return false;
            }
            return true;
        },
        onClose: () => {
            dispose();
        },
    });
    popup.dlg.setAttribute('aria-label', 'Find cards online');

    const closed = popup.show();

    if (connected) {
        dispose = wireBrowser(popup, availability.health, options);
    } else {
        dispose = wireInstallPanel(popup, availability, () => {
            reopenAfterClose = true;
        });
    }

    await closed;
    if (reopenAfterClose) {
        setTimeout(() => {
            openBrowser().catch((error) => console.error(`[${LOG_TAG}]`, error));
        }, 0);
    }
}

/**
 * @param {any} popup
 * @param {any} health
 * @param {{ query?: string }} options
 */
function wireBrowser(popup, health, options) {
    const root = popup.content;
    const dom = {
        root: root.querySelector('.sbbs-root'),
        form: root.querySelector('#sbbs_search_form'),
        bar: root.querySelector('.sbbs-bar'),
        source: root.querySelector('#sbbs_source'),
        query: root.querySelector('#sbbs_query'),
        queryLabel: root.querySelector('label[for="sbbs_query"]'),
        go: root.querySelector('#sbbs_go'),
        sort: root.querySelector('#sbbs_sort'),
        sfw: root.querySelector('#sbbs_sfw'),
        sfwNote: root.querySelector('#sbbs_sfw_note'),
        hideAiControl: root.querySelector('#sbbs_hide_ai_control'),
        hideAi: root.querySelector('#sbbs_hide_ai'),
        filtersToggle: root.querySelector('#sbbs_filters_toggle'),
        filtersBadge: root.querySelector('#sbbs_filters_badge'),
        filters: root.querySelector('#sbbs_filters'),
        filterFields: root.querySelector('#sbbs_filter_fields'),
        filtersClear: root.querySelector('#sbbs_filters_clear'),
        filterActions: root.querySelector('.sbbs-filter-actions'),
        count: root.querySelector('#sbbs_count'),
        state: root.querySelector('#sbbs_state'),
        partial: root.querySelector('#sbbs_partial'),
        reload: root.querySelector('#sbbs_reload'),
        queryHistory: root.querySelector('#sbbs_query_history'),
        body: root.querySelector('.sbbs-body'),
        selection: root.querySelector('#sbbs_selection'),
        selectToggle: root.querySelector('#sbbs_select_toggle'),
        selectionCount: root.querySelector('#sbbs_selection_count'),
        selectAll: root.querySelector('#sbbs_select_all'),
        importSelected: root.querySelector('#sbbs_import_selected'),
        grid: root.querySelector('#sbbs_grid'),
        more: root.querySelector('#sbbs_more'),
        detail: root.querySelector('#sbbs_detail'),
        intake: root.querySelector('#sbbs_intake'),
        inspectFile: root.querySelector('#sbbs_inspect_file'),
        cardFile: root.querySelector('#sbbs_card_file'),
        refresh: root.querySelector('#sbbs_refresh'),
        recovered: root.querySelector('#sbbs_recovered'),
        shortlistCount: root.querySelector('#sbbs_shortlist_count'),
        shortlistItems: root.querySelector('#sbbs_shortlist_items'),
        shortlistImport: root.querySelector('#sbbs_shortlist_import'),
        shortlistClear: root.querySelector('#sbbs_shortlist_clear'),
        named: root.querySelector('#sbbs_named_searches'),
        namedConsent: root.querySelector('#sbbs_named_consent'),
        namedControls: root.querySelector('#sbbs_named_controls'),
        namedName: root.querySelector('#sbbs_named_name'),
        namedList: root.querySelector('#sbbs_named_list'),
        namedSave: root.querySelector('#sbbs_named_save'),
        namedLoad: root.querySelector('#sbbs_named_load'),
        namedRemove: root.querySelector('#sbbs_named_remove'),
        namedStatus: root.querySelector('#sbbs_named_status'),
    };

    const settings = getSettings();
    const sources = Array.isArray(health?.sources) ? health.sources : [];
    const enabledSources = sources.filter((source) => isSourceEnabled(source, settings.enabledSources));
    const searchable = enabledSources.filter((source) => source?.capabilities?.search);
    const urlSources = enabledSources.filter((source) => source?.capabilities?.urlImport
        || source?.capabilities?.browserImport);
    const serverHasSearchOrUrlSource = sources.some((source) => source?.capabilities?.search
        || source?.capabilities?.urlImport
        || source?.capabilities?.browserImport);
    // Every enabled searchable source stays in the catalogue picker, including one the server
    // currently has in cooldown. Selecting it explains why and offers a reload,
    // which is more useful than the source not being there to select.
    const usable = searchable;

    /** Card element -> record and immutable source snapshot. */
    const records = new Map();

    const initialSource = settings.defaultSource === ALL_SOURCES && usable.length > 1
        ? mergedSourceEntry(usable)
        : (usable.find((entry) => entry.id === settings.defaultSource) ?? usable[0]);
    const state = {
        source: initialSource,
        nextCursor: null,
        loading: false,
        requestGeneration: 0,
        searchController: null,
        detailController: null,
        intakeController: null,
        disposed: false,
        items: [],
        itemKeys: new Set(),
        /** Sources already told the user they are being fetched by the browser. */
        directNoted: new Set(),
        /** Sources successfully fetched directly during this dialog only. */
        directSources: new Set(),
        /** Per-source filter panel handle; null when the source declares none. */
        filters: null,
        /** Answers to questions already asked, so toggling a control is free. */
        cache: createResultCache(),
        /** Pending as-you-type search. */
        typingTimer: null,
        /** Tag names are fetched once per source for this dialog only. */
        vocabulary: createVocabularyLoader(),
        /** Public status only. The bearer remains in the server process. */
        account: getBotbooruAccount(),
        shortlist: new Map(),
        streams: new Map(),
        lastBody: null,
        detailSource: null,
        intakeSources: [],
        jannyNotice: null,
        mergedSorts: null,
    };

    const urlSourceLabels = urlSources.map((entry) => entry.label ?? entry.id);

    /**
     * Resolves a pasted card URL to the source that can import it.
     *
     * Matching is by host only; the server's own URL parser stays the authority
     * and rejects anything else with bad_import_url. `enabled: false` marks a
     * source the server offers but the user has switched off, so the message
     * can say how to turn it on rather than shrugging.
     *
     * @param {string} raw
     * @returns {{ source: any, enabled: boolean } | null} null when the text is not a URL at all
     */
    function findUrlImport(raw) {
        let url;
        try {
            url = new URL(String(raw ?? '').trim());
        } catch {
            return null;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return null;
        }
        if (url.protocol !== 'https:') {
            // Card URLs are https everywhere; treat http as an address we
            // recognize as a URL but cannot import from.
            return { source: null, enabled: false };
        }
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const matches = (entry) => Array.isArray(entry?.clientHosts) && entry.clientHosts.includes(host);
        const enabled = urlSources.find(matches);
        if (enabled) {
            return { source: enabled, enabled: true };
        }
        const known = sources.find((entry) => (entry?.capabilities?.urlImport === true
            || entry?.capabilities?.browserImport === true) && matches(entry));
        return { source: known ?? null, enabled: false };
    }

    /**
     * Recognizes a card URL in the search box and routes it to intake.
     *
     * On submit the URL opens the intake review; while typing it only sets the
     * status line, so pasting never opens a screen the user did not ask for.
     *
     * @param {string} raw
     * @param {{ open: boolean }} options
     * @returns {boolean} whether the text was treated as a URL rather than a query
     */
    function handleUrlIntent(raw, { open }) {
        const intent = findUrlImport(raw);
        const action = intent ? (getSettings().skipReview ? 'Import card URL' : 'Review card URL') : 'Search';
        dom.go.setAttribute('aria-label', action);
        dom.go.title = action;
        dom.go.disabled = Boolean(intent && (!intent.source || !intent.enabled));
        dom.query.setAttribute('enterkeyhint', intent ? 'go' : 'search');
        dom.go.querySelector('i')?.setAttribute('class', intent ? 'fa-solid fa-file-import' : 'fa-solid fa-magnifying-glass');
        updateJannyNotice(intent ? intent.source : undefined);
        if (!intent) {
            return false;
        }
        if (!intent.source) {
            setText(dom.state, urlImportUnsupportedMessage());
        } else if (!intent.enabled) {
            setText(dom.state, urlImportDisabledMessage(intent.source.label ?? intent.source.id));
        } else if (open) {
            openIntake({ url: String(raw).trim(), source: intent.source }, 'grid');
        } else {
            setText(dom.state, urlImportReadyMessage(intent.source.label ?? intent.source.id, getSettings().skipReview));
        }
        return true;
    }

    // The search box doubles as the URL-import entry, so its name has to say so.
    if (urlSources.length > 0) {
        const name = usable.length > 0
            ? 'Search character cards or paste a card URL'
            : 'Paste a card URL';
        setText(dom.queryLabel, name);
        dom.query.setAttribute('aria-label', name);
        dom.query.setAttribute('placeholder', usable.length > 0
            ? 'Search cards, or paste a card URL'
            : `Paste a card URL (${urlSourceLabels.join(', ')})`);
    }

    dom.inspectFile?.addEventListener('click', () => dom.cardFile?.click());
    dom.cardFile?.addEventListener('change', () => {
        const file = dom.cardFile.files?.[0];
        dom.cardFile.value = '';
        if (file) {
            openIntake({ file }, 'grid');
        }
    });

    // Keep file inspection available even when every searchable source is
    // disabled or the server only exposes URL-import sources.
    dom.root.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types?.includes('Files')) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        dom.root.classList.add('sbbs-dragging');
    });
    for (const name of ['dragleave', 'dragend']) {
        dom.root.addEventListener(name, () => dom.root.classList.remove('sbbs-dragging'));
    }
    dom.root.addEventListener('drop', (event) => {
        const file = event.dataTransfer?.files?.[0];
        if (!file) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        dom.root.classList.remove('sbbs-dragging');
        openIntake({ file }, dom.root.dataset.view === 'detail' ? 'detail' : 'grid');
    });

    if (usable.length === 0) {
        // The query row stays when a URL-import source is enabled: pasting a
        // card URL into it is the one thing the dialog can still do.
        for (const row of dom.form?.querySelectorAll('.sbbs-bar-row') ?? []) {
            row.hidden = urlSources.length === 0 || !row.contains(dom.query);
        }
        dom.filtersToggle.hidden = true;
        dom.filters.hidden = true;
        dom.named.hidden = true;
        // Nothing behind them can filter or search in this mode.
        dom.sfw.disabled = true;
        setText(dom.state, !serverHasSearchOrUrlSource
            ? 'The server did not report any searchable or URL-import sources.'
            : searchUnavailableMessage(urlSourceLabels));
        if (urlSources.length > 0) {
            dom.form.addEventListener('submit', (event) => {
                event.preventDefault();
                if (!handleUrlIntent(dom.query.value, { open: true })) {
                    setText(dom.state, searchUnavailableMessage(urlSourceLabels));
                }
            });
            dom.query.addEventListener('input', () => {
                handleUrlIntent(dom.query.value.trim(), { open: false });
            });
            requestAnimationFrame(() => {
                if (!state.disposed) {
                    dom.query.focus();
                }
            });
        }
        return () => {
            state.disposed = true;
            state.intakeController?.abort();
        };
    }

    // "All sources" is a synthetic entry, not a source. It is only worth
    // offering when there is more than one thing to merge — and when the fan-out
    // cap excludes some sources, the label must not claim they are included.
    if (usable.length > 1) {
        const option = document.createElement('option');
        option.value = ALL_SOURCES;
        setText(option, usable.length > MAX_FANOUT
            ? `First ${MAX_FANOUT} sources`
            : `All sources (${usable.length})`);
        dom.source.append(option);
    }
    for (const source of usable) {
        const option = document.createElement('option');
        option.value = source.id;
        // A source the server has in cooldown is still selectable, so say which
        // one it is rather than letting it look identical to a working one.
        setText(option, source.state === 'down'
            ? `${source.label ?? source.id} (unavailable)`
            : (source.label ?? source.id));
        dom.source.append(option);
    }
    dom.source.value = state.source.id;

    dom.sfw.checked = settings.sfwOnlyDefault;
    dom.hideAi.checked = settings.hideAiDefault;
    applySourceCapabilities();

    if (typeof options.query === 'string' && options.query !== '') {
        dom.query.value = options.query.slice(0, 512);
    }

    // ---- events ----

    dom.source.addEventListener('change', () => {
        const next = dom.source.value === ALL_SOURCES
            ? mergedSourceEntry(usable)
            : usable.find((entry) => entry.id === dom.source.value);
        if (!next) {
            return;
        }
        state.source = next;
        state.mergedSorts = null;
        state.detailController?.abort();
        applySourceCapabilities();
        updateSettings({ defaultSource: next.id });
        void runSearch({ append: false });
    });

    dom.sort.addEventListener('change', () => {
        const latest = getSettings();
        updateSettings({ sortBySource: { ...latest.sortBySource, [state.source.id]: dom.sort.value } });
        void runSearch({ append: false });
    });
    dom.sfw.addEventListener('change', () => {
        updateSettings({ sfwOnlyDefault: dom.sfw.checked });
        updateContentControlNote();
        void runSearch({ append: false });
    });
    dom.hideAi.addEventListener('change', () => {
        updateSettings({ hideAiDefault: dom.hideAi.checked });
        void runSearch({ append: false });
    });

    dom.filtersToggle.addEventListener('click', () => {
        const open = dom.filters.hidden;
        dom.filters.hidden = !open;
        dom.filtersToggle.setAttribute('aria-expanded', String(open));
    });
    dom.filtersClear.addEventListener('click', () => {
        if (state.filters?.count() === 0) {
            return;
        }
        state.filters?.clear();
        updateFilterBadge();
        void runSearch({ append: false });
    });

    dom.form.addEventListener('submit', (event) => {
        event.preventDefault();
        clearTimeout(state.typingTimer);
        void runSearch({ append: false, openUrl: true, remember: true });
    });

    /**
     * Searches while typing, but slowly.
     *
     * Long enough that an ordinary phrase is one request rather than a dozen —
     * the per-user budget is 30 searches a minute and a card site should not be
     * asked a question per keystroke — and short enough that the grid follows
     * along. Submitting still works and skips the wait.
     */
    dom.query.addEventListener('input', () => {
        clearTimeout(state.typingTimer);
        // Invalidate immediately, not after the debounce: a fetch implementation
        // can ignore abort, and its completed old response must never render for
        // the text now visible in the box.
        resetSearch();
        const value = dom.query.value.trim();
        // A pasted card URL is an import: say what Enter will do, search nothing.
        if (handleUrlIntent(value, { open: false })) {
            return;
        }
        // Below this a search is mostly noise, but clearing the box back to the
        // catalogue view is a real intent.
        if (value !== '' && value.length < MIN_TYPEAHEAD_LENGTH) {
            setText(dom.state, 'Keep typing to search.');
            return;
        }
        state.typingTimer = setTimeout(() => void runSearch({ append: false }), TYPEAHEAD_DELAY_MS);
    });
    dom.more.addEventListener('click', () => void runSearch({ append: true }));
    dom.refresh.addEventListener('click', () => void runSearch({ append: false, refresh: true }));

    dom.selectToggle.addEventListener('click', () => setSelecting(dom.root.dataset.selecting !== 'true'));
    dom.selectAll.addEventListener('click', () => {
        for (const open of records.keys()) {
            setSelected(open, true);
        }
        updateSelectionBar();
    });
    dom.importSelected.addEventListener('click', () => {
        const entries = selectedRecords();
        if (entries.length === 0) {
            return;
        }
        openSubview('grid', (container, onBack, signal) => showBulkImport(container, entries, () => {
            // The batch is done with; the grid comes back in its ordinary mode.
            setSelecting(false);
            onBack();
        }, { signal, autoStart: false }), entries.map((entry) => entry.source.id));
    });

    dom.shortlistClear.addEventListener('click', () => {
        state.shortlist.clear();
        updateShortlist();
    });
    dom.shortlistImport.addEventListener('click', () => {
        const entries = [...state.shortlist.values()];
        if (entries.length === 0) {
            return;
        }
        openSubview('grid', (container, onBack, signal) => showBulkImport(container, entries, onBack,
            { signal, autoStart: false }), entries.map((entry) => entry.source.id));
    });

    dom.namedName.maxLength = MAX_NAMED_SEARCH_NAME;
    dom.namedName.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            dom.namedSave.click();
        }
    });
    setText(root.querySelector('#sbbs_named_consent_label'), NAMED_SEARCH_COPY.optIn);
    setText(root.querySelector('#sbbs_named_privacy'), NAMED_SEARCH_COPY.privacy);
    dom.namedConsent.addEventListener('change', () => updateSettings({ saveNamedSearches: dom.namedConsent.checked }));
    dom.namedSave.addEventListener('click', () => {
        const saved = saveNamedSearch({
            name: dom.namedName.value, query: dom.query.value.trim(), source: state.source.id,
            filters: state.filters?.read() ?? {}, sort: dom.sort.value,
            sorts: Object.fromEntries(mergedSources().map((source) => [source.id,
                (state.mergedSorts ?? getSettings().sortBySource)[source.id] ?? source.capabilities?.sorts?.[0]])),
            sfwOnly: dom.sfw.checked, hideAi: dom.hideAi.checked,
        });
        setText(dom.namedStatus, saved ? NAMED_SEARCH_COPY.saved : `${NAMED_SEARCH_COPY.invalid} ${NAMED_SEARCH_COPY.full}`);
    });
    dom.namedRemove.addEventListener('click', () => {
        if (removeNamedSearch(dom.namedList.value)) {
            setText(dom.namedStatus, NAMED_SEARCH_COPY.removed);
        }
    });
    dom.namedLoad.addEventListener('click', () => {
        const latest = getSettings();
        const saved = latest.namedSearches.find((entry) => entry.name === dom.namedList.value);
        if (!saved) {
            return;
        }
        const enabled = usable.filter((entry) => isSourceEnabled(entry, latest.enabledSources));
        const source = saved.source === ALL_SOURCES && enabled.length > 1
            ? mergedSourceEntry(enabled) : enabled.find((entry) => entry.id === saved.source);
        if (!source) {
            setText(dom.namedStatus, 'Enable this search source under Extensions > BotSearcher, then reopen the browser.');
            return;
        }
        state.source = source;
        state.mergedSorts = saved.sorts;
        dom.source.value = source.id;
        dom.query.value = saved.query;
        dom.sfw.checked = saved.sfwOnly;
        dom.hideAi.checked = saved.hideAi;
        applySourceCapabilities();
        if (source.capabilities?.sorts?.includes(saved.sort)) {
            dom.sort.value = saved.sort;
        }
        for (const [key, value] of Object.entries(saved.filters)) {
            state.filters?.set(key, value);
        }
        updateFilterBadge();
        void runSearch({ append: false });
        dom.query.focus();
    });
    const unsubscribeSettings = subscribeSettings((value) => {
        if (state.disposed) {
            return;
        }
        refreshQueryHistory();
        dom.namedConsent.checked = value.saveNamedSearches;
        dom.namedControls.hidden = !value.saveNamedSearches;
        if (!value.saveNamedSearches) {
            dom.namedName.value = '';
            setText(dom.namedStatus, NAMED_SEARCH_COPY.disabled);
        } else if (dom.namedStatus.textContent === NAMED_SEARCH_COPY.disabled) {
            setText(dom.namedStatus, '');
        }
        const selected = dom.namedList.value;
        dom.namedList.replaceChildren();
        for (const entry of value.namedSearches) {
            const option = el('option', undefined, entry.name);
            option.value = entry.name;
            dom.namedList.append(option);
        }
        if (value.namedSearches.some((entry) => entry.name === selected)) {
            dom.namedList.value = selected;
        }
        dom.namedLoad.disabled = dom.namedRemove.disabled = value.namedSearches.length === 0;
        handleUrlIntent(dom.query.value, { open: false });
    });

    // Arrow keys move between cards; Home and End jump to the ends. Down off
    // the last row lands on Load more, which is where the keyboard user was
    // heading. Only the card buttons take part: a tag button inside a card
    // keeps its own keys.
    dom.grid.addEventListener('keydown', (event) => {
        if (!event.target?.classList?.contains('sbbs-card-open') || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        const cards = [...records.keys()].filter((open) => open.isConnected);
        const index = cards.indexOf(event.target);
        if (index < 0) {
            return;
        }
        const columns = columnsOf(cards);
        let next = null;
        switch (event.key) {
            case 'ArrowRight': next = index + 1; break;
            case 'ArrowLeft': next = index - 1; break;
            case 'ArrowDown': next = index + columns; break;
            case 'ArrowUp': next = index - columns; break;
            case 'Home': next = 0; break;
            case 'End': next = cards.length - 1; break;
            default: return;
        }
        event.preventDefault();
        if (next >= cards.length && event.key === 'ArrowDown' && !dom.more.hidden) {
            dom.more.focus();
            return;
        }
        cards[Math.max(0, Math.min(next, cards.length - 1))]?.focus();
    });

    // "/" from anywhere in the results puts the cursor in the search box.
    dom.root.addEventListener('keydown', (event) => {
        if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey
            || dom.root.dataset.view !== 'grid' || isTyping(event.target)) {
            return;
        }
        event.preventDefault();
        dom.query.focus();
        dom.query.select();
    });

    const unsubscribeAccount = subscribeBotbooruAccount((account) => {
        const previousRevision = state.account.revision;
        state.account = account;
        updateContentControlNote();
        if (state.disposed || account.revision === previousRevision) {
            return;
        }
        // A protected response can have been cached while another source is now
        // selected. Clear on every account revision, not only while BotBooru is
        // visible, so it cannot cross a logout or replacement login.
        state.cache.clear();
        for (const [key, record] of state.shortlist) {
            if (record.source.id === 'botbooru') {
                state.shortlist.delete(key);
            }
        }
        updateShortlist();
        if (state.detailSource === 'botbooru') {
            state.detailController?.abort();
            state.detailController = null;
            state.detailSource = null;
            dom.detail.replaceChildren();
            if (dom.root.dataset.view === 'detail') {
                dom.root.dataset.view = 'grid';
                dom.query.focus();
            }
        }
        if (state.intakeSources.includes('botbooru') && !preserveIntake()) {
            closeIntake();
            dom.root.dataset.view = 'grid';
            dom.query.focus();
        }
        if (!selectionUsesBotbooru()) {
            return;
        }
        if (mergedSources().length > 0) {
            removeMergedBotbooruResults(account);
            return;
        }
        resetForAccountChange(account);
    });

    refreshQueryHistory();

    // Browsing is useful without a query. Start immediately, then leave the
    // search field focused so the user can replace the catalogue view.
    void runSearch({ append: false });
    requestAnimationFrame(() => {
        if (!state.disposed) {
            dom.query.focus();
        }
    });

    /** Rebuilds sort options and the SFW toggle for the active source. */
    function applySourceCapabilities() {
        const sorts = state.source.capabilities?.sorts ?? [];
        dom.sort.replaceChildren();
        for (const sort of sorts) {
            const option = document.createElement('option');
            option.value = sort;
            setText(option, sortLabel(sort));
            dom.sort.append(option);
        }
        const savedSort = getSettings().sortBySource[state.source.id];
        if (sorts.includes(savedSort)) {
            dom.sort.value = savedSort;
        }
        // Hidden for a merged search too: the sources share no sort vocabulary,
        // so one control could not set the same thing on all of them. Each keeps
        // the sort it was last given on its own.
        dom.sort.hidden = sorts.length <= 1;

        // Never imply filtering that the source cannot actually do.
        const canFilter = state.source.capabilities?.sfwToggle === true;
        dom.sfw.disabled = !canFilter;
        updateContentControlNote();

        dom.hideAiControl.hidden = state.source.capabilities?.hideAiToggle !== true;

        // Filters are per source and are not carried across a source change:
        // "tags" on one site does not mean the same thing on another, and a
        // silently-kept filter would explain a suddenly empty grid badly.
        const declared = state.source.capabilities?.filters ?? [];
        state.filters = declared.length > 0
            ? buildFilters(dom.filterFields, declared, onFilterChange)
            : null;
        void loadVocabulary(state.source, state.filters);
        // Content restrictions stay outside this source-specific panel.
        if (declared.length === 0) {
            dom.filterFields.replaceChildren();
        }
        dom.filterActions.hidden = declared.length === 0;
        updateFilterBadge();
        updateJannyNotice();
    }

    /**
     * JannyAI answers searches, but its card downloads sit behind a Cloudflare
     * check that blocks the server until someone passes it in the browser
     * bridge. Say so before the first import fails, whenever JannyAI can
     * supply a card: picked as the source, part of a merged search, or a
     * pasted JannyAI link. Collapsed, so it costs one line until opened.
     *
     * @param {any} [urlSource] the source a pasted URL resolved to; undefined
     *     when the search box holds no URL, null for an unsupported URL
     */
    function updateJannyNotice(urlSource) {
        const janny = sources.find((entry) => entry?.id === 'jannyai');
        const relevant = urlSource !== undefined
            ? urlSource?.id === 'jannyai'
            : state.source?.id === 'jannyai'
                || (Array.isArray(state.source?.merged) && state.source.merged.some((entry) => entry?.id === 'jannyai'));
        if (!janny || !relevant) {
            if (state.jannyNotice) {
                state.jannyNotice.hidden = true;
            }
            return;
        }
        if (!state.jannyNotice) {
            state.jannyNotice = buildJannyNotice(janny);
            dom.state.before(state.jannyNotice);
        }
        state.jannyNotice.hidden = false;
    }

    function buildJannyNotice(janny) {
        const notice = el('details', 'sbbs-direct-notice sbbs-janny-notice');
        const summary = el('summary', undefined, JANNY_CLOUDFLARE_HINT_TITLE);
        const body = el('p', 'sbbs-janny-notice-text', jannyCloudflareHint());
        notice.append(summary, body);
        // The control asks the server for the bridge status as soon as it is
        // built, so wait until the user opens the hint.
        notice.addEventListener('toggle', () => {
            if (!notice.open || notice.querySelector('.sbbs-setting-account')) {
                return;
            }
            const control = jannyBrowserControl('sbbs_browse_janny', health?.capabilities?.jannyBrowser);
            control.firstElementChild.hidden = true;
            if (janny.capabilities?.browserImport !== true) {
                control.hidden = true;
            }
            notice.append(control);
        });
        return notice;
    }

    async function loadVocabulary(source, filters) {
        if (!filters || source.capabilities?.tagVocabulary !== true) {
            return;
        }
        const tags = await state.vocabulary.load(source);
        // A slow response for the previous source must not populate the newly
        // rebuilt controls, even if both sources happen to use tag filters.
        if (!state.disposed && state.source === source && state.filters === filters) {
            filters.setVocabulary(tags);
        }
    }

    /** The real sources behind the current selection, or [] when it is one source. */
    function mergedSources() {
        return Array.isArray(state.source.merged) ? state.source.merged : [];
    }

    function selectionUsesBotbooru() {
        return state.source.id === 'botbooru'
            || mergedSources().some((source) => source.id === 'botbooru');
    }

    function updateContentControlNote() {
        const canFilter = state.source.capabilities?.sfwToggle === true;
        const notes = [];
        if (!canFilter) {
            notes.push(mergedSources().length > 0
                ? 'Some of these sources do not provide a reliable SFW filter.'
                : `${state.source.label} does not provide a reliable SFW filter.`);
        } else if (dom.sfw.checked && mergedSources().length > 0
            && state.source.capabilities?.sfwComplete !== true) {
            notes.push('SFW only is enforced where a source provides a reliable filter; other sources may still include sensitive content.');
        }
        if (selectionUsesBotbooru() && !dom.sfw.checked) {
            if (!state.account.loggedIn) {
                notes.push('BotBooru requires a login under Extensions > BotSearcher for non-SFW results.');
            } else if (!state.account.nsfwEnabled) {
                notes.push('Enable NSFW for the BotBooru account under Extensions > BotSearcher.');
            } else if (state.account.nsflEnabled && state.account.nsflActive === true) {
                notes.push('NSFL is active for the BotBooru account, so non-SFW searches may include NSFL content.');
            } else if (state.account.nsflEnabled && state.account.nsflActive === null) {
                notes.push('BotBooru did not report whether NSFL is currently active, so non-SFW searches may include it.');
            }
        }
        const note = notes.join(' ');
        setText(dom.sfwNote, note);
        if (note === '') {
            dom.sfw.removeAttribute('aria-describedby');
        } else {
            dom.sfw.setAttribute('aria-describedby', 'sbbs_sfw_note');
        }
    }

    /**
     * Opens the intake screen for a card from the grid or a file from disk.
     *
     * `returnTo` is the view the Back button goes to, so a card opened from its
     * detail pane returns there and a dropped file returns to the results.
     */
    function openIntake(request, returnTo) {
        // A file chosen for inspection is inspected whatever the preference says;
        // the preference is about imports the user has already decided on.
        const direct = !request.file && getSettings().skipReview;
        openSubview(returnTo, (container, onBack, signal) => showIntake(container, request, onBack, { signal, direct }),
            [request.source?.id]);
    }

    /**
     * Mounts a screen in the intake pane and takes it down again on Back.
     * @param {'grid' | 'detail'} returnTo
     * @param {(container: HTMLElement, onBack: () => void, signal: AbortSignal) => Promise<void>} render
     */
    function openSubview(returnTo, render, sources = []) {
        if (state.disposed || dom.intake.matches('[data-committing="true"]')
            || dom.intake.querySelector('[data-committing="true"]')) {
            return;
        }
        const returnFocus = document.activeElement;
        state.intakeController?.abort();
        const controller = new AbortController();
        state.intakeController = controller;
        state.intakeSources = sources;
        dom.root.dataset.view = 'intake';

        void render(dom.intake, () => {
            if (state.disposed || controller.signal.aborted || state.intakeController !== controller) {
                return;
            }
            controller.abort();
            state.intakeController = null;
            state.intakeSources = [];
            dom.intake.replaceChildren();
            if (returnTo === 'detail' && !state.detailController) {
                returnTo = 'grid';
            }
            dom.root.dataset.view = returnTo;
            const pane = returnTo === 'detail' ? dom.detail : dom.bar;
            const target = returnFocus?.isConnected && pane?.contains(returnFocus) && !returnFocus.disabled
                ? returnFocus : returnTo === 'detail' ? dom.detail.querySelector('.sbbs-back') : dom.query;
            target?.focus();
        }, controller.signal);
    }

    function updateShortlist() {
        setText(dom.shortlistCount, `Shortlist (${state.shortlist.size})`);
        dom.shortlistImport.disabled = dom.shortlistClear.disabled = state.shortlist.size === 0;
        const focusedKey = document.activeElement?.closest('[data-shortlist-key]')?.dataset.shortlistKey;
        dom.shortlistItems.replaceChildren();
        for (const [key, record] of state.shortlist) {
            const row = el('li', 'sbbs-shortlist-item');
            row.dataset.shortlistKey = key;
            row.append(el('span', undefined, `${record.item.name || 'Untitled'} (${record.source.label})`));
            const review = el('button', 'menu_button sbbs-shortlist-review', 'Review');
            review.type = 'button';
            review.setAttribute('aria-label', `Review ${record.item.name || 'Untitled'}`);
            review.addEventListener('click', () => openIntake({ card: record.item, source: record.source }, 'grid'));
            const remove = el('button', 'menu_button sbbs-shortlist-remove', 'Remove');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Remove ${record.item.name || 'Untitled'} from shortlist`);
            remove.addEventListener('click', () => {
                state.shortlist.delete(key);
                updateShortlist();
                (dom.shortlistItems.querySelector('button') ?? dom.shortlistCount).focus();
            });
            row.append(review, remove);
            dom.shortlistItems.append(row);
            if (key === focusedKey) {
                review.focus();
            }
        }
        for (const [open, record] of records) {
            const button = open.parentElement?.querySelector('.sbbs-shortlist-toggle');
            if (!button) {
                continue;
            }
            const saved = state.shortlist.has(`${record.source.id}:${record.item.id}`);
            button.setAttribute('aria-pressed', String(saved));
            setText(button, saved ? 'Shortlisted' : 'Shortlist');
        }
    }

    // ---- selecting cards for one import ----

    function setSelecting(on) {
        dom.root.dataset.selecting = String(on);
        dom.selectToggle.setAttribute('aria-pressed', String(on));
        for (const open of records.keys()) {
            if (on) {
                setSelected(open, false);
            } else {
                open.removeAttribute('aria-pressed');
                open.closest('.sbbs-card')?.classList.remove('sbbs-card-selected');
            }
        }
        updateSelectionBar();
    }

    function setSelected(open, on) {
        open.setAttribute('aria-pressed', String(on));
        open.closest('.sbbs-card')?.classList.toggle('sbbs-card-selected', on);
    }

    /** The selection lives on the buttons themselves, so a rebuilt grid starts empty. */
    function selectedRecords() {
        return [...records.entries()]
            .filter(([open]) => open.isConnected && open.getAttribute('aria-pressed') === 'true')
            .map(([, record]) => record);
    }

    function updateSelectionBar() {
        const selecting = dom.root.dataset.selecting === 'true';
        const count = selecting ? selectedRecords().length : 0;
        dom.selection.hidden = !selecting && records.size === 0;
        setText(dom.selectionCount, selecting ? `${count} selected` : '');
        dom.selectAll.hidden = !selecting;
        dom.importSelected.hidden = !selecting;
        dom.importSelected.disabled = count === 0;
    }

    function closeIntake() {
        state.intakeController?.abort();
        state.intakeController = null;
        state.intakeSources = [];
        dom.intake.replaceChildren();
    }

    function preserveIntake() {
        return dom.root.dataset.view === 'intake' && (dom.intake.dataset.committing === 'true'
            || dom.intake.querySelector('[data-committing="true"], .sbbs-intake-account-recovery[data-source="botbooru"]'));
    }

    function resetForAccountChange(account) {
        const wasDetail = dom.root.dataset.view === 'detail';
        resetSearch();

        if (!account.error && (!account.loggedIn || !account.nsfwEnabled) && !dom.sfw.checked) {
            // This is deliberately dialog-local. The saved default still reflects
            // what the user chose and can resume after a future login.
            dom.sfw.checked = true;
            updateContentControlNote();
        }

        if (account.error) {
            setText(dom.state, searchErrorMessage({ code: account.error }, 'BotBooru'));
            if (wasDetail && dom.query.isConnected) {
                dom.query.focus();
            }
            return;
        }
        void runSearch({ append: false });
    }

    /** Keeps valid merged results while removing cards tied to an expired account. */
    function removeMergedBotbooruResults(account) {
        for (const [open, record] of records) {
            if (record.source.id === 'botbooru') {
                open.closest('li')?.remove();
                records.delete(open);
            }
        }
        updateSelectionBar();
        state.items = state.items.filter((item) => item?.source !== 'botbooru');
        state.itemKeys = new Set(state.items.map((item) => `${item.source}:${item.id}`));
        const source = mergedSources().find((entry) => entry.id === 'botbooru');
        if (source && state.lastBody) {
            state.streams.get(source.id)?.controller?.abort();
            state.streams.set(source.id, {
                source, body: { ...state.lastBody, sources: [source.id], cursor: null }, cursor: null,
                error: account.error ?? 'account_changed', busy: false,
            });
            renderSourceStreams();
        }
        setText(dom.count, formatResultCount(state.items.length, null));
    }

    /** Resolves a result's own source, which in a merged search is not the selection. */
    function sourceOf(item) {
        const candidates = mergedSources();
        const allowed = candidates.length > 0 ? candidates : [state.source];
        return allowed.find((entry) => entry.id === item?.source) ?? null;
    }

    function onFilterChange() {
        updateFilterBadge();
        void runSearch({ append: false });
    }

    /** Shows how many filters are active, so a collapsed panel is not a trap. */
    function updateFilterBadge() {
        const active = state.filters?.count() ?? 0;
        dom.filtersBadge.hidden = active === 0;
        setText(dom.filtersBadge, String(active));
        dom.filtersClear.disabled = active === 0;
        // The badge is a bare number; give the toggle itself the full name.
        dom.filtersToggle.setAttribute('aria-label', active === 0 ? 'Filters' : `Filters, ${active} active`);
    }

    function resetSearch() {
        clearTimeout(state.typingTimer);
        state.searchController?.abort();
        state.requestGeneration++;
        state.loading = false;
        state.nextCursor = null;
        state.lastBody = null;
        for (const stream of state.streams.values()) {
            stream.controller?.abort();
        }
        state.streams.clear();
        renderSourceStreams();
        state.items = [];
        state.itemKeys.clear();
        records.clear();
        dom.grid.replaceChildren();
        setSelecting(false);
        dom.body?.setAttribute('aria-busy', 'false');
        dom.more.disabled = false;
        dom.more.hidden = true;
        hideSourceFailure();
        setText(dom.count, '');
    }

    async function runSearch({ append, openUrl = false, remember = false, refresh = false }) {
        if (state.disposed) {
            return;
        }
        if (!append) {
            resetSearch();
        }
        if (handleUrlIntent(dom.query.value, { open: openUrl })) {
            return;
        }
        if (state.disposed || (append && (state.loading || !state.nextCursor
            || [...state.streams.values()].some((stream) => stream.busy)))) {
            return;
        }
        if (remember) {
            rememberQuery(dom.query.value);
            refreshQueryHistory();
        }
        if (refresh) {
            state.cache.clear();
        }

        state.searchController?.abort();
        const controller = new AbortController();
        state.searchController = controller;
        const generation = ++state.requestGeneration;
        const accountRevision = state.account.revision;
        const source = state.source;
        const query = dom.query.value.trim();
        const sort = dom.sort.value;
        const cursor = append ? state.nextCursor : null;
        // Read once and reuse for the request and the empty-result message, so
        // the two cannot disagree about what was asked for.
        const filters = state.filters?.read() ?? {};

        state.loading = true;
        renderSourceStreams();
        dom.body?.setAttribute('aria-busy', 'true');
        dom.more.disabled = true;
        setText(dom.more, 'Load more');
        hideSourceFailure();
        setText(dom.state, append ? `Loading more from ${source.label}...` : `Searching ${source.label}...`);

        if (!append) {
            showSkeletons();
        }
        dom.more.hidden = true;

        const members = mergedSources();
        const requestFilters = {
            ...filters,
            hideAi: source.capabilities?.hideAiToggle === true && dom.hideAi.checked,
        };
        if (source.capabilities?.sfwToggle === true) {
            requestFilters.sfwOnly = dom.sfw.checked;
        }
        const body = {
            query,
            limit: append ? state.lastBody.limit : getSettings().resultsPerPage,
            cursor,
            filters: requestFilters,
        };

        if (members.length > 0) {
            body.sources = members.filter((entry) => !state.streams.has(entry.id)).map((entry) => entry.id);
            if (body.sources.length === 0) {
                state.loading = false;
                dom.body?.setAttribute('aria-busy', 'false');
                return;
            }
            // Each source keeps its own saved sort; there is no vocabulary they
            // share, so there is nothing sensible for one control to set.
            const saved = (append ? state.lastBody.sorts : state.mergedSorts) ?? getSettings().sortBySource;
            body.sorts = Object.fromEntries(members.map((entry) => [
                entry.id,
                saved[entry.id] ?? entry.capabilities?.sorts?.[0],
            ]));
        } else {
            body.source = source.id;
            body.sort = sort;
        }
        state.lastBody = body;

        try {
            // A control that was just toggled asks a question already answered.
            const cached = refresh ? null : state.cache.get(body);
            const result = cached ?? await postRouted('/search', body, source, {
                signal: controller.signal,
                // A merged search has no single source to reroute, and the
                // per-source failures it reports are handled below instead.
                allowDirect: members.length === 0 && getSettings().allowDirectRequests,
                onDirect: (reason) => {
                    if (!state.disposed && generation === state.requestGeneration) {
                        useDirectRouting(source, reason);
                    }
                },
            });

            if (state.disposed || generation !== state.requestGeneration) {
                return;
            }

            const accountChanged = accountRevision !== state.account.revision;
            if (accountChanged && source.id === 'botbooru') {
                return;
            }
            const partial = (Array.isArray(result.partial) ? result.partial : [])
                .filter((entry) => !accountChanged || entry?.source !== 'botbooru');
            if (!cached && partial.length === 0 && !accountChanged) {
                state.cache.set(body, result);
            }

            clearSkeletons();

            const items = Array.isArray(result.items) ? result.items : [];
            const fresh = items.filter((item) => {
                const itemSource = sourceOf(item);
                // Keyed by the item's OWN source, which in a merged search is
                // not the selection.
                if (!itemSource || typeof item?.id !== 'string' || item.id === ''
                    || (accountChanged && itemSource.id === 'botbooru') || state.streams.has(itemSource.id)) {
                    return false;
                }
                const key = `${itemSource.id}:${item.id}`;
                if (state.itemKeys.has(key)) {
                    return false;
                }
                state.itemKeys.add(key);
                return true;
            });
            state.items.push(...fresh);
            state.nextCursor = typeof result.nextCursor === 'string' && result.nextCursor !== ''
                ? result.nextCursor
                : null;

            appendCards(fresh, source);

            if (state.items.length === 0) {
                setText(dom.state, emptyResultMessage(source.label, query, Object.keys(filters).length));
            } else {
                setText(dom.state, '');
            }

            // Which sources in a merged search did not answer. Stated rather
            // than hidden: a short list of results has a reason, and silently
            // dropping a site would look like it simply had nothing.
            showPartialFailures(partial, body, result.nextCursor, accountRevision);

            setText(dom.count, formatResultCount(state.items.length, state.streams.size ? null : result.total));
            dom.more.hidden = state.nextCursor === null || (members.length > 0
                && members.every((entry) => state.streams.has(entry.id)));
        } catch (error) {
            if (error?.name === 'AbortError' || generation !== state.requestGeneration || state.disposed) {
                return;
            }
            clearSkeletons();

            // The server is in cooldown for this source, so re-searching would
            // be answered without it trying. Offer the reload that clears it.
            if (error?.code === 'source_down') {
                showSourceFailure(source, source.reason, append);
                return;
            }

            if (source.id === 'botbooru' && accountRevision !== state.account.revision) {
                return;
            }
            if (source.id === 'botbooru' && noteBotbooruAccountError(error)) {
                return;
            }

            setText(dom.state, searchErrorMessage(error, source.label));
            if (append && state.items.length > 0) {
                setText(dom.more, 'Retry loading more');
                dom.more.hidden = false;
            } else {
                setText(dom.count, '');
            }
        } finally {
            if (generation === state.requestGeneration) {
                state.loading = false;
                dom.body?.setAttribute('aria-busy', 'false');
                dom.more.disabled = false;
                renderSourceStreams();
            }
        }
    }

    /** Refills the previous-searches dropdown attached to the query box. */
    function refreshQueryHistory() {
        dom.queryHistory.replaceChildren();
        for (const entry of getSettings().queryHistory) {
            const option = document.createElement('option');
            // A datalist option's VALUE is what gets inserted, and setting it as
            // an attribute rather than as text keeps it out of the markup path.
            option.value = entry;
            dom.queryHistory.append(option);
        }
    }

    /** Names the sources a merged search could not reach, or clears the notice. */
    function showPartialFailures(partial, body, nextCursor, accountRevision) {
        for (const entry of partial) {
            const source = mergedSources().find((item) => item.id === entry?.source);
            if (!source || !body.sources?.includes(source.id)) {
                continue;
            }
            if (entry?.source === 'botbooru' && accountRevision === state.account.revision) {
                noteBotbooruAccountError({ code: entry?.error });
            }
            const accountFailure = source.id === 'botbooru' && [
                'botbooru_login_required', 'botbooru_session_expired', 'botbooru_nsfw_disabled',
            ].includes(entry.error);
            state.streams.set(source.id, {
                source, body: { ...body, sources: [source.id] },
                // A merged cursor can be narrowed to one source without decoding
                // it. Account failures have no retained cursor and restart safely.
                cursor: accountFailure ? null : (nextCursor || body.cursor || null),
                error: entry.error, busy: false,
            });
        }
        renderSourceStreams();
    }

    function renderSourceStreams() {
        dom.more.disabled = state.loading || [...state.streams.values()].some((stream) => stream.busy);
        dom.partial.replaceChildren();
        dom.recovered.replaceChildren();
        for (const stream of state.streams.values()) {
            const row = el('div', 'sbbs-partial-line sbbs-source-recovery');
            if (stream.error) {
                row.append(el('span', undefined, stream.error === 'account_changed'
                    ? 'BotBooru account changed. Retry to load results for the current account.'
                    : searchErrorMessage({ code: stream.error }, stream.source.label)));
            }
            if (stream.error || stream.cursor) {
                const button = el('button', 'menu_button sbbs-retry-source', stream.busy
                    ? `Loading ${stream.source.label}...`
                    : `${stream.error ? 'Retry' : 'Load more from'} ${stream.source.label}`);
                button.type = 'button';
                button.dataset.source = stream.source.id;
                button.disabled = stream.busy || state.loading;
                button.addEventListener('click', () => void retrySource(stream));
                row.append(button);
                (stream.error ? dom.partial : dom.recovered).append(row);
            }
        }
        dom.partial.hidden = dom.partial.childElementCount === 0;
        dom.recovered.hidden = dom.recovered.childElementCount === 0;
    }

    async function retrySource(stream) {
        if (state.disposed || state.loading || stream.busy || state.streams.get(stream.source.id) !== stream) {
            return;
        }
        const generation = state.requestGeneration;
        const accountRevision = state.account.revision;
        const controller = new AbortController();
        stream.controller = controller;
        const current = () => !state.disposed && !controller.signal.aborted
            && generation === state.requestGeneration && state.streams.get(stream.source.id) === stream
            && (stream.source.id !== 'botbooru' || accountRevision === state.account.revision);
        stream.busy = true;
        dom.more.disabled = true;
        renderSourceStreams();
        try {
            if (stream.error) {
                await post('/retry', { source: stream.source.id }, { signal: controller.signal });
                if (!current()) {
                    return;
                }
                invalidateAvailability();
            }
            const body = { ...stream.body, cursor: stream.cursor };
            if (stream.source.id === 'botbooru' && !state.account.error
                && (!state.account.loggedIn || !state.account.nsfwEnabled)) {
                body.filters = { ...body.filters, sfwOnly: true };
            }
            const result = await post('/search', body, { signal: controller.signal });
            if (!current()) {
                return;
            }
            const failure = (Array.isArray(result.partial) ? result.partial : [])
                .find((entry) => entry?.source === stream.source.id);
            if (failure) {
                stream.error = failure.error;
                if (stream.source.id === 'botbooru') {
                    noteBotbooruAccountError({ code: failure.error });
                }
                return;
            }
            const fresh = (Array.isArray(result.items) ? result.items : []).filter((item) => {
                if (item?.source !== stream.source.id || typeof item.id !== 'string' || !item.id) {
                    return false;
                }
                const key = `${item.source}:${item.id}`;
                if (state.itemKeys.has(key)) {
                    return false;
                }
                state.itemKeys.add(key);
                return true;
            });
            state.items.push(...fresh);
            appendCards(fresh, state.source);
            stream.body = body;
            stream.cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
            stream.error = null;
            setText(dom.count, formatResultCount(state.items.length, null));
            if (state.items.length) {
                setText(dom.state, '');
            }
        } catch (error) {
            if (!current() || error?.name === 'AbortError') {
                return;
            }
            stream.error = error?.code ?? 'request_failed';
            if (stream.source.id === 'botbooru') {
                noteBotbooruAccountError(error);
            }
        } finally {
            if (current()) {
                stream.busy = false;
                dom.more.disabled = [...state.streams.values()].some((entry) => entry.busy);
                renderSourceStreams();
            }
        }
    }

    /**
     * Says, once per source per session, that its requests are now coming from
     * this browser rather than from the Neconyan server.
     *
     * This is a routing change the user did not ask for, made because the
     * alternative is the source not working at all. It changes which address the
     * card site sees, so it is stated plainly and left on screen rather than
     * announced in a toast that disappears. The user can dismiss the disclosure
     * after reading it without changing the routing decision.
     */
    function noteDirectRouting(source, reason) {
        if (state.directNoted.has(source.id)) {
            return;
        }
        state.directNoted.add(source.id);

        const notice = el('div', 'sbbs-direct-notice');
        const message = el('span', 'sbbs-direct-notice-text');
        setText(message, directRoutingNotice(source.label, reason));
        message.setAttribute('role', 'status');

        const dismiss = document.createElement('button');
        dismiss.className = 'sbbs-direct-notice-dismiss';
        dismiss.type = 'button';
        dismiss.setAttribute('aria-label', 'Dismiss direct routing notice');
        dismiss.title = 'Dismiss direct routing notice';

        const icon = el('i', 'fa-solid fa-xmark');
        icon.setAttribute('aria-hidden', 'true');
        dismiss.append(icon);
        dismiss.addEventListener('click', () => {
            // Keep directNoted intact: closing the disclosure does not turn off
            // the route or make the same notice reappear during this dialog.
            notice.remove();
        });

        notice.append(message, dismiss);
        dom.state.after(notice);
    }

    function useDirectRouting(source, reason) {
        state.directSources.add(source.id);
        noteDirectRouting(source, reason);
    }

    /**
     * Reports a source that could not be reached, and offers to try it again.
     *
     * The source stays selected and stays in the picker. It used to be removed,
     * which meant a site having a bad minute disappeared from the list and the
     * dialog silently switched to a different one — so the results on screen
     * were from somewhere the user had not chosen, and getting back needed a
     * button that appeared somewhere else.
     *
     * The server-side cooldown is the reason a plain re-search would not help:
     * while a source is in cooldown the server answers immediately without
     * trying. Reload clears that first, then searches again.
     */
    function showSourceFailure(dead, reason, append = false) {
        dom.more.hidden = true;
        setText(dom.state, `${unreachableReason(dead.label, reason)} It is still in the list.`);

        // Rebuilt each time rather than accumulating one per failed attempt.
        dom.reload.replaceChildren();
        dom.reload.hidden = false;

        const reload = el('button', 'menu_button sbbs-reload-source');
        reload.type = 'button';
        setText(reload, `Reload ${dead.label}`);
        reload.addEventListener('click', async () => {
            const generation = state.requestGeneration;
            reload.disabled = true;
            setText(reload, `Reloading ${dead.label}...`);
            try {
                await post('/retry', { source: dead.id });
                invalidateAvailability();
            } catch {
                // The cooldown could not be cleared, but the search below still
                // reports what happened, so there is nothing extra to say here.
            }
            if (state.disposed || generation !== state.requestGeneration || state.source !== dead) {
                return;
            }
            dom.reload.hidden = true;
            dom.reload.replaceChildren();
            void runSearch({ append, refresh: true });
        });

        dom.reload.append(reload);
    }

    /** Clears the reload prompt once a search is under way again. */
    function hideSourceFailure() {
        if (!dom.reload.hidden) {
            dom.reload.hidden = true;
            dom.reload.replaceChildren();
        }
    }

    function appendCards(items, selection) {
        const settingsNow = getSettings();
        const merged = mergedSources().length > 0;
        for (const item of items) {
            // In a merged search each card belongs to its own source: that is
            // what supplies its image hosts, its filters and its importer.
            const source = merged ? sourceOf(item) : selection;
            if (!source) {
                continue;
            }
            const { card, open, tags } = buildCard(
                item,
                source,
                settingsNow,
                merged,
                state.directSources.has(source.id),
            );
            records.set(open, { item, source });
            const shortlist = el('button', 'menu_button sbbs-shortlist-toggle', 'Shortlist');
            shortlist.type = 'button';
            shortlist.setAttribute('aria-label', `Shortlist ${item.name || 'Untitled'}`);
            shortlist.addEventListener('click', () => {
                if (!records.has(open) || state.disposed) {
                    return;
                }
                const key = `${source.id}:${item.id}`;
                if (state.shortlist.has(key)) {
                    state.shortlist.delete(key);
                } else {
                    state.shortlist.set(key, { item, source });
                }
                updateShortlist();
            });
            card.append(shortlist);

            // Clicking a tag narrows the search instead of opening the card.
            // Only offered when the source declares a tag filter, so it never
            // looks like it should work and then does nothing.
            for (const { button, tag } of tags) {
                button.addEventListener('click', () => {
                    if (state.filters?.set('tags', tag)) {
                        dom.filters.hidden = false;
                        dom.filtersToggle.setAttribute('aria-expanded', 'true');
                        onFilterChange();
                        dom.filterFields.querySelector('#sbbs_filter_tags')?.focus();
                    }
                });
            }

            open.addEventListener('click', () => {
                const record = records.get(open);
                if (!record) {
                    return;
                }
                if (dom.root.dataset.selecting === 'true') {
                    setSelected(open, open.getAttribute('aria-pressed') !== 'true');
                    updateSelectionBar();
                    return;
                }
                state.detailController?.abort();
                const detailController = new AbortController();
                state.detailController = detailController;
                state.detailSource = record.source.id;
                const current = () => !state.disposed && !detailController.signal.aborted
                    && state.detailController === detailController;
                dom.root.dataset.view = 'detail';
                void showDetail(dom.detail, record.item, record.source, () => {
                    if (!current()) {
                        return;
                    }
                    detailController.abort();
                    state.detailController = null;
                    state.detailSource = null;
                    dom.root.dataset.view = 'grid';
                    dom.detail.replaceChildren();
                    // Return focus where it was, so keyboard and screen-reader
                    // users are not dropped back at the top of the dialog.
                    if (open.isConnected) {
                        open.focus();
                    }
                }, {
                    signal: detailController.signal,
                    // Filtering from the detail pane only makes sense back in
                    // the grid, so it returns there rather than leaving the user
                    // on a card while the results behind it change.
                    onTag: merged ? undefined : (tag) => {
                        if (!current() || !state.filters?.set('tags', tag)) {
                            return;
                        }
                        detailController.abort();
                        state.detailController = null;
                        state.detailSource = null;
                        dom.root.dataset.view = 'grid';
                        dom.detail.replaceChildren();
                        dom.filters.hidden = false;
                        dom.filtersToggle.setAttribute('aria-expanded', 'true');
                        onFilterChange();
                        dom.filterFields.querySelector('#sbbs_filter_tags')?.focus();
                    },
                    onDirect: (reason) => {
                        if (current()) {
                            useDirectRouting(record.source, reason);
                        }
                    },
                    isSourceDirect: (sourceId) => state.directSources.has(sourceId),
                    // The detail pane stays mounted behind the intake screen, so
                    // Back returns to the card the user was already reading.
                    onIntake: (request) => {
                        if (current()) {
                            openIntake(request, 'detail');
                        }
                    },
                });
            });
            if (dom.root.dataset.selecting === 'true') {
                setSelected(open, false);
            }
            const li = document.createElement('li');
            li.append(card);
            dom.grid.append(li);
        }
        updateSelectionBar();
        updateShortlist();
    }

    function showSkeletons() {
        for (let i = 0; i < 12; i++) {
            const li = document.createElement('li');
            li.className = 'sbbs-skeleton';
            li.setAttribute('aria-hidden', 'true');
            const shape = el('div', 'sbbs-card-img');
            shape.setAttribute('aria-hidden', 'true');
            li.append(shape);
            dom.grid.append(li);
        }
    }

    function clearSkeletons() {
        for (const node of [...dom.grid.querySelectorAll('.sbbs-skeleton')]) {
            node.remove();
        }
    }

    return () => {
        state.disposed = true;
        state.requestGeneration++;
        clearTimeout(state.typingTimer);
        state.searchController?.abort();
        state.detailController?.abort();
        state.intakeController?.abort();
        // Cached pages hold listing text from adult catalogues. They live as long
        // as the dialog and no longer.
        state.cache.clear();
        state.vocabulary.clear();
        state.shortlist.clear();
        for (const stream of state.streams.values()) {
            stream.controller?.abort();
        }
        state.streams.clear();
        unsubscribeAccount();
        unsubscribeSettings();
    };
}

/**
 * How many cards share the first row. Measured from layout rather than read
 * from the stylesheet, since the grid is auto-fill and the count depends on
 * the dialog's width at that moment.
 * @param {HTMLElement[]} cards
 */
function columnsOf(cards) {
    const top = cards[0]?.getBoundingClientRect().top;
    let columns = 0;
    while (columns < cards.length && cards[columns].getBoundingClientRect().top === top) {
        columns++;
    }
    return Math.max(1, columns);
}

/** Whether a key press belongs to a text field rather than to the dialog. */
function isTyping(target) {
    return target?.isContentEditable === true
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName);
}

/**
 * Builds one result card.
 *
 * The card is a container rather than a single button because the tags inside
 * it are their own buttons, and a button inside a button is neither valid nor
 * reachable by keyboard. `open` is the primary action and carries the card's
 * accessible name; the tags are siblings of it.
 *
 * @param {any} item
 * @param {{ label: string, clientHosts: string[], capabilities?: any }} source
 * @param {ReturnType<typeof getSettings>} settings
 * @param {boolean} showSource whether results came from more than one site
 * @param {boolean} sourceDirect whether this dialog fetched the source directly
 * @returns {{ card: HTMLElement, open: HTMLButtonElement, tags: {button: HTMLElement, tag: string}[] }}
 */
function buildCard(item, source, settings, showSource = false, sourceDirect = false) {
    const card = el('div', 'sbbs-card');

    const open = el('button', 'sbbs-card-open');
    open.type = 'button';

    const figure = el('div', 'sbbs-card-img');
    // Always present, revealed if no image arrives. A source may have no
    // thumbnail, or one too large for the proxy's cap. Decorative: the card's
    // accessible name already carries the character name.
    const initial = el('span', 'sbbs-card-initial', initialOf(item.name));
    initial.setAttribute('aria-hidden', 'true');
    figure.append(initial);

    const rating = ratingOf(item);

    const src = thumbSrc(item, source, 'grid', settings.imageMode, sourceDirect);
    if (src) {
        const img = document.createElement('img');
        img.alt = '';
        if (setImgSafe(img, src, source.clientHosts)) {
            if (rating.value !== 'sfw' && settings.blurNsfw) {
                figure.classList.add('sbbs-blurred');
            }
            img.addEventListener('error', () => img.remove(), { once: true });
            figure.append(img);
        }
    }

    const meta = el('div', 'sbbs-card-meta');
    meta.append(el('div', 'sbbs-card-name', item.name || 'Untitled'));

    const sub = [];
    if (item.stats?.tokens) {
        sub.push(formatCount(item.stats.tokens, 'token'));
    }
    if (item.creator) {
        sub.push(item.creator);
    }
    const descriptionIds = [];
    const subline = el('div', 'sbbs-card-sub', sub.join(' · '));
    subline.id = `sbbs_card_description_${++nextCardDescriptionId}`;
    meta.append(subline);
    if (item.stats?.tokens) {
        descriptionIds.push(subline.id);
    }

    // The source's own one-line summary. Already fetched and normalized, and the
    // single most useful thing for telling two similarly-named cards apart.
    if (typeof item.tagline === 'string' && item.tagline.trim() !== '') {
        const tagline = el('div', 'sbbs-card-tagline', item.tagline.trim());
        tagline.id = `sbbs_card_description_${++nextCardDescriptionId}`;
        meta.append(tagline);
        descriptionIds.push(tagline.id);
    }

    // Source, popularity and content rating share the card's last line. On a
    // wide screen CSS lifts the rating and the source chip back onto the
    // thumbnail; in the narrow list layout the thumbnail is far too small to
    // carry either legibly, and the content rating has to stay readable.
    const footer = el('div', 'sbbs-card-footer');

    // Which site a result came from only matters when they are mixed together.
    if (showSource) {
        footer.append(el('span', 'sbbs-card-source', source.label ?? item.source ?? ''));
    }

    const popularity = popularityOf(item, source.id);
    if (popularity !== '') {
        footer.append(el('div', 'sbbs-card-stats', popularity));
    }

    footer.append(el('span', `sbbs-rating sbbs-rating-${rating.value}`, rating.label));
    meta.append(footer);

    open.append(figure, meta);
    open.title = item.name || '';

    // One accessible name covers the whole card, so the tagline and stats are
    // not read out twice.
    const parts = [item.name || 'Untitled'];
    if (item.creator) {
        parts.push(`by ${item.creator}`);
    }
    if (showSource && source.label) {
        parts.push(`on ${source.label}`);
    }
    parts.push(rating.accessible);
    open.setAttribute('aria-label', parts.join(', '));
    if (descriptionIds.length) {
        open.setAttribute('aria-describedby', descriptionIds.join(' '));
    }

    card.append(open);

    const tags = buildCardTags(item, source, card, !showSource);
    return { card, open, tags };
}

/** Up to four tags, as filter buttons where the source supports tag filtering. */
function buildCardTags(item, source, card, allowFilter) {
    const list = Array.isArray(item.tags)
        ? item.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').slice(0, 4)
        : [];
    if (list.length === 0) {
        return [];
    }

    const canFilter = allowFilter && (source.capabilities?.filters ?? []).some((filter) => filter.key === 'tags');
    const row = el('div', 'sbbs-card-tags');
    const handles = [];

    for (const tag of list) {
        if (!canFilter) {
            // Still worth showing; just not clickable, because on this source
            // clicking could not do anything.
            row.append(el('span', 'sbbs-card-tag', tag));
            continue;
        }
        const button = el('button', 'sbbs-card-tag sbbs-card-tag-button', tag);
        button.type = 'button';
        button.setAttribute('aria-label', `Filter by tag ${tag}`);
        row.append(button);
        handles.push({ button, tag });
    }

    card.append(row);
    return handles;
}

/**
 * The popularity figures a source reported, and only those.
 *
 * Sources count different things under the same names — Chub's "downloads" is
 * its star count — so each is labelled rather than shown as a bare number, and
 * a figure the source did not report is omitted rather than shown as zero.
 * The token count is left out here because the line above the footer already
 * carries it; one card must not state the same figure twice.
 */
function popularityOf(item, sourceId) {
    return sourceStatLine(sourceId, item?.stats, item?.stats?.tokens ? ['tokens'] : []);
}

function ratingOf(item) {
    if (item?.contentRating === 'sfw') {
        return { value: 'sfw', label: 'SFW', accessible: 'rated SFW' };
    }
    if (item?.contentRating === 'sensitive') {
        return { value: 'sensitive', label: 'Sensitive', accessible: 'sensitive content' };
    }
    return { value: 'unknown', label: 'Unrated', accessible: 'content rating not reported' };
}

/** First character of a name, for the no-image tile. */
function initialOf(name) {
    const text = typeof name === 'string' ? name.trim() : '';
    return text === '' ? '?' : [...text][0].toUpperCase();
}

/**
 * @param {any} popup
 * @param {{ status: string, health: any }} availability
 * @param {() => void} requestReopen
 */
function wireInstallPanel(popup, availability, requestReopen) {
    const root = popup.content;
    const guidance = root.querySelector('.sbbs-install-guidance');
    const recheck = root.querySelector('#sbbs_recheck');

    for (const tag of root.querySelectorAll('.sbbs-release-tag')) {
        setText(tag, `v${VERSION}`);
    }

    const copy = availabilityCopy(
        availability.status,
        availability.health,
        PROTOCOL_VERSION,
        VERSION,
    );
    setText(root.querySelector('.sbbs-install-title'), copy.title);
    setText(root.querySelector('.sbbs-install-lead'), copy.lead);
    setText(guidance, copy.guidance);
    guidance.hidden = copy.guidance === '';

    recheck?.addEventListener('click', () => {
        invalidateAvailability();
        requestReopen();
        popup.complete(context().POPUP_RESULT.CANCELLED);
    });

    return () => {};
}
