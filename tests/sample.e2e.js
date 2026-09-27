import { test, expect } from '@playwright/test';

test.describe('sample', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('shows the Neconyan page title', async ({ page }) => {
        await expect(page).toHaveTitle('Neconyan');
    });
});
