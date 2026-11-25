/* global document, getComputedStyle, globalThis, navigator, window, requestAnimationFrame */
/* eslint-disable playwright/no-conditional-in-test -- Phone and desktop, and the baseline capture, share one script. */
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test as base } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before && !process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT) throw new Error('Set NECONYAN_SCRATCHPAD_BASELINE_ROOT for before captures.');
if (before) base.use({ initialServerOptions: { checkoutRoot: process.env.NECONYAN_SCRATCHPAD_BASELINE_ROOT } });
const test = base;

const ACCENTS = [null, 'rgba(110,231,183,1)', 'rgba(126,34,206,1)'];
const reply = text => [{ choices: [{ delta: { content: text } }] }];

// A test browser has no microphone, so the microphone, the level monitor, the recorder and the decoder are stand-ins.
// `globalThis.talkLevel` is how loud the stand-in microphone is.
function installMicrophone() {
    const state = globalThis.talkMicrophone = { started: 0, released: 0, constraints: [], contexts: 0, closed: 0, open: 0 };
    globalThis.talkLevel = 0;
    const mediaDevices = {
        getUserMedia: async constraints => {
            state.constraints.push(constraints);
            state.started += 1;
            state.open += 1;
            let stopped = false;
            return { getTracks: () => [{ stop: () => {
                if (stopped) return;
                stopped = true;
                state.released += 1;
                state.open -= 1;
            } }] };
        },
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => mediaDevices });
    globalThis.MediaRecorder = class {
        constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
        start() { this.state = 'recording'; }
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
    globalThis.AudioContext = class {
        constructor() { state.contexts += 1; this.state = 'running'; }
        async resume() { this.state = 'running'; }
        async suspend() { this.state = 'suspended'; }
        async close() { this.state = 'closed'; state.closed += 1; }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: samples => samples.fill(globalThis.talkLevel) }; }
    };
}

async function settle(page) {
    await page.evaluate(async () => {
        await Promise.all(document.getAnimations()
            .filter(animation => animation instanceof window.CSSTransition)
            .map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function picture(page, name, phone) {
    await fs.mkdir('../screenshots', { recursive: true });
    await page.screenshot({ path: `../screenshots/scratchpad-talk-mode-${name}-${phone ? 'phone' : 'desktop'}-${before ? 'before' : 'after'}.png`,
        style: '#toast-container { visibility: hidden; }' });
}

async function showDictation(page) {
    await page.locator('.scratchpad-dictation').evaluate(section => section.scrollIntoView({ block: 'start' }));
    await settle(page);
}

/** Where the composer row and its controls sit, so a layout change shows up as numbers. */
function composeGeometry(page) {
    return page.evaluate(() => {
        const box = selector => {
            const element = document.querySelector(selector);
            if (!element || !element.getClientRects().length) return null;
            const rect = element.getBoundingClientRect();
            return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        };
        return {
            compose: box('.scratchpad-compose'), row: box('.scratchpad-compose-row'), composer: box('.scratchpad-composer'),
            send: box('.scratchpad-send'), dictate: box('.scratchpad-dictate'), bar: box('.scratchpad-talk'),
            scrollWidth: document.documentElement.scrollWidth,
        };
    });
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Scratchpad talk mode holds a spoken conversation and lets go of the microphone`, async ({ app }) => {
        test.setTimeout(240000);
        const width = phone ? 393 : 1280;
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        await account.context.addInitScript(installMicrophone);
        const page = await account.open();
        const open = async tab => {
            await page.evaluate(async name => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: name }), tab);
            if (phone) await applyIOSOnlyCss(page);
        };
        const microphone = () => page.evaluate(() => globalThis.talkMicrophone);
        const loudness = value => page.evaluate(level => { globalThis.talkLevel = level; }, value);
        const heard = [];
        let transcripts = [];
        await page.route('**/api/speech/recognize', async route => {
            heard.push(route.request().postDataJSON());
            await route.fulfill({ json: { text: transcripts.shift() ?? '' } });
        });

        await open('chat');
        const composer = page.locator('.scratchpad-composer');
        await expect(composer).toBeEnabled();
        await settle(page);
        const idle = await composeGeometry(page);
        expect(idle.scrollWidth).toBeLessThanOrEqual(width);
        await picture(page, 'idle', phone);
        // The baseline has no Talk mode, so it only records the idle composer and Dictation settings to compare against.
        if (before) {
            await open('context');
            await showDictation(page);
            await picture(page, 'settings', phone);
            return;
        }

        const toggle = page.locator('.scratchpad-talk-toggle');
        const bar = page.locator('.scratchpad-talk');
        const status = page.locator('.scratchpad-talk-status');
        const sendNow = bar.getByRole('button', { name: 'Send now', exact: true });
        const interrupt = bar.getByRole('button', { name: 'Interrupt', exact: true });
        const endTalk = bar.getByRole('button', { name: 'End talk', exact: true });

        // Off, the bar takes no space and the row keeps its full-size controls inside the screen.
        await expect(toggle).toHaveAttribute('aria-label', 'Talk mode');
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await expect(bar).toBeHidden();
        expect(idle.bar).toBeNull();
        const toggleBox = await toggle.boundingBox();
        expect(Math.min(toggleBox.width, toggleBox.height)).toBeGreaterThanOrEqual(44);
        expect(toggleBox.x).toBeGreaterThanOrEqual(idle.dictate.x + idle.dictate.width);
        expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(idle.send.x);
        expect(idle.send.x + idle.send.width).toBeLessThanOrEqual(width);
        expect(idle.composer.width).toBeGreaterThanOrEqual(150);

        // The text to speech extension is real, but headless browsers have no voices, so a stand-in records what is spoken.
        await page.evaluate(async () => {
            const { registerExtensionCapability } = await import('/scripts/neconyan-conversation/extension-capabilities.js');
            const spoken = globalThis.talkSpoken = { calls: [], playing: false, stops: 0 };
            registerExtensionCapability('tts', {
                narrateTtsMessage: async message => { spoken.calls.push(message.mes); spoken.playing = true; return true; },
                stopPlayback: () => { spoken.stops += 1; spoken.playing = false; },
                isPlaying: () => spoken.playing,
            });
        });
        const spoken = () => page.evaluate(() => globalThis.talkSpoken);

        // One whole turn: listen, hear, wait out the pause, transcribe, send, read the reply aloud.
        app.provider.mode.streamEvents = reply('The harbour is quiet tonight.');
        transcripts = ['What is the harbour like?'];
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        await expect(bar).toBeVisible();
        await expect(status).toHaveText('Listening…');
        await expect(sendNow).toBeVisible();
        await expect(interrupt).toBeHidden();
        await expect(endTalk).toBeVisible();
        expect(await microphone()).toMatchObject({ started: 1, open: 1, contexts: 1 });
        expect((await microphone()).constraints[0]).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        const listening = await composeGeometry(page);
        expect(listening.bar.y + listening.bar.height).toBeLessThanOrEqual(listening.row.y);
        expect(listening.bar.x + listening.bar.width).toBeLessThanOrEqual(width);
        expect(listening.scrollWidth).toBeLessThanOrEqual(width);
        await loudness(0.2);
        await expect(status).toHaveText('Hearing you…');
        await expect(page.locator('.scratchpad-talk-level')).not.toHaveAttribute('aria-valuenow', '0');
        await picture(page, 'listening', phone);
        await loudness(0);
        await expect(page.locator('.scratchpad-message.is-user')).toContainText('What is the harbour like?');
        await expect(status).toHaveText('Speaking…');
        await expect(interrupt).toBeVisible();
        await expect(sendNow).toBeHidden();
        await expect(page.locator('.scratchpad-message.is-assistant')).toContainText('The harbour is quiet tonight.');
        expect((await spoken()).calls).toEqual(['The harbour is quiet tonight.']);
        expect(heard).toHaveLength(1);
        expect(heard[0].audio).toMatch(/^data:audio\/wav;base64,UklGR/);
        // The microphone was let go before the recording went anywhere, and stays off while the reply is read.
        expect(await microphone()).toMatchObject({ started: 1, released: 1, open: 0 });
        await expect(composer).toHaveValue('');
        await picture(page, 'speaking', phone);

        // The bar, its buttons and the pressed toggle stay readable on the default, a pale and a dark accent.
        const results = [];
        const pickers = ['sb-accent-primary-picker', 'sb-accent-secondary-picker'];
        const original = await page.evaluate(ids => ids.map(id => document.getElementById(id)?.getAttribute('color')), pickers);
        const paint = colours => page.evaluate(({ ids, colours }) => {
            ids.forEach((id, index) => {
                if (colours[index]) document.getElementById(id)?.dispatchEvent(new CustomEvent('change', { detail: { rgba: colours[index] } }));
            });
        }, { ids: pickers, colours });
        for (const accent of ACCENTS) {
            if (accent) await paint([accent, accent]);
            await settle(page);
            const measured = await page.evaluate(async () => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
                const channels = colour => {
                    canvas.clearRect(0, 0, 1, 1);
                    canvas.fillStyle = colour;
                    canvas.fillRect(0, 0, 1, 1);
                    return [...canvas.getImageData(0, 0, 1, 1).data];
                };
                const surface = element => {
                    let node = element;
                    while (node && channels(getComputedStyle(node).backgroundColor)[3] < 255) node = node.parentElement;
                    return getComputedStyle(node ?? document.body).backgroundColor;
                };
                return ['.scratchpad-talk-status', '.scratchpad-talk-interrupt', '.scratchpad-talk-end', '.scratchpad-talk-toggle'].map(selector => {
                    const element = document.querySelector(selector);
                    const ink = element.querySelector('i') ?? element;
                    return { selector, ratio: contrastRatio(channels(getComputedStyle(ink).color).slice(0, 3), channels(surface(element)).slice(0, 3)) };
                });
            });
            for (const item of measured) {
                results.push({ accent, ...item });
                expect(item.ratio, JSON.stringify(results)).toBeGreaterThanOrEqual(4.5);
            }
        }
        await test.info().attach('accent-measurements', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
        await paint(original);
        await settle(page);

        // When the voice finishes, it listens again on a fresh microphone.
        await page.evaluate(() => { globalThis.talkSpoken.playing = false; });
        await expect(status).toHaveText('Listening…');
        expect(await microphone()).toMatchObject({ started: 2, released: 1, open: 1 });

        // Send now ends the turn without waiting for the pause, and Interrupt cuts the voice off and listens again.
        app.provider.mode.streamEvents = reply('Gulls circle the lighthouse.');
        transcripts = ['And the gulls?'];
        await loudness(0.2);
        await expect(status).toHaveText('Hearing you…');
        await sendNow.click();
        await expect(page.locator('.scratchpad-message.is-user').last()).toContainText('And the gulls?');
        await expect(status).toHaveText('Speaking…');
        await loudness(0);
        expect((await spoken()).calls.at(-1)).toBe('Gulls circle the lighthouse.');
        await interrupt.click();
        await expect(status).toHaveText('Listening…');
        expect((await spoken()).stops).toBeGreaterThanOrEqual(1);
        expect(await microphone()).toMatchObject({ started: 3, released: 2, open: 1 });

        // End talk lets go of the microphone and hides the bar, and the composer is back where it was.
        await endTalk.click();
        await expect(bar).toBeHidden();
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        expect(await microphone()).toMatchObject({ released: 3, open: 0, contexts: 1, closed: 1 });
        await settle(page);
        expect(await composeGeometry(page)).toEqual(idle);

        // Hiding the tab ends talk mode at once.
        await toggle.click();
        await expect(status).toHaveText('Listening…');
        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            document.dispatchEvent(new Event('visibilitychange'));
            delete document.hidden;
        });
        await expect(bar).toBeHidden();
        expect(await microphone()).toMatchObject({ open: 0 });

        // Escape ends talk mode and leaves Scratchpad open.
        await toggle.click();
        await expect(status).toHaveText('Listening…');
        await page.keyboard.press('Escape');
        await expect(bar).toBeHidden();
        await expect(composer).toBeVisible();
        expect(await microphone()).toMatchObject({ open: 0 });

        // Closing Scratchpad ends it too, and opening it again starts with talk mode off.
        await toggle.click();
        await expect(status).toHaveText('Listening…');
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        expect(await microphone()).toMatchObject({ open: 0 });
        await open('chat');
        await expect(bar).toBeHidden();
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');

        // Without text to speech it says so once, leaves the reply as text and keeps listening.
        await page.evaluate(async () => {
            const { registerExtensionCapability } = await import('/scripts/neconyan-conversation/extension-capabilities.js');
            registerExtensionCapability('tts', {});
        });
        app.provider.mode.streamEvents = reply('The tide turns at midnight.');
        transcripts = ['When does the tide turn?'];
        const calls = (await spoken()).calls.length;
        await toggle.click();
        await expect(status).toHaveText('Listening…');
        await loudness(0.2);
        await expect(status).toHaveText('Hearing you…');
        await loudness(0);
        await expect(page.locator('.scratchpad-message.is-assistant').last()).toContainText('The tide turns at midnight.');
        await expect(page.locator('#toast-container')).toContainText('Text to speech is off, so replies will appear as text.');
        await expect(status).toHaveText('Listening…');
        expect((await spoken()).calls).toHaveLength(calls);
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'Text to speech is off' })).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await endTalk.click();
        await expect(bar).toBeHidden();
        expect(await microphone()).toMatchObject({ open: 0 });

        // The pause is chosen under Context, beside the transcription service, and remembered.
        await open('context');
        const pause = page.locator('#scratchpad-talk-pause');
        await expect(pause).toHaveValue('normal');
        await expect(pause.locator('option')).toHaveText(['Short (1.0 s)', 'Normal (1.6 s)', 'Patient (2.5 s)']);
        await pause.selectOption('patient');
        await showDictation(page);
        const pauseBox = await pause.boundingBox();
        expect(pauseBox.height).toBeGreaterThanOrEqual(phone ? 44 : 30);
        expect(pauseBox.x + pauseBox.width).toBeLessThanOrEqual(width);
        await picture(page, 'settings', phone);
        await page.evaluate(async () => (await import('/script.js')).saveSettings());
        await page.reload();
        await page.locator('body.neconyan-rail-ready').waitFor();
        await open('context');
        await expect(pause).toHaveValue('patient');
    });
}
