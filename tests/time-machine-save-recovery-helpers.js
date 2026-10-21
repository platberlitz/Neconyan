/* global window */
import { expect } from '@playwright/test';

export const EXTENSION = '/scripts/extensions/third-party/Neconyan-Time-Machine';
export const MODULE_NAME = 'NeconyanCardTimeMachine';
export const ATTACHMENT_KEY = '__Neconyan-Card-Time-Machine__';
export const CAPTURE_KIND = 'time-machine-capture';
export const RECOVERY_DEADLINE_MS = 10000;
export const CONFLICT_TITLE = 'Settings changed on another device';
export const S1 = 'mesIDDisplay_enabled';
export const S2 = 'timer_enabled';
export const S3 = 'timestamps_enabled';

const SENTINELS = [S1, S2, S3];

function tmSummary(settingsLike) {
    const module = settingsLike?.extension_settings?.[MODULE_NAME];
    const attachments = settingsLike?.extension_settings?.character_attachments?.[ATTACHMENT_KEY];
    return module ? {
        snapshots: Array.isArray(module.snapshots) ? module.snapshots.length : null,
        lastCommit: typeof module.lastCommit === 'string' ? module.lastCommit : null,
        captureCharacters: module.captureCharacters ?? null,
        keepPerTarget: module.keepPerTarget ?? null,
        lorebookProbeRows: Array.isArray(module.snapshots)
            ? module.snapshots.filter(row => row?.kind === 'lorebook' && row?.target === 'TM probe book').length
            : null,
        attachments: Array.isArray(attachments) ? attachments.length : null,
    } : null;
}

function sentinelSummary(settingsLike) {
    return Object.fromEntries(SENTINELS.map(key => [key, settingsLike?.power_user?.[key] ?? null]));
}

/** Record settings-save status and metadata only, never private setting contents. */
export function trackSettingsSaves(page) {
    const saves = [];
    page.on('request', request => {
        if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/settings/save') return;
        const entry = { seq: saves.length + 1, status: null, sentAt: Date.now(), doneAt: null };
        try {
            const body = JSON.parse((request.postDataBuffer() ?? Buffer.alloc(0)).toString('utf8'));
            Object.assign(entry, { version: body._version ?? null, settingsRevision: body._settingsRevision ?? null,
                sentinels: sentinelSummary(body), tm: tmSummary(body) });
        } catch {
            entry.parseError = true;
        }
        saves.push(entry);
        request.__tmSave = entry;
    });
    page.on('response', async response => {
        const entry = response.request().__tmSave;
        if (!entry) return;
        entry.status = response.status();
        entry.doneAt = Date.now();
        try {
            const body = await response.json();
            Object.assign(entry, { responseVersion: body.version ?? null, responseSettingsRevision: body.settingsRevision ?? null });
        } catch { /* metadata only */ }
    });
    return saves;
}

/** Collect only Time Machine save failures, without dumping console contents. */
export function watchTimeMachineErrors(page) {
    const errors = [];
    page.on('console', message => {
        if (['error', 'warning'].includes(message.type()) && /Time Machine|COMMIT_UNCONFIRMED|STALE_INDEX/.test(message.text())) {
            errors.push(message.type());
        }
    });
    return errors;
}

function createHold(maxMs) {
    const hold = { active: false, released: false, autoReleased: false };
    let resolve;
    let timer = null;
    hold.promise = new Promise(done => { resolve = done; });
    hold.begin = () => {
        if (hold.active || hold.released) return;
        hold.active = true;
        timer = setTimeout(() => {
            if (hold.released) return;
            hold.autoReleased = true;
            hold.released = true;
            resolve();
        }, maxMs);
    };
    hold.release = () => {
        if (hold.released) return;
        hold.released = true;
        if (timer) clearTimeout(timer);
        resolve();
    };
    return hold;
}

/**
 * Bounded gates on the real operations endpoints.
 * - first-terminal: hold only the first completed record read for capture keys.
 * - all-records: hold that response and every later read of the same key.
 * - holdSubmit: hold the capture submission before it reaches the server.
 * Timers start when the hold actually begins. Auto-release and failed fetches fail expectGateClean.
 */
export async function installOperationGate(page, { mode = 'first-terminal', holdSubmit = false, maxMs = 60000, fetchTimeoutMs = 30000 } = {}) {
    const resultHold = createHold(maxMs);
    const submitHold = createHold(maxMs);
    const gate = { captureKeys: new Set(), held: [], records: [], submitHeld: false, submitKey: null,
        firstRecord: null, completedKey: null, fetchFailures: [], submitFailures: [] };
    Object.defineProperties(gate, {
        released: { get: () => resultHold.released },
        autoReleased: { get: () => resultHold.autoReleased || submitHold.autoReleased },
    });
    gate.release = () => resultHold.release();
    gate.releaseSubmit = () => submitHold.release();

    await page.route('**/api/operations/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const isSubmit = request.method() === 'POST' && url.pathname === '/api/operations/submit';
        const isRecord = request.method() === 'GET' && /^\/api\/operations\/records\/[^/]+$/.test(url.pathname);
        if (!isSubmit && !isRecord) return route.fallback();

        if (isSubmit) {
            let body = {};
            try { body = JSON.parse(request.postData() || '{}'); } catch { /* not a capture */ }
            if (body.kind === CAPTURE_KIND && typeof body.key === 'string') {
                gate.captureKeys.add(body.key);
                gate.submitKey = body.key;
                if (holdSubmit && !submitHold.released && !submitHold.active) {
                    gate.submitHeld = true;
                    submitHold.begin();
                    await submitHold.promise;
                    gate.submitHeld = false;
                    try { return await route.continue(); } catch { gate.submitFailures.push('continue'); return undefined; }
                }
            }
            return route.fallback();
        }

        const key = decodeURIComponent(url.pathname.split('/').pop());
        if (!gate.captureKeys.has(key)) return route.fallback();
        const entry = { held: false };
        gate.records.push(entry);
        let response;
        try {
            response = await route.fetch({ timeout: fetchTimeoutMs });
        } catch {
            gate.fetchFailures.push('record');
            try { await route.abort('failed'); } catch { /* already gone */ }
            return undefined;
        }
        let record = null;
        try { record = await response.json(); } catch { /* not JSON */ }
        Object.assign(entry, { status: response.status(), state: record?.state ?? null, jobId: record?.jobId ?? null });
        const completed = record?.state === 'completed';
        let hold = false;
        if (!resultHold.released) {
            if (mode === 'first-terminal') hold = completed && !gate.firstRecord;
            else if (mode === 'all-records') hold = (completed && !gate.completedKey) || gate.completedKey === key;
        }
        if (completed && !gate.firstRecord) {
            gate.firstRecord = record;
            gate.completedKey = key;
        }
        if (!hold) {
            try { return await route.fulfill({ response }); } catch { return undefined; }
        }
        entry.held = true;
        gate.held.push(entry);
        resultHold.begin();
        await resultHold.promise;
        try { await route.fulfill({ response }); } catch { /* already gone */ }
        return undefined;
    });
    gate.dispose = () => {
        resultHold.release();
        submitHold.release();
    };
    return gate;
}

export function expectGateClean(...gates) {
    for (const gate of gates.filter(Boolean)) {
        expect(gate.fetchFailures, 'a gated server fetch failed').toEqual([]);
        expect(gate.submitFailures, 'a gated submission was not continued').toEqual([]);
        expect(gate.autoReleased, 'a gate was released by its safety timer').toBe(false);
    }
}

export async function settleSaves(saves, quietMs = 2500) {
    await expect.poll(() => {
        const inFlight = saves.some(entry => entry.status === null);
        const last = Math.max(0, ...saves.map(entry => entry.doneAt ?? entry.sentAt));
        return !inFlight && Date.now() - last >= quietMs;
    }, { timeout: 60000, intervals: [250], message: 'start-up settings saves did not settle' }).toBe(true);
}

export async function readServer(account) {
    const settings = JSON.parse((await account.post('/api/settings/get')).settings);
    return { version: settings._version, settingsRevision: settings._settingsRevision,
        sentinels: sentinelSummary(settings), tm: tmSummary(settings),
        index: { module: settings.extension_settings?.[MODULE_NAME] ?? null,
            attachments: settings.extension_settings?.character_attachments?.[ATTACHMENT_KEY] ?? null } };
}

/** The complete local Time Machine index and attachments, null-safe and cloned for exact comparison. */
export async function readLocalTimeMachine(page) {
    return page.evaluate(({ moduleName, attachmentKey }) => {
        const settings = window.SillyTavern.getContext().extensionSettings;
        return structuredClone({
            module: settings[moduleName] ?? null,
            attachments: settings.character_attachments?.[attachmentKey] ?? null,
        });
    }, { moduleName: MODULE_NAME, attachmentKey: ATTACHMENT_KEY });
}

export async function changeSettings(page, id, changes, { saveNow = true } = {}) {
    return page.evaluate(async ({ id, changes, saveNow }) => {
        const [{ power_user }, core] = await Promise.all([import('/scripts/power-user.js'), import('/script.js')]);
        window.__tmRecovery ??= { saves: {} };
        for (const [key, value] of Object.entries(changes)) power_user[key] = value;
        if (!saveNow) return { requested: false };
        const state = window.__tmRecovery.saves[id] = { state: 'pending' };
        core.saveSettings(0, { returnResult: true }).then(
            value => Object.assign(state, { state: 'resolved', value }),
            error => Object.assign(state, { state: 'rejected', name: error?.name ?? 'Error' }));
        return { requested: true };
    }, { id, changes, saveNow });
}

export const saveState = (page, id) => page.evaluate(id => window.__tmRecovery?.saves?.[id] ?? null, id);
export const powerUser = (page, key) => page.evaluate(async key => (await import('/scripts/power-user.js')).power_user[key], key);

export async function startCapture(page) {
    await page.evaluate(async extension => {
        const api = await import(extension + '/src/api.js');
        window.__tmRecovery ??= { saves: {} };
        const state = window.__tmRecovery.capture = { state: 'pending' };
        api.captureEverything().then(
            result => Object.assign(state, { state: 'resolved', taken: result?.taken ?? null }),
            error => Object.assign(state, { state: 'rejected', name: error?.name ?? 'Error' }));
    }, EXTENSION);
}

export const captureState = page => page.evaluate(() => window.__tmRecovery?.capture ?? null);

export async function waitForHeldRecord(page, gate, timeout = 150000) {
    await expect.poll(async () => {
        if (gate.fetchFailures.length) throw new Error('a gated record fetch failed');
        const capture = await captureState(page);
        if (capture && capture.state !== 'pending') throw new Error(`capture ended before its record was held: ${capture.state}`);
        return gate.firstRecord?.state === 'completed' && gate.held.some(entry => entry.state === 'completed');
    }, { timeout, intervals: [250], message: 'no completed capture record was observed and held' }).toBe(true);
    return gate.firstRecord;
}

export const conflictDialog = page => page.locator('dialog.popup[open]', { hasText: CONFLICT_TITLE });

export async function firstDialogMs(page, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await conflictDialog(page).isVisible()) return Date.now();
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
}

export function lastAcceptedRevision(saves, fallback) {
    const accepted = saves.filter(entry => entry.status === 200 && Number.isSafeInteger(entry.responseSettingsRevision)).at(-1);
    return accepted?.responseSettingsRevision ?? fallback;
}
