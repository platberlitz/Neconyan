/** Application adapter. Only scalar counts and fixed states leave the application. */
export function initialiseCrashActivity({ eventSource, event_types, getChat, getExtensionCount }) {
    const api = globalThis.NeconyanCrashDiagnostics;
    if (!api) return;
    const safe = callback => (...args) => { try { callback(...args); } catch { /* Optional diagnostics. */ } };
    const update = patch => api.updateActivity?.(patch);
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
    on('APP_READY', () => { api.markAppReady?.(); counts(); rebuild(); });
    for (const type of ['EXTENSIONS_FIRST_LOAD', 'EXTENSION_DISABLED', 'SETTINGS_UPDATED']) on(type, counts);
    document.addEventListener('sb:shell-tab-activated', safe(event => {
        const tab = event.detail?.tab;
        update({ view: tab === 'home' ? 'home' : tab === 'chat' ? 'chat' : ['settings', 'model', 'customise'].includes(tab) ? 'settings' : 'tool' });
    }));
    document.addEventListener('visibilitychange', safe(() => { if (document.visibilityState === 'visible') rebuild(); else revision++; }));
    globalThis.addEventListener?.('pagehide', () => { revision++; });
}
