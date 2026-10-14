import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');

const indexHtml = read('public/index.html');
const swJs = read('public/sw.js');
const tabsJs = read('public/scripts/neconyan-tabs.js');
const tagsCss = read('public/css/neconyan-character-tags.css');

const CACHE_VERSION = swJs.match(/NN_SW_CACHE_VERSION = 'neconyan-cache-v([^']+)'/)[1];

describe('character tags accent styling', () => {
    test('loads as a deferred sheet so the blocking CSS budget is untouched', () => {
        expect(indexHtml).toMatch(new RegExp(`<link href="css/neconyan-character-tags\\.css\\?v=${CACHE_VERSION}" rel="preload" as="style" data-sb-deferred-style data-sb-media="all">`));
    });

    test('shares the cache version with the other stylesheet loaders and the service worker', () => {
        expect(swJs).toContain(`NN_SW_CACHE_VERSION = 'neconyan-cache-v${CACHE_VERSION}'`);
        expect(tabsJs).toContain(`NN_SHELL_STYLE_STYLESHEET_VERSION = '${CACHE_VERSION}'`);
        expect(indexHtml).not.toMatch(/20261012g-page-close-blank/);
    });

    test('colours come from the accent-aware tokens, never a hex value or !important', () => {
        expect(tagsCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(tagsCss).not.toMatch(/!important/);
        expect(tagsCss).toMatch(/var\(--neco-ginger\)/);
        expect(tagsCss).toMatch(/var\(--neco-surface\)/);
        expect(tagsCss).toMatch(/var\(--neco-ink\)/);
    });

    test('has no transitions or animations, so no reduced-motion guard is needed', () => {
        expect(tagsCss).not.toMatch(/transition|animation/);
    });

    test('uses block comments only, never // in CSS', () => {
        expect(tagsCss).not.toMatch(/^\s*\/\//m);
    });

    test('targets both the character card tags and the editor tag list', () => {
        expect(tagsCss).toMatch(/#rm_print_characters_block \.tags_inline \.tag/);
        expect(tagsCss).toMatch(/#right-nav-panel #avatar-and-name-block #tagList \.tag/);
    });

    test('styles the character library cards, primary actions, grid view, and import panel', () => {
        expect(indexHtml).toMatch(/id="rm_button_create"[^>]*class="[^"]*menu_button_primary/);
        expect(indexHtml).toMatch(/id="rm_button_group_chats"[^>]*class="[^"]*menu_button_primary/);
        expect(tagsCss).toMatch(/\.sb-entity-action\[data-entity-action='open-chat'\]/);
        expect(tagsCss).toMatch(/@container character-list \(min-width: 520px\)/);
        expect(tagsCss).toMatch(/body\.neconyan\.charListGrid:not\(\.sbterm\) #right-nav-panel #rm_print_characters_block/);
        expect(tagsCss).toMatch(/#sb_character_import_panel \.sb-character-import-action/);
    });
});
