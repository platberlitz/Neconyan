// speaker-exclusions.js - names that are never treated as colourable characters.
// A card named Narrator, a scenario card ("Your Wife Wants To Divorce You") or a
// card name with a title ("Leonard | Actor") is a message author but not a speaker
// whose dialogue should get its own colour.
import { normalizeRegistryIdentity, normalizeRegistryIdentityName } from './group-profiles.js';
import { settings } from './state.js';

export const MAX_EXCLUDED_SPEAKER_NAMES = 200;

export function normalizeExcludedSpeakerNames(value) {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const names = [];
    for (const item of source) {
        if (typeof item !== 'string') continue;
        const name = normalizeRegistryIdentityName(item);
        const identity = name.toLowerCase();
        if (!name || identity === 'narrator' || seen.has(identity)) continue;
        seen.add(identity);
        names.push(name);
        if (names.length >= MAX_EXCLUDED_SPEAKER_NAMES) break;
    }
    return names;
}

export function getExcludedSpeakerNames() {
    return normalizeExcludedSpeakerNames(settings.excludedSpeakerNames);
}

export function isNarratorCardSkipped() {
    return settings.skipNarratorCard !== false;
}

export function isExcludedSpeakerName(name) {
    const identity = normalizeRegistryIdentity(String(name ?? ''));
    if (!identity) return false;
    if (identity === 'narrator') return isNarratorCardSkipped();
    return getExcludedSpeakerNames().some(candidate => candidate.toLowerCase() === identity);
}

// Names the colouring prompt should tell the model to leave plain. Narrator is
// left out while the Narration style is on, because that style owns the name.
export function getPromptExcludedSpeakerNames({ narratorStyled = false } = {}) {
    const names = getExcludedSpeakerNames();
    if (isNarratorCardSkipped() && !narratorStyled) names.unshift('Narrator');
    return names;
}

export function addExcludedSpeakerName(name) {
    const normalized = normalizeRegistryIdentityName(String(name ?? ''));
    if (!normalized) return false;
    if (normalized.toLowerCase() === 'narrator') {
        if (isNarratorCardSkipped()) return false;
        settings.skipNarratorCard = true;
        return true;
    }
    if (isExcludedSpeakerName(normalized)) return false;
    const next = normalizeExcludedSpeakerNames([...getExcludedSpeakerNames(), normalized]);
    if (next.length === getExcludedSpeakerNames().length) return false;
    settings.excludedSpeakerNames = next;
    return true;
}

export function removeExcludedSpeakerName(name) {
    const identity = normalizeRegistryIdentity(String(name ?? ''));
    if (!identity) return false;
    if (identity === 'narrator') {
        if (!isNarratorCardSkipped()) return false;
        settings.skipNarratorCard = false;
        return true;
    }
    const current = getExcludedSpeakerNames();
    const next = current.filter(candidate => candidate.toLowerCase() !== identity);
    if (next.length === current.length) return false;
    settings.excludedSpeakerNames = next;
    return true;
}

export function isExcludedCharacterEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return isExcludedSpeakerName(entry.name);
}
