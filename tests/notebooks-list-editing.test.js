import { continueList, formatList, indentLines, listItem } from '../public/scripts/notebooks/list-editing.js';

const applied = (text, edit) => text.slice(0, edit.from) + edit.insert + text.slice(edit.to);

describe('Notebook Markdown list editing', () => {
    test.each([
        ['- Ferry', '- Ferry\n- '], ['+ Ferry', '+ Ferry\n+ '], ['* Ferry', '* Ferry\n* '],
        ['9. Ferry', '9. Ferry\n10. '], ['2) Ferry', '2) Ferry\n3) '],
        ['    - Child', '    - Child\n    - '], ['- [x] Finished', '- [x] Finished\n- [ ] '],
    ])('Enter continues %s', (text, expected) => {
        const edit = continueList(text, text.length);
        expect(applied(text, edit)).toBe(expected);
        expect(edit.selection.anchor).toBe(expected.length);
    });

    test('an empty item ends the list; a selection cannot rewrite another line', () => {
        expect(applied('- Ferry\n- ', continueList('- Ferry\n- ', 10))).toBe('- Ferry\n');
        expect(continueList('- One\n- Two', 3, 10)).toBeNull();
        expect(continueList('A paragraph', 11)).toBeNull();
        expect(continueList('- One', 1)).toBeNull();
    });

    test.each(['```md\n- Example', '~~~\n1. Example', '---\nitems:\n- Example'])('literal examples are left alone', text => {
        expect(continueList(text, text.length)).toBeNull();
        expect(indentLines(text, text.length, text.length, false, { listsOnly: true })).toBeNull();
    });

    test('lists after closed code and property blocks continue normally', () => {
        for (const prefix of ['```\n- literal\n```\n', '---\ntype: scene\n---\n']) {
            const text = `${prefix}- Ferry`;
            expect(applied(text, continueList(text, text.length))).toBe(`${text}\n- `);
        }
    });

    test.each(['```md\n- Example', '~~~\n1. Example', '---\nitems:\n- Example'])('list formatting does not change a literal block: %s', text => {
        expect(formatList(text, text.length, text.length, 'ordered')).toBeNull();
    });

    test('formatting a selection cannot turn fences into list items', () => {
        const text = 'A paragraph\n```md\nExample\n```\nAnother paragraph';
        expect(formatList(text, 0, text.length, 'bullet')).toBeNull();
        expect(formatList(text, text.indexOf('```'), text.indexOf('Example'), 'task')).toBeNull();
    });

    test('formatting after closed literal blocks still numbers normal text', () => {
        for (const prefix of ['```\n- literal\n```\n', '---\ntype: scene\n---\n']) {
            const text = `${prefix}First\nSecond`;
            expect(formatList(text, prefix.length, text.length, 'ordered').insert).toBe('1. First\n2. Second');
        }
    });

    test('a selected block uses increasing numbers, including nested levels', () => {
        const text = 'First\n    Child\n    Other child\nSecond\nThird';
        const edit = formatList(text, 0, text.length, 'ordered');
        expect(edit.insert).toBe('1. First\n    1. Child\n    2. Other child\n2. Second\n3. Third');
        expect(formatList(edit.insert, 0, edit.insert.length, 'ordered').insert).toBe(text);
    });

    test('converting markers keeps indentation and does not duplicate prefixes', () => {
        expect(formatList('- First\n2. Second\n\n    - [x] Third', 0, 33, 'ordered').insert)
            .toBe('1. First\n2. Second\n\n    1. Third');
        expect(formatList('', 0, 0, 'task').insert).toBe('- [ ] ');
        expect(listItem('---')).toBeNull();
    });

    test('Tab and Shift-Tab move a list item by four spaces and retain the caret', () => {
        const text = '- Parent\n- Child';
        const nested = indentLines(text, text.length, text.length);
        const result = applied(text, nested);
        expect(result).toBe('- Parent\n    - Child');
        expect(nested.selection.anchor).toBe(text.length + 4);
        expect(applied(result, indentLines(result, result.length, result.length, true))).toBe(text);
        expect(indentLines('plain', 5, 5, false, { listsOnly: true })).toBeNull();
    });

    test('multi-line indentation keeps the selection and excludes an unselected next line', () => {
        const text = '- One\n- Two\nUntouched';
        const edit = indentLines(text, 0, 12);
        expect(applied(text, edit)).toBe('    - One\n    - Two\nUntouched');
        expect(edit.selection).toEqual({ anchor: 4, head: 19 });
        const unindent = indentLines('\t- One\n  - Two', 0, 15, true);
        expect(unindent.insert).toBe('- One\n- Two');
    });
});
