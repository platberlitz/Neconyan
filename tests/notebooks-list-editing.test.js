import { continueList, formatList, indentLines, listItem, literalAt } from '../public/scripts/notebooks/list-editing.js';
import { splitNoteFrontmatter } from '../public/scripts/notebooks/folding.js';

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

    test.each(['```md\n- Example', '~~~\n1. Example'])('literal examples are left alone', text => {
        expect(continueList(text, text.length)).toBeNull();
        expect(indentLines(text, text.length, text.length, false, { listsOnly: true })).toBeNull();
    });

    test('an unclosed properties block does not make the rest of the note literal', () => {
        const text = '---\nitems:\n- Example';
        expect(applied(text, continueList(text, text.length))).toBe(`${text}\n- `);
        expect(formatList(text, 11, 20, 'ordered').insert).toBe('1. Example');
        expect(indentLines(text, 11, 20, false, { listsOnly: true }).insert).toBe('    - Example');
    });

    test('lists after closed code and property blocks continue normally', () => {
        for (const prefix of ['```\n- literal\n```\n', '---\ntype: scene\n---\n']) {
            const text = `${prefix}- Ferry`;
            expect(applied(text, continueList(text, text.length))).toBe(`${text}\n- `);
        }
    });

    test('a closed properties block is still literal inside', () => {
        const text = '---\ntype: scene\n---\n- Example';
        expect(literalAt(text, 4)).toBe(true);
        expect(literalAt(text, text.indexOf('- Example'))).toBe(false);
    });

    test('the editor and the store agree on which LF notes have a properties block', () => {
        const rows = [
            { text: '- a', hasFrontmatter: false },
            { text: '---\ntype: scene\n---\n- a', hasFrontmatter: true },
            { text: '---\ntype: scene\n...\n- a', hasFrontmatter: true },
            { text: '---\nitems:\n- Example', hasFrontmatter: false },
            { text: '\uFEFF---\ntype: scene\n---\n- a', hasFrontmatter: true },
            { text: '---\n---\n- a', hasFrontmatter: true },
        ];
        for (const row of rows) {
            const split = splitNoteFrontmatter(row.text);
            expect(split.hasFrontmatter).toBe(row.hasFrontmatter);
            expect(literalAt(row.text, 0)).toBe(split.hasFrontmatter);
            if (!split.hasFrontmatter) continue;
            const listLine = row.text.indexOf('- a', split.bodyStart);
            expect(listLine).toBeGreaterThanOrEqual(split.bodyStart);
            expect(literalAt(row.text, listLine)).toBe(false);
            expect(applied(row.text, continueList(row.text, row.text.length))).toBe(`${row.text}\n- `);
        }
    });

    test('fences are not a properties block, and their inside stays literal', () => {
        for (const text of ['```\n- Example\n```\n- a', '~~~\n- Example\n~~~\n- a']) {
            expect(splitNoteFrontmatter(text).hasFrontmatter).toBe(false);
            expect(literalAt(text, 0)).toBe(false);
            expect(literalAt(text, text.indexOf('- Example'))).toBe(true);
            expect(literalAt(text, text.indexOf('- a'))).toBe(false);
        }
    });

    test('a CRLF or U+2028 close is ordinary text for the editor, by design', () => {
        const crlf = '---\na: 1\n---\r\n- a';
        expect(splitNoteFrontmatter(crlf)).toMatchObject({ hasFrontmatter: true, bodyStart: 14 });
        expect(literalAt(crlf, 0)).toBe(false);
        expect(literalAt(crlf, 14)).toBe(false);
        expect(applied(crlf, continueList(crlf, crlf.length))).toBe(`${crlf}\n- `);

        const separated = '---\na\u2028---\n- a';
        expect(splitNoteFrontmatter(separated).hasFrontmatter).toBe(true);
        expect(literalAt(separated, 0)).toBe(false);
        expect(applied(separated, continueList(separated, separated.length))).toBe(`${separated}\n- `);

        // A CRLF opener stays ordinary text, as it was before this change.
        expect(literalAt('---\r\n- a', 0)).toBe(false);
    });

    test.each(['```md\n- Example', '~~~\n1. Example'])('list formatting does not change a literal block: %s', text => {
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
