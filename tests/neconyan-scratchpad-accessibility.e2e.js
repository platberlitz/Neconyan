/* global getComputedStyle */
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const layouts = [{
    size: 'phone', phone: true,
    async checkLayout(assertThat, _panel, behind) {
        await assertThat(behind).toHaveAttribute('inert');
    },
    async checkMenu(assertThat, details) {
        assertThat(await details.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    },
    async checkReview(assertThat, review) {
        assertThat(await review.locator('textarea').evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
    },
}, {
    size: 'desktop', phone: false,
    async checkLayout(assertThat, panel, behind) {
        await assertThat(behind).not.toHaveAttribute('inert');
        const separator = panel.getByRole('separator', { name: 'Resize Scratchpad' });
        await assertThat(separator).toHaveAttribute('aria-valuemin', '320');
        await assertThat(separator).toHaveAttribute('aria-valuenow', /\d+/);
        await panel.getByRole('button', { name: 'Full width', exact: true }).click();
        await assertThat(behind).toHaveAttribute('inert');
    },
    checkMenu() {},
    checkReview() {},
}];

async function captureReviewComparison(page, size) {
    const baseline = process.env.SCRATCHPAD_AUDIT_SCREENSHOTS;
    if (!baseline) return;
    const dir = path.resolve('../screenshots/scratchpad-audit');
    await page.screenshot({ path: path.join(dir, `${size}-after.png`) });
    // Reapply just the baseline stylesheet to isolate visual differences in the same review.
    await page.locator('#neconyan-scratchpad-css').evaluate(el => { el.disabled = true; });
    await page.addStyleTag({ content: fs.readFileSync(baseline, 'utf8') });
    await page.screenshot({ path: path.join(dir, `${size}-before.png`) });
}

for (const { size, phone, checkLayout, checkMenu, checkReview } of layouts) {
    test(`${size} keeps Scratchpad keyboard navigation and review controls usable`, async ({ app }) => {
        const account = await app.account({ phone });
        const page = await account.open();
        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        const change = { type: 'character', character: 'Durable Nova', field: 'description', value: 'Nova waits by the harbour.' };
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Harbour ideas', messages: [{
            role: 'assistant', text: 'A small edit.\n```scratchpad-change\n' + JSON.stringify(change) + '\n```', reasoning: 'Keep this short.',
        }] } });
        await open();
        const panel = page.locator('#neconyan-scratchpad');
        const chat = panel.getByRole('tab', { name: 'Chat', exact: true });
        const context = panel.getByRole('tab', { name: 'Context', exact: true });
        const sessions = panel.getByRole('tab', { name: 'Sessions', exact: true });
        await chat.focus();
        await chat.press('ArrowRight');
        await expect(context).toBeFocused();
        await expect(context).toHaveAttribute('aria-selected', 'true');
        await context.press('End');
        await expect(sessions).toBeFocused();
        await sessions.press('Home');
        await expect(chat).toBeFocused();
        await expect(panel.locator('.scratchpad-messages')).not.toHaveAttribute('aria-live');
        const status = panel.locator('#scratchpad-panel-chat .sr-only[role="status"]');
        await expect(status).toHaveCount(1);
        await expect(status).not.toContainText('A small edit');

        const behind = page.locator('#sheld');
        await checkLayout(expect, panel, behind);
        const details = panel.locator('.scratchpad-message-menu > summary').first();
        await checkMenu(expect, details);
        await details.click();
        await panel.locator('.scratchpad-message-menu[open] button').first().press('Escape');
        await expect(details).toBeFocused();
        await expect(panel.locator('.scratchpad-message-menu[open]')).toHaveCount(0);

        await panel.locator('.scratchpad-change').getByRole('button', { name: 'Review', exact: true }).click();
        const review = page.locator('dialog[open] .scratchpad-review');
        const preview = review.locator('button.scratchpad-code-preview');
        await expect(review).toBeVisible();
        await expect(preview).toHaveAttribute('hidden');
        await expect(preview).toBeHidden();
        await checkReview(expect, review);
        await captureReviewComparison(page, size);
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        await panel.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await expect(behind).not.toHaveAttribute('inert');
        await expect(panel).toBeHidden();
    });
}
