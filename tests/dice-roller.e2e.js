/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-conditional-in-test -- Viewport setup and named accent variants share the same checks. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(240000);

const SCREENSHOTS = process.env.NECONYAN_DICE_SCREENSHOTS || '';
const ROLL = '🎲 Pick the lock - rolled 18 vs 12 (1d20: 18) - SUCCESS';
const DIRECTIVE = '[Dice result for User]\nPick the lock: SUCCESS.';

function enableDice(saved, location) {
    const settings = saved.extension_settings;
    settings.disabledExtensions = (settings.disabledExtensions || []).filter(name => name !== 'dice-roller');
    settings.bundledOptInProcessedExtensions = [...new Set([...(settings.bundledOptInProcessedExtensions || []), 'dice-roller'])];
    saved.power_user.reply_generation_location = location;
}

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await expect(page.locator('#chat .mes').first()).toContainText('Hello.');
    return page;
}

async function shot(page, name) {
    if (!SCREENSHOTS) return;
    await page.screenshot({ path: path.join(SCREENSHOTS, name) });
}

function promptText(call) {
    return (call?.messages || []).map(message => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`);
}

for (const [location, phone] of [['browser', false], ['server', true]]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} dice roll reaches the ${location} reply as a settled result`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, contextOptions: { reducedMotion: 'no-preference' },
            configureSettings: saved => enableDice(saved, location) });
        const page = await openChat(account);
        const composerButton = page.locator('#neco-dice-composer-button');
        await expect(composerButton).toBeVisible();
        await expect(page.locator('#neco-dice-wand-button')).toHaveCount(1);
        await shot(page, `dice-${viewport}-composer.png`);

        // 0.85 lands every d20 on 18.
        await page.evaluate(() => { Math.random = () => 0.85; });
        await composerButton.click();
        const panel = page.locator('.neco-dice');
        await expect(panel).toBeVisible();
        await expect(panel).toHaveAttribute('data-outcome', 'success');
        await panel.getByLabel('What are you attempting?').fill('Pick the lock');
        await panel.locator('.neco-dice-roll').click();
        await expect(panel).toHaveClass(/is-rolling/);
        await shot(page, `dice-${viewport}-rolling.png`);
        await expect(panel).not.toHaveClass(/is-rolling/);
        await expect(panel.locator('.neco-dice-outcome')).toContainText('Success');
        await shot(page, `dice-${viewport}-success.png`);

        const before = app.provider.calls.length;
        const send = panel.getByRole('button', { name: 'Send', exact: true });
        await expect(send).toBeInViewport({ ratio: 1 });
        await send.click();
        await expect(panel).toBeHidden();
        await expect.poll(() => app.provider.calls.length, { timeout: 60000 }).toBeGreaterThan(before);
        const lines = promptText(app.provider.calls.at(-1));
        const userIndex = lines.findIndex(line => line.includes(ROLL));
        const directiveIndex = lines.findIndex(line => line.startsWith('system: ') && line.includes(DIRECTIVE));
        expect(userIndex, lines.join('\n')).toBeGreaterThanOrEqual(0);
        expect(directiveIndex, lines.join('\n')).toBeGreaterThan(userIndex);
        expect(lines[directiveIndex]).toContain('keep the dice, the numbers and the word roll out of the reply');

        const chip = page.locator('#chat .mes[is_user="true"] .neco-dice-chip').last();
        await expect(chip).toBeVisible();
        await expect(chip).toHaveAttribute('data-outcome', 'success');
        await expect.poll(() => page.locator('#chat .mes').count(), { timeout: 60000 }).toBeGreaterThanOrEqual(3);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press)).toBe(false);
        await shot(page, `dice-${viewport}-chat.png`);

        // An ordinary message afterwards carries no dice result.
        const next = app.provider.calls.length;
        await page.locator('#send_textarea').fill('Look around the room.');
        await page.locator('#send_but').click();
        await expect.poll(() => app.provider.calls.length, { timeout: 60000 }).toBeGreaterThan(next);
        expect(promptText(app.provider.calls.at(-1)).join('\n')).not.toContain('[Dice result for');
        expect(await page.evaluate(() => document.querySelectorAll('.neco-dice-popup').length)).toBe(0);
        expect(await page.evaluate(() => typeof window.necoDiceRollerInterceptor)).toBe('function');
    });

    test(`${viewport} dice buttons stay readable with default, pale and dark accents`, async ({ app }) => {
        const account = await app.account({ phone, configureSettings: saved => enableDice(saved, location) });
        const page = await openChat(account);
        await page.addStyleTag({ content: '#toast-container { display: none; }' });
        await page.locator('#neco-dice-composer-button').click();
        const panel = page.locator('.neco-dice');
        await expect(panel).toHaveAttribute('data-outcome', /./);
        const controls = [
            ['pressed die', '.neco-dice-segment[aria-pressed="true"]'],
            ['die', '.neco-dice-segment[aria-pressed="false"]'],
            ['step', '.neco-dice-step:not(:disabled)'],
            ['add', '.neco-dice-actions .menu_button:not(.menu_button_primary)'],
            ['send', '.neco-dice-actions .menu_button_primary'],
        ];
        const results = [];
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            // The theme picker sits in a closed settings drawer.
            // eslint-disable-next-line playwright/no-force-option
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                for (const [name, selector] of controls) {
                    const measured = await panel.locator(selector).first().evaluate(async element => {
                        const { contrastRatio } = await import('/scripts/theme-contrast.js');
                        const canvas = document.createElement('canvas').getContext('2d');
                        const channels = colour => {
                            canvas.clearRect(0, 0, 1, 1);
                            canvas.fillStyle = colour;
                            canvas.fillRect(0, 0, 1, 1);
                            return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
                        };
                        const style = getComputedStyle(element);
                        const rect = element.getBoundingClientRect();
                        return { ratio: contrastRatio(channels(style.color), channels(style.backgroundColor)), color: style.color, background: style.backgroundColor, height: rect.height };
                    });
                    results.push({ theme, accent, name, ...measured });
                    expect(measured.ratio, JSON.stringify(results.at(-1))).toBeGreaterThanOrEqual(4.5);
                    expect(measured.height, name).toBeGreaterThanOrEqual(phone ? 44 : 32);
                }
                if (accent === 'Pearl' || accent === 'Midnight Ink') await shot(page, `dice-${viewport}-${theme === 'Neconyan Calico' ? 'light' : 'dark'}-${accent.split(' ')[0].toLowerCase()}.png`);
            }
        }
        await test.info().attach('accent-measurements', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    });
}
