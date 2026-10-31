import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveMovingUIViewportState, scaleMovingUIViewportState, matchesMovingUIViewport, readMovingUIDevice } from '../public/scripts/moving-ui-viewport.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

function createMemoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    const writes = [];
    return {
        values,
        writes,
        storage: {
            getItem: key => values.has(key) ? values.get(key) : null,
            setItem: (key, value) => {
                values.set(key, value);
                writes.push([key, value]);
            },
        },
    };
}

describe('deliberate MovingUI layout ownership', () => {
    const viewport = { device: 'browser-a', width: 1280, height: 900, screenWidth: 1920, screenHeight: 1080, pixelRatio: 1 };

    test('restores only in the browser and viewport that saved the arrangement', () => {
        expect(matchesMovingUIViewport({ ...viewport }, viewport)).toBe(true);
        expect(matchesMovingUIViewport(undefined, viewport)).toBe(false);
        for (const change of [{ device: 'browser-b' }, { width: 1024 }, { height: 768 }, { screenWidth: 2560 }, { pixelRatio: 1.25 }]) {
            expect(matchesMovingUIViewport(viewport, { ...viewport, ...change })).toBe(false);
        }
    });

    test('rejects phone widths and malformed metadata', () => {
        const phone = { ...viewport, width: 393 };
        expect(matchesMovingUIViewport(phone, phone)).toBe(false);
        expect(matchesMovingUIViewport({ ...viewport, height: null }, viewport)).toBe(false);
    });
});

describe('MovingUI device identity', () => {
    test('keeps a stored identity without generating or rewriting it', () => {
        const { storage, writes } = createMemoryStorage({ 'neconyan-moving-ui-device': 'device-a' });

        expect(readMovingUIDevice(() => storage, () => {
            throw new Error('must not generate an identity');
        })).toBe('device-a');
        expect(writes).toEqual([]);
    });

    test('generates and persists one identity when none is stored', () => {
        for (const initial of [{}, { 'neconyan-moving-ui-device': '' }]) {
            const { storage, writes, values } = createMemoryStorage(initial);
            let created = 0;
            const createId = () => `generated-${++created}`;

            expect(readMovingUIDevice(() => storage, createId)).toBe('generated-1');
            expect(created).toBe(1);
            expect(writes).toEqual([['neconyan-moving-ui-device', 'generated-1']]);
            expect(values.get('neconyan-moving-ui-device')).toBe('generated-1');

            expect(readMovingUIDevice(() => storage, createId)).toBe('generated-1');
            expect(created).toBe(1);
        }
    });

    test('falls back to one in-memory identity when storage access throws', () => {
        let created = 0;
        const createId = () => `generated-${++created}`;
        const blockedRead = {
            getItem: () => {
                throw new Error('storage is blocked');
            },
            setItem: () => {},
        };

        expect(readMovingUIDevice(() => {
            throw new Error('localStorage is blocked');
        }, createId)).toBe('generated-1');
        expect(readMovingUIDevice(() => blockedRead, createId)).toBe('generated-2');
        expect(created).toBe(2);
    });

    test('keeps the generated identity when the browser refuses to store it', () => {
        const { storage } = createMemoryStorage();
        storage.setItem = () => {
            throw new Error('storage is read-only');
        };

        expect(readMovingUIDevice(() => storage, () => 'generated-1')).toBe('generated-1');
    });

    test('preserves a stored identity even when writes are blocked', () => {
        const storage = {
            getItem: () => 'device-a',
            setItem: () => {
                throw new Error('storage is read-only');
            },
        };

        expect(readMovingUIDevice(() => storage, () => {
            throw new Error('must not generate an identity');
        })).toBe('device-a');
    });
});

describe('MovingUI device identity startup wiring', () => {
    const powerUserSource = readSource('public', 'scripts', 'power-user.js');

    test('reads the device identity through the startup-safe helper', () => {
        expect(powerUserSource).toMatch(/import \{[^}]*\buuidv4\b[^}]*\} from '\.\/utils\.js';/);
        expect(powerUserSource).toMatch(/import \{[^}]*\breadMovingUIDevice\b[^}]*\} from '\.\/moving-ui-viewport\.js';/);

        const viewport = powerUserSource.slice(powerUserSource.indexOf('function getMovingUIViewport()'));
        const body = viewport.slice(0, viewport.indexOf('\n}\n'));
        expect(body).toContain('readMovingUIDevice(() => localStorage, uuidv4)');
        expect(body).not.toContain('randomUUID');
    });
});

describe('MovingUI viewport containment', () => {
    test('pulls a persisted panel back inside the viewport without changing its size', () => {
        const result = resolveMovingUIViewportState({
            position: 'fixed',
            width: 600,
            height: 500,
            left: 1800,
            top: 100,
            right: -1136,
            bottom: 200,
            margin: 'unset',
        }, {
            viewportWidth: 1264,
            viewportHeight: 800,
        });

        expect(result).toMatchObject({
            changed: true,
            canContain: true,
            updates: {
                left: 664,
                right: 0,
            },
            state: {
                position: 'fixed',
                width: 600,
                height: 500,
                left: 664,
                top: 100,
                right: 0,
                bottom: 200,
                margin: 'unset',
            },
        });
    });

    test('clamps negative coordinates and panels larger than the viewport', () => {
        const result = resolveMovingUIViewportState({
            width: '1600px',
            height: '900px',
            left: '-240px',
            top: '-80px',
            right: '-96px',
            bottom: '-20px',
        }, {
            viewportWidth: 1280,
            viewportHeight: 720,
        });

        expect(result).toMatchObject({
            changed: true,
            canContain: true,
            updates: {
                width: 1280,
                height: 720,
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
        });
    });

    test('resolves right and bottom anchored legacy state before containing it', () => {
        const result = resolveMovingUIViewportState({
            width: 400,
            height: 300,
            right: -100,
            bottom: -50,
        }, {
            viewportWidth: 1000,
            viewportHeight: 700,
        });

        expect(result).toMatchObject({
            changed: true,
            canContain: true,
            updates: {
                left: 600,
                top: 400,
                right: 0,
                bottom: 0,
            },
        });
    });

    test('uses rendered bounds when CSS changes the persisted dimensions', () => {
        const result = resolveMovingUIViewportState({
            width: 900,
            height: 700,
            left: 500,
            top: 300,
            right: -400,
            bottom: -300,
        }, {
            viewportWidth: 1000,
            viewportHeight: 700,
            elementBounds: {
                left: 500,
                top: 300,
                right: 1250,
                bottom: 650,
                width: 750,
                height: 350,
            },
        });

        expect(result).toMatchObject({
            changed: true,
            canContain: true,
            updates: {
                width: 750,
                left: 250,
                right: 0,
            },
            state: {
                width: 750,
                height: 700,
                left: 250,
                top: 300,
                right: 0,
                bottom: -300,
            },
        });
    });

    test('leaves incomplete hidden-panel state alone when no bounds can be resolved', () => {
        const state = { left: 2000, top: 100, margin: 'unset' };

        expect(resolveMovingUIViewportState(state, {
            viewportWidth: 1280,
            viewportHeight: 720,
        })).toEqual({
            state,
            updates: {},
            changed: false,
            canContain: false,
        });
    });

    test('is stable once state is already contained', () => {
        const state = {
            width: 600,
            height: 500,
            left: 664,
            top: 100,
            right: 0,
            bottom: 200,
        };

        expect(resolveMovingUIViewportState(state, {
            viewportWidth: 1264,
            viewportHeight: 800,
        })).toEqual({
            state,
            updates: {},
            changed: false,
            canContain: true,
        });
    });

    test('does not freeze responsive dimensions when rendered bounds are already contained', () => {
        const state = {
            width: 'var(--sheldWidth)',
            left: 100,
            top: 60,
            right: 100,
            bottom: 60,
        };

        expect(resolveMovingUIViewportState(state, {
            viewportWidth: 1200,
            viewportHeight: 800,
            elementBounds: {
                left: 100,
                top: 60,
                right: 1100,
                bottom: 740,
                width: 1000,
                height: 680,
            },
        })).toEqual({
            state,
            updates: {},
            changed: false,
            canContain: true,
        });
    });

    test('moves drag-only state without adding fixed dimensions', () => {
        const result = resolveMovingUIViewportState({
            left: 900,
            top: 80,
            right: -300,
            bottom: 120,
        }, {
            viewportWidth: 1200,
            viewportHeight: 800,
            elementBounds: {
                left: 900,
                top: 80,
                right: 1500,
                bottom: 680,
                width: 600,
                height: 600,
            },
        });

        expect(result).toMatchObject({
            changed: true,
            canContain: true,
            updates: {
                left: 600,
                right: 0,
            },
        });
        expect(result.state).not.toHaveProperty('width');
        expect(result.state).not.toHaveProperty('height');
    });

    test('does not repeatedly rewrite contained state when CSS keeps the rendered box oversized', () => {
        const state = {
            width: 1000,
            height: 700,
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };

        expect(resolveMovingUIViewportState(state, {
            viewportWidth: 1000,
            viewportHeight: 700,
            elementBounds: {
                left: 0,
                top: 0,
                right: 1200,
                bottom: 700,
                width: 1200,
                height: 700,
            },
        })).toEqual({
            state,
            updates: {},
            changed: false,
            canContain: true,
        });
    });
});

describe('MovingUI viewport scaling', () => {
    test('scales pixel geometry while preserving responsive and absent dimensions', () => {
        expect(scaleMovingUIViewportState({
            width: 'var(--sheldWidth)',
            left: '100px',
            top: 50,
            right: 20,
            bottom: 30,
        }, {
            scaleX: 0.5,
            scaleY: 2,
        })).toEqual({
            width: 'var(--sheldWidth)',
            left: '50',
            top: '100',
            right: '10',
            bottom: '60',
        });
    });

    test('ignores invalid scale factors instead of persisting invalid geometry', () => {
        const state = { width: 600, height: 500, left: 100, top: 50 };

        expect(scaleMovingUIViewportState(state, {
            scaleX: Number.NaN,
            scaleY: 0,
        })).toEqual(state);
    });
});
