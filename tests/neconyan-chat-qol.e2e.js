/* global document, window */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

test.setTimeout(60000);

for (const width of [320, 1280]) {
    test.describe(`Neconyan chat quality of life at ${width}px`, () => {
        test.use({
            viewport: { width, height: 844 },
            isMobile: width < 768,
            hasTouch: width < 768,
        });

        test('keeps labelled actions usable and exports the rendered current chat', async ({ page }, testInfo) => {
            let exportRequests = [];
            await page.route('**/api/chats/get', route => route.fulfill({ status: 200, json: [] }));
            await page.route('**/api/characters/chats', route => route.fulfill({
                status: 200,
                json: [{ file_name: 'export-current', last_mes: Date.now() }],
            }));
            await page.route('**/api/chats/search', route => route.fulfill({
                status: 200,
                json: [
                    {
                        file_name: 'old-chat',
                        file_size: '1 KB',
                        message_count: 1,
                        last_mes: Date.now(),
                        preview_message: 'Older chat',
                    },
                    {
                        file_name: 'export-current',
                        file_size: '2 KB',
                        message_count: 4,
                        last_mes: Date.now(),
                        preview_message: 'Current chat',
                    },
                ],
            }));
            await page.route('**/api/chats/export', async route => {
                const requestBody = JSON.parse(route.request().postData() || '{}');
                exportRequests.push(requestBody);
                await route.fulfill({
                    status: 200,
                    json: { message: 'JSONL exported', result: '{"raw":true}\n' },
                });
            });

            await openQuietChatForSmoke(page, { selectCharacter: false });

            await page.evaluate(async () => {
                const context = window.SillyTavern.getContext();
                const characterId = context.characters.length;
                context.characters.push({
                    name: 'Export Cat',
                    avatar: 'none',
                    chat: 'export-current',
                    first_mes: '',
                    mes_example: '',
                    shallow: false,
                    data: {},
                });
                await context.selectCharacterById(characterId, { switchMenu: false });
                context.extensionSettings.disabledExtensions = (context.extensionSettings.disabledExtensions ?? [])
                    .filter(extensionId => extensionId !== 'regex');
                context.extensionSettings.regex = [{
                    id: 'neconyan-export-regex',
                    scriptName: 'Neconyan export check',
                    findRegex: '/(reply)/gi',
                    replaceString: 'response',
                    placement: [2],
                    markdownOnly: true,
                    promptOnly: false,
                    disabled: false,
                    runOnEdit: true,
                    trimStrings: [],
                    substituteRegex: 0,
                }];
                context.powerUserSettings.chat_truncation = 1;
                context.chat.splice(0, context.chat.length,
                    {
                        name: 'Export Cat', is_user: false, is_system: false,
                        mes: 'Hello {{user}}', send_date: new Date().toISOString(), extra: {},
                    },
                    {
                        name: 'Scroll Tester',
                        is_user: true,
                        is_system: false,
                        mes: '**hello** from the user',
                        send_date: new Date().toISOString(),
                        extra: {},
                    },
                    {
                        name: 'Export Cat',
                        is_user: false,
                        is_system: false,
                        mes: 'RAW_PRIVATE_SOURCE',
                        send_date: new Date().toISOString(),
                        extra: { display_text: '*A rendered reply* <span style="display:none">DISPLAY_SECRET</span>' },
                    },
                    {
                        name: 'System',
                        is_user: false,
                        is_system: true,
                        mes: 'Do not export this system line.',
                        send_date: new Date().toISOString(),
                        extra: {},
                    },
                    {
                        name: 'Export Cat',
                        is_user: false,
                        is_system: false,
                        mes: 'Second **reply**',
                        send_date: new Date().toISOString(),
                        extra: {},
                    },
                );
                await context.printMessages();
                await (await import('/scripts/welcome-screen.js')).hideWelcomeHome();
            });

            await expect(page.locator('#chat')).toBeVisible();

            await page.evaluate(() => document.getElementById('option_select_chat')?.click());
            await expect(page.locator('#select_chat_div .select_chat_block')).toHaveCount(2);

            const currentRow = page.locator('#select_chat_div .select_chat_block[highlight="true"]');
            const oldRow = page.locator('#select_chat_div .select_chat_block').filter({ hasText: 'old-chat' });
            await expect(currentRow).toHaveCount(1);
            await expect(currentRow.locator('.neconyan-current-chat-export')).toHaveCount(2);
            expect(await oldRow.locator('.neconyan-current-chat-export').evaluateAll(elements => elements.every(element => element.getAttribute('aria-hidden') === 'true'))).toBe(true);
            await expect(currentRow.getByRole('button', { name: 'Readable' })).toBeVisible();
            await expect(currentRow.getByRole('button', { name: 'Replies' })).toBeVisible();

            const historyOverflow = await page.locator('#select_chat_div').evaluate(element => ({
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
            }));
            expect(historyOverflow.scrollWidth - historyOverflow.clientWidth).toBeLessThanOrEqual(1);
            await page.screenshot({ path: testInfo.outputPath('chat-history.png') });

            const rawBeforeExport = await page.evaluate(() => {
                const chat = window.SillyTavern.getContext().chat;
                chat[0].mes = 'Hello {{user}}';
                return JSON.stringify(chat);
            });
            expect(JSON.parse(rawBeforeExport)[0].mes).toBe('Hello {{user}}');

            const readableDownloadPromise = page.waitForEvent('download');
            await currentRow.getByRole('button', { name: 'Readable' }).click();
            const readableDownload = await readableDownloadPromise;
            expect(readableDownload.suggestedFilename()).toBe('export-current-readable.txt');
            const readableText = await readFile(await readableDownload.path(), 'utf8');
            expect(readableText).toContain('Scroll Tester: hello from the user');
            expect(readableText).toContain('Export Cat: A rendered response');
            expect(readableText).toContain('Export Cat: Second response');
            expect(readableText).not.toContain('**');
            expect(readableText).not.toContain('Do not export this system line.');
            expect(readableText).not.toContain('RAW_PRIVATE_SOURCE');
            expect(readableText).not.toContain('DISPLAY_SECRET');

            const characterDownloadPromise = page.waitForEvent('download');
            await currentRow.getByRole('button', { name: 'Replies' }).click();
            const characterDownload = await characterDownloadPromise;
            expect(characterDownload.suggestedFilename()).toBe('export-current-character-replies.txt');
            const characterText = await readFile(await characterDownload.path(), 'utf8');
            expect(characterText).toContain('Export Cat: A rendered response');
            expect(characterText).toContain('Export Cat: Second response');
            expect(characterText).not.toContain('Scroll Tester:');
            expect(characterText).not.toContain('Do not export this system line.');
            expect(await page.evaluate(() => JSON.stringify(window.SillyTavern.getContext().chat))).toBe(rawBeforeExport);

            await page.evaluate(async () => {
                const script = await import('/script.js');
                const context = window.SillyTavern.getContext();
                window.__exportOriginalCharacterId = context.characterId;
                context.characters.push({ ...context.characters[context.characterId], avatar: 'different-owner.png', chat: 'export-current' });
                script.setCharacterId(context.characters.length - 1);
            });
            await currentRow.getByRole('button', { name: 'Readable' }).click();
            await expect(page.getByText('Open this chat before using its rendered text export.', { exact: true })).toBeVisible();
            await page.evaluate(async () => {
                (await import('/script.js')).setCharacterId(window.__exportOriginalCharacterId);
                window.toastr.clear();
            });

            const rawDownloadPromise = page.waitForEvent('download');
            await currentRow.getByRole('button', { name: 'JSONL' }).click();
            const rawDownload = await rawDownloadPromise;
            expect(await readFile(await rawDownload.path(), 'utf8')).toBe('{"raw":true}\n');
            expect(exportRequests.at(-1)).toMatchObject({
                file: 'export-current.jsonl',
                exportfilename: 'export-current.jsonl',
                format: 'jsonl',
            });

            await page.locator('#select_chat_cross').click();
            await expect(page.locator('#select_chat_div')).toBeHidden();

            const more = page.locator('#chat .mes[mesid] .extraMesButtonsHint').last();
            await expect(more).toBeVisible();
            await more.focus();
            await page.evaluate(() => {
                const element = document.querySelector('#chat .mes[mesid] .extraMesButtonsHint');
                window.__neconyanMoreClicks = 0;
                element?.addEventListener('click', () => { window.__neconyanMoreClicks += 1; }, { once: false });
            });
            await more.press('Enter');
            await expect(page.locator('#chat .mes[mesid] .extraMesButtons.visible')).toBeVisible();
            expect(await page.evaluate(() => window.__neconyanMoreClicks)).toBe(1);
            await expect(more).toHaveAttribute('aria-expanded', 'true');

            await page.evaluate(() => { window.__neconyanMoreClicks = 0; });
            await more.press('Space');
            await expect(page.locator('#chat .mes[mesid] .extraMesButtons.visible')).toHaveCount(0);
            expect(await page.evaluate(() => window.__neconyanMoreClicks)).toBe(1);
            await expect(more).toHaveAttribute('aria-expanded', 'false');

            const copy = page.locator('#chat .mes[mesid] .mes_copy').last();
            await page.evaluate(() => {
                window.__neconyanCopied = [];
                Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: {
                    writeText: async text => { window.__neconyanCopied.push(text); },
                } });
            });
            await copy.locator('.neconyan-action-label').click();
            await copy.press('Enter');
            await copy.press('Space');
            expect(await page.evaluate(() => window.__neconyanCopied)).toEqual(['Second **reply**', 'Second **reply**', 'Second **reply**']);
            if (width < 768) {
                await copy.tap();
                expect(await page.evaluate(() => window.__neconyanCopied)).toHaveLength(4);
            }

            await page.locator('#expandMessageActions').evaluate(input => {
                input.checked = true;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            const extras = page.locator('#chat .mes[mesid] .extraMesButtons').last();
            await expect(extras).toHaveAttribute('aria-hidden', 'false');
            await extras.evaluate(element => {
                const action = document.createElement('button');
                action.type = 'button';
                action.title = 'A late extension action with a long label that must remain readable';
                action.id = 'late-extension-action';
                element.append(action);
            });
            await expect(page.locator('#late-extension-action .neconyan-action-label')).toHaveText('A late extension action with a long label that must remain readable');
            await page.locator('#expandMessageActions').evaluate(input => {
                input.checked = false;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await expect(extras).toHaveAttribute('aria-hidden', 'true');
            await more.press('Space');
            await expect(page.locator('#chat .mes[mesid] .extraMesButtons.visible')).toBeVisible();
            await expect(more).toHaveAttribute('aria-expanded', 'true');
            const clippedActions = await page.locator('#chat .mes[mesid]').last().evaluate(message => {
                const card = message.getBoundingClientRect();
                return [...message.querySelectorAll('.neconyan-action-label')].filter(label => label.getClientRects().length).filter(label => {
                    const rect = label.getBoundingClientRect();
                    const control = label.parentElement.getBoundingClientRect();
                    return rect.left < control.left - 1 || rect.right > control.right + 1 || rect.bottom > control.bottom + 1
                        || rect.left < card.left - 1 || rect.right > card.right + 1 || rect.bottom > card.bottom + 1;
                }).map(label => label.textContent);
            });
            expect(clippedActions).toEqual([]);

            // Expanded actions sit in one aligned grid: every control on the same row shares its
            // top edge and height, so the columns read as rows instead of a staggered list.
            const actionRowAlignment = await extras.evaluate(element => {
                const items = [...element.children].filter(item => {
                    const style = window.getComputedStyle(item);
                    const rect = item.getBoundingClientRect();
                    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
                }).map(item => item.getBoundingClientRect());
                const rows = [];

                // Row membership is decided by vertical bands, not rounded tops: a taller control
                // must still be grouped with the shorter controls it shares a line with.
                for (const rect of items.sort((a, b) => a.top - b.top)) {
                    const center = rect.top + rect.height / 2;
                    const row = rows.find(entry => center >= entry.top - 1 && center <= entry.bottom + 1);

                    if (row) {
                        row.items.push(rect);
                        row.top = Math.min(row.top, rect.top);
                        row.bottom = Math.max(row.bottom, rect.bottom);
                    } else {
                        rows.push({ top: rect.top, bottom: rect.bottom, items: [rect] });
                    }
                }

                return {
                    visibleCount: items.length,
                    rowTopDrift: rows.map(row => Math.max(...row.items.map(entry => entry.top)) - Math.min(...row.items.map(entry => entry.top))),
                    rowHeightDrift: rows.map(row => Math.max(...row.items.map(entry => entry.height)) - Math.min(...row.items.map(entry => entry.height))),
                };
            });
            expect(actionRowAlignment.visibleCount).toBeGreaterThanOrEqual(4);
            expect(actionRowAlignment.rowTopDrift.every(drift => drift <= 1)).toBe(true);
            expect(actionRowAlignment.rowHeightDrift.every(drift => drift <= 1)).toBe(true);

            await page.evaluate(() => window.toastr.remove());
            await page.screenshot({ path: testInfo.outputPath('chat-actions.png') });
            await more.press('Escape');
            await expect(more).toBeFocused();
            await expect(more).toHaveAttribute('aria-expanded', 'false');

            const actionA11y = await page.locator('#chat .mes[mesid] .neconyan-message-action').evaluateAll(elements => elements.map(element => ({
                label: element.getAttribute('aria-label'),
                text: element.textContent?.trim(),
                height: element.getBoundingClientRect().height,
                width: element.getBoundingClientRect().width,
            })));
            expect(actionA11y.map(action => action.label)).toEqual(expect.arrayContaining([
                'More message actions',
                'Edit message',
                'Delete message',
                'Copy message',
            ]));
            if (width < 768) {
                const visibleActions = actionA11y.filter(action => action.width > 0 && action.height > 0);
                expect(visibleActions.length).toBeGreaterThanOrEqual(3);
                expect(visibleActions.every(action => action.height >= 44)).toBe(true);
            }

            await waitForAnimationFrames(page, 2);
            const documentWidth = await page.evaluate(() => ({
                scrollWidth: document.documentElement.scrollWidth,
                innerWidth: window.innerWidth,
            }));
            expect(documentWidth.scrollWidth - documentWidth.innerWidth).toBeLessThanOrEqual(1);

            const textarea = page.locator('#send_textarea');
            await textarea.fill('keep this draft');
            await page.locator('#send_form').evaluate(element => element.classList.add('no-connection'));
            const connect = page.locator('#neconyan_connect_button');
            // Both composer layouts use icon squares with an accessible name.
            const phone = width < 769;
            await expect(page.locator('#options_button .neconyan-action-label')).toBeHidden();
            await expect(page.locator('#options_button')).toHaveAccessibleName('Chat tools');
            const optionsBox = await page.locator('#options_button').boundingBox();
            expect(optionsBox.width).toBeLessThanOrEqual(phone ? 46 : 64);
            expect(optionsBox.height).toBeLessThanOrEqual(phone ? 46 : 64);
            expect(optionsBox.height).toBeGreaterThanOrEqual(38);
            const composerClipping = await page.locator('#leftSendForm .neconyan-action-label').evaluateAll(labels => labels.filter(label => {
                const rect = label.getBoundingClientRect();
                const parent = label.parentElement.getBoundingClientRect();
                return rect.width && (rect.left < parent.left || rect.right > parent.right || rect.bottom > parent.bottom);
            }).map(label => label.textContent));
            expect(composerClipping).toEqual([]);
            await connect.evaluate(element => {
                window.__neconyanConnectClicks = 0;
                element.addEventListener('click', () => { window.__neconyanConnectClicks += 1; });
            });
            await connect.press('Enter');
            expect(await page.evaluate(() => window.__neconyanConnectClicks)).toBe(1);
            await expect(page.locator('#left-nav-panel')).toHaveAttribute('data-sb-active-tab', 'api');
            await expect(textarea).toHaveValue('keep this draft');
            await page.screenshot({ path: testInfo.outputPath('connections-draft.png') });
        });
    });
}
