import { chat, getCurrentChatId } from '../../../../script.js';
import { escapeHtml } from '../../../utils.js';
import {
    areAgentsGloballyEnabled,
    areAgentsLoaded,
    getAgentById,
    getAgents,
    isAgentEnabledForCurrentScope,
    isAgentRuntimeAllowed,
    isCompanionAgent,
} from '../agent-store.js';
import { cleanCompanionAgentName, insertChoiceIntoMessageInput } from './companion-ui.js';
import { getCompanionResults, getLatestValidCompanionMessageIndex, runCompanionAgentOnMessage } from './companion-runner.js';
import { holdsReadableCompanionResults, isSuppressedCompanionResult } from './companion-shared.js';
import { runCompanionViewAction } from './view-state.js';
import { accountStorage } from '../../../util/AccountStorage.js';

export const COMPANION_WINDOWS_STORAGE_KEY = 'ica--companion-windows-v1';
export const COMPANION_WINDOWS_LAYER_ID = 'ica--cwin-layer';

const WINDOW_MODES = ['desktop', 'phone'];
const WINDOW_MARGIN = 8;
const WINDOW_DRAG_THRESHOLD_PX = 6;
const WINDOW_DRAG_CLICK_GUARD_MS = 350;
const WINDOW_REFIT_THROTTLE_MS = 80;
const WINDOW_TEMPORARY_COLLAPSE_PX = 120;
const WINDOW_DEFAULT_STAGGER_Y = 64;
const EMPTY_WINDOW_NOTE_HTML = '<p class="ica--cwin-empty">Its next note will appear here. Run latest after a reply.</p>';
const WINDOW_STATE_LIMIT = 200;
const WINDOW_ID_LIMIT = 128;
const UNSAFE_WINDOW_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FALLBACK_ICON = 'fa-user-astronaut';
const ICON_PATTERN = /^fa-[a-z0-9-]+$/;
const FOCUS_CONTAINER_SELECTOR = '.ica--cwin-head, .ica--cwin-actions';
export const COMPANION_WINDOW_FOCUS_KEYS = Object.freeze(['grip', 'collapse', 'close', 'run-latest', 'regenerate', 'show']);

let initialized = false;
let windowHooks = {};
let layerNode = null;
let windowsState = emptyWindowsState();
let renderedChatId = '';
let renderedEntries = new Map();
let renderedSections = new Map();
let frontAgentId = '';
let suppressWindowClickUntil = 0;
let refitFrame = 0;
let lastRefitAt = 0;
let composerObserver = null;
let observedComposer = null;
let dragState = null;
let refreshQueuedDuringDrag = false;
let domIdCounter = 0;

function nextDomId(prefix) {
    domIdCounter += 1;
    return `ica--cwin-${prefix}-${domIdCounter}`;
}

/** Rejects prototype keys and absurd ids before a stored object becomes window state. */
export function isSafeCompanionWindowKey(key) {
    return typeof key === 'string'
        && key.length > 0
        && key.length <= WINDOW_ID_LIMIT
        && !UNSAFE_WINDOW_KEYS.has(key);
}

export function clampCompanionWindowFraction(value, fallback = 0.5) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(1, Math.max(0, numeric));
}

function normalizePosition(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    return {
        x: clampCompanionWindowFraction(x),
        y: clampCompanionWindowFraction(y),
    };
}

function emptyWindowsState() {
    return { version: 1, agents: {} };
}

/**
 * Accepts the stored JSON or an already parsed object. Bad entries are dropped rather than
 * repaired into surprising positions; the open/collapsed flags stay usable on their own.
 */
export function parseCompanionWindowsState(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return emptyWindowsState();
        }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return emptyWindowsState();
    }

    const rawAgents = parsed.agents && typeof parsed.agents === 'object' && !Array.isArray(parsed.agents)
        ? parsed.agents
        : parsed.windows && typeof parsed.windows === 'object' && !Array.isArray(parsed.windows)
            ? parsed.windows
            : parsed;

    const agents = {};
    let accepted = 0;
    for (const [agentId, rawEntry] of Object.entries(rawAgents)) {
        if (accepted >= WINDOW_STATE_LIMIT || !isSafeCompanionWindowKey(agentId)) {
            continue;
        }
        if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
            continue;
        }

        const positions = {};
        const rawPositions = rawEntry.positions && typeof rawEntry.positions === 'object' && !Array.isArray(rawEntry.positions)
            ? rawEntry.positions
            : {};
        for (const mode of WINDOW_MODES) {
            const position = normalizePosition(rawPositions[mode]);
            if (position) {
                positions[mode] = position;
            }
        }

        agents[agentId] = {
            open: rawEntry.open === true,
            collapsed: rawEntry.collapsed === true,
            positions,
        };
        accepted += 1;
    }

    return { version: 1, agents };
}

function readStoredWindowsState() {
    try {
        return parseCompanionWindowsState(accountStorage.getItem(COMPANION_WINDOWS_STORAGE_KEY));
    } catch {
        return emptyWindowsState();
    }
}

function persistWindowsState() {
    try {
        accountStorage.setItem(COMPANION_WINDOWS_STORAGE_KEY, JSON.stringify(windowsState));
    } catch {
        // Persistence failure must not make open windows unusable for this session.
    }
}

function getWindowStateEntry(agentId, { create = false } = {}) {
    if (!isSafeCompanionWindowKey(agentId)) {
        return null;
    }
    let entry = Object.hasOwn(windowsState.agents, agentId) ? windowsState.agents[agentId] : null;
    if (!entry && create) {
        entry = { open: false, collapsed: false, positions: {} };
        windowsState.agents[agentId] = entry;
    }
    return entry ?? null;
}

function getWindowMode() {
    return getViewportMetrics().width <= 768 ? 'phone' : 'desktop';
}

function getViewportMetrics() {
    const viewport = globalThis.visualViewport;
    const width = Number(viewport?.width) || Number(globalThis.innerWidth) || 1;
    const height = Number(viewport?.height) || Number(globalThis.innerHeight) || 1;
    return {
        width: Math.max(1, width),
        height: Math.max(1, height),
        offsetLeft: Number(viewport?.offsetLeft) || 0,
        offsetTop: Number(viewport?.offsetTop) || 0,
    };
}

function getTopbarBottom() {
    const rect = globalThis.document?.getElementById?.('top-bar')?.getBoundingClientRect?.();
    return Number.isFinite(rect?.bottom) ? Math.max(0, rect.bottom) : 0;
}

function getComposerTop() {
    const rect = globalThis.document?.getElementById?.('form_sheld')?.getBoundingClientRect?.();
    if (!Number.isFinite(rect?.top) || !Number.isFinite(rect?.height) || rect.height <= 0) {
        return null;
    }
    return rect.top;
}

export function getCompanionWindowWidth(viewportWidth, collapsed, mode = getWindowMode()) {
    const available = Math.max(0, viewportWidth - WINDOW_MARGIN * 2);
    if (mode !== 'phone') {
        return Math.min(collapsed ? 260 : 320, available);
    }
    return Math.min(collapsed ? 260 : 360, available);
}

/**
 * Places a header fully inside the visible viewport and above the phone composer. Body height
 * is capped by the remaining space; when less than 120px is left the body hides temporarily
 * without changing the stored collapsed flag.
 */
export function resolveCompanionWindowLayout({
    viewportWidth,
    viewportHeight,
    desiredLeft,
    desiredTop,
    width,
    headerHeight = 44,
    topLimit = WINDOW_MARGIN,
    bottomLimit = null,
    margin = WINDOW_MARGIN,
    temporaryCollapseThreshold = WINDOW_TEMPORARY_COLLAPSE_PX,
    collapsed = false,
}) {
    const safeWidth = Math.max(0, Math.min(Number(width) || 0, viewportWidth));
    const safeHeaderHeight = Math.max(0, Number(headerHeight) || 0);
    const leftMax = Math.max(margin, viewportWidth - safeWidth - margin);
    const left = Math.min(leftMax, Math.max(margin, Number(desiredLeft) || 0));
    const bottom = Math.max(
        margin + safeHeaderHeight,
        Math.min(viewportHeight - margin, Number.isFinite(bottomLimit) ? bottomLimit : viewportHeight - margin),
    );
    const topMax = Math.max(topLimit, bottom - safeHeaderHeight);
    const top = Math.min(topMax, Math.max(topLimit, Number(desiredTop) || topLimit));
    const available = Math.max(0, bottom - top);
    const temporaryCollapse = !collapsed && available < temporaryCollapseThreshold;
    const bodyMaxHeight = collapsed || temporaryCollapse
        ? 0
        : Math.max(0, available - safeHeaderHeight);

    return { left, top, width: safeWidth, bodyMaxHeight, temporaryCollapse, available };
}

export function getCompanionWindowDefaultLayout(index, { viewportWidth, width, topbarBottom = 0 }) {
    const slot = Number.isInteger(index) && index >= 0 ? index : 0;
    return {
        left: viewportWidth - width - WINDOW_MARGIN,
        top: Math.max(topbarBottom, 0) + 12 + slot * WINDOW_DEFAULT_STAGGER_Y,
    };
}

function headerRectsOverlap(first, second, gap = 4) {
    return first.left < second.right + gap
        && first.right + gap > second.left
        && first.top < second.bottom + gap
        && first.bottom + gap > second.top;
}

/** Picks the first free header slot without moving any existing saved window. */
export function findCompanionWindowDefaultSlot({
    viewportWidth,
    viewportHeight,
    width,
    headerHeight,
    topbarBottom = 0,
    bottomLimit = null,
    occupied = [],
}) {
    const margin = WINDOW_MARGIN;
    const bottom = Math.min(
        viewportHeight - margin,
        Number.isFinite(bottomLimit) ? bottomLimit : viewportHeight - margin,
    );
    const baseTop = Math.max(topbarBottom, 0) + 12;
    const maxTop = bottom - headerHeight;
    const maxSlot = Math.max(0, Math.floor((maxTop - baseTop) / WINDOW_DEFAULT_STAGGER_Y));
    let bestSlot = 0;
    let bestOverlap = Number.POSITIVE_INFINITY;

    for (let slot = 0; slot <= maxSlot; slot++) {
        const layout = getCompanionWindowDefaultLayout(slot, { viewportWidth, width, topbarBottom });
        const rect = {
            left: layout.left,
            right: layout.left + width,
            top: layout.top,
            bottom: layout.top + headerHeight,
        };
        const overlap = occupied.reduce((count, other) => count + (headerRectsOverlap(rect, other) ? 1 : 0), 0);
        if (overlap === 0) {
            return slot;
        }
        if (overlap < bestOverlap) {
            bestOverlap = overlap;
            bestSlot = slot;
        }
    }

    return bestSlot;
}

export function resolveCompanionWindowFraction({ left, top, viewportWidth, viewportHeight }) {
    return {
        x: clampCompanionWindowFraction((Number(left) || 0) / Math.max(1, Number(viewportWidth) || 1)),
        y: clampCompanionWindowFraction((Number(top) || 0) / Math.max(1, Number(viewportHeight) || 1)),
    };
}

function getValidWindowAgent(agentId) {
    const agent = getAgentById?.(agentId) ?? getAgents().find(candidate => candidate.id === agentId);
    if (!agent || !isCompanionAgent(agent) || agent.category === 'tool') {
        return null;
    }
    return agent;
}

function getOpenWindowAgents() {
    return getAgents().filter(agent => (
        isCompanionAgent(agent)
        && agent.category !== 'tool'
        && getWindowStateEntry(agent.id)?.open === true
    ));
}

function pruneWindowState({ persist = false } = {}) {
    if (typeof areAgentsLoaded === 'function' && !areAgentsLoaded()) {
        return false;
    }

    const validIds = new Set(getAgents()
        .filter(agent => isCompanionAgent(agent) && agent.category !== 'tool')
        .map(agent => agent.id)
        .filter(isSafeCompanionWindowKey));
    let changed = false;
    for (const agentId of Object.keys(windowsState.agents)) {
        if (!validIds.has(agentId)) {
            delete windowsState.agents[agentId];
            changed = true;
        }
    }
    if (changed && persist) {
        persistWindowsState();
    }
    return changed;
}

function getLivePreviewMessage() {
    try {
        const message = typeof windowHooks.getLivePreview === 'function' ? windowHooks.getLivePreview() : null;
        return message && holdsReadableCompanionResults(message) ? message : null;
    } catch (error) {
        console.error('[InChatAgents] Companion window preview lookup failed:', error);
        return null;
    }
}

/** Latest stored note for this agent in the current chat, without the panel's display-mode filter. */
export function findLatestCompanionWindowEntry(agentId, { previewMessage = null } = {}) {
    if (!isSafeCompanionWindowKey(agentId)) {
        return null;
    }

    for (let messageIndex = chat.length; messageIndex >= 0; messageIndex--) {
        const isPreview = messageIndex === chat.length;
        const message = isPreview ? previewMessage : chat[messageIndex];
        if (!holdsReadableCompanionResults(message)) {
            continue;
        }

        const result = getCompanionResults(message)[agentId];
        if (!result || typeof result !== 'object' || isSuppressedCompanionResult(agentId, result)) {
            continue;
        }

        return {
            messageIndex: isPreview ? -1 : messageIndex,
            result,
            message,
            preview: isPreview,
            hostHidden: Boolean(message?.is_system),
        };
    }

    return null;
}

function normalizeWindowIcon(icon) {
    const normalized = String(icon ?? '').trim();
    return ICON_PATTERN.test(normalized) ? normalized : FALLBACK_ICON;
}

function getWindowDisplayName(agent, entry) {
    return cleanCompanionAgentName(agent?.name ?? entry?.result?.agentName);
}

function getWindowStatus(agent, entry) {
    if (!areAgentsGloballyEnabled()) {
        return { label: 'Paused', tone: 'off' };
    }
    if (!isAgentEnabledForCurrentScope(agent)) {
        return { label: 'Off', tone: 'off' };
    }
    if (!entry) {
        return { label: 'No note yet', tone: 'empty' };
    }

    switch (entry.result?.status ?? 'done') {
        case 'pending':
            return { label: 'Running', tone: 'running' };
        case 'error':
            return { label: 'Error', tone: 'error' };
        case 'cancelled':
            return { label: 'Cancelled', tone: 'off' };
        default:
            return { label: 'Ready', tone: 'ready' };
    }
}

export function canRunCompanionWindow(agent, entry) {
    return Boolean(agent)
        && Boolean(areAgentsGloballyEnabled())
        && Boolean(isAgentEnabledForCurrentScope(agent))
        && Boolean(isAgentRuntimeAllowed(agent))
        && entry?.result?.status !== 'pending';
}

/**
 * One window's markup. Notes arrive already formatted and sanitised through the panel hook;
 * names, statuses and icons are escaped or validated here before they become attributes.
 */
export function buildCompanionWindowHtml({
    agent,
    entry = null,
    collapsed = false,
    noteHtml = '',
    deferNote = false,
    canRun = false,
    canRegenerate = false,
    canShowInChat = false,
    isFront = false,
}) {
    if (!agent?.id) {
        return '';
    }

    const name = getWindowDisplayName(agent, entry);
    const icon = normalizeWindowIcon(agent.icon ?? entry?.result?.icon);
    const status = getWindowStatus(agent, entry);
    const titleId = nextDomId('title');
    const bodyId = nextDomId('body');
    const safeName = escapeHtml(name);
    const sourceLabel = entry?.preview ? 'Live reply' : entry ? `Message #${entry.messageIndex}` : 'No note in this chat yet';
    const emptyMessage = entry ? '' : EMPTY_WINDOW_NOTE_HTML;
    const noteContent = deferNote ? '' : (noteHtml || emptyMessage);
    const runDisabled = canRun ? '' : ' disabled';
    const regenerateDisabled = canRegenerate ? '' : ' disabled';
    const showDisabled = canShowInChat ? '' : ' disabled';
    const pausedNote = !areAgentsGloballyEnabled() || !isAgentEnabledForCurrentScope(agent)
        ? '<p class="ica--cwin-paused">Runs are off for this companion. Its saved note stays here.</p>'
        : '';

    return `
        <section class="ica--cwin" data-agent-id="${escapeHtml(agent.id)}" data-collapsed="${collapsed}" data-front="${isFront}" role="region" aria-labelledby="${titleId}">
            <header class="ica--cwin-head" data-cwin-drag-handle>
                <button type="button" class="ica--cwin-grip" data-cwin-grip data-cwin-focus="grip" aria-label="${escapeHtml(`Move ${name} window: arrow keys move, Shift for 64 pixels, Home resets`)}" title="Drag to move. Arrow keys move, Shift for 64 pixels, Home resets.">
                    <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
                </button>
                <span class="ica--cwin-heading">
                    <i class="fa-solid ${escapeHtml(icon)}" aria-hidden="true"></i>
                    <span class="ica--cwin-name" id="${titleId}">${safeName}</span>
                </span>
                <span class="ica--cwin-status" data-tone="${status.tone}" data-role="cwin-status">${status.label}</span>
                <button type="button" class="ica--cwin-icon-button" data-action="cwin-collapse" data-cwin-focus="collapse" aria-expanded="${!collapsed}" aria-controls="${bodyId}" title="${collapsed ? 'Expand window' : 'Collapse window'}" aria-label="${escapeHtml(`${collapsed ? 'Expand' : 'Collapse'} ${name} window`)}">
                    <i class="fa-solid ${collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}" aria-hidden="true"></i>
                </button>
                <button type="button" class="ica--cwin-icon-button" data-action="cwin-close" data-cwin-focus="close" title="Close window" aria-label="${escapeHtml(`Close ${name} window`)}">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </header>
            <div class="ica--cwin-body" id="${bodyId}">
                <div class="ica--cwin-source">${escapeHtml(sourceLabel)}</div>
                <div class="ica--cwin-note" data-role="cwin-note">${noteContent}</div>
                ${pausedNote}
                <div class="ica--cwin-actions" role="group" aria-label="Companion window actions">
                    <button type="button" class="menu_button ica--cwin-action ica--cwin-action--primary" data-action="cwin-run-latest" data-cwin-focus="run-latest"${runDisabled} title="Run this companion on the latest reply">
                        <i class="fa-solid fa-play" aria-hidden="true"></i><span>Run latest</span>
                    </button>
                    <button type="button" class="menu_button ica--cwin-action" data-action="cwin-regenerate" data-cwin-focus="regenerate"${regenerateDisabled} title="Write this note again from its message">
                        <i class="fa-solid fa-rotate-right" aria-hidden="true"></i><span>Write again</span>
                    </button>
                    <button type="button" class="menu_button ica--cwin-action" data-action="cwin-show" data-cwin-focus="show"${showDisabled} title="Scroll to the message this note came from">
                        <i class="fa-solid fa-comment-dots" aria-hidden="true"></i><span>Show in chat</span>
                    </button>
                </div>
            </div>
        </section>
    `;
}

/** Only real toolbar/header controls with a fixed key may capture or restore focus. */
export function isCompanionWindowFocusControl(element) {
    if (!element || typeof element.closest !== 'function') {
        return false;
    }
    const container = element.closest(FOCUS_CONTAINER_SELECTOR);
    if (!container) {
        return false;
    }
    const isHeader = container.classList?.contains?.('ica--cwin-head') === true
        && container.parentElement?.classList?.contains?.('ica--cwin') === true;
    const isToolbar = container.classList?.contains?.('ica--cwin-actions') === true
        && container.parentElement?.classList?.contains?.('ica--cwin-body') === true;
    return (isHeader || isToolbar) && COMPANION_WINDOW_FOCUS_KEYS.includes(element.dataset?.cwinFocus);
}

export function getCompanionWindowFocusSelector(key) {
    if (!COMPANION_WINDOW_FOCUS_KEYS.includes(key)) {
        return '';
    }
    return `.ica--cwin-head [data-cwin-focus="${key}"], .ica--cwin-actions [data-cwin-focus="${key}"]`;
}

function captureWindowFocus() {
    const doc = globalThis.document;
    const active = doc?.activeElement;
    if (!active || !layerNode?.contains?.(active) || !isCompanionWindowFocusControl(active)) {
        return null;
    }
    const section = active.closest?.('.ica--cwin');
    const key = active.dataset?.cwinFocus;
    if (!section || !key) {
        return null;
    }
    return { agentId: section.dataset.agentId ?? '', key };
}

function restoreWindowFocus(focus) {
    if (!focus?.agentId || !layerNode?.querySelector) {
        return;
    }
    const selector = getCompanionWindowFocusSelector(focus.key);
    if (!selector) {
        return;
    }
    const sections = [...layerNode.querySelectorAll('.ica--cwin')];
    const section = sections.find(candidate => candidate.dataset?.agentId === focus.agentId);
    const control = section
        ? [...section.querySelectorAll(selector)].find(candidate => isCompanionWindowFocusControl(candidate))
        : null;
    control?.focus?.({ preventScroll: true });
}

function updateFrontWindow(agentId) {
    if (!agentId) {
        return;
    }
    frontAgentId = agentId;
    for (const section of layerNode?.querySelectorAll?.('.ica--cwin') ?? []) {
        section.dataset.front = String(section.dataset?.agentId === agentId);
    }
}

function applyWindowLayout(section, agent, { mode, viewport, topbarBottom, composerTop, defaultSlot = 0 }) {
    const entry = getWindowStateEntry(agent.id);
    if (!entry || !section) {
        return null;
    }

    const collapsed = entry.collapsed === true;
    const width = getCompanionWindowWidth(viewport.width, collapsed, mode);
    const head = section.querySelector?.('.ica--cwin-head');
    const headerHeight = Number(head?.getBoundingClientRect?.().height) || (mode === 'phone' ? 48 : 40);
    const defaultLayout = getCompanionWindowDefaultLayout(defaultSlot, {
        viewportWidth: viewport.width,
        width,
        topbarBottom,
    });
    const stored = entry.positions?.[mode] ?? null;
    const layout = resolveCompanionWindowLayout({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        desiredLeft: stored ? stored.x * viewport.width : defaultLayout.left,
        desiredTop: stored ? stored.y * viewport.height : defaultLayout.top,
        width,
        headerHeight,
        bottomLimit: mode === 'phone' && Number.isFinite(composerTop) ? composerTop - 8 : null,
        collapsed,
    });

    section.style.left = `${Math.round(layout.left + viewport.offsetLeft)}px`;
    section.style.top = `${Math.round(layout.top + viewport.offsetTop)}px`;
    section.style.width = `${Math.round(layout.width)}px`;
    section.dataset.temporaryCollapse = String(layout.temporaryCollapse);
    const body = section.querySelector?.('.ica--cwin-body');
    if (body) {
        body.style.maxHeight = `${Math.round(layout.bodyMaxHeight)}px`;
    }
    return layout;
}

function positionRenderedWindows() {
    if (!layerNode?.querySelectorAll) {
        return;
    }
    const viewport = getViewportMetrics();
    const mode = viewport.width <= 768 ? 'phone' : 'desktop';
    const topbarBottom = getTopbarBottom();
    const composerTop = mode === 'phone' ? getComposerTop() : null;
    const bottomLimit = mode === 'phone' && Number.isFinite(composerTop) ? composerTop - 8 : null;
    const agentsById = new Map(getOpenWindowAgents().map(agent => [agent.id, agent]));
    const sectionsByAgent = new Map([...layerNode.querySelectorAll('.ica--cwin')]
        .map(section => [section.dataset?.agentId, section]));
    const metrics = new Map();
    const occupiedHeaders = [];

    for (const agent of agentsById.values()) {
        const section = sectionsByAgent.get(agent.id);
        if (!section) {
            continue;
        }
        const entry = getWindowStateEntry(agent.id);
        if (!entry) {
            continue;
        }
        const collapsed = entry.collapsed === true;
        const width = getCompanionWindowWidth(viewport.width, collapsed, mode);
        const head = section.querySelector?.('.ica--cwin-head');
        const headerHeight = Number(head?.getBoundingClientRect?.().height) || (mode === 'phone' ? 48 : 40);
        const stored = entry.positions?.[mode] ?? null;
        metrics.set(agent.id, { section, entry, width, headerHeight, stored });

        if (stored) {
            const layout = resolveCompanionWindowLayout({
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                desiredLeft: stored.x * viewport.width,
                desiredTop: stored.y * viewport.height,
                width,
                headerHeight,
                bottomLimit,
                collapsed,
            });
            occupiedHeaders.push({
                left: layout.left,
                right: layout.left + layout.width,
                top: layout.top,
                bottom: layout.top + headerHeight,
            });
        }
    }

    const sections = [...layerNode.querySelectorAll('.ica--cwin')];
    for (const section of sections) {
        const agent = agentsById.get(section.dataset?.agentId);
        const metric = agent ? metrics.get(agent.id) : null;
        if (!agent || !metric) {
            section.remove();
            continue;
        }
        let defaultSlot = 0;
        if (!metric.stored) {
            defaultSlot = findCompanionWindowDefaultSlot({
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                width: metric.width,
                headerHeight: metric.headerHeight,
                topbarBottom,
                bottomLimit,
                occupied: occupiedHeaders,
            });
        }
        const layout = applyWindowLayout(section, agent, {
            mode,
            viewport,
            topbarBottom,
            composerTop,
            defaultSlot,
        });
        if (!metric.stored && layout) {
            occupiedHeaders.push({
                left: layout.left,
                right: layout.left + layout.width,
                top: layout.top,
                bottom: layout.top + metric.headerHeight,
            });
        }
    }
}

export function getCompanionWindowNoteKey({ chatId = '', entry = null } = {}) {
    if (!entry) {
        return JSON.stringify([chatId, 'none']);
    }
    const result = entry.result ?? {};
    return JSON.stringify([
        chatId,
        entry.messageIndex,
        Boolean(entry.preview),
        Boolean(entry.hostHidden),
        result.status ?? 'done',
        result.content ?? '',
        result.error ?? '',
        result.lastRunError ?? '',
    ]);
}

export function getCompanionWindowRenderKey({ noteKey = '', agent = null, noteHtml = '', canRun = false, canRegenerate = false, canShowInChat = false, statusLabel = '' } = {}) {
    return JSON.stringify([
        noteKey,
        agent?.name ?? '',
        agent?.icon ?? '',
        noteHtml,
        Boolean(canRun),
        Boolean(canRegenerate),
        Boolean(canShowInChat),
        statusLabel,
    ]);
}

function syncWindowCollapsedState(section, collapsed, name) {
    if (!section) {
        return;
    }
    section.dataset.collapsed = String(collapsed);
    const button = section.querySelector('[data-action="cwin-collapse"]');
    if (!button) {
        return;
    }
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? 'Expand window' : 'Collapse window';
    button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${name} window`);
    const icon = button.querySelector('i');
    icon?.classList.toggle('fa-chevron-down', collapsed);
    icon?.classList.toggle('fa-chevron-up', !collapsed);
}

function captureWindowBodyView(section) {
    const body = section?.querySelector?.('.ica--cwin-body');
    return {
        scrollTop: Number(body?.scrollTop) || 0,
        details: [...section?.querySelectorAll?.('.ica--cwin-body details') ?? []].map(details => details.open === true),
    };
}

function restoreWindowBodyView(section, view) {
    if (!section || !view) {
        return;
    }
    const details = [...section.querySelectorAll('.ica--cwin-body details')];
    details.forEach((node, index) => {
        if (typeof view.details[index] === 'boolean') {
            node.open = view.details[index];
        }
    });
    const body = section.querySelector('.ica--cwin-body');
    if (body) {
        body.scrollTop = Math.max(0, Number(view.scrollTop) || 0);
    }
}

function clearRenderedWindowSections() {
    for (const cached of renderedSections.values()) {
        cached.element?.remove?.();
    }
    renderedSections = new Map();
    if (layerNode) {
        layerNode.innerHTML = '';
    }
}

function shouldHideWindowLayer() {
    if (typeof windowHooks.isConversationModeActive === 'function' && windowHooks.isConversationModeActive()) {
        return true;
    }
    return chat.length === 0 && !getLivePreviewMessage();
}

function syncComposerObserver() {
    if (typeof globalThis.ResizeObserver !== 'function') {
        return;
    }
    const composer = globalThis.document?.getElementById?.('form_sheld') ?? null;
    if (composer === observedComposer) {
        return;
    }
    composerObserver?.disconnect?.();
    observedComposer = composer;
    if (composer) {
        composerObserver.observe(composer);
    }
}

function scheduleWindowRefit() {
    if (!initialized || dragState) {
        return;
    }
    const now = Date.now();
    if (refitFrame || now - lastRefitAt < WINDOW_REFIT_THROTTLE_MS) {
        return;
    }
    const run = () => {
        refitFrame = 0;
        lastRefitAt = Date.now();
        positionRenderedWindows();
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
        refitFrame = globalThis.requestAnimationFrame(run);
    } else {
        run();
    }
}

/** Re-renders every open window from the current chat. Never starts a generation. */
export function refreshCompanionWindows({ preserveFocus = true } = {}) {
    if (!initialized) {
        return;
    }
    if (dragState) {
        refreshQueuedDuringDrag = true;
        return;
    }

    pruneWindowState();
    const agents = getOpenWindowAgents();
    const hidden = agents.length === 0 || shouldHideWindowLayer();
    layerNode.hidden = hidden;
    layerNode.setAttribute('aria-hidden', String(hidden));

    if (agents.length === 0 || hidden) {
        clearRenderedWindowSections();
        renderedEntries = new Map();
        renderedChatId = getCurrentChatId?.() ?? '';
        return;
    }

    const focus = preserveFocus ? captureWindowFocus() : null;
    const previewMessage = getLivePreviewMessage();
    const mode = getWindowMode();
    const currentChatId = getCurrentChatId?.() ?? '';
    const nextEntries = new Map();
    const nextSections = new Map();
    const restores = new Map();
    const sameNoteIds = new Set();
    const doc = globalThis.document;

    for (const agent of agents) {
        const entry = findLatestCompanionWindowEntry(agent.id, { previewMessage });
        nextEntries.set(agent.id, { ...(entry ?? {}) });
        const stateEntry = getWindowStateEntry(agent.id);
        let noteHtml = '';
        if (entry && typeof windowHooks.formatEntry === 'function') {
            try {
                noteHtml = windowHooks.formatEntry(agent.id, entry);
            } catch (error) {
                console.error('[InChatAgents] Companion window note failed to render:', error);
                noteHtml = '<p class="ica--cwin-empty">This note could not be shown. Try again after the next reply.</p>';
            }
        }
        const canRun = canRunCompanionWindow(agent, entry);
        const canRegenerate = canRun && Boolean(entry) && !entry.preview && !entry.hostHidden;
        const canShowInChat = Boolean(entry) && !entry.preview;
        const statusLabel = getWindowStatus(agent, entry).label;
        const noteKey = getCompanionWindowNoteKey({ chatId: currentChatId, entry });
        const renderKey = getCompanionWindowRenderKey({
            noteKey,
            agent,
            noteHtml,
            canRun,
            canRegenerate,
            canShowInChat,
            statusLabel,
        });
        const existing = renderedSections.get(agent.id);
        let section = existing?.element;
        if (existing && existing.noteKey === noteKey) {
            sameNoteIds.add(agent.id);
        }
        if (!section || existing.renderKey !== renderKey || !section.isConnected) {
            if (section && existing.noteKey === noteKey) {
                restores.set(agent.id, captureWindowBodyView(section));
            }
            const html = buildCompanionWindowHtml({
                agent,
                entry,
                collapsed: stateEntry?.collapsed === true,
                noteHtml,
                deferNote: true,
                canRun,
                canRegenerate,
                canShowInChat,
                isFront: agent.id === frontAgentId,
            });
            const template = doc?.createElement?.('template');
            if (html && template) {
                template.innerHTML = html;
                const next = template.content?.firstElementChild ?? template.firstElementChild;
                if (next) {
                    // Set the already-sanitised note inside its own node so its markup cannot
                    // close the window body or pretend to be a header or toolbar control.
                    const noteNode = next.querySelector('[data-role="cwin-note"]');
                    if (noteNode) {
                        noteNode.innerHTML = noteHtml || (entry ? '' : EMPTY_WINDOW_NOTE_HTML);
                    }
                    if (section?.isConnected && section.replaceWith) {
                        section.replaceWith(next);
                    } else {
                        layerNode.append(next);
                    }
                    section = next;
                }
            }
        }
        if (section) {
            syncWindowCollapsedState(section, stateEntry?.collapsed === true, getWindowDisplayName(agent, entry));
            nextSections.set(agent.id, { element: section, renderKey, noteKey });
        }
    }

    for (const [agentId, cached] of renderedSections) {
        if (!nextSections.has(agentId)) {
            cached.element?.remove?.();
        }
    }

    // Moving a node resets its body scroll in Chromium. Reorder only when the order really
    // changed, so an unchanged refresh leaves every retained window untouched.
    const orderedSections = agents.map(agent => nextSections.get(agent.id)?.element).filter(Boolean);
    const currentSections = [...layerNode.children];
    const sameOrder = orderedSections.length === currentSections.length
        && orderedSections.every((section, index) => section === currentSections[index]);
    if (!sameOrder && doc) {
        for (const agent of agents) {
            const cached = nextSections.get(agent.id);
            if (cached && sameNoteIds.has(agent.id) && !restores.has(agent.id)) {
                restores.set(agent.id, captureWindowBodyView(cached.element));
            }
        }
        const fragment = doc.createDocumentFragment();
        for (const section of orderedSections) {
            fragment.append(section);
        }
        layerNode.append(fragment);
    }
    renderedSections = nextSections;
    layerNode.dataset.mode = mode;
    renderedChatId = currentChatId;
    renderedEntries = nextEntries;
    layerNode.hidden = false;
    layerNode.setAttribute('aria-hidden', 'false');
    for (const section of layerNode.querySelectorAll('.ica--cwin')) {
        section.dataset.front = String(section.dataset?.agentId === frontAgentId);
    }
    syncComposerObserver();
    positionRenderedWindows();
    for (const [agentId, view] of restores) {
        restoreWindowBodyView(renderedSections.get(agentId)?.element, view);
    }
    restoreWindowFocus(focus);
}

export function resolveCompanionWindowBlockReason({ agentExists = true, conversationMode = false, hasContext = true } = {}) {
    if (!agentExists) {
        return 'missing';
    }
    if (conversationMode) {
        return 'conversation';
    }
    if (!hasContext) {
        return 'no-chat';
    }
    return '';
}

export function getCompanionWindowBlockReason(agentId) {
    const agent = getValidWindowAgent(agentId);
    const conversationMode = typeof windowHooks.isConversationModeActive === 'function'
        ? windowHooks.isConversationModeActive()
        : false;
    const hasContext = chat.length > 0 || Boolean(getLivePreviewMessage());
    return resolveCompanionWindowBlockReason({ agentExists: Boolean(agent), conversationMode, hasContext });
}

function explainWindowBlock(reason) {
    if (reason === 'conversation') {
        globalThis.toastr?.warning?.('Companion windows are hidden in Conversation Mode. Switch back to Roleplay to open one.');
    } else if (reason === 'no-chat') {
        globalThis.toastr?.warning?.('Open a chat with at least one message before opening a Companion window.');
    } else {
        globalThis.toastr?.warning?.('That companion no longer exists.');
    }
}

/** Opens one saved window without generating anything. */
export function openCompanionWindow(agentId) {
    const reason = getCompanionWindowBlockReason(agentId);
    if (reason) {
        explainWindowBlock(reason);
        return false;
    }
    const agent = getValidWindowAgent(agentId);
    if (!agent) {
        explainWindowBlock('missing');
        return false;
    }
    const entry = getWindowStateEntry(agent.id, { create: true });
    entry.open = true;
    frontAgentId = agent.id;
    persistWindowsState();
    refreshCompanionWindows({ preserveFocus: false });

    // Keep the first placement stable when another window opens or closes later. This is
    // an explicit open, not a refresh, so writing the default position is allowed.
    const mode = getWindowMode();
    const section = [...layerNode?.querySelectorAll?.('.ica--cwin') ?? []]
        .find(candidate => candidate.dataset?.agentId === agent.id);
    if (section && !entry.positions?.[mode]) {
        const viewport = getViewportMetrics();
        entry.positions = entry.positions ?? {};
        entry.positions[mode] = resolveCompanionWindowFraction({
            left: (Number.parseFloat(section.style.left) || 0) - viewport.offsetLeft,
            top: (Number.parseFloat(section.style.top) || 0) - viewport.offsetTop,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
        });
        persistWindowsState();
    }
    return true;
}

export function closeCompanionWindow(agentId) {
    const entry = getWindowStateEntry(agentId);
    if (!entry) {
        return false;
    }
    entry.open = false;
    persistWindowsState();
    if (frontAgentId === agentId) {
        frontAgentId = getOpenWindowAgents().find(agent => agent.id !== agentId)?.id ?? '';
    }
    refreshCompanionWindows({ preserveFocus: false });
    return true;
}

export function isCompanionWindowOpen(agentId) {
    return getWindowStateEntry(agentId)?.open === true;
}

export function setCompanionWindowCollapsed(agentId, collapsed) {
    const entry = getWindowStateEntry(agentId);
    if (!entry) {
        return false;
    }
    entry.collapsed = Boolean(collapsed);
    persistWindowsState();
    refreshCompanionWindows();
    return true;
}

function scrollChatMessageIntoView(messageElement) {
    const chatRoot = globalThis.document?.getElementById?.('chat');
    if (!messageElement || !chatRoot?.contains?.(messageElement)) {
        return false;
    }
    const chatRect = chatRoot.getBoundingClientRect();
    const messageRect = messageElement.getBoundingClientRect();
    const delta = (messageRect.top - chatRect.top) - ((chatRect.height - messageRect.height) / 2);
    chatRoot.scrollTo({
        top: Math.min(Math.max(chatRoot.scrollTop + delta, 0), Math.max(0, chatRoot.scrollHeight - chatRoot.clientHeight)),
        behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth',
    });
    return true;
}

function currentChatMatchesRendered() {
    const currentChatId = getCurrentChatId?.() ?? '';
    if (currentChatId !== renderedChatId) {
        globalThis.toastr?.warning?.('The chat changed. Open the window again to use its actions.');
        refreshCompanionWindows();
        return false;
    }
    return true;
}

async function runWindowCompanion({ agentId, messageIndex, button }) {
    if (!Number.isInteger(messageIndex) || messageIndex < 0) {
        globalThis.toastr?.warning?.('No reply yet to run this companion on.');
        return;
    }
    const agent = getValidWindowAgent(agentId);
    const entry = renderedEntries.get(agentId) ?? null;
    if (!agent) {
        globalThis.toastr?.warning?.('That companion no longer exists.');
        refreshCompanionWindows();
        return;
    }
    if (entry?.result?.status === 'pending') {
        globalThis.toastr?.info?.('This companion is already running.');
        refreshCompanionWindows();
        return;
    }
    if (!canRunCompanionWindow(agent, entry)) {
        globalThis.toastr?.warning?.('This companion is off. Turn it on before running it.');
        refreshCompanionWindows();
        return;
    }

    button.disabled = true;
    try {
        await runCompanionAgentOnMessage(agentId, messageIndex);
    } finally {
        if (button.isConnected) {
            button.disabled = false;
        }
        refreshCompanionWindows();
    }
}

async function showWindowNoteInChat(agentId) {
    const entry = renderedEntries.get(agentId);
    if (!entry || entry.preview || !Number.isInteger(entry.messageIndex)) {
        globalThis.toastr?.warning?.('That note has no saved message to show.');
        return;
    }
    if (!currentChatMatchesRendered() || chat[entry.messageIndex] !== entry.message) {
        globalThis.toastr?.warning?.('The chat changed before this note could be shown.');
        return;
    }

    const messageElement = globalThis.document?.querySelector?.(`.mes[mesid="${entry.messageIndex}"]`);
    if (!messageElement) {
        globalThis.toastr?.info?.('That message is above the rendered window. Scroll up in the chat to load it.');
        return;
    }
    scrollChatMessageIntoView(messageElement);
}

async function runWindowRegenerate(agentId, button) {
    if (!currentChatMatchesRendered()) {
        return;
    }
    const entry = renderedEntries.get(agentId);
    if (!entry || entry.preview || !Number.isInteger(entry.messageIndex) || chat[entry.messageIndex] !== entry.message) {
        globalThis.toastr?.warning?.('The chat changed before this note could be written again.');
        return;
    }
    if (entry.hostHidden) {
        globalThis.toastr?.warning?.('This note came from a hidden message, so it cannot be written again.');
        return;
    }
    await runWindowCompanion({ agentId, messageIndex: entry.messageIndex, button });
}

async function runWindowLatest(agentId, button) {
    if (!currentChatMatchesRendered()) {
        return;
    }
    const messageIndex = getLatestValidCompanionMessageIndex();
    if (messageIndex < 0) {
        globalThis.toastr?.warning?.('No message yet to run this companion on.');
        return;
    }
    await runWindowCompanion({ agentId, messageIndex, button });
}

async function performWindowAction(action, section, button, agentId) {
    if (action === 'cwin-collapse') {
        const entry = getWindowStateEntry(agentId);
        setCompanionWindowCollapsed(agentId, !(entry?.collapsed === true));
        return;
    }
    if (action === 'cwin-close') {
        closeCompanionWindow(agentId);
        return;
    }
    if (action === 'cwin-run-latest') {
        await runWindowLatest(agentId, button);
        return;
    }
    if (action === 'cwin-regenerate') {
        await runWindowRegenerate(agentId, button);
        return;
    }
    if (action === 'cwin-show') {
        await showWindowNoteInChat(agentId);
    }
}

function handleWindowClick(event) {
    const target = event.target;
    if (!target?.closest) {
        return;
    }

    const section = target.closest('.ica--cwin');
    if (!section) {
        return;
    }
    updateFrontWindow(section.dataset.agentId ?? '');

    const choiceLine = target.closest('.ica--cwin-body .ica--choice-line');
    if (choiceLine) {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() >= suppressWindowClickUntil) {
            insertChoiceIntoMessageInput(choiceLine.dataset?.icaChoiceText ?? choiceLine.textContent);
        }
        return;
    }

    // Only toolbar and header controls are trusted. Notes are sanitised without data-action,
    // and this second gate keeps any generated markup from ever reaching a runner.
    const control = target.closest('[data-action]');
    if (!control || !control.closest('.ica--cwin-head, .ica--cwin-actions')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() < suppressWindowClickUntil) {
        return;
    }

    const agentId = section.dataset.agentId ?? '';
    runCompanionViewAction(control, () => performWindowAction(control.dataset.action, section, control, agentId))
        .catch(error => {
            console.error('[InChatAgents] Companion window action failed:', error);
            globalThis.toastr?.error?.(error?.message || 'That action could not finish. Try again.');
        });
}

function applyKeyboardWindowMove(section, agentId, deltaX, deltaY) {
    const agent = getValidWindowAgent(agentId);
    if (!agent || !section) {
        return;
    }
    const viewport = getViewportMetrics();
    const mode = viewport.width <= 768 ? 'phone' : 'desktop';
    const entry = getWindowStateEntry(agentId, { create: true });
    const width = getCompanionWindowWidth(viewport.width, entry.collapsed === true, mode);
    const head = section.querySelector?.('.ica--cwin-head');
    const headerHeight = Number(head?.getBoundingClientRect?.().height) || (mode === 'phone' ? 48 : 40);
    const currentLeft = Number.parseFloat(section.style.left) || 0;
    const currentTop = Number.parseFloat(section.style.top) || 0;
    const layout = resolveCompanionWindowLayout({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        desiredLeft: currentLeft - viewport.offsetLeft + deltaX,
        desiredTop: currentTop - viewport.offsetTop + deltaY,
        width,
        headerHeight,
        bottomLimit: mode === 'phone' && Number.isFinite(getComposerTop()) ? getComposerTop() - 8 : null,
        collapsed: entry.collapsed === true,
    });

    entry.positions[mode] = resolveCompanionWindowFraction({
        left: layout.left,
        top: layout.top,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
    });
    persistWindowsState();
    positionRenderedWindows();
}

function handleWindowKeydown(event) {
    const target = event.target;
    const section = target?.closest?.('.ica--cwin');
    if (!section) {
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        const agentId = section.dataset.agentId ?? '';
        const entry = getWindowStateEntry(agentId);
        if (entry && entry.collapsed !== true) {
            setCompanionWindowCollapsed(agentId, true);
            const collapsedSection = [...layerNode.querySelectorAll('.ica--cwin')]
                .find(candidate => candidate.dataset?.agentId === agentId);
            collapsedSection?.querySelector?.('[data-action="cwin-collapse"]')?.focus?.({ preventScroll: true });
        }
        return;
    }

    const grip = target.closest?.('[data-cwin-grip]');
    if (!grip) {
        return;
    }

    const agentId = section.dataset.agentId ?? '';
    if (event.key === 'Home') {
        event.preventDefault();
        event.stopPropagation();
        const entry = getWindowStateEntry(agentId);
        if (!entry) {
            return;
        }
        delete entry.positions[getWindowMode()];
        persistWindowsState();
        refreshCompanionWindows();
        return;
    }

    const offsets = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
    };
    const direction = offsets[event.key];
    if (!direction) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 64 : 16;
    applyKeyboardWindowMove(section, agentId, direction[0] * step, direction[1] * step);
}

function beginWindowDrag(mode, clientX, clientY, section) {
    if (dragState) {
        return;
    }
    const rect = section.getBoundingClientRect();
    dragState = {
        mode,
        pointerId: null,
        section,
        agentId: section.dataset.agentId ?? '',
        startX: clientX,
        startY: clientY,
        baseLeft: Number.parseFloat(section.style.left) || rect.left,
        baseTop: Number.parseFloat(section.style.top) || rect.top,
        moved: false,
    };
    updateFrontWindow(dragState.agentId);
}

function moveWindowDrag(clientX, clientY) {
    if (!dragState) {
        return;
    }
    const deltaX = clientX - dragState.startX;
    const deltaY = clientY - dragState.startY;
    if (!dragState.moved && Math.max(Math.abs(deltaX), Math.abs(deltaY)) < WINDOW_DRAG_THRESHOLD_PX) {
        return;
    }
    dragState.moved = true;

    const viewport = getViewportMetrics();
    const mode = viewport.width <= 768 ? 'phone' : 'desktop';
    const entry = getWindowStateEntry(dragState.agentId);
    if (!entry) {
        return;
    }
    const width = getCompanionWindowWidth(viewport.width, entry.collapsed === true, mode);
    const head = dragState.section.querySelector?.('.ica--cwin-head');
    const headerHeight = Number(head?.getBoundingClientRect?.().height) || (mode === 'phone' ? 48 : 40);
    const layout = resolveCompanionWindowLayout({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        desiredLeft: dragState.baseLeft - viewport.offsetLeft + deltaX,
        desiredTop: dragState.baseTop - viewport.offsetTop + deltaY,
        width,
        headerHeight,
        bottomLimit: mode === 'phone' && Number.isFinite(getComposerTop()) ? getComposerTop() - 8 : null,
        collapsed: entry.collapsed === true,
    });
    dragState.section.style.left = `${Math.round(layout.left + viewport.offsetLeft)}px`;
    dragState.section.style.top = `${Math.round(layout.top + viewport.offsetTop)}px`;
}

function finishWindowDrag({ cancelled = false } = {}) {
    if (!dragState) {
        return;
    }
    const finished = dragState;
    dragState = null;
    if (finished.moved) {
        suppressWindowClickUntil = Date.now() + WINDOW_DRAG_CLICK_GUARD_MS;
    }
    if (!cancelled && finished.moved) {
        const viewport = getViewportMetrics();
        const mode = viewport.width <= 768 ? 'phone' : 'desktop';
        const entry = getWindowStateEntry(finished.agentId, { create: true });
        entry.positions[mode] = resolveCompanionWindowFraction({
            left: (Number.parseFloat(finished.section.style.left) || 0) - viewport.offsetLeft,
            top: (Number.parseFloat(finished.section.style.top) || 0) - viewport.offsetTop,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
        });
        persistWindowsState();
    }
    positionRenderedWindows();
    if (refreshQueuedDuringDrag) {
        refreshQueuedDuringDrag = false;
        refreshCompanionWindows();
    }
}

function bindWindowInteractions() {
    layerNode.addEventListener('click', handleWindowClick);
    layerNode.addEventListener('keydown', handleWindowKeydown);
    layerNode.addEventListener('focusin', event => {
        const agentId = event.target?.closest?.('.ica--cwin')?.dataset?.agentId;
        if (agentId) {
            updateFrontWindow(agentId);
        }
    });

    layerNode.addEventListener('touchstart', event => {
        if (!event.touches?.length) return;
        const target = event.target;
        if (target?.closest?.('button') && !target.closest?.('[data-cwin-grip]')) {
            // A new press on a control is not the synthetic click after a drag.
            suppressWindowClickUntil = 0;
            return;
        }
        const section = target?.closest?.('.ica--cwin-head')?.closest?.('.ica--cwin');
        if (!section) return;
        beginWindowDrag('touch', event.touches[0].clientX, event.touches[0].clientY, section);
    }, { passive: true });

    layerNode.addEventListener('touchmove', event => {
        if (dragState?.mode !== 'touch' || !event.touches?.length) return;
        if (event.cancelable) {
            event.preventDefault();
        }
        moveWindowDrag(event.touches[0].clientX, event.touches[0].clientY);
    }, { passive: false });

    const touchEnd = event => {
        if (dragState?.mode !== 'touch') return;
        finishWindowDrag({ cancelled: event.type === 'touchcancel' });
    };
    layerNode.addEventListener('touchend', touchEnd);
    layerNode.addEventListener('touchcancel', touchEnd);

    layerNode.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch' || dragState) return;
        const target = event.target;
        if (target?.closest?.('button') && !target.closest?.('[data-cwin-grip]')) {
            suppressWindowClickUntil = 0;
            return;
        }
        const section = target?.closest?.('.ica--cwin-head')?.closest?.('.ica--cwin');
        if (!section) return;
        beginWindowDrag('pointer', event.clientX, event.clientY, section);
        if (!dragState) return;
        dragState.pointerId = event.pointerId;
        layerNode.setPointerCapture?.(event.pointerId);
    });

    layerNode.addEventListener('pointermove', event => {
        if (dragState?.mode !== 'pointer' || dragState.pointerId !== event.pointerId) return;
        event.preventDefault();
        moveWindowDrag(event.clientX, event.clientY);
    });

    const pointerEnd = (event, cancelled) => {
        if (dragState?.mode !== 'pointer' || dragState.pointerId !== event.pointerId) return;
        layerNode.releasePointerCapture?.(event.pointerId);
        finishWindowDrag({ cancelled });
    };
    layerNode.addEventListener('pointerup', event => pointerEnd(event, false));
    layerNode.addEventListener('pointercancel', event => pointerEnd(event, true));
}

/**
 * Creates the single body-level layer and wires the panel's live-preview and formatting
 * seams. Called once by the Companion panel; opening or refreshing never runs a companion.
 */
export function initCompanionWindows(hooks = {}) {
    windowHooks = { ...windowHooks, ...hooks };
    if (initialized) {
        return;
    }

    const doc = globalThis.document;
    if (!doc?.body || typeof doc.createElement !== 'function') {
        return;
    }

    layerNode = doc.getElementById?.(COMPANION_WINDOWS_LAYER_ID) ?? null;
    if (!layerNode) {
        layerNode = doc.createElement('div');
        layerNode.id = COMPANION_WINDOWS_LAYER_ID;
        layerNode.className = 'ica--cwin-layer';
        layerNode.setAttribute('aria-hidden', 'true');
        layerNode.hidden = true;
        doc.body.append(layerNode);
    }

    initialized = true;
    // AccountStorage may finish loading after this module was imported; read it here.
    windowsState = readStoredWindowsState();
    pruneWindowState({ persist: true });
    bindWindowInteractions();

    if (typeof globalThis.ResizeObserver === 'function') {
        composerObserver = new globalThis.ResizeObserver(scheduleWindowRefit);
    }
    globalThis.addEventListener?.('resize', scheduleWindowRefit);
    globalThis.visualViewport?.addEventListener?.('resize', scheduleWindowRefit);
    globalThis.visualViewport?.addEventListener?.('scroll', scheduleWindowRefit);
    refreshCompanionWindows({ preserveFocus: false });
}
