import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(testDirectory, '..', 'public', 'scripts', 'power-user.js'), 'utf8');

function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let index = source.indexOf('{', start); index < source.length; index++) {
        if (source[index] === '{') {
            depth++;
        } else if (source[index] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(`Could not find the end of ${name}`);
}

describe('power user style writes', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('the custom CSS editor renders once the typing pauses and flushes on leave', () => {
        const applyCustomCSS = jest.fn();
        const context = vm.createContext({ applyCustomCSS, setTimeout, clearTimeout });
        vm.runInContext([
            'let customCssRenderTimer = 0;',
            extractFunction('scheduleCustomCssRender'),
            extractFunction('flushCustomCssRender'),
        ].join('\n'), context);

        context.scheduleCustomCssRender();
        context.scheduleCustomCssRender();
        context.scheduleCustomCssRender();
        jest.advanceTimersByTime(149);
        expect(applyCustomCSS).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(applyCustomCSS).toHaveBeenCalledTimes(1);

        context.scheduleCustomCssRender();
        context.flushCustomCssRender();
        expect(applyCustomCSS).toHaveBeenCalledTimes(2);
    });

    test('slider applications share one frame and repeat entries run once', () => {
        const frames = [];
        const context = vm.createContext({
            requestAnimationFrame: callback => {
                frames.push(callback);
                return frames.length;
            },
            Set,
        });
        vm.runInContext([
            'const pendingStyleApplications = new Set();',
            'let styleApplicationFrame = 0;',
            extractFunction('coalesceStyleApplication'),
        ].join('\n'), context);

        const blur = jest.fn();
        const shadow = jest.fn();
        context.coalesceStyleApplication(blur);
        context.coalesceStyleApplication(shadow);
        context.coalesceStyleApplication(blur);
        expect(frames).toHaveLength(1);
        expect(blur).not.toHaveBeenCalled();

        frames[0]();
        expect(blur).toHaveBeenCalledTimes(1);
        expect(shadow).toHaveBeenCalledTimes(1);

        context.coalesceStyleApplication(shadow);
        expect(frames).toHaveLength(2);
    });

    test('the editors and sliders use the coalesced paths', () => {
        expect(source).toContain('scheduleCustomCssRender();\n    });\n    $(\'#customCSS\').on(\'change blur\', flushCustomCssRender);');
        expect(source).toContain('coalesceStyleApplication(applyBlurStrength);');
        expect(source).toContain('coalesceStyleApplication(applyShadowWidth);');
        expect(source).toContain('coalesceStyleApplication(applyThemeEffects);');
    });
});
