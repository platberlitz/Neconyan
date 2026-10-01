/* global document, window */
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test, acknowledgeActiveSettings } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);
// eslint-disable-next-line playwright/no-skipped-test -- Uses an owned server and a deterministic model provider.
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires a disposable tracker repair fixture.');

const body = 'route: 🌱 Slow Burn Under Glass\npath: Close > Confidant > Intimate\nheart: He keeps holding hands.\ntrust: He trusts Kris.\nwant: Stay\nguard: Pride\nlikes: Soup\ndislikes: Distance\ntell: His thumb moves.\nunsaid: Stay here.\nmemory: Dinner: They held hands.\ndate: Dinner\nturn: Kris squeezed back.\nnext: Time together';
const repaired = `[METER|Alhaitham|Confidant|💚 STABLE|🌅 WARMING]\n${body}\n[/METER]`;

for (const { phone, kind } of [false, true].flatMap(phone => ['header', 'field order'].map(kind => ({ phone, kind })))) {
    test(`Fix Trackers repairs inline ${kind} and persists it on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        const broken = kind === 'header' ? repaired.replace('STABLE|', 'STABLE]')
            : repaired.replace('date: Dinner\nturn: Kris squeezed back.', 'turn: Kris squeezed back.\ndate: Dinner');
        const account = await app.account({ phone, activeConnection: true });
        app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: repaired } }] };
        const chatName = 'Tracker repair regression';
        const request = { avatar_url: account.avatar, file_name: chatName };
        const vacant = await account.context.request.post('/api/chats/get', {
            headers: account.headers, data: { ...request, allow_create: true },
        });
        expect(vacant.ok()).toBe(true);
        const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
        await account.post('/api/chats/save', { ...request,
            chat: [{ chat_metadata: {} }, { name: 'Durable Nova', is_user: false, mes: `Before the tracker.\n\n${broken}\n\nAfter the tracker.`, extra: {} }],
            roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() },
        });
        const page = await account.open({ workspace: false });
        // eslint-disable-next-line playwright/no-networkidle -- Inspect only after the disposable preview finishes startup.
        await page.waitForLoadState('networkidle');
        await page.evaluate(async ({ avatar, chatName }) => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const template = await (await fetch('/scripts/extensions/in-chat-agents/templates/relationship-tracker.json')).json();
            const bundles = await (await fetch('/scripts/extensions/in-chat-agents/templates/regex-bundles.json')).json();
            await store.saveAgent({ ...template, id: 'repair-relationship', enabled: true, regexScripts: bundles[template.id] });
            await (await import('/script.js')).openCharacterChat(chatName);
        }, { avatar: account.avatar, chatName });
        await acknowledgeActiveSettings(page);
        const message = page.locator('#chat .mes[mesid="0"]');
        const text = message.locator('.mes_text');
        await expect(text).toContainText(broken.split('\n')[0]);
        await expect(text.locator('details')).toHaveCount(0);
        await message.locator('.extraMesButtonsHint').click();
        await message.locator('.mes_fix_trackers').click();
        await expect(text.locator('details').first()).toBeVisible({ timeout: 60000 });
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
        const saved = await account.post('/api/chats/get', request);
        expect(saved[1].mes).toBe(`Before the tracker.\n\n${repaired}\n\nAfter the tracker.`);
        await page.evaluate(async chatName => (await import('/script.js')).openCharacterChat(chatName), chatName);
        await expect(text.locator('details').first()).toBeVisible();
        await expect(text).not.toContainText('[METER|');
    });
}
