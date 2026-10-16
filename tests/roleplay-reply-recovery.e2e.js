import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { checkImageControlContrast } from './scratchpad-image-contrast-helpers.js';

const mainReply = 'The completed reply stays readable while the Agents finish.';
const earlyBlock = 'First choices: stay here or explore.';

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} completed Agent changes appear immediately and a changed chat keeps a downloadable reply`, async ({ app }, info) => {
        test.setTimeout(180000);
        app.provider.mode.hold = 'held-agent';
        app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === 'held-agent'
            ? 'Last choices: take the path home.' : body.model === 'fast-agent' ? earlyBlock : mainReply }, finish_reason: 'stop' }] });
        const account = await app.account({ phone, activeConnection: true,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
                saved.extension_settings.connectionManager.profiles.push(...['fast-agent', 'held-agent'].map(model => ({
                    id: model, name: model, api: 'custom', mode: 'cc', model, 'api-url': app.provider.url,
                })));
                saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                    trackerCompanionAutoLoopVersion: 4, appendAgentsExecutionMode: 'parallel' } };
            } });
        if (phone) await installIPhoneSafari(account.context);
        const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(directory, { recursive: true });
        for (const [id, profile] of [['early', 'fast-agent'], ['late', 'held-agent']]) {
            await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, name: id, enabled: true,
                category: 'custom', phase: 'post', prompt: 'Add choices.', connectionProfile: profile,
                postProcess: { enabled: true, promptTransformEnabled: true, promptTransformMode: 'append', promptTransformMaxTokens: 64 } }));
        }
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page);
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await page.locator('#send_textarea').fill('Show the reply as it is ready.');
        await page.locator('#send_textarea').press('Enter');
        const { jobId } = await (await submitted).json();
        const preview = page.locator('#neconyan-roleplay-preview');
        await expect.poll(() => app.provider.calls.length).toBe(3);
        await expect(preview.locator('.mes_text')).toContainText(mainReply);
        await expect(preview.locator('.mes_text')).toContainText(earlyBlock);
        expect(app.provider.calls.find(call => call.model === 'held-agent').completedAt).toBeNull();
        await preview.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/roleplay-agent-progress-${viewport}-after.png`, scale: 'css' });

        // Simulate an independent editor. A real changed source must still refuse
        // delivery, while retaining the paid text outside the saved chat.
        await page.evaluate(async () => {
            const core = await import('/script.js');
            core.chat.at(-1).mes = 'Independent edit that must survive.';
            await core.saveChatConditional({ throwOnError: true });
        });
        await app.release();
        await expect.poll(async () => (await account.job(jobId)).state, { timeout: 60000 }).toMatch(/^(interrupted|failed|conflict)$/);
        const recovered = page.getByLabel('Recovered reply', { exact: true });
        await expect(recovered).toContainText(mainReply, { timeout: 60000 });
        await expect(recovered).toContainText(earlyBlock);
        await expect(preview).toHaveCount(0);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating())).toBe(false);
        expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1).mes)).toBe('Independent edit that must survive.');
        const download = page.waitForEvent('download');
        await recovered.getByRole('button', { name: 'Download reply' }).click();
        const downloaded = await fs.readFile(await (await download).path(), 'utf8');
        expect(downloaded).toContain(mainReply);
        expect(downloaded).toContain(earlyBlock);
        const contrasts = await checkImageControlContrast(page, [1, 2, 3].map(index =>
            `#neconyan-roleplay-recovered-${jobId} .neconyan-roleplay-recovery-actions button:nth-child(${index})`), phone);
        await info.attach('recovery-button-contrast', { body: JSON.stringify(contrasts), contentType: 'application/json' });
        await recovered.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/roleplay-recovered-${viewport}-after.png`, scale: 'css' });
        expect(app.provider.calls).toHaveLength(3);

        await app.restart();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: /^Open Durable Nova: Durable Nova -/ }).click();
        if (phone) await applyIOSOnlyCss(page);
        await expect(recovered).toContainText(mainReply, { timeout: 60000 });
        expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1).mes)).toBe('Independent edit that must survive.');
        expect(app.provider.calls).toHaveLength(3);
        await recovered.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(recovered).toHaveCount(0);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: /^Open Durable Nova: Durable Nova -/ }).click();
        await expect(recovered).toHaveCount(0);
    });
}
