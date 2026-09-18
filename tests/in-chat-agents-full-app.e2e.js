/* global window, document */
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90000);

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`Complete companion interface at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width < 769, isMobile: viewport.width < 769 });
        test('notes, focus and action controls fit the live application', async ({ page }, info) => {
            page.setDefaultTimeout(15000);
            const errors = [];
            const requests = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, route => {
                requests.push(route.request().url());
                return route.fulfill({ status: 503, json: { error: 'No provider requests during interface verification.' } });
            });
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            const assistant = page.locator('[data-assistant-personality="miso"]');
            await assistant.locator('input[value="miso-male"]').check();
            await assistant.locator('[data-assistant-open]').click();
            await page.waitForFunction(() => document.querySelector('[data-assistant-picker]')?.dataset.assistantBusy !== 'true');
            const skipTour = page.getByRole('region', { name: 'Neconyan interactive tutorial' }).getByRole('button', { name: 'Skip', exact: true });
            if (await skipTour.isVisible()) await skipTour.click();
            const id = `companion-ui-${viewport.width}-${Date.now()}`;
            try {
                await page.evaluate(async id => {
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
                    const context = window.SillyTavern.getContext();
                    const agent = { ...store.createDefaultAgent(), id, name: 'Interface verification note', execution: 'companion', category: 'companion', prompt: 'Return a note.', companion: { trigger: 'manual', displayMode: 'panel' } };
                    await store.saveAgent(agent);
                    const index = context.chat.findLastIndex(message => !message.is_user && !message.is_system);
                    if (index < 0) throw new Error('No assistant reply available for the note fixture.');
                    companion.setCompanionResult(context.chat[index], agent, { status: 'done', content: '## Scene\n\nA saved note remains available.\n\n- Location: home\n- Mood: calm' });
                    await companion.emitCompanionResultsUpdated(index, id);
                    panel.openCompanionPanel();
                }, id);
                const panel = page.locator('#ica--tracker-panel');
                await expect(panel).toBeVisible();
                await expect(panel).toContainText('A saved note remains available.');
                await panel.evaluate(root => Promise.all(root.getAnimations().map(animation => animation.finished.catch(() => undefined))));
                const geometry = await panel.evaluate(root => ({
                    viewport: window.innerWidth,
                    document: document.documentElement.scrollWidth,
                    left: root.getBoundingClientRect().left,
                    right: root.getBoundingClientRect().right,
                    width: root.clientWidth,
                    scrollWidth: root.scrollWidth,
                    sections: [...root.querySelectorAll('.ica--tpanel-agent')].map(section => ({
                        left: section.getBoundingClientRect().left,
                        right: section.getBoundingClientRect().right,
                        width: window.getComputedStyle(section).width,
                        margin: window.getComputedStyle(section).margin,
                        transform: window.getComputedStyle(section).transform,
                    })),
                    actions: [...root.querySelectorAll('button[data-action]')].filter(button => button.getBoundingClientRect().width > 0).map(button => ({ label: button.getAttribute('aria-label') || button.title || button.textContent.trim(), width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
                }));
                expect(geometry.document).toBeLessThanOrEqual(viewport.width + 1);
                expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
                expect(geometry.left).toBeGreaterThanOrEqual(-1);
                expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
                expect(geometry.sections.filter(section => section.left < geometry.left - 1 || section.right > geometry.right + 1)).toEqual([]);
                expect(geometry.actions.every(action => action.label.length > 0)).toBe(true);
                if (viewport.width < 769) expect(geometry.actions.filter(action => action.width < 43.5 || action.height < 43.5)).toEqual([]);
                await page.screenshot({ path: info.outputPath('companion-panel.png') });
                await page.keyboard.press('Escape');
                await expect(panel).toBeHidden();
                expect(requests).toEqual([]);
                expect(errors).toEqual([]);
            } finally {
                await page.evaluate(async id => {
                    const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                    const companion = await import('/scripts/extensions/in-chat-agents/companion/companion-runner.js');
                    const context = window.SillyTavern.getContext();
                    for (const message of context.chat) companion.deleteCompanionResult(message, id);
                    await store.deleteAgent(id);
                }, id);
            }
        });
    });
}
