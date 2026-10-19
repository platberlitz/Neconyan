import { isEngineAvailable } from '../engine-gate.js';
import { button, el } from '../dom.js';
import { isAppMounted } from '../ui/app-loader.js';
import { requestWorkbench, consumeWorkbenchRequest } from '../ui/workbench-request.js';

const ENGINE_OFF_NOTICE = 'The macro workbench needs the New macro engine. Open Settings, then Fine-tuning, and turn it on.';
const TAB_KEYS = Object.freeze({
    Playground: 'playground',
    Reference: 'reference',
    'Cache Audit': 'chat',
    Trace: 'playground',
    'My macros': 'macros',
    'This chat': 'chat',
    Setup: 'setup',
});

let openPopup = null;

export function isWorkbenchOpen() {
    return isAppMounted() || !!openPopup;
}

export function closeWorkbench() {
    if (isAppMounted()) {
        requestWorkbench({ reset: true });
    }
    if (openPopup) {
        const popup = openPopup;
        openPopup = null;
        popup.completeCancelled?.();
    }
}

function waitForDrawerInPage(timeoutMs = 4000) {
    return new Promise(resolve => {
        const started = performance.now();
        const check = () => {
            if (document.querySelector('.neconyan-included-tool-content #me-settings-drawer')) {
                resolve(true);
                return;
            }
            if (performance.now() - started >= timeoutMs) {
                resolve(false);
                return;
            }
            requestAnimationFrame(check);
        };
        check();
    });
}

/**
 * Opens the macro page at a tab (or reveals a reference entry). Keeps its old
 * signature so slash commands and help buttons continue to work.
 *
 * @param {object} [options]
 * @param {string} [options.initialText]
 * @param {string} [options.tab]
 * @param {string} [options.topic]
 * @param {string} [options.macro]
 */
export async function openWorkbench({ initialText = '', tab = 'Playground', topic = '', macro = '' } = {}) {
    const ctx = SillyTavern.getContext();
    if (!isEngineAvailable()) {
        await ctx.Popup?.show?.text?.('Macro Enhanced', ENGINE_OFF_NOTICE);
        return;
    }

    const request = {
        tab: TAB_KEYS[tab] ?? tab,
        topic,
        macro,
        initialText,
    };
    requestWorkbench(request);

    const shell = globalThis.NeconyanShell;
    if (shell?.openIncludedTool?.('MacroEnhanced')) {
        await waitForDrawerInPage();
        return;
    }

    // No shell to consume it; do not replay this request when the page mounts later.
    consumeWorkbenchRequest();
    await openFallbackPopup(request);
}

/**
 * A compact Playground and Reference for forks without the Neconyan shell. The
 * full page is the normal path; this keeps /me-workbench useful if the page
 * cannot open.
 */
async function openFallbackPopup(request) {
    const ctx = SillyTavern.getContext();
    if (openPopup) {
        return;
    }
    const [{ createPlaygroundPanel }, { createTabs }, { renderReferenceTab }] = await Promise.all([
        import('../ui/playground.js'),
        import('../ui/tabs.js'),
        import('../help/reference-ui.js'),
    ]);
    if (openPopup) {
        return;
    }
    const root = el('div', 'me-workbench me-fallback');
    root.appendChild(el('h3', 'me-editor-title', 'Macro Workbench'));
    root.appendChild(el('p', 'me-section-note', 'The full page adds My macros, This chat and Setup. Open Macro Enhanced from Fine-tuning for those.'));

    const panelHost = el('div', 'me-panels');
    const playgroundPanel = el('section', 'me-panel');
    playgroundPanel.id = 'me-fallback-panel-playground';
    playgroundPanel.setAttribute('role', 'tabpanel');
    playgroundPanel.setAttribute('aria-labelledby', 'me-fallback-tab-playground');
    const referencePanel = el('section', 'me-panel');
    referencePanel.id = 'me-fallback-panel-reference';
    referencePanel.setAttribute('role', 'tabpanel');
    referencePanel.setAttribute('aria-labelledby', 'me-fallback-tab-reference');
    panelHost.append(playgroundPanel, referencePanel);

    const localState = { playgroundText: request.initialText ?? '' };
    const playground = createPlaygroundPanel({ state: localState });
    playgroundPanel.appendChild(playground.element);

    const referenceElement = el('div', 'me-ref');
    const reference = renderReferenceTab(referenceElement, {
        onInsert: example => {
            tabs.select('playground');
            playground.setText(example);
        },
    });
    referencePanel.appendChild(referenceElement);

    const tabs = createTabs({
        tabs: [
            { key: 'playground', label: 'Playground', panel: playgroundPanel },
            { key: 'reference', label: 'Reference', panel: referencePanel },
        ],
        active: request.tab === 'reference' ? 'reference' : 'playground',
        idPrefix: 'me-fallback',
        onChange: () => {},
    });
    root.appendChild(tabs.element);
    root.appendChild(panelHost);
    root.appendChild(button('menu_button', 'Close', () => openPopup?.completeCancelled?.()));

    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Close',
    });
    openPopup = popup;
    tabs.select(request.tab === 'reference' ? 'reference' : 'playground', { notify: false });
    if (request.topic) {
        requestAnimationFrame(() => reference.focusTopic(request.topic));
    } else if (request.macro) {
        requestAnimationFrame(() => reference.focusMacro(request.macro));
    }
    if (request.initialText) {
        playground.setText(request.initialText);
    }
    try {
        await popup.show();
    } finally {
        playground.destroy();
        reference.destroy();
        openPopup = null;
    }
}
