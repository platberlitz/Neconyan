import path from 'node:path';
import { normalizeExtensionBootId } from '../../public/scripts/extension-boot-lifecycle/index.js';
import { CHATROOM_TEMPLATE_ID, getActiveCompanionResults, getAgentTemplateId } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { companionExtraCharacterAvatars } from '../../public/scripts/extensions/in-chat-agents/companion/companion-prompts.js';
import { agentCollectionDirectory, readAgentCollection, readAgentRecordLocked } from '../in-chat-agent-storage.js';
import { readRoleplayFile, roleplayError, roleplayHash, roleplayLease, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { readRoleplayEntityLocked } from './roleplay-source.js';
import { captureChatProfile } from './profiles.js';
import { agentNeedsModel, isNativeCompanion, nativeAgentDefinition } from './agent-definition.js';

const fail = message => roleplayError('ROLEPLAY_AGENT_SOURCE_CHANGED', message, 409);

/** The caller holds the account lock. Only record identities and private-profile fingerprints are saved. */
export function captureRoleplayAgents(lease, settings, { group = false, serverPrompt = true, characterAvatars = [], historyAgentIds = [], hasHistory = false, forcedIds = [] } = {}) {
    if (!serverPrompt) return null;
    const { scope } = roleplayLease(lease);
    const extensions = settings.extension_settings ?? {};
    const global = extensions.inChatAgents?.globalSettings ?? {};
    const disabled = global.enabled === false || extensions.disabledExtensions?.map(normalizeExtensionBootId).includes('in-chat-agents');
    if (!Array.isArray(forcedIds) || forcedIds.length > 512 || forcedIds.some(id => typeof id !== 'string' || !id)) throw fail('The requested manual Agents are invalid.');
    if (forcedIds.length && disabled) throw fail('Enable Agents before accepting this manual action.');
    if (disabled && !hasHistory) return null;
    const directory = agentCollectionDirectory(scope.directories);
    const library = readAgentCollection(directory);
    if (library.errors.length) throw fail('The saved Agent library needs recovery before generation.');
    const scoped = global.separateRecentChats && global.scopedEnabledAgentIdsInitialized;
    const ids = global.enabledAgentIdsByChatType?.[group ? 'group' : 'individual'] ?? [];
    if (!Array.isArray(ids)) throw fail('The saved Agent enablement scope is invalid.');
    const agents = [], historyAgents = [], extraCharacters = new Map();
    // Reuse a shared connection only during this synchronous capture. The next
    // capture must read it again so edits still invalidate accepted work.
    const bindings = new Map();
    const hiddenIds = Array.isArray(global.hiddenCompanionAgentIds) ? [...new Set(global.hiddenCompanionAgentIds.filter(id => typeof id === 'string'))] : [];
    for (const raw of library.records) {
        const enabled = !disabled && (forcedIds.includes(raw.id) || (scoped ? ids.includes(raw.id) : raw.enabled));
        if (!enabled && !historyAgentIds.includes(raw.id)) continue;
        const agent = nativeAgentDefinition(raw);
        const stored = readAgentRecordLocked(lease, 'agent', raw.id);
        if (!stored || roleplayHash(stored.record) !== roleplayHash(raw)) throw fail('An enabled Agent changed.');
        const file = stored.file;
        let binding = null;
        if (enabled && (agentNeedsModel(agent) || forcedIds.includes(agent.id) && agent.prompt.trim())) {
            const profileId = agent.connectionProfile || (isNativeCompanion(agent) ? global.companionConnectionProfile : '')
                || global.connectionProfile || extensions.connectionManager?.selectedProfile || '';
            if (typeof profileId !== 'string') throw fail('An Agent model connection is invalid.');
            if (profileId) {
                if (!bindings.has(profileId)) bindings.set(profileId, captureChatProfile(scope.directories, profileId));
                binding = { kind: 'profile', ...bindings.get(profileId) };
            }
        }
        const profile = extensions.connectionManager?.profiles?.find(item => item.id === binding?.profileId);
        const reference = { id: agent.id, revision: roleplayHash(raw), rawHash: file.rawHash, physical: file.physical, binding,
            order: agent.injection.order, profileLabel: String(profile?.name || binding?.profileId || '') };
        if (enabled) agents.push(reference);
        if (historyAgentIds.includes(raw.id)) historyAgents.push(reference);
        if (enabled && getAgentTemplateId(agent) === CHATROOM_TEMPLATE_ID) {
            for (const avatar of companionExtraCharacterAvatars(agent.settings.chatroomExtraCharacterAvatars)) {
                if (characterAvatars.includes(avatar) || extraCharacters.has(avatar)) continue;
                const character = readRoleplayEntityLocked(lease, 'character', avatar);
                if (character.changed) saveRoleplayAccount(lease);
                const { contentHash, physical } = character;
                const descriptor = Object.fromEntries(Object.entries(character).filter(([key]) => !['data', 'changed', 'kind', 'contentHash', 'physical'].includes(key)));
                extraCharacters.set(avatar, { avatar, descriptor, contentHash, physical });
            }
        }
    }
    if (forcedIds.some(id => !agents.some(agent => agent.id === id))) throw fail('A requested manual Agent no longer exists.');
    if (!agents.length && !hasHistory) return null;
    agents.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const helperPrefill = global.helperPrefillMessages ?? '';
    if (typeof helperPrefill !== 'string' || Buffer.byteLength(helperPrefill) > 64 * 1024) throw fail('The saved Agent helper messages are invalid.');
    return { version: 1, group: Boolean(group), globalHash: roleplayHash(global), agents, historyAgents, hiddenIds,
        characterAvatars, historyAgentIds, hasHistory, forcedIds, extraCharacters: [...extraCharacters.values()],
        appendMode: global.appendAgentsExecutionMode === 'sequential' ? 'sequential' : 'parallel',
        companionMode: global.companionExecutionMode === 'sequential' ? 'sequential' : 'parallel',
        concurrentCompanions: Boolean(global.companionConcurrentWithPostGen),
        reviewPostMain: global.postMainInterceptShowMessageFirst !== false, helperPrefill };
}

export function readRoleplayAgentsLocked(lease, policy) {
    const { scope } = roleplayLease(lease);
    const filename = path.join(scope.directories.root, 'settings.json');
    const file = readRoleplayFile(filename, 8 * 1024 * 1024);
    let settings;
    try { settings = JSON.parse(file?.bytes.toString('utf8')); } catch { throw fail('The saved Agent settings are unreadable.'); }
    const current = captureRoleplayAgents(lease, settings, { group: policy.group, characterAvatars: policy.characterAvatars ?? [],
        historyAgentIds: policy.historyAgentIds ?? [], hasHistory: policy.hasHistory ?? false, forcedIds: policy.forcedIds ?? [] });
    if (roleplayHash(current) !== roleplayHash(policy)) throw fail('The accepted Agents or their model connections have changed.');
    return policy.agents.map(reference => {
        const stored = readAgentRecordLocked(lease, 'agent', reference.id);
        if (!stored || roleplayHash(stored.record) !== reference.revision) throw fail('An accepted Agent record has changed.');
        const agent = { ...nativeAgentDefinition(stored.record), binding: reference.binding, revision: reference.revision, profileLabel: reference.profileLabel };
        agent.extraCharacterCards = (policy.extraCharacters ?? []).filter(item => companionExtraCharacterAvatars(agent.settings.chatroomExtraCharacterAvatars).includes(item.avatar))
            .map(item => readRoleplayEntityLocked(lease, 'character', item.avatar).data);
        return agent;
    });
}

export function readRoleplayAgents(base, snapshot) {
    if (!snapshot.agents) return [];
    return withRoleplayAccount(base, snapshot.account, lease => readRoleplayAgentsLocked(lease, snapshot.agents));
}

export function agentHistorySources(records) {
    const ids = new Set();
    let hasHistory = false;
    for (const record of records.slice(1)) {
        for (const [id, result] of Object.entries(getActiveCompanionResults(record))) {
            if (result?.status === 'done' && result.includeInChatHistory) { ids.add(id); hasHistory = true; }
        }
        const scripts = record.extra?.inChatAgents;
        if (scripts?.regexScriptRefs?.length || scripts?.regexScripts?.length || scripts?.nativeRegexScripts?.length) hasHistory = true;
        for (const reference of scripts?.regexScriptRefs ?? []) if (typeof reference.agentId === 'string') ids.add(reference.agentId);
    }
    if (ids.size > 512) throw fail('The saved Agent history references exceed their limit.');
    return { hasHistory, historyAgentIds: [...ids] };
}

export function readRoleplayHistoryAgents(base, snapshot) {
    if (!snapshot.agents) return [];
    return withRoleplayAccount(base, snapshot.account, lease => {
        readRoleplayAgentsLocked(lease, snapshot.agents);
        return (snapshot.agents.historyAgents ?? []).map(reference => {
            const stored = readAgentRecordLocked(lease, 'agent', reference.id);
            if (!stored || roleplayHash(stored.record) !== reference.revision) throw fail('A saved Agent history source has changed.');
            return nativeAgentDefinition(stored.record);
        });
    });
}
