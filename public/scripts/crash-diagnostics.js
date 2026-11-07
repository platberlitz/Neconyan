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
            visibility: choice(own(input, 'visibility'), ['visible', 'hidden', 'unknown']) };
        for (const [section, fields] of Object.entries({
            chat: ['messageCount', 'estimatedTextBytes', 'sampledMessages', 'agentHistoryEntries', 'measuredAt'],
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
    function isIOSWebKitBrowser() {
        try {
            if (typeof navigator === 'undefined') return false;
            const userAgent = String(navigator.userAgent || '');
            const platform = String(navigator.platform || '');
            const isIPadOSDesktop = platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
            return (/iPad|iPhone|iPod/.test(userAgent) || /iPad|iPhone|iPod/.test(platform) || isIPadOSDesktop)
                && /WebKit/i.test(userAgent);
        } catch { return false; }
    }
    // Pure decision shared by the live guard and its unit tests.
    function evaluateStartupGuard({ storedCount = 0, previous = null } = {}) {
        const previousCount = Number.isSafeInteger(storedCount) && storedCount > 0 ? Math.min(storedCount, 99) : 0;
        const unfinished = Boolean(previous && previous.state === 'running' && previous.ready !== true);
        const count = unfinished ? Math.min(99, previousCount + 1) : previous ? 0 : previousCount;
        return { count, unfinished, safeStart: unfinished && count >= 2 };
    }
    const api = { redact, describeError, validateActivity, validateEvents, safeAgentLabel, templateLabel: id => typeof id === 'string' ? own(LABELS, id) || null : null, isIOSWebKitBrowser, evaluateStartupGuard };
    globalThis.NeconyanCrashDiagnostics = api;
    if (typeof window === 'undefined' || !window.document) return;

    let reports = [];
    let storageError = '';
    let capturing = false;
    let unsaved = false;
    const activity = [];
    const startedAt = Date.now();
    const SESSION_PREFIX = 'neconyan.crash-session.v1:';
    const RECOVERY_KEY = 'neconyan.crash-recoveries.v1';
    const STARTUP_FAILURES_KEY = 'neconyan.crash-startup-failures.v1';
    const LOW_MEMORY_MODE_KEY = 'neconyan:low-memory-mode:v1';
    let recoveries = [];
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
        const keys = [];
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (key?.startsWith(SESSION_PREFIX) && key !== SESSION_PREFIX + tabId) keys.push(key);
        }
        const retained = [];
        for (const key of keys) {
            const value = localStorage.getItem(key);
            if (value?.length > 8192) { localStorage.removeItem(key); continue; }
            try {
                const entry = JSON.parse(value);
                if (entry?.schema !== 1 || !Number.isSafeInteger(entry.heartbeatAt) || Date.now() - entry.heartbeatAt > 604800000) localStorage.removeItem(key);
                else retained.push({ key, entry });
            } catch { localStorage.removeItem(key); }
        }
        retained.sort((a, b) => b.entry.heartbeatAt - a.entry.heartbeatAt);
        for (const item of retained.slice(7)) localStorage.removeItem(item.key);
        if (previousSession && Date.now() - previousSession.heartbeatAt > 604800000) previousSession = null;
        for (const item of retained.slice(0, 7)) {
            if (item.entry?.schema === 1 && item.entry.snapshot) retainedActivities.push({ schema: 1, id: 'activity:' + safeId(item.entry.documentId), runtime: 'browser', kind: 'retained-page-activity',
                at: Number.isSafeInteger(item.entry.heartbeatAt) ? new Date(item.entry.heartbeatAt).toISOString() : null,
                lastKnownActivity: { snapshot: validateActivity(item.entry.snapshot), events: validateEvents(item.entry.events) },
                limitation: 'Activity from another tab. This is not a crash report and never triggers an automatic notice.' });
        }
    } catch { /* Storage may be blocked. The current in-memory sample remains available. */ }

    let startupFailureCount = 0;
    let startupSafeStart = false;
    let startupSafeStartShown = false;
    let startupLowMemoryAuto = false;
    let startupHoldActive = false;
    let startupHoldChoice = null;
    let startupGatePromise = null;
    let startupGateResolve = null;
    let startupSurfaceRestore = null;

    function readStartupFailureCount() {
        try {
            const text = localStorage.getItem(STARTUP_FAILURES_KEY);
            if (!text || text.length > 512) return 0;
            const value = JSON.parse(text);
            return Number.isSafeInteger(value?.count) && value.count > 0 ? Math.min(value.count, 99) : 0;
        } catch { return 0; }
    }
    function writeStartupFailureCount(count) {
        try {
            if (!count) { localStorage.removeItem(STARTUP_FAILURES_KEY); return; }
            localStorage.setItem(STARTUP_FAILURES_KEY, JSON.stringify({ schema: 1, count, at: Date.now() }));
        } catch { /* The safe start still works for this page without persistence. */ }
    }
    function rememberStartupOutcome() {
        const decision = evaluateStartupGuard({ storedCount: readStartupFailureCount(), previous: previousSession });
        startupFailureCount = decision.count;
        startupSafeStart = decision.safeStart;
        if (decision.unfinished || previousSession) writeStartupFailureCount(startupFailureCount);
        // iPhones expose no deviceMemory, so a loop is the only signal they give us.
        // Respect an explicit off; the safe start still offers low-memory mode by hand.
        if (startupSafeStart && isIOSWebKitBrowser()) {
            try {
                const mode = localStorage.getItem(LOW_MEMORY_MODE_KEY);
                if (mode !== 'on' && mode !== 'off') {
                    localStorage.setItem(LOW_MEMORY_MODE_KEY, 'on');
                    startupLowMemoryAuto = true;
                }
            } catch { /* The mode choice below still sets it when storage allows. */ }
        }
    }
    function resetStartupFailures() {
        startupFailureCount = 0;
        startupSafeStart = false;
        try { localStorage.removeItem(STARTUP_FAILURES_KEY); } catch { /* Storage may be blocked. */ }
    }
    rememberStartupOutcome();

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
            const id = own(input, 'id'), template = own(input, 'synthesis') === true ? 'Combined reply' : api.templateLabel(own(input, 'sourceTemplateId'));
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
        observePhase: guarded((handle, phase) => { if (PHASES.includes(phase) && (phases.has(handle) || phases.size < 32)) phases.set(handle, phase); else if (!PHASES.includes(phase)) { phases.delete(handle); if (!phases.size) snapshot.generation = { phase: 'idle', location: 'unknown' }; } refreshAgents(); scheduleFlush(); }),
        markAppReady: guarded(() => { snapshot.ready = true; api.fatalReportId = null; noteActivity('app-ready'); resetStartupFailures(); if (currentStartupNotice) dismissNotice(currentStartupNotice); try { flushActivity('app-ready'); } catch { /* Diagnostics cannot block startup. */ } }),
        // The boot loader is gone, but characters and the last chat may still be
        // loading. Only the app's own ready event means startup really finished.
        markBootLoaderComplete: guarded(() => { api.fatalReportId = null; if (currentStartupNotice) dismissNotice(currentStartupNotice); }),
        setNativeBridgeToken: guarded(token => { if (typeof token !== 'string' || token.length > 100) return; nativeToken = token; scheduleFlush(); }),
    });
    try {
        const saved = localStorage.getItem(KEY);
        if (saved && saved.length <= 400000) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) reports = parsed.filter(report => report?.schema === 1).slice(-5).map(report => ({ ...report, id: safeId(report.id) || legacyId(report) }));
        }
        const recoveryText = localStorage.getItem(RECOVERY_KEY);
        if (recoveryText && recoveryText.length <= 65536) {
            const parsed = JSON.parse(recoveryText);
            if (Array.isArray(parsed)) recoveries = parsed.filter(report => report?.schema === 1 && safeId(report.id)).slice(-8);
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
    api.updateReport = (id, error) => {
        if (capturing || !safeId(id)) return null;
        const report = reports.find(item => item.id === id);
        if (!report) return null;
        capturing = true;
        try {
            const described = describeError(error);
            report.error = described;
            if (JSON.stringify(report).length > 60000) report.error = { ...described, cause: 'Omitted: report size limit', errors: undefined };
            save();
            return report;
        } catch { return null; } finally { capturing = false; }
    };
    api.getReports = () => JSON.parse(JSON.stringify({ reports, recoveries, storageError, retainedActivities }));
    api.clear = () => {
        reports = [];
        recoveries = [];
        unsaved = false;
        try { localStorage.removeItem(KEY); localStorage.removeItem(RECOVERY_KEY); storageError = ''; return true; } catch { return false; }
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
        textarea.value = redact(JSON.stringify(reports.find(report => report.id === id) || recoveries.find(report => report.id === id) || reports.at(-1) || recoveries.at(-1) || 'No saved report', null, 2), 60000);
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
        return import('./crash-report-reader.js?v=20261105-ios-safe-start').then(module => module.openCrashReportReader({ selectedReportId: id })).catch(() => fallbackReader(id));
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
        const existing = document.getElementById('neconyan-crash-notice'); existing?.remove();
        let notice;
        const dismiss = () => { markSeen(id); onDismiss?.(); dismissNotice(notice); };
        notice = document.createElement('aside'); notice.id = 'neconyan-crash-notice'; notice.setAttribute('aria-label', title); notice.setAttribute('role', 'status');
        const heading = document.createElement('strong'); heading.textContent = typeof title === 'string' ? redact(title, 200) : 'Crash report'; notice.append(heading, content); document.body.append(notice);
        actions.querySelector('[data-crash-action="read"]').addEventListener('click', () => { markSeen(id); if (onRead) onRead(); else api.openReports(id); });
        actions.querySelector('[data-crash-action="dismiss"]').addEventListener('click', dismiss);
        if (!notice || !(notice[0] || notice).isConnected) return null;
        markSeen(id);
        return notice;
    });
    function recoveryEnvironment() {
        const memory = globalThis.performance?.memory;
        return {
            measuredAt: new Date().toISOString(), measured: 'on-recovery',
            userAgent: typeof navigator?.userAgent === 'string' ? navigator.userAgent.slice(0, 200) : '',
            viewport: typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? `${window.innerWidth}x${window.innerHeight}` : null,
            deviceMemory: Number.isFinite(navigator?.deviceMemory) ? navigator.deviceMemory : null,
            memory: memory ? { usedBytes: counter(memory.usedJSHeapSize, 1099511627776), totalBytes: counter(memory.totalJSHeapSize, 1099511627776), limitBytes: counter(memory.jsHeapSizeLimit, 1099511627776) } : null,
        };
    }
    function recoverPrevious() {
        const discarded = document.wasDiscarded === true;
        if (!discarded && (previousSession?.state !== 'running' || !safeId(previousSession.documentId))) return;
        const id = discarded && !safeId(previousSession?.documentId) ? 'discarded:' + documentId : 'unclean:' + previousSession.documentId;
        if (seen.some(item => item.id === id) || recoveries.some(report => report.id === id)) return;
        const previous = validateActivity(previousSession?.snapshot);
        const report = { schema: 1, id, runtime: 'browser', kind: discarded ? 'discarded-previous-page' : 'unclean-previous-page', at: new Date().toISOString(),
            error: { message: 'Your browser did not provide a definite cause. A missing normal-close event does not prove a crash.' } };
        report.summary = discarded ? 'Your browser discarded the previous page' : 'The previous page did not close cleanly';
        // Device details measured when the page reopened, not at the failure; labelled as such.
        report.environment = recoveryEnvironment();
        const heartbeatAt = counter(previousSession?.heartbeatAt, Number.MAX_SAFE_INTEGER);
        report.lastKnownActivity = { snapshot: previous, events: validateEvents(previousSession?.events), relationship: previous.at ? 'same-tab-previous-page' : 'unavailable',
            ageMs: previous.at && heartbeatAt >= previous.at ? heartbeatAt - previous.at : null };
        report.limitation = 'The time and cause of the stop are unknown. Backgrounding does not imply a crash; a normal pagehide prevents this observation. Other tabs are never automatically diagnosed.';
        recoveries.push(report); recoveries = recoveries.slice(-8);
        if (previousSession?.visibility === 'visible') pendingRecovery = report;
        if (previousSession) previousSession.state = 'recovered';
        try { localStorage.setItem(RECOVERY_KEY, JSON.stringify(recoveries)); } catch { storageError = 'Could not save recovery activity. Copy it before closing this page.'; }
    }
    recoverPrevious();
    function clearFrontendCachesBeforeReload() {
        const tasks = [];
        try {
            if ('caches' in window && window.caches?.keys) {
                tasks.push(window.caches.keys().then(keys => Promise.all(keys.map(key => window.caches.delete(key)))));
            }
        } catch { /* Cache Storage is unavailable in insecure contexts. */ }
        try {
            if (navigator.serviceWorker?.getRegistrations) {
                tasks.push(navigator.serviceWorker.getRegistrations().then(registrations => Promise.all(registrations.map(registration => registration.unregister()))));
            }
        } catch { /* Service workers are unavailable in insecure contexts. */ }
        return Promise.all(tasks).catch(() => {});
    }
    function safeStartButton(label, primary, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.dataset.i18n = label;
        button.style.cssText = 'width:100%;margin-top:10px;border-radius:12px;padding:12px 14px;min-height:44px;cursor:pointer;font-family:inherit;'
            + (primary
                ? 'border:1px solid var(--neco-ginger, ButtonText);background:var(--neco-ginger, ButtonFace);color:var(--neco-on-accent, ButtonText);font-weight:700;font-size:16px;'
                : 'border:1px solid var(--neco-ginger, ButtonText);background:transparent;color:var(--neco-ink, CanvasText);font-weight:600;font-size:15px;');
        button.addEventListener('click', onClick);
        return button;
    }
    function setLowMemoryMode(mode) {
        try { localStorage.setItem(LOW_MEMORY_MODE_KEY, mode); return true; } catch { return false; }
    }
    function applyLowMemoryChoice(mode) {
        setLowMemoryMode(mode);
        // script.js imports the runtime before the gate opens, so storage alone
        // would not change the mode this page is already holding.
        return import('./low-memory-mode.js')
            .then(module => { module.setLowMemoryMode?.(mode); })
            .catch(() => { /* The saved choice still applies on the next start. */ });
    }
    function restoreStartupSurface() {
        const preloader = document.getElementById('preloader');
        const saved = startupSurfaceRestore;
        startupSurfaceRestore = null;
        if (!preloader || !saved) return;
        preloader.innerHTML = saved.innerHTML;
        preloader.hidden = saved.hidden;
        if (saved.ariaHidden === null) preloader.removeAttribute('aria-hidden'); else preloader.setAttribute('aria-hidden', saved.ariaHidden);
        if (saved.role === null) preloader.removeAttribute('role'); else preloader.setAttribute('role', saved.role);
        preloader.removeAttribute('aria-modal');
        preloader.removeAttribute('aria-label');
        preloader.style.cssText = saved.style;
    }
    function resumeStartup(choice) {
        if (!startupHoldActive) return;
        startupHoldActive = false;
        startupHoldChoice = choice;
        restoreStartupSurface();
        try { globalThis.NeconyanBootGuard?.resumeAfterStartupHold?.(); } catch { /* The boot guard timeout is optional. */ }
        const resolve = startupGateResolve;
        startupGateResolve = null;
        resolve?.(choice);
        try { flushActivity('startup-choice'); } catch { /* Diagnostics cannot block startup. */ }
    }
    function applyPreBootPalette(preloader) {
        // Theme tokens are black until the saved theme loads. Use Calico Dark's
        // loading-screen palette locally so the screen is readable before that.
        for (const [name, value] of Object.entries({
            '--neco-canvas': '#161716', '--neco-surface': '#242420', '--neco-ink': '#f6edda',
            '--neco-muted': '#ddd0bf', '--neco-ginger': '#d69270', '--neco-border': '#61534d', '--neco-on-accent': '#141514',
        })) preloader.style.setProperty(name, value);
    }
    function safeStartReport() {
        if (previousSession?.fatalReportId) {
            const fatal = reports.find(report => report.id === previousSession.fatalReportId);
            if (fatal) return fatal;
        }
        return pendingRecovery || recoveries.at(-1) || null;
    }
    function showSafeStart() {
        const preloader = document.getElementById('preloader');
        if (!preloader || !document.body || typeof document.createElement !== 'function') return false;
        const report = safeStartReport();
        startupSurfaceRestore = { innerHTML: preloader.innerHTML, hidden: preloader.hidden, ariaHidden: preloader.getAttribute('aria-hidden'),
            role: preloader.getAttribute('role'), style: preloader.style.cssText };
        preloader.hidden = false;
        preloader.removeAttribute('aria-hidden');
        preloader.setAttribute('role', 'dialog');
        preloader.setAttribute('aria-modal', 'true');
        preloader.setAttribute('aria-label', 'Neconyan startup choices');
        preloader.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;'
            + 'background:var(--neco-canvas, Canvas);color:var(--neco-ink, CanvasText);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
            + 'backdrop-filter:none;-webkit-backdrop-filter:none;overflow:auto;';
        applyPreBootPalette(preloader);
        preloader.innerHTML = '';
        const panel = document.createElement('div');
        panel.id = 'neconyan-safe-start';
        panel.style.cssText = 'width:min(100%,520px);max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;padding:22px;'
            + 'border:1px solid var(--neco-border, GrayText);border-radius:18px;background:var(--neco-surface, Canvas);line-height:1.45;';
        const title = document.createElement('h1');
        title.textContent = 'Neconyan could not finish starting';
        title.style.cssText = 'margin:0 0 10px;font-size:22px;line-height:1.2;color:var(--neco-ink, CanvasText);';
        const message = document.createElement('p');
        message.textContent = `The last ${startupFailureCount === 2 ? 'two starts' : `${startupFailureCount} starts`} did not finish. Your characters, chats and reports are still available.`;
        message.style.cssText = 'margin:0 0 8px;color:var(--neco-ink, CanvasText);';
        const hint = document.createElement('p');
        hint.textContent = startupLowMemoryAuto
            ? 'Low-memory mode is on for this start: Neconyan loads fewer messages at once and turns off extra interface effects. You can turn it off in Settings later.'
            : 'Low-memory mode loads fewer messages at once and turns off extra interface effects, which gives the browser more room to finish starting.';
        hint.style.cssText = 'margin:0 0 16px;color:var(--neco-muted, GrayText);font-size:14px;';
        panel.append(title, message, hint);
        panel.append(safeStartButton('Start Neconyan', true, () => resumeStartup('start')));
        panel.append(safeStartButton('Read crash report', false, () => { api.openReports(report?.id); }));
        panel.append(startupLowMemoryAuto
            ? safeStartButton('Start without low-memory mode', false, () => { void applyLowMemoryChoice('off').then(() => resumeStartup('normal')); })
            : safeStartButton('Start in low-memory mode', false, () => { void applyLowMemoryChoice('on').then(() => resumeStartup('low-memory')); }));
        const clearButton = safeStartButton('Clear frontend cache and reload', false, () => {
            clearButton.disabled = true;
            clearButton.textContent = 'Clearing cache...';
            clearFrontendCachesBeforeReload().then(() => { resetStartupFailures(); window.location.reload(); });
        });
        panel.append(clearButton);
        const details = document.createElement('p');
        details.textContent = report?.lastKnownActivity?.snapshot?.at
            ? `Last activity recorded at ${new Date(report.lastKnownActivity.snapshot.at).toLocaleString()}.`
            : 'No earlier activity was recorded before the last start stopped.';
        details.style.cssText = 'margin:14px 0 0;color:var(--neco-muted, GrayText);font-size:13px;';
        panel.append(details);
        preloader.append(panel);
        try { panel.querySelector('button')?.focus(); } catch { /* Initial focus is a convenience. */ }
        try { document.getElementById('neconyan-crash-notice')?.remove(); } catch { /* The safe start has its own report action. */ }
        return true;
    }
    api.getStartupGuardState = () => ({ failures: startupFailureCount, safeStart: startupSafeStart, holdActive: startupHoldActive,
        choice: startupHoldChoice, lowMemoryAuto: startupLowMemoryAuto, ios: isIOSWebKitBrowser() });
    api.isStartupHoldActive = () => startupHoldActive;
    api.waitForStartupGate = guarded(() => {
        if (!startupSafeStart || startupHoldChoice) return Promise.resolve(startupHoldChoice);
        if (startupGatePromise) return startupGatePromise;
        startupHoldActive = true;
        if (!showSafeStart()) {
            startupHoldActive = false;
            startupSafeStart = false;
            return Promise.resolve(null);
        }
        startupSafeStartShown = true;
        startupGatePromise = new Promise(resolve => { startupGateResolve = resolve; });
        return startupGatePromise;
    });
    function showPendingNotice() {
        if (document.visibilityState !== 'visible' || startupSafeStartShown || startupHoldActive) return;
        const native = typeof globalThis.NeconyanDiagnostics?.recordActivity === 'function';
        let report = api.fatalReportId ? reports.find(item => item.id === api.fatalReportId) : !native ? pendingRecovery : null;
        if (!report && previousSession?.fatalReportId && !previousSession.ready) report = reports.find(item => item.id === previousSession.fatalReportId);
        if (!report || seen.some(item => item.id === (report.noticeId || report.id))) return;
        const sample = report.lastKnownActivity?.snapshot;
        const labels = sample?.agents?.running?.map(item => item.label).join(' and ');
        const timing = sample?.generation?.phase === 'pre-agents' ? 'before a reply' : sample?.generation?.phase === 'post-agents' ? 'after a reply' : sample?.generation?.phase === 'companions' ? 'during Companions' : 'during the last observed activity';
        const message = (report.error?.message || 'Your browser did not provide a definite cause.')
            + (sample?.chat?.messageCount != null ? ` Last known activity: ${sample.chat.messageCount} messages.` : '')
            + (labels ? ` Running ${labels} ${timing}.` : '')
            + (sample?.at ? ` Last activity recorded at ${new Date(sample.at).toLocaleTimeString()}.` : '')
            + (storageError ? ` ${storageError}` : '');
        const notice = api.showNotice({ id: report.noticeId || report.id, title: report.summary || 'Neconyan could not finish loading', message, onRead: () => api.openReports(report.id) });
        if (api.fatalReportId === report.id) currentStartupNotice = notice;
    }
    document.addEventListener('DOMContentLoaded', showPendingNotice, { once: true });
    document.addEventListener('visibilitychange', showPendingNotice);
    // script.js dispatches this after the last chat and the rest of startup.
    window.addEventListener('neconyan:ready', () => api.markAppReady?.());
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
