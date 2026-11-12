/* global document, window, requestAnimationFrame, getComputedStyle */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { installSyntheticLongChat } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const name = 'Kaveh & Alhaitham';
const text = 'The room falls quiet as he sets the book aside.\n\nHe looks towards the window, then turns back to continue their conversation.';
const generation = { source: 'custom', model: 'gemini-4-carbon', reasoning_effort: 'medium' };
const labels = { preparing: 'Preparing reply', 'waiting-memory': 'Waiting for memory', generating: 'Writing reply',
    agents: 'Running Agents', companions: 'Running Companions', review: 'Waiting for your review',
    translating: 'Translating reply', speech: 'Preparing speech', saving: 'Saving reply' };

async function afterPaint(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
        channel.port2.postMessage(0);
    })));
}

const geometry = page => page.evaluate(() => {
    const row = document.querySelector('#neconyan-roleplay-preview') || [...document.querySelectorAll('#chat .mes[mesid]')].at(-1);
    const header = row.querySelector('.ch_name').getBoundingClientRect();
    const heading = row.querySelector('.neconyan-message-heading').getBoundingClientRect();
    return { height: header.height, bodyOffset: row.querySelector('.mes_text').getBoundingClientRect().top - header.top,
        actions: row.querySelector('.mes_buttons').getBoundingClientRect().height,
        overflow: Math.max(0, heading.right - header.right) };
});

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`server reply header holds its height through every stage on ${viewport}`, async ({ app }, info) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }, configureSettings(saved) {
            saved.power_user.timestamp_model_name = true;
            saved.power_user.timestamp_reasoning_effort = true;
        } });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false, readyTimeout: 60000 });
        if (phone) await applyIOSOnlyCss(page);
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await installSyntheticLongChat(page, { messageCount: 6 });
        await expect(page.locator('#chat')).toBeVisible();
        // Expire the initial chat-load scroll pins before measuring.
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(2800);
        await fs.mkdir(new URL('../screenshots/stable-header/', import.meta.url), { recursive: true });
        const samples = [];
        for (const scenario of ['new', 'swipe', 'first-swipe', 'document-new', 'document-swipe']) {
            const replacement = scenario.includes('swipe');
            const firstSwipe = scenario === 'first-swipe';
            await page.evaluate(async ({ name, text, generation, replacement, firstSwipe, scenario }) => {
                const core = await import('/script.js');
                document.body.classList.toggle('documentstyle', scenario.startsWith('document'));
                const index = core.chat.length - 1;
                const message = { name, mes: text, is_user: false, is_system: false, send_date: new Date().toISOString(),
                    extra: { api: generation.source, model: generation.model, reasoning_effort: generation.reasoning_effort },
                    swipes: replacement && !firstSwipe ? ['An earlier reply.', text] : [text], swipe_id: replacement && !firstSwipe ? 1 : 0 };
                core.chat[index] = message;
                core.addOneMessage(message, { type: 'swipe', forceId: index, scroll: false });
                core.showSwipeButtons();
                const originalFetch = window.fetch;
                window.fetch = (input, options) => {
                    if (!String(input).includes('/api/jobs/header-regression/preview')) return originalFetch(input, options);
                    return Promise.resolve(new Response(new ReadableStream({ start(controller) {
                        window.sendHeaderPreview = frame => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ preview: frame })}\n\n`));
                    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
                };
                const { observeRoleplayPreview } = await import('/scripts/neconyan-conversation/roleplay-preview.js');
                window.headerPreviewStop = observeRoleplayPreview('header-regression', { account: 'header-test', isCurrent: () => true,
                    onTerminal() {}, ...(replacement ? { name: 'roleplay.swipe', messageIndex: index } : {}) });
                window.restoreHeaderFetch = () => { window.fetch = originalFetch; };
                window.headerSavedMessage = message;
                core.setRoleplayJobControls('header-regression', () => {});
            }, { name, text, generation, replacement, firstSwipe, scenario });
            await expect.poll(() => page.evaluate(() => typeof window.sendHeaderPreview)).toBe('function');
            const run = [];
            for (const [index, [stage, label]] of Object.entries(labels).entries()) {
                await page.evaluate(({ name, text, generation, stage, index }) => {
                    window.sendHeaderPreview({ childId: 'header', name, text, stage, updatedAt: Date.now(), ...(index > 1 ? { generation } : {}) });
                }, { name, text, generation, stage, index });
                await expect(page.locator('#neconyan-roleplay-preview [role="status"]')).toContainText(label);
                await expect(page.locator('#neconyan-roleplay-preview .mes_buttons')).toHaveAttribute('inert', '');
                await expect(page.locator('#neconyan-roleplay-preview .mes_buttons')).toHaveAttribute('aria-disabled', 'true');
                if (replacement) await expect(page.locator('#neconyan-roleplay-preview .mes_delete_add_swipe')).toBeVisible();
                await afterPaint(page);
                run.push({ stage, ...await geometry(page) });
                if (stage === 'agents' && ['new', 'swipe'].includes(scenario)) {
                    await page.locator('#neconyan-roleplay-preview').scrollIntoViewIfNeeded();
                    await page.screenshot({ scale: 'css', path: new URL(`../screenshots/stable-header/${process.env.HEADER_CAPTURE || 'after'}-${viewport}-${replacement ? 'swipe' : 'new'}.png`, import.meta.url).pathname });
                }
            }
            await page.evaluate(async ({ replacement, firstSwipe }) => {
                const core = await import('/script.js');
                window.headerPreviewStop();
                window.restoreHeaderFetch();
                const message = window.headerSavedMessage;
                if (firstSwipe) { message.swipes.push(message.mes); message.swipe_id = 1; }
                if (replacement) core.addOneMessage(message, { type: 'swipe', forceId: core.chat.length - 1, scroll: false });
                else { core.chat.push(structuredClone(message)); core.addOneMessage(core.chat.at(-1), { scroll: false }); }
                core.setRoleplayJobControls(null);
                core.showSwipeButtons();
            }, { replacement, firstSwipe });
            await afterPaint(page);
            run.push({ stage: 'saved', ...await geometry(page) });
            await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_buttons')).not.toHaveAttribute('inert');
            samples.push({ scenario, run });
        }
        await info.attach('header-measurements', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
        console.log(viewport, JSON.stringify(samples));
        for (const { run } of samples) {
            expect(run.every(sample => sample.actions > 0 && sample.overflow <= 0.5)).toBe(true);
            expect(Math.max(...run.map(sample => sample.height)) - Math.min(...run.map(sample => sample.height))).toBeLessThanOrEqual(0.5);
            expect(Math.max(...run.map(sample => sample.bodyOffset)) - Math.min(...run.map(sample => sample.bodyOffset))).toBeLessThanOrEqual(0.5);
        }
        const contrasts = [];
        for (const accent of [null, 'Pearl', 'Midnight Ink']) {
            if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
            await afterPaint(page);
            const ratios = await page.locator('#chat .mes[mesid]').last().evaluate(async row => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas').getContext('2d');
                const background = getComputedStyle(document.body).getPropertyValue('--neco-surface');
                const channels = colour => {
                    canvas.clearRect(0, 0, 1, 1);
                    canvas.fillStyle = background;
                    canvas.fillRect(0, 0, 1, 1);
                    canvas.fillStyle = colour;
                    canvas.fillRect(0, 0, 1, 1);
                    return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
                };
                return [...row.querySelectorAll('.mes_buttons > .neconyan-message-action')]
                    .filter(button => button.getClientRects().length)
                    .map(button => contrastRatio(channels(getComputedStyle(button).color), channels(getComputedStyle(button).backgroundColor)));
            });
            contrasts.push({ accent: accent || 'default', ratios });
            expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
        }
        await info.attach('action-contrast', { body: JSON.stringify(contrasts), contentType: 'application/json' });
    });
}
