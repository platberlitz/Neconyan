/* global window, document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

async function expectReachable(button) {
    await expect(button).toBeInViewport({ ratio: 1 });
    const geometry = await button.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
            width: rect.width, height: rect.height,
            unobscured: element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
        };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(44);
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.unobscured).toBe(true);
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Lorebooks shortcut opens World Info Lab and returns to the current book`, async ({ app }) => {
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        await account.post('/api/worldinfo/edit', { name: 'Garden', data: { entries: {
            0: { uid: 0, key: ['garden'], comment: 'Moon garden', content: 'The garden opens at dusk.' },
        } } });
        const page = await account.open({ workspace: false, timeout: 60000 });
        await page.waitForFunction(async () => {
            const { eventSource, event_types } = await import('/scripts/events.js');
            return eventSource.autoFireLastArgs.has(event_types.APP_READY);
        });
        await expect(page.locator('#neconyan-home-skeleton')).toBeHidden();
        if (phone) await page.locator('#sb-hamburger').click();
        await page.locator('#neconyan-workspace-rail [data-neconyan-route="lorebooks"]').click();
        const library = page.locator('#neconyan-lorebook-library');
        await expect(library).toHaveAttribute('data-view', 'library');
        await library.getByRole('button', { name: 'Not now', exact: true }).click();
        await page.evaluate(() => window.toastr.remove());
        if (phone) await applyIOSOnlyCss(page);
        const button = library.getByRole('button', { name: 'World Info Lab', exact: true });
        await expect(button).toHaveCount(1);
        await expectReachable(button);
        await page.screenshot({ path: `../screenshots/world-info-lab-${phone ? 'phone' : 'desktop'}-after.png`, scale: 'css' });

        const lab = page.getByRole('dialog', { name: 'World Info Lab', exact: true });
        await button.click();
        await expect(lab).toBeVisible();
        await expect(lab.getByRole('heading', { name: 'Choose what to scan', exact: true })).toBeVisible();
        await lab.getByRole('button', { name: 'Close workspace', exact: true }).click();
        await expect(lab).toBeHidden();
        await expect(library).toBeVisible();
        await expect(library).toHaveAttribute('data-view', 'library');
        await expect(button).toBeFocused();

        await page.getByRole('button', { name: 'Open Garden', exact: true }).click();
        await expect(library).toHaveAttribute('data-view', 'book');
        await expectReachable(button);
        await page.screenshot({ path: `../screenshots/world-info-lab-${phone ? 'phone' : 'desktop'}-book-after.png`, scale: 'css' });
        await button.focus();
        await button.press('Enter');
        await expect(lab).toBeVisible();
        // A real pointer interaction inside the full-page tool must not dismiss Lorebooks behind it.
        await lab.getByRole('radio', { name: 'Pasted text', exact: true }).check();
        await lab.locator('#sbwil-pasted-text').fill('The garden opens at dusk.');
        await page.keyboard.press('Escape');
        await expect(lab).toBeHidden();
        await expect(library).toBeVisible();
        await expect(library).toHaveAttribute('data-view', 'book');
        await expect(library.locator('.neconyan-lorebook-selected')).toContainText('Garden');
        await expect(page.locator('#world_editor_select option:checked')).toHaveText('Garden');
        await expect(button).toBeFocused();

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Mint Glass', 'Plum Wine']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[title="Apply ${accent}"]`).evaluate(element => element.click());
                await expect.poll(() => button.evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const style = getComputedStyle(element);
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d');
                    const channels = colour => {
                        context.clearRect(0, 0, 1, 1);
                        context.fillStyle = colour;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
                    };
                    return contrastRatio(channels(style.color), channels(style.backgroundColor));
                }), { message: `${theme}, ${accent || 'default'} button contrast` }).toBeGreaterThanOrEqual(4.5);
            }
        }

        await page.evaluate(async () => {
            const { unmountRuntimeUi } = await import('/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/ui/runtime.js');
            unmountRuntimeUi();
        });
        await expect(button).toHaveCount(0);
        await page.evaluate(async () => {
            const { mountRuntimeUi } = await import('/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/ui/runtime.js');
            mountRuntimeUi();
            mountRuntimeUi();
        });
        await expect(button).toHaveCount(1);
        await button.press('Space');
        await expect(lab).toBeVisible();
        await lab.getByRole('button', { name: 'Close workspace', exact: true }).click();
        await expect(button).toBeFocused();
    });
}
