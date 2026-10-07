import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');

const indexHtml = read('public/index.html');
const visualTogglesCss = read('public/css/neconyan-visual-toggles.css');
const themeCss = read('public/css/neconyan-theme.css');

const GROUPS = {
    Comfort: ['reduced_motion', 'fast_ui_mode', 'noShadowsmode'],
    'Message details': [
        'messageTimestampsEnabled',
        'messageTimerEnabled',
        'messageTokensEnabled',
        'mesIDDisplayEnabled',
        'show_swipe_num_all_messages',
        'messageModelIconEnabled',
        'messageModelNameEnabled',
        'messageModelNameShortEnabled',
        'messageReasoningEffortEnabled',
    ],
    'Chat layout': ['waifuMode', 'hideChatAvatarsEnabled', 'expandMessageActions', 'click_to_edit', 'compact_input_area'],
    Characters: ['hotswapEnabled', 'bogus_folders', 'zoomed_avatar_magnification'],
    'Settings and sliders': ['sb_auto_close_inline_drawers', 'enableZenSliders', 'enableLabMode'],
};

function getSection() {
    const start = indexHtml.indexOf('<div id="ThemeTogglesSection"');
    expect(start).toBeGreaterThan(-1);
    const end = indexHtml.indexOf('<div name="themeToggles"', start);
    const closing = indexHtml.indexOf('</section>\n', indexHtml.lastIndexOf('nn-vt-group', indexHtml.indexOf('enableLabMode', end)));
    return indexHtml.slice(start, closing);
}

function getGroups(section) {
    return section.split('<section class="nn-vt-group"').slice(1).map(chunk => ({
        title: chunk.match(/<h4[^>]*class="nn-vt-group-title"[^>]*>([^<]+)<\/h4>/)?.[1],
        ids: [...chunk.matchAll(/<input id="([^"]+)" type="checkbox" \/>/g)].map(match => match[1]),
        chunk,
    }));
}

describe('Visual Toggles layout', () => {
    test('groups every toggle under a titled card with a one-line hint', () => {
        const groups = getGroups(getSection());
        expect(groups.map(group => group.title)).toEqual(Object.keys(GROUPS));

        for (const group of groups) {
            expect(group.ids).toEqual(GROUPS[group.title]);
            expect(group.chunk).toMatch(/<p class="nn-vt-group-hint">[^<]+<\/p>/);
        }
    });

    test('every row shows its name and a visible description, with the switch last', () => {
        const section = getSection();
        const rows = [...section.matchAll(/<label for="([^"]+)" class="checkbox_label nn-vt-row">([\s\S]*?)<\/label>/g)];
        expect(rows).toHaveLength(Object.values(GROUPS).flat().length);

        for (const [, id, body] of rows) {
            expect(body).toMatch(/<small class="nn-vt-name"[^>]*>[^<]+<\/small>/);
            expect(body).toMatch(/<span class="nn-vt-desc">[^<]+<\/span>/);
            expect(body.trimEnd().endsWith(`<input id="${id}" type="checkbox" />`)).toBe(true);
        }
    });

    test('tag folders open Tag Management from a labelled button, not a warning icon', () => {
        const section = getSection();
        expect(section).toMatch(/<button type="button" class="nn-vt-action tags_view">[\s\S]*?<span>Manage tags<\/span>\s*<\/button>/);
        expect(section).not.toContain('fa-circle-exclamation');
    });

    test('short model name sits under the model name toggle and dims while it is off', () => {
        const section = getSection();
        expect(section).toMatch(/<input id="messageModelNameEnabled" type="checkbox" \/>\s*<\/label>\s*<div class="nn-vt-nest">\s*<p class="nn-vt-nest-note">[\s\S]*?Needs Model Name After Icon switched on\.[\s\S]*?<input id="messageModelNameShortEnabled" type="checkbox" \/>\s*<\/label>\s*<\/div>/);
        expect(section).not.toContain('Model Icons switched on');
        expect(visualTogglesCss).toContain('.nn-vt-group:has(#messageModelNameEnabled:not(:checked)) .nn-vt-nest-note');
    });

    test('styles ship in a deferred sheet with accent-aware switches', () => {
        expect(indexHtml).toMatch(/<link href="css\/neconyan-visual-toggles\.css\?v=[^"]+" rel="preload" as="style" data-sb-deferred-style data-sb-media="all">/);
        expect(visualTogglesCss).toContain('var(--neco-ginger,');
        expect(visualTogglesCss).toContain('var(--neco-on-accent,');
        expect(visualTogglesCss).not.toMatch(/#[0-9a-f]{3,8}\b(?![\w-])/i);
        expect(themeCss).not.toContain('#ThemeTogglesSection [name="themeToggles"]');
    });
});
