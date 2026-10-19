/* global document, window, $, getComputedStyle */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// The buttons of the image review dialog stay readable on phones and at larger text sizes: no label is cropped, nothing makes the dialog
// scroll sideways, and the Save copies buttons and the Import button of each image row keep their one-line explanation directly beneath
// them. The dialog is measured in the browser, so a label that does not fit shows up as text outside its button.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const LINE = 'Only images stored in the chat.';
// The buttons the dialog must show, by view. The first two come from the second and third message of the fixture chat.
const CHAT_BUTTONS = ['Make this the gallery\'s chosen image', 'Use the copy already on this server', 'Save copies of selected images'];
const IMAGE_ROWS = 3;
const CHATS_BUTTONS = ['Save copies in selected chats'];
// The file picker of each image row is an Import button with a line beneath it (revision 7): one pair per image row, three rows in the fixture chat.
const IMPORT = 'Import';
const IMPORT_LINE = 'Or choose an image file to use as the compatible copy';
const SPLIT = { chat: 'Save copies of selected images', chats: 'Save copies in selected chats' };
// STRESS LABELS, not shipped wording: the two longest German button labels of the translation run (Make this the gallery's chosen image,
// Use the copy already on this server). They are wider than the English and test the wrapping rule on a label that does not fit.
const STRESS = {
    'Make this the gallery\'s chosen image': 'Dieses Bild als gewähltes Bild der Galerie festlegen',
    'Use the copy already on this server': 'Die Kopie verwenden, die schon auf diesem Server liegt',
};
const LABEL_SETS = [{ name: 'English', stress: false }, { name: 'German stress labels (CPY-12, CPY-13)', stress: true }];
const VIEWPORTS = [
    { name: 'phone 393x852', width: 393, height: 852, phone: true, sizes: [1, 1.25] },
    { name: 'phone 360x780', width: 360, height: 780, phone: true, sizes: [1, 1.5] },
    { name: 'desktop 1280x900', width: 1280, height: 900, phone: false, sizes: [1] },
];

// Every visible button of the dialog with its box and the boxes of its text, the dialog's scroll width, and for each button with a
// description the line it points to.
const measure = () => {
    const panel = document.querySelector('#prompt-media-review');
    const content = panel.closest('.popup-content');
    const box = rect => ({ l: rect.left, r: rect.right, t: rect.top, b: rect.bottom, w: rect.width, h: rect.height });
    const textBoxes = node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(box);
    };
    const buttons = [...panel.querySelectorAll('.menu_button')].map(button => {
        const line = document.getElementById(button.getAttribute('aria-describedby') ?? '');
        return { label: button.textContent, visible: button.checkVisibility() && button.getBoundingClientRect().width > 0, box: box(button.getBoundingClientRect()), text: textBoxes(button),
            line: line ? { content: line.textContent, visible: line.checkVisibility() && line.getBoundingClientRect().height > 0, box: box(line.getBoundingClientRect()), text: textBoxes(line) } : null };
    });
    return { buttons, scrollWidth: content.scrollWidth, clientWidth: content.clientWidth, fontScale: getComputedStyle(document.documentElement).getPropertyValue('--fontScale').trim() };
};

const openReview = async page => {
    await page.evaluate(async () => { void (await import('/scripts/prompt-media-ui.js')).showPromptMediaReview(); });
    const panel = page.locator('#prompt-media-review');
    await expect(panel.locator('[role="status"]')).toHaveText('Images listed.');
    await page.evaluate(() => document.fonts.ready);
    return panel;
};
const closeReview = async page => {
    await page.locator('dialog.popup:has(#prompt-media-review) .popup-button-ok').click();
    await expect(page.locator('#prompt-media-review')).toHaveCount(0);
};

// The German stress labels replace the English ones in the chat view only; the dialog is closed and built again for the next case.
const showStressLabels = async (page, stress, where) => {
    if (!stress) return;
    const replaced = await page.evaluate(map => Object.entries(map).map(([english, label]) => {
        const found = [...document.querySelectorAll('#prompt-media-review .menu_button')].filter(button => button.textContent === english);
        for (const button of found) button.textContent = label;
        return found.length;
    }), STRESS);
    expect(replaced, `${where}: each stress label replaces the buttons it names (one each)`).toEqual([1, 1]);
};

// The guards: each button the view must show is there exactly once, visible, with a box and some text, so no check below passes on nothing.
const expectShown = (shown, labels, where, count = 1) => {
    for (const label of labels) {
        const found = shown.buttons.filter(button => button.label === label);
        expect(found, `${where}: ${label} is shown exactly ${count} time(s)`).toHaveLength(count);
        for (const button of found) {
            expect(button.visible, `${where}: ${label} is visible`).toBe(true);
            expect(button.box.w * button.box.h, `${where}: ${label} has a box`).toBeGreaterThan(0);
            expect(button.text.length, `${where}: ${label} has text`).toBeGreaterThan(0);
        }
    }
};

// A button's line is visible, directly beneath it, starts at the button's left edge, and says what it should.
const expectLineBeneath = (button, name, text, where) => {
    expect.soft(button?.line?.visible, `${where}: the line under ${name} is visible`).toBe(true);
    if (!button?.line) return;
    expect.soft(button.line.content, `${where}: the line under ${name}`).toBe(text);
    expect.soft(button.line.box.t - button.box.b, `${where}: the gap between ${name} and its line`).toBeGreaterThanOrEqual(0);
    expect.soft(button.line.box.t - button.box.b, `${where}: the gap between ${name} and its line`).toBeLessThanOrEqual(8);
    expect.soft(button.line.text.length ? Math.abs(button.line.text[0].l - button.box.l) : Infinity, `${where}: the line under ${name} starts at the button's left edge`).toBeLessThanOrEqual(1);
};

// The checks, in order. Soft, so one run reports every case that fails.
const expectReadable = async ({ panel, shown, where, phone, split }) => {
    const visible = shown.buttons.filter(button => button.visible);
    // 1. Every text box lies inside its button, within 1 px.
    const cropped = visible.filter(button => button.text.some(text => text.l < button.box.l - 1 || text.r > button.box.r + 1 || text.t < button.box.t - 1 || text.b > button.box.b + 1))
        .map(button => ({ label: button.label, left: +(button.box.l - Math.min(...button.text.map(text => text.l))).toFixed(1), right: +(Math.max(...button.text.map(text => text.r)) - button.box.r).toFixed(1) }));
    expect.soft(cropped, `${where}: labels with text outside their button`).toEqual([]);
    // 2. The dialog does not scroll sideways.
    expect.soft(shown.scrollWidth, `${where}: the dialog's scroll width`).toBeLessThanOrEqual(shown.clientWidth + 1);
    // 3. The Save copies button of the view, and every Import button: its line is visible, directly beneath, starts at the button's left edge, and is
    //    the button's description (checked for the Save copies buttons and the first row's Import button below).
    expectLineBeneath(visible.find(candidate => candidate.label === split), split, LINE, where);
    for (const importButton of visible.filter(candidate => candidate.label === IMPORT)) expectLineBeneath(importButton, IMPORT, IMPORT_LINE, where);
    await expect.soft(panel.getByRole('button', { name: split, exact: true }), `${where}: the description of ${split}`).toHaveAccessibleDescription(LINE);
    // 4. On a phone every button is at least 44 px high.
    if (phone) expect.soft(visible.filter(candidate => candidate.box.h < 43.99).map(candidate => ({ label: candidate.label, h: candidate.box.h })), `${where}: buttons under 44 px`).toEqual([]);
    // 5. On a desktop every button is one line.
    else expect.soft(visible.filter(candidate => new Set(candidate.text.map(text => Math.round(text.t))).size > 1).map(candidate => candidate.label), `${where}: buttons on more than one line`).toEqual([]);
};

// One character, three messages: an image stored in the chat, the same image with a gallery choice that does not exist, and an image linked from this server.
const seedChat = (page, avatar) => page.evaluate(async ({ avatar, data }) => {
    const core = await import('/script.js');
    const context = window.SillyTavern.getContext();
    await context.getCharacters();
    await core.selectCharacterById(context.characters.findIndex(char => char.avatar === avatar), { switchMenu: false });
    const url = `data:image/png;base64,${data}`;
    core.chat.push({ name: 'User', is_user: true, is_system: false, mes: 'Embedded.', extra: { media: [{ type: 'image', url, title: 'Embedded' }] } },
        { name: 'User', is_user: true, is_system: false, mes: 'Gallery.', extra: { media: [{ type: 'image', url, title: 'Gallery' }], media_display: 'gallery', media_index: 5 } },
        { name: 'User', is_user: true, is_system: false, mes: 'Server.', extra: { media: [{ type: 'image', url: `${window.location.origin}/user/images/x.png`, title: 'Server' }] } });
    if (!await core.saveChatConditional()) throw new Error('Fixture chat was not saved.');
}, { avatar, data: png });

for (const viewport of VIEWPORTS) test(`${viewport.name}: review button labels stay inside their buttons, and the Save copies buttons keep their line beneath`, async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account({ phone: viewport.phone, contextOptions: { viewport: { width: viewport.width, height: viewport.height } } });
    const page = await account.open({ workspace: false });
    await seedChat(page, account.avatar);

    for (const size of viewport.sizes) {
        await page.evaluate(value => { $('#font_scale').val(value).trigger('input', { forced: true }); }, size);
        // The size must really have taken effect, or every case below would measure the ordinary size.
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fontScale').trim())).toBe(String(size));
        // ...and the body text has reached 15 px times the scale.
        await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)), { message: `Global Font Size ${size} reaches the body text`, timeout: 10000 }).toBeCloseTo(15 * size, 2);
        for (const labels of LABEL_SETS) {
            const where = `${viewport.name}, Global Font Size ${size}, ${labels.name}`;
            const panel = await openReview(page);
            await showStressLabels(page, labels.stress, where);
            const chat = await page.evaluate(measure);
            const shownLabels = CHAT_BUTTONS.map(label => labels.stress && STRESS[label] ? STRESS[label] : label);
            expectShown(chat, shownLabels, `${where}, Current chat`);
            expectShown(chat, [IMPORT], `${where}, Current chat`, IMAGE_ROWS);
            await expectReadable({ panel, shown: chat, where: `${where}, Current chat`, phone: viewport.phone, split: SPLIT.chat });

            await panel.getByRole('button', { name: 'Choose chats', exact: true }).click();
            await expect(panel.getByRole('button', { name: SPLIT.chats, exact: true })).toBeVisible();
            await expect(panel.locator('[role="status"]')).toHaveText('');
            await page.evaluate(() => document.fonts.ready);
            const chats = await page.evaluate(measure);
            expectShown(chats, CHATS_BUTTONS, `${where}, Choose chats`);
            await expectReadable({ panel, shown: chats, where: `${where}, Choose chats`, phone: viewport.phone, split: SPLIT.chats });
            await closeReview(page);
        }
    }
});

// The lines under the buttons are small description text in the emphasis colour (revisions 8 and 9). Their size is the size of the description directly
// above the Review chat images button in the settings drawer (it is in the page while the drawer is closed). Their colour is pinned by a probe: a paragraph
// styled with var(--SmartThemeEmColor) inside the line's own wrapper, read through the same serialiser and removed again. Everything is read inside the page, so
// the comparison is of computed values; under reduced motion every element has a near-zero transition, so each reading is polled until it settles.
const STYLE_SIZES = [1, 1.25, 1.5];
const readNoteStyles = ({ lines }) => {
    const problems = [];
    const style = (node, name) => getComputedStyle(node)[name];
    const reference = document.querySelector('#prompt-images-review')?.previousElementSibling;
    if (reference?.tagName !== 'SMALL' || !reference.textContent.startsWith('Images stay visible')) return ['the reference description above Review chat images was not found'];
    const paragraph = document.querySelector('#prompt-media-review > p');
    if (!paragraph?.textContent.startsWith('Choose what the model receives')) return ['the dialog\'s opening paragraph was not found'];
    const found = [...document.querySelectorAll('#prompt-media-review .menu_button[aria-describedby]')].map(button => ({ button, line: document.getElementById(button.getAttribute('aria-describedby')) }));
    if (found.length !== lines) problems.push(`expected ${lines} lines under buttons, found ${found.length}`);
    for (const { button, line } of found) {
        const name = `"${line.textContent.slice(0, 24)}" under ${button.textContent}`;
        // The emphasis colour as the browser serialises it, read from a probe inside the same wrapper and removed at once.
        const probe = document.createElement('p');
        probe.style.color = 'var(--SmartThemeEmColor)';
        line.parentElement.append(probe);
        const emphasis = style(probe, 'color');
        probe.remove();
        if (emphasis === style(paragraph, 'color')) problems.push(`${name}: the emphasis colour ${emphasis} equals the dialog paragraph colour, so the colour check would prove nothing`);
        if (style(line, 'color') !== emphasis) problems.push(`${name}: color ${style(line, 'color')}, emphasis colour ${emphasis}`);
        if (style(line, 'opacity') !== '1') problems.push(`${name}: opacity ${style(line, 'opacity')}, expected 1`);
        if (style(line, 'fontSize') !== style(reference, 'fontSize')) problems.push(`${name}: fontSize ${style(line, 'fontSize')}, settings description ${style(reference, 'fontSize')}`);
        if (!(parseFloat(style(line, 'fontSize')) < parseFloat(style(button, 'fontSize')))) problems.push(`${name}: not smaller than its button (${style(line, 'fontSize')} against ${style(button, 'fontSize')})`);
        if (!(parseFloat(style(line, 'fontSize')) < parseFloat(style(paragraph, 'fontSize')))) problems.push(`${name}: not smaller than the dialog's paragraph text (${style(line, 'fontSize')} against ${style(paragraph, 'fontSize')})`);
    }
    return problems;
};

for (const viewport of VIEWPORTS) test(`${viewport.name}: the lines under the buttons are small description text in the emphasis colour, at every Global Font Size`, async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account({ phone: viewport.phone, contextOptions: { viewport: { width: viewport.width, height: viewport.height } } });
    const page = await account.open({ workspace: false });
    await seedChat(page, account.avatar);
    for (const size of STYLE_SIZES) {
        await page.evaluate(value => { $('#font_scale').val(value).trigger('input', { forced: true }); }, size);
        // Wait for the size to settle: the body text is 15 px times the scale.
        await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)), { message: `Global Font Size ${size} reaches the body text`, timeout: 10000 }).toBeCloseTo(15 * size, 2);
        const where = `${viewport.name}, Global Font Size ${size}`;
        const panel = await openReview(page);
        // The three Import lines and the Save copies line of the image list.
        await expect.poll(() => page.evaluate(readNoteStyles, { lines: IMAGE_ROWS + 1 }), { message: `${where}, Current chat: the lines are small, in the emphasis colour, with no opacity`, timeout: 10000 }).toEqual([]);
        await panel.getByRole('button', { name: 'Choose chats', exact: true }).click();
        await expect(panel.getByRole('button', { name: SPLIT.chats, exact: true })).toBeVisible();
        // The Save copies line of Choose chats.
        await expect.poll(() => page.evaluate(readNoteStyles, { lines: 1 }), { message: `${where}, Choose chats: the line is small, in the emphasis colour, with no opacity`, timeout: 10000 }).toEqual([]);
        await closeReview(page);
    }
});

// The Import button of the file picker (revision 7). Both tests work in the first image row, since each of the three rows has the button and the picker input.
const PICKER_VIEWPORTS = [{ name: 'phone 393x852 (touch)', phone: true }, { name: 'desktop 1280x900', phone: false }];
const reviewIsOpen = page => page.evaluate(() => Boolean(document.querySelector('dialog[open] #prompt-media-review')));
const stayedOpen = async page => {
    // A closing dialog takes a moment to leave, so wait before reading it.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 700)));
    return reviewIsOpen(page);
};
const previewOf = page => page.locator('dialog').filter({ has: page.getByRole('heading', { name: 'Save this compatible copy?' }) });

for (const viewport of PICKER_VIEWPORTS) test(`${viewport.name}: the file picker is an Import button that Tab reaches and Enter opens, and cancelling the preview leaves the review open`, async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account({ phone: viewport.phone });
    const page = await account.open({ workspace: false });
    await seedChat(page, account.avatar);
    const panel = await openReview(page);
    const row = panel.locator('fieldset').first();
    const pick = row.getByRole('button', { name: IMPORT, exact: true });
    await expect(pick, 'the first image row has exactly one Import button').toHaveCount(1);
    await expect(row.locator('label').filter({ hasText: IMPORT_LINE }), 'the picker sentence is no longer a label').toHaveCount(0);
    await expect(pick).toHaveAccessibleDescription(IMPORT_LINE);
    // Registered before the Tab step, so the chooser the key press opens is never missed.
    const chooserPromise = page.waitForEvent('filechooser');
    await row.getByRole('button', { name: 'Prepare a converted copy', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(pick).toBeFocused();
    await page.keyboard.press('Enter');
    const chooser = await chooserPromise;
    expect(await chooser.element().evaluate((node, expected) => node === expected, await row.locator('input[type="file"]').elementHandle()), 'the chooser belongs to this row\'s input').toBe(true);
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles({ name: 'probe.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const preview = previewOf(page);
    await expect(preview.getByAltText('Prepared compatible copy')).toBeVisible();
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(preview).toHaveCount(0);
    expect(await reviewIsOpen(page), 'the review is still open after the preview is cancelled').toBe(true);
    await expect(pick).toBeEnabled();
});

for (const viewport of PICKER_VIEWPORTS) test(`${viewport.name}: dismissing the file picker keeps the review open, and the same file can be chosen again`, async ({ app }) => {
    test.setTimeout(240000);
    const account = await app.account({ phone: viewport.phone });
    const page = await account.open({ workspace: false });
    await seedChat(page, account.avatar);
    const panel = await openReview(page);
    const row = panel.locator('fieldset').first();
    const input = row.locator('input[type="file"]');
    const file = { name: 'probe.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') };
    const preview = previewOf(page);
    // Choose a file, then cancel the preview. The same file must be choosable again: the input is empty, so the browser fires change once more.
    await input.setInputFiles(file);
    await expect(preview.getByAltText('Prepared compatible copy')).toBeVisible();
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect.soft(input, 'the input is cleared after its file is read').toHaveValue('');
    await input.setInputFiles(file);
    await expect(preview.getByAltText('Prepared compatible copy')).toBeVisible();
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(preview).toHaveCount(0);
    // A browser fires 'cancel' at the input when its picker is dismissed. It bubbles, and the dialog would take it for its own cancel and close the review.
    await input.evaluate(node => node.dispatchEvent(new Event('cancel', { bubbles: true })));
    expect.soft(await stayedOpen(page), 'the review stays open when the file picker is dismissed').toBe(true);
});
