import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';
import { startNativeReply } from './native-roleplay-helpers.js';

const MODEL = 'gpt-5.1';

async function openChat(page, avatar, name) {
    return page.evaluate(async ({ avatar, name }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        if (name && core.getCurrentChatId() !== name) await core.openCharacterChat(name);
        return core.getCurrentChatId();
    }, { avatar, name });
}

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} server reply retains its reasoning-effort label after reload`, async ({ app }) => {
        test.setTimeout(180000);
        let sentEffort;
        app.provider.mode.reply = body => {
            sentEffort = body.reasoning_effort;
            return { choices: [{ message: { role: 'assistant', content: 'The reply keeps its chosen effort.' } }] };
        };
        app.provider.mode.streamReply = body => {
            sentEffort = body.reasoning_effort;
            return { first: 'The reply keeps', rest: ' its chosen effort.' };
        };
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.custom_model = MODEL;
            saved.oai_settings.reasoning_effort = 'medium';
            saved.oai_settings.stream_openai = phone;
            saved.power_user.timestamp_model_name = true;
            saved.power_user.timestamp_reasoning_effort = true;
        } });
        const page = await account.open({ workspace: false });
        const chatName = await openChat(page, account.avatar);
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText('Hello.');
        await acknowledgeActiveSettings(page);
        expect(await page.evaluate(async () => (await import('/script.js')).saveChatConditional({ throwOnError: true }))).toBe(true);
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await page.locator('#send_textarea').fill('Please reply.');
        await startNativeReply(page);
        const response = await submitted;
        expect(response.ok(), await response.text()).toBe(true);
        if (phone) {
            try {
                const previewLabel = page.locator('#neconyan-roleplay-preview .timestamp-model');
                await expect(previewLabel).toContainText(MODEL);
                await page.screenshot({ path: `../screenshots/server-reasoning-effort-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
                await expect(previewLabel).toHaveText(`${MODEL} (medium)`);
            } finally {
                app.provider.mode.finishStream?.();
            }
        }
        await account.settled((await response.json()).jobId);
        expect(app.provider.calls).toHaveLength(1);
        expect(sentEffort).toBe('medium');
        await expect(page.locator('#neconyan-roleplay-preview')).toHaveCount(0);
        const label = page.locator('#chat .mes[mesid]').last().locator('.timestamp-model');
        await expect(label).toContainText(MODEL);
        if (!phone) await page.screenshot({ path: `../screenshots/server-reasoning-effort-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        await expect(label).toHaveText(`${MODEL} (medium)`);
        await expect(label).toBeVisible();
        const bounds = await label.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
        // Later settings must never relabel a reply that used a different effort.
        await page.evaluate(async () => {
            (await import('/scripts/openai.js')).oai_settings.reasoning_effort = 'low';
            await (await import('/script.js')).saveSettings(0, { returnResult: true });
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
        await openChat(page, account.avatar, chatName);
        await expect(label).toHaveText(`${MODEL} (medium)`);
        expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1).extra.reasoning_effort)).toBe('medium');
        expect(app.provider.calls).toHaveLength(1);
    });
}
