/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- Phone and desktop share one test script. */
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { openScratchpadContext } from './neconyan-scratchpad-context-helpers.js';

async function scrollPreviewTo(preview, marker) {
    await preview.evaluate((element, marker) => {
        const node = element.firstChild;
        const index = node?.textContent?.indexOf(marker) ?? -1;
        if (!node || index < 0) return;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + marker.length);
        element.scrollTop += range.getBoundingClientRect().top - element.getBoundingClientRect().top - 8;
    }, marker);
}

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} traces lorebook activation and saves activation setting edits`, async ({ app }) => {
        test.setTimeout(180000);
        const size = phone ? 'phone' : 'desktop';
        const screenshotDir = path.join('..', 'screenshots', 'scratchpad-lorebook-activation');
        const capture = process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1';
        if (capture) fs.mkdirSync(screenshotDir, { recursive: true });

        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });

        const bookName = `Harbour Trace ${size}`;
        await account.post('/api/worldinfo/edit', {
            name: bookName,
            data: {
                entries: {
                    0: {
                        uid: 0,
                        comment: 'Signal Lamp',
                        key: ['lighthouse'],
                        keysecondary: ['storm'],
                        selective: true,
                        selectiveLogic: 0,
                        constant: false,
                        probability: 75,
                        useProbability: true,
                        order: 100,
                        position: 0,
                        depth: 4,
                        role: 0,
                        scanDepth: 2,
                        caseSensitive: true,
                        matchWholeWords: true,
                        excludeRecursion: false,
                        preventRecursion: false,
                        delayUntilRecursion: 0,
                        group: '',
                        groupOverride: false,
                        groupWeight: 100,
                        useGroupScoring: true,
                        sticky: 3,
                        cooldown: null,
                        delay: null,
                        ignoreBudget: false,
                        disable: false,
                        content: 'The lamp warns ships at night.',
                    },
                    1: {
                        uid: 1,
                        comment: 'Old Pier',
                        key: ['pier'],
                        disable: true,
                        content: 'DISABLED_E2E_SECRET_TEXT',
                    },
                    2: {
                        uid: 2,
                        comment: 'Vault Secret',
                        key: ['lighthouse'],
                        agentBlacklisted: true,
                        content: 'HIDDEN_E2E_SECRET_TEXT',
                    },
                },
            },
        });

        const page = await account.open({ workspace: false });

        // 1. General Scratchpad shows 'Why didn\'t an entry trigger?' only when a lorebook is picked.
        await openScratchpad(page);
        await expect(page.locator('.scratchpad-source')).toContainText('General Scratchpad');
        const prompt = name => page.getByRole('button', { name, exact: true });
        await expect(prompt('Why didn\'t an entry trigger?')).toHaveCount(0);

        await openScratchpadContext(page, 'sharing');
        if (phone) await applyIOSOnlyCss(page);
        const generalSource = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        await page.locator('#scratchpad-lorebook').selectOption(bookName);
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source: generalSource })).bucket.sessions[0]?.settings.lorebook).toBe(bookName);

        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(prompt('Why didn\'t an entry trigger?')).toBeVisible();
        await prompt('Why didn\'t an entry trigger?').click();
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'Turned on Problem checks for this session.' }).first()).toBeVisible();
        await expect(page.locator('.scratchpad-composer')).toHaveValue('Check the activation trace and explain why a lorebook entry did not trigger, and offer a fix if needed.');
        if (capture) {
            await page.locator('.scratchpad-quick').evaluate(element => { element.scrollLeft = element.scrollWidth; });
            await page.mouse.move(0, 0);
            await page.evaluate(() => document.activeElement?.blur());
            await page.screenshot({ path: path.join(screenshotDir, `after-${size}-quick-prompts.png`) });
        }
        await page.evaluate(() => window.toastr.clear());
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());

        // 2. Roleplay character linked to the lorebook with a chat message that matches primary key but fails secondary filter.
        const created = await account.context.request.post('/api/characters/create', {
            headers: account.headers,
            data: {
                ch_name: `Trace Keeper ${size}`,
                description: 'Keeps the harbour light.',
                first_mes: 'The lighthouse stands above the calm harbour.',
                world: bookName,
            },
        });
        expect(created.ok(), await created.text()).toBe(true);
        const avatar = await created.text();
        await page.evaluate(async avatar => {
            const context = window.SillyTavern.getContext();
            await context.getCharacters();
            await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        }, avatar);
        await expect(page.locator('#chat .mes_text').first()).toContainText('The lighthouse stands above the calm harbour.');

        await openScratchpad(page);
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        expect(source.kind).toBe('roleplay');

        // 3. Turn Problem checks on, open Show preview, verify trace reason and privacy rules.
        await openScratchpadContext(page, 'sharing');
        if (phone) await applyIOSOnlyCss(page);
        const checks = page.getByRole('checkbox', { name: /^Problem checks/ });
        await checks.check();
        await expect.poll(async () => (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0]?.settings.include.problems).toBe(true);
        await page.getByRole('button', { name: 'Show preview', exact: true }).click();
        const preview = page.locator('pre.scratchpad-preview-text');
        await expect(preview).toContainText('## Lorebook activation trace');
        await expect(preview).toContainText('Signal Lamp (uid 0): primary key "lighthouse" matched, but secondary-key logic AND any failed (secondary keys: storm)');
        await expect(preview).toContainText('Old Pier (uid 1): disabled');
        await expect(preview).toContainText('1 entry is hidden from Agents and was not shared.');
        const previewText = await preview.textContent();
        expect(previewText).not.toContain('DISABLED_E2E_SECRET_TEXT');
        expect(previewText.toLowerCase()).not.toContain('vault secret');
        expect(previewText.toLowerCase()).not.toContain('hidden_e2e_secret_text');

        if (capture) {
            await page.evaluate(() => window.toastr.clear());
            await preview.scrollIntoViewIfNeeded();
            await scrollPreviewTo(preview, '## Lorebook activation trace');
            await page.locator('#neconyan-scratchpad').screenshot({ path: path.join(screenshotDir, `after-${size}-preview-trace.png`) });
        }

        // 4. Import assistant reply containing an activation edit, a disabled-entry re-enable, and an invalid edit.
        const activationEdit = {
            type: 'lorebook',
            action: 'edit',
            book: bookName,
            uid: 0,
            reason: 'Fix secondary filter, reset global defaults and set activation options.',
            keys: ['lighthouse', 'beacon'],
            keysecondary: ['harbour'],
            selective: false,
            selectiveLogic: 3,
            constant: false,
            probability: 80,
            useProbability: false,
            order: 150,
            position: 4,
            depth: 2,
            role: 2,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: false,
            excludeRecursion: true,
            preventRecursion: true,
            delayUntilRecursion: 2,
            group: 'harbour',
            groupOverride: true,
            groupWeight: 200,
            useGroupScoring: null,
            sticky: null,
            cooldown: 4,
            delay: 1,
            ignoreBudget: true,
        };
        const enableDisabled = {
            type: 'lorebook',
            action: 'edit',
            book: bookName,
            uid: 1,
            reason: 'Enable Old Pier so its keyword can match.',
            disable: false,
        };
        const invalidEdit = {
            type: 'lorebook',
            action: 'edit',
            book: bookName,
            uid: 0,
            agentBlacklisted: false,
        };

        await account.post('/api/scratchpad/session/import', {
            source,
            session: {
                name: 'Activation fixes',
                settings: { include: { lore: true, problems: true } },
                messages: [
                    {
                        role: 'assistant',
                        text: 'Signal Lamp failed because the optional filter required storm.\n'
                            + [activationEdit, enableDisabled, invalidEdit]
                                .map(item => '```scratchpad-change\n' + JSON.stringify(item) + '\n```')
                                .join('\n'),
                    },
                ],
            },
        });
        await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);

        const cards = page.locator('.scratchpad-change');
        await expect(cards).toHaveCount(3);
        // Invalid card is refused immediately with a plain reason and no Review button.
        await expect(cards.nth(2)).toHaveClass(/is-invalid/);
        await expect(cards.nth(2)).toContainText('Unsupported lorebook field: agentBlacklisted');
        await expect(cards.nth(2).getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);

        // Open Review on Card 1 (activation edit) and check before -> after rows.
        await cards.nth(0).getByRole('button', { name: 'Review', exact: true }).click();
        const review = page.locator('.scratchpad-review');
        await expect(review).toBeVisible();
        const settingBox = review.locator('.scratchpad-setting-diff');
        await expect(settingBox).toBeVisible();
        await expect(settingBox).toContainText('Primary Keywords: lighthouse -> lighthouse, beacon');
        await expect(settingBox).toContainText('Optional Filter: storm -> harbour');
        await expect(settingBox).toContainText('Selective: Yes -> No');
        await expect(settingBox).toContainText('Logic: AND ANY -> AND ALL');
        await expect(settingBox).toContainText('Trigger probability: 75% -> 80%');
        await expect(settingBox).toContainText('Use Probability: Yes -> No');
        await expect(settingBox).toContainText('Order: 100 -> 150');
        await expect(settingBox).toContainText('Position: Before Char Defs -> At Depth');
        await expect(settingBox).toContainText('Depth: 4 -> 2');
        await expect(settingBox).toContainText('Role: System -> Assistant');
        await expect(settingBox).toContainText('Scan Depth: 2 -> Use global setting');
        await expect(settingBox).toContainText('Case-Sensitive: Yes -> Use global');
        await expect(settingBox).toContainText('Whole Words: Yes -> No');
        await expect(settingBox).toContainText('Non-recursable: No -> Yes');
        await expect(settingBox).toContainText('Prevent further recursion: No -> Yes');
        await expect(settingBox).toContainText('Delay until recursion: Off -> Level 2');
        await expect(settingBox).toContainText('Inclusion Group: None -> harbour');
        await expect(settingBox).toContainText('Prioritize: No -> Yes');
        await expect(settingBox).toContainText('Group Weight: 100 -> 200');
        await expect(settingBox).toContainText('Group Scoring: Yes -> Use global');
        await expect(settingBox).toContainText('Sticky: 3 -> Non-sticky');
        await expect(settingBox).toContainText('Cooldown: No cooldown -> 4');
        await expect(settingBox).toContainText('Delay: No delay -> 1');
        await expect(settingBox).toContainText('Ignore budget: No -> Yes');
        // Unchanged setting (constant: false -> false) is never listed.
        await expect(settingBox).not.toContainText('Constant:');
        // Pure activation edit hides the text diff and textarea.
        await expect(review.locator('.scratchpad-review-editor')).toHaveCount(0);
        // Geometry fits inside viewport without sideways overflow.
        const boxBounds = await settingBox.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, vw: document.documentElement.clientWidth };
        });
        expect(boxBounds.left).toBeGreaterThanOrEqual(0);
        expect(boxBounds.right).toBeLessThanOrEqual(boxBounds.vw);

        if (capture) {
            await page.evaluate(() => window.toastr.clear());
            await page.screenshot({ path: path.join(screenshotDir, `after-${size}-review-card.png`) });
        }

        // Save Card 1 and read the entry back from the server's real lorebook storage.
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(review).toBeHidden();
        await expect(cards.nth(0)).toContainText('Saved');

        const afterEdit = await account.post('/api/worldinfo/get', { name: bookName });
        const savedEntry = afterEdit.entries['0'];
        expect(savedEntry.key).toEqual(['lighthouse', 'beacon']);
        expect(savedEntry.keysecondary).toEqual(['harbour']);
        expect(savedEntry.selective).toBe(false);
        expect(savedEntry.selectiveLogic).toBe(3);
        expect(savedEntry.constant).toBe(false);
        expect(savedEntry.probability).toBe(80);
        expect(savedEntry.useProbability).toBe(false);
        expect(savedEntry.order).toBe(150);
        expect(savedEntry.position).toBe(4);
        expect(savedEntry.depth).toBe(2);
        expect(savedEntry.role).toBe(2);
        expect(savedEntry.scanDepth).toBeNull();
        expect(savedEntry.caseSensitive).toBeNull();
        expect(savedEntry.matchWholeWords).toBe(false);
        expect(savedEntry.excludeRecursion).toBe(true);
        expect(savedEntry.preventRecursion).toBe(true);
        expect(savedEntry.delayUntilRecursion).toBe(2);
        expect(savedEntry.group).toBe('harbour');
        expect(savedEntry.groupOverride).toBe(true);
        expect(savedEntry.groupWeight).toBe(200);
        expect(savedEntry.useGroupScoring).toBeNull();
        expect(savedEntry.sticky).toBeNull();
        expect(savedEntry.cooldown).toBe(4);
        expect(savedEntry.delay).toBe(1);
        expect(savedEntry.ignoreBudget).toBe(true);
        expect(savedEntry.content).toBe('The lamp warns ships at night.');

        // Card 2: while Problem checks is off on the imported session, enabling a disabled entry is refused.
        await cards.nth(1).getByRole('button', { name: 'Review', exact: true }).click();
        await expect(page.locator('#toast-container')).toContainText('Turn on Problem checks');
        await expect(review).toHaveCount(0);

        // Turn Problem checks on so disabled entries are listed; Card 2 now opens and enables uid 1.
        await openScratchpadContext(page, 'sharing');
        await page.getByRole('checkbox', { name: /^Problem checks/ }).check();
        await expect.poll(async () => {
            const { bucket } = await account.post('/api/scratchpad/bucket', { source });
            return bucket.sessions.find(item => item.name === 'Activation fixes')?.settings.include.problems;
        }).toBe(true);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(cards).toHaveCount(3);
        await cards.nth(1).getByRole('button', { name: 'Review', exact: true }).click();
        await expect(review).toBeVisible();
        await expect(review.locator('.scratchpad-setting-diff')).toContainText('Status: Disabled -> Enabled');
        expect(await review.textContent()).not.toContain('DISABLED_E2E_SECRET_TEXT');
        await page.getByRole('button', { name: 'Save change', exact: true }).click();
        await expect(review).toBeHidden();
        await expect(cards.nth(1)).toContainText('Saved');

        const afterEnable = await account.post('/api/worldinfo/get', { name: bookName });
        expect(afterEnable.entries['1'].disable).toBe(false);
        expect(afterEnable.entries['1'].content).toBe('DISABLED_E2E_SECRET_TEXT');

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
    });
}
