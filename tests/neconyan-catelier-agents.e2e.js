/* global document, requestAnimationFrame, getComputedStyle */
import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';

for (const phone of [false, true]) {
    test(`Catelier chains selected agents on selected fields on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        await page.evaluate(async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            for (const [name, prompt] of [['Catelier first test agent', 'FIRST_PASS: make the text concrete.'], ['Catelier second test agent', 'SECOND_PASS: make the text precise.']]) {
                await store.saveAgent({ ...store.createDefaultAgent(), name, prompt, enabled: false });
            }
        });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await creator.getByLabel('Display name', { exact: true }).fill('Mira');
        await creator.getByLabel('Description', { exact: true }).fill('Original description');
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await expect(creator.getByLabel('Grounded prose prompt', { exact: true })).toHaveValue(/## Use Instead/);
        await creator.getByLabel('Connection profile', { exact: true }).selectOption('durable');
        await creator.getByRole('button', { name: 'Post-process with agents', exact: true }).click();
        await creator.getByLabel('Find an agent', { exact: true }).fill('Catelier');
        await creator.getByLabel('Catelier first test agent', { exact: true }).check();
        await creator.getByLabel('Catelier second test agent', { exact: true }).check();
        await creator.getByLabel('Description', { exact: true }).check();
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await creator.getByRole('button', { name: 'Post-process with agents', exact: true }).click();
        await expect(creator.getByLabel('Catelier first test agent', { exact: true })).toBeChecked();
        await expect(creator.getByLabel('Catelier second test agent', { exact: true })).toBeChecked();
        await expect(creator.getByLabel('Description', { exact: true })).toBeChecked();
        await expect(creator.getByRole('button', { name: 'Expand Find an agent', exact: true })).toHaveCount(0);
        await expect(creator.locator('.creator-agent-pill.is-selected .creator-agent-step-badge')).toHaveText(['1', '2']);
        await expect(creator.getByRole('group', { name: 'Fields to post-process', exact: true }).locator('.creator-choice-subgroup--disabled').getByLabel('Personality', { exact: true })).toBeDisabled();
        const checkboxRadius = await creator.getByLabel('Catelier first test agent', { exact: true }).evaluate(node => getComputedStyle(node).borderRadius);
        expect(checkboxRadius).toBe('4px');
        await creator.getByLabel('Find an agent', { exact: true }).fill('Catelier');
        await creator.getByRole('heading', { name: 'Post-process fields with agents', exact: true }).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-agent-picker-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        const calls = [];
        let fail = true;
        let refuse = true;
        await page.route('**/api/backends/chat-completions/generate', async route => {
            const body = route.request().postDataJSON();
            const second = body.messages[0].content.includes('SECOND_PASS');
            calls.push({ second, input: JSON.parse(body.messages.at(-1).content) });
            if (second && fail) return route.fulfill({ status: 504, json: { error: 'Timed out' } });
            if (second && refuse) return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: 'I cannot help with this request.' } }] } });
            return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: second ? 'A precise description.' : 'A concrete description.' } }] } });
        });
        await creator.getByRole('button', { name: 'Run selected agents', exact: true }).click();
        await expect(creator.getByRole('button', { name: 'Continue writing', exact: true })).toBeVisible({ timeout: 60000 });
        await expect(creator.getByLabel('Proposed text', { exact: true })).toHaveValue('A concrete description.');
        fail = false;
        await creator.getByRole('button', { name: 'Continue writing', exact: true }).click();
        await expect(creator.getByText(/The model refused the request/).first()).toBeVisible({ timeout: 60000 });
        await expect(creator.getByLabel('Proposed text', { exact: true })).toHaveValue('A concrete description.');
        await expect(creator.getByRole('button', { name: 'Continue writing', exact: true })).toBeEnabled();
        await creator.getByText(/The model refused the request/).first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-refusal-after-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        refuse = false;
        await creator.getByRole('button', { name: 'Continue writing', exact: true }).click();
        await expect(creator.getByRole('button', { name: 'Accept all fields', exact: true })).toBeVisible({ timeout: 60000 });
        await expect(creator.getByLabel('Proposed text', { exact: true })).toHaveValue('A precise description.');
        const diff = creator.locator('.creator-proposal-diff .ica-transform-diff');
        await expect(diff.locator('.ica-transform-diff-part--del')).toContainText('Original');
        await expect(diff.locator('.ica-transform-diff-part--ins').first()).toContainText('A precise');
        const colours = await diff.evaluate(node => {
            const added = getComputedStyle(node.querySelector('.ica-transform-diff-part--ins'));
            const removed = getComputedStyle(node.querySelector('.ica-transform-diff-part--del'));
            return { added: added.backgroundColor, removed: removed.backgroundColor, deletion: removed.textDecorationLine };
        });
        expect(colours.added).not.toBe(colours.removed);
        expect(colours.deletion).toBe('line-through');
        await creator.getByLabel('Proposed text', { exact: true }).fill('A precise description. <img src=x onerror=alert(1)>');
        await expect(diff).toContainText('<img src=x onerror=alert(1)>');
        await expect(diff.locator('img')).toHaveCount(0);
        await creator.getByLabel('Proposed text', { exact: true }).fill('A precise description.');
        expect(calls.filter(call => !call.second)).toHaveLength(1);
        expect(calls.filter(call => call.second).every(call => call.input.text === 'A concrete description.' && call.input.field === 'description')).toBe(true);
        await creator.locator('.creator-proposal').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.screenshot({ path: fileURLToPath(new URL(`../screenshots/catelier-agents-${phone ? 'phone' : 'desktop'}.png`, import.meta.url)) });
        for (const accent of [null, 'rgba(110, 231, 183, 1)', 'rgba(126, 34, 206, 1)']) {
            const contrast = await creator.getByRole('button', { name: 'Run selected agents', exact: true }).evaluate(async (node, colour) => {
                if (colour) for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba: colour } }));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {})));
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                const ctx = canvas.getContext('2d');
                const luminance = value => {
                    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
                    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
                };
                const style = getComputedStyle(node), text = luminance(style.color), background = luminance(style.backgroundColor);
                return { ratio: (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05), colour: style.color, background: style.backgroundColor };
            }, accent);
            expect(contrast.ratio, JSON.stringify({ accent, ...contrast })).toBeGreaterThanOrEqual(4.5);
        }
        await creator.getByRole('button', { name: 'Accept all fields', exact: true }).click();
        await creator.getByRole('button', { name: 'Identity', exact: true }).click();
        await expect(creator.getByLabel('Description', { exact: true })).toHaveValue('A precise description.');
        await expect(creator.getByLabel('Display name', { exact: true })).toHaveValue('Mira');
    });
}
