import {
    characters, chat_metadata, flushPendingChatSaves, getChatGeneration, getCurrentChatId,
    getRequestHeaders, is_send_press, this_chid,
} from '../../script.js';
import { is_group_generating, selected_group } from '../group-chats.js';
import { eventSource, event_types } from '../events.js';
import { getFriendlyTokenizerName } from '../tokenizers.js';
import { conversationState } from '../neconyan-conversation/state.js';

export const mewmory = {
    config: null, view: null, stories: [], error: '', loading: false, busy: false, backfilling: false, preparing: false,
};
let initialized = false;
let timer;
let failures = 0;
let stopRequested = false;
let viewKey = '';
let selectionVersion = 0;
let refreshVersion = 0;
let latestRefresh;

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
    const state = mewmory.error ? 'Needs attention' : mewmory.loading ? 'Loading' : mewmory.busy || mewmory.preparing ? 'Processing'
        : mewmory.view?.enabled ? 'Current' : 'Off';
    for (const button of document.querySelectorAll('[data-neconyan-route="mewmory"], [data-sb-tab="mewmory"]')) {
        button.dataset.mewmoryStatus = state;
        button.title = 'Mewmory: ' + state;
        button.setAttribute('aria-label', 'Mewmory: ' + state);
        const icon = button.querySelector('i');
        icon?.classList.toggle('fa-brain', !mewmory.error);
        icon?.classList.toggle('fa-triangle-exclamation', Boolean(mewmory.error));
    }
}

export async function requestMewmory(route, data = {}, { signal, scope = getMewmoryScope() } = {}) {
    if (scope !== getMewmoryScope()) throw new Error('The active chat changed.');
    const response = await fetch('/api/mewmory/' + route, {
        method: 'POST', headers: getRequestHeaders(), signal,
        body: JSON.stringify({ locator: getMewmoryLocator(), ...data }),
    });
    const result = await response.json().catch(() => ({}));
    if (scope !== getMewmoryScope()) throw new Error('The active chat changed.');
    if (!response.ok) throw Object.assign(new Error(result.error || 'Mewmory could not reach the server.'), { status: response.status });
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
            notifyMewmory();
        }
    }
}

export async function changeMewmory(route, data = {}) {
    const locator = getMewmoryLocator();
    const scope = getMewmoryScope();
    const result = await requestMewmory(route, { locator, revision: mewmory.view?.revision, ...data });
    if (scope === getMewmoryScope()) {
        if (result.locator && (!mewmory.view || result.revision >= mewmory.view.revision)) mewmory.view = result;
        if (result.config && (!mewmory.config || result.config.revision >= mewmory.config.revision)) mewmory.config = result.config;
        mewmory.error = '';
        failures = 0;
        notifyMewmory();
    }
    return result;
}

export function stopMewmoryBackfill() {
    stopRequested = true;
    mewmory.backfilling = false;
    notifyMewmory();
}

export async function processMewmory({ all = false, checkpoint = false } = {}) {
    if (mewmory.busy) return;
    const locator = getMewmoryLocator();
    if (!locator || !mewmory.view?.enabled) return;
    const currentKey = getMewmoryScope();
    mewmory.busy = true;
    mewmory.backfilling = all;
    stopRequested = false;
    notifyMewmory();
    try {
        if (!await flushPendingChatSaves({ silent: true })) throw new Error('Save this chat before updating Mewmory.');
        do {
            if (getMewmoryScope() !== currentKey) break;
            const view = await requestMewmory('process', { locator, checkpoint });
            if (getMewmoryScope() !== currentKey) break;
            if (!mewmory.view || view.revision >= mewmory.view.revision) mewmory.view = view;
            mewmory.error = '';
            failures = 0;
            notifyMewmory();
            if (!(checkpoint ? view.health.checkpointPending : view.health.pending)) break;
        } while (all && !stopRequested);
    } catch (error) {
        if (getMewmoryScope() === currentKey) {
            failures++;
            mewmory.error = error.message;
        }
    } finally {
        mewmory.busy = false;
        mewmory.backfilling = false;
        notifyMewmory();
    }
}

function scheduleUpdate({ resetFailures = false } = {}) {
    if (resetFailures) failures = 0;
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
        if (is_send_press || is_group_generating || mewmory.preparing || mewmory.busy) {
            scheduleUpdate();
            return;
        }
        try {
            await refreshMewmory();
            if (!mewmory.view?.enabled || !mewmory.config?.autoUpdate || failures >= 3) return;
            // ponytail: automatic batches also review preservation, without a second pass that holds up chat.
            const checkpoint = mewmory.config.excludeHistory;
            const pending = () => checkpoint ? mewmory.view?.health.checkpointPending : mewmory.view?.health.pending;
            if (pending()) {
                await processMewmory({ checkpoint });
                if (pending() && failures < 3) scheduleUpdate();
            }
        } catch (error) {
            mewmory.error = error.message;
            notifyMewmory();
        }
    }, 1500 * Math.max(1, 2 ** failures));
}

export function initMewmory() {
    if (initialized) return;
    initialized = true;
    const changed = () => {
        selectionVersion++;
        stopMewmoryBackfill();
        mewmory.view = null;
        mewmory.error = '';
        mewmory.filters = {};
        void refreshMewmory();
        scheduleUpdate({ resetFailures: true });
    };
    eventSource.on(event_types.CHAT_CHANGED, changed);
    eventSource.on(event_types.CHAT_RENAMED, changed);
    window.addEventListener('sb:conversation-workspace-state-changed', changed);
    for (const event of [
        event_types.GENERATION_ENDED, event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED, event_types.MESSAGE_SWIPE_DELETED, event_types.MESSAGE_DELETED,
        event_types.MESSAGE_SENT, event_types.CHARACTER_EDITED, event_types.CHARACTER_DELETED, event_types.WORLDINFO_UPDATED,
        event_types.WORLDINFO_SETTINGS_UPDATED, event_types.WORLDINFO_DELETED,
    ]) {
        eventSource.on(event, () => scheduleUpdate({ resetFailures: true }));
    }
    window.addEventListener('mewmory:configured', () => scheduleUpdate({ resetFailures: true }));
    scheduleUpdate();
}

export async function prepareMewmoryGeneration(messages, { signal } = {}) {
    const locator = getMewmoryLocator();
    if (!locator) return { enabled: false, chat: messages };
    const generation = getChatGeneration();
    const currentKey = getMewmoryScope();
    mewmory.preparing = true;
    notifyMewmory();
    try {
        if (!await flushPendingChatSaves({ silent: true })) throw new Error('Mewmory needs a saved source before preparing memory.');
        if (getChatGeneration() !== generation || getMewmoryScope() !== currentKey) throw new Error('The active chat changed.');
        const view = await refreshMewmory(undefined, { signal });
        if (getMewmoryScope() !== currentKey) throw new Error('The active chat changed.');
        if (!view) throw new Error(mewmory.error || 'Mewmory could not read this chat. Try again.');
        if (!view.enabled) return { enabled: false, chat: messages };
        const tokenizer = getFriendlyTokenizerName();
        const result = await requestMewmory('prepare', {
            locator, tokenizer, integrity: chat_metadata.integrity,
            history: messages.filter(message => Number.isInteger(message.mewmorySourceIndex)).map(message => ({
                index: message.mewmorySourceIndex, text: String(message.name || '') + ': ' + String(message.mes || ''),
            })),
        }, { signal });
        if (getChatGeneration() !== generation || getMewmoryScope() !== currentKey) throw new Error('The active chat changed during recall.');
        const excluded = new Set(result.excludedIndices);
        mewmory.error = result.inspection?.error || result.inspection?.indexError || '';
        mewmory.view.preview = result;
        mewmory.view.previewCurrent = true;
        return { ...result, locator, tokenizer, chat: messages.filter(message => !excluded.has(message.mewmorySourceIndex)) };
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
    const plainText = typeof prompt === 'string' ? prompt : prompt.map(message => typeof message.content === 'string'
        ? message.content : JSON.stringify(message.content)).join('\n');
    for (const block of [context.npcText, context.memoryText].filter(Boolean)) {
        if (!plainText.replace(/\r/g, '').includes(block.replace(/\r/g, ''))) throw new Error('Mewmory reference context was removed by prompt formatting. Check your prompt settings.');
    }
    const serialized = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    const counted = await requestMewmory('tokens', { texts: [serialized], tokenizer: context.tokenizer }, { signal });
    if (counted.counts[0] > tokenBudget) {
        throw new Error('Mewmory and the retained chat exceed this model’s input limit. Raise the context size, reduce the memory budget, or finish backfill in Mewmory.');
    }
    await requestMewmory('validate', { locator: context.locator, fingerprint: context.validationFingerprint }, { signal });
}
