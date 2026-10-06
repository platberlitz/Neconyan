import { fail, hash } from '../mewmory/core.js';
import { applyRegexScriptList, AGENT_REGEX_PLACEMENT } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';

export function activeCharacterRegexHash(material, avatar, character) {
    const policy = material.regexPolicy;
    return hash(!policy || policy.disabled || !policy.characterAllowed.includes(avatar) ? [] : character.extensions?.regex_scripts || []);
}

/** Select raw-output transformations before dispatch; never infer missing scope. */
export function prepareActiveRegex(material, macroEnvironment) {
    const policy = material.regexPolicy;
    if (!policy || policy.disabled) return [];
    const lists = [policy.global];
    if (policy.presetScripts.length) {
        if (!policy.preset?.api || !policy.preset?.name) fail('Save the active preset selection before using its output transformations.', 409);
        if (policy.presetAllowed[policy.preset.api]?.includes(policy.preset.name)) lists.push(policy.presetScripts);
    }
    const avatar = macroEnvironment?.extra?.characterAvatar;
    // Requests that never speak as a character declare it, so character scripts are skipped rather than guessed.
    const characterless = macroEnvironment?.extra?.characterScope === 'none';
    if (!characterless && policy.characterAllowed.length && !avatar) fail('This request needs its captured character before applying output transformations.', 409);
    if (!characterless && policy.characterAllowed.includes(avatar)) {
        const character = macroEnvironment?.extra?.character;
        if (!character) fail('The captured character transformations are unavailable.', 409);
        lists.push(character.extensions?.regex_scripts || []);
    }
    const scripts = [];
    for (const list of lists) {
        if (!Array.isArray(list)) fail('The saved output transformation list is invalid.', 409);
        for (const script of list) {
            if (!script || script.disabled || script.markdownOnly || script.promptOnly || !script.placement?.includes(AGENT_REGEX_PLACEMENT.AI_OUTPUT)) continue;
            if (typeof script.findRegex !== 'string' || typeof script.replaceString !== 'string'
                || (script.trimStrings !== undefined && (!Array.isArray(script.trimStrings) || script.trimStrings.some(value => typeof value !== 'string')))) {
                fail('A saved output transformation is invalid.', 409);
            }
            // Output-dependent macro mutations cannot be reconstructed before dispatch.
            const macroFields = [script.replaceString.replace(/{{match}}/gi, ''), ...(script.trimStrings || [])];
            if (Number(script.substituteRegex)) macroFields.push(script.findRegex);
            if (macroFields.some(value => value.includes('{{') || /<(?:USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>/i.test(value))
                || /{{match}}|\$\d+|\$<[^>]+>/i.test(script.replaceString)) {
                fail('Macro-dependent output transformations require the browser and cannot run in this server request.', 409);
            }
            scripts.push({ ...script, markdownOnly: false, promptOnly: false });
        }
    }
    return structuredClone(scripts);
}

export function applyActiveRegex(text, scripts) {
    return applyRegexScriptList(text, scripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT);
}
