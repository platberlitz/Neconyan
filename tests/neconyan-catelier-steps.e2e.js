/* global globalThis */
import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`Catelier keeps partial writing and revises answers on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await creator.getByLabel('Connection profile', { exact: true }).selectOption('durable');
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await creator.getByLabel('Character dossier', { exact: true }).fill('Mira repairs boats. Her workplace is undecided.');
        const fields = creator.getByRole('group', { name: 'Fields to create', exact: true });
        for (const name of ['Personality', 'Scenario', 'First greeting', 'Interviewer examples']) await fields.getByRole('checkbox', { name, exact: true }).uncheck();
        let fail = true;
        const calls = [];
        await page.route('**/api/backends/chat-completions/generate', async route => {
            const body = route.request().postDataJSON();
            const request = JSON.parse(body.messages.findLast(message => message.role === 'user').content);
            calls.push(request);
            if (fail && request.requestedFields.includes('description')) return route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify({ error: 'Request timed out' }) });
            const revised = request.answers?.some(item => item.answer === 'Northern docks');
            const values = { name: 'Mira', description: revised ? 'Mira repairs boats at the Northern docks.' : 'Mira repairs boats.' };
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ fields: Object.fromEntries(request.requestedFields.map(field => [field, values[field]])), questions: revised ? [] : ['Where does Mira work?'], coverage: ['Used the supplied facts.'] }) } }] }) });
        });
        await creator.getByRole('button', { name: 'Convert dossier to card', exact: true }).click();
        const review = creator.locator('.creator-proposal');
        await expect(review).toContainText('Written 1 of 2 steps');
        await expect(review.getByRole('button', { name: 'Continue writing', exact: true })).toBeVisible();
        await expect(review.getByLabel('Proposed text', { exact: true })).toHaveValue('Mira');
        await review.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-partial-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        const saved = (await account.post('/api/creator/list')).drafts[0];
        await page.evaluate(id => globalThis.NeconyanShell.openCreator({ draftId: id }), saved.id);
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await creator.getByRole('button', { name: 'Review Dossier conversion', exact: true }).click();
        await expect(review).toContainText('Written 1 of 2 steps');
        fail = false;
        await review.getByRole('button', { name: 'Continue writing', exact: true }).click();
        await expect(review).toContainText('Written 2 of 2 steps');
        expect(calls.filter(call => call.requestedFields.includes('name'))).toHaveLength(1);
        await review.getByLabel('Where does Mira work?', { exact: true }).fill('Northern docks');
        await review.getByRole('button', { name: 'Revise with my answers', exact: true }).click();
        await expect(review.getByLabel('Proposed text', { exact: true }).nth(1)).toHaveValue('Mira repairs boats at the Northern docks.');
        await expect(review.getByRole('button', { name: 'Accept all fields', exact: true })).toBeVisible();
        await expect(review).toContainText('Answered questions (1)');
        await review.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-revision-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
    });
}
