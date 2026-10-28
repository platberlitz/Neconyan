/* global window, document, MutationObserver */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

for (const phone of [false, true]) {
    test(`model search reuses rows and follows source changes on ${phone ? 'phone' : 'desktop'}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone });
        const page = await context.newPage();
        try {
            const family = await readFile(new URL('../public/scripts/model-family.js', import.meta.url), 'utf8');
            const source = await readFile(new URL('../public/scripts/model-list-search.js', import.meta.url), 'utf8');
            await page.setContent('<select id="models"><option value="alpha">Alpha</option><option value="beta">Beta</option><option value="gamma">Gamma</option></select>');
            await page.addScriptTag({ type: 'module', content: `
                const t = (strings, ...values) => strings.reduce((text, part, index) => text + (values[index - 1] ?? '') + part);
                ${family}
                ${source.replace(/^import .*;\n/gm, '')}
                window.modelSearch = { attachModelListSearch, refreshModelListSearch };
            ` });
            await page.waitForFunction(() => window.modelSearch);
            await page.evaluate(() => {
                window.templateCalls = 0;
                window.changes = 0;
                const select = document.querySelector('select');
                select.addEventListener('change', () => window.changes++);
                window.list = window.modelSearch.attachModelListSearch(select, { template: ({ text }) => {
                    window.templateCalls++;
                    const label = document.createElement('strong');
                    label.textContent = text;
                    return label;
                } });
                window.originalRows = [...document.querySelectorAll('[data-model-id]')];
            });
            const search = page.getByRole('searchbox');
            await search.fill('beta');
            await expect(page.locator('[data-model-id]')).toHaveCount(1);
            await search.press('Enter');
            await expect(page.locator('[data-model-id="beta"]')).toHaveAttribute('aria-pressed', 'true');
            expect(await page.evaluate(() => ({ value: window.list.select.value, changes: window.changes, calls: window.templateCalls }))).toEqual({ value: 'beta', changes: 1, calls: 3 });
            await search.press('Escape');
            await expect(page.locator('[data-model-id]')).toHaveCount(3);
            expect(await page.evaluate(() => window.originalRows.every(row => row === document.querySelector(`[data-model-id="${row.dataset.modelId}"]`)))).toBe(true);
            await search.press('ArrowDown');
            await expect(page.locator('[data-model-id="alpha"]')).toBeFocused();
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('Enter');
            await expect(page.locator('[data-model-id="beta"]')).toBeFocused();
            expect(await page.evaluate(() => window.templateCalls)).toBe(3);

            const mutations = await page.evaluate(async () => {
                let writes = 0;
                const observer = new MutationObserver(records => { writes += records.length; });
                observer.observe(window.list.results, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
                window.list.syncPressed();
                window.list.syncPressed();
                await Promise.resolve();
                observer.disconnect();
                return writes;
            });
            expect(mutations).toBe(0);
            await page.evaluate(() => {
                window.list.select.value = 'gamma';
                window.list.select.dispatchEvent(new Event('input'));
            });
            await expect(page.locator('[data-model-id="gamma"]')).toHaveAttribute('aria-pressed', 'true');
            await page.evaluate(() => {
                const option = window.list.select.options[1];
                option.textContent = 'Updated Beta';
                option.dataset.favorite = 'true';
                window.list.select.options[0].disabled = true;
            });
            await expect(page.locator('[data-model-id]')).toHaveCount(2);
            await expect(page.locator('[data-model-id="beta"] strong')).toHaveText('Updated Beta');
            await expect(page.locator('[data-model-id="beta"] [data-model-favourite]')).toHaveCount(1);
            await page.evaluate(() => { window.list.select.disabled = true; });
            await expect(page.locator('[data-model-id="beta"]')).toBeDisabled();
            await page.evaluate(() => {
                window.list.select.disabled = false;
                window.modelSearch.attachModelListSearch(window.list.select, { template: ({ id }) => {
                    const label = document.createElement('em');
                    label.textContent = `New ${id}`;
                    return label;
                } });
            });
            await expect(page.locator('[data-model-id="beta"] em')).toHaveText('New beta');
            await expect(page.locator('[data-model-id="beta"]')).toBeEnabled();
            await page.evaluate(() => {
                window.list.select.options[1].textContent = 'Renamed in the same turn';
                window.list.input.value = 'renamed';
                window.list.input.dispatchEvent(new Event('input'));
            });
            await expect(page.locator('[data-model-id]')).toHaveCount(1);
            await expect(page.locator('[data-model-id="beta"]')).toHaveCount(1);
        } finally {
            await context.close();
        }
    });
}
