import { expect } from '@playwright/test';
import { test, MODEL } from './neconyan-conversation-durable-fixture.js';
import { fileURLToPath } from 'node:url';

const screenshot = name => fileURLToPath(new URL(`../screenshots/${name}.png`, import.meta.url));

for (const phone of [false, true]) {
    test(`Creator resumes after other pages and retries failed requests on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        const dossier = creator.getByLabel('Character dossier', { exact: true });
        await dossier.fill('A shipwright who repairs old boats.');
        for (const route of ['model', 'settings']) {
            if (phone) await page.getByRole('button', { name: /Open (navigation|menu)/ }).click();
            await page.locator(`#neconyan-workspace-rail [data-neconyan-route="${route}"]`).click();
            const panel = page.locator(route === 'model' ? '#left-nav-panel' : '#user-settings-block');
            await expect(panel).toBeVisible();
            await panel.locator('.sb-shell-close').click();
            await expect(dossier).toBeVisible();
            await expect(dossier).toHaveValue('A shipwright who repairs old boats.');
        }
        await page.screenshot({ path: screenshot(`creator-navigation-${phone ? 'phone' : 'desktop'}`) });
        app.provider.mode.hold = MODEL;
        const convert = creator.getByRole('button', { name: 'Convert dossier to card', exact: true });
        await convert.click();
        await expect.poll(() => app.provider.calls.length).toBeGreaterThan(0);
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        await creator.getByRole('button', { name: 'Cancel active request', exact: true }).click();
        await expect(creator).not.toHaveAttribute('aria-busy', 'true');
        await page.request.post(`${app.provider.url.replace(/\/v1$/, '')}/fixture/release`, { data: {} });
        app.provider.mode.reply = null;
        app.provider.mode.fail = true;
        await convert.click();
        await expect(creator.locator('.creator-conversion-status')).toContainText('Catelier could not get a reply', { timeout: 30000 });
        await expect(creator).not.toHaveAttribute('aria-busy', 'true');
        app.provider.mode.fail = false;
        await creator.getByRole('button', { name: 'Writing instructions', exact: true }).click();
        await creator.getByLabel('Connection profile', { exact: true }).selectOption('durable');
        await creator.getByRole('button', { name: 'Dossier', exact: true }).click();
        const generate = '**/api/backends/chat-completions/generate';
        await page.route(generate, route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: '<none>' }) }));
        await convert.click();
        await expect(creator.locator('.creator-conversion-status')).toContainText('HTTP 401');
        await expect(creator.locator('.creator-conversion-status')).toContainText('Check the API key');
        await expect(creator.locator('.creator-conversion-status')).not.toContainText('<none>');
        await expect(creator).not.toHaveAttribute('aria-busy', 'true');
        await page.unroute(generate);
        await page.screenshot({ path: screenshot(`creator-error-${phone ? 'phone' : 'desktop'}`) });
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: JSON.stringify({ fields: { description: 'A shipwright who repairs old boats.' }, questions: [], coverage: [] }) } }] };
        await convert.click();
        await expect(creator.getByRole('button', { name: 'Accept all fields', exact: true })).toBeVisible({ timeout: 30000 });
        await page.screenshot({ path: screenshot(`creator-retry-${phone ? 'phone' : 'desktop'}`) });
    });
}
