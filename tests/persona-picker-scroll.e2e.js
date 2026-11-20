/* global document, window */
import { expect, test } from '@playwright/test';
import { installSyntheticLongChat, isolateSettingsSaves, openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

for (const phone of [true, false]) {
    test.describe(`Bottom bar persona scroll on ${phone ? 'phone' : 'desktop'}`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });
        const press = phone ? locator => locator.tap() : locator => locator.click();
        const pressAt = phone ? (page, x, y) => page.touchscreen.tap(x, y) : (page, x, y) => page.mouse.click(x, y);
        const checkFocus = phone ? () => {} : checkbox => expect(checkbox).toBeFocused();

        test.beforeEach(async ({ page, context }) => {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage ??= {};
                settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
                settings.accountStorage['neconyanToolTourInvite.persona'] = 'seen';
            });
            await openQuietChatForSmoke(page);
            await expect(page.locator('#neconyan-home-skeleton')).toBeHidden();
            if (phone) await applyIOSOnlyCss(page);
            await installSyntheticLongChat(page, { messageCount: 24 });
            await page.evaluate(() => {
                const ctx = window.SillyTavern.getContext();
                const { powerUserSettings: settings, userAvatar } = ctx;
                settings.personas = { [userAvatar]: 'Original Persona' };
                settings.persona_descriptions[userAvatar] = {
                    description: 'Original description.',
                    appendices: Array.from({ length: 10 }, (_, index) => ({
                        id: `note-${index + 1}`, name: `Scenario ${index + 1}`, description: `Details ${index + 1}`,
                    })),
                };
                for (let i = 1; i <= 9; i++) {
                    settings.personas[`alternate-${i}.png`] = `Alternate ${i}`;
                    settings.persona_descriptions[`alternate-${i}.png`] = {
                        description: `Alternate description ${i}.`,
                        appendices: [{ id: 'alternate-note', name: 'Alternate Scenario', description: 'Alternate details.' }],
                    };
                }
                document.querySelectorAll('#nn-update-toast, #toast-container').forEach(element => element.remove());
                document.querySelector('#chat').scrollTop = 550;
            });
        });

        test('keeps its place when toggling Scenario Notes and switching personas', async ({ page }) => {
            const bubble = page.locator('#sb-persona-bubble');
            const picker = page.getByRole('dialog', { name: 'Switch persona' });
            const notes = picker.getByRole('group', { name: 'Use with Scenario Notes' });
            const personas = picker.getByRole('group', { name: 'Choose persona' });
            const chat = page.locator('#chat');
            const scrollTop = locator => locator.evaluate(element => element.scrollTop);
            const chatScroll = await scrollTop(chat);
            expect(chatScroll).toBeGreaterThan(0);
            await press(bubble);
            const alternate = personas.getByRole('button', { name: 'Alternate 9', exact: true });
            await expect(personas.getByRole('button', { pressed: true })).toBeFocused();
            await alternate.scrollIntoViewIfNeeded();
            expect(await scrollTop(personas)).toBeGreaterThan(0);
            const checkbox = notes.getByRole('checkbox', { name: 'Scenario 10', exact: true });
            await checkbox.scrollIntoViewIfNeeded();
            // Start after the intentional opening animation, so a second reveal is a regression.
            await picker.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
            const before = await checkbox.boundingBox();
            const alternateBefore = await alternate.boundingBox();
            const alternateX = alternateBefore.x + alternateBefore.width / 2;
            const alternateY = alternateBefore.y + alternateBefore.height / 2;
            const notesScroll = await scrollTop(notes);
            expect(notesScroll).toBeGreaterThan(0);
            const probe = await picker.evaluateHandle(element => {
                const checkbox = element.querySelector('input[value="note-10"]');
                const state = { detached: false, hidden: false, revealed: false, saved: false, done: false };
                const frame = () => {
                    const current = document.getElementById(element.id);
                    state.detached ||= !element.isConnected || !checkbox.isConnected;
                    state.hidden ||= !current || window.getComputedStyle(current).visibility !== 'visible';
                    state.revealed ||= Boolean(current?.getAnimations().some(animation => animation.animationName === 'sbShellContentReveal'));
                    if (!state.done) window.requestAnimationFrame(frame);
                };
                window.requestAnimationFrame(frame);
                const ctx = window.SillyTavern.getContext();
                ctx.eventSource.once(ctx.eventTypes.SETTINGS_UPDATED, () => { state.saved = true; });
                return state;
            });
            await press(checkbox);
            await expect(checkbox).toBeChecked();
            await expect(picker.locator('.sb-persona-picker-appendices-count').first()).toHaveText('1/10 on');
            await expect(personas.getByRole('button', { pressed: true })).toContainText('+ Scenario 10');
            await expect(bubble).toHaveAttribute('title', 'Persona: Original Persona + Scenario 10');
            await expect.poll(() => probe.evaluate(state => state.saved)).toBe(true);
            await waitForAnimationFrames(page);
            const { detached, hidden, revealed } = await probe.evaluate(state => {
                state.done = true;
                return state;
            });
            expect({ detached, hidden, revealed }).toEqual({ detached: false, hidden: false, revealed: false });
            await checkFocus(checkbox);
            expect(await scrollTop(notes)).toBe(notesScroll);
            // A chip can change the height of a row further up. The original tap
            // position must still hit the same persona, not a different row.
            expect(await alternate.evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), {
                x: alternateX,
                y: alternateY,
            })).toBe(true);
            expect(await scrollTop(chat)).toBe(chatScroll);
            const after = await checkbox.boundingBox();
            expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);

            // Toggle the same note again at the original coordinates, without letting Playwright scroll it back into view.
            const x = before.x + before.width / 2;
            const y = before.y + before.height / 2;
            await pressAt(page, x, y);
            await expect(checkbox).not.toBeChecked();
            await expect(bubble).toHaveAttribute('title', 'Persona: Original Persona');

            await pressAt(page, alternateX, alternateY);
            await expect(picker).toBeHidden();
            await expect(bubble).toHaveAttribute('title', 'Persona: Alternate 9');
            await expect(bubble).toBeFocused();
            expect(await scrollTop(chat)).toBe(chatScroll);
            await press(bubble);
            await expect(picker.getByRole('checkbox', { name: 'Alternate Scenario' })).toBeVisible();
        });
    });
}
