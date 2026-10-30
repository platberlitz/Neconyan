import {
    characters, chat, chat_metadata, flushPendingChatSaves, getChat, getChatGeneration, getCurrentChatId,
    getRequestHeaders, saveChatConditional, saveMetadata, this_chid,
} from '../../script.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { getGroupChat, selected_group } from '../group-chats.js';
import { getRoleplaySourceId, roleplayAccountStamp } from '../roleplay-save-chain.js';
import { eventSource, event_types } from '../events.js';
import { getFriendlyTokenizerName } from '../tokenizers.js';
import { overflowFingerprint, overflowPlan, visibleMessageIndices } from './overflow-policy.js';
import { flushMewmoryConfigAutosave } from './config-autosave.js';
import { conversationState } from '../neconyan-conversation/state.js';
import { cancelJob } from '../jobs.js';
import { uuidv4 } from '../utils.js';
import { getPreparedMewmoryContext, setPreparedMewmoryContext } from '../extensions/in-chat-agents/agent-context-macros.js';
import { isAgentWorkPending, waitForAgentWorkIdle } from '../extensions/in-chat-agents/agent-work-state.js';
import { t, translate } from '../i18n.js';
import { hasRestrictedGroupHistory } from '../group-chat-visibility.js';
import { MEWMORY_CATCH_UP_TIMEOUT_MS, observeMewmoryCatchUp } from './catch-up.js';

export const mewmory = {
    config: null, view: null, stories: [], error: '', loading: false, busy: false, backfilling: false, preparing: false,
};
const NEW_CHAT_MARK = 'mewmory_new_chat';
let initialized = false;
let timer;
let viewKey = '';
let selectionVersion = 0;
let refreshVersion = 0;
let latestRefresh;
let pendingEnable;
let autoHiding = false;
let restoringVisibility = false;
let pendingDisable = null;

export function getMewmoryLocator() {
    if (conversationState.conversationWorkspaceOpen) return null;
    const chat = getCurrentChatId();
    const avatar = characters[this_chid]?.avatar;
    if (!chat || (!selected_group && !avatar)) return null;
    return { chat: String(chat), avatar: selected_group ? '' : avatar, group: Boolean(selected_group) };
}

const key = locator => JSON.stringify(locator);
export const getMewmoryScope = () => key([getMewmoryLocator(), getChatGeneration(), selectionVersion]);

export function notifyMewmory() {
    window.dispatchEvent(new CustomEvent('mewmory:updated'));
    const state = mewmory.error ? 'Needs attention' : mewmory.loading ? 'Loading' : mewmory.busy || mewmory.preparing ? 'Updating memories'
        : mewmory.view?.enabled ? 'Up to date' : 'Off';
    const label = t`Mewmory: ${translate(state)}`;
    for (const button of document.querySelectorAll('[data-neconyan-route="mewmory"], [data-sb-tab="mewmory"]')) {
        button.dataset.mewmoryStatus = state;
        button.title = label;
        button.setAttribute('aria-label', label);
        const icon = button.querySelector('i');
        icon?.classList.toggle('fa-brain', !mewmory.error);
        icon?.classList.toggle('fa-triangle-exclamation', Boolean(mewmory.error));
    }
}

export async function requestMewmory(route, data = {}, { signal, scope = getMewmoryScope() } = {}) {
    if (scope !== getMewmoryScope()) throw new Error('The active chat changed.');
    if (route === 'recall' || route === 'index') data = { background: true, submissionKey: uuidv4(), ...data };
    const response = await fetch('/api/mewmory/' + route, {
        method: 'POST', headers: getRequestHeaders(), signal,
        body: JSON.stringify({ locator: getMewmoryLocator(), ...data }),
    });
    const result = await response.json().catch(() => ({}));
    if (scope !== getMewmoryScope()) throw new Error('The active chat changed.');
    if (!response.ok) throw Object.assign(new Error(result.error || 'Mewmory could not reach the server. Check your connection and try again.'), { status: response.status });
    if (result.job) scheduleUpdate();
    return result;
}

export function refreshMewmory(filters = mewmory.filters || {}, options = {}) {
    const scope = getMewmoryScope();
    const pending = refreshCurrentChat(filters, options).then(view => scope === getMewmoryScope() && latestRefresh !== pending ? latestRefresh : view);
    latestRefresh = pending;
    return pending;
}

async function refreshCurrentChat(filters, { signal }) {
    mewmory.filters = filters;
    const locator = getMewmoryLocator();
    const currentKey = getMewmoryScope();
    const version = ++refreshVersion;
    const current = () => currentKey === getMewmoryScope() && version === refreshVersion;
    if (viewKey !== currentKey) {
        mewmory.view = null;
        mewmory.error = '';
        viewKey = currentKey;
    }
    mewmory.loading = Boolean(locator);
    notifyMewmory();
    try {
        const config = await requestMewmory('config/get', {}, { signal, scope: currentKey });
        if (!current()) return null;
        if (!mewmory.config || config.config.revision >= mewmory.config.revision) mewmory.config = config.config;
        mewmory.stories = config.stories;
        const view = locator ? await requestMewmory('inspect', { locator, ...filters }, { signal, scope: currentKey }) : null;
        if (!current()) return null;
        if (!view || !mewmory.view || view.revision >= mewmory.view.revision) mewmory.view = view;
        mewmory.error = '';
        return view;
    } catch (error) {
        if (current()) mewmory.error = error.message;
        return null;
    } finally {
        if (current()) {
            mewmory.loading = false;
            const processing = mewmory.view?.health?.processing;
            mewmory.busy = processing?.status === 'running' || Boolean(mewmory.view?.operations?.some(job => ['queued', 'running'].includes(job.state)));
            mewmory.backfilling = Boolean(processing?.status === 'running' && processing.all);
            if (processing?.status === 'failed') mewmory.error = processing.error;
            const operation = mewmory.view?.operations?.[0];
            if (['failed', 'interrupted'].includes(operation?.state)) mewmory.error = operation.error?.message || 'Memory processing needs attention.';
            notifyMewmory();
            if (mewmory.busy) scheduleUpdate();
        }
    }
}

export async function changeMewmory(route, data = {}, { scope = getMewmoryScope(), signal } = {}) {
    const locator = getMewmoryLocator();
    const disabling = route === 'enabled' && data.enabled === false;
    let request = { locator, revision: mewmory.view?.revision, ...data };
    if (disabling) {
        if (!await flushPendingChatSaves({ silent: true })) throw new Error('This chat has unsaved changes. Save it before turning off Mewmory.');
        if (scope !== getMewmoryScope()) throw new Error('The active chat changed.');
        if (!pendingDisable || pendingDisable.scope !== scope) pendingDisable = {
            scope, operationKey: uuidv4(), branchId: mewmory.view?.branchId, account: roleplayAccountStamp().account,
            sourceInstanceId: getRoleplaySourceId(locator),
        };
        if (!pendingDisable.sourceInstanceId) throw new Error('Reload this chat before turning off Mewmory.');
        request = { ...request, ...pendingDisable };
        delete request.scope;
        restoringVisibility = true;
    }
    let result;
    try {
        result = await requestMewmory(route, request, { scope, signal });
    } catch (error) {
        if (disabling && scope === getMewmoryScope()) await refreshMewmory();
        throw error;
    } finally {
        if (disabling) restoringVisibility = false;
    }
    if (scope === getMewmoryScope()) {
        if (result.locator && (!mewmory.view || result.revision >= mewmory.view.revision)) mewmory.view = result;
        if (result.config && (!mewmory.config || result.config.revision >= mewmory.config.revision)) mewmory.config = result.config;
        mewmory.error = '';
        notifyMewmory();
    }
    if (disabling && scope === getMewmoryScope()) {
        pendingDisable = null;
        await refreshRestoredChat(locator, result.visibilityRestore?.instanceId);
    }
    return result;
}

/** Reload the saved result without navigating through a path that saves the old buffer. */
async function refreshRestoredChat(locator, instanceId = '') {
    const stamp = roleplayAccountStamp();
    const version = selectionVersion;
    const generation = getChatGeneration();
    const group = selected_group;
    // Both direct readers emit CHAT_CHANGED once after replacing the saved chat.
    const current = () => (selectionVersion === version || selectionVersion === version + 1) && getChatGeneration() === generation + 1
        && key(getMewmoryLocator()) === key(locator) && roleplayAccountStamp() === stamp;
    const options = { navigationGuard: current, expectedSourceId: instanceId || '', switchMenu: false };
    const loaded = locator.group
        ? await getGroupChat(group, true, { ...options, readOnlyRoute: true })
        : await getChat({ ...options, exactChat: locator.chat });
    if (loaded === false || !current()) throw new Error('Messages were restored, but this chat could not be refreshed. Reload it to see them.');
    await refreshMewmory();
}

export async function retryMewmoryVisibilityRestore() {
    const scope = getMewmoryScope();
    const locator = getMewmoryLocator();
    if (!locator) throw new Error('Open the chat whose messages need restoring.');
    if (!await flushPendingChatSaves({ silent: true })) throw new Error('This chat has unsaved changes. Save it before retrying.');
    restoringVisibility = true;
    try {
        const result = await requestMewmory('visibility/restore', { locator }, { scope });
        if (result.visibilityRestore?.status !== 'complete') throw new Error('Mewmory could not finish restoring messages. Try again.');
        pendingDisable = null;
        await refreshRestoredChat(locator, result.visibilityRestore?.instanceId);
        return true;
    } finally {
        restoringVisibility = false;
    }
}

export async function stopMewmoryBackfill() {
    const scope = getMewmoryScope();
    try {
        await Promise.all((mewmory.view?.operations || []).filter(job => ['queued', 'running'].includes(job.state)).map(job => cancelJob(job.id)));
        await requestMewmory('process/cancel', {}, { scope });
        if (scope === getMewmoryScope()) await refreshMewmory();
    } catch (error) {
        if (scope === getMewmoryScope()) {
            mewmory.error = error.message;
            notifyMewmory();
        }
    }
}

function currentHidingPolicy() {
    return JSON.stringify([mewmory.config?.autoHideTokens, mewmory.config?.writerTokenizer,
        getFriendlyTokenizerName(), Boolean(mewmory.config?.autoHide), Boolean(mewmory.view?.enabled),
        mewmory.view?.lastDisableId || '', mewmory.config?.historyMode, mewmory.config?.excludeHistory,
        mewmory.config?.recentMessages, mewmory.config?.historyBatchMessages]);
}

function currentChatSnapshot() {
    return { scope: getMewmoryScope(), messages: chat.slice(), fingerprint: overflowFingerprint(chat),
        policy: currentHidingPolicy(), lastDisableId: mewmory.view?.lastDisableId || '' };
}

function isSameChatSnapshot(snapshot) {
    return Boolean(snapshot) && snapshot.scope === getMewmoryScope()
        && snapshot.policy === currentHidingPolicy()
        && snapshot.messages.length === chat.length
        && snapshot.fingerprint === overflowFingerprint(chat)
        && snapshot.messages.every((message, index) => chat[index] === message);
}

async function countMessages(texts, scope) {
    if (!texts.length) return [];
    const result = await requestMewmory('tokens', { texts, tokenizer: getFriendlyTokenizerName() }, { scope });
    if (!Array.isArray(result?.counts) || result.counts.length !== texts.length
        || result.counts.some(count => !Number.isFinite(count) || count < 0)) {
        throw new Error('Mewmory could not count this chat with your writer tokenizer. Check Writer tokenizer in Mewmory settings, then try again.');
    }
    return result.counts;
}

/**
 * Counts one snapshot of the chat with the Mewmory writer tokenizer. `changed`
 * reports that a message was edited, added, deleted or reloaded, or that another
 * chat became active, while the count was running; such a plan is never applied.
 */
async function getOverflowPlan(limit, scope = getMewmoryScope()) {
    const snapshot = currentChatSnapshot();
    if (!(limit > 0)) return { limit, indices: [], snapshot, changed: false };
    if (scope !== getMewmoryScope()) return { limit, indices: [], snapshot, changed: true };
    const visible = visibleMessageIndices(snapshot.messages);
    const counts = await countMessages(visible.map(index => String(snapshot.messages[index]?.mes ?? '')), scope);
    if (scope !== getMewmoryScope() || !isSameChatSnapshot(snapshot)) {
        return { limit, indices: [], snapshot, changed: true };
    }
    return { ...overflowPlan(snapshot.messages, limit, counts), totalTokens: counts.reduce((total, count) => total + count, 0), snapshot, changed: false };
}

/**
 * Older visible messages to hide because the visible history reached Mewmory's
 * saved hiding trigger. The latest AI reply and anything after it always stay;
 * hidden messages are skipped and count for nothing.
 */
export async function getOverflowMessages(limit = mewmory.config?.autoHideTokens) {
    const plan = await getOverflowPlan(limit);
    return { limit: plan.limit, indices: plan.changed ? [] : plan.indices };
}

async function hideMessages(indices, snapshot, scope, automatic = false) {
    if (!indices.length || scope !== getMewmoryScope() || !isSameChatSnapshot(snapshot)) return 0;
    return hideMessageWindow(scope, automatic, snapshot.lastDisableId);
}

/** Both policies delegate the decision to the protected server save. */
async function hideMessageWindow(scope, automatic = false, lastDisableId = mewmory.view?.lastDisableId || '') {
    const locator = getMewmoryLocator();
    if (!locator || scope !== getMewmoryScope() || restoringVisibility) return 0;
    const before = chat.map(message => ({ isSystem: Boolean(message.is_system), id: message.mewmory_id,
        date: message.send_date, name: message.name, user: message.is_user }));
    const saved = await saveChatConditional({ mewmoryHidePolicy: { type: automatic ? 'automatic' : 'manual',
        lastDisableId }, skipUnchanged: false, throwOnError: true });
    if (!saved || scope !== getMewmoryScope()) return 0;
    await refreshRestoredChat(locator);
    return chat.reduce((total, message, index) => {
        const prior = before[index];
        return total + Number(Boolean(prior && !prior.isSystem && message.is_system && message.extra?.mewmoryKeepHidden
            && prior.id === message.mewmory_id && prior.date === message.send_date
            && prior.name === message.name && prior.user === message.is_user));
    }, 0);
}

export async function hideOverflowMessages({ limit } = {}) {
    const scope = getMewmoryScope();
    const flushed = await flushMewmoryConfigAutosave();
    if (scope !== getMewmoryScope()) return 0;
    if (!flushed.ok) {
        toastr.error('Mewmory settings could not be saved before hiding old messages: '
            + (flushed.error || 'the settings in the Mewmory panel are incomplete.'));
        return 0;
    }
    if (!mewmory.config) {
        await refreshMewmory();
        if (scope !== getMewmoryScope()) return 0;
    }
    if (mewmory.config?.historyMode === 'messages') {
        if (!mewmory.config.excludeHistory) {
            toastr.info('Turn on leaving older messages out of replies before hiding them.');
            return 0;
        }
        return hideMessageWindow(scope);
    }
    const value = limit ?? mewmory.config?.autoHideTokens;
    if (!(value > 0)) {
        toastr.error('Set Hide older messages when the visible chat reaches, tokens in Mewmory settings before hiding old messages.');
        return 0;
    }
    const plan = await getOverflowPlan(value, scope);
    if (plan.changed) {
        toastr.warning('The chat or hiding settings changed while Mewmory counted, so nothing was hidden.');
        return 0;
    }
    if (!plan.indices.length) {
        toastr.info(plan.totalTokens >= value
            ? 'This chat reached the hiding trigger, but no older messages can be hidden safely. The latest reply and messages after it stay visible.'
            : 'The visible history of this chat has not reached your Mewmory hiding trigger of '
                + value.toLocaleString() + ' tokens yet, so nothing needs hiding.');
        return 0;
    }
    const answer = await new Popup('This chat reached your Mewmory hiding trigger of ' + value.toLocaleString() + ' tokens. Hide all '
        + plan.indices.length + ' older visible ' + (plan.indices.length === 1 ? 'message' : 'messages')
        + ' in one go? The latest reply and any messages after it stay visible, and counting starts again from what remains. '
        + 'Mewmory keeps reading the hidden messages, so their memories stay. You can unhide them any time with the eye button on a message.',
    POPUP_TYPE.CONFIRM).show();
    if (answer !== POPUP_RESULT.AFFIRMATIVE) return 0;
    const again = await getOverflowPlan(value, scope);
    if (again.changed || !isSameChatSnapshot(plan.snapshot) || JSON.stringify(again.indices) !== JSON.stringify(plan.indices)) {
        toastr.warning('The chat or hiding settings changed while the question was open, so nothing was hidden.');
        return 0;
    }
    const hidden = await hideMessages(again.indices, again.snapshot, scope);
    if (hidden) toastr.success('Hid ' + hidden + ' older ' + (hidden === 1 ? 'message' : 'messages') + ' from the prompt.');
    return hidden;
}

/**
 * After a reply, refreshes the chat's Mewmory view and, once the visible history
 * reaches the saved hiding trigger, hides every older eligible message in one
 * pass. Only runs where Mewmory is on, so the hidden messages stay remembered.
 */
export async function hideOverflowAutomatically({ refresh = false, limit } = {}) {
    if (autoHiding || restoringVisibility || !getMewmoryLocator()) return 0;
    const scope = getMewmoryScope();
    autoHiding = true;
    try {
        if (refresh || !mewmory.config) {
            await refreshMewmory();
            if (scope !== getMewmoryScope()) return 0;
        }
        if (!mewmory.config?.autoHide) return 0;
        if (!mewmory.view && mewmory.error) {
            toastr.error('Could not hide older messages automatically: ' + mewmory.error);
            return 0;
        }
        const flushed = await flushMewmoryConfigAutosave();
        if (scope !== getMewmoryScope()) return 0;
        if (!flushed.ok) {
            toastr.error('Could not hide older messages automatically because Mewmory settings were not saved: '
                + (flushed.error || 'the settings in the Mewmory panel are incomplete.'));
            return 0;
        }
        if (!mewmory.config?.autoHide) return 0;
        const locator = getMewmoryLocator();
        if (!mewmory.view || JSON.stringify(mewmory.view.locator) !== JSON.stringify(locator)) {
            await refreshMewmory();
            if (scope !== getMewmoryScope()) return 0;
        }
        if (!mewmory.view?.enabled || !mewmory.config?.autoHide) return 0;
        // Hiding reloads the chat, which cancels agents still working on it.
        while (isAgentWorkPending()) {
            if (!await waitForAgentWorkIdle({ isCancelled: () => scope !== getMewmoryScope() })) return 0;
            await refreshMewmory();
            if (scope !== getMewmoryScope() || !mewmory.view?.enabled || !mewmory.config?.autoHide) return 0;
        }
        if (mewmory.config.historyMode === 'messages') {
            if (!mewmory.config.excludeHistory) return 0;
            return await hideMessageWindow(scope, true);
        }
        const value = limit ?? mewmory.config.autoHideTokens;
        if (!(value > 0)) return 0;
        const plan = await getOverflowPlan(value, scope);
        if (plan.changed) {
            toastr.warning('The chat or hiding settings changed while Mewmory counted, so older messages were not hidden automatically.');
            return 0;
        }
        if (!plan.indices.length) return 0;
        const hidden = await hideMessages(plan.indices, plan.snapshot, scope, true);
        if (hidden) {
            toastr.info('Hid ' + hidden + ' older ' + (hidden === 1 ? 'message' : 'messages') + ' after reaching '
                + value.toLocaleString() + ' tokens. Mewmory still remembers them.');
        }
        return hidden;
    } catch (error) {
        if (scope === getMewmoryScope()) toastr.error('Could not hide older messages automatically: ' + error.message);
        return 0;
    } finally {
        autoHiding = false;
    }
}

function stopPendingEnableWait() {
    if (!pendingEnable) return;
    pendingEnable.waitController.abort();
    pendingEnable.waitController = new AbortController();
}

function awaitPendingEnable(scope = getMewmoryScope(), signal) {
    const active = pendingEnable;
    if (active?.scope !== scope || active.timedOut || signal?.aborted) return Promise.resolve(false);
    const waitSignal = active.waitController.signal;
    return new Promise(resolve => {
        let timerId;
        const done = (value = false) => {
            clearTimeout(timerId);
            waitSignal.removeEventListener('abort', onAbort);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => done(false);
        timerId = setTimeout(() => {
            active.timedOut = true;
            stopPendingEnableWait();
            done(false);
        }, 15000);
        timerId.unref?.();
        waitSignal.addEventListener('abort', onAbort, { once: true });
        signal?.addEventListener('abort', onAbort, { once: true });
        active.promise.then(done, () => done(false));
    });
}

async function runEnableMewmoryForNewChat(view, scope = getMewmoryScope()) {
    const current = () => scope === getMewmoryScope();
    if (!current() || chat_metadata[NEW_CHAT_MARK] || chat.filter(message => message.is_user).length > 1) return false;
    if (!view) view = await refreshMewmory();
    const metadata = chat_metadata;
    if (!current() || !mewmory.config?.enableNewChats || !view || view.enabled || metadata[NEW_CHAT_MARK]
        || chat.filter(message => message.is_user).length > 1) return false;
    try {
        try {
            await changeMewmory('enabled', { enabled: true, revision: view.revision }, { scope });
        } catch (error) {
            if (error?.status !== 409 || !current()) throw error;
            view = await refreshMewmory();
            if (!current()) return false;
            if (!view) throw new Error(mewmory.error || error.message);
            if (!view.enabled) await changeMewmory('enabled', { enabled: true, revision: view.revision }, { scope });
        }
        if (!current()) return false;
        metadata[NEW_CHAT_MARK] = true;
        await saveMetadata();
        if (!current()) return false;
        window.dispatchEvent(new Event('mewmory:configured'));
        return true;
    } catch (error) {
        if (current()) {
            mewmory.error = error.message;
            notifyMewmory();
        }
        return false;
    }
}

const currentView = () => !mewmory.view?.locator || mewmory.view.locator.chat === getMewmoryLocator()?.chat ? mewmory.view : null;

/**
 * Switches Mewmory on once in a chat the user has just started, when Settings asks for every new chat.
 * The chat keeps a mark, so switching Mewmory off afterwards sticks.
 */
export async function enableMewmoryForNewChat(view, scope = getMewmoryScope()) {
    if (pendingEnable?.scope === scope) return awaitPendingEnable(scope);
    if (scope !== getMewmoryScope() || currentView()?.enabled || chat_metadata[NEW_CHAT_MARK]
        || mewmory.config?.enableNewChats === false || chat.filter(message => message.is_user).length > 1) {
        return false;
    }
    const promise = runEnableMewmoryForNewChat(view, scope).finally(() => {
        if (pendingEnable?.promise === promise) pendingEnable = null;
    });
    pendingEnable = { scope, promise, waitController: new AbortController(), timedOut: false };
    return awaitPendingEnable(scope);
}

export async function processMewmory({ all = false, checkpoint = false } = {}) {
    if (mewmory.busy) return;
    const locator = getMewmoryLocator();
    if (!locator || !mewmory.view?.enabled) return;
    const currentKey = getMewmoryScope();
    mewmory.busy = true;
    mewmory.backfilling = all;
    notifyMewmory();
    try {
        if (!await flushPendingChatSaves({ silent: true })) throw new Error('This chat has unsaved changes. Save it, then update Mewmory.');
        if (getMewmoryScope() !== currentKey) return;
        const view = await requestMewmory('process', { locator, checkpoint, all, background: true });
        if (getMewmoryScope() === currentKey) {
            if (!mewmory.view || view.revision >= mewmory.view.revision) mewmory.view = view;
            mewmory.error = '';
        }
    } catch (error) {
        if (getMewmoryScope() === currentKey) {
            mewmory.error = error.message;
        }
    } finally {
        if (getMewmoryScope() === currentKey) {
            mewmory.busy = mewmory.view?.health?.processing?.status === 'running';
            mewmory.backfilling = mewmory.busy && mewmory.view.health.processing.all;
            notifyMewmory();
            scheduleUpdate();
        }
    }
}

function scheduleUpdate(delay = 1500) {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
        if (getMewmoryLocator()) await refreshMewmory();
        const health = mewmory.view?.health;
        const pending = mewmory.config?.excludeHistory ? health?.checkpointPending : health?.pending;
        const waiting = mewmory.view?.enabled && mewmory.config?.autoUpdate && mewmory.config?.roles?.extractor?.enabled
            && pending > 0 && !['failed', 'cancelled'].includes(health?.processing?.status);
        if (mewmory.busy || waiting) scheduleUpdate(mewmory.busy ? 1500 : 15000);
    }, delay);
}

export function initMewmory() {
    if (initialized) return;
    initialized = true;
    const changed = () => {
        selectionVersion++;
        stopPendingEnableWait();
        pendingEnable = null;
        mewmory.busy = false;
        mewmory.backfilling = false;
        mewmory.view = null;
        mewmory.error = '';
        mewmory.filters = {};
        void refreshMewmory();
        scheduleUpdate();
    };
    const created = () => { void enableMewmoryForNewChat(); };
    eventSource.on(event_types.CHAT_CHANGED, changed);
    eventSource.on(event_types.CHAT_RENAMED, changed);
    window.addEventListener('sb:conversation-workspace-state-changed', changed);
    for (const event of [
        event_types.GENERATION_ENDED, event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED, event_types.MESSAGE_SWIPE_DELETED, event_types.MESSAGE_DELETED,
        event_types.MESSAGE_SENT, event_types.CHARACTER_EDITED, event_types.CHARACTER_DELETED, event_types.WORLDINFO_UPDATED,
        event_types.WORLDINFO_SETTINGS_UPDATED, event_types.WORLDINFO_DELETED,
    ]) {
        eventSource.on(event, () => scheduleUpdate());
    }
    eventSource.on(event_types.GENERATION_STARTED, (_type, options, dryRun) => {
        if (!dryRun && pendingEnable?.scope === getMewmoryScope() && !pendingEnable.timedOut) {
            return awaitPendingEnable(pendingEnable.scope, options?.signal);
        }
    });
    eventSource.on(event_types.GENERATION_STOPPED, stopPendingEnableWait);
    eventSource.on(event_types.GENERATION_ENDED, () => void hideOverflowAutomatically({ refresh: true }));
    eventSource.on(event_types.CHAT_CREATED, created);
    eventSource.on(event_types.GROUP_CHAT_CREATED, created);
    // Chats without a greeting never announce themselves, so their first message counts as the start.
    eventSource.on(event_types.MESSAGE_SENT, async () => {
        const active = pendingEnable?.scope === getMewmoryScope() ? pendingEnable : null;
        if (active) {
            if (active.timedOut) return;
            const waitSignal = active.waitController.signal;
            await awaitPendingEnable(active.scope);
            if (active.timedOut || waitSignal.aborted) return;
        }
        if (currentView()?.enabled || chat_metadata[NEW_CHAT_MARK] || mewmory.config?.enableNewChats === false
            || chat.filter(message => message.is_user).length !== 1) return;
        return enableMewmoryForNewChat();
    });
    window.addEventListener('mewmory:configured', () => { void refreshMewmory(); scheduleUpdate(); });
    scheduleUpdate();
}

export function syncMewmoryMacroUse(context) {
    if (context?.locator?.chat && getMewmoryScope() === context.scope) context.mewmoryMacrosUsed = Boolean(getPreparedMewmoryContext(context.locator.chat)?.mewmoryMacrosUsed);
}

export function updatePreparedMewmoryPresentation(context) {
    if (context?.locator?.chat && getMewmoryScope() === context.scope) setPreparedMewmoryContext(context.locator.chat, context);
}

export async function prepareMewmoryGeneration(messages, { signal, mewmoryCatchUpOverride } = {}) {
    const locator = getMewmoryLocator();
    setPreparedMewmoryContext(null, null);
    // Chat-wide records cannot prove which scene participants heard their sources.
    if (hasRestrictedGroupHistory()) return { enabled: false, chat: messages };
    if (!locator) return { enabled: false, chat: messages };
    const generation = getChatGeneration();
    const currentKey = getMewmoryScope();
    mewmory.preparing = true;
    notifyMewmory();
    try {
        if (pendingEnable?.scope === currentKey && !pendingEnable.timedOut) await awaitPendingEnable(currentKey, signal);
        if (!await flushPendingChatSaves({ silent: true })) throw new Error('This chat has unsaved changes. Save it, then send again so Mewmory can add memories.');
        if (getChatGeneration() !== generation || getMewmoryScope() !== currentKey) throw new Error('The active chat changed.');
        const view = await refreshMewmory(undefined, { signal });
        if (getMewmoryScope() !== currentKey) throw new Error('The active chat changed.');
        if (!view) throw new Error(mewmory.error || 'Mewmory could not read this chat. Try again.');
        if (!view.enabled) return { enabled: false, chat: messages };
        const tokenizer = getFriendlyTokenizerName();
        const input = {
            locator, tokenizer, integrity: chat_metadata.integrity,
            ...(mewmoryCatchUpOverride ? { mewmoryCatchUpOverride } : {}),
            history: messages.filter(message => Number.isInteger(message.mewmorySourceIndex)).map(message => ({
                index: message.mewmorySourceIndex, text: String(message.name || '') + ': ' + String(message.mes || ''),
            })),
        };
        let result = await requestMewmory('prepare', input, { signal });
        if (result.waiting) {
            if (!result.extractorEnabled || mewmory.config?.roles?.extractor?.error) {
                throw Object.assign(new Error('Enable and configure Facts and events to record older messages, or reply now with the extra original messages.'), { code: 'MEWMORY_WAIT_FAILED' });
            }
            const snapshot = result.waitSnapshot;
            const toast = toastr.info('Waiting for memory before replying…', 'Mewmory', { timeOut: 0, extendedTimeOut: 0 });
            try {
                await observeMewmoryCatchUp({ snapshot, deadline: Date.now() + MEWMORY_CATCH_UP_TIMEOUT_MS, signal,
                    check: async (captured, { signal: requestSignal }) => {
                        result = await requestMewmory('prepare', { ...input, mewmoryWaitSnapshot: captured }, { signal: requestSignal });
                        return { ready: !result.waiting, pending: result.pending, processing: result.processing };
                    },
                    start: async (_captured, { signal: requestSignal }) => requestMewmory('process',
                        { locator, all: true, checkpoint: true, background: true }, { signal: requestSignal }),
                    onProgress: status => {
                        if (Number.isSafeInteger(status.pending)) toast?.find('.toast-message').text('Waiting for memory before replying… ' + status.pending + ' older messages still need recording.');
                    },
                });
            } catch (error) {
                if (signal?.aborted) throw Object.assign(new Error('Stopped waiting for memory.'), { code: 'MEWMORY_WAIT_ABORTED' });
                if (!signal?.aborted && !error.code) error.code = 'MEWMORY_WAIT_FAILED';
                throw error;
            } finally {
                if (toast) toastr.clear(toast);
            }
        }
        if (getChatGeneration() !== generation || getMewmoryScope() !== currentKey) throw new Error('The active chat changed while memories were being picked. Send again.');
        const excluded = new Set(result.excludedIndices);
        mewmory.error = result.inspection?.error || result.inspection?.indexError || '';
        mewmory.view.preview = result;
        mewmory.view.previewCurrent = true;
        setPreparedMewmoryContext(locator.chat, result);
        return { ...result, locator, tokenizer, scope: currentKey, chat: messages.filter(message => !excluded.has(message.mewmorySourceIndex)) };
    } catch (error) {
        if (getMewmoryScope() === currentKey) mewmory.error = error.message;
        throw error;
    } finally {
        mewmory.preparing = false;
        notifyMewmory();
    }
}

export async function validateMewmoryGeneration(context, prompt, tokenBudget, { signal } = {}) {
    if (!context?.enabled) return;
    try {
        const plainText = typeof prompt === 'string' ? prompt : prompt.map(message => typeof message.content === 'string'
            ? message.content : JSON.stringify(message.content)).join('\n');
        for (const block of [context.npcText, context.memoryText].filter(Boolean)) {
            if (!plainText.replace(/\r/g, '').includes(block.replace(/\r/g, ''))) throw new Error('Your prompt settings removed the memories Mewmory added, so nothing was sent. Check that your prompt template keeps the Mewmory block.');
        }
        const serialized = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
        const counted = await requestMewmory('tokens', { texts: [serialized], tokenizer: context.tokenizer }, { signal });
        const total = counted?.counts?.[0];
        if (!Number.isSafeInteger(total) || total < 0) throw new Error('Mewmory could not count the prepared prompt. Check the token counter for replies, then try again.');
        if (total > tokenBudget) {
            const waiting = context.history?.waitingForPreservation
                ? ' Older messages have not been fully remembered, so they remain in the prompt.' : '';
            throw new Error('Mewmory counted ' + total.toLocaleString('en-GB') + ' tokens in the prepared prompt, but only '
                + tokenBudget.toLocaleString('en-GB') + ' fit before the reply. ' + waiting.trimStart()
                + (waiting ? ' ' : '') + 'Increase the context size if your model supports it, reduce ‘Space for recalled memories, tokens’, or update memories for the whole chat.');
        }
        await requestMewmory('validate', { locator: context.locator, fingerprint: context.validationFingerprint }, { signal });
    } catch (error) {
        if (!signal?.aborted) toastr.error(error.message, 'Mewmory');
        throw error;
    }
}
