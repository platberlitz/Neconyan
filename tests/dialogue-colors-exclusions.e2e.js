/* global window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const extension = '/scripts/extensions/third-party/sillytavern-character-colors/src';
const SCENARIO = 'Your Wife Wants To Divorce You';
const NARRATOR_RED = 'rgb(204, 34, 68)';

async function openDialogueColours(app, phone = false) {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
    if (phone) await installIPhoneSafari(account.context, { standalone: true });
    const page = await account.open({ workspace: false });
    await page.evaluate(async ({ avatar, extension, scenario }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        const { settings } = await import(`${extension}/state.js`);
        Object.assign(settings, {
            coloringEngine: 'llm', keepCardCharacter: false, autoPersonaCharacter: false,
            llmAttributionCheck: false, disableToasts: true, autoScanNewMessages: false,
        });
        const template = core.chat[0];
        const message = (name, mes, extra = {}) => ({ ...template, name, mes, swipes: undefined, swipe_id: undefined, extra: {}, ...extra });
        core.chat.splice(0, core.chat.length,
            message('Narrator', 'The rain kept falling. <font color="#cc2244">"Welcome back,"</font> the voice said.\n[COLORS:Narrator=#cc2244]'),
            message(scenario, '<font color="#22aa66">"We need to talk,"</font> Mira said. <font color="#ddaa00">"Fine,"</font> the room answered.\n[COLORS:Mira=#22aa66,Your Wife Wants To Divorce You=#ddaa00]', {
                swipes: [
                    '<font color="#22aa66">"We need to talk,"</font> Mira said. <font color="#ddaa00">"Fine,"</font> the room answered.\n[COLORS:Mira=#22aa66,Your Wife Wants To Divorce You=#ddaa00]',
                    '<font color="#22aa66">"Later,"</font> Mira said.\n[COLORS:Mira=#22aa66]',
                ],
                swipe_id: 0,
            }),
        );
        await core.saveChatConditional();
        await core.reloadCurrentChat();
        await (await import(`${extension}/color-blocks.js`)).scanAllMessages();
        window.NeconyanExtensions.focusUnit('Dialogue Colors');
    }, { avatar: account.avatar, extension, scenario: SCENARIO });
    if (phone) await applyIOSOnlyCss(page);
    return page;
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
        const page = await openDialogueColours(app, phone);

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
    });
}
