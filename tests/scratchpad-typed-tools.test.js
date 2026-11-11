import { describe, expect, test } from '@jest/globals';
import { expandTypedTools, MAX_ROLL_DICE, TypedToolError } from '../public/scripts/scratchpad/typed-tools.js';

const sequence = values => {
    let index = 0;
    return max => values[index++ % values.length] % max;
};
const failure = text => {
    try {
        expandTypedTools(text, { randomInt: () => 0 });
    } catch (error) {
        return error;
    }
    return null;
};

describe('Scratchpad typed tools', () => {
    test('a message without a command line is left exactly as typed', () => {
        const text = 'Compare /roll with dice.\n /unknown thing\n/rolling stones';
        expect(expandTypedTools(text)).toEqual({ text, used: [], help: false });
    });

    test('dice lines become their result, with every die shown', () => {
        const result = expandTypedTools('How does this go?\n/roll 2d6+1 for stealth\n/ROLL d20 - 2', { randomInt: sequence([3, 4, 19]) });
        expect(result.text).toBe('How does this go?\n\u{1F3B2} 2d6+1 (for stealth): [4, 5] + 1 = 10\n\u{1F3B2} 1d20-2: [20] - 2 = 18');
        expect(result.used).toEqual(['roll', 'roll']);
        expect(expandTypedTools('/roll 1d4+2d8', { randomInt: sequence([0, 7, 0]) }).text).toBe('\u{1F3B2} 1d4+2d8: [1] + [8, 1] = 10');
    });

    test('dice stay inside their sides with the default random source', () => {
        for (let index = 0; index < 50; index += 1) {
            const total = Number(/= (-?\d+)$/.exec(expandTypedTools('/roll 3d6').text)[1]);
            expect(total).toBeGreaterThanOrEqual(3);
            expect(total).toBeLessThanOrEqual(18);
        }
    });

    test('a roll that is not dice, or asks for too much, is refused with its line', () => {
        expect(failure('/roll banana')).toMatchObject({ code: 'roll', line: '/roll banana' });
        expect(failure('/roll 12')).toBeInstanceOf(TypedToolError);
        expect(failure('/roll')).toMatchObject({ code: 'roll' });
        expect(failure(`/roll ${MAX_ROLL_DICE + 1}d6`)).toMatchObject({ code: 'roll-limit' });
        expect(failure('/roll 2d1')).toMatchObject({ code: 'roll-limit' });
        expect(failure('/roll 0d6')).toMatchObject({ code: 'roll-limit' });
        expect(failure('/roll 1d1001')).toMatchObject({ code: 'roll-limit' });
        expect(failure(`/roll ${MAX_ROLL_DICE}d6`)).toBeNull();
    });

    test('sums follow the usual order and never run code', () => {
        const calc = text => expandTypedTools(`/calc ${text}`).text;
        expect(calc('12*(3+4)')).toBe('\u{1F9EE} 12*(3+4) = 84');
        expect(calc('2 + 3 × 4')).toBe('\u{1F9EE} 2 + 3 × 4 = 14');
        expect(calc('-2^2')).toBe('\u{1F9EE} -2^2 = -4');
        expect(calc('2^3^2')).toBe('\u{1F9EE} 2^3^2 = 512');
        expect(calc('0.1+0.2')).toBe('\u{1F9EE} 0.1+0.2 = 0.3');
        expect(calc('7 % 4 / 2')).toBe('\u{1F9EE} 7 % 4 / 2 = 1.5');
        expect(calc('1,5 ÷ 2')).toBe('\u{1F9EE} 1,5 ÷ 2 = 0.75');
        for (const text of ['', '2+', '(2', '2)', 'alert(1)', '2**3', 'globalThis', `${'1+'.repeat(120)}1`]) {
            expect(failure(`/calc ${text}`)).toMatchObject({ code: 'calc' });
        }
        expect(failure('/calc 1/0')).toMatchObject({ code: 'calc-result' });
        expect(failure('/calc 0/0')).toMatchObject({ code: 'calc-result' });
    });

    test('a pick names the choice and what it chose from', () => {
        const labels = { picked: 'Chosen', from: 'out of', now: 'Now' };
        expect(expandTypedTools('/pick tea | coffee, black | cocoa', { randomInt: () => 1, labels }).text)
            .toBe('\u{1F3AF} Chosen: coffee, black (out of: tea, coffee, black, cocoa)');
        expect(expandTypedTools('/pick north, south', { randomInt: () => 0 }).text).toBe('\u{1F3AF} Picked: north (from: north, south)');
        expect(failure('/pick only')).toMatchObject({ code: 'pick' });
        expect(failure('/pick')).toMatchObject({ code: 'pick' });
    });

    test('now gives the date and time, and code blocks are not touched', () => {
        const now = new Date(2026, 10, 12, 14, 5);
        const result = expandTypedTools('/now\n```\n/roll 2d6\n```\n/now', { now, locale: 'en-GB' });
        const stamp = '\u{1F552} Now: Thursday 12 November 2026 at 14:05';
        expect(result.text.replace(/,/g, '')).toBe(`${stamp}\n\`\`\`\n/roll 2d6\n\`\`\`\n${stamp}`);
        expect(result.used).toEqual(['now', 'now']);
    });

    test('asking for the list alone is reported and changes nothing', () => {
        expect(expandTypedTools(' /tools ')).toMatchObject({ help: true, used: [] });
        expect(expandTypedTools('/help')).toMatchObject({ help: true });
        expect(expandTypedTools('/help me with this')).toMatchObject({ help: false });
    });
});
