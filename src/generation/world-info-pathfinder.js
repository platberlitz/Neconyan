import path from 'node:path';
import { getDefaultPipelines, getDefaultPrompts } from '../../public/scripts/extensions/in-chat-agents/pathfinder/prompts/default-prompts.js';
import { canReadBook } from '../../public/scripts/extensions/in-chat-agents/pathfinder/lorebook-policy.js';
import { captureChatProfile } from './profiles.js';
import { readRoleplayFile, roleplayError, roleplayHash } from '../roleplay-store.js';
import { AGENT_STORAGE_LIMITS, getAgentRecordError } from '../../public/scripts/extensions/in-chat-agents/setup-presets.js';

const invalid = message => { throw roleplayError('ROLEPLAY_INVALID', message, 409); };

export function readPathfinderAgent(directories, reference) {
    if (!reference || typeof reference.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(reference.id)) {
        invalid('The selected Pathfinder agent has an invalid identity.');
    }
    const file = readRoleplayFile(path.join(directories.inChatAgents ?? path.join(directories.root, 'InChatAgents'), `${reference.id}.json`),
        AGENT_STORAGE_LIMITS.agentBytes);
    if (!file) throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The selected Pathfinder agent is missing.', 409);
    let agent;
    try { agent = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)); } catch {
        throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'The selected Pathfinder agent needs recovery.', 409);
    }
    if (getAgentRecordError(agent) || agent.id !== reference.id || roleplayHash(agent) !== reference.revision
        || roleplayHash(file.physical) !== roleplayHash(reference.physical)) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The selected Pathfinder agent changed after admission.', 409);
    }
    return agent;
}

export function pathfinderPipeline(settings) {
    const id = settings.pipelineId || 'default';
    const pipelines = { ...getDefaultPipelines(), ...settings.pipelines };
    const prompts = { ...getDefaultPrompts(), ...settings.pipelinePrompts };
    const pipeline = Object.hasOwn(pipelines, id) ? pipelines[id] : null;
    if (!pipeline || !Array.isArray(pipeline.stages) || !pipeline.stages.length || pipeline.stages.length > 16) {
        invalid('The selected Pathfinder pipeline is missing or invalid.');
    }
    for (const stage of pipeline.stages) {
        if (!stage || typeof stage.promptId !== 'string' || typeof stage.outputKey !== 'string'
            || !/^[a-zA-Z0-9_-]{1,128}$/.test(stage.outputKey)
            || !stage.inputMapping || typeof stage.inputMapping !== 'object' || Array.isArray(stage.inputMapping)
            || Object.keys(stage.inputMapping).length > 32 || Object.entries(stage.inputMapping)
            .some(([key, value]) => !/^[a-zA-Z0-9_-]{1,128}$/.test(key) || typeof value !== 'string' || value.length > 1024)) {
            invalid('A saved Pathfinder pipeline stage is invalid.');
        }
        const prompt = Object.hasOwn(prompts, stage.promptId) ? prompts[stage.promptId] : null;
        if (!prompt || typeof prompt.systemPrompt !== 'string' || typeof prompt.userPromptTemplate !== 'string'
            || !['json_array', 'json_object', 'text_lines'].includes(prompt.outputFormat)
            || prompt.connectionProfile !== undefined && typeof prompt.connectionProfile !== 'string'
            || prompt.settings?.maxTokens !== undefined && (!Number.isFinite(Number(prompt.settings.maxTokens)) || Number(prompt.settings.maxTokens) < 1)
            || prompt.settings?.temperature !== undefined && !Number.isFinite(Number(prompt.settings.temperature))) {
            invalid('A saved Pathfinder pipeline prompt is invalid.');
        }
    }
    return { pipeline, prompts };
}

/** Only the saved Pathfinder owner can contribute a retrieval prompt; other agents remain separately bound. */
export function capturePathfinderSource(directories, policy, { chatBook, personaBook, members, charLore }) {
    if (!policy.pathfinder.length) return null;
    const agents = policy.pathfinder.map(reference => ({ reference, agent: readPathfinderAgent(directories, reference) }));
    agents.sort((a, b) => (Number(a.agent.injection?.order) || 0) - (Number(b.agent.injection?.order) || 0)
        || a.agent.id.localeCompare(b.agent.id));
    const { reference, agent } = agents[0];
    const settings = agent.settings ?? {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || !Array.isArray(settings.enabledLorebooks ?? [])
        || settings.bookPermissions !== undefined && (!settings.bookPermissions || typeof settings.bookPermissions !== 'object' || Array.isArray(settings.bookPermissions))
        || settings.pipelinePrompts !== undefined && (!settings.pipelinePrompts || typeof settings.pipelinePrompts !== 'object' || Array.isArray(settings.pipelinePrompts))
        || settings.pipelines !== undefined && (!settings.pipelines || typeof settings.pipelines !== 'object' || Array.isArray(settings.pipelines))
        || settings.connectionProfile !== undefined && (typeof settings.connectionProfile !== 'string' || settings.connectionProfile.length > 256)) {
        invalid('Saved Pathfinder retrieval settings are invalid.');
    }
    const contextual = [chatBook, personaBook];
    if (settings.includeContextualLorebooks !== false || settings.autoUseAttachedLorebook) {
        for (const { avatar, card } of members) {
            contextual.push(card?.data?.extensions?.world || card?.data?.character_book?.name || card?.extensions?.world || card?.character_book?.name);
            const extra = charLore.find(item => item?.name === path.parse(avatar).name)?.extraBooks ?? [];
            if (!Array.isArray(extra)) invalid('Saved Pathfinder character books are invalid.');
            contextual.push(...extra);
        }
    }
    const names = [...(settings.enabledLorebooks ?? []), ...(settings.includeContextualLorebooks !== false || settings.autoUseAttachedLorebook ? contextual : [])];
    if (names.length > 256 || names.some(name => name !== undefined && name !== ''
        && (typeof name !== 'string' || !name.trim() || name.trim().length > 234))) {
        invalid('Saved Pathfinder lorebook selection is invalid.');
    }
    const books = [...new Set(names.filter(name => typeof name === 'string' && name.trim()))]
        .filter(name => settings.bookPermissions?.[name]?.enabled !== false && canReadBook(name, settings));
    const profiles = new Set([settings.connectionProfile].filter(Boolean));
    if (settings.pipelineEnabled) {
        const { pipeline, prompts } = pathfinderPipeline(settings);
        for (const stage of pipeline.stages) profiles.add(prompts[stage.promptId].connectionProfile || settings.connectionProfile || '');
    }
    if ([...profiles].some(id => typeof id !== 'string' || id.length > 256)) invalid('A saved Pathfinder connection profile is invalid.');
    return { agentId: reference.id, revision: reference.revision, physical: reference.physical, books,
        bindings: Object.fromEntries([...profiles].filter(Boolean).map(id => [id, captureChatProfile(directories, id)])) };
}
