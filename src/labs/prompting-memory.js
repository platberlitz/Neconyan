import { hash, POLICY_VERSION, syncSources } from '../mewmory/core.js';
import { readConfig } from '../mewmory/models.js';
import { processingVersion } from '../mewmory/processing.js';
import { recallFingerprint } from '../mewmory/retrieval.js';
import { prepareMewmoryPrompt } from '../mewmory/prepare.js';
import { buildBranchMemoryState, chatMemoryExists, normalizeLocator, readState } from '../mewmory/store.js';
import { readContextSourcesSync, purgeMissingContextSources } from '../mewmory/sources.js';
import { agentCollectionDirectory, readAgentCollection } from '../in-chat-agent-storage.js';
import { getActiveCompanionResults } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';

/** Snapshot existing memories without synchronising or writing their live archive. */
export function capturePromptingMemory(directories, locator, records) {
    locator = normalizeLocator(locator);
    const source = { metadata: records[0].chat_metadata ?? {}, messages: records.slice(1) };
    let state = readState(directories, locator);
    if (!chatMemoryExists(directories, locator) && source.metadata.main_chat && source.metadata.main_chat !== locator.chat) {
        const parent = normalizeLocator({ ...locator, chat: source.metadata.main_chat });
        if (chatMemoryExists(directories, parent)) state = buildBranchMemoryState(readState(directories, parent), locator, source.messages);
    }
    if (!state.enabled) return null;
    const sources = readContextSourcesSync(directories, locator, state, source);
    const legacy = source.messages.some(message => Object.values(getActiveCompanionResults(message))
        .some(result => result?.status === 'done' && !result.agentCategory));
    const trackerAgentIds = legacy ? readAgentCollection(agentCollectionDirectory(directories)).records
        .filter(agent => agent.category === 'tracker').map(agent => agent.id) : [];
    syncSources(state, source.messages, sources, { trackerAgentIds });
    purgeMissingContextSources(directories, state);
    const original = readConfig(directories), config = structuredClone(original);
    // Dry runs have no provider access. Retain configuration identity, never transport credentials.
    for (const role of Object.values(config.roles)) {
        if (role.connection) role.connection = { fingerprint: hash(role.connection) };
        if (role.endpoint) role.endpoint = hash(role.endpoint);
    }
    const oldPolicy = processingVersion(original), policy = processingVersion(config);
    const legacyPolicy = hash([POLICY_VERSION, ...['extractor', 'pawspective'].map(name => hash([original.localOnly, original.roles[name]]))]);
    for (const coverage of [state.coverage, state.checkpoints]) {
        for (const key of Object.keys(coverage)) if ([oldPolicy, legacyPolicy].includes(coverage[key])) coverage[key] = policy;
    }
    for (const recall of state.recalls) {
        if (recall.validationFingerprint === recallFingerprint(state, original, recall.sourceCount)) {
            recall.validationFingerprint = recallFingerprint(state, config, recall.sourceCount);
        }
    }
    return { locator, state, config, sources, trackerAgentIds };
}

/** Each hypothetical prompt gets its own mutable copy; no model or background work is started. */
export function promptingMemoryPreparation(context, plan, tokenizer) {
    return async ({ records, preparedContent }) => {
        context.signal.throwIfAborted();
        if (!plan.memory) return { enabled: false, excludedIndices: [], npcText: '', memoryText: '' };
        const frozen = plan.memory, state = structuredClone(frozen.state);
        const source = { metadata: records[0].chat_metadata ?? {}, messages: records.slice(1) };
        syncSources(state, source.messages, frozen.sources, { trackerAgentIds: frozen.trackerAgentIds });
        return prepareMewmoryPrompt(context.directories, { locator: frozen.locator, tokenizer,
            history: source.messages.flatMap((record, index) => !record.is_system && !record.extra?.nn_generation_failed
                ? [{ index, text: preparedContent[index] ?? String(record.mes ?? '') }] : []),
        }, context.signal, { loadState: () => state, mutate: (_directories, _locator, mutate) => mutate(state),
            readSource: () => source, readConfiguration: () => frozen.config, scheduleBackground: false });
    };
}
