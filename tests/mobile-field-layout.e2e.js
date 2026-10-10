// @ts-check
/* global document, window, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Fixed viewport cases exercise different responsive layouts. */
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';
import { test, expect } from '@playwright/test';

test.use({ hasTouch: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(90_000);

test.beforeEach(async ({ page }) => {
    await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
});

test('memory corrections and expression actions fit phone, tablet and desktop widths', async ({ page }, testInfo) => {
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
    const workspace = page.locator('#mewmory-workspace');
    await expect(workspace.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    // Seed only browser state; layout coverage does not need a model or a saved chat.
    await page.evaluate(async () => {
        const { mewmory, notifyMewmory } = await import('/scripts/mewmory/index.js');
        const record = {
            id: 'layout-record', entityId: 'layout-character', kind: 'entity',
            name: 'Price of Dismissal | Dominick', text: 'Price of Dismissal | Dominick',
            subjectIds: [], refs: [], status: 'active', significance: 'low', asOf: -1,
        };
        const view = {
            enabled: true, locator: { chat: 'Mobile layout check' }, activeNpcIds: null,
            activeReferences: { ids: [record.entityId], records: [record] },
            entities: [record], records: [record], overviews: [], health: { pending: 0 },
        };
        window.addEventListener('mewmory:updated', () => {
            if (mewmory.view === view) return;
            mewmory.view = view;
            notifyMewmory();
        });
        mewmory.view = view;
        notifyMewmory();
    });
    const actions = workspace.locator('.mewmory-record > .mewmory-actions');
    await expect(actions.getByLabel('Correction')).toBeVisible();
    for (const width of [320, 393, 820, 1280]) {
        await page.setViewportSize({ width, height: width <= 393 ? 852 : 900 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await expect(async () => {
            const [select, edit, undo] = await actions.evaluate(element => {
                element.scrollIntoView({ block: 'center' });
                return [...element.querySelectorAll('select, button')].map(control => control.getBoundingClientRect().toJSON());
            });
            expect(select.height, `correction height at ${width}px`).toBeGreaterThanOrEqual(44);
            expect(select.height, `correction height at ${width}px`).toBeLessThanOrEqual(60);
            expect(Math.abs(edit.y + edit.height - undo.y - undo.height)).toBeLessThanOrEqual(1);
            expect(undo.x + undo.width).toBeLessThanOrEqual(width);
            if (width <= 393) {
                expect(select.y + select.height).toBeLessThan(edit.y);
                expect(Math.abs(edit.width - undo.width)).toBeLessThanOrEqual(1);
                expect(edit.height).toBeGreaterThanOrEqual(44);
            }
        }).toPass({ timeout: 10_000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        // The live memory view may replace this row while capturing the image.
        await page.screenshot({ path: testInfo.outputPath(`mewmory-${width}.png`) });
    }

    // Keep the real controls exposed while the extension polls for a saved chat.
    await page.addStyleTag({ content: '#open_chat_expressions { display: block !important; } #no_chat_expressions { display: none !important; }' });
    const expressionActions = page.locator('#open_chat_expressions .expression_buttons');
    const stop = page.locator('#expressions_stop_sprite_generation');
    for (const width of [320, 393, 820, 1280]) {
        await page.setViewportSize({ width, height: width <= 393 ? 852 : 900 });
        await page.evaluate(() => window.NeconyanShell.openIncludedTool('expressions'));
        await expect(page.locator('#user-settings-block .neconyan-shell-page-intro')).toHaveAttribute('data-tool-page', 'expressions', { timeout: 15_000 });
        await expect(page.locator('#expression_override')).toBeAttached();
        const tools = page.locator('#open_chat_expressions .expression_set_tools');
        if (await tools.getAttribute('open') === null) {
            await tools.locator('summary').click();
        }
        await expect(tools).toHaveAttribute('open', '');
        await expect(stop).toBeHidden();
        await expressionActions.scrollIntoViewIfNeeded({ timeout: 10_000 });
        const field = await page.locator('#expression_override').boundingBox();
        const submit = await page.locator('#expression_override_button').boundingBox();
        expect(Math.abs(field.y - submit.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(field.height - submit.height)).toBeLessThanOrEqual(1);
        const boxes = await expressionActions.locator('.menu_button:visible').evaluateAll(elements =>
            elements.map(element => element.getBoundingClientRect().toJSON()));
        expect(boxes).toHaveLength(6);
        for (const box of boxes) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(width);
        }
        if (width <= 393) {
            for (let index = 0; index < boxes.length; index += 2) {
                expect(Math.abs(boxes[index].y - boxes[index + 1].y)).toBeLessThanOrEqual(1);
                expect(Math.abs(boxes[index].width - boxes[index + 1].width)).toBeLessThanOrEqual(1);
                expect(Math.abs(boxes[index].height - boxes[0].height)).toBeLessThanOrEqual(1);
                expect(boxes[index].height).toBeGreaterThanOrEqual(44);
            }
            await stop.evaluate(element => element.classList.add('active'));
            const activeBox = await stop.boundingBox();
            const gridBox = await expressionActions.boundingBox();
            expect(Math.abs(activeBox.width - gridBox.width)).toBeLessThanOrEqual(1);
            expect(activeBox.y).toBeGreaterThanOrEqual(boxes[5].bottom);
            await stop.evaluate(element => element.classList.remove('active'));
            await expect(stop).toBeHidden();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.locator('#open_chat_expressions').screenshot({ path: testInfo.outputPath(`expressions-${width}.png`) });
    }
});

test('field focus stays inside clipped core and bundled-extension panels', async ({ page }, testInfo) => {
    const extensionRoot = '/scripts/extensions/';
    for (const stylesheet of [
        '/css/mewmory.css', '/css/world-info.css',
        ...['quick-image-gen', 'neconyan-chats-archive', 'css-snippets', 'third-party/Neconyan-BotSearcher',
            'third-party/Neconyan-Hopper', 'third-party/Neconyan-PromptTags',
            'third-party/Neconyan-WorldInfo-Lab', 'third-party/Neconyan-Regex-Agent-Themes',
            'third-party/sillytavern-character-colors'].map(name => `${extensionRoot}${name}/style.css`),
    ]) {
        await page.addStyleTag({ url: new URL(stylesheet, page.url()).href });
    }
    await page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext();
        const html = await ctx.renderExtensionTemplateAsync('third-party/Neconyan-BotSearcher', 'templates/browser');
        const popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY, '', {
            large: true, wide: true, leftAlign: true, allowVerticalScrolling: false,
            okButton: false, cancelButton: 'Close',
        });
        void popup.show();
    });
    const query = page.locator('#sbbs_query');
    await query.fill('Selected search text');
    await query.press('ControlOrMeta+A');
    await expect(query).toBeFocused();
    expect(await query.evaluate(element => element.selectionEnd - element.selectionStart)).toBe(20);
    await expect(query).toHaveCSS('outline-offset', '-2px');
    await page.screenshot({ path: testInfo.outputPath('botsearcher-focus-phone.png') });
    await page.locator('dialog.popup[open] .popup-button-close').click();
    await expect(query).toBeHidden();

    const contexts = [
        ['', ''], ['mewmory-workspace', ''], ['neconyan-lorebook-tools', ''],
        ['promptTags-drawer', ''], ['sbwil-settings', ''], ['sbwil-page', ''], ['rat_drawer', ''],
        ['dc-ext', 'dc-bulk-toolbar'], ['dc-harmony-popup', ''], ['dc-context-menu', ''],
        ['qig-settings', ''], ['', 'qig-popup-form'], ['', 'qig-wizard'],
        ['', 'sbtw-shell'], ['', 'sbtw-drawer'], ['', 'sbca-root'], ['', 'dc-dialog'],
    ];
    for (const tone of ['dark', 'light', 'forced-colours']) {
        await page.emulateMedia({ forcedColors: tone === 'forced-colours' ? 'active' : 'none' });
        await page.evaluate(tone => {
            document.documentElement.dataset.neconyanPalette = 'calico';
            document.documentElement.dataset.neconyanCalicoTone = tone === 'light' ? 'light' : 'dark';
        }, tone);
        for (const [id, className] of contexts) {
            await page.evaluate(({ id, className }) => {
                document.querySelector('#field-focus-probe')?.remove();
                const host = document.createElement('div');
                host.id = 'field-focus-probe';
                host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:280px;z-index:2147483647;overflow:hidden;background:var(--neco-surface)';
                const scope = document.createElement('section');
                scope.id = id;
                scope.className = className;
                scope.style.cssText = 'position:relative;inset:auto;display:block;width:100%;height:auto;min-height:0;max-height:none;margin:0;padding:0;overflow:hidden';
                scope.innerHTML = '<input class="text_pole" type="search" aria-label="Search" value="Selected text"><input class="text_pole" type="text" aria-label="Text" value="Selected text"><textarea class="text_pole" aria-label="Editor">Selected text</textarea><select class="text_pole" aria-label="Choice"><option>Selected option</option></select>';
                host.append(scope);
                document.body.append(host);
            }, { id, className });
            const fields = page.locator('#field-focus-probe :is(input, textarea, select)');
            for (const field of await fields.all()) {
                await field.focus();
                await expect(field).toBeFocused();
                const ring = await field.evaluate(element => {
                    const style = getComputedStyle(element);
                    return { width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset),
                        style: style.outlineStyle, colour: style.outlineColor };
                });
                expect(ring.style, `${tone}: ${id || className || 'core'}`).toBe('solid');
                expect(ring.width).toBeGreaterThanOrEqual(2);
                expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
                expect(ring.colour).not.toBe('rgba(0, 0, 0, 0)');
            }
        }
    }
});
