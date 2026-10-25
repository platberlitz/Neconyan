/* global window, document, requestAnimationFrame, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// eslint-disable-next-line playwright/no-skipped-test -- This fixture must use an explicitly disposable server.
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

const extension = '/scripts/extensions/third-party/sillytavern-character-colors/src';
const first = 'Durable Nova said, "The colours should already be here."';
const rest = ' Nova kept talking while I am still speaking.';
const full = first + rest;

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

    test(`browser streaming paints dialogue colours before completion on ${viewport}`, async ({ app }) => {
        app.provider.mode.streamReply = { first, rest };
        const account = await app.account({
            phone,
            activeConnection: true,
            configureSettings(saved) {
                saved.power_user.reply_generation_location = 'browser';
                saved.oai_settings = { ...saved.oai_settings, stream_openai: true };
            },
        });
        const page = await openChat(account);
        expect(page.viewportSize()).toEqual(phone ? { width: 393, height: 852 } : { width: 1280, height: 900 });
        await page.evaluate(async extension => {
            const state = await import(`${extension}/state.js`);
            if (!state.runtimeState.ready) throw new Error('Dialogue Colors runtime did not start.');
            await state.runtimeState.ready;
            const { settings, setCharacterColors } = state;
            const { buildCharacterEntry } = await import(`${extension}/palettes.js`);
            Object.assign(settings, {
                enabled: true,
                coloringEngine: 'dom',
                autoScanNewMessages: false,
                llmAttributionCheck: false,
                llmAttributionParallel: false,
                disableToasts: true,
            });
            (await import(`${extension}/main.js`)).syncAutomaticRuntime();
            const { key, entry } = buildCharacterEntry('Durable Nova', { color: '#d96a9e', origin: 'manual' });
            setCharacterColors({ [key]: entry });
            await (await import(`${extension}/storage.js`)).saveData();

            window.streamColourFrames = [];
            window.recordStreamColourFrames = true;
            let previous = null;
            const sample = () => {
                if (!window.recordStreamColourFrames) return;
                const messages = document.querySelectorAll('#chat .mes[mesid]');
                const quote = messages[messages.length - 1]?.querySelector('.mes_text q');
                if (quote) {
                    const current = {
                        text: quote.textContent,
                        messageText: quote.closest('.mes_text')?.textContent ?? '',
                        coloured: quote.hasAttribute('data-dc-colored'),
                    };
                    // A rAF can run in the same frame as the host write but before
                    // the extension's microtask paint. Only a text that survives
                    // into the next frame was presented, so record those.
                    if (previous && previous.text === current.text) window.streamColourFrames.push(current);
                    previous = current;
                } else {
                    previous = null;
                }
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        }, extension);

        const request = page.waitForRequest(request => request.url().endsWith('/api/backends/chat-completions/generate'));
        await page.locator('#send_textarea').fill('Tell me about the colours.');
        await page.evaluate(async () => {
            window.fixtureGeneration = (await import('/script.js')).Generate('normal', { skipNativeRoleplay: true })
                .catch(error => { window.fixtureGenerationError = error.message; });
        });
        await request;

        const last = page.locator('#chat .mes[mesid]').last();
        const quote = last.locator('.mes_text q');
        let heldFrames = [];
        try {
            await expect(quote).toBeVisible({ timeout: 30000 });
            await expect(quote).toHaveAttribute('data-dc-colored', '1');
            await expect(last.locator('.mes_text')).toContainText('The colours should already be here.');
            await expect.poll(() => app.provider.calls.length).toBe(1);
            expect(app.provider.calls[0].completedAt).toBeNull();

            // This is the ordinary browser stream, not the native server preview.
            expect(await page.locator('#neconyan-roleplay-preview').count()).toBe(0);
            const mesid = Number(await last.getAttribute('mesid'));
            const session = await page.evaluate(async extension => {
                const { streamingSession } = await import(`${extension}/state.js`);
                return { active: streamingSession.active, hasObserver: !!streamingSession.observer, mesIndex: streamingSession.mesIndex };
            }, extension);
            expect(session).toEqual({ active: true, hasObserver: true, mesIndex: mesid });

            const colours = await last.evaluate(element => ({
                quote: getComputedStyle(element.querySelector('.mes_text q')).color,
                text: getComputedStyle(element.querySelector('.mes_text')).color,
            }));
            expect(colours.quote).not.toBe(colours.text);

            // Let a few frames pass while the provider is held after the first chunk.
            await page.evaluate(() => new Promise(resolve => {
                requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }));
            heldFrames = await page.evaluate(() => window.streamColourFrames.slice());
            expect(heldFrames.length).toBeGreaterThan(0);
            expect(heldFrames.filter(frame => !frame.coloured)).toEqual([]);
            expect(heldFrames.every(frame => !frame.messageText.includes('still speaking'))).toBe(true);
            expect(app.provider.calls[0].completedAt).toBeNull();
        } finally {
            app.provider.mode.finishStream?.();
        }

        await expect(last.locator('.mes_text')).toContainText(full, { timeout: 30000 });
        await expect(quote).toHaveAttribute('data-dc-colored', '1');
        await expect.poll(() => app.provider.calls.length).toBe(1);
        await expect.poll(() => app.provider.calls[0].completedAt).not.toBeNull();

        const frames = await page.evaluate(() => {
            window.recordStreamColourFrames = false;
            return window.streamColourFrames;
        });
        expect(frames.length).toBeGreaterThan(heldFrames.length);
        expect(frames.filter(frame => !frame.coloured)).toEqual([]);
        expect(frames.some(frame => frame.messageText.includes('still speaking'))).toBe(true);

        const finalColours = await last.evaluate(element => ({
            quote: getComputedStyle(element.querySelector('.mes_text q')).color,
            text: getComputedStyle(element.querySelector('.mes_text')).color,
        }));
        expect(finalColours.quote).not.toBe(finalColours.text);
        await expect.poll(() => page.evaluate(async extension => {
            const { streamingSession } = await import(`${extension}/state.js`);
            return { active: streamingSession.active, hasObserver: !!streamingSession.observer };
        }, extension)).toEqual({ active: false, hasObserver: false });

        await page.evaluate(() => window.fixtureGeneration);
        expect(await page.evaluate(() => window.fixtureGenerationError)).toBeUndefined();
        const saved = await page.evaluate(async () => (await import('/script.js')).chat
            .filter(message => !message.is_user)
            .map(message => message.mes));
        expect(saved.filter(mes => mes.includes('The colours should already be here.'))).toHaveLength(1);
        expect(saved.at(-1)).toContain('Nova kept talking while I am still speaking.');
    });
}
