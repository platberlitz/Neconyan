/* global window, document */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
    copiesForTemplate,
    getAgentRequestCost,
    isAutomaticRequestCost,
} from '../public/scripts/extensions/in-chat-agents/agent-recommendations.js';
import { isolateSettingsSaves, trackNavigationErrors } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block' });
test.setTimeout(180000);
test.describe.configure({ mode: 'serial' });

const openOnManage = settings => {
    delete settings.accountStorage?.['ica--workspace-view'];
    const agents = settings.extension_settings?.inChatAgents ?? {};
    settings.extension_settings ??= {};
    settings.extension_settings.inChatAgents = {
        ...agents,
        globalSettings: {
            ...(agents.globalSettings ?? {}),
            enabled: true,
            separateRecentChats: false,
            scopedEnabledAgentIdsInitialized: false,
            enabledAgentIdsByChatType: {},
        },
    };
};

test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(15000);
    await isolateSettingsSaves(page, openOnManage);
    await page.route('**/api/server-admin/**', route => route.fulfill({ status: 403, json: { error: 'Administration is disabled during agent UI checks.' } }));
    await page.route(/\/api\/.*\/generate-quiet(?:\?|$)/, route => route.fulfill({ status: 503, json: { error: 'Generation is disabled during agent UI checks.' } }));
});

async function openAgents(page, navigate = action => action()) {
    await navigate(() => page.goto('/', { waitUntil: 'domcontentloaded' }));
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 45000 });
    await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
    await expect(page.locator('#ica--run-status')).not.toHaveText('Ready', { timeout: 45000 });
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
    await expect(page.locator('#ica--settings')).toBeVisible({ timeout: 45000 });
    const skipTour = page.getByRole('region', { name: 'Neconyan interactive tutorial' }).getByRole('button', { name: 'Skip', exact: true });
    if (await skipTour.isVisible()) await skipTour.click();
}

async function headers(page) {
    return page.evaluate(() => window.SillyTavern.getContext().getRequestHeaders());
}

async function settingsAgents(page) {
    const response = await page.request.post('/api/settings/get', { headers: await headers(page), data: { sections: ['agents'] } });
    expect(response.ok()).toBe(true);
    return (await response.json()).inChatAgents;
}

const targetTemplateIds = ['tpl-repeat-spotter', 'tpl-position-tracker-companion'];
const templateById = new Map(JSON.parse(readFileSync(
    new URL('../public/scripts/extensions/in-chat-agents/templates/index.json', import.meta.url),
    'utf8',
)).map(template => [template.id, template]));

async function prepareDeterministicAgents(page, requestHeaders, originalAgents) {
    const targetCopies = [];
    const seededIds = [];
    for (const templateId of targetTemplateIds) {
        const template = templateById.get(templateId);
        expect(template).toBeTruthy();
        let copies = copiesForTemplate(originalAgents, template);
        if (!copies.length) {
            const seeded = {
                ...structuredClone(template),
                id: `taro-guide-seed-${templateId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                sourceTemplateId: template.id,
                enabled: false,
            };
            expect((await page.request.post('/api/in-chat-agents/save', { headers: requestHeaders, data: seeded })).ok()).toBe(true);
            seededIds.push(seeded.id);
            copies = [seeded];
        }
        targetCopies.push(...copies);
    }

    const toDisable = new Map(
        [
            ...originalAgents.filter(agent => agent.enabled && isAutomaticRequestCost(getAgentRequestCost(agent))),
            ...targetCopies.filter(agent => agent.enabled),
        ].map(agent => [agent.id, agent]),
    );
    for (const agent of toDisable.values()) {
        expect((await page.request.post('/api/in-chat-agents/save', {
            headers: requestHeaders,
            data: { ...agent, enabled: false },
        })).ok()).toBe(true);
    }
    return { seededIds };
}

for (const width of [1280, 393]) {
    test.describe(`Taro's agent guide at ${width}px`, () => {
        test.use({ viewport: { width, height: width === 393 ? 852 : 900 }, isMobile: width === 393, hasTouch: width === 393 });

        test('asks, explains, switches on only the checked agents and undoes them', async ({ page }, info) => {
            const { errors: pageErrors, navigate } = trackNavigationErrors(page);
            await openAgents(page, navigate);
            const requestHeaders = await headers(page);
            const originalAgents = await settingsAgents(page);
            const originalIds = new Set(originalAgents.map(agent => agent.id));
            const masterWasPressed = await page.locator('#ica--globalEnabled').getAttribute('aria-pressed') === 'true';
            let seededIds = [];

            try {
                ({ seededIds } = await prepareDeterministicAgents(page, requestHeaders, originalAgents));
                await openAgents(page, navigate);

                const toolbar = page.locator('#ica--settings .ica--toolbar-actions');
                const create = toolbar.locator('#ica--addAgent');
                const browse = toolbar.locator('#ica--templates');
                const help = toolbar.locator('#ica--askTaro');
                const guide = page.locator('#ica--taroGuide');
                const master = page.locator('#ica--globalEnabled');
                if (width === 393) {
                    const [createBox, browseBox, helpBox] = await Promise.all([create, browse, help].map(locator => locator.boundingBox()));
                    expect(Math.abs(createBox.width - browseBox.width)).toBeLessThan(3);
                    expect(Math.abs(browseBox.width - helpBox.width)).toBeLessThan(3);
                    expect(helpBox.y).toBeGreaterThanOrEqual(browseBox.y + browseBox.height);
                    expect(helpBox.height).toBeGreaterThanOrEqual(44);
                    expect(await browse.locator('span').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
                }

                await help.click();
                await expect(guide).toBeVisible();
                await expect(guide.locator('legend')).toHaveText('What are you playing?');
                await page.keyboard.press('Escape');
                await expect(guide).toBeHidden();
                await expect(help).toBeFocused();

                await help.click();
                await expect(guide).toBeVisible();
                const geometry = await guide.evaluate(element => ({
                    scrollWidth: element.scrollWidth,
                    clientWidth: element.clientWidth,
                    position: window.getComputedStyle(element).position,
                    viewport: document.documentElement.clientWidth,
                    box: element.getBoundingClientRect().toJSON(),
                }));
                expect(geometry.position).not.toBe('fixed');
                expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
                expect(geometry.box.right).toBeLessThanOrEqual(geometry.viewport + 1);

                await guide.locator('#ica--taro-guide-style-roleplay').check();
                await guide.getByRole('button', { name: 'Next', exact: true }).click();
                await expect(guide.locator('legend')).toHaveText('What should the reply do better?');
                await guide.locator('#ica--taro-guide-fixes-repeat').check();
                await guide.getByRole('button', { name: 'Next', exact: true }).click();
                await expect(guide.locator('legend')).toHaveText('Anything to keep track of?');
                await guide.locator('#ica--taro-guide-extras-map').check();
                await guide.getByRole('button', { name: 'Next', exact: true }).click();
                await expect(guide.locator('legend')).toHaveText('How many extra requests?');
                await guide.locator('#ica--taro-guide-budget-light').check();
                await guide.getByRole('button', { name: 'Show my agents', exact: true }).click();

                await expect(guide.locator('.ica--taro-guide-results-title')).toHaveText('Your agents');
                await expect(guide.locator('.ica--taro-guide-scope')).toContainText('Switches apply to');
                const repeatRow = guide.locator('.ica--taro-guide-row').filter({ hasText: 'Repeat Spotter' });
                const positionRow = guide.locator('.ica--taro-guide-row').filter({ hasText: 'Position Tracker' });
                await expect(repeatRow).toContainText('You asked for less repetition.');
                await expect(repeatRow).toContainText('One extra request before the reply');
                await expect(positionRow).toContainText('You asked for a map of who is where.');
                await expect(positionRow).toContainText('One extra request after the reply');
                await expect(guide.locator('.ica--taro-guide-notes')).toContainText('Roleplay needs no extra agent');
                await expect(guide.locator('.ica--taro-guide-primary')).toHaveText('Switch on 2 agents');
                const repeatToggle = guide.locator('#ica--taro-guide-pick-tpl-repeat-spotter');
                await repeatToggle.focus();
                await repeatToggle.press('Space');
                await expect(repeatToggle).toBeFocused();
                await expect(guide.locator('.ica--taro-guide-primary')).toHaveText('Switch on 1 agent');
                await repeatToggle.press('Space');
                await expect(guide.locator('.ica--taro-guide-primary')).toHaveText('Switch on 2 agents');

                const beforeApply = await settingsAgents(page);
                for (const id of targetTemplateIds) {
                    const copies = beforeApply.filter(agent => agent.sourceTemplateId === id);
                    expect(copies.length).toBeGreaterThan(0);
                    expect(copies.every(agent => !agent.enabled)).toBe(true);
                }

                if (await master.getAttribute('aria-pressed') === 'true') await master.click();
                await expect(guide.locator('.ica--taro-guide-paused')).toBeVisible();
                await master.click();
                await expect(guide.locator('.ica--taro-guide-paused')).toHaveCount(0);

                await guide.locator('.ica--taro-guide-primary').click();
                await expect(page.locator('.ica--taro-guide-applied')).toContainText('Switched on 2 agents.');
                await expect(page.locator('.ica--taro-guide-status')).toContainText('Switched on 2 agents.');
                for (const name of ['Repeat Spotter', 'Position Tracker']) {
                    const cards = page.locator('#ica--agentList .ica--agent-card').filter({ hasText: name });
                    await expect(cards.locator('.ica--card-toggle[aria-pressed="true"]')).toHaveCount(1);
                }
                const afterApply = await settingsAgents(page);
                for (const id of targetTemplateIds) {
                    expect(afterApply.some(agent => agent.sourceTemplateId === id && agent.enabled)).toBe(true);
                }
                await capture(page, info, `taro-guide-applied-${width}`);

                await guide.locator('.ica--taro-guide-close').click();
                await expect(guide).toBeHidden();
                await help.click();
                await expect(guide).toBeVisible();
                await expect(guide.locator('.ica--taro-guide-applied')).toContainText('Switched on 2 agents.');
                await expect(guide.locator('#ica--taro-guide-undo')).toBeEnabled();
                await capture(page, info, `taro-guide-reopened-${width}`);
                await guide.locator('#ica--taro-guide-undo').click();
                await expect(page.locator('.ica--taro-guide-status')).toContainText('Switched off 2 agents.');
                for (const name of ['Repeat Spotter', 'Position Tracker']) {
                    const cards = page.locator('#ica--agentList .ica--agent-card').filter({ hasText: name });
                    await expect(cards.locator('.ica--card-toggle[aria-pressed="true"]')).toHaveCount(0);
                }
                const afterUndo = await settingsAgents(page);
                for (const id of targetTemplateIds) {
                    const copies = afterUndo.filter(agent => agent.sourceTemplateId === id);
                    expect(copies.length).toBeGreaterThan(0);
                    expect(copies.every(agent => !agent.enabled)).toBe(true);
                }

                await guide.locator('.ica--taro-guide-close').click();
                await expect(guide).toBeHidden();
                await expect(help).toBeFocused();
                expect(pageErrors).toEqual([]);
            } finally {
                const master = page.locator('#ica--globalEnabled');
                if (await master.count()) {
                    const pressed = await master.getAttribute('aria-pressed') === 'true';
                    if (pressed !== masterWasPressed) await master.click();
                }
                for (const agent of originalAgents) {
                    await page.request.post('/api/in-chat-agents/save', { headers: requestHeaders, data: agent });
                }
                const current = await settingsAgents(page);
                for (const agent of current) {
                    const createdByGuide = targetTemplateIds.includes(agent.sourceTemplateId) && !originalIds.has(agent.id);
                    if (seededIds.includes(agent.id) || createdByGuide) {
                        await page.request.post('/api/in-chat-agents/delete', { headers: requestHeaders, data: { id: agent.id } });
                    }
                }
            }
        });
    });
}

async function capture(page, info, name) {
    await page.evaluate(() => window.toastr?.remove());
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
}
