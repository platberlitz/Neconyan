import { describe, expect, test } from '@jest/globals';
import {
    getPlotCompassChoice,
    getPlotCompassContentWithChoice,
    getPlotCompassPrompt,
    parsePlotCompassChoices,
    PLOT_COMPASS_CHOICES_INSTRUCTION,
} from '../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';

const NOTE = [
    '**Direction:** The heist turns personal.',
    '**Where we are:** Mira has the key but not the code.',
    '**Possible developments:**',
    '1. Mira bribes the night guard for the code.',
    '2. **The rival crew** arrives early and forces a truce.',
    '3. Mira finds a note from her missing brother in the vault.',
    '**Next move:** 2. Have the rival crew burst in mid-conversation.',
].join('\n');

describe('Plot Compass choices', () => {
    test('reads the numbered directions and the direction Next move recommends', () => {
        expect(parsePlotCompassChoices(NOTE)).toEqual({
            choices: [
                { number: 1, text: 'Mira bribes the night guard for the code.' },
                { number: 2, text: 'The rival crew arrives early and forces a truce.' },
                { number: 3, text: 'Mira finds a note from her missing brother in the vault.' },
            ],
            pick: 2,
        });
    });

    test('accepts heading and numbering variants models write', () => {
        const note = [
            '## Possible developments',
            '- (1) A storm traps everyone inside.',
            '- **2.** The host confesses.',
            '### Next move',
            'Go with option 1 and let the lights fail.',
        ].join('\n');
        expect(parsePlotCompassChoices(note)).toEqual({
            choices: [
                { number: 1, text: 'A storm traps everyone inside.' },
                { number: 2, text: 'The host confesses.' },
            ],
            pick: 1,
        });
    });

    test('offers no choices for prose notes or a single direction', () => {
        expect(parsePlotCompassChoices('**Possible developments:** the scene could go anywhere.')).toEqual({ choices: [], pick: null });
        expect(parsePlotCompassChoices('**Possible developments:**\n1. Only one way forward.')).toEqual({ choices: [], pick: null });
    });

    test('ignores a recommended number that names no direction', () => {
        expect(parsePlotCompassChoices(NOTE.replace('**Next move:** 2.', '**Next move:** 7.')).pick).toBeNull();
    });

    test('keeps a pick only while the note still lists that direction', () => {
        const pick = { number: 3, text: 'Mira finds a note from her missing brother in the vault.' };
        expect(getPlotCompassChoice({ content: NOTE, plotCompassChoice: pick })).toEqual(pick);
        const rewritten = NOTE.replace('her missing brother', 'an old friend');
        expect(getPlotCompassChoice({ content: rewritten, plotCompassChoice: pick })).toBeNull();
        expect(getPlotCompassChoice({ content: NOTE })).toBeNull();
    });

    test('adds the pick to prompts and makes it the instruction for the next reply', () => {
        const result = { content: NOTE, plotCompassChoice: { number: 1, text: 'Mira bribes the night guard for the code.' } };
        expect(getPlotCompassContentWithChoice(result)).toBe(`${NOTE}\n\n[User's chosen direction]\n1. Mira bribes the night guard for the code.`);
        expect(getPlotCompassContentWithChoice(result, { instruction: true })).toMatch(/\[User's chosen direction\]\n1\. Mira bribes the night guard for the code\.\nThe user picked this direction for the next response\. Follow it in place of the Next move above\.$/);
        expect(getPlotCompassContentWithChoice({ content: NOTE }, { instruction: true })).toBe(NOTE);
    });

    test('asks every installed Plot Compass for numbered directions without a template update', () => {
        const prompt = getPlotCompassPrompt({}, {}, value => value);
        expect(prompt.endsWith(PLOT_COMPASS_CHOICES_INSTRUCTION)).toBe(true);
        expect(PLOT_COMPASS_CHOICES_INSTRUCTION).toMatch(/numbered list/);
        expect(PLOT_COMPASS_CHOICES_INSTRUCTION).not.toMatch(/\b(?:shape|beat|pressure)\b|Do not|Never|Output only/i);
    });
});
