/* global window */
import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat } from './chat-scroll-regression-helpers.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

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

const personaKey = 'Example:\n[{{user}} speaks formally and never swears.]';
const personaFixture = 'Beispiel:\n[{{user}} spricht förmlich und flucht nie.]';

async function prepareGermanExamples(page, translatedPersona) {
    await page.addInitScript(() => window.localStorage.setItem('language', 'de-de'));
    if (translatedPersona) {
        await page.route('**/locales/neconyan/de-de.json', async route => {
            const response = await route.fetch();
            await route.fulfill({ response, json: { ...await response.json(), [personaKey]: personaFixture } });
        });
    }
}

async function captureNoteExample(page, input, filename) {
    const directory = process.env.NECONYAN_QUICK_FIX_SCREENSHOTS;
    if (!directory) return;
    await input.scrollIntoViewIfNeeded();
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/${filename}.png`, scale: 'css' });
}

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    test.describe(`Note placeholders on ${viewport}`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        for (const translatedPersona of [false, true]) {
            const personaExample = translatedPersona ? personaFixture : personaKey;
            const variant = translatedPersona ? 'fixture' : 'stock';
            test(`German examples with ${translatedPersona ? 'a persona translation fixture' : 'the shipped dictionary'}`, async ({ page }) => {
                const scenario = 'Beispiel:\n[Szenario: verrückte Abenteuer; Genre: romantische Komödie; Stil: wortreich, kreativ]';
                await prepareGermanExamples(page, translatedPersona);
                await isolateSettingsSaves(page, settings => {
                    settings.firstRun = false;
                    settings.accountStorage ??= {};
                    settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
                    settings.extension_settings.note = { default: '', chara: [] };
                });
                await openReadyChat(page);
                await expect(page.locator('html')).toHaveAttribute('lang', 'de-de');
                await dismissCrashNotice(page);
                await switchPersona(page, 'note-examples.png');
                await page.evaluate(async () => (await import('/scripts/authors-note.js')).openAuthorsNotePanel('character'));
                const fields = [
                    ['character', 'chara', scenario],
                    ['persona', 'persona', personaExample],
                    ['defaults', 'default', scenario],
                ];
                for (const [tab, slot, example] of fields) {
                    await page.locator(`#an_tab_${tab}`).click();
                    const input = page.locator(`#extension_floating_${slot}`);
                    await expect(input).toBeVisible();
                    await expect(input).toHaveValue('');
                    await captureNoteExample(page, input, `note-${viewport}-${tab}-${variant}`);
                    await expect.soft(input).toHaveAttribute('placeholder', example);
                    await input.fill(`My ${slot} note.`);
                }
                for (const [tab, slot] of fields) {
                    await page.locator(`#an_tab_${tab}`).click();
                    await expect(page.locator(`#extension_floating_${slot}`)).toHaveValue(`My ${slot} note.`);
                }
            });
        }
    });
}

for (const { phone, copied } of [true, false].flatMap(phone => [false, true].map(copied => ({ phone, copied })))) {
    const viewport = phone ? 'phone' : 'desktop';
    test.describe(`Character note libraries on ${viewport} (old copies: ${copied})`, () => {
        test.use(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } });

        test(`keeps the visible collection separate, including reloads (old copies: ${copied})`, async ({ page, context }) => {
            if (phone) await installIPhoneSafari(context, { standalone: false });
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage ??= {};
                settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
            });
            await openReadyChat(page);
            await dismissCrashNotice(page);
            await switchPersona(page, 'note-first.png');
            await page.evaluate(async copied => {
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
                if (copied) {
                    const [note] = extension_settings.note.chara;
                    note.personaNoteLibraries = Object.fromEntries(['note-first.png', 'note-second.png'].map(avatar => [avatar, {
                        profiles: structuredClone(note.profiles), activeProfile: 'tone', activeProfiles: note.personaActiveProfiles[avatar],
                    }]));
                }
                openAuthorsNotePanel('character');
            }, copied);
            if (phone) await applyIOSOnlyCss(page);
            const input = page.locator('#extension_floating_chara');
            await mkdir('../screenshots', { recursive: true });
            await page.screenshot({ path: `../screenshots/authors-note-visibility-${viewport}-${process.env.NECONYAN_NOTE_SCREENSHOT_STAGE || 'after'}${copied ? '-copied' : ''}.png`, scale: 'css' });
            await expect(page.locator('.an-note-name')).toHaveText(['Tone']);
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
            await expect(page.locator('.an-note-name')).toHaveText(['Setting']);
            await expect(page.locator('.an-note-row[data-an-note-id="setting"] .an-note-toggle')).toBeChecked();
            await expect(input).toHaveValue('Stay in the garden.');
            await expect(page.locator('.an-note-row')).toHaveCount(1);
            const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save')
                && response.request().postData()?.includes('Only my second persona uses this setting.'));
            await input.fill('Only my second persona uses this setting.');
            await saved;
            await openReadyChat(page);
            // Chat opening can select its own persona. Revisit the saved test persona explicitly.
            await switchPersona(page, 'note-second.png');
            await page.evaluate(async () => (await import('/scripts/authors-note.js')).openAuthorsNotePanel('character'));
            if (phone) await applyIOSOnlyCss(page);
            await expect(page.locator('.an-note-row')).toHaveCount(1);
            await expect(input).toHaveValue('Only my second persona uses this setting.');
            await switchPersona(page, 'note-first.png');
            await expect(firstOnly).toHaveCount(1);
            await firstOnly.locator('.an-note-toggle').uncheck();
            await expect(firstOnly).toHaveCount(1);
            await expect(firstOnly.locator('.an-note-toggle')).not.toBeChecked();
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
            await expect(firstOnly.locator('.an-note-toggle')).not.toBeChecked();
            await expect(input).toHaveValue('Only my first persona uses this tone.');
            const bounds = await input.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, right: rect.right, width: window.innerWidth };
            });
            expect(bounds.left).toBeGreaterThanOrEqual(0);
            expect(bounds.right).toBeLessThanOrEqual(bounds.width);
            const rowSize = await firstOnly.locator('.an-note-open').boundingBox();
            expect(rowSize.height).toBeGreaterThanOrEqual(44);

            await switchPersona(page, 'note-new.png');
            await expect(page.locator('.an-note-name')).toHaveText(['Default']);
            await expect(input).toHaveValue('');
            const snapshot = await page.evaluate(async () => {
                const { extension_settings } = await import('/scripts/extensions.js');
                const { captureScopedAuthorsNotes } = await import('/scripts/authors-note-profiles.js');
                return captureScopedAuthorsNotes(extension_settings.note.chara[0], null, 'note-new.png');
            });
            expect(snapshot.scoped.notes.every(note => !note.prompt)).toBe(true);
        });
    });
}
