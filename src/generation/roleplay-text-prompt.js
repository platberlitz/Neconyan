import Handlebars from 'handlebars';
import { renderRoleplayStory, formatRoleplayTextMessage, formatRoleplayTextExamples, combineRoleplayTextPrompt } from '../../public/scripts/roleplay-text-format.js';
import { FORCE_OUTPUT_SEQUENCE, formatInstructModePrompt, formatInstructModeStoryString } from '../../public/scripts/instruct-format.js';
import { buildRoleplayPromptExtensions, insertWorldInfoExamples } from './roleplay-prompt.js';
import { roleplayError } from '../roleplay-store.js';

/** Render the final saved text-completion prompt before provider work or token fitting. */
export function createRoleplayTextPrompt(history, snapshot, material, worldInfo, {
    userName, characterName, groupNames = [], effect = 'append', substitute = value => value,
    substituteHistory = value => value, memory,
} = {}) {
    const context = material.context ?? material.power?.context ?? {
        story_string: snapshot.storyTemplate, story_string_position: snapshot.storyPosition,
    };
    const instruct = { ...(material.instruct ?? material.power?.instruct),
        enabled: material.backend !== 'novel' && Boolean(material.instruct?.enabled ?? material.power?.instruct?.enabled) };
    const format = { instruct, userName, characterName, group: groupNames.length > 0, substitute };
    const extensions = buildRoleplayPromptExtensions(snapshot, worldInfo, substitute).sort((a, b) => a.key.localeCompare(b.key));
    const rawExamples = [...worldInfo.EMEntries.filter(entry => entry.position === 0).reverse().map(entry => entry.content),
        snapshot.characterExamples, ...worldInfo.EMEntries.filter(entry => entry.position === 1).map(entry => entry.content)]
        .filter(Boolean).flatMap(text => substitute(text).split(/<START>/gi).filter(value => value.trim()).map(value => `<START>\n${value.trim()}\n`));
    let examples = instruct.enabled ? formatRoleplayTextExamples(rawExamples, userName, characterName, { instruct, context,
        group: groupNames.length > 0, substitute: value => substitute(value),
        parseExamples: (text, group) => insertWorldInfoExamples([], [], text.replace('{Example Dialogue:}', '<START>'), 0,
            userName, characterName, group ? groupNames : []),
    }) : rawExamples.map(value => value.replace(/<START>\n/i, context.example_separator ? `${substitute(context.example_separator)}\n` : ''));
    const systemSettings = material.power?.sysprompt;
    const system = systemSettings?.enabled === false ? '' : snapshot.systemPrompt || systemSettings?.content || '';
    const params = { description: substitute(snapshot.global.characterDescription), personality: substitute(snapshot.global.characterPersonality),
        scenario: substitute(snapshot.global.scenario), persona: snapshot.personaPosition === 0 ? substitute(snapshot.global.personaDescription) : '',
        system: substitute(system), char: characterName, user: userName,
        wiBefore: worldInfo.worldInfoBefore, wiAfter: worldInfo.worldInfoAfter,
        loreBefore: worldInfo.worldInfoBefore, loreAfter: worldInfo.worldInfoAfter,
        anchorBefore: extensions.filter(prompt => prompt.position === 2).map(prompt => prompt.content).join('\n').trim(),
        anchorAfter: extensions.filter(prompt => prompt.position === 0).map(prompt => prompt.content).join('\n').trim(),
        mesExamples: examples.join(''), mesExamplesRaw: rawExamples.join(''),
        ...Object.fromEntries(Object.entries(worldInfo.outletEntries).map(([key, entries]) => [`outlet::${key}`, entries.join('\n')])),
    };
    let story;
    try {
        story = renderRoleplayStory(params, { template: context.story_string ?? '', context, instruct,
            compile: (template, options) => Handlebars.compile(template, options), substitute });
    } catch {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved story template cannot be rendered on the server.', 409);
    }
    if (instruct.enabled) story = formatInstructModeStoryString(story, { customContext: context, customInstruct: instruct, substitute });
    if (context.story_string_position === 1 && story) {
        extensions.push({ content: story, position: 1, depth: context.story_string_depth ?? 1,
            role: ['system', 'user', 'assistant'][context.story_string_role ?? 0] });
        story = '';
    }
    if (memory?.enabled) {
        const memoryText = [memory.npcText, memory.memoryText].filter(Boolean).join('\n\n');
        if (memoryText) story += '\n\n' + (instruct.enabled
            ? formatInstructModeStoryString(memoryText, { customContext: context, customInstruct: instruct, substitute }) : memoryText);
    }
    const injected = history.map(message => ({ ...substituteHistory(message), source: message })).reverse();
    let inserted = 0;
    for (const depth of [...new Set(extensions.filter(prompt => prompt.position === 1).map(prompt => prompt.depth))].sort((a, b) => a - b)) {
        const prompts = ['system', 'user', 'assistant'].flatMap(role => {
            const content = extensions.filter(prompt => prompt.position === 1 && prompt.depth === depth && prompt.role === role)
                .map(prompt => prompt.content.trim()).join('\n');
            return content ? [{ role, content }] : [];
        });
        injected.splice(Math.min((effect === 'continue' && depth === 0 ? 1 : depth) + inserted, injected.length), 0, ...prompts);
        inserted += prompts.length;
    }
    injected.reverse();
    const postHistory = snapshot.postHistory.textEnabled ? substitute(snapshot.postHistory.character || snapshot.postHistory.text) : '';
    if (postHistory) injected.splice(effect === 'continue' ? Math.max(0, injected.length - 1) : injected.length, 0,
        { role: 'user', content: postHistory });
    const lastUser = injected.findLastIndex(message => message.role === 'user');
    const marker = '\u0000\ufffc\u0000\ufffd';
    const formatted = injected.map((message, index) => {
        if (typeof message.content !== 'string' || message.tool_calls) {
            throw roleplayError('ROLEPLAY_INVALID', 'This text connection cannot format the saved media or tool history.', 409);
        }
        const continuing = effect === 'continue' && index === injected.length - 1;
        const row = { name: message.role === 'system' ? '' : message.name ?? (message.role === 'user' ? userName : characterName),
            is_user: message.role === 'user', mes: continuing ? message.content.replaceAll(marker, '') + marker : message.content,
            extra: { type: message.role === 'system' ? 'narrator' : undefined } };
        const force = continuing || index === lastUser ? FORCE_OUTPUT_SEQUENCE.LAST : index === 0 ? FORCE_OUTPUT_SEQUENCE.FIRST : false;
        const text = formatRoleplayTextMessage(row, { ...format, forceOutputSequence: force });
        return continuing ? text.slice(0, text.lastIndexOf(marker)) : text;
    });
    if (formatted.length && effect !== 'continue' && (!instruct.enabled || instruct.wrap)) {
        formatted[formatted.length - 1] = formatted.at(-1).replace(/\n?$/, '');
    }
    const tail = effect === 'continue' ? '' : instruct.enabled
        ? formatInstructModePrompt({ name: characterName, name1: userName, name2: characterName,
            customInstruct: instruct, selectedGroup: groupNames.length > 0, substitute })
        : (material.power?.always_force_name2 ?? snapshot.alwaysForceName) || groupNames.length || material.backend === 'novel'
            ? `\n${characterName}:` : '';
    if (material.power?.strip_examples) examples = [];
    if (!story.trim() && !examples.some(value => value.trim()) && !injected.some(message => message.content.trim())) {
        throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay prompt has no content to send.', 409);
    }
    const alignment = instruct.enabled && instruct.user_alignment_message ? formatRoleplayTextMessage({ name: userName,
        is_user: true, mes: substitute(instruct.user_alignment_message) }, { ...format, forceOutputSequence: FORCE_OUTPUT_SEQUENCE.FIRST }) : '';
    const chatStart = context.chat_start ? `${substitute(context.chat_start)}\n` : '';
    const preamble = material.backend === 'novel' ? `${substitute(material.active?.preamble ?? '')}\n` : '';
    return {
        exampleCount: examples.length,
        render: (selectedHistory, exampleLimit = Infinity) => {
            const selected = new Set(selectedHistory);
            const retained = injected.map((message, index) => ({ message, text: formatted[index] }))
                .filter(({ message }) => !message.source || selected.has(message.source));
            const needsAlignment = alignment && retained.find(item => item.message.source)?.message.role !== 'user';
            return combineRoleplayTextPrompt({ story, examples: examples.slice(0, exampleLimit).join(''),
                history: (needsAlignment ? alignment : '') + retained.map(item => item.text).join('') + tail,
                chatStart, preamble, collapseNewlines: material.power?.collapse_newlines });
        },
    };
}
