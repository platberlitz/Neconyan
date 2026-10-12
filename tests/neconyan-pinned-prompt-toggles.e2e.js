/* global document, window, getComputedStyle */
/* eslint-disable playwright/no-skipped-test -- The same suite has explicit clean-staging capture and feature-checkout modes. */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';

const screenshots = fileURLToPath(new URL('../screenshots/', import.meta.url));
const baseline = process.env.NECONYAN_PINNED_BASELINE === '1';
const baselineRoot = process.env.NECONYAN_PINNED_BASELINE_ROOT;
const recordScreenshots = process.env.NECONYAN_PINNED_SCREENSHOTS === '1';
test.use({ initialServerOptions: baseline && baselineRoot ? { checkoutRoot: path.resolve(baselineRoot) } : {} });
test.setTimeout(300000);

async function capture(page, name, selector) {
    if (!recordScreenshots) return;
    await fs.mkdir(screenshots, { recursive: true });
    await (selector ? page.locator(selector) : page).screenshot({ path: path.join(screenshots, name) });
}

async function recordGeometry(page, name) {
    if (!recordScreenshots) return;
    await fs.mkdir(screenshots, { recursive: true });
    await fs.writeFile(path.join(screenshots, name), JSON.stringify(await geometrySnapshot(page), null, 2));
}

async function openRoleplay(account) {
    const page = await account.open({ workspace: false });
    await selectRoleplay(page, account.avatar);
    return page;
}

async function selectRoleplay(page, avatar) {
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, avatar);
    await expect(page.locator('#send_textarea')).toBeVisible();
}

async function openPrompts(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
    const invitation = page.getByRole('button', { name: 'Not now', exact: true });
    if (await invitation.isVisible()) await invitation.click();
    await page.getByRole('tab', { name: 'Prompts', exact: false }).click();
    await expect(page.locator('#completion_prompt_manager')).toBeVisible();
    if (!await page.locator('#completion_prompt_manager_list').isVisible()) await page.locator('#completion_prompt_manager .inline-drawer-toggle').first().click();
    await expect(page.locator('#completion_prompt_manager_list')).toBeVisible();
    await page.locator('#completion_prompt_manager_drawer').evaluate(node => node.scrollIntoView({ block: 'start' }));
}

async function seededAccount(app, phone = false) {
    let preset;
    const account = await app.account({ phone, activeConnection: true, configureSettings: settings => {
        const remaining = settings.oai_settings.prompts.filter(prompt => !['pin-a', 'pin-b'].includes(prompt.identifier));
        const prompts = [{ identifier: 'pin-a', name: 'NSFW', role: 'system', system_prompt: false, content: 'PINNED_FIXTURE_A {{setvar::pinnedMode::on}}', injection_position: 0 },
            { identifier: 'pin-b', name: 'Gooner mode', role: 'system', system_prompt: false, content: 'PINNED_FIXTURE_B', injection_position: 0 }, ...remaining];
        Object.assign(settings.oai_settings, { prompts, preset_settings_openai: 'Pinned fixture A', bind_preset_to_connection: false,
            prompt_order: [{ character_id: 100001, order: prompts.map(prompt => ({ identifier: prompt.identifier, enabled: ['pin-a', 'chatHistory'].includes(prompt.identifier) })) }],
            extensions: { other_fixture: { keep: true } }, squash_system_messages: false, new_chat_prompt: '', names_behavior: -1, send_if_empty: '', custom_prompt_post_processing: '' });
        settings.extension_settings.note.default = '';
        settings.extension_settings.disabledExtensions.push('third-party/sillytavern-character-colors');
        preset = structuredClone(settings.oai_settings);
    } });
    await account.post('/api/presets/save', { apiId: 'openai', name: 'Pinned fixture A', preset });
    const second = structuredClone(preset);
    second.prompts.find(prompt => prompt.identifier === 'pin-a').name = 'Other preset toggle';
    second.prompt_order[0].order.find(entry => entry.identifier === 'pin-a').enabled = false;
    await account.post('/api/presets/save', { apiId: 'openai', name: 'Pinned fixture B', preset: second });
    return account;
}

const promptRow = (page, id) => page.locator(`#completion_prompt_manager_list [data-pm-identifier="${id}"]`);
const dockRow = (page, id) => page.locator(`#neconyan-pinned-prompts [data-prompt-identifier="${id}"]`);
async function pin(page, id) {
    await promptRow(page, id).locator('.prompt-manager-pin-action').click();
    await expect(promptRow(page, id).locator('.prompt-manager-pin-action')).toBeEnabled();
}
async function chat(page) {
    await page.locator('#left-nav-panel .sb-shell-close').click();
    await expect(page.locator('#send_textarea')).toBeVisible();
}
async function flush(page) {
    expect(await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }))).toBe(true);
}

async function geometrySnapshot(page) {
    return page.evaluate(() => Object.fromEntries(['sheld', 'chat', 'send_form', 'send_but'].map(id => {
        const node = document.getElementById(id);
        const rect = node.getBoundingClientRect();
        return [id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
    })));
}

async function assertSwitchAppearance(page) {
    const measured = await page.evaluate(() => {
        const canvas = document.createElement('canvas').getContext('2d');
        const rgb = colour => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = colour; canvas.fillRect(0, 0, 1, 1); return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        return ['pin-a', 'pin-b'].map(id => {
            const button = document.querySelector(`[data-pm-identifier="${id}"] .prompt-manager-toggle-action`);
            const style = getComputedStyle(button);
            return { id, colour: rgb(style.color), expected: rgb(id === 'pin-a' ? getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeQuoteColor') : getComputedStyle(button.parentElement).color),
                background: style.backgroundColor, border: style.borderTopWidth, padding: style.padding, opacity: Number(style.opacity), font: style.fontFamily };
        });
    });
    measured.forEach(value => {
        expect(value.colour, JSON.stringify(measured)).toEqual(value.expected);
        expect(value.background).toBe('rgba(0, 0, 0, 0)');
        expect(value.border).toBe('0px');
        expect(value.padding).toBe('0px');
        expect(value.font).toContain('Font Awesome');
    });
    expect(measured[1].opacity).toBeLessThan(1);
    console.log('PROMPT_SWITCH_APPEARANCE ' + JSON.stringify(measured));
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} before screenshots`, async ({ app }) => {
        test.skip(!baseline || !baselineRoot || !recordScreenshots, 'Explicit baseline root and screenshot flags are required');
        const account = await seededAccount(app, phone);
        const page = await openRoleplay(account);
        await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
        await expect(page.locator('#toast-container')).toBeHidden({ timeout: 15000 });
        await recordGeometry(page, `${phone ? 'phone' : 'desktop'}-geometry-before.json`);
        await capture(page, `${phone ? 'phone' : 'desktop'}-chat-before.png`);
        await openPrompts(page);
        await expect(page.locator('#completion_prompt_manager_list [data-pm-identifier="pin-a"]')).toBeVisible();
        await capture(page, `${phone ? 'phone' : 'desktop'}-prompts-before.png`);
        console.log(JSON.stringify({ baseline: phone ? 'phone' : 'desktop', geometry: await page.locator('#sheld').evaluate(node => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x, width: rect.width, height: rect.height };
        }) }));
        await page.reload();
        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
        await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
    });
}

test('desktop pins, live switches, reload, collapse, preset isolation, requests and empty-space removal', async ({ app }) => {
    test.skip(baseline, 'Feature checkout only');
    const account = await seededAccount(app);
    const page = await openRoleplay(account);
    await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
    await openPrompts(page);
    await pin(page, 'pin-a');
    await pin(page, 'pin-b');
    await expect(promptRow(page, 'pin-a').locator('.prompt-manager-pin-action')).toHaveAttribute('aria-pressed', 'true');
    await assertSwitchAppearance(page);
    await capture(page, 'desktop-prompts-after.png');
    await capture(page, 'desktop-prompts-switches-closeup-after.png', '#completion_prompt_manager_list');
    await chat(page);
    await expect(page.locator('#sheld')).toHaveAttribute('data-neconyan-chat-widgets', 'side');
    await expect(dockRow(page, 'pin-a')).toHaveAttribute('aria-checked', 'true');
    await expect(dockRow(page, 'pin-b')).toHaveAttribute('aria-checked', 'false');
    await dockRow(page, 'pin-b').click();
    await expect(promptRow(page, 'pin-b').locator('.prompt-manager-toggle-action')).toHaveAttribute('aria-checked', 'true');
    await openPrompts(page);
    await promptRow(page, 'pin-b').locator('.prompt-manager-toggle-action').click();
    await expect(dockRow(page, 'pin-b')).toHaveAttribute('aria-checked', 'false');
    await chat(page);
    const geometry = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return { host: rect('#sheld'), dock: rect('#neconyan-chat-widgets'), chat: rect('#chat'), composer: rect('#send_form'), send: rect('#send_but') };
    });
    console.log('DESKTOP_GEOMETRY ' + JSON.stringify(geometry));
    expect(geometry.dock.width).toBe(208);
    expect(geometry.chat.right).toBeLessThanOrEqual(geometry.dock.x);
    expect(geometry.composer.right).toBeLessThanOrEqual(geometry.dock.x);
    expect(geometry.send.bottom).toBeLessThanOrEqual(900);
    await capture(page, 'desktop-chat-after.png');
    const chatStyle = await page.locator('#chat_display').inputValue();
    await page.locator('#chat_display').evaluate(node => { node.value = '5'; node.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(page.locator('body')).toHaveClass(/hushstyle/);
    await expect(dockRow(page, 'pin-a')).toBeVisible();
    expect(await page.locator('#chat').evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(geometry.dock.x);
    await capture(page, 'desktop-hush-chat-after.png');
    await page.locator('#chat_display').evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }, chatStyle);
    await flush(page);
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
    await selectRoleplay(page, account.avatar);
    await expect(dockRow(page, 'pin-a')).toBeVisible();
    await page.locator('.nn-pinned-collapse').click();
    await expect(page.locator('#sheld')).toHaveAttribute('data-neconyan-chat-widgets', 'collapsed');
    expect((await page.locator('#neconyan-chat-widgets').boundingBox()).height).toBe(44);
    await flush(page);
    await page.reload();
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
    await selectRoleplay(page, account.avatar);
    await expect(page.locator('.nn-pinned-collapse')).toHaveAttribute('aria-expanded', 'false');
    expect(await page.locator('#sheld').evaluate(node => getComputedStyle(node).paddingRight)).toBe('0px');
    await page.locator('.nn-pinned-collapse').click();
    app.provider.mode.hold = 'conversation-fixture';
    await page.locator('#send_textarea').fill('Pinned on request');
    await page.locator('#send_but').click();
    await expect.poll(() => app.provider.calls.length, { timeout: 60000 }).toBe(1);
    await page.evaluate(() => window.SillyTavern.getContext().promptManager.handleCharacterUpdated({ detail: { id: 0, character: { name: 'Updated fixture card' } } }));
    await openPrompts(page);
    await promptRow(page, 'pin-b').locator('.prompt-manager-toggle-action').click();
    await expect(promptRow(page, 'pin-b').locator('.prompt-manager-toggle-action')).toHaveAttribute('aria-checked', 'true');
    await expect(dockRow(page, 'pin-b')).toHaveAttribute('aria-checked', 'true');
    await chat(page);
    await dockRow(page, 'pin-b').click();
    await app.release();
    await expect(page.locator('#chat .mes').last()).toContainText('Durable first reply.', { timeout: 60000 });
    expect(app.provider.calls).toHaveLength(1);
    expect(app.provider.calls[0].messages.some(message => message.content.includes('PINNED_FIXTURE_A'))).toBe(true);
    await page.evaluate(async () => (await import('/scripts/variables.js')).setLocalVariable('pinnedMode', 'on'));
    expect(await page.evaluate(() => window.SillyTavern.getContext().chatMetadata.variables.pinnedMode)).toBe('on');
    await dockRow(page, 'pin-a').click();
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chatMetadata.variables?.pinnedMode)).toBeUndefined();
    await flush(page);
    await page.locator('#send_textarea').fill('Pinned off request');
    await page.locator('#send_but').click();
    await expect.poll(() => app.provider.calls.length, { timeout: 60000 }).toBe(2);
    expect(app.provider.calls[1].messages.some(message => message.content.includes('PINNED_FIXTURE_A'))).toBe(false);
    await expect(page.locator('#chat .mes').last()).toContainText('Durable first reply.');
    await openPrompts(page);
    await page.locator('#settings_preset_openai').selectOption({ label: 'Pinned fixture B' });
    await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
    await page.locator('#settings_preset_openai').selectOption({ label: 'Pinned fixture A' });
    await expect(dockRow(page, 'pin-a')).toHaveAttribute('aria-checked', 'true');
    await expect(promptRow(page, 'pin-a').locator('.prompt-manager-pin-action')).toHaveAttribute('aria-pressed', 'true');
    await pin(page, 'pin-a');
    await pin(page, 'pin-b');
    await chat(page);
    await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
    await expect(page.locator('#sheld')).not.toHaveAttribute('data-neconyan-chat-widgets');
    expect(await page.locator('#sheld').evaluate(node => getComputedStyle(node).paddingRight)).toBe('0px');
});

test('phone has no dock or space, and a labelled 44px pin does not edit or toggle the prompt', async ({ app }) => {
    test.skip(baseline, 'Feature checkout only');
    const account = await seededAccount(app, true);
    const page = await openRoleplay(account);
    await expect(page.locator('#toast-container')).toBeHidden({ timeout: 15000 });
    await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
    const geometry = await page.locator('#sheld').evaluate(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, x: r.x, padding: getComputedStyle(node).paddingRight }; });
    console.log('PHONE_GEOMETRY ' + JSON.stringify(geometry));
    expect(geometry).toEqual({ width: 393, height: 809, x: 0, padding: '0px' });
    await recordGeometry(page, 'phone-geometry-after.json');
    await capture(page, 'phone-chat-after.png');
    await openPrompts(page);
    await expect(page.locator('.prompt-manager-pin-note')).toBeHidden();
    await assertSwitchAppearance(page);
    const button = promptRow(page, 'pin-a').locator('.prompt-manager-pin-action');
    await expect(button).toHaveAccessibleName('Pin NSFW to chat');
    const bounds = await button.boundingBox();
    console.log('PHONE_PIN ' + JSON.stringify(bounds));
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    await button.tap();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('Pinned');
    await expect(promptRow(page, 'pin-a').locator('.prompt-manager-toggle-action')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#completion_prompt_manager_popup')).toBeHidden();
    await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
    await capture(page, 'phone-prompts-after.png');
    const colours = [];
    for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
        await page.locator('#themes').evaluate((node, name) => { node.value = name; node.dispatchEvent(new Event('change', { bubbles: true })); }, theme);
        for (const accent of ['default', 'Mint Glass', 'Plum Wine']) {
            if (accent !== 'default') await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(node => node.click());
            const ratio = await button.evaluate(async node => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas').getContext('2d');
                const channels = colour => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = colour; canvas.fillRect(0, 0, 1, 1); return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3); };
                return contrastRatio(channels(getComputedStyle(node.querySelector('small')).color), channels(getComputedStyle(node).backgroundColor));
            });
            colours.push({ theme, accent, ratio });
            expect(ratio, JSON.stringify(colours)).toBeGreaterThanOrEqual(4.5);
        }
    }
    console.log('PHONE_ACCENT_CONTRAST ' + JSON.stringify(colours));
    await chat(page);
    await page.setViewportSize({ width: 768, height: 852 });
    await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
});

test('desktop accents, keyboard, narrow-host fallback, modes, long list, rename and full import', async ({ app }, info) => {
    test.skip(baseline, 'Feature checkout only');
    const account = await seededAccount(app);
    const page = await openRoleplay(account);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log('PINNED_NAVIGATION ' + frame.url()); });
    page.on('pageerror', error => console.log('PINNED_PAGE_ERROR ' + error.message));
    await openPrompts(page);
    const dragLock = page.locator('#completion_prompt_manager_drag_lock');
    if (await dragLock.getAttribute('aria-pressed') === 'true') await dragLock.click();
    await expect(dragLock).toHaveAttribute('aria-pressed', 'false');
    const orderBeforePins = await page.evaluate(() => window.SillyTavern.getContext().promptManager.getPromptOrderForCharacter(window.SillyTavern.getContext().promptManager.activeCharacter).map(entry => entry.identifier));
    const pinButton = promptRow(page, 'pin-a').locator('.prompt-manager-pin-action');
    await pinButton.focus();
    await page.keyboard.press('Space');
    await expect(pinButton).toHaveAttribute('aria-pressed', 'true');
    await expect(pinButton).toBeEnabled();
    await expect(pinButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pinButton).toHaveAttribute('aria-pressed', 'false');
    await expect(pinButton).toBeEnabled();
    await expect(pinButton).toBeFocused();
    await pin(page, 'pin-a'); await pin(page, 'pin-b');
    expect(await page.evaluate(() => window.SillyTavern.getContext().promptManager.getPromptOrderForCharacter(window.SillyTavern.getContext().promptManager.activeCharacter).map(entry => entry.identifier))).toEqual(orderBeforePins);
    await page.evaluate(() => {
        const list = document.getElementById('completion_prompt_manager_list');
        list.insertBefore(list.querySelector('[data-pm-identifier="pin-b"]'), list.querySelector('[data-pm-identifier="pin-a"]'));
        window.jQuery(list).sortable('option', 'update')({}, null);
    });
    await expect(page.locator('.nn-pinned-switch').first()).toHaveAttribute('data-prompt-identifier', 'pin-b');
    await promptRow(page, 'pin-a').locator('.prompt-manager-toggle-action').click();
    await expect(dockRow(page, 'pin-a')).toHaveAttribute('aria-checked', 'false');
    await promptRow(page, 'pin-a').locator('.prompt-manager-toggle-action').click();
    await expect(dockRow(page, 'pin-a')).toHaveAttribute('aria-checked', 'true');
    await chat(page);
    await dockRow(page, 'pin-a').focus();
    await page.keyboard.press('Space');
    await expect(dockRow(page, 'pin-a')).toHaveAttribute('aria-checked', 'false');
    await expect(dockRow(page, 'pin-a')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dockRow(page, 'pin-a')).toHaveAttribute('aria-checked', 'true');
    await expect(dockRow(page, 'pin-a')).toHaveAttribute('role', 'switch');
    const colours = [];
    for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
        await page.locator('#themes').evaluate((node, name) => { node.value = name; node.dispatchEvent(new Event('change', { bubbles: true })); }, theme);
        for (const accent of ['default', 'Mint Glass', 'Plum Wine']) {
            if (accent !== 'default') await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(node => node.click());
            if (accent !== 'default') {
                await expect(page.locator('html')).toHaveAttribute('data-neconyan-accent', 'custom');
                await expect.poll(() => page.locator('.nn-pinned-switch[aria-checked="true"] .nn-pinned-state').evaluate(node => getComputedStyle(node).backgroundColor))
                    .toBe(accent === 'Mint Glass' ? 'rgb(110, 231, 183)' : 'rgb(126, 34, 206)');
            }
            const measurements = await page.evaluate(async () => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas').getContext('2d');
                const channels = colour => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = colour; canvas.fillRect(0, 0, 1, 1); return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3); };
                const background = node => {
                    const ancestors = [];
                    while (node) { ancestors.unshift(node); node = node.parentElement; }
                    canvas.clearRect(0, 0, 1, 1);
                    canvas.fillStyle = getComputedStyle(document.body).getPropertyValue('--neco-surface');
                    canvas.fillRect(0, 0, 1, 1);
                    ancestors.forEach(ancestor => { canvas.fillStyle = getComputedStyle(ancestor).backgroundColor; canvas.fillRect(0, 0, 1, 1); });
                    return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
                };
                return [...document.querySelectorAll('.nn-pinned-switch, .nn-pinned-state, .prompt-manager-pin-action[aria-pressed="true"]')].map(node => {
                    const style = getComputedStyle(node);
                    const adjacent = background(node.parentElement);
                    const iconOnly = node.classList.contains('prompt-manager-pin-action');
                    return { selector: node.className, iconOnly, label: contrastRatio(channels(style.color), background(node)), boundary: iconOnly ? contrastRatio(channels(style.color), background(node)) : Math.max(contrastRatio(channels(style.borderColor), adjacent), contrastRatio(channels(style.backgroundColor), adjacent)),
                        color: style.color, background: style.backgroundColor };
                });
            });
            colours.push({ theme, accent, measurements });
            measurements.forEach(measured => expect(measured.label, JSON.stringify(colours)).toBeGreaterThanOrEqual(measured.iconOnly ? 3 : 4.5));
            measurements.forEach(measured => expect(measured.boundary, JSON.stringify(colours)).toBeGreaterThanOrEqual(3));
        }
    }
    console.log('ACCENT_CONTRAST ' + JSON.stringify(colours));
    await info.attach('accent-contrast', { body: JSON.stringify(colours, null, 2), contentType: 'application/json' });
    for (const width of [1044, 1043, 769, 768, 769, 1044, 1043, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        if (width === 768) await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
        else {
            const layout = width - 244 >= 800 ? 'side' : 'stacked';
            await expect(page.locator('#sheld')).toHaveAttribute('data-neconyan-chat-widgets', layout);
            const geometry = await page.evaluate(() => {
                const box = document.querySelector('#neconyan-chat-widgets').getBoundingClientRect();
                const chat = document.querySelector('#chat').getBoundingClientRect();
                const send = document.querySelector('#send_but').getBoundingClientRect();
                return { dockBottom: box.bottom, chatTop: chat.top, chatHeight: chat.height, sendBottom: send.bottom };
            });
            if (layout === 'stacked') expect(geometry.dockBottom).toBeLessThanOrEqual(geometry.chatTop);
            expect(geometry.chatHeight).toBeGreaterThan(100);
            expect(geometry.sendBottom).toBeLessThanOrEqual(900);
        }
    }
    for (const hiddenClass of ['neconyan-home-visible', 'sbterm']) {
        await page.evaluate(name => document.body.classList.add(name), hiddenClass);
        await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
        await page.evaluate(name => document.body.classList.remove(name), hiddenClass);
        await expect(dockRow(page, 'pin-a')).toBeVisible();
    }
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('#sheld')).toHaveAttribute('data-neconyan-chat-widgets', 'stacked');
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
    await expect(page.locator('#sheld')).toHaveAttribute('data-neconyan-chat-widgets', 'side');
    await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).openNotes({ layout: 'beside' }));
    await expect(page.locator('#sheld')).toHaveAttribute('data-neconyan-chat-widgets', 'stacked');
    await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).hideNotes());
    await expect(page.locator('#sheld')).toHaveAttribute('data-neconyan-chat-widgets', 'side');
    for (const theme of ['windows-98', 'windows-xp', 'kittyless', 'calico']) {
        await page.evaluate(theme => window.NeconyanShell.applyTheme(theme), theme);
        await expect(page.locator('html')).toHaveAttribute('data-sb-theme', theme);
        await expect(dockRow(page, 'pin-a')).toBeVisible();
        await expect(dockRow(page, 'pin-a')).toHaveAttribute('role', 'switch');
    }
    await page.evaluate(async () => {
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        await getPresetManager('openai').renamePreset('Pinned renamed fixture');
    });
    await expect(page.locator('.nn-pinned-preset')).toHaveText('Pinned renamed fixture');
    const fullPreset = await page.evaluate(async () => (await import('/scripts/preset-manager.js')).getPresetManager('openai').getPresetSettings('Pinned renamed fixture'));
    expect(fullPreset.extensions.neconyan_pinned_prompts.identifiers).toEqual(['pin-a', 'pin-b']);
    await openPrompts(page);
    const downloading = page.waitForEvent('download');
    await page.locator('#export_oai_preset').click();
    await page.locator('dialog.popup .popup-button-ok').click();
    const exported = JSON.parse(await fs.readFile(await (await downloading).path(), 'utf8'));
    expect(exported.extensions.neconyan_pinned_prompts.identifiers).toEqual(['pin-a', 'pin-b']);
    await chat(page);
    await page.locator('#openai_preset_import_file').setInputFiles({ name: 'Pinned imported fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await expect(page.locator('.nn-pinned-preset')).toHaveText('Pinned imported fixture');
    await expect(dockRow(page, 'pin-a')).toBeVisible();
    const savedLong = page.waitForResponse(response => response.url().endsWith('/api/presets/save') && response.request().postDataJSON().name === 'Pinned long fixture');
    await page.evaluate(async () => {
        const { promptManager: manager } = await import('/scripts/openai.js');
        for (let index = 0; index < 16; index++) {
            const identifier = 'long-' + index;
            manager.serviceSettings.prompts.push({ identifier, name: 'A long prompt name with enough words to wrap ' + index, role: 'system', system_prompt: false, content: 'Long', injection_position: 0 });
            manager.getPromptOrderForCharacter(manager.activeCharacter).push({ identifier, enabled: index % 2 === 0 });
            manager.serviceSettings.extensions.neconyan_pinned_prompts.identifiers.push(identifier);
        }
        void (await import('/scripts/preset-manager.js')).getPresetManager('openai').savePreset('Pinned long fixture');
    });
    expect((await savedLong).ok()).toBe(true);
    await expect(page.locator('.nn-pinned-switch')).toHaveCount(18);
    expect(await page.locator('.nn-pinned-list').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect(page.locator('#send_but')).toBeVisible();
    await capture(page, 'desktop-long-pins-after.png');
    expect(app.provider.calls).toHaveLength(0);
});

test('preset saving and selection intervals reject old scopes, and actual modes and main APIs hide the dock', async ({ app }) => {
    test.skip(baseline, 'Feature checkout only');
    const account = await seededAccount(app);
    const page = await openRoleplay(account);
    await openPrompts(page);
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let held = false;
    await page.route('**/api/presets/save', async route => {
        if (route.request().postDataJSON().name === 'Pinned fixture A') { held = true; await barrier; }
        await route.continue();
    });
    await promptRow(page, 'pin-a').locator('.prompt-manager-pin-action').click();
    await expect.poll(() => held).toBe(true);
    await expect(promptRow(page, 'pin-a').locator('.prompt-manager-pin-action')).toBeDisabled();
    await page.locator('#settings_preset_openai').selectOption({ label: 'Pinned fixture B' });
    await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
    await page.locator('#settings_preset_openai').selectOption({ label: 'Pinned fixture A' });
    release();
    await expect(promptRow(page, 'pin-a').locator('.prompt-manager-pin-action')).toBeEnabled();
    await expect(promptRow(page, 'pin-a').locator('.prompt-manager-pin-action')).toHaveAttribute('aria-pressed', 'true');
    await page.unroute('**/api/presets/save');
    await chat(page);
    await expect(dockRow(page, 'pin-a')).toBeVisible();
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        let release;
        window.fixturePresetBarrier = new Promise(resolve => { release = resolve; });
        window.fixtureReleasePreset = release;
        window.fixturePresetListener = () => window.fixturePresetBarrier;
        eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, window.fixturePresetListener);
        const manager = getPresetManager('openai');
        window.fixturePresetChanging = manager.selectPreset(manager.findPreset('Pinned fixture B'));
    });
    await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
    await page.evaluate(async () => {
        window.fixtureReleasePreset();
        await window.fixturePresetChanging;
        const { eventSource, event_types } = await import('/scripts/events.js');
        eventSource.removeListener(event_types.OAI_PRESET_CHANGED_BEFORE, window.fixturePresetListener);
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        const manager = getPresetManager('openai');
        await manager.selectPreset(manager.findPreset('Pinned fixture A'));
    });
    await expect(dockRow(page, 'pin-a')).toBeVisible();
    await page.locator('#main_api').evaluate(node => { node.value = 'textgenerationwebui'; node.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
    await page.locator('#main_api').evaluate(node => { node.value = 'openai'; node.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(dockRow(page, 'pin-a')).toBeVisible();
    for (const mode of ['conversation', 'meower', 'story']) {
        await page.evaluate(mode => window.NeconyanShell.activateMode(mode), mode);
        await expect(page.locator('#neconyan-chat-widgets')).toHaveCount(0);
        await page.evaluate(() => window.NeconyanShell.activateMode('roleplay'));
        await expect(dockRow(page, 'pin-a')).toBeVisible();
    }
    const escapedName = 'A "quote" <img id="pinned-name-injected"> & \'single\'';
    await page.evaluate(async name => {
        const { promptManager: manager } = await import('/scripts/openai.js');
        manager.getPromptById('pin-b').name = name;
        manager.render(false);
    }, escapedName);
    await openPrompts(page);
    await expect(promptRow(page, 'pin-b').locator('.prompt-manager-toggle-action')).toHaveAccessibleName(escapedName);
    await expect(promptRow(page, 'pin-b').locator('.prompt-manager-toggle-action')).toHaveAttribute('title', escapedName);
    await expect(promptRow(page, 'pin-b').locator('.prompt-manager-pin-action')).toHaveAccessibleName(`Pin ${escapedName} to chat`);
    await expect(page.locator('#pinned-name-injected')).toHaveCount(0);
    await chat(page);
    expect(app.provider.calls).toHaveLength(0);
});
