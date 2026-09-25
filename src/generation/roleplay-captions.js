import { randomInt } from 'node:crypto';
import path from 'node:path';
import { createMacroEnvironment } from '../macros/index.js';
import { providerNotDispatched, providerStep, readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { setJobResume } from '../jobs/store.js';
import { readBinaryArtifact, writeBinaryArtifact } from '../jobs/binary-artifacts.js';
import { readRoleplayFile, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { abortableSleep } from '../../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';
import { captionError, captionLocalImage, MAX_CAPTION_BYTES, prepareCaptionRequest, readCaptionResponse,
    resolveCaptionConfiguration, sendCaptionRequest, validateCaption } from './caption-transports.js';
import { applyCaptionRecords } from './caption-records.js';

const DEFAULT_PROMPT = 'What\'s in this image?';
const DEFAULT_TEMPLATE = '[{{user}} sends {{char}} a picture that contains: {{caption}}]';

/** Bind the exact selected uploaded media before the job intent is accepted. The caller holds the account lock. */
export function captureRoleplayCaptions(directories, settings, { records, images, serverPrompt, display,
    automatic = true, selection = [], reviewedPrompt, reviewed } = {}) {
    const options = settings.extension_settings?.caption ?? {};
    if (settings.extension_settings?.disabledExtensions?.includes('caption') || automatic && (!serverPrompt || !options.auto_mode)) return null;
    const items = [];
    let imageIndex = 0;
    if (!automatic) {
        if (!Array.isArray(selection) || !selection.length || selection.length > 4) throw captionError('Select the saved media to caption.');
        for (const { index, mediaIndex, imageIndex } of selection) {
            const record = Number.isSafeInteger(index) && index >= 0 ? records[index + 1] : null;
            const media = Number.isSafeInteger(mediaIndex) && mediaIndex >= 0 ? record?.extra?.media?.[mediaIndex] : null;
            if (!record || !media || !images[imageIndex] || images[imageIndex].index !== index) throw captionError('The selected caption media is invalid.');
            items.push({ index, mediaIndex, imageIndex, recordHash: roleplayHash(record), mediaHash: roleplayHash(media) });
        }
    } else records.slice(1).forEach((record, index) => {
        const media = record.extra?.media ?? [];
        const indices = (record.extra?.media_display ?? display) === 'gallery' ? media.length ? [record.extra?.media_index ?? 0] : []
            : media.map((_item, mediaIndex) => mediaIndex);
        for (const mediaIndex of indices) {
            const image = images[imageIndex];
            if (!image || image.index !== index) throw captionError('The saved caption image selection is inconsistent.');
            const item = media[mediaIndex];
            if (item.source === 'upload' && !item.captioned && !record.is_system) {
                items.push({ index, mediaIndex, imageIndex, recordHash: roleplayHash(record), mediaHash: roleplayHash(item) });
            }
            imageIndex++;
        }
    });
    if (!items.length) return null;
    if (automatic && (options.refine_mode || options.prompt_ask)
        || !automatic && (options.refine_mode && !reviewed || options.prompt_ask && typeof reviewedPrompt !== 'string' && !reviewed)) {
        throw captionError('Complete the configured caption review before accepting this reply.', 'ROLEPLAY_CAPTION_REVIEW_REQUIRED');
    }
    const prompt = reviewedPrompt ?? (options.prompt || DEFAULT_PROMPT);
    let template = options.template || DEFAULT_TEMPLATE;
    if (typeof prompt !== 'string' || typeof template !== 'string'
        || Buffer.byteLength(prompt) > MAX_CAPTION_BYTES || Buffer.byteLength(template) > MAX_CAPTION_BYTES) {
        throw captionError('The saved caption instructions are invalid.');
    }
    if (!/{{caption}}/i.test(template)) template += ' {{caption}}';
    if (reviewed && ['caption', 'title'].some(key => typeof reviewed[key] !== 'string' || !reviewed[key].trim()
        || Buffer.byteLength(reviewed[key]) > MAX_CAPTION_BYTES)) throw captionError('The reviewed caption is invalid.');
    const config = reviewed ? { source: options.source || 'local', reviewed: true } : resolveCaptionConfiguration(directories, settings);
    return { persist: true, source: config.source, model: config.model ?? '', api: config.api ?? '', prompt, template,
        fingerprint: roleplayHash(config), optionsHash: roleplayHash(options), items,
        ...(!automatic ? { manual: true } : {}), ...(reviewed ? { reviewed: { caption: reviewed.caption, title: reviewed.title } } : {}) };
}

function currentConfiguration(base, snapshot) {
    return withRoleplayAccount(base, snapshot.account, () => {
        let settings;
        try {
            const saved = readRoleplayFile(path.join(base.directories.root, 'settings.json'), 8 * 1024 * 1024);
            settings = saved && JSON.parse(saved.bytes.toString('utf8'));
        } catch { throw captionError('The saved caption settings are unavailable.', 'ROLEPLAY_CAPTION_SOURCE_CHANGED'); }
        if (!settings || roleplayHash(settings) !== snapshot.settingsHash
            || roleplayHash(settings.extension_settings?.caption ?? {}) !== snapshot.captions.optionsHash) {
            throw captionError('The caption settings changed after admission.', 'ROLEPLAY_CAPTION_SOURCE_CHANGED');
        }
        const config = resolveCaptionConfiguration(base.directories, settings);
        if (roleplayHash(config) !== snapshot.captions.fingerprint) {
            throw captionError('The caption connection changed after admission.', 'ROLEPLAY_CAPTION_SOURCE_CHANGED');
        }
        return config;
    });
}

function captionRecords(original, policy, results) {
    return applyCaptionRecords(original, policy.items, results);
}

function boundMedia(context, base, snapshot, source) {
    if (!source.file) return source;
    if (typeof source.file !== 'string' || source.file.split('/').some(part => !part || part === '.' || part === '..')
        || source.file.includes('\\') || source.file.includes('\0') || !/^video\/(?:mp4|webm|quicktime|mpeg|ogg)$/.test(source.mimeType)) {
        throw captionError('The saved caption media path is invalid.');
    }
    const name = `input:caption-media:${source.rawHash}`;
    return withRoleplayAccount(base, snapshot.account, () => {
        let bytes = readBinaryArtifact(context.directories, context.job.id, name);
        if (bytes === undefined) {
            const file = readRoleplayFile(path.join(base.directories.root, source.file), 25 * 1024 * 1024);
            if (!file || file.rawHash !== source.rawHash || roleplayHash(file.physical) !== roleplayHash(source.physical)) {
                throw captionError('The saved caption media changed after admission.', 'ROLEPLAY_CAPTION_SOURCE_CHANGED');
            }
            bytes = writeBinaryArtifact(context.directories, context.job.id, name, file.bytes);
        }
        return { ...source, url: `data:${source.mimeType};base64,${bytes.toString('base64')}` };
    });
}

async function hordeCaption(context, { base, snapshot, input, image, step, assertCurrent, fetchImpl, wait, withAccount }) {
    const resultName = `${step}:horde-result`;
    const previous = withAccount(() => readArtifact(context.directories, context.job.id, resultName));
    if (previous !== undefined) {
        if (previous?.identity !== input.identity) throw captionError('The saved Horde caption differs from its image.', 'ROLEPLAY_CAPTION_RECOVERY', 503);
        return validateCaption(previous.caption);
    }
    const savedId = withAccount(() => readArtifact(context.directories, context.job.id, `provider:${step}:submit`));
    if (savedId === undefined) assertCurrent();
    const config = currentConfiguration(base, snapshot);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10 * 60 * 1000)]);
    const submitted = await providerStep(context, `${step}:submit`, async () => {
        try { assertCurrent(); currentConfiguration(base, snapshot); } catch (error) { throw providerNotDispatched(error); }
        let response;
        try {
            response = await fetchImpl('https://aihorde.net/api/v2/interrogate/async', { method: 'POST', redirect: 'error', signal,
                headers: { 'Content-Type': 'application/json', apikey: config.key, 'Client-Agent': 'Neconyan:1.0.0' },
                body: JSON.stringify({ source_image: image.url.split(',')[1], forms: [{ name: 'caption' }] }) });
        } catch {
            throw captionError('The Horde caption submission has no confirmed result.', 'ROLEPLAY_CAPTION_PROVIDER', 502);
        }
        const responseBody = await readCaptionResponse(response, signal);
        if (typeof responseBody.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(responseBody.id)) {
            throw captionError('Horde did not return a saved caption identifier.', 'ROLEPLAY_CAPTION_PROVIDER', 502);
        }
        return { identity: input.identity, id: responseBody.id };
    }, { readResult: (...args) => withAccount(() => readArtifact(...args)), writeResult: (...args) => withAccount(() => writeArtifact(...args)) });
    if (submitted?.identity !== input.identity || typeof submitted.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(submitted.id)) throw captionError('The saved Horde submission is invalid.', 'ROLEPLAY_CAPTION_RECOVERY', 503);
    setJobResume(context.directories, context.job.id, `${step}:poll`);
    for (let attempt = 0; attempt < 200; attempt++) {
        signal.throwIfAborted();
        withAccount(() => {});
        let response;
        try {
            response = await fetchImpl(`https://aihorde.net/api/v2/interrogate/status/${encodeURIComponent(submitted.id)}`,
                { redirect: 'error', signal, headers: { apikey: config.key, 'Client-Agent': 'Neconyan:1.0.0' } });
        } catch { throw captionError('The saved Horde caption could not be checked.', 'ROLEPLAY_CAPTION_POLL', 502); }
        const status = await readCaptionResponse(response, signal);
        if (['faulted', 'cancelled'].includes(status.state)) throw captionError('The saved Horde caption did not complete.', 'ROLEPLAY_CAPTION_PROVIDER', 502);
        if (status.state === 'done') {
            const caption = validateCaption(status.forms?.find(form => form.form === 'caption' || form.name === 'caption')?.result?.caption
                ?? status.forms?.[0]?.result?.caption);
            withAccount(() => writeArtifact(context.directories, context.job.id, resultName, { identity: input.identity, caption }));
            return caption;
        }
        await wait(3000, signal);
    }
    throw captionError('The saved Horde caption is still pending.', 'ROLEPLAY_CAPTION_POLL', 503);
}

/** Finish captions before history and lore selection, using derived records rather than editing the saved chat. */
export async function prepareRoleplayCaptions(context, { base, snapshot, records, macros, assertCurrent,
    fetchImpl = fetch, localCaption = captionLocalImage, wait = abortableSleep } = {}) {
    const policy = snapshot.captions;
    if (!policy) return { records, hash: null };
    const withAccount = operation => withRoleplayAccount(base, snapshot.account, operation);
    const identity = roleplayHash({ snapshot, records });
    const saved = withAccount(() => readArtifact(context.directories, context.job.id, 'roleplay-captions'));
    const validateResult = value => {
        const { hash, ...data } = value ?? {};
        if (data.identity !== identity || hash !== roleplayHash(data) || !Array.isArray(data.results)
            || data.results.length !== policy.items.length || data.results.some(result => typeof result?.title !== 'string'
                || Buffer.byteLength(result.title) > MAX_CAPTION_BYTES || typeof result.caption !== 'string')) {
            throw captionError('The saved captions need recovery.', 'ROLEPLAY_CAPTION_RECOVERY', 503);
        }
        const derived = captionRecords(records, policy, data.results);
        if (roleplayHash(derived) !== data.recordsHash) throw captionError('The saved caption history differs.', 'ROLEPLAY_CAPTION_RECOVERY', 503);
        return { records: derived, hash };
    };
    if (saved !== undefined) return validateResult(saved);
    const results = [];
    for (const item of policy.items) {
        context.signal.throwIfAborted();
        const record = records[item.index + 1];
        const sourceImage = snapshot.images[item.imageIndex];
        if (!record || !sourceImage || sourceImage.index !== item.index || roleplayHash(record) !== item.recordHash
            || roleplayHash(record.extra?.media?.[item.mediaIndex]) !== item.mediaHash) {
            throw captionError('The caption image no longer matches its saved message.', 'ROLEPLAY_CAPTION_SOURCE_CHANGED');
        }
        if (policy.reviewed) { results.push(structuredClone(policy.reviewed)); continue; }
        const image = boundMedia(context, base, snapshot, sourceImage);
        const step = `roleplay-caption:${item.index}:${item.mediaIndex}`;
        const inputName = `input:${step}`;
        let input = withAccount(() => readArtifact(context.directories, context.job.id, inputName));
        const sourceIdentity = roleplayHash({ identity, item });
        if (input === undefined) {
            assertCurrent();
            currentConfiguration(base, snapshot);
            const environment = createMacroEnvironment(macros, {}, { readOnly: true });
            const prompt = environment.evaluate(policy.prompt, { legacy: !snapshot.experimentalMacroEngine, strictCapabilities: true });
            const data = { identity: sourceIdentity, prompt, seed: randomInt(0, 2 ** 32), imageHash: image.rawHash };
            input = { ...data, hash: roleplayHash(data) };
            withAccount(() => writeArtifact(context.directories, context.job.id, inputName, input));
        }
        const { hash: inputHash, ...inputData } = input ?? {};
        if (input?.identity !== sourceIdentity || inputHash !== roleplayHash(inputData) || input.imageHash !== image.rawHash || typeof input.prompt !== 'string'
            || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed >= 2 ** 32) {
            throw captionError('The saved caption request needs recovery.', 'ROLEPLAY_CAPTION_RECOVERY', 503);
        }
        const resultName = policy.source === 'local' ? `${step}:local-result` : `provider:${step}`;
        let result = withAccount(() => readArtifact(context.directories, context.job.id, resultName));
        if (result === undefined) {
            if (unresolvedProviderStep(context.directories, context.job.id)) {
                throw captionError('An earlier provider result is unknown and cannot be repeated.', 'ROLEPLAY_CAPTION_RECOVERY', 503);
            }
            assertCurrent();
            const config = currentConfiguration(base, snapshot);
            if (policy.source === 'local') {
                setJobResume(context.directories, context.job.id, `${step}:local`);
                const caption = validateCaption(await localCaption(config, image.url, context.signal));
                result = { identity: input.identity, caption };
                withAccount(() => writeArtifact(context.directories, context.job.id, resultName, result));
            } else if (policy.source === 'horde') {
                const caption = await hordeCaption(context, { base, snapshot, input, image, step, assertCurrent, fetchImpl, wait, withAccount });
                result = { identity: input.identity, caption };
                withAccount(() => writeArtifact(context.directories, context.job.id, resultName, result));
            } else {
                const signal = AbortSignal.any([context.signal, AbortSignal.timeout(180000)]);
                let request;
                try { request = await prepareCaptionRequest(config, { image: image.url, prompt: input.prompt, seed: input.seed, signal, fetchImpl }); } catch (error) {
                    if (context.signal.aborted) throw context.signal.reason;
                    throw captionError('The configured caption request could not be prepared.', 'ROLEPLAY_CAPTION_PREPARATION');
                }
                const requestIdentity = { identity: input.identity, bodyHash: roleplayHash(request.body) };
                withAccount(() => {
                    const previous = readArtifact(context.directories, context.job.id, `${inputName}:request`);
                    if (previous !== undefined && roleplayHash(previous) !== roleplayHash(requestIdentity)) {
                        throw captionError('The prepared caption request differs from its saved input.', 'ROLEPLAY_CAPTION_RECOVERY', 503);
                    }
                    if (previous === undefined) writeArtifact(context.directories, context.job.id, `${inputName}:request`, requestIdentity);
                });
                result = await providerStep(context, step, async () => {
                    try { assertCurrent(); currentConfiguration(base, snapshot); } catch (error) { throw providerNotDispatched(error); }
                    try { return { identity: input.identity, caption: await sendCaptionRequest(config, request, { signal, fetchImpl }) }; } catch {
                        throw captionError('The caption request has no confirmed result.', 'ROLEPLAY_CAPTION_PROVIDER', 502);
                    }
                }, { readResult: (...args) => withAccount(() => readArtifact(...args)), writeResult: (...args) => withAccount(() => writeArtifact(...args)) });
            }
        }
        if (result?.identity !== input.identity) throw captionError('The saved caption belongs to a different image.', 'ROLEPLAY_CAPTION_RECOVERY', 503);
        const caption = validateCaption(result.caption);
        const environment = createMacroEnvironment(macros, {}, { readOnly: true, dynamicMacros: { caption } });
        const title = environment.evaluate(policy.template, { legacy: !snapshot.experimentalMacroEngine, strictCapabilities: true });
        if (typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > MAX_CAPTION_BYTES) throw captionError('The saved caption template result is invalid.');
        results.push({ caption, title });
    }
    const derived = captionRecords(records, policy, results);
    const data = { identity, results, recordsHash: roleplayHash(derived) };
    const result = { ...data, hash: roleplayHash(data) };
    withAccount(() => writeArtifact(context.directories, context.job.id, 'roleplay-captions', result));
    return validateResult(result);
}
