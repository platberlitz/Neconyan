/* global globalThis */
import { load } from 'cheerio';

// Inert tree model for lifecycle tests; browser enforcement is tested separately.
export class CardScriptTestDocument extends EventTarget {
    constructor(html = '<html><head></head><body><div id="chat"></div><input id="allow_card_scripts"></body></html>') {
        super();
        this.$ = load(html);
        this.cache = new WeakMap();
        this.hidden = false;
    }
    wrap(node) {
        if (!node) return null;
        if (!this.cache.has(node)) this.cache.set(node, new TestElement(this, node));
        return this.cache.get(node);
    }
    querySelectorAll(selector) { return this.$(selector).toArray().map(node => this.wrap(node)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getElementById(id) { return this.querySelector(`#${id}`); }
    createElement(tag) { return this.wrap(load(`<${tag}></${tag}>`, null, false).root().children()[0]); }
    createDocumentFragment() { const element = this.createElement('fragment'); element.fragment = true; return element; }
    get body() { return this.querySelector('body'); }
    get head() { return this.querySelector('head'); }
}

class TestElement extends EventTarget {
    constructor(doc, node) {
        super();
        this.doc = doc;
        this.node = node;
        this.style = {};
        this.bounds = { top: 10, bottom: 100, height: 90, width: 400 };
        this.dataset = new Proxy({}, {
            get: (_, key) => this.getAttribute('data-' + key.replace(/[A-Z]/g, char => '-' + char.toLowerCase())) ?? undefined,
            set: (_, key, value) => { this.setAttribute('data-' + key.replace(/[A-Z]/g, char => '-' + char.toLowerCase()), value); return true; },
            deleteProperty: (_, key) => { this.doc.$(node).removeAttr('data-' + key.replace(/[A-Z]/g, char => '-' + char.toLowerCase())); return true; },
        });
        this.classList = {
            contains: name => this.doc.$(node).hasClass(name),
            add: (...names) => this.doc.$(node).addClass(names.join(' ')),
            remove: (...names) => this.doc.$(node).removeClass(names.join(' ')),
            toggle: (name, force) => this.doc.$(node).toggleClass(name, force),
        };
        if (node.name === 'iframe') this.contentWindow = { postMessage() {} };
    }
    get tagName() { return this.node.name?.toUpperCase(); }
    get attributes() { return Object.entries(this.node.attribs ?? {}).map(([name, value]) => ({ name, value })); }
    get className() { return this.getAttribute('class') ?? ''; }
    set className(value) { this.setAttribute('class', value); }
    get parentNode() { return this.doc.wrap(this.node.parent); }
    get parentElement() { return this.node.parent?.name ? this.parentNode : null; }
    get isConnected() { let node = this.node; while (node.parent) node = node.parent; return node === this.doc.$.root()[0]; }
    get children() { return (this.node.children ?? []).filter(node => node.name).map(node => this.doc.wrap(node)); }
    get childNodes() { return (this.node.children ?? []).map(node => this.doc.wrap(node)); }
    get firstChild() { return this.childNodes[0] ?? null; }
    get firstElementChild() { return this.children[0] ?? null; }
    get content() {
        const root = this.node.children?.find(node => node.type === 'root');
        const content = root ? this.doc.wrap(root) : this;
        content.fragment = true;
        return content;
    }
    get innerHTML() { return this.doc.$(this.node).html() ?? ''; }
    set innerHTML(value) {
        if (this.node.name === 'template') this.doc.$(this.node).empty().append(load(value, null, false).root().contents().toArray());
        else this.doc.$(this.node).html(value);
    }
    get textContent() { return this.doc.$(this.node).text(); }
    set textContent(value) { this.doc.$(this.node).text(value); }
    setAttribute(name, value) { this.doc.$(this.node).attr(name, String(value)); }
    getAttribute(name) { return this.doc.$(this.node).attr(name) ?? null; }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    querySelectorAll(selector) {
        return this.doc.$(this.node).find(selector).toArray().filter(node => {
            for (let parent = node.parent; parent && parent !== this.node; parent = parent.parent) if (parent.type === 'root' && parent.parent?.name === 'template') return false;
            return true;
        }).map(node => this.doc.wrap(node));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) {
        for (let node = this.node; node?.name; node = node.parent) {
            if (node.name === 'template' && node.parent?.type === 'root') break;
            if (this.doc.$(node).is(selector)) return this.doc.wrap(node);
        }
        return null;
    }
    matches(selector) { return this.doc.$(this.node).is(selector); }
    contains(element) { for (let node = element?.node; node; node = node.parent) if (node === this.node) return true; return false; }
    appendChild(element) {
        if (element.fragment) { for (const child of [...element.childNodes]) this.appendChild(child); }
        else { element.remove(); this.doc.$(this.node).append(element.node); }
        return element;
    }
    replaceWith(element) {
        if (element.fragment) this.doc.$(this.node).replaceWith(element.node.children);
        else { element.remove(); this.doc.$(this.node).replaceWith(element.node); }
    }
    remove() { this.doc.$(this.node).remove(); }
    after(element) { element.remove(); this.doc.$(this.node).after(element.node); }
    getClientRects() { return this.isConnected ? [this.bounds] : []; }
    getBoundingClientRect() { return this.bounds; }
}

export function installCardScriptTestDom() {
    globalThis.document = new CardScriptTestDocument();
    globalThis.DOMParser = class { parseFromString(html) { return new CardScriptTestDocument(html); } };
    globalThis.CSS = { supports: (_, value) => !/invalid|url\(/.test(value) };
    return globalThis.document;
}
