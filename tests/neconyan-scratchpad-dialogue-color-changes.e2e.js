/* global document */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const ROOT = '/scripts/extensions/third-party/sillytavern-character-colors/src';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad saves a reviewed dialogue colour only while Dialogue Colors are shared`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });

        const page = await account.open();
        await page.evaluate(async root => {
            const { setCharacterColors } = await import(`${root}/state.js`);
            const { normalizeCharacterColors } = await import(`${root}/utils.js`);
            const { saveData } = await import(`${root}/storage.js`);
            setCharacterColors(normalizeCharacterColors({
                nova: { name: 'Nova', baseColor: '#aa0000', color: '#aa0000' },
                mira: { name: 'Mira', baseColor: '#00aa00', color: '#00aa00' },
            }));
            saveData();
        }, ROOT);
        const baseColor = key => page.evaluate(async ([root, name]) => {
            const { characterColors } = await import(`${root}/state.js`);
            const { getBaseColor } = await import(`${root}/palettes.js`);
            return characterColors[name] ? getBaseColor(characterColors[name]) : null;
        }, [ROOT, key]);
        expect(await baseColor('nova')).toBe('#aa0000');

        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        const changes = [
            { type: 'dialogue-color', action: 'replace', character: 'Nova', value: '#3366CC' },
            { type: 'dialogue-color', action: 'replace', character: 'Mira', value: '#cc6633' },
            { type: 'dialogue-color', action: 'replace', character: 'Nobody', value: '#123456' },
        ];
        await account.post('/api/scratchpad/session/import', {
            source,
            session: {
                name: 'Colour edits',
                messages: [{ role: 'assistant', text: 'Three edits.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') }],
            },
        });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const shots = name => path.resolve('../screenshots/scratchpad-dialogue-color-changes', `${phone ? 'phone' : 'desktop'}-${name}.png`);
        const cards = page.locator('.scratchpad-change');
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container');
        const review = index => cards.nth(index).getByRole('button', { name: 'Review', exact: true });

        await expect(cards).toHaveCount(3);
        await expect(cards.nth(0)).toContainText('Change dialogue colour of \'Nova\'');

        await review(0).click();
        await expect(toasts).toContainText('Share Dialogue Colors under Context before saving a change to one.');
        await expect(dialog).toHaveCount(0);

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        const share = page.locator('label.scratchpad-check', { hasText: 'Shares the name and colour of every character' });
        await share.scrollIntoViewIfNeeded();
        const box = await share.boundingBox();
        if (phone) expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        const updated = page.waitForResponse('**/api/scratchpad/session/update');
        await share.locator('input[type="checkbox"]').check();
        expect((await updated).ok()).toBe(true);
        await page.screenshot({ path: shots('context') });
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        const preview = page.locator('pre.scratchpad-preview-text');
        await expect(preview).toContainText('## Dialogue Colors');
        await expect(preview).toContainText('- Nova: #aa0000');
        await expect(preview).toContainText('- Mira: #00aa00');
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();

        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await review(0).click();
        await expect(dialog).toContainText('Dialogue colour: Nova');
        await expect(dialog).toContainText('Colour');
        await page.screenshot({ path: shots('review') });
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(cards.nth(0)).toContainText('Saved');
        expect(await baseColor('nova')).toBe('#3366cc');
        expect(await baseColor('mira')).toBe('#00aa00');
        await page.screenshot({ path: shots('saved') });

        await review(2).click();
        await expect(toasts).toContainText('There is no character with that name in the colour table in use.');
        await expect(dialog).toHaveCount(0);

        await review(1).click();
        await expect(dialog).toContainText('Dialogue colour: Mira');
        await page.evaluate(async root => {
            const { characterColors } = await import(`${root}/state.js`);
            const { setEntryFromBaseColor } = await import(`${root}/palettes.js`);
            setEntryFromBaseColor(characterColors.mira, '#0000aa');
        }, ROOT);
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(toasts).toContainText('changed while the review was open');
        expect(await baseColor('mira')).toBe('#0000aa');
        await expect(cards.nth(1)).not.toContainText('Saved');

        const question = 'Pick a calmer colour for Nova.';
        app.provider.mode.reply = { choices: [{ message: { content: 'Here is a calmer one.' } }] };
        await page.locator('.scratchpad-composer').fill(question);
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
        expect(calls).toHaveLength(1);
        const sent = calls[0].messages.map(message => String(message.content)).join('\n');
        expect(sent).toContain('"type":"dialogue-color"');
        expect(sent).toContain('- Nova: #3366cc');

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

        await page.evaluate(async () => (await import('/script.js')).saveSettings());
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await expect.poll(() => baseColor('nova')).toBe('#3366cc');
    });
}
