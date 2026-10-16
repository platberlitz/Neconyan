import { buildExpressionSpritePrompt, buildExpressionSpriteSheetPrompt, DEFAULT_EXPRESSION_SPRITE_PROMPT,
    getExpressionSpriteNegative } from '../public/scripts/extensions/expressions/sprite-prompts.js';

test('new sprites request a removable green background without contradicting negatives', () => {
    const prompt = buildExpressionSpritePrompt('joy', { promptTemplate: DEFAULT_EXPRESSION_SPRITE_PROMPT });
    expect(prompt).toContain('#00FF00');
    expect(prompt).not.toContain('true transparent background');
    expect(prompt).not.toContain('{{backgroundInstructions}}');
    expect(getExpressionSpriteNegative()).not.toContain('colored background');
});
test('custom prompts receive the selected background rule and unused cells match it', () => {
    const prompt = buildExpressionSpriteSheetPrompt(['joy', 'anger', 'sadness'], { background: 'magenta', promptTemplate: 'Keep my painted style.' });
    expect(prompt).toContain('Keep my painted style.');
    expect(prompt).toContain('#FF00FF');
    expect(prompt).toContain('unused cell(s) empty, showing only the background colour');
    expect(prompt).not.toContain('flat white');
    expect(buildExpressionSpritePrompt('joy', { background: 'white' })).toContain('flat pure white');
});
test('macro text inside a character card is not expanded a second time', () => {
    const prompt = buildExpressionSpritePrompt('joy', {
        characterName: 'Mira',
        characterCard: 'Likes the {{expression}} macro and {{unknownMacro}}.',
        promptTemplate: '{{generationInstructions}}\n{{characterCard}}',
    });
    expect(prompt).toContain('Likes the {{expression}} macro and {{unknownMacro}}.');
});
