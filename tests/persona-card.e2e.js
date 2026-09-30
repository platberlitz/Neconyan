/* global window, document, getComputedStyle, Image */
import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openPersonaEditor, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';

test.setTimeout(120000);

async function dismissTour(page) {
    await page.waitForFunction(async () => {
        const { eventSource, event_types } = await import('/scripts/events.js');
        return eventSource.autoFireLastArgs.has(event_types.APP_READY);
    });
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    await page.addLocatorHandler(skip, async () => {
        await skip.click();
        await skip.waitFor({ state: 'hidden' });
        await page.evaluate(() => window.NeconyanShell.openTab('characters', 'persona'));
    });
    if (await skip.isVisible()) await skip.click();
}

async function openPersonaBrowser(page) {
    const browse = page.locator('#persona_workspace_tab_browse');
    if (await browse.isVisible()) await browse.click();
}

for (const width of [393, 1280]) {
    test.describe(`Persona cards at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, isMobile: width === 393, hasTouch: width === 393 });

        test('imports a SillyBunny persona library without changing existing personas', async ({ page }, testInfo) => {
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await dismissTour(page);
            const before = await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar } = await import('/scripts/personas.js');
                window.NeconyanShell.openTab('characters', 'persona');
                return { names: { ...power_user.personas }, selected: user_avatar, defaultPersona: power_user.default_persona };
            });
            await openPersonaBrowser(page);
            const responsePromise = page.waitForResponse('**/api/avatars/import-persona');
            const chooserPromise = page.waitForEvent('filechooser');
            await page.locator('#persona_card_import').click();
            await (await chooserPromise).setFiles({ name: 'personas_20260930.json', mimeType: 'application/json', buffer: Buffer.from('\uFEFF' + JSON.stringify({
                personas: { 'old-rin.png': 'SillyBunny Rin', 'old-kit.png': 'SillyBunny Kit' },
                persona_descriptions: { 'old-rin.png': { description: 'Portable description.\n猫', title: 'Visitor', position: 4, depth: 7, role: 2,
                    appendices: [{ id: 'rain', name: 'Rain', description: 'Wet streets.' }], connections: [{ id: 'private' }], activeAppendices: { private: ['rain'] } } },
                default_persona: 'old-rin.png',
            })) });
            const response = await responsePromise;
            expect(response.status()).toBe(200);
            const imported = await response.json();
            expect(imported.personas).toHaveLength(2);
            expect(imported.missingAvatars).toBe(2);
            await expect(page.getByText('This persona backup contains no pictures. The imported personas use the default picture; you can replace it in Edit.', { exact: true })).toBeVisible();
            const metrics = await page.locator('#persona_card_import').boundingBox();
            expect(metrics.height).toBeGreaterThanOrEqual(width === 393 ? 44 : 32);
            expect(metrics.x + metrics.width).toBeLessThanOrEqual(width);
            await page.screenshot({ path: testInfo.outputPath('sillybunny-personas-imported.png') });
            await page.reload();
            await page.waitForFunction('document.getElementById("preloader") === null');
            const after = await page.evaluate(async avatars => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar } = await import('/scripts/personas.js');
                return { names: power_user.personas, selected: user_avatar, defaultPersona: power_user.default_persona,
                    entries: avatars.map(avatar => power_user.persona_descriptions[avatar]) };
            }, imported.personas.map(persona => persona.avatar));
            expect(after.names).toMatchObject(before.names);
            expect(after.selected).toBe(before.selected);
            expect(after.defaultPersona).toBe(before.defaultPersona);
            expect(after.entries[0]).toMatchObject({ description: 'Portable description.\n猫', title: 'Visitor', position: 4, depth: 7, role: 2,
                appendices: [{ id: 'rain', name: 'Rain', description: 'Wet streets.' }], connections: [], activeAppendices: {} });
            expect(after.entries[1].description).toBe('');
            for (const persona of imported.personas) {
                expect((await page.request.get(`/User Avatars/${persona.avatar}`)).ok()).toBe(true);
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        });

        test('exports and imports both formats, preserves content after reload and never replaces the original', async ({ page }, testInfo) => {
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await dismissTour(page);
            const original = await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar, setPersonaDescription } = await import('/scripts/personas.js');
                const { saveSettings } = await import('/script.js');
                power_user.personas[user_avatar] = 'Portable Rin';
                power_user.persona_descriptions[user_avatar] = {
                    description: 'Traveller {{user}}.\n猫', title: 'Moon traveller',
                    position: 4, depth: 7, role: 2, lorebook: 'Missing roundtrip lorebook',
                    appendices: [{ id: 'rain', name: 'Rain', description: 'The streets are wet.' }],
                    activeAppendices: { 'private-chat': ['rain'] }, connections: [],
                };
                setPersonaDescription();
                if (!await saveSettings(0, { returnResult: true })) throw new Error('Fixture save failed');
                window.NeconyanShell.openTab('characters', 'persona');
                return user_avatar;
            });
            await expect(page.locator('#PersonaManagement')).toBeVisible();
            const imports = [];
            for (const format of ['png', 'json']) {
                await openPersonaEditor(page);
                const exportButton = page.locator('#persona_card_export');
                await expect(exportButton).toBeVisible();
                await exportButton.scrollIntoViewIfNeeded();
                const metrics = await exportButton.evaluate(element => {
                    const rect = element.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, height: rect.height, display: getComputedStyle(element).display };
                });
                expect(metrics.left).toBeGreaterThanOrEqual(0);
                expect(metrics.right).toBeLessThanOrEqual(width);
                expect(metrics.height).toBeGreaterThanOrEqual(width === 393 ? 44 : 40);
                expect(metrics.display).not.toBe('none');
                await page.screenshot({ path: testInfo.outputPath(`${format}-export-controls.png`) });
                await exportButton.click();
                const downloadPromise = page.waitForEvent('download');
                await page.getByText(`${format.toUpperCase()} card`, { exact: true }).click();
                const download = await downloadPromise;
                expect(download.suggestedFilename()).toBe(`Portable Rin.persona.${format}`);
                const file = testInfo.outputPath(`roundtrip.persona.${format}`);
                await download.saveAs(file);
                await openPersonaBrowser(page);
                const importButton = page.locator('#persona_card_import');
                await expect(importButton).toBeVisible();
                const box = await importButton.boundingBox();
                expect(box.height).toBeGreaterThanOrEqual(width === 393 ? 44 : 32);
                expect(box.x + box.width).toBeLessThanOrEqual(width);
                const responsePromise = page.waitForResponse('**/api/avatars/import-persona');
                const chooserPromise = page.waitForEvent('filechooser');
                await importButton.click();
                await (await chooserPromise).setFiles(file);
                const response = await responsePromise;
                expect(response.status()).toBe(200);
                const imported = await response.json();
                imports.push(imported.avatar);
                expect(imported.avatar).not.toBe(original);
                await expect(page.getByText('Persona imported. Its linked lorebook is missing; import the lorebook separately and link it again.', { exact: true })).toBeVisible({ timeout: 30000 });
                await expect(page.locator(`.avatar-container[data-avatar-id="${imported.avatar}"]`)).toHaveCount(1);
                await page.screenshot({ path: testInfo.outputPath(`${format}-imported.png`) });
            }
            expect(new Set(imports).size).toBe(2);
            const json = JSON.parse(await fs.readFile(testInfo.outputPath('roundtrip.persona.json'), 'utf8'));
            expect(json.avatar).toMatch(/^data:image\/png;base64,/);
            expect(json.data.activeAppendices).toBeUndefined();
            const images = await page.evaluate(async avatars => {
                return Promise.all(avatars.map(async avatar => {
                    const image = new Image();
                    image.src = `/User Avatars/${encodeURIComponent(avatar)}`;
                    await image.decode();
                    const canvas = document.createElement('canvas');
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;
                    canvas.getContext('2d').drawImage(image, 0, 0);
                    return canvas.toDataURL();
                }));
            }, [original, ...imports]);
            expect(images[1]).toBe(images[0]);
            expect(images[2]).toBe(images[0]);
            await page.reload();
            await page.waitForFunction('document.getElementById("preloader") === null');
            const restored = await page.evaluate(async avatars => {
                const { power_user } = await import('/scripts/power-user.js');
                const { user_avatar } = await import('/scripts/personas.js');
                return { selected: user_avatar, entries: avatars.map(avatar => ({ name: power_user.personas[avatar], ...power_user.persona_descriptions[avatar] })) };
            }, imports);
            expect(restored.selected).toBe(original);
            for (const entry of restored.entries) {
                expect(entry).toMatchObject({
                    name: 'Portable Rin', description: 'Traveller {{user}}.\n猫', title: 'Moon traveller',
                    position: 4, depth: 7, role: 2, lorebook: '', connections: [], activeAppendices: {},
                    appendices: [{ id: 'rain', name: 'Rain', description: 'The streets are wet.' }],
                });
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        });
    });
}

test('rejects malformed cards and avatar paths without creating personas', async ({ page }) => {
    await openQuietChatForSmoke(page, { selectCharacter: false });
    const results = await page.evaluate(async () => {
        const { getRequestHeaders } = await import('/script.js');
        const list = async () => (await fetch('/api/avatars/get', { method: 'POST', headers: getRequestHeaders() })).json();
        const before = await list();
        const data = new FormData();
        data.append('avatar', new File(['{"spec":"neconyan_persona"}'], 'broken.persona.json', { type: 'application/json' }));
        const imported = await fetch('/api/avatars/import-persona', {
            method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: data,
        });
        const exported = await fetch('/api/avatars/export-persona', {
            method: 'POST', headers: getRequestHeaders(),
            body: JSON.stringify({ avatar: '../settings.json', name: 'Rin', descriptor: {}, format: 'json' }),
        });
        return { before, after: await list(), imported: imported.status, exported: exported.status };
    });
    expect(results.imported).toBe(400);
    expect(results.exported).toBe(400);
    expect(results.after).toEqual(results.before);
});

test('the legacy restore input validates the whole library before changing personas', async ({ page }) => {
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await dismissTour(page);
    const before = await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.personas);
    const response = page.waitForResponse('**/api/avatars/import-persona');
    await page.locator('#personas_restore_input').setInputFiles({
        name: 'invalid-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
            personas: { 'first.png': 'Must not be partially imported', 'invalid.png': 42 }, persona_descriptions: {},
        })),
    });
    expect((await response).status()).toBe(400);
    await expect(page.getByText('Could not import this persona file. Choose a persona card or a SillyTavern or SillyBunny persona backup JSON.', { exact: true })).toBeVisible();
    expect(await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.personas)).toEqual(before);
    await expect(page.locator('#personas_restore_input')).toHaveValue('');
});

test('keeps imported details available and reports a failed settings save', async ({ page }) => {
    await openQuietChatForSmoke(page, { selectCharacter: false });
    await dismissTour(page);
    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'persona'));
    await openPersonaBrowser(page);
    await page.locator('#persona_search_bar').fill('Nothing matches this search');
    const image = await fs.readFile(new URL('../public/img/user-default.png', import.meta.url));
    await page.route('**/api/settings/save', route => route.fulfill({ status: 500, body: 'Save unavailable' }));
    await page.locator('#persona_card_import_input').setInputFiles({
        name: 'save-failure.persona.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
            spec: 'neconyan_persona', spec_version: '1.0',
            data: { name: 'Retry me', description: 'Keep these details until saving works.' },
            avatar: `data:image/png;base64,${image.toString('base64')}`,
        })),
    });
    await expect(page.getByText('The persona is loaded, but its details could not be saved. Edit the persona to retry saving before reloading.', { exact: true })).toBeVisible({ timeout: 30000 });
    const imported = await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        const avatar = Object.keys(power_user.personas).find(key => power_user.personas[key] === 'Retry me');
        return { avatar, description: power_user.persona_descriptions[avatar]?.description };
    });
    expect(imported.description).toBe('Keep these details until saving works.');
    await expect(page.locator('#persona_search_bar')).toHaveValue('');
    await expect(page.locator(`.avatar-container[data-avatar-id="${imported.avatar}"]`)).toBeVisible();
    await expect(page.getByText('Persona card imported. Select it in Browse to use it.', { exact: true })).toHaveCount(0);
});
