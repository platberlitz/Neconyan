import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const personaCss = readFileSync(path.join(repoRoot, 'public', 'css', 'personas.css'), 'utf8').replace(/\r\n/g, '\n');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const tabsJs = readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBodies(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...cssSource.matchAll(new RegExp(`^\\s*${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gms'))];

    return matches.map(match => match.groups?.body ?? '');
}

describe('Persona Management mobile layout', () => {
    test('keeps the persona list vertical-only', () => {
        const rules = getRuleBodies(personaCss, '#persona_management_list_scroller').join('\n');

        expect(rules).toContain('overflow-y: auto;');
        expect(rules).toContain('overflow-x: hidden;');
        expect(rules).toContain('touch-action: pan-y;');
    });

    test('keeps persona rows compact: text shrinks, row actions stay on one line', () => {
        const rowPrefix = '#PersonaManagement #user_avatar_block:not(.gridView) .avatar-container';
        const contentRules = getRuleBodies(personaCss, `${rowPrefix} .character_select_container`).join('\n');
        const descriptionRules = getRuleBodies(personaCss, `${rowPrefix} .ch_description`).join('\n');
        const stateRules = getRuleBodies(personaCss, `${rowPrefix} .avatar_container_states`).join('\n');

        expect(contentRules).toContain('grid-template-columns: minmax(0, 1fr) auto;');
        expect(contentRules).toContain('min-width: 0;');
        expect(descriptionRules).toContain('text-overflow: ellipsis;');
        expect(descriptionRules).toContain('white-space: nowrap;');
        expect(stateRules).toContain('min-width: 0;');
        expect(stateRules).toContain('flex-wrap: nowrap;');
    });

    test('drops the old three-line description padding', () => {
        const personasJs = readFileSync(path.join(repoRoot, 'public', 'scripts', 'personas.js'), 'utf8');
        expect(personasJs).not.toContain('\\n\\xa0\\n\\xa0');
    });
});

describe('Persona Management workspace layout', () => {
    test('shows library and editor side by side, with Browse/Edit tabs only in narrow panels', () => {
        expect(personaCss).toContain('container: persona-page / inline-size;');
        expect(personaCss).toMatch(/@container persona-page \(max-width: 719px\)/);
        expect(indexHtml).toContain('id="persona_workspace_panel_browse" class="persona-workspace-panel persona-browse-pane"');
        expect(indexHtml).toContain('id="persona_workspace_panel_edit" class="persona-workspace-panel persona-edit-pane"');
    });

    test('uses labelled editor tabs instead of a section dropdown', () => {
        expect(tabsJs).not.toContain('\'#PersonaManagement .persona-editor-tabs\'');
        expect(indexHtml).toMatch(/id="persona_editor_tab_prompt"[\s\S]*?data-i18n="Description"/);
        expect(indexHtml).toMatch(/id="persona_editor_tab_connections"[\s\S]*?data-i18n="Locks"/);
    });

    test('shows each persona name once in the editor header', () => {
        expect(indexHtml).toMatch(/<h5 id="your_name" class="persona_name" hidden>/);
    });

    test('colours pressed lock buttons and the selected row from the accent', () => {
        const lockRules = getRuleBodies(personaCss, '#PersonaManagement #persona_connections_buttons > .persona-lock-button:is(.locked, [aria-pressed=\'true\'])').join('\n');
        const selectedRules = getRuleBodies(personaCss, '#PersonaManagement #user_avatar_block .avatar-container.selected').join('\n');

        expect(lockRules).toContain('var(--neco-ginger)');
        expect(selectedRules).toContain('var(--neco-ginger)');
        expect(personaCss).not.toMatch(/#[0-9a-f]{3,8}\b(?![\w-])/i);
    });

    test('keeps Delete looking like any other button until it is hovered or focused', () => {
        expect(indexHtml).toMatch(/id="persona_delete_button" class="menu_button menu_button_icon"/);
        expect(indexHtml).not.toMatch(/class="persona_quick_delete[^"]*red_button/);
        const deleteRules = getRuleBodies(personaCss, '#PersonaManagement .persona-maintenance-actions #persona_delete_button:is(:hover, :focus-visible)').join('\n');
        expect(deleteRules).toContain('var(--warning)');
        expect(deleteRules).toContain('color: var(--neco-ink);');
    });
});

describe('Persona stylesheet loading', () => {
    const dynamicStylesJs = readFileSync(path.join(repoRoot, 'public', 'scripts', 'dynamic-styles.js'), 'utf8').replace(/\r\n/g, '\n');
    const shellTabsCss = readFileSync(path.join(repoRoot, 'public', 'css', 'neconyan-tabs.css'), 'utf8').replace(/\r\n/g, '\n');

    test('fetches the persona sheets at high priority once the app is idle', () => {
        expect(tabsJs).toContain('const NN_IDLE_WARM_PANEL_STYLESHEETS = Object.freeze([[\'characters\', \'persona\']]);');
        expect(tabsJs).toMatch(/syncMobileViewportState\(\);\n\s*scheduleIdlePanelStylesheetWarmup\(\);/);
        expect(dynamicStylesJs).toMatch(/if \(priority === 'high'\) \{\n\s*stylesheet\.fetchPriority = 'high';\n\s*stylesheet\.media = media;/);
    });

    test('keeps Persona Management invisible until its sheets apply, with a fallback', () => {
        expect(tabsJs).toContain('const personaStylesReady = preloadPanelStylesheets(\'characters\', \'persona\', { priority: \'high\' });');
        expect(tabsJs).toContain('holdPanelUntilStyled(document.getElementById(\'PersonaManagement\'), personaStylesReady);');
        expect(tabsJs).toContain('window.setTimeout(reveal, NN_PANEL_STYLE_HOLD_TIMEOUT_MS);');
        // The hold is an attribute because ensureCharacterPersonaPanel() strips inline styles.
        const holdRule = getRuleBodies(shellTabsCss, '#PersonaManagement[data-nn-styles-pending]').join('\n');
        expect(holdRule).toContain('opacity: 0;');
        expect(holdRule).toContain('pointer-events: none;');
    });
});

describe('Scenario Notes disclosure', () => {
    test('starts collapsed with a plain final-prompt preview', () => {
        expect(indexHtml).toMatch(/<details class="persona-appendices-block"[^>]*>\s*<summary id="persona_appendices_heading"/);
        expect(indexHtml).not.toContain('<details open class="persona-appendices-block"');
        expect(indexHtml).not.toContain('<details class="persona-effective-preview">');
        expect(indexHtml).toContain('class="persona-effective-preview-title"');
    });

    test('the Scenario Notes shortcut opens the disclosure before focusing Add', () => {
        expect(tabsJs).toContain('const appendicesBlock = appendicesHeading?.closest(\'details\');');
        expect(tabsJs).toContain('appendicesBlock.open = true;');
        expect(tabsJs).toContain('addButton?.focus({ preventScroll: true });');
    });
});
