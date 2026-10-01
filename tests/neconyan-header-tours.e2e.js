/* global window, getComputedStyle */
import { expect as baseExpect, test } from '@playwright/test';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.describe.configure({ mode: 'serial' });
const expect = baseExpect.configure({ timeout: 20000 });

const layouts = [
    { name: 'desktop', options: { viewport: { width: 1280, height: 900 } } },
    { name: 'iPhone browser emulation', options: IPHONE_SAFARI_CONTEXT, ios: true },
    { name: 'iPhone home-screen emulation', options: IPHONE_SAFARI_CONTEXT, ios: true, standalone: true },
];

async function openPage(page, shell, tab, key) {
    await page.evaluate(({ shell, tab }) => window.NeconyanShell.openTab(shell, tab), { shell, tab });
    const root = page.locator(shell === 'left' ? '#left-nav-panel' : '#user-settings-block');
    await expect(root).toHaveClass(/openDrawer/);
    await expect(root.locator('.neconyan-shell-page-intro')).toHaveAttribute('data-tool-page', key);
    await expect(root.locator('.sb-shell-header .neconyan-tool-page-description')).toBeVisible();
    return root;
}

test('Presets tour follows Text Completion, NovelAI and KoboldAI controls', async ({ browser }, testInfo) => {
    test.setTimeout(300000);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: testInfo.project.use.baseURL, reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
        const page = await context.newPage();
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120000 });
        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
        if (await skip.isVisible()) await skip.click();
        for (const [backend, selector] of [['textgenerationwebui', '#settings_preset_textgenerationwebui'], ['novel', '#settings_preset_novel'], ['kobold', '#settings_preset']]) {
            await openPage(page, 'left', 'api', 'connections');
            await page.locator('#main_api').selectOption(backend);
            const root = await openPage(page, 'left', 'presets', 'presets');
            await expect(root.locator(selector)).toBeVisible();
            await root.locator('.sb-shell-header .neconyan-tool-tour-button').click();
            const card = page.locator('#neconyan-tool-tour');
            for (const step of ['welcome', 'choose', 'save', 'copy', 'files', 'done']) {
                await expect(card).toHaveAttribute('data-step', step);
                await expect(card.locator('.neconyan-tool-tour-count')).toHaveText(/of 6$/);
                await expect(page.locator('.neconyan-tool-tour-target')).toHaveCount(1);
                await card.locator('[data-tool-tour-next]').click();
            }
            await expect(card).toHaveCount(0);
        }
        await openPage(page, 'left', 'api', 'connections');
        await page.locator('#main_api').selectOption('openai');
    } finally { await context.close(); }
});

async function assertHeader(root) {
    const measure = () => root.locator('.sb-shell-header').evaluate(header => {
        const box = selector => header.querySelector(selector).getBoundingClientRect().toJSON();
        const tour = box('.neconyan-tool-tour-button');
        const close = box('.sb-shell-close');
        return {
            title: box('.sb-shell-title'), description: box('.neconyan-tool-page-description'), tour, close,
            overlap: Math.min(tour.right, close.right) > Math.max(tour.left, close.left)
                && Math.min(tour.bottom, close.bottom) > Math.max(tour.top, close.top),
            subtitle: getComputedStyle(header.querySelector('.sb-shell-subtitle')).display,
            header: header.getBoundingClientRect().toJSON(),
        };
    });
    await expect.poll(async () => {
        const measurements = await measure();
        return {
            descriptionBelowTitle: measurements.description.top >= measurements.title.bottom,
            tourBelowTitle: measurements.tour.top >= measurements.title.bottom,
            touchTarget: measurements.tour.height >= 44,
            overlap: measurements.overlap,
            fitsHeader: measurements.tour.right <= measurements.header.right,
            subtitle: measurements.subtitle,
        };
    }).toEqual({ descriptionBelowTitle: true, tourBelowTitle: true, touchTarget: true, overlap: false, fitsHeader: true, subtitle: 'none' });
    await expect(root.locator('.sb-shell-header .neconyan-page-intro-toggle')).toHaveCount(0);
    await expect(root.locator('.sb-shell-panel-active .neconyan-tool-page-intro')).toHaveCount(0);
}

for (const layout of layouts) {
    test(`title blurbs and Nori's Presets tour: ${layout.name}`, async ({ browser }, testInfo) => {
        test.setTimeout(300000);
        const context = await browser.newContext({ ...layout.options, baseURL: testInfo.project.use.baseURL, reducedMotion: 'reduce', serviceWorkers: 'block' });
        try {
            if (layout.ios) await installIPhoneSafari(context, { standalone: Boolean(layout.standalone) });
            const page = await context.newPage();
            // The workspace loads its bundled tools after the main document.
            // eslint-disable-next-line playwright/no-networkidle
            await page.goto('/', { waitUntil: 'networkidle' });
            await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120000 });
            const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
            if (await skip.isVisible()) await skip.click();

            await openPage(page, 'left', 'api', 'connections');
            await page.locator('#main_api').selectOption('openai');

            for (const [tab, key] of [['api', 'connections'], ['sampling', 'sampling'], ['advanced-formatting', 'formatting'], ['mewmory', 'mewmory'], ['presets', 'presets']]) {
                const root = await openPage(page, 'left', tab, key);
                if (layout.ios) await applyIOSOnlyCss(page);
                await assertHeader(root);
                if (key === 'connections') await page.screenshot({ path: testInfo.outputPath('connections.png') });
            }

            const root = page.locator('#left-nav-panel');
            const launch = root.locator('.sb-shell-header .neconyan-tool-tour-button');
            await expect(launch).toHaveAttribute('aria-label', 'Start Nori\'s Presets tour');
            const values = () => root.locator('.sb-shell-panel-active').evaluate(panel => [...panel.querySelectorAll('input, select, textarea')].map(el => ({ id: el.id, value: el.value, checked: el.checked })));
            const before = await values();
            const presetWrites = [];
            page.on('request', request => {
                if (/\/api\/presets\/(save|delete|restore)/.test(request.url())) presetWrites.push(request.url());
            });
            await launch.click();
            const card = page.locator('#neconyan-tool-tour');
            await expect(card.locator('.neconyan-tool-tour-speaker')).toHaveText('Nori\'s Presets tour');
            await expect(card.locator('.neconyan-tool-tour-portrait')).toHaveAttribute('src', /nori/);
            const steps = ['welcome', 'choose', 'save', 'copy', 'files', 'linking', 'parameters', 'prompts', 'done'];
            for (const step of steps) {
                await expect(card).toHaveAttribute('data-step', step);
                await expect(page.locator('.neconyan-tool-tour-target')).toHaveCount(1);
                if (step === 'welcome') await expect(root.locator('.sb-shell-header .neconyan-tool-page-intro')).toHaveClass(/neconyan-tool-tour-target/);
                if (step === 'parameters') await expect(page.locator('#openai-tab-btn-parameters')).toHaveAttribute('aria-selected', 'true');
                if (step === 'prompts') {
                    await expect(page.locator('#openai-tab-btn-prompts')).toHaveAttribute('aria-selected', 'true');
                    await card.locator('[data-tool-tour-back]').click();
                    await expect(card).toHaveAttribute('data-step', 'parameters');
                    await expect(page.locator('#openai-tab-btn-parameters')).toHaveAttribute('aria-selected', 'true');
                    await card.locator('[data-tool-tour-next]').click();
                    await expect(card).toHaveAttribute('data-step', 'prompts');
                    await page.screenshot({ path: testInfo.outputPath('presets-tour.png') });
                }
                await card.locator('[data-tool-tour-next]').click();
            }
            await expect(card).toHaveCount(0);
            await expect(launch).toBeFocused();
            expect(await values()).toEqual(before);
            expect(presetWrites).toEqual([]);
            await launch.click();
            await expect(card).toHaveAttribute('data-step', 'welcome');
            await page.keyboard.press('Escape');
            await expect(card).toHaveCount(0);
            await expect(launch).toBeFocused();

            // Header searches must not depend on the controls being in the same scrolling box.
            await openPage(page, 'left', 'api', 'connections');
            await root.locator('.sb-shell-header .neconyan-tool-tour-button').click();
            await expect(card).toHaveAttribute('data-step', 'welcome');
            await expect(root.locator('.sb-shell-header .neconyan-tool-page-intro')).toHaveClass(/neconyan-tool-tour-target/);
            await openPage(page, 'left', 'presets', 'presets');
            await expect(card).toHaveCount(0);

            for (const [tab, key] of [['background', 'background'], ['server', 'server'], ['console-logs', 'console-logs']]) {
                const right = await openPage(page, 'right', tab, key);
                if (layout.ios) await applyIOSOnlyCss(page);
                await assertHeader(right);
            }
            for (const key of ['quick-image-gen', 'regex', 'expressions', 'pathfinder']) {
                await page.evaluate(key => window.NeconyanShell.openIncludedTool(key), key);
                const right = page.locator('#user-settings-block');
                await expect(right.locator('.neconyan-shell-page-intro')).toHaveAttribute('data-tool-page', key, { timeout: 15000 });
                if (layout.ios) await applyIOSOnlyCss(page);
                await assertHeader(right);
            }
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
            await expect(page.locator('#user-settings-block .neconyan-shell-page-intro')).toBeEmpty();
        } finally {
            await context.close();
        }
    });
}
