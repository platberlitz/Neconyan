/** Application adapter. Only scalar counts and fixed states leave the application. */
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';

export function createServerCrashObserver({ isAdmin, getAccount, getRequestHeaders, refreshCsrfToken, fetchFn = fetch, showNotice = options => globalThis.NeconyanCrashDiagnostics?.showNotice?.(options) }) {
    let active = false, timer = null, inFlight = null, lastRequest = -Infinity, runId = null, disconnected = false, currentNotice = null;
    const memorySeen = new Map();
    const scope = account => {
        let hash = 2166136261;
        for (const char of account) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        return `neconyan.server-crash-seen.v1:${(hash >>> 0).toString(16)}`;
    };
    const valid = account => active && isAdmin() && getAccount() === account;
    const stop = () => { active = false; clearTimeout(timer); timer = null; inFlight?.abort(); inFlight = null; runId = null; currentNotice?.remove?.(); currentNotice = null; };
    const schedule = delay => { clearTimeout(timer); timer = null; if (active && document.visibilityState === 'visible') timer = setTimeout(() => void poll(), delay); };
    const poll = async () => {
        if (!active || document.visibilityState !== 'visible' || inFlight) return;
        if (!isAdmin()) { stop(); return; }
        if (Date.now() - lastRequest < 5000) { schedule(5000 - (Date.now() - lastRequest)); return; }
        const account = getAccount();
        if (typeof account !== 'string') return;
        lastRequest = Date.now();
        const controller = new AbortController(); inFlight = controller;
        const timeout = setTimeout(() => controller.abort(), 3000);
        let delay = 30000;
        try {
            const response = await fetchWithCsrfRetry('/api/server-admin/crash-reports/status', () => ({ method: 'POST', credentials: 'same-origin',
                headers: getRequestHeaders(), signal: controller.signal }), { refreshCsrfToken, fetchFn });
            if (!valid(account)) { stop(); return; }
            if ([401, 403].includes(response.status)) { stop(); return; }
            if (!response.ok) throw new Error('Diagnostic status unavailable');
            const text = await response.text();
            if (!valid(account)) { stop(); return; }
            if (text.length > 2048) throw new Error('Invalid diagnostic status');
            const result = JSON.parse(text), latest = result.latest;
            let seen = memorySeen.get(account) || [];
            const key = scope(account);
            try { const stored = localStorage.getItem(key); if (stored && stored.length <= 2048) seen = JSON.parse(stored).filter(item => typeof item === 'string' && item.length <= 128).slice(-20); } catch { /* A page-local acknowledgement still works below. */ }
            if (latest && typeof latest.id === 'string' && latest.id.length <= 128 && !seen.includes(latest.id)) {
                const restarted = runId && runId !== result.runId && disconnected;
                currentNotice = showNotice({ id: latest.id, title: restarted ? 'The server restarted after an unexpected stop' : 'A saved server crash report is available',
                    message: `${typeof latest.at === 'string' ? latest.at : 'Time unavailable'}. ${typeof latest.errorPreview === 'string' ? latest.errorPreview.slice(0, 400) : 'No error message was supplied.'}`,
                    onRead: async () => {
                        if (!valid(account)) return;
                        const module = await import('./crash-report-reader.js');
                        if (!valid(account)) return;
                        module.openCrashReportReader({ selectedReportId: latest.id, loadServerReports: async () => {
                            const response = await fetchWithCsrfRetry('/api/server-admin/crash-reports', () => ({ method: 'POST', credentials: 'same-origin', headers: getRequestHeaders() }), { refreshCsrfToken, fetchFn });
                            if (!valid(account) || !response.ok) return { unavailable: 'Server reports are unavailable for this account.' };
                            const result = await response.json();
                            return valid(account) ? result : { unavailable: 'The account changed. Server details were not displayed.' };
                        } });
                    } });
                if (currentNotice && valid(account)) { seen.push(latest.id); memorySeen.set(account, seen.slice(-20)); try { localStorage.setItem(key, JSON.stringify(seen.slice(-20))); } catch { /* Persistence is unavailable. */ } }
            }
            runId = result.runId; disconnected = false;
        } catch { disconnected = true; delay = 60000; } finally { clearTimeout(timeout); if (inFlight === controller) inFlight = null; schedule(delay); }
    };
    const resume = () => { if (active) void poll(); };
    const visibility = () => { if (document.visibilityState === 'visible') resume(); else { clearTimeout(timer); timer = null; } };
    globalThis.addEventListener?.('online', resume); document.addEventListener('visibilitychange', visibility);
    return { start: () => { if (isAdmin()) { active = true; void poll(); } }, stop, recovered: resume };
}

export function initialiseCrashActivity({ eventSource, event_types, getChat, getExtensionCount, isAdmin, getAccount, getRequestHeaders, refreshCsrfToken }) {
    const api = globalThis.NeconyanCrashDiagnostics;
    if (!api) return;
    const safe = callback => (...args) => { try { callback(...args); } catch { /* Optional diagnostics. */ } };
    const update = patch => api.updateActivity?.(patch);
    const server = isAdmin && getAccount ? createServerCrashObserver({ isAdmin, getAccount, getRequestHeaders, refreshCsrfToken }) : null;
    api.serverRecovered = safe(() => server?.recovered());
    let revision = 0, lengths = [], total = 0;
    const textLength = message => {
        const mes = typeof message?.mes === 'string' ? message.mes : '';
        let length = mes.length + (typeof message?.extra?.reasoning === 'string' ? message.extra.reasoning.length : 0);
        const swipes = message?.swipes;
        if (Array.isArray(swipes)) for (let index = 0; index < Math.min(swipes.length, 1000); index++) {
            const text = swipes[index];
            if (typeof text === 'string' && (index !== message.swipe_id || text !== mes)) length += text.length;
            const reasoning = message.swipe_info?.[index]?.extra?.reasoning;
            if (typeof reasoning === 'string' && index !== message.swipe_id) length += reasoning.length;
        }
        return Math.min(1099511627776, length * 2);
    };
    const publish = (count, sampled, complete) => {
        update({ chat: { messageCount: count, estimatedTextBytes: total, sampledMessages: sampled, complete, measuredAt: Date.now() },
            dom: { renderedChildren: document.getElementById('chat')?.childElementCount ?? null, measuredAt: Date.now() } });
    };
    const rebuild = safe(() => {
        const current = ++revision, chat = getChat();
        lengths = []; total = 0;
        if (!Array.isArray(chat) || !['unknown', 'roleplay'].includes(api.getActivity?.()?.snapshot.mode)) { publish(null, null, false); return; }
        let index = 0;
        const limit = Math.min(chat.length, 5000);
        const chunk = safe(() => {
            if (revision !== current || document.visibilityState === 'hidden') return;
            const start = performance.now();
            let count = 0;
            while (index < limit && count++ < 128 && performance.now() - start < 1) {
                const length = textLength(chat[index]); lengths[index++] = length; total += length;
            }
            publish(chat.length, index, index === chat.length);
            if (index < limit) schedule(chunk);
        });
        schedule(chunk);
        api.noteActivity?.('chat-open');
    });
    const schedule = callback => globalThis.requestIdleCallback ? requestIdleCallback(callback, { timeout: 1000 }) : setTimeout(callback, 0);
    const changed = safe(index => {
        const chat = getChat();
        if (!Number.isInteger(index) || index < 0 || index >= 5000 || lengths.length < Math.min(chat.length - 1, 5000)) { rebuild(); return; }
        const length = textLength(chat[index]); total += length - (lengths[index] || 0); lengths[index] = length;
        publish(chat.length, lengths.length, lengths.length === chat.length);
    });
    const counts = safe(() => update({ extensions: { enabledCount: getExtensionCount?.() ?? null } }));
    const on = (type, callback) => { if (event_types[type]) eventSource.on(event_types[type], safe(callback)); };
    for (const type of ['CHAT_CHANGED', 'CHAT_LOADED', 'MESSAGE_DELETED']) on(type, rebuild);
    for (const type of ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']) on(type, index => { changed(index); if (type === 'MESSAGE_SWIPED') api.noteActivity?.('swipe'); });
    on('GENERATION_STARTED', (type, options, dryRun) => {
        if (dryRun || options?.isAuxiliaryGeneration || type === 'quiet') return;
        update({ generation: { phase: 'preparing', location: 'browser' } }); api.noteActivity?.('generation-start');
    });
    on('MAIN_GENERATION_OUTPUT_READY', () => update({ generation: { phase: 'rendering', location: 'browser' } }));
    on('GENERATION_ENDED', () => { update({ generation: { phase: 'idle', location: 'unknown' } }); api.noteActivity?.('generation-end'); });
    on('GENERATION_STOPPED', () => { update({ generation: { phase: 'idle', location: 'unknown' } }); api.noteActivity?.('generation-stop'); });
    on('APP_READY', () => { api.markAppReady?.(); counts(); rebuild(); server?.start(); });
    for (const type of ['EXTENSIONS_FIRST_LOAD', 'EXTENSION_DISABLED', 'SETTINGS_UPDATED']) on(type, counts);
    document.addEventListener('sb:shell-tab-activated', safe(event => {
        const tab = event.detail?.tab;
        update({ view: tab === 'home' ? 'home' : tab === 'chat' ? 'chat' : ['settings', 'model', 'customise'].includes(tab) ? 'settings' : 'tool' });
    }));
    document.addEventListener('visibilitychange', safe(() => { if (document.visibilityState === 'visible') rebuild(); else revision++; }));
    globalThis.addEventListener?.('pagehide', () => { revision++; });
}
