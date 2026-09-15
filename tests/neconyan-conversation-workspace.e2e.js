/* global document, window, getComputedStyle */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
test.setTimeout(120000);

async function assertReadable(page, foregroundSelector, backgroundSelector) {
    const contrast = await page.evaluate(({ foregroundSelector, backgroundSelector }) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const luminance = bytes => [...bytes].slice(0, 3).map(channel => channel / 255)
            .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
            .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        context.fillStyle = getComputedStyle(document.querySelector(backgroundSelector)).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const background = luminance(context.getImageData(0, 0, 1, 1).data);
        context.fillStyle = getComputedStyle(document.querySelector(foregroundSelector)).color;
        context.fillRect(0, 0, 1, 1);
        const foreground = luminance(context.getImageData(0, 0, 1, 1).data);
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    }, { foregroundSelector, backgroundSelector });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
}

async function assertTouchTargets(root) {
    const short = await root.evaluate(element => [...element.querySelectorAll('button, [role="button"], select, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), .checkbox_label, .sb-conversation-persona-note-option, .sb-conversation-group-member-option, .sb-conversation-file-attachment')]
        .filter(control => control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden' && control.getBoundingClientRect().height < 43.5)
        .map(control => ({ name: control.id || control.getAttribute('aria-label') || control.textContent.trim(), height: control.getBoundingClientRect().height })));
    expect(short).toEqual([]);
}


for (const width of [1280, 390, 320]) {
    test.describe(`Conversation at ${width}px`, () => {
        test.use({ viewport: { width, height: 1000 }, isMobile: width < 768, hasTouch: width < 768 });
        for (const tone of ['dark', 'light']) {
            test(`${tone} labels, settings sections, Pals and message actions`, async ({ page }, info) => {
                page.setDefaultTimeout(20000);
                const errors = [];
                const modelRequests = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, route => {
                    modelRequests.push(route.request().url());
                    return route.fulfill({ status: 503, json: { error: 'No model calls during UI check' } });
                });
                if (tone === 'light') {
                    const { name, ...theme } = JSON.parse(readFileSync(new URL('../default/content/themes/Neconyan Calico.json', import.meta.url), 'utf8'));
                    await page.route('**/api/settings/get', async route => {
                        const response = await route.fetch();
                        const data = await response.json();
                        const settings = JSON.parse(data.settings);
                        Object.assign(settings.power_user, theme, { theme: name });
                        data.settings = JSON.stringify(settings);
                        await route.fulfill({ response, json: data });
                    });
                    await page.route('**/api/settings/save', route => route.fulfill({ json: { version: Date.now() } }));
                }
                await page.goto('/', { waitUntil: 'domcontentloaded' });
                await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
                const miso = page.locator('[data-assistant-personality="miso"]');
                await miso.locator('input[value="miso-male"]').check();
                await miso.locator('[data-assistant-open]').click();
                await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
                await page.locator('#send_textarea').fill('Keep my roleplay draft.');
                if (width < 769) await page.locator('#sb-hamburger').click();
                await page.locator(`#neconyan-workspace-rail [data-neconyan-chat-mode="conversation"]`).click();
                await expect(page.locator('#sb_conversation_stage')).toBeVisible();
                const header = page.locator('#sb_conversation_header');
                await header.getByRole('button', { name: 'New branch', exact: true }).click();
                await expect(page.locator('.sb-conversation-thread-empty')).toBeVisible();
                await expect(header.locator('[data-sb-conversation-connection-notice]')).toBeVisible();
                for (const id of ['sb_conversation_send', 'sb_conversation_toggle_tools', 'sb_conversation_attach']) {
                    await expect(page.locator(`#${id} span`)).toBeVisible();
                    if (width < 1000) expect((await page.locator(`#${id}`).boundingBox()).height).toBeGreaterThanOrEqual(44);
                }
                expect((await header.locator('.sb-conversation-header-name').boundingBox()).width).toBeGreaterThan(120);
                await expect(header.locator('.sb-conversation-header-name')).toHaveText('Miso (Male)');
                await expect(page.locator('#sb_conversation_stage .sb-conversation-composer-actions button span')).toHaveCount(3);
                const clippedLabels = await page.locator('#sb_conversation_stage .sb-conversation-composer-actions button span').evaluateAll(labels => labels.filter(label => {
                    const range = document.createRange();
                    range.selectNodeContents(label);
                    const text = range.getBoundingClientRect();
                    const button = label.closest('button').getBoundingClientRect();
                    return text.width && (text.left < button.left || text.right > button.right + 1 || text.bottom > button.bottom + 1);
                }).map(label => label.textContent));
                expect(clippedLabels).toEqual([]);
                await page.locator('#sb_conversation_input').fill('Keep my Conversation draft.');
                await page.evaluate(() => window.toastr?.remove());
                await assertReadable(page, '#sb_conversation_input', '.sb-conversation-composer');
                await page.screenshot({ path: info.outputPath('conversation-empty.png') });
                await header.getByRole('button', { name: 'DM settings', exact: true }).click();
                const drawer = page.locator('#sb_conversation_settings_drawer');
                await expect(drawer).toBeVisible();
                const expectedIds = JSON.parse(readFileSync(new URL('./fixtures/neconyan-conversation-settings-ids.json', import.meta.url), 'utf8'));
                const controlIds = await drawer.locator('input[id], select[id], textarea[id]').evaluateAll(nodes => nodes.map(node => node.id));
                expect(new Set(controlIds).size).toBe(controlIds.length);
                for (const id of expectedIds) expect(controlIds).toContain(id);
                await drawer.evaluate(element => {
                    element.dataset.navigationSaveEvents = '0';
                    element.addEventListener('change', () => { element.dataset.navigationSaveEvents = String(Number(element.dataset.navigationSaveEvents) + 1); });
                });
                for (const section of ['presence', 'timing', 'memory', 'prompt-context', 'media-actions']) {
                    // Phones show the same section buttons as a scrolling row, so the
                    // button click is the one control at every width.
                    await drawer.locator(`[data-sb-conversation-settings-section="${section}"]`).click();
                    const visibleGroups = await drawer.locator('[data-conversation-settings-section]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.conversationSettingsSection));
                    expect(visibleGroups.length).toBeGreaterThan(0);
                    expect(visibleGroups.every(value => value === section)).toBe(true);
                    if (section === 'timing') {
                        await drawer.getByRole('button', { name: 'Edit schedule', exact: true }).click();
                        await expect(page.locator('#sb_conversation_schedule_modal')).toBeVisible();
                        await page.keyboard.press('Escape');
                        await expect(page.locator('#sb_conversation_schedule_modal')).toHaveCount(0);
                        await expect(drawer).toBeVisible();
                    }
                    if (width < 1000) await assertTouchTargets(drawer);
                    if (section === 'presence') {
                        const fits = await drawer.locator('.sb-conversation-notification-grid select').evaluate(select => {
                            const context = document.createElement('canvas').getContext('2d');
                            const style = getComputedStyle(select);
                            context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                            return context.measureText(select.selectedOptions[0].text).width <= select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 28;
                        });
                        expect(fits).toBe(true);
                    }
                    const overflowing = await drawer.locator('[data-conversation-settings-section]:visible').evaluateAll(groups => groups.filter(group => group.scrollWidth > group.clientWidth + 1).map(group => group.dataset.conversationSettingsSection));
                    expect(overflowing).toEqual([]);
                    await page.screenshot({ path: info.outputPath(`settings-${section}.png`) });
                }
                await expect(drawer).toHaveAttribute('data-navigation-save-events', '0');
                await page.keyboard.press('Escape');
                await expect(drawer).toBeHidden();
                await expect(header.getByRole('button', { name: 'DM settings', exact: true })).toBeFocused();
                await page.evaluate(async () => {
                    const { getCurrentCharAvatar } = await import('/scripts/neconyan-conversation/context.js');
                    const { appendConversationThreadMessage } = await import('/scripts/neconyan-conversation/thread-store.js');
                    const { getSettings, saveSettings } = await import('/scripts/neconyan-conversation/settings-store.js');
                    const { scheduleInterfaceRefresh } = await import('/scripts/neconyan-conversation/render-scheduler.js');
                    const avatar = getCurrentCharAvatar();
                    const settings = getSettings(avatar);
                    settings.enabled = true;
                    settings.proactive_messaging = false;
                    saveSettings(avatar, settings);
                    appendConversationThreadMessage(avatar, { role: 'user', name: 'You', mes: 'A saved test message for the new action menu.' });
                    appendConversationThreadMessage(avatar, { role: 'character', name: 'Miso', mes: 'A purrfect afternoon for a little chat.' });
                    scheduleInterfaceRefresh({ syncControls: false });
                });
                await header.getByRole('button', { name: 'Pals', exact: true }).click();
                await page.locator('#sb_conversation_pals_search').fill('');
                await expect(page.locator('#sb_conversation_pals_list .sb-conversation-pal').first()).toBeVisible();
                if (width < 1000) await assertTouchTargets(page.locator('#sb_conversation_pals_rail'));
                if (width === 320 && tone === 'dark') {
                    await page.locator('#sb_conversation_pals_rail').getByRole('button', { name: 'Group chat', exact: true }).click();
                    await expect(page.locator('#sb_conversation_add_dm_picker')).toBeVisible();
                    await expect(page.locator('#sb_conversation_add_dm_picker').getByRole('button', { name: 'Create Group', exact: true })).toBeDisabled();
                    await assertTouchTargets(page.locator('#sb_conversation_pals_rail'));
                    await page.locator('#sb_conversation_add_dm_picker').getByRole('button', { name: 'Cancel', exact: true }).click();
                    await expect(page.locator('#sb_conversation_add_dm_picker')).toBeHidden();
                }
                await page.locator('#sb_conversation_pals_search').fill('no-pal-has-this-name');
                await expect(page.locator('#sb_conversation_pals_filter_empty')).toBeVisible();
                await assertReadable(page, '#sb_conversation_pals_filter_empty', '#sb_conversation_pals_rail');
                await page.screenshot({ path: info.outputPath('pals-filtered.png') });
                await page.keyboard.press('Escape');
                await expect(page.locator('#sb_conversation_pals_rail')).toHaveAttribute('data-open', 'false');
                const more = page.locator('.sb-conversation-more-actions').last();
                await expect(more).toBeVisible();
                await more.click();
                await expect(more).toHaveAttribute('aria-expanded', 'true');
                if (width < 1000) await assertTouchTargets(page.locator('#sb_conversation_stage'));
                await page.screenshot({ path: info.outputPath('message-actions.png') });
                await page.locator('.sb-conversation-message-text').last().click();
                await expect(more).toHaveAttribute('aria-expanded', 'false');
                await expect(page.locator('.sb-conversation-message-actions.open')).toHaveCount(0);
                await more.click();
                await page.keyboard.press('Escape');
                await expect(more).toHaveAttribute('aria-expanded', 'false');
                await expect(more).toBeFocused();
                await more.click();
                await page.locator('.sb-conversation-message-actions.open [data-sb-conversation-action="reply-message"]').click();
                await expect(page.locator('#sb_conversation_reply_preview')).toBeVisible();
                await page.locator('.sb-conversation-reply-cancel').click();
                await expect(page.locator('#sb_conversation_reply_preview')).toBeHidden();
                await page.locator('#sb_conversation_toggle_tools').click();
                await expect(page.locator('#sb_conversation_tools')).toBeVisible();
                if (width < 1000) await assertTouchTargets(page.locator('#sb_conversation_tools'));
                await expect(page.locator('#sb_conversation_input')).toHaveValue('Keep my Conversation draft.');
                await expect(page.locator('#send_textarea')).toHaveValue('Keep my roleplay draft.');
                const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
                expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
                expect(errors).toEqual([]);
                expect(modelRequests).toEqual([]);
                await page.unrouteAll({ behavior: 'wait' });
            });
        }
    });
}
