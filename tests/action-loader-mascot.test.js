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
