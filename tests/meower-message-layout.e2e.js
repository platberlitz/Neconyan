/* global document, getComputedStyle */
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
        { id: 'quote', postId: 'post', type: 'repost', actorKey: persona,
            content: 'That sounds like a yes.', createdAt: createdAt - 1 },
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
        const borderColours = [];
        for (const accent of [null, 'rgba(110, 231, 183, 1)', 'rgba(126, 34, 206, 1)']) {
            if (accent) await page.evaluate(rgba => {
                for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) {
                    document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba } }));
                }
            }, accent);
            const colours = await reply.evaluate(element => {
                const borders = [...document.querySelectorAll('.sbtw-post:not(.sbtw-post-compact), .sbtw-reply, .sbtw-quote-card')]
                    .map(card => {
                        const css = getComputedStyle(card);
                        return { widths: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth], colour: css.borderTopColor };
                    });
                const button = element.querySelector('.sbtw-action-danger');
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const ctx = canvas.getContext('2d');
                const ancestors = [];
                for (let node = button; node; node = node.parentElement) ancestors.unshift(node);
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, 1, 1);
                for (const node of ancestors) {
                    ctx.fillStyle = getComputedStyle(node).backgroundColor;
                    ctx.fillRect(0, 0, 1, 1);
                }
                const background = [...ctx.getImageData(0, 0, 1, 1).data];
                ctx.fillStyle = getComputedStyle(button).color;
                ctx.fillRect(0, 0, 1, 1);
                const foreground = [...ctx.getImageData(0, 0, 1, 1).data];
                const luminance = rgba => rgba.slice(0, 3).map(c => c / 255)
                    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
                    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
                const values = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
                return { borders, contrast: (values[1] + 0.05) / (values[0] + 0.05) };
            });
            expect(colours.borders.length).toBeGreaterThanOrEqual(4);
            for (const border of colours.borders) expect(border.widths).toEqual(['1px', '1px', '1px', '1px']);
            expect(colours.contrast).toBeGreaterThanOrEqual(4.5);
            borderColours.push(colours.borders[0].colour);
            await info.attach(`accent-${accent || 'default'}`, { body: JSON.stringify(colours), contentType: 'application/json' });
        }
        expect(new Set(borderColours).size).toBe(3);
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
                            textFits: !label || (label.scrollWidth <= label.clientWidth + 1
                                && label.getBoundingClientRect().left >= rect.left - 1
                                && label.getBoundingClientRect().right <= rect.right + 1),
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
