import { isExpressionSource } from '../../expression-history.js';

/** Stable, filename-safe storage independent of a persona's editable display name. */
export async function personaExpressionFolder(avatar) {
    if (typeof avatar !== 'string' || !avatar || /[/\\\x00-\x1f]/.test(avatar) || avatar === '.' || avatar === '..') {
        throw new Error('Invalid persona avatar.');
    }
    if (globalThis.crypto?.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(avatar));
        return `__personas/${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    // LAN HTTP pages do not expose Web Crypto. Use the bundled equivalent there.
    const { sha256 } = await import('../../../lib.js');
    return `__personas/${sha256(avatar)}`;
}

/** Selections must belong to this persona's folder, never another card or persona. */
export function personaExpressionSelection(settings, avatar, folder) {
    const src = settings?.[avatar];
    if (src === null) return null;
    if (!isExpressionSource(src)) return undefined;
    try {
        const path = decodeURIComponent(src.split('?')[0]);
        return path.startsWith(`/characters/${folder}/`) && !path.slice(`/characters/${folder}/`.length).match(/[/\\]/)
            ? src : undefined;
    } catch { return undefined; }
}
