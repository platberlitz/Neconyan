/* global window, document, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`a stream without reasoning shows Thinking until its first words on ${viewport}`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
        } });
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const originalFetch = window.fetch;
            window.fetch = (input, options) => {
                if (!String(input).endsWith('/api/backends/chat-completions/generate')) return originalFetch(input, options);
                const stream = new ReadableStream({ start(controller) {
                    window.sendThinkingChunk = content => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
                    window.finishThinkingStream = () => {
                        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                        controller.close();
                    };
                } });
                return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
            };
            document.querySelector('#send_textarea').value = 'Tell me what happens next.';
            window.thinkingGeneration = core.Generate('normal');
        }, account.avatar);
        const message = page.locator('#chat .mes[mesid]').last();
        await expect(message.locator('.mes_text')).toHaveText(/^(\.\.\.|…)$/, { timeout: 30000 });
        await message.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/thinking-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        const indicator = message.locator('.neconyan-streaming-thinking');
        await expect(indicator).toHaveText('Thinking...');
        await expect(indicator).toBeVisible();
        const layout = await indicator.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, height: rect.height, colour: getComputedStyle(element).color };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(layout.height).toBeGreaterThan(0);
        expect(layout.colour).not.toBe('rgba(0, 0, 0, 0)');
        await page.evaluate(() => window.sendThinkingChunk('The first words.'));
        await expect(message.locator('.mes_text')).toHaveText('The first words.');
        await expect(indicator).toHaveCount(0);
        await page.evaluate(async () => { window.finishThinkingStream(); await window.thinkingGeneration; });
        const saved = await page.evaluate(async () => (await import('/script.js')).chat.at(-1));
        expect(saved.mes).toBe('The first words.');
        expect(saved.extra.reasoning || '').toBe('');
        expect(saved.extra.reasoning_duration).toBeNull();
    });
}
