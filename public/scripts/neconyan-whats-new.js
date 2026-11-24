import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';

export const WHATS_NEW_SEEN_KEY = 'neconyan-whats-new-seen';
export const WHATS_NEW_BUTTON_SELECTOR = '[data-action="whats-new"]';
const WHATS_NEW_CACHE_MS = 5 * 60 * 1000;
const PULL_REQUEST_URL = 'https://github.com/platberlitz/Neconyan/pull/';

/** @type {{at: number, promise: Promise<WhatsNew | null>} | null} */
let cachedSummary = null;

/**
 * @typedef {object} WhatsNew
 * @property {string} version Running version
 * @property {'preview' | 'release'} channel Staging or feature preview, or a release
 * @property {string | null} branch Git branch, if any
 * @property {string[]} highlights Plain-language highlights for this version
 * @property {{number: number, date: string, title: string}[]} changes Merged pull requests, oldest first
 * @property {{version: string, highlights: string[]} | null} previous Latest older version with highlights
 * @property {string} digest Changes when the version or its highlights change
 */

/**
 * Loads the What's new summary from the server.
 * @param {{fresh?: boolean}} [options] Skip the short cache
 * @returns {Promise<WhatsNew | null>} Summary, or null when it cannot be read
 */
export function loadWhatsNew({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && cachedSummary && now - cachedSummary.at < WHATS_NEW_CACHE_MS) {
        return cachedSummary.promise;
    }
    const promise = fetch('/api/whats-new', { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : null))
        .catch(() => null);
    cachedSummary = { at: now, promise };
    promise.then((summary) => {
        if (!summary && cachedSummary?.promise === promise) {
            cachedSummary = null;
        }
    });
    return promise;
}

/**
 * Says whether the summary has highlights the user has not opened yet.
 * @param {WhatsNew | null} summary Summary from the server
 * @param {string | null} seenDigest Digest saved when the user last opened What's new
 * @returns {boolean} True when the dot should show
 */
export function hasUnseenHighlights(summary, seenDigest) {
    return Boolean(summary?.digest && summary.highlights?.length && seenDigest !== summary.digest);
}

/**
 * Shows or hides the dot on every What's new button inside a root.
 * @param {ParentNode} root Element holding the buttons
 * @param {boolean} unseen Whether there is something new
 */
function setButtonsUnseen(root, unseen) {
    root.querySelectorAll(WHATS_NEW_BUTTON_SELECTOR).forEach((button) => {
        if (unseen) {
            button.setAttribute('data-unseen', 'true');
            button.setAttribute('title', t`New changes since you last looked`);
        } else {
            button.removeAttribute('data-unseen');
            button.removeAttribute('title');
        }
    });
}

/**
 * Updates the dot on the What's new buttons inside a Home panel.
 * @param {ParentNode} root Home panel
 * @returns {Promise<void>}
 */
export async function syncWhatsNewButtons(root) {
    if (!root?.querySelector?.(WHATS_NEW_BUTTON_SELECTOR)) {
        return;
    }
    const summary = await loadWhatsNew();
    setButtonsUnseen(root, hasUnseenHighlights(summary, accountStorage.getItem(WHATS_NEW_SEEN_KEY)));
}

/**
 * Appends changelog inline markdown (bold and code) to an element without parsing HTML.
 * @param {HTMLElement} target Element to fill
 * @param {string} text Inline markdown
 */
export function appendInlineMarkdown(target, text) {
    for (const part of String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
        if (!part) {
            continue;
        }
        if (/^`[^`]+`$/.test(part)) {
            const code = document.createElement('code');
            code.textContent = part.slice(1, -1);
            target.append(code);
        } else if (/^\*\*[^*]+\*\*$/.test(part)) {
            const strong = document.createElement('strong');
            strong.textContent = part.slice(2, -2);
            target.append(strong);
        } else {
            target.append(document.createTextNode(part));
        }
    }
}

/**
 * Builds a bullet list of highlights.
 * @param {string[]} highlights Highlights as inline markdown
 * @returns {HTMLUListElement} List
 */
function buildHighlightList(highlights) {
    const list = document.createElement('ul');
    list.className = 'neconyan-whats-new-list';
    list.setAttribute('data-i18n-ignore', '');
    for (const highlight of highlights) {
        const item = document.createElement('li');
        appendInlineMarkdown(item, highlight);
        list.append(item);
    }
    return list;
}

/**
 * Builds the collapsed list of every merged change, newest first.
 * @param {WhatsNew} summary Summary
 * @returns {HTMLDetailsElement | null} Details element, or null without changes
 */
function buildChangeDetails(summary) {
    if (!summary.changes?.length) {
        return null;
    }
    const details = document.createElement('details');
    details.className = 'neconyan-whats-new-changes';
    const label = document.createElement('summary');
    label.textContent = t`Every merged change (${summary.changes.length})`;
    details.append(label);

    const list = document.createElement('ol');
    list.reversed = true;
    list.setAttribute('data-i18n-ignore', '');
    for (const change of [...summary.changes].reverse()) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `${PULL_REQUEST_URL}${change.number}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `#${change.number}`;
        const title = document.createElement('span');
        title.className = 'neconyan-whats-new-change-title';
        title.textContent = change.title;
        const date = document.createElement('time');
        date.dateTime = change.date;
        date.textContent = change.date;
        item.append(title, ' ', link, ' ', date);
        list.append(item);
    }
    details.append(list);
    return details;
}

/**
 * Builds the What's new page.
 * @param {WhatsNew} summary Summary
 * @returns {HTMLElement} Page
 */
export function buildWhatsNewPage(summary) {
    const page = document.createElement('section');
    page.className = 'neconyan-whats-new';
    page.setAttribute('aria-labelledby', 'neconyan-whats-new-title');

    const heading = document.createElement('h2');
    heading.id = 'neconyan-whats-new-title';
    heading.textContent = t`What's new in ${summary.version}`;
    page.append(heading);

    if (summary.channel === 'preview') {
        const note = document.createElement('p');
        note.className = 'neconyan-whats-new-preview';
        note.setAttribute('role', 'note');
        note.textContent = summary.branch && summary.branch !== 'staging'
            ? t`Preview build from ${summary.branch}, not released yet. This list grows as changes land.`
            : t`${summary.version} staging preview, not released yet. This list grows as changes land.`;
        page.append(note);
    }

    if (summary.highlights?.length) {
        page.append(buildHighlightList(summary.highlights));
    } else {
        const empty = document.createElement('p');
        empty.className = 'neconyan-whats-new-empty';
        empty.textContent = t`Nothing written up for ${summary.version} yet.`;
        page.append(empty);
        if (summary.previous?.highlights?.length) {
            const previousHeading = document.createElement('h3');
            previousHeading.textContent = t`New in ${summary.previous.version}`;
            page.append(previousHeading, buildHighlightList(summary.previous.highlights));
        }
    }

    const changes = buildChangeDetails(summary);
    if (changes) {
        page.append(changes);
    }
    return page;
}

/**
 * Opens What's new and marks its highlights as seen.
 * @returns {Promise<void>}
 */
export async function openWhatsNew() {
    const summary = await loadWhatsNew({ fresh: true });
    if (!summary) {
        throw new Error('What\'s new is not available');
    }
    accountStorage.setItem(WHATS_NEW_SEEN_KEY, summary.digest);
    setButtonsUnseen(document, false);
    await callGenericPopup(buildWhatsNewPage(summary), POPUP_TYPE.TEXT, '', {
        okButton: t`Done`,
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        onOpen: (popup) => {
            popup.dlg?.classList.add('neconyan-whats-new-dialog');
        },
    });
}
