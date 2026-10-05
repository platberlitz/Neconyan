import { DEFAULT_SCROLL_EDGE_SETTLE_DELAYS, jumpScrollElementToEdge } from './chat-scroll-edges.js';
import {
    clampMobileShellText as clampText,
    createMobileShellLifecycle,
    MOBILE_SHELL_NAV_TOGGLE_ACTION,
    normalizeMobileShellRailIcon as normalizeFontAwesomeIcon,
    normalizeMobileShellText as normalizeText,
} from './mobile-shell-lifecycle/index.js';
import { isIOSWebKitPlatform, isLegacyIOSWebKitPlatform } from './mobile-send-button.js';
import { hasChatNavigationDraft } from './chat-navigation-flight.js';
import { createPresetApiSyncLifecycle } from './preset-api-sync-lifecycle/index.js';
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';
import { hasServerReturnedAfterRestart } from './server-restart-monitor.js';
import {
    PERSONA_APPENDICES_DEFAULT_SCOPE_KEY,
    PERSONA_APPENDICES_SELECTIONS_KEY,
} from './neconyan-conversation/constants.js';
import { conversationState } from './neconyan-conversation/state.js';
import { scheduleTimelineRender } from './neconyan-conversation/render-scheduler.js';
import {
    resolveCharacterBadgeMirrorPlan,
    resolveTopbarAdoptionPlan,
    TOPBAR_ADOPTED_MARKER_ATTRIBUTE,
    TOPBAR_ADOPTION_ATTRIBUTE,
    TOPBAR_EXTENSION_SLOT_ID,
} from './topbar-extension-slot/index.js';
import { power_user, setCharacterSpoilerFreeFieldsHidden } from './power-user.js';
import { escapeRegex } from './util/escape-regex.js';
import { hasChangedAttributeValue } from './util/attribute-mutations.js';
import { copyText, flashHighlight, showFontAwesomePicker } from './utils.js';
import { characters, chat, flushCharacterSaveDebounced, flushPendingChatSavesForNavigation, getChatGeneration, getCurrentChatId, getGeneratingModel, getOneCharacter, getShortModelName, getThumbnailUrl, is_send_press, parseAvatarSource, refreshCsrfToken, saveSettingsDebounced, scrollReopenedChatToBottom, selectCharacterById, selectRightMenuWithAnimation, this_chid } from '../script.js';
import { is_group_generating } from './group-chats.js';
import { eventSource, event_types } from './events.js';
import { extensionNames, findExtension, getExtensionManifest, getExtensionType } from './extensions.js';
import { getCurrentUserHandle } from './user.js';
import { getAssistantIconSrc } from './neconyan-assistant-art.js';
import { t, translate } from './i18n.js';
import {
    MODEL_FILTER_BOTH_VIEWPORTS_SELECTORS,
    MODEL_FILTER_PHONE_ONLY_SELECTORS,
    computeVisibleModelOptions,
} from './neconyan-model-filter.js';
import { getReasoningEffortShortLabel, isReasoningEffortSupported } from './neconyan-reasoning-effort.js';
import {
    mountNeconyanCharacterWorkspace,
    mountNeconyanLorebookWorkspace,
    mountNeconyanModelWorkspace,
} from './neconyan-native-workspaces.js';

const nnMobileShellLifecycle = createMobileShellLifecycle();
const nnPresetApiSyncLifecycle = createPresetApiSyncLifecycle();
const NN_SHELL_SUBTITLE_PLACEHOLDER = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';

const NN_STORAGE_KEYS = Object.freeze({
    leftTab: 'sb-left-tab',
    rightTab: 'sb-right-tab',
    leftShellSize: 'sb-left-shell-size',
    rightShellSize: 'sb-right-shell-size',
    desktopShellSnapToChatWidth: 'sb-desktop-shell-snap-to-chat-width',
    characterDrawerRightLocked: 'sb-character-drawer-right-locked',
    theme: 'sb-theme',
    kittyless: 'sb-kittyless',
    tourButtonsHidden: 'sb-tour-buttons-hidden',
    surfaceTransparency: 'sb-surface-transparency',
    topbarScaleDesktop: 'sb-topbar-scale-desktop',
    topbarScaleMobile: 'sb-topbar-scale-mobile',
    topbarLabelDesktopParts: 'sb-topbar-label-desktop-parts',
    topbarLabelMobilePart: 'sb-topbar-label-mobile-part',
    topbarLabelCustomText: 'sb-topbar-label-custom-text',
    topbarLabelClickCycle: 'sb-topbar-label-click-cycle',
    topbarLabelClickCycleDesktop: 'sb-topbar-label-click-cycle-desktop',
    topbarLabelClickCycleMobile: 'sb-topbar-label-click-cycle-mobile',
    chatbarVisible: 'sb-chatbar-visible',
    topbarOffset: 'sb-topbar-offset',
    settingsDrawerStatePrefix: 'sb-settings-inline-drawer',
    shortcutLeft: 'sb-shortcut-left',
    shortcutRight: 'sb-shortcut-right',
    shortcutSlot3: 'sb-shortcut-slot3',
    shortcutSlot4: 'sb-shortcut-slot4',
    shortcutSlot5: 'sb-shortcut-slot5',
    shortcutSlot6: 'sb-shortcut-slot6',
    bottomBarScale: 'sb-bottom-bar-scale',
    bottomChatSecondaryOpen: 'sb-bottom-chat-secondary-open',
    desktopButtonScale: 'sb-desktop-button-scale',
    mobileButtonScale: 'sb-mobile-button-scale',
    desktopNavLayout: 'sb-desktop-nav-layout',
    desktopNavIconOnly: 'sb-desktop-nav-icon-only',
    desktopNavShowCustomize: 'sb-desktop-nav-show-customize',
    desktopNavShowQuickActions: 'sb-desktop-nav-show-quick-actions',
    desktopNavReplaceQuickActions: 'sb-desktop-nav-replace-quick-actions',
    desktopNavReplacementTarget: 'sb-desktop-nav-replacement-target',
    desktopQuickActions: 'sb-desktop-quick-actions-v2',
    mobileNavLayout: 'sb-mobile-nav-layout',
    mobileNavIconOnly: 'sb-mobile-nav-icon-only',
    mobileNavShowCustomize: 'sb-mobile-nav-show-customize',
    mobileNavShowQuickActions: 'sb-mobile-nav-show-quick-actions',
    mobileNavReplaceQuickActions: 'sb-mobile-nav-replace-quick-actions',
    mobileNavReplacementTarget: 'sb-mobile-nav-replacement-target',
    mobileQuickActions: 'sb-mobile-quick-actions-v2',
    mobileQuickActionsLegacy: 'sb-mobile-quick-actions',
    settingsDrawerAutoClose: 'sb-settings-drawer-auto-close',
    compactMode: 'sb-compact-mode',
    // Legacy single-key form of the per-device pair below; kept as a read-only seed so a bar
    // configured before the split keeps its look on both devices.
    topbarIconsOnly: 'sb-topbar-icons-only',
    desktopTopbarIconsOnly: 'sb-desktop-topbar-icons-only',
    mobileTopbarIconsOnly: 'sb-mobile-topbar-icons-only',
    frontendIcon: 'sb-frontend-icon',
    characterEditorSubTab: 'sb-character-editor-sub-tab',
    bottomChatBarVisible: 'sb-bottom-chat-bar-visible',
    paperTextureEnabled: 'sb-paper-texture-enabled',
    paperTextureOpacity: 'sb-paper-texture-opacity',
});

const NN_SHORTCUT_TARGETS = Object.freeze([
    { value: 'left:presets', label: 'Presets', icon: 'fa-sliders' },
    { value: 'left:api', label: 'Connections', icon: 'fa-plug' },
    { value: 'left:sampling', label: 'Sampling', icon: 'fa-wave-square' },
    { value: 'left:advanced-formatting', label: 'Formatting', icon: 'fa-text-height' },
    { value: 'characters:world-info', label: 'Lorebooks', icon: 'fa-book-atlas' },
    { value: 'left:agents', label: 'Agents', icon: 'fa-cat' },
    { value: 'left:mewmory', label: 'Mewmory', icon: 'fa-brain' },
    { value: 'action:search', label: 'Search', icon: 'fa-magnifying-glass' },
    { value: 'right:settings', label: 'Settings', icon: 'fa-screwdriver-wrench' },
    { value: 'right:extensions', label: 'Extensions', icon: 'fa-cubes' },
    { value: 'characters:persona', label: 'Persona', icon: 'fa-face-smile' },
    { value: 'right:background', label: 'Background', icon: 'fa-panorama' },
    { value: 'none', label: 'None', icon: 'fa-circle-minus' },
]);

const NN_SHORTCUT_DEFAULTS = Object.freeze({
    left: 'left:agents',
    right: 'action:search',
    slot3: 'none',
    slot4: 'none',
    slot5: 'none',
    slot6: 'none',
});
const NN_SHORTCUT_SLOTS = Object.freeze(['left', 'right', 'slot3', 'slot4', 'slot5', 'slot6']);
const NN_SHORTCUT_DESKTOP_SLOTS = Object.freeze(['slot3', 'slot4', 'slot5', 'slot6']);
const NN_SHORTCUT_STORAGE_KEYS = Object.freeze({
    left: NN_STORAGE_KEYS.shortcutLeft,
    right: NN_STORAGE_KEYS.shortcutRight,
    slot3: NN_STORAGE_KEYS.shortcutSlot3,
    slot4: NN_STORAGE_KEYS.shortcutSlot4,
    slot5: NN_STORAGE_KEYS.shortcutSlot5,
    slot6: NN_STORAGE_KEYS.shortcutSlot6,
});
const NN_SHORTCUT_LABELS = Object.freeze({
    left: 'Left',
    right: 'Right',
    slot3: 'Slot 3 (Desktop)',
    slot4: 'Slot 4 (Desktop)',
    slot5: 'Slot 5 (Desktop)',
    slot6: 'Slot 6 (Desktop)',
});
const NN_PANEL_STYLESHEETS = Object.freeze({
    'characters:world-info': [
        { href: 'css/world-info.css?v=20261005-chat-styles1', id: 'deferred-world-info-css' },
    ],
    'characters:persona': [
        { href: 'css/personas.css?v=20260912h', id: 'deferred-personas-css' },
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'left:api': [
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'left:presets': [
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'left:sampling': [
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'left:advanced-formatting': [
        { href: 'css/macros.css', id: 'deferred-macros-css' },
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'left:mewmory': [
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'left:agents': [
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'right:extensions': [
        { href: 'css/extensions-panel.css?v=20260425a', id: 'deferred-extensions-panel-css' },
    ],
    'right:background': [
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'right:server': [
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'right:console-logs': [
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
    'right:included-tool': [
        { href: 'css/neconyan-tool-pages.css?v=20261003-notes-controls4', id: 'deferred-tool-pages-css' },
    ],
});
const NN_FRONTEND_ICON_DEFAULT = 'calico';
const NN_FRONTEND_ICONS = Object.freeze([
    {
        id: 'calico',
        label: 'Calico',
        description: 'Neconyan calico badge.',
        src: 'img/neconyan-icon-192.png',
    },
    { id: 'miso', label: 'Miso', description: 'Orange-and-black tiger.' },
    { id: 'taro', label: 'Taro', description: 'Blue-grey cat.' },
    { id: 'nori', label: 'Nori', description: 'Black-and-white tuxedo cat.' },
]);
const NN_ACCOUNT_STORAGE_READY_MARKER = '__migrated';
const NN_INLINE_DRAWER_CUSTOM_PERSISTENCE_SELECTOR = '.sb-openai-settings-drawer, .sb-openai-settings-subdrawer, [id$="prompt_manager_drawer"]';
const NN_STORAGE_PREFIX = 'sb-';
const NN_STORAGE_WRITE_DEBOUNCE_MS = 120;
const NN_MOBILE_ACTION_DEBOUNCE_MS = 140;
const NN_SHELL_FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

let nnInlineDrawerPersistenceObserver = null;
let nnInlineDrawerPersistenceQueued = false;
let nnChatScriptModulePromise = null;
let nnMainScriptModulePromise = null;
let nnComposerControlsObserver = null;
let nnComposerControlsSyncQueued = false;
let nnStorageFlushTimer = 0;
let nnStorageFlushEventsBound = false;
let nnMessageActionEventsBound = false;
let nnPendingBottomChatScrollCancel = null;
let nnSearchShortcutPreFocusAt = 0;
const nnStorageCache = new Map();
const nnStoragePendingWrites = new Map();
const NN_EXTENSION_ALIASES = {
};

function debounceAction(callback, wait = NN_MOBILE_ACTION_DEBOUNCE_MS) {
    let lastRun = 0;

    return function debouncedAction(event) {
        const now = performance.now();
        if (now - lastRun < wait) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            return;
        }

        lastRun = now;
        return callback.call(this, event);
    };
}

function getShortcutTarget(side) {
    const storageKey = NN_SHORTCUT_STORAGE_KEYS[side];
    const stored = migrateLegacyWorldInfoRoute(storageKey ? safeGetItem(storageKey) : null);
    const valid = NN_SHORTCUT_TARGETS.some(t => t.value === stored);
    return valid ? stored : NN_SHORTCUT_DEFAULTS[side] || 'none';
}

function getShortcutButtonId(side) {
    return `sb-shortcut-${side}`;
}

function getShortcutConfig(target) {
    return NN_SHORTCUT_TARGETS.find(t => t.value === target) || NN_SHORTCUT_TARGETS[0];
}

function migrateLegacyWorldInfoRoute(target) {
    // Neconyan: migrate saved pre-relocation World Info shortcuts to the
    // Characters panel tab instead of reviving the old left-shell route.
    return target === 'left:world-info' ? 'characters:world-info' : target;
}

function isSearchShortcutTarget(target) {
    return target === 'action:search';
}

function activateShortcutTarget(target) {
    if (isSearchShortcutTarget(target)) {
        const searchState = getUniversalSearchState();

        if (searchState.expanded) {
            if (performance.now() - nnSearchShortcutPreFocusAt < NN_MOBILE_ACTION_DEBOUNCE_MS * 2) {
                nnSearchShortcutPreFocusAt = 0;
                focusUniversalSearchInput(searchState.input);
                return;
            }

            setUniversalSearchOpenState(false);

            if (searchState.input instanceof HTMLInputElement && document.activeElement === searchState.input) {
                searchState.input.blur();
            }

            return;
        }

        closeAllDropdowns({ except: 'search' });
        setUniversalSearchOpenState(true, { focusInput: true });
        return;
    }

    const [shell, tab] = String(target).split(':');

    if (shell === 'characters') {
        if (!tab || tab === 'characters') {
            void setCharacterListEntityView('characters');
        }
        preloadPanelStylesheets('characters', tab);
        toggleShellPanel(shell, tab);
        return;
    }

    if (shell && tab) {
        toggleShellPanel(shell, tab);
    }
}

function isNeconyanStorageKey(key) {
    return typeof key === 'string' && key.startsWith(NN_STORAGE_PREFIX);
}

function scheduleNnStorageFlush() {
    if (nnStorageFlushTimer) {
        return;
    }

    nnStorageFlushTimer = window.setTimeout(flushNnStorageWrites, NN_STORAGE_WRITE_DEBOUNCE_MS);
}

function flushNnStorageWrites() {
    if (nnStorageFlushTimer) {
        window.clearTimeout(nnStorageFlushTimer);
        nnStorageFlushTimer = 0;
    }

    if (!nnStoragePendingWrites.size) {
        return;
    }

    const pendingWrites = Array.from(nnStoragePendingWrites.entries());

    for (const [key, write] of pendingWrites) {
        try {
            if (write?.remove) {
                localStorage.removeItem(key);
            } else {
                localStorage.setItem(key, write.value);
            }
            nnStoragePendingWrites.delete(key);
        } catch {
            // Retry on the next flush or page hide if browser storage becomes writable again.
        }
    }
}

function bindNnStorageFlushEvents() {
    if (nnStorageFlushEventsBound || typeof window === 'undefined') {
        return;
    }

    window.addEventListener('pagehide', flushNnStorageWrites);
    window.addEventListener('beforeunload', flushNnStorageWrites);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushNnStorageWrites();
        }
    });
    nnStorageFlushEventsBound = true;
}

function safeGetItem(key) {
    if (!isNeconyanStorageKey(key)) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    if (nnStorageCache.has(key)) {
        return nnStorageCache.get(key);
    }

    try {
        const value = localStorage.getItem(key);
        nnStorageCache.set(key, value);
        return value;
    } catch {
        return null;
    }
}

function safeSetItem(key, value) {
    if (!isNeconyanStorageKey(key)) {
        try { localStorage.setItem(key, value); } catch {
            // Ignore storage write failures.
        }
        return;
    }

    const stringValue = String(value);
    nnStorageCache.set(key, stringValue);
    nnStoragePendingWrites.set(key, { value: stringValue, remove: false });
    scheduleNnStorageFlush();
}

function safeRemoveItem(key) {
    if (!isNeconyanStorageKey(key)) {
        try { localStorage.removeItem(key); } catch {
            // Ignore storage removal failures.
        }
        return;
    }

    nnStorageCache.set(key, null);
    nnStoragePendingWrites.set(key, { remove: true });
    scheduleNnStorageFlush();
}

bindNnStorageFlushEvents();

const NN_IDLE_BRAND_LABEL = 'Neconyan';
const NN_MOBILE_MEDIA_QUERY = '(max-width: 768px)';
const NN_SURFACE_TRANSPARENCY = Object.freeze({
    min: 0,
    max: 100,
    step: 5,
    defaultValue: 0,
});
const NN_TOPBAR_SCALE = Object.freeze({
    min: 70,
    max: 150,
    step: 5,
    defaultValue: 100,
});
const NN_PAPER_TEXTURE_OPACITY = Object.freeze({
    min: 0,
    max: 100,
    step: 5,
    defaultValue: 20,
});
const NN_TOPBAR_LABEL_PARTS = Object.freeze([
    {
        id: 'ctx',
        label: 'Context Size',
        description: 'Show the current total Tokens value from the Prompt page.',
    },
    {
        id: 'char',
        label: 'Character Name',
        description: 'Show the active character name, or the group name while a group chat is open.',
    },
    {
        id: 'model',
        label: 'Current Model',
        description: 'Show the model selected in Connections. Uses the short name when Short Model Name is on in Visual Toggles.',
    },
    {
        id: 'custom',
        label: 'Custom Text',
        description: 'Show your own short label in the center of the top bar.',
    },
]);
const NN_TOPBAR_LABEL_PART_ORDER = Object.freeze(NN_TOPBAR_LABEL_PARTS.map(part => part.id));
const NN_TOPBAR_LABEL_PART_IDS = new Set(NN_TOPBAR_LABEL_PART_ORDER);
const NN_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH = 48;
const NN_TOPBAR_DRAG_X_RATIO = 0.36;
const NN_TOPBAR_DRAG_Y_RATIO = 0.24;
const NN_TOPBAR_CONTEXT_REFRESH_DEBOUNCE = 220;
const NN_CONSOLE_LOG_LIMIT = 260;
const NN_CONSOLE_LOG_REFRESH_MS = 2500;
const NN_CONSOLE_LOG_STICKY_THRESHOLD = 28;
const NN_CHATBAR_SEARCH_DEBOUNCE = 220;
const NN_CHAT_SEARCH_MARK_SELECTOR = 'mark[data-sb-chat-search="true"]';
const NN_DESKTOP_SHELL_LAYOUT = Object.freeze({
    minWidth: 600,
    maxWidth: 900,
    ratio: 0.55,
    laptopViewportMin: 1001,
    laptopViewportMax: 1440,
    laptopMinWidth: 680,
    laptopMaxWidth: 920,
    laptopRatio: 0.6,
    laptopGutter: 28,
    compactMaxWidth: 900,
    compactViewportWidth: 1100,
    compactGap: 20,
    gutterMin: 20,
    gutterRatio: 0.04,
    gutterMax: 80,
    fullWidthMaxHeight: 860,
});
const NN_DESKTOP_SHELL_RESIZE = Object.freeze({
    minWidth: 420,
    minHeight: 320,
    bottomGap: 16,
});
const NN_SHELL_TOGGLE_GUARD_MS = 260;
const NN_INIT_RETRY_DELAY_MS = 150;
const NN_INIT_MAX_RETRIES = 30;

const NN_SHELL_STYLE_STYLESHEET_VERSION = '20261005-chat-styles1';
const NN_THEMES = Object.freeze([
    {
        id: 'calico',
        label: 'Calico',
    },
    {
        id: 'kittyless',
        label: 'Kittyless',
    },
    {
        id: 'windows-aero',
        label: 'Windows Aero',
    },
    {
        id: 'windows-xp',
        label: 'Windows XP',
    },
    {
        id: 'windows-98',
        label: 'Windows 98',
    },
    {
        id: 'clean-minimal',
        label: 'Clean Minimal',
    },
    {
        id: 'macos-minimal',
        label: 'macOS Minimal',
    },
    {
        id: 'cozy-warm',
        label: 'Cozy Warm',
    },
    {
        id: 'hypr-glow',
        label: 'Hypr Glow',
    },
    {
        id: 'slate-flat',
        label: 'Slate Flat',
    },
]);

const NN_MESSAGE_STYLES = Object.freeze([
    { id: '0', label: 'Flat', icon: 'fa-grip-lines' },
    { id: '1', label: 'Bubbles', icon: 'fa-comment-dots' },
    { id: '2', label: 'Document', icon: 'fa-file-lines' },
]);

const NN_WORLD_INFO_SUBTITLE_HTML = 'Edit lorebooks for character cards here. Read the guide <a class="notes-link" href="https://docs.sillytavern.app/usage/core-concepts/worldinfo/" target="_blank" rel="noopener noreferrer">here</a>.';
const NN_SAMPLING_SUBTITLE_HTML = 'Adjust randomness, reply length and other generation settings.';

/*
 * The server owns the extension catalog. These entries only describe where a
 * native tool already exposes its existing launcher or settings drawer.
 */
const NECONYAN_NATIVE_TOOL_DEFINITIONS = Object.freeze([
    { id: 'third-party/Neconyan-Preset-Tools', label: 'Preset Tools', icon: 'fa-sliders', actions: ['open', 'settings'], open: 'presets' },
    { id: 'third-party/ChatCompletionTabs', label: 'Chat Completion Tabs', icon: 'fa-table-columns', actions: ['open', 'settings'], open: 'presets' },
    { id: 'third-party/sillytavern-character-colors', label: 'Dialogue Colors', icon: 'fa-palette', actions: ['settings'] },
    { id: 'third-party/Neconyan-Terminal-UI', label: 'Termeownal UI', icon: 'fa-terminal', actions: ['settings'] },
    { id: 'third-party/Neconyan-BotSearcher', label: 'BotSearcher', icon: 'fa-binoculars', actions: ['open', 'settings'], open: 'botsearcher' },
    { id: 'third-party/Neconyan-PromptTags', label: 'Prompt Tags', icon: 'fa-tags', actions: ['settings'] },
    { id: 'third-party/Neconyan-Regex-Agent-Themes', label: 'Regex Agent Themes', icon: 'fa-brush', actions: ['settings'] },
    { id: 'third-party/MacroEnhanced', label: 'Macro Enhanced', icon: 'fa-wand-magic-sparkles', actions: ['settings'] },
    { id: 'third-party/Neconyan-WorldInfo-Lab', label: 'World Info Lab', icon: 'fa-book-atlas', actions: ['open', 'settings'], open: 'world-info-lab' },
    { id: 'third-party/Neconyan-Prompting-Lab', label: 'Prompting Lab', icon: 'fa-flask', actions: ['open', 'settings'], open: 'prompting-lab' },
    { id: 'neconyan-debugger', label: 'Debugger', icon: 'fa-bug', actions: ['open', 'settings'], open: 'debugger' },
    { id: 'neconyan-chats-archive', label: 'Chat Archive', icon: 'fa-box-archive', actions: ['open'], open: 'chat-archive' },
    { id: 'css-snippets', label: 'CSS Snippets', icon: 'fa-list-check', actions: ['open'], open: 'css-snippets' },
    { id: 'third-party/Neconyan-Lorebook-Distiller', label: 'Lorebook Distiller', icon: 'fa-book-medical', actions: ['open'], open: 'distiller' },
    { id: 'third-party/Neconyan-Time-Machine', label: 'Card & Lorebook Time Machine', icon: 'fa-clock-rotate-left', actions: ['open', 'settings'], open: 'time-machine' },
    { id: 'third-party/Neconyan-Deep-Swipe', label: 'Deep Swipe', icon: 'fa-arrows-up-down', actions: ['settings'] },
    { id: 'third-party/Neconyan-Story-Mode', label: 'Story Mode', icon: 'fa-book-open', actions: ['open', 'settings'], open: 'story-mode' },
    { id: 'third-party/Neconyan-Hopper', label: 'Meower', icon: 'fa-paw', actions: ['open', 'settings'], open: 'meower' },
    // Pawthfinder is a settings section inside In-Chat Agents rather than its own
    // extension, so it is presented here and resolved by its settings unit.
    { id: 'pathfinder', label: 'Pawthfinder', icon: 'fa-diamond-turn-right', actions: ['settings'], unitOnly: true },
    { id: 'quick-image-gen', label: 'Quick Image Gen', icon: 'fa-image', actions: ['settings'] },
    { id: 'expressions', label: 'Character Expressions', icon: 'fa-masks-theater', actions: ['settings'] },
    { id: 'regex', label: 'Regexes', icon: 'fa-code', actions: ['settings'] },
]);

const nativeToolActionLabel = actionName => ({ open: t`Open`, settings: t`Settings`, manage: t`Manage extensions` })[actionName];

const NECONYAN_MODE_DEFINITIONS = Object.freeze([
    { id: 'roleplay', label: 'Roleplay', icon: 'fa-masks-theater' },
    { id: 'conversation', label: 'Conversation', icon: 'fa-comments' },
    { id: 'meower', label: 'Meower', icon: 'fa-paw', extension: 'third-party/Neconyan-Hopper' },
    { id: 'story', label: 'Story Mode', icon: 'fa-feather-pointed', extension: 'third-party/Neconyan-Story-Mode' },
]);
const NECONYAN_MODE_IDS = new Set(NECONYAN_MODE_DEFINITIONS.map(mode => mode.id));
let neconyanNativeToolsBound = false;
let neconyanNativeToolsRefreshFrame = 0;
const neconyanNativeToolOpenState = new Map();
const NECONYAN_INCLUDED_TOOL_STORAGE_KEY = 'NeconyanIncludedTool.v1';
let neconyanIncludedToolSelection = safeGetItem(NECONYAN_INCLUDED_TOOL_STORAGE_KEY) || '';
let neconyanIncludedToolRestore = null;
let neconyanModeTask = null;
let neconyanModeSyncFrame = 0;
let neconyanModeObserver = null;
let neconyanChatReopenFrame = 0;

function normalizeNeconyanMode(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'story-mode' ? 'story' : NECONYAN_MODE_IDS.has(normalized) ? normalized : '';
}

function getNeconyanModeDefinition(mode) {
    const normalizedMode = normalizeNeconyanMode(mode);
    return NECONYAN_MODE_DEFINITIONS.find(item => item.id === normalizedMode) || null;
}

export function getActualNeconyanMode() {
    const sheld = document.getElementById('sheld');
    if (document.body?.classList.contains('sbstory') || document.getElementById('sbstory-bar')?.hidden === false) {
        return 'story';
    }
    if (sheld?.dataset.sbtwMode === 'on') {
        return 'meower';
    }
    if (conversationState.conversationWorkspaceOpen || sheld?.dataset.sbConversationMode === 'on') {
        return 'conversation';
    }
    return 'roleplay';
}

function getNeconyanModeLifecycle(mode) {
    const normalizedMode = normalizeNeconyanMode(mode);
    return normalizedMode ? globalThis.NeconyanModeLifecycle?.[normalizedMode] || null : null;
}

export function isNeconyanModeBusy() {
    const lifecycles = Object.values(globalThis.NeconyanModeLifecycle || {});
    return Boolean(
        is_send_press
        || is_group_generating
        || conversationState.generationActive
        || conversationState.conversationReplyBusy
        || conversationState.conversationUploadActive
        || lifecycles.some(lifecycle => lifecycle?.isBusy?.()),
    );
}

function getActiveNeconyanAvatar() {
    return characters?.[this_chid]?.avatar || conversationState.conversationSelectedAvatar || '';
}

function getNeconyanModeContext() {
    return {
        account: getCurrentUserHandle(),
        chatId: getCurrentChatId(),
        generation: getChatGeneration(),
        characterId: this_chid,
        avatar: getActiveNeconyanAvatar(),
    };
}

function isNeconyanModeContextCurrent(expected) {
    if (!expected) {
        return true;
    }

    const current = getNeconyanModeContext();
    return current.account === expected.account
        && current.chatId === expected.chatId
        && current.generation === expected.generation
        && current.characterId === expected.characterId
        && current.avatar === expected.avatar;
}

function promptForNeconyanCharacter(mode) {
    const definition = getNeconyanModeDefinition(mode);
    if (!definition) {
        return false;
    }
    globalThis.toastr?.info?.(`Pick or create a character before opening ${definition.label}.`, definition.label);
    openCharacterPanelTab('characters');
    void focusNeconyanCharacterAction();
    return false;
}

function isNeconyanModeExtensionEnabled(definition) {
    if (!definition.extension) {
        return true;
    }

    const extension = findExtension(definition.extension);
    if (extension?.enabled) {
        return true;
    }

    globalThis.toastr?.info?.(`${definition.label} is unavailable until its extension is enabled.`, definition.label);
    void openNeconyanNativeExtensionSettings({ id: definition.extension, label: definition.label });
    return false;
}

function syncNeconyanModeControls() {
    const activeMode = getActualNeconyanMode();
    const definition = getNeconyanModeDefinition(activeMode);
    document.documentElement.dataset.neconyanChatMode = activeMode;
    if (document.body?.dataset.neconyanChatMode !== activeMode) {
        const previousMode = document.body.dataset.neconyanChatMode;
        document.body.dataset.neconyanChatMode = activeMode;
        if (previousMode) {
            queueReopenedChatBottomScroll();
        }
    }

    document.querySelectorAll('button[data-neconyan-chat-mode]').forEach(button => {
        if (!(button instanceof HTMLElement)) {
            return;
        }

        const buttonMode = normalizeNeconyanMode(button.dataset.neconyanChatMode);
        const buttonDefinition = getNeconyanModeDefinition(buttonMode);
        const isActive = buttonMode !== '' && buttonMode === activeMode;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
        button.title = buttonDefinition
            ? isActive ? t`${translate(definition.label)} is active` : t`Use ${translate(buttonDefinition.label)}`
            : t`Unavailable mode`;
    });

    document.querySelectorAll('#sb_character_mode_toggle [data-sb-character-mode]').forEach(button => {
        if (!(button instanceof HTMLElement)) {
            return;
        }

        const mode = button.dataset.sbCharacterMode === 'conversation' ? 'conversation' : 'roleplay';
        const isActive = mode === activeMode;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-checked', String(isActive));
    });
    document.getElementById('sbtw-launch-button')?.setAttribute('aria-pressed', String(activeMode === 'meower'));
    document.getElementById('sbstory-mode-button')?.setAttribute('aria-pressed', String(activeMode === 'story'));
    syncModeFavicon(activeMode);
    syncTopbarEditCardButton();
}

const NN_MEOWER_FAVICON_SRC = '/img/neconyan-paw-192.png';

/* Meower shows a paw in the browser tab; every other mode keeps the chosen frontend icon.
   Written straight to the <link> tags because the icon controller skips the swap when its id is unchanged. */
function syncModeFavicon(activeMode) {
    const href = activeMode === 'meower' ? NN_MEOWER_FAVICON_SRC : getFrontendIconSrc(nnState.frontendIcon);
    const resolvedHref = new URL(href, document.baseURI).href;
    for (const link of document.querySelectorAll('link[rel~="icon"]')) {
        if (link.href !== resolvedHref) {
            link.setAttribute('href', href);
            link.setAttribute('type', 'image/png');
        }
    }
}

function queueNeconyanModeSync() {
    if (neconyanModeSyncFrame) {
        return;
    }

    neconyanModeSyncFrame = window.requestAnimationFrame(() => {
        neconyanModeSyncFrame = 0;
        syncNeconyanModeControls();
    });
}

function queueReopenedChatBottomScroll() {
    if (neconyanChatReopenFrame || document.hidden) {
        return;
    }

    neconyanChatReopenFrame = window.requestAnimationFrame(() => {
        neconyanChatReopenFrame = 0;
        if (document.hidden || document.body.classList.contains('neconyan-home-visible')) {
            return;
        }

        const mode = getActualNeconyanMode();
        if (mode === 'conversation') {
            conversationState.timelineBottomScrollPending = true;
            scheduleTimelineRender();
        } else if (mode === 'roleplay') {
            void scrollReopenedChatToBottom().catch(error => console.error('Could not scroll the reopened chat.', error));
        }
    });
}

async function closeActiveNeconyanMode(targetMode, expectedContext, { presentationOnly = false, navigationGuard = () => true } = {}) {
    if (!isNeconyanModeContextCurrent(expectedContext)) {
        return false;
    }
    const activeMode = getActualNeconyanMode();
    if (activeMode === targetMode || activeMode === 'roleplay') {
        return true;
    }

    if (activeMode === 'conversation') {
        const conversationModule = await import('./neconyan-conversation.js');
        if (!isNeconyanModeContextCurrent(expectedContext)) {
            return false;
        }
        const disabled = await conversationModule.disableConversationModeForCurrentCharacter?.({ focusRoleplay: false });
        return disabled !== false && isNeconyanModeContextCurrent(expectedContext);
    }

    if (activeMode === 'story') {
        const lifecycle = getNeconyanModeLifecycle('story');
        try {
            if (typeof lifecycle?.setEnabled !== 'function') {
                globalThis.toastr?.warning?.('Story Mode could not be closed right now.', 'Story Mode');
                return false;
            }
            const closed = (await lifecycle.setEnabled(false, { presentationOnly, navigationGuard })) !== false;
            return closed && isNeconyanModeContextCurrent(expectedContext);
        } catch (error) {
            console.error('Could not close Story Mode.', error);
            globalThis.toastr?.error?.('Story Mode could not be closed. Try again after the current save finishes.', 'Story Mode');
            return false;
        }
    }

    if (activeMode === 'meower') {
        const lifecycle = getNeconyanModeLifecycle('meower');
        try {
            if (typeof lifecycle?.close !== 'function') {
                globalThis.toastr?.warning?.('Meower could not be closed right now.', 'Meower');
                return false;
            }
            const closed = (await lifecycle.close()) !== false;
            return closed && isNeconyanModeContextCurrent(expectedContext);
        } catch (error) {
            console.error('Could not close Meower.', error);
            globalThis.toastr?.error?.('Meower could not save before switching modes. Try again.', 'Meower');
            return false;
        }
    }

    return true;
}

async function activateNeconyanMode(mode) {
    const targetMode = normalizeNeconyanMode(mode);
    if (!targetMode) {
        globalThis.toastr?.warning?.('That Neconyan mode is unavailable.', 'Modes');
        return false;
    }
    if (neconyanModeTask) {
        globalThis.toastr?.info?.('A mode change is still in progress. Try again in a moment.', 'Modes');
        return false;
    }

    const task = (async () => {
        const definition = getNeconyanModeDefinition(targetMode);
        const expectedContext = getNeconyanModeContext();
        if (targetMode === 'roleplay' && !hasActiveCharacterChat() && !getActiveNeconyanAvatar()) {
            return promptForNeconyanCharacter(targetMode);
        }
        if (getActualNeconyanMode() === targetMode) {
            globalThis.NeconyanWelcome?.concealHome?.();
            globalThis.document?.body?.classList.remove('neconyan-home-visible');
            closeWorkspace();
            closeMobileNav();
            syncNeconyanModeControls();
            queueReopenedChatBottomScroll();
            return true;
        }

        if (!isNeconyanModeExtensionEnabled(definition)) {
            return false;
        }

        const avatar = targetMode === 'roleplay' ? '' : getActiveNeconyanAvatar();
        if (targetMode === 'story' && !getCurrentChatId() && !chat.length) {
            globalThis.toastr?.info?.('Open or start a chat before using Story Mode.', 'Story Mode');
            return false;
        }

        if (isNeconyanModeBusy()) {
            globalThis.toastr?.info?.(`Let the current reply finish before switching to ${definition.label}.`, definition.label);
            return false;
        }

        // Respond to this selection now. A drawer reopened during asynchronous activation
        // belongs to a newer user action and must not be closed when activation finishes.
        closeWorkspace();
        closeMobileNav();

        if (targetMode === 'roleplay' && getActualNeconyanMode() === 'conversation') {
            // Conversation hands its character back to Roleplay: close the workspace and select
            // that character so its latest roleplay chat loads. The generic close path bails out
            // because the teardown itself clears the conversation avatar it compares against.
            const conversationModule = await import('./neconyan-conversation.js');
            const returnAvatar = conversationModule.getRoleplayAvatarForWelcome?.() || expectedContext?.avatar || '';
            await conversationModule.disableConversationModeForCurrentCharacter?.({ focusRoleplay: false });
            const index = Array.isArray(characters) ? characters.findIndex(character => character?.avatar === returnAvatar) : -1;
            if (index >= 0 && String(this_chid) !== String(index)) {
                await selectCharacterById(index);
            }
            globalThis.NeconyanWelcome?.concealHome?.();
            globalThis.document?.body?.classList.remove('neconyan-home-visible');
            document.getElementById('send_textarea')?.focus?.({ preventScroll: false });
            queueNeconyanModeSync();
            return true;
        }

        if (!await closeActiveNeconyanMode(targetMode, expectedContext)) {
            return false;
        }

        if (!isNeconyanModeContextCurrent(expectedContext)) {
            globalThis.toastr?.info?.('Mode switching paused because the active chat changed.', 'Modes');
            return false;
        }

        let activated = false;
        if (targetMode === 'roleplay') {
            document.getElementById('send_textarea')?.focus?.({ preventScroll: false });
            activated = true;
        } else if (targetMode === 'conversation') {
            const conversationModule = await import('./neconyan-conversation.js');
            if (!isNeconyanModeContextCurrent(expectedContext)) {
                return false;
            }
            if (avatar) {
                activated = Boolean(conversationModule.openConversationWorkspaceForAvatar?.(avatar, {
                    showToast: false,
                }));
                if (!activated) {
                    globalThis.toastr?.warning?.('Conversation Mode needs an active character chat.', 'Conversation');
                }
            } else {
                // No character picked yet: let the module choose a default or show its empty screen.
                activated = Boolean(conversationModule.openConversationWorkspaceFromWelcome?.());
            }
        } else if (targetMode === 'meower') {
            const lifecycle = getNeconyanModeLifecycle('meower');
            if (typeof lifecycle?.open === 'function' && isNeconyanModeContextCurrent(expectedContext)) {
                activated = (await lifecycle.open()) !== false && isNeconyanModeContextCurrent(expectedContext);
            }
            if (!activated) {
                globalThis.toastr?.warning?.('Meower could not be opened. Check its extension settings and try again.', 'Meower');
            }
        } else if (targetMode === 'story') {
            const lifecycle = getNeconyanModeLifecycle('story');
            if (typeof lifecycle?.setEnabled === 'function' && isNeconyanModeContextCurrent(expectedContext)) {
                activated = (await lifecycle.setEnabled(true)) !== false && isNeconyanModeContextCurrent(expectedContext);
            }
            if (!activated) {
                globalThis.toastr?.warning?.('Story Mode could not be opened. Check its extension settings and try again.', 'Story Mode');
            }
        }

        if (activated) {
            globalThis.NeconyanWelcome?.concealHome?.();
            globalThis.document?.body?.classList.remove('neconyan-home-visible');
            queueNeconyanModeSync();
        }
        return activated;
    })();

    neconyanModeTask = task;
    try {
        return await task;
    } finally {
        if (neconyanModeTask === task) {
            neconyanModeTask = null;
        }
        queueNeconyanModeSync();
    }
}

function createNeconyanModeButton(mode, mobile = false) {
    const definition = getNeconyanModeDefinition(mode);
    const button = createElement('button', {
        className: mobile ? 'sb-nav-item neconyan-mode-button' : 'neconyan-mode-button',
        attrs: {
            type: 'button',
            'data-neconyan-chat-mode': definition.id,
            'aria-pressed': String(getActualNeconyanMode() === definition.id),
            'aria-label': definition.label,
            title: t`Use ${translate(definition.label)}`,
        },
    });
    button.append(
        createElement('i', { className: `fa-solid ${definition.icon}`, attrs: { 'aria-hidden': 'true' } }),
        createElement('span', { text: definition.label }),
    );
    button.addEventListener('click', () => {
        void activateNeconyanMode(definition.id);
    });
    return button;
}

function bindNeconyanModeStateEvents() {
    if (neconyanModeObserver) {
        return;
    }

    for (const eventName of ['sb:conversation-workspace-state-changed', 'neconyan:hopper-state-changed', 'neconyan:story-state-changed', 'sb:close-conversation-workspace', 'neconyan:open-story']) {
        window.addEventListener(eventName, queueNeconyanModeSync);
    }
    window.addEventListener('sb:activate-neconyan-mode', event => {
        const requestedMode = event instanceof CustomEvent ? event.detail?.mode : '';
        void activateNeconyanMode(requestedMode);
    });
    window.addEventListener('neconyan:home-hidden', queueReopenedChatBottomScroll);

    if (document.body instanceof HTMLElement && typeof MutationObserver !== 'undefined') {
        neconyanModeObserver = new MutationObserver(records => {
            if (hasChangedAttributeValue(records)) {
                queueNeconyanModeSync();
            }
        });
        neconyanModeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'data-generating'],
            attributeOldValue: true,
            subtree: true,
        });
    } else {
        neconyanModeObserver = {};
    }
    syncNeconyanModeControls();
}

const NN_CHARACTER_TAB_COPY = Object.freeze({
    characters: {
        title: 'Characters',
        subtitle: 'Choose a character and start a little chat.',
        description: 'Move between characters, groups, personas, lore, and imports without leaving the writing workspace.',
    },
    groups: {
        title: 'Groups',
        subtitle: 'View or create group chats here for your roleplays and chats!',
        description: 'Sort group chats, check members, and return to character cards without losing your place.',
    },
    conversation: {
        title: 'Conversation Mode',
        subtitle: NN_SHELL_SUBTITLE_PLACEHOLDER,
        description: 'Tune schedules, cooldowns, format prompts, and DM helpers without opening a group chat.',
    },
    editor: {
        title: 'Editor',
        subtitle: 'Edit character cards and group chats here.',
        description: 'Keep identity, definitions, greetings, and metadata in separate sections.',
    },
    'world-info': {
        title: 'Lorebooks',
        subtitle: NN_WORLD_INFO_SUBTITLE_HTML,
        subtitleIsHtml: true,
        description: 'Create, edit, import, and activate lorebook entries without leaving Characters.',
    },
    persona: {
        title: 'Persona',
        subtitle: 'Edit your own persona here for roleplay and chats!',
        description: 'Edit persona details, locks, and defaults in the same flow as your character work.',
    },
    import: {
        title: 'Import',
        subtitle: 'Directly import character cards here from various sources.',
        description: 'PNG, JSON, YAML, CHARX, BYAF, and supported URL imports stay one tab away.',
    },
});

const NN_CHARACTER_EDITOR_SUB_TABS = Object.freeze([
    'char-info',
    'definitions',
    'greetings',
    'metadata',
]);
const NN_CHARACTER_EDITOR_DEFAULT_SUB_TAB = 'char-info';
const NN_CHARACTER_EDITOR_SPOILER_FREE_VISIBLE_TABS = Object.freeze(['char-info', 'metadata']);

const NN_CHARACTER_PANEL_TABS = Object.freeze([
    { id: 'characters', label: 'Characters', icon: 'fa-address-book' },
    { id: 'groups', label: 'Groups', icon: 'fa-users' },
    { id: 'editor', label: 'Editor', icon: 'fa-pen-to-square' },
    { id: 'world-info', label: 'Lorebooks', icon: 'fa-book-atlas' },
    { id: 'persona', label: 'Persona', icon: 'fa-face-smile' },
    { id: 'import', label: 'Import', icon: 'fa-file-import' },
]);
const NN_CHARACTER_PANEL_DEFAULT_TAB = 'characters';

const NN_PERSONA_HELP_LINK_HTML = '<a class="notes-link sb-character-title-help" href="https://docs.sillytavern.app/usage/core-concepts/personas/" target="_blank"><span class="fa-solid fa-circle-question note-link-span"></span></a>';

const NN_SHELLS = Object.freeze({
    left: {
        rootPanelId: 'left-nav-panel',
        hostDrawerId: 'ai-config-button',
        hostToggleSelector: '#ai-config-button > .drawer-toggle',
        hostIconSelector: '#leftNavDrawerIcon',
        proxyButtonId: 'sb-left-shell-toggle',
        proxyIcon: 'fa-bars',
        proxyLabel: 'Connections',
        title: 'Connections',
        subtitle: '', // Removed redundant workspace subtext (PR #145 expansion)
        searchPlaceholder: 'Find presets, connections, samplers, lore, or tools...',
        storageKey: NN_STORAGE_KEYS.leftTab,
        defaultTabId: 'api',
        baseTab: {
            id: 'presets',
            label: 'Presets',
            icon: 'fa-sliders',
            description: 'Save or load the settings used to write replies.',
        },
        embeddedTabs: [
            {
                id: 'api',
                drawerId: 'sys-settings-button',
                label: 'Connections',
                icon: 'fa-plug',
                description: 'Connect a model provider and choose the backend used for replies.',
            },
            {
                id: 'advanced-formatting',
                drawerId: 'advanced-formatting-button',
                label: 'Formatting',
                icon: 'fa-text-height',
                description: 'Change Text Completion templates and system prompts here!',
            },
        ],
        customTabs: [
            {
                id: 'sampling',
                label: 'Sampling',
                icon: 'fa-wave-square',
                description: NN_SAMPLING_SUBTITLE_HTML,
                descriptionIsHtml: true,
                searchPlaceholder: 'Search temperature, top p, repetition penalty, or backend samplers',
                searchExamples: ['temperature', 'top p', 'repetition penalty'],
            },
            {
                id: 'agents',
                label: 'Agents',
                icon: 'fa-cat',
                description: 'Enable, disable, or modify in-chat agents here. Can be configured as pre-gen, sidecar, or post-gen.',
            },
            {
                id: 'mewmory',
                label: 'Mewmory',
                icon: 'fa-brain',
                description: 'RAG and LLM-empowered native memory system for Neconyan~',
            },
        ],
    },
    right: {
        rootPanelId: 'user-settings-block',
        hostDrawerId: 'user-settings-button',
        hostToggleSelector: '#user-settings-button > .drawer-toggle',
        hostIconSelector: '#user-settings-button > .drawer-toggle .drawer-icon',
        proxyButtonId: 'sb-right-shell-toggle',
        proxyIcon: 'fa-gear',
        proxyLabel: 'Settings',
        title: 'Settings',
        subtitle: 'Personalize your settings, add/remove extensions, modify server settings, or check logs here.',
        searchPlaceholder: 'Search themes, top bar, backgrounds, or extensions',
        searchExamples: ['theme', 'top bar', 'Appearance', 'notify extension updates'],
        storageKey: NN_STORAGE_KEYS.rightTab,
        defaultTabId: 'settings',
        baseTab: {
            id: 'settings',
            label: 'Settings',
            icon: 'fa-screwdriver-wrench',
            description: 'Modify and customise Neconyan\'s general appearance and configuration here.',
            searchPlaceholder: 'Search Appearance, top bar, chat style, blur, or update notices',
            searchExamples: ['theme', 'top bar', 'Appearance', 'notify extension updates'],
        },
        embeddedTabs: [
            {
                id: 'extensions',
                drawerId: 'extensions-settings-button',
                label: 'Extensions',
                icon: 'fa-cubes',
                description: 'Find an extension, then adjust its settings.',
                searchPlaceholder: 'Search themes, Quick Reply, Dialogue Colors, or Image Gen',
                searchExamples: ['themes', 'Quick Reply', 'Dialogue Colors', 'Image Gen'],
            },
            {
                id: 'background',
                drawerId: 'backgrounds-button',
                label: 'Background',
                icon: 'fa-panorama',
                description: 'Change the appearance of the background surrounding your chats here!',
                searchPlaceholder: 'Search background names, blur, fit, or vibe words',
                searchExamples: ['cozy', 'landscape', 'blur', 'fit'],
            },
        ],
        customTabs: [
            {
                id: 'server',
                label: 'Server',
                icon: 'fa-server',
                description: 'See runtime status, updates, and server controls.',
                searchPlaceholder: 'Search update, restart, config.yaml, or branch',
                searchExamples: ['update', 'restart', 'config.yaml', 'branch'],
            },
            {
                id: 'console-logs',
                label: 'Console Logs',
                icon: 'fa-terminal',
                description: 'View Neconyan logs for easy troubleshooting here.',
                searchPlaceholder: 'Search error, warning, npm, bun, or extension logs',
                searchExamples: ['error', 'warning', 'npm', 'bun'],
            },
            {
                id: 'included-tool',
                label: 'Included Tool',
                icon: 'fa-puzzle-piece',
                description: 'Open one included tool in its own workspace.',
            },
        ],
    },
});

function renderShellSubtitle(target, subtitle, { isHtml = false } = {}) {
    if (!(target instanceof HTMLElement)) {
        return;
    }

    target.textContent = '';
    if (isHtml) {
        target.insertAdjacentHTML('beforeend', subtitle || '');
        // Subtitles render single-line with text-overflow: ellipsis; expose the
        // full text as a tooltip so truncated copy stays readable.
        target.title = target.textContent.trim();
        return;
    }

    target.textContent = subtitle || '';
    target.title = (subtitle || '').trim();
}

const NN_DRAWER_ROUTES = Object.freeze({
    'user-settings-button': { shell: 'right', tab: 'settings' },
    'sys-settings-button': { shell: 'left', tab: 'api' },
    'advanced-formatting-button': { shell: 'left', tab: 'advanced-formatting' },
    'WI-SP-button': { shell: 'characters', tab: 'world-info' },
    'extensions-settings-button': { shell: 'right', tab: 'extensions' },
    'persona-management-button': { shell: 'characters', tab: 'persona' },
    'backgrounds-button': { shell: 'right', tab: 'background' },
});

const NN_SEARCH_TARGET_SELECTOR = [
    'label',
    '.checkbox_label',
    '.menu_button',
    '.inline-drawer-toggle',
    '.standoutHeader',
    '.range-block-title',
    '.range-block-header',
    '.extension_name',
    'h3',
    'h4',
    'h5',
    'strong',
    '.bg-header-row-1',
    '.bg-header-row-2',
    '.ch_name',
    'select[title]',
].join(', ');

// The global search skips these rows: they wrap several unrelated controls, so their text
// reads as one long jumble. The controls inside are indexed on their own.
const NN_SEARCH_JUMBLED_ROW_SELECTOR = '.bg-header-row-1, .bg-header-row-2';
// Sliders such as Temperature are named only by their aria-label.
const NN_SEARCH_READABLE_TARGET_SELECTOR = `${NN_SEARCH_TARGET_SELECTOR}, input[type="range"][aria-label]`;
// Blocks shown only for one provider or backend. When hidden, their fields cannot be reached.
const NN_SEARCH_SOURCE_GATED_SELECTOR = '[data-source], [data-tg-type], [data-tg-samplers], [id$="_api"]';
// Elements that head a section, so a result for them is a result for the whole section.
const NN_SEARCH_SECTION_HEADING_SELECTOR = '.inline-drawer-toggle, .standoutHeader, .extension_name, h3, h4, h5, summary';

const NN_ADVANCED_SEARCH_ROUTES = new Set([
    'left:sampling',
    'left:advanced-formatting',
    'left:agents',
    'right:server',
    'right:console-logs',
    'characters:editor',
    'characters:world-info',
    'characters:import',
]);

const NN_UNIVERSAL_SEARCH_PLACEHOLDER = 'Search pages and settings...';
const NN_UNIVERSAL_SEARCH_IDLE_TITLE = 'Search pages and settings';
const NN_UNIVERSAL_SEARCH_IDLE_HINT = 'Type a page or a setting name, such as Sampling, Temperature or Hide cats.';
const NN_UNIVERSAL_SEARCH_EMPTY_HINT = 'Try the name of a page, such as Connections, or a shorter word from the setting.';
const NN_UNIVERSAL_SEARCH_RESULT_LIMIT = 12;
const NN_UNIVERSAL_SEARCH_PAGE_LIMIT = 3;

// Every page in the workspace rail, so searching a page name opens that page instead of listing
// the buttons inside it. Keywords are the other words people use for the same page.
const NN_SEARCH_PAGES = Object.freeze([
    { route: 'home', label: 'Home', description: 'Recent chats, characters and quick starts.', keywords: ['start', 'dashboard', 'welcome'] },
    { route: 'new-chat', label: 'New chat', description: 'Start a fresh chat.', keywords: ['temporary chat', 'start chat'] },
    { route: 'characters', label: 'Characters', description: 'Browse, create and import characters.', keywords: ['bots', 'character cards', 'groups'], covers: ['characters::characters::characters'] },
    { route: 'model', label: 'Connections', description: 'Choose the service, API key and model that write the replies.', keywords: ['api', 'api key', 'provider', 'model', 'backend', 'connect', 'proxy', 'endpoint', 'connection profiles'] },
    { route: 'agents', label: 'Agents', description: 'Helpers that run alongside your chats.', keywords: ['in-chat agents', 'companion agents'] },
    { route: 'mewmory', label: 'Mewmory', description: 'Long-term memory for Roleplay chats.', keywords: ['memory', 'memories', 'remember', 'recall', 'pawspective', 'summary'] },
    { route: 'lorebooks', label: 'Lorebooks', description: 'World info entries the model reads when they come up.', keywords: ['world info', 'lore', 'worldbook'], covers: ['characters::characters::world-info'] },
    { route: 'extensions', label: 'Extensions', description: 'Turn tools on and off, and install new ones.', keywords: ['plugins', 'add-ons', 'install extension', 'manage extensions'] },
    { route: 'presets', label: 'Presets', description: 'Saved bundles of prompts and reply settings.', keywords: ['prompt manager', 'chat completion preset'] },
    { route: 'sampling', label: 'Sampling', description: 'How the model picks its words: temperature, penalties and more.', keywords: ['temperature', 'top p', 'top k', 'penalty', 'samplers', 'seed', 'logit bias'] },
    { route: 'formatting', label: 'Formatting', description: 'Templates and system prompts sent to the model.', keywords: ['advanced formatting', 'context template', 'instruct', 'system prompt', 'tokenizer'] },
    { route: 'regex', label: 'Regexes', description: 'Find-and-replace rules for messages and prompts.', keywords: ['regex', 'find and replace', 'scripts'] },
    { route: 'expressions', label: 'Character Expressions', description: 'Character pictures that change with the mood of each reply.', keywords: ['sprites', 'emotions', 'classifier'] },
    { route: 'persona', label: 'Persona', description: 'The character you play.', keywords: ['personas', 'user name', 'my character', 'avatar'], covers: ['characters::characters::persona'] },
    { route: 'pathfinder', label: 'Pawthfinder', description: 'Lets the model choose which lorebook entries matter for each reply.', keywords: ['pathfinder', 'lorebook search'] },
    { route: 'dialogue-colors', label: 'Dialogue Colors', description: 'Give every speaker their own colour.', keywords: ['dialogue colours', 'colours', 'colors', 'speaker colours', 'character colors'] },
    { route: 'quick-image-gen', label: 'Quick Image Gen', description: 'Make pictures of characters and scenes.', keywords: ['image generation', 'images', 'pictures', 'art'] },
    { route: 'background', label: 'Background', description: 'The picture or video behind your chats.', keywords: ['backgrounds', 'wallpaper', 'animated background', 'video'] },
    { route: 'settings', label: 'Settings', description: 'Appearance, chat behaviour and interface options.', keywords: ['preferences', 'options', 'theme', 'shell style', 'appearance'] },
    { route: 'server', label: 'Server', description: 'Status, updates, restarts and config.yaml.', keywords: ['update', 'restart', 'config', 'version', 'branch'] },
    { route: 'console-logs', label: 'Console Logs', description: 'Live server logs for troubleshooting.', keywords: ['logs', 'debug', 'errors', 'console'] },
    { route: 'report-issue', label: 'Report an Issue', description: 'Opens the Neconyan GitHub issues page in a new tab.', keywords: ['bug', 'issue', 'github', 'feedback'] },
].map(page => Object.freeze(page)));
const NN_MOBILE_QUICK_ACTION_LIMIT = nnMobileShellLifecycle.railModel.limits.quickActionLimit;
const NN_MOBILE_QUICK_ACTION_ICON_FALLBACK = nnMobileShellLifecycle.railModel.limits.iconFallback;
let nnIsSyncingRailActions = false;
const NN_MOBILE_NAV_CLOSED_ICON = 'fa-compass';
const NN_NECONYAN_MOBILE_NAV_CLOSED_ICON = 'fa-bars';
const NN_MOBILE_VIEWPORT_RESET_FOLLOWUP_MS = 350;

const NN_MOBILE_DEFAULT_QUICK_ACTIONS = Object.freeze([
    { type: 'tab', shellKey: 'left', tabId: 'presets', icon: 'fa-sliders', label: 'Presets' },
    { type: 'tab', shellKey: 'left', tabId: 'api', icon: 'fa-plug', label: 'Connections' },
    { type: 'tab', shellKey: 'left', tabId: 'sampling', icon: 'fa-wave-square', label: 'Sampling' },
    { type: 'tab', shellKey: 'left', tabId: 'advanced-formatting', icon: 'fa-text-height', label: 'Formatting' },
    { type: 'tab', shellKey: 'characters', tabId: 'world-info', icon: 'fa-book-atlas', label: 'Lorebooks' },
    { type: 'tab', shellKey: 'left', tabId: 'agents', icon: 'fa-cat', label: 'Agents' },
]);
const NN_DESKTOP_DEFAULT_QUICK_ACTIONS = Object.freeze([
    { type: 'tab', shellKey: 'characters', tabId: 'world-info', icon: 'fa-book-atlas', label: 'Lorebooks' },
]);
const NN_MOBILE_NAV_PAGE_TARGET_DEFAULT = 'left:api';
const NN_MOBILE_NAV_PAGE_TARGETS = Object.freeze([
    { value: 'left:presets', shellKey: 'left', tabId: 'presets', label: 'Presets', icon: 'fa-sliders' },
    { value: 'left:api', shellKey: 'left', tabId: 'api', label: 'Connections', icon: 'fa-plug' },
    { value: 'left:sampling', shellKey: 'left', tabId: 'sampling', label: 'Sampling', icon: 'fa-wave-square' },
    { value: 'left:advanced-formatting', shellKey: 'left', tabId: 'advanced-formatting', label: 'Formatting', icon: 'fa-text-height' },
    { value: 'characters:world-info', shellKey: 'characters', tabId: 'world-info', label: 'Lorebooks', icon: 'fa-book-atlas' },
    { value: 'left:agents', shellKey: 'left', tabId: 'agents', label: 'Agents', icon: 'fa-cat' },
    { value: 'right:settings', shellKey: 'right', tabId: 'settings', label: 'Settings', icon: 'fa-screwdriver-wrench' },
    { value: 'right:extensions', shellKey: 'right', tabId: 'extensions', label: 'Extensions', icon: 'fa-cubes' },
    { value: 'right:background', shellKey: 'right', tabId: 'background', label: 'Background', icon: 'fa-panorama' },
    { value: 'right:server', shellKey: 'right', tabId: 'server', label: 'Server', icon: 'fa-server' },
    { value: 'right:console-logs', shellKey: 'right', tabId: 'console-logs', label: 'Console Logs', icon: 'fa-terminal' },
]);

// Neconyan: the optional icons-only top bar does not pool every page into one strip. It expands
// each section in place into that section's own pages, so the bar keeps the skeleton PRODUCT.md
// prescribes and each cluster stays readable as its own zone. Labels and icons resolve from
// NN_SHELLS / NN_CHARACTER_PANEL_TABS at build time so a cluster cannot drift when a page is
// renamed. Kept separate from NN_SHORTCUT_TARGETS and NN_MOBILE_NAV_PAGE_TARGETS because those two
// are persisted in user settings and carry pseudo-entries these lists must not inherit.
const NN_TOPBAR_CLUSTERS = Object.freeze([
    {
        key: 'workspace',
        leadId: 'sb-left-shell-toggle',
        railId: 'sb-topbar-cluster-workspace',
        pages: Object.freeze([
            { value: 'left:presets', shellKey: 'left', tabId: 'presets' },
            { value: 'left:api', shellKey: 'left', tabId: 'api' },
            { value: 'left:sampling', shellKey: 'left', tabId: 'sampling' },
            { value: 'left:advanced-formatting', shellKey: 'left', tabId: 'advanced-formatting' },
            { value: 'left:agents', shellKey: 'left', tabId: 'agents' },
        ]),
    },
    {
        key: 'customize',
        leadId: 'sb-right-shell-toggle',
        railId: 'sb-topbar-cluster-customize',
        pages: Object.freeze([
            { value: 'right:settings', shellKey: 'right', tabId: 'settings' },
            { value: 'right:extensions', shellKey: 'right', tabId: 'extensions' },
            { value: 'right:background', shellKey: 'right', tabId: 'background' },
            { value: 'right:server', shellKey: 'right', tabId: 'server' },
            { value: 'right:console-logs', shellKey: 'right', tabId: 'console-logs' },
        ]),
    },
    {
        key: 'characters',
        leadId: 'sb-character-toggle',
        railId: 'sb-topbar-cluster-characters',
        pages: Object.freeze([
            { value: 'characters:groups', shellKey: 'characters', tabId: 'groups' },
            { value: 'characters:editor', shellKey: 'characters', tabId: 'editor' },
            { value: 'characters:world-info', shellKey: 'characters', tabId: 'world-info' },
            { value: 'characters:persona', shellKey: 'characters', tabId: 'persona' },
            { value: 'characters:import', shellKey: 'characters', tabId: 'import' },
        ]),
    },
]);
const NN_TOPBAR_PAGE_TARGETS = Object.freeze(NN_TOPBAR_CLUSTERS.flatMap(cluster => cluster.pages));

// Neconyan: Home and Characters remain as Layer 2 anchors. Workspace and Customize are redundant
// once all of their pages are shown, so CSS hides those two only while icons-only mode is active.
const NN_TOPBAR_ANCHOR_IDS = Object.freeze([
    'sb-home-toggle',
    'sb-character-toggle',
]);
const NN_TOPBAR_BRAND_MIN_WIDTH = 60;

// The per-device key wins; the legacy single key seeds both sides of the split so a bar
// configured before it keeps its look everywhere until a device is set on its own.
function readTopbarIconsOnlySetting(storageKey) {
    return normalizeStoredBoolean(
        safeGetItem(storageKey),
        normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.topbarIconsOnly), false),
    );
}

const nnState = {
    initialized: false,
    initRetryTimer: 0,
    initRetryCount: 0,
    initObserver: null,
    landingPageObserver: null,
    landingPageSyncFrame: 0,
    inlineDrawerAutoClose: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.settingsDrawerAutoClose), false),
    theme: normalizeTheme(safeGetItem(NN_STORAGE_KEYS.theme)),
    kittyless: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.kittyless), false),
    tourButtonsHidden: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.tourButtonsHidden), false),
    frontendIcon: normalizeFrontendIcon(safeGetItem(NN_STORAGE_KEYS.frontendIcon)),
    surfaceTransparency: normalizeSurfaceTransparency(safeGetItem(NN_STORAGE_KEYS.surfaceTransparency)),
    paperTextureEnabled: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.paperTextureEnabled), false),
    paperTextureOpacity: normalizePaperTextureOpacity(safeGetItem(NN_STORAGE_KEYS.paperTextureOpacity)),
    compactMode: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.compactMode), false),
    topbarIconsOnly: {
        desktop: readTopbarIconsOnlySetting(NN_STORAGE_KEYS.desktopTopbarIconsOnly),
        mobile: readTopbarIconsOnlySetting(NN_STORAGE_KEYS.mobileTopbarIconsOnly),
    },
    topbarPages: {
        syncFrame: 0,
        fitFrame: 0,
        brandWidth: 0,
    },
    topbarExtensions: {
        syncFrame: 0,
        adopting: false,
        observer: null,
    },
    bottomBarScale: normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.bottomBarScale)),
    desktopButtonScale: normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.desktopButtonScale)),
    mobileButtonScale: normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.mobileButtonScale)),
    topbarScale: {
        desktop: normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.topbarScaleDesktop)),
        mobile: normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.topbarScaleMobile)),
    },
    topbarLabel: {
        desktopParts: safeGetItem(NN_STORAGE_KEYS.topbarLabelDesktopParts) === null
            ? ['char']
            : normalizeTopbarLabelParts(safeGetItem(NN_STORAGE_KEYS.topbarLabelDesktopParts), []),
        mobileParts: readTopbarLabelMobileParts(safeGetItem(NN_STORAGE_KEYS.topbarLabelMobilePart)),
        customText: normalizeTopbarCustomText(safeGetItem(NN_STORAGE_KEYS.topbarLabelCustomText)),
        clickCycle: {
            desktop: readTopbarLabelClickCycle('desktop'),
            mobile: readTopbarLabelClickCycle('mobile'),
        },
        contextTokens: null,
        refreshTimer: 0,
        refreshInFlight: false,
        refreshPending: false,
        refreshToken: 0,
        bindingRetryTimer: 0,
        boundEventSource: null,
        windowBindingsAttached: false,
    },
    shells: {},
    universalSearch: {
        row: null,
        root: null,
        input: null,
        results: null,
        expanded: false,
        dismissBound: false,
        activeIndex: -1,
    },
    shellSizing: {
        overrides: {
            left: normalizeShellSize(safeGetItem(NN_STORAGE_KEYS.leftShellSize)),
            right: normalizeShellSize(safeGetItem(NN_STORAGE_KEYS.rightShellSize)),
        },
        snapToChatWidth: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.desktopShellSnapToChatWidth), true),
        activeResize: null,
    },
    characterDrawer: {
        rightLocked: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.characterDrawerRightLocked), false),
        stateObserver: null,
        observedOpen: null,
        lastTab: 'characters',
        displacedWhilePinned: false,
        restoreFrame: 0,
    },
    mobileModal: {
        syncFrame: 0,
    },
    mobileNav: {
        lastOpenedAt: 0,
        quickActionContainer: null,
        quickActionSection: null,
        quickActionDivider: null,
        layout: normalizeMobileNavLayout(safeGetItem(NN_STORAGE_KEYS.mobileNavLayout)),
        iconOnly: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.mobileNavIconOnly), false),
        showCustomize: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.mobileNavShowCustomize), true),
        showQuickActions: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.mobileNavShowQuickActions), false),
        replaceQuickActions: false,
        replacementTarget: NN_MOBILE_NAV_PAGE_TARGET_DEFAULT,
    },
    desktopNav: {
        layout: normalizeMobileNavLayout(safeGetItem(NN_STORAGE_KEYS.desktopNavLayout)),
        iconOnly: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.desktopNavIconOnly), false),
        showCustomize: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.desktopNavShowCustomize), true),
        showQuickActions: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.desktopNavShowQuickActions), false),
        replaceQuickActions: false,
        replacementTarget: NN_MOBILE_NAV_PAGE_TARGET_DEFAULT,
    },
    desktopQuickActions: [],
    mobileQuickActions: [],
    chatbar: {
        desktop: null,
        sidebar: null,
        mobileTools: null,
        visible: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.chatbarVisible), true),
        searchQuery: '',
        searchTimer: 0,
        searchApplyToken: 0,
        refreshTimer: 0,
        refreshToken: 0,
        pendingSearchScroll: false,
        isApplyingSearch: false,
        chatObserver: null,
        sourceObserver: null,
        sourceSelectObserver: null,
        sourceObservedElement: null,
        sourceChangeHandler: null,
        connectionStripOpen: false,
        sidebarOpen: false,
        mobileToolsOpen: false,
        bindingRetryTimer: 0,
        boundEventSource: null,
        windowBindingsAttached: false,
        topbarOffset: normalizeTopbarOffset(safeGetItem(NN_STORAGE_KEYS.topbarOffset)),
        renderedTopbarOffset: { x: 0, y: 0 },
        dragging: null,
        dragListenersBound: false,
        chatbarToggleButton: null,
        dragHandleButton: null,
    },
    chatAvatars: {
        observer: null,
        debounceTimer: 0,
        retryTimer: 0,
        sourceCache: new WeakMap(),
    },
    bottomChatBar: {
        chatSelect: null,
        personaBubble: null,
        searchField: null,
        searchInput: null,
        searchStatus: null,
        searchToggleButton: null,
        collapseToggleButton: null,
        secondaryRow: null,
        scrollTopButton: null,
        scrollBottomButton: null,
        managerButton: null,
        massDeleteButton: null,
        autoNameButton: null,
        secondaryOpen: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.bottomChatSecondaryOpen), true),
        visible: normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.bottomChatBarVisible), true),
        searchOpen: false,
        bindingRetryTimer: 0,
        boundEventSource: null,
        windowBindingsAttached: false,
        outsideClickBound: false,
    },
    serverAdmin: {
        refs: null,
        originalConfig: '',
        lastModifiedMs: 0,
        thumbnailLastModifiedMs: 0,
        thumbnailSettingsLoaded: false,
        lastStatusData: null,
        busy: false,
        restarting: false,
        configLoaded: false,
    },
    consoleLogs: {
        refs: null,
        entries: [],
        latestId: 0,
        captureStartedAt: 0,
        totalBuffered: 0,
        refreshTimer: 0,
        busy: false,
        paused: false,
        lastUpdatedAt: 0,
        lastError: '',
        configBusy: false,
        configLoaded: false,
        configPath: '',
        configLastModifiedMs: 0,
        verboseLoggingEnabled: false,
    },
    importer: {
        refs: null,
        busy: false,
        report: null,
    },
};

function normalizeTheme(themeId) {
    return NN_THEMES.some(theme => theme.id === themeId) ? themeId : 'calico';
}

function normalizeFrontendIcon(iconId) {
    const normalizedIconId = normalizeText(iconId);
    return NN_FRONTEND_ICONS.some(icon => icon.id === normalizedIconId) ? normalizedIconId : NN_FRONTEND_ICON_DEFAULT;
}

function getFrontendIconConfig(iconId = nnState.frontendIcon) {
    const normalizedIconId = normalizeFrontendIcon(iconId);
    return NN_FRONTEND_ICONS.find(icon => icon.id === normalizedIconId) || NN_FRONTEND_ICONS[0];
}

function getFrontendIconSrc(iconId = nnState.frontendIcon, { absolute = true } = {}) {
    const src = getAssistantIconSrc(getFrontendIconConfig(iconId).id);
    return absolute ? `/${src}` : src;
}

function normalizeTopbarLabelPart(value, fallback = '') {
    const fallbackValue = NN_TOPBAR_LABEL_PART_IDS.has(fallback) ? fallback : '';
    const normalizedValue = normalizeText(value);
    return NN_TOPBAR_LABEL_PART_IDS.has(normalizedValue) ? normalizedValue : fallbackValue;
}

function normalizeTopbarLabelParts(value, fallback = []) {
    let source = value;

    if (typeof source === 'string') {
        const trimmedValue = source.trim();
        if (!trimmedValue) {
            source = [];
        } else {
            try {
                source = JSON.parse(trimmedValue);
            } catch {
                source = trimmedValue.split(',');
            }
        }
    }

    const rawParts = Array.isArray(source) ? source : [source];
    const normalizedParts = NN_TOPBAR_LABEL_PART_ORDER.filter(
        partId => rawParts.some(candidate => normalizeTopbarLabelPart(candidate) === partId),
    );
    const fallbackParts = Array.isArray(fallback)
        ? NN_TOPBAR_LABEL_PART_ORDER.filter(partId => fallback.includes(partId))
        : [];

    return normalizedParts.length ? normalizedParts : fallbackParts;
}

function normalizeTopbarCustomText(value) {
    const normalizedValue = String(value ?? '').replace(/\s+/g, ' ').trim();
    return normalizedValue.slice(0, NN_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH).trim();
}

function normalizeStoredBoolean(value, fallback = false) {
    if (value === null || value === undefined) {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalizedValue = String(value).trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalizedValue)) {
        return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalizedValue)) {
        return false;
    }

    return fallback;
}

function readTopbarLabelClickCycle(mode) {
    const storageKey = mode === 'mobile'
        ? NN_STORAGE_KEYS.topbarLabelClickCycleMobile
        : NN_STORAGE_KEYS.topbarLabelClickCycleDesktop;
    // Keep the old choice as a read-only seed until each layout has its own saved value.
    return normalizeStoredBoolean(
        safeGetItem(storageKey),
        normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.topbarLabelClickCycle), true),
    );
}

function isTopbarLabelClickCycleEnabled() {
    return isMobileViewport() ? nnState.topbarLabel.clickCycle.mobile : nnState.topbarLabel.clickCycle.desktop;
}

function syncNeconyanSectionSelect(nav, attribute, label) {
    if (!(nav instanceof HTMLElement) || !nav.parentElement || !document.body?.classList.contains('neconyan')) return;
    let select = nav.parentElement.querySelector('select[data-neconyan-section="' + attribute + '"]');
    if (!(select instanceof HTMLSelectElement)) {
        select = createElement('select', {
            className: 'text_pole neconyan-mobile-section-select',
            attrs: { 'aria-label': label, 'data-neconyan-section': attribute, 'data-sb-search-index-ignore': 'true' },
        });
        select.addEventListener('change', () => {
            const target = Array.from(nav.querySelectorAll('[' + attribute + ']')).find(button => button.getAttribute(attribute) === select.value);
            target?.click();
        });
        nav.parentElement.insertBefore(select, nav);
    }
    const buttons = Array.from(nav.querySelectorAll('[' + attribute + ']')).filter(button => !button.hidden);
    const entries = buttons.map(button => ({
        value: button.getAttribute(attribute),
        text: (button.querySelector('strong')?.textContent || button.getAttribute('aria-label') || button.textContent).trim(),
        disabled: Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true',
    }));
    if (select.options.length !== entries.length || Array.from(select.options).some((option, index) => option.value !== entries[index]?.value || option.textContent !== entries[index]?.text || option.disabled !== entries[index]?.disabled)) {
        select.replaceChildren(...entries.map(entry => {
            const option = createElement('option', { text: entry.text, attrs: { value: entry.value } });
            option.disabled = entry.disabled;
            return option;
        }));
    }
    const active = buttons.find(button => button.getAttribute('aria-selected') === 'true')?.getAttribute(attribute);
    if (active && select.value !== active) select.value = active;
    select.disabled = entries.length === 0;
}

function normalizeMobileNavLayout() { return 'vertical'; }

function getNavState(mode) {
    return mode === 'desktop' ? nnState.desktopNav : nnState.mobileNav;
}

function getQuickActionState(mode) {
    return mode === 'desktop' ? nnState.desktopQuickActions : nnState.mobileQuickActions;
}

function getActiveShellRailMode() {
    return isMobileViewport() ? 'mobile' : 'desktop';
}

function getMobileNavCustomizeLocationLabel(mode = 'mobile') {
    return getNavState(mode).layout === 'horizontal'
        ? 'Show Model and Settings buttons in top bar'
        : 'Show Model and Settings shortcuts in each side rail';
}

function normalizeMobileNavReplacementTarget(value) {
    const normalizedValue = String(value ?? '').trim();
    return NN_MOBILE_NAV_PAGE_TARGETS.some(target => target.value === normalizedValue)
        ? normalizedValue
        : NN_MOBILE_NAV_PAGE_TARGET_DEFAULT;
}

function getMobileNavReplacementTargetConfig(target = nnState.mobileNav.replacementTarget) {
    const normalizedTarget = normalizeMobileNavReplacementTarget(target);
    return NN_MOBILE_NAV_PAGE_TARGETS.find(item => item.value === normalizedTarget)
        ?? NN_MOBILE_NAV_PAGE_TARGETS[0];
}

function createNavReplacementQuickAction(target) {
    const config = getMobileNavReplacementTargetConfig(target);
    return normalizeMobileQuickAction({
        type: 'tab',
        shellKey: config.shellKey,
        tabId: config.tabId,
        icon: config.icon,
        label: config.label,
    });
}

function normalizeShellSize(value) {
    let source = value;

    if (typeof source === 'string') {
        const trimmedValue = source.trim();

        if (!trimmedValue) {
            return null;
        }

        try {
            source = JSON.parse(trimmedValue);
        } catch {
            return null;
        }
    }

    const width = Number(source?.width);
    const height = Number(source?.height);

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }

    return {
        width: Math.max(0, Math.round(width)),
        height: Math.max(0, Math.round(height)),
    };
}

function normalizeSurfaceTransparency(value) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return NN_SURFACE_TRANSPARENCY.defaultValue;
    }

    const snappedValue = Math.round(numericValue / NN_SURFACE_TRANSPARENCY.step) * NN_SURFACE_TRANSPARENCY.step;
    return Math.min(NN_SURFACE_TRANSPARENCY.max, Math.max(NN_SURFACE_TRANSPARENCY.min, snappedValue));
}

function formatSurfaceTransparency(value) {
    return `${normalizeSurfaceTransparency(value)}%`;
}

function normalizePaperTextureOpacity(value) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return NN_PAPER_TEXTURE_OPACITY.defaultValue;
    }

    const snappedValue = Math.round(numericValue / NN_PAPER_TEXTURE_OPACITY.step) * NN_PAPER_TEXTURE_OPACITY.step;
    return Math.min(NN_PAPER_TEXTURE_OPACITY.max, Math.max(NN_PAPER_TEXTURE_OPACITY.min, snappedValue));
}

function formatPaperTextureOpacity(value) {
    return `${normalizePaperTextureOpacity(value)}%`;
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeTopbarOffset(value) {
    let source = value;

    if (typeof source === 'string' && source.trim()) {
        try {
            source = JSON.parse(source);
        } catch {
            source = null;
        }
    }

    const x = Number(source?.x);
    const y = Number(source?.y);

    return {
        x: Number.isFinite(x) ? Math.round(x) : 0,
        y: Number.isFinite(y) ? Math.round(y) : 0,
    };
}

function getMobileQuickActionTabConfig(shellKey, tabId) {
    if (shellKey === 'characters') {
        return getCharacterPanelTabConfig(tabId);
    }

    const shellConfig = getShellConfig(shellKey);
    if (!shellConfig || !tabId) {
        return null;
    }

    return [
        shellConfig.baseTab,
        ...(Array.isArray(shellConfig.embeddedTabs) ? shellConfig.embeddedTabs : []),
        ...(Array.isArray(shellConfig.customTabs) ? shellConfig.customTabs : []),
    ].find(tab => tab?.id === tabId) || null;
}

function getMobileQuickActionContext(value) {
    const route = nnMobileShellLifecycle.railModel.resolveQuickActionRoute(value);
    return {
        shellConfig: route.shellKey === 'characters' ? null : getShellConfig(route.shellKey),
        tabConfig: route.tabId ? getMobileQuickActionTabConfig(route.shellKey, route.tabId) : null,
    };
}

function normalizeMobileQuickAction(value) {
    const { shellConfig, tabConfig } = getMobileQuickActionContext(value);
    return nnMobileShellLifecycle.railModel.normalizeQuickAction({
        action: value,
        shellConfig,
        tabConfig,
        limits: nnMobileShellLifecycle.railModel.limits,
    });
}

function normalizeMobileQuickActionList(actions) {
    const seen = new Set();
    const nextActions = [];

    if (!Array.isArray(actions)) {
        return nextActions;
    }

    for (const action of actions) {
        const normalizedAction = normalizeMobileQuickAction(action);
        if (!normalizedAction) {
            continue;
        }

        const key = getMobileQuickActionKey(normalizedAction);
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        nextActions.push(normalizedAction);

        if (nextActions.length >= NN_MOBILE_QUICK_ACTION_LIMIT) {
            break;
        }
    }

    return nextActions;
}

function getDefaultMobileQuickActions() {
    return normalizeMobileQuickActionList(NN_MOBILE_DEFAULT_QUICK_ACTIONS);
}

function getDefaultDesktopQuickActions() {
    return normalizeMobileQuickActionList(NN_DESKTOP_DEFAULT_QUICK_ACTIONS);
}

function migrateLegacyMobileQuickAction(action) {
    if (!action || typeof action !== 'object') {
        return action;
    }

    // Neconyan: account storage may still contain the pre-relocation mobile
    // World Info route; normalize it to the Characters tab on read.
    const legacyShellKey = normalizeText(action.shellKey || action.shell);
    const legacyTabId = normalizeText(action.tabId || action.tab);
    if (legacyShellKey !== 'left' || legacyTabId !== 'world-info') {
        return action;
    }

    return {
        ...action,
        shellKey: 'characters',
        tabId: 'world-info',
    };
}

function parseMobileQuickActionStorage(storedValue) {
    if (storedValue === null) {
        return null;
    }

    try {
        const parsedValue = JSON.parse(storedValue);
        if (!Array.isArray(parsedValue)) {
            return null;
        }

        return normalizeMobileQuickActionList(parsedValue.map(migrateLegacyMobileQuickAction));
    } catch {
        return null;
    }
}

function loadMobileQuickActions() {
    const storedActions = parseMobileQuickActionStorage(safeGetItem(NN_STORAGE_KEYS.mobileQuickActions));
    if (storedActions) {
        return storedActions;
    }

    const defaultActions = getDefaultMobileQuickActions();
    const legacyActions = parseMobileQuickActionStorage(safeGetItem(NN_STORAGE_KEYS.mobileQuickActionsLegacy));
    const nextActions = legacyActions
        ? normalizeMobileQuickActionList([...defaultActions, ...legacyActions])
        : defaultActions;

    safeSetItem(NN_STORAGE_KEYS.mobileQuickActions, JSON.stringify(nextActions));
    return nextActions;
}

function loadDesktopQuickActions() {
    const storedActions = parseMobileQuickActionStorage(safeGetItem(NN_STORAGE_KEYS.desktopQuickActions));
    if (storedActions) {
        return storedActions;
    }

    const nextActions = getDefaultDesktopQuickActions();
    safeSetItem(NN_STORAGE_KEYS.desktopQuickActions, JSON.stringify(nextActions));
    return nextActions;
}

function saveMobileQuickActions() {
    safeSetItem(NN_STORAGE_KEYS.mobileQuickActions, JSON.stringify(nnState.mobileQuickActions));
}

function saveDesktopQuickActions() {
    safeSetItem(NN_STORAGE_KEYS.desktopQuickActions, JSON.stringify(nnState.desktopQuickActions));
}

function getMobileQuickActionKey(action) {
    const normalizedAction = normalizeMobileQuickAction(action);
    return nnMobileShellLifecycle.railModel.getQuickActionKey(normalizedAction);
}

function createMobileQuickActionFromMatch(match) {
    const normalizedMatch = normalizeMobileQuickAction({
        type: 'custom',
        shellKey: match?.shellKey,
        tabId: match?.tabId,
        icon: NN_MOBILE_QUICK_ACTION_ICON_FALLBACK,
        sectionLabel: match?.sectionLabel,
        displayText: match?.displayText,
        dedupeKey: match?.dedupeKey,
        label: match?.displayText || match?.sectionLabel,
    });

    return normalizedMatch;
}

function setQuickActionsForMode(mode, actions, { persist = true } = {}) {
    const normalizedActions = normalizeMobileQuickActionList(actions);

    if (mode === 'desktop') {
        nnState.desktopQuickActions = normalizedActions;

        if (persist) {
            saveDesktopQuickActions();
        }

        renderMobileQuickActionSettingsList('desktop');
        refreshMobileQuickActionSearchResults('desktop');
        refreshDesktopTopbarQuickActions();
        syncMobileShellRailActions();
        return;
    }

    nnState.mobileQuickActions = normalizedActions;

    if (persist) {
        saveMobileQuickActions();
    }

    renderMobileQuickActionSettingsList('mobile');
    refreshMobileQuickActionSearchResults('mobile');
    refreshMobileNavQuickActions();
    syncMobileShellRailActions();
}

function setMobileQuickActions(actions, options = {}) {
    setQuickActionsForMode('mobile', actions, options);
}

function setDesktopQuickActions(actions, options = {}) {
    setQuickActionsForMode('desktop', actions, options);
}

function addQuickActionFromMatch(mode, match) {
    const action = createMobileQuickActionFromMatch(match);
    if (!action) {
        return false;
    }

    const currentActions = getQuickActionState(mode);
    if (currentActions.length >= NN_MOBILE_QUICK_ACTION_LIMIT) {
        return false;
    }

    const actionKey = getMobileQuickActionKey(action);
    if (currentActions.some(existingAction => getMobileQuickActionKey(existingAction) === actionKey)) {
        return false;
    }

    setQuickActionsForMode(mode, [...currentActions, action]);
    return true;
}

function removeQuickAction(mode, actionKey) {
    setQuickActionsForMode(mode, getQuickActionState(mode).filter(action => getMobileQuickActionKey(action) !== actionKey));
}

function setQuickActionIcon(mode, actionKey, iconClass) {
    setQuickActionsForMode(mode, getQuickActionState(mode).map(action => {
        if (getMobileQuickActionKey(action) !== actionKey) {
            return action;
        }

        return {
            ...action,
            icon: normalizeFontAwesomeIcon(iconClass),
        };
    }));
}

async function chooseQuickActionIcon(mode, actionKey) {
    const action = getQuickActionState(mode).find(action => getMobileQuickActionKey(action) === actionKey);
    const normalizedAction = normalizeMobileQuickAction(action);

    if (!normalizedAction || normalizedAction.type !== 'custom') {
        return;
    }

    const iconClass = await showFontAwesomePicker();
    if (iconClass === null) {
        return;
    }

    setQuickActionIcon(mode, actionKey, iconClass);
}

function resetMobileQuickActions() {
    setMobileQuickActions(getDefaultMobileQuickActions());
}

function resetDesktopQuickActions() {
    setDesktopQuickActions(getDefaultDesktopQuickActions());
}

function normalizeTopbarScale(value) {
    if (value === null || value === undefined || value === '') {
        return NN_TOPBAR_SCALE.defaultValue;
    }

    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return NN_TOPBAR_SCALE.defaultValue;
    }

    const snappedValue = Math.round(numericValue / NN_TOPBAR_SCALE.step) * NN_TOPBAR_SCALE.step;
    return Math.min(NN_TOPBAR_SCALE.max, Math.max(NN_TOPBAR_SCALE.min, snappedValue));
}

function formatTopbarScale(value) {
    return `${normalizeTopbarScale(value)}%`;
}

function seedTopbarScaleDefaults() {
    if (safeGetItem(NN_STORAGE_KEYS.topbarScaleDesktop) === null) {
        safeSetItem(NN_STORAGE_KEYS.topbarScaleDesktop, String(NN_TOPBAR_SCALE.defaultValue));
    }

    if (safeGetItem(NN_STORAGE_KEYS.topbarScaleMobile) === null) {
        safeSetItem(NN_STORAGE_KEYS.topbarScaleMobile, String(NN_TOPBAR_SCALE.defaultValue));
    }

    if (safeGetItem(NN_STORAGE_KEYS.bottomBarScale) === null) {
        safeSetItem(NN_STORAGE_KEYS.bottomBarScale, String(NN_TOPBAR_SCALE.defaultValue));
    }

    if (safeGetItem(NN_STORAGE_KEYS.desktopButtonScale) === null) {
        safeSetItem(NN_STORAGE_KEYS.desktopButtonScale, String(NN_TOPBAR_SCALE.defaultValue));
    }

    if (safeGetItem(NN_STORAGE_KEYS.mobileButtonScale) === null) {
        safeSetItem(NN_STORAGE_KEYS.mobileButtonScale, String(NN_TOPBAR_SCALE.defaultValue));
    }
}

function restorePersistedTopbarState() {
    nnState.topbarScale.desktop = normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.topbarScaleDesktop));
    nnState.topbarScale.mobile = normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.topbarScaleMobile));
    nnState.bottomBarScale = normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.bottomBarScale));
    nnState.desktopButtonScale = normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.desktopButtonScale));
    nnState.mobileButtonScale = normalizeTopbarScale(safeGetItem(NN_STORAGE_KEYS.mobileButtonScale));
    nnState.frontendIcon = normalizeFrontendIcon(safeGetItem(NN_STORAGE_KEYS.frontendIcon));
    nnState.topbarLabel.desktopParts = safeGetItem(NN_STORAGE_KEYS.topbarLabelDesktopParts) === null
        ? ['char']
        : normalizeTopbarLabelParts(safeGetItem(NN_STORAGE_KEYS.topbarLabelDesktopParts), []);
    nnState.topbarLabel.mobileParts = readTopbarLabelMobileParts(safeGetItem(NN_STORAGE_KEYS.topbarLabelMobilePart));
    nnState.topbarLabel.customText = normalizeTopbarCustomText(safeGetItem(NN_STORAGE_KEYS.topbarLabelCustomText));
    nnState.topbarLabel.clickCycle.desktop = readTopbarLabelClickCycle('desktop');
    nnState.topbarLabel.clickCycle.mobile = readTopbarLabelClickCycle('mobile');
    nnState.chatbar.visible = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.chatbarVisible), nnState.chatbar.visible);
    nnState.chatbar.topbarOffset = normalizeTopbarOffset(safeGetItem(NN_STORAGE_KEYS.topbarOffset));
    nnState.compactMode = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.compactMode), nnState.compactMode);
    nnState.tourButtonsHidden = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.tourButtonsHidden), nnState.tourButtonsHidden);
    nnState.topbarIconsOnly.desktop = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.desktopTopbarIconsOnly), nnState.topbarIconsOnly.desktop);
    nnState.topbarIconsOnly.mobile = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.mobileTopbarIconsOnly), nnState.topbarIconsOnly.mobile);
    nnState.bottomChatBar.visible = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.bottomChatBarVisible), nnState.bottomChatBar.visible);
    nnState.shellSizing.snapToChatWidth = normalizeStoredBoolean(
        safeGetItem(NN_STORAGE_KEYS.desktopShellSnapToChatWidth),
        nnState.shellSizing.snapToChatWidth,
    );
    nnState.mobileNav.layout = normalizeMobileNavLayout(safeGetItem(NN_STORAGE_KEYS.mobileNavLayout));
    nnState.mobileNav.iconOnly = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.mobileNavIconOnly), nnState.mobileNav.iconOnly);
    nnState.mobileNav.showCustomize = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.mobileNavShowCustomize), nnState.mobileNav.showCustomize);
    nnState.mobileNav.showQuickActions = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.mobileNavShowQuickActions), nnState.mobileNav.showQuickActions);
    nnState.desktopNav.layout = normalizeMobileNavLayout(safeGetItem(NN_STORAGE_KEYS.desktopNavLayout));
    nnState.desktopNav.iconOnly = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.desktopNavIconOnly), nnState.desktopNav.iconOnly);
    nnState.desktopNav.showCustomize = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.desktopNavShowCustomize), nnState.desktopNav.showCustomize);
    nnState.desktopNav.showQuickActions = normalizeStoredBoolean(safeGetItem(NN_STORAGE_KEYS.desktopNavShowQuickActions), nnState.desktopNav.showQuickActions);
    nnState.desktopQuickActions = loadDesktopQuickActions();
    nnState.mobileQuickActions = loadMobileQuickActions();
    nnState.characterDrawer.rightLocked = normalizeStoredBoolean(
        getPersistentStorageItem(NN_STORAGE_KEYS.characterDrawerRightLocked),
        nnState.characterDrawer.rightLocked,
    );
}

function clampTopbarOffset(offset) {
    const maxX = Math.max(0, Math.round(window.innerWidth * NN_TOPBAR_DRAG_X_RATIO));
    const maxY = Math.max(0, Math.round(window.innerHeight * NN_TOPBAR_DRAG_Y_RATIO));
    const normalizedOffset = normalizeTopbarOffset(offset);

    return {
        x: clampNumber(normalizedOffset.x, -maxX, maxX),
        y: clampNumber(normalizedOffset.y, 0, maxY),
    };
}

function getRenderedTopbarOffset() {
    return clampTopbarOffset(getChatbarState().topbarOffset);
}

function applyTopbarOffset() {
    const dragSurface = document.getElementById('sb-chatbar-layer');
    const renderedOffset = getRenderedTopbarOffset();

    getChatbarState().renderedTopbarOffset = renderedOffset;

    if (!(dragSurface instanceof HTMLElement)) {
        return;
    }

    dragSurface.style.setProperty('--sb-topbar-offset-x', `${renderedOffset.x}px`);
    dragSurface.style.setProperty('--sb-topbar-offset-y', `${renderedOffset.y}px`);
}

function setTopbarOffset(offset, { persist = true } = {}) {
    const nextOffset = normalizeTopbarOffset(offset);
    getChatbarState().topbarOffset = nextOffset;

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.topbarOffset, JSON.stringify(nextOffset));
    }

    applyTopbarOffset();
}

function setTopbarScale(mode, value, { persist = true } = {}) {
    const storageKey = mode === 'mobile'
        ? NN_STORAGE_KEYS.topbarScaleMobile
        : mode === 'desktop'
            ? NN_STORAGE_KEYS.topbarScaleDesktop
            : '';

    if (!storageKey) {
        return;
    }

    const nextScale = normalizeTopbarScale(value);
    const scaleFactor = Number((nextScale / 100).toFixed(2)).toString();

    nnState.topbarScale[mode] = nextScale;
    document.documentElement.style.setProperty(`--sb-topbar-scale-${mode}`, scaleFactor);

    if (persist) {
        safeSetItem(storageKey, String(nextScale));
    }

    if (getChatDesktopRefs()) {
        scheduleChatbarRefresh(0);
    }

    updateThemePickerUi();
}

function setBottomBarScale(value, { persist = true } = {}) {
    const nextScale = normalizeTopbarScale(value);
    const scaleFactor = Number((nextScale / 100).toFixed(2)).toString();

    nnState.bottomBarScale = nextScale;
    document.documentElement.style.setProperty('--sb-bottom-bar-scale', scaleFactor);

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.bottomBarScale, String(nextScale));
    }

    updateThemePickerUi();
}

function setDesktopButtonScale(value, { persist = true } = {}) {
    const nextScale = normalizeTopbarScale(value);
    const scaleFactor = Number((nextScale / 100).toFixed(2)).toString();

    nnState.desktopButtonScale = nextScale;
    document.documentElement.style.setProperty('--sb-desktop-button-scale', scaleFactor);

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.desktopButtonScale, String(nextScale));
    }

    updateThemePickerUi();
}

function setMobileButtonScale(value, { persist = true } = {}) {
    const nextScale = normalizeTopbarScale(value);
    const scaleFactor = Number((nextScale / 100).toFixed(2)).toString();

    nnState.mobileButtonScale = nextScale;
    document.documentElement.style.setProperty('--sb-mobile-button-scale', scaleFactor);

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.mobileButtonScale, String(nextScale));
    }

    updateThemePickerUi();
}

function applyMobileNavPreferences() {
    const quickActionsShown = nnState.mobileNav.showQuickActions;
    const useIconOnly = nnState.mobileNav.iconOnly;
    document.documentElement.dataset.sbMobileNavLayout = nnState.mobileNav.layout;
    document.documentElement.dataset.sbMobileNavMode = useIconOnly ? 'icon-only' : 'labeled';
    document.documentElement.dataset.sbMobileNavCustomize = nnState.mobileNav.showCustomize ? 'shown' : 'hidden';
    document.documentElement.dataset.sbMobileNavQuickActions = quickActionsShown ? 'shown' : 'hidden';
    document.documentElement.dataset.sbMobileNavReplacement = nnState.mobileNav.replaceQuickActions ? 'shown' : 'hidden';
}

function applyDesktopNavPreferences() {
    const quickActionsShown = nnState.desktopNav.showQuickActions;
    const useIconOnly = nnState.desktopNav.iconOnly;
    document.documentElement.dataset.sbDesktopNavLayout = nnState.desktopNav.layout;
    document.documentElement.dataset.sbDesktopNavMode = useIconOnly ? 'icon-only' : 'labeled';
    document.documentElement.dataset.sbDesktopNavCustomize = nnState.desktopNav.showCustomize ? 'shown' : 'hidden';
    document.documentElement.dataset.sbDesktopNavQuickActions = quickActionsShown ? 'shown' : 'hidden';
    document.documentElement.dataset.sbDesktopNavReplacement = nnState.desktopNav.replaceQuickActions ? 'shown' : 'hidden';
}

function setMobileNavIconOnly(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    nnState.mobileNav.iconOnly = nextEnabled;
    applyMobileNavPreferences();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.mobileNavIconOnly, String(nextEnabled));
    }

    updateThemePickerUi();
}

function setMobileNavShowCustomize(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    nnState.mobileNav.showCustomize = nextEnabled;
    applyMobileNavPreferences();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.mobileNavShowCustomize, String(nextEnabled));
    }

    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setMobileNavShowQuickActions(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    nnState.mobileNav.showQuickActions = nextEnabled;
    applyMobileNavPreferences();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.mobileNavShowQuickActions, String(nextEnabled));
    }

    refreshMobileNavQuickActions();
    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setDesktopNavIconOnly(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    nnState.desktopNav.iconOnly = nextEnabled;
    applyDesktopNavPreferences();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.desktopNavIconOnly, String(nextEnabled));
    }

    updateThemePickerUi();
}

function setDesktopNavShowCustomize(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    nnState.desktopNav.showCustomize = nextEnabled;
    applyDesktopNavPreferences();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.desktopNavShowCustomize, String(nextEnabled));
    }

    syncMobileShellRailActions();
    updateThemePickerUi();
}

function setDesktopNavShowQuickActions(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    nnState.desktopNav.showQuickActions = nextEnabled;
    applyDesktopNavPreferences();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.desktopNavShowQuickActions, String(nextEnabled));
    }

    refreshDesktopTopbarQuickActions();
    syncMobileShellRailActions();
    updateThemePickerUi();
}

function moveElementBefore(element, parent, referenceNode) {
    if (!(element instanceof HTMLElement) || !(parent instanceof HTMLElement)) {
        return;
    }

    if (referenceNode instanceof Node) {
        if (element.parentElement === parent && element.nextElementSibling === referenceNode) {
            return;
        }

        parent.insertBefore(element, referenceNode);
        return;
    }

    if (element.parentElement === parent && element.nextSibling === null) {
        return;
    }

    parent.appendChild(element);
}

function moveElementToStart(element, parent) {
    if (!(element instanceof HTMLElement) || !(parent instanceof HTMLElement)) {
        return;
    }

    if (element.parentElement === parent && element.previousElementSibling === null) {
        return;
    }

    parent.insertBefore(element, parent.firstChild);
}

function moveElementAfter(element, referenceElement, parent) {
    if (!(element instanceof HTMLElement)
        || !(referenceElement instanceof HTMLElement)
        || !(parent instanceof HTMLElement)) {
        return;
    }

    if (element.parentElement === parent && element.previousElementSibling === referenceElement) {
        return;
    }

    parent.insertBefore(element, referenceElement.nextSibling);
}

/*
 * Everything upstream (plus the bundled palette button) ships in #rightSendForm. The phone
 * composer sizes that rail for exactly two buttons, so anything else there is third-party.
 */
const NN_COMPOSER_NATIVE_RIGHT_RAIL_IDS = Object.freeze([
    'stscript_continue',
    'stscript_pause',
    'stscript_stop',
    'mes_stop',
    'mes_impersonate',
    'mes_continue',
    'sb_prose_polisher_but',
    'send_but',
    'qig-input-btn',
]);

const NN_COMPOSER_ADOPTED_ATTRIBUTE = 'data-sb-composer-adopted';

/**
 * Relocates third-party composer buttons between the rails. The right rail is a fixed two-button
 * grid column with no overflow, so extension buttons there used to be hidden outright on phones;
 * the left rail already scrolls, so it can hold any number of them. Desktop keeps them where the
 * extension put them.
 */
function placeComposerExtensionButtons(leftForm, rightForm) {
    const mobile = isMobileViewport();

    if (mobile) {
        for (const child of Array.from(rightForm.children)) {
            // Keep paw sounds in place if they fall back to this row.
            if (!(child instanceof HTMLElement) || NN_COMPOSER_NATIVE_RIGHT_RAIL_IDS.includes(child.id) || child.classList.contains('neconyan-send-nya')) {
                continue;
            }

            child.setAttribute(NN_COMPOSER_ADOPTED_ATTRIBUTE, 'right');
            leftForm.appendChild(child);
        }

        return;
    }

    for (const child of Array.from(leftForm.querySelectorAll(`:scope > [${NN_COMPOSER_ADOPTED_ATTRIBUTE}='right']`))) {
        child.removeAttribute(NN_COMPOSER_ADOPTED_ATTRIBUTE);
        rightForm.appendChild(child);
    }
}

function placeComposerControls() {
    const leftForm = document.getElementById('leftSendForm');
    const rightForm = document.getElementById('rightSendForm');

    if (!(leftForm instanceof HTMLElement) || !(rightForm instanceof HTMLElement)) {
        return;
    }

    const paletteButton = document.getElementById('qig-input-btn');
    const optionsButton = document.getElementById('options_button');
    const wandButton = document.getElementById('extensionsMenuButton');
    const sendButton = document.getElementById('send_but');

    moveElementToStart(optionsButton, leftForm);

    if (optionsButton instanceof HTMLElement && optionsButton.parentElement === leftForm) {
        moveElementAfter(wandButton, optionsButton, leftForm);
    } else {
        moveElementToStart(wandButton, leftForm);
    }

    moveElementBefore(paletteButton, rightForm, sendButton);
    placeComposerExtensionButtons(leftForm, rightForm);
    // Phones wear the cat ears on the whole bottom bar so they clear the chat-name pill above
    // the composer; neconyan-calico.css hides the composer's own pair there.
    const isPhone = isMobileViewport();
    document.getElementById('form_sheld')?.classList.toggle('neconyan-cat-panel', isPhone);
    // Same idea for the Characters sheet: on phones its header collapses to the close button,
    // so the ears sit on the tab row instead.
    document.querySelector('#right-nav-panel > .sb-character-shell-nav-wrapper')?.classList.toggle('neconyan-cat-panel', isPhone);
}

function queueComposerControlPlacement() {
    if (nnComposerControlsSyncQueued) {
        return;
    }

    nnComposerControlsSyncQueued = true;
    window.requestAnimationFrame(() => {
        nnComposerControlsSyncQueued = false;
        placeComposerControls();
    });
}

function bindComposerControlPlacement() {
    const leftForm = document.getElementById('leftSendForm');
    const rightForm = document.getElementById('rightSendForm');

    if (!(leftForm instanceof HTMLElement) || !(rightForm instanceof HTMLElement)) {
        return;
    }

    if (!(nnComposerControlsObserver instanceof MutationObserver)) {
        nnComposerControlsObserver = new MutationObserver(() => queueComposerControlPlacement());
    }

    nnComposerControlsObserver.disconnect();
    nnComposerControlsObserver.observe(leftForm, { childList: true });
    nnComposerControlsObserver.observe(rightForm, { childList: true });

    // Guided Generations inserts its row as a direct child of #send_form after boot.
    const sendForm = document.getElementById('send_form');
    if (sendForm instanceof HTMLElement) {
        nnComposerControlsObserver.observe(sendForm, { childList: true });
    }

    queueComposerControlPlacement();
}

function setCompactMode(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    nnState.compactMode = nextEnabled;
    document.documentElement.dataset.sbCompactMode = String(nextEnabled);
    document.body?.classList.toggle('sb-compact-mode', nextEnabled);
    syncTopbarLayoutState();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.compactMode, String(nextEnabled));
    }

    queueComposerControlPlacement();
    updateThemePickerUi();
}

// Neconyan: the old Advanced/Simple toggle is retired. The app is permanently in its full
// mode, so every control stays available on every device and the stored preferences are
// only kept so old settings files keep loading cleanly.
function isTopbarIconsOnlyActive() {
    return true;
}

function applyTopbarIconsOnlyPreference() {
    document.documentElement.dataset.sbTopbarIconsOnly = 'true';
    document.documentElement.dataset.neconyanMode = 'advanced';
    syncTopbarIconsOnlyLayout();
    queueTopbarPageStateSync();
    scheduleCharacterToggleGhostSync();
}

function setDesktopShellSnapToChatWidth(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    nnState.shellSizing.snapToChatWidth = nextEnabled;
    document.documentElement.dataset.sbDesktopShellSnapToChatWidth = String(nextEnabled);

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.desktopShellSnapToChatWidth, String(nextEnabled));
    }

    syncDesktopShellSizing();
    updateThemePickerUi();
}

function syncCharacterDrawerLockButton() {
    const button = document.getElementById('sb-character-right-lock');
    if (!(button instanceof HTMLButtonElement)) {
        return;
    }

    const isRightLocked = Boolean(nnState.characterDrawer.rightLocked);
    setButtonPressed(button, isRightLocked);
    button.title = isRightLocked ? 'Keep Characters centered' : 'Lock Characters to right';
    button.setAttribute('aria-label', button.title);
}

function syncCharacterDrawerLockPosition() {
    const panel = getCharacterPanel();
    if (!(panel instanceof HTMLElement)) {
        return;
    }

    // Neconyan docks inspectors in the application frame. Keep the legacy
    // moving UI lock available for other hosts, but let the stylesheet own
    // Neconyan's desktop geometry.
    if (document.body?.classList.contains('neconyan') && !isMobileViewport()) {
        if (panel.dataset.sbCharacterLockInline === 'right') {
            for (const property of ['left', 'right', 'margin-left', 'margin-right']) {
                panel.style.removeProperty(property);
            }
            delete panel.dataset.sbCharacterLockInline;
        }
        return;
    }

    if (isMovingUIActive()) {
        if (panel.dataset.sbCharacterLockInline === 'right') {
            for (const property of ['left', 'right', 'margin-left', 'margin-right']) {
                panel.style.removeProperty(property);
            }

            delete panel.dataset.sbCharacterLockInline;
        }

        return;
    }

    if (!nnState.characterDrawer.rightLocked || isMobileViewport()) {
        if (panel.dataset.sbCharacterLockInline === 'right') {
            for (const property of ['left', 'right', 'margin-left', 'margin-right']) {
                panel.style.removeProperty(property);
            }

            delete panel.dataset.sbCharacterLockInline;
        }
        return;
    }

    panel.style.setProperty('left', 'auto', 'important');
    panel.style.setProperty('right', '0px', 'important');
    panel.style.setProperty('margin-left', '0px', 'important');
    panel.style.setProperty('margin-right', '0px', 'important');
    panel.dataset.sbCharacterLockInline = 'right';
}

function setCharacterDrawerRightLock(enabled, { persist = true } = {}) {
    const nextEnabled = Boolean(enabled);
    nnState.characterDrawer.rightLocked = nextEnabled;
    document.documentElement.dataset.sbCharacterDrawerLock = nextEnabled ? 'right' : 'center';

    if (persist) {
        setPersistentStorageItem(NN_STORAGE_KEYS.characterDrawerRightLocked, String(nextEnabled));
    }

    syncCharacterDrawerLockPosition();
    syncCharacterDrawerLockButton();
}

/*
 * Identity-based ownership for the top-bar adoption pass. An id prefix is spoofable and absent
 * on id-less nodes, so registering what our own factory built is the only reliable test. Any
 * future Neconyan element that becomes a direct child of #top-bar or #top-settings-holder
 * must come from createElement() or it will be adopted as if it were third-party markup.
 */
const nnOwnedElements = new WeakSet();

function isNeconyanOwnedElement(node) {
    return node instanceof Element && nnOwnedElements.has(node);
}

function createElement(tagName, { id = '', className = '', text = '', html = '', attrs = {} } = {}) {
    const element = document.createElement(tagName);

    nnOwnedElements.add(element);

    if (id) {
        element.id = id;
    }

    if (className) {
        element.className = className;
    }

    if (text) {
        element.textContent = text;
    }

    if (html) {
        element.innerHTML = html;
    }

    for (const [key, value] of Object.entries(attrs)) {
        element.setAttribute(key, value);
    }

    return element;
}

function normalizeNeconyanNativeToolId(value) {
    return String(value ?? '').trim().replace(/^third-party[\\/]/i, '').toLowerCase();
}

function resolveNeconyanNativeTool(definition) {
    const wantedId = normalizeNeconyanNativeToolId(definition.id);
    const liveName = extensionNames.find(name => normalizeNeconyanNativeToolId(name) === wantedId)
        ?? extensionNames.find(name => normalizeNeconyanNativeToolId(name).endsWith(wantedId))
        ?? definition.id;
    const extension = findExtension(liveName) ?? findExtension(definition.id);
    const canonicalName = extension?.name ?? liveName;
    const manifest = getExtensionManifest(canonicalName) ?? getExtensionManifest(definition.id) ?? {};
    const present = definition.unitOnly === true || Boolean(extension);
    const enabled = present && (definition.unitOnly === true || extension.enabled !== false);

    return {
        ...definition,
        id: canonicalName,
        label: String(manifest.display_name || definition.label),
        description: String(manifest.description || ''),
        type: getExtensionType(canonicalName),
        present,
        enabled,
        manifest,
    };
}

function getNeconyanNativeTools() {
    return NECONYAN_NATIVE_TOOL_DEFINITIONS.map(resolveNeconyanNativeTool);
}

function focusNeconyanNativeManagerRow(label) {
    const normalizedLabel = String(label || '').trim().toLowerCase();
    return waitForNeconyanNativeReady(() => Array.from(document.querySelectorAll('.extensions_info .extension_block'))
        .find(row => row.textContent.trim().toLowerCase().includes(normalizedLabel)))
        .then(row => {
            if (!(row instanceof HTMLElement)) {
                return false;
            }
            const focusTarget = row.querySelector('input, button, .extension_name') || row;
            focusTarget.focus?.({ preventScroll: true });
            return true;
        });
}

function getSelectedIncludedTool() {
    const tools = getNeconyanNativeTools();
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return tools.find(tool => normalizeNeconyanNativeToolId(tool.id) === normalizeNeconyanNativeToolId(neconyanIncludedToolSelection)
        || normalize(tool.label) === normalize(neconyanIncludedToolSelection)) || null;
}

function buildIncludedToolPanel() {
    const panelBundle = createShellPanel({ id: 'included-tool' });
    let activationToken = 0;
    const host = createElement('div', { className: 'neconyan-included-tool-page' });
    const heading = createElement('div', { className: 'neconyan-included-tool-heading' });
    const title = createElement('h2', { text: 'Included tool' });
    const state = createElement('p', { className: 'neconyan-included-tool-state', text: 'Choose a tool from Included tools to open its settings here.' });
    heading.append(title, state);
    const content = createElement('div', { className: 'neconyan-included-tool-content' });
    host.append(heading, content);
    panelBundle.scroller.append(host);
    panelBundle.searchRoot = host;
    // The shell root carries the key too so the phone header can drop the generic Settings blurb.
    const setToolPageKey = key => {
        host.dataset.toolPage = key;
        const root = getShellState('right')?.root;
        if (root) root.dataset.toolPage = key;
    };
    panelBundle.onActivate = async () => {
        const token = ++activationToken;
        const tool = getSelectedIncludedTool();
        if (!tool) {
            neconyanIncludedToolRestore?.();
            neconyanIncludedToolRestore = null;
            title.textContent = 'Included tool';
            state.textContent = 'That tool is unavailable. Return to Extensions to choose another one.';
            content.replaceChildren();
            return;
        }
        title.textContent = tool.label;
        title.hidden = true;
        const shell = getShellState('right');
        const tab = shell?.tabs.get('included-tool');
        if (tab) tab.label = tool.label;
        if (shell?.headerTitle) shell.headerTitle.textContent = tool.label;
        state.textContent = tool.present ? '' : 'This tool is not installed in the current profile.';
        state.hidden = tool.present;
        neconyanIncludedToolRestore?.();
        neconyanIncludedToolRestore = null;
        content.replaceChildren();
        panelBundle.scroller.scrollTop = 0;
        neconyanIncludedToolRestore = () => globalThis.NeconyanExtensions?.restoreMountedUnits?.();
        const mounted = await waitForNeconyanNativeReady(() => {
            if (token !== activationToken) return false;
            if (tool.id === 'pathfinder') {
                return globalThis.NeconyanAgents?.mountPathfinderSettings?.(content);
            }
            return globalThis.NeconyanExtensions?.mountUnit?.(tool.label, content, tool.id);
        }, 4000);
        if (token !== activationToken) return;
        setToolPageKey('');
        void import('./neconyan-tool-tour.js').then(({ getToolPageKey, mountToolPage }) => {
            if (token !== activationToken) return;
            setToolPageKey(mounted ? getToolPageKey(tool.id) : '');
            mountToolPage(mounted ? tool.id : '', heading, host, shell?.headerIntro);
        }).catch(error => console.warn('[Neconyan] Could not load the tool page tour:', error));
        if (!mounted) {
            const message = createElement('p', { className: 'neconyan-included-tool-unavailable', text: `No settings are available for ${tool.label}. Use Manage extensions to install or enable it.` });
            const manage = createElement('button', { className: 'menu_button', text: 'Manage extensions', attrs: { type: 'button' } });
            manage.addEventListener('click', () => { void openNeconyanNativeManage(tool.label); });
            const retry = createElement('button', { className: 'menu_button', text: 'Retry', attrs: { type: 'button' } });
            retry.addEventListener('click', () => { void panelBundle.onActivate(); });
            content.append(message, retry, manage);
            return;
        }
        for (const unit of content.children) {
            const drawer = unit.matches('.inline-drawer') ? unit : unit.querySelector('.inline-drawer');
            if (drawer) setInlineDrawerExpanded(drawer, true);
        }
        neconyanIncludedToolRestore = () => globalThis.NeconyanExtensions?.restoreMountedUnits?.();
    };
    panelBundle.onDeactivate = () => {
        activationToken += 1;
        setToolPageKey('');
        void import('./neconyan-tool-tour.js').then(({ endToolTour }) => endToolTour({ restoreFocus: false })).catch(() => {});
        neconyanIncludedToolRestore?.();
        neconyanIncludedToolRestore = null;
    };
    return panelBundle;
}

const NECONYAN_TOOL_PAGE_ROUTES = Object.freeze({
    pathfinder: 'pathfinder',
    'quick-image-gen': 'quick-image-gen',
    expressions: 'expressions',
    regex: 'regex',
    'sillytavern-character-colors': 'dialogue-colors',
});

function getIncludedToolRailRoute() {
    const selected = normalizeNeconyanNativeToolId(neconyanIncludedToolSelection);
    const key = Object.keys(NECONYAN_TOOL_PAGE_ROUTES).find(id => selected === id || selected.endsWith(`/${id}`));
    return key ? NECONYAN_TOOL_PAGE_ROUTES[key] : 'extensions';
}

// Shell tabs that get the same introduction and assistant tour as the full-page Included tools.
const NN_NATIVE_SHELL_PAGES = Object.freeze({
    'left:api': 'connections',
    'left:presets': 'presets',
    'left:sampling': 'sampling',
    'left:advanced-formatting': 'formatting',
    'left:mewmory': 'mewmory',
    'left:agents': 'agents',
    'right:background': 'background',
    'right:server': 'server',
    'right:console-logs': 'console-logs',
});

// Character drawer tabs with their own assistant tour. Characters and Groups share #rm_characters_block.
const NN_CHARACTER_NATIVE_PAGES = Object.freeze({
    characters: 'character-library',
    groups: 'group-library',
    persona: 'persona',
    import: 'character-import',
});

/**
 * Puts the introduction beneath a shell title, or at the top of a standalone page.
 * @param {string} key Page key from the tool tour
 * @param {HTMLElement|null} host The page's scrolling container
 * @param {HTMLElement|null} [headerHeading] Optional introduction beneath the shell title
 */
function mountNeconyanNativePage(key, host, headerHeading = null) {
    if (!(host instanceof HTMLElement)) return;
    host.dataset.neconyanNativePage = key;
    let heading = host.querySelector(':scope > .neconyan-native-page-heading');
    if (!heading) {
        heading = createElement('div', { className: 'neconyan-native-page-heading' });
        host.prepend(heading);
    }
    if (!headerHeading && heading.dataset.toolPage === key && heading.querySelector('.neconyan-tool-page-intro')) return;
    heading.dataset.toolPage = key;
    void import('./neconyan-tool-tour.js')
        .then(({ mountToolPage }) => {
            if (headerHeading && headerHeading.dataset.toolPage !== key) return;
            if (heading.dataset.toolPage !== key) return;
            mountToolPage(key, heading, host, headerHeading);
        })
        .catch(error => console.warn('[Neconyan] Could not load the page tour:', error));
}

function syncNeconyanNativeShellPage(shellKey, tabId) {
    const key = NN_NATIVE_SHELL_PAGES[`${shellKey}:${tabId}`] ?? '';
    const shellState = getShellState(shellKey);
    const headerHeading = shellState?.headerIntro;
    if (headerHeading) {
        headerHeading.replaceChildren();
        headerHeading.dataset.toolPage = key;
    }
    const root = document.getElementById(getShellConfig(shellKey)?.rootPanelId ?? '');
    if (root instanceof HTMLElement) root.dataset.neconyanNativePage = key;
    if (!key) return;
    const panel = shellState?.tabs.get(tabId)?.panel;
    mountNeconyanNativePage(key, panel?.querySelector(':scope > .sb-shell-panel-scroller') ?? null, headerHeading);
}

/**
 * Opens an included tool as its own full page beside the rail.
 * @param {string} id Tool id from NECONYAN_NATIVE_TOOL_DEFINITIONS
 * @returns {boolean} Whether the tool was found
 */
function openNeconyanIncludedToolPage(id) {
    const wanted = normalizeNeconyanNativeToolId(id);
    const tool = getNeconyanNativeTools().find(item => {
        const itemId = normalizeNeconyanNativeToolId(item.id);
        return itemId === wanted || itemId.endsWith(`/${wanted}`);
    });
    if (!tool) return false;
    void openNeconyanNativeExtensionSettings(tool);
    return true;
}

async function openNeconyanNativeExtensionSettings(tool) {
    closeMobileNav();
    neconyanIncludedToolSelection = tool.id || tool.label;
    safeSetItem(NECONYAN_INCLUDED_TOOL_STORAGE_KEY, neconyanIncludedToolSelection);
    openShell('right', 'included-tool');
    return true;
}

async function openNeconyanNativeManage(label = '') {
    try {
        closeMobileNav();
        openShell('right', 'extensions');
        const details = await waitForNeconyanNativeReady('#extensions_details');
        if (!(details instanceof HTMLElement)) {
            globalThis.toastr?.warning?.('Extension management is unavailable right now.', 'Extensions');
            return false;
        }
        details.click();
        if (label) {
            await focusNeconyanNativeManagerRow(label);
        }
        return true;
    } catch (error) {
        console.error('Could not open extension management.', error);
        return false;
    }
}

async function clickNeconyanNativeLauncher(selector) {
    const target = await waitForNeconyanNativeReady(selector);
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    target.click();
    return true;
}

function explainNeconyanNativeCharacterContext(tool) {
    const message = tool.open === 'story-mode'
        ? 'Choose or create a character before opening Story Mode.'
        : 'Choose or create a character before opening Meower.';
    globalThis.toastr?.info?.(message, tool.label);
}

async function focusNeconyanCharacterAction() {
    const action = await waitForNeconyanNativeReady(() => document.querySelector('#rm_button_create, #character_import_button, #rm_button_group_chats, #character_select'));
    action?.focus?.({ preventScroll: true });
}

async function openNeconyanNativeTool(tool) {
    closeMobileNav();
    try {
        switch (tool.open) {
            case 'presets':
                openShell('left', 'presets');
                return true;
            case 'botsearcher':
                openCharacterPanelTab('import');
                if (await clickNeconyanNativeLauncher('#sbbs_import_action')) return true;
                return openNeconyanNativeExtensionSettings(tool);
            case 'world-info-lab':
                if (await clickNeconyanNativeLauncher('#sbwil-menu-item')) return true;
                return openNeconyanNativeExtensionSettings(tool);
            case 'prompting-lab':
                if (await clickNeconyanNativeLauncher('#sbpl-menu-item')) return true;
                return openNeconyanNativeExtensionSettings(tool);
            case 'debugger':
                if (await clickNeconyanNativeLauncher('#sbdbg-menu-item')) return true;
                return openNeconyanNativeExtensionSettings(tool);
            case 'chat-archive':
                if (await clickNeconyanNativeLauncher('#sbca_drawer_button')) return true;
                return openNeconyanNativeManage(tool.label);
            case 'css-snippets':
                if (await clickNeconyanNativeLauncher('#csss_manager_button')) return true;
                return openNeconyanNativeManage(tool.label);
            case 'distiller':
                if (await clickNeconyanNativeLauncher('#sbld-menu-item')) return true;
                return openNeconyanNativeManage(tool.label);
            case 'time-machine':
                if (await clickNeconyanNativeLauncher('#sbctm-menu-item')) return true;
                return openNeconyanNativeExtensionSettings(tool);
            case 'story-mode':
            case 'meower': {
                const selector = tool.open === 'story-mode' ? '#sbstory-mode-button' : '#sbtw-launch-button';
                if (await clickNeconyanNativeLauncher(selector)) return true;
                openCharacterPanelTab('characters');
                if (await clickNeconyanNativeLauncher(selector)) return true;
                explainNeconyanNativeCharacterContext(tool);
                await focusNeconyanCharacterAction();
                return false;
            }
            default:
                return false;
        }
    } catch (error) {
        console.error(`Could not open ${tool.label}.`, error);
        globalThis.toastr?.warning?.(`${tool.label} could not be opened. Use Manage extensions to inspect it.`, 'Extensions');
        return false;
    }
}

function updateNeconyanNativeToolSummary(details, summary) {
    summary.setAttribute('aria-expanded', String(details.open));
    summary.querySelector('.neconyan-native-tool-chevron')?.classList.toggle('is-open', details.open);
}

function nativeToolKey(tool) {
    return normalizeNeconyanNativeToolId(tool.id || tool.label).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function renderNeconyanNativeToolList(host, scope = 'rail') {
    if (!(host instanceof HTMLElement)) return;

    const existingOpen = new Set(Array.from(host.querySelectorAll('details[data-neconyan-native-tool-key]'))
        .filter(details => details instanceof HTMLDetailsElement && details.open)
        .map(details => details.getAttribute('data-neconyan-native-tool-key')));
    existingOpen.forEach(key => neconyanNativeToolOpenState.set(key, true));
    const previousFocusKey = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest('[data-neconyan-native-tool-key]')?.getAttribute('data-neconyan-native-tool-key')
        : '';

    host.replaceChildren();
    for (const tool of getNeconyanNativeTools()) {
        const key = nativeToolKey(tool);
        const summaryId = `neconyan-${scope}-${key}-summary`;
        const panelId = `neconyan-${scope}-${key}-panel`;
        const details = createElement('details', {
            className: 'neconyan-native-tool',
            attrs: {
                'data-neconyan-native-tool': 'true',
                'data-neconyan-native-tool-key': key,
                'data-neconyan-extension-id': tool.id,
            },
        });
        details.open = neconyanNativeToolOpenState.get(key) ?? existingOpen.has(key);

        const summary = createElement('summary', {
            id: summaryId,
            className: 'neconyan-native-tool-summary',
            attrs: {
                'aria-controls': panelId,
                'aria-expanded': String(details.open),
            },
        });
        summary.append(
            createElement('i', { className: `fa-solid ${tool.icon} neconyan-native-tool-icon`, attrs: { 'aria-hidden': 'true' } }),
            createElement('span', { className: 'neconyan-native-tool-name', text: tool.label }),
            createElement('span', {
                className: `neconyan-native-tool-state ${tool.enabled ? 'is-enabled' : 'is-disabled'}`,
                text: tool.present ? (tool.enabled ? 'On' : 'Off') : 'Unavailable',
                attrs: { 'data-state': tool.present ? (tool.enabled ? 'enabled' : 'disabled') : 'missing' },
            }),
            createElement('i', { className: 'fa-solid fa-chevron-down neconyan-native-tool-chevron', attrs: { 'aria-hidden': 'true' } }),
        );

        const panel = createElement('div', {
            id: panelId,
            className: 'neconyan-native-tool-panel',
            attrs: { role: 'group', 'aria-labelledby': summaryId },
        });
        const actions = createElement('div', { className: 'neconyan-native-tool-actions' });
        const actionNames = tool.enabled ? tool.actions : tool.actions.filter(action => action === 'settings');
        for (const actionName of actionNames) {
            const button = createElement('button', {
                className: `neconyan-native-tool-action neconyan-native-tool-action-${actionName}`,
                text: nativeToolActionLabel(actionName),
                attrs: {
                    type: 'button',
                    'data-neconyan-native-tool-action': actionName,
                    'aria-label': actionName === 'settings' ? t`Settings ${tool.label}` : t`Open ${tool.label}`,
                },
            });
            button.addEventListener('click', () => {
                if (button.disabled) return;
                button.disabled = true;
                button.setAttribute('aria-busy', 'true');
                Promise.resolve(actionName === 'settings'
                    ? openNeconyanNativeExtensionSettings(tool)
                    : openNeconyanNativeTool(tool))
                    .catch(error => {
                        console.error(`Could not run ${actionName} for ${tool.label}.`, error);
                    })
                    .finally(() => {
                        button.disabled = false;
                        button.removeAttribute('aria-busy');
                    });
            });
            actions.appendChild(button);
        }

        const manage = createElement('button', {
            className: 'neconyan-native-tool-action neconyan-native-tool-action-manage',
            text: nativeToolActionLabel('manage'),
            attrs: {
                type: 'button',
                'data-neconyan-native-tool-action': 'manage',
                'aria-label': t`Manage extensions for ${tool.label}`,
            },
        });
        manage.addEventListener('click', () => {
            if (manage.disabled) return;
            manage.disabled = true;
            manage.setAttribute('aria-busy', 'true');
            Promise.resolve(openNeconyanNativeManage())
                .catch(error => console.error(`Could not manage ${tool.label}.`, error))
                .finally(() => {
                    manage.disabled = false;
                    manage.removeAttribute('aria-busy');
                });
        });
        actions.appendChild(manage);
        panel.appendChild(actions);
        details.append(summary, panel);

        summary.addEventListener('click', () => {
            if (document.documentElement.dataset.neconyanSidebar === 'closed') {
                document.getElementById('neconyan-sidebar-toggle')?.click();
            }
        });
        details.addEventListener('toggle', () => {
            neconyanNativeToolOpenState.set(key, details.open);
            updateNeconyanNativeToolSummary(details, summary);
        });
        host.appendChild(details);
    }

    if (previousFocusKey) {
        host.querySelector(`[data-neconyan-native-tool-key="${CSS.escape(previousFocusKey)}"] summary`)?.focus({ preventScroll: true });
    }
}

function mountNeconyanNativeTools() {
    document.querySelectorAll('[data-neconyan-native-tool-list]').forEach((host, index) => {
        renderNeconyanNativeToolList(host, index === 0 ? 'rail' : 'mobile');
    });
}

function bindNeconyanNativeToolEvents() {
    if (neconyanNativeToolsBound || !eventSource?.on) return;
    neconyanNativeToolsBound = true;
    const refresh = () => {
        if (neconyanNativeToolsRefreshFrame) return;
        neconyanNativeToolsRefreshFrame = window.requestAnimationFrame(() => {
            neconyanNativeToolsRefreshFrame = 0;
            mountNeconyanNativeTools();
        });
    };
    for (const eventName of [event_types.APP_READY, event_types.EXTENSION_SETTINGS_LOADED, event_types.EXTENSION_DISABLED]) {
        if (eventName) eventSource.on(eventName, refresh);
    }
    globalThis.NeconyanNativeTools = {
        mount: mountNeconyanNativeTools,
        refresh,
        getDefinitions: () => NECONYAN_NATIVE_TOOL_DEFINITIONS,
        openSettings: tool => openNeconyanNativeExtensionSettings(tool),
    };
    refresh();
}

bindNeconyanNativeToolEvents();

function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function isNeconyanNativeTargetUsable(target) {
    return target instanceof HTMLElement
        && !target.hidden
        && target.getAttribute('aria-hidden') !== 'true'
        && !target.matches(':disabled, [aria-disabled="true"]');
}

async function waitForNeconyanNativeReady(resolveTarget, timeout = 1000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeout) {
        const target = typeof resolveTarget === 'function' ? resolveTarget() : document.querySelector(resolveTarget);
        if (isNeconyanNativeTargetUsable(target)) {
            return target;
        }

        const remaining = timeout - (Date.now() - startedAt);
        if (remaining <= 0) {
            break;
        }
        await wait(Math.min(40, remaining));
    }
    return null;
}

function normalizeCharacterEditorSubTab(tabId) {
    const normalizedTabId = normalizeText(tabId);
    return NN_CHARACTER_EDITOR_SUB_TABS.includes(normalizedTabId) ? normalizedTabId : NN_CHARACTER_EDITOR_DEFAULT_SUB_TAB;
}

function isCharacterSpoilerFreeFieldsHidden() {
    const form = document.getElementById('form_create');
    return form instanceof HTMLElement && form.dataset.sbSpoilerFreeFieldsHidden === 'true';
}

function isCharacterEditorSubTabSpoilerHidden(tabId) {
    return isCharacterSpoilerFreeFieldsHidden()
        && !NN_CHARACTER_EDITOR_SPOILER_FREE_VISIBLE_TABS.includes(normalizeCharacterEditorSubTab(tabId));
}

function resolveCharacterEditorSubTab(tabId) {
    const normalizedTabId = normalizeCharacterEditorSubTab(tabId);
    return isCharacterEditorSubTabSpoilerHidden(normalizedTabId) ? 'metadata' : normalizedTabId;
}

function isCharacterEditorMenuType(menuType) {
    return ['character_edit', 'create'].includes(menuType ?? '');
}

// Reads visible words with a space between elements, so a drawer title and its caption do not
// run together, and skips the option lists of dropdowns.
function getSearchElementText(element) {
    if (!(element instanceof Element) || element instanceof HTMLSelectElement) {
        return '';
    }

    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement?.closest('option, optgroup, select, script, style, template, svg')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) {
        parts.push(walker.currentNode.nodeValue);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function getSearchHeadingText(element, { readable = false } = {}) {
    if (!readable || !element?.matches?.('.inline-drawer-toggle, .inline-drawer-header')) {
        return '';
    }
    return getSearchElementText(element.querySelector('b, strong') ?? element);
}

function getSearchTextCandidates(element, { readable = false } = {}) {
    const readText = node => (readable ? getSearchElementText(node) : node?.textContent);
    const extensionContainer = element.closest('.extension_container');
    const extensionName = readText(extensionContainer?.querySelector('.extension_name')) ?? '';
    const candidates = [
        element.dataset.sbSearchLabel,
        getSearchHeadingText(element, { readable }),
        element.matches('.extension_name') ? readText(element) : '',
        extensionName,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : '',
        element instanceof HTMLSelectElement ? element.selectedOptions?.[0]?.textContent : '',
        element.matches('.range-block, .range-block-title, .range-block-header')
            ? readText(element.closest('.range-block')?.querySelector('.range-block-title, .range-block-header, label, strong, h4, h5'))
            : '',
        element.matches('.extension_container, .extension_name')
            ? readText(extensionContainer?.querySelector('.extension_name, .inline-drawer-header, .inline-drawer-toggle, h3, h4, strong'))
            : '',
        readText(element),
    ];

    return candidates
        .map(candidate => String(candidate ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((candidate, index, collection) => collection.indexOf(candidate) === index);
}

function getSearchDisplayText(element, fallback = '', { readable = false } = {}) {
    const headingText = getSearchHeadingText(element, { readable });
    if (headingText) {
        return clampText(headingText, 110);
    }
    const candidates = getSearchTextCandidates(element, { readable });
    const normalizedFallback = normalizeText(fallback);
    const preferredCandidate = candidates.find(candidate => normalizeText(candidate) !== normalizedFallback);
    return clampText(preferredCandidate || candidates[0] || fallback, 110);
}

function getSearchText(element, sectionLabel = '', { readable = false } = {}) {
    return normalizeText([
        ...getSearchTextCandidates(element, { readable }),
        sectionLabel,
    ].join(' '));
}

function getSearchWordStartPattern(term) {
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(term)}`, 'u');
}

function hasSearchWordStarts(text, patterns) {
    return patterns.every(pattern => pattern.test(text));
}

// Ranks a result by where the words land: the item's own name first, then its section, then
// anything else it mentions (tooltips, placeholders, page keywords).
function scoreSearchEntry(entry, query, patterns) {
    const label = normalizeText(entry.displayText);
    const section = normalizeText(entry.sectionLabel);
    // Page names win ties with settings of the same name: the page is usually where you want to go.
    const pageBonus = entry.kind === 'page' ? 20 : 0;
    const lengthPenalty = label.length / 1000;

    if (label === query) return { score: 100 + pageBonus - lengthPenalty, sectionOnly: false };
    if (label.startsWith(query)) return { score: 80 + pageBonus - lengthPenalty, sectionOnly: false };
    if (hasSearchWordStarts(label, patterns)) return { score: 60 + pageBonus - lengthPenalty, sectionOnly: false };
    if (entry.kind === 'page') {
        // 'model' is exactly a keyword of Connections; 'temp' only starts one of New chat's.
        const keywordScore = entry.keywords?.includes(query) ? 75 : 45;
        return { score: keywordScore - lengthPenalty, sectionOnly: false };
    }
    if (section && (section === query || hasSearchWordStarts(section, patterns))) {
        return { score: 30 - lengthPenalty, sectionOnly: true };
    }
    return { score: 10 - lengthPenalty, sectionOnly: false };
}

function isSearchElementSwitchedOff(element) {
    let current = element instanceof HTMLElement ? element.closest(NN_SEARCH_SOURCE_GATED_SELECTOR) : null;

    while (current) {
        if (current.style.display === 'none') {
            return true;
        }
        current = current.parentElement?.closest(NN_SEARCH_SOURCE_GATED_SELECTOR) ?? null;
    }

    return false;
}

function getPersonaSearchAvatarId(element) {
    if (!(element instanceof HTMLElement)) {
        return '';
    }

    const directAvatarId = element.closest('.avatar-container[data-avatar-id], .avatar[data-avatar-id]')?.getAttribute('data-avatar-id');
    if (directAvatarId) {
        return directAvatarId;
    }

    if (!element.matches('.persona_name')) {
        return '';
    }

    return document.querySelector('#user_avatar_block .avatar-container.selected[data-avatar-id]')?.getAttribute('data-avatar-id')
        ?? '';
}

function getSearchEntryDedupeKey(tabState, sectionLabel, displayText, { element = null, avatarId = '' } = {}) {
    const personaAvatarId = tabState.id === 'persona'
        ? normalizeText(
            avatarId
            || getPersonaSearchAvatarId(element),
        )
        : '';

    if (personaAvatarId) {
        return `persona::${personaAvatarId}`;
    }

    return [
        tabState.id,
        normalizeText(sectionLabel),
        normalizeText(displayText),
    ].filter(Boolean).join('::');
}

function getUniversalSearchState() {
    return nnState.universalSearch;
}

function renderSearchEmptyState(container, title, detail) {
    container.replaceChildren();

    const empty = createElement('div', { className: 'sb-search-empty' });
    const emptyTitle = createElement('strong', { text: title });
    const emptyCopy = createElement('span', { text: detail });
    empty.append(emptyTitle, emptyCopy);
    container.appendChild(empty);
}

function focusUniversalSearchInput(input) {
    if (!(input instanceof HTMLInputElement)) {
        return;
    }

    const applyFocus = () => {
        input.focus({ preventScroll: true });
        input.select();
    };

    applyFocus();
    window.requestAnimationFrame(applyFocus);
}

function requestMobileViewportReset({ restoreScroll = false } = {}) {
    if (!isMobileViewport() || typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
        return;
    }

    const dispatchReset = () => window.dispatchEvent(new CustomEvent('sb-mobile-viewport-reset', {
        detail: { restoreScroll: Boolean(restoreScroll) },
    }));

    if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(dispatchReset);
    } else {
        dispatchReset();
    }

    window.setTimeout(dispatchReset, NN_MOBILE_VIEWPORT_RESET_FOLLOWUP_MS);
}

function setUniversalSearchOpenState(isOpen, { focusInput = false } = {}) {
    const searchState = getUniversalSearchState();
    const row = searchState.row;
    const root = searchState.root;
    const input = searchState.input;
    const nextOpenState = Boolean(isOpen);
    const wasOpen = Boolean(searchState.expanded);

    searchState.expanded = nextOpenState;
    row?.classList.toggle('is-open', nextOpenState);
    row?.setAttribute('aria-hidden', String(!nextOpenState));
    root?.classList.toggle('is-open', nextOpenState);
    root?.setAttribute('aria-expanded', String(nextOpenState));
    if (input instanceof HTMLInputElement) {
        input.tabIndex = nextOpenState ? 0 : -1;
        input.setAttribute('aria-expanded', String(nextOpenState));
    }

    if (!nextOpenState) {
        searchState.results?.classList.remove('is-visible');
        if (wasOpen) {
            requestMobileViewportReset({ restoreScroll: true });
        }
    } else {
        renderUniversalSearchResults(input?.value ?? '');
    }

    if (focusInput && input instanceof HTMLInputElement) {
        focusUniversalSearchInput(input);
    }

    queueMobileShellDrawerBoundsSync();
    syncShortcutButtonActiveStates();
}

function clearUniversalSearch({ blur = false } = {}) {
    const searchState = getUniversalSearchState();

    if (searchState.input instanceof HTMLInputElement) {
        searchState.input.value = '';
        if (blur && document.activeElement === searchState.input) {
            searchState.input.blur();
        }
    }

    if (searchState.results instanceof HTMLElement) {
        searchState.results.replaceChildren();
        searchState.results.classList.remove('is-visible');
    }

    searchState.activeIndex = -1;
    searchState.input?.removeAttribute('aria-activedescendant');
    setUniversalSearchOpenState(false);
}

function isActuallyVisible(element) {
    return Boolean(element) && element.getClientRects().length > 0;
}

function getShellState(shellKey) {
    return nnState.shells[shellKey];
}

function getShellConfig(shellKey) {
    return NN_SHELLS[shellKey];
}

function getCharacterPanelTabConfig(tabId) {
    return NN_CHARACTER_PANEL_TABS.find(tab => tab.id === tabId) ?? null;
}

function normalizeCharacterPanelTab(tabId) {
    const normalizedTabId = normalizeText(tabId);
    return getCharacterPanelTabConfig(normalizedTabId) ? normalizedTabId : NN_CHARACTER_PANEL_DEFAULT_TAB;
}

function getCharacterPanelSearchEntries() {
    const panel = getCharacterPanel();

    return NN_CHARACTER_PANEL_TABS.map((tab) => {
        const button = panel?.querySelector(`[data-sb-character-tab="${CSS.escape(tab.id)}"]`);
        const searchText = normalizeText([
            tab.label,
            tab.id,
            'characters',
            tab.id === 'world-info' ? 'lore lorebook lorebooks' : '',
        ].join(' '));

        return {
            element: button instanceof HTMLElement ? button : null,
            searchText,
            displayText: tab.label,
            sectionLabel: tab.label,
            tabId: tab.id,
            tabLabel: tab.label,
            kind: 'tab',
            advanced: NN_ADVANCED_SEARCH_ROUTES.has(`characters:${tab.id}`),
            dedupeKey: `characters::${tab.id}`,
        };
    });
}

function isMobileViewport() {
    return window.matchMedia(NN_MOBILE_MEDIA_QUERY).matches;
}

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getShellProxyButton(shellKey) {
    const shellConfig = getShellConfig(shellKey);
    const proxyButton = shellConfig?.proxyButtonId ? document.getElementById(shellConfig.proxyButtonId) : null;

    if (proxyButton instanceof HTMLElement && isActuallyVisible(proxyButton)) {
        return proxyButton;
    }

    // Neconyan: Workspace and Customize are hidden in icons-only mode, and Workspace is also
    // hidden on phones. Fall back to the cluster icon so focus does not silently drop to <body>.
    const activeTabId = getShellState(shellKey)?.activeTabId;
    const pageButton = activeTabId
        ? document.querySelector(`[data-sb-topbar-page="${CSS.escape(`${shellKey}:${activeTabId}`)}"]`)
        : null;

    if (pageButton instanceof HTMLElement && isActuallyVisible(pageButton)) {
        return pageButton;
    }

    return proxyButton instanceof HTMLElement ? proxyButton : null;
}

function getShellActivePanel(shellState) {
    return shellState?.tabs.get(shellState.activeTabId)?.panel ?? null;
}

function getShellFocusTarget(shellState) {
    if (shellState?.headerTitle instanceof HTMLElement) {
        return shellState.headerTitle;
    }

    const panel = getShellActivePanel(shellState);
    const focusable = Array.from(panel?.querySelectorAll(NN_SHELL_FOCUSABLE_SELECTOR) ?? [])
        .find(element => element instanceof HTMLElement
            && isActuallyVisible(element)
            && !element.closest('[hidden], [aria-hidden="true"], [inert]'));

    if (focusable instanceof HTMLElement) {
        return focusable;
    }

    return shellState?.nav instanceof HTMLElement ? shellState.nav : null;
}

function focusShellPanel(shellKey, { force = false } = {}) {
    const shellState = getShellState(shellKey);
    const shellRoot = shellState?.root;

    if (!(shellRoot instanceof HTMLElement) || !shellRoot.classList.contains('openDrawer')) {
        return;
    }

    const activeElement = document.activeElement;
    if (!force && activeElement instanceof HTMLElement && shellRoot.contains(activeElement)) {
        return;
    }

    const target = getShellFocusTarget(shellState);
    if (target instanceof HTMLElement) {
        target.focus({ preventScroll: true });
    }
}

function rememberShellFocusOrigin(shellKey) {
    const shellState = getShellState(shellKey);
    const shellRoot = shellState?.root;
    const activeElement = document.activeElement;

    if (!shellState || !(activeElement instanceof HTMLElement)) {
        return;
    }

    if (shellRoot instanceof HTMLElement && shellRoot.contains(activeElement)) {
        return;
    }

    shellState.restoreFocusTarget = activeElement;
}

function restoreShellFocus(shellKey) {
    const shellState = getShellState(shellKey);
    const restoreTarget = shellState?.restoreFocusTarget;
    const proxyButton = getShellProxyButton(shellKey);
    const target = restoreTarget instanceof HTMLElement && document.contains(restoreTarget)
        ? restoreTarget
        : proxyButton;

    if (shellState) {
        delete shellState.restoreFocusTarget;
    }

    if (target instanceof HTMLElement && !target.hasAttribute('disabled')) {
        target.focus({ preventScroll: true });
    }
}

function getLayoutViewportScrollAnchor() {
    const scrollingElement = document.scrollingElement;

    return {
        left: Math.max(0, Math.round(window.scrollX || scrollingElement?.scrollLeft || 0)),
        top: Math.max(0, Math.round(window.scrollY || scrollingElement?.scrollTop || 0)),
    };
}

function restoreLayoutViewportScroll(anchor) {
    if (!anchor) {
        return;
    }

    const scrollingElement = document.scrollingElement;
    if (scrollingElement instanceof Element) {
        scrollingElement.scrollLeft = anchor.left;
        scrollingElement.scrollTop = anchor.top;
    }

    if (window.scrollX !== anchor.left || window.scrollY !== anchor.top) {
        window.scrollTo(anchor.left, anchor.top);
    }
}

function queueLayoutViewportScrollRestore(anchor) {
    restoreLayoutViewportScroll(anchor);
    window.requestAnimationFrame(() => restoreLayoutViewportScroll(anchor));
    window.setTimeout(() => restoreLayoutViewportScroll(anchor), 120);
}

function getManagedScrollContainer(target) {
    if (!(target instanceof HTMLElement)) {
        return null;
    }

    return target.closest('.sb-shell-panel-scroller, .scrollableInner, .scrollableInnerFull, .sb-search-results, #chat');
}

function scrollElementIntoManagedView(target, { block = 'nearest', behavior = 'auto' } = {}) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const anchor = getLayoutViewportScrollAnchor();
    const scroller = getManagedScrollContainer(target);

    if (!(scroller instanceof HTMLElement) || scroller.clientHeight <= 0) {
        target.scrollIntoView({ block, behavior });
        queueLayoutViewportScrollRestore(anchor);
        return false;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const topOverflow = targetRect.top - scrollerRect.top;
    const bottomOverflow = targetRect.bottom - scrollerRect.bottom;
    let delta = 0;

    if (block === 'center') {
        delta = topOverflow - ((scrollerRect.height - targetRect.height) / 2);
    } else if (block === 'end') {
        delta = bottomOverflow;
    } else if (block === 'start') {
        delta = topOverflow;
    } else if (topOverflow < 0) {
        delta = topOverflow;
    } else if (bottomOverflow > 0) {
        delta = bottomOverflow;
    }

    if (Math.abs(delta) > 1) {
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTo({
            top: clampNumber(scroller.scrollTop + delta, 0, maxScrollTop),
            behavior,
        });
    }

    queueLayoutViewportScrollRestore(anchor);
    return true;
}

function scrollShellTabButtonIntoView(nav, button, { smooth = false } = {}) {
    if (!(nav instanceof HTMLElement) || !(button instanceof HTMLElement)) {
        return;
    }

    if (!isActuallyVisible(button)) {
        return;
    }

    const navRect = nav.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const behavior = smooth && !prefersReducedMotion() ? 'smooth' : 'auto';

    if (nav.getAttribute('aria-orientation') === 'vertical') {
        const topOverflow = buttonRect.top - navRect.top;
        const bottomOverflow = buttonRect.bottom - navRect.bottom;
        if (topOverflow >= 0 && bottomOverflow <= 0) {
            return;
        }
        nav.scrollBy({ top: topOverflow < 0 ? topOverflow : bottomOverflow, behavior });
        return;
    }

    const leftOverflow = buttonRect.left - navRect.left;
    const rightOverflow = buttonRect.right - navRect.right;

    if (leftOverflow >= 0 && rightOverflow <= 0) {
        return;
    }

    nav.scrollBy({
        left: leftOverflow < 0 ? leftOverflow : rightOverflow,
        behavior,
    });
}

function isTouchOnlyDesktopViewport() {
    const hasHover = window.matchMedia('(hover: hover), (any-hover: hover)').matches;
    const hasFinePointer = window.matchMedia('(pointer: fine), (any-pointer: fine)').matches;
    const isTouchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

    return isTouchMac || (navigator.maxTouchPoints > 0 && !hasHover && !hasFinePointer);
}

function canResizeDesktopShells() {
    return !isMobileViewport() && !isTouchOnlyDesktopViewport();
}

function readFiniteViewportNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function getLayoutViewportSize() {
    const doc = document.documentElement;
    const fallbackWidth = window.innerWidth || doc?.clientWidth || 0;
    const fallbackHeight = window.innerHeight || doc?.clientHeight || 0;

    const width = Math.max(0, Math.round(readFiniteViewportNumber(fallbackWidth, 0)));
    const height = Math.max(0, Math.round(readFiniteViewportNumber(fallbackHeight, 0)));

    return {
        width,
        height,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };
}

function getVisualViewportSize(fallbackViewport = getLayoutViewportSize()) {
    const visualViewport = window.visualViewport;
    const fallbackWidth = fallbackViewport.width;
    const fallbackHeight = fallbackViewport.height;
    const width = Math.max(0, Math.round(readFiniteViewportNumber(visualViewport?.width, fallbackWidth)));
    const height = Math.max(0, Math.round(readFiniteViewportNumber(visualViewport?.height, fallbackHeight)));

    return {
        width,
        height,
        left: Math.max(0, Math.round(readFiniteViewportNumber(visualViewport?.offsetLeft, 0))),
        top: Math.max(0, Math.round(readFiniteViewportNumber(visualViewport?.offsetTop, 0))),
        right: width,
        bottom: height,
    };
}

function isEditableElement(element) {
    return element instanceof HTMLElement
        && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable);
}

function isMobileShellPanelEditableElement(element) {
    return isEditableElement(element)
        && Boolean(element.closest('#left-nav-panel, #user-settings-block, .sb-shell-root, #right-nav-panel'));
}

function isChatComposerEditableElement(element) {
    return isEditableElement(element)
        && Boolean(element.closest('#send_textarea, #send_form, #form_sheld'));
}

function hasOpenMobileShellDrawer() {
    return getMobileShellBoundDrawers().some(drawer => drawer.classList.contains('openDrawer'));
}

function shouldUseStableIOSPanelViewport(layoutViewport, visualViewportSize) {
    if (!isIOSWebKitPlatform() || !isVisualViewportKeyboardOpen(layoutViewport, visualViewportSize)) {
        return false;
    }

    if (isMobileViewport() && !isLegacyIOSWebKitPlatform()) {
        return false;
    }

    const activeElement = document.activeElement;
    if (isChatComposerEditableElement(activeElement)) {
        return false;
    }

    return isMobileShellPanelEditableElement(activeElement) || hasOpenMobileShellDrawer();
}

const MOBILE_COMPOSER_KEYBOARD_PAN_EPSILON_PX = 8;
const MOBILE_COMPOSER_KEYBOARD_PRESHIFT_WINDOW_MS = 700;
const MOBILE_IOS_KEYBOARD_MIN_HEIGHT_PX = 80;

let nnLastIOSKeyboardHeight = 0;
let nnComposerKeyboardPreShiftDeadline = 0;
let nnComposerKeyboardSettleTimer = 0;

function isVisualViewportKeyboardOpen(layoutViewport = getLayoutViewportSize(), visualViewportSize = getVisualViewportSize(layoutViewport)) {
    const keyboardHeight = Math.max(0, layoutViewport.height - visualViewportSize.height);
    return keyboardHeight > MOBILE_IOS_KEYBOARD_MIN_HEIGHT_PX || visualViewportSize.top > 2;
}

/**
 * Neconyan: old iOS versions can force-scroll the document to reveal the
 * composer caret. Shrink the stable shell by the keyboard height before that
 * reveal while preserving the modern viewport behavior on iOS 26 and newer.
 */
function getComposerKeyboardInset(layoutViewport, visualViewportSize) {
    if (!isLegacyIOSWebKitPlatform() || !isMobileViewport()) {
        return 0;
    }

    const keyboardHeight = Math.max(0, layoutViewport.height - visualViewportSize.height);
    if (keyboardHeight > MOBILE_IOS_KEYBOARD_MIN_HEIGHT_PX) {
        nnLastIOSKeyboardHeight = keyboardHeight;
    }

    if (!isChatComposerEditableElement(document.activeElement)) {
        return 0;
    }

    const withinPreShiftWindow = Date.now() < nnComposerKeyboardPreShiftDeadline;

    if (isVisualViewportKeyboardOpen(layoutViewport, visualViewportSize)) {
        // Do not shrink after Safari has already panned, which would recreate
        // the empty space below the escaped composer.
        if (visualViewportSize.top > MOBILE_COMPOSER_KEYBOARD_PAN_EPSILON_PX) {
            return 0;
        }

        return withinPreShiftWindow ? Math.max(keyboardHeight, nnLastIOSKeyboardHeight) : keyboardHeight;
    }

    return withinPreShiftWindow ? nnLastIOSKeyboardHeight : 0;
}

function handleComposerKeyboardFocusIn(event) {
    if (!isLegacyIOSWebKitPlatform() || !isMobileViewport()) {
        return;
    }

    if (isChatComposerEditableElement(event.target)) {
        nnComposerKeyboardPreShiftDeadline = Date.now() + MOBILE_COMPOSER_KEYBOARD_PRESHIFT_WINDOW_MS;
        window.clearTimeout(nnComposerKeyboardSettleTimer);
        nnComposerKeyboardSettleTimer = window.setTimeout(queueMobileViewportStateSync, MOBILE_COMPOSER_KEYBOARD_PRESHIFT_WINDOW_MS + 50);
    }

    queueMobileViewportStateSync();
}

function handleMobileKeyboardFocusOut() {
    if (!isLegacyIOSWebKitPlatform() || !isMobileViewport()) {
        return;
    }

    queueMobileViewportStateSync();
}

function syncIOSKeyboardBottomInset() {
    const root = document.documentElement;
    let bottomInset = 0;
    let composerControlsActive = false;

    if (isIOSWebKitPlatform()) {
        const layoutViewport = getLayoutViewportSize();
        const visualViewportSize = getVisualViewportSize(layoutViewport);

        if (isVisualViewportKeyboardOpen(layoutViewport, visualViewportSize)) {
            if (isMobileViewport() && !isLegacyIOSWebKitPlatform()) {
                composerControlsActive = isChatComposerEditableElement(document.activeElement);
            } else {
                bottomInset = Math.max(0, Math.round(layoutViewport.height - visualViewportSize.top - visualViewportSize.height));
            }
        }
    }

    const value = `${bottomInset}px`;
    if (root.style.getPropertyValue('--sb-ios-keyboard-bottom-inset') !== value) {
        root.style.setProperty('--sb-ios-keyboard-bottom-inset', value);
    }

    // Neconyan: the <=768px shell CSS consumes the inset var directly; wide
    // viewports (iPadOS desktop-mode Safari) gate the padding on this class so
    // desktop layouts only pick it up while the software keyboard is open.
    root.classList.toggle('sb-ios-keyboard-inset-active', bottomInset > 0);
    root.classList.toggle('sb-ios-composer-keyboard-controls-active', composerControlsActive);
}

function getShellViewportSize() {
    const layoutViewport = getLayoutViewportSize();
    const visualViewportSize = getVisualViewportSize(layoutViewport);

    const composerKeyboardInset = getComposerKeyboardInset(layoutViewport, visualViewportSize);
    if (composerKeyboardInset > 0) {
        const height = Math.max(0, layoutViewport.height - composerKeyboardInset);
        return { ...layoutViewport, height, bottom: height };
    }

    // Older iOS and wide iPad panels retain the stable layout; modern phone
    // panels fit the visible viewport without a second keyboard-sized reserve.
    if (shouldUseStableIOSPanelViewport(layoutViewport, visualViewportSize)) {
        return layoutViewport;
    }

    return visualViewportSize;
}

function syncShellViewportBounds() {
    if (nnIsSyncingRailActions) {
        return;
    }

    const root = document.documentElement;
    const viewportSize = getShellViewportSize();
    const topOffset = Math.max(0, Math.round(getResolvedShellTopbarOffset()));
    const composerKeyboardInset = getComposerKeyboardInset(getLayoutViewportSize(), getVisualViewportSize());
    const setRootViewportProperty = (property, value) => {
        if (root.style.getPropertyValue(property) !== value) {
            root.style.setProperty(property, value);
        }
    };

    setRootViewportProperty('--sb-shell-viewport-height', `${viewportSize.height}px`);
    setRootViewportProperty('--sb-shell-measured-top-offset', `${topOffset}px`);
    setRootViewportProperty('--sb-shell-available-height', `${Math.max(0, viewportSize.height - topOffset)}px`);
    // Neconyan: Safari can pan the visible viewport without resizing it.
    setRootViewportProperty('--sb-shell-viewport-top', `${viewportSize.top}px`);

    // Neconyan: browser-fixes.js may reset document scroll mid-edit once the
    // legacy shell has moved the focused composer above the keyboard.
    root.classList.toggle('sb-ios-composer-keyboard-inset-active', composerKeyboardInset > 0);
}

function getMobileFocusedInputScroller(target) {
    if (!(target instanceof HTMLElement)) {
        return null;
    }

    // Shell construction retains compatibility wrappers inside the real panel
    // scroller. Prefer the outer scroll owner, otherwise scroll legacy drawers.
    const shellScroller = target.closest('.sb-shell-panel-scroller');
    if (shellScroller instanceof HTMLElement) {
        return shellScroller;
    }

    const legacyScroller = target.closest('.scrollableInner, .scrollableInnerFull');
    return legacyScroller instanceof HTMLElement ? legacyScroller : null;
}

function syncMobileFocusedInputScroll(target = document.activeElement) {
    if (!isMobileViewport() || !(target instanceof HTMLElement) || target !== document.activeElement || !isEditableElement(target)) {
        return;
    }

    const scroller = getMobileFocusedInputScroller(target);
    if (!scroller) {
        return;
    }

    // visualViewport tracks the keyboard: top grows and height shrinks as the
    // keyboard rises, so (top + height) is the bottom of the visible area.
    const layoutViewport = getLayoutViewportSize();
    const viewportSize = getVisualViewportSize(layoutViewport);

    if (!isVisualViewportKeyboardOpen(layoutViewport, viewportSize)) {
        return;
    }

    const viewportBottom = viewportSize.top + viewportSize.height;
    const rect = target.getBoundingClientRect();
    const overflow = rect.bottom - viewportBottom + 16;

    if (overflow > 0) {
        scroller.scrollTop += overflow;
    }
}

let nnMobileFocusedInputScrollTimer = null;

/**
 * Neconyan: on mobile the body is fixed/clip, so the browser cannot scroll a
 * focused input above the virtual keyboard the way a normal page would. Follow
 * the keyboard's visual viewport updates until Safari finishes its animation.
 */
function scheduleMobileFocusedInputScroll(event) {
    const target = event?.target instanceof HTMLElement && isEditableElement(event.target)
        ? event.target
        : document.activeElement;

    if (!(target instanceof HTMLElement)) {
        return;
    }

    window.requestAnimationFrame(() => syncMobileFocusedInputScroll(target));

    if (nnMobileFocusedInputScrollTimer !== null) {
        window.clearTimeout(nnMobileFocusedInputScrollTimer);
    }

    nnMobileFocusedInputScrollTimer = window.setTimeout(() => {
        nnMobileFocusedInputScrollTimer = null;
        syncMobileFocusedInputScroll(target);
    }, 360);
}

const MOBILE_POPUP_KEYBOARD_CLEARANCE_PX = 16;

function getMobilePopupDialogForKeyboard(element) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }

    const dialog = element.closest('dialog.popup');
    return dialog instanceof HTMLElement && dialog.open ? dialog : null;
}

function clearMobilePopupKeyboardShift(dialog) {
    if (!(dialog instanceof HTMLElement)) {
        return;
    }

    const scroller = dialog.querySelector('[data-sb-keyboard-max-height]');
    if (scroller instanceof HTMLElement) {
        const previousMaxHeight = scroller.dataset.sbKeyboardMaxHeight;
        if (previousMaxHeight) {
            scroller.style.maxHeight = previousMaxHeight;
        } else {
            scroller.style.removeProperty('max-height');
        }
        delete scroller.dataset.sbKeyboardMaxHeight;
    }

    if (dialog.dataset.sbKeyboardStyle !== undefined) {
        dialog.style.cssText = dialog.dataset.sbKeyboardStyle;
    }

    delete dialog.dataset.sbKeyboardAdjusted;
    delete dialog.dataset.sbKeyboardStyle;
}

function clearAllMobilePopupKeyboardShifts(except = null) {
    for (const dialog of document.querySelectorAll('dialog.popup[data-sb-keyboard-adjusted]')) {
        if (dialog !== except) {
            clearMobilePopupKeyboardShift(dialog);
        }
    }
}

/**
 * Neconyan: popup dialogs are centered against the layout viewport, which
 * does not shrink with the virtual keyboard (interactive-widget=resizes-visual).
 * When a focused popup input sits behind the keyboard, the browser pans the
 * visual viewport to reveal it, pushing the top bar off screen (e.g. the
 * connection profile name popup). Anchor the popup to the measured visible
 * area and cap it there, then scroll its content so the browser never needs
 * to pan. Position comes from visualViewport alone: measuring the dialog to
 * offset it reads a stale rect while the open/keyboard animations run.
 */
function syncMobilePopupKeyboardShift() {
    const activeElement = document.activeElement;
    const dialog = isMobileViewport() && isEditableElement(activeElement)
        ? getMobilePopupDialogForKeyboard(activeElement)
        : null;

    clearAllMobilePopupKeyboardShifts(dialog);

    if (!dialog) {
        return;
    }

    const layoutViewport = getLayoutViewportSize();
    const viewportSize = getVisualViewportSize(layoutViewport);

    if (!isVisualViewportKeyboardOpen(layoutViewport, viewportSize)) {
        clearMobilePopupKeyboardShift(dialog);
        return;
    }

    // Measure without the current shift so a shrinking keyboard relaxes it.
    clearMobilePopupKeyboardShift(dialog);

    // visualViewport tracks the keyboard: top grows and height shrinks as the
    // keyboard rises, so (top + height) is the bottom of the visible area.
    const viewportBottom = viewportSize.top + viewportSize.height;
    const edgeClearance = `${MOBILE_POPUP_KEYBOARD_CLEARANCE_PX}px`;
    const topClearance = `max(${edgeClearance}, env(safe-area-inset-top, 0px))`;
    const bottomClearance = `max(${edgeClearance}, env(safe-area-inset-bottom, 0px))`;
    const availableHeight = `calc(${viewportSize.height}px - ${topClearance} - ${bottomClearance})`;
    const scroller = activeElement.closest('.popup-body, .popup-content');

    dialog.dataset.sbKeyboardStyle = dialog.style.cssText;
    dialog.dataset.sbKeyboardAdjusted = 'true';
    // A modal dialog is fixed to the layout viewport with inset 0 and auto
    // margins, so bottom: auto drops the vertical centering while top pins it
    // to the visible area. Horizontal centering is untouched.
    dialog.style.setProperty('top', `calc(${viewportSize.top}px + ${topClearance})`, 'important');
    dialog.style.setProperty('bottom', 'auto', 'important');
    dialog.style.setProperty('min-height', '0', 'important');
    dialog.style.setProperty('max-height', availableHeight, 'important');

    if (scroller instanceof HTMLElement) {
        scroller.dataset.sbKeyboardMaxHeight = scroller.style.maxHeight;
        scroller.style.maxHeight = availableHeight;

        const scrollOverflow = activeElement.getBoundingClientRect().bottom + MOBILE_POPUP_KEYBOARD_CLEARANCE_PX - viewportBottom;
        if (scrollOverflow > 0) {
            scroller.scrollTop += scrollOverflow;
        }
    }
}

let nnMobilePopupKeyboardSyncTimer = 0;

function scheduleMobilePopupKeyboardSync() {
    window.requestAnimationFrame(syncMobilePopupKeyboardShift);
    window.clearTimeout(nnMobilePopupKeyboardSyncTimer);
    // Run again after the keyboard animation / visualViewport resize settles.
    // iOS takes ~300ms to finish raising the keyboard and panning back.
    nnMobilePopupKeyboardSyncTimer = window.setTimeout(syncMobilePopupKeyboardShift, 400);
}

function getMobileShellBoundDrawers() {
    return Array.from(new Set([
        ...document.querySelectorAll('#left-nav-panel, #user-settings-block, .sb-shell-root, #right-nav-panel'),
        ...document.querySelectorAll('#top-settings-holder #right-nav-panel'),
    ])).filter(drawer => drawer instanceof HTMLElement);
}

function applyMobileDrawerBoundsDecision(drawer, decision) {
    if (!(drawer instanceof HTMLElement) || !decision) {
        return;
    }

    if (decision.action === nnMobileShellLifecycle.drawerBounds.action.BIND) {
        drawer.dataset.sbMobileViewportBound = 'true';
    } else if (decision.action === nnMobileShellLifecycle.drawerBounds.action.CLEAR) {
        delete drawer.dataset.sbMobileViewportBound;
    }

    for (const property of decision.styleRemovals) {
        if (drawer.style.getPropertyValue(property) || drawer.style.getPropertyPriority(property)) {
            drawer.style.removeProperty(property);
        }
    }

    for (const { property, value, priority } of decision.styleWrites) {
        if (drawer.style.getPropertyValue(property) !== value || drawer.style.getPropertyPriority(property) !== priority) {
            drawer.style.setProperty(property, value, priority);
        }
    }
}

function syncMobileShellDrawerBounds() {
    const drawers = getMobileShellBoundDrawers();

    if (!drawers.length) {
        return;
    }

    const mobileViewport = isMobileViewport();
    const viewportSize = mobileViewport ? getShellViewportSize() : null;
    const baseTopOffset = mobileViewport ? getResolvedShellTopbarOffset() : 0;

    const decisions = drawers.map(drawer => {
        const isOpen = drawer.classList.contains('openDrawer');
        const drawerStyles = mobileViewport && isOpen ? window.getComputedStyle(drawer) : null;

        return nnMobileShellLifecycle.drawerBounds.resolveBounds({
            isMobileViewport: mobileViewport,
            isOpen,
            isViewportBound: drawer.dataset.sbMobileViewportBound === 'true',
            viewportHeight: viewportSize?.height ?? 0,
            viewportTop: viewportSize?.top ?? 0,
            baseTopOffset,
            shellGap: drawerStyles ? Number.parseFloat(drawerStyles.getPropertyValue('--sb-mobile-shell-gap')) || 0 : 0,
        });
    });
    drawers.forEach((drawer, index) => applyMobileDrawerBoundsDecision(drawer, decisions[index]));
}

let nnMobileShellDrawerBoundsFrameId = 0;
let nnMobileShellDrawerBoundsFollowupId = 0;

function queueMobileShellDrawerBoundsSync() {
    const schedule = nnMobileShellLifecycle.viewportSync.resolveDrawerBoundsSchedule({
        isMobileViewport: isMobileViewport(),
        hasAnimationFrame: typeof window.requestAnimationFrame === 'function',
        followupDelayMs: NN_MOBILE_VIEWPORT_RESET_FOLLOWUP_MS,
    });

    if (!schedule.shouldSchedule) {
        return;
    }

    if (nnMobileShellDrawerBoundsFrameId && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(nnMobileShellDrawerBoundsFrameId);
        nnMobileShellDrawerBoundsFrameId = 0;
    }
    if (nnMobileShellDrawerBoundsFollowupId) {
        window.clearTimeout(nnMobileShellDrawerBoundsFollowupId);
        nnMobileShellDrawerBoundsFollowupId = 0;
    }

    const sync = () => {
        nnMobileShellDrawerBoundsFrameId = 0;
        syncShellViewportBounds();
        syncMobileShellDrawerBounds();
    };

    if (schedule.useAnimationFrame) {
        nnMobileShellDrawerBoundsFrameId = window.requestAnimationFrame(sync);
    } else {
        sync();
    }

    nnMobileShellDrawerBoundsFollowupId = window.setTimeout(() => {
        nnMobileShellDrawerBoundsFollowupId = 0;
        sync();
    }, schedule.followupDelayMs);
}

function isMovingUIActive() {
    return document.body?.classList.contains('movingUI') ?? false;
}

function isDesktopResizableShell(shellKey) {
    return shellKey === 'left' || shellKey === 'right' || shellKey === 'characters';
}

function getShellSizingKey(shellKey) {
    return ['left', 'right', 'characters'].includes(shellKey) ? 'right' : shellKey;
}

function getShellAccountStorage() {
    const storage = getSillyTavernContext()?.accountStorage;

    if (!storage || typeof storage.getState !== 'function') {
        return null;
    }

    try {
        // Called once per settings drawer at startup; copying the whole state here cost about a second on phones.
        if (typeof storage.hasItem === 'function') {
            return storage.hasItem(NN_ACCOUNT_STORAGE_READY_MARKER) ? storage : null;
        }

        const snapshot = storage.getState();
        return snapshot && Object.hasOwn(snapshot, NN_ACCOUNT_STORAGE_READY_MARKER) ? storage : null;
    } catch {
        return null;
    }
}

function getPersistentStorageItem(key) {
    if (!key) {
        return null;
    }

    const localValue = safeGetItem(key);
    const accountStorage = getShellAccountStorage();
    const accountValue = accountStorage ? accountStorage.getItem(key) : null;

    if (accountValue !== null) {
        if (accountValue !== localValue) {
            safeSetItem(key, accountValue);
        }

        return accountValue;
    }

    if (localValue !== null && accountStorage) {
        accountStorage.setItem(key, localValue);
    }

    return localValue;
}

function setPersistentStorageItem(key, value) {
    if (!key) {
        return;
    }

    safeSetItem(key, value);
    getShellAccountStorage()?.setItem(key, value);
}

function getPersistedShellSize(shellKey) {
    const storageKey = getShellSizeStorageKey(shellKey);

    if (!storageKey) {
        return null;
    }

    const localSize = normalizeShellSize(safeGetItem(storageKey));
    const accountStorage = getShellAccountStorage();
    const accountSize = accountStorage ? normalizeShellSize(accountStorage.getItem(storageKey)) : null;

    if (accountSize) {
        if (!areShellSizesEqual(localSize, accountSize)) {
            safeSetItem(storageKey, JSON.stringify(accountSize));
        }

        return accountSize;
    }

    if (localSize && accountStorage) {
        accountStorage.setItem(storageKey, JSON.stringify(localSize));
    }

    return localSize;
}

function hydratePersistedShellSizes() {
    const persistedSize = getPersistedShellSize('right') ?? getPersistedShellSize('left');

    if (persistedSize) {
        nnState.shellSizing.overrides.left = persistedSize;
        nnState.shellSizing.overrides.right = persistedSize;
    }
}

function getResolvedShellTopbarOffset() {
    const docEl = document.documentElement;
    const docTop = (docEl instanceof HTMLElement && docEl.getClientRects().length > 0)
        ? Math.max(0, Math.round(readFiniteViewportNumber(docEl.getBoundingClientRect().top, 0)))
        : 0;

    // Neconyan: on mobile the shell's own rect.top is driven by the very
    // CSS var this function feeds back into (--sb-shell-measured-top-offset),
    // so reading it creates a feedback loop. If an overscroll momentarily
    // displaces the shell (e.g. iOS rubber-band), the displaced value is
    // written back, the shell is pushed further, and the chat goes blank
    // even after the page snaps back. Stay off #sheld on mobile.
    const isMobileViewportLike = isMobileViewport() || isTouchOnlyDesktopViewport();
    const fallbackTopOffset = (() => {
        const topbarOffset = Number.parseFloat(
            window.getComputedStyle(document.documentElement).getPropertyValue('--sb-topbar-layout-offset'),
        );
        return Number.isFinite(topbarOffset) ? topbarOffset : 0;
    })();

    if (!isMobileViewportLike) {
        const chatShell = document.getElementById('sheld');
        if (chatShell instanceof HTMLElement && chatShell.getClientRects().length > 0) {
            const chatRect = chatShell.getBoundingClientRect();
            if (Number.isFinite(chatRect.top)) {
                const offset = chatRect.top - docTop;
                if (offset > 0) {
                    return offset;
                }
            }
        }
    }

    const topBar = document.getElementById('top-bar');
    if (topBar instanceof HTMLElement && topBar.getClientRects().length > 0) {
        const topBarRect = topBar.getBoundingClientRect();
        if (Number.isFinite(topBarRect.bottom)) {
            const offset = topBarRect.bottom - docTop;
            if (offset > 0) {
                return offset;
            }
        }
    }

    return fallbackTopOffset;
}

function getShellViewportTop(root, viewportSize = getShellViewportSize()) {
    let top = getResolvedShellTopbarOffset();

    if (root instanceof HTMLElement && root.classList.contains('openDrawer') && root.getClientRects().length > 0) {
        const rect = root.getBoundingClientRect();
        if (Number.isFinite(rect.top)) {
            top = rect.top;
        }
    }

    return clampNumber(Math.round(top), viewportSize.top, viewportSize.bottom);
}

function getChatViewportWidth(viewportSize = getShellViewportSize()) {
    const chatShell = document.getElementById('sheld');

    if (chatShell instanceof HTMLElement && chatShell.getClientRects().length > 0) {
        const rect = chatShell.getBoundingClientRect();
        const visibleWidth = Math.min(rect.right, viewportSize.right) - Math.max(rect.left, viewportSize.left);

        if (Number.isFinite(visibleWidth) && visibleWidth > 0) {
            return Math.round(visibleWidth);
        }
    }

    const sheldWidthStr = window.getComputedStyle(document.documentElement).getPropertyValue('--sheldWidth').trim();
    const sheldWidthValue = Number.parseFloat(sheldWidthStr);

    if (!Number.isFinite(sheldWidthValue)) {
        return viewportSize.width;
    }

    if (sheldWidthStr.endsWith('px')) {
        return Math.round(sheldWidthValue);
    }

    return Math.round((sheldWidthValue / 100) * viewportSize.width);
}

function isShellSnapToChatWidthEnabled(shellKey) {
    return Boolean(nnState.shellSizing.snapToChatWidth)
        && isDesktopResizableShell(shellKey)
        && !isMobileViewport();
}

function getShellSizeStorageKey(shellKey) {
    const sizingKey = getShellSizingKey(shellKey);

    if (sizingKey === 'left') {
        return NN_STORAGE_KEYS.leftShellSize;
    }

    if (sizingKey === 'right') {
        return NN_STORAGE_KEYS.rightShellSize;
    }

    return '';
}

function getDesktopShellDimensions(shellKey = '') {
    const viewportSize = getShellViewportSize();
    const viewportWidth = viewportSize.width;
    const viewportHeight = viewportSize.height;
    const maxShellWidth = shellKey === 'right' ? Math.min(NN_DESKTOP_SHELL_LAYOUT.maxWidth, 760) : NN_DESKTOP_SHELL_LAYOUT.maxWidth;

    if (isShellSnapToChatWidthEnabled(shellKey)) {
        const snappedWidth = clampNumber(
            getChatViewportWidth(viewportSize),
            Math.min(NN_DESKTOP_SHELL_LAYOUT.minWidth, viewportWidth),
            viewportWidth,
        );

        return {
            width: snappedWidth,
            maxWidth: snappedWidth,
        };
    }

    if (
        ['left', 'right'].includes(shellKey)
        && viewportWidth >= NN_DESKTOP_SHELL_LAYOUT.laptopViewportMin
        && viewportWidth <= NN_DESKTOP_SHELL_LAYOUT.laptopViewportMax
    ) {
        const laptopWidth = clampNumber(
            viewportWidth * NN_DESKTOP_SHELL_LAYOUT.laptopRatio,
            NN_DESKTOP_SHELL_LAYOUT.laptopMinWidth,
            NN_DESKTOP_SHELL_LAYOUT.laptopMaxWidth,
        );
        const maxWidth = Math.max(0, viewportWidth - NN_DESKTOP_SHELL_LAYOUT.laptopGutter);
        const resolvedWidth = Math.min(laptopWidth, maxWidth);

        return {
            width: resolvedWidth,
            maxWidth: resolvedWidth,
        };
    }

    if (isMobileViewport() || (viewportHeight <= NN_DESKTOP_SHELL_LAYOUT.fullWidthMaxHeight && shellKey !== 'characters')) {
        return {
            width: viewportWidth,
            maxWidth: viewportWidth,
        };
    }

    if (viewportWidth <= NN_DESKTOP_SHELL_LAYOUT.compactViewportWidth) {
        const compactWidth = Math.max(0, Math.min(NN_DESKTOP_SHELL_LAYOUT.compactMaxWidth, viewportWidth - NN_DESKTOP_SHELL_LAYOUT.compactGap));
        return {
            width: compactWidth,
            maxWidth: compactWidth,
        };
    }

    // Neconyan: cap shell width to the active chat width (--sheldWidth) so settings
    // panels narrow when the user reduces the chat width, matching standard ST behaviour.
    const sheldWidthStr = window.getComputedStyle(document.documentElement).getPropertyValue('--sheldWidth').trim();
    const sheldWidthVw = parseFloat(sheldWidthStr);
    const chatWidthPx = Number.isFinite(sheldWidthVw) ? Math.round((sheldWidthVw / 100) * viewportWidth) : viewportWidth;
    const desiredWidth = clampNumber(
        Math.min(viewportWidth * NN_DESKTOP_SHELL_LAYOUT.ratio, chatWidthPx),
        NN_DESKTOP_SHELL_LAYOUT.minWidth,
        maxShellWidth,
    );
    const gutter = clampNumber(
        viewportWidth * NN_DESKTOP_SHELL_LAYOUT.gutterRatio,
        NN_DESKTOP_SHELL_LAYOUT.gutterMin,
        NN_DESKTOP_SHELL_LAYOUT.gutterMax,
    );
    const maxWidth = Math.max(0, viewportWidth - gutter);
    const resolvedWidth = Math.min(desiredWidth, maxWidth);

    return {
        width: resolvedWidth,
        maxWidth: resolvedWidth,
    };
}

function getDesktopShellResizeBounds(shellKey = '') {
    const viewportSize = getShellViewportSize();
    const viewportWidth = Math.max(0, Math.round(viewportSize.width));
    const viewportHeight = Math.max(0, Math.round(viewportSize.height));
    const root = isDesktopResizableShell(shellKey) ? getResizableShellRoot(shellKey) : null;
    const shellTop = getShellViewportTop(root, viewportSize);
    const defaultDimensions = getDesktopShellDimensions(shellKey);
    const defaultWidth = Math.max(0, Math.min(Math.round(defaultDimensions.width), viewportWidth));
    const snapWidth = isShellSnapToChatWidthEnabled(shellKey) ? defaultWidth : null;
    const maxHeight = Math.max(0, Math.round(viewportHeight - shellTop - NN_DESKTOP_SHELL_RESIZE.bottomGap));

    return {
        defaultWidth,
        defaultHeight: maxHeight,
        minWidth: snapWidth ?? Math.min(NN_DESKTOP_SHELL_RESIZE.minWidth, viewportWidth),
        maxWidth: snapWidth ?? viewportWidth,
        minHeight: Math.min(NN_DESKTOP_SHELL_RESIZE.minHeight, maxHeight),
        maxHeight,
    };
}

function clampShellSize(size, bounds = getDesktopShellResizeBounds()) {
    const normalizedSize = normalizeShellSize(size);

    if (!normalizedSize) {
        return null;
    }

    return {
        width: clampNumber(normalizedSize.width, bounds.minWidth, bounds.maxWidth),
        height: clampNumber(normalizedSize.height, bounds.minHeight, bounds.maxHeight),
    };
}

function areShellSizesEqual(left, right) {
    return Boolean(left) && Boolean(right)
        && left.width === right.width
        && left.height === right.height;
}

function getShellSizeOverride(shellKey) {
    return isDesktopResizableShell(shellKey) ? nnState.shellSizing.overrides.right ?? nnState.shellSizing.overrides.left ?? null : null;
}

function setShellSizeOverride(shellKey, size, { persist = true } = {}) {
    if (!isDesktopResizableShell(shellKey)) {
        return null;
    }

    const nextSize = clampShellSize(size, getDesktopShellResizeBounds(shellKey));

    nnState.shellSizing.overrides.left = nextSize;
    nnState.shellSizing.overrides.right = nextSize;

    if (!persist) {
        return nextSize;
    }

    const accountStorage = getShellAccountStorage();
    const storageKeys = [NN_STORAGE_KEYS.leftShellSize, NN_STORAGE_KEYS.rightShellSize];

    if (nextSize) {
        const serializedSize = JSON.stringify(nextSize);
        for (const storageKey of storageKeys) {
            safeSetItem(storageKey, serializedSize);
            accountStorage?.setItem(storageKey, serializedSize);
        }
    } else {
        for (const storageKey of storageKeys) {
            safeRemoveItem(storageKey);
            accountStorage?.removeItem(storageKey);
        }
    }

    return nextSize;
}

function applyDesktopShellSize(root, size) {
    root.style.setProperty('width', `${size.width}px`, 'important');
    root.style.setProperty('max-width', `${size.width}px`, 'important');
    root.style.setProperty('height', `${size.height}px`, 'important');
    root.style.setProperty('max-height', `${size.height}px`, 'important');
    root.dataset.sbShellInlineSize = 'true';
}

function clearDesktopShellSize(root) {
    root.style.removeProperty('width');
    root.style.removeProperty('max-width');
    root.style.removeProperty('height');
    root.style.removeProperty('max-height');
    delete root.dataset.sbShellInlineSize;
}

function syncDesktopShellSizing() {
    if (nnIsSyncingRailActions) {
        return;
    }

    hydratePersistedShellSizes();

    const resizingEnabled = canResizeDesktopShells();
    const neconyanDocking = document.body?.classList.contains('neconyan') && !isMobileViewport();

    for (const shellKey of ['left', 'right', 'characters']) {
        const root = shellKey === 'characters'
            ? getCharacterPanel()
            : document.getElementById(getShellConfig(shellKey).rootPanelId);
        if (!(root instanceof HTMLElement)) {
            continue;
        }

        if (isMobileViewport()) {
            clearDesktopShellSize(root);
            root.classList.remove('sb-shell-can-resize');
            syncShellResizeHandleValue(shellKey, null);
            continue;
        }

        if (neconyanDocking) {
            clearDesktopShellSize(root);
            root.classList.remove('sb-shell-can-resize');
            syncShellResizeHandleValue(shellKey, null);
            continue;
        }

        if (shellKey === 'characters' && isMovingUIActive()) {
            if (root.dataset.sbShellInlineSize === 'true') {
                clearDesktopShellSize(root);
            }

            root.classList.remove('sb-shell-can-resize');
            syncShellResizeHandleValue(shellKey, null);
            continue;
        }

        const { width } = getDesktopShellDimensions(shellKey);
        const bounds = getDesktopShellResizeBounds(shellKey);
        let sizeToApply = {
            width,
            height: bounds.defaultHeight,
        };

        const storedOverride = getShellSizeOverride(shellKey);
        if (resizingEnabled && storedOverride) {
            const clampedOverride = clampShellSize(storedOverride, bounds);
            if (clampedOverride) {
                sizeToApply = clampedOverride;

                if (!areShellSizesEqual(storedOverride, clampedOverride)) {
                    setShellSizeOverride(shellKey, clampedOverride);
                } else {
                    nnState.shellSizing.overrides[getShellSizingKey(shellKey)] = clampedOverride;
                }
            }
        }

        applyDesktopShellSize(root, sizeToApply);
        root.classList.toggle('sb-shell-can-resize', resizingEnabled);
        syncShellResizeHandleValue(shellKey, sizeToApply);
    }

    syncCharacterDrawerLockPosition();
}

function getResizableShellRoot(shellKey) {
    if (shellKey === 'characters') {
        return getCharacterPanel();
    }

    return document.getElementById(getShellConfig(shellKey).rootPanelId);
}

function isPrimaryShellResizeStart(event) {
    if (event && 'isPrimary' in event && event.isPrimary === false) {
        return false;
    }

    return event?.button === undefined || event.button === 0 || event.pointerType === 'touch';
}

function bindShellResizeHandle(handle, shellKey) {
    stopProxyPointerPropagation(handle);
    configureShellResizeHandle(handle, shellKey);
    handle.addEventListener('pointerdown', event => beginShellResize(shellKey, event));
    handle.addEventListener('mousedown', event => {
        if (event.defaultPrevented || nnState.shellSizing.activeResize) {
            return;
        }

        beginShellResize(shellKey, event);
    });
    handle.addEventListener('keydown', event => handleShellResizeKeydown(shellKey, event));
}

function configureShellResizeHandle(handle, shellKey) {
    const bounds = getDesktopShellResizeBounds(shellKey);
    const currentSize = getShellSizeOverride(shellKey) ?? {
        width: bounds.defaultWidth,
        height: bounds.defaultHeight,
    };
    const label = shellKey === 'characters' ? 'Characters' : getShellConfig(shellKey)?.title || 'panel';

    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-label', `Resize ${label} panel`);
    handle.setAttribute('aria-valuemin', String(bounds.minWidth));
    handle.setAttribute('aria-valuemax', String(bounds.maxWidth));
    handle.setAttribute('aria-valuenow', String(Math.round(currentSize.width)));
    handle.setAttribute('aria-valuetext', `${Math.round(currentSize.width)} pixels wide, ${Math.round(currentSize.height)} pixels tall`);
    handle.tabIndex = canResizeDesktopShells() ? 0 : -1;
}

function syncShellResizeHandleValue(shellKey, size) {
    const root = getResizableShellRoot(shellKey);
    const shellState = getShellState(shellKey);
    const handle = shellState?.resizeHandle ?? root?.querySelector(':scope > .sb-shell-resize-handle, .sb-shell-resize-handle');
    if (!(handle instanceof HTMLElement)) {
        return;
    }

    if (!size) {
        if (!root?.classList.contains('sb-shell-can-resize')) {
            if (handle.tabIndex !== -1) handle.tabIndex = -1;
            return;
        }
        configureShellResizeHandle(handle, shellKey);
        return;
    }

    configureShellResizeHandle(handle, shellKey);
    handle.setAttribute('aria-valuenow', String(Math.round(size.width)));
    handle.setAttribute('aria-valuetext', `${Math.round(size.width)} pixels wide, ${Math.round(size.height)} pixels tall`);
}

function handleShellResizeKeydown(shellKey, event) {
    if (!canResizeDesktopShells() || !isDesktopResizableShell(shellKey)) {
        return;
    }

    const root = getResizableShellRoot(shellKey);
    if (!(root instanceof HTMLElement) || !root.classList.contains('openDrawer')) {
        return;
    }

    const bounds = getDesktopShellResizeBounds(shellKey);
    const currentRect = root.getBoundingClientRect();
    const currentSize = clampShellSize({
        width: currentRect.width || bounds.defaultWidth,
        height: currentRect.height || bounds.defaultHeight,
    }, bounds);

    if (!currentSize) {
        return;
    }

    const step = event.shiftKey ? 72 : 24;
    let nextSize = currentSize;

    if (event.key === 'ArrowLeft') {
        nextSize = { ...currentSize, width: currentSize.width - step };
    } else if (event.key === 'ArrowRight') {
        nextSize = { ...currentSize, width: currentSize.width + step };
    } else if (event.key === 'ArrowUp') {
        nextSize = { ...currentSize, height: currentSize.height - step };
    } else if (event.key === 'ArrowDown') {
        nextSize = { ...currentSize, height: currentSize.height + step };
    } else if (event.key === 'Home') {
        nextSize = { ...currentSize, width: bounds.minWidth };
    } else if (event.key === 'End') {
        nextSize = { ...currentSize, width: bounds.maxWidth };
    } else {
        return;
    }

    const clampedSize = clampShellSize(nextSize, bounds);
    if (!clampedSize) {
        return;
    }

    event.preventDefault();
    setShellSizeOverride(shellKey, clampedSize);
    applyDesktopShellSize(root, clampedSize);
    syncShellResizeHandleValue(shellKey, clampedSize);
}

function beginShellResize(shellKey, event) {
    if (!canResizeDesktopShells() || !isDesktopResizableShell(shellKey) || !isPrimaryShellResizeStart(event)) {
        return;
    }

    if (shellKey === 'characters' && isMovingUIActive()) {
        return;
    }

    const root = getResizableShellRoot(shellKey);
    if (!(root instanceof HTMLElement) || !root.classList.contains('openDrawer')) {
        return;
    }

    if (typeof nnState.shellSizing.activeResize?.cleanup === 'function') {
        nnState.shellSizing.activeResize.cleanup();
    }

    const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const bounds = getDesktopShellResizeBounds(shellKey);
    const startRect = root.getBoundingClientRect();
    const startSize = clampShellSize({
        width: startRect.width || bounds.defaultWidth,
        height: startRect.height || bounds.defaultHeight,
    }, bounds);

    if (!startSize) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    document.body.classList.add('sb-shell-resizing');
    root.classList.add('sb-shell-resize-active');
    setShellSizeOverride(shellKey, startSize, { persist: false });

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    const moveEventName = pointerId === null ? 'mousemove' : 'pointermove';
    const upEventName = pointerId === null ? 'mouseup' : 'pointerup';
    const cancelEventName = pointerId === null ? 'mouseleave' : 'pointercancel';

    const cleanup = () => {
        if (pointerId !== null && handle && typeof handle.releasePointerCapture === 'function') {
            try {
                handle.releasePointerCapture(pointerId);
            } catch {
                // Ignore pointer capture cleanup failures.
            }
        }

        window.removeEventListener(moveEventName, onPointerMove);
        window.removeEventListener(upEventName, onPointerUp);
        window.removeEventListener(cancelEventName, onPointerUp);
        document.body.classList.remove('sb-shell-resizing');
        root.classList.remove('sb-shell-resize-active');

        if (nnState.shellSizing.activeResize?.pointerId === pointerId) {
            nnState.shellSizing.activeResize = null;
        }
    };

    const onPointerMove = moveEvent => {
        if (pointerId !== null && moveEvent.pointerId !== pointerId) {
            return;
        }

        moveEvent.preventDefault();
        const widthDelta = shellKey === 'characters' && nnState.characterDrawer.rightLocked
            ? event.clientX - moveEvent.clientX
            : moveEvent.clientX - event.clientX;
        const nextSize = clampShellSize({
            width: startSize.width + widthDelta,
            height: startSize.height + (moveEvent.clientY - event.clientY),
        }, bounds);

        if (!nextSize) {
            return;
        }

        nnState.shellSizing.overrides[getShellSizingKey(shellKey)] = nextSize;
        applyDesktopShellSize(root, nextSize);
        syncShellResizeHandleValue(shellKey, nextSize);
    };

    const onPointerUp = endEvent => {
        if (pointerId !== null && endEvent.pointerId !== pointerId) {
            return;
        }

        const activeSize = getShellSizeOverride(shellKey) ?? startSize;
        cleanup();
        setShellSizeOverride(shellKey, activeSize);
        syncShellResizeHandleValue(shellKey, activeSize);
        syncDesktopShellSizing();
    };

    nnState.shellSizing.activeResize = {
        shellKey,
        pointerId,
        cleanup,
    };

    if (pointerId !== null && handle && typeof handle.setPointerCapture === 'function') {
        try {
            handle.setPointerCapture(pointerId);
        } catch {
            // Ignore pointer capture failures.
        }
    }

    window.addEventListener(moveEventName, onPointerMove);
    window.addEventListener(upEventName, onPointerUp);
    window.addEventListener(cancelEventName, onPointerUp);
}

function ensureShellReady(shellKey) {
    if (!getShellConfig(shellKey)) {
        return false;
    }

    if (getShellState(shellKey)) {
        return true;
    }

    buildShell(shellKey);
    return Boolean(getShellState(shellKey));
}

function syncExistingMobileNavQuickActions(overlay) {
    if (!(overlay instanceof HTMLElement)) {
        return;
    }

    const list = overlay.querySelector('.sb-mobile-quick-action-list')
        ?? overlay.querySelector('.sb-mobile-section-list');
    if (list instanceof HTMLElement) {
        nnState.mobileNav.quickActionContainer = list;
        const quickActionSection = list.closest('.sb-mobile-quick-action-section');
        if (quickActionSection instanceof HTMLElement) {
            nnState.mobileNav.quickActionSection = quickActionSection;
        }
        refreshMobileNavQuickActions();
    }
}

function ensureMobileNavReady() {
    const existingOverlay = document.getElementById('sb-mobile-nav');
    if (existingOverlay instanceof HTMLElement) {
        syncExistingMobileNavQuickActions(existingOverlay);
        return existingOverlay;
    }

    buildMobileNav();
    const overlay = document.getElementById('sb-mobile-nav');
    syncExistingMobileNavQuickActions(overlay);
    return overlay;
}

function getThemeOption(themeId) {
    return NN_THEMES.find(theme => theme.id === themeId) ?? NN_THEMES[0];
}

function normalizeMessageStyle(styleId) {
    const select = getMessageStyleSelect();
    const fallbackValue = select?.options?.[0]?.value ?? NN_MESSAGE_STYLES[0].id;
    const value = String(styleId ?? fallbackValue);

    if (!select) {
        return value;
    }

    return Array.from(select.options).some(option => option.value === value) ? value : fallbackValue;
}

function getMessageStyleSelect() {
    const select = document.getElementById('chat_display');
    return select instanceof HTMLSelectElement ? select : null;
}

function getCurrentMessageStyle() {
    return normalizeMessageStyle(getMessageStyleSelect()?.value);
}

function setMessageStyle(styleId) {
    const select = getMessageStyleSelect();
    if (!select) {
        return;
    }

    const nextStyle = normalizeMessageStyle(styleId);
    if (select.value !== nextStyle) {
        select.value = nextStyle;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    updateThemePickerUi();
}

function stripAvatarOrigin(url) {
    const normalizedUrl = String(url ?? '').trim();
    if (!normalizedUrl) {
        return '';
    }

    return normalizedUrl.startsWith(window.location.origin)
        ? normalizedUrl.slice(window.location.origin.length)
        : normalizedUrl;
}

function isAbsoluteAvatarUrl(path) {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(path ?? ''));
}

function ensureAvatarPath(path) {
    const normalizedPath = String(path ?? '').trim();
    if (!normalizedPath || isAbsoluteAvatarUrl(normalizedPath)) {
        return normalizedPath;
    }

    return normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
}

function getChatAvatarSources(rawSrc) {
    const source = ensureAvatarPath(stripAvatarOrigin(rawSrc));
    const avatarInfo = parseAvatarSource(source);
    if (!avatarInfo) {
        return { display: '', thumb: '', original: '' };
    }

    const { type, file, original } = avatarInfo;
    const isThumbnail = Object.prototype.hasOwnProperty.call(avatarInfo, 'preset');
    const thumb = type === 'avatar' || type === 'persona'
        ? (isThumbnail ? source : getThumbnailUrl(type, file))
        : ensureAvatarPath(file);

    return {
        display: source || thumb,
        thumb: stripAvatarOrigin(thumb),
        original: stripAvatarOrigin(ensureAvatarPath(original)),
    };
}

function formatAvatarCssUrl(url) {
    const normalizedUrl = stripAvatarOrigin(url);
    return normalizedUrl ? `url(${JSON.stringify(normalizedUrl)})` : '';
}

function updateChatAvatarVariables(root = document) {
    const messages = root instanceof HTMLElement && root.matches('.mes')
        ? [root]
        : Array.from(root.querySelectorAll?.('.mes') ?? []);

    for (const message of messages) {
        if (!(message instanceof HTMLElement)) {
            continue;
        }

        const avatarImg = message.querySelector('.avatar img');
        if (!(avatarImg instanceof HTMLImageElement)) {
            continue;
        }

        const src = avatarImg.getAttribute('src') || avatarImg.getAttribute('data-src') || avatarImg.currentSrc;
        const thumbnailSrc = avatarImg.getAttribute('data-thumbnail-src');
        const originalSrc = avatarImg.getAttribute('data-original-src');
        const cachedSources = nnState.chatAvatars.sourceCache.get(message);
        if (cachedSources?.src === src
            && cachedSources.thumbnailSrc === thumbnailSrc
            && cachedSources.originalSrc === originalSrc) {
            continue;
        }
        nnState.chatAvatars.sourceCache.set(message, { src, thumbnailSrc, originalSrc });

        const srcSources = getChatAvatarSources(src);
        const thumbnailSources = getChatAvatarSources(thumbnailSrc);
        const originalSources = getChatAvatarSources(originalSrc);
        const displayUrl = srcSources.display || thumbnailSources.display || originalSources.display;
        const thumbUrl = thumbnailSources.display || srcSources.thumb || displayUrl;
        const originalUrl = originalSources.display || srcSources.original || thumbnailSources.original || displayUrl;

        if (!displayUrl && !thumbUrl && !originalUrl) {
            continue;
        }

        message.dataset.avatarThumb = thumbUrl;
        message.dataset.avatarOriginal = originalUrl;
        message.dataset.avatar = displayUrl;
        message.style.setProperty('--sb-message-avatar', formatAvatarCssUrl(displayUrl));
        message.style.setProperty('--mes-avatar-thumb-url', formatAvatarCssUrl(thumbUrl));
        message.style.setProperty('--mes-avatar-original-url', formatAvatarCssUrl(originalUrl));
        message.style.setProperty('--mes-avatar-url', formatAvatarCssUrl(displayUrl));
    }
}

function scheduleChatAvatarVariableUpdate(delay = 80) {
    window.clearTimeout(nnState.chatAvatars.debounceTimer);
    nnState.chatAvatars.debounceTimer = window.setTimeout(() => {
        nnState.chatAvatars.debounceTimer = 0;
        updateChatAvatarVariables();
    }, delay);
}

function initChatAvatarVariables() {
    window.updateNeconyanChatAvatars = updateChatAvatarVariables;
    updateChatAvatarVariables();

    if (nnState.chatAvatars.observer instanceof MutationObserver) {
        return;
    }

    const chatContainer = document.getElementById('chat');
    if (!(chatContainer instanceof HTMLElement)) {
        if (!nnState.chatAvatars.retryTimer) {
            nnState.chatAvatars.retryTimer = window.setTimeout(() => {
                nnState.chatAvatars.retryTimer = 0;
                initChatAvatarVariables();
            }, NN_INIT_RETRY_DELAY_MS);
        }
        return;
    }

    window.clearTimeout(nnState.chatAvatars.retryTimer);
    nnState.chatAvatars.retryTimer = 0;

    const observer = new MutationObserver(() => scheduleChatAvatarVariableUpdate());
    observer.observe(chatContainer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'data-src', 'data-thumbnail-src', 'data-original-src'],
    });

    nnState.chatAvatars.observer = observer;
    document.addEventListener('sb:chat-style-updated', () => scheduleChatAvatarVariableUpdate(0));
}

const NN_KITTYLESS_STYLESHEET_HREF = `css/neconyan-kittyless.css?v=${NN_SHELL_STYLE_STYLESHEET_VERSION}`;

function getShellStyleStylesheetHref(themeId) {
    return `css/shell-styles/${themeId}.css?v=${NN_SHELL_STYLE_STYLESHEET_VERSION}`;
}

// Calico is the base look in the core sheets; every other shell style layers one lazy sheet on top.
// The inline head script in index.html inserts the same link before first paint for a saved style.
function syncShellStyleStylesheet(themeId) {
    const links = [...document.querySelectorAll('link[data-sb-shell-style]')];

    if (themeId === 'calico') {
        links.forEach(link => link.remove());
        return;
    }

    const href = getShellStyleStylesheetHref(themeId);
    const current = links.find(link => link.getAttribute('href') === href);

    if (current) {
        links.filter(link => link !== current).forEach(link => link.remove());
        return;
    }

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = href;
    stylesheet.dataset.sbShellStyle = themeId;

    const settle = () => {
        if (document.documentElement.dataset.sbTheme !== themeId) {
            stylesheet.remove();
            return;
        }
        document.querySelectorAll('link[data-sb-shell-style]').forEach(link => {
            if (link !== stylesheet) link.remove();
        });
    };
    stylesheet.addEventListener('load', settle, { once: true });
    stylesheet.addEventListener('error', settle, { once: true });

    const userStylesheet = document.querySelector('link[href^="css/user.css"]');
    if (userStylesheet) {
        userStylesheet.before(stylesheet);
    } else {
        document.head.append(stylesheet);
    }
}

function setShellTheme(themeId, { persist = true } = {}) {
    const nextTheme = normalizeTheme(themeId);

    nnState.theme = nextTheme;
    document.documentElement.dataset.sbTheme = nextTheme;
    syncShellStyleStylesheet(nextTheme);
    syncKittylessStylesheet();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.theme, nextTheme);
    }

    updateThemePickerUi();
    updateThemeBadge();
    syncShellStyleAssistantArt();
}

function isKittylessActive() {
    return nnState.theme === 'kittyless' || nnState.kittyless;
}

// Cat removal is its own sheet so Hide cats works on every Shell Style; the Kittyless style always turns it on.
// The inline head script in index.html applies the same attribute and link before first paint.
function syncKittylessStylesheet() {
    const active = isKittylessActive();
    const links = [...document.querySelectorAll('link[data-sb-kittyless]')];

    if (active) {
        document.documentElement.dataset.sbKittyless = 'true';
    } else {
        delete document.documentElement.dataset.sbKittyless;
        links.forEach(link => link.remove());
        return;
    }

    const current = links.find(link => link.getAttribute('href') === NN_KITTYLESS_STYLESHEET_HREF);
    links.filter(link => link !== current).forEach(link => link.remove());
    // It must load after the Shell Style sheet so its rules win ties against that style's cats.
    const followsStyle = link => [...document.querySelectorAll('link[data-sb-shell-style]')]
        .every(style => style.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (current && followsStyle(current)) {
        return;
    }

    const stylesheet = current ?? document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = NN_KITTYLESS_STYLESHEET_HREF;
    stylesheet.dataset.sbKittyless = 'true';

    const userStylesheet = document.querySelector('link[href^="css/user.css"]');
    if (userStylesheet) {
        userStylesheet.before(stylesheet);
    } else {
        document.head.append(stylesheet);
    }
}

function setKittylessEnabled(enabled, { persist = true } = {}) {
    nnState.kittyless = normalizeStoredBoolean(enabled, false);
    syncKittylessStylesheet();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.kittyless, String(nnState.kittyless));
    }

    updateThemePickerUi();
}

// Tour buttons are created by several lazy modules, so one injected rule hides them wherever they appear.
const NN_TOUR_BUTTON_SELECTOR = '.neconyan-tool-tour-button, .neconyan-lorebook-tour-button, .neconyan-tool-tour-invite, .neconyan-lorebook-tour-invite, [data-action="replay-tutorial"]';

function setTourButtonsHidden(hidden, { persist = true } = {}) {
    nnState.tourButtonsHidden = normalizeStoredBoolean(hidden, false);
    let style = document.getElementById('sb-tour-buttons-hidden-style');
    if (nnState.tourButtonsHidden) {
        document.documentElement.dataset.sbTourButtonsHidden = 'true';
        if (!style) {
            style = document.createElement('style');
            style.id = 'sb-tour-buttons-hidden-style';
            style.textContent = `:root[data-sb-tour-buttons-hidden='true'] :is(${NN_TOUR_BUTTON_SELECTOR}) { display: none !important; }`;
            document.head.append(style);
        }
    } else {
        delete document.documentElement.dataset.sbTourButtonsHidden;
        style?.remove();
    }

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.tourButtonsHidden, String(nnState.tourButtonsHidden));
    }

    updateThemePickerUi();
}

const NN_WINDOWS_98_ASSISTANT_IDS = new Set(['miso', 'taro', 'nori'].flatMap(name => ['male', 'female', 'neutral'].map(gender => `${name}-${gender}`)));
let nnShellStyleAssistantArtBound = false;

// Installed assistants are ordinary character files, so their avatars need rules built from the loaded character list.
function buildWindows98AssistantArtCss(characterList) {
    const rules = [];
    for (const character of Array.isArray(characterList) ? characterList : []) {
        const assistantId = character?.data?.extensions?.neconyan_assistant?.id;
        const avatar = character?.avatar;
        if (!NN_WINDOWS_98_ASSISTANT_IDS.has(assistantId) || typeof avatar !== 'string' || !avatar || avatar === 'none') continue;
        const file = encodeURIComponent(avatar);
        rules.push(`:root[data-sb-theme='windows-98'] body.neconyan img:is([src$="type=avatar&file=${file}"], [src*="type=avatar&file=${file}&"], [src$="/characters/${file}"], [src*="/characters/${file}?"]) { content: url('img/neconyan/win98/portrait-${assistantId}.webp?v=20260930a'); }`);
    }
    return rules.join('\n');
}

function syncShellStyleAssistantArt() {
    let style = document.getElementById('sb-shell-style-assistant-art');
    if (nnState.theme !== 'windows-98') {
        style?.remove();
        return;
    }
    if (!nnShellStyleAssistantArtBound && eventSource?.on) {
        nnShellStyleAssistantArtBound = true;
        for (const eventName of [event_types.CHARACTER_PAGE_LOADED, event_types.CHARACTER_EDITED, event_types.CHARACTER_RENAMED, event_types.CHARACTER_DELETED]) {
            if (eventName) eventSource.on(eventName, () => syncShellStyleAssistantArt());
        }
    }
    const css = buildWindows98AssistantArtCss(characters);
    if (!style) {
        style = document.createElement('style');
        style.id = 'sb-shell-style-assistant-art';
        document.head.append(style);
    }
    if (style.textContent !== css) style.textContent = css;
}

function applyFrontendIcon(iconId = nnState.frontendIcon) {
    const normalizedIconId = normalizeFrontendIcon(iconId);
    const iconController = window.NeconyanFrontendIcon;

    if (iconController?.apply) {
        iconController.apply(normalizedIconId);
        return;
    }

    const iconSrc = getFrontendIconSrc(normalizedIconId);

    document.documentElement.dataset.sbFrontendIcon = normalizedIconId;

    for (const image of document.querySelectorAll('img[data-sb-frontend-icon]')) {
        image.setAttribute('src', iconSrc);
    }

    for (const link of document.querySelectorAll('link[rel~="icon"]')) {
        link.setAttribute('href', iconSrc);
        link.setAttribute('type', 'image/png');
    }
}

function setFrontendIconPreference(iconId, { persist = true } = {}) {
    const nextIconId = normalizeFrontendIcon(iconId);

    nnState.frontendIcon = nextIconId;

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.frontendIcon, nextIconId);
    }

    applyFrontendIcon(nextIconId);
    updateThemePickerUi();
}

function setSurfaceTransparency(value, { persist = true } = {}) {
    const nextTransparency = normalizeSurfaceTransparency(value);
    const surfaceOpacity = Math.max(0, 1 - (nextTransparency / 100));
    const cardOpacity = Math.min(1, surfaceOpacity + 0.12);
    const controlOpacity = Math.min(1, surfaceOpacity + 0.22);
    const overlayOpacity = Math.min(1, surfaceOpacity + 0.08);
    nnState.surfaceTransparency = nextTransparency;

    document.documentElement.style.setProperty('--sb-shell-surface-opacity', surfaceOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-shell-surface-opacity-percent', `${(surfaceOpacity * 100).toFixed(0)}%`);
    document.documentElement.style.setProperty('--sb-shell-card-opacity', '1');
    document.documentElement.style.setProperty('--sb-shell-control-opacity', '1');
    document.documentElement.style.setProperty('--sb-shell-overlay-opacity', '1');
    document.documentElement.style.setProperty('--sb-page-surface-opacity', surfaceOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-page-card-opacity', cardOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-page-control-opacity', controlOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-page-overlay-opacity', overlayOpacity.toFixed(2));
    document.documentElement.style.setProperty('--sb-composer-surface-opacity', '1');

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.surfaceTransparency, String(nextTransparency));
    }

    updateThemePickerUi();
}

function applyPaperTextureOpacity() {
    const enabled = nnState.paperTextureEnabled;
    const opacity = enabled ? normalizePaperTextureOpacity(nnState.paperTextureOpacity) / 100 : 0;
    document.documentElement.style.setProperty('--sb-paper-texture-opacity', opacity.toFixed(2));
}

function setPaperTextureEnabled(enabled, { persist = true } = {}) {
    const nextEnabled = normalizeStoredBoolean(enabled, false);
    nnState.paperTextureEnabled = nextEnabled;
    applyPaperTextureOpacity();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.paperTextureEnabled, String(nextEnabled));
    }

    updateThemePickerUi();
}

function setPaperTextureOpacity(value, { persist = true } = {}) {
    const nextOpacity = normalizePaperTextureOpacity(value);
    nnState.paperTextureOpacity = nextOpacity;
    applyPaperTextureOpacity();

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.paperTextureOpacity, String(nextOpacity));
    }

    updateThemePickerUi();
}

function setDesktopTopbarLabelPart(partId, enabled) {
    const normalizedPart = normalizeTopbarLabelPart(partId);
    if (!normalizedPart) {
        return;
    }

    const nextParts = new Set(normalizeTopbarLabelParts(nnState.topbarLabel.desktopParts));
    if (enabled) {
        nextParts.add(normalizedPart);
    } else {
        nextParts.delete(normalizedPart);
    }

    setDesktopTopbarLabelParts(Array.from(nextParts));
}

function setDesktopTopbarLabelParts(parts) {
    nnState.topbarLabel.desktopParts = normalizeTopbarLabelParts(parts, []);
    safeSetItem(NN_STORAGE_KEYS.topbarLabelDesktopParts, JSON.stringify(nnState.topbarLabel.desktopParts));
    flushNnStorageWrites();
    updateThemePickerUi();
    updateTopBarBrand();
    scheduleTopbarContextRefresh(0);
}

function readTopbarLabelMobileParts(raw) {
    // The stored value is one bare part for a single selection (the legacy shape) or a JSON
    // array once several parts are picked, so old saved settings keep loading cleanly.
    const value = String(raw ?? '').trim();
    if (!value) {
        return ['char'];
    }
    if (value.startsWith('[')) {
        try {
            return normalizeTopbarLabelParts(JSON.parse(value), ['char']);
        } catch {
            return ['char'];
        }
    }
    return normalizeTopbarLabelParts([value], ['char']);
}

function setMobileTopbarLabelParts(parts) {
    const nextParts = normalizeTopbarLabelParts(Array.isArray(parts) ? parts : [], []);
    const same = nextParts.length === nnState.topbarLabel.mobileParts.length
        && nextParts.every(partId => nnState.topbarLabel.mobileParts.includes(partId));
    if (same) {
        return;
    }

    nnState.topbarLabel.mobileParts = nextParts;
    safeSetItem(NN_STORAGE_KEYS.topbarLabelMobilePart, nextParts.length === 1 ? nextParts[0] : JSON.stringify(nextParts));
    flushNnStorageWrites();
    updateThemePickerUi();
    updateTopBarBrand();
    scheduleTopbarContextRefresh(0);
}

function setMobileTopbarLabelPart(partId, enabled) {
    const normalizedPart = normalizeTopbarLabelPart(partId);
    const nextParts = new Set(nnState.topbarLabel.mobileParts);
    if (enabled && normalizedPart) {
        nextParts.add(normalizedPart);
    } else {
        nextParts.delete(normalizedPart);
    }
    setMobileTopbarLabelParts(Array.from(nextParts));
}

function setTopbarCustomText(value) {
    const nextText = normalizeTopbarCustomText(value);
    if (nnState.topbarLabel.customText === nextText) {
        return;
    }

    nnState.topbarLabel.customText = nextText;
    safeSetItem(NN_STORAGE_KEYS.topbarLabelCustomText, nextText);
    flushNnStorageWrites();
    updateThemePickerUi();
    updateTopBarBrand();
}

function setTopbarLabelClickCycle(enabled) {
    const mode = isMobileViewport() ? 'mobile' : 'desktop';
    const nextValue = Boolean(enabled);
    if (nnState.topbarLabel.clickCycle[mode] === nextValue) {
        return;
    }

    nnState.topbarLabel.clickCycle[mode] = nextValue;
    const storageKey = mode === 'mobile'
        ? NN_STORAGE_KEYS.topbarLabelClickCycleMobile
        : NN_STORAGE_KEYS.topbarLabelClickCycleDesktop;
    safeSetItem(storageKey, String(nextValue));
    flushNnStorageWrites();
    updateThemePickerUi();
    updateTopBarBrand();
}

function updateThemeBadge() {
    const badge = document.getElementById('sb-theme-current-label');
    if (!badge) {
        return;
    }

    badge.textContent = getThemeOption(nnState.theme).label;
}

function getSillyTavernContext() {
    // SillyTavern.getContext() throws a TDZ ReferenceError on slow boots when
    // it is called before script.js finishes initializing its module-level
    // `chat` binding. Treat that the same as "context not ready yet".
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function isExtensionEnabled(name) {
    const context = getSillyTavernContext();
    const disabledExtensions = context?.extensionSettings?.disabledExtensions;

    if (!Array.isArray(disabledExtensions)) {
        return true;
    }

    const normalizedName = normalizeExtensionName(name);
    const aliases = new Set(NN_EXTENSION_ALIASES[normalizedName] ?? [normalizedName]);
    return !disabledExtensions.some(disabled => {
        const normalizedDisabled = normalizeExtensionName(disabled);
        return aliases.has(normalizedDisabled);
    });
}

function normalizeExtensionName(name) {
    return String(name || '').replace(/^third-party\//i, '').toLowerCase();
}

function syncMessageActionExtensionVisibility(root = document) {
    if (typeof root === 'number') {
        root = document.querySelector(`.mes[mesid="${root}"]`) || document;
    }

    if (!root?.querySelectorAll) {
        return;
    }

    root.querySelectorAll('[data-requires-extension]').forEach(button => {
        if (!(button instanceof HTMLElement)) {
            return;
        }

        const requiredExtension = button.dataset.requiresExtension;
        const isEnabled = isExtensionEnabled(requiredExtension);
        button.classList.toggle('displayNone', !isEnabled);
        button.toggleAttribute('aria-hidden', !isEnabled);
        if (!isEnabled) {
            button.setAttribute('tabindex', '-1');
        } else if (button.getAttribute('tabindex') === '-1') {
            button.removeAttribute('tabindex');
        }
    });
}

function bindMessageActionExtensionEvents() {
    if (nnMessageActionEventsBound) {
        return;
    }

    const context = getSillyTavernContext();
    if (!context?.eventSource || !context?.event_types) {
        return;
    }

    nnMessageActionEventsBound = true;
    context.eventSource.on(context.event_types.EXTENSION_SETTINGS_LOADED, () => syncMessageActionExtensionVisibility());
    context.eventSource.on(context.event_types.SETTINGS_UPDATED, () => syncMessageActionExtensionVisibility());
    context.eventSource.on(context.event_types.USER_MESSAGE_RENDERED, data => syncMessageActionExtensionVisibility(data?.element || data));
    context.eventSource.on(context.event_types.CHARACTER_MESSAGE_RENDERED, data => syncMessageActionExtensionVisibility(data?.element || data));
}

function getChatScriptModule() {
    if (!nnChatScriptModulePromise) {
        nnChatScriptModulePromise = import('../script.js');
    }

    return nnChatScriptModulePromise;
}

function getMainScriptModule() {
    if (!nnMainScriptModulePromise) {
        nnMainScriptModulePromise = import('../script.js');
    }

    return nnMainScriptModulePromise;
}

function getCookieClearDomains(hostname) {
    if (!hostname || hostname === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
        return [''];
    }

    const parts = hostname.split('.').filter(Boolean);
    const domains = [''];

    for (let index = 0; index < parts.length - 1; index++) {
        const domain = parts.slice(index).join('.');
        domains.push(domain, `.${domain}`);
    }

    return [...new Set(domains)];
}

function getCookieClearPaths(pathname) {
    const paths = new Set(['/']);
    const segments = pathname.split('/').filter(Boolean);
    let currentPath = '';

    for (const segment of segments) {
        currentPath += `/${segment}`;
        paths.add(currentPath);
        paths.add(`${currentPath}/`);
    }

    return [...paths];
}

function getCookieClearNames(cookieName) {
    const names = new Set([cookieName]);

    try {
        names.add(encodeURIComponent(decodeURIComponent(cookieName)));
    } catch {
        names.add(encodeURIComponent(cookieName));
    }

    return [...names];
}

// Neconyan: iOS WebKit keeps cookies outside cache/storage APIs, so expire them explicitly.
function clearAllBrowserCookies() {
    if (!document.cookie) {
        return 0;
    }

    const cookieNames = document.cookie
        .split(';')
        .map(cookie => cookie.trim().split('=')[0])
        .filter(Boolean);
    const domains = getCookieClearDomains(window.location.hostname);
    const paths = getCookieClearPaths(window.location.pathname);
    const expires = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';

    for (const cookieName of cookieNames) {
        for (const clearName of getCookieClearNames(cookieName)) {
            for (const path of paths) {
                document.cookie = `${clearName}=; ${expires}; max-age=0; path=${path}; SameSite=Lax`;

                for (const domain of domains) {
                    if (!domain) {
                        continue;
                    }

                    document.cookie = `${clearName}=; ${expires}; max-age=0; path=${path}; domain=${domain}; SameSite=Lax`;
                }
            }
        }
    }

    return cookieNames.length;
}

async function confirmClearCookiesAndCache() {
    const context = getSillyTavernContext();
    if (!context?.Popup?.show?.confirm) {
        return window.confirm('Clear cookies & cache? This removes browser-accessible Neconyan cookies and cached UI data, then reloads the page.');
    }

    const result = await context?.Popup?.show?.confirm?.(
        'Clear cookies & cache?',
        'This removes browser-accessible Neconyan cookies, browser cache, temporary session data, and IndexedDB cache stores, then reloads the page. Saved settings and account data stay intact, but you may need to sign in again if your setup uses browser cookies.',
        {
            okButton: 'Clear cookies & cache',
            cancelButton: 'Cancel',
        },
    );

    if (context?.POPUP_RESULT) {
        return result === context.POPUP_RESULT.AFFIRMATIVE;
    }

    return result === true || result === 1;
}

async function clearServerCookies() {
    const response = await fetch('/api/cookies/clear', {
        method: 'POST',
        headers: getRequestHeadersFromContext(),
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new Error(`Server cookie clear failed: ${response.status} ${response.statusText}`);
    }

    try {
        return await response.json();
    } catch {
        return { success: true };
    }
}

async function handleClearCookiesAndCacheClick(event) {
    event?.preventDefault();

    const button = document.getElementById('clear_cookies_cache_button');
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
        return;
    }

    button.disabled = true;
    button.classList.add('disabled');
    button.setAttribute('aria-busy', 'true');

    try {
        const confirmed = await confirmClearCookiesAndCache();
        if (!confirmed) {
            button.disabled = false;
            button.classList.remove('disabled');
            button.removeAttribute('aria-busy');
            return;
        }

        const clearFrontendCache = window.NeconyanClearFrontendCache;
        if (typeof clearFrontendCache !== 'function') {
            throw new Error('Cache clear helper is not available yet. Reload the page and try again.');
        }

        const didClear = await clearFrontendCache({ skipConfirmation: true });
        if (!didClear) {
            button.disabled = false;
            button.classList.remove('disabled');
            button.removeAttribute('aria-busy');
            return;
        }

        const serverCookieResult = await clearServerCookies();
        const clearedCookieCount = clearAllBrowserCookies();
        globalThis.toastr?.success?.('Cookies and cache cleared. Reloading Neconyan...', 'Cookies cleared');
        console.info(`[Cache] Expired ${clearedCookieCount} browser cookies and queued ${serverCookieResult?.expirationAttempts ?? 0} server cookie expirations before reload`);
        window.setTimeout(() => window.location.reload(), 1000);
    } catch (error) {
        console.error('Failed to clear cookies and cache', error);
        globalThis.toastr?.error?.(String(error?.message || error), 'Clear failed');
        button.disabled = false;
        button.classList.remove('disabled');
        button.removeAttribute('aria-busy');
    }
}

function bindClearCookiesAndCacheButton() {
    const button = document.getElementById('clear_cookies_cache_button');
    if (!(button instanceof HTMLButtonElement) || button.dataset.sbCookiesCacheBound === 'true') {
        return;
    }

    button.dataset.sbCookiesCacheBound = 'true';
    button.addEventListener('click', event => {
        void handleClearCookiesAndCacheClick(event);
    });
}

function hasActiveTopBarChat(context = getSillyTavernContext()) {
    return Boolean(context && (context.groupId || (context.characterId !== undefined && context.characterId !== null)));
}

function getTopBarCharacterLabel(context = getSillyTavernContext()) {
    if (!context) {
        return '';
    }

    if (context.groupId) {
        const activeGroup = context.groups?.find(group => String(group?.id) === String(context.groupId));
        return activeGroup?.name?.trim() || '';
    }

    if (context.characterId !== undefined && context.characterId !== null) {
        const activeCharacter = context.characters?.[context.characterId];
        return activeCharacter?.name?.trim() || context.name2?.trim() || '';
    }

    return '';
}

function getDefaultTopBarLabel(context = getSillyTavernContext()) {
    return getTopBarCharacterLabel(context) || NN_IDLE_BRAND_LABEL;
}

function formatTopbarContextTokens(value) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return '';
    }

    return Math.max(0, Math.round(numericValue)).toLocaleString();
}

function getPromptManagerTokenUsage(promptManager) {
    const directValue = Number(promptManager?.tokenUsage);
    if (Number.isFinite(directValue)) {
        return Math.max(0, Math.round(directValue));
    }

    const tokenHandler = promptManager?.getTokenHandler?.();
    const total = Number(tokenHandler?.getTotal?.());
    return Number.isFinite(total) ? Math.max(0, Math.round(total)) : null;
}

function setTopbarContextTokens(tokens) {
    const normalizedValue = Number.isFinite(Number(tokens)) ? Math.max(0, Math.round(Number(tokens))) : null;
    if (nnState.topbarLabel.contextTokens === normalizedValue) {
        return;
    }

    nnState.topbarLabel.contextTokens = normalizedValue;
    updateTopBarBrand();
}

function isTopbarContextLabelEnabled() {
    return nnState.topbarLabel.desktopParts.includes('ctx')
        || nnState.topbarLabel.mobileParts.includes('ctx');
}

function syncTopbarContextTokensFromPromptManager() {
    const context = getSillyTavernContext();
    const promptManager = context?.promptManager;

    if (!hasActiveTopBarChat(context) || context?.mainApi !== 'openai') {
        setTopbarContextTokens(null);
        return;
    }

    setTopbarContextTokens(getPromptManagerTokenUsage(promptManager));
}

function scheduleTopbarContextRefresh(delay = NN_TOPBAR_CONTEXT_REFRESH_DEBOUNCE) {
    window.clearTimeout(nnState.topbarLabel.refreshTimer);

    if (!isTopbarContextLabelEnabled()) {
        syncTopbarContextTokensFromPromptManager();
        return;
    }

    nnState.topbarLabel.refreshTimer = window.setTimeout(() => {
        void refreshTopbarContextTokens();
    }, delay);
}

async function refreshTopbarContextTokens() {
    const context = getSillyTavernContext();
    const promptManager = context?.promptManager;

    if (!hasActiveTopBarChat(context) || context?.mainApi !== 'openai') {
        setTopbarContextTokens(null);
        return;
    }

    if (!promptManager || typeof promptManager.tryGenerate !== 'function') {
        syncTopbarContextTokensFromPromptManager();
        return;
    }

    if (nnState.topbarLabel.refreshInFlight) {
        nnState.topbarLabel.refreshPending = true;
        return;
    }

    nnState.topbarLabel.refreshInFlight = true;
    nnState.topbarLabel.refreshPending = false;
    const refreshToken = ++nnState.topbarLabel.refreshToken;
    syncTopbarContextTokensFromPromptManager();

    try {
        await promptManager.tryGenerate();
    } catch {
        // Ignore dry-run failures and keep the most recent known value.
    } finally {
        nnState.topbarLabel.refreshInFlight = false;
    }

    if (refreshToken !== nnState.topbarLabel.refreshToken) {
        return;
    }

    syncTopbarContextTokensFromPromptManager();

    if (nnState.topbarLabel.refreshPending) {
        nnState.topbarLabel.refreshPending = false;
        scheduleTopbarContextRefresh(80);
    }
}

function getConfiguredTopbarLabelParts() {
    if (isMobileViewport()) {
        return normalizeTopbarLabelParts(nnState.topbarLabel.mobileParts);
    }

    return normalizeTopbarLabelParts(nnState.topbarLabel.desktopParts);
}

function getTopbarLabelCycleParts(context = getSillyTavernContext()) {
    const cycleParts = ['char'];
    if (hasActiveTopBarChat(context) && context?.mainApi === 'openai') {
        cycleParts.push('ctx');
    }
    if (getTopBarModelLabel()) {
        cycleParts.push('model');
    }
    if (nnState.topbarLabel.customText) {
        cycleParts.push('custom');
    }

    return cycleParts;
}

function getTopBarModelLabel() {
    let model = '';
    try {
        model = String(getGeneratingModel() ?? '').trim();
    } catch {
        return '';
    }

    if (!model || model === 'no_connection') {
        return '';
    }

    return power_user?.timestamp_model_name_short ? getShortModelName(model) : model;
}

function getTopBarLabelPartText(partId, context = getSillyTavernContext()) {
    switch (partId) {
        case 'model':
            return getTopBarModelLabel();
        case 'ctx':
            if (!hasActiveTopBarChat(context) || context?.mainApi !== 'openai') {
                return '';
            }

            return formatTopbarContextTokens(nnState.topbarLabel.contextTokens) || '...';
        case 'char':
            return getTopBarCharacterLabel(context);
        case 'custom':
            return nnState.topbarLabel.customText;
        default:
            return '';
    }
}

function cycleTopBarLabel() {
    // Neconyan: a tap on the title switches the configured label and saves it for this device,
    // so the choice survives chat changes and reloads instead of snapping back after a preview.
    const cycleParts = getTopbarLabelCycleParts();
    const configuredParts = getConfiguredTopbarLabelParts();
    const currentIndex = cycleParts.findIndex(partId => configuredParts.includes(partId));
    const nextPart = cycleParts[(currentIndex + 1) % cycleParts.length];

    if (isMobileViewport()) {
        setMobileTopbarLabelParts([nextPart]);
    } else {
        setDesktopTopbarLabelParts([nextPart]);
    }
}

function returnToChatSurface() {
    // Close every overlay surface without touching the active chat itself.
    window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
    closeShell('left');
    closeShell('right');
    closeCharacterPanelUnlessPinned();
    closeMobileNav();
    closeMobileChatTools();
    setConnectionStripOpenState(false);
    queueLandingPageStateSync();
}

function handleTopBarTitleActivation() {
    if (isTopbarLabelClickCycleEnabled()) {
        cycleTopBarLabel();
        return;
    }

    returnToChatSurface();
}

function bindTopBarTitleCycle(title) {
    if (!(title instanceof HTMLElement) || title.dataset.sbTopbarTitleCycleBound === 'true') {
        return;
    }

    title.dataset.sbTopbarTitleCycleBound = 'true';
    title.addEventListener('click', event => {
        event.stopPropagation();
        handleTopBarTitleActivation();
    });
    title.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        handleTopBarTitleActivation();
    });
}

function getTopBarLabel() {
    const context = getSillyTavernContext();
    const parts = getConfiguredTopbarLabelParts()
        .map(partId => normalizeTopbarLabelPart(partId))
        .filter(Boolean);
    const labelParts = NN_TOPBAR_LABEL_PART_ORDER
        .filter(partId => parts.includes(partId))
        .map(partId => getTopBarLabelPartText(partId, context))
        .filter(Boolean);

    return labelParts.length ? labelParts.join(' · ') : getDefaultTopBarLabel(context);
}

function updateTopBarBrand() {
    const title = document.getElementById('sb-topbar-title');
    const brand = document.querySelector('.sb-topbar-brand');

    if (!(title instanceof HTMLElement) || !(brand instanceof HTMLElement)) {
        return;
    }

    const context = getSillyTavernContext();
    const label = getTopBarLabel();
    const isActiveChat = hasActiveTopBarChat(context);

    bindTopBarTitleCycle(title);
    title.textContent = label;
    title.title = label;
    title.setAttribute('aria-label', isTopbarLabelClickCycleEnabled()
        ? t`${label}. Tap to switch the top bar label.`
        : t`${label}. Tap to return to the chat.`);
    title.classList.toggle('is-chat', isActiveChat);
    brand.dataset.brandState = isActiveChat ? 'chat' : 'idle';
    queueTopbarBrandFit();
}

function scheduleTopBarBrandBindingRetry(delay = 240) {
    window.clearTimeout(nnState.topbarLabel.bindingRetryTimer);
    nnState.topbarLabel.bindingRetryTimer = window.setTimeout(() => {
        bindTopBarBrand();
    }, delay);
}

function bindTopBarBrandWindowEvents() {
    if (nnState.topbarLabel.windowBindingsAttached) {
        return;
    }

    const refreshWithContext = () => {
        window.requestAnimationFrame(updateTopBarBrand);
        scheduleTopbarContextRefresh(0);
        bindTopBarBrand();
    };

    document.addEventListener('input', event => {
        const targetId = event.target instanceof HTMLElement ? event.target.id : '';
        if (targetId === 'messageModelNameShortEnabled' || targetId.endsWith('_model_id')) {
            window.requestAnimationFrame(updateTopBarBrand);
        }
    });
    window.addEventListener('pageshow', refreshWithContext, { passive: true });
    window.addEventListener('focus', refreshWithContext, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            refreshWithContext();
        }
    });

    nnState.topbarLabel.windowBindingsAttached = true;
}

function bindTopBarBrand() {
    const context = getSillyTavernContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes ?? context?.event_types;
    bindTopBarBrandWindowEvents();

    if (!eventSource || !eventTypes) {
        window.requestAnimationFrame(updateTopBarBrand);
        scheduleTopbarContextRefresh(0);
        scheduleTopBarBrandBindingRetry();
        return;
    }

    window.clearTimeout(nnState.topbarLabel.bindingRetryTimer);

    if (nnState.topbarLabel.boundEventSource === eventSource) {
        window.requestAnimationFrame(updateTopBarBrand);
        scheduleTopbarContextRefresh(0);
        return;
    }

    const refresh = () => window.requestAnimationFrame(updateTopBarBrand);
    const refreshWithContext = () => {
        refresh();
        scheduleTopbarContextRefresh();
    };
    const events = [
        eventTypes.APP_READY,
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_CREATED,
        eventTypes.GROUP_CHAT_CREATED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.CHARACTER_EDITED,
        eventTypes.CHARACTER_RENAMED,
        eventTypes.CHARACTER_DELETED,
        eventTypes.GROUP_UPDATED,
        eventTypes.PERSONA_CHANGED,
        eventTypes.MAIN_API_CHANGED,
        eventTypes.SETTINGS_UPDATED,
        eventTypes.WORLDINFO_SETTINGS_UPDATED,
    ].filter(Boolean);

    for (const eventName of new Set(events)) {
        eventSource.on(eventName, refreshWithContext);
    }

    const modelEvents = [
        eventTypes.CHATCOMPLETION_MODEL_CHANGED,
        eventTypes.CHATCOMPLETION_SOURCE_CHANGED,
        eventTypes.ONLINE_STATUS_CHANGED,
    ].filter(Boolean);

    for (const eventName of new Set(modelEvents)) {
        eventSource.on(eventName, refresh);
    }

    if (eventTypes.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, () => {
            syncTopbarContextTokensFromPromptManager();
            refresh();
        });
    }

    nnState.topbarLabel.boundEventSource = eventSource;
    refresh();
    scheduleTopbarContextRefresh(0);
}

function stopProxyPointerPropagation(element) {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    const stop = event => {
        event.stopPropagation();
    };

    element.addEventListener('mousedown', stop);
    element.addEventListener('pointerdown', stop);
    // Passive: the handler never calls preventDefault, and a non-passive touchstart on every
    // button pulls WebKit off its compositor scrolling path, which stalls the icons-only rail.
    element.addEventListener('touchstart', stop, { passive: true });
}

function createProxyButton({ id, icon, label, title, className = '' }, onClick) {
    const button = createElement('button', {
        id,
        className: `sb-proxy-button ${className}`.trim(),
        attrs: {
            type: 'button',
            title,
            'aria-label': title,
            'aria-expanded': 'false',
            'data-sb-proxy-button': 'true',
        },
    });

    button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span>`;
    stopProxyPointerPropagation(button);
    button.addEventListener('click', debounceAction(onClick));

    return button;
}

function getTopbarPageConfig(page) {
    if (isSearchShortcutTarget(page.value)) {
        return getShortcutConfig(page.value);
    }

    if (page.shellKey === 'characters') {
        return getCharacterPanelTabConfig(page.tabId);
    }

    const shellConfig = getShellConfig(page.shellKey);

    return [
        shellConfig?.baseTab,
        ...(shellConfig?.embeddedTabs ?? []),
        ...(shellConfig?.customTabs ?? []),
    ].find(tab => tab?.id === page.tabId) ?? null;
}

function createTopbarPageButton(page) {
    const config = getTopbarPageConfig(page);
    const label = config?.label ?? page.tabId;
    const button = createProxyButton(
        {
            id: '',
            icon: config?.icon ?? 'fa-circle-dot',
            label,
            title: label,
            className: 'sb-proxy-button-icon-only sb-topbar-page-button',
        },
        () => activateShortcutTarget(page.value),
    );

    button.dataset.sbTopbarPage = page.value;

    return button;
}

function createDesktopQuickActionButton(item) {
    const action = normalizeMobileQuickAction(item);
    if (!action) return null;
    const button = createElement('button', {
        className: 'sb-proxy-button sb-topbar-quick-action',
        attrs: {
            type: 'button',
            title: t`Open ${action.label}`,
            'aria-label': t`Open ${action.label}`,
        },
    });
    button.innerHTML = `<i class="fa-solid ${action.icon || NN_MOBILE_QUICK_ACTION_ICON_FALLBACK}" aria-hidden="true"></i><span>${action.label}</span>`;
    button.addEventListener('click', () => activateMobileQuickAction(action));
    return button;
}

function refreshDesktopTopbarQuickActions() {
    const container = document.getElementById('sb-topbar-quick-actions');
    if (!(container instanceof HTMLElement)) return;
    container.replaceChildren();
    container.hidden = !nnState.desktopNav.showQuickActions;
    if (container.hidden) return;
    for (const action of nnState.desktopQuickActions) {
        const button = createDesktopQuickActionButton(action);
        if (button) container.appendChild(button);
    }
}

function buildTopbarPageRail(railId, pages) {
    const rail = createElement('div', {
        id: railId,
        className: 'sb-topbar-pages',
        attrs: { role: 'group' },
    });

    for (const page of pages) {
        rail.appendChild(createTopbarPageButton(page));
    }

    return rail;
}

// Neconyan: a 1px rule between two clusters, visible at every size while icons-only mode is on
// so the boundaries read the same with or without the brand label between them.
function createTopbarClusterDivider(id) {
    return createElement('span', {
        id,
        className: 'sb-topbar-cluster-divider',
        attrs: { 'aria-hidden': 'true' },
    });
}

// Neconyan: the whole bar has one canonical child order per group per mode, and the layout is
// applied by replaying that order rather than by moving individual buttons and remembering where
// each came from. appendChild on a node the group already holds is a move, so replaying is
// idempotent and no remembered reference node can go stale.
//
// The cluster rails are display:none while the mode is off, so the "off" order renders exactly as
// the bar always has: the button sequence never changes between modes, only labels and the added
// clusters do. Phones fold the Characters pages into the single scrolling left strip, because the
// right group is pinned at its natural width there and would otherwise starve the strip.
function getTopbarGroupOrder({ iconsOnly, mobile }) {
    const [workspace, customize, characters] = NN_TOPBAR_CLUSTERS;
    const quickAccessIds = NN_SHORTCUT_SLOTS.map(side => getShortcutButtonId(side));
    // The divider spans ride the order too; CSS decides when they are visible.
    const left = [
        'sb-hamburger',
        'sb-topbar-clock',
        workspace.leadId,
        workspace.railId,
        'sb-topbar-divider-customize',
        customize.leadId,
        customize.railId,
    ];
    // The extension slot leads the right group in every mode: syncTopbarGroupOrder() re-appends
    // every listed id, so an unlisted element would be pushed to the front of the group as a side
    // effect. It stays out of the left group because that one scrolls in cramped mode, which would
    // clip an adopted extension's dropdown.
    const right = [TOPBAR_EXTENSION_SLOT_ID, 'sb-topbar-quick-actions'];

    if (iconsOnly) {
        right.push(...quickAccessIds);
    } else {
        left.push('sb-shortcut-left', 'sb-shortcut-slot3', 'sb-shortcut-slot4');
        right.push('sb-shortcut-slot6', 'sb-shortcut-slot5', 'sb-shortcut-right');
    }

    // Advanced is a presentation toggle, so it stays between Quick Access and Home in both
    // layouts. It never changes the shell state or rebuilds the chat surface.
    right.push('sb-home-toggle', 'sb-topbar-divider-home');

    if (iconsOnly && mobile) {
        // The characters pages ride the strip, so the divider marks where they start there;
        // the anchor stays pinned right beside Home.
        right.push(characters.leadId);
        left.push('sb-topbar-divider-characters', characters.railId);
    } else {
        // The characters divider rides along hidden here; the home divider above carries the
        // Home|Characters boundary on desktop.
        right.push('sb-topbar-divider-characters', characters.leadId, characters.railId);
    }

    return { left, right };
}

function syncTopbarGroupOrder() {
    const leftGroup = document.querySelector('#sb-topbar-inner > .sb-topbar-group-left');
    const rightGroup = document.querySelector('#sb-topbar-inner > .sb-topbar-group-right');

    if (!(leftGroup instanceof HTMLElement) || !(rightGroup instanceof HTMLElement)) {
        return;
    }

    const order = getTopbarGroupOrder({
        iconsOnly: isTopbarIconsOnlyActive(),
        mobile: isMobileViewport(),
    });

    for (const [group, ids] of [[leftGroup, order.left], [rightGroup, order.right]]) {
        for (const id of ids) {
            const element = document.getElementById(id);

            if (element instanceof HTMLElement) {
                group.appendChild(element);
            }
        }
    }
}

function syncTopbarIconsOnlyLayout() {
    const iconsOnly = isTopbarIconsOnlyActive();

    for (const buttonId of NN_TOPBAR_ANCHOR_IDS) {
        document.getElementById(buttonId)?.classList.toggle('sb-proxy-button-icon-only', iconsOnly);
    }

    syncTopbarGroupOrder();
    syncTopbarIconsOnlyDedupe();
    syncTopbarBrandFit();

    for (const cluster of NN_TOPBAR_CLUSTERS) {
        document.getElementById(cluster.railId)?.toggleAttribute('inert', !iconsOnly);
    }
}

// Neconyan: the complete clusters keep their canonical positions. A Quick Access slot pointed at
// one of those pages yields in icons-only mode; non-cluster actions such as Search remain visible.
function syncTopbarIconsOnlyDedupe() {
    const clusterButtons = document.querySelectorAll('.sb-topbar-page-button[data-sb-topbar-page]');
    const claimedByClusters = new Set(Array.from(clusterButtons).filter(isActuallyVisible).map(button => button.dataset.sbTopbarPage));
    const iconsOnly = isTopbarIconsOnlyActive();

    for (const side of NN_SHORTCUT_SLOTS) {
        const button = document.getElementById(getShortcutButtonId(side));

        if (button instanceof HTMLElement) {
            button.classList.toggle(
                'sb-topbar-shortcut-duplicate',
                iconsOnly && claimedByClusters.has(getShortcutTarget(side)),
            );
        }
    }
}

// Neconyan: once the icon count outgrows the bar the brand label is the least useful thing on
// it, so it yields its width to the rails. The decision is made from the rails' full content
// width plus a fixed label reservation, never from the label's current state, so showing and
// hiding it cannot feed back into itself and oscillate.
function syncTopbarBrandFit() {
    const inner = document.getElementById('sb-topbar-inner');
    const brand = document.querySelector('.sb-topbar-brand');

    if (!(inner instanceof HTMLElement) || !(brand instanceof HTMLElement)) {
        return;
    }

    if (!isTopbarIconsOnlyActive()) {
        delete document.documentElement.dataset.sbTopbarBrandCramped;
        delete document.documentElement.dataset.sbTopbarScroll;
        return;
    }

    // Phones drop the label unconditionally, so only the overflow verdict matters there.
    const labelCanFit = !isMobileViewport();

    if (isActuallyVisible(brand)) {
        nnState.topbarPages.brandWidth = Math.max(brand.scrollWidth, NN_TOPBAR_BRAND_MIN_WIDTH);
    }

    const groups = [...inner.querySelectorAll(':scope > .sb-topbar-group')];
    const gap = Number.parseFloat(getComputedStyle(inner).columnGap) || 0;
    let needed = 0;

    for (const group of groups) {
        for (const child of group.children) {
            if (!(child instanceof HTMLElement) || !isActuallyVisible(child)) {
                continue;
            }

            // Rails are scroll containers, so their laid-out width understates what they hold.
            needed += child.classList.contains('sb-topbar-pages') ? child.scrollWidth : child.offsetWidth;
            // The cluster seams and divider centring live in margins, which offsetWidth omits.
            // Leaving them uncounted opens a dead band where the bar overflows its grid tracks
            // -- the groups visibly overlap -- yet the scroll verdict never trips.
            const childStyle = getComputedStyle(child);
            needed += (Number.parseFloat(childStyle.marginInlineStart) || 0) + (Number.parseFloat(childStyle.marginInlineEnd) || 0);
            needed += gap;
        }
    }

    const reservation = nnState.topbarPages.brandWidth || NN_TOPBAR_BRAND_MIN_WIDTH;
    const available = inner.clientWidth;

    if (labelCanFit && needed + reservation + gap > available) {
        document.documentElement.dataset.sbTopbarBrandCramped = 'true';
    } else {
        delete document.documentElement.dataset.sbTopbarBrandCramped;
    }

    // Even with the label gone the icons can outrun the bar. Rather than let a rail clip a
    // button to an unreadable sliver, hand the whole bar one scroll axis and pin the trailing
    // controls so Quick Actions, Search, Home and Characters stay reachable at any width.
    if (needed > available) {
        document.documentElement.dataset.sbTopbarScroll = 'true';
    } else {
        delete document.documentElement.dataset.sbTopbarScroll;
    }
}

function queueTopbarBrandFit() {
    if (nnState.topbarPages.fitFrame) {
        return;
    }

    nnState.topbarPages.fitFrame = window.requestAnimationFrame(() => {
        nnState.topbarPages.fitFrame = 0;
        syncTopbarBrandFit();
    });
}

function bindSearchShortcutPreFocus(button, targetGetter) {
    if (!(button instanceof HTMLElement) || typeof targetGetter !== 'function') {
        return;
    }

    const openAndFocusSearch = () => {
        if (!isSearchShortcutTarget(targetGetter())) {
            return;
        }

        const searchState = getUniversalSearchState();
        if (searchState.expanded) {
            return;
        }

        closeAllDropdowns({ except: 'search' });
        setUniversalSearchOpenState(true, { focusInput: true });
        nnSearchShortcutPreFocusAt = performance.now();
    };

    button.addEventListener('pointerdown', openAndFocusSearch, { passive: true });
    button.addEventListener('touchstart', openAndFocusSearch, { passive: true });
}

function createTopBarIconButton({ id = '', icon, title, className = '', label = '' }, onClick) {
    const button = createElement('button', {
        id,
        className: `sb-chatbar-button ${className}`.trim(),
        attrs: {
            type: 'button',
            title,
            'aria-label': title,
        },
    });

    button.innerHTML = `
        <i class="fa-solid ${icon}" aria-hidden="true"></i>
        ${label ? `<span>${label}</span>` : ''}
    `;

    // Only stop mousedown/pointerdown propagation — stopping touchstart
    // interferes with mobile click synthesis and causes double-tap issues.
    const stop = event => event.stopPropagation();
    button.addEventListener('mousedown', stop);
    button.addEventListener('pointerdown', stop);
    button.addEventListener('click', onClick);

    return button;
}

function getChatbarState() {
    return nnState.chatbar;
}

function setTopbarUtilityButtonIcon(button, icon, title) {
    if (!(button instanceof HTMLButtonElement)) {
        return;
    }

    button.title = title;
    button.setAttribute('aria-label', title);

    const iconElement = button.querySelector('i');
    if (iconElement instanceof HTMLElement) {
        iconElement.className = `fa-solid ${icon}`;
    }
}

function updateTopbarUtilityButtons() {
    const state = getChatbarState();
    const toggleButton = state.chatbarToggleButton;
    const dragHandleButton = state.dragHandleButton;
    const isVisible = state.visible;

    if (toggleButton instanceof HTMLButtonElement) {
        setTopbarUtilityButtonIcon(
            toggleButton,
            isVisible ? 'fa-eye-slash' : 'fa-eye',
            isVisible ? 'Hide top chat bar' : 'Show top chat bar',
        );
        setButtonPressed(toggleButton, isVisible);
    }

    if (dragHandleButton instanceof HTMLButtonElement) {
        const dragTitle = isMobileViewport()
            ? 'Drag to move the chat info bar on mobile.'
            : 'Drag to move the chat info bar. Double-click to reset.';
        setTopbarUtilityButtonIcon(dragHandleButton, 'fa-grip-lines', dragTitle);
        setButtonDisabled(dragHandleButton, false);
    }
}

function syncTopbarLayoutState() {
    const stack = document.getElementById('sb-topbar-stack');
    const hasVisibleChatbar = stack?.querySelector('#sb-chatbar-layer') instanceof HTMLElement
        && getChatbarState().visible;

    document.body.classList.toggle('sb-topbar-compact', !hasVisibleChatbar);
}

function setChatbarVisible(shouldShow, { persist = true } = {}) {
    const nextVisible = Boolean(shouldShow);
    const state = getChatbarState();
    state.visible = nextVisible;

    document.body.classList.toggle('sb-chatbar-hidden', !nextVisible);

    if (!nextVisible) {
        setConnectionStripOpenState(false);
    }

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.chatbarVisible, String(nextVisible));
    }

    updateTopbarUtilityButtons();
    syncTopbarLayoutState();
    scheduleChatbarRefresh(0);
}

function toggleChatbarVisibility() {
    setChatbarVisible(!getChatbarState().visible);
}

function syncChatbarVisibilityState() {
    setChatbarVisible(getChatbarState().visible, { persist: false });
}

function getTopbarDragKey(event) {
    if (!event) {
        return null;
    }

    if (event.changedTouches?.length) {
        return `touch:${event.changedTouches[0].identifier}`;
    }

    if (event.touches?.length) {
        return `touch:${event.touches[0].identifier}`;
    }

    if (typeof event.pointerType === 'string') {
        if (event.pointerType === 'mouse') {
            return 'mouse';
        }

        if (Number.isFinite(event.pointerId)) {
            return `pointer:${event.pointerId}`;
        }
    }

    if (Number.isFinite(event.pointerId)) {
        return `pointer:${event.pointerId}`;
    }

    if (event.type?.startsWith?.('mouse')) {
        return 'mouse';
    }

    return null;
}

function getTopbarDragPoint(event) {
    if (!event) {
        return null;
    }

    if (event.changedTouches?.length) {
        return event.changedTouches[0];
    }

    if (event.touches?.length) {
        return event.touches[0];
    }

    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
        return event;
    }

    return null;
}

function updateTopbarDrag(event) {
    const state = getChatbarState();
    const point = getTopbarDragPoint(event);

    if (!state.dragging || !point || getTopbarDragKey(event) !== state.dragging.key) {
        return;
    }

    setTopbarOffset({
        x: state.dragging.startX + (point.clientX - state.dragging.originX),
        y: state.dragging.startY + (point.clientY - state.dragging.originY),
    }, { persist: false });

    if (event.cancelable) {
        event.preventDefault();
    }
}

function endTopbarDrag(event) {
    const state = getChatbarState();

    if (!state.dragging || getTopbarDragKey(event) !== state.dragging.key) {
        return;
    }

    document.getElementById('sb-chatbar-layer')?.classList.remove('is-dragging');
    document.body.classList.remove('sb-topbar-dragging');

    const finalOffset = clampTopbarOffset(getChatbarState().renderedTopbarOffset);
    state.dragging = null;
    setTopbarOffset(finalOffset, { persist: true });

    unbindTopbarDragEvents();
}

function unbindTopbarDragEvents() {
    const state = getChatbarState();

    if (!state.dragListenersBound) {
        return;
    }

    state.dragListenersBound = false;
    window.removeEventListener('pointermove', updateTopbarDrag);
    window.removeEventListener('pointerup', endTopbarDrag);
    window.removeEventListener('pointercancel', endTopbarDrag);
    window.removeEventListener('mousemove', updateTopbarDrag);
    window.removeEventListener('mouseup', endTopbarDrag);
    window.removeEventListener('touchmove', updateTopbarDrag);
    window.removeEventListener('touchend', endTopbarDrag);
    window.removeEventListener('touchcancel', endTopbarDrag);
}

function bindTopbarDragEvents() {
    const state = getChatbarState();

    if (state.dragListenersBound) {
        return;
    }

    state.dragListenersBound = true;
    window.addEventListener('pointermove', updateTopbarDrag);
    window.addEventListener('pointerup', endTopbarDrag);
    window.addEventListener('pointercancel', endTopbarDrag);
    window.addEventListener('mousemove', updateTopbarDrag);
    window.addEventListener('mouseup', endTopbarDrag);
    window.addEventListener('touchmove', updateTopbarDrag, { passive: false });
    window.addEventListener('touchend', endTopbarDrag);
    window.addEventListener('touchcancel', endTopbarDrag);
}

function getChatDesktopRefs() {
    return getChatbarState().desktop;
}

function getChatMobileRefs() {
    return getChatbarState().mobileTools;
}

function getChatSidebarRefs() {
    return getChatbarState().sidebar;
}

function escapeSelectorValue(value) {
    if (globalThis.CSS?.escape) {
        return globalThis.CSS.escape(String(value ?? ''));
    }

    return String(value ?? '').replace(/["\\]/g, '\\$&');
}

function stripDecoratedOptionText(value) {
    return String(value ?? '').replace(/[[(].*?[\])]/g, '').trim();
}

function getRequestHeadersFromContext(context = getSillyTavernContext()) {
    if (typeof context?.getRequestHeaders === 'function') {
        return context.getRequestHeaders();
    }

    return {
        'Content-Type': 'application/json',
    };
}

function getCsrfTokenFromHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
        return '';
    }

    const rawToken = headers['X-CSRF-Token'] ?? headers['x-csrf-token'] ?? '';
    const token = String(rawToken ?? '').trim();

    if (!token || token === 'undefined' || token === 'null') {
        return '';
    }

    return token;
}

async function waitForAuthorizedRequestHeaders(timeoutMs = 15000, context = getSillyTavernContext()) {
    const timeoutAt = Date.now() + timeoutMs;

    while (Date.now() < timeoutAt) {
        const headers = getRequestHeadersFromContext(context);

        if (getCsrfTokenFromHeaders(headers)) {
            return headers;
        }

        await wait(50);
    }

    return getRequestHeadersFromContext(context);
}

async function getAuthorizedRequestHeadersOrNull(timeoutMs = 1500, context = getSillyTavernContext()) {
    const headers = await waitForAuthorizedRequestHeaders(timeoutMs, context);
    return getCsrfTokenFromHeaders(headers) ? headers : null;
}

function normalizeChatFileName(value) {
    return String(value ?? '').replace(/\.jsonl$/i, '').trim();
}

function getChatUiContext() {
    const context = getSillyTavernContext();

    if (!context) {
        return {
            context: null,
            chatId: '',
            group: null,
            character: null,
            hasChat: false,
            canBrowseChats: false,
            canStartNewChat: false,
            label: '',
        };
    }

    const group = context.groupId
        ? context.groups?.find(item => String(item?.id) === String(context.groupId)) ?? null
        : null;
    const character = context.characterId !== undefined && context.characterId !== null
        ? context.characters?.[context.characterId] ?? null
        : null;
    const chatId = normalizeChatFileName(context.getCurrentChatId?.() ?? context.chatId ?? '');
    const canBrowseChats = Boolean(group || character);

    return {
        context,
        chatId,
        group,
        character,
        hasChat: Boolean(chatId),
        canBrowseChats,
        canStartNewChat: canBrowseChats,
        label: String(group?.name ?? character?.name ?? '').trim(),
    };
}

function getChatSortTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1e12 ? value : value * 1000;
    }

    if (typeof value === 'string') {
        const numericValue = Number(value);

        if (Number.isFinite(numericValue) && numericValue > 0) {
            return numericValue > 1e12 ? numericValue : numericValue * 1000;
        }

        const parsedValue = Date.parse(value);
        if (Number.isFinite(parsedValue)) {
            return parsedValue;
        }
    }

    return 0;
}

function formatChatTimestamp(value) {
    const timestamp = getChatSortTimestamp(value);
    if (!timestamp) {
        return '';
    }

    try {
        return new Date(timestamp).toLocaleDateString();
    } catch {
        return '';
    }
}

function formatChatPreview(value) {
    return clampText(String(value ?? '').replace(/\s+/g, ' ').trim() || 'No preview yet.', 120);
}

function formatChatTokenEstimate(value) {
    const tokens = Math.round(Number(value) || 0);
    if (tokens <= 0) {
        return '';
    }

    if (tokens >= 1_000_000) {
        return `~${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}m tokens`;
    }

    if (tokens >= 1_000) {
        return `~${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, '')}k tokens`;
    }

    return `~${tokens} tokens`;
}

function formatChatSelectorLabel(fileName, tokenEstimate = 0) {
    const tokenLabel = formatChatTokenEstimate(tokenEstimate);
    return tokenLabel ? `${fileName} (${tokenLabel})` : fileName;
}

function normalizeChatInfo(chatInfo) {
    const rawFileName = chatInfo?.file_name ?? chatInfo?.id ?? chatInfo?.chat_id ?? chatInfo ?? '';
    const fileName = normalizeChatFileName(rawFileName);

    return {
        fileName,
        preview: formatChatPreview(chatInfo?.mes ?? chatInfo?.preview ?? chatInfo?.message ?? ''),
        lastMessage: chatInfo?.last_mes ?? chatInfo?.updated_at ?? chatInfo?.create_date ?? '',
        sortTimestamp: getChatSortTimestamp(chatInfo?.last_mes ?? chatInfo?.updated_at ?? chatInfo?.create_date ?? ''),
        chatItems: Number(chatInfo?.chat_items ?? chatInfo?.message_count ?? 0) || 0,
        tokenEstimate: Number(chatInfo?.token_estimate ?? chatInfo?.tokenEstimate ?? 0) || 0,
        fileSize: String(chatInfo?.file_size ?? '').trim(),
    };
}

function sortChatFiles(files) {
    return [...files].sort((left, right) => {
        if (right.sortTimestamp !== left.sortTimestamp) {
            return right.sortTimestamp - left.sortTimestamp;
        }

        return left.fileName.localeCompare(right.fileName);
    });
}

async function fetchCharacterChatFiles(chatContext) {
    const avatarUrl = chatContext.character?.avatar;

    if (!avatarUrl) {
        return [];
    }

    try {
        const headers = await getAuthorizedRequestHeadersOrNull(2000, chatContext.context);
        if (!headers) {
            return [];
        }

        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers,
            body: JSON.stringify({ avatar_url: avatarUrl }),
        });

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        if (typeof data === 'object' && data?.error === true) {
            return [];
        }

        const chats = Array.isArray(data) ? data : Object.values(data ?? {});
        return sortChatFiles(chats.map(normalizeChatInfo).filter(chat => chat.fileName));
    } catch (error) {
        console.error('Failed to fetch character chats', error);
        return [];
    }
}

async function fetchGroupChatFiles(chatContext) {
    const groupChats = Array.isArray(chatContext.group?.chats) ? chatContext.group.chats : [];

    if (!groupChats.length) {
        return [];
    }

    try {
        const headers = await getAuthorizedRequestHeadersOrNull(2000, chatContext.context);
        if (!headers) {
            return [];
        }

        const chats = await Promise.all(groupChats.map(async chatId => {
            try {
                const response = await fetchWithCsrfRetry('/api/chats/group/info', () => ({
                    method: 'POST',
                    headers: getRequestHeadersFromContext(chatContext.context),
                    body: JSON.stringify({ id: chatId }),
                }), { refreshCsrfToken });

                if (!response.ok) {
                    if (response.status === 404) {
                        return null;
                    }

                    return normalizeChatInfo({ file_name: chatId });
                }

                const chatInfo = normalizeChatInfo(await response.json());
                return chatInfo.fileName ? chatInfo : normalizeChatInfo({ file_name: chatId });
            } catch {
                return normalizeChatInfo({ file_name: chatId });
            }
        }));

        return sortChatFiles(chats.filter(chat => chat?.fileName));
    } catch (error) {
        console.error('Failed to fetch group chats', error);
        return [];
    }
}

async function getChatFilesForContext(chatContext = getChatUiContext()) {
    if (!chatContext.canBrowseChats) {
        return [];
    }

    return chatContext.group
        ? fetchGroupChatFiles(chatContext)
        : fetchCharacterChatFiles(chatContext);
}

async function openChatById(chatId, { closeMobileTools = false } = {}) {
    const nextChatId = normalizeChatFileName(chatId);
    const chatContext = getChatUiContext();

    if (!nextChatId || !chatContext.context) {
        return;
    }

    if (nextChatId === chatContext.chatId) {
        if (closeMobileTools) {
            closeMobileChatTools();
        }
        return;
    }

    try {
        if (chatContext.group?.id) {
            await chatContext.context.openGroupChat?.(chatContext.group.id, nextChatId);
        } else {
            await chatContext.context.openCharacterChat?.(nextChatId);
        }
    } finally {
        if (closeMobileTools) {
            closeMobileChatTools();
        }

        scheduleChatbarRefresh(80);
    }
}

async function handleRenameChat() {
    const chatContext = getChatUiContext();
    const currentChatId = chatContext.chatId;

    if (!currentChatId || typeof chatContext.context?.renameChat !== 'function') {
        return;
    }

    const newChatName = await chatContext.context.Popup?.show?.input?.('Rename chat', 'Enter a new chat name:', currentChatId);

    if (!newChatName || String(newChatName).trim() === currentChatId) {
        return;
    }

    try {
        await chatContext.context.renameChat(currentChatId, String(newChatName).trim());
    } catch {
        return;
    }
    scheduleChatbarRefresh(120);
}

async function handleDeleteChat() {
    const chatContext = getChatUiContext();

    if (!chatContext.chatId) {
        return;
    }

    const confirmed = await chatContext.context?.Popup?.show?.confirm?.('Delete chat?', 'This action cannot be undone.');
    if (!confirmed) {
        return;
    }

    await chatContext.context?.executeSlashCommandsWithOptions?.('/delchat');
    scheduleChatbarRefresh(150);
}

function setBottomChatActionBusy(button, busy) {
    if (!(button instanceof HTMLElement)) {
        return;
    }

    button.classList.toggle('is-busy', Boolean(busy));
    setButtonDisabled(button, Boolean(busy));
}

async function handleAutoNameChat() {
    const chatContext = getChatUiContext();
    const button = getBottomChatBarState().autoNameButton;

    if (!chatContext.hasChat) {
        return;
    }

    setBottomChatActionBusy(button, true);
    try {
        const { autoLabelCurrentChat } = await getChatScriptModule();
        if (typeof autoLabelCurrentChat !== 'function') {
            throw new Error('Chat auto-name helper is unavailable.');
        }

        await autoLabelCurrentChat();
        scheduleBottomChatBarRefresh(160);
    } catch (error) {
        console.error('[Neconyan] Failed to auto-name current chat.', error);
        globalThis.toastr?.error?.(String(error?.message || error), 'Auto-name Chat');
    } finally {
        setBottomChatActionBusy(button, false);
    }
}

function getMassDeleteOlderThanDays(files, days, currentChatId) {
    const numericDays = Number(days);
    if (!Number.isFinite(numericDays) || numericDays <= 0) {
        return [];
    }

    const cutoff = Date.now() - (numericDays * 24 * 60 * 60 * 1000);
    return files.filter(chatFile => chatFile.fileName !== currentChatId && chatFile.sortTimestamp > 0 && chatFile.sortTimestamp < cutoff);
}

function bindChatDeleteVisualViewport(overlay) {
    const visualViewport = window.visualViewport;
    if (!(overlay instanceof HTMLElement) || !isMobileViewport() || !visualViewport) {
        return () => {};
    }

    let animationFrame = 0;

    function readViewportNumber(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : fallback;
    }

    function update() {
        animationFrame = 0;
        const fallbackWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const fallbackHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const isKeyboardClosed = Math.abs(readViewportNumber(visualViewport.height, fallbackHeight) - fallbackHeight) <= 2
            && Math.abs(readViewportNumber(visualViewport.offsetTop) || 0) <= 2
            && Math.abs(readViewportNumber(visualViewport.offsetLeft) || 0) <= 2;

        if (isKeyboardClosed) {
            overlay.style.removeProperty('--sb-chat-delete-vv-left');
            overlay.style.removeProperty('--sb-chat-delete-vv-top');
            overlay.style.removeProperty('--sb-chat-delete-vv-width');
            overlay.style.removeProperty('--sb-chat-delete-vv-height');
            overlay.classList.remove('sb-chat-delete-overlay--keyboard-open');
            return;
        }

        const viewportLeft = Math.max(0, readViewportNumber(visualViewport.offsetLeft));
        const viewportTop = Math.max(0, readViewportNumber(visualViewport.offsetTop));
        const viewportWidth = Math.max(1, readViewportNumber(visualViewport.width, fallbackWidth));
        const viewportHeight = Math.max(1, readViewportNumber(visualViewport.height, fallbackHeight));

        overlay.classList.add('sb-chat-delete-overlay--keyboard-open');
        overlay.style.setProperty('--sb-chat-delete-vv-left', `${viewportLeft}px`);
        overlay.style.setProperty('--sb-chat-delete-vv-top', `${viewportTop}px`);
        overlay.style.setProperty('--sb-chat-delete-vv-width', `${viewportWidth}px`);
        overlay.style.setProperty('--sb-chat-delete-vv-height', `${viewportHeight}px`);
    }

    function scheduleUpdate() {
        if (animationFrame) {
            return;
        }

        animationFrame = window.requestAnimationFrame(update);
    }

    overlay.classList.add('sb-chat-delete-overlay--visual-viewport');
    update();
    visualViewport.addEventListener('resize', scheduleUpdate);
    visualViewport.addEventListener('scroll', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
        if (animationFrame) {
            window.cancelAnimationFrame(animationFrame);
        }

        visualViewport.removeEventListener('resize', scheduleUpdate);
        visualViewport.removeEventListener('scroll', scheduleUpdate);
        window.removeEventListener('resize', scheduleUpdate);
        window.removeEventListener('orientationchange', scheduleUpdate);
        overlay.classList.remove('sb-chat-delete-overlay--visual-viewport');
        overlay.style.removeProperty('--sb-chat-delete-vv-left');
        overlay.style.removeProperty('--sb-chat-delete-vv-top');
        overlay.style.removeProperty('--sb-chat-delete-vv-width');
        overlay.style.removeProperty('--sb-chat-delete-vv-height');
    };
}

function showBottomChatMassDeleteDialog(files, currentChatId) {
    return new Promise(resolve => {
        const overlay = createElement('div', { className: 'sb-chat-delete-overlay' });
        const dialog = createElement('div', {
            className: 'sb-chat-delete-dialog',
            attrs: {
                role: 'dialog',
                'aria-modal': 'true',
                'aria-labelledby': 'sb-chat-delete-title',
            },
        });
        const title = createElement('h3', { id: 'sb-chat-delete-title', text: 'Mass delete chats' });
        const note = createElement('p', {
            className: 'sb-chat-delete-note',
            text: 'Delete saved chats for the current character or group. The open chat is protected.',
        });
        const list = createElement('div', { className: 'sb-chat-delete-list' });
        const ageRow = createElement('div', { className: 'sb-chat-delete-age' });
        const ageLabel = createElement('label', { text: 'Older than' });
        const ageInput = createElement('input', {
            className: 'text_pole',
            attrs: { type: 'number', min: '1', step: '1', value: '30', inputmode: 'numeric' },
        });
        const dayText = createElement('span', { text: 'days' });
        const presets = createElement('div', { className: 'sb-chat-delete-presets' });
        const status = createElement('small', { className: 'sb-chat-delete-status' });
        const actions = createElement('div', { className: 'sb-chat-delete-actions' });
        const deleteSelectedButton = createElement('button', { className: 'menu_button', text: 'Delete selected', attrs: { type: 'button' } });
        const deleteOlderButton = createElement('button', { className: 'menu_button', text: 'Delete older', attrs: { type: 'button' } });
        const cancelButton = createElement('button', { className: 'menu_button', text: 'Cancel', attrs: { type: 'button' } });
        const checkboxes = [];
        let cleanupVisualViewport = () => {};
        let isFinished = false;

        function finish(result) {
            if (isFinished) {
                return;
            }

            isFinished = true;
            document.removeEventListener('keydown', handleKeydown);
            cleanupVisualViewport();
            overlay.remove();
            resolve(result);
        }

        function getSelectedNames() {
            return checkboxes.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value);
        }

        function updateStatus() {
            const selectedCount = getSelectedNames().length;
            const olderCount = getMassDeleteOlderThanDays(files, ageInput.value, currentChatId).length;
            status.textContent = `${selectedCount} selected. ${olderCount} older than ${ageInput.value || 0} day(s).`;
            deleteSelectedButton.disabled = selectedCount === 0;
            deleteOlderButton.disabled = olderCount === 0;
        }

        function handleKeydown(event) {
            if (event.key === 'Escape') {
                finish(null);
            }
        }

        for (const days of [7, 30, 90, 180]) {
            const button = createElement('button', { className: 'menu_button', text: String(days), attrs: { type: 'button' } });
            button.addEventListener('click', () => {
                ageInput.value = String(days);
                updateStatus();
            });
            presets.appendChild(button);
        }

        for (const chatFile of files) {
            const row = createElement('label', { className: 'sb-chat-delete-row' });
            const checkbox = createElement('input', {
                attrs: {
                    type: 'checkbox',
                    value: chatFile.fileName,
                },
            });
            checkbox.disabled = chatFile.fileName === currentChatId;
            const text = createElement('span', { className: 'sb-chat-delete-row-text' });
            const name = createElement('strong', { text: chatFile.fileName });
            const meta = createElement('small', { text: [formatChatTimestamp(chatFile.lastMessage), chatFile.chatItems ? `${chatFile.chatItems} msg` : ''].filter(Boolean).join(' - ') });

            text.append(name, meta);
            row.append(checkbox, text);
            list.appendChild(row);
            if (checkbox instanceof HTMLInputElement && !checkbox.disabled) {
                checkbox.addEventListener('change', updateStatus);
                checkboxes.push(checkbox);
            }
        }

        ageInput.addEventListener('input', updateStatus);
        deleteSelectedButton.addEventListener('click', () => finish({ mode: 'selected', names: getSelectedNames() }));
        deleteOlderButton.addEventListener('click', () => finish({ mode: 'older', days: Number(ageInput.value) }));
        cancelButton.addEventListener('click', () => finish(null));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                finish(null);
            }
        });

        ageLabel.append(ageInput, dayText);
        ageRow.append(ageLabel, presets);
        actions.append(deleteSelectedButton, deleteOlderButton, cancelButton);
        dialog.append(title, note, ageRow, status, list, actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        cleanupVisualViewport = bindChatDeleteVisualViewport(overlay);
        document.addEventListener('keydown', handleKeydown);
        updateStatus();
        if (!isMobileViewport()) {
            ageInput.focus({ preventScroll: true });
        }
    });
}

async function deleteChatFileForContext(chatContext, fileName, chatModule) {
    if (chatContext.group?.id) {
        const { deleteGroupChatByName } = await import('./group-chats.js');
        return deleteGroupChatByName(chatContext.group.id, fileName);
    }

    if (chatContext.context?.characterId !== undefined && chatContext.context?.characterId !== null) {
        await chatModule.deleteCharacterChatByName(chatContext.context.characterId, fileName);
        return true;
    }

    return false;
}

async function handleMassDeleteChats() {
    const chatContext = getChatUiContext();
    const button = getBottomChatBarState().massDeleteButton;

    if (!chatContext.canBrowseChats) {
        return;
    }

    setBottomChatActionBusy(button, true);
    try {
        const files = await getChatFilesForContext(chatContext);
        const deletableFiles = files.filter(chatFile => chatFile.fileName !== chatContext.chatId);
        if (!deletableFiles.length) {
            globalThis.toastr?.info?.('No saved chats can be deleted for this character or group.', 'Mass Delete Chats');
            return;
        }

        const result = await showBottomChatMassDeleteDialog(files, chatContext.chatId);
        if (!result) {
            return;
        }

        const names = result.mode === 'older'
            ? getMassDeleteOlderThanDays(files, result.days, chatContext.chatId).map(chatFile => chatFile.fileName)
            : result.names;

        if (!names.length) {
            return;
        }

        const confirmed = await chatContext.context?.Popup?.show?.confirm?.('Delete chats?', `Delete ${names.length} chat(s)? This cannot be undone.`)
            ?? window.confirm(`Delete ${names.length} chat(s)? This cannot be undone.`);
        if (!confirmed) {
            return;
        }

        const chatModule = await getChatScriptModule();
        for (const fileName of names) {
            await deleteChatFileForContext(chatContext, fileName, chatModule);
        }

        globalThis.toastr?.success?.(`Deleted ${names.length} chat(s).`, 'Mass Delete Chats');
        scheduleBottomChatBarRefresh(160);
        scheduleChatbarRefresh(160);
        await chatModule.displayPastChats?.();
    } catch (error) {
        console.error('[Neconyan] Failed to mass delete chats.', error);
        globalThis.toastr?.error?.(String(error?.message || error), 'Mass Delete Chats');
    } finally {
        setBottomChatActionBusy(button, false);
    }
}

async function handleCloseChat() {
    const chatContext = getChatUiContext();

    if (typeof chatContext.context?.closeCurrentChat === 'function') {
        await chatContext.context.closeCurrentChat();
    } else {
        document.getElementById('option_close_chat')?.click();
    }

    scheduleChatbarRefresh(80);
}

function handleNewChat() {
    document.getElementById('option_start_new_chat')?.click();
    scheduleChatbarRefresh(100);
}

function handleChatManagerClick() {
    document.getElementById('option_select_chat')?.click();
}

function createChatField({ id = '', icon, title, tagName = 'label', className = '' }) {
    const field = createElement(tagName, {
        id,
        className: `sb-chatbar-field ${className}`.trim(),
        attrs: {
            title,
        },
    });
    const fieldIcon = createElement('i', { className: `fa-solid ${icon}` });

    field.appendChild(fieldIcon);
    return field;
}

function setButtonDisabled(button, disabled) {
    if (!(button instanceof HTMLElement)) {
        return;
    }

    button.toggleAttribute('disabled', Boolean(disabled));
    button.classList.toggle('is-disabled', Boolean(disabled));
}

function setButtonPressed(button, pressed) {
    if (!(button instanceof HTMLElement)) {
        return;
    }

    button.classList.toggle('is-active', Boolean(pressed));
    button.setAttribute('aria-pressed', String(Boolean(pressed)));
}

function setSearchStatusText(statusText) {
    const normalizedText = String(statusText ?? '').trim();

    for (const refs of [getChatDesktopRefs(), getChatMobileRefs(), getBottomChatBarState()]) {
        const status = refs?.searchStatus;
        if (!(status instanceof HTMLElement)) {
            continue;
        }

        status.textContent = normalizedText;
        status.title = normalizedText;
        status.hidden = !normalizedText;
    }
}

function getChatScrollElement() {
    const chatRoot = document.getElementById('chat');
    return chatRoot instanceof HTMLElement ? chatRoot : null;
}

function getReducedMotionScrollBehavior() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function cancelPendingBottomChatScroll() {
    if (typeof nnPendingBottomChatScrollCancel === 'function') {
        nnPendingBottomChatScrollCancel();
        nnPendingBottomChatScrollCancel = null;
    }
}

function scrollCurrentChatToTop() {
    cancelPendingBottomChatScroll();

    const chatRoot = getChatScrollElement();
    if (!(chatRoot instanceof HTMLElement)) {
        return;
    }

    chatRoot.scrollTo({
        top: 0,
        behavior: getReducedMotionScrollBehavior(),
    });
}

function scrollCurrentChatToBottom() {
    cancelPendingBottomChatScroll();

    const context = getSillyTavernContext();

    if (typeof context?.scrollChatToBottom === 'function') {
        context.scrollChatToBottom({ force: true });
    }

    const chatRoot = getChatScrollElement();
    nnPendingBottomChatScrollCancel = jumpScrollElementToEdge(chatRoot, 'bottom', {
        settleDelays: DEFAULT_SCROLL_EDGE_SETTLE_DELAYS,
    });
}

function countRegexMatches(value, regex) {
    const text = String(value ?? '');
    if (!text || !(regex instanceof RegExp)) {
        return 0;
    }

    regex.lastIndex = 0;
    return Array.from(text.matchAll(regex)).length;
}

function populateChatSelector(select, chatFiles, chatContext, placeholder) {
    if (!(select instanceof HTMLSelectElement)) {
        return;
    }

    const currentValue = String(chatContext.chatId ?? '').trim();
    const uniqueChats = Array.from(chatFiles.reduce((map, chatFile) => {
        const fileName = String(chatFile?.fileName ?? chatFile ?? '').trim();
        if (fileName && !map.has(fileName)) {
            map.set(fileName, {
                fileName,
                tokenEstimate: Number(chatFile?.tokenEstimate ?? 0) || 0,
            });
        }

        return map;
    }, new Map()).values()).sort((left, right) => left.fileName.localeCompare(right.fileName));

    select.replaceChildren();

    if (!uniqueChats.length) {
        const option = createElement('option', { text: placeholder });
        option.value = '';
        option.selected = true;
        select.appendChild(option);
        select.disabled = true;
        return;
    }

    for (const chat of uniqueChats) {
        const chatName = chat.fileName;
        const option = createElement('option', { text: formatChatSelectorLabel(chatName, chat.tokenEstimate) });
        option.value = chatName;
        option.selected = chatName === currentValue;
        select.appendChild(option);
    }

    if (currentValue && !uniqueChats.some(chat => chat.fileName === currentValue)) {
        const option = createElement('option', { text: currentValue });
        option.value = currentValue;
        option.selected = true;
        select.appendChild(option);
    }

    select.disabled = false;
    select.value = currentValue || uniqueChats[0].fileName;
}

function createChatFileButton(chatFile, currentChatId, onSelect, { compact = false } = {}) {
    const button = createElement('button', {
        className: `sb-chat-file ${compact ? 'is-compact' : ''}`.trim(),
        attrs: {
            type: 'button',
        },
    });

    const dateLabel = formatChatTimestamp(chatFile.lastMessage);
    button.classList.toggle('is-current', chatFile.fileName === currentChatId);
    button.innerHTML = `
        <div class="sb-chat-file-head">
            <strong>${chatFile.fileName}</strong>
            <small>${dateLabel || ''}</small>
        </div>
        <span class="sb-chat-file-preview">${chatFile.preview}</span>
        <div class="sb-chat-file-meta">
            <small>${chatFile.chatItems ? `${chatFile.chatItems} msg` : ''}</small>
            <small>${chatFile.fileSize || ''}</small>
        </div>
    `;

    button.addEventListener('click', () => {
        void onSelect(chatFile.fileName);
    });

    return button;
}

function renderChatFiles(listRoot, files, currentChatId, { compact = false, emptyTitle = 'No chats yet.', emptyBody = 'Start a chat to see it here.', onSelect } = {}) {
    if (!(listRoot instanceof HTMLElement)) {
        return;
    }

    listRoot.replaceChildren();

    if (!files.length) {
        const empty = createElement('div', { className: `sb-chat-files-empty ${compact ? 'is-compact' : ''}`.trim() });
        empty.innerHTML = `<strong>${emptyTitle}</strong><p>${emptyBody}</p>`;
        listRoot.appendChild(empty);
        return;
    }

    for (const chatFile of files) {
        listRoot.appendChild(createChatFileButton(chatFile, currentChatId, onSelect, { compact }));
    }
}

function buildChatSidebar() {
    const existingSidebar = getChatSidebarRefs();
    if (existingSidebar) {
        return existingSidebar;
    }

    const template = document.getElementById('generic_draggable_template');
    const movingDivs = document.getElementById('movingDivs');

    if (!(template instanceof HTMLTemplateElement) || !(movingDivs instanceof HTMLElement)) {
        return null;
    }

    const fragment = template.content.cloneNode(true);
    const root = fragment.querySelector('.draggable');
    const title = fragment.querySelector('.dragTitle');
    const closeButton = fragment.querySelector('.dragClose');

    if (!(root instanceof HTMLElement) || !(title instanceof HTMLElement) || !(closeButton instanceof HTMLElement)) {
        return null;
    }

    root.id = 'sb-chat-sidebar';
    root.classList.add('sb-chat-sidebar');
    root.style.top = 'calc(var(--sb-topbar-layout-offset) + 18px)';
    root.style.right = '16px';
    root.style.left = 'auto';
    root.style.bottom = 'auto';

    title.textContent = 'Recent Chats';

    const body = createElement('div', { className: 'sb-chat-sidebar-body' });
    const list = createElement('div', { className: 'sb-chat-sidebar-list' });
    const copyButton = createElement('button', { id: 'sb-desktop-chat-copy-link', className: 'menu_button', text: 'Copy chat link',
        attrs: { type: 'button', 'data-chat-link-copy': '', 'aria-disabled': 'true', 'aria-describedby': 'sb-desktop-chat-copy-note' } });
    copyButton.disabled = true;
    copyButton.addEventListener('click', () => { document.getElementById('option_copy_chat_link')?.click(); setChatSidebarOpenState(false); });
    const copyNote = createElement('small', { id: 'sb-desktop-chat-copy-note', text: 'Only saved chats have links. A link opens this chat in your account; it does not share it.' });
    const linkSwitches = createElement('div', { className: 'sb-chat-link-switches', attrs: { 'data-chat-link-switches': 'sb-desktop-chat' } });
    body.append(copyButton, copyNote, linkSwitches, list);
    root.appendChild(body);

    closeButton.addEventListener('click', () => setChatSidebarOpenState(false));

    movingDivs.appendChild(root);

    getChatbarState().sidebar = { root, title, list };
    window.dispatchEvent(new CustomEvent('neconyan:chat-tools-ready'));
    return getChatbarState().sidebar;
}

function isChatSidebarOpen() {
    return Boolean(getChatbarState().sidebarOpen);
}

function setChatSidebarOpenState(shouldOpen) {
    const refs = buildChatSidebar();

    if (!refs?.root) {
        return;
    }

    const isOpen = Boolean(shouldOpen);
    getChatbarState().sidebarOpen = isOpen;
    refs.root.style.display = isOpen ? 'flex' : 'none';
    refs.root.classList.toggle('sb-chat-sidebar-visible', isOpen);
    setButtonPressed(getChatDesktopRefs()?.toggleSidebarButton, isOpen);

    if (isOpen) {
        scheduleChatbarRefresh(0);
    }
}

function toggleChatSidebar() {
    const chatContext = getChatUiContext();
    if (!chatContext.canBrowseChats) {
        return;
    }

    setConnectionStripOpenState(false);
    setChatSidebarOpenState(!isChatSidebarOpen());
}

function buildMobileChatTools() {
    const existingMobileTools = getChatMobileRefs();
    if (existingMobileTools) {
        return existingMobileTools;
    }

    const overlay = createElement('div', { id: 'sb-mobile-chat-tools' });
    const panel = createElement('div', { id: 'sb-mobile-chat-tools-panel' });
    const header = createElement('div', { className: 'sb-mobile-chat-header' });
    const dismissButton = createTopBarIconButton(
        {
            id: 'sb-mobile-chat-close',
            icon: 'fa-xmark',
            title: 'Close chat tools',
            className: 'sb-mobile-chat-close',
        },
        () => closeMobileChatTools(),
    );
    const chatSelectField = createChatField({
        id: 'sb-mobile-chat-select-field',
        icon: 'fa-comments',
        title: 'Switch chat',
        className: 'is-mobile',
    });
    const chatSelect = createElement('select', {
        id: 'sb-mobile-chat-select',
        className: 'text_pole',
        attrs: {
            'aria-label': 'Switch chat',
        },
    });
    const searchField = createChatField({
        id: 'sb-mobile-chat-search-field',
        icon: 'fa-magnifying-glass',
        title: 'Search all messages in this chat, including hidden messages',
        className: 'is-mobile',
    });
    const searchInput = createElement('input', {
        id: 'sb-mobile-chat-search',
        className: 'text_pole',
        attrs: {
            type: 'search',
            placeholder: 'Search this chat...',
            'aria-label': 'Search all messages in this chat',
        },
    });
    const searchStatus = createElement('small', { className: 'sb-chatbar-search-status' });
    const actions = createElement('div', { className: 'sb-mobile-chat-actions' });
    const recentSection = createElement('section', { className: 'sb-mobile-chat-section' });
    const recentTitle = createElement('strong', { className: 'sb-mobile-chat-section-title', text: 'Recent Chats' });
    const recentList = createElement('div', { className: 'sb-mobile-chat-files' });
    const connectionSection = createElement('section', { className: 'sb-mobile-chat-section sb-mobile-chat-connection' });
    const connectionTitle = createElement('strong', { className: 'sb-mobile-chat-section-title', text: 'Connection Profile' });
    const connectionField = createChatField({
        id: 'sb-mobile-chat-connection-field',
        icon: 'fa-plug',
        title: 'Switch connection profile',
        className: 'is-mobile',
    });
    const connectionSelect = createElement('select', {
        id: 'sb-mobile-chat-connection-select',
        className: 'text_pole',
        attrs: {
            'aria-label': 'Switch connection profile',
        },
    });
    const connectionStatus = createElement('small', { className: 'sb-mobile-chat-connection-status' });

    searchStatus.hidden = true;
    connectionSection.hidden = true;

    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');

    if ('inert' in overlay) {
        overlay.inert = true;
    }

    chatSelectField.appendChild(chatSelect);
    searchField.append(searchInput, searchStatus);
    connectionField.appendChild(connectionSelect);
    connectionSection.append(connectionTitle, connectionField, connectionStatus);
    header.append(searchField, dismissButton);

    const buttons = {
        managerButton: createTopBarIconButton({ icon: 'fa-address-book', title: 'View chat files', className: 'is-mobile-compact' }, handleChatManagerClick),
        newButton: createTopBarIconButton({ icon: 'fa-comments', title: 'Start a new chat', className: 'is-mobile-compact' }, handleNewChat),
        renameButton: createTopBarIconButton({ icon: 'fa-pen', title: 'Rename this chat', className: 'is-mobile-compact' }, () => { void handleRenameChat(); }),
        deleteButton: createTopBarIconButton({ icon: 'fa-trash', title: 'Delete this chat', className: 'is-mobile-compact' }, () => { void handleDeleteChat(); }),
        closeButton: createTopBarIconButton({ icon: 'fa-xmark', title: 'Close this chat', className: 'is-mobile-compact' }, () => { void handleCloseChat(); }),
    };

    actions.append(
        buttons.managerButton,
        buttons.newButton,
        buttons.renameButton,
        buttons.deleteButton,
        buttons.closeButton,
    );

    recentSection.append(recentTitle, recentList);
    const copyButton = createElement('button', { id: 'sb-mobile-chat-copy-link', className: 'menu_button sb-mobile-chat-copy-link', text: 'Copy chat link',
        attrs: { type: 'button', 'data-chat-link-copy': '', 'aria-disabled': 'true', 'aria-describedby': 'sb-mobile-chat-copy-note' } });
    copyButton.disabled = true;
    copyButton.addEventListener('click', () => { document.getElementById('option_copy_chat_link')?.click(); closeMobileChatTools(); });
    const copyNote = createElement('small', { id: 'sb-mobile-chat-copy-note', text: 'Only saved chats have links. A link opens this chat in your account; it does not share it.' });
    const linkSwitches = createElement('div', { className: 'sb-chat-link-switches', attrs: { 'data-chat-link-switches': 'sb-mobile-chat' } });
    panel.append(header, chatSelectField, actions, copyButton, copyNote, linkSwitches, connectionSection, recentSection);
    overlay.appendChild(panel);

    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeMobileChatTools();
        }
    });

    chatSelect.addEventListener('change', () => {
        void openChatById(chatSelect.value, { closeMobileTools: true });
    });
    searchInput.addEventListener('input', () => setChatSearchQuery(searchInput.value, { source: searchInput }));
    connectionSelect.addEventListener('change', () => {
        syncConnectionProfileSelection(connectionSelect.value);
    });

    document.body.appendChild(overlay);

    getChatbarState().mobileTools = {
        overlay,
        panel,
        chatSelect,
        searchInput,
        searchStatus,
        recentList,
        connectionSection,
        connectionSelect,
        connectionStatus,
        ...buttons,
    };
    window.dispatchEvent(new CustomEvent('neconyan:chat-tools-ready'));

    return getChatbarState().mobileTools;
}

function setMobileChatToolsOpenState(shouldOpen) {
    const refs = buildMobileChatTools();
    const isOpen = Boolean(shouldOpen) && isMobileViewport();

    if (!refs?.overlay) {
        return;
    }

    getChatbarState().mobileToolsOpen = isOpen;
    refs.overlay.hidden = !isOpen;
    refs.overlay.classList.toggle('sb-chat-tools-open', isOpen);
    refs.overlay.setAttribute('aria-hidden', String(!isOpen));

    if ('inert' in refs.overlay) {
        refs.overlay.inert = !isOpen;
    }

    queueMobileModalStateSync();

    if (isOpen) {
        scheduleChatbarRefresh(0);
    }
}

function openMobileChatTools() {
    if (!isMobileViewport()) {
        return;
    }

    applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
        surface: nnMobileShellLifecycle.overlays.surface.CHAT_TOOLS,
        isMobileViewport: isMobileViewport(),
    }));
    setMobileChatToolsOpenState(true);
}

function closeMobileChatTools() {
    setMobileChatToolsOpenState(false);
}

function getMobileShellSurfaceForShell(shellKey) {
    if (shellKey === 'left') {
        return nnMobileShellLifecycle.overlays.surface.LEFT_SHELL;
    }

    if (shellKey === 'right') {
        return nnMobileShellLifecycle.overlays.surface.RIGHT_SHELL;
    }

    if (shellKey === 'characters') {
        return nnMobileShellLifecycle.overlays.surface.CHARACTER_PANEL;
    }

    return '';
}

function applyMobileSurfaceExclusivity(decision) {
    if (!decision || !Array.isArray(decision.closeSurfaces)) {
        return;
    }

    const surface = nnMobileShellLifecycle.overlays.surface;
    const closeSurface = {
        [surface.NAV]: () => closeMobileNav(),
        [surface.LEFT_SHELL]: () => closeShell('left'),
        [surface.RIGHT_SHELL]: () => closeShell('right'),
        [surface.CHARACTER_PANEL]: () => closeCharacterPanelUnlessPinned(),
        [surface.CHAT_TOOLS]: () => closeMobileChatTools(),
        [surface.CONNECTION_STRIP]: () => setConnectionStripOpenState(false),
    };

    for (const closeSurfaceKey of decision.closeSurfaces) {
        const close = closeSurface[closeSurfaceKey];
        if (typeof close !== 'function') {
            throw new Error(`Unknown mobile shell surface: ${closeSurfaceKey}`);
        }

        close();
    }
}

function toggleMobileChatTools() {
    const shouldOpen = !getChatbarState().mobileToolsOpen;

    if (shouldOpen) {
        applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: nnMobileShellLifecycle.overlays.surface.CHAT_TOOLS,
            isMobileViewport: isMobileViewport(),
        }));
    }

    setMobileChatToolsOpenState(shouldOpen);
}

function syncConnectionProfileSelection(value) {
    const sourceSelect = document.getElementById('connection_profiles');

    if (!(sourceSelect instanceof HTMLSelectElement)) {
        return;
    }

    const syncState = nnPresetApiSyncLifecycle.connectionProfiles.resolveSelectionSync({
        requestedValue: value,
        currentValue: sourceSelect.value,
    });
    if (!syncState.shouldSync) {
        return;
    }

    sourceSelect.value = syncState.nextValue;
    sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
}

function isConnectionStripOpen() {
    return Boolean(getChatbarState().connectionStripOpen);
}

function setConnectionStripOpenState(shouldOpen) {
    const desktopRefs = getChatDesktopRefs();
    const nextState = Boolean(shouldOpen);

    if (!desktopRefs?.connectionStrip) {
        return;
    }

    if (nextState) {
        applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: nnMobileShellLifecycle.overlays.surface.CONNECTION_STRIP,
            isMobileViewport: isMobileViewport(),
        }));
    }

    getChatbarState().connectionStripOpen = nextState;
    desktopRefs.connectionStrip.classList.toggle('is-open', nextState);
    desktopRefs.connectionStrip.hidden = !nextState;
    setButtonPressed(desktopRefs.toggleConnectionButton, nextState);
}

function getCurrentMainApiValue() {
    const mainApiSelect = document.getElementById('main_api');
    const context = getSillyTavernContext();

    return nnPresetApiSyncLifecycle.api.resolveMainValue({
        selectValue: mainApiSelect instanceof HTMLSelectElement ? mainApiSelect.value : '',
        contextMainApi: context?.mainApi,
    });
}

function resolveActiveApiConnectButton() {
    const selector = nnPresetApiSyncLifecycle.api.resolveConnectButtonSelector(getCurrentMainApiValue());

    if (!selector) {
        return null;
    }

    const button = document.querySelector(selector);
    return button instanceof HTMLElement ? button : null;
}

function getSearchTerms(query = getChatbarState().searchQuery) {
    return String(query ?? '')
        .trim()
        .split(/\s+/)
        .map(term => term.trim())
        .filter(Boolean);
}

function createChatSearchRegex(terms = getSearchTerms()) {
    if (!terms.length) {
        return null;
    }

    return new RegExp(`(${terms.map(escapeRegex).join('|')})`, 'gi');
}

function addChatSearchTextSegment(segments, value) {
    const normalizedValue = String(value ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (normalizedValue && !segments.includes(normalizedValue)) {
        segments.push(normalizedValue);
    }
}

function getChatSearchMessageText(message) {
    if (!message || typeof message !== 'object') {
        return '';
    }

    const segments = [];

    addChatSearchTextSegment(segments, message.extra?.display_text);
    addChatSearchTextSegment(segments, message.mes);
    addChatSearchTextSegment(segments, message.extra?.reasoning_display_text);
    addChatSearchTextSegment(segments, message.extra?.reasoning);

    return segments.join('\n');
}

function getChatSearchMatches(regex) {
    const context = getSillyTavernContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const matches = [];
    let totalMatches = 0;

    if (!(regex instanceof RegExp)) {
        return { matches, totalMatches };
    }

    chat.forEach((message, messageId) => {
        const count = countRegexMatches(getChatSearchMessageText(message), regex);
        if (!count) {
            return;
        }

        matches.push({ messageId, count, message });
        totalMatches += count;
    });

    return { matches, totalMatches };
}

function getChatMessageElement(messageId) {
    const chatRoot = getChatScrollElement();
    if (!(chatRoot instanceof HTMLElement) || !Number.isInteger(messageId)) {
        return null;
    }

    return chatRoot.querySelector(`.mes[mesid="${messageId}"]`);
}

async function waitForNextAnimationFrame() {
    await new Promise(resolve => window.requestAnimationFrame(resolve));
}

async function ensureChatMessageRendered(messageId) {
    if (!Number.isInteger(messageId) || messageId < 0) {
        return null;
    }

    let messageElement = getChatMessageElement(messageId);
    if (messageElement instanceof HTMLElement) {
        return messageElement;
    }

    const context = getSillyTavernContext();
    const chatLength = Array.isArray(context?.chat) ? context.chat.length : 0;
    const renderedMessages = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
    const firstRenderedId = Number(renderedMessages.at(0)?.getAttribute('mesid') ?? NaN);
    const lastRenderedId = Number(renderedMessages.at(-1)?.getAttribute('mesid') ?? NaN);
    const chatModule = await getChatScriptModule().catch(() => null);
    const showMoreMessages = typeof context?.showMoreMessages === 'function'
        ? context.showMoreMessages
        : chatModule?.showMoreMessages;
    const showNewerMessages = typeof context?.showNewerMessages === 'function'
        ? context.showNewerMessages
        : chatModule?.showNewerMessages;
    const redisplayChat = typeof context?.redisplayChat === 'function'
        ? context.redisplayChat
        : chatModule?.redisplayChat;

    if (typeof showMoreMessages === 'function' && Number.isInteger(firstRenderedId) && messageId < firstRenderedId) {
        await showMoreMessages(firstRenderedId - messageId);
        await waitForNextAnimationFrame();
        messageElement = getChatMessageElement(messageId);
        if (messageElement instanceof HTMLElement) {
            return messageElement;
        }
    }

    if (typeof showNewerMessages === 'function' && Number.isInteger(lastRenderedId) && messageId > lastRenderedId) {
        await showNewerMessages(messageId - lastRenderedId);
        await waitForNextAnimationFrame();
        messageElement = getChatMessageElement(messageId);
        if (messageElement instanceof HTMLElement) {
            return messageElement;
        }
    }

    if (typeof redisplayChat === 'function' && chatLength > 0) {
        const fallbackStartIndex = Math.max(0, Math.min(messageId, chatLength - 1));
        if (!getChatMessageElement(fallbackStartIndex)) {
            getChatScrollElement()?.querySelectorAll('.mes, #show_more_messages, #show_newer_messages').forEach(element => element.remove());
        }

        await redisplayChat({ startIndex: fallbackStartIndex, fade: false });
        await waitForNextAnimationFrame();
        return getChatMessageElement(messageId);
    }

    return null;
}

function releaseChatSearchApply(chatbarState, applyToken) {
    window.setTimeout(() => {
        if (applyToken === chatbarState.searchApplyToken) {
            chatbarState.isApplyingSearch = false;
        }
    }, 0);
}

function getChatSearchStatusText(totalMatches, renderedMatches) {
    if (!totalMatches) {
        return 'No matches';
    }

    if (renderedMatches > 0 && renderedMatches < totalMatches) {
        return `${renderedMatches}/${totalMatches} visible`;
    }

    if (!renderedMatches) {
        return `${totalMatches} hidden match${totalMatches === 1 ? '' : 'es'}`;
    }

    return `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`;
}

function clearChatSearchHighlights() {
    for (const mark of document.querySelectorAll(NN_CHAT_SEARCH_MARK_SELECTOR)) {
        if (!(mark instanceof HTMLElement) || !mark.parentNode) {
            continue;
        }

        mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
    }

    document.querySelectorAll('#chat .sb-search-hit').forEach(element => {
        element.classList.remove('sb-search-hit');
    });
    document.getElementById('chat')?.normalize();
    setSearchStatusText('');
}

function highlightMessageText(root, regex) {
    if (!(root instanceof HTMLElement)) {
        return { count: 0, firstMatch: null };
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue?.trim()) {
                return NodeFilter.FILTER_REJECT;
            }

            const parent = node.parentElement;
            if (!parent
                || parent.closest(NN_CHAT_SEARCH_MARK_SELECTOR)
                || parent.closest('.mes_buttons, .extraMesButtons, .mes_edit_buttons, .mes_reasoning_actions, .mes_bias, .mes_avatar, .avatar, .timestamp, .tokenCounterDisplay, .mesIDDisplay, .swipes-counter')) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const textNodes = [];
    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    let count = 0;
    let firstMatch = null;

    for (const textNode of textNodes) {
        const textValue = textNode.nodeValue ?? '';
        regex.lastIndex = 0;

        if (!regex.test(textValue)) {
            continue;
        }

        regex.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let previousIndex = 0;

        for (const match of textValue.matchAll(regex)) {
            const matchValue = match[0];
            const matchIndex = match.index ?? 0;

            if (!matchValue) {
                continue;
            }

            fragment.append(textValue.slice(previousIndex, matchIndex));

            const mark = createElement('mark', {
                className: 'sb-chat-search-hit',
                text: matchValue,
                attrs: {
                    'data-sb-chat-search': 'true',
                },
            });

            if (!firstMatch) {
                firstMatch = mark;
            }

            fragment.appendChild(mark);
            previousIndex = matchIndex + matchValue.length;
            count += 1;
        }

        fragment.append(textValue.slice(previousIndex));
        textNode.parentNode?.replaceChild(fragment, textNode);
    }

    return { count, firstMatch };
}

async function applyChatSearchHighlights({ scrollToFirst = false } = {}) {
    const chatbarState = getChatbarState();
    const terms = getSearchTerms();
    const applyToken = ++chatbarState.searchApplyToken;

    chatbarState.pendingSearchScroll = false;
    clearTimeout(chatbarState.searchTimer);
    chatbarState.isApplyingSearch = true;
    clearChatSearchHighlights();

    if (!terms.length || !getChatUiContext().hasChat) {
        chatbarState.isApplyingSearch = false;
        return;
    }

    const regex = createChatSearchRegex(terms);
    if (!(regex instanceof RegExp)) {
        chatbarState.isApplyingSearch = false;
        return;
    }

    const searchMatches = getChatSearchMatches(regex);
    const firstMatchId = searchMatches.matches[0]?.messageId;

    if (scrollToFirst && Number.isInteger(firstMatchId)) {
        setSearchStatusText('Loading match...');

        try {
            await ensureChatMessageRendered(firstMatchId);
        } catch (error) {
            console.warn('[Neconyan] Failed to reveal chat search match.', error);
        }

        if (applyToken !== chatbarState.searchApplyToken) {
            chatbarState.isApplyingSearch = false;
            return;
        }
    }

    let renderedMatches = 0;
    let firstMatch = null;

    try {
        for (const node of document.querySelectorAll('#chat .mes_text')) {
            const result = highlightMessageText(node, regex);
            renderedMatches += result.count;
            firstMatch ??= result.firstMatch;
        }
    } finally {
        releaseChatSearchApply(chatbarState, applyToken);
    }

    const totalMatches = Math.max(searchMatches.totalMatches, renderedMatches);
    setSearchStatusText(getChatSearchStatusText(totalMatches, renderedMatches));

    if (scrollToFirst && firstMatch instanceof HTMLElement) {
        scrollElementIntoManagedView(firstMatch, {
            block: 'center',
            behavior: getReducedMotionScrollBehavior(),
        });
    } else if (scrollToFirst && Number.isInteger(firstMatchId)) {
        const messageElement = getChatMessageElement(firstMatchId);
        if (messageElement instanceof HTMLElement) {
            messageElement.classList.add('sb-search-hit');
            window.setTimeout(() => messageElement.classList.remove('sb-search-hit'), 2400);
            scrollElementIntoManagedView(messageElement, {
                block: 'center',
                behavior: getReducedMotionScrollBehavior(),
            });
        }
    }
}

function scheduleChatSearchHighlight({ scrollToFirst = false } = {}) {
    const chatbarState = getChatbarState();
    chatbarState.pendingSearchScroll = chatbarState.pendingSearchScroll || scrollToFirst;

    clearTimeout(chatbarState.searchTimer);
    chatbarState.searchTimer = window.setTimeout(() => {
        const shouldScroll = chatbarState.pendingSearchScroll;
        chatbarState.pendingSearchScroll = false;
        void applyChatSearchHighlights({ scrollToFirst: shouldScroll });
    }, NN_CHATBAR_SEARCH_DEBOUNCE);
}

function setChatSearchQuery(value, { source = null } = {}) {
    const nextValue = String(value ?? '');
    const chatbarState = getChatbarState();

    chatbarState.searchQuery = nextValue;
    chatbarState.searchApplyToken += 1;

    for (const input of [getChatDesktopRefs()?.searchInput, getChatMobileRefs()?.searchInput, getBottomChatBarState()?.searchInput]) {
        if (!(input instanceof HTMLInputElement) || input === source) {
            continue;
        }

        input.value = nextValue;
    }

    if (!nextValue.trim()) {
        clearTimeout(chatbarState.searchTimer);
        chatbarState.pendingSearchScroll = false;
        chatbarState.isApplyingSearch = false;
        clearChatSearchHighlights();
        return;
    }

    scheduleChatSearchHighlight({ scrollToFirst: true });
}

function createBottomChatButton({ icon, title, className = '' }, onClick) {
    const button = createElement('button', {
        className: `sb-bottom-chat-btn ${className}`.trim(),
        attrs: {
            type: 'button',
            title,
            'aria-label': title,
        },
    });

    button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
    button.addEventListener('click', debounceAction(onClick));

    return button;
}

function createBottomChatSearchField() {
    const field = createElement('label', {
        id: 'sb-bottom-chat-search-field',
        className: 'sb-bottom-chat-search-field',
        attrs: {
            title: 'Search all messages in this chat, including hidden messages',
        },
    });
    const icon = createElement('i', {
        className: 'fa-solid fa-magnifying-glass',
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const input = createElement('input', {
        id: 'sb-bottom-chat-search',
        className: 'text_pole',
        attrs: {
            type: 'search',
            placeholder: 'Search chat...',
            'aria-label': 'Search all messages in this chat',
            autocomplete: 'off',
            spellcheck: 'false',
        },
    });
    const status = createElement('small', { className: 'sb-chatbar-search-status sb-bottom-chat-search-status' });

    input.value = getChatbarState().searchQuery;
    status.hidden = true;
    field.append(icon, input, status);
    input.addEventListener('input', () => setChatSearchQuery(input.value, { source: input }));

    return { field, input, status };
}

function setBottomChatButtonIcon(button, iconClass) {
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const icon = button.querySelector('i');
    if (icon instanceof HTMLElement) {
        icon.className = `fa-solid ${iconClass}`;
    }
}

function syncBottomChatBarSecondaryState() {
    const bottomChatBarState = getBottomChatBarState();
    const container = document.getElementById('sb-bottom-chat-bar');
    const isOpen = Boolean(bottomChatBarState.secondaryOpen);
    const isHiddenOnMobile = !isOpen && isMobileViewport();

    container?.classList.toggle('sb-bottom-chat-secondary-collapsed', !isOpen);

    if (bottomChatBarState.secondaryRow instanceof HTMLElement) {
        bottomChatBarState.secondaryRow.hidden = isHiddenOnMobile;
    }

    const button = bottomChatBarState.collapseToggleButton;
    if (button instanceof HTMLElement) {
        const title = isOpen ? 'Hide chat actions' : 'Show chat actions';

        button.title = title;
        button.setAttribute('aria-label', title);
        button.setAttribute('aria-expanded', String(isOpen));
        setBottomChatButtonIcon(button, isOpen ? 'fa-chevron-up' : 'fa-chevron-down');
    }
}

function syncBottomChatBarSearchState({ focusInput = false } = {}) {
    const bottomChatBarState = getBottomChatBarState();
    const container = document.getElementById('sb-bottom-chat-bar');
    const isOpen = Boolean(bottomChatBarState.searchOpen);
    const isMobileHidden = !isOpen && isMobileViewport();

    container?.classList.toggle('sb-bottom-chat-search-open', isOpen);

    if (bottomChatBarState.searchField instanceof HTMLElement) {
        bottomChatBarState.searchField.hidden = isMobileHidden;
    }

    if (bottomChatBarState.searchInput instanceof HTMLElement) {
        if (isMobileHidden) {
            bottomChatBarState.searchInput.setAttribute('tabindex', '-1');
        } else {
            bottomChatBarState.searchInput.removeAttribute('tabindex');
        }
    }

    const button = bottomChatBarState.searchToggleButton;
    if (button instanceof HTMLElement) {
        const title = isOpen ? 'Hide chat search' : 'Search chat';

        button.title = title;
        button.setAttribute('aria-label', title);
        setButtonPressed(button, isOpen);
    }

    if (focusInput && isOpen && bottomChatBarState.searchInput instanceof HTMLInputElement) {
        window.requestAnimationFrame(() => {
            bottomChatBarState.searchInput.focus({ preventScroll: true });
            bottomChatBarState.searchInput.select();
        });
    }
}

function setBottomChatSecondaryOpen(open, { focusSearch = false } = {}) {
    const bottomChatBarState = getBottomChatBarState();
    const searchInput = bottomChatBarState.searchInput;

    bottomChatBarState.secondaryOpen = Boolean(open);
    safeSetItem(NN_STORAGE_KEYS.bottomChatSecondaryOpen, String(bottomChatBarState.secondaryOpen));
    if (!bottomChatBarState.secondaryOpen) {
        bottomChatBarState.searchOpen = false;
        if (searchInput instanceof HTMLElement && searchInput === document.activeElement) {
            searchInput.blur();
        }
    } else if (focusSearch) {
        bottomChatBarState.searchOpen = true;
    }

    syncBottomChatBarSecondaryState();
    syncBottomChatBarSearchState({ focusInput: focusSearch });
}

function setBottomChatSearchOpen(open, { focusInput = false } = {}) {
    const bottomChatBarState = getBottomChatBarState();
    const searchInput = bottomChatBarState.searchInput;

    bottomChatBarState.searchOpen = Boolean(open);
    if (bottomChatBarState.searchOpen && !bottomChatBarState.secondaryOpen) {
        bottomChatBarState.secondaryOpen = true;
    } else if (!bottomChatBarState.searchOpen && searchInput instanceof HTMLElement && searchInput === document.activeElement) {
        searchInput.blur();
    }

    syncBottomChatBarSecondaryState();
    syncBottomChatBarSearchState({ focusInput });
}

function initChatSearchObserver() {
    const chatRoot = document.getElementById('chat');

    if (!(chatRoot instanceof HTMLElement) || getChatbarState().chatObserver) {
        return;
    }

    const observer = new MutationObserver(() => {
        if (getChatbarState().isApplyingSearch || !getSearchTerms().length) {
            return;
        }

        scheduleChatSearchHighlight({ scrollToFirst: false });
    });

    observer.observe(chatRoot, { childList: true, subtree: true });
    getChatbarState().chatObserver = observer;
}

async function getConnectionStatusText() {
    const context = getSillyTavernContext();

    if (!context) {
        return '';
    }

    if (context.onlineStatus === 'no_connection') {
        return 'No connection...';
    }

    let apiValue = String(context.mainApi ?? 'Connected').trim();
    let modelValue = String(context.onlineStatus ?? '').trim();

    try {
        const nextApiValue = await context.SlashCommandParser?.commands?.api?.callback?.({ quiet: 'true' }, '');
        if (nextApiValue) {
            apiValue = String(nextApiValue).trim();
        }
    } catch {
        // Ignore slash command lookup failures and use the current context values.
    }

    try {
        const nextModelValue = await context.SlashCommandParser?.commands?.model?.callback?.({ quiet: 'true' }, '');
        if (typeof nextModelValue === 'string' && nextModelValue.trim()) {
            modelValue = nextModelValue.trim();
        }
    } catch {
        // Ignore slash command lookup failures and use the current context values.
    }

    const apiBlock = document.getElementById('rm_api_block');

    if (apiBlock instanceof HTMLElement) {
        const apiOption = apiBlock.querySelector(`select:not(#main_api) option[value="${escapeSelectorValue(apiValue)}"]`)
            ?? apiBlock.querySelector(`select#main_api option[value="${escapeSelectorValue(apiValue)}"]`);
        const modelOption = apiBlock.querySelector(`option[value="${escapeSelectorValue(modelValue)}"]`);

        apiValue = stripDecoratedOptionText(apiOption?.textContent ?? apiValue);
        modelValue = stripDecoratedOptionText(modelOption?.textContent ?? modelValue);
    }

    return modelValue ? `${apiValue} - ${modelValue}` : apiValue;
}

function nodeTouchesConnectionProfilesSource(node) {
    if (!(node instanceof Element)) {
        return false;
    }

    return node.id === 'connection_profiles' || Boolean(node.querySelector('#connection_profiles'));
}

function mutationTouchesConnectionProfilesSource(mutation) {
    if (nodeTouchesConnectionProfilesSource(mutation.target)) {
        return true;
    }

    for (const node of mutation.addedNodes) {
        if (nodeTouchesConnectionProfilesSource(node)) {
            return true;
        }
    }

    for (const node of mutation.removedNodes) {
        if (nodeTouchesConnectionProfilesSource(node)) {
            return true;
        }
    }

    return false;
}

function bindConnectionProfileSourceElement(sourceElement) {
    const chatbarState = getChatbarState();
    const normalizedSource = sourceElement instanceof HTMLSelectElement ? sourceElement : null;

    if (chatbarState.sourceObservedElement === normalizedSource) {
        return;
    }

    if (chatbarState.sourceObservedElement instanceof HTMLSelectElement && typeof chatbarState.sourceChangeHandler === 'function') {
        chatbarState.sourceObservedElement.removeEventListener('change', chatbarState.sourceChangeHandler);
    }

    chatbarState.sourceSelectObserver?.disconnect();
    chatbarState.sourceObservedElement = normalizedSource;
    chatbarState.sourceChangeHandler = null;

    if (!(normalizedSource instanceof HTMLSelectElement)) {
        return;
    }

    if (!chatbarState.sourceSelectObserver) {
        chatbarState.sourceSelectObserver = new MutationObserver(() => {
            scheduleChatbarRefresh(60);
        });
    }

    const handleSourceChange = () => {
        scheduleChatbarRefresh(0);
    };

    chatbarState.sourceChangeHandler = handleSourceChange;
    normalizedSource.addEventListener('change', handleSourceChange);
    chatbarState.sourceSelectObserver.observe(normalizedSource, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled'],
    });
}

function bindConnectionProfileSourceObserver() {
    const chatbarState = getChatbarState();
    if (chatbarState.sourceObserver) {
        bindConnectionProfileSourceElement(document.getElementById('connection_profiles'));
        return;
    }

    const observer = new MutationObserver(mutations => {
        if (!mutations.some(mutationTouchesConnectionProfilesSource)) {
            return;
        }

        bindConnectionProfileSourceElement(document.getElementById('connection_profiles'));
        scheduleChatbarRefresh(60);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    chatbarState.sourceObserver = observer;
    bindConnectionProfileSourceElement(document.getElementById('connection_profiles'));
}

async function refreshChatbarState() {
    const chatbarState = getChatbarState();
    const refreshToken = ++chatbarState.refreshToken;
    const desktopRefs = getChatDesktopRefs();
    const mobileRefs = getChatMobileRefs();

    if (!desktopRefs && !mobileRefs) {
        return;
    }

    const chatContext = getChatUiContext();
    const files = await getChatFilesForContext(chatContext);
    const connectionStatusText = await getConnectionStatusText();

    if (refreshToken !== chatbarState.refreshToken) {
        return;
    }

    const chatNames = files.map(chat => chat.fileName);

    if (chatContext.chatId && !chatNames.includes(chatContext.chatId)) {
        files.unshift({ fileName: chatContext.chatId, tokenEstimate: 0 });
    }

    populateChatSelector(desktopRefs?.chatSelect, files, chatContext, chatContext.canBrowseChats ? 'No saved chats yet' : 'No chat selected');
    populateChatSelector(mobileRefs?.chatSelect, files, chatContext, chatContext.canBrowseChats ? 'No saved chats yet' : 'No chat selected');

    if (desktopRefs) {
        setButtonDisabled(desktopRefs.managerButton, !chatContext.canBrowseChats);
        setButtonDisabled(desktopRefs.toggleSidebarButton, !chatContext.canBrowseChats);
        setButtonDisabled(desktopRefs.newButton, !chatContext.canStartNewChat);
        setButtonDisabled(desktopRefs.renameButton, !chatContext.hasChat);
        setButtonDisabled(desktopRefs.deleteButton, !chatContext.hasChat);
        setButtonDisabled(desktopRefs.closeButton, !chatContext.hasChat);
        setButtonDisabled(desktopRefs.chatSelect, !chatContext.canBrowseChats);
        setButtonDisabled(desktopRefs.searchInput, !chatContext.hasChat);
    }

    if (mobileRefs) {
        setButtonDisabled(mobileRefs.managerButton, !chatContext.canBrowseChats);
        setButtonDisabled(mobileRefs.newButton, !chatContext.canStartNewChat);
        setButtonDisabled(mobileRefs.renameButton, !chatContext.hasChat);
        setButtonDisabled(mobileRefs.deleteButton, !chatContext.hasChat);
        setButtonDisabled(mobileRefs.closeButton, !chatContext.hasChat);
        setButtonDisabled(mobileRefs.chatSelect, !chatContext.canBrowseChats);
        setButtonDisabled(mobileRefs.searchInput, !chatContext.hasChat);
    }

    const connectionProfilesSource = document.getElementById('connection_profiles');
    const hasConnectionProfiles = connectionProfilesSource instanceof HTMLSelectElement;
    const connectionMirrorState = nnPresetApiSyncLifecycle.connectionProfiles.resolveMirrorState({
        hasConnectionProfiles,
        isConnectionStripOpen: isConnectionStripOpen(),
        hasActiveConnectButton: hasConnectionProfiles && Boolean(resolveActiveApiConnectButton()),
    });

    if (desktopRefs) {
        desktopRefs.toggleConnectionButton.hidden = !connectionMirrorState.shouldShowToggle;
        desktopRefs.connectionStrip.hidden = !connectionMirrorState.shouldShowDesktopStrip;
    }

    if (connectionMirrorState.shouldCloseDesktopStrip) {
        setConnectionStripOpenState(false);
    }

    if (connectionMirrorState.shouldClearMirrors) {
        if (desktopRefs) {
            desktopRefs.connectionSelect.replaceChildren();
            desktopRefs.connectionStatus.textContent = '';
            setButtonDisabled(desktopRefs.connectionConnectButton, connectionMirrorState.shouldDisableConnectButton);
        }

        if (mobileRefs?.connectionSection instanceof HTMLElement) {
            mobileRefs.connectionSection.hidden = !connectionMirrorState.shouldShowMobileSection;
            mobileRefs.connectionSelect.replaceChildren();
            mobileRefs.connectionStatus.textContent = '';
        }
    } else {
        const optionsMarkup = connectionProfilesSource.innerHTML;
        if (desktopRefs) {
            desktopRefs.connectionSelect.innerHTML = optionsMarkup;
            desktopRefs.connectionSelect.value = connectionProfilesSource.value;
            desktopRefs.connectionStatus.textContent = connectionStatusText;
            setButtonDisabled(desktopRefs.connectionConnectButton, connectionMirrorState.shouldDisableConnectButton);
        }

        if (mobileRefs?.connectionSection instanceof HTMLElement) {
            mobileRefs.connectionSection.hidden = !connectionMirrorState.shouldShowMobileSection;
            mobileRefs.connectionSelect.innerHTML = optionsMarkup;
            mobileRefs.connectionSelect.value = connectionProfilesSource.value;
            mobileRefs.connectionStatus.textContent = connectionStatusText;
        }
    }

    renderChatFiles(getChatSidebarRefs()?.list, files, chatContext.chatId, {
        onSelect: chatId => openChatById(chatId),
    });
    renderChatFiles(mobileRefs?.recentList, files, chatContext.chatId, {
        compact: true,
        onSelect: chatId => openChatById(chatId, { closeMobileTools: true }),
    });

    if (desktopRefs) {
        setButtonPressed(desktopRefs.toggleSidebarButton, isChatSidebarOpen());
        setButtonPressed(desktopRefs.toggleConnectionButton, isConnectionStripOpen());
    }

    if (!chatContext.canBrowseChats) {
        setChatSidebarOpenState(false);
    }

    if (!chatContext.hasChat) {
        clearChatSearchHighlights();
    } else if (getSearchTerms().length) {
        scheduleChatSearchHighlight({ scrollToFirst: false });
    }
}

function scheduleChatbarRefresh(delay = 0) {
    const chatbarState = getChatbarState();
    const safeDelay = Math.max(0, Number(delay) || 0);

    window.clearTimeout(chatbarState.refreshTimer);
    chatbarState.refreshTimer = window.setTimeout(() => {
        chatbarState.refreshTimer = 0;
        void refreshChatbarState().catch(error => {
            console.warn('[Neconyan] Failed to refresh chat tools state.', error);
        });
    }, safeDelay);
}

function scheduleChatbarBindingRetry(delay = 240) {
    const chatbarState = getChatbarState();

    window.clearTimeout(chatbarState.bindingRetryTimer);
    chatbarState.bindingRetryTimer = window.setTimeout(() => {
        bindChatbarEvents();
    }, delay);
}

function bindChatbarWindowEvents() {
    const chatbarState = getChatbarState();

    if (chatbarState.windowBindingsAttached) {
        return;
    }

    const refreshWithContext = () => {
        window.requestAnimationFrame(() => scheduleChatbarRefresh(0));
        bindChatbarEvents();
    };

    window.addEventListener('pageshow', refreshWithContext, { passive: true });
    window.addEventListener('focus', refreshWithContext, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            refreshWithContext();
        }
    });

    chatbarState.windowBindingsAttached = true;
}

function bindChatbarEvents() {
    const chatbarState = getChatbarState();
    const context = getSillyTavernContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes ?? context?.event_types;

    bindChatbarWindowEvents();
    initChatSearchObserver();
    bindConnectionProfileSourceObserver();

    if (!eventSource || !eventTypes) {
        scheduleChatbarRefresh(0);
        scheduleChatbarBindingRetry();
        return;
    }

    window.clearTimeout(chatbarState.bindingRetryTimer);

    if (chatbarState.boundEventSource === eventSource) {
        scheduleChatbarRefresh(0);
        return;
    }

    const refresh = () => scheduleChatbarRefresh(0);
    const events = [
        eventTypes.APP_READY,
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_LOADED,
        eventTypes.CHAT_CREATED,
        eventTypes.GROUP_CHAT_CREATED,
        eventTypes.CHAT_DELETED,
        eventTypes.GROUP_CHAT_DELETED,
        eventTypes.MESSAGE_RECEIVED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MESSAGE_SWIPED,
        eventTypes.MESSAGE_SWIPE_DELETED,
        eventTypes.CONNECTION_PROFILE_LOADED,
        eventTypes.CONNECTION_PROFILE_CREATED,
        eventTypes.CONNECTION_PROFILE_UPDATED,
        eventTypes.CONNECTION_PROFILE_DELETED,
        eventTypes.MAIN_API_CHANGED,
        eventTypes.ONLINE_STATUS_CHANGED,
        eventTypes.SETTINGS_UPDATED,
    ].filter(Boolean);

    for (const eventName of new Set(events)) {
        eventSource.on(eventName, refresh);
    }

    chatbarState.boundEventSource = eventSource;
    scheduleChatbarRefresh(0);
}

function getCanonicalTopSettingsHolder() {
    return Array.from(document.querySelectorAll('#top-settings-holder'))
        .find(element => element instanceof HTMLElement && element.parentElement === document.body)
        ?? document.getElementById('top-settings-holder');
}

function getCharacterDrawerHost() {
    const topSettingsHolder = getCanonicalTopSettingsHolder();
    const hosts = Array.from(document.querySelectorAll('#rightNavHolder')).filter(element => element instanceof HTMLElement);
    const host = hosts.find(element => element.classList.contains('sb-drawer-host') && element.closest('#top-settings-holder') === topSettingsHolder)
        ?? hosts.find(element => element.classList.contains('sb-drawer-host'))
        ?? hosts.find(element => element.closest('#top-settings-holder') === topSettingsHolder)
        ?? document.getElementById('rightNavHolder');

    if (host instanceof HTMLElement && topSettingsHolder instanceof HTMLElement && host.parentElement === topSettingsHolder && topSettingsHolder.firstElementChild !== host) {
        topSettingsHolder.insertBefore(host, topSettingsHolder.firstElementChild);
    }

    return host instanceof HTMLElement ? host : null;
}

function getCharacterPanel() {
    const panel = getCharacterDrawerHost()?.querySelector(':scope > #right-nav-panel')
        ?? document.querySelector('#right-nav-panel.sb-character-drawer-root')
        ?? document.getElementById('right-nav-panel');

    return panel instanceof HTMLElement ? panel : null;
}

function getDrawerRoot(drawerRootOrId) {
    if (drawerRootOrId === 'right-nav-panel') {
        return getCharacterPanel();
    }

    return typeof drawerRootOrId === 'string'
        ? document.getElementById(drawerRootOrId)
        : drawerRootOrId;
}

function getDrawerIcon(drawerIconOrSelector) {
    if (typeof drawerIconOrSelector === 'string') {
        return document.querySelector(drawerIconOrSelector);
    }

    return drawerIconOrSelector;
}

function syncDrawerIconState(drawerIconOrSelector, shouldOpen) {
    const icon = getDrawerIcon(drawerIconOrSelector);

    if (!(icon instanceof HTMLElement)) {
        return;
    }

    icon.classList.toggle('openIcon', Boolean(shouldOpen));
    icon.classList.toggle('closedIcon', !shouldOpen);
}

function isDrawerActuallyOpen(drawerRootOrId) {
    const el = getDrawerRoot(drawerRootOrId);

    if (!(el instanceof HTMLElement) || !el.classList.contains('openDrawer')) {
        return false;
    }

    const styles = getComputedStyle(el);
    return styles.display !== 'none'
        && styles.visibility !== 'hidden'
        && styles.pointerEvents !== 'none'
        && el.getClientRects().length > 0;
}

function isMobileOverlayActuallyOpen(overlayRootOrId, openClass) {
    const el = getDrawerRoot(overlayRootOrId);

    if (!(el instanceof HTMLElement) || !el.classList.contains(openClass)) {
        return false;
    }

    const isExplicitlyHidden = el.hidden || el.getAttribute('aria-hidden') === 'true';
    if (isExplicitlyHidden) {
        return false;
    }

    const styles = getComputedStyle(el);
    return styles.display !== 'none'
        && styles.visibility !== 'hidden'
        && styles.pointerEvents !== 'none'
        && el.getClientRects().length > 0;
}

function getMobileModalRootCandidates() {
    const chatTools = getChatbarState().mobileTools?.overlay ?? document.getElementById('sb-mobile-chat-tools');
    return [
        document.getElementById(getShellConfig('left').rootPanelId),
        document.getElementById(getShellConfig('right').rootPanelId),
        getCharacterPanel(),
        document.getElementById('sb-mobile-nav'),
        chatTools,
    ].filter(element => element instanceof HTMLElement);
}

function isMobileModalRootOpen(root) {
    if (!(root instanceof HTMLElement)) {
        return false;
    }

    if (root.id === 'sb-mobile-nav') {
        return isMobileOverlayActuallyOpen(root, 'sb-nav-open');
    }

    if (root.id === 'sb-mobile-chat-tools') {
        return isMobileOverlayActuallyOpen(root, 'sb-chat-tools-open');
    }

    return isDrawerActuallyOpen(root);
}

function getActiveMobileModalRoots() {
    if (!isMobileViewport()) {
        return [];
    }

    return getMobileModalRootCandidates().filter(root => isMobileModalRootOpen(root));
}

function setElementInertForMobileModal(element, shouldInert) {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    if (shouldInert) {
        if (!element.hasAttribute('data-sb-mobile-modal-prev-aria-hidden')) {
            element.setAttribute(
                'data-sb-mobile-modal-prev-aria-hidden',
                element.getAttribute('aria-hidden') ?? '',
            );
        }

        element.setAttribute('aria-hidden', 'true');
        if ('inert' in element) {
            element.inert = true;
        }
        return;
    }

    const previousAriaHidden = element.getAttribute('data-sb-mobile-modal-prev-aria-hidden');
    if (previousAriaHidden !== null) {
        if (previousAriaHidden) {
            element.setAttribute('aria-hidden', previousAriaHidden);
        } else {
            element.removeAttribute('aria-hidden');
        }
        element.removeAttribute('data-sb-mobile-modal-prev-aria-hidden');
    }

    if ('inert' in element) {
        element.inert = false;
    }
}

function setMobileModalRootA11y(root, isActiveRoot) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    const hasManagedAriaState = root.id === 'sb-mobile-nav' || root.id === 'sb-mobile-chat-tools';

    if (isActiveRoot) {
        if (hasManagedAriaState) {
            root.setAttribute('aria-hidden', 'false');
            if ('inert' in root) {
                root.inert = false;
            }
            return;
        }

        if (!root.hasAttribute('data-sb-mobile-modal-root-prev-aria-hidden')) {
            root.setAttribute(
                'data-sb-mobile-modal-root-prev-aria-hidden',
                root.getAttribute('aria-hidden') ?? '',
            );
        }

        root.setAttribute('aria-hidden', 'false');
        if ('inert' in root) {
            root.inert = false;
        }
        return;
    }

    if (hasManagedAriaState) {
        return;
    }

    const previousAriaHidden = root.getAttribute('data-sb-mobile-modal-root-prev-aria-hidden');
    if (previousAriaHidden !== null) {
        if (previousAriaHidden) {
            root.setAttribute('aria-hidden', previousAriaHidden);
        } else {
            root.removeAttribute('aria-hidden');
        }
        root.removeAttribute('data-sb-mobile-modal-root-prev-aria-hidden');
    }
}

function syncMobileModalState() {
    const activeRoots = getActiveMobileModalRoots();
    const activeRootSet = new Set(activeRoots);
    const modalState = nnMobileShellLifecycle.modal.resolveA11yState({
        activeRootIds: activeRoots.map(root => root.id),
    });

    document.body?.classList.toggle('sb-mobile-modal-open', modalState.hasActiveMobileModal);

    for (const root of getMobileModalRootCandidates()) {
        setMobileModalRootA11y(root, activeRootSet.has(root));
    }

    // Neconyan: only the chat is inerted. Mobile panels dock below the top bar instead of
    // covering it, so its proxy buttons stay reachable and re-tapping one closes the panel,
    // same as on desktop.
    setElementInertForMobileModal(document.getElementById('sheld'), modalState.shouldInertShell);
}

function queueMobileModalStateSync() {
    if (nnState.mobileModal.syncFrame) {
        return;
    }

    nnState.mobileModal.syncFrame = window.requestAnimationFrame(() => {
        nnState.mobileModal.syncFrame = 0;
        syncMobileModalState();
    });
}

function isTopbarPageActive(page) {
    return page.shellKey === 'characters'
        ? isCharacterPanelTabOpen(page.tabId)
        : isShellTabOpen(page.shellKey, page.tabId);
}

function syncTopbarPageButtonStates() {
    syncTopbarEditCardButton();
    for (const page of NN_TOPBAR_PAGE_TARGETS) {
        const button = document.querySelector(`[data-sb-topbar-page="${CSS.escape(page.value)}"]`);

        if (!(button instanceof HTMLElement)) {
            continue;
        }

        const isActive = isTopbarPageActive(page);
        button.classList.toggle('is-current', isActive);
        button.setAttribute('aria-expanded', String(isActive));

        if (isActive) {
            button.setAttribute('aria-current', 'page');
        } else {
            button.removeAttribute('aria-current');
        }
    }

    syncCharacterTopbarButtonState();
    syncNeconyanRailSelection();
}

function syncNeconyanRailSelection() {
    const route = document.body.classList.contains('neconyan-notes-open') ? 'notes'
        : isCharacterPanelOpen()
            ? ({
                'world-info': 'lorebooks',
                persona: 'persona',
            }[getActiveCharacterPanelTab()] ?? 'characters')
            : isShellOpen('left') ? ({
                presets: 'presets',
                sampling: 'sampling',
                'advanced-formatting': 'formatting',
                agents: 'agents',
                mewmory: 'mewmory',
            }[getShellState('left')?.activeTabId] ?? 'model')
                : isShellOpen('right') ? ({
                    extensions: 'extensions',
                    background: 'background',
                    server: 'server',
                    'console-logs': 'console-logs',
                    'included-tool': getIncludedToolRailRoute(),
                }[getShellState('right')?.activeTabId] ?? 'settings')
                    : isLandingPageVisible() ? 'home' : '';
    for (const button of document.querySelectorAll('#neconyan-workspace-rail [data-neconyan-route]')) {
        if (button.dataset.neconyanRoute === route) {
            button.setAttribute('aria-current', 'page');
        } else {
            button.removeAttribute('aria-current');
        }
    }
    syncNeconyanModeControls();
}

function queueTopbarPageStateSync() {
    if (nnState.topbarPages.syncFrame) {
        return;
    }

    nnState.topbarPages.syncFrame = window.requestAnimationFrame(() => {
        nnState.topbarPages.syncFrame = 0;
        syncTopbarPageButtonStates();
    });
}

let neconyanTopbarClockTimer = 0;
let neconyanTopbarStateBound = false;

function refreshNeconyanTopbarClock() {
    const clock = document.getElementById('sb-topbar-clock');
    if (!(clock instanceof HTMLElement)) {
        return;
    }
    const now = new Date();
    clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    clock.setAttribute('datetime', now.toISOString());
}

function startNeconyanTopbarClock() {
    window.clearInterval(neconyanTopbarClockTimer);
    refreshNeconyanTopbarClock();
    neconyanTopbarClockTimer = window.setInterval(refreshNeconyanTopbarClock, 15000);
}

function syncTopbarEditCardButton() {
    const button = document.getElementById('sb-topbar-edit-card');
    if (!(button instanceof HTMLElement)) {
        return;
    }
    const visible = document.body.classList.contains('neconyan')
        && getActualNeconyanMode() === 'roleplay'
        && hasActiveCharacterChat()
        && !isLandingPageVisible();
    if (button.hidden === visible) button.hidden = !visible;
}

function bindNeconyanTopbarStateEvents() {
    if (neconyanTopbarStateBound || !eventSource?.on) {
        return;
    }
    neconyanTopbarStateBound = true;
    const refresh = () => queueTopbarPageStateSync();
    for (const name of [event_types?.CHAT_CHANGED, event_types?.CHAT_LOADED, event_types?.CHAT_CREATED, event_types?.GROUP_CHAT_CREATED, event_types?.CHAT_DELETED].filter(Boolean)) {
        eventSource.on(name, refresh);
    }
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(records => {
            if (hasChangedAttributeValue(records)) {
                syncTopbarEditCardButton();
            }
        }).observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'data-neconyan-chat-mode'],
            attributeOldValue: true,
        });
    }
}

function forceDrawerState(drawerRootOrId, shouldOpen, drawerIconOrSelector = null) {
    const el = typeof drawerRootOrId === 'string'
        ? document.getElementById(drawerRootOrId)
        : drawerRootOrId;
    if (!(el instanceof HTMLElement)) return;
    // The Neconyan frame has one inspector slot, so replace its current panel.
    if (shouldOpen && document.body.classList.contains('neconyan')
        && ['left-nav-panel', 'user-settings-block', 'right-nav-panel'].includes(el.id)) {
        if (el.id !== 'left-nav-panel') closeShell('left');
        if (el.id !== 'user-settings-block') closeShell('right');
        if (el.id !== 'right-nav-panel') displaceCharacterPanel();
    }
    el.classList.toggle('openDrawer', Boolean(shouldOpen));
    el.classList.toggle('closedDrawer', !shouldOpen);
    syncDrawerIconState(drawerIconOrSelector, shouldOpen);
    queueMobileModalStateSync();
    queueTopbarPageStateSync();
}

function isShellOpen(shellKey) {
    return isDrawerActuallyOpen(getShellConfig(shellKey).rootPanelId);
}

function isShellTabOpen(shellKey, tabId) {
    const shellState = getShellState(shellKey);
    return Boolean(shellState && isShellOpen(shellKey) && shellState.activeTabId === tabId);
}

function isCharacterPanelOpen() {
    return isDrawerActuallyOpen('right-nav-panel');
}

function getActiveCharacterPanelTab() {
    const menuType = getCharacterPanel()?.dataset.menuType;

    if (['persona', 'import', 'world-info', 'groups'].includes(menuType)) {
        return menuType;
    }

    if (['character_edit', 'group_edit', 'create', 'group_create', 'editor_empty'].includes(menuType)) {
        return 'editor';
    }

    return 'characters';
}

function isCharacterPanelTabOpen(tabId) {
    return isCharacterPanelOpen() && getActiveCharacterPanelTab() === normalizeCharacterPanelTab(tabId);
}

function hasActiveCharacterChat(context = getSillyTavernContext()) {
    if (context?.groupId) {
        return true;
    }

    return Boolean(
        context
        && context.characterId !== undefined
        && context.characterId !== null
        && context.characters?.[context.characterId],
    );
}

async function setCharacterListEntityView(view) {
    try {
        const module = await getMainScriptModule();
        module.setCharacterMenuEntityView?.(view);
    } catch (error) {
        console.warn('[Neconyan] Could not set character list entity view.', error);
    }
}

function syncCharacterListControls(view) {
    const normalizedView = view === 'groups' ? 'groups' : 'characters';
    const createCharacterButton = document.getElementById('rm_button_create');
    const importButton = document.getElementById('character_import_button');
    const createGroupButton = document.getElementById('rm_button_group_chats');
    const bulkEditButton = document.getElementById('bulkEditButton');
    const bulkSelectAllButton = document.getElementById('bulkSelectAllButton');
    const bulkDeleteButton = document.getElementById('bulkDeleteButton');
    const hotSwap = document.getElementById('CharListButtonAndHotSwaps');

    if (createCharacterButton instanceof HTMLElement) {
        createCharacterButton.hidden = normalizedView === 'groups';
    }

    if (importButton instanceof HTMLElement) {
        importButton.hidden = normalizedView === 'groups';
    }

    if (createGroupButton instanceof HTMLElement) {
        createGroupButton.hidden = normalizedView !== 'groups';
    }

    if (hotSwap instanceof HTMLElement) {
        const actualFavorites = hotSwap.querySelectorAll('.hotswap .avatar, .hotswap [data-chid]').length > 0;
        const hasFavoriteCharacters = characters.some(character => character?.fav === true || character?.fav === 'true');
        const hasFavorites = actualFavorites || (normalizedView === 'characters' && hasFavoriteCharacters);
        hotSwap.hidden = !hasFavorites;
        hotSwap.classList.toggle('has-favorites', hasFavorites);
    }

    for (const button of [bulkEditButton, bulkSelectAllButton, bulkDeleteButton]) {
        if (button instanceof HTMLElement) {
            button.hidden = false;
        }
    }

    for (const actionId of ['character_context_menu_favorite', 'character_context_menu_duplicate', 'character_context_menu_persona']) {
        const action = document.getElementById(actionId)?.closest('li');
        if (action instanceof HTMLElement) {
            action.hidden = normalizedView === 'groups';
        }
    }

    if (bulkEditButton instanceof HTMLElement) {
        bulkEditButton.title = normalizedView === 'groups'
            ? 'Bulk actions for group chats'
            : 'Bulk edit characters\n\nClick to toggle characters\nShift + Click to select/deselect a range of characters\nRight-click for actions';
    }
}

function ensureCharacterEditorLayout() {
    const form = document.getElementById('form_create');
    const basics = document.getElementById('sb_character_editor_panel_char_info');
    const advanced = document.getElementById('sb_character_editor_panel_metadata');
    const commitBar = document.getElementById('sb_character_commit_bar');

    if (!(form instanceof HTMLElement) || !(basics instanceof HTMLElement) || !(advanced instanceof HTMLElement)) {
        return;
    }

    const description = document.getElementById('descriptionWrapper');
    const personality = document.getElementById('personality_div');
    if (description instanceof HTMLElement && description.parentElement !== basics) {
        basics.append(description);
    }
    if (personality instanceof HTMLElement && personality.parentElement !== basics) {
        basics.append(personality);
    }

    const tags = document.getElementById('tags_div');
    if (tags instanceof HTMLElement && tags.parentElement !== basics) {
        basics.append(tags);
    }

    const promptOverrides = basics.querySelector('.sb-character-editor-prompt-overrides');
    if (promptOverrides instanceof HTMLElement && promptOverrides.parentElement !== advanced) {
        advanced.prepend(promptOverrides);
    }

    if (commitBar instanceof HTMLElement) {
        const commitActions = commitBar.querySelector('.sb-character-commit-actions');
        const createButton = document.getElementById('create_button_label');
        const backButton = document.getElementById('rm_button_back');
        if (commitActions instanceof HTMLElement) {
            if (backButton instanceof HTMLElement && backButton.parentElement !== commitActions) {
                commitActions.append(backButton);
            }
            if (createButton instanceof HTMLElement && createButton.parentElement !== commitActions) {
                commitActions.append(createButton);
            }
        }
    }
}

function ensureCharacterListToolbarLayout() {
    const fixedTop = document.getElementById('charListFixedTop');
    const buttonBar = document.getElementById('rm_button_bar');
    const createButton = document.getElementById('rm_button_create');
    const importButton = document.getElementById('character_import_button');
    const createGroupButton = document.getElementById('rm_button_group_chats');
    const searchButton = document.getElementById('rm_button_search');
    const pagination = document.getElementById('rm_print_characters_pagination');

    if (!(fixedTop instanceof HTMLElement) || !(buttonBar instanceof HTMLElement)) {
        return;
    }

    let primaryActions = fixedTop.parentElement.querySelector('.sb-character-library-primary-actions');
    if (!(primaryActions instanceof HTMLElement)) {
        primaryActions = createElement('div', { className: 'sb-character-library-primary-actions' });
        fixedTop.prepend(primaryActions);
    }

    for (const button of [createButton, importButton, createGroupButton]) {
        if (button instanceof HTMLElement && button.parentElement !== primaryActions) {
            primaryActions.append(button);
        }
    }

    // Character-list extension buttons (for example Chat Archive) belong in the main tool
    // row; the shared slot would otherwise stay parked inside the collapsed filter drawer.
    const extensionButtons = document.getElementById('rm_buttons_container');
    if (extensionButtons instanceof HTMLElement && extensionButtons.parentElement !== primaryActions) {
        primaryActions.append(extensionButtons);
    }

    let secondaryActions = fixedTop.parentElement.querySelector('.sb-character-library-secondary-actions');
    if (!(secondaryActions instanceof HTMLElement)) {
        secondaryActions = createElement('div', { className: 'sb-character-library-secondary-actions' });
        fixedTop.append(secondaryActions);
    }

    if (buttonBar.parentElement !== secondaryActions) {
        secondaryActions.append(buttonBar);
    }

    const footer = fixedTop.parentElement?.querySelector('.neconyan-character-library-footer');
    const paginationHost = footer || fixedTop.parentElement;
    if (pagination instanceof HTMLElement && pagination.parentElement !== paginationHost) {
        paginationHost?.append(pagination);
    }

    // Phones: Create/Import lead the single scrolling tool row under the search field.
    // Desktop keeps them beside the search field in #charListFixedTop.
    const primaryHost = isMobileViewport() && footer instanceof HTMLElement ? footer : fixedTop;
    if (primaryActions.parentElement !== primaryHost) {
        primaryHost.prepend(primaryActions);
    }

    if (searchButton instanceof HTMLElement && searchButton.parentElement !== buttonBar) {
        buttonBar.appendChild(searchButton);
    }
}

async function showCharacterListView(view = 'characters') {
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    const panel = getCharacterPanel();
    const normalizedView = view === 'groups' ? 'groups' : 'characters';
    nnState.characterDrawer.lastTab = normalizedView;

    setCharacterPanelMenuType(panel, normalizedView);

    syncCharacterListControls(normalizedView);
    await setCharacterListEntityView(normalizedView);

    const backButton = document.getElementById('rm_button_back');

    if (backButton instanceof HTMLElement) {
        backButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        setCharacterPanelMenuType(panel, normalizedView);
        syncCharacterListControls(normalizedView);
        syncCharacterShellTabs(normalizedView);
        return true;
    }

    resetCharacterPanelView();
    setCharacterPanelMenuType(panel, normalizedView);
    syncCharacterListControls(normalizedView);
    syncCharacterShellTabs(normalizedView);
    return true;
}

function showCharacterEditorEmptyState() {
    const panel = getCharacterPanel();
    const infoPanel = document.getElementById('result_info');
    const pinAndTabs = document.getElementById('rm_PinAndTabs');
    const characterEditor = document.getElementById('rm_ch_create_block');
    const groupEditor = document.getElementById('rm_group_chats_block');
    const characterList = document.getElementById('rm_characters_block');

    setCharacterPanelMenuType(panel, 'editor_empty');
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterEditorEmptyState(true);

    if (infoPanel instanceof HTMLElement) {
        infoPanel.style.display = 'none';
    }

    if (pinAndTabs instanceof HTMLElement) {
        pinAndTabs.style.display = 'none';
    }

    if (characterEditor instanceof HTMLElement) {
        characterEditor.classList.remove('sb-active-right-menu');
        characterEditor.style.display = 'none';
        characterEditor.style.visibility = 'hidden';
        characterEditor.style.pointerEvents = 'none';
    }

    if (groupEditor instanceof HTMLElement) {
        groupEditor.classList.remove('sb-active-right-menu');
        groupEditor.style.display = 'none';
        groupEditor.style.visibility = 'hidden';
        groupEditor.style.pointerEvents = 'none';
    }

    if (characterList instanceof HTMLElement) {
        characterList.classList.remove('sb-active-right-menu');
        characterList.style.display = 'none';
        characterList.style.visibility = 'hidden';
        characterList.style.pointerEvents = 'none';
    }

    syncCharacterShellTabs('editor');
}

function setCharacterEditorEmptyState(visible) {
    const emptyState = document.getElementById('sb_character_editor_empty');

    if (emptyState instanceof HTMLElement) {
        emptyState.hidden = !visible;
    }

    syncCharacterTitlebarVisibility();
}

function syncCharacterTitlebarVisibility() {
    const panel = getCharacterPanel();
    const pinAndTabs = document.getElementById('rm_PinAndTabs');

    if (!(panel instanceof HTMLElement) || !(pinAndTabs instanceof HTMLElement)) {
        return;
    }

    const shouldHide = ['characters', 'groups', 'editor_empty', 'world-info', 'persona', 'import', 'conversation'].includes(panel.dataset.menuType ?? '');
    pinAndTabs.style.display = shouldHide ? 'none' : '';
    // Phones: the name/token titlebar scrolls away with the editor body instead of pinning
    // another 100px of chrome above it. Desktop keeps it as a direct panel child.
    const scroller = panel.querySelector(':scope > .scrollableInner');
    if (scroller instanceof HTMLElement) {
        if (isMobileViewport()) {
            if (pinAndTabs.parentElement !== scroller) scroller.prepend(pinAndTabs);
        } else if (pinAndTabs.parentElement !== panel) {
            scroller.before(pinAndTabs);
        }
    }
    syncCharacterEditorFullscreenAvailability();
}

function ensureCharacterPersonaPanel() {
    const host = document.getElementById('sb_character_persona_panel');
    const drawer = document.getElementById('persona-management-button');
    const content = document.getElementById('PersonaManagement');

    if (!(host instanceof HTMLElement) || !(drawer instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return null;
    }

    host.setAttribute('role', 'tabpanel');
    host.setAttribute('aria-labelledby', 'sb_character_tab_persona');
    drawer.classList.add('sb-embedded-drawer');
    drawer.querySelector(':scope > .drawer-toggle')?.classList.add('sb-hidden-toggle');
    content.classList.remove('drawer-content', 'openDrawer', 'closedDrawer', 'fillLeft', 'fillRight', 'pinnedOpen');
    content.classList.add('sb-managed', 'sb-shell-embedded-content');
    content.removeAttribute('style');
    content.setAttribute('aria-hidden', String(host.hidden));

    if (drawer.parentElement !== host) {
        host.appendChild(drawer);
    }

    return host;
}

function ensureCharacterWorldInfoPanel() {
    const host = document.getElementById('sb_character_world_info_panel');
    const drawer = document.getElementById('WI-SP-button');
    const content = document.getElementById('WorldInfo');

    if (!(host instanceof HTMLElement) || !(drawer instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return null;
    }

    host.setAttribute('role', 'tabpanel');
    host.setAttribute('aria-labelledby', 'sb_character_tab_world_info');
    drawer.classList.add('sb-embedded-drawer');
    drawer.querySelector(':scope > .drawer-toggle')?.classList.add('sb-hidden-toggle');
    content.classList.remove('drawer-content', 'openDrawer', 'closedDrawer', 'fillLeft', 'fillRight', 'pinnedOpen');
    content.classList.add('sb-managed', 'sb-shell-embedded-content');
    content.removeAttribute('style');
    content.removeAttribute('data-dragged');
    content.setAttribute('role', 'tabpanel');
    content.setAttribute('aria-labelledby', 'sb_character_tab_world_info');
    content.setAttribute('aria-hidden', String(host.hidden));

    if (drawer.parentElement !== host) {
        host.appendChild(drawer);
    }

    drawer.querySelector('#WI_panel_pin_div')?.classList.add('sb-shell-hidden-control');
    preloadPanelStylesheets('characters', 'world-info');
    return host;
}

function setCharacterPersonaPanelVisible(visible) {
    const host = ensureCharacterPersonaPanel() ?? document.getElementById('sb_character_persona_panel');

    if (host instanceof HTMLElement) {
        host.hidden = !visible;
        host.setAttribute('aria-hidden', String(!visible));
    }

    const content = document.getElementById('PersonaManagement');
    if (content instanceof HTMLElement) {
        content.setAttribute('aria-hidden', String(!visible));
    }
}

function setCharacterImportPanelVisible(visible) {
    const host = document.getElementById('sb_character_import_panel');

    if (host instanceof HTMLElement) {
        host.hidden = !visible;
        host.setAttribute('aria-hidden', String(!visible));
    }
}

function setCharacterWorldInfoPanelVisible(visible) {
    const host = ensureCharacterWorldInfoPanel() ?? document.getElementById('sb_character_world_info_panel');
    const content = document.getElementById('WorldInfo');

    if (host instanceof HTMLElement) {
        host.hidden = !visible;
        host.setAttribute('aria-hidden', String(!visible));
    }

    if (content instanceof HTMLElement) {
        content.setAttribute('aria-hidden', String(!visible));
    }
}

function getCharacterEditorSubTabState() {
    const storedTab = safeGetItem(NN_STORAGE_KEYS.characterEditorSubTab);
    return normalizeCharacterEditorSubTab(storedTab);
}

function saveCharacterEditorSubTab(tabId) {
    safeSetItem(NN_STORAGE_KEYS.characterEditorSubTab, normalizeCharacterEditorSubTab(tabId));
}

function updateCharacterEditorSubTabButtons(activeTabId) {
    const activeSubTab = resolveCharacterEditorSubTab(activeTabId);

    for (const tabButton of document.querySelectorAll('#sb_character_editor_subtabs [data-sb-character-editor-tab]')) {
        if (!(tabButton instanceof HTMLElement)) {
            continue;
        }

        const isActive = tabButton.dataset.sbCharacterEditorTab === activeSubTab;
        tabButton.classList.toggle('is-active', isActive);
        tabButton.setAttribute('aria-selected', String(isActive));
        tabButton.setAttribute('tabindex', isActive ? '0' : '-1');
        // Dimmed, not disabled: tapping a spoiler-hidden tab reveals the fields (see bindCharacterEditorSubTabs).
        tabButton.classList.toggle('is-spoiler-hidden', isCharacterEditorSubTabSpoilerHidden(tabButton.dataset.sbCharacterEditorTab));
    }

    syncNeconyanSectionSelect(document.getElementById('sb_character_editor_subtabs'), 'data-sb-character-editor-tab', 'Editor section');
}

function updateCharacterEditorSubTabPanels(activeTabId) {
    const activeSubTab = resolveCharacterEditorSubTab(activeTabId);

    for (const panel of document.querySelectorAll('#form_create [data-sb-character-editor-panel]')) {
        if (!(panel instanceof HTMLElement)) {
            continue;
        }

        const isActive = panel.dataset.sbCharacterEditorPanel === activeSubTab;
        panel.hidden = !isActive;
        panel.setAttribute('aria-hidden', String(!isActive));
    }
}

function syncCharacterEditorSubTabs(activeTabId = getCharacterEditorSubTabState()) {
    const normalizedTab = resolveCharacterEditorSubTab(activeTabId);
    saveCharacterEditorSubTab(normalizedTab);
    updateCharacterEditorSubTabButtons(normalizedTab);
    updateCharacterEditorSubTabPanels(normalizedTab);
}

function focusCharacterEditorSubTab(tabId) {
    const button = document.querySelector(`#sb_character_editor_subtabs [data-sb-character-editor-tab="${tabId}"]`);
    if (button instanceof HTMLElement) {
        button.focus({ preventScroll: true });
    }
}

function setCharacterEditorSubTab(tabId, { focusButton = false } = {}) {
    const normalizedTab = normalizeCharacterEditorSubTab(tabId);
    syncCharacterEditorSubTabs(normalizedTab);

    if (focusButton) {
        focusCharacterEditorSubTab(normalizedTab);
    }
}

function setCharacterEditorFullscreenState(expanded, { focusButton = false } = {}) {
    const panel = getCharacterPanel();
    const toggleButton = document.getElementById('sb_character_editor_fullscreen_toggle');
    const wasExpanded = panel instanceof HTMLElement && panel.classList.contains('sb-character-editor-fullscreen');
    const canExpand = panel instanceof HTMLElement
        && panel.classList.contains('openDrawer')
        && isCharacterEditorMenuType(panel.dataset.menuType);
    const isExpanded = Boolean(expanded) && canExpand;

    if (panel instanceof HTMLElement) {
        panel.classList.toggle('sb-character-editor-fullscreen', isExpanded);
        panel.dataset.sbCharacterEditorFullscreen = String(isExpanded);
    }

    if (toggleButton instanceof HTMLButtonElement) {
        setButtonPressed(toggleButton, isExpanded);
        toggleButton.title = isExpanded ? 'Exit editor fullscreen' : 'Enter editor fullscreen';
        toggleButton.setAttribute('aria-label', toggleButton.title);
        toggleButton.setAttribute('aria-expanded', String(isExpanded));
        toggleButton.dataset.i18n = isExpanded
            ? '[title]Exit editor fullscreen;[aria-label]Exit editor fullscreen'
            : '[title]Enter editor fullscreen;[aria-label]Enter editor fullscreen';

        if (focusButton) {
            toggleButton.focus({ preventScroll: true });
        }
    }

    if (isExpanded && !wasExpanded) {
        scrollElementIntoManagedView(document.getElementById('sb_character_editor_subtabs'), { block: 'nearest' });
    }
}

function setCharacterPanelMenuType(panel, menuType) {
    if (!(panel instanceof HTMLElement)) {
        return;
    }

    if (!isCharacterEditorMenuType(menuType)) {
        setCharacterEditorFullscreenState(false);
    }

    panel.dataset.menuType = menuType;
    if (panel.dataset.menuType !== menuType) {
        panel.setAttribute('data-menu-type', menuType);
    }
}

function toggleCharacterEditorFullscreen() {
    const panel = getCharacterPanel();
    if (!(panel instanceof HTMLElement) || !panel.classList.contains('openDrawer') || !isCharacterEditorMenuType(panel.dataset.menuType)) {
        return;
    }

    setCharacterEditorFullscreenState(!panel.classList.contains('sb-character-editor-fullscreen'), { focusButton: true });
}

function syncCharacterEditorFullscreenAvailability() {
    const panel = getCharacterPanel();
    const toggleButton = document.getElementById('sb_character_editor_fullscreen_toggle');
    const canUseFullscreen = panel instanceof HTMLElement
        && isCharacterEditorMenuType(panel.dataset.menuType)
        && panel.classList.contains('openDrawer');

    if (toggleButton instanceof HTMLButtonElement) {
        toggleButton.hidden = !canUseFullscreen;
    }

    if (!canUseFullscreen) {
        setCharacterEditorFullscreenState(false);
    }
}

function bindCharacterEditorFullscreenToggle() {
    const toggleButton = document.getElementById('sb_character_editor_fullscreen_toggle');
    if (!(toggleButton instanceof HTMLButtonElement) || toggleButton.dataset.sbBound === 'true') {
        return;
    }

    toggleButton.dataset.sbBound = 'true';
    toggleButton.addEventListener('click', () => toggleCharacterEditorFullscreen());

    const panel = getCharacterPanel();
    if (panel instanceof HTMLElement && panel.dataset.sbEditorFullscreenKeyBound !== 'true') {
        panel.dataset.sbEditorFullscreenKeyBound = 'true';
        panel.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !panel.classList.contains('sb-character-editor-fullscreen')) {
                return;
            }

            setCharacterEditorFullscreenState(false, { focusButton: true });
            event.preventDefault();
            event.stopPropagation();
        });
    }

    syncCharacterEditorFullscreenAvailability();
}

async function openCreatorNotesFullscreen() {
    const context = getSillyTavernContext();
    const spoiler = document.getElementById('creator_notes_spoiler');

    if (!context?.callGenericPopup || !spoiler) {
        return;
    }

    // Move the rendered node instead of re-rendering it: formatCreatorNotes() scopes embedded
    // <custom-style> rules to '#creator_notes_spoiler ', and the live textarea sync keeps writing
    // to this same element while the popup is open.
    const anchor = document.createComment('sb-creator-notes-fullscreen');
    spoiler.replaceWith(anchor);

    const wrapper = document.createElement('div');
    wrapper.className = 'sb-creator-notes-fullscreen';
    wrapper.append(spoiler);

    try {
        await context.callGenericPopup(wrapper, context.POPUP_TYPE.TEXT, '', { wide: true, large: true });
    } finally {
        if (anchor.isConnected) {
            anchor.replaceWith(spoiler);
        } else {
            document.querySelector('.sb-character-creator-notes-preview-body')?.prepend(spoiler);
        }
    }
}

function bindCreatorNotesFullscreen() {
    const button = document.getElementById('sb_creator_notes_maximize');
    if (!(button instanceof HTMLButtonElement) || button.dataset.sbBound === 'true') {
        return;
    }

    button.dataset.sbBound = 'true';
    button.addEventListener('click', () => openCreatorNotesFullscreen());
}

function focusCharacterPanelTab(tabId) {
    const normalizedTabId = normalizeCharacterPanelTab(tabId);
    const button = getCharacterPanel()?.querySelector(`[data-sb-character-tab="${CSS.escape(normalizedTabId)}"]`);

    if (button instanceof HTMLElement) {
        button.focus({ preventScroll: true });
    }
}

function bindCharacterEditorSubTabs() {
    const tablist = document.getElementById('sb_character_editor_subtabs');
    if (!(tablist instanceof HTMLElement) || tablist.dataset.sbBound === 'true') {
        return;
    }

    tablist.dataset.sbBound = 'true';
    if (typeof tablist.setAttribute === 'function') {
        tablist.setAttribute('aria-orientation', 'vertical');
    }

    tablist.addEventListener('click', (event) => {
        const target = event.target instanceof HTMLElement ? event.target.closest('[data-sb-character-editor-tab]') : null;
        if (!(target instanceof HTMLButtonElement)) {
            return;
        }

        const tabId = target.dataset.sbCharacterEditorTab;
        // Spoiler-free mode hides Definitions/Greetings; a deliberate tap on one of them is the same request as the eye
        // button's peek, so reveal the fields first instead of silently landing on Metadata.
        if (isCharacterEditorSubTabSpoilerHidden(tabId)) {
            setCharacterSpoilerFreeFieldsHidden(false);
        }

        setCharacterEditorSubTab(tabId, { focusButton: false });
    });

    tablist.addEventListener('keydown', (event) => {
        if (!(event.target instanceof HTMLElement)) {
            return;
        }

        const targetButton = event.target.closest('[data-sb-character-editor-tab]');
        if (!(targetButton instanceof HTMLButtonElement)) {
            return;
        }

        const buttons = Array.from(tablist.querySelectorAll('[data-sb-character-editor-tab]'));
        const currentIndex = buttons.indexOf(targetButton);
        if (currentIndex === -1) {
            return;
        }

        const lastIndex = buttons.length - 1;
        let nextIndex = currentIndex;

        const isVertical = tablist.getAttribute('aria-orientation') === 'vertical';
        if (event.key === 'ArrowDown' || (!isVertical && event.key === 'ArrowRight')) {
            nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
        } else if (event.key === 'ArrowUp' || (!isVertical && event.key === 'ArrowLeft')) {
            nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
        } else if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = lastIndex;
        } else {
            return;
        }

        event.preventDefault();
        const nextButton = buttons[nextIndex];
        if (nextButton instanceof HTMLButtonElement) {
            setCharacterEditorSubTab(nextButton.dataset.sbCharacterEditorTab, { focusButton: true });
        }
    });

    syncCharacterEditorSubTabs();
}

function hideCharacterMainPanels() {
    const infoPanel = document.getElementById('result_info');
    const pinAndTabs = document.getElementById('rm_PinAndTabs');
    const characterEditor = document.getElementById('rm_ch_create_block');
    const groupEditor = document.getElementById('rm_group_chats_block');
    const characterList = document.getElementById('rm_characters_block');

    if (infoPanel instanceof HTMLElement) {
        infoPanel.style.display = 'none';
    }

    if (pinAndTabs instanceof HTMLElement) {
        pinAndTabs.style.display = 'none';
    }

    if (characterEditor instanceof HTMLElement) {
        characterEditor.style.display = 'none';
        characterEditor.style.visibility = 'hidden';
        characterEditor.style.pointerEvents = 'none';
    }

    if (groupEditor instanceof HTMLElement) {
        groupEditor.style.display = 'none';
        groupEditor.style.visibility = 'hidden';
        groupEditor.style.pointerEvents = 'none';
    }

    if (characterList instanceof HTMLElement) {
        characterList.style.display = 'none';
        characterList.style.visibility = 'hidden';
        characterList.style.pointerEvents = 'none';
    }
}

function openCharacterWorldInfoTab() {
    const panel = getCharacterPanel();
    nnState.characterDrawer.lastTab = 'world-info';

    applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
        surface: nnMobileShellLifecycle.overlays.surface.CHARACTER_PANEL,
        isMobileViewport: isMobileViewport(),
    }));
    setCharacterPanelMenuType(panel, 'world-info');
    preloadPanelStylesheets('characters', 'world-info');
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterWorldInfoPanelVisible(true);
    mountNeconyanLorebookWorkspace(panel ?? document);
    hideCharacterMainPanels();

    syncDrawerIconState('#WIDrawerIcon', true);
    syncCharacterShellTabs('world-info');
    syncCharacterTitlebarVisibility();
    window.requestAnimationFrame(() => focusCharacterPanelTab('world-info'));
}

function openCharacterPersonaTab() {
    const panel = getCharacterPanel();
    nnState.characterDrawer.lastTab = 'persona';

    preloadPanelStylesheets('characters', 'persona');
    setCharacterPanelMenuType(panel, 'persona');
    setCharacterEditorEmptyState(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterPersonaPanelVisible(true);
    hideCharacterMainPanels();

    syncNeconyanSectionSelect(document.querySelector('#PersonaManagement .persona-editor-tabs'), 'data-persona-editor-tab', 'Persona section');

    syncCharacterShellTabs('persona');
    syncCharacterTitlebarVisibility();
}

function openCharacterImportTab() {
    const panel = getCharacterPanel();
    nnState.characterDrawer.lastTab = 'import';

    setCharacterPanelMenuType(panel, 'import');
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterImportPanelVisible(true);
    hideCharacterMainPanels();

    syncCharacterShellTabs('import');
    syncCharacterTitlebarVisibility();
}

function preserveCharacterImportTab() {
    const panel = getCharacterPanel();

    if (panel instanceof HTMLElement && panel.dataset.menuType !== 'import') {
        return;
    }

    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterListControls('characters');
    setCharacterImportPanelVisible(true);
    hideCharacterMainPanels();
    syncCharacterShellTabs('import');
    syncCharacterTitlebarVisibility();
}

function syncCharacterModeToggle() {
    const toggle = document.getElementById('sb_character_mode_toggle');

    if (!(toggle instanceof HTMLElement)) {
        return;
    }

    const activeMode = conversationState.conversationWorkspaceOpen ? 'conversation' : 'roleplay';
    toggle.dataset.activeMode = activeMode;
    toggle.querySelectorAll('[data-sb-character-mode]').forEach((button) => {
        if (!(button instanceof HTMLButtonElement)) {
            return;
        }

        const isActive = button.dataset.sbCharacterMode === activeMode;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-checked', String(isActive));
        button.setAttribute('aria-label', button.dataset.sbCharacterMode === 'conversation' ? 'Conversation' : 'Roleplay');
    });
}

function setCharacterShellMode(mode) {
    const normalizedMode = mode === 'conversation' ? 'conversation' : 'roleplay';
    const isConversationMode = normalizedMode === 'conversation';
    const mobileViewport = isMobileViewport();

    if (conversationState.conversationWorkspaceOpen === isConversationMode) {
        syncCharacterModeToggle();
        if (mobileViewport) {
            closeCharacterPanel();
        }
        return;
    }

    if (isConversationMode) {
        window.dispatchEvent(new CustomEvent('sb:open-conversation-workspace', {
            detail: {
                avatar: characters[this_chid]?.avatar || '',
                showToast: false,
            },
        }));
    } else {
        window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
    }

    syncCharacterModeToggle();

    if (mobileViewport) {
        closeCharacterPanel();
    }
}

function openCharacterPanelTab(tabId) {
    const normalizedTabId = normalizeCharacterPanelTab(tabId);
    nnState.characterDrawer.lastTab = normalizedTabId;

    if (normalizedTabId !== 'editor') {
        setCharacterEditorFullscreenState(false);
    }

    if (normalizedTabId === 'world-info' || normalizedTabId === 'persona') {
        preloadPanelStylesheets('characters', normalizedTabId);
    }

    if (!isCharacterPanelOpen()) {
        toggleCharacterPanel({ preferredTab: normalizedTabId });
    } else {
        applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: nnMobileShellLifecycle.overlays.surface.CHARACTER_PANEL,
            isMobileViewport: isMobileViewport(),
        }));
    }

    const activateRequestedTab = () => {
        const panel = getCharacterPanel();
        if (normalizedTabId === 'persona') {
            setCharacterPanelMenuType(panel, 'persona');
            openCharacterPersonaTab();
        } else if (normalizedTabId === 'import') {
            setCharacterPanelMenuType(panel, 'import');
            openCharacterImportTab();
        } else if (normalizedTabId === 'groups') {
            setCharacterPanelMenuType(panel, 'groups');
            void showCharacterListView('groups');
        } else if (normalizedTabId === 'editor') {
            setCharacterPanelMenuType(panel, 'character_edit');
            void openCharacterEditorTab();
        } else if (normalizedTabId === 'world-info') {
            setCharacterPanelMenuType(panel, 'world-info');
            openCharacterWorldInfoTab();
        } else {
            setCharacterPanelMenuType(panel, 'characters');
            void showCharacterListView();
        }
    };

    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(activateRequestedTab);
    });
}

function restoreLastCharacterPanelView() {
    const lastTab = nnState.characterDrawer.lastTab || 'characters';

    if (lastTab === 'persona') {
        openCharacterPersonaTab();
    } else if (lastTab === 'import') {
        openCharacterImportTab();
    } else if (lastTab === 'world-info') {
        openCharacterWorldInfoTab();
    } else if (lastTab === 'groups') {
        void showCharacterListView('groups');
    } else if (lastTab === 'editor') {
        void openCharacterEditorTab();
    } else {
        void showCharacterListView('characters');
    }
}

async function openCharacterEditorTab() {
    nnState.characterDrawer.lastTab = 'editor';
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);

    if (await showActiveCharacterEditor()) {
        syncCharacterShellTabs('editor');
        return true;
    }

    showCharacterEditorEmptyState();
    return false;
}

function syncCharacterShellTabs(activeTab = null) {
    const panel = getCharacterPanel();
    const menuType = panel?.dataset.menuType;
    const normalizedTab = activeTab
        ?? (menuType === 'persona'
            ? 'persona'
            : menuType === 'import'
                ? 'import'
                : menuType === 'world-info'
                    ? 'world-info'
                    : menuType === 'groups'
                        ? 'groups'
                        : ['character_edit', 'group_edit', 'create', 'group_create', 'editor_empty'].includes(menuType) ? 'editor' : 'characters');

    nnState.characterDrawer.lastTab = normalizedTab;

    if (menuType === 'characters' || menuType === 'groups') {
        syncCharacterListControls(menuType);
    }

    syncCharacterHeaderCopy(normalizedTab);
    syncCharacterModeToggle();
    const nativePage = NN_CHARACTER_NATIVE_PAGES[normalizedTab] ?? '';
    if (panel instanceof HTMLElement) panel.dataset.neconyanNativePage = nativePage;
    if (normalizedTab === 'persona') mountNeconyanNativePage('persona', document.getElementById('sb_character_persona_panel'));
    else if (normalizedTab === 'import') mountNeconyanNativePage(nativePage, document.getElementById('sb_character_import_panel'));
    else if (nativePage) mountNeconyanNativePage(nativePage, document.getElementById('rm_characters_block'));

    panel?.querySelectorAll('[data-sb-character-tab]').forEach(tab => {
        if (!(tab instanceof HTMLElement)) {
            return;
        }

        const isActive = tab.dataset.sbCharacterTab === normalizedTab;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        tab.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    document.querySelectorAll('[data-sb-rail-shell-key="characters"]').forEach(button => {
        if (!(button instanceof HTMLElement)) {
            return;
        }

        const isActive = button.dataset.sbRailTabId === normalizedTab;
        button.classList.toggle('is-active', isActive);
        if (isActive) {
            button.setAttribute('aria-current', 'page');
        } else {
            button.removeAttribute('aria-current');
        }
    });

    queueTopbarPageStateSync();

    if (panel instanceof HTMLElement && panel.classList.contains('openDrawer')) {
        const tabConfig = getCharacterPanelTabConfig(normalizedTab);
        document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', {
            detail: {
                shellKey: 'characters',
                tabId: normalizedTab,
                label: tabConfig?.label || normalizedTab,
            },
        }));
    }
}

function syncCharacterHeaderCopy(activeTab = 'characters') {
    const copy = NN_CHARACTER_TAB_COPY[activeTab] ?? NN_CHARACTER_TAB_COPY.characters;
    const panel = getCharacterPanel();
    const title = panel?.querySelector('.sb-character-shell-header .sb-shell-title');
    const subtitle = panel?.querySelector('.sb-character-shell-header .sb-shell-subtitle');
    const description = panel?.querySelector('.sb-character-shell-header .sb-shell-description');
    // The static data-i18n markers only describe the first tab; left in place they stop the
    // page localiser from translating the copy written here for every other tab.
    for (const element of [title, subtitle, description]) element?.removeAttribute('data-i18n');

    if (title instanceof HTMLElement) {
        title.textContent = '';
        title.append(document.createTextNode(translate(copy.title)));
        if (activeTab === 'persona') {
            title.insertAdjacentHTML('beforeend', NN_PERSONA_HELP_LINK_HTML);
        }
    }

    if (subtitle instanceof HTMLElement) {
        renderShellSubtitle(subtitle, copy.subtitleIsHtml ? copy.subtitle : translate(copy.subtitle), { isHtml: copy.subtitleIsHtml === true });
    }

    if (description instanceof HTMLElement) {
        description.textContent = translate(copy.description);
    }
}

async function refreshActiveCharacterBeforeEditorOpen() {
    const context = getSillyTavernContext();
    const characterId = context?.characterId;
    const avatar = context?.groupId ? null : context?.characters?.[characterId]?.avatar;

    if (!avatar) {
        return true;
    }

    try {
        if (await flushCharacterSaveDebounced() === false) {
            return false;
        }
        const refreshedContext = getSillyTavernContext();
        const refreshedCharacterId = refreshedContext?.characterId;
        const refreshedAvatar = refreshedContext?.groupId ? null : refreshedContext?.characters?.[refreshedCharacterId]?.avatar;
        await getOneCharacter(refreshedAvatar || avatar);
        return true;
    } catch (error) {
        console.warn('Failed to refresh character before opening editor.', error);
        return false;
    }
}

async function showActiveCharacterEditor() {
    if (!hasActiveCharacterChat()) {
        return false;
    }

    const selectedCharacterButton = document.getElementById('rm_button_selected_ch');
    if (!(selectedCharacterButton instanceof HTMLElement)) {
        return false;
    }

    if (await refreshActiveCharacterBeforeEditorOpen()) {
        selectedCharacterButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } else {
        selectRightMenuWithAnimation('rm_ch_create_block');
        setCharacterPanelMenuType(getCharacterPanel(), 'character_edit');
    }
    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);
    syncCharacterShellTabs('editor');
    return true;
}

function resetCharacterPanelView() {
    const panel = getCharacterPanel();
    const listButton = document.getElementById('rm_button_characters');
    const selectedTitle = document.querySelector('#rm_button_selected_ch h2');

    if (selectedTitle instanceof HTMLElement) {
        selectedTitle.textContent = '';
    }

    setCharacterEditorEmptyState(false);
    setCharacterPersonaPanelVisible(false);
    setCharacterImportPanelVisible(false);
    setCharacterWorldInfoPanelVisible(false);

    if (listButton instanceof HTMLElement) {
        listButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        setCharacterPanelMenuType(panel, 'characters');
        syncCharacterListControls('characters');
        syncCharacterShellTabs('characters');
        return;
    }

    setCharacterPanelMenuType(panel, 'characters');

    const infoPanel = document.getElementById('result_info');
    const characterEditor = document.getElementById('rm_ch_create_block');
    const characterList = document.getElementById('rm_characters_block');

    if (infoPanel instanceof HTMLElement) {
        infoPanel.style.display = 'none';
    }

    if (characterEditor instanceof HTMLElement) {
        characterEditor.style.display = 'none';
        characterEditor.style.visibility = 'hidden';
        characterEditor.style.pointerEvents = 'none';
    }

    if (characterList instanceof HTMLElement) {
        characterList.style.display = 'flex';
        characterList.style.visibility = 'visible';
        characterList.style.pointerEvents = 'auto';
    }

    syncCharacterShellTabs('characters');
}

function setCharacterDrawerHostOverflow(shouldOpen) {
    const host = getCharacterDrawerHost();

    if (host instanceof HTMLElement) {
        host.style.overflow = shouldOpen ? 'visible' : '';
    }
}

function syncCharacterDrawerStateFromDom({ force = false } = {}) {
    const panel = getCharacterPanel();

    if (!(panel instanceof HTMLElement)) {
        return;
    }

    const isOpen = panel.classList.contains('openDrawer');
    if (!force && nnState.characterDrawer.observedOpen === isOpen) {
        return;
    }

    const wasOpen = nnState.characterDrawer.observedOpen;
    nnState.characterDrawer.observedOpen = isOpen;
    rememberCharacterPanelOpenState(wasOpen, isOpen);
    setCharacterDrawerHostOverflow(isOpen);
    syncDrawerIconState('#rightNavDrawerIcon', isOpen);
    syncDrawerIconState('#WIDrawerIcon', isOpen && panel.dataset.menuType === 'world-info');
    syncCharacterEditorFullscreenAvailability();

    if (!isOpen && document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    syncChatbarVisibilityState();
    queueMobileModalStateSync();
    queueTopbarPageStateSync();
}

function bindCharacterDrawerStateObserver() {
    const panel = getCharacterPanel();

    if (!(panel instanceof HTMLElement)) {
        return;
    }

    nnState.characterDrawer.stateObserver?.disconnect();
    nnState.characterDrawer.stateObserver = new MutationObserver((mutations) => {
        syncCharacterDrawerStateFromDom();

        if (mutations.some(mutation => mutation.attributeName === 'data-menu-type')) {
            setCharacterEditorEmptyState(panel.dataset.menuType === 'editor_empty');
            setCharacterPersonaPanelVisible(panel.dataset.menuType === 'persona');
            setCharacterImportPanelVisible(panel.dataset.menuType === 'import');
            setCharacterWorldInfoPanelVisible(panel.dataset.menuType === 'world-info');
            syncCharacterEditorFullscreenAvailability();
            syncCharacterTitlebarVisibility();
            syncCharacterShellTabs();
        }
    });
    nnState.characterDrawer.stateObserver.observe(panel, {
        attributes: true,
        attributeFilter: ['class', 'data-menu-type'],
    });
    syncCharacterDrawerStateFromDom({ force: true });
}

function closeCharacterPanel() {
    const panel = getCharacterPanel();
    const shouldResetViewport = panel instanceof HTMLElement
        && (panel.classList.contains('openDrawer') || (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)));

    setCharacterEditorFullscreenState(false);

    if (panel instanceof HTMLElement && panel.classList.contains('openDrawer')) {
        forceDrawerState(panel, false, '#rightNavDrawerIcon');
    } else if (panel instanceof HTMLElement && document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
        document.activeElement.blur();
    }

    syncDrawerIconState('#WIDrawerIcon', false);
    setCharacterDrawerHostOverflow(false);
    syncChatbarVisibilityState();
    syncMobileShellDrawerBounds();
    queueMobileShellDrawerBoundsSync();
    queueMobileModalStateSync();

    if (shouldResetViewport) {
        requestMobileViewportReset();
    }
}

function isCharacterPanelPinned() {
    // Pinning docks the panel beside chat, a layout that only exists at desktop widths.
    return !isMobileViewport() && document.getElementById('rm_button_panel_pin')?.checked === true;
}

// Opening a chat, going Home and popovers tidy the workspace away. A pinned panel is part of the
// layout rather than an overlay, so it stays; the user still closes it with its own buttons.
function closeCharacterPanelUnlessPinned() {
    if (!isCharacterPanelPinned()) {
        closeCharacterPanel();
    }
}

// Settings and the left shell share the panel's inspector slot, so they replace a pinned panel
// while open and hand the slot back when they close.
function displaceCharacterPanel() {
    if (isCharacterPanelPinned() && isCharacterPanelOpen()) {
        nnState.characterDrawer.displacedWhilePinned = true;
    }
    closeCharacterPanel();
}

// The shell intercepts the native toggle, so the native NavOpened flag is written here instead;
// OpenNavPanels() calls restorePinnedCharacterPanel() on the next load, which reads it.
function rememberCharacterPanelOpenState(wasOpen, isOpen) {
    if (wasOpen === null || isMobileViewport()) {
        return;
    }

    // A displaced pinned panel comes back when Settings closes, so it still counts as open.
    if (!isOpen && nnState.characterDrawer.displacedWhilePinned) {
        return;
    }

    getShellAccountStorage()?.setItem('NavOpened', String(isOpen));
}

function restorePinnedCharacterPanel() {
    if (!isCharacterPanelPinned() || isCharacterPanelOpen()) {
        return;
    }

    if (getShellAccountStorage()?.getItem('NavOpened') === 'true') {
        toggleCharacterPanel();
    }
}

function queuePinnedCharacterPanelRestore() {
    if (!nnState.characterDrawer.displacedWhilePinned || nnState.characterDrawer.restoreFrame) {
        return;
    }

    // Deferred so a shell that closes only to make room for another one keeps the slot.
    nnState.characterDrawer.restoreFrame = window.requestAnimationFrame(() => {
        nnState.characterDrawer.restoreFrame = 0;
        if (isShellOpen('left') || isShellOpen('right')) {
            return;
        }

        const shouldRestore = isCharacterPanelPinned() && !isCharacterPanelOpen();
        nnState.characterDrawer.displacedWhilePinned = false;
        if (shouldRestore) {
            toggleCharacterPanel();
        }
    });
}

function ensureCharacterResizeHandle() {
    const panel = getCharacterPanel();
    if (!(panel instanceof HTMLElement)) {
        return null;
    }

    let handle = panel.querySelector(':scope > .sb-shell-resize-handle');
    if (handle instanceof HTMLElement) {
        return handle;
    }

    handle = createElement('div', {
        className: 'sb-shell-resize-handle',
        attrs: {
            title: 'Resize Characters panel',
        },
    });

    bindShellResizeHandle(handle, 'characters');
    panel.appendChild(handle);
    return handle;
}

let characterToggleDispatchGuard = false;
let characterToggleSkipExtensionIntercept = false;

function syncCharacterToggleGhostRect() {
    const nativeToggle = getCharacterDrawerHost()?.querySelector(':scope > .drawer-toggle');
    const proxyButton = document.getElementById('sb-character-toggle');
    if (!(nativeToggle instanceof HTMLElement)) return;
    if (!(proxyButton instanceof HTMLElement)) return;
    const proxyRect = proxyButton.getBoundingClientRect();
    nativeToggle.style.left = proxyRect.left + 'px';
    nativeToggle.style.top = proxyRect.top + 'px';
    nativeToggle.style.width = proxyRect.width + 'px';
    nativeToggle.style.height = proxyRect.height + 'px';
}

let characterToggleGhostObserver = null;
function scheduleCharacterToggleGhostSync() {
    window.requestAnimationFrame(syncCharacterToggleGhostRect);
    if (characterToggleGhostObserver) return;
    const observer = new ResizeObserver(syncCharacterToggleGhostRect);
    const attach = () => {
        const proxyButton = document.getElementById('sb-character-toggle');
        if (!proxyButton) return false;
        observer.observe(proxyButton);
        characterToggleGhostObserver = observer;
        return true;
    };
    if (!attach()) {
        const intervalId = window.setInterval(() => {
            if (attach()) window.clearInterval(intervalId);
        }, 250);
        window.setTimeout(() => window.clearInterval(intervalId), 5000);
    }
}
window.addEventListener('resize', syncCharacterToggleGhostRect, { passive: true });
window.addEventListener('resize', queueTopbarBrandFit, { passive: true });
window.matchMedia(NN_MOBILE_MEDIA_QUERY).addEventListener('change', () => {
    // Crossing the breakpoint can change which device's icons-only setting is in force, so the
    // whole preference re-applies rather than just the group order.
    applyTopbarIconsOnlyPreference();
    updateThemePickerUi();
    updateTopBarBrand();
    // Crossing the breakpoint also decides which rail third-party composer buttons belong in.
    queueComposerControlPlacement();
    // ...and where the character library's Create/Import buttons live.
    ensureCharacterListToolbarLayout();
});

document.addEventListener('click', (e) => {
    if (characterToggleDispatchGuard) return;
    const nativeToggle = getCharacterDrawerHost()?.querySelector(':scope > .drawer-toggle');
    if (!(nativeToggle instanceof HTMLElement)) return;
    if (!nativeToggle.contains(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
    characterToggleSkipExtensionIntercept = true;
    toggleCharacterPanel();
    characterToggleSkipExtensionIntercept = false;
}, true);

function toggleCharacterPanel({ preferredTab = null } = {}) {
    injectCharacterDrawerControls();
    ensureCharacterResizeHandle();

    if (isCharacterPanelOpen()) {
        closeCharacterPanel();
        return;
    }

    const normalizedPreferredTab = preferredTab ? normalizeCharacterPanelTab(preferredTab) : '';
    if (normalizedPreferredTab) {
        nnState.characterDrawer.lastTab = normalizedPreferredTab;
    }

    applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
        surface: nnMobileShellLifecycle.overlays.surface.CHARACTER_PANEL,
        isMobileViewport: isMobileViewport(),
    }));
    closeAllDropdowns({ except: 'characters', closeSurfaces: false });
    restoreLastCharacterPanelView();

    // iOS Safari clips position:fixed inside overflow:hidden ancestors.
    // Temporarily allow overflow on the parent so the panel renders.
    setCharacterDrawerHostOverflow(true);

    // Neconyan: dispatch a cancelable click on the native Characters toggle to give
    // extensions like CharacterLibrary a chance to intercept. If they preventDefault(),
    // they handle the UI themselves and we yield. Otherwise, we proceed with shell's
    // normal open flow (Sillyanonymous/SillyTavern-CharacterLibrary#28).
    if (characterToggleSkipExtensionIntercept) {
        characterToggleSkipExtensionIntercept = false;
    } else {
        syncCharacterToggleGhostRect();
        const nativeToggle = getCharacterDrawerHost()?.querySelector(':scope > .drawer-toggle');
        if (nativeToggle instanceof HTMLElement) {
            const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            characterToggleDispatchGuard = true;
            nativeToggle.dispatchEvent(clickEvent);
            characterToggleDispatchGuard = false;
            if (clickEvent.defaultPrevented) {
                setCharacterDrawerHostOverflow(false);
                return;
            }
        }
    }

    // No extension intercepted — proceed with shell's normal open flow.
    // Neconyan: open the character drawer directly via forceDrawerState instead of
    // synthetic-clicking the hidden native toggle. The old approach triggered handlers
    // anchored to the hidden toggle's zero-size bounding rect, breaking extensions that
    // anchor dropdowns/popups to native toggle positions (e.g. CharacterLibrary).
    forceDrawerState('right-nav-panel', true, '#rightNavDrawerIcon');
    syncMobileShellDrawerBounds();
    queueMobileShellDrawerBoundsSync();

    window.requestAnimationFrame(() => {
        if (!isCharacterPanelOpen()) {
            forceDrawerState('right-nav-panel', true, '#rightNavDrawerIcon');
        }

        restoreLastCharacterPanelView();

        syncChatbarVisibilityState();
        syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        syncDesktopShellSizing();
        queueMobileModalStateSync();
    });
}

function closeAllDropdowns({ except = '', closeSurfaces = true } = {}) {
    if (closeSurfaces) {
        const exemptSurface = getMobileShellSurfaceForShell(except);

        if (exemptSurface) {
            applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
                surface: exemptSurface,
                isMobileViewport: isMobileViewport(),
            }));
        } else {
            applyMobileSurfaceExclusivity({
                closeSurfaces: nnMobileShellLifecycle.overlays.closeAllSurfaces,
            });
        }
    }

    if (except !== 'search') setUniversalSearchOpenState(false);

    // Close persona picker
    document.getElementById('sb-persona-picker')?.remove();
}

function toggleShellPanel(shellKey, tabId = null) {
    if (shellKey === 'characters') {
        if (isCharacterPanelTabOpen(tabId)) {
            closeCharacterPanel();
            return;
        }

        openCharacterPanelTab(tabId);
        return;
    }

    if (shellKey === 'left' && tabId === 'world-info') {
        // Neconyan: final guard for old code paths that still ask for the
        // removed left-shell World Info route.
        openCharacterPanelTab('world-info');
        return;
    }

    if (!ensureShellReady(shellKey)) {
        return;
    }

    preloadPanelStylesheets(shellKey, tabId);

    if (tabId ? isShellTabOpen(shellKey, tabId) : isShellOpen(shellKey)) {
        if (wasShellJustOpened(shellKey)) {
            return;
        }

        closeShell(shellKey);
        return;
    }

    rememberShellFocusOrigin(shellKey);
    const shellSurface = getMobileShellSurfaceForShell(shellKey);
    if (shellSurface) {
        applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: shellSurface,
            isMobileViewport: isMobileViewport(),
        }));
        closeAllDropdowns({ except: shellKey, closeSurfaces: false });
    } else {
        closeAllDropdowns({ except: shellKey });
    }
    window.requestAnimationFrame(() => openShell(shellKey, tabId));
}

function preloadPanelStylesheets(shellKey, tabId = null) {
    // Neconyan: old saved/configured left-shell World Info routes should only
    // preload assets for the relocated Characters tab, never recreate a left tab.
    const normalizedTabId = shellKey === 'left' && tabId === 'world-info' ? 'world-info' : tabId;
    const normalizedShellKey = shellKey === 'left' && tabId === 'world-info' ? 'characters' : shellKey;
    const key = `${shellKey}:${tabId || ''}`;
    const normalizedKey = `${normalizedShellKey}:${normalizedTabId || ''}`;
    const stylesheets = NN_PANEL_STYLESHEETS[normalizedKey] ?? NN_PANEL_STYLESHEETS[key];

    if (!stylesheets || !window.NeconyanAssets?.loadStylesheetAsync) {
        return;
    }

    for (const stylesheet of stylesheets) {
        window.NeconyanAssets.loadStylesheetAsync(stylesheet.href, { id: stylesheet.id }).catch(error => {
            console.warn('Failed to load panel stylesheet:', stylesheet.href, error);
        });
    }
}

function isLandingPageVisible() {
    const panel = document.querySelector('.welcomePanel');
    // Body class watchers call this often; checkVisibility needs up-to-date styles
    // but, unlike getClientRects, does not also force a layout pass.
    return typeof panel?.checkVisibility === 'function'
        ? panel.checkVisibility()
        : isActuallyVisible(panel);
}

function syncHomeButtonState() {
    syncNeconyanRailSelection();
    const homeButton = document.getElementById('sb-home-toggle');
    if (!(homeButton instanceof HTMLButtonElement)) {
        return;
    }

    const isHomeVisible = isLandingPageVisible();
    setButtonPressed(homeButton, isHomeVisible);
    homeButton.classList.toggle('is-current', isHomeVisible);

    if (isHomeVisible) {
        homeButton.setAttribute('aria-current', 'page');
    } else {
        homeButton.removeAttribute('aria-current');
    }
}

function queueLandingPageStateSync() {
    if (nnState.landingPageSyncFrame) {
        return;
    }

    nnState.landingPageSyncFrame = window.requestAnimationFrame(() => {
        nnState.landingPageSyncFrame = 0;
        syncHomeButtonState();
    });
}

function bindLandingPageObserver() {
    nnState.landingPageObserver?.disconnect();

    const observer = new MutationObserver(records => {
        if (hasChangedAttributeValue(records)) {
            queueLandingPageStateSync();
        }
    });

    observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
        attributeOldValue: true,
    });

    nnState.landingPageObserver = observer;
    queueLandingPageStateSync();
}

async function returnToLandingPage() {
    if (hasChatNavigationDraft(getActualNeconyanMode())) {
        toastr.warning('Send or clear the current draft before switching chats.');
        return;
    }
    if (isNeconyanModeBusy()) {
        toastr.warning('Finish the current reply or save before switching chats.');
        return;
    }
    if (!await flushPendingChatSavesForNavigation()) return;
    const sync = await import('./neconyan-conversation/store-sync.js');
    if (!await sync.waitForConversationEdits(getCurrentUserHandle())) return;
    setUniversalSearchOpenState(false);
    closeShell('left');
    closeShell('right');
    closeCharacterPanelUnlessPinned();
    closeMobileNav();
    closeMobileChatTools();
    setConnectionStripOpenState(false);

    if (isLandingPageVisible()) {
        queueLandingPageStateSync();
        document.getElementById('neconyan-home-host')?.scrollTo({
            top: 0,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
        window.dispatchEvent(new CustomEvent('neconyan:navigate-home'));
        return;
    }

    const welcomeScreen = await import('./welcome-screen.js');
    await welcomeScreen.openWelcomeScreen({ force: true });
    queueLandingPageStateSync();
    window.dispatchEvent(new CustomEvent('neconyan:navigate-home'));
}

function syncProxyButtonState(proxyButton, sourceIcon) {
    if (!(proxyButton instanceof HTMLElement) || !(sourceIcon instanceof HTMLElement)) {
        return;
    }

    const isOpen = sourceIcon.classList.contains('openIcon');
    const isPinned = sourceIcon.classList.contains('drawerPinnedOpen');
    const isCharacterButton = proxyButton.id === 'sb-character-toggle';

    if (isCharacterButton && isTopbarIconsOnlyActive()) {
        const isCurrent = isCharacterPanelTabOpen(NN_CHARACTER_PANEL_DEFAULT_TAB);
        proxyButton.classList.remove('is-open', 'is-pinned');
        proxyButton.classList.toggle('is-current', isCurrent);
        proxyButton.setAttribute('aria-expanded', String(isCurrent));

        if (isCurrent) {
            proxyButton.setAttribute('aria-current', 'page');
        } else {
            proxyButton.removeAttribute('aria-current');
        }
        return;
    }

    proxyButton.classList.toggle('is-open', isOpen);
    proxyButton.classList.toggle('is-pinned', isPinned);
    proxyButton.setAttribute('aria-expanded', String(isOpen));

    if (isCharacterButton) {
        proxyButton.classList.remove('is-current');
        proxyButton.removeAttribute('aria-current');
    }
}

function syncCharacterTopbarButtonState() {
    syncProxyButtonState(
        document.getElementById('sb-character-toggle'),
        document.querySelector('#rightNavDrawerIcon'),
    );
}

function observeProxyButton(buttonId, iconSelector) {
    const proxyButton = document.getElementById(buttonId);
    const sourceIcon = document.querySelector(iconSelector);

    if (!(proxyButton instanceof HTMLElement) || !(sourceIcon instanceof HTMLElement)) {
        return;
    }

    syncProxyButtonState(proxyButton, sourceIcon);

    const observer = new MutationObserver(() => {
        syncProxyButtonState(proxyButton, sourceIcon);
        if (isTopbarIconsOnlyActive()) {
            queueTopbarPageStateSync();
        }
    });

    observer.observe(sourceIcon, { attributes: true, attributeFilter: ['class'] });
}

function activateCharacterTopbarButton() {
    if (isTopbarIconsOnlyActive()) {
        openCharacterPanelTab(NN_CHARACTER_PANEL_DEFAULT_TAB);
        return;
    }

    toggleCharacterPanel();
}

function wasShellJustOpened(shellKey) {
    const shellState = getShellState(shellKey);
    if (!shellState) {
        return false;
    }

    return (performance.now() - Number(shellState.lastOpenedAt || 0)) < NN_SHELL_TOGGLE_GUARD_MS;
}

function buildUniversalSearchRow() {
    const row = createElement('div', { id: 'sb-topbar-search-row' });
    const search = createElement('div', { id: 'sb-universal-search', className: 'sb-universal-search' });
    const field = createElement('label', { className: 'sb-universal-search-field' });
    const searchIcon = createElement('i', {
        className: 'fa-solid fa-magnifying-glass',
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const searchInput = createElement('input', {
        className: 'text_pole',
        attrs: {
            id: 'sb-universal-search-input',
            type: 'search',
            placeholder: NN_UNIVERSAL_SEARCH_PLACEHOLDER,
            'aria-label': NN_UNIVERSAL_SEARCH_PLACEHOLDER,
            autocomplete: 'off',
            enterkeyhint: 'search',
            spellcheck: 'false',
            role: 'combobox',
            'aria-expanded': 'false',
            'aria-controls': 'sb-universal-search-results',
        },
    });
    const panel = createElement('div', { className: 'sb-universal-search-panel' });
    const searchResults = createElement('div', {
        id: 'sb-universal-search-results',
        className: 'sb-search-results',
        attrs: {
            role: 'listbox',
            'aria-label': 'Universal search results',
        },
    });

    field.append(searchIcon, searchInput);
    panel.appendChild(searchResults);
    search.append(field, panel);
    row.appendChild(search);

    row.setAttribute('aria-hidden', 'true');
    search.setAttribute('aria-expanded', 'false');
    searchInput.tabIndex = -1;

    nnState.universalSearch.row = row;
    nnState.universalSearch.root = search;
    nnState.universalSearch.input = searchInput;
    nnState.universalSearch.results = searchResults;
    nnState.universalSearch.expanded = false;

    stopProxyPointerPropagation(search);

    field.addEventListener('click', () => {
        setUniversalSearchOpenState(true, { focusInput: true });
    });

    searchInput.addEventListener('focus', () => {
        setUniversalSearchOpenState(true);
    });

    searchInput.addEventListener('input', () => {
        setUniversalSearchOpenState(true);
    });

    searchInput.addEventListener('keydown', event => {
        const resultButtons = Array.from(searchResults.querySelectorAll('.sb-search-result'));

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!resultButtons.length) {
                return;
            }

            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const nextIndex = (nnState.universalSearch.activeIndex + direction + resultButtons.length) % resultButtons.length;
            setUniversalSearchActiveIndex(nextIndex);
            return;
        }

        if (event.key === 'Enter') {
            const firstMatch = resultButtons[nnState.universalSearch.activeIndex] ?? resultButtons[0];
            if (firstMatch instanceof HTMLButtonElement) {
                event.preventDefault();
                firstMatch.click();
            }
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            clearUniversalSearch({ blur: true });
        }
    });

    if (!nnState.universalSearch.dismissBound) {
        document.addEventListener('click', event => {
            const searchState = getUniversalSearchState();

            if (!searchState.expanded || !(searchState.root instanceof HTMLElement)) {
                return;
            }

            const searchTrigger = event.target instanceof Element
                ? event.target.closest('[data-sb-universal-search-trigger="true"]')
                : null;
            if (searchTrigger instanceof HTMLElement) {
                return;
            }

            if (event.target instanceof Node && searchState.root.contains(event.target)) {
                return;
            }

            setUniversalSearchOpenState(false);
        });

        nnState.universalSearch.dismissBound = true;
    }

    return row;
}

function buildTopBar() {
    const topBar = document.getElementById('top-bar');
    if (!(topBar instanceof HTMLElement)) {
        return;
    }

    // Neconyan: preserve children injected by third-party extensions before wiping
    // the bar. They are adopted into the extension slot once the shell layout exists, so
    // extensions targeting #top-bar (e.g. CharacterLibrary in standalone mode) aren't orphaned.
    const preservedExtensionChildren = Array.from(topBar.children)
        .filter(child => child instanceof HTMLElement && !isNeconyanOwnedElement(child));

    topBar.replaceChildren();

    const stack = createElement('div', { id: 'sb-topbar-stack' });
    const primaryRow = createElement('div', { id: 'sb-topbar-primary' });
    const searchRow = buildUniversalSearchRow();
    const topBarInner = createElement('div', { id: 'sb-topbar-inner' });
    const leftGroup = createElement('div', { className: 'sb-topbar-group sb-topbar-group-left' });
    const centerGroup = createElement('div', { className: 'sb-topbar-brand' });
    const rightGroup = createElement('div', { className: 'sb-topbar-group sb-topbar-group-right' });
    const clock = createElement('time', {
        id: 'sb-topbar-clock',
        className: 'sb-topbar-clock',
        attrs: { datetime: '', title: 'Current time' },
    });
    const extensionSlot = createElement('div', {
        id: TOPBAR_EXTENSION_SLOT_ID,
        attrs: { 'data-sb-topbar-slot-empty': 'true' },
    });

    const mobileButton = createElement('button', {
        id: 'sb-hamburger',
        className: 'sb-proxy-button sb-mobile-toggle',
        attrs: {
            type: 'button',
            title: 'Open navigation',
            'aria-label': 'Open navigation',
            'aria-expanded': 'false',
        },
    });
    const closedIcon = document.body?.classList.contains('neconyan')
        ? NN_NECONYAN_MOBILE_NAV_CLOSED_ICON
        : NN_MOBILE_NAV_CLOSED_ICON;
    mobileButton.innerHTML = `<i class="fa-solid ${closedIcon}" aria-hidden="true"></i>`;
    stopProxyPointerPropagation(mobileButton);
    mobileButton.addEventListener('click', toggleMobileNav);

    const leftButton = createProxyButton(
        {
            id: 'sb-left-shell-toggle',
            icon: getShellConfig('left').proxyIcon,
            label: getShellConfig('left').proxyLabel,
            title: 'Open connections',
        },
        () => toggleShellPanel('left'),
    );

    const homeButton = createProxyButton(
        {
            id: 'sb-home-toggle',
            icon: 'fa-house',
            label: 'Home',
            title: 'Return to the landing page',
        },
        () => {
            closeMobileNav();
            void returnToLandingPage();
        },
    );

    const rightButton = createProxyButton(
        {
            id: 'sb-right-shell-toggle',
            icon: getShellConfig('right').proxyIcon,
            label: getShellConfig('right').proxyLabel,
            title: 'Open settings',
        },
        () => toggleShellPanel('right'),
    );

    const charactersButton = createProxyButton(
        {
            id: 'sb-character-toggle',
            icon: 'fa-address-card',
            label: 'Characters',
            title: 'Open character management',
        },
        activateCharacterTopbarButton,
    );

    const editCardButton = createProxyButton(
        {
            id: 'sb-topbar-edit-card',
            icon: 'fa-pen-to-square',
            label: 'Edit card',
            title: 'Edit this character card',
        },
        () => {
            if (!hasActiveCharacterChat()) {
                globalThis.toastr?.info?.('Open a character chat before editing a card.', 'Edit card');
                return;
            }
            openCharacterPanelTab('editor');
            void openCharacterEditorTab();
        },
    );
    editCardButton.hidden = true;

    const leftShortcutConfig = getShortcutConfig(getShortcutTarget('left'));
    const leftShortcut = createProxyButton(
        {
            id: 'sb-shortcut-left',
            icon: leftShortcutConfig.icon,
            label: leftShortcutConfig.label,
            title: t`Quick access: ${translate(leftShortcutConfig.label)}`,
            className: 'sb-proxy-button-icon-only',
        },
        () => activateShortcutTarget(getShortcutTarget('left')),
    );
    bindSearchShortcutPreFocus(leftShortcut, () => getShortcutTarget('left'));

    const rightShortcutConfig = getShortcutConfig(getShortcutTarget('right'));
    const rightShortcut = createProxyButton(
        {
            id: 'sb-shortcut-right',
            icon: rightShortcutConfig.icon,
            label: rightShortcutConfig.label,
            title: t`Quick access: ${translate(rightShortcutConfig.label)}`,
            className: 'sb-proxy-button-icon-only',
        },
        () => activateShortcutTarget(getShortcutTarget('right')),
    );
    bindSearchShortcutPreFocus(rightShortcut, () => getShortcutTarget('right'));

    const desktopShortcutButtons = {};
    for (const side of NN_SHORTCUT_DESKTOP_SLOTS) {
        const shortcutConfig = getShortcutConfig(getShortcutTarget(side));
        const shortcut = createProxyButton(
            {
                id: getShortcutButtonId(side),
                icon: shortcutConfig.icon,
                label: shortcutConfig.label,
                title: t`Quick access: ${translate(shortcutConfig.label)}`,
                className: 'sb-proxy-button-icon-only sb-desktop-setting',
            },
            () => activateShortcutTarget(getShortcutTarget(side)),
        );
        bindSearchShortcutPreFocus(shortcut, () => getShortcutTarget(side));
        desktopShortcutButtons[side] = shortcut;
    }

    centerGroup.innerHTML = `
        <div id="sb-topbar-title" class="sb-brand-title" role="button" tabindex="0" aria-label="Tap to switch the top bar label">${NN_IDLE_BRAND_LABEL}</div>
    `;

    // Neconyan: each cluster rail is built beside the Layer 2 anchor it belongs to and stays
    // display:none until icons-only mode is on, so one static child order serves both modes and the
    // button sequence never shifts when the option is toggled. Search gets no dedicated button: it
    // rides a Quick Access slot here exactly as it does with the option off.
    const [workspaceCluster, customizeCluster, charactersCluster] = NN_TOPBAR_CLUSTERS;
    const workspaceRail = buildTopbarPageRail(workspaceCluster.railId, workspaceCluster.pages);
    const customizeRail = buildTopbarPageRail(customizeCluster.railId, customizeCluster.pages);
    const charactersRail = buildTopbarPageRail(charactersCluster.railId, charactersCluster.pages);
    const desktopQuickActions = createElement('div', {
        id: 'sb-topbar-quick-actions',
        className: 'sb-topbar-quick-actions',
        attrs: { role: 'group', 'aria-label': 'Custom Quick Actions' },
    });
    const customizeDivider = createTopbarClusterDivider('sb-topbar-divider-customize');
    const homeDivider = createTopbarClusterDivider('sb-topbar-divider-home');
    const charactersDivider = createTopbarClusterDivider('sb-topbar-divider-characters');

    leftGroup.append(mobileButton, clock, leftButton, workspaceRail, customizeDivider, rightButton, customizeRail, leftShortcut, desktopShortcutButtons.slot3, desktopShortcutButtons.slot4);
    rightGroup.append(extensionSlot, desktopQuickActions, desktopShortcutButtons.slot6, desktopShortcutButtons.slot5, editCardButton, rightShortcut, homeButton, homeDivider, charactersDivider, charactersButton, charactersRail);
    topBarInner.append(leftGroup, centerGroup, rightGroup);
    primaryRow.appendChild(topBarInner);

    stack.append(primaryRow, searchRow);
    topBar.append(stack);
    adoptTopbarExtensionNodes(preservedExtensionChildren);

    // The anchor that leads a cluster carries the wider seam that separates the clusters.
    for (const cluster of NN_TOPBAR_CLUSTERS) {
        document.getElementById(cluster.leadId)?.classList.add('sb-topbar-cluster-lead');
    }

    startNeconyanTopbarClock();
    bindNeconyanTopbarStateEvents();
    ensureNeconyanRailDrawerBindings();

    observeProxyButton('sb-left-shell-toggle', getShellConfig('left').hostIconSelector);
    observeProxyButton('sb-right-shell-toggle', getShellConfig('right').hostIconSelector);
    observeProxyButton('sb-character-toggle', '#rightNavDrawerIcon');
    bindTopbarExtensionAdoption();
    bindTopBarBrand();
    updateTopBarBrand();
    updateTopbarUtilityButtons();
    updateShortcutButton('left');
    updateShortcutButton('right');
    updateShortcutButton('slot3');
    updateShortcutButton('slot4');
    updateShortcutButton('slot5');
    updateShortcutButton('slot6');
    refreshDesktopTopbarQuickActions();
    syncTopbarLayoutState();
    queueLandingPageStateSync();
    scheduleCharacterToggleGhostSync();
    queueTopbarPageStateSync();
}

function hideHostToggles() {
    for (const shellConfig of Object.values(NN_SHELLS)) {
        const hostDrawer = document.getElementById(shellConfig.hostDrawerId);
        const hostToggle = hostDrawer?.querySelector(':scope > .drawer-toggle');

        hostDrawer?.classList.add('sb-drawer-host');
        hostToggle?.classList.add('sb-hidden-toggle');
    }

    // Neconyan: use sb-ghost-toggle (not sb-hidden-toggle) so the native Characters toggle
    // retains a real bounding rect. Extensions like CharacterLibrary anchor dropdowns to this
    // toggle's or its icon child's getBoundingClientRect(); display:none produces a zero rect
    // and sends their dropdowns off-screen (Sillyanonymous/SillyTavern-CharacterLibrary#28).
    const characterDrawer = getCharacterDrawerHost();
    characterDrawer?.classList.add('sb-drawer-host');
    const characterToggle = characterDrawer?.querySelector(':scope > .drawer-toggle');
    characterToggle?.classList.add('sb-ghost-toggle');
    // Apply critical hiding via inline styles to avoid !important budget inflation
    if (characterToggle instanceof HTMLElement) {
        characterToggle.style.visibility = 'hidden';
        characterToggle.style.pointerEvents = 'none';
    }

    // Neconyan: World Info is no longer a left/top-level drawer, but keeping
    // the upstream drawer ID preserves legacy selectors until runtime reparents it.
    const worldInfoDrawer = document.getElementById('WI-SP-button');
    worldInfoDrawer?.classList.add('sb-drawer-host');
    worldInfoDrawer?.querySelector(':scope > .drawer-toggle')?.classList.add('sb-hidden-toggle');
}

function getTopbarExtensionSlot() {
    const slot = document.getElementById(TOPBAR_EXTENSION_SLOT_ID);

    return slot instanceof HTMLElement ? slot : null;
}

function getNativeCharacterDrawerIcon() {
    const icon = getCharacterDrawerHost()?.querySelector(':scope #rightNavDrawerIcon')
        ?? document.getElementById('rightNavDrawerIcon');

    return icon instanceof HTMLElement ? icon : null;
}

/**
 * Describes a DOM node for the pure adoption rules. Keeping the DOM reads here lets the
 * decision logic in topbar-extension-slot/index.js stay importable and unit testable.
 */
function describeTopbarNode(node, index) {
    const isElement = node instanceof Element;

    return {
        node,
        key: isElement && node.id ? `id:${node.id}` : `index:${index}`,
        isElement,
        id: isElement ? node.id : '',
        tagName: isElement ? node.tagName : '',
        classNames: isElement ? Array.from(node.classList) : [],
        adoptAttribute: isElement ? node.getAttribute(TOPBAR_ADOPTION_ATTRIBUTE) : null,
        isNeconyanOwned: isNeconyanOwnedElement(node),
    };
}

function describeCharacterBadge(node, index) {
    const descriptor = describeTopbarNode(node, index);

    return {
        ...descriptor,
        key: `badge:${index}`,
        signature: `${descriptor.tagName}:${descriptor.classNames.join(' ')}`,
    };
}

/**
 * Mirrors extension badges from the ghosted native Characters icon onto the visible proxy
 * button. CharacterLibrary appends its chevron to #rightNavDrawerIcon, which lives inside
 * .sb-ghost-toggle and is therefore invisible, so the affordance never reaches the user.
 * The badges are moved rather than copied: the extension flips visibility through a global
 * document.querySelector, which only ever reaches the first copy.
 */
function syncCharacterToggleBadges() {
    const drawerIcon = getNativeCharacterDrawerIcon();
    const legacyButton = document.getElementById('sb-character-toggle');
    const proxyButton = document.querySelector('#neconyan-workspace-rail [data-neconyan-route="characters"]') ?? legacyButton;

    if (!(drawerIcon instanceof HTMLElement) || !(proxyButton instanceof HTMLElement)) {
        return;
    }

    const iconNodes = [...(legacyButton && legacyButton !== proxyButton
        ? legacyButton.querySelectorAll(`:scope > [${TOPBAR_ADOPTED_MARKER_ATTRIBUTE}='true']`) : []), ...drawerIcon.children];
    const hostNodes = Array.from(proxyButton.querySelectorAll(`:scope > [${TOPBAR_ADOPTED_MARKER_ATTRIBUTE}='true']`));
    const iconBadges = iconNodes.map((node, index) => describeCharacterBadge(node, index));
    const hostBadges = hostNodes.map((node, index) => describeCharacterBadge(node, `host-${index}`));
    const plan = resolveCharacterBadgeMirrorPlan({ iconBadges, hostBadges });
    const byKey = new Map([...iconBadges, ...hostBadges].map(badge => [badge.key, badge.node]));

    for (const key of plan.removeKeys) {
        byKey.get(key)?.remove();
    }

    for (const key of plan.moveKeys) {
        const badge = byKey.get(key);

        if (badge instanceof HTMLElement) {
            badge.setAttribute(TOPBAR_ADOPTED_MARKER_ATTRIBUTE, 'true');
            proxyButton.appendChild(badge);
        }
    }

    proxyButton.classList.toggle(
        'sb-has-adopted-badge',
        proxyButton.querySelector(`:scope > [${TOPBAR_ADOPTED_MARKER_ATTRIBUTE}='true']`) !== null,
    );
    if (legacyButton !== proxyButton) legacyButton?.classList.remove('sb-has-adopted-badge');
}

function syncTopbarExtensionSlotEmptyState() {
    const slot = getTopbarExtensionSlot();

    if (!slot) {
        return;
    }

    slot.dataset.sbTopbarSlotEmpty = String(slot.children.length === 0);
}

/**
 * Moves third-party top-bar controls into the shell's own bar. Upstream's bare
 * `.drawer { width: 100% }` plus this fork's fixed, click-through #top-settings-holder means an
 * injected button otherwise stretches across the whole strip and eats every click meant for the
 * bar underneath it (Sillyanonymous/SillyTavern-CharacterLibrary).
 */
function adoptTopbarExtensionNodes(extraNodes = []) {
    const slot = getTopbarExtensionSlot();

    if (!slot || nnState.topbarExtensions.adopting) {
        return;
    }

    nnState.topbarExtensions.adopting = true;

    try {
        const candidates = [...extraNodes];

        for (const source of [getCanonicalTopSettingsHolder(), document.getElementById('top-bar')]) {
            if (source instanceof HTMLElement) {
                candidates.push(...source.children);
            }
        }

        const descriptors = candidates.map((node, index) => describeTopbarNode(node, index));
        // Only id-bearing slot children can be matched by key; id-less descriptors fall back to a
        // per-pass index, which would collide across the two lists. Those are covered by the
        // parentElement check below instead.
        const slotChildKeys = Array.from(slot.children)
            .filter(node => node instanceof Element && node.id)
            .map(node => `id:${node.id}`);
        const plan = resolveTopbarAdoptionPlan({ nodes: descriptors, slotChildKeys });
        const byKey = new Map(descriptors.map(descriptor => [descriptor.key, descriptor.node]));

        for (const key of plan.adoptKeys) {
            const node = byKey.get(key);

            // The parent check -- not a "already in place" helper -- is what terminates repeated
            // passes: appendChild on a node the slot already holds still mutates childList.
            if (node instanceof HTMLElement && node.parentElement !== slot) {
                slot.appendChild(node);
            }
        }

        syncCharacterToggleBadges();
        syncTopbarExtensionSlotEmptyState();
    } finally {
        nnState.topbarExtensions.adopting = false;
        // Drop the records our own moves just produced before they reach the callback.
        nnState.topbarExtensions.observer?.takeRecords();
    }

    queueTopbarBrandFit();
}

function queueTopbarExtensionAdoption() {
    if (nnState.topbarExtensions.syncFrame) {
        return;
    }

    nnState.topbarExtensions.syncFrame = window.requestAnimationFrame(() => {
        nnState.topbarExtensions.syncFrame = 0;
        adoptTopbarExtensionNodes();
    });
}

function bindTopbarExtensionAdoption() {
    if (!getTopbarExtensionSlot()) {
        return;
    }

    window.addEventListener('neconyan:rail-ready', bindTopbarExtensionAdoption);

    if (!(nnState.topbarExtensions.observer instanceof MutationObserver)) {
        nnState.topbarExtensions.observer = new MutationObserver(() => queueTopbarExtensionAdoption());
    }

    const observer = nnState.topbarExtensions.observer;

    observer.disconnect();

    // childList only: extensions inject direct children, and subtree on #top-bar would fire on
    // every chatbar and search re-render inside #sb-topbar-stack. The slot itself is watched so a
    // control that removes itself flips the empty flag back and the slot stops holding a gap.
    for (const target of [getCanonicalTopSettingsHolder(), document.getElementById('top-bar'), getNativeCharacterDrawerIcon(), getTopbarExtensionSlot(), document.querySelector('#neconyan-workspace-rail [data-neconyan-route="characters"]')]) {
        if (target instanceof HTMLElement) {
            observer.observe(target, { childList: true });
        }
    }

    queueTopbarExtensionAdoption();
}

function createShellPanel(tabConfig) {
    const panel = createElement('section', {
        className: 'sb-shell-panel',
        attrs: {
            role: 'tabpanel',
            'data-sb-panel': tabConfig.id,
            'aria-hidden': 'true',
        },
    });

    const scroller = createElement('div', { className: 'sb-shell-panel-scroller' });
    panel.appendChild(scroller);

    return { panel, scroller };
}

function closeFocusedShell() {
    const activeElement = document.activeElement;

    if (!(activeElement instanceof HTMLElement)) {
        return false;
    }

    const shellRoot = activeElement.closest('.sb-shell-root.openDrawer');
    if (!(shellRoot instanceof HTMLElement)) {
        return false;
    }

    const shellKey = shellRoot.dataset.sbShellKey;
    if (!shellKey || !getShellState(shellKey)) {
        return false;
    }

    closeShell(shellKey);
    return true;
}

function moveChildrenIntoContainer(sourceElement, targetElement) {
    const nodes = Array.from(sourceElement.childNodes);

    for (const node of nodes) {
        targetElement.appendChild(node);
    }
}

function prepareEmbeddedDrawer(drawerId, root = document) {
    const drawer = root.querySelector?.(`#${CSS.escape(drawerId)}`) ?? document.getElementById(drawerId);
    if (!(drawer instanceof HTMLElement)) {
        return null;
    }

    const drawerToggle = drawer.querySelector(':scope > .drawer-toggle');
    const drawerContent = drawer.querySelector(':scope > .drawer-content');

    if (!(drawerContent instanceof HTMLElement)) {
        return null;
    }

    drawer.classList.add('sb-embedded-drawer');
    drawerToggle?.classList.add('sb-hidden-toggle');
    drawerContent.classList.remove('drawer-content');
    drawerContent.classList.remove('openDrawer', 'closedDrawer', 'fillLeft', 'fillRight', 'pinnedOpen');
    drawerContent.classList.add('sb-managed', 'sb-shell-embedded-content');

    // Clean up any persistent inline styles or state
    drawerContent.removeAttribute('style');
    drawer.style.display = '';
    drawer.style.visibility = '';
    drawer.style.opacity = '';

    if (drawerId === 'WI-SP-button') {
        drawer.querySelector('#WI_panel_pin_div')?.classList.add('sb-shell-hidden-control');
    }

    return { drawer, drawerContent };
}

const NN_SAMPLING_BACKENDS = Object.freeze([
    {
        id: 'openai',
        apiIds: ['openai'],
        title: 'Chat Completions',
        description: 'Uses the active Chat Completions provider and its provider-specific sampler support.',
        controls: [
            '#seed_openai',
            '#openai_logit_bias_preset',
            '#temp_openai',
            '#claude_disable_temperature',
            '#top_p_openai',
            '#claude_disable_top_p',
            '#repetition_penalty_openai',
            '#freq_pen_openai',
            '#pres_pen_openai',
            '#top_k_openai',
            '#min_p_openai',
            '#top_a_openai',
            '#typical_p_openai',
        ],
    },
    {
        id: 'textgenerationwebui',
        apiIds: ['textgenerationwebui'],
        title: 'Text Completions',
        description: 'Uses the selected Text Completions backend and sampler visibility rules.',
        controls: [
            '#seed_textgenerationwebui',
            '#n_textgenerationwebui',
            '#samplerResetButton',
            '#sampler_order_block_kcpp',
            '#sampler_order_block_lcpp',
            '#sampler_priority_block_ooba',
            '#sampler_priority_block_aphrodite',
            '#json_schema_block',
            '#banned_tokens_block_ooba',
            '#logit_bias_block_ooba',
            '#temp_textgenerationwebui',
            '#top_k_textgenerationwebui',
            '#top_p_textgenerationwebui',
            '#typical_p_textgenerationwebui',
            '#min_p_textgenerationwebui',
            '#top_a_textgenerationwebui',
            '#tfs_textgenerationwebui',
            '#epsilon_cutoff_textgenerationwebui',
            '#nsigma_textgenerationwebui',
            '#min_keep_textgenerationwebui',
            '#eta_cutoff_textgenerationwebui',
            '#rep_pen_textgenerationwebui',
            '#rep_pen_range_textgenerationwebui',
            '#rep_pen_slope_textgenerationwebui',
            '#rep_pen_decay_textgenerationwebui',
            '#encoder_rep_pen_textgenerationwebui',
            '#freq_pen_textgenerationwebui',
            '#presence_pen_textgenerationwebui',
            '#no_repeat_ngram_size_textgenerationwebui',
            '#skew_textgenerationwebui',
            '#min_length_textgenerationwebui',
            '#max_tokens_second_textgenerationwebui',
            '#adaptive_p_block',
            '#smoothingBlock',
            '#xtc_block',
            '#dryBlock',
            '#dynatemp_block_ooba',
            '#mirostat_block_ooba',
            '#beamSearchBlock',
            '#contrastiveSearchBlock',
            '#do_sample_textgenerationwebui',
            '#add_bos_token_textgenerationwebui',
            '#ignore_eos_token_textgenerationwebui',
            '#include_reasoning_textgenerationwebui',
            '#temperature_last_textgenerationwebui',
            '#speculative_ngram_textgenerationwebui',
            '#spaces_between_special_tokens_textgenerationwebui',
            '#cfg_block_ooba',
            '#grammar_block_ooba',
        ],
    },
    {
        id: 'kobold',
        apiIds: ['kobold', 'koboldhorde'],
        title: 'Kobold / Horde',
        description: 'Kobold Horde reuses Kobold sampler settings; Horde still requires a non-GUI preset.',
        controls: ['#temp', '#top_p', '#rep_pen'],
    },
    {
        id: 'novel',
        apiIds: ['novel'],
        title: 'NovelAI',
        description: 'Uses NovelAI preset sampling fields without changing the backend request format.',
        controls: [
            '#temp_novel',
            '#rep_pen_novel',
            '#rep_pen_size_novel',
            '#rep_pen_slope_novel',
            '#rep_pen_freq_novel',
            '#rep_pen_presence_novel',
            '#min_p_novel',
            '#tail_free_sampling_novel',
            '#top_p_novel',
            '#top_a_novel',
            '#top_k_novel',
            '#mirostat_tau_novel',
            '#mirostat_lr_novel',
            '#typical_p_novel',
            '#math1_temp_novel',
            '#math1_quad_novel',
            '#math1_quad_entropy_scale_novel',
            '#min_length_novel',
        ],
    },
]);

const NN_LARGE_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#seed_openai',
    '#openai_logit_bias_preset',
    '#samplerResetButton',
    '#n_textgenerationwebui',
    '#seed_textgenerationwebui',
    '#banned_tokens_block_ooba',
    '#logit_bias_block_ooba',
    '#json_schema_block',
    '#sampler_order_block_kcpp',
    '#sampler_order_block_lcpp',
    '#sampler_priority_block_ooba',
    '#sampler_priority_block_aphrodite',
]));

const NN_COMPACT_PRIORITY_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#samplerResetButton',
    '#n_textgenerationwebui',
    '#seed_textgenerationwebui',
    '#json_schema_block',
]));

const NN_WIDE_PRIORITY_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#sampler_order_block_kcpp',
    '#sampler_order_block_lcpp',
    '#sampler_priority_block_ooba',
    '#sampler_priority_block_aphrodite',
]));

const NN_AFTER_SAMPLER_CONTROLS = Object.freeze(new Set([
    '#sampler_order_block_kcpp',
    '#sampler_order_block_lcpp',
    '#sampler_priority_block_ooba',
    '#sampler_priority_block_aphrodite',
    '#json_schema_block',
]));

const NN_BOTTOM_PRIORITY_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#banned_tokens_block_ooba',
    '#logit_bias_block_ooba',
]));

const NN_MULTI_SAMPLING_CONTROLS = Object.freeze(new Set([
    '#adaptive_p_block',
    '#smoothingBlock',
    '#xtc_block',
    '#dryBlock',
    '#dynatemp_block_ooba',
    '#mirostat_block_ooba',
    '#beamSearchBlock',
    '#contrastiveSearchBlock',
]));

function getSamplingPriorityTier(selector) {
    if (NN_AFTER_SAMPLER_CONTROLS.has(selector)) {
        return 'after';
    }

    if (NN_BOTTOM_PRIORITY_SAMPLING_CONTROLS.has(selector)) {
        return 'bottom';
    }

    if (NN_LARGE_SAMPLING_CONTROLS.has(selector)) {
        return 'top';
    }

    return '';
}

function getSpecialTokenControlBlock() {
    const controls = [
        document.getElementById('ban_eos_token_textgenerationwebui')?.closest('.checkbox_label'),
        document.getElementById('skip_special_tokens_textgenerationwebui')?.closest('.checkbox_label'),
    ].filter(control => control instanceof HTMLElement);

    if (!controls.length) {
        return null;
    }

    const block = createElement('div', { className: 'sb-sampling-special-token-controls' });
    controls.forEach(control => block.appendChild(control));
    return block;
}

function getSamplerToolbarControlBlock() {
    const toolbar = getSamplingControlBlock('#samplerResetButton');
    if (!(toolbar instanceof HTMLElement)) {
        return null;
    }

    const block = createElement('div', { className: 'sb-sampling-sampler-tools-card' });
    block.appendChild(toolbar);

    const specialTokenControls = getSpecialTokenControlBlock();
    if (specialTokenControls) {
        block.appendChild(specialTokenControls);
    }

    return block;
}

function neutralizeChatCompletionSamplers() {
    const values = {
        '#temp_openai': 1,
        '#top_p_openai': 1,
        '#top_k_openai': 0,
        '#min_p_openai': 0,
        '#top_a_openai': 0,
        '#typical_p_openai': 1,
        '#repetition_penalty_openai': 1,
        '#freq_pen_openai': 0,
        '#pres_pen_openai': 0,
    };

    for (const [selector, value] of Object.entries(values)) {
        const input = document.querySelector(selector);
        if (input instanceof HTMLInputElement) {
            input.value = String(value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    ['#claude_disable_temperature', '#claude_disable_top_p'].forEach(selector => {
        const input = document.querySelector(selector);
        if (input instanceof HTMLInputElement) {
            input.checked = false;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}

function decorateSamplingControlCard(card, selector) {
    if (!(card instanceof HTMLElement)) {
        return;
    }

    if (selector === '#seed_textgenerationwebui') {
        const seedLabel = card.querySelector('label');
        seedLabel?.classList.add('range-block-title', 'justifyLeft', 'sb-sampling-seed-title');
        seedLabel?.insertAdjacentElement('afterend', createElement('small', {
            className: 'sb-sampling-card-help',
            text: 'Set to get deterministic results. Use -1 for a random seed.',
        }));
    }

    if (selector === '#seed_openai') {
        const row = createElement('small', { className: 'sb-chat-neutralize-row flex-container alignitemscenter' });
        const button = createElement('button', {
            className: 'menu_button menu_button_icon sb-neutralize-chat-samplers',
            text: 'Neutralize Samplers',
            attrs: { type: 'button' },
        });
        const info = createElement('div', {
            className: 'fa-solid fa-circle-info opacity50p',
            attrs: {
                title: 'Set all samplers to their neutral/disabled state.',
                'data-i18n': '[title]Set all samplers to their neutral/disabled state.',
            },
        });
        button.addEventListener('click', neutralizeChatCompletionSamplers);
        row.append(button, info);
        card.appendChild(row);
    }
}

function getSamplingControlBlock(selector) {
    const input = document.querySelector(selector);
    if (!(input instanceof HTMLElement)) {
        return null;
    }

    if (input.id === 'samplerResetButton' || input.id === 'samplerSelectButton') {
        return input.closest('.flex-container.justifyCenter') ?? input.parentElement;
    }

    return input.closest('.range-block')
        ?? input.closest('[data-tg-samplers]')
        ?? input.parentElement;
}

function buildSamplingControlCard(selector) {
    const controlBlock = selector === '#samplerResetButton'
        ? getSamplerToolbarControlBlock()
        : getSamplingControlBlock(selector);
    if (!(controlBlock instanceof HTMLElement)) {
        return null;
    }

    const isTextGenSampler = controlBlock.hasAttribute('data-tg-samplers') || controlBlock.querySelector('[data-tg-samplers]');
    const card = createElement('div', {
        className: [
            'sb-sampling-control-card',
            isTextGenSampler ? 'sb-sampling-textgen-card' : '',
            NN_LARGE_SAMPLING_CONTROLS.has(selector) ? 'sb-sampling-large-card' : '',
            NN_COMPACT_PRIORITY_SAMPLING_CONTROLS.has(selector) ? 'sb-sampling-compact-priority-card' : '',
            NN_WIDE_PRIORITY_SAMPLING_CONTROLS.has(selector) ? 'sb-sampling-wide-priority-card' : '',
            NN_MULTI_SAMPLING_CONTROLS.has(selector) ? 'sb-sampling-multi-card' : '',
            getSamplingPriorityTier(selector) ? `sb-sampling-priority-${getSamplingPriorityTier(selector)}` : '',
        ].filter(Boolean).join(' '),
    });
    card.dataset.sbSamplingControl = selector;
    for (const attributeName of ['data-source', 'data-source-mode']) {
        if (controlBlock.hasAttribute(attributeName)) {
            card.setAttribute(attributeName, controlBlock.getAttribute(attributeName));
        }
    }

    card.appendChild(controlBlock);
    decorateSamplingControlCard(card, selector);
    return card;
}

function drawerHasControls(drawer) {
    if (!(drawer instanceof HTMLElement)) {
        return false;
    }

    const content = drawer.querySelector('.inline-drawer-content');
    if (!(content instanceof HTMLElement)) {
        return false;
    }

    return Boolean(content.querySelector([
        '.range-block',
        '[data-tg-samplers]',
        'select',
        'textarea',
        'button',
        '.menu_button',
        'input:not([type="hidden"])',
    ].join(',')));
}

function hideEmptyGroupedSettingsDrawers() {
    document.querySelectorAll('#range_block_openai .sb-openai-settings-drawer, #textgenerationwebui_api-settings .sb-textgen-drawers > .inline-drawer').forEach(drawer => {
        if (!(drawer instanceof HTMLElement)) {
            return;
        }

        drawer.style.display = drawerHasControls(drawer) ? '' : 'none';
    });
}

function updateSamplingCardVisibility(section) {
    if (!(section instanceof HTMLElement)) {
        return;
    }

    section.querySelectorAll('[data-sb-sampling-control]').forEach(card => {
        if (!(card instanceof HTMLElement)) {
            return;
        }

        const hasVisibleContent = Array.from(card.children).some(child => child instanceof HTMLElement && getComputedStyle(child).display !== 'none');
        card.hidden = !hasVisibleContent;
    });

    section.querySelectorAll('.sb-sampling-priority-row').forEach(row => {
        if (!(row instanceof HTMLElement)) {
            return;
        }

        row.hidden = !Array.from(row.children).some(child => child instanceof HTMLElement && !child.hidden);
    });

    section.querySelectorAll('.sb-sampling-multi-grid').forEach(row => {
        if (!(row instanceof HTMLElement)) {
            return;
        }

        row.hidden = !Array.from(row.children).some(child => child instanceof HTMLElement && !child.hidden);
    });
}

function syncSamplingPanelControls(root) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    for (const backend of NN_SAMPLING_BACKENDS) {
        const section = root.querySelector(`#sb-sampling-${backend.id}`);
        const priorityRows = {
            top: section?.querySelector('.sb-sampling-priority-row[data-sb-priority-tier="top"]'),
            bottom: section?.querySelector('.sb-sampling-priority-row[data-sb-priority-tier="bottom"]'),
            after: section?.querySelector('.sb-sampling-after-row[data-sb-priority-tier="after"]'),
        };
        const grid = section?.querySelector('.sb-sampling-grid');
        const multiGrid = section?.querySelector('.sb-sampling-multi-grid');
        if (!Object.values(priorityRows).every(row => row instanceof HTMLElement) || !(grid instanceof HTMLElement) || !(multiGrid instanceof HTMLElement)) {
            continue;
        }

        section.querySelector('.sb-sampling-note')?.remove();

        for (const selector of backend.controls) {
            const tier = getSamplingPriorityTier(selector);
            const target = tier ? priorityRows[tier] : (NN_MULTI_SAMPLING_CONTROLS.has(selector) ? multiGrid : grid);
            const existingCard = Array.from(section.querySelectorAll('[data-sb-sampling-control]'))
                .find(card => card instanceof HTMLElement && card.dataset.sbSamplingControl === selector);
            if (existingCard instanceof HTMLElement && existingCard.children.length > 0) {
                if (existingCard.parentElement !== target) {
                    target.appendChild(existingCard);
                }
                continue;
            }

            existingCard?.remove();

            const card = buildSamplingControlCard(selector);
            if (card) {
                target.appendChild(card);
            }
        }

        if (!Object.values(priorityRows).some(row => row.children.length) && !grid.children.length && !multiGrid.children.length) {
            grid.appendChild(createElement('p', {
                className: 'sb-sampling-note',
                text: 'Sampler controls are not ready yet. Reopen the Model menu after settings finish loading.',
            }));
        }

        updateSamplingCardVisibility(section);
    }

    hideEmptyGroupedSettingsDrawers();
}

function updateSamplingPanelVisibility(root) {
    if (!(root instanceof HTMLElement)) {
        return;
    }

    syncSamplingPanelControls(root);

    const activeApi = getCurrentMainApiValue();
    let activeSection = null;

    for (const section of root.querySelectorAll('[data-sb-sampling-apis]')) {
        if (!(section instanceof HTMLElement)) {
            continue;
        }

        const apiIds = String(section.dataset.sbSamplingApis ?? '').split(',');
        const isActive = apiIds.includes(activeApi);
        section.hidden = !isActive;

        if (isActive) {
            activeSection = section;
        }
    }

    const empty = root.querySelector('#sb-sampling-empty');
    if (empty instanceof HTMLElement) {
        empty.hidden = Boolean(activeSection);
    }
}

function buildSamplingPanel() {
    const { panel, scroller } = createShellPanel({ id: 'sampling' });
    const column = createElement('div', { className: 'sb-shell-column sb-sampling-panel' });

    const sections = createElement('div', { className: 'sb-sampling-sections' });

    for (const backend of NN_SAMPLING_BACKENDS) {
        const section = createElement('section', {
            id: `sb-sampling-${backend.id}`,
            className: 'sb-sampling-section',
            attrs: {
                'data-sb-sampling-apis': backend.apiIds.join(','),
            },
        });
        const header = createElement('div', { className: 'sb-sampling-section-header' });
        const titleRow = createElement('div', { className: 'sb-sampling-title-row' });
        const title = createElement('strong', { text: 'Sampling Backend' });
        const mode = createElement('span', { className: 'sb-sampling-mode-pill', text: backend.title });
        const description = createElement('p', { text: `Active backend samplers are shown here. ${backend.description}` });
        const priorityStack = createElement('div', { className: 'sb-sampling-priority-stack' });
        const priorityTop = createElement('div', { className: 'sb-sampling-priority-row sb-sampling-priority-row-top', attrs: { 'data-sb-priority-tier': 'top' } });
        const priorityBottom = createElement('div', { className: 'sb-sampling-priority-row sb-sampling-priority-row-bottom', attrs: { 'data-sb-priority-tier': 'bottom' } });
        const grid = createElement('div', { className: 'sb-sampling-grid' });
        const multiGrid = createElement('div', { className: 'sb-sampling-multi-grid' });
        const afterRow = createElement('div', { className: 'sb-sampling-priority-row sb-sampling-after-row', attrs: { 'data-sb-priority-tier': 'after' } });

        titleRow.append(title, mode);
        header.append(titleRow, description);

        priorityStack.append(priorityTop, priorityBottom);
        section.append(header, priorityStack, grid, multiGrid, afterRow);
        sections.appendChild(section);
    }

    const empty = createElement('div', {
        id: 'sb-sampling-empty',
        className: 'sb-sampling-empty sb-shell-callout',
        html: '<strong>No unified samplers for this backend yet</strong><p>This POC currently supports Chat Completions, Text Completions, Kobold/Kobold Horde, and NovelAI.</p>',
    });

    column.append(sections, empty);
    scroller.appendChild(column);

    $('#main_api').on('change.sbSamplingPanel', () => updateSamplingPanelVisibility(column));
    window.requestAnimationFrame(() => updateSamplingPanelVisibility(column));
    window.setTimeout(() => updateSamplingPanelVisibility(column), 250);
    window.setTimeout(() => updateSamplingPanelVisibility(column), 1000);

    return {
        id: 'sampling',
        panel,
        button: null,
        searchRoot: column,
        onActivate: () => updateSamplingPanelVisibility(column),
    };
}

function buildInChatAgentsPanel() {
    const { panel, scroller } = createShellPanel({
        id: 'agents',
    });

    const column = createElement('div', { className: 'sb-shell-column' });
    const inChatAgentsContainer = createElement('div', { id: 'in_chat_agents_container' });

    column.append(inChatAgentsContainer);
    scroller.appendChild(column);

    return {
        id: 'agents',
        panel,
        button: null,
        searchRoot: column,
    };
}

function buildMewmoryPanel() {
    const { panel, scroller } = createShellPanel({ id: 'mewmory' });
    const root = createElement('section', { id: 'mewmory-workspace', className: 'sb-shell-column' });
    scroller.append(root);
    return {
        id: 'mewmory', panel, button: null, searchRoot: root,
        onActivate: () => {
            void import('./mewmory/ui.js').then(module => module.mountMewmory(root))
                .catch(error => { root.textContent = 'Mewmory could not open: ' + error.message; });
        },
    };
}

function getServerAdminState() {
    return nnState.serverAdmin;
}

function getServerAdminRefs() {
    return getServerAdminState().refs;
}

function getConsoleLogsState() {
    return nnState.consoleLogs;
}

function getConsoleLogsRefs() {
    return getConsoleLogsState().refs;
}

function isConsoleLogsTabActive() {
    return isShellTabOpen('right', 'console-logs');
}

function formatConsoleLogTime(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) {
        return '00:00:00';
    }

    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function formatConsoleLogDateTime(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) {
        return 'Unknown';
    }

    return date.toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function formatConsoleLogEntry(entry) {
    const stream = String(entry?.stream ?? 'stdout').toUpperCase().padEnd(6);
    const message = String(entry?.message ?? '');
    return `[${formatConsoleLogTime(entry?.timestamp)}] ${stream} ${message}`;
}

function isScrolledNearBottom(element, threshold = NN_CONSOLE_LOG_STICKY_THRESHOLD) {
    if (!(element instanceof HTMLElement)) {
        return true;
    }

    return (element.scrollHeight - element.scrollTop - element.clientHeight) <= threshold;
}

function updateConsoleLogsInteractivity() {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();

    if (!refs) {
        return;
    }

    refs.pauseButton.textContent = state.paused ? 'Resume Live' : 'Pause Live';
    refs.pauseButton.setAttribute('aria-pressed', String(state.paused));
    setButtonDisabled(refs.refreshButton, state.busy || state.paused);
    setButtonDisabled(refs.copyButton, state.entries.length === 0);
    setButtonDisabled(refs.verboseLoggingActionButton, state.busy || state.configBusy || !state.configLoaded);
    refs.output?.setAttribute('aria-busy', String(state.busy));
}

function setConsoleLogsVerboseLoggingUI(value) {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();
    const enabled = Number(value) === 0;

    state.verboseLoggingEnabled = enabled;

    if (refs?.verboseLoggingStatus instanceof HTMLElement) {
        refs.verboseLoggingStatus.textContent = enabled
            ? 'Verbose logging is enabled.'
            : 'Standard logging is enabled.';
        refs.verboseLoggingStatus.dataset.state = enabled ? 'warn' : 'neutral';
    }

    if (refs?.verboseLoggingActionButton instanceof HTMLButtonElement) {
        refs.verboseLoggingActionButton.textContent = enabled
            ? 'Debug Logging: Enabled'
            : 'Debug Logging: Disabled';
    }

    updateConsoleLogsInteractivity();
}

function getLoggingConfigTextFromYaml(content) {
    if (typeof content !== 'string' || !content.trim()) {
        return 1;
    }

    const match = content.match(/^\s*minLogLevel:\s*(\d+)\s*$/m);
    return match ? Number(match[1]) : 1;
}

function replaceLoggingMinLogLevel(content, nextLevel) {
    const desiredLevel = Number(nextLevel) === 0 ? 0 : 1;
    const minLogLevelPattern = /^(\s*minLogLevel:\s*)(\d+)\s*$/m;

    if (minLogLevelPattern.test(content)) {
        return content.replace(minLogLevelPattern, `$1${desiredLevel}`);
    }

    const loggingHeaderPattern = /^(logging:\s*\n)(?:\s*#.*\n)*?/m;
    if (loggingHeaderPattern.test(content)) {
        return content.replace(loggingHeaderPattern, (match) => `${match}  minLogLevel: ${desiredLevel}\n`);
    }

    return `${content.trimEnd()}\n\nlogging:\n  minLogLevel: ${desiredLevel}\n`;
}

async function refreshConsoleLogsConfig() {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();

    if (!refs) {
        return;
    }

    state.configBusy = true;
    updateConsoleLogsInteractivity();

    try {
        const data = await requestServerAdmin('/api/server-admin/config/get');
        const content = String(data?.content ?? '');
        const enabled = getLoggingConfigTextFromYaml(content) === 0;

        state.configLoaded = true;
        state.configPath = String(data?.path ?? '');
        state.configLastModifiedMs = Number(data?.lastModifiedMs ?? 0) || 0;
        setConsoleLogsVerboseLoggingUI(enabled ? 0 : 1);
    } catch (error) {
        state.configLoaded = false;
        state.verboseLoggingEnabled = false;
        if (refs?.verboseLoggingStatus instanceof HTMLElement) {
            refs.verboseLoggingStatus.textContent = error?.message || 'Failed to load config.yaml.';
            refs.verboseLoggingStatus.dataset.state = 'danger';
        }
        console.error('Failed to load logging config for Console Logs.', error);
    } finally {
        state.configBusy = false;
        updateConsoleLogsInteractivity();
    }
}

async function toggleConsoleLogsVerboseLogging() {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();

    if (!refs || !state.configLoaded || state.configBusy || state.busy) {
        return;
    }

    state.configBusy = true;
    updateConsoleLogsInteractivity();

    try {
        const data = await requestServerAdmin('/api/server-admin/config/get');
        const content = String(data?.content ?? '');
        const nextEnabled = !state.verboseLoggingEnabled;
        const nextContent = replaceLoggingMinLogLevel(content, nextEnabled ? 0 : 1);
        const result = await requestServerAdmin('/api/server-admin/config/save', {
            content: nextContent,
            expectedLastModifiedMs: Number(data?.lastModifiedMs ?? 0) || state.configLastModifiedMs,
            restart: false,
        });

        state.configPath = String(result?.path ?? state.configPath);
        state.configLastModifiedMs = Number(result?.lastModifiedMs ?? 0) || state.configLastModifiedMs;
        setConsoleLogsVerboseLoggingUI(nextEnabled ? 0 : 1);
        if (refs.verboseLoggingStatus instanceof HTMLElement) {
            refs.verboseLoggingStatus.textContent = result?.message || 'Logging config saved.';
            refs.verboseLoggingStatus.dataset.state = 'saved';
        }
        globalThis.toastr?.success?.('Logging config saved. Restart Neconyan to apply it.', 'Console logs');
    } catch (error) {
        console.error('Failed to save logging config for Console Logs.', error);
        if (refs?.verboseLoggingStatus instanceof HTMLElement) {
            refs.verboseLoggingStatus.textContent = error?.message || 'Failed to save logging config.';
            refs.verboseLoggingStatus.dataset.state = 'danger';
        }
        globalThis.toastr?.error?.(error?.message || 'Failed to save logging config.', 'Console logs');
    } finally {
        state.configBusy = false;
        updateConsoleLogsInteractivity();
    }
}

function renderConsoleLogsStatus() {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();

    if (!refs) {
        return;
    }

    if (state.busy) {
        setServerAdminPill(refs.statusPill, 'Loading…', 'neutral');
        setServerAdminMessage(refs.statusNote, state.entries.length
            ? 'Refreshing recent console output.'
            : 'Loading recent console output.', 'neutral');
        return;
    }

    if (state.lastError) {
        const retainedOutput = state.entries.length > 0 || state.lastUpdatedAt > 0;
        setServerAdminPill(refs.statusPill, retainedOutput ? 'Refresh failed' : 'Unavailable', 'danger');
        setServerAdminMessage(refs.statusNote, retainedOutput
            ? `Could not refresh the logs. Showing the previous ${state.entries.length} entries.`
            : state.lastError, 'danger');
        return;
    }

    if (!state.lastUpdatedAt) {
        setServerAdminPill(refs.statusPill, 'Ready', 'neutral');
        setServerAdminMessage(refs.statusNote, 'Open this tab to load recent console output.', 'neutral');
        return;
    }

    if (!state.entries.length) {
        setServerAdminPill(refs.statusPill, 'Empty', 'neutral');
        setServerAdminMessage(refs.statusNote, 'No console output has been captured yet for this server process.', 'neutral');
        return;
    }

    const linesShown = state.entries.length;
    const totalBuffered = state.totalBuffered || linesShown;
    const noteParts = [`Showing ${linesShown} of ${totalBuffered} recent console line${totalBuffered === 1 ? '' : 's'}.`];

    if (state.captureStartedAt) {
        noteParts.push(`Capture started ${formatConsoleLogDateTime(state.captureStartedAt)}.`);
    }

    if (state.lastUpdatedAt) {
        noteParts.push(`Last updated ${formatConsoleLogTime(state.lastUpdatedAt)}.`);
    }

    noteParts.push(state.paused
        ? 'Live polling is paused.'
        : `Refreshes every ${(NN_CONSOLE_LOG_REFRESH_MS / 1000).toFixed(1).replace(/\.0$/, '')} seconds while this tab is open.`);

    setServerAdminPill(refs.statusPill, state.paused ? 'Paused' : 'Live', state.paused ? 'warn' : 'good');
    setServerAdminMessage(refs.statusNote, noteParts.join(' '), state.paused ? 'warn' : 'neutral');
}

function renderConsoleLogsOutput({ preserveScroll = true } = {}) {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();
    const output = refs?.output;

    if (!(output instanceof HTMLElement)) {
        return;
    }

    const shouldStickToBottom = !preserveScroll || isScrolledNearBottom(output);
    const formatted = state.entries.length
        ? state.entries.map(formatConsoleLogEntry).join('\n')
        : 'No console output has been captured yet for this server process.';
    if (output.textContent !== formatted) {
        output.textContent = formatted;
    }
    output.classList.toggle('is-empty', state.entries.length === 0);
    output.setAttribute('aria-busy', String(state.busy));

    if (shouldStickToBottom) {
        output.scrollTop = output.scrollHeight;
    }

    renderConsoleLogsStatus();
}

function scheduleConsoleLogsRefresh(delay = NN_CONSOLE_LOG_REFRESH_MS) {
    const state = getConsoleLogsState();
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = 0;

    if (state.paused || !isConsoleLogsTabActive()) {
        return;
    }

    state.refreshTimer = window.setTimeout(() => {
        void refreshConsoleLogs();
    }, delay);
}

async function refreshConsoleLogs({ forceFull = false } = {}) {
    const state = getConsoleLogsState();
    const refs = getConsoleLogsRefs();

    if (!refs) {
        return;
    }

    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = 0;

    if (state.busy || state.paused) {
        if (state.busy && !state.paused) {
            scheduleConsoleLogsRefresh();
        }
        return;
    }

    state.busy = true;
    state.lastError = '';
    updateConsoleLogsInteractivity();
    renderConsoleLogsOutput();

    const requestBody = {
        limit: NN_CONSOLE_LOG_LIMIT,
    };

    if (!forceFull && state.latestId > 0) {
        requestBody.afterId = state.latestId;
    }

    try {
        const data = await requestServerAdmin('/api/server-admin/logs', requestBody);
        if (state.paused) {
            return;
        }
        const nextEntries = Array.isArray(data?.entries)
            ? data.entries.map(entry => ({
                id: Number(entry?.id ?? 0) || 0,
                timestamp: Number(entry?.timestamp ?? 0) || 0,
                stream: String(entry?.stream ?? 'stdout'),
                message: String(entry?.message ?? ''),
            })).filter(entry => entry.id > 0)
            : [];

        if (forceFull || !requestBody.afterId || data?.truncated) {
            state.entries = nextEntries.slice(-NN_CONSOLE_LOG_LIMIT);
        } else if (nextEntries.length > 0) {
            const mergedEntries = new Map(state.entries.map(entry => [entry.id, entry]));

            for (const entry of nextEntries) {
                mergedEntries.set(entry.id, entry);
            }

            state.entries = Array.from(mergedEntries.values())
                .sort((left, right) => left.id - right.id)
                .slice(-NN_CONSOLE_LOG_LIMIT);
        }

        state.latestId = Number(data?.latestId ?? state.latestId) || state.latestId;
        state.captureStartedAt = Number(data?.captureStartedAt ?? state.captureStartedAt) || state.captureStartedAt;
        state.totalBuffered = Number(data?.totalBuffered ?? state.totalBuffered) || state.totalBuffered;
        state.lastUpdatedAt = Date.now();
    } catch (error) {
        console.error('Failed to refresh console logs panel.', error);
        state.lastError = error.message || 'Failed to read console logs.';
    } finally {
        state.busy = false;
        updateConsoleLogsInteractivity();
        renderConsoleLogsOutput();
        scheduleConsoleLogsRefresh();
    }
}

function toggleConsoleLogsPolling() {
    const state = getConsoleLogsState();
    state.paused = !state.paused;

    if (state.paused) {
        window.clearTimeout(state.refreshTimer);
        state.refreshTimer = 0;
    }

    updateConsoleLogsInteractivity();
    renderConsoleLogsStatus();

    if (!state.paused) {
        void refreshConsoleLogs({ forceFull: state.latestId === 0 });
    }
}

function getImporterState() {
    return nnState.importer;
}

function getImporterRefs() {
    return getImporterState().refs;
}

async function requestServerAdmin(endpoint, body = {}, { signal } = {}) {
    const headers = await waitForAuthorizedRequestHeaders();
    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    });

    const text = await response.text();
    let data = null;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        const message = response.status === 403
            ? 'Server tools are only available after an admin session is ready.'
            : data?.error || data?.message || text || `Request failed with status ${response.status}.`;
        const error = new Error(message);
        error.status = response.status;
        error.data = data;
        throw error;
    }

    return data;
}

const NN_UPDATE_TOAST_STORAGE_KEY = 'neconyan:update-toast-commit';
const NN_UPDATE_TOAST_INTERVAL_MS = 30 * 60 * 1000;
const NN_UPDATE_TOAST_DURATION_MS = 8000;
let nnUpdateToastTimer = null;
let nnUpdateToastDismissTimer = null;
let nnUpdateToastChecking = false;

function readNotifiedUpdateCommit() {
    try {
        return localStorage.getItem(NN_UPDATE_TOAST_STORAGE_KEY) || '';
    } catch {
        return '';
    }
}

function rememberNotifiedUpdateCommit(commit) {
    try {
        localStorage.setItem(NN_UPDATE_TOAST_STORAGE_KEY, commit);
    } catch {
        /* storage unavailable; the toast may show again next check */
    }
}

function dismissUpdateToast() {
    clearTimeout(nnUpdateToastDismissTimer);
    nnUpdateToastDismissTimer = null;
    document.getElementById('nn-update-toast')?.remove();
}

function scheduleUpdateToastDismissal(toast) {
    clearTimeout(nnUpdateToastDismissTimer);
    nnUpdateToastDismissTimer = setTimeout(() => {
        if (toast.matches(':hover') || toast.contains(document.activeElement)) {
            scheduleUpdateToastDismissal(toast);
            return;
        }
        dismissUpdateToast();
    }, NN_UPDATE_TOAST_DURATION_MS);
}

let nnUpdateToastStyles = null;

function loadUpdateToastStyles() {
    nnUpdateToastStyles ??= new Promise(resolve => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'css/neconyan-update-toast.css?v=20260926a';
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
        document.head.append(link);
    });
    return nnUpdateToastStyles;
}

async function showUpdateToast(repository) {
    const commit = String(repository.remoteCommit || '');
    rememberNotifiedUpdateCommit(commit);
    dismissUpdateToast();
    await loadUpdateToastStyles();

    const behind = Number(repository.behind) || 0;
    const toast = document.createElement('div');
    toast.id = 'nn-update-toast';
    toast.className = 'nn-update-toast';
    toast.setAttribute('role', 'status');
    toast.innerHTML = `
        <button type="button" class="nn-update-toast-open">
            <i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i>
            <span class="nn-update-toast-text">
                <strong>Update available</strong>
                <span></span>
            </span>
        </button>
        <button type="button" class="nn-update-toast-close" aria-label="Dismiss" title="Dismiss">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>`;
    toast.querySelector('.nn-update-toast-text > span').textContent = behind === 1
        ? '1 new change. Open Server to update.'
        : `${behind} new changes. Open Server to update.`;
    toast.querySelector('.nn-update-toast-open').addEventListener('click', () => {
        dismissUpdateToast();
        openShell('right', 'server');
    });
    toast.querySelector('.nn-update-toast-close').addEventListener('click', dismissUpdateToast);
    document.body.append(toast);
    scheduleUpdateToastDismissal(toast);
}

async function checkForNeconyanUpdate() {
    if (nnUpdateToastChecking || document.hidden) return;
    nnUpdateToastChecking = true;
    try {
        const status = await requestServerAdmin('/api/server-admin/status');
        const repository = status?.repository;
        if (!repository?.isRepo || !repository.remoteCommit || !(Number(repository.behind) > 0)) return;
        if (repository.remoteCommit === readNotifiedUpdateCommit()) return;
        await showUpdateToast(repository);
    } catch (error) {
        if (error?.status === 401 || error?.status === 403) {
            clearInterval(nnUpdateToastTimer);
            nnUpdateToastTimer = null;
        }
    } finally {
        nnUpdateToastChecking = false;
    }
}

function startNeconyanUpdateToast() {
    if (nnUpdateToastTimer) return;
    nnUpdateToastTimer = setInterval(() => void checkForNeconyanUpdate(), NN_UPDATE_TOAST_INTERVAL_MS);
    void checkForNeconyanUpdate();
}

function setServerAdminPill(element, label, tone = 'neutral') {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    element.textContent = label;
    element.dataset.tone = tone;
}

function setServerAdminMessage(element, message, tone = 'neutral') {
    if (!(element instanceof HTMLElement)) {
        return;
    }

    element.textContent = String(message ?? '').trim();
    element.dataset.tone = tone;
    element.hidden = !element.textContent;
}

function setServerAdminButtonLabel(button, isBusy, busyLabel) {
    if (!(button instanceof HTMLButtonElement)) {
        return;
    }

    if (!button.dataset.idleLabel) {
        button.dataset.idleLabel = button.textContent || '';
    }

    button.textContent = isBusy ? busyLabel : button.dataset.idleLabel;
}

function describeAutoStashState(result) {
    if (!result?.stashed) {
        return '';
    }

    if (result?.stashPopWarning) {
        return result.stashPopWarning;
    }

    return 'Local tracked and untracked changes were auto-stashed and restored.';
}

function getThumbnailSettingsFromRefs(refs = getServerAdminRefs()) {
    const parseSize = (input, fallback) => {
        const value = Number.parseInt(input?.value, 10);
        return Number.isFinite(value) ? Math.min(4096, Math.max(1, value)) : fallback;
    };

    return {
        settings: {
            enabled: Boolean(refs?.thumbnailEnabled?.checked),
            format: refs?.thumbnailFormat?.value === 'jpg' ? 'jpg' : 'png',
            quality: parseSize(refs?.thumbnailQuality, 100),
            dimensions: {
                bg: [
                    parseSize(refs?.thumbnailBgWidth, 240),
                    parseSize(refs?.thumbnailBgHeight, 135),
                ],
                avatar: [
                    parseSize(refs?.thumbnailAvatarWidth, 864),
                    parseSize(refs?.thumbnailAvatarHeight, 1280),
                ],
                persona: [
                    parseSize(refs?.thumbnailPersonaWidth, 864),
                    parseSize(refs?.thumbnailPersonaHeight, 1280),
                ],
            },
        },
        mobileSettings: {
            enabled: Boolean(refs?.thumbnailMobileEnabled?.checked),
            format: refs?.thumbnailMobileFormat?.value === 'jpg' ? 'jpg' : 'png',
            quality: parseSize(refs?.thumbnailMobileQuality, 82),
            dimensions: {
                bg: [
                    parseSize(refs?.thumbnailMobileBgWidth, 240),
                    parseSize(refs?.thumbnailMobileBgHeight, 135),
                ],
                avatar: [
                    parseSize(refs?.thumbnailMobileAvatarWidth, 320),
                    parseSize(refs?.thumbnailMobileAvatarHeight, 480),
                ],
                persona: [
                    parseSize(refs?.thumbnailMobilePersonaWidth, 320),
                    parseSize(refs?.thumbnailMobilePersonaHeight, 480),
                ],
            },
        },
    };
}

function setThumbnailInputValues({ settings = {}, mobileSettings = {} } = {}, refs = getServerAdminRefs()) {
    if (!refs) {
        return;
    }

    refs.thumbnailEnabled.checked = Boolean(settings.enabled);
    refs.thumbnailFormat.value = settings.format === 'jpg' ? 'jpg' : 'png';
    refs.thumbnailQuality.value = String(settings.quality ?? 100);
    refs.thumbnailBgWidth.value = String(settings.dimensions?.bg?.[0] ?? 240);
    refs.thumbnailBgHeight.value = String(settings.dimensions?.bg?.[1] ?? 135);
    refs.thumbnailAvatarWidth.value = String(settings.dimensions?.avatar?.[0] ?? 864);
    refs.thumbnailAvatarHeight.value = String(settings.dimensions?.avatar?.[1] ?? 1280);
    refs.thumbnailPersonaWidth.value = String(settings.dimensions?.persona?.[0] ?? 864);
    refs.thumbnailPersonaHeight.value = String(settings.dimensions?.persona?.[1] ?? 1280);

    refs.thumbnailMobileEnabled.checked = Boolean(mobileSettings.enabled);
    refs.thumbnailMobileFormat.value = mobileSettings.format === 'jpg' ? 'jpg' : 'png';
    refs.thumbnailMobileQuality.value = String(mobileSettings.quality ?? 82);
    refs.thumbnailMobileBgWidth.value = String(mobileSettings.dimensions?.bg?.[0] ?? 240);
    refs.thumbnailMobileBgHeight.value = String(mobileSettings.dimensions?.bg?.[1] ?? 135);
    refs.thumbnailMobileAvatarWidth.value = String(mobileSettings.dimensions?.avatar?.[0] ?? 320);
    refs.thumbnailMobileAvatarHeight.value = String(mobileSettings.dimensions?.avatar?.[1] ?? 480);
    refs.thumbnailMobilePersonaWidth.value = String(mobileSettings.dimensions?.persona?.[0] ?? 320);
    refs.thumbnailMobilePersonaHeight.value = String(mobileSettings.dimensions?.persona?.[1] ?? 480);
}

function setThumbnailInputsDisabled(disabled, refs = getServerAdminRefs()) {
    const controls = [
        refs?.thumbnailEnabled,
        refs?.thumbnailFormat,
        refs?.thumbnailQuality,
        refs?.thumbnailBgWidth,
        refs?.thumbnailBgHeight,
        refs?.thumbnailAvatarWidth,
        refs?.thumbnailAvatarHeight,
        refs?.thumbnailPersonaWidth,
        refs?.thumbnailPersonaHeight,
        refs?.thumbnailUseRecommendedButton,
        refs?.thumbnailUseRecommendedMobileButton,
        refs?.thumbnailSaveButton,
        refs?.thumbnailSaveClearButton,
        refs?.thumbnailClearButton,
        refs?.thumbnailMobileEnabled,
        refs?.thumbnailMobileFormat,
        refs?.thumbnailMobileQuality,
        refs?.thumbnailMobileBgWidth,
        refs?.thumbnailMobileBgHeight,
        refs?.thumbnailMobileAvatarWidth,
        refs?.thumbnailMobileAvatarHeight,
        refs?.thumbnailMobilePersonaWidth,
        refs?.thumbnailMobilePersonaHeight,
    ];

    for (const control of controls) {
        if (control instanceof HTMLElement) {
            control.disabled = disabled;
        }
    }
}

function appendServerAdminStat(target, label, value) {
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const item = createElement('div', { className: 'sb-server-stat' });
    const title = createElement('small', { className: 'sb-server-stat-label', text: label });
    const content = createElement('strong', { className: 'sb-server-stat-value', text: value || 'Not available' });
    item.append(title, content);
    target.appendChild(item);
}

function updateServerConfigDirtyState() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs?.configEditor || !refs.configState) {
        return false;
    }

    const isDirty = refs.configEditor.value !== state.originalConfig;
    refs.configState.textContent = isDirty ? 'Unsaved changes' : 'Saved';
    refs.configState.dataset.state = isDirty ? 'dirty' : 'saved';
    return isDirty;
}

function updateServerAdminInteractivity() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    const locked = state.busy || state.restarting;
    const thumbnailLocked = locked || !state.thumbnailSettingsLoaded;
    const canUpdate = refs.updateButton?.dataset.sbCanUpdate === 'true';
    const hasConfigContent = Boolean(refs.configEditor?.value.trim());

    setButtonDisabled(refs.refreshButton, locked);
    setButtonDisabled(refs.reloadConfigButton, locked);
    setButtonDisabled(refs.updateButton, locked || !canUpdate);
    setButtonDisabled(refs.restartButton, locked);
    setButtonDisabled(refs.saveConfigButton, locked || !hasConfigContent);
    setButtonDisabled(refs.saveConfigRestartButton, locked || !hasConfigContent);
    setThumbnailInputsDisabled(thumbnailLocked);

    if (refs.configEditor instanceof HTMLTextAreaElement) {
        refs.configEditor.disabled = locked;
    }
}

function renderServerAdminStatus(data) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    const repository = data?.repository ?? {};
    const release = data?.release ?? null;
    const version = data?.version ?? {};
    const isGitInstall = Boolean(repository?.supported && repository?.isRepo);
    const statusGrid = refs.statusGrid;
    const sourceDetailsGrid = refs.sourceDetailsGrid ?? statusGrid;
    statusGrid.replaceChildren();
    if (sourceDetailsGrid !== statusGrid) {
        sourceDetailsGrid.replaceChildren();
    }

    appendServerAdminStat(statusGrid, 'Runtime', data?.runtime || 'Unknown');
    appendServerAdminStat(statusGrid, 'Version', version?.pkgVersion ? `v${version.pkgVersion}` : 'Unknown');

    const branchContainer = createElement('div', { className: 'sb-server-stat' });
    const branchLabel = createElement('small', {
        className: 'sb-server-stat-label',
        text: isGitInstall ? 'Git branch' : 'Release source',
    });
    const branchValue = createElement('div', { className: 'sb-server-stat-value' });
    const branchSelect = createElement('select', {
        id: 'sb-branch-select',
        className: 'text_pole',
        attrs: { style: 'width: 100%; max-width: 200px;', 'aria-label': isGitInstall ? 'Git branch' : 'Release source' },
    });
    branchSelect.disabled = !isGitInstall;
    const currentBranch = isGitInstall ? (repository?.displayBranch || repository?.branch || version?.gitBranch || '') : 'Release ZIP';
    const currentOptionAttributes = { value: currentBranch, selected: 'selected' };
    if (!currentBranch || !isGitInstall) {
        currentOptionAttributes.disabled = 'disabled';
    }
    const currentOption = createElement('option', { attrs: currentOptionAttributes });
    currentOption.textContent = currentBranch || 'Unknown';
    branchSelect.appendChild(currentOption);
    branchValue.appendChild(branchSelect);
    branchContainer.append(branchLabel, branchValue);
    statusGrid.appendChild(branchContainer);

    if (isGitInstall) {
        loadServerAdminBranches(branchSelect, currentBranch);
    }

    appendServerAdminStat(statusGrid, 'Commit', repository?.currentCommit || version?.gitRevision || 'Unknown');
    appendServerAdminStat(sourceDetailsGrid, 'Tracking', repository?.trackingBranch || 'Not set');
    appendServerAdminStat(sourceDetailsGrid, 'Ahead', String(repository?.ahead ?? 0));
    appendServerAdminStat(sourceDetailsGrid, 'Behind', String(repository?.behind ?? 0));
    if (release) {
        appendServerAdminStat(sourceDetailsGrid, 'Latest ZIP', release?.latestVersion ? `v${release.latestVersion}` : 'Unknown');
    }
    appendServerAdminStat(sourceDetailsGrid, 'Config', data?.configPath || 'Unknown');

    state.lastStatusData = {
        runtime: data?.runtime || '',
        configPath: data?.configPath || '',
        version,
        repository,
        release,
    };

    let pillLabel = 'Unavailable';
    let pillTone = 'neutral';

    if (isGitInstall) {
        if (!repository?.trackingBranch) {
            pillLabel = 'Local project';
            pillTone = 'neutral';
        } else if (repository?.hasLocalChanges && !repository?.canUpdate) {
            pillLabel = 'Update Blocked';
            pillTone = 'danger';
        } else if (repository?.hasLocalChanges && repository?.autoStash) {
            pillLabel = (repository?.behind ?? 0) > 0 ? 'Update Ready (Auto-stash)' : 'Auto-stash Enabled';
            pillTone = 'warn';
        } else if ((repository?.behind ?? 0) > 0) {
            pillLabel = 'Update Ready';
            pillTone = 'warn';
        } else if ((repository?.ahead ?? 0) > 0) {
            pillLabel = 'Patched Local';
            pillTone = 'neutral';
        } else {
            pillLabel = 'Up To Date';
            pillTone = 'good';
        }
    } else if (release?.canUpdate) {
        pillLabel = release?.latestVersion ? `Update Available (v${release.latestVersion})` : 'Update Available';
        pillTone = 'warn';
    } else if (release?.checked && release?.assetAvailable && release?.latestVersion === release?.currentVersion) {
        pillLabel = 'Up To Date';
        pillTone = 'good';
    } else if (release?.checked && release?.assetAvailable) {
        pillLabel = 'ZIP Install';
        pillTone = 'neutral';
    } else if (release?.checked && !release?.assetAvailable) {
        pillLabel = 'ZIP Unavailable';
        pillTone = 'warn';
    } else if (release?.supported && !release?.checked) {
        pillLabel = 'Check Failed';
        pillTone = 'warn';
    }

    setServerAdminPill(refs.statusPill, pillLabel, pillTone);
    const updateMode = repository?.canUpdate ? 'git' : release?.canUpdate ? 'zip' : '';
    refs.updateButton.dataset.sbCanUpdate = String(Boolean(updateMode));
    refs.updateButton.dataset.sbUpdateMode = updateMode;

    const noteParts = [String((isGitInstall ? repository?.message : release?.message || repository?.message) ?? '').trim()].filter(Boolean);

    if (repository?.hasLocalChanges && !repository?.canUpdate) {
        noteParts.push('Update blocked while this checkout has local changes.');
    }

    if ((repository?.changedFilesCount ?? 0) > 0) {
        const changedPreview = Array.isArray(repository?.changedFiles)
            ? repository.changedFiles.map(file => file?.path).filter(Boolean).join(', ')
            : '';
        noteParts.push(`Changed files: ${repository.changedFilesCount}`);
        appendServerAdminStat(sourceDetailsGrid, 'Changed files', changedPreview || String(repository.changedFilesCount));
    }

    setServerAdminMessage(refs.statusNote, noteParts.join('\n'), pillTone);

    if (refs.autoStashCheckbox) {
        refs.autoStashCheckbox.checked = Boolean(repository?.autoStash);
        refs.autoStashCheckbox.disabled = !isGitInstall;
    }
    updateServerAdminInteractivity();
}

function renderServerAdminConfig(data, { overwrite = true } = {}) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    refs.configPath.textContent = data?.path || 'config.yaml';
    state.configLoaded = true;

    if (overwrite && refs.configEditor instanceof HTMLTextAreaElement) {
        refs.configEditor.value = String(data?.content ?? '');
        state.originalConfig = refs.configEditor.value;
        state.lastModifiedMs = Number(data?.lastModifiedMs ?? 0) || 0;
        updateServerConfigDirtyState();
    }
}

function renderServerThumbnailSettings(data) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    setThumbnailInputValues({ settings: data?.settings ?? {}, mobileSettings: data?.mobileSettings ?? {} });
    state.thumbnailLastModifiedMs = Number(data?.lastModifiedMs ?? 0) || state.thumbnailLastModifiedMs;
    state.thumbnailRecommended = data?.recommended ?? state.thumbnailRecommended;
    state.thumbnailRecommendedMobile = data?.recommendedMobile ?? state.thumbnailRecommendedMobile;
    state.thumbnailSettingsLoaded = true;
    setServerAdminMessage(refs.thumbnailNote, 'Thumbnail settings loaded. Saving applies to new thumbnails immediately.', 'neutral');
}

async function waitForServerReturn(expectedRevision = '', { clearCacheBeforeReload = false, expectedVersion = '', previousServerBootId = '' } = {}) {
    let sawOffline = false;

    async function reloadAfterOptionalCacheClear() {
        if (clearCacheBeforeReload && typeof window.NeconyanClearFrontendCache === 'function') {
            await window.NeconyanClearFrontendCache({ skipConfirmation: true, saveBeforeClear: false });
        }
        location.reload();
    }
    const timeoutAt = Date.now() + 180000;

    while (Date.now() < timeoutAt) {
        try {
            const response = await fetch('/version', { cache: 'no-store' });

            if (!response.ok) {
                throw new Error('Server is not ready yet.');
            }

            const version = await response.json().catch(() => ({}));
            if (hasServerReturnedAfterRestart(version, { expectedRevision, expectedVersion, previousServerBootId, sawOffline })) {
                await reloadAfterOptionalCacheClear();
                return true;
            }
        } catch {
            sawOffline = true;
        }

        await wait(1500);
    }

    return false;
}

async function refreshServerAdminPanel({ includeConfig = false, forceConfig = false } = {}) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();
    const shouldLoadConfig = includeConfig || forceConfig || !state.configLoaded;
    const shouldLoadThumbnails = forceConfig || !state.thumbnailSettingsLoaded;

    if (!refs || state.busy || state.restarting) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.statusNote, 'Loading server status…');
    if (shouldLoadConfig) {
        refs.configState.textContent = state.configLoaded ? 'Refreshing…' : 'Loading…';
        refs.configState.dataset.state = 'loading';
    }

    const statusPromise = requestServerAdmin('/api/server-admin/status');
    const configPromise = shouldLoadConfig ? requestServerAdmin('/api/server-admin/config/get') : null;
    const thumbnailPromise = shouldLoadThumbnails
        ? requestServerAdmin('/api/server-admin/config/thumbnail-settings/get')
        : null;

    // Handle parallel failures before awaiting each result for its own panel.
    await Promise.allSettled([statusPromise, configPromise, thumbnailPromise]);

    if (configPromise) {
        try {
            const configData = await configPromise;
            const configIsDirty = refs.configEditor.value !== state.originalConfig;

            if (forceConfig || !configIsDirty) {
                renderServerAdminConfig(configData, { overwrite: true });
            } else {
                renderServerAdminConfig(configData, { overwrite: false });
                state.lastModifiedMs = Number(configData?.lastModifiedMs ?? 0) || state.lastModifiedMs;
                refs.configPath.textContent = configData?.path || refs.configPath.textContent;
                setServerAdminMessage(refs.configNote, 'The file was refreshed on disk, but your unsaved draft was kept locally.', 'warn');
            }
        } catch (error) {
            state.configLoaded = false;
            const tone = error?.status === 403 ? 'warn' : 'danger';
            refs.configState.textContent = error?.status === 403 ? 'Admin Only' : 'Unavailable';
            refs.configState.dataset.state = tone;
            setServerAdminMessage(refs.configNote, error.message || 'Failed to load config.yaml.', tone);
            if (error?.status !== 403) {
                console.error('Failed to load config.yaml.', error);
            }
        }
    }

    if (thumbnailPromise) {
        try {
            renderServerThumbnailSettings(await thumbnailPromise);
        } catch (error) {
            state.thumbnailSettingsLoaded = false;
            const tone = error?.status === 403 ? 'warn' : 'danger';
            setServerAdminMessage(refs.thumbnailNote, error.message || 'Failed to load thumbnail settings.', tone);
            if (error?.status !== 403) {
                console.error('Failed to load thumbnail settings.', error);
            }
        }
    }

    try {
        const statusData = await statusPromise;
        renderServerAdminStatus(statusData);
    } catch (error) {
        const tone = error?.status === 403 ? 'warn' : 'danger';
        if (error?.status !== 403) {
            console.error('Failed to refresh server admin panel.', error);
        }
        refs.updateButton.dataset.sbCanUpdate = 'false';
        refs.updateButton.dataset.sbUpdateMode = '';
        refs.statusGrid.replaceChildren();
        refs.sourceDetailsGrid?.replaceChildren();
        setServerAdminPill(getServerAdminRefs()?.statusPill, error?.status === 403 ? 'Admin Only' : 'Unavailable', tone);
        setServerAdminMessage(getServerAdminRefs()?.statusNote, error.message || 'Failed to load server tools.', tone);
    } finally {
        state.busy = false;
        updateServerAdminInteractivity();
    }
}

async function handleServerAdminReloadConfig() {
    const refs = getServerAdminRefs();

    if (!refs) {
        return;
    }

    if (updateServerConfigDirtyState() && !window.confirm('Discard your unsaved config edits and reload config.yaml from disk?')) {
        return;
    }

    await refreshServerAdminPanel({ includeConfig: true, forceConfig: true });
}

async function handleServerAdminSaveConfig({ restart = false } = {}) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.configNote, restart ? 'Saving config and preparing restart…' : 'Saving config…');

    try {
        const normalizedContent = refs.configEditor.value.endsWith('\n')
            ? refs.configEditor.value
            : `${refs.configEditor.value}\n`;
        const result = await requestServerAdmin('/api/server-admin/config/save', {
            content: normalizedContent,
            expectedLastModifiedMs: state.lastModifiedMs,
            restart,
        });

        refs.configEditor.value = normalizedContent;
        state.originalConfig = normalizedContent;
        state.lastModifiedMs = Number(result?.lastModifiedMs ?? 0) || state.lastModifiedMs;
        updateServerConfigDirtyState();
        setServerAdminMessage(refs.configNote, result?.message || 'Config saved.', restart ? 'warn' : 'good');
        toastr.success(result?.message || 'Config saved.', 'Server config');

        if (restart) {
            state.busy = false;
            state.restarting = true;
            updateServerAdminInteractivity();
            const restarted = await waitForServerReturn();

            if (!restarted) {
                state.restarting = false;
                setServerAdminMessage(refs.configNote, 'Restart is taking longer than expected. Refresh the page once the server is back.', 'warn');
                toastr.warning('Restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
            }
        }
    } catch (error) {
        console.error('Failed to save config.yaml.', error);
        setServerAdminMessage(refs.configNote, error.message || 'Failed to save config.yaml.', 'danger');
        toastr.error(error.message || 'Failed to save config.yaml.', 'Server config');
    } finally {
        if (!state.restarting) {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }
}

async function handleServerThumbnailSave({ clearCache = false } = {}) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    if (updateServerConfigDirtyState()) {
        setServerAdminMessage(refs.thumbnailNote, 'Save or reload the config.yaml editor before changing thumbnail settings.', 'warn');
        toastr.warning('Save or reload the config.yaml editor before changing thumbnail settings.', 'Thumbnails');
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.thumbnailNote, clearCache ? 'Saving settings and clearing thumbnail cache…' : 'Saving thumbnail settings…');

    try {
        const { settings, mobileSettings } = getThumbnailSettingsFromRefs(refs);
        const result = await requestServerAdmin('/api/server-admin/config/thumbnail-settings/save', {
            settings,
            mobileSettings,
            expectedLastModifiedMs: state.thumbnailLastModifiedMs || state.lastModifiedMs,
            clearCache,
        });

        renderServerThumbnailSettings(result);
        state.lastModifiedMs = Number(result?.lastModifiedMs ?? 0) || state.lastModifiedMs;
        setServerAdminMessage(refs.thumbnailNote, result?.message || 'Thumbnail settings saved.', 'good');
        toastr.success(result?.message || 'Thumbnail settings saved.', 'Thumbnails');
        renderServerAdminConfig(await requestServerAdmin('/api/server-admin/config/get'), { overwrite: true });
    } catch (error) {
        console.error('Failed to save thumbnail settings.', error);
        setServerAdminMessage(refs.thumbnailNote, error.message || 'Failed to save thumbnail settings.', 'danger');
        toastr.error(error.message || 'Failed to save thumbnail settings.', 'Thumbnails');
    } finally {
        state.busy = false;
        updateServerAdminInteractivity();
    }
}

async function handleServerThumbnailClearCache() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    if (!window.confirm('Clear cached thumbnails for this user? They will be rebuilt as images are loaded.')) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.thumbnailNote, 'Clearing thumbnail cache…');

    try {
        const result = await requestServerAdmin('/api/server-admin/thumbnails/clear-cache');
        setServerAdminMessage(refs.thumbnailNote, result?.message || 'Thumbnail cache cleared.', 'good');
        toastr.success(result?.message || 'Thumbnail cache cleared.', 'Thumbnails');
    } catch (error) {
        console.error('Failed to clear thumbnail cache.', error);
        setServerAdminMessage(refs.thumbnailNote, error.message || 'Failed to clear thumbnail cache.', 'danger');
        toastr.error(error.message || 'Failed to clear thumbnail cache.', 'Thumbnails');
    } finally {
        state.busy = false;
        updateServerAdminInteractivity();
    }
}

function handleUseRecommendedThumbnailSettings() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();
    const recommended = state.thumbnailRecommended ?? {
        enabled: true,
        format: 'png',
        quality: 100,
        dimensions: {
            bg: [240, 135],
            avatar: [864, 1280],
            persona: [864, 1280],
        },
    };

    setThumbnailInputValues({ settings: recommended, mobileSettings: getThumbnailSettingsFromRefs(refs).mobileSettings }, refs);
    setServerAdminMessage(refs.thumbnailNote, 'Recommended desktop thumbnail settings are staged. Save them when ready.', 'warn');
}

function handleUseRecommendedMobileThumbnailSettings() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();
    const recommendedMobile = state.thumbnailRecommendedMobile ?? {
        enabled: true,
        format: 'jpg',
        quality: 82,
        dimensions: {
            bg: [240, 135],
            avatar: [320, 480],
            persona: [320, 480],
        },
    };

    setThumbnailInputValues({ settings: getThumbnailSettingsFromRefs(refs).settings, mobileSettings: recommendedMobile }, refs);
    setServerAdminMessage(refs.thumbnailNote, 'Recommended mobile thumbnail settings are staged. Save them when ready.', 'warn');
}

function createThumbnailSizeRow(label, key) {
    const row = createElement('div', { className: 'sb-thumbnail-size-row' });
    const rowLabel = createElement('span', { className: 'sb-thumbnail-size-label', text: label });
    const widthInput = createElement('input', {
        className: 'text_pole sb-thumbnail-number',
        attrs: {
            type: 'number',
            inputmode: 'numeric',
            min: '1',
            max: '4096',
            step: '1',
            'aria-label': `${label} thumbnail width`,
        },
    });
    const separator = createElement('span', { className: 'sb-thumbnail-size-separator', text: 'x' });
    const heightInput = createElement('input', {
        className: 'text_pole sb-thumbnail-number',
        attrs: {
            type: 'number',
            inputmode: 'numeric',
            min: '1',
            max: '4096',
            step: '1',
            'aria-label': `${label} thumbnail height`,
        },
    });

    row.dataset.thumbnailSize = key;
    row.append(rowLabel, widthInput, separator, heightInput);
    return { row, widthInput, heightInput };
}

async function handleServerAdminRestart() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.updateNote, 'Restarting Neconyan…');

    try {
        const result = await requestServerAdmin('/api/server-admin/restart');
        state.busy = false;
        state.restarting = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, result?.message || 'Restarting Neconyan…', 'warn');
        toastr.info(result?.message || 'Restarting Neconyan…', 'Server');

        const restarted = await waitForServerReturn('', { previousServerBootId: result?.serverBootId });
        if (!restarted) {
            state.restarting = false;
            setServerAdminMessage(refs.updateNote, 'Restart is taking longer than expected. Refresh the page once the server is back.', 'warn');
            toastr.warning('Restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
        }
    } catch (error) {
        console.error('Failed to restart Neconyan.', error);
        state.busy = false;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, error.message || 'Failed to restart Neconyan.', 'danger');
        toastr.error(error.message || 'Failed to restart Neconyan.', 'Server');
    }
}

async function handleServerAdminUpdate() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting || refs.updateButton?.dataset.sbCanUpdate !== 'true') {
        return;
    }

    if (refs.updateButton?.dataset.sbUpdateMode === 'zip') {
        await handleServerAdminZipUpdate();
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminButtonLabel(refs.updateButton, true, 'Updating…');
    setServerAdminMessage(refs.updateNote, 'Checking Git status and applying the latest update…');
    refs.updateOutput.hidden = true;
    refs.updateOutput.textContent = '';

    try {
        const result = await requestServerAdmin('/api/server-admin/update');
        const nextStatus = {
            ...(state.lastStatusData ?? {}),
            configPath: refs.configPath?.textContent || state.lastStatusData?.configPath || '',
            version: result?.version ?? state.lastStatusData?.version ?? {},
            repository: result?.repository ?? state.lastStatusData?.repository ?? {},
        };

        if (!result?.updated) {
            renderServerAdminStatus(nextStatus);
            const stashMessage = describeAutoStashState(result);
            setServerAdminMessage(refs.updateNote, [result?.message || 'Already up to date.', stashMessage].filter(Boolean).join('\n'), stashMessage ? 'warn' : 'good');
            if (stashMessage) {
                toastr.info(stashMessage, 'Auto-stash');
            }
            toastr.success(result?.message || 'Already up to date.', 'Server update');
            return;
        }

        renderServerAdminStatus(nextStatus);

        const stashMessage = describeAutoStashState(result);
        if (result?.stashPopWarning) {
            toastr.warning(stashMessage, 'Auto-stash warning', { timeOut: 10000 });
        } else if (stashMessage) {
            toastr.info(stashMessage, 'Auto-stash');
        }

        if (result?.install?.stdout || result?.install?.stderr) {
            refs.updateOutput.hidden = false;
            refs.updateOutput.textContent = [result.install.command, result.install.stdout, result.install.stderr]
                .filter(Boolean)
                .join('\n\n');
        }

        state.busy = false;
        state.restarting = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, result?.message || 'Update applied. Restarting Neconyan.', 'warn');
        toastr.info(result?.message || 'Update applied. Restarting Neconyan.', 'Server update');

        const expectedRevision = String(result?.version?.gitRevision ?? result?.repository?.currentCommit ?? '').trim();
        const autoClearCacheEnabled = Boolean(document.getElementById('auto_clear_cache_on_update')?.checked);
        const restarted = await waitForServerReturn(expectedRevision, { clearCacheBeforeReload: autoClearCacheEnabled });

        if (!restarted) {
            state.restarting = false;
            setServerAdminMessage(refs.updateNote, 'Update completed, but restart is taking longer than expected. Refresh manually once the server is back.', 'warn');
            toastr.warning('Update finished, but restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
        }
    } catch (error) {
        console.error('Failed to update Neconyan.', error);
        state.busy = false;
        const stashMessage = describeAutoStashState(error?.data);
        if (stashMessage) {
            toastr.warning(stashMessage, 'Auto-stash warning', { timeOut: 10000 });
        }
        setServerAdminMessage(refs.updateNote, [error.message || 'Failed to update Neconyan.', stashMessage].filter(Boolean).join('\n'), 'danger');
        toastr.error(error.message || 'Failed to update Neconyan.', 'Server update');
    } finally {
        setServerAdminButtonLabel(refs.updateButton, false, 'Updating…');

        if (!state.restarting) {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }
}

async function handleServerAdminZipUpdate() {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminButtonLabel(refs.updateButton, true, 'Updating…');
    setServerAdminMessage(refs.updateNote, 'Downloading the latest GitHub release ZIP and preparing a safe restart…');
    refs.updateOutput.hidden = true;
    refs.updateOutput.textContent = '';

    try {
        const result = await requestServerAdmin('/api/server-admin/zip-update');
        const nextStatus = {
            ...(state.lastStatusData ?? {}),
            configPath: refs.configPath?.textContent || state.lastStatusData?.configPath || '',
            version: result?.version ?? state.lastStatusData?.version ?? {},
            repository: result?.repository ?? state.lastStatusData?.repository ?? {},
            release: result?.release ?? state.lastStatusData?.release ?? null,
        };

        if (!result?.updated) {
            renderServerAdminStatus(nextStatus);
            setServerAdminMessage(refs.updateNote, result?.message || 'Already up to date.', 'good');
            toastr.success(result?.message || 'Already up to date.', 'Server update');
            return;
        }

        renderServerAdminStatus(nextStatus);
        state.busy = false;
        state.restarting = true;
        updateServerAdminInteractivity();
        setServerAdminMessage(refs.updateNote, result?.message || 'ZIP update downloaded. Restarting Neconyan.', 'warn');
        toastr.info(result?.message || 'ZIP update downloaded. Restarting Neconyan.', 'Server update');

        const expectedVersion = String(result?.release?.latestVersion ?? '').trim();
        const autoClearCacheEnabled = Boolean(document.getElementById('auto_clear_cache_on_update')?.checked);
        const restarted = await waitForServerReturn('', { clearCacheBeforeReload: autoClearCacheEnabled, expectedVersion });

        if (!restarted) {
            state.restarting = false;
            setServerAdminMessage(refs.updateNote, 'ZIP update started, but restart is taking longer than expected. Refresh manually once the server is back.', 'warn');
            toastr.warning('ZIP update started, but restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
        }
    } catch (error) {
        console.error('Failed to update Neconyan from release ZIP.', error);
        state.busy = false;
        setServerAdminMessage(refs.updateNote, error.message || 'Failed to update Neconyan from release ZIP.', 'danger');
        toastr.error(error.message || 'Failed to update Neconyan from release ZIP.', 'Server update');
    } finally {
        setServerAdminButtonLabel(refs.updateButton, false, 'Updating…');

        if (!state.restarting) {
            state.busy = false;
            updateServerAdminInteractivity();
        }
    }
}

async function loadServerAdminBranches(selectElement, currentBranch) {
    try {
        const result = await requestServerAdmin('/api/server-admin/branches');
        const branches = result?.branches || [];

        selectElement.replaceChildren();

        for (const branch of branches) {
            const option = createElement('option', { attrs: { value: branch } });
            option.textContent = branch;
            if (branch === currentBranch) {
                option.selected = true;
            }
            selectElement.appendChild(option);
        }

        // Add change handler
        selectElement.addEventListener('change', () => handleServerAdminBranchSwitch(selectElement));
    } catch (error) {
        console.error('Failed to load branches.', error);
        // Keep the current branch option if loading fails
    }
}

async function handleServerAdminBranchSwitch(selectElement) {
    const state = getServerAdminState();
    const refs = getServerAdminRefs();

    if (!refs || state.busy || state.restarting) {
        return;
    }

    const targetBranch = selectElement.value;
    const currentBranch = state.lastStatusData?.repository?.displayBranch || state.lastStatusData?.repository?.branch || '';

    if (targetBranch === currentBranch) {
        return;
    }

    // Show confirmation dialog
    const hasLocalChanges = state.lastStatusData?.repository?.hasLocalChanges || false;
    const changedFiles = state.lastStatusData?.repository?.changedFiles || [];
    const changedFilesText = changedFiles.length > 0
        ? `\n\nChanged files: ${changedFiles.map(f => f.path).join(', ')}`
        : '';

    const confirmMessage = hasLocalChanges
        ? `You have local changes.${changedFilesText}\n\nDo you want to auto-stash your changes and switch to "${targetBranch}"?\n\nThe server will restart after switching.`
        : `Switch to branch "${targetBranch}"?\n\nThe server will restart after switching.`;

    const confirmed = confirm(confirmMessage);

    if (!confirmed) {
        // Reset select to current branch
        selectElement.value = currentBranch;
        return;
    }

    state.busy = true;
    updateServerAdminInteractivity();
    setServerAdminMessage(refs.updateNote, `Switching to branch "${targetBranch}"…`);

    const abortController = new AbortController();
    const abortTimeout = setTimeout(() => abortController.abort(), 45000);

    try {
        const result = await requestServerAdmin('/api/server-admin/switch-branch', {
            branch: targetBranch,
            autoStash: hasLocalChanges,
        }, { signal: abortController.signal });

        clearTimeout(abortTimeout);
        state.busy = false;
        state.restarting = true;
        updateServerAdminInteractivity();

        const message = result?.message || `Switched to branch "${targetBranch}". Restarting…`;
        setServerAdminMessage(refs.updateNote, message, 'warn');
        toastr.info(message, 'Branch Switch');

        if (result?.stashed && !result?.stashRestored) {
            toastr.warning('Your changes were stashed but could not be automatically restored. Use "git stash pop" after restart.', 'Stash Warning', { timeOut: 10000 });
        }

        const restarted = await waitForServerReturn();
        if (!restarted) {
            state.restarting = false;
            setServerAdminMessage(refs.updateNote, 'Branch switched, but restart is taking longer than expected. Refresh manually once the server is back.', 'warn');
            toastr.warning('Branch switched, but restart is taking longer than expected. Refresh manually once the server is back.', 'Restart pending');
        }
    } catch (error) {
        clearTimeout(abortTimeout);
        console.error('Failed to switch branch.', error);
        state.busy = false;
        updateServerAdminInteractivity();

        // Reset select to current branch
        selectElement.value = currentBranch;

        if (error.name === 'AbortError') {
            const timeoutMessage = 'Branch switch is taking longer than expected. The server may still be working; refresh in a moment to see the result.';
            setServerAdminMessage(refs.updateNote, timeoutMessage, 'warn');
            toastr.warning(timeoutMessage, 'Branch Switch', { timeOut: 10000 });
            return;
        }

        const errorMessage = error.message || 'Failed to switch branch.';
        setServerAdminMessage(refs.updateNote, errorMessage, 'danger');
        toastr.error(errorMessage, 'Branch Switch');
    }
}

function buildServerAdminPanel() {
    const { panel, scroller } = createShellPanel({
        id: 'server',
    });

    const column = createElement('div', { className: 'sb-shell-column sb-server-column' });

    const statusCard = createElement('section', { className: 'sb-admin-card sb-server-card neconyan-cat-panel' });
    const statusHeader = createElement('div', { className: 'sb-admin-card-header' });
    const statusCopy = createElement('div', { className: 'sb-admin-card-copy' });
    const statusTitle = createElement('strong', { text: 'Server status' });
    const statusDescription = createElement('p', { text: 'Runtime, source, commit, and update state.' });
    const statusPill = createElement('span', { className: 'sb-server-pill', text: 'Checking…' });
    const statusGrid = createElement('div', { className: 'sb-server-grid sb-server-summary-grid' });
    const statusNote = createElement('div', { className: 'sb-server-note' });
    const sourceDetails = createElement('details', { className: 'sb-server-source-details' });
    const sourceSummary = createElement('summary', { text: 'More source details' });
    const sourceDetailsGrid = createElement('div', { className: 'sb-server-grid' });
    sourceDetails.append(sourceSummary, sourceDetailsGrid);
    statusCopy.append(statusTitle, statusDescription);
    statusHeader.append(statusCopy, statusPill);
    statusCard.append(statusHeader, statusGrid, statusNote, sourceDetails);

    const updateCard = createElement('section', { className: 'sb-admin-card sb-server-card' });
    const updateHeader = createElement('div', { className: 'sb-admin-card-header' });
    const updateCopy = createElement('div', { className: 'sb-admin-card-copy' });
    const updateTitle = createElement('strong', { text: 'Updates & Restart' });
    const updateDescription = createElement('p', { text: 'Check upstream status, update the app, and relaunch automatically when it is safe to do so.' });
    const updateActions = createElement('div', { className: 'sb-server-actions' });
    const refreshButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Check for updates', attrs: { type: 'button' } });
    const updateButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action menu_button_primary', text: 'Update & Restart', attrs: { type: 'button' } });
    const restartButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Restart server', attrs: { type: 'button' } });
    const updateNote = createElement('div', { className: 'sb-server-note', text: 'Git fast-forward updates and release ZIP updates restart automatically after preparation finishes.' });
    const autoStashLabel = createElement('label', { className: 'checkbox_label' });
    const autoStashCheckbox = createElement('input', { attrs: { type: 'checkbox', id: 'auto_stash_before_pull' } });
    const autoStashText = createElement('small', { text: 'Auto-stash local changes before pulling' });
    autoStashLabel.append(autoStashCheckbox, autoStashText);
    const updateOutput = createElement('pre', { className: 'sb-server-output' });
    updateOutput.hidden = true;
    updateCopy.append(updateTitle, updateDescription);
    updateActions.append(refreshButton, updateButton, restartButton);
    updateHeader.append(updateCopy);
    updateCard.append(updateHeader, updateActions, autoStashLabel, updateNote, updateOutput);

    const thumbnailCard = createElement('section', { className: 'sb-admin-card sb-server-card sb-thumbnail-card' });
    const thumbnailHeader = createElement('div', { className: 'sb-admin-card-header' });
    const thumbnailCopy = createElement('div', { className: 'sb-admin-card-copy' });
    const thumbnailTitle = createElement('strong', { text: 'Thumbnail Quality' });
    const thumbnailDescription = createElement('p', { text: 'Set thumbnail format, quality, and generated sizes without hand-editing config.yaml.' });
    thumbnailCopy.append(thumbnailTitle, thumbnailDescription);
    thumbnailHeader.append(thumbnailCopy);

    const thumbnailControls = createElement('div', { className: 'sb-thumbnail-controls' });
    const thumbnailEnabledLabel = createElement('label', { className: 'checkbox_label sb-thumbnail-enabled' });
    const thumbnailEnabled = createElement('input', { attrs: { type: 'checkbox' } });
    const thumbnailEnabledText = createElement('small', { text: 'Generate thumbnails' });
    thumbnailEnabledLabel.append(thumbnailEnabled, thumbnailEnabledText);

    const thumbnailFormatGroup = createElement('label', { className: 'sb-thumbnail-field' });
    const thumbnailFormatText = createElement('span', { text: 'Format' });
    const thumbnailFormat = createElement('select', { className: 'text_pole' });
    thumbnailFormat.append(
        createElement('option', { text: 'JPG', attrs: { value: 'jpg' } }),
        createElement('option', { text: 'PNG', attrs: { value: 'png' } }),
    );
    thumbnailFormatGroup.append(thumbnailFormatText, thumbnailFormat);

    const thumbnailQualityGroup = createElement('label', { className: 'sb-thumbnail-field' });
    const thumbnailQualityText = createElement('span', { text: 'Quality' });
    const thumbnailQuality = createElement('input', {
        className: 'text_pole sb-thumbnail-number',
        attrs: {
            type: 'number',
            inputmode: 'numeric',
            min: '1',
            max: '100',
            step: '1',
        },
    });
    thumbnailQualityGroup.append(thumbnailQualityText, thumbnailQuality);
    thumbnailControls.append(thumbnailEnabledLabel, thumbnailFormatGroup, thumbnailQualityGroup);

    const thumbnailSizes = createElement('div', { className: 'sb-thumbnail-sizes' });
    const bgSize = createThumbnailSizeRow('Background', 'bg');
    const avatarSize = createThumbnailSizeRow('Character', 'avatar');
    const personaSize = createThumbnailSizeRow('Persona', 'persona');
    thumbnailSizes.append(bgSize.row, avatarSize.row, personaSize.row);

    const thumbnailActions = createElement('div', { className: 'sb-server-actions' });
    const thumbnailUseRecommendedButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Use desktop recommended', attrs: { type: 'button' } });
    const thumbnailUseRecommendedMobileButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Use mobile recommended', attrs: { type: 'button' } });
    const thumbnailSaveButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Save thumbnails', attrs: { type: 'button' } });
    const thumbnailSaveClearButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action menu_button_primary', text: 'Save & Clear Cache', attrs: { type: 'button' } });
    const thumbnailClearButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Clear cache only', attrs: { type: 'button' } });
    const thumbnailNote = createElement('div', { className: 'sb-server-note', text: 'Desktop thumbnails default to PNG at full resolution. Enable the mobile preset to serve smaller JPG thumbnails to phone-sized screens.' });

    const thumbnailMobileHeading = createElement('div', { className: 'sb-thumbnail-mobile-heading', text: 'Mobile preset' });
    const thumbnailMobileControls = createElement('div', { className: 'sb-thumbnail-controls' });
    const thumbnailMobileEnabledLabel = createElement('label', { className: 'checkbox_label sb-thumbnail-enabled' });
    const thumbnailMobileEnabled = createElement('input', { attrs: { type: 'checkbox' } });
    const thumbnailMobileEnabledText = createElement('small', { text: 'Generate mobile thumbnails' });
    thumbnailMobileEnabledLabel.append(thumbnailMobileEnabled, thumbnailMobileEnabledText);

    const thumbnailMobileFormatGroup = createElement('label', { className: 'sb-thumbnail-field' });
    const thumbnailMobileFormatText = createElement('span', { text: 'Mobile format' });
    const thumbnailMobileFormat = createElement('select', { className: 'text_pole' });
    thumbnailMobileFormat.append(
        createElement('option', { text: 'JPG', attrs: { value: 'jpg' } }),
        createElement('option', { text: 'PNG', attrs: { value: 'png' } }),
    );
    thumbnailMobileFormatGroup.append(thumbnailMobileFormatText, thumbnailMobileFormat);

    const thumbnailMobileQualityGroup = createElement('label', { className: 'sb-thumbnail-field' });
    const thumbnailMobileQualityText = createElement('span', { text: 'Mobile quality' });
    const thumbnailMobileQuality = createElement('input', {
        className: 'text_pole sb-thumbnail-number',
        attrs: {
            type: 'number',
            inputmode: 'numeric',
            min: '1',
            max: '100',
            step: '1',
        },
    });
    thumbnailMobileQualityGroup.append(thumbnailMobileQualityText, thumbnailMobileQuality);
    thumbnailMobileControls.append(thumbnailMobileEnabledLabel, thumbnailMobileFormatGroup, thumbnailMobileQualityGroup);

    const thumbnailMobileSizes = createElement('div', { className: 'sb-thumbnail-sizes' });
    const mobileBgSize = createThumbnailSizeRow('Mobile background', 'mobile-bg');
    const mobileAvatarSize = createThumbnailSizeRow('Mobile character', 'mobile-avatar');
    const mobilePersonaSize = createThumbnailSizeRow('Mobile persona', 'mobile-persona');
    thumbnailMobileSizes.append(mobileBgSize.row, mobileAvatarSize.row, mobilePersonaSize.row);

    thumbnailActions.append(thumbnailUseRecommendedButton, thumbnailUseRecommendedMobileButton, thumbnailSaveButton, thumbnailSaveClearButton, thumbnailClearButton);
    thumbnailCard.append(thumbnailHeader, thumbnailControls, thumbnailSizes, thumbnailMobileHeading, thumbnailMobileControls, thumbnailMobileSizes, thumbnailActions, thumbnailNote);

    const configCard = createElement('section', { className: 'sb-admin-card sb-server-card' });
    const configHeader = createElement('div', { className: 'sb-admin-card-header' });
    const configCopy = createElement('div', { className: 'sb-admin-card-copy' });
    const configTitle = createElement('strong', { text: 'config.yaml Editor' });
    const configDescription = createElement('p', { text: 'Edit the live config file directly here. Saves validate YAML before writing anything to disk.' });
    const configState = createElement('span', { className: 'sb-server-inline-state', text: 'Loading…' });
    const configPath = createElement('code', { className: 'sb-server-config-path', text: 'config.yaml' });
    const configMeta = createElement('div', { className: 'sb-server-config-meta' });
    const configEditor = createElement('textarea', {
        className: 'text_pole sb-server-config-editor',
        attrs: {
            spellcheck: 'false',
            rows: '22',
            'aria-label': 'config.yaml editor',
        },
    });
    const configActions = createElement('div', { className: 'sb-server-actions' });
    const reloadConfigButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Reload file', attrs: { type: 'button' } });
    const saveConfigButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Save config', attrs: { type: 'button' } });
    const saveConfigRestartButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action menu_button_primary', text: 'Save & Restart', attrs: { type: 'button' } });
    const configNote = createElement('div', { className: 'sb-server-note', text: 'Most config changes only take effect after a restart.' });
    configCopy.append(configTitle, configDescription);
    configHeader.append(configCopy, configState);
    configMeta.append(configPath);
    configActions.append(reloadConfigButton, saveConfigButton, saveConfigRestartButton);
    configCard.append(configHeader, configMeta, configEditor, configActions, configNote);

    column.append(statusCard, updateCard, thumbnailCard, configCard);
    scroller.appendChild(column);

    const state = getServerAdminState();
    state.refs = {
        statusPill,
        statusGrid,
        sourceDetailsGrid,
        statusNote,
        refreshButton,
        updateButton,
        restartButton,
        updateNote,
        updateOutput,
        autoStashCheckbox,
        thumbnailEnabled,
        thumbnailFormat,
        thumbnailQuality,
        thumbnailBgWidth: bgSize.widthInput,
        thumbnailBgHeight: bgSize.heightInput,
        thumbnailAvatarWidth: avatarSize.widthInput,
        thumbnailAvatarHeight: avatarSize.heightInput,
        thumbnailPersonaWidth: personaSize.widthInput,
        thumbnailPersonaHeight: personaSize.heightInput,
        thumbnailUseRecommendedButton,
        thumbnailUseRecommendedMobileButton,
        thumbnailSaveButton,
        thumbnailSaveClearButton,
        thumbnailClearButton,
        thumbnailNote,
        thumbnailMobileEnabled,
        thumbnailMobileFormat,
        thumbnailMobileQuality,
        thumbnailMobileBgWidth: mobileBgSize.widthInput,
        thumbnailMobileBgHeight: mobileBgSize.heightInput,
        thumbnailMobileAvatarWidth: mobileAvatarSize.widthInput,
        thumbnailMobileAvatarHeight: mobileAvatarSize.heightInput,
        thumbnailMobilePersonaWidth: mobilePersonaSize.widthInput,
        thumbnailMobilePersonaHeight: mobilePersonaSize.heightInput,
        configPath,
        configState,
        configEditor,
        reloadConfigButton,
        saveConfigButton,
        saveConfigRestartButton,
        configNote,
    };
    setServerAdminPill(statusPill, 'Idle', 'neutral');
    setServerAdminMessage(statusNote, 'Open this tab to load server status and update controls.', 'neutral');
    configState.textContent = 'Not loaded';
    configState.dataset.state = 'neutral';

    refreshButton.addEventListener('click', () => refreshServerAdminPanel({ includeConfig: false }));
    updateButton.addEventListener('click', handleServerAdminUpdate);
    restartButton.addEventListener('click', handleServerAdminRestart);
    thumbnailUseRecommendedButton.addEventListener('click', handleUseRecommendedThumbnailSettings);
    thumbnailUseRecommendedMobileButton.addEventListener('click', handleUseRecommendedMobileThumbnailSettings);
    thumbnailSaveButton.addEventListener('click', () => handleServerThumbnailSave({ clearCache: false }));
    thumbnailSaveClearButton.addEventListener('click', () => handleServerThumbnailSave({ clearCache: true }));
    thumbnailClearButton.addEventListener('click', handleServerThumbnailClearCache);
    reloadConfigButton.addEventListener('click', handleServerAdminReloadConfig);
    saveConfigButton.addEventListener('click', () => handleServerAdminSaveConfig({ restart: false }));
    saveConfigRestartButton.addEventListener('click', () => handleServerAdminSaveConfig({ restart: true }));
    configEditor.addEventListener('input', () => {
        updateServerConfigDirtyState();
        updateServerAdminInteractivity();
    });
    autoStashCheckbox.addEventListener('change', function () {
        const refs = getServerAdminRefs();
        if (!refs?.configEditor) return;
        const yaml = refs.configEditor.value;
        const newValue = this.checked ? 'true' : 'false';
        if (/^autoStashBeforePull:\s*(true|false)/m.test(yaml)) {
            refs.configEditor.value = yaml.replace(/^(autoStashBeforePull:\s*)(true|false)/m, `$1${newValue}`);
        } else {
            refs.configEditor.value = yaml + `\nautoStashBeforePull: ${newValue}\n`;
        }
        refs.configEditor.dispatchEvent(new Event('input'));
    });
    updateServerAdminInteractivity();

    return {
        id: 'server',
        panel,
        button: null,
        searchRoot: column,
        onActivate: () => {
            if (!isShellOpen('right')) {
                return;
            }

            void refreshServerAdminPanel({ includeConfig: !getServerAdminState().configLoaded });
        },
    };
}

/**
 * Creates a collapsible inline-drawer for Advanced Formatting sections.
 * @param {string} id Drawer element ID
 * @param {string} title Drawer title
 * @param {string} description Short description
 * @returns {HTMLElement} The drawer element
 */
function createAdvFormattingDrawer(id, title, description) {
    const drawer = createElement('div', {
        id,
        className: 'inline-drawer wide100p flexFlowColumn sb-af-settings-drawer',
    });
    const header = createElement('div', { className: 'inline-drawer-toggle inline-drawer-header' });
    const label = createElement('div', { className: 'flex-container flexFlowColumn' });
    const titleEl = createElement('b');
    titleEl.textContent = title;
    label.appendChild(titleEl);
    if (description) {
        const desc = createElement('small', { className: 'sb-group-meta' });
        desc.textContent = description;
        label.appendChild(desc);
    }
    header.appendChild(label);
    const icon = createElement('div', { className: 'fa-solid fa-circle-chevron-down inline-drawer-icon down' });
    header.appendChild(icon);
    drawer.appendChild(header);
    const content = createElement('div', { className: 'inline-drawer-content' });
    content.style.display = 'none';
    drawer.appendChild(content);
    return drawer;
}

/**
 * Wraps Advanced Formatting columns (Context Template, Instruct Template,
 * System Prompt, Reasoning) into collapsible drawers for better UX.
 */
function groupAdvancedFormattingIntoDrawers() {
    const $af = $('#AdvancedFormatting');
    if ($af.length === 0 || $af.data('sb-grouped')) {
        return;
    }

    // The three-column container
    const $columnsContainer = $af.find('.flex-container.spaceEvenly').first();
    if ($columnsContainer.length === 0) {
        return;
    }

    const sections = [
        {
            id: 'sb-af-context',
            title: 'Context Template',
            description: 'Story string, separators, and context formatting options',
            selector: '#ContextSettings',
        },
        {
            id: 'sb-af-instruct',
            title: 'Instruct Template',
            description: 'Instruct mode sequences, wrapping, and activation',
            selector: '#InstructSettingsColumn',
        },
        {
            id: 'sb-af-sysprompt',
            title: 'System Prompt',
            description: 'System prompt, post-history instructions, stopping strings, tokenizer',
            selector: '#SystemPromptColumn',
        },
    ];

    const $drawersContainer = $('<div>', { class: 'sb-af-drawers flex-container flexFlowColumn gap10' });

    sections.forEach(section => {
        const $col = $(section.selector).first();
        if ($col.length === 0) return;

        $col.detach();

        const drawer = createAdvFormattingDrawer(section.id, section.title, section.description);
        const content = drawer.querySelector('.inline-drawer-content');

        // Remove the flex1 class so it fills the full width in stacked layout
        $col.removeClass('flex1');
        $col.addClass('wide100p');

        content.appendChild($col[0]);
        $drawersContainer.append(drawer);
    });

    // Also check if Reasoning section exists after the columns container
    const $reasoning = $columnsContainer.nextAll().filter(function () {
        return $(this).find('#reasoning_auto_parse').length > 0 || $(this).find('.sb-reasoning-toggle-grid').length > 0;
    }).first();

    if ($reasoning.length > 0) {
        $reasoning.detach();
        const drawer = createAdvFormattingDrawer('sb-af-reasoning', 'Reasoning', 'Auto-parse, formatting, and reasoning block settings');
        const content = drawer.querySelector('.inline-drawer-content');
        content.appendChild($reasoning[0]);
        $drawersContainer.append(drawer);
    }

    // Replace the columns container with the stacked drawers
    $columnsContainer.replaceWith($drawersContainer);

    $af.data('sb-grouped', true);
}

function buildConsoleLogsPanel() {
    const { panel, scroller } = createShellPanel({
        id: 'console-logs',
    });

    const column = createElement('div', { className: 'sb-shell-column sb-console-log-column' });
    const card = createElement('section', { className: 'sb-admin-card sb-server-card sb-console-log-card neconyan-cat-panel' });
    const header = createElement('div', { className: 'sb-admin-card-header' });
    const copy = createElement('div', { className: 'sb-admin-card-copy' });
    const title = createElement('strong', { text: 'Server logs' });
    const description = createElement('p', { text: 'Recent output from this Neconyan session. The text stays selectable while polling is paused.' });
    const statusPill = createElement('span', { className: 'sb-server-pill', text: 'Ready' });
    const actions = createElement('div', { className: 'sb-server-actions sb-console-log-actions' });
    const refreshButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Refresh', attrs: { type: 'button' } });
    const pauseButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Pause Live', attrs: { type: 'button', 'aria-pressed': 'false' } });
    const copyButton = createElement('button', { className: 'menu_button menu_button_icon sb-server-action', text: 'Copy logs', attrs: { type: 'button' } });
    const statusNote = createElement('div', { className: 'sb-server-note' });
    const copyStatus = createElement('span', { className: 'sb-console-log-copy-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const output = createElement('pre', {
        className: 'sb-server-output sb-console-log-output',
        attrs: { role: 'log', tabindex: '0', 'aria-label': 'Neconyan server console logs', 'aria-busy': 'false' },
    });
    const verboseLoggingCard = createElement('section', { className: 'sb-admin-card sb-server-card sb-console-log-verbose-card' });
    const verboseLoggingHeader = createElement('div', { className: 'sb-admin-card-header' });
    const verboseLoggingCopy = createElement('div', { className: 'sb-admin-card-copy' });
    const verboseLoggingTitle = createElement('strong', { text: 'Verbose Debug Logging' });
    const verboseLoggingDescription = createElement('p', { text: 'Enable full debugging console output for advanced troubleshooting. Changes are saved to config.yaml and apply after a restart.' });
    const verboseLoggingStatus = createElement('span', { className: 'sb-server-inline-state', text: 'Loading…' });
    const verboseLoggingActionButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action interactable sb-console-log-verbose-action',
        text: 'Debug Logging: Disabled',
        attrs: { type: 'button' },
    });

    copy.append(title, description);
    header.append(copy, statusPill);
    actions.append(refreshButton, pauseButton, copyButton);
    card.append(header, actions, statusNote, copyStatus, output);
    verboseLoggingCopy.append(verboseLoggingTitle, verboseLoggingDescription);
    verboseLoggingHeader.append(verboseLoggingCopy, verboseLoggingStatus);
    verboseLoggingCard.append(verboseLoggingHeader, verboseLoggingActionButton);
    column.append(card, verboseLoggingCard);
    scroller.appendChild(column);

    const state = getConsoleLogsState();
    state.refs = {
        statusPill,
        refreshButton,
        pauseButton,
        copyButton,
        statusNote,
        copyStatus,
        output,
        verboseLoggingStatus,
        verboseLoggingActionButton,
    };

    refreshButton.addEventListener('click', () => {
        void refreshConsoleLogs({ forceFull: state.latestId === 0 });
    });
    pauseButton.addEventListener('click', toggleConsoleLogsPolling);
    copyButton.addEventListener('click', async () => {
        if (!state.entries.length) {
            return;
        }

        try {
            await copyText(output.textContent || '');
            copyStatus.textContent = 'Logs copied.';
        } catch (error) {
            copyStatus.textContent = error?.message || 'Unable to copy logs.';
        } finally {
            copyButton.focus({ preventScroll: true });
        }
    });
    verboseLoggingActionButton.addEventListener('click', () => {
        void toggleConsoleLogsVerboseLogging();
    });

    renderConsoleLogsOutput({ preserveScroll: false });
    updateConsoleLogsInteractivity();

    return {
        id: 'console-logs',
        panel,
        button: null,
        searchRoot: column,
        onActivate: () => {
            void refreshConsoleLogsConfig();
            void refreshConsoleLogs({ forceFull: getConsoleLogsState().latestId === 0 });
            scheduleConsoleLogsRefresh(0);
        },
        onDeactivate: () => {
            const state = getConsoleLogsState();
            window.clearTimeout(state.refreshTimer);
            state.refreshTimer = 0;
        },
    };
}

function updateSillyTavernImportInteractivity() {
    const state = getImporterState();
    const refs = getImporterRefs();

    if (!refs) {
        return;
    }

    setButtonDisabled(refs.folderButton, state.busy);
    setButtonDisabled(refs.syncButton, state.busy);
    setButtonDisabled(refs.zipButton, state.busy);

    if (refs.pathInput instanceof HTMLInputElement) {
        refs.pathInput.disabled = state.busy;
    }
    for (const input of refs.card.querySelectorAll('[data-import-part]')) input.disabled = state.busy;
}

function setSillyTavernImportBusy(isBusy) {
    getImporterState().busy = Boolean(isBusy);
    const refs = getImporterRefs();
    if (isBusy && refs?.progress) {
        refs.progress.hidden = false;
        refs.progress.removeAttribute('value');
        refs.progressLabel.textContent = 'Preparing import…';
    } else if (refs?.progress) {
        refs.progress.hidden = true;
        refs.progress.removeAttribute('value');
        refs.progressLabel.textContent = '';
    }
    updateSillyTavernImportInteractivity();
}

function showImportProgress({ percent, phase }) {
    const refs = getImporterRefs();
    if (!refs?.progress) return;
    refs.progress.hidden = false;
    if (percent === null) refs.progress.removeAttribute('value');
    else refs.progress.value = percent;
    refs.progressLabel.textContent = `${phase}${percent === null ? '' : `: ${percent}%`}`;
}

function getExtensionSyncStatusTone(status) {
    if (status === 'shadowed') return 'neutral';

    if (status === 'failed') {
        return 'danger';
    }

    if (status === 'warning') {
        return 'warn';
    }

    return 'good';
}

function getExtensionSyncStatusLabel(status) {
    if (status === 'shadowed') return 'Retained, inactive';

    if (status === 'failed') {
        return 'Failed';
    }

    if (status === 'warning') {
        return 'Needs Attention';
    }

    return 'Ready';
}

function getExtensionSyncActivationMessage(result) {
    const shadowedCount = Number(result?.shadowedCount ?? 0) || 0;
    const syncedCount = (Number(result?.readyCount ?? 0) || 0) + (Number(result?.warningCount ?? 0) || 0);
    return [
        syncedCount > 0 ? 'Reload when you are ready to activate the synced custom extensions.' : '',
        shadowedCount > 0 ? `${shadowedCount} retained ${shadowedCount === 1 ? 'copy stays' : 'copies stay'} inactive because Neconyan includes these features.` : '',
    ].filter(Boolean).join(' ');
}

function getExtensionSyncCheckSummary(result) {
    if (result?.status === 'shadowed') return 'Neconyan uses its included version. Your imported copy is retained on disk.';
    const checks = [];
    const manifestFound = result?.checks?.manifestFound === true;
    const manifestValid = result?.checks?.manifestValid === true;
    const jsEntry = typeof result?.checks?.jsEntry === 'string' ? result.checks.jsEntry.trim() : '';
    const jsEntryExists = result?.checks?.jsEntryExists === true;
    const gitMetadataSkipped = result?.checks?.gitMetadataSkipped === true;

    checks.push(!manifestFound
        ? 'manifest missing'
        : manifestValid
            ? 'manifest OK'
            : 'manifest invalid');
    checks.push(jsEntry
        ? jsEntryExists
            ? `JS entry: ${jsEntry}`
            : `JS missing: ${jsEntry}`
        : 'no JS entry');

    if (gitMetadataSkipped) {
        checks.push('git metadata skipped');
    }

    return checks.join(' · ');
}

function renderSillyTavernExtensionSyncReport(reportData = null) {
    const refs = getImporterRefs();
    const report = refs?.report;
    const summary = refs?.reportSummary;
    const help = refs?.reportHelp;
    const list = refs?.reportList;
    const state = getImporterState();

    state.report = reportData;

    if (!(report instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(help instanceof HTMLElement) || !(list instanceof HTMLElement)) {
        return;
    }

    if (!reportData || !Array.isArray(reportData.results) || reportData.results.length === 0) {
        report.hidden = true;
        summary.textContent = '';
        help.textContent = '';
        list.replaceChildren();
        return;
    }

    const results = reportData.results;
    const readyCount = Number(reportData.readyCount ?? 0) || 0;
    const warningCount = Number(reportData.warningCount ?? 0) || 0;
    const failedCount = Number(reportData.failedCount ?? 0) || 0;
    const syncedCount = readyCount + warningCount;
    const needsAttention = warningCount + failedCount > 0;
    const gitMetadataSkippedCount = Number(reportData.gitMetadataSkippedCount ?? 0)
        || results.filter(result => result?.checks?.gitMetadataSkipped === true).length;

    summary.textContent = reportData.message
        || `Synced ${syncedCount} of ${results.length} third-party extensions.`;
    help.textContent = [
        getExtensionSyncActivationMessage(reportData),
        needsAttention ? 'Review the warnings below before reloading.' : '',
        gitMetadataSkippedCount > 0 ? `Git metadata was skipped on ${gitMetadataSkippedCount} imported folders; custom extensions may need reinstalling to use Git updates.` : '',
    ].filter(Boolean).join(' ');

    const items = results.map(result => {
        const card = createElement('article', { className: `sb-import-report-item is-${result?.status || 'warning'}` });
        const header = createElement('div', { className: 'sb-import-report-item-header' });
        const titleGroup = createElement('div', { className: 'sb-import-report-item-title' });
        const title = createElement('strong', { text: result?.displayName || result?.name || 'Unknown extension' });
        const metaParts = [];

        if (result?.version) {
            metaParts.push(`v${result.version}`);
        }

        if (result?.author) {
            metaParts.push(result.author);
        }

        const meta = createElement('small', {
            className: 'sb-import-report-item-meta',
            text: metaParts.join(' • '),
        });
        const pill = createElement('span', { className: 'sb-server-pill' });

        setServerAdminPill(pill, getExtensionSyncStatusLabel(result?.status), getExtensionSyncStatusTone(result?.status));
        titleGroup.append(title);

        if (metaParts.length > 0) {
            titleGroup.append(meta);
        }

        header.append(titleGroup, pill);

        const body = createElement('div', { className: 'sb-import-report-item-body' });
        const copiedFiles = Number(result?.copiedFiles ?? 0) || 0;
        const statusLine = createElement('p', {
            className: 'sb-import-report-item-copy',
            text: result?.status === 'failed'
                ? (result?.error || 'This extension could not be synced.')
                : `Copied ${copiedFiles} file${copiedFiles === 1 ? '' : 's'} into ${result?.name || 'extension'}.`,
        });
        const checksLine = createElement('p', {
            className: 'sb-import-report-item-checks',
            text: getExtensionSyncCheckSummary(result),
        });

        body.append(statusLine, checksLine);

        if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
            const warningList = createElement('ul', { className: 'sb-import-report-warnings' });

            for (const warning of result.warnings) {
                warningList.appendChild(createElement('li', { text: warning }));
            }

            body.appendChild(warningList);
        }

        card.append(header, body);
        return card;
    });

    list.replaceChildren(...items);
    report.hidden = false;
}

function logSillyTavernExtensionSyncReport(reportData) {
    if (!reportData || !Array.isArray(reportData.results)) {
        return;
    }

    console.groupCollapsed(`[Neconyan] Third-party extension sync report (${reportData.results.length})`);
    console.table(reportData.results.map(result => ({
        name: result?.name || '',
        displayName: result?.displayName || '',
        status: result?.status || '',
        copiedFiles: Number(result?.copiedFiles ?? 0) || 0,
        manifestFound: result?.checks?.manifestFound === true,
        manifestValid: result?.checks?.manifestValid === true,
        jsEntry: result?.checks?.jsEntry || '',
        jsEntryExists: result?.checks?.jsEntryExists === true,
        gitMetadataSkipped: result?.checks?.gitMetadataSkipped === true,
        warningCount: Array.isArray(result?.warnings) ? result.warnings.length : 0,
        error: result?.error || '',
    })));
    console.groupEnd();
}

function selectedAccountImportParts(refs) {
    const parts = Array.from(refs.card.querySelectorAll('[data-import-part]:checked'), input => input.value);
    if (!parts.length) {
        setServerAdminMessage(refs.note, 'Choose at least one library to import: chats, personas, character cards or lorebooks.', 'warn');
        toastr.warning('Choose at least one library to import.', 'Import SillyTavern');
        return null;
    }
    return parts;
}

function accountImportPartNames(parts) {
    const labels = { chats: 'chats', personas: 'personas', characters: 'character cards', lorebooks: 'lorebooks' };
    return parts.map(part => labels[part]).join(', ');
}

async function handleSillyTavernFolderImport() {
    const refs = getImporterRefs();

    if (!refs?.pathInput || getImporterState().busy) {
        return;
    }

    const sourcePath = refs.pathInput.value.trim();

    if (!sourcePath) {
        setServerAdminMessage(refs.note, 'Paste the path to your SillyTavern folder or user data folder first.', 'warn');
        toastr.warning('Paste a SillyTavern folder path first.', 'Import SillyTavern');
        refs.pathInput.focus({ preventScroll: true });
        return;
    }

    const parts = selectedAccountImportParts(refs);
    if (!parts) return;
    const confirmed = window.confirm(`Import ${accountImportPartNames(parts)} from this folder?\n\n${sourcePath}\n\nMatching files in the selected libraries will be replaced. Unselected libraries, other account settings, themes, presets and bookkeeping files are left out. A report will list files left out before you reload.`);
    if (!confirmed) {
        return;
    }

    setSillyTavernImportBusy(true);
    renderSillyTavernExtensionSyncReport(null);
    setServerAdminMessage(refs.note, 'Importing folder data… This may take a moment for larger libraries.');

    try {
        const { importAccountData, describeAccountImportSkips, mountAccountImportReportDownload } = await import('./account-import.js');
        const { result } = await importAccountData({ mode: 'folder', content: 'core', parts, path: sourcePath }, { onProgress: showNativeImportProgress });

        if (showSkippedImportFiles(refs, 'Folder import finished.', describeAccountImportSkips(result), result, mountAccountImportReportDownload)) {
            return;
        }

        setServerAdminMessage(refs.note, result?.message || 'Folder import finished. Reloading…', 'good');
        toastr.success(result?.message || 'Folder import finished. Reloading…', 'Import SillyTavern');
        await wait(700);
        location.reload();
    } catch (error) {
        console.error('Failed to import SillyTavern folder.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to import from that folder path.', 'danger');
        toastr.error(error.message || 'Failed to import from that folder path.', 'Import SillyTavern');
    } finally {
        setSillyTavernImportBusy(false);
    }
}

async function handleSillyTavernExtensionSync() {
    const refs = getImporterRefs();

    if (!refs?.pathInput || getImporterState().busy) {
        return;
    }

    const sourcePath = refs.pathInput.value.trim();

    if (!sourcePath) {
        setServerAdminMessage(refs.note, 'Paste the path to your existing SillyTavern folder before syncing extensions.', 'warn');
        toastr.warning('Paste a SillyTavern folder path first.', 'Sync Extensions');
        refs.pathInput.focus({ preventScroll: true });
        return;
    }

    const confirmed = window.confirm(`Sync third-party extensions from this SillyTavern folder into the current Neconyan account?\n\n${sourcePath}\n\nMatching extension folders will be replaced. Neconyan will show a detailed report instead of reloading immediately.`);
    if (!confirmed) {
        return;
    }

    setSillyTavernImportBusy(true);
    renderSillyTavernExtensionSyncReport(null);
    setServerAdminMessage(refs.note, 'Syncing third-party extensions… Neconyan will validate each one and show a report when it finishes.');

    try {
        const { importAccountData } = await import('./account-import.js');
        const { result } = await importAccountData({ mode: 'extensions', path: sourcePath }, { onProgress: showNativeImportProgress });
        const warningCount = Number(result?.warningCount ?? 0) || 0;
        const failedCount = Number(result?.failedCount ?? 0) || 0;
        const needsAttention = warningCount + failedCount > 0;
        const gitMetadataSkippedCount = Number(result?.gitMetadataSkippedCount ?? 0) || 0;
        const message = needsAttention
            ? `${result?.message || 'Extension sync finished with warnings.'} ${getExtensionSyncActivationMessage(result)} Review the report below before reloading.`
            : `${result?.message || 'Extension sync finished.'} ${getExtensionSyncActivationMessage(result)}${gitMetadataSkippedCount > 0 ? ` Git metadata was skipped on ${gitMetadataSkippedCount} extension${gitMetadataSkippedCount === 1 ? '' : 's'} to avoid permission issues, so built-in update tooling may need a reinstall later.` : ''}`;
        const tone = failedCount > 0 ? 'danger' : warningCount > 0 ? 'warn' : 'good';

        renderSillyTavernExtensionSyncReport(result);
        logSillyTavernExtensionSyncReport(result);
        setServerAdminMessage(refs.note, message, tone);

        if (failedCount > 0) {
            toastr.error(result?.message || 'Some extensions could not be synced.', 'Sync Extensions');
        } else if (warningCount > 0) {
            toastr.warning(result?.message || 'Extension sync finished with warnings.', 'Sync Extensions');
        } else {
            toastr.success(result?.message || 'Extension sync finished.', 'Sync Extensions');
        }
    } catch (error) {
        console.error('Failed to sync SillyTavern third-party extensions.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to sync third-party extensions from that folder.', 'danger');
        toastr.error(error.message || 'Failed to sync third-party extensions from that folder.', 'Sync Extensions');
    } finally {
        setSillyTavernImportBusy(false);
    }
}

async function handleSillyTavernZipImport(file) {
    const refs = getImporterRefs();

    if (!(file instanceof File) || getImporterState().busy || !refs) {
        return;
    }

    const parts = selectedAccountImportParts(refs);
    if (!parts) { refs.zipFileInput.value = ''; return; }
    const confirmed = window.confirm(`Import ${accountImportPartNames(parts)} from this backup ZIP?\n\n${file.name}\n\nMatching files in the selected libraries will be replaced. Unselected libraries, other account settings, themes, presets and bookkeeping files are left out. A report will list files left out before you reload.`);
    if (!confirmed) {
        if (refs.zipFileInput instanceof HTMLInputElement) {
            refs.zipFileInput.value = '';
        }

        return;
    }

    setSillyTavernImportBusy(true);
    renderSillyTavernExtensionSyncReport(null);
    setServerAdminMessage(refs.note, 'Importing backup ZIP… This may take a moment for larger libraries.');

    try {
        const { importAccountData, describeAccountImportSkips, mountAccountImportReportDownload } = await import('./account-import.js');
        const { result } = await importAccountData({ mode: 'zip', content: 'core', parts }, { file, onProgress: showNativeImportProgress });

        if (showSkippedImportFiles(refs, 'Backup ZIP imported.', describeAccountImportSkips(result), result, mountAccountImportReportDownload)) {
            return;
        }

        setServerAdminMessage(refs.note, result?.message || 'Backup ZIP imported. Reloading…', 'good');
        toastr.success(result?.message || 'Backup ZIP imported. Reloading…', 'Import SillyTavern');
        await wait(700);
        location.reload();
    } catch (error) {
        console.error('Failed to import SillyTavern backup ZIP.', error);
        setServerAdminMessage(refs.note, error.message || 'Failed to import that backup ZIP.', 'danger');
        toastr.error(error.message || 'Failed to import that backup ZIP.', 'Import SillyTavern');
    } finally {
        if (refs.zipFileInput instanceof HTMLInputElement) {
            refs.zipFileInput.value = '';
        }

        setSillyTavernImportBusy(false);
    }
}

/**
 * Keeps deliberate exclusions and damaged files on screen instead of reloading straight away.
 * @returns {boolean} True when files were skipped and the list is showing.
 */
function showSkippedImportFiles(refs, heading, skips, result, mountReportDownload) {
    if (!skips) {
        return false;
    }

    const count = Number(result?.skippedCount) || 0;
    console.info('Account import files left out.', { excluded: result?.excluded, skipped: result?.skipped });
    setServerAdminMessage(refs.note, `${heading}\n\n${skips}`, count ? 'warn' : 'good');
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'menu_button';
    reload.textContent = 'Reload to use the imported data';
    reload.addEventListener('click', () => location.reload());
    refs.note.append('\n', reload);
    mountReportDownload(refs.note, result);
    if (count) toastr.warning(`${count === 1 ? '1 file could' : `${count} files could`} not be imported. Review the report before reloading.`, 'Import SillyTavern');
    else toastr.success('Selected libraries imported. Review the files left out before reloading.', 'Import SillyTavern');
    return true;
}

function showNativeImportProgress(progress) {
    const total = Number(progress?.total) || 0;
    const completed = Math.min(total, Math.max(0, Number(progress?.completed) || 0));
    const stage = progress?.stage || 'Preparing account import';
    showImportProgress({ percent: null, phase: `${stage}${total ? ` (${completed} of ${total})` : ''}` });
}

function injectSillyTavernImportCard() {
    const importOutlet = document.getElementById('sb-import-tools-outlet');
    const themeBlock = document.getElementById('UI-presets-block');
    const cardHost = importOutlet instanceof HTMLElement
        ? importOutlet
        : themeBlock;
    if (!(cardHost instanceof HTMLElement)) {
        return;
    }

    const existingCard = document.getElementById('sb-import-card');
    if (existingCard instanceof HTMLElement) {
        if (cardHost.firstElementChild !== existingCard) {
            cardHost.prepend(existingCard);
        }

        return;
    }

    const card = createElement('section', { id: 'sb-import-card', className: 'sb-admin-card sb-import-card' });
    const header = createElement('div', { className: 'sb-admin-card-header' });
    const copy = createElement('div', { className: 'sb-admin-card-copy' });
    const title = createElement('strong', { text: 'Import Your SillyTavern Setup' });
    const description = createElement('p', { text: 'Choose which chats, personas, character cards and lorebooks to bring over from a SillyTavern or SillyBunny folder or backup ZIP. Other account settings stay as they are. Files left out are listed after the import.' });
    const badge = createElement('span', { className: 'sb-server-pill', text: 'Easy Import' });
    copy.append(title, description);
    header.append(copy, badge);

    const choicesTitle = createElement('strong', { text: 'Choose what to import' });
    const hintRow = createElement('div', { className: 'sb-import-hints', attrs: { role: 'group', 'aria-label': 'Choose what to import' } });
    for (const [value, text] of [['chats', 'Chats'], ['personas', 'Personas'], ['characters', 'Character cards'], ['lorebooks', 'Lorebooks']]) {
        const label = createElement('label', { className: 'sb-import-chip' });
        const input = createElement('input', { attrs: { type: 'checkbox', value, 'data-import-part': value } });
        input.checked = true;
        label.append(input, createElement('span', { text }));
        hintRow.appendChild(label);
    }

    const grid = createElement('div', { className: 'sb-import-grid' });
    const folderPane = createElement('div', { className: 'sb-import-pane' });
    const folderTitle = createElement('strong', { text: 'Import From Folder Path' });
    const folderBody = createElement('p', { text: 'Paste the path to your SillyTavern install, its data folder, or the user folder you want to import. Import the selected libraries, or use Sync Extensions separately.' });
    const pathRow = createElement('div', { className: 'sb-import-path-row' });
    const actionRow = createElement('div', { className: 'sb-import-action-row' });
    const pathInput = createElement('input', {
        id: 'sb-import-path-input',
        className: 'text_pole sb-import-path-input',
        attrs: {
            type: 'text',
            placeholder: '/path/to/SillyTavern',
            'aria-label': 'SillyTavern folder path',
            autocomplete: 'off',
            spellcheck: 'false',
            title: 'You can paste a full SillyTavern install path, its data folder, or a specific user folder.',
        },
    });
    const folderButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action menu_button_primary',
        attrs: { type: 'button' },
        html: '<i class="fa-solid fa-folder-open" aria-hidden="true"></i><span>Import Folder</span>',
    });
    const syncButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action',
        attrs: { type: 'button' },
        html: '<i class="fa-solid fa-puzzle-piece" aria-hidden="true"></i><span>Sync Extensions</span>',
    });
    pathRow.append(pathInput);
    actionRow.append(folderButton, syncButton);
    folderPane.append(folderTitle, folderBody, pathRow, actionRow);

    const zipPane = createElement('div', { className: 'sb-import-pane' });
    const zipTitle = createElement('strong', { text: 'Import From Backup ZIP' });
    const zipBody = createElement('p', { text: 'Choose a SillyTavern or SillyBunny backup ZIP. Only the libraries ticked above are imported. Chats include group chats and attachments.' });
    const zipButton = createElement('button', {
        className: 'menu_button menu_button_icon sb-server-action menu_button_primary',
        attrs: { type: 'button' },
        html: '<i class="fa-solid fa-file-zipper" aria-hidden="true"></i><span>Import Backup ZIP</span>',
    });
    const zipFileInput = createElement('input', {
        id: 'sb-import-zip-input',
        className: 'sb-import-file-input',
        attrs: {
            type: 'file',
            accept: '.zip,application/zip,application/x-zip-compressed',
            'aria-label': 'Choose a SillyTavern backup ZIP',
        },
    });
    const zipFileName = createElement('small', { className: 'sb-import-file-name', text: 'No ZIP selected yet.' });
    zipPane.append(zipTitle, zipBody, zipButton, zipFileInput, zipFileName);

    const note = createElement('div', {
        className: 'sb-server-note sb-import-note',
        text: 'Matching files in selected libraries are replaced. If Personas is ticked, persona names and descriptions are merged into your current settings. Other preferences, API keys, presets, themes and bookkeeping files are not imported. Review the files left out before reloading.',
    });
    const report = createElement('section', {
        className: 'sb-import-report',
        attrs: { 'aria-live': 'polite' },
    });
    const reportHeader = createElement('div', { className: 'sb-import-report-header' });
    const reportTitle = createElement('strong', { text: 'Third-Party Extension Sync Report' });
    const reportSummary = createElement('p', { className: 'sb-import-report-summary' });
    const reportHelp = createElement('p', { className: 'sb-import-report-help' });
    const reportList = createElement('div', { className: 'sb-import-report-list' });

    reportHeader.append(reportTitle);
    report.append(reportHeader, reportSummary, reportHelp, reportList);
    report.hidden = true;

    grid.append(folderPane, zipPane);
    const progressLabel = createElement('div', { id: 'sb-import-progress-label', attrs: { role: 'status', 'aria-live': 'polite' } });
    const progress = createElement('progress', { attrs: { max: '100', 'aria-labelledby': 'sb-import-progress-label' } });
    progress.hidden = true;
    progress.style.width = '100%';
    card.append(header, choicesTitle, hintRow, grid, progressLabel, progress, note, report);
    cardHost.prepend(card);

    void import('./roleplay-recovery-ui.js').then(module => module.mountRoleplayRecovery(cardHost))
        .catch(error => console.error('Could not load transferred-data repair:', error));

    getImporterState().refs = {
        progress,
        progressLabel,
        card,
        pathInput,
        folderButton,
        syncButton,
        zipButton,
        zipFileInput,
        zipFileName,
        note,
        report,
        reportSummary,
        reportHelp,
        reportList,
    };

    void import('./account-import.js').then(module => module.mountSavedAccountImports(card, {
        onBusy: setSillyTavernImportBusy,
        onResult: result => {
            renderSillyTavernExtensionSyncReport(result.mode === 'extensions' ? result : null);
            if (result.mode === 'extensions') logSillyTavernExtensionSyncReport(result);
        },
    })).catch(error => setServerAdminMessage(note, error.message, 'danger'));

    folderButton.addEventListener('click', handleSillyTavernFolderImport);
    syncButton.addEventListener('click', handleSillyTavernExtensionSync);
    pathInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void handleSillyTavernFolderImport();
        }
    });

    zipButton.addEventListener('click', () => zipFileInput.click());
    zipFileInput.addEventListener('change', () => {
        const [file] = Array.from(zipFileInput.files ?? []);
        zipFileName.textContent = file?.name || 'No ZIP selected yet.';

        if (file) {
            void handleSillyTavernZipImport(file);
        }
    });

    updateSillyTavernImportInteractivity();
}

function createThemeSettingsDrawer({ id, title, content, className = '' }) {
    const drawer = createElement('section', {
        id,
        className: `inline-drawer sb-theme-settings-drawer ${className}`.trim(),
        attrs: {
            'data-settings-tab': 'appearance',
        },
    });
    const header = createElement('div', { className: 'inline-drawer-toggle inline-drawer-header' });
    const heading = createElement('strong', { text: title });
    const icon = createElement('div', { className: 'fa-solid fa-circle-chevron-down inline-drawer-icon down' });
    const body = createElement('div', { className: 'inline-drawer-content sb-theme-settings-drawer-body' });
    body.style.display = 'none';

    header.append(heading);
    header.append(icon);
    body.append(...content);
    drawer.append(header, body);
    return drawer;
}

function createThemeSliderGroup({ title, valueId, inputId, value, min, max, step, ariaLabel, caption, onInput, className = '' }) {
    const sliderGroup = createElement('div', { className: `sb-theme-slider-group ${className}`.trim() });
    const sliderHeader = createElement('div', { className: 'sb-theme-slider-header' });
    const sliderTitle = createElement('strong', { text: title });
    const sliderValue = createElement('span', { id: valueId, className: 'sb-theme-slider-value' });
    const sliderInput = createElement('input', {
        id: inputId,
        className: 'sb-theme-slider-input',
        attrs: {
            type: 'range',
            min: String(min),
            max: String(max),
            step: String(step),
            value: String(value),
            'aria-label': ariaLabel,
        },
    });
    const sliderCaption = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: caption,
    });

    sliderHeader.append(sliderTitle, sliderValue);
    sliderGroup.append(sliderHeader, sliderInput, sliderCaption);
    sliderInput.addEventListener('input', event => onInput(event.currentTarget?.value));

    return sliderGroup;
}

function createTopbarLabelOption(mode, part) {
    const inputId = `sb-topbar-label-${mode}-${part.id}`;
    const option = createElement('label', {
        className: 'sb-topbar-label-option',
        attrs: {
            for: inputId,
        },
    });
    const checkbox = createElement('input', {
        id: inputId,
        className: 'sb-topbar-label-checkbox',
        attrs: {
            type: 'checkbox',
            'data-sb-topbar-label-mode': mode,
            'data-sb-topbar-label-part': part.id,
        },
    });
    const copy = createElement('span', { className: 'sb-topbar-label-option-copy' });
    const title = createElement('strong', { text: part.label });
    const description = createElement('small', { text: part.description });

    checkbox.addEventListener('change', event => {
        const input = event.currentTarget;
        const isChecked = input instanceof HTMLInputElement ? input.checked : false;

        if (mode === 'mobile') {
            setMobileTopbarLabelPart(part.id, isChecked);
        } else {
            setDesktopTopbarLabelPart(part.id, isChecked);
        }
    });

    copy.append(title, description);
    option.append(checkbox, copy);
    return option;
}

function createShortcutSettingsGroup() {
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: 'Assign a shell tab or universal search to each shortcut button in the top bar.',
    });
    const rows = createElement('div', {
        className: 'sb-shortcut-rows',
    });

    for (const side of NN_SHORTCUT_SLOTS) {
        const selectId = `sb-shortcut-${side}-select`;
        const row = createElement('div', { className: 'sb-shortcut-row' });

        const label = createElement('label', {
            className: 'sb-shortcut-label',
            attrs: {
                for: selectId,
            },
        });
        label.textContent = NN_SHORTCUT_LABELS[side] || side;

        const select = createElement('select', {
            id: selectId,
            className: 'sb-shortcut-select',
        });

        const currentTarget = getShortcutTarget(side);
        for (const target of NN_SHORTCUT_TARGETS) {
            const option = createElement('option', {
                attrs: { value: target.value },
            });
            option.textContent = target.label;
            option.selected = target.value === currentTarget;
            select.appendChild(option);
        }

        select.addEventListener('change', () => {
            const key = NN_SHORTCUT_STORAGE_KEYS[side];
            if (key) {
                safeSetItem(key, select.value);
            }
            updateShortcutButton(side);
        });

        row.append(label, select);
        rows.appendChild(row);
    }

    return createThemeSettingsDrawer({
        id: 'sb-quick-access-shortcuts-drawer',
        title: 'Quick Access Shortcuts',
        content: [description, rows],
    });
}

function getMobileQuickActionContextLabel(action) {
    const normalizedAction = normalizeMobileQuickAction(action);
    if (!normalizedAction) {
        return '';
    }

    const shellLabel = normalizedAction.shellKey === 'characters'
        ? 'Characters'
        : getShellConfig(normalizedAction.shellKey)?.title || normalizedAction.shellKey;
    const tabLabel = normalizedAction.shellKey === 'characters'
        ? getCharacterPanelTabConfig(normalizedAction.tabId)?.label || normalizedAction.tabId
        : getShellState(normalizedAction.shellKey)?.tabs?.get(normalizedAction.tabId)?.label
        || getMobileQuickActionTabConfig(normalizedAction.shellKey, normalizedAction.tabId)?.label
        || normalizedAction.tabId;
    const labels = [shellLabel, tabLabel];

    if (normalizedAction.type === 'custom'
        && normalizedAction.sectionLabel
        && normalizeText(normalizedAction.sectionLabel) !== normalizeText(tabLabel)) {
        labels.push(normalizedAction.sectionLabel);
    }

    return labels.join(' · ');
}

function createMobileQuickActionIconElement(iconClass) {
    return createElement('i', {
        className: `fa-solid ${normalizeFontAwesomeIcon(iconClass)}`,
        attrs: {
            'aria-hidden': 'true',
        },
    });
}

function createMobileQuickActionIconControl(action, actionKey, mode = 'mobile') {
    const normalizedAction = normalizeMobileQuickAction(action);
    const iconClass = normalizedAction?.icon || NN_MOBILE_QUICK_ACTION_ICON_FALLBACK;

    if (normalizedAction?.type === 'custom') {
        const button = createElement('button', {
            className: 'menu_button menu_button_icon sb-mobile-quick-action-icon-picker',
            attrs: {
                type: 'button',
                title: `Choose icon for ${normalizedAction.label}`,
                'aria-label': `Choose icon for ${normalizedAction.label}`,
            },
        });
        button.appendChild(createMobileQuickActionIconElement(iconClass));
        button.addEventListener('click', () => {
            void chooseQuickActionIcon(mode, actionKey);
        });
        return button;
    }

    const preview = createElement('span', {
        className: 'sb-mobile-quick-action-icon-preview',
        attrs: {
            title: normalizedAction ? `${normalizedAction.label} icon` : 'Quick Action icon',
            'aria-hidden': 'true',
        },
    });
    preview.appendChild(createMobileQuickActionIconElement(iconClass));
    return preview;
}

function updateMobileQuickActionSettingsStatus(mode = 'mobile') {
    const currentActions = getQuickActionState(mode);
    const status = document.getElementById(`sb-${mode}-quick-action-status`);
    if (status instanceof HTMLElement) {
        status.textContent = mode === 'desktop'
            ? `${currentActions.length}/${NN_MOBILE_QUICK_ACTION_LIMIT} selected. This list controls the desktop side rail shortcuts.`
            : `${currentActions.length}/${NN_MOBILE_QUICK_ACTION_LIMIT} selected. This list replaces the mobile quick shortcuts.`;
    }

    const resetButton = document.getElementById(`sb-${mode}-quick-action-reset`);
    if (resetButton instanceof HTMLButtonElement) {
        const currentKeys = currentActions.map(getMobileQuickActionKey);
        const defaultKeys = (mode === 'desktop' ? getDefaultDesktopQuickActions() : getDefaultMobileQuickActions()).map(getMobileQuickActionKey);
        resetButton.disabled = currentKeys.length === defaultKeys.length
            && currentKeys.every((key, index) => key === defaultKeys[index]);
    }
}

function refreshMobileQuickActionSearchResults(mode = 'mobile') {
    const searchInput = document.getElementById(`sb-${mode}-quick-action-search`);
    const results = document.getElementById(`sb-${mode}-quick-action-results`);

    if (searchInput instanceof HTMLInputElement && results instanceof HTMLElement) {
        renderMobileQuickActionResults(searchInput.value, results, mode);
    }
}

function renderMobileQuickActionResults(query, resultsElement, mode = 'mobile') {
    if (!(resultsElement instanceof HTMLElement)) {
        return;
    }

    const modeLabel = mode === 'desktop' ? 'desktop' : 'mobile';

    resultsElement.replaceChildren();

    const trimmedQuery = String(query ?? '').trim();
    if (trimmedQuery.length < 2) {
        resultsElement.appendChild(createElement('div', {
            className: 'sb-mobile-quick-action-empty',
            text: 'Type at least 2 characters to find settings and extensions.',
        }));
        return;
    }

    const matches = getMobileQuickActionSearchMatches(trimmedQuery);
    if (!matches.length) {
        resultsElement.appendChild(createElement('div', {
            className: 'sb-mobile-quick-action-empty',
            text: `No matches for "${trimmedQuery}" yet.`,
        }));
        return;
    }

    const currentActions = getQuickActionState(mode);
    const currentKeys = new Set(currentActions.map(getMobileQuickActionKey));
    for (const match of matches) {
        const action = createMobileQuickActionFromMatch(match);
        if (!action) {
            continue;
        }

        const actionKey = getMobileQuickActionKey(action);
        const isAdded = currentKeys.has(actionKey);
        const isFull = currentActions.length >= NN_MOBILE_QUICK_ACTION_LIMIT;
        const buttonText = isAdded ? 'Added' : isFull ? 'Full' : 'Add';
        const row = createElement('div', { className: 'sb-mobile-quick-action-result' });
        const copy = createElement('span', { className: 'sb-mobile-quick-action-copy' });
        const title = createElement('strong', { text: action.label });
        const detail = createElement('small', {
            text: `${match.shellLabel} · ${match.tabLabel}${action.sectionLabel ? ` · ${action.sectionLabel}` : ''}`,
        });
        const button = createElement('button', {
            className: 'menu_button sb-mobile-quick-action-add',
            text: buttonText,
            attrs: {
                type: 'button',
                'aria-label': isAdded
                    ? `${action.label} is already in ${modeLabel} Quick Actions`
                    : `Add ${action.label} to ${modeLabel} Quick Actions`,
            },
        });

        button.disabled = isAdded || isFull;
        button.addEventListener('click', () => addQuickActionFromMatch(mode, match));

        copy.append(title, detail);
        row.append(copy, button);
        resultsElement.appendChild(row);
    }
}

function renderMobileQuickActionSettingsList(mode = 'mobile') {
    updateMobileQuickActionSettingsStatus(mode);

    const list = document.getElementById(`sb-${mode}-quick-action-list`);
    if (!(list instanceof HTMLElement)) {
        return;
    }

    const modeLabel = mode === 'desktop' ? 'desktop' : 'mobile';
    const currentActions = getQuickActionState(mode);

    list.replaceChildren();

    if (!currentActions.length) {
        list.appendChild(createElement('div', {
            className: 'sb-mobile-quick-action-empty',
            text: `No ${modeLabel} Quick Actions selected. Add one from search or reset to defaults.`,
        }));
        return;
    }

    for (const action of currentActions) {
        const actionKey = getMobileQuickActionKey(action);
        const row = createElement('div', { className: 'sb-mobile-quick-action-current' });
        const copy = createElement('span', { className: 'sb-mobile-quick-action-copy' });
        const title = createElement('strong', { text: action.label });
        const detail = createElement('small', { text: getMobileQuickActionContextLabel(action) });
        const controls = createElement('span', { className: 'sb-mobile-quick-action-controls' });
        const iconControl = createMobileQuickActionIconControl(action, actionKey, mode);
        const removeButton = createElement('button', {
            className: 'menu_button sb-mobile-quick-action-remove',
            text: 'Remove',
            attrs: {
                type: 'button',
                'aria-label': `Remove ${action.label} from ${modeLabel} Quick Actions`,
            },
        });

        removeButton.addEventListener('click', () => removeQuickAction(mode, actionKey));

        copy.append(title, detail);
        controls.append(iconControl, removeButton);
        row.append(copy, controls);
        list.appendChild(row);
    }
}

function createMobileQuickActionSettingsGroup(mode = 'mobile') {
    const isDesktop = mode === 'desktop';
    const modeTitle = isDesktop ? 'Desktop' : 'Mobile';
    const modeLabel = isDesktop ? 'desktop' : 'mobile';
    const group = createElement('section', {
        className: `sb-theme-slider-group sb-mobile-quick-actions-group sb-${mode}-quick-actions-group`,
    });
    const header = createElement('div', { className: 'sb-mobile-quick-action-header' });
    const heading = createElement('div', { className: 'sb-mobile-quick-action-heading' });
    const title = createElement('strong', { text: `${modeTitle} Quick Actions` });
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: isDesktop
            ? 'Choose the shortcuts shown beneath Fine-tuning in the desktop sidebar. Defaults can be removed or restored.'
            : 'Choose the shortcuts shown beneath Fine-tuning in the phone sidebar. Defaults can be removed or restored.',
    });
    const resetButton = createElement('button', {
        id: `sb-${mode}-quick-action-reset`,
        className: 'menu_button sb-mobile-quick-action-reset',
        text: 'Reset to defaults',
        attrs: {
            type: 'button',
        },
    });

    const searchInput = createElement('input', {
        id: `sb-${mode}-quick-action-search`,
        className: 'text_pole sb-mobile-quick-action-search',
        attrs: {
            type: 'search',
            placeholder: 'Search settings or extensions...',
            autocomplete: 'off',
            'aria-label': `Search settings and extensions to add as ${modeLabel} Quick Actions`,
        },
    });
    const results = createElement('div', {
        id: `sb-${mode}-quick-action-results`,
        className: 'sb-mobile-quick-action-results',
    });
    const list = createElement('div', {
        id: `sb-${mode}-quick-action-list`,
        className: 'sb-mobile-quick-action-list',
    });
    const status = createElement('p', {
        id: `sb-${mode}-quick-action-status`,
        className: 'sb-theme-slider-caption',
    });

    heading.append(title, description);
    header.append(heading, resetButton);

    resetButton.addEventListener('click', isDesktop ? resetDesktopQuickActions : resetMobileQuickActions);

    searchInput.addEventListener('input', event => {
        const input = event.currentTarget;
        renderMobileQuickActionResults(input instanceof HTMLInputElement ? input.value : '', results, mode);
    });

    group.append(header, searchInput, results, list, status);
    renderMobileQuickActionResults('', results, mode);

    window.requestAnimationFrame(() => renderMobileQuickActionSettingsList(mode));
    return group;
}

function createCompactModeSettingsGroup(mode = 'mobile') {
    const inputId = mode === 'desktop' ? 'sb-desktop-compact-mode-input' : 'sb-mobile-compact-mode-input';
    const group = createElement('section', {
        className: 'sb-theme-slider-group sb-compact-mode-group',
    });
    const label = createElement('label', {
        className: 'sb-compact-mode-option',
        attrs: {
            for: inputId,
        },
    });
    const checkbox = createElement('input', {
        id: inputId,
        className: 'sb-compact-mode-checkbox',
        attrs: {
            type: 'checkbox',
            'data-sb-compact-mode-input': mode,
        },
    });
    const copy = createElement('span', { className: 'sb-compact-mode-copy' });
    const title = createElement('strong', { text: 'Compact Mode' });
    const description = createElement('small', {
        text: 'Reduce spacing, controls, and mobile composer height for denser screens.',
    });

    checkbox.addEventListener('change', event => {
        const input = event.currentTarget;
        setCompactMode(input instanceof HTMLInputElement && input.checked);
    });

    copy.append(title, description);
    label.append(checkbox, copy);
    group.appendChild(label);
    return group;
}

function createBottomChatBarSettingsGroup(mode = 'mobile') {
    const inputId = mode === 'desktop' ? 'sb-desktop-bottom-bar-visible-input' : 'sb-mobile-bottom-bar-visible-input';
    const group = createElement('section', {
        className: 'sb-theme-slider-group sb-compact-mode-group',
    });
    const label = createElement('label', {
        className: 'sb-compact-mode-option',
        attrs: {
            for: inputId,
        },
    });
    const checkbox = createElement('input', {
        id: inputId,
        className: 'sb-compact-mode-checkbox sb-bottom-bar-visible-checkbox',
        attrs: {
            type: 'checkbox',
            'data-sb-bottom-bar-visible-input': mode,
        },
    });
    const copy = createElement('span', { className: 'sb-compact-mode-copy' });
    const title = createElement('strong', { text: 'Show Bottom Chat Bar' });
    const description = createElement('small', {
        text: 'Display the bottom bar with the chat switcher, persona picker, and chat actions.',
    });

    checkbox.addEventListener('change', event => {
        const input = event.currentTarget;
        setBottomChatBarVisible(input instanceof HTMLInputElement && input.checked);
    });

    copy.append(title, description);
    label.append(checkbox, copy);
    group.appendChild(label);
    return group;
}

function createRailOrderSettingsGroup(mode) {
    const inputId = `sb-${mode}-rail-reorder-input`;
    const group = createElement('section', { className: 'sb-theme-slider-group sb-compact-mode-group' });
    const label = createElement('label', { className: 'sb-compact-mode-option', attrs: { for: inputId } });
    const checkbox = createElement('input', {
        id: inputId, className: 'sb-compact-mode-checkbox',
        attrs: { type: 'checkbox', 'data-sb-rail-reorder-input': mode, 'aria-describedby': `${inputId}-hint` },
    });
    const enabled = globalThis.NeconyanWelcome?.isRailReordering?.();
    checkbox.checked = enabled === true;
    checkbox.disabled = enabled === undefined;
    checkbox.addEventListener('change', () => globalThis.NeconyanWelcome?.setRailReordering?.(checkbox.checked));
    const copy = createElement('span', { className: 'sb-compact-mode-copy' });
    copy.append(
        createElement('strong', { text: 'Reorder sidebar' }),
        createElement('small', { id: `${inputId}-hint`, text: 'Drag the grips within Workspace, Fine-tuning or Modes. On phones, hold a grip first. With a row focused, use Alt + Up/Down. Turning this off keeps your order.' }),
    );
    const reset = createElement('button', {
        className: 'menu_button widthNatural', text: 'Reset sidebar order',
        attrs: { type: 'button', 'data-sb-rail-order-reset': mode },
    });
    reset.disabled = enabled === undefined;
    reset.addEventListener('click', () => globalThis.NeconyanWelcome?.resetRailOrder?.());
    label.append(checkbox, copy);
    group.append(label, reset);
    return group;
}

function createMobileNavChoice({ id, type = 'radio', name = '', value = '', label, icon, onChange }) {
    const choice = createElement('label', {
        className: 'sb-mobile-nav-choice',
        attrs: {
            for: id,
        },
    });
    const inputAttrs = {
        type,
        value,
    };

    if (name) {
        inputAttrs.name = name;
    }

    const input = createElement('input', {
        id,
        className: 'sb-mobile-nav-choice-input',
        attrs: inputAttrs,
    });
    const iconElement = createElement('i', {
        className: `fa-solid ${icon} sb-mobile-nav-choice-icon`,
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const copy = createElement('span', { className: 'sb-mobile-nav-choice-copy' });
    const title = createElement('strong', { text: label });

    input.addEventListener('change', event => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLInputElement)) {
            return;
        }

        if (target.type === 'radio' && !target.checked) {
            return;
        }

        onChange?.(target);
    });

    copy.appendChild(title);
    choice.append(input, iconElement, copy);
    return choice;
}

function createMobileNavDivider(label = '') {
    const divider = createElement('div', {
        className: 'sb-mobile-nav-settings-divider',
        attrs: label ? { role: 'separator', 'aria-label': label } : { role: 'separator' },
    });
    if (label) {
        divider.appendChild(createElement('span', { text: label }));
    }
    return divider;
}

function createNavigationSettingsGroup(mode = 'mobile') {
    const isDesktop = mode === 'desktop';
    const modeTitle = isDesktop ? 'Desktop' : 'Mobile';
    const modePrefix = isDesktop ? 'desktop' : 'mobile';
    const group = createElement('section', {
        className: `sb-theme-slider-group sb-mobile-nav-layout-group sb-${modePrefix}-nav-layout-group`,
    });
    const header = createElement('div', { className: 'sb-mobile-nav-settings-header' });
    const title = createElement('strong', { text: `${modeTitle} Navigation` });

    const iconOnlyChoice = createMobileNavChoice({
        id: `sb-${modePrefix}-nav-icon-only-input`,
        type: 'checkbox',
        value: 'icon-only',
        label: 'Icons only in shell tabs',
        icon: 'fa-icons',
        onChange: input => isDesktop ? setDesktopNavIconOnly(input.checked) : setMobileNavIconOnly(input.checked),
    });
    // Neconyan: stored per device -- this group's copy governs its own viewport only, exactly
    // like the shell-tab toggle above it -- and it belongs with navigation rather than nested
    // inside the Quick Access Shortcuts drawer. Sitting next to the shell-tab toggle also keeps
    // the two similarly named options readable side by side.
    const showCustomizeChoice = createMobileNavChoice({
        id: `sb-${modePrefix}-nav-show-customize-input`,
        type: 'checkbox',
        value: 'show-customize',
        label: getMobileNavCustomizeLocationLabel(mode),
        icon: 'fa-screwdriver-wrench',
        onChange: input => isDesktop ? setDesktopNavShowCustomize(input.checked) : setMobileNavShowCustomize(input.checked),
    });
    const showQuickActionsChoice = createMobileNavChoice({
        id: `sb-${modePrefix}-nav-show-quick-actions-input`,
        type: 'checkbox',
        value: 'show-quick-actions',
        label: 'Show Custom Quick Actions at the top bar',
        icon: 'fa-bolt',
        onChange: input => isDesktop ? setDesktopNavShowQuickActions(input.checked) : setMobileNavShowQuickActions(input.checked),
    });

    header.appendChild(title);
    group.append(
        header,
        iconOnlyChoice,
        createMobileNavDivider(),
        showCustomizeChoice,
        showQuickActionsChoice,
    );
    return group;
}

function createMobileNavLayoutSettingsGroup() {
    return createNavigationSettingsGroup('mobile');
}

function createDesktopNavLayoutSettingsGroup() {
    return createNavigationSettingsGroup('desktop');
}

function createDesktopShellSizingSettingsGroup() {
    const group = createElement('section', {
        className: 'sb-theme-slider-group sb-desktop-shell-sizing-group sb-desktop-setting',
    });
    const header = createElement('div', { className: 'sb-mobile-nav-settings-header' });
    const title = createElement('strong', { text: 'Panel Sizing' });
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: 'Keep Model, Settings, and Characters aligned with the active chat width.',
    });
    const snapChoice = createMobileNavChoice({
        id: 'sb-desktop-shell-snap-to-chat-input',
        type: 'checkbox',
        value: 'snap-to-chat-width',
        label: 'Snap to chat width',
        icon: 'fa-arrows-left-right-to-line',
        onChange: input => setDesktopShellSnapToChatWidth(input.checked),
    });

    header.append(title, description);
    group.append(header, snapChoice);
    return group;
}

function createPaperTextureSettingsGroup() {
    const group = createElement('section', {
        className: 'sb-theme-slider-group sb-paper-texture-group',
    });
    const header = createElement('div', { className: 'sb-mobile-nav-settings-header' });
    const title = createElement('strong', { text: 'Paper Texture' });
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: 'Add a subtle paper grain and wash overlay to the chat background.',
    });
    const toggleChoice = createMobileNavChoice({
        id: 'sb-paper-texture-enabled-input',
        type: 'checkbox',
        value: 'paper-texture-enabled',
        label: 'Enable paper texture',
        icon: 'fa-scroll',
        onChange: input => setPaperTextureEnabled(input.checked),
    });
    const opacitySliderGroup = createThemeSliderGroup({
        title: 'Texture opacity',
        valueId: 'sb-paper-texture-opacity-value',
        inputId: 'sb-paper-texture-opacity-input',
        value: nnState.paperTextureOpacity,
        min: NN_PAPER_TEXTURE_OPACITY.min,
        max: NN_PAPER_TEXTURE_OPACITY.max,
        step: NN_PAPER_TEXTURE_OPACITY.step,
        ariaLabel: 'Paper texture opacity',
        caption: 'Higher values make the paper grain and wash more visible.',
        onInput: nextValue => setPaperTextureOpacity(nextValue),
    });

    header.append(title, description);
    group.append(header, toggleChoice, opacitySliderGroup);
    return group;
}

function createFrontendIconSettingsGroup() {
    const group = createElement('section', {
        className: 'sb-interface-settings-group sb-frontend-icon-group',
    });
    const header = createElement('div', { className: 'sb-frontend-icon-header' });
    const title = createElement('strong', { text: 'Frontend Icon' });
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: 'Choose the icon for your browser tab and system messages.',
    });
    const options = createElement('div', { className: 'sb-frontend-icon-options' });

    header.append(title, description);

    for (const icon of NN_FRONTEND_ICONS) {
        const button = createElement('button', {
            className: 'sb-theme-option sb-frontend-icon-option',
            attrs: {
                type: 'button',
                'data-sb-frontend-icon-option': icon.id,
            },
        });
        const preview = createElement('img', {
            className: 'sb-frontend-icon-preview',
            attrs: {
                src: getFrontendIconSrc(icon.id),
                'data-assistant-icon': icon.id,
                alt: '',
                loading: 'lazy',
            },
        });
        const copy = createElement('span', { className: 'sb-frontend-icon-copy' });
        const label = createElement('span', { className: 'sb-theme-option-label', text: icon.label });
        const meta = createElement('span', { className: 'sb-theme-option-meta', text: icon.description });

        copy.append(label, meta);
        button.append(preview, copy);
        button.addEventListener('click', () => setFrontendIconPreference(icon.id));
        options.appendChild(button);
    }

    group.append(header, options);
    return group;
}

function updateShortcutButton(side) {
    const buttonId = getShortcutButtonId(side);
    const button = document.getElementById(buttonId);
    if (!(button instanceof HTMLElement)) return;

    const target = getShortcutTarget(side);
    const config = getShortcutConfig(target);
    const icon = button.querySelector('i');
    const span = button.querySelector('span');
    const isDisabled = target === 'none';

    if (isDisabled) {
        button.style.setProperty('display', 'none', 'important');
    } else {
        button.style.removeProperty('display');
    }

    if (icon) {
        icon.className = `fa-solid ${config.icon}`;
    }
    if (span) {
        span.textContent = config.label;
    }
    button.title = t`Quick access: ${translate(config.label)}`;
    button.setAttribute('aria-label', t`Quick access: ${translate(config.label)}`);
    button.dataset.sbUniversalSearchTrigger = String(isSearchShortcutTarget(target));
    syncTopbarIconsOnlyDedupe();
    syncShortcutButtonActiveStates();
    queueTopbarBrandFit();
}

function syncShortcutButtonActiveStates() {
    const searchExpanded = getUniversalSearchState().expanded;

    for (const side of NN_SHORTCUT_SLOTS) {
        const buttonId = getShortcutButtonId(side);
        const button = document.getElementById(buttonId);

        if (!(button instanceof HTMLButtonElement)) {
            continue;
        }

        const target = getShortcutTarget(side);
        setButtonPressed(button, isSearchShortcutTarget(target) && searchExpanded);
    }

    queueTopbarPageStateSync();
}

function createTopbarLabelSettingsGroup() {
    const description = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: 'Choose what the center label shows. Desktop can mix multiple parts with a middle dot, while mobile keeps one selection at a time.',
    });
    const desktopSection = createElement('div', { className: 'sb-topbar-label-section sb-desktop-setting' });
    const desktopHeading = createElement('div', { className: 'sb-topbar-label-section-heading' });
    const desktopTitle = createElement('strong', { text: 'Desktop' });
    const desktopDescription = createElement('small', { text: 'Pick any combination you want.' });
    const desktopGrid = createElement('div', { className: 'sb-topbar-label-option-grid' });
    const mobileSection = createElement('div', { className: 'sb-topbar-label-section sb-mobile-setting' });
    const mobileHeading = createElement('div', { className: 'sb-topbar-label-section-heading' });
    const mobileTitle = createElement('strong', { text: 'Mobile' });
    const mobileDescription = createElement('small', { text: 'Pick one option at a time.' });
    const mobileGrid = createElement('div', { className: 'sb-topbar-label-option-grid' });
    const customTextField = createElement('label', {
        className: 'sb-topbar-custom-text-field',
        attrs: {
            for: 'sb-topbar-custom-text-input',
        },
    });
    const customTextHeading = createElement('div', { className: 'sb-topbar-label-section-heading' });
    const customTextTitle = createElement('strong', { text: 'Custom Text Value' });
    const customTextDescription = createElement('small', { text: 'This only appears in the top bar when the Custom Text checkbox is enabled above.' });
    const customTextInput = createElement('input', {
        id: 'sb-topbar-custom-text-input',
        className: 'text_pole sb-topbar-custom-text-input',
        attrs: {
            type: 'text',
            maxlength: String(NN_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH),
            placeholder: 'Neconyan',
            'aria-label': 'Top bar custom text',
        },
    });

    customTextInput.addEventListener('input', event => {
        const input = event.currentTarget;
        setTopbarCustomText(input instanceof HTMLInputElement ? input.value : '');
    });

    const clickCycleId = 'sb-topbar-label-click-cycle-input';
    const clickCycleOption = createElement('label', {
        className: 'sb-topbar-label-option sb-topbar-label-click-cycle-option',
        attrs: {
            for: clickCycleId,
        },
    });
    const clickCycleCheckbox = createElement('input', {
        id: clickCycleId,
        className: 'sb-topbar-label-checkbox',
        attrs: {
            type: 'checkbox',
            'data-sb-topbar-label-click-cycle-input': 'true',
        },
    });
    const clickCycleCopy = createElement('span', { className: 'sb-topbar-label-option-copy' });
    const clickCycleTitle = createElement('strong', { text: 'Tap The Title To Switch Label' });
    const clickCycleDescription = createElement('small', { text: 'When enabled, tapping the label switches between character name, context size and custom text and saves the choice for this device. When disabled, tapping the label returns to the chat.' });

    clickCycleCheckbox.addEventListener('change', event => {
        const input = event.currentTarget;
        setTopbarLabelClickCycle(input instanceof HTMLInputElement ? input.checked : true);
    });

    clickCycleCopy.append(clickCycleTitle, clickCycleDescription);
    clickCycleOption.append(clickCycleCheckbox, clickCycleCopy);

    desktopHeading.append(desktopTitle, desktopDescription);
    mobileHeading.append(mobileTitle, mobileDescription);
    customTextHeading.append(customTextTitle, customTextDescription);

    for (const part of NN_TOPBAR_LABEL_PARTS) {
        desktopGrid.appendChild(createTopbarLabelOption('desktop', part));
        mobileGrid.appendChild(createTopbarLabelOption('mobile', part));
    }

    desktopSection.append(desktopHeading, desktopGrid);
    mobileSection.append(mobileHeading, mobileGrid);
    customTextField.append(customTextHeading, customTextInput);

    return createThemeSettingsDrawer({
        id: 'sb-topbar-label-drawer',
        title: 'Top Bar Label',
        content: [description, desktopSection, mobileSection, customTextField, clickCycleOption],
    });
}

function injectThemePicker() {
    if (document.getElementById('UI-presets-block')?.dataset.themePickerInitialized === 'true') {
        updateThemePickerUi();
        return;
    }

    const themeBlock = document.getElementById('UI-presets-block');
    if (!(themeBlock instanceof HTMLElement)) {
        return;
    }

    const card = createElement('div', { id: 'sb-theme-card', className: 'sb-theme-card' });
    const description = createElement('p', { text: 'Switch the navigation shell between built-in visual directions.' });
    const optionRow = createElement('div', { className: 'sb-theme-option-row' });
    const surfaceSliderGroup = createThemeSliderGroup({
        title: 'Background Visibility',
        valueId: 'sb-surface-transparency-value',
        inputId: 'sb-surface-transparency-input',
        value: nnState.surfaceTransparency,
        min: NN_SURFACE_TRANSPARENCY.min,
        max: NN_SURFACE_TRANSPARENCY.max,
        step: NN_SURFACE_TRANSPARENCY.step,
        ariaLabel: 'Background visibility',
        caption: 'Higher values make the home and chat surfaces more transparent so your selected background picture shows through.',
        onInput: nextValue => setSurfaceTransparency(nextValue),
        className: 'sb-interface-settings-group',
    });
    const bottomBarSliderGroup = createThemeSliderGroup({
        title: 'Bottom Bar Size',
        valueId: 'sb-bottom-bar-scale-value',
        inputId: 'sb-bottom-bar-scale-input',
        value: nnState.bottomBarScale,
        min: NN_TOPBAR_SCALE.min,
        max: NN_TOPBAR_SCALE.max,
        step: NN_TOPBAR_SCALE.step,
        ariaLabel: 'Bottom bar size',
        caption: 'Resize the bottom chat bar, send form, and action buttons without editing CSS.',
        onInput: nextValue => setBottomBarScale(nextValue),
        className: 'sb-interface-settings-group',
    });
    const desktopButtonSliderGroup = createThemeSliderGroup({
        title: 'Desktop Button Size',
        valueId: 'sb-desktop-button-scale-value',
        inputId: 'sb-desktop-button-scale-input',
        value: nnState.desktopButtonScale,
        min: NN_TOPBAR_SCALE.min,
        max: NN_TOPBAR_SCALE.max,
        step: NN_TOPBAR_SCALE.step,
        ariaLabel: 'Desktop button size',
        caption: 'Increase or decrease the desktop top bar and shell navigation buttons without changing mobile controls.',
        onInput: nextValue => setDesktopButtonScale(nextValue),
        className: 'sb-desktop-setting',
    });
    const mobileButtonSliderGroup = createThemeSliderGroup({
        title: 'Mobile Button Size',
        valueId: 'sb-mobile-button-scale-value',
        inputId: 'sb-mobile-button-scale-input',
        value: nnState.mobileButtonScale,
        min: NN_TOPBAR_SCALE.min,
        max: NN_TOPBAR_SCALE.max,
        step: NN_TOPBAR_SCALE.step,
        ariaLabel: 'Mobile button size',
        caption: 'Increase or decrease the mobile nav and mobile chat tool buttons without changing desktop controls.',
        onInput: nextValue => setMobileButtonScale(nextValue),
        className: 'sb-mobile-only-setting',
    });
    const topbarLabelSettingsGroup = createTopbarLabelSettingsGroup();
    const desktopNavLayoutSettingsGroup = createDesktopNavLayoutSettingsGroup();
    const desktopShellSizingSettingsGroup = createDesktopShellSizingSettingsGroup();
    const mobileNavLayoutSettingsGroup = createMobileNavLayoutSettingsGroup();
    const desktopSettingsDivider = createMobileNavDivider();
    const mobileSettingsDivider = createMobileNavDivider();
    const desktopCompactModeSettingsGroup = createCompactModeSettingsGroup('desktop');
    const mobileCompactModeSettingsGroup = createCompactModeSettingsGroup('mobile');
    const desktopBottomChatBarSettingsGroup = createBottomChatBarSettingsGroup('desktop');
    const mobileBottomChatBarSettingsGroup = createBottomChatBarSettingsGroup('mobile');
    const desktopRailOrderSettingsGroup = createRailOrderSettingsGroup('desktop');
    const mobileRailOrderSettingsGroup = createRailOrderSettingsGroup('mobile');
    const paperTextureSettingsGroup = createPaperTextureSettingsGroup();
    const frontendIconSettingsGroup = createFrontendIconSettingsGroup();
    const shortcutSettingsGroup = createShortcutSettingsGroup();
    const desktopQuickActionSettingsGroup = createMobileQuickActionSettingsGroup('desktop');
    const mobileQuickActionSettingsGroup = createMobileQuickActionSettingsGroup();
    const desktopSettingsOutlet = document.getElementById('sb-desktop-settings-outlet');
    const mobileSettingsOutlet = document.getElementById('sb-mobile-settings-outlet');
    for (const theme of NN_THEMES) {
        const button = createElement('button', {
            className: 'sb-theme-option',
            attrs: {
                type: 'button',
                'data-sb-theme-option': theme.id,
            },
        });

        button.innerHTML = `
            <span class="sb-theme-option-label">${theme.label}</span>
        `;

        button.addEventListener('click', () => setShellTheme(theme.id));
        optionRow.appendChild(button);
    }

    const kittylessChoice = createMobileNavChoice({
        id: 'sb-kittyless-enabled-input',
        type: 'checkbox',
        value: 'kittyless-enabled',
        label: 'Hide cats (Kittyless)',
        icon: 'fa-eye-slash',
        onChange: input => setKittylessEnabled(input.checked),
    });
    const kittylessCaption = createElement('p', {
        id: 'sb-kittyless-caption',
        className: 'sb-theme-slider-caption',
        text: 'Hide the cats, ears, paws and sleeping animals while keeping the style you picked.',
    });
    const kittylessGroup = createElement('div', { className: 'sb-kittyless-setting' });
    kittylessGroup.append(kittylessChoice, kittylessCaption);

    const shellStyleSettingsGroup = createThemeSettingsDrawer({
        id: 'sb-shell-style-drawer',
        title: 'Shell Style',
        content: [description, optionRow, kittylessGroup],
    });
    const interfaceSettingsGroup = createThemeSettingsDrawer({
        id: 'sb-interface-drawer',
        title: 'Interface',
        content: [frontendIconSettingsGroup, surfaceSliderGroup, bottomBarSliderGroup],
    });
    const restoreTourInvites = createElement('button', {
        id: 'sb-restore-tour-invitations',
        className: 'menu_button',
        text: 'Restore tour invitations',
        attrs: { type: 'button' },
    });
    const tourInviteStatus = createElement('p', {
        className: 'sb-theme-slider-caption',
        attrs: { role: 'status' },
    });
    restoreTourInvites.addEventListener('click', async () => {
        try {
            const { restoreTourInvitations } = await import('./neconyan-tour-invitations.js');
            restoreTourInvitations();
            tourInviteStatus.textContent = 'Tour invitations restored. Open a page to see its invitation again.';
        } catch (error) {
            console.warn('[Neconyan] Could not restore tour invitations:', error);
            tourInviteStatus.textContent = 'Could not restore tour invitations. Please try again.';
        }
    });
    const hideTourButtonsChoice = createMobileNavChoice({
        id: 'sb-hide-tour-buttons-input',
        type: 'checkbox',
        value: 'hide-tour-buttons',
        label: 'Hide all tour buttons',
        icon: 'fa-eye-slash',
        onChange: input => setTourButtonsHidden(input.checked),
    });
    const hideTourButtonsCaption = createElement('p', {
        className: 'sb-theme-slider-caption',
        text: 'Hides the Tour button on every page, the tour invitations and Replay First paws tour on Home. Turn it off to bring them all back.',
    });
    const tourSettingsGroup = createThemeSettingsDrawer({
        id: 'sb-page-tours-drawer',
        title: 'Page tours',
        content: [hideTourButtonsChoice, hideTourButtonsCaption, createElement('p', {
            className: 'sb-theme-slider-caption',
            text: 'Restore page-tour invitations you hid or already tried.',
        }), restoreTourInvites, tourInviteStatus],
    });

    getMessageStyleSelect()?.addEventListener('change', updateThemePickerUi);
    document.addEventListener('sb:chat-style-updated', updateThemePickerUi);

    if (desktopSettingsOutlet instanceof HTMLElement) {
        desktopSettingsOutlet.replaceChildren(
            desktopNavLayoutSettingsGroup,
            desktopSettingsDivider,
            desktopShellSizingSettingsGroup,
            desktopButtonSliderGroup,
            desktopCompactModeSettingsGroup,
            desktopBottomChatBarSettingsGroup,
            desktopRailOrderSettingsGroup,
            desktopQuickActionSettingsGroup,
        );
    }

    if (mobileSettingsOutlet instanceof HTMLElement) {
        mobileSettingsOutlet.replaceChildren(
            mobileNavLayoutSettingsGroup,
            mobileSettingsDivider,
            mobileButtonSliderGroup,
            mobileCompactModeSettingsGroup,
            mobileBottomChatBarSettingsGroup,
            mobileRailOrderSettingsGroup,
            paperTextureSettingsGroup,
            mobileQuickActionSettingsGroup,
        );
    }

    const themeSettingsDrawers = [shellStyleSettingsGroup, interfaceSettingsGroup, topbarLabelSettingsGroup, shortcutSettingsGroup, tourSettingsGroup];
    if (!(desktopSettingsOutlet instanceof HTMLElement)) {
        card.append(
            desktopNavLayoutSettingsGroup,
            desktopSettingsDivider,
            desktopShellSizingSettingsGroup,
            desktopButtonSliderGroup,
            desktopCompactModeSettingsGroup,
            desktopBottomChatBarSettingsGroup,
            desktopRailOrderSettingsGroup,
            desktopQuickActionSettingsGroup,
        );
    }

    if (!(mobileSettingsOutlet instanceof HTMLElement)) {
        card.append(
            mobileNavLayoutSettingsGroup,
            mobileSettingsDivider,
            mobileButtonSliderGroup,
            mobileCompactModeSettingsGroup,
            mobileBottomChatBarSettingsGroup,
            mobileRailOrderSettingsGroup,
            mobileQuickActionSettingsGroup,
        );
    }
    themeBlock.append(card);
    placeThemeSettingsDrawers(themeBlock, card, themeSettingsDrawers);
    if (!card.hasChildNodes()) {
        card.remove();
    }
    themeBlock.dataset.themePickerInitialized = 'true';
    updateThemePickerUi();
}

function placeThemeSettingsDrawers(themeBlock, card, drawers) {
    const themeDrawer = themeBlock.closest('.inline-drawer');
    const anchor = document.getElementById('sb-theme-presets-drawer') || themeDrawer;
    if (!(anchor instanceof HTMLElement) || !(anchor.parentElement instanceof HTMLElement)) {
        card.append(...drawers);
        return;
    }
    const icons = {
        'sb-shell-style-drawer': 'fa-paw',
        'sb-interface-drawer': 'fa-sliders',
        'sb-topbar-label-drawer': 'fa-heading',
        'sb-quick-access-shortcuts-drawer': 'fa-bolt',
        'sb-page-tours-drawer': 'fa-route',
    };
    for (const drawer of drawers) {
        drawer.classList.remove('sb-theme-settings-drawer');
        drawer.classList.add('wide100p', 'flexFlowColumn', 'sb-settings-subdrawer', 'sb-theme-lifted-drawer');
        const header = drawer.querySelector(':scope > .inline-drawer-header');
        header?.classList.add('userSettingsInnerExpandable');
        const heading = header?.querySelector(':scope > strong');
        if (heading) {
            const label = createElement('b');
            const glyph = createElement('i', { className: `fa-solid ${icons[drawer.id] || 'fa-gear'}`, attrs: { 'aria-hidden': 'true' } });
            label.append(glyph, ' ', createElement('span', { text: heading.textContent || '' }));
            heading.replaceWith(label);
        }
        drawer.querySelector(':scope > .sb-theme-settings-drawer-body')?.classList.add('sb-settings-subdrawer-body');
    }
    anchor.after(...drawers);
}

function updateThemePickerUi() {
    const sliderInput = document.getElementById('sb-surface-transparency-input');
    const sliderValue = document.getElementById('sb-surface-transparency-value');
    const desktopTopbarScaleInput = document.getElementById('sb-topbar-scale-desktop-input');
    const desktopTopbarScaleValue = document.getElementById('sb-topbar-scale-desktop-value');
    const bottomBarScaleInput = document.getElementById('sb-bottom-bar-scale-input');
    const bottomBarScaleValue = document.getElementById('sb-bottom-bar-scale-value');
    const desktopButtonScaleInput = document.getElementById('sb-desktop-button-scale-input');
    const desktopButtonScaleValue = document.getElementById('sb-desktop-button-scale-value');
    const mobileButtonScaleInput = document.getElementById('sb-mobile-button-scale-input');
    const mobileButtonScaleValue = document.getElementById('sb-mobile-button-scale-value');
    const customTextInput = document.getElementById('sb-topbar-custom-text-input');
    const desktopNavIconOnlyInput = document.getElementById('sb-desktop-nav-icon-only-input');
    const desktopNavShowCustomizeInput = document.getElementById('sb-desktop-nav-show-customize-input');
    const desktopNavShowQuickActionsInput = document.getElementById('sb-desktop-nav-show-quick-actions-input');
    const desktopNavReplaceQuickActionsInput = document.getElementById('sb-desktop-nav-replace-quick-actions-input');
    const desktopNavReplacementSelect = document.getElementById('sb-desktop-nav-replacement-select');
    const desktopShellSnapToChatInput = document.getElementById('sb-desktop-shell-snap-to-chat-input');
    const mobileNavIconOnlyInput = document.getElementById('sb-mobile-nav-icon-only-input');
    const mobileNavShowCustomizeInput = document.getElementById('sb-mobile-nav-show-customize-input');
    const mobileNavShowQuickActionsInput = document.getElementById('sb-mobile-nav-show-quick-actions-input');
    const mobileNavReplaceQuickActionsInput = document.getElementById('sb-mobile-nav-replace-quick-actions-input');
    const mobileNavReplacementSelect = document.getElementById('sb-mobile-nav-replacement-select');
    const paperTextureEnabledInput = document.getElementById('sb-paper-texture-enabled-input');
    const paperTextureOpacityInput = document.getElementById('sb-paper-texture-opacity-input');
    const paperTextureOpacityValue = document.getElementById('sb-paper-texture-opacity-value');

    for (const button of document.querySelectorAll('[data-sb-theme-option]')) {
        const themeId = button.getAttribute('data-sb-theme-option');
        const isActive = themeId === nnState.theme;
        button.classList.toggle('is-selected', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    }

    for (const button of document.querySelectorAll('[data-sb-frontend-icon-option]')) {
        const iconId = button.getAttribute('data-sb-frontend-icon-option');
        const isActive = iconId === nnState.frontendIcon;
        button.classList.toggle('is-selected', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    }

    if (sliderInput instanceof HTMLInputElement) {
        sliderInput.min = String(NN_SURFACE_TRANSPARENCY.min);
        sliderInput.max = String(NN_SURFACE_TRANSPARENCY.max);
        sliderInput.step = String(NN_SURFACE_TRANSPARENCY.step);
        sliderInput.value = String(nnState.surfaceTransparency);
    }

    if (sliderValue instanceof HTMLElement) {
        sliderValue.textContent = formatSurfaceTransparency(nnState.surfaceTransparency);
    }

    if (desktopTopbarScaleInput instanceof HTMLInputElement) {
        desktopTopbarScaleInput.value = String(nnState.topbarScale.desktop);
    }

    if (desktopTopbarScaleValue instanceof HTMLElement) {
        desktopTopbarScaleValue.textContent = formatTopbarScale(nnState.topbarScale.desktop);
    }

    if (bottomBarScaleInput instanceof HTMLInputElement) {
        bottomBarScaleInput.value = String(nnState.bottomBarScale);
    }

    if (bottomBarScaleValue instanceof HTMLElement) {
        bottomBarScaleValue.textContent = formatTopbarScale(nnState.bottomBarScale);
    }

    if (desktopButtonScaleInput instanceof HTMLInputElement) {
        desktopButtonScaleInput.value = String(nnState.desktopButtonScale);
    }

    if (desktopButtonScaleValue instanceof HTMLElement) {
        desktopButtonScaleValue.textContent = formatTopbarScale(nnState.desktopButtonScale);
    }

    if (mobileButtonScaleInput instanceof HTMLInputElement) {
        mobileButtonScaleInput.value = String(nnState.mobileButtonScale);
    }

    if (mobileButtonScaleValue instanceof HTMLElement) {
        mobileButtonScaleValue.textContent = formatTopbarScale(nnState.mobileButtonScale);
    }

    for (const input of document.querySelectorAll('[data-sb-topbar-label-mode][data-sb-topbar-label-part]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        const mode = input.getAttribute('data-sb-topbar-label-mode');
        const partId = normalizeTopbarLabelPart(input.getAttribute('data-sb-topbar-label-part'));
        const isChecked = mode === 'mobile'
            ? nnState.topbarLabel.mobileParts.includes(partId)
            : nnState.topbarLabel.desktopParts.includes(partId);

        input.checked = isChecked;
        input.closest('.sb-topbar-label-option')?.classList.toggle('is-selected', isChecked);
    }

    if (customTextInput instanceof HTMLInputElement && customTextInput.value !== nnState.topbarLabel.customText) {
        customTextInput.value = nnState.topbarLabel.customText;
    }

    for (const input of document.querySelectorAll('[data-sb-topbar-label-click-cycle-input]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        input.checked = isTopbarLabelClickCycleEnabled();
        input.closest('.sb-topbar-label-option')?.classList.toggle('is-selected', input.checked);
    }

    for (const input of document.querySelectorAll('[data-sb-compact-mode-input]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        input.checked = nnState.compactMode;
        input.closest('.sb-compact-mode-option')?.classList.toggle('is-selected', nnState.compactMode);
    }

    for (const input of document.querySelectorAll('[data-sb-bottom-bar-visible-input]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        input.checked = nnState.bottomChatBar.visible;
        input.closest('.sb-compact-mode-option')?.classList.toggle('is-selected', nnState.bottomChatBar.visible);
    }

    for (const input of document.querySelectorAll('input[name="sb-desktop-nav-layout"]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        const isChecked = input.value === nnState.desktopNav.layout;
        input.checked = isChecked;
        input.closest('.sb-mobile-nav-choice')?.classList.toggle('is-selected', isChecked);
    }

    for (const input of document.querySelectorAll('input[name="sb-mobile-nav-layout"]')) {
        if (!(input instanceof HTMLInputElement)) {
            continue;
        }

        const isChecked = input.value === nnState.mobileNav.layout;
        input.checked = isChecked;
        input.closest('.sb-mobile-nav-choice')?.classList.toggle('is-selected', isChecked);
    }

    // Each Navigation group's checkbox reflects its own device's stored value, not the state in
    // force on this viewport. Quick Access stays fully live in icons-only mode -- the slots are
    // part of the right-hand cluster now, not superseded by it.

    if (desktopNavIconOnlyInput instanceof HTMLInputElement) {
        desktopNavIconOnlyInput.checked = nnState.desktopNav.iconOnly;
        const choice = desktopNavIconOnlyInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', nnState.desktopNav.iconOnly);
        choice?.classList.toggle('is-disabled', false);
    }

    if (desktopNavShowCustomizeInput instanceof HTMLInputElement) {
        desktopNavShowCustomizeInput.checked = nnState.desktopNav.showCustomize;
        desktopNavShowCustomizeInput.disabled = false;
        const choice = desktopNavShowCustomizeInput.closest('.sb-mobile-nav-choice');
        const label = choice?.querySelector('.sb-mobile-nav-choice-copy > strong');
        if (label instanceof HTMLElement) {
            label.textContent = getMobileNavCustomizeLocationLabel('desktop');
        }
        choice?.classList.toggle('is-selected', nnState.desktopNav.showCustomize);
        choice?.classList.toggle('is-disabled', false);
        if (choice instanceof HTMLElement) {
            choice.style.display = nnState.desktopNav.layout === 'vertical' ? 'none' : '';
        }
    }

    if (desktopNavShowQuickActionsInput instanceof HTMLInputElement) {
        desktopNavShowQuickActionsInput.checked = nnState.desktopNav.showQuickActions;
        desktopNavShowQuickActionsInput.disabled = false;
        const choice = desktopNavShowQuickActionsInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', nnState.desktopNav.showQuickActions);
        choice?.classList.toggle('is-disabled', false);
    }

    if (desktopNavReplaceQuickActionsInput instanceof HTMLInputElement) {
        desktopNavReplaceQuickActionsInput.checked = nnState.desktopNav.replaceQuickActions;
        const choice = desktopNavReplaceQuickActionsInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', nnState.desktopNav.replaceQuickActions);
    }

    if (desktopNavReplacementSelect instanceof HTMLSelectElement) {
        desktopNavReplacementSelect.value = normalizeMobileNavReplacementTarget(nnState.desktopNav.replacementTarget);
        desktopNavReplacementSelect.disabled = !nnState.desktopNav.replaceQuickActions;
        desktopNavReplacementSelect.closest('.sb-mobile-nav-replacement-field')?.classList.toggle('is-disabled', !nnState.desktopNav.replaceQuickActions);
    }

    if (desktopShellSnapToChatInput instanceof HTMLInputElement) {
        desktopShellSnapToChatInput.checked = nnState.shellSizing.snapToChatWidth;
        const choice = desktopShellSnapToChatInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', nnState.shellSizing.snapToChatWidth);
    }

    if (mobileNavIconOnlyInput instanceof HTMLInputElement) {
        mobileNavIconOnlyInput.checked = nnState.mobileNav.iconOnly;
        const choice = mobileNavIconOnlyInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', nnState.mobileNav.iconOnly);
        choice?.classList.toggle('is-disabled', false);
    }

    if (mobileNavShowCustomizeInput instanceof HTMLInputElement) {
        mobileNavShowCustomizeInput.checked = nnState.mobileNav.showCustomize;
        mobileNavShowCustomizeInput.disabled = false;
        const choice = mobileNavShowCustomizeInput.closest('.sb-mobile-nav-choice');
        const label = choice?.querySelector('.sb-mobile-nav-choice-copy > strong');
        if (label instanceof HTMLElement) {
            label.textContent = getMobileNavCustomizeLocationLabel();
        }
        choice?.classList.toggle('is-selected', nnState.mobileNav.showCustomize);
        choice?.classList.toggle('is-disabled', false);
        if (choice instanceof HTMLElement) {
            choice.style.display = nnState.mobileNav.layout === 'vertical' ? 'none' : '';
        }
    }

    if (mobileNavShowQuickActionsInput instanceof HTMLInputElement) {
        mobileNavShowQuickActionsInput.checked = nnState.mobileNav.showQuickActions;
        mobileNavShowQuickActionsInput.disabled = false;
        const choice = mobileNavShowQuickActionsInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', nnState.mobileNav.showQuickActions);
        choice?.classList.toggle('is-disabled', false);
    }

    if (mobileNavReplaceQuickActionsInput instanceof HTMLInputElement) {
        mobileNavReplaceQuickActionsInput.checked = nnState.mobileNav.replaceQuickActions;
        const choice = mobileNavReplaceQuickActionsInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', nnState.mobileNav.replaceQuickActions);
    }

    if (mobileNavReplacementSelect instanceof HTMLSelectElement) {
        mobileNavReplacementSelect.value = normalizeMobileNavReplacementTarget(nnState.mobileNav.replacementTarget);
        mobileNavReplacementSelect.disabled = !nnState.mobileNav.replaceQuickActions;
        mobileNavReplacementSelect.closest('.sb-mobile-nav-replacement-field')?.classList.toggle('is-disabled', !nnState.mobileNav.replaceQuickActions);
    }

    const hideTourButtonsInput = document.getElementById('sb-hide-tour-buttons-input');
    if (hideTourButtonsInput instanceof HTMLInputElement) {
        hideTourButtonsInput.checked = nnState.tourButtonsHidden;
        hideTourButtonsInput.closest('.sb-mobile-nav-choice')?.classList.toggle('is-selected', nnState.tourButtonsHidden);
    }

    const kittylessInput = document.getElementById('sb-kittyless-enabled-input');
    if (kittylessInput instanceof HTMLInputElement) {
        const styleHidesCats = nnState.theme === 'kittyless';
        kittylessInput.checked = isKittylessActive();
        kittylessInput.disabled = styleHidesCats;
        kittylessInput.closest('.sb-mobile-nav-choice')?.classList.toggle('is-selected', kittylessInput.checked);
        kittylessInput.closest('.sb-kittyless-setting')?.classList.toggle('is-disabled', styleHidesCats);
        const caption = document.getElementById('sb-kittyless-caption');
        if (caption) {
            caption.textContent = styleHidesCats
                ? 'The Kittyless style always hides the cats. Pick another style to choose for yourself.'
                : 'Hide the cats, ears, paws and sleeping animals while keeping the style you picked.';
        }
    }

    if (paperTextureEnabledInput instanceof HTMLInputElement) {
        paperTextureEnabledInput.checked = nnState.paperTextureEnabled;
        const choice = paperTextureEnabledInput.closest('.sb-mobile-nav-choice');
        choice?.classList.toggle('is-selected', nnState.paperTextureEnabled);
    }

    if (paperTextureOpacityInput instanceof HTMLInputElement) {
        paperTextureOpacityInput.min = String(NN_PAPER_TEXTURE_OPACITY.min);
        paperTextureOpacityInput.max = String(NN_PAPER_TEXTURE_OPACITY.max);
        paperTextureOpacityInput.step = String(NN_PAPER_TEXTURE_OPACITY.step);
        paperTextureOpacityInput.value = String(nnState.paperTextureOpacity);
        paperTextureOpacityInput.disabled = !nnState.paperTextureEnabled;
        paperTextureOpacityInput.closest('.sb-theme-slider-group')?.classList.toggle('is-disabled', !nnState.paperTextureEnabled);
    }

    if (paperTextureOpacityValue instanceof HTMLElement) {
        paperTextureOpacityValue.textContent = formatPaperTextureOpacity(nnState.paperTextureOpacity);
    }

    for (const button of document.querySelectorAll('[data-sb-message-style]')) {
        const isActive = button.getAttribute('data-sb-message-style') === getCurrentMessageStyle();
        button.classList.toggle('is-selected', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    }
}

// `readable` is the global search's index: it includes the Shell Style card and reads labels
// with clean spacing. Phone quick actions keep the older labels because their saved keys use them.
function createSearchIndex(tabState, { includeThemeCard = false, readable = false } = {}) {
    const searchRoot = tabState.searchRoot;
    if (!(searchRoot instanceof HTMLElement)) {
        return [];
    }

    const entries = [];
    const seen = new Set();
    const excludedSelector = includeThemeCard || readable
        ? '.sb-search-result, [data-sb-search-index-ignore], .sb-legacy-search-hidden, .sb-mobile-quick-actions-group, .sb-desktop-quick-actions-group'
        : '.sb-search-result, [data-sb-search-index-ignore], .sb-theme-card, .sb-legacy-search-hidden';

    for (const element of searchRoot.querySelectorAll(readable ? NN_SEARCH_READABLE_TARGET_SELECTOR : NN_SEARCH_TARGET_SELECTOR)) {
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (element.closest(excludedSelector) || (readable && element.matches(NN_SEARCH_JUMBLED_ROW_SELECTOR))) {
            continue;
        }

        const sectionLabel = getSearchSectionLabel(element, tabState.label, { readable });
        const searchText = getSearchText(element, sectionLabel, { readable });
        const displayText = getSearchDisplayText(element, sectionLabel, { readable });
        const dedupeKey = getSearchEntryDedupeKey(tabState, sectionLabel, displayText, { element });

        if (searchText.length < 3 || seen.has(dedupeKey)) {
            continue;
        }

        seen.add(dedupeKey);
        entries.push({
            element,
            searchText,
            displayText,
            sectionLabel,
            tabId: tabState.id,
            tabLabel: tabState.label,
            dedupeKey,
        });
    }

    return entries;
}

/**
 * Returns synthetic search entries for all personas from power_user.personas.
 * These are not in the DOM in a searchable form (paginated list), so we read
 * the data directly and provide an action that navigates to the persona.
 */
function getPersonaSearchEntries(tabState) {
    const context = getSillyTavernContext();
    const personas = context?.powerUserSettings?.personas ?? {};
    const personaDescriptions = context?.powerUserSettings?.persona_descriptions ?? {};
    const defaultPersona = context?.powerUserSettings?.default_persona ?? '';
    const entries = [];

    for (const [avatarId, name] of Object.entries(personas)) {
        if (!name || name === '[Unnamed Persona]') continue;
        const personaDescription = personaDescriptions[avatarId]?.description ?? '';
        const personaTitle = personaDescriptions[avatarId]?.title ?? '';
        const searchText = normalizeText([
            name,
            avatarId,
            personaTitle,
            personaDescription,
            avatarId === defaultPersona ? 'default persona' : '',
        ].join(' '));

        if (searchText.length < 2) continue;

        entries.push({
            element: null,
            searchText,
            displayText: name,
            sectionLabel: 'Persona',
            tabId: tabState.id,
            tabLabel: tabState.label,
            dedupeKey: getSearchEntryDedupeKey(tabState, 'Persona', name, { avatarId }),
            action: () => {
                // Activate the persona tab and trigger ST's own persona search
                openCharacterPanelTab('persona');
                window.setTimeout(() => {
                    const searchInput = document.getElementById('persona_search_bar');
                    if (searchInput instanceof HTMLInputElement) {
                        searchInput.value = name;
                        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, 80);
            },
        });
    }

    return entries;
}

function getSearchSectionLabel(element, fallback, { readable = false } = {}) {
    const readText = node => String((readable ? getSearchElementText(node) : node?.textContent) ?? '').replace(/\s+/g, ' ').trim();

    // For extension containers: use the extension's own name/header, not the parent tab label
    const extContainer = element.closest('.extension_container, [id$="-container"]');
    if (extContainer instanceof HTMLElement) {
        const extName = extContainer.querySelector('.extension_name')
            ?? extContainer.querySelector(':scope > .inline-drawer > .inline-drawer-toggle b, :scope > .inline-drawer > .inline-drawer-header b')
            ?? extContainer.querySelector(':scope > .inline-drawer > .inline-drawer-toggle, :scope > .inline-drawer > .inline-drawer-header')
            ?? extContainer.querySelector('h3, h4, strong');
        if (extName) {
            const text = readText(extName);
            if (text) return text;
        }
    }

    // Walk up to the nearest inline-drawer and use its toggle header as the section
    const inlineDrawer = element.closest('.inline-drawer');
    if (inlineDrawer instanceof HTMLElement) {
        const toggle = inlineDrawer.querySelector(':scope > .inline-drawer-toggle');
        if (toggle) {
            const text = readable ? getSearchHeadingText(toggle, { readable }) : readText(toggle);
            if (text && text !== fallback) return text;
        }
    }

    const preferred = element.closest('.persona_management_global_settings')
        ?? (readable ? null : element.closest('.bg-header-row-1') ?? element.closest('.bg-header-row-2'))
        ?? element.closest('label, h3, h4, h5, strong');

    const text = preferred ? readText(preferred) : String(fallback ?? '').trim();
    return text || fallback;
}

// The element a folded section result scrolls to, matching the order getSearchSectionLabel uses.
function getSearchSectionElement(element) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }
    return element.closest('.extension_container, [id$="-container"]')
        ?? element.closest('.inline-drawer')
        ?? element;
}

function getSearchPageEntries() {
    return NN_SEARCH_PAGES.map(page => ({
        element: null,
        searchText: normalizeText([page.label, page.route.replace(/-/g, ' '), ...page.keywords].join(' ')),
        displayText: page.label,
        sectionLabel: '',
        detail: page.description,
        keywords: [page.route.replace(/-/g, ' '), ...page.keywords].map(normalizeText),
        tabId: page.route,
        tabLabel: 'Pages',
        groupLabel: 'Pages',
        kind: 'page',
        covers: page.covers ?? [],
        dedupeKey: `page::${page.route}`,
        action: () => {
            const railButton = document.querySelector(`#neconyan-workspace-rail [data-neconyan-route="${CSS.escape(page.route)}"]`);
            if (railButton instanceof HTMLElement) {
                railButton.click();
                return;
            }
            globalThis.NeconyanWelcome?.activateRoute?.(page.route);
        },
    }));
}

function collectGlobalSearchMatches(query) {
    const normalizedQuery = normalizeText(query);

    if (!normalizedQuery) {
        return [];
    }

    const searchTerms = normalizedQuery.split(' ').filter(Boolean);
    const wordPatterns = searchTerms.map(getSearchWordStartPattern);

    const searchSources = [{ shellKey: 'pages', shellLabel: 'Pages', entries: getSearchPageEntries() }];

    for (const [shellKey, shellState] of Object.entries(nnState.shells)) {
        const shellLabel = getShellConfig(shellKey)?.title || shellKey;
        const entries = [];

        for (const tabState of shellState.tabs.values()) {
            if (!tabState.searchIndex || ['settings', 'extensions'].includes(tabState.id)) {
                tabState.searchIndex = createSearchIndex(tabState, { readable: true });
            }

            entries.push(...tabState.searchIndex);
            if (tabState.id === 'persona') {
                entries.push(...getPersonaSearchEntries(tabState));
            }
        }

        searchSources.push({ shellKey, shellLabel, entries });
    }

    // Characters is a separate drawer rather than an nnState shell, so merge its navigation
    // entries explicitly. This keeps its tabs discoverable even when the drawer is closed.
    searchSources.push({
        shellKey: 'characters',
        shellLabel: 'Characters',
        entries: getCharacterPanelSearchEntries(),
    });

    const collectMatches = (isMatch) => {
        const matches = new Map();

        for (const { shellKey, shellLabel, entries } of searchSources) {
            for (const entry of entries) {
                if (!isMatch(entry.searchText) || isSearchElementSwitchedOff(entry.element)) {
                    continue;
                }

                const { score, sectionOnly } = scoreSearchEntry(entry, normalizedQuery, wordPatterns);
                const sectionText = normalizeText(entry.sectionLabel);
                // Controls that only matched through their section name fold into one result
                // for that section, so a section search does not list every button inside it.
                const isSection = typeof entry.action !== 'function'
                    && !entry.kind
                    && Boolean(sectionText)
                    && (sectionOnly || (normalizeText(entry.displayText) === sectionText
                        && entry.element instanceof HTMLElement
                        && entry.element.matches(NN_SEARCH_SECTION_HEADING_SELECTOR)));
                const isWholeTab = isSection && sectionText === normalizeText(entry.tabLabel);
                const match = {
                    ...entry,
                    ...(isSection ? {
                        kind: 'section',
                        displayText: entry.sectionLabel,
                        element: isWholeTab ? null : sectionOnly ? getSearchSectionElement(entry.element) : entry.element,
                        dedupeKey: `${entry.tabId}::section::${sectionText}`,
                    } : {}),
                    shellKey,
                    shellLabel,
                    advanced: entry.advanced === true || NN_ADVANCED_SEARCH_ROUTES.has(`${shellKey}:${entry.tabId}`),
                    score,
                };
                const matchKey = [
                    shellKey,
                    match.dedupeKey || [
                        entry.tabId,
                        normalizeText(entry.sectionLabel),
                        normalizeText(entry.displayText),
                    ].filter(Boolean).join('::'),
                ].filter(Boolean).join('::');
                const existingMatch = matches.get(matchKey);
                const shouldReplaceMatch = !existingMatch
                    || match.score > existingMatch.score
                    || (match.score === existingMatch.score
                        && typeof match.action === 'function'
                        && typeof existingMatch.action !== 'function');

                if (shouldReplaceMatch) {
                    matches.set(matchKey, match);
                }
            }
        }

        return matches;
    };

    // Words must start a word in the result ('temp' finds Temperature, not Attempts). Only when
    // nothing matches that way does search fall back to matching inside words.
    let matches = collectMatches(text => hasSearchWordStarts(text, wordPatterns));
    if (!matches.size) {
        matches = collectMatches(text => searchTerms.every(term => text.includes(term)));
    }

    for (const match of matches.values()) {
        for (const coveredKey of match.covers ?? []) {
            matches.delete(coveredKey);
        }
    }

    const ranked = Array.from(matches.values()).sort((left, right) => right.score - left.score);
    // Matching pages always make the list, even when many settings outrank them.
    const pages = ranked.filter(match => match.kind === 'page').slice(0, NN_UNIVERSAL_SEARCH_PAGE_LIMIT);
    const settings = ranked
        .filter(match => match.kind !== 'page')
        .slice(0, NN_UNIVERSAL_SEARCH_RESULT_LIMIT - pages.length);
    const ordered = [...pages, ...settings].sort((left, right) => right.score - left.score);
    // A page found by its own name goes first: results are grouped, and settings groups
    // would otherwise push it down the list.
    const namedPages = ordered.filter(match => match.kind === 'page' && match.score >= 80);
    return [...namedPages, ...ordered.filter(match => !namedPages.includes(match))];
}

function getTabSearchEntries(tabState, { includeThemeCard = false } = {}) {
    const searchIndex = includeThemeCard ? createSearchIndex(tabState, { includeThemeCard }) : tabState.searchIndex;

    if (!searchIndex) {
        tabState.searchIndex = createSearchIndex(tabState);
    }

    return [
        ...(searchIndex || tabState.searchIndex),
        ...(tabState.id === 'persona'
            ? getPersonaSearchEntries(tabState)
            : tabState.id === 'characters'
                ? getCharacterPanelSearchEntries()
                : []),
    ];
}

function getMobileQuickActionSearchMatches(query) {
    const normalizedQuery = normalizeText(query);

    if (normalizedQuery.length < 2) {
        return [];
    }

    const searchTerms = normalizedQuery.split(' ').filter(Boolean);
    const matches = new Map();

    for (const [shellKey, shellState] of Object.entries(nnState.shells)) {
        const shellLabel = getShellConfig(shellKey)?.title || shellKey;

        for (const tabState of shellState.tabs.values()) {
            for (const entry of getTabSearchEntries(tabState, { includeThemeCard: true })) {
                if (!searchTerms.every(term => entry.searchText.includes(term))) {
                    continue;
                }

                const match = {
                    ...entry,
                    shellKey,
                    shellLabel,
                    advanced: entry.advanced === true || NN_ADVANCED_SEARCH_ROUTES.has(`${shellKey}:${entry.tabId}`),
                    score: Number(entry.searchText.startsWith(normalizedQuery)) * 10 - entry.displayText.length / 1000,
                };
                const matchKey = [
                    shellKey,
                    entry.dedupeKey,
                ].filter(Boolean).join('::');
                const existingMatch = matches.get(matchKey);

                if (!existingMatch || match.score > existingMatch.score) {
                    matches.set(matchKey, match);
                }
            }
        }
    }

    return Array.from(matches.values())
        .sort((left, right) => right.score - left.score)
        .slice(0, NN_UNIVERSAL_SEARCH_RESULT_LIMIT);
}

function findMobileQuickActionMatch(action) {
    const normalizedAction = normalizeMobileQuickAction(action);
    if (!normalizedAction) {
        return null;
    }

    const shellState = getShellState(normalizedAction.shellKey);
    const tabState = shellState?.tabs.get(normalizedAction.tabId);
    if (!tabState) {
        return null;
    }

    const entries = getTabSearchEntries(tabState, { includeThemeCard: true });
    const exactMatch = entries.find(entry => entry.dedupeKey === normalizedAction.dedupeKey);
    const fallbackMatch = exactMatch || entries.find(entry => (
        normalizeText(entry.sectionLabel) === normalizeText(normalizedAction.sectionLabel)
        && normalizeText(entry.displayText) === normalizeText(normalizedAction.displayText)
    ));

    if (!fallbackMatch) {
        return null;
    }

    return {
        ...fallbackMatch,
        shellKey: normalizedAction.shellKey,
        shellLabel: normalizedAction.shellKey === 'characters'
            ? 'Characters'
            : getShellConfig(normalizedAction.shellKey)?.title || normalizedAction.shellKey,
    };
}

function activateMobileQuickAction(action) {
    const match = findMobileQuickActionMatch(action);
    if (!match) {
        if (action.shellKey === 'characters') {
            openCharacterPanelTab(action.tabId);
            return;
        }

        openShell(action.shellKey, action.tabId);
        return;
    }

    if (action.shellKey === 'characters') {
        revealSearchMatch(action.shellKey, match);
        return;
    }

    revealSearchMatch(action.shellKey, match);
}

function activateMobileNavAction(action) {
    const normalizedAction = normalizeMobileQuickAction(action);
    if (!normalizedAction) {
        return;
    }

    if (isMobileViewport()) {
        closeMobileNav();
    }

    if (normalizedAction.type === 'custom') {
        activateMobileQuickAction(normalizedAction);
        return;
    }

    if (normalizedAction.type === 'shell') {
        closeAllDropdowns({ except: normalizedAction.shellKey });
        openShell(normalizedAction.shellKey);
        return;
    }

    if (normalizedAction.shellKey === 'characters') {
        openCharacterPanelTab(normalizedAction.tabId);
        return;
    }

    closeAllDropdowns({ except: normalizedAction.shellKey });
    openShell(normalizedAction.shellKey, normalizedAction.tabId);
}

function renderUniversalSearchResults(query) {
    const searchState = getUniversalSearchState();
    const results = searchState.results;

    if (!(results instanceof HTMLElement)) {
        return;
    }

    results.replaceChildren();
    searchState.activeIndex = -1;
    searchState.input?.removeAttribute('aria-activedescendant');

    if (!searchState.expanded) {
        results.classList.remove('is-visible');
        return;
    }

    const trimmedQuery = String(query ?? '').trim();

    if (!trimmedQuery) {
        renderSearchEmptyState(results, NN_UNIVERSAL_SEARCH_IDLE_TITLE, NN_UNIVERSAL_SEARCH_IDLE_HINT);
        results.classList.add('is-visible');
        return;
    }

    const matches = collectGlobalSearchMatches(trimmedQuery);
    const groupedMatches = new Map();
    for (const match of matches) {
        const groupLabel = match.groupLabel || `${match.shellLabel} · ${match.tabLabel}`;
        if (!groupedMatches.has(groupLabel)) {
            groupedMatches.set(groupLabel, []);
        }
        groupedMatches.get(groupLabel).push(match);
    }

    let resultIndex = 0;
    for (const [groupLabel, groupMatches] of groupedMatches.entries()) {
        const group = createElement('div', {
            className: 'sb-search-result-group',
            attrs: {
                role: 'group',
                'aria-label': groupLabel,
            },
        });
        group.appendChild(createElement('div', { className: 'sb-search-result-group-label', text: groupLabel }));

        for (const match of groupMatches) {
            const button = createElement('button', {
                className: 'sb-search-result',
                attrs: {
                    type: 'button',
                    role: 'option',
                    id: `sb-search-result-${resultIndex++}`,
                    'aria-selected': 'false',
                },
            });
            const label = match.displayText || match.sectionLabel || match.tabLabel;
            const labelText = normalizeText(label);
            const sectionText = normalizeText(match.sectionLabel);
            // Say where a setting lives when its section adds something the group label does not.
            const detailText = match.detail || (
                match.kind !== 'section'
                && sectionText
                && sectionText !== labelText
                && sectionText !== normalizeText(match.tabLabel)
                    ? `in ${match.sectionLabel}`
                    : ''
            );
            const kindText = match.kind === 'page'
                ? 'Open page'
                : match.kind === 'section'
                    ? 'Open section'
                    : match.kind === 'tab'
                        ? 'Open tab'
                        : typeof match.action === 'function' ? 'Quick action' : 'Jump to setting';

            button.appendChild(createElement('strong', { text: label }));

            if (detailText) {
                button.appendChild(createElement('span', { text: detailText }));
            }

            button.appendChild(createElement('small', { text: kindText }));

            button.addEventListener('click', () => {
                clearUniversalSearch({ blur: true });
                revealSearchMatch(match.shellKey, match);
            });

            group.appendChild(button);
        }

        results.appendChild(group);
    }

    if (!results.childElementCount) {
        renderSearchEmptyState(
            results,
            `No matches for "${trimmedQuery}" yet.`,
            NN_UNIVERSAL_SEARCH_EMPTY_HINT,
        );
    }

    results.classList.add('is-visible');
    setUniversalSearchActiveIndex(results.querySelector('.sb-search-result') ? 0 : -1);
}

function setUniversalSearchActiveIndex(index) {
    const searchState = getUniversalSearchState();
    const results = searchState.results;
    const input = searchState.input;

    if (!(results instanceof HTMLElement)) {
        return;
    }

    const buttons = Array.from(results.querySelectorAll('.sb-search-result'));
    searchState.activeIndex = buttons.length ? Math.min(Math.max(index, 0), buttons.length - 1) : -1;

    for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        const active = i === searchState.activeIndex;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        if (active) {
            input?.setAttribute('aria-activedescendant', button.id);
            scrollElementIntoManagedView(button, { block: 'nearest' });
        }
    }

    if (searchState.activeIndex === -1) {
        input?.removeAttribute('aria-activedescendant');
    }
}

function expandHiddenAccordions(target) {
    const hiddenContents = [];
    let current = target.parentElement;

    while (current) {
        if (current instanceof HTMLDetailsElement) {
            current.open = true;
        }
        if (current.classList.contains('inline-drawer-content') && getComputedStyle(current).display === 'none') {
            hiddenContents.push(current);
        }

        current = current.parentElement;
    }

    for (const content of hiddenContents.reverse()) {
        const toggle = content.previousElementSibling?.classList.contains('inline-drawer-toggle')
            ? content.previousElementSibling
            : content.parentElement?.querySelector(':scope > .inline-drawer-toggle');

        if (toggle instanceof HTMLElement) {
            toggle.click();
        }
    }
}

const NN_SEARCH_HIGHLIGHT_CLASS = 'highlighted-drawer';
const NN_SEARCH_HIGHLIGHT_DURATION_MS = 1800;

function pulseSearchTarget(target) {
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const drawer = target.closest('.inline-drawer');
    const highlightTarget = drawer instanceof HTMLElement ? drawer : target;

    document.querySelectorAll('.' + NN_SEARCH_HIGHLIGHT_CLASS)
        .forEach(el => el.classList.remove(NN_SEARCH_HIGHLIGHT_CLASS));

    highlightTarget.classList.add(NN_SEARCH_HIGHLIGHT_CLASS);
    window.setTimeout(() => {
        highlightTarget.classList.remove(NN_SEARCH_HIGHLIGHT_CLASS);
    }, NN_SEARCH_HIGHLIGHT_DURATION_MS);
}

function revealSettingsCategoryFor(target) {
    if (!(target instanceof HTMLElement)) {
        return;
    }

    target.dispatchEvent(new CustomEvent('sb:reveal-search-target', { bubbles: true, detail: { target } }));

    const settingsContent = document.getElementById('user-settings-block-content');
    if (!settingsContent || !settingsContent.contains(target)) {
        return;
    }

    const taggedDrawer = target.closest('.inline-drawer[data-settings-tab]');
    if (taggedDrawer instanceof HTMLElement) {
        const category = taggedDrawer.getAttribute('data-settings-tab');
        if (category) {
            settingsContent.setAttribute('data-active-tab', category);
            const settingsBlock = document.getElementById('user-settings-block');
            if (settingsBlock) {
                settingsBlock.setAttribute('data-active-tab', category);
            }
            document.querySelectorAll('.sb-settings-tab-btn').forEach(btn => {
                const isActive = btn.getAttribute('data-tab') === category;
                btn.classList.toggle('active', isActive);
                if (isActive) {
                    btn.setAttribute('aria-current', 'page');
                } else {
                    btn.removeAttribute('aria-current');
                }
            });
            return;
        }
    }

    settingsContent.setAttribute('data-search-active', 'true');
    const tabNav = document.getElementById('sb-settings-tabs');
    if (tabNav) {
        const clearSearchActive = () => {
            settingsContent.removeAttribute('data-search-active');
            tabNav.removeEventListener('click', clearSearchActive);
        };
        tabNav.addEventListener('click', clearSearchActive);
    }
}

async function openExtensionSettings(id) {
    const selector = { regex: '#open_regex_editor', expressions: '#expression_api' }[id];
    if (!selector) return false;
    closeMobileNav();
    const extension = findExtension(id);
    const element = extension?.enabled && await waitForNeconyanNativeReady(selector, 4000);
    if (!(element instanceof HTMLElement)) {
        globalThis.toastr?.info?.(extension?.enabled
            ? 'These settings have not loaded. Check Manage extensions.'
            : 'Enable this tool in Manage extensions, then reload.', 'Extensions');
        return openNeconyanNativeManage();
    }
    revealSearchMatch('right', { tabId: 'extensions', element });
    return true;
}

function revealSearchMatch(shellKey, match) {
    closeAllDropdowns({ except: shellKey });

    // Entries with a custom action (e.g. persona results) bypass DOM scrolling
    if (typeof match.action === 'function') {
        match.action();
        return;
    }

    if (shellKey === 'characters') {
        openCharacterPanelTab(match.tabId);

        if (match.element instanceof HTMLElement) {
            window.setTimeout(() => {
                expandHiddenAccordions(match.element);
                scrollElementIntoManagedView(match.element, {
                    block: 'center',
                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                });
                pulseSearchTarget(match.element);
            }, 40);
        }

        return;
    }

    openShell(shellKey, match.tabId);

    // A result for a whole tab has no single element to scroll to.
    if (!(match.element instanceof HTMLElement)) {
        return;
    }

    window.setTimeout(() => {
        revealSettingsCategoryFor(match.element);
        expandHiddenAccordions(match.element);
        scrollElementIntoManagedView(match.element, {
            block: 'center',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
        pulseSearchTarget(match.element);
    }, 40);
}

function setActiveTab(shellKey, tabId, { focusButton = false } = {}) {
    const shellState = getShellState(shellKey);
    const shellConfig = getShellConfig(shellKey);

    if (shellKey === 'left' && tabId === 'world-info') {
        // Neconyan: final guard for old code paths that still ask for the
        // removed left-shell World Info route.
        openCharacterPanelTab('world-info');
        return;
    }

    if (!shellState || !shellState.tabs.has(tabId)) {
        return;
    }

    if (shellKey === 'right' && tabId === 'extensions') {
        neconyanIncludedToolRestore?.();
        neconyanIncludedToolRestore = null;
        globalThis.NeconyanExtensions?.resetThirdParty?.();
    }

    preloadPanelStylesheets(shellKey, tabId);

    const previousTab = shellState.tabs.get(shellState.activeTabId);
    shellState.activeTabId = tabId;
    safeSetItem(shellConfig.storageKey, tabId);

    for (const [currentTabId, tabState] of shellState.tabs.entries()) {
        const isActive = currentTabId === tabId;
        const isHiddenRailDuplicate = tabState.button?.classList.contains('sb-shell-tab-mobile-rail-hidden') ?? false;
        tabState.button?.classList.toggle('is-active', isActive);
        tabState.button?.setAttribute('aria-selected', String(isActive));
        tabState.button?.setAttribute('tabindex', isActive && !isHiddenRailDuplicate ? '0' : '-1');
        tabState.panel.classList.toggle('sb-shell-panel-active', isActive);
        tabState.panel.setAttribute('aria-hidden', String(!isActive));
        // Invalidate search index when switching to a tab so stale DOM isn't searched
        if (isActive) tabState.searchIndex = null;
    }

    syncMobileShellRailActionState(shellKey, tabId);
    queueTopbarPageStateSync();

    const activeTab = shellState.tabs.get(tabId);
    shellState.headerTitle.textContent = activeTab.label;
    renderShellSubtitle(shellState.headerSubtitle, activeTab.description ?? '', { isHtml: activeTab.descriptionIsHtml === true });
    scrollShellTabButtonIntoView(shellState.nav, activeTab.button, { smooth: focusButton });
    shellState.updateNavScrollIndicators?.();

    if (focusButton && isActuallyVisible(activeTab.button)) {
        activeTab.button?.focus({ preventScroll: true });
    } else if (isShellOpen(shellKey)) {
        window.requestAnimationFrame(() => focusShellPanel(shellKey, { force: true }));
    }

    if (previousTab && previousTab.id !== activeTab.id) {
        previousTab.onDeactivate?.();
    }

    activeTab.onActivate?.();
    syncNeconyanNativeShellPage(shellKey, tabId);
    const shellRoot = document.getElementById(shellConfig.rootPanelId);
    if (shellRoot instanceof HTMLElement) {
        shellRoot.dataset.sbActiveTab = tabId;
        const closeButton = shellRoot.querySelector('.sb-shell-close');
        const closeLabel = t`Close ${translate(tabId === 'agents' ? 'Agents' : shellConfig.title)}`;
        closeButton?.setAttribute('aria-label', closeLabel);
        closeButton?.setAttribute('title', closeLabel);
    }
    if (shellRoot instanceof HTMLElement && shellRoot.classList.contains('openDrawer')) {
        dispatchShellTabActivated(shellKey, activeTab);
        queueMobileShellActivationRefresh();
    }
}

function openShell(shellKey, tabId = null) {
    if (shellKey === 'left' && tabId === 'world-info') {
        // Neconyan: final guard for old code paths that still ask for the
        // removed left-shell World Info route.
        openCharacterPanelTab('world-info');
        return;
    }

    const shellConfig = getShellConfig(shellKey);
    const shellState = getShellState(shellKey);
    const shellRoot = document.getElementById(shellConfig.rootPanelId);

    if (!shellState || !(shellRoot instanceof HTMLElement)) {
        return;
    }

    const shellSurface = getMobileShellSurfaceForShell(shellKey);
    if (shellSurface) {
        applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: shellSurface,
            isMobileViewport: isMobileViewport(),
        }));
    } else {
        closeMobileNav();
    }
    rememberShellFocusOrigin(shellKey);

    if (tabId) {
        setActiveTab(shellKey, tabId);
    }

    shellState.lastOpenedAt = performance.now();

    if (isDrawerActuallyOpen(shellRoot)) {
        syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        syncDesktopShellSizing();
        window.requestAnimationFrame(() => focusShellPanel(shellKey));
        return;
    }

    if (shellRoot.classList.contains('openDrawer')) {
        forceDrawerState(shellRoot, true, shellConfig.hostIconSelector);
        syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        syncDesktopShellSizing();
        window.requestAnimationFrame(() => focusShellPanel(shellKey));
        return;
    }

    if (!shellRoot.classList.contains('openDrawer')) {
        forceDrawerState(shellRoot, true, shellConfig.hostIconSelector);
        // Apply phone bounds once before the next paint, rather than measuring
        // the newly opened panel repeatedly between style writes.
        if (!isMobileViewport()) syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        window.requestAnimationFrame(() => {
            if (!shellRoot.classList.contains('openDrawer')) return;
            syncDesktopShellSizing();
            focusShellPanel(shellKey);
        });
    }
}

function closeShell(shellKey) {
    const shellConfig = getShellConfig(shellKey);
    const shellState = getShellState(shellKey);
    const shellRoot = document.getElementById(shellConfig.rootPanelId);

    if (!(shellRoot instanceof HTMLElement) || !shellRoot.classList.contains('openDrawer')) {
        return;
    }

    queuePinnedCharacterPanelRestore();
    shellState?.tabs.get(shellState.activeTabId)?.onDeactivate?.();

    if (!isDrawerActuallyOpen(shellRoot)) {
        forceDrawerState(shellRoot, false, shellConfig.hostIconSelector);
        syncMobileShellDrawerBounds();
        queueMobileShellDrawerBoundsSync();
        requestMobileViewportReset();
        return;
    }

    const shouldRestoreFocus = document.activeElement instanceof HTMLElement && shellRoot.contains(document.activeElement);
    if (shouldRestoreFocus) {
        document.activeElement.blur();
    }

    // Managed shells do not need the legacy drawer toggle close animation.
    forceDrawerState(shellRoot, false, shellConfig.hostIconSelector);
    syncMobileShellDrawerBounds();
    queueMobileShellDrawerBoundsSync();
    requestMobileViewportReset();
    if (shouldRestoreFocus) {
        window.requestAnimationFrame(() => restoreShellFocus(shellKey));
    } else {
        delete shellState?.restoreFocusTarget;
    }
}

function closeWorkspace() {
    closeShell('left');
    closeShell('right');
    closeCharacterPanelUnlessPinned();
}

function buildShell(shellKey) {
    const shellConfig = getShellConfig(shellKey);
    const shellRoot = document.getElementById(shellConfig.rootPanelId);

    if (!(shellRoot instanceof HTMLElement) || shellRoot.dataset.sbShellReady === 'true') {
        return;
    }

    shellRoot.dataset.sbShellReady = 'true';
    shellRoot.dataset.sbShellKey = shellKey;
    shellRoot.classList.add('sb-shell-root', `sb-shell-root-${shellKey}`);

    if (shellKey === 'right') {
        shellRoot.classList.add('fillRight');
    }

    const originalContent = createElement('div', { className: 'sb-shell-column' });
    moveChildrenIntoContainer(shellRoot, originalContent);
    if (!document.body.classList.contains('neconyan')) {
        originalContent.querySelector('#settingsSearch')?.classList.add('sb-legacy-search-hidden');
    }

    const frame = createElement('div', { className: 'sb-shell-frame' });
    const navWrapper = createElement('div', { className: 'sb-shell-nav-wrapper' });
    const navScrollLeft = createElement('button', {
        className: 'sb-shell-nav-scroll sb-shell-nav-scroll-left',
        attrs: {
            type: 'button',
            'aria-label': t`Scroll ${translate(shellConfig.title)} sections left`,
        },
    });
    const nav = createElement('nav', {
        className: 'sb-shell-nav',
        attrs: {
            role: 'tablist',
            'aria-label': `${shellConfig.title} sections`,
            'aria-orientation': 'vertical',
        },
    });
    const navScrollRight = createElement('button', {
        className: 'sb-shell-nav-scroll sb-shell-nav-scroll-right',
        attrs: {
            type: 'button',
            'aria-label': t`Scroll ${translate(shellConfig.title)} sections right`,
        },
    });
    navScrollLeft.innerHTML = '<i class="fa-solid fa-chevron-left" aria-hidden="true"></i>';
    navScrollRight.innerHTML = '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';
    navWrapper.append(navScrollLeft, nav, navScrollRight);

    const scrollNavByPage = direction => {
        const scrollRequest = nnMobileShellLifecycle.nav.resolvePageScroll({
            direction,
            clientWidth: nav.clientWidth,
            prefersReducedMotion: prefersReducedMotion(),
        });

        nav.scrollBy(scrollRequest);
    };

    let navTouchDrag = null;
    let suppressNavClickUntil = 0;

    const clearNavTouchDrag = () => {
        navTouchDrag = null;
    };

    const finishNavTouchDrag = event => {
        const dragEnd = nnMobileShellLifecycle.nav.resolveDragEnd({
            dragState: navTouchDrag,
            nowMs: Date.now(),
        });

        if (dragEnd.suppressClickUntil) {
            suppressNavClickUntil = dragEnd.suppressClickUntil;
        }

        if (dragEnd.shouldStopPropagation) {
            event.stopPropagation();
        }

        navTouchDrag = dragEnd.dragState;
    };

    const beginNavTouchDrag = event => {
        const touch = event.touches?.[0];

        navTouchDrag = nnMobileShellLifecycle.nav.createDragState({
            isMobileViewport: isMobileViewport(),
            touch,
            scrollLeft: nav.scrollLeft,
        });
    };

    const updateNavTouchDrag = event => {
        if (!navTouchDrag) {
            return;
        }

        const dragMove = nnMobileShellLifecycle.nav.resolveDragMove({
            dragState: navTouchDrag,
            touch: event.touches?.[0],
        });
        navTouchDrag = dragMove.dragState;

        if (!navTouchDrag) {
            return;
        }

        if (dragMove.shouldPreventDefault && event.cancelable) {
            event.preventDefault();
        }

        if (dragMove.shouldStopPropagation) {
            event.stopPropagation();
        }

        if (dragMove.nextScrollLeft !== null) {
            nav.scrollLeft = dragMove.nextScrollLeft;
            updateNavScrollIndicators();
        }
    };

    const suppressClickAfterNavDrag = event => {
        if (!nnMobileShellLifecycle.nav.shouldSuppressClick({
            nowMs: Date.now(),
            suppressClickUntil: suppressNavClickUntil,
        })) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
    };

    let navIndicatorsFrame = null;
    const updateNavScrollIndicators = () => {
        if (navIndicatorsFrame !== null || !shellRoot.classList.contains('openDrawer')) return;
        navIndicatorsFrame = window.requestAnimationFrame(() => {
            navIndicatorsFrame = null;
            if (!shellRoot.classList.contains('openDrawer')) return;
            const { canScrollLeft, canScrollRight } = nnMobileShellLifecycle.nav.resolveScrollIndicators({
                scrollLeft: nav.scrollLeft,
                clientWidth: nav.clientWidth,
                scrollWidth: nav.scrollWidth,
            });

            navWrapper.classList.toggle('sb-can-scroll-left', canScrollLeft);
            navWrapper.classList.toggle('sb-can-scroll-right', canScrollRight);
            if (navScrollLeft.disabled === canScrollLeft) navScrollLeft.disabled = !canScrollLeft;
            if (navScrollRight.disabled === canScrollRight) navScrollRight.disabled = !canScrollRight;
        });
    };

    nav.addEventListener('scroll', updateNavScrollIndicators, { passive: true });
    nav.addEventListener('click', suppressClickAfterNavDrag, true);
    nav.addEventListener('touchstart', beginNavTouchDrag, { passive: true });
    nav.addEventListener('touchmove', updateNavTouchDrag, { passive: false });
    nav.addEventListener('touchend', finishNavTouchDrag, { passive: true });
    nav.addEventListener('touchcancel', clearNavTouchDrag, { passive: true });
    window.addEventListener('resize', updateNavScrollIndicators, { passive: true });
    navScrollLeft.addEventListener('click', () => scrollNavByPage(-1));
    navScrollRight.addEventListener('click', () => scrollNavByPage(1));

    setTimeout(updateNavScrollIndicators, 100);

    const main = createElement('div', { className: 'sb-shell-main' });
    const header = createElement('div', { className: 'sb-shell-header' });
    const closeButton = createElement('button', {
        className: 'sb-shell-close',
        attrs: {
            type: 'button',
            title: t`Close ${translate(shellConfig.title)}`,
            'aria-label': t`Close ${translate(shellConfig.title)}`,
        },
    });
    const eyebrow = createElement('div', { className: 'sb-shell-kicker', text: shellConfig.title });
    const title = createElement('h2', { className: 'sb-shell-title', text: shellConfig.baseTab.label, attrs: { tabindex: '-1' } });
    const headerIntro = createElement('div', { className: 'neconyan-shell-page-intro' });
    const subtitle = createElement('p', { className: 'sb-shell-subtitle' });
    const shellDescription = createElement('p', { className: 'sb-shell-description', text: shellConfig.subtitle });
    const panelBody = createElement('div', { className: 'sb-shell-body' });
    const resizeHandle = createElement('div', {
        className: 'sb-shell-resize-handle',
        attrs: {
            title: `Resize ${shellConfig.title}`,
        },
    });

    closeButton.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    renderShellSubtitle(subtitle, shellConfig.baseTab.description ?? '', { isHtml: shellConfig.baseTab.descriptionIsHtml === true });
    closeButton.addEventListener('click', () => closeShell(shellKey));
    shellRoot.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
            return;
        }

        if (closeFocusedShell()) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
    bindShellResizeHandle(resizeHandle, shellKey);

    header.append(closeButton, eyebrow, title, headerIntro, subtitle, shellDescription);
    main.append(header, panelBody);
    if (shellKey === 'left') {
        navWrapper.classList.add('sb-model-native-nav-wrapper');
        nav.setAttribute('aria-orientation', 'horizontal');
        main.prepend(navWrapper);
        frame.append(main, resizeHandle);
    } else {
        frame.append(navWrapper, main, resizeHandle);
    }
    shellRoot.appendChild(frame);

    const shellState = {
        activeTabId: shellConfig.defaultTabId,
        lastOpenedAt: 0,
        tabs: new Map(),
        nav,
        headerTitle: title,
        headerIntro,
        headerSubtitle: subtitle,
        root: shellRoot,
        resizeHandle,
        updateNavScrollIndicators,
    };

    nnState.shells[shellKey] = shellState;

    let wasOpen = shellRoot.classList.contains('openDrawer');
    new MutationObserver(() => {
        const isOpen = shellRoot.classList.contains('openDrawer');

        if (isOpen === wasOpen) {
            return;
        }

        wasOpen = isOpen;

        if (isOpen) {
            shellState.lastOpenedAt = performance.now();
            if (isMobileViewport()) {
                closeMobileNav();
            }
            syncDesktopShellSizing();
            const activeTab = shellState.tabs.get(shellState.activeTabId);
            activeTab?.onActivate?.();
            dispatchShellTabActivated(shellKey, activeTab);
            queueMobileShellActivationRefresh();
            updateNavScrollIndicators();
            window.requestAnimationFrame(() => focusShellPanel(shellKey));
            queueMobileModalStateSync();
            return;
        }

        shellState.tabs.get(shellState.activeTabId)?.onDeactivate?.();
        queueMobileModalStateSync();
    }).observe(shellRoot, { attributes: true, attributeFilter: ['class'] });

    const basePanel = createShellPanel(shellConfig.baseTab);
    basePanel.scroller.appendChild(originalContent);
    registerShellTab(shellKey, shellConfig.baseTab, basePanel);

    const registerEmbeddedTab = (embeddedTab) => {
        const prepared = prepareEmbeddedDrawer(embeddedTab.drawerId, originalContent);
        if (!prepared) {
            return;
        }

        const embeddedPanel = createShellPanel(embeddedTab);
        embeddedPanel.scroller.appendChild(prepared.drawer);
        registerShellTab(shellKey, embeddedTab, embeddedPanel, prepared.drawerContent);
    };

    const leadingEmbeddedTabId = shellKey === 'left' ? 'api' : null;
    const leadingEmbeddedTab = shellConfig.embeddedTabs.find(tab => tab.id === leadingEmbeddedTabId);
    if (leadingEmbeddedTab) {
        registerEmbeddedTab(leadingEmbeddedTab);
    }

    const samplingTab = shellConfig.customTabs.find(tab => tab.id === 'sampling');
    if (samplingTab) {
        const samplingPanel = buildSamplingPanel();
        registerShellTab(shellKey, samplingTab, samplingPanel, samplingPanel.searchRoot);
    }

    for (const embeddedTab of shellConfig.embeddedTabs) {
        if (embeddedTab.id === leadingEmbeddedTabId) {
            continue;
        }

        registerEmbeddedTab(embeddedTab);
    }

    for (const customTab of shellConfig.customTabs) {
        if (customTab.id === 'sampling') {
            continue;
        }

        if (customTab.id === 'agents') {
            const agentPanel = buildInChatAgentsPanel();
            registerShellTab(shellKey, customTab, agentPanel, agentPanel.searchRoot);
            continue;
        }

        if (customTab.id === 'mewmory') {
            const memoryPanel = buildMewmoryPanel();
            registerShellTab(shellKey, customTab, memoryPanel, memoryPanel.searchRoot);
            continue;
        }

        if (customTab.id === 'server') {
            const serverPanel = buildServerAdminPanel();
            registerShellTab(shellKey, customTab, serverPanel, serverPanel.searchRoot);
            continue;
        }

        if (customTab.id === 'console-logs') {
            const consoleLogsPanel = buildConsoleLogsPanel();
            registerShellTab(shellKey, customTab, consoleLogsPanel, consoleLogsPanel.searchRoot);
            continue;
        }

        if (customTab.id === 'included-tool') {
            const includedToolPanel = buildIncludedToolPanel();
            registerShellTab(shellKey, customTab, includedToolPanel, includedToolPanel.searchRoot);
            shellState.tabs.get(customTab.id)?.button?.setAttribute('hidden', '');
        }
    }

    panelBody.append(...Array.from(shellState.tabs.values()).map(tabState => tabState.panel));
    if (shellKey === 'left') {
        mountNeconyanModelWorkspace(shellRoot);
    }

    const storedTabId = migrateLegacyWorldInfoRoute(safeGetItem(shellConfig.storageKey));
    const storedIncludedToolIsUsable = storedTabId !== 'included-tool' || Boolean(getSelectedIncludedTool());
    const nextActiveTab = shellState.tabs.has(storedTabId) && storedIncludedToolIsUsable
        ? storedTabId
        : shellConfig.defaultTabId;
    setActiveTab(shellKey, nextActiveTab);

    if (shellKey === 'right') {
        injectThemePicker();
        injectSillyTavernImportCard();
    }
}

function registerShellTab(shellKey, tabConfig, panelBundle, explicitSearchRoot = null) {
    const shellState = getShellState(shellKey);

    if (!shellState) {
        return;
    }

    const tabDomId = `sb-shell-tab-${shellKey}-${tabConfig.id}`;
    const panelDomId = `sb-shell-panel-${shellKey}-${tabConfig.id}`;
    const button = createElement('button', {
        className: 'sb-shell-tab',
        attrs: {
            id: tabDomId,
            type: 'button',
            role: 'tab',
            tabindex: '-1',
            'aria-selected': 'false',
            'aria-controls': panelDomId,
            'aria-label': tabConfig.label,
            title: tabConfig.label,
            'data-sb-tab': tabConfig.id,
        },
    });

    panelBundle.panel.id = panelDomId;
    panelBundle.panel.setAttribute('aria-labelledby', tabDomId);

    button.innerHTML = `
        <i class="fa-solid ${tabConfig.icon}" aria-hidden="true"></i>
        <span class="sb-shell-tab-copy">
            <strong>${tabConfig.label}</strong>
        </span>
    `;

    button.addEventListener('click', () => {
        setActiveTab(shellKey, tabConfig.id, { focusButton: false });
        openShell(shellKey);
    });

    button.addEventListener('keydown', event => {
        const buttons = Array.from(shellState.nav.querySelectorAll('.sb-shell-tab[data-sb-tab]')).filter(
            item => item instanceof HTMLElement && !item.classList.contains('sb-shell-tab-mobile-rail-hidden'),
        );
        const currentIndex = buttons.indexOf(button);

        if (currentIndex === -1) {
            return;
        }

        const lastIndex = buttons.length - 1;
        let nextIndex = currentIndex;

        const isVertical = shellState.nav.getAttribute('aria-orientation') === 'vertical';
        if (event.key === 'ArrowDown' || (!isVertical && event.key === 'ArrowRight')) {
            nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
        } else if (event.key === 'ArrowUp' || (!isVertical && event.key === 'ArrowLeft')) {
            nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
        } else if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = lastIndex;
        } else {
            return;
        }

        event.preventDefault();
        const nextButton = buttons[nextIndex];
        const nextTabId = nextButton?.getAttribute('data-sb-tab');

        if (nextTabId) {
            setActiveTab(shellKey, nextTabId, { focusButton: true });
        }
    });

    shellState.tabs.set(tabConfig.id, {
        ...tabConfig,
        button,
        panel: panelBundle.panel,
        searchRoot: explicitSearchRoot ?? panelBundle.searchRoot ?? panelBundle.scroller,
        searchIndex: null,
        onActivate: panelBundle.onActivate ?? tabConfig.onActivate ?? null,
        onDeactivate: panelBundle.onDeactivate ?? tabConfig.onDeactivate ?? null,
    });
    shellState.nav.appendChild(button);
    shellState.updateNavScrollIndicators?.();
    syncMobileShellRailActions(shellKey);
}

function createMobileShellRailDivider(label) {
    return createElement('div', {
        className: 'sb-shell-rail-divider',
        attrs: {
            role: 'separator',
            'aria-label': label,
        },
    });
}

function createMobileShellRailButton(item, actionHandler, className = '') {
    const action = normalizeMobileQuickAction({
        type: item.type || 'tab',
        shellKey: item.shellKey,
        tabId: item.tabId,
        icon: item.icon,
        label: item.label,
        sectionLabel: item.sectionLabel,
        displayText: item.displayText,
        dedupeKey: item.dedupeKey,
    });

    if (!action) {
        return null;
    }

    const buttonAttrs = {
        type: 'button',
        title: action.label,
        'aria-label': action.label,
        'data-sb-rail-action': getMobileQuickActionKey(action),
        'data-sb-rail-type': action.type,
        'data-sb-rail-shell-key': action.shellKey,
    };

    if (action.tabId) {
        buttonAttrs['data-sb-rail-tab-id'] = action.tabId;
    }

    const button = createElement('button', {
        className: ['sb-shell-tab', 'sb-shell-rail-action', className].filter(Boolean).join(' '),
        attrs: buttonAttrs,
    });
    const icon = createElement('i', {
        className: `fa-solid ${action.icon || NN_MOBILE_QUICK_ACTION_ICON_FALLBACK}`,
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const copy = createElement('span', { className: 'sb-shell-tab-copy' });
    const label = createElement('strong', { text: action.label });

    copy.appendChild(label);
    button.append(icon, copy);
    button.addEventListener('click', () => actionHandler(action));
    return button;
}

function createRailActionGroup(actions, groupLabel, className = '') {
    const railGroup = createElement('div', {
        className: ['sb-shell-rail-group', className].filter(Boolean).join(' '),
        attrs: {
            'aria-label': groupLabel,
        },
    });

    for (const action of actions) {
        const button = createMobileShellRailButton(action, activateMobileNavAction, 'sb-shell-rail-customize-action');
        if (button) {
            railGroup.appendChild(button);
        }
    }

    return railGroup;
}

function getBuiltInRailActionsForShell(shellKey) {
    const shellState = getShellState(shellKey);
    if (!shellState?.tabs) {
        return [];
    }

    const actions = [];
    for (const tabState of shellState.tabs.values()) {
        actions.push({
            type: 'tab',
            shellKey,
            tabId: tabState.id,
            icon: tabState.icon,
            label: tabState.label,
        });
    }
    return actions;
}

function getAllBuiltInRailActionKeys() {
    const actionKeys = new Set();

    for (const [shellKey, shellConfig] of Object.entries(NN_SHELLS)) {
        const tabConfigs = [
            shellConfig.baseTab,
            ...(Array.isArray(shellConfig.embeddedTabs) ? shellConfig.embeddedTabs : []),
            ...(Array.isArray(shellConfig.customTabs) ? shellConfig.customTabs : []),
        ];

        for (const tabConfig of tabConfigs) {
            if (!tabConfig?.id) {
                continue;
            }

            actionKeys.add(getMobileQuickActionKey({
                type: 'tab',
                shellKey,
                tabId: tabConfig.id,
                icon: tabConfig.icon,
                label: tabConfig.label,
            }));
        }
    }

    return actionKeys;
}

function getBuiltInRailLabelForShell(shellKey) {
    return getShellConfig(shellKey)?.title || shellKey;
}

function syncMobileShellRailActionState(activeShellKey = '', activeTabId = '') {
    document.querySelectorAll('.sb-shell-rail-action[data-sb-rail-shell-key]').forEach(button => {
        if (!(button instanceof HTMLElement)) {
            return;
        }

        const isActive = button.dataset.sbRailShellKey === activeShellKey && button.dataset.sbRailTabId === activeTabId;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-selected', String(isActive));
        if (isActive) {
            button.setAttribute('aria-current', 'page');
        } else {
            button.removeAttribute('aria-current');
        }
    });
}

function syncMobileShellRailTabVisibility(shellState, currentShellKey, hideCustomizeTabs) {
    for (const tabState of shellState.tabs.values()) {
        if (!(tabState.button instanceof HTMLElement)) {
            continue;
        }

        const shouldHide = hideCustomizeTabs;
        const isActive = tabState.id === shellState.activeTabId;
        tabState.button.classList.toggle('sb-shell-tab-mobile-rail-hidden', shouldHide);
        tabState.button.setAttribute('aria-hidden', String(shouldHide));
        tabState.button.setAttribute('tabindex', isActive && !shouldHide ? '0' : '-1');
        tabState.button.toggleAttribute('inert', shouldHide);
    }
}

function syncMobileShellRailActions(shellKey = null) {
    refreshNeconyanRailQuickActions();
    const shellKeys = shellKey ? [shellKey] : ['left', 'right'];
    const railMode = getActiveShellRailMode();
    const navState = getNavState(railMode);
    const hasVerticalRail = navState.layout === 'vertical';
    const isNeconyan = document.body?.classList.contains('neconyan') === true;
    const railQuickActionState = getQuickActionState(railMode);

    const prevSyncingRail = nnIsSyncingRailActions;
    nnIsSyncingRailActions = true;

    try {
        for (const currentShellKey of shellKeys) {
            const shellState = getShellState(currentShellKey);
            if (!(shellState?.nav instanceof HTMLElement)) {
                continue;
            }

            let shouldHideCustomizeTabs = false;

            const createRailBlock = (position) => createElement('div', {
                className: `sb-shell-rail-shortcuts sb-shell-rail-shortcuts-${position}`,
                attrs: {
                    'aria-hidden': 'false',
                },
            });

            let beforeBlock = null;
            let afterBlock = null;

            if (hasVerticalRail && !isNeconyan) {
                const builtInRailLabel = getBuiltInRailLabelForShell(currentShellKey);
                const replacementAction = railMode === 'desktop' && navState.replaceQuickActions
                    ? createNavReplacementQuickAction(navState.replacementTarget)
                    : null;
                const railActionPlan = nnMobileShellLifecycle.railModel.resolveActionVisibility({
                    hasVerticalRail,
                    showCustomize: hasVerticalRail || navState.showCustomize,
                    showQuickActions: navState.showQuickActions,
                    builtInActions: getBuiltInRailActionsForShell(currentShellKey),
                    builtInActionKeys: Array.from(getAllBuiltInRailActionKeys()),
                    quickActions: railQuickActionState,
                    replacementAction,
                    builtInGroupLabel: builtInRailLabel,
                });
                shouldHideCustomizeTabs = railActionPlan.shouldHideCustomizeTabs;

                const createQuickActionsGroup = (actions) => {
                    const quickActionsGroup = createElement('div', {
                        className: 'sb-shell-rail-group sb-shell-rail-group-quick-actions',
                        attrs: {
                            'aria-label': 'Quick Actions',
                        },
                    });

                    if (actions.length) {
                        for (const action of actions) {
                            const button = createMobileShellRailButton(action, activateMobileNavAction, 'sb-shell-rail-quick-action');
                            if (button) {
                                quickActionsGroup.appendChild(button);
                            }
                        }
                    } else {
                        quickActionsGroup.appendChild(createElement('div', {
                            className: 'sb-shell-rail-empty',
                            text: 'No Quick Actions',
                        }));
                    }

                    return quickActionsGroup;
                };

                const pendingBefore = createRailBlock('before');

                for (const group of railActionPlan.beforeGroups) {
                    pendingBefore.appendChild(createMobileShellRailDivider(group.label));
                    pendingBefore.appendChild(createRailActionGroup(
                        group.actions,
                        group.label,
                        `sb-shell-rail-group-${group.label.toLowerCase()}`,
                    ));
                }

                if (pendingBefore.children.length > 0) {
                    beforeBlock = pendingBefore;
                }

                if (railActionPlan.afterGroups.length > 0) {
                    const pendingAfter = createRailBlock('after');
                    for (const group of railActionPlan.afterGroups) {
                        pendingAfter.append(
                            createMobileShellRailDivider(group.label),
                            createQuickActionsGroup(group.actions),
                        );
                    }
                    afterBlock = pendingAfter;
                }
            }

            shellState.nav.querySelectorAll('.sb-shell-rail-shortcuts').forEach(element => element.remove());
            syncMobileShellRailTabVisibility(shellState, currentShellKey, isNeconyan ? false : shouldHideCustomizeTabs);

            if (beforeBlock) {
                shellState.nav.prepend(beforeBlock);
            }
            if (afterBlock) {
                shellState.nav.appendChild(afterBlock);
            }

            shellState.updateNavScrollIndicators?.();
        }

        const activeShellKey = ['left', 'right'].find(currentShellKey => isShellOpen(currentShellKey)) ?? (shellKeys.length === 1 ? shellKeys[0] : '');
        const activeShellState = activeShellKey ? getShellState(activeShellKey) : null;
        syncMobileShellRailActionState(activeShellKey, activeShellState?.activeTabId ?? '');
    } finally {
        if (!prevSyncingRail) {
            requestAnimationFrame(() => {
                nnIsSyncingRailActions = false;
            });
        } else {
            nnIsSyncingRailActions = prevSyncingRail;
        }
    }
}

function routeDrawerTarget(targetId) {
    const route = NN_DRAWER_ROUTES[targetId];
    if (!route) {
        return false;
    }

    if (route.shell === 'characters') {
        openCharacterPanelTab(route.tab);
        return true;
    }

    preloadPanelStylesheets(route.shell, route.tab);
    openShell(route.shell, route.tab);
    return true;
}

function dispatchShellTabActivated(shellKey, tabState) {
    if (!tabState) {
        return;
    }

    document.dispatchEvent(new CustomEvent('sb:shell-tab-activated', {
        detail: {
            shellKey,
            tabId: tabState.id,
            label: tabState.label,
        },
    }));
}

function queueMobileShellActivationRefresh() {
    if (!isMobileViewport()) {
        return;
    }

    queueMobileShellDrawerBoundsSync();
    queueMobileViewportStateSync();
}

function getInlineDrawerAutoCloseId(drawer, index = 0) {
    if (!(drawer instanceof HTMLElement)) {
        return '';
    }

    const drawerId = String(drawer.id || '').trim();
    return drawerId ? `id:${drawerId}:index:${index}` : `index:${index}`;
}

function interceptDrawerOpeners() {
    document.addEventListener('click', event => {
        const opener = event.target instanceof Element ? event.target.closest('.drawer-opener') : null;
        const targetId = opener?.getAttribute('data-target');

        if (!targetId || !routeDrawerTarget(targetId)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
    }, true);

    // Collapse sibling inline-drawers when one is opened — prevents nested
    // dropdown clutter by keeping only one drawer open per container at a time.
    document.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const toggle = event.target.closest('.inline-drawer-toggle');
        if (!toggle) return;
        if (!nnState.inlineDrawerAutoClose) return;

        const thisDrawer = toggle.closest('.inline-drawer');
        if (!thisDrawer) return;

        // Only collapse if this toggle is about to OPEN (icon currently points down = closed)
        const icon = thisDrawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
        const isCurrentlyClosed = icon?.classList.contains('fa-circle-chevron-down');
        if (!isCurrentlyClosed) return;

        // Find sibling inline-drawers in the same parent and close any that are open
        const parent = thisDrawer.parentElement;
        if (!parent) return;

        const siblingDrawers = Array.from(parent.children)
            .filter(element => element instanceof HTMLElement && element.classList.contains('inline-drawer'));
        const drawerById = new Map(siblingDrawers.map((drawer, index) => [getInlineDrawerAutoCloseId(drawer, index), drawer]));
        const openedDrawerId = getInlineDrawerAutoCloseId(thisDrawer, siblingDrawers.indexOf(thisDrawer));
        const openDrawerIds = siblingDrawers
            .map((drawer, index) => {
                const siblingIcon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
                return siblingIcon?.classList.contains('fa-circle-chevron-up')
                    ? getInlineDrawerAutoCloseId(drawer, index)
                    : '';
            })
            .filter(Boolean);
        const autoClosePlan = nnMobileShellLifecycle.inlineDrawers.resolveAutoCloseSiblings({
            openedDrawerId,
            openDrawerIds,
            isMobileViewport: isMobileViewport(),
        });

        for (const closeId of autoClosePlan.closeIds) {
            const sibling = drawerById.get(closeId);
            if (!(sibling instanceof HTMLElement)) continue;

            const siblingIcon = sibling.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
            const siblingContent = sibling.querySelector(':scope > .inline-drawer-content');
            if (!siblingIcon?.classList.contains('fa-circle-chevron-up')) continue;

            // Close it — mirror what ST's handler does
            siblingIcon.classList.replace('fa-circle-chevron-up', 'fa-circle-chevron-down');
            siblingIcon.classList.replace('up', 'down');
            if (window.jQuery && siblingContent) {
                window.jQuery(siblingContent).stop().slideUp();
            } else {
                siblingContent?.style.setProperty('display', 'none');
            }
        }
    }, true);
}

function bindInlineDrawerAutoCloseToggle() {
    const checkbox = document.getElementById('sb_auto_close_inline_drawers');
    if (!(checkbox instanceof HTMLInputElement)) {
        return;
    }

    checkbox.checked = nnState.inlineDrawerAutoClose;

    if (checkbox.dataset.sbBound === 'true') {
        return;
    }

    checkbox.addEventListener('change', () => {
        nnState.inlineDrawerAutoClose = checkbox.checked;
        safeSetItem(NN_STORAGE_KEYS.settingsDrawerAutoClose, String(nnState.inlineDrawerAutoClose));
    });

    checkbox.dataset.sbBound = 'true';
}

function bindWorldInfoRoute() {
    if (!window.jQuery) {
        return;
    }

    window.jQuery('#WIDrawerIcon, #WI-SP-button > .drawer-toggle')
        .off('click.sbShellRoute')
        .on('click.sbShellRoute', function (event) {
            event.preventDefault();
            event.stopImmediatePropagation();

            const characterPanel = getCharacterPanel();
            const worldInfoVisible = characterPanel instanceof HTMLElement
                && characterPanel.classList.contains('openDrawer')
                && characterPanel.dataset.menuType === 'world-info';

            if (worldInfoVisible) {
                closeCharacterPanel();
            } else {
                openCharacterPanelTab('world-info');
            }

            return false;
        });
}

function activateMobileNavPageTarget(target) {
    const config = getMobileNavReplacementTargetConfig(target);

    closeMobileNav();

    if (config.shellKey === 'characters') {
        openCharacterPanelTab(config.tabId);
        return;
    }

    if (config.shellKey && config.tabId) {
        openShell(config.shellKey, config.tabId);
    }
}

function updateMobileNavButtonLabel() {
    const button = document.getElementById('sb-hamburger');
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const overlay = document.getElementById('sb-mobile-nav');
    const isOpen = overlay instanceof HTMLElement
        && !overlay.hidden
        && overlay.getAttribute('aria-hidden') === 'false';
    const replacement = getMobileNavReplacementTargetConfig();
    const neconyanMenu = document.body?.classList.contains('neconyan');
    let title = neconyanMenu ? t`Open menu` : t`Open navigation`;

    if (isOpen) {
        title = neconyanMenu ? t`Close menu` : t`Close navigation`;
    } else if (nnState.mobileNav.replaceQuickActions) {
        title = t`Open ${replacement.label}`;
    }

    button.title = title;
    button.setAttribute('aria-label', title);
}

function createMobileQuickActionButton(item) {
    const action = normalizeMobileQuickAction(item);
    if (!action) {
        return null;
    }

    const button = createElement('button', {
        className: 'sb-nav-item',
        attrs: {
            type: 'button',
            title: t`Open ${action.label}`,
            'aria-label': t`Open ${action.label}`,
        },
    });
    const icon = createElement('i', {
        className: `fa-solid ${action.icon || NN_MOBILE_QUICK_ACTION_ICON_FALLBACK}`,
        attrs: {
            'aria-hidden': 'true',
        },
    });
    const label = createElement('span', { text: action.label });

    button.append(icon, label);
    button.addEventListener('click', () => {
        closeMobileNav();

        if (action.type === 'custom') {
            activateMobileQuickAction(action);
        } else if (action.type === 'shell') {
            openShell(action.shellKey);
        } else if (action.shellKey === 'characters') {
            openCharacterPanelTab(action.tabId);
        } else {
            toggleShellPanel(action.shellKey, action.tabId);
        }
    });

    return button;
}

function refreshNeconyanRailQuickActions() {
    const list = document.querySelector('#neconyan-workspace-rail [data-neconyan-quick-actions]');
    if (!(list instanceof HTMLElement)) return;
    const mode = getActiveShellRailMode();
    const actions = getQuickActionState(mode);
    const signature = JSON.stringify([mode, actions]);
    if (list.dataset.quickActionsSignature === signature) return;
    list.dataset.quickActionsSignature = signature;
    list.replaceChildren();
    for (const item of actions) {
        const action = normalizeMobileQuickAction(item);
        if (!action) continue;
        const button = createElement('button', {
            className: 'neconyan-rail-button',
            attrs: { type: 'button', title: action.label, 'aria-label': action.label },
        });
        button.append(
            createElement('i', { className: `fa-solid ${action.icon || NN_MOBILE_QUICK_ACTION_ICON_FALLBACK}`, attrs: { 'aria-hidden': 'true' } }),
            createElement('span', { text: action.label }),
        );
        button.addEventListener('click', () => activateMobileNavAction(action));
        list.appendChild(button);
    }
    if (!list.children.length) list.appendChild(createElement('p', {
        className: 'neconyan-rail-empty', text: 'No Quick Actions. Use Edit Quick Actions to add shortcuts.',
    }));
}

function editNeconyanRailQuickActions() {
    const mode = getActiveShellRailMode();
    const element = document.querySelector(`#sb-${mode}-settings-outlet .sb-${mode}-quick-actions-group`);
    revealSearchMatch('right', { tabId: 'settings', element });
}

function refreshMobileNavQuickActions() {
    const list = nnState.mobileNav.quickActionContainer
        ?? document.querySelector('#sb-mobile-nav .sb-mobile-quick-action-list');
    if (!(list instanceof HTMLElement)) {
        return;
    }

    nnState.mobileNav.quickActionContainer = list;
    list.replaceChildren();

    if (!nnState.mobileQuickActions.length) {
        list.appendChild(createElement('div', {
            className: 'sb-mobile-quick-action-empty',
            text: 'No mobile Quick Actions selected yet.',
        }));
        return;
    }

    for (const action of nnState.mobileQuickActions) {
        const button = createMobileQuickActionButton(action);
        if (button) {
            list.appendChild(button);
        }
    }
}

function buildMobileNav() {
    if (document.getElementById('sb-mobile-nav')) {
        return;
    }

    const overlay = createElement('div', {
        id: 'sb-mobile-nav',
        attrs: {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'sb-mobile-nav-title',
        },
    });
    const content = createElement('div', { id: 'sb-mobile-nav-content' });
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');

    if ('inert' in overlay) {
        overlay.inert = true;
    }

    const sectionBlock = createElement('section', { className: 'sb-mobile-section' });
    const quickActionTitle = createElement('span', { className: 'sb-mobile-section-title', text: 'Quick Actions' });
    const list = createElement('div', { className: 'sb-mobile-section-list sb-mobile-quick-action-list' });

    sectionBlock.classList.add('sb-mobile-quick-action-section');
    sectionBlock.append(quickActionTitle, list);
    content.append(sectionBlock);
    if (document.body.classList.contains('neconyan')) {
        const workspace = createElement('nav', {
            className: 'neconyan-mobile-workspace',
            attrs: { 'aria-label': 'Workspace' },
        });
        const home = createElement('button', {
            className: 'sb-nav-item',
            attrs: { type: 'button', title: 'Open Home', 'aria-label': 'Open Home', 'data-neconyan-route': 'home' },
            html: '<i class="fa-solid fa-house" aria-hidden="true"></i><span>Home</span>',
        });
        home.addEventListener('click', () => { void returnToLandingPage(); });
        workspace.appendChild(home);
        for (const [shellKey, tabId, label, icon] of [
            ['characters', 'characters', 'Characters', 'fa-address-card'],
            ['left', 'api', 'Connections', 'fa-plug'],
            ['left', 'agents', 'Agents', 'fa-cat'],
            ['left', 'mewmory', 'Mewmory', 'fa-brain'],
            ['characters', 'world-info', 'Lorebooks', 'fa-book-atlas'],
            ['right', 'extensions', 'Extensions', 'fa-cubes'],
            ['right', 'settings', 'Settings', 'fa-gear'],
        ]) {
            const button = createMobileQuickActionButton({ type: 'tab', shellKey, tabId, label, icon });
            if (button) workspace.appendChild(button);
        }
        const modes = createElement('section', {
            className: 'neconyan-mobile-modes',
            attrs: { 'aria-labelledby': 'sb-mobile-modes-title' },
        });
        modes.append(
            createElement('h3', { id: 'sb-mobile-modes-title', className: 'sb-mobile-section-title', text: 'Modes' }),
            ...NECONYAN_MODE_DEFINITIONS.map(mode => createNeconyanModeButton(mode.id, true)),
        );
        const includedTools = createElement('details', {
            className: 'neconyan-mobile-native-tools',
            attrs: { 'aria-labelledby': 'sb-mobile-native-tools-title' },
        });
        const includedSummary = createElement('summary', {
            id: 'sb-mobile-native-tools-title',
            className: 'neconyan-native-tools-summary',
            attrs: { 'aria-controls': 'sb-mobile-native-tools-list', 'aria-expanded': 'false' },
        });
        includedSummary.append(
            createElement('span', { text: 'Included tools' }),
            createElement('i', { className: 'fa-solid fa-chevron-down neconyan-native-tools-chevron', attrs: { 'aria-hidden': 'true' } }),
        );
        const includedList = createElement('div', {
            id: 'sb-mobile-native-tools-list',
            className: 'neconyan-native-tool-list',
            attrs: { 'data-neconyan-native-tool-list': '' },
        });
        includedTools.append(includedSummary, includedList);
        includedTools.addEventListener('toggle', () => {
            includedSummary.setAttribute('aria-expanded', String(includedTools.open));
            includedSummary.querySelector('.neconyan-native-tools-chevron')?.classList.toggle('is-open', includedTools.open);
        });
        workspace.append(sectionBlock, modes, includedTools);
        content.prepend(workspace);
        globalThis.NeconyanNativeTools?.mount?.();
    }
    nnState.mobileNav.quickActionContainer = list;
    nnState.mobileNav.quickActionSection = sectionBlock;
    nnState.mobileNav.quickActionDivider = null;
    refreshMobileNavQuickActions();

    const header = createElement('div', { className: 'sb-mobile-panel-header' });
    const closeButton = createElement('button', {
        className: 'sb-mobile-panel-close',
        attrs: {
            type: 'button',
            title: 'Close navigation',
            'aria-label': 'Close navigation',
        },
    });
    const headerCopy = createElement('div', { className: 'sb-mobile-panel-copy' });
    const eyebrow = createElement('div', { className: 'sb-shell-kicker', text: 'Menu' });
    const title = createElement('h2', {
        id: 'sb-mobile-nav-title',
        className: 'sb-shell-title',
        text: 'Navigation',
        attrs: {
            tabindex: '-1',
        },
    });
    closeButton.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    closeButton.addEventListener('click', closeMobileNav);
    headerCopy.append(eyebrow, title);
    header.append(headerCopy, closeButton);
    content.prepend(header);

    overlay.appendChild(content);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeMobileNav();
        }
    });
    overlay.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        closeMobileNav();
    });

    document.body.appendChild(overlay);
    updateMobileNavButtonLabel();

    // Auto-close mobile nav when clicking on main content areas
    const autoCloseSelectors = [
        '#send_textarea',
        '#send_but',
        '.mes',
        '#chat',
        '.drawer-content',
    ];

    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const shouldClose = nnMobileShellLifecycle.nav.shouldAutoClose({
            isNavOpen: overlay.classList.contains('sb-nav-open'),
            isTrusted: event.isTrusted,
            elapsedSinceOpenedMs: performance.now() - nnState.mobileNav.lastOpenedAt,
            isHamburgerTarget: Boolean(target.closest('#sb-hamburger')),
            isInsideNav: Boolean(target.closest('#sb-mobile-nav')),
            isAutoCloseArea: autoCloseSelectors.some(selector => target.matches(selector) || target.closest(selector)),
        });

        if (shouldClose) {
            closeMobileNav();
        }
    }, { passive: false });
}

function setMobileNavOpenState(isOpen) {
    const overlay = ensureMobileNavReady();
    const button = document.getElementById('sb-hamburger');

    if (!(overlay instanceof HTMLElement) || !(button instanceof HTMLElement)) {
        return;
    }

    const wasOpen = !overlay.hidden && overlay.getAttribute('aria-hidden') === 'false';
    const navState = nnMobileShellLifecycle.nav.resolveOpenState({
        requestedOpen: isOpen,
        isMobileViewport: isMobileViewport(),
        wasOpen,
        focusedInside: Boolean(document.activeElement && overlay.contains(document.activeElement)),
    });

    if (navState.shouldRecordOpenedAt) {
        nnState.mobileNav.lastOpenedAt = performance.now();
    }

    overlay.hidden = navState.overlayHidden;
    overlay.classList.toggle('sb-nav-open', navState.shouldOpen);
    overlay.setAttribute('aria-hidden', navState.overlayAriaHidden);

    if ('inert' in overlay) {
        overlay.inert = navState.overlayInert;
    }

    button.classList.toggle('is-open', navState.shouldOpen);
    button.setAttribute('aria-expanded', navState.buttonExpanded);
    const closedIcon = document.body?.classList.contains('neconyan')
        ? NN_NECONYAN_MOBILE_NAV_CLOSED_ICON
        : NN_MOBILE_NAV_CLOSED_ICON;
    button.innerHTML = navState.buttonIcon === 'close'
        ? '<i class="fa-solid fa-xmark" aria-hidden="true"></i>'
        : `<i class="fa-solid ${closedIcon}" aria-hidden="true"></i>`;
    updateMobileNavButtonLabel();

    queueMobileModalStateSync();

    if (wasOpen && !navState.shouldOpen) {
        requestMobileViewportReset();
    }

    if (navState.shouldRefreshQuickActions) {
        refreshMobileNavQuickActions();
    }

    if (navState.shouldFocusTitle) {
        window.requestAnimationFrame(() => {
            overlay.querySelector('#sb-mobile-nav-title')?.focus?.({ preventScroll: true });
        });
    } else if (navState.shouldRestoreButtonFocus) {
        button.focus({ preventScroll: true });
    }
}

function toggleMobileNav() {
    if (document.body.classList.contains('neconyan') && isMobileViewport()) {
        toggleNeconyanMobileMenu();
        return;
    }

    const overlay = ensureMobileNavReady();

    if (!(overlay instanceof HTMLElement)) {
        return;
    }

    const isOpen = !overlay.hidden && overlay.getAttribute('aria-hidden') === 'false';
    const toggleIntent = nnMobileShellLifecycle.nav.resolveToggleIntent({
        isMobileViewport: isMobileViewport(),
        isReplacementEnabled: nnState.mobileNav.replaceQuickActions,
        isOpen,
    });

    if (toggleIntent.action === MOBILE_SHELL_NAV_TOGGLE_ACTION.ACTIVATE_PAGE_TARGET) {
        activateMobileNavPageTarget(nnState.mobileNav.replacementTarget);
        return;
    }

    if (toggleIntent.shouldCloseCompetingPanels) {
        applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: nnMobileShellLifecycle.overlays.surface.NAV,
            isMobileViewport: isMobileViewport(),
        }));
    }

    setMobileNavOpenState(toggleIntent.action === MOBILE_SHELL_NAV_TOGGLE_ACTION.OPEN_NAV);
}

function closeMobileNav() {
    setMobileNavOpenState(false);
    setNeconyanRailDrawerOpen(false);
}

let neconyanRailDrawerBound = false;

function isNeconyanRailDrawerOpen() {
    return document.body.classList.contains('neconyan-rail-drawer-open');
}

function ensureNeconyanRailScrim() {
    let scrim = document.getElementById('neconyan-rail-drawer-scrim');
    if (!(scrim instanceof HTMLElement)) {
        scrim = createElement('div', {
            id: 'neconyan-rail-drawer-scrim',
            className: 'neconyan-rail-drawer-scrim',
            attrs: { 'aria-hidden': 'true' },
        });
        scrim.hidden = true;
        scrim.addEventListener('click', () => setNeconyanRailDrawerOpen(false, { restoreFocus: true }));
        document.body.append(scrim);
    }
    return scrim;
}

function setNeconyanRailDrawerOpen(open, { restoreFocus = false } = {}) {
    const rail = document.getElementById('neconyan-workspace-rail');
    const button = document.getElementById('sb-hamburger');
    const mobile = document.body.classList.contains('neconyan') && isMobileViewport();
    const wasOpen = isNeconyanRailDrawerOpen();
    const shouldOpen = Boolean(open) && mobile;

    if (shouldOpen) {
        applyMobileSurfaceExclusivity(nnMobileShellLifecycle.overlays.resolveExclusiveOpen({
            surface: nnMobileShellLifecycle.overlays.surface.NAV,
            isMobileViewport: true,
        }));
        setMobileNavOpenState(false);
    }

    document.body.classList.toggle('neconyan-rail-drawer-open', shouldOpen);
    const scrim = ensureNeconyanRailScrim();
    scrim.hidden = !shouldOpen;

    if (rail instanceof HTMLElement) {
        if (mobile) {
            if ('inert' in rail) {
                rail.inert = !shouldOpen;
            }
            rail.setAttribute('aria-hidden', String(!shouldOpen));
        } else {
            if ('inert' in rail) {
                rail.inert = false;
            }
            rail.removeAttribute('aria-hidden');
        }
    }

    if (button instanceof HTMLElement) {
        button.classList.toggle('is-open', shouldOpen);
        button.setAttribute('aria-expanded', String(shouldOpen));
        button.innerHTML = shouldOpen
            ? '<i class="fa-solid fa-xmark" aria-hidden="true"></i>'
            : `<i class="fa-solid ${NN_NECONYAN_MOBILE_NAV_CLOSED_ICON}" aria-hidden="true"></i>`;
        updateMobileNavButtonLabel();
        if (restoreFocus) {
            button.focus({ preventScroll: true });
        }
    }

    if (wasOpen && !shouldOpen) {
        requestMobileViewportReset();
    }
}

function toggleNeconyanMobileMenu() {
    if (!document.body.classList.contains('neconyan') || !isMobileViewport()) {
        toggleMobileNav();
        return;
    }
    const closing = isNeconyanRailDrawerOpen();
    setNeconyanRailDrawerOpen(!closing, { restoreFocus: closing });
}

function ensureNeconyanRailDrawerBindings() {
    if (neconyanRailDrawerBound) {
        return;
    }
    neconyanRailDrawerBound = true;

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !isNeconyanRailDrawerOpen()) {
            return;
        }
        setNeconyanRailDrawerOpen(false, { restoreFocus: true });
    });

    // Delegated from the document because the topbar is built before welcome-screen.js creates the rail.
    document.addEventListener('click', event => {
        if (!isNeconyanRailDrawerOpen() || !(event.target instanceof Element)) {
            return;
        }
        const button = event.target.closest('#neconyan-workspace-rail button');
        if (!(button instanceof HTMLElement) || button.matches('#neconyan-sidebar-toggle, [data-neconyan-refresh-recent], [data-neconyan-section-toggle]')) {
            return;
        }
        window.setTimeout(() => setNeconyanRailDrawerOpen(false), 0);
    });

    window.matchMedia(NN_MOBILE_MEDIA_QUERY).addEventListener('change', event => {
        refreshNeconyanRailQuickActions();
        if (!event.matches) {
            setNeconyanRailDrawerOpen(false);
        }
    });

    setNeconyanRailDrawerOpen(false);
}

function injectCharacterDrawerControls() {
    getCharacterPanel()?.classList.add('sb-character-drawer-root');
    mountNeconyanCharacterWorkspace(getCharacterPanel() ?? document);
    ensureCharacterListToolbarLayout();
    ensureCharacterEditorLayout();
    bindCharacterEditorFullscreenToggle();
    bindCreatorNotesFullscreen();

    const dockToggle = document.getElementById('sb_character_dock_toggle');
    const nativePin = document.getElementById('rm_button_panel_pin');
    if (dockToggle instanceof HTMLButtonElement && nativePin instanceof HTMLInputElement && dockToggle.dataset.sbBound !== 'true') {
        dockToggle.dataset.sbBound = 'true';
        const syncPin = () => dockToggle.setAttribute('aria-pressed', String(nativePin.checked));
        nativePin.addEventListener('change', syncPin);
        dockToggle.addEventListener('click', () => { nativePin.click(); syncPin(); });
        new MutationObserver(syncPin).observe(getCharacterPanel(), { attributes: true, attributeFilter: ['class'] });
        syncPin();
    }

    const shellCloseButton = document.getElementById('sb_character_shell_close');
    if (shellCloseButton instanceof HTMLButtonElement && shellCloseButton.dataset.sbBound !== 'true') {
        shellCloseButton.dataset.sbBound = 'true';
        shellCloseButton.addEventListener('click', () => closeCharacterPanel());
    }

    const modeToggle = document.getElementById('sb_character_mode_toggle');
    if (modeToggle instanceof HTMLElement && modeToggle.dataset.sbBound !== 'true') {
        modeToggle.dataset.sbBound = 'true';
        modeToggle.querySelectorAll('[data-sb-character-mode]').forEach((button) => {
            if (!(button instanceof HTMLButtonElement)) {
                return;
            }

            button.addEventListener('click', () => setCharacterShellMode(button.dataset.sbCharacterMode));
        });
    }

    if (document.documentElement.dataset.sbCharacterModeStateBound !== 'true') {
        document.documentElement.dataset.sbCharacterModeStateBound = 'true';
        window.addEventListener('sb:conversation-workspace-state-changed', syncCharacterModeToggle);
    }
    syncCharacterModeToggle();

    const charactersTab = document.getElementById('sb_character_tab_characters');
    if (charactersTab instanceof HTMLButtonElement && charactersTab.dataset.sbBound !== 'true') {
        charactersTab.dataset.sbBound = 'true';
        charactersTab.addEventListener('click', () => { void showCharacterListView(); });
    }

    const groupsTab = document.getElementById('sb_character_tab_groups');
    if (groupsTab instanceof HTMLButtonElement && groupsTab.dataset.sbBound !== 'true') {
        groupsTab.dataset.sbBound = 'true';
        groupsTab.addEventListener('click', () => { void showCharacterListView('groups'); });
    }

    const editorTab = document.getElementById('sb_character_tab_editor');
    if (editorTab instanceof HTMLButtonElement && editorTab.dataset.sbBound !== 'true') {
        editorTab.dataset.sbBound = 'true';
        editorTab.addEventListener('click', () => { void openCharacterEditorTab(); });
    }

    const personaTab = document.getElementById('sb_character_tab_persona');
    if (personaTab instanceof HTMLButtonElement && personaTab.dataset.sbBound !== 'true') {
        personaTab.dataset.sbBound = 'true';
        personaTab.addEventListener('click', () => openCharacterPersonaTab());
    }

    const worldInfoTab = document.getElementById('sb_character_tab_world_info');
    if (worldInfoTab instanceof HTMLButtonElement && worldInfoTab.dataset.sbBound !== 'true') {
        worldInfoTab.dataset.sbBound = 'true';
        worldInfoTab.addEventListener('click', () => openCharacterWorldInfoTab());
    }

    const importTab = document.getElementById('sb_character_tab_import');
    if (importTab instanceof HTMLButtonElement && importTab.dataset.sbBound !== 'true') {
        importTab.dataset.sbBound = 'true';
        importTab.addEventListener('click', () => openCharacterImportTab());
    }

    const importFileAction = document.getElementById('sb_character_import_file_action');
    if (importFileAction instanceof HTMLButtonElement && importFileAction.dataset.sbBound !== 'true') {
        importFileAction.dataset.sbBound = 'true';
        importFileAction.addEventListener('click', () => {
            document.getElementById('character_import_button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    }

    const importUrlAction = document.getElementById('sb_character_import_url_action');
    if (importUrlAction instanceof HTMLButtonElement && importUrlAction.dataset.sbBound !== 'true') {
        importUrlAction.dataset.sbBound = 'true';
        importUrlAction.addEventListener('click', () => {
            document.getElementById('external_import_button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    }

    if (document.documentElement.dataset.sbCharacterImportPreserveBound !== 'true') {
        document.documentElement.dataset.sbCharacterImportPreserveBound = 'true';
        document.addEventListener('neconyan:character-import-tab-preserve', () => {
            window.requestAnimationFrame(preserveCharacterImportTab);
        });
    }

    const emptyBrowseButton = document.getElementById('sb_character_empty_browse');
    if (emptyBrowseButton instanceof HTMLButtonElement && emptyBrowseButton.dataset.sbBound !== 'true') {
        emptyBrowseButton.dataset.sbBound = 'true';
        emptyBrowseButton.addEventListener('click', () => { void showCharacterListView(); });
    }

    const emptyCreateButton = document.getElementById('sb_character_empty_create');
    if (emptyCreateButton instanceof HTMLButtonElement && emptyCreateButton.dataset.sbBound !== 'true') {
        emptyCreateButton.dataset.sbBound = 'true';
        emptyCreateButton.addEventListener('click', () => {
            setCharacterEditorEmptyState(false);
            setCharacterPersonaPanelVisible(false);
            setCharacterImportPanelVisible(false);
            setCharacterWorldInfoPanelVisible(false);
            document.getElementById('rm_button_create')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            syncCharacterShellTabs('editor');
        });
    }

    ensureCharacterPersonaPanel();
    ensureCharacterWorldInfoPanel();

    const characterNav = getCharacterPanel()?.querySelector('.sb-character-native-nav, .sb-character-shell-nav');
    if (characterNav instanceof HTMLElement) {
        characterNav.setAttribute('aria-orientation', 'horizontal');
        if (characterNav.dataset.sbVerticalKeyboardBound !== 'true') {
            characterNav.dataset.sbVerticalKeyboardBound = 'true';
            characterNav.addEventListener('keydown', event => {
                const targetButton = event.target instanceof HTMLElement
                    ? event.target.closest('[data-sb-character-tab]')
                    : null;
                if (!(targetButton instanceof HTMLButtonElement)) {
                    return;
                }

                const buttons = Array.from(characterNav.querySelectorAll('[data-sb-character-tab]'))
                    .filter(button => button instanceof HTMLButtonElement && !button.disabled && !button.hidden);
                const currentIndex = buttons.indexOf(targetButton);
                if (currentIndex === -1) {
                    return;
                }

                const lastIndex = buttons.length - 1;
                let nextIndex;
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                    nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
                } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                    nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
                } else if (event.key === 'Home') {
                    nextIndex = 0;
                } else if (event.key === 'End') {
                    nextIndex = lastIndex;
                } else {
                    return;
                }

                event.preventDefault();
                const nextButton = buttons[nextIndex];
                nextButton?.focus({ preventScroll: true });
                nextButton?.click();
            });
        }
    }

    const target = document.getElementById('CharListButtonAndHotSwaps');
    if (!(target instanceof HTMLElement)) {
        return;
    }

    syncCharacterShellTabs();
}

function bindCharacterEditorExitButton() {
    const button = document.getElementById('sb_character_editor_exit');
    if (!(button instanceof HTMLButtonElement) || button.dataset.sbBound === 'true') {
        return;
    }

    button.dataset.sbBound = 'true';
    button.addEventListener('click', () => {
        setCharacterEditorFullscreenState(false);
        closeCharacterPanel();
    });
}

function setInlineDrawerExpanded(drawer, expand) {
    if (!(drawer instanceof HTMLElement)) {
        return;
    }

    const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon, :scope > .inline-drawer-toggle .inline-drawer-icon');
    const content = drawer.querySelector(':scope > .inline-drawer-content');

    if (!(icon instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        return;
    }

    const stateChanged = icon.classList.contains('up') !== Boolean(expand) || icon.getAttribute('aria-expanded') !== String(Boolean(expand));
    icon.classList.toggle('down', !expand);
    icon.classList.toggle('fa-circle-chevron-down', !expand);
    icon.classList.toggle('up', expand);
    icon.classList.toggle('fa-circle-chevron-up', expand);
    content.style.display = expand ? 'block' : 'none';
    drawer.querySelector(':scope > .inline-drawer-header, :scope > .inline-drawer-toggle')?.setAttribute('aria-expanded', String(Boolean(expand)));
    icon.setAttribute('aria-expanded', String(Boolean(expand)));
    if (stateChanged) drawer.dispatchEvent(new CustomEvent('inline-drawer-toggle', { bubbles: true }));
}

function getLegacySettingsDrawerStorageKey(drawer) {
    const root = document.getElementById('user-settings-block-content');
    if (!(root instanceof HTMLElement) || !(drawer instanceof HTMLElement) || !root.contains(drawer)) {
        return null;
    }

    if (drawer.id) {
        return `${NN_STORAGE_KEYS.settingsDrawerStatePrefix}:${drawer.id}`;
    }

    const drawers = Array.from(root.querySelectorAll('.inline-drawer'));
    const index = drawers.indexOf(drawer);
    return index === -1 ? null : `${NN_STORAGE_KEYS.settingsDrawerStatePrefix}:${index}`;
}

function sanitizeInlineDrawerStorageSegment(value, fallback = 'drawer') {
    const normalizedValue = normalizeText(value)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);

    return normalizedValue || fallback;
}

function getInlineDrawerHeaderText(drawer) {
    if (!(drawer instanceof HTMLElement)) {
        return '';
    }

    return drawer.querySelector(':scope > .inline-drawer-header b, :scope > .inline-drawer-header strong, :scope > .inline-drawer-header, :scope > .inline-drawer-toggle b, :scope > .inline-drawer-toggle strong, :scope > .inline-drawer-toggle')
        ?.textContent
        ?? '';
}

function getInlineDrawerContextSegment(element) {
    if (!(element instanceof HTMLElement)) {
        return '';
    }

    const elementId = String(element.id || '').trim();
    // Generated ARIA targets must not change existing drawer persistence keys.
    if (element.classList.contains('sb-shell-panel') && elementId.startsWith('sb-shell-panel-')) return '';
    if (elementId && !elementId.startsWith('select2-') && !/^ui-id-\d+$/i.test(elementId)) {
        return `id:${sanitizeInlineDrawerStorageSegment(elementId, 'scope')}`;
    }

    const worldEntryUid = element.classList.contains('world_entry')
        ? String(element.getAttribute('uid') || element.dataset.uid || '').trim()
        : '';
    if (worldEntryUid) {
        return `world-entry:${sanitizeInlineDrawerStorageSegment(worldEntryUid, 'entry')}`;
    }

    const promptIdentifier = String(element.dataset.pmIdentifier || '').trim();
    if (promptIdentifier) {
        return `prompt:${sanitizeInlineDrawerStorageSegment(promptIdentifier, 'prompt')}`;
    }

    if (element.classList.contains('extension_container')) {
        const extensionName = element.querySelector(':scope > .extension_name, .extension_name')?.textContent ?? '';
        if (extensionName) {
            return `extension:${sanitizeInlineDrawerStorageSegment(extensionName, 'extension')}`;
        }
    }

    return '';
}

function shouldPersistInlineDrawer(drawer) {
    return drawer instanceof HTMLElement
        && !drawer.matches(NN_INLINE_DRAWER_CUSTOM_PERSISTENCE_SELECTOR)
        && !drawer.closest('[data-sb-drawer-persistence="off"]');
}

function isTopLevelExtensionDrawer(drawer) {
    return drawer instanceof HTMLElement
        && Boolean(drawer.closest('#extensions_settings, #extensions_settings2'))
        && !drawer.parentElement?.closest('.inline-drawer');
}

function getInlineDrawerStorageKey(drawer) {
    if (!shouldPersistInlineDrawer(drawer)) {
        return null;
    }

    const contextSegments = [];
    for (let current = drawer.parentElement; current && current !== document.body; current = current.parentElement) {
        const segment = getInlineDrawerContextSegment(current);
        if (segment) {
            contextSegments.unshift(segment);
        }
    }

    if (!contextSegments.length) {
        return null;
    }

    const siblingInlineDrawers = drawer.parentElement
        ? Array.from(drawer.parentElement.children).filter(element => element instanceof HTMLElement && element.classList.contains('inline-drawer'))
        : [];
    const drawerIndex = Math.max(0, siblingInlineDrawers.indexOf(drawer));
    const drawerLabel = sanitizeInlineDrawerStorageSegment(getInlineDrawerHeaderText(drawer));

    return nnMobileShellLifecycle.inlineDrawers.derivePersistenceKey({
        drawerId: drawer.id ? sanitizeInlineDrawerStorageSegment(drawer.id) : '',
        context: {
            storagePrefix: NN_STORAGE_KEYS.settingsDrawerStatePrefix,
            contextSegments,
            drawerLabel,
            drawerIndex,
        },
    }) || null;
}

function getStoredInlineDrawerExpanded(drawer) {
    const storageKey = getInlineDrawerStorageKey(drawer);
    const storedValue = storageKey ? getPersistentStorageItem(storageKey) : null;

    if (storedValue !== null) {
        return normalizeStoredBoolean(storedValue, false);
    }

    const legacyStorageKey = getLegacySettingsDrawerStorageKey(drawer);
    if (!legacyStorageKey || legacyStorageKey === storageKey) {
        return null;
    }

    const legacyStoredValue = getPersistentStorageItem(legacyStorageKey);
    if (legacyStoredValue === null) {
        return null;
    }

    if (storageKey) {
        setPersistentStorageItem(storageKey, legacyStoredValue);
    }

    return normalizeStoredBoolean(legacyStoredValue, false);
}

function getInlineDrawers(root = document) {
    const drawers = [];

    if (root instanceof HTMLElement && root.classList.contains('inline-drawer')) {
        drawers.push(root);
    }

    if ('querySelectorAll' in root) {
        drawers.push(...root.querySelectorAll('.inline-drawer'));
    }

    return drawers;
}

function bindInlineDrawerPersistence(root = document) {
    for (const drawer of getInlineDrawers(root)) {
        if (!(drawer instanceof HTMLElement) || !shouldPersistInlineDrawer(drawer)) {
            continue;
        }

        const storedExpanded = getStoredInlineDrawerExpanded(drawer);
        if (storedExpanded !== null) {
            setInlineDrawerExpanded(drawer, storedExpanded);
        } else if (isTopLevelExtensionDrawer(drawer) && drawer.dataset.sbExtensionDefaultOpen !== 'true') {
            drawer.dataset.sbExtensionDefaultOpen = 'true';
            setInlineDrawerExpanded(drawer, true);
        }

        if (drawer.dataset.sbDrawerPersistenceBound === 'true') {
            continue;
        }

        drawer.addEventListener('inline-drawer-toggle', () => {
            const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon, :scope > .inline-drawer-toggle .inline-drawer-icon');
            const storageKey = getInlineDrawerStorageKey(drawer);
            if (!(icon instanceof HTMLElement) || !storageKey) {
                return;
            }

            setPersistentStorageItem(storageKey, String(icon.classList.contains('up')));
        });

        drawer.dataset.sbDrawerPersistenceBound = 'true';
    }
}

function queueInlineDrawerPersistenceBind() {
    if (nnInlineDrawerPersistenceQueued) {
        return;
    }

    nnInlineDrawerPersistenceQueued = true;
    window.requestAnimationFrame(() => {
        nnInlineDrawerPersistenceQueued = false;
        bindInlineDrawerPersistence(document.body);
    });
}

function getInlineDrawerPersistenceRoots() {
    return [
        document.getElementById('left-nav-panel'),
        document.getElementById('user-settings-block-content'),
        document.getElementById('extensions_settings'),
        document.getElementById('extensions_settings2'),
        document.getElementById('WorldInfo'),
        getCharacterPanel(),
    ].filter(element => element instanceof HTMLElement);
}

function ensureInlineDrawerPersistenceObserver() {
    if (nnInlineDrawerPersistenceObserver) {
        return;
    }

    const roots = getInlineDrawerPersistenceRoots();
    if (!roots.length) {
        return;
    }

    nnInlineDrawerPersistenceObserver = new MutationObserver(() => queueInlineDrawerPersistenceBind());
    for (const root of roots) {
        nnInlineDrawerPersistenceObserver.observe(root, { childList: true, subtree: true });
    }
}

function applyDefaultDrawerStates() {
    bindInlineDrawerPersistence(document.body);

    for (const drawerId of ['AppearanceSection', 'ChatCharactersSection']) {
        const drawer = document.getElementById(drawerId);
        if (drawer instanceof HTMLElement && getStoredInlineDrawerExpanded(drawer) === null) {
            setInlineDrawerExpanded(drawer, false);
        }
    }

    ensureInlineDrawerPersistenceObserver();
}

function syncMobileViewportState() {
    const viewportSyncStep = nnMobileShellLifecycle.viewportSync.step;
    const syncPlan = nnMobileShellLifecycle.viewportSync.resolveSyncPlan({
        isMobileViewport: isMobileViewport(),
    });
    const stepHandlers = {
        [viewportSyncStep.SYNC_SHELL_VIEWPORT_BOUNDS]: () => syncShellViewportBounds(),
        [viewportSyncStep.SYNC_MOBILE_SHELL_DRAWER_BOUNDS]: () => {
            syncMobileShellDrawerBounds();
        },
        [viewportSyncStep.CLOSE_MOBILE_NAV]: () => closeMobileNav(),
        [viewportSyncStep.CLOSE_MOBILE_CHAT_TOOLS]: () => closeMobileChatTools(),
        [viewportSyncStep.SYNC_MOBILE_SHELL_RAIL_ACTIONS]: () => syncMobileShellRailActions(),
        [viewportSyncStep.SYNC_DESKTOP_SHELL_SIZING]: () => syncDesktopShellSizing(),
        [viewportSyncStep.APPLY_TOPBAR_OFFSET]: () => applyTopbarOffset(),
        [viewportSyncStep.SYNC_CHATBAR_VISIBILITY_STATE]: () => syncChatbarVisibilityState(),
        [viewportSyncStep.UPDATE_TOP_BAR_BRAND]: () => updateTopBarBrand(),
        [viewportSyncStep.SCHEDULE_TOPBAR_CONTEXT_REFRESH]: () => scheduleTopbarContextRefresh(0),
        [viewportSyncStep.SYNC_MOBILE_MODAL_STATE]: () => syncMobileModalState(),
    };

    for (const step of syncPlan.steps) {
        const handler = stepHandlers[step];
        if (typeof handler !== 'function') {
            throw new Error(`Unknown mobile viewport sync step: ${step}`);
        }

        handler();
    }

    // Neconyan: after viewport sizing settles, give iOS shell scrollers enough
    // bottom inset to move focused bottom fields above the keyboard without
    // locking the document and exposing a blank Safari background.
    syncIOSKeyboardBottomInset();
}

let nnMobileViewportStateFrameId = 0;

function queueMobileViewportStateSync() {
    if (nnMobileViewportStateFrameId) {
        return;
    }

    if (typeof window.requestAnimationFrame !== 'function') {
        syncMobileViewportState();
        return;
    }

    nnMobileViewportStateFrameId = window.requestAnimationFrame(() => {
        nnMobileViewportStateFrameId = 0;
        syncMobileViewportState();
    });
}

function reinitSelect2AfterShell() {
    const modelSelectors = [
        '#mancer_model',
        '#model_togetherai_select',
        '#ollama_model',
        '#tabby_model',
        '#llamacpp_model',
        '#model_infermaticai_select',
        '#model_dreamgen_select',
        '#openrouter_model',
        '#vllm_model',
        '#aphrodite_model',
    ];

    if (isMobileViewport()) {
        // On mobile, destroy Select2 (doesn't work on iOS Safari); filter inputs come from installModelFilterInputs()
        for (const selector of modelSelectors) {
            const $el = $(selector);
            if ($el.length && $el.data('select2')) {
                try {
                    $el.select2('destroy');
                } catch {
                    // Ignore
                }
            }
        }
    } else {
        // On desktop, reinitialize Select2 after DOM reparenting
        const apiDropdownParent = $('#rm_api_block');
        const select2Defaults = {
            dropdownParent: apiDropdownParent.length ? apiDropdownParent : $(document.body),
            minimumResultsForSearch: 0,
        };
        const allSelectors = [...modelSelectors, '.openrouter_quantizations', '.openrouter_providers', '#nanogpt_allowed_providers', '#nanogpt_ignored_providers'];
        for (const selector of allSelectors) {
            const $el = $(selector);
            if ($el.length && $el.data('select2')) {
                try {
                    const config = $el.data('select2').options.options;
                    $el.select2('destroy');
                    $el.select2({ ...select2Defaults, ...config });
                } catch {
                    // Element may not have been initialized yet
                }
            }
        }
    }
}

function injectModelFilterInput($select) {
    if (!$select.length || $select.prev('.sb-model-filter').length) {
        return;
    }

    const select = $select[0];
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'sb-model-filter text_pole';
    input.placeholder = t`Filter models...`;
    input.setAttribute('aria-label', t`Filter models`);

    const snapshotModelOptions = () => Array.from(select.options).map(option => ({
        value: option.value,
        text: option.textContent,
    }));

    let masterOptions = snapshotModelOptions();

    // Neconyan: backends replace the option list when their models finish loading, so re-snapshot on
    // external DOM changes instead of freezing the boot-time list (which only holds the placeholder).
    const observer = new MutationObserver(() => {
        masterOptions = snapshotModelOptions();
        applyFilter();
    });

    const applyFilter = () => {
        const currentValue = select.value;
        const selectedValues = new Set(Array.from(select.selectedOptions, option => option.value));
        const visibleOptions = computeVisibleModelOptions(masterOptions, input.value, {
            currentValue,
            selectedValues: [...selectedValues],
            multiple: select.multiple,
        });

        observer.disconnect();
        select.innerHTML = '';
        for (const option of visibleOptions) {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.text;
            element.selected = select.multiple ? selectedValues.has(option.value) : option.value === currentValue;
            select.appendChild(element);
        }
        observer.observe(select, { childList: true });
    };

    input.addEventListener('input', applyFilter);
    observer.observe(select, { childList: true });
    $select.before(input);
}

function installModelFilterInputs() {
    const selectors = isMobileViewport()
        ? [...MODEL_FILTER_BOTH_VIEWPORTS_SELECTORS, ...MODEL_FILTER_PHONE_ONLY_SELECTORS]
        : MODEL_FILTER_BOTH_VIEWPORTS_SELECTORS;

    for (const selector of selectors) {
        injectModelFilterInput($(selector));
    }
}

function buildBottomChatBar() {
    const container = document.getElementById('sb-bottom-chat-bar');
    if (!(container instanceof HTMLElement)) {
        return;
    }

    container.replaceChildren();

    // Persona bubble
    const personaBubble = createElement('button', {
        id: 'sb-persona-bubble',
        attrs: { type: 'button', title: 'Switch persona' },
    });
    personaBubble.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePersonaPicker();
    });
    updatePersonaBubble(personaBubble);

    const reasoningButton = createElement('button', {
        id: 'sb-reasoning-effort-button',
        className: 'sb-bottom-chat-btn',
        attrs: { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', hidden: '' },
    });
    reasoningButton.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleReasoningEffortPicker();
    });

    const chatSelect = createElement('select', {
        id: 'sb-bottom-chat-select',
        attrs: { title: 'Switch chat' },
    });
    chatSelect.addEventListener('change', () => {
        void openChatById(chatSelect.value);
    });

    const collapseToggleBtn = createBottomChatButton({ icon: 'fa-chevron-up', title: 'Hide chat actions', className: 'sb-bottom-chat-collapse-toggle' }, () => {
        setBottomChatSecondaryOpen(!getBottomChatBarState().secondaryOpen);
    });
    collapseToggleBtn.setAttribute('aria-controls', 'sb-bottom-chat-secondary-row');
    collapseToggleBtn.setAttribute('aria-expanded', 'true');

    const search = createBottomChatSearchField();
    const searchToggleBtn = createBottomChatButton({ icon: 'fa-magnifying-glass', title: 'Search chat', className: 'sb-bottom-chat-search-toggle' }, () => {
        const shouldOpen = !getBottomChatBarState().searchOpen;
        setBottomChatSearchOpen(shouldOpen, { focusInput: shouldOpen });
    });
    searchToggleBtn.setAttribute('aria-controls', 'sb-bottom-chat-search-field');
    const navCluster = createElement('div', { className: 'sb-bottom-chat-nav-actions' });
    const managementCluster = createElement('div', { className: 'sb-bottom-chat-management-actions' });
    const secondaryRow = createElement('div', {
        id: 'sb-bottom-chat-secondary-row',
        className: 'sb-bottom-chat-secondary-row',
        attrs: {
            'aria-label': 'Chat actions',
        },
    });

    const topBtn = createBottomChatButton({ icon: 'fa-arrow-up', title: 'Go to top of chat' }, scrollCurrentChatToTop);
    const bottomBtn = createBottomChatButton({ icon: 'fa-arrow-down', title: 'Go to bottom of chat' }, scrollCurrentChatToBottom);
    const regenerateBtn = createBottomChatButton({ icon: 'fa-arrows-rotate', title: 'Regenerate the last reply' }, () => {
        document.getElementById('option_regenerate')?.click();
    });
    const chatManagerBtn = createBottomChatButton({ icon: 'fa-address-book', title: 'View chat files' }, handleChatManagerClick);
    const newBtn = createBottomChatButton({ icon: 'fa-plus', title: 'New chat' }, handleNewChat);
    const massDeleteBtn = createBottomChatButton({ icon: 'fa-list-check', title: 'Mass delete chats', className: 'sb-advanced-only' }, () => { void handleMassDeleteChats(); });
    const autoNameBtn = createBottomChatButton({ icon: 'fa-wand-magic-sparkles', title: 'Ask the LLM to name this chat', className: 'sb-advanced-only' }, () => { void handleAutoNameChat(); });
    const renameBtn = createBottomChatButton({ icon: 'fa-pencil', title: 'Rename chat' }, () => { void handleRenameChat(); });
    const hideBtn = createBottomChatButton({ icon: 'fa-eye-slash', title: 'Hide bottom chat bar' }, () => {
        setBottomChatBarVisible(false);
    });
    const deleteBtn = createBottomChatButton({ icon: 'fa-trash', title: 'Delete chat' }, () => { void handleDeleteChat(); });

    navCluster.append(topBtn, bottomBtn);
    managementCluster.append(regenerateBtn, chatManagerBtn, newBtn, massDeleteBtn, autoNameBtn, renameBtn, searchToggleBtn, hideBtn, deleteBtn);
    secondaryRow.append(managementCluster);
    container.append(personaBubble, reasoningButton, chatSelect, search.field, navCluster, collapseToggleBtn, secondaryRow);

    // Store references for refresh and late context binding retries.
    Object.assign(getBottomChatBarState(), {
        chatSelect,
        personaBubble,
        reasoningButton,
        searchField: search.field,
        searchInput: search.input,
        searchStatus: search.status,
        searchToggleButton: searchToggleBtn,
        collapseToggleButton: collapseToggleBtn,
        secondaryRow,
        scrollTopButton: topBtn,
        scrollBottomButton: bottomBtn,
        regenerateButton: regenerateBtn,
        managerButton: chatManagerBtn,
        massDeleteButton: massDeleteBtn,
        autoNameButton: autoNameBtn,
        hideButton: hideBtn,
    });
    syncBottomChatBarSecondaryState();
    syncBottomChatBarSearchState();
    setBottomChatBarVisible(nnState.bottomChatBar.visible, { persist: false });

    // Defer initial persona bubble update in case user_avatar isn't ready yet
    setTimeout(() => updatePersonaBubble(personaBubble), 100);
    updateReasoningEffortButton();

    // Close persona picker when clicking outside
    const bottomChatBarState = getBottomChatBarState();
    if (!bottomChatBarState.outsideClickBound) {
        document.addEventListener('click', (e) => {
            const picker = document.getElementById('sb-persona-picker');
            if (picker && !picker.contains(e.target) && e.target !== bottomChatBarState.personaBubble) {
                picker.remove();
            }
            if (!bottomChatBarState.reasoningButton?.contains(e.target) && !document.getElementById('sb-reasoning-effort-picker')?.contains(e.target)) {
                closeReasoningEffortPicker();
            }
        });
        bottomChatBarState.outsideClickBound = true;
    }

    bindBottomChatBarEvents();
    scheduleBottomChatBarRefresh(0);
}

function scheduleBottomChatBarRefresh(delay = 0) {
    window.clearTimeout(nnState.bottomChatBarRefreshTimer || 0);
    nnState.bottomChatBarRefreshTimer = window.setTimeout(() => {
        nnState.bottomChatBarRefreshTimer = 0;
        void refreshBottomChatSelect();
    }, delay);
}

async function refreshBottomChatSelect() {
    const chatSelect = nnState.bottomChatBar?.chatSelect;
    if (!(chatSelect instanceof HTMLSelectElement)) {
        return;
    }

    const chatContext = getChatUiContext();

    setButtonDisabled(nnState.bottomChatBar?.searchInput, !chatContext.hasChat);
    setButtonDisabled(nnState.bottomChatBar?.searchToggleButton, !chatContext.hasChat);
    setButtonDisabled(nnState.bottomChatBar?.scrollTopButton, !chatContext.hasChat);
    setButtonDisabled(nnState.bottomChatBar?.scrollBottomButton, !chatContext.hasChat);
    setButtonDisabled(nnState.bottomChatBar?.regenerateButton, !chatContext.hasChat);
    setButtonDisabled(nnState.bottomChatBar?.managerButton, !chatContext.canBrowseChats);
    setButtonDisabled(nnState.bottomChatBar?.massDeleteButton, !chatContext.canBrowseChats);
    setButtonDisabled(nnState.bottomChatBar?.autoNameButton, !chatContext.hasChat);

    if (!chatContext.context) {
        return;
    }

    const currentChatName = chatContext.chatId;
    chatSelect.replaceChildren();

    // Add placeholder option showing the current chat
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = currentChatName || 'No chat selected';
    placeholder.selected = true;
    chatSelect.appendChild(placeholder);

    if (!chatContext.canBrowseChats) {
        return;
    }

    try {
        const chats = await getChatFilesForContext(chatContext);
        const chatNames = chats.map(chat => chat.fileName);

        chatSelect.replaceChildren();

        for (const chat of chats) {
            const chatName = chat.fileName;
            if (!chatName) continue;
            const option = document.createElement('option');
            option.value = chatName;
            option.textContent = formatChatSelectorLabel(chatName, chat.tokenEstimate);
            option.selected = chatName === currentChatName;
            chatSelect.appendChild(option);
        }

        if (!chatNames.includes(currentChatName)) {
            const fallback = document.createElement('option');
            fallback.value = '';
            fallback.textContent = currentChatName || 'No chat selected';
            fallback.selected = true;
            chatSelect.prepend(fallback);
        }

        if (chatContext.canBrowseChats && chats.length === 0) {
            const attempts = Number(nnState.bottomChatBarRefreshAttempts ?? 0);
            if (attempts < 30) {
                nnState.bottomChatBarRefreshAttempts = attempts + 1;
                scheduleBottomChatBarRefresh(200 + Math.random() * 50);
            }
        } else {
            nnState.bottomChatBarRefreshAttempts = 0;
        }
    } catch {
        const attempts = Number(nnState.bottomChatBarRefreshAttempts ?? 0);
        if (attempts < 30) {
            nnState.bottomChatBarRefreshAttempts = attempts + 1;
            scheduleBottomChatBarRefresh(250 + Math.random() * 50);
        }
    }
}

const PERSONA_APPENDICES_METADATA_KEY = 'persona_appendices';

function getPersonaAppendixScopeKeyFromContext(context) {
    return String(context?.groupId || context?.characters?.[context?.characterId]?.avatar || PERSONA_APPENDICES_DEFAULT_SCOPE_KEY);
}

function normalizePersonaAppendixSelectionsFromContext(context, avatarId) {
    const descriptor = context?.powerUserSettings?.persona_descriptions?.[avatarId];
    if (!descriptor || typeof descriptor !== 'object') {
        return {};
    }

    const source = descriptor[PERSONA_APPENDICES_SELECTIONS_KEY];
    const normalized = {};

    if (source && typeof source === 'object' && !Array.isArray(source)) {
        for (const [scopeKey, activeIds] of Object.entries(source)) {
            if (!Array.isArray(activeIds)) {
                continue;
            }

            const cleanScopeKey = String(scopeKey || PERSONA_APPENDICES_DEFAULT_SCOPE_KEY);
            normalized[cleanScopeKey] = activeIds
                .map(String)
                .filter((id, index, array) => id && array.indexOf(id) === index);
        }
    }

    descriptor[PERSONA_APPENDICES_SELECTIONS_KEY] = normalized;
    return normalized;
}

function getPersonaAppendicesFromContext(context, avatarId) {
    const descriptor = context?.powerUserSettings?.persona_descriptions?.[avatarId];
    const appendices = Array.isArray(descriptor?.appendices) ? descriptor.appendices : [];
    return appendices.map((appendix, index) => ({
        id: String(appendix?.id || `appendix-${index}`),
        name: String(appendix?.name || `Scenario Note ${index + 1}`),
        description: String(appendix?.description || ''),
    }));
}

function getActivePersonaAppendixIdsFromContext(context, avatarId) {
    const selections = normalizePersonaAppendixSelectionsFromContext(context, avatarId);
    const scopeKey = getPersonaAppendixScopeKeyFromContext(context);
    const metadata = context?.chatMetadata?.[PERSONA_APPENDICES_METADATA_KEY];
    const legacyActiveIds = Array.isArray(metadata?.[avatarId]) ? metadata[avatarId] : [];
    const activeIds = Object.prototype.hasOwnProperty.call(selections, scopeKey) ? selections[scopeKey] : legacyActiveIds;
    const availableIds = new Set(getPersonaAppendicesFromContext(context, avatarId).map(appendix => appendix.id));
    return activeIds.map(String).filter((id, index, array) => availableIds.has(id) && array.indexOf(id) === index);
}

function getActivePersonaAppendicesFromContext(context, avatarId) {
    const activeIds = new Set(getActivePersonaAppendixIdsFromContext(context, avatarId));
    return getPersonaAppendicesFromContext(context, avatarId).filter(appendix => activeIds.has(appendix.id));
}

function getPersonaDisplayNameWithAppendices(context, avatarId, name) {
    const appendices = getActivePersonaAppendicesFromContext(context, avatarId);
    if (!appendices.length) {
        return name;
    }

    return `${name} + ${appendices.map(appendix => appendix.name).join(' + ')}`;
}

function composePersonaDescriptionFromContext(context, avatarId, activeIds = null) {
    const descriptor = context?.powerUserSettings?.persona_descriptions?.[avatarId];
    const appendices = getPersonaAppendicesFromContext(context, avatarId);
    const activeIdSet = new Set(activeIds ?? getActivePersonaAppendixIdsFromContext(context, avatarId));
    const chunks = [];
    const baseDescription = String(descriptor?.description ?? '').trim();

    if (baseDescription) {
        chunks.push(baseDescription);
    }

    for (const appendix of appendices) {
        const description = String(appendix.description ?? '').trim();
        if (activeIdSet.has(appendix.id) && description) {
            chunks.push(`[${appendix.name}]\n${description}`);
        }
    }

    return chunks.join('\n\n');
}

function syncPersonaDescriptionFromContext(context, avatarId, activeIds = null) {
    if (!context?.powerUserSettings || !avatarId) {
        return;
    }

    const { currentAvatarId } = getCurrentPersonaSelection(context);
    if (currentAvatarId === avatarId) {
        context.powerUserSettings.persona_description = composePersonaDescriptionFromContext(context, avatarId, activeIds);
    }
}

function setActivePersonaAppendixIdsFromContext(context, avatarId, ids) {
    if (!context?.powerUserSettings?.persona_descriptions?.[avatarId] || !avatarId) {
        return;
    }

    const availableIds = new Set(getPersonaAppendicesFromContext(context, avatarId).map(appendix => appendix.id));
    const cleanIds = ids.map(String).filter((id, index, array) => availableIds.has(id) && array.indexOf(id) === index);
    const selections = normalizePersonaAppendixSelectionsFromContext(context, avatarId);
    selections[getPersonaAppendixScopeKeyFromContext(context)] = cleanIds;

    syncPersonaDescriptionFromContext(context, avatarId, cleanIds);
    saveSettingsDebounced();
    const eventTypes = context.eventTypes ?? context.event_types;
    if (context.eventSource && eventTypes?.PERSONA_UPDATED) {
        void context.eventSource.emit(eventTypes.PERSONA_UPDATED, avatarId);
    }
}

function updatePersonaBubble(bubble) {
    if (!(bubble instanceof HTMLElement)) {
        bubble = document.getElementById('sb-persona-bubble');
    }
    if (!bubble) {
        return;
    }

    const { context, currentAvatarId, currentName } = getCurrentPersonaSelection();
    const avatarUrl = currentAvatarId
        ? (context?.getThumbnailUrl?.('persona', currentAvatarId) || `/User Avatars/${currentAvatarId}`)
        : '';

    if (avatarUrl) {
        bubble.style.backgroundImage = `url("${avatarUrl}")`;
    } else {
        bubble.style.backgroundImage = 'none';
    }
    bubble.setAttribute('title', `Persona: ${getPersonaDisplayNameWithAppendices(context, currentAvatarId, currentName)}`);
}

function quoteSlashCommandArgument(value) {
    return `"${String(value ?? '').replace(/(["\\])/g, '\\$1')}"`;
}

function getCurrentPersonaSelection(context = getSillyTavernContext()) {
    const personas = context?.powerUserSettings?.personas ?? {};
    const selectedAvatarId = document.querySelector('#user_avatar_block .avatar-container.selected[data-avatar-id]')?.getAttribute('data-avatar-id')
        ?? '';
    const currentAvatarId = String(context?.userAvatar ?? '').trim()
        || String(selectedAvatarId).trim()
        || '';
    const currentName = personas[currentAvatarId] || context?.name1 || 'You';

    return {
        context,
        personas,
        currentAvatarId,
        currentName,
    };
}

function getBottomChatBarState() {
    return nnState.bottomChatBar;
}

function setBottomChatBarVisible(shouldShow, { persist = true } = {}) {
    const nextVisible = Boolean(shouldShow);
    const bottomChatBarState = getBottomChatBarState();
    bottomChatBarState.visible = nextVisible;

    const container = document.getElementById('sb-bottom-chat-bar');
    if (container instanceof HTMLElement) {
        container.classList.toggle('displayNone', !nextVisible);
    }

    if (persist) {
        safeSetItem(NN_STORAGE_KEYS.bottomChatBarVisible, String(nextVisible));
    }

    for (const input of document.querySelectorAll('[data-sb-bottom-bar-visible-input]')) {
        if (input instanceof HTMLInputElement) {
            input.checked = nextVisible;
            input.closest('.sb-compact-mode-option')?.classList.toggle('is-selected', nextVisible);
        }
    }

    const optionIcon = document.querySelector('#option_toggle_bottom_bar i');
    const optionSpan = document.querySelector('#option_toggle_bottom_bar span');
    if (optionIcon instanceof HTMLElement) {
        optionIcon.className = `fa-lg fa-solid ${nextVisible ? 'fa-eye-slash' : 'fa-eye'}`;
    }
    if (optionSpan instanceof HTMLElement) {
        optionSpan.textContent = nextVisible ? 'Hide Bottom Bar' : 'Show Bottom Bar';
        optionSpan.setAttribute('data-i18n', nextVisible ? 'Hide Bottom Bar' : 'Show Bottom Bar');
    }
}

function toggleBottomChatBarVisibility() {
    setBottomChatBarVisible(!getBottomChatBarState().visible);
}

function scheduleBottomChatBarBindingRetry(delay = 240) {
    const bottomChatBarState = getBottomChatBarState();

    window.clearTimeout(bottomChatBarState.bindingRetryTimer);
    bottomChatBarState.bindingRetryTimer = window.setTimeout(() => {
        bindBottomChatBarEvents();
    }, delay);
}

function bindBottomChatBarWindowEvents() {
    const bottomChatBarState = getBottomChatBarState();

    if (bottomChatBarState.windowBindingsAttached) {
        return;
    }

    const refreshWithContext = () => {
        syncBottomChatBarSecondaryState();
        syncBottomChatBarSearchState();
        scheduleBottomChatBarRefresh(0);
        window.requestAnimationFrame(() => updatePersonaBubble(bottomChatBarState.personaBubble));
        bindBottomChatBarEvents();
    };

    window.addEventListener('pageshow', refreshWithContext, { passive: true });
    window.addEventListener('focus', refreshWithContext, { passive: true });
    window.addEventListener('resize', refreshWithContext, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            refreshWithContext();
        }
    });

    bottomChatBarState.windowBindingsAttached = true;
}

function bindBottomChatBarEvents() {
    const bottomChatBarState = getBottomChatBarState();
    const personaBubble = bottomChatBarState.personaBubble;
    const context = getSillyTavernContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes ?? context?.event_types;

    const toggleOption = document.getElementById('option_toggle_bottom_bar');
    if (toggleOption instanceof HTMLElement && !toggleOption.dataset.sbBound) {
        toggleOption.addEventListener('click', (event) => {
            event.preventDefault();
            toggleBottomChatBarVisibility();
        });
        toggleOption.dataset.sbBound = 'true';
    }

    bindBottomChatBarWindowEvents();

    if (!eventSource || !eventTypes) {
        scheduleBottomChatBarRefresh(0);
        window.requestAnimationFrame(() => updatePersonaBubble(personaBubble));
        scheduleBottomChatBarBindingRetry();
        return;
    }

    window.clearTimeout(bottomChatBarState.bindingRetryTimer);

    if (bottomChatBarState.boundEventSource === eventSource) {
        scheduleBottomChatBarRefresh(0);
        window.requestAnimationFrame(() => updatePersonaBubble(personaBubble));
        return;
    }

    const refresh = () => scheduleBottomChatBarRefresh(0);
    const refreshPersona = () => {
        window.requestAnimationFrame(() => {
            updatePersonaBubble(bottomChatBarState.personaBubble);
            refreshOpenPersonaPicker();
        });
    };
    const events = [
        eventTypes.APP_READY,
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_LOADED,
        eventTypes.CHAT_CREATED,
        eventTypes.GROUP_CHAT_CREATED,
        eventTypes.CHAT_DELETED,
        eventTypes.GROUP_CHAT_DELETED,
        eventTypes.MESSAGE_RECEIVED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_DELETED,
    ].filter(Boolean);
    const personaEvents = [
        eventTypes.PERSONA_CHANGED,
        eventTypes.PERSONA_UPDATED,
        eventTypes.APP_READY,
        eventTypes.CHAT_CHANGED,
        eventTypes.CHAT_LOADED,
        eventTypes.SETTINGS_UPDATED,
    ].filter(Boolean);

    for (const eventName of new Set(events)) {
        eventSource.on(eventName, refresh);
    }

    for (const eventName of new Set(personaEvents)) {
        eventSource.on(eventName, refreshPersona);
    }

    const refreshReasoningEffort = () => window.requestAnimationFrame(() => updateReasoningEffortButton());
    const reasoningEvents = [
        eventTypes.APP_READY,
        eventTypes.SETTINGS_LOADED_AFTER,
        eventTypes.SETTINGS_UPDATED,
        eventTypes.MAIN_API_CHANGED,
        eventTypes.CHATCOMPLETION_SOURCE_CHANGED,
        eventTypes.OAI_PRESET_CHANGED_AFTER,
        eventTypes.CONNECTION_PROFILE_LOADED,
    ].filter(Boolean);
    for (const eventName of new Set(reasoningEvents)) {
        eventSource.on(eventName, refreshReasoningEffort);
    }

    bottomChatBarState.boundEventSource = eventSource;
    scheduleBottomChatBarRefresh(0);
    refreshPersona();
}

function getReasoningEffortSelect() {
    const select = document.getElementById('openai_reasoning_effort');
    return select instanceof HTMLSelectElement ? select : null;
}

function isReasoningEffortAvailable(select = getReasoningEffortSelect()) {
    const context = getSillyTavernContext();
    return Boolean(select) && isReasoningEffortSupported({
        mainApi: context?.mainApi,
        source: context?.chatCompletionSettings?.chat_completion_source,
        dataSource: select.closest('[data-source]')?.getAttribute('data-source'),
    });
}

function bindReasoningEffortSelect(select) {
    if (select.dataset.sbReasoningBound === 'true') {
        return;
    }

    select.addEventListener('input', () => updateReasoningEffortButton());
    select.addEventListener('change', () => updateReasoningEffortButton());
    select.dataset.sbReasoningBound = 'true';
}

function updateReasoningEffortButton() {
    const button = getBottomChatBarState().reasoningButton;
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const select = getReasoningEffortSelect();
    const available = isReasoningEffortAvailable(select);
    button.hidden = !available;
    button.closest('#sb-bottom-chat-bar')?.classList.toggle('sb-has-reasoning-effort', available);
    if (!available) {
        closeReasoningEffortPicker();
        return;
    }

    bindReasoningEffortSelect(select);
    const fullLabel = select.selectedOptions[0]?.textContent?.trim() || select.value;
    const title = `${t`Reasoning Effort`}: ${fullLabel}`;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.dataset.effort = select.value;
    button.innerHTML = '<i class="fa-solid fa-brain" aria-hidden="true"></i><span></span>';
    button.querySelector('span').textContent = getReasoningEffortShortLabel(select.value);
}

function setReasoningEffort(value) {
    const select = getReasoningEffortSelect();
    if (!select || select.value === value) {
        return;
    }

    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    updateReasoningEffortButton();
}

function toggleReasoningEffortPicker() {
    if (document.getElementById('sb-reasoning-effort-picker')) {
        closeReasoningEffortPicker({ restoreFocus: true });
        return;
    }

    openReasoningEffortPicker();
}

function openReasoningEffortPicker() {
    const select = getReasoningEffortSelect();
    const button = getBottomChatBarState().reasoningButton;
    if (!(button instanceof HTMLElement) || !isReasoningEffortAvailable(select)) {
        return;
    }

    closePersonaPicker();
    const picker = createElement('div', {
        id: 'sb-reasoning-effort-picker',
        className: 'sb-persona-options',
        attrs: { role: 'listbox', 'aria-label': t`Reasoning Effort` },
    });
    for (const option of Array.from(select.options)) {
        const isActive = option.value === select.value;
        const item = createElement('button', {
            className: `sb-persona-option${isActive ? ' is-active' : ''}`,
            attrs: { type: 'button', role: 'option', 'aria-selected': String(isActive) },
        });
        item.innerHTML = `<i class="fa-solid ${isActive ? 'fa-check' : 'fa-brain'} fa-fw" aria-hidden="true"></i><span class="sb-persona-option-name"></span>`;
        item.querySelector('span').textContent = option.textContent?.trim() || option.value;
        item.addEventListener('click', () => {
            setReasoningEffort(option.value);
            closeReasoningEffortPicker({ restoreFocus: true });
        });
        picker.appendChild(item);
    }
    picker.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeReasoningEffortPicker({ restoreFocus: true });
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const items = Array.from(picker.querySelectorAll('.sb-persona-option'));
            const index = items.indexOf(document.activeElement);
            const step = event.key === 'ArrowDown' ? 1 : -1;
            items[(index + step + items.length) % items.length]?.focus({ preventScroll: true });
        }
    });

    document.body.appendChild(picker);
    button.setAttribute('aria-expanded', 'true');
    positionPersonaPicker(picker, button);
    (picker.querySelector('.is-active') ?? picker.querySelector('button'))?.focus({ preventScroll: true });
}

function closeReasoningEffortPicker({ restoreFocus = false } = {}) {
    const picker = document.getElementById('sb-reasoning-effort-picker');
    if (!picker) {
        return;
    }

    picker.remove();
    const button = getBottomChatBarState().reasoningButton;
    button?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
        button?.focus({ preventScroll: true });
    }
}

function togglePersonaPicker() {
    const existing = document.getElementById('sb-persona-picker');
    if (existing) {
        existing.remove();
        document.getElementById('sb-persona-bubble')?.focus({ preventScroll: true });
        return;
    }

    openPersonaPicker();
}

function openPersonaPicker({ focus = true } = {}) {
    const context = getSillyTavernContext();
    if (!context) return;
    closeReasoningEffortPicker();

    const { personas, currentAvatarId } = getCurrentPersonaSelection(context);
    const personaDescriptions = context?.powerUserSettings?.persona_descriptions ?? {};
    const picker = createElement('div', {
        id: 'sb-persona-picker',
        attrs: {
            role: 'dialog',
            'aria-label': 'Switch persona',
        },
    });
    const optionsList = createElement('div', {
        className: 'sb-persona-options',
        attrs: {
            role: 'listbox',
            'aria-label': 'Choose persona',
        },
    });
    picker.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closePersonaPicker({ restoreFocus: true });
        }
    });

    const keys = Object.keys(personas).filter(avatarId => {
        const name = personas[avatarId];
        // Skip auto-created unnamed entries; always show the active persona
        const isActive = avatarId === currentAvatarId;
        return isActive || (name && name !== '[Unnamed Persona]');
    });

    if (!keys.length) {
        const empty = createElement('div', { className: 'sb-persona-option-empty' });
        empty.textContent = 'No personas defined';
        optionsList.appendChild(empty);
    } else {
        for (const avatarId of keys) {
            const name = personas[avatarId] || avatarId;
            const title = personaDescriptions[avatarId]?.title || '';
            const isActive = avatarId === currentAvatarId;
            addPersonaOption(optionsList, avatarId, name, title, isActive, context);
        }
    }

    picker.appendChild(optionsList);
    renderPersonaPickerAppendixControls(picker, context, currentAvatarId);

    const bubble = document.getElementById('sb-persona-bubble');
    if (bubble instanceof HTMLElement) {
        document.body.appendChild(picker);
        positionPersonaPicker(picker, bubble);
        if (focus) {
            const activeOption = picker.querySelector('.sb-persona-option.is-active');
            const firstOption = picker.querySelector('.sb-persona-option');
            const firstControl = picker.querySelector('button, input');
            (activeOption ?? firstOption ?? firstControl)?.focus({ preventScroll: true });
        }
    }
}

function refreshOpenPersonaPicker() {
    const existing = document.getElementById('sb-persona-picker');
    if (!existing) {
        return;
    }

    existing.remove();
    openPersonaPicker({ focus: false });
}

function renderPersonaPickerAppendixControls(picker, context, avatarId) {
    if (!avatarId) {
        return;
    }

    const appendices = getPersonaAppendicesFromContext(context, avatarId);
    const personas = context?.powerUserSettings?.personas ?? {};
    const personaName = personas[avatarId] || avatarId;
    const activeIds = new Set(getActivePersonaAppendixIdsFromContext(context, avatarId));
    const section = createElement('section', {
        className: 'sb-persona-picker-appendices',
        attrs: { 'aria-label': `Scenario Notes for ${personaName}` },
    });
    const header = createElement('div', { className: 'sb-persona-picker-appendices-header' });
    const title = createElement('strong', { text: 'Scenario Notes' });
    const count = createElement('span', { className: 'sb-persona-picker-appendices-count' });
    const updateCount = () => {
        const activeCount = appendices.filter(appendix => activeIds.has(appendix.id)).length;
        count.textContent = `${activeCount}/${appendices.length} on`;
        count.hidden = !appendices.length;
    };
    updateCount();
    const manageButton = createElement('button', {
        className: 'sb-persona-picker-manage menu_button menu_button_icon',
        attrs: { type: 'button', title: 'Manage Scenario Notes' },
    });
    manageButton.innerHTML = '<i class="fa-solid fa-pen-to-square fa-fw" aria-hidden="true"></i><span>Manage</span>';
    manageButton.addEventListener('click', openPersonaAppendicesManager);
    header.append(title, count, manageButton);
    section.appendChild(header);

    if (!appendices.length) {
        const empty = createElement('p', { className: 'sb-persona-picker-appendices-empty', text: 'No Scenario Notes on this persona yet.' });
        section.appendChild(empty);
        picker.appendChild(section);
        return;
    }

    const controls = createElement('div', {
        className: 'sb-persona-picker-appendix-toggles',
        attrs: { role: 'group', 'aria-label': 'Use with Scenario Notes' },
    });
    for (const appendix of appendices) {
        const label = createElement('label', { className: 'sb-persona-picker-appendix-toggle', attrs: { title: appendix.name } });
        const checkbox = createElement('input', {
            attrs: {
                type: 'checkbox',
                value: appendix.id,
            },
        });
        checkbox.checked = activeIds.has(appendix.id);
        checkbox.addEventListener('change', () => {
            const nextIds = getActivePersonaAppendixIdsFromContext(context, avatarId).filter(id => id !== appendix.id);
            if (checkbox.checked) {
                nextIds.push(appendix.id);
            }
            setActivePersonaAppendixIdsFromContext(context, avatarId, nextIds);
            if (checkbox.checked) {
                activeIds.add(appendix.id);
            } else {
                activeIds.delete(appendix.id);
            }
            updateCount();
            updatePersonaBubble();
        });

        const labelText = createElement('span', { text: appendix.name });
        label.append(checkbox, labelText);
        controls.appendChild(label);
    }

    section.appendChild(controls);
    picker.appendChild(section);
}

function openPersonaAppendicesManager() {
    closePersonaPicker();
    openCharacterPanelTab('persona');

    window.setTimeout(() => {
        document.getElementById('persona_workspace_tab_edit')?.click();
        document.getElementById('persona_editor_tab_prompt')?.click();
        const appendicesHeading = document.getElementById('persona_appendices_heading');
        const addButton = document.getElementById('persona_appendix_add');
        const appendicesBlock = appendicesHeading?.closest('details');
        if (appendicesBlock instanceof HTMLDetailsElement) {
            appendicesBlock.open = true;
        }
        scrollElementIntoManagedView(appendicesHeading ?? addButton, { block: 'center', behavior: getReducedMotionScrollBehavior() });
        addButton?.focus({ preventScroll: true });
    }, 160);
}

function positionPersonaPicker(picker, bubble) {
    const bubbleRect = bubble.getBoundingClientRect();
    picker.style.visibility = 'hidden';
    picker.style.left = '0px';
    picker.style.top = '0px';
    picker.style.right = 'auto';
    picker.style.bottom = 'auto';

    requestAnimationFrame(() => {
        const pickerRect = picker.getBoundingClientRect();
        const viewportPadding = 8;
        const left = Math.min(
            Math.max(viewportPadding, bubbleRect.left),
            Math.max(viewportPadding, window.innerWidth - pickerRect.width - viewportPadding),
        );
        const top = Math.max(
            viewportPadding,
            bubbleRect.top - pickerRect.height - viewportPadding,
        );

        picker.style.left = `${Math.round(left)}px`;
        picker.style.top = `${Math.round(top)}px`;
        picker.style.visibility = '';
    });
}

function closePersonaPicker({ restoreFocus = false } = {}) {
    const picker = document.getElementById('sb-persona-picker');
    if (picker) {
        picker.remove();
    }

    if (restoreFocus) {
        document.getElementById('sb-persona-bubble')?.focus({ preventScroll: true });
    }
}

function focusPersonaOption(picker, offset) {
    const options = Array.from(picker.querySelectorAll('.sb-persona-option'));
    const currentIndex = options.indexOf(document.activeElement);
    const nextIndex = currentIndex === -1
        ? 0
        : (currentIndex + offset + options.length) % options.length;
    options[nextIndex]?.focus({ preventScroll: true });
}

async function selectPersonaOption(option, picker, avatarId, context) {
    picker.querySelectorAll('.sb-persona-option').forEach(element => {
        element.classList.toggle('is-active', element === option);
        element.setAttribute('aria-selected', String(element === option));
    });
    closePersonaPicker();
    const execSlash = context?.executeSlashCommandsWithOptions;
    let switched = false;
    if (typeof execSlash === 'function') {
        try {
            await execSlash(`/persona-set ${quoteSlashCommandArgument(avatarId)}`);
            switched = true;
        } catch (error) {
            console.warn('[Neconyan] Persona switch via slash command failed, falling back to DOM selection.', error);
        }
    }

    if (!switched) {
        // Fallback: try clicking the DOM avatar
        const avatarBlock = document.getElementById('user_avatar_block');
        const domAvatar = avatarBlock?.querySelector(`.avatar-container[title="${CSS.escape(avatarId)}"]`);
        if (domAvatar instanceof HTMLElement) {
            domAvatar.click();
        } else {
            openCharacterPanelTab('persona');
        }
    }

    updatePersonaBubble();
    document.getElementById('sb-persona-bubble')?.focus({ preventScroll: true });
}

function addPersonaOption(picker, avatarId, name, title, isActive, context) {
    const option = createElement('button', {
        className: `sb-persona-option${isActive ? ' is-active' : ''}`,
        attrs: {
            type: 'button',
            role: 'option',
            'aria-selected': String(isActive),
        },
    });

    const img = createElement('img', {
        className: 'sb-persona-option-avatar',
        attrs: {
            src: `/User Avatars/${avatarId}`,
            alt: name,
            loading: 'lazy',
        },
    });
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });

    const label = createElement('span', { className: 'sb-persona-option-name' });
    label.textContent = name;
    const info = createElement('div', { className: 'sb-persona-option-info' });
    info.appendChild(label);

    if (title) {
        const desc = createElement('span', { className: 'sb-persona-option-description' });
        desc.textContent = title;
        info.appendChild(desc);
    }

    const activeAppendices = getActivePersonaAppendicesFromContext(context, avatarId);
    if (activeAppendices.length) {
        const chips = createElement('span', { className: 'sb-persona-option-appendices' });
        for (const appendix of activeAppendices) {
            chips.appendChild(createElement('span', { className: 'sb-persona-appendix-chip', text: `+ ${appendix.name}` }));
        }
        info.appendChild(chips);
    }

    option.append(img, info);

    option.addEventListener('click', () => { void selectPersonaOption(option, picker, avatarId, context); });
    option.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            focusPersonaOption(picker, 1);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            focusPersonaOption(picker, -1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            picker.querySelector('.sb-persona-option')?.focus({ preventScroll: true });
        } else if (event.key === 'End') {
            event.preventDefault();
            Array.from(picker.querySelectorAll('.sb-persona-option')).at(-1)?.focus({ preventScroll: true });
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closePersonaPicker({ restoreFocus: true });
        }
    });

    picker.appendChild(option);
}

function initAll() {
    if (nnState.initialized) {
        return;
    }

    const leftShellRoot = document.getElementById(getShellConfig('left').rootPanelId);
    const rightShellRoot = document.getElementById(getShellConfig('right').rootPanelId);
    const topBarRoot = document.getElementById('top-bar');
    const bottomChatBarRoot = document.getElementById('sb-bottom-chat-bar');

    if (!(leftShellRoot instanceof HTMLElement)
        || !(rightShellRoot instanceof HTMLElement)
        || !(topBarRoot instanceof HTMLElement)
        || !(bottomChatBarRoot instanceof HTMLElement)) {
        if (!nnState.initObserver && document.body instanceof HTMLElement) {
            nnState.initObserver = new MutationObserver(() => {
                if (!nnState.initialized) {
                    initAll();
                }
            });
            nnState.initObserver.observe(document.body, { childList: true, subtree: true });
        }

        if (!nnState.initRetryTimer && nnState.initRetryCount < NN_INIT_MAX_RETRIES) {
            nnState.initRetryTimer = window.setTimeout(() => {
                nnState.initRetryTimer = 0;
                nnState.initRetryCount += 1;
                initAll();
            }, NN_INIT_RETRY_DELAY_MS);
        }
        return;
    }

    window.clearTimeout(nnState.initRetryTimer);
    nnState.initRetryTimer = 0;
    nnState.initRetryCount = 0;
    nnState.initObserver?.disconnect();
    nnState.initObserver = null;
    nnState.initialized = true;

    restorePersistedTopbarState();
    seedTopbarScaleDefaults();
    hideHostToggles();
    forceDrawerState(leftShellRoot, false, getShellConfig('left').hostIconSelector);
    forceDrawerState(rightShellRoot, false, getShellConfig('right').hostIconSelector);
    buildShell('left');
    buildShell('right');
    buildMobileNav();
    bindNeconyanModeStateEvents();
    buildMobileChatTools();
    injectCharacterDrawerControls();
    bindCharacterEditorExitButton();
    bindCharacterDrawerStateObserver();
    setShellTheme(nnState.theme, { persist: false });
    setFrontendIconPreference(nnState.frontendIcon, { persist: false });
    setSurfaceTransparency(nnState.surfaceTransparency, { persist: false });
    setPaperTextureEnabled(nnState.paperTextureEnabled, { persist: false });
    setPaperTextureOpacity(nnState.paperTextureOpacity, { persist: false });
    setCompactMode(nnState.compactMode, { persist: false });
    setTourButtonsHidden(nnState.tourButtonsHidden, { persist: false });
    setDesktopShellSnapToChatWidth(nnState.shellSizing.snapToChatWidth, { persist: false });
    setCharacterDrawerRightLock(nnState.characterDrawer.rightLocked, { persist: false });
    setTopbarScale('desktop', nnState.topbarScale.desktop, { persist: false });
    setTopbarScale('mobile', nnState.topbarScale.mobile, { persist: false });
    setBottomBarScale(nnState.bottomBarScale, { persist: false });
    setDesktopButtonScale(nnState.desktopButtonScale, { persist: false });
    setMobileButtonScale(nnState.mobileButtonScale, { persist: false });
    applyDesktopNavPreferences();
    applyMobileNavPreferences();
    bindComposerControlPlacement();
    initChatAvatarVariables();
    syncDesktopShellSizing();
    buildTopBar();
    // Must follow buildTopBar(): it rearranges the buttons that call creates.
    applyTopbarIconsOnlyPreference();
    bindLandingPageObserver();
    buildBottomChatBar();
    // Neconyan: user input ends the ⬇ scroll-to-bottom ladder so a mid-ladder flick is not snapped back.
    getChatScrollElement()?.addEventListener('wheel', cancelPendingBottomChatScroll, { passive: true });
    getChatScrollElement()?.addEventListener('touchstart', cancelPendingBottomChatScroll, { passive: true });
    // Refresh again after the current JS task — APP_READY may have already
    // fired before this listener was registered, so the initial call in
    // buildBottomChatBar() may have found no active chat yet.
    scheduleBottomChatBarRefresh(0);
    bindTopbarDragEvents();
    bindChatbarEvents();
    bindClearCookiesAndCacheButton();
    bindMessageActionExtensionEvents();
    syncMessageActionExtensionVisibility();
    scheduleChatbarRefresh(0);
    interceptDrawerOpeners();
    bindWorldInfoRoute();
    bindCharacterEditorSubTabs();
    applyDefaultDrawerStates();
    bindInlineDrawerAutoCloseToggle();
    syncMobileViewportState();

    window.addEventListener('resize', queueMobileViewportStateSync, { passive: true });
    window.addEventListener('orientationchange', queueMobileViewportStateSync);
    window.visualViewport?.addEventListener('resize', queueMobileViewportStateSync, { passive: true });
    // Neconyan: iOS can move visualViewport.offsetTop without resizing while the keyboard is open.
    window.visualViewport?.addEventListener('scroll', queueMobileViewportStateSync, { passive: true });
    window.visualViewport?.addEventListener('resize', syncDesktopShellSizing, { passive: true });

    // Neconyan: keep focused inputs in mobile settings drawers above the
    // virtual keyboard. The fixed/clipped body blocks native scrolling, so the
    // real panel scroller is nudged manually after viewport changes.
    document.addEventListener('focusin', scheduleMobileFocusedInputScroll);
    document.addEventListener('focusout', scheduleMobileFocusedInputScroll);
    window.visualViewport?.addEventListener('resize', scheduleMobileFocusedInputScroll, { passive: true });
    window.visualViewport?.addEventListener('scroll', scheduleMobileFocusedInputScroll, { passive: true });

    // Neconyan: popup dialogs sit outside the shell scrollers; shift them
    // above the virtual keyboard instead so the browser never pans the visual
    // viewport away from the top bar (see syncMobilePopupKeyboardShift).
    document.addEventListener('focusin', scheduleMobilePopupKeyboardSync);
    document.addEventListener('focusout', scheduleMobilePopupKeyboardSync);
    window.visualViewport?.addEventListener('resize', scheduleMobilePopupKeyboardSync, { passive: true });
    window.visualViewport?.addEventListener('scroll', scheduleMobilePopupKeyboardSync, { passive: true });

    // Neconyan: keep iOS drawer scroller padding in sync with keyboard focus;
    // this provides scroll range for bottom inputs without fixing the document.
    if (isIOSWebKitPlatform()) {
        document.addEventListener('focusin', syncIOSKeyboardBottomInset);
        document.addEventListener('focusout', syncIOSKeyboardBottomInset);
        document.addEventListener('focusin', queueMobileViewportStateSync);
        document.addEventListener('focusout', queueMobileViewportStateSync);
    }

    if (isLegacyIOSWebKitPlatform()) {
        document.addEventListener('focusin', handleComposerKeyboardFocusIn);
        document.addEventListener('focusout', handleMobileKeyboardFocusOut);
    }

    // Neconyan: re-sync shell width when the chat width slider changes so settings
    // panels narrow alongside the chat container (matches standard ST behaviour).
    $(document).on('input change mouseup touchend', '#chat_width_slider', () => {
        syncDesktopShellSizing();
    });

    // Reinitialize Select2 widgets after shell reparents DOM elements.
    // Select2 bindings break when elements are moved in the DOM.
    reinitSelect2AfterShell();

    // One filter box above every model dropdown that has no search of its own.
    installModelFilterInputs();

    // Group Advanced Formatting sections into collapsible drawers
    groupAdvancedFormattingIntoDrawers();

    const neconyanShell = /** @type {any} */ (globalThis.NeconyanShell || {});
    globalThis.NeconyanShell = Object.assign(neconyanShell, {
        refreshRailQuickActions: refreshNeconyanRailQuickActions,
        editQuickActions: editNeconyanRailQuickActions,
        openExtensionSettings,
        openIncludedTool: openNeconyanIncludedToolPage,
        openTab(shellKey, tabId) {
            if (shellKey === 'characters') {
                openCharacterPanelTab(tabId);
                return;
            }

            if (NN_SHELLS[shellKey]) {
                openShell(shellKey, tabId);
            }
        },
        openCharacters() {
            toggleCharacterPanel();
        },
        closeCharacters() {
            closeCharacterPanel();
        },
        restorePinnedCharacterPanel,
        closeAgents() {
            if (isShellTabOpen('left', 'agents')) closeShell('left');
        },
        closeWorkspace,
        isMobileViewport,
        highlightCharacterEditorTab() {
            const editorTab = document.querySelector('[data-sb-character-tab="editor"]');
            if (editorTab instanceof HTMLElement) {
                flashHighlight($(editorTab), 1000);
            }
        },
        openGlobalSearch({ focusInput = true } = {}) {
            closeAllDropdowns({ except: 'search' });
            setUniversalSearchOpenState(true, { focusInput });
        },
        showHome() {
            return returnToLandingPage();
        },
        focusTab(route) {
            const normalizedRoute = route === 'left:world-info' ? 'characters:world-info' : String(route || '');
            const [shellKey, tabId] = normalizedRoute.split(':');
            const selector = shellKey === 'characters'
                ? `[data-sb-character-tab="${CSS.escape(tabId || '')}"]`
                : `[data-sb-tab="${CSS.escape(tabId || '')}"]`;
            window.setTimeout(() => {
                const target = document.querySelector(selector);
                if (target instanceof HTMLElement) {
                    target.focus({ preventScroll: true });
                    flashHighlight($(target), 1400);
                }
            }, 80);
        },
        applyTheme(themeId) {
            setShellTheme(themeId);
        },
        setFrontendIcon(iconId) {
            setFrontendIconPreference(iconId);
        },
        setSurfaceTransparency(value) {
            setSurfaceTransparency(value);
        },
        setTopbarScale(mode, value) {
            setTopbarScale(mode, value);
        },
        setMobileButtonScale(value) {
            setMobileButtonScale(value);
        },
        setDesktopButtonScale(value) {
            setDesktopButtonScale(value);
        },
        setCompactMode(value) {
            setCompactMode(value);
        },
        activateMode(mode) {
            return activateNeconyanMode(mode);
        },
        getActiveMode() {
            return getActualNeconyanMode();
        },
        setDesktopShellSnapToChatWidth(value) {
            setDesktopShellSnapToChatWidth(value);
        },
        setMessageStyle,
        openChatTools() {
            if (isMobileViewport()) {
                openMobileChatTools();
                return;
            }

            setChatSidebarOpenState(true);
        },
        toggleChatSidebar() {
            toggleChatSidebar();
        },
        toggleMobileChatTools,
        toggleChatbarVisibility() {
            toggleChatbarVisibility();
        },
        resetTopbarPosition() {
            setTopbarOffset({ x: 0, y: 0 });
        },
        getTheme() {
            return nnState.theme;
        },
        getFrontendIcon() {
            return nnState.frontendIcon;
        },
        getSurfaceTransparency() {
            return nnState.surfaceTransparency;
        },
        getTopbarScale(mode) {
            return mode === 'mobile'
                ? nnState.topbarScale.mobile
                : nnState.topbarScale.desktop;
        },
        getMobileButtonScale() {
            return nnState.mobileButtonScale;
        },
        getDesktopButtonScale() {
            return nnState.desktopButtonScale;
        },
        getCompactMode() {
            return nnState.compactMode;
        },
        getAdvancedMode() {
            // The Advanced/Simple toggle is retired: every control is always available.
            return true;
        },
    });
}

export async function consumeNeconyanRoute() {
    if (!nnState.initialized) {
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const view = params.get('neconyanView');
    if (!view) {
        return;
    }

    if (view === 'conversation') {
        const avatar = params.get('neconyanAvatar') || '';
        const characterId = characters.findIndex(character => character?.avatar === avatar);
        if (characterId === -1) {
            globalThis.NeconyanShell?.openCharacters?.();
            return;
        }

        const { selectConversationThread } = await import('./neconyan-conversation/chrome.js');
        const opened = await selectConversationThread(avatar, {
            branchId: params.get('branchId') || '',
            groupId: params.get('groupId') || null,
            personaId: params.get('personaId') || undefined,
            showToast: false,
        });
        if (!opened) {
            toastr.warning('This conversation could not be opened. Choose it from Characters or Home.');
            return;
        }
        const { hideWelcomeHome } = await import('./welcome-screen.js');
        hideWelcomeHome();
    } else if (view === 'characters') {
        openCharacterPanelTab('characters');
    } else if (view === 'world-info') {
        openCharacterPanelTab('world-info');
    } else if (view === 'extensions') {
        openShell('right', 'extensions');
    } else if (view === 'connections') {
        openShell('left', 'api');
    } else if (view === 'settings') {
        openShell('right', 'settings');
    } else {
        return;
    }

    for (const key of ['neconyanView', 'neconyanAvatar', 'branchId', 'groupId', 'personaId']) {
        params.delete(key);
    }
    const nextQuery = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`);
}

// Init shell UI as soon as DOM is ready.
// Also re-trigger on APP_READY as a safety net for slow-loading environments.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
} else {
    window.setTimeout(initAll, 120);
}

// Safety net: ensure init runs after the full app is ready (covers slow VPS /
// slow networks where DOMContentLoaded fires but scripts haven't set up UI).
const ctx = getSillyTavernContext();
if (ctx?.eventSource && ctx?.event_types) {
    bindMessageActionExtensionEvents();
    ctx.eventSource.on(ctx.event_types.APP_READY, () => {
        if (!nnState.initialized) {
            initAll();
        } else {
            bindMessageActionExtensionEvents();
            syncMessageActionExtensionVisibility();
        }
    });
}

// Run links after every APP_READY listener, including async Home and extension setup.
window.addEventListener('neconyan:ready', () => {
    startNeconyanUpdateToast();
});

/** Close presentations through their existing lifecycle; never load a default chat. */
export async function prepareSavedChatMode(mode, navigationGuard = () => true) {
    if (isNeconyanModeBusy() || !navigationGuard()) return false;
    if (mode === 'story') {
        const definition = getNeconyanModeDefinition('story');
        if (!findExtension(definition?.extension)?.enabled || typeof getNeconyanModeLifecycle('story')?.setEnabled !== 'function') return false;
    }
    const context = getNeconyanModeContext();
    return await closeActiveNeconyanMode(mode === 'story' ? 'roleplay' : mode, context, { presentationOnly: true, navigationGuard }) && navigationGuard();
}

export async function presentSavedStory(navigationGuard = () => true) {
    if (!navigationGuard()) return false;
    const lifecycle = getNeconyanModeLifecycle('story');
    return typeof lifecycle?.setEnabled === 'function' && await lifecycle.setEnabled(true, { presentationOnly: true, navigationGuard }) !== false && navigationGuard();
}

export async function presentSavedRoleplay(navigationGuard = () => true) {
    if (!navigationGuard()) return false;
    if (getActualNeconyanMode() !== 'story') return true;
    const lifecycle = getNeconyanModeLifecycle('story');
    return typeof lifecycle?.setEnabled === 'function' && await lifecycle.setEnabled(false, { presentationOnly: true, navigationGuard }) !== false && navigationGuard();
}
