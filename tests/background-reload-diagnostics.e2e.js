/* global window, document, localStorage, sessionStorage, HTMLMediaElement, NeconyanCrashDiagnostics */
import { expect, test } from '@playwright/test';

const ANDROID_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; SM-F966B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const INTERRUPTED_TEXT = 'The browser or another app stopped the sound while you were away, so Android may reload Neconyan.';

test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, userAgent: ANDROID_USER_AGENT, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.setTimeout(180000);

test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
        // The keep-alive sound is an Audio element the page creates itself, so wrap the constructor to reach it.
        const OriginalAudio = window.Audio;
        window.__audios = [];
        window.Audio = function (...args) {
            const element = new OriginalAudio(...args);
            window.__audios.push(element);
            return element;
        };
        window.Audio.prototype = OriginalAudio.prototype;
        window.__keepAliveAudio = () => window.__audios.find(element => element.loop);
        // Copies the closing session record out of the page that is going away.
        window.addEventListener('unload', () => {
            const tab = sessionStorage.getItem('neconyan.crash-tab.v1');
            sessionStorage.setItem('probe:last-session', localStorage.getItem('neconyan.crash-session.v1:' + tab) || '');
        });
    });
});

async function waitForApp(page, { keepNotice = false } = {}) {
    await expect.poll(() => page.evaluate(() => window.NeconyanCrashDiagnostics?.getActivity?.()?.snapshot?.ready === true), { timeout: 120000 }).toBe(true);
    await page.evaluate(keepNotice => {
        document.querySelector('#neconyan-tour-coachmark [data-tour-coach-skip]')?.click();
        if (!keepNotice) document.querySelector('#nn-update-toast')?.remove();
    }, keepNotice);
}

async function openApp(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
}

const setVisibility = (page, value) => page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
}, value);

/** Rewrites /version for as long as `mode.value` says so. The page reads the real one when it loads. */
async function rewriteVersion(context) {
    const mode = { value: 'real', hits: 0 };
    await context.route('**/version', async route => {
        mode.hits++;
        const response = await route.fetch();
        const json = await response.json();
        if (mode.value === 'changed') json.gitRevision = 'deadbeef';
        if (mode.value === 'longer') json.gitRevision = `${json.gitRevision}9a8b7c`;
        if (mode.value === 'unknown') json.pkgVersion = 'UNKNOWN';
        await route.fulfill({ response, json });
    });
    return mode;
}

test('an update reload leaves a note with its versions and is not a crash, while a longer hash or an unreadable version does not reload', async ({ page, context }) => {
    const mode = await rewriteVersion(context);
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await openApp(page);
    await page.evaluate(() => { window.__marker = 'original-document'; });
    const startedAt = navigations;

    for (const next of ['longer', 'unknown']) {
        mode.value = next;
        const hits = mode.hits;
        await setVisibility(page, 'hidden');
        await setVisibility(page, 'visible');
        await expect.poll(() => mode.hits).toBeGreaterThan(hits);
        // A reload would start well inside this wait.
        await page.waitForTimeout(2500);
        expect(navigations).toBe(startedAt);
        expect(await page.evaluate(() => window.__marker)).toBe('original-document');
    }
    expect(await page.evaluate(() => NeconyanCrashDiagnostics.getReports().reloads.length)).toBe(0);

    mode.value = 'changed';
    await setVisibility(page, 'hidden');
    const reloaded = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() });
    await setVisibility(page, 'visible');
    await reloaded;
    mode.value = 'real';
    await waitForApp(page);

    expect(navigations).toBe(startedAt + 1);
    expect(await page.evaluate(() => window.__marker ?? null)).toBeNull();
    const result = await page.evaluate(() => ({
        reports: NeconyanCrashDiagnostics.getReports(),
        notice: document.querySelectorAll('#neconyan-crash-notice').length,
        failures: localStorage.getItem('neconyan.crash-startup-failures.v1'),
        previous: JSON.parse(sessionStorage.getItem('probe:last-session')),
    }));
    expect(result.reports.reloads).toHaveLength(1);
    expect(result.reports.reloads[0]).toMatchObject({ kind: 'page-reloaded-by-app', reason: 'served-code-changed', to: 'deadbeef', summary: 'Neconyan reloaded this page to load an update' });
    expect(result.reports.reloads[0].from).toMatch(/^[0-9a-f]{7,}$/);
    expect(result.reports.recoveries).toHaveLength(0);
    expect(result.reports.reports).toHaveLength(0);
    expect(result.notice).toBe(0);
    expect(result.failures).toBeNull();
    // The page that reloaded itself closed normally.
    expect(result.previous).toMatchObject({ state: 'closed', ready: true });
});

test('a page with a draft only offers the update, and tapping the notice reloads with its own reason', async ({ page, context }) => {
    const mode = await rewriteVersion(context);
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await openApp(page);
    await page.evaluate(() => { document.querySelector('#send_textarea').value = 'An unsent draft'; });
    const startedAt = navigations;

    mode.value = 'changed';
    await setVisibility(page, 'hidden');
    await setVisibility(page, 'visible');
    const notice = page.locator('#toast-container .toast').filter({ hasText: 'Update ready' });
    await expect(notice).toBeVisible();
    await page.waitForTimeout(2500);
    expect(navigations).toBe(startedAt);
    expect(await page.evaluate(() => NeconyanCrashDiagnostics.getReports().reloads.length)).toBe(0);

    const reloaded = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() });
    mode.value = 'real';
    await notice.click();
    await reloaded;
    await waitForApp(page);
    const reloads = await page.evaluate(() => NeconyanCrashDiagnostics.getReports().reloads);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toMatchObject({ reason: 'update-toast', to: 'deadbeef' });
    expect(await page.evaluate(() => NeconyanCrashDiagnostics.getReports().recoveries.length)).toBe(0);
});

const ANNOUNCED_KEY = 'neconyan.page-reload-announced.v1';
const updateNotice = page => page.locator('#nn-update-toast').filter({ hasText: 'Neconyan updated' });

/** The 'Update available' check would put its own notice in the same corner. */
const stubUpdateStatus = context => context.route('**/api/server-admin/status', route => route.fulfill({ json: { repository: { isRepo: false } } }));

test('an update reload shows Neconyan updated once, with only Dismiss to press, and no later load shows it again', async ({ page, context }) => {
    await stubUpdateStatus(context);
    const mode = await rewriteVersion(context);
    await openApp(page);
    // A first visit is a navigation, not a reload.
    await expect(updateNotice(page)).toHaveCount(0);

    mode.value = 'changed';
    await setVisibility(page, 'hidden');
    const reloaded = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() });
    await setVisibility(page, 'visible');
    await reloaded;
    mode.value = 'real';
    await waitForApp(page, { keepNotice: true });

    const notice = updateNotice(page);
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(notice.locator('strong')).toHaveText('Neconyan updated');
    await expect(notice).toContainText('The page reloaded to load the new version.');
    // Nothing to act on: the body is text, and Dismiss is the only button.
    expect(await notice.locator('.nn-update-toast-open').evaluate(element => element.tagName)).toBe('DIV');
    await expect(notice.getByRole('button')).toHaveCount(1);
    const noteId = await page.evaluate(() => NeconyanCrashDiagnostics.getReports().reloads.at(-1).id);
    expect(await page.evaluate(key => localStorage.getItem(key), ANNOUNCED_KEY)).toBe(noteId);
    const box = await notice.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(393);
    expect(box.y + box.height).toBeLessThanOrEqual(852);

    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('#nn-update-toast')).toHaveCount(0);

    // The person pressing the browser's reload button on the same page.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page, { keepNotice: true });
    await page.waitForTimeout(2000);
    await expect(page.locator('#nn-update-toast')).toHaveCount(0);

    // A new tab in the same browser.
    const other = await context.newPage();
    await other.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForApp(other, { keepNotice: true });
    await other.waitForTimeout(2000);
    await expect(other.locator('#nn-update-toast')).toHaveCount(0);
    expect(await other.evaluate(key => localStorage.getItem(key), ANNOUNCED_KEY)).toBe(noteId);
});

test('the cleared-cache update reload shows the notice and it closes by itself', async ({ page, context }) => {
    await stubUpdateStatus(context);
    await openApp(page);
    await page.evaluate(() => NeconyanCrashDiagnostics.noteReload({ reason: 'cache-cleared-after-update', from: '1.2.3', to: '1.2.4' }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page, { keepNotice: true });
    const notice = updateNotice(page);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('The page reloaded to load the new version.');
    // Nothing hovers or focuses it, so it leaves after its eight seconds.
    await expect(notice).toHaveCount(0, { timeout: 20000 });
});

for (const reason of ['user-requested', 'update-toast', 'server-restarted']) {
    test(`a reload noted as ${reason} shows no Neconyan updated notice`, async ({ page, context }) => {
        await stubUpdateStatus(context);
        await openApp(page);
        await page.evaluate(reason => NeconyanCrashDiagnostics.noteReload({ reason, from: '1.2.3', to: '1.2.4' }), reason);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForApp(page, { keepNotice: true });
        await page.waitForTimeout(2000);
        await expect(page.locator('#nn-update-toast')).toHaveCount(0);
        expect(await page.evaluate(key => localStorage.getItem(key), ANNOUNCED_KEY)).toBeNull();
        expect(await page.evaluate(() => NeconyanCrashDiagnostics.getReports().reloads.at(-1).reason)).toBe(reason);
    });
}

test('Stay open in the background reports real playback, treats a plain pause as an interruption and retries a faulty element once', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
        window.__playCalls = 0;
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () { window.__playCalls++; return play.call(this); };
    });
    await page.evaluate(() => window.NeconyanShell.openTab('right', 'settings'));
    await page.locator('.sb-settings-tab-btn[data-tab="system-device"]').filter({ visible: true }).first().click();
    const group = page.locator('#background_keep_alive_group');
    // The drawer holding the group may already be open.
    if (!await group.isVisible()) await page.locator('#sb-aggressive-dom-unload-drawer > .inline-drawer-toggle').first().click();
    await expect(group).toBeVisible();
    const status = page.locator('#background_keep_alive_status');
    const keepAlive = () => page.evaluate(() => NeconyanCrashDiagnostics.getActivity().snapshot.keepAlive);

    await expect(status).toHaveText('Off. Android may reload Neconyan if you stay away for long.');
    await group.locator('label[for="background_keep_alive"]').click();
    await expect(status).toHaveText('On. Starts when you switch to another app or tab.');
    expect(await keepAlive()).toMatchObject({ enabled: true, state: 'armed', interruptions: 0 });

    await setVisibility(page, 'hidden');
    await expect.poll(() => page.evaluate(() => { const audio = window.__keepAliveAudio(); return Boolean(audio) && !audio.paused && audio.currentTime > 0; })).toBe(true);
    await expect(status).toHaveText('Keeping Neconyan open.');
    expect(await keepAlive()).toMatchObject({ state: 'playing', interruptions: 0 });

    // A pause nobody on the page asked for. Another app taking over audio looks like this, so it is not played again.
    await page.evaluate(() => window.__keepAliveAudio().pause());
    await expect(status).toHaveText(INTERRUPTED_TEXT);
    expect(await keepAlive()).toMatchObject({ state: 'interrupted', interruptions: 1, lastEvent: 'pause' });
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => ({ paused: window.__keepAliveAudio().paused, plays: window.__playCalls }))).toEqual({ paused: true, plays: 1 });

    await setVisibility(page, 'visible');
    await expect(status).toHaveText(INTERRUPTED_TEXT);
    expect(await keepAlive()).toMatchObject({ state: 'interrupted', interruptions: 1 });

    // A fault in the element itself gets exactly one more try.
    await setVisibility(page, 'hidden');
    await expect.poll(() => page.evaluate(() => { const audio = window.__keepAliveAudio(); return !audio.paused && audio.currentTime > 0; })).toBe(true);
    await expect(status).toHaveText('Keeping Neconyan open.');
    const plays = await page.evaluate(() => window.__playCalls);
    await page.evaluate(() => window.__keepAliveAudio().dispatchEvent(new Event('error')));
    await expect(status).toHaveText(INTERRUPTED_TEXT);
    await expect(status).toHaveText('Keeping Neconyan open.');
    expect(await page.evaluate(() => window.__playCalls)).toBe(plays + 1);
    await page.evaluate(() => window.__keepAliveAudio().dispatchEvent(new Event('error')));
    await expect(status).toHaveText(INTERRUPTED_TEXT);
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => window.__playCalls)).toBe(plays + 1);
    expect(await keepAlive()).toMatchObject({ state: 'interrupted', interruptions: 3, lastEvent: 'error' });
});

test('a page lost while hidden is explained by its recovery record and by the App diagnostics evidence', async ({ page, context }) => {
    const mode = await rewriteVersion(context);
    await openApp(page);
    await page.evaluate(() => {
        NeconyanCrashDiagnostics.updateActivity({ keepAlive: { enabled: true, state: 'interrupted', since: Date.now() - 2400000, interruptions: 1, playedSeconds: 600, lastEvent: 'pause' } });
    });
    await setVisibility(page, 'hidden');
    await page.evaluate(() => NeconyanCrashDiagnostics.flushActivity('test'));
    const entry = await page.evaluate(() => JSON.parse(localStorage.getItem('neconyan.crash-session.v1:' + sessionStorage.getItem('neconyan.crash-tab.v1'))));
    expect(entry).toMatchObject({ visibility: 'hidden', state: 'running' });
    expect(Number.isSafeInteger(entry.hiddenAt)).toBe(true);
    expect(entry.snapshot.keepAlive.state).toBe('interrupted');

    // The same record, as it would stand if the page had been lost 20 minutes after its last sign of life.
    const now = Date.now();
    Object.assign(entry, { heartbeatAt: now - 20 * 60000, hiddenAt: now - 50 * 60000 });
    await context.addInitScript(seed => {
        if (sessionStorage.getItem('seeded-death')) return;
        sessionStorage.setItem('seeded-death', '1');
        localStorage.setItem('neconyan.crash-session.v1:' + sessionStorage.getItem('neconyan.crash-tab.v1'), JSON.stringify(seed));
    }, entry);
    await setVisibility(page, 'visible');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);

    const recovery = await page.evaluate(() => NeconyanCrashDiagnostics.getReports().recoveries.at(-1));
    expect(recovery.kind).toBe('unclean-previous-page');
    expect(recovery.previousPage).toMatchObject({ hiddenAtLastSignOfLife: true, hiddenForMs: 30 * 60000, frozenAtLastSignOfLife: false, keepAlive: { state: 'interrupted', interruptions: 1, lastEvent: 'pause' } });
    expect(Math.abs(recovery.previousPage.lastSignOfLifeAgeMs - 20 * 60000)).toBeLessThan(60000);
    expect(recovery.limitation).toContain('commonly unloaded by phones to free memory');
    expect(recovery.limitation).toContain('cannot confirm');
    // The page was hidden, so nothing interrupts the user's return.
    await expect(page.locator('#neconyan-crash-notice')).toHaveCount(0);

    mode.value = 'changed';
    await setVisibility(page, 'hidden');
    const reloaded = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() });
    await setVisibility(page, 'visible');
    await reloaded;
    mode.value = 'real';
    await waitForApp(page);

    const evidence = await page.evaluate(async () => (await import('/scripts/scratchpad/evidence-gather.js')).gatherAppEvidence());
    const start = evidence.indexOf('### Page reloads and restarts in this browser');
    expect(start).toBeGreaterThan(-1);
    const section = evidence.slice(start).split('\n\n')[0];
    expect(section).toMatch(/Neconyan reloaded this page to load an update \([0-9a-f]{7,} -> deadbeef\)/);
    expect(section).toContain('The previous page ended without closing normally; it was hidden at its last sign of life (hidden for 30 minutes by then); that was 20 minutes before this reopening');
    expect(section).toContain('Stay open in the background: stopped while the page was hidden');
    expect(section).toContain('The cause was not recorded.');
    expect(section).toContain('commonly unloaded by phones to free memory, which this record cannot confirm');
    expect(section.indexOf('Neconyan reloaded this page')).toBeLessThan(section.indexOf('The previous page ended'));
});
