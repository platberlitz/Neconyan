/* eslint-disable playwright/no-conditional-in-test -- Both viewport variants share the same checks with optional iOS emulation. */
/* global document, getComputedStyle, globalThis, navigator */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

// A test browser has no microphone, so the recorder and the audio decoder are stand-ins.
function installMicrophone() {
    const state = { started: 0, released: 0 };
    globalThis.scratchpadMicrophone = state;
    const mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { state.released += 1; } }] }) };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => mediaDevices });
    globalThis.MediaRecorder = class {
        constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
        start() { this.state = 'recording'; state.started += 1; }
        stop() {
            this.state = 'inactive';
            this.ondataavailable?.({ data: new Blob(['sound'], { type: 'audio/webm' }) });
            this.onstop?.();
        }
    };
    globalThis.OfflineAudioContext = class {
        async decodeAudioData() {
            return { length: 1600, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(1600).fill(0.25) };
        }
    };
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad dictation puts the heard text in the box without sending it`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.context.addInitScript(installMicrophone);
        const page = await account.open();
        const open = async tab => {
            await page.evaluate(async name => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: name }), tab);
            if (phone) await applyIOSOnlyCss(page);
        };
        const microphone = () => page.evaluate(() => globalThis.scratchpadMicrophone);
        const prefix = `../screenshots/scratchpad-dictation/${phone ? 'phone' : 'desktop'}`;
        const width = phone ? 393 : 1280;
        const requests = [];
        let groq = 0;
        await page.route('**/api/speech/recognize', async route => {
            requests.push(route.request().postDataJSON());
            await route.fulfill({ json: { text: '  Hello from\nthe microphone. ' } });
        });
        await page.route('**/api/openai/groq/transcribe-audio', async route => {
            groq += 1;
            await route.fulfill({ status: 400, json: { error: true } });
        });

        await open('chat');
        const composer = page.locator('.scratchpad-composer');
        const dictate = page.locator('.scratchpad-dictate');
        const send = page.locator('.scratchpad-send');
        await expect(composer).toBeEnabled();
        await expect(dictate).toHaveAttribute('aria-label', 'Dictate');
        await expect(dictate).toHaveAttribute('aria-pressed', 'false');

        // The button is a full touch target and sits between the box and Send.
        const [box, boxComposer, boxSend] = await Promise.all([dictate.boundingBox(), composer.boundingBox(), send.boundingBox()]);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(boxComposer.x + boxComposer.width);
        expect(box.x + box.width).toBeLessThanOrEqual(boxSend.x);
        expect(boxSend.x + boxSend.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `${prefix}-button.png` });

        await composer.fill('Note:');
        await dictate.click();
        await expect(dictate).toHaveAttribute('aria-label', 'Stop and transcribe');
        await expect(dictate).toHaveAttribute('aria-pressed', 'true');
        await expect(dictate).toBeFocused();
        expect(await microphone()).toEqual({ started: 1, released: 0 });
        await page.screenshot({ path: `${prefix}-recording.png` });

        for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
            await page.locator('#themes').selectOption({ label: theme }, { force: true });
            for (const accent of [null, 'Pearl', 'Midnight Ink']) {
                if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
                const contrast = await dictate.evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const context = document.createElement('canvas').getContext('2d');
                    const channels = colour => {
                        context.fillStyle = colour;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
                    };
                    let surface = element;
                    while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
                    return contrastRatio(channels(getComputedStyle(element).color), channels(getComputedStyle(surface ?? document.body).backgroundColor));
                });
                expect(contrast, `${theme} ${accent ?? 'default'}`).toBeGreaterThanOrEqual(4.5);
            }
        }

        // Stopping transcribes on this server and adds the text to the draft. Nothing is sent.
        await dictate.click();
        await expect(composer).toHaveValue('Note: Hello from the microphone.');
        await expect(composer).toBeFocused();
        await expect(dictate).toHaveAttribute('aria-label', 'Dictate');
        await expect(dictate).toHaveAttribute('aria-pressed', 'false');
        expect(await microphone()).toEqual({ started: 1, released: 1 });
        expect(requests).toHaveLength(1);
        expect(requests[0].audio).toMatch(/^data:audio\/wav;base64,UklGR/);
        await expect(page.locator('.scratchpad-message')).toHaveCount(0);
        expect(app.provider.calls).toHaveLength(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `${prefix}-text.png` });

        // The service is chosen under Context and remembered on this device.
        await open('context');
        const service = page.locator('#scratchpad-dictation-service');
        await expect(service).toHaveValue('local');
        await expect(service.locator('option')).toHaveText(['This server (Whisper, no key needed)', 'OpenAI', 'Groq', 'Mistral']);
        await service.selectOption('groq');
        await service.scrollIntoViewIfNeeded();
        const boxService = await service.boundingBox();
        expect(boxService.height).toBeGreaterThanOrEqual(phone ? 44 : 30);
        expect(boxService.x + boxService.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `${prefix}-settings.png` });

        // A service with no saved key says so and leaves the draft alone.
        await open('chat');
        await dictate.click();
        await expect(dictate).toHaveAttribute('aria-pressed', 'true');
        await dictate.click();
        await expect(page.locator('#toast-container')).toContainText('No API key is saved for Groq');
        await expect(composer).toHaveValue('Note: Hello from the microphone.');
        await expect(dictate).toHaveAttribute('aria-label', 'Dictate');
        expect(groq).toBe(1);
        expect(await microphone()).toEqual({ started: 2, released: 2 });

        // Closing Scratchpad while recording releases the microphone and transcribes nothing.
        await dictate.click();
        await expect(dictate).toHaveAttribute('aria-pressed', 'true');
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        expect(await microphone()).toEqual({ started: 3, released: 3 });
        expect(groq).toBe(1);

        // Preferences ride on the delayed settings save, so finish it before reloading.
        await page.evaluate(async () => (await import('/script.js')).saveSettings());
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await open('context');
        await expect(service).toHaveValue('groq');
        await open('chat');
        await expect(dictate).toHaveAttribute('aria-label', 'Dictate');
    });
}
