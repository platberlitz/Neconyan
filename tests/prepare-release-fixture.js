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
    const readTutorial = () => page.evaluate(() => {
        const storage = window.SillyTavern?.getContext?.().accountStorage;
        return {
            ready: Boolean(storage?.isReady),
            status: storage?.getItem('NeconyanTutorialStatus.v1') ?? null,
            hidden: storage?.getItem('NeconyanTutorialHidden.v1') ?? null,
        };
    });
    const openApp = async () => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready')
            && Boolean(window.SillyTavern?.getContext?.().accountStorage?.isReady), undefined, { timeout: 60000 });
    };
    const tutorialPending = ({ status, hidden }) => status !== null && !['completed', 'skipped'].includes(status) && hidden !== 'true';
    await openApp();
    // The tour opens on APP_READY, which can land well after the rail is ready.
    if (tutorialPending(await readTutorial())) {
        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        await skip.waitFor({ state: 'visible', timeout: 60000 });
        await skip.click();
        await skip.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => window.SillyTavern.getContext().accountStorage.getItem('NeconyanTutorialStatus.v1') === 'skipped', undefined, { timeout: 30000 });
        await openApp();
        const saved = await readTutorial();
        if (tutorialPending(saved)) throw new Error(`First-run tour is still pending after a reload: ${JSON.stringify(saved)}`);
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
