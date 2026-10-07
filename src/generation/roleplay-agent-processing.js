import { appendHelperPrefillMessages } from '../../public/scripts/extensions/helper-prefill.js';
import { buildPromptTransformRecentChat, getAgentLengthTarget } from '../../public/scripts/extensions/in-chat-agents/prompt-transform-context.js';
import { applyRegexScriptList } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';
import { buildRegexScriptRefsForAgent } from '../../public/scripts/extensions/in-chat-agents/regex-snapshot-store.js';
import { inspectTrackerState, mergeTrackerRepairPayload, TRACKER_REPAIR_INSTRUCTION } from '../../public/scripts/extensions/in-chat-agents/tracker-state.js';
import { composePromptTransformDraft, planPromptTransformStages, runPromptTransformStages } from '../../public/scripts/extensions/in-chat-agents/prompt-transform-synthesis.js';
import { createMacroEnvironment } from '../macros/index.js';
import { createProviderScope, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { readRoleplayAgents, readRoleplayHistoryAgents } from './roleplay-agents-source.js';
import { captureAgentHistoryScripts, captureCompanionHistoryPolicies } from './agent-history.js';
import { prepareCompanionFeedback } from './companion-feedback.js';
import { isNativeCompanion } from './agent-definition.js';
import { runAgentModelStep } from './agent-model-step.js';
import { stripSavedAuxiliaryTrackerEchoes } from '../../public/scripts/extensions/in-chat-agents/companion/companion-tracker-context.js';
import { validateRoleplayToolHistory } from './roleplay-contributions.js';
import { requireJobApproval } from './job-approvals.js';
import { agentMessageExtra, agentTransformHistory, reconcileAgentTrackerMetadata } from './agent-message-state.js';

const fail = message => roleplayError('ROLEPLAY_AGENT_RECOVERY', message, 409);
const join = (left, right) => !left ? right : !right ? left : left + (/\n\n$/.test(left) ? '' : /\n$/.test(left) ? '\n' : '\n\n') + right;
const inline = agent => !isNativeCompanion(agent) && agent.category !== 'tool';
const outputStages = new Set(['normal', 'continue', 'swipe', 'regenerate']);

function readPhase(context, account, name, identity) {
    const saved = withRoleplayAccount({ owner: context.owner, directories: context.directories }, account,
        () => readArtifact(context.directories, context.job.id, name));
    if (saved === undefined) return undefined;
    const { hash, ...data } = saved || {};
    if (hash !== roleplayHash(data) || data.identity !== identity) throw fail('The saved Agent phase changed.');
    return saved;
}

function savePhase(context, account, name, data) {
    const value = { ...data, hash: roleplayHash(data) };
    if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw fail('The Agent phase exceeds its saved limit.');
    return withRoleplayAccount({ owner: context.owner, directories: context.directories }, account, () => {
        const previous = readArtifact(context.directories, context.job.id, name);
        if (previous !== undefined && roleplayHash(previous) !== roleplayHash(value)) throw fail('The saved Agent phase differs.');
        if (previous === undefined) writeArtifact(context.directories, context.job.id, name, value);
        return previous ?? value;
    });
}

function keywordMatches(value, text, companion) {
    if (companion && /^\/[\s\S]+\/[a-z]*$/i.test(value)) {
        const end = value.lastIndexOf('/');
        try { return new RegExp(value.slice(1, end), value.slice(end + 1)).test(text); } catch { /* Match an invalid expression literally, as the saved browser rule does. */ }
    }
    return text.toLowerCase().includes(value.toLowerCase());
}

function activation(agent, records, generationType, random) {
    const conditions = agent.conditions;
    // The browser treats swipes and regenerations as normal replies. Honour
    // explicit saved types too, including records created by server clients.
    const normalReply = ['swipe', 'regenerate'].includes(generationType) && conditions.generationTypes.includes('normal');
    if (conditions.generationTypes.length && !conditions.generationTypes.includes(generationType) && !normalReply) return { active: false, draw: null };
    const draw = conditions.triggerProbability < 100 ? random() * 100 : null;
    if (draw !== null && (!Number.isFinite(draw) || draw < 0 || draw > 100)) throw fail('The Agent activation draw is invalid.');
    if (draw !== null && draw > conditions.triggerProbability) return { active: false, draw };
    const companion = isNativeCompanion(agent);
    const record = companion ? [...records.slice(1)].reverse().find(item => item.is_user && !item.is_system) : records.at(-1);
    const text = typeof record?.mes === 'string' ? record.mes : '';
    const active = !conditions.triggerKeywords.length || Boolean(text && conditions.triggerKeywords.some(key => keywordMatches(key, text, companion)));
    return { active, draw };
}

function aliases(environment, agent, text, generationType, assistantName) {
    for (const key of ['currentmessage', 'lastmessage', 'latestmessage', 'response', 'currentresponse', 'latestresponse', 'assistantmessage']) environment.dynamicMacros[key] = text;
    Object.assign(environment.dynamicMacros, { assistantname: assistantName, agentname: agent.name, generationtype: generationType,
        lengthtarget: getAgentLengthTarget(agent) });
    return environment;
}

function evaluate(environment, text, snapshot) {
    return environment.evaluate(text, { legacy: !snapshot.experimentalMacroEngine, strictCapabilities: true });
}

/** Freeze activation and pre-prompt contributions before history preparation or World Info scanning. */
export function prepareRoleplayAgentContributions(context, { base, snapshot, records, policyRecords = records, macros, generationType, assertCurrent, random = Math.random }) {
    if (!snapshot.agents) return null;
    const identity = roleplayHash({ intent: context.job.intent, agents: snapshot.agents, records, generationType });
    const completed = readPhase(context, snapshot.account, 'roleplay-agents-pre', identity);
    if (completed) return completed;
    assertCurrent();
    const agents = readRoleplayAgents(base, snapshot);
    const decisions = readPhase(context, snapshot.account, 'roleplay-agent-activation', identity)
        ?? savePhase(context, snapshot.account, 'roleplay-agent-activation', { identity,
            decisions: agents.map(agent => ({ id: agent.id, ...activation(agent, records, generationType, random) })) });
    const activeIds = decisions.decisions.filter(item => item.active).map(item => item.id);
    const active = agents.filter(agent => activeIds.includes(agent.id));
    const environment = createMacroEnvironment(macros, {}, { readOnly: true });
    const historyAgents = readRoleplayHistoryAgents(base, snapshot);
    const history = { scripts: captureAgentHistoryScripts(records, historyAgents), policies: captureCompanionHistoryPolicies(policyRecords) };
    const extensions = active.filter(agent => inline(agent) && ['pre', 'both'].includes(agent.phase)
        && agent.preProcess.mode !== 'intercept' && agent.prompt.trim()).map(agent => ({
        key: `inchat_agent_${agent.id}`, content: evaluate(aliases(environment, agent, '', generationType, snapshot.speakerNames?.character || ''), agent.prompt, snapshot),
        position: agent.injection.position, depth: agent.injection.depth, role: ['system', 'user', 'assistant'][agent.injection.role], scan: agent.injection.scan,
    }));
    const feedback = prepareCompanionFeedback(active, historyAgents, records, snapshot, environment, history.policies, generationType);
    extensions.push(...feedback.extensions);
    return savePhase(context, snapshot.account, 'roleplay-agents-pre', { identity, intentHash: roleplayHash(context.job.intent),
        policyHash: roleplayHash(snapshot.agents), generationType, activeIds, extensions, history, trackerTags: feedback.trackerTags, macroState: environment.captureState() });
}

function activeAgents(context, base, snapshot) {
    const saved = withRoleplayAccount(base, snapshot.account, () => readArtifact(context.directories, context.job.id, 'roleplay-agents-pre'));
    const { hash, ...data } = saved || {};
    if (hash !== roleplayHash(data) || data.intentHash !== roleplayHash(context.job.intent) || data.policyHash !== roleplayHash(snapshot.agents)
        || !Array.isArray(data.activeIds) || data.activeIds.some(id => !snapshot.agents.agents.some(agent => agent.id === id))) throw fail('The saved Agent activation is unavailable.');
    return { pre: saved, agents: readRoleplayAgents(base, snapshot).filter(agent => data.activeIds.includes(agent.id)) };
}

function unwrap(value) {
    let text = String(value || '').trim();
    for (let index = 0; index < 8; index++) {
        const match = text.match(/^<(assistant_response|context)>\s*([\s\S]*?)\s*<\/\1>$/i);
        if (!match) break;
        text = match[2].trim();
    }
    return text;
}

function messagesFor(agent, text, prompt, generationType, assistantName, format, intercept, recentChat = '') {
    if (intercept) {
        const post = agent.preProcess.interceptTiming === 'post-main-generation';
        const instruction = post
            ? 'You are modifying an assistant response after the main model has generated it and before it is displayed or saved. Return ONLY the requested replacement, wrapper, or patch. Do not add explanations or markdown fences.'
            : 'You are modifying the complete outgoing context before the main model runs. Return ONLY the requested replacement, wrapper, or patch. When replacing chat context, return the entire valid JSON message array, including any tool calls and results. Do not add explanations or markdown fences.';
        return [{ role: 'system', content: `${prompt}\n\n${instruction}` }, { role: 'user', content: post
            ? `Generation type: ${generationType}\n\nMain model output:\n<assistant_response>\n${text}\n</assistant_response>`
            : `Generation type: ${generationType}\nContext format: ${format === 'chat' ? 'chat JSON' : 'text'}\n\n<context>\n${text}\n</context>` }];
    }
    const instruction = agent.postProcess.promptTransformMode === 'append'
        ? 'Return ONLY the new content to append. Do not repeat, rewrite or summarise the original response. Do not include explanations or markdown fences.'
        : 'Return ONLY the final rewritten response. If no changes are needed, return the original response verbatim. Do not include explanations or markdown fences.';
    const label = generationType === 'impersonate' ? 'Current impersonation text' : generationType === 'companion_output' ? 'Current companion note' : 'Current assistant response';
    const recent = recentChat ? `Recent chat, oldest first. Read-only context: do not rewrite, repeat, or return it.\n<recent_chat>\n${recentChat}\n</recent_chat>\n\n` : '';
    return [{ role: 'system', content: `${prompt}\n\n${instruction}` }, { role: 'user', content: `Assistant name: ${assistantName}\nGeneration type: ${generationType}\n\n${recent}${label}:\n<assistant_response>\n${text}\n</assistant_response>` }];
}

async function modelRun(context, options, agent, text, name, intercept = false, format = 'text') {
    const { base, snapshot, macros, generationType, assertCurrent, generate } = options;
    const { effect, source, request } = context.job.intent;
    const records = options.records ?? [];
    const isNote = options.companionAgent || request?.agent?.mode === 'companion-output';
    const endIndex = !isNote && ['continue', 'agent'].includes(effect) && Number.isInteger(source?.message?.index)
        ? source.message.index + 1 : records.length;
    const recentChat = intercept ? '' : buildPromptTransformRecentChat(records.slice(1, endIndex), agent.postProcess.promptTransformContextMessages, unwrap);
    const result = await runAgentModelStep(context, { base, account: snapshot.account, name,
        identity: roleplayHash({ intent: context.job.intent, agent: snapshot.agents.agents.find(item => item.id === agent.id), text, intercept, format, generationType }),
        binding: agent.binding || options.binding, modelOverride: agent.binding ? agent.modelOverride : '', fallbacks: agent.fallbacks,
        maxTokens: intercept ? agent.preProcess.maxTokens : agent.postProcess.promptTransformMaxTokens,
        macros, tokenizer: snapshot.tokenizer, fallbackContext: snapshot.maxContext, assertCurrent, generate,
        buildMessages: environment => {
            aliases(environment, agent, text, generationType, options.assistantName);
            const prompt = evaluate(environment, agent.prompt, snapshot);
            return appendHelperPrefillMessages(messagesFor(agent, text, prompt, generationType, options.assistantName, format, intercept, recentChat), snapshot.agents.helperPrefill);
        } });
    return { agentId: agent.id, agentName: agent.name, order: agent.injection.order,
        outputText: result.lengthLimited ? '' : unwrap(result.text), status: result.lengthLimited ? 'length-limited' : result.text.trim() ? 'done' : 'empty',
        profileLabel: result.fallbackLabel || result.profileId || 'Main model', modelLabel: result.model, timestamp: result.completedAt, modelHash: result.hash };
}

function interceptResult(original, output, agent, format) {
    const settings = agent.preProcess;
    if (!output) return original;
    if (format === 'chat') {
        if (settings.applyMode === 'replace') {
            let parsed;
            try { parsed = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw fail('The Agent did not return a complete chat context.'); }
            if (!Array.isArray(parsed) || !parsed.length) throw fail('The Agent did not return a complete chat context.');
            validateRoleplayToolHistory(parsed);
            const images = new Set(original.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').map(part => JSON.stringify(part)) : []));
            if (parsed.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' && !images.has(JSON.stringify(part))))) throw fail('An Agent replacement introduced an unbound image.');
            return parsed;
        }
        const content = settings.applyMode === 'patch' ? `${settings.patchStartTag}\n${output}\n${settings.patchEndTag}` : `${settings.wrapPrefix}${output}${settings.wrapSuffix}`;
        const message = { role: ['system', 'user', 'assistant'][agent.injection.role], content };
        return settings.wrapPosition === 'before' ? [message, ...original] : [...original, message];
    }
    if (settings.applyMode === 'replace') return output;
    if (settings.applyMode === 'patch') return join(original, `${settings.patchStartTag}\n${output}\n${settings.patchEndTag}`);
    const addition = `${settings.wrapPrefix}${output}${settings.wrapSuffix}`;
    return settings.wrapPosition === 'before' ? join(addition, original) : join(original, addition);
}

/** Intercept a complete prepared request, or the saved main response, using ordered saved steps. */
export async function runRoleplayAgentInterceptors(context, options) {
    const { base, snapshot, timing = 'pre-generation', format = 'text', value } = options;
    if (!snapshot.agents) return { value, runs: [] };
    const identity = roleplayHash({ intent: context.job.intent, timing, format, value });
    const name = `roleplay-agent-intercepts:${timing}`;
    const completed = readPhase(context, snapshot.account, name, identity);
    if (completed) return completed;
    const { agents } = activeAgents(context, base, snapshot);
    const selected = agents.filter(agent => inline(agent) && ['pre', 'both'].includes(agent.phase) && agent.preProcess.mode === 'intercept'
        && agent.preProcess.interceptTiming === timing && agent.prompt.trim());
    if (selected.length && timing === 'post-main-generation' && snapshot.agents.reviewPostMain) {
        const approval = requireJobApproval(context, { account: snapshot.account, key: 'post-main-interceptors', choices: ['continue', 'skip'],
            proposal: { title: 'Review the main reply before its configured interceptors', response: value, agents: selected.map(agent => ({ id: agent.id, name: agent.name })) } });
        if (approval.decision === null) return { waiting: true, approval };
        if (approval.decision === 'skip') return savePhase(context, snapshot.account, name, { identity, value, runs: [], skipped: true });
    }
    let current = structuredClone(value);
    const runs = [];
    for (const agent of selected) {
        const beforeText = format === 'chat' ? JSON.stringify(current) : current;
        const run = await modelRun(context, options, agent, beforeText, `intercept:${timing}:${agent.id}`, true, format);
        current = interceptResult(current, run.outputText, agent, format);
        const afterText = format === 'chat' ? JSON.stringify(current) : current;
        runs.push({ ...run, beforeText, afterText, changed: beforeText !== afterText, timing, contextFormat: format, applyMode: agent.preProcess.applyMode });
    }
    return savePhase(context, snapshot.account, name, { identity, value: current, runs });
}

function prepend(agent, text) {
    return ['tpl-scene-tracker', 'tpl-time-tracker'].includes(agent.sourceTemplateId) || /^(?:\[|\()(?:SCENE|TIME)\|/i.test(text.trim());
}

/** Save the complete post-pass result; a failed parallel peer never discards acknowledged siblings. */
export function roleplayAgentOutputBaseline(value, pre) {
    return stripSavedAuxiliaryTrackerEchoes(value, pre?.trackerTags ?? [], []);
}

// Old paid steps include preceding append blocks in later inputs. Keep their
// original ordering and exact merge rules instead of invalidating those receipts.
async function runLegacyPromptTransformStages({ agents, text, isAppend, runRewrite, runAppend }) {
    for (const stage of planPromptTransformStages(agents, { isAppend })) {
        if (stage.type === 'rewrite') {
            const outcome = await runRewrite(stage.agents[0], text);
            if (typeof outcome?.text === 'string') text = outcome.text;
            if (outcome?.stop) break;
        } else {
            const outcome = await runAppend(stage.agents, text);
            if (outcome?.stop) break;
            const before = [], after = [];
            for (const { agent, text: output } of outcome?.outputs ?? []) {
                if (!output) continue;
                const blocks = prepend(agent, output) ? before : after;
                if (!blocks.includes(output)) blocks.push(output);
            }
            text = join(join(before.reduce(join, ''), text), after.reduce(join, ''));
        }
    }
    return { draft: { body: text, before: [], after: [] } };
}

function postprocessingPlan(context, account, phaseName, identity, selected, modelName) {
    const name = `${phaseName}:plan`;
    const saved = readPhase(context, account, name, identity);
    if (saved) {
        if (![1, 2].includes(saved.version)) throw fail('The saved Agent postprocessing plan is unsupported.');
        return saved.version;
    }
    const started = withRoleplayAccount({ owner: context.owner, directories: context.directories }, account, () =>
        selected.some(agent => ['input', 'result'].some(part =>
            readArtifact(context.directories, context.job.id, `agent-model:${modelName(agent.id)}:${part}`) !== undefined)));
    // Persist the choice before any new call, so another interruption cannot
    // mistake a new synthesis run for a pre-upgrade run.
    return savePhase(context, account, name, { identity, version: started ? 1 : 2 }).version;
}

export async function runRoleplayAgentPostprocessing(context, options) {
    const { base, snapshot, records, value, generationType, macros } = options;
    if (!snapshot.agents) return { text: value, extra: {}, metadata: {}, runs: [] };
    const identity = roleplayHash({ intent: context.job.intent, records, value, generationType });
    const phaseName = options.namespace ? `roleplay-agent-post:${options.namespace}` : 'roleplay-agent-post';
    const completed = readPhase(context, snapshot.account, phaseName, identity);
    if (completed) return completed;
    const active = activeAgents(context, base, snapshot);
    const pre = active.pre;
    const companionOutput = Boolean(options.companionAgent);
    const targetIds = companionOutput ? [options.companionAgent.id, options.companionAgent.sourceTemplateId].filter(Boolean) : [];
    const manual = Boolean(options.manualAgentIds);
    const agents = manual ? readRoleplayAgents(base, snapshot).filter(agent => options.manualAgentIds.includes(agent.id) && !isNativeCompanion(agent))
        : companionOutput ? readRoleplayAgents(base, snapshot).filter(agent => inline(agent) && agent.id !== options.companionAgent.id
            && agent.conditions.runOnCompanionOutputs && (!agent.conditions.companionOutputTargetAgentIds.length || agent.conditions.companionOutputTargetAgentIds.some(id => targetIds.includes(id)))) : active.agents;
    const selected = agents.filter(agent => (manual || inline(agent) && agent.postProcess.promptTransformEnabled
        && (companionOutput || ['post', 'both'].includes(agent.phase)) && agent.prompt.trim()
        && (companionOutput || outputStages.has(generationType) || generationType === 'impersonate' && (agent.conditions.runOnImpersonate || agent.sourceTemplateId === 'tpl-prose-polisher')))
        && agent.prompt.trim() && (!options.repairTrackers || agent.postProcess.enabled && agent.postProcess.promptTransformEnabled && ['post', 'both'].includes(agent.phase) && agent.postProcess.type !== 'extract'));
    const baseline = companionOutput || manual ? value : roleplayAgentOutputBaseline(value, pre);
    const modelName = id => `${options.namespace ? options.namespace + ':' : ''}post:${id}`;
    const version = postprocessingPlan(context, snapshot.account, phaseName, identity, selected, modelName);
    let postFailed = false;
    const runs = [];
    const parallel = snapshot.agents.appendMode === 'parallel';
    // Run together shares one provider scope, so rewrite and append steps can be in flight at once.
    const scope = parallel ? { ...context, providerScope: context.providerScope ?? createProviderScope(context) } : context;
    const runStages = version === 1 ? runLegacyPromptTransformStages : runPromptTransformStages;
    const { draft } = await runStages({
        agents: selected, text: baseline, parallel, isPrepend: prepend,
        isAppend: agent => agent.postProcess.promptTransformMode === 'append',
        runRewrite: async (agent, body) => {
            const run = await modelRun(scope, options, agent, body, modelName(agent.id));
            runs.push({ ...run, mode: 'rewrite' });
            if (companionOutput && run.status !== 'done') { postFailed = true; return { stop: true }; }
            return run.outputText ? { text: run.outputText } : {};
        },
        runAppend: async (batch, body) => {
            let results;
            if (parallel) {
                const settled = await Promise.allSettled(batch.map(item => modelRun(scope, options, item, body, modelName(item.id))));
                const failed = settled.find(item => item.status === 'rejected');
                if (failed) throw failed.reason;
                results = settled.map(item => item.value);
            } else {
                results = [];
                for (const item of batch) results.push(await modelRun(scope, options, item, body, modelName(item.id)));
            }
            runs.push(...results.map(run => ({ ...run, mode: 'append' })));
            if (companionOutput && results.some(run => run.status !== 'done')) { postFailed = true; return { stop: true }; }
            return { outputs: results.map((run, offset) => ({ agent: batch[offset], text: run.outputText })) };
        },
    });
    const agentOrder = new Map(selected.map((agent, index) => [agent.id, index]));
    runs.sort((left, right) => agentOrder.get(left.agentId) - agentOrder.get(right.agentId));
    let text = composePromptTransformDraft(draft, join);
    if (companionOutput && postFailed || manual && !options.repairTrackers && runs.some(run => run.status === 'length-limited')) {
        return savePhase(context, snapshot.account, phaseName, { identity, text: value, extra: {}, metadata: {}, runs, failed: true });
    }
    const utilities = agents.filter(agent => inline(agent) && agent.postProcess.enabled
        && (['post', 'both'].includes(agent.phase) || agent.postProcess.type === 'extract'));
    const environment = createMacroEnvironment(macros, {}, { readOnly: true });
    if (options.repairTrackers) {
        for (const agent of utilities.filter(item => item.postProcess.type === 'extract' && item.postProcess.extractVariable)) {
            if (inspectTrackerState(agent, text).status === 'valid') continue;
            const repairAgent = { ...agent, prompt: `${agent.prompt}\n\n${TRACKER_REPAIR_INSTRUCTION}`,
                postProcess: { ...agent.postProcess, promptTransformMode: 'append' } };
            const run = await modelRun(context, options, repairAgent, text, `${options.namespace}:repair:${agent.id}`);
            const beforeText = text;
            if (run.outputText) {
                const merged = mergeTrackerRepairPayload(agent, text, run.outputText, { prepend: prepend(agent, run.outputText) });
                if (!merged.reason && inspectTrackerState(agent, merged.text).status === 'valid') text = merged.text;
            }
            runs.push({ ...run, mode: 'tracker-repair', beforeText, afterText: text, changed: text !== beforeText });
        }
    }
    if (!companionOutput && generationType !== 'impersonate' && (!manual || options.repairTrackers)) {
        for (const agent of utilities) {
            if (agent.postProcess.type === 'append') text += options.repairTrackers
                ? evaluate(aliases(environment, agent, text, generationType, options.assistantName), agent.postProcess.appendText, snapshot) : agent.postProcess.appendText;
        }
    }
    for (const agent of agents.filter(agent => manual || inline(agent))) {
        aliases(environment, agent, text, generationType, options.assistantName);
        const regexOptions = { isMarkdown: false, isPrompt: false,
            substituteParamsFn: (input, extra = {}) => environment.evaluate(input, { legacy: !snapshot.experimentalMacroEngine,
                strictCapabilities: true, postProcess: extra.postProcessFn }),
            substituteParamsExtendedFn: (input, _extra, postProcess) => environment.evaluate(input, { legacy: !snapshot.experimentalMacroEngine,
                strictCapabilities: true, postProcess }) };
        if (companionOutput || options.includeDisplayRegex) text = applyRegexScriptList(text, agent.regexScripts, 2, { ...regexOptions, isMarkdown: true });
        text = applyRegexScriptList(text, agent.regexScripts, 2, regexOptions);
    }
    if (companionOutput) return savePhase(context, snapshot.account, phaseName, { identity, text, extra: {}, metadata: {}, runs });
    const trackerRecords = structuredClone(options.metadataRecords ?? records);
    const effect = context.job.intent.effect;
    if (['continue', 'swipe', 'agent'].includes(effect) && context.job.intent.source?.message) trackerRecords[context.job.intent.source.message.index + 1].mes = text;
    else if (effect === 'replace' && context.job.intent.source?.range) trackerRecords.splice(context.job.intent.source.range.start + 1, context.job.intent.source.range.count, { mes: text, is_user: false });
    else trackerRecords.push({ mes: text, is_user: false });
    const metadata = generationType === 'impersonate' ? {} : reconcileAgentTrackerMetadata(utilities, trackerRecords);
    const regexAgents = agents.filter(agent => inline(agent) && agent.regexScripts.length);
    const extra = { inChatAgentPromptRuns: runs, inChatAgents: { activeAgentIds: pre.activeIds, generationType, edited: false,
        regexScriptRefs: regexAgents.flatMap(agent => buildRegexScriptRefsForAgent(agent.id, agent.regexScripts)),
        nativeRegexScripts: regexAgents.flatMap(agent => agent.regexScripts.map(script => ({ agentId: agent.id, script }))) } };
    if (text !== baseline && options.recordHistory !== false) {
        const previous = agentMessageExtra(records.at(-1), 'inChatAgentTransformHistory');
        const history = agentTransformHistory(previous, baseline);
        extra.inChatAgentTransformHistory = [...history, { agentId: runs.at(-1)?.agentId || '', agentName: runs.map(run => run.agentName).join(', '),
            mode: 'combined', order: runs.at(-1)?.order ?? 0, profileLabel: runs.at(-1)?.profileLabel || '', modelLabel: runs.at(-1)?.modelLabel || '',
            beforeText: baseline, afterText: text, timestamp: Date.now() }].slice(-10);
        extra.inChatAgentTransformRedo = [];
    }
    return savePhase(context, snapshot.account, phaseName, { identity, baseline, text, extra, metadata, runs });
}
