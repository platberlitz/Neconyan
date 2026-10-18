/* global document, Element, MouseEvent, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

test.setTimeout(120_000);
test.use({ serviceWorkers: 'block' });

const BASE_VIEWPORT = { width: 1280, height: 900 };
const RESIZED_VIEWPORT = { width: 1180, height: 900 };

async function installMenuProbe(page) {
    await page.evaluate(() => {
        const anchors = new Set(['options_button', 'export_button', 'extensionsMenuButton']);
        const menus = new Set(['options', 'export_format_popup', 'extensionsMenu']);
        const prototype = Element.prototype;
        const original = prototype.getBoundingClientRect;
        const reads = { anchor: 0, menu: 0 };

        window.menuProbe = {
            reads,
            reset() {
                reads.anchor = 0;
                reads.menu = 0;
            },
            dispose() {
                prototype.getBoundingClientRect = original;
            },
        };

        prototype.getBoundingClientRect = function (...args) {
            if (anchors.has(this.id)) reads.anchor += 1;
            if (menus.has(this.id)) reads.menu += 1;
            return original.apply(this, args);
        };
    });
}

async function waitForSurfaceSettled(page, selector) {
    await page.evaluate(async selectorInPage => {
        const surface = document.querySelector(selectorInPage);
        if (!surface) return;
        await Promise.all(surface.getAnimations()
            .map(animation => animation.finished.catch(() => {})));
    }, selector);
}

async function resetMenuProbe(page) {
    await page.evaluate(() => window.menuProbe.reset());
}

async function readMenuProbe(page) {
    return page.evaluate(() => ({ ...window.menuProbe.reads }));
}

async function readMenuGeometry(page, menuSelector, buttonSelector) {
    return page.evaluate(({ menuSelector: menuSelectorInPage, buttonSelector: buttonSelectorInPage }) => {
        const menu = document.querySelector(menuSelectorInPage);
        const button = document.querySelector(buttonSelectorInPage);
        if (!menu || !button) return null;
        const menuRect = menu.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            menu: {
                left: menuRect.left, top: menuRect.top, right: menuRect.right, bottom: menuRect.bottom,
                width: menuRect.width, height: menuRect.height,
            },
            relative: {
                left: menuRect.left - buttonRect.left,
                top: menuRect.top - buttonRect.top,
                right: menuRect.right - buttonRect.right,
                bottom: menuRect.bottom - buttonRect.bottom,
                topGap: buttonRect.top - menuRect.bottom,
                leftGap: buttonRect.left - menuRect.right,
                centerY: (menuRect.top + menuRect.bottom - buttonRect.top - buttonRect.bottom) / 2,
            },
        };
    }, { menuSelector, buttonSelector });
}

async function readMenuStyle(page, menuSelector) {
    return page.evaluate(selector => document.querySelector(selector)?.getAttribute('style') ?? null, menuSelector);
}

async function dispatchViewportWork(page) {
    await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'));
        window.visualViewport?.dispatchEvent(new Event('scroll'));
        window.visualViewport?.dispatchEvent(new Event('resize'));
        const chat = document.querySelector('#chat');
        if (chat) chat.scrollTop = Math.max(0, chat.scrollTop - 120);
    });
    await waitForAnimationFrames(page, 4);
}

function expectPlacement(geometry, placement) {
    expect(geometry).not.toBeNull();
    expect(geometry.menu.width).toBeGreaterThan(0);
    expect(geometry.menu.height).toBeGreaterThan(0);
    expect(geometry.menu.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.menu.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
    if (placement === 'top-start') {
        expect(Math.abs(geometry.relative.topGap)).toBeLessThanOrEqual(8);
        expect(Math.abs(geometry.relative.left)).toBeLessThanOrEqual(8);
    } else {
        expect(Math.abs(geometry.relative.leftGap)).toBeLessThanOrEqual(8);
        expect(Math.abs(geometry.relative.centerY)).toBeLessThanOrEqual(16);
    }
}

function expectAnchored(before, after) {
    expect(after).not.toBeNull();
    expect(Math.abs(after.relative.left - before.relative.left)).toBeLessThanOrEqual(6);
    expect(Math.abs(after.relative.top - before.relative.top)).toBeLessThanOrEqual(6);
    expect(Math.abs(after.relative.right - before.relative.right)).toBeLessThanOrEqual(6);
    expect(Math.abs(after.relative.bottom - before.relative.bottom)).toBeLessThanOrEqual(6);
    expect(after.menu.width).toBeGreaterThan(0);
    expect(after.menu.height).toBeGreaterThan(0);
}

const CHAT_MENUS = [
    {
        name: 'options',
        button: '#options_button',
        menu: '#options',
        placement: 'top-start',
        close: page => page.locator('#options_button').click(),
    },
    {
        name: 'wand',
        button: '#extensionsMenuButton',
        menu: '#extensionsMenu',
        placement: 'top-start',
        close: page => page.evaluate(() => {
            document.querySelector('#chat').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }),
    },
];

const EXPORT_MENU = {
    name: 'export',
    button: '#export_button',
    menu: '#export_format_popup',
    placement: 'left',
    close: page => page.locator('#export_button').click(),
};

async function exerciseMenu(page, menu) {
    await page.locator(menu.button).click();
    await expect(page.locator(menu.menu)).toBeVisible();
    await waitForSurfaceSettled(page, menu.menu);
    await waitForAnimationFrames(page, 1);

    const initial = await readMenuGeometry(page, menu.menu, menu.button);
    expectPlacement(initial, menu.placement);

    await resetMenuProbe(page);
    await page.setViewportSize(RESIZED_VIEWPORT);
    await waitForAnimationFrames(page, 4);
    const openReads = await readMenuProbe(page);
    expect(openReads.anchor, `${menu.name} anchor reads while open`).toBeGreaterThan(0);
    expect(openReads.menu, `${menu.name} menu reads while open`).toBeGreaterThan(0);
    expectAnchored(initial, await readMenuGeometry(page, menu.menu, menu.button));

    await page.setViewportSize(BASE_VIEWPORT);
    await waitForAnimationFrames(page, 4);
    expectAnchored(initial, await readMenuGeometry(page, menu.menu, menu.button));

    await menu.close(page);
    await expect(page.locator(menu.menu)).toBeHidden();
    await waitForAnimationFrames(page, 4);
    const closedStyle = await readMenuStyle(page, menu.menu);

    await resetMenuProbe(page);
    await dispatchViewportWork(page);
    const closedReads = await readMenuProbe(page);
    expect(closedReads.anchor, `${menu.name} anchor reads after close`).toBe(0);
    expect(await readMenuStyle(page, menu.menu)).toBe(closedStyle);
    await expect(page.locator(menu.menu)).toBeHidden();
}

test('open menus keep positioning while open and stop after every close path', async ({ page }) => {
    await isolateSettingsSaves(page);
    await openReadyChat(page);
    await page.setViewportSize(BASE_VIEWPORT);
    await installMenuProbe(page);

    try {
        for (const menu of CHAT_MENUS) {
            await exerciseMenu(page, menu);
        }

        // Author's Note also fades the options menu as a legacy duplicate close.
        // The direct hide below separately covers a path that never reaches hideMenu.
        await page.locator('#options_button').click();
        await expect(page.locator('#options')).toBeVisible();
        await waitForSurfaceSettled(page, '#options');
        await page.locator('#option_toggle_AN').click();
        await expect(page.locator('#options')).toBeHidden();
        await waitForAnimationFrames(page, 4);
        const authorNoteClosedStyle = await readMenuStyle(page, '#options');

        await resetMenuProbe(page);
        await dispatchViewportWork(page);
        const authorNoteReads = await readMenuProbe(page);
        expect(authorNoteReads.anchor).toBe(0);
        expect(await readMenuStyle(page, '#options')).toBe(authorNoteClosedStyle);
        await expect(page.locator('#options')).toBeHidden();
        await page.evaluate(() => {
            const prompt = document.querySelector('#floatingPrompt');
            if (prompt) prompt.style.display = 'none';
        });

        // The observer is the safety net for a direct hide that never reaches
        // hideMenu. It must disable positioning just the same.
        await page.locator('#options_button').click();
        await expect(page.locator('#options')).toBeVisible();
        await waitForSurfaceSettled(page, '#options');
        await page.evaluate(() => window.jQuery('#options').stop(true, true).hide());
        await expect(page.locator('#options')).toBeHidden();
        await waitForAnimationFrames(page, 4);
        const directClosedStyle = await readMenuStyle(page, '#options');

        await resetMenuProbe(page);
        await dispatchViewportWork(page);
        expect((await readMenuProbe(page)).anchor).toBe(0);
        expect(await readMenuStyle(page, '#options')).toBe(directClosedStyle);
        await expect(page.locator('#options')).toBeHidden();

        // The export menu lives in the character editor. Open it through the
        // roleplay top-bar shortcut so the real button and Popper are exercised.
        await page.evaluate(() => window.NeconyanShell.activateMode('roleplay'));
        await page.locator('#sb-topbar-edit-card').click();
        await expect(page.locator('#export_button')).toBeVisible();
        await exerciseMenu(page, EXPORT_MENU);
    } finally {
        await page.evaluate(() => {
            window.menuProbe?.dispose();
            const prompt = document.querySelector('#floatingPrompt');
            if (prompt) prompt.style.display = 'none';
        });
    }
});

async function installRoleplayPreview(page) {
    await page.evaluate(async () => {
        const originalFetch = window.fetch;
        const encode = text => new TextEncoder().encode(text);
        let current = null;
        let latest = null;
        const enqueue = text => {
            try {
                current?.enqueue(encode(text));
            } catch {
                current = null;
            }
        };
        const keepalive = setInterval(() => enqueue(': keepalive\n\n'), 1000);
        window.sendRenderPreview = frame => {
            latest = frame;
            enqueue(`data: ${JSON.stringify(frame)}\n\n`);
        };
        window.fetch = (input, options) => {
            if (!String(input).includes('/api/jobs/preview-render-regression/preview')) {
                return originalFetch(input, options);
            }
            let own = null;
            return Promise.resolve(new Response(new ReadableStream({
                start(controller) {
                    own = controller;
                    current = controller;
                    if (latest) controller.enqueue(encode(`data: ${JSON.stringify(latest)}\n\n`));
                },
                cancel() {
                    if (current === own) current = null;
                },
            }), { headers: { 'Content-Type': 'text/event-stream' } }));
        };

        window.previewDraws = 0;
        document.addEventListener('neconyan:roleplay-preview-rendered', () => {
            window.previewDraws += 1;
        });

        const { observeRoleplayPreview } = await import('/scripts/neconyan-conversation/roleplay-preview.js');
        const stop = observeRoleplayPreview('preview-render-regression', {
            account: 'preview-render-test',
            isCurrent: () => true,
            onTerminal: () => {},
            name: 'reply',
            messageIndex: 1,
        });
        window.stopRenderPreview = () => {
            stop();
            clearInterval(keepalive);
            window.fetch = originalFetch;
        };
    });
}

const BODY_CODE_TOKEN = 'live_bg_preview_body_token';
const REASONING_CODE_TOKEN = 'live_bg_preview_reasoning_token';
const BODY_TEXT = [
    'A live reply with code.',
    '',
    '```js',
    `const ${BODY_CODE_TOKEN} = 1;`,
    '```',
    '',
    'First line of the reply.',
].join('\n');
const REASONING_TEXT = [
    'Reasoning before the reply.',
    '',
    '```js',
    `const ${REASONING_CODE_TOKEN} = 2;`,
    '```',
].join('\n');
const FINAL_TEXT = [
    BODY_TEXT,
    '',
    'Final line after the code.',
].join('\n');

test('streamed preview keeps one code control per block, updates badges and never writes chat', async ({ page }) => {
    await isolateSettingsSaves(page);
    await openReadyChat(page);
    const before = await page.evaluate(async () => {
        const core = await import('/script.js');
        return { length: core.chat.length, last: core.chat.at(-1)?.mes ?? '' };
    });
    await installRoleplayPreview(page);

    const preview = page.locator('#neconyan-roleplay-preview');
    const bodyCodeBlocks = preview.locator('.mes_text pre code');
    const reasoningCodeBlocks = preview.locator('.mes_reasoning pre code');
    const bodyCopies = bodyCodeBlocks.locator('.code-copy');
    const reasoningCopies = reasoningCodeBlocks.locator('.code-copy');
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const firstFrame = {
        childId: 'preview-render-1',
        stage: 'generating',
        name: 'Miso',
        reasoning: REASONING_TEXT,
        reasoning_finished: true,
        reasoning_duration: 1200,
        text: BODY_TEXT,
        gen_started: startedAt,
        token_count: 100,
        generation: { source: 'openai', model: 'gpt-5' },
    };

    try {
        await page.evaluate(frame => {
            window.renderPreviewBase = frame;
            window.sendRenderPreview({ preview: frame });
        }, firstFrame);

        await expect(preview.locator('.mes_text')).toContainText(BODY_CODE_TOKEN);
        await expect(preview.locator('.mes_reasoning')).toContainText(REASONING_CODE_TOKEN);
        await expect(bodyCodeBlocks).toHaveCount(1);
        await expect(reasoningCodeBlocks).toHaveCount(1);
        await expect(bodyCopies).toHaveCount(1);
        await expect(reasoningCopies).toHaveCount(1);
        await expect(preview.locator('.tokenCounterDisplay')).toHaveText('100t');

        const timer = preview.locator('.mes_timer');
        await expect(timer).toHaveText(/\d+\.\ds/);
        const timerStart = Number.parseFloat(await timer.textContent());
        await expect.poll(async () => Number.parseFloat(await timer.textContent()), { timeout: 5000 }).toBeGreaterThan(timerStart);

        // Full renders clear .mes_bias. A fast text draw must leave it alone,
        // which proves this frame took the in-place text path.
        await page.evaluate(() => {
            const bias = document.querySelector('#neconyan-roleplay-preview .mes_bias');
            bias.innerHTML = '<span data-preview-fast-path></span>';
        });
        await page.evaluate(() => window.sendRenderPreview({ delta: { text: '\n\nFirst fast append.', set: { updatedAt: Date.now() } } }));
        await expect(preview.locator('.mes_text')).toContainText('First fast append.');
        await expect(preview.locator('[data-preview-fast-path]')).toHaveCount(1);
        await expect(bodyCopies).toHaveCount(1);
        await expect(reasoningCopies).toHaveCount(1);

        await page.evaluate(() => window.sendRenderPreview({ delta: { set: { token_count: 321 } } }));
        await expect(preview.locator('.tokenCounterDisplay')).toHaveText('321t');
        await expect(bodyCopies).toHaveCount(1);
        await expect(reasoningCopies).toHaveCount(1);

        await page.evaluate(() => window.sendRenderPreview({ delta: { text: '\n\nSecond fast append.', set: { updatedAt: Date.now() } } }));
        await expect(preview.locator('.mes_text')).toContainText('Second fast append.');
        await expect(page.locator('[data-preview-fast-path]')).toHaveCount(1);
        await expect(bodyCopies).toHaveCount(1);
        await expect(reasoningCopies).toHaveCount(1);

        // A stage change rebuilds through the full renderer: the bias marker is
        // cleared, while the code controls stay single.
        await page.evaluate(() => window.sendRenderPreview({ delta: { set: { stage: 'companions' } } }));
        await expect(preview.locator('[role="status"]')).toHaveText('Running Companions…');
        await expect(preview.locator('[data-preview-fast-path]')).toHaveCount(0);
        await expect(bodyCopies).toHaveCount(1);
        await expect(reasoningCopies).toHaveCount(1);

        await page.evaluate(text => window.sendRenderPreview({
            preview: { ...window.renderPreviewBase, stage: 'saving', text, token_count: 321 },
        }), FINAL_TEXT);
        await expect(preview.locator('[role="status"]')).toHaveText('Saving reply…');
        const finalRendered = await preview.locator('.mes_text').innerText();
        expect(finalRendered).toContain(BODY_CODE_TOKEN);
        expect(finalRendered).toContain('Final line after the code.');
        expect(finalRendered).not.toContain('First fast append.');
        expect(finalRendered).not.toContain('Second fast append.');
        await expect(bodyCopies).toHaveCount(1);
        await expect(reasoningCopies).toHaveCount(1);

        expect(await page.evaluate(() => window.previewDraws)).toBeGreaterThanOrEqual(5);
        const after = await page.evaluate(async token => {
            const core = await import('/script.js');
            const draft = document.querySelector('#neconyan-roleplay-preview');
            return {
                length: core.chat.length,
                last: core.chat.at(-1)?.mes ?? '',
                leaked: core.chat.some(message => String(message.mes).includes(token)),
                draftFlag: draft?.getAttribute('data-roleplay-draft') ?? null,
                mesid: draft?.getAttribute('mesid') ?? null,
            };
        }, BODY_CODE_TOKEN);
        expect(after.length).toBe(before.length);
        expect(after.last).toBe(before.last);
        expect(after.leaked).toBe(false);
        expect(after.draftFlag).toBe('true');
        expect(after.mesid).toBeNull();
    } finally {
        await page.evaluate(() => window.stopRenderPreview?.());
    }
});
