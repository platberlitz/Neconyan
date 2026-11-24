import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MacroRegistry, registerMacros } from '../src/macros/index.js';
import { BUNDLED_MACROS } from '../src/macros/browser-only.js';
import { registerUtilityMacros } from '../public/scripts/extensions/third-party/MacroEnhanced/src/utility-macros.js';
import { registerStateMacros } from '../public/scripts/extensions/third-party/MacroEnhanced/src/state-macros.js';
import { registerLogicMacros } from '../public/scripts/extensions/third-party/MacroEnhanced/src/logic-macros.js';
import { registerChatVarMacros } from '../public/scripts/extensions/third-party/MacroEnhanced/src/chatvar-macros.js';
import { registerDateMacros } from '../public/scripts/extensions/third-party/MacroEnhanced/src/date-macros.js';
import { registerLorebookMacros } from '../public/scripts/extensions/third-party/MacroEnhanced/src/lorebook-macros.js';
import { registerPronounMacros } from '../public/scripts/extensions/third-party/MacroEnhanced/src/pronoun-macros.js';
import { registerCompatMacros } from '../public/scripts/extensions/third-party/MacroEnhanced/src/compat-macros.js';
import {
    STORY_STRING_MACRO_NAMES,
    macroFieldProblems,
    hasMacroFieldProblems,
    registerMacroFieldDialect,
} from '../public/scripts/macro-field-warnings.js';
import { AGENT_MESSAGE_MACROS, agentPromptMacroNames } from '../public/scripts/extensions/in-chat-agents/agent-context-macros.js';
import { EXPECTED_TRUE_POSITIVES, auditMacroTexts, bundledMacroTexts } from './macro-field-audit-texts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

registerMacros();
registerMacroFieldDialect('agent', agentPromptMacroNames);

/** Names the browser registry gains from bundled extensions, read from their own sources. */
function extensionMacroNames() {
    const names = new Set(BUNDLED_MACROS);
    for (const register of [registerUtilityMacros, registerStateMacros, registerLogicMacros, registerChatVarMacros,
        registerDateMacros, registerLorebookMacros, registerPronounMacros, registerCompatMacros]) {
        register((name, options) => {
            for (const value of [name, `me-${name}`, ...(options.aliases ?? []).map(item => item.alias)]) names.add(value);
            return name;
        });
    }
    for (const match of read('public/scripts/extensions/expressions/index.js').matchAll(/MacrosParser\.registerMacro\('([^']+)'/g)) names.add(match[1]);
    for (const match of read('public/scripts/extensions/third-party/sillytavern-character-colors/src/main.js').matchAll(/registerMacro\('([^']+)'/g)) names.add(match[1]);
    return [...names];
}

const knownNames = [...MacroRegistry.getAllMacros().map(definition => definition.name), ...extensionMacroNames()];

test('bundled presets, cards and Agent templates raise no false macro warnings', () => {
    const { findings, counts } = auditMacroTexts(bundledMacroTexts(), (text, dialect) => macroFieldProblems(text, { knownNames, dialect }));
    if (process.env.NECONYAN_MACRO_AUDIT_REPORT) console.log(JSON.stringify(counts, null, 2));
    assert.deepEqual(findings, [...EXPECTED_TRUE_POSITIVES].sort());
    for (const category of ['Context story strings', 'Instruct sequences', 'System Prompts', 'Chat Completion prompts', 'Character cards', 'Agent templates']) {
        assert.ok(counts[category]?.withMacros > 0, `${category} audit read no macro text`);
    }
});

test('macros that look odd but work never warn', () => {
    for (const text of [
        '{{//}}scratch {{chra}} notes{{///}}{{char}}',
        '{{// a note}}{{user}}',
        'Before{{///}}after {{char}}',
        '{{time_UTC+2}} {{time_UTC-10}}',
        '{{.local}} {{$global}} {{.score}} {{$total}}',
        '{{original}} {{trim}} {{newline}} {{noop}}',
        '{{setvar::mood::calm}}{{getvar::mood}}{{addvar::count::1}}{{getglobalvar::x}}',
        '{{if {{getvar::mood}}}}calm{{else}}tense{{/if}}',
        '{{roll 1d6}} {{random::a::b}} {{pick::a::b}} {{reverse:abc}}',
    ]) {
        assert.equal(hasMacroFieldProblems(macroFieldProblems(text, { knownNames })), false, text);
    }
});

test('story strings accept Handlebars blocks and their template values only there', () => {
    const template = '{{#if system}}{{system}}\n{{/if}}{{#each items}}{{this}} {{@index}}{{/each}}{{#unless persona}}x{{else}}y{{/unless}}'
        + '{{#with anchorBefore}}{{.}}{{/with}}{{wiBefore}}{{loreAfter}}{{anchorAfter}}{{mesExamplesRaw}}{{{description}}}{{lookup this 0}}';
    assert.equal(hasMacroFieldProblems(macroFieldProblems(template, { knownNames, dialect: 'story-string' })), false);
    assert.deepEqual(macroFieldProblems('{{wiBefore}}{{#each x}}{{/each}}', { knownNames }).unknown, ['wiBefore', 'each']);
});

test('story-string names match the values both renderers hand to Handlebars', () => {
    const browser = read('public/script.js').match(/const storyStringParams = \{([\s\S]*?)\n\s*\};/)[1];
    const server = read('src/generation/roleplay-text-prompt.js').match(/const params = \{([\s\S]*?)\n\s*\};/)[1];
    const keys = source => [...source.matchAll(/(?:^|[,{\s])(\w+):/g)].map(match => match[1]).filter(key => key !== 'outlet');
    for (const key of [...keys(browser), ...keys(server)]) assert.ok(STORY_STRING_MACRO_NAMES.includes(key), `story string value ${key}`);
});

test('the Agents dialect accepts every Agent-only macro the runners provide', () => {
    const names = agentPromptMacroNames().map(name => name.toLowerCase());
    const browser = read('public/scripts/extensions/in-chat-agents/agent-runner.js').match(/export function buildPromptDynamicMacros[\s\S]*?return \{([\s\S]*?)\n {4}\};/)[1];
    for (const match of browser.matchAll(/^\s+(\w+)[,:]/gm)) assert.ok(names.includes(match[1].toLowerCase()), `browser Agent macro ${match[1]}`);
    const server = read('src/generation/roleplay-agent-processing.js').match(/function aliases\([\s\S]*?\n\}/)[0];
    for (const match of server.matchAll(/'(\w+)'|(\w+): /g)) {
        const name = match[1] ?? match[2];
        if (!['environment', 'agent', 'text'].includes(name)) assert.ok(names.includes(name.toLowerCase()), `server Agent macro ${name}`);
    }
    for (const name of [...AGENT_MESSAGE_MACROS, 'full-mewmory', 'group-cards', 'active-lore', 'tracker-state', 'continuity-corrections', 'preset-prompts']) {
        assert.equal(hasMacroFieldProblems(macroFieldProblems(`{{${name}}}`, { knownNames, dialect: 'agent' })), false, name);
        assert.ok(macroFieldProblems(`{{${name}}}`, { knownNames }).unknown.length > 0 || knownNames.includes(name), `${name} only passes in Agent prompts`);
    }
});

test('typos, unclosed and stray braces are reported once each', () => {
    const problems = macroFieldProblems('{{chra}} meets {{CHRA}} and {{usr}}. {{user\nnext line }} and }}', { knownNames });
    assert.deepEqual(problems.unknown, ['chra', 'usr']);
    assert.deepEqual(macroFieldProblems('Hello {{user', { knownNames }).unclosed, ['{{user']);
    assert.deepEqual(macroFieldProblems('{{char}} smiles }}', { knownNames }), { unknown: [], unclosed: [], strayClosers: 1 });
    assert.deepEqual(macroFieldProblems('{{char}} }} }}', { knownNames }).strayClosers, 2);
    const long = macroFieldProblems('{{getvar::a really long variable name that runs on', { knownNames }).unclosed[0];
    assert.equal(long, '{{getvar::a really long …');
    assert.deepEqual(macroFieldProblems('{{chra}}', { knownNames: [] }), { unknown: [], unclosed: [], strayClosers: 0 }, 'no registry, no guessing');
    assert.deepEqual(macroFieldProblems('a }} b', { knownNames }).strayClosers, 0, 'text without any macro never warns');
});

test('the Scratchpad scanner keeps its findings and adds the unbalanced detail', async () => {
    const { scanMacroProblems } = await import('../public/scripts/scratchpad/checks/macros.js');
    const [finding] = scanMacroProblems('{{char}} {{user', { knownNames });
    assert.equal(finding.rule, 'macro-unbalanced');
    assert.equal(finding.message, 'A macro is missing its closing braces or has an extra closing pair.');
    assert.equal(finding.details, '{{user');
    assert.deepEqual(finding.unclosed, ['{{user']);
    assert.equal(finding.extraClosers, 0);
});

test('warning lines dedupe, cap at three names and count the rest', async () => {
    const { formatMacroFieldProblems, MACRO_WARNING_NAME_CAP } = await import('../public/scripts/macro-field-warnings.js');
    assert.equal(MACRO_WARNING_NAME_CAP, 3);
    const one = formatMacroFieldProblems(macroFieldProblems('{{chra}} {{chra}}', { knownNames }));
    assert.deepEqual(one, [{ kind: 'unknown', label: 'Unknown macro:', codes: ['{{chra}}'], more: '',
        hint: 'Check the spelling. Neconyan sends unknown macros as plain text.' }]);
    const many = formatMacroFieldProblems(macroFieldProblems('{{a1}}{{b2}}{{c3}}{{d4}}{{e5}} {{user }} }}', { knownNames }));
    assert.deepEqual(many.map(line => line.kind), ['unknown', 'stray']);
    assert.equal(many[0].label, 'Unknown macros:');
    assert.deepEqual(many[0].codes, ['{{a1}}', '{{b2}}', '{{c3}}']);
    assert.equal(many[0].more, '+2 more');
    assert.deepEqual(many[1], { kind: 'stray', label: 'Extra closing braces:', codes: ['}}'], more: '',
        hint: 'Remove them or add the opening braces.' });
    const unclosed = formatMacroFieldProblems(macroFieldProblems('{{user', { knownNames }));
    assert.deepEqual(unclosed, [{ kind: 'unclosed', label: 'Unclosed macro:', codes: ['{{user'], more: '', hint: 'Add the closing braces.' }]);
    assert.equal(formatMacroFieldProblems(macroFieldProblems('}} {{char}} }} }}', { knownNames }))[0].more, '×3');
});

test('every editor whose text runs through substituteParams is marked for macros', () => {
    const html = read('public/index.html');
    const marked = id => new RegExp(`<textarea id="${id}" data-macros[ >]`).test(html) || new RegExp(`id="${id}"[^>]*data-macros`).test(html);
    for (const id of ['main_prompt_quick_edit_textarea', 'nsfw_prompt_quick_edit_textarea', 'jailbreak_prompt_quick_edit_textarea',
        'impersonation_prompt_textarea', 'scenario_format_textarea', 'personality_format_textarea', 'group_nudge_prompt_textarea',
        'newchat_prompt_textarea', 'newgroupchat_prompt_textarea', 'newexamplechat_prompt_textarea', 'continue_nudge_prompt_textarea',
        'send_if_empty_textarea', 'claude_assistant_prefill', 'claude_assistant_impersonation', 'description_textarea',
        'completion_prompt_manager_popup_entry_form_prompt', 'persona_description', 'extension_floating_prompt',
        'instruct_story_string_prefix', 'instruct_story_string_suffix']) {
        assert.ok(marked(id), `${id} has data-macros`);
    }
    assert.equal(marked('wi_format_textarea'), false, 'World Info format uses {0}, not macros');
    assert.equal(marked('send_textarea'), false, 'the composer stays unmarked');
    assert.match(html, /id="context_story_string"[^>]*data-macro-dialect="story-string"/);
    assert.match(html, /id="instruct_input_sequence"[^>]*data-macro-dialect="instruct"/);
    assert.match(html, /<textarea class="text_pole mdHotkeys" name="content" rows="8" data-macros/);
    const overrides = read('public/scripts/templates/scenarioOverride.html');
    for (const id of ['chat_scenario_override', 'chat_examples_override', 'chat_system_prompt_override']) {
        assert.match(overrides, new RegExp(`id="${id}"[^>]*data-macros`), id);
    }
    assert.match(read('public/scripts/extensions/in-chat-agents/editor.html'), /id="ica--editor-prompt"[^>]*data-macros data-macro-dialect="agent"/);
    assert.match(read('public/scripts/extensions/in-chat-agents/index.js'), /registerMacroFieldDialect\('agent', agentPromptMacroNames\)/);
    assert.match(read('public/scripts/chats.js'), /textarea\.dataset\.macroDialect = bro\[0\]\.dataset\.macroDialect/);
    assert.match(read('public/scripts/creator/fields.js'), /editor\.dataset\.macros = input\.dataset\.macros/);
    assert.ok(/import\('\.\/scripts\/macro-field-warnings\.js'\)\s*\.then\(module => module\.initMacroFieldWarnings\(\{ t \}\)\)/.test(read('public/script.js')), 'script.js starts the warnings after APP_READY');
});
