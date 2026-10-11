import { main_api } from '../../script.js';
import { oai_settings, promptManager } from '../openai.js';
import { INJECTION_POSITION } from '../PromptManager.js';
import { power_user } from '../power-user.js';
import { getPresetManager } from '../preset-manager.js';

const API_LABELS = {
    openai: 'Chat Completion',
    textgenerationwebui: 'Text Completion',
    kobold: 'KoboldAI',
    koboldhorde: 'AI Horde',
    novel: 'NovelAI',
};

function text(value) {
    return String(value ?? '').trim();
}

/** The name of the preset the open chat would generate with, or '' when none is selected. */
export function currentPresetName() {
    if (main_api === 'openai' && text(oai_settings?.preset_settings_openai)) return text(oai_settings.preset_settings_openai);
    try {
        return text(getPresetManager()?.getSelectedPresetName());
    } catch {
        return '';
    }
}

function promptOrder() {
    if (!promptManager?.serviceSettings) return [];
    const dummy = { id: promptManager.configuration?.promptOrder?.dummyId };
    const own = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
    return own.length ? own : promptManager.getPromptOrderForCharacter(dummy);
}

function chatModules() {
    return promptOrder().map(entry => {
        const prompt = promptManager.getPromptById(entry.identifier);
        if (!prompt) return null;
        const inChat = Number(prompt.injection_position) === INJECTION_POSITION.ABSOLUTE;
        return {
            id: prompt.identifier,
            name: text(prompt.name) || prompt.identifier,
            enabled: entry.enabled !== false,
            marker: Boolean(prompt.marker),
            role: prompt.marker ? '' : (prompt.role || 'system'),
            depth: inChat ? Number(prompt.injection_depth ?? 4) : null,
            content: prompt.marker ? '' : text(prompt.content),
        };
    }).filter(Boolean);
}

function textModules() {
    const sysprompt = power_user?.sysprompt || {};
    const instruct = power_user?.instruct || {};
    const context = power_user?.context || {};
    return [
        {
            id: 'sysprompt',
            name: `System prompt${text(sysprompt.name) ? `: ${text(sysprompt.name)}` : ''}`,
            enabled: Boolean(sysprompt.enabled),
            marker: false,
            role: 'system',
            depth: null,
            content: [text(sysprompt.content), text(sysprompt.post_history) ? `Post-history instructions:\n${text(sysprompt.post_history)}` : ''].filter(Boolean).join('\n\n'),
        },
        {
            id: 'context',
            name: `Context template${text(context.preset) ? `: ${text(context.preset)}` : ''}`,
            enabled: true,
            marker: false,
            role: '',
            depth: null,
            content: text(context.story_string),
        },
        {
            id: 'instruct',
            name: `Instruct template${text(instruct.preset) ? `: ${text(instruct.preset)}` : ''}`,
            enabled: Boolean(instruct.enabled),
            marker: false,
            role: '',
            depth: null,
            content: '',
        },
    ];
}

/**
 * Reads the active preset and its parts, in prompt order, with what is on and off.
 * Text is returned exactly as saved, so macros and card slots stay unfilled.
 */
export function readCurrentPreset() {
    const api = main_api || '';
    const kind = api === 'openai' ? 'chat' : 'text';
    return {
        kind,
        api: API_LABELS[api] || api,
        name: currentPresetName(),
        modules: kind === 'chat' ? chatModules() : textModules(),
    };
}
