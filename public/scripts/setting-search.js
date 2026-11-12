import { debounce } from './utils.js';
import { debounce_timeout } from './constants.js';

/**
 * Search for settings that match the search string and highlight them.
 */
function searchSettings() {
    const searchString = String($('#settingsSearch').val());
    const searchableText = document.getElementById('user-settings-block-content'); // Get the HTML block
    const matches = searchableText && searchString.trim() !== ''
        ? findMatchingElements(searchableText, searchString)
        : new Set();
    // Neconyan: only touch elements whose highlight changes. Clearing and re-adding every
    // highlight per key restyled the whole settings panel twice.
    for (const element of document.querySelectorAll('.highlighted')) {
        if (!matches.has(element)) {
            element.classList.remove('highlighted');
        }
    }
    for (const element of matches) {
        element.classList.add('highlighted');
    }
}

/**
 * Collect the parents of text nodes that match the search string, skipping headers.
 * @param {HTMLElement} root Settings block HTML element
 * @param {string} searchString Search string
 * @returns {Set<HTMLElement>} Elements to highlight
 */
function findMatchingElements(root, searchString) {
    const needle = searchString.toLowerCase();
    const matches = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                // h4 subtrees are never searched; other elements are walked through.
                return /** @type {Element} */ (node).tagName === 'H4' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue;
        const parent = node.parentElement;
        if (!parent || text.trim() === '' || !text.toLowerCase().includes(needle) || parent.closest('h4, h3')) {
            continue;
        }
        matches.add(parent);
    }

    return matches;
}

export function initSettingsSearch() {
    const debouncedSearch = debounce(searchSettings, debounce_timeout.quick);
    $('#settingsSearch').on('input', debouncedSearch).on('change', searchSettings);
}
