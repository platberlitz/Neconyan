import { getStringHash } from './macro-primitives.js';
import { normalizeWorldInfoPosition } from './world-info-character-book.js';

/**
 * Normalizes probability fields from native and CharacterBook-shaped entries.
 * @param {object} entry World Info entry
 * @returns {object} Entry with native probability fields
 */
export function normalizeWorldInfoProbability(entry) {
    const rawProbability = entry.probability ?? entry.extensions?.probability ?? 100;
    const probability = Number(rawProbability);
    return {
        ...entry,
        probability: Number.isFinite(probability) ? probability : 100,
        useProbability: entry.useProbability ?? entry.extensions?.useProbability ?? true,
    };
}

/**
 * Tests whether an entry passes its probability check.
 * @param {object} entry Normalized World Info entry
 * @param {() => number} random Random source returning a value in [0, 1)
 * @param {boolean} isSticky Whether the entry is currently sticky
 * @returns {boolean} Whether the entry passes
 */
export function passesWorldInfoProbability(entry, random = Math.random, isSticky = false) {
    if (!entry.useProbability || isSticky) {
        return true;
    }

    const probability = Number(entry.probability);
    if (!Number.isFinite(probability) || probability >= 100) {
        return true;
    }
    if (probability <= 0) {
        return false;
    }

    return random() * 100 < probability;
}

/**
 * Substitutes and trims a World Info key.
 * @param {unknown} key Raw key
 * @param {(value: string) => string} substitute Substitution function
 * @returns {string|null} A usable key, or null when empty
 */
export function normalizeWorldInfoKey(key, substitute) {
    if (typeof key !== 'string') {
        return null;
    }

    const normalized = substitute(key)?.trim();
    return normalized || null;
}

/**
 * Parses an entry's comma-separated inclusion groups.
 * @param {unknown} group Raw group field
 * @returns {string[]} Trimmed unique group names
 */
export function getWorldInfoGroupNames(group) {
    if (typeof group !== 'string') {
        return [];
    }

    return [...new Set(group.split(',').map(value => value.trim()).filter(Boolean))];
}

/**
 * Computes the persisted activity window for a World Info timed effect.
 * @param {number} chatLength Chat length when the effect is created
 * @param {number} duration Effect duration in messages
 * @returns {{ start: number, end: number }} Effect window
 */
export function getTimedEffectWindow(chatLength, duration) {
    return {
        start: chatLength,
        end: chatLength + Number(duration),
    };
}

/** Advance the saved sticky/cooldown windows once, before scanning this chat length. */
export function resolveWorldInfoTimedEffects(entries, chatLength, timedWorldInfo = {}, dryRun = false) {
    const metadata = structuredClone(timedWorldInfo);
    const active = { sticky: new Set(), cooldown: new Set(), delay: new Set() };
    const identity = entry => `${entry.world}.${entry.uid}`;
    for (const type of ['sticky', 'cooldown']) {
        if (!metadata[type] || typeof metadata[type] !== 'object' || Array.isArray(metadata[type])) metadata[type] = {};
    }
    for (const type of ['sticky', 'cooldown']) {
        for (const [key, effect] of Object.entries(metadata[type])) {
            if (!effect || typeof effect !== 'object' || Array.isArray(effect)) { delete metadata[type][key]; continue; }
            if (dryRun) continue;
            const entry = entries.find(value => String(value.hash) === String(effect.hash));
            if (chatLength <= Number(effect.start) && !effect.protected || entry && !entry[type]) {
                delete metadata[type][key];
                continue;
            }
            if (chatLength >= Number(effect.end)) {
                delete metadata[type][key];
                if (type === 'sticky' && entry?.cooldown) {
                    const window = getTimedEffectWindow(chatLength, entry.cooldown);
                    metadata.cooldown[identity(entry)] = { hash: entry.hash, ...window, protected: true };
                    active.cooldown.add(entry.hash);
                }
                continue;
            }
            if (entry) active[type].add(entry.hash);
        }
    }
    for (const entry of entries) if (entry.delay && chatLength < entry.delay) active.delay.add(entry.hash);
    return { metadata, active };
}

/** Apply a completed scan's windows to a copy of chat metadata. */
export function applyWorldInfoTimedEffects(metadata, activated, chatLength) {
    metadata = structuredClone(metadata);
    for (const type of ['sticky', 'cooldown']) {
        metadata[type] ??= {};
        for (const entry of activated) {
            if (!entry[type]) continue;
            const key = `${entry.world}.${entry.uid}`;
            metadata[type][key] ??= { hash: entry.hash, ...getTimedEffectWindow(chatLength, entry[type]), protected: false };
        }
    }
    return metadata;
}

/** Order and normalize entries using the same identities as the browser's timed windows. */
export function prepareWorldInfoEntries({ globalLore = [], characterLore = [], chatLore = [], personaLore = [] },
                                        strategy = 1) {
    const order = (a, b) => b.order - a.order;
    let ordinary = [...globalLore, ...characterLore].sort(order);
    if (strategy === 1) ordinary = [...characterLore.sort(order), ...globalLore.sort(order)];
    if (strategy === 2) ordinary = [...globalLore.sort(order), ...characterLore.sort(order)];
    const positions = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };
    return [...chatLore.sort(order), ...personaLore.sort(order), ...ordinary].map(entry => {
        const lines = (entry.content || '').split(/\r?\n/);
        const decorators = [];
        let content = entry.content || '';
        if (content.startsWith('@@')) {
            let fallback = false;
            content = '';
            for (let index = 0; index < lines.length; index++) {
                const line = lines[index];
                if (!line.startsWith('@@')) { content = lines.slice(index).join('\n'); break; }
                if (line.startsWith('@@@') && !fallback) continue;
                const decorator = line.startsWith('@@@') ? line.slice(1) : line;
                if (['@@activate', '@@dont_activate'].some(value => decorator.startsWith(value))) {
                    decorators.push(decorator);
                    fallback = false;
                } else {
                    fallback = true;
                }
            }
        }
        const decorated = { ...entry, decorators, content };
        const hash = getStringHash(JSON.stringify(decorated));
        return normalizeWorldInfoProbability({ ...decorated, hash,
            position: normalizeWorldInfoPosition(entry.position, positions) ?? positions.before });
    });
}

/** Resolve one scan pass's inclusion groups without browser state. Mutates candidates like the browser scan. */
export function filterWorldInfoInclusionGroups(candidates, activated, {
    score, isEffectActive, groupScoring = false, scanState, random = Math.random, defaultWeight = 100,
}) {
    const groups = candidates.filter(entry => entry.group).reduce((result, entry) => {
        for (const name of getWorldInfoGroupNames(entry.group)) (result[name] ??= []).push(entry);
        return result;
    }, Object.create(null));
    const remove = entry => {
        const index = candidates.indexOf(entry);
        if (index !== -1) candidates.splice(index, 1);
        for (const group of Object.values(groups)) {
            const groupIndex = group.indexOf(entry);
            if (groupIndex !== -1) group.splice(groupIndex, 1);
        }
    };
    const keep = (group, winner) => { for (const entry of [...group]) if (entry !== winner) remove(entry); };
    const stickyGroups = new Set();

    for (const [name, group] of Object.entries(groups)) {
        const sticky = group.filter(entry => isEffectActive('sticky', entry));
        if (sticky.length) {
            for (const entry of [...group]) if (!sticky.includes(entry)) remove(entry);
            stickyGroups.add(name);
        }
        for (const entry of [...groups[name]]) {
            if (isEffectActive('cooldown', entry) || isEffectActive('delay', entry)) remove(entry);
        }
    }

    for (const [name, group] of Object.entries(groups)) {
        if (!group.length || stickyGroups.has(name) || !(groupScoring || group.some(entry => entry.useGroupScoring))) continue;
        const highest = Math.max(...group.map(entry => score(entry, scanState)));
        for (const entry of [...group]) {
            if ((entry.useGroupScoring ?? groupScoring) && score(entry, scanState) < highest) remove(entry);
        }
    }

    for (const [name, group] of Object.entries(groups)) {
        if (!group.length || stickyGroups.has(name)) continue;
        if ([...activated].some(entry => getWorldInfoGroupNames(entry.group).includes(name))) { keep(group, null); continue; }
        if (group.length <= 1) continue;
        const priority = group.filter(entry => entry.groupOverride).sort((a, b) => b.order - a.order);
        if (priority.length) { keep(group, priority[0]); continue; }
        const total = group.reduce((sum, entry) => sum + (entry.groupWeight ?? defaultWeight), 0);
        const roll = random() * total;
        let weight = 0;
        const winner = group.find(entry => (weight += entry.groupWeight ?? defaultWeight) >= roll);
        if (winner) keep(group, winner);
    }
    return candidates;
}

/** The exact key and selective-key checks used by each recursive scan pass. */
export function matchesWorldInfoEntry(entry, text, { substitute = value => value, caseSensitive = false, wholeWords = false } = {}) {
    const match = (key, normalized = false) => {
        if (!normalized) key = normalizeWorldInfoKey(key, substitute);
        if (!key) return false;
        const regex = parseWorldInfoKeyRegex(key);
        if (regex) return regex.test(text);
        const source = (entry.caseSensitive ?? caseSensitive) ? text : text.toLowerCase();
        const needle = (entry.caseSensitive ?? caseSensitive) ? key : key.toLowerCase();
        if (!(entry.matchWholeWords ?? wholeWords)) return source.includes(needle);
        if (/\s/.test(needle)) return source.includes(needle);
        return new RegExp(`(?:^|\\W)(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?:$|\\W)`).test(source);
    };
    if (!Array.isArray(entry.key) || !entry.key.some(match)) return false;
    const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary.map(key => normalizeWorldInfoKey(key, substitute)).filter(Boolean) : [];
    if (!entry.selective || !secondary.length) return true;
    const hits = secondary.map(key => match(key, true));
    switch (entry.selectiveLogic ?? 0) {
        case 0: return hits.some(Boolean);
        case 1: return !hits.every(Boolean);
        case 2: return !hits.some(Boolean);
        case 3: return hits.every(Boolean);
        default: return false;
    }
}

/** Slash-delimited World Info regex, including the browser's escaped-delimiter rule. */
export function parseWorldInfoKeyRegex(input) {
    const match = typeof input === 'string' && input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match || /(^|[^\\])\//.test(match[1])) return null;
    try { return new RegExp(match[1].replace('\\/', '/'), match[2]); } catch { return null; }
}
