/**
 * The theme registry. Every entry is a partial token object; resolveTheme fills the rest
 * from BASE_TOKENS, so a theme only declares what makes it distinct.
 */

import { CUTE_FLOWERY } from './cute-flowery.js';
import { TECH_TERMINAL } from './tech-terminal.js';
import { RETRO_PRINT } from './retro-print.js';
import { FANTASY_BOLD } from './fantasy-bold.js';
import { ANIMATED } from './animated.js';
import { ADAPTIVE } from './adaptive.js';

export const THEMES = Object.freeze([
    ...CUTE_FLOWERY,
    ...TECH_TERMINAL,
    ...RETRO_PRINT,
    ...FANTASY_BOLD,
    ...ANIMATED,
    ...ADAPTIVE,
]);

export const FAMILIES = Object.freeze([
    { id: 'cute', label: 'Cute & Soft' },
    { id: 'flowery', label: 'Flowery & Botanical' },
    { id: 'cyber', label: 'Cyber & Tech' },
    { id: 'terminal', label: 'Terminal & Retro Computing' },
    { id: 'retro', label: 'Retro-Futurist & Neon' },
    { id: 'print', label: 'Print & Editorial' },
    { id: 'fantasy', label: 'Fantasy & Arcane' },
    { id: 'bold', label: 'Bold & Material' },
    { id: 'animated', label: 'Animated' },
    { id: 'adaptive', label: 'Adaptive' },
]);

/** @type {Map<string, typeof THEMES[number]>} */
export const THEME_BY_SLUG = new Map(THEMES.map(theme => [theme.slug, theme]));

export function getTheme(slug, customThemes = {}) {
    return THEME_BY_SLUG.get(slug)
        ?? (Object.hasOwn(customThemes, slug) ? customThemes[slug] : null);
}

export function themesInFamily(familyId) {
    return THEMES.filter(theme => theme.family === familyId);
}
