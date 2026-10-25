/* global globalThis */
import vm from 'node:vm';

import { describe, expect, test } from '@jest/globals';

import {
    collectBudgetFailures,
    collectLongTaskMetrics,
    createLongChatRenderFixture,
    createStreamingRenderFixture,
    ensureChatSurfaceVisible,
    installLongTaskObserver,
    LONG_CHAT_RENDER_FILLER_REPEAT,
    LONG_CHAT_RENDER_MESSAGE_COUNT,
    LONG_CHAT_RENDER_VISIBLE_COUNT,
    measureLongChatRender,
    measureProfile,
    measureScrollFps,
    measureStreamingRender,
    parseProfileNames,
    resetLongTaskCollection,
    STREAM_RENDER_CODE_REPEAT,
    STREAM_RENDER_FILLER_REPEAT,
    STREAM_RENDER_STEP_COUNT,
    summarizeRequestByteFields,
    summarizeRequests,
    waitForAppReady,
} from '../scripts/measure-frontend-performance.js';

function installFakeLongTaskObserver({ supportedEntryTypes: entryTypes = ['longtask'] } = {}) {
    const originalObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver');
    const originalStateDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__neconyanPerfLongTasks');
    const instances = [];

    class FakePerformanceObserver {
        static supportedEntryTypes = entryTypes;

        constructor(callback) {
            this.callback = callback;
            this.observeCalls = [];
            this.takeRecordsCalls = 0;
            this.queued = [];
            this.disconnected = false;
            instances.push(this);
        }

        observe(options) {
            this.observeCalls.push(options);
        }

        disconnect() {
            this.disconnected = true;
        }

        takeRecords() {
            this.takeRecordsCalls++;
            return this.queued.splice(0);
        }

        deliver(entries) {
            this.callback({ getEntries: () => entries });
        }
    }

    Object.defineProperty(globalThis, 'PerformanceObserver', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: FakePerformanceObserver,
    });
    Reflect.deleteProperty(globalThis, '__neconyanPerfLongTasks');

    return {
        instances,
        restore() {
            if (originalObserverDescriptor) {
                Object.defineProperty(globalThis, 'PerformanceObserver', originalObserverDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'PerformanceObserver');
            }
            if (originalStateDescriptor) {
                Object.defineProperty(globalThis, '__neconyanPerfLongTasks', originalStateDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, '__neconyanPerfLongTasks');
            }
        },
    };
}

function createBrowserMeasurementRuntime() {
    const contexts = [];

    function createPage(initScripts) {
        let browserContext;
        let currentUrl = 'about:blank';
        let navigationCount = 0;
        let syntheticTaskDelivered = false;

        function createDocument() {
            class HTMLElement {}
            class FakePerformanceObserver {
                static supportedEntryTypes = ['longtask'];
                static instances = [];

                constructor(callback) {
                    this.callback = callback;
                    this.queued = [];
                    FakePerformanceObserver.instances.push(this);
                }

                observe() {}

                disconnect() {}

                takeRecords() {
                    return this.queued.splice(0);
                }

                deliver(entries) {
                    this.callback({ getEntries: () => entries });
                }
            }

            let fakeNow = 0;
            const chatElement = new HTMLElement();
            const bodyClasses = new Set();

            chatElement.scrollHeight = 300;
            chatElement.clientHeight = 100;
            chatElement.scrollTop = 100;
            chatElement.checkVisibility = () => true;

            return vm.createContext({
                addEventListener: () => {},
                clearTimeout,
                console,
                document: {
                    body: {
                        classList: {
                            contains: name => bodyClasses.has(name),
                            remove: name => bodyClasses.delete(name),
                        },
                    },
                    getElementById: id => id === 'chat' ? chatElement : null,
                    querySelector: selector => selector === '#chat' ? chatElement : null,
                    hidden: false,
                    visibilityState: 'visible',
                },
                FakePerformanceObserver,
                HTMLElement,
                PerformanceObserver: FakePerformanceObserver,
                performance: {
                    timeOrigin: 1000,
                    now: () => {
                        fakeNow += 100;
                        return fakeNow;
                    },
                    getEntriesByType: name => {
                        if (name === 'navigation') {
                            return [{
                                domContentLoadedEventEnd: 120,
                                loadEventEnd: 220,
                                transferSize: 4096,
                                encodedBodySize: 2048,
                                decodedBodySize: 8192,
                            }];
                        }
                        if (name === 'paint') {
                            return [{ name: 'first-contentful-paint', startTime: 50 }];
                        }
                        return [];
                    },
                    clearResourceTimings: () => {},
                    setResourceTimingBufferSize: () => {},
                },
                queueMicrotask,
                requestAnimationFrame: callback => callback(fakeNow += 100),
                setTimeout: (callback, delay, ...args) => setTimeout(callback, 0, ...args),
                SillyTavern: {
                    getContext: () => ({ chat: [], powerUserSettings: {} }),
                },
            });
        }

        function runInitScripts() {
            for (const { script, arg } of initScripts) {
                const browserScript = vm.runInContext(`(${script.toString()})`, browserContext);
                browserScript(arg);
            }
        }

        function deliverLongTask(duration) {
            browserContext.FakePerformanceObserver.instances.at(-1).deliver([
                { startTime: 10, duration },
            ]);
        }

        function loadDocument() {
            browserContext = createDocument();
            runInitScripts();
            navigationCount++;
            syntheticTaskDelivered = false;
            browserContext.__neconyanPerfReadyAt = 123;
            deliverLongTask(70 + (navigationCount * 10));
        }

        browserContext = createDocument();
        runInitScripts();

        return {
            async evaluate(callback, arg) {
                if (!syntheticTaskDelivered && callback.toString().includes('chat-formatting-unavailable')) {
                    syntheticTaskDelivered = true;
                    deliverLongTask(60);
                }
                const browserCallback = vm.runInContext(`(${callback.toString()})`, browserContext, { filename: 'browser-evaluate.js' });
                return await browserCallback(arg);
            },
            async waitForFunction(callback) {
                const predicate = vm.runInContext(`(${callback.toString()})`, browserContext, { filename: 'browser-wait.js' });
                if (!predicate()) {
                    throw new Error('Browser predicate never became true.');
                }
            },
            async goto(url) {
                currentUrl = url;
                loadDocument();
            },
            async reload() {
                loadDocument();
            },
            url() {
                return currentUrl;
            },
        };
    }

    const browser = {
        contexts,
        async newContext(options) {
            const context = {
                options,
                initScripts: [],
                pages: [],
                async addInitScript(script, arg) {
                    this.initScripts.push({ script, arg });
                },
                async newPage() {
                    const page = createPage(this.initScripts);
                    this.pages.push(page);
                    return page;
                },
                async close() {
                    this.closed = true;
                },
            };
            contexts.push(context);
            return context;
        },
    };

    return { browser, contexts };
}

function createScrollMeasurementPage(scroller) {
    return {
        evaluate: async (callback) => {
            const previousDocument = globalThis.document;
            const previousPerformance = globalThis.performance;
            const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
            let frameTime = 0;

            try {
                globalThis.document = {
                    getElementById: () => scroller,
                    scrollingElement: null,
                };
                globalThis.performance = {
                    now: () => 0,
                };
                globalThis.requestAnimationFrame = callbackRef => {
                    frameTime += 500;
                    callbackRef(frameTime);
                };

                return await callback();
            } finally {
                globalThis.document = previousDocument;
                globalThis.performance = previousPerformance;
                globalThis.requestAnimationFrame = previousRequestAnimationFrame;
            }
        },
    };
}

describe('frontend performance measurement helpers', () => {
    test('waits for completed startup even when the chat exists before settings finish', async () => {
        const original = { document: globalThis.document, HTMLElement: globalThis.HTMLElement,
            SillyTavern: globalThis.SillyTavern, ready: globalThis.__neconyanPerfReadyAt };
        try {
            globalThis.HTMLElement = class {};
            globalThis.document = { getElementById: () => new globalThis.HTMLElement() };
            globalThis.SillyTavern = { getContext: () => ({}) };
            globalThis.__neconyanPerfReadyAt = 0;
            await waitForAppReady({ waitForFunction: async (ready, arg, options) => {
                expect(ready()).toBe(false);
                expect(options.timeout).toBe(60000);
                globalThis.__neconyanPerfReadyAt = 1234;
                expect(ready()).toBe(true);
            } });
        } finally {
            Object.assign(globalThis, { document: original.document, HTMLElement: original.HTMLElement,
                SillyTavern: original.SillyTavern, __neconyanPerfReadyAt: original.ready });
        }
    });

    test('records the long-chat render fixture size used for baseline measurements', () => {
        const fixture = createLongChatRenderFixture();

        expect(fixture.messageCount).toBe(LONG_CHAT_RENDER_MESSAGE_COUNT);
        expect(fixture.visibleCount).toBe(LONG_CHAT_RENDER_VISIBLE_COUNT);
        expect(fixture.fillerRepeat).toBe(LONG_CHAT_RENDER_FILLER_REPEAT);
        expect(fixture.messages).toHaveLength(96);
        expect(fixture.messages.at(0)).toEqual(expect.objectContaining({
            name: 'Scroll Tester',
            is_user: true,
            is_system: false,
        }));
        expect(fixture.messages.at(1)).toEqual(expect.objectContaining({
            name: 'Miso',
            is_user: false,
            is_system: false,
        }));
        expect(fixture.messages.at(-1).mes).toContain('performance synthetic message 95');
    });

    test('summarizes request bytes by asset type', () => {
        expect(summarizeRequests([
            { url: 'http://example.test/script.js', bytes: 12 },
            { url: 'http://example.test/styles.css?v=1', bytes: 20 },
            { url: 'http://example.test/font.woff2', bytes: 30 },
            { url: 'http://example.test/image.webp', bytes: 40 },
            { url: 'http://example.test/api/status', bytes: 50 },
        ])).toEqual({
            count: 5,
            js: 12,
            css: 20,
            font: 30,
            image: 40,
            other: 50,
        });
    });

    test('summarizes transfer and body-size request byte fields separately', () => {
        expect(summarizeRequestByteFields([
            {
                url: 'http://example.test/script.js',
                bytes: 0,
                encodedBodySize: 120,
                decodedBodySize: 240,
            },
            {
                url: 'http://example.test/styles.css',
                bytes: 30,
                encodedBodySize: 40,
                decodedBodySize: 80,
            },
        ])).toEqual({
            transfer: {
                count: 2,
                js: 0,
                css: 30,
                font: 0,
                image: 0,
                other: 0,
            },
            encoded: {
                count: 2,
                js: 120,
                css: 40,
                font: 0,
                image: 0,
                other: 0,
            },
            decoded: {
                count: 2,
                js: 240,
                css: 80,
                font: 0,
                image: 0,
                other: 0,
            },
            zeroTransferCount: 1,
            zeroTransferWithEncodedBodyCount: 1,
        });
    });

    test('creates a streaming render fixture with cumulative steps', () => {
        const fixture = createStreamingRenderFixture();

        expect(fixture.stepCount).toBe(STREAM_RENDER_STEP_COUNT);
        expect(fixture.fillerRepeat).toBe(STREAM_RENDER_FILLER_REPEAT);
        expect(fixture.codeRepeat).toBe(STREAM_RENDER_CODE_REPEAT);
        expect(fixture.steps).toHaveLength(STREAM_RENDER_STEP_COUNT);
        expect(fixture.steps.at(0).length).toBeGreaterThan(0);
        expect(fixture.steps.at(-1)).toBe(fixture.fullText);
        expect(fixture.fullText).toContain('```js');
    });

    test('parses requested performance profile names', () => {
        expect(parseProfileNames('mobile, desktop, mobile')).toEqual(['mobile', 'desktop']);
        expect(parseProfileNames('')).toEqual(['mobile', 'desktop']);
        expect(() => parseProfileNames('mobile,unknown')).toThrow('Unknown performance profile');
    });

    test('collects max budget failures by metric path', () => {
        const result = {
            profiles: {
                mobile: {
                    cold: {
                        requests: {
                            js: 120,
                        },
                    },
                },
            },
        };

        expect(collectBudgetFailures(result, {
            max: {
                'profiles.mobile.cold.requests.js': 100,
                'profiles.mobile.cold.requests.css': 100,
            },
        })).toEqual([
            {
                path: 'profiles.mobile.cold.requests.js',
                expected: '<= 100',
                actual: 120,
                reason: 'over_budget',
            },
            {
                path: 'profiles.mobile.cold.requests.css',
                expected: 'number <= 100',
                actual: null,
                reason: 'missing_metric',
            },
        ]);
    });

    test('treats unavailable measurements as missing budget metrics instead of passing zero', () => {
        const result = {
            profiles: {
                mobile: {
                    cold: {
                        longTasks: {
                            supported: false,
                            reason: 'longtask-unsupported',
                            count: null,
                            totalDuration: null,
                            longest: null,
                        },
                        supportedLongTasks: {
                            supported: true,
                            count: 0,
                            totalDuration: 0,
                            longest: 0,
                        },
                        scrollFps: {
                            available: false,
                            reason: 'not-scrollable',
                            movedPixels: 0,
                        },
                        chatRender: {
                            longChat: {
                                available: false,
                                reason: 'chat-hidden',
                            },
                        },
                    },
                },
            },
        };

        expect(collectBudgetFailures(result, {
            max: {
                'profiles.mobile.cold.longTasks.count': 10,
                'profiles.mobile.cold.supportedLongTasks.count': 10,
                'profiles.mobile.cold.scrollFps.movedPixels': 10,
                'profiles.mobile.cold.chatRender.longChat.renderedCount': 10,
            },
        })).toEqual([
            {
                path: 'profiles.mobile.cold.longTasks.count',
                expected: 'number <= 10',
                actual: null,
                reason: 'missing_metric',
            },
            {
                path: 'profiles.mobile.cold.scrollFps.movedPixels',
                expected: 'number <= 10',
                actual: null,
                reason: 'missing_metric',
            },
            {
                path: 'profiles.mobile.cold.chatRender.longChat.renderedCount',
                expected: 'number <= 10',
                actual: null,
                reason: 'missing_metric',
            },
        ]);
    });

    test('reports missing long-task observer state explicitly', () => {
        const fake = installFakeLongTaskObserver();

        try {
            expect(collectLongTaskMetrics()).toEqual({
                supported: false,
                reason: 'longtask-observer-missing',
                count: null,
                totalDuration: null,
                longest: null,
            });
            expect(resetLongTaskCollection()).toBe(false);
        } finally {
            fake.restore();
        }
    });

    test('collects long tasks through a PerformanceObserver and drains pending records', () => {
        const fake = installFakeLongTaskObserver();

        try {
            installLongTaskObserver();
            const [observer] = fake.instances;

            expect(observer.observeCalls).toEqual([{ type: 'longtask', buffered: true }]);

            observer.deliver([
                { startTime: 120, duration: 85 },
                { startTime: 260, duration: 120 },
            ]);
            observer.queued.push({ startTime: 430, duration: 70 });

            expect(collectLongTaskMetrics()).toEqual({
                supported: true,
                count: 3,
                totalDuration: 275,
                longest: 120,
            });
            expect(observer.takeRecordsCalls).toBe(1);
            expect(collectLongTaskMetrics()).toEqual({
                supported: true,
                count: 3,
                totalDuration: 275,
                longest: 120,
            });
        } finally {
            fake.restore();
        }
    });

    test('reports unsupported long-task entry collection instead of zero tasks', () => {
        const fake = installFakeLongTaskObserver({ supportedEntryTypes: ['paint'] });

        try {
            installLongTaskObserver();

            expect(fake.instances).toHaveLength(0);
            expect(collectLongTaskMetrics()).toEqual({
                supported: false,
                reason: 'longtask-unsupported',
                count: null,
                totalDuration: null,
                longest: null,
            });
        } finally {
            fake.restore();
        }
    });

    test('reports unsupported long-task collection when the observer API is missing', () => {
        const fake = installFakeLongTaskObserver();

        try {
            Reflect.deleteProperty(globalThis, 'PerformanceObserver');
            installLongTaskObserver();

            expect(collectLongTaskMetrics()).toEqual({
                supported: false,
                reason: 'longtask-unsupported',
                count: null,
                totalDuration: null,
                longest: null,
            });
        } finally {
            fake.restore();
        }
    });

    test('resets long-task collection for each navigation', () => {
        const fake = installFakeLongTaskObserver();

        try {
            installLongTaskObserver();
            const [observer] = fake.instances;

            observer.deliver([{ startTime: 100, duration: 90 }]);
            expect(collectLongTaskMetrics().count).toBe(1);

            observer.queued.push({ startTime: 300, duration: 60 });
            expect(resetLongTaskCollection()).toBe(true);
            expect(collectLongTaskMetrics()).toEqual({
                supported: true,
                count: 0,
                totalDuration: 0,
                longest: 0,
            });

            observer.deliver([{ startTime: 500, duration: 75 }]);
            expect(collectLongTaskMetrics()).toEqual({
                supported: true,
                count: 1,
                totalDuration: 75,
                longest: 75,
            });
        } finally {
            fake.restore();
        }
    });

    test('collects long-task metrics from the browser during profile measurement', async () => {
        const originalNodeState = Object.getOwnPropertyDescriptor(globalThis, '__neconyanPerfLongTasks');
        Reflect.deleteProperty(globalThis, '__neconyanPerfLongTasks');

        try {
            // Node has no long-task state. If measurePage calls the collector here
            // instead of through page.evaluate, the result below is observer-missing.
            expect(collectLongTaskMetrics()).toEqual({
                supported: false,
                reason: 'longtask-observer-missing',
                count: null,
                totalDuration: null,
                longest: null,
            });

            const { browser, contexts } = createBrowserMeasurementRuntime();
            const result = await measureProfile(browser, {
                name: 'integration',
                label: 'Integration',
                contextOptions: {},
            }, {
                url: 'http://example.test/',
                serviceWorkers: 'block',
                instrumentation: false,
            });

            expect(result.cold.metrics.longTasks).toEqual({
                supported: true,
                count: 1,
                totalDuration: 80,
                longest: 80,
            });
            expect(result.warm.metrics.longTasks).toEqual({
                supported: true,
                count: 1,
                totalDuration: 90,
                longest: 90,
            });
            expect(result.cold.metrics.longTasksAfterSynthetic).toEqual({
                supported: true,
                count: 1,
                totalDuration: 60,
                longest: 60,
            });
            expect(result.warm.metrics.longTasksAfterSynthetic).toEqual({
                supported: true,
                count: 1,
                totalDuration: 60,
                longest: 60,
            });
            expect(globalThis.__neconyanPerfLongTasks).toBeUndefined();
            expect(contexts[0].closed).toBe(true);
        } finally {
            if (originalNodeState) {
                Object.defineProperty(globalThis, '__neconyanPerfLongTasks', originalNodeState);
            } else {
                Reflect.deleteProperty(globalThis, '__neconyanPerfLongTasks');
            }
        }
    });

    test('measures long-chat render timing through the browser page contract', async () => {
        const bodyClasses = new Set(['neconyan', 'neconyan-home-visible']);
        const renderedMessages = [];
        let concealCalls = 0;
        let activeFixture = null;
        const chatElement = {
            scrollHeight: 1200,
            clientHeight: 500,
            scrollTop: 700,
            checkVisibility: () => !bodyClasses.has('neconyan-home-visible'),
            replaceChildren: () => renderedMessages.splice(0),
            querySelectorAll: () => renderedMessages,
        };
        const context = {
            powerUserSettings: {
                auto_scroll_chat_to_bottom: false,
                chat_truncation: 100,
            },
            chat: [],
            printMessages: async () => {
                renderedMessages.push(...activeFixture.messages.slice(-activeFixture.visibleCount).map((message, offset) => ({
                    getAttribute: attributeName => attributeName === 'mesid'
                        ? String(activeFixture.messageCount - activeFixture.visibleCount + offset)
                        : null,
                })));
            },
        };
        const page = {
            evaluate: async (callback, fixture) => {
                const previousGlobal = globalThis.SillyTavern;
                const previousDocument = globalThis.document;
                const previousHTMLElement = globalThis.HTMLElement;
                const previousPerformance = globalThis.performance;
                const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
                const previousWelcome = globalThis.NeconyanWelcome;

                try {
                    activeFixture = fixture;
                    globalThis.HTMLElement = Object;
                    globalThis.document = {
                        body: {
                            classList: {
                                contains: name => bodyClasses.has(name),
                                remove: name => bodyClasses.delete(name),
                            },
                        },
                        getElementById: () => chatElement,
                        querySelector: () => chatElement,
                    };
                    globalThis.SillyTavern = {
                        getContext: () => context,
                    };
                    globalThis.NeconyanWelcome = {
                        concealHome: () => {
                            concealCalls++;
                            bodyClasses.delete('neconyan-home-visible');
                        },
                    };
                    globalThis.performance = {
                        now: (() => {
                            let now = 100;
                            return () => {
                                now += 25;
                                return now;
                            };
                        })(),
                    };
                    globalThis.requestAnimationFrame = callbackRef => callbackRef();

                    return await callback(fixture);
                } finally {
                    globalThis.SillyTavern = previousGlobal;
                    globalThis.document = previousDocument;
                    globalThis.HTMLElement = previousHTMLElement;
                    globalThis.performance = previousPerformance;
                    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
                    globalThis.NeconyanWelcome = previousWelcome;
                }
            },
        };

        const result = await measureLongChatRender(page, createLongChatRenderFixture());

        expect(result).toEqual(expect.objectContaining({
            available: true,
            durationMs: 25,
            messageCount: 96,
            visibleCount: 24,
            fillerRepeat: 36,
            renderedCount: 24,
            firstRenderedMesId: '72',
            lastRenderedMesId: '95',
            bottomDelta: 0,
        }));
        expect(result.surface).toEqual({ revealedFromHome: true, visible: true });
        expect(concealCalls).toBe(1);
        expect(context.powerUserSettings).toEqual({
            auto_scroll_chat_to_bottom: false,
            chat_truncation: 100,
        });
        expect(result.fixture).toEqual({
            messageCount: 96,
            visibleCount: 24,
            fillerRepeat: 36,
        });
    });

    test('measures synthetic streaming render work through the browser page contract', async () => {
        const plainPreviewModuleUrl = `data:text/javascript,${encodeURIComponent('export const formatPlainTextStreamingPreview = text => text;')}`;
        const page = {
            evaluate: async (callback, fixture) => {
                const previousGlobal = globalThis.SillyTavern;
                const previousDocument = globalThis.document;
                const previousHTMLElement = globalThis.HTMLElement;
                const previousPerformance = globalThis.performance;
                const previousRequestAnimationFrame = globalThis.requestAnimationFrame;

                const selectorResults = {
                    '*': [{}, {}],
                    'pre code': [{}],
                };
                const createElement = () => ({
                    className: '',
                    innerHTML: '',
                    appendChild: () => {},
                    remove: () => {},
                    setAttribute: () => {},
                    querySelectorAll: selector => selectorResults[selector],
                });
                const chatElement = createElement();
                chatElement.checkVisibility = () => true;
                const context = {
                    chat: [],
                    messageFormatting: text => `<p>${text}</p><pre><code>sample</code></pre>`,
                };
                let now = 100;

                try {
                    globalThis.HTMLElement = Object;
                    globalThis.document = {
                        body: {
                            classList: {
                                contains: () => false,
                                remove: () => {},
                            },
                        },
                        createElement,
                        getElementById: () => chatElement,
                        querySelector: () => chatElement,
                    };
                    globalThis.SillyTavern = {
                        getContext: () => context,
                    };
                    globalThis.performance = {
                        now: () => {
                            now += 5;
                            return now;
                        },
                    };
                    globalThis.requestAnimationFrame = callbackRef => {
                        now += 100;
                        callbackRef(now);
                    };

                    return await callback(fixture);
                } finally {
                    globalThis.SillyTavern = previousGlobal;
                    globalThis.document = previousDocument;
                    globalThis.HTMLElement = previousHTMLElement;
                    globalThis.performance = previousPerformance;
                    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
                }
            },
        };

        const result = await measureStreamingRender(page, createStreamingRenderFixture({
            stepCount: 2,
            fillerRepeat: 1,
            codeRepeat: 1,
        }), { plainPreviewModuleUrl });

        expect(result).toEqual(expect.objectContaining({
            available: true,
            totalMs: 65,
            averageStepMs: 32.5,
            stepCount: 2,
            fillerRepeat: 1,
            codeRepeat: 1,
            domNodeCount: 2,
            codeBlockCount: 1,
        }));
        expect(result.formatTotalMs).toBeGreaterThan(0);
        expect(result.writeTotalMs).toBeGreaterThan(0);
        expect(result.finalHtmlBytes).toBeGreaterThan(0);
        expect(result.plainPreview).toEqual(expect.objectContaining({
            available: true,
            totalMs: 65,
            averageStepMs: 32.5,
        }));
        expect(result.fixture).toEqual({
            stepCount: 2,
            fillerRepeat: 1,
            codeRepeat: 1,
        });
    });

    test('reports chat-hidden without running synthetic render work when the chat surface stays hidden', async () => {
        let evaluateCalls = 0;
        const page = {
            evaluate: async () => {
                evaluateCalls++;
                return { revealedFromHome: true, visible: false };
            },
        };

        const longChat = await measureLongChatRender(page, createLongChatRenderFixture({
            messageCount: 2,
            visibleCount: 1,
            fillerRepeat: 1,
        }));
        const streaming = await measureStreamingRender(page, createStreamingRenderFixture({
            stepCount: 1,
            fillerRepeat: 1,
            codeRepeat: 1,
        }));

        expect(longChat).toEqual(expect.objectContaining({
            available: false,
            reason: 'chat-hidden',
            surface: { revealedFromHome: true, visible: false },
        }));
        expect(longChat.renderedCount).toBeUndefined();
        expect(streaming).toEqual(expect.objectContaining({
            available: false,
            reason: 'chat-hidden',
            surface: { revealedFromHome: true, visible: false },
        }));
        expect(streaming.totalMs).toBeUndefined();
        expect(evaluateCalls).toBe(2);
    });

    test('measures scroll FPS upward from the bottom and records actual movement', async () => {
        let scrollTop = 100;
        const scroller = {
            scrollHeight: 200,
            clientHeight: 100,
            get scrollTop() {
                return scrollTop;
            },
            set scrollTop(value) {
                scrollTop = Math.min(100, Math.max(0, value));
            },
        };

        const result = await measureScrollFps(createScrollMeasurementPage(scroller));

        expect(result).toEqual(expect.objectContaining({
            available: true,
            direction: 'up',
            scrollRange: 100,
            startScrollTop: 100,
            endScrollTop: 52,
            movedPixels: 48,
        }));
        expect(scrollTop).toBe(100);
    });

    test('reveals Home before scroll FPS so the rendered chat fixture is scrollable', async () => {
        const bodyClasses = new Set(['neconyan', 'neconyan-home-visible']);
        let homeVisible = true;
        let scrollTop = 0;
        const scroller = {
            get scrollHeight() {
                return homeVisible ? 0 : 200;
            },
            get clientHeight() {
                return homeVisible ? 0 : 100;
            },
            get scrollTop() {
                return scrollTop;
            },
            set scrollTop(value) {
                scrollTop = Math.min(100, Math.max(0, value));
            },
            checkVisibility: () => !homeVisible,
        };
        const page = {
            evaluate: async (callback) => {
                const previousDocument = globalThis.document;
                const previousHTMLElement = globalThis.HTMLElement;
                const previousPerformance = globalThis.performance;
                const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
                const previousWelcome = globalThis.NeconyanWelcome;
                let frameTime = 0;

                try {
                    globalThis.document = {
                        body: {
                            classList: {
                                contains: name => bodyClasses.has(name),
                                remove: name => bodyClasses.delete(name),
                            },
                        },
                        getElementById: () => scroller,
                        scrollingElement: null,
                    };
                    globalThis.HTMLElement = Object;
                    globalThis.NeconyanWelcome = {
                        concealHome: () => {
                            bodyClasses.delete('neconyan-home-visible');
                            homeVisible = false;
                        },
                    };
                    globalThis.performance = {
                        now: () => 0,
                    };
                    globalThis.requestAnimationFrame = callbackRef => {
                        frameTime += 500;
                        callbackRef(frameTime);
                    };

                    return await callback();
                } finally {
                    globalThis.document = previousDocument;
                    globalThis.HTMLElement = previousHTMLElement;
                    globalThis.performance = previousPerformance;
                    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
                    globalThis.NeconyanWelcome = previousWelcome;
                }
            },
        };

        const surface = await ensureChatSurfaceVisible(page);
        const result = await measureScrollFps(page);

        expect(surface).toEqual({ revealedFromHome: true, visible: true });
        expect(result).toEqual(expect.objectContaining({
            available: true,
            direction: 'down',
            scrollRange: 100,
            startScrollTop: 0,
            endScrollTop: 48,
            movedPixels: 48,
        }));
    });

    test('waits for finite chat animations and ignores perpetual decorative animations', async () => {
        const bodyClasses = new Set(['neconyan', 'neconyan-home-visible']);
        let finiteFinished = false;
        let frameCount = 0;
        const chatElement = {
            scrollHeight: 200,
            clientHeight: 100,
            scrollTop: 100,
            checkVisibility: () => !bodyClasses.has('neconyan-home-visible'),
            getAnimations: () => [
                {
                    effect: {
                        getComputedTiming: () => ({ endTime: 360 }),
                    },
                    finished: new Promise(resolve => {
                        setTimeout(() => {
                            finiteFinished = true;
                            resolve();
                        }, 0);
                    }),
                },
                {
                    effect: {
                        getComputedTiming: () => ({ endTime: Infinity }),
                    },
                    finished: new Promise(() => {}),
                },
            ],
        };
        const page = {
            evaluate: async (callback) => {
                const previousDocument = globalThis.document;
                const previousHTMLElement = globalThis.HTMLElement;
                const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
                const previousWelcome = globalThis.NeconyanWelcome;

                try {
                    globalThis.document = {
                        body: {
                            classList: {
                                contains: name => bodyClasses.has(name),
                                remove: name => bodyClasses.delete(name),
                            },
                        },
                        getElementById: () => chatElement,
                    };
                    globalThis.HTMLElement = Object;
                    globalThis.NeconyanWelcome = {
                        concealHome: () => {
                            bodyClasses.delete('neconyan-home-visible');
                        },
                    };
                    globalThis.requestAnimationFrame = callbackRef => {
                        frameCount++;
                        callbackRef(frameCount);
                    };

                    return await callback();
                } finally {
                    globalThis.document = previousDocument;
                    globalThis.HTMLElement = previousHTMLElement;
                    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
                    globalThis.NeconyanWelcome = previousWelcome;
                }
            },
        };

        const surface = await ensureChatSurfaceVisible(page);

        expect(surface).toEqual({ revealedFromHome: true, visible: true });
        expect(finiteFinished).toBe(true);
        expect(frameCount).toBeGreaterThanOrEqual(2);
    });

    test('reports scroll FPS unavailable without a usable scroll range or movement', async () => {
        const notScrollable = await measureScrollFps(createScrollMeasurementPage({
            scrollHeight: 100,
            clientHeight: 100,
            scrollTop: 0,
        }));
        const lockedScroller = {
            scrollHeight: 200,
            clientHeight: 100,
            get scrollTop() {
                return 0;
            },
            set scrollTop(value) {
                void value;
            },
        };
        const noMovement = await measureScrollFps(createScrollMeasurementPage(lockedScroller));

        expect(notScrollable).toEqual({
            available: false,
            reason: 'not-scrollable',
            scrollRange: 0,
            movedPixels: 0,
        });
        expect(noMovement).toEqual(expect.objectContaining({
            available: false,
            reason: 'no-scroll-movement',
            scrollRange: 100,
            movedPixels: 0,
        }));
    });

    test('closes the browser context when init-script setup fails', async () => {
        const profile = {
            name: 'test',
            label: 'Test',
            contextOptions: {},
        };
        let closeCount = 0;
        const context = {
            addInitScript: async () => {
                throw new Error('init failed');
            },
            newPage: async () => {
                throw new Error('newPage should not be called');
            },
            close: async () => {
                closeCount++;
            },
        };
        const browser = {
            newContext: async () => context,
        };

        await expect(measureProfile(browser, profile, {
            url: 'http://example.test',
            serviceWorkers: 'block',
            instrumentation: false,
        })).rejects.toThrow('init failed');
        expect(closeCount).toBe(1);
    });

    test('closes the browser context when page creation fails', async () => {
        const profile = {
            name: 'test',
            label: 'Test',
            contextOptions: {},
        };
        let closeCount = 0;
        const initScripts = [];
        const context = {
            addInitScript: async (script) => {
                initScripts.push(script);
            },
            newPage: async () => {
                throw new Error('page failed');
            },
            close: async () => {
                closeCount++;
            },
        };
        const browser = {
            newContext: async () => context,
        };

        await expect(measureProfile(browser, profile, {
            url: 'http://example.test',
            serviceWorkers: 'block',
            instrumentation: false,
        })).rejects.toThrow('page failed');
        expect(closeCount).toBe(1);
        expect(initScripts).toHaveLength(2);
        expect(initScripts[1]).toBe(installLongTaskObserver);
    });
});
