import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const groupChatsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'group-chats.js'), 'utf8').replace(/\r\n/g, '\n');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const groupsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'neconyan-groups.css'), 'utf8').replace(/\r\n/g, '\n');
const enLocale = JSON.parse(readFileSync(path.join(repoRoot, 'public', 'locales', 'neconyan', 'en.json'), 'utf8'));

function extractUtilityActionsBlock(html) {
    const start = html.indexOf('<div class="flex-container sb-group-editor-utility-actions">');
    const end = html.indexOf('</div>', html.indexOf('id="rm_group_delete"', start));
    return start >= 0 && end > start ? html.slice(start, end + '</div>'.length) : '';
}

function getCssRuleBody(css, selector) {
    const idx = css.indexOf(selector);
    if (idx === -1) return '';
    const open = css.indexOf('{', idx);
    if (open === -1) return '';
    let depth = 1;
    let pos = open + 1;
    while (pos < css.length && depth > 0) {
        if (css[pos] === '{') depth++;
        else if (css[pos] === '}') depth--;
        pos++;
    }
    return css.slice(open + 1, pos - 1);
}

describe('group editor action buttons', () => {
    const selectGroupChats = groupChatsSource.slice(groupChatsSource.indexOf('function select_group_chats(groupId, skipAnimation)'));
    const body = selectGroupChats.slice(0, selectGroupChats.indexOf('\n}\n'));

    test('edit-only buttons are toggled by class, never by an inline display', () => {
        expect(body).toContain('$(\'#rm_group_submit\').toggleClass(\'displayNone\', Boolean(openGroupId));');
        expect(body).toContain('$(\'#rm_group_delete, #rm_group_scenario, #group_open_media_overrides\').css(\'display\', \'\').toggleClass(\'displayNone\', !openGroupId);');
        for (const id of ['rm_group_submit', 'rm_group_delete', 'rm_group_scenario', 'group_open_media_overrides']) {
            expect(body).not.toMatch(new RegExp(`\\$\\('#${id}'\\)\\.(show|hide)\\(`));
        }
    });

    test('utility action buttons carry localized visible labels and danger class', () => {
        const block = extractUtilityActionsBlock(indexHtml);
        expect(block).toContain('class="chat_lorebook_button menu_button fa-solid fa-passport"');
        expect(block).toContain('<span data-i18n="Chat Lore">Chat Lore</span>');
        expect(block).toContain('id="group_open_media_overrides"');
        expect(block).toContain('id="group_media_allowed_icon" class="fa-solid fa-fw fa-link" aria-hidden="true"');
        expect(block).toContain('id="group_media_forbidden_icon" class="fa-solid fa-fw fa-link-slash" aria-hidden="true"');
        expect(block).toContain('<span data-i18n="Ext. Media">Ext. Media</span>');
        expect(block).toContain('id="rm_group_delete" class="heightFitContent margin0 menu_button menu_button_danger fa-solid fa-fw fa-trash-can"');
        expect(block).toContain('<span data-i18n="Delete">Delete</span>');

        for (const key of ['Chat Lore', 'Ext. Media', 'Delete']) {
            expect(enLocale[key]).toBe(key);
        }
    });

    test('group edit header wraps long titles onto new lines without clipping or wrapping controls', () => {
        const tabsRule = getCssRuleBody(groupsCss, '#right-nav-panel[data-menu-type="group_edit"] #right-nav-panel-tabs');
        expect(tabsRule).toContain('align-items: flex-start;');
        expect(tabsRule).toContain('flex-wrap: nowrap;');

        const titleWrapRule = getCssRuleBody(groupsCss, '#right-nav-panel[data-menu-type="group_edit"] #rm_button_selected_ch {');
        expect(titleWrapRule).toContain('height: auto;');
        expect(titleWrapRule).toContain('max-height: none;');
        expect(titleWrapRule).toContain('overflow: visible;');

        const titleHeadingRule = getCssRuleBody(groupsCss, '#right-nav-panel[data-menu-type="group_edit"] #rm_button_selected_ch h2 {');
        expect(titleHeadingRule).toContain('white-space: normal;');
        expect(titleHeadingRule).toContain('overflow: visible;');
        expect(titleHeadingRule).toContain('text-overflow: clip;');
        expect(titleHeadingRule).toContain('overflow-wrap: anywhere;');
    });

    test('labeled utility action buttons size to content, stay single-line and keep 44px touch targets', () => {
        const containerRule = getCssRuleBody(groupsCss, '#right-nav-panel:is([data-menu-type="group_create"], [data-menu-type="group_edit"]) #rm_group_chats_block .sb-group-editor-utility-actions {');
        expect(containerRule).toContain('border: 0;');
        expect(containerRule).toContain('background: transparent;');
        expect(containerRule).toContain('flex-wrap: wrap;');

        const buttonRule = getCssRuleBody(groupsCss, '#right-nav-panel:is([data-menu-type="group_create"], [data-menu-type="group_edit"]) #rm_group_chats_block .sb-group-editor-utility-actions > :is(.chat_lorebook_button, #group_open_media_overrides, #rm_group_delete) {');
        expect(buttonRule).toContain('width: max-content;');
        expect(buttonRule).toContain('max-width: 100%;');
        expect(buttonRule).toContain('min-height: var(--sb-mobile-touch-target, 44px);');
        expect(buttonRule).toContain('white-space: nowrap;');

        const labelRule = getCssRuleBody(groupsCss, '#right-nav-panel:is([data-menu-type="group_create"], [data-menu-type="group_edit"]) #rm_group_chats_block .sb-group-editor-utility-actions > :is(.chat_lorebook_button, #group_open_media_overrides, #rm_group_delete) > span {');
        expect(labelRule).toContain('white-space: nowrap;');

        const shellDeleteRule = getCssRuleBody(groupsCss, ':root[data-sb-theme]:not([data-sb-theme="calico"]) #right-nav-panel:is([data-menu-type="group_create"], [data-menu-type="group_edit"]) #rm_group_chats_block .sb-group-editor-utility-actions > #rm_group_delete {');
        expect(shellDeleteRule).toContain('border-radius: var(--sb-radius-button, var(--neconyan-control-radius, 10px));');

        const lightDeleteRule = getCssRuleBody(groupsCss, ':root[data-sb-surface-tone="light"] #right-nav-panel:is([data-menu-type="group_create"], [data-menu-type="group_edit"]) #rm_group_chats_block .sb-group-editor-utility-actions > #rm_group_delete {');
        expect(lightDeleteRule).toContain('var(--color-danger, var(--sb-color-danger)) 28%');
    });
});
