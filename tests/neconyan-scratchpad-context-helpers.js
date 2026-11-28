import { expect } from '@playwright/test';

/**
 * Opens Scratchpad's Context tab, then one of its sections: 'sharing', 'replies' or 'setup'.
 * @param {import('@playwright/test').Page} page
 * @param {'sharing'|'replies'|'setup'} [section]
 */
export async function openScratchpadContext(page, section = 'sharing') {
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await showContextSection(page, section);
}

/**
 * Switches the open Context tab to one of its sections.
 * @param {import('@playwright/test').Page} page
 * @param {'sharing'|'replies'|'setup'} section
 */
export async function showContextSection(page, section) {
    const tab = page.locator(`#scratchpad-context-tab-${section}`);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`#scratchpad-context-pane-${section}`)).toBeVisible();
}

/**
 * Opens one of the folded groups on the Context tab and returns it. Drawers that
 * are already open stay open.
 * @param {import('@playwright/test').Page} page
 * @param {'picks'|'lore'|'notes'|'tools'|'other-assistants'|'summary'|'prefills'|'web-search'|'dictation'} name
 */
export async function openContextDrawer(page, name) {
    const drawer = page.locator(`#scratchpad-panel-context details.scratchpad-drawer[data-context-drawer="${name}"]`);
    await expect(drawer).toBeVisible();
    if (!await drawer.evaluate(element => element.open)) await drawer.locator(':scope > summary').click();
    await expect(drawer).toHaveJSProperty('open', true);
    return drawer;
}

/**
 * Turns on the opt-in voice buttons beside Send from Context, Setup, Dictation
 * and voice, then returns to the Chat tab.
 * @param {import('@playwright/test').Page} page
 * @param {{ dictate?: boolean, talk?: boolean }} [buttons]
 */
export async function showVoiceButtons(page, { dictate = true, talk = true } = {}) {
    await openScratchpadContext(page, 'setup');
    const drawer = await openContextDrawer(page, 'dictation');
    const wanted = [['Show Dictate beside Send', dictate], ['Show Talk mode beside Send', talk]];
    for (const [label, on] of wanted) {
        const box = drawer.getByRole('checkbox', { name: label, exact: true });
        await box.setChecked(on);
        await expect(box).toBeChecked({ checked: on });
    }
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(page.locator('.scratchpad-compose-row .scratchpad-dictate')).toBeVisible({ visible: dictate });
    await expect(page.locator('.scratchpad-compose-row .scratchpad-talk-toggle')).toBeVisible({ visible: talk });
}
