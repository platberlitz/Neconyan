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

    test('the Agents list is rebuilt only while it is on screen', () => {
        const refresh = functionBody(agentsJs, 'function refreshConnectionProfileUi(');
        expect(refresh).toContain('renderAgentListWhenShown();');
        expect(refresh).not.toMatch(/\n\s+renderAgentList\(\);/);

        const whenShown = functionBody(agentsJs, 'function renderAgentListWhenShown(');
        expect(whenShown).toContain('agentListRenderPending = true;');
        expect(whenShown).toContain('list.contains(document.activeElement)');
        expect(whenShown).toContain('updateFixTrackersButtonVisibility();');

        const watch = functionBody(agentsJs, 'function watchAgentList(');
        expect(watch).toContain('new IntersectionObserver(');
        expect(watch).toContain('if (agentListShown && agentListRenderPending) renderAgentList();');
        expect(functionBody(agentsJs, 'function renderAgentList(')).toContain('agentListRenderPending = false;');

        const watchCall = agentsJs.indexOf('    watchAgentList();');
        expect(watchCall).toBeGreaterThan(-1);
        expect(agentsJs.indexOf('eventSource.on(event_types.CHAT_CHANGED, refreshProfileUi);')).toBeGreaterThan(watchCall);
    });

    test('the Fix trackers toolbar button is shown without a computed style read', () => {
        const update = functionBody(agentsJs, 'function updateFixTrackersButtonVisibility(');
        expect(update).not.toContain('$agentsButton.show()');
        expect(update).not.toContain('$(this).toggle(');
        expect(update).toContain('if ($agentsButton[0]?.style.display === \'none\') $agentsButton[0].style.display = \'\';');
    });

    test('Deep Swipe searches only the chat and keeps unchanged arrows', () => {
        const deepSwipeUiJs = read('public/scripts/extensions/third-party/Neconyan-Deep-Swipe/ui.js');
        expect(functionBody(deepSwipeUiJs, 'function findMessageElement(')).toContain('document.getElementById(\'chat\') ?? document');
        expect(deepSwipeUiJs).not.toContain('document.querySelector(`.mes[mesid="${messageId}"]`)');

        const add = functionBody(deepSwipeUiJs, 'export function addSwipeNavigationToMessage(');
        const skip = add.indexOf('messageElement.dataset.deepSwipeNavigation === signature');
        expect(skip).toBeGreaterThan(-1);
        expect(add).toContain('const signature = `${messageId}:${message.is_user ? \'user\' : \'assistant\'}:${swipeCount}:${currentSwipe}`;');
        expect(add.indexOf('.deep-swipe-right-block\').forEach(el => el.remove())')).toBeGreaterThan(skip);
    });

    test('opening a page finds the shell drawers without searching the whole page', () => {
        const drawers = functionBody(tabsJs, 'function getMobileShellBoundDrawers(');
        expect(drawers).toContain('document.getElementsByClassName(\'sb-shell-root\')');
        expect(drawers).not.toContain('querySelectorAll(');
    });
});
