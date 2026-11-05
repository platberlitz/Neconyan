// Embedded portraits travel with persona cards and saved messages.
export const MAX_SCENARIO_AVATAR_LENGTH = 96 * 1024;

/** Keep detail for enlarged portraits, reducing dimensions only to fit the saved-data budget. */
export async function fitScenarioAvatar(width, height, encode) {
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
        throw new Error('Invalid Scenario Note image dimensions');
    }
    let previousSize = '';
    for (const edge of [1024, 768, 512, 384, 256, 128]) {
        const scale = Math.min(edge / width, edge / height, 1);
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const size = `${w}x${h}`;
        if (size === previousSize) continue;
        previousSize = size;
        const avatar = normalizeScenarioAvatar(await encode(w, h));
        if (avatar) return avatar;
    }
    throw new Error('The Scenario Note portrait could not fit its storage limit');
}

export async function createScenarioAvatar(dataUrl) {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    return fitScenarioAvatar(image.naturalWidth, image.naturalHeight, (width, height) => {
        canvas.width = width;
        canvas.height = height;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, width, height);
        return canvas.toDataURL('image/webp', 0.85);
    });
}

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
