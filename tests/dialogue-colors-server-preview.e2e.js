/* global window, document, requestAnimationFrame, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

async function skipTour(page) {
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    await skip.click();
    // dismissTutorial awaits saveSettings before it removes the coachmark. Do not
    // start app work while that save/dismissal is still in flight.
    await page.waitForFunction(() => !document.querySelector('#neconyan-tour-coachmark'));
}

const extension = '/scripts/extensions/third-party/sillytavern-character-colors/src';
const first = 'Nova smiled. "The colours should already be here';
const rest = ', while I am still speaking."';

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`server reply dialogue colours appear before completion on ${viewport}`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.streamReply = { first, rest };
        const account = await app.account({ phone, activeConnection: true,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(settings) {
                settings.oai_settings.stream_openai = true;
            } });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false, skipTour: false });
        await skipTour(page);
        await page.evaluate(async ({ avatar, extension }) => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const { settings, setCharacterColors } = await import(`${extension}/state.js`);
            const { buildCharacterEntry } = await import(`${extension}/palettes.js`);
            Object.assign(settings, { coloringEngine: 'dom', autoScanNewMessages: false,
                llmAttributionCheck: false, disableToasts: true });
            const { key, entry } = buildCharacterEntry('Durable Nova', { color: '#d96a9e', origin: 'manual' });
            setCharacterColors({ [key]: entry });
            await (await import(`${extension}/storage.js`)).saveData();
            window.previewFrames = [];
            window.recordPreviewFrames = true;
            const sample = () => {
                if (!window.recordPreviewFrames) return;
                const quote = document.querySelector('#neconyan-roleplay-preview .mes_text q');
                if (quote) window.previewFrames.push({ text: quote.textContent, coloured: quote.hasAttribute('data-dc-colored') });
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        }, { avatar: account.avatar, extension });
        if (phone) await applyIOSOnlyCss(page);
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await page.locator('#send_textarea').fill('Please keep talking while I read.');
        await page.locator('#send_textarea').press('Enter');
        const { jobId } = await (await submitted).json();
        try {
            const preview = page.locator('#neconyan-roleplay-preview');
            await expect(preview).toContainText('The colours should already be here');
            await expect(preview.locator('[role="status"]')).toHaveText('Writing reply…');
            await preview.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `../screenshots/server-dialogue-colours-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
            const quote = preview.locator('.mes_text q');
            await expect(quote).toHaveAttribute('data-dc-colored', '1');
            const colour = await quote.evaluate(element => getComputedStyle(element).color);
            expect(colour).not.toBe(await preview.locator('.mes_text').evaluate(element => getComputedStyle(element).color));
            expect(await preview.getAttribute('mesid')).toBeNull();
            expect(await page.evaluate(async first => (await import('/script.js')).chat.some(message => message.mes.includes(first)), first)).toBe(false);
            const saved = await account.post('/api/chats/get', { avatar_url: account.avatar,
                file_name: await page.evaluate(async () => (await import('/script.js')).getCurrentChatId()) });
            expect(JSON.stringify(saved)).not.toContain(first);
            expect((await account.job(jobId)).state).not.toBe('completed');
            app.provider.mode.finishStream();
            await expect(page.locator('#chat .mes[mesid]').last()).toContainText(first + rest);
            await expect(preview).toHaveCount(0);
            await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text q')).toHaveAttribute('data-dc-colored', '1');
            const frames = await page.evaluate(() => { window.recordPreviewFrames = false; return window.previewFrames; });
            expect(frames.length).toBeGreaterThan(0);
            expect(frames.filter(frame => !frame.coloured)).toEqual([]);
            expect(app.provider.calls).toHaveLength(1);
        } finally {
            app.provider.mode.finishStream?.();
        }
    });
}

test('preview updates preserve gradients, exclusions and display-only state', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open({ workspace: false, skipTour: false });
    await skipTour(page);
    const novaColour = await page.evaluate(async ({ avatar, extension }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        const state = await import(`${extension}/state.js`);
        const { buildCharacterEntry } = await import(`${extension}/palettes.js`);
        Object.assign(state.settings, { coloringEngine: 'llm', autoScanNewMessages: false, llmAttributionCheck: false,
            skipNarratorCard: true, excludedSpeakerNames: ['Scenario'], disableToasts: true });
        const { key, entry } = buildCharacterEntry('Durable Nova', { color: '#d96a9e', origin: 'manual' });
        entry.gradient = { type: 'linear', angle: 90, primaryPosition: 0,
            stops: [{ color: '#9e88ee', baseColor: '#9e88ee', position: 100 }] };
        state.setCharacterColors({ [key]: entry });
        await (await import(`${extension}/storage.js`)).saveData();
        window.savedPreviewState = JSON.stringify({ chat: core.chat, colours: state.characterColors, metadata: core.chat_metadata });
        const originalFetch = window.fetch;
        window.fetch = (input, options) => String(input).includes('/api/jobs/colour-regression/preview')
            ? Promise.resolve(new Response(new ReadableStream({ start(controller) {
                window.sendColourPreview = preview => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ preview })}\n\n`));
            } }), { headers: { 'Content-Type': 'text/event-stream' } }))
            : originalFetch(input, options);
        const { observeRoleplayPreview } = await import('/scripts/neconyan-conversation/roleplay-preview.js');
        const stop = observeRoleplayPreview('colour-regression', { account: 'test', isCurrent: () => true, onTerminal() {} });
        window.stopColourPreview = () => { stop(); window.fetch = originalFetch; };
        return state.characterColors[key].color;
    }, { avatar: account.avatar, extension });
    const preview = page.locator('#neconyan-roleplay-preview');
    const send = async (text, { name = 'Durable Nova', childId = 'reply', stage = 'generating' } = {}) => {
        await page.evaluate(preview => window.sendColourPreview(preview), { text, name, childId, stage, updatedAt: Date.now() });
        await expect(preview.locator('.mes_text')).toContainText(text.replace(/<[^>]+>|\[COLORS:[^\]]+\]|"/g, '').trim());
    };
    try {
        // LLM mode colours only explicit model tags. A known speaker's gradient
        // and excluded names must work even before a COLORS footer arrives.
        await send(`<font color="${novaColour}">"The gradient arrives immediately."</font>`);
        await expect(preview.locator('font')).toHaveClass(/dc-gradient-text/);
        expect(await preview.locator('font').evaluate(element => getComputedStyle(element).backgroundImage)).toContain('linear-gradient');
        await send(`<font color="${novaColour}">"The gradient arrives immediately, and stays as I speak."</font>`);
        await expect(preview.locator('font')).toHaveClass(/dc-gradient-text/);
        await send('<font color="#cc2244">"An excluded narrator."</font>\n[COLORS:Narrator=#cc2244]', { name: 'Narrator', childId: 'narrator' });
        expect(await preview.locator('font').evaluate(element => getComputedStyle(element).color))
            .toBe(await preview.locator('.mes_text').evaluate(element => getComputedStyle(element).color));
        await send('<font color="#22aa66">"An excluded scenario."</font>\n[COLORS:Scenario=#22aa66]', { name: 'Scenario', childId: 'scenario' });
        expect(await preview.locator('font').evaluate(element => getComputedStyle(element).color))
            .toBe(await preview.locator('.mes_text').evaluate(element => getComputedStyle(element).color));
        await send('"A plain line in LLM mode."', { childId: 'plain' });
        await expect(preview.locator('[data-dc-colored], .dc-gradient-text')).toHaveCount(0);

        await page.evaluate(async extension => { (await import(`${extension}/state.js`)).settings.coloringEngine = 'dom'; }, extension);
        await send('"A local line');
        await expect(preview.locator('q')).toHaveClass(/dc-gradient-text/);
        await send('"A local line keeps growing');
        await expect(preview.locator('q')).toHaveClass(/dc-gradient-text/);
        await send('"An unknown speaker must not reuse Nova’s colour."', { name: 'Unknown', childId: 'other-member' });
        await expect(preview.locator('[data-dc-colored], .dc-gradient-text')).toHaveCount(0);
        await send('"Back to Nova."', { childId: 'nova-again', stage: 'companions' });
        await expect(preview.locator('q')).toHaveClass(/dc-gradient-text/);
        await expect(preview.locator('[role="status"]')).toHaveText('Running Companions…');

        await page.evaluate(async extension => {
            const { settings } = await import(`${extension}/state.js`);
            settings.enabled = false;
            (await import(`${extension}/main.js`)).syncAutomaticRuntime();
        }, extension);
        await expect(preview.locator('[data-dc-colored], .dc-gradient-text')).toHaveCount(0);
        await send('"Disabled colouring stays disabled."');
        await expect(preview.locator('[data-dc-colored], .dc-gradient-text')).toHaveCount(0);
        const savedState = await page.evaluate(async extension => {
            const core = await import('/script.js');
            const state = await import(`${extension}/state.js`);
            // A background world-info pass after the chat opens may add empty timed-effect slots.
            const settled = value => {
                const copy = JSON.parse(JSON.stringify(value));
                const timed = copy.metadata?.timedWorldInfo;
                if (timed && Object.values(timed).every(slot => slot && !Object.keys(slot).length)) delete copy.metadata.timedWorldInfo;
                return copy;
            };
            return {
                before: settled(JSON.parse(window.savedPreviewState)),
                after: settled({ chat: core.chat, colours: state.characterColors, metadata: core.chat_metadata }),
            };
        }, extension);
        expect(savedState.after).toEqual(savedState.before);
        expect(app.provider.calls).toHaveLength(0);
    } finally {
        await page.evaluate(() => window.stopColourPreview());
    }
    await expect(preview).toHaveCount(0);
});
