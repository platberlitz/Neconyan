/* global document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// eslint-disable-next-line playwright/no-skipped-test -- This fixture must use an explicitly disposable server.
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

const extension = '/scripts/extensions/third-party/sillytavern-character-colors/src';
const reply = 'Brix leaned in. <font color="#3fa7d6">"I am new around here."</font>\n[COLORS:Brix=#3fa7d6]';

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await expect(page.locator('#send_textarea')).toBeVisible();
    return page;
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';

    test(`a new NPC's automatic gradient paints when the reply arrives on ${viewport}`, async ({ app }) => {
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: reply } }] };
        const account = await app.account({
            phone,
            activeConnection: true,
            configureSettings(saved) {
                saved.power_user.reply_generation_location = 'browser';
                saved.oai_settings = { ...saved.oai_settings, stream_openai: false };
            },
        });
        const page = await openChat(account);
        await page.evaluate(async extension => {
            const state = await import(`${extension}/state.js`);
            if (!state.runtimeState.ready) throw new Error('Dialogue Colors runtime did not start.');
            await state.runtimeState.ready;
            Object.assign(state.settings, {
                enabled: true,
                coloringEngine: 'llm',
                autoScanNewMessages: true,
                autoRandomNpcGradients: true,
                llmAttributionCheck: false,
                llmAttributionParallel: false,
                disableToasts: true,
            });
            (await import(`${extension}/main.js`)).syncAutomaticRuntime();
        }, extension);

        await page.evaluate(() => (async () => (await import('/script.js')).Generate('normal', { skipNativeRoleplay: true }))());
        const font = page.locator('#chat .mes[mesid]').last().locator('.mes_text font[color]');
        await expect(font).toContainText('I am new around here.', { timeout: 30000 });

        await expect.poll(() => page.evaluate(async extension => {
            const { characterColors } = await import(`${extension}/state.js`);
            return !!Object.values(characterColors).find(entry => entry.name === 'Brix')?.gradient;
        }, extension), { timeout: 10000 }).toBe(true);
        // Without a reload, a chat switch or any other repaint.
        await expect(font).toHaveAttribute('data-dc-gradient', /.+/, { timeout: 3000 });
        expect(await font.evaluate(element => element.style.getPropertyValue('--dc-gradient'))).not.toBe('');
        expect(await page.evaluate(() => document.querySelectorAll('#chat .mes_text font[data-dc-gradient]').length)).toBe(1);
    });
}
