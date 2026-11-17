// @ts-check
/* global document */
/* eslint-disable playwright/no-conditional-in-test -- Screenshots are opt-in. */
import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { isolateSettingsSaves } from './chat-scroll-regression-helpers.js';
import { PLUGIN_ID, PROTOCOL_VERSION } from '../public/scripts/extensions/third-party/Neconyan-BotSearcher/shared/schema.js';
import { janitorai } from '../public/scripts/extensions/third-party/Neconyan-BotSearcher/server/sources/janitorai.js';

const pluginBase = `/api/plugins/${PLUGIN_ID}`;
const clientBase = '/scripts/extensions/third-party/Neconyan-BotSearcher/client';
const searchCapabilities = { search: true, query: true, urlImport: true, sorts: ['latest'], filters: [], paging: 'cursor' };
const sources = [
    { id: 'chub', label: 'Chub', tier: 1, state: 'up', clientHosts: ['chub.ai'], capabilities: searchCapabilities },
    { id: 'jannyai', label: 'JannyAI', tier: 2, state: 'up', clientHosts: ['jannyai.com', 'janitorai.com'], capabilities: { ...searchCapabilities, browserImport: true } },
    {
        id: janitorai.id,
        label: janitorai.label,
        tier: janitorai.tier,
        state: 'up',
        clientHosts: [...janitorai.allowedHosts, ...janitorai.linkHosts],
        capabilities: { ...janitorai.capabilities },
    },
];

const frontpage = Array.from({ length: 6 }, (_, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    name: `Trending character ${index + 1}`,
    creator_name: `creator${index + 1}`,
    description: '<p>A short introduction.</p>',
    avatar: `avatar-${index}.webp`,
    is_nsfw: false,
    tags: [{ name: '🧝 Fantasy' }],
    custom_tags: [],
    stats: { chat: 1200 * (index + 1) },
    total_tokens: 900 + index,
    created_at: '2026-11-16T10:00:00Z',
}));

async function janitorItems(body) {
    const sections = [];
    const result = await janitorai.search({
        frontpage: async (section, mode) => {
            sections.push({ section, mode });
            return { data: frontpage };
        },
    }, { cursor: null, limit: body.limit, sort: body.sort, sfwOnly: body.filters?.sfwOnly === true });
    return { result, sections };
}

async function openBrowser(page) {
    const searches = [];
    await page.route(`**${pluginBase}/healthz`, route => route.fulfill({ json: {
        protocol: PROTOCOL_VERSION,
        sources,
        capabilities: { jannyBrowser: { available: true } },
    } }));
    await page.route(`**${pluginBase}/search`, async route => {
        const body = route.request().postDataJSON();
        if (body.source !== 'janitorai') {
            searches.push({ body });
            return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
        }
        const { result, sections } = await janitorItems(body);
        searches.push({ body, sections });
        return route.fulfill({ json: { items: result.items, nextCursor: null, total: null } });
    });
    await page.route(`**${pluginBase}/thumb**`, route => route.fulfill({ status: 404, body: '' }));
    await page.route(`**${pluginBase}/janny/**`, route => route.fulfill({ json: { available: true, ready: true, loggedIn: true } }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async ({ path }) => {
        const { updateSettings } = await import(`${path}/settings.js`);
        updateSettings({ defaultSource: 'chub', enabledSources: ['chub', 'jannyai', 'janitorai'] });
        const { openBrowser } = await import(`${path}/browser.js`);
        void openBrowser();
    }, { path: clientBase });
    await expect(page.locator('#sbbs_query')).toBeVisible();
    await expect(page.locator('.popup:has(#sbbs_query)')).not.toHaveAttribute('opening');
    return searches;
}

for (const [name, options] of [
    ['phone', { viewport: { width: 393, height: 852 }, hasTouch: true }],
    ['desktop', { viewport: { width: 1280, height: 900 }, hasTouch: true }],
]) {
    test.describe(`${name}`, () => {
        test.use({ ...options, serviceWorkers: 'block', reducedMotion: 'reduce' });
        test.setTimeout(240_000);

        test.beforeEach(async ({ page }) => {
            await isolateSettingsSaves(page, settings => {
                settings.firstRun = false;
                settings.accountStorage = {
                    ...settings.accountStorage,
                    'NeconyanTutorialStatus.v1': 'skipped',
                    'NeconyanSimpleMode.v1': 'off',
                };
            });
        });

        test('JanitorAI lists its trending cards and keeps out of text search', async ({ page }) => {
            const searches = await openBrowser(page);
            const picker = page.locator('#sbbs_source');
            const query = page.locator('#sbbs_query');
            const sort = page.locator('#sbbs_sort');

            await expect(picker.locator('option[value="janitorai"]')).toHaveText('JanitorAI');
            // The all-sources entry counts only sources that can search by text.
            await expect(picker.locator('option').first()).toHaveText('All sources (2)');

            await picker.selectOption('janitorai');
            await expect(sort).toBeVisible();
            await expect(sort.locator('option')).toHaveText(['Trending 24h', 'Trending 7d', 'Popular', 'Latest']);
            await expect(query).toHaveAttribute('placeholder', 'Paste a card URL');
            const cards = page.locator('#sbbs_grid .sbbs-card');
            await expect(cards).toHaveCount(6);
            await expect(cards.first().locator('.sbbs-card-name')).toHaveText('Trending character 1');
            const first = searches.findLast(entry => entry.body.source === 'janitorai');
            expect(first?.body.sort).toBe('trending_day');
            // BotSearcher starts with 'SFW only' on, which asks JanitorAI for its SFW list.
            expect(first?.sections).toEqual([{ section: 'trending24', mode: 'sfw' }]);

            await sort.selectOption('trending_week');
            await expect.poll(() => searches.findLast(entry => entry.body.source === 'janitorai')?.sections?.[0]?.section).toBe('trending');

            await query.fill('elf');
            await query.press('Enter');
            await expect(page.locator('#sbbs_state')).toContainText('JanitorAI shows its own lists and cannot search by text.');
            const typed = searches.findLast(entry => entry.body.source === 'janitorai');
            expect(typed?.body.query).toBe('');

            if (process.env.NECONYAN_JANITOR_SCREENSHOTS) {
                await mkdir('../screenshots', { recursive: true });
                await page.screenshot({ path: `../screenshots/janitorai-${name}-${process.env.NECONYAN_JANITOR_SCREENSHOTS}.png` });
            }
        });
    });
}
