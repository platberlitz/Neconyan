import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const mainReply = 'The main reply is finished. The next Agents are preparing.';
const lore = 'Nova keeps a silver compass in her coat.';

for (const phone of [true, false]) for (const concurrent of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    const order = concurrent ? 'together' : 'post-first';
    test(`${viewport} shows Companion activity while Post Gen is unfinished (${order})`, async ({ app }) => {
        test.setTimeout(180000);
        app.provider.mode.streamReply = { first: 'The main reply', rest: mainReply.slice('The main reply'.length) };
        app.provider.mode.hold = ['post-held', 'companion-held'];
        app.provider.mode.reply = body => ({ choices: [{ message: { content: body.model === 'post-held'
            ? 'The final reply includes the Post Gen revision.' : 'The Companion note is ready.' }, finish_reason: 'stop' }] });
        const account = await app.account({ phone, activeConnection: true, configureSettings(saved) {
            saved.oai_settings.stream_openai = true;
            saved.extension_settings.connectionManager.profiles.push(
                { id: 'post', name: 'Post Gen fixture', api: 'custom', mode: 'cc', model: 'post-held', 'api-url': app.provider.url },
                { id: 'companion', name: 'Companion fixture', api: 'custom', mode: 'cc', model: 'companion-held', 'api-url': app.provider.url });
            saved.extension_settings.inChatAgents = { globalSettings: { enabled: true, separateRecentChats: false,
                trackerCompanionAutoLoopVersion: 4, connectionProfile: 'post', companionExecutionMode: 'parallel',
                companionConcurrentWithPostGen: concurrent } };
            saved.world_info_settings = { ...saved.world_info_settings,
                world_info: { globalSelect: ['agent-start'] }, world_info_budget: 100 };
        } });
        const directory = path.join(app.dataRoot, 'default-user', 'InChatAgents');
        await fs.mkdir(directory, { recursive: true });
        const agents = [
            { id: 'post', name: 'Post Gen', enabled: true, phase: 'post', prompt: 'Revise the reply.', connectionProfile: 'post',
                postProcess: { enabled: false, promptTransformEnabled: true } },
            { id: 'companion', name: 'Story Companion', enabled: true, category: 'companion', execution: 'companion',
                prompt: 'Write a note about the reply.', connectionProfile: 'companion',
                companion: { trigger: 'auto', displayMode: 'card' } },
        ];
        for (const agent of agents) await fs.writeFile(path.join(directory, `${agent.id}.json`), JSON.stringify(agent));
        await fs.writeFile(path.join(app.dataRoot, 'default-user', 'worlds', 'agent-start.json'), JSON.stringify({ entries: {
            0: { uid: 0, key: ['Nova'], keysecondary: [], content: lore, comment: 'Companion context',
                constant: true, selective: true, order: 100, position: 0, disable: false, probability: 100, useProbability: true },
        } }));
        const page = await account.open({ workspace: false, skipTour: false });
        await page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]').click();
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        const submitted = page.waitForResponse(response => response.url().endsWith('/api/roleplay/workflow/submit') && response.status() !== 409);
        await page.locator('#send_textarea').fill('Show the next Agents as soon as the main reply finishes.');
        await page.locator('#send_textarea').press('Enter');
        const { jobId } = await (await submitted).json();
        const preview = page.locator('#neconyan-roleplay-preview');
        try {
            await expect(preview).toContainText('The main reply');
            app.provider.mode.finishStream();
            await expect.poll(() => app.provider.calls.some(call => call.model === 'post-held')).toBe(true);
            await expect(preview).toContainText(mainReply);
            await expect(preview).toContainText(concurrent ? /Running (Agents|Companions)/ : 'Running Agents');
            await preview.scrollIntoViewIfNeeded();
            const capture = () => page.screenshot({ path: `../screenshots/agent-start-${order}-${viewport}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
            if (process.env.NECONYAN_SCREENSHOT_PHASE === 'before') await capture();
            const pending = preview.locator('.ica--companion-pending');
            await expect(pending).toBeVisible();
            const layout = await pending.evaluate(element => {
                const bounds = element.getBoundingClientRect();
                const style = element.ownerDocument.defaultView.getComputedStyle(element);
                return { left: bounds.left, right: bounds.right, height: bounds.height, opacity: Number(style.opacity) };
            });
            expect(layout.left).toBeGreaterThanOrEqual(0);
            expect(layout.right).toBeLessThanOrEqual(page.viewportSize().width);
            expect(layout.height).toBeGreaterThan(0);
            expect(layout.opacity).toBeGreaterThan(0);
            await expect(preview.locator('.ica--companion-action')).toHaveCount(0);
            if (process.env.NECONYAN_SCREENSHOT_PHASE !== 'before') await capture();
            expect(app.provider.calls.find(call => call.model === 'post-held').completedAt).toBeNull();
            if (concurrent) await expect.poll(() => app.provider.calls.some(call => call.model === 'companion-held')).toBe(true);
            else expect(app.provider.calls.some(call => call.model === 'companion-held')).toBe(false);
            expect(await page.evaluate(async () => (await import('/script.js')).chat.at(-1).is_user)).toBe(true);
        } finally {
            app.provider.mode.finishStream?.();
            await app.release();
        }
        await account.settled(jobId);
        await expect(preview).toHaveCount(0);
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText('The final reply includes the Post Gen revision.');
        await expect(page.locator('#chat .mes[mesid]').last()).toContainText('The Companion note is ready.');
        const post = app.provider.calls.find(call => call.model === 'post-held');
        const companion = app.provider.calls.find(call => call.model === 'companion-held');
        expect(app.provider.calls).toHaveLength(3);
        expect(JSON.stringify(companion.messages)).toContain(lore);
        if (!concurrent) {
            expect(companion.startedAt).toBeGreaterThanOrEqual(post.completedAt);
            expect(JSON.stringify(companion.messages)).toContain('The final reply includes the Post Gen revision.');
        }
    });
}
