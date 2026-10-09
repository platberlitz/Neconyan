/* global document, window, Element, getComputedStyle */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference' });
test.setTimeout(90000);

const enableReducedMotion = {
    device: page => page.emulateMedia({ reducedMotion: 'reduce' }),
    app: page => page.locator('#reduced_motion').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
};

async function openApp(page, phone, standalone) {
    if (phone) await installIPhoneSafari(page.context(), { standalone });
    await isolateSettingsSaves(page, settings => {
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settings.power_user.reduced_motion = false;
    });
    await page.addInitScript(() => {
        window.motionSurfaces = [];
        window.motionDetails = {};
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
            window.motionSurfaces.push(this.id);
            window.motionDetails[this.id] = { frames: args[0], options: args[1] };
            return animate.apply(this, args);
        };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
    if (phone) await applyIOSOnlyCss(page);
}

for (const [phone, standalone] of [[false, false], [true, false], [true, true]]) {
    const press = phone ? 'tap' : 'click';
    test.describe(`${phone ? (standalone ? 'iPhone home-screen' : 'iPhone Safari') : 'desktop'} motion`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        test('panels reverse cleanly, dialogs animate both ways and chat navigation settles', async ({ page }) => {
            await openApp(page, phone, standalone);
            const panel = page.locator('#left-nav-panel');
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await expect(panel).toBeVisible();
            await expect.poll(() => page.evaluate(() => window.motionSurfaces.includes('left-nav-panel'))).toBe(true);
            await expect(panel).toHaveCSS('translate', 'none');
            const drawerMotion = await page.evaluate(() => window.motionDetails['left-nav-panel']);
            const geometry = await panel.boundingBox();
            const closing = await page.evaluate(() => {
                window.NeconyanShell.closeWorkspace();
                const panel = document.getElementById('left-nav-panel');
                return { inert: panel.inert, visible: panel.getBoundingClientRect().height > 0, count: panel.getAnimations().length };
            });
            expect(closing).toMatchObject({ inert: true, visible: true });
            expect(closing.count).toBeGreaterThan(0);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await expect(panel).toHaveCSS('translate', 'none');
            await expect(panel).toHaveJSProperty('inert', false);
            expect((await panel.boundingBox()).width).toBeCloseTo(geometry.width, 0);
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
            await expect(panel).toBeHidden();
            await expect(page.locator('#user-settings-block')).toBeVisible();
            await page.evaluate(() => window.NeconyanShell.closeWorkspace());
            await expect(page.locator('#user-settings-block')).toBeHidden();

            // All drawer entry points use the same frames and timing, without a
            // second CSS effect animating their height, clipping or opacity.
            const assertDrawerMotion = async (id) => {
                expect(await page.evaluate(id => window.motionDetails[id], id)).toEqual(drawerMotion);
                await expect(page.locator(`#${id}`)).toHaveCSS('translate', 'none');
                expect(await page.locator(`#${id}`).evaluate(el => ({
                    clip: getComputedStyle(el).clipPath,
                    animations: el.getAnimations().length,
                }))).toEqual({ clip: 'none', animations: 0 });
            };
            if (phone) {
                await page.locator('#sb-hamburger').tap();
                await assertDrawerMotion('neconyan-workspace-rail');
                await page.locator('#sb-hamburger').tap();
                await expect(page.locator('#neconyan-workspace-rail')).toBeHidden();
                await page.locator('#sb-hamburger').tap();
                await expect(page.locator('#neconyan-workspace-rail')).toHaveJSProperty('inert', false);
                await page.locator('#sb-hamburger').tap();
                await expect(page.locator('#neconyan-workspace-rail')).toBeHidden();
            }
            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).openCompanionPanel());
            await assertDrawerMotion('ica--tracker-panel');
            await page.evaluate(async () => {
                const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                panel.closeCompanionPanel();
                panel.openCompanionPanel();
            });
            await expect(page.locator('#ica--tracker-panel')).toHaveJSProperty('inert', false);
            await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel());
            await expect(page.locator('#ica--tracker-panel')).toBeHidden();

            const nativeSwitch = await page.evaluate(async () => {
                const { doNavbarIconClick } = await import('/script.js');
                window.NeconyanShell.openTab('left', 'api');
                const panel = document.getElementById('right-nav-panel');
                void doNavbarIconClick.call(panel.parentElement.querySelector('.drawer-toggle'));
                return panel.classList.contains('openDrawer');
            });
            expect(nativeSwitch).toBe(true);
            await assertDrawerMotion('right-nav-panel');
            await page.evaluate(async () => {
                const { doNavbarIconClick } = await import('/script.js');
                void doNavbarIconClick.call(document.getElementById('right-nav-panel').parentElement.querySelector('.drawer-toggle'));
            });
            await expect(page.locator('#right-nav-panel')).toBeHidden();

            const dialogMotion = await page.evaluate(async () => {
                const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
                const popup = new Popup('<h3>Motion check</h3><p>A short, quiet arrival.</p>', POPUP_TYPE.TEXT);
                window.motionPopup = popup;
                void popup.show();
                const style = getComputedStyle(popup.dlg);
                return { name: style.animationName, duration: style.animationDuration };
            });
            expect(dialogMotion).toEqual({ name: 'popup-arrive', duration: '0.18s' });
            const dialog = page.locator('dialog.popup[open]');
            await expect(dialog).not.toHaveAttribute('opening');
            const exit = await page.evaluate(() => {
                document.querySelector('dialog.popup .popup-button-ok').click();
                return getComputedStyle(document.querySelector('dialog.popup')).animationName;
            });
            expect(exit).toBe('popup-leave');
            await expect(dialog).toHaveCount(0);

            await page.evaluate(() => { window.motionSurfaces = []; });
            const miso = page.locator('[data-assistant-personality="miso"]');
            await miso.locator('input[value="miso-male"]').check();
            await miso.locator('[data-assistant-open]').click();
            await expect(page.locator('#send_textarea')).toBeVisible();
            await expect.poll(() => page.evaluate(() => window.motionSurfaces.includes('chat'))).toBe(true);
            await expect(page.locator('#chat')).toHaveCSS('translate', 'none');
            await page.locator('#send_textarea').fill('This draft stays put while panels move.');

            await page.evaluate(() => window.NeconyanShell.openChatTools());
            const tools = page.locator(phone ? '#sb-mobile-chat-tools' : '#sb-chat-sidebar');
            await expect(tools).toBeVisible();
            await assertDrawerMotion(phone ? 'sb-mobile-chat-tools' : 'sb-chat-sidebar');
            await expect.poll(() => page.evaluate(id => window.motionSurfaces.includes(id), phone ? 'sb-mobile-chat-tools' : 'sb-chat-sidebar')).toBe(true);
            await page.evaluate(phone => phone ? window.NeconyanShell.toggleMobileChatTools() : window.NeconyanShell.toggleChatSidebar(), phone);
            await expect(tools).toBeHidden();
            await expect(page.locator('#send_textarea')).toHaveValue('This draft stays put while panels move.');

            // A real menu uses Popper's transform for placement. Motion must not replace it.
            await page.locator('#options_button')[press]();
            await expect(page.locator('#options')).toBeVisible();
            const menu = await page.evaluate(() => {
                const menu = document.getElementById('options');
                return { animated: window.motionSurfaces.includes('options'), transform: menu.style.transform };
            });
            expect(menu.animated).toBe(true);
            expect(menu.transform).toContain('translate');
            await expect(page.locator('#options')).toHaveCSS('translate', 'none');
            await page.locator('#options_button')[press]();
            await expect(page.locator('#options')).toBeHidden();
            await expect(page.locator('#send_textarea')).toBeEditable();
            const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(horizontalOverflow).toBeLessThanOrEqual(1);

            await page.evaluate(() => window.NeconyanShell.activateMode('conversation'));
            const timeline = page.locator('#sb_conversation_timeline');
            await expect(timeline).toBeVisible();
            await expect.poll(() => page.evaluate(() => window.motionSurfaces.includes('sb_conversation_timeline'))).toBe(true);
            await expect(timeline).toHaveCSS('translate', 'none');
            await page.locator('#sb_conversation_input').fill('Keep this Conversation draft, too.');
            await page.evaluate(async () => {
                window.motionSurfaces = [];
                const { renderConversationTimeline } = await import('/scripts/neconyan-conversation/timeline-render.js');
                renderConversationTimeline();
            });
            expect(await page.evaluate(() => window.motionSurfaces)).not.toContain('sb_conversation_timeline');

            await page.evaluate(async () => (await import('/scripts/neconyan-conversation/settings-panel.js')).openConversationSettings());
            const settings = page.locator('#sb_conversation_settings_drawer');
            await expect(settings).toBeVisible();
            await assertDrawerMotion('sb_conversation_settings_drawer');
            await expect.poll(() => page.evaluate(() => window.motionSurfaces.includes('sb_conversation_settings_drawer'))).toBe(true);
            await expect(settings).toHaveCSS('translate', 'none');
            await page.evaluate(async () => {
                const { closeConversationSettings, openConversationSettings } = await import('/scripts/neconyan-conversation/settings-panel.js');
                closeConversationSettings();
                openConversationSettings();
            });
            await expect(settings).toHaveCSS('translate', 'none');
            await expect(settings).toHaveJSProperty('inert', false);
            await page.evaluate(async () => (await import('/scripts/neconyan-conversation/settings-panel.js')).closeConversationSettings());
            await expect(settings).toBeHidden();
            await expect(page.locator('#sb_conversation_settings_backdrop')).toBeHidden();
            await expect(page.locator('#sb_conversation_input')).toHaveValue('Keep this Conversation draft, too.');
            if (phone) {
                await page.locator('#sb_conversation_pals_toggle').tap();
                await assertDrawerMotion('sb_conversation_pals_rail');
                await page.evaluate(async () => {
                    const { closePalsRail, togglePalsRail } = await import('/scripts/neconyan-conversation/settings-panel.js');
                    closePalsRail();
                    togglePalsRail();
                });
                await expect(page.locator('#sb_conversation_pals_rail')).toHaveJSProperty('inert', false);
                await page.evaluate(async () => (await import('/scripts/neconyan-conversation/settings-panel.js')).closePalsRail());
                await expect(page.locator('#sb_conversation_pals_rail')).toBeHidden();
                await expect(page.locator('#sb_conversation_settings_backdrop')).toBeHidden();
            }
        });

        test('prompt editor opens at its final size and preserves an interrupted draft', async ({ page }) => {
            await openApp(page, phone, standalone);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await page.locator('#main_api').selectOption('openai');
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
            await page.getByRole('tab', { name: /Prompts/ }).click();
            await expect(page.locator('#completion_prompt_manager')).toBeVisible();
            await page.getByRole('button', { name: /^Expand Prompts/ }).click();
            await page.evaluate(() => new Promise(resolve => {
                window.$('#completion_prompt_manager_drawer > .inline-drawer-content').promise().done(() => resolve());
            }));
            const geometry = await page.evaluate(async () => {
                const { promptManager } = await import('/scripts/openai.js');
                promptManager.showPopup();
                const popup = promptManager.getPopupElement();
                const animation = popup.getAnimations()[0];
                const heights = [0, 90, 179].map(time => {
                    if (animation) { animation.pause(); animation.currentTime = time; }
                    return popup.getBoundingClientRect().height;
                });
                animation?.finish();
                return { heights, split: promptManager.isDesktopSplitLayout(), motion: window.motionDetails[popup.id] };
            });
            expect(geometry.heights[0]).toBeGreaterThan(100);
            expect(new Set(geometry.heights).size).toBe(1);
            if (!geometry.split) expect(geometry.motion.options.duration).toBe(180);
            const field = page.locator('#completion_prompt_manager_popup_entry_form_prompt');
            await field.fill('Keep this prompt draft.');
            await page.evaluate(async () => {
                const { promptManager } = await import('/scripts/openai.js');
                promptManager.hidePopup();
                promptManager.showPopup();
            });
            await expect(field).toHaveValue('Keep this prompt draft.');
            await expect(page.locator('#completion_prompt_manager_popup')).toHaveJSProperty('inert', false);
            await enableReducedMotion.device(page);
            const closed = await page.evaluate(async () => {
                const { promptManager } = await import('/scripts/openai.js');
                promptManager.hidePopup();
                return promptManager.isPopupVisible();
            });
            expect(closed).toBe(false);
        });

        for (const preference of ['app', 'device']) {
            test(`${preference} reduced motion settles an interrupted close and disables subsequent reveals`, async ({ page }) => {
                await openApp(page, phone, standalone);
                await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
                await expect(page.locator('#left-nav-panel')).toHaveCSS('translate', 'none');
                await page.evaluate(() => {
                    window.NeconyanShell.closeWorkspace();
                    document.getElementById('left-nav-panel').getAnimations().forEach(animation => animation.pause());
                });
                await enableReducedMotion[preference](page);
                await expect(page.locator('#left-nav-panel')).toBeHidden();
                await page.evaluate(() => { window.motionSurfaces = []; window.NeconyanShell.openTab('left', 'api'); });
                await expect(page.locator('#left-nav-panel')).toBeVisible();
                await page.evaluate(async () => {
                    window.NeconyanShell.closeWorkspace();
                    const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                    panel.openCompanionPanel();
                });
                await expect(page.locator('#ica--tracker-panel')).toBeVisible();
                await page.evaluate(async () => (await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js')).closeCompanionPanel());
                await expect(page.locator('#ica--tracker-panel')).toBeHidden();
                if (phone) {
                    await page.locator('#sb-hamburger').tap();
                    await expect(page.locator('#neconyan-workspace-rail')).toBeVisible();
                    await page.locator('#sb-hamburger').tap();
                    await expect(page.locator('#neconyan-workspace-rail')).toBeHidden();
                }
                expect(await page.evaluate(() => window.motionSurfaces)).toEqual([]);
                const popupMotion = await page.evaluate(async () => {
                    const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
                    const popup = new Popup('Reduced motion', POPUP_TYPE.TEXT);
                    void popup.show();
                    return getComputedStyle(popup.dlg).animationName;
                });
                expect(popupMotion).toBe('none');
            });
        }
    });
}
