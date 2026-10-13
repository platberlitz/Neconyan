const CARD_SCRIPT_TAG_PATTERN = /<\s*(?:script|iframe)(?:\s|>)/i;

export const CARD_SCRIPT_MARKER_TAG = 'custom-card-script-marker';
export const MAX_STASHED_CARD_SCRIPTS = 200;

const cardScriptSnapshots = new Map();
const shownCardScriptToastKeys = new Set();

function normalizeMessageId(messageId) {
    if (messageId === null || messageId === undefined || messageId === '') {
        return null;
    }

    const normalized = Number(messageId);
    return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

export function containsEmbeddedCardScript(html) {
    const value = String(html ?? '');
    if (!CARD_SCRIPT_TAG_PATTERN.test(value)) return false;
    const template = document.createElement('template');
    template.innerHTML = value;
    return Array.from(template.content.querySelectorAll('script, iframe')).some(element => !element.closest('pre, code, template') && (element.tagName !== 'SCRIPT' || /<\/script\s*>/i.test(value)));
}

export function hashCardScriptHtml(html) {
    const value = String(html ?? '');
    let hash = 2166136261;

    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function rememberCardScript(messageId, html, { scopeKey = '', blocks = [] } = {}) {
    const normalizedMessageId = normalizeMessageId(messageId);
    const htmlString = String(html ?? '');

    if (normalizedMessageId === null) return null;
    if (!blocks.length && !containsEmbeddedCardScript(htmlString)) {
        forgetCardScript(normalizedMessageId);
        return null;
    }

    const hash = hashCardScriptHtml(htmlString + JSON.stringify(blocks));
    const existingSnapshot = cardScriptSnapshots.get(normalizedMessageId);

    if (existingSnapshot?.hash === hash && existingSnapshot.html === htmlString && existingSnapshot.scopeKey === String(scopeKey)) {
        cardScriptSnapshots.delete(normalizedMessageId);
        cardScriptSnapshots.set(normalizedMessageId, existingSnapshot);
        return existingSnapshot;
    }

    const snapshot = { html: htmlString, hash, scopeKey: String(scopeKey), blocks };
    cardScriptSnapshots.delete(normalizedMessageId);
    cardScriptSnapshots.set(normalizedMessageId, snapshot);

    while (cardScriptSnapshots.size > MAX_STASHED_CARD_SCRIPTS) {
        const oldestKey = cardScriptSnapshots.keys().next().value;
        cardScriptSnapshots.delete(oldestKey);
    }

    return snapshot;
}

export function markCardScriptHtml(html, messageId, { scopeKey = '', fencedPages = [] } = {}) {
    let htmlString = String(html ?? '');
    const blocks = [];
    let sandboxHtml = htmlString;
    const directScript = containsEmbeddedCardScript(htmlString);
    if (fencedPages.length) {
        const template = document.createElement('template');
        template.innerHTML = htmlString;
        Array.from(template.content.querySelectorAll('pre')).forEach((pre, index) => {
            const code = pre.querySelector('code');
            if (!code || (code.className && !/^(?:html|language-html)(?:\s|$)/i.test(code.className))) return;
            const source = fencedPages[Number(pre.dataset.cardScriptFenced)];
            if (typeof source !== 'string' || source.replace(/\r\n?/g, '\n').trim() !== code.textContent.trim()) return;
            blocks.push({ html: source, index });
            pre.dataset.cardScriptBlock = String(blocks.length - 1);
            if (directScript) {
                const page = document.createElement('template');
                page.innerHTML = source;
                pre.replaceWith(page.content);
            }
        });
        if (blocks.length) {
            if (directScript) sandboxHtml = template.innerHTML;
            else htmlString = sandboxHtml = template.innerHTML;
        }
    }
    const snapshot = rememberCardScript(messageId, sandboxHtml, { scopeKey, blocks: directScript ? [] : blocks });

    if (!snapshot) {
        return htmlString;
    }

    return `${htmlString}<${CARD_SCRIPT_MARKER_TAG} data-msg-id="${Number(messageId)}" data-card-script-hash="${snapshot.hash}" data-card-script-scope="${escapeAttribute(snapshot.scopeKey)}"></${CARD_SCRIPT_MARKER_TAG}>`;
}

export function forgetCardScript(messageId) {
    cardScriptSnapshots.delete(normalizeMessageId(messageId));
}

export function protectCardScriptBlocks(text) {
    const source = String(text ?? '');
    if (!/<(?:script|style|iframe)\b|^ {0,3}(?:`{3,}|~{3,})/im.test(source)) return { text: source, fencedPages: [], restore: html => html };
    const saved = [];
    const replacements = [];
    let prefix = `neconyan-card-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}-`;
    while (source.includes(prefix)) prefix += 'x';
    // Scan code ranges before protecting complete raw-text elements, including multiline scripts.
    const excluded = [];
    const fencedPages = [];
    let activeFence = null;
    let position = 0;
    for (const line of source.split('\n')) {
        const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (match) {
            if (!activeFence) activeFence = { token: match[1], start: position, contentStart: position + line.length + 1, language: line.slice(match[0].length).trim().toLowerCase() };
            else if (match[1][0] === activeFence.token[0] && match[1].length >= activeFence.token.length && /^\s*$/.test(line.slice(match[0].length))) {
                excluded.push([activeFence.start, position + line.length]);
                const page = source.slice(activeFence.contentStart, position).replace(/\n$/, '');
                if (['', 'html'].includes(activeFence.language) && /<(?:html\b|body\b|!doctype\s+html\b)/i.test(page)) {
                    const index = fencedPages.length;
                    fencedPages.push(page);
                    const placeholder = `<!--${prefix}${saved.length}-->`;
                    const block = `<pre data-card-script-fenced="${index}"><code>${escapeAttribute(page)}</code></pre>`;
                    saved.push({ placeholder, block });
                    replacements.push({ start: activeFence.start, end: position + line.length, placeholder });
                }
                activeFence = null;
            }
        } else if (!activeFence && /^(?: {4}|\t)/.test(line)) excluded.push([position, position + line.length]);
        position += line.length + 1;
    }
    if (activeFence) excluded.push([activeFence.start, source.length]);
    for (const match of source.matchAll(/(`+)[\s\S]*?\1|<!--[\s\S]*?-->/g)) excluded.push([match.index, match.index + match[0].length]);
    for (const match of source.matchAll(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)) {
        if (excluded.some(([start, end]) => match.index >= start && match.index < end)) continue;
        const placeholder = `<!--${prefix}${saved.length}-->`;
        saved.push({ placeholder, block: match[0] });
        replacements.push({ start: match.index, end: match.index + match[0].length, placeholder });
    }
    const result = replacements.sort((a, b) => b.start - a.start).reduce((output, item) => output.slice(0, item.start) + item.placeholder + output.slice(item.end), source);
    return { text: result, fencedPages, restore: html => saved.reduce((output, { placeholder, block }) => output.replaceAll(placeholder, () => block), html) };
}

function escapeAttribute(value) {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function getCardScriptSnapshot(messageId) {
    const normalizedMessageId = normalizeMessageId(messageId);
    return normalizedMessageId === null ? null : cardScriptSnapshots.get(normalizedMessageId) ?? null;
}

export function buildCardScriptToastKey(chatId, messageId, hash) {
    return `${chatId ?? ''}:${messageId}:${hash}`;
}

export function hasCardScriptToastBeenShown(toastKey) {
    return shownCardScriptToastKeys.has(toastKey);
}

export function markCardScriptToastShown(toastKey) {
    shownCardScriptToastKeys.add(toastKey);
}

export function getStoredCardScriptCount() {
    return cardScriptSnapshots.size;
}

export function getShownCardScriptToastCount() {
    return shownCardScriptToastKeys.size;
}

export function forgetAllCardScripts() {
    cardScriptSnapshots.clear();
    shownCardScriptToastKeys.clear();
}
