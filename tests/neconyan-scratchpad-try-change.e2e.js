/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-conditional-in-test -- Both viewports and the before build share one interaction contract. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) test.use({ initialServerOptions: { checkoutRoot: '/srv/projects/Neconyan' } });

const PROPOSED = 'TRIAL-PROPOSED Nova keeps a brass lantern lit for travellers.';
const EDITED = 'TRIAL-EDITED Nova keeps a blue lantern and hums while she works.';
const SAVES = /\/api\/(settings\/save|characters\/(edit|merge-attributes)|worldinfo\/edit|chats\/save)/;
const block = change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```';

async function insideViewport(locator, width) {
    for (const box of await locator.evaluateAll(items => items.map(item => item.getBoundingClientRect().toJSON()))) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(width);
    }
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    const width = phone ? 393 : 1280;

    test(`${viewport} tries a character change in a rehearsal before saving it`, async ({ app }) => {
        test.setTimeout(240000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes)).toBe('Hello.');
        const read = () => account.post('/api/characters/get', { avatar_url: account.avatar });
        const live = (await read()).data.description;
        expect(live).toContain('Nova belongs to account');
        const story = () => page.evaluate(() => JSON.stringify(window.SillyTavern.getContext().chat));
        const original = await story();

        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        expect(source.kind).toBe('roleplay');
        const changes = [
            { type: 'character', character: 'Durable Nova', field: 'description', value: PROPOSED },
            { type: 'regex', action: 'replace', script: 'missing-script', name: 'Missing', field: 'replaceString', value: 'hue' },
            { type: 'character', action: 'create', name: 'Pip', description: 'A small grey cat.', first_mes: 'Mrrp.' },
            { type: 'character', character: 'Durable Nova', field: 'personality', value: 'Warm and curious.' },
        ];
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Try a change',
            messages: [{ role: 'assistant', text: 'Three ideas.\n' + changes.map(block).join('\n') }] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.evaluate(() => window.toastr.remove());

        const cards = page.locator('.scratchpad-message.is-assistant').first().locator('.scratchpad-change');
        await expect(cards).toHaveCount(4);
        const card = cards.first();
        const dialog = page.locator('dialog[open]');
        const tryFirst = card.locator('.scratchpad-change-try');
        const shot = name => page.screenshot({ path: `../screenshots/scratchpad-try-change/${viewport}-${name}${before ? '-before' : ''}.png` });
        await card.scrollIntoViewIfNeeded();

        if (before) {
            await expect(card.locator('.scratchpad-change-actions button')).toHaveText(['Review', 'Dismiss']);
            await expect(tryFirst).toHaveCount(0);
            await shot('card');
            await card.getByRole('button', { name: 'Review', exact: true }).click();
            await expect(dialog.getByText('Save change', { exact: true })).toBeVisible();
            await expect(dialog.locator('.scratchpad-review-try')).toHaveCount(0);
            await shot('review');
            await dialog.getByText('Not now', { exact: true }).click();
            return;
        }

        // Try first sits between Review and Dismiss, only on cards a rehearsal can show.
        await expect(card.locator('.scratchpad-change-actions button')).toHaveText(['Review', 'Try first', 'Dismiss']);
        await expect(cards.nth(1).locator('.scratchpad-change-try')).toHaveCount(0);
        await expect(cards.nth(2).locator('.scratchpad-change-try')).toHaveCount(0);
        await expect(tryFirst).toBeEnabled();
        const box = await tryFirst.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
        await expect(cards.nth(3).locator('.scratchpad-change-try')).toBeEnabled();
        await insideViewport(page.locator('.scratchpad-change-actions > *'), width);
        await shot('card');

        // Opening the chat and the panel can leave a debounced settings save in flight, which a
        // loaded machine may send late. Let it land before counting saves made by the trial.
        let lastSave = Date.now();
        page.on('requestfinished', request => { if (SAVES.test(request.url())) lastSave = Date.now(); });
        await expect.poll(() => Date.now() - lastSave, { timeout: 30000, intervals: [500] }).toBeGreaterThan(3000);
        const saves = [];
        page.on('request', request => { if (request.method() === 'POST' && SAVES.test(request.url())) saves.push(request.url()); });
        const label = (await card.locator('.scratchpad-change-title span').textContent()).trim();
        expect(label).toBe('Change Durable Nova\'s description');
        const rehearse = async start => {
            app.provider.mode.reply = { choices: [{ message: { content: 'Nova lifts the lantern and smiles.' } }] };
            const sending = page.waitForResponse('**/api/scratchpad/send');
            await start();
            const response = await sending;
            expect(response.ok(), await response.text()).toBe(true);
            await account.settled((await response.json()).job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            const call = app.provider.calls.at(-1);
            expect(call.tools ?? []).toHaveLength(0);
            expect(call.messages[0].content).toContain('as a rehearsal');
            expect(call.messages.at(-1).content).toBe(`Rehearse the next story reply using this unsaved change: ${label}.`);
            return { body: response.request().postDataJSON(), sent: call.messages.map(message => String(message.content)).join('\n') };
        };
        const reply = page.locator('.scratchpad-message.is-assistant').last();
        const checkTrial = async () => {
            await expect(reply.locator('.scratchpad-badge')).toHaveText('Rehearsal · Unsaved change');
            await expect(reply.locator('.scratchpad-trial-note')).toHaveText(`Tried without saving: ${label}`);
            await expect(reply.locator('.scratchpad-trial-label')).toHaveAttribute('data-i18n-ignore', '');
            await expect(reply.locator('.scratchpad-change')).toHaveCount(0);
            await expect(card.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
            await expect(card).not.toContainText('Saved');
            expect((await read()).data.description).toBe(live);
            expect(await story()).toBe(original);
            expect(saves).toEqual([]);
        };

        const first = await rehearse(() => tryFirst.click());
        expect(first.body.rehearsal).toBe(true);
        expect(first.body.rehearsalLabel).toBe(label);
        expect(first.sent).toContain('## Unsaved change under rehearsal');
        expect(first.sent).toContain(PROPOSED);
        expect(first.sent).not.toContain('Nova belongs to account');
        await checkTrial();
        await reply.scrollIntoViewIfNeeded();
        await shot('reply');

        await card.scrollIntoViewIfNeeded();
        await card.getByRole('button', { name: 'Review', exact: true }).click();
        const tryDraft = dialog.locator('.scratchpad-review-try');
        await expect(tryDraft).toHaveText('Try before saving');
        await expect(tryDraft).not.toHaveClass(/disabled/);
        await insideViewport(dialog.locator('.popup-controls > *'), width);
        expect(await dialog.locator('.popup-controls').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await dialog.locator('.scratchpad-review-editor').fill(EDITED);
        await shot('review');
        const second = await rehearse(() => tryDraft.click());
        await expect(dialog).toHaveCount(0);
        expect(second.sent).toContain(EDITED);
        expect(second.sent).not.toContain(PROPOSED);
        await checkTrial();

        // Saving still goes through Review, and only then reaches the card.
        await card.scrollIntoViewIfNeeded();
        await card.getByRole('button', { name: 'Review', exact: true }).click();
        await expect(dialog.locator('.scratchpad-review-editor')).toHaveValue(PROPOSED);
        await dialog.getByText('Save change', { exact: true }).click();
        await expect(card).toContainText('Saved');
        await expect(card.locator('.scratchpad-change-try')).toHaveCount(0);
        await expect.poll(async () => (await read()).data.description).toBe(PROPOSED);
        expect(saves.length).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

        // The label stays readable on light and dark themes with the default, a pale and a dark accent.
        const other = cards.nth(3).locator('.scratchpad-change-try');
        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                await settleCssTransitions(page);
                const contrast = await other.evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const canvas = document.createElement('canvas').getContext('2d');
                    const channels = colour => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = colour; canvas.fillRect(0, 0, 1, 1); return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3); };
                    let surface = element;
                    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
                    return contrastRatio(channels(getComputedStyle(element).color), channels(getComputedStyle(surface ?? document.body).backgroundColor));
                });
                expect(contrast, `${theme} ${accent ?? 'default'}`).toBeGreaterThanOrEqual(4.5);
            }
        }
    });

    test(`${viewport} General Scratchpad offers no Try first`, async ({ app }) => {
        test.skip(before, 'The before build has no Try first anywhere.');
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        await expect(page.locator('.scratchpad-source')).toContainText('General Scratchpad');
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        expect(source.kind).toBe('general');
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'General ideas', messages: [{ role: 'assistant',
            text: 'One idea.\n' + block({ type: 'character', character: 'Durable Nova', field: 'description', value: PROPOSED }) }] } });
        await open();
        const card = page.locator('.scratchpad-change');
        await expect(card).toHaveCount(1);
        await expect(card.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
        await expect(card.locator('.scratchpad-change-try')).toHaveCount(0);
    });
}
