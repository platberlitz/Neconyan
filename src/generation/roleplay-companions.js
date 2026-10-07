import path from 'node:path';
import { readArtifact, writeArtifact, createProviderScope } from '../jobs/artifacts.js';
import { readRoleplayFile, roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { getCounter } from '../mewmory/tokens.js';
import { captureRoleplayWorldInfo, prepareRoleplayWorldInfo } from './world-info.js';
import { readRoleplayAgents } from './roleplay-agents-source.js';
import { isNativeCompanion } from './agent-definition.js';
import { runAgentModelStep } from './agent-model-step.js';
import { runRoleplayAgentPostprocessing } from './roleplay-agent-processing.js';
import { companionMessageTokens, previousCompanionNotes, resolveCompanionText, singleCompanionPrompt, batchCompanionPrompt } from './companion-context.js';
import { classifyCompanionFailureMessage, getActiveCompanionResults, isEmptyOutputSentinel, MEMORY_SHARD_TEMPLATE_ID } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { getCompanionTrackerAutoRepairPayload, inspectCompanionTrackerOutput, normalizeCompanionTrackerRepairPayload } from '../../public/scripts/extensions/in-chat-agents/tracker-state.js';
import { captureCompanionCapacity, MAX_COMPANION_RESULT_BYTES } from './companion-capacity.js';

const clean = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const content = value => clean(value).replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1').trim().slice(0, 65536);
const fail = message => roleplayError('ROLEPLAY_COMPANION_INVALID', message, 409);
const references = agent => [...new Set([agent.id, agent.sourceTemplateId].filter(Boolean))];

function saved(context, account, key, identity) {
    return withRoleplayAccount({ owner: context.owner, directories: context.directories }, account, () => {
        const value = readArtifact(context.directories, context.job.id, key);
        if (value === undefined) return null;
        if (!value || typeof value !== 'object') throw fail('The saved companion stage is invalid.');
        const { hash, ...data } = value;
        if (data.identity !== identity || hash !== roleplayHash(data)) throw fail('The saved companion stage differs from its accepted input.');
        return value;
    });
}

function persist(context, account, key, data) {
    const value = { ...data, hash: roleplayHash(data) };
    const limit = key === 'roleplay-companions' ? MAX_COMPANION_RESULT_BYTES : 2 * 1024 * 1024;
    if (Buffer.byteLength(JSON.stringify(value)) > limit) throw fail('The saved companion stage is too large.');
    withRoleplayAccount({ owner: context.owner, directories: context.directories }, account, () => {
        const previous = readArtifact(context.directories, context.job.id, key);
        if (previous !== undefined && roleplayHash(previous) !== roleplayHash(value)) throw fail('The saved companion stage cannot be replaced.');
        if (previous === undefined) writeArtifact(context.directories, context.job.id, key, value);
    });
    return value;
}

/** The prospective host stays private until the reply and every companion effect can be committed. */
export function companionHostRecords(records, value, effect, assistantName) {
    const result = structuredClone(records);
    if (effect === 'continue') {
        result.at(-1).mes = value;
        result.at(-1).name = assistantName;
    } else {
        result.push({ is_user: false, is_system: false, name: assistantName, mes: value, extra: {} });
    }
    return result;
}

function referenceMap(agents) {
    const result = new Map();
    for (const agent of agents) for (const id of references(agent)) if (!result.has(id)) result.set(id, agent);
    return result;
}

function dependencies(agent, index) {
    return [...new Map(agent.companion.dependencies.map(id => index.get(id)).filter(Boolean).map(value => [value.id, value])).values()];
}

function linkedContext(options, agent, sources, index, completed) {
    const entries = new Map();
    for (const source of dependencies(agent, index)) entries.set(source.id, { source, dependency: true });
    for (const source of sources) {
        if (!source.companion.sendContextToCompanions || source.id === agent.id) continue;
        if (source.companion.contextRecipientAgentIds.some(id => references(agent).includes(id))) {
            entries.set(source.id, { source, dependency: entries.get(source.id)?.dependency ?? false });
        }
    }
    return [...entries.values()].flatMap(({ source, dependency }) => {
        const current = completed.get(source.id);
        const prior = current?.success ? current.record : previousCompanionNotes(options, source, { depth: 1, before: options.messages.length })[0]?.note;
        if (prior?.status !== 'done' || !clean(prior.content) || isEmptyOutputSentinel(prior.content)) return [];
        const text = current?.success ? resolveCompanionText(options, source, prior.content) : previousCompanionNotes(options, source, { depth: 1, before: options.messages.length })[0]?.content;
        return text ? [{ title: `${dependency && current?.success ? 'Completed companion' : 'Companion context'}: ${source.name}`, content: text }] : [];
    });
}

function units(agents, linked, binding) {
    const compatible = agent => roleplayHash({ binding: agent.binding ?? binding, model: agent.binding ? agent.modelOverride : '',
        ...(agent.fallbacks?.length ? { fallbacks: agent.fallbacks.map(fallback => fallback.binding) } : {}),
        context: Object.fromEntries(['contextMessages', 'minContextTokens', 'includeCharacterCard', 'includePersona', 'includeWorldInfo',
            'includeAuthorsNote', 'includeSystemPrompt', 'includeHistory', 'historyDepth'].map(key => [key, agent.companion[key]])), linked: linked.get(agent.id) ?? [] });
    const ids = referenceMap(agents), edges = new Map(agents.map(agent => [agent.id, new Set()]));
    for (const agent of agents.filter(item => item.companion.batch)) {
        for (const id of agent.companion.batchAgentIds) {
            const other = ids.get(id);
            if (!other || other.id === agent.id || compatible(other) !== compatible(agent)) continue;
            edges.get(agent.id).add(other.id); edges.get(other.id).add(agent.id);
        }
    }
    const visited = new Set(), batches = [], singles = [];
    for (const agent of agents) {
        if (visited.has(agent.id)) continue;
        const queue = [agent.id], selected = new Set();
        while (queue.length) {
            const id = queue.shift();
            if (selected.has(id)) continue;
            selected.add(id); visited.add(id); queue.push(...edges.get(id));
        }
        const group = agents.filter(item => selected.has(item.id));
        (group.length > 1 ? batches : singles).push(group);
    }
    return [...batches, ...singles];
}

function parseBatch(text) {
    const result = new Map();
    const pattern = /<<<companion:([^>\r\n]+)>>>\s*([\s\S]*?)\s*<<<end:\1>>>/gi;
    for (const match of text.matchAll(pattern)) result.set(match[1].trim(), content(match[2]));
    return result;
}

async function worldInfoContext(context, options, agents, identity) {
    if (!agents.some(agent => agent.companion.includeWorldInfo)) return '';
    const key = 'roleplay-companion-world-info';
    const previous = saved(context, options.snapshot.account, key, identity);
    if (previous) return previous.text;
    await options.assertCurrent?.();
    const snapshot = captureRoleplayWorldInfo(options.base, options.snapshot.account, options.snapshot.source, {
        avatar: options.snapshot.avatar, tokenizer: options.snapshot.tokenizer, maxContext: 4096, serverPrompt: true, trigger: options.snapshot.global.trigger,
        agentIds: options.snapshot.agents?.forcedIds ?? [], agentContext: options.snapshot.agentContext ?? false,
    });
    const pre = readArtifact(context.directories, context.job.id, 'roleplay-agents-pre');
    const selection = await prepareRoleplayWorldInfo(options.base, snapshot, { macros: options.macros,
        promptChat: options.messages.filter(message => !message.is_system).map(message => String(message.mes ?? '')).reverse(),
        promptInjections: (pre?.extensions ?? []).filter(extension => extension.scan).map(extension => extension.content) });
    await options.assertCurrent?.();
    return persist(context, snapshot.account, key, { identity, text: [selection.worldInfoBefore, selection.worldInfoAfter].filter(Boolean).join('\n'),
        selectionHash: roleplayHash(selection) }).text;
}

function baseRecord(agent, model) {
    return { agentName: agent.name, agentCategory: agent.category, icon: agent.icon, profileId: model?.profileId ?? '', profileLabel: model?.fallbackLabel || agent.profileLabel || 'Main model',
        modelLabel: model?.model ?? agent.modelOverride, format: agent.companion.format, displayMode: agent.companion.displayMode,
        includeInChatHistory: agent.companion.includeInChatHistory, chatHistoryDepth: agent.companion.chatHistoryDepth,
        includeAllChatHistory: agent.companion.includeAllChatHistory, keepInChatHistoryWhenHostHidden: agent.companion.keepInChatHistoryWhenHostHidden };
}

/** Run automatic or explicitly selected companions from saved inputs and acknowledged provider steps. */
export async function runRoleplayCompanions(context, options) {
    const { base, snapshot, records, value, generationType, effect, assistantName, binding, generate, assertCurrent } = options;
    const identity = roleplayHash({ intent: context.job.intent, records, value, generationType, effect,
        ...(options.selectedAgentIds ? { selectedAgentIds: options.selectedAgentIds, repair: Boolean(options.repair) } : {}) });
    const key = 'roleplay-companions';
    const previous = saved(context, snapshot.account, key, identity);
    if (previous) return previous;
    await assertCurrent?.();
    const all = readRoleplayAgents(base, snapshot);
    const hidden = new Set(snapshot.agents.hiddenIds ?? []);
    const sources = all.filter(agent => isNativeCompanion(agent) && agent.prompt.trim() && (options.selectedAgentIds || !hidden.has(agent.id)));
    const index = referenceMap(sources);
    const pre = readArtifact(context.directories, context.job.id, 'roleplay-agents-pre');
    if (!pre || pre.intentHash !== roleplayHash(context.job.intent) || pre.policyHash !== roleplayHash(snapshot.agents)) throw fail('The companion activation input needs recovery.');
    const { hash: preHash, ...preData } = pre;
    if (preHash !== roleplayHash(preData)) throw fail('The companion activation input is damaged.');
    const preparedRecords = companionHostRecords(records, value, effect, assistantName);
    const messages = preparedRecords.slice(1);
    const hostResults = getActiveCompanionResults(messages.at(-1));
    const capacity = captureCompanionCapacity(all, records, snapshot.source, { agentContext: Boolean(snapshot.agentContext),
        trigger: snapshot.global?.trigger, hiddenIds: snapshot.agents.hiddenIds });
    if (roleplayHash(capacity) !== roleplayHash(snapshot.companionCapacity ?? null)) {
        throw fail('The admitted Companion result capacity differs from its saved source.');
    }
    const input = { ...options, records: preparedRecords, messages };
    const settings = withRoleplayAccount(base, snapshot.account, () => JSON.parse(readRoleplayFile(path.join(base.directories.root, 'settings.json'), 64 * 1024 * 1024).bytes.toString('utf8')));
    input.systemPrompt = String(settings.power_user?.sysprompt?.content ?? '');
    input.authorsNote = clean(records[0]?.chat_metadata?.note_prompt) || String(settings.extension_settings?.note?.default ?? '');
    const availableTokens = messages.filter(message => !message.is_system).reduce((total, message) => total + companionMessageTokens(message), 0);
    let pending = options.selectedAgentIds ? sources.filter(agent => options.selectedAgentIds.some(id => references(agent).includes(id)))
        : sources.filter(agent => pre.activeIds.includes(agent.id) && agent.companion.trigger === 'auto' && availableTokens >= agent.companion.minContextTokens);
    if (options.selectedAgentIds?.length && !pending.length) throw fail('The selected companion is not enabled in this saved context.');
    input.worldInfo = await worldInfoContext(context, input, sources, identity);
    const { count } = await getCounter(snapshot.tokenizer);
    const completed = new Map(), visited = new Set(pending.map(agent => agent.id)), changed = new Set();
    const shared = { ...context, providerScope: context.providerScope ?? createProviderScope(context) };
    const isRepairTarget = agent => Boolean(options.repair && (!options.selectedAgentIds || options.selectedAgentIds.some(id => references(agent).includes(id))));

    const storeResult = (agent, runIdentity, record, success) => {
        const prior = Object.hasOwn(hostResults, agent.id) ? hostResults[agent.id] : null;
        return persist(context, snapshot.account, `roleplay-companion:${agent.id}`, { identity: runIdentity, agentId: agent.id, record, success,
            changed: success && clean(prior?.content) !== clean(record.content) });
    };
    const failedResult = (agent, runIdentity, reason, model = null) => {
        const cached = saved(context, snapshot.account, `roleplay-companion:${agent.id}`, runIdentity);
        if (cached) return cached;
        const prior = Object.hasOwn(hostResults, agent.id) ? hostResults[agent.id] : null;
        const failureKind = classifyCompanionFailureMessage(reason) || 'other';
        const record = prior?.status === 'done' ? { ...prior, lastRunError: reason, lastRunFailureKind: failureKind }
            : { ...baseRecord(agent, model), status: 'error', content: '', error: reason, failureKind, tokenUsage: null, updatedAt: Date.now() };
        return storeResult(agent, runIdentity, record, false);
    };
    const usageOf = async (prompt, raw) => ({ inputTokens: await count(JSON.stringify(prompt.messages)),
        outputTokens: await count(JSON.stringify({ role: 'assistant', content: content(raw) })) });
    // Automatic tracker runs keep only the tracker block: story prose is regenerated once, a broken block gets one repair pass.
    const cleanTrackerOutput = async (agent, text, sections, stepName) => {
        const usage = [];
        let model = null;
        const ask = async (repair, extra, suffix) => {
            const prompt = singleCompanionPrompt({ ...input, repair }, agent, extra);
            model = await runModel(agent, `${stepName}:${suffix}`, prompt, agent.companion.maxTokens);
            usage.push(await usageOf(prompt, model.text));
            return model.lengthLimited ? null : content(model.text);
        };
        const done = value => ({ text: value, model, usage });
        const failed = reason => ({ error: reason, model, usage });
        let check = inspectCompanionTrackerOutput(agent, text);
        if (check.action === 'keep') return done(check.content);
        let broken = text;
        if (check.action === 'regenerate') {
            const fallback = check.content;
            const next = await ask(false, sections, 'tracker-regenerate');
            if (next === null) return failed('The reply reached its output limit.');
            check = inspectCompanionTrackerOutput(agent, next);
            if (check.action === 'keep') return done(check.content);
            if (check.content || fallback) return done(check.content || fallback);
            broken = next;
        }
        const repaired = await ask(true, [...sections, { title: 'Current companion agent note', content: broken }], 'tracker-repair');
        if (repaired === null) return failed('The reply reached its output limit.');
        const payload = getCompanionTrackerAutoRepairPayload(agent, repaired);
        return payload ? done(payload) : failed('Tracker repair returned invalid output.');
    };
    const finishResult = async (agent, raw, model, prompt, runIdentity, tokenUsage, coverage, sections = [], stepName = `companion:${agent.id}`) => {
        const cached = saved(context, snapshot.account, `roleplay-companion:${agent.id}`, runIdentity);
        if (cached) return cached;
        if (model.lengthLimited) return failedResult(agent, runIdentity, 'The reply reached its output limit.', model);
        let text = content(raw);
        if (!text) return failedResult(agent, runIdentity, 'Companion returned no output.', model);
        let usage = tokenUsage ?? await usageOf(prompt, raw);
        if (!isRepairTarget(agent) && agent.category === 'tracker') {
            const cleaned = await cleanTrackerOutput(agent, text, sections, stepName);
            usage = cleaned.usage.reduce((total, next) => ({ inputTokens: total.inputTokens + next.inputTokens,
                outputTokens: total.outputTokens + next.outputTokens }), usage);
            if (cleaned.error) return failedResult(agent, runIdentity, cleaned.error, cleaned.model ?? model);
            text = cleaned.text;
            model = cleaned.model ?? model;
        }
        const post = await runRoleplayAgentPostprocessing(shared, { ...options, companionAgent: agent, generationType: 'companion_output',
            namespace: `companion:${agent.id}`, value: text, records: preparedRecords, assertCurrent, generate });
        text = content(post.text);
        if (isRepairTarget(agent) && agent.category === 'tracker') {
            text = normalizeCompanionTrackerRepairPayload(agent, text).payload;
            if (!text) return failedResult(agent, runIdentity, 'Tracker repair returned invalid output.', model);
        } else if (!text) return failedResult(agent, runIdentity, 'Companion returned no output.', model);
        const prior = Object.hasOwn(hostResults, agent.id) ? hostResults[agent.id] : {};
        const record = { ...prior, ...baseRecord(agent, model), status: 'done', content: text, error: '', tokenUsage: usage, updatedAt: model.completedAt };
        delete record.lastRunError; delete record.lastRunFailureKind; delete record.failureKind; delete record.previousResult;
        if (references(agent).includes(MEMORY_SHARD_TEMPLATE_ID) && coverage) record.contextCoverage = coverage;
        return storeResult(agent, runIdentity, record, true);
    };
    const runModel = (agent, name, prompt, maxTokens) => runAgentModelStep(shared, { base, account: snapshot.account, name,
        identity: roleplayHash({ identity, agents: name, messages: prompt.messages }), binding: agent.binding ?? binding,
        modelOverride: agent.binding ? agent.modelOverride : '', fallbacks: agent.fallbacks, maxTokens, macros: options.macros, tokenizer: snapshot.tokenizer,
        fallbackContext: snapshot.maxContext, assertCurrent, generate, buildMessages: () => prompt.messages });
    const runSingle = async (agent, sections, suffix = '') => {
        const runIdentity = roleplayHash({ identity, agent: agent.id, sections, suffix });
        const cached = saved(context, snapshot.account, `roleplay-companion:${agent.id}`, runIdentity);
        if (cached) return cached;
        const prior = Object.hasOwn(hostResults, agent.id) ? hostResults[agent.id] : null;
        if (isRepairTarget(agent) && agent.category === 'tracker' && prior?.content) {
            const normalised = normalizeCompanionTrackerRepairPayload(agent, prior.content).payload;
            if (normalised) {
                const record = { ...prior, ...baseRecord(agent, null), status: 'done', content: normalised, error: '', updatedAt: Date.now() };
                delete record.lastRunError; delete record.lastRunFailureKind; delete record.failureKind; delete record.previousResult;
                return storeResult(agent, runIdentity, record, true);
            }
        }
        const extra = isRepairTarget(agent) && prior?.content ? [...sections, { title: 'Current companion agent note', content: prior.content }] : sections;
        const prompt = singleCompanionPrompt({ ...input, repair: isRepairTarget(agent) }, agent, extra);
        const stepName = `companion:${agent.id}${suffix}`;
        const model = await runModel(agent, stepName, prompt, agent.companion.maxTokens);
        return finishResult(agent, model.text, model, prompt, runIdentity, null, prompt.coverage, sections, stepName);
    };
    const runUnit = async (group, sections) => {
        if (group.length === 1 || group.some(isRepairTarget)) {
            const outputs = [];
            for (const agent of group) outputs.push(await runSingle(agent, sections.get(agent.id)));
            return outputs;
        }
        const linked = sections.get(group[0].id), prompt = batchCompanionPrompt(input, group, linked);
        const name = `companion-batch:${roleplayHash(group.map(agent => agent.id))}`;
        const model = await runModel(group[0], name, prompt, Math.min(64000, group.reduce((total, agent) => total + agent.companion.maxTokens, 0)));
        const parsed = parseBatch(model.text);
        const taskCounts = await Promise.all(prompt.tasks.map(task => count(task.content)));
        const total = await count(JSON.stringify(prompt.messages)), sharedTokens = Math.max(0, total - taskCounts.reduce((sum, value) => sum + value, 0)) / group.length;
        const outputs = [];
        for (let offset = 0; offset < group.length; offset++) {
            const agent = group[offset], runIdentity = roleplayHash({ identity, agent: agent.id, batch: name, sections: sections.get(agent.id) });
            if (model.lengthLimited) outputs.push(failedResult(agent, runIdentity, 'The reply reached its output limit.', model));
            else if (!parsed.get(agent.id)) outputs.push(await runSingle(agent, sections.get(agent.id), ':missing-batch-result'));
            else outputs.push(await finishResult(agent, parsed.get(agent.id), model, prompt, runIdentity, {
                inputTokens: Math.round(taskCounts[offset] + sharedTokens), outputTokens: await count(JSON.stringify({ role: 'assistant', content: parsed.get(agent.id) })) },
            prompt.coverage, sections.get(agent.id), `${name}:${agent.id}`));
        }
        return outputs;
    };

    while (pending.length) {
        const remaining = new Set(pending.map(agent => agent.id));
        const blocked = pending.filter(agent => agent.companion.waitForDependencies && dependencies(agent, index).some(dependency => completed.has(dependency.id) && !completed.get(dependency.id).success));
        const ready = pending.filter(agent => !blocked.includes(agent) && (!agent.companion.waitForDependencies || dependencies(agent, index).every(dependency => !remaining.has(dependency.id))));
        const cyclic = ready.length || blocked.length ? [] : pending;
        for (const agent of [...blocked, ...cyclic]) {
            const runIdentity = roleplayHash({ identity, agent: agent.id, dependencyFailure: true });
            const result = saved(context, snapshot.account, `roleplay-companion:${agent.id}`, runIdentity)
                ?? failedResult(agent, runIdentity, cyclic.length ? 'Companion dependencies form a cycle.' : 'A required companion did not complete.');
            completed.set(agent.id, result);
        }
        const sections = new Map(ready.map(agent => [agent.id, linkedContext(input, agent, sources, index, completed)]));
        const groups = units(ready, sections, binding);
        let results = [];
        if (snapshot.agents.companionMode === 'parallel') {
            const settled = await Promise.allSettled(groups.map(group => runUnit(group, sections)));
            const failure = settled.find(item => item.status === 'rejected');
            if (failure) throw failure.reason;
            results = settled.flatMap(item => item.value);
        } else for (const group of groups) results.push(...await runUnit(group, sections));
        for (const result of results) {
            completed.set(result.agentId, result);
            if (result.changed) changed.add(result.agentId);
        }
        pending = pending.filter(agent => !completed.has(agent.id));
        if (!pending.length) {
            pending = sources.filter(agent => !visited.has(agent.id) && dependencies(agent, index).some(dependency => changed.has(dependency.id)));
            for (const agent of pending) visited.add(agent.id);
        }
    }
    const resultEntries = new Map(Object.entries(hostResults));
    for (const [id, result] of completed) resultEntries.set(id, result.record);
    return persist(context, snapshot.account, key, { identity, results: Object.fromEntries(resultEntries),
        completed: [...completed.keys()], resultHashes: Object.fromEntries([...completed].map(([id, result]) => [id, result.hash])) });
}
