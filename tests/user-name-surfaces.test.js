import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8');

// The run-time localiser translates any text whose trimmed form is a dictionary key, so a name a person chose ('Default', 'Summary') shows
// translated unless its element is protected. These guards are static: they read the source, not the page. The browser sweep
// (tests/user-name-surfaces.e2e.js) is the guard for what they cannot see.
//
// Known limits:
//   - the first guard does not see selects built in JS (Prompt Manager and the like) or the selects that have no id;
//   - it checks only that a marker is present, not that it is on the right options.

const NAME_LIKE_ID = /preset|profile|world|lore|layout|theme|movingUI|agent|setup|snippet|folder|book|style|template|set\b/i;

/** Every html file that ships a select: public/index.html and every html file under public/scripts. */
function htmlFiles(directory) {
    return readdirSync(path.join(repoRoot, directory), { withFileTypes: true }).flatMap(entry => {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) return htmlFiles(relative);
        return entry.name.endsWith('.html') ? [relative] : [];
    });
}

const selectTags = [...['public/index.html', ...htmlFiles('public/scripts')]].flatMap(file => [...read(file).matchAll(/<select\b[^>]*>/g)]
    .map(match => ({ file, tag: match[0], id: match[0].match(/\sid="([^"]+)"/)?.[1] }))).filter(select => select.id);

/** A select whose only built-in options carry data-i18n holds only names: the select carries data-i18n-ignore. */
const NAME_SELECTS = [
    'world_info', 'world_editor_select', 'settings_preset', 'settings_preset_novel', 'settings_preset_openai',
    'settings_preset_textgenerationwebui', 'context_presets', 'instruct_presets',
    // Author's Note persona note profiles: renderNoteSlot fills it only with profile names (authors-note.js 763 at the base). The one
    // app-made name, the Default fallback (137), is built with t.
    'extension_floating_persona_profile',
];

/** A select that holds names beside built-in options: the marker goes on each name option, in the named functions. */
const MIXED_SELECTS = {
    connection_profiles: { file: 'public/scripts/extensions/connection-manager/index.js', fns: ['renderConnectionProfiles'] },
    themes: { file: 'public/scripts/power-user.js', fns: ['loadPowerUserSettings', 'saveTheme'] },
    movingUIPresets: { file: 'public/scripts/power-user.js', fns: ['loadPowerUserSettings', 'saveMovingUI'] },
    openai_proxy_preset: { file: 'public/scripts/openai.js', fns: ['appendProxyPresetOption'] },
    custom_endpoint_preset: { file: 'public/scripts/openai.js', fns: ['appendCustomEndpointPresetOption'] },
    openai_logit_bias_preset: { file: 'public/scripts/openai.js', fns: ['refreshLogitBiasPresetOptions'] },
    gg_profileImpersonate1st: { file: 'public/scripts/extensions/guided-generations/index.js', fns: ['populateProfiles'] },
    gg_presetImpersonate1st: { file: 'public/scripts/extensions/guided-generations/index.js', fns: ['populatePresets'] },
    'ica--setupSelect': { file: 'public/scripts/extensions/in-chat-agents/index.js', fns: ['renderAgentSetupControls'] },
    'ica--connectionProfile': { file: 'public/scripts/extensions/in-chat-agents/profile-utils.js', fns: ['populateConnectionProfileSelect'] },
    'ica--companionConnectionProfile': { file: 'public/scripts/extensions/in-chat-agents/profile-utils.js', fns: ['populateConnectionProfileSelect'] },
    'ica--trackerRepairConnectionProfile': { file: 'public/scripts/extensions/in-chat-agents/profile-utils.js', fns: ['populateConnectionProfileSelect'] },
    'ica--editor-connectionProfile': { file: 'public/scripts/extensions/in-chat-agents/profile-utils.js', fns: ['populateConnectionProfileSelect'] },
    'pf--pipeline-profile': { file: 'public/scripts/extensions/in-chat-agents/profile-utils.js', fns: ['populateConnectionProfileSelect'] },
    regex_ai_page_profile: { file: 'public/scripts/extensions/regex/index.js', fns: ['fillRegexDraftProfiles'] },
    rm_group_director_profile: { file: 'public/scripts/group-chats.js', fns: ['populateGroupDirectorProfiles'] },
    'neco-lore-merge-book': { file: 'public/scripts/neconyan-lorebook-tools.js', fns: ['mountLorebookTools'] },
    regex_presets: { file: 'public/scripts/extensions/regex/index.js', fns: ['RegexPresetManager'] },
    'qr--set': { file: 'public/scripts/extensions/quick-reply/src/ui/SettingsUi.js', fns: ['SettingsUi'] },
    'ica--editor-chatroom-custom-style-name': { file: 'public/scripts/extensions/in-chat-agents/index.js', fns: ['openEditor'] },
    'ica--editor-companion-batchAgentIds': { file: 'public/scripts/extensions/in-chat-agents/index.js', fns: ['refreshAgentReferenceOptions'] },
    'ica--editor-companion-contextRecipientAgentIds': { file: 'public/scripts/extensions/in-chat-agents/index.js', fns: ['refreshAgentReferenceOptions'] },
};

/** A select built from a template: the marker is on its name option there. */
const TEMPLATE_SELECTS = {
    profile_folder_select: 'public/scripts/extensions/connection-manager/edit.html',
};

/** Selects that hold no name a person chose. */
const BUILT_IN_SELECTS = [
    'expressions_agent_sprite_generation_mode', 'expressions_agent_sprite_framing', 'expressions_agent_sprite_background',
    'expressions_agent_sprite_upscale', 'ica--editor-chatroom-style', 'pf--decision-preset', 'ica--agentViewSelect',
    'ica--appendAgentsExecutionMode', 'neco-lore-delimiter-scope', 'neco-lore-delimiter-style',
    'neco-lore-delimiter-level', 'neco-lore-delimiter-source', 'tag_view_create_folder', 'openai_reasoning_tag_style',
    'world_info_character_strategy', 'world_info_sort_order', 'avatar_style', 'stscript_autocomplete_style', 'google_font_preset',
    'google_font_heading_preset', 'google_font_chat_preset', 'google_font_mono_preset', 'group-chat-lorebook-dropdown',
];

/** The same declaration slicer as tests/user-text-render.e2e.js: a top-level function or class, from its first line to the first '}' at column 0. */
function declaration(text, name) {
    const match = text.match(new RegExp(`^(?:export )?(?:async )?(?:function|class) ${name}\\b[^]*?\\n}$`, 'm'));
    return match ? match[0] : null;
}

describe('names a person chose are not translated', () => {
    test('every name-like select is classified', () => {
        const known = new Map();
        for (const [table, ids] of [['NAME_SELECTS', NAME_SELECTS], ['MIXED_SELECTS', [...Object.keys(MIXED_SELECTS), ...Object.keys(TEMPLATE_SELECTS)]], ['BUILT_IN_SELECTS', BUILT_IN_SELECTS]]) {
            for (const id of ids) known.set(id, [...(known.get(id) ?? []), table]);
        }
        const twice = [...known].filter(([, tables]) => tables.length > 1).map(([id, tables]) => `${id}: ${tables.join(' and ')}`);
        // An id sits in exactly one table.
        expect(twice).toEqual([]);

        const unclassified = [...new Set(selectTags.filter(select => NAME_LIKE_ID.test(select.id) && !known.has(select.id)).map(select => `${select.id} (${select.file})`))];
        // Classify each new name-like select in NAME_SELECTS, MIXED_SELECTS or BUILT_IN_SELECTS.
        expect(unclassified).toEqual([]);

        const missing = [...known.keys()].filter(id => !selectTags.some(select => select.id === id));
        // Every classified id is a select in the html.
        expect(missing).toEqual([]);
    });

    test('a select that only holds names carries data-i18n-ignore', () => {
        const unmarked = NAME_SELECTS.filter(id => !selectTags.some(select => select.id === id && /\sdata-i18n-ignore(\s|>|=)/.test(select.tag)));
        expect(unmarked).toEqual([]);
    });

    test('a mixed select marks its name options in every function that builds them', () => {
        const problems = [];
        for (const [id, { file, fns }] of Object.entries(MIXED_SELECTS)) {
            const source = read(file);
            for (const name of fns) {
                const body = declaration(source, name);
                if (!body) problems.push(`${id}: ${name} is not a top-level function in ${file}`);
                else if (!/data-i18n-ignore|dataset\.i18nIgnore|'translate', 'no'/.test(body)) problems.push(`${id}: ${name} in ${file} never marks an option`);
            }
        }
        expect(problems).toEqual([]);
    });

    test('a select built from a template marks its name option there', () => {
        const unmarked = Object.entries(TEMPLATE_SELECTS).filter(([id, file]) => {
            const block = read(file).match(new RegExp(`<select[^>]*id="${id}"[^]*?</select>`))?.[0] ?? '';
            return !/<option[^>]*data-i18n-ignore[^>]*>\{\{name\}\}/.test(block);
        }).map(([id]) => id);
        expect(unmarked).toEqual([]);
    });

    test('no source reads the lorebook editor selection by its text', () => {
        const pattern = /#world_editor_select[^\n]*(:selected['"]\)\.text\(\)|option:selected['"]\)\.text\(\)|selectedOptions\[0\]\?*\.(textContent|text)\b)/;
        const matches = [];
        const walk = directory => {
            for (const entry of readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
                const relative = `${directory}/${entry.name}`;
                if (entry.isDirectory()) { walk(relative); continue; }
                if (!entry.name.endsWith('.js')) continue;
                read(relative).split('\n').forEach((line, index) => { if (pattern.test(line)) matches.push(`${relative}:${index + 1}`); });
            }
        };
        walk('public/scripts');
        expect(matches).toEqual([]);
    });

    test('the bundled theme list matches the shipped themes', async () => {
        const { BUNDLED_THEME_NAMES } = await import('../public/scripts/neconyan-ui-theme-picker.js');
        const index = JSON.parse(read('default/content/index.json'));
        const shipped = index.filter(item => /^themes\/.+\.json$/.test(item.filename))
            .map(item => JSON.parse(read(`default/content/${item.filename}`)).name);
        expect(shipped.length).toBeGreaterThan(180);
        expect([...BUNDLED_THEME_NAMES].sort()).toEqual([...shipped].sort());
    });

    test('the bundled Moving UI list matches the shipped layouts', () => {
        // power-user.js imports the whole app, so only its declaration is cut out and evaluated.
        const literal = read('public/scripts/power-user.js').match(/export const BUNDLED_MOVING_UI_NAMES = (new Set\(\[[^\]]*\]\));/)?.[1];
        expect(literal).toBeTruthy();
        const bundled = new Function(`return ${literal};`)();
        const index = JSON.parse(read('default/content/index.json'));
        const shipped = index.filter(item => /^presets\/moving-ui\/.+\.json$/.test(item.filename))
            .map(item => JSON.parse(read(`default/content/${item.filename}`)).name);
        expect(shipped).toHaveLength(5);
        expect([...bundled].sort()).toEqual([...shipped].sort());
    });

    test('the prompt reset names cover every reset case', () => {
        const source = read('public/scripts/PromptManager.js');
        const literal = source.match(/export const PROMPT_RESET_NAMES = (Object\.freeze\(\{[^}]*\}\));/)?.[1];
        expect(literal).toBeTruthy();
        const names = new Function(`return ${literal};`)();
        const reset = source.match(/this\.handleResetPrompt = \(\) => \{\n[^]*?\n {8}\};/)?.[0];
        expect(reset).toBeTruthy();
        const cases = [...reset.matchAll(/case '([^']+)':/g)].map(match => match[1]);
        expect(cases.sort()).toEqual(Object.keys(names).sort());
        // Every case takes its name from the map.
        expect(reset).not.toMatch(/prompt\.name = '/);
        expect(Object.isFrozen(names)).toBe(true);
    });
});
