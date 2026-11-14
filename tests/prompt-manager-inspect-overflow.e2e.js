/* global window, document */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(180000);

const popupSelector = '#completion_prompt_manager_popup';
const listSelector = '#completion_prompt_manager_popup_entry_form_inspect_list';
const names = ['Event Tracker', 'Relationship Tracker', 'Parallel Off-Screen (Extended)',
    'Position Tracker', 'Vitals', 'World Detail', 'Omen Tracker', 'Secrets Tracker'];
const content = `<tracker>\n${'Keep the scene consistent.\n'.repeat(12)}https://example.invalid/${'longpath'.repeat(40)}\n</tracker>`;

async function measureInspection(page) {
    return page.locator(`${popupSelector}, ${listSelector}, ${listSelector} .inline-drawer, ${listSelector} .inline-drawer-header, ${listSelector} .inline-drawer-content`).evaluateAll(elements =>
        elements.filter(element => element.getClientRects().length).map(element => {
            const bounds = element.getBoundingClientRect();
            return { name: element.id || element.className, left: bounds.left, right: bounds.right,
                width: element.clientWidth, scrollWidth: element.scrollWidth };
        }));
}

for (const phone of [true, false]) {
    test(`Agents inspection stays within the screen (${phone ? 'phone' : 'desktop'})`, async ({ app, browserName }, info) => {
        const account = await app.account({ activeConnection: true, phone,
            contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {},
            configureSettings(saved) {
                saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            } });
        if (phone) await installIPhoneSafari(account.context, { standalone: false });
        const page = await account.open({ workspace: false });
        await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
        await page.getByRole('tab', { name: 'Prompts', exact: true }).click();
        await page.evaluate(async ({ names, content }) => {
            const { promptManager, ChatCompletion, Message } = await import('/scripts/openai.js');
            await promptManager.tryGenerate();
            ++promptManager.renderRequestId;
            const completion = new ChatCompletion();
            for (const [index, name] of names.entries()) {
                const message = await Message.createAsync('assistant', content, `inchat_agent_inspect_${index}`);
                message.displayName = name;
                completion.messages.add(message);
            }
            await completion.buildRuntimeAgentMessages();
            promptManager.setChatCompletion(completion);
            await promptManager.renderPromptManager();
            await promptManager.renderPromptManagerListItems();
        }, { names, content });
        if (phone) await applyIOSOnlyCss(page, { inPlace: true });
        await page.locator('#completion_prompt_manager_list').getByRole('button', { name: 'Agents', exact: true }).click();
        const popup = page.locator(popupSelector);
        const rows = page.locator(`${listSelector} .inline-drawer`);
        await expect(popup).toBeVisible();
        await expect(rows).toHaveCount(names.length);
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('#toast-container .toast')).toHaveCount(0);

        for (const expanded of [false, true]) {
            if (expanded) {
                await rows.first().locator('.inline-drawer-header').click({ position: { x: 15, y: 15 } });
                await expect(rows.first().locator('.inline-drawer-content')).toBeVisible();
                await expect(rows.first().locator('.inline-drawer-content')).toHaveText(content);
                await expect(rows.first().locator('.inline-drawer-content')).toHaveCSS('white-space', 'pre-wrap');
            }
            const state = expanded ? 'expanded' : 'collapsed';
            if (process.env.NECONYAN_INSPECT_SCREENSHOTS) {
                await page.screenshot({ path: `../screenshots/prompt-inspect-${phone ? 'phone' : 'desktop'}-${browserName}-${state}-${process.env.NECONYAN_INSPECT_SCREENSHOTS}.png` });
            }
            const measurements = await measureInspection(page);
            await info.attach(`${state}-geometry`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
            for (const bounds of measurements) {
                expect.soft(bounds.left, `${state}: ${bounds.name} left`).toBeGreaterThanOrEqual(0);
                expect.soft(bounds.right, `${state}: ${bounds.name} right`).toBeLessThanOrEqual(page.viewportSize().width + 1);
                expect.soft(bounds.scrollWidth, `${state}: ${bounds.name} overflow`).toBeLessThanOrEqual(bounds.width + 1);
            }
        }

        // An unbroken agent name must wrap too, while the disclosure icon remains reachable.
        await rows.first().locator('.inline-drawer-header > span').evaluate(element => {
            element.textContent = `Name: ${'LongAgentName'.repeat(30)}, Role: assistant, Tokens: 237`;
        });
        const longName = await measureInspection(page);
        for (const bounds of longName) {
            expect.soft(bounds.scrollWidth, `${bounds.name} with an unbroken name`).toBeLessThanOrEqual(bounds.width + 1);
        }
        await expect(rows.first().locator('.inline-drawer-icon')).toBeInViewport();

        const scrolling = phone ? popup : page.locator('.completion_prompt_manager_editor_host');
        const movement = await scrolling.evaluate(element => {
            element.scrollTo(200, 150);
            return { x: element.scrollLeft, y: element.scrollTop };
        });
        expect.soft(movement.x).toBe(0);
        expect(movement.y).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.scrollX)).toBe(0);
        await page.locator('#completion_prompt_manager_popup_close_button').click();
        await expect(popup).toBeHidden();
    });
}
