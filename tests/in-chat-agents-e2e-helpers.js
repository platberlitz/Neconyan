import { expect } from '@playwright/test';

async function renderSearch(list, input, text) {
    // The search redraw is debounced. Clear first and wait for that render, then
    // wait for the render of this term: a count that already matched the previous
    // search is not proof that this fill has been drawn.
    await input.fill('');
    await expect(list).toHaveAttribute('data-rendered-search', '');
    await input.fill(text);
    await expect(list).toHaveAttribute('data-rendered-search', text);
}

/**
 * Types into the Agents search box and waits for the debounced redraw. Acting on a
 * card before that redraw can hit a row the filter is about to remove, and the blur
 * caused by the click no longer rebuilds the list under the pointer.
 */
export async function searchAgentList(page, text, { count = null, agentId = null } = {}) {
    const list = page.locator('#ica--agentList');
    await renderSearch(list, page.locator('#ica--search'), text);
    const cards = list.locator('.ica--agent-card');
    if (count !== null) await expect(cards).toHaveCount(count);
    if (agentId) await expect(list.locator(`.ica--agent-card[data-agent-id="${agentId}"]`)).toBeVisible();
}

/** Fills the agent library search and waits for its debounced result list. */
export async function searchAgentTemplates(page, text, { count = null, templateId = null } = {}) {
    const library = page.locator('.ica--template-browser');
    await renderSearch(library, page.locator('.ica--template-search'), text);
    const cards = library.locator('.ica--template-card');
    if (count !== null) await expect(cards).toHaveCount(count);
    if (templateId) await expect(library.locator(`.ica--template-card[data-id="${templateId}"]`)).toBeVisible();
}
