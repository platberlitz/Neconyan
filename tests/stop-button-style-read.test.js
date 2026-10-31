import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const names = ['showStopButton', 'hideStopButton'];
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(row => row.declaration ?? row).filter(row => names.includes(row.id?.name))
    .map(row => source.slice(row.start, row.end)).join('\n');

function createElement(id) {
    const classes = new Set();
    return {
        id,
        style: { display: '' },
        classList: {
            contains: name => classes.has(name),
            add: name => classes.add(name),
            remove: name => classes.delete(name),
        },
    };
}

function createRuntime() {
    const elements = {
        send_form: createElement('send_form'),
        mes_stop: createElement('mes_stop'),
    };
    const computedReads = [];
    const displayWrites = [];
    const $ = selector => {
        const element = elements[String(selector).replace(/^#/, '')];
        return {
            addClass(name) {
                element.classList.add(name);
                return this;
            },
            removeClass(name) {
                element.classList.remove(name);
                return this;
            },
            css(value) {
                // A string argument is a getComputedStyle read: the regression this pins.
                if (typeof value === 'string') {
                    computedReads.push(value);
                    throw new Error(`computed style read: ${value}`);
                }
                displayWrites.push({ id: element.id, value: { ...value } });
                if (Object.hasOwn(value, 'display')) element.style.display = value.display;
                return this;
            },
        };
    };
    const emit = jest.fn();
    const context = vm.createContext({
        $,
        document: { getElementById: id => elements[id] ?? null },
        eventSource: { emit },
        event_types: { GENERATION_ENDED: 'GENERATION_ENDED' },
        activeGenerationRun: null,
        chat: [],
    });
    vm.runInContext(functions, context);
    return { context, elements, computedReads, displayWrites, emit };
}

test('hiding an unshown Stop button reads no computed style and emits nothing', () => {
    const { context, elements, computedReads, displayWrites, emit } = createRuntime();

    context.hideStopButton();

    expect(computedReads).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expect(displayWrites).toEqual([]);
    expect(elements.mes_stop.style.display).toBe('');
});

test('a shown Stop button hides once and emits GENERATION_ENDED once, with no style read', () => {
    const { context, elements, computedReads, emit } = createRuntime();

    context.showStopButton();
    expect(elements.mes_stop.style.display).toBe('flex');
    expect(elements.send_form.classList.contains('sb-generating-controls')).toBe(true);

    context.hideStopButton();
    context.hideStopButton();

    expect(computedReads).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('GENERATION_ENDED', 0);
    expect(elements.mes_stop.style.display).toBe('none');
    expect(elements.send_form.classList.contains('sb-generating-controls')).toBe(false);
});

test('an inline-flex Stop button counts as visible even without the generating class', () => {
    const { context, elements, computedReads, emit } = createRuntime();
    elements.mes_stop.style.display = 'inline-flex';

    context.hideStopButton();

    expect(computedReads).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(elements.mes_stop.style.display).toBe('none');
});

test('a silent hide still clears the button without emitting', () => {
    const { context, elements, computedReads, emit } = createRuntime();
    context.showStopButton();

    context.hideStopButton({ emitGenerationEnded: false });

    expect(computedReads).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    expect(elements.mes_stop.style.display).toBe('none');
    expect(elements.send_form.classList.contains('sb-generating-controls')).toBe(false);
});
