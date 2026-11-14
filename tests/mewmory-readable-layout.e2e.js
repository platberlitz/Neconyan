// @ts-check
/* global document, window, getComputedStyle, requestAnimationFrame */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Phone and desktop widths use different tab layouts. */
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { test, expect } from '@playwright/test';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.use({ hasTouch: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(90_000);

test.beforeEach(async ({ page }) => {
    await isolateSettingsSaves(page, settings => {
        settings.firstRun = false;
        settings.accountStorage = {
            ...settings.accountStorage,
            'NeconyanTutorialStatus.v1': 'skipped',
            'NeconyanSimpleMode.v1': 'off',
        };
    });
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
});

test('Mewmory keeps its tabs in one sticky row with readable headings and described switches', async ({ page }) => {
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
    const workspace = page.locator('#mewmory-workspace');
    await expect(workspace.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    // Seed only browser state; the layout does not need a model or a saved chat.
    await page.evaluate(async () => {
        const { mewmory, notifyMewmory } = await import('/scripts/mewmory/index.js');
        const records = Array.from({ length: 6 }, (_, index) => ({
            id: `layout-record-${index}`, entityId: `layout-character-${index}`, kind: 'entity',
            name: `Character ${index}`, text: 'Keeps the brass key in a coat pocket and never says why.',
            subjectIds: [], refs: [], status: 'active', significance: 'low', asOf: -1,
        }));
        const view = {
            enabled: true, locator: { chat: 'Readable layout check' }, activeNpcIds: null,
            activeReferences: { ids: records.map(record => record.entityId), records },
            entities: records, records, overviews: [], recalls: [], health: { pending: 0, totalMessages: 6 },
        };
        window.addEventListener('mewmory:updated', () => {
            if (mewmory.view === view) return;
            mewmory.view = view;
            notifyMewmory();
        });
        mewmory.view = view;
        notifyMewmory();
    });

    const toggle = workspace.getByRole('checkbox', { name: 'Use Mewmory in this chat' });
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAttribute('aria-describedby', 'mewmory-switch-hint-enabled');
    const hint = workspace.locator('#mewmory-switch-hint-enabled');
    await expect(hint).toHaveClass(/mewmory-caption/);
    await expect(hint).not.toBeEmpty();

    // The live view can redraw the panel at any moment, so pick and measure in one step.
    const showTab = id => page.evaluate(tab => document.getElementById(`mewmory-tab-${tab}`).click(), id);
    for (const width of [393, 1280]) {
        await page.setViewportSize({ width, height: width <= 393 ? 852 : 900 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        await expect(async () => {
            await showTab('now');
            const layout = await page.evaluate(() => {
                const bar = document.querySelector('#mewmory-workspace [role="tablist"]');
                const heading = document.querySelector('#mewmory-pane-now:not([hidden]) .mewmory-section h4');
                const style = getComputedStyle(bar);
                const tops = [...bar.querySelectorAll('[role="tab"]')].map(tab => Math.round(tab.getBoundingClientRect().top));
                return {
                    position: getComputedStyle(bar.parentElement).position, overflowX: style.overflowX, touchAction: style.touchAction,
                    rows: new Set(tops).size, heading: heading && getComputedStyle(heading).textTransform,
                };
            });
            expect(layout.heading, `section heading at ${width}px`).toBe('none');
            expect(layout.position, `tab wrapper at ${width}px`).toBe('sticky');
            expect(layout.rows, `tab rows at ${width}px`).toBe(1);
            if (width <= 393) {
                expect(layout.overflowX).toBe('auto');
                expect(layout.touchAction).toBe('pan-x');
            }
        }).toPass({ timeout: 10_000 });

        await expect(async () => {
            await showTab('recall');
            await expect(workspace.getByRole('tab', { name: 'Recall' })).toHaveAttribute('aria-selected', 'true');
            const [bar, selected] = await page.evaluate(() => {
                const element = document.querySelector('#mewmory-workspace [role="tablist"]');
                return [
                    element.getBoundingClientRect().toJSON(),
                    element.querySelector('[aria-selected="true"]').getBoundingClientRect().toJSON(),
                ];
            });
            expect(selected.x).toBeGreaterThanOrEqual(bar.x - 1);
            expect(selected.x + selected.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
        }).toPass({ timeout: 10_000 });
        await expect(workspace.getByRole('tab', { name: 'Recall' })).toHaveAttribute('aria-selected', 'true');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
});

test.describe('Mewmory phone scroll controls', () => {
    test.use(IPHONE_SAFARI_CONTEXT);

    test('memory updates keep the tab scroll controls painted and preserve the reading position', async ({ context, page }) => {
        await installIPhoneSafari(context, { standalone: true });
        await page.reload();
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60_000 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        const workspace = page.locator('#mewmory-workspace');
        const rail = workspace.locator('.mewmory-tabs');
        const chrome = workspace.locator('.sb-mobile-rail-chrome');
        await expect(workspace.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
        await applyIOSOnlyCss(page, { inPlace: true });
        await rail.getByRole('tab', { name: 'Recall', exact: true }).evaluate(tab => tab.click());
        await expect(workspace.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
        await expect(chrome.locator('.sb-mobile-rail-track')).toBeVisible();

        // Keep Recall selected while reading the tabs to its left. A status
        // refresh must not scroll back to the selected tab or remove the hints.
        await rail.evaluate(el => { el.scrollLeft = 0; });
        await expect(chrome.locator('.sb-mobile-rail-left')).toBeHidden();
        await expect(chrome.locator('.sb-mobile-rail-right')).toBeVisible();
        const frames = await page.evaluate(async () => {
            const { mewmory, notifyMewmory } = await import('/scripts/mewmory/index.js');
            const samples = [];
            for (const state of [
                { busy: true, loading: true, preparing: true },
                { busy: true, loading: false, preparing: false },
                { busy: true, loading: true, preparing: false },
                { busy: true, loading: false, preparing: false },
                { busy: false, loading: false, preparing: false },
            ]) {
                Object.assign(mewmory, state);
                notifyMewmory();
                // Sample the first paint after render, before the shared rails
                // can repair missing controls in a later animation frame.
                await new Promise(resolve => requestAnimationFrame(resolve));
                const rail = document.querySelector('#mewmory-workspace .mewmory-tabs');
                const controls = rail.parentElement.querySelector('.sb-mobile-rail-chrome');
                samples.push({
                    controlsVisible: Boolean(controls && !controls.hidden),
                    scrollLeft: rail.scrollLeft,
                    fade: rail.classList.contains('sb-can-scroll-right'),
                    selected: rail.querySelector('[aria-selected="true"]').id,
                    status: document.querySelector('#mewmory-workspace .mewmory-heading .mewmory-status').dataset.state,
                });
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
            return samples;
        });
        expect(frames).toEqual(Array.from({ length: 5 }, (_, index) => ({
            controlsVisible: true, scrollLeft: 0, fade: true, selected: 'mewmory-tab-recall',
            status: index === 4 ? 'off' : 'busy',
        })));

        await chrome.locator('.sb-mobile-rail-right').tap();
        await rail.getByRole('tab', { name: 'Recall', exact: true }).tap();
        await expect(rail.getByRole('tab', { name: 'Recall', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(workspace.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
        await rail.getByRole('tab', { name: 'Recall', exact: true }).press('Home');
        await expect(rail.getByRole('tab', { name: 'Now', exact: true })).toBeFocused();
        await expect(rail.getByRole('tab', { name: 'Now', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect.poll(() => rail.evaluate(el => el.scrollLeft)).toBe(0);

        const actionState = await page.evaluate(async () => {
            const { act } = await import('/scripts/mewmory/ui.js');
            let finish;
            const action = act(() => new Promise(resolve => { finish = resolve; }), { refresh: false });
            const disabledDuringAction = [...document.querySelectorAll('.mewmory-tab')].every(tab => tab.disabled);
            finish();
            await action;
            return { disabledDuringAction, enabledAfterAction: [...document.querySelectorAll('.mewmory-tab')].every(tab => !tab.disabled) };
        });
        expect(actionState).toEqual({ disabledDuringAction: true, enabledAfterAction: true });
    });

    test('shared arrows and scroll line follow sticky tabs and survive panel redraws', async ({ context, page }) => {
        await installIPhoneSafari(context, { standalone: true });
        await page.reload();
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60_000 });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
        const rail = page.locator('#mewmory-workspace .mewmory-tabs');
        await expect(rail).toBeVisible();
        await applyIOSOnlyCss(page, { inPlace: true });
        const chrome = page.locator('#mewmory-workspace .sb-mobile-rail-chrome');
        const left = chrome.locator('.sb-mobile-rail-left');
        const right = chrome.locator('.sb-mobile-rail-right');
        await expect(chrome.locator('.sb-mobile-rail-track')).toBeVisible();
        await expect(left).toBeHidden();
        await right.tap();
        await expect.poll(() => rail.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        await expect(left).toBeVisible();
        await expect(right).toBeHidden();
        await expect.poll(() => chrome.evaluate(el => parseFloat(el.style.getPropertyValue('--sb-rail-thumb-left')))).toBeGreaterThan(0);

        await rail.getByRole('tab', { name: 'Settings', exact: true }).tap();
        await expect(rail.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(chrome).toHaveCount(1);
        await expect(left).toBeVisible();

        // Measure in the scroll task itself: polling alone lets a delayed frame
        // catch up and hides the drift when the tab row enters/leaves sticky mode.
        const gaps = await rail.evaluate(el => {
            const controls = el.parentElement.querySelector('.sb-mobile-rail-chrome');
            for (let parent = el.parentElement; parent; parent = parent.parentElement) {
                if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
                    return [0, 20, 300, 500, 200, 0, 300].map(top => {
                        parent.scrollTop = top;
                        const tabs = el.getBoundingClientRect();
                        const chrome = controls.getBoundingClientRect();
                        return Math.abs(tabs.top - chrome.top) + Math.abs(tabs.width - chrome.width);
                    });
                }
            }
            throw new Error('Mewmory needs a scrollable settings page for this regression');
        });
        for (const gap of gaps) expect(gap).toBeLessThan(1);
        await expect.poll(() => chrome.evaluate(el => {
            const tabs = el.parentElement.querySelector('.mewmory-tabs').getBoundingClientRect();
            const controls = el.getBoundingClientRect();
            return Math.abs(tabs.top - controls.top) + Math.abs(tabs.width - controls.width);
        })).toBeLessThan(1);
        // Visibility alone misses controls painted beneath the sticky row.
        expect(await left.evaluate(el => {
            const box = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
        await left.tap();
        await expect.poll(() => rail.evaluate(el => el.scrollLeft)).toBe(0);
        await expect(left).toBeHidden();
        await expect(right).toBeVisible();
        await expect(page.locator('#left-nav-panel')).toBeVisible();

        await page.setViewportSize({ width: 1280, height: 900 });
        await expect(chrome).toBeHidden();
    });
});
