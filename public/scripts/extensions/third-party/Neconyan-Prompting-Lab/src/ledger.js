import { readChatCompletionSections, readTextCompletionSections } from './capture.js';
import { getContext, loadHost } from './host.js';
import { createLedgerEntry } from './schema.js';
import { getSettings } from './settings.js';
import * as storage from './storage.js';

/**
 * Per-device, like Neconyan-Debugger's capture toggle: extensionSettings
 * syncs across devices, and turning recording on here must not silently turn
 * it on everywhere.
 */
const ENABLED_KEY = 'SBPromptingLab_ledgerEnabled';

export function isLedgerRecordingEnabled(context = getContext()) {
    return context?.accountStorage?.getItem?.(ENABLED_KEY) === 'true';
}

export function setLedgerRecordingEnabled(value, context = getContext()) {
    context?.accountStorage?.setItem?.(ENABLED_KEY, value ? 'true' : 'false');
}

/**
 * Records where the tokens of real generations went.
 *
 * This is the one part of Prompting Lab that observes generations it did not
 * start, so it is off by default and attaches its listeners only while the
 * user has recording switched on. It stores section names and token counts,
 * never the prompt text. Dry runs — including this extension's own captures —
 * are skipped: the ledger is about what was actually sent.
 */
export function createLedger({ onRecorded = null } = {}) {
    const attached = [];
    let enabled = false;
    let pending = null;
    let recording = Promise.resolve();

    const onGenerationStarted = (type, options, dryRun) => {
        pending = {
            kind: typeof type === 'string' && type ? type : 'normal',
            dryRun: dryRun === true,
            beforeCombine: null,
            wiEntries: new Set(),
        };
    };

    const onBeforeCombine = (data) => {
        // The CFG negative-prompt pass re-emits this event; the first pass is
        // the prompt being sent.
        if (!pending || pending.beforeCombine) {
            return;
        }
        const copy = {};
        for (const [key, value] of Object.entries(data ?? {})) {
            if (typeof value === 'string') {
                copy[key] = value;
            }
        }
        pending.beforeCombine = copy;
    };

    const onWorldInfoScanDone = (payload) => {
        if (!pending) {
            return;
        }
        const activated = payload?.activated?.entries;
        const entries = activated instanceof Set ? [...activated] : (Array.isArray(activated) ? activated : []);
        for (const entry of entries) {
            if (entry && typeof entry === 'object') {
                pending.wiEntries.add(`${entry.world}:${entry.uid}`);
            }
        }
    };

    const onAfterData = (generateData, dryRun) => {
        const state = pending ?? { kind: 'normal', dryRun: null, beforeCombine: null, wiEntries: new Set() };
        pending = null;
        if (dryRun === true || state.dryRun === true) {
            return;
        }
        // A recording failure must never disturb the send it observed.
        recording = recording.then(() => record(state, generateData)).catch(() => {});
    };

    async function record(state, generateData) {
        const context = getContext();
        let apiType;
        let sections;
        let tokenTable;
        let estimated = false;
        if (Array.isArray(generateData?.prompt)) {
            apiType = 'cc';
            const host = await loadHost();
            ({ sections, tokenTable } = readChatCompletionSections(host, context?.promptManager));
        } else if (typeof generateData?.prompt === 'string' || state.beforeCombine) {
            apiType = 'tc';
            ({ sections, tokenTable, estimated } = await readTextCompletionSections(
                state.beforeCombine,
                typeof generateData?.prompt === 'string' ? generateData.prompt : null,
            ));
        } else {
            return;
        }
        const characterName = context?.groupId
            ? String(context?.groups?.find?.(group => group?.id === context.groupId)?.name ?? 'Group chat')
            : String(context?.characters?.[context?.characterId]?.name ?? context?.name2 ?? '');
        const entry = createLedgerEntry({
            kind: state.kind,
            apiType,
            api: String(context?.mainApi ?? ''),
            characterName,
            total: tokenTable?.total ?? 0,
            estimated: Boolean(estimated),
            sections: (sections ?? []).map(({ id, label, tokens }) => ({ id, label, tokens })),
            wiEntryCount: state.wiEntries.size,
        });
        await storage.saveLedgerEntry(entry);
        await storage.pruneLedger(getSettings().ledgerRetention);
        onRecorded?.(entry);
    }

    function attach() {
        if (attached.length) {
            return;
        }
        const context = getContext();
        const source = context?.eventSource;
        const events = context?.eventTypes;
        if (!source || !events) {
            return;
        }
        const listen = (eventType, handler, { last = false } = {}) => {
            if (!eventType) {
                return;
            }
            const add = last && typeof source.makeLast === 'function'
                ? source.makeLast.bind(source)
                : source.on.bind(source);
            add(eventType, handler);
            attached.push({ source, eventType, handler });
        };
        listen(events.GENERATION_STARTED, onGenerationStarted);
        listen(events.GENERATION_AFTER_COMMANDS, onGenerationStarted);
        listen(events.GENERATE_BEFORE_COMBINE_PROMPTS, onBeforeCombine);
        listen(events.WORLDINFO_SCAN_DONE, onWorldInfoScanDone);
        // makeLast so anything that rewrites the prompt has already run and the
        // ledger records what Neconyan really sent.
        listen(events.GENERATE_AFTER_DATA, onAfterData, { last: true });
    }

    function detach() {
        while (attached.length) {
            const { source, eventType, handler } = attached.pop();
            source?.removeListener?.(eventType, handler);
        }
        pending = null;
    }

    return {
        setEnabled(value) {
            enabled = Boolean(value);
            if (enabled) {
                attach();
            } else {
                detach();
            }
        },
        sync() {
            this.setEnabled(isLedgerRecordingEnabled());
        },
        isEnabled() {
            return enabled;
        },
        /** Resolves after every recording already queued has been written. */
        whenIdle() {
            return recording;
        },
        dispose() {
            detach();
            enabled = false;
        },
    };
}
