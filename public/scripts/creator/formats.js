export const CREATOR_FORMATS = Object.freeze({
    plain: { label: 'Natural description', hint: 'Character-specific prose, with clear paragraphs.', instruction: 'Write descriptive character fields as natural prose with concrete, character-specific details.' },
    plist: { label: 'PList', hint: 'Compact labelled properties and traits.', instruction: 'Write descriptive character fields as compact labelled properties, grouping related traits into readable lists. Prefer exact nouns, measurements, habits, triggers and lifestyle context over bare adjectives; use thing(descriptor, descriptor) parentheticals and semicolon-separated categories where helpful. Preserve concrete detail instead of reducing everything to vague adjectives.' },
    alichat: { label: 'ALIchat', hint: 'Characterisation through Interviewer and character dialogue.', instruction: 'Express characterisation through short example exchanges using brief neutral Interviewer: questions (roughly 2-5 words) and character-voiced {{char}}: turns with concrete physical mannerisms. Let the character demonstrate their traits in their own voice. Use Interviewer, never {{user}}, as the example speaker. Separate exchanges with blank lines; no opening delimiter is required.' },
    hybrid: { label: 'Hybrid', hint: 'Concise facts plus dialogue that demonstrates their voice.', instruction: 'Combine concise labelled character facts (PList-style traits and context) with illustrative dialogue using brief Interviewer: questions and {{char}}: replies. Separate exchanges with blank lines; no opening delimiter is required. Keep each part useful rather than repeating all the same facts.' },
});

export const CREATOR_TENSES = Object.freeze({
    unset: { label: 'Default', instruction: '' },
    present: { label: 'Present tense', instruction: 'Write narrative prose and greetings in present tense outside dialogue quotes.' },
    past: { label: 'Past tense', instruction: 'Write narrative prose and greetings in past tense outside dialogue quotes.' },
});

export const CREATOR_POVS = Object.freeze({
    unset: { label: 'Default', instruction: '' },
    third: { label: 'Third person', instruction: 'Use third-person external narration outside dialogue; keep first person inside {{char}} spoken quotes and Interviewer answers.' },
    first: { label: 'First person', instruction: 'Use first-person narration from {{char}}\'s perspective where narrative prose is requested.' },
});

export const CREATOR_CANON_MODES = Object.freeze({
    source_only: { label: 'Source only', instruction: 'Rely strictly on the supplied dossier, character fields and lore; do not import unverified outside franchise details.' },
    supplement: { label: 'Allow canon knowledge', instruction: 'Supplement supplied facts with established canon knowledge about {{char}} and their setting when consistent with the user\'s source material.' },
});

/** Adapted from the bundled Director preset's NSFW Mode for character fields and greetings. */
export const CREATOR_NSFW_GUIDANCE = `Apply these rules only to description, personality and greeting content that involves intimacy or sex, and only when the source material or user asks for explicit content. All characters in explicit content are adults.
Describe every physical interaction with raw, blunt and highly detailed language. Focus on the concrete mechanics: explicit anatomical contact, friction, wetness, temperature and bodily fluids, the exact rhythm, the pressure of skin against skin, and the sounds of movement, breathing and moisture. Use lewd onomatopoeia where it suits the scene.
Avoid metaphorical, poetic or vague euphemisms; represent every sexual act with raw realism and clinical clarity. Keep dirty talk and verbal interaction strictly in the established voice and dominance dynamics of the characters, uninhibited, vulgar and blunt.
In descriptions and personality, state sexual preferences, anatomy, kinks, limits and intimate behaviour plainly and specifically rather than hinting. In explicit greetings, let intimacy take priority over plot, with the plot slowed or paused, while still leaving {{user}}'s actions, words and decisions to {{user}}.`;

export const creatorTargetValue = (targets, key) => String(targets?.[key] ?? (key === 'characterWords' ? targets?.words : key === 'characterTokens' ? targets?.tokens : '') ?? '').trim();

export function creatorNsfwInstruction(draft) {
    const nsfw = draft?.writing?.nsfw;
    if (!nsfw?.enabled) return '';
    return typeof nsfw.instruction === 'string' ? nsfw.instruction : CREATOR_NSFW_GUIDANCE;
}

export function creatorTargetsSignature(draft) {
    const t = draft?.writing?.targets ?? {};
    return JSON.stringify([
        t.tense ?? 'unset',
        t.pov ?? 'unset',
        t.canon ?? 'source_only',
        creatorTargetValue(t, 'characterWords'),
        String(t.paragraphs ?? '').trim(),
        creatorTargetValue(t, 'characterTokens'),
        creatorTargetValue(t, 'greetingWords'),
        creatorTargetValue(t, 'greetingTokens'),
        creatorNsfwInstruction(draft),
        String(t.interviewQuestions ?? '').trim(),
        String(t.plistCategories ?? '').trim(),
        String(t.openingScenarios ?? '').trim(),
        draft.writing?.formatInstruction ?? '',
        draft.writing?.plistDestination ?? 'description',
    ]);
}

export function creatorTargetsGuidance(draft) {
    const t = draft?.writing?.targets ?? {};
    const lines = [];
    const tense = CREATOR_TENSES[t.tense]?.instruction;
    const pov = CREATOR_POVS[t.pov]?.instruction;
    const canon = CREATOR_CANON_MODES[t.canon ?? 'source_only']?.instruction;
    if (tense) lines.push(tense);
    if (pov) lines.push(pov);
    if (canon) lines.push(canon);
    const group = (words, tokens) => [
        creatorTargetValue(t, words) ? `word target: ${creatorTargetValue(t, words)}` : '',
        creatorTargetValue(t, tokens) ? `approximate token target: ${creatorTargetValue(t, tokens)}` : '',
    ].filter(Boolean).join('; ');
    const character = group('characterWords', 'characterTokens');
    const greeting = group('greetingWords', 'greetingTokens');
    const paragraphs = String(t.paragraphs ?? '').trim();
    if (character) lines.push(`Description and personality length (${character}).`);
    if (greeting) lines.push(`Opening greeting length, per greeting, for first_mes, alternate_greetings and group_only_greetings (${greeting}).`);
    if (paragraphs) lines.push(`Paragraph target: ${paragraphs}.`);
    if (character || greeting || paragraphs) {
        lines.push('Treat length targets as quality-biased writing targets for the requested fields rather than hard API cutoffs: a tight, character-specific result outperforms padded filler.');
    }
    if (String(t.interviewQuestions ?? '').trim()) {
        lines.push(`Interview / ALIchat exchange target: ${String(t.interviewQuestions).trim()} (move from surface traits to habits, relationships and deeper fault lines with brief 2-5 word Interviewer prompts).`);
    }
    if (String(t.plistCategories ?? '').trim()) {
        lines.push(`PList category focus: ${String(t.plistCategories).trim()}.`);
    }
    if (String(t.openingScenarios ?? '').trim()) {
        lines.push(`Opening / greeting scenario guidance: ${String(t.openingScenarios).trim()} (establish character state, situation, tension and an active hook for {{user}} without writing {{user}}'s actions or dialogue).`);
    }
    return lines.length ? `Conversion and writing targets:\n${lines.join('\n')}` : '';
}

export function creatorFormatGuidance(draft) {
    const format = CREATOR_FORMATS[draft.style] ?? CREATOR_FORMATS.plain;
    const base = `Selected writing format: ${format.label}. ${format.instruction} Apply this format to description, personality, scenario and example dialogue as appropriate to the requested fields. Keep names, tags and metadata short. Greetings remain playable scene openings; system and depth prompts remain instructions. Preserve established facts, user agency and literal macros. Do not rewrite unrelated fields merely to enforce a format.`;
    const targets = creatorTargetsGuidance(draft);
    const custom = draft.writing?.formatInstruction ? `Custom writing format instructions:\n${draft.writing.formatInstruction}` : '';
    const placement = draft.style === 'plist' && draft.writing?.plistDestination === 'depth_prompt' ? 'When depth_prompt is requested, write the PList into Character’s Note (depth_prompt), not into description or creator_notes. Preserve any existing useful note instructions. Do not duplicate the PList into other fields.' : '';
    const nsfw = creatorNsfwInstruction(draft);
    return [base, targets, custom, placement, nsfw ? `NSFW instructions for descriptions and greetings:\n${nsfw}` : ''].filter(Boolean).join('\n\n');
}

export function creatorFormatFields(draft, fields) {
    return [...new Set(fields.map(field => field === 'description' && draft.style === 'plist' && draft.writing?.plistDestination === 'depth_prompt' ? 'depth_prompt' : field))];
}
