import { describe, expect, test } from '@jest/globals';
import {
    getPlotCompassChoice,
    getPlotCompassContentWithChoice,
    getCompanionChatHistoryContributions,
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
        const projected = getPlotCompassContentWithChoice(result, { instruction: true });
        expect(projected).toContain('**Next move:** 1. Mira bribes the night guard for the code.');
        expect(projected).not.toContain('Have the rival crew burst in mid-conversation.');
        expect(projected).toMatch(/\[User's chosen direction\]\n1\. Mira bribes the night guard for the code\.\nThe user picked this direction for the next response\./);
        expect(result.content).toBe(NOTE);
        expect(getPlotCompassContentWithChoice({ content: NOTE }, { instruction: true })).toBe(NOTE);
    });

    test('replaces a multiline recommendation without removing the sections after it', () => {
        const content = '## Possible developments\n1. A storm arrives.\n2. The host confesses.\n### Next move\n**2.** Go with option 2.\nLet them confess.\n\n## Reminders\nKeep the cat safe.';
        const result = { content, plotCompassChoice: { number: 1, text: 'A storm arrives.' } };
        const projected = getPlotCompassContentWithChoice(result);
        expect(projected).toContain('**Next move:** 1. A storm arrives.');
        expect(projected).not.toContain('Go with option 2.');
        expect(projected).not.toContain('Let them confess.');
        expect(projected).toContain('## Reminders\nKeep the cat safe.');
    });

    test.each(['**Option 2:** The host confesses.', '**2. The host confesses.**', '**Go with option 2:** The host confesses.'])('replaces a bold recommendation line: %s', recommendation => {
        const content = `**Possible developments:**\n1. A storm arrives.\n2. The host confesses.\n**Next move:**\n${recommendation}\n**Reminders:** Keep the cat safe.`;
        const projected = getPlotCompassContentWithChoice({ content, plotCompassChoice: { number: 1, text: 'A storm arrives.' } });
        expect(projected).not.toContain(recommendation);
        expect(projected).toContain('**Next move:** 1. A storm arrives.');
        expect(projected).toContain('**Reminders:** Keep the cat safe.');
    });

    test('kept notes record a valid historical pick without issuing an old instruction', () => {
        const result = { status: 'done', includeInChatHistory: true, content: NOTE,
            plotCompassChoice: { number: 1, text: 'Mira bribes the night guard for the code.' } };
        const message = { extra: { inChatAgentCompanionResults: { plot: result } } };
        const [contribution] = getCompanionChatHistoryContributions(message);
        expect(contribution.content).toContain('[User\'s chosen direction at the time]');
        expect(contribution.content).not.toContain('Have the rival crew burst in mid-conversation.');
        expect(contribution.content).not.toContain('for the next response');
        expect(result.content).toBe(NOTE);
    });

    test('asks every installed Plot Compass for numbered directions without a template update', () => {
        const prompt = getPlotCompassPrompt({}, {}, value => value);
        expect(prompt.endsWith(PLOT_COMPASS_CHOICES_INSTRUCTION)).toBe(true);
        expect(PLOT_COMPASS_CHOICES_INSTRUCTION).toMatch(/numbered list/);
        expect(PLOT_COMPASS_CHOICES_INSTRUCTION).not.toMatch(/\b(?:shape|beat|pressure)\b|Do not|Never|Output only/i);
    });
});
