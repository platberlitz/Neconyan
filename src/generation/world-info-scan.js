import { applyWorldInfoTimedEffects, filterWorldInfoInclusionGroups, matchesWorldInfoEntry, normalizeWorldInfoKey,
    passesWorldInfoProbability, resolveWorldInfoTimedEffects } from '../../public/scripts/world-info-scan-core.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';

const INITIAL = 1;
const RECURSION = 2;
const MIN_ACTIVATIONS = 3;
const MAX_SCAN_DEPTH = 1000;
const MAX_HOOK_RECORD_BYTES = 2 * 1024 * 1024;

function hookEntry(entry) {
    return { world: String(entry.world ?? ''), uid: entry.uid ?? null, hash: entry.hash ?? null,
        comment: String(entry.comment ?? ''), keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
        position: entry.position ?? null, depth: entry.depth ?? null, order: entry.order ?? null };
}

/** Scan saved entries without browser globals. The caller must save the result before provider dispatch. */
export async function scanWorldInfo({ entries, chat, metadata = {}, settings, global = {}, maxContext,
    countTokens, substitute = value => value, transform = value => value, random = Math.random, onScan = async () => {} }) {
    const sorted = structuredClone(entries);
    const effects = resolveWorldInfoTimedEffects(sorted, chat.length, metadata.timedWorldInfo);
    const active = (type, entry) => effects.active[type].has(entry.hash);
    if (!sorted.length) return { worldInfoBefore: '', worldInfoAfter: '', EMEntries: [], WIDepthEntries: [],
        ANBeforeEntries: [], ANAfterEntries: [], outletEntries: {}, activated: [], chatLength: chat.length,
        timedWorldInfo: effects.metadata, draws: [], iterations: 0, hookEvents: { scanPasses: [], activated: null } };
    let budget = Math.min(maxContext, Math.round(settings.world_info_budget * maxContext / 100) || 1);
    if (settings.world_info_budget_cap > 0) budget = Math.min(budget, settings.world_info_budget_cap);
    if (!Number.isFinite(budget) || budget < 1) throw roleplayError('ROLEPLAY_INVALID', 'World Info needs a valid saved context budget.', 400);
    let state = INITIAL;
    let depth = Number(settings.world_info_depth ?? 2);
    let iterations = 0;
    let overflowed = false;
    let activatedText = '';
    const activated = new Set();
    const failed = new Set();
    const recursion = [];
    const draws = [];
    const scanPasses = [];
    let hookBytes = 0;
    const roll = () => {
        const value = random();
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
            throw roleplayError('ROLEPLAY_INVALID', 'World Info random choices must be finite values from zero to one.', 409);
        }
        draws.push(value);
        return value;
    };
    const delayed = settings.world_info_recursive ? [...new Set(sorted.filter(entry => entry.delayUntilRecursion)
        .map(entry => entry.delayUntilRecursion === true ? 1 : entry.delayUntilRecursion))].sort((a, b) => a - b) : [];
    let currentDelay = delayed.shift() ?? 0;
    const scanText = (entry, phase) => {
        const limit = Math.min(MAX_SCAN_DEPTH, entry.scanDepth ?? depth);
        if (limit < 0) return '';
        const joiner = '\n\x01';
        let text = '\x01' + chat.slice(0, limit).map(value => value.trim()).join(joiner);
        if (limit > 0) for (const [flag, field] of [
            ['matchPersonaDescription', 'personaDescription'], ['matchCharacterDescription', 'characterDescription'],
            ['matchCharacterPersonality', 'characterPersonality'], ['matchCharacterDepthPrompt', 'characterDepthPrompt'],
            ['matchScenario', 'scenario'], ['matchCreatorNotes', 'creatorNotes'],
        ]) if (entry[flag] && global[field]) text += joiner + global[field];
        if (global.inject?.length) text += joiner + global.inject.join(joiner);
        if (recursion.length && phase !== MIN_ACTIVATIONS) text += joiner + recursion.join(joiner);
        return text;
    };
    const score = (entry, phase) => {
        const text = scanText(entry, phase);
        const primaryKeys = Array.isArray(entry.key) ? entry.key.map(key => normalizeWorldInfoKey(key, substitute)).filter(Boolean) : [];
        if (!primaryKeys.length) return 0;
        const primary = primaryKeys.filter(key => matchesWorldInfoEntry({ key: [key] }, text, {
            caseSensitive: entry.caseSensitive ?? settings.world_info_case_sensitive,
            wholeWords: entry.matchWholeWords ?? settings.world_info_match_whole_words,
        })).length;
        const secondaryKeys = Array.isArray(entry.keysecondary)
            ? entry.keysecondary.map(key => normalizeWorldInfoKey(key, substitute)).filter(Boolean) : [];
        const secondary = secondaryKeys.filter(key => matchesWorldInfoEntry({ key: [key] }, text, {
            caseSensitive: entry.caseSensitive ?? settings.world_info_case_sensitive,
            wholeWords: entry.matchWholeWords ?? settings.world_info_match_whole_words,
        }));
        if (!secondary.length) return primary;
        if (entry.selectiveLogic === 0 || entry.selectiveLogic === 3 && secondary.length === secondaryKeys.length) return primary + secondary.length;
        return primary;
    };
    while (state) {
        if (iterations >= MAX_SCAN_DEPTH + sorted.length * 4) {
            throw roleplayError('ROLEPLAY_INVALID', 'A World Info scan hook exceeded the bounded scan limit.', 409);
        }
        if (settings.world_info_max_recursion_steps && iterations >= settings.world_info_max_recursion_steps) break;
        iterations++;
        const candidates = [];
        for (const entry of sorted) {
            if (failed.has(entry) || activated.has(entry) || entry.disable == true
                || Array.isArray(entry.triggers) && entry.triggers.length > 0 && !entry.triggers.includes(global.trigger)) continue;
            if (entry.characterFilter?.names?.length && (entry.characterFilter.isExclude
                ? entry.characterFilter.names.includes(global.characterFile) : !entry.characterFilter.names.includes(global.characterFile))) continue;
            if (entry.characterFilter?.tags?.length && (entry.characterFilter.isExclude
                ? global.characterTags.some(tag => entry.characterFilter.tags.includes(tag))
                : !global.characterTags.some(tag => entry.characterFilter.tags.includes(tag)))) continue;
            const sticky = active('sticky', entry);
            if (active('delay', entry) || active('cooldown', entry) && !sticky
                || state !== RECURSION && entry.delayUntilRecursion && !sticky
                || state === RECURSION && entry.delayUntilRecursion > currentDelay && !sticky
                || state === RECURSION && settings.world_info_recursive && entry.excludeRecursion && !sticky
                || entry.decorators?.includes('@@dont_activate') && !entry.decorators.includes('@@activate')) continue;
            if (entry.decorators?.includes('@@activate') || global.external?.includes(`${entry.world}.${entry.uid}`)
                || entry.constant || sticky || matchesWorldInfoEntry(entry, scanText(entry, state), {
                substitute, caseSensitive: settings.world_info_case_sensitive, wholeWords: settings.world_info_match_whole_words,
            })) candidates.push(entry);
        }
        candidates.sort((a, b) => Number(active('sticky', b)) - Number(active('sticky', a)) || sorted.indexOf(a) - sorted.indexOf(b));
        filterWorldInfoInclusionGroups(candidates, activated, { score, isEffectActive: active,
            groupScoring: settings.world_info_use_group_scoring, scanState: state, random: roll });
        const accepted = [];
        let acceptedContent = '';
        let ignoresBudget = candidates.filter(entry => entry.ignoreBudget).length;
        const previousTokens = await countTokens(activatedText);
        for (const entry of candidates) {
            if (entry.ignoreBudget) ignoresBudget--;
            if (overflowed && !entry.ignoreBudget) {
                if (!ignoresBudget) break;
                continue;
            }
            if (!passesWorldInfoProbability(entry, roll, active('sticky', entry))) { failed.add(entry); continue; }
            const content = substitute(entry.content || '');
            const next = acceptedContent + content + '\n';
            if (!entry.ignoreBudget && previousTokens + await countTokens(next) >= budget) { overflowed = true; continue; }
            entry.content = content;
            acceptedContent = next;
            accepted.push(entry);
            activated.add(entry);
        }
        const fresh = accepted.filter(entry => !entry.preventRecursion);
        if (acceptedContent) activatedText = acceptedContent + activatedText;
        let next = settings.world_info_recursive && !overflowed && fresh.length ? RECURSION : 0;
        if (settings.world_info_recursive && !overflowed && state === MIN_ACTIVATIONS && recursion.length) next = RECURSION;
        if (!next && !overflowed && settings.world_info_min_activations > activated.size
            && (!settings.world_info_min_activations_depth_max || depth < settings.world_info_min_activations_depth_max)
            && depth < chat.length) { next = MIN_ACTIVATIONS; depth++; }
        if (settings.world_info_recursive && state === RECURSION && !next && delayed.length) {
            next = RECURSION;
            currentDelay = delayed.shift();
        }
        const previous = state;
        state = next;
        if (state && fresh.length) recursion.push(fresh.map(entry => entry.content).join('\n'));
        const hook = { state: { current: previous, next: state, loopCount: iterations },
            new: { all: candidates, successful: accepted }, activated: { entries: activated, text: activatedText },
            sortedEntries: sorted, recursionDelay: { availableLevels: delayed, currentLevel: currentDelay },
            budget: { current: budget, overflowed }, timedEffects: effects };
        const entryHash = roleplayHash(sorted);
        const activeEntries = [...activated];
        const timedHash = roleplayHash(effects.metadata);
        const activeTimed = Object.fromEntries(Object.entries(effects.active).map(([type, entries]) => [type, [...entries]]));
        const remainingDelay = [...delayed];
        const savedDelay = currentDelay;
        await onScan(hook);
        if (roleplayHash(sorted) !== entryHash || !Array.isArray(hook.sortedEntries) || hook.sortedEntries.length !== sorted.length
            || hook.state.current !== previous || hook.state.loopCount !== iterations
            || hook.sortedEntries.some((entry, index) => entry !== sorted[index])
            || !(hook.activated.entries instanceof Set) || hook.activated.entries.size !== activeEntries.length
            || [...hook.activated.entries].some((entry, index) => entry !== activeEntries[index])
            || !Array.isArray(hook.new.all) || hook.new.all.length !== candidates.length
            || hook.new.all.some((entry, index) => entry !== candidates[index])
            || !Array.isArray(hook.new.successful) || hook.new.successful.length !== accepted.length
            || hook.new.successful.some((entry, index) => entry !== accepted[index])
            || hook.timedEffects !== effects || roleplayHash(effects.metadata) !== timedHash
            || Object.entries(activeTimed).some(([type, entries]) => !(effects.active[type] instanceof Set)
                || effects.active[type].size !== entries.length || entries.some(value => !effects.active[type].has(value)))
            || hook.recursionDelay.currentLevel !== savedDelay
            || hook.recursionDelay.availableLevels !== delayed
            || delayed.length !== remainingDelay.length || delayed.some((value, index) => value !== remainingDelay[index])
            || ![INITIAL, RECURSION, MIN_ACTIVATIONS, 0].includes(hook.state.next)
            || !Number.isFinite(hook.budget.current) || hook.budget.current < 1 || hook.budget.current > maxContext
            || typeof hook.budget.overflowed !== 'boolean' || typeof hook.activated.text !== 'string') {
            throw roleplayError('ROLEPLAY_INVALID', 'A World Info scan hook returned an invalid scan state.', 409);
        }
        if (hook.activated.text !== activatedText && await countTokens(hook.activated.text) > maxContext) {
            throw roleplayError('ROLEPLAY_INVALID', 'A World Info scan hook exceeded the saved context limit.', 409);
        }
        state = hook.state.next;
        activatedText = hook.activated.text;
        currentDelay = hook.recursionDelay.currentLevel;
        budget = hook.budget.current;
        overflowed = hook.budget.overflowed;
        const pass = { state: { ...hook.state }, all: candidates.map(hookEntry), successful: accepted.map(hookEntry),
            activated: [...activated].map(hookEntry), activatedTextHash: roleplayHash(activatedText),
            budget: { current: budget, overflowed }, drawCount: draws.length,
            recursionDelay: { availableLevels: [...delayed], currentLevel: currentDelay } };
        hookBytes += Buffer.byteLength(JSON.stringify(pass));
        if (hookBytes > MAX_HOOK_RECORD_BYTES) {
            throw roleplayError('ROLEPLAY_INVALID', 'The World Info scan hook record exceeds its saved limit.', 409);
        }
        scanPasses.push(pass);
    }
    const activatedEntries = [...activated].sort((a, b) => b.order - a.order);
    const output = { worldInfoBefore: [], worldInfoAfter: [], EMEntries: [], WIDepthEntries: [],
        ANBeforeEntries: [], ANAfterEntries: [], outletEntries: Object.create(null) };
    for (const entry of activatedEntries) {
        const content = transform(entry.content, entry);
        if (!content) continue;
        switch (entry.position) {
            case 0: output.worldInfoBefore.unshift(content); break;
            case 1: output.worldInfoAfter.unshift(content); break;
            case 2: output.ANBeforeEntries.unshift(content); break;
            case 3: output.ANAfterEntries.unshift(content); break;
            case 4: {
                const depth = entry.depth ?? 4;
                const role = entry.role ?? 0;
                const found = output.WIDepthEntries.find(value => value.depth === depth && value.role === role);
                if (found) found.entries.unshift(content);
                else output.WIDepthEntries.push({ depth, role, entries: [content] });
                break;
            }
            case 5: output.EMEntries.unshift({ position: 0, content }); break;
            case 6: output.EMEntries.unshift({ position: 1, content }); break;
            case 7: if (entry.outletName) (output.outletEntries[entry.outletName] ??= []).unshift(content); break;
        }
    }
    output.worldInfoBefore = output.worldInfoBefore.join('\n');
    output.worldInfoAfter = output.worldInfoAfter.join('\n');
    const activation = activatedEntries.map(entry => ({
        world: entry.world, uid: entry.uid, hash: entry.hash,
        title: String(entry.comment ?? '').trim() || String(Array.isArray(entry.key) && entry.key[0] || entry.uid),
        content: String(entry.content ?? ''),
        ...(entry.automationId ? { automationId: entry.automationId } : {}),
    }));
    return { ...output, activated: activation,
        chatLength: chat.length, timedWorldInfo: applyWorldInfoTimedEffects(effects.metadata, activatedEntries, chat.length),
        draws, iterations, hookEvents: { scanPasses, activated: activation.length ? activation : null } };
}
