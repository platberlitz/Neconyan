/* global document, window */
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function mount(page, items = []) {
    await page.route('http://purrks.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<main></main>' });
        if (pathname === '/scripts/creator/assistant.js') {
            return route.fulfill({ contentType: 'text/javascript', body: 'export async function requestCreatorReply() { return "{}"; }' });
        }
        const file = path.resolve(root, 'public', `.${pathname}`);
        if (!file.startsWith(path.join(root, 'public') + path.sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(file, 'utf8') });
    });
    await page.goto('http://purrks.test/');
    await page.evaluate(async initialItems => {
        const { renderCreatorPurrks } = await import('/scripts/creator/purrks.js');
        const host = document.querySelector('main');
        const workspace = {
            session: { draft: { card: { data: { extensions: { neconyan_purrks: { items: initialItems } } } } } },
            status() {},
            edit(operation, redraw) {
                operation(this.session.draft);
                if (redraw) this.render();
                return true;
            },
            render() { host.replaceChildren(); renderCreatorPurrks(this, host); },
            run: action => action(),
        };
        window.purrksWorkspace = workspace;
        workspace.render();
    }, items);
}

async function items(page) {
    return page.evaluate(() => window.purrksWorkspace.session.draft.card.data.extensions.neconyan_purrks.items);
}

test('Catelier adds and edits a blank Purrk and exposes its trigger inputs', async ({ page }) => {
    await mount(page);
    await page.getByRole('button', { name: '+ Add Purrk', exact: true }).click();
    await expect(page.locator('.neconyan-purrk-card')).toHaveCount(1);
    await page.getByLabel('Label', { exact: true }).fill('Rain cloak');
    await page.getByLabel('Prompt directive', { exact: true }).fill('Wear the oilskin coat.');
    await page.getByLabel('Activation mode').selectOption('keyword');
    await page.getByLabel('Keywords (comma-separated)').fill('rain, storm');
    await page.getByLabel('Keywords (comma-separated)').blur();
    expect((await items(page))[0]).toMatchObject({ label: 'Rain cloak', prompt: 'Wear the oilskin coat.', keywords: ['rain', 'storm'] });
    await page.getByLabel('Activation mode').selectOption('scene');
    await page.getByLabel('Scene trigger condition').fill('When rain starts');
    await page.getByLabel('Scene trigger condition').blur();
    expect((await items(page))[0].condition).toBe('When rain starts');
});

test('deleting the middle Purrk leaves subsequent edits on the right item', async ({ page }) => {
    await mount(page, ['one', 'two', 'three'].map(id => ({ id, label: id, prompt: id })));
    await page.getByRole('button', { name: 'two', exact: true }).click();
    await page.getByRole('button', { name: 'Delete Purrk' }).click();
    await expect(page.locator('.neconyan-purrk-card')).toHaveCount(2);
    await page.getByRole('button', { name: 'three', exact: true }).click();
    await page.getByLabel('Prompt directive', { exact: true }).fill('Updated third');
    await page.getByLabel('Prompt directive', { exact: true }).blur();
    expect((await items(page)).map(item => [item.id, item.prompt])).toEqual([['one', 'one'], ['three', 'Updated third']]);
});
