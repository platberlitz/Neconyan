import { Worker } from 'node:worker_threads';
import { createMacroEnvironment } from '../macros/index.js';
import { assembleRoleplayChatPrompt } from '../generation/roleplay-chat-prompt.js';
import { createRoleplayTextPrompt } from '../generation/roleplay-text-prompt.js';
import { buildRoleplaySavedHistory, prepareRoleplayHistoryContent, roleplayMacroCapabilities, savedRoleplayMacroSnapshot } from '../generation/roleplay-prompt.js';
import { computeWorldInfoLab } from './world-info-compute.js';
import { createRun, resolveStatus } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/schema.js';
import { evaluateAssertions } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/assertions.js';
import { analyzeCache } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/cache-analyzer.js';
import { compareRuns, findVolatileSpans } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/compare.js';
import { SECTION_LABEL, CAVEAT } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/constants.js';
import { getStringHash } from '../../public/scripts/macro-primitives.js';
import { messagesToText } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/message-content.js';
import { applyWrap } from '../../public/scripts/extensions/third-party/Neconyan-PromptTags/src/wrap.js';
import { isTaggablePromptIdentifier } from '../../public/scripts/extensions/third-party/Neconyan-PromptTags/src/sections.js';
import { createRoleplayLoreMacros } from '../generation/roleplay-lore-macros.js';
import { supportsChatImages, supportsChatSignatures, supportsChatTools } from '../../public/scripts/chat-input-capabilities.js';

const emptyLore = () => ({ worldInfoBefore: '', worldInfoAfter: '', EMEntries: [], ANBeforeEntries: [], ANAfterEntries: [], WIDepthEntries: [], outletEntries: {} });
function testRegex(pattern, text) {
    return new Promise(resolve => {
        const worker = new Worker('const {parentPort,workerData}=require("node:worker_threads");parentPort.postMessage(new RegExp(workerData.pattern).test(workerData.text));',
            { eval: true, workerData: { pattern, text }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
        const finish = result => { clearTimeout(timer); void worker.terminate(); resolve(result); };
        const timer = setTimeout(() => finish({ status: 'timeout', found: null }), 100);
        worker.once('message', found => finish({ status: 'ok', found }));
        worker.once('error', error => finish({ status: 'invalid', error: error.message }));
    });
}

/** A request-local prompt compiler. All transformations run in a bounded native worker. */
export async function compilePromptingCapture({ context: plan, material, scene = [], userMessage = '' }, tokenCount, prepareMemory) {
    const records = structuredClone(plan.records), original = structuredClone(plan.snapshot);
    for (const entry of [...scene, ...(userMessage ? [{ role: 'user', text: userMessage }] : [])]) {
        records.push({ name: entry.role === 'assistant' ? original.speakerNames.character : original.speakerNames.user,
            is_user: entry.role !== 'assistant', is_system: false, mes: String(entry.text) });
    }
    original.authorNote.userMessages = records.slice(1).filter(record => record.is_user).length;
    const macros = savedRoleplayMacroSnapshot(original, records);
    const loreContext = { activeLore: [], boundLore: plan.scan.sourcePlan.all.flatMap(book =>
        Object.values(plan.scan.books[book].book.entries).filter(entry => !entry.disable).map(entry => ({ book, entry,
            title: String(entry.comment ?? '').trim() || String(entry.key?.[0] || entry.uid), content: String(entry.content ?? '') }))) };
    let environment;
    environment = createMacroEnvironment(macros, roleplayMacroCapabilities(original, material, plan.maxTokens,
        plan.maxContext + plan.maxTokens, () => environment), { dynamicMacros: original.enhancedLoreMacros
        ? createRoleplayLoreMacros(loreContext, { ...original, names: plan.scan.sourcePlan }) : {} });
    const prepared = prepareRoleplayHistoryContent(records, original, environment);
    const snapshot = { ...original, ...prepared };
    let lore = emptyLore(), scan = null;
    if (plan.scan.sourcePlan.all.length) {
        const messages = records.slice(1).flatMap((record, index) => record.is_system ? [] : [plan.scan.settings.includeNames
            ? `${record.name}: ${prepared.content[index]}` : prepared.content[index]]).reverse();
        scan = await computeWorldInfoLab('world-info.scan', { ...plan.scan, macros: savedRoleplayMacroSnapshot(snapshot, records),
            globalScanData: prepared.global, injections: prepared.global.inject, messages, chatLength: messages.length,
        }, tokenCount);
        const placement = scan.placements;
        loreContext.activeLore = scan.activated.map(active => {
            const entry = scan.snapshot.entries.find(entry => entry.world === active.world && entry.uid === active.uid);
            return { title: active.label, content: entry?.content ?? '' };
        });
        lore = { worldInfoBefore: placement.worldInfoBefore, worldInfoAfter: placement.worldInfoAfter,
            EMEntries: placement.examples, ANBeforeEntries: placement.authorNoteBefore, ANAfterEntries: placement.authorNoteAfter,
            WIDepthEntries: placement.atDepth, outletEntries: placement.outlets };
    }
    const memory = plan.memory ? await prepareMemory({ records, preparedContent: prepared.content }) : null;
    const excluded = new Set(memory?.excludedIndices ?? []);
    const retained = records.slice(1).map((_record, index) => index).filter(index => !excluded.has(index));
    const remap = entries => entries.flatMap(entry => {
        const index = retained.indexOf(entry.index);
        return index < 0 ? [] : [{ ...entry, index }];
    });
    const promptRecords = [records[0], ...retained.map(index => records[index + 1])];
    const textBackend = material.backend && material.backend !== 'chat';
    const controls = material.labCapabilities?.settings ?? {}, models = material.labCapabilities?.models ?? [];
    const toolHistory = promptRecords.some(record => record.extra?.tool_invocations !== undefined);
    if (toolHistory && (textBackend || !supportsChatTools(controls, material.profile?.model, { model_list: models }))) {
        throw new Error('Saved tool history needs a tool-capable Chat Completion connection.');
    }
    let images = remap(snapshot.images);
    if (images.length && (textBackend || !supportsChatImages(controls, { model_list: models }))) {
        if (images.some(image => !image.captioned)) throw new Error('This prompt needs a vision connection or saved image captions.');
        images = images.map(image => ({ ...image, captionOnly: true }));
    }
    const history = buildRoleplaySavedHistory(promptRecords, { preparedContent: retained.map(index => prepared.content[index]), attachments: remap(snapshot.attachments),
        images, imageDetail: controls.inline_image_quality ?? 'auto', group: false, userName: snapshot.speakerNames.user,
        characterName: snapshot.speakerNames.character, reasoningInPrompt: snapshot.reasoningInPrompt, reasoning: snapshot.reasoning,
        companionHostIndex: retained.indexOf(prepared.companionHostIndex), toolHistory, toolSource: material.source, toolModel: material.profile?.model,
        signaturePolicy: { source: material.source, model: material.profile?.model, include: !textBackend && supportsChatSignatures(controls),
            reasoning: !textBackend && material.source === 'openrouter' && (controls.show_thoughts || controls.auto_append_reasoning_tags)
                ? controls.tool_reasoning_mode : 'disabled' },
        namesBehavior: textBackend ? 'provider' : controls.names_behavior ?? 0, mediaDisplay: snapshot.mediaDisplay });
    const evaluate = value => environment.evaluate(String(value ?? ''), { legacy: !snapshot.experimentalMacroEngine, strictCapabilities: true });
    const resolved = [], historyCache = new WeakMap();
    let resolvedIndex = 0;
    const substitute = value => {
        const index = resolvedIndex++;
        if (!resolved[index]) resolved[index] = { value, result: evaluate(value) };
        if (resolved[index].value !== value) throw new Error('Prompt trimming changed the macro expansion order.');
        return resolved[index].result;
    };
    const options = { userName: snapshot.speakerNames.user, characterName: snapshot.speakerNames.character, memory,
        substitute, transformPrompt: (id, content) => plan.promptTags?.enabled && isTaggablePromptIdentifier(id)
            ? applyWrap(content, plan.promptTags.rules[id], { substitute }) : content,
        substituteHistory: message => {
            if (!historyCache.has(message)) {
                const content = message.role === 'tool' || message.tool_calls ? message.content
                    : Array.isArray(message.content) ? message.content.map(part => part.type === 'text' ? { ...part, text: evaluate(part.text) } : part)
                        : evaluate(message.content);
                historyCache.set(message, { ...message, ...(content !== undefined && { content }) });
            }
            return historyCache.get(message);
        }, records: promptRecords };
    let messages = null, combinedPrompt = null, rawSections = [], selected = [...history], limit = Infinity;
    if (textBackend) {
        const builder = createRoleplayTextPrompt(history, snapshot, material, lore, { ...options,
            onSections: parts => {
                rawSections = [
                    { id: 'storyString', content: parts.story }, { id: 'examplesString', content: parts.examples },
                    { id: 'mesSendString', content: parts.history }, { id: 'chatStart', content: parts.chatStart }, { id: 'preamble', content: parts.preamble },
                ];
            },
        });
        limit = builder.exampleCount;
        combinedPrompt = builder.render(selected, limit);
        while (await tokenCount(combinedPrompt) > plan.maxContext && (selected.length > 1 || limit > 0)) {
            if (!snapshot.pinExamples && limit > 0) limit--; else if (selected.length > 1) selected.shift(); else break;
            combinedPrompt = builder.render(selected, limit);
        }
    } else {
        let built;
        do {
            rawSections = [];
            resolvedIndex = 0;
            built = await assembleRoleplayChatPrompt(selected, snapshot, material, lore,
                { ...options, exampleLimit: limit, onSection: section => rawSections.push(section) });
            messages = built.messages;
            if (await tokenCount(messages) <= plan.maxContext) break;
            if (limit === Infinity) limit = built.exampleCount;
            if (!snapshot.pinExamples && limit > 0) limit--; else if (selected.length > 1) selected.shift(); else break;
        } while (true);
    }
    const total = await tokenCount(messages ?? combinedPrompt);
    if (total > plan.maxContext) throw new Error('The pinned prompt does not fit its saved context limit.');
    const sections = await Promise.all(rawSections.map(async ({ id, content }) => {
        const text = Array.isArray(content) ? messagesToText(content) : String(content ?? '');
        return { id, label: SECTION_LABEL[id] || id, content: text, tokens: text ? await tokenCount(text) : 0 };
    }));
    return { messages, combinedPrompt, sections, tokenTable: { total, perSection: Object.fromEntries(sections.map(section => [section.id, section.tokens])) },
        wiPasses: [scan ? scan.activated.map(entry => ({ ...entry, comment: entry.label })) : []], sourceTexts: sections,
        metricsComplete: true, capabilities: { syntheticMessagesIsolated: true, macroStateSandboxed: true, localMacroStateRestored: true },
        caveats: [CAVEAT.NO_INTERCEPTORS], promptNames: { user: snapshot.speakerNames.user, char: snapshot.speakerNames.character },
        useSysPrompt: material.active?.use_sysprompt ?? true, useTools: true, prefillString: '',
    };
}

export async function analysePromptingRun(plan, tokenCount, prepareMemory) {
    const started = Date.now();
    const first = await compilePromptingCapture(plan, tokenCount, prepareMemory), second = await compilePromptingCapture(plan, tokenCount, prepareMemory);
    const run = createRun({ ...plan.run, capture: first, caveats: first.caveats,
        environment: { ...plan.context.environment, promptTagsProfile: plan.context.promptTags }, durationMs: Date.now() - started });
    const volatileSpans = findVolatileSpans({ capture: first }, { capture: second });
    run.cache = analyzeCache({ messages: first.messages ?? [], sections: first.sections, sourceTexts: first.sourceTexts,
        volatileSpans, cachingAtDepth: plan.context.settings.manualCachingAtDepth, squashSystem: Boolean(plan.material.active?.squash_system_messages),
        useSysPrompt: first.useSysPrompt, useTools: true, prefillString: '', names: first.promptNames, hash: getStringHash });
    if (run.cache.source === 'unknown') run.caveats.push(CAVEAT.CACHE_DEPTH_UNKNOWN);
    if (run.cache.source === 'manual') run.caveats.push(CAVEAT.CACHE_BOUNDARY_PREDICTED);
    run.assertionResults = await evaluateAssertions(plan.testCase.assertions, run, { safetyProblem: () => '', test: testRegex });
    const comparison = plan.baseline ? compareRuns(run, plan.baseline, { volatileSpans, normalize: plan.context.settings.normalizeVolatile ?? true }) : null;
    if (comparison) run.diffVsBaseline = { ...comparison, baselineRunId: plan.baseline.id };
    run.status = resolveStatus({ assertionResults: run.assertionResults, hasBaseline: Boolean(comparison), diffIsEmpty: comparison?.identical ?? true });
    return run;
}
