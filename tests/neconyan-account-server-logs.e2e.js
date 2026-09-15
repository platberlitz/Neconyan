/* global document, window, getComputedStyle */
import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const screenshotDir = fileURLToPath(new URL('../output/playwright/neconyan-audit/account-server-reviewed', import.meta.url));
mkdirSync(screenshotDir, { recursive: true });
const lightTheme = JSON.parse(readFileSync(new URL('../default/content/themes/Neconyan Calico.json', import.meta.url), 'utf8'));

test.use({ viewport: { width: 320, height: 900 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
test.setTimeout(120000);
let pageErrors;
test.beforeEach(({ page }) => {
    pageErrors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(error.message));
});
test.afterEach(() => expect(pageErrors).toEqual([]));

const accountFixture = {
    handle: 'neco-user',
    name: 'Neco User',
    admin: true,
    created: '2026-09-12T00:00:00.000Z',
    password: true,
    avatar: 'img/neconyan-persona.png',
};

const serverStatusFixture = {
    runtime: 'Node.js 22',
    configPath: '/isolated/config.yaml',
    version: { pkgVersion: '1.0.0', gitBranch: 'staging', gitRevision: 'abc1234' },
    repository: {
        supported: true,
        isRepo: true,
        branch: 'staging',
        displayBranch: 'staging',
        trackingBranch: 'origin/staging',
        currentCommit: 'abc1234',
        ahead: 0,
        behind: 2,
        canUpdate: false,
        hasLocalChanges: true,
        autoStash: false,
        changedFilesCount: 1,
        changedFiles: [{ path: 'working-tree.txt' }],
        message: 'This checkout has local changes.',
    },
    release: null,
};

const logEntries = [
    { id: 1, timestamp: 1726100000000, stream: 'stdout', message: 'Started Neconyan.' },
    { id: 2, timestamp: 1726100001000, stream: 'stderr', message: 'A'.repeat(320) },
];

async function installFailClosedRoutes(page, { light = false, delayLogs = false, logsMode = 'entries', serverMode = 'dirty', password = true } = {}) {
    let envelopePromise;
    let storedSettings;
    await page.route('**/api/settings/get', async route => {
        const envelope = await (envelopePromise ??= route.fetch().then(response => response.json()));
        if (!storedSettings) {
            storedSettings = JSON.parse(envelope.settings);
            if (light) {
                const { name, ...theme } = lightTheme;
                Object.assign(storedSettings.power_user, theme, { theme: name });
            }
        }
        await route.fulfill({ json: { ...envelope, settings: JSON.stringify(storedSettings) } });
    });
    await page.route('**/api/settings/save', async route => {
        const request = route.request();
        let body = request.postDataBuffer();
        if (request.headers()['content-encoding'] === 'gzip') body = gunzipSync(body);
        const payload = JSON.parse(body.toString());
        const version = Math.max(Date.now(), Number(payload._version || 0) + 1);
        storedSettings = { ...payload, _version: version };
        await route.fulfill({ json: { version } });
    });
    await page.route('**/api/users/me', route => route.fulfill({ json: { ...accountFixture, password } }));
    for (const pattern of [
        '**/api/users/reset*',
        '**/api/users/backup*',
        '**/api/users/change-password*',
        '**/api/users/change-avatar*',
        '**/api/cookies/clear',
    ]) {
        await page.route(pattern, () => { throw new Error(`Unexpected account mutation: ${pattern}`); });
    }
    await page.route(/\/api\/.*\/(?:generate|generate-quiet)(?:\?|$)/, () => {
        throw new Error('Unexpected model request during account/server/log UI test');
    });

    let logsRequests = 0;
    let statusRequests = 0;
    await page.route('**/api/server-admin/**', async route => {
        const endpoint = new URL(route.request().url()).pathname;
        if (endpoint === '/api/server-admin/status') {
            statusRequests++;
            if ((serverMode === 'retry' && statusRequests === 2) || (serverMode === 'initial-503' && statusRequests === 1)) {
                await route.fulfill({ status: 503, json: { error: 'Server status is temporarily unavailable.' } });
                return;
            }
            const status = structuredClone(serverStatusFixture);
            if (serverMode === 'retry') {
                Object.assign(status.repository, { canUpdate: true, hasLocalChanges: false, changedFilesCount: 0, changedFiles: [], message: 'An update is available.' });
            } else {
                status.repository.changedFilesCount = 12;
                status.repository.changedFiles = Array.from({ length: 12 }, (_, index) => ({ path: `public/scripts/long-nested-directory/changed-workspace-file-${index}.js` }));
            }
            await route.fulfill({ json: status });
            return;
        }
        if (endpoint === '/api/server-admin/branches') {
            await route.fulfill({ json: { branches: ['staging'] } });
            return;
        }
        if (endpoint === '/api/server-admin/config/get') {
            if (serverMode === 'initial-503') await new Promise(resolve => setTimeout(resolve, 300));
            await route.fulfill({ json: { path: '/isolated/config.yaml', content: 'logging:\n  minLogLevel: 1\n', lastModifiedMs: 1 } });
            return;
        }
        if (endpoint === '/api/server-admin/config/chat-completions/get') {
            await route.fulfill({ json: { settings: {}, lastModifiedMs: 1 } });
            return;
        }
        if (endpoint === '/api/server-admin/config/thumbnail-settings/get') {
            await route.fulfill({ json: {
                settings: { enabled: true, format: 'png', quality: 100, dimensions: { bg: [240, 135], avatar: [864, 1280], persona: [864, 1280] } },
                mobileSettings: { enabled: true, format: 'jpg', quality: 82, dimensions: { bg: [240, 135], avatar: [320, 480], persona: [320, 480] } },
                lastModifiedMs: 1,
            } });
            return;
        }
        if (endpoint === '/api/server-admin/logs') {
            logsRequests++;
            if (delayLogs) await new Promise(resolve => setTimeout(resolve, 400));
            if (logsMode === 'initial-503' && logsRequests === 1) {
                await route.fulfill({ status: 503, json: { error: 'Logs are temporarily unavailable.' } });
                return;
            }
            if (logsMode === 'empty') {
                await route.fulfill({ json: { entries: [], latestId: 0, totalBuffered: 0 } });
                return;
            }
            if (logsMode === 'retained-error' && logsRequests === 2) {
                await route.fulfill({ status: 503, json: { error: 'The next log refresh failed.' } });
                return;
            }
            await route.fulfill({ json: { entries: logEntries, latestId: 2, totalBuffered: 2, captureStartedAt: 1726100000000 } });
            return;
        }
        throw new Error(`Unexpected server-admin request: ${endpoint}`);
    });

    return () => logsRequests;
}

async function assertSurfaceGeometry(page, surface, coarse) {
    const selectors = {
        settings: '#UI-language-block :is(label, select), #account_controls button, #user-settings-utility-actions :is(.sb-settings-utility-action, .checkbox_label)',
        account: 'dialog.popup[open] button',
        server: '#sb-shell-panel-right-server .sb-server-actions button, #sb-shell-panel-right-server .sb-server-source-details summary, #sb-shell-panel-right-server .sb-server-card .checkbox_label',
        logs: '#sb-shell-panel-right-console-logs .sb-console-log-actions button',
    };
    const result = await page.evaluate(selector => {
        const visible = nodes => nodes.filter(node => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const nodes = visible([...document.querySelectorAll(selector)]);
        return {
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1,
            clipped: nodes.filter(node => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().left < -1 || node.getBoundingClientRect().right > window.innerWidth + 1)
                .map(node => node.id || node.getAttribute('aria-label') || node.textContent.trim()),
            short: nodes.filter(node => node.getBoundingClientRect().height < 43.5).map(node => node.id || node.getAttribute('aria-label') || node.textContent.trim()),
        };
    }, selectors[surface]);
    expect(result.horizontalOverflow).toBe(false);
    expect(result.clipped).toEqual([]);
    if (coarse) expect(result.short).toEqual([]);
}

async function dismissOptionalQigDialog(page) {
    const dialog = page.locator('dialog.popup[open]').filter({ hasText: 'Quick Image Gen found legacy browser-only settings' });
    if (await dialog.count()) {
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
}

async function openSettings(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-neconyan-cat]')).toBeVisible({ timeout: 60000 });
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'settings'));
    await expect(page.locator('.sb-settings-layout')).toBeVisible();
    await dismissOptionalQigDialog(page);
}

test('account profile keeps identity facts, hooks, current avatar, and touch targets', async ({ page }) => {
    await installFailClosedRoutes(page);
    await openSettings(page);
    await page.locator('.sb-settings-category-select').selectOption('cache-account');
    await page.locator('#account_button').click();

    const popup = page.locator('dialog.popup:visible');
    await expect(popup).toContainText('Account Info');
    await expect(popup.locator('h2')).toHaveText('Hi, Neco User');
    await expect(popup.locator('.hasPassword')).toHaveText('Protected');
    await expect(popup.locator('.noPassword')).toBeHidden();
    await expect(popup).toContainText('Chat personas are separate identities');
    await expect(popup.locator('.userHandle')).toHaveText('neco-user');
    await expect(popup.locator('.userRole')).toHaveText('Admin');
    await expect(popup.locator('.userAvatarChange')).toContainText('Change avatar');
    await expect(popup.locator('.userAvatarRemove')).toContainText('Remove avatar');
    await expect(popup.locator('.avatar img')).toHaveAttribute('src', /neconyan-persona\.png/);
    await expect(popup.locator('.userChangeNameButton')).toHaveAttribute('type', 'button');
    await expect(popup.locator('.avatarUpload')).toHaveCount(1);

    const shortControls = await popup.locator('button').evaluateAll(buttons => buttons
        .filter(button => button.getClientRects().length)
        .filter(button => button.getBoundingClientRect().height < 43.5)
        .map(button => button.textContent.trim()));
    expect(shortControls).toEqual([]);
    await popup.getByRole('button', { name: 'Close', exact: true }).click();

    const cancelledMutations = [];
    page.on('request', request => {
        if (/\/api\/cookies\/clear/.test(new URL(request.url()).pathname)) {
            cancelledMutations.push(new URL(request.url()).pathname);
        }
    });
    for (const buttonId of ['clear_all_cache_button', 'clear_cookies_cache_button']) {
        await page.locator(`#${buttonId}`).click();
        const confirmation = page.locator('dialog.popup:visible');
        await expect(confirmation).toContainText(buttonId === 'clear_all_cache_button' ? 'Clear all cache' : 'Clear cookies & cache');
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(confirmation).toHaveCount(0);
    }
    expect(cancelledMutations).toEqual([]);
});

test('Server keeps dirty update state visible and source details collapsed', async ({ page }) => {
    await installFailClosedRoutes(page);
    await openSettings(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'server'));

    const panel = page.locator('#sb-shell-panel-right-server');
    await expect(panel.locator('.sb-server-summary-grid')).toContainText('Runtime');
    await expect(panel.getByRole('combobox', { name: 'Git branch' })).toBeVisible();
    await expect(panel.locator('.sb-server-summary-grid')).toContainText('Commit');
    await expect(panel.locator('.sb-server-pill')).toHaveText('Update Blocked');
    await expect(panel.locator('.sb-server-note[data-tone="danger"]')).toContainText('local changes');
    await expect(panel.locator('.sb-server-source-details')).not.toHaveAttribute('open', '');
    await expect(panel.locator('.sb-server-source-details')).toContainText('Tracking');
    await expect(panel.locator('.sb-server-action', { hasText: 'Update & Restart' })).toBeDisabled();
    const restart = panel.getByRole('button', { name: 'Restart server', exact: true });
    await expect(restart).toBeInViewport();
    const restartBounds = await restart.boundingBox();
    expect(restartBounds.y + restartBounds.height).toBeLessThanOrEqual(900);
    await expect(panel.locator('.sb-server-source-details')).toContainText('changed-workspace-file-11.js');
});

test('Logs expose selectable output, preserve it on identical polling, and copy only entries', async ({ page }) => {
    const logsRequestCount = await installFailClosedRoutes(page);
    await openSettings(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'console-logs'));

    const panel = page.locator('#sb-shell-panel-right-console-logs');
    const output = panel.locator('[role="log"]');
    const copyButton = panel.getByRole('button', { name: 'Copy logs' });
    await expect(output).toContainText('Started Neconyan.');
    await expect(output).toContainText('A'.repeat(320));
    await expect(output).toHaveAttribute('tabindex', '0');
    await expect(copyButton).toBeEnabled();

    await output.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    });
    const selectedBeforePolling = await page.evaluate(() => window.getSelection().toString());
    await page.waitForTimeout(2800);
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(selectedBeforePolling);

    const pauseButton = panel.locator('.sb-console-log-actions button').nth(1);
    await pauseButton.click();
    await expect(pauseButton).toHaveAttribute('aria-pressed', 'true');
    const requestsWhilePaused = logsRequestCount();
    await page.waitForTimeout(2800);
    expect(logsRequestCount()).toBe(requestsWhilePaused);

    await page.evaluate(() => {
        window.__neconyanCopied = [];
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: {
            writeText: async text => window.__neconyanCopied.push(text),
        } });
    });
    await copyButton.click();
    await expect(panel.locator('.sb-console-log-copy-status')).toHaveText('Logs copied.');
    expect(await page.evaluate(() => window.__neconyanCopied)).toEqual([await output.textContent()]);
    await expect(copyButton).toBeFocused();
});





test('Logs show initial unavailable state and recover on the next refresh', async ({ page }) => {
    await installFailClosedRoutes(page, { logsMode: 'initial-503' });
    await openSettings(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'console-logs'));
    const panel = page.locator('#sb-shell-panel-right-console-logs');
    const output = panel.locator('[role="log"]');
    const refresh = panel.locator('.sb-console-log-actions button').first();
    await expect(panel.locator('.sb-server-pill')).toHaveText('Unavailable');
    await expect(output).toContainText('No console output has been captured yet');
    await expect(panel.getByRole('button', { name: 'Copy logs' })).toBeDisabled();
    await refresh.click();
    await expect(output).toContainText('Started Neconyan.');
    await expect(panel.locator('.sb-server-pill')).toHaveText('Live');
});

test('Logs distinguish empty output and disable Copy', async ({ page }) => {
    await installFailClosedRoutes(page, { logsMode: 'empty' });
    await openSettings(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'console-logs'));
    const emptyPanel = page.locator('#sb-shell-panel-right-console-logs');
    await expect(emptyPanel.locator('.sb-server-pill')).toHaveText('Empty');
    await expect(emptyPanel.getByRole('button', { name: 'Copy logs' })).toBeDisabled();

});

test('Logs retain previous output after a failed refresh and recover', async ({ page }) => {
    await installFailClosedRoutes(page, { logsMode: 'retained-error' });
    await openSettings(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'console-logs'));
    const panel = page.locator('#sb-shell-panel-right-console-logs');
    const output = panel.locator('[role="log"]');
    const refresh = panel.locator('.sb-console-log-actions button').first();
    await expect(output).toContainText('Started Neconyan.');
    await refresh.click();
    await expect(panel.locator('.sb-server-pill')).toHaveText('Refresh failed');
    await expect(output).toContainText('Started Neconyan.');
    await expect(panel.getByRole('button', { name: 'Copy logs' })).toBeEnabled();
    await refresh.click();
    await expect(panel.locator('.sb-server-pill')).toHaveText('Live');
});

test('Pause Live keeps an in-flight response from rewriting selected output', async ({ page }) => {
    await installFailClosedRoutes(page, { delayLogs: true });
    await openSettings(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'console-logs'));

    const panel = page.locator('#sb-shell-panel-right-console-logs');
    const output = panel.locator('[role="log"]');
    const pauseButton = panel.locator('.sb-console-log-actions button').nth(1);
    const before = await output.textContent();
    await expect(output).toHaveAttribute('aria-busy', 'true');
    await pauseButton.click();
    await expect(pauseButton).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(600);
    expect(await output.textContent()).toBe(before);
    await expect(output).not.toContainText('Started Neconyan.');

    await pauseButton.click();
    await expect(pauseButton).toHaveAttribute('aria-pressed', 'false');
    await expect(output).toContainText('Started Neconyan.');
});

test('Server disables stale Update authority after a failed status refresh and recovers', async ({ page }) => {
    await installFailClosedRoutes(page, { serverMode: 'retry' });
    await openSettings(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'server'));
    const panel = page.locator('#sb-shell-panel-right-server');
    const update = panel.getByRole('button', { name: 'Update & Restart', exact: true });
    const refresh = panel.getByRole('button', { name: 'Check for updates', exact: true });
    await expect(update).toBeEnabled();
    await refresh.click();
    await expect(panel.locator('.sb-server-pill')).toHaveText('Unavailable');
    await expect(update).toBeDisabled();
    await update.dispatchEvent('click');
    await refresh.click();
    await expect(update).toBeEnabled();
    await expect(panel.locator('.sb-server-pill')).toHaveText('Update Ready');
});

test('Server handles initial status failure while configuration is still loading and retries', async ({ page }) => {
    await installFailClosedRoutes(page, { serverMode: 'initial-503' });
    await openSettings(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'server'));
    const panel = page.locator('#sb-shell-panel-right-server');
    await expect(panel.locator('.sb-server-pill')).toHaveText('Unavailable');
    await expect(panel.getByRole('button', { name: 'Update & Restart', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await expect(panel.locator('.sb-server-pill')).toHaveText('Update Blocked');
    await expect(panel.getByRole('combobox', { name: 'Git branch' })).toBeVisible();
});

test('Logs report legacy clipboard failure, clean up, and allow retry', async ({ page }) => {
    await installFailClosedRoutes(page);
    await openSettings(page);
    await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'console-logs'));
    const panel = page.locator('#sb-shell-panel-right-console-logs');
    await expect(panel.locator('[role="log"]')).toContainText('Started Neconyan.');
    await page.evaluate(() => {
        Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined });
        document.execCommand = () => false;
    });
    const textareas = await page.locator('textarea').count();
    const copy = panel.getByRole('button', { name: 'Copy logs', exact: true });
    await copy.click();
    await expect(panel.locator('.sb-console-log-copy-status')).toHaveText('Could not copy text to the clipboard.');
    await expect(copy).toBeFocused();
    expect(await page.locator('textarea').count()).toBe(textareas);
    await page.evaluate(() => { document.execCommand = () => true; });
    await copy.click();
    await expect(panel.locator('.sb-console-log-copy-status')).toHaveText('Logs copied.');
    expect(await page.locator('textarea').count()).toBe(textareas);
});

test('Account shows no-password state and guards Backup re-entry and failed-download retry', async ({ page }) => {
    await installFailClosedRoutes(page, { password: false });
    let backupRequests = 0;
    await page.route('**/api/users/backup', async route => {
        backupRequests++;
        expect(route.request().postDataJSON()).toEqual({ handle: 'neco-user' });
        await new Promise(resolve => setTimeout(resolve, 400));
        await route.fulfill({ status: 503, json: { error: 'Backup temporarily unavailable.' } });
    });
    await openSettings(page);
    await page.locator('.sb-settings-category-select').selectOption('cache-account');
    await page.locator('#account_button').click();
    const popup = page.locator('dialog.popup:visible');
    await expect(popup.locator('.noPassword')).toHaveText('Not set');
    await expect(popup.locator('.hasPassword')).toBeHidden();
    const backup = popup.getByRole('button', { name: 'Download Backup', exact: true });
    await backup.click();
    await expect(backup).toBeDisabled();
    await expect(backup).toHaveAttribute('aria-busy', 'true');
    await backup.dispatchEvent('click');
    await expect(backup).toBeEnabled();
    expect(backupRequests).toBe(1);
    await expect(page.locator('#toast-container')).toContainText('Backup temporarily unavailable.');
    await backup.click();
    await expect(backup).toBeDisabled();
    await expect(backup).toBeEnabled();
    expect(backupRequests).toBe(2);
});

async function assertPillContrast(panel) {
    const contrast = await panel.locator('.sb-server-pill').evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const luminance = bytes => [...bytes].slice(0, 3).map(channel => channel / 255)
            .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
            .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        const ancestors = [];
        for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
        context.fillStyle = '#fff';
        context.fillRect(0, 0, 1, 1);
        for (const node of ancestors) {
            context.fillStyle = getComputedStyle(node).backgroundColor;
            context.fillRect(0, 0, 1, 1);
        }
        const background = luminance(context.getImageData(0, 0, 1, 1).data);
        context.fillStyle = getComputedStyle(element).color;
        context.fillRect(0, 0, 1, 1);
        const foreground = luminance(context.getImageData(0, 0, 1, 1).data);
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
}

for (const width of [1280, 390, 320]) {
    for (const tone of ['dark', 'light']) {
        test.describe(`visual matrix ${tone} ${width}px`, () => {
            test.use({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 768 });
            test(`captures Account, Settings, Server, and Logs`, async ({ page }) => {
                await installFailClosedRoutes(page, { light: tone === 'light' });
                await openSettings(page);
                const capture = async surface => {
                    await expect(page.locator('#toast-container .toast')).toHaveCount(0);
                    await page.screenshot({ path: `${screenshotDir}/${tone}-${width}-${surface}.png`, fullPage: false });
                };

                const categorySelect = page.locator('.sb-settings-category-select');
                if (await categorySelect.isVisible()) {
                    await categorySelect.selectOption('cache-account');
                } else {
                    await page.locator('.sb-settings-tab-btn[data-tab="cache-account"]').click();
                }
                await capture('settings');
                await assertSurfaceGeometry(page, 'settings', width < 768);
                await page.locator('#account_button').click();
                await expect(page.locator('dialog.popup:visible')).toContainText('Account Info');
                const earClearance = await page.locator('.neconyan-account-panel').evaluate(panel => {
                    const content = panel.closest('.popup-content').getBoundingClientRect();
                    const earHeight = parseFloat(getComputedStyle(panel, '::before').height);
                    return panel.getBoundingClientRect().top - earHeight - content.top;
                });
                expect(earClearance).toBeGreaterThanOrEqual(0);
                await capture('account');
                await assertSurfaceGeometry(page, 'account', width < 768);
                await page.locator('dialog.popup:visible').getByRole('button', { name: 'Close', exact: true }).click();

                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'server'));
                await expect(page.locator('#sb-shell-panel-right-server .sb-server-summary-grid')).toContainText('Runtime');
                await assertPillContrast(page.locator('#sb-shell-panel-right-server'));
                await capture('server');
                await assertSurfaceGeometry(page, 'server', width < 768);

                await page.evaluate(() => window.SillyBunnyShell.openTab('right', 'console-logs'));
                await expect(page.locator('#sb-shell-panel-right-console-logs [role="log"]')).toContainText('Started Neconyan.');
                await assertPillContrast(page.locator('#sb-shell-panel-right-console-logs'));
                await capture('logs');
                await assertSurfaceGeometry(page, 'logs', width < 768);
            });
        });
    }
}
