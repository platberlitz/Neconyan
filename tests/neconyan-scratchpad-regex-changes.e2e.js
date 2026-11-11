/* global document */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const SCRIPT = {
    id: 'tidy-script',
    scriptName: 'Tidy',
    findRegex: '/colour/g',
    replaceString: 'color',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
};

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad saves a reviewed regex script change only while Regexes are shared`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });

        const page = await account.open();
        await page.evaluate(async script => {
            const { extension_settings } = await import('/scripts/extensions.js');
            const { saveSettings } = await import('/script.js');
            extension_settings.regex = [...(extension_settings.regex ?? []).filter(item => item.id !== script.id), script];
            await saveSettings();
        }, SCRIPT);
        const savedScript = () => page.evaluate(async id => {
            const { extension_settings } = await import('/scripts/extensions.js');
            return structuredClone(extension_settings.regex.find(item => item.id === id));
        }, SCRIPT.id);

        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        const changes = [
            { type: 'regex', action: 'replace', script: SCRIPT.id, name: SCRIPT.scriptName, field: 'findRegex', value: '/colou?r/gi' },
            { type: 'regex', action: 'replace', script: SCRIPT.id, name: SCRIPT.scriptName, field: 'replaceString', value: 'hue' },
            { type: 'regex', action: 'replace', script: SCRIPT.id, name: SCRIPT.scriptName, field: 'findRegex', value: '/colou(r/g' },
        ];
        await account.post('/api/scratchpad/session/import', {
            source,
            session: {
                name: 'Regex edits',
                messages: [{ role: 'assistant', text: 'Three edits.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') }],
            },
        });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const shots = name => path.resolve('../screenshots/scratchpad-regex-changes', `${phone ? 'phone' : 'desktop'}-${name}.png`);
        const cards = page.locator('.scratchpad-change');
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container');
        const review = index => cards.nth(index).getByRole('button', { name: 'Review', exact: true });

        await expect(cards).toHaveCount(3);
        await expect(cards.nth(0)).toContainText('Change regex script \'Tidy\': findRegex');
        await expect(cards.nth(1)).toContainText('Change regex script \'Tidy\': replaceString');

        await review(0).click();
        await expect(toasts).toContainText('Share Regexes under Context before saving a change to one.');
        await expect(dialog).toHaveCount(0);

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        const share = page.locator('label.scratchpad-check', { hasText: 'Shares the name, Find pattern and replacement' });
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
        await expect(preview).toContainText('## Regexes');
        await expect(preview).toContainText('ID: tidy-script');
        await expect(preview).toContainText('/colour/g');
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();

        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await review(0).click();
        await expect(dialog).toContainText('Regex script: Tidy');
        await expect(dialog).toContainText('Find pattern');
        await page.screenshot({ path: shots('review') });
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(cards.nth(0)).toContainText('Saved');
        expect((await savedScript()).findRegex).toBe('/colou?r/gi');
        await page.screenshot({ path: shots('saved') });

        await review(2).click();
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(toasts).toContainText('not a valid regular expression');
        expect((await savedScript()).findRegex).toBe('/colou?r/gi');
        await expect(dialog).toHaveCount(0);

        await review(1).click();
        await expect(dialog).toContainText('Replace with');
        await page.evaluate(async id => {
            const { extension_settings } = await import('/scripts/extensions.js');
            extension_settings.regex.find(item => item.id === id).replaceString = 'Changed elsewhere.';
        }, SCRIPT.id);
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(toasts).toContainText('changed while the review was open');
        expect((await savedScript()).replaceString).toBe('Changed elsewhere.');
        await expect(cards.nth(1)).not.toContainText('Saved');

        const question = 'Tidy the Tidy script.';
        app.provider.mode.reply = { choices: [{ message: { content: 'Here is a tidier one.' } }] };
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
        expect(sent).toContain('"type":"regex"');
        expect(sent).toContain('ID: tidy-script');
        expect(sent).toContain('/colou?r/gi');

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

        await page.evaluate(async () => (await import('/script.js')).saveSettings());
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        expect((await savedScript()).findRegex).toBe('/colou?r/gi');
    });
}
