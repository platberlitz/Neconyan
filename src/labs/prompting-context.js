import path from 'node:path';
import { parseChatJsonl } from '../chat-recovery.js';
import { readRoleplayFile } from '../roleplay-store.js';
import { roleplayEntityContent } from '../generation/roleplay-source.js';
import { captureGenerationBinding, captureProfilePresetBinding, resolveGenerationProfile } from '../generation/profiles.js';
import { captureSavedRoleplayImages, savedAttachments, selectSavedRoleplayPersona } from '../generation/world-info.js';
import { getSettingsRevision } from '../settings-version.js';
import { readLabSettings } from './sources.js';
import { captureWorldInfoLab } from './world-info.js';
import { labError } from './store.js';
import { capturePromptingTags } from './prompting-tags.js';
import { capturePromptingMemory } from './prompting-memory.js';
import { SENSITIVE_FIELDS, withoutFields } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/presets.js';

const TEMPLATE_DIRECTORIES = { context: 'context', instruct: 'instruct', sysprompt: 'sysprompt', reasoning: 'reasoning' };

function readPreset(base, ref) {
    const directory = base.directories[TEMPLATE_DIRECTORIES[ref.apiId]];
    if (!directory || !ref.name || path.basename(ref.name) !== ref.name) throw labError('The pinned prompt template is invalid.');
    const file = readRoleplayFile(path.join(directory, ref.name + '.json'), 8 * 1024 * 1024);
    if (!file) throw labError(`The pinned ${ref.apiId} template is missing.`);
    try { return withoutFields(JSON.parse(file.bytes.toString('utf8')), SENSITIVE_FIELDS); } catch { throw labError('The pinned template is unreadable.'); }
}

/** Read a hypothetical test's saved sources without selecting a character or editing a chat. */
export function capturePromptingContext(base, account, pins, { maxTokens = 300, locator } = {}) {
    const avatar = pins.characterAvatar;
    if (typeof avatar !== 'string' || !avatar || path.basename(avatar) !== avatar) throw labError('Choose a saved character for this test.');
    const bytes = readRoleplayFile(path.join(base.directories.characters, avatar), 16 * 1024 * 1024);
    if (!bytes) throw labError('The test character no longer exists.');
    const card = roleplayEntityContent('character', avatar, bytes.bytes).data;
    const data = card.data ?? card;
    const settings = readLabSettings(base), power = settings.power_user ??= {};
    const templates = {};
    for (const ref of pins.presets ?? []) {
        if (TEMPLATE_DIRECTORIES[ref.apiId]) power[ref.apiId] = templates[ref.apiId] = readPreset(base, ref);
    }
    if (pins.macroEnhanced === 'off') power.experimental_macro_engine = false;
    const selected = locator ?? { group: false, avatar, chat: card.chat || data.chat || '' };
    if (selected.group || selected.avatar !== avatar || typeof selected.chat !== 'string' || path.basename(selected.chat) !== selected.chat) {
        throw labError('The test chat does not belong to its selected character.');
    }
    const file = selected.chat ? readRoleplayFile(path.join(base.directories.chats, path.parse(avatar).name, selected.chat + '.jsonl'),
        8 * 1024 * 1024, { allowMissingParent: true }) : null;
    const parsed = file ? parseChatJsonl(file.bytes) : null;
    if (locator?.chat && !file) throw labError('The selected saved test chat no longer exists.');
    if (parsed && parsed.status !== 'ok') throw labError('The test chat is damaged.');
    const records = parsed?.records ?? [{ user_name: settings.username || 'User', character_name: data.name, chat_metadata: {} },
        ...(data.first_mes ? [{ name: data.name, is_user: false, is_system: false, mes: data.first_mes }] : [])];
    records[0].chat_metadata ??= {};
    if (pins.personaKey) records[0].chat_metadata.persona = pins.personaKey;
    const persona = selectSavedRoleplayPersona(settings, { locator: selected, records }, {}, avatar, base.directories);
    const names = { user: persona.name || settings.username || 'User', char: data.name || path.parse(avatar).name };
    const chat = { locator: selected, records, persona: { ...persona, name: names.user }, macros: {
        names, character: { ...data, persona: persona.description }, variables: { local: records[0].chat_metadata.variables ?? {},
            global: settings.extension_settings?.variables?.global ?? {} }, extra: { chat: records.slice(1), chatMetadata: records[0].chat_metadata },
    } };
    let binding = captureGenerationBinding(base.directories, pins.connectionProfileId
        ? { kind: 'profile', profileId: pins.connectionProfileId } : { kind: 'active' }, { settingsRevision: getSettingsRevision(readLabSettings(base)) });
    const sampler = (pins.presets ?? []).find(ref => ['openai', 'textgenerationwebui'].includes(ref.apiId));
    let material = resolveGenerationProfile(base.directories, binding);
    if (sampler) {
        if ((sampler.apiId === 'openai') === (material.backend === 'text')) throw labError('The pinned preset and connection use different prompt formats.');
        if (binding.kind === 'active') {
            const directory = sampler.apiId === 'openai' ? base.directories.openAI_Settings : base.directories.textGen_Settings;
            if (!directory || path.basename(sampler.name) !== sampler.name) throw labError('The pinned completion preset is invalid.');
            const file = readRoleplayFile(path.join(directory, sampler.name + '.json'), 8 * 1024 * 1024);
            if (!file) throw labError('The pinned completion preset is missing.');
            templates.sampler = withoutFields(JSON.parse(file.bytes.toString('utf8')), SENSITIVE_FIELDS);
        } else binding = captureProfilePresetBinding(base.directories, binding, sampler.name);
        material = resolveGenerationProfile(base.directories, binding);
    }
    const controls = { ...material.active, ...material.preset, ...templates.sampler };
    const maxContext = Number(material.contextLimit || controls.openai_max_context || settings.max_context || 4096) - maxTokens;
    if (!Number.isSafeInteger(maxContext) || maxContext < 1) throw labError('The reply limit leaves no room for the test prompt.');
    const scan = captureWorldInfoLab(base, account, { mode: 'chat', maxContext }, 'world-info.scan', {
        chat, settings, allowEmpty: true, tokenizer: { kind: 'binding', binding },
    });
    const metadata = records[0].chat_metadata, extensions = settings.extension_settings ?? {}, note = extensions.note ?? {};
    const snapshot = {
        source: { locator: selected }, avatar, characterFile: path.parse(avatar).name, speakerNames: { user: names.user, character: names.char },
        groupNames: [], unmutedGroupNames: [], groupPrompt: null, pinExamples: Boolean(power.pin_examples), alwaysForceName: Boolean(power.always_force_name2),
        contextRetention: { html: power.html_context_depth ?? -1, ooc: power.ooc_context_depth ?? -1 },
        characterExamples: metadata.mes_example || data.mes_example || '',
        characterFields: { version: data.character_version ?? '', firstMessage: data.first_mes ?? '', alternateGreetings: data.alternate_greetings ?? [] },
        promptSettings: Object.fromEntries(['instruct', 'context', 'sysprompt', 'collapse_newlines', 'strip_examples', 'token_padding', 'user_prompt_bias']
            .filter(key => power[key] !== undefined).map(key => [key, power[key]])),
        attachments: savedAttachments(base.directories, records),
        images: captureSavedRoleplayImages(base.directories, records, power.media_display ?? 'list', extensions.caption), mediaDisplay: power.media_display ?? 'list',
        systemPrompt: (power.prefer_character_prompt ?? true) ? metadata.system_prompt || data.system_prompt || '' : '',
        postHistory: { character: (power.prefer_character_jailbreak ?? true) ? data.post_history_instructions ?? '' : '',
            textEnabled: Boolean(power.sysprompt?.enabled), text: power.sysprompt?.post_history ?? '' },
        storyTemplate: power.context?.story_string ?? '', storyPosition: power.context?.story_string_position ?? 0,
        personaPosition: persona.position, personaDepth: persona.depth, personaRole: persona.role, promptVariables: chat.macros.variables,
        experimentalMacroEngine: Boolean(power.experimental_macro_engine), enhancedLoreMacros: pins.macroEnhanced !== 'off',
        depthPrompt: { prompt: data.extensions?.depth_prompt?.prompt ?? '', depth: data.extensions?.depth_prompt?.depth ?? 4,
            role: data.extensions?.depth_prompt?.role ?? 'system' }, regex: scan.regex, noteScanEnabled: Boolean(note.allowWIScan),
        cfg: extensions.cfg ?? null, reasoningInPrompt: Boolean(power.reasoning?.add_to_prompts), reasoning: {
            prefix: power.reasoning?.prefix ?? '<think>', suffix: power.reasoning?.suffix ?? '</think>', separator: power.reasoning?.separator ?? '\n',
            max_additions: power.reasoning?.max_additions ?? 1,
        }, metadata, authorNote: { prompt: metadata.note_prompt ?? note.default ?? '', interval: metadata.note_interval ?? note.defaultInterval ?? 1,
            position: metadata.note_position ?? note.defaultPosition ?? 1, depth: metadata.note_depth ?? note.defaultDepth ?? 4,
            role: metadata.note_role ?? note.defaultRole ?? 0, scoped: note.chara?.find(item => item.name === `individual:${avatar}`)
                ?? note.chara?.find(item => item.name === path.parse(avatar).name) ?? null,
            userMessages: records.slice(1).filter(item => item.is_user).length },
        global: { ...scan.globalScanData, inject: scan.injections },
    };
    return { binding, templates, records, snapshot, scan, macros: chat.macros, maxTokens, maxContext,
        memory: file ? capturePromptingMemory(base.directories, selected, records) : null,
        promptTags: capturePromptingTags(settings, metadata, data, controls, pins.promptTags),
        environment: { apiType: material.backend === 'text' ? 'tc' : 'cc', api: material.source ?? material.backend ?? 'openai',
            model: material.profile?.model ?? controls.openai_model ?? '', profileName: material.profile?.name ?? pins.connectionProfileId ?? '',
            presetName: sampler?.name ?? material.profile?.preset ?? '', presets: pins.presets ?? [], personaName: names.user,
            characterName: names.char, characterAvatar: avatar, macroEnhanced: pins.macroEnhanced ?? 'record' },
        settings: settings.extension_settings?.SillyBunnyPromptingLab ?? {} };
}

export function promptingMaterial(directories, plan) {
    const material = resolveGenerationProfile(directories, plan.binding);
    const power = { ...material.power, ...plan.snapshot.promptSettings, ...Object.fromEntries(Object.entries(plan.templates).filter(([key]) => key !== 'sampler')) };
    return { ...material, power, ...(plan.templates.sampler ? { preset: plan.templates.sampler } : {}),
        ...(plan.templates.context ? { context: plan.templates.context } : {}), ...(plan.templates.instruct ? { instruct: plan.templates.instruct } : {}) };
}
