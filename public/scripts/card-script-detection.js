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

const SCRIPT_TARGET_CALL_PATTERN = /\b(getElementById|getElementsByClassName|querySelector(?:All)?)\s*\(\s*(?:(['"])((?:(?!\2)[^\\\n]|\\.)*)\2|`([^`$]*)`)?/g;
const WHOLE_DOCUMENT_ACCESS_PATTERN = /(?<![\w$.])(?:document\s*\.\s*(?:body|documentElement|write(?:ln)?|getElementsByTagName|forms|images|links)\b|getElementsByTagName\s*\()/;

// Ids and classes a direct script reaches for, or null when it acts on the whole document.
function readScriptTargets(source) {
    if (WHOLE_DOCUMENT_ACCESS_PATTERN.test(source)) return null;
    const targets = new Set();
    for (const match of source.matchAll(SCRIPT_TARGET_CALL_PATTERN)) {
        const value = match[3] ?? match[4];
        if (value === undefined) return null;
        if (match[1] === 'getElementById') targets.add(`#${value}`);
        else if (match[1] === 'getElementsByClassName') value.split(/\s+/).filter(Boolean).forEach(name => targets.add(`.${name}`));
        else for (const part of value.split(',')) {
            const names = part.match(/[#.][\w-]+/g);
            if (!names) return null;
            names.forEach(name => targets.add(name));
        }
    }
    return targets.size ? targets : null;
}

function containsScriptTarget(node, targets) {
    if (!node.tagName) return false;
    return [node, ...Array.from(node.querySelectorAll('[id], [class]'))].some(element => {
        const id = element.getAttribute('id');
        if (id && targets.has(`#${id}`)) return true;
        return String(element.getAttribute('class') ?? '').split(/\s+/).some(name => name && targets.has(`.${name}`));
    });
}

// Groups each live script with the widget it drives, so the rest of the message stays in the chat.
function groupDirectCardScripts(content, allowScripts) {
    const nodes = Array.from(content.childNodes);
    const isLive = element => !element.closest('pre, code, template') && (element.tagName !== 'SCRIPT' || allowScripts);
    const groups = [];
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (!node.tagName) continue;
        const ownTag = /^(?:SCRIPT|IFRAME)$/.test(node.tagName);
        if (ownTag ? !isLive(node) : !Array.from(node.querySelectorAll('script, iframe')).some(isLive)) continue;
        let targets = new Set();
        if (node.tagName === 'SCRIPT') {
            targets = readScriptTargets(node.textContent);
            if (!targets) return null;
        } else {
            // A script inside its widget may only reach that widget, or earlier siblings it names.
            for (const script of Array.from(node.querySelectorAll('script')).filter(isLive)) {
                if (WHOLE_DOCUMENT_ACCESS_PATTERN.test(script.textContent)) return null;
                readScriptTargets(script.textContent)?.forEach(target => targets.add(target));
            }
        }
        const previous = groups[groups.length - 1];
        const floor = previous ? previous.end + 1 : 0;
        let start = index;
        if (targets.size) for (let cursor = index - 1; cursor >= floor; cursor--) {
            if (containsScriptTarget(nodes[cursor], targets)) start = cursor;
        }
        const reachesPrevious = targets.size && previous && nodes.slice(previous.start, previous.end + 1).some(sibling => containsScriptTarget(sibling, targets));
        if (reachesPrevious) previous.end = index;
        else if (node.tagName !== 'SCRIPT') groups.push({ start, end: index });
        else if (start === index) return null;
        else groups.push({ start, end: index });
    }
    return groups.map(({ start, end }) => nodes.slice(start, end + 1));
}

export function markCardScriptHtml(html, messageId, { scopeKey = '', fencedPages = [] } = {}) {
    let htmlString = String(html ?? '');
    const blocks = [];
    let sandboxHtml = htmlString;
    const directScript = containsEmbeddedCardScript(htmlString);
    let wholeMessage = false;
    if (fencedPages.length || directScript) {
        const template = document.createElement('template');
        template.innerHTML = htmlString;
        const fences = [];
        if (fencedPages.length) Array.from(template.content.querySelectorAll('pre')).forEach((pre, index) => {
            const code = pre.querySelector('code');
            if (!code || (code.className && !/^(?:html|language-html)(?:\s|$)/i.test(code.className))) return;
            const source = fencedPages[Number(pre.dataset.cardScriptFenced)];
            if (typeof source !== 'string' || source.replace(/\r\n?/g, '\n').trim() !== code.textContent.trim()) return;
            fences.push({ pre, source, index });
        });
        const groups = directScript ? groupDirectCardScripts(template.content, /<\/script\s*>/i.test(htmlString)) : [];
        wholeMessage = !groups || groups.some(group => fences.some(({ pre }) => group.some(node => node === pre || node.contains?.(pre))));
        if (wholeMessage) {
            // Scripts that act on the whole document keep the whole message as their page.
            fences.forEach(({ pre, source }) => {
                const page = document.createElement('template');
                page.innerHTML = source;
                pre.replaceWith(page.content);
            });
            if (fences.length) sandboxHtml = template.innerHTML;
        } else {
            fences.forEach(({ pre, source, index }) => {
                blocks.push({ html: source, index });
                pre.dataset.cardScriptBlock = String(blocks.length - 1);
            });
            const styles = Array.from(template.content.childNodes).filter(node => node.tagName === 'STYLE').map(node => `<style>${node.textContent}</style>`).join('');
            groups.forEach(group => {
                const wrapper = document.createElement('div');
                group[group.length - 1].after(wrapper);
                group.forEach(node => wrapper.appendChild(node));
                blocks.push({ html: styles + wrapper.innerHTML, index: blocks.length });
                wrapper.dataset.cardScriptBlock = String(blocks.length - 1);
            });
            if (blocks.length) htmlString = template.innerHTML;
            if (fences.length && !groups.length) sandboxHtml = htmlString;
        }
    }
    const snapshot = rememberCardScript(messageId, sandboxHtml, { scopeKey, blocks: wholeMessage ? [] : blocks });

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
