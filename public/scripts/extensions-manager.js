/**
 * Helpers for the 'Manage extensions' window: grouping, one-line descriptions,
 * search and filter matching, and the live wiring for search, filters and the
 * pending-changes notice. Row and window markup is built in extensions.js.
 */

/** Plain one-line descriptions for extensions whose manifest has none. Keyed by folder name. */
const BUILT_IN_EXTENSION_DESCRIPTIONS = Object.freeze({
    'assets': 'Browse and download extra backgrounds, characters, sounds and extensions.',
    'attachments': 'Attach files and web pages to a chat or character so replies can draw on them.',
    'caption': 'Describes the images you send, so models that only read text can follow along.',
    'connection-manager': 'Saves connection profiles, so you can switch API, model and preset in one go.',
    'expressions': 'Shows character sprites that change with the mood of each reply.',
    'gallery': 'Keeps a gallery of images for each character.',
    'guided-generations': 'Steer the next reply, swipe or impersonation with a short instruction.',
    'in-chat-agents': 'Agents that run alongside each reply to track details, add notes or tidy formatting.',
    'input-history': 'Press Up or Down in the message box to bring back things you sent before.',
    'prompt-inspector': 'Shows the full prompt before it is sent, so you can check or edit it.',
    'quick-image-gen': 'Makes images from the chat in one tap, using your image settings.',
    'quick-reply': 'Buttons above the message box that send saved messages or run scripts.',
    'regex': 'Find-and-replace rules that tidy messages and prompts automatically.',
    'token-counter': 'Counts how many tokens a piece of text uses.',
    'translate': 'Translates messages into your language, automatically or when you ask.',
    'tts': 'Reads replies aloud with a text-to-speech voice.',
    'vectors': 'Finds older messages and files that match the current chat, and adds them to the prompt.',
    'neconyan-deep-swipe': 'Swipe for new versions of your own messages too, and move between swipes quickly.',
});

export const EXTENSION_MANAGER_FILTERS = Object.freeze(['all', 'on', 'off']);

/**
 * Gets the folder name of an extension, lower-cased, without the 'third-party/' prefix.
 * @param {string} name Extension name, for example 'third-party/Neconyan-Deep-Swipe' or 'vectors'
 * @returns {string}
 */
export function getExtensionManagerKey(name) {
    return String(name ?? '').replace(/^\/?third-party\//i, '').split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
}

/**
 * Sorts an extension type into one of the three sections of the window.
 * @param {string} type Extension type from getExtensionType()
 * @returns {'neconyan' | 'builtin' | 'installed'}
 */
export function getExtensionManagerGroup(type) {
    if (type === 'native') return 'neconyan';
    if (type === 'local' || type === 'global') return 'installed';
    return 'builtin';
}

/**
 * Gets the one-line description shown under an extension's name.
 * The manifest's own description wins; built-in extensions fall back to a plain line kept here.
 * @param {string} name Extension name
 * @param {object} [manifest] Extension manifest
 * @returns {string} Plain or manifest-provided text, unsanitised
 */
export function getExtensionManagerDescription(name, manifest) {
    const own = typeof manifest?.description === 'string' ? manifest.description.trim() : '';
    if (own) return own;
    return BUILT_IN_EXTENSION_DESCRIPTIONS[getExtensionManagerKey(name)] ?? '';
}

/**
 * Lower-cases text, strips accents and collapses spaces, so searches ignore case and accents.
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseExtensionSearchText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Decides whether a row is shown for the current search and filter.
 * Every word of the query has to appear somewhere in the row's text.
 * @param {{ searchText: string, enabled: boolean }} row
 * @param {{ query?: string, state?: string }} filter
 * @returns {boolean}
 */
export function matchesExtensionManagerFilter(row, { query = '', state = 'all' } = {}) {
    if (state === 'on' && !row.enabled) return false;
    if (state === 'off' && row.enabled) return false;
    const words = normaliseExtensionSearchText(query).split(' ').filter(Boolean);
    if (words.length === 0) return true;
    const haystack = normaliseExtensionSearchText(row.searchText);
    return words.every(word => haystack.includes(word));
}

/**
 * Counts switches that no longer match the state they had when the window opened.
 * @param {Iterable<{ initial: boolean, checked: boolean }>} toggles
 * @returns {number}
 */
export function countPendingExtensionChanges(toggles) {
    let count = 0;
    for (const toggle of toggles) {
        if (Boolean(toggle.initial) !== Boolean(toggle.checked)) count++;
    }
    return count;
}

/**
 * Writes a switch's on or off state onto its row, label and legacy classes.
 * @param {HTMLInputElement} input The switch inside `.extension_toggle`
 * @param {{ on: string, off: string }} labels Visible state words
 */
export function syncExtensionToggleState(input, labels) {
    const enabled = input.checked;
    input.classList.toggle('toggle_disable', enabled);
    input.classList.toggle('toggle_enable', !enabled);
    input.classList.toggle('checkbox_disabled', !enabled);
    const row = input.closest('.extension_block');
    if (row?.dataset) {
        row.dataset.enabled = String(enabled);
        const nameWrapper = row.querySelector('.extension_text_block .extension_enabled, .extension_text_block .extension_disabled');
        nameWrapper?.classList.toggle('extension_enabled', enabled);
        nameWrapper?.classList.toggle('extension_disabled', !enabled);
    }
    const stateLabel = input.closest('.extension_toggle')?.querySelector('.extension_toggle_state');
    if (stateLabel) stateLabel.textContent = enabled ? labels.on : labels.off;
}

/**
 * Wires search, the All/On/Off filter, section counts and the pending-changes notice.
 * @param {HTMLElement} root The `.extensions_info` element
 * @param {object} options
 * @param {(count: number) => string} options.pendingText Builds the notice text for a number of changes
 * @param {{ on: string, off: string }} options.stateLabels Visible state words for the switches
 * @param {(count: number) => void} [options.onPendingChange] Called whenever the number of pending changes moves
 * @returns {{ refresh: () => void, getPendingCount: () => number }}
 */
export function bindExtensionManager(root, { pendingText, stateLabels, onPendingChange }) {
    const searchInput = root.querySelector('.nn-ext-search input');
    const filterButtons = Array.from(root.querySelectorAll('.nn-ext-filter[data-filter]'));
    const pendingNotice = root.querySelector('.nn-ext-pending');
    const pendingNoticeText = pendingNotice?.querySelector('.nn-ext-pending-text');
    const noMatches = root.querySelector('.nn-ext-no-matches');
    const initialStates = new Map();
    let state = 'all';
    let lastPendingCount = 0;

    const getToggles = () => Array.from(root.querySelectorAll('.extension_block .extension_toggle input[type="checkbox"]:not(:disabled)'));
    for (const input of getToggles()) initialStates.set(input, input.checked);

    const getPendingCount = () => countPendingExtensionChanges(getToggles()
        .map(input => ({ initial: initialStates.get(input) ?? input.checked, checked: input.checked })));

    const updatePending = () => {
        const count = getPendingCount();
        if (pendingNotice instanceof HTMLElement) {
            pendingNotice.hidden = count === 0;
            if (pendingNoticeText) pendingNoticeText.textContent = count > 0 ? pendingText(count) : '';
        }
        if (count !== lastPendingCount) {
            lastPendingCount = count;
            onPendingChange?.(count);
        }
    };

    const applyFilter = () => {
        const query = searchInput instanceof HTMLInputElement ? searchInput.value : '';
        let visibleTotal = 0;
        const counts = { all: 0, on: 0, off: 0 };
        for (const section of root.querySelectorAll('.nn-ext-section')) {
            let visibleInSection = 0;
            const rows = Array.from(section.querySelectorAll('.extension_block'));
            for (const row of rows) {
                if (!(row instanceof HTMLElement)) continue;
                const enabled = row.dataset.enabled === 'true';
                const searchText = `${row.querySelector('.extension_text_block')?.textContent ?? ''} ${row.dataset.name ?? ''}`;
                if (matchesExtensionManagerFilter({ searchText, enabled }, { query })) {
                    counts.all++;
                    counts[enabled ? 'on' : 'off']++;
                }
                const visible = matchesExtensionManagerFilter({ searchText, enabled }, { query, state });
                row.hidden = !visible;
                if (visible) visibleInSection++;
            }
            visibleTotal += visibleInSection;
            const count = section.querySelector('.nn-ext-count');
            if (count) count.textContent = String(visibleInSection);
            const filtering = Boolean(query.trim()) || state !== 'all';
            // Keep the 'Installed by you' empty state and toolbar visible when nothing is filtered out.
            section.toggleAttribute('hidden', filtering && visibleInSection === 0);
        }
        for (const button of filterButtons) {
            const count = button.querySelector('.nn-ext-filter-count');
            if (count) count.textContent = String(counts[button.dataset.filter] ?? 0);
        }
        if (noMatches instanceof HTMLElement) noMatches.hidden = visibleTotal > 0 || (!query.trim() && state === 'all');
    };

    searchInput?.addEventListener('input', applyFilter);
    searchInput?.addEventListener('keydown', event => {
        if (event.key === 'Escape' && searchInput instanceof HTMLInputElement && searchInput.value) {
            event.preventDefault();
            event.stopPropagation();
            searchInput.value = '';
            applyFilter();
        }
    });
    for (const button of filterButtons) {
        button.addEventListener('click', () => {
            state = EXTENSION_MANAGER_FILTERS.includes(button.dataset.filter) ? button.dataset.filter : 'all';
            for (const other of filterButtons) other.setAttribute('aria-pressed', String(other === button));
            applyFilter();
        });
    }
    root.addEventListener('change', event => {
        if (event.target instanceof HTMLInputElement && event.target.closest('.extension_toggle')) {
            syncExtensionToggleState(event.target, stateLabels);
            applyFilter();
            updatePending();
        }
    });

    const refresh = () => {
        for (const input of getToggles()) syncExtensionToggleState(input, stateLabels);
        applyFilter();
        updatePending();
    };
    refresh();
    return { refresh, getPendingCount };
}
