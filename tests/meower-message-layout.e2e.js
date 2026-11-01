/* global document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { normalizeSettings, normalizeSession } from '../public/scripts/extensions/third-party/Neconyan-Hopper/src/core.js';

test.setTimeout(180000);

async function seedMessages(account) {
    const store = await (await account.context.request.get('/api/plugins/hopper/store')).json();
    const persona = `persona:${account.personaId}`;
    const character = `character:${account.avatar}`;
    store.settings = normalizeSettings({ activeSessionId: 'one', profiles: {
        [persona]: { name: 'Dawn Galatea', handle: 'invisible_wolf' },
        [character]: { name: 'Nova', handle: 'nova' },
    }, sessions: { one: normalizeSession({ id: 'one', name: 'Friends', personaId: account.personaId,
        invited: [account.avatar], ambient: false }, 'one') } });
    const createdAt = 1793581200000;
    store.feeds = { one: { version: 1, epoch: 'fixture', posts: [
        { id: 'post', authorKey: character, authorSnapshot: { kind: 'character', name: 'Nova', handle: 'nova' },
            body: 'The moon is out. Who is going to howl first?', createdAt },
    ], interactions: [
        { id: 'reply', postId: 'post', type: 'reply', actorKey: persona,
            actorSnapshot: { kind: 'persona', name: 'Dawn Galatea', handle: 'invisible_wolf' },
            content: 'Stop trying to make me howl or I’ll bite you.', createdAt: createdAt + 1 },
        ...['like', 'like', 'like', 'repost', 'repost'].map((type, index) => ({
            id: `reaction-${index}`, postId: 'post', parentInteractionId: 'reply', type,
            actorKey: `ambient:guest-${index}`, createdAt: createdAt + 2 + index,
            actorSnapshot: { kind: 'ambient', name: `Guest ${index}`, handle: `guest_${index}` },
        })),
    ] } };
    await account.post('/api/plugins/hopper/store', store);
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Meower reply actions fit without squeezing Delete`, async ({ app }, info) => {
        const account = await app.account({ phone });
        await seedMessages(account);
        const page = await account.open({ workspace: false });
        await page.evaluate(async () => (await import('/scripts/extensions/third-party/Neconyan-Hopper/src/ui.js')).openFeed());
        const reply = page.locator('[data-post-id="post"] [data-reply-id="reply"]').first();
        await expect(reply.getByRole('button', { name: 'Delete your reply' })).toBeVisible();
        await expect(page.locator('#toast-container')).toBeHidden({ timeout: 15000 });
        await reply.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('messages.png') });
        for (const scale of [1, 1.5]) {
            await page.evaluate(scale => document.documentElement.style.setProperty('--fontScale', String(scale)), scale);
            const layout = await reply.locator('.sbtw-reply-actions').evaluate(row => {
                const bounds = row.getBoundingClientRect();
                return { width: row.clientWidth, contentWidth: row.scrollWidth,
                    controls: [...row.querySelectorAll('button')].map(button => {
                        const rect = button.getBoundingClientRect();
                        const label = button.querySelector('span:not(.sbtw-action-count)');
                        const icon = button.querySelector('i');
                        return { label: button.getAttribute('aria-label') || button.textContent,
                            inside: rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
                            textFits: button.scrollWidth <= button.clientWidth + 1,
                            separated: !label || !icon || label.getBoundingClientRect().left >= icon.getBoundingClientRect().right + 4 };
                    }) };
            });
            expect(layout.contentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1);
            for (const control of layout.controls) {
                expect(control.inside, control.label).toBe(true);
                expect(control.textFits, control.label).toBe(true);
                expect(control.separated, control.label).toBe(true);
            }
        }
        await reply.getByRole('button', { name: /^Reply to @/ }).click();
        await expect(reply.locator('textarea')).toBeVisible();
    });
}
