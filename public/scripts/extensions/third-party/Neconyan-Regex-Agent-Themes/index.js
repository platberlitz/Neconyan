/**
 * Entry point. Wiring only. Every decision lives in src/.
 *
 * `deactivate` deliberately does not revert. Applied themes live in the user's agent JSON,
 * not in this extension, so silently un-theming on disable would be a destructive surprise.
 * Use "Revert all" in the drawer, or /rat-revert.
 */

import { mountSettings, removeSettings } from './src/ui.js';
import { registerCommands, unregisterCommands } from './src/commands.js';
import { getSettings, pruneLedger } from './src/settings.js';
import { reconcile } from './src/apply.js';
import { getContext, waitForAgents } from './src/host.js';

let booted = false;
let refresh = () => {};
let activation = 0;
let bootController = null;
const subscriptions = [];

function subscribe(eventType, handler) {
    if (!eventType) {
        return;
    }
    const context = getContext();
    if (!context?.eventSource) {
        return;
    }
    context.eventSource.on(eventType, handler);
    subscriptions.push({ eventType, handler });
}

/**
 * The boot pass runs once. In-Chat Agents loads its agents from settings asynchronously, so
 * this waits for the store rather than assuming it is populated.
 */
async function reconcileOnce(epoch, signal) {
    const host = await waitForAgents({ signal });
    if (!host.ok || !host.ready || signal.aborted || epoch !== activation) {
        return;
    }

    pruneLedger((host.store.getAgents() ?? []).map(agent => agent.id));

    if (signal.aborted || epoch !== activation) {
        return;
    }
    const result = await reconcile({ signal });
    if (!result.ok || result.cancelled || signal.aborted || epoch !== activation) {
        return;
    }

    if (result.repaired > 0) {
        globalThis.toastr?.info?.(
            `Regex Agent Themes: put your theme back on ${result.repaired} tracker(s) after a template update.`,
        );
    }
    if (result.reverted > 0) {
        globalThis.toastr?.info?.(
            `Regex Agent Themes: restored ${result.reverted} tracker(s) to their original style.`,
        );
    }
    if (result.needsAttention.length > 0) {
        const names = result.needsAttention.map(item => item.agentName).join(', ');
        globalThis.toastr?.warning?.(
            `Regex Agent Themes: skipped ${result.needsAttention.length} tracker(s) that were edited outside the extension (${names}).`,
        );
    }
    if (result.failed.length > 0) {
        const names = result.failed.map(item => item.agentName).join(', ');
        globalThis.toastr?.error?.(
            `Regex Agent Themes: could not update ${result.failed.length} tracker(s) (${names}).`,
        );
    }
    refresh();
}

export function init() {
    if (booted) {
        return;
    }
    booted = true;
    const epoch = ++activation;
    bootController = new AbortController();
    const { signal } = bootController;

    getSettings();
    refresh = mountSettings() ?? (() => {});
    registerCommands(() => refresh());

    const context = getContext();
    const events = context?.eventTypes;
    if (!events) {
        return;
    }

    // APP_READY is sticky in Neconyan's emitter, so subscribing after it has already
    // fired still runs the handler.
    subscribe(events.APP_READY, () => {
        void reconcileOnce(epoch, signal).catch((error) => {
            if (!signal.aborted && epoch === activation) {
                console.error('Regex Agent Themes boot reconciliation failed', error);
            }
        });
    });
    subscribe(events.SETTINGS_UPDATED, () => refresh());
    subscribe(events.CHAT_CHANGED, () => refresh());
}

export function deactivate() {
    booted = false;
    activation++;
    bootController?.abort();
    bootController = null;
    unregisterCommands();
    removeSettings();

    const context = getContext();
    while (subscriptions.length) {
        const { eventType, handler } = subscriptions.pop();
        context?.eventSource?.removeListener?.(eventType, handler);
    }

    refresh = () => {};
}
