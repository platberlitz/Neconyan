import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');

const functionBody = (source, signature) => {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}\n', start);
    return source.slice(start, end);
};

const tabsJs = read('public/scripts/neconyan-tabs.js');
const settingsTabsJs = read('public/scripts/neconyan-settings-tabs.js');
const agentsJs = read('public/scripts/extensions/in-chat-agents/index.js');
const dialogueColorsUiJs = read('public/scripts/extensions/third-party/sillytavern-character-colors/src/ui.js');
const regexThemesUiJs = read('public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/ui.js');
const tabManagerJs = read('public/scripts/extensions/third-party/ChatCompletionTabs/components/tab-manager.js');
const tabsStyleCss = read('public/scripts/extensions/third-party/ChatCompletionTabs/style.css');

describe('opening a chat skips work for panels that are not on screen', () => {
    test('the Dialogue Colors gradient gallery waits until it comes into view', () => {
        const defer = functionBody(dialogueColorsUiJs, 'function deferHiddenGradientGallery(');
        expect(defer).toContain('new IntersectionObserver(');
        expect(defer).toContain('gradientGalleryPendingPreset = preferredPreset');
        expect(defer).toContain('host.contains(document.activeElement)');

        const render = functionBody(dialogueColorsUiJs, 'function renderGradientPresetGallery(');
        expect(render).toMatch(/if \(deferHiddenGradientGallery\(host, preferredPreset, focusId\)\) {?\s*return;/);
    });

    test('the Regex Agent Themes panel redraws once it is shown, not on every chat change', () => {
        const refresh = functionBody(regexThemesUiJs, 'function refresh()');
        expect(refresh).toContain('if (!viewOnScreen && view?.container?.isConnected');
        expect(refresh).toContain('viewRenderPending = true;');
        expect(functionBody(regexThemesUiJs, 'function watchViewVisibility(')).toContain('if (viewOnScreen && viewRenderPending)');
        expect(functionBody(regexThemesUiJs, 'export function mountSettings(')).toContain('watchViewVisibility(view.container);');
        expect(functionBody(regexThemesUiJs, 'export function removeSettings(')).toContain('viewVisibilityObserver?.disconnect();');
    });

    test('fix-tracker buttons change display without reading computed styles', () => {
        const update = functionBody(agentsJs, 'function updateFixTrackersButtonVisibility(');
        expect(update).not.toContain('.toggle(');
        expect(update).toContain('document.querySelectorAll(\'.mes_fix_trackers\')');
        expect(update).toContain('if (button.style.display !== display) button.style.display = display;');
    });

    test('drawer state is restored only for drawers that changed', () => {
        const queue = functionBody(tabsJs, 'function queueInlineDrawerPersistenceBind(');
        expect(queue).toContain('record.addedNodes');
        expect(queue).toContain('node.parentElement?.closest(\'.inline-drawer\')');
        expect(queue).toContain('bindInlineDrawerPersistence(root);');
        expect(queue).not.toContain('bindInlineDrawerPersistence(document.body)');
        expect(tabsJs).toContain('new MutationObserver(records => queueInlineDrawerPersistenceBind(records))');
    });

    test('message resize reads every position before writing any', () => {
        const scriptJs = read('public/script.js');
        const onResize = functionBody(scriptJs, 'function onChatMessageResize(');
        expect(onResize).toContain('queueMessageSleeperPosition(element.closest(\'.mes\'));');
        expect(onResize).not.toContain('updateMessageSleeperPosition(');

        const flush = functionBody(scriptJs, 'function flushMessageSleeperPositions(');
        const lastRead = flush.lastIndexOf('getBoundingClientRect()');
        const firstWrite = flush.indexOf('style.setProperty(');
        expect(lastRead).toBeGreaterThan(-1);
        expect(firstWrite).toBeGreaterThan(lastRead);
        expect(functionBody(scriptJs, 'function queueMessageSleeperPosition(')).toContain('queueMicrotask(flushMessageSleeperPositions)');
    });

    test('extension search text is built only when a search reads it', () => {
        const create = functionBody(settingsTabsJs, '    function createExtensionGroup(');
        expect(create).toContain('Object.defineProperty(group, \'searchText\'');
        expect(create).toContain('if (searchText === null)');
        expect(settingsTabsJs).toContain('group.searchSources.push([unit, name, id]);');
        expect(settingsTabsJs).not.toMatch(/group\.searchText = normalizeSettingsSearchText\(`\$\{group\.searchText\}/);
    });

    test('chat completion tabs flag the body with a class instead of a page-wide :has()', () => {
        expect(tabManagerJs).toContain('document.body.classList.add(`has-${this.config.className}-buttons`);');
        expect(tabManagerJs.match(/document\.body\.classList\.remove\(`has-\$\{this\.config\.className\}-buttons`\);/g)).toHaveLength(2);
        expect(tabsStyleCss).toContain('body.has-openai-tab-buttons {');
        expect(tabsStyleCss).not.toContain('body:has(.openai-tab-buttons)');
    });
});
