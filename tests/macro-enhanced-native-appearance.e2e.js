/* global document, window, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { captureMacros, openMacros } from './macro-enhanced-native-helpers.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(240000);

async function primaryContrast(button) {
    return button.evaluate(async element => {
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
        const backgrounds = [];
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            backgrounds.unshift(getComputedStyle(ancestor).backgroundColor);
        }
        context.fillStyle = 'white';
        context.fillRect(0, 0, 1, 1);
        for (const background of backgrounds) {
            context.fillStyle = background;
            context.fillRect(0, 0, 1, 1);
        }
        const background = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        return contrastRatio(channels(style.color), background);
    });
}

async function undersizedControls(workbench) {
    return workbench.evaluate(root => [...root.querySelectorAll('button,input,select,textarea,summary,a[href]')]
        .filter(element => element.getClientRects().length && !element.disabled)
        .map(element => {
            const target = ['checkbox', 'radio'].includes(element.type) ? element.closest('label') ?? element : element;
            const bounds = target.getBoundingClientRect();
            return { name: element.getAttribute('aria-label') || element.textContent.trim() || element.id, width: bounds.width, height: bounds.height };
        }).filter(bounds => bounds.width < 43.9 || bounds.height < 43.9));
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} macro page has readable accents, solid surfaces and usable controls`, async ({ app }, info) => {
        const { page, workbench } = await openMacros(app, phone);
        const prefix = phone ? 'phone' : 'desktop';
        for (const [label, name] of [['Playground', 'workbench'], ['Reference', 'reference'], ['My macros', 'macros'], ['This chat', 'chat'], ['Setup', 'setup']]) {
            await workbench.getByRole('tab', { name: label, exact: true }).click();
            await expect.poll(() => undersizedControls(workbench), { message: `${label} controls have 44px targets` }).toEqual([]);
            await captureMacros(page, info, `${prefix}-${name}-after`);
        }

        await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
        const primary = workbench.getByRole('button', { name: 'New macro', exact: true }).first();
        const introduction = page.locator('.neconyan-included-tool-page[data-tool-page="macro-enhanced"] .neconyan-native-kicker');
        const metrics = [];
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            await expect.poll(() => primaryContrast(primary), { message: `${theme} default contrast` }).toBeGreaterThanOrEqual(4.5);
            metrics.push({ theme, accent: 'default', contrast: await primaryContrast(primary) });
            for (const accent of ['Mint Glass', 'Plum Wine']) {
                await page.locator(`.sb-accent-profile-apply[title="Apply ${accent}"]`).evaluate(element => element.click());
                await expect.poll(() => primaryContrast(primary), { message: `${theme} ${accent} contrast` }).toBeGreaterThanOrEqual(4.5);
                await expect.poll(() => primaryContrast(introduction), { message: `${theme} ${accent} introduction contrast` }).toBeGreaterThanOrEqual(4.5);
                metrics.push({ theme, accent, contrast: await primaryContrast(primary) });
                await captureMacros(page, info, `${prefix}-${theme.endsWith('Dark') ? 'dark' : 'light'}-${accent.toLowerCase().replaceAll(' ', '-')}-after`);
            }
        }
        await primary.click();
        await expect(workbench.locator('.me-macro-editor')).toBeVisible();
        await expect.poll(() => undersizedControls(workbench)).toEqual([]);
        await captureMacros(page, info, `${prefix}-editor-after`);
        for (const [shell, sheet] of [
            ['windows-98', 'link[data-sb-shell-style="windows-98"]'],
            ['windows-xp', 'link[data-sb-shell-style="windows-xp"]'],
            ['kittyless', 'link[data-sb-kittyless]'],
        ]) {
            await page.evaluate(shell => window.NeconyanShell.applyTheme(shell), shell);
            await page.waitForFunction(selector => document.querySelector(selector)?.sheet, sheet);
            const save = workbench.locator('.me-macro-editor').getByRole('button', { name: 'Save', exact: true });
            await expect.poll(() => primaryContrast(save), { message: `${shell} Save contrast` }).toBeGreaterThanOrEqual(4.5);
            await expect.poll(() => undersizedControls(workbench)).toEqual([]);
            await captureMacros(page, info, `${prefix}-${shell}-editor-after`);
        }
        await info.attach('contrast-measurements', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
        expect(app.provider.calls).toHaveLength(0);
    });
}

test('Narrow phone and tablet layouts keep the editor and navigation within the viewport', async ({ app }, info) => {
    const { page, workbench } = await openMacros(app, true);
    for (const width of [320, 768]) {
        await page.setViewportSize({ width, height: 852 });
        await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
        await workbench.getByRole('button', { name: 'New macro', exact: true }).first().click();
        const editor = workbench.locator('.me-macro-editor');
        await editor.getByRole('textbox', { name: /^Name/ }).fill('narrowview');
        await editor.getByRole('textbox', { name: 'What it expands to', exact: true }).fill('{{upper::A legible editor}}');
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const bounds = await editor.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await expect.poll(() => undersizedControls(workbench)).toEqual([]);
        await captureMacros(page, info, `${width}-editor-after`);
        await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
        await workbench.getByRole('tab', { name: 'Setup', exact: true }).click();
        await expect(workbench.getByRole('tab', { name: 'Setup', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    expect(app.provider.calls).toHaveLength(0);
});
