/* global document, Element, MutationObserver, window */
import { expect, test } from '@playwright/test';
import { installSyntheticLongChat, isolateSettingsSaves, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

test.use({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.addEventListener('neconyan:ready', () => { window.desktopPerformanceReady = true; }, { once: true });
    });
    await isolateSettingsSaves(page);
    await openReadyChat(page);
    await page.waitForFunction(() => window.desktopPerformanceReady, null, { timeout: 90_000 });
});

test('desktop resizing preserves chat choices without reloading their data', async ({ page }) => {
    const requests = [];
    const pending = new Set();
    let lastRequest = Date.now();
    page.on('request', request => {
        if (!/\/api\/(?:characters\/chats|chats\/group\/info)$/.test(new URL(request.url()).pathname)) return;
        requests.push(request.url());
        pending.add(request);
        lastRequest = Date.now();
    });
    page.on('requestfinished', request => pending.delete(request));
    page.on('requestfailed', request => pending.delete(request));
    await expect.poll(() => pending.size === 0 && Date.now() - lastRequest >= 1000, { timeout: 20_000 }).toBe(true);
    const options = await page.locator('#sb-bottom-chat-select option').allTextContents();
    const selected = await page.locator('#sb-bottom-chat-select').inputValue();
    expect(options.length).toBeGreaterThan(0);
    requests.length = 0;
    await page.evaluate(() => {
        window.desktopResizeClassWrites = 0;
        window.desktopResizeObserver = new MutationObserver(records => {
            window.desktopResizeClassWrites += records.filter(record => record.target.matches('.mes')).length;
        });
        window.desktopResizeObserver.observe(document.getElementById('chat'), { subtree: true, attributes: true, attributeFilter: ['class'] });
    });

    for (let index = 0; index < 12; index++) {
        await page.setViewportSize({ width: 1100 + index * 12, height: 900 });
        await waitForAnimationFrames(page, 2);
    }
    await waitForAnimationFrames(page, 40);

    const classWrites = await page.evaluate(() => {
        window.desktopResizeObserver.disconnect();
        return window.desktopResizeClassWrites;
    });
    expect(classWrites).toBe(0);
    expect(requests).toEqual([]);
    expect(await page.locator('#sb-bottom-chat-select option').allTextContents()).toEqual(options);
    await expect(page.locator('#sb-bottom-chat-select')).toHaveValue(selected);
    await expect(page.locator('#send_textarea')).toBeEditable();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1232);
});

test('long-chat anchor capture preserves the visible row without measuring every older row', async ({ page }) => {
    await installSyntheticLongChat(page, { messageCount: 200, visibleCount: 100 });
    await expect.poll(() => page.evaluate(() => {
        const chat = document.getElementById('chat');
        return Math.abs(chat.scrollHeight - chat.clientHeight - chat.scrollTop);
    }), { timeout: 15_000 }).toBeLessThanOrEqual(4);
    for (const fraction of [0.15, 0.5, 0.9]) {
        await page.evaluate(fraction => {
            const chat = document.getElementById('chat');
            chat.scrollTop = (chat.scrollHeight - chat.clientHeight) * fraction;
        }, fraction);
        await waitForAnimationFrames(page, 4);
        const result = await page.evaluate(async () => {
            const { captureVisibleMessageAnchor } = await import('/scripts/chat-render-lifecycle/anchor.js');
            const chat = document.getElementById('chat');
            const viewport = chat.getBoundingClientRect();
            const messages = [...chat.querySelectorAll('.mes[mesid]')];
            const first = messages.find(message => {
                const rect = message.getBoundingClientRect();
                return rect.bottom > viewport.top && rect.top < viewport.bottom;
            });
            const expected = { messageId: first.getAttribute('mesid'), offsetTop: first.getBoundingClientRect().top - viewport.top };
            let reads = 0;
            const original = Element.prototype.getBoundingClientRect;
            Element.prototype.getBoundingClientRect = function (...args) {
                if (this.matches('.mes[mesid]')) reads++;
                return original.apply(this, args);
            };
            try {
                return { expected, actual: captureVisibleMessageAnchor(chat), reads, rows: messages.length };
            } finally {
                Element.prototype.getBoundingClientRect = original;
            }
        });
        expect(result.actual.messageId).toBe(result.expected.messageId);
        expect(Math.abs(result.actual.offsetTop - result.expected.offsetTop)).toBeLessThanOrEqual(1);
        expect(result.rows).toBe(100);
        expect(result.reads).toBeLessThan(25);
    }
});

test('unchanged preview metadata leaves its DOM intact and changed counts still appear', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { updateMessageElement, updatePreviewMessageText } = await import('/script.js');
        const message = {
            name: 'Miso', is_user: false, is_system: false, mes: 'Preview body',
            send_date: '2026-01-01T00:00:00.000Z', gen_started: '2026-01-01T00:00:00.000Z',
            gen_finished: '2026-01-01T00:00:01.000Z',
            extra: { api: 'openai', model: 'test', token_count: 40, reasoning_tokens: 8 },
        };
        const node = updateMessageElement(message, { messageId: 7, isPreview: true })[0];
        updatePreviewMessageText(node, message, { messageId: 7, updateText: false });
        const observer = new MutationObserver(() => {});
        observer.observe(node, { subtree: true, attributes: true, childList: true, characterData: true });
        try {
            for (let index = 0; index < 10; index++) {
                updatePreviewMessageText(node, message, { messageId: 7, updateText: false });
            }
            const unchangedWrites = observer.takeRecords().length;
            message.extra.token_count = 43;
            message.extra.reasoning_tokens = 12;
            updatePreviewMessageText(node, message, { messageId: 7, updateText: false });
            const updated = {
                tokens: node.querySelector('.tokenCounterDisplay').textContent,
                reasoning: node.querySelector('.reasoning-tokens-count').textContent,
                body: node.querySelector('.mes_text').textContent,
            };
            message.extra.reasoning_tokens = 0;
            updatePreviewMessageText(node, message, { messageId: 7, updateText: false });
            return { unchangedWrites, updated, remainingReasoningBadges: node.querySelectorAll('.reasoning-tokens-badge').length };
        } finally {
            observer.disconnect();
            node.remove();
        }
    });
    expect(result.unchangedWrites).toBe(0);
    expect(result.updated.tokens).toContain('43');
    expect(result.updated.reasoning).toBe('12');
    expect(result.updated.body).toBe('Preview body');
    expect(result.remainingReasoningBadges).toBe(0);
});
