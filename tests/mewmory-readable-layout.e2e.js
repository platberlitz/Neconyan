// @ts-check
/* global document, window, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Phone and desktop widths use different tab layouts. */
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { test, expect } from '@playwright/test';

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
                    position: style.position, overflowX: style.overflowX, touchAction: style.touchAction,
                    rows: new Set(tops).size, heading: heading && getComputedStyle(heading).textTransform,
                };
            });
            expect(layout.heading, `section heading at ${width}px`).toBe('none');
            expect(layout.position, `tab bar at ${width}px`).toBe('sticky');
            expect(layout.rows, `tab rows at ${width}px`).toBe(1);
            if (width <= 393) {
                expect(layout.overflowX).toBe('auto');
                expect(layout.touchAction).toBe('pan-x');
            }
        }).toPass({ timeout: 10_000 });

        await expect(async () => {
            await showTab('recall');
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
