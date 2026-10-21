/* global document, window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import {
    EXTENSION,
    RECOVERY_DEADLINE_MS,
    S1,
    S2,
    S3,
    captureState,
    changeSettings,
    conflictDialog,
    expectGateClean,
    firstDialogMs,
    installOperationGate,
    lastAcceptedRevision,
    powerUser,
    readLocalTimeMachine,
    readServer,
    saveState,
    settleSaves,
    startCapture,
    trackSettingsSaves,
    waitForHeldRecord,
    watchTimeMachineErrors,
} from './time-machine-save-recovery-helpers.js';

async function openChat(account) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    return page;
}

async function renderDrawer(page) {
    await page.evaluate(async extension => {
        const host = document.createElement('div');
        host.id = 'time-machine-save-recovery-settings';
        host.style.cssText = 'position:fixed;top:64px;right:8px;z-index:2147483000;background:#fff;color:#000;padding:8px;max-width:360px';
        document.body.append(host);
        (await import(extension + '/src/ui.js')).renderDrawer(host);
    }, EXTENSION);
}

test('direct recovery completes while terminal delivery is held and keeps local Time Machine edits', async ({ app }) => {
    test.setTimeout(300000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    let gate;
    try {
        const saves = trackSettingsSaves(page);
        const tmErrors = watchTimeMachineErrors(page);
        // Rendering initialises the Time Machine settings, so include it in the flush.
        await renderDrawer(page);
        await settleSaves(saves);
        expect(await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }))).toBe(true);
        const server = await readServer(account);
        const pageRevision = lastAcceptedRevision(saves, server.settingsRevision);
        gate = await installOperationGate(page, { mode: 'first-terminal', maxMs: 60000 });
        const before = { s1: await powerUser(page, S1), s2: await powerUser(page, S2), s3: await powerUser(page, S3) };

        await startCapture(page);
        const record = await waitForHeldRecord(page, gate);
        expect(record.state).toBe('completed');
        expect(record.result.previousSettingsRevision).toBe(pageRevision);
        const heldServer = await readServer(account);
        expect(heldServer.settingsRevision).toBe(record.result.settingsRevision);
        expect(heldServer.tm.lastCommit).toBe(record.result.module.lastCommit);

        const charactersSwitch = page.getByLabel('Snapshot characters when they are edited', { exact: true });
        await charactersSwitch.uncheck();
        const keep = page.getByLabel('Versions kept per item', { exact: true });
        await keep.fill('7');
        await keep.press('Tab');
        await expect(charactersSwitch).toBeDisabled();
        await expect(keep).toBeDisabled();

        await page.evaluate(async extension => {
            const api = await import(extension + '/src/api.js');
            const state = window.__tmRecovery.lorebook = { state: 'pending' };
            api.captureLorebook('TM probe book', { entries: { 0: { uid: 0, key: ['probe'], content: 'Queued during capture.' } } }, { force: true }).then(
                row => Object.assign(state, { state: 'resolved', row: row ? { kind: row.kind, target: row.target } : null }),
                error => Object.assign(state, { state: 'rejected', code: error?.code ?? null }),
            );
        }, EXTENSION);

        await changeSettings(page, 'collide', { [S1]: !before.s1 });
        await expect.poll(() => saveState(page, 'collide'), { timeout: RECOVERY_DEADLINE_MS + 5000, intervals: [100] })
            .toEqual({ state: 'resolved', value: true });
        expect(gate.held).toHaveLength(1);
        expect(gate.released).toBe(false);
        const collided = saves.filter(entry => entry.sentinels?.[S1] === !before.s1);
        const [refused, retry] = collided;
        expect(refused?.status).toBe(409);
        expect(retry?.status).toBe(200);
        expect(saves.filter(entry => entry.status === 409)).toHaveLength(1);
        expect(retry.version).toBe(record.result.version);
        expect(retry.settingsRevision).toBe(record.result.settingsRevision);
        expect(retry.tm.lastCommit).toBe(record.result.module.lastCommit);
        expect(retry.tm.snapshots).toBe(record.result.module.snapshots.length);
        expect(retry.tm.captureCharacters).toBe(false);
        expect(retry.tm.keepPerTarget).toBe(7);
        await expect(conflictDialog(page)).toHaveCount(0);

        await changeSettings(page, 'later', { [S2]: !before.s2 });
        await expect.poll(() => saveState(page, 'later'), { timeout: 10000 }).toEqual({ state: 'resolved', value: true });
        expect(gate.released).toBe(false);
        gate.release();
        await expect.poll(async () => (await captureState(page))?.state, { timeout: 60000 }).not.toBe('pending');
        expect((await captureState(page)).state).toBe('resolved');
        await expect(charactersSwitch).toBeEnabled({ timeout: 30000 });
        await expect(keep).toBeEnabled({ timeout: 30000 });
        await expect.poll(() => page.evaluate(() => window.__tmRecovery.lorebook.state), { timeout: 30000 }).not.toBe('pending');
        expect(await page.evaluate(() => window.__tmRecovery.lorebook)).toEqual({
            state: 'resolved', row: { kind: 'lorebook', target: 'TM probe book' },
        });

        await changeSettings(page, 'final', { [S3]: !before.s3 });
        await expect.poll(() => saveState(page, 'final'), { timeout: 10000 }).toEqual({ state: 'resolved', value: true });

        const after = await readServer(account);
        const local = await readLocalTimeMachine(page);
        expect(after.sentinels[S1]).toBe(!before.s1);
        expect(after.sentinels[S2]).toBe(!before.s2);
        expect(after.sentinels[S3]).toBe(!before.s3);
        expect(after.tm.captureCharacters).toBe(false);
        expect(after.tm.keepPerTarget).toBe(7);
        expect(after.tm.lorebookProbeRows).toBe(1);
        expect(after.tm.snapshots).toBe(record.result.module.snapshots.length + 1);
        expect(after.tm.lastCommit).not.toBe(record.result.module.lastCommit);
        expect(local).toEqual(after.index);
        expect(saves.filter(entry => entry.status === 409)).toHaveLength(1);
        expect(tmErrors).toEqual([]);
        await expect(page.locator('#toast-container .toast-error')).toHaveCount(0);
        await expect(conflictDialog(page)).toHaveCount(0);
        expectGateClean(gate);
    } finally {
        gate?.dispose();
    }
});

test('a held capture submission does not delay a settings save or a provider reply', async ({ app }) => {
    test.setTimeout(300000);
    const account = await app.account({ activeConnection: true });
    const page = await openChat(account);
    let gate;
    try {
        const saves = trackSettingsSaves(page);
        gate = await installOperationGate(page, { mode: 'none', holdSubmit: true, maxMs: 60000 });
        await settleSaves(saves);
        expect(await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }))).toBe(true);
        await startCapture(page);
        await expect.poll(() => gate.submitHeld, { timeout: 30000 }).toBe(true);
        const missing = await account.context.request.get(`${app.url}/api/operations/records/${encodeURIComponent(gate.submitKey)}`, {
            headers: account.headers,
        });
        expect(missing.status()).toBe(404);

        const s2 = await powerUser(page, S2);
        const saveStarted = Date.now();
        await changeSettings(page, 'generic', { [S2]: !s2 });
        await expect.poll(() => saveState(page, 'generic'), { timeout: 3000, intervals: [50] })
            .toEqual({ state: 'resolved', value: true });
        expect(Date.now() - saveStarted).toBeLessThan(3000);

        const callsBefore = app.provider.calls.length;
        app.provider.mode.reply = { choices: [{ message: { content: 'Reply while the capture submission is held.' } }] };
        await page.locator('#send_textarea').fill('Hello while Time Machine waits.');
        await page.evaluate(() => {
            window.__tmRecovery.reply = { state: 'pending' };
            import('/script.js').then(core => core.Generate('normal')).then(
                () => { window.__tmRecovery.reply.state = 'resolved'; },
                error => Object.assign(window.__tmRecovery.reply, { state: 'rejected', name: error?.name ?? 'Error' }),
            );
        });
        await expect.poll(() => app.provider.calls.length, { timeout: 15000 }).toBeGreaterThan(callsBefore);
        await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text'))
            .toHaveText('Reply while the capture submission is held.', { timeout: 15000 });
        expect(gate.submitHeld).toBe(true);
        expect((await captureState(page)).state).toBe('pending');

        gate.releaseSubmit();
        await expect.poll(async () => (await captureState(page))?.state, { timeout: 120000 }).not.toBe('pending');
        expect((await captureState(page)).state).toBe('resolved');
        await expect(conflictDialog(page)).toHaveCount(0);
        expect(saves.filter(entry => entry.status === 409)).toEqual([]);
        const server = await readServer(account);
        expect(server.sentinels[S2]).toBe(!s2);
        expect(server.tm.lastCommit).toMatch(/^server-/);
        expectGateClean(gate);
    } finally {
        gate?.dispose();
    }
});

test('held recovery reads give a bounded conflict and leave the complete local index untouched', async ({ app }) => {
    test.setTimeout(300000);
    const account = await app.account();
    const page = await account.open({ workspace: false });
    let gate;
    try {
        const saves = trackSettingsSaves(page);
        await settleSaves(saves);
        expect(await page.evaluate(async () => (await import('/script.js')).saveSettings(0, { returnResult: true }))).toBe(true);
        const server = await readServer(account);
        const pageRevision = lastAcceptedRevision(saves, server.settingsRevision);
        const localBefore = await readLocalTimeMachine(page);
        const s1 = await powerUser(page, S1);
        gate = await installOperationGate(page, { mode: 'all-records', maxMs: 90000 });

        await startCapture(page);
        const record = await waitForHeldRecord(page, gate);
        expect(record.state).toBe('completed');
        expect(record.result.previousSettingsRevision).toBe(pageRevision);
        const heldServer = await readServer(account);
        expect(heldServer.settingsRevision).toBe(record.result.settingsRevision);
        expect(heldServer.tm.lastCommit).toBe(record.result.module.lastCommit);

        await changeSettings(page, 'collide', { [S1]: !s1 });
        await expect.poll(() => saves.some(entry => entry.sentinels?.[S1] === !s1 && entry.status === 409), { timeout: 10000 }).toBe(true);
        const refused = saves.find(entry => entry.sentinels?.[S1] === !s1 && entry.status === 409);
        const dialogMs = await firstDialogMs(page, RECOVERY_DEADLINE_MS + 10000);
        expect(gate.records.filter(entry => entry.held).length).toBeGreaterThan(0);
        expect(dialogMs).not.toBeNull();
        expect(dialogMs - refused.doneAt).toBeGreaterThanOrEqual(RECOVERY_DEADLINE_MS - 2500);
        expect(dialogMs - refused.doneAt).toBeLessThanOrEqual(RECOVERY_DEADLINE_MS + 4000);
        expect(saves.filter(entry => entry.sentinels?.[S1] === !s1).map(entry => entry.status)).toEqual([409]);

        gate.release();
        await expect.poll(async () => (await captureState(page))?.state, { timeout: 60000 }).not.toBe('pending');
        const localAfter = await readLocalTimeMachine(page);
        const after = await readServer(account);
        expect(localAfter).toEqual(localBefore);
        await expect(conflictDialog(page)).toBeVisible();
        expect((await saveState(page, 'collide'))?.value === true).toBe(false);
        expect(after.sentinels[S1]).toBe(s1);
        expect(after.tm.lastCommit).toBe(record.result.module.lastCommit);
        expect(after.tm.snapshots).toBe(record.result.module.snapshots.length);
        expectGateClean(gate);
    } finally {
        gate?.dispose();
    }
});
