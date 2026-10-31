/* global window, document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

const LENGTH_WARNING = 'The reply ran out of Max Response Length while the model was still reasoning. Raise Max Response Length or lower the reasoning effort, then try again.';
const FINISHED_WARNING = 'The model finished reasoning but returned no reply text.';

async function streamReasoningOnly(page, avatar, finishReason) {
    await page.evaluate(async ({ avatar, finishReason }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        const originalFetch = window.fetch;
        window.fetch = (input, options) => {
            if (!String(input).endsWith('/api/backends/chat-completions/generate')) return originalFetch(input, options);
            const frame = value => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
            const stream = new ReadableStream({ start(controller) {
                controller.enqueue(frame({ choices: [{ delta: { reasoning: 'Planning the room, the weather and the tracker.' } }] }));
                controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: finishReason }] }));
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                controller.close();
            } });
            return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
        };
        document.querySelector('#send_textarea').value = 'Tell me what happens next.';
        await core.Generate('normal', { skipNativeRoleplay: true });
    }, { avatar, finishReason });
}

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`a reply cut off while reasoning names Max Response Length on ${viewport}`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
            saved.oai_settings.show_thoughts = true;
        } });
        const page = await account.open({ workspace: false });
        await streamReasoningOnly(page, account.avatar, 'length');
        const warning = page.locator('#toast-container .toast-warning').last();
        await expect(warning).toBeVisible({ timeout: 30000 });
        await page.screenshot({ path: `../screenshots/reasoning-length-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        await expect(warning).toContainText(LENGTH_WARNING);
        await expect(page.locator('#toast-container')).not.toContainText(FINISHED_WARNING);
        const saved = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
        expect(saved.mes.trim()).toBe('');
        expect(saved.extra.reasoning).toContain('Planning the room');
    });
}

test('a reasoning-only reply that stopped normally keeps the finished warning', async ({ app }) => {
    const account = await app.account({ phone: false, activeConnection: true, configureSettings(saved) {
        saved.oai_settings.stream_openai = true;
        saved.oai_settings.show_thoughts = true;
    } });
    const page = await account.open({ workspace: false });
    await streamReasoningOnly(page, account.avatar, 'stop');
    const warning = page.locator('#toast-container .toast-warning').last();
    await expect(warning).toContainText(FINISHED_WARNING, { timeout: 30000 });
    await expect(page.locator('#toast-container')).not.toContainText(LENGTH_WARNING);
});
