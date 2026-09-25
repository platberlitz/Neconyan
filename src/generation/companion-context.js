import { createMacroEnvironment } from '../macros/index.js';
import { getStringHash } from '../../public/scripts/macro-primitives.js';
import { getActiveCompanionResults, isEmptyOutputSentinel, MEMORY_SHARD_TEMPLATE_ID, TRACKER_EMPTY_OUTPUT_INSTRUCTION } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { TRACKER_REPAIR_INSTRUCTION } from '../../public/scripts/extensions/in-chat-agents/tracker-state.js';
import { COMPANION_GUARD_INSTRUCTION, COMPANION_FINAL_BOUNDARY, COMPANION_BATCH_FINAL_BOUNDARY, COMPANION_TASK_ANCHOR, getCompanionFormatInstruction,
    getCompanionTemplateSettings, formatCompanionExtraCharacterCard } from '../../public/scripts/extensions/in-chat-agents/companion/companion-prompts.js';

const clean = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
export const companionLine = message => `${clean(message.name) || (message.is_user ? 'User' : 'Assistant')}: ${clean(message.mes)}`;
export function companionMessageTokens(message) {
    const count = Number(message.extra?.token_count);
    return Number.isFinite(count) && count > 0 ? count : Math.ceil(String(message.mes ?? '').length / 4);
}

export function companionEnvironment(options, agent, message = options.messages.at(-1)) {
    const environment = createMacroEnvironment(options.macros, {}, { readOnly: true });
    environment.names.char = clean(message?.name) || options.assistantName || environment.names.char;
    const text = clean(message?.mes);
    for (const name of ['currentMessage', 'lastMessage', 'latestMessage', 'response', 'currentResponse', 'latestResponse', 'assistantMessage']) {
        environment.dynamicMacros[name.toLowerCase()] = text;
    }
    Object.assign(environment.dynamicMacros, { assistantname: environment.names.char, agentname: agent.name, generationtype: options.generationType });
    return environment;
}

export function resolveCompanionText(options, agent, text, message) {
    const environment = companionEnvironment(options, agent, message);
    return clean(environment.evaluate(String(text ?? ''), { legacy: !options.snapshot.experimentalMacroEngine, strictCapabilities: true,
        original: String(message?.mes ?? options.messages.at(-1)?.mes ?? '') }));
}

export function previousCompanionNotes(options, agent, { depth = agent.companion.historyDepth, before = options.messages.length - 1 } = {}) {
    const result = [];
    for (let index = Math.min(before - 1, options.messages.length - 1); index >= 0 && result.length < depth; index--) {
        const message = options.messages[index];
        if (message.is_user) continue;
        const stored = getActiveCompanionResults(message);
        const note = Object.hasOwn(stored, agent.id) ? stored[agent.id] : null;
        if (note?.status !== 'done' || !clean(note.content) || isEmptyOutputSentinel(note.content)) continue;
        result.push({ index, note, content: resolveCompanionText(options, agent, note.content, message) });
    }
    return result;
}

export function recentCompanionContext(options, agent) {
    const selected = [];
    let tokens = 0;
    for (let index = options.messages.length - 1; index >= 0; index--) {
        const message = options.messages[index];
        if (message.is_system) continue;
        selected.push({ index, message });
        tokens += companionMessageTokens(message);
        if (selected.length >= agent.companion.contextMessages && tokens >= agent.companion.minContextTokens) break;
    }
    selected.reverse();
    return { text: selected.map(({ message }) => companionLine(message)).join('\n\n'), coverage: selected.map(({ index, message }) => {
        const line = companionLine(message);
        return { index, swipe: message.swipe_id ?? 0, hash: getStringHash(line), length: line.length };
    }) };
}

function characterSection(options, agent) {
    const parts = [];
    const { macros, snapshot } = options;
    const card = macros.extra?.character?.data ?? macros.extra?.character ?? snapshot.promptFields ?? {};
    if (agent.companion.includeCharacterCard) {
        const name = options.assistantName || snapshot.speakerNames.character;
        if (name) parts.push(`Name: ${name}`);
        for (const [label, key, fallback] of [['Description', 'description', macros.character?.description], ['Personality', 'personality', macros.character?.personality],
            ['Scenario', 'scenario', macros.character?.scenario], ['System', 'system_prompt', ''], ['Creator Notes', 'creator_notes', '']]) {
            const value = resolveCompanionText(options, agent, card[key] ?? fallback ?? '');
            if (value) parts.push(`${label}:\n${value}`);
        }
    }
    if (agent.companion.includePersona) {
        const persona = resolveCompanionText(options, agent, macros.character?.persona ?? snapshot.global?.personaDescription ?? '');
        if (persona) parts.push(`User Persona:\n${persona}`);
    }
    return parts.join('\n\n');
}

export function companionContextSections(options, agent, { previous = true, linked = [] } = {}) {
    const settings = agent.companion;
    const recent = recentCompanionContext(options, agent);
    const notes = previous && settings.includeHistory
        ? previousCompanionNotes(options, agent).map(note => `Message ${note.index}:\n${note.content}`).join('\n\n') : '';
    const sections = [
        ['System Prompt', settings.includeSystemPrompt ? resolveCompanionText(options, agent, options.systemPrompt) : ''],
        ['Character', characterSection(options, agent)],
        ['World Info', settings.includeWorldInfo ? options.worldInfo : ''],
        ['Author\'s Note', settings.includeAuthorsNote ? resolveCompanionText(options, agent, options.authorsNote) : ''],
        ['Your previous notes', notes], ['Recent conversation', recent.text],
        ...linked.map(section => [clean(section.title) || 'Extra context', clean(section.content)]),
    ].filter(([, content]) => content).map(([title, content]) => `[${title}]\n${content}`).join('\n\n');
    return { sections, coverage: recent.coverage };
}

export function expandedCompanionPrompt(options, agent) {
    const prompt = resolveCompanionText(options, agent, agent.prompt);
    const resolve = value => resolveCompanionText(options, agent, value);
    const extraCharacterCards = (agent.extraCharacterCards ?? []).map(card => formatCompanionExtraCharacterCard(card, resolve)).join('\n\n');
    const settings = getCompanionTemplateSettings(agent, { resolve, extraCharacterCards });
    return [prompt, settings, !options.repair && agent.category === 'tracker' && !prompt.toLowerCase().includes('tracker-none') ? TRACKER_EMPTY_OUTPUT_INSTRUCTION : '']
        .filter(Boolean).join('\n\n').trim();
}

export function singleCompanionPrompt(options, agent, linked = []) {
    const context = companionContextSections(options, agent, { linked });
    const messages = [{ role: 'system', content: [COMPANION_GUARD_INSTRUCTION, expandedCompanionPrompt(options, agent),
        agent.companion.rawPrompt ? '' : getCompanionFormatInstruction(agent.companion.format), options.repair ? TRACKER_REPAIR_INSTRUCTION : '', COMPANION_FINAL_BOUNDARY]
        .filter(Boolean).join('\n\n').trim() },
    { role: 'user', content: `${context.sections || '[Recent conversation]\nConversation context is empty.'}\n\n${COMPANION_TASK_ANCHOR}` }];
    return { messages, coverage: agent.sourceTemplateId === MEMORY_SHARD_TEMPLATE_ID || agent.id === MEMORY_SHARD_TEMPLATE_ID ? context.coverage : null };
}

export function batchCompanionPrompt(options, agents, linked = []) {
    const context = companionContextSections(options, agents[0], { previous: false, linked });
    const tasks = agents.map(agent => {
        const notes = agent.companion.includeHistory ? previousCompanionNotes(options, agent).map(note => `Message ${note.index}:\n${note.content}`).join('\n\n') : '';
        return { agentId: agent.id, content: [`<<<companion:${agent.id}>>>`, `Agent: ${agent.name || agent.id}`, COMPANION_GUARD_INSTRUCTION,
            'Instruction:', expandedCompanionPrompt(options, agent), ...(notes ? [`[Your previous notes]\n${notes}`] : []),
            ...(agent.companion.rawPrompt ? [] : ['Output format:', getCompanionFormatInstruction(agent.companion.format)]), COMPANION_FINAL_BOUNDARY, `<<<end:${agent.id}>>>`].join('\n') };
    });
    return { tasks, coverage: context.coverage, messages: [{ role: 'system',
        content: 'Run each companion task independently in its requested format. Put every result inside its matching <<<companion:agentId>>> and <<<end:agentId>>> markers. Text outside markers is ignored.' },
    { role: 'user', content: `${context.sections || '[Recent conversation]\nConversation context is empty.'}\n\n[Tasks]\n${tasks.map(task => task.content).join('\n\n')}\n\nPlace every result inside its markers now.\n${COMPANION_BATCH_FINAL_BOUNDARY}` }] };
}
