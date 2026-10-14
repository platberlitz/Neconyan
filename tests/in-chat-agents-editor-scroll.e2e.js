/* global window, document, getComputedStyle */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const templates = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/index.json', import.meta.url), 'utf8'));
const families = [
    { key: 'scene', templateId: 'tpl-scene-tracker', lower: '#ica--tracker-builder-style' },
    { key: 'knowledge', templateId: 'tpl-knowledge-guard', lower: '#ica--editor-prompt' },
    { key: 'companion', templateId: 'tpl-directors-commentary-companion', lower: '#ica--editor-prompt' },
];

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(180000);

async function openWorkspace(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'), null, { timeout: 45000 });
    await page.locator('#neconyan-home-skeleton').waitFor({ state: 'hidden' });
    const skip = page.getByRole('region', { name: 'Neconyan interactive tutorial' }).getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible()) await skip.click();
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
    const legacyImages = page.locator('dialog[open]').filter({ hasText: 'Quick Image Gen found legacy browser-only settings' });
    if (await legacyImages.isVisible()) await legacyImages.locator('.popup-button-cancel').click();
    await page.locator('#ica--settings').getByRole('tab', { name: 'All', exact: true }).click();
}

async function storedAgents(page) {
    return page.evaluate(async () => {
        const response = await fetch('/api/in-chat-agents/list', { method: 'POST', headers: window.SillyTavern.getContext().getRequestHeaders() });
        if (!response.ok) throw new Error(`Agent list failed: ${response.status}`);
        return response.json();
    });
}

async function wheel(page, content, delta) {
    const box = await content.boundingBox();
    const point = { x: box.x + 3, y: box.y + Math.min(150, box.height / 2) };
    expect(await content.evaluate((element, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return element.contains(hit) && !hit.closest('textarea, input, select');
    }, point)).toBe(true);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, delta);
}

async function assertFooter(popup, viewport) {
    for (const selector of ['.popup-button-ok', '.popup-button-cancel']) {
        const box = await popup.locator(selector).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
}

async function assertReached(popup, target) {
    // Read geometry before a click/fill/check can scroll the field into view.
    expect(await target.evaluate(element => {
        if (!element.getClientRects().length || element.closest('[hidden]')) return false;
        const closed = element.closest('details:not([open])');
        return !closed || closed.querySelector('summary')?.contains(element);
    })).toBe(true);
    const clip = await popup.locator('.popup-content').boundingBox();
    const box = await target.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(clip.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(clip.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(clip.x + clip.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(clip.y + clip.height + 1);
}

async function reachLower(page, popup, target, viewport, info, label) {
    const content = popup.locator('.popup-content');
    await wheel(page, content, -10000);
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBe(0);
    const before = await content.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
    if (before.total > before.height) {
        await wheel(page, content, 10000);
        await expect.poll(() => content.evaluate(element => element.scrollTop), { message: 'Outer editor content must move after real wheel input' }).toBeGreaterThan(before.top);
    }
    await assertReached(popup, target);
    await assertFooter(popup, viewport);
    await info.attach(label, { body: JSON.stringify({ before, after: await content.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight })), target: await target.boundingBox(), clip: await content.boundingBox() }), contentType: 'application/json' });
}

async function changeTab(page, popup, tab, phone) {
    if (phone) {
        await wheel(page, popup.locator('.popup-content'), -10000);
        await expect.poll(() => popup.locator('.popup-content').evaluate(element => element.scrollTop)).toBe(0);
    }
    await popup.locator(`[data-editor-tab="${tab}"]`).click();
    await expect(popup.locator(`[data-editor-tab="${tab}"]`)).toHaveAttribute('aria-selected', 'true');
}

async function openAgent(page, id) {
    await page.locator(`#ica--agentList [data-agent-id="${id}"] .ica--btn-edit`).click();
    const popup = page.locator('dialog[open]:has(#ica--editor)');
    await expect(popup).toBeVisible();
    return popup;
}

async function exerciseEditor({ browser, baseURL }, info, size, viewport) {
    const phone = size === 'phone';
    const context = await browser.newContext({ baseURL, viewport, hasTouch: phone, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const prefix = `editor-scroll-${size}-${Date.now()}`;
    try {
        await page.route('**/api/settings/save', route => route.fulfill({ json: { result: 'ok', version: Date.now(), settingsRevision: Date.now() } }));
        await page.route('**/api/settings/get', async route => {
            const response = await route.fetch();
            const envelope = await response.json();
            if (typeof envelope.settings !== 'string') return route.fulfill({ response, json: envelope });
            const settings = JSON.parse(envelope.settings);
            settings.firstRun = false;
            settings.language = 'en';
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
            delete settings.accountStorage['ica--workspace-view'];
            await route.fulfill({ response, json: { ...envelope, settings: JSON.stringify(settings) } });
        });
        await openWorkspace(page);
        await page.evaluate(async ({ families, templates, prefix }) => {
            const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
            for (const family of families) {
                const template = templates.find(agent => agent.id === family.templateId);
                await store.saveAgent(store.normalizeAgent({ ...store.createDefaultAgent(), ...template, id: `${prefix}-${family.key}`, sourceTemplateId: template.id, phaseLocked: true, enabled: false }));
            }
        }, { families, templates: templates.filter(agent => families.some(family => family.templateId === agent.id)), prefix });
        await openWorkspace(page);

        for (const family of size === 'short-desktop' ? families.filter(family => family.key === 'knowledge') : families) {
            const id = `${prefix}-${family.key}`;
            const original = (await storedAgents(page)).find(agent => agent.id === id);
            let popup = await openAgent(page, id);
            await reachLower(page, popup, popup.locator(family.lower), viewport, info, `${family.key}-instructions`);
            await changeTab(page, popup, 'when', phone);
            const quiet = popup.locator('#ica--editor-type-quiet');
            await reachLower(page, popup, quiet, viewport, info, `${family.key}-quiet`);
            const checked = await quiet.isChecked();
            await quiet.setChecked(!checked);
            await popup.locator('.popup-button-ok').click();
            await expect(popup).toHaveCount(0);
            const saved = (await storedAgents(page)).find(agent => agent.id === id);
            const expectedTypes = checked ? original.conditions.generationTypes.filter(type => type !== 'quiet') : [...original.conditions.generationTypes, 'quiet'];
            expect(saved.conditions.generationTypes).toEqual(expectedTypes);

            await openWorkspace(page);
            popup = await openAgent(page, id);
            await changeTab(page, popup, 'when', phone);
            await reachLower(page, popup, popup.locator('#ica--editor-type-quiet'), viewport, info, `${family.key}-reloaded-quiet`);
            await expect(popup.locator('#ica--editor-type-quiet')).toBeChecked({ checked: !checked });
            await popup.locator('#ica--editor-type-quiet').setChecked(checked);
            await popup.locator('.popup-button-cancel').click();
            const discard = page.locator('dialog[open]').filter({ hasText: 'Discard changes?' });
            await expect(discard).toBeVisible();
            await discard.locator('.popup-button-ok').click();
            await expect(popup).toHaveCount(0);
            expect((await storedAgents(page)).find(agent => agent.id === id)).toEqual(saved);

            if (family.key === 'companion') {
                popup = await openAgent(page, id);
                await changeTab(page, popup, 'companion', phone);
                const connections = popup.getByText('Connections to other companions', { exact: true });
                await reachLower(page, popup, connections, viewport, info, 'companion-connections');
                await connections.click();
                await reachLower(page, popup, popup.locator('#ica--editor-companion-waitForDependencies'), viewport, info, 'companion-expanded-dependencies');
                await changeTab(page, popup, 'instructions', phone);
                await expect(popup.locator('#ica--editor-connectionProfile')).toBeVisible();
                await assertFooter(popup, viewport);
                await popup.locator('.popup-button-cancel').click();
                await expect(popup).toHaveCount(0);
            }
            if (family.key === 'knowledge' && size === 'short-desktop') {
                popup = await openAgent(page, id);
                await changeTab(page, popup, 'reply', phone);
                const output = popup.getByText('Save or add text without the AI', { exact: true });
                await reachLower(page, popup, output, viewport, info, 'knowledge-output-processing');
                await output.click();
                await reachLower(page, popup, popup.locator('#ica--editor-pp-enabled'), viewport, info, 'knowledge-expanded-output-processing');
                await changeTab(page, popup, 'instructions', phone);
                await popup.locator('.popup-button-cancel').click();
                await expect(popup).toHaveCount(0);
            }
        }

        if (size !== 'short-desktop') {
            const beforeCreate = (await storedAgents(page)).map(agent => agent.id).sort();
            await page.locator('#ica--addAgent').click();
            let popup = page.locator('dialog[open]:has(#ica--editor)');
            await assertFooter(popup, viewport);
            await popup.locator('.popup-button-cancel').click();
            await expect(popup).toHaveCount(0);
            expect((await storedAgents(page)).map(agent => agent.id).sort()).toEqual(beforeCreate);

            await page.locator('#ica--addAgent').click();
            popup = page.locator('dialog[open]:has(#ica--editor)');
            await popup.locator('#ica--editor-name').fill(prefix);
            await reachLower(page, popup, popup.locator('#ica--editor-prompt'), viewport, info, 'new-agent-instructions');
            const prompt = 'Return one short observation about the current scene.';
            await popup.locator('#ica--editor-prompt').fill(prompt);
            await popup.locator('.popup-button-ok').click();
            await expect(popup).toHaveCount(0);
            const created = (await storedAgents(page)).find(agent => agent.name === prefix);
            expect(created.prompt).toBe(prompt);
            expect(beforeCreate).not.toContain(created.id);
            await openWorkspace(page);
            popup = await openAgent(page, created.id);
            await reachLower(page, popup, popup.locator('#ica--editor-prompt'), viewport, info, 'new-agent-reloaded-instructions');
            await expect(popup.locator('#ica--editor-prompt')).toHaveValue(prompt);
            await popup.locator('.popup-button-cancel').click();
            await expect(popup).toHaveCount(0);
        }
    } finally {
        if (!page.isClosed() && await page.evaluate(() => Boolean(window.SillyTavern?.getContext))) {
            const owned = (await storedAgents(page)).filter(agent => agent.id.startsWith(prefix) || agent.name === prefix).map(agent => agent.id);
            await page.evaluate(async ids => {
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                for (const id of ids) await store.deleteAgent(id);
            }, owned);
        }
        if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
    }
}

for (const { size, viewport } of [
    { size: 'desktop', viewport: { width: 1280, height: 900 } },
    { size: 'phone', viewport: { width: 393, height: 852 } },
    { size: 'short-desktop', viewport: { width: 1280, height: 600 } },
]) {
    // eslint-disable-next-line playwright/expect-expect -- The shared viewport runner contains the browser assertions.
    test(`Agent editor lower fields scroll, persist and cancel on ${size}`, async ({ browser, baseURL }, info) => {
        await exerciseEditor({ browser, baseURL }, info, size, viewport);
    });
}
