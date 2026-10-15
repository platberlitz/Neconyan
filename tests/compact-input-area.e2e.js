/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);
test.afterEach(async ({ page }) => page.unrouteAll({ behavior: 'wait' }));

async function prepareChat(page) {
    let initialLoad = true;
    await isolateSettingsSaves(page, settings => {
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        if (initialLoad) {
            settings.power_user.compact_input_area = true;
            initialLoad = false;
        }
    });
    await openReadyChat(page);
}

async function setCompactInput(page, compact) {
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    const checkbox = page.locator('#compact_input_area');
    if (!(await checkbox.isVisible())) {
        await page.locator('#ThemeTogglesSection > .inline-drawer-header').click();
    }
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save')
        && response.request().postDataJSON()?.power_user?.compact_input_area === compact);
    await checkbox.setChecked(compact);
    expect((await saved).ok()).toBe(true);
    await page.locator('#user-settings-block .sb-shell-close').click();
    await expect(page.locator('#user-settings-block')).toBeHidden();
    await waitForAnimationFrames(page);
}

async function geometry(page) {
    return page.evaluate(() => Object.fromEntries(
        ['nonQRFormItems', 'send_textarea', 'leftSendForm', 'rightSendForm', 'send_but'].map(id => [
            id, document.getElementById(id).getBoundingClientRect().toJSON(),
        ]),
    ));
}

async function expectPhoneLayout(page, compact) {
    await expect(page.locator('#send_form')).toHaveClass(compact ? /\bcompact\b/ : /^(?!.*\bcompact\b)/);
    const box = await geometry(page);
    const input = box.send_textarea;
    for (const rail of [box.leftSendForm, box.rightSendForm]) {
        if (compact) {
            expect(Math.abs((rail.top + rail.bottom) / 2 - (input.top + input.bottom) / 2)).toBeLessThan(1);
        } else {
            expect(rail.top).toBeGreaterThanOrEqual(input.bottom);
        }
    }
    if (compact) {
        expect(input.left - box.leftSendForm.right).toBeGreaterThanOrEqual(6);
        expect(box.rightSendForm.left - input.right).toBeGreaterThanOrEqual(6);
    } else {
        expect(input.width).toBeGreaterThan(box.nonQRFormItems.width - 12);
    }
    expect(box.send_but.width).toBe(box.send_but.height);
    expect(box.send_but.height).toBeLessThanOrEqual(44);
    expect(box.nonQRFormItems.left).toBeGreaterThanOrEqual(0);
    expect(box.nonQRFormItems.right).toBeLessThanOrEqual(page.viewportSize().width);
    expect(box.nonQRFormItems.bottom).toBeLessThanOrEqual(page.viewportSize().height);
    return box;
}

for (const phone of [
    { name: 'iPhone-sized', options: IPHONE_SAFARI_CONTEXT, ios: true },
    { name: 'small phone', options: { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true } },
]) {
    test.describe(`${phone.name}`, () => {
        test.use(phone.options);
        test('compact input changes the layout immediately and survives reloads', async ({ context, page }) => {
            if (phone.ios) await installIPhoneSafari(context, { standalone: true });
            await prepareChat(page);
            if (phone.ios) await applyIOSOnlyCss(page);
            // Use the actual connected state so Send participates in the layout.
            await page.evaluate(async () => (await import('/script.js')).setOnlineStatus('Composer layout fixture connection'));
            await expect(page.locator('#send_but')).toBeVisible();
            await waitForAnimationFrames(page, 3);
            const compact = await expectPhoneLayout(page, true);
            await page.locator('#send_textarea').fill('Keep this draft.');
            await setCompactInput(page, false);
            const expanded = await expectPhoneLayout(page, false);
            expect(expanded.send_textarea.width).toBeGreaterThan(compact.send_textarea.width + 100);
            expect(expanded.nonQRFormItems.height).toBeGreaterThan(compact.nonQRFormItems.height + 25);
            expect(expanded.send_but.width).toBe(compact.send_but.width);
            await expect(page.locator('#send_textarea')).toHaveValue('Keep this draft.');

            // The input setting remains independent of the whole-interface compact mode and scale.
            await page.evaluate(() => {
                document.documentElement.setAttribute('data-sb-compact-mode', 'true');
                document.documentElement.style.setProperty('--sb-bottom-bar-scale', '1.5');
            });
            await expectPhoneLayout(page, false);
            await page.locator('#send_textarea').fill('First line\nSecond line\nThird line');
            await page.locator('#send_textarea').blur();
            await waitForAnimationFrames(page, 3);
            await expectPhoneLayout(page, false);

            await openReadyChat(page);
            if (phone.ios) await applyIOSOnlyCss(page);
            // Reload has no connection; the full-width input must still fit above the tools.
            await expectPhoneLayout(page, false);
            await setCompactInput(page, true);
            await expectPhoneLayout(page, true);
            await openReadyChat(page);
            if (phone.ios) await applyIOSOnlyCss(page);
            await expectPhoneLayout(page, true);
        });
    });
}

test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 900 } });
    test('the phone-only input setting does not rearrange the desktop composer', async ({ page }) => {
        await prepareChat(page);
        await page.evaluate(async () => (await import('/script.js')).setOnlineStatus('Composer layout fixture connection'));
        await expect(page.locator('#send_but')).toBeVisible();
        await waitForAnimationFrames(page, 3);
        const before = await geometry(page);
        await setCompactInput(page, false);
        expect(await geometry(page)).toEqual(before);
        await setCompactInput(page, true);
        expect(await geometry(page)).toEqual(before);
    });
});
