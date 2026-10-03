/* global document, window */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { createMockRoleplayStore } from './roleplay-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.setTimeout(120000);
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

async function openSleeperChat(page) {
    const store = createMockRoleplayStore(() => page.evaluate(async () =>
        (await import('/scripts/roleplay-save-chain.js')).roleplayAccountStamp().account));
    await page.route('**/api/chats/get', route => store.read(route));
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await page.route('**/api/chats/save', route => store.save(route));
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const id = context.characters.length;
        context.characters.push({ name: 'Sleeper Cat', avatar: 'none', chat: 'sleeper-check', first_mes: '', mes_example: '', shallow: false, data: {} });
        await context.selectCharacterById(id, { switchMenu: false });
        context.chat.splice(0, context.chat.length, ...[true, false].map(is_user => ({
            name: is_user ? 'User' : 'Sleeper Cat', is_user, is_system: false,
            mes: 'The portrait and the sleeping cat must both remain visible. '.repeat(3),
            send_date: new Date().toISOString(), extra: {},
        })));
        await context.printMessages();
        (await import('/scripts/welcome-screen.js')).hideWelcomeHome();
        window.jQuery('#chat_display').val('6').trigger('change');
    });
    await page.waitForFunction(() => document.querySelector('#neconyan-native-chat-styles')?.sheet);
    await expect(page.locator('#toast-container .toast')).toHaveCount(0);
}

for (const phone of [false, true]) {
    test.describe(`${phone ? 'iPhone stand-in' : 'Desktop'} message sleepers`, () => {
        const syncPhoneCss = phone ? applyIOSOnlyCss : async () => {};
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });
        test.beforeEach(async ({ context, page }) => {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            await openSleeperChat(page);
        });

        test('keeps calico paws and tiger tails above Ripple portraits', async ({ page }, info) => {
            for (const theme of ['Neconyan Calico', 'Neconyan Calico Dark']) {
                await page.locator('#themes').evaluate((el, name) => window.jQuery(el).val(name).trigger('change'), theme);
                for (const shell of ['windows-98', 'calico']) {
                    await page.evaluate(shell => window.NeconyanShell.applyTheme(shell), shell);
                    await page.waitForFunction(shell => shell === 'calico'
                        ? !document.querySelector('link[data-sb-shell-style]')
                        : document.querySelector(`link[data-sb-shell-style="${shell}"]`)?.sheet, shell);
                    await syncPhoneCss(page);
                    for (const id of ['0', '1']) {
                        const message = page.locator(`#chat .mes[mesid="${id}"]`);
                        const cat = message.locator(':scope > .neconyan-message-sleeper');
                        await message.scrollIntoViewIfNeeded();
                        await expect(cat).toBeVisible();
                        const visibleParts = await cat.evaluate(el => {
                            const bounds = el.getBoundingClientRect();
                            const user = el.classList.contains('is-user');
                            return [
                                [bounds.left + (user ? 25 : 65), bounds.top + 44],
                                [bounds.left + (user ? 85 : 10), bounds.top + 65],
                            ].map(([x, y]) => document.elementFromPoint(x, y) === el);
                        });
                        expect(visibleParts, `${theme}, ${shell}, message ${id}: paws and tail remain uncovered`).toEqual([true, true]);
                        await page.screenshot({ path: info.outputPath(`${shell}-${theme.replaceAll(' ', '-')}-${id}.png`) });
                    }
                }
            }
        });
    });
}
