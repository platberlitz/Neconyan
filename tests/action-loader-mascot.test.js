import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/action-loader.js', import.meta.url), 'utf8');
const factory = source.slice(source.indexOf('export function createDefaultLoaderOverlay()'), source.indexOf('/**\n * Normalizes custom overlay'))
    .replace('export ', '');

function createOverlay({ app = false, system = false } = {}) {
    const context = vm.createContext({
        t: strings => strings[0],
        window: { matchMedia: () => ({ matches: system }) },
        document: {
            body: { classList: { contains: () => app } },
            createElement(tag) {
                return { tag, attributes: {}, children: [],
                    setAttribute(name, value) { this.attributes[name] = value; },
                    append(...children) { this.children.push(...children); },
                    appendChild(child) { this.children.push(child); },
                };
            },
        },
    });
    vm.runInContext(factory, context);
    return context.createDefaultLoaderOverlay();
}

const cleanupStart = source.indexOf('export function cleanupActionLoaderArtifacts(');
const cleanupSource = source.slice(cleanupStart, source.indexOf('\n}\n', cleanupStart) + 2).replace('export ', '');

function loaderPage({ activeIsSplash = false } = {}) {
    const removed = [];
    const element = (name, children = []) => ({
        name, children, isConnected: true,
        remove() {
            this.isConnected = false;
            for (const child of this.children) child.isConnected = false;
            removed.push(name);
        },
        contains(other) { return other === this || this.children.some(child => child.contains?.(other)); },
        querySelector(selector) {
            const ids = selector.split(',').map(part => part.trim());
            const match = this.children.find(child => ids.includes(child.selector));
            return match && match.isConnected ? match : null;
        },
    });
    const node = (name, selector) => ({ ...element(name), selector, contains(other) { return other === this; } });
    const startupLoader = node('startup loader', '#loader');
    const startupDialog = { ...element('startup dialog', [startupLoader, node('splash', '.splash-screen')]), close() {} };
    const activeLoader = node('active loader', '#loader');
    const activeDialog = { ...element('active dialog', activeIsSplash ? [activeLoader, node('splash', '.splash-screen')] : [activeLoader]), close() {} };
    const context = vm.createContext({
        loaderPopup: { dlg: activeDialog },
        yoinkPreloader() {},
        document: {
            getElementById: id => [startupLoader, activeLoader].find(item => id === 'loader' && item.isConnected) || null,
            querySelectorAll: () => [startupDialog, activeDialog].filter(dialog => dialog.isConnected),
            querySelector: () => null,
        },
    });
    vm.runInContext(cleanupSource, context);
    return { cleanup: () => context.cleanupActionLoaderArtifacts({ removePreloader: true }), removed, activeDialog, activeLoader };
}

describe('startup loader cleanup', () => {
    test('keeps a loader shown after startup and removes the leftover startup dialog', () => {
        const page = loaderPage();
        page.cleanup();
        expect(page.removed).toEqual(['startup dialog']);
        expect(page.activeDialog.isConnected).toBe(true);
        expect(page.activeLoader.isConnected).toBe(true);
    });

    test('still clears the startup splash when it is the active loader', () => {
        const page = loaderPage({ activeIsSplash: true });
        page.cleanup();
        expect(page.removed).toEqual(['startup dialog', 'active dialog']);
    });
});

describe('shared action loader artwork', () => {
    test('uses the running mascot without spinning the container', () => {
        const overlay = createOverlay();
        expect(overlay.id).toBe('loader');
        expect(overlay.attributes).toEqual({ role: 'status', 'aria-label': 'Loading…' });
        const spinner = overlay.children[0];
        expect(spinner.id).toBe('load-spinner');
        expect(spinner.className).toBeUndefined();
        const [mascot, progress] = spinner.children;
        expect(mascot.src).toContain('neconyan-pixel-cat-running.webp?v=20260913g');
        expect(mascot.className).toBe('neconyan-startup-cat');
        expect(mascot.alt).toBe('');
        expect(progress.className).toContain('action-loader-progress');
        expect(progress.attributes['aria-hidden']).toBe('true');
        expect(createOverlay()).not.toBe(overlay);
    });

    test.each([{ app: true }, { system: true }, { app: true, system: true }])('respects reduced motion: %o', options => {
        expect(createOverlay(options).children[0].children[0].src).toContain('neconyan-pixel-cat-rest.webp');
    });
});
