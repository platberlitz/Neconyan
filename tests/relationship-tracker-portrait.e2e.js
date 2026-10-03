/* global window, getComputedStyle, Image */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { SAMPLES } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/samples.js';

const bundles = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url), 'utf8'));

for (const phone of [false, true]) {
    test(`relationship portraits follow the selected duplicate card on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, configureSettings(saved) {
            saved.extension_settings.regex = bundles['tpl-relationship-tracker'];
        } });
        const avatars = [];
        for (let i = 0; i < 2; i++) {
            const response = await account.context.request.post('/api/characters/create', { headers: account.headers, data: {
                ch_name: 'Mira', description: `Duplicate card ${i}`, first_mes: SAMPLES['relationship-bond'].full,
            } });
            expect(response.ok()).toBe(true);
            avatars.push(await response.text());
        }
        expect(avatars[0]).not.toBe(avatars[1]);
        const page = await account.open({ workspace: false });
        await page.evaluate(() => window.SillyTavern.getContext().getCharacters());

        for (const avatar of [avatars[1], avatars[0], avatars[1]]) {
            await page.evaluate(async avatar => {
                const core = await import('/script.js');
                const id = core.characters.findIndex(character => character.avatar === avatar);
                if (!await core.selectCharacterById(id, { switchMenu: false })) throw new Error('Could not select duplicate card');
            }, avatar);
            const portrait = page.locator('#chat .mes_text [style*="/thumbnail/portrait?"]').first();
            await expect(portrait).toBeVisible();
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
        }
    });
}
