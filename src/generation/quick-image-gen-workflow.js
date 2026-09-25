import path from 'node:path';
import { appendWorldInfoToRequest, dedupePromptTags } from '../../public/scripts/extensions/quick-image-gen/lib/prompt-pipeline.js';
import { buildImagePromptInstruction, buildSceneDescriptionInstruction, cleanImagePrompt, cleanSceneDescription,
    QIG_ARTISTS } from '../../public/scripts/extensions/quick-image-gen/lib/prompt-instructions.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { registerHandler } from '../jobs/runner.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked } from './roleplay-source.js';
import { admitNativeMediaJob, ensureNativeMediaDirectory, finishNativeMediaJob, mediaDirectoryEvidence,
    publishNativeMediaFile, withNativeMediaReceipt } from './media-jobs.js';
import { readSavedImageSettings } from './quick-image-gen-request.js';
import { generateQuickImageGenJobImage } from './quick-image-gen-job.js';
import { prepareConversationScopedImagePrompt } from './quick-image-gen-scoped.js';
import { runQuickImageTextStep } from './quick-image-gen-text.js';
import { prepareRoleplayWorldInfo } from './world-info.js';
import { buildSavedProxyImageContext } from './quick-image-gen-proxy.js';
import { freezeQuickImageReferenceSources } from './quick-image-gen-reference.js';

const fail = (message, code = 'QIG_RESULT_RECOVERY') => roleplayError(code, message, 409);

export function admitQuickImageJob(base, account, { operationKey, source, request }) {
    if (request?.version !== 1 || roleplayHash(request.account) !== roleplayHash({ accountId: account.accountId, dataEpoch: account.dataEpoch })) {
        throw fail('The image request belongs to another account.', 'QIG_INPUT_INVALID');
    }
    return admitNativeMediaJob(base, account, { operationKey, source, request, kind: 'images',
        target: { kind: 'images', id: source.instanceId, branchId: request.avatar } });
}

function draw(random, length) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw fail('The image random choice is invalid.');
    return Math.floor(value * length);
}

function fixedSeed(value) {
    if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return null;
    return Math.min(0xffffffff, Math.floor(Number(value)));
}

function expandWildcards(value, random) {
    return value.replace(/\{([^{}]+)\}/g, (whole, choices) => {
        if (!choices.includes('|')) return whole;
        const items = choices.split('|');
        return items[draw(random, items.length)];
    });
}

/** Full prompt passes, saved lore, styling and per-image choices finish independently of any page. */
export async function runQuickImageJob(context, { generateText, fetchImpl = fetch, random = Math.random,
    wait, afterPublication } = {}) {
    const request = context.job.intent?.request;
    if (context.job.intent?.kind !== 'images' || request?.version !== 1 || !request.snapshot || !request.scene
        || !Number.isSafeInteger(request.batchCount) || request.batchCount < 1 || request.batchCount > 10) {
        throw fail('The accepted image workflow is invalid.', 'QIG_INPUT_INVALID');
    }
    const prior = withNativeMediaReceipt(context, ({ value }) => value.state === 'closed' ? value.result : null, { checkSource: false });
    if (prior) return { result: prior };
    const base = { owner: context.owner, directories: context.directories };
    const account = request.account;
    const identity = roleplayHash(context.job.intent);
    const parents = request.parents.map(parent => ({ relative: parent.relative, after: ensureNativeMediaDirectory(context, parent) }));
    const checkSource = lease => {
        context.signal.throwIfAborted();
        assertRoleplaySourceLocked(lease, context.job.intent.source);
        if (roleplayHash(readSavedImageSettings(context.directories)) !== request.settingsHash) throw fail('The saved image settings changed.', 'QIG_SETTINGS_CHANGED');
        freezeQuickImageReferenceSources({ ...context, referenceSources: request.snapshot.quickImageGenReferenceSources });
        for (const parent of parents) if (roleplayHash(mediaDirectoryEvidence(path.join(context.directories.root, parent.relative))) !== roleplayHash(parent.after)) {
            throw fail('The accepted image destination changed.', 'QIG_SOURCE_CHANGED');
        }
    };
    const withAccount = operation => withRoleplayAccount(base, account, operation);
    const read = name => withAccount(() => {
        const saved = readArtifact(context.directories, context.job.id, name);
        if (saved === undefined) return undefined;
        const { hash, ...data } = saved ?? {};
        if (hash !== roleplayHash(data) || data.identity !== identity) throw fail('The saved image workflow evidence changed.');
        return data;
    });
    const save = (name, value) => withAccount(() => {
        const data = { identity, ...value };
        const output = { ...data, hash: roleplayHash(data) };
        const previous = readArtifact(context.directories, context.job.id, name);
        if (previous !== undefined && roleplayHash(previous) !== roleplayHash(output)) throw fail('The saved image workflow input cannot be replaced.');
        if (previous === undefined) writeArtifact(context.directories, context.job.id, name, output);
        return data;
    });
    let prompt = read('image:prompt');
    if (!prompt) {
        withAccount(checkSource);
        if (request.reviewed) {
            prompt = save('image:prompt', { positive: request.reviewed.positive, negative: request.reviewed.negative,
                seedOverride: null, reviewed: true });
        } else {
            let choices = read('image:prompt-choices');
            if (!choices) choices = save('image:prompt-choices', { artist: request.options.llmAddArtist
                ? QIG_ARTISTS[draw(random, QIG_ARTISTS.length)] : '' });
            let lore = read('image:world-info');
            if (lore === undefined && request.worldInfo) {
                const selection = await prepareRoleplayWorldInfo(base, request.worldInfo, {
                    macros: request.snapshot.macros, promptChat: [request.scene, ...request.worldInfo.chat], random,
                });
                if (selection.hookEvents.actions.length) throw fail('The image lore selection needs its native Quick Reply action.', 'QIG_CONTRIBUTOR_PENDING');
                const text = selection.activeLore.map(entry => `[${entry.title}]\n${entry.content}`).join('\n\n');
                withAccount(checkSource);
                lore = save('image:world-info', { selection, text });
            }
            let sourceText = request.scene;
            if (request.options.useLLMPrompt && request.options.twoStepPrompt && request.mode === 'scene') {
                const instruction = appendWorldInfoToRequest(buildSceneDescriptionInstruction(request.options, request.scene,
                    request.profile, { isMultiMessage: request.isMultiMessage }), lore?.text || '');
                const response = await runQuickImageTextStep(context, { base, account, effectId: 'manual', stage: 'scene-description',
                    instruction, snapshot: request.snapshot, beforeDispatch: checkSource, generate: generateText });
                sourceText = cleanSceneDescription(response.text);
                if (!sourceText) throw fail('The image scene description contains no usable text.', 'QIG_TEXT_INVALID');
            }
            let generatedPrompt = sourceText;
            if (request.options.useLLMPrompt) {
                const instruction = appendWorldInfoToRequest(buildImagePromptInstruction(request.options, sourceText,
                    request.profile, { isMultiMessage: request.isMultiMessage && !request.options.twoStepPrompt, artist: choices.artist }), lore?.text || '');
                const response = await runQuickImageTextStep(context, { base, account, effectId: 'manual', stage: 'image-prompt',
                    instruction, snapshot: request.snapshot, prefill: request.snapshot.quickImageGenTextAI.prefill,
                    beforeDispatch: checkSource, generate: generateText });
                generatedPrompt = cleanImagePrompt(response.text, response.prefill, request.profile, sourceText);
                if (!generatedPrompt) throw fail('The image prompt contains no usable text.', 'QIG_TEXT_INVALID');
            }
            const styled = await prepareConversationScopedImagePrompt(context, { effectId: 'manual', prompt: generatedPrompt,
                negative: request.negative, snapshot: request.snapshot, matchText: request.scene, llmSceneText: request.scene,
                expectedAccount: account, assertSourceLocked: checkSource, generateClassifier: generateText });
            prompt = save('image:prompt', { positive: dedupePromptTags(styled.prompt), negative: dedupePromptTags(styled.negative),
                seedOverride: styled.seedOverride ?? null, reviewed: false });
        }
    }
    if (typeof prompt.positive !== 'string' || !prompt.positive.trim() || typeof prompt.negative !== 'string') throw fail('The saved final image prompt is invalid.');
    let plan = read('image:batch');
    if (!plan) {
        const seed = prompt.seedOverride ?? fixedSeed(request.seed);
        const baseSeed = request.options.sequentialSeeds && request.batchCount > 1 ? seed ?? draw(random, 2147483647) : seed;
        const items = Array.from({ length: request.batchCount }, (_, index) => ({ index,
            seed: request.options.sequentialSeeds && request.batchCount > 1 ? (baseSeed + index) >>> 0 : baseSeed ?? draw(random, 2147483647),
            positive: expandWildcards(prompt.positive, random), negative: expandWildcards(prompt.negative, random) }));
        withAccount(checkSource);
        plan = save('image:batch', { promptHash: roleplayHash(prompt), items });
    }
    if (plan.promptHash !== roleplayHash(prompt) || !Array.isArray(plan.items) || plan.items.length !== request.batchCount
        || plan.items.some((item, index) => item.index !== index || !Number.isSafeInteger(item.seed) || item.seed < 0
            || item.seed > 0xffffffff || typeof item.positive !== 'string' || !item.positive.trim() || typeof item.negative !== 'string')) {
        throw fail('The saved image batch choices are invalid.');
    }
    const outputs = [];
    for (const item of plan.items) {
        context.signal.throwIfAborted();
        const image = await generateQuickImageGenJobImage(context, { effectId: `image:${item.index}`, prompt: item.positive,
            negative: item.negative, seedOverride: item.seed, batch: { index: item.index, count: plan.items.length },
            expectedAccount: account, settingsFingerprint: request.snapshot.quickImageGenSettingsFingerprint, assertSourceLocked: checkSource,
            characterScope: request.snapshot.quickImageGenCharacterScope,
            referenceSources: request.snapshot.quickImageGenReferenceSources,
            ...(request.provider === 'proxy' ? { proxyContext: buildSavedProxyImageContext(request.snapshot), proxyReferences: request.proxyReferences } : {}),
            fetch: fetchImpl, wait });
        const name = `qig-${roleplayHash([context.job.id, item.index])}.${image.format}`;
        const relative = `${request.relativeDirectory}/${name}`;
        const after = publishNativeMediaFile(context, { relative, before: null, bytes: Buffer.from(image.base64, 'base64'),
            checkLocked: lease => {
                assertRoleplaySourceLocked(lease, context.job.intent.source);
                for (const parent of parents) if (roleplayHash(mediaDirectoryEvidence(path.join(context.directories.root, parent.relative))) !== roleplayHash(parent.after)) throw fail('The image destination was replaced.', 'QIG_SOURCE_CHANGED');
            } });
        outputs.push({ index: item.index, seed: item.seed, url: `/${relative.split('/').map(encodeURIComponent).join('/')}`,
            rawHash: after.rawHash, promptHash: roleplayHash({ positive: item.positive, negative: item.negative }) });
        await afterPublication?.(item.index);
    }
    save('image:result', { outputs });
    return finishNativeMediaJob(context, { outputs, promptArtifact: 'image:prompt', batchArtifact: 'image:batch' });
}

registerHandler('media.images', runQuickImageJob);
