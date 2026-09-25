/** The same ask-first text is used for browser and account-bound native tool definitions. */
export const CONFIRM_PROTOCOL = 'Before calling: describe the change in chat, end that message by asking whether to make the tool call now, and call only after the user\'s next message confirms. Set userConfirmed to true only then.';

export const ASK_FIRST = Object.freeze({
    createCharacter: 'Ask the user in one compact round before creating a character: 1) Format: the recommended format (an Ali:Chat interview transcript as the description plus a PList stat sheet as the Character Note), or a format of their own? 2) Avatar: generate a picture with Quick Image Gen first from a prompt you draft, or use the default Neconyan picture? 3) Anything still missing: name, concept, appearance, personality, setting, relationship to {{user}}, how many greetings, anything to avoid. Then post a short summary (name, format, avatar choice, key traits, greeting count) and end the message by asking whether to make the tool call now. Call only after the user confirms.',
    editCharacter: 'Ask the user first which character, which field and what the new text should be. Show the exact new text in chat, end the message by asking whether to make the tool call now, and call only after the user confirms.',
    editLorebookEntry: 'Ask the user first which lorebook, which entry, which field (title or content) and what the new text should be. Show the exact new text in chat, end the message by asking whether to make the tool call now, and call only after the user confirms.',
    editAgent: 'Ask the user first which agent, which field and what the new value should be. Show the exact new value in chat, end the message by asking whether to make the tool call now, and call only after the user confirms.',
    editModelPreset: 'Ask the user first which API, which preset, which field and what the new value should be. Show the exact new value in chat, end the message by asking whether to make the tool call now, and call only after the user confirms.',
});

export const CREATE_CHARACTER_GUIDE = [
    'Create a new character after review. Existing cards are never replaced.',
    'Recommended format, used only when the user agreed to it:',
    'description = an Ali:Chat interview transcript with no headers, labels or brackets; each exchange is `Interviewer`: Question? on one line and `Name`: plain-text action "dialogue in double quotes" action on the next, with one blank line between exchanges and no asterisks. Cover Brief introduction?, Personality? and Appearance? (build, face, hair, eyes, hands, each garment with material and colour) plus 2 to 7 questions only this character would answer this way.',
    'characterNote = a PList stat sheet: the whole list inside square brackets, first line Name\'s persona: then one category per line (persona, likes, dislikes, backstory, appearance, body, hands, wardrobe, abilities, relationships, quirks_and_tells), each ending with a semicolon; traits are 1 to 5 words separated by commas with descriptors in parentheses such as shy(blushes easily, mumbles), no sentences, no articles or connector words.',
    'first_mes and alternateGreetings = third-person present-tense openings written only for {{char}}, never {{user}}\'s actions or words, grounded in a concrete place within the first two paragraphs, each with a clothing detail, a physical feature and a documented habit, each ending in a situation that needs the user\'s reply without announcing it. The recommended set is first_mes plus three alternates that differ in mood, place and time of day.',
    'avatarPrompt: a Quick Image Gen prompt for the avatar; omit it or leave it empty to use the default Neconyan picture.',
].join(' ');

export const USER_CONFIRMED_DESCRIPTION = 'True only when the user\'s latest message confirmed this exact tool call.';
