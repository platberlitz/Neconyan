export { translate };

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { POPUP_TYPE, callGenericPopup } from '../../popup.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { enumIcons } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { enumTypes, SlashCommandEnumValue } from '../../slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { isTranslationRefresh, mountSavedTranslations, translateSaved, translateText } from './native.js';
import { secret_state } from '../../secrets.js';

export const autoModeOptions = {
    NONE: 'none',
    RESPONSES: 'responses',
    INPUT: 'inputs',
    BOTH: 'both',
};

const incomingTypes = [autoModeOptions.RESPONSES, autoModeOptions.BOTH];
const outgoingTypes = [autoModeOptions.INPUT, autoModeOptions.BOTH];

const defaultSettings = {
    target_language: 'en',
    internal_language: 'en',
    provider: 'google',
    auto_mode: autoModeOptions.NONE,
    deepl_endpoint: 'free',
};

const languageCodes = {
    'Afrikaans': 'af',
    'Albanian': 'sq',
    'Amharic': 'am',
    'Arabic': 'ar',
    'Armenian': 'hy',
    'Azerbaijani': 'az',
    'Basque': 'eu',
    'Belarusian': 'be',
    'Bengali': 'bn',
    'Bosnian': 'bs',
    'Bulgarian': 'bg',
    'Catalan': 'ca',
    'Cebuano': 'ceb',
    'Chinese (Simplified)': 'zh-CN',
    'Chinese (Traditional)': 'zh-TW',
    'Corsican': 'co',
    'Croatian': 'hr',
    'Czech': 'cs',
    'Danish': 'da',
    'Dutch': 'nl',
    'English': 'en',
    'Esperanto': 'eo',
    'Estonian': 'et',
    'Finnish': 'fi',
    'French': 'fr',
    'Frisian': 'fy',
    'Galician': 'gl',
    'Georgian': 'ka',
    'German': 'de',
    'Greek': 'el',
    'Gujarati': 'gu',
    'Haitian Creole': 'ht',
    'Hausa': 'ha',
    'Hawaiian': 'haw',
    'Hebrew': 'iw',
    'Hindi': 'hi',
    'Hmong': 'hmn',
    'Hungarian': 'hu',
    'Icelandic': 'is',
    'Igbo': 'ig',
    'Indonesian': 'id',
    'Irish': 'ga',
    'Italian': 'it',
    'Japanese': 'ja',
    'Javanese': 'jw',
    'Kannada': 'kn',
    'Kazakh': 'kk',
    'Khmer': 'km',
    'Korean': 'ko',
    'Kurdish': 'ku',
    'Kyrgyz': 'ky',
    'Lao': 'lo',
    'Latin': 'la',
    'Latvian': 'lv',
    'Lithuanian': 'lt',
    'Luxembourgish': 'lb',
    'Macedonian': 'mk',
    'Malagasy': 'mg',
    'Malay': 'ms',
    'Malayalam': 'ml',
    'Maltese': 'mt',
    'Maori': 'mi',
    'Marathi': 'mr',
    'Mongolian': 'mn',
    'Myanmar (Burmese)': 'my',
    'Nepali': 'ne',
    'Norwegian': 'no',
    'Nyanja (Chichewa)': 'ny',
    'Pashto': 'ps',
    'Persian': 'fa',
    'Polish': 'pl',
    'Portuguese (Portugal)': 'pt-PT',
    'Portuguese (Brazil)': 'pt-BR',
    'Punjabi': 'pa',
    'Romanian': 'ro',
    'Russian': 'ru',
    'Samoan': 'sm',
    'Scots Gaelic': 'gd',
    'Serbian': 'sr',
    'Sesotho': 'st',
    'Shona': 'sn',
    'Sindhi': 'sd',
    'Sinhala (Sinhalese)': 'si',
    'Slovak': 'sk',
    'Slovenian': 'sl',
    'Somali': 'so',
    'Spanish': 'es',
    'Sundanese': 'su',
    'Swahili': 'sw',
    'Swedish': 'sv',
    'Tagalog (Filipino)': 'tl',
    'Tajik': 'tg',
    'Tamil': 'ta',
    'Telugu': 'te',
    'Thai': 'th',
    'Turkish': 'tr',
    'Ukrainian': 'uk',
    'Urdu': 'ur',
    'Uzbek': 'uz',
    'Vietnamese': 'vi',
    'Welsh': 'cy',
    'Xhosa': 'xh',
    'Yiddish': 'yi',
    'Yoruba': 'yo',
    'Zulu': 'zu',
};

const KEY_REQUIRED = ['deepl', 'libre'];
const LOCAL_URL = ['libre', 'oneringtranslator', 'deeplx', 'lingva'];

function showKeysButton() {
    const providerRequiresKey = KEY_REQUIRED.includes(extension_settings.translate.provider);
    const providerOptionalUrl = LOCAL_URL.includes(extension_settings.translate.provider);
    $('#translate_key_button').toggle(providerRequiresKey).data('key', extension_settings.translate.provider);
    $('#translate_key_button').toggleClass('success', Boolean(secret_state[extension_settings.translate.provider]));
    $('#translate_url_button').toggle(providerOptionalUrl).data('key', extension_settings.translate.provider + '_url');
    $('#translate_url_button').toggleClass('success', Boolean(secret_state[extension_settings.translate.provider + '_url']));
    $('#deepl_api_endpoint').toggle(extension_settings.translate.provider === 'deepl');
}

function loadSettings() {
    for (const key in defaultSettings) {
        if (!Object.hasOwn(extension_settings.translate, key)) {
            extension_settings.translate[key] = defaultSettings[key];
        }
    }

    $(`#translation_provider option[value="${extension_settings.translate.provider}"]`).attr('selected', 'true');
    $(`#translation_target_language option[value="${extension_settings.translate.target_language}"]`).attr('selected', 'true');
    $(`#translation_auto_mode option[value="${extension_settings.translate.auto_mode}"]`).attr('selected', 'true');
    $('#deepl_api_endpoint').val(extension_settings.translate.deepl_endpoint).toggle(extension_settings.translate.provider === 'deepl');
    showKeysButton();
}

/**
 * Check if the swipe is being generated for a message.
 * @param {string|number} messageId Message ID
 * @returns {boolean} Whether the swipe is being generated
 */
function isGeneratingSwipe(messageId) {
    return $(`#chat .mes[mesid="${messageId}"] .mes_text`).text() === '...';
}

async function translateImpersonate() {
    const sendTextArea = $('#send_textarea');
    const text = sendTextArea.val().toString();
    const translatedText = await translate(text, extension_settings.translate.target_language);
    if (sendTextArea.val() === text) sendTextArea.val(translatedText);
}

/**
 * Translates the contents of an incoming message.
 * @param {string | number} messageId Message ID
 * @returns {Promise<void>}
 */
async function translateIncomingMessage(messageId) {
    const message = getContext().chat[messageId];
    if (!message || message.is_system || isGeneratingSwipe(messageId) || isTranslationRefresh()) return;
    return translateSaved({ mode: 'message', index: Number(messageId) }, { automatic: true });
}

/**
 * Translates the reasoning of an incoming message.
 * @param {string | number} messageId
 * @returns {Promise<boolean>} translated or not
 */
async function translateIncomingMessageReasoning(messageId) {
    const message = getContext().chat[messageId];
    if (!message?.extra?.reasoning || message.is_system || isGeneratingSwipe(messageId) || isTranslationRefresh()) return false;
    await translateSaved({ mode: 'message', index: Number(messageId), fields: ['reasoning'] }, { automatic: true });
    return true;
}

/**
 * Translates text using the selected translation provider
 * @param {string} text Text to translate
 * @param {string} lang Target language code
 * @param {string} provider Translation provider to use
 * @returns {Promise<string>} Translated text
 */
async function translate(text, lang, provider = null) {
    return translateText(text, lang || extension_settings.translate.target_language, provider);
}

async function translateOutgoingMessage(messageId) {
    const message = getContext().chat[messageId];
    if (!message || message.is_system || message.extra?.display_text || isTranslationRefresh()) return;
    return translateSaved({ mode: 'message', index: Number(messageId), direction: 'input', fields: ['body'] }, { automatic: true });
}

function shouldTranslate(types) {
    return types.includes(extension_settings.translate.auto_mode);
}

function createEventHandler(translateFunction, shouldTranslateFunction) {
    return async (data) => {
        if (shouldTranslateFunction()) {
            await translateFunction(data);
        }
    };
}

async function onTranslateInputMessageClick() {
    const textarea = document.getElementById('send_textarea');

    if (!(textarea instanceof HTMLTextAreaElement)) {
        return;
    }

    if (!textarea.value) {
        toastr.warning('Enter a message first');
        return;
    }

    const toast = toastr.info('Input Message is translating', 'Please wait...');
    const original = textarea.value;
    try {
        const translatedText = await translate(original, extension_settings.translate.internal_language);
        if (textarea.value === original) {
            textarea.value = translatedText;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        } else toastr.info('The translation was saved. Your newer input was kept.');
    } catch (error) { toastr.error(error.message, 'Translation did not finish'); } finally { toastr.clear(toast); }
}

// Prevents the chat from being translated in parallel
let translateChatExecuting = false;

async function onTranslateChatClick() {
    if (translateChatExecuting) {
        return;
    }

    try {
        translateChatExecuting = true;
        toastr.info('The saved chat is being translated on the server.');
        await translateSaved({ mode: 'chat' });
    } catch (error) {
        console.log(error);
        toastr.error('Failed to translate chat');
    } finally {
        translateChatExecuting = false;
    }
}

async function onTranslationsClearClick() {
    const popupHtml = await renderExtensionTemplateAsync('translate', 'deleteConfirmation');
    const confirm = await callGenericPopup(popupHtml, POPUP_TYPE.CONFIRM);

    if (!confirm) {
        return;
    }

    await translateSaved({ mode: 'clear' });
}

async function translateMessageEdit(messageId) {
    if (isTranslationRefresh()) return;
    const message = getContext().chat[messageId];
    if (!message) return;
    if (message.is_system || (extension_settings.translate.auto_mode == autoModeOptions.NONE && message.extra?.display_text)) {
        await translateSaved({ mode: 'clear', index: Number(messageId), fields: ['body'] }, { automatic: true });
    } else if ((message.is_user && shouldTranslate(outgoingTypes)) || (!message.is_user && shouldTranslate(incomingTypes))) {
        await translateIncomingMessage(messageId);
    }
}

async function translateMessageReasoningEdit(messageId) {
    if (isTranslationRefresh()) return;
    const message = getContext().chat[messageId];
    if (!message) return;
    if (message.is_system || (extension_settings.translate.auto_mode == autoModeOptions.NONE && message.extra?.reasoning_display_text)) {
        await translateSaved({ mode: 'clear', index: Number(messageId), fields: ['reasoning'] }, { automatic: true });
    } else if ((message.is_user && shouldTranslate(outgoingTypes)) || (!message.is_user && shouldTranslate(incomingTypes))) {
        await translateIncomingMessageReasoning(messageId);
    }
}

async function removeReasoningDisplayText(messageId) {
    if (!isTranslationRefresh() && getContext().chat[messageId]?.extra?.reasoning_display_text) {
        await translateSaved({ mode: 'clear', index: Number(messageId), fields: ['reasoning'] }, { automatic: true });
    }
}

async function onMessageTranslateClick() {
    const context = getContext();
    const messageId = $(this).closest('.mes').attr('mesid');
    const message = context.chat[messageId];

    if (!message) return;
    const alreadyTranslated = message.extra?.display_text || message.extra?.reasoning_display_text;
    try { await translateSaved({ mode: alreadyTranslated ? 'clear' : 'message', index: Number(messageId) }); } catch (error) { toastr.error(error.message, 'Translation did not finish'); }
}

const handleIncomingMessage = createEventHandler(async (messageId) => {
    if (getContext().chat[messageId]?.extra?.display_text) return;
    await translateIncomingMessage(messageId);
}, () => shouldTranslate(incomingTypes));
const handleOutgoingMessage = createEventHandler(translateOutgoingMessage, () => shouldTranslate(outgoingTypes));
const handleImpersonateReady = createEventHandler(translateImpersonate, () => shouldTranslate(incomingTypes));
const handleMessageEdit = createEventHandler(translateMessageEdit, () => true);
const handleMessageReasoningEdit = createEventHandler(translateMessageReasoningEdit, () => true);
const handleMessageReasoningDelete = createEventHandler(removeReasoningDisplayText, () => true);

globalThis.translate = translate;

export async function init() {
    const html = await renderExtensionTemplateAsync('translate', 'index');
    const buttonHtml = await renderExtensionTemplateAsync('translate', 'buttons');

    $('#translate_wand_container').append(buttonHtml);
    $('#translation_container').append(html);
    $('#translate_chat').on('click', onTranslateChatClick);
    $('#translate_input_message').on('click', onTranslateInputMessageClick);
    $('#translation_clear').on('click', onTranslationsClearClick);

    for (const [key, value] of Object.entries(languageCodes)) {
        $('#translation_target_language').append(`<option value="${value}">${key}</option>`);
    }

    $('#translation_auto_mode').on('change', (event) => {
        if (!(event.target instanceof HTMLSelectElement)) {
            return;
        }
        extension_settings.translate.auto_mode = event.target.value;
        saveSettingsDebounced();
    });
    $('#translation_provider').on('change', (event) => {
        if (!(event.target instanceof HTMLSelectElement)) {
            return;
        }
        extension_settings.translate.provider = event.target.value;
        showKeysButton();
        saveSettingsDebounced();
    });
    $('#translation_target_language').on('change', (event) => {
        if (!(event.target instanceof HTMLSelectElement)) {
            return;
        }
        extension_settings.translate.target_language = event.target.value;
        saveSettingsDebounced();
    });
    $('#deepl_api_endpoint').on('change', (event) => {
        if (!(event.target instanceof HTMLSelectElement)) {
            return;
        }
        extension_settings.translate.deepl_endpoint = event.target.value;
        saveSettingsDebounced();
    });
    $(document).on('click', '.mes_translate', onMessageTranslateClick);

    [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED].forEach((eventType) => {
        eventSource.on(eventType, (/** @type {string} */ key) => {
            if (key === extension_settings.translate.provider) {
                $('#translate_key_button').toggleClass('success', !!secret_state[extension_settings.translate.provider]);
            }
            if (key === `${extension_settings.translate.provider}_url`) {
                $('#translate_url_button').toggleClass('success', !!secret_state[`${extension_settings.translate.provider}_url`]);
            }
        });
    });

    loadSettings();
    mountSavedTranslations(document.querySelector('#translation_container .inline-drawer-content'));

    eventSource.makeFirst(event_types.CHARACTER_MESSAGE_RENDERED, handleIncomingMessage);
    eventSource.makeFirst(event_types.USER_MESSAGE_RENDERED, handleOutgoingMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, handleIncomingMessage);
    eventSource.on(event_types.IMPERSONATE_READY, handleImpersonateReady);
    eventSource.on(event_types.MESSAGE_UPDATED, handleMessageEdit);
    eventSource.on(event_types.MESSAGE_REASONING_EDITED, handleMessageReasoningEdit);
    eventSource.on(event_types.MESSAGE_REASONING_DELETED, handleMessageReasoningDelete);

    document.body.classList.add('translate');

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'translate',
        helpString: 'Translate text to a target language. If target language is not provided, the value from the extension settings will be used.',
        namedArgumentList: [
            new SlashCommandNamedArgument('target', 'The target language code to translate to', ARGUMENT_TYPE.STRING, false, false, '', Object.values(languageCodes)),
            SlashCommandNamedArgument.fromProps({
                name: 'provider',
                description: 'The translation provider to use. If not provided, the value from the extension settings will be used.',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                acceptsMultiple: false,
                enumProvider: () => Array.from(document.getElementById('translation_provider').querySelectorAll('option')).map((option) => new SlashCommandEnumValue(option.value, option.text, enumTypes.name, enumIcons.server)),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('The text to translate', ARGUMENT_TYPE.STRING, true, false, ''),
        ],
        callback: async (args, value) => {
            const target = args?.target && Object.values(languageCodes).includes(String(args.target))
                ? String(args.target)
                : extension_settings.translate.target_language;
            const provider = args?.provider || extension_settings.translate.provider;
            return await translate(String(value), target, provider);
        },
        returns: ARGUMENT_TYPE.STRING,
    }));
}
