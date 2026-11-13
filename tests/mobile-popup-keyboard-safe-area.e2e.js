/* global document, window, getComputedStyle */
import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const publicRoot = new URL('../public/', import.meta.url);
const safariUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const KEYBOARD_VIEWPORT_HEIGHT = 460;

function extractFunction(source, name) {
    const match = source.match(new RegExp(`^(function ${name}\\([\\s\\S]*?^}$)`, 'm'));
    if (!match) throw new Error(`Missing production function: ${name}`);
    return match[1];
}

function extractDeclaration(source, name) {
    const match = source.match(new RegExp(`^((?:const|let) ${name} = [\\s\\S]*?;)`, 'm'));
    if (!match) throw new Error(`Missing production declaration: ${name}`);
    return match[1];
}

test.use({ viewport: { width: 390, height: 844 }, userAgent: safariUA, hasTouch: true, reducedMotion: 'reduce' });

// An iPhone home-screen app: status bar above, home indicator below.
async function mountFixture(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, right: 0, bottom: 34, left: 0 } });
    await page.route('**/*', route => route.abort());
    const rows = Array.from({ length: 30 }, (_, index) => `<p>Row ${index}</p>`).join('');
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, viewport-fit=cover, initial-scale=1"><style>* { box-sizing: border-box; }</style></head><body>
        <dialog class="popup wide_dialogue_popup vertical_scrolling_dialogue_popup" id="editor-popup">
            <div class="popup-body">
                <div class="popup-content"><div id="ica--editor">
                    <label for="editor-name">Name</label>
                    <input id="editor-name" class="text_pole" value="Plot Compass">
                    ${rows}
                </div></div>
                <div class="popup-controls">
                    <div class="popup-button-ok menu_button">Save</div>
                    <div class="popup-button-cancel menu_button">Cancel</div>
                </div>
            </div>
        </dialog>
        <dialog class="popup" id="plain-popup">
            <div class="popup-body">
                <div class="popup-content">${rows}<input id="plain-input" class="text_pole"></div>
                <div class="popup-controls"><div class="popup-button-ok menu_button">OK</div></div>
            </div>
        </dialog>
    </body></html>`);
    for (const [file, media] of [
        ['css/popup.css', 'all'],
        ['css/mobile-styles.css', '(max-width: 768px)'],
        ['scripts/extensions/in-chat-agents/style.css', 'all'],
    ]) {
        const style = await page.addStyleTag({ content: await fs.readFile(new URL(file, publicRoot), 'utf8') });
        await style.evaluate((element, media) => { element.media = media; }, media);
    }
    await page.evaluate(() => {
        const viewport = new window.EventTarget();
        Object.assign(viewport, { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });

    const tabs = await fs.readFile(new URL('scripts/neconyan-tabs.js', publicRoot), 'utf8');
    await page.addScriptTag({ content: [
        ...['NN_MOBILE_MEDIA_QUERY', 'MOBILE_IOS_KEYBOARD_MIN_HEIGHT_PX', 'MOBILE_POPUP_KEYBOARD_CLEARANCE_PX'].map(name => extractDeclaration(tabs, name)),
        ...['isMobileViewport', 'readFiniteViewportNumber', 'getLayoutViewportSize', 'getVisualViewportSize', 'isEditableElement',
            'isVisualViewportKeyboardOpen', 'getMobilePopupDialogForKeyboard', 'clearMobilePopupKeyboardShift',
            'clearAllMobilePopupKeyboardShifts', 'syncMobilePopupKeyboardShift',
        ].map(name => extractFunction(tabs, name)),
        'window.syncMobilePopupKeyboardShift = syncMobilePopupKeyboardShift;',
    ].join('\n') });
    if (errors.length) throw new Error(errors.join('\n'));
}

async function openAndFocus(page, dialogId, inputId) {
    await page.evaluate(({ dialogId, inputId }) => {
        document.getElementById(dialogId).showModal();
        document.getElementById(inputId).focus();
    }, { dialogId, inputId });
}

async function setKeyboard(page, height) {
    await page.evaluate(height => {
        window.visualViewport.height = height;
        window.syncMobilePopupKeyboardShift();
    }, height);
}

async function popupGeometry(page, dialogId, inputId) {
    return page.evaluate(({ dialogId, inputId }) => {
        const dialog = document.getElementById(dialogId);
        const style = getComputedStyle(dialog);
        const rect = element => {
            const { top, bottom } = element.getBoundingClientRect();
            return { top: Math.round(top), bottom: Math.round(bottom) };
        };
        return {
            dialog: rect(dialog),
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            content: rect(dialog.querySelector('.popup-content')),
            input: rect(document.getElementById(inputId)),
            lastButton: rect(dialog.querySelector('.popup-controls .menu_button:last-child')),
        };
    }, { dialogId, inputId });
}

test('a full-screen popup fills the space above the keyboard without a second safe-area gap', async ({ page }) => {
    await mountFixture(page);
    await openAndFocus(page, 'editor-popup', 'editor-name');

    const closed = await popupGeometry(page, 'editor-popup', 'editor-name');
    expect(closed.dialog).toEqual({ top: 0, bottom: 844 });
    expect(closed.paddingTop).toBe('47px');
    expect(closed.paddingBottom).toBe('34px');

    await setKeyboard(page, KEYBOARD_VIEWPORT_HEIGHT);
    const open = await popupGeometry(page, 'editor-popup', 'editor-name');
    // The sheet's own padding clears the status bar once; the keyboard hides the home indicator.
    expect(open.dialog).toEqual({ top: 0, bottom: KEYBOARD_VIEWPORT_HEIGHT });
    expect(open.paddingTop).toBe('47px');
    expect(open.paddingBottom).toBe('8px');
    expect(KEYBOARD_VIEWPORT_HEIGHT - open.lastButton.bottom).toBeLessThanOrEqual(24);
    expect(open.input.top).toBeGreaterThanOrEqual(open.content.top);
    expect(open.input.bottom).toBeLessThanOrEqual(open.content.bottom);

    await setKeyboard(page, 844);
    expect(await popupGeometry(page, 'editor-popup', 'editor-name')).toEqual(closed);
});

test('a centred popup keeps the status-bar gap but drops the home-indicator gap above the keyboard', async ({ page }) => {
    await mountFixture(page);
    await openAndFocus(page, 'plain-popup', 'plain-input');
    await setKeyboard(page, KEYBOARD_VIEWPORT_HEIGHT);

    const open = await popupGeometry(page, 'plain-popup', 'plain-input');
    expect(open.dialog.top).toBe(47);
    expect(open.dialog.bottom).toBe(KEYBOARD_VIEWPORT_HEIGHT - 16);
    // The focused field ends inside the scrolling content, not under the buttons.
    expect(open.input.bottom).toBeLessThanOrEqual(open.content.bottom);
});
