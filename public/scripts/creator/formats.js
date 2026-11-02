export const CREATOR_FORMATS = Object.freeze({
    plain: { label: 'Natural description', hint: 'Character-specific prose, with clear paragraphs.', instruction: 'Write descriptive character fields as natural prose with concrete, character-specific details.' },
    plist: { label: 'PList', hint: 'Compact labelled properties and traits.', instruction: 'Write descriptive character fields as compact labelled properties, grouping related traits into readable lists. Prefer exact nouns, measurements, habits, triggers and lifestyle context over bare adjectives; use thing(descriptor, descriptor) parentheticals and semicolon-separated categories where helpful. Preserve concrete detail instead of reducing everything to vague adjectives.' },
    alichat: { label: 'ALIchat', hint: 'Characterisation through Interviewer and character dialogue.', instruction: 'Express characterisation through short example exchanges: <START> followed by brief neutral Interviewer: questions (roughly 2-5 words) and character-voiced {{char}}: turns with concrete physical mannerisms. Let the character demonstrate their traits in their own voice. Use Interviewer, never {{user}}, as the example speaker.' },
    hybrid: { label: 'Hybrid', hint: 'Concise facts plus dialogue that demonstrates their voice.', instruction: 'Combine concise labelled character facts (PList-style traits and context) with illustrative <START> dialogue using brief Interviewer: questions and {{char}}: replies. Keep each part useful rather than repeating all the same facts.' },
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

export function creatorTargetsSignature(draft) {
    const t = draft?.writing?.targets ?? {};
    return JSON.stringify([
        t.tense ?? 'unset',
        t.pov ?? 'unset',
        t.canon ?? 'source_only',
        String(t.words ?? '').trim(),
        String(t.paragraphs ?? '').trim(),
        String(t.tokens ?? '').trim(),
        String(t.interviewQuestions ?? '').trim(),
        String(t.plistCategories ?? '').trim(),
        String(t.openingScenarios ?? '').trim(),
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
    const lengths = [
        String(t.words ?? '').trim() ? `word target: ${String(t.words).trim()}` : '',
        String(t.paragraphs ?? '').trim() ? `paragraph target: ${String(t.paragraphs).trim()}` : '',
        String(t.tokens ?? '').trim() ? `approximate token target: ${String(t.tokens).trim()}` : '',
    ].filter(Boolean);
    if (lengths.length) {
        lines.push(`Approximate length and structure targets (${lengths.join('; ')}). Treat these as quality-biased writing targets for the requested fields rather than hard API cutoffs: a tight, character-specific result outperforms padded filler.`);
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
    return [base, targets].filter(Boolean).join('\n\n');
}
