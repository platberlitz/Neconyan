import { main_api, this_chid } from '../script.js';
import { selected_group } from './group-chats.js';
import { promptManager, oai_settings } from './openai.js';
import { eventSource, event_types } from './events.js';
import { accountStorage } from './util/AccountStorage.js';
import { t } from './i18n.js';
import { getPinnedPromptRows, resolveChatWidgetLayout } from './pinned-prompt-toggles.js';

const COLLAPSED_KEY = 'neconyan-pinned-prompts-collapsed';
let controller;

/** Small, dependency-injectable controller. No prompt state is owned by the dock. */
export function createChatWidgets({ getState, events = eventSource, types = event_types, storage = accountStorage,
    doc = document, win = window }) {
    const desktop = win.matchMedia('(min-width: 769px)');
    const host = doc.getElementById('sheld');
    const link = doc.getElementById('neconyan-chat-widgets-stylesheet');
    const rows = new Map();
    let aside, section, heading, summary, preset, collapse, list;
    let disposed = false, scheduled = false, switching = false, stylesReady = false;
    let collapsed = false, storageRead = false;
    let hostWidth = host?.getBoundingClientRect().width ?? 0;
    const bindings = [];

    const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    const setAttribute = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };

    function remove() {
        aside?.remove();
        aside = null;
        rows.clear();
        host?.removeAttribute('data-neconyan-chat-widgets');
    }

    function schedule() {
        if (scheduled || disposed) return;
        scheduled = true;
        win.queueMicrotask(() => { scheduled = false; refresh(); });
    }

    function mount() {
        aside = doc.createElement('aside');
        aside.id = 'neconyan-chat-widgets';
        aside.hidden = true;
        aside.setAttribute('aria-labelledby', 'neconyan-pinned-prompts-heading');
        section = doc.createElement('section');
        section.id = 'neconyan-pinned-prompts';
        const header = doc.createElement('div');
        header.className = 'nn-pinned-header';
        heading = doc.createElement('h2');
        heading.id = 'neconyan-pinned-prompts-heading';
        heading.dataset.i18n = 'Pinned prompts';
        heading.textContent = t`Pinned prompts`;
        summary = doc.createElement('small');
        summary.className = 'nn-pinned-summary';
        collapse = doc.createElement('button');
        collapse.type = 'button';
        collapse.className = 'menu_button nn-pinned-collapse';
        collapse.setAttribute('aria-controls', 'neconyan-pinned-prompts-content');
        collapse.addEventListener('click', () => {
            collapsed = !collapsed;
            storage.setItem(COLLAPSED_KEY, String(collapsed));
            refresh();
        });
        header.append(heading, summary, collapse);
        const content = doc.createElement('div');
        content.id = 'neconyan-pinned-prompts-content';
        preset = doc.createElement('div');
        preset.className = 'nn-pinned-preset';
        preset.setAttribute('data-i18n-ignore', '');
        list = doc.createElement('div');
        list.className = 'nn-pinned-list';
        content.append(preset, list);
        section.append(header, content);
        aside.append(section);
        host.prepend(aside);
    }

    function refresh() {
        if (disposed) return;
        const state = getState();
        const projected = getPinnedPromptRows(state.manager);
        const visible = host && stylesReady && desktop.matches && !switching && !state.manager?.isPresetChanging && storage.isReady &&
            doc.body.classList.contains('neconyan') && !doc.body.classList.contains('neconyan-home-visible') &&
            !doc.body.classList.contains('sbterm') && state.mode === 'roleplay' && state.hasChat && state.api === 'openai' && projected.length;
        if (!visible) { remove(); return; }
        if (!storageRead) {
            collapsed = storage.getItem(COLLAPSED_KEY) === 'true';
            storageRead = true;
        }
        if (!aside) mount();
        const layout = resolveChatWidgetLayout({ hostWidth, collapsed });
        if (host.getAttribute('data-neconyan-chat-widgets') !== layout) host.setAttribute('data-neconyan-chat-widgets', layout);
        setAttribute(section, 'data-collapsed', String(collapsed));
        const content = doc.getElementById('neconyan-pinned-prompts-content');
        if (content.hidden !== collapsed) content.hidden = collapsed;
        setText(heading, t`Pinned prompts`);
        setText(summary, t`${projected.filter(row => row.enabled).length}/${projected.length} on`);
        setText(preset, state.name);
        setAttribute(preset, 'title', state.name);
        setAttribute(collapse, 'aria-expanded', String(!collapsed));
        const action = collapsed ? t`Expand pinned prompts` : t`Collapse pinned prompts`;
        setAttribute(collapse, 'title', action);
        setAttribute(collapse, 'aria-label', action);
        setText(collapse, collapsed ? '⌄' : '⌃');
        const wanted = new Set(projected.map(row => row.identifier));
        for (const [identifier, button] of rows) {
            if (!wanted.has(identifier)) { button.remove(); rows.delete(identifier); }
        }
        projected.forEach((row, index) => {
            let button = rows.get(row.identifier);
            if (!button) {
                button = doc.createElement('button');
                button.type = 'button';
                button.className = 'nn-pinned-switch';
                button.setAttribute('role', 'switch');
                button.setAttribute('data-i18n-ignore', '');
                button.dataset.promptIdentifier = row.identifier;
                const name = doc.createElement('span');
                name.className = 'nn-pinned-name';
                name.setAttribute('data-i18n-ignore', '');
                const status = doc.createElement('span');
                status.className = 'nn-pinned-state';
                status.setAttribute('aria-hidden', 'true');
                button.append(name, status);
                button.addEventListener('click', () => {
                    const current = getState();
                    const scope = button.promptScope;
                    if (!aside || button.parentElement !== list || switching || !desktop.matches || current.mode !== 'roleplay' || !current.hasChat || current.api !== 'openai' || current.manager !== scope.manager ||
                        !doc.body.classList.contains('neconyan') || doc.body.classList.contains('neconyan-home-visible') || doc.body.classList.contains('sbterm') ||
                        current.name !== scope.name || !current.manager.isPromptScopeCurrent(scope)) return;
                    current.manager.setPromptEnabled(scope.prompt.identifier, !scope.entry.enabled);
                });
                rows.set(row.identifier, button);
            }
            button.promptScope = { manager: state.manager, name: state.name, character: state.manager.activeCharacter, prompt: row.prompt, entry: row.entry };
            if (button.getAttribute('aria-checked') !== String(row.enabled)) button.setAttribute('aria-checked', String(row.enabled));
            setAttribute(button, 'aria-label', row.name);
            setAttribute(button, 'title', row.name);
            setText(button.firstElementChild, row.name);
            setText(button.lastElementChild, row.enabled ? t`On` : t`Off`);
            if (list.children[index] !== button) list.insertBefore(button, list.children[index] ?? null);
        });
        if (aside.hidden) aside.hidden = false;
    }

    const beforePreset = () => { switching = true; remove(); };
    const afterPreset = () => { switching = false; schedule(); };
    for (const key of ['PROMPT_MANAGER_UPDATED', 'CHAT_CHANGED', 'CHAT_LOADED', 'CHATCOMPLETION_SOURCE_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'MAIN_API_CHANGED',
        'SETTINGS_LOADED_AFTER', 'SETTINGS_UPDATED', 'PRESET_RENAMED', 'PRESET_DELETED', 'APP_READY']) {
        events.on(types[key], schedule);
        bindings.push([types[key], schedule]);
    }
    events.on(types.OAI_PRESET_CHANGED_BEFORE, beforePreset);
    events.on(types.OAI_PRESET_CHANGED_AFTER, afterPreset);
    const presetChanged = data => { if (data?.apiId === 'openai') afterPreset(); };
    events.on(types.PRESET_CHANGED, presetChanged);
    bindings.push([types.OAI_PRESET_CHANGED_BEFORE, beforePreset], [types.OAI_PRESET_CHANGED_AFTER, afterPreset], [types.PRESET_CHANGED, presetChanged]);
    const mediaChanged = () => { if (!desktop.matches) remove(); else refresh(); };
    desktop.addEventListener('change', mediaChanged);
    const bodyObserver = new win.MutationObserver(schedule);
    bodyObserver.observe(doc.body, { attributes: true, attributeFilter: ['class', 'data-neconyan-chat-mode'] });
    const resize = new win.ResizeObserver(entries => {
        const entry = entries[0];
        hostWidth = entry?.borderBoxSize?.[0]?.inlineSize ?? host.getBoundingClientRect().width;
        schedule();
    });
    if (host) resize.observe(host, { box: 'border-box' });
    const windowEvents = ['neconyan:home-hidden', 'sb:conversation-workspace-state-changed', 'neconyan:hopper-state-changed', 'neconyan:story-state-changed'];
    windowEvents.forEach(event => win.addEventListener(event, schedule));
    const styleLoaded = () => {
        stylesReady = Boolean(link?.rel === 'stylesheet' && link.sheet);
        schedule();
    };
    const styleFailed = () => { stylesReady = false; remove(); };
    if (link) {
        link.addEventListener('load', styleLoaded);
        link.addEventListener('error', styleFailed);
        link.rel = 'stylesheet';
        link.media = link.dataset.sbMedia || 'all';
        link.dataset.sbStyleActivated = 'true';
        styleLoaded();
    }
    refresh();
    return { refresh, dispose() {
        disposed = true;
        remove();
        bodyObserver.disconnect();
        resize.disconnect();
        desktop.removeEventListener('change', mediaChanged);
        bindings.forEach(([event, listener]) => events.removeListener(event, listener));
        windowEvents.forEach(event => win.removeEventListener(event, schedule));
        link?.removeEventListener('load', styleLoaded);
        link?.removeEventListener('error', styleFailed);
    } };
}

export function initChatWidgets({ getMode }) {
    if (!controller) controller = createChatWidgets({ getState: () => ({ manager: promptManager, name: oai_settings.preset_settings_openai,
        mode: getMode(), api: main_api, hasChat: Boolean(selected_group || this_chid !== undefined && this_chid !== null) }) });
    controller.refresh();
    return controller;
}
