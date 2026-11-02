import { creatorFormatGuidance } from './formats.js';

/** Authoring guidance adapted from the bundled Director main and grounded prose prompts. */
export const DIRECTOR_GUIDANCE = `Treat the user's established facts and corrections as canon. Preserve chronology, possessions, knowledge boundaries and physical continuity. Give characters independent goals, distinctive voices and initiative. Keep the environment and supporting characters active.
Use observable action, concrete nouns, direct verbs and material detail. Let consequences follow causes. Continue from the actual endpoint without recap or parroting. Leave the user's dialogue, actions, thoughts and decisions to them unless their chosen co-writing instructions explicitly grant control. End scenes with a meaningful opening before deciding the user's response. Example dialogue uses <START>, Interviewer: and {{char}}:. Return directly applicable writing, never a handover prompt.`;

export const GROUNDED_GUIDANCE = `Replace stock gestures, repetitive hesitation and generic emotional shorthand with character-specific behaviour and object interaction.
Avoid canned 'a beat' or 'a pause', negative-parallelism formulas, tightening jaws, catching breaths, whitening knuckles, dust motes and stock scent descriptions. Avoid repeated dialogue echoes, half-X-half-Y voice formulas and possessive 'Mine' shorthand. Use human vocal descriptions for humans; reserve literal purring, chirping and growling for appropriate nonhuman characters. Prefer positive, concrete phrasing to a catalogue of prohibitions in the generated prose.`;

export const MACRO_GUIDANCE = `Keep authoring macros literal. Core names include {{user}}, {{char}}, {{description}}, {{personality}}, {{scenario}}, {{persona}}, {{mesExamples}} and {{creatorNotes}}.
MacroEnhanced pronouns require that extension and its experimental macro support: {{sub}}, {{obj}}, {{poss}}, {{poss_p}}, {{ref}}, and {{charsub}}, {{charobj}}, {{charposs}}, {{charposs_p}}, {{charref}}. Verb agreement uses {{pverb::is::are}} or {{charpverb::is::are}}. Never invent pronoun macro names. Use {{hasvar::key}} to test variable existence: zero is a valid stored value. {{random::a::b}} rerolls on evaluation; {{pick::a::b}} is seeded, not permanent. MacroEnhanced can provide {{freeze::key::{{random::a::b}}}}, {{rollonce::key::1d20}} and {{listpick::key::a,b}}. Setters do not create new bare macro names; read values with {{getvar::key}}. Never hide executable initialisers inside {{// comments}}, which discard their contents. Suggest only macros whose required support is identified.`;

export const CREATOR_PROMPTS = Object.freeze({ director: DIRECTOR_GUIDANCE, grounded: GROUNDED_GUIDANCE, macros: MACRO_GUIDANCE });

export function creatorGuidance(draft) {
    const mode = draft.writing?.mode ?? 'full';
    const prompts = Object.fromEntries(Object.entries(CREATOR_PROMPTS).map(([key, fallback]) => [key,
        typeof draft.writing?.prompts?.[key] === 'string' ? draft.writing.prompts[key] : fallback]));
    return [prompts.director, mode === 'full' ? prompts.grounded : '', mode === 'custom' ? String(draft.writing?.custom ?? '') : '', prompts.macros,
        draft.writing?.userInstructions ? `Custom user instructions:\n${draft.writing.userInstructions}` : '', creatorFormatGuidance(draft),
    ].filter(Boolean).join('\n\n');
}
