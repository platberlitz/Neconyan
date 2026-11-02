import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('Neconyan settings theme drawers', () => {
    const indexSource = readSource('public', 'index.html');
    const settingsTabsSource = readSource('public', 'scripts', 'neconyan-settings-tabs.js');
    const shellTabsSource = readSource('public', 'scripts', 'neconyan-tabs.js');
    const shellTabsCssSource = readSource('public', 'css', 'neconyan-tabs.css');

    test('separates full UI themes from palette and accent presets', () => {
        expect(settingsTabsSource).not.toContain('UI Theme & Presets');
        expect(settingsTabsSource).toContain('mainHeaderSpan.textContent = \'UI Theme\';');
        expect(settingsTabsSource).toContain('mainHeaderSpan.setAttribute(\'data-i18n\', \'UI Theme\');');
        expect(settingsTabsSource).toContain('parentAppearance.querySelector(\'#UI-presets-block > .sb-theme-presets\')');
        expect(settingsTabsSource).toContain('presetsDrawer.id = \'sb-theme-presets-drawer\';');
        expect(settingsTabsSource).toContain('<span data-i18n="Accent Profiles">Accent Profiles</span>');
        expect(settingsTabsSource).not.toContain('<span data-i18n="Presets">Presets</span>');
        expect(settingsTabsSource).toContain('presetsDrawer.querySelector(\'.inline-drawer-content\').appendChild(themePresets);');
        expect(settingsTabsSource).toContain('\'sb-theme-presets-drawer\': \'appearance\',');
    });

    test('keeps full theme controls in their original injection target', () => {
        const themeBlockMatch = indexSource.match(/<div id="UI-presets-block"[^>]*>([\s\S]*?)<div class="sb-theme-presets">/);
        expect(themeBlockMatch).not.toBeNull();
        const themeBlock = themeBlockMatch[1];

        expect(themeBlock).toContain('id="themes"');
        expect(themeBlock).toContain('id="ui_preset_import_file"');
        expect(themeBlock).toContain('id="ui_preset_export_button"');
        expect(themeBlock).toContain('id="ui-preset-save-button"');
    });

    test('removes the empty shell card and duplicate inner UI Theme heading', () => {
        expect(shellTabsSource).toContain('dataset.themePickerInitialized === \'true\'');
        expect(shellTabsSource).toContain('if (!card.hasChildNodes()) {\n        card.remove();\n    }');
        expect(shellTabsSource).toContain('themeBlock.dataset.themePickerInitialized = \'true\';');
        const themeBlock = indexSource.match(/<div id="UI-presets-block"[^>]*>([\s\S]*?)<div class="sb-theme-presets">/)[1];
        expect(themeBlock).toContain('class="sb-ui-theme-actions"');
        expect(themeBlock).not.toContain('<h4');
        expect(themeBlock).not.toContain('data-i18n="UI Theme"');
        const themeCss = readSource('public', 'css', 'neconyan-theme.css');
        expect(themeCss.match(/#UI-presets-block \{([^}]+)\}/)[1].trim()).toBe('gap: 12px;');
    });

    test('groups shell theme controls into persisted appearance drawers', () => {
        const drawerIds = [
            'sb-shell-style-drawer',
            'sb-interface-drawer',
            'sb-topbar-label-drawer',
            'sb-quick-access-shortcuts-drawer',
        ];

        expect(shellTabsSource).toContain('\'data-settings-tab\': \'appearance\'');
        expect(shellTabsSource).toContain('body.style.display = \'none\';');
        expect(shellTabsSource).toContain('themeBlock.append(card);');
        expect(shellTabsSource).not.toContain('themeBlock.prepend(card);');
        for (const drawerId of drawerIds) {
            expect(shellTabsSource).toContain(`'${drawerId}'`);
        }
        expect(shellTabsSource).toContain('content: [frontendIconSettingsGroup, surfaceSliderGroup, bottomBarSliderGroup],');
        expect(shellTabsSource).not.toContain('sb-frontend-icon-drawer');
        expect(shellTabsSource).not.toContain('sb-background-visibility-drawer');
        expect(shellTabsSource).not.toContain('sb-bottom-bar-size-drawer');
        expect(shellTabsCssSource).toContain('.sb-theme-settings-drawer > .inline-drawer-header');
        expect(shellTabsCssSource).toContain('.sb-theme-settings-drawer > .sb-theme-settings-drawer-body');
        expect(shellTabsCssSource).toContain('.sb-interface-settings-group + .sb-interface-settings-group');
    });

    test('lifts shell theme drawers out of UI Theme as top-level appearance drawers', () => {
        const neconyanCssSource = readSource('public', 'css', 'neconyan.css');
        expect(shellTabsSource).toContain('placeThemeSettingsDrawers(themeBlock, card, themeSettingsDrawers);');
        expect(shellTabsSource).toContain('const anchor = document.getElementById(\'sb-theme-presets-drawer\') || themeDrawer;');
        expect(shellTabsSource).toContain('anchor.after(...drawers);');
        expect(shellTabsSource).toContain('drawer.classList.remove(\'sb-theme-settings-drawer\');');
        expect(shellTabsSource).toContain('header?.classList.add(\'userSettingsInnerExpandable\');');
        expect(shellTabsSource).not.toContain('card.append(shellStyleSettingsGroup');
        expect(neconyanCssSource).toContain('.sb-theme-lifted-drawer > .sb-settings-subdrawer-body[style*=\'display: block\']');
    });

    test('gives settings drawers icons and files the Chat & Writing drawers under their tabs', () => {
        expect(settingsTabsSource).toContain('function ensureSettingsHeaderIcons()');
        for (const icon of ['fa-ruler-combined', 'fa-fill-drip', 'fa-toggle-on', 'fa-keyboard', 'fa-code', 'fa-font', 'fa-address-card', 'fa-sliders']) {
            expect(settingsTabsSource).toContain(icon);
        }
        for (const id of ['ChatCharactersSection', 'CharacterHandlingSection', 'AutoSwipeContinueSection', 'ChatFineTuningSection']) {
            expect(settingsTabsSource).toContain(`'${id}': 'chat-writing',`);
        }
        expect(settingsTabsSource).toContain('\'MovingUISection\': \'appearance\',');
        expect(settingsTabsSource).not.toContain('function ensureStscriptDrawer()');
        expect(settingsTabsSource).not.toContain('sb-auto-swipe-drawer');
    });

    test('shows MovingUI presets as cards that drive the preset select', () => {
        expect(settingsTabsSource).toContain('function ensureMovingUIPresetCards()');
        expect(settingsTabsSource).toContain('select.dispatchEvent(new Event(\'change\', { bubbles: true }));');
        expect(settingsTabsSource).toContain('card.setAttribute(\'aria-pressed\', String(card.dataset.preset === select.value));');
    });

    test('keeps the new top-bar Quick Actions wording and removes replacement-page controls', () => {
        expect(shellTabsSource).toContain('Show Custom Quick Actions at the top bar');
        expect(shellTabsSource).not.toContain('Use a chosen page instead of Quick Actions');
        expect(shellTabsSource).toContain('id: \'sb-topbar-quick-actions\'');
        expect(shellTabsSource).toContain('refreshDesktopTopbarQuickActions');
    });

    test('places Memory and performance in the System & Device drawer while retaining aggressive unloading controls', () => {
        expect(settingsTabsSource).toContain('domUnloadDrawer.id = \'sb-aggressive-dom-unload-drawer\';');
        expect(settingsTabsSource).toContain('domUnloadDrawer.className = \'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer nn-settings-cards\';');
        expect(settingsTabsSource).toContain('<span data-i18n="Memory and performance">Memory and performance</span>');
        expect(settingsTabsSource).toContain('\'sb-aggressive-dom-unload-drawer\': \'system-device\',');

        expect(indexSource).toContain('id="low_memory_mode"');
        expect(indexSource).toContain('aria-describedby="low_memory_mode_status"');
        expect(indexSource).toContain('id="low_memory_mode_status"');
        expect(indexSource).toContain('id="low_memory_use_recommendations"');
        expect(indexSource).toContain('id="aggressive_dom_unload"');
        expect(indexSource).toContain('id="aggressive_dom_window_size"');
        expect(indexSource).toContain('id="aggressive_dom_window_size_counter"');
    });

    test('places Miso\'s Help me choose beside the settings search, not in the tab row', () => {
        const guideSource = readSource('public', 'scripts', 'miso-settings-guide.js');
        const recommendationsSource = readSource('public', 'scripts', 'miso-settings-recommendations.js');

        expect(settingsTabsSource).toContain('askMiso.id = MISO_GUIDE_TRIGGER_ID;');
        expect(settingsTabsSource).toContain('searchBar.append(askMiso);');
        expect(settingsTabsSource).toContain('detail.append(searchBar, misoGuideRoot, heading, resultCount, noResults, content);');
        expect(settingsTabsSource).toContain('misoGuideRoot.className = \'nn-miso-guide\';');
        expect(settingsTabsSource).toContain('misoGuideRoot.setAttribute(\'aria-label\', \'Miso\\\'s settings guide\');');
        expect(settingsTabsSource).toContain('markSearchIndexIgnored(document.createElement(\'section\'));');
        expect(settingsTabsSource).not.toContain('nav.append(askMiso');
        expect(settingsTabsSource).toContain('import(\'./miso-settings-guide.js\')');
        expect(settingsTabsSource).toContain('loadAnswers: () => accountStorage.getItem(MISO_GUIDE_STORAGE_KEY)');
        expect(settingsTabsSource).toContain('NeconyanMisoSettingsGuide.v1');
        expect(settingsTabsSource).toContain('aria-expanded');
        expect(settingsTabsSource).toContain('aria-controls');

        expect(guideSource).toContain('getAssistantIconSrc(\'miso\')');
        expect(guideSource).toContain('Miso asks, you decide');
        expect(guideSource).toContain('Four short questions. Miso suggests settings for how you read and chat, and nothing changes until you press the button.');
        expect(guideSource).toContain('event.key === \'Escape\'');
        expect(guideSource).toContain('neconyan:assistant-gender-changed');
        expect(guideSource).toContain('window.addEventListener(\'neconyan:simple-mode-changed\'');
        expect(guideSource).not.toContain('document.addEventListener(\'neconyan:simple-mode-changed\'');
        expect(guideSource).toContain('settingsContent?.addEventListener(\'input\'');
        expect(guideSource).toContain('settingsContent?.addEventListener(\'change\'');
        expect(guideSource).toContain('if (!built || root.hidden || view !== \'results\' || busy) return;');
        expect(guideSource).toContain('const SHELL_APPEARANCE_CONTROL_IDS = new Set([');
        expect(guideSource).toContain('\'sb-desktop-compact-mode-input\'');
        expect(guideSource).toContain('\'sb-mobile-compact-mode-input\'');
        expect(guideSource).toContain('\'sb-kittyless-enabled-input\'');
        expect(guideSource).toContain('settingsBlock?.addEventListener(\'change\', handleAppearanceControlChange)');
        expect(guideSource).toContain('settingsBlock?.removeEventListener(\'change\', handleAppearanceControlChange)');
        expect(settingsTabsSource).toContain('if (readMisoRawValue(settingId) !== next || control.checked !== next)');
        expect(settingsTabsSource).toContain('Aggressive unloading keeps the chat at');
        expect(recommendationsSource).toContain('NeconyanMisoSettingsGuide.v1');

        const chatWritingCss = readSource('public', 'css', 'neconyan-chat-writing.css');
        expect(chatWritingCss).toMatch(/#nn-settings-ask-miso,\s*#nn-settings-miso-guide \.nn-miso-guide-close \{\s*min-height: 44px;/);
    });
});
