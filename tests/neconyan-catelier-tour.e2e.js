import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { fileURLToPath } from 'node:url';

const screenshot = name => fileURLToPath(new URL(`../screenshots/${name}.png`, import.meta.url));

for (const phone of [false, true]) {
    const label = phone ? 'phone' : 'desktop';

    test(`Nori leads the Catelier tour and follows the user's own clicks on ${label}`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        const tab = page.locator('#sb_character_tab_creator');
        await expect(tab).toContainText('Catelier');
        await tab.click();
        const creator = page.locator('#sb_character_creator_panel');
        const invite = creator.locator('[data-neconyan-tour-invite-key="neconyanToolTourInvite.character-creator"]');
        await expect(invite).toBeVisible();
        await expect(invite).toContainText('New to Catelier?');
        await page.screenshot({ path: screenshot(`catelier-invite-${label}`) });

        await invite.getByRole('button', { name: 'Show me around', exact: true }).click();
        const tour = page.locator('#neconyan-tool-tour');
        await expect(tour).toHaveAttribute('data-step', 'welcome');
        await expect(tour).toContainText('Nori');
        const next = tour.locator('.neconyan-tool-tour-next');
        await next.click();
        await expect(tour).toHaveAttribute('data-step', 'start');

        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await expect(tour).toHaveAttribute('data-step', 'sections');
        await expect(creator.locator('.neconyan-native-page-heading')).toHaveCount(1);
        await next.click();
        await expect(tour).toHaveAttribute('data-step', 'dossier');
        await expect(creator.locator('[data-creator-section="dossier"]')).toHaveAttribute('aria-current', 'page');
        await next.click();
        await expect(tour).toHaveAttribute('data-step', 'convert');
        await next.click();
        await expect(tour).toHaveAttribute('data-step', 'instructions');
        await expect(creator.locator('[data-creator-section="instructions"]')).toHaveAttribute('aria-current', 'page');
        await expect(creator.locator('[data-creator-connection]')).toHaveClass(/neconyan-tool-tour-target/);
        await page.screenshot({ path: screenshot(`catelier-tour-${label}`) });

        await creator.locator('[data-creator-section="dossier"]').click();
        await expect(tour).toHaveAttribute('data-step', 'dossier');
        await next.click();
        await next.click();
        await next.click();
        await expect(tour).toHaveAttribute('data-step', 'save');
        await next.click();
        await expect(tour).toHaveAttribute('data-step', 'done');
        await next.click();
        await expect(tour).toHaveCount(0);
        await expect(creator.locator('.neconyan-native-page-heading')).toHaveCount(1);
    });

    test(`Alt greetings keep the label and buttons on one line on ${label}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, activeConnection: true });
        const page = await account.open({ workspace: false });
        await page.getByRole('button', { name: 'Choose a character', exact: true }).click();
        await page.locator('#sb_character_tab_creator').click();
        const creator = page.locator('#sb_character_creator_panel');
        await creator.getByRole('button', { name: 'Create a character', exact: true }).click();
        await creator.locator('[data-creator-section="greetings"]').click();
        await creator.getByRole('button', { name: 'Add alt greetings', exact: true }).click();
        const heading = creator.locator('.creator-greeting-field .creator-field-heading').first();
        await expect(heading.locator('label')).toHaveText('Alt greetings 1');
        await heading.scrollIntoViewIfNeeded();
        const rows = await heading.evaluate(node => [...node.children]
            .filter(child => child.getClientRects().length)
            .map(child => {
                const box = child.getBoundingClientRect();
                return { text: child.textContent.trim(), top: Math.round(box.top), bottom: Math.round(box.bottom) };
            }));
        expect(rows.map(row => row.text)).toEqual(expect.arrayContaining(['Alt greetings 1', 'Remove', 'Generate']));
        const middle = row => (row.top + row.bottom) / 2;
        for (const row of rows) expect(Math.abs(middle(row) - middle(rows[0]))).toBeLessThanOrEqual(4);
        const rightEdge = locator => locator.evaluate(node => Math.round(node.lastElementChild.getBoundingClientRect().right));
        const firstGreeting = creator.locator('.creator-field-heading').filter({ hasText: 'First greeting' }).first();
        expect(Math.abs(await rightEdge(heading) - await rightEdge(firstGreeting))).toBeLessThanOrEqual(2);
        await page.screenshot({ path: screenshot(`catelier-alt-greetings-${label}`) });
    });
}
