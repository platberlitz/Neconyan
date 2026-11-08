/* global document, window */
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
        await checkImageControlContrast(page, ['.scratchpad-session-tools > .menu_button_primary'], phone);
        const settleLayout = async () => {
            await page.evaluate(async () => {
                await document.fonts.ready;
                await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
            });
        };
        const measureButtons = () => buttons.evaluateAll(elements => elements.map(element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height, overflow: element.scrollWidth > element.clientWidth };
        }));
        const measureNarrow = () => buttons.evaluateAll(elements => elements.map(element => ({
            x: element.getBoundingClientRect().x,
            width: element.getBoundingClientRect().width,
            overflow: element.scrollWidth > element.clientWidth,
        })));
        const assertColumns = boxes => {
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
        };
        const assertNarrow = boxes => {
            for (const box of boxes) {
                expect(box.x).toBeCloseTo(boxes[0].x, 0);
                expect(box.width).toBeCloseTo(boxes[0].width, 0);
                expect(box.overflow).toBe(false);
            }
        };

        let shellStyle = null;
        for (const shell of ['default', 'windows-98']) {
            if (shellStyle) {
                await shellStyle.evaluate(element => element.remove());
                shellStyle = null;
            }
            await page.evaluate(shell => {
                if (shell === 'default') delete document.documentElement.dataset.sbTheme;
                else document.documentElement.dataset.sbTheme = shell;
                delete document.body.dataset.sbTheme;
            }, shell);
            if (shell === 'windows-98') {
                shellStyle = await page.addStyleTag({ url: `/css/shell-styles/${shell}.css` });
                await expect.poll(() => page.evaluate(() => {
                    const sheet = [...document.styleSheets].find(item => item.href?.includes('/css/shell-styles/windows-98.css'));
                    return Boolean(sheet?.cssRules?.length);
                }), { message: 'Windows 98 stylesheet is loaded' }).toBe(true);
            }
            await settleLayout();
            const boxes = await measureButtons();
            await page.screenshot({ path: `../screenshots/scratchpad-sessions-${phone ? 'phone' : 'desktop'}-${shell}.png` });
            assertColumns(boxes);

            await page.locator('#neconyan-scratchpad').evaluate(element => {
                element.style.width = '300px';
                element.style.left = 'auto';
            });
            await settleLayout();
            const narrow = await measureNarrow();
            await page.screenshot({ path: `../screenshots/scratchpad-sessions-${phone ? 'phone' : 'desktop'}-${shell}-narrow.png` });
            assertNarrow(narrow);

            await page.locator('#neconyan-scratchpad').evaluate(element => {
                element.style.width = '';
                element.style.left = '';
            });
            await settleLayout();
        }
        if (shellStyle) await shellStyle.evaluate(element => element.remove());
        await page.evaluate(() => {
            delete document.documentElement.dataset.sbTheme;
            delete document.body.dataset.sbTheme;
        });
    });
}
