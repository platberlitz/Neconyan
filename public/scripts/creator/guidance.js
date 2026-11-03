import { creatorFormatGuidance } from './formats.js';

/** Authoring guidance adapted from the bundled Director main and grounded prose prompts. */
export const DIRECTOR_GUIDANCE = `# Source and canon
- The user's Dossier, card fields, lore and corrections are canon. Keep their facts, chronology, relationships, possessions and physical details exactly; leave unspecified details open unless the selected source setting allows filling them in.
- Separate established facts from your own suggestions, and never contradict the source to make a field read better.

# Characters
- Derive behaviour from established characterisation, circumstances and what the character can perceive, know and infer. Extraordinary knowledge needs support in the source.
- Give the character independent goals, limits, priorities and agency: they initiate, interfere, cooperate, refuse, negotiate and commit according to their interests.
- Treat traits as contextual tendencies shown through concrete habits, reactions and choices, not adjectives repeated as labels. Keep rough edges, private agendas and contradictions.
- Ground vocabulary in the character's background, work, hobbies, relationships and habits. Give them a stable, distinct idiolect through diction, syntax, rhythm and timing.

# Dialogue and example messages
- Dialogue does work: it pursues goals, conceals intent, tests boundaries and changes relationships. It carries its own meaning; add narration only when it reveals something the line does not.
- Attach grounded physical beats to the line they affect. Avoid sitcom-style banter, echoing the other speaker and stock dialogue beats.
- Example dialogue uses Interviewer: and {{char}}: with blank lines between exchanges.

# Narration and greetings
- Use concrete nouns, direct verbs, precise sensory detail and spatially clear paragraphs. State actions directly; keep figurative language for a specific effect. Describe bodies literally and consistently.
- Treat the setting as active physical reality, and give side characters their own interests and voices.
- Greetings start inside a live situation with the character pursuing something. End at a meaningful handoff: an action, consequence, discovery or unresolved tension.
- Leave {{user}}'s dialogue, actions, thoughts and decisions to them unless the user's instructions explicitly grant control. Stop before any reaction reserved for {{user}}.
- Default to grounded, direct narration without editorial moral judgement.

Return directly applicable card text, never a handover prompt or commentary.`;

export const GROUNDED_GUIDANCE = `Replace stock gestures, repetitive hesitation and generic emotional shorthand with character-specific behaviour and object interaction.
Avoid canned 'a beat' or 'a pause', negative-parallelism formulas, tightening jaws, catching breaths, whitening knuckles, dust motes and stock scent descriptions. Avoid repeated dialogue echoes, half-X-half-Y voice formulas and possessive 'Mine' shorthand. Use human vocal descriptions for humans; reserve literal purring, chirping and growling for appropriate nonhuman characters. Prefer positive, concrete phrasing to a catalogue of prohibitions in the generated prose.`;

export const MACRO_GUIDANCE = `Keep authoring macros literal. Core names include {{user}}, {{char}}, {{description}}, {{personality}}, {{scenario}}, {{persona}}, {{mesExamples}} and {{creatorNotes}}.
MacroEnhanced pronouns require that extension and its experimental macro support: {{sub}}, {{obj}}, {{poss}}, {{poss_p}}, {{ref}}, and {{charsub}}, {{charobj}}, {{charposs}}, {{charposs_p}}, {{charref}}. Verb agreement uses {{pverb::is::are}} or {{charpverb::is::are}}. Never invent pronoun macro names. Use {{hasvar::key}} to test variable existence: zero is a valid stored value. {{random::a::b}} rerolls on evaluation; {{pick::a::b}} is seeded, not permanent. MacroEnhanced can provide {{freeze::key::{{random::a::b}}}}, {{rollonce::key::1d20}} and {{listpick::key::a,b}}. Setters do not create new bare macro names; read values with {{getvar::key}}. Never hide executable initialisers inside {{// comments}}, which discard their contents. Suggest only macros whose required support is identified.`;

export const CREATOR_PROMPTS = Object.freeze({ director: DIRECTOR_GUIDANCE, grounded: GROUNDED_GUIDANCE, macros: MACRO_GUIDANCE });

export function creatorGuidance(draft) {
    if (draft.style === 'custom') {
        return [MACRO_GUIDANCE, draft.writing?.userInstructions ? `Custom user instructions:\n${draft.writing.userInstructions}` : '', creatorFormatGuidance(draft)].filter(Boolean).join('\n\n');
    }
    const mode = draft.writing?.mode ?? 'full';
    const prompts = Object.fromEntries(Object.entries(CREATOR_PROMPTS).map(([key, fallback]) => [key,
        typeof draft.writing?.prompts?.[key] === 'string' ? draft.writing.prompts[key] : fallback]));
    return [prompts.director, mode === 'full' ? prompts.grounded : '', mode === 'custom' ? String(draft.writing?.custom ?? '') : '', prompts.macros,
        draft.writing?.userInstructions ? `Custom user instructions:\n${draft.writing.userInstructions}` : '', creatorFormatGuidance(draft),
    ].filter(Boolean).join('\n\n');
}
