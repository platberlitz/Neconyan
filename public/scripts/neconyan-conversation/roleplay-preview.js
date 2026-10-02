import { getRequestHeaders } from '../../script.js';

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
    let stopped = false;
    const remove = () => { node?.remove(); node = null; };
    const render = () => {
        if (!isCurrent()) { remove(); return; }
        if (!latest) return;
        const chat = document.querySelector('#chat');
        if (!chat) return;
        const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
        if (!node?.isConnected) {
            node = document.createElement('article');
            node.id = 'neconyan-roleplay-preview';
            node.className = 'mes_block';
            // This is a direct child of the scrolling flex column, not a block inside a message.
            // Keep its content height instead of squeezing the reply into the remaining chat space.
            Object.assign(node.style, { padding: '12px', borderRadius: '8px', background: 'var(--neco-surface)',
                color: 'var(--neco-ink)', overflowWrap: 'anywhere', flexShrink: '0' });
            node.setAttribute('aria-label', 'Reply in progress');
            node.innerHTML = '<div class="ch_name"><span class="name_text"></span></div><small role="status"></small><details><summary>Reasoning</summary><div></div></details><div class="mes_text"></div>';
            node.querySelector('.mes_text').style.whiteSpace = 'pre-wrap';
            node.querySelector('details div').style.whiteSpace = 'pre-wrap';
            chat.append(node);
        }
        node.querySelector('.name_text').textContent = latest.name || 'Reply';
        node.querySelector('[role="status"]').textContent = labels[latest.stage] || labels.preparing;
        node.querySelector('.mes_text').textContent = latest.text || '';
        node.querySelector('details').hidden = !latest.reasoning;
        node.querySelector('details div').textContent = latest.reasoning || '';
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
                            if (value.preview) { latest = value.preview; render(); }
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
