import { accessibleTheme, contrastRatio } from './theme-contrast.js';

const previewFields = {
    surface: 'blur_tint_color',
    chat: 'chat_tint_color',
    ink: 'main_text_color',
    accent: 'quote_text_color',
    secondary: 'underline_text_color',
};
const defaultNames = ['Neconyan Calico Dark', 'Neconyan Calico'];

/** Use the same resolved colours as theme application, including imported palettes. */
export function deriveUiThemePreview(theme) {
    const resolved = accessibleTheme(theme);
    const colours = Object.fromEntries(Object.entries(previewFields).map(([role, key]) => [role, resolved[key]]));
    return { ...colours, tone: contrastRatio(colours.surface, 'rgb(0, 0, 0)') > 9 ? 'light' : 'dark' };
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
    const filterButtons = ['all', 'dark', 'light'].map((value, index) => {
        const button = element('button', 'nn-ui-theme-filter', translate(['All', 'Dark', 'Light'][index]));
        button.type = 'button';
        button.dataset.tone = value;
        button.addEventListener('click', () => { tone = value; filter(); });
        filters.append(button);
        return button;
    });

    function visibleEntries() {
        return entries.filter(entry => !entry.button.hidden);
    }

    function setTabStop(button) {
        for (const entry of entries) entry.button.tabIndex = entry.button === button ? 0 : -1;
    }

    function filter() {
        const query = search.value.trim().toLocaleLowerCase();
        for (const entry of entries) {
            entry.button.hidden = !entry.name.toLocaleLowerCase().includes(query) || (tone !== 'all' && tone !== entry.tone);
        }
        for (const button of filterButtons) button.setAttribute('aria-pressed', String(button.dataset.tone === tone));
        const visible = visibleEntries();
        empty.hidden = visible.length > 0;
        grid.hidden = visible.length === 0;
        count.textContent = `${visible.length} / ${entries.length}`;
        setTabStop((visible.find(entry => entry.name === activeName) ?? visible[0])?.button);
    }

    search.addEventListener('input', filter);
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
                    const meta = element('span', 'nn-ui-theme-meta');
                    meta.append(element('span', '', translate(preview.tone === 'light' ? 'Light' : 'Dark')));
                    const check = element('span', 'nn-ui-theme-check', '✓');
                    check.setAttribute('aria-hidden', 'true');
                    meta.append(check);
                    button.append(palette, name, meta);
                    button.addEventListener('focus', () => setTabStop(button));
                    button.addEventListener('click', () => onSelect(theme.name));
                    return { name: theme.name, tone: preview.tone, button };
                });
                grid.replaceChildren(...entries.map(entry => entry.button));
            }
            const changed = activeName !== selected;
            activeName = selected;
            currentName.textContent = selected || translate('No theme selected.');
            for (const entry of entries) entry.button.setAttribute('aria-pressed', String(entry.name === selected));
            filter();
            const active = entries.find(entry => entry.name === selected);
            if (changed && active?.button.hidden) {
                search.value = '';
                tone = 'all';
                filter();
            }
            if (focusName) (entries.find(entry => entry.name === focusName) ?? active)?.button.focus({ preventScroll: true });
        },
    };
}
