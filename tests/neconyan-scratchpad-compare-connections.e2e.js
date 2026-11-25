/* global document, getComputedStyle, window, requestAnimationFrame */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const ACCENTS = [null, 'rgba(110,231,183,1)', 'rgba(126,34,206,1)'];

async function settleColours(page) {
    await page.evaluate(async () => {
        await Promise.all(document.getAnimations()
            .filter(animation => animation instanceof window.CSSTransition)
            .map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function openMenu(reply) {
    await reply.locator('.scratchpad-message-menu > summary[aria-label="Message actions"]').click();
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Compare asks one assistant on two connections and keeps the chosen reply`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: { ...(phone ? IPHONE_SAFARI_CONTEXT : {}), reducedMotion: 'reduce' }, configureSettings: saved => {
            const profiles = saved.extension_settings.connectionManager.profiles;
            profiles.push({ ...profiles[0], id: 'compare-alpha', name: 'Alpha', model: 'compare-alpha' });
            profiles.push({ ...profiles[0], id: 'compare-beta', name: 'Beta', model: 'compare-beta' });
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        let page = await account.open();
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
            await expect(page.locator('.scratchpad-composer')).toBeEnabled();
            if (phone) await applyIOSOnlyCss(page);
            await page.addStyleTag({ content: '#toast-container { display: none; }' });
        };
        await open();
        const width = phone ? 393 : 1280;

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('compare-alpha');
        const compare = page.locator('#scratchpad-compare-connection');
        await expect(compare).toBeEnabled();
        await expect(compare.locator('option')).toHaveText(['Off', 'Same connection as the chat', 'Durable fixture · conversation-fixture', 'Alpha · compare-alpha', 'Beta · compare-beta']);
        await compare.selectOption('compare-alpha');
        const warning = page.locator('.scratchpad-compare-warning');
        await expect(warning).toHaveText('Choose a different connection from Miso\'s main connection.');
        await compare.selectOption('compare-beta');
        await expect(warning).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const badge = () => page.locator('.scratchpad-summary .scratchpad-compare-badge');
        const replies = () => page.locator('.scratchpad-message.is-assistant.is-done');
        await expect(badge()).toHaveText('Compare: 2 connections');
        await expect(badge()).toHaveAttribute('title', 'Alpha vs Beta');

        app.provider.mode.streamReply = body => ({ first: body.model === 'compare-alpha' ? 'Answer from Alpha' : 'Answer from Beta', rest: ' about the ending.' });
        await page.locator('.scratchpad-composer').fill('Which ending works?');
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok()).toBe(true);
        const first = await response.json();
        await expect(page.locator('.scratchpad-stream')).toHaveCount(2);
        await expect(page.locator('.scratchpad-send')).toHaveAccessibleName('Stop all');
        const firstCalls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === 'Which ending works?');
        expect(firstCalls.map(call => call.model).sort()).toEqual(['compare-alpha', 'compare-beta']);
        expect(firstCalls[0].messages[0].content).toBe(firstCalls[1].messages[0].content);
        for (const call of firstCalls) call.finishStream();
        await account.settled(first.job.id);
        await expect(replies()).toHaveCount(2);
        await expect(replies().locator('.scratchpad-connection-badge')).toHaveText(['Alpha', 'Beta']);
        await expect(replies().nth(0)).toContainText('Answer from Alpha about the ending.');
        await expect(replies().nth(1)).toContainText('Answer from Beta about the ending.');
        await expect(page.getByRole('button', { name: 'Discuss these answers', exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.screenshot({ path: test.info().outputPath(`compare-after-${phone ? 'phone' : 'desktop'}.png`) });

        const results = [];
        for (const accent of ACCENTS) {
            if (accent) {
                await page.evaluate(rgba => {
                    for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id)?.dispatchEvent(new CustomEvent('change', { detail: { rgba } }));
                }, accent);
            }
            await settleColours(page);
            const measured = await page.evaluate(async () => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
                const channels = colour => {
                    canvas.clearRect(0, 0, 1, 1);
                    canvas.fillStyle = colour;
                    canvas.fillRect(0, 0, 1, 1);
                    return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
                };
                return ['.scratchpad-summary .scratchpad-compare-badge', '.scratchpad-connection-badge'].map(selector => {
                    const element = document.querySelector(selector);
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return { selector, ratio: contrastRatio(channels(style.color), channels(style.backgroundColor)), color: style.color, background: style.backgroundColor, right: rect.right };
                });
            });
            for (const item of measured) {
                results.push({ accent, ...item });
                expect(item.ratio, JSON.stringify(results)).toBeGreaterThanOrEqual(4.5);
                expect(item.right).toBeLessThanOrEqual(width);
            }
        }
        await test.info().attach('accent-measurements', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });

        await page.close();
        page = await account.open();
        await open();
        await expect(replies()).toHaveCount(2);
        await expect(replies().locator('.scratchpad-connection-badge')).toHaveText(['Alpha', 'Beta']);
        await expect(badge()).toHaveText('Compare: 2 connections');

        const before = app.provider.calls.length;
        await openMenu(replies().nth(1));
        const retried = page.waitForResponse('**/api/scratchpad/send');
        await replies().nth(1).getByRole('button', { name: 'Try again', exact: true }).click();
        const retry = await (await retried).json();
        await expect.poll(() => app.provider.calls.length).toBe(before + 1);
        const retryCall = app.provider.calls.at(-1);
        expect(retryCall.model).toBe('compare-beta');
        app.provider.calls.at(-1).finishStream();
        await account.settled(retry.job.id);
        await expect(replies()).toHaveCount(2);
        await expect(replies().nth(1).locator('.scratchpad-connection-badge')).toHaveText('Beta');
        await expect(replies().nth(1)).toContainText('Answer from Beta about the ending.');

        app.provider.mode.streamReply = body => ({ first: body.model === 'compare-alpha' ? 'Epilogue from Alpha' : 'Epilogue from Beta', rest: '.' });
        await page.locator('.scratchpad-composer').fill('And the epilogue?');
        const followed = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const follow = await (await followed).json();
        await expect.poll(() => app.provider.calls.filter(call => call.messages?.at(-1)?.content === 'And the epilogue?').length).toBe(2);
        const followCalls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === 'And the epilogue?');
        for (const call of followCalls) {
            const roles = call.messages.slice(1).map(message => message.role);
            expect(roles.some((role, index) => role === 'assistant' && roles[index + 1] === 'assistant')).toBe(false);
            expect(call.messages.filter(message => message.role === 'assistant' && /\[Reply via Alpha\][\s\S]*\n\n---\n\n\[Reply via Beta\]/.test(message.content))).toHaveLength(1);
        }
        for (const call of followCalls) call.finishStream();
        await account.settled(follow.job.id);
        await expect(replies()).toHaveCount(4);

        await openMenu(replies().nth(0));
        await replies().nth(0).getByRole('button', { name: 'Keep only this reply', exact: true }).click();
        await expect(replies()).toHaveCount(3);
        await expect(replies().nth(0)).toContainText('Answer from Alpha about the ending.');
        await expect(page.locator('.scratchpad-message.is-assistant', { hasText: 'Answer from Beta about the ending.' })).toHaveCount(0);
        await expect(replies().nth(1)).toContainText('Epilogue from Alpha.');
        await expect(replies().nth(2)).toContainText('Epilogue from Beta.');
        await expect(replies().nth(0).locator('.scratchpad-connection-badge')).toHaveText('Alpha');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-round-table')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.scratchpad-summary .scratchpad-compare-badge')).toHaveCount(0);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(page.locator('#scratchpad-compare-connection')).toBeDisabled();
        await expect(page.locator('.scratchpad-compare-note')).toHaveText('Turn off Round Table to compare one assistant on two connections.');
    });
}
