/* global window, document, getComputedStyle */
/* eslint-disable playwright/no-force-option -- Exercise roleplay and theme selection without opening drawers. */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

async function measure(page, selector = '#chat > .mes[is_user="false"]') {
    return page.locator(selector).evaluateAll(rows => rows.map(row => {
        const cat = row.querySelector(':scope > .neconyan-message-sleeper');
        const block = row.querySelector('.mes_block');
        const avatar = row.querySelector('.mesAvatarWrapper');
        const c = cat.getBoundingClientRect(), b = block.getBoundingClientRect(), a = avatar.getBoundingClientRect();
        return { left: c.left, blockLeft: b.left, avatarWidth: a.width, overhang: b.left - c.left,
            pawError: c.top + 41 - b.top, cssLeft: getComputedStyle(cat).left };
    }));
}

test('Flat Roleplay assistant cats follow avatar width and preserve excluded modes', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    await page.evaluate(async () => { await (await import('/scripts/extensions.js')).enableExtension('third-party/Neconyan-Terminal-UI', false); });
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar));
        context.chat.splice(0, context.chat.length,
            { name: 'Miso', is_user: false, is_system: false, mes: 'Earlier response.', swipes: ['Earlier response.'], swipe_id: 0, send_date: Date.now(), extra: {} },
            { name: 'You', is_user: true, is_system: false, mes: 'A reply.', send_date: Date.now(), extra: {} },
            { name: 'Miso', is_user: false, is_system: false, mes: 'Final response.', swipes: ['Final response.'], swipe_id: 0, send_date: Date.now(), extra: {} });
        await context.saveChat(); await context.reloadCurrentChat();
        window.NeconyanShell.applyTheme('calico');
    }, account.avatar);
    await page.locator('#chat_display').selectOption('0', { force: true });
    await expect(page.locator('body')).toHaveClass(/flatchat/);
    await expect(page.locator('body')).toHaveAttribute('data-neconyan-chat-mode', 'roleplay');
    for (const theme of ['Neconyan Calico', 'Neconyan Calico Dark']) {
        await page.locator('#themes').selectOption({ label: theme }, { force: true });
        for (const row of await page.locator('#chat > .mes[is_user="false"]').all()) {
            const geometry = await row.evaluate(element => {
                const cat = element.querySelector(':scope > .neconyan-message-sleeper').getBoundingClientRect();
                const block = element.querySelector('.mes_block').getBoundingClientRect();
                const avatar = element.querySelector('.mesAvatarWrapper').getBoundingClientRect();
                return { overhang: block.left - cat.left, pawError: cat.top + 41 - block.top, avatarWidth: avatar.width };
            });
            expect(Math.abs(geometry.pawError)).toBeLessThanOrEqual(1);
            expect.soft(geometry.overhang, `${theme}: assistant tail overhang`).toBeCloseTo(17, 0);
        }
    }
    const baseline = await measure(page);
    await test.info().attach('flat-roleplay-cat-geometry.json', { body: JSON.stringify(baseline, null, 2), contentType: 'application/json' });

    // Exercise the real range popup and foreign-object PNG renderer after screenshot sanitisation removes the checkbox spacer.
    await page.addScriptTag({ url: '/lib/html2canvas.min.js' });
    await page.evaluate(() => {
        const originalRenderer = window.html2canvas;
        window.__flatRoleplayScreenshotCaptures = [];
        window.html2canvas = (surface, options) => {
            const rect = element => element?.getBoundingClientRect().toJSON();
            const geometry = row => {
                const cat = row?.querySelector(':scope > .neconyan-message-sleeper');
                const block = row?.querySelector('.mes_block');
                const avatar = row?.querySelector('.mesAvatarWrapper');
                const c = rect(cat), b = rect(block), a = rect(avatar), r = rect(row);
                return { cat: c, block: b, avatar: a, row: r, inlineLeft: cat?.style.left,
                    catLeftInRow: c && c.left - r.left, catRightInRow: c && r.right - c.right,
                    blockLeftInRow: b && b.left - r.left, blockRightInRow: b && r.right - b.right,
                    overhang: c && b.left - c.left, pawError: c && c.top + 41 - b.top,
                    checkboxPresent: Boolean(row?.querySelector('.for_checkbox')), mesid: row?.getAttribute('mesid') };
            };
            const sourceAssistant = surface.querySelector('.mes[is_user="false"][mesid="2"]');
            const sourceUser = surface.querySelector('.mes[is_user="true"][mesid="1"]');
            const source = { className: surface.className, foreignObjectRendering: options.foreignObjectRendering,
                assistant: geometry(sourceAssistant), user: geometry(sourceUser) };
            const originalOnclone = options.onclone;
            options.onclone = (clonedDocument, clonedSurface) => {
                originalOnclone(clonedDocument, clonedSurface);
                window.__flatRoleplayScreenshotCaptures.push({ source, clone: {
                    chatPresent: Boolean(clonedDocument.querySelector('#chat')),
                    assistant: geometry(clonedSurface.querySelector('.mes[is_user="false"][mesid="2"]')),
                    user: geometry(clonedSurface.querySelector('.mes[is_user="true"][mesid="1"]')),
                } });
            };
            return originalRenderer(surface, options);
        };
    });
    for (const theme of ['Neconyan Calico', 'Neconyan Calico Dark']) {
        await page.locator('#themes').selectOption({ label: theme }, { force: true });
        const beforeUser = await page.locator('#chat > .mes[is_user="true"][mesid="1"]').evaluate(row => {
            const cat = row.querySelector(':scope > .neconyan-message-sleeper').getBoundingClientRect();
            const block = row.querySelector('.mes_block').getBoundingClientRect();
            return { left: cat.left, right: cat.right, blockLeft: block.left, blockRight: block.right };
        });
        await page.locator('#chat > .mes[mesid="2"] .mes_screenshot').dispatchEvent('click');
        await expect(page.locator('.message_screenshot_popup')).toBeVisible();
        await page.locator('#message_screenshot_start_id').fill('0');
        await page.locator('#message_screenshot_end_id').fill('2');
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download PNG' }).click();
        const download = await downloadPromise;
        const pngPath = test.info().outputPath(`${theme.endsWith('Dark') ? 'dark' : 'light'}-roleplay-range.png`);
        await download.saveAs(pngPath);
        const png = await fs.readFile(pngPath);
        expect(png.subarray(1, 4).toString()).toBe('PNG');
        await test.info().attach(`${theme}-actual-range-export.png`, { path: pngPath, contentType: 'image/png' });
        await expect.poll(() => page.evaluate(() => window.__flatRoleplayScreenshotCaptures.length)).toBeGreaterThan(0);
        const capture = await page.evaluate(() => window.__flatRoleplayScreenshotCaptures.at(-1));
        expect(capture.source.className).toContain('sb-message-screenshot-surface');
        expect(capture.source.foreignObjectRendering).toBe(true);
        expect(capture.source.assistant.checkboxPresent).toBe(false);
        expect(capture.source.assistant.mesid).toBe('2');
        expect(capture.clone.assistant.checkboxPresent).toBe(false);
        expect(capture.clone.assistant.mesid).toBe('2');
        expect(capture.clone.chatPresent).toBe(false);
        expect.soft(capture.source.assistant.overhang, `${theme}: sanitised source assistant tail`).toBeCloseTo(17, 0);
        expect.soft(Math.abs(capture.source.assistant.pawError), `${theme}: sanitised source assistant paws`).toBeLessThanOrEqual(1);
        expect.soft(capture.clone.assistant.overhang, `${theme}: rendered clone assistant tail`).toBeCloseTo(17, 0);
        expect.soft(Math.abs(capture.clone.assistant.pawError), `${theme}: rendered clone assistant paws`).toBeLessThanOrEqual(1);
        expect.soft(capture.clone.assistant.inlineLeft, `${theme}: copied screenshot offset`).toBe(`${capture.source.assistant.avatar.width + 1}px`);
        expect(capture.clone.user.catLeftInRow).toBeCloseTo(capture.source.user.catLeftInRow, 0);
        expect(capture.clone.user.catRightInRow).toBeCloseTo(capture.source.user.catRightInRow, 0);
        expect(capture.clone.user.blockLeftInRow).toBeCloseTo(capture.source.user.blockLeftInRow, 0);
        expect(capture.clone.user.blockRightInRow).toBeCloseTo(capture.source.user.blockRightInRow, 0);
        const afterUser = await page.locator('#chat > .mes[is_user="true"][mesid="1"]').evaluate(row => {
            const cat = row.querySelector(':scope > .neconyan-message-sleeper').getBoundingClientRect();
            const block = row.querySelector('.mes_block').getBoundingClientRect();
            return { left: cat.left, right: cat.right, blockLeft: block.left, blockRight: block.right };
        });
        expect(afterUser).toEqual(beforeUser);
    }

    // Enter Terminal UI through its real settings control, then return to the same Flat Roleplay layout.
    await page.locator('#sbterm-enabled').evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(page.locator('body')).toHaveClass(/sbterm/);
    const terminal = await page.locator('#chat > .mes[is_user="false"][mesid]').first().evaluate(row => {
        const cat = row.querySelector(':scope > .neconyan-message-sleeper').getBoundingClientRect();
        const outer = row.getBoundingClientRect();
        return { overhang: outer.left - cat.left, pawError: cat.top + 41 - outer.top };
    });
    expect(terminal.overhang, 'Terminal cat remains anchored to its outer row').toBeCloseTo(17, 0);
    expect(Math.abs(terminal.pawError)).toBeLessThanOrEqual(1);
    await page.locator('#sbterm-enabled').evaluate(el => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(page.locator('body')).not.toHaveClass(/sbterm/);
    await expect(page.locator('body')).toHaveAttribute('data-neconyan-chat-mode', 'roleplay');
    for (const row of await page.locator('#chat > .mes[is_user="false"][mesid]').all()) {
        const geometry = await row.evaluate(element => {
            const cat = element.querySelector(':scope > .neconyan-message-sleeper').getBoundingClientRect();
            const block = element.querySelector('.mes_block').getBoundingClientRect();
            return { overhang: block.left - cat.left, pawError: cat.top + 41 - block.top };
        });
        expect(geometry.overhang, 'Flat Roleplay cat returns to its block').toBeCloseTo(17, 0);
        expect(Math.abs(geometry.pawError)).toBeLessThanOrEqual(1);
    }

    // Native draft construction follows the real preview path, which hides the checkbox placeholder.
    await page.evaluate(async () => {
        const core = await import('/script.js');
        const context = window.SillyTavern.getContext();
        const draft = { name: 'Miso', is_user: false, is_system: false, mes: 'A native draft.', send_date: Date.now(), extra: {} };
        const element = core.updateMessageElement(draft, { messageId: context.chat.length, isPreview: true });
        document.querySelector('#chat').append(element[0]);
    });
    const draft = await measure(page, '#chat > .mes[data-roleplay-draft]');
    expect(draft).toHaveLength(1);
    expect(draft[0].overhang, 'native draft tail overhang').toBeCloseTo(17, 0);
    expect(Math.abs(draft[0].pawError)).toBeLessThanOrEqual(1);

});
