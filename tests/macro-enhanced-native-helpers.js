/* global document, window */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function openMacros(app, phone = false, options = {}) {
    const account = await app.account({ ...options, phone, configureSettings: settings => {
        settings.power_user.experimental_macro_engine = true;
        options.configureSettings?.(settings);
    } });
    const page = await account.open({ workspace: false });
    await page.waitForFunction(() => document.getElementById('me-settings-drawer'));
    await page.evaluate(() => {
        window.NeconyanShell.openIncludedTool('MacroEnhanced');
        window.toastr?.remove();
    });
    return { account, page, workbench: page.locator('#me-settings-drawer .me-workbench') };
}

export async function selectMacroCharacter(page, avatar) {
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await (await import('/script.js')).selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        window.NeconyanShell.openIncludedTool('MacroEnhanced');
    }, avatar);
}

export async function captureMacros(page, info, name) {
    await page.locator('#toast-container').evaluateAll(elements => elements.forEach(element => element.remove()));
    const directory = path.resolve('../screenshots/macroenhanced');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, name + '.png');
    await page.screenshot({ path: file });
    await info.attach(name, { path: file, contentType: 'image/png' });
}

export async function savedMacroState(page) {
    return page.evaluate(() => {
        const ctx = window.SillyTavern.getContext();
        return JSON.stringify({
            macro: ctx.chatMetadata.MacroEnhanced,
            local: ctx.chatMetadata.variables,
            global: ctx.extensionSettings.variables,
        });
    });
}
