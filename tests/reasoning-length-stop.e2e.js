/* global window, document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

const LENGTH_WARNING = 'The reply ran out of Max Response Length while the model was still reasoning. Raise Max Response Length or lower the reasoning effort, then try again.';
const FINISHED_WARNING = 'The model finished reasoning but returned no reply text.';
const PARTIAL_PROSE = 'She opens the door and';

for (const phone of [true, false]) {
    for (const mode of ['stream', 'buffer', 'nonstream']) {
        test(`a provider length stop preserves inline-thinking prose on ${phone ? 'phone' : 'desktop'}: ${mode}`, async ({ app }) => {
            const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
                saved.oai_settings.stream_openai = mode !== 'nonstream';
                saved.oai_settings.show_thoughts = true;
                saved.power_user.trim_sentences = true;
                Object.assign(saved.power_user.reasoning ??= {}, { auto_parse: true, prefix: '<think>', suffix: '</think>' });
            } });
            const page = await account.open({ workspace: false });
            const result = await page.evaluate(async ({ avatar, mode, prose }) => {
                const core = await import('/script.js');
                await core.getCharacters();
                await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
                if (mode === 'buffer') core.eventSource.on(core.event_types.GENERATION_OUTPUT_BUFFERING_DECISION, data => { data.hasPostMainInterceptors = true; });
                const originalFetch = window.fetch;
                let calls = 0;
                window.fetch = (input, options) => {
                    if (!String(input).endsWith('/api/backends/chat-completions/generate')) return originalFetch(input, options);
                    calls++;
                    const content = '<think>Plan the room.</think>' + prose;
                    if (mode === 'nonstream') return Promise.resolve(Response.json({ choices: [{ message: { content }, finish_reason: 'length' }] }));
                    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
                    return Promise.resolve(new Response(frame({ choices: [{ delta: { content } }] })
                        + frame({ choices: [{ delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n',
                    { headers: { 'Content-Type': 'text/event-stream' } }));
                };
                document.querySelector('#send_textarea').value = 'Tell me what happens next.';
                try {
                    await core.Generate('normal', { skipNativeRoleplay: true });
                    return { message: structuredClone(core.chat.at(-1)), calls };
                } finally { window.fetch = originalFetch; }
            }, { avatar: account.avatar, mode, prose: PARTIAL_PROSE });
            await page.screenshot({ path: `../screenshots/length-prose-${phone ? 'phone' : 'desktop'}-${mode}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
            expect(result.calls).toBe(1);
            expect(result.message.mes).toBe(PARTIAL_PROSE);
            expect(result.message.extra.reasoning).toBe('Plan the room.');
            expect(result.message.swipes[result.message.swipe_id]).toBe(PARTIAL_PROSE);
            await expect(page.locator('#chat .mes').last().locator('.mes_text')).toContainText(PARTIAL_PROSE);
            await page.close();
            const reopened = await account.open({ workspace: false });
            await reopened.evaluate(async avatar => {
                const core = await import('/script.js');
                await core.getCharacters();
                await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            }, account.avatar);
            await expect.poll(() => reopened.evaluate(async () => (await import('/script.js')).chat.at(-1)?.mes), { timeout: 30000 }).toBe(PARTIAL_PROSE);
        });
    }
}

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
