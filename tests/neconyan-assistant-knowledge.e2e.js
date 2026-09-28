/* global document, window */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'default' });
test.setTimeout(120000);
test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' });
});

async function fixture(page, tone = 'dark') {
    let initial = true;
    const requests = [];
    await page.route(/https?:\/\/(?!127\.0\.0\.1(?::|\/))/, route => route.abort());
    await page.route('**/api/settings/get', async route => {
        const envelope = await (await route.fetch()).json();
        const settings = JSON.parse(envelope.settings);
        settings.firstRun = false;
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        if (initial) {
            const { name, ...theme } = JSON.parse(readFileSync(new URL(`../default/content/themes/Neconyan Calico${tone === 'dark' ? ' Dark' : ''}.json`, import.meta.url), 'utf8'));
            Object.assign(settings.power_user, theme, { theme: name });
            initial = false;
        }
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(settings) } });
    });
    await page.route('**/api/backends/chat-completions/status', route => route.fulfill({ json: { data: [{ id: 'help-fixture' }] } }));
    await page.route(/\/api\/backends\/.*\/generate(?:\?|$)/, route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: 'Verified help fixture reply.' }, text: 'Verified help fixture reply.', finish_reason: 'stop' }] } });
    });
    const ready = async () => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.evaluate(async () => !document.getElementById('preloader') && (await import('/script.js')).settingsReady && typeof window.NeconyanShell?.showHome === 'function'), { timeout: 60000 }).toBe(true);
    };
    await ready();
    return { ready, requests };
}

async function assistant(page) {
    await page.evaluate(() => window.NeconyanShell.showHome());
    const picker = page.locator('[data-assistant-personality="miso"]');
    const opening = await picker.evaluateHandle(row => row.closest('[data-assistant-picker]'));
    await picker.locator('input[value="miso-male"]').check();
    await picker.locator('[data-assistant-open]').click();
    await expect.poll(() => page.evaluate(async () => {
        const app = await import('/script.js');
        return app.this_chid !== undefined && app.chat.length > 0 && !app.is_send_press;
    })).toBe(true);
    // Selection publishes the character before its chat and extension events finish.
    await expect.poll(() => opening.evaluate(root => root.dataset.assistantBusy), { timeout: 30000 }).toBe('false');
    await opening.dispose();
    await expect(page.locator('body')).not.toHaveClass(/neconyan-home-visible/, { timeout: 30000 });
}

async function rail(page) {
    if (page.viewportSize().width <= 768) {
        await page.locator('#sb-hamburger').click();
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-drawer-open/);
    }
    return page.locator('#neconyan-workspace-rail');
}

async function dialogue(page) {
    const workspace = await rail(page);
    const tool = workspace.locator('[data-neconyan-native-tool-key="sillytavern-character-colors"]');
    if (!await tool.isVisible()) await workspace.getByText('Included tools', { exact: true }).click();
    if (await tool.getAttribute('open') === null) await tool.locator('summary').click();
    await tool.getByRole('button', { name: 'Settings Dialogue Colors', exact: true }).click();
    await expect(page.locator('#dc-add-name')).toBeVisible();
}

for (const { width, height, tone } of [{ width: 1280, height: 900, tone: 'dark' }, { width: 393, height: 852, tone: 'light' }]) {
    test(`documented colour routes save and reload at ${width}px in ${tone} theme`, async ({ page }, info) => {
        await page.setViewportSize({ width, height });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 768 });
        const { ready } = await fixture(page, tone);
        await assistant(page);
        await dialogue(page);
        const name = `Help ${width} ${Date.now()}`;
        await page.locator('#dc-add-name').fill(name);
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        const row = page.locator('.dc-char').filter({ has: page.getByLabel(`Color for ${name}`, { exact: true }) });
        await row.getByRole('button', { name: 'Edit', exact: true }).click();
        const hex = row.getByRole('textbox', { name: `Hex color for ${name}`, exact: true });
        await hex.fill('#aa3377');
        const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save') && response.ok());
        await hex.press('Tab');
        await saved;
        await expect(hex).toHaveValue('#aa3377');
        const geometry = await row.evaluate(element => ({
            width: element.getBoundingClientRect().width,
            colour: window.getComputedStyle(element.querySelector('.dc-char-name')).color,
            touchPoints: window.navigator.maxTouchPoints,
        }));
        expect(geometry.width).toBeGreaterThan(200);
        expect(geometry.width).toBeLessThanOrEqual(width);
        expect(geometry.colour).toMatch(/^rgb/);
        await info.attach('colour-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath(`dialogue-${width}.png`) });

        await ready();
        await assistant(page);
        await dialogue(page);
        await expect(page.getByLabel(`Color for ${name}`, { exact: true })).toHaveValue('#aa3377');
        const workspace = await rail(page);
        await workspace.locator('[data-neconyan-route="settings"]').click();
        const quote = page.locator('#quote-color-picker');
        if (!await quote.getByRole('button', { name: 'Select Color' }).isVisible()) await page.getByText('Theme Colors', { exact: true }).click();
        await quote.getByRole('button', { name: 'Select Color' }).click();
        const expectedQuote = tone === 'dark' ? 'rgba(170, 187, 204, 1)' : 'rgba(102, 51, 85, 1)';
        await quote.locator('input[data-type="hex"]').fill(tone === 'dark' ? 'AABBCC' : '663355');
        const quoteSaved = page.waitForResponse(response => response.url().endsWith('/api/settings/save') && response.ok());
        await quote.locator('input[data-type="hex"]').press('Tab');
        await quoteSaved;
        await expect.poll(() => page.evaluate(() => window.getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeQuoteColor').trim())).toBe(expectedQuote);
        await ready();
        expect(await page.evaluate(() => window.getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeQuoteColor').trim())).toBe(expectedQuote);
        await cdp.detach();
    });
}

test('normal chat sends shared reference through chat and text completion without function tools', async ({ app }) => {
    test.setTimeout(240000);
    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'Verified help fixture reply.' }, text: 'Verified help fixture reply.', finish_reason: 'stop' }] };
    const account = await app.account({ activeConnection: true });
    const page = await account.open({ workspace: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    const requests = app.provider.calls;
    await assistant(page);
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(app.provider.url);
    await page.locator('#custom_model_id').fill('help-fixture');
    await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        Object.assign(oai_settings, { openai_max_context: 16000, openai_max_tokens: 128, stream_openai: false, function_calling: false });
    });
    await page.locator('#api_button_openai').click();
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).online_status)).not.toBe('no_connection');
    expect(await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }))).toBe(true);
    await page.evaluate(() => window.NeconyanShell.closeWorkspace());
    await page.locator('#send_textarea').fill('How do I change dialogue colours?');
    await page.locator('#send_but').click();
    await expect(page.locator('#chat')).toContainText('Verified help fixture reply.', { timeout: 60000 });
    const chat = requests.find(request => JSON.stringify(request.messages).includes('[Neconyan help reference'));
    expect(chat).toBeTruthy();
    expect(chat.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')).toContain('Included tools → Dialogue Colors → Settings → Characters');
    expect(chat.tools).toBeUndefined();
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption('textgenerationwebui');
    await page.evaluate(async providerUrl => {
        const textgen = await import('/scripts/textgen-settings.js');
        Object.assign(textgen.textgenerationwebui_settings, { type: 'ooba', streaming: false, bypass_status_check: true });
        textgen.textgenerationwebui_settings.server_urls.ooba = providerUrl;
        const context = document.getElementById('max_context');
        context.value = '16000';
        context.dispatchEvent(new Event('input', { bubbles: true }));
        const { power_user } = await import('/scripts/power-user.js');
        power_user.tokenizer = 1;
        await textgen.getStatusTextgen();
        if (!await (await import('/script.js')).saveSettings(0, { returnResult: true })) throw new Error('The text connection was not saved.');
        await (await import('/script.js')).Generate('normal', { suppressUserMessage: true });
    }, app.provider.url);
    const text = requests.find(request => request.prompt?.includes('[Neconyan help reference'));
    expect(text?.prompt).toContain('Included tools → Dialogue Colors → Settings → Characters');
    expect(await page.evaluate(async () => JSON.stringify((await import('/script.js')).chat))).not.toContain('[Neconyan help reference');
});
