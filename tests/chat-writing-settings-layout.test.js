import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');

const indexHtml = read('public/index.html');
const chatWritingCss = read('public/css/neconyan-chat-writing.css');
const motionTest = read('tests/ui-motion-css-compliance.test.js');

const DRAWERS = [
    { marker: '<div id="ChatCharactersSection"', title: 'Chat &amp; messages', groups: ['Sending', 'Replies', 'Chat window', 'Messages'] },
    { marker: '<div id="CharacterHandlingSection"', title: 'Characters', groups: ['Character list', 'Importing', 'Prompts'] },
    { marker: '<div id="AutoSwipeContinueSection"', title: 'Auto-swipe &amp; auto-continue', groups: ['Auto-swipe', 'Auto-continue'] },
    { marker: '<div name="AutoCompleteToggle"', title: 'Autocomplete', groups: ['When it shows', 'Choosing', 'Look'] },
    { marker: '<div id="ChatFineTuningSection"', title: 'Fine-tuning', groups: ['Tools', 'Prompt context', 'Developer'] },
    { marker: '<div id="MovingUISection"', title: 'Movable panels', groups: ['Moving panels', 'Layouts'] },
];

const CONTROL_IDS = [
    'send_on_enter', 'continue_on_send', 'quick_continue', 'quick_impersonate', 'restore_user_input',
    'enable_auto_select_input', 'enable_md_hotkeys', 'smooth_streaming', 'smooth_streaming_no_think',
    'smooth_streaming_speed', 'stream_fade_in', 'streaming_fps', 'streaming_fps_counter', 'play_message_sound',
    'audio_message_sound', 'play_sound_unfocused', 'swipes-checkbox', 'gestures-checkbox', 'image_overswipe',
    'auto_scroll_chat_to_bottom', 'chat_truncation', 'chat_truncation_counter', 'show_group_chat_queue',
    'pin_styles', 'auto-load-chat-checkbox', 'chat-links-checkbox', 'auto_save_msg_edits',
    'confirm_message_delete', 'auto_fix_generated_markdown', 'allow_name2_display', 'allow_name1_display',
    'encode_tags', 'forbid_external_media', 'allow_card_scripts', 'aux_field', 'fuzzy_search_checkbox',
    'show_card_avatar_urls', 'spoiler_free_mode', 'tag_import_setting', 'world_import_dialog',
    'never_resize_avatars', 'background_thumbnails_animation', 'prefer_character_prompt',
    'prefer_character_jailbreak', 'example_messages_behavior', 'disable_group_trimming', 'auto_swipe',
    'auto_swipe_minimum_length', 'auto_swipe_blacklist', 'auto_swipe_blacklist_threshold',
    'auto_continue_enabled', 'auto_continue_allow_chat_completions', 'auto_continue_target_length',
    'stscript_autocomplete_state', 'stscript_autocomplete_autoHide', 'stscript_autocomplete_showInAllMacroFields',
    'stscript_matching', 'stscript_autocomplete_select', 'stscript_autocomplete_style',
    'stscript_autocomplete_font_scale', 'stscript_autocomplete_font_scale_counter',
    'stscript_autocomplete_width_left', 'stscript_autocomplete_width_right', 'reload_chat', 'data_maid_button',
    'debug_menu', 'ooc_context_depth', 'html_context_depth', 'experimental_macro_engine', 'console_log_prompts',
    'request_token_probabilities', 'relaxed_api_urls', 'stscript_parser_flag_strict_escaping',
    'stscript_parser_flag_replace_getvar', 'movingUImode', 'movingUIreset', 'movingUIOffscreenWarning',
    'movingUIOffscreenReset', 'movingUIPresets', 'movingui-preset-save-button',
];

function getDrawerChunks() {
    const starts = DRAWERS.map(drawer => {
        const start = indexHtml.indexOf(drawer.marker);
        expect(start).toBeGreaterThan(-1);
        return start;
    });
    const end = indexHtml.indexOf('<div name="IOSWebKitStreamingToggles"', starts.at(-1));
    expect(end).toBeGreaterThan(starts.at(-1));
    return DRAWERS.map((drawer, index) => ({ ...drawer, chunk: indexHtml.slice(starts[index], starts[index + 1] ?? end) }));
}

describe('Chat & Writing settings layout', () => {
    test('splits the settings into titled drawers of grouped cards with a one-line intro', () => {
        for (const drawer of getDrawerChunks()) {
            expect(drawer.chunk).toContain('class="inline-drawer wide100p flexFlowColumn sb-settings-subdrawer nn-settings-cards"');
            expect(drawer.chunk).toContain(`<span>${drawer.title}</span>`);
            expect(drawer.chunk).toMatch(/<p class="nn-vt-intro">[^<]+<\/p>/);
            const groups = drawer.chunk.split('<section class="nn-vt-group"').slice(1);
            expect(groups.map(group => group.match(/class="nn-vt-group-title">([^<]+)<\/h4>/)?.[1])).toEqual(drawer.groups);
            for (const group of groups) {
                expect(group).toMatch(/<p class="nn-vt-group-hint">[^<]+<\/p>/);
            }
        }
    });

    test('keeps every control id exactly once so existing settings code still binds', () => {
        for (const id of CONTROL_IDS) {
            expect(indexHtml.split(`id="${id}"`).length - 1).toBe(1);
        }
        expect(indexHtml).not.toContain('id="power-user-option-checkboxes"');
        expect(indexHtml).not.toContain('id="ChatMessageHandlingSection"');
    });

    test('every switch row shows a name and a visible description, with the switch last', () => {
        const chunks = getDrawerChunks().map(drawer => drawer.chunk).join('');
        const rows = [...chunks.matchAll(/<label (?:id="[^"]+" )?for="([^"]+)" class="checkbox_label nn-vt-row[^"]*">([\s\S]*?)<\/label>/g)];
        expect(rows.length).toBeGreaterThan(40);
        for (const [, id, body] of rows) {
            expect(body).toMatch(/<small class="nn-vt-name"[^>]*>[^<]+<\/small>/);
            expect(body).toMatch(/<span class="nn-vt-desc">[^<]+/);
            expect(body.trim().endsWith(`<input id="${id}" type="checkbox" />`)).toBe(true);
        }
    });

    test('ships its styles in a deferred, accent-aware sheet', () => {
        expect(indexHtml).toMatch(/<link href="css\/neconyan-chat-writing\.css\?v=[^"]+" rel="preload" as="style" data-sb-deferred-style data-sb-media="all">/);
        expect(motionTest).toContain('new URL(\'../public/css/neconyan-chat-writing.css\', import.meta.url)');
        expect(chatWritingCss).toContain('var(--neco-ginger,');
        expect(chatWritingCss).not.toMatch(/#[0-9a-f]{3,8}\b(?![\w-])/i);
        expect(chatWritingCss).toContain('prefers-reduced-motion');
    });

    test('offers MovingUI layout presets that never move the chat', () => {
        const contentIndex = JSON.parse(read('default/content/index.json'));
        const presetFiles = contentIndex.filter(item => item.type === 'moving_ui').map(item => item.filename);
        expect(presetFiles).toEqual([
            'presets/moving-ui/Default.json',
            'presets/moving-ui/Pop-outs on the Right.json',
            'presets/moving-ui/Writing Desk.json',
            'presets/moving-ui/Centred Card.json',
            'presets/moving-ui/Compact Corner.json',
        ]);
        for (const file of presetFiles.slice(1)) {
            const preset = JSON.parse(read(`default/content/${file}`));
            expect(path.basename(file, '.json')).toBe(preset.name);
            expect(Object.keys(preset.movingUIState).sort()).toEqual(['cfgConfig', 'floatingPrompt', 'logprobsViewer']);
        }
    });
});
