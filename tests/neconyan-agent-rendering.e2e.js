/* global window, document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { createLongChatRenderFixture, measureLongChatRender, measureStreamingRender } from '../scripts/measure-frontend-performance.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

test('Agent refreshes visit rendered messages in a long chat', async ({ app }, info) => {
    const account = await app.account();
    const page = await account.open({ workspace: false, readyTimeout: 60000 });
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    const ordinary = await measureLongChatRender(page);
    const streaming = await measureStreamingRender(page);
    const long = await measureLongChatRender(page, createLongChatRenderFixture({ messageCount: 10000, visibleCount: 24, fillerRepeat: 1 }));
    const refresh = await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        const { COMPANION_RESULTS_UPDATED_EVENT } = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const original = window.$;
        let queries = 0;
        window.$ = new Proxy(original, {
            apply(target, receiver, args) {
                if (typeof args[0] === 'string' && args[0].startsWith('.mes[mesid=')) queries++;
                return Reflect.apply(target, receiver, args);
            },
        });
        const samples = [];
        try {
            for (let index = 0; index < 7; index++) {
                queries = 0;
                const start = window.performance.now();
                await eventSource.emit(COMPANION_RESULTS_UPDATED_EVENT, {});
                samples.push({ durationMs: window.performance.now() - start, queries });
            }
            // Loading older messages must also decorate their choices.
            const message = document.createElement('div');
            message.className = 'mes';
            message.setAttribute('mesid', '9975');
            message.innerHTML = '<div class="mes_text"><div class="custom-pura-choice"><span>1</span><span>Open the door.</span></div></div>';
            document.getElementById('chat').prepend(message);
            await eventSource.emit(event_types.MORE_MESSAGES_LOADED);
            return { samples, loadedChoice: message.querySelector('button')?.dataset.icaChoiceText };
        } finally {
            window.$ = original;
        }
    });
    const measurements = { ordinary, streaming, long, refresh };
    await info.attach('render-performance', { body: JSON.stringify(measurements), contentType: 'application/json' });
    console.log(JSON.stringify(measurements));
    expect(long.renderedCount).toBe(24);
    expect(refresh.samples.every(sample => sample.queries <= long.renderedCount)).toBe(true);
    expect(refresh.loadedChoice).toBe('1. Open the door.');
});
