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

const methodBody = (source, signature) => {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n    }\n', start);
    return source.slice(start, end);
};

describe('taps keep working on phones', () => {
    test('the pinch-zoom guard leaves touchstart alone', () => {
        const browserFixes = read('public/scripts/browser-fixes.js');
        expect(browserFixes).not.toMatch(/addEventListener\('touchstart', blockMultiTouchZoom/);
        expect(browserFixes).toMatch(/addEventListener\('touchmove', blockMultiTouchZoom/);
    });

    test('long-press listeners are passive and do not pile up on short taps', () => {
        const longPress = functionBody(read('public/scripts/utils.js'), 'export function addLongPressEvent(');
        const touchStart = longPress.slice(longPress.indexOf('addEventListener(\'touchstart\''), longPress.indexOf('}, { passive: true });'));
        expect(touchStart).toContain('setTimeout(');
        expect(touchStart).not.toContain('preventDefault()');

        const bulkEdit = read('public/scripts/BulkEditOverlay.js');
        expect(bulkEdit).toContain('addEventListener(\'touchstart\', this.handleHold, { passive: true })');
        expect(bulkEdit).toContain('addEventListener(\'touchmove\', this.handleLongPressEnd, { passive: true })');
        expect(bulkEdit).toContain('#releaseHoldListeners = null;');
        expect(bulkEdit.match(/this\.#releaseHoldListeners\?\.\(\);/g)?.length).toBeGreaterThanOrEqual(3);
    });

    test('a UI motion that cannot start still hands the page back', () => {
        const motion = read('public/scripts/ui-motion.js');
        const catchBlock = motion.slice(motion.indexOf('} catch (error) {', motion.indexOf('element.animate(frames, options)')));
        expect(catchBlock.slice(0, 400)).toMatch(/restore\(\);\s*complete\(\);\s*return;/);
    });

    test('closing Meower always shows the chat again', () => {
        const close = functionBody(read('public/scripts/extensions/third-party/Neconyan-Hopper/src/ui.js'), 'function closeFeedInternal(');
        expect(close).toMatch(/} finally {\s*host\?\.removeAttribute\('data-sbtw-mode'\);\s*syncLaunchState\(false\);/);
    });

    test.each([
        'public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/ui/runtime.js',
        'public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/ui/runtime.js',
    ])('%s only clears the inert flags it set', (file) => {
        const runtime = read(file);
        expect(runtime).toContain('const modalBackground = new Set();');
        expect(runtime).not.toContain('modalBackground.set(');
        expect(runtime).toMatch(/for \(const sibling of modalBackground\) {\s*sibling\.removeAttribute\('inert'\);/);
        expect(runtime).toMatch(/} else if \(!sibling\.hasAttribute\('inert'\)\) {\s*sibling\.setAttribute\('inert', ''\);\s*modalBackground\.add\(sibling\);/);
    });

    test('the chat loading dialog always offers a way out', () => {
        const navigation = read('public/scripts/chat-navigation.js');
        expect(navigation).toContain('const SLOW_LOADING_ESCAPE_MS = 8000;');
        expect(navigation).toMatch(/element\.querySelector\('\[data-route-home\]'\)\.hidden = false;\s*}\s*}, SLOW_LOADING_ESCAPE_MS\);/);
        expect(navigation).toMatch(/if \(preparingForeground === ticket && ticket === observationTicket && !routing\) {\s*preparingForeground = 0;\s*dialog\(\)\.close\(\);\s*setChatNavigationBlocked\(false\);/);
    });
});

describe('background work stays small while chatting on a phone', () => {
    test('the chat mode attribute is only written when it changes', () => {
        const tabs = read('public/scripts/neconyan-tabs.js');
        expect(tabs).toMatch(/if \(document\.documentElement\.dataset\.neconyanChatMode !== activeMode\) {\s*document\.documentElement\.dataset\.neconyanChatMode = activeMode;/);
    });

    test('chat avatar variables update only the messages a change touched', () => {
        const tabs = read('public/scripts/neconyan-tabs.js');
        const collect = functionBody(tabs, 'function collectChatAvatarMessages(');
        expect(collect).toContain('if (target?.closest(\'.mes_text\')) continue;');
        const schedule = functionBody(tabs, 'function scheduleChatAvatarVariableUpdate(');
        expect(schedule).toContain('if (message.isConnected) updateChatAvatarVariables(message);');
        expect(tabs).toMatch(/const messages = collectChatAvatarMessages\(mutations\);\s*if \(messages\.size\) scheduleChatAvatarVariableUpdate\(80, messages\);/);
    });

    test('Quick Image Gen revisits only the messages a change touched', () => {
        const qig = read('public/scripts/extensions/quick-image-gen/index.js');
        const schedule = functionBody(qig, 'function scheduleRefreshMessageGenerateActions(');
        expect(schedule).toContain('if (messageElement.isConnected) ensureMessageGenerateAction(messageElement, ctx);');
        expect(qig).toContain('if (touched.size > 0) scheduleRefreshMessageGenerateActions(touched);');
    });

    test('card scripts find their messages with one query', () => {
        const reconcile = functionBody(read('public/scripts/card-script-runtime.js'), 'function reconcileAllMessages(');
        expect(reconcile.match(/querySelectorAll\(/g)).toHaveLength(1);
        expect(reconcile).not.toContain('element.querySelector(');
    });

    test('the Prompt Manager waits for its panel before building a test prompt', () => {
        const promptManager = read('public/scripts/PromptManager.js');
        const render = methodBody(promptManager, '    render(afterTryGenerate = true) {');
        expect(render).toContain('if (this.#deferRenderWhileHidden(afterTryGenerate)) return;');
        const defer = methodBody(promptManager, '    #deferRenderWhileHidden(afterTryGenerate) {');
        expect(defer).toContain('if (container.checkVisibility()) {');
        expect(defer).toContain('new IntersectionObserver(');
        expect(defer).toContain('this.render(pendingDryRun);');
    });

    test('the Dialogue Colours health check rests while the page is hidden', () => {
        const check = functionBody(read('public/scripts/extensions/third-party/sillytavern-character-colors/src/dom-engine.js'), 'function runDomHealthCheck(');
        expect(check).toContain('if (isDecoratingDom || document.visibilityState === \'hidden\') return;');
    });
});
