/* global window, localStorage */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const extension = '/scripts/extensions/third-party/sillytavern-character-colors/src';
const SCENARIO = 'Your Wife Wants To Divorce You';
const CARD_TITLE = 'Your Wife Will Divorce You';
const NARRATOR_RED = 'rgb(204, 34, 68)';
const dialogue = name => `<font color="#22aa66">"We need to talk,"</font> Mira said. <font color="#ddaa00">"Fine,"</font> the room answered.\n[COLORS:Mira=#22aa66,${name}=#ddaa00]`;

async function openDialogueColours(app, phone) {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
    if (phone) await installIPhoneSafari(account.context, { standalone: true });
    const created = await account.context.request.post('/api/characters/create', {
        headers: account.headers, data: { ch_name: CARD_TITLE, first_mes: dialogue(CARD_TITLE) },
    });
    expect(created.ok()).toBe(true);
    const titleAvatar = await created.text();
    const page = await account.open({ workspace: false });
    await page.evaluate(async ({ avatar, extension, scenario, firstSwipe }) => {
        const core = await import('/script.js');
        const { settings } = await import(`${extension}/state.js`);
        Object.assign(settings, {
            coloringEngine: 'llm', keepCardCharacter: false, autoPersonaCharacter: false,
            llmAttributionCheck: false, disableToasts: true, autoScanNewMessages: false,
        });
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        const template = core.chat[0];
        const message = (name, mes, extra = {}) => ({ ...template, name, mes, swipes: undefined, swipe_id: undefined, extra: {}, ...extra });
        core.chat.splice(0, core.chat.length,
            message('Narrator', 'The rain kept falling. <font color="#cc2244">"Welcome back,"</font> the voice said.\n[COLORS:Narrator=#cc2244]'),
            message(scenario, firstSwipe, {
                swipes: [
                    firstSwipe,
                    '<font color="#22aa66">"Later,"</font> Mira said.\n[COLORS:Mira=#22aa66]',
                ],
                swipe_id: 0,
            }),
        );
        await core.saveChatConditional();
        await core.reloadCurrentChat();
        await (await import(`${extension}/color-blocks.js`)).scanAllMessages();
        window.NeconyanExtensions.focusUnit('Dialogue Colors');
    }, { avatar: account.avatar, extension, scenario: SCENARIO, firstSwipe: dialogue(SCENARIO) });
    if (phone) await applyIOSOnlyCss(page);
    return { page, titleAvatar };
}

const fontColour = (page, mesid, index) => page.locator(`#chat .mes[mesid="${mesid}"] .mes_text font`).nth(index)
    .evaluate(element => window.getComputedStyle(element).color);
const textColour = (page, mesid) => page.locator(`#chat .mes[mesid="${mesid}"] .mes_text`)
    .evaluate(element => window.getComputedStyle(element).color);
const characterNames = page => page.evaluate(async extension => {
    const state = await import(`${extension}/state.js`);
    return Object.values(state.characterColors).map(entry => entry.name).sort();
}, extension);

// The drawer shows each page as a fold-out section; only fullscreen has tabs.
async function openPage(page, slug, press) {
    const section = page.locator(`#dc-page-${slug}`);
    if (!await section.evaluate(element => element.open)) await press(section.locator(':scope > summary'));
    await expect(section).toHaveAttribute('open', '');
}

for (const phone of [true, false]) {
    const viewport = phone ? 'phone' : 'desktop';
    const press = locator => phone ? locator.tap() : locator.click();
    test(`dialogue colours skips Narrator and names that are not characters on ${viewport}`, async ({ app }) => {
        test.setTimeout(180000);
        const { page, titleAvatar } = await openDialogueColours(app, phone);

        // A Narrator card stays in the normal text colour even when the model wrapped it in red.
        await expect.poll(() => fontColour(page, 0, 0)).toBe(await textColour(page, 0));
        expect(await fontColour(page, 0, 0)).not.toBe(NARRATOR_RED);
        const plain = await textColour(page, 1);
        await expect.poll(() => fontColour(page, 1, 0)).not.toBe(plain);
        const miraColour = await fontColour(page, 1, 0);
        expect(await fontColour(page, 1, 1)).not.toBe(plain);
        expect(await characterNames(page)).toEqual(['Mira', SCENARIO]);

        await openPage(page, 'automation', press);
        const narratorToggle = page.locator('#dc-skip-narrator-card');
        await expect(narratorToggle).toBeChecked();
        await expect(page.locator('#dc-excluded-name-list')).toContainText('Narrator');

        // Turning the Narrator option off lets the model's colour show again.
        await press(narratorToggle);
        await expect.poll(() => fontColour(page, 0, 0)).toBe(NARRATOR_RED);
        await expect(page.locator('#dc-excluded-name-list')).not.toContainText('Narrator');
        await press(narratorToggle);
        await expect.poll(() => fontColour(page, 0, 0)).toBe(await textColour(page, 0));

        // A scenario card name leaves the list and its lines lose their colour; Mira keeps hers.
        await page.locator('#dc-excluded-name-input').fill(SCENARIO);
        await press(page.locator('#dc-excluded-name-add'));
        await expect(page.locator('#dc-excluded-name-list .dc-excluded-remove')).toHaveCount(2);
        await expect.poll(() => characterNames(page)).toEqual(['Mira']);
        await expect.poll(() => fontColour(page, 1, 1)).toBe(plain);
        expect(await fontColour(page, 1, 0)).toBe(miraColour);
        const addRow = await page.locator('#dc-excluded-name-add').boundingBox();
        expect(addRow.height).toBeGreaterThanOrEqual(phone ? 40 : 28);
        expect(addRow.x + addRow.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.locator('#dc-excluded-name-list').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/dialogue-colors-not-characters-${viewport}-after.png` });

        // The model is told not to colour them, and the list survives a settings round trip.
        const prompt = await page.evaluate(async extension => (await import(`${extension}/prompts.js`)).buildExcludedSpeakerPromptRule(), extension);
        expect(prompt).toContain('"Narrator"');
        expect(prompt).toContain(`"${SCENARIO}"`);

        // Clean messages removes every [COLORS] line, including swipes, and Undo puts them back.
        await openPage(page, 'process', press);
        const clean = page.locator('#dc-clean-messages');
        await clean.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/dialogue-colors-clean-${viewport}-after.png` });
        await press(clean);
        const confirm = page.locator('.dc-dialog [data-dialog-value="confirm"]');
        await expect(confirm).toHaveText('Remove lines');
        await press(confirm);
        await expect(page.locator('.dc-dialog')).toHaveCount(0);
        const chatText = () => page.evaluate(async () => {
            const core = await import('/script.js');
            return core.chat.map(message => ({ mes: message.mes, swipes: message.swipes ?? [] }));
        });
        await expect.poll(async () => JSON.stringify(await chatText())).not.toContain('[COLORS');
        const cleaned = await chatText();
        expect(cleaned[1].mes).toContain('<font color="#22aa66">');
        expect(cleaned[1].swipes[1]).toBe('<font color="#22aa66">"Later,"</font> Mira said.');
        const undoToast = page.locator('#toast-container .toast', { hasText: 'Cleaned 2 messages' });
        await expect(undoToast).toBeVisible();
        await press(undoToast.locator('.toast-message'));
        await expect.poll(async () => (await chatText())[1].swipes[1]).toContain('[COLORS:Mira=#22aa66]');

        // Removing the tags too leaves plain text, with no colour left on any line.
        await page.locator('#dc-clean-target').selectOption('all');
        await press(clean);
        await expect(confirm).toHaveText('Remove lines and tags');
        await press(confirm);
        await expect.poll(async () => JSON.stringify(await chatText())).not.toContain('<font');
        expect((await chatText())[0].mes).toBe('The rain kept falling. "Welcome back," the voice said.');
        await expect(page.locator('#chat .mes[mesid="1"] .mes_text font')).toHaveCount(0);

        await test.step('Skip the active card title without adding a manual exclusion', async () => {
            await page.evaluate(async ({ avatar, extension }) => {
                const core = await import('/script.js');
                const { settings } = await import(`${extension}/state.js`);
                settings.keepCardCharacter = true;
                await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
                await (await import(`${extension}/color-blocks.js`)).scanAllMessages();
            }, { avatar: titleAvatar, extension });
            if (!await page.locator('#dc-page-automation > summary').isVisible()) {
                await page.evaluate(() => window.NeconyanExtensions.focusUnit('Dialogue Colors'));
            }
            await expect(page.locator('#dc-char-list .dc-char-name')).toHaveText(['Mira']);
            expect(await characterNames(page)).toEqual(['Mira']);
            const titleChatColour = await textColour(page, 0);
            await expect.poll(() => fontColour(page, 0, 1)).toBe(titleChatColour);
            expect(await fontColour(page, 0, 0)).not.toBe(titleChatColour);

            await openPage(page, 'automation', press);
            const exclusions = page.locator('#dc-excluded-name-list');
            await expect(exclusions.locator('.dc-excluded-remove')).toHaveCount(2);
            await expect(exclusions).not.toContainText(CARD_TITLE);
            await press(page.locator('#dc-excluded-current-card'));
            await expect(exclusions.locator('.dc-excluded-remove')).toHaveCount(2);
        });
    });
}

test('recoloring 1 message shows the full German save-failure warning when chat save fails', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account({ phone: false });
    await account.context.addInitScript(() => localStorage.setItem('language', 'de-de'));
    const page = await account.open({ workspace: false });

    const seedSavePromise = page.waitForResponse(response =>
        /\/api\/chats\/(save|patch)(?:\?|$)/.test(response.url()) && response.request().method() === 'POST');
    const seedSaved = await page.evaluate(async ({ avatar, extension }) => {
        const core = await import('/script.js');
        const { settings } = await import(`${extension}/state.js`);
        Object.assign(settings, {
            coloringEngine: 'llm',
            keepCardCharacter: false,
            autoPersonaCharacter: false,
            llmAttributionCheck: false,
            disableToasts: false,
            autoScanNewMessages: false,
        });
        if (!core.characters.some(character => character.avatar === avatar)) await core.getCharacters();
        const charIndex = core.characters.findIndex(character => character.avatar === avatar);
        if (charIndex < 0) throw new Error(`Fixture character ${avatar} not found`);
        await core.selectCharacterById(charIndex, { switchMenu: false });
        const template = core.chat[0];
        core.chat.splice(0, core.chat.length, {
            ...template,
            name: 'Mira',
            mes: '<font color="#22aa66">"Hello."</font> Mira said.\n[COLORS:Mira=#22aa66]',
            swipes: undefined,
            swipe_id: undefined,
            extra: {},
        });
        return await core.saveChatConditional();
    }, { avatar: account.avatar, extension });
    expect(seedSaved).toBe(true);
    expect((await seedSavePromise).status()).toBe(200);

    await page.evaluate(async extension => {
        const core = await import('/script.js');
        const { characterColors } = await import(`${extension}/state.js`);
        const { scanAllMessages } = await import(`${extension}/color-blocks.js`);
        await core.reloadCurrentChat();
        await scanAllMessages();
        const mira = Object.values(characterColors).find(entry => entry.name === 'Mira');
        if (!mira) throw new Error('Mira missing from characterColors after scanAllMessages()');
        Object.assign(mira, { color: '#ff5500', baseColor: '#ff5500' });
        if (!window.NeconyanShell?.openIncludedTool?.('sillytavern-character-colors')) {
            window.NeconyanExtensions.focusUnit('Dialogfarben');
        }
    }, extension);

    await openPage(page, 'process', locator => locator.click());
    let interceptedHits = 0;
    await page.route(/\/api\/chats\/(save|patch)(?:\?|$)/, route => {
        interceptedHits += 1;
        return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'simulated save failure' }),
        });
    });
    await page.locator('#dc-recolor').click();
    await page.locator('.dc-dialog [data-dialog-value="confirm"]').click();
    await expect(page.locator('#toast-container .toast-warning .toast-message'))
        .toHaveText('1 Nachricht umgefärbt; der Host hat das Speichern des Chats nicht bestätigt.');
    expect(interceptedHits).toBeGreaterThanOrEqual(1);
});
