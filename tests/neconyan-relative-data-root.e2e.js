/* global window, document */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { test } from './neconyan-conversation-durable-fixture.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(120000);

for (const phone of [false, true]) test(`${phone ? 'phone' : 'desktop'} relative configured data root loads settings without a reload loop`, async ({ app, browser }, info) => {
    const account = await app.account({ phone, activeConnection: true });
    const configPath = path.join(app.directory, 'config.yaml');
    const dataRoot = path.join(app.directory, 'data');
    const relative = path.relative(projectRoot, dataRoot);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(path.resolve(projectRoot, relative)).toBe(dataRoot);

    await app.stop('SIGKILL');
    const config = YAML.parse(await fs.readFile(configPath, 'utf8'));
    config.dataRoot = relative;
    await fs.writeFile(configPath, YAML.stringify(config));
    await app.start({ useConfigDataRoot: true });

    const csrf = await (await account.context.request.get('/csrf-token')).json();
    const settings = await account.context.request.post('/api/settings/get', {
        headers: { ...account.headers, 'X-CSRF-Token': csrf.token }, data: {},
    });
    expect(settings.ok(), 'The owned settings endpoint must work with a relative data root.').toBe(true);
    expect(JSON.parse((await settings.json()).settings).extension_settings.connectionManager.profiles[0].id).toBe('durable');

    const failedSettings = [];
    account.context.on('page', page => page.on('response', response => {
        if (response.url().includes('/api/settings/get') && !response.ok()) failedSettings.push(response.status());
    }));
    const page = await account.open({ workspace: false });
    await expect(page.getByRole('region', { name: 'Home' })).toBeVisible();
    expect(failedSettings).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('relative-data-root.png') });
    await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
});
