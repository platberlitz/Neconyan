import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const worldInfoCss = readFileSync(path.join(repoRoot, 'public', 'css', 'world-info.css'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBody(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...cssSource.matchAll(new RegExp(`^\\s*${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gms'))];
    return matches.at(-1)?.groups?.body ?? '';
}

describe('lorebook Entry tools summary button', () => {
    test('Entry tools summary carries the button classes, icon and cat-control hook', () => {
        const summary = indexHtml.match(/<details class="world_popup_action_group_details">\s*<summary[^>]*>[\s\S]*?<\/summary>/);
        expect(summary).not.toBeNull();
        const markup = summary[0];
        expect(markup).toContain('<summary class="world_popup_action_group_label menu_button menu_button_icon"');
        expect(markup).toContain('data-neconyan-cat-control');
        expect(markup).toContain('<i class="fa-solid fa-toolbox" aria-hidden="true"></i>');
        expect(markup).toContain('<span data-i18n="Entry tools">Entry tools</span>');
    });

    test('Library actions summary stays a plain label', () => {
        expect(indexHtml).toContain('<summary class="world_popup_action_group_label"><span data-i18n="Library actions">Library actions</span></summary>');
    });

    test('button variant rule undoes the plain label row treatment and follows it', () => {
        const labelRule = getRuleBody(worldInfoCss, 'body.neconyan #WorldInfo .world_popup_action_group_label');
        const buttonRule = getRuleBody(worldInfoCss, 'body.neconyan #WorldInfo .world_popup_action_group_label.menu_button');

        expect(labelRule).toContain('min-height: 44px;');
        expect(buttonRule).toContain('min-height: 48px;');
        expect(buttonRule).toContain('padding-block: 6px;');
        expect(buttonRule).toContain('font-size: var(--sb-type-control);');
        expect(buttonRule).toContain('font-weight: var(--sb-weight-control);');
        expect(worldInfoCss.indexOf('body.neconyan #WorldInfo .world_popup_action_group_label.menu_button {'))
            .toBeGreaterThan(worldInfoCss.indexOf('body.neconyan #WorldInfo .world_popup_action_group_label {'));
    });

    test('Add entry keeps whisker-clearing space on the side facing Entry tools', () => {
        const addEntryRule = getRuleBody(worldInfoCss, 'body.neconyan #WorldInfo #world_popup_new');
        expect(addEntryRule).toContain('margin-inline-end: 16px;');
    });
});
