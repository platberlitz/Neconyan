/* Early crash capture, shared with the server. No request bodies, console values or telemetry. */
(function () {
    'use strict';
    const MAX_TEXT = 12000;
    const KEY = 'neconyan.crash-reports.v1';

    function redact(value, limit = MAX_TEXT) {
        if (typeof value !== 'string') return '';
        return value.slice(0, limit)
            .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
            .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|passwd|secret|cookie)\s*["']?\s*[:=]\s*)(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;}]+)/gi, '$1[redacted]')
            .replace(/\b(?:sk|sess)-[a-zA-Z0-9_-]{12,}/g, '[redacted]')
            .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
            .replace(/((?:https?|file):\/\/[^\s?#)]+)[?#][^\s)]*/gi, '$1?[redacted]')
            .replace(/(\/[\w/.-]+)\?[^\s)]*/g, '$1?[redacted]');
    }

    function field(value, key) {
        try { return value?.[key]; } catch { return undefined; }
    }

    function describeError(value, depth = 0, seen = new Set(), budget = { nodes: 32, characters: 36000 }) {
        if (--budget.nodes < 0 || budget.characters <= 0) return { omitted: 'Error detail limit reached' };
        if (depth > 5) return { omitted: 'Cause depth limit reached' };
        if (value === null || typeof value !== 'object') {
            const message = typeof value === 'string' ? redact(value, Math.min(MAX_TEXT, budget.characters)) : `Non-Error rejection (${typeof value})`;
            budget.characters -= message.length;
            return { message };
        }
        if (seen.has(value)) return { omitted: 'Circular cause' };
        seen.add(value);
        const result = {};
        for (const key of ['name', 'message', 'stack', 'code', 'errno', 'syscall', 'status', 'statusCode']) {
            const item = field(value, key);
            if (typeof item === 'string') {
                result[key] = redact(item, Math.max(0, Math.min(MAX_TEXT, budget.characters)));
                budget.characters -= result[key].length;
            } else if (typeof item === 'number' || typeof item === 'boolean') result[key] = item;
        }
        const cause = field(value, 'cause');
        if (cause !== undefined) result.cause = describeError(cause, depth + 1, seen, budget);
        const errors = field(value, 'errors');
        try {
            if (Array.isArray(errors)) {
                result.errors = [];
                for (let index = 0; index < Math.min(field(errors, 'length') || 0, 8); index++) {
                    result.errors.push(describeError(field(errors, index), depth + 1, seen, budget));
                }
            }
        } catch { result.errors = [{ omitted: 'Error list could not be read' }]; }
        return Object.keys(result).length ? result : { message: 'Non-Error object; arbitrary fields omitted' };
    }

    const LABELS = Object.freeze({
        'tpl-format-fixer': 'Format Fixer', 'tpl-proofreader': 'Proofreader', 'tpl-prose-polisher': 'Prose Polisher',
        'tpl-scene-tracker': 'Scene Tracker', 'tpl-time-tracker': 'Time Tracker',
    });
    const PHASES = ['idle', 'preparing', 'pre-agents', 'generating', 'post-agents', 'companions', 'rendering', 'saving', 'waiting-review', 'unknown'];
    const AGENT_PHASES = ['pre', 'post', 'companions', 'synthesis', 'repair', 'regex', 'unknown'];
    const EVENTS = ['page-start', 'app-ready', 'chat-open', 'generation-start', 'generation-end', 'generation-stop', 'agent-start', 'agent-end', 'agent-error', 'agent-cancel', 'swipe', 'visibility', 'pagehide', 'pageshow', 'memory-pressure'];
    // Read data properties only. Application objects and accessor side effects are not diagnostics.
    function own(object, key) {
        try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
    }
    const counter = (value, maximum = 1000000) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : null;
    const choice = (value, values, fallback = 'unknown') => values.includes(value) ? value : fallback;
    const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9:-]{1,100}$/.test(value) ? value : '';
    function safeAgentLabel(value) {
        return typeof value === 'string' && (Object.values(LABELS).includes(value) || value === 'Combined reply' || /^Custom agent [1-9][0-9]{0,3}$/.test(value)) ? value : 'Custom agent 1';
    }
    function validateActivity(input) {
        const result = { schema: 1, pageSessionId: safeId(own(input, 'pageSessionId')), at: counter(own(input, 'at'), Number.MAX_SAFE_INTEGER),
            uptimeMs: counter(own(input, 'uptimeMs'), 2592000000), ready: own(input, 'ready') === true,
            view: choice(own(input, 'view'), ['startup', 'home', 'chat', 'settings', 'tool', 'unknown']),
            mode: choice(own(input, 'mode'), ['roleplay', 'conversation', 'meower', 'story', 'unknown']),
            visibility: choice(own(input, 'visibility'), ['visible', 'hidden'], 'hidden') };
        for (const [section, fields] of Object.entries({
            chat: ['messageCount', 'estimatedTextBytes', 'sampledMessages', 'measuredAt'],
            dom: ['renderedChildren', 'measuredAt'], heap: ['usedBytes', 'totalBytes', 'limitBytes'],
        })) {
            const source = own(input, section);
            result[section] = {};
            for (const key of fields) result[section][key] = counter(own(source, key), key.endsWith('Bytes') ? 1099511627776 : key === 'measuredAt' ? Number.MAX_SAFE_INTEGER : 1000000);
            if (section === 'chat') { result.chat.estimate = 'utf16-text-only'; result.chat.complete = own(source, 'complete') === true; }
        }
        const generation = own(input, 'generation');
        result.generation = { phase: choice(own(generation, 'phase'), PHASES), location: choice(own(generation, 'location'), ['browser', 'server', 'unknown']) };
        const agents = own(input, 'agents'), running = own(agents, 'running');
        result.agents = { enabledCount: counter(own(agents, 'enabledCount')), running: [], omittedRunningCount: counter(own(agents, 'omittedRunningCount')) || 0 };
        if (Array.isArray(running)) {
            const length = counter(own(running, 'length')) || 0;
            for (let index = 0; index < Math.min(length, 8); index++) {
                const item = own(running, index);
                result.agents.running.push({ label: safeAgentLabel(own(item, 'label')), phase: choice(own(item, 'phase'), AGENT_PHASES), location: choice(own(item, 'location'), ['browser', 'server', 'unknown']) });
            }
            result.agents.omittedRunningCount = Math.min(1000000, result.agents.omittedRunningCount + Math.max(0, length - 8));
        }
        result.extensions = { enabledCount: counter(own(own(input, 'extensions'), 'enabledCount')) };
        return result;
    }
    function validateEvents(input) {
        const result = [];
        if (!Array.isArray(input)) return result;
        for (let index = Math.max(0, Math.min(own(input, 'length') || 0, 12) - 12); index < Math.min(own(input, 'length') || 0, 12); index++) {
            const item = own(input, index), type = own(item, 'type');
            if (!EVENTS.includes(type)) continue;
            const event = { at: counter(own(item, 'at'), Number.MAX_SAFE_INTEGER), type };
            if (PHASES.includes(own(item, 'phase'))) event.phase = own(item, 'phase');
            if (own(item, 'agentLabel')) event.agentLabel = safeAgentLabel(own(item, 'agentLabel'));
            result.push(event);
        }
        return result;
    }
    const api = { redact, describeError, validateActivity, validateEvents, safeAgentLabel, templateLabel: id => typeof id === 'string' ? own(LABELS, id) || null : null };
    globalThis.NeconyanCrashDiagnostics = api;
    if (typeof window === 'undefined' || !window.document) return;

    let reports = [];
    let storageError = '';
    let capturing = false;
    let unsaved = false;
    const activity = [];
    const startedAt = Date.now();
    const SESSION_PREFIX = 'neconyan.crash-session.v1:';
    const TAB_KEY = 'neconyan.crash-tab.v1';
    const randomId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    function legacyId(report) {
        const values = [report.runtime, report.kind, report.at, report.startedAt, report.context?.source, report.error?.message];
        const text = values.map(value => typeof value === 'string' ? value.slice(0, 400) : typeof value === 'number' ? String(value) : '').join('|');
        let hash = 2166136261;
        for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
        return `legacy:${(hash >>> 0).toString(16)}`;
    }
    const documentId = randomId();
    let tabId = randomId(), previousSession = null;
    let snapshot = validateActivity({ pageSessionId: documentId, at: startedAt, uptimeMs: 0, view: 'startup', visibility: document.visibilityState });
    let events = [{ at: startedAt, type: 'page-start' }];
    const handles = new Map(), observedJobs = new Map(), customLabels = new Map(), phases = new Map(), retainedActivities = [];
    let nextHandle = 0, nativeToken = '', lastWrite = 0, flushTimer = null, heartbeatTimer = null, state = 'running', dirty = true;
    try {
        tabId = safeId(sessionStorage.getItem(TAB_KEY)) || tabId;
        sessionStorage.setItem(TAB_KEY, tabId);
        const text = localStorage.getItem(SESSION_PREFIX + tabId);
        if (text && text.length <= 8192) {
            const entry = JSON.parse(text);
            if (entry?.schema === 1 && safeId(entry.documentId)) previousSession = entry;
        }
        const retained = [];
        for (let index = 0; index < localStorage.length && retained.length < 8; index++) {
            const key = localStorage.key(index);
            if (!key?.startsWith(SESSION_PREFIX) || key === SESSION_PREFIX + tabId) continue;
            const value = localStorage.getItem(key);
            if (value?.length > 8192) { localStorage.removeItem(key); continue; }
            try { const entry = JSON.parse(value); retained.push({ key, entry }); } catch { localStorage.removeItem(key); }
        }
        for (const item of retained.filter(item => ['closed', 'recovered'].includes(item.entry?.state)).sort((a, b) => a.entry.heartbeatAt - b.entry.heartbeatAt).slice(0, Math.max(0, retained.length - 6))) localStorage.removeItem(item.key);
        for (const item of retained.slice(0, 8)) {
            if (item.entry?.schema === 1 && item.entry.snapshot) retainedActivities.push({ schema: 1, id: 'activity:' + safeId(item.entry.documentId), runtime: 'browser', kind: 'retained-page-activity',
                at: Number.isSafeInteger(item.entry.heartbeatAt) ? new Date(item.entry.heartbeatAt).toISOString() : null,
                lastKnownActivity: { snapshot: validateActivity(item.entry.snapshot), events: validateEvents(item.entry.events) },
                limitation: 'Activity from another tab. This is not a crash report and never triggers an automatic notice.' });
        }
    } catch { /* Storage may be blocked. The current in-memory sample remains available. */ }

    function refreshAgents() {
        const running = Array.from(handles.values());
        for (const observation of observedJobs.values()) running.push(...observation.agents.running);
        snapshot.agents.running = running.slice(0, 8);
        snapshot.agents.omittedRunningCount = Math.max(0, running.length - 8);
        const phase = running[0]?.phase;
        if (phase) snapshot.generation = { phase: phase === 'pre' ? 'pre-agents' : phase === 'companions' ? 'companions' : 'post-agents', location: running[0].location };
        else if (['pre-agents', 'post-agents', 'companions'].includes(snapshot.generation.phase)) snapshot.generation = { phase: 'idle', location: 'unknown' };
        if (!running.length && phases.size) snapshot.generation = { phase: Array.from(phases.values()).at(-1), location: 'server' };
    }
    function scheduleFlush() {
        dirty = true;
        if (flushTimer !== null || typeof setTimeout !== 'function') return;
        flushTimer = setTimeout(() => { flushTimer = null; flushActivity(); }, Math.max(0, 5000 - (Date.now() - lastWrite)));
    }
    function noteActivity(type) {
        if (!EVENTS.includes(type)) return;
        events.push({ at: Date.now(), type });
        if (events.length > 12) events.shift();
        scheduleFlush();
    }
    function updateActivity(patch) {
        const before = JSON.stringify(snapshot);
        const next = validateActivity(patch);
        for (const key of ['view', 'mode', 'chat', 'dom', 'generation', 'extensions']) if (own(patch, key) !== undefined) snapshot[key] = next[key];
        if (own(own(patch, 'agents'), 'enabledCount') !== undefined) snapshot.agents.enabledCount = next.agents.enabledCount;
        refreshAgents();
        if (JSON.stringify(snapshot) !== before) scheduleFlush();
    }
    function flushActivity(reason = 'scheduled') {
        const now = Date.now();
        if (reason === 'scheduled' && ((!dirty && now - lastWrite < 30000) || now - lastWrite < 5000)) return;
        snapshot.at = now;
        snapshot.uptimeMs = Math.min(2592000000, now - startedAt);
        snapshot.visibility = document.visibilityState === 'visible' ? 'visible' : 'hidden';
        let snapshotText, eventsText;
        try {
            const memory = performance.memory;
            if (memory) snapshot.heap = { usedBytes: counter(memory.usedJSHeapSize, 1099511627776), totalBytes: counter(memory.totalJSHeapSize, 1099511627776), limitBytes: counter(memory.jsHeapSizeLimit, 1099511627776) };
            snapshotText = JSON.stringify(snapshot); eventsText = JSON.stringify(events);
            const entry = { schema: 1, documentId, state, startedAt, heartbeatAt: now, visibility: snapshot.visibility, ready: snapshot.ready, fatalReportId: safeId(api.fatalReportId) || null };
            const text = JSON.stringify(entry).slice(0, -1) + ',"snapshot":' + snapshotText + ',"events":' + eventsText + '}';
            // Canonical activity contains only ASCII enums, reviewed labels and safe IDs.
            if (text.length <= 8192) localStorage.setItem(SESSION_PREFIX + tabId, text);
        } catch { storageError = 'Browser storage is unavailable; activity cannot be retained after this page closes.'; }
        try {
            if (nativeToken && snapshotText && eventsText) {
                const text = '{"snapshot":' + snapshotText + ',"events":' + eventsText + '}';
                if (text.length <= 4096) globalThis.NeconyanDiagnostics?.recordActivity(nativeToken, text);
            }
        } catch { /* Native recording is optional and cannot block application work. */ }
        lastWrite = now; dirty = false;
    }
    function heartbeat() {
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
        if (document.visibilityState !== 'visible' || state !== 'running' || typeof setTimeout !== 'function') return;
        heartbeatTimer = setTimeout(() => { heartbeatTimer = null; flushActivity(); heartbeat(); }, 30000);
    }
    function guarded(callback) { return (...args) => { try { return callback(...args); } catch { return null; } }; }
    Object.assign(api, {
        updateActivity: guarded(updateActivity), noteActivity: guarded(noteActivity), flushActivity: guarded(flushActivity),
        getActivity: guarded(() => ({ snapshot: validateActivity(snapshot), events: validateEvents(events) })),
        beginAgent: guarded(input => {
            if (handles.size >= 128) return null;
            const id = own(input, 'id'), template = api.templateLabel(own(input, 'sourceTemplateId'));
            if (!template && !customLabels.has(id) && customLabels.size < 128) customLabels.set(id, `Custom agent ${customLabels.size + 1}`);
            const handle = ++nextHandle;
            handles.set(handle, { label: own(input, 'synthesis') === true ? 'Combined reply' : template || customLabels.get(id) || 'Custom agent 1', phase: choice(own(input, 'phase'), AGENT_PHASES), location: 'browser' });
            refreshAgents(); noteActivity('agent-start'); return handle;
        }),
        endAgent: guarded((handle, outcome) => { if (!handles.delete(handle)) return; refreshAgents(); noteActivity(outcome === 'error' ? 'agent-error' : outcome === 'cancel' ? 'agent-cancel' : 'agent-end'); }),
        observeJobActivity: guarded((id, handle, input) => {
            if (!input) {
                const old = observedJobs.get(id); old?.observers.delete(handle);
                if (!old?.observers.size) observedJobs.delete(id);
            } else if (observedJobs.has(id) || observedJobs.size < 32) {
                const agents = validateActivity({ agents: own(input, 'agents') }).agents;
                const old = observedJobs.get(id) || { observers: new Set() };
                old.observers.add(handle);
                const signature = JSON.stringify(agents);
                if (old.signature === signature) return;
                old.signature = signature; old.agents = agents;
                const incoming = validateEvents(own(input, 'events'));
                for (const event of incoming) if (event.at > (old.eventAt || 0)) events.push(event);
                old.eventAt = incoming.at(-1)?.at || old.eventAt || 0;
                events = events.slice(-12);
                observedJobs.set(id, old);
            }
            refreshAgents(); scheduleFlush();
        }),
        observePhase: guarded((handle, phase) => { if (PHASES.includes(phase) && phases.size < 32) phases.set(handle, phase); else { phases.delete(handle); if (!phases.size) snapshot.generation = { phase: 'idle', location: 'unknown' }; } refreshAgents(); scheduleFlush(); }),
        markAppReady: guarded(() => { snapshot.ready = true; api.fatalReportId = null; noteActivity('app-ready'); if (currentStartupNotice) dismissNotice(currentStartupNotice); }),
        setNativeBridgeToken: guarded(token => { if (typeof token !== 'string' || token.length > 100) return; nativeToken = token; scheduleFlush(); }),
    });
    try {
        const saved = localStorage.getItem(KEY);
        if (saved && saved.length <= 400000) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) reports = parsed.filter(report => report?.schema === 1).slice(-5).map(report => ({ ...report, id: safeId(report.id) || legacyId(report) }));
        }
    } catch { storageError = 'Browser storage is unavailable; reports last only until this page closes.'; }

    function breadcrumb(type) {
        activity.push({ at: new Date().toISOString(), type });
        if (activity.length > 30) activity.shift();
    }

    function save() {
        unsaved = false;
        try { localStorage.setItem(KEY, JSON.stringify(reports)); storageError = ''; } catch { storageError = 'Could not save to browser storage. Copy or download these reports before closing the page.'; }
    }

    function capture(kind, error, context = {}) {
        if (capturing) return null;
        capturing = true;
        try {
            const described = describeError(error);
            const where = {
                source: redact(field(context, 'source')), tag: redact(field(context, 'tag'), 20),
                line: Number(field(context, 'line')) || 0, column: Number(field(context, 'column')) || 0,
            };
            const last = reports[reports.length - 1];
            // A failing loop must not evict the first report or write storage on every frame.
            if (last && last.startedAt === startedAt && last.kind === kind && last.error?.message === described.message
                && last.error?.stack === described.stack && JSON.stringify(last.context) === JSON.stringify(where)) {
                last.repeats = (last.repeats || 1) + 1;
                last.lastAt = new Date().toISOString();
                if ((last.repeats & (last.repeats - 1)) === 0) save(); else unsaved = true;
                return last;
            }
            const report = {
                schema: 1, id: randomId(), runtime: 'browser', kind, at: new Date().toISOString(), startedAt,
                error: described, context: where,
                environment: {
                    userAgent: navigator.userAgent, platform: navigator.platform,
                    appVersion: document.getElementById('version_display')?.textContent?.trim()?.slice(0, 200) || 'Startup not completed',
                    viewport: `${window.innerWidth}x${window.innerHeight}`, devicePixelRatio: window.devicePixelRatio,
                    online: navigator.onLine, visibility: document.visibilityState,
                    uptimeMs: Date.now() - startedAt,
                    memory: performance.memory ? {
                        usedJSHeapSize: performance.memory.usedJSHeapSize,
                        totalJSHeapSize: performance.memory.totalJSHeapSize,
                        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
                    } : 'Not exposed by this browser',
                },
                activity: activity.slice(),
                lastKnownActivity: { snapshot: validateActivity(snapshot), events: validateEvents(events), relationship: 'same-page', ageMs: Math.max(0, Date.now() - (snapshot.at || startedAt)) },
                limitation: 'An unhandled error does not necessarily stop the page. Browser process kills cannot run JavaScript; their cause is unavailable here.',
            };
            // Bound each report even when nested AggregateErrors have large stacks.
            if (JSON.stringify(report).length > 60000) report.error = { ...described, cause: 'Omitted: report size limit', errors: undefined };
            reports.push(report);
            reports = reports.slice(-5);
            save();
            return report;
        } catch { return null; } finally { capturing = false; }
    }

    api.capture = capture;
    api.getReports = () => JSON.parse(JSON.stringify({ reports, storageError, retainedActivities }));
    api.clear = () => {
        reports = [];
        unsaved = false;
        try { localStorage.removeItem(KEY); storageError = ''; return true; } catch { return false; }
    };
    const SEEN_KEY = 'neconyan.crash-notice-seen.v1';
    let seen = [], pendingRecovery = null, currentStartupNotice = null;
    try {
        const text = localStorage.getItem(SEEN_KEY);
        if (text && text.length <= 4096) seen = JSON.parse(text).filter(item => safeId(item?.id) && Number.isSafeInteger(item?.at)).slice(-32);
    } catch { /* In-memory acknowledgement still works for this document. */ }
    function markSeen(id) {
        if (!safeId(id)) return;
        seen = [...seen.filter(item => item.id !== id), { id, at: Date.now() }].slice(-32);
        try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* No persistence is available. */ }
    }
    function dismissNotice(notice) {
        if (!notice) return;
        notice.remove?.();
        try { if (notice.jquery) globalThis.toastr?.remove?.(notice); } catch { /* It may have already closed. */ }
    }
    function fallbackReader(id) {
        const template = document.getElementById('popup_template');
        const dialog = template?.content?.querySelector('dialog.popup')?.cloneNode(true);
        if (!dialog) return;
        const previousFocus = document.activeElement;
        for (const node of dialog.querySelectorAll('.popup-crop-wrap, .popup-input, .popup-inputs, .popup-button-close')) node.remove();
        const content = dialog.querySelector('.popup-content'); content.replaceChildren();
        const textarea = document.createElement('textarea'); textarea.className = 'text_pole'; textarea.rows = 14; textarea.readOnly = true;
        textarea.value = redact(JSON.stringify(reports.find(report => report.id === id) || reports.at(-1) || 'No saved report', null, 2), 60000);
        textarea.setAttribute('aria-label', 'Saved crash reports'); content.append(textarea);
        const controls = dialog.querySelector('.popup-controls'); controls.replaceChildren();
        for (const label of ['Copy report', 'Close']) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button'; button.textContent = label;
            button.addEventListener('click', () => { if (label === 'Close') dialog.close(); else { textarea.select(); try { document.execCommand('copy'); } catch { /* Selectable text remains available. */ } } }); controls.append(button);
        }
        dialog.addEventListener('close', () => { dialog.remove(); if (previousFocus?.isConnected) previousFocus.focus(); });
        document.body.append(dialog); dialog.showModal();
    }
    api.openReports = guarded(id => {
        return import('./crash-report-reader.js').then(module => module.openCrashReportReader({ selectedReportId: id })).catch(() => fallbackReader(id));
    });
    api.showNotice = guarded(({ id, title, message, onRead, onDismiss }) => {
        const stylesheet = document.querySelector('link[href^="css/neconyan-crash-reports.css"]');
        if (stylesheet) stylesheet.rel = 'stylesheet';
        const content = document.createElement('div'); content.className = 'neconyan-crash-notice';
        const text = document.createElement('p'); text.textContent = redact(message, 1000); content.append(text);
        const actions = document.createElement('div'); actions.className = 'sbdbg-actions'; content.append(actions);
        for (const label of ['Read report', 'Dismiss']) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button' + (label === 'Read report' ? ' menu_button_primary' : ''); button.textContent = label; button.dataset.i18n = label;
            button.dataset.crashAction = label === 'Read report' ? 'read' : 'dismiss'; actions.append(button);
        }
        let notice;
        const dismiss = () => { markSeen(id); onDismiss?.(); dismissNotice(notice); };
        if (globalThis.toastr?.warning) {
            const heading = document.createElement('span'); heading.textContent = typeof title === 'string' ? redact(title, 200) : 'Crash report';
            notice = globalThis.toastr.warning(content.outerHTML, heading.innerHTML, { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, positionClass: 'toast-top-center', onHidden: () => { markSeen(id); onDismiss?.(); } });
            const node = notice?.[0];
            node?.querySelector('[data-crash-action="read"]')?.addEventListener('click', event => { event.stopPropagation(); markSeen(id); if (onRead) onRead(); else api.openReports(id); });
            node?.querySelector('[data-crash-action="dismiss"]')?.addEventListener('click', event => { event.stopPropagation(); dismiss(); });
        } else {
            notice = document.createElement('aside'); notice.id = 'neconyan-crash-notice'; notice.setAttribute('aria-label', title);
            const heading = document.createElement('strong'); heading.textContent = title; notice.append(heading, content); document.body.append(notice);
            actions.querySelector('[data-crash-action="read"]').addEventListener('click', () => { markSeen(id); if (onRead) onRead(); else api.openReports(id); });
            actions.querySelector('[data-crash-action="dismiss"]').addEventListener('click', dismiss);
        }
        if (!notice || !(notice[0] || notice).isConnected) return null;
        markSeen(id);
        return notice;
    });
    function recoverPrevious() {
        const discarded = document.wasDiscarded === true;
        if (!discarded && (previousSession?.state !== 'running' || !safeId(previousSession.documentId))) return;
        const id = discarded && !safeId(previousSession?.documentId) ? 'discarded:' + documentId : 'unclean:' + previousSession.documentId;
        if (seen.some(item => item.id === id) || reports.some(report => report.id === id)) return;
        const previous = validateActivity(previousSession?.snapshot);
        const report = capture(discarded ? 'discarded-previous-page' : 'unclean-previous-page', 'Your browser did not provide a definite cause. A missing normal-close event does not prove a crash.');
        if (!report) return;
        report.id = id;
        report.summary = discarded ? 'Your browser discarded the previous page' : 'The previous page did not close cleanly';
        report.environment = { measuredOnRecovery: report.environment };
        const heartbeatAt = counter(previousSession?.heartbeatAt, Number.MAX_SAFE_INTEGER);
        report.lastKnownActivity = { snapshot: previous, events: validateEvents(previousSession?.events), relationship: previous.at ? 'same-tab-previous-page' : 'unavailable',
            ageMs: previous.at && heartbeatAt >= previous.at ? heartbeatAt - previous.at : null };
        report.limitation = 'The time and cause of the stop are unknown. Backgrounding does not imply a crash; a normal pagehide prevents this observation. Other tabs are never automatically diagnosed.';
        pendingRecovery = report; if (previousSession) previousSession.state = 'recovered'; save();
    }
    recoverPrevious();
    function showPendingNotice() {
        if (document.visibilityState !== 'visible') return;
        const native = typeof globalThis.NeconyanDiagnostics?.recordActivity === 'function';
        let report = api.fatalReportId ? reports.find(item => item.id === api.fatalReportId) : !native ? pendingRecovery : null;
        if (!report && previousSession?.fatalReportId && !previousSession.ready) report = reports.find(item => item.id === previousSession.fatalReportId);
        if (!report || seen.some(item => item.id === (report.noticeId || report.id))) return;
        const sample = report.lastKnownActivity?.snapshot;
        const labels = sample?.agents?.running?.map(item => item.label).join(' and ');
        const message = (report.error?.message || 'Your browser did not provide a definite cause.')
            + (sample?.chat?.messageCount != null ? ` Last known activity: ${sample.chat.messageCount} messages.` : '')
            + (labels ? ` Running ${labels} after a reply.` : '')
            + (sample?.at ? ` Last activity recorded at ${new Date(sample.at).toLocaleTimeString()}.` : '')
            + (storageError ? ` ${storageError}` : '');
        const notice = api.showNotice({ id: report.noticeId || report.id, title: report.summary || 'Neconyan could not finish loading', message, onRead: () => api.openReports(report.id) });
        if (api.fatalReportId === report.id) currentStartupNotice = notice;
    }
    document.addEventListener('DOMContentLoaded', showPendingNotice, { once: true });
    document.addEventListener('visibilitychange', showPendingNotice);
    window.addEventListener('error', event => {
        if (event.target && event.target !== window) {
            const tag = event.target.tagName;
            if (tag !== 'SCRIPT' && tag !== 'LINK') return;
            const report = capture('resource-load-failure', 'A script or stylesheet could not load', {
                source: redact(event.target.src || event.target.href || ''), tag,
            });
            let pathname = '';
            try { pathname = new URL(event.target.src, document.baseURI).pathname; } catch { /* Not a static core script. */ }
            if (!snapshot.ready && tag === 'SCRIPT' && (event.target.hasAttribute?.('data-neconyan-core-script') || ['/script.js', '/scripts/neconyan-tabs.js', '/scripts/i18n.js', '/lib/jquery-3.5.1.min.js', '/lib/polyfill.js'].includes(pathname)) && report) {
                report.kind = 'critical-startup-load-failure'; report.summary = 'Neconyan could not finish loading';
                report.noticeId = 'startup:' + documentId;
                api.fatalReportId = report.id; save(); scheduleFlush();
                if (document.readyState !== 'loading') showPendingNotice();
            }
            return;
        }
        capture('uncaught-exception', event.error || event.message, {
            source: redact(event.filename || ''), line: event.lineno, column: event.colno,
        });
    }, true);
    window.addEventListener('unhandledrejection', event => capture('unhandled-rejection', event.reason));
    for (const type of ['online', 'offline', 'pageshow', 'pagehide']) window.addEventListener(type, () => breadcrumb(type));
    window.addEventListener('pagehide', event => {
        if (unsaved) save();
        state = event?.persisted ? 'suspended' : 'closed';
        noteActivity('pagehide'); flushActivity('pagehide');
        if (flushTimer !== null) clearTimeout(flushTimer); flushTimer = null;
        heartbeat();
    });
    window.addEventListener('pageshow', event => { if (event?.persisted) { state = 'running'; noteActivity('pageshow'); scheduleFlush(); heartbeat(); } });
    document.addEventListener('visibilitychange', () => { breadcrumb(`visibility:${document.visibilityState}`); noteActivity('visibility'); flushActivity('visibility'); heartbeat(); });
    breadcrumb('capture-started');
    scheduleFlush(); heartbeat();
})();
