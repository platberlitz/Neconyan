/* global window */
import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat } from './chat-scroll-regression-helpers.js';

test.setTimeout(240000);

async function switchPersona(page, avatar) {
    await page.evaluate(async avatar => {
        const { setUserAvatar } = await import('/scripts/personas.js');
        await setUserAvatar(avatar, { toastPersonaNameChange: false, readOnlyRoute: true });
    }, avatar);
}

async function nameNote(page, name) {
    const dialog = page.locator('dialog[open]');
    await dialog.locator('.popup-input').fill(name);
    await dialog.locator('.popup-button-ok').click();
}

async function dismissCrashNotice(page) {
    const dismiss = page.locator('[data-crash-action="dismiss"]');
    if (await dismiss.isVisible()) await dismiss.click();
}

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test.describe(`Character note libraries on ${viewport}`, () => {
        test.use({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone });

        test('keeps saved notes, their names and selections separate when switching personas', async ({ page }) => {
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage ??= {};
                settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
            });
            await openReadyChat(page);
            await dismissCrashNotice(page);
            await switchPersona(page, 'note-first.png');
            await page.evaluate(async () => {
                const { extension_settings } = await import('/scripts/extensions.js');
                const { chat_metadata } = await import('/script.js');
                const { openAuthorsNotePanel } = await import('/scripts/authors-note.js');
                const { getCharaFilename } = await import('/scripts/utils.js');
                const { power_user } = await import('/scripts/power-user.js');
                power_user.personas['note-first.png'] = 'First persona';
                power_user.personas['note-second.png'] = 'Second persona';
                chat_metadata.note_interval = 1;
                extension_settings.note.chara = [{ name: `individual:${getCharaFilename()}`, useChara: true,
                    perPersona: true, activeProfile: 'tone', activeProfiles: ['tone'],
                    profiles: [
                        { id: 'tone', name: 'Tone', prompt: 'Keep the tone gentle.', position: 2 },
                        { id: 'setting', name: 'Setting', prompt: 'Stay in the garden.', position: 1 },
                    ], personaActiveProfiles: { 'note-first.png': ['tone'], 'note-second.png': ['setting'] } }];
                openAuthorsNotePanel('character');
            });
            const input = page.locator('#extension_floating_chara');
            await expect(input).toHaveValue('Keep the tone gentle.');
            await input.fill('Only my first persona uses this tone.');
            await page.locator('[data-an-profile-slot="chara"][data-an-profile-action="rename"]').click();
            await nameNote(page, 'First persona tone');
            await page.locator('[data-an-profile-slot="chara"][data-an-profile-action="new"]').click();
            await nameNote(page, 'First persona only');
            const firstOnly = page.locator('.an-note-row').filter({ hasText: 'First persona only' });
            await expect(firstOnly.locator('.an-note-toggle')).toBeChecked();
            await input.fill('Explore the lighthouse.');
            await expect(input).toHaveValue('Explore the lighthouse.');
            await page.locator('#extension_floating_chara_notes').scrollIntoViewIfNeeded();
            await dismissCrashNotice(page);
            await mkdir('../screenshots', { recursive: true });
            await page.screenshot({ path: `../screenshots/authors-note-library-${viewport}-after.png` });
            await switchPersona(page, 'note-second.png');
            await expect(firstOnly).toHaveCount(0);
            await expect(page.locator('.an-note-row[data-an-note-id="setting"] .an-note-toggle')).toBeChecked();
            await page.locator('.an-note-row[data-an-note-id="tone"] .an-note-open').click();
            await expect(input).toHaveValue('Keep the tone gentle.');
            await expect(page.locator('.an-note-row[data-an-note-id="tone"] .an-note-name')).toHaveText('Tone');
            await page.locator('[data-an-profile-slot="chara"][data-an-profile-action="delete"]').click();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(page.locator('.an-note-row')).toHaveCount(1);
            const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save')
                && response.request().postData()?.includes('Only my second persona uses this setting.'));
            await input.fill('Only my second persona uses this setting.');
            await saved;
            await openReadyChat(page);
            // Chat opening can select its own persona. Revisit the saved test persona explicitly.
            await switchPersona(page, 'note-second.png');
            await page.evaluate(async () => (await import('/scripts/authors-note.js')).openAuthorsNotePanel('character'));
            await expect(page.locator('.an-note-row')).toHaveCount(1);
            await expect(input).toHaveValue('Only my second persona uses this setting.');
            await switchPersona(page, 'note-first.png');
            await expect(firstOnly).toHaveCount(1);
            await firstOnly.locator('.an-note-open').click();
            await expect(input).toHaveValue('Explore the lighthouse.');
            await page.locator('.an-note-row[data-an-note-id="tone"] .an-note-open').click();
            await expect(input).toHaveValue('Only my first persona uses this tone.');
            await expect(page.locator('.an-note-row[data-an-note-id="tone"] .an-note-name')).toHaveText('First persona tone');
            await page.locator('#extension_floating_chara_per_persona').uncheck();
            await expect(page.locator('.an-note-row')).toHaveCount(2);
            await expect(input).toHaveValue('Keep the tone gentle.');
            await page.locator('#extension_floating_chara_per_persona').check();
            await expect(firstOnly).toHaveCount(1);
            await expect(input).toHaveValue('Only my first persona uses this tone.');
            const bounds = await input.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, right: rect.right, width: window.innerWidth };
            });
            expect(bounds.left).toBeGreaterThanOrEqual(0);
            expect(bounds.right).toBeLessThanOrEqual(bounds.width);
            const rowSize = await firstOnly.locator('.an-note-open').boundingBox();
            expect(rowSize.height).toBeGreaterThanOrEqual(44);
        });
    });
}
