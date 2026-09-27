/**
 * Host-native settings UI for choosing, previewing, applying, and safely restoring themes.
 * The outer shell and section toggles stay mounted; refreshes replace only section bodies
 * and restore focus by stable control key.
 */

import { DRAWER_ID, MODULE_NAME, STOCK_THEME } from './constants.js';
import { ARCHETYPES, THEMABLE_TEMPLATE_IDS } from './specs.js';
import { summarizeStatuses } from './drift.js';
import { FAMILIES, THEMES, getTheme } from './themes/index.js';
import { DENSITIES, OPEN_DEFAULTS, getSettings, isTemplateInScope, resolveThemeSlug, updateSettings } from './settings.js';
import { TEMPLATE_LABELS } from './template-catalog.js';
import { PREVIEW_KEYS, detectEncodedTags, mountPreview } from './preview.js';
import {
    applyAll,
    applyToAgent,
    inspectAgent,
    refreshAgentMessages,
    revertAgent,
    themableAgents,
} from './apply.js';
import { getContext, loadHost } from './host.js';
import {
    CUSTOM_THEME_LIMITS,
    createCustomThemeExport,
    parseCustomThemeImport,
} from './custom-themes.js';

const ARCHETYPE_LABELS = Object.freeze({
    [ARCHETYPES.PANEL]: 'Tracker panel',
    [ARCHETYPES.PROFILE]: 'NPC profile',
    [ARCHETYPES.SLOTS]: 'Choice menu',
    [ARCHETYPES.STATCARD]: 'Relationship meter',
    [ARCHETYPES.CHIP]: 'Inline chip',
    [ARCHETYPES.STREAM]: 'Chatroom stream',
    [ARCHETYPES.TRANSCRIPT]: 'Transcript row',
});

const STATUS_LABELS = Object.freeze({
    pristine: 'Themed',
    stock: 'Original',
    outdated: 'Needs re-apply',
    foreign: 'Edited outside this extension',
    missing: 'Script missing',
    'upstream-changed': 'Changed upstream',
});

const STATUS_HELP = Object.freeze({
    pristine: 'This extension owns the current theme output.',
    stock: 'The original tracker style is installed.',
    outdated: 'A theme or option changed and can be applied safely.',
    foreign: 'The tracker contains edits this extension will not overwrite automatically.',
    missing: 'A required tracker script is not installed.',
    'upstream-changed': 'The tracker pattern differs from the supported tracker template.',
});

const sectionOpen = {
    overview: true,
    browse: false,
    options: false,
    scope: false,
    maintenance: false,
};

const uiState = {
    busy: false,
    previewArchetype: ARCHETYPES.PANEL,
    previewThemeSlug: null,
    family: 'all',
    mode: 'all',
    query: '',
    optionsDirty: false,
    result: null,
};

let view = null;
let refreshHandle = null;
let renderGeneration = 0;
let thumbnailObserver = null;
const thumbnailJobs = new Map();
const drawerStateObservers = new Set();
const changedSelects = new WeakSet();

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') {
            node.className = value;
        } else if (key === 'text') {
            node.textContent = value;
        } else if (key === 'disabled') {
            node.disabled = Boolean(value);
        } else if (value !== null && value !== undefined) {
            node.setAttribute(key, String(value));
        }
    }
    for (const child of [].concat(children)) {
        if (child !== null && child !== undefined && child !== false) {
            node.append(child);
        }
    }
    return node;
}

function toast(type, message) {
    globalThis.toastr?.[type]?.(message);
}

function optionRow(label, control, help = '') {
    const text = el('span', {}, [el('span', { text: label })]);
    if (help) {
        text.append(el('small', { class: 'rat-help', text: help }));
    }
    return el('label', { class: 'rat-check' }, [control, text]);
}

function fieldRow(label, control, help = '') {
    const children = [el('span', { text: label }), control];
    if (help) {
        children.push(el('small', { class: 'rat-help', text: help }));
    }
    return el('label', { class: 'rat-field' }, children);
}

function button(label, onClick, {
    className = 'menu_button',
    id,
    disabled = false,
    focusKey,
    description,
    ariaLabel,
} = {}) {
    const node = el('button', {
        id,
        type: 'button',
        class: className,
        disabled,
        'data-focus-key': focusKey,
        'aria-describedby': description,
        'aria-label': ariaLabel,
        text: label,
    });
    node.dataset.ratOperation = 'true';
    node.addEventListener('click', () => {
        Promise.resolve(onClick()).catch((error) => {
            setResult({ tone: 'error', text: error?.message ?? String(error) });
        });
    });
    return node;
}

function select(id, options, value, onChange, { focusKey } = {}) {
    const node = el('select', {
        id,
        class: 'text_pole',
        'data-focus-key': focusKey ?? id,
    });
    for (const option of options) {
        node.append(el('option', { value: option.value, text: option.label }));
    }
    node.value = value;
    node.addEventListener('change', () => {
        changedSelects.add(node);
        Promise.resolve(onChange(node.value)).catch((error) => {
            setResult({ tone: 'error', text: error?.message ?? String(error) });
        });
    });
    return node;
}

function groupedSelect(id, groups, value, onChange, { focusKey } = {}) {
    const node = el('select', {
        id,
        class: 'text_pole',
        'data-focus-key': focusKey ?? id,
    });
    for (const group of groups) {
        if (!group.options.length) {
            continue;
        }
        if (!group.label) {
            for (const option of group.options) {
                node.append(el('option', { value: option.value, text: option.label }));
            }
            continue;
        }
        const optgroup = el('optgroup', { label: group.label });
        for (const option of group.options) {
            optgroup.append(el('option', { value: option.value, text: option.label }));
        }
        node.append(optgroup);
    }
    node.value = value;
    node.addEventListener('change', () => {
        changedSelects.add(node);
        Promise.resolve(onChange(node.value)).catch((error) => {
            setResult({ tone: 'error', text: error?.message ?? String(error) });
        });
    });
    return node;
}

function checkbox(id, checked, onChange, { focusKey } = {}) {
    const node = el('input', {
        id,
        type: 'checkbox',
        'data-focus-key': focusKey ?? id,
    });
    node.checked = checked;
    node.addEventListener('change', () => {
        Promise.resolve(onChange(node.checked)).catch((error) => {
            setResult({ tone: 'error', text: error?.message ?? String(error) });
        });
    });
    return node;
}

function captureFocus() {
    const active = document.activeElement;
    if (!view?.container?.contains(active)) {
        return null;
    }
    return {
        id: active.id || '',
        key: active.dataset?.focusKey || '',
        skipRestore: changedSelects.delete(active),
        start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    };
}

export function shouldRestoreFocus(snapshot) {
    return Boolean(snapshot && !snapshot.skipRestore);
}

function restoreFocus(snapshot) {
    if (!shouldRestoreFocus(snapshot) || !view) {
        return;
    }
    let target = snapshot.id ? document.getElementById(snapshot.id) : null;
    if (!target && snapshot.key) {
        target = [...view.container.querySelectorAll('[data-focus-key]')]
            .find(node => node.dataset.focusKey === snapshot.key);
    }
    if (!(target instanceof HTMLElement)) {
        return;
    }
    target.focus({ preventScroll: true });
    if (snapshot.start !== null && typeof target.setSelectionRange === 'function') {
        target.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
    }
}

function captureScroll() {
    if (!view) {
        return [];
    }
    const snapshots = [];
    const seen = new Set();
    let current = view.container.contains(document.activeElement)
        ? document.activeElement
        : view.container;
    while (current) {
        if ((current.scrollHeight > current.clientHeight || current.scrollWidth > current.clientWidth)
            && !seen.has(current)) {
            snapshots.push({
                node: current,
                top: current.scrollTop,
                left: current.scrollLeft,
            });
            seen.add(current);
        }
        current = current.parentElement;
    }
    const root = document.scrollingElement;
    if (root && !seen.has(root)) {
        snapshots.push({ node: root, top: root.scrollTop, left: root.scrollLeft });
    }
    return snapshots;
}

function restoreScroll(snapshots) {
    for (const snapshot of snapshots ?? []) {
        if (!snapshot.node?.isConnected) {
            continue;
        }
        snapshot.node.scrollTop = snapshot.top;
        snapshot.node.scrollLeft = snapshot.left;
    }
}

function captureInteraction() {
    return { focus: captureFocus(), scroll: captureScroll() };
}

function restoreInteraction(snapshot) {
    restoreScroll(snapshot?.scroll);
    restoreFocus(snapshot?.focus);
}

export function drawerIconClass(open) {
    const direction = open
        ? 'fa-circle-chevron-up up'
        : 'fa-circle-chevron-down down';
    return `inline-drawer-icon fa-solid ${direction}`;
}

function observeDrawerState(drawer, toggle, content, onChange = () => {}) {
    const icon = toggle.querySelector('.inline-drawer-icon');
    let previousOpen = null;
    const sync = () => {
        const open = icon?.classList.contains('up') ?? false;
        content.setAttribute('aria-hidden', String(!open));
        if (open !== previousOpen) {
            previousOpen = open;
            onChange(open);
        }
    };
    const observer = new MutationObserver(sync);
    if (icon) {
        observer.observe(icon, { attributes: true, attributeFilter: ['class'] });
    }
    observer.observe(content, { attributes: true, attributeFilter: ['style'] });
    drawerStateObservers.add(observer);
    drawer.addEventListener('inline-drawer-toggle', (event) => {
        if (event.target === drawer) {
            sync();
        }
    });
    sync();
}

function disconnectDrawerStateObservers() {
    for (const observer of drawerStateObservers) {
        observer.disconnect();
    }
    drawerStateObservers.clear();
}

function makeDrawerToggle(id, title, level, open) {
    // No aria-hidden: with a <div> header the host's a11y pass makes this
    // chevron the keyboard control, so hiding it would hide the only control.
    const icon = el('span', { class: drawerIconClass(open) });
    // Plain <div> with a <b> title, exactly like every host drawer header: a
    // <button> would need a font/colour reset that outranks theme rules on
    // .inline-drawer-header, and the host makes the chevron the keyboard target.
    return el('div', {
        id,
        class: 'inline-drawer-toggle inline-drawer-header rat-drawer-toggle',
    }, [
        el('b', { role: 'heading', 'aria-level': String(level), text: title }),
        icon,
    ]);
}

function makeSection(key, title) {
    const contentId = `rat_section_${key}`;
    const open = sectionOpen[key];
    const content = el('div', {
        id: contentId,
        class: 'inline-drawer-content rat-section-content',
        'aria-hidden': String(!open),
    });
    content.style.display = open ? 'block' : 'none';
    const toggle = makeDrawerToggle(`rat_toggle_${key}`, title, 3, open);
    const drawer = el('section', {
        class: 'inline-drawer rat-section',
        'data-rat-section': key,
    }, [toggle, content]);
    observeDrawerState(drawer, toggle, content, (isOpen) => {
        sectionOpen[key] = isOpen;
        if (key === 'browse' && isOpen) {
            queueMicrotask(mountVisibleThumbnailFallbacks);
        }
    });
    return { drawer, toggle, content };
}

function themeGroups(settings, { includeInherit = false } = {}) {
    const first = includeInherit
        ? [
            { value: '', label: 'Use default theme' },
            { value: STOCK_THEME, label: 'Original tracker style' },
        ]
        : [{ value: STOCK_THEME, label: 'Original tracker style' }];
    const groups = [{ label: '', options: first }];
    for (const family of FAMILIES) {
        groups.push({
            label: family.label,
            options: THEMES
                .filter(theme => theme.family === family.id)
                .map(theme => ({ value: theme.slug, label: theme.name })),
        });
    }
    groups.push({
        label: 'Custom',
        options: Object.values(settings.customThemes)
            .map(theme => ({ value: theme.slug, label: theme.name ?? theme.slug })),
    });
    return groups;
}

function themeEntries(settings) {
    return [
        {
            slug: STOCK_THEME,
            name: 'Original tracker style',
            family: 'original',
            familyLabel: 'Original',
            mode: 'host',
            theme: null,
        },
        ...THEMES.map(theme => ({
            ...theme,
            familyLabel: FAMILIES.find(family => family.id === theme.family)?.label ?? theme.family,
            theme,
        })),
        ...Object.values(settings.customThemes).map(theme => ({
            ...theme,
            name: theme.name ?? theme.slug,
            family: 'custom',
            familyLabel: 'Custom',
            mode: theme.mode ?? 'custom',
            theme,
        })),
    ];
}

function formatNames(items) {
    return items
        .map(item => item?.agentName ?? item?.name ?? item?.agentId ?? item?.id)
        .filter(Boolean)
        .join(', ');
}

/** Converts apply-engine results into persistent, human-readable UI feedback. */
export function summarizeApplyResult(result) {
    if (!result?.ok) {
        return { tone: 'error', text: result?.reason ?? 'Could not update tracker themes.' };
    }
    const parts = [];
    if (result.applied) {
        parts.push(`${result.applied} themed`);
    }
    if (result.reverted) {
        parts.push(`${result.reverted} restored`);
    }
    if (result.unchanged) {
        parts.push(`${result.unchanged} already current`);
    }
    if (result.blocked?.length) {
        parts.push(`skipped edited trackers: ${formatNames(result.blocked)}`);
    }
    if (result.failed?.length) {
        parts.push(`failed: ${formatNames(result.failed)}`);
    }
    return {
        tone: result.failed?.length ? 'error' : result.blocked?.length ? 'warning' : 'success',
        text: parts.length ? `${parts.join('. ')}.` : 'No installed trackers needed changes.',
    };
}

/** Converts a no-write card refresh result into persistent, human-readable UI feedback. */
export function summarizeRefreshResult(result) {
    const repainted = Number(result?.repainted) || 0;
    const failed = Number(result?.failed) || 0;
    if (!result?.ok) {
        if (repainted > 0) {
            return {
                tone: 'warning',
                text: `Refreshed ${repainted} matching tracker ${repainted === 1 ? 'card' : 'cards'}; ${failed || 1} could not be refreshed.`,
            };
        }
        return { tone: 'error', text: result?.reason ?? 'Could not refresh tracker cards.' };
    }
    if (!result.matched) {
        return { tone: 'neutral', text: 'No matching tracker cards are loaded in this chat.' };
    }
    return {
        tone: 'success',
        text: `Refreshed ${repainted} matching tracker ${repainted === 1 ? 'card' : 'cards'}.`,
    };
}

/** Worst-first aggregation shared by duplicate-agent rows and tests. */
export function summarizeTemplateReports(reports) {
    return summarizeStatuses((reports ?? []).map(report => report.status));
}

function renderResult() {
    if (!view?.resultHost) {
        return;
    }
    view.resultHost.textContent = '';
    const result = uiState.result ?? {
        tone: 'neutral',
        text: 'Choose a default theme or preview the library below.',
    };
    view.resultHost.dataset.tone = result.tone;
    view.resultHost.append(el('span', { text: result.text }));
}

function setResult(result, { notify = false } = {}) {
    uiState.result = result;
    renderResult();
    if (notify && result?.tone !== 'progress' && result?.tone !== 'neutral') {
        const type = result.tone === 'error' ? 'error' : result.tone === 'warning' ? 'warning' : 'success';
        toast(type, result.text);
    }
}

function updateBusyState() {
    if (!view) {
        return;
    }
    view.container.setAttribute('aria-busy', String(uiState.busy));
    for (const control of view.container.querySelectorAll('[data-rat-operation], select, input')) {
        control.disabled = uiState.busy || control.dataset.ratStaticDisabled === 'true';
    }
}

async function runOperation(label, operation) {
    if (uiState.busy) {
        return null;
    }
    const interaction = captureInteraction();
    clearTimeout(refreshHandle);
    refreshHandle = null;
    renderGeneration++;
    uiState.busy = true;
    setResult({ tone: 'progress', text: `${label}...` });
    updateBusyState();
    try {
        return await operation();
    } catch (error) {
        setResult({ tone: 'error', text: error?.message ?? String(error) }, { notify: true });
        return null;
    } finally {
        uiState.busy = false;
        await renderView({ interaction });
    }
}

async function confirmAction(title, message, okButton) {
    const context = getContext();
    if (typeof context?.callGenericPopup === 'function') {
        const content = el('div', { class: 'rat-confirm-copy' }, [
            el('strong', { text: title }),
            el('p', { text: message }),
        ]);
        return Boolean(await context.callGenericPopup(content, 2, '', {
            okButton,
            cancelButton: 'Cancel',
            leftAlign: true,
        }));
    }
    return Boolean(globalThis.confirm?.(`${title}\n\n${message}`));
}

function disconnectThumbnailObserver() {
    thumbnailObserver?.disconnect();
    thumbnailObserver = null;
    thumbnailJobs.clear();
}

function runThumbnailJob(host) {
    const job = thumbnailJobs.get(host);
    if (!job || !host.isConnected) {
        thumbnailJobs.delete(host);
        return;
    }
    thumbnailJobs.delete(host);
    job();
}

function mountVisibleThumbnailFallbacks() {
    if (typeof globalThis.IntersectionObserver === 'function') {
        return;
    }
    for (const host of [...thumbnailJobs.keys()]) {
        runThumbnailJob(host);
    }
}

function scheduleThumbnail(host, archetype, theme, options) {
    thumbnailJobs.set(host, () => mountPreview(host, archetype, theme, options));
    if (typeof globalThis.IntersectionObserver !== 'function') {
        queueMicrotask(mountVisibleThumbnailFallbacks);
        return;
    }
    if (!thumbnailObserver) {
        thumbnailObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) {
                    continue;
                }
                thumbnailObserver?.unobserve(entry.target);
                runThumbnailJob(entry.target);
            }
        }, { rootMargin: '180px 0px' });
    }
    thumbnailObserver.observe(host);
}

function applyTheme(slug) {
    return runOperation('Applying theme', async () => {
        updateSettings({ theme: slug });
        uiState.previewThemeSlug = slug;
        const result = await applyAll();
        if (result.ok) {
            uiState.optionsDirty = false;
        }
        setResult(summarizeApplyResult(result), { notify: true });
        return result;
    });
}

function refreshTrackerCards(agents) {
    return runOperation('Refreshing tracker cards', async () => {
        const result = await refreshAgentMessages(agents);
        setResult(summarizeRefreshResult(result), { notify: true });
        return result;
    });
}

function renderOverview(settings, host, agents, reports) {
    const content = view.sections.overview.content;
    content.textContent = '';

    content.append(el('p', {
        class: 'rat-intro',
        text: 'Theme bundled trackers and companion panels without changing prompts or model output.',
    }));

    if (detectEncodedTags()) {
        content.append(el('div', {
            class: 'rat-callout',
            role: 'alert',
            'data-tone': 'warning',
            text: 'Show tags in chat as plain text is enabled. Turn it off in User Settings so tracker HTML can render.',
        }));
    }

    const dependencyText = host.ok
        ? `${agents.length} compatible installed ${agents.length === 1 ? 'agent' : 'agents'} found.`
        : `${host.reason}. Previews remain available, but themes cannot be applied.`;
    const attention = reports.filter(report => !['pristine', 'stock'].includes(report.status));
    const summaryText = host.ok
        ? `${dependencyText} ${Object.keys(settings.overrides).length} tracker override(s). ${attention.length} need attention.`
        : dependencyText;

    content.append(el('div', {
        class: 'rat-dependency',
        'data-tone': host.ok ? 'success' : 'warning',
    }, [
        el('strong', { text: host.ok ? 'In-Chat Agents connected' : 'In-Chat Agents unavailable' }),
        el('span', { text: summaryText }),
    ]));

    const themeSelect = groupedSelect(
        'rat_theme',
        themeGroups(settings),
        settings.theme,
        applyTheme,
    );
    content.append(fieldRow(
        'Default theme',
        themeSelect,
        'Applied to the selected tracker families and companion panels unless an override says otherwise.',
    ));

    const scopeSelect = select('rat_tracker_scope', [
        { value: 'both', label: 'Both' },
        { value: 'pura', label: 'Pura trackers only' },
        { value: 'ethereal', label: 'Ethereal trackers only' },
    ], settings.trackerScope, value => runOperation('Applying tracker selection', async () => {
        updateSettings({ trackerScope: value });
        const result = await applyAll();
        setResult(summarizeApplyResult(result), { notify: true });
        return result;
    }));
    content.append(fieldRow('Apply to trackers', scopeSelect,
        'Excluded trackers return to their original styles. Saved overrides resume when selected again. Companion panels keep their own theme settings.'));

    const refreshButton = button('Refresh all tracker cards', () => refreshTrackerCards(agents), {
        disabled: !host.ok || !agents.length,
        focusKey: 'refresh-all-cards',
        ariaLabel: 'Refresh matching tracker cards in the current chat',
    });
    if (!host.ok || !agents.length) {
        refreshButton.dataset.ratStaticDisabled = 'true';
    }
    content.append(el('div', { class: 'rat-action-row' }, [refreshButton]));

    view.resultHost = el('div', {
        class: 'rat-result',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
    });
    content.append(view.resultHost);
    renderResult();
}

function rerenderBrowse() {
    if (!view) {
        return;
    }
    const interaction = captureInteraction();
    renderBrowse(getSettings());
    updateBusyState();
    queueMicrotask(() => restoreInteraction(interaction));
}

function renderBrowse(settings) {
    const content = view.sections.browse.content;
    disconnectThumbnailObserver();
    content.textContent = '';

    const entries = themeEntries(settings);
    if (!entries.some(entry => entry.slug === uiState.previewThemeSlug)) {
        uiState.previewThemeSlug = settings.theme;
    }

    const familyOptions = [
        { value: 'all', label: 'All families' },
        { value: 'original', label: 'Original' },
        ...FAMILIES.map(family => ({ value: family.id, label: family.label })),
    ];
    if (Object.keys(settings.customThemes).length) {
        familyOptions.push({ value: 'custom', label: 'Custom' });
    }

    const search = el('input', {
        id: 'rat_theme_search',
        class: 'text_pole',
        type: 'search',
        value: uiState.query,
        placeholder: 'Search themes',
        'data-focus-key': 'rat_theme_search',
    });
    search.value = uiState.query;
    search.addEventListener('input', () => {
        uiState.query = search.value;
        rerenderBrowse();
    });

    const family = select('rat_family_filter', familyOptions, uiState.family, (value) => {
        uiState.family = value;
        rerenderBrowse();
    });
    const mode = select('rat_mode_filter', [
        { value: 'all', label: 'All colour modes' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'adaptive', label: 'Adaptive' },
        { value: 'host', label: 'Original host style' },
        { value: 'custom', label: 'Custom' },
    ], uiState.mode, (value) => {
        uiState.mode = value;
        rerenderBrowse();
    });
    const shape = select(
        'rat_preview_archetype',
        Object.keys(PREVIEW_KEYS).map(value => ({ value, label: ARCHETYPE_LABELS[value] ?? value })),
        uiState.previewArchetype,
        (value) => {
            uiState.previewArchetype = value;
            rerenderBrowse();
        },
    );

    content.append(el('div', { class: 'rat-filter-grid' }, [
        fieldRow('Search', search),
        fieldRow('Family', family),
        fieldRow('Colour mode', mode),
        fieldRow('Preview shape', shape),
    ]));

    const selected = entries.find(entry => entry.slug === uiState.previewThemeSlug) ?? entries[0];
    const selectedPreview = el('div', { class: 'rat-preview rat-selected-preview' });
    mountPreview(selectedPreview, uiState.previewArchetype, selected.theme, settings.options);
    const selectedCurrent = selected.slug === settings.theme;
    const selectedApply = button(
        selectedCurrent ? 'Current default' : `Apply ${selected.name}`,
        () => applyTheme(selected.slug),
        {
            disabled: selectedCurrent,
            focusKey: `selected-apply-${selected.slug}`,
        },
    );
    if (selectedCurrent) {
        selectedApply.dataset.ratStaticDisabled = 'true';
    }
    content.append(el('section', {
        class: 'rat-preview-stage',
        'aria-labelledby': 'rat_selected_theme_name',
    }, [
        el('div', { class: 'rat-preview-stage-head' }, [
            el('div', {}, el('h4', { id: 'rat_selected_theme_name', text: selected.name })),
            selectedApply,
        ]),
        selectedPreview,
    ]));

    const query = uiState.query.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
        const familyMatch = uiState.family === 'all' || entry.family === uiState.family;
        const modeMatch = uiState.mode === 'all' || entry.mode === uiState.mode;
        const queryMatch = !query || `${entry.name} ${entry.familyLabel} ${entry.mode}`.toLowerCase().includes(query);
        return familyMatch && modeMatch && queryMatch;
    });

    content.append(el('p', {
        class: 'rat-gallery-count',
        'aria-live': 'polite',
        text: `${filtered.length} ${filtered.length === 1 ? 'theme' : 'themes'}`,
    }));

    if (!filtered.length) {
        content.append(el('p', {
            class: 'rat-empty',
            text: 'No themes match these filters. Clear the search or choose another family.',
        }));
        return;
    }

    const gallery = el('div', { class: 'rat-gallery', id: 'rat_gallery' });
    for (const entry of filtered) {
        const selectedCard = uiState.previewThemeSlug === entry.slug;
        const current = settings.theme === entry.slug;
        const headingId = `rat_theme_name_${entry.slug}`;
        const card = el('article', {
            class: 'rat-card',
            'data-selected': String(selectedCard),
            'data-current': String(current),
            'aria-labelledby': headingId,
        });
        card.append(el('div', { class: 'rat-card-head' }, [
            el('h4', { id: headingId, class: 'rat-card-name', text: entry.name }),
            el('span', { class: 'rat-card-mode', text: entry.mode }),
        ]));

        const thumbnail = el('div', {
            class: 'rat-preview rat-thumbnail',
            inert: '',
            'aria-hidden': 'true',
        });
        try {
            thumbnail.inert = true;
        } catch {
            // The attribute above remains the fallback for browsers without the property.
        }
        card.append(thumbnail);
        scheduleThumbnail(thumbnail, uiState.previewArchetype, entry.theme, settings.options);

        const previewButton = button('Preview', () => {
            uiState.previewThemeSlug = entry.slug;
            rerenderBrowse();
        }, {
            focusKey: `preview-${entry.slug}`,
            ariaLabel: `Preview ${entry.name}`,
        });
        const applyButton = button(current ? 'Current' : 'Apply', () => applyTheme(entry.slug), {
            disabled: current,
            focusKey: `apply-${entry.slug}`,
            ariaLabel: current
                ? `${entry.name} is the current default theme`
                : `Apply ${entry.name}`,
        });
        if (current) {
            applyButton.dataset.ratStaticDisabled = 'true';
        }
        card.append(el('div', { class: 'rat-card-actions' }, [previewButton, applyButton]));
        gallery.append(card);
    }
    content.append(gallery);
}

function updateOption(patch, { dirty = true } = {}) {
    updateSettings({ options: patch });
    if (dirty) {
        uiState.optionsDirty = true;
        setResult({
            tone: 'warning',
            text: 'Options changed. Preview a non-original theme, then apply option changes to update installed cards.',
        });
    }
    refresh();
}

function applyOptionChanges() {
    return runOperation('Applying option changes', async () => {
        const result = await applyAll();
        if (result.ok) {
            uiState.optionsDirty = false;
        }
        setResult(summarizeApplyResult(result), { notify: true });
        return result;
    });
}

function renderOptions(settings) {
    const content = view.sections.options.content;
    content.textContent = '';
    const options = settings.options;

    content.append(el('div', { class: 'rat-option-grid' }, [
        fieldRow('Density', select('rat_density', [
            { value: 'compact', label: 'Compact spacing' },
            { value: 'normal', label: 'Theme default' },
            { value: 'roomy', label: 'Roomy spacing' },
        ], options.density, value => updateOption({ density: value }))),
        fieldRow('Panel defaults', select('rat_open_defaults', [
            { value: 'theme', label: 'Use theme default' },
            { value: 'all-open', label: 'Always expanded' },
            { value: 'all-closed', label: 'Always collapsed' },
        ], options.openDefaults, value => updateOption({ openDefaults: value }))),
    ]));

    content.append(el('div', { class: 'rat-check-list' }, [
        optionRow('Use Neconyan theme colours', checkbox(
            'rat_adaptive',
            options.adaptiveNeutrals,
            value => updateOption({ adaptiveNeutrals: value }),
        ), 'Adapts neutral surfaces to the active host theme.'),
        optionRow('Relationship meter bars', checkbox(
            'rat_meters',
            options.meters,
            value => updateOption({ meters: value }),
        ), 'Adds a visual bar while keeping the numeric value.'),
        optionRow('Restyle bold text', checkbox(
            'rat_bold',
            options.restyleBold,
            value => updateOption({ restyleBold: value }),
        ), 'Lets the selected theme style bold prose.'),
        optionRow('Plain glyphs', checkbox(
            'rat_glyphs',
            options.glyphs === 'none',
            value => updateOption({ glyphs: value ? 'none' : 'theme' }),
        ), 'Removes decorative theme symbols.'),
        optionRow('Re-apply after template updates', checkbox(
            'rat_auto',
            settings.autoReapply,
            (value) => {
                updateSettings({ autoReapply: value });
                refresh();
            },
        ), 'Repairs extension-owned theme output after supported template updates.'),
    ]));

    if (uiState.optionsDirty) {
        content.append(el('div', {
            class: 'rat-callout rat-option-action',
            'data-tone': 'warning',
        }, [
            el('span', { text: 'Previews use the new options only for a selected non-original theme. Original tracker style stays unchanged; installed cards keep their previous values until you apply these changes.' }),
            button('Apply option changes', applyOptionChanges, { focusKey: 'apply-options' }),
        ]));
    } else {
        content.append(el('p', {
            class: 'rat-note',
            text: 'Options preview on selected non-original themes before you apply them to installed cards.',
        }));
    }
}

function emptyBatchResult() {
    return { ok: true, applied: 0, reverted: 0, unchanged: 0, blocked: [], failed: [] };
}

async function runAgentBatch(agents, operation, { restoring = false } = {}) {
    const summary = emptyBatchResult();
    for (const agent of agents) {
        const result = await operation(agent);
        if (result.ok) {
            if (restoring) {
                if (result.unchanged) {
                    summary.unchanged++;
                } else {
                    summary.reverted++;
                }
            } else {
                summary.applied++;
            }
        } else if (result.blocked) {
            summary.blocked.push({ agentId: agent.id, agentName: agent.name, blocked: result.blocked });
        } else {
            summary.failed.push({ agentId: agent.id, agentName: agent.name, reason: result.reason });
        }
    }
    return summary;
}

function setOverride(templateId, value) {
    const settings = getSettings();
    const overrides = { ...settings.overrides };
    if (value) {
        overrides[templateId] = value;
    } else {
        delete overrides[templateId];
    }
    updateSettings({ overrides });
}

function applyTemplateOverride(templateId, value, agents) {
    const current = getSettings();
    const effective = value || current.theme;
    if (effective === STOCK_THEME) {
        return restoreAgents(agents, {
            label: TEMPLATE_LABELS[templateId] ?? templateId,
            settingsPatch: () => setOverride(templateId, value),
        });
    }
    return runOperation(`Applying ${TEMPLATE_LABELS[templateId] ?? 'tracker'} theme`, async () => {
        setOverride(templateId, value);
        const result = await runAgentBatch(agents, agent => applyToAgent(agent));
        setResult(summarizeApplyResult(result), { notify: true });
        return result;
    });
}

function forceApplyTemplate(templateId, agents) {
    const settings = getSettings();
    const themeSlug = resolveThemeSlug(templateId, settings);
    const theme = getTheme(themeSlug, settings.customThemes);
    const names = formatNames(agents);
    return runOperation('Waiting for confirmation', async () => {
        const confirmed = await confirmAction(
            'Apply over tracker edits?',
            `This will replace edited HTML in: ${names}. The current HTML will be saved so Restore original styles can put it back.`,
            `Apply ${theme?.name ?? themeSlug}`,
        );
        if (!confirmed) {
            setResult({ tone: 'neutral', text: 'No tracker edits were changed.' });
            return null;
        }
        const result = await runAgentBatch(agents, agent => applyToAgent(agent, { force: true }));
        setResult(summarizeApplyResult(result), { notify: true });
        return result;
    });
}

function needsDestructiveRestore(agent, report, settings) {
    const unsafe = report.perScript.some(entry => ['foreign', 'upstream-changed'].includes(entry.status));
    const ledgerMissingForTheme = !settings.ledger[agent.id]
        && ['pristine', 'outdated', 'foreign', 'upstream-changed'].includes(report.status);
    return unsafe || ledgerMissingForTheme;
}

function restoreAgents(agents, { label, settingsPatch }) {
    return runOperation('Checking tracker ownership', async () => {
        const settings = getSettings();
        const reports = new Map(agents.map(agent => [agent.id, inspectAgent(agent, settings)]));
        const forceAgents = agents.filter(agent => needsDestructiveRestore(
            agent,
            reports.get(agent.id),
            settings,
        ));

        if (forceAgents.length) {
            const names = formatNames(forceAgents);
            const confirmed = await confirmAction(
                'Restore original styles?',
                `Restoring ${label} requires replacing script content without a complete ownership record: ${names}. Any unrecorded hand edits in those trackers will be overwritten.`,
                `Restore ${forceAgents.length} tracker(s)`,
            );
            if (!confirmed) {
                setResult({ tone: 'neutral', text: 'No tracker styles were restored.' });
                return null;
            }
        }

        settingsPatch();
        const forced = new Set(forceAgents.map(agent => agent.id));
        const result = await runAgentBatch(
            agents,
            agent => revertAgent(agent, { force: forced.has(agent.id) }),
            { restoring: true },
        );
        setResult(summarizeApplyResult(result), { notify: true });
        return result;
    });
}

function statusBadge(status, { id } = {}) {
    return el('span', {
        id,
        class: 'rat-status',
        'data-status': status,
        title: STATUS_HELP[status] ?? '',
        text: STATUS_LABELS[status] ?? status,
    });
}

function renderScope(settings, host, agents) {
    const content = view.sections.scope.content;
    content.textContent = '';
    if (!host.ok) {
        content.append(el('div', {
            class: 'rat-callout',
            'data-tone': 'warning',
            text: `${host.reason}. Tracker overrides are unavailable.`,
        }));
        return;
    }
    if (!agents.length) {
        content.append(el('div', { class: 'rat-empty' }, [
            el('strong', { text: 'No compatible trackers installed' }),
            el('p', { text: 'Install a bundled In-Chat Agent tracker to set an override.' }),
        ]));
        return;
    }

    const byTemplate = new Map();
    for (const agent of agents) {
        const templateId = agent.sourceTemplateId ?? '';
        if (!byTemplate.has(templateId)) {
            byTemplate.set(templateId, []);
        }
        byTemplate.get(templateId).push(agent);
    }

    content.append(el('p', {
        class: 'rat-note',
        text: 'Overrides affect every installed agent from that tracker template. Expand duplicate entries to review each agent.',
    }));
    const list = el('div', { class: 'rat-scope-list' });
    for (const templateId of THEMABLE_TEMPLATE_IDS) {
        const templateAgents = byTemplate.get(templateId) ?? [];
        if (!templateAgents.length) {
            continue;
        }
        const reports = templateAgents.map(agent => inspectAgent(agent, settings));
        const worst = summarizeTemplateReports(reports);
        const label = TEMPLATE_LABELS[templateId] ?? templateId;
        const titleId = `rat_scope_title_${templateId}`;
        const effective = resolveThemeSlug(templateId, settings);
        const inScope = isTemplateInScope(templateId, settings);

        const themeSelect = groupedSelect(
            `rat_scope_${templateId}`,
            themeGroups(settings, { includeInherit: true }),
            settings.overrides[templateId] ?? '',
            value => applyTemplateOverride(templateId, value, templateAgents),
            { focusKey: `scope-${templateId}` },
        );
        if (!inScope) {
            themeSelect.disabled = true;
            themeSelect.dataset.ratStaticDisabled = 'true';
        }

        const agentList = el('ul', { class: 'rat-agent-list' });
        for (const report of reports) {
            agentList.append(el('li', {}, [
                el('span', { text: report.agentName || report.agentId }),
                statusBadge(report.status),
            ]));
        }
        const agentDetail = templateAgents.length > 1
            ? el('details', { class: 'rat-agent-details' }, [
                el('summary', { text: `${templateAgents.length} installed agents` }),
                agentList,
            ])
            : agentList;

        const actions = el('div', { class: 'rat-action-row' });
        actions.append(button(
            'Refresh cards',
            () => refreshTrackerCards(templateAgents),
            {
                focusKey: `refresh-${templateId}`,
                ariaLabel: `Refresh matching ${label} tracker cards in the current chat`,
            },
        ));
        const hasForeign = reports.some(report => report.status === 'foreign');
        if (hasForeign && effective !== STOCK_THEME) {
            actions.append(button(
                'Apply over edits',
                () => forceApplyTemplate(templateId, templateAgents),
                {
                    focusKey: `force-${templateId}`,
                    ariaLabel: `Apply ${label} theme over external edits`,
                },
            ));
        }
        const restorable = reports.some((report, index) => report.status !== 'stock'
            || Boolean(settings.ledger[templateAgents[index].id]));
        const restoreButton = button(
            'Restore original styles',
            () => restoreAgents(templateAgents, {
                label,
                settingsPatch: () => setOverride(templateId, STOCK_THEME),
            }),
            {
                disabled: !restorable,
                focusKey: `restore-${templateId}`,
                ariaLabel: `Restore original styles for ${label}`,
            },
        );
        if (!restorable) {
            restoreButton.dataset.ratStaticDisabled = 'true';
        }
        actions.append(restoreButton);

        list.append(el('article', {
            class: 'rat-scope-card',
            'data-status': worst,
            'aria-labelledby': titleId,
        }, [
            el('div', { class: 'rat-scope-head' }, [
                el('div', {}, [
                    el('h4', { id: titleId, text: label }),
                    el('p', {
                        text: templateAgents.length === 1
                            ? '1 installed agent'
                            : `${templateAgents.length} installed agents`,
                    }),
                ]),
                statusBadge(worst),
            ]),
            fieldRow(`Theme for ${label}`, themeSelect, inScope ? '' : 'Excluded by Apply to trackers. This override is saved for when you select this family again.'),
            agentDetail,
            actions,
        ]));
    }
    content.append(list);
}

function exportThemes(settings) {
    const payload = createCustomThemeExport(settings.customThemes);
    const blob = new Blob([JSON.stringify(payload, null, 4)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'regex-agent-themes.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    setResult({
        tone: 'success',
        text: `Exported ${Object.keys(settings.customThemes).length} custom theme(s).`,
    });
}

function importThemes() {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) {
            return;
        }
        void runOperation('Importing custom themes', async () => {
            if (file.size > CUSTOM_THEME_LIMITS.fileBytes) {
                setResult({
                    tone: 'error',
                    text: `That file exceeds the ${Math.round(CUSTOM_THEME_LIMITS.fileBytes / 1024)} KB import limit.`,
                }, { notify: true });
                return null;
            }
            const before = getSettings();
            const plan = parseCustomThemeImport(await file.text(), before.customThemes);
            if (!plan.ok) {
                setResult({ tone: 'error', text: plan.error }, { notify: true });
                return null;
            }
            if (!plan.accepted.length) {
                const reason = plan.rejected[0]
                    ? `${plan.rejected[0].slug}: ${plan.rejected[0].reason}`
                    : 'No supported themes were present.';
                setResult({ tone: 'warning', text: `No themes were imported. ${reason}` }, { notify: true });
                return null;
            }

            const describe = (slugs) => {
                const names = slugs.slice(0, 8).map(slug => plan.themes[slug]?.name ?? slug);
                if (slugs.length > names.length) names.push(`and ${slugs.length - names.length} more`);
                return names.join(', ');
            };
            const rejected = plan.rejected.slice(0, 4)
                .map(item => `${item.slug}: ${item.reason}`)
                .join(' ');
            const summary = [
                `Ready to import ${plan.accepted.length}: ${describe(plan.accepted)}.`,
                plan.overwritten.length
                    ? `This will replace ${plan.overwritten.length} existing theme(s): ${describe(plan.overwritten)}.`
                    : '',
                plan.rejected.length
                    ? `${plan.rejected.length} rejected. ${rejected}${plan.rejected.length > 4 ? ' More were rejected.' : ''}`
                    : '',
            ].filter(Boolean).join(' ');
            const confirmed = await confirmAction('Import custom themes?', summary, 'Import themes');
            if (!confirmed) {
                setResult({ tone: 'neutral', text: 'No custom themes were imported.' });
                return null;
            }

            const after = updateSettings({ customThemes: plan.themes });
            setResult({
                tone: plan.rejected.length ? 'warning' : 'success',
                text: `Imported ${plan.accepted.length} custom theme(s)`
                    + `${plan.overwritten.length ? `; replaced ${plan.overwritten.length}` : ''}`
                    + `${plan.rejected.length ? `; rejected ${plan.rejected.length}` : ''}.`,
            }, { notify: true });
            return after;
        });
    });
    input.click();
}

function removeCustomTheme(slug) {
    return runOperation('Waiting for confirmation', async () => {
        const settings = getSettings();
        const theme = settings.customThemes[slug];
        if (!theme) {
            return null;
        }
        const inUse = settings.theme === slug || Object.values(settings.overrides).includes(slug);
        const confirmed = await confirmAction(
            'Remove custom theme?',
            inUse
                ? `${theme.name ?? slug} is currently selected. Removing it will change those selections to the original style.`
                : `Remove ${theme.name ?? slug} from this browser?`,
            'Remove theme',
        );
        if (!confirmed) {
            setResult({ tone: 'neutral', text: 'The custom theme was kept.' });
            return null;
        }
        const customThemes = { ...settings.customThemes };
        delete customThemes[slug];
        updateSettings({ customThemes });
        setResult({ tone: 'success', text: `Removed ${theme.name ?? slug}.` });
        return true;
    });
}

function restoreAll(agents) {
    return restoreAgents(agents, {
        label: 'all installed trackers',
        settingsPatch: () => updateSettings({ theme: STOCK_THEME, overrides: {} }),
    });
}

function renderMaintenance(settings, host, agents) {
    const content = view.sections.maintenance.content;
    content.textContent = '';

    content.append(el('div', { class: 'rat-maintenance-group' }, [
        el('div', {}, [
            el('h4', { text: 'Repair installed themes' }),
            el('p', { text: 'Re-apply the selected themes after template or option changes.' }),
        ]),
        button('Re-apply selected themes', () => runOperation('Re-applying themes', async () => {
            const result = await applyAll();
            if (result.ok) {
                uiState.optionsDirty = false;
            }
            setResult(summarizeApplyResult(result), { notify: true });
            return result;
        }), { disabled: !host.ok || !agents.length, focusKey: 'reapply-all' }),
    ]));

    const customList = el('div', { class: 'rat-custom-list' });
    const customThemes = Object.values(settings.customThemes);
    if (customThemes.length) {
        for (const theme of customThemes) {
            customList.append(el('div', { class: 'rat-custom-row' }, [
                el('span', { text: theme.name ?? theme.slug }),
                button('Remove', () => removeCustomTheme(theme.slug), {
                    focusKey: `remove-custom-${theme.slug}`,
                    ariaLabel: `Remove custom theme ${theme.name ?? theme.slug}`,
                }),
            ]));
        }
    } else {
        customList.append(el('p', { class: 'rat-note', text: 'No custom themes imported.' }));
    }
    const exportButton = button('Export custom themes', () => exportThemes(getSettings()), {
        disabled: !customThemes.length,
        focusKey: 'export-custom',
    });
    if (!customThemes.length) {
        exportButton.dataset.ratStaticDisabled = 'true';
    }
    content.append(el('div', { class: 'rat-maintenance-group' }, [
        el('div', {}, [
            el('h4', { text: 'Custom themes' }),
            el('p', { text: 'Import or export the versioned custom-theme JSON format.' }),
        ]),
        el('div', { class: 'rat-action-row' }, [
            button('Import custom themes', importThemes, { focusKey: 'import-custom' }),
            exportButton,
        ]),
        customList,
    ]));

    const dangerDescriptionId = 'rat_restore_all_description';
    const restoreButton = button('Restore all original styles', () => restoreAll(agents), {
        className: 'menu_button rat-danger-button',
        disabled: !host.ok || !agents.length,
        focusKey: 'restore-all',
        description: dangerDescriptionId,
    });
    if (!host.ok || !agents.length) {
        restoreButton.dataset.ratStaticDisabled = 'true';
    }
    content.append(el('section', {
        class: 'rat-danger-zone',
        'aria-labelledby': 'rat_danger_title',
    }, [
        el('div', {}, [
            el('h4', { id: 'rat_danger_title', text: 'Restore original styles' }),
            el('p', {
                id: dangerDescriptionId,
                text: 'Removes extension-owned themes from every installed tracker. Trackers with unrecorded edits are named before any destructive overwrite.',
            }),
        ]),
        restoreButton,
    ]));
}

async function renderView({ interaction = captureInteraction() } = {}) {
    if (!view) {
        return;
    }
    const generation = ++renderGeneration;
    const settings = getSettings();
    const host = await loadHost();
    if (!view || generation !== renderGeneration) {
        return;
    }
    const agents = host.ok ? themableAgents(host.store.getAgents() ?? []) : [];
    const reports = agents.map(agent => inspectAgent(agent, settings));

    renderOverview(settings, host, agents, reports);
    renderBrowse(settings);
    renderOptions(settings);
    renderScope(settings, host, agents);
    renderMaintenance(settings, host, agents);
    updateBusyState();
    queueMicrotask(() => restoreInteraction(interaction));
}

function refresh() {
    if (uiState.busy) {
        return;
    }
    clearTimeout(refreshHandle);
    refreshHandle = setTimeout(() => {
        void renderView();
    }, 0);
}

function createView(host) {
    disconnectDrawerStateObservers();
    const contentId = 'rat_drawer_content';
    const content = el('div', {
        id: contentId,
        class: 'inline-drawer-content rat-root-content',
        'aria-hidden': 'true',
    });
    content.style.display = 'none';
    const rootToggle = makeDrawerToggle('rat_drawer_toggle', 'Regex Agent Themes', 2, false);
    const sections = {
        overview: makeSection('overview', 'Overview'),
        browse: makeSection('browse', 'Browse themes'),
        options: makeSection('options', 'Options'),
        scope: makeSection('scope', 'Tracker overrides'),
        maintenance: makeSection('maintenance', 'Maintenance'),
    };
    content.append(...Object.values(sections).map(section => section.drawer));

    const drawer = el('div', { class: 'inline-drawer' }, [rootToggle, content]);
    observeDrawerState(drawer, rootToggle, content);

    const container = el('div', {
        class: 'extension_container',
        id: DRAWER_ID,
        'data-extension-name': MODULE_NAME,
        'aria-busy': 'false',
    }, drawer);
    host.append(container);
    return { container, drawer, rootToggle, content, sections, resultHost: null };
}

/** Mounts the drawer. Idempotent, so a re-activation cannot duplicate it. */
export function mountSettings() {
    if (view?.container?.isConnected) {
        return refresh;
    }
    if (document.getElementById(DRAWER_ID)) {
        return () => {};
    }
    const host = document.getElementById('extensions_settings2')
        ?? document.getElementById('extensions_settings');
    if (!host) {
        return () => {};
    }
    view = createView(host);
    void renderView({ interaction: null });
    return refresh;
}

export function removeSettings() {
    clearTimeout(refreshHandle);
    refreshHandle = null;
    renderGeneration++;
    disconnectThumbnailObserver();
    disconnectDrawerStateObservers();
    view?.container?.remove();
    view = null;
}

export { TEMPLATE_LABELS, STATUS_LABELS, ARCHETYPE_LABELS, DENSITIES, OPEN_DEFAULTS };
