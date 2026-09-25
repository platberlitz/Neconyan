import { isNeconyanAssistant } from '../../public/scripts/neconyan-assistant-knowledge.js';
import { readAgentRecordLocked } from '../in-chat-agent-storage.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { nativeToolDefinitions, ASSISTANT_TOOL_NAMES, PATHFINDER_TOOL_NAMES } from './native-tool-definitions.js';
import { capturePathfinderToolOwnerLocked } from './pathfinder-tool-jobs.js';

const invalid = message => roleplayError('ROLEPLAY_TOOL_INVALID', message, 409);

/** Freeze only native actions registered for this exact card and enabled tool Agent. Caller holds the account lock. */
export function captureRoleplayToolBindings(lease, source, avatar, character, agents, settings) {
    const names = [];
    let assistant = null;
    if (!source.locator.group && isNeconyanAssistant(character)) {
        assistant = { avatar, id: character.data?.extensions?.neconyan_assistant?.id
            ?? character.extensions?.neconyan_assistant?.id };
        names.push(...ASSISTANT_TOOL_NAMES);
    }
    let pathfinder = null;
    if (agents?.agents?.length && settings.extension_settings?.inChatAgents?.globalSettings?.enabled !== false) {
        const candidates = agents.agents.flatMap(reference => {
            const record = readAgentRecordLocked(lease, 'agent', reference.id)?.record;
            if (!record || record.category !== 'tool' || !(record.sourceTemplateId === 'tpl-pathfinder'
                || ['Pawthfinder', 'Pathfinder'].includes(record.name)
                || record.tools?.some(tool => tool.name?.startsWith('Pathfinder_')))) return [];
            return [{ reference, record }];
        }).sort((a, b) => a.reference.order - b.reference.order || a.reference.id.localeCompare(b.reference.id));
        if (candidates.length) {
            const owner = capturePathfinderToolOwnerLocked(lease, source, avatar);
            if (owner.reference.id !== candidates[0].reference.id) throw invalid('The Pathfinder tool owner changed during admission.');
            const states = owner.agent.settings?.toolStates ?? {};
            const available = (owner.agent.settings?.sidecarEnabled ? PATHFINDER_TOOL_NAMES : ['Pathfinder_Summarize'])
                .filter(name => states[name] !== false && !owner.agent.tools?.some(tool => tool.name === name
                    && (tool.enabled === false || tool.shouldRegister === false)));
            pathfinder = { agentId: owner.reference.id, revision: owner.reference.revision,
                rawHash: owner.reference.rawHash, physical: owner.reference.physical,
                books: owner.books, names: available, settingsHash: roleplayHash(owner.agent.settings ?? {}) };
            names.push(...available);
        }
    }
    if (!names.length) return null;
    const definitions = nativeToolDefinitions(names);
    if (Buffer.byteLength(JSON.stringify(definitions)) > 1024 * 1024) throw invalid('The saved native tool definitions exceed their limit.');
    return { version: 1, assistant, pathfinder, definitions };
}
