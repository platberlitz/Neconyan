// Scenario Note portraits are saved as original image files. Older notes can still carry an
// embedded portrait inside the saved-data budget, and those keep working unchanged.
export const MAX_SCENARIO_AVATAR_LENGTH = 96 * 1024;
export const SCENARIO_AVATAR_FOLDER = 'persona-notes';

const DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const PATH_PATTERN = /^\/user\/images\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif)$/i;

/** Split a portable embedded portrait into its MIME type and bytes, without decoding them. */
export function parseScenarioAvatarDataUrl(value) {
    const match = typeof value === 'string' ? DATA_URL_PATTERN.exec(value) : null;
    if (!match) {
        return null;
    }
    return {
        type: match[1],
        extension: match[1] === 'jpeg' ? 'jpg' : match[1],
        base64: match[2],
    };
}

/** A saved picture must stay inside this account's user images folder and use an image extension. */
export function isScenarioAvatarPath(value) {
    if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/user/images/') || !PATH_PATTERN.test(value)) {
        return false;
    }
    return !value.split('/').some(part => part === '.' || part === '..');
}

export function normalizeScenarioAvatar(value) {
    if (typeof value === 'string' && value.length <= MAX_SCENARIO_AVATAR_LENGTH && parseScenarioAvatarDataUrl(value)) {
        return value;
    }
    return isScenarioAvatarPath(value) ? value : '';
}

/** Persona cards travel between accounts, so they can only carry the picture inside the file. */
export function normalizePortableScenarioAvatar(value) {
    return typeof value === 'string' && parseScenarioAvatarDataUrl(value) ? value : '';
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
