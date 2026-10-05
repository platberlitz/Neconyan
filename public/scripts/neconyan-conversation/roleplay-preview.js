import { chat as messages, getRequestHeaders, getThumbnailUrl, updateMessageElement } from '../../script.js';
import { beginRoleplayReplacement } from './roleplay-replacement.js';

const labels = {
    preparing: 'Preparing reply…', generating: 'Writing reply…', agents: 'Running Agents…',
    companions: 'Running Companions…', review: 'Waiting for your review…',
    translating: 'Translating reply…', speech: 'Preparing speech…', saving: 'Saving reply…',
};

/** Display only: partial output never enters the chat array or a chat save. */
export function observeRoleplayPreview(jobId, { account, isCurrent, onTerminal, name, messageIndex }) {
    const controller = new AbortController();
    let node = null;
    let latest = null;
    let receivedAt = 0;
    let rendered = null;
    let childId = null;
    let startedAt = null;
    let stopped = false;
    let restoreReplacement = () => {};
    const remove = () => { node?.remove(); node = null; rendered = null; };
    const render = () => {
        if (!isCurrent()) { remove(); restoreReplacement(); return; }
        if (!latest) return;
        const chat = document.querySelector('#chat');
        if (!chat) return;
        if (!chat.querySelector('[data-roleplay-replacement]')) {
            restoreReplacement = beginRoleplayReplacement(name, messageIndex, isCurrent);
        }
        const thinking = latest.stage === 'generating' && latest.reasoning && !latest.reasoning_finished;
        if (node?.isConnected && latest === rendered && !thinking) return;
        const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
        if (childId !== latest.childId) {
            remove();
            childId = latest.childId;
            startedAt = new Date(latest.updatedAt || Date.now()).toISOString();
        }
        const reasoningDetails = node?.querySelector('.mes_reasoning_details');
        const message = { name: latest.name || 'Reply', is_user: false, is_system: false,
            mes: latest.text || '', send_date: startedAt, gen_started: latest.gen_started || startedAt,
            original_avatar: latest.avatar,
            force_avatar: latest.avatar ? getThumbnailUrl('avatar', latest.avatar) : undefined,
            extra: { reasoning: latest.reasoning || '', inChatAgents: latest.inChatAgents,
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
        rendered = latest;
        if (nearBottom) chat.scrollTop = chat.scrollHeight;
    };
    const timer = setInterval(render, 500);
    const run = async () => {
        while (!stopped) {
            try {
                const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/preview`, {
                    headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account },
                    credentials: 'same-origin', signal: controller.signal,
                });
                if (!response.ok || !response.body) return;
                const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
                try {
                    let pending = '';
                    while (!stopped) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        pending += chunk.value;
                        if (pending.length > 2 * 1024 * 1024) throw new Error('Reply preview exceeded its limit.');
                        let boundary;
                        while ((boundary = pending.indexOf('\n\n')) >= 0) {
                            const event = pending.slice(0, boundary);
                            pending = pending.slice(boundary + 2);
                            if (!event.startsWith('data: ')) continue;
                            const value = JSON.parse(event.slice(6));
                            // Use the regular display formatter at a bounded cadence, rather
                            // than rebuilding a growing Markdown message for every token.
                            if (value.preview) { latest = value.preview; receivedAt = Date.now(); if (!node) render(); }
                            if (value.state) { onTerminal(value); return; }
                        }
                    }
                } finally { await reader.cancel().catch(() => {}); }
            } catch { /* The ordinary job observer remains available during reconnects. */ }
            if (!stopped) await new Promise(resolve => setTimeout(resolve, 1000));
        }
    };
    void run();
    return () => { stopped = true; controller.abort(); clearInterval(timer); remove(); restoreReplacement(); };
}
