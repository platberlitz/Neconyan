/* global document, window */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 900 } });

let created = {};
test.afterEach(async ({ request }) => {
    const fixtures = created;
    created = {};
    const csrf = await request.get('/csrf-token');
    const { token } = await csrf.json();
    const headers = { 'X-CSRF-Token': token };
    if (fixtures.groupId) {
        const response = await request.post('/api/groups/delete', { headers, data: { id: fixtures.groupId } });
        expect(response.ok()).toBe(true);
    }
    if (fixtures.avatar) {
        const response = await request.post('/api/characters/delete', { headers, data: { avatar_url: fixtures.avatar } });
        expect(response.ok()).toBe(true);
    }
});

test('a group created in the library opens and saves its first chat', async ({ page }) => {
    test.setTimeout(60000);
    const suffix = Date.now();
    const characterName = `Group check ${suffix}`;
    const groupName = `First chat ${suffix}`;
    let avatar;
    let groupId;
    let headers;

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyBunnyShell && !document.getElementById('preloader'));
    headers = await page.evaluate(async () => (await import('/script.js')).getRequestHeaders());
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await page.getByRole('button', { name: 'Create character', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(characterName);
    const characterResponse = page.waitForResponse(response => response.url().endsWith('/api/characters/create'));
    await page.getByRole('button', { name: 'Create character', exact: true }).click();
    const createdCharacter = await characterResponse;
    expect(createdCharacter.ok()).toBe(true);
    avatar = await createdCharacter.text();
    created.avatar = avatar;
    await expect(page.getByRole('button', { name: `Open chat with ${characterName}`, exact: true })).toBeVisible();

    await page.getByRole('tab', { name: 'Groups', exact: true }).click();
    await page.locator('#rm_button_group_chats').click();
    await page.getByRole('textbox', { name: 'Group name', exact: true }).fill(groupName);
    await page.locator('#rm_group_filter').fill(characterName);
    await page.locator('#rm_group_add_members .group_member').filter({ hasText: characterName }).getByRole('button', { name: /Add$/ }).click();
    const groupResponse = page.waitForResponse(response => response.url().endsWith('/api/groups/create'));
    await page.locator('#rm_group_submit').click();
    const createdGroup = await groupResponse;
    expect(createdGroup.ok()).toBe(true);
    const group = await createdGroup.json();
    groupId = group.id;
    created.groupId = groupId;
    expect(group.chat_id).toBe('');
    expect(group.chats).toEqual([]);

    const firstLoad = page.waitForResponse(response => response.url().endsWith('/api/chats/group/get'));
    await page.getByRole('button', { name: `Open ${groupName}`, exact: true }).click();
    expect((await firstLoad).ok()).toBe(true);
    await expect.poll(async () => {
        const response = await page.request.post('/api/groups/all', { headers, data: {} });
        const saved = (await response.json()).find(item => item.id === groupId);
        if (!saved?.chat_id) return 0;
        const info = await page.request.post('/api/chats/group/info', { headers, data: { id: saved.chat_id } });
        return info.status();
    }).toBe(200);
});
