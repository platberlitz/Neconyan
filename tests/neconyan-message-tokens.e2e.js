/* global document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect, playwright/no-standalone-expect -- Shared viewport helpers and explicit platform cases. */
import { expect } from '@playwright/test';
import { test, send } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const reasoning = 'I should keep the plan simple and leave room for a break.';
const first = 'We can start with a short walk.';
const rest = '\n\nThen find somewhere comfortable to read.';

async function checkGeometry(page, selector, width) {
    const geometry = await page.locator(selector).evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, whiteSpace: getComputedStyle(node).whiteSpace };
    }));
    expect(geometry.length).toBeGreaterThan(0);
    for (const box of geometry) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(width);
        expect(box.width).toBeGreaterThan(0);
        expect(box.whiteSpace).toBe('nowrap');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
}

async function timingSettings(page) {
    await page.locator('[data-sb-conversation-action="open-settings"]').click();
    const navigation = page.locator('[data-sb-conversation-settings-navigation]');
    if (await navigation.isVisible()) await navigation.selectOption('timing');
    else await page.locator('[data-sb-conversation-settings-section="timing"]').click();
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} Scratchpad counts reasoning and output live, then retains them after reopening`, async ({ app }) => {
        test.setTimeout(150000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        if (phone) await applyIOSOnlyCss(page);
        app.provider.mode.streamReply = { first, rest, reasoning, holdReasoning: true, reasoningRest: ' A little flexibility will help.' };
        await page.locator('.scratchpad-composer').fill('Help me plan a quiet afternoon.');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const { job } = await (await accepted).json();
        const pending = page.locator('.scratchpad-message.is-pending');
        await expect(pending.locator('.nn-output-tokens')).toHaveText('0t');
        await expect(pending.locator('.nn-reasoning-tokens')).toContainText(/[1-9]\d*t/);
        const earlyReasoning = await pending.locator('.nn-reasoning-tokens').innerText();
        app.provider.mode.finishReasoning();
        await expect(pending.locator('.nn-output-tokens')).toHaveText(/[1-9]\d*t/);
        await expect(pending.locator('.nn-reasoning-tokens')).not.toHaveText(earlyReasoning);
        await checkGeometry(page, '.scratchpad-author .nn-message-token-counts', phone ? 393 : 1280);
        await page.screenshot({ path: `../screenshots/tokens-scratchpad-${viewport}-after.png` });
        const liveOutput = Number((await pending.locator('.nn-output-tokens').innerText()).replace('t', ''));
        app.provider.mode.finishStream();
        await account.settled(job.id);
        await expect(pending).toHaveCount(0);
        const complete = page.locator('.scratchpad-message.is-assistant.is-done').last();
        const finalOutput = await complete.locator('.nn-output-tokens').innerText();
        expect(Number(finalOutput.replace('t', ''))).toBeGreaterThan(liveOutput);
        await page.close();
        const reopened = await account.open();
        await reopened.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(reopened.locator('.scratchpad-message.is-assistant.is-done').last().locator('.nn-output-tokens')).toHaveText(finalOutput);
        expect(app.provider.calls).toHaveLength(1);
    });

    test(`${viewport} Conversation counts with Streaming off and previews text only when enabled`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        if (phone) await applyIOSOnlyCss(page);
        await timingSettings(page);
        await expect(page.locator('#sb_conv_streaming')).not.toBeChecked();
        await page.locator('[data-sb-conversation-action="close-settings"]').click();
        app.provider.mode.streamReply = { first, rest, reasoning, holdReasoning: true, reasoningRest: ' A little flexibility will help.' };
        const { job } = await send(page, 'Help me plan a quiet afternoon.');
        const pending = page.locator('.sb-conversation-typing-indicator:has(.nn-message-token-counts)');
        await expect(pending.locator('.nn-reasoning-tokens')).toContainText(/[1-9]\d*t/, { timeout: 30000 });
        await expect(pending.locator('.nn-output-tokens')).toHaveText('0t');
        const earlyReasoning = await pending.locator('.nn-reasoning-tokens').innerText();
        app.provider.mode.finishReasoning();
        await expect(pending.locator('.nn-output-tokens')).toHaveText(/[1-9]\d*t/);
        await expect(pending.locator('.nn-reasoning-tokens')).not.toHaveText(earlyReasoning);
        await expect(pending).not.toContainText(first);
        await expect(pending).toHaveCSS('animation-name', 'none');
        await checkGeometry(page, '.sb-conversation-message-meta .nn-message-token-counts', phone ? 393 : 1280);
        await page.screenshot({ path: `../screenshots/tokens-conversation-${viewport}-after.png` });
        await timingSettings(page);
        await page.locator('#sb_conv_streaming').check();
        if (phone) await applyIOSOnlyCss(page);
        await page.screenshot({ path: `../screenshots/tokens-streaming-${viewport}-after.png` });
        await page.locator('[data-sb-conversation-action="close-settings"]').click();
        await expect(pending).toContainText(first);
        await page.close();
        const reopened = await account.open();
        if (phone) await applyIOSOnlyCss(reopened);
        await expect(reopened.locator('.sb-conversation-live-text')).toHaveText(first, { timeout: 30000 });
        await checkGeometry(reopened, '.sb-conversation-message-meta .nn-message-token-counts', phone ? 393 : 1280);
        await reopened.screenshot({ path: `../screenshots/tokens-conversation-streaming-${viewport}-after.png` });
        app.provider.mode.finishStream();
        await account.settled(job.id);
        await expect(reopened.locator('.sb-conversation-typing-indicator .nn-message-token-counts')).toHaveCount(0);
        const saved = (await account.branch()).messages.filter(message => message.role === 'character');
        expect(saved).toHaveLength(2);
        expect(saved[0].extra.reasoning_tokens).toBeGreaterThan(0);
        expect(saved[1].extra.reasoning_tokens).toBe(0);
        for (const message of saved) {
            expect(message.extra.token_count).toBeGreaterThan(0);
            await expect(reopened.locator(`[data-message-id="${message.id}"] .nn-output-tokens`)).toHaveText(`${message.extra.token_count}t`);
        }
        expect(app.provider.calls).toHaveLength(1);
        await timingSettings(reopened);
        await expect(reopened.locator('#sb_conv_streaming')).toBeChecked();
    });
}
