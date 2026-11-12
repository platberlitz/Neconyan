/* global document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) test.use({ initialServerOptions: { checkoutRoot: '/srv/projects/Neconyan' } });
const SUMMARY = 'The earlier discussion agreed to keep the lighthouse open. The ferry timetable is still undecided.';

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} summarises older discussion without removing saved messages`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const open = async tab => {
            await page.evaluate(async tab => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab }), tab);
            if (phone) await applyIOSOnlyCss(page);
        };
        await open('context');
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        const messages = Array.from({ length: 60 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user',
            assistant: index % 2 ? 'miso' : undefined, text: `TURN-${index}`, created: '2026-11-12T00:00:00.000Z' }));
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Lighthouse discussion', messages,
            settings: { autoSummary: false, stream: false, connection: { kind: 'profile', profileId: 'durable' } } } });
        await open('context');
        const prefix = `../screenshots/scratchpad-summary/${phone ? 'phone' : 'desktop'}`;
        const section = page.locator('.scratchpad-summary-settings');
        if (before) {
            await expect(section).toHaveCount(0);
            await expect(async () => page.getByText('Saved notes', { exact: true }).first().scrollIntoViewIfNeeded()).toPass();
            await page.screenshot({ path: `${prefix}-before.png` });
            return;
        }
        const checkbox = section.locator('input[type="checkbox"]');
        await expect(checkbox).not.toBeChecked();
        const updated = page.waitForResponse('**/api/scratchpad/session/update');
        await checkbox.check();
        expect((await updated).ok()).toBe(true);
        await expect(async () => section.scrollIntoViewIfNeeded()).toPass();
        const bounds = await section.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.screenshot({ path: `${prefix}-after.png` });

        app.provider.mode.reply = body => ({ choices: [{ message: { content:
            body.messages[0].content.startsWith('Summarise an earlier Scratchpad discussion') ? SUMMARY : 'The lighthouse stays open.' } }] });
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        const ask = async text => {
            await page.locator('.scratchpad-composer').fill(text);
            const accepted = page.waitForResponse('**/api/scratchpad/send');
            await page.locator('.scratchpad-send').click();
            const response = await accepted;
            expect(response.ok(), await response.text()).toBe(true);
            await account.settled((await response.json()).job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            await expect(page.locator('.scratchpad-send')).toBeEnabled();
        };
        await ask('What did we decide?');
        expect(app.provider.calls).toHaveLength(2);
        expect(app.provider.calls[0].messages[1].content).toContain('TURN-0');
        const sent = app.provider.calls[1].messages;
        expect(sent.some(message => message.content === `<scratchpad_summary>\n${SUMMARY}\n</scratchpad_summary>`)).toBe(true);
        expect(sent.some(message => message.content === 'TURN-0')).toBe(false);
        expect(sent.some(message => message.content === 'TURN-40')).toBe(true);
        const read = async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions.find(item => item.name === 'Lighthouse discussion');
        const saved = await read();
        expect(saved.summary).toMatchObject({ text: SUMMARY, count: 40 });
        expect(saved.messages.slice(0, 60).map(message => message.text)).toEqual(messages.map(message => message.text));
        expect(saved.messages).toHaveLength(62);

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await section.locator('summary').click();
        await expect(section.locator('pre')).toHaveText(SUMMARY);
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${prefix}-summary.png` });
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await ask('What is still undecided?');
        expect(app.provider.calls).toHaveLength(3);
        expect((await read()).messages).toHaveLength(64);
        expect(app.provider.calls[2].messages.some(message => String(message.content).includes(SUMMARY))).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
}
