/* global globalThis, document, getComputedStyle */
import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

for (const phone of [false, true]) {
    test(`Catelier asks before writing and revises follow-up answers on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
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
        const option = creator.getByRole('checkbox', { name: 'Ask questions first', exact: true });
        await expect(option).not.toBeChecked();
        await option.check();
        let failQuestions = true;
        const calls = [];
        await page.route('**/api/backends/chat-completions/generate', async route => {
            const request = JSON.parse(route.request().postDataJSON().messages.findLast(message => message.role === 'user').content);
            calls.push(request);
            const revised = request.answers?.some(item => item.answer === 'Her aunt');
            const result = request.phase === 'questions'
                ? (failQuestions ? {} : { questions: ['Where does Mira work?'], fields: { name: 'Premature writing' } })
                : { fields: Object.fromEntries(request.requestedFields.map(field => [field, field === 'name' ? 'Mira' : revised ? 'Mira repairs boats at the Northern docks, taught by her aunt.' : 'Mira repairs boats at the Northern docks.'])), questions: revised ? [] : ['Who taught Mira?'] };
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }] }) });
        });
        await creator.getByRole('button', { name: 'Convert dossier to card', exact: true }).click();
        const review = creator.locator('.creator-proposal');
        await expect(review.getByRole('button', { name: 'Retry questions', exact: true })).toBeVisible();
        expect(calls).toHaveLength(1);
        failQuestions = false;
        await review.getByRole('button', { name: 'Retry questions', exact: true }).click();
        await expect(review.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
        await expect(review.getByLabel('Proposed text', { exact: true })).toHaveCount(0);
        await review.getByLabel('Where does Mira work?', { exact: true }).fill('Northern docks');
        expect(calls).toHaveLength(2);
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        await expect(creator.getByRole('heading', { name: 'Your drafts', exact: true })).toBeVisible();
        const saved = (await account.post('/api/creator/list')).drafts[0];
        await page.evaluate(id => globalThis.NeconyanShell.openCreator({ draftId: id }), saved.id);
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await expect(option).toBeChecked();
        await creator.getByRole('button', { name: 'Review Dossier conversion', exact: true }).click();
        await expect(review.getByLabel('Where does Mira work?', { exact: true })).toHaveValue('Northern docks');
        const generate = review.getByRole('button', { name: 'Generate', exact: true });
        await generate.scrollIntoViewIfNeeded();
        const geometry = await generate.evaluate(node => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return { left: rect.left, right: rect.right, width: rect.width, height: rect.height, colour: style.color, background: style.backgroundColor, viewport: document.documentElement.clientWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
        expect(geometry.height).toBeGreaterThanOrEqual(32);
        expect(geometry.colour).not.toBe(geometry.background);
        await review.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-questions-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        await generate.click();
        await expect(review.getByRole('button', { name: 'Accept all fields', exact: true })).toBeVisible();
        await expect(review).toContainText('Written 2 of 2 steps');
        expect(calls).toHaveLength(4);
        for (const request of calls.slice(2)) expect(request.answers).toContainEqual({ question: 'Where does Mira work?', answer: 'Northern docks' });
        await expect(review.getByLabel('Where does Mira work?', { exact: true })).toHaveCount(0);
        await review.getByLabel('Who taught Mira?', { exact: true }).fill('Her aunt');
        await review.getByRole('button', { name: 'Revise with my answers', exact: true }).click();
        await expect(review.getByRole('button', { name: 'Accept all fields', exact: true })).toBeVisible();
        await expect(review.getByLabel('Proposed text', { exact: true }).nth(1)).toHaveValue('Mira repairs boats at the Northern docks, taught by her aunt.');
        expect(calls).toHaveLength(6);
        await review.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-questions-revised-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        await review.getByRole('button', { name: 'Accept all fields', exact: true }).click();
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await expect(creator.getByLabel('Description', { exact: true })).toHaveValue('Mira repairs boats at the Northern docks, taught by her aunt.');
    });
}

test('Writing partner waits for Generate even with no questions and keeps accent contrast', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account({ activeConnection: true });
    const page = await account.open({ workspace: false });
    await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
    await page.locator('#sb_character_tab_creator').click();
    const creator = page.locator('#sb_character_creator_panel');
    await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
    await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
    await creator.getByLabel('Connection profile', { exact: true }).selectOption('durable');
    await creator.getByRole('button', { name: 'Writing partner', exact: true }).click();
    await creator.getByLabel('What would you like to work on?', { exact: true }).fill('Write a description of Mira, a shipwright.');
    await creator.getByRole('checkbox', { name: 'Ask questions first', exact: true }).check();
    const calls = [];
    await page.route('**/api/backends/chat-completions/generate', async route => {
        const request = JSON.parse(route.request().postDataJSON().messages.findLast(message => message.role === 'user').content);
        calls.push(request);
        const result = request.phase === 'questions' ? { questions: [] } : { fields: { description: 'Mira is a shipwright.' }, questions: [] };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }] }) });
    });
    await creator.getByRole('button', { name: 'Ask for a proposal', exact: true }).click();
    const review = creator.locator('.creator-proposal');
    await expect(review).toContainText('The model has no questions.');
    const generate = review.getByRole('button', { name: 'Generate', exact: true });
    await expect(generate).toBeVisible();
    expect(calls).toHaveLength(1);
    for (const accent of [null, 'rgba(255, 238, 204, 1)', 'rgba(40, 20, 60, 1)']) {
        if (accent) await page.evaluate(rgba => {
            for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba } }));
        }, accent);
        await settleCssTransitions(page);
        const contrast = await generate.evaluate(node => {
            const style = getComputedStyle(node);
            const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
            const context = canvas.getContext('2d');
            const luminance = colour => {
                context.clearRect(0, 0, 1, 1); context.fillStyle = colour; context.fillRect(0, 0, 1, 1);
                const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
                return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
            };
            const ink = luminance(style.color), fill = luminance(style.backgroundColor);
            return (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05);
        });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
    await generate.click();
    await expect(review.getByRole('button', { name: 'Accept all fields', exact: true })).toBeVisible();
    await expect(review.getByLabel('Proposed text', { exact: true })).toHaveValue('Mira is a shipwright.');
    expect(calls).toHaveLength(2);
});
