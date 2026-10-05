/* global window, getComputedStyle */
import { expect, test } from '@playwright/test';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

test.describe.configure({ mode: 'serial' });

const pages = [
    { shell: 'left', tab: 'api', key: 'neconyanToolTourInvite.connections', action: 'close', launch: '#left-nav-panel .sb-shell-header .neconyan-tool-tour-button' },
    { shell: 'left', tab: 'sampling', key: 'neconyanToolTourInvite.sampling', action: 'later', launch: '#left-nav-panel .sb-shell-header .neconyan-tool-tour-button' },
    { shell: 'characters', tab: 'characters', key: 'neconyanToolTourInvite.character-library', action: 'close', launch: '#rm_characters_block .neconyan-tool-tour-button' },
    { shell: 'characters', tab: 'groups', key: 'neconyanToolTourInvite.group-library', action: 'start', launch: '#rm_characters_block .neconyan-tool-tour-button' },
    { shell: 'characters', tab: 'import', key: 'neconyanToolTourInvite.character-import', action: 'close', launch: '#sb_character_import_panel .neconyan-tool-tour-button' },
    { shell: 'characters', tab: 'world-info', key: 'neconyanLorebookTourInvite', action: 'later', launch: '#WorldInfo .neconyan-lorebook-tour-button' },
];

function invitation(page, key) {
    return page.locator(`[data-neconyan-tour-invite-key="${key}"]`);
}

async function openPage(page, entry, phone) {
    await page.evaluate(({ shell, tab }) => window.NeconyanShell.openTab(shell, tab), entry);
    await expect(invitation(page, entry.key)).toBeAttached();
    if (phone) await applyIOSOnlyCss(page);
}

async function savedInvitations(page) {
    return page.evaluate(async keys => {
        const { accountStorage } = await import('/scripts/util/AccountStorage.js');
        return keys.map(key => accountStorage.getItem(key));
    }, pages.map(entry => entry.key));
}

async function dismiss(page, entry) {
    const invite = invitation(page, entry.key);
    await expect(invite).toBeVisible();
    if (entry.action === 'close') {
        await invite.locator('.neconyan-tour-invite-dismiss').click();
    } else if (entry.action === 'later') {
        await invite.getByRole('button', { name: 'Not now', exact: true }).click();
    } else {
        await invite.getByRole('button', { name: 'Show me around', exact: true }).click();
        const tour = page.locator('#neconyan-tool-tour');
        await expect(tour).toBeVisible();
        await tour.locator('.neconyan-tool-tour-close').click();
        await expect(tour).toHaveCount(0);
    }
    await expect(invite).toBeHidden();
}

for (const phone of [false, true]) {
    test(`page-tour dismissals survive a delayed settings reload on ${phone ? 'iPhone emulation' : 'desktop'}`, async ({ browser }, info) => {
        test.setTimeout(180000);
        const context = await browser.newContext({
            ...(phone ? IPHONE_SAFARI_CONTEXT : { viewport: { width: 1280, height: 900 } }),
            baseURL: info.project.use.baseURL,
            reducedMotion: 'reduce',
            serviceWorkers: 'block',
        });
        let releaseSettings;
        let delaySettings = false;
        let settingsHeld = false;
        try {
            if (phone) await installIPhoneSafari(context, { standalone: true });
            const page = await context.newPage();
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const data = await response.json();
                if (typeof data.settings === 'string') {
                    const settings = JSON.parse(data.settings);
                    settings.firstRun = false;
                    settings.accountStorage ??= {};
                    settings.accountStorage['NeconyanTutorialStatus.v1'] = 'skipped';
                    data.settings = JSON.stringify(settings);
                    if (delaySettings) {
                        delaySettings = false;
                        settingsHeld = true;
                        await new Promise(resolve => { releaseSettings = resolve; });
                    }
                }
                await route.fulfill({ response, json: data });
            });
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120000 });
            await page.evaluate(async () => {
                const { restoreTourInvitations } = await import('/scripts/neconyan-tour-invitations.js');
                restoreTourInvitations();
            });

            for (const entry of pages) {
                await openPage(page, entry, phone);
                await dismiss(page, entry);
            }
            expect(await savedInvitations(page)).toEqual(pages.map(() => 'seen'));
            expect(await page.evaluate(async () => {
                const { saveSettings } = await import('/script.js');
                return saveSettings(0, { returnResult: true });
            })).toBe(true);

            delaySettings = true;
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect.poll(() => settingsHeld).toBe(true);
            await page.waitForFunction(() => Boolean(window.NeconyanShell));
            await openPage(page, pages[0], phone);
            expect(await page.evaluate(async () => (await import('/scripts/util/AccountStorage.js')).accountStorage.isReady)).toBe(false);
            await expect(invitation(page, pages[0].key)).toBeHidden();
            expect(await invitation(page, pages[0].key).evaluate(node => ({ hidden: node.hidden, display: getComputedStyle(node).display, boxes: node.getClientRects().length }))).toEqual({ hidden: true, display: 'none', boxes: 0 });
            releaseSettings();
            await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 120000 });
            await expect.poll(() => savedInvitations(page)).toEqual(pages.map(() => 'seen'));

            for (const entry of pages) {
                await openPage(page, entry, phone);
                await expect(invitation(page, entry.key)).toBeHidden();
                await expect(page.locator(entry.launch)).toBeVisible();
            }

            const fresh = { shell: 'characters', tab: 'persona', key: 'neconyanToolTourInvite.persona' };
            await openPage(page, fresh, phone);
            await expect(invitation(page, fresh.key)).toBeVisible();

            await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
            const categories = page.locator('.sb-settings-category-select');
            if (await categories.isVisible()) await categories.selectOption('appearance');
            else await page.locator('.sb-settings-tab-btn[data-tab="appearance"]').click();
            const restore = page.locator('#sb-restore-tour-invitations');
            if (!await restore.isVisible()) await page.locator('#sb-page-tours-drawer .inline-drawer-toggle').click();
            await restore.click();
            await expect.poll(() => savedInvitations(page)).toEqual(pages.map(() => null));
            for (const entry of pages) {
                await openPage(page, entry, phone);
                await expect(invitation(page, entry.key)).toBeVisible();
            }
        } finally {
            releaseSettings?.();
            for (const page of context.pages()) await page.unrouteAll({ behavior: 'wait' });
            await context.close();
        }
    });
}
