/* global window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// A chat rename that Scratchpad's damaged saved files refuse says why, instead of only 'An error has occurred'.
for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} rename tells the person that Scratchpad's saved chat identities are damaged`, async ({ app }, info) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        const original = await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            await context.saveChat({ throwOnError: true });
            await (await import('/script.js')).reloadCurrentChat();
            return context.getCurrentChatId();
        }, account.avatar);
        const legacy = { kind: 'roleplay', key: `character:${account.avatar}:${original}`, label: original };
        await account.post('/api/scratchpad/session/create', { source: legacy, name: 'Kept planning' });
        await fs.writeFile(path.join(app.dataRoot, 'default-user', 'scratchpad', 'identities.json'), '{damaged');
        // The popup waits to be closed, so the rename is started without waiting for it.
        await page.evaluate(({ original }) => {
            void import('/script.js').then(script => script.renameGroupOrCharacterChat({ characterId: script.this_chid, oldFileName: original, newFileName: 'Renamed planning chat' })).catch(() => {});
        }, { original });
        const popup = page.locator('.popup:visible .popup-content');
        await expect(popup).toContainText('Chat was not renamed.', { timeout: 30000 });
        await page.screenshot({ path: info.outputPath(`rename-refused-${phone ? 'phone' : 'desktop'}.png`) });
        await expect(popup).toContainText('Scratchpad\'s saved chat identities could not be read. The original files were kept.');
        await expect(popup.locator('[translate="no"]')).toHaveCount(1);
    });
}
