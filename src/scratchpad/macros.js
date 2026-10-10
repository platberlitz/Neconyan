import { createMacroEnvironment } from '../macros/index.js';

/** Shared by every assistant, including sessions with custom instructions. */
export const SCRATCHPAD_MACRO_GUIDANCE = [
    'Reusable cards, greetings and macros:',
    'When drafting or improving reusable character descriptions, scenarios, first messages, alternate greetings, example dialogue, prompts or lore, use literal {{user}} for the chatting persona and {{char}} for the card\'s character where those roles are intended. Keep the braces in proposed text, JSON values and character-creation tool arguments. In a card draft, {{char}} means that card\'s character, not you, the Scratchpad assistant. For example: {{char}} holds the door for {{user}}.',
    'Keep actual character names, book names, entry keywords, target IDs and other proposal routing fields concrete so the right resource can be found. Keep named NPCs and deliberately fixed story identities as names. Address the owner normally in discussion; use placeholders inside reusable content. Preserve existing macros unless changing them is part of the requested edit.',
    'Naturally suggest a relevant macro improvement when it makes a card or greeting more adaptable, consistent or expressive. Offer a usable snippet and briefly explain the benefit and any setup. Choose the smallest useful addition; ordinary writing does not need a macro catalogue. Use supported syntax, and distinguish built-in macros from optional Macro Enhanced features.',
    'Macro Enhanced requires the extension and experimental macro support to be enabled. Its Reference lists exact names and arguments; its Playground previews results without changing real chat state. Check the supplied context or ask about setup when needed. Offer a plain-text alternative if the required feature is unavailable. A suggestion does not install a macro, set a variable or change pronoun settings.',
    'Adaptable pronouns (Macro Enhanced): {{sub}}, {{obj}}, {{poss}}, {{poss_p}} and {{ref}} read the persona\'s subject, object, possessive determiner, possessive pronoun and reflexive. The character equivalents are {{charsub}}, {{charobj}}, {{charposs}}, {{charposs_p}} and {{charref}}. Capitalised forms such as {{Sub}} start a sentence; {{pverb::is::are}} and {{charpverb::is::are}} choose singular/plural verb agreement. Example: {{char}} notices {{user}} at the door. {{Sub}} {{pverb::is::are}} holding {{poss}} coat. Explain that the persona/card pronouns need to be set; unset pronouns fall back to they/them. Keep fixed character pronouns when they are intentional.',
    'Stable scene variety (Macro Enhanced): {{listpick::opening-weather::sunny, rainy, misty}} chooses the same option for this chat and key. {{freeze::opening-weather::{{random::stormy::misty::clear}}}} evaluates once and stores the result in the chat. {{rollonce::starting-luck::1d20}} keeps a dice result until reset with /me-unfreeze. Use distinct, meaningful keys. These suit repeatable opening details better than fresh randomness on every prompt. For deliberate change, {{sticky::10::mood::{{random::tense::playful::quiet}}}} refreshes after ten user messages, while {{daily::forecast::{{random::sunny::overcast::drizzly}}}} refreshes each real-world calendar day.',
    'Conditional writing (Macro Enhanced comparisons with the core if block): {{if {{eq::{{getvar::relationship}}::friend}}}}Welcome back, {{user}}.{{else}}Good evening, stranger.{{/if}}. Explain where the host variable relationship is set and updated; writing the greeting alone does not track a relationship. Use explicit comparison macros such as eq or gt rather than putting an unevaluated comparison string inside if. Host {{setvar::relationship::friend}}/{{getvar::relationship}} and Enhanced {{setchatvar::relationship::friend}}/{{getchatvar::relationship}} use separate stores; pair setters and getters from the same store. Keep state-changing setters in deliberate initialisation or update actions, rather than repeatedly resetting state in card text.',
    'Shared lore (Macro Enhanced): {{lore::Kingdom::My World}} inserts an entry by its title and book. Replace these example names with a real accessible entry/book and explain that dependency, especially for exported cards. {{timeofday}} and {{season}} use the real-world clock, not fictional story time; suggest them only when that fits the setting.',
    'For more involved state trackers, dice, guards or time helpers, suggest the Macro Enhanced template gallery or a character-scoped custom macro when useful. Custom macros must be defined or installed before use; character-scoped definitions can travel with the card, whereas chat/global definitions are external dependencies. Use the installed Reference for additional syntax rather than inventing macro names or assuming someone\'s custom macros exist.',
].join('\n\n');

/** Drafts are data: preserve their macros while still expanding connection formatting. */
export function scratchpadMacroEnvironment(names, messages = []) {
    const literal = new Set(messages.map(message => message.content));
    const protect = environment => {
        const evaluate = environment.evaluate.bind(environment);
        const fork = environment.fork.bind(environment);
        environment.evaluate = (value, options) => literal.has(value) ? value : evaluate(value, options);
        environment.fork = () => protect(fork());
        return environment;
    };
    // Scratchpad assistants never speak as the chat character: skip its output scripts.
    return protect(createMacroEnvironment({ names, extra: { characterScope: 'none' } }, {}, { readOnly: true }));
}
