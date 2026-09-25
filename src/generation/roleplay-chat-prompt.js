import { isKimiK3Model } from '../../public/scripts/openai-model-capabilities.js';
import { appendAutoAppendReasoningInstruction } from '../../public/scripts/chat-reasoning-instruction.js';
import { injectChatPromptDepth } from '../../public/scripts/chat-prompt-depth.js';
import { roleplayError } from '../roleplay-store.js';
import { buildRoleplayPromptExtensions, insertWorldInfoExamples, roleplayEffectTrigger } from './roleplay-prompt.js';
import { mergeChatPresetSettings } from '../../public/scripts/chat-preset-request.js';

const roles = ['system', 'user', 'assistant'];
const fail = message => { throw roleplayError('ROLEPLAY_INVALID', message, 409); };

/** Assemble saved Prompt Manager slots around protected history. No page state is read. */
export async function assembleRoleplayChatPrompt(history, snapshot, material, worldInfo, {
    userName, characterName, groupNames = [], effect = 'append', substitute, substituteHistory = value => value, memory, exampleLimit = Infinity, contributions = [], records = [],
} = {}) {
    const controls = mergeChatPresetSettings(material.active, material.preset);
    const order = controls?.prompt_order?.find(value => String(value?.character_id) === '100001')?.order;
    if (!Array.isArray(order) || !Array.isArray(controls?.prompts)
        || order.some(value => !value || typeof value.identifier !== 'string' || typeof value.enabled !== 'boolean')
        || controls.prompts.some(value => !value || typeof value.identifier !== 'string')
        || new Set(order.map(value => value.identifier)).size !== order.length
        || new Set(controls.prompts.map(value => value.identifier)).size !== controls.prompts.length) {
        fail('The saved Chat Completion prompt order is invalid.');
    }
    substitute ??= value => {
        const result = value.replaceAll('{{char}}', characterName).replaceAll('{{user}}', userName);
        if (result.includes('{{')) fail('This saved prompt needs server-side macro handling.');
        return result;
    };
    const render = (value, original) => {
        if (typeof value !== 'string') fail('A saved Chat Completion prompt has invalid content.');
        return substitute(value, original);
    };
    const trigger = roleplayEffectTrigger(effect);
    const values = {
        worldInfoBefore: worldInfo.worldInfoBefore, worldInfoAfter: worldInfo.worldInfoAfter,
        personaDescription: snapshot.personaPosition === 0 || snapshot.personaPosition === undefined ? snapshot.global.personaDescription : '',
        charDescription: snapshot.global.characterDescription, charPersonality: snapshot.global.characterPersonality,
        scenario: snapshot.global.scenario,
    };
    const prompts = order.flatMap(item => {
        const saved = controls.prompts.find(prompt => prompt.identifier === item.identifier);
        if (!saved) {
            if (item.enabled) fail('An enabled saved prompt is missing.');
            return [];
        }
        const active = item.enabled && (!Array.isArray(saved.injection_trigger) || !saved.injection_trigger.length || saved.injection_trigger.includes(trigger));
        if (!active && item.identifier !== 'main') return [];
        if (['chatHistory', 'dialogueExamples'].includes(item.identifier)) {
            if (!saved.marker || saved.injection_position === 1) fail('A saved history or example marker is invalid.');
            return [{ ...saved }];
        }
        if (saved.marker && !Object.hasOwn(values, item.identifier)) fail('This saved prompt marker has no server content.');
        const role = saved.role ?? 'system';
        if (!roles.includes(role) || ![0, 1].includes(saved.injection_position ?? 0)) fail('A saved prompt position or role is invalid.');
        let content = Object.hasOwn(values, item.identifier) ? values[item.identifier] : saved.content;
        let original;
        if (saved.forbid_overrides !== true) {
            if (item.identifier === 'main' && snapshot.systemPrompt) { original = content; content = snapshot.systemPrompt; }
            if (item.identifier === 'jailbreak' && snapshot.postHistory?.character?.trim()) { original = content; content = snapshot.postHistory.character; }
        }
        if (!active) content = '';
        if (content && item.identifier === 'charPersonality' && controls.personality_format) {
            content = controls.personality_format.replaceAll('{{personality}}', content);
        }
        if (content && item.identifier === 'scenario' && controls.scenario_format) {
            content = controls.scenario_format.replaceAll('{{scenario}}', content);
        }
        if (content && ['worldInfoBefore', 'worldInfoAfter'].includes(item.identifier) && controls.wi_format?.trim()) {
            content = controls.wi_format.replaceAll('{0}', content);
        }
        const prompt = { ...saved, role, content: render(content ?? '', original), injection_depth: saved.injection_depth ?? 4,
            injection_order: saved.injection_order ?? 100 };
        if (!Number.isSafeInteger(prompt.injection_depth) || prompt.injection_depth < 0 || prompt.injection_depth > 10000
            || !Number.isSafeInteger(prompt.injection_order)) fail('A saved depth prompt is invalid.');
        return [prompt];
    });
    const extensions = buildRoleplayPromptExtensions(snapshot, worldInfo, render, contributions);
    if (memory?.enabled && !prompts.some(prompt => prompt.identifier === 'chatHistory')) {
        fail('Mewmory needs the saved Chat History prompt marker enabled.');
    }
    const absolute = prompts.filter(prompt => prompt.injection_position === 1);
    const main = prompts.find(prompt => prompt.identifier === 'main');
    const relative = extensions.filter(prompt => prompt.position !== 1).sort((a, b) => a.key.localeCompare(b.key));
    if (main?.injection_position === 1) {
        for (const prompt of relative) {
            const index = absolute.indexOf(main);
            absolute.splice(index + (prompt.position === 0 ? 1 : 0), 0, { ...main, content: prompt.content });
        }
    }
    const maxDepth = Math.max(0, ...absolute.map(prompt => prompt.injection_depth),
        ...extensions.filter(prompt => prompt.position === 1).map(prompt => prompt.depth));
    const control = [];
    const retainedHistory = [...history].reverse().map(substituteHistory).reverse();
    const continued = effect === 'continue' ? retainedHistory.pop() : null;
    if (continued) {
        if (controls.continue_prefill) {
            const prefill = continued.role === 'assistant' && material.source === 'claude' ? render(controls.assistant_prefill ?? '') : '';
            control.push(prefill ? { ...continued, content: Array.isArray(continued.content)
                ? [{ type: 'text', text: prefill }, ...continued.content] : `${prefill}\n\n${continued.content}` } : continued);
        } else {
            control.push(continued);
            const content = render((controls.continue_nudge_prompt ?? '').replaceAll('{{lastChatMessage}}', String(continued.content).trim()));
            if (content) control.push({ role: 'system', content });
        }
    }
    const injected = (await injectChatPromptDepth(absolute, [...retainedHistory].reverse(), { maxDepth,
        extensionAt: (depth, role) => ({ content: extensions.filter(prompt => prompt.position === 1
            && prompt.depth === depth && prompt.role === role).sort((a, b) => a.key.localeCompare(b.key))
            .map(prompt => prompt.content.trim()).join('\n') }),
    })).map(({ injected: _injected, ...message }) => message);
    const exampleBlocks = prompts.some(prompt => prompt.identifier === 'dialogueExamples')
        ? insertWorldInfoExamples([], worldInfo.EMEntries, render(snapshot.characterExamples), 0,
            userName, characterName, groupNames, { blocksOnly: true }) : [];
    const exampleSeparator = render(controls.new_example_chat_prompt ?? '');
    const boundaries = new Set();
    const boundary = content => {
        const message = { role: 'system', content };
        boundaries.add(message);
        return message;
    };
    const examples = exampleBlocks.slice(0, exampleLimit).flatMap(block => exampleSeparator
        ? [boundary(exampleSeparator), ...block] : block);
    const newChat = render((groupNames.length ? controls.new_group_chat_prompt : controls.new_chat_prompt) ?? '');
    const groupNudge = groupNames.length ? render(controls.group_nudge_prompt ?? '') : '';
    if (newChat) injected.unshift(boundary(newChat));
    if (injected.at(-1)?.role === 'assistant' && controls.send_if_empty) injected.push({ role: 'user', content: controls.send_if_empty });
    if (groupNudge) injected.push(boundary(groupNudge));
    const result = [];
    for (const prompt of prompts) {
        if (prompt.injection_position === 1) continue;
        if (prompt.identifier === 'chatHistory') { result.push(...injected); continue; }
        if (prompt.identifier === 'dialogueExamples') { result.push(...examples); continue; }
        if (prompt.identifier === 'main') {
            result.push(...relative.filter(item => item.position === 2).reverse().map(({ role, content }) => ({ role, content })));
        }
        if (prompt.content) result.push({ role: prompt.role, content: prompt.content });
        if (prompt.identifier === 'main') {
            result.push(...relative.filter(item => item.position === 0).map(({ role, content }) => ({ role, content })));
        }
    }
    if (memory?.enabled) result.push(...[memory.npcText, memory.memoryText].filter(Boolean)
        .map(content => ({ role: 'system', content })));
    const savedBias = effect === 'continue' ? '' : records.slice(1).findLast(record => record.is_user || record.is_system || record.extra?.type === 'narrator')?.extra?.bias;
    const defaultBias = ['custom', 'moonshot', 'nanogpt', 'openrouter'].includes(material.source) && isKimiK3Model(material.profile?.model)
        ? controls.kimi_partial_prefill || material.power?.user_prompt_bias : material.power?.user_prompt_bias;
    const bias = effect === 'continue' ? '' : render(savedBias || defaultBias || '');
    if (bias.trim()) result.push({ role: 'assistant', content: bias });
    result.push(...control);
    if (!controls.squash_system_messages) return { messages: appendAutoAppendReasoningInstruction(result, { ...controls, chat_completion_source: material.source }, material.profile?.model, trigger), exampleCount: exampleBlocks.length };
    const messages = [];
    let previous;
    for (const message of result) {
        if (message.role === 'system' && !message.content) continue;
        const merge = message.role === 'system' && !message.name && !boundaries.has(message);
        if (merge && previous) previous.content += `\n${message.content}`;
        else {
            const copy = { ...message };
            messages.push(copy);
            previous = merge ? copy : null;
        }
    }
    return { messages: appendAutoAppendReasoningInstruction(messages, { ...controls, chat_completion_source: material.source }, material.profile?.model, trigger), exampleCount: exampleBlocks.length };
}
