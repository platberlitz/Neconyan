/* global window, renderPanel, refreshCompanionPanel */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const panelSource = read('../public/scripts/extensions/in-chat-agents/companion/companion-panel.js');
const panelDeclarations = parse(panelSource, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(node => node.declaration ?? node)
    .filter(node => node.type !== 'ImportDeclaration' && (node.type === 'VariableDeclaration'
        || ['renderPanel', 'applyPanelReorder', 'setupPanelSortable', 'refreshCompanionPanel'].includes(node.id?.name)))
    .map(node => panelSource.slice(node.start, node.end)).join('\n');

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`companion panel reorder at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width === 393 });

        test.beforeEach(async ({ page }) => {
            await page.setContent('<aside id="ica--tracker-panel" class="ica--tpanel is-open" data-edge="right"></aside>');
            await page.addStyleTag({ content: read('../public/scripts/extensions/in-chat-agents/style.css') });
            await page.addStyleTag({ content: '#ica--tracker-panel { --mainFontSize: 15px; box-sizing: border-box; } .test-content { height: 120px; }' });
            await page.addScriptTag({ content: read('../public/lib/jquery-3.5.1.min.js') });
            await page.addScriptTag({ content: read('../public/lib/jquery-ui.min.js') });
            await page.addScriptTag({ content: read('../public/lib/jquery.ui.touch-punch.min.js') });
            await page.evaluate(async source => {
                const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                Object.assign(window, await import(url));
                URL.revokeObjectURL(url);
                window.getStoredPanelLocked = () => false;
                window.getStoredHandleHidden = () => false;
                window.getStoredPanelLauncher = () => 'handle';
                window.captureVisibleMessageAnchor = () => null;
                window.restoreVisibleMessageAnchor = () => {};
                window.captureMessageTargetState = () => ({});
                window.isMessageTargetCurrent = () => true;
                window.toastr = { error: message => { window.saveError = message; } };
                window.escapeHtml = value => String(value);
                window.savedOrder = ['a', 'b', 'c'];
                window.saveCalls = [];
                window.reorderAgentsIntoOrderSlots = async ids => {
                    window.saveCalls.push(ids);
                    await new Promise(resolve => { window.finishSave = resolve; });
                    if (window.rejectSave) throw new Error('Could not save order');
                    window.savedOrder = ids;
                    return true;
                };
                window.buildPanelHtml = () => `<div class="ica--tpanel-body">${window.savedOrder.map(id => `
                    <section class="ica--tpanel-agent" data-agent-id="${id}">
                        <button class="ica--cdash-action ica--tpanel-drag-handle" aria-label="Move ${id}">Move ${id}</button>
                        <div class="test-content">${window.resultText ?? 'Saved result'}</div>
                    </section>`).join('')}</div>`;
            }, read('../public/scripts/extensions/in-chat-agents/companion/view-state.js'));
            await page.addScriptTag({ content: `${panelDeclarations}\npanelOpen = true; renderPanel();` });
        });

        async function startDrag(page, from = 'a', to = 'b') {
            const grip = page.getByRole('button', { name: `Move ${from}` });
            expect(await grip.evaluate(node => window.getComputedStyle(node).touchAction)).toBe('none');
            const handle = await grip.boundingBox();
            const next = await page.locator(`[data-agent-id="${to}"]`).boundingBox();
            const x = handle.x + handle.width / 2;
            const y = handle.y + handle.height / 2;
            const targetY = next.y + next.height / 2;
            let release;
            if (viewport.width === 393) {
                const cdp = await page.context().newCDPSession(page);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
                for (let step = 1; step <= 12; step++) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (targetY - y) * step / 12 }] });
                }
                release = async () => {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    await cdp.detach();
                };
            } else {
                await page.mouse.move(x, y);
                await page.mouse.down();
                await page.mouse.move(x, targetY, { steps: 12 });
                release = () => page.mouse.up();
            }
            await expect(page.locator('.ui-sortable-helper')).toHaveCount(1);
            return release;
        }

        test('keeps the dropped order after saving and rendering again', async ({ page }) => {
            const release = await startDrag(page);
            await release();
            await expect.poll(() => page.evaluate(() => window.saveCalls)).toEqual([['b', 'a', 'c']]);
            await page.evaluate(() => window.finishSave());
            await expect.poll(() => page.evaluate(() => window.savedOrder)).toEqual(['b', 'a', 'c']);
            await page.evaluate(() => renderPanel());
            expect(await page.locator('.ica--tpanel-agent').evaluateAll(nodes => nodes.map(node => node.dataset.agentId))).toEqual(['b', 'a', 'c']);
        });

        test('defers result refreshes during a drag and its pending save', async ({ page }) => {
            const release = await startDrag(page);
            await page.evaluate(() => {
                window.resultText = 'New result';
                refreshCompanionPanel();
            });
            await expect(page.locator('.ui-sortable-helper')).toHaveCount(1);
            await release();
            await expect.poll(() => page.evaluate(() => window.saveCalls)).toEqual([['b', 'a', 'c']]);
            await page.evaluate(() => refreshCompanionPanel());
            expect(await page.locator('.ica--tpanel-agent').evaluateAll(nodes => nodes.map(node => node.dataset.agentId))).toEqual(['b', 'a', 'c']);
            await page.evaluate(() => window.finishSave());
            await expect(page.locator('.test-content').first()).toHaveText('New result');
            expect(await page.locator('.ica--tpanel-agent').evaluateAll(nodes => nodes.map(node => node.dataset.agentId))).toEqual(['b', 'a', 'c']);
        });

        test('serialises repeated drops without restoring the earlier order', async ({ page }) => {
            const releaseFirst = await startDrag(page);
            await releaseFirst();
            await expect.poll(() => page.evaluate(() => window.saveCalls.length)).toBe(1);
            const releaseSecond = await startDrag(page, 'b', 'a');
            await releaseSecond();
            expect(await page.evaluate(() => window.saveCalls.length)).toBe(1);
            await page.evaluate(() => window.finishSave());
            await expect.poll(() => page.evaluate(() => window.saveCalls)).toEqual([['b', 'a', 'c'], ['a', 'b', 'c']]);
            expect(await page.locator('.ica--tpanel-agent').evaluateAll(nodes => nodes.map(node => node.dataset.agentId))).toEqual(['a', 'b', 'c']);
            await page.evaluate(() => window.finishSave());
            await expect.poll(() => page.evaluate(() => window.savedOrder)).toEqual(['a', 'b', 'c']);
        });

        test('reports a failed save and allows another drag', async ({ page }) => {
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.evaluate(() => { window.rejectSave = true; });
            const release = await startDrag(page);
            await release();
            await expect.poll(() => page.evaluate(() => window.saveCalls.length)).toBe(1);
            await page.evaluate(() => window.finishSave());
            await expect.poll(() => page.evaluate(() => window.saveError)).toContain('Could not save');
            expect(await page.locator('.ica--tpanel-agent').evaluateAll(nodes => nodes.map(node => node.dataset.agentId))).toEqual(['a', 'b', 'c']);
            await page.evaluate(() => { window.rejectSave = false; });
            const releaseRetry = await startDrag(page);
            await releaseRetry();
            await expect.poll(() => page.evaluate(() => window.saveCalls.length)).toBe(2);
            await page.evaluate(() => window.finishSave());
            await expect.poll(() => page.evaluate(() => window.savedOrder)).toEqual(['b', 'a', 'c']);
            expect(errors).toEqual([]);
        });
    });
}
