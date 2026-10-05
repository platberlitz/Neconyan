import { DOMPurify, showdown } from '../../lib.js';
import { t, translate } from '../i18n.js';
import { headingSections, splitNoteFrontmatter } from './folding.js';
import { userPhrase } from './user-text.js';

const ESCAPED_OPEN = '\uE000';
const ESCAPED_EMBED = '\uE001';
const SAFE_SCHEMES = /^(?:https?:|mailto:)/i;
const WIKI = /(!?)\[\[([^\]\n]{1,400})\]\]/g;
const CAPTION_ATTRIBUTES = ['title', 'aria-label', 'placeholder'];
// What the reader adds itself: its own controls, and caption attributes it writes onto the note's elements. Everything else in a
// rendered note is the note's own. The note's HTML keeps its classes, so a class name cannot tell the two apart.
const readerControls = new WeakSet();
const readerAttributes = new WeakMap();

function readerControl(element) {
    readerControls.add(element);
    return element;
}

let converter = null;

function markdownConverter() {
    if (converter) return converter;
    converter = new showdown.Converter({
        tables: true,
        strikethrough: true,
        tasklists: true,
        ghCodeBlocks: true,
        simpleLineBreaks: false,
        openLinksInNewWindow: false,
        noHeaderId: true,
        literalMidWordUnderscores: true,
        disableForced4SpacesIndentedSublists: true,
    });
    return converter;
}

export function splitFrontmatterText(text) {
    const { frontmatter, body, bodyStart } = splitNoteFrontmatter(text);
    return { frontmatter, body, bodyStart };
}

export function parseWikiInner(inner) {
    const [targetPart, ...labelParts] = String(inner).split('|');
    const label = labelParts.length ? labelParts.join('|').trim() : '';
    const hash = targetPart.indexOf('#');
    const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const fragment = hash >= 0 ? targetPart.slice(hash + 1).trim() : '';
    return { target, fragment, label };
}

function folderOf(relative) {
    const index = String(relative ?? '').lastIndexOf('/');
    return index < 0 ? '' : relative.slice(0, index);
}

export function resolveRelativePath(fromPath, href) {
    const parts = folderOf(fromPath).split('/').filter(Boolean);
    let target = String(href).split(/[?#]/)[0];
    try {
        target = decodeURIComponent(target);
    } catch {
        return null;
    }
    if (target.startsWith('/')) return null;
    for (const segment of target.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!parts.length) return null;
            parts.pop();
        } else {
            parts.push(segment);
        }
    }
    return parts.join('/') || null;
}

function protectEscapes(markdown) {
    return markdown.replace(/\\(!?)\[\[/g, (_match, embed) => embed ? ESCAPED_EMBED : ESCAPED_OPEN);
}

function wikiNodes(text, documentRef, { embedLoading = false, noteId } = {}) {
    const fragment = documentRef.createDocumentFragment();
    let last = 0;
    let found = false;
    for (const match of text.matchAll(WIKI)) {
        found = true;
        fragment.append(documentRef.createTextNode(text.slice(last, match.index)));
        const link = parseWikiInner(match[2]);
        const element = documentRef.createElement(match[1] ? 'span' : 'a');
        if (match[1]) {
            element.className = 'notes-embed-placeholder';
            element.textContent = embedLoading ? 'Loading embedded note...' : 'Embedded note unavailable.';
            readerControl(element);
        } else {
            element.className = 'notes-wikilink';
            element.href = '#';
            element.textContent = link.label || (link.fragment ? `${link.target} › ${link.fragment}` : link.target);
        }
        if (!match[1]) {
            element.dataset.wikiTarget = link.target;
            element.dataset.wikiFragment = link.fragment;
            if (noteId) element.dataset.noteFromId = noteId;
        }
        fragment.append(element);
        last = match.index + match[0].length;
    }
    if (!found) return null;
    fragment.append(documentRef.createTextNode(text.slice(last)));
    return fragment;
}

function decorateWikiLinks(root, options) {
    const documentRef = root.ownerDocument;
    const walker = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.parentElement?.closest('code, pre, a, .notes-embed-placeholder')) return NodeFilter.FILTER_REJECT;
            return node.nodeValue.includes('[[') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
    });
    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    for (const node of targets) {
        const replacement = wikiNodes(node.nodeValue, documentRef, options);
        if (replacement) node.replaceWith(replacement);
    }
    const restore = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (restore.nextNode()) {
        const node = restore.currentNode;
        const code = node.parentElement?.closest('code, pre');
        node.nodeValue = node.nodeValue.replaceAll(ESCAPED_OPEN, code ? '\\[[' : '[[')
            .replaceAll(ESCAPED_EMBED, code ? '\\![[' : '![[');
    }
}

function decodedFragment(fragment) {
    try { return decodeURIComponent(fragment); } catch { return ''; }
}

function fixLinksAndImages(root, { notebookId, noteId, notePath, attachmentUrl }) {
    for (const anchor of root.querySelectorAll('a[href]')) {
        if (noteId) anchor.dataset.noteFromId = noteId;
        if (anchor.classList.contains('notes-wikilink')) continue;
        const href = anchor.getAttribute('href') ?? '';
        if (SAFE_SCHEMES.test(href)) {
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer nofollow';
            continue;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
            anchor.removeAttribute('href');
            anchor.classList.add('notes-link-blocked');
            anchor.title = 'This link type is not opened from notes.';
            readerAttributes.set(anchor, ['title']);
            continue;
        }
        if (href.startsWith('#')) {
            anchor.dataset.headingTarget = decodedFragment(href.slice(1));
            continue;
        }
        const relative = resolveRelativePath(notePath, href);
        if (!relative) {
            anchor.removeAttribute('href');
            continue;
        }
        if (/\.md$/i.test(relative)) {
            anchor.dataset.notePath = relative;
            anchor.dataset.wikiFragment = href.includes('#') ? decodedFragment(href.slice(href.indexOf('#') + 1)) : '';
            anchor.classList.add('notes-wikilink');
            anchor.href = '#';
        } else {
            anchor.href = attachmentUrl(notebookId, relative);
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
        }
    }
    for (const image of root.querySelectorAll('img')) {
        const source = image.getAttribute('src') ?? '';
        if (/^https?:/i.test(source)) {
            const button = root.ownerDocument.createElement('button');
            button.type = 'button';
            button.className = 'menu_button notes-external-image';
            button.dataset.externalSource = source;
            button.dataset.alt = image.getAttribute('alt') ?? '';
            if (image.alt) button.append(userPhrase`Load external image: ${image.alt}`);
            else button.textContent = 'Load external image';
            button.title = 'Loading this image contacts another website.';
            readerControl(button);
            image.replaceWith(button);
            continue;
        }
        const relative = /^[a-z][a-z0-9+.-]*:/i.test(source) ? null : resolveRelativePath(notePath, source);
        if (!relative) {
            image.remove();
            continue;
        }
        image.src = attachmentUrl(notebookId, relative);
        image.loading = 'lazy';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
    }
    for (const box of root.querySelectorAll('input[type="checkbox"]')) box.disabled = true;
    for (const table of root.querySelectorAll('table')) {
        const wrapper = root.ownerDocument.createElement('div');
        wrapper.className = 'notes-table-scroll';
        table.replaceWith(wrapper);
        wrapper.append(table);
    }
}

/** Only server-selected source ranges become preview tokens; note-authored HTML cannot make a preview control. */
export function prepareEmbedMarkdown(text, embeds, nonce = crypto.randomUUID().replaceAll('-', '')) {
    const source = String(text);
    const tokens = new Map();
    const ranges = (Array.isArray(embeds) ? embeds.slice(0, 32) : []).filter(node => Number.isInteger(node?.start) && Number.isInteger(node.end)
        && node.start >= 0 && node.end > node.start && node.end <= source.length && node.end - node.start <= 1024
        && /^!\[\[[^\]\n]+\]\]$/.test(source.slice(node.start, node.end))).sort((a, b) => a.start - b.start);
    let markdown = '';
    let offset = 0;
    for (const node of ranges) {
        if (node.start < offset) continue;
        const token = `\uE100NNembed${nonce}${tokens.size}NN\uE101`;
        tokens.set(token, node);
        markdown += source.slice(offset, node.start) + token;
        offset = node.end;
    }
    return { markdown: markdown + source.slice(offset), tokens };
}

function embedWidget(documentRef, node, options, budget) {
    const section = documentRef.createElement('section');
    section.className = 'notes-embed';
    const textBytes = typeof node.text === 'string' ? new TextEncoder().encode(node.text).length : 0;
    const available = node.status === 'rendered' && /^n_[a-f\d]{16}$/.test(node.noteId ?? '') && typeof node.path === 'string'
        && typeof node.text === 'string' && textBytes <= 64 * 1024 && budget.count < 32 && budget.depth <= 5 && budget.bytes + textBytes <= 256 * 1024;
    budget.count++;
    if (!available) {
        section.classList.add('notes-embed-placeholder');
        section.textContent = node.status === 'limited' || node.status === 'rendered' ? 'Embedded note preview limit reached.' : 'Embedded note unavailable.';
        return readerControl(section);
    }
    budget.bytes += textBytes;
    section.dataset.embedNoteId = node.noteId;
    const header = documentRef.createElement('div');
    header.className = 'notes-embed-header';
    const title = documentRef.createElement('p');
    title.className = 'notes-embed-title';
    const part = node.section ? String(node.section).slice(0, 200) : '';
    // The embedded note's title and section are the user's; the 'Note' fallback is the reader's own wording.
    if (node.title !== undefined && node.title !== null) title.textContent = `${String(node.title).slice(0, 200)}${part ? `: ${part}` : ''}`;
    else if (part) title.append(userPhrase`Note: ${part}`);
    else readerControl(title).textContent = 'Note';
    const open = readerControl(documentRef.createElement('button'));
    open.type = 'button';
    open.className = 'menu_button notes-button';
    open.textContent = 'Open note';
    open.dataset.noteOpen = node.noteId;
    open.dataset.wikiFragment = String(node.fragment ?? '');
    const fold = readerControl(documentRef.createElement('button'));
    fold.type = 'button';
    fold.className = 'menu_button notes-button';
    fold.textContent = 'Fold embed';
    fold.setAttribute('aria-expanded', 'true');
    const body = documentRef.createElement('div');
    body.className = 'notes-embed-body';
    fold.addEventListener('click', () => {
        body.hidden = !body.hidden;
        fold.textContent = readerCaption(fold, body.hidden ? 'Show embed' : 'Fold embed');
        fold.setAttribute('aria-expanded', String(!body.hidden));
    });
    header.append(title, open, fold);
    section.append(header, body);
    budget.depth++;
    renderNoteInto(body, node.text, { ...options, noteId: node.noteId, notePath: node.path, embeds: node.embeds,
        bodyOnly: true, embedLoading: false, onFold: null, foldedKeys: [], embedBudget: budget });
    budget.depth--;
    return section;
}

function liftEmbedFromParagraph(section) {
    while (section.parentElement?.closest('p')) {
        const parent = section.parentElement;
        const after = parent.cloneNode(false);
        while (section.nextSibling) after.append(section.nextSibling);
        parent.after(section, after);
        if (!parent.childNodes.length) parent.remove();
        if (!after.childNodes.length) after.remove();
    }
}

function restoreEmbedTokens(value, tokens, source) {
    let result = value;
    for (const [token, node] of tokens) result = result.replaceAll(token, source.slice(node.start, node.end));
    return result;
}

function hydrateEmbeds(container, tokens, options, source) {
    if (!tokens.size) return;
    const documentRef = container.ownerDocument;
    const walker = documentRef.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement?.closest('code, pre, a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const targets = [];
    while (walker.nextNode()) if ([...tokens.keys()].some(token => walker.currentNode.nodeValue.includes(token))) targets.push(walker.currentNode);
    const budget = options.embedBudget ?? { count: 0, bytes: 0, depth: 1 };
    for (const textNode of targets) {
        const replacement = documentRef.createDocumentFragment();
        const widgets = [];
        let remainder = textNode.nodeValue;
        while (remainder) {
            let chosen = null;
            let position = remainder.length;
            for (const [token, node] of tokens) {
                const index = remainder.indexOf(token);
                if (index >= 0 && index < position) { chosen = { token, node }; position = index; }
            }
            if (!chosen) { replacement.append(documentRef.createTextNode(remainder)); break; }
            const widget = embedWidget(documentRef, chosen.node, options, budget);
            widgets.push(widget);
            replacement.append(documentRef.createTextNode(remainder.slice(0, position)), widget);
            remainder = remainder.slice(position + chosen.token.length);
        }
        textNode.replaceWith(replacement);
        for (const widget of widgets) liftEmbedFromParagraph(widget);
    }
    const restore = documentRef.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (restore.nextNode()) restore.currentNode.nodeValue = restoreEmbedTokens(restore.currentNode.nodeValue, tokens, source);
}

/** A reader control's wording, translated here when the note's element around it is out of the run-time localiser's reach. */
function readerCaption(control, text) {
    return control.parentElement?.closest('[data-i18n-ignore]') ? translate(text) : text;
}

function translateWords(value) {
    const key = value.trim();
    return key ? value.replace(key, () => translate(key)) : value;
}

/** Translates the reader's own wording inside an element that is about to be marked as the note's. */
function translateReaderWords(element) {
    for (const item of [element, ...element.querySelectorAll('*')]) {
        if (item.parentElement?.closest('[data-i18n-ignore]')) continue;
        for (const name of readerAttributes.get(item) ?? []) item.setAttribute(name, translateWords(item.getAttribute(name)));
        if (!readerControls.has(item)) continue;
        for (const node of item.childNodes) if (node.nodeType === Node.TEXT_NODE) node.nodeValue = translateWords(node.nodeValue);
        for (const name of CAPTION_ATTRIBUTES) if (item.hasAttribute(name)) item.setAttribute(name, translateWords(item.getAttribute(name)));
    }
}

function insideReaderControl(node) {
    for (let element = node.parentElement; element; element = element.parentElement) if (readerControls.has(element)) return true;
    return false;
}

/**
 * Leaves the note's own words alone: each of its text nodes goes in a marked span, and each element carrying a title, aria-label or
 * placeholder the note wrote is marked, so the run-time localiser skips them. The reader's controls stay translatable; one inside
 * such an element is translated here instead.
 */
function protectNoteText(root) {
    const documentRef = root.ownerDocument;
    const walker = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeValue.trim() && !node.parentElement?.closest('[data-i18n-ignore], pre, code') && !insideReaderControl(node)) texts.push(node);
    }
    for (const node of texts) {
        const words = documentRef.createElement('span');
        words.setAttribute('data-i18n-ignore', '');
        node.replaceWith(words);
        words.append(node);
    }
    for (const element of root.querySelectorAll(CAPTION_ATTRIBUTES.map(name => `[${name}]`).join(', '))) {
        const written = readerAttributes.get(element) ?? [];
        if (readerControls.has(element) || insideReaderControl(element) || element.closest('[data-i18n-ignore]')
            || !CAPTION_ATTRIBUTES.some(name => element.hasAttribute(name) && !written.includes(name))) continue;
        translateReaderWords(element);
        element.setAttribute('data-i18n-ignore', '');
    }
}

export function renderNoteInto(container, text, options) {
    const { markdown, tokens } = prepareEmbedMarkdown(text, options.embeds);
    const body = options.bodyOnly ? markdown : splitFrontmatterText(markdown).body;
    const html = markdownConverter().makeHtml(protectEscapes(body));
    const clean = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'video', 'audio', 'source', 'link', 'meta', 'base'],
        FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'id', 'name', 'background', 'ping'],
        ALLOW_DATA_ATTR: false,
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
        ADD_TAGS: [],
        RETURN_DOM_FRAGMENT: true,
    });
    // Keep the sanitiser's inert document until all resource URLs have been checked.
    // Adopting an image into the page first can start a request even if it is immediately removed.
    if (tokens.size) {
        for (const element of clean.querySelectorAll('*')) {
            for (const attribute of [...element.attributes]) {
                if (attribute.value.includes('\uE100NNembed')) element.setAttribute(attribute.name, restoreEmbedTokens(attribute.value, tokens, String(text)));
            }
        }
    }
    restoreTaskBoxes(clean, body);
    decorateWikiLinks(clean, options);
    fixLinksAndImages(clean, options);
    clean.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading, index) => {
        heading.dataset.headingIndex = String(index);
    });
    if (options.onFold) decorateHeadingFolds(clean, text, { ...options, register: readerControl, translate, t });
    hydrateEmbeds(clean, tokens, options, String(text));
    protectNoteText(clean);
    container.replaceChildren(clean);
}

/** Only real, top-level Markdown headings receive folding controls. */
export function decorateHeadingFolds(container, text, { foldedKeys = [], onFold, register = control => control, translate: translateText = caption => caption,
    t: label = (strings, ...values) => strings.reduce((caption, part, index) => caption + part + (index < values.length ? values[index] : ''), '') }) {
    const headings = headingSections(text);
    const rendered = [...container.children].filter(node => /^H[1-6]$/.test(node.tagName));
    if (rendered.length !== headings.length || rendered.some((node, index) => Number(node.tagName[1]) !== headings[index].level)) return;
    const nodes = [...container.childNodes];
    const folded = new Set(foldedKeys);
    const stack = [];
    let index = 0;
    container.replaceChildren();
    for (const node of nodes) {
        if (node !== rendered[index]) {
            (stack.at(-1)?.body ?? container).append(node);
            continue;
        }
        const heading = headings[index++];
        while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
        const section = container.ownerDocument.createElement('section');
        section.className = 'notes-read-section';
        section.dataset.foldKey = heading.key;
        const row = container.ownerDocument.createElement('div');
        row.className = 'notes-read-heading';
        row.append(node);
        const body = container.ownerDocument.createElement('div');
        body.className = 'notes-section-body';
        body.hidden = folded.has(heading.key);
        if (heading.to > heading.from) {
            const control = register(container.ownerDocument.createElement('button'));
            control.type = 'button';
            control.className = 'menu_button notes-button notes-read-fold';
            const describe = () => {
                const caption = body.hidden ? 'Show section' : 'Fold section';
                if (heading.text) {
                    // The label holds the user's heading, and an attribute cannot be split. So the control's wording is translated
                    // here, the heading goes in as written, and the control is marked so the run-time localiser leaves both alone.
                    control.textContent = translateText(caption);
                    control.setAttribute('aria-label', body.hidden ? label`Show ${heading.text}` : label`Fold ${heading.text}`);
                    control.setAttribute('data-i18n-ignore', '');
                } else {
                    control.textContent = caption;
                    control.setAttribute('aria-label', [body.hidden ? 'Show' : 'Fold', 'Untitled heading'].join(' '));
                }
                control.setAttribute('aria-expanded', String(!body.hidden));
            };
            describe();
            control.addEventListener('click', () => {
                body.hidden = !body.hidden;
                if (body.hidden) folded.add(heading.key);
                else folded.delete(heading.key);
                describe();
                onFold([...folded]);
            });
            row.append(control);
        }
        section.append(row, body);
        (stack.at(-1)?.body ?? container).append(section);
        stack.push({ level: heading.level, body });
    }
}

function restoreTaskBoxes(container, body) {
    const tasks = [...body.matchAll(/^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]/gm)].map(match => match[1] !== ' ');
    let index = 0;
    for (const item of container.querySelectorAll('li')) {
        const text = item.firstChild;
        if (!(text?.nodeType === 3 && /^\s*\[( |x|X)\]\s/.test(text.nodeValue)) && !item.classList.contains('task-list-item')) continue;
        const box = readerControl(container.ownerDocument.createElement('input'));
        box.type = 'checkbox';
        box.checked = tasks[index] ?? /\[(x|X)\]/.test(text?.nodeValue ?? '');
        box.disabled = true;
        box.setAttribute('aria-label', box.checked ? 'Done' : 'Not done');
        if (text?.nodeType === 3) text.nodeValue = text.nodeValue.replace(/^\s*\[( |x|X)\]\s/, '');
        item.prepend(box, ' ');
        item.classList.add('notes-task');
        index++;
    }
}

export function headingOutline(text) {
    return headingSections(text);
}
