/* global document, window, getComputedStyle, innerWidth, localStorage */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { captureMacros, openMacros, savedMacroState, selectMacroCharacter } from './macro-enhanced-native-helpers.js';
import assistantPack from '../public/scripts/extensions/third-party/MacroEnhanced/src/templates/assistants.js';
import { pickIndex } from '../public/scripts/extensions/third-party/MacroEnhanced/src/state-impl.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(240000);

const CHAT_HASH = 424242;
const MACRO_NAMES = assistantPack.macros.map(macro => macro.name);

function prefix(phone) {
    return phone ? 'phone' : 'desktop';
}

function listpickSpec(name) {
    const template = assistantPack.macros.find(macro => macro.name === name)?.template ?? '';
    const match = /^\{\{listpick::([^:]+)::([\s\S]*?)::;\}\}$/.exec(template);
    if (!match) {
        throw new Error(`No listpick template found for ${name}.`);
    }
    return { key: match[1], items: match[2].split(';') };
}

function prankItems() {
    const template = assistantPack.macros.find(macro => macro.name === 'noriprank')?.template ?? '';
    const match = /\{\{random::([\s\S]*)\}\}\}\}$/.exec(template);
    if (!match) {
        throw new Error('No random list found for noriprank.');
    }
    return match[1].split('::');
}

function instantiateExpected(user, timeofday, hostValues) {
    const expected = {
        misostarter: 'Open on two people who want to speak and choose the wrong words.',
        misocheer: listpickSpec('misocheer').items[pickIndex(`${CHAT_HASH}:${listpickSpec('misocheer').key}`, listpickSpec('misocheer').items.length)],
        taropun: listpickSpec('taropun').items[pickIndex(`${CHAT_HASH}:${listpickSpec('taropun').key}`, listpickSpec('taropun').items.length)],
        noritwist: listpickSpec('noritwist').items[pickIndex(`${CHAT_HASH}:${listpickSpec('noritwist').key}`, listpickSpec('noritwist').items.length)],
        norisense: listpickSpec('norisense').items[pickIndex(`${CHAT_HASH}:${listpickSpec('norisense').key}`, listpickSpec('norisense').items.length)],
        noridare: listpickSpec('noridare').items[pickIndex(`${CHAT_HASH}:${listpickSpec('noridare').key}`, listpickSpec('noridare').items.length)],
    };
    const greetings = {
        morning: `Good morning, ${user}. I hope the day is being kind to you so far.`,
        afternoon: `Good afternoon, ${user}. How is the day treating you?`,
        evening: `Good evening, ${user}. Ready to unwind?`,
        night: `Still awake, ${user}? I'll keep you company.`,
    };
    expected.misohello = greetings[timeofday] ?? greetings.night;
    expected.tarodebug = `Model: ${hostValues.model}; character: ${hostValues.char}; prompt limit: ${hostValues.maxPrompt} tokens; `
        + `context limit: ${hostValues.maxContext} tokens; last message: about 5 tokens (estimate, roughly 4 characters per token).`;
    expected.tarocheck = 'Local variable \'macrobrowser\' is set to \'7\'.';
    expected.tarotrimOver = 'The last message is 4 words. That is over the 3-word budget: '
        + 'trim repeated description first and keep the action and last line of dialogue.';
    expected.tarotrimFit = 'The last message is 4 words. That fits the 5-word budget; keep the next reply just as tight.';
    return expected;
}

async function installAssistantPack(page, workbench) {
    await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
    const scope = workbench.locator('.me-gallery-scope select');
    await expect(scope).toBeVisible();
    await scope.selectOption('browser');
    const pack = workbench.locator('.me-gallery-pack').filter({ hasText: 'Miso, Taro & Nori' });
    await expect(pack).toHaveCount(1);
    await pack.locator('.me-gallery-pack-header').click();
    await expect(pack.locator('.me-gallery-pack-body')).toBeVisible();
    await pack.getByRole('button', { name: 'Add all', exact: true }).click();
    await expect(workbench.locator('.me-gallery-status')).toContainText('Installed');
    await expect(workbench.locator('.me-gallery-status')).toContainText('browser');
    await expect(workbench.locator('.me-macro-card')).toHaveCount(11);
    return { pack, scope };
}

async function browserState(page) {
    return page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const store = await import('/scripts/extensions/third-party/MacroEnhanced/src/custom/store.js');
        const handle = String(context.currentUserHandle ?? '');
        return {
            handle,
            defs: store.getBrowserDefs(),
            raw: localStorage.getItem(`MacroEnhanced.browserMacros.v1:${handle}`),
            settingsMacros: context.extensionSettings.MacroEnhanced?.customMacros ?? [],
            chatMacros: context.chatMetadata.MacroEnhanced?.customMacros ?? [],
            characterMacros: context.characters?.[context.characterId]?.data?.extensions?.MacroEnhanced?.customMacros ?? [],
        };
    });
}

async function browserKeys(page) {
    return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('MacroEnhanced.browserMacros.v1:')));
}

async function exactExpansions(page) {
    return page.evaluate(async hash => {
        const context = window.SillyTavern.getContext();
        const { withReadOnlyVariables } = await import('/scripts/variable-read-only.js');
        const originalChat = Array.isArray(context.chat) ? [...context.chat] : [];
        const originalLength = context.chat?.length ?? 0;
        const originalHash = context.chatMetadata.chat_id_hash;
        const value = text => context.substituteParams(text);
        try {
            context.chatMetadata.chat_id_hash = hash;
            context.chat.push({ is_user: false, mes: 'one two three four' });
            const model = value('{{model}}');
            const char = value('{{char}}');
            const maxPrompt = value('{{maxPrompt}}');
            const maxContext = value('{{maxContext}}');
            context.variables.local.set('macrobrowser', '7');
            const checkSet = value('{{tarocheck::macrobrowser}}');
            context.variables.local.del('macrobrowser');
            const result = {
                user: value('{{user}}'),
                timeofday: value('{{timeofday}}'),
                model,
                char,
                maxPrompt,
                maxContext,
                hello: value('{{misohello}}'),
                starter: value('{{misostarter::romance}}'),
                starterFallback: value('{{misostarter::western}}'),
                checkSet,
                checkMissing: value('{{tarocheck::missing_macro_value}}'),
                trimOver: value('{{tarotrim::3}}'),
                trimFit: value('{{tarotrim::5}}'),
                debug: value('{{tarodebug}}'),
                cheer: value('{{misocheer}}'),
                pun: value('{{taropun}}'),
                twist: value('{{noritwist}}'),
                sense: value('{{norisense}}'),
                dare: value('{{noridare}}'),
                stable: {},
            };
            const stableKey = {
                misocheer: 'cheer',
                taropun: 'pun',
                noritwist: 'twist',
                norisense: 'sense',
                noridare: 'dare',
            };
            for (const name of Object.keys(stableKey)) {
                const first = result[stableKey[name]];
                const second = value(`{{${name}}}`);
                result.stable[name] = second === first;
                result[`${name}Again`] = second;
            }
            const prank = withReadOnlyVariables(() => value('{{noriprank}}'));
            const prankAgain = withReadOnlyVariables(() => value('{{noriprank}}'));
            result.prank = prank;
            result.prankAgain = prankAgain;
            return result;
        } finally {
            context.chat.length = originalLength;
            if (originalLength === 0) {
                context.chat.splice(0, context.chat.length, ...originalChat);
            }
            if (originalHash === undefined) {
                delete context.chatMetadata.chat_id_hash;
            } else {
                context.chatMetadata.chat_id_hash = originalHash;
            }
        }
    }, CHAT_HASH);
}

async function sourceMetadata(page) {
    return page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        return {
            settings: context.extensionSettings.MacroEnhanced?.customMacros ?? [],
            chat: context.chatMetadata.MacroEnhanced?.customMacros ?? [],
            character: context.characters?.[context.characterId]?.data?.extensions?.MacroEnhanced?.customMacros ?? [],
        };
    });
}

async function assertNoServerLeak(app, handle, account) {
    const accountRoot = path.join(app.dataRoot, handle);
    const settings = JSON.parse(await fs.readFile(path.join(accountRoot, 'settings.json'), 'utf8'));
    expect(settings.extension_settings?.MacroEnhanced?.customMacros ?? []).toEqual([]);
    const card = await account.post('/api/characters/get', { avatar_url: account.avatar });
    const cardText = JSON.stringify(card);
    const names = [...MACRO_NAMES, 'MacroEnhanced.browserMacros'];
    for (const name of names) {
        expect(cardText, `character server data contains ${name}`).not.toContain(name);
    }
    const entries = await fs.readdir(accountRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile() || !/\.(json|jsonl|txt)$/i.test(entry.name)) {
            continue;
        }
        const file = path.join(entry.parentPath ?? entry.path ?? accountRoot, entry.name);
        const text = await fs.readFile(file, 'utf8');
        for (const name of names) {
            expect(text, `${file} contains ${name}`).not.toContain(name);
        }
    }
}

async function assertNoSavedWrites(page, initialState) {
    const before = JSON.parse(initialState);
    const after = JSON.parse(await savedMacroState(page));
    expect(after.local ?? {}).toEqual(before.local ?? {});
    expect(after.global ?? {}).toEqual(before.global ?? {});
    expect(after.macro ?? {}).toEqual(before.macro ?? {});
}

async function startReview(page, input) {
    await page.evaluate(inputValue => {
        window.__browserMacroReview = import('/scripts/neconyan-assistant-macros.js')
            .then(({ reviewAndSaveBrowserMacro }) => reviewAndSaveBrowserMacro(inputValue));
    }, input);
}

async function waitForReview(page) {
    const review = page.locator('dialog.popup[open]').filter({ has: page.locator('.neconyan-assistant-review') });
    await expect(review).toBeVisible({ timeout: 15000 });
    return review;
}

async function finishReview(page) {
    return page.evaluate(() => window.__browserMacroReview);
}

async function reviewMetrics(page, review, phone) {
    const dialog = await review.boundingBox();
    const ok = await review.locator('.popup-button-ok').boundingBox();
    const cancel = await review.locator('.popup-button-cancel').boundingBox();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    const minimum = phone ? 44 : 28;
    expect(dialog, 'review dialog bounds').not.toBeNull();
    expect(ok, 'review OK bounds').not.toBeNull();
    expect(cancel, 'review cancel bounds').not.toBeNull();
    expect(dialog.x).toBeGreaterThanOrEqual(0);
    expect(dialog.y).toBeGreaterThanOrEqual(0);
    expect(dialog.x + dialog.width).toBeLessThanOrEqual(page.viewportSize().width + 0.5);
    expect(dialog.y + dialog.height).toBeLessThanOrEqual(page.viewportSize().height + 0.5);
    expect(overflow).toBe(false);
    expect(ok.width).toBeGreaterThanOrEqual(minimum - 0.1);
    expect(ok.height).toBeGreaterThanOrEqual(minimum - 0.1);
    expect(cancel.width).toBeGreaterThanOrEqual(minimum - 0.1);
    expect(cancel.height).toBeGreaterThanOrEqual(minimum - 0.1);
    return { dialog, ok, cancel, overflow };
}

async function primaryContrast(button) {
    return button.evaluate(async element => {
        const { contrastRatio } = await import('/scripts/theme-contrast.js');
        const style = getComputedStyle(element);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const channels = colour => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = colour;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const backgrounds = [];
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            backgrounds.unshift(getComputedStyle(ancestor).backgroundColor);
        }
        context.fillStyle = 'white';
        context.fillRect(0, 0, 1, 1);
        for (const background of backgrounds) {
            context.fillStyle = background;
            context.fillRect(0, 0, 1, 1);
        }
        const background = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        return contrastRatio(channels(style.color), background);
    });
}

async function controlsFit(page, workbench, phone) {
    const viewport = page.viewportSize();
    const metrics = {};
    for (const [label, locator] of [
        ['scope', workbench.locator('.me-gallery-scope select')],
        ['pack header', workbench.locator('.me-gallery-pack').filter({ hasText: 'Miso, Taro & Nori' }).locator('.me-gallery-pack-header')],
        ['add all', workbench.locator('.me-gallery-pack').filter({ hasText: 'Miso, Taro & Nori' }).getByRole('button', { name: 'Add all', exact: true })],
        ['add', workbench.locator('.me-gallery-pack').filter({ hasText: 'Miso, Taro & Nori' }).getByRole('button', { name: 'Add', exact: true }).first()],
        ['edit', workbench.locator('.me-macro-card').first().getByRole('button', { name: 'Edit', exact: true })],
        ['delete', workbench.locator('.me-macro-card').first().getByRole('button', { name: 'Delete', exact: true })],
    ]) {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        expect(box, `${label} bounds`).not.toBeNull();
        metrics[label] = box;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
        if (phone) {
            expect(box.width, `${label} width`).toBeGreaterThanOrEqual(43.9);
            expect(box.height, `${label} height`).toBeGreaterThanOrEqual(43.9);
        } else {
            expect(box.width, `${label} width`).toBeGreaterThanOrEqual(24);
            expect(box.height, `${label} height`).toBeGreaterThanOrEqual(24);
        }
    }
    return metrics;
}

for (const phone of [false, true]) {
    test(`${prefix(phone)} assistant trio installs into browser scope and persists exactly`, async ({ app }, info) => {
        const handle = 'default-user';
        const { page, account, workbench } = await openMacros(app, phone);
        await selectMacroCharacter(page, account.avatar);
        await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();

        const pack = workbench.locator('.me-gallery-pack').filter({ hasText: 'Miso, Taro & Nori' });
        await expect(pack).toHaveCount(1);
        await pack.scrollIntoViewIfNeeded();
        await captureMacros(page, info, `${prefix(phone)}-gallery-before`);

        const installed = await installAssistantPack(page, workbench);
        await installed.pack.scrollIntoViewIfNeeded();
        await captureMacros(page, info, `${prefix(phone)}-gallery-after`);
        const metrics = await controlsFit(page, workbench, phone);

        const state = await browserState(page);
        expect(state.handle).toBe(handle);
        expect(state.defs.map(def => def.name)).toEqual(MACRO_NAMES);
        expect(state.defs.map(def => ({
            name: def.name,
            description: def.description,
            template: def.template,
            args: def.args,
            enabled: def.enabled,
        }))).toEqual(assistantPack.macros.map(def => ({
            name: def.name,
            description: def.description,
            template: def.template,
            args: def.args,
            enabled: true,
        })));
        expect(state.raw).toContain('"misohello"');
        expect(state.settingsMacros).toEqual([]);
        expect(state.chatMacros).toEqual([]);
        expect(state.characterMacros).toEqual([]);
        const source = await sourceMetadata(page);
        expect(source).toEqual({ settings: [], chat: [], character: [] });
        await assertNoServerLeak(app, handle, account);

        const expansions = await exactExpansions(page);
        const expected = instantiateExpected(expansions.user, expansions.timeofday, expansions);
        expect(expansions.hello).toBe(expected.misohello);
        expect(expansions.starter).toBe(expected.misostarter);
        expect(expansions.starterFallback)
            .toBe('Open in the middle of a scene already in motion, with one concrete detail and one thing left unsaid.');
        expect(expansions.checkSet).toBe(expected.tarocheck);
        expect(expansions.checkMissing).toBe('Local variable \'missing_macro_value\' is not set in this chat.');
        expect(expansions.trimOver).toBe(expected.tarotrimOver);
        expect(expansions.trimFit).toBe(expected.tarotrimFit);
        expect(expansions.debug).toBe(expected.tarodebug);
        expect(expansions.cheer).toBe(expected.misocheer);
        expect(expansions.pun).toBe(expected.taropun);
        expect(expansions.twist).toBe(expected.noritwist);
        expect(expansions.sense).toBe(expected.norisense);
        expect(expansions.dare).toBe(expected.noridare);
        expect(expansions.stable).toEqual({
            misocheer: true,
            taropun: true,
            noritwist: true,
            norisense: true,
            noridare: true,
        });
        expect(prankItems()).toContain(expansions.prank);
        expect(expansions.prankAgain).toBe(expansions.prank);

        await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
        const firstCard = workbench.locator('.me-macro-card').filter({ hasText: '{{misohello' }).first();
        await firstCard.getByRole('button', { name: 'Edit', exact: true }).click();
        const editor = workbench.locator('.me-macro-editor');
        await expect(editor).toBeVisible();
        await expect(editor.getByRole('textbox', { name: /^Name/ })).toHaveValue('misohello');
        await expect(editor.getByRole('textbox', { name: 'What it expands to', exact: true }))
            .toHaveValue(assistantPack.macros.find(macro => macro.name === 'misohello').template);
        await captureMacros(page, info, `${prefix(phone)}-editor-after`);
        await editor.getByRole('button', { name: 'Cancel', exact: true }).click();

        const accents = [];
        for (const accent of ['Mint Glass', 'Plum Wine']) {
            await page.locator(`.sb-accent-profile-apply[title="Apply ${accent}"]`).evaluate(element => element.click());
            await installed.pack.scrollIntoViewIfNeeded();
            await captureMacros(page, info, `${prefix(phone)}-gallery-${accent.toLowerCase().replaceAll(' ', '-')}-after`);
            accents.push({ accent, contrast: await primaryContrast(installed.pack.getByRole('button', { name: 'Add all', exact: true })) });
        }
        expect(accents.every(item => item.contrast >= 4.5)).toBe(true);
        await info.attach(`macro-authoring-metrics-${prefix(phone)}`, {
            body: JSON.stringify({ metrics, accents }, null, 2),
            contentType: 'application/json',
        });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.NeconyanShell?.openIncludedTool && document.getElementById('me-settings-drawer'));
        await selectMacroCharacter(page, account.avatar);
        await page.evaluate(() => window.NeconyanShell.openIncludedTool('MacroEnhanced'));
        await expect(workbench).toBeVisible();
        await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
        await expect(workbench.locator('.me-macro-card')).toHaveCount(11);
        const persistedState = await browserState(page);
        expect(persistedState.defs.map(def => def.name)).toEqual(MACRO_NAMES);
        const persisted = await page.evaluate(async hash => {
            const context = window.SillyTavern.getContext();
            const { withReadOnlyVariables } = await import('/scripts/variable-read-only.js');
            const originalHash = context.chatMetadata.chat_id_hash;
            try {
                context.chatMetadata.chat_id_hash = hash;
                return withReadOnlyVariables(() => ({
                    starter: context.substituteParams('{{misostarter::romance}}'),
                    cheer: context.substituteParams('{{misocheer}}'),
                    pun: context.substituteParams('{{taropun}}'),
                }));
            } finally {
                if (originalHash === undefined) {
                    delete context.chatMetadata.chat_id_hash;
                } else {
                    context.chatMetadata.chat_id_hash = originalHash;
                }
            }
        }, CHAT_HASH);
        expect(persisted.starter).toBe(expected.misostarter);
        expect(persisted.cheer).toBe(expansions.cheer);
        expect(persisted.pun).toBe(expansions.pun);
        expect(await browserKeys(page)).toEqual([`MacroEnhanced.browserMacros.v1:${handle}`]);
        expect(app.provider.calls).toHaveLength(0);
    });
}

for (const phone of [false, true]) {
    test(`${prefix(phone)} browser macro review rejects, approves, updates and refuses collisions without writes`, async ({ app }, info) => {
        const { page, workbench } = await openMacros(app, phone);
        await workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
        const name = 'browserpreview';
        const template = '{{setvar::hp::5}}{{setglobalvar::gold::9}}{{freeze::moon::silver}}'
            + 'local={{getvar::hp}}; global={{getglobalvar::gold}}; frozen={{freeze::moon::changed}}';
        const expectedPreview = 'silverlocal=5; global=9; frozen=silver';
        const initialState = await savedMacroState(page);

        await startReview(page, { name, template, description: 'A previewed browser macro.', args: [] });
        const review = await waitForReview(page);
        await expect(review.locator('h3').first()).toHaveText('Save browser macro?');
        await expect(review.locator('.neconyan-assistant-review')).toBeVisible();
        await expect(review.locator('.neconyan-assistant-review')).toContainText('not synced');
        await expect(review.locator('.neconyan-assistant-review')).toContainText('Server-built prompts cannot expand browser macros');
        await expect(review.locator('pre').nth(0)).toHaveText('(new macro)');
        const afterDefinition = JSON.parse(await review.locator('pre').nth(1).textContent());
        expect(afterDefinition).toMatchObject({ name, template, description: 'A previewed browser macro.', args: [], enabled: true });
        await expect(review.locator('pre').nth(2)).toHaveText(expectedPreview);
        await captureMacros(page, info, `${prefix(phone)}-review-before`);
        const rejectedMetrics = await reviewMetrics(page, review, phone);
        await review.locator('.popup-button-cancel').click();
        const rejected = await finishReview(page);
        expect(rejected).toMatchObject({ status: 'cancelled', committed: false });
        expect((await browserState(page)).defs).toEqual([]);
        await assertNoSavedWrites(page, initialState);

        await startReview(page, { name, template, description: 'A previewed browser macro.', args: [] });
        const approvedReview = await waitForReview(page);
        await expect(approvedReview.locator('pre').nth(2)).toHaveText(expectedPreview);
        await captureMacros(page, info, `${prefix(phone)}-review-after`);
        const approvedMetrics = await reviewMetrics(page, approvedReview, phone);
        await approvedReview.locator('.popup-button-ok').click();
        const approved = await finishReview(page);
        expect(approved).toMatchObject({ status: 'success', committed: true, name, scope: 'browser' });
        const approvedState = await browserState(page);
        expect(approvedState.defs).toHaveLength(1);
        expect(approvedState.defs[0]).toMatchObject({ name, template, description: 'A previewed browser macro.', args: [], enabled: true });
        await assertNoSavedWrites(page, initialState);
        expect(await page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            return {
                hp: context.substituteParams('{{getvar::hp}}'),
                gold: context.substituteParams('{{getglobalvar::gold}}'),
                moon: context.chatMetadata.MacroEnhanced?.frozen?.moon ?? null,
            };
        })).toEqual({ hp: '', gold: '', moon: null });
        const registered = await page.evaluate(macroName => {
            const context = window.SillyTavern.getContext();
            return {
                hasMacro: context.macros.registry.hasMacro(macroName),
                template: context.macros.registry.getMacro(macroName)?.unnamedArgDefs ? 'registered' : '',
            };
        }, name);
        expect(registered.hasMacro).toBe(true);
        await assertNoSavedWrites(page, initialState);
        await captureMacros(page, info, `${prefix(phone)}-review-saved-after`);

        const savedId = approvedState.defs[0].id;
        const updatedTemplate = 'Updated {{upper::browser}}';
        await startReview(page, { name, template: updatedTemplate, expectedTemplate: template, args: [] });
        const updateReview = await waitForReview(page);
        await updateReview.locator('.popup-button-ok').click();
        expect(await finishReview(page)).toMatchObject({ status: 'success', committed: true, name, scope: 'browser' });
        const updated = (await browserState(page)).defs;
        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({ id: savedId, name, template: updatedTemplate });
        expect(await page.evaluate(macroName => window.SillyTavern.getContext().substituteParams(`{{${macroName}}}`), name))
            .toBe('Updated BROWSER');

        await startReview(page, { name: 'listpick', template: 'Nope' });
        const builtInCollision = await finishReview(page);
        expect(builtInCollision).toMatchObject({ status: 'error', committed: false });
        expect(builtInCollision.message).toContain('built-in');
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);

        await startReview(page, { name, template: 'Another template' });
        const existingCollision = await finishReview(page);
        expect(existingCollision).toMatchObject({ status: 'conflict', committed: false });
        expect(existingCollision.message).toContain('expectedTemplate');
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);
        await assertNoSavedWrites(page, initialState);
        expect(app.provider.calls).toHaveLength(0);

        await info.attach(`macro-authoring-review-metrics-${prefix(phone)}`, {
            body: JSON.stringify({ rejectedMetrics, approvedMetrics }, null, 2),
            contentType: 'application/json',
        });
    });
}

test('two browser contexts and two account handles keep the assistant pack isolated', async ({ app }, info) => {
    const admin = await app.account();
    for (const [handle, name] of [['macro-isolation-a', 'Macro isolation A'], ['macro-isolation-b', 'Macro isolation B']]) {
        await admin.post('/api/users/create', { handle, name, password: '', admin: false });
    }
    const first = await openMacros(app, false, { handle: 'macro-isolation-a' });
    const firstInstall = await installAssistantPack(first.page, first.workbench);
    await firstInstall.pack.scrollIntoViewIfNeeded();
    const firstState = await browserState(first.page);
    expect(firstState.handle).toBe('macro-isolation-a');
    expect(firstState.defs.map(def => def.name)).toEqual(MACRO_NAMES);
    expect(await browserKeys(first.page)).toEqual(['MacroEnhanced.browserMacros.v1:macro-isolation-a']);

    const second = await openMacros(app, false, { handle: 'macro-isolation-b' });
    await second.workbench.getByRole('tab', { name: 'My macros', exact: true }).click();
    const secondState = await browserState(second.page);
    expect(secondState.handle).toBe('macro-isolation-b');
    expect(secondState.defs).toEqual([]);
    expect(secondState.raw).toBeNull();
    expect(secondState.settingsMacros).toEqual([]);
    expect(secondState.chatMacros).toEqual([]);
    expect(secondState.characterMacros).toEqual([]);
    await expect(second.workbench.locator('.me-macro-card')).toHaveCount(0);
    expect(await second.page.evaluate(() => window.SillyTavern.getContext().substituteParams('{{misostarter::romance}}')))
        .toBe('{{misostarter::romance}}');
    expect(await browserKeys(second.page)).toEqual([]);
    await captureMacros(second.page, info, 'desktop-isolation-second-empty');
    expect(app.provider.calls).toHaveLength(0);
});
