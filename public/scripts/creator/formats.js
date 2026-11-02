export const CREATOR_FORMATS = Object.freeze({
    plain: { label: 'Natural description', hint: 'Character-specific prose, with clear paragraphs.', instruction: 'Write descriptive character fields as natural prose with concrete, character-specific details.' },
    plist: { label: 'PList', hint: 'Compact labelled properties and traits.', instruction: 'Write descriptive character fields as compact labelled properties, grouping related traits into readable lists. Preserve concrete detail instead of reducing everything to vague adjectives.' },
    alichat: { label: 'ALIchat', hint: 'Characterisation through Interviewer and character dialogue.', instruction: 'Express characterisation through short example exchanges: <START> followed by Interviewer: and {{char}}: turns. Let the character demonstrate their traits in their own voice. Use Interviewer, never {{user}}, as the example speaker.' },
    hybrid: { label: 'Hybrid', hint: 'Concise facts plus dialogue that demonstrates their voice.', instruction: 'Combine concise labelled character facts with illustrative <START> dialogue using Interviewer: and {{char}}:. Keep each part useful rather than repeating all the same facts.' },
});

export function creatorFormatGuidance(draft) {
    const format = CREATOR_FORMATS[draft.style] ?? CREATOR_FORMATS.plain;
    return `Selected writing format: ${format.label}. ${format.instruction} Apply this format to description, personality, scenario and example dialogue as appropriate to the requested fields. Keep names, tags and metadata short. Greetings remain playable scene openings; system and depth prompts remain instructions. Preserve established facts, user agency and literal macros. Do not rewrite unrelated fields merely to enforce a format.`;
}
