import { chat as messages, getRequestHeaders, getThumbnailUrl, scrollChatToBottom, updateMessageElement } from '../../script.js';
import { beginRoleplayReplacement } from './roleplay-replacement.js';
import { withAbortSignal } from '../abort.js';

const labels = {
    preparing: 'Preparing reply…', generating: 'Writing reply…', agents: 'Running Agents…',
    companions: 'Running Companions…', review: 'Waiting for your review…',
    translating: 'Translating reply…', speech: 'Preparing speech…', saving: 'Saving reply…',
};
const PREVIEW_SILENCE_MS = 5000;
// Companion notes share the saved job artifact's 16 MiB limit.
const MAX_PREVIEW_EVENT_LENGTH = 16 * 1024 * 1024;
const FOLLOWED_STAGES = new Set(['preparing', 'generating', 'agents']);

/** Display only: partial output never enters the chat array or a chat save. */
export function observeRoleplayPreview(jobId, { account, isCurrent, onTerminal, name, messageIndex }) {
    let node = null;
    let latest = null;
    let receivedAt = 0;
    let rendered = null;
    let childId = null;
    let startedAt = null;
    let stopped = false;
    let frozen = false;
    const diagnosticHandle = {};
    let diagnosticStage = null;
    const diagnostic = phase => { try { globalThis.NeconyanCrashDiagnostics?.observePhase?.(diagnosticHandle, phase); } catch { /* Optional diagnostics. */ } };
    let restoreReplacement = () => {};
    const remove = () => {
        if (node) {
            node.remove();
            document.dispatchEvent(new CustomEvent('neconyan:roleplay-preview-removed', { detail: { element: node } }));
        }
        node = null; rendered = null;
    };
    const render = () => {
        if (frozen) return;
        if (!isCurrent()) { remove(); restoreReplacement(); return; }
        if (!latest) return;
        const chat = document.querySelector('#chat');
        if (!chat) return;
        if (!chat.querySelector('[data-roleplay-replacement]')) {
            restoreReplacement = beginRoleplayReplacement(name, messageIndex, isCurrent);
        }
        const thinking = latest.stage === 'generating' && latest.reasoning && !latest.reasoning_finished;
        if (node?.isConnected && latest === rendered && !thinking) return;
        // Follow the reply while it is written; Agent and Companion output added after
        // that lands below the reader instead of pulling the page down to it.
        const nearBottom = FOLLOWED_STAGES.has(latest.stage || 'preparing')
            && chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
        if (childId !== latest.childId) {
            remove();
            childId = latest.childId;
            startedAt = new Date(latest.updatedAt || Date.now()).toISOString();
        }
        const reasoningDetails = node?.querySelector('.mes_reasoning_details');
        const message = { name: latest.name || 'Reply', is_user: false, is_system: false,
            mes: latest.text || '', send_date: startedAt, gen_started: latest.gen_started || startedAt, gen_finished: latest.gen_finished,
            original_avatar: latest.avatar,
            force_avatar: latest.avatar ? getThumbnailUrl('avatar', latest.avatar) : undefined,
            extra: { reasoning: latest.reasoning || '', inChatAgents: latest.inChatAgents,
                inChatAgentCompanionResults: latest.inChatAgentCompanionResults,
                api: latest.generation?.source, model: latest.generation?.model,
                token_count: latest.token_count, reasoning_tokens: latest.reasoning_tokens,
                reasoning_duration: typeof latest.reasoning_duration === 'number'
                    ? latest.reasoning_duration + (thinking ? Math.max(0, Date.now() - receivedAt) : 0) : undefined,
                ...(reasoningDetails && node.classList.contains('reasoning') ? { reasoning_collapsed: !reasoningDetails.open } : {}) } };
        const replacement = chat.querySelector('[data-roleplay-replacement]');
        const messageElement = updateMessageElement(message, { messageId: replacement ? Number(replacement.dataset.roleplayReplacement) : messages.length, isPreview: true,
            ...(node?.isConnected ? { messageElement: globalThis.jQuery(node) } : {}) });
        if (!node?.isConnected) {
            node = messageElement[0];
            node.id = 'neconyan-roleplay-preview';
            node.style.flexShrink = '0';
            node.setAttribute('aria-label', 'Reply in progress');
            const status = document.createElement('small');
            status.className = 'timestamp';
            status.setAttribute('role', 'status');
            node.querySelector('.name_text').parentElement.append(status);
            if (replacement) replacement.before(node);
            else chat.append(node);
        }
        node.querySelector('[role="status"]').textContent = labels[latest.stage] || labels.preparing;
        // Display-only decorators run before the browser paints. Saved-message
        // events would incorrectly treat this draft as part of the chat history.
        document.dispatchEvent(new CustomEvent('neconyan:roleplay-preview-rendered', { detail: { message, element: node } }));
        rendered = latest;
        // A live bottom landing must supersede resize anchors for older positions,
        // and honour the same automatic/manual scrolling policy as saved replies.
        if (nearBottom) scrollChatToBottom({ isNearBottom: nearBottom });
    };
    const hidden = () => document.visibilityState === 'hidden';
    let timer = hidden() ? null : setInterval(render, 500);
    let attempt = null;
    let wake = null;
    let reconnectRequested = false;
    // A backgrounded phone tab can lose its connection without an error, leaving
    // the reader waiting forever on a frozen preview. The server writes at least
    // once a second, so silence or a return to the page starts a fresh connection,
    // which begins with the server's current text and stage.
    const reconnect = () => {
        reconnectRequested = true;
        attempt?.abort();
        wake?.(); wake = null;
    };
    // Nobody reads a hidden preview, and receiving the growing reply several times
    // a second keeps a phone's radio and processor awake. Close the stream while
    // hidden; the job observer still notices the finish and reads the saved reply.
    const onVisible = () => {
        if (hidden()) {
            clearInterval(timer); timer = null;
            reconnect();
            return;
        }
        if (!timer && !frozen && !stopped) timer = setInterval(render, 500);
        reconnect();
    };
    document.addEventListener('visibilitychange', onVisible);
    globalThis.addEventListener?.('pageshow', reconnect);
    globalThis.addEventListener?.('online', reconnect);
    const run = async () => {
        while (!stopped) {
            if (hidden()) {
                await new Promise(resolve => { wake = resolve; });
                continue;
            }
            const current = new AbortController();
            attempt = current;
            reconnectRequested = false;
            let silence = null;
            const heard = () => { clearTimeout(silence); silence = setTimeout(() => current.abort(), PREVIEW_SILENCE_MS); };
            try {
                heard();
                const response = await withAbortSignal(fetch(`/api/jobs/${encodeURIComponent(jobId)}/preview`, {
                    headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account },
                    credentials: 'same-origin', signal: current.signal,
                }), current.signal);
                // A missing job has no preview to wait for; other refusals are retried.
                if (response.status === 404) return;
                if (!response.ok || !response.body) throw new Error(`Reply preview returned ${response.status}.`);
                const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
                try {
                    let pending = '';
                    let firstSnapshot = true;
                    while (!stopped) {
                        const chunk = await withAbortSignal(reader.read(), current.signal);
                        if (chunk.done) break;
                        heard();
                        pending += chunk.value;
                        if (pending.length > MAX_PREVIEW_EVENT_LENGTH) throw new Error('Reply preview exceeded its limit.');
                        let boundary;
                        while ((boundary = pending.indexOf('\n\n')) >= 0) {
                            const event = pending.slice(0, boundary);
                            pending = pending.slice(boundary + 2);
                            if (!event.startsWith('data: ')) continue;
                            const value = JSON.parse(event.slice(6));
                            // Use the regular display formatter at a bounded cadence, rather
                            // than rebuilding a growing Markdown message for every token.
                            if (value.preview) {
                                latest = value.preview; receivedAt = Date.now();
                                if (latest.stage !== diagnosticStage && isCurrent()) {
                                    diagnosticStage = latest.stage;
                                    diagnostic(({ preparing: 'preparing', generating: 'generating', agents: 'post-agents', companions: 'companions', review: 'waiting-review', saving: 'saving' })[diagnosticStage] || 'unknown');
                                }
                                if (firstSnapshot || !node) render();
                                firstSnapshot = false;
                            }
                            if (value.state) { diagnostic(null); onTerminal(value); return; }
                        }
                    }
                } finally {
                    // Safari can leave both read() and cancel() pending after suspension.
                    // A stale connection must never hold up the next current snapshot.
                    void reader.cancel().catch(() => {});
                }
            } catch { /* The ordinary job observer remains available during reconnects. */ } finally {
                clearTimeout(silence);
                current.abort();
            }
            if (!stopped && !hidden() && !reconnectRequested) await new Promise(resolve => {
                const backoff = setTimeout(() => { wake = null; resolve(); }, 1000);
                wake = () => { clearTimeout(backoff); resolve(); };
            });
        }
    };
    void run();
    const stop = () => {
        stopped = true;
        diagnostic(null);
        attempt?.abort();
        wake?.(); wake = null;
        document.removeEventListener('visibilitychange', onVisible);
        globalThis.removeEventListener?.('pageshow', reconnect);
        globalThis.removeEventListener?.('online', reconnect);
        clearInterval(timer); remove(); restoreReplacement();
    };
    // The finished reply is about to be saved and the chat rebuilt. Stop redrawing,
    // so the preview stays where the reader sees it and cannot reappear in the
    // emptied chat ahead of the saved messages.
    stop.freeze = () => { render(); frozen = true; clearInterval(timer); };
    return stop;
}
