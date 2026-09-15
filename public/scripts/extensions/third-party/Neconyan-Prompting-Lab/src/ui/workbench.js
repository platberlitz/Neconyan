import { EXTENSION_LABEL, TAB_GROUPS, TAB_LABEL, TAB_META, TAB_ORDER } from '../constants.js';
import { element, emptyState, replace } from '../dom.js';
import { getSettings, updateSettings } from '../settings.js';
import * as storage from '../storage.js';

/** What the side rail counts, in the order it lists them. */
const READOUT_ROWS = [
    ['suites', 'Suites'],
    ['cases', 'Test cases'],
    ['checks', 'Checks'],
    ['runs', 'Runs kept'],
    ['drafts', 'Preset drafts'],
    ['prompts', 'Prompts'],
    ['ledger', 'Recorded prompts'],
];

/** Counts what the lab holds, so the workspace can show its own inventory. */
async function readInventory() {
    const [suites, cases, drafts, prompts, ledger] = await Promise.all([
        storage.listSuites(),
        storage.listCases(),
        storage.listDrafts(),
        storage.listPromptDrafts(),
        storage.countLedger(),
    ]);
    const runCounts = await Promise.all(cases.map(testCase => storage.listRuns(testCase.id)));
    return {
        suites: suites.length,
        cases: cases.length,
        checks: cases.reduce((total, testCase) => total + (testCase.assertions?.length ?? 0), 0),
        runs: runCounts.reduce((total, runs) => total + runs.length, 0),
        drafts: drafts.length,
        prompts: prompts.length,
        ledger,
    };
}

/**
 * The workbench owns the tab shell and hands each tab a panel element to fill.
 * It lays itself out two ways from the same markup: a compact tab strip in the
 * extensions drawer, and a side rail with a panel heading when it is mounted
 * in the full-page workspace.
 */
export function createWorkbench({ lifetimeSignal = null, onStateChange = null } = {}) {
    const state = {
        open: false,
        activeTab: getSettings().lastTab,
        availability: null,
        layout: 'drawer',
    };
    const panels = new Map();
    const tabButtons = new Map();
    const dirtyTabs = new Set();

    let root = null;
    let tabList = null;
    let panelHost = null;
    let panelHead = null;
    let readout = null;
    let selectMobile = null;
    let disposed = false;
    let readoutPending = false;
    let readoutStale = false;
    let lastFocused = null;

    function notifyChange() {
        onStateChange?.();
    }

    function renderActivePanel() {
        if (!panelHost) {
            return;
        }
        renderPanelHead();
        const controller = panels.get(state.activeTab);
        if (!controller) {
            replace(panelHost, emptyState(
                `${TAB_LABEL[state.activeTab] ?? 'This tab'} is not available yet.`,
                'This part of Prompting Lab is still being built.',
            ));
            return;
        }
        const node = controller.render();
        replace(panelHost, node);
    }

    /** The heading above the panel: where you are, and what it costs to be here. */
    function renderPanelHead() {
        if (!panelHead) {
            return;
        }
        const meta = TAB_META[state.activeTab] ?? {};
        const group = TAB_GROUPS.find(entry => entry.tabs.includes(state.activeTab));
        const nodes = [
            element('p', { className: 'sbpl-panel-eyebrow', text: group?.label ?? EXTENSION_LABEL }),
            element('h3', { className: 'sbpl-panel-title', text: TAB_LABEL[state.activeTab] ?? '' }),
        ];
        if (meta.blurb) {
            nodes.push(element('p', { className: 'sbpl-panel-blurb', text: meta.blurb }));
        }
        nodes.push(element('p', {
            className: meta.sends ? 'sbpl-panel-cost sbpl-panel-cost-sends' : 'sbpl-panel-cost',
            text: meta.sends
                ? 'This tab sends a request and uses tokens, and only when you press its button.'
                : 'Nothing on this tab sends a message or uses tokens.',
        }));
        replace(panelHead, ...nodes);
    }

    /** Fills the rail's inventory. Skipped in the drawer, where it is hidden. */
    async function refreshReadout() {
        if (disposed || !readout || state.layout !== 'page') {
            return;
        }
        // A change made while a count is in flight would otherwise leave the
        // rail showing the numbers from before it.
        if (readoutPending) {
            readoutStale = true;
            return;
        }
        readoutPending = true;
        let inventory = null;
        try {
            inventory = await readInventory();
        } catch {
            inventory = null;
        } finally {
            readoutPending = false;
            if (readoutStale) {
                readoutStale = false;
                void refreshReadout();
            }
        }
        if (disposed || !readout) {
            return;
        }
        const rows = READOUT_ROWS.map(([key, label]) => {
            const row = element('div', { className: 'sbpl-readout-row' });
            row.append(
                element('span', { className: 'sbpl-readout-label', text: label }),
                element('span', {
                    className: 'sbpl-readout-value',
                    text: inventory ? String(inventory[key]) : '—',
                }),
            );
            return row;
        });
        replace(
            readout,
            element('p', { className: 'sbpl-readout-title', text: 'In this workspace' }),
            ...rows,
        );
    }

    function syncTabControls() {
        for (const [id, node] of tabButtons) {
            const selected = id === state.activeTab;
            node.classList.toggle('sbpl-tab-active', selected);
            node.setAttribute('aria-selected', String(selected));
            node.tabIndex = selected ? 0 : -1;
        }
        if (selectMobile && selectMobile.value !== state.activeTab) {
            selectMobile.value = state.activeTab;
        }
        // The panel is named after the selected tab, so a screen reader
        // announces which section it has landed in.
        panelHost?.setAttribute('aria-labelledby', `sbpl-tab-${state.activeTab}`);
    }

    function focusActiveControl() {
        const tab = tabButtons.get(state.activeTab);
        const target = tab?.getClientRects().length
            ? tab
            : selectMobile?.getClientRects().length
                ? selectMobile
                : panelHost;
        target?.focus({ preventScroll: true });
    }

    function setActiveTab(id, { focus = false } = {}) {
        if (!TAB_ORDER.includes(id)) {
            return;
        }
        state.activeTab = id;
        updateSettings({ lastTab: id });
        syncTabControls();
        renderActivePanel();
        if (dirtyTabs.delete(id)) {
            panels.get(id)?.refresh?.('activated');
        }
        void refreshReadout();
        if (focus) {
            focusActiveControl();
        }
        notifyChange();
    }

    function onTabKeydown(event) {
        const index = TAB_ORDER.indexOf(state.activeTab);
        let next = null;
        // The rail is vertical and the strip is horizontal, and both are the
        // same set of tabs, so both axes move through them.
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            next = TAB_ORDER[(index + 1) % TAB_ORDER.length];
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            next = TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length];
        } else if (event.key === 'Home') {
            next = TAB_ORDER[0];
        } else if (event.key === 'End') {
            next = TAB_ORDER[TAB_ORDER.length - 1];
        }
        if (next) {
            event.preventDefault();
            setActiveTab(next, { focus: true });
        }
    }

    function buildTabButton(id) {
        const meta = TAB_META[id] ?? {};
        const node = element('button', {
            className: 'sbpl-tab',
            id: `sbpl-tab-${id}`,
            attributes: {
                type: 'button',
                role: 'tab',
                'aria-controls': 'sbpl-panel',
                'aria-selected': 'false',
                // The visible hint and badge are decoration for the eye; the
                // name a screen reader reads stays the tab's own name.
                'aria-label': meta.sends ? `${TAB_LABEL[id]}, uses tokens` : TAB_LABEL[id],
                ...(meta.blurb ? { title: meta.blurb } : {}),
            },
        });
        const text = element('span', { className: 'sbpl-tab-text' });
        const line = element('span', { className: 'sbpl-tab-line' });
        line.append(element('span', { className: 'sbpl-tab-label', text: TAB_LABEL[id] }));
        if (meta.sends) {
            line.append(element('span', { className: 'sbpl-tab-badge', text: 'tokens' }));
        }
        text.append(line);
        if (meta.hint) {
            text.append(element('span', { className: 'sbpl-tab-hint', text: meta.hint }));
        }
        node.append(
            element('span', {
                className: `sbpl-tab-icon fa-solid ${meta.icon ?? 'fa-circle'}`,
                attributes: { 'aria-hidden': 'true' },
            }),
            text,
        );
        node.addEventListener('click', () => setActiveTab(id));
        node.addEventListener('keydown', onTabKeydown);
        return node;
    }

    function buildNav() {
        const nav = element('nav', {
            className: 'sbpl-nav',
            attributes: { 'aria-label': `${EXTENSION_LABEL} sections` },
        });

        tabList = element('div', {
            className: 'sbpl-tabs',
            attributes: { role: 'tablist', 'aria-label': `${EXTENSION_LABEL} sections` },
        });
        for (const group of TAB_GROUPS) {
            // The grouping is a reading aid on screen; the tablist itself stays
            // one flat set of tabs for anything that is not looking at it.
            const wrapper = element('div', {
                className: 'sbpl-tab-group',
                attributes: { role: 'presentation' },
            });
            wrapper.append(element('p', {
                className: 'sbpl-tab-group-label',
                text: group.label,
                attributes: { 'aria-hidden': 'true' },
            }));
            for (const id of group.tabs) {
                const node = buildTabButton(id);
                tabButtons.set(id, node);
                wrapper.append(node);
            }
            tabList.append(wrapper);
        }

        selectMobile = element('select', {
            className: 'text_pole sbpl-tab-select',
            attributes: { 'aria-label': `${EXTENSION_LABEL} section` },
        });
        for (const id of TAB_ORDER) {
            selectMobile.append(element('option', { text: TAB_LABEL[id], attributes: { value: id } }));
        }
        selectMobile.addEventListener('change', () => setActiveTab(selectMobile.value));

        readout = element('div', {
            className: 'sbpl-readout',
            attributes: { role: 'status', 'aria-live': 'off' },
        });

        nav.append(tabList, selectMobile, readout);
        return nav;
    }

    function build() {
        root = element('section', {
            id: 'sbpl-workbench',
            className: 'sbpl-workbench',
            attributes: { 'aria-label': EXTENSION_LABEL },
        });

        const availabilityNote = element('p', {
            className: 'sbpl-availability',
            attributes: { role: 'status', 'aria-live': 'polite' },
        });
        availabilityNote.hidden = true;

        const nav = buildNav();

        panelHead = element('header', { className: 'sbpl-panel-head' });
        panelHost = element('div', {
            id: 'sbpl-panel',
            className: 'sbpl-panel',
            attributes: { role: 'tabpanel', tabindex: '-1' },
        });
        const main = element('div', { className: 'sbpl-main' });
        main.append(panelHead, panelHost);

        root.append(availabilityNote, nav, main);
        root.__availabilityNote = availabilityNote;
        root.addEventListener('focusin', (event) => {
            lastFocused = event.target;
        });
        applyLayout();
        syncTabControls();
        renderActivePanel();
        return root;
    }

    /** Switches between the drawer strip and the full-page rail. */
    function applyLayout() {
        if (!root) {
            return;
        }
        const isPage = state.layout === 'page';
        root.classList.toggle('sbpl-workbench-page', isPage);
        root.classList.toggle('sbpl-workbench-drawer', !isPage);
        tabList?.setAttribute('aria-orientation', isPage ? 'vertical' : 'horizontal');
        void refreshReadout();
    }

    function applyAvailability() {
        const unavailable = state.availability?.ok === false;
        panelHost?.toggleAttribute('inert', unavailable);
        if (unavailable) {
            panelHost?.setAttribute('aria-disabled', 'true');
        } else {
            panelHost?.removeAttribute('aria-disabled');
        }
        const note = root?.__availabilityNote;
        if (!note) {
            return;
        }
        if (state.availability?.ok === false) {
            note.hidden = false;
            note.className = 'sbpl-availability sbpl-availability-error';
            note.textContent = state.availability.reason
                ?? `${EXTENSION_LABEL} is not compatible with this Neconyan build.`;
        } else if (state.availability?.warnings?.length) {
            note.hidden = false;
            note.className = 'sbpl-availability sbpl-availability-warning';
            note.textContent = state.availability.warnings.join(' ');
        } else {
            note.hidden = true;
            note.textContent = '';
        }
    }

    const controller = {
        getState() {
            return state;
        },
        registerTab(id, tabController) {
            panels.set(id, tabController);
            tabController.setAvailability?.(state.availability);
            if (id === state.activeTab) {
                renderActivePanel();
            }
        },
        showTab(id) {
            setActiveTab(id, { focus: true });
        },
        mount(host, { layout = 'drawer' } = {}) {
            if (disposed || !host) {
                return null;
            }
            if (!root) {
                build();
            }
            if (state.layout !== layout) {
                state.layout = layout;
                applyLayout();
            }
            if (root.parentElement !== host) {
                const active = document.activeElement;
                const restoreFocus = root.contains(active)
                    || (!root.parentElement?.isConnected
                        && (!active || active === document.body || active === document.documentElement))
                    ? lastFocused
                    : null;
                host.append(root);
                if (restoreFocus?.isConnected && !restoreFocus.closest('[inert]')) {
                    restoreFocus.focus({ preventScroll: true });
                }
            }
            state.open = true;
            applyAvailability();
            void refreshReadout();
            notifyChange();
            return root;
        },
        setAvailability(value) {
            state.availability = value;
            for (const panel of panels.values()) {
                panel.setAvailability?.(value);
            }
            applyAvailability();
            notifyChange();
        },
        refresh(reason = 'refresh') {
            if (disposed || !state.open) {
                return;
            }
            void refreshReadout();
            for (const [id, panel] of panels) {
                if (id === state.activeTab) {
                    dirtyTabs.delete(id);
                    panel.refresh?.(reason);
                } else {
                    dirtyTabs.add(id);
                }
            }
        },
        /** Re-counts the rail's inventory after another tab changed something. */
        refreshReadout() {
            void refreshReadout();
        },
        focus() {
            focusActiveControl();
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const panel of panels.values()) {
                panel.dispose?.();
            }
            panels.clear();
            tabButtons.clear();
            dirtyTabs.clear();
            root?.remove();
            root = null;
            tabList = null;
            panelHost = null;
            panelHead = null;
            readout = null;
            selectMobile = null;
            lastFocused = null;
            state.open = false;
        },
    };

    lifetimeSignal?.addEventListener?.('abort', () => controller.dispose(), { once: true });
    return controller;
}
