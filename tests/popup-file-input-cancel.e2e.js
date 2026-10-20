/* global document, window */
import { expect, test } from '@playwright/test';

// Popup animations are off, as in connection-profile-scroll.e2e.js, so the 500ms fallback decides when the dialog is removed
// and `closing` is set synchronously. Playwright cannot drive the operating system's file picker, so the test dispatches the
// same bubbling `cancel` event a file input fires when the picker is dismissed.
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);

async function openPage(browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/');
    await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
    return { context, page };
}

const makePopup = (page, allowEscapeClose = true) => page.evaluate(async allowEscapeClose => {
    const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
    const content = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'file';
    content.append(input);
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', { allowEscapeClose });
    const record = window.__fileCancelPopup = { popup, input, settled: false, value: 'pending' };
    popup.show().then(value => { record.settled = true; record.value = value; });
}, allowEscapeClose);

const popupState = page => page.evaluate(() => {
    const { popup, settled, value } = window.__fileCancelPopup;
    return { open: popup.dlg.open, closing: popup.dlg.hasAttribute('closing'), connected: popup.dlg.isConnected, settled, value };
});

const cancelAt = (page, target) => page.evaluate(target => {
    const record = window.__fileCancelPopup;
    const node = target === 'input' ? record.input : record.popup.dlg;
    node.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
}, target);

test('dismissing a file picker leaves its popup open; Escape still closes it', async ({ browser }) => {
    const { context, page } = await openPage(browser);
    try {
        await makePopup(page);
        expect(await popupState(page)).toMatchObject({ open: true, closing: false });

        await cancelAt(page, 'input');
        // The base closes at once: complete(CANCELLED) sets the closing attribute synchronously with animations off.
        expect(await popupState(page)).toMatchObject({ open: true, closing: false, settled: false });

        await page.waitForTimeout(700);
        expect(await popupState(page)).toMatchObject({ open: true, closing: false, connected: true, settled: false });

        await cancelAt(page, 'dialog');
        await page.waitForTimeout(700);
        expect(await popupState(page)).toMatchObject({ open: false, connected: false, settled: true, value: null });
    } finally {
        await context.close();
    }
});

test('a blocked popup is not treated as closing-prevented by a file picker cancel', async ({ browser }) => {
    const { context, page } = await openPage(browser);
    try {
        await makePopup(page, false);
        await cancelAt(page, 'input');
        expect(await popupState(page)).toMatchObject({ open: true, closing: false, settled: false });

        // On the base the input cancel sets isClosingPrevented, so this close is undone by closeListener.
        await page.evaluate(() => new Promise(resolve => {
            const { popup } = window.__fileCancelPopup;
            popup.dlg.addEventListener('close', () => setTimeout(resolve, 0), { once: true });
            popup.dlg.close();
        }));
        expect(await popupState(page)).toMatchObject({ open: false, closing: false });
    } finally {
        await context.close();
    }
});

test('Escape and the double-Escape force-close still work with allowEscapeClose false', async ({ browser }) => {
    const { context, page } = await openPage(browser);
    try {
        await makePopup(page, false);
        await cancelAt(page, 'dialog');
        expect(await popupState(page)).toMatchObject({ open: true, closing: false });

        await cancelAt(page, 'dialog');
        const confirm = page.locator('dialog[open]').filter({ hasText: 'Force-close Blocking Popup' });
        await expect(confirm).toBeVisible();
        await confirm.locator('.popup-button-ok').click();
        await page.waitForTimeout(700);
        expect(await popupState(page)).toMatchObject({ open: false, connected: false, settled: true, value: null });
    } finally {
        await context.close();
    }
});
