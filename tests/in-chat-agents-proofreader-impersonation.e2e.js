/* global window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test, acknowledgeActiveSettings, MODEL } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);

const DRAFT = 'I looks towards the door.';
const PROOFREAD = 'I look towards the door.';

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`enabled Proofreader automatically checks ordinary and guided impersonation on ${viewport}`, async ({ app }, info) => {
        app.provider.mode.reply = body => ({ choices: [{ message: { role: 'assistant', content: body.model === MODEL
            ? DRAFT : `<assistant_response>${PROOFREAD}</assistant_response>` }, finish_reason: 'stop' }] });
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            saved.extension_settings.connectionManager.profiles.push({ id: 'proofreader', name: 'Proofreader fixture',
                api: 'custom', mode: 'cc', model: 'proofreader-model', 'api-url': app.provider.url });
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                trackerCompanionAutoLoopVersion: 4 } };
        } });
        const page = await account.open({ workspace: false });
        // eslint-disable-next-line playwright/no-networkidle -- Inspect the composer only after the disposable app settles.
        await page.waitForLoadState('networkidle');
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const template = await (await fetch('/scripts/extensions/in-chat-agents/templates/proofreader.json')).json();
            await store.saveAgent({ ...template, id: 'saved-proofreader', sourceTemplateId: template.id,
                enabled: true, connectionProfile: 'proofreader' });
        }, account.avatar);
        await acknowledgeActiveSettings(page);
        const before = await page.evaluate(async () => structuredClone((await import('/script.js')).chat));
        const composer = page.locator('#send_textarea');
        await composer.fill('');
        await page.evaluate(async () => { await (await import('/script.js')).Generate('impersonate'); });
        await fs.mkdir(path.resolve('../screenshots'), { recursive: true });
        const screenshot = path.resolve(`../screenshots/proofreader-impersonation-${process.env.PROOFREADER_EVIDENCE_PHASE || 'after'}-${viewport}.png`);
        await page.screenshot({ path: screenshot });
        await info.attach('ordinary-impersonation', { path: screenshot, contentType: 'image/png' });
        await expect(composer).toHaveValue(PROOFREAD);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL, 'proofreader-model']);
        expect(app.provider.calls[1].messages.map(message => message.content).join('\n')).toContain('generated impersonation text');

        const geometry = await composer.evaluate(element => ({ left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right, width: window.innerWidth, display: window.getComputedStyle(element).display }));
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width);
        expect(geometry.display).not.toBe('none');
        await info.attach('composer-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });

        await composer.fill('I approach the door. Write in first person.');
        await page.evaluate(async () => { await (await import('/scripts/extensions/guided-generations/scripts/guidedImpersonate.js')).guidedImpersonate(); });
        await expect(composer).toHaveValue(PROOFREAD);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL, 'proofreader-model', MODEL, 'proofreader-model']);
        expect(await page.evaluate(async () => (await import('/script.js')).chat)).toEqual(before);

        await page.evaluate(async () => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            await store.saveAgentEnabledState(['saved-proofreader'], false);
        });
        await composer.fill('');
        await page.evaluate(async () => { await (await import('/script.js')).Generate('impersonate'); });
        await expect(composer).toHaveValue(DRAFT);
        expect(app.provider.calls.map(call => call.model)).toEqual([MODEL, 'proofreader-model', MODEL, 'proofreader-model', MODEL]);
        expect(await page.evaluate(async () => (await import('/script.js')).chat)).toEqual(before);
    });
}
