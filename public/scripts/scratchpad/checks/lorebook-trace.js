/**
 * Lorebook activation trace for Scratchpad Problem checks.
 * Reuses simulateWorldInfo and evaluateKeys from Neconyan-WorldInfo-Lab directly
 * without writing a second activation simulator.
 */
import {
    entryId,
    LOGIC_LABEL,
    POSITION,
} from '../../extensions/third-party/Neconyan-WorldInfo-Lab/src/constants.js';
import { getTimedEffects } from '../../extensions/third-party/Neconyan-WorldInfo-Lab/src/scan-input.js';
import { simulateWorldInfo } from '../../extensions/third-party/Neconyan-WorldInfo-Lab/src/simulator/engine.js';
import { evaluateKeys } from '../../extensions/third-party/Neconyan-WorldInfo-Lab/src/simulator/matching.js';
import {
    getWorldEntries,
    normalizeScanSettings,
    parseDecorators,
    sortByStrategy,
} from '../../extensions/third-party/Neconyan-WorldInfo-Lab/src/sources.js';
import { getStringHash } from '../../macro-primitives.js';
import { normalizeWorldInfoPosition } from '../../world-info-character-book.js';
import { normalizeWorldInfoProbability, parseWorldInfoKeyRegex } from '../../world-info-scan-core.js';

export const DEFAULT_TRACE_SEED = 1;
export const MAX_TRACE_LINES = 120;
export const MAX_TRACE_CHARS = 8_000;
const MAX_KEYS_NAMED = 6;
const DEFAULT_MAX_CONTEXT = 4096;

const OUTCOME_PRIORITY = Object.freeze({
    'budget-rejected': 100,
    'not-evaluated-after-overflow': 95,
    'probability-rejected': 90,
    'group-rejected': 85,
    'secondary-miss': 80,
    'timed-effect': 75,
    'character-filtered': 70,
    'trigger-filtered': 65,
    'decorator-blocked': 60,
    'disabled': 55,
    'no-primary-keys': 50,
    'primary-miss': 48,
    'recursion-gated': 45,
    'probability-failed-earlier': 10,
    'already-activated': 5,
});

function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function entryLabel(entry, includeBook = true) {
    const title = cleanText(entry?.comment) || `Entry ${entry?.uid}`;
    return includeBook && entry?.world ? `${title} (uid ${entry.uid}, ${entry.world})` : `${title} (uid ${entry.uid})`;
}

function formatKeyList(keys) {
    const clean = (Array.isArray(keys) ? keys : []).map(cleanText).filter(Boolean);
    if (!clean.length) return 'none';
    const shown = clean.slice(0, MAX_KEYS_NAMED).join(', ');
    return clean.length > MAX_KEYS_NAMED ? `${shown}, +${clean.length - MAX_KEYS_NAMED} more` : shown;
}

function groupList(entry) {
    return String(entry?.group ?? '').split(/,\s*/).map(item => item.trim()).filter(Boolean);
}

function normalizePositionValue(entry) {
    const raw = entry?.position;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 7) return raw;
    return normalizeWorldInfoPosition(raw, POSITION.before);
}

/**
 * Strips entries hidden from Agents and clears content on disabled entries
 * before any entry enters the simulator.
 */
function buildSimulatorEntries(books, insertionStrategy) {
    const groups = { chat: [], persona: [], character: [], global: [] };
    let hiddenCount = 0;
    for (const book of books || []) {
        const rawEntries = Object.values(book?.raw?.entries || {});
        const visible = {};
        let index = 0;
        for (const raw of rawEntries) {
            if (!raw || typeof raw !== 'object') continue;
            if (raw.agentBlacklisted) {
                hiddenCount++;
                continue;
            }
            const safeEntry = raw.disable
                ? { ...raw, content: '' }
                : { ...raw };
            visible[raw.uid ?? index] = safeEntry;
            index++;
        }
        const sourceKey = groups[book.source] ? book.source : 'global';
        const rawList = getWorldEntries({ entries: visible }, book.name, sourceKey);
        groups[sourceKey].push(...rawList);
    }
    const entries = sortByStrategy(groups, insertionStrategy).map((raw) => {
        const { labSource, ...entryWithoutSource } = raw;
        const rawContent = entryWithoutSource.disable ? '' : String(entryWithoutSource.content ?? '');
        const parsed = entryWithoutSource.disable ? { decorators: [], content: '' } : parseDecorators(rawContent);
        const decoratedEntry = { ...entryWithoutSource, ...parsed };
        const hash = getStringHash(JSON.stringify(decoratedEntry));
        const prob = normalizeWorldInfoProbability(decoratedEntry);
        return {
            ...decoratedEntry,
            ...prob,
            hash,
            labSource,
            comment: String(decoratedEntry.comment ?? ''),
            key: Array.isArray(decoratedEntry.key) ? decoratedEntry.key.map(String) : [],
            keysecondary: Array.isArray(decoratedEntry.keysecondary) ? decoratedEntry.keysecondary.map(String) : [],
            selective: decoratedEntry.selective ?? true,
            selectiveLogic: Number(decoratedEntry.selectiveLogic ?? 0),
            constant: Boolean(decoratedEntry.constant),
            disable: Boolean(decoratedEntry.disable),
            position: normalizePositionValue(decoratedEntry),
            order: Number(decoratedEntry.order ?? 100),
            depth: Number(decoratedEntry.depth ?? 4),
            scanDepth: decoratedEntry.scanDepth === null || decoratedEntry.scanDepth === undefined || decoratedEntry.scanDepth === '' ? null : Number(decoratedEntry.scanDepth),
            caseSensitive: typeof decoratedEntry.caseSensitive === 'boolean' ? decoratedEntry.caseSensitive : null,
            matchWholeWords: typeof decoratedEntry.matchWholeWords === 'boolean' ? decoratedEntry.matchWholeWords : null,
            useGroupScoring: typeof decoratedEntry.useGroupScoring === 'boolean' ? decoratedEntry.useGroupScoring : null,
            excludeRecursion: Boolean(decoratedEntry.excludeRecursion),
            preventRecursion: Boolean(decoratedEntry.preventRecursion),
            delayUntilRecursion: decoratedEntry.delayUntilRecursion ?? 0,
            ignoreBudget: Boolean(decoratedEntry.ignoreBudget),
            group: String(decoratedEntry.group ?? ''),
            groupOverride: Boolean(decoratedEntry.groupOverride),
            groupWeight: Number(decoratedEntry.groupWeight ?? 100),
            sticky: Number(decoratedEntry.sticky) > 0 ? Number(decoratedEntry.sticky) : 0,
            cooldown: Number(decoratedEntry.cooldown) > 0 ? Number(decoratedEntry.cooldown) : 0,
            delay: Number(decoratedEntry.delay) > 0 ? Number(decoratedEntry.delay) : 0,
            triggers: Array.isArray(decoratedEntry.triggers) ? decoratedEntry.triggers : [],
            characterFilter: decoratedEntry.characterFilter && typeof decoratedEntry.characterFilter === 'object' ? decoratedEntry.characterFilter : null,
        };
    });
    return { entries, hiddenCount };
}

function findLastFailedStage(trace) {
    const stages = Array.isArray(trace?.stages) ? trace.stages : [];
    for (let i = stages.length - 1; i >= 0; i--) {
        if (stages[i]?.status === 'fail') return stages[i];
    }
    return null;
}

function chooseBestTrace(entryTraces) {
    if (!entryTraces.length) return null;
    let best = entryTraces[0];
    let bestScore = OUTCOME_PRIORITY[best.outcome] ?? 0;
    for (let i = 1; i < entryTraces.length; i++) {
        const candidate = entryTraces[i];
        const score = OUTCOME_PRIORITY[candidate.outcome] ?? 0;
        // Prefer further-along failures, and on a tie prefer the later round
        // (e.g. recursion delay-level over round-0 delayed).
        if (score > bestScore || (score === bestScore && candidate.outcome === 'recursion-gated')) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}

function matchedKeyText(match) {
    if (!match) return '';
    if (typeof match === 'string') return cleanText(match);
    return cleanText(match.expanded || match.raw || '');
}

function findDeeperPrimaryMatch(entry, messages, effectiveDepth, settings, expand) {
    if (!Array.isArray(messages) || messages.length <= effectiveDepth) return null;
    for (let i = Math.max(0, effectiveDepth); i < messages.length; i++) {
        const text = String(messages[i] ?? '');
        if (!text) continue;
        const result = evaluateKeys(entry, text, settings, expand, parseWorldInfoKeyRegex);
        if (result.primaryMatch) {
            return { depth: i + 1, key: matchedKeyText(result.primaryMatch) || entry.key[0] || '' };
        }
    }
    return null;
}

function findRecursionBufferMatch(entry, activatedEntries, settings, expand) {
    const buffer = activatedEntries
        .filter(item => !item.preventRecursion && item.content)
        .map(item => item.content)
        .join('\n');
    if (!buffer) return null;
    const result = evaluateKeys(entry, buffer, settings, expand, parseWorldInfoKeyRegex);
    return result.matched ? (matchedKeyText(result.primaryMatch) || entry.key[0] || '') : null;
}

function resolveGroupWinner(detail, groupName, entryById, activatedEntries, multipleBooks) {
    if (detail?.winner && entryById.has(detail.winner)) {
        return entryLabel(entryById.get(detail.winner), multipleBooks);
    }
    if (groupName) {
        const winner = activatedEntries.find(item => groupList(item).includes(groupName));
        if (winner) return entryLabel(winner, multipleBooks);
    }
    return '';
}

function stickyNote(entry, hasChatState, isStickyActive) {
    if (!entry.sticky || entry.sticky <= 0 || isStickyActive) return '';
    return hasChatState
        ? `not yet sticky (sticky ${entry.sticky} applies only after it activates)`
        : `not yet sticky (sticky ${entry.sticky} depends on prior chat turns)`;
}

function joinParts(parts) {
    return parts.filter(Boolean).join('; ');
}

function formatNonActivatedReason({
    entry,
    entryTraces,
    bestTrace,
    messages,
    settings,
    expand,
    activatedEntries,
    entryById,
    budgetLimit,
    hasChatState,
    hasChatMessages,
    chatLength,
    timedStickySet,
    multipleBooks,
}) {
    if (!bestTrace) return 'not evaluated';
    const detail = findLastFailedStage(bestTrace) || {};
    const outcome = bestTrace.outcome;
    const id = entryId(entry);
    const isStickyActive = timedStickySet.has(id);

    switch (outcome) {
        case 'disabled':
            return 'disabled';
        case 'no-primary-keys':
            return 'no primary keys configured';
        case 'primary-miss': {
            const effectiveDepth = entry.scanDepth === null ? Number(settings.depth ?? 0) : Number(entry.scanDepth);
            const deeper = findDeeperPrimaryMatch(entry, messages, effectiveDepth, settings, expand);
            const excludedInRecursion = entryTraces.some(tr =>
                tr.outcome === 'recursion-gated' && findLastFailedStage(tr)?.reason === 'excluded');
            if (excludedInRecursion && entry.excludeRecursion) {
                const recKey = findRecursionBufferMatch(entry, activatedEntries, settings, expand);
                if (recKey) {
                    return `excluded from recursion (Non-recursable; key "${recKey}" appeared in an activated entry, and no chat message matched)`;
                }
            }
            if (deeper) {
                const depthPhrase = effectiveDepth === 1 ? '1 message' : `${effectiveDepth} messages`;
                return joinParts([
                    `scan depth too short (${depthPhrase}; primary key "${deeper.key}" would match at message depth ${deeper.depth})`,
                    stickyNote(entry, hasChatState, isStickyActive),
                ]);
            }
            if (effectiveDepth === 0) {
                return joinParts([
                    `scan depth is 0 (scans no messages; tried keys: ${formatKeyList(entry.key)})`,
                    stickyNote(entry, hasChatState, isStickyActive),
                ]);
            }
            const base = `no primary key matched (tried: ${formatKeyList(entry.key)})`;
            const recNote = excludedInRecursion ? 'excluded from recursion' : '';
            return joinParts([base, recNote, stickyNote(entry, hasChatState, isStickyActive)]);
        }
        case 'secondary-miss': {
            const logicCode = bestTrace.match?.logic ?? entry.selectiveLogic;
            const logic = LOGIC_LABEL[logicCode] || String(logicCode);
            const primary = matchedKeyText(bestTrace.match?.primaryMatch) || entry.key[0] || '';
            const primaryPart = primary ? `primary key "${primary}" matched` : 'primary key matched';
            return joinParts([
                `${primaryPart}, but secondary-key logic ${logic} failed (secondary keys: ${formatKeyList(entry.keysecondary)})`,
                stickyNote(entry, hasChatState, isStickyActive),
            ]);
        }
        case 'probability-rejected': {
            const threshold = detail.threshold ?? entry.probability ?? 0;
            if (detail.reason === 'zero' || threshold <= 0) {
                return 'probability is 0% (Use Probability is on)';
            }
            return `may not activate: probability is ${threshold}% (depends on a random roll)`;
        }
        case 'timed-effect': {
            if (detail.reason === 'delay') {
                const needed = entry.delay;
                return hasChatMessages
                    ? `blocked by delay (requires ${needed} messages; chat has ${chatLength})`
                    : `may be blocked by delay (requires ${needed} messages; depends on chat length)`;
            }
            if (detail.reason === 'cooldown') {
                const cd = entry.cooldown;
                return hasChatState
                    ? `blocked by cooldown (${cd} messages; active in current chat state)`
                    : `may be blocked by cooldown (${cd} messages; depends on chat state)`;
            }
            return 'blocked by timed effect (depends on chat state)';
        }
        case 'group-rejected': {
            const groupName = detail.group || groupList(entry)[0] || '';
            const winner = resolveGroupWinner(detail, groupName, entryById, activatedEntries, multipleBooks);
            const winnerText = winner ? ` to ${winner}` : '';
            if (detail.reason === 'non-sticky-loser') {
                return `lost in inclusion group "${groupName}"${winnerText} (not yet sticky; a sticky entry held the group)`;
            }
            if (detail.reason === 'override-loser') {
                return `lost in inclusion group "${groupName}"${winnerText} (prioritised override)`;
            }
            if (detail.reason === 'lower-score') {
                return `lost in inclusion group "${groupName}"${winnerText} (lower keyword score: ${detail.score} vs ${detail.maximum})`;
            }
            if (detail.reason === 'weighted-loser') {
                return `may lose in inclusion group "${groupName}"${winnerText} (weighted selection; depends on a random roll)`;
            }
            if (detail.reason === 'already-activated') {
                return `lost in inclusion group "${groupName}"${winnerText} (group already activated)`;
            }
            return `lost in inclusion group "${groupName}"${winnerText}`;
        }
        case 'budget-rejected': {
            const limit = detail.limit ?? budgetLimit;
            const after = Number(detail.after ?? 0);
            const delta = Number(detail.delta ?? 0);
            if (detail.reason === 'limit-reached') {
                const over = Math.max(0, after - limit);
                return over > 0
                    ? `cut by token budget (budget ${limit} tokens; ${over} tokens over with this ${delta}-token entry)`
                    : `cut by token budget (budget ${limit} tokens; adding ${delta} tokens reaches the cap)`;
            }
            return `cut by token budget (budget ${limit} tokens already full; entry needs ${delta} tokens)`;
        }
        case 'not-evaluated-after-overflow':
            return `cut by token budget (budget ${budgetLimit} tokens already full)`;
        case 'character-filtered': {
            const list = Array.isArray(detail.configured) ? detail.configured.join(', ') : '';
            const verb = entry.characterFilter?.isExclude ? 'excluded' : 'limited to';
            const kind = detail.kind === 'character-tag' ? 'character tags' : 'character';
            return `filtered by ${kind} (${verb}: ${list || 'configured filter'})`;
        }
        case 'trigger-filtered': {
            const list = Array.isArray(detail.configured) ? detail.configured.join(', ') : '';
            return `filtered by generation type (only runs on: ${list || 'none'}; checked as ${detail.actual || 'normal'})`;
        }
        case 'recursion-gated': {
            if (detail.reason === 'excluded') {
                return 'excluded from recursion (Non-recursable)';
            }
            if (detail.reason === 'delay-level') {
                return `waiting for recursion level ${detail.required} (reached level ${detail.current})`;
            }
            return settings.recursive
                ? 'waiting for recursion (Delay until recursion is on; no recursion step matched it)'
                : 'waiting for recursion (Delay until recursion is on; recursive scanning is off)';
        }
        case 'decorator-blocked':
            return 'blocked by @@dont_activate decorator';
        default:
            return outcome;
    }
}

function activatedCaveats(entry, { hasChatState, hasChatMessages }) {
    const notes = [];
    if (entry.useProbability && entry.probability > 0 && entry.probability < 100) {
        notes.push(`may not activate: probability is ${entry.probability}% (depends on a random roll)`);
    }
    if (!hasChatMessages && entry.delay > 0) {
        notes.push(`may be blocked by delay (${entry.delay} messages; depends on chat length)`);
    }
    if (!hasChatState && entry.cooldown > 0) {
        notes.push(`cooldown ${entry.cooldown} depends on chat state`);
    }
    if (!hasChatState && entry.sticky > 0) {
        notes.push(`sticky ${entry.sticky} depends on chat state`);
    }
    return notes;
}

/**
 * Runs simulateWorldInfo on sanitized books (hidden entries stripped, disabled
 * content cleared) and builds a structured activation trace.
 */
export async function traceLorebooks({
    books = [],
    messages = [],
    settings = {},
    maxContext = DEFAULT_MAX_CONTEXT,
    globalScanData = {},
    character = { filename: '', tags: [], tagsAvailable: false },
    chatMetadata = null,
    chatLength = 0,
    hasChatState = false,
    hasChatMessages = false,
    trigger = 'normal',
    expand = value => String(value ?? ''),
    tokenCount = value => Math.ceil(String(value ?? '').length / 4),
    seed = DEFAULT_TRACE_SEED,
} = {}) {
    const sanitizedSettings = { ...settings };
    if (sanitizedSettings.budgetPercent === undefined && sanitizedSettings.world_info_budget === undefined && sanitizedSettings.budget !== undefined) {
        sanitizedSettings.budgetPercent = sanitizedSettings.budget;
    }
    if (sanitizedSettings.budgetPercent !== undefined && Number(sanitizedSettings.budgetPercent) < 1) {
        delete sanitizedSettings.budgetPercent;
    }
    if (sanitizedSettings.world_info_budget !== undefined && Number(sanitizedSettings.world_info_budget) < 1) {
        delete sanitizedSettings.world_info_budget;
    }
    const normalizedSettings = normalizeScanSettings(sanitizedSettings);
    const { entries, hiddenCount } = buildSimulatorEntries(books, normalizedSettings.characterStrategy);
    const effectiveMaxContext = Number(maxContext) > 0 ? Number(maxContext) : DEFAULT_MAX_CONTEXT;
    const multipleBooks = books.length > 1;

    if (!entries.length) {
        return {
            activated: [],
            notActivated: [],
            budget: { limit: 0, used: 0, overflowed: false },
            hiddenCount,
            scannedMessages: messages.length,
            hasChatState,
            hasChatMessages,
            multipleBooks,
        };
    }

    const timedEffects = hasChatState
        ? getTimedEffects({ chatMetadata }, entries, chatLength)
        : (hasChatMessages
            ? getTimedEffects({ chatMetadata: null }, entries, chatLength)
            : { sticky: [], cooldown: [], delay: [] });

    const timedStickySet = new Set((timedEffects.sticky || []).map(item => String(item?.id ?? '')));

    const simulation = await simulateWorldInfo({
        entries,
        messages,
        injections: [],
        globalScanData,
        character,
        maxContext: effectiveMaxContext,
        trigger,
        seed,
        settings: normalizedSettings,
        timedEffects,
        forcedRefs: [],
        expand,
        parseRegex: parseWorldInfoKeyRegex,
        tokenCount,
        processRegex: null,
    });

    const activatedSet = new Set(simulation.activated.map(entry => entryId(entry)));
    const entryById = new Map(entries.map(entry => [entryId(entry), entry]));
    const activatedEntries = entries.filter(entry => activatedSet.has(entryId(entry)));
    const tracesByRef = new Map();
    for (const trace of simulation.traces) {
        const ref = trace.entryId || entryId({ world: trace.world, uid: trace.uid });
        const list = tracesByRef.get(ref) || [];
        list.push(trace);
        tracesByRef.set(ref, list);
    }

    const activated = [];
    const notActivated = [];
    const seen = new Set();

    for (const entry of entries) {
        const ref = entryId(entry);
        if (seen.has(ref)) continue;
        seen.add(ref);
        const label = entryLabel(entry, multipleBooks);
        if (activatedSet.has(ref)) {
            const caveats = activatedCaveats(entry, { hasChatState, hasChatMessages });
            activated.push({
                world: entry.world,
                uid: entry.uid,
                label,
                caveats,
            });
            continue;
        }
        const entryTraces = tracesByRef.get(ref) || [];
        const bestTrace = chooseBestTrace(entryTraces);
        const reason = formatNonActivatedReason({
            entry,
            entryTraces,
            bestTrace,
            messages,
            settings: normalizedSettings,
            expand,
            activatedEntries,
            entryById,
            budgetLimit: simulation.budget.limit,
            hasChatState,
            hasChatMessages,
            chatLength,
            timedStickySet,
            multipleBooks,
        });
        notActivated.push({
            world: entry.world,
            uid: entry.uid,
            label,
            outcome: bestTrace?.outcome || 'not-evaluated',
            reason,
        });
    }

    return {
        activated,
        notActivated,
        budget: simulation.budget,
        hiddenCount,
        scannedMessages: messages.length,
        hasChatState,
        hasChatMessages,
        multipleBooks,
    };
}

/**
 * Formats a lorebook activation trace for the shared Scratchpad context,
 * capping lines and total characters and reporting how many lines were cut.
 */
export function formatLorebookTrace(trace, { maxLines = MAX_TRACE_LINES, maxChars = MAX_TRACE_CHARS } = {}) {
    if (!trace || (!trace.activated?.length && !trace.notActivated?.length)) return '';
    const lines = [];
    let chars = 0;
    let omitted = 0;
    const budgetText = trace.budget?.limit ? `budget ${trace.budget.used}/${trace.budget.limit} tokens` : '';
    const countLabel = trace.hasChatMessages
        ? (trace.scannedMessages === 1 ? '1 chat message' : `${trace.scannedMessages} chat messages`)
        : (trace.scannedMessages === 1 ? '1 Scratchpad message (no open chat; timed effects depend on chat state)' : `${trace.scannedMessages} Scratchpad messages (no open chat; timed effects depend on chat state)`);
    const scopeText = `${[`Scanned ${countLabel}`, budgetText].filter(Boolean).join(', ')}.`;

    const tryPush = (line) => {
        if (lines.length >= maxLines || chars + line.length + 1 > maxChars) {
            omitted++;
            return false;
        }
        lines.push(line);
        chars += line.length + 1;
        return true;
    };

    tryPush(scopeText);

    if (trace.activated.length) {
        const items = trace.activated.map(item =>
            item.caveats?.length ? `${item.label} (${item.caveats.join('; ')})` : item.label);
        const summary = `Would activate (${trace.activated.length}): ${items.join('; ')}`;
        if (summary.length <= 400 && chars + summary.length + 1 <= maxChars && lines.length < maxLines) {
            tryPush(summary);
        } else {
            tryPush(`Would activate (${trace.activated.length}):`);
            for (const item of items) tryPush(`- ${item}`);
        }
    } else {
        tryPush('Would activate (0): none.');
    }

    if (trace.notActivated.length) {
        tryPush(`Would not activate (${trace.notActivated.length}):`);
        for (const item of trace.notActivated) {
            tryPush(`- ${item.label}: ${item.reason}`);
        }
    }

    if (omitted > 0) {
        lines.push(`(${omitted} more trace ${omitted === 1 ? 'line was' : 'lines were'} omitted to fit the shared limit.)`);
    }
    return lines.join('\n');
}
