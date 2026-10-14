// speaker-exclusions.js - names that are never treated as colourable characters.
// A card named Narrator is a message author but not a speaker whose dialogue
// should get its own colour.
import { normalizeRegistryIdentity } from './group-profiles.js';
import { settings } from './state.js';

export function isNarratorCardSkipped() {
    return settings.skipNarratorCard !== false;
}

export function isExcludedSpeakerName(name) {
    const identity = normalizeRegistryIdentity(String(name ?? ''));
    if (!identity) return false;
    if (identity === 'narrator') return isNarratorCardSkipped();
    return false;
}

// Names the colouring prompt should tell the model to leave plain. Narrator is
// left out while the Narration style is on, because that style owns the name.
export function getPromptExcludedSpeakerNames({ narratorStyled = false } = {}) {
    const names = [];
    if (isNarratorCardSkipped() && !narratorStyled) names.push('Narrator');
    return names;
}

export function isExcludedCharacterEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return isExcludedSpeakerName(entry.name);
}
