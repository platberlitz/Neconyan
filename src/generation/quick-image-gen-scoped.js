import fs from 'node:fs';
import path from 'node:path';

import { applyQuickImageStyle } from '../../public/scripts/extensions/quick-image-gen/lib/styles.js';
import { resolveCharacterImageSettings } from '../../public/scripts/extensions/quick-image-gen/lib/character-settings.js';
import { mergeSTStylePrompts, resolveSTStyleSettings } from '../../public/scripts/extensions/quick-image-gen/lib/st-style.js';
import { createMacroEnvironment } from '../macros/index.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayAccountBase, roleplayAccountStamp, roleplayError, roleplayHash,
    withRoleplayAccount } from '../roleplay-store.js';
import { assertQuickImageGenConfigured, readQuickImageGenSettings } from './quick-image-gen.js';
import { quickImageGenSettingsFingerprint } from './quick-image-gen-job.js';
import { applyMatchedImageFilters, imageFilterSeedOverride, resolveSavedImageFilters,
    sortImageFilters } from './quick-image-gen-filters.js';
import { classifySavedImageFilters } from './quick-image-gen-classifier.js';
import { freezeQuickImageReferenceSources } from './quick-image-gen-reference.js';
import { buildSavedProxyImageContext } from './quick-image-gen-proxy.js';

const invalid = (message, code = 'QIG_SCOPED_SOURCE_CHANGED') => { throw roleplayError(code, message, 409); };

function readSDSettings(directories) {
    let settings;
    try { settings = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8')); } catch {
        invalid('The saved image style settings are unavailable.');
    }
    return settings?.extension_settings?.sd || settings?.extension_settings?.['stable-diffusion'] || {};
}

function assertAcceptedSettings(directories, snapshot) {
    const qig = resolveCharacterImageSettings(readQuickImageGenSettings(directories), snapshot.quickImageGenCharacterScope);
    const sd = readSDSettings(directories);
    if (snapshot.quickImageGenSettingsFingerprint !== quickImageGenSettingsFingerprint(qig)
        || snapshot.quickImageGenSDSettingsFingerprint !== quickImageGenSettingsFingerprint(sd)) {
        invalid('The accepted image or style settings have changed.', 'QIG_SETTINGS_CHANGED');
    }
    return { qig, sd };
}

/** Capture the scoped Conversation image prompt once, before any image provider receives it. */
export async function prepareConversationScopedImagePrompt(context, { effectId, prompt, negative = '', snapshot,
    generateClassifier, matchText, llmSceneText, expectedAccount, assertSourceLocked: externalSourceCheck } = {}) {
    if (typeof effectId !== 'string' || !effectId || typeof prompt !== 'string' || !prompt.trim()
        || typeof negative !== 'string' || !snapshot?.macros) invalid('The accepted scoped image input is invalid.');
    const base = roleplayAccountBase(context.directories);
    if (!base || base.owner !== context.owner) invalid('The accepted image account is unavailable.');
    const account = expectedAccount ?? roleplayAccountStamp(base);
    const artifact = `input:quick-image:${effectId}:scoped`;
    const identity = roleplayHash({ effectId, prompt, negative, snapshot,
        ...(matchText !== undefined ? { matchText } : {}), ...(llmSceneText !== undefined ? { llmSceneText } : {}) });
    const hasProviderResult = () => readArtifact(context.directories, context.job.id, `provider:quick-image:${effectId}`) !== undefined;
    const legacy = !snapshot.quickImageGenSettingsFingerprint || !snapshot.quickImageGenSDSettingsFingerprint;
    const assertSourceLocked = lease => {
        externalSourceCheck?.(lease);
        const settings = legacy ? undefined : assertAcceptedSettings(context.directories, snapshot);
        if (settings) assertQuickImageGenConfigured({ ...settings.qig,
            __qigProxyContext: snapshot.quickImageGenProxyContext ?? buildSavedProxyImageContext(snapshot) });
        freezeQuickImageReferenceSources({ ...context, referenceSources: snapshot.quickImageGenReferenceSources });
        return settings;
    };
    let saved = withRoleplayAccount(base, account, () => readArtifact(context.directories, context.job.id, artifact));
    if (saved !== undefined) {
        const { hash, ...data } = saved ?? {};
        if (data.identity !== identity || hash !== roleplayHash(data) || typeof data.prompt !== 'string'
            || typeof data.negative !== 'string' || !data.account) {
            invalid('The saved scoped image prompt needs recovery.');
        }
        withRoleplayAccount(base, data.account, lease => {
            if (!hasProviderResult()) assertSourceLocked(lease);
        });
        return { prompt: data.prompt, negative: data.negative, account: data.account,
            seedOverride: data.seedOverride, assertSourceLocked };
    }
    const draftName = `${artifact}:draft`;
    let draft = withRoleplayAccount(base, account, () => readArtifact(context.directories, context.job.id, draftName));
    if (draft === undefined && (legacy || hasProviderResult())) {
        // Jobs accepted before scoped image staging keep their original paid input.
        const data = { identity, prompt, negative, account };
        saved = { ...data, hash: roleplayHash(data) };
        withRoleplayAccount(base, account, () => writeArtifact(context.directories, context.job.id, artifact, saved));
        return { prompt, negative, account, assertSourceLocked };
    }
    if (draft !== undefined) {
        const { hash, ...data } = draft ?? {};
        if (hash !== roleplayHash(data) || data.identity !== identity || !data.account
            || typeof data.prompt !== 'string' || typeof data.negative !== 'string'
            || typeof data.scene !== 'string' || !Array.isArray(data.keyword) || !Array.isArray(data.llm)) {
            invalid('The saved scoped image draft needs recovery.');
        }
        withRoleplayAccount(base, data.account, lease => {
            if (!hasProviderResult()) assertSourceLocked(lease);
        });
    } else {
        withRoleplayAccount(base, account, lease => {
            const { qig, sd } = assertSourceLocked(lease);
            let styledPrompt = applyQuickImageStyle(prompt, qig.style);
            let styledNegative = negative;
            if (qig.appendQuality !== false) styledPrompt = `${String(qig.qualityTags || 'masterpiece, best quality, highly detailed, sharp focus, 8k')}, ${styledPrompt}`;
            const environment = createMacroEnvironment(snapshot.macros, {}, { readOnly: true });
            if (qig.useSTStyle !== false) {
                const card = snapshot.macros.extra?.character;
                if (!card || snapshot.speaker?.avatar !== snapshot.macros.extra?.characterAvatar) {
                    invalid('The accepted image character is unavailable.');
                }
                const style = resolveSTStyleSettings(sd, { characters: [{ ...card, data: card.data || card,
                    avatar: snapshot.speaker.avatar }], characterId: 0, groupId: snapshot.target?.groupId ?? null });
                const merged = mergeSTStylePrompts(styledPrompt, styledNegative, style,
                    text => environment.evaluate(text, { strictCapabilities: true }));
                styledPrompt = merged.prompt;
                styledNegative = merged.negative;
            }
            const filters = resolveSavedImageFilters(qig, snapshot, matchText === undefined ? styledPrompt
                : `${matchText}\n\n${styledPrompt}`, environment);
            if (llmSceneText !== undefined) filters.scene = resolveSavedImageFilters(qig, snapshot, llmSceneText, environment).scene;
            ({ prompt: styledPrompt, negative: styledNegative } = applyMatchedImageFilters(styledPrompt,
                styledNegative, filters.keyword));
            const keepFilter = filter => Object.fromEntries(['id', 'name', 'description', 'scope', 'priority',
                'sortOrder', 'positive', 'negative', 'removePositive', 'removeNegative', 'removeMode', 'seedOverride']
                .filter(key => filter[key] !== undefined).map(key => [key, filter[key]]));
            const data = { identity, prompt: styledPrompt, negative: styledNegative, account,
                scene: filters.scene, keyword: filters.keyword.map(keepFilter), llm: filters.llm.map(keepFilter) };
            if (Buffer.byteLength(JSON.stringify(data)) > 2 * 1024 * 1024) {
                invalid('The saved scoped image filters exceed their size limit.');
            }
            draft = { ...data, hash: roleplayHash(data) };
            writeArtifact(context.directories, context.job.id, draftName, draft);
        });
    }
    const selected = await classifySavedImageFilters(context, { base, snapshot, effectId, draft,
        assertSourceLocked, generate: generateClassifier });
    const filtered = applyMatchedImageFilters(draft.prompt, draft.negative, selected);
    const seedOverride = imageFilterSeedOverride(sortImageFilters([...draft.keyword, ...selected]));
    const data = { identity, prompt: filtered.prompt, negative: filtered.negative, account: draft.account,
        ...(seedOverride !== null && seedOverride !== undefined ? { seedOverride } : {}) };
    saved = { ...data, hash: roleplayHash(data) };
    withRoleplayAccount(base, draft.account, () => {
        const previous = readArtifact(context.directories, context.job.id, artifact);
        if (previous !== undefined && roleplayHash(previous) !== roleplayHash(saved)) {
            invalid('The saved scoped image prompt changed after classification.');
        }
        if (previous === undefined) writeArtifact(context.directories, context.job.id, artifact, saved);
    });
    return { prompt: saved.prompt, negative: saved.negative, account: draft.account,
        seedOverride: saved.seedOverride, assertSourceLocked };
}
