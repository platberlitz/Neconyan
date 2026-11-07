/* global document, window */
// Paragraph Picker regression: with the picker on (paragraphs confirmed) the generation
// must complete exactly like with the picker off, and a provider refusal must be named
// in the toast instead of reported as "returned no text".
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

const TAG_REPLY = '1girl, solo, long hair, smile, outdoors, sunset, masterpiece';
const SCENE_SINGLE = 'Nova stretches under the fading light. Her tail flicks once, twice, and she grins at the horizon.';
const SCENE_MULTI = 'Nova stretches under the fading light.\n\nHer tail flicks once, twice, and she grins at the horizon.\n\nThe wind carries rain over the hills.';

function seedQigSettings(saved, { picker }) {
    saved.extension_settings['quick-image-gen'] = {
        _syncCacheId: randomUUID(),
        provider: 'gptimage', setupWizardSeen: true,
        useLastMessage: true, useLLMPrompt: true, llmPromptStyle: 'tags',
        llmRequestRole: 'user', llmPrefill: '',
        twoStepPrompt: false, appendQuality: false, useSTStyle: false, useWorldInfo: false,
        reviewBeforeGenerate: false, reviewLLMPrompt: false, confirmBeforeGenerate: false,
        autoInsert: false, batchCount: 1,
        llmOverrideEnabled: true, llmOverrideProfileId: 'durable',
        llmOverridePreset: '', llmOverrideMaxTokens: 512, llmOverrideChatDepth: 0,
        llmOverrideTemp: 0.7, llmOverrideSystemPrompt: '',
        enableParagraphPicker: picker,
        gptImageProxyUrl: 'https://image-proxy.example.test/openai/flex/v1',
        gptImageProxyKey: 'fixture-key', gptImageModel: 'gpt-image-2.6-sunburst',
        width: 256, height: 256,
    };
}

async function openChatWithScene(account, { multiParagraph = true } = {}) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async ({ avatar, multiParagraph, single, multi }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        const index = core.characters.findIndex(character => character.avatar === avatar);
        await core.selectCharacterById(index, { switchMenu: false });
        core.chat.push(
            { name: 'User', is_user: true, is_system: false, send_date: Date.now(), mes: 'Show me the scene.', extra: {} },
            { name: 'Durable Nova', is_user: false, is_system: false, send_date: Date.now(),
                mes: multiParagraph ? multi : single, extra: {} },
        );
        await core.saveChatConditional();
    }, { avatar: account.avatar, multiParagraph, single: SCENE_SINGLE, multi: SCENE_MULTI });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
    await page.waitForFunction(() => window.NeconyanExtensions && document.querySelector('#qig-settings'));
    await page.evaluate(() => window.NeconyanExtensions.focusUnit('Quick Image Gen'));
    await expect(page.locator('#qig-settings')).toBeVisible();
    return page;
}

function pageState(page) {
    return page.evaluate(() => ({
        result: !!document.querySelector('#qig-result-img'),
        toasts: [...document.querySelectorAll('.toast')].map(toast => toast.textContent.trim()),
    }));
}

async function readProviderCalls(account, providerUrl) {
    // provider.url is 'http://127.0.0.1:<port>/v1'; the fixture control plane hangs off the same origin.
    const response = await account.context.request.get(providerUrl.replace(/\/v1$/, '') + '/fixture/calls');
    return await response.json();
}

test('picker on: generation completes like the picker off without the empty-prompt toast', async ({ app }, testInfo) => {
    const image = (await readFile(new URL('../public/img/ai4.png', import.meta.url))).toString('base64');
    const provider = app.provider;
    provider.mode.reply = { choices: [{ message: { role: 'assistant', content: TAG_REPLY } }], usage: {} };
    const account = await app.account({ configureSettings(saved) { seedQigSettings(saved, { picker: true }); } });
    await account.context.route('https://image-proxy.example.test/**', route => route.fulfill({ json: {
        object: 'response', status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: image }],
    } }));
    const page = await openChatWithScene(account, { multiParagraph: true });
    await page.locator('#qig-generate-btn').click();
    await expect(page.locator('#qig-paragraph-picker-popup')).toBeVisible({ timeout: 15000 });
    await page.locator('#qig-para-use').click();
    await expect.poll(async () => (await pageState(page)).result, { timeout: 90000 }).toBe(true);
    const state = await pageState(page);
    expect(state.toasts.join(' ')).not.toContain('returned no text');
    const calls = await readProviderCalls(account, provider.url);
    const overrideCalls = calls.filter(call => String(call.url).endsWith('/chat/completions'));
    expect(overrideCalls).toHaveLength(1);
    expect(overrideCalls[0].messages).toHaveLength(1);
    const instruction = String(overrideCalls[0].messages[0].content);
    expect(instruction).toContain('STANDALONE IMAGE GENERATION TASK');
    expect(instruction).toContain('Nova stretches under the fading light');
    await testInfo.attach('picker-on-instruction', { body: instruction, contentType: 'text/plain' });
});

test('picker off: the same scene generation completes without toast', async ({ app }, testInfo) => {
    const image = (await readFile(new URL('../public/img/ai4.png', import.meta.url))).toString('base64');
    const provider = app.provider;
    provider.mode.reply = { choices: [{ message: { role: 'assistant', content: TAG_REPLY } }], usage: {} };
    const account = await app.account({ configureSettings(saved) { seedQigSettings(saved, { picker: false }); } });
    await account.context.route('https://image-proxy.example.test/**', route => route.fulfill({ json: {
        object: 'response', status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: image }],
    } }));
    const page = await openChatWithScene(account, { multiParagraph: true });
    await page.locator('#qig-generate-btn').click();
    await expect.poll(async () => (await pageState(page)).result, { timeout: 90000 }).toBe(true);
    const state = await pageState(page);
    expect(state.toasts.join(' ')).not.toContain('returned no text');
    const calls = await readProviderCalls(account, provider.url);
    const overrideCalls = calls.filter(call => String(call.url).endsWith('/chat/completions'));
    expect(overrideCalls).toHaveLength(1);
    const instruction = String(overrideCalls[0].messages[0].content);
    await testInfo.attach('picker-off-instruction', { body: instruction, contentType: 'text/plain' });
});

test('picker on with an empty override reply keeps the generic fallback toast', async ({ app }) => {
    const image = (await readFile(new URL('../public/img/ai4.png', import.meta.url))).toString('base64');
    const provider = app.provider;
    provider.mode.reply = { choices: [{ message: { role: 'assistant', content: '' } }], usage: {} };
    const account = await app.account({ configureSettings(saved) { seedQigSettings(saved, { picker: true }); } });
    await account.context.route('https://image-proxy.example.test/**', route => route.fulfill({ json: {
        object: 'response', status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: image }],
    } }));
    const page = await openChatWithScene(account, { multiParagraph: true });
    await page.locator('#qig-generate-btn').click();
    await expect(page.locator('#qig-paragraph-picker-popup')).toBeVisible({ timeout: 15000 });
    await page.locator('#qig-para-use').click();
    await expect.poll(async () => {
        const state = await pageState(page);
        return state.toasts.some(toast => toast.includes('returned no text'));
    }, { timeout: 90000 }).toBe(true);
    const state = await pageState(page);
    expect(state.toasts.join(' ')).toContain('LLM Override returned no text, so the raw prompt was used');
});

async function captureRefusalToast({ app, testInfo, phone }) {
    const image = (await readFile(new URL('../public/img/ai4.png', import.meta.url))).toString('base64');
    const provider = app.provider;
    provider.mode.reply = { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'prohibited_content' }], usage: {} };
    const account = await app.account({ phone, configureSettings(saved) { seedQigSettings(saved, { picker: true }); } });
    await account.context.route('https://image-proxy.example.test/**', route => route.fulfill({ json: {
        object: 'response', status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: image }],
    } }));
    const page = await openChatWithScene(account, { multiParagraph: true });
    await page.locator('#qig-generate-btn').click();
    await expect(page.locator('#qig-paragraph-picker-popup')).toBeVisible({ timeout: 15000 });
    await page.locator('#qig-para-use').click();
    await expect.poll(async () => {
        const state = await pageState(page);
        return state.toasts.some(toast => toast.includes('refused this request on a content filter'));
    }, { timeout: 90000 }).toBe(true);
    const state = await pageState(page);
    expect(state.toasts.join(' ')).toContain('The separate AI profile\'s model refused this request on a content filter (prohibited_content)');
    const toast = page.locator('.toast-warning').first();
    const shot = await toast.screenshot();
    if (testInfo) await testInfo.attach('refused-toast', { body: shot, contentType: 'image/png' });
    return shot;
}

test('picker on with a refused override reply names the content filter in the toast (desktop)', async ({ app }, testInfo) => {
    const shot = await captureRefusalToast({ app, testInfo, phone: false });
    const fs = await import('node:fs/promises');
    await fs.mkdir(new URL('../screenshots/', import.meta.url), { recursive: true });
    await fs.writeFile(new URL('../screenshots/qig-refused-toast-desktop-after.png', import.meta.url), shot);
});

test('picker on with a refused override reply names the content filter in the toast (phone)', async ({ app }, testInfo) => {
    const shot = await captureRefusalToast({ app, testInfo, phone: true });
    const fs = await import('node:fs/promises');
    await fs.writeFile(new URL('../screenshots/qig-refused-toast-phone-after.png', import.meta.url), shot);
});
