/* global document, MutationObserver, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat } from './chat-scroll-regression-helpers.js';

test.setTimeout(90000);

for (const phone of [true, false]) {
    test.describe(`Author's Note typing on ${phone ? 'phone' : 'desktop'}`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone });

        test('defers panel redraws in every note tab while keeping prompt data and saving current', async ({ page }) => {
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage ??= {};
                settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
            });
            await openReadyChat(page);
            await page.evaluate(async () => {
                const { extension_settings } = await import('/scripts/extensions.js');
                const { chat_metadata } = await import('/script.js');
                const { user_avatar } = await import('/scripts/personas.js');
                const { openAuthorsNotePanel } = await import('/scripts/authors-note.js');
                const { getCharaFilename } = await import('/scripts/utils.js');
                extension_settings.note.default = '';
                delete chat_metadata.note_prompt;
                chat_metadata.note_interval = 1;
                const profiles = Array.from({ length: 24 }, (_, index) => ({
                    id: `typing-${index}`, name: `Note ${index + 1}`, prompt: '', position: 1,
                }));
                extension_settings.note.chara = [{ name: `individual:${getCharaFilename()}`, useChara: true,
                    profiles, activeProfiles: ['typing-0'], activeProfile: 'typing-0' }];
                extension_settings.note.persona = { [user_avatar]: { useNote: true,
                    profiles: [{ id: 'default', name: 'Default', prompt: '', position: 2 }], activeProfile: 'default' } };
                openAuthorsNotePanel('defaults');
            });

            for (const [tab, slot] of [['defaults', 'default'], ['chat', 'prompt'], ['character', 'chara'], ['persona', 'persona']]) {
                await page.locator(`[data-an-tab="${tab}"]`).click();
                const input = page.locator(`#extension_floating_${slot}`);
                await expect(input).toBeVisible();
                await input.focus();
                const result = await page.evaluate(async (slot) => {
                    const { extension_settings } = await import('/scripts/extensions.js');
                    const { chat_metadata, extension_prompts } = await import('/script.js');
                    const { user_avatar } = await import('/scripts/personas.js');
                    const input = document.getElementById(`extension_floating_${slot}`);
                    const observer = new MutationObserver(() => {});
                    for (const id of ['extension_floating_chara_notes', 'an_in_use', 'persona_author_note_status']) {
                        observer.observe(document.getElementById(id), { subtree: true, childList: true, attributes: true });
                    }
                    for (const character of `${slot} typing test`) {
                        input.value += character;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    const mutations = observer.takeRecords().length;
                    observer.disconnect();
                    const stored = slot === 'default' ? extension_settings.note.default
                        : slot === 'prompt' ? chat_metadata.note_prompt
                            : slot === 'chara' ? extension_settings.note.chara[0].profiles[0].prompt
                                : extension_settings.note.persona[user_avatar].profiles[0].prompt;
                    const rect = input.getBoundingClientRect();
                    return { value: input.value, stored, mutations, prompt: extension_prompts['2_floating_prompt'].value,
                        inViewport: rect.left >= 0 && rect.right <= window.innerWidth && rect.width > 0 };
                }, slot);
                expect(result.stored).toBe(result.value);
                expect(result.prompt).toContain(result.value);
                expect(result.mutations).toBe(0);
                expect(result.inViewport).toBe(true);
                await expect(page.locator(`[data-an-tab="${tab}"]`)).toHaveClass(/has-note/);
                await expect(input).toBeFocused();

                const saved = page.waitForRequest(request => {
                    if (!request.url().endsWith(slot === 'prompt' ? '/api/chats/save' : '/api/settings/save')) return false;
                    return request.postData()?.includes(`${result.value} more text`);
                });
                await input.press('Control+End');
                await input.pressSequentially(' more text', { delay: 40 });
                await expect(input).toHaveValue(`${result.value} more text`);
                await saved;
            }
        });
    });
}
