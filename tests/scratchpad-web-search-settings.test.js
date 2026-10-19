import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));
const h = (tag, attributes = {}, ...children) => {
    const element = { tag, attributes, children: [], value: attributes.value ?? '', hidden: Boolean(attributes.hidden),
        textContent: attributes.text ?? '', className: attributes.class ?? '', disabled: Boolean(attributes.disabled) };
    for (const [key, value] of Object.entries(attributes)) if (key.startsWith('on') && typeof value === 'function') element[key] = value;
    element.append = (...values) => {
        for (const child of values.flat(Infinity)) if (child) element.children.push(child);
    };
    element.append(...children);
    return element;
};
jest.unstable_mockModule('../public/scripts/notebooks/dom.js', () => ({ h }));

const { renderWebSearchSettings } = await import('../public/scripts/scratchpad/web-search.js');

const nodes = root => [root, ...root.children.flatMap(child => child?.tag ? nodes(child) : [])];
const byId = (root, id) => nodes(root).find(node => node.attributes.id === id);
const status = root => nodes(root).find(node => String(node.className).includes('scratchpad-web-status'));
const saved = { provider: 'off', searxngUrl: '', results: 5 };
const offReady = { provider: 'off', configured: false, missing: 'off' };

describe('Scratchpad web search settings draft', () => {
    test('an unsaved provider, address and result count survive a background render', () => {
        const draft = { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080/search-services', results: 7 };
        const first = renderWebSearchSettings({ config: saved, draft, readiness: offReady, onDraft: jest.fn() });
        expect(byId(first, 'scratchpad-web-search-provider').value).toBe('searxng');
        expect(byId(first, 'scratchpad-web-search-searxng').value).toBe(draft.searxngUrl);
        expect(byId(first, 'scratchpad-web-search-results').value).toBe('7');
        expect(status(first).textContent).toBe('Save to use this provider.');

        const refreshed = renderWebSearchSettings({ config: saved, draft,
            readiness: { provider: 'brave', configured: true, missing: '' }, onDraft: jest.fn() });
        expect(byId(refreshed, 'scratchpad-web-search-provider').value).toBe('searxng');
        expect(byId(refreshed, 'scratchpad-web-search-searxng').value).toBe(draft.searxngUrl);
        expect(byId(refreshed, 'scratchpad-web-search-results').value).toBe('7');
    });

    test('a failed save keeps the draft and shows the error instead of the saved values', () => {
        const draft = { provider: 'searxng', searxngUrl: 'https://search.example.com', results: 7 };
        const view = renderWebSearchSettings({ config: saved, draft, readiness: offReady,
            error: 'Fixture save unavailable.', onDraft: jest.fn() });
        expect(byId(view, 'scratchpad-web-search-provider').value).toBe('searxng');
        expect(byId(view, 'scratchpad-web-search-searxng').value).toBe(draft.searxngUrl);
        expect(byId(view, 'scratchpad-web-search-results').value).toBe('7');
        expect(status(view).textContent).toBe('Fixture save unavailable.');
    });

    test('the same saved provider shows unsaved changes without losing the draft', () => {
        const config = { provider: 'searxng', searxngUrl: 'https://search.example.com', results: 5 };
        const view = renderWebSearchSettings({ config, draft: { ...config, results: 7 },
            readiness: { provider: 'searxng', configured: true, missing: '' }, onDraft: jest.fn() });
        expect(status(view).textContent).toBe('Unsaved changes. Press Save web search to apply them.');
        expect(byId(view, 'scratchpad-web-search-results').value).toBe('7');
    });

    test('after a successful save the saved values show Ready', () => {
        const config = { provider: 'searxng', searxngUrl: 'https://search.example.com', results: 7 };
        const view = renderWebSearchSettings({ config, draft: null,
            readiness: { provider: 'searxng', configured: true, missing: '' }, onDraft: jest.fn() });
        expect(status(view).textContent).toBe('Ready. Only the message you send is used as the search query.');
        expect(byId(view, 'scratchpad-web-search-results').value).toBe('7');
    });

    test('control changes publish the complete draft and save reads the current fields', () => {
        const onDraft = jest.fn();
        const onSave = jest.fn();
        const view = renderWebSearchSettings({ config: saved, draft: null, readiness: offReady, onDraft, onSave });
        const provider = byId(view, 'scratchpad-web-search-provider');
        provider.value = 'nanogpt';
        provider.onchange();
        expect(onDraft).toHaveBeenLastCalledWith({ provider: 'nanogpt', searxngUrl: '', customUrl: '', customHeader: '', results: 5 });

        const url = byId(view, 'scratchpad-web-search-searxng');
        url.value = 'https://search.example.com';
        url.oninput();
        expect(onDraft).toHaveBeenLastCalledWith({ provider: 'nanogpt', searxngUrl: 'https://search.example.com', customUrl: '', customHeader: '', results: 5 });

        const results = byId(view, 'scratchpad-web-search-results');
        results.value = '9';
        results.onchange();
        expect(onDraft).toHaveBeenLastCalledWith({ provider: 'nanogpt', searxngUrl: 'https://search.example.com', customUrl: '', customHeader: '', results: 9 });

        byId(view, 'scratchpad-web-search-save').onclick();
        expect(onSave).toHaveBeenCalledWith({ provider: 'nanogpt', searxngUrl: 'https://search.example.com', customUrl: '', customHeader: '', results: 9 });
    });

    test('each provider shows only its own key or address fields', () => {
        const visible = (view, provider) => {
            const select = byId(view, 'scratchpad-web-search-provider');
            select.value = provider;
            select.onchange();
            const shown = node => node.hidden ? [] : [node, ...node.children.flatMap(child => child?.tag ? shown(child) : [])];
            return shown(view).map(node => node.attributes.dataset?.key || node.attributes.id).filter(Boolean);
        };
        const view = renderWebSearchSettings({ config: saved, draft: null, readiness: offReady, onDraft: jest.fn() });
        expect(visible(view, 'exa')).toContain('api_key_exa');
        expect(visible(view, 'exa')).not.toContain('api_key_tavily');
        expect(visible(view, 'tavily')).toContain('api_key_tavily');
        expect(visible(view, 'tavily')).not.toContain('scratchpad-web-search-custom');
        const custom = visible(view, 'custom');
        expect(custom).toEqual(expect.arrayContaining(['scratchpad-web-search-custom', 'api_key_custom_search', 'scratchpad-web-search-custom-header']));
        expect(custom).not.toContain('api_key_exa');
    });

    test('the custom address and key header are part of the draft and the save', () => {
        const onDraft = jest.fn();
        const onSave = jest.fn();
        const view = renderWebSearchSettings({ config: saved, draft: null, readiness: offReady, onDraft, onSave });
        const provider = byId(view, 'scratchpad-web-search-provider');
        provider.value = 'custom';
        provider.onchange();
        const url = byId(view, 'scratchpad-web-search-custom');
        url.value = 'https://search.example.com/api?q={query}&n={count}';
        url.oninput();
        const header = byId(view, 'scratchpad-web-search-custom-header');
        header.value = 'X-API-Key';
        header.oninput();
        const expected = { provider: 'custom', searxngUrl: '', customUrl: 'https://search.example.com/api?q={query}&n={count}',
            customHeader: 'X-API-Key', results: 5 };
        expect(onDraft).toHaveBeenLastCalledWith(expected);
        byId(view, 'scratchpad-web-search-save').onclick();
        expect(onSave).toHaveBeenCalledWith(expected);
    });

    test('a saved custom address counts as unchanged until it is edited', () => {
        const config = { provider: 'custom', searxngUrl: '', customUrl: 'https://search.example.com/api?q={query}', customHeader: '', results: 5 };
        const ready = { provider: 'custom', configured: true, missing: '' };
        const view = renderWebSearchSettings({ config, draft: null, readiness: ready, onDraft: jest.fn() });
        expect(status(view).textContent).toBe('Ready. Only the message you send is used as the search query.');
        const edited = renderWebSearchSettings({ config, draft: { ...config, customHeader: 'X-API-Key' }, readiness: ready, onDraft: jest.fn() });
        expect(status(edited).textContent).toBe('Unsaved changes. Press Save web search to apply them.');
    });
});

const indexSource = fs.readFileSync(new URL('../public/scripts/scratchpad/index.js', import.meta.url), 'utf8');
const functionCode = names => names.map(name => indexSource.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}`, 'm'))[0]).join('\n');
const searchState = { provider: 'brave', configured: true, missing: '' };

function lifecycleFixture() {
    const reads = [];
    const readWebSearch = jest.fn(() => new Promise((resolve, reject) => reads.push({ resolve, reject })));
    const app = { open: false, source: {}, sending: false, webSearch: null, webSearchCheck: 0, webSearchSaving: false,
        webSearchDraft: null, webSearchLoad: null, webSearchOwner: 'kris' };
    let owner = 'kris';
    const updateSettings = jest.fn(async () => ({ bucket: {} }));
    const openWebSearchSettings = jest.fn();
    const runtime = vm.createContext({
        app, api: { readWebSearch }, owner, updateSettings, openWebSearchSettings,
        getCurrentUserHandle: () => owner, pendingReply: () => null, currentSettings: () => ({ webSearch: false }),
        renderComposer: jest.fn(), renderContext: jest.fn(), reportError: jest.fn(),
        t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    });
    vm.runInContext(functionCode(['loadWebSearchConfig', 'refreshWebSearchConfig', 'toggleWebSearch']), runtime);
    return { app, reads, readWebSearch, updateSettings, openWebSearchSettings, setOwner: value => { owner = value; }, runtime };
}

describe('Scratchpad web search loading lifecycle', () => {
    test('concurrent refreshes share one read and preserve an unsaved draft', async () => {
        const f = lifecycleFixture();
        f.app.webSearchDraft = { provider: 'searxng', searxngUrl: 'https://draft.example.com', results: 7 };
        const first = f.runtime.refreshWebSearchConfig();
        const second = f.runtime.refreshWebSearchConfig();
        expect(f.readWebSearch).toHaveBeenCalledTimes(1);
        f.reads[0].resolve({ webSearch: { ...saved, revision: 1 }, readiness: offReady });
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        expect(f.app.webSearch).toEqual({ config: { ...saved, revision: 1 }, readiness: offReady });
        expect(f.app.webSearchDraft).toEqual({ provider: 'searxng', searxngUrl: 'https://draft.example.com', results: 7 });
        expect(f.app.webSearchLoad).toBeNull();
    });

    test('a read that was in flight before a save cannot overwrite the saved settings', async () => {
        const f = lifecycleFixture();
        const pending = f.runtime.refreshWebSearchConfig();
        f.app.webSearchSaving = true;
        f.app.webSearchCheck += 1;
        f.reads[0].resolve({ webSearch: { ...saved, revision: 1 }, readiness: offReady });
        await pending;
        expect(f.app.webSearch).toBeNull();
        await expect(f.runtime.refreshWebSearchConfig()).resolves.toBeNull();
    });

    test('toggle waits for the current read before deciding that search is unconfigured', async () => {
        const f = lifecycleFixture();
        const toggled = f.runtime.toggleWebSearch();
        expect(f.readWebSearch).toHaveBeenCalledTimes(1);
        expect(f.openWebSearchSettings).not.toHaveBeenCalled();
        f.reads[0].resolve({ webSearch: { ...saved, revision: 1 }, readiness: searchState });
        await toggled;
        expect(f.openWebSearchSettings).not.toHaveBeenCalled();
        expect(f.updateSettings).toHaveBeenCalledWith({ webSearch: true });
    });

    test('a new account clears the previous draft', async () => {
        const f = lifecycleFixture();
        f.app.webSearchDraft = { provider: 'brave', searxngUrl: '', results: 5 };
        f.setOwner('someone-else');
        const pending = f.runtime.refreshWebSearchConfig();
        expect(f.app.webSearchDraft).toBeNull();
        f.reads[0].resolve({ webSearch: { ...saved, revision: 2 }, readiness: offReady });
        await pending;
        expect(f.app.webSearchDraft).toBeNull();
    });
});
