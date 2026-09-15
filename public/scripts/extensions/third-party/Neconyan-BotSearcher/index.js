/**
 * Neconyan-BotSearcher frontend extension entry point.
 *
 * Loaded as a module by src/../public/scripts/extensions.js from
 * /scripts/extensions/third-party/Neconyan-BotSearcher/index.js.
 *
 * We use SillyTavern.getContext() rather than relative imports into
 * public/script.js: the context object is the fork's supported surface, while
 * deep imports are the coupling that breaks other browser extensions whenever
 * upstream moves a file.
 */

import { LOG_TAG } from './client/constants.js';
import { installEntryPoints } from './client/inject.js';
import { openBrowser } from './client/browser.js';
import { mountSettings } from './client/settings.js';

let booted = false;

/**
 * Idempotent: the manifest declares this as the `activate` hook, and activation
 * can fire more than once (e.g. toggling the extension off and on).
 */
export function init() {
    if (booted) {
        return;
    }
    booted = true;

    installEntryPoints(() => {
        openBrowser().catch((error) => console.error(`[${LOG_TAG}] open failed:`, error));
    });

    mountSettings().catch((error) => console.error(`[${LOG_TAG}] settings mount failed:`, error));

    const ctx = globalThis.SillyTavern.getContext();
    ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'botsearch',
        helpString: 'Find and import character cards, with an optional search term.',
        unnamedArgumentList: [
            ctx.SlashCommandArgument.fromProps({
                description: 'character name or keyword',
                typeList: [ctx.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        callback: (_named, unnamed) => {
            const query = typeof unnamed === 'string' ? unnamed : '';
            openBrowser({ query }).catch((error) => console.error(`[${LOG_TAG}]`, error));
            return '';
        },
    }));

    console.debug(`[${LOG_TAG}] ready`);
}

// APP_READY is declared sticky by the EventEmitter (public/scripts/events.js:123),
// so subscribing after it has already fired still runs the handler. That makes
// this safe regardless of where we land in the extension load order.
const ctx = globalThis.SillyTavern.getContext();
ctx.eventSource.on(ctx.eventTypes.APP_READY, init);
