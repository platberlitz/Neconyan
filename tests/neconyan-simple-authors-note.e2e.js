/* global document, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openReadyChat } from './chat-scroll-regression-helpers.js';

test.beforeEach(async ({ page }) => {
    await isolateSettingsSaves(page, settings => {
        settings.firstRun = false;
        settings.power_user ??= {};
        settings.power_user.auto_focus_chat_input = false;
        settings.accountStorage ??= {};
        settings.accountStorage['NeconyanSimpleMode.v1'] = 'on';
        settings.accountStorage['NeconyanTutorialStatus.v1'] = 'completed';
        settings.accountStorage['NeconyanAssistantSeed.v1'] = 'done';
    });
    await openReadyChat(page);
    await expect(page.locator('html')).toHaveClass(/neconyan-simple-mode/);
});

function chatTools(page) {
    const tools = page.getByRole('button', { name: 'Chat tools', exact: true });
    const menu = page.locator('#options');
    const note = menu.getByRole('button', { name: /^Author's Note$/ });
    const panel = page.locator('#floatingPrompt');
    const close = panel.getByRole('button', { name: /^Close Author's Note$/ });
    return { tools, menu, note, panel, close };
}

async function expectEditorOpen(page) {
    const { tools, menu, panel } = chatTools(page);
    await expect(menu).toBeHidden();
    await expect(tools).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByRole('heading', { name: /^Author's Note$/ })).toBeVisible();
    for (const tab of ['This chat', 'Character', 'Persona', 'New chats']) {
        await expect(panel.getByRole('tab', { name: tab, exact: true })).toBeVisible();
    }
}

test.describe('on phone', () => {
    test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });

    test('edits an Author\'s Note from Chat tools without leaving Simple Mode', async ({ page }) => {
        const { tools, menu, note, panel, close } = chatTools(page);
        await expect(tools).toHaveAttribute('aria-expanded', 'false');
        await tools.tap();
        await expect(tools).toHaveAttribute('aria-expanded', 'true');
        await expect(note).toBeVisible();
        await expect(menu.locator('#option_toggle_CFG')).toBeHidden();
        expect((await note.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await note.tap();
        await expectEditorOpen(page);

        const editor = panel.locator('#extension_floating_prompt');
        await expect(editor).toBeEditable();
        expect(await editor.evaluate(element => {
            const box = element.getBoundingClientRect();
            return box.left >= 0 && box.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
        })).toBe(true);
        await editor.fill('Keep the scene quiet.');
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chatMetadata.note_prompt)).toBe('Keep the scene quiet.');
        await close.tap();
        await expect(panel).toBeHidden();
        await expect(page.locator('html')).toHaveClass(/neconyan-simple-mode/);
    });
});

test.describe('on desktop', () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test('opens and closes Author\'s Note in Simple Mode by keyboard', async ({ page }) => {
        const { tools, menu, note, panel, close } = chatTools(page);
        await tools.press('Space');
        await expect(tools).toHaveAttribute('aria-expanded', 'true');
        await expect(note).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(tools).toBeFocused();

        await page.keyboard.press('Enter');
        await expect(note).toBeFocused();
        await page.keyboard.press('Space');
        await expectEditorOpen(page);
        await expect(panel.getByRole('tab', { name: 'This chat', exact: true })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(close).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(panel.getByRole('button', { name: 'Expand panel', exact: true })).toBeFocused();
        await page.keyboard.press('Space');
        await expect(panel).toHaveClass(/\bmaximized\b/);
        await page.keyboard.press('Enter');
        await expect(panel).not.toHaveClass(/\bmaximized\b/);
        await page.keyboard.press('Tab');
        await expect(close).toBeFocused();
        await page.keyboard.press('Space');
        await expect(panel).toBeHidden();
        await expect(tools).toBeFocused();
        await expect(page.locator('html')).toHaveClass(/neconyan-simple-mode/);
    });
});
