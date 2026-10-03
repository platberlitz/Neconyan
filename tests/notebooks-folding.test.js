import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';
import { headingSections, splitNoteFrontmatter } from '../public/scripts/notebooks/folding.js';

const renderSource = fs.readFileSync(new URL('../public/scripts/notebooks/render.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../public/scripts/notebooks/notes-app.js', import.meta.url), 'utf8');
const panelsSource = fs.readFileSync(new URL('../public/scripts/notebooks/notes-panels.js', import.meta.url), 'utf8');
function functionSource(source, name) {
    return source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`, 'm'))[0].replace(/^export /, '');
}

function element(tag, text = '') {
    const node = { tagName: tag.toUpperCase(), childNodes: [], dataset: {}, attributes: {}, text, ownerDocument: { createElement: element },
        append(...children) { this.childNodes.push(...children); },
        replaceChildren(...children) { this.childNodes = children; },
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name]; },
        addEventListener(name, callback) { this[name] = callback; },
        get children() { return this.childNodes; },
        get textContent() { return this.text + this.childNodes.map(child => child.textContent).join(''); },
        set textContent(value) { this.text = value; this.childNodes = []; },
    };
    return node;
}

function reader() {
    const onFold = jest.fn();
    const host = element('div');
    const source = '# One\nFirst body\n## Child\nChild body\n# Two\nLast body';
    host.append(element('h1', 'One'), element('p', 'First body'), element('h2', 'Child'), element('p', 'Child body'), element('h1', 'Two'), element('p', 'Last body'));
    const context = vm.createContext({ headingSections, host, source, onFold });
    vm.runInContext(functionSource(renderSource, 'decorateHeadingFolds'), context);
    return { host, source, onFold, fold: keys => vm.runInContext(`decorateHeadingFolds(host, source, { foldedKeys: ${JSON.stringify(keys)}, onFold })`, context) };
}

test('Read excludes whitespace-delimited properties before assigning heading folds', () => {
    const text = '\uFEFF--- \t\r\ntitle: Notes\r\n... \t\r\n# Actual\r\nBody';
    const context = vm.createContext({ text, splitNoteFrontmatter });
    vm.runInContext(functionSource(renderSource, 'splitFrontmatterText'), context);
    const result = vm.runInContext('splitFrontmatterText(text)', context);
    expect(result.frontmatter).toBe('title: Notes');
    expect(result.body).toBe('# Actual\r\nBody');
    expect(text.slice(result.bodyStart)).toBe(result.body);
});

test('the Details outline uses the shared source-editor jump instead of treating its adapter as an HTML element', () => {
    const app = { jumpToOffset: jest.fn(), setPane: jest.fn(), setView: jest.fn(), elements: { textarea: {
        focus: jest.fn(), setSelectionRange: jest.fn(), value: '# One\nBody\n# Two', scrollTop: 0 } } };
    const getComputedStyle = jest.fn(() => { throw new TypeError('The editor adapter is not an HTML element.'); });
    const context = vm.createContext({ app, getComputedStyle });
    vm.runInContext(functionSource(panelsSource, 'jumpTo'), context);
    expect(() => vm.runInContext('jumpTo(app, 11)', context)).not.toThrow();
    expect(app.setPane).toHaveBeenCalledWith('note');
    expect(app.jumpToOffset).toHaveBeenCalledWith(11);
    expect(getComputedStyle).not.toHaveBeenCalled();
});

test('source outline jumps cannot change an active composition', () => {
    const app = { state: { view: 'read' }, sourceEditor: { composing: true }, elements: { textarea: {
        value: '# One\nBody', focus: jest.fn(), setSelectionRange: jest.fn(), scrollToOffset: jest.fn() } } };
    const renderEditor = jest.fn();
    const context = vm.createContext({ app, renderEditor });
    vm.runInContext(functionSource(appSource, 'jumpToOffset'), context);
    vm.runInContext('jumpToOffset(6)', context);
    expect(app.state.view).toBe('read');
    expect(renderEditor).not.toHaveBeenCalled();
    expect(app.elements.textarea.setSelectionRange).not.toHaveBeenCalled();
});

describe('Read heading folding', () => {
    test('groups nested headings without removing their text and keeps peer sections separate', () => {
        const { host, source, onFold, fold } = reader();
        fold([]);
        const sections = host.children;
        expect(sections).toHaveLength(2);
        expect(sections[0].textContent).toContain('Child body');
        expect(sections[1].textContent).toContain('Last body');
        const child = sections[0].children[1].children[1];
        child.children[0].children[1].click();
        expect(child.children[1].hidden).toBe(true);
        sections[0].children[0].children[1].click();
        expect(sections[0].children[1].hidden).toBe(true);
        sections[0].children[0].children[1].click();
        expect(child.children[1].hidden).toBe(true);
        expect(onFold.mock.calls.at(-1)[0]).toEqual([headingSections(source)[1].key]);
        expect(host.textContent).toContain('First body');
    });

    test('restores presentation state with accessible, plain-text labels', () => {
        const { host, source, fold } = reader();
        fold([headingSections(source)[0].key]);
        const control = host.children[0].children[0].children[1];
        expect(control.textContent).toBe('Show section');
        expect(control.getAttribute('aria-label')).toBe('Show One');
        expect(control.getAttribute('aria-expanded')).toBe('false');
        expect(host.children[0].children[1].hidden).toBe(true);
        control.click();
        expect(control.getAttribute('aria-expanded')).toBe('true');
    });

    test('does not mistake unrelated HTML headings for the parsed Markdown sections', () => {
        const { host, fold, onFold } = reader();
        host.childNodes.unshift(element('h3'));
        fold([]);
        expect(host.children.filter(node => node.tagName === 'BUTTON')).toHaveLength(0);
        expect(host.children.filter(node => node.tagName === 'H1')).toHaveLength(2);
        expect(onFold).not.toHaveBeenCalled();
    });
});

test('composition keys bypass link completion and save shortcuts', () => {
    const flushSave = jest.fn();
    const click = jest.fn();
    const app = { sourceEditor: { composing: false }, elements: { suggest: { hidden: false,
        querySelectorAll: () => [{ getAttribute: () => 'true', click }] } } };
    const context = vm.createContext({ app, flushSave });
    vm.runInContext(functionSource(appSource, 'onEditorKeydown'), context);
    for (const event of [{ key: 'Enter', isComposing: true }, { key: 's', ctrlKey: true, keyCode: 229 }]) {
        const preventDefault = jest.fn();
        context.event = { ...event, preventDefault };
        vm.runInContext('onEditorKeydown(event)', context);
        expect(preventDefault).not.toHaveBeenCalled();
    }
    app.sourceEditor.composing = true;
    context.event = { key: 'Enter', preventDefault: jest.fn() };
    vm.runInContext('onEditorKeydown(event)', context);
    expect(click).not.toHaveBeenCalled();
    expect(flushSave).not.toHaveBeenCalled();
});

test('composition cannot acquire the identity of another note before its document is installed', async () => {
    const original = { id: 'one', revision: 'one-revision' };
    const app = { sourceEditor: { composing: true }, state: { note: original, notebookId: 'first', notebookSelectionVersion: 0 } };
    const request = jest.fn();
    const flushSave = jest.fn();
    const context = vm.createContext({ app, request, flushSave });
    vm.runInContext(functionSource(appSource, 'selectNotebook') + '\n' + functionSource(appSource, 'openNote'), context);
    expect(await vm.runInContext('openNote("second", "two")', context)).toBe(false);
    expect(await vm.runInContext('selectNotebook("second")', context)).toBe(false);
    expect(app.state.note).toBe(original);
    expect(app.state.notebookId).toBe('first');
    expect(app.state.notebookSelectionVersion).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect(flushSave).not.toHaveBeenCalled();
});

describe('fold preferences', () => {
    function preferences() {
        const stores = new Map();
        const app = { state: { account: 'first-owner', notebookId: 'first-book', note: { id: 'same-imported-id' } } };
        const readPrefs = () => stores.get(app.state.account) ?? {};
        const writePrefs = patch => stores.set(app.state.account, { ...readPrefs(), ...patch });
        const context = vm.createContext({ app, readPrefs, writePrefs, renderFoldControls: jest.fn() });
        vm.runInContext(functionSource(appSource, 'noteFolds') + '\n' + functionSource(appSource, 'rememberFolds'), context);
        return { app, stores, context, readPrefs, writePrefs, get: () => vm.runInContext('noteFolds()', context), set: keys => {
            context.keys = keys;
            vm.runInContext('rememberFolds(keys)', context);
        } };
    }

    test('the same imported note id cannot carry folds into another notebook or account', () => {
        const fixture = preferences();
        const key = headingSections('# Title\nBody')[0].key;
        fixture.set([key]);
        expect(fixture.get()).toEqual([key]);
        fixture.app.state.notebookId = 'second-book';
        expect(fixture.get()).toEqual([]);
        fixture.app.state.notebookId = 'first-book';
        fixture.app.state.account = 'second-owner';
        expect(fixture.get()).toEqual([]);
        fixture.app.state.account = 'first-owner';
        expect(fixture.get()).toEqual([key]);
    });

    test('stored fold choices have bounded note and heading counts', () => {
        const fixture = preferences();
        fixture.writePrefs({ folds: Object.fromEntries(Array.from({ length: 55 }, (_, index) => [`old-book:${index}`, []])) });
        const keys = Array.from({ length: 5001 }, (_, index) => `h_${index.toString(16).padStart(16, '0')}`);
        fixture.set(keys);
        expect(Object.keys(fixture.readPrefs().folds)).toHaveLength(50);
        expect(fixture.get()).toEqual(keys.slice(0, 5000));
    });

    test('malformed stored folds cannot stop the editor opening', () => {
        const fixture = preferences();
        const name = `${fixture.app.state.notebookId}:${fixture.app.state.note.id}`;
        for (const value of ['not-an-array', 3, {}, null]) {
            fixture.writePrefs({ folds: { [name]: value } });
            expect(fixture.get()).toEqual([]);
        }
        fixture.writePrefs({ folds: { [name]: [null, {}, 'invalid', 'h_0000000000000000'] } });
        expect(fixture.get()).toEqual(['h_0000000000000000']);
    });
});
