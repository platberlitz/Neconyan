import { accountStorage } from './util/AccountStorage.js';

/**
 * Simple Mode hides power-user controls so a new or easily overwhelmed user sees
 * the chat, their characters and their connection. Nothing is removed: every
 * hidden control comes back the moment Simple Mode is turned off.
 *
 * The preference is account-backed ('on', 'off' or 'ask'). New profiles are
 * seeded with 'ask' so Nori can offer it at the start of the first-run tour;
 * a missing value counts as off, so existing users see no change.
 */
export const SIMPLE_MODE_KEY = 'NeconyanSimpleMode.v1';
export const SIMPLE_MODE_EVENT = 'neconyan:simple-mode-changed';
export const SIMPLE_MODE_CLASS = 'neconyan-simple-mode';
const SIMPLE_MODE_STYLE_ID = 'neconyan-simple-mode-style';

const SIMPLE_MODE_HIDDEN_RAIL_ROUTES = Object.freeze(['mewmory', 'chat-archive', 'extensions']);

/* Presets is the one Fine-tuning page Simple Mode keeps; every other page from below Workspace goes, wherever the sidebar order has moved it. */
export const SIMPLE_MODE_KEPT_FINE_TUNING_ROUTE = 'presets';

export const SIMPLE_MODE_HIDDEN_SELECTORS = Object.freeze([
    '#neconyan-workspace-rail .neconyan-rail-advanced > .neconyan-rail-section-heading',
    '#neconyan-workspace-rail .neconyan-rail-advanced > [data-neconyan-quick-actions]',
    `#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-rail-home]:not([data-neconyan-rail-home="primary"], [data-neconyan-rail-home="modes"], [data-neconyan-route="${SIMPLE_MODE_KEPT_FINE_TUNING_ROUTE}"])`,
    '#neconyan-workspace-rail .neconyan-rail-modes-label',
    '#neconyan-workspace-rail [data-neconyan-mode-nav]',
    '#neconyan-workspace-rail [data-neconyan-open-archive]',
    ...SIMPLE_MODE_HIDDEN_RAIL_ROUTES.map(route => `#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-rail-home="primary"][data-neconyan-route="${route}"]`),
    '#sb-reasoning-effort-button',
    '.sb-advanced-only',
    '#extensionsMenuButton',
    '#qig-input-btn',
    '#gg-action-button-container',
    '#option_toggle_AN',
    '#option_copy_chat_link',
    '#option_chat_link_settings',
    '#option_impersonate',
    '.sb-shell-tab[data-sb-tab="extensions"]',
    '.sb-shell-tab[data-sb-tab="server"]',
    '.sb-shell-tab[data-sb-tab="console-logs"]',
]);

function normalizeSimpleModePreference(value) {
    return value === 'on' || value === 'ask' ? value : 'off';
}

function readDeviceCopy() {
    try {
        return globalThis.localStorage?.getItem(SIMPLE_MODE_KEY) ?? null;
    } catch {
        return null;
    }
}

function writeDeviceCopy(value) {
    try {
        globalThis.localStorage?.setItem(SIMPLE_MODE_KEY, value);
    } catch { /* Private browsing can refuse storage; the account copy still holds the choice. */ }
}

/**
 * @returns {'on'|'off'|'ask'} The saved choice. Before settings load, the copy on this device stands in.
 */
export function getSimpleModePreference() {
    const value = accountStorage.isReady ? accountStorage.getItem(SIMPLE_MODE_KEY) : readDeviceCopy();
    return normalizeSimpleModePreference(value);
}

export function isSimpleModeEnabled() {
    return getSimpleModePreference() === 'on';
}

export function buildSimpleModeCss() {
    return [
        `html.${SIMPLE_MODE_CLASS} :is(${SIMPLE_MODE_HIDDEN_SELECTORS.join(', ')}) { display: none !important; }`,
        /* A collapsed section would otherwise take Presets or a moved Workspace page with it, since its heading (the toggle) is hidden. */
        `html.${SIMPLE_MODE_CLASS} #neconyan-workspace-rail .neconyan-rail-advanced { margin-top: 0; }`,
        `html.${SIMPLE_MODE_CLASS} #neconyan-workspace-rail .neconyan-rail-advanced > [data-neconyan-rail-group][hidden] { display: block !important; }`,
        `html:not(.${SIMPLE_MODE_CLASS}) .neconyan-rail-simple-exit { display: none !important; }`,
        /* While Nori asks, the answer buttons are the only way forward. */
        '#neconyan-tour-coachmark.neconyan-tour-asking :is([data-tour-coach-back], [data-tour-coach-next]) { display: none !important; }',
    ].join('\n');
}

function ensureSimpleModeStyle() {
    if (typeof document === 'undefined' || document.getElementById(SIMPLE_MODE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SIMPLE_MODE_STYLE_ID;
    style.textContent = buildSimpleModeCss();
    document.head.append(style);
}

/**
 * Applies the saved choice to the page without saving anything.
 * @returns {boolean} Whether Simple Mode is on.
 */
export function applySimpleMode() {
    const enabled = isSimpleModeEnabled();
    if (typeof document === 'undefined') return enabled;
    ensureSimpleModeStyle();
    document.documentElement.classList.toggle(SIMPLE_MODE_CLASS, enabled);
    if (accountStorage.isReady) {
        writeDeviceCopy(getSimpleModePreference());
    }
    return enabled;
}

/**
 * Saves the choice to the account (the settings save is debounced by account storage) and applies it.
 * @param {boolean} enabled
 */
export function setSimpleModeEnabled(enabled) {
    const value = enabled ? 'on' : 'off';
    const changed = getSimpleModePreference() !== value;
    accountStorage.setItem(SIMPLE_MODE_KEY, value);
    writeDeviceCopy(value);
    applySimpleMode();
    if (changed) {
        globalThis.dispatchEvent?.(new CustomEvent(SIMPLE_MODE_EVENT, { detail: { enabled: Boolean(enabled) } }));
    }
}

applySimpleMode();
