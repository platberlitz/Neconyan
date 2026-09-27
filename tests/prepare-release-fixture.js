/* global window, document */
import { chromium } from '@playwright/test';

if (process.env.NECONYAN_RELEASE_TEST_DISPOSABLE !== '1') {
    throw new Error('Release fixture preparation requires an explicitly disposable server.');
}
const browser = await chromium.launch();
try {
    const context = await browser.newContext({
        baseURL: process.env.NECONYAN_TEST_BASE_URL,
        storageState: process.env.NECONYAN_TEST_STORAGE_STATE || undefined,
        serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) {
        await skip.click();
        await skip.waitFor({ state: 'hidden' });
    }
    if (await page.evaluate(() => window.SillyTavern.getContext().characters.length === 0)) {
        const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
        const response = await page.request.post('/api/characters/create', { headers, data: {
            ch_name: 'Neconyan Release Fixture', description: 'A disposable character for release browser checks.', first_mes: 'Ready for the release check.',
        } });
        if (!response.ok()) throw new Error(`Release character creation failed: ${response.status()}`);
    }
    console.log('Disposable release profile has a character and a dismissed first-run tour.');
} finally {
    await browser.close();
}
