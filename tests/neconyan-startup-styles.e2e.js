/* global window, document, matchMedia, MutationObserver */
import { chromium, expect, test } from '@playwright/test';

const base = process.env.NECONYAN_TEST_BASE_URL;
test.skip(!base, 'Requires this worktree\'s disposable preview.');
test.setTimeout(180000);
test.describe.configure({ mode: 'serial' });

const SLOW_STYLESHEET_MS = 1500;

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} first open shows no page before its styles have loaded`, async () => {
        const browser = await chromium.launch();
        const context = await browser.newContext({
            ...(phone ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
            serviceWorkers: 'block',
        });
        await context.addInitScript(() => {
            const state = { splashSeen: false, agentsMountedBeforeCss: null, snapshot: null };
            window.__startupStyles = state;
            const applies = link => {
                const media = link.media || 'all';
                return media === 'all' || matchMedia(media).matches;
            };
            const check = () => {
                const agentsSettings = document.getElementById('ica--settings');
                if (agentsSettings && state.agentsMountedBeforeCss === null) {
                    state.agentsMountedBeforeCss = !document.getElementById('in-chat-agents-css')?.sheet;
                }
                const splashOpen = Boolean(document.querySelector('dialog[open] .splash-screen'));
                if (splashOpen) state.splashSeen = true;
                if (!state.splashSeen || splashOpen || state.snapshot) return;
                const links = [...document.querySelectorAll('link[rel~="stylesheet"]')];
                state.snapshot = {
                    pending: links.filter(link => applies(link) && !link.sheet).map(link => link.getAttribute('href')),
                    deferredNotActivated: [...document.querySelectorAll('link[data-sb-deferred-style]')]
                        .filter(link => link.rel !== 'stylesheet').map(link => link.getAttribute('href')),
                    startupSheets: ['deferred-highlight-theme-css', 'deferred-cropper-css', 'deferred-rm-groups-css', 'deferred-group-avatars-css', 'deferred-macros-css']
                        .filter(id => !document.getElementById(id)?.sheet),
                    shellStyleApplied: Boolean(document.querySelector('link[data-sb-shell-style]')?.sheet),
                    agentsMounted: Boolean(agentsSettings),
                };
            };
            new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
            window.setInterval(check, 20);
        });
        // A new device: the account picked Windows 98, but this browser has no saved copy of that choice.
        await context.route('**/api/settings/get', async route => {
            const response = await route.fetch();
            const body = await response.json().catch(() => null);
            if (!body?.settings) return route.fulfill({ response });
            const settings = typeof body.settings === 'string' ? JSON.parse(body.settings) : body.settings;
            settings.power_user = { ...settings.power_user, neconyan_shell_style: 'windows-98' };
            body.settings = typeof body.settings === 'string' ? JSON.stringify(settings) : settings;
            return route.fulfill({ response, json: body });
        });
        const slow = async route => {
            await new Promise(resolve => setTimeout(resolve, SLOW_STYLESHEET_MS));
            return route.continue();
        };
        await context.route('**/scripts/extensions/in-chat-agents/style.css*', slow);
        await context.route('**/css/shell-styles/windows-98.css*', slow);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await expect.poll(() => page.evaluate(() => Boolean(window.__startupStyles?.snapshot)), { timeout: 120000 }).toBe(true);
            const state = await page.evaluate(() => window.__startupStyles);
            expect(state.snapshot).toEqual({
                pending: [],
                deferredNotActivated: [],
                startupSheets: [],
                shellStyleApplied: true,
                agentsMounted: true,
            });
            expect(state.agentsMountedBeforeCss).toBe(false);
            expect(errors).toEqual([]);
        } finally {
            await browser.close();
        }
    });
}
