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

    const api = { redact, describeError };
    globalThis.NeconyanCrashDiagnostics = api;
    if (typeof window === 'undefined' || !window.document) return;

    let reports = [];
    let storageError = '';
    let capturing = false;
    let unsaved = false;
    const activity = [];
    const startedAt = Date.now();
    try {
        const saved = localStorage.getItem(KEY);
        if (saved && saved.length <= 400000) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) reports = parsed.filter(report => report?.schema === 1).slice(-5);
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
                schema: 1, runtime: 'browser', kind, at: new Date().toISOString(), startedAt,
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
    api.getReports = () => JSON.parse(JSON.stringify({ reports, storageError }));
    api.clear = () => {
        reports = [];
        unsaved = false;
        try { localStorage.removeItem(KEY); storageError = ''; return true; } catch { return false; }
    };
    window.addEventListener('error', event => {
        if (event.target && event.target !== window) {
            const tag = event.target.tagName;
            if (tag !== 'SCRIPT' && tag !== 'LINK') return;
            capture('resource-load-failure', 'A script or stylesheet could not load', {
                source: redact(event.target.src || event.target.href || ''), tag,
            });
            return;
        }
        capture('uncaught-exception', event.error || event.message, {
            source: redact(event.filename || ''), line: event.lineno, column: event.colno,
        });
    }, true);
    window.addEventListener('unhandledrejection', event => capture('unhandled-rejection', event.reason));
    for (const type of ['online', 'offline', 'pageshow', 'pagehide']) window.addEventListener(type, () => breadcrumb(type));
    window.addEventListener('pagehide', () => { if (unsaved) save(); });
    document.addEventListener('visibilitychange', () => breadcrumb(`visibility:${document.visibilityState}`));
    breadcrumb('capture-started');
})();
