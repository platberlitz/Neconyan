import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';
import * as helpers from '../public/scripts/pinned-prompt-toggles.js';
import * as inspection from '../public/scripts/in-chat-agent-inspection.js';
import { getPromptPreview } from '../public/scripts/prompt-preview.js';

export const translate = (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), '');
export const escapeHtml = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Evaluate the real module, replacing only its heavy application imports. */
export async function loadIsolated(filename, overrides = {}, globals = {}, extra = '') {
    const source = readFileSync(new URL('../public/' + filename, import.meta.url), 'utf8');
    const imports = new Map([...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
        .map(([, names, specifier]) => [specifier, names.split(',').map(name => name.trim()).filter(Boolean)]));
    const context = vm.createContext({ console, structuredClone, DOMException, setTimeout, clearTimeout,
        window: { matchMedia: () => ({ matches: true }) }, ...globals });
    const dependencies = {
        './i18n.js': { t: translate },
        './utils.js': { debounce: fn => fn, escapeHtml, ensurePlainObject: value => value },
        './constants.js': { debounce_timeout: { relaxed: 0 } },
        './pinned-prompt-toggles.js': helpers,
        './in-chat-agent-inspection.js': inspection,
        './prompt-preview.js': { getPromptPreview },
        ...overrides,
    };
    const makeDependency = (specifier, names = []) => {
        const values = dependencies[specifier] ?? {};
        const keys = [...new Set([...names.map(name => name.split(/\s+as\s+/)[0]), ...Object.keys(values)])];
        return new vm.SyntheticModule(keys, function () {
            keys.forEach(key => this.setExport(key, values[key] ?? {}));
        }, { context });
    };
    const module = new vm.SourceTextModule(source + '\n' + extra, { context, identifier: filename,
        importModuleDynamically: async specifier => {
            const dependency = makeDependency(specifier);
            await dependency.link(() => {});
            await dependency.evaluate();
            return dependency;
        } });
    await module.link(specifier => makeDependency(specifier, imports.get(specifier)));
    await module.evaluate();
    return module.namespace;
}

export async function managerFixture(overrides = {}, globals = {}) {
    const emit = jest.fn();
    const cleanup = jest.fn();
    const { PromptManager } = await loadIsolated('scripts/PromptManager.js', {
        '../script.js': { eventSource: { emit }, event_types: { PROMPT_MANAGER_UPDATED: 'updated' } },
        './prompt-variable-cleanup.js': { clearPromptSetVariables: cleanup }, ...overrides,
    }, globals);
    const manager = new PromptManager();
    manager.activeCharacter = { id: 42 };
    manager.serviceSettings = { preset_settings_openai: 'A', custom_model: 'dirty model', extensions: { other: { keep: true } },
        prompts: [{ identifier: 'a', name: 'Shared', content: '{{setvar::mode::on}}', system_prompt: false },
            { identifier: 'b', name: 'Shared', content: 'B', system_prompt: false },
            { identifier: 'detached', name: 'Detached' }, { identifier: 'restricted', name: 'Restricted', marker: true }],
        prompt_order: [{ character_id: '42', order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }, { identifier: 'restricted', enabled: true }] }] };
    const counts = { a: 100, b: 10 };
    manager.tokenHandler = { getCounts: () => counts };
    manager.render = jest.fn();
    manager.saveServiceSettings = jest.fn(async () => true);
    return { manager, counts, emit, cleanup, PromptManager };
}

/** Minimal native-control DOM: exercise the real list renderer and its click listeners. */
export async function renderedManagerFixture(overrides = {}, globals = {}) {
    const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, String.fromCharCode(39)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const doc = { body: {} };
    doc.activeElement = doc.body;
    class List {
        constructor() { this.ownerDocument = doc; this.rows = []; this.html = ''; }
        set innerHTML(value) { this.html = value; this.rows = []; }
        contains(node) { return this.rows.some(row => row.buttons.includes(node)); }
        insertAdjacentHTML(_, html) {
            this.html += html;
            for (const [, identifier, content] of html.matchAll(/<li\b[^>]*data-pm-identifier="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)) {
                const row = { dataset: { pmIdentifier: decode(identifier) }, buttons: [], classList: { toggle() {} }, addEventListener() {},
                    querySelector: selector => row.buttons.find(button => button.matches(selector)) };
                for (const [, attributes] of content.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/g)) {
                    const attrs = Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)]));
                    const label = { textContent: '' };
                    const listeners = new Map();
                    const button = { attrs, className: attrs.class, getAttribute: name => attrs[name] ?? null, setAttribute: (name, value) => { attrs[name] = String(value); },
                        matches: selector => selector.split(',').some(part => part.trim().startsWith('.') && button.className.split(' ').includes(part.trim().slice(1))),
                        closest: () => row, querySelector: () => label,
                        addEventListener: (name, callback) => listeners.set(name, callback),
                        click: () => listeners.get('click')({ target: button, currentTarget: button, preventDefault() {}, stopPropagation() {} }) };
                    button.classList = { contains: name => button.className.split(' ').includes(name), toggle() {} };
                    Object.defineProperty(button, 'title', { get: () => attrs.title, set: value => { attrs.title = value; } });
                    row.buttons.push(button);
                }
                this.rows.push(row);
            }
        }
        querySelectorAll(selector) { return selector === '[data-pm-identifier]' ? this.rows : this.rows.flatMap(row => row.buttons).filter(button => button.matches(selector)); }
        getElementsByClassName(name) { return this.querySelectorAll('.' + name); }
    }
    const f = await managerFixture({ './templates.js': { renderTemplateAsync: async () => '' }, './RossAscends-mods.js': { isMobile: () => false }, ...overrides }, { document: doc, HTMLElement: List, ...globals });
    f.manager.listElement = new List();
    f.manager.getActivePromptTokenCounts = () => ({});
    f.manager.getInChatAgentTokenUsage = () => 0;
    f.manager.syncListSelection = () => {};
    const source = readFileSync(new URL('../public/scripts/PromptManager.js', import.meta.url), 'utf8');
    const start = source.indexOf('this.handleToggle = (event) => {');
    const end = source.indexOf('const editPromptById =', start);
    new Function(source.slice(start, end)).call(f.manager);
    return f;
}
