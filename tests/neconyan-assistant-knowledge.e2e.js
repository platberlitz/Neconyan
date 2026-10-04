/* global document, window */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { refreshedKnowledgeCases } from './neconyan-assistant-knowledge-cases.js';
import { fillSource } from './notebooks-browser-fixture.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'default' });
test.setTimeout(120000);
test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'wait' });
});

async function fixture(page, tone, baseURL) {
    let initial = true;
    const requests = [];
    await page.route(/https?:\/\/(?!127\.0\.0\.1(?::|\/))/, route => route.abort());
    await page.route('**/api/settings/get', async route => {
        // Section and extension reads have no full settings document to adjust.
        const body = route.request().postDataJSON() ?? {};
        if (body.extensionSettings || body.sections || body.settingsOnly) return route.continue();
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
        await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
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
    test(`documented colour routes save and reload at ${width}px in ${tone} theme`, async ({ app }, info) => {
        const account = await app.account({ phone: width < 768 });
        const page = await account.context.newPage();
        await page.setViewportSize({ width, height });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 768 });
        const { ready } = await fixture(page, tone, app.url);
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
        for (const [id, label] of [
            ['sb-theme-presets-drawer', 'Custom RGB Accent'],
            ['sb-shell-style-drawer', 'Hide cats (Kittyless)'],
            ['sb-interface-drawer', 'Background Visibility'],
            ['sb-page-tours-drawer', 'Hide all tour buttons'],
        ]) {
            const drawer = page.locator(`#${id}`);
            const control = drawer.getByText(label, { exact: true });
            if (!await control.isVisible()) await drawer.locator(':scope > .inline-drawer-header').click();
            await expect(control).toBeVisible();
            expect(await drawer.evaluate(element => element.parentElement === document.getElementById('sb-theme-presets-drawer').parentElement)).toBe(true);
            await drawer.locator(':scope > .inline-drawer-header').click();
        }
        const accents = page.locator('#sb-theme-presets-drawer');
        await accents.locator(':scope > .inline-drawer-header').click();
        await accents.getByRole('checkbox', { name: 'Custom RGB Accent', exact: true }).check();
        await expect(accents.getByText('Primary Accent', { exact: true })).toBeVisible();
        await expect(accents.getByText('Secondary Accent', { exact: true })).toBeVisible();
        await accents.locator(':scope > .inline-drawer-header').click();
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

for (const phone of [false, true]) {
    test(`documented Notes save and assistant hand-off work on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        test.setTimeout(240000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        const workspace = await rail(page);
        await workspace.locator('[data-neconyan-route="notes"]').click();
        const notes = page.locator('#neconyan-notes');
        await expect(notes).toBeVisible({ timeout: 60000 });
        if (phone) await notes.getByRole('button', { name: 'Notebooks', exact: true }).click();
        await notes.getByRole('button', { name: 'Quick note', exact: true }).first().click();
        const quickNote = page.locator('.popup');
        await quickNote.getByRole('textbox', { name: 'Into the Inbox', exact: true }).fill('Knowledge check\n\nQuick capture.');
        await quickNote.getByRole('button', { name: 'Save to Inbox', exact: true }).click();
        await notes.locator('[data-section="list"] .notes-note-link').filter({ hasText: 'Knowledge check' }).click();
        const text = '# Knowledge check\n\nPlease discuss this draft. [[Another note]]';
        await fillSource(page, text);
        await expect(notes.locator('.notes-status')).toHaveText('Saved on server', { timeout: 15000 });
        await notes.getByRole('button', { name: 'Read', exact: true }).click();
        await expect(notes.getByRole('heading', { name: 'Knowledge check', exact: true })).toBeVisible();
        await notes.getByRole('button', { name: 'Talk about this note', exact: true }).click();
        const dialog = page.locator('.notes-discussion-dialog');
        await dialog.getByRole('button', { name: 'Miso', exact: true }).click();
        await dialog.getByRole('button', { name: 'Neutral', exact: true }).click();
        await dialog.getByRole('button', { name: 'Roleplay', exact: true }).click();
        await page.locator('.popup').getByRole('button', { name: 'Start chat', exact: true }).click();
        await expect(notes).toBeHidden({ timeout: 60000 });
        const composer = page.locator('#send_textarea');
        await expect(composer).toBeVisible();
        await expect(composer).toHaveValue(/Please discuss this draft/);
        expect(await page.evaluate(async () => (await import('/script.js')).chat.filter(message => message.is_user).length)).toBe(0);
        expect(app.provider.calls).toHaveLength(0);
        const geometry = await composer.evaluate(element => ({
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            display: window.getComputedStyle(element).display,
        }));
        expect(geometry.width).toBeGreaterThan(100);
        expect(geometry.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        expect(geometry.height).toBeGreaterThanOrEqual(phone ? 44 : 30);
        await info.attach('note-hand-off-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('note-ready-to-discuss.png') });
    });

    test(`refreshed help loads for all assistants on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(240000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        const references = await page.evaluate(async cases => {
            const { buildAssistantKnowledge } = await import('/scripts/neconyan-assistant-knowledge.js');
            const { KNOWLEDGE_REVISION } = await import('/scripts/neconyan-assistant-knowledge/index.js');
            const results = [];
            for (const name of ['miso', 'taro', 'nori']) {
                for (const variant of ['male', 'female', 'neutral']) {
                    for (const [question, fact] of [
                        ...cases.map(([question, , fact]) => [question, fact]),
                        ['How do I retry failed companions?', 'Successful companions are not rerun'],
                        ['How do I import a SillyBunny persona backup JSON?', 'no picture bytes'],
                        ['Can I try a Vectorization search without a reply?', 'one embedding query'],
                        ['How do I update my source ZIP installation?', 'copy your data folder'],
                        ['How do I activate the relationship tracker?', 'Agents → Manage agents → Browse library'],
                        ['How do I edit the sidebar Quick Actions?', 'Desktop and mobile keep separate lists'],
                        ['How do I start the Nori Presets tour?', 'with a new name keeps the original'],
                        ['Can I hide the message statistics below the avatar?', 'Settings → Appearance → Visual Toggles'],
                        ['Can Mewmory search without an AI selector?', 'ranked results go directly to the memory budget'],
                        ['Can Mewmory use native Vectorization?', 'Use chat retrieval in replies can stay off'],
                        ['Why are Mewmory Data Bank file passages missing?', 'This role may read'],
                        ['Where do I set the E5 query and document prefixes?', 'Trailing spaces and line breaks are preserved'],
                        ['Does Fix trackers repair reordered tracker fields locally?', 'Other repairs, transforms and companion runs may call models'],
                    ]) {
                        const id = `${name}-${variant}`;
                        const reference = await buildAssistantKnowledge({ character: { name: 'Renamed older copy', extensions: { neconyan_assistant: { id, version: 0 } } }, messages: [{ role: 'user', mes: question }] });
                        results.push({ id, question, found: reference.text.includes(fact) });
                    }
                }
            }
            return { revision: KNOWLEDGE_REVISION, results };
        }, refreshedKnowledgeCases);
        expect(references.revision).toBe(11);
        expect(references.results).toHaveLength((13 + refreshedKnowledgeCases.length) * 9);
        expect(references.results.filter(result => !result.found)).toEqual([]);
    });

    test(`documented Relationship Tracker activation works on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        test.setTimeout(240000);
        const account = await app.account({ phone });
        const page = await account.open({ workspace: false });
        const generationRequests = [];
        page.on('request', request => {
            if (/\/generate(?:-quiet)?(?:\?|$)/.test(request.url())) generationRequests.push(request.url());
        });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
        await expect(page.locator('#ica--settings')).toBeVisible();
        await page.getByRole('button', { name: 'Browse library', exact: true }).click();
        await page.getByRole('textbox', { name: 'Search templates', exact: true }).fill('Relationship Tracker');
        const template = page.locator('.ica--template-card[data-id="tpl-relationship-tracker"]');
        await expect(template.getByRole('button', { name: 'Add another', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Close library', exact: true }).click();
        const enabled = page.getByRole('button', { name: 'Enable Relationship Tracker', exact: true });
        await expect(enabled).toHaveAttribute('aria-pressed', 'false');
        await enabled.click();
        await expect(page.getByRole('button', { name: 'Disable Relationship Tracker', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#ica--globalEnabled')).toContainText('Agents On');
        expect(await page.evaluate(async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            return store.getAgents().filter(agent => agent.sourceTemplateId === 'tpl-relationship-tracker')
                .map(agent => ({ name: agent.name, enabled: store.isAgentEnabledForCurrentScope(agent) }));
        })).toEqual([{ name: 'Relationship Tracker', enabled: true }]);
        expect(generationRequests).toEqual([]);
        await page.screenshot({ path: info.outputPath('relationship-tracker-installed.png') });
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
    await page.locator('#send_textarea').fill('How do I use Talk about this note?');
    await page.locator('#send_but').click();
    await expect(page.locator('#chat')).toContainText('Verified help fixture reply.', { timeout: 60000 });
    const chat = requests.find(request => JSON.stringify(request.messages).includes('[Neconyan help reference'));
    expect(chat).toBeTruthy();
    expect(chat.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')).toContain('nothing is sent automatically');
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
    expect(text?.prompt).toContain('nothing is sent automatically');
    expect(await page.evaluate(async () => JSON.stringify((await import('/script.js')).chat))).not.toContain('[Neconyan help reference');
});
