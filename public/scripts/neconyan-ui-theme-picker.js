import { accessibleTheme, contrastRatio } from './theme-contrast.js';

const previewFields = {
    surface: 'blur_tint_color',
    chat: 'chat_tint_color',
    ink: 'main_text_color',
    accent: 'quote_text_color',
    secondary: 'underline_text_color',
};
const defaultNames = ['Neconyan Calico Dark', 'Neconyan Calico'];
/**
 * The themes the app ships, by name (default/content/themes). Their names are the app's own captions and keep translating.
 * A theme with any other name was saved or imported by a person, so the run-time localiser must leave it as written.
 * tests/user-name-surfaces.test.js checks this list against default/content/index.json.
 */
export const BUNDLED_THEME_NAMES = new Set([
    'Amber Dusk', 'AMOLED Black', 'Arcade Cabinet', 'Atomic Diner', 'Aurora Drift', 'Azure', 'Bauhaus Poster',
    'Bioluminescent Tide', 'Biometric Lab', 'Black Orange', 'Blueprint', 'Botanical Plate', 'Bubble Tea', 'Burnt Orange',
    'Campfire Flicker', 'Candlelit Page', 'Candy Gloss', 'Cappuccino', 'Carbon Fibre', 'Cassette Future', 'Catppuccin Latte',
    'Catppuccin Mocha', 'Celestial Chart', 'Celestial Macaron', 'Cerulean', 'Cherry Cola', 'Chrome 98', 'Chrome HUD', 'Cinder',
    'Circuitry', 'Clean Room', 'Comet Trail', 'Comic Panel', 'Construction Paper', 'Cottagecore Linen', 'Dark Lite', 'Dark V 1.0',
    'Datastream', 'Dawn Glow', 'Deep Sea Sonar', 'Delft Porcelain', 'DOS Cobalt', 'Dracula', 'Dracula Light', 'Dungeon Slate',
    'E-Ink Reader', 'Editorial Hairline', 'Eldritch Deep', 'Elven Gilt', 'Ember Hearth', 'Espresso Bar', 'Everforest Dark',
    'Everforest Light', 'Firefly Glow', 'Frost Rune', 'Game Boy DMG', 'Glacier', 'Glass Frost', 'Glitchwave', 'Greenhouse Grid',
    'Grimoire', 'Gruvbox Dark', 'Gruvbox Light', 'Hacker-Terminal', 'Hacker-Terminal-Light', 'Hazard Console', 'Heat Haze',
    'Herbarium', 'Holo Foil', 'Hydrangea', 'Ice Station', 'Ink & Vellum', 'Koi Pond Night', 'Lantern Warmth', 'Lava Lamp',
    'Lavender', 'Legal Pad', 'Lemon Sorbet', 'Lime', 'Magenta', 'Marshmallow', 'Meadow Sway', 'Memphis Pop', 'Miami Deco',
    'Midnight Kawaii', 'Midnight Library', 'Mint', 'Mint Chip', 'Monochrome', 'Monochrome Slate', 'Moonlit Garden', 'Moss Hollow',
    'Nebula Swirl', 'Neconyan Calico', 'Neconyan Calico Dark', 'Neo-Brutalist', 'Neon Abyss', 'Neon Grid', 'Neon Heartbeat',
    'Neon Yellow', 'Newsprint', 'Night Orchid', 'Nord', 'Nord Light', 'Nordic Frost', 'Obsidian Ink', 'Ocean Breath',
    'Paper Minimal', 'Paper Tape', 'Peach Fuzz', 'Petal Breeze', 'Phosphor Green', 'Photocopy Zine', 'Plasma Ring', 'Plum',
    'Plushie Felt', 'Pressed Lavender', 'Prism Haze', 'Radar Sweep', 'Rain on Glass', 'Raygun Poster', 'Riso Print', 'Rose',
    'Rose Gold Bloom', 'Rosé Pine', 'Rosé Pine Dawn', 'Sage', 'Sakura Drift', 'Signal Pulse', 'Slate', 'Soap Bubble', 'Soft Clay',
    'Solarized Dark', 'Solarized Light', 'Sonokai Andromeda', 'Sonokai Andromeda Light', 'Sonokai Atlantis',
    'Sonokai Atlantis Light', 'Sonokai Default', 'Sonokai Default Light', 'Sonokai Espresso', 'Sonokai Espresso Light',
    'Sonokai Maia', 'Sonokai Maia Light', 'Sonokai Shusia', 'Sonokai Shusia Light', 'Stealth Ops', 'Steampunk Brass',
    'Sticker Book', 'Storm Charge', 'Strawberry Milk', 'Sunbeam Dust', 'Sunflower Field', 'Sunlit Mosaic', 'Sunny Bento',
    'Swiss Grid', 'Synthwave Drive', 'Teletext', 'Terminal Amber', 'Terracotta Sun', 'Tidepool Shimmer', 'Tokyo Night',
    'Tokyo Night Day', 'Ultraviolet Rave', 'Vaporwave Sunset', 'Velvet Noir', 'Verdant', 'Verdant Light', 'VFD Cyan',
    'Volcanic Glass', 'Wildflower Press', 'Windows 98', 'Windows Aero', 'Windows Aero Light', 'Windows XP Blue',
    'Windows XP Olive Green', 'Windows XP Olive Green Dark', 'Windows XP Royale', 'Windows XP Royale Noir', 'Windows XP Silver',
    'Windows XP Zune', 'Witching Hour',
]);
const SEARCH_FILTER_DELAY_MS = 120;

/** Use the same resolved colours as theme application, including imported palettes. */
export function deriveUiThemePreview(theme) {
    const resolved = accessibleTheme(theme);
    const colours = Object.fromEntries(Object.entries(previewFields).map(([role, key]) => [role, resolved[key]]));
    return { ...colours, tone: contrastRatio(colours.surface, 'rgb(0, 0, 0)') > 9 ? 'light' : 'dark' };
}

const themeApplyHoldMs = 1500;
const userScrollEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'];

function scrollParent(node) {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
    }
    return null;
}

/**
 * Keep the control in place through a layout update, even in browsers without scroll anchoring.
 * Filtering only needs the next two frames. Applying a theme can resize content above the
 * gallery for longer, and also needs to restore the card grid's own scroll position.
 */
function holdInPlace(anchor, { grid, duration = 0 } = {}) {
    const scroller = scrollParent(grid ?? anchor);
    const top = anchor.getBoundingClientRect().top;
    const gridTop = grid?.scrollTop;
    const pageX = window.scrollX;
    const pageY = window.scrollY;
    let end = 0;
    let frame = 0;
    let passes = 0;
    const stop = () => {
        cancelAnimationFrame(frame);
        for (const type of userScrollEvents) window.removeEventListener(type, stop, true);
    };
    const settle = () => {
        if (!anchor.isConnected) return stop();
        end ||= performance.now() + duration;
        if (window.scrollY !== pageY) window.scrollTo(pageX, pageY);
        if (grid && grid.scrollTop !== gridTop) grid.scrollTop = gridTop;
        const drift = anchor.getBoundingClientRect().top - top;
        if (scroller && Math.abs(drift) >= 1) scroller.scrollTop += drift;
        if (++passes < 3 || performance.now() < end) frame = requestAnimationFrame(settle);
        else stop();
    };
    for (const type of userScrollEvents) window.addEventListener(type, stop, { capture: true, passive: true });
    return settle;
}

/** Mount once; selection changes preserve the cards, keyboard focus and scroll position. */
export function createUiThemePicker(host, { onSelect, translate = text => text }) {
    const element = (tag, className, text) => {
        const node = document.createElement(tag);
        node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const current = element('div', 'nn-ui-theme-current');
    current.append(element('span', '', translate('Selected theme')));
    const currentName = element('strong', '');
    current.append(currentName);
    const search = element('input', 'text_pole nn-ui-theme-search');
    search.type = 'search';
    search.placeholder = translate('Search themes');
    search.setAttribute('aria-label', translate('Search themes'));
    search.autocomplete = 'off';
    const filters = element('div', 'nn-ui-theme-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', translate('Filter themes by tone'));
    const grid = element('div', 'nn-ui-theme-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', translate('UI themes'));
    const empty = element('div', 'nn-ui-theme-empty');
    empty.append(element('p', '', translate('No themes match that search.')));
    const clear = element('button', 'nn-ui-theme-clear', translate('Clear filters'));
    clear.type = 'button';
    empty.append(clear);
    const count = element('small', 'nn-ui-theme-count');
    count.setAttribute('role', 'status');
    host.replaceChildren(current, search, filters, count, grid, empty);
    let entries = [];
    let activeName = '';
    let signature = '';
    let tone = 'all';
    let filterTimer = 0;
    const filterButtons = ['all', 'dark', 'light'].map((value, index) => {
        const button = element('button', 'nn-ui-theme-filter', translate(['All', 'Dark', 'Light'][index]));
        button.type = 'button';
        button.dataset.tone = value;
        button.addEventListener('click', () => {
            const settle = holdInPlace(filters);
            const changed = tone !== value;
            tone = value;
            filter();
            // A different result set starts at its first card, not the old list's scroll offset.
            if (changed) grid.scrollTop = 0;
            settle();
        });
        filters.append(button);
        return button;
    });

    function visibleEntries() {
        return entries.filter(entry => !entry.filtered);
    }

    function setTabStop(button) {
        for (const entry of entries) {
            const tabIndex = entry.button === button ? 0 : -1;
            if (entry.button.tabIndex !== tabIndex) entry.button.tabIndex = tabIndex;
        }
    }

    // Writes only what changed: each redundant attribute write wakes the page-wide observers.
    function filter() {
        clearTimeout(filterTimer);
        filterTimer = 0;
        const query = search.value.trim().toLocaleLowerCase();
        for (const entry of entries) {
            const filtered = !entry.search.includes(query) || (tone !== 'all' && tone !== entry.tone);
            if (entry.filtered === filtered) continue;
            entry.filtered = filtered;
            // A class, not the hidden attribute: Chrome restyles the whole settings panel for
            // every hidden change because :has() rules watch it.
            entry.button.classList.toggle('displayNone', filtered);
        }
        for (const button of filterButtons) {
            const pressed = String(button.dataset.tone === tone);
            if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
        }
        const visible = visibleEntries();
        if (empty.hidden !== visible.length > 0) empty.hidden = visible.length > 0;
        if (grid.hidden !== (visible.length === 0)) grid.hidden = visible.length === 0;
        const label = `${visible.length} / ${entries.length}`;
        if (count.textContent !== label) count.textContent = label;
        setTabStop((visible.find(entry => entry.name === activeName) ?? visible[0])?.button);
    }

    // Typing only echoes the key; the cards re-filter once the typist pauses.
    search.addEventListener('input', () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(filter, SEARCH_FILTER_DELAY_MS);
    });
    clear.addEventListener('click', () => {
        search.value = '';
        tone = 'all';
        filter();
        search.focus();
    });
    grid.addEventListener('keydown', event => {
        const visible = visibleEntries();
        const index = visible.findIndex(entry => entry.button === event.target);
        if (index < 0) return;
        const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        const offsets = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
            : event.key in offsets ? Math.max(0, Math.min(visible.length - 1, index + offsets[event.key])) : -1;
        if (next < 0) return;
        event.preventDefault();
        setTabStop(visible[next].button);
        visible[next].button.focus();
    });

    return {
        update(themes, selected) {
            // Includes all fields used by accessibleTheme, not just the displayed swatches.
            const nextSignature = JSON.stringify(themes);
            const focusName = entries.find(entry => entry.button === document.activeElement)?.name;
            if (nextSignature !== signature) {
                signature = nextSignature;
                const ordered = [...themes].sort((a, b) => {
                    const rank = name => { const index = defaultNames.indexOf(name); return index < 0 ? 2 : index; };
                    return rank(a.name) - rank(b.name);
                });
                entries = ordered.map(theme => {
                    const preview = deriveUiThemePreview(theme);
                    const button = element('button', 'nn-ui-theme-card');
                    button.type = 'button';
                    button.dataset.themeName = theme.name;
                    const palette = element('span', 'nn-ui-theme-palette');
                    palette.setAttribute('aria-hidden', 'true');
                    for (const role of Object.keys(previewFields)) {
                        const swatch = element('span', '');
                        swatch.style.backgroundColor = preview[role];
                        palette.append(swatch);
                    }
                    const name = element('span', 'nn-ui-theme-name', theme.name);
                    if (!BUNDLED_THEME_NAMES.has(theme.name)) name.setAttribute('data-i18n-ignore', '');
                    const meta = element('span', 'nn-ui-theme-meta');
                    meta.append(element('span', '', translate(preview.tone === 'light' ? 'Light' : 'Dark')));
                    const check = element('span', 'nn-ui-theme-check', '✓');
                    check.setAttribute('aria-hidden', 'true');
                    meta.append(check);
                    button.append(palette, name, meta);
                    button.addEventListener('focus', () => setTabStop(button));
                    button.addEventListener('click', () => {
                        const settle = holdInPlace(button, { grid, duration: themeApplyHoldMs });
                        onSelect(theme.name);
                        settle();
                    });
                    return { name: theme.name, search: theme.name.toLocaleLowerCase(), tone: preview.tone, button, filtered: false };
                });
                grid.replaceChildren(...entries.map(entry => entry.button));
            }
            const changed = activeName !== selected;
            activeName = selected;
            currentName.textContent = selected || translate('No theme selected.');
            // A chosen name stays as written; a bundled name and the fallback caption keep translating.
            currentName.toggleAttribute('data-i18n-ignore', Boolean(selected) && !BUNDLED_THEME_NAMES.has(selected));
            for (const entry of entries) {
                const pressed = String(entry.name === selected);
                if (entry.button.getAttribute('aria-pressed') !== pressed) entry.button.setAttribute('aria-pressed', pressed);
            }
            filter();
            const active = entries.find(entry => entry.name === selected);
            if (changed && active?.filtered) {
                search.value = '';
                tone = 'all';
                filter();
            }
            if (focusName) (entries.find(entry => entry.name === focusName) ?? active)?.button.focus({ preventScroll: true });
        },
    };
}
