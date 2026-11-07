// Neconyan: surface fatal startup failures, with an additional iOS/WebKit module timeout guard.
(function () {
    'use strict';

    var bootCompleted = false;
    var failureShown = false;
    var failureDismissed = false;
    var failureReportId = '';
    var lastFailure = null;
    var timeoutId = null;
    var BOOT_TIMEOUT_MS = 25000;
    var BOOT_TIMEOUT_RETRY_MS = 10000;
    var MAX_BOOT_TIMEOUT_MS = 90000;
    var MODULE_DIAGNOSTIC_TIMEOUT_MS = 4000;
    var bootStartedAt = Date.now();

    // Neconyan: matched without a leading slash so relative extension URLs are recognised too.
    var THIRD_PARTY_EXTENSION_PATH = 'scripts/extensions/third-party/';
    // Only the marked entry modules are retried. A page or extension cannot choose another URL.
    var CORE_MODULE_PATHS = {
        '/script.js': true,
        '/scripts/i18n.js': true,
        '/scripts/neconyan-tabs.js': true,
    };
    var moduleDiagnosticsStarted = Object.create(null);
    var isBootGuardApplicable = isIOSWebKitBrowser();

    // Neconyan: jQuery rethrows whatever an async ready callback rejected with,
    // so startup failures often arrive as message-less objects such as a jqXHR.
    // These are the fields worth reading before falling back to enumeration.
    var ERROR_DETAIL_KEYS = ['name', 'code', 'status', 'statusText', 'readyState', 'type', 'url', 'responseText'];
    var MAX_ERROR_VALUE_LENGTH = 200;
    var MAX_ERROR_DETAIL_LENGTH = 800;

    // Neconyan: a rejected jqXHR does not carry its own URL, so failing requests are
    // tracked separately to name the endpoint that broke startup.
    var MAX_TRACKED_REQUEST_FAILURES = 5;
    var failedRequests = [];

    function isIOSWebKitBrowser() {
        try {
            if (typeof navigator === 'undefined') {
                return false;
            }

            if (typeof window !== 'undefined' && typeof window.NeconyanCrashDiagnostics?.isIOSWebKitBrowser === 'function') {
                return window.NeconyanCrashDiagnostics.isIOSWebKitBrowser();
            }

            var userAgent = String(navigator.userAgent || '');
            var platform = String(navigator.platform || '');
            var isiPadOSDesktopUA = platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1;
            var isIOS = /iPad|iPhone|iPod/.test(userAgent) || /iPad|iPhone|iPod/.test(platform) || isiPadOSDesktopUA;

            return isIOS && /WebKit/i.test(userAgent);
        } catch (_error) {
            return false;
        }
    }

    function isThirdPartyExtensionSource(value) {
        try {
            return String(value || '').indexOf(THIRD_PARTY_EXTENSION_PATH) !== -1;
        } catch (_error) {
            return false;
        }
    }

    function hasAttribute(element, name) {
        try {
            if (typeof element.hasAttribute === 'function') {
                return element.hasAttribute(name);
            }

            return Boolean(element.attributes && typeof element.attributes.has === 'function' && element.attributes.has(name));
        } catch (_error) {
            return false;
        }
    }

    // Returns the exact URL a core module failed from, or an empty string for anything else.
    function coreModuleDiagnosticUrl(target) {
        try {
            if (!target || String(target.tagName || '').toUpperCase() !== 'SCRIPT') {
                return '';
            }

            if (String(target.type || '').toLowerCase() !== 'module' || !hasAttribute(target, 'data-neconyan-core-script')) {
                return '';
            }

            var source = String(target.src || '');

            if (!source) {
                return '';
            }

            var parsed = new URL(source, window.location.href);

            if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== window.location.origin) {
                return '';
            }

            return CORE_MODULE_PATHS[parsed.pathname] ? parsed.href : '';
        } catch (_error) {
            return '';
        }
    }

    function truncate(value, limit) {
        var text = String(value);
        return text.length > limit ? text.slice(0, limit) + '...' : text;
    }

    function describeErrorValue(value) {
        if (value === null || value === undefined) {
            return '';
        }

        if (typeof value === 'object' || typeof value === 'function') {
            return '';
        }

        return truncate(value, MAX_ERROR_VALUE_LENGTH);
    }

    // Neconyan: `String(plainObject)` renders as "[object Object]", which hides
    // every useful detail. Enumerate the value instead so iOS boot reports name the
    // actual failure (for example an aborted jqXHR with status 0).
    function describeErrorObject(error) {
        var parts = [];
        var seen = {};

        function push(key, value) {
            var text = describeErrorValue(value);

            if (!text || seen[key]) {
                return;
            }

            seen[key] = true;
            parts.push(key + ': ' + text);
        }

        for (var index = 0; index < ERROR_DETAIL_KEYS.length; index++) {
            try {
                push(ERROR_DETAIL_KEYS[index], error[ERROR_DETAIL_KEYS[index]]);
            } catch (_error) {
                // Accessor properties can throw on cross-origin or revoked objects.
            }
        }

        if (!parts.length) {
            try {
                var keys = Object.keys(error);

                for (var keyIndex = 0; keyIndex < keys.length && parts.length < ERROR_DETAIL_KEYS.length; keyIndex++) {
                    push(keys[keyIndex], error[keys[keyIndex]]);
                }
            } catch (_error) {
                // Non-enumerable or exotic objects simply stay undescribed.
            }
        }

        var constructorName = '';
        try {
            constructorName = String(error.constructor && error.constructor.name || '');
        } catch (_error) {
            constructorName = '';
        }

        var prefix = 'Thrown ' + (constructorName || 'object');

        if (!parts.length) {
            return prefix + ' with no readable details.';
        }

        return truncate(prefix + ' { ' + parts.join(', ') + ' }', MAX_ERROR_DETAIL_LENGTH);
    }

    function describeError(error) {
        try {
            if (!error) {
                return 'Unknown startup error.';
            }

            if (typeof error === 'string') {
                return error;
            }

            if (error.stack) {
                var stack = String(error.stack);
                // WebKit's stack lists frames without the error message.
                var message = error.message ? String(error.message) : '';
                return message && !stack.includes(message) ? message + '\n' + stack : stack;
            }

            if (error.message) {
                return String(error.message);
            }

            if (typeof error === 'object') {
                return describeErrorObject(error);
            }

            return String(error);
        } catch (_error) {
            return 'Unable to read startup error details.';
        }
    }

    function recordRequestFailure(method, url, status) {
        if (failedRequests.length >= MAX_TRACKED_REQUEST_FAILURES) {
            return;
        }

        failedRequests.push(truncate(String(method || 'GET') + ' ' + String(url) + ' -> ' + String(status), MAX_ERROR_VALUE_LENGTH));
    }

    function describeRequestFailures() {
        if (!failedRequests.length) {
            return '';
        }

        return truncate('Failed requests during startup:\n' + failedRequests.join('\n'), MAX_ERROR_DETAIL_LENGTH);
    }

    // Neconyan: a rejected jqXHR carries no stack, message or URL, so jQuery rethrows it
    // from its own source and the failure looks like a Neconyan bug. When the only requests
    // that failed belong to a third-party extension, blame the extension instead.
    function isThirdPartyRequestFailure(error) {
        if (!error || typeof error !== 'object' || error.stack || error.message) {
            return false;
        }

        if (!failedRequests.length) {
            return false;
        }

        for (var index = 0; index < failedRequests.length; index++) {
            if (!isThirdPartyExtensionSource(failedRequests[index])) {
                return false;
            }
        }

        return true;
    }

    // Neconyan: jQuery AJAX goes through XMLHttpRequest, so watching it here captures
    // the URL and status of the request behind an otherwise anonymous jqXHR rejection.
    function trackFailingRequests() {
        try {
            var XHR = window.XMLHttpRequest;

            if (!XHR || !XHR.prototype || !XHR.prototype.open || !XHR.prototype.send) {
                return;
            }

            var originalOpen = XHR.prototype.open;
            var originalSend = XHR.prototype.send;

            XHR.prototype.open = function (method, url) {
                try {
                    this.neconyanBootMethod = method;
                    this.neconyanBootUrl = url;
                } catch (_error) {
                    // Exotic instances simply stay unlabeled.
                }

                return originalOpen.apply(this, arguments);
            };

            XHR.prototype.send = function () {
                try {
                    var request = this;
                    request.addEventListener('loadend', function () {
                        if (bootCompleted) {
                            return;
                        }

                        var status = Number(request.status || 0);

                        if (status !== 0 && status < 400) {
                            return;
                        }

                        recordRequestFailure(request.neconyanBootMethod, request.neconyanBootUrl, status || 'network error');
                    });
                } catch (_error) {
                    // Never let diagnostics break startup.
                }

                return originalSend.apply(this, arguments);
            };
        } catch (_error) {
            // Never let diagnostics break startup.
        }
    }

    function failureDetails(message, error) {
        var details = message || 'Neconyan startup failed.';
        var errorDetails = describeError(error);

        if (errorDetails && details.indexOf(errorDetails) === -1) {
            details += '\n' + errorDetails;
        }

        var requestDetails = describeRequestFailures();

        if (requestDetails && details.indexOf(requestDetails) === -1) {
            details += '\n' + requestDetails;
        }

        return details;
    }

    function queueFailure(details) {
        lastFailure = details;
        window.setTimeout(function () {
            showFailure(details);
        }, 0);
    }

    function recordFailure(message, error) {
        if (!isBootGuardApplicable) {
            return;
        }

        queueFailure(failureDetails(message, error));
    }

    function redactFailureDetails(details) {
        try {
            if (window.NeconyanCrashDiagnostics?.redact) {
                return window.NeconyanCrashDiagnostics.redact(details);
            }
        } catch (_error) { /* The unredacted text is still shown when redaction fails. */ }

        return details;
    }

    // A nonfatal panel is still useful when a later module diagnostic names the cause.
    // Fatal panels and dismissed panels never change.
    function enrichFailure(details) {
        if (!details || bootCompleted || failureDismissed || !failureShown) {
            return false;
        }

        if (document.getElementById('neconyan-startup-failure')) {
            return false;
        }

        var preloader = document.getElementById('preloader');
        var pre = preloader && preloader.querySelector('pre');

        if (!pre) {
            return false;
        }

        var recordedDetails = redactFailureDetails(details);
        var previousDetails = pre.textContent || '';

        if (previousDetails && recordedDetails.indexOf(previousDetails) === -1) {
            recordedDetails = previousDetails + '\n\n' + recordedDetails;
        }

        pre.textContent = recordedDetails;
        lastFailure = recordedDetails;

        try {
            var diagnostics = window.NeconyanCrashDiagnostics;
            var updated = failureReportId && typeof diagnostics?.updateReport === 'function'
                ? Boolean(diagnostics.updateReport(failureReportId, recordedDetails))
                : false;

            if (!updated && diagnostics?.capture) {
                var report = diagnostics.capture('startup-failure', recordedDetails);
                if (report?.id) {
                    failureReportId = report.id;
                }
            }
        } catch (_error) { /* The visible details are still updated. */ }

        return true;
    }

    function recordOrEnrichFailure(message, error) {
        if (!isBootGuardApplicable || bootCompleted || failureDismissed || document.getElementById('neconyan-startup-failure')) {
            return;
        }

        var details = failureDetails(message, error);

        if (enrichFailure(details)) {
            return;
        }

        queueFailure(details);
    }

    // WebKit often reports a module load failure with no Error object. Importing the
    // same URL uses the module map, so an evaluated module is not run twice, while a
    // failed module can reject with the parser or dependency error behind the event.
    function diagnoseCoreModuleFailure(url, target, eventError) {
        var base = 'Failed to load startup resource: ' + url;
        var moduleUrl = coreModuleDiagnosticUrl(target);

        if (!moduleUrl) {
            recordFailure(base, eventError);
            return;
        }

        if (moduleDiagnosticsStarted[moduleUrl]) {
            return;
        }

        moduleDiagnosticsStarted[moduleUrl] = true;
        var settled = false;
        var timer = window.setTimeout(function () {
            finish(null);
        }, MODULE_DIAGNOSTIC_TIMEOUT_MS);

        function finish(reason) {
            if (settled) {
                return;
            }

            settled = true;

            if (timer) {
                window.clearTimeout(timer);
            }

            if (reason) {
                recordOrEnrichFailure(base + '\nRetried module import and received:', reason);
            } else {
                recordFailure(base, eventError);
            }
        }

        try {
            import(moduleUrl).then(function () {
                finish(null);
            }, function (reason) {
                finish(reason || new Error('Module import rejected without details.'));
            });
        } catch (error) {
            finish(error);
        }
    }

    function clearBrowserCaches() {
        var tasks = [];

        try {
            if ('caches' in window && window.caches.keys) {
                tasks.push(window.caches.keys().then(function (keys) {
                    return Promise.all(keys.map(function (key) {
                        return window.caches.delete(key);
                    }));
                }));
            }
        } catch (error) {
            console.warn('Unable to access frontend caches before reload.', error);
        }

        try {
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
                tasks.push(navigator.serviceWorker.getRegistrations().then(function (registrations) {
                    return Promise.all(registrations.map(function (registration) {
                        return registration.unregister();
                    }));
                }));
            }
        } catch (error) {
            console.warn('Unable to access service worker registrations before reload.', error);
        }

        return Promise.all(tasks);
    }

    function reloadAfterCacheClear(button) {
        button.disabled = true;
        button.textContent = 'Clearing cache...';

        clearBrowserCaches()
            .catch(function (error) {
                console.warn('Unable to clear frontend caches before reload.', error);
            })
            .then(function () {
                window.location.reload();
            });
    }

    function removeElement(element) {
        if (!element) {
            return;
        }

        if (typeof element.remove === 'function') {
            element.remove();
            return;
        }

        if (element.parentNode) {
            element.parentNode.removeChild(element);
        }
    }

    function queryAll(selector, root) {
        try {
            return Array.prototype.slice.call((root || document).querySelectorAll(selector));
        } catch (_error) {
            return [];
        }
    }

    function isStartupLoaderActive() {
        try {
            return Boolean(document.querySelector('#loader, .splash-screen, #load-spinner, dialog #loader, dialog .splash-screen, dialog #load-spinner'));
        } catch (_error) {
            return false;
        }
    }

    function removeStartupLoaderArtifacts() {
        queryAll('dialog').forEach(function (dialog) {
            try {
                if (dialog.querySelector('#loader, .splash-screen, #load-spinner')) {
                    removeElement(dialog);
                }
            } catch (_error) {
                // Keep surfacing the boot failure even if a browser rejects a selector.
            }
        });

        queryAll('#loader, .splash-screen, #load-spinner, ._poly_dialog_overlay').forEach(removeElement);
    }

    function getElapsedBootTimeMs() {
        return Date.now() - bootStartedAt;
    }

    // Neconyan: the safe start screen holds the app on purpose. Its timer must not
    // replace that screen with the failure panel while the user reads a report.
    function isStartupHoldActive() {
        try {
            return typeof window !== 'undefined' && window.NeconyanCrashDiagnostics?.isStartupHoldActive?.() === true;
        } catch (_error) {
            return false;
        }
    }

    function scheduleBootTimeout(delay) {
        timeoutId = window.setTimeout(handleBootTimeout, delay);
    }

    function handleBootTimeout() {
        if (bootCompleted || failureShown || failureDismissed) {
            return;
        }

        if (isStartupHoldActive()) {
            scheduleBootTimeout(BOOT_TIMEOUT_RETRY_MS);
            return;
        }

        if (!lastFailure && isStartupLoaderActive() && getElapsedBootTimeMs() < MAX_BOOT_TIMEOUT_MS) {
            scheduleBootTimeout(BOOT_TIMEOUT_RETRY_MS);
            return;
        }

        showFailure(lastFailure || 'Startup timed out before Neconyan removed the loading screen.');
    }

    function showFailure(details, fatal = false) {
        if (!fatal && (!isBootGuardApplicable || bootCompleted || failureShown || failureDismissed || isStartupHoldActive())) {
            return;
        }

        if (fatal && document.getElementById('neconyan-startup-failure')) return;
        var preloader = fatal ? document.createElement('div') : document.getElementById('preloader');
        if (!preloader) {
            return;
        }
        if (fatal) {
            // Loader cleanup runs again on the next frame. Keep a fatal error outside
            // that lifecycle, including failures after the ordinary loader was hidden.
            preloader.id = 'neconyan-startup-failure';
            document.body.appendChild(preloader);
            removeElement(document.getElementById('preloader'));
        }

        failureShown = true;
        // A blocked core script can leave the browser recovery notice sitting above this
        // panel on a phone. This panel carries its own Read report, so remove the notice.
        try { document.getElementById('neconyan-crash-notice')?.remove(); } catch (_error) { /* The panel still follows. */ }
        var recordedDetails = details || lastFailure || 'Startup timed out before Neconyan removed the loading screen.';
        try {
            if (window.NeconyanCrashDiagnostics?.openReports) {
                recordedDetails = window.NeconyanCrashDiagnostics.redact(recordedDetails);
                var savedReport = window.NeconyanCrashDiagnostics.capture('startup-failure', recordedDetails);
                failureReportId = savedReport?.id || '';
            }
        } catch (_error) { /* The existing failure screen remains available. */ }
        removeStartupLoaderArtifacts();
        preloader.hidden = false;
        preloader.innerHTML = '';
        preloader.removeAttribute('aria-hidden');
        // Settings may not have loaded, so inherited theme tokens can still be black.
        preloader.style.cssText = '--neco-canvas:#141514;--neco-surface:#222220;--neco-ink:#f4ebdb;--neco-ink-muted:#beb1a1;--neco-ginger:#d69270;--neco-on-accent:#141514;position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--neco-canvas);color:var(--neco-ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;backdrop-filter:none;-webkit-backdrop-filter:none;';
        preloader.setAttribute('role', 'alertdialog');
        preloader.setAttribute('aria-modal', 'true');
        preloader.setAttribute('aria-labelledby', 'neconyan-startup-failure-title');

        var panel = document.createElement('div');
        panel.style.cssText = 'width:min(100%,520px);max-height:calc(100vh - 48px);overflow:auto;border:1px solid rgba(247,190,122,.35);border-radius:18px;background:#222220;box-shadow:0 20px 60px rgba(0,0,0,.55);padding:22px;line-height:1.45;';

        var title = document.createElement('h1');
        title.id = 'neconyan-startup-failure-title';
        title.textContent = 'Neconyan could not finish loading';
        title.style.cssText = 'margin:0 0 10px;font-size:22px;line-height:1.2;color:#f4ebdb;';

        var message = document.createElement('p');
        message.textContent = fatal
            ? 'Neconyan could not load your workspace. Retry startup to reconnect. If the error returns, the server may need attention.'
            : 'Your browser stopped during startup. Cached files or blocked storage can prevent the app from loading.';
        message.style.cssText = 'margin:0 0 16px;color:#beb1a1;';

        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = fatal ? 'Retry startup' : 'Clear frontend cache and reload';
        button.style.cssText = 'width:100%;border:0;border-radius:12px;background:var(--neco-ginger);color:var(--neco-on-accent);font-weight:700;font-size:16px;padding:12px 14px;cursor:pointer;';
        button.addEventListener('click', function () {
            if (fatal) window.location.reload();
            else reloadAfterCacheClear(button);
        });

        var dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.textContent = 'Continue anyway';
        dismissButton.style.cssText = 'width:100%;margin-top:10px;border:1px solid var(--neco-ginger);border-radius:12px;background:transparent;color:var(--neco-ink);font-weight:600;font-size:15px;padding:11px 14px;cursor:pointer;';
        dismissButton.addEventListener('click', function () {
            failureDismissed = true;
            if (timeoutId) {
                window.clearTimeout(timeoutId);
            }
            removeElement(preloader);
        });

        var reportButton = null;
        if (window.NeconyanCrashDiagnostics?.openReports) {
            reportButton = document.createElement('button');
            reportButton.type = 'button';
            reportButton.className = 'menu_button';
            reportButton.textContent = 'Read report';
            reportButton.setAttribute('data-i18n', 'Read report');
            // Outlined and accent-aware like 'Continue anyway', so the panel is not two filled primary buttons.
            reportButton.style.cssText = 'width:100%;margin-top:10px;border:1px solid var(--neco-ginger, currentColor);border-radius:12px;background:transparent;color:var(--neco-ink, inherit);font-weight:600;font-size:15px;padding:11px 14px;min-height:44px;cursor:pointer;';
            reportButton.addEventListener('click', function () {
                window.NeconyanCrashDiagnostics?.openReports?.(failureReportId || window.NeconyanCrashDiagnostics.fatalReportId);
            });
        }

        var hint = document.createElement('p');
        hint.textContent = fatal
            ? 'Your saved data has not been cleared. Error details are available below.'
            : 'If this keeps happening, read the report before changing your browser storage.';
        hint.style.cssText = 'margin:14px 0 0;color:#beb1a1;font-size:14px;';

        var summary = document.createElement('details');
        summary.style.cssText = 'margin-top:16px;color:#beb1a1;';

        var summaryTitle = document.createElement('summary');
        summaryTitle.textContent = 'Startup error details';

        var pre = document.createElement('pre');
        pre.textContent = recordedDetails;
        pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:10px 0 0;padding:12px;border-radius:10px;background:#141514;color:#f4ebdb;font-size:12px;';

        summary.appendChild(summaryTitle);
        summary.appendChild(pre);
        panel.appendChild(title);
        panel.appendChild(message);
        panel.appendChild(button);
        if (!fatal) panel.appendChild(dismissButton);
        if (reportButton) {
            panel.appendChild(reportButton);
        }
        panel.appendChild(hint);
        panel.appendChild(summary);
        preloader.appendChild(panel);
        if (fatal) button.focus?.();
    }

    const neconyanBootGuard = {
        bootCompleted: function () {
            bootCompleted = true;
            try {
                // The app is still loading characters and the last chat; only the
                // later 'neconyan:ready' event marks startup complete.
                var diagnostics = window.NeconyanCrashDiagnostics;
                (diagnostics?.markBootLoaderComplete ?? diagnostics?.markAppReady)?.();
            } catch (_error) { /* Diagnostics cannot block startup. */ }
            if (timeoutId) {
                window.clearTimeout(timeoutId);
            }
        },
        showFailure: showFailure,
        showStartupFailure: function (error) {
            showFailure(describeError(error), true);
        },
        resumeAfterStartupHold: function () {
            bootStartedAt = Date.now();
            if (timeoutId) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (isBootGuardApplicable && !bootCompleted && !failureShown && !failureDismissed) {
                scheduleBootTimeout(BOOT_TIMEOUT_MS);
            }
        },
    };
    window.NeconyanBootGuard = neconyanBootGuard;

    if (!isBootGuardApplicable) {
        return;
    }

    trackFailingRequests();

    window.addEventListener('error', function (event) {
        if (bootCompleted) {
            return;
        }

        if (event.target && event.target !== window) {
            var target = event.target;
            var tagName = target.tagName;
            var rel = target.rel || '';
            var url = target.src || target.href || '';

            if (isThirdPartyExtensionSource(url)) {
                console.warn('Neconyan boot guard ignored a third-party extension resource failure.', url);
                return;
            }

            if (tagName === 'SCRIPT' || (tagName === 'LINK' && rel.indexOf('modulepreload') !== -1)) {
                // A module script's error event often carries no Error object on WebKit.
                // Retry only the marked core entry modules and only when no detail exists.
                if (tagName === 'SCRIPT' && !event.error && coreModuleDiagnosticUrl(target)) {
                    diagnoseCoreModuleFailure(url, target, event.error);
                } else {
                    recordFailure('Failed to load startup resource: ' + url, event.error);
                }
            }

            return;
        }

        if (isThirdPartyExtensionSource(event.filename)) {
            console.warn('Neconyan boot guard ignored a third-party extension startup error.', event.filename);
            return;
        }

        if (isThirdPartyRequestFailure(event.error)) {
            console.warn('Neconyan boot guard ignored a third-party extension request failure.', failedRequests);
            return;
        }

        var source = event.filename ? ' at ' + event.filename + ':' + event.lineno + ':' + event.colno : '';
        recordFailure(String(event.message || 'Startup script error') + source, event.error);
    }, true);

    window.addEventListener('unhandledrejection', function (event) {
        if (bootCompleted) {
            return;
        }

        if (isThirdPartyExtensionSource(describeError(event.reason))) {
            console.warn('Neconyan boot guard ignored a third-party extension startup rejection.', event.reason);
            return;
        }

        if (isThirdPartyRequestFailure(event.reason)) {
            console.warn('Neconyan boot guard ignored a third-party extension request failure.', failedRequests);
            return;
        }

        recordFailure('Unhandled startup promise rejection.', event.reason);
    });

    scheduleBootTimeout(BOOT_TIMEOUT_MS);
}());
