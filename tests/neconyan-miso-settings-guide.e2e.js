/* global document, window, HTMLInputElement */
import { expect, test } from '@playwright/test';
import { dismissOnboardingIfPresent, isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

const APP_URL = process.env.NECONYAN_TEST_BASE_URL || '/';
const GUIDE = '#nn-settings-miso-guide';
const TRIGGER = '#nn-settings-ask-miso';

test.describe.configure({ mode: 'serial' });
test.setTimeout(180000);

async function openSettings(page) {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 45000 });
    await dismissOnboardingIfPresent(page);
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    await expect(page.locator('#sb-settings-tabs')).toBeVisible({ timeout: 45000 });
    await expect(page.locator(TRIGGER)).toBeVisible();
}

async function openGuide(page) {
    await page.locator(TRIGGER).click();
    await expect(page.locator(GUIDE)).toBeVisible();
    await expect(page.locator(`${GUIDE} .nn-miso-guide-title`)).toHaveText('Help me choose');
    await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'true');
}

async function clearMisoAnswers(page) {
    await page.evaluate(() => {
        window.SillyTavern.getContext().accountStorage.removeItem('NeconyanMisoSettingsGuide.v1');
    });
}

function isQuickImpersonateSave(request, expected) {
    try {
        return request.url().endsWith('/api/settings/save')
            && request.postDataJSON()?.power_user?.quick_impersonate === expected;
    } catch {
        return false;
    }
}

async function closeGuideWithEscape(page) {
    await page.locator(`${GUIDE} .nn-miso-guide-title`).focus();
    await page.keyboard.press('Escape');
    await expect(page.locator(GUIDE)).toBeHidden();
    await expect(page.locator(TRIGGER)).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('nn-settings-ask-miso');
}

async function setBaseline(page) {
    await page.evaluate(() => {
        window.NeconyanShell.setCompactMode(false);
        const setCheckbox = (id, value) => {
            const input = document.getElementById(id);
            if (!(input instanceof HTMLInputElement)) throw new Error(`${id} is missing`);
            input.checked = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setCheckbox('messageTokensEnabled', true);
        setCheckbox('messageTimerEnabled', true);
        setCheckbox('messageModelNameEnabled', true);
        setCheckbox('play_message_sound', false);
        setCheckbox('play_sound_unfocused', true);
    });
}

async function readSettings(page) {
    return page.evaluate(() => {
        const checked = id => {
            const input = document.getElementById(id);
            return input instanceof HTMLInputElement ? input.checked : null;
        };
        return {
            compact: window.NeconyanShell.getCompactMode(),
            tokenCount: checked('messageTokensEnabled'),
            timer: checked('messageTimerEnabled'),
            modelName: checked('messageModelNameEnabled'),
            messageSound: checked('play_message_sound'),
            backgroundSound: checked('play_sound_unfocused'),
        };
    });
}

async function answerAllFour(page) {
    const guide = page.locator(GUIDE);
    await expect(page.locator(`${GUIDE} .nn-miso-guide-progress`)).toHaveText('Step 1 of 4');
    await page.locator('#nn-miso-guide-look-compact').check();
    await guide.getByRole('button', { name: 'Next', exact: true }).click();

    await expect(page.locator(`${GUIDE} .nn-miso-guide-progress`)).toHaveText('Step 2 of 4');
    await page.locator('#nn-miso-guide-reading-hide_details').check();
    await guide.getByRole('button', { name: 'Next', exact: true }).click();

    await expect(page.locator(`${GUIDE} .nn-miso-guide-progress`)).toHaveText('Step 3 of 4');
    await page.locator('#nn-miso-guide-chatting-chime').check();
    await guide.getByRole('button', { name: 'Next', exact: true }).click();

    await expect(page.locator(`${GUIDE} .nn-miso-guide-progress`)).toHaveText('Step 4 of 4');
    await expect(page.locator('#nn-miso-guide-device-keep')).toBeChecked();
    await guide.getByRole('button', { name: 'Show my settings', exact: true }).click();
    await expect(guide.getByRole('heading', { name: 'Settings Miso suggests' })).toBeVisible();
}

test('desktop: four questions apply real settings, undo guards an outside change, and answers reopen', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    await isolateSettingsSaves(page);
    try {
        await openSettings(page);
        await setBaseline(page);
        await clearMisoAnswers(page);
        const before = await readSettings(page);

        await expect(page.locator('#sb-settings-tabs .sb-settings-tab-btn')).toHaveCount(4);
        await expect(page.locator('#sb-settings-tabs')).not.toContainText('Help me choose');
        await openGuide(page);
        await closeGuideWithEscape(page);
        await openGuide(page);

        await answerAllFour(page);
        await expect(page.locator('#nn-miso-guide-pick-compactMode')).toBeChecked();
        await expect(page.locator('#nn-miso-guide-pick-messageTokenCount')).toBeChecked();
        await expect(page.locator('#nn-miso-guide-pick-messageTimer')).toBeChecked();
        await expect(page.locator('#nn-miso-guide-pick-messageModelName')).toBeChecked();
        await expect(page.locator('#nn-miso-guide-pick-messageSound')).toBeChecked();
        await expect(page.locator(GUIDE)).toContainText('sends no model request');

        await page.locator('#nn-miso-guide-apply').click();
        const applied = page.locator(`${GUIDE} .nn-miso-guide-applied`);
        await expect(applied).toContainText(/Applied \d+ settings?\./);
        await expect(page.locator('#nn-miso-guide-undo')).toBeEnabled();
        const afterApply = await readSettings(page);
        expect(afterApply).toEqual({
            compact: true,
            tokenCount: false,
            timer: false,
            modelName: false,
            messageSound: true,
            backgroundSound: true,
        });

        await page.evaluate(() => {
            const input = document.getElementById('messageTokensEnabled');
            input.checked = true;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        // The settings listener disables Undo before another click can overwrite the change.
        await expect(page.locator(`${GUIDE} .nn-miso-guide-undo-blocked`)).toContainText(/changed elsewhere/);
        await expect(page.locator('#nn-miso-guide-undo')).toBeDisabled();
        expect(await readSettings(page)).toEqual({ ...afterApply, tokenCount: true });

        await page.evaluate(() => {
            const input = document.getElementById('messageTokensEnabled');
            input.checked = false;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.locator('#nn-miso-guide-inline-close').click();
        await expect(page.locator(GUIDE)).toBeHidden();
        await openGuide(page);
        await expect(page.locator('#nn-miso-guide-undo')).toBeEnabled();
        await page.locator('#nn-miso-guide-undo').click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-status`)).toContainText(/Put \d+ settings? back\./);
        await expect(page.locator(`${GUIDE} .nn-miso-guide-applied`)).toHaveCount(0);
        expect(await readSettings(page)).toEqual(before);

        await page.locator('#nn-miso-guide-apply').click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-applied`)).toBeVisible();
        await page.waitForResponse(response => response.url().endsWith('/api/settings/save')
            && Boolean(response.request().postDataJSON()?.accountStorage?.['NeconyanMisoSettingsGuide.v1']), { timeout: 15000 });
        const afterSecondApply = await readSettings(page);

        await openSettings(page);
        expect(await readSettings(page)).toEqual(afterSecondApply);
        await openGuide(page);
        await expect(page.locator(`${GUIDE} .nn-miso-guide-results-title`)).toHaveText('Settings Miso suggests');
        await expect(page.locator('#nn-miso-guide-last-answers')).toBeEnabled();
        await expect(page.locator('#nn-miso-guide-pick-compactMode')).toBeChecked();
        await page.locator('#nn-miso-guide-change').click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-progress`)).toHaveText('Step 1 of 4');
        await expect(page.locator('#nn-miso-guide-look-compact')).toBeChecked();
    } finally {
        await context.close();
    }
});

test('low-memory undo restores the raw window and leaves the explicit choices untouched', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    await isolateSettingsSaves(page);
    try {
        await openSettings(page);
        await clearMisoAnswers(page);
        await page.evaluate(() => {
            const mode = document.getElementById('low_memory_mode');
            mode.value = 'on';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
            const truncation = document.getElementById('chat_truncation');
            truncation.value = '100';
            truncation.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('low_memory_use_recommendations').click();
        });
        await expect(page.locator('#low_memory_mode_status')).toContainText('up to 25 rendered Roleplay messages');

        await openGuide(page);
        const guide = page.locator(GUIDE);
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await page.locator('#nn-miso-guide-device-plenty').check();
        await guide.getByRole('button', { name: 'Show my settings', exact: true }).click();
        await expect(page.locator('#nn-miso-guide-pick-lowMemoryMode')).toBeChecked();
        await expect(page.locator('#nn-miso-guide-pick-chatTruncation')).toBeChecked();
        await page.locator('#nn-miso-guide-apply').click();
        await expect(page.locator('#low_memory_mode')).toHaveValue('off');
        await expect(page.locator('#chat_truncation')).toHaveValue('150');

        await page.locator('#nn-miso-guide-undo').click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-status`)).toContainText('Put 2 settings back.');
        await expect(page.locator('#low_memory_mode')).toHaveValue('on');
        await expect(page.locator('#chat_truncation')).toHaveValue('100');
        await expect(page.locator('#low_memory_mode_status')).toContainText('up to 25 rendered Roleplay messages');

        await page.evaluate(() => {
            const mode = document.getElementById('low_memory_mode');
            mode.value = 'off';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
            mode.value = 'on';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(page.locator('#low_memory_mode_status')).toContainText('up to 25 rendered Roleplay messages');
    } finally {
        await context.close();
    }
});

test('calmer motion turns blur off even though its control listens for change, and undo puts it back', async ({ browser }) => {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: 'no-preference',
        serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await isolateSettingsSaves(page);
    try {
        await openSettings(page);
        await clearMisoAnswers(page);
        await page.evaluate(() => {
            const mode = document.getElementById('low_memory_mode');
            mode.value = 'off';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
            const fastUi = document.getElementById('fast_ui_mode');
            fastUi.checked = false;
            fastUi.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(page.locator('#fast_ui_mode')).not.toBeChecked();
        expect(await page.evaluate(() => document.body.classList.contains('no-blur'))).toBe(false);

        await openGuide(page);
        const guide = page.locator(GUIDE);
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await page.locator('#nn-miso-guide-reading-calm_motion').check();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Show my settings', exact: true }).click();
        await page.locator('#nn-miso-guide-apply').click();

        await expect(page.locator(`${GUIDE} .nn-miso-guide-applied`)).toBeVisible();
        await expect(page.locator('#fast_ui_mode')).toBeChecked();
        expect(await page.evaluate(() => document.body.classList.contains('no-blur'))).toBe(true);

        await page.locator('#nn-miso-guide-undo').click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-status`)).toContainText(/Put \d+ settings? back\./);
        await expect(page.locator('#fast_ui_mode')).not.toBeChecked();
        expect(await page.evaluate(() => document.body.classList.contains('no-blur'))).toBe(false);
    } finally {
        await context.close();
    }
});

test('a stale Impersonate checkbox still applies and undoes the stored value', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    await isolateSettingsSaves(page);
    try {
        await openSettings(page);
        await clearMisoAnswers(page);
        await page.evaluate(() => {
            const target = (id, value, eventName = 'input') => {
                const input = document.getElementById(id);
                input.checked = value;
                input.dispatchEvent(new Event(eventName, { bubbles: true }));
            };
            target('quick_continue', true);
            target('quick_impersonate', false);
            // A stale visual state with no event, like the old quick_continue initialiser.
            document.getElementById('quick_impersonate').checked = true;
        });

        await openGuide(page);
        const guide = page.locator(GUIDE);
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await page.locator('#nn-miso-guide-chatting-quick_helpers').check();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Show my settings', exact: true }).click();
        await expect(page.locator('#nn-miso-guide-pick-quickContinue')).toBeDisabled();
        await expect(page.locator('#nn-miso-guide-pick-quickImpersonate')).toBeChecked();

        const appliedSave = page.waitForRequest(request => isQuickImpersonateSave(request, true), { timeout: 15000 });
        await page.locator('#nn-miso-guide-apply').click();
        await appliedSave;
        await expect(page.locator('#quick_impersonate')).toBeChecked();
        await expect(page.locator('#quick_continue')).toBeChecked();

        const undoSave = page.waitForRequest(request => isQuickImpersonateSave(request, false), { timeout: 15000 });
        await page.locator('#nn-miso-guide-undo').click();
        await undoSave;
        await expect(page.locator('#quick_impersonate')).not.toBeChecked();
        await expect(page.locator('#quick_continue')).toBeChecked();
    } finally {
        await context.close();
    }
});

test('aggressive unloading skips the impossible messages-to-load suggestion', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    await isolateSettingsSaves(page);
    try {
        await openSettings(page);
        await clearMisoAnswers(page);
        await page.evaluate(() => {
            const mode = document.getElementById('low_memory_mode');
            mode.value = 'on';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
            const aggressive = document.getElementById('aggressive_dom_unload');
            aggressive.checked = true;
            aggressive.dispatchEvent(new Event('input', { bubbles: true }));
            const aggressiveSize = document.getElementById('aggressive_dom_window_size');
            aggressiveSize.value = '5';
            aggressiveSize.dispatchEvent(new Event('input', { bubbles: true }));
            const truncation = document.getElementById('chat_truncation');
            truncation.value = '100';
            truncation.dispatchEvent(new Event('input', { bubbles: true }));
        });

        await openGuide(page);
        const guide = page.locator(GUIDE);
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await page.locator('#nn-miso-guide-device-plenty').check();
        await guide.getByRole('button', { name: 'Show my settings', exact: true }).click();
        await expect(page.locator('#nn-miso-guide-pick-lowMemoryMode')).toBeChecked();
        await expect(page.locator('#nn-miso-guide-pick-chatTruncation')).toHaveCount(0);
        await expect(page.locator(`${GUIDE} .nn-miso-guide-skipped`)).toContainText('Aggressive unloading keeps the chat at 5 messages');

        await page.locator('#nn-miso-guide-apply').click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-applied`)).toBeVisible();
        await expect(page.locator('#low_memory_mode')).toHaveValue('off');
        await expect(page.locator('#chat_truncation')).toHaveValue('100');

        await page.locator('#nn-miso-guide-undo').click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-status`)).toContainText('Put 1 setting back.');
        await expect(page.locator('#low_memory_mode')).toHaveValue('on');
        await expect(page.locator('#chat_truncation')).toHaveValue('100');
    } finally {
        await context.close();
    }
});

test('a settings change refreshes results without losing a manual untick', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    await isolateSettingsSaves(page);
    try {
        await openSettings(page);
        await setBaseline(page);
        await clearMisoAnswers(page);
        await openGuide(page);
        const guide = page.locator(GUIDE);
        await page.locator('#nn-miso-guide-look-compact').check();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await page.locator('#nn-miso-guide-reading-hide_details').check();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Show my settings', exact: true }).click();

        await page.locator('#nn-miso-guide-pick-messageTokenCount').uncheck();
        await page.evaluate(() => {
            const timer = document.getElementById('messageTimerEnabled');
            timer.checked = false;
            timer.dispatchEvent(new Event('input', { bubbles: true }));
        });

        await expect(page.locator('#nn-miso-guide-pick-messageTimer')).toBeDisabled({ timeout: 3000 });
        await expect(page.locator('#nn-miso-guide-pick-messageTimer')).toBeChecked();
        await expect(page.locator('#nn-miso-guide-pick-messageTokenCount')).not.toBeChecked();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-results-title`)).toHaveText('Settings Miso suggests');
    } finally {
        await context.close();
    }
});

test('phone: guide opens, closes with Escape, fits the viewport and applies a setting', async ({ browser }) => {
    const context = await browser.newContext({
        viewport: { width: 393, height: 852 },
        hasTouch: true,
        isMobile: true,
        serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await isolateSettingsSaves(page);
    try {
        await openSettings(page);
        await setBaseline(page);
        await clearMisoAnswers(page);
        await openGuide(page);

        const width = await page.locator(GUIDE).evaluate(element => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
            right: element.getBoundingClientRect().right,
        }));
        expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
        expect(width.right).toBeLessThanOrEqual(393);
        const optionHeight = await page.locator(`${GUIDE} .nn-miso-guide-option`).first().evaluate(element => element.getBoundingClientRect().height);
        expect(optionHeight).toBeGreaterThanOrEqual(44);
        const triggerBox = await page.locator(TRIGGER).evaluate(element => {
            const box = element.getBoundingClientRect();
            return { height: box.height, width: box.width };
        });
        expect(triggerBox.height).toBeGreaterThanOrEqual(44);
        expect(triggerBox.width).toBeGreaterThanOrEqual(44);
        const closeHeight = await page.locator(`${GUIDE} .nn-miso-guide-close`).evaluate(element => element.getBoundingClientRect().height);
        expect(closeHeight).toBeGreaterThanOrEqual(44);

        await closeGuideWithEscape(page);
        await openGuide(page);

        const guide = page.locator(GUIDE);
        await page.locator('#nn-miso-guide-look-compact').check();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await guide.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-progress`)).toHaveText('Step 4 of 4');
        await guide.getByRole('button', { name: 'Show my settings', exact: true }).click();

        await expect(page.locator('#nn-miso-guide-pick-compactMode')).toBeChecked();
        await page.locator('#nn-miso-guide-apply').click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-applied`)).toContainText(/Applied 1 setting\./);
        expect((await readSettings(page)).compact).toBe(true);
        await page.locator('#nn-miso-guide-undo').click();
        await expect(page.locator(`${GUIDE} .nn-miso-guide-status`)).toContainText('Put 1 setting back.');
        expect((await readSettings(page)).compact).toBe(false);
    } finally {
        await context.close();
    }
});
