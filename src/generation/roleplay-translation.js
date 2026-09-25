import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { translate as bingTranslate } from 'bing-translate-api';
import { Translator } from 'google-translate-api-x';

import { readSecret, SECRET_KEYS } from '../endpoints/secrets.js';
import { providerNotDispatched, providerStep, readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { readResponseText } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { assertRoleplayWorldInfoCurrent } from './world-info.js';
import { getConfigValue } from '../util.js';

const PROVIDERS = new Set(['libre', 'google', 'yandex', 'lingva', 'deepl', 'oneringtranslator', 'deeplx', 'bing']);
const DEFAULT_URLS = Object.freeze({ lingva: 'https://lingva.ml/api/v1',
    oneringtranslator: 'http://127.0.0.1:4990/translate', deeplx: 'http://127.0.0.1:1188/translate' });
const MAX_TRANSLATION_BYTES = 256 * 1024;
const bad = (message, code = 'ROLEPLAY_TRANSLATION_INVALID', status = 409) => roleplayError(code, message, status);

function endpoint(value, name) {
    let url;
    try { url = new URL(value); } catch { throw bad(`The saved ${name} URL is invalid.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw bad(`The saved ${name} URL is invalid.`);
    }
    return url.href;
}

function translatorCredentials(directories, provider, options) {
    switch (provider) {
        case 'libre': return { key: readSecret(directories, SECRET_KEYS.LIBRE),
            url: readSecret(directories, SECRET_KEYS.LIBRE_URL) };
        case 'deepl': return { key: readSecret(directories, SECRET_KEYS.DEEPL),
            url: options.deepl_endpoint === 'pro' ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate' };
        case 'lingva': return { url: readSecret(directories, SECRET_KEYS.LINGVA_URL) || DEFAULT_URLS.lingva };
        case 'oneringtranslator': return { url: readSecret(directories, SECRET_KEYS.ONERING_URL) || DEFAULT_URLS.oneringtranslator };
        case 'deeplx': return { url: readSecret(directories, SECRET_KEYS.DEEPLX_URL) || DEFAULT_URLS.deeplx };
        default: return {};
    }
}

function validateCredentials(provider, credentials) {
    if (['libre', 'deepl'].includes(provider) && !credentials.key) throw bad('The configured translation key is unavailable.');
    if (['libre', 'deepl', 'lingva', 'oneringtranslator', 'deeplx'].includes(provider)) {
        if (!credentials.url) throw bad('The configured translation address is unavailable.');
        endpoint(credentials.url, provider);
    }
}

/** Called under the original account lock while capturing the immutable Roleplay prompt source. */
export function captureIncomingRoleplayTranslation(directories, savedSettings, { serverPrompt } = {}) {
    return serverPrompt ? captureTranslationPolicy(directories, savedSettings, 'output') : null;
}

function captureTranslationPolicy(directories, savedSettings, direction) {
    const options = savedSettings?.extension_settings?.translate;
    if (!(direction === 'input' ? ['inputs', 'both'] : ['responses', 'both']).includes(options?.auto_mode)
        || savedSettings?.extension_settings?.disabledExtensions?.some(name => String(name).toLowerCase() === 'translate')) return null;
    const provider = String(options.provider || 'google');
    if (!PROVIDERS.has(provider)) throw bad('The saved incoming translation provider is not supported.');
    const target = String(options.target_language || 'en');
    const internal = String(options.internal_language || 'en');
    if (![target, internal].every(lang => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(lang))) {
        throw bad('The saved translation language is invalid.');
    }
    const credentials = translatorCredentials(directories, provider, options);
    validateCredentials(provider, credentials);
    return { provider, target: direction === 'input' ? internal : target, internal, translateReasoning: options.translate_reasoning === true,
        ...(direction === 'input' ? { direction, from: target } : {}),
        deeplEndpoint: options.deepl_endpoint || 'free',
        formality: getConfigValue('deepl.formality', 'default'),
        settingsHash: roleplayHash(options), credentialsHash: roleplayHash(credentials) };
}

/** Bind only the new user input at the end of the accepted prompt, never older unrelated history. */
export function captureRoleplayInputTranslation(directories, savedSettings, records, { serverPrompt } = {}) {
    if (!serverPrompt) return null;
    let index = records.length - 2;
    while (index >= 0 && records[index + 1].is_system) index--;
    const record = records[index + 1];
    if (index < 0 || !record?.is_user || typeof record.mes !== 'string' || record.extra?.display_text) return null;
    const policy = captureTranslationPolicy(directories, savedSettings, 'input');
    return policy ? { policy, item: { index, recordHash: roleplayHash(record) } } : null;
}

function currentCredentials(base, snapshot, policy = snapshot.translation) {
    return withRoleplayAccount(base, snapshot.account, () => {
        const settings = requireSettings(base.directories);
        const current = captureTranslationPolicy(base.directories, settings, policy.direction || 'output');
        if (!current || roleplayHash(current) !== roleplayHash(policy)) {
            throw bad('The accepted translation connection or settings changed.', 'ROLEPLAY_TRANSLATION_SOURCE_CHANGED');
        }
        return translatorCredentials(base.directories, policy.provider, settings.extension_settings.translate);
    });
}

function requireSettings(directories) {
    // Read the same account file the World Info admission snapshot hashes, under its account lock.
    try { return JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8')); } catch {
        throw bad('The accepted translation settings are unavailable.', 'ROLEPLAY_TRANSLATION_SOURCE_CHANGED');
    }
}

function language(provider, input) {
    switch (provider) {
        case 'libre': return input === 'zh-CN' ? 'zh' : input === 'zh-TW' ? 'zt'
            : ['pt-BR', 'pt-PT'].includes(input) ? 'pt' : input;
        case 'google': return input === 'pt-BR' ? 'pt' : input;
        case 'yandex': return ['zh-CN', 'zh-TW'].includes(input) ? 'zh' : input === 'pt-PT' ? 'pt' : input;
        case 'lingva': return ['zh-CN', 'zh-TW'].includes(input) ? 'zh' : ['pt-BR', 'pt-PT'].includes(input) ? 'pt' : input;
        case 'deepl': case 'deeplx': return ['zh-CN', 'zh-TW'].includes(input) ? 'ZH' : input;
        case 'bing': return input === 'zh-CN' ? 'zh-Hans' : input === 'zh-TW' ? 'zh-Hant'
            : input === 'pt-BR' ? 'pt' : input;
        default: return input;
    }
}

function partsForTranslation(text, provider) {
    const size = ({ google: 5000, lingva: 5000, deeplx: 1500, bing: 1000 })[provider] || Infinity;
    if (provider === 'yandex') return [splitChunks(text, 5000)];
    return splitChunks(text, size).map(value => [value]);
}

function splitChunks(text, size) {
    if (text.length <= size) return [text];
    const delimiters = ['\n\n', '\n', ' ', ''];
    const divide = (value, index) => {
        if (value.length <= size) return [value];
        const separator = delimiters[index] ?? '';
        if (!separator) return value.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || [];
        const pieces = value.split(separator).flatMap(part => part.length < size ? [part] : divide(part, index + 1));
        const merged = [];
        for (const part of pieces) {
            if (merged.length && merged.at(-1).length + separator.length + part.length <= size) {
                merged[merged.length - 1] += separator + part;
            } else merged.push(part);
        }
        return merged;
    };
    return divide(text, 0);
}

async function responseText(response, field) {
    if (!response.ok) throw bad(`The translation provider returned HTTP ${response.status}.`, 'ROLEPLAY_TRANSLATION_PROVIDER', 502);
    let result;
    try { result = JSON.parse(await readResponseText(response, 1024 * 1024)); } catch {
        throw bad('The translation provider returned invalid JSON.', 'ROLEPLAY_TRANSLATION_PROVIDER', 502);
    }
    const text = field(result);
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TRANSLATION_BYTES) {
        throw bad('The translation provider returned no bounded text.', 'ROLEPLAY_TRANSLATION_PROVIDER', 502);
    }
    return text;
}

async function transport({ provider, chunks, policy, credentials, fetchImpl, signal }) {
    const text = chunks.join('');
    const lang = language(provider, policy.target);
    const options = { signal, redirect: 'error' };
    switch (provider) {
        case 'libre': {
            const response = await fetchImpl(credentials.url, { ...options, method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: text, source: 'auto', target: lang, format: 'text', api_key: credentials.key }) });
            return responseText(response, data => data?.translatedText);
        }
        case 'google': {
            const translator = new Translator({ to: lang, requestFunction: (...args) => fetchImpl(...args) });
            const result = await translator.translate(text);
            return result?.text;
        }
        case 'yandex': {
            const form = new URLSearchParams();
            form.set('lang', lang);
            for (const chunk of chunks) form.append('text', chunk);
            const response = await fetchImpl(`https://translate.yandex.net/api/v1/tr.json/translate?ucid=${randomUUID()}&srv=android&format=text`,
                { ...options, method: 'POST', body: form });
            return responseText(response, data => Array.isArray(data?.text) && data.text.every(value => typeof value === 'string')
                ? data.text.join() : null);
        }
        case 'lingva': {
            const url = `${credentials.url.replace(/\/$/, '')}/auto/${encodeURIComponent(lang)}/${encodeURIComponent(text)}`;
            return responseText(await fetchImpl(url, options), data => data?.translation);
        }
        case 'deepl': {
            const form = new URLSearchParams({ text, target_lang: lang });
            if (['de', 'fr', 'it', 'es', 'nl', 'ja', 'ru', 'pt-BR', 'pt-PT'].includes(policy.target)) {
                form.set('formality', policy.formality);
            }
            const response = await fetchImpl(credentials.url, { ...options, method: 'POST',
                headers: { Authorization: `DeepL-Auth-Key ${credentials.key}` }, body: form });
            return responseText(response, data => data?.translations?.[0]?.text);
        }
        case 'oneringtranslator': {
            const url = new URL(credentials.url);
            url.searchParams.set('text', text);
            url.searchParams.set('from_lang', policy.from ?? policy.internal);
            url.searchParams.set('to_lang', policy.target);
            return responseText(await fetchImpl(url, options), data => data?.result);
        }
        case 'deeplx': {
            const response = await fetchImpl(credentials.url, { ...options, method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, source_lang: 'auto', target_lang: lang }) });
            return responseText(response, data => data?.data);
        }
        case 'bing': return (await bingTranslate(text, null, lang))?.translation;
        default: throw bad('The selected translation provider is unavailable.');
    }
}

function translatedTarget(output, effect, savedSource, source) {
    if (output.message) return { original: output.message.mes, extra: output.message.extra };
    if (output.messages?.length === 1) return { original: output.messages[0].mes, extra: output.messages[0].extra };
    if (typeof output.text === 'string') {
        const index = source?.message?.index;
        if (effect.type === 'continue' && (!Number.isSafeInteger(index) || index < 0)) {
            throw bad('The accepted continuation anchor is unavailable.');
        }
        const prefix = effect.type === 'continue' ? savedSource?.records?.[index + 1]?.mes : '';
        if (typeof prefix !== 'string') throw bad('The accepted continuation text is unavailable.');
        return { original: prefix + output.text, extra: output.extra };
    }
    throw bad('The saved reply cannot be translated.');
}

/** Translate a saved model reply progressively, retaining its original text and presentation identity. */
export async function translateIncomingRoleplayOutput(context, { base, snapshot, effect, output, assertSource,
    fetchImpl = fetch } = {}) {
    const policy = snapshot?.translation;
    if (!policy) return output;
    const savedSource = assertSource();
    const { original, extra } = translatedTarget(output, effect, savedSource, snapshot.source);
    const fields = [{ key: 'display_text', text: original }];
    if (policy.translateReasoning && typeof extra.reasoning === 'string' && extra.reasoning) {
        fields.push({ key: 'reasoning_display_text', text: extra.reasoning });
    }
    await translateSavedFields(context, { base, snapshot, policy, fields, extra, assertSource, fetchImpl });
    return output;
}

async function translateSavedFields(context, { base, snapshot, policy, fields, extra, assertSource, fetchImpl }) {
    const withAccount = operation => withRoleplayAccount(base, snapshot.account, operation);
    for (const field of fields) {
        const split = field.text.split(/(!\[.*?]\([^)]*\))/g);
        const translated = [];
        for (const [segment, value] of split.entries()) {
            if (!value || /^!\[.*?]\([^)]*\)$/.test(value)) { translated.push(value); continue; }
            const requests = partsForTranslation(value, policy.provider);
            for (const [chunk, chunks] of requests.entries()) {
                const step = `translation:${field.key}:${segment}:${chunk}`;
                const identity = roleplayHash({ account: snapshot.account, policy, field: field.key,
                    source: roleplayHash(field.text), segment, chunk, chunks });
                const artifact = `input:${step}`;
                const saved = withAccount(() => readArtifact(context.directories, context.job.id, artifact));
                const input = { identity, provider: policy.provider, target: policy.target, chunks };
                if (saved !== undefined && roleplayHash(saved) !== roleplayHash(input)) {
                    throw bad('A saved translation input needs recovery.', 'ROLEPLAY_TRANSLATION_RECOVERY', 503);
                }
                if (saved === undefined) withAccount(() => writeArtifact(context.directories, context.job.id, artifact, input));
                const providerArtifact = `provider:${step}`;
                if (readArtifact(context.directories, context.job.id, providerArtifact) === undefined
                    && unresolvedProviderStep(context.directories, context.job.id)) {
                    throw bad('The previous translation provider outcome is unknown.', 'ROLEPLAY_TRANSLATION_RECOVERY', 503);
                }
                let credentials;
                if (readArtifact(context.directories, context.job.id, providerArtifact) === undefined) {
                    assertRoleplayWorldInfoCurrent(base, snapshot);
                    credentials = currentCredentials(base, snapshot, policy);
                }
                const result = await providerStep(context, step, async () => {
                    try {
                        assertSource();
                        assertRoleplayWorldInfoCurrent(base, snapshot);
                        const verified = currentCredentials(base, snapshot, policy);
                        if (roleplayHash(verified) !== roleplayHash(credentials)) {
                            throw bad('The translation connection changed before dispatch.', 'ROLEPLAY_TRANSLATION_SOURCE_CHANGED');
                        }
                    } catch (error) { throw providerNotDispatched(error); }
                    let text;
                    try {
                        text = await transport({ provider: policy.provider, chunks, policy, credentials,
                            fetchImpl, signal: context.signal });
                    } catch (error) {
                        if (context.signal?.aborted) throw error;
                        throw bad('The translation provider did not return a result.', 'ROLEPLAY_TRANSLATION_PROVIDER', 502);
                    }
                    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TRANSLATION_BYTES) {
                        throw bad('The translation provider result is invalid.', 'ROLEPLAY_TRANSLATION_PROVIDER', 502);
                    }
                    return { identity, text };
                }, { readResult: (...args) => withAccount(() => readArtifact(...args)), writeResult: (...args) => withAccount(() => writeArtifact(...args)) });
                if (result?.identity !== identity || typeof result.text !== 'string') {
                    throw bad('The saved translation provider result needs recovery.', 'ROLEPLAY_TRANSLATION_RECOVERY', 503);
                }
                translated.push(result.text);
            }
        }
        const content = translated.join('');
        if (Buffer.byteLength(content) > MAX_TRANSLATION_BYTES) {
            throw bad('The translated reply exceeds its saved limit.', 'ROLEPLAY_TRANSLATION_INVALID');
        }
        extra[field.key] = content;
    }
}

/** Prepare translated input before lore and prompt construction, retaining its accepted original for display. */
export async function prepareRoleplayInputTranslation(context, { base, snapshot, records, assertSource, fetchImpl = fetch }) {
    const captured = snapshot.inputTranslation;
    if (!captured) return { records };
    const { item, policy } = captured;
    const withAccount = operation => withRoleplayAccount(base, snapshot.account, operation);
    const original = records[item.index + 1];
    if (!original?.is_user || !Number.isSafeInteger(item.index) || item.index < 0) throw bad('The saved outgoing translation source is invalid.');
    const identity = roleplayHash({ captured, records, account: snapshot.account, source: snapshot.source });
    const validate = saved => {
        const { hash, ...data } = saved ?? {};
        if (hash !== roleplayHash(data) || data.identity !== identity || typeof data.text !== 'string'
            || data.displayText !== original.mes || Buffer.byteLength(data.text) > MAX_TRANSLATION_BYTES) {
            throw bad('The saved outgoing translation result needs recovery.', 'ROLEPLAY_TRANSLATION_RECOVERY', 503);
        }
        const derived = structuredClone(records);
        derived[item.index + 1].mes = data.text;
        derived[item.index + 1].extra = { ...derived[item.index + 1].extra, display_text: original.mes };
        return { records: derived, hash, change: { index: item.index, recordHash: item.recordHash, text: data.text, displayText: original.mes } };
    };
    const saved = withAccount(() => readArtifact(context.directories, context.job.id, 'roleplay-input-translation'));
    if (saved !== undefined) return validate(saved);
    const extra = {};
    await translateSavedFields(context, { base, snapshot, policy, fields: [{ key: `input:${item.index}`, text: original.mes }],
        extra, assertSource, fetchImpl });
    const data = { identity, text: extra[`input:${item.index}`], displayText: original.mes };
    const result = { ...data, hash: roleplayHash(data) };
    withAccount(() => writeArtifact(context.directories, context.job.id, 'roleplay-input-translation', result));
    return validate(result);
}
