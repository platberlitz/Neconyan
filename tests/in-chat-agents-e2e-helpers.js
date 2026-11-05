import { expect } from '@playwright/test';

/**
 * Types into the Agents search box and waits for the debounced redraw. Acting on a
 * card before that redraw can hit a row the filter is about to remove, and the blur
 * caused by the click no longer rebuilds the list under the pointer.
 */
export async function searchAgentList(page, text, { count = null, agentId = null } = {}) {
    await page.locator('#ica--search').fill(text);
    const cards = page.locator('#ica--agentList .ica--agent-card');
    if (count !== null) await expect(cards).toHaveCount(count);
    if (agentId) await expect(page.locator(`#ica--agentList .ica--agent-card[data-agent-id="${agentId}"]`)).toBeVisible();
}

/** Fills the agent library search and waits for its debounced result list. */
export async function searchAgentTemplates(page, text, { count = null, templateId = null } = {}) {
    await page.locator('.ica--template-search').fill(text);
    const cards = page.locator('.ica--template-browser .ica--template-card');
    if (count !== null) await expect(cards).toHaveCount(count);
    if (templateId) await expect(page.locator(`.ica--template-card[data-id="${templateId}"]`)).toBeVisible();
}
