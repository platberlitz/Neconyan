/* global document, window, Element, getComputedStyle */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference' });
test.setTimeout(90000);

const enableReducedMotion = {
    device: page => page.emulateMedia({ reducedMotion: 'reduce' }),
    app: page => page.locator('#reduced_motion').evaluate(input => {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
};

async function openApp(page) {
    await isolateSettingsSaves(page, settings => {
        settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        settings.power_user.reduced_motion = false;
    });
    await page.addInitScript(() => {
        window.motionSurfaces = [];
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
            window.motionSurfaces.push(this.id);
            return animate.apply(this, args);
        };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
}

for (const phone of [false, true]) {
    const press = phone ? 'tap' : 'click';
    test.describe(`${phone ? 'phone' : 'desktop'} motion`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });

        test('panels reverse cleanly, dialogs animate both ways and chat navigation settles', async ({ page }) => {
            await openApp(page);
            const panel = page.locator('#left-nav-panel');
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
            await expect(panel).toBeVisible();
            await expect.poll(() => page.evaluate(() => window.motionSurfaces.includes('left-nav-panel'))).toBe(true);
            await expect(panel).toHaveCSS('translate', 'none');
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
        });

        for (const preference of ['app', 'device']) {
            test(`${preference} reduced motion settles an interrupted close and disables subsequent reveals`, async ({ page }) => {
                await openApp(page);
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
