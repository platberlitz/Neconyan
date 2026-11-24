import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const json = file => JSON.parse(read(file));
const jsonFiles = dir => fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith('.json')).sort().map(name => `${dir}/${name}`);

/**
 * Bundled prompts that ask for the SillyTavern Summarize extension's {{summary}}. Neconyan
 * ships no Summarize extension, so these really do reach the model as raw text.
 */
export const EXPECTED_TRUE_POSITIVES = Object.freeze([
    'Chat Completion prompts default/content/presets/openai/Pura\'s Director Preset 16.0.json 07e168f8-f793-435b-a8c7-306690e31830: summary',
    'Chat Completion prompts default/content/presets/openai/The Ethereality Express 1.1.json a1000000-0000-4000-8000-000000000051: summary',
    'Chat Completion prompts default settings 07e168f8-f793-435b-a8c7-306690e31830: summary',
]);

/**
 * Every bundled text that a macro-aware editor opens, grouped as the editors group them.
 * @returns {{ category: string, label: string, text: string, dialect: string }[]}
 */
export function bundledMacroTexts() {
    const texts = [];
    const add = (category, label, text, dialect = '') => {
        if (typeof text === 'string' && text) texts.push({ category, label, text, dialect });
    };
    for (const file of jsonFiles('default/content/presets/context')) {
        const preset = json(file);
        add('Context story strings', file, preset.story_string, 'story-string');
        add('Context separators', `${file} example_separator`, preset.example_separator);
        add('Context separators', `${file} chat_start`, preset.chat_start);
    }
    const sequences = ['input_sequence', 'input_suffix', 'output_sequence', 'output_suffix', 'system_sequence', 'system_suffix',
        'first_output_sequence', 'last_output_sequence', 'first_input_sequence', 'last_input_sequence', 'last_system_sequence',
        'story_string_prefix', 'story_string_suffix'];
    for (const file of jsonFiles('default/content/presets/instruct')) {
        const preset = json(file);
        for (const key of sequences) add('Instruct sequences', `${file} ${key}`, preset[key], 'instruct');
        add('Instruct stop and alignment', `${file} stop_sequence`, preset.stop_sequence);
        add('Instruct stop and alignment', `${file} user_alignment_message`, preset.user_alignment_message);
    }
    for (const file of jsonFiles('default/content/presets/sysprompt')) {
        const preset = json(file);
        add('System Prompts', file, preset.content);
        add('System Prompts', `${file} post_history`, preset.post_history);
    }
    for (const file of jsonFiles('default/content/presets/reasoning')) {
        const preset = json(file);
        for (const key of ['prefix', 'suffix', 'separator']) add('Reasoning formats', `${file} ${key}`, preset[key]);
    }
    const chatFields = ['impersonation_prompt', 'new_chat_prompt', 'new_group_chat_prompt', 'new_example_chat_prompt', 'continue_nudge_prompt',
        'group_nudge_prompt', 'scenario_format', 'personality_format', 'send_if_empty', 'assistant_prefill', 'assistant_impersonation'];
    const chatPreset = (label, preset) => {
        for (const prompt of preset.prompts ?? []) add('Chat Completion prompts', `${label} ${prompt.identifier}`, prompt.content);
        for (const key of chatFields) add('Chat Completion fields', `${label} ${key}`, preset[key]);
    };
    for (const file of jsonFiles('default/content/presets/openai')) chatPreset(file, json(file));
    const settings = json('default/content/settings.json');
    chatPreset('default settings', settings.oai_settings);
    add('Context story strings', 'default settings story_string', settings.power_user.context?.story_string, 'story-string');
    add('System Prompts', 'default settings sysprompt', settings.power_user.sysprompt?.content);
    const cardFields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'];
    const card = (label, value) => {
        const data = value.data ?? value;
        for (const key of cardFields) add('Character cards', `${label} ${key}`, data[key]);
        for (const greeting of data.alternate_greetings ?? []) add('Character cards', `${label} alternate greeting`, greeting);
        add('Character cards', `${label} depth prompt`, data.extensions?.depth_prompt?.prompt);
        for (const entry of data.character_book?.entries ?? []) add('Lorebook entries', `${label} ${entry.comment || entry.id}`, entry.content);
    };
    card('Narrator', json('default/content/characters/Narrator.json'));
    for (const variant of fs.readdirSync(path.join(root, 'default/content/assistants')).sort()) {
        const file = `default/content/assistants/${variant}/card.json`;
        if (fs.existsSync(path.join(root, file))) card(file, json(file));
    }
    const templates = 'public/scripts/extensions/in-chat-agents/templates';
    for (const file of jsonFiles(templates).filter(name => !/\/(index|groups|regex-bundles)\.json$/.test(name))) {
        add('Agent templates', file, json(file).prompt, 'agent');
    }
    for (const template of json(`${templates}/index.json`)) add('Agent template catalogue', template.id, template.prompt, 'agent');
    return texts;
}

/**
 * Runs the field checker over every bundled text and lists what it would warn about.
 * @param {{ category: string, label: string, text: string, dialect: string }[]} texts
 * @param {(text: string, dialect: string) => { unknown: string[], unclosed: string[], strayClosers: number }} problemsFor
 */
export function auditMacroTexts(texts, problemsFor) {
    const findings = [];
    const counts = {};
    for (const { category, label, text, dialect } of texts) {
        counts[category] ??= { texts: 0, withMacros: 0, warned: 0 };
        counts[category].texts++;
        if (text.includes('{{')) counts[category].withMacros++;
        const problems = problemsFor(text, dialect);
        const parts = [...problems.unknown, ...problems.unclosed.map(snippet => `unclosed ${snippet}`)];
        if (problems.strayClosers) parts.push(`stray x${problems.strayClosers}`);
        if (!parts.length) continue;
        counts[category].warned++;
        findings.push(`${category} ${label}: ${parts.join(', ')}`);
    }
    return { findings: findings.sort(), counts };
}
