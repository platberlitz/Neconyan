import { roleplayError } from '../roleplay-store.js';

const invalid = message => { throw roleplayError('QIG_INVALID_FILTER', message, 409); };
const DEFAULT_POOL = 'qig_pool_default_global';
const SCOPE_RANK = { global: 0, char: 1, card: 2 };
const priority = filter => Number.isFinite(Number(filter.priority)) ? Math.trunc(Number(filter.priority)) : 0;
const order = filter => Number.isFinite(Number(filter.sortOrder)) && Number(filter.sortOrder) >= 0
    ? Math.trunc(Number(filter.sortOrder)) : Number.MAX_SAFE_INTEGER;
export const sortImageFilters = filters => [...filters].sort((a, b) => priority(b) - priority(a)
    || SCOPE_RANK[b.scope || 'global'] - SCOPE_RANK[a.scope || 'global']
    || order(a) - order(b) || String(a.id || '').localeCompare(String(b.id || '')));

function ids(value) {
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))] : [];
}

function activeFilters(settings, snapshot) {
    const records = settings._backupContextualFilters;
    if (records === undefined) return [];
    if (!Array.isArray(records) || records.length > 1000) invalid('The saved image filters are invalid.');
    const avatar = String(snapshot.speaker?.avatar || snapshot.macros?.extra?.characterAvatar || '').trim().toLowerCase();
    const cardPools = settings._backupActiveFilterPoolIdsByCard;
    const charPools = settings._backupActiveFilterPoolIdsByChar;
    const globalPools = settings._backupActiveFilterPoolIdsGlobal;
    const pools = new Set(ids(globalPools === undefined ? [DEFAULT_POOL] : globalPools));
    if (cardPools && typeof cardPools !== 'object') invalid('The saved card filter pools are invalid.');
    if (charPools && typeof charPools !== 'object') invalid('The saved character filter pools are invalid.');
    for (const id of ids(cardPools?.[avatar])) pools.add(id);
    const savedCharId = snapshot.quickImageGenCharacterId;
    if (savedCharId !== undefined && savedCharId !== null) {
        for (const id of ids(charPools?.[String(savedCharId)])) pools.add(id);
    }
    return sortImageFilters(records.filter(filter => {
        if (!filter || typeof filter !== 'object' || Array.isArray(filter)) invalid('A saved image filter is invalid.');
        if (filter.enabled === false) return false;
        const scope = filter.scope || 'global';
        if (!Object.hasOwn(SCOPE_RANK, scope)) invalid('A saved image filter has an unknown scope.');
        if (scope === 'card') {
            if (!filter.cardKey || typeof filter.cardKey !== 'string') invalid('A saved card filter has no card identity.');
            if (filter.cardKey.trim().toLowerCase() !== avatar) return false;
        }
        if (scope === 'char') {
            if (filter.charId === undefined || filter.charId === null || !String(filter.charId).trim()) {
                invalid('A saved character filter has no character identity.');
            }
            if (savedCharId === undefined || savedCharId === null) {
                invalid('A saved character filter needs a bound browser roster ID before it can run server-side.');
            }
            if (String(filter.charId) !== String(savedCharId)) return false;
        }
        const filterPools = ids(filter.poolIds);
        return (filterPools.length ? filterPools : [DEFAULT_POOL]).some(id => pools.has(id));
    }));
}

function resolveFilter(filter, macroEnvironment) {
    const fields = ['name', 'description', 'keywords', 'positive', 'negative', 'removePositive', 'removeNegative'];
    const resolved = { ...filter };
    for (const field of fields) {
        if (filter[field] !== undefined && typeof filter[field] !== 'string') invalid('A saved image filter field is not text.');
        resolved[field] = macroEnvironment.evaluate(filter[field] || '', { strictCapabilities: true }).trim();
    }
    return resolved;
}

function enrichScene(sceneText, snapshot) {
    const characters = [snapshot.macros?.names?.char].filter(Boolean);
    const description = String(snapshot.macros?.character?.description || snapshot.macros?.extra?.character?.description || '').slice(0, 1800);
    const persona = String(snapshot.macros?.character?.persona || '').slice(0, 600);
    const user = String(snapshot.macros?.names?.user || 'User');
    const additions = [];
    if (characters.length && !sceneText.includes(`Characters: ${characters.join(', ')}`)) additions.push(`Characters: ${characters.join(', ')}`);
    if (description && !sceneText.includes(description)) additions.push(`Character profiles:\n${description}`);
    if (persona && !sceneText.includes(persona)) additions.push(`${user} profile: ${persona}`);
    return [sceneText, ...additions].filter(Boolean).join('\n\n');
}

function tokenIdentity(value) {
    const text = String(value).trim().replace(/\s+/g, ' ').toLowerCase();
    const lora = text.match(/^<lora:([^:>]+):[^>]+>$/);
    return lora ? `<lora:${lora[1]}>` : text;
}

function split(value) {
    return String(value || '').split(',').map(token => token.trim()).filter(Boolean);
}

function removeTokens(value, removals) {
    const identities = new Set(split(removals).map(tokenIdentity));
    if (!identities.size) return { value, removed: [] };
    const kept = [];
    const removed = [];
    for (const token of split(value)) (identities.has(tokenIdentity(token)) ? removed : kept).push(token);
    return { value: removed.length ? kept.join(', ') : value, removed };
}

function append(value, extra) {
    return [value, extra].filter(Boolean).join(', ');
}

export function applyMatchedImageFilters(prompt, negative, filters) {
    let positive = prompt;
    let exclusion = negative;
    for (const filter of filters) {
        const withoutPositive = removeTokens(positive, filter.removePositive);
        const withoutNegative = removeTokens(exclusion, filter.removeNegative);
        positive = withoutPositive.value;
        exclusion = withoutNegative.value;
        if (filter.removeMode === 'moveToNegative') exclusion = append(exclusion, withoutPositive.removed.join(', '));
        positive = append(positive, filter.positive);
        exclusion = append(exclusion, filter.negative);
    }
    return { prompt: positive, negative: exclusion };
}

export function imageFilterSeedOverride(filters) {
    for (const filter of filters) {
        const raw = filter.seedOverride;
        if (raw === null || raw === undefined || raw === '') continue;
        const seed = Number(raw);
        if (Number.isSafeInteger(seed) && seed >= 0 && seed <= 4294967295) return seed;
    }
    return null;
}

/** Match only saved account filters against the protected Conversation participant and scene. */
export function resolveSavedImageFilters(settings, snapshot, sceneText, macroEnvironment) {
    const sorted = activeFilters(settings, snapshot).map(filter => resolveFilter(filter, macroEnvironment));
    const scene = enrichScene(sceneText, snapshot);
    const candidates = sorted.filter(filter => filter.matchMode !== 'LLM' && filter.enabled !== false);
    const matched = candidates.filter(filter => {
        const keywords = split(filter.keywords).map(keyword => keyword.toLowerCase());
        if (!keywords.length) return false;
        const text = scene.toLowerCase();
        return filter.matchMode === 'OR' ? keywords.some(keyword => text.includes(keyword))
            : keywords.every(keyword => text.includes(keyword));
    });
    const andMatches = matched.filter(filter => filter.matchMode !== 'OR');
    const active = matched.filter(filter => {
        if (filter.matchMode !== 'OR') return true;
        const keywords = new Set(split(filter.keywords).map(keyword => keyword.toLowerCase()));
        return !andMatches.some(and => priority(and) >= priority(filter)
            && [...keywords].every(keyword => split(and.keywords).some(value => value.toLowerCase() === keyword)));
    });
    return { keyword: active, llm: sorted.filter(filter => filter.matchMode === 'LLM' && filter.enabled !== false
        && filter.description), scene };
}
