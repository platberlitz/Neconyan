/* global globalThis */
// A page object just big enough for the image review dialogs (public/scripts/prompt-media-ui.js), and helpers that read the tree it
// builds. Strings appended to a node are kept as strings, as a real DOM would keep them as text nodes.

export class FakeNode {
    constructor(tag) {
        this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {};
        this.ownText = ''; this.className = ''; this.hidden = false; this.disabled = false; this.checked = false; this.value = '';
    }
    get textContent() { return this.children.length ? this.children.map(child => typeof child === 'string' ? child : child.textContent).join('') : this.ownText; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    append(...nodes) { this.children.push(...nodes); }
    prepend(...nodes) { this.children.unshift(...nodes); }
    replaceChildren(...nodes) { this.ownText = ''; this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    click() { return Promise.all((this.listeners.click ?? []).map(listener => listener())); }
    querySelectorAll(selector) {
        const tags = selector.split(',').map(part => part.trim());
        return [...walk(this)].filter(entry => entry.node).map(entry => entry.node).filter(node => node !== this && tags.includes(node.tag));
    }
    remove() {}
    closest() { return null; }
}

/**
 * Every element under a node, depth first, with the elements above it. Text kept as strings is yielded as { text, path }.
 * @param {FakeNode} root
 * @param {FakeNode[]} [path]
 */
export function* walk(root, path = []) {
    yield { node: root, path };
    for (const child of root.children) {
        if (typeof child === 'string') yield { text: child, path: [...path, root] };
        else yield* walk(child, [...path, root]);
    }
}

/** The node, or an element above it, carries the attribute. */
export const marked = (entry, name) => [...entry.path, entry.node].filter(Boolean).some(node => node.hasAttribute?.(name));
/** Whether the run-time localiser would skip this element: marked final, or marked not to be translated. */
export const shielded = entry => marked(entry, 'data-i18n-ignore') || [...entry.path, entry.node].filter(Boolean).some(node => node.getAttribute?.('translate') === 'no');

/** Every piece of text with something in it that a translator could read, and whether the localiser can reach it. */
export function textPieces(root) {
    const pieces = [];
    for (const entry of walk(root)) {
        if (entry.text !== undefined) pieces.push({ text: entry.text, entry: { node: entry.path.at(-1), path: entry.path.slice(0, -1) } });
        else if (!entry.node.children.length && entry.node.ownText) pieces.push({ text: entry.node.ownText, entry });
    }
    return pieces.filter(piece => /[\p{L}\p{N}]/u.test(piece.text));
}

export const elements = (root, predicate) => [...walk(root)].filter(entry => entry.node && entry.text === undefined && predicate(entry.node)).map(entry => entry.node);
export const byTag = (root, tag) => elements(root, node => node.tag === tag);
export const buttonsNamed = (root, text) => byTag(root, 'button').filter(node => node.textContent === text);
export const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

/** Installs a document on globalThis. `lang` is the interface language the page would hold. */
export function installDocument(lang = 'en') {
    const body = { classList: { contains: name => body.classes.has(name) }, classes: new Set() };
    const documentElement = { lang };
    globalThis.document = { body, documentElement, createElement: tag => new FakeNode(tag), querySelectorAll: () => [], getElementById: () => null };
    return { body, documentElement };
}
