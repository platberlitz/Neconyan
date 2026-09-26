/* global document, window */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);
// eslint-disable-next-line playwright/no-skipped-test -- Requires an explicitly disposable server and fixture provider.
test.skip(process.env.NECONYAN_MEWMORY_TEST_DISPOSABLE !== '1', 'Use a disposable server and the Mewmory fixture provider.');

test('completed tracker state reaches extraction, archive and source inspection on desktop and touch phones', async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // eslint-disable-next-line playwright/no-networkidle -- Finish loading the disposable preview before inspecting its UI.
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
    const headers = await page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
    const post = async (route, data = {}) => {
        const response = await page.request.post(route, { headers, data });
        expect(response.ok(), await response.text()).toBe(true);
        return response.json();
    };
    const created = await page.request.post('/api/characters/create', { headers, data: {
        ch_name: 'Tracker Mewmory ' + Date.now(), description: 'Mara is an archivist.', first_mes: 'She closes her bag.',
    } });
    expect(created.ok()).toBe(true);
    const avatar = await created.text();
    const chatName = 'Tracker evidence';
    const locator = { avatar, chat: chatName, group: false };
    const vacant = await page.request.post('/api/chats/get', { headers, data: { avatar_url: avatar, file_name: chatName, allow_create: true } });
    expect(vacant.ok()).toBe(true);
    const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
    const stateText = 'Mara carries a quartz compass in her bag.';
    await post('/api/chats/save', { avatar_url: avatar, file_name: chatName,
        chat: [{ chat_metadata: {} }, { name: 'Mara', is_user: false, mes: 'She closes her bag.', extra: {
            inChatAgentCompanionResults: {
                inventory: { agentName: 'Inventory', agentCategory: 'tracker', status: 'done', content: stateText, includeInChatHistory: false },
                pending: { agentName: 'Unfinished', agentCategory: 'tracker', status: 'pending', content: 'Unfinished ruby state.' },
            },
        } }], roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() },
    });
    await page.evaluate(async ({ avatar, chatName }) => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await (await import('/script.js')).openCharacterChat(chatName);
        window.NeconyanShell.openTab('left', 'mewmory');
    }, { avatar, chatName });
    const { config } = await post('/api/mewmory/config/get');
    config.autoUpdate = false;
    for (const role of Object.values(config.roles)) role.enabled = false;
    Object.assign(config.roles.extractor, { enabled: true, endpoint: process.env.MEWMORY_FIXTURE_URL || 'http://127.0.0.1:4491/v1', model: 'extractor' });
    await post('/api/mewmory/config/save', { config });
    const workspace = page.locator('#mewmory-workspace');
    await workspace.getByRole('button', { name: 'Refresh', exact: true }).click();
    await workspace.getByRole('tab', { name: 'Settings', exact: true }).click();
    await workspace.getByLabel('Use Mewmory in this chat').check();
    await workspace.getByRole('tab', { name: 'Now', exact: true }).click();
    await workspace.getByRole('button', { name: 'Update now', exact: true }).click();
    await expect.poll(async () => (await post('/api/mewmory/inspect', { locator })).records.map(record => record.text)).toContain(stateText);
    const touch = await page.context().newCDPSession(page);
    for (const width of [1280, 393]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 900 });
        await touch.send('Emulation.setTouchEmulationEnabled', { enabled: width === 393 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await workspace.getByRole('tab', { name: 'Archive', exact: true }).click();
        await workspace.getByLabel('Search memories and original messages').fill('quartz compass');
        await workspace.getByRole('button', { name: 'Search archive', exact: true }).click();
        await expect(workspace.getByText(stateText, { exact: false }).first()).toBeVisible();
        await workspace.getByRole('button', { name: 'Message 1 · revision 1', exact: true }).first().click();
        const source = workspace.locator('.mewmory-source-text');
        await expect(source).toContainText(stateText);
        await expect(source).toContainText('supplementary state, not dialogue');
        await expect(source).not.toContainText('Unfinished ruby');
        const geometry = await source.evaluate(element => ({
            width: document.documentElement.scrollWidth, left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right, fontSize: window.getComputedStyle(element).fontSize,
            touchPoints: window.navigator.maxTouchPoints,
        }));
        expect(geometry.width).toBeLessThanOrEqual(width + 1);
        expect(geometry.left).toBeGreaterThanOrEqual(-1);
        expect(geometry.right).toBeLessThanOrEqual(width + 1);
        await info.attach('tracker-source-' + width, { body: Buffer.from(JSON.stringify(geometry)), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('tracker-source-' + width + '.png') });
        await workspace.getByRole('button', { name: 'Close source', exact: true }).click();
    }
    await touch.detach();
});
