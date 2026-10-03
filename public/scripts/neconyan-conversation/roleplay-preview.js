import { chat as messages, getRequestHeaders, getThumbnailUrl, updateMessageElement } from '../../script.js';

const labels = {
    preparing: 'Preparing reply…', generating: 'Writing reply…', agents: 'Running Agents…',
    companions: 'Running Companions…', review: 'Waiting for your review…',
    translating: 'Translating reply…', speech: 'Preparing speech…', saving: 'Saving reply…',
};

/** Display only: partial output never enters the chat array or a chat save. */
export function observeRoleplayPreview(jobId, { account, isCurrent, onTerminal }) {
    const controller = new AbortController();
    let node = null;
    let latest = null;
    let rendered = null;
    let childId = null;
    let startedAt = null;
    let stopped = false;
    const remove = () => { node?.remove(); node = null; rendered = null; };
    const render = () => {
        if (!isCurrent()) { remove(); return; }
        if (!latest) return;
        const chat = document.querySelector('#chat');
        if (!chat) return;
        if (node?.isConnected && latest === rendered) return;
        const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
        if (childId !== latest.childId) {
            remove();
            childId = latest.childId;
            startedAt = new Date(latest.updatedAt || Date.now()).toISOString();
        }
        const reasoningDetails = node?.querySelector('.mes_reasoning_details');
        const message = { name: latest.name || 'Reply', is_user: false, is_system: false,
            mes: latest.text || '', send_date: startedAt, gen_started: startedAt,
            original_avatar: latest.avatar,
            force_avatar: latest.avatar ? getThumbnailUrl('avatar', latest.avatar) : undefined,
            extra: { reasoning: latest.reasoning || '', inChatAgents: latest.inChatAgents,
                ...(reasoningDetails && node.classList.contains('reasoning') ? { reasoning_collapsed: !reasoningDetails.open } : {}) } };
        const messageElement = updateMessageElement(message, { messageId: messages.length, isPreview: true,
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
            chat.append(node);
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
                            if (value.preview) { latest = value.preview; if (!node) render(); }
                            if (value.state) { onTerminal(value); return; }
                        }
                    }
                } finally { await reader.cancel().catch(() => {}); }
            } catch { /* The ordinary job observer remains available during reconnects. */ }
            if (!stopped) await new Promise(resolve => setTimeout(resolve, 1000));
        }
    };
    void run();
    return () => { stopped = true; controller.abort(); clearInterval(timer); remove(); };
}
