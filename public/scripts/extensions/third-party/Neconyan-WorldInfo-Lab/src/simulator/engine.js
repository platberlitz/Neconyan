import {
    DEFAULT_SCAN_SETTINGS,
    LOGIC_LABEL,
    SCAN_STATE,
    SCAN_STATE_LABEL,
    entryId,
    entryRef,
    entryRefKey,
} from '../constants.js';
import { normalizeScanSettings } from '../sources.js';
import {
    ScanBuffer,
    createRng,
    evaluateKeys,
} from './matching.js';
import { buildPlacements } from './placements.js';

const DEFAULT_GROUP_WEIGHT = 100;

function groupsOf(entry) {
    return typeof entry.group === 'string'
        ? [...new Set(entry.group.split(',').map(value => value.trim()).filter(Boolean))]
        : [];
}

function stage(trace, name, status, detail = {}) {
    trace.stages.push({ name, status, ...detail });
}

function makeTrace(entry, entryIndex, round, state) {
    return {
        id: entryId(entry),
        hash: String(entry.hash ?? ''),
        world: entry.world,
        uid: entry.uid,
        label: entry.comment || `Entry ${entry.uid}`,
        source: entry.labSource ?? 'test',
        entryIndex,
        round,
        state,
        stateLabel: SCAN_STATE_LABEL[state],
        stages: [],
        outcome: 'not-evaluated',
        activationReason: '',
    };
}

function reject(trace, name, detail = {}) {
    stage(trace, name, 'fail', detail);
    trace.outcome = detail.outcome ?? 'rejected';
    return false;
}

function pass(trace, name, detail = {}) {
    stage(trace, name, 'pass', detail);
    return true;
}

function isActive(timed, type, entry) {
    return timed[type].has(entryRefKey(entryRef(entry)));
}

function getCharacterFilterFailure(entry, character) {
    const filter = entry.characterFilter;
    if (!filter || typeof filter !== 'object') {
        return null;
    }
    if (Array.isArray(filter.names) && filter.names.length) {
        const match = filter.names.includes(character.filename);
        if (filter.isExclude ? match : !match) {
            return { kind: 'character-name', configured: filter.names, actual: character.filename };
        }
    }
    if (Array.isArray(filter.tags) && filter.tags.length && character.tagsAvailable !== false) {
        const match = character.tags.some(tag => filter.tags.includes(tag));
        if (filter.isExclude ? match : !match) {
            return { kind: 'character-tag', configured: filter.tags, actual: character.tags };
        }
    }
    return null;
}

function candidateEntry(entry, trace, reason, external = false) {
    trace.activationReason = reason;
    trace.outcome = 'candidate';
    stage(trace, 'Activation', 'pass', { reason });
    return { entry, trace, external };
}

function filterGroups(candidates, activated, buffer, state, timed, settings, expand, parseRegex, random) {
    const grouped = Object.create(null);
    for (const candidate of candidates) {
        for (const groupName of groupsOf(candidate.entry)) {
            grouped[groupName] ??= [];
            grouped[groupName].push(candidate);
        }
    }
    const active = new Set(candidates);
    const remove = (candidate, groupName, reason, detail = {}) => {
        if (!active.has(candidate)) {
            return;
        }
        active.delete(candidate);
        stage(candidate.trace, 'Inclusion group', 'fail', { group: groupName, reason, ...detail });
        candidate.trace.outcome = 'group-rejected';
        for (const group of Object.values(grouped)) {
            const index = group.indexOf(candidate);
            if (index !== -1) {
                group.splice(index, 1);
            }
        }
    };
    const removeAllBut = (groupName, group, winner, reason, detail = {}) => {
        for (const candidate of [...group]) {
            if (candidate !== winner) {
                remove(candidate, groupName, reason, detail);
            }
        }
    };

    const stickyByGroup = new Map();
    for (const [groupName, group] of Object.entries(grouped)) {
        const sticky = group.filter(candidate => isActive(timed, 'sticky', candidate.entry));
        stickyByGroup.set(groupName, sticky.length > 0);
        if (sticky.length) {
            for (const candidate of [...group]) {
                if (!sticky.includes(candidate)) {
                    remove(candidate, groupName, 'non-sticky-loser');
                }
            }
        }
        for (const candidate of [...group]) {
            if (isActive(timed, 'cooldown', candidate.entry) || isActive(timed, 'delay', candidate.entry)) {
                remove(candidate, groupName, 'timed-effect');
            }
        }
    }

    for (const [groupName, group] of Object.entries(grouped)) {
        if (stickyByGroup.get(groupName) || (!settings.useGroupScoring && !group.some(item => item.entry.useGroupScoring))) {
            continue;
        }
        const scored = group.map(candidate => ({
            candidate,
            score: buffer.score(candidate.entry, state, expand, parseRegex),
        }));
        const maximum = Math.max(...scored.map(item => item.score));
        for (const item of scored) {
            const enabled = item.candidate.entry.useGroupScoring ?? settings.useGroupScoring;
            if (enabled && item.score < maximum) {
                remove(item.candidate, groupName, 'lower-score', { score: item.score, maximum });
            } else if (active.has(item.candidate)) {
                stage(item.candidate.trace, 'Group score', 'pass', {
                    group: groupName,
                    score: item.score,
                    maximum,
                });
            }
        }
    }

    for (const [groupName, group] of Object.entries(grouped)) {
        if (stickyByGroup.get(groupName)) {
            for (const candidate of group) {
                if (active.has(candidate)) {
                    stage(candidate.trace, 'Inclusion group', 'pass', { group: groupName, reason: 'sticky' });
                }
            }
            continue;
        }
        if ([...activated].some(entry => groupsOf(entry).includes(groupName))) {
            removeAllBut(groupName, group, null, 'already-activated');
            continue;
        }
        const available = group.filter(candidate => active.has(candidate));
        if (available.length <= 1) {
            for (const candidate of available) {
                stage(candidate.trace, 'Inclusion group', 'pass', { group: groupName, reason: 'only-candidate' });
            }
            continue;
        }
        const overrides = available.filter(candidate => candidate.entry.groupOverride)
            .sort((a, b) => b.entry.order - a.entry.order);
        if (overrides.length) {
            const winner = overrides[0];
            stage(winner.trace, 'Inclusion group', 'pass', { group: groupName, reason: 'override' });
            removeAllBut(groupName, available, winner, 'override-loser', { winner: entryId(winner.entry) });
            continue;
        }
        const weights = available.map(candidate => Number(candidate.entry.groupWeight ?? DEFAULT_GROUP_WEIGHT));
        const totalWeight = weights.reduce((sum, value) => sum + value, 0);
        if (weights.some(value => !Number.isFinite(value) || value <= 0) || !Number.isFinite(totalWeight) || totalWeight <= 0) {
            for (const candidate of available) {
                remove(candidate, groupName, 'invalid-weight');
            }
            continue;
        }
        const roll = random() * totalWeight;
        let weight = 0;
        let winner = null;
        for (const [index, candidate] of available.entries()) {
            weight += weights[index];
            if (roll <= weight) {
                winner = candidate;
                break;
            }
        }
        if (winner) {
            stage(winner.trace, 'Inclusion group', 'pass', {
                group: groupName,
                reason: 'weighted-roll',
                roll,
                totalWeight,
            });
            removeAllBut(groupName, available, winner, 'weighted-loser', {
                winner: entryId(winner.entry),
                roll,
                totalWeight,
            });
        } else {
            for (const candidate of available) {
                remove(candidate, groupName, 'no-winner');
            }
        }
    }

    for (const candidate of candidates) {
        if (active.has(candidate) && !groupsOf(candidate.entry).length) {
            stage(candidate.trace, 'Inclusion group', 'skip', { reason: 'not-grouped' });
        }
    }
    return candidates.filter(candidate => active.has(candidate));
}

function probability(entry, sticky, random) {
    const enabled = entry.useProbability ?? entry.extensions?.useProbability ?? true;
    if (!enabled || sticky) {
        return { passed: true, roll: null, reason: sticky ? 'sticky' : 'disabled' };
    }
    const threshold = Number(entry.probability ?? entry.extensions?.probability ?? 100);
    if (!Number.isFinite(threshold) || threshold >= 100) {
        return { passed: true, roll: null, reason: 'guaranteed', threshold };
    }
    if (threshold <= 0) {
        return { passed: false, roll: null, reason: 'zero', threshold };
    }
    const roll = random() * 100;
    return { passed: roll < threshold, roll, threshold, reason: 'roll' };
}

function stableFingerprint(value) {
    const input = JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeReference(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.id !== 'string' || !value.id
        || typeof value.hash !== 'string' || !value.hash) {
        throw new TypeError(`${label} must contain a lorebook entry ID and hash.`);
    }
    return { id: value.id, hash: value.hash };
}

function normalizeReferences(value, label) {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be a list.`);
    }
    return new Map(value.map(reference => {
        const normalized = normalizeReference(reference, label);
        return [entryRefKey(normalized), normalized];
    }));
}

function normalizeTimedEffects(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Timed effects must contain sticky, cooldown, and delay lists.');
    }
    return {
        sticky: new Set(normalizeReferences(value.sticky, 'Sticky effects').keys()),
        cooldown: new Set(normalizeReferences(value.cooldown, 'Cooldown effects').keys()),
        delay: new Set(normalizeReferences(value.delay, 'Delay effects').keys()),
    };
}

function checkAbort(signal) {
    if (signal?.aborted) {
        throw new DOMException('Scan canceled.', 'AbortError');
    }
}

export async function simulateWorldInfo(request, { signal } = {}) {
    if (!Array.isArray(request?.entries) || !Array.isArray(request.messages) || !Array.isArray(request.injections)) {
        throw new TypeError('Scan entries, messages, and injections must be lists.');
    }
    if (!request.character || typeof request.character.filename !== 'string'
        || !Array.isArray(request.character.tags) || request.character.tags.some(tag => typeof tag !== 'string')
        || typeof request.character.tagsAvailable !== 'boolean') {
        throw new TypeError('Scan character data must contain a filename, tag list, and tag availability flag.');
    }
    const maxContext = Number(request.maxContext);
    if (!Number.isFinite(maxContext) || maxContext <= 0) {
        throw new TypeError('The scan context limit must be a positive number.');
    }
    const entries = structuredClone(request.entries).map((entry) => {
        const probabilityValue = Number(entry.probability ?? entry.extensions?.probability ?? 100);
        return {
            ...entry,
            probability: Number.isFinite(probabilityValue) ? probabilityValue : 100,
            useProbability: entry.useProbability ?? entry.extensions?.useProbability ?? true,
        };
    });
    const settings = normalizeScanSettings({ ...DEFAULT_SCAN_SETTINGS, ...(request.settings ?? {}) });
    const entryOrder = new Map(entries.map((entry, index) => [entry, index]));
    const random = createRng(request.seed);
    const buffer = new ScanBuffer(request.messages ?? [], request.globalScanData, request.injections, settings);
    const timed = normalizeTimedEffects(request.timedEffects);
    const forcedRefs = normalizeReferences(request.forcedRefs ?? [], 'Forced entries');
    const forced = new Set(forcedRefs.keys());
    const activated = new Set();
    const failedProbability = new Set();
    const rounds = [];
    const traces = [];
    const tokenCache = new Map();
    const tokenCount = async (value) => {
        const text = String(value ?? '');
        if (!tokenCache.has(text)) {
            tokenCache.set(text, Promise.resolve(request.tokenCount(text)).then(Number).then((count) => {
                if (!Number.isFinite(count) || count < 0) {
                    throw new TypeError('The tokenizer returned an invalid token count.');
                }
                return count;
            }));
        }
        return tokenCache.get(text);
    };
    let budget = Math.round(Number(settings.budgetPercent) * maxContext / 100) || 1;
    if (Number(settings.budgetCap) > 0 && budget > Number(settings.budgetCap)) {
        budget = Number(settings.budgetCap);
    }
    let overflowed = false;
    let allActivatedText = '';
    let state = SCAN_STATE.INITIAL;
    let loopCount = 0;
    const delayedLevels = settings.recursive
        ? [...new Set(entries.filter(entry => entry.delayUntilRecursion).map(entry => (
            entry.delayUntilRecursion === true ? 1 : Number(entry.delayUntilRecursion)
        )))].sort((a, b) => a - b)
        : [];
    let currentDelayLevel = delayedLevels.shift() ?? 0;

    while (state) {
        checkAbort(signal);
        if (Number(settings.maxRecursionSteps) && Number(settings.maxRecursionSteps) <= loopCount) {
            break;
        }
        loopCount++;
        const round = {
            number: loopCount,
            state,
            stateLabel: SCAN_STATE_LABEL[state],
            depth: buffer.getDepth(),
            candidates: [],
            activated: [],
            nextState: SCAN_STATE.NONE,
        };
        rounds.push(round);
        let candidates = [];

        for (const entry of entries) {
            const id = entryId(entry);
            const entryIndex = entryOrder.get(entry);
            const trace = makeTrace(entry, entryIndex, loopCount, state);
            traces.push(trace);
            if (activated.has(entry)) {
                stage(trace, 'Prior result', 'skip', { reason: 'already-activated' });
                trace.outcome = 'already-activated';
                continue;
            }
            if (failedProbability.has(entry)) {
                stage(trace, 'Prior result', 'skip', { reason: 'probability-failed' });
                trace.outcome = 'probability-failed-earlier';
                continue;
            }
            if (entry.disable == true) {
                reject(trace, 'Enabled', { reason: 'disabled', outcome: 'disabled' });
                continue;
            }
            pass(trace, 'Enabled');
            if (Array.isArray(entry.triggers) && entry.triggers.length && !entry.triggers.includes(request.trigger)) {
                reject(trace, 'Generation trigger', {
                    reason: 'not-included',
                    actual: request.trigger,
                    configured: entry.triggers,
                    outcome: 'trigger-filtered',
                });
                continue;
            }
            pass(trace, 'Generation trigger', { actual: request.trigger });
            const characterFailure = getCharacterFilterFailure(entry, request.character ?? { filename: '', tags: [] });
            if (characterFailure) {
                reject(trace, 'Character filter', { ...characterFailure, outcome: 'character-filtered' });
                continue;
            }
            pass(trace, 'Character filter');
            const sticky = isActive(timed, 'sticky', entry);
            const cooldown = isActive(timed, 'cooldown', entry);
            const delay = isActive(timed, 'delay', entry);
            if (delay || (cooldown && !sticky)) {
                reject(trace, 'Timed effects', {
                    reason: delay ? 'delay' : 'cooldown',
                    sticky,
                    cooldown,
                    delay,
                    outcome: 'timed-effect',
                });
                continue;
            }
            pass(trace, 'Timed effects', { sticky, cooldown, delay });
            if (state !== SCAN_STATE.RECURSION && entry.delayUntilRecursion && !sticky) {
                reject(trace, 'Recursion gate', { reason: 'delayed', outcome: 'recursion-gated' });
                continue;
            }
            if (state === SCAN_STATE.RECURSION && entry.delayUntilRecursion
                && Number(entry.delayUntilRecursion) > currentDelayLevel && !sticky) {
                reject(trace, 'Recursion gate', {
                    reason: 'delay-level',
                    required: Number(entry.delayUntilRecursion),
                    current: currentDelayLevel,
                    outcome: 'recursion-gated',
                });
                continue;
            }
            if (state === SCAN_STATE.RECURSION && settings.recursive && entry.excludeRecursion && !sticky) {
                reject(trace, 'Recursion gate', { reason: 'excluded', outcome: 'recursion-gated' });
                continue;
            }
            pass(trace, 'Recursion gate', { currentDelayLevel });
            if (entry.decorators?.includes('@@activate')) {
                candidates.push(candidateEntry(entry, trace, 'decorator'));
                continue;
            }
            if (entry.decorators?.includes('@@dont_activate')) {
                reject(trace, 'Decorator', { reason: '@@dont_activate', outcome: 'decorator-blocked' });
                continue;
            }
            stage(trace, 'Decorator', 'skip', { reason: 'none' });
            if (forced.has(entryRefKey(entryRef(entry)))) {
                candidates.push(candidateEntry(entry, trace, 'forced', true));
                continue;
            }
            if (entry.constant) {
                candidates.push(candidateEntry(entry, trace, 'constant'));
                continue;
            }
            if (sticky) {
                candidates.push(candidateEntry(entry, trace, 'sticky'));
                continue;
            }
            const haystack = buffer.get(entry, state);
            const matches = evaluateKeys(entry, haystack, settings, request.expand, request.parseRegex);
            trace.match = matches;
            if (!matches.matched) {
                reject(trace, 'Keys', {
                    reason: matches.reason,
                    logic: LOGIC_LABEL[matches.logic],
                    outcome: matches.reason,
                });
                continue;
            }
            pass(trace, 'Keys', {
                reason: matches.reason,
                primary: matches.primaryMatch?.expanded,
                logic: LOGIC_LABEL[matches.logic],
            });
            candidates.push(candidateEntry(entry, trace, matches.reason));
        }

        candidates.sort((a, b) => {
            const stickyA = isActive(timed, 'sticky', a.entry) ? 1 : 0;
            const stickyB = isActive(timed, 'sticky', b.entry) ? 1 : 0;
            const indexA = a.external ? -1 : entryOrder.get(a.entry);
            const indexB = b.external ? -1 : entryOrder.get(b.entry);
            return stickyB - stickyA || indexA - indexB;
        });
        round.candidates = candidates.map(candidate => entryId(candidate.entry));
        candidates = filterGroups(
            candidates,
            activated,
            buffer,
            state,
            timed,
            settings,
            request.expand,
            request.parseRegex,
            random,
        );

        let acceptedContent = '';
        const successful = [];
        let remainingIgnored = candidates.filter(candidate => candidate.entry.ignoreBudget).length;
        for (let index = 0; index < candidates.length; index++) {
            checkAbort(signal);
            const candidate = candidates[index];
            const { entry, trace } = candidate;
            const id = entryId(entry);
            if (entry.ignoreBudget) {
                remainingIgnored--;
            }
            if (overflowed && !entry.ignoreBudget) {
                stage(trace, 'Probability', 'skip', { reason: 'budget-already-overflowed' });
                reject(trace, 'Token budget', {
                    reason: 'budget-already-overflowed',
                    limit: budget,
                    outcome: 'budget-rejected',
                });
                if (remainingIgnored <= 0) {
                    for (const rest of candidates.slice(index + 1)) {
                        stage(rest.trace, 'Probability', 'skip', { reason: 'scan-stopped-after-overflow' });
                        stage(rest.trace, 'Token budget', 'skip', { reason: 'scan-stopped-after-overflow' });
                        rest.trace.outcome = 'not-evaluated-after-overflow';
                    }
                    break;
                }
                continue;
            }
            const probabilityResult = probability(entry, isActive(timed, 'sticky', entry), random);
            if (!probabilityResult.passed) {
                failedProbability.add(entry);
                reject(trace, 'Probability', { ...probabilityResult, outcome: 'probability-rejected' });
                continue;
            }
            pass(trace, 'Probability', probabilityResult);
            entry.content = String(request.expand(entry.content, `entry:${entryRefKey(entryRef(entry))}:content`) ?? '');
            const nextContent = `${acceptedContent}${entry.content}\n`;
            const [previousTokens, candidateTokens] = await Promise.all([
                tokenCount(acceptedContent + allActivatedText),
                tokenCount(nextContent + allActivatedText),
            ]);
            const budgetDetail = {
                ignored: Boolean(entry.ignoreBudget),
                before: previousTokens,
                after: candidateTokens,
                delta: candidateTokens - previousTokens,
                limit: budget,
            };
            if (!entry.ignoreBudget && candidateTokens >= budget) {
                overflowed = true;
                reject(trace, 'Token budget', {
                    ...budgetDetail,
                    reason: 'limit-reached',
                    outcome: 'budget-rejected',
                });
                continue;
            }
            pass(trace, 'Token budget', budgetDetail);
            trace.outcome = 'activated';
            acceptedContent = nextContent;
            successful.push(entry);
            activated.add(entry);
            round.activated.push(id);
        }
        if (acceptedContent) {
            allActivatedText = acceptedContent + allActivatedText;
        }

        const recursionEntries = successful.filter(entry => !entry.preventRecursion);
        let nextState = SCAN_STATE.NONE;
        if (settings.recursive && !overflowed && recursionEntries.length) {
            nextState = SCAN_STATE.RECURSION;
        }
        if (settings.recursive && !overflowed && state === SCAN_STATE.MIN_ACTIVATIONS && buffer.hasRecursion()) {
            nextState = SCAN_STATE.RECURSION;
        }
        const minimumMissing = Number(settings.minActivations) > 0
            && activated.size < Number(settings.minActivations);
        if (!nextState && !overflowed && minimumMissing) {
            const maximumReached = (
                Number(settings.minActivationsDepthMax) > 0
                && buffer.getDepth() >= Number(settings.minActivationsDepthMax)
            ) || buffer.getDepth() >= buffer.messages.length;
            if (!maximumReached) {
                nextState = SCAN_STATE.MIN_ACTIVATIONS;
                buffer.advance();
            }
        }
        if (settings.recursive && state === SCAN_STATE.RECURSION && !nextState && delayedLevels.length) {
            nextState = SCAN_STATE.RECURSION;
            currentDelayLevel = delayedLevels.shift();
        }
        if (nextState) {
            const recursiveText = recursionEntries.map(entry => entry.content).join('\n');
            buffer.addRecursion(recursiveText);
        }
        round.nextState = nextState;
        round.nextStateLabel = SCAN_STATE_LABEL[nextState];
        state = nextState;
    }

    const accepted = [...activated];
    const placements = buildPlacements(accepted, request.processRegex);
    const usedTokens = await tokenCount(allActivatedText);
    const warnings = [...(request.warnings ?? [])];
    if (request.volatileMacros?.size) {
        const count = request.volatileMacros.size;
        warnings.push(count === 1
            ? '1 changing macro value, such as random or time, was evaluated once and kept fixed for this scan.'
            : `${count} changing macro values, such as random or time, were evaluated once and kept fixed for this scan.`);
    }
    if (request.unfrozenMacros?.size) {
        warnings.push('Experimental variable shorthand macros cannot be frozen reliably, so this scan cannot be saved as a replay test.');
    }
    const fingerprintSource = {
        seed: request.seed,
        messages: request.messages,
        settings,
        activated: accepted.map(entryRef),
        placements: placements.records.map(record => ({
            id: record.id,
            hash: record.hash,
            position: record.position,
            placementStatus: record.placementStatus,
            renderedContent: record.renderedContent,
        })),
        budget: { limit: budget, used: usedTokens, overflowed },
    };
    const macroSnapshot = request.macroSnapshot instanceof Map
        ? Object.fromEntries(request.macroSnapshot)
        : { ...(request.macroSnapshot ?? {}) };
    return {
        kind: 'simulated',
        fingerprint: stableFingerprint(fingerprintSource),
        seed: request.seed,
        input: {
            mode: request.mode,
            messages: [...(request.messages ?? [])],
            trigger: request.trigger,
            maxContext: request.maxContext,
        },
        settings: { ...settings },
        budget: { limit: budget, used: usedTokens, overflowed },
        rounds,
        traces,
        activated: accepted.map(entry => ({
            id: entryId(entry),
            hash: String(entry.hash ?? ''),
            world: entry.world,
            uid: entry.uid,
            label: entry.comment || `Entry ${entry.uid}`,
            activationReason: [...traces].reverse().find(trace => (
                trace.entryIndex === entryOrder.get(entry) && trace.outcome === 'activated'
            ))?.activationReason ?? '',
        })),
        placements,
        macroSnapshot,
        replay: {
            schemaVersion: 2,
            macroEngine: request.macroEngine ?? 'legacy',
            macroReplaySafe: !request.unfrozenMacros?.size,
            sourcePlan: structuredClone(request.sourcePlan ?? null),
            mode: request.mode,
            messages: [...(request.messages ?? [])],
            injections: [...(request.injections ?? [])],
            settings: { ...settings },
            maxContext: request.maxContext,
            trigger: request.trigger,
            seed: request.seed,
            forcedRefs: [...forcedRefs.values()].map(reference => structuredClone(reference)),
            timedEffects: {
                sticky: [...timed.sticky].map(key => JSON.parse(key)).map(([id, hash]) => ({ id, hash })),
                cooldown: [...timed.cooldown].map(key => JSON.parse(key)).map(([id, hash]) => ({ id, hash })),
                delay: [...timed.delay].map(key => JSON.parse(key)).map(([id, hash]) => ({ id, hash })),
            },
            character: structuredClone(request.character ?? {}),
            globalScanData: structuredClone(request.globalScanData ?? {}),
            macroSnapshot,
        },
        warnings,
    };
}
