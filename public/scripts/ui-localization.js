// Localise known UI captions only, never editable values or user-authored messages.
const userText = [
    '[data-i18n-ignore]', '[translate="no"]', '.notranslate', '[contenteditable="true"]',
    'script', 'style', 'pre', 'code', 'textarea',
    '#chat .mes', '.mes_text', '.mes_reasoning', '.sb-conversation-message', '.sb-conversation-message-text',
    '.ch_name', '.name_text', '.characterName', '.chatName', '.chatMessage', '.tag', '.tag_name',
    '.persona_name', '#persona_selected_name', '.sb-persona-option-name', '.sb-conversation-persona-option-name', '.sb-conversation-reply-name',
    '.sb-chat-file-preview', '.sb-conversation-file-name', '.sb-import-file-name',
].join(',');
const attributes = ['title', 'placeholder', 'aria-label'];
const nonEmptyDictionaries = new WeakSet();

function translatesOwnText(element) {
    const keys = element.getAttribute('data-i18n');
    return keys !== null && keys.split(';').some(key => key.trim() && !key.trim().startsWith('['));
}

const templateIndexes = new WeakMap();
const placeholder = /\$\{(\d+)\}/g;

// Captions built with t`` before the locale loaded arrive filled in but untranslated, so match them against their ${n} keys.
function templateIndex(dictionary) {
    let index = templateIndexes.get(dictionary);
    if (index) return index;
    index = { byPrefix: new Map(), leading: [] };
    for (const [key, value] of Object.entries(dictionary)) {
        if (!key.includes('${') || value === key || typeof value !== 'string') continue;
        const parts = key.split(placeholder);
        if (parts.length < 3 || parts.filter((_, i) => i % 2 === 0).join('').replace(/\s/g, '').length < 3) continue;
        const order = parts.filter((_, i) => i % 2 === 1);
        const pattern = parts.map((part, i) => i % 2 ? '(.+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
        const template = { expression: new RegExp(`^${pattern}$`, 's'), order, value };
        const prefix = parts[0].slice(0, 2);
        if (prefix.length < 2) index.leading.push(template);
        else index.byPrefix.set(prefix, [...(index.byPrefix.get(prefix) || []), template]);
    }
    templateIndexes.set(dictionary, index);
    return index;
}

function lookup(key, dictionary) {
    if (Object.hasOwn(dictionary, key)) return dictionary[key] !== key ? dictionary[key] : null;
    if (!key.length) return null;
    const index = templateIndex(dictionary);
    for (const template of [...(index.byPrefix.get(key.slice(0, 2)) || []), ...index.leading]) {
        const match = template.expression.exec(key);
        if (!match) continue;
        const values = Object.fromEntries(template.order.map((slot, i) => [slot, Object.hasOwn(dictionary, match[i + 1]) ? dictionary[match[i + 1]] : match[i + 1]]));
        return template.value.replace(placeholder, (whole, slot) => values[slot] ?? whole);
    }
    return null;
}

function localizeText(text, dictionary) {
    const key = text.data.trim();
    const value = key && lookup(key, dictionary);
    if (value) text.data = text.data.replace(key, value);
}

function localizeAttributes(element, dictionary) {
    for (const attribute of attributes) {
        const key = element.getAttribute(attribute)?.trim();
        const value = key && lookup(key, dictionary);
        if (value) element.setAttribute(attribute, value);
    }
}

export function localizeControls(root, dictionary) {
    if (!root?.querySelectorAll) return;
    if (!nonEmptyDictionaries.has(dictionary)) {
        if (!Object.keys(dictionary).length) return;
        nonEmptyDictionaries.add(dictionary);
    }
    if (root.closest?.(userText)) return;
    if (root.nodeType === Node.ELEMENT_NODE) localizeAttributes(root, dictionary);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
            return node.matches(userText) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
    });
    let node;
    while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.parentElement && !translatesOwnText(node.parentElement)) localizeText(node, dictionary);
            continue;
        }
        localizeAttributes(node, dictionary);
    }
}
