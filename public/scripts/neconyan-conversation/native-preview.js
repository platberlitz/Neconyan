import { getRequestHeaders } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';

const previews = new Map();

export function getNativeConversationPreviews(avatar, { branchId, groupId, personaId }) {
    return [...previews.values()].flatMap(entry => entry.account === getCurrentUserHandle() ? entry.participants : [])
        .filter(value => value.target?.avatar === avatar && value.target.branchId === branchId
            && (value.target.groupId || '') === (groupId || '') && (value.target.personaId || '') === (personaId || ''));
}

/** Reconnect to display-only server state; the regular observer owns saved-message readback. */
export function observeNativeConversationPreview(jobId, account) {
    const controller = new AbortController();
    const entry = { account, participants: [] };
    previews.set(jobId, entry);
    let stopped = false;
    const current = () => !stopped && account === getCurrentUserHandle();
    const update = participants => {
        if (!current()) return;
        entry.participants = participants;
        scheduleInterfaceRefresh({ syncControls: false });
    };
    const run = async () => {
        while (current()) {
            try {
                const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/preview`, {
                    headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account },
                    credentials: 'same-origin', signal: controller.signal,
                });
                if ([401, 403, 404, 409].includes(response.status)) return;
                if (!response.ok || !response.body) throw new Error('Preview unavailable.');
                const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
                try {
                    let pending = '';
                    while (current()) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        pending += chunk.value;
                        if (pending.length > 8 * 1024 * 1024) throw new Error('Preview exceeded its limit.');
                        let boundary;
                        while ((boundary = pending.indexOf('\n\n')) >= 0) {
                            const event = pending.slice(0, boundary);
                            pending = pending.slice(boundary + 2);
                            if (!event.startsWith('data: ')) continue;
                            const value = JSON.parse(event.slice(6));
                            if (Array.isArray(value.preview?.participants)) update(value.preview.participants);
                            if (value.state) return;
                        }
                    }
                } finally { await reader.cancel().catch(() => {}); }
            } catch { /* Reconnect without resubmitting work. */ }
            if (current()) await new Promise(resolve => setTimeout(resolve, 1000));
        }
    };
    const clear = () => {
        if (previews.get(jobId) !== entry) return;
        previews.delete(jobId);
        scheduleInterfaceRefresh({ syncControls: false });
    };
    void run().finally(clear);
    return () => {
        stopped = true;
        controller.abort();
        clear();
    };
}
