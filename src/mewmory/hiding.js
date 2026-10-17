import path from 'node:path';
import { overflowPlan, visibleMessageIndices } from '../../public/scripts/mewmory/overflow-policy.js';
import { getSettingsRevision } from '../settings-version.js';
import { captureGenerationBinding, resolveGenerationProfile } from '../generation/profiles.js';
import { createRoleplayChatCounter, createRoleplayTextCounter } from '../generation/roleplay-budget.js';
import { resolveTextTokenizer } from '../generation/text-request.js';
import { captureSavedTokenizer } from '../generation/saved-token-counter.js';
import { hash } from './core.js';
import { readConfig } from './models.js';
import { readJsonShared, readStateShared } from './store.js';
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
export async function prepareAutomaticHiding(directories, locator, { binding = null, models = [], modelOverride = '' } = {}) {
    try {
        const config = readConfig(directories);
        if (!config.autoHide) return null;
        const state = readStateShared(directories, locator);
        if (!state.enabled) return null;
        const writerTokenizer = config.writerTokenizer;
        const settingsHash = writerTokenizer === 'auto' ? hash(writerSettings(directories)) : null;
        const tokenizer = writerTokenizer === 'auto'
            ? await resolveWriterTokenizer(directories, { binding, models, modelOverride })
            : writerTokenizer;
        if (!tokenizer) return null;
        const counter = await getCounter(tokenizer);
        const policy = {
            limit: config.autoHideTokens, writerTokenizer, settingsHash, directories, locator,
            count: value => counter.count(String(value ?? '')),
        };
        policy.guard = checkedLocator => {
            try {
                const current = readConfig(directories);
                if (!current.autoHide || current.autoHideTokens !== policy.limit
                    || current.writerTokenizer !== policy.writerTokenizer
                    || (policy.settingsHash !== null && hash(writerSettings(directories)) !== policy.settingsHash)) return false;
                return readStateShared(directories, checkedLocator || locator).enabled === true;
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
        const visible = visibleMessageIndices(messages);
        const counts = visible.map(index => policy.count(messages[index]?.mes));
        const plan = overflowPlan(messages, policy.limit, counts);
        if (!plan.indices.length) return { records, hidden: 0 };
        const next = records.slice();
        for (const index of plan.indices) {
            next[index + 1] = { ...next[index + 1], is_system: true,
                extra: { ...next[index + 1].extra, mewmoryKeepHidden: true } };
        }
        return { records: next, hidden: plan.indices.length };
    } catch (error) {
        // A tokenizer problem must not discard a reply that is already paid for.
        console.warn('[Mewmory] Automatic hiding was skipped:', error?.message || error);
        return { records, hidden: 0 };
    }
}
