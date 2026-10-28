import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelListSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'model-list-search.js'), 'utf8').replace(/\r\n/g, '\n');

function functionSource(name) {
    return (modelListSource.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '').replace(/^export /, '');
}

function createRuntime() {
    class FakeNode {
        constructor(tagName = '') {
            this.tagName = tagName.toUpperCase();
            this.children = [];
            this.parentElement = null;
            this.dataset = {};
            this.attributes = new Map();
            this.listeners = new Map();
            this.hidden = false;
            this.disabled = false;
            this.value = '';
            this.className = '';
            this.textContent = '';
            this.style = {};
            this.classList = { add: (...names) => { this.className = [...new Set(`${this.className} ${names.join(' ')}`.trim().split(/\s+/))].join(' '); } };
        }

        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        append(...nodes) {
            for (const node of nodes) {
                const children = node?.fragment ? node.children : [node];
                for (const child of children) {
                    child.parentElement = this;
                    this.children.push(child);
                }
            }
        }
        appendChild(node) { this.append(node); }
        after(node) {
            if (!this.parentElement) return;
            const index = this.parentElement.children.indexOf(this);
            node.parentElement = this.parentElement;
            this.parentElement.children.splice(index + 1, 0, node);
        }
        replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        }
        dispatchEvent(event) {
            event.target = this;
            for (const listener of this.listeners.get(event.type) ?? []) listener(event);
            return true;
        }
        contains(node) {
            if (node === this) return true;
            return this.children.some(child => child.contains?.(node) ?? false);
        }
        querySelectorAll(selector) {
            const matches = selector.replace(/^\./, '');
            const found = [];
            const visit = node => {
                for (const child of node.children) {
                    if ((child.className || '').split(/\s+/).includes(matches)) found.push(child);
                    visit(child);
                }
            };
            visit(this);
            return found;
        }
    }

    class FakeSelect extends FakeNode {
        constructor(id, options) {
            super('select');
            this.id = id;
            this.multiple = false;
            this.options = options;
            this.value = options[0]?.value ?? '';
        }
    }

    class FakeEvent {
        constructor(type) { this.type = type; }
    }

    const document = {
        activeElement: null,
        createElement: tagName => new FakeNode(tagName),
        createDocumentFragment: () => {
            const fragment = new FakeNode('#fragment');
            fragment.fragment = true;
            return fragment;
        },
    };
    const context = vm.createContext({
        console,
        document,
        Node: FakeNode,
        HTMLSelectElement: FakeSelect,
        HTMLOptGroupElement: class extends FakeNode { },
        MutationObserver: class { observe() { } disconnect() { } takeRecords() { return []; } },
        CSS: { escape: value => String(value).replace(/["\\]/g, '\\$&') },
        Event: FakeEvent,
        t: strings => strings[0],
        groupByModelFamily: items => [{ label: null, items }],
        globalThis: {},
    });
    context.globalThis = context;
    context.lists = new WeakMap();
    vm.runInContext(`
        const lists = new WeakMap();
        ${functionSource('attachModelListSearch')}
        ${functionSource('syncModelListSearchValue')}
        this.attachModelListSearch = attachModelListSearch;
        this.syncModelListSearchValue = syncModelListSearchValue;
    `, context);
    return { ...context, document, FakeNode, FakeSelect, FakeEvent };
}

function option(value, text = value) {
    return { value, textContent: text, disabled: false, parentElement: null, dataset: {} };
}

describe('model list value sync', () => {
    test('updates a saved NovelAI model selection after settings load', () => {
        const runtime = createRuntime();
        const options = [option('a'), option('b')];
        const select = new runtime.FakeSelect('model_novel_select', options);
        const parent = new runtime.FakeNode('div');
        parent.append(select);
        runtime.attachModelListSearch(select);

        const result = parent.children[1].querySelectorAll('.nn-model-list-option');
        expect(result.find(button => button.dataset.modelId === 'a').getAttribute('aria-pressed')).toBe('true');

        select.value = 'b';
        runtime.syncModelListSearchValue(select);

        expect(result.find(button => button.dataset.modelId === 'a').getAttribute('aria-pressed')).toBe('false');
        expect(result.find(button => button.dataset.modelId === 'b').getAttribute('aria-pressed')).toBe('true');
    });

    test('updates a non-active provider selection whose option property changed', () => {
        const runtime = createRuntime();
        const options = [option('novel-a'), option('novel-b')];
        const select = new runtime.FakeSelect('model_claude_select', options);
        const parent = new runtime.FakeNode('div');
        parent.append(select);
        runtime.attachModelListSearch(select);

        select.value = 'novel-b';
        options[1].selected = true;
        runtime.syncModelListSearchValue(select);

        const results = parent.children[1].querySelectorAll('.nn-model-list-option');
        expect(results.find(button => button.dataset.modelId === 'novel-b').getAttribute('aria-pressed')).toBe('true');
    });

    test('keeps the slash /model selector synced through its change event', () => {
        const runtime = createRuntime();
        const options = [option('a'), option('b')];
        const select = new runtime.FakeSelect('model_openrouter_select', options);
        const parent = new runtime.FakeNode('div');
        parent.append(select);
        runtime.attachModelListSearch(select);

        select.value = 'b';
        select.dispatchEvent(new runtime.FakeEvent('change'));

        const results = parent.children[1].querySelectorAll('.nn-model-list-option');
        expect(results.find(button => button.dataset.modelId === 'b').getAttribute('aria-pressed')).toBe('true');
    });
});
