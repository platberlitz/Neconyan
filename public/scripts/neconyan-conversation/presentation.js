/**
 * Present server-owned Conversation completions at most once per tab set.
 *
 * A native job records an unread bump and a `branch.pendingPresentations` entry
 * in the same store write as the message. This module claims those entries from
 * the server; the claim is the atomic deletion of the entry, so exactly one tab
 * wins an entry and presents it. Everything here only reads the merged store and
 * posts a claim; it never generates or delivers content.
 */
import { getRequestHeaders } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';
import {
    getConversationGroupById,
    getConversationStore,
    getConversationThreadStore,
    isConversationThreadKeyForPersona,
    parseConversationThreadKey,
} from './context.js';
import {
    isConversationActiveThread,
    notifyNewConversationMessage,
    updateConversationNotificationIndicators,
} from './notifications.js';
import { isConversationGroupSpeakerEligible } from './partners-utils.js';
import { schedulePalsRailRender } from './render-scheduler.js';
import { beginConversationNarration, narrateConversationMessage, playConversationNarration } from './tts.js';

const CLAIM_ENDPOINT = '/api/neconyan-conversation/presentation/claim';
// ponytail: a claim older than this is consumed silently (the unread badge is the
// durable signal); it only stops a reopened page replaying days-old alerts.
const PRESENT_MAX_AGE_MS = 5 * 60 * 1000;
const CLAIM_TIMEOUT_MS = 30000;
// Ids this tab already asked the server to consume, so repeated readbacks before
// the merge lands cannot re-post them. Bounded: clearing it only costs a claim
// that the server resolves as already-won.
const claimedLocally = new Set();
const CLAIMED_LOCALLY_MAX = 200;
const refusedNotices = new Set();
const reading = new Map();
const activePresentations = new Map();

async function postClaim(target, messageIds, readThrough, account) {
    const response = await fetch(CLAIM_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json', 'X-Neconyan-Account': account },
        body: JSON.stringify({ target, messageIds, readThrough }),
        signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (account !== getCurrentUserHandle()) return null;
    if (!response.ok) {
        return null;
    }
    return body && typeof body === 'object' ? body : null;
}

/** Record only the messages this page has actually observed. */
export async function markConversationBranchRead(avatar, { branchId, groupId = '', personaId } = {}) {
    const account = getCurrentUserHandle();
    const thread = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    branchId ||= thread?.activeBranchId;
    const branch = thread?.branches?.[branchId];
    const readThrough = branch?.messages?.at(-1)?.id;
    if (!readThrough || branch.readThrough === readThrough) return;
    const target = { avatar, groupId, personaId, branchId, createdAt: branch.createdAt };
    const key = JSON.stringify([account, target, readThrough]);
    if (reading.has(key)) return reading.get(key);
    const request = postClaim(target, [], readThrough, account).then(claimed => {
        if (!claimed) return;
        const live = getConversationThreadStore(avatar, { create: false, groupId, personaId })?.branches?.[branchId];
        if (live?.createdAt !== target.createdAt || live.messages?.at(-1)?.id !== readThrough) return;
        const changed = live.unread !== claimed.unread;
        live.readThrough = claimed.readThrough;
        live.unread = claimed.unread;
        updateConversationNotificationIndicators();
        if (changed) schedulePalsRailRender();
    }).catch(error => console.warn('Conversation Mode: read acknowledgement failed', error))
        .finally(() => reading.delete(key));
    reading.set(key, request);
    return request;
}

async function narrate(record, message, isStillVisible, token) {
    if (!record) {
        return;
    }
    if (record.status === 'ready') {
        // The claim response can arrive after the user hid the page or switched
        // threads, so re-check the visibility decision before playing.
        if (typeof isStillVisible === 'function' && !isStillVisible()) {
            return 'cancelled';
        }
        // A false result means Stop, a thread change, or a missing player; stop the batch.
        return (await playConversationNarration(record, message, isStillVisible, token)) === false ? 'cancelled' : undefined;
    }
    if (record.status === 'browser') {
        return (await narrateConversationMessage(message, { isStillVisible, token })) === false ? 'cancelled' : undefined;
    }
    if (record.status === 'refused') {
        // One notice per provider per session; the per-message Speak button still works.
        const noticeKey = `${record.code}:${record.provider || ''}`;
        if (refusedNotices.has(noticeKey)) {
            return;
        }
        refusedNotices.add(noticeKey);
        const provider = record.provider || 'This provider';
        globalThis.toastr?.warning?.(`Automatic narration is unavailable: ${provider} speech runs only in a browser. Use Speak on a message to hear it.`);
        return;
    }
    if (record.status === 'failed') {
        console.warn('Conversation Mode: automatic narration failed', record.error);
    }
}

/** Claim and present this account's pending Conversation completions. */
export async function presentPendingConversationClaims(account = getCurrentUserHandle()) {
    if (account !== getCurrentUserHandle()) return;
    if (claimedLocally.size > CLAIMED_LOCALLY_MAX) claimedLocally.clear();
    const tasks = [];
    for (const key of Object.keys(getConversationStore().characters || {})) {
        if (!isConversationThreadKeyForPersona(key)) continue;
        // Serialise a thread's branches, but a stalled download cannot block other threads.
        const lock = JSON.stringify([account, key]);
        const active = activePresentations.get(lock);
        if (active) { active.again = true; continue; }
        const state = { again: false };
        activePresentations.set(lock, state);
        tasks.push((async () => {
            do {
                state.again = false;
                const thread = getConversationStore().characters?.[key];
                for (const branchId of Object.keys(thread?.branches || {})) {
                    if (account !== getCurrentUserHandle() || !isConversationThreadKeyForPersona(key)) break;
                    await presentBranch(account, key, branchId);
                }
            } while (state.again && account === getCurrentUserHandle());
        })().catch(error => console.warn('Conversation Mode: presentation failed', error))
            .finally(() => { activePresentations.delete(lock); updateConversationNotificationIndicators(); }));
    }
    await Promise.all(tasks);
}

async function presentBranch(account, key, branchId) {
    const { avatar, groupId, personaId } = parseConversationThreadKey(key);
    if (!avatar) return;
    const options = { branchId, groupId, personaId };
    const liveBranch = () => getConversationThreadStore(avatar, { create: false, groupId, personaId })?.branches?.[branchId];
    const branch = liveBranch();
    const pending = branch?.pendingPresentations;
    const viewing = isConversationActiveThread(avatar, groupId, options);
    if (viewing && globalThis.document?.visibilityState !== 'visible') return;
    const ids = Object.keys(pending || {}).filter(id => !claimedLocally.has(id));
    if (!ids.length) {
        // Another tab can claim without reading; discovery still retries the visible boundary.
        if (viewing) await markConversationBranchRead(avatar, options);
        return;
    }
    const createdAt = branch.createdAt;
    const messages = (branch.messages || []).map(message => ({ ...message, extra: { ...message.extra } }));
    const readThrough = viewing ? messages.at(-1)?.id : undefined;
    // Capture Stop before awaiting a claim, including a thread opened during that wait.
    const token = ids.some(id => ['ready', 'browser'].includes(pending[id]?.narration?.status)) ? beginConversationNarration() : null;
    try {
        const claimed = await postClaim({ avatar, groupId, personaId, branchId, createdAt }, ids, readThrough, account);
        if (!claimed) return;
        for (const id of ids) claimedLocally.add(id);
        if (readThrough && liveBranch()?.createdAt === createdAt && liveBranch().messages?.at(-1)?.id === readThrough) {
            liveBranch().readThrough = claimed.readThrough;
            liveBranch().unread = claimed.unread;
        }
        for (const id of ids) {
            if (account !== getCurrentUserHandle() || !isConversationThreadKeyForPersona(key) || token?.isCurrent() === false) break;
            if (!Object.hasOwn(claimed.won || {}, id)) continue;
            const message = messages.find(item => item.id === id);
            if (!message) continue;
            const fresh = () => Date.now() - Number(pending[id]?.at || 0) < PRESENT_MAX_AGE_MS;
            const sourceCurrent = () => {
                const live = liveBranch();
                const saved = live?.messages?.find(item => item.id === id);
                return live?.createdAt === createdAt && saved?.mes === message.mes && saved?.role === message.role
                    && saved?.name === message.name && saved?.extra?.display_text === message.extra.display_text
                    && saved?.extra?.partner_avatar === message.extra.partner_avatar
                    && (!groupId || isConversationGroupSpeakerEligible(getConversationGroupById(groupId, { personaId }), message.extra.partner_avatar || avatar));
            };
            if (!fresh() || !sourceCurrent()) continue;
            if (viewing || isConversationActiveThread(avatar, groupId, options)) {
                const stillVisible = () => account === getCurrentUserHandle() && isConversationThreadKeyForPersona(key)
                    && isConversationActiveThread(avatar, groupId, options) && globalThis.document?.visibilityState === 'visible'
                    && token?.isCurrent() !== false && sourceCurrent();
                if (!stillVisible()) break;
                const record = claimed.won[id] ?? pending[id]?.narration;
                if (['ready', 'browser'].includes(record?.status) && !token) continue;
                const outcome = await narrate(record, message, () => stillVisible() && fresh(), token);
                // Expiry or a failed download skips one entry; Stop/navigation cancels the batch.
                if (outcome === 'cancelled' && !stillVisible()) break;
            } else {
                notifyNewConversationMessage(avatar, message, true, options);
            }
        }
    } finally {
        token?.end();
    }
}
