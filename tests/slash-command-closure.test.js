import { jest } from '@jest/globals';

jest.unstable_mockModule('../public/script.js', () => ({ substituteParams: text => text }));
jest.unstable_mockModule('../public/lib.js', () => ({ hljs: {} }));
const { SlashCommandClosure } = await import('../public/scripts/slash-commands/SlashCommandClosure.js');

test.each([
    ['["first","second"]', '1', 'second'],
    ['{"name":"Nova"}', 'name', 'Nova'],
])('legacy scoped variables honour the requested index in %s', (value, index, expected) => {
    const closure = new SlashCommandClosure();
    closure.scope.letVariable('items', value);
    expect(closure.substituteParams(`{{var::items::${index}}}`)).toBe(expected);
});

test('preserves a single character after a closure macro', () => {
    const closure = new SlashCommandClosure();
    const nested = new SlashCommandClosure();
    closure.scope.setMacro('nested', nested);
    expect(closure.substituteParams('{{nested}}!')).toEqual([nested, '!']);
});
