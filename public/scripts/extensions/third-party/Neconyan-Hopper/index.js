// Boot and teardown only. Host I/O lives in src/api.js, DOM in src/ui.js, logic in src/core.js.

import { applyCarryover, clearCarryover, ensureActiveSession, flushFeed, getSettings, initializeStorage, loadFeed } from './src/api.js';
import { closeFeed, isFeedBusy, mountAll, openFeed, unmountAll } from './src/ui.js';

let active = false;
let lifecycleEpoch = 0;
let startupTask;
let carryoverEpoch = 0;
const subscriptions = [];
let modeLifecycle = null;

function registerModeLifecycle() {
    const lifecycles = globalThis.NeconyanModeLifecycle || {};
    modeLifecycle = {
        open: () => openFeed(),
        close: () => closeFeed(),
        isBusy: () => isFeedBusy(),
    };
    lifecycles.meower = modeLifecycle;
    globalThis.NeconyanModeLifecycle = lifecycles;
}

function unregisterModeLifecycle() {
    if (globalThis.NeconyanModeLifecycle?.meower === modeLifecycle) {
        delete globalThis.NeconyanModeLifecycle.meower;
    }
    modeLifecycle = null;
}

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function contextIdentity(sessionId) {
    const context = ctx();
    return [sessionId, getSettings().activeSessionId, context.userAvatar, context.chatId, context.characterId, context.groupId]
        .map(value => String(value ?? ''))
        .join('\u0000');
}

function subscribe(eventType, handler) {
    if (!eventType) {
        return;
    }
    ctx().eventSource.on(eventType, handler);
    subscriptions.push({ eventType, handler });
}

function unsubscribeAll() {
    const context = ctx();
    for (const { eventType, handler } of subscriptions.splice(0)) {
        context.eventSource.removeListener?.(eventType, handler);
    }
}

/**
 * Rebuilds the carryover block before a generation. It is opt-in and clears itself when it
 * has nothing to say, so a disabled or empty feed never leaves a stale block in the prompt.
 */
async function syncCarryover() {
    if (!active) {
        return;
    }
    const epoch = ++carryoverEpoch;
    if (!getSettings().carry.enabled) {
        clearCarryover();
        return;
    }
    let sessionId = '';
    let identity = contextIdentity(sessionId);
    const isCurrent = () => active
        && epoch === carryoverEpoch
        && identity === contextIdentity(sessionId)
        && getSettings().carry.enabled;
    try {
        await initializeStorage();
        if (!isCurrent()) return;
        const session = ensureActiveSession();
        sessionId = session.id;
        identity = contextIdentity(sessionId);
        await flushFeed(sessionId);
        if (!isCurrent()) {
            return;
        }
        const feed = await loadFeed(sessionId);
        await applyCarryover(feed, sessionId, { isCurrent });
    } catch (error) {
        if (isCurrent()) {
            clearCarryover();
            console.error('[Meower] could not build the carryover block', error);
        }
    }
}

async function closeAndSyncCarryover(closeOptions) {
    if (!active) {
        return;
    }
    const epoch = ++carryoverEpoch;
    clearCarryover();
    try {
        await closeFeed(closeOptions);
    } catch (error) {
        console.error('[Meower] could not save the timeline before changing context', error);
        return;
    }
    if (active && epoch === carryoverEpoch) {
        await syncCarryover();
    }
}

function start() {
    if (active) {
        return;
    }
    // Host compatibility is guaranteed by the manifest's minimum version, not by
    // probing individual APIs; optional features check at their point of use.
    const context = ctx();
    active = true;
    const epoch = ++lifecycleEpoch;
    registerModeLifecycle();

    try {
        subscribe(context.eventTypes.APP_READY, () => mountAll());
        subscribe(context.eventTypes.CHAT_CHANGED, () => closeAndSyncCarryover());
        subscribe(context.eventTypes.PERSONA_CHANGED, () => closeAndSyncCarryover({ allowExpectedPersonaSwitch: true }));
        subscribe(context.eventTypes.PERSONA_UPDATED, () => syncCarryover());
        subscribe(context.eventTypes.GENERATION_AFTER_COMMANDS, async () => {
            // Startup also builds a prompt; it must finish before the host can generate.
            if (getSettings().carry.enabled) await startupTask;
            if (active && epoch === lifecycleEpoch) await syncCarryover();
        });

        // APP_READY is sticky in the host, but enabling after load still needs a direct mount.
        if (document.getElementById('send_form')) {
            mountAll();
        }
        // Load shared settings once; disabled carryover adds no storage work to chat generation.
        startupTask = initializeStorage().then(() => active && epoch === lifecycleEpoch && syncCarryover()).catch(error => {
            console.warn('[Meower] storage is unavailable; open Meower for recovery options', error);
        });
    } catch (error) {
        active = false;
        unregisterModeLifecycle();
        unsubscribeAll();
        throw error;
    }
}

function stop() {
    if (!active) {
        return;
    }
    active = false;
    unregisterModeLifecycle();
    carryoverEpoch += 1;
    try {
        unsubscribeAll();
        clearCarryover();
    } catch (error) {
        console.error('[Meower] teardown had a problem', error);
    }
    const finalSave = closeFeed();
    void finalSave.catch(error => console.error('[Meower] final save failed; browser recovery retained', error));
    unmountAll();
    // The host can time out teardown; recovery is recorded before any server save.
    return finalSave;
}

export function activate() {
    start();
}

export function enable() {
    start();
}

export function disable() {
    return stop();
}

start();
