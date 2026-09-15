import { EXTENSION_LABEL, EXTENSION_NAME, TAB, TAB_LABEL, TAB_META } from '../constants.js';
import { button, element, replace } from '../dom.js';
import { createLedger } from '../ledger.js';
import { createAbTab } from './ab-tab.js';
import { createCasesTab } from './cases-tab.js';
import { createDiffTab } from './diff-tab.js';
import { createExperimentTab } from './experiment-tab.js';
import { createLedgerTab } from './ledger-tab.js';
import { createPresetsTab } from './presets-tab.js';
import { createPromptsTab } from './prompts-tab.js';
import { createRunTab } from './run-tab.js';
import { createScenesTab } from './scenes-tab.js';
import { createSettingsTab } from './settings-tab.js';
import { createWorkbench } from './workbench.js';

const TOKEN_SPEND_TAB_LABELS = Object.entries(TAB_META)
    .filter(([, meta]) => meta.sends)
    .map(([id]) => TAB_LABEL[id]);
const TOKEN_SPEND_TAB_NAMES = new Intl.ListFormat('en', { type: 'conjunction' })
    .format(TOKEN_SPEND_TAB_LABELS);
const TOKEN_SPEND_SUMMARY = `${TOKEN_SPEND_TAB_NAMES} ${TOKEN_SPEND_TAB_LABELS.length === 1 ? 'is' : 'are'}`
    + ` the only ${TOKEN_SPEND_TAB_LABELS.length === 1 ? 'tab' : 'tabs'} that send requests and use tokens,`
    + ` and only when you press ${TOKEN_SPEND_TAB_LABELS.length === 1 ? 'its button' : 'their buttons'}.`;
const TABBABLE_SELECTOR = [
    'a[href]', 'area[href]', 'button', 'input', 'select', 'textarea',
    'iframe', 'object', 'embed', 'summary', 'audio[controls]', 'video[controls]',
    '[contenteditable]:not([contenteditable="false"])', '[tabindex]',
].join(', ');

let mounted = null;

function settingsHost() {
    return document.getElementById('extensions_settings2')
        ?? document.getElementById('extensions_settings');
}

export function mountRuntimeUi({ signal = null } = {}) {
    if (mounted) {
        mounted.refresh('remount');
        return mounted;
    }

    let menuItem = null;
    let settingsRoot = null;
    let settingsDrawer = null;
    let drawerToggle = null;
    let drawerIcon = null;
    let drawerContent = null;
    let drawerObserver = null;
    let drawerStatus = null;
    let workbenchMount = null;
    let page = null;
    let pageMount = null;
    let pageStatus = null;
    let pageOpener = null;
    let modalObserver = null;
    const modalBackground = new Map();
    let disposed = false;
    let workbench = null;

    /** A small labelled pill for the workspace header. */
    function pill(text, { variant = '', title = '' } = {}) {
        const node = element('span', {
            className: variant ? `sbpl-pill ${variant}` : 'sbpl-pill',
            ...(title ? { attributes: { title } } : {}),
        });
        node.append(
            element('span', { className: 'sbpl-pill-dot', attributes: { 'aria-hidden': 'true' } }),
            element('span', { text }),
        );
        return node;
    }

    /** The workspace header says whether the lab can run before you try. */
    function updatePageStatus() {
        if (!pageStatus?.isConnected) {
            return;
        }
        const availability = workbench.getState().availability;
        let host;
        if (availability?.ok === true && !availability.warnings?.length) {
            host = pill('Host ready', { variant: 'sbpl-pill-ready' });
        } else if (availability?.ok === true) {
            host = pill('Host ready, with notes', {
                variant: 'sbpl-pill-warning',
                title: availability.warnings.join(' '),
            });
        } else if (availability?.ok === false) {
            host = pill('Host not compatible', {
                variant: 'sbpl-pill-error',
                title: availability.reason ?? '',
            });
        } else {
            host = pill('Checking host...', { variant: 'sbpl-pill-quiet' });
        }
        replace(
            pageStatus,
            host,
            pill(`Only ${TOKEN_SPEND_TAB_LABELS.length} tabs use tokens`, {
                variant: 'sbpl-pill-quiet',
                title: TOKEN_SPEND_SUMMARY,
            }),
        );
    }

    function updateDrawer() {
        updatePageStatus();
        if (!settingsDrawer?.isConnected || !drawerStatus) {
            return;
        }
        const state = workbench.getState();
        if (state.availability?.ok === true) {
            drawerStatus.hidden = true;
            drawerStatus.textContent = '';
            drawerStatus.className = 'sbpl-settings-status sbpl-settings-ready';
            drawerStatus.removeAttribute('title');
        } else if (state.availability?.ok === false) {
            drawerStatus.hidden = false;
            drawerStatus.textContent = 'Prompting Lab cannot run with this Neconyan version. Update Neconyan or Prompting Lab, then reload.';
            drawerStatus.className = 'sbpl-settings-status sbpl-settings-error';
            if (state.availability.reason) {
                drawerStatus.title = `Technical details: ${state.availability.reason}`;
            }
        } else {
            drawerStatus.hidden = false;
            drawerStatus.textContent = 'Checking Neconyan compatibility...';
            drawerStatus.className = 'sbpl-settings-status';
            drawerStatus.removeAttribute('title');
        }
    }

    workbench = createWorkbench({
        lifetimeSignal: signal,
        onStateChange: updateDrawer,
    });

    const runTab = createRunTab({
        onRunFinished: () => {
            workbench.refresh('run-finished');
            diffTab.refresh();
            abTab.refresh();
        },
    });
    const casesTab = createCasesTab({
        onChanged: () => {
            runTab.refresh();
            workbench.refreshReadout();
        },
        onQuickRun: (testCase) => {
            if (workbench.getState().availability?.ok === false) {
                return;
            }
            const suiteId = testCase.suiteId ?? document.querySelector(
                '#sbpl-panel .sbpl-cases-tab > .sbpl-controls select',
            )?.value ?? '';
            workbench.showTab(TAB.RUN);
            runTab.runOne(testCase, suiteId);
        },
    });
    const promptsTab = createPromptsTab({
        onChanged: () => {
            presetsTab.refresh();
            experimentTab.refresh();
            workbench.refreshReadout();
        },
    });
    const presetsTab = createPresetsTab({
        onChanged: () => {
            casesTab.refresh();
            promptsTab.refresh();
            workbench.refreshReadout();
        },
        onPromptSaved: () => {
            promptsTab.refresh();
            experimentTab.refresh();
        },
    });
    const diffTab = createDiffTab();
    const experimentTab = createExperimentTab();
    const abTab = createAbTab();
    const scenesTab = createScenesTab();
    const ledger = createLedger({
        onRecorded: () => {
            ledgerTab.refresh();
            workbench.refreshReadout();
        },
    });
    const ledgerTab = createLedgerTab({ ledger });
    ledger.sync();
    workbench.registerTab(TAB.CASES, casesTab);
    workbench.registerTab(TAB.PRESETS, presetsTab);
    workbench.registerTab(TAB.PROMPTS, promptsTab);
    workbench.registerTab(TAB.RUN, runTab);
    workbench.registerTab(TAB.LEDGER, ledgerTab);
    workbench.registerTab(TAB.DIFF, diffTab);
    workbench.registerTab(TAB.EXPERIMENT, experimentTab);
    const settingsTab = createSettingsTab({
        onChanged: () => {
            casesTab.refresh();
            runTab.refresh();
            diffTab.refresh();
        },
    });
    workbench.registerTab(TAB.AB, abTab);
    workbench.registerTab(TAB.SCENES, scenesTab);
    workbench.registerTab(TAB.SETTINGS, settingsTab);

    function syncDrawerAccessibility() {
        const expanded = Boolean(drawerIcon && !drawerIcon.classList.contains('down'));
        drawerToggle?.setAttribute('aria-expanded', String(expanded));
        drawerContent?.setAttribute('aria-hidden', String(!expanded));
    }

    /* ---------------------------------------------------- full-page mode */

    function pageTabbables() {
        if (!page || page.hidden) {
            return [];
        }
        return [...page.querySelectorAll(TABBABLE_SELECTOR)].filter(node => (
            node.tabIndex >= 0
            && !node.matches(':disabled')
            && !node.closest('[inert]')
            && node.getClientRects().length > 0
            && getComputedStyle(node).visibility !== 'hidden'
        )).sort((left, right) => {
            if (left.tabIndex === right.tabIndex) {
                return 0;
            }
            if (left.tabIndex === 0) {
                return 1;
            }
            if (right.tabIndex === 0) {
                return -1;
            }
            return left.tabIndex - right.tabIndex;
        });
    }

    function hasActiveHostUi(sibling) {
        for (const selector of [':modal', ':popover-open']) {
            try {
                if (sibling.matches(selector) || sibling.querySelector(selector)) {
                    return true;
                }
            } catch {
                // Older hosts may run a browser without one of these selectors.
            }
        }
        const dialog = sibling.matches('dialog[open], [role="dialog"], [role="alertdialog"]')
            ? sibling
            : sibling.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]');
        return Boolean(dialog && !dialog.hidden && dialog.getAttribute('aria-hidden') !== 'true'
            && dialog.getClientRects().length);
    }

    function nestedHostUiOpen() {
        return [...document.body.children].some(sibling => sibling !== page && hasActiveHostUi(sibling));
    }

    function containPageFocus(event) {
        if (!page || page.hidden || page.contains(event.target) || nestedHostUiOpen()) {
            return;
        }
        const restore = () => (pageTabbables()[0] ?? page).focus({ preventScroll: true });
        restore();
        requestAnimationFrame(() => {
            if (page && !page.hidden && !nestedHostUiOpen() && !page.contains(document.activeElement)) {
                restore();
            }
        });
    }

    function inertPageBackground() {
        for (const sibling of document.body.children) {
            if (sibling === page) {
                continue;
            }
            if (!modalBackground.has(sibling)) {
                modalBackground.set(sibling, sibling.hasAttribute('inert'));
            }
            sibling.toggleAttribute('inert', hasActiveHostUi(sibling)
                ? modalBackground.get(sibling)
                : true);
        }
    }

    function activatePageModal() {
        inertPageBackground();
        document.addEventListener('focusin', containPageFocus, true);
        document.addEventListener('toggle', inertPageBackground, true);
        modalObserver?.disconnect();
        modalObserver = new MutationObserver(inertPageBackground);
        modalObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['open', 'role', 'aria-modal', 'aria-hidden', 'hidden', 'popover', 'class', 'style'],
        });
    }

    function deactivatePageModal() {
        modalObserver?.disconnect();
        modalObserver = null;
        document.removeEventListener('focusin', containPageFocus, true);
        document.removeEventListener('toggle', inertPageBackground, true);
        for (const [sibling, wasInert] of modalBackground) {
            sibling.toggleAttribute('inert', wasInert);
        }
        modalBackground.clear();
    }

    function ensurePage() {
        if (page?.isConnected) {
            return;
        }
        deactivatePageModal();
        page?.remove();
        document.getElementById('sbpl-page')?.remove();
        page = element('div', {
            id: 'sbpl-page',
            className: 'sbpl-page',
            attributes: {
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': `${EXTENSION_LABEL} workspace`,
                tabindex: '-1',
            },
        });
        page.hidden = true;

        const header = element('header', { className: 'sbpl-page-header' });
        const heading = element('div', { className: 'sbpl-page-heading' });
        const copy = element('div', { className: 'sbpl-page-copy' });
        copy.append(
            element('h2', { className: 'sbpl-page-title', text: EXTENSION_LABEL }),
            element('p', {
                className: 'sbpl-page-subtitle',
                text: 'Build a prompt the way Neconyan would, check it, and see what a change did to it.',
            }),
        );
        heading.append(
            element('span', {
                className: 'sbpl-page-mark fa-solid fa-flask',
                attributes: { 'aria-hidden': 'true' },
            }),
            copy,
        );

        pageStatus = element('div', { className: 'sbpl-page-status' });
        const actions = element('div', { className: 'sbpl-page-actions' });
        actions.append(
            element('span', {
                className: 'sbpl-page-shortcut',
                text: 'Esc',
                attributes: { 'aria-hidden': 'true', title: 'Escape closes the workspace' },
            }),
            button('Close workspace', () => closePage(), {
                className: 'menu_button sbpl-button sbpl-page-close',
                title: 'Close the workspace and return to Neconyan (Escape)',
            }),
        );
        header.append(heading, pageStatus, actions);

        const body = element('div', { className: 'sbpl-page-body' });
        pageMount = element('div', { className: 'sbpl-workbench-mount' });
        body.append(pageMount);
        page.append(header, body);
        page.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                closePage();
                return;
            }
            // aria-modal promises the app behind the page is unreachable, so
            // Tab has to wrap inside the page instead of escaping it.
            if (event.key === 'Tab' && !nestedHostUiOpen()) {
                const focusable = pageTabbables();
                if (!focusable.length) {
                    event.preventDefault();
                    page.focus({ preventScroll: true });
                    return;
                }
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                const index = focusable.indexOf(document.activeElement);
                if (event.shiftKey && index <= 0) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && (index < 0 || index === focusable.length - 1)) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });
        document.body.append(page);
    }

    /** Opens the lab as a page of its own rather than a drawer entry. */
    function openPage(opener = null) {
        if (disposed) {
            return;
        }
        ensurePage();
        pageOpener = opener instanceof HTMLElement ? opener : null;
        page.hidden = false;
        workbench.mount(pageMount, { layout: 'page' });
        activatePageModal();
        updatePageStatus();
        requestAnimationFrame(() => {
            if (!disposed && page && !page.hidden) {
                workbench.focus();
            }
        });
    }

    /** Puts the workbench back in the drawer so nothing is lost on close. */
    function closePage() {
        if (!page || page.hidden) {
            return;
        }
        page.hidden = true;
        deactivatePageModal();
        ensureSettingsDrawer();
        if (workbenchMount) {
            workbench.mount(workbenchMount, { layout: 'drawer' });
        }
        const opener = pageOpener?.isConnected
            ? pageOpener
            : (document.getElementById(pageOpener?.id) ?? document.getElementById('sbpl-menu-item'));
        opener?.focus?.({ preventScroll: true });
        pageOpener = null;
    }

    function ensureMenuItem() {
        if (menuItem?.isConnected) {
            return;
        }
        const host = document.getElementById('prompting_lab_wand_container')
            ?? document.getElementById('extensionsMenu');
        if (!host) {
            return;
        }
        document.getElementById('sbpl-menu-item')?.remove();

        // Wand entries must be divs: the host styles them via
        // `#extensionsMenu > div`, and a <button> falls back to browser chrome.
        menuItem = element('div', {
            id: 'sbpl-menu-item',
            className: 'list-group-item flex-container flexGap5 interactable sbpl-menu-item',
            attributes: {
                title: 'Open the Prompting Lab workspace to test prompts for your characters',
                role: 'button',
                tabindex: '0',
            },
        });
        menuItem.append(
            element('span', {
                className: 'fa-solid fa-flask extensionsMenuExtensionButton sbpl-menu-icon',
                attributes: { 'aria-hidden': 'true' },
            }),
            element('span', { text: EXTENSION_LABEL }),
        );
        menuItem.addEventListener('click', () => openPage(menuItem));
        menuItem.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPage(menuItem);
            }
        });
        host.append(menuItem);
    }

    function ensureSettingsDrawer() {
        if (settingsRoot?.isConnected && settingsDrawer?.isConnected && settingsRoot.contains(settingsDrawer)) {
            return;
        }
        const host = settingsHost();
        if (!host) {
            return;
        }
        const drawerWasExpanded = Boolean(drawerIcon && !drawerIcon.classList.contains('down'));
        drawerObserver?.disconnect();
        settingsRoot?.remove();
        const staleDrawer = document.getElementById('sbpl-settings');
        (staleDrawer?.closest('.extension_container') ?? staleDrawer)?.remove();

        settingsRoot = element('div', { className: 'extension_container sbpl-settings-container' });
        settingsDrawer = element('div', {
            id: 'sbpl-settings',
            className: 'inline-drawer sbpl-settings',
            attributes: {
                'data-extension-name': EXTENSION_NAME,
            },
        });
        drawerToggle = element('button', {
            className: 'inline-drawer-toggle inline-drawer-header sbpl-settings-summary',
            attributes: {
                type: 'button',
                'aria-controls': 'sbpl-settings-content',
                'aria-expanded': String(drawerWasExpanded),
            },
        });
        const summaryCopy = element('span', { className: 'sbpl-settings-summary-copy' });
        summaryCopy.append(
            element('strong', { className: 'extension_name', text: EXTENSION_LABEL }),
            element('span', {
                className: 'sbpl-settings-summary-note',
                text: 'Test prompts and spot changes',
            }),
        );
        drawerIcon = element('span', {
            className: `inline-drawer-icon fa-solid fa-circle-chevron-down ${drawerWasExpanded ? 'up' : 'down'} not_focusable`,
            attributes: { 'aria-hidden': 'true' },
        });
        drawerToggle.append(summaryCopy, drawerIcon);

        drawerContent = element('div', {
            id: 'sbpl-settings-content',
            className: 'inline-drawer-content sbpl-settings-content',
            attributes: { 'aria-hidden': String(!drawerWasExpanded) },
        });
        drawerContent.style.display = drawerWasExpanded ? 'block' : 'none';

        const settingsBody = element('div', { className: 'sbpl-settings-body' });
        drawerStatus = element('p', {
            className: 'sbpl-settings-status',
            attributes: { role: 'status', 'aria-live': 'polite' },
        });

        const openPageButton = button('Open as full page', () => openPage(openPageButton), {
            id: 'sbpl-open-page',
            className: 'menu_button sbpl-button',
            title: 'Open the lab as a workspace covering the whole page',
        });
        settingsBody.append(
            drawerStatus,
            element('p', {
                className: 'sbpl-settings-note',
                text: `Prompt tests build prompts without sending a message or using tokens. ${TOKEN_SPEND_SUMMARY}`,
            }),
            element('p', {
                className: 'sbpl-settings-note',
                text: 'While a suite runs, Prompting Lab temporarily applies each test case\'s character, persona, preset, and connection profile, then restores your setup.',
            }),
            openPageButton,
        );

        workbenchMount = element('div', { className: 'sbpl-workbench-mount' });
        drawerContent.append(settingsBody, workbenchMount);
        settingsDrawer.append(drawerToggle, drawerContent);
        settingsRoot.append(settingsDrawer);
        host.append(settingsRoot);
        if (!page || page.hidden) {
            workbench.mount(workbenchMount, { layout: 'drawer' });
        }

        drawerObserver = new MutationObserver(syncDrawerAccessibility);
        drawerObserver.observe(drawerIcon, { attributes: true, attributeFilter: ['class'] });
        syncDrawerAccessibility();
        updateDrawer();
    }

    function ensureEntrypoints() {
        ensureMenuItem();
        ensureSettingsDrawer();
    }

    const controller = {
        refresh(reason = 'refresh') {
            if (disposed) {
                return;
            }
            ensureEntrypoints();
            workbench.refresh(reason);
            updateDrawer();
        },
        setAvailability(value) {
            if (disposed) {
                return;
            }
            workbench.setAvailability(value);
            updateDrawer();
        },
        getWorkbench() {
            return workbench;
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            deactivatePageModal();
            drawerObserver?.disconnect();
            ledger.dispose();
            workbench.dispose();
            menuItem?.remove();
            settingsRoot?.remove();
            page?.remove();
            document.getElementById('sbpl-menu-item')?.remove();
            document.getElementById('sbpl-page')?.remove();
            const staleDrawer = document.getElementById('sbpl-settings');
            (staleDrawer?.closest('.extension_container') ?? staleDrawer)?.remove();
            menuItem = null;
            settingsRoot = null;
            settingsDrawer = null;
            drawerToggle = null;
            drawerIcon = null;
            drawerContent = null;
            drawerObserver = null;
            drawerStatus = null;
            workbenchMount = null;
            page = null;
            pageMount = null;
            pageStatus = null;
            pageOpener = null;
        },
    };

    mounted = controller;
    ensureEntrypoints();
    updateDrawer();
    return controller;
}

export function unmountRuntimeUi() {
    mounted?.dispose();
    mounted = null;
}
