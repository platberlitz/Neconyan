/* global globalThis, document */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ debounce: fn => fn, escapeRegex: value => value }));
const { AutoComplete } = await import('../public/scripts/autocomplete/AutoComplete.js');

function completion(text = '/ec Keep the rest | /pass tail') {
    const input = Object.assign(new EventTarget(), {
        value: text, selectionStart: 3, selectionEnd: 3,
        focus: jest.fn(),
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    });
    const ac = Object.assign(Object.create(AutoComplete.prototype), {
        textarea: input, text, isReplaceable: true, showRequest: 0,
        parserResult: { start: 1, name: 'ec' },
        selectedItem: { value: 'echo', replacer: 'echo', isSelectable: true },
        show: jest.fn(), hide: jest.fn(),
    });
    return { ac, input };
}

afterEach(() => { delete globalThis.document; });

test.each(['false', 'wrong text', 'throw'])('repairs a native insert that returns %s without losing the draft', async mode => {
    const { ac, input } = completion();
    globalThis.document = { execCommand: jest.fn(() => {
        input.value = '';
        input.dispatchEvent(new Event('input'));
        ac.text = input.value;
        if (mode === 'throw') throw new Error('Native insertion unavailable');
        return mode !== 'false';
    }) };
    const changed = jest.fn();
    input.addEventListener('input', changed);
    await ac.select();
    expect(input.value).toBe('/echo Keep the rest | /pass tail');
    expect(input.selectionStart).toBe(5);
    expect(changed).toHaveBeenCalled();
});

test('does not apply a stale completion to a changed draft', async () => {
    const { ac, input } = completion();
    input.value = 'A newer draft';
    globalThis.document = { execCommand: jest.fn() };
    await ac.select();
    expect(input.value).toBe('A newer draft');
    expect(document.execCommand).not.toHaveBeenCalled();
});

test('touch completion avoids native insertion and keeps text on both sides', async () => {
    const { ac, input } = completion('/pass prefix | /ec Keep the rest');
    ac.parserResult.start = 16;
    globalThis.document = { execCommand: jest.fn() };
    await ac.select(false);
    expect(input.value).toBe('/pass prefix | /echo Keep the rest');
    expect(document.execCommand).not.toHaveBeenCalled();
});

test('a touch scroll does not choose a suggestion, while a finished tap does', () => {
    const { ac } = completion();
    const item = new EventTarget();
    const option = { renderItem: () => item };
    ac.result = [option];
    ac.select = jest.fn();
    ac.makeItem(option);
    const pointer = (type, y = 10) => item.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
        button: 0, pointerType: 'touch', pointerId: 1, clientX: 10, clientY: y,
    }));
    pointer('pointerdown');
    pointer('pointermove', 40);
    pointer('pointerup', 40);
    expect(ac.select).not.toHaveBeenCalled();
    pointer('pointerdown');
    expect(ac.select).not.toHaveBeenCalled();
    pointer('pointerup');
    expect(ac.select).toHaveBeenCalledWith(false);
});

test('keeps successful native insertion in the undo history', async () => {
    const { ac, input } = completion();
    globalThis.document = { execCommand: jest.fn((command, ui, text) => {
        input.value = input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd);
        return true;
    }) };
    await ac.select();
    expect(input.value).toBe('/echo Keep the rest | /pass tail');
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'echo');
});

test('ignores an asynchronous result after another edit', async () => {
    const { ac, input } = completion();
    let resolve;
    ac.getNameAt = () => new Promise(done => { resolve = done; });
    ac.checkIfActivate = () => true;
    // Exercise the actual show method, rather than the selection test stub.
    delete ac.show;
    globalThis.document = { activeElement: input };
    const pending = ac.show(true);
    input.value = 'New text';
    resolve({ start: 1, name: 'old' });
    await pending;
    expect(ac.parserResult.name).toBe('ec');
});

test('accepts a current asynchronous result', async () => {
    const { ac, input } = completion();
    ac.getNameAt = async () => null;
    ac.checkIfActivate = () => true;
    delete ac.show;
    globalThis.document = { activeElement: input };
    await ac.show(true);
    expect(ac.parserResult).toBeNull();
    expect(ac.hide).toHaveBeenCalled();
});
