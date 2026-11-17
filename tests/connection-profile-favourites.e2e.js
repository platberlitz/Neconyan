/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';

const profile = (id, name, folderId, fav) => ({ id, name, folderId, fav, mode: 'cc', api: 'openai', model: 'gpt-4o', exclude: [] });
const initialProfiles = [
    profile('root-favourite', 'Amber root', null, true),
    profile('folder-favourite', 'Basil folder', 'mixed', true),
    profile('only-favourite', 'Clover folder', 'only', true),
    profile('root-ordinary', 'Daisy root', null, false),
    profile('folder-ordinary', 'Elm folder', 'mixed', false),
];
const folders = [
    { id: 'mixed', name: 'Mixed', sortOrder: 0 },
    { id: 'only', name: 'Only favourites', sortOrder: 1 },
];

async function openConnections(page) {
    await page.goto('/');
    await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
    await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'api'));
    const management = page.locator('.neconyan-connection-management');
    if (!await management.evaluate(element => element.open)) await management.locator('summary').click();
    await expect(page.locator('#sb-connection_profiles-picker-button')).toBeVisible();
}

async function options(page) {
    return page.locator('#connection_profiles').evaluate(select => [...select.options].map(option => ({
        id: option.value,
        text: option.textContent,
        group: option.parentElement.tagName === 'OPTGROUP' ? option.parentElement.label : null,
        folder: option.dataset.folderId ?? null,
        favourite: option.dataset.favorite ?? null,
        selected: option.selected,
    })));
}

for (const { size, viewport, hasTouch } of [
    { size: 'phone', viewport: { width: 393, height: 852 }, hasTouch: true },
    { size: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false },
]) {
    for (const selectedId of ['folder-favourite', 'root-favourite']) {
        test(`favourite connection profiles stay unique and return to their place on ${size}: ${selectedId}`, async ({ browser }) => {
            const context = await browser.newContext({ viewport, hasTouch, serviceWorkers: 'block', reducedMotion: 'reduce' });
            const page = await context.newPage();
            const saves = [];
            page.on('request', request => {
                if (request.url().endsWith('/api/settings/save')) {
                    saves.push(request.postDataJSON().extension_settings.connectionManager);
                }
            });
            try {
                await isolateSettingsSaves(page, settings => {
                    settings.firstRun = false;
                    settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
                    settings.extension_settings.connectionManager = { profiles: structuredClone(initialProfiles), folders: structuredClone(folders), selectedProfile: selectedId };
                });
                await openConnections(page);
                const picker = page.locator('#sb-connection_profiles-picker');
                const toggle = page.locator('#toggle_profile_favorite');
                await page.locator('#sb-connection_profiles-picker-button').click();
                await expect(picker).toBeVisible();

                const initial = await options(page);
                expect(initial.map(option => option.id)).toEqual(['', 'root-favourite', 'folder-favourite', 'only-favourite', 'root-ordinary', 'folder-ordinary']);
                expect(initial.filter(option => option.group === '★ Favorites').map(option => option.id)).toEqual(['root-favourite', 'folder-favourite', 'only-favourite']);
                expect(initial.find(option => option.id === 'folder-favourite')).toMatchObject({ folder: 'mixed', favourite: 'true' });
                expect(initial.find(option => option.id === 'folder-ordinary').group).toBe('📁 Mixed');
                expect(initial.some(option => option.group === '📁 Only favourites')).toBe(false);
                expect(initial.find(option => option.id === selectedId).selected).toBe(true);
                await expect(picker.locator('.sb-chat-picker-row', { hasText: selectedId === 'folder-favourite' ? 'Basil folder' : 'Amber root' })).toHaveCount(1);
                await expect(toggle).toHaveAttribute('aria-pressed', 'true');

                await page.locator('#sb-connection_profiles-picker-button').click();
                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-pressed', 'false');
                let updated = await options(page);
                const moved = updated.find(option => option.id === selectedId);
                expect(updated.filter(option => option.id === selectedId)).toHaveLength(1);
                expect(moved).toMatchObject({ selected: true, favourite: 'false', group: selectedId === 'folder-favourite' ? '📁 Mixed' : null });
                await expect.poll(() => saves.at(-1)?.profiles.find(item => item.id === selectedId)?.fav).toBe(false);
                expect(saves.at(-1).selectedProfile).toBe(selectedId);
                expect(saves.at(-1).folders).toEqual(folders);

                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-pressed', 'true');
                updated = await options(page);
                expect(updated.find(option => option.id === selectedId)).toMatchObject({ selected: true, favourite: 'true', group: '★ Favorites' });
                expect(updated.filter(option => option.id === selectedId)).toHaveLength(1);
                const stored = await page.evaluate(async () => (await import('/scripts/extensions.js')).extension_settings.connectionManager);
                expect(stored.selectedProfile).toBe(selectedId);
                expect(stored.profiles).toEqual(initialProfiles);
                expect(stored.folders).toEqual(folders);
                await expect.poll(() => saves.at(-1)?.profiles.find(item => item.id === selectedId)?.fav).toBe(true);
                expect(saves.at(-1).selectedProfile).toBe(selectedId);
                expect(saves.at(-1).profiles).toEqual(initialProfiles);
                expect(saves.at(-1).folders).toEqual(folders);
            } finally {
                await context.close().catch(() => {});
            }
        });
    }
}
