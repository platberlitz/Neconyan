/* global document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('#neconyan-scratchpad')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
}

async function headerGeometry(page) {
    return page.evaluate(() => {
        const root = document.querySelector('#neconyan-scratchpad');
        const header = root.querySelector('.scratchpad-header');
        const title = root.querySelector('.scratchpad-title');
        const heading = root.querySelector('.scratchpad-heading');
        const actions = root.querySelector('.scratchpad-header-actions');
        const rect = element => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        };
        const textRect = element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return rect(range);
        };
        const headingText = textRect(heading);
        const actionsBox = rect(actions);
        return {
            root: rect(root),
            header: rect(header),
            title: rect(title),
            heading: { ...rect(heading), scrollWidth: heading.scrollWidth, clientWidth: heading.clientWidth },
            headingText,
            actions: actionsBox,
            headingOverlapsActions: headingText.left < actionsBox.right && headingText.right > actionsBox.left
                && headingText.top < actionsBox.bottom && headingText.bottom > actionsBox.top,
            buttons: [...actions.querySelectorAll('button')]
                .filter(button => !button.hidden && getComputedStyle(button).display !== 'none')
                .map(button => {
                    const box = button.getBoundingClientRect();
                    return { className: button.className, width: box.width, height: box.height };
                }),
        };
    });
}

function expectHeadingClear(geometry, label) {
    expect(geometry.headingOverlapsActions, label + ': heading must not be covered by the header actions').toBe(false);
    expect(geometry.headingText.width, label + ': heading text fits beside the actions').toBeLessThanOrEqual(geometry.title.width + 0.5);
    expect(geometry.heading.scrollWidth, label + ': heading is not clipped inside its title').toBeLessThanOrEqual(geometry.title.width + 0.5);
}

function expectPhoneTargets(geometry, label) {
    for (const button of geometry.buttons) {
        expect(button.height, label + ': ' + button.className + ' keeps a 44px phone target').toBeGreaterThanOrEqual(44);
        expect(button.width, label + ': ' + button.className + ' keeps a 44px phone target').toBeGreaterThanOrEqual(44);
    }
}

async function expectLongHeadingWraps(page, label) {
    const heading = page.locator('.scratchpad-heading');
    await heading.evaluate(element => { element.textContent = 'ScratchpadScratchpad'; });
    const geometry = await headerGeometry(page);
    expect(geometry.header.height, label + ': the long heading wraps inside its title').toBeGreaterThan(80);
    expect(geometry.headingText.height, label + ': the long heading occupies more than one line').toBeGreaterThan(24);
    expectHeadingClear(geometry, label + ' long heading');
    await expect(heading).toHaveText('ScratchpadScratchpad');
    await heading.evaluate(element => { element.textContent = 'Scratchpad'; });
}

test('phone Scratchpad header keeps the heading clear at 393 and the supported 320 width', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account({ phone: true, contextOptions: { reducedMotion: 'reduce' } });
    const page = await account.open();
    await openScratchpad(page);

    const normal = await headerGeometry(page);
    expect(normal.root.width).toBe(393);
    expect(normal.root.left).toBe(0);
    expect(normal.header.height, 'phone 393 header stays on one row').toBeLessThan(80);
    expectHeadingClear(normal, 'phone 393');
    expectPhoneTargets(normal, 'phone 393');
    await expect(page.locator('.scratchpad-header').getByRole('button', { name: 'Back to chat', exact: true })).toBeVisible();
    await expect(page.locator('.scratchpad-header').getByRole('button', { name: /^(New session|Start a new Scratchpad session)$/ })).toBeVisible();

    await expectLongHeadingWraps(page, 'phone 393');

    await page.setViewportSize({ width: 320, height: 568 });
    await expect.poll(() => page.locator('#neconyan-scratchpad').evaluate(element => element.getBoundingClientRect().width)).toBe(320);
    const narrow = await headerGeometry(page);
    expect(narrow.root.width).toBe(320);
    expect(narrow.root.left).toBe(0);
    expect(narrow.header.height, 'phone 320 header wraps the actions below the title').toBeGreaterThan(100);
    expect(narrow.actions.top, 'phone 320 actions sit below the title').toBeGreaterThanOrEqual(narrow.title.bottom);
    expectHeadingClear(narrow, 'phone 320');
    expectPhoneTargets(narrow, 'phone 320');
    await expect(page.locator('.scratchpad-header').getByRole('button', { name: 'Back to chat', exact: true })).toBeVisible();
    await expect(page.locator('.scratchpad-header').getByRole('button', { name: /^(New session|Start a new Scratchpad session)$/ })).toBeVisible();

    const previousTheme = await page.evaluate(() => document.documentElement.dataset.sbTheme ?? '');
    for (const shell of ['windows-98', 'windows-xp']) {
        const sheet = await page.addStyleTag({ url: `/css/shell-styles/${shell}.css` });
        await page.evaluate(theme => { document.documentElement.dataset.sbTheme = theme; }, shell);
        const themed = await headerGeometry(page);
        expectHeadingClear(themed, 'phone 320 ' + shell);
        expectPhoneTargets(themed, 'phone 320 ' + shell);
        await sheet.evaluate(element => element.remove());
    }
    await page.evaluate(theme => {
        if (theme) document.documentElement.dataset.sbTheme = theme;
        else delete document.documentElement.dataset.sbTheme;
    }, previousTheme);
});

test('desktop Scratchpad header keeps the heading clear at the default and minimum panel widths', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account({ phone: false, contextOptions: { reducedMotion: 'reduce' } });
    const page = await account.open();
    await openScratchpad(page);

    const normal = await headerGeometry(page);
    expect(normal.root.width).toBe(420);
    expect(normal.header.height, 'default desktop header stays on one row').toBeLessThan(80);
    expectHeadingClear(normal, 'desktop 420');
    for (const button of normal.buttons) expect(button.height).toBeGreaterThanOrEqual(36);
    await expect(page.locator('.scratchpad-header').getByRole('button', { name: 'Back to chat', exact: true })).toBeVisible();
    await expect(page.locator('.scratchpad-header').getByRole('button', { name: /^(Full width|Beside chat)$/ })).toBeVisible();

    await expectLongHeadingWraps(page, 'desktop 420');

    const resizer = page.locator('.scratchpad-resizer');
    await resizer.focus();
    for (let index = 0; index < 6; index++) await resizer.press('ArrowRight');
    await expect.poll(() => page.locator('#neconyan-scratchpad').evaluate(element => element.getBoundingClientRect().width)).toBe(320);
    const narrow = await headerGeometry(page);
    expect(narrow.header.height, 'minimum desktop panel wraps the actions below the title').toBeGreaterThan(100);
    expect(narrow.actions.top, 'minimum desktop panel actions sit below the title').toBeGreaterThanOrEqual(narrow.title.bottom);
    expectHeadingClear(narrow, 'desktop 320');
    for (const button of narrow.buttons) expect(button.height).toBeGreaterThanOrEqual(36);
    await expect(page.locator('.scratchpad-header').getByRole('button', { name: 'Back to chat', exact: true })).toBeVisible();
    await expect(page.locator('.scratchpad-header').getByRole('button', { name: /^(Full width|Beside chat)$/ })).toBeVisible();
});
