import { DOMPurify, showdown } from '../../lib.js';

const ESCAPED_OPEN = '\uE000';
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
    const source = String(text ?? '');
    const offset = source.startsWith('\uFEFF') ? 1 : 0;
    const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source.slice(offset));
    if (!match) return { frontmatter: '', body: source.slice(offset), bodyStart: offset };
    return { frontmatter: match[1], body: source.slice(offset + match[0].length), bodyStart: offset + match[0].length };
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
    return markdown.replace(/\\\[\[/g, ESCAPED_OPEN);
}

function wikiNodes(text, documentRef) {
    const fragment = documentRef.createDocumentFragment();
    let last = 0;
    let found = false;
    for (const match of text.matchAll(WIKI)) {
        found = true;
        fragment.append(documentRef.createTextNode(text.slice(last, match.index)));
        const link = parseWikiInner(match[2]);
        const element = documentRef.createElement(match[1] ? 'span' : 'a');
        if (match[1]) {
            element.className = 'notes-embed-chip';
            element.textContent = `Embedded note: ${link.target}${link.fragment ? ` # ${link.fragment}` : ''}`;
            element.title = 'Embedded notes are shown as a link here. Open it to read the embedded text.';
            element.setAttribute('role', 'button');
            element.tabIndex = 0;
        } else {
            element.className = 'notes-wikilink';
            element.href = '#';
            element.textContent = link.label || (link.fragment ? `${link.target} › ${link.fragment}` : link.target);
        }
        element.dataset.wikiTarget = link.target;
        element.dataset.wikiFragment = link.fragment;
        fragment.append(element);
        last = match.index + match[0].length;
    }
    if (!found) return null;
    fragment.append(documentRef.createTextNode(text.slice(last)));
    return fragment;
}

function decorateWikiLinks(root) {
    const documentRef = root.ownerDocument;
    const walker = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.parentElement?.closest('code, pre, a, .notes-embed-chip')) return NodeFilter.FILTER_REJECT;
            return node.nodeValue.includes('[[') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
    });
    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    for (const node of targets) {
        const replacement = wikiNodes(node.nodeValue, documentRef);
        if (replacement) node.replaceWith(replacement);
    }
    const restore = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (restore.nextNode()) {
        const node = restore.currentNode;
        if (node.nodeValue.includes(ESCAPED_OPEN)) {
            const literal = node.parentElement?.closest('code, pre') ? '\\[[' : '[[';
            node.nodeValue = node.nodeValue.replaceAll(ESCAPED_OPEN, literal);
        }
    }
}

function fixLinksAndImages(root, { notebookId, notePath, attachmentUrl }) {
    for (const anchor of root.querySelectorAll('a[href]')) {
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
            anchor.dataset.headingTarget = decodeURIComponent(href.slice(1));
            continue;
        }
        const relative = resolveRelativePath(notePath, href);
        if (!relative) {
            anchor.removeAttribute('href');
            continue;
        }
        if (/\.md$/i.test(relative)) {
            anchor.dataset.notePath = relative;
            anchor.dataset.wikiFragment = href.includes('#') ? decodeURIComponent(href.slice(href.indexOf('#') + 1)) : '';
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

export function renderNoteInto(container, text, options) {
    const { body } = splitFrontmatterText(text);
    const html = markdownConverter().makeHtml(protectEscapes(body));
    const clean = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'video', 'audio', 'source', 'link', 'meta', 'base'],
        FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'id', 'name'],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
        ADD_TAGS: [],
        RETURN_DOM_FRAGMENT: true,
    });
    container.replaceChildren(clean);
    restoreTaskBoxes(container, body);
    decorateWikiLinks(container);
    fixLinksAndImages(container, options);
    container.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading, index) => {
        heading.dataset.headingIndex = String(index);
    });
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
    const { body, bodyStart } = splitFrontmatterText(text);
    const outline = [];
    let fence = null;
    let offset = bodyStart;
    for (const line of body.split('\n')) {
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
        } else if (fenceMatch) {
            fence = fenceMatch[1];
        } else {
            const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
            if (heading) outline.push({ level: heading[1].length, text: heading[2].replace(/\s+\^[A-Za-z0-9-]+$/, ''), offset });
        }
        offset += line.length + 1;
    }
    return outline;
}
