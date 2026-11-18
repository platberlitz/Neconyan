import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The Panels store helpers are pure, so they run here exactly as neconyan-tabs.js ships them.
const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const slice = pattern => {
    const match = source.match(pattern)?.[0];
    if (!match) throw new Error(`Could not extract ${pattern} from neconyan-tabs.js.`);
    return match;
};
const code = [
    slice(/^const NN_PANEL_SURFACES = [^\n]*;/m),
    slice(/^const NN_PANEL_LOOK = Object\.freeze\(\{[\s\S]*?^\}\);/m),
    slice(/^const NN_TEXT_OUTLINE = [^\n]*;/m),
    slice(/^function snapPanelLookValue\(value, range\) \{[\s\S]*?^\}/m),
    slice(/^function normalizePanelLookOutline\(value\) \{[\s\S]*?^\}/m),
    slice(/^function normalizePanelLookStyle\(value\) \{[\s\S]*?^\}/m),
    slice(/^function normalizePanelLookStore\(value, styleIds\) \{[\s\S]*?^\}/m),
    slice(/^function migratePanelLookStore\(oldValue, hadDeviceTheme, styleIds\) \{[\s\S]*?^\}/m),
    slice(/^function applyPanelLookNoticeAnswer\(store, answer\) \{[\s\S]*?^\}/m),
    slice(/^function panelLookKnobMark\(defaults\) \{[\s\S]*?^\}/m),
    slice(/^function panelLookIndexToPosition\(index, mark\) \{[\s\S]*?^\}/m),
    slice(/^function panelLookPositionToIndex\(position, mark\) \{[\s\S]*?^\}/m),
].join('\n');
const { normalize, migrate, answer, knobMark, indexToPosition, positionToIndex } = vm.runInNewContext(`${code}\n({
    normalize: normalizePanelLookStore, migrate: migratePanelLookStore, answer: applyPanelLookNoticeAnswer,
    knobMark: panelLookKnobMark, indexToPosition: panelLookIndexToPosition, positionToIndex: panelLookPositionToIndex,
})`);
const plain = value => JSON.parse(JSON.stringify(value));

const STYLES = ['calico', 'kittyless', 'windows-aero', 'windows-xp', 'windows-98', 'clean-minimal', 'macos-minimal', 'cozy-warm', 'hypr-glow', 'slate-flat', 'starlight-conservatory', 'sunken-reef'];
const shippedStyles = [...source.matchAll(/^ {8}id: '([a-z0-9-]+)',$/gm)].map(match => match[1]).filter(id => STYLES.includes(id));
const empty = { version: 1, styles: {} };
// The migration holds side panels at each style's own default ('default'), so the old slider never makes them clearer.
const everywhere = position => Object.fromEntries(STYLES.map(id => [id, { position, side: { opacity: 'default' } }]));

describe('Panels store normalisation', () => {
    test('the twelve shell styles are the ones the shell ships', () => {
        expect([...new Set(shippedStyles)].sort()).toEqual([...STYLES].sort());
    });

    test.each([null, undefined, '', 'not json', '[]', '42', '"text"', '{"version":2,"styles":{"calico":{"position":-40}}}'])('reads %p as an empty store', value => {
        expect(plain(normalize(value, STYLES))).toEqual(empty);
    });

    test('keeps valid values and drops unknown styles and keys', () => {
        const stored = normalize(JSON.stringify({
            version: 1,
            styles: {
                calico: { position: -40, blur: 16, message: { opacity: 70, blur: 8 }, outline: { on: true, width: 1.5, colour: 'dark' }, extra: 1 },
                'not-a-style': { position: 20 },
                'windows-xp': { home: { opacity: 50 }, side: 'solid' },
            },
            notice: 'choice',
            other: true,
        }), STYLES);
        expect(plain(stored)).toEqual({
            version: 1,
            styles: {
                calico: { position: -40, blur: 16, message: { opacity: 70, blur: 8 }, outline: { on: true, width: 1.5, colour: 'dark' } },
                'windows-xp': { home: { opacity: 50 } },
            },
            notice: 'choice',
        });
    });

    test.each([
        [{ position: -43 }, { position: -43 }],
        [{ position: 4 }, { position: 4 }],
        [{ position: -43.4 }, { position: -43 }],
        [{ position: 250 }, { position: 100 }],
        [{ position: -250 }, { position: -100 }],
        [{ position: 0 }, null],
        [{ position: 'x' }, null],
        [{ blur: 7 }, { blur: 8 }],
        [{ blur: 99 }, { blur: 40 }],
        [{ blur: -3 }, { blur: 0 }],
        [{ message: { opacity: 37 } }, { message: { opacity: 35 } }],
        [{ home: { opacity: 140, blur: '12' } }, { home: { opacity: 100, blur: 12 } }],
        [{ side: { opacity: null } }, null],
        [{ side: { opacity: 'default' } }, { side: { opacity: 'default' } }],
        [{ side: { opacity: 'default', blur: 6 } }, { side: { opacity: 'default', blur: 6 } }],
        [{ side: { opacity: 'solid' } }, null],
        [{ home: { opacity: 'Default' } }, null],
        [{ outline: { on: 'yes', width: 2.3, colour: 'pink' } }, { outline: { width: 2.5 } }],
        [{ outline: { width: 9 } }, { outline: { width: 3 } }],
        [{ outline: { width: 0 } }, { outline: { width: 1 } }],
        [{ outline: { on: false, colour: 'light' } }, { outline: { on: false, colour: 'light' } }],
    ])('snaps and clamps %p', (style, expected) => {
        const stored = plain(normalize({ version: 1, styles: { calico: style } }, STYLES));
        expect(stored).toEqual(expected ? { version: 1, styles: { calico: expected } } : empty);
    });

    test.each(['follow', 'choice'])('keeps the %s notice', notice => {
        expect(normalize({ notice }, STYLES).notice).toBe(notice);
    });

    test.each(['seen', 'yes', 1, null])('drops the notice %p', notice => {
        expect(plain(normalize({ notice }, STYLES))).toEqual(empty);
    });
});

describe('Panels migration from Background Visibility', () => {
    test.each([[null, true], [null, false], ['', true], ['  ', false], ['abc', true], ['NaN', false]])('no readable old value %p (device seen before: %p)', (oldValue, hadDeviceTheme) => {
        expect(plain(migrate(oldValue, hadDeviceTheme, STYLES))).toEqual(hadDeviceTheme ? { ...empty, notice: 'follow' } : empty);
    });

    test.each([
        ['0', 100],
        ['100', -100],
        ['70', -40],
        ['35', 30],
        ['37', 30],
        ['30', 40],
        ['-20', 100],
        ['140', -100],
    ])('old value %p seeds position %p in every style and asks for a choice', (oldValue, position) => {
        for (const hadDeviceTheme of [true, false]) {
            expect(plain(migrate(oldValue, hadDeviceTheme, STYLES))).toEqual({ version: 1, styles: everywhere(position), notice: 'choice' });
        }
    });

    test.each(['50', '52', '48'])('old value %p maps to Style default: nothing stored and note A', oldValue => {
        for (const hadDeviceTheme of [true, false]) {
            expect(plain(migrate(oldValue, hadDeviceTheme, STYLES))).toEqual({ ...empty, notice: 'follow' });
        }
    });

    test('every old step lands on a step of the new slider', () => {
        for (let value = 0; value <= 100; value += 5) {
            const position = migrate(String(value), true, STYLES).styles.calico?.position ?? 0;
            expect(Math.abs(position) % 10).toBe(0);
            expect(position).toBe(100 - 2 * value);
        }
    });

    test('old 70 holds side panels at the style default in Calico', () => {
        expect(plain(migrate('70', true, STYLES).styles.calico)).toEqual({ position: -40, side: { opacity: 'default' } });
    });

    test('the migrated store normalises to itself', () => {
        for (const oldValue of [null, '0', '35', '50', '70', '100']) {
            const store = migrate(oldValue, true, STYLES);
            expect(plain(normalize(JSON.stringify(store), STYLES))).toEqual(plain(store));
        }
    });
});

describe('Panels note answers', () => {
    test.each([null, '50'])('seen removes note A from the store of %p', oldValue => {
        const store = migrate(oldValue, true, STYLES);
        expect(plain(answer(store, 'seen'))).toEqual(empty);
    });

    test.each([['0', 100], ['100', -100]])('keep removes note B and leaves %p mapped to %p', (oldValue, position) => {
        expect(plain(answer(migrate(oldValue, true, STYLES), 'keep'))).toEqual({ version: 1, styles: everywhere(position) });
    });

    test.each(['0', '100'])('defaults removes note B and every position from the store of %p', oldValue => {
        expect(plain(answer(migrate(oldValue, true, STYLES), 'defaults'))).toEqual(empty);
    });

    test('defaults keeps blur, surface and outline values set in the meantime', () => {
        const store = migrate('0', true, STYLES);
        store.styles.calico = { position: 100, blur: 12, message: { opacity: 60 }, side: { opacity: 'default' }, outline: { on: true, width: 2, colour: 'auto' } };
        store.styles['windows-xp'] = { position: 100, home: { blur: 4 }, side: { opacity: 'default', blur: 6 } };
        store.styles['windows-aero'] = { position: 100, side: { opacity: 60 } };
        const next = plain(answer(store, 'defaults'));
        expect(next.notice).toBeUndefined();
        expect(next.styles.calico).toEqual({ blur: 12, message: { opacity: 60 }, outline: { on: true, width: 2, colour: 'auto' } });
        expect(next.styles['windows-xp']).toEqual({ home: { blur: 4 }, side: { blur: 6 } });
        expect(next.styles['windows-aero']).toEqual({ side: { opacity: 60 } });
        expect(next.styles['windows-98']).toBeUndefined();
    });

    test('keep leaves the side panel pins', () => {
        const next = plain(answer(migrate('70', true, STYLES), 'keep'));
        expect(next.notice).toBeUndefined();
        for (const id of STYLES) expect(next.styles[id]).toEqual({ position: -40, side: { opacity: 'default' } });
    });

    test('an unknown answer leaves the store and its note alone', () => {
        const store = migrate('0', true, STYLES);
        expect(plain(answer(store, 'maybe'))).toEqual(plain(store));
    });
});

// Shell defaults from the plan's table (4.2): [messages light, messages dark, Home cards, side panels on desktop].
const DEFAULTS = {
    calico: [0.9, 0.9, 0.85, 1],
    kittyless: [1, 1, 1, 1],
    'windows-aero': [1, 0.95, 0.8, 0.92],
    'windows-xp': [1, 1, 1, 1],
    'windows-98': [1, 1, 1, 1],
    'clean-minimal': [0.85, 0.85, 0.85, 1],
    'macos-minimal': [1, 0.95, 0.7, 0.92],
    'cozy-warm': [1, 0.9, 0.85, 1],
    'hypr-glow': [1, 0.9, 0.7, 0.92],
    'slate-flat': [1, 0.9, 0.85, 1],
    'starlight-conservatory': [1, 0.95, 0.8, 1],
    'sunken-reef': [1, 0.95, 0.8, 1],
};
// Marks at the defaults: desktop light, desktop dark, phone light, phone dark (phones: messages and Home cards only).
const MARKS = {
    calico: [18, 18, 18, 18],
    kittyless: [20, 20, 20, 20],
    'windows-xp': [20, 20, 20, 20],
    'windows-98': [20, 20, 20, 20],
    'windows-aero': [18, 18, 18, 18],
    'clean-minimal': [18, 18, 17, 17],
    'macos-minimal': [17, 17, 17, 17],
    'cozy-warm': [19, 18, 19, 18],
    'hypr-glow': [17, 17, 17, 16],
    'slate-flat': [19, 18, 19, 18],
    'starlight-conservatory': [19, 18, 18, 18],
    'sunken-reef': [19, 18, 18, 18],
};
const N = 20;

describe('Panel opacity knob', () => {
    test.each([
        [[1], 20], [[1, 1, 1], 20], [[0.9995], 20],
        [[0], 0], [[0, 0], 0],
        [[0.99], 19], [[0.004], 1],
        [[0.9, 0.85, 0.85], 17],
        [[0.9, 0.85, 1], 18], [[0.85, 0.85, 1], 18], [[1, 0.8, 1], 19],
        [[0.9, 0.85], 18], [[0.9, 0.7], 16], [[], 20],
    ])('the mark of %p is %p', (defaults, mark) => {
        expect(knobMark(defaults)).toBe(mark);
    });

    test('every shell has the mark the plan lists, desktop and phone, both tones', () => {
        expect(Object.keys(MARKS).sort()).toEqual([...STYLES].sort());
        for (const id of STYLES) {
            const [light, dark, home, side] = DEFAULTS[id];
            const marks = [knobMark([light, home, side]), knobMark([dark, home, side]), knobMark([light, home]), knobMark([dark, home])];
            expect([id, marks]).toEqual([id, MARKS[id]]);
        }
    });

    test('a step gives the position on its own side of the mark', () => {
        for (let mark = 1; mark <= 19; mark++) {
            expect(indexToPosition(mark, mark)).toBe(0);
            expect(indexToPosition(0, mark)).toBe(-100);
            expect(indexToPosition(20, mark)).toBe(100);
        }
        expect(indexToPosition(20, 20)).toBe(0);
        expect(indexToPosition(10, 17)).toBe(-41);
        expect(indexToPosition(19, 17)).toBe(67);
        expect(indexToPosition(11, 18)).toBe(-39);
    });

    test('a position gives back the step it came from, for every mark and step', () => {
        const failures = [];
        for (let mark = 0; mark <= N; mark++) {
            expect(positionToIndex(0, mark)).toBe(mark);
            expect(positionToIndex(-100, mark)).toBe(0);
            expect(positionToIndex(100, mark)).toBe(20);
            for (let index = 0; index <= N; index++) {
                if (index !== mark) {
                    const back = positionToIndex(indexToPosition(index, mark), mark);
                    if (back !== index) failures.push([mark, index, back]);
                }
            }
        }
        expect(failures).toEqual([]);
    });

    test('a non-zero position never lands on the mark, and only the ends of the range land on an end', () => {
        const failures = [];
        for (let mark = 0; mark <= N; mark++) {
            for (let position = -100; position <= 100; position++) {
                if (position === 0) continue;
                const index = positionToIndex(position, mark);
                const hasStep = position < 0 ? mark > 0 : mark < N;
                const singleStep = position < 0 ? mark === 1 : mark === N - 1;
                if (hasStep && index === mark) failures.push(['on the mark', mark, position]);
                if (Math.abs(position) < 100 && hasStep && !singleStep && (index === 0 || index === N)) failures.push(['on an end', mark, position]);
            }
        }
        expect(failures).toEqual([]);
        expect(positionToIndex(-40, 1)).toBe(0);
        expect(positionToIndex(10, 19)).toBe(20);
        for (const position of [1, 10, 40, 99]) expect(positionToIndex(position, 20)).toBe(20);
        expect(positionToIndex(-40, 17)).toBe(10);
        expect(positionToIndex(10, 17)).toBe(18);
    });

    test.each([[17, 10, 18], [18, 11, 19], [20, 12, 20]])('migration positions -40 and 40 at mark %p give steps %p and %p', (mark, left, right) => {
        expect(positionToIndex(-40, mark)).toBe(left);
        expect(positionToIndex(40, mark)).toBe(right);
    });
});
