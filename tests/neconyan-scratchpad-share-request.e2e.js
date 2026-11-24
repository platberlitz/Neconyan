/* global window, document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Phone and desktop, and the baseline capture, share one script. */
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) {
    if (!process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT) throw new Error('Set NECONYAN_SCRATCHPAD_BASELINE_ROOT for before captures.');
    test.use({ initialServerOptions: { checkoutRoot: process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT } });
}
const capture = process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1';
const shots = path.resolve('../screenshots/scratchpad-share-request');

const XSS = '<img src=x onerror="window.__shareXss=1">';
const INSTRUCTIONS = 'Asking the user to share more context:';
const fence = request => ['```neconyan-share-request', JSON.stringify(request), '```'].join('\n');
const FIRST = [
    'I can see the character card, but not the prompt that reached the model, so I cannot tell why the reply drifted.',
    '',
    fence({ items: ['card', 'preset', 'lastPrompt', 'appEvidence'], reason: `I need the last prompt to check what reached the model. ${XSS}` }),
    '',
    'Press Share and I will look again.',
].join('\n');
const FOLLOW_UP = 'I shared App diagnostics and Last prompt sent. Please continue.';
const SECOND = [
    'The prompt looks fine. A problem check and more of the chat would help.',
    '',
    fence({ items: ['problems', 'problems', 'webSearch'], depth: 60, reason: 'Older messages may hold the setup.' }),
].join('\n');
const THIRD = [
    'If you want edits later, I could read your Agents and regexes.',
    '',
    fence({ items: ['agents', 'regex'], reason: 'Only if you want suggestions for them.' }),
].join('\n');
const GENERAL = [
    'I would need the chat to answer that.',
    '',
    fence({ items: ['mewmory', 'authorsNote', 'lastPrompt', 'hidden', 'config'], depth: 80, reason: `Chat context. ${XSS}` }),
].join('\n');

const textOf = call => call.messages.map(message => String(message.content)).join('\n');
const replyWith = (provider, content) => {
    provider.mode.reply = { choices: [{ message: { content } }] };
};

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

async function useDurableConnection(page) {
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
}

async function chatTab(page) {
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
}

async function settledSend(account, page, click) {
    const [response] = await Promise.all([page.waitForResponse('**/api/scratchpad/send'), click()]);
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
}

async function send(account, page, text) {
    await chatTab(page);
    await page.locator('.scratchpad-composer').fill(text);
    await settledSend(account, page, () => page.locator('.scratchpad-send').click());
}

async function savedSettings(account, source) {
    const bucket = (await account.post('/api/scratchpad/bucket', { source })).bucket;
    return bucket.sessions.find(session => session.id === bucket.activeSessionId)?.settings ?? bucket.sessions[0]?.settings;
}

async function screenshot(page, element, name) {
    if (!capture) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.toastr?.clear());
    // The panel at its real size, with the bottom of the element (where the buttons are) in view.
    await element.evaluate(node => node.scrollIntoView({ block: 'end' }));
    await page.locator('#neconyan-scratchpad').screenshot({ path: path.join(shots, name.replace(/\.png$/, '-panel.png')) });
    // The whole element, in a taller window so nothing is cut off.
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: viewport.width, height: 2400 });
    await element.evaluate(node => node.scrollIntoView({ block: 'center' }));
    await element.screenshot({ path: path.join(shots, name) });
    await page.setViewportSize(viewport);
}

async function expectInside(element, width) {
    const geometry = await element.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, scroll: node.scrollWidth, client: node.clientWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
}

/** Label contrast of a button, painted through a 1x1 canvas so colour-mix and alpha resolve as drawn. */
function buttonContrast(locator) {
    return locator.evaluate(node => {
        const style = getComputedStyle(node);
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const luminance = colour => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const ink = luminance(style.color);
        const fill = luminance(style.backgroundColor);
        return { ratio: (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05), color: style.color, background: style.backgroundColor };
    });
}

async function openRoleplay(app, phone) {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, activeConnection: true });
    if (phone) await installIPhoneSafari(account.context, { standalone: true });
    const page = await account.open({ workspace: false });
    await acknowledgeActiveSettings(page);
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    const source = await openScratchpad(page);
    await useDurableConnection(page);
    if (phone) await applyIOSOnlyCss(page);
    return { account, page, source };
}

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';
    const width = phone ? 393 : 1280;

    test(`${size} share card turns on only what I tick, then continues`, async ({ app }) => {
        test.setTimeout(420000);
        const provider = app.provider;
        const { account, page, source } = await openRoleplay(app, phone);
        const contextSwitch = name => page.getByRole('checkbox', { name });

        replyWith(provider, FIRST);
        let start = provider.calls.length;
        await send(account, page, `Why did the last reply drift? (${size})`);
        let calls = provider.calls.slice(start);
        expect(calls).toHaveLength(1);
        const reply = page.locator('.scratchpad-message.is-assistant').last();
        await expect(reply).toContainText('Press Share and I will look again.');

        if (before) {
            // Without the feature the request is an ordinary code block and the prompt never mentions it.
            expect(textOf(calls[0])).not.toContain('neconyan-share-request');
            await expect(page.locator('.scratchpad-share-request')).toHaveCount(0);
            await expect(reply.locator('pre code')).toContainText('"items"');
            await screenshot(page, reply, `${size}-reply-before.png`);
            return;
        }

        // The assistant is told only about switches that are off; the character card is on by default.
        const system = textOf(calls[0]);
        expect(system).toContain(INSTRUCTIONS);
        expect(system).toContain('- lastPrompt: Last prompt sent');
        expect(system).toContain('- appEvidence: App diagnostics');
        expect(system).toContain('- preset: Current preset');
        expect(system).not.toMatch(/^- card:/m);
        expect(system).not.toMatch(/^- persona:/m);

        const card = reply.locator('.scratchpad-share-request');
        await expect(card).toBeVisible();
        await expect(card.locator('.scratchpad-share-title')).toHaveText('Share with the assistant');
        await expect(card.locator('.scratchpad-share-reason')).toHaveText(`I need the last prompt to check what reached the model. ${XSS}`);
        await expect(reply.locator('pre code')).toHaveCount(0);
        await expect(reply.locator('.scratchpad-text')).toContainText(['I can see the character card', 'Press Share and I will look again.']);
        expect(await card.locator('img').count()).toBe(0);
        expect(await page.evaluate(() => window.__shareXss)).toBeUndefined();
        const boxes = card.locator('input[data-share-item]');
        await expect(boxes).toHaveCount(3);
        expect(await boxes.evaluateAll(nodes => nodes.map(node => [node.dataset.shareItem, node.checked]))).toEqual([['preset', true], ['lastPrompt', true], ['appEvidence', true]]);
        await expect(card.locator('.scratchpad-share-item.is-shared')).toHaveText(['Character cardsAlready shared']);
        const accept = card.locator('.scratchpad-share-accept');
        const only = card.locator('.scratchpad-share-only');
        await expect(accept).toBeEnabled();
        await expect(accept).toHaveText('Share & continue');
        await expect(card.locator('.scratchpad-share-dismiss')).toHaveText('Not now');
        await expectInside(card, width);
        for (const target of [accept, only, card.locator('.scratchpad-share-dismiss'), card.locator('label.scratchpad-share-item').first()]) {
            const box = await target.boundingBox();
            expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
        }

        // Nothing changes until a button is pressed.
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(contextSwitch(/^Last prompt sent/)).not.toBeChecked();
        await expect(contextSwitch(/^App diagnostics/)).not.toBeChecked();
        await expect(contextSwitch(/^Current preset/)).not.toBeChecked();
        const initial = await savedSettings(account, source);
        expect(initial.include).toMatchObject({ preset: false, appEvidence: false, lastPrompt: false });
        await chatTab(page);
        await screenshot(page, reply, `${size}-reply-after.png`);

        // Untick the preset, so only the other two are turned on.
        await card.locator('input[data-share-item="preset"]').uncheck();
        await expect(accept).toBeEnabled();
        await screenshot(page, card, `${size}-card-partial-after.png`);

        replyWith(provider, SECOND);
        start = provider.calls.length;
        await settledSend(account, page, () => accept.click());
        calls = provider.calls.slice(start);
        expect(calls).toHaveLength(1);
        const followUp = calls[0];
        expect(followUp.messages.at(-1).content).toBe(FOLLOW_UP);
        const shared = textOf(followUp);
        expect(shared).toContain('## Last prompt sent');
        expect(shared).toContain('## App evidence');
        expect(shared).not.toContain('## Current preset');
        // The fixed message never carries the assistant's reason.
        expect(followUp.messages.at(-1).content).not.toContain('onerror');
        // Switches already on drop out of the list the assistant sees.
        expect(shared).toContain('- preset: Current preset');
        expect(shared).not.toMatch(/^- (lastPrompt|appEvidence):/m);
        await expect(page.locator('.scratchpad-message.is-user').last()).toContainText(FOLLOW_UP);
        let saved = await savedSettings(account, source);
        expect(saved.include).toMatchObject({ preset: false, appEvidence: true, lastPrompt: true });
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(contextSwitch(/^Last prompt sent/)).toBeChecked();
        await expect(contextSwitch(/^App diagnostics/)).toBeChecked();
        await expect(contextSwitch(/^Current preset/)).not.toBeChecked();
        await chatTab(page);
        const firstCard = page.locator('.scratchpad-share-request').first();
        await expect(firstCard.locator('.scratchpad-share-item.is-shared .scratchpad-share-name')).toHaveText(['Character cards', 'Last prompt sent', 'App diagnostics']);
        await expect(firstCard.locator('input[data-share-item]')).toHaveCount(1);
        await screenshot(page, firstCard, `${size}-card-shared-after.png`);

        // 'Turn on only' saves the switches and the message count without sending anything.
        const second = page.locator('.scratchpad-message.is-assistant').last().locator('.scratchpad-share-request');
        await expect(second.locator('input[data-share-item]')).toHaveCount(2);
        await expect(second.locator('label.scratchpad-share-item').last()).toContainText('Reads the last 60 messages instead of 15.');
        await expect(second.locator('.scratchpad-share-note')).toHaveText('Some of what the assistant asked for is not available in this Scratchpad mode.');
        start = provider.calls.length;
        await second.locator('.scratchpad-share-only').click();
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'Shared Problem checks, Recent messages to read (60). Open Preview to check before sending.' }).first()).toBeVisible();
        await expect(second.locator('.scratchpad-change-state')).toHaveText('Already shared');
        await expect(second.locator('.scratchpad-share-badge')).toHaveCount(2);
        await expect(second.locator('.scratchpad-share-actions')).toHaveCount(0);
        expect(provider.calls.length).toBe(start);
        saved = await savedSettings(account, source);
        expect(saved.include.problems).toBe(true);
        expect(saved.depth).toBe(60);
        await page.evaluate(() => window.toastr.clear());

        // 'Not now' only folds the card away.
        replyWith(provider, THIRD);
        await send(account, page, `Anything else? (${size})`);
        const third = page.locator('.scratchpad-message.is-assistant').last().locator('.scratchpad-share-request');
        await expect(third.locator('input[data-share-item]')).toHaveCount(2);
        const beforeDismiss = await savedSettings(account, source);
        await third.locator('.scratchpad-share-dismiss').click();
        await expect(third).toHaveClass(/is-dismissed/);
        await expect(third.locator('.scratchpad-change-state')).toHaveText('Dismissed');
        await expect(third.locator('input')).toHaveCount(0);
        expect(await savedSettings(account, source)).toEqual(beforeDismiss);
        expect(beforeDismiss.include).toMatchObject({ agents: false, regex: false });

        // The primary button keeps its label readable on the default, a pale and a dark accent.
        await firstCard.locator('input[data-share-item="preset"]').check();
        const firstAccept = firstCard.locator('.scratchpad-share-accept');
        await expect(firstAccept).toBeEnabled();
        const contrast = {};
        for (const [name, rgba] of [['Calico', null], ['Mint Glass', 'rgba(110,231,183,1)'], ['Plum Wine', 'rgba(126,34,206,1)']]) {
            if (rgba) {
                await page.evaluate(value => {
                    for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba: value } }));
                }, rgba);
            }
            await settleCssTransitions(page);
            contrast[name] = await buttonContrast(firstAccept);
            expect(contrast[name].ratio, `${name} ${JSON.stringify(contrast[name])}`).toBeGreaterThanOrEqual(4.5);
        }
        console.log(`share accept contrast ${size}: ${Object.entries(contrast).map(([name, value]) => `${name} ${value.ratio.toFixed(2)} (${value.color} on ${value.background})`).join('; ')}`);

        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    });

    test(`${size} share card offers nothing a General Scratchpad cannot share`, async ({ app }) => {
        test.skip(before, 'Baseline captures only.');
        test.setTimeout(300000);
        const provider = app.provider;
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, activeConnection: true });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true }));
        const source = await openScratchpad(page);
        await expect(page.locator('.scratchpad-source')).toContainText('General Scratchpad');
        await useDurableConnection(page);
        if (phone) await applyIOSOnlyCss(page);

        replyWith(provider, GENERAL);
        const start = provider.calls.length;
        await send(account, page, `What happened in my chat? (${size})`);
        const system = textOf(provider.calls.slice(start)[0]);
        expect(system).toContain(INSTRUCTIONS);
        expect(system).toContain('- preset: Current preset');
        expect(system).not.toMatch(/^- (mewmory|authorsNote|lore|lastPrompt|hidden|depth|card):/m);

        const reply = page.locator('.scratchpad-message.is-assistant').last();
        const card = reply.locator('.scratchpad-share-request');
        await expect(card).toBeVisible();
        await expect(card.locator('.scratchpad-share-note')).toHaveText('What the assistant asked for is not available in this Scratchpad mode.');
        await expect(card.locator('input')).toHaveCount(0);
        await expect(card.locator('button')).toHaveCount(0);
        await expect(card.locator('.scratchpad-share-reason')).toHaveText(`Chat context. ${XSS}`);
        expect(await card.locator('img').count()).toBe(0);
        expect(await page.evaluate(() => window.__shareXss)).toBeUndefined();
        await expectInside(card, width);
        const saved = await savedSettings(account, source);
        // Author's Note stays at its saved default; General never reads it.
        for (const key of ['mewmory', 'lastPrompt', 'hidden']) expect(saved.include[key]).not.toBe(true);
        expect(saved.depth).toBe(15);
        expect(saved).not.toHaveProperty('config');
        await screenshot(page, card, `${size}-general-unavailable-after.png`);

        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    });
}
