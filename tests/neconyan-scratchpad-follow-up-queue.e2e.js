/* global window, document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Phone and desktop, and the baseline capture, share one script. */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test as base } from './neconyan-conversation-durable-fixture.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before && !process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT) throw new Error('Set NECONYAN_SCRATCHPAD_BASELINE_ROOT for before captures.');
if (before) base.use({ initialServerOptions: { checkoutRoot: process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT } });

const test = base.extend({
    readyAccount: [async ({ app }, use, testInfo) => {
        const phone = testInfo.title.startsWith('phone');
        const account = await app.account({ phone, contextOptions: {} });
        const page = await account.open({ workspace: false });
        await use({ account, page });
    }, { timeout: 120000 }],
});

const question = 'Suggest a quiet opening for the garden scene.';
const answer = 'Start with the garden gate left open.';
const FIRST = { first: 'Gate note: ', rest: 'the hinge squeaks at dawn.' };
const LONG = 'A much longer follow-up that keeps going about the garden gate, the hinge, the footprints in the frost and the letter nobody has opened yet, so the row has to clamp.';

async function open(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeVisible();
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

async function picture(page, name, phone) {
    await fs.mkdir('../screenshots', { recursive: true });
    await page.screenshot({ path: `../screenshots/scratchpad-${name}-${phone ? 'phone' : 'desktop'}-${before ? 'before' : 'after'}.png`,
        style: '#toast-container > :not(.toast-warning) { visibility: hidden; }' });
}

async function seed(account, page) {
    const source = await open(page);
    await account.post('/api/scratchpad/session/import', { source, session: {
        name: 'Garden ideas', assistant: 'miso', settings: { connection: { kind: 'profile', profileId: 'durable' } },
        messages: [{ role: 'user', text: question }, { role: 'assistant', assistant: 'miso', assistantName: 'Miso', text: answer }],
    } });
    await open(page);
    await expect(page.locator('.scratchpad-reply')).toHaveText(answer);
    return source;
}

async function expectButton(locator, label, icon) {
    await expect(locator).toHaveAttribute('aria-label', label);
    await expect(locator).toHaveAttribute('title', label);
    await expect(locator.locator(`i.${icon}`)).toHaveCount(1);
}

/** Sends a message from the composer and waits until its reply is being written. */
async function sendHeld(app, page, text) {
    const calls = app.provider.calls.length;
    await page.locator('.scratchpad-composer').fill(text);
    const accepted = page.waitForResponse('**/api/scratchpad/send');
    await page.locator('.scratchpad-send').click();
    const response = await accepted;
    expect(response.ok(), await response.text()).toBe(true);
    await expect.poll(() => app.provider.calls.length).toBe(calls + 1);
    await expect.poll(() => Boolean(app.provider.calls.at(-1)?.finishStream)).toBe(true);
    await expectButton(page.locator('.scratchpad-send'), 'Stop', 'fa-stop');
    return (await response.json()).job.id;
}

async function release(app, account, jobId) {
    app.provider.calls.at(-1).finishStream();
    await account.settled(jobId);
}

async function expectInside(page, width) {
    const geometry = await page.locator('.scratchpad-queue').evaluate(node => {
        const rect = node.getBoundingClientRect();
        const rows = [...node.querySelectorAll('.scratchpad-queue-item')].map(row => {
            const box = row.getBoundingClientRect();
            const text = row.querySelector('.scratchpad-queue-text');
            return { left: box.left, right: box.right, height: box.height, scroll: row.scrollWidth, client: row.clientWidth, clamped: text.scrollWidth > text.clientWidth };
        });
        return { left: rect.left, right: rect.right, scroll: node.scrollWidth, client: node.clientWidth, rows, page: document.documentElement.scrollWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    expect(geometry.page).toBe(width);
    for (const row of geometry.rows) {
        expect(row.left).toBeGreaterThanOrEqual(geometry.left);
        expect(row.right).toBeLessThanOrEqual(geometry.right);
        expect(row.scroll).toBeLessThanOrEqual(row.client + 1);
        expect(row.height).toBeLessThan(60);
    }
    return geometry;
}

/** Label contrast of an element, painted through a 1x1 canvas so colour-mix and alpha resolve as drawn. */
function contrastOf(locator) {
    return locator.evaluate(node => {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const paint = colours => {
            context.clearRect(0, 0, 1, 1);
            for (const colour of colours) {
                context.fillStyle = colour;
                context.fillRect(0, 0, 1, 1);
            }
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        // Stack the element's own background over every opaque-enough ancestor background.
        const layers = [];
        for (let element = node; element; element = element.parentElement) {
            const background = getComputedStyle(element).backgroundColor;
            if (background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') layers.unshift(background);
        }
        const luminance = rgb => {
            const [r, g, b] = rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return r * 0.2126 + g * 0.7152 + b * 0.0722;
        };
        const fillRgb = paint(['rgb(255, 255, 255)', ...layers]);
        const fill = luminance(fillRgb);
        const ink = luminance(paint([`rgb(${fillRgb.join(', ')})`, getComputedStyle(node).color]));
        return { ratio: (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05), color: getComputedStyle(node).color, background: `rgb(${fillRgb.join(', ')})` };
    });
}

for (const phone of [true, false]) {
    const size = phone ? 'phone' : 'desktop';
    const width = phone ? 393 : 1280;

    test(`${size} baseline Scratchpad cannot queue a message while a reply is pending`, async ({ app, readyAccount }) => {
        test.skip(!before, 'Baseline capture only.');
        const { account, page } = readyAccount;
        await seed(account, page);
        app.provider.mode.streamReply = FIRST;
        const job = await sendHeld(app, page, 'Where does the path lead?');
        await page.locator('.scratchpad-composer').fill('<b>after</b>');
        const calls = app.provider.calls.length;
        await expectButton(page.locator('.scratchpad-send'), 'Stop', 'fa-stop');
        if (!phone) await page.locator('.scratchpad-composer').press('Enter');
        await expect(page.locator('.scratchpad-composer')).toHaveValue('<b>after</b>');
        await expect(page.locator('.scratchpad-queue')).toHaveCount(0);
        await page.evaluate(() => window.toastr.clear());
        await picture(page, 'follow-up-queue', phone);
        expect(app.provider.calls.length).toBe(calls);
        await release(app, account, job);
    });

    test(`${size} follow-ups queue while a reply is pending and send in order`, async ({ app, readyAccount }) => {
        test.skip(before, 'After build only.');
        test.setTimeout(240000);
        const { account, page } = readyAccount;
        const source = await seed(account, page);
        const send = page.locator('.scratchpad-send');
        const composer = page.locator('.scratchpad-composer');
        const queue = page.locator('.scratchpad-queue');
        const rows = queue.locator('.scratchpad-queue-item');
        await expect(queue).toBeHidden();
        app.provider.mode.streamReply = FIRST;
        const firstJob = await sendHeld(app, page, 'Where does the path lead?');

        // Typing or picking a quick prompt turns Stop into Queue follow-up; an empty composer keeps Stop.
        await expect(composer).toHaveValue('');
        await expectButton(send, 'Stop', 'fa-stop');
        await page.locator('.scratchpad-quick .scratchpad-chip:not(.scratchpad-chip-edit)').first().click();
        await expect(composer).not.toHaveValue('');
        await expectButton(send, 'Queue follow-up', 'fa-clock');
        await composer.fill('');
        await expectButton(send, 'Stop', 'fa-stop');
        await composer.pressSequentially('<b>after</b>');
        await expectButton(send, 'Queue follow-up', 'fa-clock');
        await composer.fill('');
        await expectButton(send, 'Stop', 'fa-stop');
        await composer.fill('<b>after</b>');
        await expectButton(send, 'Queue follow-up', 'fa-clock');
        await send.click();
        await expect(rows).toHaveCount(1);
        await expect(composer).toHaveValue('');
        await expectButton(send, 'Stop', 'fa-stop');
        await expect(queue.locator('.scratchpad-queue-title')).toHaveText('Queued next');
        await expect(rows.first().locator('.scratchpad-queue-text')).toHaveText('<b>after</b>');
        await expect(queue.locator('b')).toHaveCount(0);
        // The strip sits directly above the compose row.
        expect(await queue.evaluate(node => node.nextElementSibling?.classList.contains('scratchpad-compose-row'))).toBe(true);

        // Desktop Enter queues as well; phones queue with the button.
        await composer.fill(LONG);
        if (phone) await send.click();
        else await composer.press('Enter');
        await expect(rows).toHaveCount(2);
        await expect(composer).toHaveValue('');
        const geometry = await expectInside(page, width);
        expect(geometry.rows[1].clamped).toBe(true);
        await page.evaluate(() => window.toastr.clear());
        await picture(page, 'follow-up-queue', phone);

        // Edit moves it back ahead of what is already typed; Remove drops it.
        await composer.fill('Draft words');
        await rows.nth(1).getByRole('button', { name: 'Edit queued follow-up', exact: true }).click();
        await expect(rows).toHaveCount(1);
        await expect(composer).toHaveValue(`${LONG}\n\nDraft words`);
        await send.click();
        await expect(rows).toHaveCount(2);
        await rows.nth(1).getByRole('button', { name: 'Remove queued follow-up', exact: true }).click();
        await expect(rows).toHaveCount(1);
        await expect(composer).toHaveValue('');

        // Files alone can be queued too.
        await page.locator('input[type="file"][aria-label="Attach files"]').setInputFiles({ name: 'only.txt', mimeType: 'text/plain', buffer: Buffer.from('File-only follow-up.') });
        await expect(page.locator('.scratchpad-draft-attachments .scratchpad-file')).toHaveCount(1);
        await expectButton(send, 'Queue follow-up', 'fa-clock');
        await send.click();
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(1).locator('.scratchpad-queue-text')).toHaveText('1 file');
        await expect(page.locator('.scratchpad-draft-attachments .scratchpad-file')).toHaveCount(0);
        await expectInside(page, width);

        // When the reply finishes, the first follow-up goes out with that reply in its context.
        const secondAccepted = page.waitForResponse(response => response.url().endsWith('/api/scratchpad/send') && response.request().postDataJSON()?.text === '<b>after</b>');
        await release(app, account, firstJob);
        const secondResponse = await secondAccepted;
        expect(secondResponse.ok(), await secondResponse.text()).toBe(true);
        await expect.poll(() => Boolean(app.provider.calls.at(-1)?.finishStream)).toBe(true);
        const secondCall = JSON.stringify(app.provider.calls.at(-1).messages);
        expect(secondCall).toContain('Gate note: the hinge squeaks at dawn.');
        expect(secondCall).toContain('<b>after</b>');
        await expect(rows).toHaveCount(1);
        await expectButton(send, 'Stop', 'fa-stop');

        // The next one waits for that reply, then sends its file.
        const thirdAccepted = page.waitForResponse(response => response.url().endsWith('/api/scratchpad/send') && response.request().postDataJSON()?.attachments?.length === 1);
        await release(app, account, (await secondResponse.json()).job.id);
        const thirdResponse = await thirdAccepted;
        expect(thirdResponse.ok(), await thirdResponse.text()).toBe(true);
        expect(thirdResponse.request().postDataJSON().attachments.map(file => file.name)).toEqual(['only.txt']);
        await expect(queue).toBeHidden();
        await expect.poll(() => Boolean(app.provider.calls.at(-1)?.finishStream)).toBe(true);
        expect(JSON.stringify(app.provider.calls.at(-1).messages)).toContain('File-only follow-up.');
        await release(app, account, (await thirdResponse.json()).job.id);
        await expectButton(send, 'Send', 'fa-paper-plane');
        const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].messages;
        expect(saved.filter(message => message.role === 'user').map(message => message.text)).toEqual([question, 'Where does the path lead?', '<b>after</b>', '']);
        expect(saved.every(message => message.state !== 'pending')).toBe(true);
    });

    test(`${size} a stopped reply pauses the queue until Send now`, async ({ app, readyAccount }) => {
        test.skip(before, 'After build only.');
        test.setTimeout(240000);
        const { account, page } = readyAccount;
        const source = await seed(account, page);
        const send = page.locator('.scratchpad-send');
        const composer = page.locator('.scratchpad-composer');
        const queue = page.locator('.scratchpad-queue');
        app.provider.mode.streamReply = FIRST;
        const job = await sendHeld(app, page, 'Where does the path lead?');
        await composer.fill('Wait for this one.');
        await send.click();
        await expect(queue.locator('.scratchpad-queue-item')).toHaveCount(1);
        await expectButton(send, 'Stop', 'fa-stop');

        const calls = app.provider.calls.length;
        await send.click();
        await account.settled(job, 'cancelled');
        await expect(queue.locator('.scratchpad-queue-notice')).toHaveText('Paused because the previous reply stopped.');
        await expect(queue.locator('.scratchpad-queue-item')).toHaveCount(1);
        // eslint-disable-next-line playwright/no-wait-for-timeout -- Nothing may be sent behind the pause.
        await page.waitForTimeout(1500);
        expect(app.provider.calls.length).toBe(calls);
        const sendNow = queue.getByRole('button', { name: 'Send now', exact: true });
        await expect(sendNow).toBeVisible();
        await expectInside(page, width);
        await page.evaluate(() => window.toastr.clear());
        await picture(page, 'follow-up-paused', phone);

        // Send now keeps its label readable on the default, a pale and a dark accent.
        const contrast = {};
        for (const [name, rgba] of [['Calico', null], ['Mint Glass', 'rgba(110,231,183,1)'], ['Plum Wine', 'rgba(126,34,206,1)']]) {
            if (rgba) {
                await page.evaluate(value => {
                    for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba: value } }));
                }, rgba);
            }
            await settleCssTransitions(page);
            contrast[name] = { sendNow: await contrastOf(sendNow), text: await contrastOf(queue.locator('.scratchpad-queue-text').first()) };
            // Send now is filled with the accent, so each accent must actually repaint it.
            if (rgba) expect(contrast[name].sendNow.background, `${name} accent applied`).not.toBe(contrast.Calico.sendNow.background);
            expect(contrast[name].sendNow.ratio, `${name} ${JSON.stringify(contrast[name])}`).toBeGreaterThanOrEqual(4.5);
            expect(contrast[name].text.ratio, `${name} ${JSON.stringify(contrast[name])}`).toBeGreaterThanOrEqual(4.5);
        }
        console.log(`follow-up queue contrast ${size}: ${Object.entries(contrast).map(([name, value]) => `${name} Send now ${value.sendNow.ratio.toFixed(2)} (${value.sendNow.color} on ${value.sendNow.background}), row ${value.text.ratio.toFixed(2)}`).join('; ')}`);

        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await sendNow.click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        expect(response.request().postDataJSON().text).toBe('Wait for this one.');
        await expect(queue).toBeHidden();
        await expect.poll(() => Boolean(app.provider.calls.at(-1)?.finishStream)).toBe(true);
        await release(app, account, (await response.json()).job.id);

        // A reply that finishes while Scratchpad is closed never sends behind it.
        const hidden = await sendHeld(app, page, 'One more question.');
        await composer.fill('Only when I am back.');
        await send.click();
        await expect(queue.locator('.scratchpad-queue-item')).toHaveCount(1);
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        const closedCalls = app.provider.calls.length;
        await release(app, account, hidden);
        // eslint-disable-next-line playwright/no-wait-for-timeout -- Nothing may be sent behind the closed panel.
        await page.waitForTimeout(1500);
        expect(app.provider.calls.length).toBe(closedCalls);
        await open(page);
        await expect(queue.locator('.scratchpad-queue-notice')).toHaveText('Paused while you were away. Press Send now to send it.');
        await expect(queue.locator('.scratchpad-queue-item')).toHaveCount(1);
        expect(app.provider.calls.length).toBe(closedCalls);
        await queue.getByRole('button', { name: 'Remove queued follow-up', exact: true }).click();
        await expect(queue).toBeHidden();
        const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0].messages;
        expect(saved.filter(message => message.role === 'user').map(message => message.text)).toEqual([question, 'Where does the path lead?', 'Wait for this one.', 'One more question.']);
    });
}
