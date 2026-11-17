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

/* Pages from below Workspace that Simple Mode keeps, wherever the sidebar order has moved them. */
export const SIMPLE_MODE_KEPT_ROUTES = Object.freeze(['presets', 'persona', 'botsearcher', 'dialogue-colors']);

/* The character search goes by a plainer name while Simple Mode is on. */
export const SIMPLE_MODE_RAIL_LABELS = Object.freeze({ botsearcher: 'Find characters' });

/* Page tabs that sit beside a kept page and would otherwise show through. */
export const SIMPLE_MODE_HIDDEN_PAGE_TABS = Object.freeze(['sampling', 'advanced-formatting', 'mewmory']);

/* The same pages, as the targets of quick-access slots and Quick Actions. */
export const SIMPLE_MODE_HIDDEN_PAGE_TARGETS = Object.freeze(['left:sampling', 'left:advanced-formatting', 'left:mewmory', 'left:extensions']);

/* Default Quick Actions that only repeat a page the sidebar already lists. */
export const SIMPLE_MODE_REPEATED_QUICK_ACTIONS = Object.freeze(['left:presets', 'left:api', 'left:agents', 'characters:world-info']);

/* Show and hide stay: Memory Shard hides messages and people need the way back. */
export const SIMPLE_MODE_HIDDEN_MESSAGE_ACTIONS = Object.freeze([
    'mes_prompt', 'mes_run_card_scripts', 'mes_media_gallery', 'mes_media_list', 'mes_embed',
    'mes_swipe_picker', 'mes_create_bookmark', 'qig-message-generate',
]);

export const SIMPLE_MODE_HIDDEN_CHAT_BAR_UNITS = Object.freeze(['scroll', 'files', 'rename', 'hideBar']);

export const SIMPLE_MODE_HIDDEN_SELECTORS = Object.freeze([
    '#neconyan-workspace-rail .neconyan-rail-advanced > .neconyan-rail-section-heading:not(#neconyan-rail-quick-actions-title)',
    `#neconyan-workspace-rail .neconyan-rail-button[data-neconyan-rail-home]:not([data-neconyan-rail-home="primary"], [data-neconyan-rail-home="modes"], ${SIMPLE_MODE_KEPT_ROUTES.map(route => `[data-neconyan-route="${route}"]`).join(', ')})`,
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
    '#option_toggle_purrks',
    '#sb-bottom-chat-purrks-btn',
    '#option_copy_chat_link',
    '#option_chat_link_settings',
    '#option_impersonate',
    '.sb-shell-tab[data-sb-tab="extensions"]',
    '.sb-shell-tab[data-sb-tab="server"]',
    '.sb-shell-tab[data-sb-tab="console-logs"]',
    '#chat .mes_mewmory',
    '#chat .mewmory-chips',
    ...SIMPLE_MODE_HIDDEN_PAGE_TABS.map(tab => `.sb-shell-tab[data-sb-tab="${tab}"]`),
    '#sb_character_tab_groups',
    '#sb_character_tab_creator',
    '#sbca_drawer_button',
    ...SIMPLE_MODE_HIDDEN_MESSAGE_ACTIONS.map(action => `#chat .${action}`),
    ...SIMPLE_MODE_HIDDEN_CHAT_BAR_UNITS.map(unit => `[data-sb-bottom-unit="${unit}"]`),
    ...[...SIMPLE_MODE_REPEATED_QUICK_ACTIONS, ...SIMPLE_MODE_HIDDEN_PAGE_TARGETS].map(target => `#neconyan-workspace-rail [data-neconyan-quick-target="tab::${target.replace(':', '::')}"]`),
    ...SIMPLE_MODE_HIDDEN_PAGE_TARGETS.map(target => `[data-sb-shortcut-target="${target}"]`),
    '#result_info_text',
    '#rm_ch_create_block .extension_token_counter',
    '#sb_character_open_creator',
    '#sb_character_editor_tab_metadata',
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
    const tuckedQuickActions = [...SIMPLE_MODE_REPEATED_QUICK_ACTIONS, ...SIMPLE_MODE_HIDDEN_PAGE_TARGETS]
        .map(target => `[data-neconyan-quick-target="tab::${target.replace(':', '::')}"]`).join(', ');
    return [
        /* Quick Actions with nothing left to show says how to fill it, instead of sitting empty under its heading. */
        `html.${SIMPLE_MODE_CLASS}:not([data-neconyan-sidebar="closed"]) #neconyan-workspace-rail [data-neconyan-quick-actions]:not(:has(> button:not(${tuckedQuickActions}))) > [data-neconyan-quick-actions-tucked] { display: block !important; }`,
        `html.${SIMPLE_MODE_CLASS} :is(${SIMPLE_MODE_HIDDEN_SELECTORS.join(', ')}) { display: none !important; }`,
        /* A collapsed section would otherwise take Presets or a moved Workspace page with it, since its heading (the toggle) is hidden. */
        `html.${SIMPLE_MODE_CLASS} #neconyan-workspace-rail .neconyan-rail-advanced { margin-top: 0; }`,
        `html.${SIMPLE_MODE_CLASS} #neconyan-workspace-rail .neconyan-rail-advanced > [data-neconyan-rail-group][hidden]:not([data-neconyan-quick-actions]) { display: block !important; }`,
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
