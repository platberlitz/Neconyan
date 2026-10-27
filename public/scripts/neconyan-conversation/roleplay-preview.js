import { chat as messages, formatGenerationTimer, getRequestHeaders, getThumbnailUrl, refreshChatViewportBaseline, scrollChatToBottom, updateMessageElement, updatePreviewMessageText } from '../../script.js';
import { beginRoleplayReplacement } from './roleplay-replacement.js';
import { withAbortSignal } from '../abort.js';
import { power_user } from '../power-user.js';
import { getStreamingUpdateInterval } from '../mobile-streaming.js';
import { applyRoleplayPreviewFrame } from './roleplay-preview-frames.js';
import { StreamingThinkingIndicator } from '../streaming-thinking.js';

const labels = {
    preparing: 'Preparing reply…', generating: 'Writing reply…', agents: 'Running Agents…',
    companions: 'Running Companions…', review: 'Waiting for your review…',
    translating: 'Translating reply…', speech: 'Preparing speech…', saving: 'Saving reply…',
};
const PREVIEW_SILENCE_MS = 5000;
// Companion notes share the saved job artifact's 16 MiB limit.
const MAX_PREVIEW_EVENT_LENGTH = 16 * 1024 * 1024;
const FOLLOWED_STAGES = new Set(['preparing', 'generating', 'agents']);
// Everything the full message renderer treats as structure. Frames copy the
// snapshot and reuse nested metadata references, so an equal reference means
// that part is unchanged; the growing text is compared separately.
const PREVIEW_STRUCTURE_FIELDS = Object.freeze([
    'childId', 'stage', 'name', 'avatar', 'gen_started', 'gen_finished',
    'reasoning', 'reasoning_finished', 'reasoning_duration',
    'inChatAgents', 'inChatAgentCompanionResults', 'generation',
]);

/**
 * Whether two preview frames need the same message structure. Text, counters
 * and elapsed time are deliberately excluded: those update without a rebuild.
 * @param {object|null} previous Frame last drawn in full
 * @param {object|null} next Current frame
 * @returns {boolean}
 */
export function hasSamePreviewStructure(previous, next) {
    if (!previous || !next) return false;
    return PREVIEW_STRUCTURE_FIELDS.every(field => Object.is(previous[field], next[field]));
}

function hasUnfinishedReasoning(preview) {
    return Boolean(preview?.reasoning) && !preview?.reasoning_finished;
}

/**
 * Display only: the preview itself never enters the chat array or a chat save.
 * `stop.reply()` hands its last text to the observer, which keeps a reply the
 * server stopped or refused to write instead of letting it vanish.
 */
export function observeRoleplayPreview(jobId, { account, isCurrent, onTerminal, name, messageIndex }) {
    let node = null;
    let latest = null;
    let receivedAt = 0;
    let serverTime = null;
    let receivedMonotonic = 0;
    let rendered = null;
    let renderedMessageId = null;
    let childId = null;
    let startedAt = null;
    let stopped = false;
    let frozen = false;
    const thinkingIndicator = new StreamingThinkingIndicator();
    const diagnosticHandle = {};
    let diagnosticStage = null;
    const diagnostic = phase => { try { globalThis.NeconyanCrashDiagnostics?.observePhase?.(diagnosticHandle, phase); } catch { /* Optional diagnostics. */ } };
    let restoreReplacement = () => {};
    const remove = () => {
        if (node) {
            thinkingIndicator.clear();
            node.remove();
            document.dispatchEvent(new CustomEvent('neconyan:roleplay-preview-removed', { detail: { element: node } }));
        }
        node = null; rendered = null; renderedMessageId = null;
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
        const elapsed = Math.max(0, performance.now() - receivedMonotonic);
        const now = (serverTime ?? receivedAt) + elapsed;
        const finishedAt = latest.gen_finished || (['preparing', 'generating'].includes(latest.stage || 'preparing') ? now : serverTime ?? receivedAt);
        const reasoningDuration = typeof latest.reasoning_duration === 'number'
            ? latest.reasoning_duration + (thinking ? elapsed : 0) : undefined;
        if (node?.isConnected && latest === rendered && !thinking) {
            // A quiet stream still has an elapsed time. Update only the badge,
            // preserving the message text, selection and display-only colours.
            const { timerValue, timerTitle } = formatGenerationTimer(latest.gen_started || startedAt, finishedAt,
                latest.token_count, reasoningDuration, latest.time_to_first_token, latest.reasoning_tokens);
            const timer = node.querySelector('.mes_timer');
            if (timer) {
                if (timer.textContent !== (timerValue || '')) timer.textContent = timerValue || '';
                if (timer.title !== (timerTitle || '')) timer.title = timerTitle || '';
            }
            return;
        }
        // Follow the reply while it is written; Agent and Companion output added after
        // that lands below the reader instead of pulling the page down to it. Once
        // Companion notes exist, even the Agents stage stops following, because its
        // concurrent notes can grow the same reply while it is still streaming.
        const companionResults = latest.inChatAgentCompanionResults;
        const hasCompanionResults = Boolean(companionResults) && typeof companionResults === 'object'
            && Object.keys(companionResults).length > 0;
        const nearBottom = !hasCompanionResults
            && FOLLOWED_STAGES.has(latest.stage || 'preparing')
            && chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
        if (childId !== latest.childId) {
            remove();
            childId = latest.childId;
            startedAt = new Date(latest.updatedAt || serverTime || receivedAt).toISOString();
        }
        const reasoningDetails = node?.querySelector('.mes_reasoning_details');
        const message = { name: latest.name || 'Reply', is_user: false, is_system: false,
            mes: latest.text || '', send_date: startedAt, gen_started: latest.gen_started || startedAt, gen_finished: finishedAt,
            original_avatar: latest.avatar,
            force_avatar: latest.avatar ? getThumbnailUrl('avatar', latest.avatar) : undefined,
            extra: { reasoning: latest.reasoning || '', inChatAgents: latest.inChatAgents,
                inChatAgentCompanionResults: latest.inChatAgentCompanionResults,
                api: latest.generation?.source, model: latest.generation?.model,
                token_count: latest.token_count, reasoning_tokens: latest.reasoning_tokens,
                time_to_first_token: latest.time_to_first_token, reasoning_duration: reasoningDuration,
                ...(reasoningDetails && node.classList.contains('reasoning') ? { reasoning_collapsed: !reasoningDetails.open } : {}) } };
        const replacement = chat.querySelector('[data-roleplay-replacement]');
        const messageId = replacement ? Number(replacement.dataset.roleplayReplacement) : messages.length;
        const finishDraw = () => {
            const status = node.querySelector('[role="status"]');
            const label = labels[latest.stage] || labels.preparing;
            if (status.textContent !== label) status.textContent = label;
            thinkingIndicator.update(node, latest.stage === 'generating'
                && !/\S/.test(latest.text || '') && !/\S/.test(latest.reasoning || ''));
            // The saved receipt names the final child job. Keep the preview's own
            // child identity for the handover to match a completed group speaker.
            const currentChild = String(latest.childId ?? '');
            if (node.dataset.roleplayChild !== currentChild) node.dataset.roleplayChild = currentChild;
            // Display-only decorators run before the browser paints. Saved-message
            // events would incorrectly treat this draft as part of the chat history.
            document.dispatchEvent(new CustomEvent('neconyan:roleplay-preview-rendered', { detail: { message, element: node } }));
            rendered = latest;
            renderedMessageId = messageId;
            // A live bottom landing must supersede resize anchors for older positions,
            // and honour the same automatic/manual scrolling policy as saved replies.
            if (nearBottom) scrollChatToBottom({ isNearBottom: nearBottom });
            else refreshChatViewportBaseline();
        };
        // Streaming text, counters and the clock only need the draft body and its
        // metadata rewritten. Starting reasoning, a stage, Agent or Companion
        // change, another child or another model all rebuild through the full
        // renderer, so decorators keep their normal behaviour.
        const canUpdateInPlace = node?.isConnected && !thinking && !hasUnfinishedReasoning(rendered)
            && renderedMessageId === messageId && hasSamePreviewStructure(rendered, latest);
        if (canUpdateInPlace
            && updatePreviewMessageText(node, message, { messageId, updateText: rendered?.text !== latest.text })) {
            finishDraw();
            return;
        }
        const messageElement = updateMessageElement(message, { messageId, isPreview: true,
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
        finishDraw();
    };
    // Draw at the reader's streaming cadence (with the phone's conservative floors)
    // aligned to the next animation frame, instead of rebuilding the growing
    // Markdown reply for every arriving append. Stage and candidate changes are
    // progress the reader waits for and skip the wait to the next frame.
    let drawTimer = null;
    let drawRaf = null;
    let lastDrawAt = 0;
    const minDrawInterval = () => getStreamingUpdateInterval(1000 / power_user.streaming_fps, {
        iosEnabled: power_user.ios_webkit_conservative_streaming,
        androidEnabled: power_user.android_conservative_streaming,
    });
    const cancelPendingDraws = () => {
        if (drawTimer !== null) { clearTimeout(drawTimer); drawTimer = null; }
        if (drawRaf !== null) { cancelAnimationFrame(drawRaf); drawRaf = null; }
    };
    const paint = () => { drawRaf = null; lastDrawAt = performance.now(); render(); };
    const requestDraw = urgent => {
        if (stopped || frozen) return;
        if (urgent) {
            if (drawTimer !== null) { clearTimeout(drawTimer); drawTimer = null; }
            if (drawRaf === null) drawRaf = requestAnimationFrame(paint);
            return;
        }
        if (drawTimer !== null || drawRaf !== null) return;
        const remaining = minDrawInterval() - (performance.now() - lastDrawAt);
        if (remaining <= 0) drawRaf = requestAnimationFrame(paint);
        else drawTimer = setTimeout(() => { drawTimer = null; drawRaf = requestAnimationFrame(paint); }, remaining);
    };
    const hidden = () => document.visibilityState === 'hidden';
    // The clock timer keeps a quiet stream's badge alive and backs up any text a
    // dropped draw left undisplayed; a scheduled draw already covers new text.
    const onClockTick = () => {
        if (frozen || stopped) return;
        if (latest && latest !== rendered) { requestDraw(false); return; }
        render();
    };
    let timer = hidden() ? null : setInterval(onClockTick, 500);
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
            cancelPendingDraws();
            reconnect();
            return;
        }
        if (!timer && !frozen && !stopped) timer = setInterval(onClockTick, 500);
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
                // The query opts this reader into delta frames. A server that does
                // not know it ignores the parameter and sends full snapshots, which
                // the frame decoder below still accepts.
                const response = await withAbortSignal(fetch(`/api/jobs/${encodeURIComponent(jobId)}/preview?frames=delta`, {
                    headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account },
                    credentials: 'same-origin', signal: current.signal,
                }), current.signal);
                // A missing job has no preview to wait for; other refusals are retried.
                if (response.status === 404) { stop.freeze(); return; }
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
                            if (value.preview || value.delta) {
                                const previous = latest;
                                // A full snapshot replaces the base; a delta extends it. Every
                                // connection opens with a full snapshot, so a delta without a
                                // base means this stream desynchronised: reconnect for one.
                                const applied = applyRoleplayPreviewFrame(previous, value);
                                if (!applied && value.delta) { reconnect(); break; }
                                if (applied) {
                                    latest = applied; receivedAt = Date.now();
                                    receivedMonotonic = performance.now();
                                    serverTime = Number.isFinite(value.serverTime) ? value.serverTime : null;
                                    if (latest.stage !== diagnosticStage && isCurrent()) {
                                        diagnosticStage = latest.stage;
                                        diagnostic(({ preparing: 'preparing', generating: 'generating', agents: 'post-agents', companions: 'companions', review: 'waiting-review', saving: 'saving' })[diagnosticStage] || 'unknown');
                                    }
                                    const immediate = firstSnapshot || !node;
                                    firstSnapshot = false;
                                    // The first snapshot's bottom landing must supersede
                                    // any resize still settling an older reading position.
                                    if (immediate) {
                                        if (!stopped && !frozen) { cancelPendingDraws(); paint(); }
                                    } else requestDraw(previous.childId !== latest.childId || previous.stage !== latest.stage);
                                }
                            }
                            if (value.state) { stop.freeze(); diagnostic(null); onTerminal(value); return; }
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
        cancelPendingDraws();
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
    stop.freeze = () => { cancelPendingDraws(); render(); frozen = true; thinkingIndicator.clear(); clearInterval(timer); timer = null; };
    // The last reply text shown, so a reply the server did not save can be kept.
    stop.reply = () => {
        if (!latest || !/\S/.test(latest.text || '')) return null;
        const sentAt = startedAt || new Date(latest.updatedAt || Date.now()).toISOString();
        const extra = Object.fromEntries(Object.entries({ reasoning: latest.reasoning || undefined,
            api: latest.generation?.source, model: latest.generation?.model,
            token_count: latest.token_count, reasoning_tokens: latest.reasoning_tokens,
            time_to_first_token: latest.time_to_first_token, reasoning_duration: latest.reasoning_duration })
            .filter(([, value]) => value !== undefined && value !== null));
        return { name: latest.name || 'Reply', avatar: latest.avatar || '', text: latest.text, send_date: sentAt,
            gen_started: latest.gen_started || sentAt, gen_finished: latest.gen_finished || new Date(receivedAt || Date.now()).toISOString(), extra };
    };
    return stop;
}
