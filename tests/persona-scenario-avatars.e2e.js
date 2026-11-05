/* global window */
import { expect, test } from '@playwright/test';
import { Jimp } from '../src/jimp.js';
import { isolateSettingsSaves, openPersonaEditor, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

test.setTimeout(180000);

for (const phone of [true, false]) {
    test.describe(`Scenario Note avatars on ${phone ? 'phone' : 'desktop'}`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });

        test('stages uploads, preserves sent portraits and falls back after removal', async ({ page }) => {
            page.setDefaultNavigationTimeout(90000);
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage ??= {};
                settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
                settings.accountStorage['neconyanToolTourInvite.persona'] = 'seen';
            });
            await openQuietChatForSmoke(page);
            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, setPersonaDescription } = await import('/scripts/personas.js');
                power_user.personas[user_avatar] = 'Rin';
                power_user.persona_descriptions[user_avatar] = {
                    description: 'A traveller who always finds a reason to stay.',
                    appendices: [{ id: 'winter', name: 'Winter in Mondstadt', description: 'A familiar face at the tavern. Snow has closed the mountain road.' }],
                    activeAppendices: {},
                };
                setPersonaDescription();
                window.NeconyanShell.openTab('characters', 'persona');
            });
            await openPersonaEditor(page);
            await page.locator('#persona_appendices_heading').click();
            const card = page.locator('.persona-appendix-card[data-appendix-id="winter"]');
            const edit = card.locator('.persona_appendix_edit');
            const save = page.locator('dialog[open] .popup-button-ok');
            const cancel = page.locator('dialog[open] .popup-button-cancel');
            const upload = page.locator('#persona_appendix_avatar_input');
            const preview = page.locator('.persona-appendix-avatar-preview');
            await edit.click();
            await expect(page.getByRole('button', { name: 'Remove avatar', exact: true })).toHaveCount(0);
            await upload.setInputFiles('../public/img/user-default.png');
            await expect(preview).toHaveAttribute('src', /^data:image\//);
            await cancel.click();
            await expect(card.locator('img')).toHaveCount(0);

            await edit.click();
            const buffer = await new Jimp({ width: 1200, height: 1600, color: 0x7799aaff }).getBuffer('image/png');
            await upload.setInputFiles({ name: 'large-portrait.png', mimeType: 'image/png', buffer });
            await expect(preview).toHaveAttribute('src', /^data:image\//);
            await expect.poll(() => preview.evaluate(image => [image.naturalWidth, image.naturalHeight])).toEqual([768, 1024]);
            const portrait = await preview.getAttribute('src');
            expect(portrait.length).toBeLessThanOrEqual(96 * 1024);
            // A refresh normalises the model while the editor is still open.
            await page.evaluate(async () => (await import('/scripts/personas.js')).getOrCreatePersonaDescriptor());
            await save.click();
            await expect(card.locator('img')).toHaveAttribute('src', portrait);
            await card.getByRole('checkbox').check();

            const snapshot = await page.evaluate(async () => {
                const core = await import('/script.js');
                const personas = await import('/scripts/personas.js');
                const conversationPersonas = await import('/scripts/neconyan-conversation/personas.js');
                const { appendConversationMessage } = await import('/scripts/neconyan-conversation/message-writer.js');
                const avatar = core.characters[Number(core.this_chid)].avatar;
                conversationPersonas.setActiveConversationPersonaAppendixIds(personas.user_avatar, ['winter'], { avatar, groupId: '' });
                const roleplay = await core.sendMessageAsUser('Portrait snapshot test', '');
                const conversation = await appendConversationMessage('Portrait snapshot test', { role: 'user', name: 'Rin', groupId: '' }, avatar);
                window.scenarioAvatarMessages = { roleplay, conversation };
                return { roleplay: roleplay.force_avatar, conversation: conversation.extra.scenario_avatar };
            });
            expect(snapshot).toEqual({ roleplay: portrait, conversation: portrait });
            const sentPortrait = page.locator('#chat .mes[is_user="true"]').last().locator('.avatar img');
            await expect(sentPortrait).toHaveAttribute('src', portrait);

            await edit.click();
            await page.getByRole('button', { name: 'Remove avatar', exact: true }).click();
            await cancel.click();
            await expect(card.locator('img')).toHaveAttribute('src', portrait);
            await edit.click();
            await page.getByRole('button', { name: 'Remove avatar', exact: true }).click();
            await save.click();
            await expect(card.locator('img')).toHaveCount(0);
            const result = await page.evaluate(async () => {
                const personas = await import('/scripts/personas.js');
                const conversation = await import('/scripts/neconyan-conversation/personas.js');
                return {
                    current: personas.getPersonaScenarioAvatar(),
                    conversation: conversation.getConversationScenarioAvatar(),
                    oldRoleplay: window.scenarioAvatarMessages.roleplay.force_avatar,
                    oldConversation: window.scenarioAvatarMessages.conversation.extra.scenario_avatar,
                };
            });
            expect(result).toEqual({ current: '', conversation: '', oldRoleplay: portrait, oldConversation: portrait });
            await expect(sentPortrait).toHaveAttribute('src', portrait);
        });
    });
}
