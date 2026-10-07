import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const { stripTrackerMandatoryMarkers } = await import('../public/scripts/tracker-mandatory-marker.js');

describe('stripTrackerMandatoryMarkers', () => {
    test('removes the copied marker from tracker field values', () => {
        const input = [
            'note: MANDATORY; the bridge collapsed behind them',
            'unlocked: MANDATORY: a new route north',
            'cause: MANDATORY - she lied about the key',
            'stamp:MANDATORY;Day 3, dusk',
        ].join('\n');

        expect(stripTrackerMandatoryMarkers(input)).toBe([
            'note: the bridge collapsed behind them',
            'unlocked: a new route north',
            'cause: she lied about the key',
            'stamp:Day 3, dusk',
        ].join('\n'));
    });

    test('handles bullets, bold labels, indentation and bracketed markers', () => {
        const input = [
            '- note: MANDATORY; trust rose after the rescue',
            '  * **Context:** MANDATORY; they share a tent',
            '__says__: (MANDATORY) "Stay close."',
            'Was: [MANDATORY] wary',
        ].join('\n');

        expect(stripTrackerMandatoryMarkers(input)).toBe([
            '- note: trust rose after the rescue',
            '  * **Context:** they share a tent',
            '__says__: "Stay close."',
            'Was: wary',
        ].join('\n'));
    });

    test('leaves prose and unmarked values untouched', () => {
        const input = [
            'Mandatory evacuation was ordered at dawn.',
            'Sign: MANDATORY overtime for all staff',
            'note: attendance is MANDATORY; no exceptions',
            'note: mandatory; lower case stays as written',
            'MANDATORY; with no label',
        ].join('\n');

        expect(stripTrackerMandatoryMarkers(input)).toBe(input);
    });

    test('returns non-string input unchanged', () => {
        expect(stripTrackerMandatoryMarkers(undefined)).toBeUndefined();
        expect(stripTrackerMandatoryMarkers(null)).toBeNull();
        expect(stripTrackerMandatoryMarkers('')).toBe('');
    });

    test('cleans a block that copies a bundled tracker template line', () => {
        const templateSource = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/index.json', import.meta.url), 'utf8');
        expect(templateSource).toContain('MANDATORY;');

        const reply = '<tracker>\nmood: tense\nnote: MANDATORY; the storm cut off the pass\n</tracker>';
        expect(stripTrackerMandatoryMarkers(reply)).toBe('<tracker>\nmood: tense\nnote: the storm cut off the pass\n</tracker>');
    });
});
