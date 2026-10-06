/* global window */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { openNotes, notesApi, fillSource, expectSourceText, sourceText } from './notebooks-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

async function createCurrentNote(page) {
    const notebookId = await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().state.notebookId);
    const title = `Writing controls ${randomUUID()}`;
    const result = await notesApi(page, '/notes/create', { notebookId, operationId: `browser:${randomUUID()}`, title, text: '# Notes\n\nMy ideas.' });
    expect(result.status).toBe('success');
    await page.evaluate(async ({ notebookId, noteId }) => {
        const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
        await app.openNote(notebookId, noteId);
        app.setPane('note');
    }, { notebookId, noteId: result.noteId });
    return { notebookId, noteId: result.noteId, title };
}

for (const phone of [false, true]) {
    test(`Notes full-screen writing works on ${phone ? 'iPhone-emulated' : 'desktop'} layouts`, async ({ browser }, info) => {
        test.setTimeout(180000);
        const viewport = phone ? { width: 393, height: 852 } : { width: 1280, height: 900 };
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport }), baseURL: info.project.use.baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
        let page;
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            page = await context.newPage();
            await openNotes(page, viewport);
            await createCurrentNote(page);
            if (phone) await applyIOSOnlyCss(page);
            if (!phone) await page.getByRole('button', { name: 'Show notes beside the chat', exact: true }).click();
            await fillSource(page, '# Full screen\n\nA draft that must stay.');
            await page.evaluate(async () => { window.notesEditorBeforeFullscreen = (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor; });
            const root = page.locator('#neconyan-notes');
            const normal = await root.boundingBox();
            await root.getByRole('button', { name: 'Full screen', exact: true }).click();
            await expect(root).toHaveAttribute('data-writing-fullscreen', 'true');
            const expanded = await root.boundingBox();
            expect(expanded).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
            await expect(root.locator('.notes-header')).toBeHidden();
            await expect(root.locator('.notes-pane-nav')).toBeHidden();
            await expect(root.locator('.notes-status')).toBeVisible();
            await fillSource(page, '# Full screen\n\nEdited in full screen.');
            await expect(root.locator('.notes-status')).toHaveText('Saved on server', { timeout: 15000 });
            expect(await page.evaluate(async () => window.notesEditorBeforeFullscreen === (await import('/scripts/notebooks/notes-app.js')).notesApp().sourceEditor)).toBe(true);
            await page.screenshot({ path: info.outputPath('writing-fullscreen.png') });
            await root.getByRole('button', { name: 'Exit full screen', exact: true }).click();
            await expect(root).toHaveAttribute('data-writing-fullscreen', 'false');
            expect(await root.boundingBox()).toEqual(normal);
            await expectSourceText(page, '# Full screen\n\nEdited in full screen.');
            await root.getByRole('button', { name: 'Full screen', exact: true }).click();
            await page.keyboard.press('Escape');
            await expect(root).toHaveAttribute('data-writing-fullscreen', 'false');
            await root.getByRole('button', { name: 'Read', exact: true }).click();
            await expect(root.getByRole('button', { name: 'Full screen', exact: true })).toBeHidden();
        } finally {
            await page?.unrouteAll({ behavior: 'wait' });
            await context.close();
        }
    });

    test(`Notes start fresh assistant discussions without sending on ${phone ? 'iPhone-emulated' : 'desktop'} layouts`, async ({ browser }, info) => {
        test.setTimeout(180000);
        const viewport = phone ? { width: 393, height: 852 } : { width: 1280, height: 900 };
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport }), baseURL: info.project.use.baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
        let page;
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            page = await context.newPage();
            await openNotes(page, viewport);
            const note = await createCurrentNote(page);
            const text = '# My note\n\nDiscuss this exact text. [[Another note]]';
            await fillSource(page, text);
            if (phone) await applyIOSOnlyCss(page);
            const root = page.locator('#neconyan-notes');
            for (const [mode, assistant] of [['Roleplay', 'Taro'], ['Conversation', 'Nori'], ['Conversation', 'Miso'], ['Roleplay', 'Miso']]) {
                await root.getByRole('button', { name: 'Talk about this note', exact: true }).click();
                const dialog = page.locator('.notes-discussion-dialog');
                await expect(dialog.getByRole('button', { name: 'Miso', exact: true })).toBeVisible();
                await expect(dialog.getByRole('button', { name: 'Taro', exact: true })).toBeVisible();
                await expect(dialog.getByRole('button', { name: 'Nori', exact: true })).toBeVisible();
                await dialog.getByRole('button', { name: assistant, exact: true }).click();
                await dialog.getByRole('button', { name: 'Neutral', exact: true }).click();
                await dialog.getByRole('button', { name: mode, exact: true }).click();
                await page.screenshot({ path: info.outputPath(`choose-${mode.toLowerCase()}.png`) });
                await page.locator('.popup').getByRole('button', { name: 'Start chat', exact: true }).click();
                await expect(root).toBeHidden({ timeout: 60000 });
                const composer = page.locator(mode === 'Roleplay' ? '#send_textarea' : '#sb_conversation_input');
                await expect(composer).toBeVisible();
                await expect(composer).toHaveValue(new RegExp('Discuss this exact text'));
                await expect.poll(() => page.evaluate(() => window.NeconyanShell.getActiveMode())).toBe(mode.toLowerCase());
                const bounds = await composer.boundingBox();
                expect(bounds.width).toBeGreaterThan(100);
                expect(bounds.height).toBeGreaterThanOrEqual(phone ? 44 : 30);
                await page.screenshot({ path: info.outputPath(`opened-${mode.toLowerCase()}-${assistant.toLowerCase()}.png`) });
                const state = await page.evaluate(async mode => {
                    const core = await import('/script.js');
                    const context = await import('/scripts/neconyan-conversation/context.js');
                    const avatar = core.characters[core.this_chid].avatar;
                    return { avatar, userMessages: mode === 'Roleplay' ? core.chat.filter(message => message.is_user).length
                        : context.getActiveConversationBranch(avatar, { groupId: '' }).messages.length };
                }, mode);
                expect(state.avatar).toContain(assistant);
                expect(state.userMessages).toBe(0);
                await composer.fill('');
                await page.evaluate(async note => { await (await import('/scripts/notebooks/notes-app.js')).openNotes({ notebookId: note.notebookId, noteId: note.noteId }); }, note);
                await expectSourceText(page, text);
                if (mode === 'Conversation' && assistant === 'Miso') {
                    await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().setPane('details'));
                    await root.getByRole('button', { name: 'AI access', exact: true }).click();
                    await root.getByRole('button', { name: 'Share this note once', exact: true }).click();
                    await expect(composer).toHaveValue(new RegExp(`noteId ${note.noteId}, grantId`));
                    await expect(page.locator('#send_textarea')).toHaveValue('');
                    await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).hideNotes());
                    await expect(composer).toBeVisible();
                    await composer.fill('');
                    await page.evaluate(async note => {
                        const notes = await import('/scripts/notebooks/notes-app.js');
                        await notes.openNotes({ notebookId: note.notebookId, noteId: note.noteId });
                        notes.notesApp().setPane('note');
                    }, note);
                }
            }
            await root.getByRole('button', { name: 'Talk about this note', exact: true }).click();
            await page.locator('.popup').getByRole('button', { name: 'Not now', exact: true }).click();
            await expect(root).toBeVisible();
        } finally {
            await page?.unrouteAll({ behavior: 'wait' });
            await context.close();
        }
    });

    test(`Notes highlight the picked template and delete the open note to Trash on ${phone ? 'iPhone-emulated' : 'desktop'} layouts`, async ({ browser }, info) => {
        test.setTimeout(180000);
        const viewport = phone ? { width: 393, height: 852 } : { width: 1280, height: 900 };
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport }), baseURL: info.project.use.baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
        let page;
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            page = await context.newPage();
            await openNotes(page, viewport);
            if (phone) await applyIOSOnlyCss(page);
            const root = page.locator('#neconyan-notes');
            await root.locator('.notes-create-row').getByRole('button', { name: 'New note', exact: true }).click();
            const popup = page.locator('.popup:has(.notes-dialog)');
            const choices = popup.getByRole('group', { name: 'Start from' });
            const blank = choices.getByRole('button', { name: 'Blank note', exact: true });
            const location = choices.getByRole('button', { name: 'Location', exact: true });
            await expect(blank).toHaveAttribute('aria-pressed', 'true');
            await location.click();
            await expect(location).toHaveAttribute('aria-pressed', 'true');
            await expect(location).toHaveClass(/menu_button_primary/);
            await expect(blank).toHaveAttribute('aria-pressed', 'false');
            await expect(blank).not.toHaveClass(/menu_button_primary/);
            await expect(choices.locator('[aria-pressed="true"]')).toHaveCount(1);
            const title = `Delete me ${randomUUID()}`;
            await popup.getByLabel('Name', { exact: true }).fill(title);
            await popup.getByRole('button', { name: 'Create note', exact: true }).click();
            await expect(root.getByRole('textbox', { name: 'Note name', exact: true })).toHaveValue(title);
            await expect.poll(() => sourceText(page)).toContain('type: location');
            const { notebookId, noteId } = await page.evaluate(async () => {
                const { state } = (await import('/scripts/notebooks/notes-app.js')).notesApp();
                return { notebookId: state.notebookId, noteId: state.note.id };
            });

            await fillSource(page, '# Delete me\n\nTyped just before deleting.');
            await root.getByRole('button', { name: 'Delete', exact: true }).click();
            await page.locator('.popup').getByRole('button', { name: 'Move to Trash', exact: true }).click();
            await expect(root.locator('.notes-editor')).toBeHidden();
            await expect(root.locator('.notes-empty')).toBeVisible();
            expect((await notesApi(page, '/notes/read', { notebookId, noteId })).status).toBe('not_found');
            const { trash } = await notesApi(page, '/trash/list', { notebookId });
            const entry = trash.find(item => item.noteId === noteId);
            expect(entry?.title).toBe(title);
            const restored = await notesApi(page, '/trash/restore', { notebookId, trashId: entry.id, operationId: `browser:${randomUUID()}` });
            expect(restored.status).toBe('success');
            const reread = await notesApi(page, '/notes/read', { notebookId, noteId: restored.restoredAs ?? restored.noteId });
            expect(reread.note.text).toBe('# Delete me\n\nTyped just before deleting.');
        } finally {
            await page?.unrouteAll({ behavior: 'wait' });
            await context.close();
        }
    });
}
