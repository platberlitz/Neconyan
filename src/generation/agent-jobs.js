import path from 'node:path';
import { registerHandler } from '../jobs/runner.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { admitRoleplayJob, applyRoleplayJobEffect, readRoleplayJobResult } from '../roleplay-jobs.js';
import { readRoleplayFile, roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { readAgentRecordLocked } from '../in-chat-agent-storage.js';
import { getCounter } from '../mewmory/tokens.js';
import { assertRoleplaySourceLocked } from './roleplay-source.js';
import { captureRoleplayWorldInfo, assertRoleplayWorldInfoCurrent } from './world-info.js';
import { captureGenerationBinding } from './profiles.js';
import { savedRoleplayMacroSnapshot } from './roleplay-prompt.js';
import { captureRoleplayAgents, readRoleplayAgents, readRoleplayHistoryAgents, agentHistorySources } from './roleplay-agents-source.js';
import { isNativeCompanion, nativeAgentDefinition } from './agent-definition.js';
import { agentMessageExtra, agentTransformHistory, mergeAgentRegexSnapshot, reconcileAgentTrackerMetadata } from './agent-message-state.js';
import { prepareRoleplayAgentContributions, runRoleplayAgentPostprocessing } from './roleplay-agent-processing.js';
import { runRoleplayCompanions } from './roleplay-companions.js';
import { getActiveCompanionResults } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { roleplayNativeHost } from '../endpoints/chats.js';

const fail = message => roleplayError('ROLEPLAY_AGENT_INVALID', message, 409);
const MODES = new Set(['run', 'companions', 'repair-companions', 'repair-trackers', 'undo', 'redo', 'companion-output']);
const tracker = agent => agent.category === 'tracker' && (['post', 'both'].includes(agent.phase)
    || agent.phase === 'pre' && (agent.postProcess.enabled && agent.postProcess.type === 'extract' || agent.regexScripts.length));

/** Capture a saved message and explicit manual selection, including disabled or hidden selected Agents. */
export function captureAgentRequest(base, account, source, { avatar, mode = 'run', agentIds = [], companionId = '', connection, acknowledgement } = {}) {
    if (!MODES.has(mode) || !Array.isArray(agentIds) || agentIds.length > 512 || agentIds.some(id => typeof id !== 'string' || !id)) throw fail('The manual Agent selection is invalid.');
    const selection = withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source);
        const index = source.message?.index;
        const message = Number.isSafeInteger(index) && index >= 0 ? saved.records[index + 1] : null;
        if (!message || message.is_system || !source.dependencies?.some(item => item.kind === 'character' && item.locator.avatar === avatar)) throw fail('The manual action needs its exact saved message and character.');
        const file = readRoleplayFile(path.join(base.directories.root, 'settings.json'), 8 * 1024 * 1024);
        let settings;
        try { settings = JSON.parse(file.bytes.toString('utf8')); } catch { throw fail('The saved Agent settings are unavailable.'); }
        let ids = [...new Set(agentIds)];
        if (!ids.length && ['companions', 'repair-companions', 'repair-trackers'].includes(mode)) {
            const policy = captureRoleplayAgents(lease, settings, { group: Boolean(source.locator.group), characterAvatars: [avatar], ...agentHistorySources(saved.records) });
            ids = (policy?.agents ?? []).map(reference => nativeAgentDefinition(readAgentRecordLocked(lease, 'agent', reference.id).record))
                .filter(agent => mode === 'companions' ? isNativeCompanion(agent) : mode === 'repair-companions' ? isNativeCompanion(agent) && tracker(agent) : !isNativeCompanion(agent) && tracker(agent)).map(agent => agent.id);
        }
        const definitions = ids.map(id => {
            const stored = readAgentRecordLocked(lease, 'agent', id);
            if (!stored) throw fail('A selected Agent no longer exists.');
            return nativeAgentDefinition(stored.record);
        });
        if (mode === 'run' && definitions.length === 1 && isNativeCompanion(definitions[0])) mode = 'companions';
        if (['run', 'companion-output'].includes(mode) && (definitions.length !== 1 || isNativeCompanion(definitions[0]))) throw fail('Select one inline Agent for this manual edit.');
        if (['companions', 'repair-companions'].includes(mode) && (!definitions.length || definitions.some(agent => !isNativeCompanion(agent)))) throw fail('Select the companion Agents to run.');
        if (mode === 'repair-trackers' && (!definitions.length || definitions.some(agent => !tracker(agent) || isNativeCompanion(agent)))) throw fail('Select inline tracker Agents for this repair.');
        if (message.is_user && !['companions', 'repair-companions', 'companion-output'].includes(mode)) throw fail('This Agent action edits assistant messages only.');
        if (mode === 'companion-output') {
            const note = getActiveCompanionResults(message)[companionId];
            if (typeof companionId !== 'string' || !companionId || note?.status !== 'done' || !note.content?.trim()) throw fail('Select an existing finished companion note.');
        }
        const binding = connection ? captureGenerationBinding(base.directories, connection, acknowledgement) : null;
        return { ids, binding, mode };
    });
    const worldInfo = captureRoleplayWorldInfo(base, account, source, { avatar, maxContext: 8192, serverPrompt: true,
        trigger: 'continue', agentIds: selection.ids, agentContext: true });
    if (!worldInfo.agents) throw fail('The saved message has no Agent work or history to use.');
    const saved = withRoleplayAccount(base, account, lease => assertRoleplaySourceLocked(lease, source));
    const records = saved.records.slice(0, source.message.index + 2);
    const request = { worldInfo, macros: savedRoleplayMacroSnapshot(worldInfo, records), binding: selection.binding,
        agent: { mode: selection.mode, ids: selection.ids, companionId } };
    if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) throw fail('The saved manual Agent context exceeds its limit.');
    return request;
}

export function admitAgentJob(base, account, { operationKey, source, request }) {
    if (!request?.agent || !MODES.has(request.agent.mode) || !request.worldInfo?.agentContext
        || roleplayHash(request.worldInfo.source) !== roleplayHash(source) || roleplayHash(request.worldInfo.account) !== roleplayHash(account)) throw fail('The manual Agent request is not bound to this source.');
    return admitRoleplayJob(base, account, { operationKey, source, request, effect: 'agent', type: 'roleplay.agent', label: 'Run saved Agent action' });
}

export async function runAgentJob(context, { generate, host = roleplayNativeHost, beforeCompletion } = {}) {
    const { job, directories, owner } = context;
    const { roleplay, effect, source, request } = job.intent ?? {};
    if (!roleplay || effect !== 'agent' || !request?.agent) throw fail('The accepted manual Agent action is missing.');
    const base = { owner, directories }, account = { accountId: roleplay.accountId, dataEpoch: roleplay.dataEpoch };
    const completed = readRoleplayJobResult(base, account, { operationKey: roleplay.operationKey, jobId: job.id, effect, source, request });
    if (completed) return { result: completed };
    let output = withRoleplayAccount(base, account, () => readArtifact(directories, job.id, 'agent-manual-output'));
    if (output === undefined) {
        const assertCurrent = () => {
            context.signal.throwIfAborted();
            const saved = withRoleplayAccount(base, account, lease => assertRoleplaySourceLocked(lease, source, { effect }));
            assertRoleplayWorldInfoCurrent(base, request.worldInfo);
            return saved;
        };
        const saved = assertCurrent(), records = saved.records.slice(0, source.message.index + 2), message = records.at(-1);
        const agents = readRoleplayAgents(base, request.worldInfo);
        const selected = agents.filter(agent => request.agent.ids.includes(agent.id));
        const options = { base, snapshot: request.worldInfo, records, policyRecords: saved.records, macros: request.macros, binding: request.binding,
            generationType: 'normal', assistantName: message.name || request.worldInfo.speakerNames.character, assertCurrent, generate, metadataRecords: saved.records };
        prepareRoleplayAgentContributions(context, options);
        let text = message.mes, extra = {}, metadata = {}, proofs = {}, preserveMessage = false;
        if (['companions', 'repair-companions'].includes(request.agent.mode)) {
            const result = await runRoleplayCompanions(context, { ...options, value: text, effect: 'continue', selectedAgentIds: request.agent.ids, repair: request.agent.mode === 'repair-companions' });
            extra.inChatAgentCompanionResults = result.results;
            proofs['roleplay-companions'] = result.hash;
        } else if (['undo', 'redo'].includes(request.agent.mode)) {
            const stored = agentMessageExtra(message, 'inChatAgentTransformHistory');
            const redo = agentMessageExtra(message, 'inChatAgentTransformRedo');
            const redoList = Array.isArray(redo) ? structuredClone(redo) : [];
            if (request.agent.mode === 'undo') {
                const entry = agentTransformHistory(stored, text).at(-1);
                if (!entry) throw fail('There is no matching Agent edit to undo.');
                text = entry.beforeText;
                extra.inChatAgentTransformRedo = [...redoList, entry].slice(-10);
            } else {
                const entry = redoList.at(-1);
                if (!entry || entry.beforeText !== text) throw fail('The saved redo does not match this message text.');
                text = entry.afterText;
                redoList.pop();
                extra.inChatAgentTransformRedo = redoList;
            }
            extra.inChatAgentTransformHistory = Array.isArray(stored) ? stored : [];
        } else {
            const note = request.agent.mode === 'companion-output' ? getActiveCompanionResults(message)[request.agent.companionId] : null;
            const namespace = 'manual';
            const result = await runRoleplayAgentPostprocessing(context, { ...options, namespace, manualAgentIds: request.agent.ids,
                value: note ? note.content : text, includeDisplayRegex: Boolean(note), repairTrackers: request.agent.mode === 'repair-trackers' });
            proofs[`roleplay-agent-post:${namespace}`] = result.hash;
            if (result.failed) preserveMessage = true;
            else if (note) extra.inChatAgentCompanionResults = { ...getActiveCompanionResults(message), [request.agent.companionId]: { ...note, content: result.text, updatedAt: Date.now() } };
            else {
                text = result.text;
                extra = result.extra;
                extra.inChatAgents = mergeAgentRegexSnapshot(message, selected, readRoleplayHistoryAgents(base, request.worldInfo), 'normal');
            }
        }
        if (!preserveMessage && !['companions', 'repair-companions', 'companion-output'].includes(request.agent.mode)) {
            const updated = structuredClone(saved.records);
            updated[source.message.index + 1].mes = text;
            metadata = reconcileAgentTrackerMetadata(agents, updated);
            const { count } = await getCounter(request.worldInfo.tokenizer);
            extra.token_count = await count(text);
        }
        const value = { identity: roleplayHash(job.intent), recordsHash: roleplayHash(saved.records), text, extra, metadata, proofs };
        output = { ...value, hash: roleplayHash(value) };
        if (Buffer.byteLength(JSON.stringify(output)) > 2 * 1024 * 1024) throw fail('The manual Agent result exceeds its saved limit.');
        withRoleplayAccount(base, account, () => writeArtifact(directories, job.id, 'agent-manual-output', output));
    }
    await beforeCompletion?.(output);
    context.signal.throwIfAborted();
    const { hash, ...value } = output ?? {};
    if (hash !== roleplayHash(value) || value.identity !== roleplayHash(job.intent)) throw fail('The saved manual Agent output is damaged.');
    return { result: applyRoleplayJobEffect(base, account, { operationKey: roleplay.operationKey, jobId: job.id, output: { agentOutput: hash } }, host) };
}

registerHandler('roleplay.agent', context => runAgentJob(context));
