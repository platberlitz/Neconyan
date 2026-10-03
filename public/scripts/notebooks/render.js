import { DOMPurify, showdown } from '../../lib.js';
import { headingSections, splitNoteFrontmatter } from './folding.js';

const ESCAPED_OPEN = '\uE000';
const ESCAPED_EMBED = '\uE001';
const SAFE_SCHEMES = /^(?:https?:|mailto:)/i;
const WIKI = /(!?)\[\[([^\]\n]{1,400})\]\]/g;

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
            button.textContent = `Load external image${image.alt ? `: ${image.alt}` : ''}`;
            button.title = 'Loading this image contacts another website.';
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
        return section;
    }
    budget.bytes += textBytes;
    section.dataset.embedNoteId = node.noteId;
    const header = documentRef.createElement('div');
    header.className = 'notes-embed-header';
    const title = documentRef.createElement('p');
    title.className = 'notes-embed-title';
    title.textContent = `${String(node.title ?? 'Note').slice(0, 200)}${node.section ? `: ${String(node.section).slice(0, 200)}` : ''}`;
    const open = documentRef.createElement('button');
    open.type = 'button';
    open.className = 'menu_button notes-button';
    open.textContent = 'Open note';
    open.dataset.noteOpen = node.noteId;
    open.dataset.wikiFragment = String(node.fragment ?? '');
    const fold = documentRef.createElement('button');
    fold.type = 'button';
    fold.className = 'menu_button notes-button';
    fold.textContent = 'Fold embed';
    fold.setAttribute('aria-expanded', 'true');
    const body = documentRef.createElement('div');
    body.className = 'notes-embed-body';
    fold.addEventListener('click', () => {
        body.hidden = !body.hidden;
        fold.textContent = body.hidden ? 'Show embed' : 'Fold embed';
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
    if (options.onFold) decorateHeadingFolds(clean, text, options);
    hydrateEmbeds(clean, tokens, options, String(text));
    container.replaceChildren(clean);
}

/** Only real, top-level Markdown headings receive folding controls. */
export function decorateHeadingFolds(container, text, { foldedKeys = [], onFold }) {
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
            const control = container.ownerDocument.createElement('button');
            control.type = 'button';
            control.className = 'menu_button notes-button notes-read-fold';
            const describe = () => {
                control.textContent = body.hidden ? 'Show section' : 'Fold section';
                control.setAttribute('aria-label', `${body.hidden ? 'Show' : 'Fold'} ${heading.text || 'Untitled heading'}`);
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
        const box = container.ownerDocument.createElement('input');
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
