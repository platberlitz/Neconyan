import { getSettings, updateSettings } from '../settings.js';
import { pruneHistory } from '../history.js';
import { element, field, replace } from './dom.js';
import { createWorkbench } from './workbench.js';

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
    let lorebooksButton = null;
    let settingsRoot = null;
    let settingsDrawer = null;
    let drawerToggle = null;
    let drawerIcon = null;
    let drawerContent = null;
    let drawerObserver = null;
    let drawerStatus = null;
    let drawerResult = null;
    let historyLimitInput = null;
    let workbenchMount = null;
    let page = null;
    let pageMount = null;
    let pageStatus = null;
    let pageOpener = null;
    let modalObserver = null;
    const modalBackground = new Map();
    let disposed = false;
    let workbench = null;

    function pill(text, { variant = '', title = '' } = {}) {
        const node = element('span', {
            className: variant ? `sbwil-pill ${variant}` : 'sbwil-pill',
            attributes: title ? { title } : {},
        });
        node.append(
            element('span', { className: 'sbwil-pill-dot', attributes: { 'aria-hidden': 'true' } }),
            element('span', { text }),
        );
        return node;
    }

    function updatePageStatus() {
        if (!pageStatus?.isConnected) {
            return;
        }
        const availability = workbench.getState().availability;
        let host;
        if (availability?.ok === true && !availability.warnings?.length) {
            host = pill('Ready to scan', { variant: 'sbwil-pill-ready' });
        } else if (availability?.ok === true) {
            host = pill('Ready, with notes', {
                variant: 'sbwil-pill-warning',
                title: availability.warnings.join(' '),
            });
        } else if (availability?.ok === false) {
            host = pill('Scanning unavailable', {
                variant: 'sbwil-pill-error',
                title: availability.reason ?? '',
            });
        } else {
            host = pill('Checking compatibility...', { variant: 'sbwil-pill-quiet' });
        }
        replace(
            pageStatus,
            host,
            pill('Scans are read-only', {
                variant: 'sbwil-pill-quiet',
                title: 'A scan does not send a message or edit a lorebook.',
            }),
        );
    }

    function updateDrawer() {
        updatePageStatus();
        if (!settingsDrawer?.isConnected) {
            return;
        }
        const state = workbench.getState();
        if (state.availability?.ok === true) {
            drawerStatus.textContent = 'Lorebook scanning is ready.';
            drawerStatus.className = 'sbwil-settings-status sbwil-settings-ready';
            drawerStatus.removeAttribute('title');
        } else if (state.availability?.ok === false) {
            drawerStatus.textContent = 'Lorebook scanning is unavailable. Update Neconyan or World Info Lab, then reload.';
            drawerStatus.className = 'sbwil-settings-status sbwil-settings-error';
            if (state.availability.reason) {
                drawerStatus.title = `Technical details: ${state.availability.reason}`;
            }
        } else {
            drawerStatus.textContent = 'Checking compatibility with Neconyan...';
            drawerStatus.className = 'sbwil-settings-status';
            drawerStatus.removeAttribute('title');
        }

        const result = state.latestResult;
        drawerResult.textContent = result
            ? `Last scan: ${result.activated?.length ?? 0} entries activated; ${result.budget?.used ?? 0} lorebook tokens.`
            : 'No scans have run in this Neconyan session yet.';
        if (state.stale) {
            drawerResult.textContent += ' The chat, lorebooks, or scan settings changed since then.';
        }

        if (document.activeElement !== historyLimitInput) {
            historyLimitInput.value = String(getSettings().historyLimit);
        }
    }

    workbench = createWorkbench({
        lifetimeSignal: signal,
        onStateChange: updateDrawer,
    });

    function syncDrawerAccessibility() {
        const expanded = Boolean(drawerIcon && !drawerIcon.classList.contains('down'));
        drawerToggle?.setAttribute('aria-expanded', String(expanded));
        drawerContent?.setAttribute('aria-hidden', String(!expanded));
        if (expanded && workbenchMount && !disposed && (!page || page.hidden)) {
            workbench.mount(workbenchMount, { layout: 'drawer' });
        }
    }

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
                // Older host browsers may not support one of these selectors.
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
        document.getElementById('sbwil-page')?.remove();
        page = element('div', {
            id: 'sbwil-page',
            className: 'sbwil-page',
            attributes: {
                role: 'dialog',
                'aria-modal': 'true',
                'aria-labelledby': 'sbwil-page-title',
                tabindex: '-1',
            },
        });
        page.hidden = true;

        const header = element('header', { className: 'sbwil-page-header' });
        const heading = element('div', { className: 'sbwil-page-heading' });
        const copy = element('div', { className: 'sbwil-page-copy' });
        copy.append(
            element('h2', { id: 'sbwil-page-title', className: 'sbwil-page-title', text: 'World Info Lab' }),
            element('p', {
                className: 'sbwil-page-subtitle',
                text: 'Test lorebook activation, trace every decision, and preview safe edits.',
            }),
        );
        heading.append(
            element('span', {
                className: 'sbwil-page-mark fa-solid fa-wand-magic-sparkles',
                attributes: { 'aria-hidden': 'true' },
            }),
            copy,
        );
        pageStatus = element('div', { className: 'sbwil-page-status' });
        const actions = element('div', { className: 'sbwil-page-actions' });
        const closeButton = element('button', {
            className: 'menu_button sbwil-button sbwil-page-close',
            text: 'Close workspace',
            attributes: {
                type: 'button',
                title: 'Close the workspace and return to Neconyan (Escape)',
            },
        });
        closeButton.addEventListener('click', closePage);
        actions.append(
            element('span', {
                className: 'sbwil-page-shortcut',
                text: 'Esc',
                attributes: { 'aria-hidden': 'true', title: 'Escape closes the workspace' },
            }),
            closeButton,
        );
        header.append(heading, pageStatus, actions);

        const body = element('div', { className: 'sbwil-page-body' });
        pageMount = element('div', { className: 'sbwil-page-workbench-mount' });
        body.append(pageMount);
        page.append(header, body);
        page.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                closePage();
                return;
            }
            if (event.key !== 'Tab' || nestedHostUiOpen()) {
                return;
            }
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
        });
        document.body.append(page);
    }

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
            : (document.getElementById(pageOpener?.id) ?? document.getElementById('sbwil-menu-item'));
        opener?.focus?.({ preventScroll: true });
        pageOpener = null;
    }

    function ensureMenuItem() {
        if (menuItem?.isConnected) {
            return;
        }
        const host = document.getElementById('extensionsMenu');
        if (!host) {
            return;
        }
        document.getElementById('sbwil-menu-item')?.remove();

        // Wand entries must be divs: the host styles them via
        // `#extensionsMenu > div`, and a <button> falls back to browser chrome.
        menuItem = element('div', {
            id: 'sbwil-menu-item',
            className: 'list-group-item flex-container flexGap5 interactable sbwil-menu-item',
            attributes: {
                title: 'Open World Info Lab to test lorebook activation',
                role: 'button',
                tabindex: '0',
            },
        });
        const icon = element('span', {
            className: 'fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton sbwil-menu-icon',
            attributes: { 'aria-hidden': 'true' },
        });
        menuItem.append(icon, element('span', { text: 'World Info Lab' }));
        menuItem.addEventListener('click', () => openPage(menuItem));
        menuItem.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            openPage(menuItem);
        });
        host.append(menuItem);
    }

    function ensureLorebooksButton() {
        if (lorebooksButton?.isConnected) {
            return;
        }
        const host = document.getElementById('world_popup_primary_actions');
        if (!host) {
            return;
        }
        document.getElementById('sbwil-lorebooks-button')?.remove();

        lorebooksButton = element('button', {
            id: 'sbwil-lorebooks-button',
            className: 'menu_button menu_button_icon',
            attributes: {
                type: 'button',
                title: 'Open World Info Lab to test lorebook activation',
                'data-i18n': '[title]Open World Info Lab to test lorebook activation',
                'aria-haspopup': 'dialog',
            },
        });
        lorebooksButton.append(
            element('span', { className: 'fa-solid fa-flask', attributes: { 'aria-hidden': 'true' } }),
            element('span', { text: 'World Info Lab', attributes: { 'data-i18n': 'World Info Lab' } }),
        );
        lorebooksButton.addEventListener('click', () => openPage(lorebooksButton));
        // Keep it outside the picker group, which hides while editing a book.
        host.prepend(lorebooksButton);
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
        const staleDrawer = document.getElementById('sbwil-settings');
        (staleDrawer?.closest('.extension_container') ?? staleDrawer)?.remove();

        settingsRoot = element('div', {
            className: 'extension_container sbwil-settings-container',
        });
        settingsDrawer = element('div', {
            id: 'sbwil-settings',
            className: 'inline-drawer sbwil-settings',
            attributes: {
                'data-extension-name': 'Neconyan-WorldInfo-Lab',
                'data-sb-drawer-persistence': 'off',
            },
        });
        drawerToggle = element('button', {
            className: 'inline-drawer-toggle inline-drawer-header sbwil-settings-summary',
            attributes: {
                type: 'button',
                'aria-controls': 'sbwil-settings-content',
                'aria-expanded': String(drawerWasExpanded),
            },
        });
        const summaryCopy = element('span', { className: 'sbwil-settings-summary-copy' });
        summaryCopy.append(
            element('strong', { text: 'World Info Lab' }),
            element('span', { className: 'sbwil-settings-summary-note', text: 'Test and troubleshoot lorebooks' }),
        );
        drawerIcon = element('span', {
            className: `inline-drawer-icon fa-solid fa-circle-chevron-${drawerWasExpanded ? 'up' : 'down'} ${drawerWasExpanded ? 'up' : 'down'} not_focusable`,
            attributes: { 'aria-hidden': 'true' },
        });
        drawerToggle.append(summaryCopy, drawerIcon);

        drawerContent = element('div', {
            id: 'sbwil-settings-content',
            className: 'inline-drawer-content sbwil-settings-content',
            attributes: { 'aria-hidden': String(!drawerWasExpanded) },
        });
        drawerContent.style.display = drawerWasExpanded ? 'block' : 'none';
        const settingsBody = element('div', { className: 'sbwil-settings-body' });
        drawerStatus = element('p', {
            className: 'sbwil-settings-status',
            attributes: {
                role: 'status',
                'aria-live': 'polite',
            },
        });
        drawerResult = element('p', { className: 'sbwil-settings-result' });
        historyLimitInput = element('input', {
            id: 'sbwil-history-limit',
            className: 'text_pole sbwil-input sbwil-history-limit',
            attributes: {
                type: 'number',
                min: '10',
                max: '500',
                step: '1',
                inputmode: 'numeric',
            },
        });
        historyLimitInput.value = String(getSettings().historyLimit);
        historyLimitInput.addEventListener('change', () => {
            const settings = updateSettings({ historyLimit: Number(historyLimitInput.value) });
            historyLimitInput.value = String(settings.historyLimit);
            pruneHistory();
            workbench.refresh('history-limit-changed');
        });
        const openPageButton = element('button', {
            id: 'sbwil-open-page',
            className: 'menu_button sbwil-button',
            text: 'Open as full page',
            attributes: {
                type: 'button',
                title: 'Open World Info Lab as a workspace covering the whole page',
            },
        });
        openPageButton.addEventListener('click', () => openPage(openPageButton));

        settingsBody.append(
            drawerStatus,
            drawerResult,
            openPageButton,
            field('Recent scan history limit', historyLimitInput, {
                hint: 'Number of summary-only scans to keep for this account (10 to 500). Chat, lorebook content, and lorebook names are not stored.',
            }),
            element('p', {
                className: 'sbwil-settings-note',
                text: 'Running a scan does not send a message or edit a lorebook. Lorebooks change only when you save a test or apply a batch edit.',
            }),
            element('p', {
                className: 'sbwil-settings-note',
                text: 'Saved tests are stored inside a lorebook and may contain private chat, character, and persona data. Delete private tests before sharing the lorebook. Cleaning World Info Lab data does not delete them.',
            }),
        );
        workbenchMount = element('div', { className: 'sbwil-workbench-mount' });
        drawerContent.append(settingsBody, workbenchMount);
        settingsDrawer.append(drawerToggle, drawerContent);
        settingsRoot.append(settingsDrawer);
        host.append(settingsRoot);
        drawerObserver = new MutationObserver(syncDrawerAccessibility);
        drawerObserver.observe(drawerIcon, {
            attributes: true,
            attributeFilter: ['class'],
        });
        if (workbench.getState().open && (!page || page.hidden)) {
            workbench.mount(workbenchMount, { layout: 'drawer' });
        }
        syncDrawerAccessibility();
        updateDrawer();
    }

    function ensureEntrypoints() {
        ensureMenuItem();
        ensureLorebooksButton();
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
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            deactivatePageModal();
            drawerObserver?.disconnect();
            workbench.dispose();
            menuItem?.remove();
            lorebooksButton?.remove();
            settingsRoot?.remove();
            page?.remove();
            document.getElementById('sbwil-menu-item')?.remove();
            document.getElementById('sbwil-lorebooks-button')?.remove();
            document.getElementById('sbwil-page')?.remove();
            const staleDrawer = document.getElementById('sbwil-settings');
            (staleDrawer?.closest('.extension_container') ?? staleDrawer)?.remove();
            menuItem = null;
            lorebooksButton = null;
            settingsRoot = null;
            settingsDrawer = null;
            drawerToggle = null;
            drawerIcon = null;
            drawerContent = null;
            drawerObserver = null;
            drawerStatus = null;
            drawerResult = null;
            historyLimitInput = null;
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
