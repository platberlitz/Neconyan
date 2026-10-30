import path from 'node:path';
import { overflowPlan, visibleMessageIndices } from '../../public/scripts/mewmory/overflow-policy.js';
import { messageHistoryPlan } from '../../public/scripts/mewmory/history-policy.js';
import { getSettingsRevision } from '../settings-version.js';
import { captureGenerationBinding, resolveGenerationProfile } from '../generation/profiles.js';
import { createRoleplayChatCounter, createRoleplayTextCounter } from '../generation/roleplay-budget.js';
import { resolveTextTokenizer } from '../generation/text-request.js';
import { captureSavedTokenizer } from '../generation/saved-token-counter.js';
import { hash, refKey, sourceEligible, syncSources } from './core.js';
import { readConfig } from './models.js';
import { processingVersion } from './processing.js';
import { readContextSourcesSync, roleIdentityChanged } from './sources.js';
import { readJsonShared, readStateShared, sourceSyncOptions } from './store.js';
import { getCounter, getTokenizerModel } from './tokens.js';

function writerSettings(directories) {
    const settings = readJsonShared(path.join(directories.root, 'settings.json'), {});
    return {
        main_api: settings.main_api ?? 'openai',
        active_generation: settings.active_generation ?? null,
        selected_custom_endpoint_preset: settings.selected_custom_endpoint_preset ?? null,
        oai_settings: settings.oai_settings ?? null,
        textgenerationwebui_settings: settings.textgenerationwebui_settings ?? null,
        nai_settings: settings.nai_settings ?? null,
        power_user: { tokenizer: settings.power_user?.tokenizer ?? null },
        connectionManager: settings.extension_settings?.connectionManager ?? null,
    };
}

function legacyTextTokenizer(material, model) {
    const choice = material.power?.tokenizer;
    try {
        return resolveTextTokenizer(choice, material.source, model);
    } catch (error) {
        // The browser's best-match fallback is Llama when no local family is known;
        // an API tokenizer cannot be used for local Mewmory counting.
        if (['99', 'best_match'].includes(String(choice ?? 'best_match').toLowerCase())
            && ['kobold', 'koboldhorde'].includes(material.source)) return 'llama';
        throw error;
    }
}

/** Text counters can describe OpenAI as 'openai' plus a model name; Mewmory needs its concrete tiktoken choice. */
function concreteTokenizer(tokenizer, model = '') {
    const key = tokenizer?.tokenizerKey ?? tokenizer;
    if (typeof key !== 'string' || !key) return null;
    if (key === 'openai') return getTokenizerModel(String(tokenizer?.tokenizerName || model || ''));
    return key;
}

/**
 * The exact writer tokenizer for one resolved generation profile. Chat
 * counters reuse the browser's OpenRouter architecture-aware resolver; text
 * counters reuse the provider-specific saved model and saved tokenizer choices.
 */
export async function writerTokenizerFromMaterial(material, { models = [], modelOverride = '' } = {}) {
    const promptMaterial = modelOverride && material.profile
        ? { ...material, profile: { ...material.profile, model: modelOverride } } : material;
    if (promptMaterial.backend === 'text' || promptMaterial.backend === 'novel') {
        const counter = await createRoleplayTextCounter({ directories: null }, promptMaterial, {
            tokenizer: 'o200k_base', modelOverride,
        });
        return concreteTokenizer(counter.tokenizer, modelOverride || promptMaterial.profile?.model || '');
    }
    if (promptMaterial.backend === 'kobold' || promptMaterial.backend === 'horde') {
        const model = modelOverride || promptMaterial.profile?.model || '';
        return concreteTokenizer({ tokenizerKey: legacyTextTokenizer(promptMaterial, model), tokenizerName: model }, model);
    }
    const counter = await createRoleplayChatCounter(promptMaterial, { models, fallbackTokenizer: 'o200k_base' });
    return concreteTokenizer(counter.tokenizer, promptMaterial.profile?.model || '');
}

/** Resolve the writer's actual tokenizer from its admitted binding, or from the saved active writer. */
export async function resolveWriterTokenizer(directories, { binding = null, models = [], modelOverride = '' } = {}) {
    if (binding) {
        return writerTokenizerFromMaterial(resolveGenerationProfile(directories, binding), { models, modelOverride });
    }
    const settings = readJsonShared(path.join(directories.root, 'settings.json'), {});
    try {
        const active = captureGenerationBinding(directories, { kind: 'active' }, { settingsRevision: getSettingsRevision(settings) });
        return await writerTokenizerFromMaterial(resolveGenerationProfile(directories, active), { models, modelOverride });
    } catch {
        const saved = captureSavedTokenizer({ directories }, settings);
        if (saved.kind === 'binding') {
            return writerTokenizerFromMaterial(resolveGenerationProfile(directories, saved.binding), { models, modelOverride });
        }
        return saved.tokenizer;
    }
}

/**
 * A counter, the saved clearing trigger, and a synchronous guard rechecked
 * inside the chat write. The guard refuses a policy whose settings, tokenizer
 * choice or per-chat enabled state changed while the tokenizer was loading,
 * and reads the current chat name after a supported rename.
 */
export async function prepareAutomaticHiding(directories, locator, { binding = null, models = [], modelOverride = '',
    manual = false, expectedLastDisableId } = {}) {
    try {
        const config = readConfig(directories);
        if (!manual && !config.autoHide) return null;
        const state = readStateShared(directories, locator);
        if (!state.enabled || ['pending', 'failed'].includes(state.visibilityRestore?.status)
            || (expectedLastDisableId !== undefined && (state.lastDisableId || '') !== expectedLastDisableId)
            || (config.historyMode === 'messages' && !config.excludeHistory)) return null;
        const writerTokenizer = config.writerTokenizer;
        const messageMode = config.historyMode === 'messages';
        const settingsHash = !messageMode && writerTokenizer === 'auto' ? hash(writerSettings(directories)) : null;
        const tokenizer = messageMode ? null : writerTokenizer === 'auto'
            ? await resolveWriterTokenizer(directories, { binding, models, modelOverride })
            : writerTokenizer;
        if (!messageMode && !tokenizer) return null;
        const counter = messageMode ? null : await getCounter(tokenizer);
        const policy = {
            limit: config.autoHideTokens, writerTokenizer, settingsHash, directories, locator,
            mode: config.historyMode, recent: config.recentMessages, batch: config.historyBatchMessages,
            lastDisableId: state.lastDisableId, count: value => counter?.count(String(value ?? '')) || 0,
        };
        policy.guard = checkedLocator => {
            try {
                const current = readConfig(directories);
                if ((!manual && !current.autoHide) || current.autoHideTokens !== policy.limit
                    || current.writerTokenizer !== policy.writerTokenizer
                    || current.historyMode !== policy.mode || current.recentMessages !== policy.recent
                    || current.historyBatchMessages !== policy.batch || (messageMode && !current.excludeHistory)
                    || (policy.settingsHash !== null && hash(writerSettings(directories)) !== policy.settingsHash)) return false;
                const state = readStateShared(directories, checkedLocator || locator);
                return state.enabled === true && state.lastDisableId === policy.lastDisableId
                    && !['pending', 'failed'].includes(state.visibilityRestore?.status);
            } catch {
                return false;
            }
        };
        return policy.guard(locator) ? policy : null;
    } catch (error) {
        // Automatic hiding is a convenience. A missing tokenizer or an unreadable
        // archive must never discard a reply that is already paid for.
        console.warn('[Mewmory] Automatic hiding was skipped:', error?.message || error);
        return null;
    }
}

/** Capture the message-mode policy at first protected browser-save admission. */
export function prepareMessageHidingPolicy(directories, locator, { manual = false, lastDisableId = '' } = {}) {
    const config = readConfig(directories);
    const state = readStateShared(directories, locator);
    if (config.historyMode !== 'messages' || (!manual && !config.autoHide) || !config.excludeHistory || !state.enabled
        || (state.lastDisableId || '') !== lastDisableId
        || ['pending', 'failed'].includes(state.visibilityRestore?.status)) return null;
    const policy = { mode: 'messages', directories, locator, recent: config.recentMessages,
        batch: config.historyBatchMessages, lastDisableId };
    policy.guard = checked => {
        const current = readConfig(directories);
        const saved = readStateShared(directories, checked || locator);
        return current.historyMode === 'messages' && (manual || current.autoHide) && current.excludeHistory
            && current.recentMessages === policy.recent && current.historyBatchMessages === policy.batch
            && saved.enabled && (saved.lastDisableId || '') === policy.lastDisableId
            && !['pending', 'failed'].includes(saved.visibilityRestore?.status);
    };
    return policy;
}

/**
 * A preservation test over a clone of the proposed saved vector, so planning
 * never publishes uncommitted sources. A message counts as preserved once
 * Mewmory has finished reading it, or when it is not a memory source at all.
 */
function preservationCheck(records, archivedState, config, contextSources, sourceOptions = {}, { checkpoint = config.excludeHistory !== false } = {}) {
    const shadow = structuredClone(archivedState);
    const messages = records.slice(1);
    syncSources(shadow, messages, contextSources, sourceOptions);
    const offset = shadow.inheritedTimeline?.length || 0;
    const policy = processingVersion(config);
    // Hiding can run without loadCurrentStateSync, so it must apply the same identity check.
    // A changed profile source or model means the stored marks belong to another reader.
    const identityChanged = roleIdentityChanged(archivedState, config);
    // Message-mode hiding always needs preservation checkpoints. Token-mode hiding
    // normally has no checkpoints when history exclusion is off, so it uses the
    // ordinary processed marks the worker writes for every finished batch.
    const marks = checkpoint ? shadow.checkpoints : shadow.coverage;
    return {
        messages,
        isPreserved: index => {
            if (identityChanged) return false;
            const ref = shadow.timeline[index + offset];
            return Boolean(ref && (!sourceEligible(shadow, ref) || marks[refKey(ref)] === policy));
        },
    };
}

export function planPreservedMessageHiding(records, archivedState, config, contextSources, sourceOptions = {}) {
    const { messages, isPreserved } = preservationCheck(records, archivedState, config, contextSources, sourceOptions, { checkpoint: true });
    const visible = visibleMessageIndices(messages).filter(index => !messages[index]?.extra?.nn_generation_failed);
    return messageHistoryPlan(visible, config.recentMessages, config.historyBatchMessages, isPreserved).excluded;
}

/**
 * Token-mode hiding keeps every message Mewmory has not finished reading in
 * the prompt. Only the oldest run of already-remembered messages is hidden;
 * the rest stay visible and a later reply hides them once they are recorded.
 * With the Facts and events reader off nothing is ever recorded, so waiting
 * would stop hiding for good; the trigger then hides as it always has.
 */
export function planPreservedOverflowHiding(records, archivedState, config, contextSources, sourceOptions, indices) {
    if (!config.roles?.extractor?.enabled) return indices;
    const { isPreserved } = preservationCheck(records, archivedState, config, contextSources, sourceOptions,
        { checkpoint: config.excludeHistory !== false });
    const kept = [];
    for (const index of indices) {
        if (!isPreserved(index)) break;
        kept.push(index);
    }
    return kept;
}

/**
 * Applies one saved-chat mutation's hidden flags. `records` are whole chat
 * records: the first row is chat metadata, the rest are messages. The returned
 * records are the exact vector the protected write must publish, so hiding
 * never needs a second write between a reply, its proof and its completion.
 * `locator` is the chat's current permanent name, used for the final guard.
 */
export function applyOverflowHiding(records, policy, locator = policy?.locator) {
    if (!policy || !Array.isArray(records) || records.length < 2) return { records, hidden: 0 };
    try {
        if (policy.guard && !policy.guard(locator)) return { records, hidden: 0 };
        const messages = records.slice(1);
        const archive = () => {
            const state = readStateShared(policy.directories, locator);
            const config = readConfig(policy.directories);
            const source = { metadata: records[0].chat_metadata ?? {}, messages };
            const context = readContextSourcesSync(policy.directories, locator, state, source);
            return { state, config, context, options: sourceSyncOptions(policy.directories, messages) };
        };
        let indices;
        if (policy.mode === 'messages') {
            const { state, config, context, options } = archive();
            indices = planPreservedMessageHiding(records, state, config, context, options);
        } else {
            const visible = visibleMessageIndices(messages);
            const counts = visible.map(index => policy.count(messages[index]?.mes));
            indices = overflowPlan(messages, policy.limit, counts).indices;
            if (indices.length) {
                const { state, config, context, options } = archive();
                indices = planPreservedOverflowHiding(records, state, config, context, options, indices);
            }
        }
        if (!indices.length) return { records, hidden: 0 };
        const next = records.slice();
        for (const index of indices) {
            next[index + 1] = { ...next[index + 1], is_system: true,
                extra: { ...next[index + 1].extra, mewmoryKeepHidden: true } };
        }
        return { records: next, hidden: indices.length };
    } catch (error) {
        // A tokenizer problem must not discard a reply that is already paid for.
        console.warn('[Mewmory] Automatic hiding was skipped:', error?.message || error);
        return { records, hidden: 0 };
    }
}
