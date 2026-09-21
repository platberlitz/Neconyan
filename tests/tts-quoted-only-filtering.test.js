import { filterTtsAsterisks, stripTtsTaggedBlocks, joinQuotedBlocks, prepareTtsNarrationText } from '../public/scripts/extensions/tts/lib/text-prep.js';

describe('TTS quoted-only filtering', () => {
    test('filters semantic blocks before extracting quoted dialogue', () => {
        const tts = { narrate_dialogues_only: true, narrate_quoted_only: true, skip_tags: true };
        const text = '<think>"Keep this hidden."</think><font color="#c8a86e">"Speak this aloud."</font> *"Do not narrate me."*';

        expect(prepareTtsNarrationText(text, tts)).toBe('"Speak this aloud."');
    });

    test('excludes quoted text inside asterisk actions when both filters are enabled', () => {
        const filteredText = filterTtsAsterisks('*"Do not narrate me."*', {
            narrateDialoguesOnly: true,
            passAsterisks: false,
        });

        expect(joinQuotedBlocks(filteredText, { includeQuotes: true })).toBe('');
    });

    test('does not treat quoted font attributes as dialogue', () => {
        const taggedDialogue = '<font color="#c8a86e">"More water. That fire\'s dying. Move, girl, move."</font>';
        const textWithoutTagMarkup = taggedDialogue.replace(/<.*?>/g, '').trim();

        expect(joinQuotedBlocks(textWithoutTagMarkup, { includeQuotes: true }))
            .toBe('"More water. That fire\'s dying. Move, girl, move."');
    });

    test('drops quoted semantic blocks while preserving dialogue inside formatting wrappers', () => {
        const taggedDialogue = '<think>"Keep this hidden."</think><font color="#c8a86e">"Speak this aloud."</font>';
        const filteredText = stripTtsTaggedBlocks(taggedDialogue, { preserveFormatting: true });
        const textWithoutTagMarkup = filteredText.replace(/<.*?>/g, '').trim();

        expect(joinQuotedBlocks(textWithoutTagMarkup, { includeQuotes: true }))
            .toBe('"Speak this aloud."');
    });
});
