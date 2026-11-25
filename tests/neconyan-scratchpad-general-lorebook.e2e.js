/* global document, window, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const REFUSAL = 'Share that lorebook under Context before saving a change to it.';
const ACCENTS = [null, 'rgba(110,231,183,1)', 'rgba(126,34,206,1)'];

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} General Scratchpad shares several hand-picked lorebooks for that session only`, async ({ app }) => {
        test.setTimeout(240000);
        const width = phone ? 393 : 1280;
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.post('/api/worldinfo/edit', { name: 'Harbour', data: { entries: {
            0: { uid: 0, comment: 'Ferry', key: ['ferry'], constant: true, content: 'The ferry leaves at dawn.' },
            1: { uid: 1, comment: 'Cellar', key: ['cellar'], constant: true, agentBlacklisted: true, content: 'The hidden cellar is under the pier.' },
            2: { uid: 2, comment: 'Tide', key: ['tide'], constant: true, content: 'The tide turns at noon.' },
        } } });
        await account.post('/api/worldinfo/edit', { name: 'Garden', data: { entries: {
            0: { uid: 0, comment: 'Roses', key: ['roses'], constant: true, content: 'The roses are white.' },
            1: { uid: 1, comment: 'Gnome', key: ['gnome'], constant: true, agentBlacklisted: true, content: 'The secret gnome guards the shed.' },
        } } });
        await account.post('/api/worldinfo/edit', { name: 'Vault', data: { entries: {
            0: { uid: 0, comment: 'Code', key: ['code'], constant: true, content: 'The strongroom code is 1234.' },
        } } });

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
        const changes = [
            { type: 'lorebook', action: 'edit', book: 'Garden', uid: 0, content: 'The roses are red.' },
            { type: 'lorebook', action: 'edit', book: 'Harbour', uid: 0, content: 'The ferry leaves at dusk.' },
            { type: 'lorebook', action: 'edit', book: 'Vault', uid: 0, content: 'The strongroom code is 9999.' },
            { type: 'lorebook', action: 'edit', book: 'Harbour', uid: 2, content: 'The tide turns at midnight.' },
        ];
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Lore edits', messages: [{ role: 'assistant',
            text: 'Intro.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') }] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);

        const shots = name => path.resolve('../screenshots/scratchpad-general-lorebook', `${phone ? 'phone' : 'desktop'}-${name}.png`);
        const cards = page.locator('.scratchpad-change');
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container');
        const picker = page.locator('#scratchpad-lorebook');
        const chips = page.locator('.scratchpad-shared-lorebooks .scratchpad-shared-lorebook');
        const review = index => cards.nth(index).getByRole('button', { name: 'Review', exact: true });
        const clearToasts = async () => {
            await page.evaluate(() => window.toastr.clear());
            await expect(toasts.locator('.toast')).toHaveCount(0);
        };
        const tab = name => page.getByRole('tab', { name, exact: true });
        const settings = async () => {
            const bucket = (await account.post('/api/scratchpad/bucket', { source })).bucket;
            return bucket.sessions.find(session => session.id === bucket.activeSessionId)?.settings;
        };
        const share = async name => {
            const updated = page.waitForResponse('**/api/scratchpad/session/update');
            await picker.selectOption(name);
            expect((await updated).ok()).toBe(true);
            await expect(chips.filter({ hasText: name })).toHaveCount(1);
            await expect(picker).toHaveValue('');
            await expect(picker.locator(`option[value="${name}"]`)).toHaveCount(0);
        };
        const sendQuestion = async question => {
            await page.locator('.scratchpad-composer').fill(question);
            const accepted = page.waitForResponse('**/api/scratchpad/send');
            await page.locator('.scratchpad-send').click();
            const response = await accepted;
            expect(response.ok(), await response.text()).toBe(true);
            await account.settled((await response.json()).job.id);
            await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
            const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
            expect(calls).toHaveLength(1);
            return calls[0].messages.map(message => String(message.content)).join('\n');
        };
        const noSidewaysScroll = async () => {
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        };
        const chipGeometry = async () => {
            const boxes = await chips.evaluateAll(items => items.map(item => {
                const chip = item.getBoundingClientRect();
                const remove = item.querySelector('.scratchpad-shared-lorebook-remove').getBoundingClientRect();
                const name = item.querySelector('.scratchpad-shared-lorebook-name').getBoundingClientRect();
                return { left: chip.left, right: chip.right, removeLeft: remove.left, removeRight: remove.right, width: remove.width, height: remove.height, name: name.right };
            }));
            for (const box of boxes) {
                expect(box.left).toBeGreaterThanOrEqual(0);
                expect(box.right).toBeLessThanOrEqual(width);
                expect(box.removeRight).toBeLessThanOrEqual(box.right);
                expect(box.name).toBeLessThanOrEqual(box.removeLeft);
                if (phone) {
                    expect(box.height).toBeGreaterThanOrEqual(44);
                    expect(box.width).toBeGreaterThanOrEqual(44);
                }
            }
        };
        await expect(cards).toHaveCount(4);

        await review(1).click();
        await expect(toasts).toContainText(REFUSAL);
        await expect(dialog).toHaveCount(0);
        await clearToasts();

        await tab('Context').click();
        await expect(picker).toHaveValue('');
        await expect(chips).toHaveCount(0);
        await expect(page.getByText('Shared in this session only. Entries hidden from assistants stay hidden.')).toBeVisible();
        await expect(page.getByRole('checkbox', { name: 'Lorebook entries', exact: true })).toHaveCount(0);
        await picker.scrollIntoViewIfNeeded();
        const box = await picker.boundingBox();
        if (phone) expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await share('Harbour');
        await share('Garden');
        await expect(chips).toHaveText([/Harbour/, /Garden/]);
        await expect(page.getByRole('list', { name: 'Shared lorebooks' })).toBeVisible();
        await expect.poll(async () => (await settings())?.lorebooks).toEqual(['Harbour', 'Garden']);
        expect((await settings()).lorebook).toBe('Harbour');
        await chipGeometry();
        await noSidewaysScroll();
        await page.locator('.scratchpad-general-lorebooks').scrollIntoViewIfNeeded();
        await page.screenshot({ path: shots('context') });

        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        const preview = page.locator('pre.scratchpad-preview-text');
        await expect(preview).toContainText('Lorebooks shared by hand for this session: Harbour, Garden');
        await expect(preview).toContainText('2 lorebooks were shared by hand for this session.');
        await expect(preview).toContainText('The ferry leaves at dawn.');
        await expect(preview).toContainText('The roses are white.');
        await expect(preview).not.toContainText('hidden cellar');
        await expect(preview).not.toContainText('secret gnome');
        await expect(preview).not.toContainText('strongroom');
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();

        await tab('Chat').click();
        await review(2).click();
        await expect(toasts).toContainText(REFUSAL);
        await expect(dialog).toHaveCount(0);
        await clearToasts();

        await review(1).click();
        await expect(dialog).toContainText('Harbour');
        const dialogBox = await dialog.boundingBox();
        expect(dialogBox.x).toBeGreaterThanOrEqual(0);
        expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: shots('review') });
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(cards.nth(1)).toContainText('Saved');
        await clearToasts();

        const sent = await sendQuestion('When does the ferry leave?');
        expect(sent).toContain('Lorebook entries (only');
        expect(sent).toContain('shared 2 lorebooks by hand for this session');
        expect(sent).toContain('Lorebooks shared by hand for this session: Harbour, Garden');
        expect(sent).toContain('The ferry leaves at dusk.');
        expect(sent).toContain('The roses are white.');
        expect(sent).not.toContain('hidden cellar');
        expect(sent).not.toContain('secret gnome');
        expect(sent).not.toContain('strongroom');
        await noSidewaysScroll();

        await tab('Context').click();
        const removed = page.waitForResponse('**/api/scratchpad/session/update');
        await page.getByRole('button', { name: 'Remove Harbour', exact: true }).click();
        expect((await removed).ok()).toBe(true);
        await expect(chips).toHaveText([/Garden/]);
        await expect(picker.locator('option[value="Harbour"]')).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Remove Garden', exact: true })).toBeFocused();
        await expect.poll(async () => (await settings())?.lorebooks).toEqual(['Garden']);
        await tab('Chat').click();
        await review(3).click();
        await expect(toasts).toContainText(REFUSAL);
        await expect(dialog).toHaveCount(0);
        await clearToasts();
        await review(0).click();
        await expect(dialog).toContainText('Garden');
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(cards.nth(0)).toContainText('Saved');
        await expect(cards.nth(3)).not.toContainText('Saved');
        await clearToasts();
        await page.screenshot({ path: shots('saved') });

        const harbour = (await account.post('/api/worldinfo/get', { name: 'Harbour' })).entries;
        expect(harbour[0].content).toBe('The ferry leaves at dusk.');
        expect(harbour[1].content).toBe('The hidden cellar is under the pier.');
        expect(harbour[2].content).toBe('The tide turns at noon.');
        expect((await account.post('/api/worldinfo/get', { name: 'Garden' })).entries[0].content).toBe('The roses are red.');
        expect((await account.post('/api/worldinfo/get', { name: 'Vault' })).entries[0].content).toBe('The strongroom code is 1234.');

        const later = await sendQuestion('What colour are the roses?');
        expect(later).toContain('shared one lorebook by hand');
        expect(later).toContain('The roses are red.');
        expect(later).not.toContain('ferry leaves');

        await tab('Context').click();
        await share('Vault');
        await account.post('/api/worldinfo/delete', { name: 'Vault' });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        if (await skip.isVisible()) await skip.click();
        await open();
        if (phone) await applyIOSOnlyCss(page);
        await tab('Context').click();
        await expect(chips).toHaveText([/Garden/, /Vault/]);
        await expect(chips.nth(1)).toContainText('Not found. It may have been renamed or deleted.');
        await expect(picker.locator('option[value="Vault"]')).toHaveCount(0);
        await chipGeometry();
        await noSidewaysScroll();
        await page.locator('.scratchpad-general-lorebooks').scrollIntoViewIfNeeded();
        await page.screenshot({ path: shots('missing') });
        const dropped = page.waitForResponse('**/api/scratchpad/session/update');
        await page.getByRole('button', { name: 'Remove Vault', exact: true }).click();
        expect((await dropped).ok()).toBe(true);
        await expect(chips).toHaveText([/Garden/]);
        await expect.poll(async () => (await settings())?.lorebooks).toEqual(['Garden']);

        const contrast = [];
        for (const accent of ACCENTS) {
            await page.evaluate(value => {
                if (!value) return;
                for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) {
                    document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba: value } }));
                }
            }, accent);
            await settleCssTransitions(page);
            const ratios = await chips.first().evaluate(chip => {
                const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
                const alpha = colour => {
                    ctx.clearRect(0, 0, 1, 1);
                    ctx.fillStyle = colour;
                    ctx.fillRect(0, 0, 1, 1);
                    return ctx.getImageData(0, 0, 1, 1).data[3];
                };
                const paintBackdrop = element => {
                    const layers = [];
                    for (let node = element; node; node = node.parentElement) {
                        const colour = getComputedStyle(node).backgroundColor;
                        layers.push(colour);
                        if (alpha(colour) === 255) break;
                    }
                    ctx.clearRect(0, 0, 1, 1);
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(0, 0, 1, 1);
                    for (const colour of layers.reverse()) {
                        ctx.fillStyle = colour;
                        ctx.fillRect(0, 0, 1, 1);
                    }
                };
                const luminance = () => [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(c => {
                    const value = c / 255;
                    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
                const ratio = text => {
                    paintBackdrop(text);
                    const back = luminance();
                    ctx.fillStyle = getComputedStyle(text).color;
                    ctx.fillRect(0, 0, 1, 1);
                    const fore = luminance();
                    return (Math.max(back, fore) + 0.05) / (Math.min(back, fore) + 0.05);
                };
                return {
                    name: ratio(chip.querySelector('.scratchpad-shared-lorebook-name')),
                    remove: ratio(chip.querySelector('.scratchpad-shared-lorebook-remove span')),
                };
            });
            contrast.push({ accent: accent || 'default', ...ratios });
            expect(ratios.name, accent || 'default').toBeGreaterThanOrEqual(4.5);
            expect(ratios.remove, accent || 'default').toBeGreaterThanOrEqual(4.5);
            await chipGeometry();
            if (accent) await page.screenshot({ path: shots(`accent-${accent.startsWith('rgba(110') ? 'mint' : 'plum'}`) });
        }
        await test.info().attach('shared-lorebook-contrast', { body: JSON.stringify(contrast, null, 2), contentType: 'application/json' });

        const created = page.waitForResponse('**/api/scratchpad/session/create');
        await page.locator('.scratchpad-header .scratchpad-new-session').click();
        expect((await created).ok()).toBe(true);
        await tab('Context').click();
        await expect(picker).toHaveValue('');
        await expect(chips).toHaveCount(0);
        await expect(picker.locator('option[value="Garden"]')).toHaveCount(1);
        await expect.poll(async () => (await settings())?.lorebooks).toEqual([]);
    });
}
