export const LOW_MEMORY_MODE_STORAGE_KEY = 'neconyan:low-memory-mode:v1';
export const LOW_MEMORY_MODES = Object.freeze({
    AUTO: 'auto',
    ON: 'on',
    OFF: 'off',
});
export const RECOGNISED_BROWSER_MEMORY_BUCKETS = Object.freeze([0.25, 0.5, 1, 2, 4, 8]);
export const LOW_MEMORY_BROWSER_MAX_GB = 2;
export const LOW_MEMORY_NATIVE_MAX_MIB = 3072;
export const LOW_MEMORY_ROLEPLAY_WINDOW_SIZE = 25;
export const LOW_MEMORY_CONVERSATION_WINDOW_SIZE = 25;
export const NORMAL_CONVERSATION_WINDOW_SIZE = 200;
export const NORMAL_ROLEPLAY_WINDOW_DEFAULT = 100;
export const NORMAL_ROLEPLAY_WINDOW_MAX = 200;
export const AGGRESSIVE_ROLEPLAY_WINDOW_DEFAULT = 5;
export const LOW_MEMORY_PREFERENCES_KEY = 'low_memory_preferences';
export const LOW_MEMORY_PREFERENCES_VERSION = 1;
export const LOW_MEMORY_MANAGED_KEYS = Object.freeze([
    'fast_ui_mode',
    'chat_truncation',
    'aggressive_dom_unload',
    'aggressive_dom_window_size',
]);
export const LOW_MEMORY_HISTORY_KEYS = Object.freeze([
    'chat_truncation',
    'aggressive_dom_unload',
    'aggressive_dom_window_size',
]);
export const LOW_MEMORY_SHIPPED_DEFAULTS = Object.freeze({
    fast_ui_mode: false,
    chat_truncation: 100,
    aggressive_dom_unload: false,
    aggressive_dom_window_size: 5,
});

const MAX_VALID_NATIVE_MEMORY_MIB = 1048576;
const observedBaseByTarget = new WeakMap();
const storageListenerByWindow = new WeakMap();
let controlHydrationDepth = 0;

export function normalizeLowMemoryMode(mode) {
    if (mode === LOW_MEMORY_MODES.ON || mode === LOW_MEMORY_MODES.OFF || mode === LOW_MEMORY_MODES.AUTO) {
        return mode;
    }
    return LOW_MEMORY_MODES.AUTO;
}

export function validateAndroidMemoryProfile(profile) {
    let candidate = profile;
    if (typeof candidate === 'string') {
        try {
            candidate = JSON.parse(candidate);
        } catch {
            return null;
        }
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return null;
    }
    if (candidate.schema !== 1 || typeof candidate.isLowRamDevice !== 'boolean') {
        return null;
    }
    const totalMemoryMiB = candidate.totalMemoryMiB;
    if (
        typeof totalMemoryMiB !== 'number'
        || !Number.isFinite(totalMemoryMiB)
        || totalMemoryMiB <= 0
        || Math.floor(totalMemoryMiB) !== totalMemoryMiB
        || totalMemoryMiB > MAX_VALID_NATIVE_MEMORY_MIB
    ) {
        return null;
    }
    return Object.freeze({
        schema: 1,
        totalMemoryMiB,
        isLowRamDevice: candidate.isLowRamDevice,
    });
}

export function normalizeBrowserDeviceMemory(deviceMemory) {
    if (
        typeof deviceMemory !== 'number'
        || !Number.isFinite(deviceMemory)
        || !RECOGNISED_BROWSER_MEMORY_BUCKETS.includes(deviceMemory)
    ) {
        return null;
    }
    return deviceMemory;
}

export function classifyDeviceMemory({ deviceMemory, nativeMemory } = {}) {
    const validNative = validateAndroidMemoryProfile(nativeMemory);
    const browserGb = normalizeBrowserDeviceMemory(deviceMemory);

    if (validNative) {
        const lowMemory = validNative.isLowRamDevice === true || validNative.totalMemoryMiB <= LOW_MEMORY_NATIVE_MAX_MIB;
        const reason = validNative.isLowRamDevice
            ? 'native-low-ram-flag'
            : (lowMemory ? 'native-total-memory-low' : 'native-total-memory-sufficient');
        return Object.freeze({
            lowMemory,
            source: 'native',
            reason,
            deviceMemoryGb: browserGb,
            totalMemoryMiB: validNative.totalMemoryMiB,
            isLowRamDevice: validNative.isLowRamDevice,
        });
    }

    if (browserGb !== null) {
        const lowMemory = browserGb <= LOW_MEMORY_BROWSER_MAX_GB;
        return Object.freeze({
            lowMemory,
            source: 'browser',
            reason: lowMemory ? 'browser-device-memory-low' : 'browser-device-memory-sufficient',
            deviceMemoryGb: browserGb,
            totalMemoryMiB: null,
            isLowRamDevice: null,
        });
    }

    return Object.freeze({
        lowMemory: false,
        source: 'unknown',
        reason: 'memory-unavailable',
        deviceMemoryGb: null,
        totalMemoryMiB: null,
        isLowRamDevice: null,
    });
}

export function createDefaultLowMemoryPreferences() {
    return {
        version: LOW_MEMORY_PREFERENCES_VERSION,
        explicit: {},
    };
}

export function isValidLowMemoryPreferencesMarker(marker) {
    return Boolean(
        marker
        && typeof marker === 'object'
        && !Array.isArray(marker)
        && marker.version === LOW_MEMORY_PREFERENCES_VERSION
        && marker.explicit
        && typeof marker.explicit === 'object'
        && !Array.isArray(marker.explicit),
    );
}

export function normalizeExplicitChoices(explicitInput) {
    if (!explicitInput || typeof explicitInput !== 'object' || Array.isArray(explicitInput)) {
        return {};
    }
    const rawExplicit = isValidLowMemoryPreferencesMarker(explicitInput)
        ? explicitInput.explicit
        : (explicitInput.explicit && typeof explicitInput.explicit === 'object' && !Array.isArray(explicitInput.explicit)
            ? explicitInput.explicit
            : explicitInput);
    const normalized = {};
    for (const key of LOW_MEMORY_MANAGED_KEYS) {
        if (rawExplicit[key] === true) {
            normalized[key] = true;
        }
    }
    return normalized;
}

function captureManagedBaseValues(target) {
    const snapshot = {};
    if (!target || typeof target !== 'object') {
        return snapshot;
    }
    for (const key of LOW_MEMORY_MANAGED_KEYS) {
        snapshot[key] = Object.hasOwn(target, key) ? target[key] : LOW_MEMORY_SHIPPED_DEFAULTS[key];
    }
    return snapshot;
}

export function initializeLowMemoryPreferences(target, savedSettings) {
    if (!target || typeof target !== 'object') {
        return false;
    }
    const saved = savedSettings && typeof savedSettings === 'object' && !Array.isArray(savedSettings)
        ? savedSettings
        : {};
    const hadPreviousObservation = observedBaseByTarget.has(target);

    for (const key of LOW_MEMORY_MANAGED_KEYS) {
        if (Object.hasOwn(saved, key)) {
            target[key] = saved[key];
        } else if (hadPreviousObservation || !Object.hasOwn(target, key)) {
            target[key] = LOW_MEMORY_SHIPPED_DEFAULTS[key];
        }
    }

    const rawMarker = Object.hasOwn(saved, LOW_MEMORY_PREFERENCES_KEY)
        ? saved[LOW_MEMORY_PREFERENCES_KEY]
        : undefined;

    if (isValidLowMemoryPreferencesMarker(rawMarker)) {
        const cleanExplicit = normalizeExplicitChoices(rawMarker.explicit);
        const rawKeys = Object.keys(rawMarker.explicit);
        const cleanKeys = Object.keys(cleanExplicit);
        const needsSanitization = rawKeys.length !== cleanKeys.length
            || rawKeys.some(key => !LOW_MEMORY_MANAGED_KEYS.includes(key) || rawMarker.explicit[key] !== true);
        target[LOW_MEMORY_PREFERENCES_KEY] = {
            version: LOW_MEMORY_PREFERENCES_VERSION,
            explicit: cleanExplicit,
        };
        observedBaseByTarget.set(target, captureManagedBaseValues(target));
        return needsSanitization;
    }

    const migratedExplicit = {};
    for (const key of LOW_MEMORY_MANAGED_KEYS) {
        if (Object.hasOwn(saved, key) && saved[key] !== LOW_MEMORY_SHIPPED_DEFAULTS[key]) {
            migratedExplicit[key] = true;
        }
    }
    target[LOW_MEMORY_PREFERENCES_KEY] = {
        version: LOW_MEMORY_PREFERENCES_VERSION,
        explicit: migratedExplicit,
    };
    observedBaseByTarget.set(target, captureManagedBaseValues(target));
    return true;
}

function ensureTargetPreferencesMarker(target) {
    if (!isValidLowMemoryPreferencesMarker(target[LOW_MEMORY_PREFERENCES_KEY])) {
        target[LOW_MEMORY_PREFERENCES_KEY] = {
            version: LOW_MEMORY_PREFERENCES_VERSION,
            explicit: normalizeExplicitChoices(target[LOW_MEMORY_PREFERENCES_KEY]),
        };
    } else {
        target[LOW_MEMORY_PREFERENCES_KEY].explicit = normalizeExplicitChoices(target[LOW_MEMORY_PREFERENCES_KEY].explicit);
    }
    return target[LOW_MEMORY_PREFERENCES_KEY];
}

export function syncExternalLowMemoryBaseWrites(target) {
    if (!target || typeof target !== 'object') {
        return false;
    }
    const observed = observedBaseByTarget.get(target);
    if (!observed) {
        return false;
    }
    let changed = false;
    for (const key of LOW_MEMORY_MANAGED_KEYS) {
        const currentValue = Object.hasOwn(target, key) ? target[key] : LOW_MEMORY_SHIPPED_DEFAULTS[key];
        if (currentValue !== observed[key]) {
            observed[key] = currentValue;
            const marker = ensureTargetPreferencesMarker(target);
            marker.explicit[key] = true;
            changed = true;
        }
    }
    return changed;
}

export function markLowMemoryPreferenceExplicit(target, key) {
    if (!target || typeof target !== 'object' || !LOW_MEMORY_MANAGED_KEYS.includes(key)) {
        return null;
    }
    if (isLowMemoryControlHydrating()) {
        return target[LOW_MEMORY_PREFERENCES_KEY] ?? null;
    }
    const marker = ensureTargetPreferencesMarker(target);
    marker.explicit[key] = true;
    observedBaseByTarget.set(target, captureManagedBaseValues(target));
    return marker;
}

export function setLowMemoryManagedSetting(target, key, value) {
    if (!target || typeof target !== 'object' || !LOW_MEMORY_MANAGED_KEYS.includes(key)) {
        return null;
    }
    target[key] = value;
    if (isLowMemoryControlHydrating()) {
        observedBaseByTarget.set(target, captureManagedBaseValues(target));
        return target[LOW_MEMORY_PREFERENCES_KEY] ?? null;
    }
    const marker = ensureTargetPreferencesMarker(target);
    marker.explicit[key] = true;
    observedBaseByTarget.set(target, captureManagedBaseValues(target));
    return marker;
}

export function releaseLowMemoryPreferencesToAutomatic(target) {
    if (!target || typeof target !== 'object') {
        return null;
    }
    target[LOW_MEMORY_PREFERENCES_KEY] = createDefaultLowMemoryPreferences();
    observedBaseByTarget.set(target, captureManagedBaseValues(target));
    return target[LOW_MEMORY_PREFERENCES_KEY];
}

export function withLowMemoryControlHydration(callback) {
    controlHydrationDepth += 1;
    try {
        return callback();
    } finally {
        controlHydrationDepth = Math.max(0, controlHydrationDepth - 1);
    }
}

export function isLowMemoryControlHydrating() {
    return controlHydrationDepth > 0;
}

function normalizePositiveInt(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return fallback;
    }
    return Math.floor(numeric);
}

function normalizeWindowSize(value, defaultSize = NORMAL_ROLEPLAY_WINDOW_DEFAULT, maxSize = NORMAL_ROLEPLAY_WINDOW_MAX) {
    const safeDefault = normalizePositiveInt(defaultSize, NORMAL_ROLEPLAY_WINDOW_DEFAULT);
    const safeMax = Math.max(1, normalizePositiveInt(maxSize, NORMAL_ROLEPLAY_WINDOW_MAX));
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return Math.min(safeDefault, safeMax);
    }
    return Math.min(Math.floor(numeric), safeMax);
}

export function resolveLowMemoryPreferences(savedValues = {}, explicitChoices = undefined, active = false) {
    const source = savedValues && typeof savedValues === 'object' ? savedValues : {};
    if (observedBaseByTarget.has(source)) {
        syncExternalLowMemoryBaseWrites(source);
    }

    const explicitFromSource = normalizeExplicitChoices(source[LOW_MEMORY_PREFERENCES_KEY]);
    const explicitFromArg = explicitChoices !== undefined && explicitChoices !== null
        ? normalizeExplicitChoices(explicitChoices)
        : explicitFromSource;
    const explicitMap = {
        ...explicitFromSource,
        ...explicitFromArg,
    };

    const isActive = Boolean(active);
    const baseFastUiMode = Boolean(
        Object.hasOwn(source, 'fast_ui_mode')
            ? source.fast_ui_mode
            : LOW_MEMORY_SHIPPED_DEFAULTS.fast_ui_mode,
    );
    const baseChatTruncation = normalizeWindowSize(
        Object.hasOwn(source, 'chat_truncation')
            ? source.chat_truncation
            : LOW_MEMORY_SHIPPED_DEFAULTS.chat_truncation,
        NORMAL_ROLEPLAY_WINDOW_DEFAULT,
        NORMAL_ROLEPLAY_WINDOW_MAX,
    );
    const baseAggressiveUnload = Boolean(
        Object.hasOwn(source, 'aggressive_dom_unload')
            ? source.aggressive_dom_unload
            : LOW_MEMORY_SHIPPED_DEFAULTS.aggressive_dom_unload,
    );
    const baseAggressiveWindowSize = normalizePositiveInt(
        Object.hasOwn(source, 'aggressive_dom_window_size')
            ? source.aggressive_dom_window_size
            : LOW_MEMORY_SHIPPED_DEFAULTS.aggressive_dom_window_size,
        AGGRESSIVE_ROLEPLAY_WINDOW_DEFAULT,
    );

    const fastUiExplicit = Boolean(explicitMap.fast_ui_mode);
    const historyExplicit = Boolean(
        explicitMap.chat_truncation
        || explicitMap.aggressive_dom_unload
        || explicitMap.aggressive_dom_window_size,
    );

    const fastUiApplied = isActive && !fastUiExplicit;
    const fastUiPreserved = fastUiExplicit;
    const effectiveFastUiMode = fastUiApplied ? true : baseFastUiMode;

    const roleplayWindowApplied = isActive && !historyExplicit;
    const roleplayWindowPreserved = historyExplicit;

    let roleplayWindowSize;
    let roleplayMaxWindowSize;
    let roleplayFixedWindow;

    if (baseAggressiveUnload) {
        const aggressiveCap = normalizeWindowSize(
            baseAggressiveWindowSize,
            AGGRESSIVE_ROLEPLAY_WINDOW_DEFAULT,
            baseAggressiveWindowSize,
        );
        roleplayWindowSize = roleplayWindowApplied
            ? Math.min(aggressiveCap, LOW_MEMORY_ROLEPLAY_WINDOW_SIZE)
            : aggressiveCap;
        roleplayMaxWindowSize = roleplayWindowSize;
        roleplayFixedWindow = true;
    } else if (roleplayWindowApplied) {
        roleplayWindowSize = Math.min(baseChatTruncation, LOW_MEMORY_ROLEPLAY_WINDOW_SIZE);
        roleplayMaxWindowSize = roleplayWindowSize;
        roleplayFixedWindow = true;
    } else {
        roleplayWindowSize = baseChatTruncation;
        roleplayMaxWindowSize = NORMAL_ROLEPLAY_WINDOW_MAX;
        roleplayFixedWindow = false;
    }

    const conversationWindowSize = isActive
        ? LOW_MEMORY_CONVERSATION_WINDOW_SIZE
        : NORMAL_CONVERSATION_WINDOW_SIZE;

    const appliedKeys = isActive
        ? [
            ...(fastUiApplied ? ['fast_ui_mode'] : []),
            ...(roleplayWindowApplied ? ['chat_truncation'] : []),
        ]
        : [];
    const preservedKeys = LOW_MEMORY_MANAGED_KEYS.filter(key => Boolean(explicitMap[key]));

    return Object.freeze({
        active: isActive,
        fast_ui_mode: effectiveFastUiMode,
        effectiveFastUiMode,
        baseFastUiMode,
        chat_truncation: roleplayWindowSize,
        roleplayWindowSize,
        roleplayMaxWindowSize,
        roleplayFixedWindow,
        conversationWindowSize,
        fastUiApplied,
        fastUiPreserved,
        roleplayWindowApplied,
        roleplayWindowPreserved,
        appliedKeys: Object.freeze(appliedKeys),
        preservedKeys: Object.freeze(preservedKeys),
        explicit: Object.freeze({ ...explicitMap }),
    });
}

export function didRoleplayRenderWindowPolicyChange(previousPolicy, nextPolicy) {
    if (!previousPolicy || !nextPolicy) {
        return false;
    }
    return previousPolicy.roleplayWindowSize !== nextPolicy.roleplayWindowSize
        || previousPolicy.roleplayFixedWindow !== nextPolicy.roleplayFixedWindow;
}

export function shouldRequireRoleplayChatReopen({
    previousPolicy = null,
    nextPolicy = null,
    chatWindowChanged = didRoleplayRenderWindowPolicyChange(previousPolicy, nextPolicy),
    hasMountedRoleplayMessages = false,
    isConversationMode = false,
    previouslyRequired = false,
} = {}) {
    if (!hasMountedRoleplayMessages || isConversationMode) {
        return false;
    }
    return Boolean(previouslyRequired || chatWindowChanged);
}

function safeReadModeFromStorage(storage) {
    if (!storage || typeof storage.getItem !== 'function') {
        return LOW_MEMORY_MODES.AUTO;
    }
    try {
        return normalizeLowMemoryMode(storage.getItem(LOW_MEMORY_MODE_STORAGE_KEY));
    } catch {
        return LOW_MEMORY_MODES.AUTO;
    }
}

function safeWriteModeToStorage(storage, mode) {
    if (!storage || typeof storage.setItem !== 'function') {
        return false;
    }
    try {
        storage.setItem(LOW_MEMORY_MODE_STORAGE_KEY, mode);
        return true;
    } catch {
        return false;
    }
}

export function createLowMemoryRuntime({
    navigatorRef,
    storageRef,
    windowRef,
    globalRef,
    preferencesProvider = null,
} = {}) {
    const getGlobal = () => globalRef ?? globalThis;
    const getWindow = () => windowRef ?? getGlobal()?.window ?? null;
    const getNavigator = () => navigatorRef ?? getGlobal()?.navigator ?? null;
    const getStorage = () => {
        if (storageRef !== undefined) {
            return storageRef;
        }
        try {
            return getGlobal()?.localStorage ?? null;
        } catch {
            return null;
        }
    };

    let currentMode = safeReadModeFromStorage(getStorage());
    let nativeMemory = null;
    let nativeProfileStatus = 'pending';
    let currentPreferencesProvider = typeof preferencesProvider === 'function' ? preferencesProvider : null;
    const listeners = new Set();

    function hasNativeBridgeHost() {
        const host = getGlobal();
        return Boolean(host && (host.NeconyanAndroid || host.NeconyanExport));
    }

    function computeState() {
        const classification = classifyDeviceMemory({
            deviceMemory: getNavigator()?.deviceMemory,
            nativeMemory,
        });
        const active = currentMode === LOW_MEMORY_MODES.ON
            ? true
            : currentMode === LOW_MEMORY_MODES.OFF
                ? false
                : classification.lowMemory;
        const effectiveStatus = nativeProfileStatus === 'pending' && !hasNativeBridgeHost()
            ? 'not-applicable'
            : nativeProfileStatus;

        const resolvedPrefs = typeof currentPreferencesProvider === 'function'
            ? currentPreferencesProvider(active)
            : resolveLowMemoryPreferences({}, {}, active);

        return Object.freeze({
            mode: currentMode,
            active,
            classification,
            nativeProfileStatus: effectiveStatus,
            appliedKeys: resolvedPrefs.appliedKeys,
            preservedKeys: resolvedPrefs.preservedKeys,
            fastUiApplied: resolvedPrefs.fastUiApplied,
            fastUiPreserved: resolvedPrefs.fastUiPreserved,
            roleplayWindowApplied: resolvedPrefs.roleplayWindowApplied,
            roleplayWindowPreserved: resolvedPrefs.roleplayWindowPreserved,
            roleplayWindowSize: resolvedPrefs.roleplayWindowSize,
            roleplayMaxWindowSize: resolvedPrefs.roleplayMaxWindowSize,
            roleplayFixedWindow: resolvedPrefs.roleplayFixedWindow,
            conversationWindowSize: resolvedPrefs.conversationWindowSize,
        });
    }

    let lastNotifiedSignature = stateSignature(computeState());

    function stateSignature(state) {
        return JSON.stringify({
            mode: state.mode,
            active: state.active,
            source: state.classification.source,
            reason: state.classification.reason,
            deviceMemoryGb: state.classification.deviceMemoryGb,
            totalMemoryMiB: state.classification.totalMemoryMiB,
            isLowRamDevice: state.classification.isLowRamDevice,
            nativeProfileStatus: state.nativeProfileStatus,
            appliedKeys: state.appliedKeys,
            preservedKeys: state.preservedKeys,
            roleplayWindowSize: state.roleplayWindowSize,
            conversationWindowSize: state.conversationWindowSize,
        });
    }

    function notifyIfChanged() {
        const nextState = computeState();
        const nextSignature = stateSignature(nextState);
        if (nextSignature === lastNotifiedSignature) {
            return nextState;
        }
        lastNotifiedSignature = nextSignature;
        for (const listener of [...listeners]) {
            try {
                listener(nextState);
            } catch {
                // Keep other subscribers running if a listener throws.
            }
        }
        return nextState;
    }

    function getLowMemoryState() {
        return computeState();
    }

    function getLowMemoryMode() {
        return currentMode;
    }

    function isLowMemoryModeActive() {
        return computeState().active;
    }

    function setLowMemoryMode(nextMode) {
        const normalized = normalizeLowMemoryMode(nextMode);
        currentMode = normalized;
        safeWriteModeToStorage(getStorage(), normalized);
        return notifyIfChanged();
    }

    function subscribeLowMemoryState(listener) {
        if (typeof listener !== 'function') {
            return () => {};
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    function acceptAndroidMemoryProfile(profile) {
        const validProfile = validateAndroidMemoryProfile(profile);
        if (validProfile) {
            nativeMemory = validProfile;
            nativeProfileStatus = 'received';
        } else if (!nativeMemory) {
            nativeProfileStatus = profile === undefined || profile === null ? 'unavailable' : 'invalid';
        }
        notifyIfChanged();
        return Boolean(validProfile);
    }

    function setLowMemoryPreferencesProvider(provider) {
        currentPreferencesProvider = typeof provider === 'function' ? provider : null;
        lastNotifiedSignature = stateSignature(computeState());
    }

    const win = getWindow();
    if (win && typeof win.addEventListener === 'function') {
        const previousHandler = storageListenerByWindow.get(win);
        if (previousHandler && typeof win.removeEventListener === 'function') {
            win.removeEventListener('storage', previousHandler);
        }
        const onStorage = event => {
            if (event && event.key && event.key !== LOW_MEMORY_MODE_STORAGE_KEY) {
                return;
            }
            currentMode = event && typeof event.newValue === 'string'
                ? normalizeLowMemoryMode(event.newValue)
                : safeReadModeFromStorage(getStorage());
            notifyIfChanged();
        };
        storageListenerByWindow.set(win, onStorage);
        win.addEventListener('storage', onStorage);
    }

    return Object.freeze({
        getLowMemoryState,
        getLowMemoryMode,
        isLowMemoryModeActive,
        setLowMemoryMode,
        subscribeLowMemoryState,
        acceptAndroidMemoryProfile,
        setLowMemoryPreferencesProvider,
        notifyIfChanged,
    });
}

let defaultRuntime = createLowMemoryRuntime();

export function getLowMemoryState() {
    return defaultRuntime.getLowMemoryState();
}

export function getLowMemoryMode() {
    return defaultRuntime.getLowMemoryMode();
}

export function isLowMemoryModeActive() {
    return defaultRuntime.isLowMemoryModeActive();
}

export function setLowMemoryMode(mode) {
    return defaultRuntime.setLowMemoryMode(mode);
}

export function subscribeLowMemoryState(listener) {
    return defaultRuntime.subscribeLowMemoryState(listener);
}

export function acceptAndroidMemoryProfile(profile) {
    return defaultRuntime.acceptAndroidMemoryProfile(profile);
}

export function setLowMemoryPreferencesProvider(provider) {
    return defaultRuntime.setLowMemoryPreferencesProvider(provider);
}

export function notifyLowMemoryPreferencesChanged() {
    return defaultRuntime.notifyIfChanged();
}

export function resetLowMemoryRuntimeForTests(options = {}) {
    defaultRuntime = createLowMemoryRuntime(options);
    return defaultRuntime;
}
