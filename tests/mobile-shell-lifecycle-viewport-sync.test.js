import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

import {
    createForegroundRefreshCoalescer,
    createMobileShellLifecycle,
    MOBILE_SHELL_VIEWPORT_SYNC_KIND,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP,
    resolveDrawerBoundsSyncSchedule,
    resolveMobileViewportSyncPlan,
    resolvePendingViewportSyncKind,
    shouldRunFullViewportSync,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = tabsSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const paramsStart = tabsSource.indexOf('(', start);
    let parenDepth = 0;
    let paramsEnd = -1;

    for (let index = paramsStart; index < tabsSource.length; index++) {
        const char = tabsSource[index];
        if (char === '(') {
            parenDepth++;
        } else if (char === ')') {
            parenDepth--;
            if (parenDepth === 0) {
                paramsEnd = index;
                break;
            }
        }
    }

    const bodyStart = tabsSource.indexOf('{', paramsEnd);
    let depth = 0;

    for (let index = bodyStart; index < tabsSource.length; index++) {
        const char = tabsSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return tabsSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

function createViewportSyncSandbox({ width = 390, isMobile = true, hasAnimationFrame = true } = {}) {
    const frames = [];
    const calls = [];
    let nextFrameId = 1;
    const viewport = { width, isMobile };
    // A stub for every step handler, plus the helpers the queue and plan need.
    const stubs = [
        'syncShellViewportBounds', 'syncMobileShellDrawerBounds', 'closeMobileNav', 'closeMobileChatTools',
        'syncMobileShellRailActions', 'syncDesktopShellSizing', 'applyTopbarOffset', 'syncChatbarVisibilityState',
        'updateTopBarBrand', 'scheduleTopbarContextRefresh', 'syncMobileModalState', 'syncIOSKeyboardBottomInset',
    ].map(name => `function ${name}() { calls.push(${JSON.stringify(name)}); }`);

    const requestAnimationFrame = callback => {
        const frameId = nextFrameId++;
        frames.push({ frameId, callback });
        return frameId;
    };
    const cancelAnimationFrame = frameId => {
        const index = frames.findIndex(frame => frame.frameId === frameId);
        if (index >= 0) {
            frames.splice(index, 1);
        }
        calls.push(`cancel:${frameId}`);
    };
    const context = vm.createContext({
        window: {
            ...(hasAnimationFrame ? { requestAnimationFrame, cancelAnimationFrame } : {}),
            innerWidth: width,
        },
        document: { documentElement: { clientWidth: width } },
        getLayoutViewportSize: () => ({
            width: viewport.width,
            height: 844,
            left: 0,
            top: 0,
            right: viewport.width,
            bottom: 844,
        }),
        isMobileViewport: () => viewport.isMobile,
        calls,
        nnMobileShellLifecycle: {
            viewportSync: {
                step: MOBILE_SHELL_VIEWPORT_SYNC_STEP,
                kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND,
                resolveSyncPlan: resolveMobileViewportSyncPlan,
                resolvePendingKind: resolvePendingViewportSyncKind,
                shouldRunFullSync: shouldRunFullViewportSync,
            },
        },
    });

    vm.runInContext([
        ...stubs,
        'let nnMobileViewportStateFrameId = 0;',
        'let nnMobileViewportStatePendingKind = \'\';',
        'let nnMobileViewportStateSyncBaseline = null;',
        'let nnMobileViewportStateSyncFrameBaseline = null;',
        getFunctionSource('readMobileShellLayoutMetrics'),
        getFunctionSource('syncMobileViewportState'),
        getFunctionSource('queueMobileViewportStateSync'),
        'globalThis.queueSync = queueMobileViewportStateSync;',
        'globalThis.syncNow = syncMobileViewportState;',
    ].join('\n'), context);

    return {
        calls,
        viewport,
        queueSync: (kind = MOBILE_SHELL_VIEWPORT_SYNC_KIND.FULL) => context.queueSync(kind),
        syncNow: (kind = MOBILE_SHELL_VIEWPORT_SYNC_KIND.FULL) => context.syncNow({ kind }),
        setLayoutWidth: (nextWidth, nextIsMobile = viewport.isMobile) => {
            viewport.width = nextWidth;
            viewport.isMobile = nextIsMobile;
            context.document.documentElement.clientWidth = nextWidth;
        },
        setInnerWidthOnly: nextWidth => {
            context.window.innerWidth = nextWidth;
        },
        runNextFrame: () => {
            const frame = frames.shift();
            if (!frame) {
                throw new Error('No queued animation frame');
            }
            frame.callback();
        },
        pendingFrameCount: () => frames.length,
        resetCalls: () => { calls.length = 0; },
    };
}

const MOBILE_VIEWPORT_SYNC_STEPS = [
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_RAIL_ACTIONS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_DESKTOP_SHELL_SIZING,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.APPLY_TOPBAR_OFFSET,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_CHATBAR_VISIBILITY_STATE,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.UPDATE_TOP_BAR_BRAND,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SCHEDULE_TOPBAR_CONTEXT_REFRESH,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_MODAL_STATE,
];

const DESKTOP_VIEWPORT_SYNC_STEPS = [
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.CLOSE_MOBILE_NAV,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.CLOSE_MOBILE_CHAT_TOOLS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_RAIL_ACTIONS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_DESKTOP_SHELL_SIZING,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.APPLY_TOPBAR_OFFSET,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_CHATBAR_VISIBILITY_STATE,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.UPDATE_TOP_BAR_BRAND,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SCHEDULE_TOPBAR_CONTEXT_REFRESH,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_MODAL_STATE,
];

const MOBILE_GEOMETRY_SYNC_STEPS = [
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.APPLY_TOPBAR_OFFSET,
];

const DESKTOP_GEOMETRY_SYNC_STEPS = [
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_SHELL_VIEWPORT_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_DRAWER_BOUNDS,
    MOBILE_SHELL_VIEWPORT_SYNC_STEP.APPLY_TOPBAR_OFFSET,
];

function createFakeClock() {
    let currentTime = 0;

    return {
        now: () => currentTime,
        advance: milliseconds => {
            currentTime += milliseconds;
        },
    };
}

describe('mobile shell viewport sync lifecycle', () => {
    test('keeps the viewport sync step constants explicit', () => {
        expect(MOBILE_SHELL_VIEWPORT_SYNC_STEP).toEqual({
            SYNC_SHELL_VIEWPORT_BOUNDS: 'sync-shell-viewport-bounds',
            SYNC_MOBILE_SHELL_DRAWER_BOUNDS: 'sync-mobile-shell-drawer-bounds',
            CLOSE_MOBILE_NAV: 'close-mobile-nav',
            CLOSE_MOBILE_CHAT_TOOLS: 'close-mobile-chat-tools',
            SYNC_MOBILE_SHELL_RAIL_ACTIONS: 'sync-mobile-shell-rail-actions',
            SYNC_DESKTOP_SHELL_SIZING: 'sync-desktop-shell-sizing',
            APPLY_TOPBAR_OFFSET: 'apply-topbar-offset',
            SYNC_CHATBAR_VISIBILITY_STATE: 'sync-chatbar-visibility-state',
            UPDATE_TOP_BAR_BRAND: 'update-top-bar-brand',
            SCHEDULE_TOPBAR_CONTEXT_REFRESH: 'schedule-topbar-context-refresh',
            SYNC_MOBILE_MODAL_STATE: 'sync-mobile-modal-state',
        });
    });

    test('keeps the viewport sync kind constants explicit', () => {
        expect(MOBILE_SHELL_VIEWPORT_SYNC_KIND).toEqual({
            FULL: 'full',
            GEOMETRY: 'geometry',
        });
    });

    test('resolves the exact mobile viewport sync order', () => {
        expect(resolveMobileViewportSyncPlan({ isMobileViewport: true })).toEqual({
            kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.FULL,
            steps: MOBILE_VIEWPORT_SYNC_STEPS,
        });
    });

    test('resolves the exact desktop viewport sync order with mobile closures', () => {
        expect(resolveMobileViewportSyncPlan({ isMobileViewport: false })).toEqual({
            kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.FULL,
            steps: DESKTOP_VIEWPORT_SYNC_STEPS,
        });
    });

    test('defaults viewport sync planning to the full desktop close sequence', () => {
        expect(resolveMobileViewportSyncPlan()).toEqual({
            kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.FULL,
            steps: DESKTOP_VIEWPORT_SYNC_STEPS,
        });
        expect(resolveMobileViewportSyncPlan({ kind: 'unexpected' })).toEqual({
            kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.FULL,
            steps: DESKTOP_VIEWPORT_SYNC_STEPS,
        });
    });

    test('limits geometry-only mobile syncs to bounds, drawers and the topbar offset', () => {
        expect(resolveMobileViewportSyncPlan({
            isMobileViewport: true,
            kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY,
        })).toEqual({
            kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY,
            steps: MOBILE_GEOMETRY_SYNC_STEPS,
        });
    });

    test('limits geometry-only desktop syncs to bounds, drawer cleanup and the topbar offset', () => {
        expect(resolveMobileViewportSyncPlan({
            isMobileViewport: false,
            kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY,
        })).toEqual({
            kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY,
            steps: DESKTOP_GEOMETRY_SYNC_STEPS,
        });
    });

    test('never repeats the chatbar refresh or context dry run for geometry-only work', () => {
        const { steps } = resolveMobileViewportSyncPlan({
            isMobileViewport: true,
            kind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY,
        });

        expect(steps).not.toContain(MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_CHATBAR_VISIBILITY_STATE);
        expect(steps).not.toContain(MOBILE_SHELL_VIEWPORT_SYNC_STEP.SCHEDULE_TOPBAR_CONTEXT_REFRESH);
        expect(steps).not.toContain(MOBILE_SHELL_VIEWPORT_SYNC_STEP.UPDATE_TOP_BAR_BRAND);
        expect(steps).not.toContain(MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_SHELL_RAIL_ACTIONS);
        expect(steps).not.toContain(MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_DESKTOP_SHELL_SIZING);
        expect(steps).not.toContain(MOBILE_SHELL_VIEWPORT_SYNC_STEP.SYNC_MOBILE_MODAL_STATE);
    });

    test('promotes a queued geometry sync only across the breakpoint or within mobile', () => {
        const geometry = MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY;
        const mobile = { width: 390, isMobileViewport: true };
        const desktop = { width: 900, isMobileViewport: false };

        expect(shouldRunFullViewportSync({
            before: mobile,
            after: { ...mobile },
            requestedKind: geometry,
        })).toBe(false);
        expect(shouldRunFullViewportSync({
            before: mobile,
            after: { width: 391, isMobileViewport: true },
            requestedKind: geometry,
        })).toBe(true);
        expect(shouldRunFullViewportSync({
            before: mobile,
            after: { width: 390, isMobileViewport: false },
            requestedKind: geometry,
        })).toBe(true);
        expect(shouldRunFullViewportSync({
            before: desktop,
            after: { ...desktop },
            requestedKind: geometry,
        })).toBe(false);
        expect(shouldRunFullViewportSync({
            before: desktop,
            after: { width: 1000, isMobileViewport: false },
            requestedKind: geometry,
        })).toBe(false);
        expect(shouldRunFullViewportSync({
            before: desktop,
            after: { width: 390, isMobileViewport: true },
            requestedKind: geometry,
        })).toBe(true);
        expect(shouldRunFullViewportSync({
            before: mobile,
            after: { width: 900, isMobileViewport: false },
            requestedKind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.FULL,
        })).toBe(true);
        expect(shouldRunFullViewportSync({ requestedKind: MOBILE_SHELL_VIEWPORT_SYNC_KIND.FULL })).toBe(true);
        // An unknown baseline must not be treated as "no change": the browser has
        // already applied the new width by the time a resize event arrives.
        expect(shouldRunFullViewportSync({
            before: null,
            after: mobile,
            requestedKind: geometry,
        })).toBe(true);
        expect(shouldRunFullViewportSync({ requestedKind: geometry })).toBe(true);
    });

    test('keeps a full request winning over geometry within one pending frame', () => {
        const geometry = MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY;
        const full = MOBILE_SHELL_VIEWPORT_SYNC_KIND.FULL;

        expect(resolvePendingViewportSyncKind({ pendingKind: geometry, requestedKind: full })).toBe(full);
        expect(resolvePendingViewportSyncKind({ pendingKind: full, requestedKind: geometry })).toBe(full);
        expect(resolvePendingViewportSyncKind({ pendingKind: geometry, requestedKind: geometry })).toBe(geometry);
        expect(resolvePendingViewportSyncKind({ pendingKind: '', requestedKind: geometry })).toBe(geometry);
        expect(resolvePendingViewportSyncKind({ pendingKind: '', requestedKind: full })).toBe(full);
        expect(resolvePendingViewportSyncKind()).toBe(full);
    });

    test('resolves drawer bounds sync scheduling for every mobile and rAF state', () => {
        const cases = [
            {
                input: { isMobileViewport: false, hasAnimationFrame: false },
                expected: { shouldSchedule: false, useAnimationFrame: false, followupDelayMs: 123 },
            },
            {
                input: { isMobileViewport: false, hasAnimationFrame: true },
                expected: { shouldSchedule: false, useAnimationFrame: false, followupDelayMs: 123 },
            },
            {
                input: { isMobileViewport: true, hasAnimationFrame: false },
                expected: { shouldSchedule: true, useAnimationFrame: false, followupDelayMs: 123 },
            },
            {
                input: { isMobileViewport: true, hasAnimationFrame: true },
                expected: { shouldSchedule: true, useAnimationFrame: true, followupDelayMs: 123 },
            },
        ];

        for (const { input, expected } of cases) {
            expect(resolveDrawerBoundsSyncSchedule({
                ...input,
                followupDelayMs: 123,
            })).toEqual(expected);
        }
    });

    test('defaults drawer bounds sync scheduling to skipped with the standard follow-up delay', () => {
        expect(resolveDrawerBoundsSyncSchedule()).toEqual({
            shouldSchedule: false,
            useAnimationFrame: false,
            followupDelayMs: 350,
        });
    });

    test('normalizes invalid drawer bounds follow-up delays to the standard delay', () => {
        expect(resolveDrawerBoundsSyncSchedule({
            isMobileViewport: true,
            hasAnimationFrame: true,
            followupDelayMs: 'not-a-delay',
        })).toEqual({
            shouldSchedule: true,
            useAnimationFrame: true,
            followupDelayMs: 350,
        });
    });

    test('exposes viewport sync decisions through the lifecycle seam', () => {
        const lifecycle = createMobileShellLifecycle();

        expect(lifecycle.viewportSync.step).toBe(MOBILE_SHELL_VIEWPORT_SYNC_STEP);
        expect(lifecycle.viewportSync.kind).toBe(MOBILE_SHELL_VIEWPORT_SYNC_KIND);
        expect(lifecycle.viewportSync.resolveSyncPlan).toBe(resolveMobileViewportSyncPlan);
        expect(lifecycle.viewportSync.resolveDrawerBoundsSchedule).toBe(resolveDrawerBoundsSyncSchedule);
        expect(lifecycle.viewportSync.resolvePendingKind).toBe(resolvePendingViewportSyncKind);
        expect(lifecycle.viewportSync.shouldRunFullSync).toBe(shouldRunFullViewportSync);
        expect(lifecycle.foreground.createRefreshCoalescer).toBe(createForegroundRefreshCoalescer);
    });
});

function createKeyboardScrollSandbox() {
    const frames = [];
    const timerQueue = [];
    const scrollLog = [];
    const target = { id: 'first-input' };
    class HTMLElementStub {}
    Object.setPrototypeOf(target, HTMLElementStub.prototype);
    const context = vm.createContext({
        HTMLElement: HTMLElementStub,
        window: {
            requestAnimationFrame: callback => {
                frames.push(callback);
                return frames.length;
            },
            cancelAnimationFrame: () => {
                frames.length = 0;
            },
            setTimeout: (callback, delay) => {
                timerQueue.push({ callback, delay });
                return timerQueue.length;
            },
            clearTimeout: () => {
                timerQueue.length = 0;
            },
        },
        document: { activeElement: target },
        isMobileViewport: () => true,
        isEditableElement: element => Boolean(element?.id),
        syncMobileFocusedInputScroll: element => scrollLog.push(element?.id ?? null),
        nnMobileFocusedInputScrollTimer: null,
        nnMobileFocusedInputScrollFrameId: 0,
    });

    vm.runInContext([
        getFunctionSource('coalesceMobileKeyboardFrame'),
        getFunctionSource('syncScheduledMobileFocusedInput'),
        getFunctionSource('scheduleMobileFocusedInputScroll'),
        'globalThis.schedule = scheduleMobileFocusedInputScroll;',
    ].join('\n'), context);

    return {
        context,
        frames,
        timerQueue,
        scrollLog,
        target,
        schedule: () => context.schedule({ target }),
        runNextFrame: () => {
            const callback = frames.shift();
            if (!callback) {
                throw new Error('No queued animation frame');
            }
            callback();
        },
        runNextTimer: () => {
            const timer = timerQueue.shift();
            if (!timer) {
                throw new Error('No queued timer');
            }
            timer.callback();
            return timer.delay;
        },
    };
}

describe('queued mobile viewport sync', () => {
    test('runs one geometry-only pass for a burst of scroll frames', () => {
        const sandbox = createViewportSyncSandbox();
        sandbox.syncNow(); // Records the layout baseline like initAll does.
        sandbox.resetCalls();

        for (let frame = 0; frame < 18; frame++) {
            sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        }

        expect(sandbox.pendingFrameCount()).toBe(1);
        sandbox.runNextFrame();

        expect(sandbox.calls).toEqual([
            'syncShellViewportBounds',
            'syncMobileShellDrawerBounds',
            'applyTopbarOffset',
            'syncIOSKeyboardBottomInset',
        ]);
        expect(sandbox.calls).not.toContain('syncChatbarVisibilityState');
        expect(sandbox.calls).not.toContain('scheduleTopbarContextRefresh');
        expect(sandbox.calls).not.toContain('syncDesktopShellSizing');
    });

    test('runs the full plan when the browser changed the layout width before the resize event', () => {
        const sandbox = createViewportSyncSandbox();
        sandbox.syncNow();
        sandbox.resetCalls();

        // Real browser order: the layout viewport is already 900 when resize fires,
        // so comparing the request size with itself would stay geometry forever.
        sandbox.setLayoutWidth(900, false);
        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        sandbox.runNextFrame();

        expect(sandbox.calls).toEqual(expect.arrayContaining([
            'closeMobileNav',
            'closeMobileChatTools',
            'syncMobileShellRailActions',
            'syncDesktopShellSizing',
            'syncChatbarVisibilityState',
            'updateTopBarBrand',
            'scheduleTopbarContextRefresh',
            'syncMobileModalState',
        ]));
    });

    test('upgrades a queued geometry pass when the layout width changed before the frame', () => {
        const sandbox = createViewportSyncSandbox();
        sandbox.syncNow();
        sandbox.resetCalls();

        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        sandbox.setLayoutWidth(500, false);
        sandbox.runNextFrame();

        expect(sandbox.calls).toEqual(expect.arrayContaining([
            'syncChatbarVisibilityState',
            'syncDesktopShellSizing',
            'scheduleTopbarContextRefresh',
            'syncMobileModalState',
        ]));
        expect(sandbox.calls).toContain('closeMobileNav');
        expect(sandbox.calls).toContain('closeMobileChatTools');
    });

    test('stays geometry-only when two changes return to the synced width before the frame', () => {
        const sandbox = createViewportSyncSandbox();
        sandbox.syncNow();
        sandbox.resetCalls();

        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        sandbox.setLayoutWidth(500, true);
        sandbox.setLayoutWidth(390, true);
        sandbox.runNextFrame();

        expect(sandbox.calls).toEqual([
            'syncShellViewportBounds',
            'syncMobileShellDrawerBounds',
            'applyTopbarOffset',
            'syncIOSKeyboardBottomInset',
        ]);
    });

    test('upgrades a queued geometry pass when the mobile breakpoint was crossed', () => {
        const sandbox = createViewportSyncSandbox();
        sandbox.syncNow();
        sandbox.resetCalls();

        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        sandbox.viewport.isMobile = false;
        sandbox.runNextFrame();

        expect(sandbox.calls).toContain('syncChatbarVisibilityState');
        expect(sandbox.calls).toContain('scheduleTopbarContextRefresh');
        expect(sandbox.calls).toContain('syncMobileModalState');
    });

    test('keeps a full request winning over a geometry frame pending in the same tick', () => {
        const sandbox = createViewportSyncSandbox();
        sandbox.syncNow();
        sandbox.resetCalls();

        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        sandbox.queueSync();

        expect(sandbox.calls).toContain('cancel:1');
        expect(sandbox.pendingFrameCount()).toBe(1);
        sandbox.runNextFrame();

        expect(sandbox.calls).toContain('syncChatbarVisibilityState');
        expect(sandbox.calls).toContain('scheduleTopbarContextRefresh');
        expect(sandbox.calls).toContain('updateTopBarBrand');
    });

    test('keeps pinch zoom geometry-only because the layout width did not change', () => {
        const sandbox = createViewportSyncSandbox();
        sandbox.syncNow();
        sandbox.resetCalls();

        // iOS pinch zoom can change window.innerWidth; documentElement.clientWidth
        // is the layout width the shell reflows against and stays put.
        sandbox.setInnerWidthOnly(500);
        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        sandbox.runNextFrame();

        expect(sandbox.calls).not.toContain('syncChatbarVisibilityState');
        expect(sandbox.calls).not.toContain('syncDesktopShellSizing');
        expect(sandbox.calls).toContain('applyTopbarOffset');
    });

    test('keeps desktop height-only movement geometry-only and reapplies the topbar offset', () => {
        const sandbox = createViewportSyncSandbox({ width: 900, isMobile: false });
        sandbox.syncNow();
        sandbox.resetCalls();

        // Height alone cannot reflow the shell or change the breakpoint, but the
        // topbar offset is clamped against the height, so it must be reapplied.
        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        sandbox.runNextFrame();

        expect(sandbox.calls).toEqual([
            'syncShellViewportBounds',
            'syncMobileShellDrawerBounds',
            'applyTopbarOffset',
            'syncIOSKeyboardBottomInset',
        ]);
        expect(sandbox.calls).not.toContain('syncChatbarVisibilityState');
        expect(sandbox.calls).not.toContain('syncMobileModalState');
    });

    test('keeps a desktop width change geometry-only and skips shell-context refreshes', () => {
        const sandbox = createViewportSyncSandbox({ width: 900, isMobile: false });
        sandbox.syncNow();
        sandbox.resetCalls();

        sandbox.setLayoutWidth(1000, false);
        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        sandbox.runNextFrame();

        expect(sandbox.calls).toEqual([
            'syncShellViewportBounds',
            'syncMobileShellDrawerBounds',
            'applyTopbarOffset',
            'syncIOSKeyboardBottomInset',
        ]);
        expect(sandbox.calls).not.toContain('syncChatbarVisibilityState');
        expect(sandbox.calls).not.toContain('syncMobileShellRailActions');
        expect(sandbox.calls).not.toContain('updateTopBarBrand');
        expect(sandbox.calls).not.toContain('scheduleTopbarContextRefresh');
        expect(sandbox.calls).not.toContain('syncMobileModalState');
    });

    test('applies the same ordering rule without requestAnimationFrame', () => {
        const sandbox = createViewportSyncSandbox({ hasAnimationFrame: false });
        sandbox.syncNow();
        sandbox.resetCalls();

        sandbox.setLayoutWidth(500, false);
        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);

        expect(sandbox.calls).toEqual(expect.arrayContaining([
            'syncChatbarVisibilityState',
            'syncDesktopShellSizing',
            'syncMobileModalState',
        ]));
    });

    test('does not keep a full marker after the frame it belonged to ran', () => {
        const sandbox = createViewportSyncSandbox();
        sandbox.syncNow();
        sandbox.resetCalls();

        // A later geometry request must not inherit the finished full request.
        sandbox.queueSync(MOBILE_SHELL_VIEWPORT_SYNC_KIND.GEOMETRY);
        sandbox.runNextFrame();

        expect(sandbox.calls).toEqual([
            'syncShellViewportBounds',
            'syncMobileShellDrawerBounds',
            'applyTopbarOffset',
            'syncIOSKeyboardBottomInset',
        ]);
    });

    test('keeps explicit callers on the full plan', () => {
        const sandbox = createViewportSyncSandbox();
        sandbox.queueSync();

        sandbox.runNextFrame();

        expect(sandbox.calls).toEqual(expect.arrayContaining([
            'syncShellViewportBounds',
            'syncMobileShellDrawerBounds',
            'syncMobileShellRailActions',
            'syncDesktopShellSizing',
            'applyTopbarOffset',
            'syncChatbarVisibilityState',
            'updateTopBarBrand',
            'scheduleTopbarContextRefresh',
            'syncMobileModalState',
        ]));
        expect(sandbox.calls).toContain('syncIOSKeyboardBottomInset');
    });
});

describe('keyboard focus scroll scheduling', () => {
    test('queues a single frame for a burst of focus signals', () => {
        const sandbox = createKeyboardScrollSandbox();

        sandbox.schedule();
        sandbox.schedule();
        sandbox.schedule();

        expect(sandbox.frames).toHaveLength(1);
        sandbox.runNextFrame();

        expect(sandbox.scrollLog).toEqual(['first-input']);
    });

    test('runs one settle timer after the keyboard animation', () => {
        const sandbox = createKeyboardScrollSandbox();

        sandbox.schedule();
        sandbox.schedule();

        expect(sandbox.timerQueue).toHaveLength(1);
        expect(sandbox.runNextTimer()).toBe(360);
        expect(sandbox.scrollLog).toEqual(['first-input']);
    });

    test('follows a field focused after the geometry burst', () => {
        const sandbox = createKeyboardScrollSandbox();
        sandbox.schedule();

        sandbox.context.document.activeElement = Object.setPrototypeOf({ id: 'second-input' }, Object.getPrototypeOf(sandbox.target));
        sandbox.runNextTimer();

        expect(sandbox.scrollLog).toEqual(['second-input']);
    });

    test('clears its pending markers when the settle timer runs', () => {
        const sandbox = createKeyboardScrollSandbox();
        sandbox.schedule();
        sandbox.runNextFrame();
        sandbox.runNextTimer();

        expect(sandbox.context.nnMobileFocusedInputScrollTimer).toBeNull();
        expect(sandbox.context.nnMobileFocusedInputScrollFrameId).toBe(0);
        expect(sandbox.timerQueue).toHaveLength(0);
    });
});

describe('foreground refresh coalescer', () => {
    test('runs one refresh for focus and visibility signals in the same frame', () => {
        const clock = createFakeClock();
        let refreshCount = 0;
        const coalescer = createForegroundRefreshCoalescer({
            refresh: () => { refreshCount += 1; },
            now: clock.now,
        });

        coalescer.request();
        coalescer.request();
        coalescer.request();

        expect(refreshCount).toBe(1);
    });

    test('runs one refresh for a burst spread across the window', () => {
        const clock = createFakeClock();
        const runs = [];
        const coalescer = createForegroundRefreshCoalescer({
            refresh: () => { runs.push(clock.now()); },
            now: clock.now,
        });

        coalescer.request();
        clock.advance(50);
        coalescer.request();
        clock.advance(50);
        coalescer.request();

        expect(runs).toEqual([0]);
    });

    test('runs a later real resume after the window has passed', () => {
        const clock = createFakeClock();
        let refreshCount = 0;
        const coalescer = createForegroundRefreshCoalescer({
            refresh: () => { refreshCount += 1; },
            now: clock.now,
        });

        coalescer.request();
        clock.advance(900);
        coalescer.request();

        expect(refreshCount).toBe(2);
    });

    test('ignores hidden signals without spending the burst window', () => {
        const clock = createFakeClock();
        let active = false;
        let refreshCount = 0;
        const coalescer = createForegroundRefreshCoalescer({
            refresh: () => { refreshCount += 1; },
            now: clock.now,
            isActive: () => active,
        });

        coalescer.request();
        expect(refreshCount).toBe(0);

        active = true;
        clock.advance(10);
        coalescer.request();
        expect(refreshCount).toBe(1);

        active = false;
        clock.advance(10);
        coalescer.request();
        expect(refreshCount).toBe(1);

        active = true;
        clock.advance(600);
        coalescer.request();
        expect(refreshCount).toBe(2);
    });

    test('stops scheduling work after disposal', () => {
        const clock = createFakeClock();
        let refreshCount = 0;
        const coalescer = createForegroundRefreshCoalescer({
            refresh: () => { refreshCount += 1; },
            now: clock.now,
        });

        coalescer.request();
        coalescer.dispose();
        clock.advance(1000);
        coalescer.request();

        expect(refreshCount).toBe(1);
    });

    test('reset allows an explicit foreground refresh after a burst', () => {
        const clock = createFakeClock();
        let refreshCount = 0;
        const coalescer = createForegroundRefreshCoalescer({
            refresh: () => { refreshCount += 1; },
            now: clock.now,
        });

        coalescer.request();
        clock.advance(50);
        coalescer.request();
        expect(refreshCount).toBe(1);

        coalescer.cancel();
        coalescer.request();
        expect(refreshCount).toBe(2);
    });

    test('reports a throwing refresh and still allows the next resume', () => {
        const clock = createFakeClock();
        const errors = [];
        let refreshCount = 0;
        const coalescer = createForegroundRefreshCoalescer({
            refresh: () => {
                refreshCount += 1;
                if (refreshCount === 1) {
                    throw new Error('boom');
                }
            },
            now: clock.now,
            reportError: error => errors.push(error.message),
        });

        expect(() => coalescer.request()).not.toThrow();
        clock.advance(500);
        coalescer.request();

        expect(refreshCount).toBe(2);
        expect(errors).toEqual(['boom']);
    });
});
