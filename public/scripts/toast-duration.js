export const MIN_AUTO_CLOSE_TOAST_MS = 5000;
export const MAX_VISIBLE_ALERT_TOASTS = 4;

const TOAST_METHODS = ['info', 'success', 'warning', 'error'];
const ALERT_METHODS = new Set(['warning', 'error']);
const CALLBACK_OPTIONS = ['onclick', 'onShown', 'onHidden', 'onCloseClick'];
const ALERT_QUEUE_CHECK_MS = 250;
const LOG_TEXT_LIMIT = 600;
const INSTALLED = Symbol.for('neconyan.toastMinimumDuration');

function raiseDuration(value) {
    return typeof value === 'number' && value > 0 && value < MIN_AUTO_CLOSE_TOAST_MS
        ? MIN_AUTO_CLOSE_TOAST_MS
        : value;
}

/**
 * Returns toast options where any auto-close delay shorter than the minimum is raised to it.
 * Zero (stay until dismissed) and longer delays are left alone.
 * @param {object} [options]
 * @returns {object|undefined}
 */
export function withMinimumToastDuration(options) {
    if (!options || typeof options !== 'object') {
        return options;
    }
    let raised = options;
    for (const key of ['timeOut', 'extendedTimeOut']) {
        const value = raiseDuration(options[key]);
        if (value !== options[key]) {
            raised = { ...raised, [key]: value };
        }
    }
    return raised;
}

function isPlainText(value) {
    return typeof value === 'string' || typeof value === 'number';
}

/**
 * Identical notices share a key. Notices built from elements or carrying their own callbacks never do,
 * because each call expects its own toast.
 */
function duplicateKey(method, message, title, options, autoCloses) {
    if (!isPlainText(message) || !(title === undefined || title === null || isPlainText(title))) {
        return null;
    }
    if (options && CALLBACK_OPTIONS.some(name => typeof options[name] === 'function')) {
        return null;
    }
    return JSON.stringify([method, String(title ?? ''), String(message), autoCloses]);
}

function readableText(value, allowsHtml) {
    let text = '';
    if (isPlainText(value)) {
        text = String(value);
        if (allowsHtml) {
            text = text.replace(/<[^>]*>/g, ' ');
        }
    } else if (value && typeof value === 'object') {
        if (typeof value.text === 'function') {
            text = String(value.text() ?? '');
        } else if (typeof value.textContent === 'string') {
            text = value.textContent;
        }
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > LOG_TEXT_LIMIT ? `${text.slice(0, LOG_TEXT_LIMIT)}...` : text;
}

function logAlertToast(method, message, title, settings, note = '') {
    const allowsHtml = settings.escapeHtml === false;
    const text = [readableText(title, allowsHtml), readableText(message, allowsHtml)].filter(Boolean).join(' - ');
    const kind = method === 'error' ? 'Error' : 'Warning';
    // A warning rather than an error: the notice is expected app behaviour, and the code that hit a real fault logs it itself.
    console.warn(`[Neconyan] ${kind} notice${note ? ` (${note})` : ''}: ${text || '(no text)'}`);
}

function toastElement(toast) {
    const element = toast && typeof toast.triggerHandler === 'function' ? toast[0] : null;
    return element && typeof element.isConnected === 'boolean' ? element : null;
}

function isInUse(entry) {
    const { element } = entry;
    if (typeof element.matches === 'function' && element.matches(':hover')) {
        return true;
    }
    const active = globalThis.document?.activeElement;
    return Boolean(active && typeof element.contains === 'function' && element.contains(active));
}

/**
 * Keeps error and warning toasts readable during a burst: an identical notice already on screen is
 * kept and its close timer restarted, and at most MAX_VISIBLE_ALERT_TOASTS auto-closing notices show
 * at once. Extra ones wait hidden until a visible one closes or has been up for the minimum time.
 */
function createAlertToastGuard(toastrApi) {
    const entries = [];
    let queueTimer = null;

    function prune() {
        for (let index = entries.length - 1; index >= 0; index--) {
            if (!entries[index].element.isConnected) {
                entries.splice(index, 1);
            }
        }
    }

    // toastr pauses a toast's close timer on mouseenter and restarts it on mouseleave.
    function restartCloseTimer(entry) {
        entry.toast.triggerHandler('mouseenter');
        entry.toast.triggerHandler('mouseleave');
    }

    function hold(entry) {
        entry.toast.triggerHandler('mouseenter');
        entry.toast.stop?.(true, true);
        entry.toast.hide?.();
        entry.held = true;
    }

    function reveal(entry) {
        entry.held = false;
        entry.shownAt = Date.now();
        restartCloseTimer(entry);
    }

    function makeRoom() {
        let visible = entries.filter(entry => entry.autoCloses && !entry.held && !entry.closing);
        while (visible.length >= MAX_VISIBLE_ALERT_TOASTS) {
            const now = Date.now();
            const oldest = visible
                .filter(entry => now - entry.shownAt >= MIN_AUTO_CLOSE_TOAST_MS && !isInUse(entry))
                .sort((a, b) => a.shownAt - b.shownAt)[0];
            if (!oldest) {
                return false;
            }
            oldest.closing = true;
            toastrApi.clear?.(oldest.toast, { force: true });
            visible = visible.filter(entry => entry !== oldest);
        }
        return true;
    }

    function scheduleQueueCheck() {
        if (queueTimer || !entries.some(entry => entry.held)) {
            return;
        }
        queueTimer = setTimeout(() => {
            queueTimer = null;
            releaseHeld();
        }, ALERT_QUEUE_CHECK_MS);
    }

    function releaseHeld() {
        prune();
        for (const entry of entries.filter(item => item.held)) {
            if (!makeRoom()) {
                break;
            }
            reveal(entry);
        }
        scheduleQueueCheck();
    }

    function show(method, original, thisArg, message, title, options, rest) {
        releaseHeld();
        const settings = { ...(toastrApi.options || {}), ...(options || {}) };
        const autoCloses = Number(settings.timeOut ?? 5000) > 0;
        const canPause = autoCloses && Number(settings.extendedTimeOut ?? 1000) > 0 && settings.closeOnHover !== false;
        const key = duplicateKey(method, message, title, options, autoCloses);

        const existing = key ? entries.find(entry => entry.key === key && !entry.closing) : null;
        if (existing) {
            if (!existing.held && existing.canPause && !isInUse(existing)) {
                restartCloseTimer(existing);
            }
            // A toast caught mid fade-out is finished and removed by the restart; show a fresh one then.
            if (existing.element.isConnected) {
                existing.repeats += 1;
                if (existing.repeats === 1) {
                    logAlertToast(method, message, title, settings, 'repeated, kept the one already on screen');
                }
                return existing.toast;
            }
            prune();
        }

        const toast = original.call(thisArg, message, title, options, ...rest);
        if (!toast) {
            return toast;
        }
        const element = toastElement(toast);
        if (!element) {
            logAlertToast(method, message, title, settings);
            return toast;
        }

        const entry = { key, toast, element, autoCloses, canPause, held: false, closing: false, shownAt: Date.now(), repeats: 0 };
        let note = '';
        if (autoCloses) {
            const queued = entries.some(item => item.held);
            if ((queued || !makeRoom()) && canPause) {
                hold(entry);
                note = 'waiting for space on screen';
            }
        }
        entries.push(entry);
        scheduleQueueCheck();
        logAlertToast(method, message, title, settings, note);
        return toast;
    }

    return { show };
}

/**
 * Makes every auto-closing toast stay on screen for at least MIN_AUTO_CLOSE_TOAST_MS, keeps bursts of
 * error and warning toasts from stacking duplicates or flooding the screen, and writes every error and
 * warning toast to the console.
 * @param {object} toastrApi The global toastr object
 */
export function installToastMinimumDuration(toastrApi) {
    if (!toastrApi || toastrApi[INSTALLED]) {
        return;
    }
    if (toastrApi.options) {
        toastrApi.options = withMinimumToastDuration(toastrApi.options);
    }
    const guard = createAlertToastGuard(toastrApi);
    for (const method of TOAST_METHODS) {
        const original = toastrApi[method];
        if (typeof original !== 'function') {
            continue;
        }
        toastrApi[method] = ALERT_METHODS.has(method)
            ? function (message, title, optionsOverride, ...rest) {
                return guard.show(method, original, this, message, title, withMinimumToastDuration(optionsOverride), rest);
            }
            : function (message, title, optionsOverride, ...rest) {
                return original.call(this, message, title, withMinimumToastDuration(optionsOverride), ...rest);
            };
    }
    toastrApi[INSTALLED] = true;
}
