import { moment, seedrandom, droll } from './engine/macro-vendor.js';
import { getStringHash } from '../macro-primitives.js';
import { inject_ids } from '../constants.js';
import { escapeRegex, uuidv4 } from '../slash-commands/SlashCommandRuntimeUtils.js';

// The historical regex evaluator. A host belongs to one evaluation, never to
// the process-wide modern registry. Keep table order and replacement semantics.
export function evaluateLegacyMacros(content, env, host, postProcessFn) {
    if (!content) return '';
    const { chat, chatMetadata: chat_metadata, powerUser: power_user, variables,
        getCurrentChatId, getMaxPromptTokens, getMaxContextTokens, getMaxResponseTokens,
        timestampToMoment, getFirstDisplayedMessageId } = host;
    postProcessFn = typeof postProcessFn === 'function' ? postProcessFn : (x => x);
    const rawContent = content;

    function getChatIdHash() {
        const cachedIdHash = chat_metadata.chat_id_hash;
        if (!cachedIdHash) {
            const chatId = chat_metadata.main_chat ?? getCurrentChatId();
            const chatIdHash = getStringHash(chatId);
            host.setChatIdHash(chatIdHash);
            return chatIdHash;
        }
        return cachedIdHash;
    }
    function getLastMessageId(options) { return getLegacyLastMessageId(chat, options); }
    function getFirstIncludedMessageId() { return chat_metadata.lastInContextMessageId; }
    function getLastMessage() { return chat[getLastMessageId()]?.mes ?? ''; }
    function getLastUserMessage() { return chat[getLastMessageId({ filter: m => m.is_user && !m.is_system })]?.mes ?? ''; }
    function getLastCharMessage() { return chat[getLastMessageId({ filter: m => !m.is_user && !m.is_system })]?.mes ?? ''; }
    function getLastSwipeId() { return chat[getLastMessageId({ exclude_swipe_in_propress: false })]?.swipes?.length; }
    function getCurrentSwipeId() {
        const swipeId = chat[getLastMessageId({ exclude_swipe_in_propress: false })]?.swipe_id;
        return swipeId !== null ? swipeId + 1 : null;
    }
    function getTimeSinceLastMessage() {
        const now = moment();
        if (Array.isArray(chat) && chat.length > 0) {
            let lastMessage;
            let takeNext = false;
            for (let i = chat.length - 1; i >= 0; i--) {
                const message = chat[i];
                if (message.is_system) continue;
                if (message.is_user && takeNext) { lastMessage = message; break; }
                takeNext = true;
            }
            if (lastMessage?.send_date) {
                return moment.duration(now.diff(timestampToMoment(lastMessage.send_date))).humanize();
            }
        }
        return 'just now';
    }
    function getDiceRollMacro() {
        const rollPattern = /{{roll[ : ]([^}]+)}}/gi;
        const rollReplace = (match, matchValue) => {
            let formula = matchValue.trim();
            if (/^\d+$/.test(formula)) formula = `1d${formula}`;
            if (!droll.validate(formula)) { console.debug(`Invalid roll formula: ${formula}`); return ''; }
            const result = droll.roll(formula);
            if (result === false) return '';
            return String(result.total);
        };
        return { regex: rollPattern, replace: rollReplace };
    }
    function getBannedWordsMacro() {
        return { regex: /{{banned "(.*)"}}/gi, replace: (match, bannedWord) => {
            if (host.mainApi == 'textgenerationwebui') {
                console.log('Found banned word in macros: ' + bannedWord);
                host.bannedWords.push(bannedWord);
            }
            return '';
        } };
    }
    function getRandomReplaceMacro() {
        return { regex: /{{random\s?::?([^}]+)}}/gi, replace: (match, listString) => {
            const list = listString.includes('::') ? listString.split('::')
                : listString.replace(/\\,/g, '##�COMMA�##').split(',').map(item => item.trim().replace(/##�COMMA�##/g, ','));
            if (list.length === 0) return '';
            const rng = seedrandom('added entropy.', { entropy: true });
            return list[Math.floor(rng() * list.length)];
        } };
    }
    function getPickReplaceMacro(rawContent) {
        const chatIdHash = getChatIdHash();
        const rawContentHash = getStringHash(rawContent);
        return { regex: /{{pick\s?::?([^}]+)}}/gi, replace: (match, listString, offset) => {
            const list = listString.includes('::') ? listString.split('::')
                : listString.replace(/\\,/g, '##�COMMA�##').split(',').map(item => item.trim().replace(/##�COMMA�##/g, ','));
            if (list.length === 0) return '';
            const combinedSeedString = `${chatIdHash}-${rawContentHash}-${offset}`;
            const finalSeed = getStringHash(combinedSeedString);
            const rng = seedrandom(finalSeed);
            return list[Math.floor(rng() * list.length)];
        } };
    }
    function getTimeDiffMacro() {
        return { regex: /{{timeDiff::(.*?)::(.*?)}}/gi, replace: (_match, left, right) => moment.duration(moment(left).diff(moment(right))).humanize(true) };
    }
    function getOutletPrompt(key) { return host.extensionPrompts[inject_ids.CUSTOM_WI_OUTLET(key)]?.value || ''; }

    const preEnvMacros = [
        { regex: /<USER>/gi, replace: () => typeof env.user === 'function' ? env.user() : env.user },
        { regex: /<BOT>/gi, replace: () => typeof env.char === 'function' ? env.char() : env.char },
        { regex: /<CHAR>/gi, replace: () => typeof env.char === 'function' ? env.char() : env.char },
        { regex: /<CHARIFNOTGROUP>/gi, replace: () => typeof env.group === 'function' ? env.group() : env.group },
        { regex: /<GROUP>/gi, replace: () => typeof env.group === 'function' ? env.group() : env.group },
        getDiceRollMacro(),
        ...getLegacyInstructMacros(env, power_user),
        ...getLegacyVariableMacros(variables),
        { regex: /{{newline}}/gi, replace: () => '\n' },
        { regex: /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, replace: () => '' },
        { regex: /{{noop}}/gi, replace: () => '' },
        { regex: /{{input}}/gi, replace: () => String(host.getInput()) },
    ];
    const postEnvMacros = [
        { regex: /{{maxPrompt}}/gi, replace: () => String(getMaxPromptTokens()) },
        { regex: /{{maxPromptTokens}}/gi, replace: () => String(getMaxPromptTokens()) },
        { regex: /{{maxContext}}/gi, replace: () => String(getMaxContextTokens()) },
        { regex: /{{maxContextTokens}}/gi, replace: () => String(getMaxContextTokens()) },
        { regex: /{{maxResponse}}/gi, replace: () => String(getMaxResponseTokens()) },
        { regex: /{{maxResponseTokens}}/gi, replace: () => String(getMaxResponseTokens()) },
        { regex: /{{lastMessage}}/gi, replace: () => getLastMessage() },
        { regex: /{{lastMessageId}}/gi, replace: () => String(getLastMessageId() ?? '') },
        { regex: /{{lastUserMessage}}/gi, replace: () => getLastUserMessage() },
        { regex: /{{lastCharMessage}}/gi, replace: () => getLastCharMessage() },
        { regex: /{{firstIncludedMessageId}}/gi, replace: () => String(getFirstIncludedMessageId() ?? '') },
        { regex: /{{firstDisplayedMessageId}}/gi, replace: () => String(getFirstDisplayedMessageId() ?? '') },
        { regex: /{{lastSwipeId}}/gi, replace: () => String(getLastSwipeId() ?? '') },
        { regex: /{{currentSwipeId}}/gi, replace: () => String(getCurrentSwipeId() ?? '') },
        { regex: /{{allChatRange}}/gi, replace: () => chat.length === 0 ? '' : `0-${chat.length - 1}` },
        { regex: /{{reverse:(.+?)}}/gi, replace: (_, str) => Array.from(str).reverse().join('') },
        { regex: /\{\{\/\/([\s\S]*?)\}\}/gm, replace: () => '' },
        { regex: /{{time}}/gi, replace: () => moment().format('LT') },
        { regex: /{{date}}/gi, replace: () => moment().format('LL') },
        { regex: /{{weekday}}/gi, replace: () => moment().format('dddd') },
        { regex: /{{isotime}}/gi, replace: () => moment().format('HH:mm') },
        { regex: /{{isodate}}/gi, replace: () => moment().format('YYYY-MM-DD') },
        { regex: /{{datetimeformat +([^}]*)}}/gi, replace: (_, format) => moment().format(format) },
        { regex: /{{idle_duration}}/gi, replace: () => getTimeSinceLastMessage() },
        { regex: /{{time_UTC([-+]\d+)}}/gi, replace: (_, offset) => moment().utc().utcOffset(parseInt(offset, 10)).format('LT') },
        { regex: /{{outlet::(.+?)}}/gi, replace: (_, key) => getOutletPrompt(key.trim()) || '' },
        getTimeDiffMacro(),
        getBannedWordsMacro(),
        getRandomReplaceMacro(),
        getPickReplaceMacro(rawContent),
    ];

    host.populateEnv(env);
    const nonce = uuidv4();
    const envMacros = [];
    for (const varName in env) {
        if (!Object.hasOwn(env, varName)) continue;
        const envRegex = new RegExp(`{{${escapeRegex(varName)}}}`, 'gi');
        const envReplace = () => {
            const param = env[varName];
            return sanitizeMacroValue(typeof param === 'function' ? param(nonce) : param);
        };
        envMacros.push({ regex: envRegex, replace: envReplace });
    }
    const macros = [...preEnvMacros, ...envMacros, ...postEnvMacros];
    for (const macro of macros) {
        if (!content) break;
        if (!macro.regex.source.startsWith('<') && !content.includes('{{')) break;
        try {
            content = content.replace(macro.regex, (...args) => postProcessFn(macro.replace(...args)));
        } catch (e) {
            console.warn(`Macro content can't be replaced: ${macro.regex} in ${content}`, e);
        }
    }
    return content;
}

export function getLegacyLastMessageId(chat, { exclude_swipe_in_propress = true, filter = null } = {}) {
    for (let i = chat?.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (exclude_swipe_in_propress && message.swipes && message.swipe_id >= message.swipes.length) continue;
        if (!filter || filter(message)) return i;
    }
    return null;
}

export function sanitizeMacroValue(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (value instanceof Promise) { console.warn('Promises are not supported as macro values'); return ''; }
    if (typeof value === 'function') { console.warn('Functions are not supported as macro values'); return ''; }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

export function getLegacyVariableMacros({ local, global }) {
    return [
        { regex: /{{setvar::([^:]+)::([^}]*)}}/gi, replace: (_, name, value) => { local.set(name.trim(), value); return ''; } },
        { regex: /{{addvar::([^:]+)::([^}]+)}}/gi, replace: (_, name, value) => { local.add(name.trim(), value); return ''; } },
        { regex: /{{incvar::([^}]+)}}/gi, replace: (_, name) => local.inc(name.trim()) },
        { regex: /{{decvar::([^}]+)}}/gi, replace: (_, name) => local.dec(name.trim()) },
        { regex: /{{getvar::([^}]+)}}/gi, replace: (_, name) => local.get(name.trim()) },
        { regex: /{{setglobalvar::([^:]+)::([^}]*)}}/gi, replace: (_, name, value) => { global.set(name.trim(), value); return ''; } },
        { regex: /{{addglobalvar::([^:]+)::([^}]+)}}/gi, replace: (_, name, value) => { global.add(name.trim(), value); return ''; } },
        { regex: /{{incglobalvar::([^}]+)}}/gi, replace: (_, name) => global.inc(name.trim()) },
        { regex: /{{decglobalvar::([^}]+)}}/gi, replace: (_, name) => global.dec(name.trim()) },
        { regex: /{{getglobalvar::([^}]+)}}/gi, replace: (_, name) => global.get(name.trim()) },
    ];
}

export function getLegacyInstructMacros(env, power_user) {
    const instructMacros = [
        { key: 'instructStoryStringPrefix', value: power_user.instruct.story_string_prefix, enabled: power_user.instruct.enabled },
        { key: 'instructStoryStringSuffix', value: power_user.instruct.story_string_suffix, enabled: power_user.instruct.enabled },
        { key: 'instructInput|instructUserPrefix', value: power_user.instruct.input_sequence, enabled: power_user.instruct.enabled },
        { key: 'instructUserSuffix', value: power_user.instruct.input_suffix, enabled: power_user.instruct.enabled },
        { key: 'instructOutput|instructAssistantPrefix', value: power_user.instruct.output_sequence, enabled: power_user.instruct.enabled },
        { key: 'instructSeparator|instructAssistantSuffix', value: power_user.instruct.output_suffix, enabled: power_user.instruct.enabled },
        { key: 'instructSystemPrefix', value: power_user.instruct.system_sequence, enabled: power_user.instruct.enabled },
        { key: 'instructSystemSuffix', value: power_user.instruct.system_suffix, enabled: power_user.instruct.enabled },
        { key: 'instructFirstOutput|instructFirstAssistantPrefix', value: power_user.instruct.first_output_sequence || power_user.instruct.output_sequence, enabled: power_user.instruct.enabled },
        { key: 'instructLastOutput|instructLastAssistantPrefix', value: power_user.instruct.last_output_sequence || power_user.instruct.output_sequence, enabled: power_user.instruct.enabled },
        { key: 'instructStop', value: power_user.instruct.stop_sequence, enabled: power_user.instruct.enabled },
        { key: 'instructUserFiller', value: power_user.instruct.user_alignment_message, enabled: power_user.instruct.enabled },
        { key: 'instructSystemInstructionPrefix', value: power_user.instruct.last_system_sequence, enabled: power_user.instruct.enabled },
        { key: 'instructFirstInput|instructFirstUserPrefix', value: power_user.instruct.first_input_sequence || power_user.instruct.input_sequence, enabled: power_user.instruct.enabled },
        { key: 'instructLastInput|instructLastUserPrefix', value: power_user.instruct.last_input_sequence || power_user.instruct.input_sequence, enabled: power_user.instruct.enabled },
        { key: 'systemPrompt', value: power_user.prefer_character_prompt && env.charPrompt ? env.charPrompt : power_user.sysprompt.content, enabled: power_user.sysprompt.enabled },
        { key: 'defaultSystemPrompt|instructSystem|instructSystemPrompt', value: power_user.sysprompt.content, enabled: power_user.sysprompt.enabled },
        { key: 'chatSeparator', value: power_user.context.example_separator, enabled: true },
        { key: 'chatStart', value: power_user.context.chat_start, enabled: true },
    ];
    const macros = [];
    for (const { key, value, enabled } of instructMacros) {
        const regex = new RegExp(`{{(${key})}}`, 'gi');
        const replace = () => enabled ? value : '';
        macros.push({ regex, replace });
    }
    return macros;
}
