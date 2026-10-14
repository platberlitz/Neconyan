/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-standalone-expect -- Helpers verify their setup. */
/* eslint-disable playwright/no-conditional-in-test -- Viewport and baseline variants share the same setup and checks. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) {
    if (!process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT) throw new Error('Set NECONYAN_SCRATCHPAD_BASELINE_ROOT for before captures.');
    test.use({ initialServerOptions: { checkoutRoot: process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT } });
}

async function openFromRail(page, phone) {
    if (phone) await page.locator('#sb-hamburger').click();
    await page.locator('#neconyan-workspace-rail [data-neconyan-route="scratchpad"]').click();
    await expect(page.locator('#neconyan-scratchpad')).toBeVisible();
}

async function source(page) {
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

for (const phone of [true, false]) {
    const size = phone ? 'phone' : 'desktop';
    test(`${size} General works from Home, excludes hidden story and preserves drafts and background replies`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        await openFromRail(page, phone);
        if (phone) await applyIOSOnlyCss(page);
        if (before) {
            await expect(page.locator('.scratchpad-source')).toHaveText('No chat open');
            await expect(page.locator('.scratchpad-composer')).toBeDisabled();
            await page.evaluate(() => window.toastr.clear());
            await page.screenshot({ path: `../screenshots/item1-${size}-before.png` });
            return;
        }
        await expect(page.locator('.scratchpad-source')).toHaveText('General Scratchpad');
        await expect(page.locator('.scratchpad-composer')).toBeEnabled();
        await expect(page.locator('.scratchpad-summary')).toContainText('No chat messages shared');
        await expect(page.getByRole('button', { name: 'Read the scene', exact: true })).toHaveCount(0);
        await page.evaluate(() => window.toastr.clear());
        await page.screenshot({ path: `../screenshots/item1-${size}-after.png` });
        const general = await source(page);
        expect(general.kind).toBe('general');
        expect(general.avatar).toBeUndefined();
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(page.locator('#scratchpad-depth')).toHaveCount(0);
        await expect(page.getByRole('checkbox', { name: 'Lorebook entries', exact: true })).toHaveCount(0);
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source: general })).bucket.sessions[0]?.settings.assistantConnections.miso.profileId).toBe('durable');
        await page.screenshot({ path: `../screenshots/item1-${size}-context-after.png` });
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-composer').fill('GENERAL-DRAFT');
        await page.locator('.scratchpad-close').click();
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
            const script = await import('/script.js');
            context.chat.push({ name: 'Durable Nova', mes: 'HIDDEN-STORY-SECRET', is_user: false, extra: {} });
            context.chatMetadata.note_prompt = 'HIDDEN-AUTHORS-NOTE';
            context.chatMetadata.world_info = 'HIDDEN-LOREBOOK';
            await context.saveChat({ throwOnError: true });
            await script.reloadCurrentChat();
        }, account.avatar);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        expect((await source(page)).kind).toBe('roleplay');
        await page.locator('.scratchpad-header .scratchpad-new-session').click();
        await page.locator('.scratchpad-composer').fill('CHAT-DRAFT');
        await page.evaluate(async () => {
            await (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true });
            window.dispatchEvent(new Event('neconyan:navigate-home'));
        });
        await openFromRail(page, phone);
        await expect(page.locator('.scratchpad-composer')).toHaveValue('GENERAL-DRAFT');
        expect(await source(page)).toEqual(general);
        app.provider.mode.streamReply = { first: 'General ', rest: 'answer saved.' };
        await page.locator('.scratchpad-composer').fill('Help me decide without reading a story.');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        const jobId = (await response.json()).job.id;
        await expect(page.locator('.scratchpad-stream')).toHaveText('General ');
        const call = app.provider.calls.find(call => call.messages?.at(-1)?.content === 'Help me decide without reading a story.');
        expect(call).toBeTruthy();
        const body = JSON.stringify(call.messages);
        expect(body).toContain('General Scratchpad');
        expect(body).not.toMatch(/HIDDEN-STORY-SECRET|HIDDEN-AUTHORS-NOTE|HIDDEN-LOREBOOK|## Character: Durable Nova|## Current preset:/);
        await page.locator('.scratchpad-close').click();
        await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).hideWelcomeHome());
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toHaveValue('CHAT-DRAFT');
        expect((await source(page)).kind).toBe('roleplay');
        app.provider.mode.finishStream();
        await account.settled(jobId);
        await expect(page.locator('.scratchpad-reply')).toHaveCount(0);
        await page.locator('.scratchpad-close').click();
        await page.evaluate(async () => (await import('/script.js')).closeCurrentChat());
        await openFromRail(page, phone);
        await expect(page.locator('.scratchpad-reply')).toHaveText('General answer saved.');
        await page.locator('.scratchpad-message.is-assistant summary[aria-label="Message actions"]').click();
        await expect(page.getByRole('button', { name: 'Use as draft in the chat box', exact: true })).toHaveCount(0);
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
        await openFromRail(page, phone);
        await expect(page.locator('.scratchpad-reply')).toHaveText('General answer saved.');
        const geometry = await page.locator('#neconyan-scratchpad').evaluate(element => {
            const bounds = element.getBoundingClientRect();
            const composer = element.querySelector('.scratchpad-composer').getBoundingClientRect();
            const send = element.querySelector('.scratchpad-send').getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, composerBottom: composer.bottom, sendHeight: send.height,
                width: document.documentElement.scrollWidth, fontSize: getComputedStyle(element).fontSize };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(geometry.width).toBe(phone ? 393 : 1280);
        expect(geometry.composerBottom).toBeLessThanOrEqual(phone ? 852 : 900);
        if (phone) expect(geometry.sendHeight).toBeGreaterThanOrEqual(44);
    });

    test(`${size} General controls fit and retain contrast across themes, accents and shell styles`, async ({ app }) => {
        test.skip(before, 'Before captures cover the disabled no-chat panel.');
        test.setTimeout(240000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await openFromRail(page, phone);
        if (phone) await applyIOSOnlyCss(page);
        const measured = [];
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                for (const style of ['calico', 'kittyless', 'windows-aero', 'windows-xp', 'windows-98', 'clean-minimal', 'macos-minimal', 'cozy-warm', 'hypr-glow', 'slate-flat']) {
                    await page.evaluate(id => window.NeconyanShell.applyTheme(id), style);
                    await page.waitForFunction(id => id === 'calico' || document.querySelector(`link[data-sb-shell-style="${id}"]`)?.sheet, style);
                    if (phone) await applyIOSOnlyCss(page);
                    const result = await page.locator('#neconyan-scratchpad').evaluate(async element => {
                        await Promise.all(document.getAnimations().filter(animation => animation instanceof window.CSSTransition).map(animation => animation.finished.catch(() => {})));
                        const { contrastRatio } = await import('/scripts/theme-contrast.js');
                        const canvas = document.createElement('canvas').getContext('2d');
                        const channels = colour => {
                            canvas.clearRect(0, 0, 1, 1);
                            canvas.fillStyle = colour;
                            canvas.fillRect(0, 0, 1, 1);
                            return [...canvas.getImageData(0, 0, 1, 1).data];
                        };
                        const composite = (over, under) => over.slice(0, 3).map((channel, index) => Math.round(channel * over[3] / 255 + under[index] * (1 - over[3] / 255)));
                        return { width: document.documentElement.scrollWidth,
                            buttons: [...element.querySelectorAll('.scratchpad-chip, .scratchpad-send, .scratchpad-close')].map(button => {
                                const css = getComputedStyle(button);
                                const label = getComputedStyle(button.querySelector('span'));
                                const rect = button.getBoundingClientRect();
                                let backdrop = [255, 255, 255];
                                const ancestors = [];
                                for (let parent = button.parentElement; parent; parent = parent.parentElement) ancestors.unshift(parent);
                                for (const parent of ancestors) backdrop = composite(channels(getComputedStyle(parent).backgroundColor), backdrop);
                                const base = composite(channels(css.backgroundColor), backdrop);
                                // Match the shared shell-button audit: the upper fill covers a border-only gradient.
                                const image = css.backgroundClip === 'padding-box, border-box' ? css.backgroundImage.split(/, (?=linear-gradient)/)[0] : css.backgroundImage;
                                const stops = image.match(/(?:rgba?|color)\([^)]+\)/g) || [];
                                const backgrounds = stops.length ? stops.map(stop => composite(channels(stop), base)) : [base];
                                const brightness = Number(css.filter.match(/brightness\(([\d.]+)\)/)?.[1] || 1);
                                const filtered = values => values.slice(0, 3).map(channel => Math.min(255, Math.round(channel * brightness)));
                                const ink = filtered(channels(label.color));
                                return { label: button.textContent, prompt: button.classList.contains('scratchpad-chip'), height: rect.height, right: rect.right,
                                    ink, backgrounds, image, contrast: Math.min(...backgrounds.map(background => contrastRatio(ink, filtered(background)))) };
                            }) };
                    });
                    measured.push({ theme, accent, style, ...result });
                    expect(result.width).toBe(phone ? 393 : 1280);
                    for (const button of result.buttons) {
                        expect(button.contrast, JSON.stringify({ theme, accent, style, button })).toBeGreaterThanOrEqual(4.5);
                        if (!button.prompt) expect(button.right).toBeLessThanOrEqual(phone ? 393 : 1280);
                        if (phone) expect(button.height).toBeGreaterThanOrEqual(44);
                    }
                }
            }
        }
        await test.info().attach('general-control-measurements', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
    });
}

test('the real Home control updates an open desktop side panel before its source poll', async ({ app }) => {
    test.skip(before, 'The original no-chat panel predates this behaviour.');
    test.setTimeout(150000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await page.evaluate(() => {
        window.scratchpadSourcePolls = [];
        const interval = window.setInterval;
        window.setInterval = (callback, delay, ...args) => {
            const id = interval(callback, delay, ...args);
            if (callback.name === 'checkSource' && delay === 1500) window.scratchpadSourcePolls.push(id);
            return id;
        };
        window.addEventListener('neconyan:navigate-home', () => { window.scratchpadHomeEventAt = performance.now(); });
    });
    await page.evaluate(async avatar => {
        const core = window.SillyTavern.getContext();
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(card => card.avatar === avatar), { switchMenu: false });
        await core.saveChat({ throwOnError: true });
    }, account.avatar);
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-source')).not.toHaveText('General Scratchpad');
    await expect(page.locator('#neconyan-scratchpad')).toHaveAttribute('data-layout', 'beside');
    await page.evaluate(() => { for (const id of window.scratchpadSourcePolls) window.clearInterval(id); });
    await page.locator('#neconyan-workspace-rail [data-neconyan-route="home"]').click();
    await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
    await expect(page.locator('.scratchpad-source')).toHaveText('General Scratchpad', { timeout: 700 });
    expect(await page.evaluate(() => performance.now() - window.scratchpadHomeEventAt)).toBeLessThan(1500);
    await expect(page.locator('#neconyan-scratchpad')).toBeVisible();
});
