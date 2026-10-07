/* global getComputedStyle */
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { SAMPLES } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/samples.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const bundles = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url), 'utf8'));
const dialogue = 'You smelled it. Nobody smells it. What else can you tell from me, comrade?';

for (const phone of [true, false]) {
    test(`dialogue quotes in Unsaid and Scratchpad on ${phone ? 'phone' : 'desktop'}`, async ({ app }) => {
        test.setTimeout(120000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
            saved.extension_settings.regex = bundles['tpl-relationship-tracker'];
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await page.evaluate(async ({ avatar, sample, dialogue }) => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
            core.chat[0].mes = sample.replace('I hoped you would stay', `<font color="#aaffaa">"${dialogue}"</font>`);
            await core.saveChatConditional();
            await core.reloadCurrentChat();
        }, { avatar: account.avatar, sample: SAMPLES['relationship-bond'].full, dialogue });
        const unsaid = page.locator('#chat .mes_text details').filter({ has: page.locator('summary').filter({ hasText: 'Unsaid' }) }).last();
        await page.locator('#chat .mes_text details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
        if (phone) await applyIOSOnlyCss(page);
        await expect(unsaid.locator(':scope > div')).toHaveText(`"${dialogue}"`);
        await expect(unsaid.locator('font q')).toHaveCSS('color', 'rgb(170, 255, 170)');
        await page.screenshot({ path: `../screenshots/quotes-tracker-${phone ? 'phone' : 'desktop'}-after.png` });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        const source = await page.evaluate(async () => {
            const { currentSource, wireSource } = await import('/scripts/scratchpad/context.js');
            return wireSource(currentSource());
        });
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Dialogue quotes', messages: [
            { role: 'assistant', text: `<font color="#aaffaa">"${dialogue}"</font>\n\n"Uncoloured dialogue."` },
        ] } });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        if (phone) await applyIOSOnlyCss(page);
        await expect(page.locator('.scratchpad-text q')).toHaveCount(2);
        await expect(page.locator('.scratchpad-text font q')).toHaveCSS('color', 'rgb(170, 255, 170)');
        await page.screenshot({ path: `../screenshots/quotes-scratchpad-${phone ? 'phone' : 'desktop'}-after.png` });
        const quotes = await page.locator('.scratchpad-text q').evaluateAll(nodes => nodes.map(node => ({
            text: node.textContent, before: getComputedStyle(node, '::before').content, after: getComputedStyle(node, '::after').content,
        })));
        expect(quotes.map(quote => quote.text)).toEqual([`"${dialogue}"`, '"Uncoloured dialogue."']);
        expect(quotes.every(quote => ['none', '""'].includes(quote.before) && ['none', '""'].includes(quote.after))).toBe(true);
    });
}
