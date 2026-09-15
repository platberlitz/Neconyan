/**
 * Applying, reverting and reconciling themes against the live agent store.
 *
 * The write path mirrors what In-Chat Agents does itself: clone the agent, `saveAgent`
 * (which refreshes the live regex cache and POSTs), then repaint matching message blocks. Because
 * messages store only `{agentId, scriptId}` refs and resolve them against that live cache,
 * changing a `replaceString` re-skins existing chat history without touching any message.
 */

import { ENGINE_VERSION, STOCK_THEME } from './constants.js';
import { buildAgentScripts, isOwnedScript, planRevertAgentScripts } from './build.js';
import { STATUS, classifyScript, isAutoApplicable, summarizeStatuses } from './drift.js';
import { buildCleanupFindRegex, buildReplaceString, DEFAULT_OPTIONS } from './render/index.js';
import { SPECS, THEMABLE_TEMPLATE_IDS, getSpec } from './specs.js';
import { getStock } from './stock.js';
import { getTheme } from './themes/index.js';
import { getSettings, resolveThemeSlug, updateSettings } from './settings.js';
import { loadHost, repaintMessagesForAgents } from './host.js';

let writeTail = Promise.resolve();

function enqueueWrite(operation) {
    const result = writeTail.then(operation, operation);
    writeTail = result.catch(() => {});
    return result;
}

function replaceObject(target, source) {
    for (const key of Object.keys(target)) {
        delete target[key];
    }
    Object.assign(target, structuredClone(source));
}

function restoreLocalAgent(host, snapshot) {
    const agents = host.store.getAgents?.();
    if (Array.isArray(agents) && typeof host.store.loadAgents === 'function') {
        host.store.loadAgents(agents.map(item => item.id === snapshot.id ? snapshot : item));
        return true;
    }
    const stored = host.store.getAgentById?.(snapshot.id);
    if (stored) {
        replaceObject(stored, snapshot);
    }
    return false;
}

async function saveAgentChange(host, agent, nextAgent) {
    const snapshot = structuredClone(agent);
    try {
        await host.store.saveAgent(nextAgent);
    } catch (error) {
        const rolledBack = restoreLocalAgent(host, snapshot);
        return {
            ok: false,
            reason: error?.message ?? String(error),
            rolledBack,
        };
    }

    const saved = host.store.getAgentById?.(agent.id) ?? nextAgent;
    replaceObject(agent, saved);
    return { ok: true };
}

/** Agents created from a template this extension understands, including incomplete ones. */
export function themableAgents(agents) {
    return agents.filter(agent => THEMABLE_TEMPLATE_IDS.includes(agent.sourceTemplateId ?? ''));
}

/** Re-renders current-chat messages for the supplied live agents without writing agent data. */
export async function refreshAgentMessages(agents) {
    const changes = (agents ?? []).map(agent => ({
        agentId: agent?.id,
        scriptIds: (agent?.regexScripts ?? []).map(script => script?.id).filter(Boolean),
    }));
    return repaintMessagesForAgents(changes);
}

function agentVersion(agent) {
    return Number(agent?.version) || 0;
}

/**
 * Inspects one agent without writing anything.
 * @returns {{agentId: string, templateId: string, themeSlug: string, status: string,
 *            perScript: Array<{scriptId: string, status: string}>}}
 */
export function inspectAgent(agent, settings = getSettings()) {
    const templateId = agent.sourceTemplateId ?? '';
    const themeSlug = resolveThemeSlug(templateId, settings);
    const theme = getTheme(themeSlug, settings.customThemes);
    const ledger = settings.ledger[agent.id];
    const perScript = [];
    const options = { ...DEFAULT_OPTIONS, ...settings.options };
    const currentScripts = agent.regexScripts ?? [];
    const byId = new Map(currentScripts.map(script => [script.id, script]));

    for (const spec of SPECS.filter(item => item.templateId === templateId && !item.passthrough)) {
        const script = byId.get(spec.scriptId) ?? null;
        const target = spec.regenerateFindRegex ? getSpec(templateId, spec.cleanupFor) : null;

        perScript.push({
            scriptId: spec.scriptId,
            scriptName: script?.scriptName ?? spec.scriptName,
            owned: false,
            status: classifyScript({
                script,
                spec,
                expected: theme && !spec.regenerateFindRegex
                    ? buildReplaceString(spec, theme, options)
                    : null,
                expectedFindRegex: theme && target
                    ? buildCleanupFindRegex(target, theme, options)
                    : null,
                ledgerEntry: ledger?.scripts?.[spec.scriptId],
            }),
        });
    }

    const desired = theme
        ? buildAgentScripts(templateId, currentScripts, theme, options, agent.id)
        : { scripts: [] };
    const desiredOwned = new Map(
        desired.scripts.filter(isOwnedScript).map(script => [script.id, script]),
    );
    const ownedIds = new Set([
        ...currentScripts.filter(isOwnedScript).map(script => script.id),
        ...(ledger?.added ?? []),
        ...desiredOwned.keys(),
    ]);

    for (const scriptId of ownedIds) {
        const script = byId.get(scriptId) ?? null;
        const expected = desiredOwned.get(scriptId) ?? null;
        const recorded = ledger?.scripts?.[scriptId];
        let status;
        if (!script) {
            status = STATUS.MISSING;
        } else if (expected
            && script.findRegex === expected.findRegex
            && script.replaceString === expected.replaceString) {
            status = STATUS.PRISTINE;
        } else {
            const matchesRecorded = recorded
                && (recorded.applied === script.replaceString
                    || recorded.generated?.includes(script.replaceString))
                && (typeof recorded.findRegex !== 'string' || recorded.findRegex === script.findRegex);
            status = matchesRecorded || (!recorded && isOwnedScript(script))
                ? STATUS.OUTDATED
                : STATUS.FOREIGN;
        }
        perScript.push({
            scriptId,
            scriptName: script?.scriptName ?? expected?.scriptName ?? scriptId,
            owned: true,
            status,
        });
    }

    return {
        agentId: agent.id,
        agentName: agent.name,
        templateId,
        themeSlug,
        status: summarizeStatuses(perScript.map(entry => entry.status)),
        perScript,
    };
}

/**
 * Writes one agent's themed scripts.
 * @param {object} agent The live agent object from the store.
 * @param {object} options `{ force }` overwrites confirmed hand edits.
 */
async function applyToAgentUnlocked(agent, {
    force = false,
    settings,
    host: readyHost,
    repaint = true,
    signal,
} = {}) {
    if (signal?.aborted) {
        return { ok: false, cancelled: true, reason: 'cancelled' };
    }
    const host = readyHost ?? await loadHost();
    if (!host.ok) {
        return { ok: false, reason: host.reason };
    }

    const templateId = agent.sourceTemplateId ?? '';
    const themeSlug = resolveThemeSlug(templateId, settings);

    if (themeSlug === STOCK_THEME) {
        return revertAgentUnlocked(agent, { force, settings, host, repaint, signal });
    }

    const theme = getTheme(themeSlug, settings.customThemes);
    if (!theme) {
        return { ok: false, reason: `Unknown theme "${themeSlug}"` };
    }

    const report = inspectAgent(agent, settings);
    const unavailable = report.perScript.filter(entry => entry.status === STATUS.UPSTREAM_CHANGED
        || (entry.status === STATUS.MISSING && !entry.owned));
    if (unavailable.length > 0) {
        return {
            ok: false,
            reason: 'required tracker scripts are missing or changed upstream',
            blocked: unavailable.map(entry => ({ ...entry })),
        };
    }

    const blocked = report.perScript.filter(entry => !isAutoApplicable(entry.status)
        && entry.status !== STATUS.PRISTINE
        && !(entry.status === STATUS.MISSING && entry.owned));

    if (!force && blocked.length > 0) {
        return {
            ok: false,
            reason: 'changed outside this extension',
            blocked: blocked.map(entry => ({ ...entry })),
        };
    }

    // Capture genuine hand edits once, so revert can restore exactly what was there.
    const previous = settings.ledger[agent.id];
    const originals = { ...(previous?.originals ?? {}) };
    for (const entry of report.perScript) {
        if (entry.owned || entry.status !== STATUS.FOREIGN || originals[entry.scriptId]) {
            continue;
        }
        const script = (agent.regexScripts ?? []).find(item => item.id === entry.scriptId);
        if (script) {
            originals[entry.scriptId] = {
                replaceString: script.replaceString,
                findRegex: script.findRegex,
            };
        }
    }

    const built = buildAgentScripts(
        templateId,
        agent.regexScripts ?? [],
        theme,
        settings.options,
        agent.id,
    );

    const versionBefore = previous?.versionBefore ?? agentVersion(agent);
    const phaseLockedBefore = previous?.phaseLockedBefore ?? Boolean(agent.phaseLocked);

    const nextAgent = structuredClone(agent);
    nextAgent.regexScripts = built.scripts.map(script => host.scripts.normalizeRegexScript(script));

    if (signal?.aborted) {
        return { ok: false, cancelled: true, reason: 'cancelled' };
    }
    const saved = await saveAgentChange(host, agent, nextAgent);
    if (!saved.ok) {
        return saved;
    }

    const scriptLedger = {};
    const changedIds = new Set([...built.themed, ...built.added]);
    for (const script of agent.regexScripts) {
        if (!changedIds.has(script.id)) {
            continue;
        }
        scriptLedger[script.id] = {
            applied: script.replaceString,
            findRegex: script.findRegex,
        };
    }

    const current = getSettings();
    updateSettings({
        ledger: {
            ...current.ledger,
            [agent.id]: {
                agentId: agent.id,
                templateId,
                theme: themeSlug,
                engine: ENGINE_VERSION,
                appliedAt: Date.now(),
                versionBefore,
                phaseLockedBefore,
                scripts: scriptLedger,
                originals,
                added: built.added,
            },
        },
    });

    const change = { agentId: agent.id, scriptIds: [...changedIds] };
    const refresh = repaint
        ? await repaintMessagesForAgents([change])
        : null;
    return {
        ok: true,
        themed: built.themed.length,
        added: built.added.length,
        skipped: built.skipped,
        refreshed: Boolean(refresh?.matched),
        refresh,
        change,
    };
}

export function applyToAgent(agent, { force = false } = {}) {
    const settings = structuredClone(getSettings());
    return enqueueWrite(() => applyToAgentUnlocked(agent, { force, settings }));
}

/** Restores only changes this extension can prove it owns. */
async function revertAgentUnlocked(agent, {
    force = false,
    settings,
    host: readyHost,
    repaint = true,
    signal,
} = {}) {
    if (signal?.aborted) {
        return { ok: false, cancelled: true, reason: 'cancelled' };
    }
    const host = readyHost ?? await loadHost();
    if (!host.ok) {
        return { ok: false, reason: host.reason };
    }

    const templateId = agent.sourceTemplateId ?? '';
    const entry = settings.ledger[agent.id];

    if (!entry && !force) {
        return { ok: true, unchanged: true, reverted: 0, removed: 0, refreshed: false };
    }

    const plan = planRevertAgentScripts(
        templateId,
        agent.regexScripts ?? [],
        entry,
        { force },
    );

    if (plan.blocked.length > 0) {
        return {
            ok: false,
            reason: 'changed after this extension applied',
            blocked: plan.blocked,
        };
    }

    const nextAgent = structuredClone(agent);
    nextAgent.regexScripts = plan.scripts.map(script => host.scripts.normalizeRegexScript(script));
    if (entry) {
        nextAgent.phaseLocked = entry.phaseLockedBefore;
    }

    const metadataChanged = nextAgent.phaseLocked !== agent.phaseLocked;
    if (plan.changed > 0 || metadataChanged) {
        if (signal?.aborted) {
            return { ok: false, cancelled: true, reason: 'cancelled' };
        }
        const saved = await saveAgentChange(host, agent, nextAgent);
        if (!saved.ok) {
            return saved;
        }
    }

    const current = getSettings();
    const ledger = { ...current.ledger };
    delete ledger[agent.id];
    updateSettings({ ledger });

    const change = {
        agentId: agent.id,
        scriptIds: [...plan.restored, ...plan.removed],
    };
    const refresh = repaint && plan.changed > 0
        ? await repaintMessagesForAgents([change])
        : null;
    return {
        ok: true,
        reverted: plan.restored.length,
        removed: plan.removed.length,
        unchanged: plan.changed === 0 && !metadataChanged,
        refreshed: Boolean(refresh?.matched),
        refresh,
        change,
    };
}

export function revertAgent(agent, { force = false } = {}) {
    const settings = structuredClone(getSettings());
    return enqueueWrite(() => revertAgentUnlocked(agent, { force, settings }));
}

/** Applies the current settings to every themable agent. */
async function applyAllUnlocked({ force = false, settings } = {}) {
    const host = await loadHost();
    if (!host.ok) {
        return { ok: false, reason: host.reason };
    }

    const agents = themableAgents(host.store.getAgents() ?? []);
    const results = { applied: 0, reverted: 0, unchanged: 0, blocked: [], failed: [] };
    const changes = [];

    for (const agent of agents) {
        const themeSlug = resolveThemeSlug(agent.sourceTemplateId ?? '', settings);
        const result = themeSlug === STOCK_THEME
            ? await revertAgentUnlocked(agent, { force, settings, host, repaint: false })
            : await applyToAgentUnlocked(agent, { force, settings, host, repaint: false });

        if (result.ok) {
            if (themeSlug === STOCK_THEME) {
                if (result.unchanged) {
                    results.unchanged++;
                } else {
                    results.reverted++;
                }
            } else {
                results.applied++;
            }
            if (result.change?.scriptIds?.length) {
                changes.push(result.change);
            }
        } else if (result.blocked) {
            results.blocked.push({ agentId: agent.id, agentName: agent.name, blocked: result.blocked });
        } else {
            results.failed.push({ agentId: agent.id, reason: result.reason });
        }
    }

    const refresh = await repaintMessagesForAgents(changes);
    return { ok: true, ...results, refresh };
}

export function applyAll({ force = false } = {}) {
    const settings = structuredClone(getSettings());
    return enqueueWrite(() => applyAllUnlocked({ force, settings }));
}

/**
 * The boot pass. Only touches agents whose markup we recognise as stock (so a template
 * update silently restores the theme) or as our own older output. Hand edits are reported,
 * never overwritten, and an unchanged boot issues no writes at all.
 */
async function reconcileUnlocked({ settings, signal } = {}) {
    if (!settings.autoReapply || signal?.aborted) {
        return {
            ok: !signal?.aborted,
            cancelled: Boolean(signal?.aborted),
            repaired: 0,
            reverted: 0,
            needsAttention: [],
            failed: [],
        };
    }
    const host = await loadHost();
    if (!host.ok) {
        return { ok: false, reason: host.reason };
    }

    const agents = themableAgents(host.store.getAgents() ?? []);
    const needsAttention = [];
    const failed = [];
    const changes = [];
    let repaired = 0;
    let reverted = 0;

    for (const agent of agents) {
        if (signal?.aborted) {
            return { ok: false, cancelled: true, repaired, reverted, needsAttention, failed };
        }
        const themeSlug = resolveThemeSlug(agent.sourceTemplateId ?? '', settings);
        if (themeSlug === STOCK_THEME) {
            if (!settings.ledger[agent.id]) {
                continue;
            }
            const result = await revertAgentUnlocked(agent, {
                settings,
                host,
                repaint: false,
                signal,
            });
            if (result.ok) {
                if (!result.unchanged) {
                    reverted++;
                }
                if (result.change?.scriptIds?.length) {
                    changes.push(result.change);
                }
            } else if (result.blocked) {
                needsAttention.push({
                    agentId: agent.id,
                    agentName: agent.name,
                    entries: result.blocked,
                });
            } else if (!result.cancelled) {
                failed.push({ agentId: agent.id, agentName: agent.name, reason: result.reason });
            }
            continue;
        }

        const report = inspectAgent(agent, settings);
        const drifted = report.perScript.filter(entry => isAutoApplicable(entry.status)
            || (entry.status === STATUS.MISSING && entry.owned));
        const stuck = report.perScript.filter(entry => entry.status === STATUS.FOREIGN
            || entry.status === STATUS.UPSTREAM_CHANGED
            || (entry.status === STATUS.MISSING && !entry.owned));

        if (stuck.length > 0) {
            needsAttention.push({ agentId: agent.id, agentName: agent.name, entries: stuck });
            continue;
        }
        if (drifted.length === 0) {
            continue;
        }

        const result = await applyToAgentUnlocked(agent, {
            settings,
            host,
            repaint: false,
            signal,
        });
        if (result.ok) {
            repaired++;
            if (result.change?.scriptIds?.length) {
                changes.push(result.change);
            }
        } else if (result.blocked) {
            needsAttention.push({
                agentId: agent.id,
                agentName: agent.name,
                entries: result.blocked,
            });
        } else if (!result.cancelled) {
            failed.push({ agentId: agent.id, agentName: agent.name, reason: result.reason });
        }
    }

    const refresh = signal?.aborted
        ? null
        : await repaintMessagesForAgents(changes);
    return { ok: true, repaired, reverted, needsAttention, failed, refresh };
}

export function reconcile({ signal } = {}) {
    const settings = structuredClone(getSettings());
    return enqueueWrite(() => reconcileUnlocked({ settings, signal }));
}

export { STATUS };
