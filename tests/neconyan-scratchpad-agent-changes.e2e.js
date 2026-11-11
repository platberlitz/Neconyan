/* global document */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const AGENT = {
    id: 'scene-keeper',
    name: 'Scene Keeper',
    enabled: false,
    category: 'custom',
    description: 'Keeps scenes tidy.',
    prompt: 'Old agent prompt.',
};

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} Scratchpad saves a reviewed Agent change only while Agents are shared`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.post('/api/in-chat-agents/save', AGENT);
        const savedAgent = async () => (await account.post('/api/in-chat-agents/list', {})).find(agent => agent.id === AGENT.id);

        const page = await account.open();
        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        const changes = [
            { type: 'agent', action: 'replace', agent: AGENT.id, name: AGENT.name, field: 'prompt', value: 'New agent prompt.' },
            { type: 'agent', action: 'replace', agent: AGENT.id, name: AGENT.name, field: 'description', value: 'Keeps every scene tidy.' },
        ];
        await account.post('/api/scratchpad/session/import', {
            source,
            session: {
                name: 'Agent edits',
                messages: [{ role: 'assistant', text: 'Two edits.\n' + changes.map(change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```').join('\n') }],
            },
        });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const shots = name => path.resolve('../screenshots/scratchpad-agent-changes', `${phone ? 'phone' : 'desktop'}-${name}.png`);
        const cards = page.locator('.scratchpad-change');
        const dialog = page.locator('dialog[open]');
        const toasts = page.locator('#toast-container');
        const review = index => cards.nth(index).getByRole('button', { name: 'Review', exact: true });

        await expect(cards).toHaveCount(2);
        await expect(cards.nth(0)).toContainText('Change Agent \'Scene Keeper\': prompt');
        await expect(cards.nth(1)).toContainText('Change Agent \'Scene Keeper\': description');

        await review(0).click();
        await expect(toasts).toContainText('Share Agents under Context before saving a change to one.');
        await expect(dialog).toHaveCount(0);

        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        const share = page.locator('label.scratchpad-check', { hasText: 'Shares the name, description and prompt' });
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
        await expect(preview).toContainText('## Agents');
        await expect(preview).toContainText('ID: scene-keeper');
        await expect(preview).toContainText('Old agent prompt.');
        await page.locator('[id^="scratchpad-connection-"]').first().selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();

        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await review(0).click();
        await expect(dialog).toContainText('Agent: Scene Keeper');
        await expect(dialog.locator('.ica-transform-diff-part--ins').first()).toContainText('New');
        await page.screenshot({ path: shots('review') });
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(cards.nth(0)).toContainText('Saved');
        await expect.poll(async () => (await savedAgent()).prompt).toBe('New agent prompt.');
        await page.screenshot({ path: shots('saved') });

        await account.post('/api/in-chat-agents/save', { ...await savedAgent(), description: 'Changed elsewhere.' });
        await review(1).click();
        await dialog.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(toasts).toContainText('changed while the review was open');
        expect((await savedAgent()).description).toBe('Changed elsewhere.');
        await expect(cards.nth(1)).not.toContainText('Saved');

        const question = 'Tighten the Scene Keeper prompt.';
        app.provider.mode.reply = { choices: [{ message: { content: 'Here is a tighter one.' } }] };
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
        expect(sent).toContain('"type":"agent"');
        expect(sent).toContain('ID: scene-keeper');
        expect(sent).toContain('New agent prompt.');

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
}
