/* global document, getComputedStyle, requestAnimationFrame */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { openNotes, notesApi } from './notebooks-browser-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const styles = ['calico', 'cozy-warm', 'slate-flat', 'clean-minimal', 'macos-minimal', 'windows-aero', 'windows-98', 'hypr-glow', 'kittyless'];

for (const phone of [false, true]) {
    test(`Notes primary buttons keep the native colour pair on ${phone ? 'iPhone-emulated' : 'desktop'} layouts`, async ({ browser }, testInfo) => {
        test.setTimeout(180000);
        const viewport = phone ? { width: 393, height: 852 } : { width: 1280, height: 900 };
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport }), baseURL: testInfo.project.use.baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            const page = await context.newPage();
            await openNotes(page, viewport);
            await expect(page.locator('#neconyan-notes .notes-pane-nav').getByRole('button', { name: 'New note', exact: true })).toBeVisible();
            await page.evaluate(async () => {
                const { button } = await import('/scripts/notebooks/dom.js');
                const reference = button('Native primary reference', () => {}, { className: 'menu_button_primary', icon: 'fa-file-circle-plus' });
                reference.id = 'notes-primary-reference';
                document.querySelector('#neconyan-notes .notes-pane-nav .notes-nav-actions').append(reference);
            });
            for (const shell of styles) {
                if (shell !== 'calico') await page.addStyleTag({ url: `/css/shell-styles/${shell}.css` });
                await page.evaluate(shell => { document.documentElement.dataset.sbTheme = shell; }, shell);
                if (phone) await applyIOSOnlyCss(page);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                const colours = await page.evaluate(() => {
                    const read = element => {
                        const style = getComputedStyle(element);
                        return { color: style.color, background: style.backgroundColor, image: style.backgroundImage, icon: getComputedStyle(element.querySelector('i')).color, text: getComputedStyle(element.querySelector('span')).color };
                    };
                    const actual = document.querySelector('#neconyan-notes .notes-pane-nav .notes-primary');
                    return { actual: read(actual), reference: read(document.querySelector('#notes-primary-reference')), height: actual.getBoundingClientRect().height };
                });
                expect(colours.actual, `${shell}: use the theme's complete native primary-button colour pair`).toEqual(colours.reference);
                if (phone) expect(colours.height).toBeGreaterThanOrEqual(44);
                if (shell === 'slate-flat') await page.screenshot({ path: testInfo.outputPath('new-note-colours.png') });
            }
            await page.locator('#notes-primary-reference').evaluate(element => element.remove());
            await page.locator('#neconyan-notes .notes-pane-nav').getByRole('button', { name: 'New note', exact: true }).click();
            await expect(page.locator('.popup').getByRole('heading', { name: 'New note', exact: true })).toBeVisible();
            await page.locator('.popup').getByRole('button', { name: 'Cancel', exact: true }).click();
        } finally { await context.close(); }
    });
}

for (const phone of [false, true]) {
    test(`Notes selected tabs and AI choices keep native colours on ${phone ? 'iPhone-emulated' : 'desktop'} layouts`, async ({ browser }, testInfo) => {
        test.setTimeout(180000);
        const viewport = phone ? { width: 393, height: 852 } : { width: 1280, height: 900 };
        const context = await browser.newContext({ ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport }), baseURL: testInfo.project.use.baseURL, serviceWorkers: 'block', reducedMotion: 'reduce' });
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            const page = await context.newPage();
            await openNotes(page, viewport);
            const notebookId = await page.evaluate(async () => (await import('/scripts/notebooks/notes-app.js')).notesApp().state.notebookId);
            const created = await notesApi(page, '/notes/create', { notebookId, operationId: `browser:${randomUUID()}`, title: `Button colours ${randomUUID()}`, text: '# Colours\n\nA saved note.' });
            expect(created.status).toBe('success');
            await page.evaluate(async ({ notebookId, noteId }) => {
                const app = (await import('/scripts/notebooks/notes-app.js')).notesApp();
                await app.openNote(notebookId, noteId);
                const { button } = await import('/scripts/notebooks/dom.js');
                const reference = button('Native primary reference', () => {}, { className: 'menu_button_primary', icon: 'fa-pen' });
                reference.id = 'notes-selected-reference';
                reference.hidden = true;
                app.elements.root.append(reference);
            }, { notebookId, noteId: created.noteId });
            if (!phone) await page.getByRole('button', { name: 'Show notes beside the chat', exact: true }).click();
            for (const shell of styles) {
                if (shell !== 'calico') await page.addStyleTag({ url: `/css/shell-styles/${shell}.css` });
                await page.evaluate(shell => { document.documentElement.dataset.sbTheme = shell; }, shell);
                if (phone) await applyIOSOnlyCss(page);
                for (const pane of ['nav', 'note', 'details']) {
                    const tab = page.locator(`.notes-pane-tabs [data-pane="${pane}"]`);
                    await tab.click();
                    await expect(tab).toHaveClass(/menu_button_primary/);
                    if (pane === 'details') {
                        await page.locator('.notes-detail-tabs [data-tab="ai"]').click();
                        await expect(page.locator('.notes-detail-body [aria-pressed="true"]').first()).toBeVisible();
                    }
                    await page.mouse.move(0, 0);
                    await expect.poll(async () => page.locator('#neconyan-notes').evaluate(root => {
                        const read = element => {
                            const style = getComputedStyle(element);
                            return { colour: style.color, background: style.backgroundColor, image: style.backgroundImage, text: getComputedStyle(element.querySelector('span')).color };
                        };
                        const reference = read(root.querySelector('#notes-selected-reference'));
                        return [...root.querySelectorAll('.notes-button[aria-pressed="true"]')].map(element => ({ label: element.textContent, actual: read(element), reference,
                            icon: element.querySelector('i') ? getComputedStyle(element.querySelector('i')).color : null }))
                            .filter(pair => JSON.stringify(pair.actual) !== JSON.stringify(pair.reference) || (pair.icon && pair.icon !== pair.actual.colour));
                    }), { message: `${shell}/${pane}: selected backgrounds, text and icons use the native colour pair` }).toEqual([]);
                }
            }
            await page.locator('.notes-pane-tabs [data-pane="note"]').click();
            for (const view of ['read', 'outline', 'write']) {
                await page.locator(`.notes-view-tabs [data-view="${view}"]`).click();
                await expect(page.locator(`.notes-view-tabs [data-view="${view}"]`)).toHaveClass(/menu_button_primary/);
                await expect(page.locator('.notes-view-tabs .menu_button_primary')).toHaveCount(1);
            }
        } finally { await context.close(); }
    });
}
