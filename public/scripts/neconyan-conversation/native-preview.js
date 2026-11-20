import { getRequestHeaders } from '../../script.js';
import { getCurrentUserHandle } from '../user.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { withAbortSignal } from '../abort.js';

const previews = new Map();

export function getNativeConversationPreviews(avatar, { branchId, groupId, personaId }) {
    return [...previews.values()].flatMap(entry => entry.account === getCurrentUserHandle() ? entry.participants : [])
        .filter(value => value.target?.avatar === avatar && value.target.branchId === branchId
            && (value.target.groupId || '') === (groupId || '') && (value.target.personaId || '') === (personaId || ''));
}

/** Reconnect to display-only server state; the regular observer owns saved-message readback. */
export function observeNativeConversationPreview(jobId, account) {
    const entry = { account, participants: [] };
    previews.set(jobId, entry);
    let stopped = false;
    let diagnosticRunning = false;
    const diagnostic = phase => { try { globalThis.NeconyanCrashDiagnostics?.observePhase?.(entry, phase); } catch { /* Optional diagnostics. */ } };
    const current = () => !stopped && account === getCurrentUserHandle();
    const update = participants => {
        if (!current()) return;
        entry.participants = participants;
        if (Boolean(participants.length) !== diagnosticRunning) { diagnosticRunning = Boolean(participants.length); diagnostic(diagnosticRunning ? 'generating' : null); }
        scheduleInterfaceRefresh({ syncControls: false });
    };
    // Close the stream while the page is hidden so a phone is not kept awake receiving
    // text nobody sees; the regular observer still reads the saved reply.
    let attempt = null;
    let wake = null;
    const hidden = () => document.visibilityState === 'hidden';
    const onVisibility = () => {
        if (hidden()) { attempt?.abort(); return; }
        wake?.(); wake = null;
    };
    const reconnect = () => { attempt?.abort(); onVisibility(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', reconnect);
    window.addEventListener('online', reconnect);
    const run = async () => {
        while (current()) {
            if (hidden()) {
                await new Promise(resolve => { wake = resolve; });
                continue;
            }
            const connection = attempt = new AbortController();
            let silence;
            const arm = () => { clearTimeout(silence); silence = setTimeout(() => connection.abort(), 5000); };
            try {
                arm();
                const response = await withAbortSignal(fetch(`/api/jobs/${encodeURIComponent(jobId)}/preview`, {
                    headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account },
                    credentials: 'same-origin', signal: connection.signal,
                }), connection.signal);
                if ([401, 403, 404, 409].includes(response.status)) return;
                if (!response.ok || !response.body) throw new Error('Preview unavailable.');
                const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
                try {
                    let pending = '';
                    while (current()) {
                        const chunk = await withAbortSignal(reader.read(), connection.signal);
                        if (chunk.done) break;
                        arm();
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
                } finally { void reader.cancel().catch(() => {}); }
            } catch { /* Reconnect without resubmitting work. */ } finally {
                clearTimeout(silence);
                connection.abort();
                attempt = null;
            }
            if (current() && !hidden()) await new Promise(resolve => setTimeout(resolve, 1000));
        }
    };
    const clear = () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pageshow', reconnect);
        window.removeEventListener('online', reconnect);
        diagnostic(null);
        if (previews.get(jobId) !== entry) return;
        previews.delete(jobId);
        scheduleInterfaceRefresh({ syncControls: false });
    };
    void run().finally(clear);
    return () => {
        stopped = true;
        attempt?.abort();
        wake?.(); wake = null;
        clear();
    };
}
