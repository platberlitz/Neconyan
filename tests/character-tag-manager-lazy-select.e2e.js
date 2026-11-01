/* global window */
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function openTagManager(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120000 });

    const full = page.getByRole('button', { name: 'No, show me everything', exact: true });
    if (await full.isVisible()) await full.click();

    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible()) await skip.click();

    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'characters'));
    await page.locator('#right-nav-panel').waitFor({ state: 'visible' });

    if (!await page.locator('[title="Manage tags"]:visible').count()) {
        await page.getByText('Filter and organise', { exact: true }).click();
    }

    await page.locator('[title="Manage tags"]:visible').first().click();
    await page.locator('#tag_view_list:visible').waitFor();
}

async function readSettings(request) {
    const token = (await (await request.get('/csrf-token')).json()).token;
    const headers = { 'X-CSRF-Token': token };
    const response = await request.post('/api/settings/get', { headers, data: {} });
    if (!response.ok()) throw new Error(`Could not read settings: ${response.status()}`);
    return { headers, settings: JSON.parse((await response.json()).settings) };
}

async function saveSettings(request, headers, settings) {
    const response = await request.post('/api/settings/save', { headers, data: settings });
    if (!response.ok()) throw new Error(`Could not save settings: ${response.status()} ${await response.text()}`);
}

async function removeTestTag(request, page, tagName, tagId) {
    try {
        // Let any pending debounced settings write land before taking the cleanup snapshot.
        await page.waitForTimeout(1500);
    } catch {
        // The page may already be gone; the API cleanup below is still valid.
    }

    const matchesTag = tag => tag?.name === tagName || (tagId !== null && String(tag?.id) === String(tagId));

    for (let attempt = 0; attempt < 4; attempt++) {
        const { headers, settings } = await readSettings(request);
        const tags = Array.isArray(settings.tags) ? settings.tags : [];
        const removedIds = new Set(tags.filter(matchesTag).map(tag => String(tag.id)));
        const nextTags = tags.filter(tag => !matchesTag(tag));
        let changed = nextTags.length !== tags.length;

        if (tagId !== null) removedIds.add(String(tagId));

        const tagMap = settings.tag_map && typeof settings.tag_map === 'object' ? settings.tag_map : {};
        for (const key of Object.keys(tagMap)) {
            if (!Array.isArray(tagMap[key])) continue;
            const nextIds = tagMap[key].filter(id => !removedIds.has(String(id)));
            if (nextIds.length !== tagMap[key].length) {
                tagMap[key] = nextIds;
                changed = true;
            }
        }

        if (changed) {
            settings.tags = nextTags;
            settings.tag_map = tagMap;
            await saveSettings(request, headers, settings);
        }

        await new Promise(resolve => setTimeout(resolve, 400));

        const { settings: latest } = await readSettings(request);
        const tagStillPresent = (Array.isArray(latest.tags) ? latest.tags : []).some(matchesTag);
        const assignmentStillPresent = Object.values(latest.tag_map ?? {}).some(ids => Array.isArray(ids)
            && ids.some(id => removedIds.has(String(id))));

        if (!tagStillPresent && !assignmentStillPresent) return;
    }

    throw new Error(`Could not clean up test tag '${tagName}'.`);
}

test('lazy entity tag select keeps its empty placeholder and assigns the created tag', async ({ page, request }) => {
    test.setTimeout(120000);

    const tagName = `AAA Lazy Select ${Date.now()}`;
    let tagId = null;

    try {
        await openTagManager(page);

        await page.locator('#tag_view_create_input').fill(tagName);
        await page.locator('.tag_view_create').click();
        const card = page.locator('#tag_view_list .tag_view_item').filter({ has: page.locator('.tag_view_name', { hasText: tagName }) });
        await expect(card).toBeVisible();
        tagId = await card.evaluate(element => element.id);

        await page.locator('#neconyan_tag_manager_tab_entities').click();
        const row = page.locator('.neconyan-tag-entity-row').first();
        await expect(row).toBeVisible();

        const select = row.locator('.neconyan-tag-entity-add');
        await expect(select).toBeVisible();
        await select.focus();

        // Focusing must not auto-select the first tag. Removing the placeholder did that and
        // made a later pick of that same tag fire no change event.
        await expect.poll(async () => select.inputValue()).toBe('');

        expect(tagId).toBeTruthy();
        await select.selectOption(String(tagId));
        await expect(row.locator('.neconyan-tag-entity-chip-name').filter({ hasText: tagName })).toBeVisible();
    } finally {
        await removeTestTag(request, page, tagName, tagId);
    }
});
