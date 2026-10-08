import { applyRegexScriptList, normalizeRegexScript } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';
import { getRegexScriptRevision } from '../../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js';
import { buildCompanionChatHistoryBlocks, consolidateCompanionChatHistory, getActiveCompanionResults, hasCompanionChatHistoryForHiddenHost, isRetainedCompanionResult,
    normalizeCompanionChatHistoryInjection, normalizeCompanionChatHistoryPlacement, selectCompanionChatHistory } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { shouldRetainContextAtDepth, stripHtmlTagsFromContext, stripOocBlocksFromContext } from '../../public/scripts/ooc-blocks.js';
import { roleplayError } from '../roleplay-store.js';

const invalid = () => roleplayError('ROLEPLAY_AGENT_HISTORY_INVALID', 'The saved Agent history is invalid.', 409);

export function captureAgentHistoryScripts(records, agents) {
    const known = new Map(agents.map(agent => [agent.id, agent]));
    return records.slice(1).map((record, recordIndex) => {
        const snapshot = record.extra?.inChatAgents;
        if (!snapshot) return [];
        if (typeof snapshot !== 'object' || Array.isArray(snapshot)) throw invalid();
        if (Object.hasOwn(snapshot, 'nativeRegexScripts')) {
            if (!Array.isArray(snapshot.nativeRegexScripts) || !Array.isArray(snapshot.regexScriptRefs)) throw invalid();
            return snapshot.regexScriptRefs.map(reference => {
                const entry = snapshot.nativeRegexScripts.find(entry => entry.agentId === reference.agentId && entry.script?.id === reference.scriptId);
                if (!entry || getRegexScriptRevision(entry.script) !== reference.revision) throw invalid();
                return structuredClone(entry.script);
            });
        }
        if (snapshot.regexScriptRefs !== undefined) {
            if (!Array.isArray(snapshot.regexScriptRefs)) throw invalid();
            return snapshot.regexScriptRefs.flatMap(reference => {
                const script = known.get(reference.agentId)?.regexScripts.find(script => script.id === reference.scriptId);
                return script ? [structuredClone(script)] : [];
            });
        }
        if (snapshot.regexScripts !== undefined && !Array.isArray(snapshot.regexScripts)) throw invalid();
        return (snapshot.regexScripts ?? []).map((script, index) => normalizeRegexScript({ ...script, id: script.id || `history:${recordIndex}:${index}` }));
    });
}

export function captureCompanionHistoryPolicies(records) {
    const policies = new Map();
    for (const record of records.slice(1)) {
        if (record.is_user) continue;
        for (const [id, result] of Object.entries(getActiveCompanionResults(record))) {
            if (isRetainedCompanionResult(result)) policies.set(id, {
                chatHistoryDepth: Math.max(1, Math.floor(Number(result.chatHistoryDepth) || 1)),
                includeAllChatHistory: result.includeAllChatHistory !== false,
                chatHistoryPlacement: normalizeCompanionChatHistoryPlacement(result.chatHistoryPlacement),
                chatHistoryInjection: normalizeCompanionChatHistoryInjection(result.chatHistoryInjection),
            });
        }
    }
    return Object.fromEntries(policies);
}

export function applyAgentHistoryRegex(text, record, scripts, depth, snapshot, environment) {
    const substitute = (value, overrides = {}, postProcess) => environment.evaluate(value, {
        legacy: !snapshot.experimentalMacroEngine, strictCapabilities: true,
        original: overrides.original, postProcess: overrides.postProcessFn ?? postProcess,
    });
    return applyRegexScriptList(text, scripts ?? [], record.is_user ? 1 : 2, {
        isPrompt: true, depth, characterOverride: snapshot.speakerNames.character,
        substituteParamsFn: substitute, substituteParamsExtendedFn: substitute,
    });
}

/** Prompt-only notes keep the macro identity and regex depth of the message that originally hosted them. */
export function prepareCompanionPromptHistory(records, snapshot, environment, { scripts = [], policies } = {}) {
    const messages = records.slice(1);
    const indices = new Map(messages.map((message, index) => [message, index]));
    const core = messages.filter(message => !message.is_system || message.extra?.tool_invocations || hasCompanionChatHistoryForHiddenHost(message));
    const candidates = core.filter(message => !(snapshot.global.trigger === 'continue' && message === messages.at(-1)));
    const selections = selectCompanionChatHistory(candidates, { policyMessages: messages, policies });
    const resolve = message => content => {
        const names = environment.names;
        environment.names = { ...names, char: String(message.name ?? '').trim() || names.char };
        try {
            return environment.evaluate(content, { legacy: !snapshot.experimentalMacroEngine, strictCapabilities: true,
                original: message.is_system ? '' : message.mes });
        } finally { environment.names = names; }
    };
    const { host, entries } = consolidateCompanionChatHistory(candidates, selections, resolve,
        message => !Array.isArray(message.extra?.tool_invocations), { policyMessages: messages, policies });
    const transformed = entries.map(({ message, contribution, agentId, placement, host: entryHost, injection }) => {
        const index = indices.get(message), sourceIndex = core.indexOf(message);
        const depth = core.length - sourceIndex - (snapshot.global.trigger === 'continue' ? 2 : 1);
        const contextDepth = Math.max(0, core.length - sourceIndex - 1);
        const retain = value => stripHtmlTagsFromContext(stripOocBlocksFromContext(value,
            shouldRetainContextAtDepth(contextDepth, snapshot.contextRetention?.ooc)),
        shouldRetainContextAtDepth(contextDepth, snapshot.contextRetention?.html));
        const afterAgent = applyAgentHistoryRegex(contribution.content, message, scripts[index], depth, snapshot, environment);
        const content = retain(applyAgentHistoryRegex(afterAgent, message, snapshot.regex, depth, snapshot, environment));
        const worldInfoContent = afterAgent === contribution.content ? content
            : retain(applyAgentHistoryRegex(contribution.content, message, snapshot.regex, depth, snapshot, environment));
        return { content, worldInfoContent, hostIndex: entryHost ? indices.get(entryHost) : -1,
            agentId, placement, injection, contribution: { name: contribution.name } };
    });
    const blocks = buildCompanionChatHistoryBlocks(transformed, entry => entry.content).map(block => ({ key: block.key, content: block.content,
        position: block.position, depth: block.depth, role: ['system', 'user', 'assistant'][block.role], scan: block.scan }));
    return { hostIndex: host ? indices.get(host) : -1, entries: transformed.filter(entry => entry.placement !== 'block')
        .map(({ content, worldInfoContent, hostIndex }) => ({ content, worldInfoContent, hostIndex })), blocks };
}
