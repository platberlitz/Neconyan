const FRAMING = {
    bust: [
        'Framing: bust portrait, chest and shoulders visible, face centered, same head size in every sprite.',
        'Use a straight-on front view at eye level. Keep shoulders square to the camera and do not change the camera distance.',
        'Position the character identically in every image: head near the top with a small even margin, body centered horizontally, same scale and crop. The character must occupy the same area of the frame each time.',
    ].join('\n'),
    full_body: [
        'Framing: full body sprite, entire character visible from head to feet, centered with consistent scale.',
        'Use a straight-on front-facing standing pose at eye level. Keep the same body pose and camera distance in every sprite.',
        'Position the character identically in every image: feet near the bottom, head near the top, centered horizontally, same scale and crop. The character must occupy the same area of the frame each time.',
    ].join('\n'),
};

export const EXPRESSION_SPRITE_NEGATIVE = [
    'three-quarter view', '3/4 view', 'side view', 'profile view', 'looking away', 'rotated shoulders',
    'tilted head', 'tilted camera', 'dutch angle', 'top-down view', 'low angle', 'different crop',
    'different zoom', 'different outfit', 'different hairstyle', 'different accessories', 'opaque background',
    'colored background', 'busy background', 'checkerboard background', 'transparent checkerboard',
    'transparency grid', 'alpha checkerboard', 'gray checkerboard', 'captions', 'labels', 'text',
    'expression names', 'overlapping cells', 'sprites crossing cell boundaries', 'cut off character', 'adjacent sprite fragments',
].join(', ');

export const DEFAULT_EXPRESSION_SPRITE_PROMPT = [
    '{{generationInstructions}}', '{{sheetInstructions}}',
    'Use these character card details as the source of truth for the character\'s actual appearance:',
    '{{characterCard}}', '{{framingInstructions}}',
    'Preserve the same character identity, species, body, hair, eyes, clothing, accessories, colors, and style described in the card.',
    'Consistency rules: same front-facing angle, same crop, same scale, same head and body position, same outfit, same hairstyle, same accessories, true transparent background.',
    'If true alpha transparency is unavailable, use flat pure white only. Never draw a checkerboard or transparency grid.',
    'Only the facial expression should change. Keep pose, camera, composition, and silhouette stable across all generated expressions.',
    'Clean isolated character sprite, emotional face, production-ready expression sheet tile.',
].join('\n');

function truncate(value, limit) {
    const text = String(value || '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return text.length <= limit ? text : `${text.slice(0, limit).trim()}...`;
}

export function buildCharacterCardSpritePrompt(fields = {}) {
    return truncate([
        ['Description', fields.description, 1400], ['Creator notes', fields.creatorNotes, 650],
        ['Personality', fields.personality, 450], ['Scenario', fields.scenario, 450], ['Depth note', fields.charDepthPrompt, 350],
    ].map(([label, value, limit]) => {
        const text = truncate(value, limit);
        return text ? `${label}: ${text}` : '';
    }).filter(Boolean).join('\n'), 2400);
}

export function getExpressionSpriteSheetGrid(count) {
    const columns = Math.ceil(Math.sqrt(count));
    return { columns, rows: Math.ceil(count / columns) };
}

function fromTemplate(template, values) {
    const missing = ['generationInstructions', 'sheetInstructions'].filter(key => values[key] && !new RegExp(`{{\\s*${key}\\s*}}`, 'i').test(template));
    const text = Object.entries(values).reduce((value, [key, replacement]) => value.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'gi'), () => String(replacement ?? '')), template);
    return [missing.map(key => values[key]).join('\n'), text].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function build(labels, context, grid) {
    const characterName = context.characterName || 'character';
    const characterCard = String(context.characterCard || '').trim();
    const framing = Object.hasOwn(FRAMING, context.framing) ? context.framing : 'bust';
    const generationInstructions = grid ? `Create one image containing a matching character expression sheet for ${characterName}.`
        : `Create one image in a matching character expression sprite set for ${characterName}.\nExpression to show: ${labels[0]}.`;
    const unused = grid ? grid.columns * grid.rows - labels.length : 0;
    const sheetInstructions = grid ? [
        `Create one complete character expression sheet for ${characterName}.`,
        `Sheet layout: ${grid.columns} columns by ${grid.rows} rows, equal-size cells, row-major order.`,
        `Generate the first ${labels.length} cells using these expressions in order:\n${labels.map((label, index) => `${index + 1}. ${label}`).join('\n')}`,
        unused > 0 ? `Leave the final ${unused} unused cell(s) transparent or flat white.` : '',
        'Use true alpha transparency for the sheet and every cell. If true transparency is not available, use a flat pure white background only.',
        'Do not draw a checkerboard, transparency grid, gray squares, paper texture, or any background pattern.',
        'No captions, labels, numbers, expression names, borders, gutters, panel outlines, or decorative dividers.',
        'Keep every character, prop, weapon, accessory, hair strand, and shadow fully inside its own cell with clear transparent padding on all sides.',
        'Do not let any part of a sprite cross into another cell. Adjacent cells must never overlap or leak into each other.',
        'Each filled cell must contain exactly one clean sprite tile that can be cropped by equal grid coordinates.',
    ].filter(Boolean).join('\n') : '';
    const template = String(context.promptTemplate || '').trim();
    if (template) return fromTemplate(template, { characterName, characterCard, framing, framingInstructions: FRAMING[framing],
        expression: grid ? 'each listed expression' : labels[0], expressions: labels.join(', '), generationInstructions, sheetInstructions });
    return [generationInstructions, sheetInstructions,
        characterCard ? `Use these character card details as the source of truth for the character's actual appearance:\n${characterCard}` : '',
        FRAMING[framing],
        'Preserve the same character identity, species, body, hair, eyes, clothing, accessories, colors, and style described in the card.',
        'Consistency rules: same front-facing angle, same crop, same scale, same head and body position, same outfit, same hairstyle, same accessories, true transparent background.',
        'If true transparency is not available, use flat pure white only. Never draw a checkerboard or transparency grid.',
        'Only the facial expression should change. Keep pose, camera, composition, and silhouette stable across all generated expressions.',
        grid ? 'Clean isolated character sprite, emotional face, production-ready expression sheet.'
            : 'Clean isolated character sprite, emotional face, production-ready expression sheet tile.',
    ].filter(Boolean).join('\n');
}

export function buildExpressionSpritePrompt(expression, context = {}) { return build([expression], context, null); }
export function buildExpressionSpriteSheetPrompt(expressions, context = {}, grid = getExpressionSpriteSheetGrid(expressions.length)) { return build(expressions, context, grid); }
