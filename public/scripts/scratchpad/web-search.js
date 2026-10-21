import { t } from '../i18n.js';
import { h } from '../notebooks/dom.js';

const PROVIDERS = [
    ['off', 'Off'],
    ['brave', 'Brave Search'],
    ['searxng', 'SearXNG'],
    ['nanogpt', 'NanoGPT (Linkup)'],
    ['exa', 'Exa'],
    ['tavily', 'Tavily'],
    ['custom', 'Custom address'],
];

const MISSING = {
    'off': () => t`Choose a provider, save, then turn on Web beside the message box.`,
    'brave-key': () => t`Add a Brave Search API key, save, then turn on Web beside the message box.`,
    'searxng-url': () => t`Add your SearXNG address, save, then turn on Web beside the message box.`,
    'nanogpt-key': () => t`Add a NanoGPT API key, save, then turn on Web beside the message box.`,
    'exa-key': () => t`Add an Exa API key, save, then turn on Web beside the message box.`,
    'tavily-key': () => t`Add a Tavily API key, save, then turn on Web beside the message box.`,
    'custom-url': () => t`Add your custom search address, save, then turn on Web beside the message box.`,
};

export function setWebSearchToggle(button, { enabled = false, configured = false } = {}) {
    if (!button) return;
    button.setAttribute('aria-pressed', String(Boolean(enabled)));
    button.classList.toggle('menu_button_primary', Boolean(enabled));
    button.title = enabled ? t`Web search is on for this session`
        : configured ? t`Search the web for this message` : t`Set up web search in Context`;
    button.setAttribute('aria-label', button.title);
}

function keyButton(key, label) {
    return h('button', {
        type: 'button',
        class: 'menu_button scratchpad-button manage-api-keys',
        dataset: { key },
        title: label,
    }, h('i', { class: 'fa-solid fa-key', 'aria-hidden': 'true' }), h('span', { text: label }));
}

function providerStatus(config, readiness, error) {
    if (error) return error;
    if (!readiness) return t`Web search settings are loading.`;
    if (readiness.configured && readiness.provider === config.provider) return t`Ready. Only the message you send is used as the search query.`;
    return MISSING[readiness.missing]?.() || t`Save a provider to use web search.`;
}

/**
 * Account-wide provider settings. The search service never receives the chat,
 * cards, persona or saved notes; the explanation sits beside the controls.
 * A draft survives background refreshes and failed saves until a save succeeds.
 */
export function renderWebSearchSettings({ config, draft, readiness, error = '', saving = false, onSave, onRefresh, onDraft }) {
    const saved = config ?? { provider: 'off', searxngUrl: '', customUrl: '', customHeader: '', results: 5 };
    const value = draft ?? saved;
    const status = h('p', { class: `scratchpad-muted scratchpad-web-status${error ? ' scratchpad-error' : ''}`, role: 'status' });
    const provider = h('select', {
        class: 'text_pole', id: 'scratchpad-web-search-provider',
        onchange: () => { updateProvider(); emitDraft(); },
    }, PROVIDERS.map(([id, label]) => h('option', { value: id, text: label })));
    provider.value = value.provider;

    const braveKey = h('div', { class: 'scratchpad-web-key' },
        keyButton('api_key_brave_search', t`Manage Brave Search key`),
        h('small', { text: t`Saved with the same key manager as your other API keys.` }));
    const nanoKey = h('div', { class: 'scratchpad-web-key' },
        keyButton('api_key_nanogpt', t`Manage NanoGPT key`),
        h('small', { text: t`The same NanoGPT key is used for chat and web search.` }));
    const exaKey = h('div', { class: 'scratchpad-web-key' },
        keyButton('api_key_exa', t`Manage Exa key`),
        h('small', { text: t`Saved with the same key manager as your other API keys.` }));
    const tavilyKey = h('div', { class: 'scratchpad-web-key' },
        keyButton('api_key_tavily', t`Manage Tavily key`),
        h('small', { text: t`Saved with the same key manager as your other API keys.` }));
    const customInput = h('input', { type: 'url', class: 'text_pole', id: 'scratchpad-web-search-custom', value: value.customUrl ?? '',
        placeholder: 'https://search.example.com/api?q={query}&limit={count}', oninput: () => { updateStatus(); emitDraft(); } });
    const customHeaderInput = h('input', { type: 'text', class: 'text_pole', id: 'scratchpad-web-search-custom-header', value: value.customHeader ?? '',
        placeholder: 'Authorization', autocomplete: 'off', spellcheck: 'false', oninput: () => { updateStatus(); emitDraft(); } });
    const customFields = h('div', { class: 'scratchpad-web-custom' },
        h('div', { class: 'scratchpad-field' },
            h('label', { for: 'scratchpad-web-search-custom', text: t`Custom search address` }),
            customInput,
            h('small', { text: t`Put {query} where the search words go and {count} where the number of results goes. The address must return JSON with a url and title for each result.` })),
        h('div', { class: 'scratchpad-web-key' },
            keyButton('api_key_custom_search', t`Manage custom search key`),
            h('small', { text: t`Optional. Leave it empty if the service needs no key.` })),
        h('div', { class: 'scratchpad-field' },
            h('label', { for: 'scratchpad-web-search-custom-header', text: t`Key header` }),
            customHeaderInput,
            h('small', { text: t`Authorization sends the key as Bearer. Any other header, such as X-API-Key, sends the key as it is.` })));
    const urlInput = h('input', { type: 'url', class: 'text_pole', id: 'scratchpad-web-search-searxng', value: value.searxngUrl,
        placeholder: 'https://search.example.com/searxng', oninput: () => { updateStatus(); emitDraft(); } });
    const urlField = h('div', { class: 'scratchpad-field' },
        h('label', { for: 'scratchpad-web-search-searxng', text: t`SearXNG address` }),
        urlInput,
        h('small', { text: t`Keep the base path. JSON output must be enabled in SearXNG. A 403 means it refused the request, often because JSON output is off or this server is not allowed.` }));
    const results = h('select', { class: 'text_pole', id: 'scratchpad-web-search-results',
        onchange: () => { updateStatus(); emitDraft(); } },
    Array.from({ length: 10 }, (_, index) => h('option', { value: String(index + 1), text: String(index + 1) })));
    results.value = String(value.results || 5);
    const readDraft = () => ({
        provider: provider.value,
        searxngUrl: urlInput.value.trim(),
        customUrl: customInput.value.trim(),
        customHeader: customHeaderInput.value.trim(),
        results: Number(results.value),
    });
    const emitDraft = () => onDraft?.(readDraft());
    const save = h('button', {
        type: 'button',
        class: 'menu_button menu_button_primary scratchpad-button',
        id: 'scratchpad-web-search-save',
        disabled: saving,
        onclick: () => {
            const next = readDraft();
            emitDraft();
            onSave?.(next);
        },
    }, h('i', { class: `fa-solid ${saving ? 'fa-spinner' : 'fa-floppy-disk'}`, 'aria-hidden': 'true' }), h('span', { text: saving ? t`Saving…` : t`Save web search` }));
    const refresh = h('button', {
        type: 'button',
        class: 'menu_button scratchpad-button',
        id: 'scratchpad-web-search-refresh',
        disabled: saving,
        onclick: () => onRefresh?.(),
    }, h('i', { class: 'fa-solid fa-rotate', 'aria-hidden': 'true' }), h('span', { text: t`Check again` }));

    function isDirty() {
        return provider.value !== saved.provider
            || urlInput.value.trim() !== (saved.searxngUrl ?? '')
            || customInput.value.trim() !== (saved.customUrl ?? '')
            || customHeaderInput.value.trim() !== (saved.customHeader ?? '')
            || Number(results.value) !== Number(saved.results || 5);
    }
    function statusText() {
        if (error) return error;
        if (provider.value !== saved.provider) return t`Save to use this provider.`;
        if (isDirty()) return t`Unsaved changes. Press Save web search to apply them.`;
        return providerStatus(saved, readiness, '');
    }
    function updateStatus() {
        status.textContent = statusText();
        status.className = `scratchpad-muted scratchpad-web-status${error ? ' scratchpad-error' : ''}`;
    }
    function updateProvider() {
        const current = provider.value;
        urlField.hidden = current !== 'searxng';
        braveKey.hidden = current !== 'brave';
        nanoKey.hidden = current !== 'nanogpt';
        exaKey.hidden = current !== 'exa';
        tavilyKey.hidden = current !== 'tavily';
        customFields.hidden = current !== 'custom';
        updateStatus();
    }
    updateProvider();

    return h('section', { class: 'scratchpad-section scratchpad-web-settings', id: 'scratchpad-web-search-settings' },
        h('h3', { class: 'scratchpad-section-title', text: t`Web search` }),
        h('p', { class: 'scratchpad-muted', text: t`Saved for your account and used by every Scratchpad session.` }),
        h('p', { class: 'scratchpad-muted', text: t`Only the message you send is used as the search query. Scratchpad does not send the chat, character cards, persona or saved notes to the search service.` }),
        h('div', { class: 'scratchpad-field' }, h('label', { for: 'scratchpad-web-search-provider', text: t`Provider` }), provider),
        braveKey,
        nanoKey,
        exaKey,
        tavilyKey,
        urlField,
        customFields,
        h('div', { class: 'scratchpad-field' }, h('label', { for: 'scratchpad-web-search-results', text: t`Results to read` }), results,
            h('small', { text: t`Between 1 and 10. Five is the default.` })),
        status,
        h('div', { class: 'scratchpad-web-actions' }, save, refresh));
}

function safeWebUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch {
        return '';
    }
}

/** Numbered sources and the exact query, kept under the reply rather than in it. */
export function renderWebSearchSources(message) {
    const metadata = message?.webSearch;
    if (!metadata || typeof metadata !== 'object') return null;
    const sources = (Array.isArray(metadata.sources) ? metadata.sources : []).flatMap(source => {
        const url = safeWebUrl(source?.url);
        return url ? [{ title: String(source.title || url).slice(0, 200), url }] : [];
    }).slice(0, 10);
    const query = typeof metadata.query === 'string' ? metadata.query.slice(0, 400) : '';
    const error = typeof metadata.error === 'string' ? metadata.error.slice(0, 300) : '';
    const details = h('details', { class: 'scratchpad-web-sources scratchpad-sources', open: Boolean(error) || !sources.length },
        h('summary', { class: 'scratchpad-web-summary', text: sources.length ? t`Sources (${sources.length})` : t`Web search` }));
    const body = h('div', { class: 'scratchpad-web-source-body' });
    if (query) body.append(h('p', { class: 'scratchpad-web-query', text: t`Search query: ${query}` }));
    if (error) body.append(h('p', { class: 'scratchpad-web-error', role: 'status', text: t`Web search failed: ${error}` }));
    if (sources.length) {
        const list = h('ol', { class: 'scratchpad-web-source-list scratchpad-source-list' });
        for (const [index, source] of sources.entries()) {
            list.append(h('li', {},
                h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer', text: source.title || t`Source ${index + 1}` }),
                h('small', { class: 'scratchpad-web-url', text: source.url.length > 160 ? `${source.url.slice(0, 157)}...` : source.url })));
        }
        body.append(list);
    } else if (!error) {
        body.append(h('p', { class: 'scratchpad-muted', text: t`No web results were found for this message.` }));
    }
    details.append(body);
    return details;
}

export const testExports = { safeWebUrl, PROVIDERS };
