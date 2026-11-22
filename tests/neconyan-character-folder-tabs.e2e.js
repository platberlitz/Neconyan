/* global window */
import { expect, test } from '@playwright/test';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.describe.configure({ mode: 'serial' });

async function openCharacters(page, phone) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120000 });
    const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
    if (await skip.isVisible()) await skip.click();
    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
    const root = page.locator('#rm_characters_block');
    const later = root.locator('.neconyan-tool-tour-invite button').filter({ hasText: 'Not now' });
    if (await later.isVisible()) await later.click();
    if (phone) await applyIOSOnlyCss(page);
    await page.addStyleTag({ content: '#toast-container, #nn-update-toast { display: none !important; }' });
    await expect(page.locator('#neconyan-folder-tabs')).toBeVisible({ timeout: 30000 });
}

for (const phone of [false, true]) {
    test(`Folder tabs sort a JanitorAI import into its own folder: ${phone ? 'iPhone emulation' : 'desktop'}`, async ({ browser }, testInfo) => {
        test.setTimeout(180000);
        const context = await browser.newContext({
            ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
            baseURL: testInfo.project.use.baseURL, reducedMotion: 'reduce', serviceWorkers: 'block',
        });
        const name = `Folder Tab Check ${phone ? 'Phone' : 'Desktop'} ${Date.now().toString(36)}`;
        let page;
        try {
            if (phone) await installIPhoneSafari(context, { standalone: false });
            page = await context.newPage();
            await openCharacters(page, phone);

            await page.evaluate(async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const tagsModule = await import('/scripts/tags.js');
                window.__folderTabsRestore = {
                    settings: power_user.character_folder_sort ? JSON.parse(JSON.stringify(power_user.character_folder_sort)) : undefined,
                    tagImport: power_user.tag_import_setting,
                    hadJanitor: tagsModule.tags.some(tag => tag.name === 'JanitorAI'),
                };
                power_user.tag_import_setting = tagsModule.tag_import_setting.NONE;
            });

            const rail = page.locator('#neconyan-folder-tabs-rail');
            const toggle = page.locator('#neconyan-folder-tabs .neconyan-folder-tabs-toggle');
            if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
            await expect(rail).toBeVisible();
            const all = rail.locator('.neconyan-folder-tab[data-folder-id=""]');
            if (await all.getAttribute('aria-pressed') !== 'true') await all.click();
            await expect(all).toHaveAttribute('aria-pressed', 'true');

            await page.locator('#neconyan-folder-tabs .neconyan-folder-tabs-organise').click();
            const organiser = page.locator('.neconyan-folder-organiser');
            await expect(organiser.locator('h3')).toHaveText('Organise folders');
            const bySite = organiser.locator('label').filter({ hasText: 'Sort imported characters by site' }).locator('input');
            if (!await bySite.isChecked()) await bySite.check({ force: true });
            await expect(organiser.locator('label').filter({ hasText: 'Make a folder for a site the first time' })).toBeVisible();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(organiser).toHaveCount(0);

            await page.evaluate(async (name) => {
                const script = await import('/script.js');
                const card = {
                    spec: 'chara_card_v2', spec_version: '2.0',
                    data: { name, description: 'A folder tab test card.', first_mes: 'Hello.', personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} },
                };
                const file = new File([JSON.stringify(card)], 'folder-tab-check.json', { type: 'application/json' });
                window.__folderTabsImport = 'running';
                script.processDroppedFiles([file], new Map(), { sourceUrl: 'https://janitorai.com/characters/folder-tab-check' })
                    .then(() => { window.__folderTabsImport = 'done'; }, error => { window.__folderTabsImport = `failed: ${error}`; });
            }, name);
            await expect.poll(() => page.evaluate(() => window.__folderTabsImport), { timeout: 60000 }).toBe('done');

            const janitor = rail.locator('.neconyan-folder-tab').filter({ has: page.locator('.neconyan-folder-tab-name', { hasText: /^JanitorAI$/ }) });
            await expect(janitor).toHaveCount(1);
            await expect.poll(() => page.evaluate(async (name) => {
                const script = await import('/script.js');
                const tagsModule = await import('/scripts/tags.js');
                const folder = tagsModule.tags.find(tag => tag.name === 'JanitorAI');
                const character = script.characters.find(item => item.name === name);
                return Boolean(folder && ['OPEN', 'CLOSED'].includes(folder.folder_type) && character && tagsModule.tag_map[character.avatar]?.includes(folder.id));
            }, name)).toBe(true);

            // Importing opens the new character, so go back to the list.
            await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
            await expect(page.locator('#neconyan-folder-tabs')).toBeVisible();
            await janitor.click();
            await expect(janitor).toHaveAttribute('aria-pressed', 'true');
            await expect(all).toHaveAttribute('aria-pressed', 'false');
            await expect(page.locator('#neconyan-folder-tabs .neconyan-folder-tabs-current')).toHaveText('JanitorAI');
            await expect(page.locator('#rm_characters_block .rm_tag_filter .tag.selected')).toHaveCount(1);
            await expect(page.locator('#rm_print_characters_block .character_select .ch_name').filter({ hasText: name })).toHaveCount(1);
            await all.click();
            await expect(all).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('#rm_characters_block .rm_tag_filter .tag.selected')).toHaveCount(0);

            if (phone) {
                const touch = await rail.evaluate(node => window.getComputedStyle(node).touchAction);
                expect(touch).toBe('pan-x');
            }
            const sizes = await rail.locator('.neconyan-folder-tab').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
            for (const height of sizes) expect(height).toBeGreaterThanOrEqual(phone ? 44 : 32);

            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(rail).toBeHidden();
            await toggle.click();
            await expect(rail).toBeVisible();
        } finally {
            if (page) {
                await page.evaluate(async (name) => {
                    const script = await import('/script.js');
                    const { power_user } = await import('/scripts/power-user.js');
                    const tagsModule = await import('/scripts/tags.js');
                    const restore = window.__folderTabsRestore;
                    if (!restore) return;
                    for (const character of script.characters.filter(item => item.name === name)) {
                        await fetch('/api/characters/delete', {
                            method: 'POST',
                            headers: script.getRequestHeaders(),
                            body: JSON.stringify({ avatar_url: character.avatar, delete_chats: true }),
                        });
                        delete tagsModule.tag_map[character.avatar];
                    }
                    if (!restore.hadJanitor) {
                        const index = tagsModule.tags.findIndex(tag => tag.name === 'JanitorAI');
                        if (index >= 0) tagsModule.tags.splice(index, 1);
                    }
                    if (restore.settings === undefined) delete power_user.character_folder_sort;
                    else power_user.character_folder_sort = restore.settings;
                    power_user.tag_import_setting = restore.tagImport;
                    // No character list refresh here: the deleted card is still open,
                    // and refreshing would raise the app's 'no longer available' reload prompt.
                    await script.saveSettings();
                }, name).catch(() => {});
            }
            await context.close();
        }
    });
}
