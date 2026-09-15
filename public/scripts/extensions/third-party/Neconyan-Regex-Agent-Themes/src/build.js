/**
 * Turns a stock script list into a themed one. This is the single place that decides what
 * gets rewritten, what is left alone, and what extra scripts get appended. Shared by the
 * apply engine and the tests so they can never disagree.
 */

import { ARCHETYPES, getSpec } from './specs.js';
import { getStock } from './stock.js';
import {
    DEFAULT_OPTIONS, buildCleanupFindRegex, buildExtraCleanupScript,
    buildMeterScript, buildReplaceString, ownedScriptId,
} from './render/index.js';
import { OWNED_SCRIPT_PREFIX } from './constants.js';

/** True for scripts this extension appended rather than themed in place. */
export function isOwnedScript(script) {
    return String(script?.id ?? '').startsWith(OWNED_SCRIPT_PREFIX);
}

/**
 * @typedef {object} BuildResult
 * @property {object[]} scripts The themed script list, in apply order.
 * @property {string[]} themed Ids whose replaceString was rewritten.
 * @property {string[]} added Ids of scripts this extension appended.
 * @property {string[]} skipped Ids left untouched, with the reason appended.
 */

/**
 * @param {string} templateId
 * @param {object[]} stockScripts The agent's current `regexScripts`.
 * @param {object} theme
 * @param {object} [options]
 * @param {string} [agentId] Namespaces the ids of appended scripts.
 * @returns {BuildResult}
 */
export function buildAgentScripts(templateId, stockScripts, theme, options = {}, agentId = 'agent') {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const themed = [];
    const added = [];
    const skipped = [];
    const scripts = [];
    const cleanupSpecs = [];
    let wantsMeter = false;

    for (const script of stockScripts) {
        // Scripts we appended on a previous apply are rebuilt from scratch below.
        if (isOwnedScript(script)) {
            continue;
        }

        const spec = getSpec(templateId, script.id);
        if (!spec) {
            scripts.push({ ...script });
            skipped.push(`${script.id}: no spec`);
            continue;
        }

        // A pattern that faces model output must match the shipped one byte for byte, or
        // the capture groups this spec maps may have been renumbered upstream.
        const stock = getStock(templateId, script.id);
        if (stock && !spec.regenerateFindRegex && script.findRegex !== stock.findRegex) {
            scripts.push({ ...script });
            skipped.push(`${script.id}: findRegex differs from baseline`);
            continue;
        }

        if (spec.archetype === ARCHETYPES.PASSTHROUGH) {
            scripts.push({ ...script });
            continue;
        }

        if (spec.archetype === ARCHETYPES.CLEANUP) {
            const target = getSpec(templateId, spec.cleanupFor);
            const findRegex = target ? buildCleanupFindRegex(target, theme, merged) : null;
            scripts.push(findRegex ? { ...script, findRegex, replaceString: '' } : { ...script });
            if (findRegex) {
                themed.push(script.id);
            }
            continue;
        }

        const replaceString = buildReplaceString(spec, theme, merged);
        scripts.push({ ...script, replaceString });
        themed.push(script.id);

        if (spec.archetype === ARCHETYPES.SLOTS && spec.key !== 'choices') {
            // The CYOA agent ships its own cleanup script; the direction menu and parallel
            // tracker do not, so they need one appended.
            cleanupSpecs.push(spec);
        }
        if (spec.archetype === ARCHETYPES.PROFILE && spec.optionalSections?.length) {
            cleanupSpecs.push(spec);
        }
        if (spec.archetype === ARCHETYPES.STATCARD && merged.meters) {
            wantsMeter = true;
        }
    }

    for (const spec of cleanupSpecs) {
        const cleanup = buildExtraCleanupScript(agentId, spec, theme, merged);
        if (cleanup) {
            scripts.push(cleanup);
            added.push(cleanup.id);
        }
    }

    if (wantsMeter) {
        const meter = buildMeterScript(agentId, theme, merged);
        scripts.push(meter);
        added.push(meter.id);
    }

    return { scripts, themed, added, skipped };
}

function matchesTarget(script, target) {
    return script.findRegex === target.findRegex && script.replaceString === target.replaceString;
}

function matchesRecordedState(templateId, script, recorded) {
    const applied = recorded?.applied === script.replaceString
        || recorded?.generated?.includes(script.replaceString);
    if (!applied) {
        return false;
    }
    if (typeof recorded.findRegex === 'string') {
        return recorded.findRegex === script.findRegex;
    }

    const spec = getSpec(templateId, script.id);
    const stock = getStock(templateId, script.id);
    return !spec?.regenerateFindRegex && (!stock || stock.findRegex === script.findRegex);
}

function restoreTarget(templateId, scriptId, ledgerEntry) {
    const original = ledgerEntry?.originals?.[scriptId];
    if (original) {
        return original;
    }
    const stock = getStock(templateId, scriptId);
    return stock ? { findRegex: stock.findRegex, replaceString: stock.replaceString } : null;
}

/**
 * Plans a restore without mutating the current list. Automatic restores only touch script
 * ids recorded in the ledger and only while their bytes still match our last write.
 */
export function planRevertAgentScripts(templateId, currentScripts, ledgerEntry, { force = false } = {}) {
    const scripts = [];
    const blocked = [];
    const restored = [];
    const removed = [];
    const ledgerScripts = ledgerEntry?.scripts ?? {};
    const added = new Set(ledgerEntry?.added ?? []);
    const seen = new Set();

    for (const script of currentScripts) {
        seen.add(script.id);

        if (isOwnedScript(script)) {
            if (!ledgerEntry) {
                if (force) {
                    removed.push(script.id);
                } else {
                    scripts.push({ ...script });
                }
                continue;
            }
            if (!added.has(script.id)) {
                scripts.push({ ...script });
                continue;
            }
            const recorded = ledgerScripts[script.id];
            if (force || !recorded || matchesRecordedState(templateId, script, recorded)) {
                removed.push(script.id);
            } else {
                scripts.push({ ...script });
                blocked.push({ scriptId: script.id, scriptName: script.scriptName, reason: 'changed after apply' });
            }
            continue;
        }

        const recorded = ledgerScripts[script.id];
        if (!ledgerEntry && force) {
            const stock = getStock(templateId, script.id);
            if (stock) {
                const target = { findRegex: stock.findRegex, replaceString: stock.replaceString };
                scripts.push({ ...script, ...target });
                if (!matchesTarget(script, target)) {
                    restored.push(script.id);
                }
            } else {
                scripts.push({ ...script });
            }
            continue;
        }
        if (!recorded) {
            scripts.push({ ...script });
            continue;
        }

        const target = restoreTarget(templateId, script.id, ledgerEntry);
        if (!target || matchesTarget(script, target)) {
            scripts.push({ ...script, ...(target ?? {}) });
            continue;
        }
        if (force || matchesRecordedState(templateId, script, recorded)) {
            scripts.push({ ...script, ...target });
            restored.push(script.id);
        } else {
            scripts.push({ ...script });
            blocked.push({ scriptId: script.id, scriptName: script.scriptName, reason: 'changed after apply' });
        }
    }

    if (ledgerEntry) {
        for (const scriptId of Object.keys(ledgerScripts)) {
            if (!seen.has(scriptId) && !added.has(scriptId)) {
                blocked.push({ scriptId, scriptName: scriptId, reason: 'missing after apply' });
            }
        }
    }

    return {
        scripts,
        blocked,
        restored,
        removed,
        changed: restored.length + removed.length,
        owned: Boolean(ledgerEntry),
    };
}

export { ownedScriptId };
