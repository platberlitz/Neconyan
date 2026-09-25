import { Buffer } from 'node:buffer';

import { providerNotDispatched, readArtifact, providerStep, writeArtifact } from '../jobs/artifacts.js';
import { readImageArtifact, writeImageArtifact } from '../jobs/image-artifacts.js';
import { getJob } from '../jobs/store.js';
import { roleplayAccountBase, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { resolveCharacterImageSettings } from '../../public/scripts/extensions/quick-image-gen/lib/character-settings.js';
import { assertQuickImageGenRequestConfigured, generateQuickImageGenImage, materializeQueuedImage,
    readQuickImageGenSettings, resolveQuickImageGenSeed } from './quick-image-gen.js';
import { prepareNanoGptPayload } from './quick-image-gen-nanogpt.js';
import { prepareNanobananaPayload } from './quick-image-gen-nanobanana.js';
import { generateQueuedImageJob } from './quick-image-gen-queued.js';
import { generateComfyImageJob } from './quick-image-gen-comfy.js';
import { prepareProxyImageRequest } from './quick-image-gen-proxy.js';
import { prepareA1111ImageRequest } from './quick-image-gen-a1111.js';
import { generateCustomImageJob, prepareCustomImageReferences } from './quick-image-gen-custom.js';
import { freezeQuickImageReferenceSources } from './quick-image-gen-reference.js';

const recovery = message => Object.assign(new Error(message), { status: 409, code: 'QIG_RESULT_RECOVERY' });
const sourceChanged = () => Object.assign(new Error('The accepted Quick Image Gen provider settings changed before the image request.'), { status: 409, code: 'QIG_SETTINGS_CHANGED' });

function accountBase(context) {
    const base = roleplayAccountBase(context.directories);
    if (!base || base.owner !== context.owner) throw recovery('The image job has no protected account identity.');
    return base;
}

/** Only an identity, never a provider key or connection URL, belongs in a saved job. */
export function quickImageGenSettingsFingerprint(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw recovery('The accepted image provider settings are unavailable.');
    return roleplayHash(settings);
}

/** Save an image request before dispatch; a restarted job may only use its recorded result. */
export async function generateQuickImageGenJobImage(context, { effectId, prompt, negative = '', settingsFingerprint,
    expectedAccount, assertSourceLocked, seedOverride, batch, characterScope, referenceSources, proxyContext, proxyReferences, fetch, wait } = {}) {
    if (typeof effectId !== 'string' || !effectId || effectId.length > 128) throw recovery('The image request has no stable effect identity.');
    if (seedOverride !== undefined && (!Number.isSafeInteger(seedOverride) || seedOverride < 0 || seedOverride > 0xffffffff)) {
        throw recovery('The saved image seed override is invalid.');
    }
    if (batch !== undefined && (!batch || !Number.isSafeInteger(batch.index) || !Number.isSafeInteger(batch.count)
        || batch.count < 1 || batch.count > 10 || batch.index < 0 || batch.index >= batch.count)) throw recovery('The saved image batch is invalid.');
    if (proxyContext !== undefined && (typeof proxyContext !== 'string' || Buffer.byteLength(proxyContext) > 16 * 1024)
        || proxyReferences !== undefined && (!Array.isArray(proxyReferences) || proxyReferences.length > 15
             || proxyReferences.some(value => typeof value !== 'string' || !value))) throw recovery('The saved image proxy context is invalid.');
    if (referenceSources !== undefined && (!Array.isArray(referenceSources) || referenceSources.length > 30
        || referenceSources.some(value => !value || !/^[a-f0-9]{64}$/.test(value.sourceHash)
            || !/^[a-f0-9]{64}$/.test(value.rawHash) || !value.physical)
        || new Set(referenceSources.map(value => value.sourceHash)).size !== referenceSources.length)) throw recovery('The accepted reference identities are invalid.');
    const extraInput = { ...(batch ? { batch: { index: batch.index, count: batch.count } } : {}),
        ...(characterScope !== undefined ? { characterScope: structuredClone(characterScope) } : {}),
        ...(referenceSources !== undefined ? { referenceSourcesHash: roleplayHash(referenceSources) } : {}),
        ...(proxyContext !== undefined ? { proxyContextHash: roleplayHash(proxyContext) } : {}),
        ...(proxyReferences !== undefined ? { proxyReferencesHash: roleplayHash(proxyReferences) } : {}) };
    const name = `quick-image:${effectId}`;
    const inputName = `input:${name}`;
    let input = readArtifact(context.directories, context.job.id, inputName);
    const base = accountBase(context);
    if (input === undefined) {
        input = withRoleplayAccount(base, expectedAccount ?? null, (_lease, account) => {
            assertSourceLocked?.(_lease);
            const settings = resolveCharacterImageSettings(readQuickImageGenSettings(context.directories), characterScope);
            const fingerprint = quickImageGenSettingsFingerprint(settings);
            if (settingsFingerprint !== undefined && fingerprint !== settingsFingerprint) throw sourceChanged();
            const prepared = { effectId, prompt: String(prompt || '').trim(), negative: String(negative || ''),
                provider: settings.provider || '', settingsFingerprint: fingerprint,
                seed: resolveQuickImageGenSeed(seedOverride ?? settings.seed),
                ...(seedOverride !== undefined ? { seedOverride } : {}),
                ...(settings.provider === 'proxy' ? { proxySeed: resolveQuickImageGenSeed(seedOverride ?? settings.proxySeed) } : {}),
                ...extraInput, account };
            if (!prepared.prompt) throw recovery('The image request has no prompt.');
            writeArtifact(context.directories, context.job.id, inputName, prepared);
            return prepared;
        });
    }
    if (input?.effectId !== effectId || typeof input.prompt !== 'string' || !input.prompt
        || typeof input.negative !== 'string' || typeof input.provider !== 'string'
        || !/^[0-9a-f]{64}$/.test(input.settingsFingerprint)
        || !Number.isSafeInteger(input.seed) || input.seed < 0
        || input.provider === 'proxy' && (!Number.isSafeInteger(input.proxySeed) || input.proxySeed < 0)
        || typeof input.account?.accountId !== 'string' || !Number.isSafeInteger(input.account.dataEpoch)
        || input.prompt !== String(prompt || '').trim() || input.negative !== String(negative || '')
        || input.seedOverride !== seedOverride
        || roleplayHash(Object.fromEntries(Object.keys(extraInput).map(key => [key, input[key] ?? null]))) !== roleplayHash(extraInput)
        || ['batch', 'characterScope', 'referenceSourcesHash', 'proxyContextHash', 'proxyReferencesHash'].some(key => Object.hasOwn(input, key) !== Object.hasOwn(extraInput, key))
        || settingsFingerprint !== undefined && settingsFingerprint !== input.settingsFingerprint
        || expectedAccount && (expectedAccount.accountId !== input.account.accountId
            || expectedAccount.dataEpoch !== input.account.dataEpoch)) {
        throw recovery('The saved image inputs no longer match the accepted request.');
    }
    let activeLease;
    const withAccount = operation => withRoleplayAccount(base, input.account, lease => {
        activeLease = lease;
        try { return operation(lease); } finally { activeLease = undefined; }
    });
    const readSettingsLocked = () => {
        try { assertSourceLocked?.(activeLease); return resolveCharacterImageSettings(readQuickImageGenSettings(context.directories), characterScope); } catch (error) {
            throw providerNotDispatched(error);
        }
    };
    const readSettings = () => {
        try { return withAccount(readSettingsLocked); } catch (error) { throw providerNotDispatched(error); }
    };
    withAccount(() => {});
    const step = `provider:${name}`;
    const savedResult = withAccount(() => readImageArtifact(context.directories, context.job.id, step));
    if (savedResult === undefined && getJob(context.directories, context.job.id)?.resume === step) {
        throw recovery('The image provider outcome is unknown and cannot be repeated automatically.');
    }
    // After a paid result was saved, changing settings cannot change or replay it.
    // Before dispatch, reject even a changed key, and retain the real key only in memory.
    let settings;
    let providerInput;
    const referenceContext = referenceSources === undefined ? context : { ...context, referenceSources };
    if (savedResult === undefined) {
        settings = readSettings();
        if (quickImageGenSettingsFingerprint(settings) !== input.settingsFingerprint || settings.provider !== input.provider) throw sourceChanged();
        withAccount(() => freezeQuickImageReferenceSources(referenceContext));
        assertQuickImageGenRequestConfigured({ ...settings, seed: input.seed,
            ...(input.provider === 'proxy' ? { proxySeed: input.proxySeed, __qigProxyContext: proxyContext,
                __qigProxyReferences: proxyReferences } : {}) }, input.prompt, input.negative);
        if (input.provider === 'nanogpt') {
            providerInput = await prepareNanoGptPayload(referenceContext, {
                effectId, settings: { ...settings, seed: input.seed }, fingerprint: input.settingsFingerprint,
                prompt: input.prompt, negative: input.negative, fetchImpl: fetch || globalThis.fetch,
                readSettings, readSettingsLocked, withAccount,
            });
        } else if (input.provider === 'nanobanana') {
            providerInput = await prepareNanobananaPayload(referenceContext, {
                effectId, settings: { ...settings, seed: input.seed }, fingerprint: input.settingsFingerprint,
                prompt: input.prompt, negative: input.negative, fetchImpl: fetch || globalThis.fetch,
                readSettings, readSettingsLocked, withAccount,
            });
        } else if (input.provider === 'proxy') {
            providerInput = await prepareProxyImageRequest(referenceContext, { effectId,
                settings: { ...settings, __qigProxyContext: proxyContext, __qigProxyReferences: proxyReferences }, fingerprint: input.settingsFingerprint,
                input, fetchImpl: fetch || globalThis.fetch, withAccount,
                readSettingsLocked });
        } else if (input.provider === 'local' && settings.localType !== 'comfyui') {
            providerInput = await prepareA1111ImageRequest(referenceContext, { effectId, input, settings, fingerprint: input.settingsFingerprint,
                withAccount, readSettingsLocked, fetchImpl: fetch || globalThis.fetch });
        } else if (input.provider === 'custom') {
            providerInput = await prepareCustomImageReferences(referenceContext, { effectId, input, settings, fingerprint: input.settingsFingerprint,
                withAccount, readSettingsLocked, fetchImpl: fetch || globalThis.fetch });
            assertQuickImageGenRequestConfigured({ ...settings, seed: input.seed, __qigCustomReferences: providerInput }, input.prompt, input.negative);
        }
    }
    let image = savedResult;
    if (image === undefined) {
        if (input.provider === 'custom' && settings.customApiMode === 'async') {
            image = await generateCustomImageJob(context, { effectId, input, settings, references: providerInput,
                fingerprint: input.settingsFingerprint, fetchImpl: fetch || globalThis.fetch, readSettings, withAccount, wait });
            withAccount(() => writeImageArtifact(context.directories, context.job.id, step, image));
        } else if (['replicate', 'civitai'].includes(input.provider) || input.provider === 'local' && settings.localType === 'comfyui') {
            image = input.provider === 'local'
                ? await generateComfyImageJob(referenceContext, { effectId, input, settings,
                    fingerprint: input.settingsFingerprint, fetchImpl: fetch || globalThis.fetch,
                    readSettings, readSettingsLocked,
                    withAccount, ...(wait ? { wait } : {}) })
                : await generateQueuedImageJob(context, { effectId, input, settings,
                    fingerprint: input.settingsFingerprint, fetchImpl: fetch || globalThis.fetch,
                    readSettings, materializeSource: materializeQueuedImage, ...(wait ? { wait } : {}) });
            withAccount(() => writeImageArtifact(context.directories, context.job.id, step, image));
        } else {
            image = await providerStep(context, name, async () => {
                const current = readSettings();
                if (quickImageGenSettingsFingerprint(current) !== input.settingsFingerprint || current.provider !== input.provider) {
                    throw providerNotDispatched(sourceChanged());
                }
                return generateQuickImageGenImage({ directories: context.directories, prompt: input.prompt, negative: input.negative,
                    settings: { ...current, seed: input.seed,
                        ...(input.provider === 'nanogpt' ? { __qigNanoGptPayload: providerInput } : {}),
                        ...(input.provider === 'nanobanana' ? { __qigNanobananaPayload: providerInput } : {}),
                        ...(input.provider === 'local' ? { __qigA1111Request: providerInput } : {}),
                        ...(input.provider === 'custom' ? { __qigCustomReferences: providerInput } : {}),
                        ...(input.provider === 'proxy' ? { proxySeed: input.proxySeed, __qigProxyRequest: providerInput,
                            __qigProxyContext: proxyContext, __qigProxyReferences: proxyReferences } : {}) },
                    signal: context.signal, fetch });
            }, {
                readResult: () => withAccount(() => readImageArtifact(context.directories, context.job.id, step)),
                writeResult: (_directories, _id, _name, result) => withAccount(() => writeImageArtifact(context.directories, context.job.id, step, result)),
            });
        }
    }
    const bytes = typeof image?.base64 === 'string' ? Buffer.from(image.base64, 'base64') : null;
    const format = bytes && detectImageFormat(bytes);
    if (!format || image.format !== (format.ext === 'jpeg' ? 'jpg' : format.ext)) {
        throw recovery('The saved image result is invalid; no provider request was repeated.');
    }
    return image;
}
