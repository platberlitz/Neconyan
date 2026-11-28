import { t } from './i18n.js';
import { noteSaveFailure, showSaveFailureNotice } from './save-failure-notices.js';

// Says why a save failed, so a notice only blames the connection when Neconyan's server was really out of reach.
// 'unreachable': no reply from Neconyan's server (offline, dropped request, gateway 502/503/504 with no error body).
// 'verifying': an earlier save is still unconfirmed, so later saves wait for it.
// 'server': the server replied but could not finish the save.
// 'refused': the server turned the save down (4xx).
// 'stale': this tab no longer matches the signed-in account or the saved chat.
// 'changed': the saved copy changed elsewhere while a save was unconfirmed, so this tab stops saving to keep that change.
// 'local': something failed in this tab before or after the request.
export const SAVE_FAILURE_KINDS = Object.freeze(['unreachable', 'verifying', 'server', 'refused', 'stale', 'changed', 'local']);

// Causes that clear up on their own; their notices stand in for each other, so a flipping outage shows one toast.
const PASSING_KINDS = new Set(['unreachable', 'verifying', 'server']);

const NETWORK_ERROR = /failed to fetch|networkerror|network error|load failed|network request failed|fetch failed|err_network|err_internet_disconnected|connection (?:refused|reset)/i;
const GATEWAY_STATUSES = new Set([502, 503, 504]);

function hasServerError(data) {
    return Boolean(data) && typeof data === 'object' && (typeof data.error === 'string' || typeof data.error?.message === 'string');
}

function isOffline() {
    return globalThis.navigator?.onLine === false;
}

/**
 * Sorts a failed save into one of SAVE_FAILURE_KINDS.
 * @param {any} error Thrown error, if any
 * @param {{ status?: number, data?: any }|Response|null} [response] Failed reply, if any
 * @returns {'unreachable'|'verifying'|'server'|'refused'|'stale'|'changed'|'local'}
 */
export function saveFailureKind(error, response = null) {
    if (SAVE_FAILURE_KINDS.includes(error?.saveFailure)) {
        return error.saveFailure;
    }
    if (error?.code === 'ROLEPLAY_SAVE_UNCERTAIN') {
        return SAVE_FAILURE_KINDS.includes(error.reason) ? error.reason : 'verifying';
    }
    if (error?.code === 'ROLEPLAY_ACCOUNT_CHANGED' || error?.code === 'ROLEPLAY_READ_REQUIRED') {
        return 'stale';
    }
    const status = Number(response?.status ?? error?.status);
    if (Number.isInteger(status) && status >= 400) {
        const data = response && 'data' in response ? response.data : error?.data;
        if (GATEWAY_STATUSES.has(status) && !hasServerError(data)) {
            return 'unreachable';
        }
        if (status === 409 && (data?.error === 'account_changed')) {
            return 'stale';
        }
        if (status < 500 && status !== 408 && status !== 429) {
            return 'refused';
        }
        return 'server';
    }
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        return 'unreachable';
    }
    if (error instanceof TypeError && NETWORK_ERROR.test(String(error.message ?? ''))) {
        return 'unreachable';
    }
    if (error && isOffline()) {
        return 'unreachable';
    }
    return 'local';
}

/**
 * Notice text for a chat or group chat that could not be saved.
 * @param {string} kind One of SAVE_FAILURE_KINDS
 * @returns {string}
 */
export function chatSaveFailureMessage(kind) {
    switch (kind) {
        case 'unreachable':
            return t`Neconyan could not reach its server, so recent changes are not saved yet. Check your internet connection and keep this tab open. Neconyan tries again with your next change.`;
        case 'verifying':
            return t`Neconyan is still checking whether an earlier save went through, so recent changes are not saved yet. Keep this tab open. Neconyan tries again with your next change.`;
        case 'server':
            return t`Neconyan's server could not finish saving, so recent changes are not saved yet. Keep this tab open. Neconyan tries again with your next change.`;
        case 'refused':
            return t`Neconyan's server turned this save down, so the saved chat was left as it was. Reload the page to bring this tab up to date.`;
        case 'stale':
            return t`This tab is out of date for this account or chat, so recent changes were not saved. Reload the page to continue.`;
        case 'changed':
            return t`The saved copy of this chat changed somewhere else, so Neconyan stopped saving here to keep that change. Copy anything you need, then reload the page.`;
        default:
            return t`Something went wrong in this tab while saving, so recent changes may not be saved. Copy anything you need, then reload the page.`;
    }
}

/**
 * Notice text for settings, themes and presets that could not be saved.
 * @param {string} kind One of SAVE_FAILURE_KINDS
 * @returns {string}
 */
export function settingsSaveFailureMessage(kind) {
    switch (kind) {
        case 'unreachable':
            return t`Neconyan could not reach its server, so your changes are not saved. Check your internet connection, then try again.`;
        case 'server':
            return t`Neconyan's server could not save your changes. Wait a moment, then try again.`;
        case 'refused':
            return t`Neconyan's server turned these changes down, so nothing was saved. Reload the page, then try again.`;
        case 'stale':
        case 'changed':
            return t`This tab is out of date for this account, so your changes are not saved. Reload the page, then try again.`;
        default:
            return t`Something went wrong in this tab, so your changes are not saved. Reload the page, then try again.`;
    }
}

/**
 * Notice text for a deletion that did not happen because Neconyan's server did not confirm it.
 * @param {string} kind One of SAVE_FAILURE_KINDS
 * @returns {string}
 */
export function deletionSaveFailureMessage(kind) {
    switch (kind) {
        case 'unreachable':
            return t`Neconyan could not reach its server, so nothing was deleted. Check your internet connection, then try again.`;
        case 'verifying':
            return t`Neconyan is still checking whether an earlier save went through, so nothing was deleted. Wait a moment, then try again.`;
        case 'server':
            return t`Neconyan's server could not finish the change, so nothing was deleted. Wait a moment, then try again.`;
        case 'refused':
            return t`Neconyan's server turned the change down, so nothing was deleted. Reload the page, then try again.`;
        case 'stale':
            return t`This tab is out of date for this account or chat, so nothing was deleted. Reload the page to continue.`;
        case 'changed':
            return t`The saved copy of this chat changed somewhere else, so nothing was deleted. Reload the page to continue.`;
        default:
            return t`Something went wrong in this tab, so nothing was deleted. Reload the page, then try again.`;
    }
}

/**
 * Records why a chat save failed and, unless the caller reports it itself, shows one notice for it.
 * @param {string} key Chat notice key
 * @param {string} title Toast title
 * @param {{ error?: any, response?: any, notice?: string, quiet?: boolean }} [options]
 * @returns {string} The failure kind, for the caller to attach to what it throws
 */
export function reportChatSaveFailure(key, title, { error = null, response = null, notice = '', quiet = false } = {}) {
    const kind = saveFailureKind(error, response);
    noteSaveFailure(key, kind);
    if (!quiet) {
        const family = PASSING_KINDS.has(kind) && !notice ? 'not-saved-yet' : '';
        showSaveFailureNotice(key, notice || chatSaveFailureMessage(kind), title, undefined, undefined, { family });
    }
    return kind;
}

/**
 * Marks an error as already recorded and reported, so outer catches pass it on without a second notice.
 * @param {any} error Thrown error
 * @param {string} kind Failure kind
 * @returns {any} The same error
 */
export function markReportedSaveFailure(error, kind) {
    if (error && typeof error === 'object' && Object.isExtensible(error)) {
        Object.assign(error, { saveFailure: kind, saveFailureReported: true });
    }
    return error;
}
