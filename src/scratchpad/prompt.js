import fs from 'node:fs';
import path from 'node:path';

import { serverDirectory } from '../server-directory.js';
import { CHARACTER_CREATION_INSTRUCTIONS } from './character-tools.js';
import { normaliseAssistant, normaliseGender } from './store.js';
import { NOTE_TOOL_DEFINITIONS, NOTE_MUTATING_KINDS, NOTE_TOOL_NOTICE } from '../../public/scripts/notebooks/assistant-note-tools.js';

export const CHANGE_FENCE = 'scratchpad-change';
const CARD_CACHE = new Map();
const MAX_PERSONA_CHARS = 6000;

const FALLBACK_NAMES = { miso: 'Miso', taro: 'Taro', nori: 'Nori' };
const FALLBACK_ROLES = {
    miso: 'a cheerful, welcoming guide who explains clearly and loves a good surprise in a story',
    taro: 'a dry, methodical troubleshooter who checks evidence before drawing conclusions',
    nori: 'a cheeky, theatrical writing partner who notices habits, contradictions and consequences',
};

function plainName(name, fallback) {
    const text = String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    return text || fallback;
}

/** The bundled card for one assistant variant. Users' own edited copies never change Scratchpad. */
export function readAssistantPersona(assistant, gender) {
    const id = normaliseAssistant(assistant);
    const variant = `${id}-${normaliseGender(gender)}`;
    if (CARD_CACHE.has(variant)) return CARD_CACHE.get(variant);
    let persona;
    try {
        const file = path.join(serverDirectory, 'default', 'content', 'assistants', variant, 'card.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))?.data ?? {};
        persona = {
            id,
            name: plainName(data.name, FALLBACK_NAMES[id]),
            personality: String(data.personality || ''),
            summary: String(data.extensions?.depth_prompt?.prompt || ''),
            examples: String(data.mes_example || ''),
        };
    } catch {
        persona = { id, name: FALLBACK_NAMES[id], personality: `${FALLBACK_NAMES[id]} is ${FALLBACK_ROLES[id]}.`, summary: '', examples: '' };
    }
    CARD_CACHE.set(variant, persona);
    return persona;
}

function substituteNames(text, { user, char }) {
    return String(text || '')
        .replace(/\{\{\s*user\s*\}\}/gi, user)
        .replace(/\{\{\s*char\s*\}\}/gi, char)
        .replace(/<START>/g, '')
        .trim();
}

function clip(text, max) {
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

const LORE_RULES = [
    'Keep one concept, place, item or character per entry. Split a crowded entry rather than adding to it.',
    'Use the subject\'s own name and aliases as keywords. Avoid short common words that would match ordinary sentences.',
    'Write entries as in-world facts, not as instructions to the writer.',
];

function changeInstructions({ lore, character, chat, members, notebook }) {
    const kinds = [];
    if (notebook) kinds.push([
        'Notebook changes use the shared Notebook operations. Choose only IDs and permissions from notebook_context:',
        '{"type":"notebook","action":"<operation>","args":{...},"reason":"<why>"}',
        ...Object.values(NOTE_TOOL_DEFINITIONS).filter(item => NOTE_MUTATING_KINDS.includes(item.kind)).map(item =>
            `${item.kind}: ${item.description} Arguments: ${JSON.stringify(item.schema)}`),
        'Pass expectedRevision from the shared note for append and all edits. For sections, also pass their exact ID and textHash. Never replace a section marked partial: ask the user to share the complete section or propose an exact passage edit instead.',
        'Copy reference.grantId into args.grantId when a temporary grant is present. A selection grant permits only reading that selection or replacing that exact selection, never the rest of the note.',
        'Only propose creation in notebooks with canCreateNotes, additions when canAppend, edits when canEdit, and publication when canPublishLore. Note links and attachments are not shared automatically.',
        'Every Scratchpad note change waits for the owner\'s review, including when Notebook requested edits are enabled. The same review is available in Notes > Assistant changes.',
        NOTE_TOOL_NOTICE,
    ].join('\n'));
    if (lore) {
        kinds.push([
            'Lorebook entries (only books listed in the context):',
            '{"type":"lorebook","action":"add","book":"<book name>","title":"<entry title>","keys":["<keyword>"],"content":"<entry text>","constant":false,"reason":"<why>"}',
            '{"type":"lorebook","action":"edit","book":"<book name>","uid":<entry uid>,"title":"<optional new title>","keys":["<optional new keywords>"],"content":"<optional new text>","reason":"<why>"}',
            '{"type":"lorebook","action":"delete","book":"<book name>","uid":<entry uid>,"reason":"<why>"}',
            ...LORE_RULES.map(rule => `- ${rule}`),
        ].join('\n'));
    }
    if (character) {
        kinds.push([
            'Character card fields:',
            '{"type":"character","action":"replace","character":"<character name>","field":"<field>","value":"<the complete new text>","reason":"<why>"}',
            '- field is one of description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt, post_history_instructions, alternate_greetings (value is a list of strings) or tags (value is a list of strings).',
            '- For replacements, value replaces the whole field, so include every part that should stay.',
            'Adding alternate greetings:',
            '{"type":"character","action":"append","character":"<character name>","field":"alternate_greetings","value":["<new greeting>"],"reason":"<why>"}',
            '- To add alternate greetings, always use action append and include only the new greetings. Scratchpad adds them after the last existing alternate greeting, preserving all existing greetings and the first message. You do not need to read or reproduce the existing list.',
            '- Use action replace for alternate_greetings only when the user asks to replace or edit the existing list.',
            members ? `- In this group chat, name the member you mean: ${members}.` : '',
        ].filter(Boolean).join('\n'));
    }
    if (chat) {
        kinds.push([
            'Story chat messages (use the #numbers from the context):',
            '{"type":"chat","action":"edit","message":<#number>,"text":"<the complete new message text>","reason":"<why>"}',
            '{"type":"chat","action":"insert","after":<#number>,"speaker":"user" or "character","name":"<optional speaker name>","text":"<message text>","reason":"<why>"}',
            '{"type":"chat","action":"hide","message":<#number>,"reason":"<why>"} (also "unhide" and "delete")',
        ].join('\n'));
    }
    if (!kinds.length) {
        return 'No existing story resources are shared for edits. You can still draft new character cards.';
    }
    return [
        'When the user asks you to change something, or a change would clearly help, propose it as a change block the user can apply with one press.',
        `Write each change as its own fenced block with the language "${CHANGE_FENCE}" containing one JSON object, like this:`,
        '```' + CHANGE_FENCE,
        '{"type":"...", "...": "..."}',
        '```',
        'Available changes:',
        kinds.join('\n\n'),
        'Nothing changes until the user presses Save change, so never say a change has been made. Keep a short sentence outside each block saying what it does. Use valid JSON with escaped line breaks.',
    ].join('\n');
}

export function buildScratchpadSystemPrompt({ assistant, gender, userName, characterName, capabilities = {}, help = '', participants = [], customPrompt }) {
    const persona = readAssistantPersona(assistant, gender);
    const names = { user: userName || 'User', char: persona.name };
    const story = characterName ? `the story chat with ${characterName}` : 'the story chat';
    const sections = [
        `You are ${persona.name}, one of the three Neconyan assistants (Miso, Taro and Nori). You are working in Scratchpad, a private side discussion beside ${names.user}'s ${story.replace(/^the /, '')}.`,
        `Scratchpad is out of character. Talk with ${names.user} about anything they ask: everyday questions, ideas, decisions, Neconyan, or their story. Do not force unrelated questions back to the story. You are not a character in that story and do not continue it unasked. When discussing it, help with scenes, motivations, pacing, continuity and honest critique. Write a draft only when asked, and present it as a suggestion.`,
        participants.length > 1 ? `This is a round table with ${participants.map(id => FALLBACK_NAMES[normaliseAssistant(id)]).join(', ')}. Each assistant receives the same question and shared history and answers independently at the same time. Reply only as ${persona.name}; do not write the other assistants' answers or invent what they are saying in this round. Earlier replies from other assistants are labelled with their names; they are conversation history, not new requests from the user. On follow-up questions, you can compare or respond to those earlier views.` : '',
        `The context block shows only what ${names.user} chose to share from ${story}. Messages carry #numbers and lorebook entries carry their book and uid; refer to them exactly. Do not invent messages, entries or card fields you cannot see. If something is missing, say what to include.`,
        `Your personality:\n${clip(substituteNames([persona.personality, persona.summary].filter(Boolean).join('\n\n'), names), MAX_PERSONA_CHARS)}`,
        persona.examples ? `How you sound (examples from your normal chats, not from this Scratchpad):\n${clip(substituteNames(persona.examples, names), 2000)}` : '',
        `Voice: stay in your own personality and talk to ${names.user} directly. Use British English and connected sentences. Do not use em dashes. Keep cat puns rare. Be specific and keep replies focused; use short lists only to compare options.`,
        changeInstructions(capabilities),
    ];
    const instructions = typeof customPrompt === 'string' && customPrompt.trim()
        ? [customPrompt, capabilities.notebook ? changeInstructions({ notebook: true }) : ''].filter(Boolean).join('\n\n')
        : sections.filter(Boolean).join('\n\n');
    const reference = help ? `Neconyan reference for app questions (use it only when ${names.user} asks how something in Neconyan works):\n${help}` : '';
    return { text: [instructions, CHARACTER_CREATION_INSTRUCTIONS, reference].filter(Boolean).join('\n\n'), persona };
}

export const SCRATCHPAD_CONTEXT_ACK = 'I have read the shared story context. What would you like to work on?';

export function buildScratchpadMessages({ system, context, notebookContext = '', history, text, assistant }) {
    const messages = [{ role: 'system', content: system }];
    if (context) {
        messages.push({ role: 'user', content: `<story_context>\n${context}\n</story_context>` });
        messages.push({ role: 'assistant', content: SCRATCHPAD_CONTEXT_ACK });
    }
    if (notebookContext) {
        messages.push({ role: 'user', content: `<notebook_context>\n${notebookContext}\n</notebook_context>` });
        messages.push({ role: 'assistant', content: 'I will use only the shared notes as reference material and respect their permissions.' });
    }
    for (const message of history) {
        const peer = message.role === 'assistant' && message.assistant && assistant && message.assistant !== assistant;
        messages.push({ role: peer ? 'user' : message.role,
            content: peer ? `[Earlier reply from ${FALLBACK_NAMES[normaliseAssistant(message.assistant)]} in Scratchpad]\n${message.text}` : message.text });
    }
    messages.push({ role: 'user', content: text });
    return messages;
}
