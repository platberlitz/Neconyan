import { getContext, loadHost } from './src/host.js';
import { SETTINGS_KEY } from './src/constants.js';
import { getSettings } from './src/settings.js';
import { clearExtensionData } from './src/ui/data.js';
import { mountRuntimeUi, unmountRuntimeUi } from './src/ui/runtime.js';

let initialized = false;
let activationEpoch = 0;
let activationController = null;
let runtimeUi = null;
const subscriptions = [];

function scanSettingsSnapshot(context = getContext()) {
    const extensionSettings = context?.extensionSettings && typeof context.extensionSettings === 'object'
        ? { ...context.extensionSettings }
        : {};
    delete extensionSettings[SETTINGS_KEY];
    return JSON.stringify({
        extensionPrompts: context?.extensionPrompts ?? null,
        extensionSettings,
        maxContext: context?.maxContext ?? null,
        mainApi: context?.mainApi ?? null,
        powerUserSettings: context?.powerUserSettings ?? null,
        worldInfoSettings: context?.worldInfoSettings ?? null,
        chatCompletionSettings: context?.chatCompletionSettings ?? null,
        textCompletionSettings: context?.textCompletionSettings ?? null,
        tagMap: context?.tagMap ?? null,
        tags: context?.tags ?? null,
        name1: context?.name1 ?? null,
        name2: context?.name2 ?? null,
        characterId: context?.characterId ?? null,
    });
}

function subscribe(source, eventType, handler) {
    if (!source?.on || !eventType) {
        return;
    }
    source.on(eventType, handler);
    subscriptions.push({ source, eventType, handler });
}

async function mountOnReady(epoch, signal) {
    if (signal.aborted || epoch !== activationEpoch) {
        return;
    }
    runtimeUi = mountRuntimeUi({ signal });
    runtimeUi.refresh('app-ready');

    const host = await loadHost();
    if (signal.aborted || epoch !== activationEpoch) {
        return;
    }
    runtimeUi?.setAvailability(host);
}

export function init() {
    if (initialized) {
        runtimeUi?.refresh('init');
        return;
    }

    initialized = true;
    const epoch = ++activationEpoch;
    activationController = new AbortController();
    const { signal } = activationController;
    getSettings();

    const context = getContext();
    const source = context?.eventSource;
    const events = context?.eventTypes;
    if (!source || !events) {
        initialized = false;
        activationController.abort();
        activationController = null;
        return;
    }

    subscribe(source, events.APP_READY, () => {
        void mountOnReady(epoch, signal).catch((error) => {
            if (!signal.aborted && epoch === activationEpoch) {
                console.error('World Info Lab could not mount.', error);
            }
        });
    });

    const refresh = reason => () => {
        if (!signal.aborted && epoch === activationEpoch) {
            runtimeUi?.refresh(reason);
        }
    };
    subscribe(source, events.WORLDINFO_UPDATED, refresh('worldinfo-updated'));
    subscribe(source, events.WORLDINFO_SETTINGS_UPDATED, refresh('worldinfo-settings-updated'));
    subscribe(source, events.CHAT_CHANGED, refresh('chat-changed'));
    let settingsSnapshot = scanSettingsSnapshot(context);
    subscribe(source, events.SETTINGS_UPDATED, () => {
        const nextSettingsSnapshot = scanSettingsSnapshot();
        if (nextSettingsSnapshot !== settingsSnapshot) {
            settingsSnapshot = nextSettingsSnapshot;
            runtimeUi?.refresh('settings-updated');
        }
    });
    const scanInputEvents = [
        'MESSAGE_SWIPED',
        'MESSAGE_SENT',
        'MESSAGE_RECEIVED',
        'MESSAGE_EDITED',
        'MESSAGE_DELETED',
        'MESSAGE_UPDATED',
        'MESSAGE_FILE_EMBEDDED',
        'MESSAGE_REASONING_EDITED',
        'MESSAGE_REASONING_DELETED',
        'MESSAGE_SWIPE_DELETED',
        'MORE_MESSAGES_LOADED',
        'FILE_ATTACHMENT_DELETED',
        'MEDIA_ATTACHMENT_DELETED',
        'CHARACTER_EDITED',
        'CHARACTER_FIRST_MESSAGE_SELECTED',
        'GROUP_UPDATED',
        'PERSONA_CHANGED',
        'PERSONA_CREATED',
        'PERSONA_UPDATED',
        'PERSONA_RENAMED',
        'PERSONA_DELETED',
    ];
    const eventValues = new Set(scanInputEvents.map(name => events[name]).filter(Boolean));
    for (const eventType of eventValues) {
        subscribe(source, eventType, refresh('scan-input-changed'));
    }
}

export function deactivate() {
    initialized = false;
    activationEpoch++;
    activationController?.abort();
    activationController = null;

    while (subscriptions.length) {
        const { source, eventType, handler } = subscriptions.pop();
        source?.removeListener?.(eventType, handler);
    }

    runtimeUi = null;
    unmountRuntimeUi();
}

export async function clean() {
    deactivate();
    await clearExtensionData();
}
