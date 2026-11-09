import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/scratchpad/index.js', import.meta.url), 'utf8');
const code = source.match(/^function installReplySwipeGesture\([\s\S]*?^}/m)[0];

function gesture({ excluded = false, selected = false } = {}) {
    const handlers = new Map();
    const move = jest.fn();
    let clock = 0;
    const runtime = vm.createContext({ window: { getSelection: () => ({ isCollapsed: !selected }) }, Date: { now: () => clock } });
    vm.runInContext(code, runtime);
    runtime.installReplySwipeGesture({ addEventListener: (name, handler) => handlers.set(name, handler) }, move);
    const target = { closest: () => excluded };
    const point = (x, y) => ({ clientX: x, clientY: y });
    return {
        move,
        start: (count = 1) => handlers.get('touchstart')({ target, touches: Array.from({ length: count }, () => point(100, 100)) }),
        end: (x, y = 100, delay = 200) => {
            clock = delay;
            handlers.get('touchend')({ touches: [], changedTouches: [point(x, y)] });
        },
        cancel: () => handlers.get('touchcancel')(),
    };
}

describe('Scratchpad reply swipe gestures', () => {
    test.each([[20, 1], [180, -1]])('a deliberate horizontal swipe to %s selects direction %s once', (x, direction) => {
        const input = gesture();
        input.start();
        input.end(x);
        input.end(x);
        expect(input.move).toHaveBeenCalledTimes(1);
        expect(input.move).toHaveBeenCalledWith(direction);
    });

    test.each([[120, 100, 200], [160, 180, 200], [180, 100, 1000]])('short, vertical and held gestures do not switch replies (%s, %s, %s)', (x, y, delay) => {
        const input = gesture();
        input.start();
        input.end(x, y, delay);
        expect(input.move).not.toHaveBeenCalled();
    });

    test.each([{ excluded: true }, { selected: true }])('interactive content and text selection keep their normal gestures: %j', options => {
        const input = gesture(options);
        input.start();
        input.end(180);
        expect(input.move).not.toHaveBeenCalled();
    });

    test('a cancelled gesture or a second finger cannot switch replies', () => {
        const input = gesture();
        input.start();
        input.cancel();
        input.end(180);
        input.start();
        input.start(2);
        input.end(180);
        expect(input.move).not.toHaveBeenCalled();
    });
});
