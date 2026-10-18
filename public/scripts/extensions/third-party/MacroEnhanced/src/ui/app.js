/**
 * The Macro Enhanced page: status strip, five tabs and their panels. Mounted
 * inside the host's `#me-settings-drawer`, which the shell moves into the
 * Included tool page and back again without losing this DOM or its state.
 */
import { announce, announceError, button, el, helpButton } from '../dom.js';
import { getRemaps } from '../registration.js';
import { createTabs } from './tabs.js';
import { renderReferenceTab } from '../help/reference-ui.js';
import { createPlaygroundPanel } from './playground.js';
import { createMyMacrosPanel } from './my-macros.js';
import { createThisChatPanel } from './this-chat.js';
import { createSetupPanel } from './setup.js';
import { consumeWorkbenchRequest, onWorkbenchRequest } from './workbench-request.js';
import { setActiveTab, uiState } from './ui-state.js';

let activeApp = null;

function createApp(container, { engineAvailable }) {
    const root = el('div', 'me-workbench me-app');
    root.dataset.meApp = '';
    const statusHost = el('div', 'me-status');
    const live = el('div', 'me-sr-only', '');
    live.dataset.meLive = '';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    const alert = el('div', 'me-sr-only', '');
    alert.dataset.meAlert = '';
    alert.setAttribute('role', 'alert');
    alert.setAttribute('aria-live', 'assertive');
    alert.setAttribute('aria-atomic', 'true');
    const body = el('div', 'me-body');
    root.append(statusHost, live, alert, body);
    container.replaceChildren(root);

    let panels = null;
    let tabs = null;
    let playground = null;
    let reference = null;
    let myMacros = null;
    let thisChat = null;
    let setup = null;
    let reloadPending = false;
    let reloadRequested = false;
    let engineOn = false;

    function openReferenceTopic(topic) {
        if (!panels) {
            announce('Turn on the new macro engine to read the guides.');
            statusHost.querySelector('.me-engine-on')?.focus();
            return;
        }
        selectTab('reference');
        requestAnimationFrame(() => reference?.focusTopic(topic));
    }

    function openReferenceMacro(macro) {
        if (!panels) {
            return;
        }
        selectTab('reference');
        requestAnimationFrame(() => reference?.focusMacro(macro));
    }

    function selectTab(key) {
        if (!panels) {
            return;
        }
        tabs.select(key);
        setActiveTab(key);
    }

    function applyRequest(request) {
        if (!request) {
            return;
        }
        if (request.initialText) {
            playground?.setText(request.initialText);
            selectTab('playground');
        }
        if (request.tab) {
            const tab = request.tab === 'trace' ? 'playground' : request.tab === 'audit' ? 'chat' : request.tab;
            if (['playground', 'reference', 'macros', 'chat', 'setup'].includes(tab)) {
                selectTab(tab);
            }
        }
        if (request.topic) {
            openReferenceTopic(request.topic);
        } else if (request.macro) {
            openReferenceMacro(request.macro);
        }
        if (request.reset) {
            playground?.resetSandbox();
        }
    }

    const stopRequestListener = onWorkbenchRequest(() => {
        const request = consumeWorkbenchRequest();
        applyRequest(request);
    });

    function createPanels() {
        playground?.destroy?.();
        myMacros?.destroy?.();
        reference?.destroy?.();
        body.replaceChildren();
        const panelHost = el('div', 'me-panels');
        const panelSpecs = [
            { key: 'playground', label: 'Playground', controller: createPlaygroundPanel({ announce, openReference: () => openReferenceTopic('getting-started') }) },
            { key: 'reference', label: 'Reference', controller: null },
            { key: 'macros', label: 'My macros', controller: createMyMacrosPanel({ announce, onTry: text => { selectTab('playground'); playground?.setText(text); } }) },
            { key: 'chat', label: 'This chat', controller: createThisChatPanel({ openTopic: openReferenceTopic }) },
            { key: 'setup', label: 'Setup', controller: createSetupPanel({ openTopic: openReferenceTopic }) },
        ];

        const referenceElement = el('div', 'me-ref');
        reference = renderReferenceTab(referenceElement, {
            onInsert: example => {
                selectTab('playground');
                playground?.setText(example);
            },
        });
        panelSpecs[1].controller = { element: referenceElement };

        const tabModels = [];
        for (const spec of panelSpecs) {
            const panel = el('section', 'me-panel');
            panel.id = `me-panel-${spec.key}`;
            panel.dataset.meTab = spec.key;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', `me-tab-${spec.key}`);
            panel.appendChild(spec.controller.element);
            panelHost.appendChild(panel);
            tabModels.push({ key: spec.key, label: spec.label, panel });
        }
        body.appendChild(panelHost);

        playground = panelSpecs[0].controller;
        myMacros = panelSpecs[2].controller;
        thisChat = panelSpecs[3].controller;
        setup = panelSpecs[4].controller;

        tabs = createTabs({
            tabs: tabModels,
            active: uiState.activeTab,
            onChange: key => {
                setActiveTab(key);
            },
        });
        body.insertBefore(tabs.element, panelHost);
        panels = panelHost;
        const remembered = consumeWorkbenchRequest();
        const startTab = remembered?.tab ?? uiState.activeTab;
        tabs.select(startTab, { notify: false });
        setActiveTab(startTab);
        if (remembered) {
            applyRequest(remembered);
        }
        body.hidden = !engineOn;
    }

    function renderStatus() {
        statusHost.replaceChildren();

        const boundary = el('div', 'me-boundary');
        boundary.dataset.meServerBoundary = '';
        const icon = el('span', 'me-boundary-icon', 'i');
        icon.setAttribute('aria-hidden', 'true');
        boundary.appendChild(icon);
        boundary.appendChild(el('p', 'me-boundary-copy', 'Most macros here are browser-only.'));
        boundary.appendChild(helpButton('Server prompts and saved variables', () => openReferenceTopic('server-prompts')));
        statusHost.appendChild(boundary);

        const remaps = getRemaps();
        if (remaps.size) {
            const warning = el('div', 'me-warning me-remap-warning');
            warning.appendChild(el('b', undefined, 'Renamed because Neconyan already uses the name: '));
            warning.appendChild(document.createTextNode(
                [...remaps.values()].map(({ requested, actual }) => `{{${requested}}} is {{${actual}}} here`).join(', ')));
            statusHost.appendChild(warning);
        }

        if (!engineOn && !reloadPending) {
            const card = el('div', 'me-callout me-engine-card');
            card.appendChild(el('h2', 'me-callout-title', 'Macro Enhanced is asleep'));
            card.appendChild(el('p', 'me-section-note', 'The new macro engine is off. Turn it on to use the Playground, the reference and your saved macros.'));
            const turnOn = button('menu_button menu_button_primary me-engine-on', 'Turn on the new macro engine', () => {
                const toggle = document.getElementById('experimental_macro_engine');
                if (!(toggle instanceof HTMLElement)) {
                    announceError('Open Settings, then Fine-tuning, then turn on New macro engine.');
                    return;
                }
                toggle.checked = true;
                toggle.dispatchEvent(new Event('input', { bubbles: true }));
                reloadPending = true;
                announce('New macro engine turned on. Reload to finish.');
                renderStatus();
            });
            card.appendChild(turnOn);
            statusHost.appendChild(card);
            return;
        }

        if (reloadPending) {
            const card = el('div', 'me-callout me-reload-card');
            card.appendChild(el('h2', 'me-callout-title', 'Reload to finish'));
            card.appendChild(el('p', 'me-section-note', 'The new macro engine is on. Reload Neconyan to wake this page.'));
            card.appendChild(button('menu_button menu_button_primary', 'Reload now', () => {
                reloadRequested = true;
                announce('Saving your settings. The page will reload when the save lands.');
                SillyTavern.getContext().saveSettingsDebounced?.();
            }));
            statusHost.appendChild(card);
        }
    }

    function setEngineAvailable(next) {
        const available = !!next;
        const wasOn = engineOn;
        if (!available) {
            engineOn = false;
            reloadPending = false;
            reloadRequested = false;
            body.hidden = true;
            renderStatus();
            return;
        }
        if (!panels) {
            engineOn = true;
            createPanels();
            renderStatus();
            if (!wasOn) {
                refresh('all');
            }
            return;
        }
        engineOn = true;
        body.hidden = false;
        renderStatus();
        if (!wasOn) {
            refresh('all');
        }
    }

    function refresh(kind) {
        if (!panels) {
            return;
        }
        playground?.refresh(kind);
        if (kind === 'macros' || kind === 'all') {
            reference?.refresh();
        }
        myMacros?.refresh(kind);
        if (kind === 'values' || kind === 'chat' || kind === 'pronouns' || kind === 'all') {
            thisChat?.refresh(kind);
        }
        setup?.refresh(kind);
    }

    function handleChatChanged() {
        playground?.handleChatChanged();
        myMacros?.handleChatChanged();
        reference?.refresh();
        thisChat?.handleChatChanged();
        setup?.refresh('chat');
    }

    function handleSettingsUpdated() {
        if (!engineOn) {
            return;
        }
        if (reloadRequested) {
            window.location.reload();
        }
    }

    function destroy() {
        stopRequestListener();
        playground?.destroy?.();
        myMacros?.destroy?.();
        reference?.destroy?.();
        panels = null;
        tabs = null;
        playground = null;
        reference = null;
        myMacros = null;
        thisChat = null;
        setup = null;
        container.replaceChildren();
    }

    engineOn = !!engineAvailable;
    if (engineOn) {
        // A page opened while the engine is already on does not need a reload card.
        reloadPending = false;
        createPanels();
        const pending = consumeWorkbenchRequest();
        if (pending) {
            applyRequest(pending);
        }
    }
    renderStatus();
    body.hidden = !engineOn;

    return {
        setEngineAvailable,
        refresh,
        handleChatChanged,
        handleSettingsUpdated,
        destroy,
    };
}

/**
 * Mounts the page once, or refreshes the existing mount in place.
 * @param {HTMLElement} container
 * @param {{engineAvailable: boolean}} options
 */
export function mountApp(container, { engineAvailable }) {
    if (activeApp && container.querySelector('[data-me-app]')) {
        activeApp.setEngineAvailable(engineAvailable);
        return;
    }
    activeApp?.destroy();
    activeApp = createApp(container, { engineAvailable });
}

export function refreshApp(kind = 'all') {
    activeApp?.refresh(kind);
}

export function appSettingsUpdated() {
    activeApp?.handleSettingsUpdated();
}

export function appChatChanged() {
    activeApp?.handleChatChanged();
}

export function unmountApp() {
    activeApp?.destroy();
    activeApp = null;
    uiState.editorDraft = null;
}

export function isAppMounted() {
    return !!activeApp;
}
