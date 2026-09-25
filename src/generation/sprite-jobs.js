import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { registerHandler } from '../jobs/runner.js';
import { writeArtifact } from '../jobs/artifacts.js';
import { readImageArtifact, writeImageArtifact } from '../jobs/image-artifacts.js';
import { readRoleplayFile, roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { decodeServerImage, encodeServerImage } from '../media-codecs.js';
import { generateQuickImageGenJobImage, quickImageGenSettingsFingerprint } from './quick-image-gen-job.js';
import { captureQuickImageReferenceSources } from './quick-image-gen-reference.js';
import { resolveCharacterImageSettings } from '../../public/scripts/extensions/quick-image-gen/lib/character-settings.js';
import { cleanSpriteBitmap, splitSpriteBitmap } from '../../public/scripts/extensions/expressions/sprite-pixels.js';
import { buildCharacterCardSpritePrompt, buildExpressionSpritePrompt, buildExpressionSpriteSheetPrompt,
    DEFAULT_EXPRESSION_SPRITE_PROMPT, EXPRESSION_SPRITE_NEGATIVE, getExpressionSpriteSheetGrid } from '../../public/scripts/extensions/expressions/sprite-prompts.js';
import { admitNativeMediaJob, ensureNativeMediaDirectory, finishNativeMediaJob, mediaDirectoryEvidence, mediaFileEvidence,
    publishNativeMediaFile, removeReplacedMediaFile, withNativeMediaReceipt } from './media-jobs.js';

const IMAGE_LIMIT = 25 * 1024 * 1024;
const fail = (message, code = 'SPRITE_INVALID') => roleplayError(code, message);
const physical = file => mediaFileEvidence(file);

function safePart(value) {
    return typeof value === 'string' && value && value === sanitize(value) && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(value)
        && !/[\\/\0]/.test(value) && Buffer.byteLength(value) <= 200;
}

function savedSettings(directories) {
    const file = readRoleplayFile(path.join(directories.root, 'settings.json'), 8 * 1024 * 1024);
    try { return JSON.parse(file.bytes.toString('utf8')); } catch { throw fail('The saved sprite settings are unavailable.'); }
}

function listSprites(directory) {
    if (!mediaDirectoryEvidence(directory)) return [];
    return fs.readdirSync(directory).filter(name => /\.(?:png|jpg|jpeg|webp|gif|bmp|tiff|avif)$/i.test(name)).sort().map(filename => {
        if (!safePart(filename)) throw fail('An existing sprite filename needs an explicit supported name.');
        const file = readRoleplayFile(path.join(directory, filename), IMAGE_LIMIT);
        if (!file) throw fail('An existing sprite disappeared during capture.');
        const name = path.parse(filename).name;
        return { filename, name, label: name.toLowerCase().match(/^(.+?)(?:[-.].*?)?$/)?.[1] ?? name, before: physical(file) };
    });
}

function selectedSpriteName(label, files, replace, allowMultiple) {
    if (replace !== undefined) {
        if (!safePart(replace) || !new RegExp(`^${label}(?:[-.].*)?$`).test(replace)
            || files.filter(file => file.name === replace).length !== 1) throw fail('The sprite selected for replacement is not unique.');
        return replace;
    }
    if (!files.length) return label;
    if (!allowMultiple) throw fail('Enable multiple sprites before adding another version of this expression.');
    let suffix = files.length;
    while (files.some(file => file.name === `${label}-${suffix}`)) suffix++;
    return `${label}-${suffix}`;
}

/** Snapshot card, cleanup settings, exact sprite destinations and the configured image connection. */
export function captureSpriteRequest(base, account, source, { avatar, labels, folder, mode, replacements = {}, missingOnly = false, sheetImage = null } = {}) {
    return withRoleplayAccount(base, account, lease => {
        assertRoleplaySourceLocked(lease, source);
        if (!source.dependencies?.some(item => item.kind === 'character' && item.locator.avatar === avatar)) throw fail('The sprite character is not in the accepted source.');
        const saved = readRoleplayEntityLocked(lease, 'character', avatar);
        const card = saved.data.data ?? saved.data;
        const settings = savedSettings(base.directories);
        const options = settings.extension_settings?.expressions ?? {};
        const characterScope = { avatar };
        const qig = resolveCharacterImageSettings(settings.extension_settings?.['quick-image-gen'] ?? {}, characterScope);
        const stem = path.parse(avatar).name;
        const overrides = settings.extension_settings?.expressionOverrides ?? [];
        if (!Array.isArray(overrides)) throw fail('The saved sprite folder overrides are invalid.');
        const configuredFolder = overrides.find(item => item?.name === stem)?.path || card.name || stem;
        folder ??= configuredFolder;
        const parts = typeof folder === 'string' ? folder.split('/') : [];
        if (!parts.length || parts.length > 2 || parts.some(part => !safePart(part))) throw fail('The sprite folder name is invalid.');
        const directory = path.join(base.directories.characters, ...parts);
        readRoleplayFile(path.join(directory, '.sprite-path-check'), 1024, { allowMissingParent: true });
        const relativeDirectory = path.relative(base.directories.root, directory).split(path.sep).join('/');
        const parents = [];
        let parent = base.directories.root;
        for (const part of relativeDirectory.split('/')) {
            parent = path.join(parent, part);
            parents.push({ relative: path.relative(base.directories.root, parent).split(path.sep).join('/'), before: mediaDirectoryEvidence(parent) });
        }
        const files = listSprites(directory);
        mode ??= options.agentSpriteGenerationMode || 'individual';
        if (!['individual', 'sheet', 'cleanup', 'split'].includes(mode)) throw fail('The sprite generation mode is invalid.');
        if (mode === 'cleanup' && labels === undefined) labels = [...new Set(files.map(file => file.label))];
        if (!Array.isArray(labels) || labels.length > 64 || labels.some(label => typeof label !== 'string' || !/^[a-z]{1,80}$/.test(label))
            || new Set(labels).size !== labels.length || !replacements || typeof replacements !== 'object' || Array.isArray(replacements)) throw fail('The requested sprite labels are invalid.');
        if (!labels.length && mode !== 'cleanup') throw fail('Choose at least one expression for the sprite request.');
        const targets = [];
        for (const label of labels) {
            const matching = files.filter(file => file.label === label);
            if (missingOnly && matching.length) continue;
            const names = mode === 'cleanup' && replacements[label] === undefined ? matching.map(file => file.name)
                : [selectedSpriteName(label, matching, replacements[label], options.allowMultiple)];
            for (const name of names) {
                if (mode === 'cleanup' && matching.filter(file => file.name === name).length !== 1) throw fail('The sprite cleanup selection is ambiguous.');
                const filename = `${name}.png`;
                const existing = files.find(file => file.filename === filename);
                const previous = matching.filter(file => file.name === name);
                targets.push({ label, name, relative: `${relativeDirectory}/${filename}`, before: existing?.before ?? null,
                    obsolete: previous.filter(file => file.filename !== filename).map(file => ({ relative: `${relativeDirectory}/${file.filename}`, before: file.before })),
                    ...(mode === 'cleanup' ? { source: { relative: `${relativeDirectory}/${previous[0].filename}`, before: previous[0].before } } : {}) });
            }
        }
        if (targets.length > 64 || new Set(targets.map(item => item.relative)).size !== targets.length) throw fail('The sprite output selection is too large or duplicated.');
        let sheet = null;
        if (mode === 'split') {
            if (typeof sheetImage !== 'string' || !sheetImage.startsWith('/user/images/')) throw fail('Save the sprite sheet in this account before splitting it.');
            let names;
            try { names = sheetImage.slice('/user/images/'.length).split('/').map(decodeURIComponent); } catch { throw fail('The saved sprite sheet path is invalid.'); }
            if (names.length < 1 || names.length > 2 || names.some(name => !safePart(name))) throw fail('The saved sprite sheet path is invalid.');
            const filename = path.join(base.directories.userImages, ...names);
            const file = readRoleplayFile(filename, IMAGE_LIMIT);
            if (!file) throw fail('The saved sprite sheet is missing.');
            sheet = { relative: path.relative(base.directories.root, filename).split(path.sep).join('/'), before: physical(file) };
        }
        const context = { characterName: card.name || stem, characterCard: buildCharacterCardSpritePrompt({
            description: card.description, creatorNotes: card.creator_notes || saved.data.creatorcomment,
            personality: card.personality, scenario: card.scenario, charDepthPrompt: card.extensions?.depth_prompt?.prompt,
        }), framing: options.agentSpriteFraming || 'bust', promptTemplate: options.agentSpritePrompt || DEFAULT_EXPRESSION_SPRITE_PROMPT };
        if (!['bust', 'full_body'].includes(context.framing) || typeof context.promptTemplate !== 'string' || context.promptTemplate.length > 64 * 1024) throw fail('The saved sprite prompt controls are invalid.');
        const grid = ['sheet', 'split'].includes(mode) && targets.length ? getExpressionSpriteSheetGrid(targets.length) : null;
        const prompts = mode === 'sheet' ? [buildExpressionSpriteSheetPrompt(targets.map(item => item.label), context, grid)]
            : mode === 'individual' ? targets.map(item => buildExpressionSpritePrompt(item.label, context)) : [];
        return { version: 1, avatar, folder, mode, characterScope, settingsHash: roleplayHash(settings), qigFingerprint: quickImageGenSettingsFingerprint(qig),
            referenceSources: ['individual', 'sheet'].includes(mode) ? captureQuickImageReferenceSources(base.directories, qig) : [],
            removeBackground: Boolean(options.agentSpriteRemoveBackground), targets, parents, sheet, grid, prompts,
            negative: [qig.negativePrompt, EXPRESSION_SPRITE_NEGATIVE].filter(Boolean).join(', ') };
    });
}

export function admitSpriteJob(base, account, { operationKey, source, request }) {
    return admitNativeMediaJob(base, account, { operationKey, source, request, kind: 'sprites',
        target: { kind: 'sprites', id: request.folder } });
}

function verifyDestinations(context, lease, receipt) {
    const request = context.job.intent.request;
    assertRoleplaySourceLocked(lease, context.job.intent.source);
    for (const parent of request.parents) {
        const effect = receipt?.effects[roleplayHash(['directory', parent.relative])];
        const expected = effect?.state === 'done' ? effect.after : parent.before;
        if (roleplayHash(mediaDirectoryEvidence(path.join(context.directories.root, parent.relative))) !== roleplayHash(expected)) throw fail('The accepted sprite directory changed.', 'SPRITE_SOURCE_CHANGED');
    }
    for (const target of request.targets) for (const item of [target, ...target.obsolete]) {
        const write = receipt?.effects[roleplayHash(['write', item.relative])];
        const removed = receipt?.effects[roleplayHash(['remove', item.relative])];
        const expected = removed?.state === 'done' ? null : write?.state === 'done' ? write.after : item.before;
        const current = readRoleplayFile(path.join(context.directories.root, item.relative), IMAGE_LIMIT, { allowMissingParent: true });
        if (write?.state === 'writing' && current && roleplayHash(current.bytes.toString('base64')) === write.outputHash) continue;
        if (removed?.state === 'removing' && !current) continue;
        if (roleplayHash(physical(current)) !== roleplayHash(expected)) throw fail('A sprite destination changed after admission.', 'SPRITE_SOURCE_CHANGED');
    }
}

function readFrozenImage(context, name, input) {
    return withNativeMediaReceipt(context, () => {
        let image = readImageArtifact(context.directories, context.job.id, name);
        if (image !== undefined) return image;
        const file = readRoleplayFile(path.join(context.directories.root, input.relative), IMAGE_LIMIT);
        if (roleplayHash(physical(file)) !== roleplayHash(input.before)) throw fail('The source sprite changed after admission.', 'SPRITE_SOURCE_CHANGED');
        image = { base64: file.bytes.toString('base64'), format: ({ jpeg: 'jpg' })[path.extname(input.relative).slice(1).toLowerCase()] || path.extname(input.relative).slice(1).toLowerCase() };
        writeImageArtifact(context.directories, context.job.id, name, image);
        return image;
    });
}

/** Native individual, generated-sheet, imported-sheet and cleanup work; saved results precede publication. */
export async function runSpriteJob(context, { fetchImpl = fetch, wait, afterPublication } = {}) {
    const request = context.job.intent?.request;
    if (context.job.intent?.kind !== 'sprites' || request?.version !== 1 || !Array.isArray(request.targets)) throw fail('The accepted sprite job is invalid.');
    const prior = withNativeMediaReceipt(context, ({ value }) => value.state === 'closed' ? value.result : null, { checkSource: false });
    if (prior) return { result: prior };
    for (const parent of request.parents) ensureNativeMediaDirectory(context, parent);
    const check = () => withNativeMediaReceipt(context, ({ lease, value }) => verifyDestinations(context, lease, value));
    check();
    const imageFor = async index => {
        check();
        const assertSourceLocked = lease => {
            if (!lease) throw fail('The sprite source is not held under its account lock.');
            assertRoleplaySourceLocked(lease, context.job.intent.source);
            if (roleplayHash(savedSettings(context.directories)) !== request.settingsHash) throw fail('The saved sprite settings changed before generation.', 'SPRITE_SOURCE_CHANGED');
        };
        return generateQuickImageGenJobImage(context, { effectId: `sprite:${index}`, prompt: request.prompts[index], negative: request.negative,
            settingsFingerprint: request.qigFingerprint, characterScope: request.characterScope,
            referenceSources: request.referenceSources,
            expectedAccount: context.job.intent.media, assertSourceLocked, fetch: fetchImpl, wait });
    };
    const saveTile = (index, image) => withNativeMediaReceipt(context, () => writeImageArtifact(context.directories, context.job.id, `sprite:tile:${index}`, image));
    if (['sheet', 'split'].includes(request.mode) && request.targets.length) {
        const missing = withNativeMediaReceipt(context, () => request.targets.some((_item, index) => readImageArtifact(context.directories, context.job.id, `sprite:tile:${index}`) === undefined));
        if (missing) {
            const image = request.mode === 'sheet' ? await imageFor(0) : readFrozenImage(context, 'sprite:source-sheet', request.sheet);
            const bitmap = await decodeServerImage(Buffer.from(image.base64, 'base64'));
            const tiles = splitSpriteBitmap(bitmap, request.grid, request.targets.length,
                { removeBackground: request.removeBackground, check: () => context.signal.throwIfAborted() });
            for (let index = 0; index < tiles.length; index++) saveTile(index, { base64: (await encodeServerImage(tiles[index])).toString('base64'), format: 'png' });
        }
    }
    const outputs = [];
    for (let index = 0; index < request.targets.length; index++) {
        context.signal.throwIfAborted();
        const target = request.targets[index];
        let tile = withNativeMediaReceipt(context, () => readImageArtifact(context.directories, context.job.id, `sprite:tile:${index}`));
        if (tile === undefined) {
            const image = request.mode === 'cleanup' ? readFrozenImage(context, `sprite:source:${index}`, target.source) : await imageFor(index);
            const bitmap = await decodeServerImage(Buffer.from(image.base64, 'base64'));
            if (request.mode === 'cleanup' || request.removeBackground) cleanSpriteBitmap(bitmap,
                { removeBackground: request.removeBackground, check: () => context.signal.throwIfAborted() });
            tile = { base64: (await encodeServerImage(bitmap)).toString('base64'), format: 'png' };
            saveTile(index, tile);
        }
        check();
        const after = publishNativeMediaFile(context, { relative: target.relative, before: target.before,
            bytes: Buffer.from(tile.base64, 'base64'), checkLocked: (lease, receipt) => verifyDestinations(context, lease, receipt) });
        await afterPublication?.(index);
        for (const old of target.obsolete) removeReplacedMediaFile(context, { ...old, replacement: target.relative });
        outputs.push({ label: target.label, name: target.name, url: `/characters/${request.folder.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(target.name)}.png`, rawHash: after.rawHash });
    }
    withNativeMediaReceipt(context, () => writeArtifact(context.directories, context.job.id, 'sprite-result', { outputs }));
    return finishNativeMediaJob(context, { outputs });
}

registerHandler('media.sprites', runSpriteJob);
