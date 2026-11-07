import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bootGuardSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-boot-guard.js'), 'utf8');
const IOS_WEBKIT_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_CHROME_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

class FakeElement {
    constructor(tagName, { id = '', className = '' } = {}) {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.className = className;
        this.children = [];
        this.parentNode = null;
        this.style = { cssText: '' };
        this.attributes = new Map();
        this.listeners = new Map();
        this.textContent = '';
        this.type = '';
        this.disabled = false;
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        this.children = this.children.filter(candidate => candidate !== child);
        child.parentNode = null;
        return child;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const selectors = selector.split(',').map(part => part.trim()).filter(Boolean);
        return getDescendants(this).filter(element => selectors.some(part => matchesSelector(element, part)));
    }

    set innerHTML(_value) {
        this.children.forEach(child => {
            child.parentNode = null;
        });
        this.children = [];
    }
}

class FakeDocument {
    constructor() {
        this.body = new FakeElement('body');
    }

    createElement(tagName) {
        return new FakeElement(tagName);
    }

    appendChild(element) {
        return this.body.appendChild(element);
    }

    getElementById(id) {
        return getDescendants(this.body).find(element => element.id === id) || null;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        return this.body.querySelectorAll(selector);
    }
}

function getDescendants(root) {
    return root.children.flatMap(child => [child, ...getDescendants(child)]);
}

function matchesSimpleSelector(element, selector) {
    if (selector.startsWith('#')) {
        return element.id === selector.slice(1);
    }

    if (selector.startsWith('.')) {
        return element.className.split(/\s+/).includes(selector.slice(1));
    }

    return element.tagName.toLowerCase() === selector.toLowerCase();
}

function matchesSelector(element, selector) {
    const parts = selector.split(/\s+/).filter(Boolean);
    let currentElement = element;

    for (let index = parts.length - 1; index >= 0; index--) {
        if (index === parts.length - 1) {
            if (!matchesSimpleSelector(currentElement, parts[index])) {
                return false;
            }
            currentElement = currentElement.parentNode;
            continue;
        }

        while (currentElement && !matchesSimpleSelector(currentElement, parts[index])) {
            currentElement = currentElement.parentNode;
        }

        if (!currentElement) {
            return false;
        }

        currentElement = currentElement.parentNode;
    }

    return true;
}

function createFakeXMLHttpRequest() {
    return class FakeXMLHttpRequest {
        constructor() {
            this.status = 0;
            this.requestListeners = new Map();
        }

        open(method, url) {
            this.requestMethod = method;
            this.requestUrl = url;
        }

        send() {
            this.sent = true;
        }

        addEventListener(type, listener) {
            const existing = this.requestListeners.get(type) || [];
            existing.push(listener);
            this.requestListeners.set(type, existing);
        }

        dispatch(type) {
            (this.requestListeners.get(type) || []).forEach(listener => listener());
        }
    };
}

function createBootGuardHarness({ userAgent = IOS_WEBKIT_USER_AGENT, platform = 'iPhone', maxTouchPoints = 5, diagnostics, importModuleDynamically } = {}) {
    const document = new FakeDocument();
    const timers = [];
    const listeners = new Map();
    let now = 0;
    const fakeNavigator = { maxTouchPoints, platform, userAgent };

    const window = {
        addEventListener: (type, listener) => listeners.set(type, listener),
        clearTimeout: jest.fn(),
        location: { href: 'https://neconyan.test/', origin: 'https://neconyan.test', reload: jest.fn() },
        navigator: fakeNavigator,
        setTimeout: (callback, delay) => {
            timers.push({ callback, delay });
            return timers.length;
        },
        XMLHttpRequest: createFakeXMLHttpRequest(),
    };
    if (diagnostics) {
        window.NeconyanCrashDiagnostics = diagnostics;
    }

    const options = importModuleDynamically ? { importModuleDynamically } : {};
    vm.runInNewContext(bootGuardSource, {
        console,
        Date: { now: () => now },
        document,
        navigator: fakeNavigator,
        Promise,
        URL,
        window,
    }, options);

    return {
        document,
        listeners,
        setNow: value => {
            now = value;
        },
        timers,
        window,
    };
}

function addPreloader(document) {
    const preloader = new FakeElement('div', { id: 'preloader' });
    preloader.setAttribute('aria-hidden', 'true');
    document.appendChild(preloader);
    return preloader;
}

function coreModuleTarget(src = 'https://neconyan.test/scripts/i18n.js') {
    const target = new FakeElement('script');
    target.type = 'module';
    target.src = src;
    target.setAttribute('data-neconyan-core-script', '');
    return target;
}

function flushPromises() {
    return new Promise(resolve => setImmediate(resolve));
}

describe('Neconyan boot guard', () => {
    test.each([IOS_WEBKIT_USER_AGENT, DESKTOP_CHROME_USER_AGENT])('shows fatal startup failures after the loader has gone on %s', userAgent => {
        const diagnostics = { redact: value => value, capture: jest.fn(() => ({ id: 'startup' })), openReports: jest.fn() };
        const { document, window } = createBootGuardHarness({ userAgent, diagnostics });
        window.NeconyanBootGuard.bootCompleted();
        const failure = new Error('POST /api/settings/get failed (HTTP 500).');
        failure.stack = 'requestSettingsData@http://localhost/script.js:100:24';
        window.NeconyanBootGuard.showStartupFailure(failure);

        const surface = document.getElementById('neconyan-startup-failure');
        expect(surface.querySelector('h1').textContent).toBe('Neconyan could not finish loading');
        expect(surface.querySelector('pre').textContent).toContain('HTTP 500');
        expect(surface.style.cssText).toContain('--neco-ink:');
        expect(surface.querySelectorAll('button').map(button => button.textContent)).toEqual(['Retry startup', 'Read report']);
        surface.querySelector('button').listeners.get('click')();
        expect(window.location.reload).toHaveBeenCalledTimes(1);
        surface.querySelectorAll('button')[1].listeners.get('click')();
        expect(diagnostics.openReports).toHaveBeenCalledWith('startup');
        window.NeconyanBootGuard.showStartupFailure('second error');
        expect(document.querySelectorAll('#neconyan-startup-failure')).toHaveLength(1);
    });

    test('stays hidden when the browser is not iOS WebKit', () => {
        const { document, listeners, timers, window } = createBootGuardHarness({
            maxTouchPoints: 0,
            platform: 'Linux x86_64',
            userAgent: DESKTOP_CHROME_USER_AGENT,
        });
        const preloader = addPreloader(document);

        expect(timers).toHaveLength(0);
        expect(listeners.has('error')).toBe(false);
        expect(listeners.has('unhandledrejection')).toBe(false);

        window.NeconyanBootGuard.showFailure('boom');

        expect(preloader.querySelector('button')).toBeNull();
    });

    test('removes startup loader artifacts before showing the recovery panel', () => {
        const { document, window } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const dialog = document.appendChild(new FakeElement('dialog'));

        dialog.appendChild(new FakeElement('div', { id: 'loader' }));
        document.appendChild(new FakeElement('div', { className: '_poly_dialog_overlay' }));

        window.NeconyanBootGuard.showFailure('boom');

        expect(document.querySelector('dialog')).toBeNull();
        expect(document.getElementById('loader')).toBeNull();
        expect(document.querySelector('._poly_dialog_overlay')).toBeNull();
        expect(preloader.attributes.has('aria-hidden')).toBe(false);
        expect(preloader.querySelector('h1').textContent).toBe('Neconyan could not finish loading');
        expect(preloader.querySelector('button').textContent).toBe('Clear frontend cache and reload');
    });

    test('defers timeout failures while the normal startup loader is active', () => {
        const { document, setNow, timers } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const loader = document.appendChild(new FakeElement('div', { id: 'loader' }));

        expect(timers[0].delay).toBe(25000);

        setNow(26000);
        timers.shift().callback();

        expect(preloader.querySelector('button')).toBeNull();
        expect(timers[0].delay).toBe(10000);

        loader.remove();
        setNow(36000);
        timers.shift().callback();

        expect(preloader.querySelector('button').textContent).toBe('Clear frontend cache and reload');
    });

    test('offers a dismiss button that removes the panel and suppresses later failures', () => {
        const { document, window } = createBootGuardHarness();
        addPreloader(document);

        window.NeconyanBootGuard.showFailure('boom');

        const preloader = document.getElementById('preloader');
        const dismissButton = preloader.querySelectorAll('button').find(button => button.textContent === 'Continue anyway');
        expect(dismissButton).toBeDefined();

        dismissButton.listeners.get('click')();

        expect(document.getElementById('preloader')).toBeNull();
    });

    test('ignores startup errors originating from third-party extensions', () => {
        const { document, listeners, timers } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        listeners.get('error')({
            target: { tagName: 'SCRIPT', src: '/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1.6.5' },
        });
        listeners.get('error')({
            filename: '/scripts/extensions/third-party/Extension-WebSearch/index.js',
            message: 'boom',
            lineno: 1,
            colno: 1,
        });
        listeners.get('unhandledrejection')({
            reason: { stack: 'Error: boom\n    at /scripts/extensions/third-party/Extension-WebSearch/index.js:1:1' },
        });

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        expect(preloader.querySelector('button')).toBeNull();
    });

    test('still surfaces non-extension startup errors on iOS WebKit', () => {
        const { document, listeners, timers } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        listeners.get('error')({
            filename: '/script.js',
            message: 'boom',
            lineno: 1,
            colno: 1,
        });

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        expect(preloader.querySelector('button').textContent).toBe('Clear frontend cache and reload');
    });

    test('retries a marked core module error and reports the real rejection', async () => {
        const imports = [];
        const diagnostics = { redact: value => value, capture: jest.fn(() => ({ id: 'saved-1' })), openReports: jest.fn() };
        const { document, listeners, timers } = createBootGuardHarness({
            diagnostics,
            importModuleDynamically: async specifier => {
                imports.push(specifier);
                const error = new Error('Unexpected token in dependency');
                error.stack = 'SyntaxError: Unexpected token\n    at /scripts/i18n.js:10:2';
                throw error;
            },
        });
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;
        const target = coreModuleTarget();

        listeners.get('error')({ target });
        listeners.get('error')({ target });
        await flushPromises();

        expect(imports).toEqual(['https://neconyan.test/scripts/i18n.js']);

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        const details = preloader.querySelector('pre').textContent;
        expect(details).toContain('Failed to load startup resource: https://neconyan.test/scripts/i18n.js');
        expect(details).toContain('Retried module import and received:');
        expect(details).toContain('Unexpected token in dependency');
        expect(details).toContain('at /scripts/i18n.js:10:2');
        expect(diagnostics.capture).toHaveBeenCalledWith(
            'startup-failure',
            expect.stringContaining('Unexpected token in dependency'),
        );
    });

    test('keeps the generic resource error when a core module retry does not settle', async () => {
        const imports = [];
        const { document, listeners, timers } = createBootGuardHarness({
            importModuleDynamically: specifier => {
                imports.push(specifier);
                return new Promise(() => {});
            },
        });
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        listeners.get('error')({ target: coreModuleTarget() });
        await flushPromises();

        expect(imports).toEqual(['https://neconyan.test/scripts/i18n.js']);

        timers.find(timer => timer.delay === 4000).callback();
        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        const details = preloader.querySelector('pre').textContent;
        expect(details).toContain('Failed to load startup resource: https://neconyan.test/scripts/i18n.js');
        expect(details).toContain('Unknown startup error.');
        expect(details).not.toContain('Retried module import');
    });

    test('enriches an already shown nonfatal panel when a later core module diagnostic arrives', async () => {
        let rejectImport;
        const diagnostics = {
            redact: value => value,
            capture: jest.fn(() => ({ id: 'saved-generic' })),
            updateReport: jest.fn(() => ({ id: 'saved-generic' })),
            openReports: jest.fn(),
        };
        const { document, listeners, timers } = createBootGuardHarness({
            diagnostics,
            importModuleDynamically: specifier => {
                expect(specifier).toBe('https://neconyan.test/scripts/i18n.js');
                return new Promise((_resolve, reject) => {
                    rejectImport = reject;
                });
            },
        });
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;
        const genericTarget = new FakeElement('script');
        genericTarget.type = 'module';
        genericTarget.src = 'https://neconyan.test/scripts/neconyan-conversation.js';

        listeners.get('error')({ target: genericTarget });
        timers.slice(initialTimerCount).find(timer => timer.delay === 0).callback();
        expect(preloader.querySelector('pre').textContent).toContain('conversation.js');

        listeners.get('error')({ target: coreModuleTarget() });
        await flushPromises();
        rejectImport(new Error('Importing a module script failed.'));
        await flushPromises();

        const details = preloader.querySelector('pre').textContent;
        expect(details).toContain('conversation.js');
        expect(details).toContain('scripts/i18n.js');
        expect(details).toContain('Retried module import and received:');
        expect(details).toContain('Importing a module script failed.');
        expect(diagnostics.updateReport).toHaveBeenCalledWith(
            'saved-generic',
            expect.stringContaining('Importing a module script failed.'),
        );
        expect(diagnostics.capture).toHaveBeenCalledTimes(1);
    });

    test('does not enrich a fatal startup failure panel', async () => {
        let rejectImport;
        const diagnostics = {
            redact: value => value,
            capture: jest.fn(() => ({ id: 'saved-fatal' })),
            updateReport: jest.fn(),
            openReports: jest.fn(),
        };
        const { document, listeners, window } = createBootGuardHarness({
            diagnostics,
            importModuleDynamically: specifier => {
                expect(specifier).toBe('https://neconyan.test/scripts/i18n.js');
                return new Promise((_resolve, reject) => {
                    rejectImport = reject;
                });
            },
        });
        const fatal = new Error('POST /api/settings/get failed (HTTP 500).');
        fatal.stack = 'requestSettingsData@https://neconyan.test/script.js:100:24';
        window.NeconyanBootGuard.showStartupFailure(fatal);
        const surface = document.getElementById('neconyan-startup-failure');
        const before = surface.querySelector('pre').textContent;

        listeners.get('error')({ target: coreModuleTarget() });
        await flushPromises();
        rejectImport(new Error('Importing a module script failed.'));
        await flushPromises();

        expect(surface.querySelector('pre').textContent).toBe(before);
        expect(diagnostics.updateReport).not.toHaveBeenCalled();
        expect(diagnostics.capture).toHaveBeenCalledTimes(1);
    });

    test('does not enrich a dismissed startup failure panel', async () => {
        let rejectImport;
        const diagnostics = {
            redact: value => value,
            capture: jest.fn(() => ({ id: 'saved-generic' })),
            updateReport: jest.fn(),
            openReports: jest.fn(),
        };
        const { document, listeners, timers } = createBootGuardHarness({
            diagnostics,
            importModuleDynamically: specifier => {
                expect(specifier).toBe('https://neconyan.test/scripts/i18n.js');
                return new Promise((_resolve, reject) => {
                    rejectImport = reject;
                });
            },
        });
        addPreloader(document);
        const initialTimerCount = timers.length;
        listeners.get('error')({ filename: 'https://neconyan.test/script.js', message: 'generic boom', lineno: 1, colno: 1 });
        timers.slice(initialTimerCount).find(timer => timer.delay === 0).callback();
        const preloader = document.getElementById('preloader');
        preloader.querySelectorAll('button').find(button => button.textContent === 'Continue anyway').listeners.get('click')();

        listeners.get('error')({ target: coreModuleTarget() });
        await flushPromises();
        rejectImport(new Error('Importing a module script failed.'));
        await flushPromises();

        expect(document.getElementById('preloader')).toBeNull();
        expect(diagnostics.updateReport).not.toHaveBeenCalled();
        expect(diagnostics.capture).toHaveBeenCalledTimes(1);
    });

    test('does not retry unmarked, unknown, non-module or cross-origin script errors', async () => {
        const imports = [];
        const { document, listeners, timers } = createBootGuardHarness({
            importModuleDynamically: specifier => {
                imports.push(specifier);
                return Promise.reject(new Error('should not run'));
            },
        });
        addPreloader(document);
        const initialTimerCount = timers.length;
        const unmarked = coreModuleTarget();
        unmarked.removeAttribute('data-neconyan-core-script');
        const classic = coreModuleTarget();
        classic.type = 'text/javascript';
        const link = new FakeElement('link');
        link.rel = 'modulepreload';
        link.href = 'https://neconyan.test/scripts/i18n.js';

        for (const target of [
            unmarked,
            coreModuleTarget('https://neconyan.test/scripts/other.js'),
            coreModuleTarget('https://elsewhere.test/scripts/i18n.js'),
            classic,
            link,
        ]) {
            listeners.get('error')({ target });
        }
        await flushPromises();

        expect(imports).toEqual([]);

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        const details = document.getElementById('preloader').querySelector('pre').textContent;
        expect(details).toContain('Failed to load startup resource:');
        expect(details).not.toContain('Retried module import');
    });

    test('describes message-less thrown objects instead of showing [object Object]', () => {
        const { document, listeners, timers } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        listeners.get('error')({
            filename: '/lib/jquery-3.5.1.min.js',
            message: '[object Object]',
            lineno: 2,
            colno: 31677,
            error: { readyState: 4, status: 0, statusText: 'error' },
        });

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        const details = preloader.querySelector('pre').textContent;
        expect(details).toContain('status: 0');
        expect(details).toContain('statusText: error');
        expect(details).toContain('readyState: 4');
    });

    test('names the failing request behind an object-shaped startup failure', () => {
        const { document, listeners, timers, window } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        const request = new window.XMLHttpRequest();
        request.open('POST', '/api/tokenizers/openai/count?model=gpt-4-turbo');
        request.send();
        request.status = 404;
        request.dispatch('loadend');

        listeners.get('error')({
            filename: '/lib/jquery-3.5.1.min.js',
            message: '[object Object]',
            lineno: 2,
            colno: 31677,
            error: { readyState: 4, status: 404, statusText: 'Not Found' },
        });

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        const details = preloader.querySelector('pre').textContent;
        expect(details).toContain('Failed requests during startup:');
        expect(details).toContain('POST /api/tokenizers/openai/count?model=gpt-4-turbo -> 404');
    });

    test('ignores object-shaped failures whose only failing request is a third-party extension file', () => {
        const { document, listeners, timers, window } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        const request = new window.XMLHttpRequest();
        request.open('GET', 'scripts/extensions/third-party/SB-GroupUtilities/html/group-note.html');
        request.send();
        request.status = 404;
        request.dispatch('loadend');

        listeners.get('error')({
            filename: '/lib/jquery-3.5.1.min.js',
            message: '[object Object]',
            lineno: 2,
            colno: 31677,
            error: { readyState: 4, status: 404, statusText: 'Not Found', responseText: 'Not Found' },
        });

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        expect(preloader.querySelector('pre')).toBeNull();
    });

    test('still blames Neconyan when a core request failed alongside a third-party one', () => {
        const { document, listeners, timers, window } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        const extensionRequest = new window.XMLHttpRequest();
        extensionRequest.open('GET', 'scripts/extensions/third-party/SB-GroupUtilities/html/group-note.html');
        extensionRequest.send();
        extensionRequest.status = 404;
        extensionRequest.dispatch('loadend');

        const coreRequest = new window.XMLHttpRequest();
        coreRequest.open('GET', '/api/settings/get');
        coreRequest.send();
        coreRequest.status = 500;
        coreRequest.dispatch('loadend');

        listeners.get('error')({
            filename: '/lib/jquery-3.5.1.min.js',
            message: '[object Object]',
            lineno: 2,
            colno: 31677,
            error: { readyState: 4, status: 500, statusText: 'Internal Server Error' },
        });

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        expect(preloader.querySelector('pre').textContent).toContain('GET /api/settings/get -> 500');
    });

    test('describes rejected objects that only carry enumerable keys', () => {
        const { document, listeners, timers } = createBootGuardHarness();
        const preloader = addPreloader(document);
        const initialTimerCount = timers.length;

        listeners.get('unhandledrejection')({ reason: { extensionId: 'quick-reply' } });

        timers.slice(initialTimerCount).forEach(timer => timer.callback());

        expect(preloader.querySelector('pre').textContent).toContain('extensionId: quick-reply');
    });

    test('offers an outlined Read report only when the crash reader is available', () => {
        const openReports = jest.fn();
        const diagnostics = { redact: value => value, capture: () => ({ id: 'saved-1' }), openReports };
        const { document, window } = createBootGuardHarness({ diagnostics });
        addPreloader(document);
        document.appendChild(new FakeElement('div', { id: 'neconyan-crash-notice' }));

        window.NeconyanBootGuard.showFailure('boom');

        // A browser recovery notice would otherwise sit above this panel on a phone (z-index 110000 vs 99999).
        expect(document.getElementById('neconyan-crash-notice')).toBeNull();
        const reportButton = document.getElementById('preloader')
            .querySelectorAll('button').find(button => button.textContent === 'Read report');
        expect(reportButton).toBeDefined();
        // Outlined and accent-aware like 'Continue anyway', not a second filled primary button.
        expect(reportButton.className).toBe('menu_button');
        expect(reportButton.className).not.toContain('menu_button_primary');
        expect(reportButton.style.cssText).toContain('background:transparent');
        expect(reportButton.style.cssText).toContain('font-weight:600');
        expect(reportButton.style.cssText).toContain('font-size:15px');
        expect(reportButton.style.cssText).toContain('var(--neco-ginger, currentColor)');
        expect(reportButton.style.cssText).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        reportButton.listeners.get('click')();
        expect(openReports).toHaveBeenCalledWith('saved-1');
    });

    test('hides the Read report button when the crash reader is unavailable', () => {
        const { document, window } = createBootGuardHarness();
        addPreloader(document);

        window.NeconyanBootGuard.showFailure('boom');

        const labels = document.getElementById('preloader').querySelectorAll('button').map(button => button.textContent);
        expect(labels).not.toContain('Read report');
        expect(labels).toContain('Continue anyway');
    });

    test('leaves the safe start screen alone and restarts its timeout when the hold ends', () => {
        let hold = true;
        const diagnostics = { isStartupHoldActive: () => hold, redact: value => value, capture: () => ({ id: 'saved-1' }), openReports: jest.fn() };
        const { document, setNow, timers, window } = createBootGuardHarness({ diagnostics });
        const preloader = addPreloader(document);

        window.NeconyanBootGuard.showFailure('boom');
        expect(preloader.querySelector('button')).toBeNull();

        setNow(26000);
        timers.shift().callback();
        expect(preloader.querySelector('button')).toBeNull();
        expect(timers.at(-1).delay).toBe(10000);

        hold = false;
        window.NeconyanBootGuard.resumeAfterStartupHold();
        expect(timers.at(-1).delay).toBe(25000);

        setNow(51000);
        timers.at(-1).callback();
        expect(preloader.querySelector('button').textContent).toBe('Clear frontend cache and reload');
    });
});
