/**
 * Pipeline Runner - Orchestrates multi-stage prompt execution for predictive lore retrieval
 */

import { getPrompt, getPipeline } from './prompt-store.js';
import { sidecarGenerateWithProfile } from '../llm-sidecar.js';
import { canReadBook, getSettings, getTree, getAllEntryUids, isEntryEligible } from '../tree-store.js';
import { getReadableBooks } from '../pathfinder-tool-bridge.js';
import { logPipelineStageStart, logPipelineStageComplete, logPipelineError } from '../activity-feed.js';
import { isAbortLikeError } from '../../../../util/abort-error.js';

const PATHFINDER_LOG_PREFIX = '[Pawthfinder]';
const DEFAULT_PIPELINE_MAX_TOKENS = 64000;

function throwIfAborted(signal) {
    if (!signal?.aborted) {
        return;
    }

    throw signal.reason ?? new Error('Pawthfinder pipeline cancelled.');
}

/**
 * @typedef {Object} PipelineContext
 * @property {string} chat_history - Formatted recent chat
 * @property {string} entry_names - List of all entry names
 * @property {Map<string, Object>} entriesByName - Map of entry name -> entry data
 * @property {Map<string, any>} stageOutputs - Outputs from previous stages
 */

/**
 * @typedef {Object} PipelineResult
 * @property {boolean} success
 * @property {string[]} selectedEntries - Entry names/UIDs to activate
 * @property {Object[]} [selectedEntryData] - Selected entries with their originating book and UID
 * @property {Object[]} stageResults - Results from each stage
 * @property {string} [error] - Error message if failed
 */

/**
 * Run a pipeline to select relevant lorebook entries
 * @param {string} pipelineId - Pipeline to run
 * @param {Object[]} chatMessages - Recent chat messages
 * @param {number} [maxMessages=10] - Max messages to include in context
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(pipelineId, chatMessages, maxMessages = 10, signal = null, books = getReadableBooks()) {
    throwIfAborted(signal);
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) {
        console.warn(`${PATHFINDER_LOG_PREFIX} Pipeline "${pipelineId}" was requested, but no matching pipeline was found.`);
        return {
            success: false,
            selectedEntries: [],
            stageResults: [],
            error: `Pipeline not found: ${pipelineId}`,
        };
    }

    const settings = getSettings();
    const context = await buildPipelineContext(chatMessages, maxMessages, books, signal);
    throwIfAborted(signal);

    if (!context.entry_names.trim()) {
        return {
            success: true,
            selectedEntries: [],
            selectedEntryData: [],
            stageResults: [],
            error: 'No lorebook entries available',
        };
    }

    const stageResults = [];
    let currentEntries = [];
    const maxCandidates = Math.max(1, Math.min(50, Math.floor(Number(settings.maxCandidates) || 20)));

    for (let i = 0; i < pipeline.stages.length; i++) {
        throwIfAborted(signal);
        const stage = pipeline.stages[i];

        // Check skip condition
        if (stage.optional && stage.skipCondition && settings[stage.skipCondition]) {
            stageResults.push({
                stageIndex: i,
                promptId: stage.promptId,
                skipped: true,
                reason: `Skipped due to ${stage.skipCondition}`,
            });
            continue;
        }

        const prompt = getPrompt(stage.promptId);
        if (!prompt) {
            const error = `Prompt not found: ${stage.promptId}`;
            logPipelineError(pipeline.name, stage.promptId, error);
            console.warn(`${PATHFINDER_LOG_PREFIX} Pipeline stage ${i + 1} is missing prompt "${stage.promptId}".`);
            return {
                success: false,
                selectedEntries: [],
                stageResults,
                error,
            };
        }

        logPipelineStageStart(pipeline.name, prompt.name, i + 1, pipeline.stages.length);

        try {
            const readableBooks = new Set(getReadableBooks());
            context.entriesByName = new Map([...context.entriesByName].filter(([, entry]) => readableBooks.has(entry.bookName)));
            context.entry_names = [...context.entriesByName.keys()].map(name => `- ${name}`).join('\n');
            currentEntries = currentEntries.filter(name => context.entriesByName.has(name));
            // Resolve input mappings
            const inputs = resolveInputMappings(stage.inputMapping, context, currentEntries, settings);

            // Build the prompt
            const userPrompt = substituteTemplate(prompt.userPromptTemplate, inputs);

            // Get connection profile (stage-specific or default)
            const profileId = prompt.connectionProfile || settings.connectionProfile || '';
            const maxTokens = prompt.settings?.maxTokens ?? DEFAULT_PIPELINE_MAX_TOKENS;

            // Call the LLM
            const response = await sidecarGenerateWithProfile(
                userPrompt,
                prompt.systemPrompt,
                profileId,
                maxTokens,
                signal,
                { temperature: prompt.settings?.temperature },
            );
            throwIfAborted(signal);

            // Parse the output
            const mappings = Object.values(stage.inputMapping ?? {});
            const filtersCandidates = mappings.includes('prev:candidate_entries') && !mappings.includes('source:entry_names');
            const offeredEntries = filtersCandidates
                ? new Map(currentEntries.map(name => [name, context.entriesByName.get(name)]))
                : context.entriesByName;
            const parsed = parseOutput(response, prompt.outputFormat, offeredEntries);

            currentEntries = parsed.entries.filter(name => getReadableBooks().includes(context.entriesByName.get(name)?.bookName)).slice(0, maxCandidates);
            context.stageOutputs.set(stage.outputKey, {
                entries: currentEntries,
                raw: response,
                parsed,
            });

            logPipelineStageComplete(pipeline.name, prompt.name, currentEntries.length);

            stageResults.push({
                stageIndex: i,
                promptId: stage.promptId,
                success: true,
                entriesFound: currentEntries.length,
                reasoning: parsed.reasoning,
            });
        } catch (error) {
            if (isAbortLikeError(error, signal)) {
                throw error;
            }

            const errorMsg = error instanceof Error ? error.message : String(error);
            logPipelineError(pipeline.name, stage.promptId, errorMsg);
            console.warn(`${PATHFINDER_LOG_PREFIX} Pipeline stage ${i + 1}/${pipeline.stages.length} failed.`, {
                promptId: stage.promptId,
                error: errorMsg,
            });

            stageResults.push({
                stageIndex: i,
                promptId: stage.promptId,
                success: false,
                error: errorMsg,
            });

            // If non-optional stage fails, abort
            if (!stage.optional) {
                return {
                    success: false,
                    selectedEntries: [],
                    stageResults,
                    error: `Stage ${i + 1} failed: ${errorMsg}`,
                };
            }
        }
    }

    return {
        success: true,
        selectedEntries: currentEntries.map(name => context.entriesByName.get(name).comment),
        selectedEntryData: currentEntries.map(name => context.entriesByName.get(name)),
        stageResults,
    };
}

export async function loadRetrievalEntries(bookName, signal = null) {
    throwIfAborted(signal);
    if (!canReadBook(bookName)) return [];
    const ctx = globalThis.window?.SillyTavern?.getContext?.();
    const data = await ctx?.loadWorldInfo?.(bookName);
    throwIfAborted(signal);
    if (!canReadBook(bookName)) return [];
    // A failed read must not become a cacheable empty selection.
    if (!data?.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        throw new Error(`Lorebook "${bookName}" has no entries while fetching all content.`);
    }
    return Object.values(data.entries)
        .filter(isEntryEligible)
        .map(entry => ({ ...entry, bookName, comment: String(entry.comment || entry.key?.[0] || `Entry ${entry.uid}`) }));
}

/**
 * Build the initial context for pipeline execution
 * @param {Object[]} chatMessages
 * @param {number} maxMessages
 * @returns {Promise<PipelineContext>}
 */
async function buildPipelineContext(chatMessages, maxMessages, books, signal) {
    // Format chat history
    const recentMessages = chatMessages.slice(-maxMessages);
    const chat_history = recentMessages
        .map(msg => {
            const name = msg.is_user || msg.role === 'user' ? 'User' : (msg.name || 'Assistant');
            return `${name}: ${msg.mes}`;
        })
        .join('\n\n');

    // Gather all entries from enabled lorebooks (one load per book;
    // per-UID fetches re-loaded the whole book for every entry)
    const entriesByName = new Map();
    const entryNames = [];

    for (const bookName of books) {
        const tree = getTree(bookName);
        if (!tree) {
            continue;
        }

        const treeUids = new Set(getAllEntryUids(tree));
        const entries = await loadRetrievalEntries(bookName, signal);
        for (const entry of entries) {
            if (!treeUids.has(entry.uid) || !entry.comment) {
                continue;
            }
            const name = `${JSON.stringify([bookName, entry.uid])} ${entry.comment}`;
            entriesByName.set(name, entry);
            entryNames.push(`- ${name}`);
        }
    }

    return {
        chat_history,
        entry_names: entryNames.join('\n'),
        entriesByName,
        stageOutputs: new Map(),
    };
}

/**
 * Resolve input mappings for a stage
 * @param {Record<string, string>} mappings
 * @param {PipelineContext} context
 * @param {string[]} currentEntries
 * @param {Object} settings
 * @returns {Record<string, string>}
 */
function resolveInputMappings(mappings, context, currentEntries, settings) {
    const resolved = {};

    for (const [key, source] of Object.entries(mappings)) {
        if (source.startsWith('source:')) {
            // Direct source data
            const sourceKey = source.slice(7);
            resolved[key] = context[sourceKey] ?? '';
        } else if (source.startsWith('prev:')) {
            // Data from previous stage
            const prevKey = source.slice(5);
            if (prevKey === 'candidate_entries') {
                // Build entry content for candidates
                resolved[key] = formatCandidateEntries(currentEntries, context, settings);
            } else {
                const prevOutput = context.stageOutputs.get(prevKey);
                resolved[key] = prevOutput?.entries?.join('\n') ?? '';
            }
        } else if (source.startsWith('settings:')) {
            // Settings value
            const settingsKey = source.slice(9);
            resolved[key] = String(settings[settingsKey] ?? '');
        } else {
            resolved[key] = source;
        }
    }

    return resolved;
}

/**
 * Format candidate entries for the relevance filter stage
 * @param {string[]} candidates
 * @param {PipelineContext} context
 * @param {Object} settings
 * @returns {string}
 */
function formatCandidateEntries(candidates, context, settings) {
    const contentMode = settings.entryContentMode ?? 'full';
    const truncateLength = settings.truncateLength ?? 500;
    const maxCandidates = settings.maxCandidates ?? 20;

    const limited = candidates.slice(0, maxCandidates);
    const formatted = [];

    for (const name of limited) {
        const entry = context.entriesByName.get(name);
        if (!entry || !canReadBook(entry.bookName)) continue;

        let content = entry.content || '';

        if (contentMode === 'truncated' && content.length > truncateLength) {
            content = content.slice(0, truncateLength) + '...';
        }

        formatted.push(`### ${name}\n${content}`);
    }

    return formatted.join('\n\n');
}

function normalizeEntryName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function resolveEntryName(name, entriesByName) {
    if (typeof name !== 'string') {
        return null;
    }

    const trimmed = name.trim();
    if (entriesByName.has(trimmed)) {
        return trimmed;
    }

    const normalized = normalizeEntryName(trimmed);
    const matches = [...entriesByName].filter(([knownName, entry]) =>
        normalizeEntryName(knownName) === normalized || normalizeEntryName(entry.comment) === normalized,
    );
    return matches.length === 1 ? matches[0][0] : null;
}

/**
 * Substitute template variables
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
function substituteTemplate(template, values) {
    let result = template;
    for (const [key, value] of Object.entries(values)) {
        // Function replacer: chat text may contain $&/$1 replacement patterns
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
    }
    return result;
}

/**
 * Parse LLM output based on format
 * @param {string} response
 * @param {string} format
 * @param {Map<string, Object>} entriesByName
 * @returns {{ entries: string[], reasoning?: string }}
 */
function parseOutput(response, format, entriesByName) {
    const trimmed = response.trim();

    if (format === 'json_object' || format === 'json_array') {
        const source = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
        let json;
        try {
            json = JSON.parse(source);
        } catch {
            if (source.startsWith('{') || source.startsWith('[') || trimmed.startsWith('```')) {
                throw new Error('The retrieval reply contains incomplete or invalid JSON.');
            }
        }
        if (json !== undefined) {
            const entries = Array.isArray(json) ? json : json?.candidates ?? json?.selected;
            if (!Array.isArray(entries) || entries.some(name => typeof name !== 'string')
                || (json?.reasoning !== undefined && typeof json.reasoning !== 'string')) {
                throw new Error('The retrieval reply must contain an array of entry names.');
            }
            return { entries: [...new Set(entries.map(name => resolveEntryName(name, entriesByName)).filter(Boolean))], reasoning: json.reasoning ?? '' };
        }
    }

    // Fallback: extract entry names line by line
    const lines = trimmed.split('\n')
        .map(line => line.replace(/^[-*]\s*/, '').trim())
        .map(line => resolveEntryName(line, entriesByName))
        .filter(Boolean);

    if (!lines.length) throw new Error('The retrieval reply did not contain a valid entry selection.');
    return { entries: [...new Set(lines)] };
}
