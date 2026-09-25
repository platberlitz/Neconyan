import { roleplayError } from '../roleplay-store.js';
import { isDeepStrictEqual } from 'node:util';
import Handlebars from 'handlebars';
import { AGENT_REGEX_PLACEMENT, applyRegexScriptList } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';
import { selectToolHistoryReasoning } from '../../public/scripts/chat-input-capabilities.js';
import { shouldRetainContextAtDepth, stripHtmlTagsFromContext, stripOocBlocksFromContext } from '../../public/scripts/ooc-blocks.js';
import { formatRoleplayTextExamples } from '../../public/scripts/roleplay-text-format.js';
import { formatPromptReasoning } from '../../public/scripts/reasoning-prompt-format.js';
import { applyAgentHistoryRegex, prepareCompanionPromptHistory } from './agent-history.js';

const ROLES = ['system', 'user', 'assistant'];

/** A saved edit target changes the prompt view; its old text remains on disk until completion. */
export function selectRoleplayPromptRecords(records, source, effect) {
    const anchor = effect === 'replace' ? source.range?.start : source.message?.index;
    if (effect === 'append' || anchor === undefined) return records;
    if (!Number.isSafeInteger(anchor) || anchor < 0 || anchor >= records.length - 1) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved prompt target is outside its protected history.', 409);
    }
    return records.slice(0, anchor + (effect === 'continue' ? 2 : 1));
}

/** Apply saved prompt-only transformations before both lore scanning and memory budgeting. */
export function prepareRoleplayHistoryContent(records, snapshot, environment, agentHistory = {}) {
    const attachments = new Map(snapshot.attachments.map(item => [item.index, item.text]));
    let position = 0;
    const substitute = (value, overrides = {}, postProcess) => environment.evaluate(value, {
        legacy: !snapshot.experimentalMacroEngine, strictCapabilities: true,
        original: overrides.original, postProcess: overrides.postProcessFn ?? postProcess,
    });
    const global = { ...snapshot.global };
    let characterExamples = snapshot.characterExamples;
    let depthPrompts;
    if (snapshot.groupPrompt) {
        const group = snapshot.groupPrompt;
        const memberSubstitute = (value, member) => {
            const names = environment.names;
            environment.names = { ...names, char: member.name };
            try { return substitute(value).replace(/\r/g, ''); } finally { environment.names = names; }
        };
        const collect = (field, label) => group.members.filter(member => member.selected || !member.disabled || group.mode === 2)
            .map(member => {
                let value = member.fields[field].trim();
                if (!value) return '';
                if (field === 'mes_example' && !value.startsWith('<START>')) value = '<START>\n' + value;
                return [group.prefix, value, group.suffix].map(part => memberSubstitute(part.replace(/<FIELDNAME>/gi, label), member)).join('');
            }).filter(Boolean).join('\n');
        global.characterDescription = collect('description', 'Description');
        global.characterPersonality = collect('personality', 'Personality');
        if (!snapshot.metadata.scenario?.trim()) global.scenario = collect('scenario', 'Scenario');
        if (!snapshot.metadata.mes_example?.trim()) characterExamples = collect('mes_example', 'Example Messages');
        depthPrompts = group.members.filter(member => member.selected || !member.disabled).map(member => ({
            prompt: memberSubstitute(String(member.depth.prompt ?? '').trim(), member),
            depth: member.depth.depth ?? 4, role: member.depth.role ?? 'system',
        })).filter(prompt => prompt.prompt);
    }
    environment.character = { ...environment.character };
    for (const [field, macro] of Object.entries({ characterDescription: 'description', characterPersonality: 'personality',
        scenario: 'scenario', personaDescription: 'persona', characterDepthPrompt: 'charDepthPrompt', creatorNotes: 'creatorNotes' })) {
        if (typeof global[field] !== 'string') throw roleplayError('ROLEPLAY_INVALID', 'A saved character or persona field is invalid.', 409);
        global[field] = substitute(global[field]);
        environment.character[macro] = global[field];
    }
    const companionHistory = prepareCompanionPromptHistory(records, snapshot, environment, agentHistory);
    const visibleCount = records.slice(1).filter((record, index) => !record.is_system || record.extra?.tool_invocations || index === companionHistory.hostIndex).length;
    const worldInfoContent = [];
    const content = records.slice(1).map((record, index) => {
        if (record.is_system && !record.extra?.tool_invocations && index !== companionHistory.hostIndex) { worldInfoContent.push(''); return ''; }
        const depth = visibleCount - position++ - 1;
        const original = record.is_system && !record.extra?.tool_invocations ? '' : record.mes;
        const afterAgent = applyAgentHistoryRegex(original, record, agentHistory.scripts?.[index],
            depth - (snapshot.global.trigger === 'continue' ? 1 : 0), snapshot, environment);
        const transform = value => applyRegexScriptList(value, snapshot.regex,
            record.is_user ? AGENT_REGEX_PLACEMENT.USER_INPUT : AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
                isPrompt: true, depth: depth - (snapshot.global.trigger === 'continue' ? 1 : 0),
                characterOverride: snapshot.speakerNames.character,
                substituteParamsFn: substitute, substituteParamsExtendedFn: substitute,
            });
        const text = transform(afterAgent);
        const titles = record.is_system ? [] : [record.extra?.append_title && record.extra?.title,
            ...(record.extra?.media ?? []).map(media => media?.append_title && media.title)].filter(Boolean);
        const finish = value => stripHtmlTagsFromContext(stripOocBlocksFromContext((record.is_system ? '' : attachments.get(index) ?? '') + value
            + (titles.length ? `\n\n${titles.join('\n\n')}` : ''),
        shouldRetainContextAtDepth(depth, snapshot.contextRetention?.ooc)),
        shouldRetainContextAtDepth(depth, snapshot.contextRetention?.html));
        const retained = index === companionHistory.hostIndex ? companionHistory.entries : [];
        worldInfoContent.push([finish(afterAgent === original ? text : transform(original)), ...retained.map(item => item.worldInfoContent)].filter(Boolean).join('\n\n'));
        return [finish(text), ...retained.map(item => item.content)].filter(Boolean).join('\n\n');
    });
    const settings = { ...snapshot.reasoning, add_to_prompts: snapshot.reasoningInPrompt };
    if ((settings.add_to_prompts || snapshot.global.trigger === 'continue')
        && (!Number.isSafeInteger(settings.max_additions) || settings.max_additions < 0
            || ['prefix', 'separator', 'suffix'].some(key => typeof settings[key] !== 'string'))) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved reasoning prompt controls are invalid.', 409);
    }
    const visible = records.slice(1).map((record, index) => ({ record, index })).filter(({ record, index }) => !record.is_system
        && (content[index].trim() || record.extra?.media?.length || snapshot.global.trigger === 'continue' && index === content.length - 1));
    let state = { counter: 0 };
    for (let index = visible.length - 1; index >= 0; index--) {
        const row = visible[index];
        const continuing = snapshot.global.trigger === 'continue' && index === visible.length - 1;
        if (!snapshot.source.locator.group || row.record.name === snapshot.speakerNames.character) {
            const thought = applyRegexScriptList(String(row.record.extra?.reasoning ?? ''), snapshot.regex, AGENT_REGEX_PLACEMENT.REASONING, {
                isPrompt: true, depth: visible.length - index - (snapshot.global.trigger === 'continue' ? 2 : 1),
                characterOverride: snapshot.speakerNames.character, substituteParamsFn: substitute, substituteParamsExtendedFn: substitute,
            });
            const resolved = [];
            const result = formatPromptReasoning(content[row.index], thought, { settings, counter: state.counter,
                isPrefix: continuing, duration: row.record.extra?.reasoning_duration,
                substitute: value => { const text = substitute(value); resolved.push(text); return text; } });
            let resolvedIndex = 0;
            worldInfoContent[row.index] = formatPromptReasoning(worldInfoContent[row.index], thought, { settings, counter: state.counter,
                isPrefix: continuing, duration: row.record.extra?.reasoning_duration, substitute: () => resolved[resolvedIndex++] }).content;
            const { content: text, ...next } = result;
            content[row.index] = text;
            state = { ...state, ...next };
        }
        if (!settings.add_to_prompts || state.counter >= settings.max_additions) break;
    }
    const authorNote = { ...snapshot.authorNote, prompt: isWorldInfoAuthorNoteActive(snapshot.authorNote)
        ? substitute(activeRoleplayAuthorNote(snapshot.authorNote)) : '', scoped: null };
    const depthPrompt = { ...snapshot.depthPrompt, prompt: global.characterDepthPrompt };
    const inject = [];
    if (snapshot.noteScanEnabled) {
        inject.push(...(depthPrompts?.length ? depthPrompts : [depthPrompt]).map(prompt => prompt.prompt).filter(Boolean));
        if (authorNote.prompt) inject.push([snapshot.personaPosition === 2 ? global.personaDescription : '', authorNote.prompt,
            snapshot.personaPosition === 3 ? global.personaDescription : ''].filter(Boolean).join('\n'));
    }
    if (snapshot.personaPosition === 4 && global.personaDescription) inject.push(global.personaDescription);
    global.inject = inject;
    return { content, reasoning: state, global, characterExamples, authorNote, depthPrompt,
        ...(companionHistory.hostIndex >= 0 ? { companionHostIndex: companionHistory.hostIndex } : {}),
        ...(worldInfoContent.some((value, index) => value !== content[index]) ? { worldInfoContent } : {}),
        ...(depthPrompts?.length ? { depthPrompts } : {}) };
}

/** Macro inputs come from captured account sources, not a prepared page prompt. */
export function savedRoleplayMacroSnapshot(snapshot, records) {
    const names = snapshot.speakerNames;
    const group = snapshot.groupNames ?? [];
    return {
        chatId: snapshot.source.locator.chat,
        names: { user: names.user, char: names.character, group: group.join(', ') || names.character,
            groupNotMuted: (snapshot.unmutedGroupNames ?? group).join(', ') || names.character,
            notChar: [...group.filter(name => name !== names.character), names.user].join(', ') },
        character: { ...snapshot.characterFields, description: snapshot.global.characterDescription, personality: snapshot.global.characterPersonality,
            scenario: snapshot.global.scenario, persona: snapshot.global.personaDescription,
            charPrompt: snapshot.systemPrompt, charInstruction: snapshot.postHistory.character,
            mesExamplesRaw: snapshot.characterExamples, charDepthPrompt: snapshot.global.characterDepthPrompt,
            creatorNotes: snapshot.global.creatorNotes },
        variables: snapshot.promptVariables,
        extra: { chat: records.slice(1), chatMetadata: snapshot.metadata, powerUser: snapshot.promptSettings },
    };
}

export function roleplayMacroCapabilities(snapshot, material, maxTokens, maxContext, getEnvironment) {
    const substitute = value => getEnvironment().evaluate(value, { legacy: !snapshot.experimentalMacroEngine, strictCapabilities: true });
    const power = { ...snapshot.promptSettings, ...material?.power };
    const context = material?.context ?? power.context ?? {};
    const instruct = material?.instruct ?? power.instruct ?? {};
    return {
        getMaxResponseTokens: () => maxTokens, getMaxContextTokens: () => maxContext,
        getMaxPromptTokens: () => maxContext - maxTokens,
        parseMesExamples: (value, isInstruct) => !value || value === '<START>' ? []
            : (value.startsWith('<START>') ? value : '<START>\n' + value.trim()).split(/<START>/gi).slice(1)
                .map(block => (material?.backend === 'chat' || !material?.backend || isInstruct ? '<START>\n'
                    : context.example_separator ? substitute(context.example_separator) + '\n' : '') + block.trim() + '\n'),
        formatInstructModeExamples: (examples, user, char) => formatRoleplayTextExamples(examples, user, char, {
            instruct, context, group: snapshot.groupNames.length > 0, substitute,
            parseExamples: (value, group) => insertWorldInfoExamples([], [], value.replace('{Example Dialogue:}', '<START>'), 0,
                user, char, group ? snapshot.groupNames : []),
        }),
    };
}

export const isWorldInfoAuthorNoteActive = note => note?.interval === 1
    || note?.interval > 1 && note.userMessages > 0 && note.userMessages % note.interval === 0;

/** Resolve the saved note once for both World Info scanning and prompt placement. */
export function activeRoleplayAuthorNote(note) {
    if (!isWorldInfoAuthorNoteActive(note)) return '';
    let prompt = note.prompt;
    const scoped = note.scoped;
    if (scoped?.useChara) {
        if (typeof scoped.prompt !== 'string' || ![0, 1, 2].includes(Number(scoped.position))) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved character Author\'s Note is invalid.', 409);
        }
        prompt = Number(scoped.position) === 1 ? [scoped.prompt, prompt].filter(Boolean).join('\n')
            : Number(scoped.position) === 2 ? [prompt, scoped.prompt].filter(Boolean).join('\n') : scoped.prompt;
    }
    return prompt;
}

/** Render named lore only where the saved story template explicitly requests it. */
export function insertWorldInfoOutlets(messages, outlets, snapshot, historyStart, userName, characterName, before = '', after = '', forceStory = false) {
    if (!outlets || typeof outlets !== 'object' || Array.isArray(outlets)
        || typeof snapshot?.storyTemplate !== 'string' || snapshot.storyPosition !== 0
        || !Number.isSafeInteger(historyStart) || historyStart !== 0
        || typeof userName !== 'string' || typeof characterName !== 'string'
        || typeof before !== 'string' || typeof after !== 'string') {
        throw roleplayError('ROLEPLAY_INVALID', 'Named World Info outlets need a saved story template.', 409);
    }
    const fields = Object.create(null);
    for (const [name, entries] of Object.entries(outlets)) {
        if (!/^[\w-]{1,128}$/.test(name) || !Array.isArray(entries) || entries.some(value => typeof value !== 'string')
            || !snapshot.storyTemplate.includes(`{{outlet::${name}}}`)) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved story template does not contain this World Info outlet.', 409);
        }
        fields[`outlet::${name}`] = entries.join('\n');
    }
    if (!Object.keys(fields).length && !before && !after && !forceStory) return messages;
    const global = snapshot.global;
    if ((before && !['wiBefore', 'loreBefore'].some(name => snapshot.storyTemplate.includes(`{{${name}}}`)))
        || (after && !['wiAfter', 'loreAfter'].some(name => snapshot.storyTemplate.includes(`{{${name}}}`)))) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved story template does not place its selected World Info.', 409);
    }
    let rendered;
    try {
        const allowed = new Set(['description', 'personality', 'scenario', 'persona', 'user', 'char',
            'system', 'wiBefore', 'wiAfter', 'loreBefore', 'loreAfter', ...Object.keys(fields).map(key => `outlet::${key.slice(8)}`)]);
        const verify = program => {
            for (const statement of program.body) {
                if (statement.type === 'ContentStatement') continue;
                if (statement.type === 'MustacheStatement' && !statement.params.length
                    && allowed.has(statement.path.original)) continue;
                if (statement.type === 'BlockStatement' && statement.path.original === 'if'
                    && statement.params.length === 1 && allowed.has(statement.params[0].original)
                    && !statement.inverse) { verify(statement.program); continue; }
                throw new Error('Unsupported story template expression');
            }
        };
        verify(Handlebars.parse(snapshot.storyTemplate));
        rendered = Handlebars.compile(snapshot.storyTemplate, { noEscape: true })({ ...fields,
            description: global.characterDescription, personality: global.characterPersonality,
            scenario: global.scenario, persona: global.personaDescription, user: userName, char: characterName,
            system: snapshot.systemPrompt ?? '',
            wiBefore: before, wiAfter: after, loreBefore: before, loreAfter: after });
    } catch {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved story template needs unsupported prompt macros.', 409);
    }
    if (!rendered) throw roleplayError('ROLEPLAY_INVALID', 'The saved story template did not place its World Info outlet.', 409);
    return [{ role: 'system', content: rendered }, ...messages];
}

/** Place saved Chat Completion system slots in their bound prompt-manager order. */
export function insertRoleplayChatSystem(messages, snapshot, material, userName, characterName, before = '', after = '', effect = 'append') {
    const controls = material?.preset ?? material?.active;
    const order = controls?.prompt_order?.find(value => String(value?.character_id) === '100001')?.order;
    const prompts = controls?.prompts;
    const supported = new Set(['main', 'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality',
        'scenario', 'enhanceDefinitions', 'nsfw', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak']);
    if (material?.backend && material.backend !== 'chat' || !Array.isArray(order) || !Array.isArray(prompts)
        || order.some(value => !supported.has(value?.identifier))
        || new Set(order.map(value => value.identifier)).size !== order.length
        || new Set(prompts.map(value => value?.identifier)).size !== prompts.length
        || !order.some(value => value.identifier === 'chatHistory' && value.enabled === true)) {
        throw roleplayError('ROLEPLAY_INVALID', 'This Chat Completion prompt needs server-side prompt-manager ordering.', 409);
    }
    const historyIndex = order.findIndex(value => value.identifier === 'chatHistory');
    if (order.slice(historyIndex + 1).some(value => value?.enabled && value.identifier !== 'jailbreak')
        || order.slice(0, historyIndex).some(value => value?.enabled && value.identifier === 'jailbreak')
        || order.some(value => value.identifier === 'dialogueExamples' && value.enabled
            && order.indexOf(value) !== historyIndex - 1)
        || typeof userName !== 'string' || typeof characterName !== 'string') {
        throw roleplayError('ROLEPLAY_INVALID', 'This Chat Completion prompt order cannot be placed by the server.', 409);
    }
    const contentById = { worldInfoBefore: before, worldInfoAfter: after,
        personaDescription: snapshot.global.personaDescription,
        charDescription: snapshot.global.characterDescription,
        charPersonality: snapshot.global.characterPersonality,
        scenario: snapshot.global.scenario };
    const prefix = [];
    const trigger = effect === 'append' ? 'normal' : effect === 'replace' ? 'regenerate' : effect;
    for (const value of order.slice(0, historyIndex)) {
        if (!value.enabled) continue;
        const prompt = prompts.find(item => item?.identifier === value.identifier);
        if (!prompt || prompt.injection_position != null || prompt.role && prompt.role !== 'system'
            || prompt.system_prompt !== true) {
            throw roleplayError('ROLEPLAY_INVALID', 'This Chat Completion prompt cannot be placed by the server.', 409);
        }
        if (Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.length
            && !prompt.injection_trigger.includes(trigger)) continue;
        if (value.identifier === 'dialogueExamples') {
            if (!prompt.marker) throw roleplayError('ROLEPLAY_INVALID', 'This Chat Completion example marker is invalid.', 409);
            continue;
        }
        if (value.identifier === 'personaDescription' && contentById.personaDescription && snapshot.personaPosition !== undefined
            && snapshot.personaPosition !== 0) {
            if (snapshot.personaPosition === 9) continue;
            throw roleplayError('ROLEPLAY_INVALID', 'This persona description needs its saved depth or note position.', 409);
        }
        let content = value.identifier === 'main' && snapshot.systemPrompt && prompt.forbid_overrides !== true
            ? snapshot.systemPrompt : Object.hasOwn(contentById, value.identifier)
                ? contentById[value.identifier] : prompt.content;
        if (typeof content !== 'string') {
            throw roleplayError('ROLEPLAY_INVALID', 'This saved prompt needs unsupported prompt macros.', 409);
        }
        if (value.identifier === 'charPersonality' && content) {
            content = controls.personality_format?.replaceAll('{{personality}}', content) ?? content;
        } else if (value.identifier === 'scenario' && content) {
            content = controls.scenario_format?.replaceAll('{{scenario}}', content) ?? content;
        } else if (['worldInfoBefore', 'worldInfoAfter'].includes(value.identifier) && content
            && typeof controls.wi_format === 'string' && controls.wi_format.trim()) {
            content = controls.wi_format.replace(/\{(\d+)\}/g, (match, index) => index === '0' ? content : match);
        }
        if (content.replaceAll('{{char}}', '').replaceAll('{{user}}', '').includes('{{')) {
            throw roleplayError('ROLEPLAY_INVALID', 'This saved prompt needs unsupported prompt macros.', 409);
        }
        content = content.replaceAll('{{char}}', characterName).replaceAll('{{user}}', userName);
        if (content.includes('{{')) throw roleplayError('ROLEPLAY_INVALID', 'This saved prompt needs unsupported prompt macros.', 409);
        if (content) prefix.push({ role: 'system', content });
    }
    const historyMarker = prompts.find(value => value?.identifier === 'chatHistory');
    if (!historyMarker?.marker || historyMarker.system_prompt !== true) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved chat history marker is invalid.', 409);
    }
    return [...prefix, ...messages];
}

/** Depth positions may use only an exact plain-text suffix of the protected chat. */
export function assertWorldInfoDepthHistory(records, messages, historyStart, options = {}) {
    if (!Array.isArray(records) || !Array.isArray(messages) || !Number.isSafeInteger(historyStart)
        || historyStart < 0 || historyStart > messages.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'World Info needs a saved chat history boundary for depth insertion.', 409);
    }
    const history = buildPromptHistory(records, options);
    const selected = messages.slice(historyStart);
    if (!selected.length || selected.length > history.length || !isDeepStrictEqual(selected, history.slice(-selected.length))) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'World Info depth history differs from the protected chat.', 409);
    }
}

function buildPromptHistory(records, { reasoningInPrompt = false, reasoning = null, regex = [], characterName,
    group = false, userName = records[0]?.user_name, namesBehavior, attachments = [], images = [], imageDetail = 'auto', mediaDisplay = 'list', toolHistory = false, toolSource = '', toolModel = '', signaturePolicy, preparedContent, companionHostIndex } = {}) {
    if (preparedContent !== undefined && (!Array.isArray(preparedContent) || preparedContent.length !== records.length - 1
        || preparedContent.some(value => typeof value !== 'string'))) {
        throw roleplayError('ROLEPLAY_INVALID', 'The prepared saved history is invalid.', 409);
    }
    if (group && ![-1, 0, 1, 2, 'provider'].includes(namesBehavior)) {
        throw roleplayError('ROLEPLAY_INVALID', 'This group naming policy needs server-side provider formatting.', 409);
    }
    if (!Array.isArray(attachments) || attachments.some(item => !item || !Number.isSafeInteger(item.index)
        || item.index < 0 || item.index >= records.length - 1 || typeof item.text !== 'string')) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay file attachments are invalid.', 409);
    }
    if (!Array.isArray(images) || images.some(item => !item || !Number.isSafeInteger(item.index)
        || item.index < 0 || item.index >= records.length - 1 || typeof item.url !== 'string'
        || !(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(item.url)
            || item.captionOnly === true && /^video\/(?:mp4|webm|quicktime|mpeg|ogg)$/.test(item.mimeType)
                && /^[a-f0-9]{64}$/.test(item.rawHash) && typeof item.file === 'string')
        || item.captionOnly !== undefined && typeof item.captionOnly !== 'boolean')
        || !['low', 'auto', 'high'].includes(imageDetail)) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay images are invalid.', 409);
    }
    const sameProvider = record => record.extra?.api === signaturePolicy?.source && record.extra?.model === signaturePolicy?.model;
    const reasoningMessages = records.slice(1).map(record => ({
        role: record.is_system && !record.extra?.tool_invocations ? 'tool' : record.is_user ? 'user' : 'assistant',
        content: record.mes, invocations: record.extra?.tool_invocations,
        reasoning: sameProvider(record) ? record.extra?.reasoning : '',
    }));
    const lastUser = reasoningMessages.findLastIndex(message => message.role === 'user');
    const history = records.slice(1).map((record, index) => {
        if (record.extra?.tool_invocations !== undefined) {
            const calls = record.extra.tool_invocations;
            if (!toolHistory || !Array.isArray(calls) || !calls.length || calls.length > 32
                || record.is_system !== true || record.is_user !== false || typeof record.mes !== 'string'
                || !signaturePolicy && (record.extra.api !== toolSource || record.extra.model !== toolModel)
                || Object.keys(record).some(key => !['name', 'force_avatar', 'is_system', 'is_user', 'mes', 'extra', 'send_date', 'mewmory_id'].includes(key))
                || Object.keys(record.extra).some(key => !['isSmallSys', 'tool_invocations', 'api', 'model'].includes(key))
                || calls.some(call => !call || typeof call.id !== 'string' || !call.id || call.id.length > 256
                    || typeof call.name !== 'string' || !call.name || call.name.length > 256
                    || typeof call.parameters !== 'string' || typeof call.result !== 'string'
                    || !signaturePolicy && (call.signature || call.reasoning)
                    || call.signature != null && typeof call.signature !== 'string'
                    || call.reasoning != null && typeof call.reasoning !== 'string')
                || new Set(calls.map(call => call.id)).size !== calls.length) {
                throw roleplayError('ROLEPLAY_INVALID', 'This saved tool history needs a bound tool-capable connection.', 409);
            }
            const thought = sameProvider(record) && index > lastUser && ['active_chain', 'since_last_user'].includes(signaturePolicy?.reasoning)
                ? selectToolHistoryReasoning(reasoningMessages, index, lastUser, signaturePolicy.reasoning)
                    || calls.find(call => call.reasoning)?.reasoning : '';
            return [{ role: 'assistant', tool_calls: calls.map(call => ({ id: call.id, type: 'function',
                function: { name: call.name, arguments: call.parameters },
                ...(signaturePolicy?.include && sameProvider(record) && call.signature ? { signature: call.signature } : {}) })),
            ...(thought ? { reasoning: thought } : {}) },
            ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: call.result || '[No content]' }))];
        }
        if (record.is_system === true) {
            if (index !== companionHostIndex || !preparedContent?.[index]) return [];
            record = { name: record.name, is_user: false, mes: '', extra: {} };
        }
        const attachment = attachments.find(item => item.index === index);
        const selectedImages = images.filter(item => item.index === index);
        const media = record.extra?.media;
        if (typeof record.mes !== 'string' || typeof record.is_user !== 'boolean'
            || group && (typeof record.name !== 'string' || !record.name)
            || record.is_system !== undefined && typeof record.is_system !== 'boolean'
            || Object.keys(record).some(key => !['name', 'is_user', 'is_system', 'is_name', 'mes', 'swipes', 'swipe_id', 'swipe_info',
                'extra', 'send_date', 'title', 'gen_started', 'gen_finished', 'mewmory_id', 'force_avatar', 'original_avatar'].includes(key))
            || (record.extra && (typeof record.extra !== 'object' || Array.isArray(record.extra)
                 || Object.keys(record.extra).some(key => !['token_count', 'isSmallSys', 'reasoning', 'files', 'fileLength',
                     'media', 'media_index', 'media_display', 'inline_image', 'api', 'model', 'reasoning_effort',
                     'reasoning_duration', 'reasoning_signature', 'reasoning_tokens', 'time_to_first_token', 'gen_id', 'type',
                     'inChatAgentPostRuns', 'inChatAgents', 'inChatAgentPromptRuns', 'inChatAgentTransformHistory', 'inChatAgentTransformRedo',
                     'inChatAgentPreGenerationInterceptHistory', 'inChatAgentCompanionResults',
                     'title', 'append_title', 'bias', 'display_text', 'reasoning_display_text', 'server_narration'].includes(key))
                 || record.extra.bias != null && typeof record.extra.bias !== 'string'
                 || record.extra.title != null && typeof record.extra.title !== 'string'
                  || record.extra.append_title != null && typeof record.extra.append_title !== 'boolean'
                  || ['display_text', 'reasoning_display_text'].some(key => record.extra[key] != null && typeof record.extra[key] !== 'string')
                  || record.extra.server_narration != null && (typeof record.extra.server_narration !== 'object' || Array.isArray(record.extra.server_narration))
                  || record.extra.inChatAgents != null && (typeof record.extra.inChatAgents !== 'object' || Array.isArray(record.extra.inChatAgents))
                   || record.extra.inChatAgentCompanionResults != null && (typeof record.extra.inChatAgentCompanionResults !== 'object' || Array.isArray(record.extra.inChatAgentCompanionResults))
                   || ['inChatAgentPromptRuns', 'inChatAgentTransformHistory', 'inChatAgentTransformRedo', 'inChatAgentPreGenerationInterceptHistory']
                       .some(key => record.extra[key] != null && !Array.isArray(record.extra[key]))
                 || record.extra.inChatAgentPostRuns !== undefined && (!Array.isArray(record.extra.inChatAgentPostRuns)
                     || record.extra.inChatAgentPostRuns.some(value => typeof value !== 'string'))
                 || record.extra.reasoning_signature && (!signaturePolicy || typeof record.extra.reasoning_signature !== 'string')
                 || record.extra.type !== undefined && record.extra.type !== 'narrator'
                 || record.extra.files !== undefined && (!Array.isArray(record.extra.files) || !attachment)
                 || attachment && !Array.isArray(record.extra.files)
                 || media !== undefined && (!Array.isArray(media) || !media.length
                     || selectedImages.length !== ((record.extra.media_display ?? mediaDisplay) === 'gallery' ? 1 : media.length))
                 || selectedImages.length && !Array.isArray(media)
                 || ['media_index', 'media_display', 'inline_image'].some(key => record.extra[key] !== undefined && !Array.isArray(media))
                 || record.extra.fileLength !== undefined && (!Number.isSafeInteger(record.extra.fileLength)
                    || record.extra.fileLength < 0 || record.extra.fileLength > record.mes.length)
                || record.extra.reasoning !== undefined && typeof record.extra.reasoning !== 'string'))) {
            throw roleplayError('ROLEPLAY_INVALID', 'This saved chat needs server handling for its non-text content.', 409);
        }
        if (preparedContent !== undefined && !preparedContent[index].trim() && !selectedImages.length) return [];
        return { role: record.extra?.type === 'narrator' ? 'system' : record.is_user ? 'user' : 'assistant',
            content: preparedContent?.[index] ?? (attachment?.text ?? '') + record.mes,
            ...(signaturePolicy?.include && sameProvider(record) && record.extra?.reasoning_signature
                ? { signature: record.extra.reasoning_signature } : {}) };
    });
    if (preparedContent === undefined && reasoningInPrompt && records.some(record => record.extra?.reasoning)) {
        if (!reasoning || !Number.isSafeInteger(reasoning.max_additions) || reasoning.max_additions < 0
            || !Array.isArray(regex) || regex.some(script => script?.placement?.includes(AGENT_REGEX_PLACEMENT.REASONING)
                && !script.disabled && script.promptOnly && !script.markdownOnly)
            || ['prefix', 'suffix', 'separator'].some(key => typeof reasoning[key] !== 'string'
                || reasoning[key].includes('{{') || /<(?:USER|BOT|CHAR|GROUP)>/i.test(reasoning[key]))) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved reasoning prompt settings need server-side macro handling.', 409);
        }
        let added = 0;
        for (let index = history.length - 1; index >= 0 && added < reasoning.max_additions; index--) {
            const record = records[index + 1];
            if (Array.isArray(history[index])) continue;
            if (group && record.name !== characterName) continue;
            const thought = record.extra?.reasoning;
            if (!thought || thought === '\u200B') continue;
            history[index].content = `${reasoning.prefix}${thought}${reasoning.suffix}${reasoning.separator}${history[index].content}`;
            added++;
        }
    }
    if (group || namesBehavior !== undefined) for (let index = 0; index < history.length; index++) {
        if (Array.isArray(history[index])) continue;
        const name = records[index + 1].name;
        if (namesBehavior === 'provider' && name) {
            history[index].name = name;
        } else if (namesBehavior === 1 && name) {
            const wireName = name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
            if (!wireName) throw roleplayError('ROLEPLAY_INVALID', 'The saved group speaker cannot be named by this provider.', 409);
            history[index].name = wireName;
        } else if (namesBehavior === 2 && history[index].role !== 'system'
            || namesBehavior === 0 && name !== userName && (group || records[index + 1].force_avatar && history[index].role !== 'system')) {
            history[index].content = `${name}: ${history[index].content}`;
        }
    }
    for (const [index, message] of history.entries()) {
        if (Array.isArray(message)) continue;
        const selectedImages = images.filter(item => item.index === index && !item.captionOnly);
        if (selectedImages.length) message.content = [{ type: 'text', text: message.content }, ...selectedImages.map(item => ({
            type: 'image_url', image_url: { url: item.url, detail: imageDetail },
        }))];
    }
    return history.flat();
}

/** Derive the plain-text history from the protected chat, rather than an accepted page payload. */
export function buildRoleplaySavedHistory(records, options) {
    if (!Array.isArray(records) || !records.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'A saved Roleplay chat is required for prompt construction.', 409);
    }
    if (records.length === 1) return [];
    return buildPromptHistory(records, options);
}

/** Place saved depth entries within the captured history, never among system prompts. */
export function insertWorldInfoDepth(messages, entries, historyStart) {
    if (!Number.isSafeInteger(historyStart) || historyStart < 0 || historyStart > messages.length
        || !Array.isArray(entries) || entries.some(value => !value || !Number.isSafeInteger(value.depth)
            || value.depth < 0 || value.depth > 10000 || !Number.isInteger(value.role) || !ROLES[value.role]
            || !Array.isArray(value.entries) || value.entries.some(text => typeof text !== 'string'))) {
        throw roleplayError('ROLEPLAY_INVALID', 'World Info needs a saved chat history boundary for depth insertion.', 409);
    }
    const prefix = messages.slice(0, historyStart);
    const history = messages.slice(historyStart).reverse();
    let inserted = 0;
    for (const depth of [...new Set(entries.map(value => value.depth))].sort((a, b) => a - b)) {
        const injections = ROLES.flatMap((role, index) => entries
            .filter(value => value.depth === depth && value.role === index)
            .map(value => ({ role, content: value.entries.join('\n') })).filter(value => value.content));
        history.splice(depth + inserted, 0, ...injections);
        inserted += injections.length;
    }
    return [...prefix, ...history.reverse()];
}

/** Keep saved card examples between lore's before/after example blocks. */
export function insertWorldInfoExamples(messages, entries, cardExamples, historyStart, userName, characterName, groupNames = [], { blocksOnly = false } = {}) {
    if (!Number.isSafeInteger(historyStart) || historyStart < 0 || historyStart > messages.length
        || typeof cardExamples !== 'string' || typeof userName !== 'string' || !userName
        || typeof characterName !== 'string' || !characterName || !Array.isArray(groupNames)
        || groupNames.some(name => typeof name !== 'string')
        || !Array.isArray(entries) || entries.some(item => !item || ![0, 1].includes(item.position)
            || typeof item.content !== 'string')
        || messages.slice(0, historyStart).some(item => ['example_user', 'example_assistant'].includes(item?.name))) {
        throw roleplayError('ROLEPLAY_INVALID', 'World Info examples need a saved card and an unambiguous history boundary.', 409);
    }
    const blocks = text => text ? (text.startsWith('<START>') ? text : `<START>\n${text.trim()}`)
        .split(/<START>/gi).slice(1).map(block => block.trim()) : [];
    const parse = text => blocks(text).map(block => {
        const lines = (`<START>\n${block}`).split('\n').slice(1);
        const result = [];
        let current;
        const flush = () => {
            if (!current) return;
            const content = current.lines.join('\n').replace(current.name + ':', '').trim();
            result.push({ role: 'system', content: groupNames.length ? `${current.name}: ${content}` : content,
                name: current.name === userName ? 'example_user' : 'example_assistant' });
        };
        for (const line of lines) {
            const speaker = [userName, characterName, ...groupNames].find(name => line.startsWith(name + ':'));
            if (speaker && speaker !== current?.name) { flush(); current = { name: speaker, lines: [] }; }
            if (current) current.lines.push(line);
        }
        flush();
        return result;
    });
    const before = entries.filter(item => item.position === 0).reverse().flatMap(item => parse(item.content));
    const after = entries.filter(item => item.position === 1).flatMap(item => parse(item.content));
    const examples = [...before, ...parse(cardExamples), ...after].filter(block => block.length);
    return blocksOnly ? examples : [...messages.slice(0, historyStart), ...examples.flat(), ...messages.slice(historyStart)];
}

/** Browser Author's Note timing comes from saved chat metadata and saved extension defaults. */
export function insertWorldInfoAuthorNote(messages, before, after, note, historyStart, storyBound = false) {
    if (!Array.isArray(before) || !Array.isArray(after) || [...before, ...after].some(value => typeof value !== 'string')
        || !note || typeof note.prompt !== 'string' || !Number.isSafeInteger(note.interval)
        || !Number.isSafeInteger(note.depth) || note.depth < 0 || note.depth > 10000
        || ![0, 1, 2].includes(note.position) || ![0, 1, 2].includes(note.role)
        || !Number.isSafeInteger(note.userMessages) || note.userMessages < 0
        || !Number.isSafeInteger(historyStart) || historyStart < 0 || historyStart > messages.length) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Author\'s Note cannot be placed in this prompt.', 409);
    }
    if (!before.length && !after.length) return messages;
    if (!isWorldInfoAuthorNoteActive(note)) return messages;
    const prompt = activeRoleplayAuthorNote(note);
    const content = [...before, prompt, ...after].join('\n').replace(/(^\n)|(\n$)/g, '');
    if (!content) return messages;
    if (note.position === 1) {
        return insertWorldInfoDepth(messages, [{ depth: note.depth, role: note.role, entries: [content] }], historyStart);
    }
    if (!storyBound || historyStart < 1 || messages[0]?.role !== 'system') {
        throw roleplayError('ROLEPLAY_INVALID', 'This Author\'s Note position needs a bound story prompt.', 409);
    }
    const injection = { role: ROLES[note.role], content };
    return note.position === 2 ? [injection, ...messages] : [messages[0], injection, ...messages.slice(1)];
}

/** Text completion puts saved post-history instructions after chat, except before a continued reply. */
export function insertRoleplayPostHistory(messages, saved, backend, effect, material, userName = '', characterName = '') {
    if (!saved || typeof saved.character !== 'string' || typeof saved.text !== 'string'
        || typeof saved.textEnabled !== 'boolean') {
        throw roleplayError('ROLEPLAY_INVALID', 'Saved post-history instructions are invalid.', 409);
    }
    if (backend === 'chat') {
        const controls = material?.preset ?? material?.active;
        const order = controls?.prompt_order?.find(value => String(value?.character_id) === '100001')?.order;
        const prompt = controls?.prompts?.find(value => value?.identifier === 'jailbreak');
        if (!Array.isArray(order) || !Array.isArray(controls?.prompts)) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved Chat Completion prompt order is unavailable.', 409);
        }
        const position = order.findIndex(value => value?.identifier === 'jailbreak');
        if (position < 0 || order[position].enabled !== true) return messages;
        const history = order.findIndex(value => value?.identifier === 'chatHistory');
        if (!prompt || history < 0 || history >= position || order[history].enabled !== true
            || order.slice(history + 1).some(value => value?.enabled && value.identifier !== 'jailbreak')
            || prompt.role !== 'system' || prompt.system_prompt !== true || prompt.injection_position != null) {
            throw roleplayError('ROLEPLAY_INVALID', 'This Chat Completion post-history instruction needs full prompt-manager ordering.', 409);
        }
        const trigger = effect === 'append' ? 'normal' : effect === 'replace' ? 'regenerate' : effect;
        if (Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.length
            && !prompt.injection_trigger.includes(trigger)) return messages;
        const instruction = saved.character.trim() && prompt.forbid_overrides !== true ? saved.character : prompt.content;
        if (typeof instruction !== 'string' || instruction.replaceAll('{{char}}', '').replaceAll('{{user}}', '').includes('{{')
            || /<(?:USER|BOT|CHAR|GROUP)>/i.test(instruction)) {
            throw roleplayError('ROLEPLAY_INVALID', 'This Chat Completion post-history instruction needs full prompt-manager ordering.', 409);
        }
        const content = instruction.replaceAll('{{char}}', characterName).replaceAll('{{user}}', userName).trim();
        return content ? [...messages, { role: 'system', content }] : messages;
    }
    if (!['text', 'kobold', 'novel', 'horde'].includes(backend)) {
        throw roleplayError('ROLEPLAY_INVALID', 'This connection cannot place saved post-history instructions.', 409);
    }
    if (!saved.textEnabled) return messages;
    const instruction = saved.character.trim() || saved.text.trim();
    if (!instruction) return messages;
    if (instruction.includes('{{') || /<(?:USER|BOT|CHAR|GROUP)>/i.test(instruction)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Saved post-history macros need server-side prompt substitution.', 409);
    }
    if (effect === 'continue' && messages.at(-1)?.role !== 'assistant') {
        throw roleplayError('ROLEPLAY_INVALID', 'Continuation instructions need the saved assistant reply at the end of the prompt.', 409);
    }
    const position = effect === 'continue' ? messages.length - 1 : messages.length;
    return [...messages.slice(0, position), { role: 'user', content: instruction }, ...messages.slice(position)];
}

/** Resolve saved static extension prompts once for both provider families. */
export function buildRoleplayPromptExtensions(snapshot, worldInfo, render = value => value, contributions = []) {
    const extensions = [];
    const addExtension = (key, content, position, depth, role) => {
        if (!content) return;
        if (![0, 1, 2].includes(position) || !Number.isSafeInteger(depth) || depth < 0 || depth > 10000
            || !ROLES.includes(role)) throw roleplayError('ROLEPLAY_INVALID', 'A saved extension prompt position is invalid.', 409);
        extensions.push({ key, content: render(content), position, depth, role });
    };
    const note = snapshot.authorNote;
    let noteText = note ? activeRoleplayAuthorNote(note) : '';
    if (note && isWorldInfoAuthorNoteActive(note)) {
        noteText = [snapshot.personaPosition === 2 ? snapshot.global.personaDescription : '',
            ...worldInfo.ANBeforeEntries, noteText, ...worldInfo.ANAfterEntries,
            snapshot.personaPosition === 3 ? snapshot.global.personaDescription : ''].filter(Boolean).join('\n');
        addExtension('2_floating_prompt', noteText, note.position, note.depth, ROLES[note.role]);
    }
    if (snapshot.personaPosition === 4) {
        addExtension('PERSONA_DESCRIPTION', snapshot.global.personaDescription, 1, snapshot.personaDepth, ROLES[snapshot.personaRole]);
    }
    for (const [index, prompt] of (snapshot.depthPrompts ?? (snapshot.depthPrompt ? [snapshot.depthPrompt] : [])).entries()) {
        addExtension(snapshot.depthPrompts ? `DEPTH_PROMPT_${index}` : 'DEPTH_PROMPT', prompt.prompt, 1, prompt.depth, prompt.role);
    }
    for (const [index, entry] of worldInfo.WIDepthEntries.entries()) {
        addExtension(`worldInfoDepth${index}`, entry.entries.join('\n'), 1, entry.depth, ROLES[entry.role]);
    }
    for (const prompt of contributions) {
        if (extensions.some(existing => existing.key === prompt.key)) {
            throw roleplayError('ROLEPLAY_INVALID', 'A saved contributor cannot replace a protected prompt slot.', 409);
        }
        extensions.push({ ...prompt });
    }
    return extensions;
}
