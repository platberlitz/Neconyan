import {
    characters, chat_metadata, flushPendingChatSaves, getChatGeneration, getCurrentChatId,
    getRequestHeaders, is_send_press, this_chid,
} from '../../script.js';
import { is_group_generating, selected_group } from '../group-chats.js';
import { eventSource, event_types } from '../events.js';
import { getFriendlyTokenizerName } from '../tokenizers.js';
import { conversationState } from '../neconyan-conversation/state.js';

export const mewmory = {
    config: null, view: null, stories: [], error: '', busy: false, backfilling: false, preparing: false,
};
let initialized = false;
let timer;
let currentBatch = null;
let failures = 0;
let stopRequested = false;
let viewKey = '';

export function getMewmoryLocator() {
    if (conversationState.conversationWorkspaceOpen) return null;
    const chat = getCurrentChatId();
    const avatar = characters[this_chid]?.avatar;
    if (!chat || (!selected_group && !avatar)) return null;
    return { chat: String(chat), avatar: selected_group ? '' : avatar, group: Boolean(selected_group) };
}

const key = locator => JSON.stringify(locator);

export function notifyMewmory() {
    window.dispatchEvent(new CustomEvent('mewmory:updated'));
    const state = mewmory.error ? 'Needs attention' : mewmory.busy || mewmory.preparing ? 'Processing'
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

export async function requestMewmory(route, data = {}, { signal } = {}) {
    const response = await fetch('/api/mewmory/' + route, {
        method: 'POST', headers: getRequestHeaders(), signal,
        body: JSON.stringify({ locator: getMewmoryLocator(), ...data }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'Mewmory could not reach the server.'), { status: response.status });
    return result;
}

export async function refreshMewmory(filters = mewmory.filters || {}) {
    mewmory.filters = filters;
    const locator = getMewmoryLocator();
    const currentKey = key(locator);
    const config = await requestMewmory('config/get');
    mewmory.config = config.config;
    mewmory.stories = config.stories;
    if (viewKey !== currentKey) {
        mewmory.view = null;
        mewmory.error = '';
        viewKey = currentKey;
    }
    const existing = config.stories.some(story => key(story.locator) === currentKey);
    const inspecting = document.getElementById('mewmory-workspace')?.getClientRects().length > 0;
    if (locator && (existing || inspecting)) {
        try {
            const view = await requestMewmory('inspect', { locator, ...filters });
            if (key(getMewmoryLocator()) === currentKey) mewmory.view = view;
        } catch (error) {
            if (key(getMewmoryLocator()) === currentKey) mewmory.error = error.message;
        }
    } else mewmory.view = null;
    notifyMewmory();
    return mewmory.view;
}

export async function changeMewmory(route, data = {}) {
    const locator = getMewmoryLocator();
    const result = await requestMewmory(route, { locator, revision: mewmory.view?.revision, ...data });
    if (key(locator) === key(getMewmoryLocator())) {
        if (result.locator) mewmory.view = result;
        if (result.config) mewmory.config = result.config;
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
    if (mewmory.busy || mewmory.preparing) return;
    const locator = getMewmoryLocator();
    if (!locator || !mewmory.view?.enabled) return;
    const currentKey = key(locator);
    mewmory.busy = true;
    mewmory.backfilling = all;
    stopRequested = false;
    notifyMewmory();
    try {
        if (!await flushPendingChatSaves({ silent: true })) throw new Error('Save this chat before updating Mewmory.');
        do {
            if (key(getMewmoryLocator()) !== currentKey || mewmory.preparing) break;
            currentBatch = requestMewmory('process', { locator, checkpoint });
            const view = await currentBatch;
            currentBatch = null;
            if (key(getMewmoryLocator()) !== currentKey) break;
            mewmory.view = view;
            mewmory.error = '';
            failures = 0;
            notifyMewmory();
            if (!(checkpoint ? view.health.checkpointPending : view.health.pending)) break;
        } while (all && !stopRequested);
    } catch (error) {
        failures++;
        if (key(getMewmoryLocator()) === currentKey) mewmory.error = error.message;
    } finally {
        currentBatch = null;
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
            if (mewmory.view.health.pending) {
                await processMewmory();
                if (mewmory.view?.health.pending && failures < 3) scheduleUpdate();
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
    eventSource.on(event_types.CHAT_CHANGED, () => {
        stopMewmoryBackfill();
        mewmory.view = null;
        mewmory.error = '';
        notifyMewmory();
        scheduleUpdate({ resetFailures: true });
    });
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
    const currentKey = key(locator);
    mewmory.preparing = true;
    notifyMewmory();
    try {
        if (currentBatch) await currentBatch.catch(() => {});
        await refreshMewmory();
        if (!mewmory.view?.enabled) {
            const enabled = mewmory.stories.some(story => key(story.locator) === currentKey && story.enabled);
            if (enabled) throw new Error(mewmory.error || 'Mewmory could not read this chat.');
            return { enabled: false, chat: messages };
        }
        if (!await flushPendingChatSaves({ silent: true })) throw new Error('Mewmory needs a saved source before preparing memory.');
        if (getChatGeneration() !== generation || key(getMewmoryLocator()) !== currentKey) throw new Error('The active chat changed.');
        const tokenizer = getFriendlyTokenizerName();
        const result = await requestMewmory('prepare', {
            locator, tokenizer, integrity: chat_metadata.integrity,
            history: messages.filter(message => Number.isInteger(message.mewmorySourceIndex)).map(message => ({
                index: message.mewmorySourceIndex, text: String(message.name || '') + ': ' + String(message.mes || ''),
            })),
        }, { signal });
        if (getChatGeneration() !== generation || key(getMewmoryLocator()) !== currentKey) throw new Error('The active chat changed during recall.');
        const excluded = new Set(result.excludedIndices);
        mewmory.error = result.processingError || result.inspection?.error || result.inspection?.indexError || '';
        mewmory.view.preview = result;
        mewmory.view.previewCurrent = true;
        return { ...result, locator, tokenizer, chat: messages.filter(message => !excluded.has(message.mewmorySourceIndex)) };
    } catch (error) {
        mewmory.error = error.message;
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
    await requestMewmory('validate', { locator: context.locator, fingerprint: context.fingerprint }, { signal });
}
