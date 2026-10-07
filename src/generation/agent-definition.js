import { normalizeRegexScript } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';
import { normalizePromptTransformContextMessages } from '../../public/scripts/extensions/in-chat-agents/prompt-transform-context.js';
import { roleplayError } from '../roleplay-store.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => typeof value === 'string' ? value : '';
const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;
const number = (value, fallback, min, max = Number.MAX_SAFE_INTEGER) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
export const MAX_AGENT_FALLBACK_CONNECTIONS = 10;
export const isNativeCompanion = agent => agent.execution === 'companion' || agent.category === 'companion';
export const agentTokenLimit = (value, fallback = 8192) => number(value, fallback, 16, 64000);

function identifiers(value) {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : [];
    const ids = [...new Set(values.map(item => String(item ?? '').trim()).filter(Boolean))];
    if (ids.length > 512) throw roleplayError('AGENT_INPUT_INVALID', 'The saved Agent links exceed their limit.', 409);
    return ids;
}

/** Runtime defaults are applied to a bound record without assigning new random identities. */
export function nativeAgentDefinition(raw) {
    const pre = object(raw.preProcess), post = object(raw.postProcess), companion = object(raw.companion);
    const injection = object(raw.injection), conditions = object(raw.conditions);
    const scripts = Array.isArray(raw.regexScripts) ? raw.regexScripts : [];
    const regexScripts = scripts.map((script, index) => normalizeRegexScript({ ...script,
        id: text(script?.id).trim() || `${raw.id}:regex:${index}` }));
    if (!scripts.length && post.enabled && post.type === 'regex' && text(post.regexFind).trim()) {
        const find = post.regexFind.trim();
        regexScripts.push(normalizeRegexScript({ id: `legacy-${raw.id}`, scriptName: `${raw.name || 'Agent'} regex`,
            findRegex: /^\/.+\/[a-z]*$/i.test(find) ? find : `/${find.replace(/\//g, '\\/')}/${text(post.regexFlags) || 'g'}`,
            replaceString: text(post.regexReplace), markdownOnly: true }));
    }
    const category = oneOf(raw.category, ['content', 'tracker', 'randomizer', 'custom', 'tool', 'companion'], 'custom');
    const order = Number(injection.order);
    const definition = {
        id: raw.id, name: text(raw.name) || 'Agent', icon: text(raw.icon), description: text(raw.description), prompt: text(raw.prompt),
        category, execution: raw.execution === 'companion' || category === 'companion' ? 'companion' : 'inline',
        sourceTemplateId: text(raw.sourceTemplateId), phase: oneOf(raw.phase, ['pre', 'post', 'both'], 'pre'),
        connectionProfile: text(raw.connectionProfile).trim(), modelOverride: text(raw.modelOverride).trim(),
        injection: { position: number(injection.position, 1, 0, 2), depth: number(injection.depth, 1, 0, 99),
            role: number(injection.role, 0, 0, 2), order: Number.isFinite(order) ? order : 100, scan: Boolean(injection.scan) },
        preProcess: { mode: oneOf(pre.mode, ['inject', 'intercept'], 'inject'),
            interceptTiming: oneOf(pre.interceptTiming, ['pre-generation', 'post-main-generation'], 'pre-generation'),
            applyMode: oneOf(pre.applyMode, ['replace', 'wrap', 'patch'], 'replace'), wrapPosition: pre.wrapPosition === 'before' ? 'before' : 'after',
            wrapPrefix: text(pre.wrapPrefix), wrapSuffix: text(pre.wrapSuffix), patchStartTag: text(pre.patchStartTag) || '<context_patch>',
            patchEndTag: text(pre.patchEndTag) || '</context_patch>', maxTokens: agentTokenLimit(pre.maxTokens) },
        postProcess: { enabled: Boolean(post.enabled), type: oneOf(post.type, ['regex', 'append', 'extract'], 'regex'),
            appendText: text(post.appendText), extractPattern: text(post.extractPattern), extractVariable: text(post.extractVariable),
            promptTransformEnabled: Boolean(post.promptTransformEnabled), promptTransformMode: post.promptTransformMode === 'append' ? 'append' : 'rewrite',
            promptTransformMaxTokens: agentTokenLimit(post.promptTransformMaxTokens),
            promptTransformContextMessages: normalizePromptTransformContextMessages(post.promptTransformContextMessages) },
        conditions: { generationTypes: Array.isArray(conditions.generationTypes) ? identifiers(conditions.generationTypes) : ['normal', 'continue', 'impersonate'],
            triggerKeywords: Array.isArray(conditions.triggerKeywords) ? identifiers(conditions.triggerKeywords) : [],
            triggerProbability: Number.isFinite(Number(conditions.triggerProbability)) ? Math.max(0, Math.min(100, Number(conditions.triggerProbability))) : 100,
            runOnImpersonate: Boolean(conditions.runOnImpersonate), runOnCompanionOutputs: Boolean(conditions.runOnCompanionOutputs),
            companionOutputTargetAgentIds: identifiers(conditions.companionOutputTargetAgentIds) },
        companion: { ...companion, trigger: oneOf(companion.trigger, ['auto', 'manual'], 'auto'),
            displayMode: oneOf(companion.displayMode, ['card', 'panel', 'hidden'], 'panel'), format: oneOf(companion.format, ['markdown', 'html', 'text'], 'markdown'),
            rawPrompt: Boolean(companion.rawPrompt), inlinePhase: oneOf(companion.inlinePhase, ['pre', 'post', 'both'], ''),
            minContextTokens: number(companion.minContextTokens, 0, 0, 200000), contextMessages: number(companion.contextMessages, 10, 1),
            includeCharacterCard: companion.includeCharacterCard !== false, includePersona: companion.includePersona !== false,
            includeWorldInfo: companion.includeWorldInfo !== false, includeAuthorsNote: companion.includeAuthorsNote !== false,
            includeSystemPrompt: companion.includeSystemPrompt !== false, includeHistory: companion.includeHistory !== false,
            includeInChatHistory: Boolean(companion.includeInChatHistory), includeAllChatHistory: companion.includeAllChatHistory !== false,
            keepInChatHistoryWhenHostHidden: Boolean(companion.keepInChatHistoryWhenHostHidden), chatHistoryDepth: number(companion.chatHistoryDepth, 1, 1),
            historyDepth: number(companion.historyDepth, 3, 1, 10), feedback: { enabled: Boolean(companion.feedback?.enabled), depth: number(companion.feedback?.depth, 1, 1, 10) },
            batch: Boolean(companion.batch), batchAgentIds: identifiers(companion.batchAgentIds),
            sendContextToCompanions: Boolean(companion.sendContextToCompanions), contextRecipientAgentIds: identifiers(companion.contextRecipientAgentIds),
            dependencies: identifiers(companion.dependencies), waitForDependencies: Boolean(companion.waitForDependencies), maxTokens: agentTokenLimit(companion.maxTokens, 64000) },
        regexScripts, settings: object(raw.settings), tools: Array.isArray(raw.tools) ? raw.tools : [],
    };
    return definition;
}

export function agentNeedsModel(agent) {
    if (isNativeCompanion(agent)) return Boolean(agent.prompt.trim());
    if (agent.category === 'tool' || !agent.prompt.trim()) return false;
    return ['pre', 'both'].includes(agent.phase) && agent.preProcess.mode === 'intercept'
        || agent.postProcess.promptTransformEnabled
            && (['post', 'both'].includes(agent.phase) || agent.conditions.runOnCompanionOutputs);
}
