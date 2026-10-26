/* global document, window */
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test, acknowledgeActiveSettings, MODEL } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.setTimeout(180000);
// eslint-disable-next-line playwright/no-skipped-test -- Uses an owned server and a deterministic model provider.
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires a disposable tracker repair fixture.');

const body = 'route: 🌱 Slow Burn Under Glass\npath: Close > Confidant > Intimate\nheart: He keeps holding hands.\ntrust: He trusts Kris.\nwant: Stay\nguard: Pride\nlikes: Soup\ndislikes: Distance\ntell: His thumb moves.\nunsaid: Stay here.\nmemory: Dinner: They held hands.\ndate: Dinner\nturn: Kris squeezed back.\nnext: Time together';
const repaired = `[METER|Alhaitham|Confidant|💚 STABLE|🌅 WARMING]\n${body}\n[/METER]`;

function configureTrackerSettings(saved) {
    saved.extension_settings.connectionManager.profiles[0].model = MODEL;
    saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
}

function labelBoundsWithinButton(element) {
    const label = element.getBoundingClientRect();
    const button = element.parentElement.getBoundingClientRect();
    return { x: label.x - button.x, y: label.y - button.y, width: label.width, height: label.height };
}

async function openTrackerChat(account, chatName, broken, agentOverrides = {}, { templateName = 'relationship-tracker', companionContent } = {}) {
    const request = { avatar_url: account.avatar, file_name: chatName };
    const vacant = await account.context.request.post('/api/chats/get', {
        headers: account.headers, data: { ...request, allow_create: true },
    });
    expect(vacant.ok()).toBe(true);
    const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...request,
        chat: [{ chat_metadata: {} }, { name: 'Durable Nova', is_user: false, mes: `Before the tracker.\n\n${broken}\n\nAfter the tracker.`,
            extra: companionContent ? { inChatAgentCompanionResults: { [agentOverrides.id]: {
                status: 'done', content: companionContent, agentName: 'Event Tracker', agentCategory: 'tracker', format: 'markdown', displayMode: 'card',
            } } } : {} }],
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() },
    });
    const page = await account.open({ workspace: false });
    // eslint-disable-next-line playwright/no-networkidle -- Inspect only after the disposable preview finishes startup.
    await page.waitForLoadState('networkidle');
    await page.evaluate(async ({ avatar, chatName, agentOverrides, templateName }) => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const template = await (await fetch(`/scripts/extensions/in-chat-agents/templates/${templateName}.json`)).json();
        const bundles = await (await fetch('/scripts/extensions/in-chat-agents/templates/regex-bundles.json')).json();
        await store.saveAgent({ ...template, id: 'repair-relationship', enabled: true, regexScripts: bundles[template.id], ...agentOverrides });
        await (await import('/script.js')).openCharacterChat(chatName);
    }, { avatar: account.avatar, chatName, agentOverrides, templateName });
    await acknowledgeActiveSettings(page);
    return { page, request };
}

for (const phone of [false, true]) {
    test(`Companion wrench repairs a mixed Event Tracker note on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const event = '[EVENT|✅ RESOLVED|The Archon War question was answered|Tonight, kitchen table]\ncontext: Alhaitham now knows which war Kris fought in.\n[/EVENT]';
        const promise = '[EVENT|💬 PROMISE|Defer the remaining war questions|Tomorrow]\ncontext: They agreed to talk after resting.\n[/EVENT]';
        const broken = `${event.replace('[EVENT|', '[EVENT|⚠️ THREAT|')}\n\n${promise}`;
        const fixed = `${event}\n\n${promise}`;
        const account = await app.account({ phone, activeConnection: true,
            configureSettings: configureTrackerSettings });
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: event } }] };
        const chatName = 'Mixed Event Tracker repair';
        const { page, request } = await openTrackerChat(account, chatName, 'The scene is unchanged.', {
            id: 'repair-event', execution: 'companion', companion: { trigger: 'manual', displayMode: 'card', format: 'markdown' },
        }, { templateName: 'event-tracker', companionContent: broken });
        const card = page.locator('#chat .ica--companion-card[data-agent-id="repair-event"]');
        const note = card.locator('.ica--companion-body');
        await expect(note).toContainText('[EVENT|⚠️ THREAT|✅ RESOLVED|');
        await expect(note.locator('details')).toHaveCount(1);
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('event-before.png') });
        await card.locator('[data-action="fix"]').click();
        await expect(card.locator('.ica--companion-error')).toContainText('Showing the previous note.', { timeout: 30000 });
        await expect(note).toContainText('[EVENT|⚠️ THREAT|✅ RESOLVED|');
        await expect(note.locator('details')).toHaveCount(1);
        await expect.poll(async () => (await account.post('/api/chats/get', request))[1].extra.inChatAgentCompanionResults['repair-event'].content).toBe(broken);
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: fixed } }] };
        await card.locator('[data-action="fix"]').click();
        await expect(note).not.toContainText('[EVENT|', { timeout: 30000 });
        await expect(note.locator('details')).toHaveCount(2);
        await expect(card.locator('.ica--companion-error')).toHaveCount(0);
        expect(app.provider.calls).toHaveLength(2);
        await expect.poll(async () => (await account.post('/api/chats/get', request))[1].extra.inChatAgentCompanionResults['repair-event'].content).toBe(fixed);
        const geometry = await card.evaluate(element => ({ left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right, width: window.innerWidth, display: window.getComputedStyle(element).display }));
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
        expect(geometry.display).not.toBe('none');
        await info.attach('event-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('event-after.png') });
        await card.locator('[data-action="fix"]').click();
        await expect(card.locator('[data-action="fix"]')).toBeEnabled();
        expect(app.provider.calls).toHaveLength(2);
        await page.evaluate(async chatName => (await import('/script.js')).openCharacterChat(chatName), chatName);
        await expect(note.locator('details')).toHaveCount(2);
        await expect(page.locator('#chat .mes_text')).toContainText('The scene is unchanged.');
    });
}

for (const { phone, kind } of [false, true].flatMap(phone => ['header', 'field order'].map(kind => ({ phone, kind })))) {
    test(`Fix Trackers repairs inline ${kind} and persists it on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const broken = kind === 'header' ? repaired.replace('STABLE|', 'STABLE]')
            : repaired.replace('date: Dinner\nturn: Kris squeezed back.', 'turn: Kris squeezed back.\ndate: Dinner');
        const account = await app.account({ phone, activeConnection: true,
            configureSettings: configureTrackerSettings,
            contextOptions: { ...(phone ? IPHONE_SAFARI_CONTEXT : {}), reducedMotion: 'no-preference' } });
        if (phone) await installIPhoneSafari(account.context);
        if (kind === 'header') app.provider.mode.hold = MODEL;
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: repaired } }] };
        const chatName = 'Tracker repair regression';
        const { page, request } = await openTrackerChat(account, chatName, broken);
        if (phone) await applyIOSOnlyCss(page);
        const message = page.locator('#chat .mes[mesid="0"]');
        const text = message.locator('.mes_text');
        await expect(text).toContainText(broken.split('\n')[0]);
        await expect(text.locator('details')).toHaveCount(0);
        await message.locator('.extraMesButtonsHint').click();
        const fixButton = message.locator('.mes_fix_trackers');
        const label = fixButton.locator('.neconyan-action-label');
        const restingLabelBounds = await label.evaluate(labelBoundsWithinButton);
        await fixButton.click();
        if (kind === 'header') {
            try {
                await expect.poll(() => app.provider.calls.length).toBe(1);
                await expect(fixButton).toHaveClass(/mes_fix_trackers--running/);
                // Freeze a quarter-turn so a rotating row cannot pass at a full revolution.
                await fixButton.evaluate(element => {
                    for (const animation of element.getAnimations({ subtree: true })) {
                        animation.pause();
                        animation.currentTime = 250;
                    }
                });
                // A user scroll releases the phone's automatic bottom pin during generation.
                await page.locator('#chat').hover();
                await page.mouse.wheel(0, -2000);
                await expect(fixButton).toBeInViewport();
                await page.screenshot({ path: info.outputPath('tracker-repair-running.png'), animations: 'allow' });
                await expect(fixButton).toHaveCSS('animation-name', 'none');
                await expect(fixButton).toHaveCSS('transform', 'none');
                expect(await label.evaluate(labelBoundsWithinButton)).toEqual(restingLabelBounds);
                expect(await fixButton.evaluate(element => window.getComputedStyle(element, '::before').animationName))
                    .toBe('mes-fix-trackers-spin');
                expect(await fixButton.evaluate(element => window.getComputedStyle(element, '::before').transform)).not.toBe('none');
                // The companion message action shares this rule; settings use a separate icon child.
                for (const [selector, runningClass, childIcon] of [
                    ['.mes_run_companions', 'mes_run_companions--running', false],
                    ['#ica--fixTrackers', 'mes_fix_trackers--running', true],
                ]) {
                    const action = childIcon ? page.locator(selector) : message.locator(selector);
                    const motion = await action.evaluate((element, { runningClass, childIcon }) => {
                        element.classList.add(runningClass);
                        const result = {
                            button: window.getComputedStyle(element).animationName,
                            icon: window.getComputedStyle(childIcon ? element.querySelector('i') : element, childIcon ? null : '::before').animationName,
                        };
                        element.classList.remove(runningClass);
                        return result;
                    }, { runningClass, childIcon });
                    expect(motion).toEqual({ button: 'none', icon: 'mes-fix-trackers-spin' });
                }
                await page.emulateMedia({ reducedMotion: 'reduce' });
                expect(await fixButton.evaluate(element => window.getComputedStyle(element, '::before').animationName)).toBe('none');
                await page.emulateMedia({ reducedMotion: 'no-preference' });
            } finally {
                await app.release();
            }
        }
        await expect(text.locator('details').first()).toBeVisible({ timeout: 60000 });
        await expect(fixButton).not.toHaveClass(/mes_fix_trackers--running/);
        expect(await fixButton.evaluate(element => window.getComputedStyle(element, '::before').animationName)).toBe('none');
        await expect(text).not.toContainText('[METER|');
        if (kind === 'field order') expect(app.provider.calls).toHaveLength(0);
        await expect(text).toContainText('Before the tracker.');
        await expect(text).toContainText('After the tracker.');
        await text.locator('details').first().locator(':scope > summary').click();
        await expect(text.getByText('He keeps holding hands.', { exact: true })).toBeVisible();
        const geometry = await text.locator('details').first().evaluate(element => ({
            left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
            height: element.getBoundingClientRect().height, display: window.getComputedStyle(element).display,
            viewport: window.innerWidth, touchPoints: window.navigator.maxTouchPoints,
            documentWidth: document.documentElement.scrollWidth,
        }));
        expect(geometry.display).not.toBe('none');
        expect(geometry.height).toBeGreaterThan(0);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.touchPoints > 0).toBe(phone);
        await info.attach('tracker-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('tracker-repaired.png') });
        // The repair saves through the debounced chat save, so wait for it to land.
        await expect.poll(async () => (await account.post('/api/chats/get', request))[1].mes)
            .toBe(`Before the tracker.\n\n${repaired}\n\nAfter the tracker.`);
        await page.evaluate(async chatName => (await import('/script.js')).openCharacterChat(chatName), chatName);
        await expect(text.locator('details').first()).toBeVisible();
        await expect(text).not.toContainText('[METER|');
    });
}

test('with server replies chosen, Fix Trackers and the Companion wrench repair on the server', async ({ app }) => {
    const account = await app.account({ activeConnection: true, configureSettings(saved) {
        configureTrackerSettings(saved);
        saved.power_user.reply_generation_location = 'server';
    } });
    const browserRequests = [];
    const serverActions = [];
    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: repaired } }] };
    const { page, request } = await openTrackerChat(account, 'Server tracker repair', repaired.replace('STABLE|', 'STABLE]'));
    page.on('request', sent => {
        if (sent.url().includes('/api/backends/chat-completions/generate')) browserRequests.push(sent.url());
        if (sent.url().endsWith('/api/roleplay/agent/submit')) serverActions.push(sent.postDataJSON().mode);
    });
    const message = page.locator('#chat .mes[mesid="0"]');
    const text = message.locator('.mes_text');
    await message.locator('.extraMesButtonsHint').click();
    await message.locator('.mes_fix_trackers').click();
    await expect(text.locator('details').first()).toBeVisible({ timeout: 60000 });
    await expect(text).not.toContainText('[METER|');
    await expect.poll(async () => (await account.post('/api/chats/get', request))[1].mes)
        .toBe(`Before the tracker.\n\n${repaired}\n\nAfter the tracker.`);

    const event = '[EVENT|✅ RESOLVED|The Archon War question was answered|Tonight, kitchen table]\ncontext: Alhaitham now knows which war Kris fought in.\n[/EVENT]';
    const broken = event.replace('[EVENT|', '[EVENT|⚠️ THREAT|');
    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: event } }] };
    const companion = await openTrackerChat(account, 'Server event repair', 'The scene is unchanged.', {
        id: 'repair-event', execution: 'companion', companion: { trigger: 'manual', displayMode: 'card', format: 'markdown' },
    }, { templateName: 'event-tracker', companionContent: broken });
    companion.page.on('request', sent => {
        if (sent.url().includes('/api/backends/chat-completions/generate')) browserRequests.push(sent.url());
        if (sent.url().endsWith('/api/roleplay/agent/submit')) serverActions.push(sent.postDataJSON().mode);
    });
    const card = companion.page.locator('#chat .ica--companion-card[data-agent-id="repair-event"]');
    await expect(card.locator('.ica--companion-body')).toContainText('[EVENT|⚠️ THREAT|');
    await card.locator('[data-action="fix"]').click();
    await expect(card.locator('.ica--companion-body')).not.toContainText('[EVENT|', { timeout: 60000 });
    await expect.poll(async () => (await account.post('/api/chats/get', companion.request))[1].extra.inChatAgentCompanionResults['repair-event'].content).toBe(event);

    expect(serverActions).toEqual(['repair-trackers', 'repair-companions']);
    expect(browserRequests).toEqual([]);
    expect(app.provider.calls).toHaveLength(2);
});

for (const phone of [false, true]) {
    test(`Fix trackers saves its connections and escapes a stalled primary on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const account = await app.account({ phone, activeConnection: true, configureSettings: saved => {
            configureTrackerSettings(saved);
            const manager = saved.extension_settings.connectionManager;
            for (const name of ['stalled', 'backup']) manager.profiles.push({ ...manager.profiles[0],
                id: `repair-${name}`, name: `Repair ${name}`, model: `repair-${name}-model` });
        } });
        const chatName = 'Tracker repair connection fallback';
        const broken = repaired.replace('STABLE|', 'STABLE]');
        const { page, request } = await openTrackerChat(account, chatName, broken, {
            connectionProfile: 'durable', modelOverride: 'ordinary-agent-override',
        });
        const openConnections = async () => {
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
            await page.locator('.ica--workspace-tab[data-workspace-view="connections"]').click();
        };
        await openConnections();
        const primary = page.locator('#ica--trackerRepairConnectionProfile');
        const fallback = page.locator('#ica--trackerRepairConnectionFallbacks');
        const timeout = page.locator('#ica--trackerRepairTimeoutSeconds');
        await primary.selectOption('repair-stalled');
        await fallback.locator('.ica--fallback-add').selectOption('repair-backup');
        await timeout.fill('1');
        await timeout.dispatchEvent('change');
        await acknowledgeActiveSettings(page);
        await page.reload();
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
        await page.evaluate(async ({ avatar, chatName }) => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            await (await import('/script.js')).openCharacterChat(chatName);
        }, { avatar: account.avatar, chatName });
        await openConnections();
        await expect(primary).toHaveValue('repair-stalled');
        await expect(fallback.locator('.ica--fallback-row')).toHaveAttribute('data-profile-id', 'repair-backup');
        await expect(timeout).toHaveValue('1');
        await expect(page.locator('#ica--moreTools')).not.toHaveAttribute('open');
        const fix = page.locator('#ica--fixTrackers');
        await expect(fix).toBeVisible();
        await page.screenshot({ path: info.outputPath('repair-connections.png') });
        app.provider.mode.hold = 'repair-stalled-model';
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: repaired } }] };
        try {
            await fix.click();
            await expect.poll(() => app.provider.calls.map(call => call.model), { timeout: 30000 })
                .toEqual(['repair-stalled-model', 'repair-backup-model']);
            await expect(fix).toBeEnabled();
            await expect(fix).toHaveText('Fix trackers');
            await expect.poll(async () => (await account.post('/api/chats/get', request))[1].mes)
                .toBe(`Before the tracker.\n\n${repaired}\n\nAfter the tracker.`);
            expect(await page.evaluate(async () => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const agent = store.getAgentById('repair-relationship');
                return { profile: agent.connectionProfile, model: agent.modelOverride,
                    connection: window.SillyTavern.getContext().extensionSettings.connectionManager.selectedProfile };
            })).toEqual({ profile: 'durable', model: 'ordinary-agent-override', connection: 'durable' });
        } finally {
            await app.release();
        }
    });
}
