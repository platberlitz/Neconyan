/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`cached catalogues reflect saved changes on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        await expect(page.locator('.neconyan-assistant-row').first()).toBeVisible();

        const result = await page.evaluate(async () => {
            const headers = window.SillyTavern.getContext().getRequestHeaders();
            const request = async (url, body) => {
                const response = await fetch(url, body === undefined ? {} : {
                    method: 'POST', headers, body: JSON.stringify(body),
                });
                if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
                const text = await response.text();
                return text === 'OK' ? null : JSON.parse(text);
            };
            const catalogue = () => request('/api/settings/get', { sections: ['presets'] });
            const name = 'Backend cache fixture';
            const save = temperature => request('/api/presets/save', { name, apiId: 'openai', preset: { temperature } });
            const temperature = data => JSON.parse(data.openai_settings[data.openai_setting_names.indexOf(name)]).temperature;
            await catalogue();
            await save(1);
            const added = temperature(await catalogue());
            const warm = temperature(await catalogue());
            await save(2);
            const edited = temperature(await catalogue());
            await request('/api/presets/delete', { name, apiId: 'openai' });
            const removed = !(await catalogue()).openai_setting_names.includes(name);

            const assistants = () => request('/api/characters/assistants');
            const installed = data => data.personalities.flatMap(item => item.variants)
                .find(item => item.id === 'miso-male').installed;
            const before = installed(await assistants());
            await assistants();
            const created = await request('/api/characters/assistants/install', { id: 'miso-male' });
            const after = installed(await assistants());
            const repeated = installed(await assistants());
            return { added, warm, edited, removed, before, created, after, repeated };
        });

        expect(result).toMatchObject({ added: 1, warm: 1, edited: 2, removed: true, before: [] });
        expect(result.after).toEqual([expect.objectContaining({ avatar: result.created.avatar, id: 'miso-male' })]);
        expect(result.repeated).toEqual(result.after);
        await expect(page.locator('.neconyan-assistant-row').first()).toBeVisible();
    });
}
