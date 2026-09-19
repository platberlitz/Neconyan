import assert from 'node:assert/strict';
import test from 'node:test';

const {
    FORCE_OUTPUT_SEQUENCE,
    formatInstructModeChat,
    formatInstructModePrompt,
    formatInstructModeStoryString,
    getInstructStoppingSequences,
} = await import('../public/scripts/instruct-format.js');

const preset = {
    enabled: true,
    wrap: true,
    macro: false,
    names_behavior: 'always',
    input_sequence: '### {{name}}:',
    input_suffix: '',
    output_sequence: '### {{name}}:',
    output_suffix: '',
    first_output_sequence: '',
    last_output_sequence: '',
    system_sequence: '',
    last_system_sequence: '',
    stop_sequence: '',
    sequences_as_stop_strings: false,
};

test('formatInstructModeChat wraps names and only expands macros when enabled', () => {
    assert.equal(
        formatInstructModeChat({ name: 'Alice', mes: 'Hi', isUser: true, name1: 'Alice', name2: 'Nova', customInstruct: preset }),
        '### {{name}}:\nAlice: Hi\n',
    );
    assert.equal(
        formatInstructModeChat({ name: 'Nova', mes: 'Hello', isUser: false, name1: 'Alice', name2: 'Nova', customInstruct: preset }),
        '### {{name}}:\nNova: Hello\n',
    );

    const macro = { ...preset, macro: true };
    assert.equal(
        formatInstructModeChat({ name: 'Nova', mes: 'Hi', name1: 'Alice', name2: 'Nova', customInstruct: macro, substitute: value => value.replace(/{{name}}/g, 'Alice') }),
        '### Alice:\nNova: Hi\n',
    );
});

test('formatInstructModeChat uses the forced first/last sequences', () => {
    const forced = { ...preset, first_output_sequence: 'FIRST {{name}}:', last_output_sequence: 'LAST {{name}}:' };
    assert.equal(
        formatInstructModeChat({ name: 'Nova', mes: 'Hi', name1: 'Alice', name2: 'Nova', forceOutputSequence: FORCE_OUTPUT_SEQUENCE.FIRST, customInstruct: forced }),
        'FIRST {{name}}:\nNova: Hi\n',
    );
    assert.equal(
        formatInstructModeChat({ name: 'Nova', mes: 'Hi', name1: 'Alice', name2: 'Nova', forceOutputSequence: FORCE_OUTPUT_SEQUENCE.LAST, customInstruct: forced }),
        'LAST {{name}}:\nNova: Hi\n',
    );
});

test('formatInstructModePrompt keeps quiet requests unnamed and trims the leading separator', () => {
    assert.equal(
        formatInstructModePrompt({ name: 'Nova', name1: 'Alice', name2: 'Nova', customInstruct: preset }),
        '\n### {{name}}:\nNova:',
    );
    assert.equal(
        formatInstructModePrompt({ name: 'Nova', isQuiet: true, name1: 'Alice', name2: 'Nova', customInstruct: preset }),
        '### {{name}}:\n',
    );
});

test('getInstructStoppingSequences collects preset and context stops without duplicates', () => {
    const withSequences = { ...preset, sequences_as_stop_strings: true, stop_sequence: 'END' };
    const stops = getInstructStoppingSequences({
        customInstruct: withSequences,
        useStopStrings: true,
        context: { use_stop_strings: true, chat_start: 'START', example_separator: 'EX' },
        name1: 'Alice',
        name2: 'Nova',
    });
    assert.deepEqual(stops, ['\nEND', '\n### Alice:', '\n### Nova:', '\nSTART', '\nEX']);
});

test('formatInstructModeStoryString only wraps when the story is not in-chat', () => {
    const instruct = { ...preset, story_string_prefix: 'PRE', story_string_suffix: 'SUF' };
    assert.equal(
        formatInstructModeStoryString('story', { customInstruct: instruct, customContext: { story_string_position: 0 } }),
        'PRE\nstorySUF',
    );
    assert.equal(
        formatInstructModeStoryString('story', { customInstruct: instruct, customContext: { story_string_position: 1 } }),
        'story',
    );
});
