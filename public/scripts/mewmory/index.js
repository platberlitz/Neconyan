import {
    characters, chat_metadata, flushPendingChatSaves, getChatGeneration, getCurrentChatId,
    getRequestHeaders, this_chid,
} from '../../script.js';
import { selected_group } from '../group-chats.js';
import { eventSource, event_types } from '../events.js';
import { getFriendlyTokenizerName } from '../tokenizers.js';
import { conversationState } from '../neconyan-conversation/state.js';
import { cancelJob } from '../jobs.js';
import { uuidv4 } from '../utils.js';

export const mewmory = {
    config: null, view: null, stories: [], error: '', loading: false, busy: false, backfilling: false, preparing: false,
};
let initialized = false;
let timer;
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

export async function changeMewmory(route, data = {}) {
    const locator = getMewmoryLocator();
    const scope = getMewmoryScope();
    const result = await requestMewmory(route, { locator, revision: mewmory.view?.revision, ...data });
    if (scope === getMewmoryScope()) {
        if (result.locator && (!mewmory.view || result.revision >= mewmory.view.revision)) mewmory.view = result;
        if (result.config && (!mewmory.config || result.config.revision >= mewmory.config.revision)) mewmory.config = result.config;
        mewmory.error = '';
        notifyMewmory();
    }
    return result;
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
        mewmory.busy = false;
        mewmory.backfilling = false;
        mewmory.view = null;
        mewmory.error = '';
        mewmory.filters = {};
        void refreshMewmory();
        scheduleUpdate();
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
        eventSource.on(event, () => scheduleUpdate());
    }
    window.addEventListener('mewmory:configured', () => { void refreshMewmory(); scheduleUpdate(); });
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
        if (!await flushPendingChatSaves({ silent: true })) throw new Error('This chat has unsaved changes. Save it, then send again so Mewmory can add memories.');
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
        if (getChatGeneration() !== generation || getMewmoryScope() !== currentKey) throw new Error('The active chat changed while memories were being picked. Send again.');
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
        if (!plainText.replace(/\r/g, '').includes(block.replace(/\r/g, ''))) throw new Error('Your prompt settings removed the memories Mewmory added, so nothing was sent. Check that your prompt template keeps the Mewmory block.');
    }
    const serialized = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    const counted = await requestMewmory('tokens', { texts: [serialized], tokenizer: context.tokenizer }, { signal });
    if (counted.counts[0] > tokenBudget) {
        throw new Error('The memories plus the recent chat are too long for this model. Raise the context size, lower Selected memory budget, tokens, or use Catch up on this whole chat in Mewmory so older messages can be left out safely.');
    }
    await requestMewmory('validate', { locator: context.locator, fingerprint: context.validationFingerprint }, { signal });
}
