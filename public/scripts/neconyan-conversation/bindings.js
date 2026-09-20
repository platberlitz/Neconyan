import { getRequestHeaders, getActiveGenerationAcknowledgement, saveSettings } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';
import { assertConversationAccount, flushConversationStore } from './store-sync.js';

export async function requestConversationBinding(path, payload, account, signal) {
    assertConversationAccount(account);
    const response = await fetch(`/api/neconyan-conversation/${path}`, {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json', 'X-Neconyan-Account': account },
        body: JSON.stringify(payload),
    });
    const body = await response.json();
    assertConversationAccount(account);
    if (!response.ok) throw Object.assign(new Error(body.message || body.error || 'The saved connection could not be used.'), { status: response.status, body });
    return body;
}

/** An empty saved profile deliberately selects the acknowledged active connection. */
export async function preflightConversationBinding(scope, account = getCurrentUserHandle()) {
    if (!await flushConversationStore(account)) throw new Error('Conversation changes could not be saved. Try again before sending.');
    try {
        return await requestConversationBinding('binding/preflight', scope, account);
    } catch (error) {
        if (error.body?.error !== 'active_settings_ack_required') throw error;
        assertConversationAccount(account);
        if (!await saveSettings(0, { returnResult: true })) throw new Error('The active connection settings could not be saved. Your draft has been kept.');
        assertConversationAccount(account);
        const acknowledgement = getActiveGenerationAcknowledgement();
        return requestConversationBinding('binding/preflight', { ...scope, acknowledgement }, account);
    }
}
