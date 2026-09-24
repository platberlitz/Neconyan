import { injectChatPromptDepth } from '../../public/scripts/chat-prompt-depth.js';
import { roleplayError } from '../roleplay-store.js';
import { activeRoleplayAuthorNote, insertWorldInfoExamples, isWorldInfoAuthorNoteActive } from './roleplay-prompt.js';

const roles = ['system', 'user', 'assistant'];
const fail = message => { throw roleplayError('ROLEPLAY_INVALID', message, 409); };

/** Assemble saved Prompt Manager slots around protected history. No page state is read. */
export async function assembleRoleplayChatPrompt(history, snapshot, material, worldInfo, {
    userName, characterName, groupNames = [], effect = 'append', substitute, memory,
} = {}) {
    const controls = material.preset ?? material.active;
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
    const render = value => {
        if (typeof value !== 'string') fail('A saved Chat Completion prompt has invalid content.');
        return substitute(value);
    };
    const trigger = effect === 'append' ? 'normal' : effect === 'replace' ? 'regenerate' : effect;
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
        const active = item.enabled && (!saved.injection_trigger?.length || saved.injection_trigger.includes(trigger));
        if (!active && item.identifier !== 'main') return [];
        if (['chatHistory', 'dialogueExamples'].includes(item.identifier)) {
            if (!saved.marker || saved.injection_position === 1) fail('A saved history or example marker is invalid.');
            return [{ ...saved }];
        }
        if (saved.marker && !Object.hasOwn(values, item.identifier)) fail('This saved prompt marker has no server content.');
        const role = saved.role ?? 'system';
        if (!roles.includes(role) || ![0, 1].includes(saved.injection_position ?? 0)) fail('A saved prompt position or role is invalid.');
        let content = Object.hasOwn(values, item.identifier) ? values[item.identifier] : saved.content;
        if (saved.forbid_overrides !== true) {
            if (item.identifier === 'main' && snapshot.systemPrompt) content = snapshot.systemPrompt;
            if (item.identifier === 'jailbreak' && snapshot.postHistory?.character?.trim()) content = snapshot.postHistory.character;
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
        const prompt = { ...saved, role, content: render(content ?? ''), injection_depth: saved.injection_depth ?? 4,
            injection_order: saved.injection_order ?? 100 };
        if (!Number.isSafeInteger(prompt.injection_depth) || prompt.injection_depth < 0 || prompt.injection_depth > 10000
            || !Number.isSafeInteger(prompt.injection_order)) fail('A saved depth prompt is invalid.');
        return [prompt];
    });
    const extensions = [];
    if (memory?.enabled && !prompts.some(prompt => prompt.identifier === 'chatHistory')) {
        fail('Mewmory needs the saved Chat History prompt marker enabled.');
    }
    const addExtension = (key, content, position, depth, role) => {
        if (!content) return;
        if (![0, 1, 2].includes(position) || !Number.isSafeInteger(depth) || depth < 0 || depth > 10000
            || !roles.includes(role)) fail('A saved extension prompt position is invalid.');
        extensions.push({ key, content: render(content), position, depth, role });
    };
    const note = snapshot.authorNote;
    let noteText = note ? activeRoleplayAuthorNote(note) : '';
    if (note && isWorldInfoAuthorNoteActive(note)) {
        noteText = [snapshot.personaPosition === 2 ? snapshot.global.personaDescription : '',
            ...worldInfo.ANBeforeEntries, noteText, ...worldInfo.ANAfterEntries,
            snapshot.personaPosition === 3 ? snapshot.global.personaDescription : ''].filter(Boolean).join('\n');
        addExtension('2_floating_prompt', noteText, note.position, note.depth, roles[note.role]);
    }
    if (snapshot.personaPosition === 4) {
        addExtension('PERSONA_DESCRIPTION', snapshot.global.personaDescription, 1, snapshot.personaDepth, roles[snapshot.personaRole]);
    }
    if (snapshot.depthPrompt) {
        addExtension('DEPTH_PROMPT', snapshot.depthPrompt.prompt, 1, snapshot.depthPrompt.depth, snapshot.depthPrompt.role);
    }
    for (const [index, entry] of worldInfo.WIDepthEntries.entries()) {
        addExtension(`worldInfoDepth${index}`, entry.entries.join('\n'), 1, entry.depth, roles[entry.role]);
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
    const injected = (await injectChatPromptDepth(absolute, [...history].reverse(), { maxDepth,
        extensionAt: (depth, role) => ({ content: extensions.filter(prompt => prompt.position === 1
            && prompt.depth === depth && prompt.role === role).sort((a, b) => a.key.localeCompare(b.key))
            .map(prompt => prompt.content.trim()).join('\n') }),
    })).map(({ injected: _injected, ...message }) => message);
    const examples = prompts.some(prompt => prompt.identifier === 'dialogueExamples')
        ? insertWorldInfoExamples([], worldInfo.EMEntries, render(snapshot.characterExamples), 0,
            userName, characterName, groupNames) : [];
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
    return result;
}
