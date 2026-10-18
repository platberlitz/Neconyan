/* global window */
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { captureMacros, openMacros } from './macro-enhanced-native-helpers.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

const GLOBALS = {
    lumia_personality_standard: 'I, Lumia, speak with my true voice',
    lumia_personality_neko: 'nya',
    pov: 'first person',
};

for (const phone of [false, true]) {
    test(`Remove unused clears leftover global variables after confirmation (${phone ? 'phone' : 'desktop'})`, async ({ app }, info) => {
        const presets = path.join(app.dataRoot, 'default-user', 'OpenAI Settings');
        await fs.mkdir(presets, { recursive: true });
        await fs.writeFile(path.join(presets, 'Uses pov.json'), JSON.stringify({ prompts: [{ content: 'Write in {{getglobalvar::pov}}.' }] }));

        const { page, workbench } = await openMacros(app, phone, {
            configureSettings: settings => {
                settings.extension_settings ??= {};
                settings.extension_settings.variables = { global: { ...GLOBALS } };
            },
        });
        const globals = workbench.locator('[data-me-globals]');
        await globals.locator('summary').click();
        await expect(globals.locator('summary')).toHaveText('Global variables (3)');
        const removeButton = globals.getByRole('button', { name: 'Remove unused', exact: true });
        await removeButton.scrollIntoViewIfNeeded();
        await captureMacros(page, info, `${phone ? 'phone' : 'desktop'}-unused-globals-before`);

        await removeButton.click();
        const dialog = page.locator('dialog[open]');
        await expect(dialog).toContainText('Remove 2 unused global variables?');
        await expect(dialog).toContainText('lumia_personality_neko, lumia_personality_standard');
        await expect(dialog).not.toContainText('pov,');
        await captureMacros(page, info, `${phone ? 'phone' : 'desktop'}-unused-globals-confirm`);
        await dialog.getByText('Yes', { exact: true }).click();

        await expect(globals.locator('summary')).toHaveText('Global variables (1)');
        await expect(workbench.locator('[data-me-globals-status]')).toHaveText('Removed 2 unused global variables.');
        await expect.poll(() => page.evaluate(() => Object.keys(window.SillyTavern.getContext().extensionSettings.variables.global))).toEqual(['pov']);
        await expect.poll(async () => {
            const saved = JSON.parse(await fs.readFile(path.join(app.dataRoot, 'default-user', 'settings.json'), 'utf8'));
            return Object.keys(saved.extension_settings.variables.global);
        }, { timeout: 15000 }).toEqual(['pov']);
        await globals.scrollIntoViewIfNeeded();
        await captureMacros(page, info, `${phone ? 'phone' : 'desktop'}-unused-globals-after`);
        expect(app.provider.calls).toHaveLength(0);
    });
}
