// Small embedded portraits travel with persona cards and saved messages.
export const MAX_SCENARIO_AVATAR_LENGTH = 96 * 1024;

export function normalizeScenarioAvatar(value) {
    return typeof value === 'string' && value.length <= MAX_SCENARIO_AVATAR_LENGTH
        && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
        ? value : '';
}

/** The first active note with a portrait wins, in the visible note order. */
export function getScenarioAvatar(appendices, activeIds) {
    const selected = new Set(activeIds);
    for (const note of appendices ?? []) {
        if (!selected.has(note.id)) continue;
        const avatar = normalizeScenarioAvatar(note.avatar);
        if (avatar) return avatar;
    }
    return '';
}
