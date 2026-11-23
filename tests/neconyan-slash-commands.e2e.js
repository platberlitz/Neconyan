/* global document, window, getComputedStyle */
import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} slash command workflow`, async ({ app }) => {
        const account = await app.account({ phone, activeConnection: true, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page);
        const input = page.locator('#send_textarea');
        const send = page.locator('#send_but');
        const submit = async command => {
            await input.fill(command);
            await input.blur();
            if (phone) await send.tap();
            else await send.click();
        };
        await expect(input).toBeVisible();
        await input.fill('/ec Keep this draft | /pass keep this too');
        await input.evaluate(element => {
            element.setSelectionRange(3, 3);
            element.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await input.press('Control+Space');
        const suggestion = page.locator('.autoComplete-wrap li[data-name="echo"]');
        await expect(suggestion).toBeVisible();
        await mkdir('../screenshots', { recursive: true });
        const prefix = `../screenshots/slash-${phone ? 'phone' : 'desktop'}-after`;
        await page.screenshot({ path: `${prefix}-completion.png` });
        if (phone) await suggestion.tap();
        else await suggestion.click();
        await expect(input).toHaveValue('/echo Keep this draft | /pass keep this too');

        // Read the draft from an automation without sending or modifying it.
        expect(await page.evaluate(async () => (await (await import('/scripts/slash-commands.js'))
            .executeSlashCommandsWithOptions('/getinput')).pipe)).toBe('/echo Keep this draft | /pass keep this too');
        await expect(input).toHaveValue('/echo Keep this draft | /pass keep this too');

        const audit = await page.evaluate(async () => {
            const { executeSlashCommandsWithOptions: run } = await import('/scripts/slash-commands.js');
            const { power_user } = await import('/scripts/power-user.js');
            const engine = power_user.experimental_macro_engine;
            power_user.experimental_macro_engine = false;
            try {
                const indexed = await run('/let key=items ["first","second"] | /pass {{var::items::1}}');
                const invalid = await run('/not-a-real-neconyan-command');
                return { indexed: indexed.pipe, invalidIsError: invalid.isError };
            } finally {
                // Browser-built replies would otherwise open the one-time engine prompt over the composer.
                power_user.experimental_macro_engine = engine;
            }
        });
        expect(audit).toEqual({ indexed: 'second', invalidIsError: true });
        await submit('/not-a-real-neconyan-command <img id="slash-error-html">');
        await expect(input).toHaveValue('/not-a-real-neconyan-command <img id="slash-error-html">');
        await expect(page.locator('#slash-error-html')).toHaveCount(0);
        await page.evaluate(async () => {
            window.toastr.remove();
            const core = await import('/script.js');
            window.slashGenerationEvents = 0;
            core.eventSource.on(core.event_types.GENERATION_STARTED, () => window.slashGenerationEvents++);
        });

        app.provider.mode.hold = 'conversation-fixture';
        await input.fill('Keep replying while I use a command.');
        if (phone) await send.tap();
        else await send.click();
        await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBe(1);
        await input.fill('Keep this ordinary draft');
        await expect(send).toBeHidden();
        await input.press('Enter');
        await expect(input).toHaveValue('Keep this ordinary draft');
        expect(await page.evaluate(async () => {
            const { executeSlashCommandsWithOptions: run } = await import('/scripts/slash-commands.js');
            return [(await run('/is-generating')).pipe, (await run('/wait-generation timeout=20')).pipe];
        })).toEqual(['true', 'false']);
        await input.fill('/echo Slash command ran');
        await input.blur();
        await expect(send).toBeVisible();
        await page.screenshot({ path: `${prefix}-generating.png` });
        const buttons = await page.locator('#send_but, #mes_stop').evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width, height: rect.height };
        }));
        expect(buttons[0].right <= buttons[1].x || buttons[1].right <= buttons[0].x).toBe(true);
        for (const button of buttons) {
            expect(button.x).toBeGreaterThanOrEqual(0);
            expect(button.right).toBeLessThanOrEqual(phone ? 393 : 1280);
            expect(button.bottom).toBeLessThanOrEqual(phone ? 852 : 900);
            if (phone) expect(Math.abs(button.width - button.height)).toBeLessThan(1);
        }
        for (const profile of [null, 'Pearl', 'Midnight Ink']) {
            if (profile) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${profile} accent profile"]`).evaluate(element => element.click());
            const contrast = await send.evaluate(async element => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const channels = colour => {
                    ctx.fillStyle = colour;
                    ctx.fillRect(0, 0, 1, 1);
                    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
                };
                const style = getComputedStyle(element);
                return contrastRatio(channels(style.color), channels(style.backgroundColor));
            });
            expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
        await page.locator('.sb-accent-profile-apply').first().evaluate(element => element.click());
        if (phone) await send.tap();
        else await send.click();
        await expect(page.locator('#toast-container')).toContainText('Slash command ran');
        await expect(input).toHaveValue('');
        await expect(page.locator('#mes_stop')).toBeVisible();
        expect(app.provider.calls).toHaveLength(1);
        expect(app.provider.calls[0].completedAt).toBeNull();
        expect(await page.evaluate(() => window.slashGenerationEvents)).toBe(1);
        await input.press('Alt+ArrowUp');
        await expect(input).toHaveValue('/echo Slash command ran');

        // Script cancellation is independent of reply cancellation, including on phones.
        for (const command of ['/delay 60000 | /echo Should never run', '/wait-generation | /echo Should never run', '/trigger await=true | /echo Should never run']) {
            await submit(command);
            const stopScript = page.locator('.stscript_stop');
            await expect(stopScript).toBeVisible();
            await input.fill('A newer draft survives script cancellation');
            if (command.startsWith('/delay')) await page.screenshot({ path: `${prefix}-script-stop.png` });
            if (phone) await stopScript.tap();
            else await stopScript.click();
            await expect(stopScript).toBeHidden({ timeout: 2000 });
            await expect(input).toHaveValue('A newer draft survives script cancellation');
            await expect(page.locator('#mes_stop')).toBeVisible();
            await expect(page.locator('#toast-container')).not.toContainText('Should never run');
            expect(app.provider.calls[0].completedAt).toBeNull();
        }

        await input.fill('/stop');
        if (phone) await send.tap();
        else await input.press('Enter');
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).isGenerating())).toBe(false);
        expect(await page.evaluate(async () => {
            const { executeSlashCommandsWithOptions: run } = await import('/scripts/slash-commands.js');
            return [(await run('/is-generating')).pipe, (await run('/wait-generation')).pipe];
        })).toEqual(['false', 'true']);
    });

    test(`${phone ? 'phone' : 'desktop'} Neconyan slash commands UI, geometry, browser, contrast, and themes`, async ({ app }, info) => {
        const account = await app.account({ phone, activeConnection: true, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context);
        const page = await account.open({ workspace: false });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        if (phone) await applyIOSOnlyCss(page);
        const screenshotDirectory = process.env.NECONYAN_SLASH_SCREENSHOTS;
        const capture = async name => {
            if (screenshotDirectory) await page.screenshot({ path: `${screenshotDirectory}/slash-${name}-after.png`, scale: 'css' });
        };

        const waitPaint = () => page.evaluate(() => new Promise(resolve => {
            window.requestAnimationFrame(() => {
                const channel = new window.MessageChannel();
                channel.port1.onmessage = () => resolve();
                channel.port2.postMessage(null);
            });
        }));

        const input = page.locator('#send_textarea');
        const send = page.locator('#send_but');
        await expect(input).toBeVisible();

        // 1. Open autocomplete on /ec and verify header + non-blurring details toggle + geometry.
        await input.click();
        await input.fill('/ec');
        await input.evaluate(element => {
            element.setSelectionRange(3, 3);
            element.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const wrap = page.locator('.autoComplete-wrap');
        const detailsWrap = page.locator('.autoComplete-detailsWrap');
        const toggleBtn = page.locator('.autoComplete-wrap .nn-ac-details-toggle');
        const closeBtn = page.locator('.autoComplete-detailsWrap .nn-ac-details-close');

        await expect(wrap).toBeVisible();
        await expect(page.locator('.autoComplete-wrap .nn-ac-header')).toBeVisible();
        await expect(page.locator('.autoComplete-wrap .nn-ac-count')).toContainText(/\d+\s+match/i);
        await expect(toggleBtn).toBeVisible();
        await expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');
        const countFullRows = () => wrap.locator('ul.autoComplete').evaluate(list => {
            const bounds = list.getBoundingClientRect();
            return [...list.querySelectorAll(':scope > .item[data-option-type="command"]')].filter(item => {
                const row = item.getBoundingClientRect();
                return row.height > 0 && row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1;
            }).length;
        });
        if (phone) {
            await expect(wrap.locator('li[data-name="echo"] > .specs > .body')).toBeHidden();
            await expect(wrap.locator('li[data-name="echo"] .helpContent')).toBeVisible();
            await expect.poll(countFullRows).toBeGreaterThanOrEqual(3);
            const fullRows = await countFullRows();
            await info.attach('phone-visible-suggestions', { body: JSON.stringify({ fullRows }), contentType: 'application/json' });
            await capture('autocomplete-phone');
        } else {
            const echoName = await wrap.locator('li[data-name="echo"] > .specs > .name').boundingBox();
            const echoStyleName = await wrap.locator('li[data-name="echostyle"] > .specs > .name').boundingBox();
            expect(Math.abs(echoName.x - echoStyleName.x)).toBeLessThanOrEqual(1);
        }

        // Open details via toggle button without blurring textarea.
        if (phone) await toggleBtn.tap();
        else await toggleBtn.click();
        await expect(detailsWrap).toBeVisible();
        await expect(toggleBtn).toHaveAttribute('aria-pressed', 'true');
        await expect(closeBtn).toBeVisible();
        await expect(detailsWrap.locator('.argument-name').filter({ hasText: /^title$/ })).toBeVisible();
        await waitPaint();

        const openState = await page.evaluate(() => {
            const vpWidth = window.visualViewport ? window.visualViewport.width : window.innerWidth;
            const vpHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
            const listRect = document.querySelector('.autoComplete-wrap').getBoundingClientRect();
            const detRect = document.querySelector('.autoComplete-detailsWrap').getBoundingClientRect();
            const toggleRect = document.querySelector('.nn-ac-details-toggle').getBoundingClientRect();
            const closeRect = document.querySelector('.nn-ac-details-close').getBoundingClientRect();
            const rowRects = [...document.querySelectorAll('.autoComplete-wrap li.item')].map(item => item.getBoundingClientRect());
            const rowOverlap = rowRects.some((row, i) => i > 0 && row.top < rowRects[i - 1].bottom - 1);
            const overlaps = !(
                listRect.right <= detRect.left + 1 ||
                detRect.right <= listRect.left + 1 ||
                listRect.bottom <= detRect.top + 1 ||
                detRect.bottom <= listRect.top + 1
            );
            return {
                activeId: document.activeElement?.id ?? null,
                vpWidth,
                vpHeight,
                list: { left: listRect.left, top: listRect.top, right: listRect.right, bottom: listRect.bottom, width: listRect.width, height: listRect.height },
                details: { left: detRect.left, top: detRect.top, right: detRect.right, bottom: detRect.bottom, width: detRect.width, height: detRect.height },
                toggleHeight: toggleRect.height,
                closeHeight: closeRect.height,
                overlaps,
                rowOverlap,
                stackedAbove: detRect.bottom <= listRect.top + 1,
                sideBySide: detRect.left >= listRect.right - 1 || listRect.left >= detRect.right - 1,
                sourceBg: getComputedStyle(document.querySelector('.autoComplete-details .source'), '::after').backgroundImage,
            };
        });
        await info.attach('autocomplete-geometry', { body: JSON.stringify(openState, null, 2), contentType: 'application/json' });

        expect(openState.activeId).toBe('send_textarea');
        expect(openState.overlaps).toBe(false);
        expect(openState.rowOverlap).toBe(false);
        expect(openState.list.left).toBeGreaterThanOrEqual(4);
        expect(openState.list.right).toBeLessThanOrEqual(openState.vpWidth - 4);
        expect(openState.list.top).toBeGreaterThanOrEqual(4);
        expect(openState.list.bottom).toBeLessThanOrEqual(openState.vpHeight - 4);
        expect(openState.details.left).toBeGreaterThanOrEqual(4);
        expect(openState.details.right).toBeLessThanOrEqual(openState.vpWidth - 4);
        expect(openState.details.top).toBeGreaterThanOrEqual(4);
        expect(openState.details.bottom).toBeLessThanOrEqual(openState.vpHeight - 4);
        expect(openState.sourceBg).not.toContain('favicon');
        if (phone) {
            expect(openState.stackedAbove).toBe(true);
            expect(openState.toggleHeight).toBeGreaterThanOrEqual(44);
            expect(await countFullRows()).toBeGreaterThanOrEqual(2);
            expect(openState.closeHeight).toBeGreaterThanOrEqual(44);
        } else {
            expect(openState.sideBySide).toBe(true);
        }

        // 2. Contrast >= 4.5:1 across Calico Dark, Calico Light, Mint Glass and Plum Wine.
        const measureContrast = () => page.evaluate(async () => {
            const { contrastRatio } = await import('/scripts/theme-contrast.js');
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext('2d');
            const compositeChain = element => {
                const chain = [];
                let cur = element;
                while (cur && cur.nodeType === 1) {
                    const bg = getComputedStyle(cur).backgroundColor;
                    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') chain.push(bg);
                    cur = cur.parentElement;
                }
                ctx.clearRect(0, 0, 1, 1);
                ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--neco-surface').trim() || '#1c1816';
                ctx.fillRect(0, 0, 1, 1);
                for (let i = chain.length - 1; i >= 0; i--) {
                    ctx.fillStyle = chain[i];
                    ctx.fillRect(0, 0, 1, 1);
                }
                return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            const measureElement = el => {
                const bg = compositeChain(el);
                ctx.clearRect(0, 0, 1, 1);
                ctx.fillStyle = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
                ctx.fillRect(0, 0, 1, 1);
                ctx.fillStyle = getComputedStyle(el).color;
                ctx.fillRect(0, 0, 1, 1);
                const fg = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
                return contrastRatio(fg, bg);
            };
            const measure = (selector, all = false) => {
                const labels = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length > 0);
                if (labels.length === 0) return null;
                return all ? Math.min(...labels.map(measureElement)) : measureElement(labels[0]);
            };
            return {
                selectedName: measure('.autoComplete > li.item.selected .name'),
                matched: measure('.autoComplete > li.item.selected .matched'),
                typeBadge: measure('.autoComplete > li.item.selected .type'),
                activeToggle: measure('.autoComplete-wrap .nn-ac-details-toggle[aria-pressed="true"]'),
                sourceBadge: measure('.autoComplete-details .source'),
                detailsArgumentNames: measure('.autoComplete-details .argument-name', true),
                detailsArgumentTypes: measure('.autoComplete-details .argument-type', true),
                inlineArgumentNames: measure('.autoComplete-wrap li[data-name="echo"] .argument-name', true),
                inlineArgumentTypes: measure('.autoComplete-wrap li[data-name="echo"] .argument-type', true),
            };
        });

        const palettes = [
            { label: 'calico-dark', theme: 'Neconyan Calico Dark', accent: null, screenshot: 'autocomplete-desktop' },
            { label: 'calico-light', theme: 'Neconyan Calico', accent: null, screenshot: 'autocomplete-light-desktop' },
            { label: 'mint-glass', theme: 'Neconyan Calico Dark', accent: 'rgba(110,231,183,1)', screenshot: 'autocomplete-mint-desktop' },
            { label: 'plum-wine', theme: 'Neconyan Calico Dark', accent: 'rgba(126,34,206,1)', screenshot: 'autocomplete-plum-desktop' },
        ];

        for (const variant of palettes) {
            await page.evaluate(name => window.jQuery('#themes').val(name).trigger('change'), variant.theme);
            if (variant.accent) {
                await page.evaluate(rgba => {
                    for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) {
                        document.getElementById(id)?.dispatchEvent(new CustomEvent('change', { detail: { rgba } }));
                    }
                }, variant.accent);
            }
            await waitPaint();
            const ratios = await measureContrast();
            await info.attach(`autocomplete-contrast-${variant.label}`, { body: JSON.stringify(ratios, null, 2), contentType: 'application/json' });
            expect(ratios.selectedName, `${variant.label} selectedName`).toBeGreaterThanOrEqual(4.5);
            expect(ratios.matched, `${variant.label} matched`).toBeGreaterThanOrEqual(4.5);
            expect(ratios.typeBadge, `${variant.label} typeBadge`).toBeGreaterThanOrEqual(4.5);
            expect(ratios.activeToggle, `${variant.label} activeToggle`).toBeGreaterThanOrEqual(4.5);
            expect(ratios.sourceBadge, `${variant.label} sourceBadge`).toBeGreaterThanOrEqual(4.5);
            expect(ratios.detailsArgumentNames, `${variant.label} details argument names`).toBeGreaterThanOrEqual(4.5);
            expect(ratios.detailsArgumentTypes, `${variant.label} details argument types`).toBeGreaterThanOrEqual(4.5);
            if (!phone) {
                expect(ratios.inlineArgumentNames, `${variant.label} inline argument names`).toBeGreaterThanOrEqual(4.5);
                expect(ratios.inlineArgumentTypes, `${variant.label} inline argument types`).toBeGreaterThanOrEqual(4.5);
            }
            if (!phone) await capture(variant.screenshot);
            else if (variant.label === 'calico-dark') await capture('autocomplete-details-phone');
        }
        // Restore default Calico Dark after palette loop.
        await page.evaluate(() => window.jQuery('#themes').val('Neconyan Calico Dark').trigger('change'));
        await waitPaint();

        // 3. Kittyless strips paw backgrounds; Windows 98 applies square chrome; Termeownal hides Neconyan header.
        if (!phone) {
            await expect(wrap).toHaveCSS('background-image', /paw-/);
            await page.evaluate(() => window.NeconyanShell.applyTheme('kittyless'));
            await expect(page.locator('html')).toHaveAttribute('data-sb-kittyless', 'true');
            await expect(wrap).not.toHaveCSS('background-image', /paw-/);
            await expect(detailsWrap).not.toHaveCSS('background-image', /paw-/);

            await page.evaluate(() => window.NeconyanShell.applyTheme('windows-98'));
            await expect(wrap).toHaveCSS('border-radius', '0px');

            await page.evaluate(() => window.NeconyanShell.applyTheme('calico'));
            await waitPaint();

            const terminalStyles = await page.addStyleTag({ url: '/scripts/extensions/third-party/Neconyan-Terminal-UI/style.css' });
            const terminal = await page.evaluate(() => {
                document.body.classList.add('sbterm');
                try {
                    const list = document.querySelector('.autoComplete-wrap');
                    const sample = document.createElement('span');
                    sample.style.backgroundColor = 'var(--sbterm-bg)';
                    list.append(sample);
                    const measured = {
                        headerDisplay: getComputedStyle(list.querySelector('.nn-ac-header')).display,
                        rowDisplay: getComputedStyle(list.querySelector('li.item')).display,
                        actualBackground: getComputedStyle(list).backgroundColor,
                        terminalBackground: getComputedStyle(sample).backgroundColor,
                    };
                    sample.remove();
                    return measured;
                } finally {
                    document.body.classList.remove('sbterm');
                }
            });
            await terminalStyles.evaluate(link => link.remove());
            expect(terminal.headerDisplay).toBe('none');
            expect(terminal.rowDisplay).toBe('contents');
            expect(terminal.terminalBackground).not.toBe('rgba(0, 0, 0, 0)');
            expect(terminal.actualBackground).toBe(terminal.terminalBackground);
        }

        // 4. Close details via close button without blurring textarea.
        if (phone) await closeBtn.tap();
        else await closeBtn.click();
        await expect(detailsWrap).toBeHidden();
        await expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('send_textarea');

        if (phone) {
            await page.setViewportSize({ width: 393, height: 300 });
            await expect(wrap).toBeVisible();
            await toggleBtn.tap();
            await expect(wrap).toBeHidden();
            await expect(detailsWrap).toBeVisible();
            const shortGeometry = await detailsWrap.evaluate(element => {
                const viewport = window.visualViewport;
                const box = element.getBoundingClientRect();
                const composer = document.querySelector('#send_form').getBoundingClientRect();
                return { top: box.top, bottom: box.bottom, width: box.width, viewportTop: viewport.offsetTop, composerTop: composer.top };
            });
            await info.attach('autocomplete-short-viewport', { body: JSON.stringify(shortGeometry), contentType: 'application/json' });
            expect(shortGeometry.top).toBeGreaterThanOrEqual(shortGeometry.viewportTop + 7);
            expect(shortGeometry.bottom).toBeLessThanOrEqual(shortGeometry.composerTop - 7);
            expect(shortGeometry.width).toBeCloseTo(377, 0);
            await closeBtn.tap();
            await expect(wrap).toBeVisible();
            await expect(input).toBeFocused();
            await page.setViewportSize({ width: 393, height: 852 });
        }

        // 5. Run /help slash and verify Neconyan Slash Command Browser.
        await input.fill('/help slash');
        await input.blur();
        if (phone) await send.tap();
        else await send.click();

        const browser = page.locator('.slashCommandBrowser').last();
        await expect(browser).toBeVisible();
        await expect(browser.locator('.nn-scb-title')).toHaveText('Slash Commands');
        const initialCount = await browser.locator('.nn-scb-count').textContent();
        expect(initialCount).toMatch(/\d+\s+commands/);

        // Filter pills update aria-pressed & match count.
        const coreBtn = browser.locator('.nn-scb-filter-btn[data-filter="core"]');
        const allBtn = browser.locator('.nn-scb-filter-btn[data-filter="all"]');
        if (phone) await coreBtn.tap();
        else await coreBtn.click();
        await expect(coreBtn).toHaveAttribute('aria-pressed', 'true');
        await expect(allBtn).toHaveAttribute('aria-pressed', 'false');

        // Search filters commands using debounced input.
        const search = browser.locator('.searchInput');
        const countBeforeSearch = await browser.locator('.nn-scb-count').textContent();
        const searchErrors = [];
        page.on('pageerror', error => searchErrors.push(error.message));
        await search.fill('echo');
        await expect.poll(async () => ({ count: await browser.locator('.nn-scb-count').textContent(), errors: searchErrors }))
            .not.toEqual({ count: countBeforeSearch, errors: [] });
        expect(searchErrors).toEqual([]);
        const echoItem = browser.locator('.autoComplete > li.item[data-name="echo"]').first();
        await expect(echoItem).toBeVisible();
        await expect(browser.locator('.nn-scb-count')).toContainText(/\d+\s+of\s+\d+/);
        await expect(browser.locator('.nn-scb-count')).not.toHaveText(countBeforeSearch);
        const filtered = browser.locator('.autoComplete > li.item.isFiltered');
        expect(await filtered.count()).toBeGreaterThan(0);
        await expect(filtered.first()).toHaveCSS('display', 'none');

        // Select echo and verify details + responsive back/close button.
        if (phone) await echoItem.tap();
        else await echoItem.click();
        const browserDetails = browser.locator('.autoComplete-detailsWrap');
        await expect(browserDetails).toBeVisible();
        await expect(browserDetails).toContainText('/echo');
        const browserGeometry = await browser.evaluate(element => {
            const list = element.querySelector('.commandContainer > .autoComplete');
            const details = element.querySelector('.autoComplete-detailsWrap');
            const ancestors = [];
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                const { display, maxWidth } = getComputedStyle(parent);
                ancestors.push({ node: parent.id || parent.className || parent.tagName, width: parent.clientWidth, display, maxWidth });
                if (parent.id === 'chat') break;
            }
            return { width: element.clientWidth, listVisible: list.getClientRects().length > 0,
                listRight: list.getBoundingClientRect().right, detailsLeft: details.getBoundingClientRect().left, ancestors };
        });
        await info.attach('command-browser-geometry', { body: JSON.stringify(browserGeometry), contentType: 'application/json' });
        expect(browserGeometry.listVisible).toBe(!phone);
        if (!phone) expect(browserGeometry.detailsLeft - browserGeometry.listRight).toBeGreaterThanOrEqual(8);
        await browser.locator('.nn-scb-title').evaluate(element => element.scrollIntoView({ block: 'start' }));
        await capture(`browser-${phone ? 'phone' : 'desktop'}`);

        if (phone) {
            const backBtn = browser.locator('.nn-scb-details-back');
            await expect(backBtn).toBeVisible();
            const backBox = await backBtn.boundingBox();
            expect(backBox.height).toBeGreaterThanOrEqual(44);
            await backBtn.tap();
            await expect(browserDetails).toBeHidden();
        } else {
            const closeBrowserDetails = browser.locator('.nn-scb-details-close');
            await expect(closeBrowserDetails).toBeVisible();
            await closeBrowserDetails.click();
            await expect(browserDetails).toBeHidden();
        }
    });
}
