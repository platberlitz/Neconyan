import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const tabsSource = read('public', 'scripts', 'neconyan-tabs.js');
const cssSource = read('public', 'css', 'neconyan.css');
const tabsCssSource = read('public', 'css', 'neconyan-tabs.css');

const getFunctionSource = name => tabsSource.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0] ?? '';

describe('Neconyan workspace frame', () => {
    test('uses the full area beside the rail instead of the old inspector width', () => {
        expect(cssSource).toContain('--neco-workspace-nav-width: 208px;');
        // The old fixed inspector width, not the unrelated 520px tour coachmark cap.
        expect(cssSource).not.toContain('width: 520px');
        expect(cssSource).toContain('left: var(--neco-sidebar-offset) !important; right: 0 !important;');
        expect(cssSource).toContain('width: auto !important; max-width: none !important;');
        expect(cssSource).toContain('body.neconyan:has(:is(.sb-shell-root, #right-nav-panel).openDrawer) #sheld');
        expect(cssSource).toContain('visibility: hidden !important; pointer-events: none !important;');
    });

    test('keeps Model navigation compact inside the page with keyboard and touch-safe tabs', () => {
        const buildShell = getFunctionSource('buildShell');
        const registerShellTab = getFunctionSource('registerShellTab');

        expect(buildShell).toContain('\'aria-orientation\': \'vertical\'');
        expect(tabsSource).toContain('nav.setAttribute(\'aria-orientation\', \'horizontal\');');
        expect(tabsSource).toContain('navWrapper.classList.add(\'sb-model-native-nav-wrapper\');');
        expect(tabsCssSource).toContain('.sb-model-native-nav-wrapper');
        expect(registerShellTab).toContain('event.key === \'ArrowDown\'');
        expect(registerShellTab).toContain('event.key === \'ArrowUp\'');
        expect(registerShellTab).toContain('event.key === \'Home\'');
        expect(registerShellTab).toContain('event.key === \'End\'');
        expect(cssSource).toContain('body.neconyan .sb-shell-root.openDrawer .sb-shell-tab {');
        expect(cssSource).toContain('min-height: 44px;');
        expect(cssSource).toContain('overflow-y: auto;');
    });

    test('keeps Characters navigation compact while preserving editor keyboard navigation', () => {
        const controls = getFunctionSource('injectCharacterDrawerControls');
        const editorTabs = getFunctionSource('bindCharacterEditorSubTabs');

        expect(controls).toContain('characterNav.setAttribute(\'aria-orientation\', \'horizontal\');');
        expect(controls).toContain('.sb-character-native-nav, .sb-character-shell-nav');
        expect(controls).toContain('event.key === \'ArrowDown\'');
        expect(controls).toContain('event.key === \'ArrowRight\'');
        expect(controls).toContain('event.key === \'ArrowLeft\'');
        expect(controls).toContain('event.key === \'Home\'');
        expect(controls).toContain('event.key === \'End\'');
        expect(editorTabs).toContain('tablist.setAttribute(\'aria-orientation\', \'vertical\');');
        expect(editorTabs).toContain('event.key === \'ArrowDown\'');
        expect(editorTabs).toContain('event.key === \'ArrowUp\'');
        expect(cssSource).toContain('body.neconyan #right-nav-panel.openDrawer .sb-character-editor-subtabs {');
    });

    test('opens model setup on Connections and exposes a workspace close API', () => {
        expect(tabsSource).toContain('defaultTabId: \'api\'');
        expect(tabsSource).toContain('id: \'api\',');
        expect(tabsSource).toContain('label: \'Connections\'');
        expect(tabsSource).toContain('function closeWorkspace() {');
        expect(getFunctionSource('closeWorkspace')).toContain('closeShell(\'left\');');
        expect(getFunctionSource('closeWorkspace')).toContain('closeShell(\'right\');');
        expect(getFunctionSource('closeWorkspace')).toContain('closeCharacterPanelUnlessPinned();');
        expect(tabsSource).toContain('closeWorkspace,');
    });

    test('keeps Advanced content controls without reopening the legacy icon strip', () => {
        expect(cssSource).toContain('.sb-topbar-pages, .sb-topbar-cluster-divider');
        expect(cssSource).toContain('/* The shell toggle ghosts stay hidden while the real controls live in the rail and sheets. */');
        expect(tabsSource).not.toContain('function setTopbarIconsOnly(');
        expect(tabsSource).toContain('const NN_NECONYAN_MOBILE_NAV_CLOSED_ICON = \'fa-bars\';');
        expect(tabsSource).toContain('let title = neconyanMenu ? t`Open menu` : t`Open navigation`;');
        expect(tabsSource).toContain('closeWorkspace,');
    });
});
