const READABLE_TEXT = 'Inside each requested field, write text a person can read and edit directly, with a blank line between sections. The surrounding response must still follow the requested JSON schema.';
const READABLE_PLIST = 'Write each profile section on its own line as Name\'s label: item(qualifier, qualifier), item(qualifier); using the character\'s name, with a blank line between sections and no semicolon after the last section. Wrap the whole profile in square brackets, with [ on the first line and ] on the last line. Write values as plain words, never in quotes.';

/** Display order matters: the first entry is the recommended format offered to new drafts. */
export const CREATOR_FORMATS = Object.freeze({
    purachina: { label: 'purachina’s recommended', hint: 'Interview-style description, a bracketed profile in Character’s Note and real names.', instruction: `purachina’s recommended format. ${READABLE_TEXT}
Description: an interview. Every line starts with the speaker name in backticks and a colon: \`Interviewer\`: for questions and \`<character's real name>\`: for answers, with a blank line between question-and-answer blocks. Open with these three questions in this order: Brief introduction? Personality? Appearance? Then ask short questions about the key people, events and objects in their life (for example: The eyepatch? Your brother?), and finish with emotional questions such as What scares you? and What do you want? Each answer mixes a present-tense action written without a subject (for example: leans back, arms crossed.), first-person speech in double quotes and brief narration. The Appearance answer covers face, hair, build, hands and clothes. When the card has two characters, both answer every question and react to each other.
Character’s Note (depth_prompt): the structured profile. ${READABLE_PLIST} Persona covers voice, speech pattern, fears, secret, motivation and insecurity. Relationships include a {{user}}(...) entry. Hands and feet sections are optional.
Personality: empty or one sentence, for example: Name is A, B, C and D beneath a calm exterior.
Scenario: empty or one or two sentences, for example: <Place>, after <event>. {{user}} is meeting Name in <location>.
Greetings (first_mes and alternate_greetings): third person, present tense, using the character's real name. Open on the setting with sensory detail, show the character mid-task with clothing details, let them notice {{user}}, mix dialogue with movement and end with an invitation for {{user}} to act. Never write {{user}}'s actions, speech or thoughts.
Leave example dialogue, the main prompt and post-history instructions empty unless they are explicitly requested.
Macros: use {{user}} for the user and write the character's real name instead of {{char}}.` },
    plain: { label: 'Natural description', hint: 'Character-specific prose, with clear paragraphs.', instruction: `Write descriptive character fields as natural prose with concrete, character-specific details. ${READABLE_TEXT} Keep paragraphs short, one topic each.` },
    plist: { label: 'PList', hint: 'Compact labelled properties and traits.', instruction: `Write descriptive character fields as compact labelled properties, grouping related traits into readable lists. ${READABLE_PLIST} Prefer exact nouns, measurements, habits, triggers and lifestyle context over bare adjectives, and use item(qualifier, qualifier) parentheticals to keep detail. Preserve concrete detail instead of reducing everything to vague adjectives.` },
    alichat: { label: 'ALIchat', hint: 'Characterisation through Interviewer and character dialogue.', instruction: `Express characterisation through short example exchanges using brief neutral Interviewer: questions (roughly 2-5 words) and character-voiced {{char}}: turns with concrete physical mannerisms. Let the character demonstrate their traits in their own voice. Use Interviewer, never {{user}}, as the example speaker. Start each speaker turn on a new line and separate exchanges with blank lines; no opening delimiter is required. ${READABLE_TEXT}` },
    hybrid: { label: 'Hybrid', hint: 'Concise facts plus dialogue that demonstrates their voice.', instruction: `Combine a concise labelled profile with illustrative dialogue. For the profile: ${READABLE_PLIST} For the dialogue, use brief Interviewer: questions and {{char}}: replies, each turn on a new line, with blank lines between exchanges; no opening delimiter is required. ${READABLE_TEXT} Keep each part useful rather than repeating all the same facts.` },
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
    source_only: { label: 'Only what I provide', hint: 'Use just your Dossier, card fields and lorebooks.', instruction: 'Rely strictly on the supplied dossier, character fields and lore; do not import unverified outside franchise details.' },
    supplement: { label: 'Fill gaps from known canon', hint: 'For existing characters: the model may add details it already knows from their series.', instruction: 'Supplement supplied facts with established canon knowledge about {{char}} and their setting when consistent with the user\'s source material.' },
});

/** Adapted from the bundled Director preset's NSFW Mode for character fields and greetings. */
export const CREATOR_NSFW_GUIDANCE = `Apply these rules only to description, personality and greeting content that involves intimacy or sex, and only when the source material or user asks for explicit content. All characters in explicit content are adults.
Describe every physical interaction with raw, blunt and highly detailed language. Focus on the concrete mechanics: explicit anatomical contact, friction, wetness, temperature and bodily fluids, the exact rhythm, the pressure of skin against skin, and the sounds of movement, breathing and moisture. Use lewd onomatopoeia where it suits the scene.
Avoid metaphorical, poetic or vague euphemisms; represent every sexual act with raw realism and clinical clarity. Keep dirty talk and verbal interaction strictly in the established voice and dominance dynamics of the characters, uninhibited, vulgar and blunt.
In descriptions and personality, state sexual preferences, anatomy, kinks, limits and intimate behaviour plainly and specifically rather than hinting. In explicit greetings, let intimacy take priority over plot, with the plot slowed or paused, while still leaving {{user}}'s actions, words and decisions to {{user}}.`;

/** Starting values for the writing targets. An empty value switches that target off. */
export const CREATOR_TARGET_DEFAULTS = Object.freeze({
    greetingCount: '1',
    characterWords: '1,200-2,000 words across description and personality',
    characterTokens: '~1,600-2,600 tokens',
    greetingWords: '~500 words each',
    greetingTokens: '~650 tokens each',
    paragraphs: '4-6 paragraphs per greeting',
    interviewQuestions: '5-15 questions, moving from surface traits to habits, then contradictions',
    plistCategories: 'persona, likes, dislikes, backstory, appearance, body, hands, wardrobe, abilities, relationships, quirks and tells',
    openingScenarios: 'Each greeting sets out the character\'s state, the situation, a tension and a hook. Roughly half narration, a third dialogue, the rest sensory detail. Place the scene within the first two paragraphs.',
});

export function creatorTargetValue(targets, key) {
    if (key === 'greetingCount') {
        const raw = String(targets?.greetingCount ?? 1).trim();
        const count = Number(raw);
        return /^\d+$/.test(raw) && count >= 1 ? String(Math.min(count, 101)) : '1';
    }
    if (typeof targets?.[key] === 'string') return targets[key].trim();
    const legacy = key === 'characterWords' ? targets?.words : key === 'characterTokens' ? targets?.tokens : undefined;
    if (typeof legacy === 'string' && legacy.trim()) return legacy.trim();
    return CREATOR_TARGET_DEFAULTS[key] ?? '';
}

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
        creatorTargetValue(t, 'paragraphs'),
        creatorTargetValue(t, 'characterTokens'),
        creatorTargetValue(t, 'greetingWords'),
        creatorTargetValue(t, 'greetingTokens'),
        creatorTargetValue(t, 'greetingCount'),
        creatorNsfwInstruction(draft),
        creatorTargetValue(t, 'interviewQuestions'),
        creatorTargetValue(t, 'plistCategories'),
        creatorTargetValue(t, 'openingScenarios'),
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
    const paragraphs = creatorTargetValue(t, 'paragraphs');
    if (character) lines.push(`Description and personality length (${character}).`);
    if (greeting) lines.push(`Opening greeting length, per greeting, for first_mes, alternate_greetings and group_only_greetings (${greeting}).`);
    lines.push(`Number of greetings to create: ${creatorTargetValue(t, 'greetingCount')} total, including the first greeting. When creating a set, put the first in first_mes and the remaining greetings in alternate_greetings as separate strings. This count applies only when greetings are requested; when editing one specific greeting, return only that greeting. Preserve existing greetings unless replacement is requested.`);
    if (paragraphs) lines.push(`Paragraph target: ${paragraphs}.`);
    if (character || greeting || paragraphs) {
        lines.push('Treat length targets as quality-biased writing targets for the requested fields rather than hard API cutoffs: a tight, character-specific result outperforms padded filler.');
    }
    if (creatorTargetValue(t, 'interviewQuestions')) {
        lines.push(`Interview / ALIchat exchange target: ${creatorTargetValue(t, 'interviewQuestions')} (move from surface traits to habits, relationships and deeper fault lines with brief 2-5 word Interviewer prompts).`);
    }
    if (creatorTargetValue(t, 'plistCategories')) {
        lines.push(`PList category focus: ${creatorTargetValue(t, 'plistCategories')}.`);
    }
    if (creatorTargetValue(t, 'openingScenarios')) {
        lines.push(`Opening / greeting scenario guidance: ${creatorTargetValue(t, 'openingScenarios')} (establish character state, situation, tension and an active hook for {{user}} without writing {{user}}'s actions or dialogue).`);
    }
    return lines.length ? `Conversion and writing targets:\n${lines.join('\n')}` : '';
}

export function creatorFormatGuidance(draft) {
    const format = CREATOR_FORMATS[draft.style] ?? CREATOR_FORMATS.plain;
    const base = `Selected writing format: ${format.label}. ${format.instruction} Apply this format to description, personality, scenario and example dialogue as appropriate to the requested fields. Keep names, tags and metadata short. Greetings remain playable scene openings; system and depth prompts remain instructions. Preserve established facts, user agency and literal macros. Do not rewrite unrelated fields merely to enforce a format.`;
    const targets = creatorTargetsGuidance(draft);
    const custom = draft.writing?.formatInstruction ? `Custom writing format instructions:\n${draft.writing.formatInstruction}` : '';
    const nsfw = creatorNsfwInstruction(draft);
    const placement = draft.style === 'purachina'
        ? 'Write the interview into description. When depth_prompt is requested, put the bracketed profile in Character’s Note, preserving existing useful instructions. Write only requested, unlocked fields. Keep source facts and existing literal macros intact.'
        : draft.style === 'plist' && draft.writing?.plistDestination === 'depth_prompt' ? 'When depth_prompt is requested, write the PList into Character’s Note (depth_prompt), not into description or creator_notes. Preserve any existing useful note instructions. Do not duplicate the PList into other fields.' : '';
    return [base, targets, custom, placement, nsfw ? `NSFW instructions for descriptions and greetings:\n${nsfw}` : ''].filter(Boolean).join('\n\n');
}

/** Route requested fields to where the selected format keeps them; callers still drop locked fields. */
export function creatorFormatFields(draft, fields) {
    if (draft.style === 'purachina') return [...new Set(fields.flatMap(field => field === 'description' ? ['description', 'depth_prompt'] : [field]))];
    return [...new Set(fields.map(field => field === 'description' && draft.style === 'plist' && draft.writing?.plistDestination === 'depth_prompt' ? 'depth_prompt' : field))];
}
