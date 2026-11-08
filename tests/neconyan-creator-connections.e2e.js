/* global globalThis */
import { isDeepStrictEqual } from 'node:util';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';

async function waitForAppReady(page) {
    // The shell API appears before settings finish. A reload can stay on the
    // workspace skeleton longer than the acknowledgement helper's own window.
    // Poll the async import: waitForFunction treats an async predicate's Promise
    // as truthy and would return before APP_READY exists.
    await expect.poll(async () => page.evaluate(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        return eventSource.autoFireLastArgs.has(event_types.APP_READY);
    }), { timeout: 60000, message: 'The app completes startup after reload' }).toBe(true);
}

for (const phone of [false, true]) {
    test(`Creator saves choices and generates several greetings with fallback on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, configureSettings(saved) {
            const profile = saved.extension_settings.connectionManager.profiles[0];
            saved.extension_settings.connectionManager.profiles.push({ ...profile, id: 'broken', name: 'Unavailable fixture', 'api-url': 'http://127.0.0.1:1' });
        } });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await expect(creator.getByLabel('Maximum output tokens')).toHaveValue('64000');
        await creator.getByLabel('Connection profile', { exact: true }).selectOption('broken');
        await creator.getByRole('button', { name: 'Add fallback', exact: true }).click();
        await creator.getByLabel('Fallback 1', { exact: true }).selectOption('durable');
        await creator.getByLabel('Maximum output tokens').fill('1234');
        await creator.getByLabel('Maximum output tokens').press('Tab');
        await expect(creator.getByLabel('Maximum output tokens')).toHaveValue('1234');
        await expect(creator.getByLabel('Connection profile', { exact: true })).toBeVisible();
        const count = creator.getByLabel('Number of greetings', { exact: true });
        await expect(count).toHaveValue('1');
        await count.fill('0');
        await count.press('Tab');
        await expect(count).toHaveValue('1');
        await count.fill('4');
        await count.press('Tab');
        await count.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/creator-greeting-count-${phone ? 'phone' : 'desktop'}.png` });
        await page.screenshot({ path: `../screenshots/creator-connections-${phone ? 'phone' : 'desktop'}.png` });
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        const choices = creator.getByRole('group', { name: 'Fields to create', exact: true });
        await choices.getByRole('checkbox', { name: 'Display name', exact: true }).uncheck();
        await creator.getByLabel('Character dossier', { exact: true }).fill('A shipwright. Write four distinct greetings.');
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        const stored = (await account.post('/api/creator/list')).drafts[0];
        const expectedConnection = { profile: 'broken', fallbacks: ['durable'], maxTokens: 1234 };
        // Drafts renders while the queued save is still in flight. Wait for the
        // full saved choices before asserting them instead of reading an old revision.
        await expect.poll(async () => {
            const draft = (await account.post('/api/creator/get', { id: stored.id })).draft;
            const dossierFields = draft.writing?.dossierFields;
            return Array.isArray(dossierFields)
                && !dossierFields.includes('name')
                && draft.writing?.targets?.greetingCount === '4'
                && isDeepStrictEqual(draft.writing?.connection, expectedConnection);
        }, { message: 'Catelier saved the Dossier choices, four greetings and the connection' }).toBe(true);
        const saved = (await account.post('/api/creator/get', { id: stored.id })).draft;
        expect(saved.writing.dossierFields).not.toContain('name');
        expect(saved.writing.targets.greetingCount).toBe('4');
        expect(saved.writing.connection).toEqual(expectedConnection);
        await page.reload();
        await page.waitForFunction(() => typeof globalThis.NeconyanShell?.openCreator === 'function');
        // The shell API exists before startup settings finish loading. Wait for the
        // app's complete event, then for a real server acknowledgement.
        await waitForAppReady(page);
        await acknowledgeActiveSettings(page);
        await page.evaluate(async id => globalThis.NeconyanShell.openCreator({ draftId: id }), stored.id);
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await expect(choices.getByRole('checkbox', { name: 'Display name', exact: true })).not.toBeChecked();
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ fields: { first_mes: 'At the dock.', alternate_greetings: ['At home.', 'At work.', 'At sea.'] }, questions: [], coverage: ['Four distinct greetings'] }) } }] };
        await creator.getByRole('button', { name: 'Convert dossier to card', exact: true }).click();
        await expect(creator.getByLabel('Proposed alternate greeting 3', { exact: true })).toHaveValue('At sea.', { timeout: 30000 });
        await creator.getByLabel('Proposed alternate greeting 2', { exact: true }).fill('At the workshop.');
        await page.screenshot({ path: `../screenshots/creator-multiple-greetings-${phone ? 'phone' : 'desktop'}.png` });
        await creator.getByRole('button', { name: 'Accept all fields', exact: true }).click();
        await creator.getByRole('button', { name: 'Drafts', exact: true }).click();
        const expectedAlternateGreetings = ['At home.', 'At the workshop.', 'At sea.'];
        // Accepting fields queues the same kind of save behind the Drafts view.
        await expect.poll(async () => {
            const draft = (await account.post('/api/creator/get', { id: stored.id })).draft;
            return isDeepStrictEqual(draft.card?.data?.alternate_greetings, expectedAlternateGreetings);
        }, { message: 'Catelier saved the accepted alternate greetings' }).toBe(true);
        const result = (await account.post('/api/creator/get', { id: stored.id })).draft;
        expect(result.card.data.alternate_greetings).toEqual(expectedAlternateGreetings);
        expect(app.provider.calls.some(call => call.max_tokens === 1234)).toBe(true);
        expect(app.provider.calls.some(call => call.messages?.some(message => message.content?.includes('Number of greetings to create: 4 total')))).toBe(true);
    });
}
