/* global document, getComputedStyle, window, requestAnimationFrame */
/* eslint-disable playwright/no-conditional-in-test -- Phone and desktop share the same checks with viewport-specific sizes. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { openContextDrawer, showContextSection } from './neconyan-scratchpad-context-helpers.js';

const SECTIONS = ['sharing', 'replies', 'setup'];

async function openRoleplay(page, account) {
    await page.evaluate(async avatar => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes ?? null)).toBe('Hello.');
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'context' }));
    await page.addStyleTag({ content: '#toast-container, #nn-update-toast { display: none; }' });
    await expect(page.locator('#scratchpad-panel-context .scratchpad-context-summary')).toBeVisible();
    await expect(page.locator('.scratchpad-web-status')).not.toHaveText('Web search settings are loading.');
}

async function start(app, phone) {
    const account = await app.account({
        phone,
        configureSettings: settings => {
            const manager = settings.extension_settings.connectionManager;
            manager.profiles.push({ ...manager.profiles[0], id: 'layout-taro', name: 'Taro layout', model: 'layout-taro' });
        },
    });
    const page = await account.open({ workspace: false });
    await openRoleplay(page, account);
    return { account, page };
}

const pills = page => page.locator('#scratchpad-panel-context .scratchpad-context-pill').allTextContents();
const tab = (page, name) => page.locator(`#scratchpad-context-tab-${name}`);
const sessionSaved = page => page.waitForResponse(response => response.url().includes('/api/scratchpad/session/update') && response.ok());

for (const phone of [false, true]) {
    const size = phone ? 'phone' : 'desktop';

    test(`${size} Context opens on a live summary with Show preview and keyboard-friendly sub-tabs`, async ({ app }) => {
        test.setTimeout(180000);
        const { account, page } = await start(app, phone);
        const panel = page.locator('#scratchpad-panel-context');
        const preview = page.getByRole('button', { name: 'Show preview', exact: true });

        // The summary and Show preview sit above the sub-tabs, inside the first screen.
        const layout = await panel.evaluate(element => {
            const top = element.getBoundingClientRect().top;
            const offset = selector => element.querySelector(selector).getBoundingClientRect().top - top;
            return { summary: offset('.scratchpad-context-summary'), tabs: offset('.scratchpad-context-tabs'), preview: offset('.scratchpad-preview-button'),
                messages: offset('.scratchpad-context-messages'), height: element.clientHeight };
        });
        expect(layout.summary).toBeLessThan(layout.tabs);
        expect(layout.preview).toBeLessThan(layout.tabs);
        expect(layout.messages).toBeLessThan(layout.height);
        await expect(tab(page, 'sharing')).toHaveAttribute('aria-selected', 'true');
        expect(await pills(page)).toEqual(expect.arrayContaining(['15 msgs', 'Card', 'Persona']));

        // Pills follow the controls straight away, while the save is still on its way to the server.
        let release;
        const held = new Promise(resolve => { release = resolve; });
        await page.route('**/api/scratchpad/session/update', async route => { await held; await route.continue(); });
        const persona = page.getByRole('checkbox', { name: 'Your persona and Scenario Notes', exact: true });
        await persona.uncheck();
        await expect.poll(() => pills(page)).not.toContain('Persona');
        const depth = page.locator('#scratchpad-depth');
        await depth.fill('3');
        await expect.poll(() => pills(page)).toContain('3 msgs');
        await showContextSection(page, 'sharing');
        await openContextDrawer(page, 'tools');
        await page.getByRole('checkbox', { name: /^Agents Shares the name/ }).check();
        await expect.poll(() => pills(page)).toContain('1 tool');
        await expect(page.locator('[data-context-drawer="tools"] .scratchpad-drawer-badge')).toHaveText('1 shared');
        release();
        await page.unroute('**/api/scratchpad/session/update');
        await depth.dispatchEvent('change');
        const source = await page.evaluate(async () => {
            const context = await import('/scripts/scratchpad/context.js');
            return context.wireSource(context.currentSource());
        });
        await expect.poll(async () => {
            const bucket = (await account.post('/api/scratchpad/bucket', { source })).bucket;
            const settings = bucket.sessions.find(session => session.id === bucket.activeSessionId)?.settings;
            return settings && { depth: settings.depth, persona: settings.include.persona, agents: settings.include.agents };
        }, { timeout: 15000 }).toEqual({ depth: 3, persona: false, agents: true });
        await expect.poll(() => pills(page)).toEqual(expect.arrayContaining(['3 msgs', 'Card', '1 tool']));
        expect(await pills(page)).not.toContain('Persona');

        await preview.click();
        await expect(page.locator('.scratchpad-context-summary .scratchpad-preview-text')).toBeVisible();

        // Mouse selects a sub-tab; arrows, Home and End move between them and keep focus on the tab.
        await tab(page, 'replies').click();
        await expect(tab(page, 'replies')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#scratchpad-context-pane-replies')).toBeVisible();
        await expect(page.locator('#scratchpad-context-pane-sharing')).toBeHidden();
        await page.keyboard.press('ArrowRight');
        await expect(tab(page, 'setup')).toBeFocused();
        await expect(tab(page, 'setup')).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Home');
        await expect(tab(page, 'sharing')).toBeFocused();
        await page.keyboard.press('End');
        await expect(tab(page, 'setup')).toBeFocused();
        await page.keyboard.press('ArrowLeft');
        await expect(tab(page, 'replies')).toBeFocused();
        await expect(tab(page, 'replies')).toHaveAttribute('aria-selected', 'true');
        // The main Scratchpad tabs stay on Context while the arrows move the sub-tabs.
        await expect(page.getByRole('tab', { name: 'Context', exact: true })).toHaveAttribute('aria-selected', 'true');
        for (const name of SECTIONS) {
            const height = await tab(page, name).evaluate(element => element.getBoundingClientRect().height);
            expect(height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        }
    });

    test(`${size} the sub-tab, drawers, scroll and focus survive saves and reloads`, async ({ app }) => {
        test.setTimeout(180000);
        const { account, page } = await start(app, phone);
        const panel = page.locator('#scratchpad-panel-context');
        await showContextSection(page, 'replies');
        await expect(page.locator('[data-context-drawer="other-assistants"]')).not.toHaveJSProperty('open', true);
        await expect(page.locator('[data-context-drawer="prefills"]')).not.toHaveJSProperty('open', true);
        await expect(page.locator('[data-context-drawer="summary"] .scratchpad-drawer-badge')).toHaveText('Off');
        await openContextDrawer(page, 'prefills');
        const summary = await openContextDrawer(page, 'summary');
        const toggle = summary.getByRole('checkbox', { name: 'Summarise older discussion' });
        await toggle.scrollIntoViewIfNeeded();
        await panel.evaluate(element => { element.scrollTop = Math.max(0, element.scrollTop - 40); });
        const before = await panel.evaluate(element => element.scrollTop);
        // This switch saves and redraws the whole Context tab.
        const saved = sessionSaved(page);
        await toggle.check();
        await saved;
        await expect(summary.locator('.scratchpad-drawer-badge')).toHaveText('On');
        await expect(tab(page, 'replies')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[data-context-drawer="prefills"]')).toHaveJSProperty('open', true);
        await expect(page.locator('[data-context-drawer="summary"]')).toHaveJSProperty('open', true);
        await expect(summary.getByRole('checkbox', { name: 'Summarise older discussion' })).toBeFocused();
        expect(Math.abs(await panel.evaluate(element => element.scrollTop) - before)).toBeLessThanOrEqual(1);

        // Settings that are in use open their drawers by themselves after a reload.
        await page.locator('#scratchpad-prefill').fill('Here is the plan:');
        const prefillSaved = sessionSaved(page);
        await page.locator('#scratchpad-prefill').blur();
        await prefillSaved;
        await expect(page.locator('[data-context-drawer="prefills"] .scratchpad-drawer-badge')).toHaveText('Active');
        await openContextDrawer(page, 'other-assistants');
        const taroSaved = sessionSaved(page);
        await page.locator('#scratchpad-connection-taro').selectOption('layout-taro');
        await taroSaved;
        await expect(page.locator('[data-context-drawer="other-assistants"] .scratchpad-drawer-badge')).toHaveText('1 custom');
        await expect.poll(async () => {
            const { accountStorage } = JSON.parse((await account.post('/api/settings/get')).settings);
            return JSON.parse(accountStorage?.neconyanScratchpad ?? '{}').contextSubTab;
        }, { timeout: 15000 }).toBe('replies');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('body.neconyan-rail-ready').waitFor({ timeout: 60000 });
        await openRoleplay(page, account);
        await expect(tab(page, 'replies')).toHaveAttribute('aria-selected', 'true');
        for (const name of ['other-assistants', 'summary', 'prefills']) {
            await expect(page.locator(`[data-context-drawer="${name}"]`)).toHaveJSProperty('open', true);
        }
        await expect(page.locator('#scratchpad-prefill')).toHaveValue('Here is the plan:');
        await expect(page.locator('#scratchpad-connection-taro')).toHaveValue('layout-taro');
    });

    test(`${size} Round Table lists every participant, and a lone assistant tucks the others away`, async ({ app }) => {
        test.setTimeout(180000);
        const { page } = await start(app, phone);
        await showContextSection(page, 'replies');
        const replies = page.locator('#scratchpad-context-pane-replies');
        const others = page.locator('[data-context-drawer="other-assistants"]');
        await expect(others.locator('.scratchpad-drawer-title')).toHaveText('Other assistants (2)');
        await expect(page.locator('#scratchpad-connection-miso')).toBeVisible();
        await expect(page.locator('#scratchpad-connection-taro')).toBeHidden();
        await expect(replies.getByRole('button', { name: 'View or edit Miso\'s prompt', exact: true })).toBeVisible();

        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.locator('.scratchpad-round-table').click();
        await expect(page.locator('.scratchpad-round-table')).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(tab(page, 'replies')).toHaveAttribute('aria-selected', 'true');
        await expect(others).toHaveCount(0);
        for (const [id, name] of [['miso', 'Miso'], ['taro', 'Taro'], ['nori', 'Nori']]) {
            await expect(page.locator(`#scratchpad-connection-${id}`)).toBeVisible();
            await expect(replies.getByRole('button', { name: `View or edit ${name}'s prompt`, exact: true })).toBeVisible();
        }
    });

    test(`${size} every sub-tab fits without sideways scrolling and its chips and tabs stay readable on Calico, Mint Glass and Plum Wine`, async ({ app }) => {
        test.setTimeout(240000);
        const { page } = await start(app, phone);
        await page.getByRole('checkbox', { name: 'Character cards', exact: true }).check();
        for (const name of SECTIONS) {
            await showContextSection(page, name);
            for (const drawer of await page.locator(`#scratchpad-context-pane-${name} details.scratchpad-drawer`).all()) {
                if (!await drawer.evaluate(element => element.open)) await drawer.locator(':scope > summary').click();
            }
            const overflow = await page.locator('#scratchpad-panel-context').evaluate(element => {
                const right = element.getBoundingClientRect().right;
                const wide = [...element.querySelectorAll('*')].filter(node => node.getClientRects().length && node.getBoundingClientRect().right > right + 1)
                    .map(node => node.className || node.tagName);
                const clippedBadges = [...element.querySelectorAll('.scratchpad-drawer-badge')]
                    .filter(node => node.getClientRects().length && node.textContent.trim().length <= 20 && node.scrollWidth > node.clientWidth + 1)
                    .map(node => node.textContent);
                return { scroll: element.scrollWidth - element.clientWidth, wide, clippedBadges };
            });
            expect(overflow, `${name} ${JSON.stringify(overflow)}`).toEqual({ scroll: 0, wide: [], clippedBadges: [] });
        }
        await showContextSection(page, 'sharing');
        const chips = await page.locator('#scratchpad-context-pane-sharing .scratchpad-chip-toggle').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        expect(chips.length).toBeGreaterThan(3);
        for (const height of chips) expect(height).toBeGreaterThanOrEqual(phone ? 44 : 36);

        const results = [];
        for (const [accent, rgba] of [['Calico', null], ['Mint Glass', 'rgba(110,231,183,1)'], ['Plum Wine', 'rgba(126,34,206,1)']]) {
            const measured = await page.locator('#scratchpad-panel-context').evaluate(async (panel, colour) => {
                if (colour) for (const id of ['sb-accent-primary-picker', 'sb-accent-secondary-picker']) document.getElementById(id).dispatchEvent(new CustomEvent('change', { detail: { rgba: colour } }));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas').getContext('2d');
                const pixel = colours => {
                    canvas.clearRect(0, 0, 1, 1);
                    for (const value of colours) { canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1); }
                    return [...canvas.getImageData(0, 0, 1, 1).data];
                };
                const paint = colours => pixel(colours).slice(0, 3);
                // Translucent fills are layered over their ancestors' backgrounds, from the first opaque one up.
                const backdrop = element => {
                    const layers = [];
                    for (let node = element; node; node = node.parentElement) {
                        const fill = getComputedStyle(node).backgroundColor;
                        layers.unshift(fill);
                        if (pixel([fill])[3] === 255) break;
                    }
                    return paint(['rgb(255, 255, 255)', ...layers]);
                };
                const sample = (label, element, text = element) => ({ label, ratio: contrastRatio(paint([getComputedStyle(text).color]), backdrop(element)) });
                const checked = panel.querySelector('.scratchpad-chip-toggle:has(input:checked)');
                const unchecked = panel.querySelector('.scratchpad-chip-toggle:has(input:not(:checked))');
                return [
                    sample('selected tab', panel.querySelector('.scratchpad-context-tab[aria-selected="true"]')),
                    sample('other tab', panel.querySelector('.scratchpad-context-tab[aria-selected="false"]')),
                    sample('checked chip', checked, checked.querySelector('span')),
                    sample('unchecked chip', unchecked, unchecked.querySelector('span')),
                    sample('summary pill', panel.querySelector('.scratchpad-context-pill')),
                    sample('drawer badge', panel.querySelector('.scratchpad-drawer-badge')),
                ];
            }, rgba);
            for (const item of measured) {
                results.push({ accent, ...item });
                expect(item.ratio, JSON.stringify({ accent, ...item })).toBeGreaterThanOrEqual(4.5);
            }
        }
        await test.info().attach('context-contrast', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    });
}
