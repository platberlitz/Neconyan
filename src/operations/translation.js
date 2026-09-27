import { roleplayHash, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { captureRoleplayStorageSourceLocked } from '../generation/roleplay-source.js';
import { commitSingleChatWriteLocked } from '../roleplay-lifecycle.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { captureSavedTranslationPolicy, translateCapturedFields, translatorCredentials } from '../generation/roleplay-translation.js';
import { captureLabChat as captureSavedChat, readLabSettings as readSavedSettings } from '../labs/sources.js';
import { createMacroEnvironment } from '../macros/index.js';
import { operationError, withOperation } from './store.js';
import { registerOperation } from './jobs.js';
import { captureSavedTokenizer, savedTokenCounter } from '../generation/saved-token-counter.js';
import { updateReasoningTokenAccounting } from '../../public/scripts/reasoning-token-accounting.js';

const MAX_TEXT = 256 * 1024;
const refuse = message => Object.assign(operationError(message), { operationRefused: true });
const text = value => {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_TEXT) throw operationError('The translation text is invalid or too large.', 413);
    return value;
};
const policyOptions = input => ({ manual: true, direction: input.direction ?? 'output', target: input.target,
    internal: input.internal, provider: input.provider });

export function captureTranslation(base, account, input) {
    if (!['text', 'message', 'chat', 'clear'].includes(input.mode) || ![undefined, 'input', 'output'].includes(input.direction)) {
        throw operationError('Choose a valid translation workflow.', 400);
    }
    const options = policyOptions(input);
    const selectedFields = input.fields ?? ['body', 'reasoning'];
    if (!Array.isArray(selectedFields) || !selectedFields.length || selectedFields.length > 2
        || selectedFields.some(field => !['body', 'reasoning'].includes(field)) || new Set(selectedFields).size !== selectedFields.length) {
        throw operationError('Choose valid translation fields.', 400);
    }
    const policy = input.mode === 'clear' ? null : withRoleplayAccount(base, account,
        () => captureSavedTranslationPolicy(base.directories, readSavedSettings(base), options));
    if (input.mode === 'text') return { mode: input.mode, account, policy, text: text(input.text), options: JSON.parse(JSON.stringify(options)) };
    const snapshot = captureSavedChat(base, account, input.locator);
    return withRoleplayAccount(base, account, lease => {
        const captured = captureRoleplayStorageSourceLocked(lease, snapshot.locator);
        if (captured.saved.rawHash !== snapshot.rawHash) throw refuse('The saved chat changed before translation was accepted.');
        if (captured.changed) saveRoleplayAccount(lease);
        const requested = input.message;
        if (input.mode === 'message' || requested) {
            const row = captured.saved.records[requested?.index + 1];
            if (!Number.isSafeInteger(requested?.index) || requested.index < 0 || !row || input.mode !== 'clear' && row.is_system
                || requested.original !== row.mes || requested.swipeId !== (row.swipe_id ?? null)
                || requested.reasoning !== (row.extra?.reasoning ?? null)) throw refuse('The selected message or swipe changed.');
        }
        const targets = captured.saved.records.slice(1).flatMap((row, index) => {
            if (row.is_system && input.mode !== 'clear' || requested && index !== requested.index) return [];
            const fields = [];
            if (input.mode !== 'clear') {
                const environment = createMacroEnvironment({ ...snapshot.macros,
                    names: { ...snapshot.macros.names, char: row.is_user ? snapshot.macros.names.char : row.name || snapshot.macros.names.char } });
                if (selectedFields.includes('body')) fields.push({ key: `${index}:body`, text: text(environment.evaluate(text(row.mes))) });
                if (selectedFields.includes('reasoning') && policy.translateReasoning && row.extra?.reasoning) {
                    fields.push({ key: `${index}:reasoning`, text: text(environment.evaluate(text(row.extra.reasoning))) });
                }
            }
            return [{ index, hash: roleplayHash(row), fields }];
        });
        if (targets.length > 10000) throw operationError('This translation exceeds the saved message limit.', 413);
        const settings = readSavedSettings(base);
        const tokenizer = input.mode !== 'clear' && input.direction === 'input' && settings.power_user?.message_token_count_enabled
            ? captureSavedTokenizer(base, settings) : null;
        return { mode: input.mode, account, source: captured.source, policy, selectedFields, tokenizer,
            options: JSON.parse(JSON.stringify(options)), targets };
    });
}

function currentSource(lease, plan) {
    const captured = captureRoleplayStorageSourceLocked(lease, plan.source.locator);
    if (captured.source.instanceId !== plan.source.instanceId) throw refuse('The translated chat was replaced.');
    for (const target of plan.targets) {
        const row = captured.saved.records[target.index + 1];
        if (!row || roleplayHash(row) !== target.hash) throw refuse('A translated message or selected swipe changed. The existing chat was kept.');
    }
    if (captured.changed) saveRoleplayAccount(lease);
    return captured;
}

export async function runTranslation(context, plan, { fetchImpl = fetch, afterTranslationPublication } = {}) {
    const base = { owner: context.owner, directories: context.directories };
    const prior = withOperation(context, ({ value }) => value.effects.chat);
    let translated = {};
    if (!prior && plan.mode !== 'clear') {
        const verify = () => withOperation(context, ({ lease }) => {
            if (plan.source) currentSource(lease, plan);
            const saved = readSavedSettings(base);
            const current = captureSavedTranslationPolicy(base.directories, saved, plan.options);
            if (roleplayHash(current) !== roleplayHash(plan.policy)) throw refuse('The saved translation settings or credentials changed.');
            return translatorCredentials(base.directories, current.provider, saved.extension_settings?.translate ?? {});
        });
        const fields = plan.mode === 'text' ? [{ key: 'text', text: plan.text }] : plan.targets.flatMap(target => target.fields);
        let completed = 0;
        await context.progress({ stage: 'Translating saved text', completed, total: fields.length });
        translated = await translateCapturedFields(context, { base, account: plan.account, policy: plan.policy, fields, verify, fetchImpl,
            onField: () => context.progress({ stage: 'Translating saved text', completed: ++completed, total: fields.length }) });
    }
    if (plan.mode === 'text') return { text: translated.text, target: plan.policy.target };
    let changedRows;
    if (!prior) {
        changedRows = withOperation(context, ({ lease }) => {
            const current = currentSource(lease, plan);
            return plan.targets.map(target => ({ target, row: structuredClone(current.saved.records[target.index + 1]) }));
        });
        const countTokens = plan.tokenizer ? await savedTokenCounter(context, plan.tokenizer) : null;
        for (const { target, row } of changedRows) {
            row.extra = { ...row.extra };
            const fields = [];
            if (plan.mode === 'clear') {
                if (plan.selectedFields.includes('body')) { delete row.extra.display_text; fields.push('display_text'); }
                if (plan.selectedFields.includes('reasoning')) { delete row.extra.reasoning_display_text; fields.push('reasoning_display_text'); }
            } else {
                if (Object.hasOwn(translated, `${target.index}:body`)) {
                    fields.push('display_text');
                    if (plan.options.direction === 'input') {
                        row.extra.display_text = row.mes; row.mes = translated[`${target.index}:body`];
                        if (countTokens) { await updateReasoningTokenAccounting(row, { countTokens }); fields.push('token_count', 'reasoning_tokens'); }
                    } else row.extra.display_text = translated[`${target.index}:body`];
                }
                if (Object.hasOwn(translated, `${target.index}:reasoning`)) {
                    row.extra.reasoning_display_text = translated[`${target.index}:reasoning`]; fields.push('reasoning_display_text');
                }
            }
            const swipe = Number.isSafeInteger(row.swipe_id) ? row.swipe_info?.[row.swipe_id] : null;
            if (swipe) {
                swipe.extra = { ...swipe.extra };
                for (const key of fields) {
                    if (Object.hasOwn(row.extra, key)) swipe.extra[key] = row.extra[key];
                    else delete swipe.extra[key];
                }
                if (plan.options.direction === 'input' && plan.mode !== 'clear' && Array.isArray(row.swipes)) row.swipes[row.swipe_id] = row.mes;
            }
        }
    }
    return withOperation(context, ({ lease, value, save }) => {
        if (value.effects.chat?.state === 'done') return value.effects.chat.result;
        if (!value.effects.chat) {
            context.signal.throwIfAborted();
            const current = currentSource(lease, plan);
            const records = structuredClone(current.saved.records);
            for (const { target, row } of changedRows) records[target.index + 1] = row;
            value.effects.chat = { state: 'prepared', input: { operationKey: `application:${context.job.id}:translation`,
                mode: 'update', sourceKind: 'storage', source: current.source, records, allowShrink: true, backup: { deferBackup: true } },
            result: { locator: plan.source.locator, count: plan.targets.length } };
            save();
        }
        const effect = value.effects.chat;
        commitSingleChatWriteLocked(lease, effect.input, roleplayNativeHost);
        afterTranslationPublication?.();
        effect.state = 'done';
        save();
        return effect.result;
    });
}

registerOperation('translation', { label: 'Translate saved text and messages', capture: captureTranslation, run: runTranslation,
    canRecover: value => ['prepared', 'done'].includes(value.effects.chat?.state),
    target: plan => plan.source ? { kind: 'chat', id: roleplayHash(plan.source.locator) } : null });
