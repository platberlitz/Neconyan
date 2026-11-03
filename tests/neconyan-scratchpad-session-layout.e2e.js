/* global document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { checkImageControlContrast } from './scratchpad-image-contrast-helpers.js';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad session buttons share aligned columns`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: { reducedMotion: 'reduce' } });
        const page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await page.locator('.scratchpad-header .scratchpad-new-session').click();
        await expect(page.locator('.scratchpad-summary')).toContainText('notes');
        await page.getByRole('tab', { name: 'Sessions', exact: true }).click();
        const buttons = page.locator('.scratchpad-session-tools > button');
        await expect(buttons).toHaveCount(5);
        await page.screenshot({ path: `../screenshots/scratchpad-sessions-${phone ? 'phone' : 'desktop'}.png` });
        await checkImageControlContrast(page, ['.scratchpad-session-tools > .scratchpad-button-primary'], phone);
        for (const shell of ['default', 'windows-98']) {
            await page.evaluate(shell => { document.body.dataset.sbTheme = shell; }, shell);
            if (shell !== 'default') await page.addStyleTag({ url: `/css/shell-styles/${shell}.css` });
            const boxes = await buttons.evaluateAll(elements => elements.map(element => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return { x, y, width, height, overflow: element.scrollWidth > element.clientWidth };
            }));
            expect(boxes[0].x).toBeCloseTo(boxes[2].x, 0);
            expect(boxes[1].x).toBeCloseTo(boxes[3].x, 0);
            expect(boxes[0].width).toBeCloseTo(boxes[1].width, 0);
            expect(boxes[2].width).toBeCloseTo(boxes[3].width, 0);
            expect(boxes[0].y).toBeCloseTo(boxes[1].y, 0);
            expect(boxes[2].y).toBeCloseTo(boxes[3].y, 0);
            expect(boxes[4].x).toBeCloseTo(boxes[0].x, 0);
            expect(boxes[4].x + boxes[4].width).toBeCloseTo(boxes[1].x + boxes[1].width, 0);
            for (const box of boxes) {
                expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
                expect(box.overflow).toBe(false);
            }
        }
        await page.locator('#neconyan-scratchpad').evaluate(element => {
            element.style.width = '300px';
            element.style.left = 'auto';
        });
        const narrow = await buttons.evaluateAll(elements => elements.map(element => ({
            x: element.getBoundingClientRect().x,
            width: element.getBoundingClientRect().width,
            overflow: element.scrollWidth > element.clientWidth,
        })));
        for (const box of narrow) {
            expect(box.x).toBeCloseTo(narrow[0].x, 0);
            expect(box.width).toBeCloseTo(narrow[0].width, 0);
            expect(box.overflow).toBe(false);
        }
    });
}
