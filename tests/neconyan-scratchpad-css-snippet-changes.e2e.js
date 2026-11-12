/* global document */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const SNIPPET = {
    id: 'tidy-snippet',
    name: 'Tidy',
    isDisabled: false,
    isGlobal: true,
    content: '.mes { letter-spacing: 0.01em; }',
    isCollapsed: false,
    isSynced: false,
    isDeleted: false,
    modifiedOn: 1,
    themeList: [],
    charList: [],
    groupList: [],
};
const NEW_CSS = '.mes { letter-spacing: 0.02em; word-spacing: 0.05em; }';

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad saves a reviewed CSS snippet change only while CSS Snippets are shared`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });

        const page = await account.open();
        await page.evaluate(async snippet => {
            const { getSettings } = await import('/scripts/extensions/css-snippets/src/runtime.js');
            const { saveSettings } = await import('/script.js');
            const settings = getSettings();
            settings.snippetList = [...settings.snippetList.filter(item => item.id !== snippet.id), snippet];
            await saveSettings();
        }, SNIPPET);
        const savedSnippet = () => page.evaluate(async id => {
            const { getSettings } = await import('/scripts/extensions/css-snippets/src/runtime.js');
            return structuredClone(getSettings().snippetList.find(item => item.id === id));
        }, SNIPPET.id);

        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        const changes = [
            { type: 'css-snippet', action: 'replace', snippet: SNIPPET.id, name: SNIPPET.name, field: 'content', value: NEW_CSS },
            { type: 'css-snippet', action: 'replace', snippet: SNIPPET.id, name: SNIPPET.name, field: 'name', value: 'Tidier' },
            { type: 'css-snippet', action: 'replace', snippet: SNIPPET.id, name: SNIPPET.name, field: 'content', value: 'not css at all' },
        ];
        await account.post('/api/scratchpad/session/import', {
            source,
            session: {
                name: 'Snippet edits',
                messages: [{ role: 'assistant', text: 'Three edits.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') }],
            },
        });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const shots = name => path.resolve('../screenshots/scratchpad-css-snippet-changes', `${phone ? 'phone' : 'desktop'}-${name}.png`);
        const cards = page.locator('.scratchpad-change');
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container');
        const review = index => cards.nth(index).getByRole('button', { name: 'Review', exact: true });

        await expect(cards).toHaveCount(3);
        await expect(cards.nth(0)).toContainText('Change CSS snippet \'Tidy\': content');
        await expect(cards.nth(1)).toContainText('Change CSS snippet \'Tidy\': name');

        await review(0).click();
        await expect(toasts).toContainText('Share CSS Snippets under Context before saving a change to one.');
        await expect(dialog).toHaveCount(0);

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        const share = page.locator('label.scratchpad-check', { hasText: 'Shares the name and CSS of every saved snippet' });
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
        await expect(preview).toContainText('## CSS Snippets');
        await expect(preview).toContainText('ID: tidy-snippet');
        await expect(preview).toContainText('letter-spacing: 0.01em');
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();

        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await review(0).click();
        await expect(dialog).toContainText('CSS snippet: Tidy');
        await expect(dialog).toContainText('CSS');
        await page.screenshot({ path: shots('review') });
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(cards.nth(0)).toContainText('Saved');
        const saved = await savedSnippet();
        expect(saved.content).toBe(NEW_CSS);
        expect(saved.modifiedOn).toBeGreaterThan(1);
        const applied = await page.evaluate(() => document.getElementById('csss--css-snippets')?.textContent ?? null);
        if (applied !== null) expect(applied).toContain('word-spacing');
        await page.screenshot({ path: shots('saved') });

        await review(2).click();
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(toasts).toContainText('The browser cannot read any rule in that CSS');
        expect((await savedSnippet()).content).toBe(NEW_CSS);
        await expect(dialog).toHaveCount(0);

        await review(1).click();
        await expect(dialog).toContainText('Name');
        await page.evaluate(async id => {
            const { getSettings } = await import('/scripts/extensions/css-snippets/src/runtime.js');
            getSettings().snippetList.find(item => item.id === id).name = 'Renamed elsewhere';
        }, SNIPPET.id);
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(toasts).toContainText('changed while the review was open');
        expect((await savedSnippet()).name).toBe('Renamed elsewhere');
        await expect(cards.nth(1)).not.toContainText('Saved');

        const question = 'Tidy the Tidy snippet.';
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
        expect(sent).toContain('"type":"css-snippet"');
        expect(sent).toContain('ID: tidy-snippet');
        expect(sent).toContain('word-spacing: 0.05em');

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

        await page.evaluate(async () => (await import('/script.js')).saveSettings());
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        expect((await savedSnippet()).content).toBe(NEW_CSS);
    });
}
