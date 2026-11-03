/* global window, getComputedStyle, Image */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { SAMPLES } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/samples.js';

const bundles = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url), 'utf8'));

for (const phone of [false, true]) {
    test(`companion tracker portraits use the current card on ${phone ? 'phone' : 'desktop'}`, async ({ app }, info) => {
        test.setTimeout(120000);
        const account = await app.account({ phone });
        const created = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
            ch_name: 'Mimi', description: 'A card whose avatar filename does not match her name.', first_mes: 'Hello.',
        } });
        expect(created.ok()).toBe(true);
        const originalAvatar = await created.text();
        const avatar = `Creator-${randomUUID()}.png`;
        await fs.rename(path.join(app.dataRoot, 'default-user', 'characters', originalAvatar),
            path.join(app.dataRoot, 'default-user', 'characters', avatar));
        const page = await account.open({ workspace: false });
        const tracker = SAMPLES['relationship-bond'].full.replaceAll('Mira', 'Mimi');
        const regexScripts = bundles['tpl-relationship-tracker'];
        await page.evaluate(async ({ avatar, tracker, regexScripts }) => {
            const core = await import('/script.js');
            await core.getCharacters();
            const index = core.characters.findIndex(character => character.avatar === avatar);
            if (index < 0) throw new Error('Renamed card was not listed');
            if (!await core.selectCharacterById(index, { switchMenu: false })) throw new Error('Could not select renamed card');
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            const template = await (await fetch('/scripts/extensions/in-chat-agents/templates/relationship-tracker.json')).json();
            await store.saveAgent({ ...template, id: 'companion-portrait', name: 'Relationship Tracker', enabled: true,
                execution: 'companion', companion: { displayMode: 'card', format: 'markdown' }, regexScripts });
            core.chat.splice(0, core.chat.length, {
                name: 'Mimi', is_user: false, is_system: false, mes: 'The scene continues.', original_avatar: avatar,
                send_date: new Date().toISOString(),
                extra: { inChatAgentCompanionResults: { 'companion-portrait': {
                    status: 'done', content: tracker, agentName: 'Relationship Tracker', format: 'markdown', displayMode: 'card',
                } } },
            });
            await core.printMessages();
            await window.SillyTavern.getContext().eventSource.emit('in_chat_agent_companion_results_updated', { messageIndex: 0 });
        }, { avatar, tracker, regexScripts });

        const card = page.locator('#chat .ica--companion-card[data-agent-id="companion-portrait"]');
        const portrait = card.locator('.ica--companion-body [style*="/thumbnail/portrait?"]').first();
        await expect(portrait).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/companion-tracker-portrait-${phone ? 'phone' : 'desktop'}-${process.env.NECONYAN_SCREENSHOT_PHASE || 'after'}.png`, scale: 'css' });
        const rendered = await portrait.evaluate(element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return { background: style.backgroundImage, width: rect.width, height: rect.height };
        });
        expect(rendered.width).toBeGreaterThan(0);
        expect(rendered.height).toBeGreaterThan(0);
        const portraitUrl = rendered.background.match(/url\("?([^")]+)"?\)/)[1];
        expect(new URL(portraitUrl).searchParams.get('avatar')).toBe(avatar);
        const resolved = await account.context.request.get(portraitUrl, { maxRedirects: 0 });
        expect(resolved.status()).toBe(302);
        expect(new URL(resolved.headers().location, app.url).searchParams.get('file')).toBe(avatar);
        const dimensions = await page.evaluate(url => new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
            image.onerror = () => reject(new Error('Portrait failed to load'));
            image.src = url;
        }), portraitUrl);
        expect(dimensions.width).toBeGreaterThan(0);
        expect(dimensions.height).toBeGreaterThan(0);
        await info.attach('companion-tracker-portrait', { body: JSON.stringify({ avatar, portraitUrl }), contentType: 'application/json' });
    });
}
