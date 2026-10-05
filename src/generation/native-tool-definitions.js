import { roleplayError } from '../roleplay-store.js';
import { ASK_FIRST, CONFIRM_PROTOCOL, CREATE_CHARACTER_GUIDE, USER_CONFIRMED_DESCRIPTION } from '../../public/scripts/neconyan-assistant-tool-guidance.js';
import { EDITABLE_AGENT_FIELDS, EDITABLE_CHARACTER_FIELDS } from './assistant-tool-data.js';
import { NOTE_TOOL_DEFINITIONS } from '../../public/scripts/notebooks/assistant-note-tools.js';
import { CREATE_AGENT_GUIDE, CREATE_AGENT_SCHEMA } from '../../public/scripts/neconyan-assistant-agent.js';

const invalid = message => roleplayError('ROLEPLAY_TOOL_INVALID', message, 409);
const string = { type: 'string' };
const bookName = { type: 'string', description: 'Exact lorebook name.' };
const agentId = { type: 'string', description: 'Exact agent ID.' };
const presetName = { type: 'string', description: 'Exact preset name.' };
const avatarName = { type: 'string', description: 'Exact known character avatar filename.' };
const uid = { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string', pattern: '^\\d+$' }] };
const object = (required, properties, additionalProperties) => ({ type: 'object', ...(required.length ? { required } : {}),
    properties, ...(additionalProperties === undefined ? {} : { additionalProperties }) });
const reviewed = schema => ({ ...schema, required: [...(schema.required ?? []), 'userConfirmed'],
    properties: { ...schema.properties, userConfirmed: { type: 'boolean',
        description: USER_CONFIRMED_DESCRIPTION } } });

const assistant = Object.freeze({
    Neconyan_Assistant_ListLorebooks: ['List real lorebooks in the current profile.', object([], {})],
    Neconyan_Assistant_ListLorebookEntries: ['List readable entries, including ordinary disabled entries.', object(['book'], { book: bookName })],
    Neconyan_Assistant_ReadLorebookEntry: ['Read one readable lorebook entry by exact UID.', object(['book', 'uid'], { book: bookName, uid })],
    Neconyan_Assistant_EditLorebookEntry: ['Edit exactly one lorebook title or content field after review.', reviewed(object(
        ['book', 'uid', 'field', 'value'], { book: bookName, uid, field: { type: 'string', enum: ['title', 'content'] },
            value: string, expected: { type: 'object' } }))],
    Neconyan_Assistant_ListAgents: ['List the current profile in-chat agents.', object([], {})],
    Neconyan_Assistant_ReadAgent: ['Read one in-chat agent by exact ID.', object(['id'], { id: agentId })],
    Neconyan_Assistant_CreateAgent: [CREATE_AGENT_GUIDE, reviewed(CREATE_AGENT_SCHEMA)],
    Neconyan_Assistant_EditAgent: ['Edit exactly one safe agent field after review.', reviewed(object(
        ['id', 'field', 'value'], { id: agentId, field: { type: 'string', enum: EDITABLE_AGENT_FIELDS }, value: {} }))],
    Neconyan_Assistant_ListModelPresets: ['List supported saved model presets without connection secrets.', object(['apiId'], { apiId: { type: 'string', enum: ['kobold', 'novel', 'openai', 'textgenerationwebui'] } })],
    Neconyan_Assistant_ReadModelPreset: ['Read only safe editable fields from one model preset.', object(['apiId', 'name'], { apiId: { type: 'string', enum: ['kobold', 'novel', 'openai', 'textgenerationwebui'] }, name: presetName })],
    Neconyan_Assistant_EditModelPreset: ['Edit exactly one safe model preset field after review.', reviewed(object(
        ['apiId', 'name', 'field', 'value'], { apiId: { type: 'string', enum: ['kobold', 'novel', 'openai', 'textgenerationwebui'] }, name: presetName, field: string, value: {} }))],
    Neconyan_Assistant_ListCharacters: ['List known character records by safe fields.', object([], {})],
    Neconyan_Assistant_CreateCharacter: [CREATE_CHARACTER_GUIDE, reviewed(object(
        ['character'], { character: object(['name'], Object.fromEntries(EDITABLE_CHARACTER_FIELDS.map(field => [field, string])), false),
            characterNote: { type: 'string', description: 'Character Note text (the PList in the recommended format). Stored at depth 4 with the system role.' },
            alternateGreetings: { type: 'array', items: string, description: 'Extra greetings after first_mes; the recommended format uses three.' },
            avatarPrompt: { type: 'string', description: 'Quick Image Gen prompt for the avatar. Omit it or leave it empty to use the default Neconyan picture.' } }, false))],
    Neconyan_Assistant_ReadCharacter: ['Read one known character by exact avatar filename.', object(['avatar'], { avatar: avatarName })],
    Neconyan_Assistant_EditCharacter: ['Edit exactly one safe character field after review.', reviewed(object(
        ['avatar', 'field', 'value'], { avatar: avatarName, field: { type: 'string', enum: EDITABLE_CHARACTER_FIELDS }, value: string }))],
    ...Object.fromEntries(Object.entries(NOTE_TOOL_DEFINITIONS)
        .map(([name, definition]) => [`Neconyan_Assistant_${name}`, [definition.description, definition.schema]])),
});

const assistantGuides = Object.freeze({
    Neconyan_Assistant_EditLorebookEntry: ASK_FIRST.editLorebookEntry,
    Neconyan_Assistant_EditAgent: ASK_FIRST.editAgent,
    Neconyan_Assistant_CreateAgent: ASK_FIRST.createAgent,
    Neconyan_Assistant_EditModelPreset: ASK_FIRST.editModelPreset,
    Neconyan_Assistant_CreateCharacter: ASK_FIRST.createCharacter,
    Neconyan_Assistant_EditCharacter: ASK_FIRST.editCharacter,
});

const pathfinder = Object.freeze({
    Pathfinder_Search: ['Search accessible lorebooks and navigate saved waypoints.', object([], { book: string, node_id: string })],
    Pathfinder_Remember: ['Save one new lorebook entry.', object(['title', 'content'], { title: string, content: string, book: string })],
    Pathfinder_Update: ['Update a saved lorebook entry.', object(['uid'], { uid, content: string, title: string, book: string })],
    Pathfinder_Forget: ['Disable or delete a saved lorebook entry.', object(['uid'], { uid, book: string, hard_delete: { type: 'boolean' } })],
    Pathfinder_Summarize: ['Save a scene summary in the lorebook.', object(['title', 'content'], { title: string,
        content: string, arc: string, significance: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, book: string })],
    Pathfinder_Reorganize: ['Move an entry or create a lorebook waypoint.', object(['action'], { action: { type: 'string',
        enum: ['move', 'create_waypoint'] }, uid, target_node_id: string, name: string, parent_node_id: string,
    description: string, book: string })],
    Pathfinder_MergeSplit: ['Merge or split saved lorebook entries.', object(['action'], { action: { type: 'string',
        enum: ['merge', 'split'] }, uid1: uid, uid2: uid, merged_title: string, uid, title1: string,
    content1: string, title2: string, content2: string, book: string })],
    Pathfinder_Notebook: ['Read or update the saved chat notebook.', object(['action'], { action: { type: 'string',
        enum: ['read', 'write', 'delete'] }, key: string, content: string })],
});

export const ASSISTANT_TOOL_NAMES = Object.freeze(Object.keys(assistant));
export const PATHFINDER_TOOL_NAMES = Object.freeze(Object.keys(pathfinder));

/** Only registered native actions may be offered to a model; never trust browser-supplied schemas. */
export function nativeToolDefinitions(names) {
    if (!Array.isArray(names) || names.length > 64 || names.some(name => !Object.hasOwn(assistant, name) && !Object.hasOwn(pathfinder, name))) {
        throw invalid('The accepted native tool list is invalid.');
    }
    if (new Set(names).size !== names.length) throw invalid('A native tool name was repeated.');
    return names.map(name => {
        const [description, parameters] = assistant[name] ?? pathfinder[name];
        const askFirst = assistantGuides[name];
        return { type: 'function', function: { name, description: askFirst ? `${description} ${CONFIRM_PROTOCOL}` : description,
            parameters: structuredClone(parameters) } };
    });
}
