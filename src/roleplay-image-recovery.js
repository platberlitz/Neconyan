import fs from 'node:fs';
import { imageSize } from 'image-size';
import { fsyncDirectorySync } from './util.js';
import { accountImagePath, decodeCompatibleImage, managedImageUrl, publishManagedImage, verifyManagedImage } from './managed-image-files.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseChatJsonl } from './chat-recovery.js';
import { withRoleplayAccount, roleplayLease, readRoleplayFile, inspectRoleplayFile, roleplayHash, saveRoleplayAccount } from './roleplay-store.js';
import { normaliseRoleplayLocator, roleplayChatPath, captureRoleplayStorageSourceLocked } from './generation/roleplay-source.js';
import { assertNativeMediaTargetIdle } from './generation/media-receipts.js';
import { commitSingleChatWriteLocked, roleplayChatWriteIdentity } from './roleplay-lifecycle.js';
import { attachmentIdentity, PROMPT_MEDIA_MODES, validateImagePreference } from '../public/scripts/prompt-media-policy.js';
import { uiText } from '../public/scripts/ui-text.js';
import { REPAIR_LIMIT, REPAIR_CHAT_LIMIT, repairFailure, integrityFailure, repairPath, repairDirectory, readRepairJson, writeRepairJson,
    writeRepairBytes, ensureRepairStore, reserveRepair, pinRepair, finishRepair, repairCatalogue, validateRepairReservation, assertRepairUnstarted, setRepairPhase } from './roleplay-image-repair-store.js';

const hashBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => isDeepStrictEqual(left, right);
/** Every status a scan can give an image. The review dialog keeps one label for each. */
export const IMAGE_REVIEW_STATUSES = Object.freeze(['saved-reference', 'missing-file', 'needs-compatible-copy', 'unreadable-or-over-limit', 'embedded-image',
    'external-or-old-location', 'other-media', 'malformed-attachment', 'empty-attachment-list', 'invalid-gallery-selection']);
/** Every stage that change history reports for a change. */
export const REPAIR_HISTORY_STAGES = Object.freeze(['committed', 'backup-verified', 'native-write-pending', 'staging-incomplete', 'discarded']);
/** A saved description is usable when it has text and fits the limit. Choosing it and listing it as available use this one test. */
const usableDescription = text => typeof text === 'string' && Boolean(text.trim()) && Buffer.byteLength(text) <= 16 * 1024;
function readChat(scope, locator) {
    // A chat file, or the folder it was in, that is gone is not a damaged chat. allowMissingParent answers null for both, so no operating
    // system error (which names a server path) reaches the page.
    const file = readRoleplayFile(roleplayChatPath(scope, locator), REPAIR_CHAT_LIMIT, { allowMissingParent: true });
    if (!file) throw repairFailure(uiText('This chat file no longer exists, so its images cannot be listed.'));
    const parsed = parseChatJsonl(file.bytes);
    if (parsed?.status !== 'ok') throw repairFailure(uiText('This chat file is damaged, so its images cannot be listed. Recover the chat first.'));
    return { file, records: parsed.records };
}
function observation(scope, locator, file) {
    return { accountId: scope.accountId, dataEpoch: scope.dataEpoch, locator, rawHash: file.rawHash, physical: file.physical };
}
function attachmentLocations(records) {
    const locations = [];
    let total = 0;
    const add = (index, swipe, extra) => {
        if (!object(extra)) return;
        const extraHash = roleplayHash(extra);
        const entries = Array.isArray(extra.media) ? extra.media : extra.media === undefined
            ? Array.isArray(extra.image_swipes) ? extra.image_swipes.map(url => ({ type: 'image', url }))
                : typeof extra.image === 'string' ? [{ type: 'image', url: extra.image }] : [] : [null];
        entries.forEach((item, mediaIndex) => {
            total++;
            if (locations.length < 10000) locations.push({ index, swipe, mediaIndex, item, extra,
                identity: roleplayHash([index, swipe, mediaIndex, extraHash]) });
        });
        if (!entries.length && (Object.hasOwn(extra, 'media') || Object.hasOwn(extra, 'image') || Object.hasOwn(extra, 'image_swipes'))) {
            total++;
            if (locations.length < 10000) locations.push({ index, swipe, mediaIndex: -1, item: null, extra, identity: roleplayHash([index, swipe, -1, extraHash]) });
        }
    };
    records.slice(1).forEach((record, index) => {
        add(index, null, record.extra);
        if (Array.isArray(record.swipe_info)) record.swipe_info.forEach((swipe, swipeIndex) => {
            // Active duplicates are edited together; divergent duplicates remain separately visible.
            if (swipeIndex !== record.swipe_id || !same(swipe.extra, record.extra)) add(index, swipeIndex, swipe.extra);
        });
    });
    return { locations, total };
}
function itemSummary(location) {
    const { item, extra, index, swipe, mediaIndex, identity } = location;
    let status = 'saved-reference';
    if (mediaIndex < 0) status = Array.isArray(extra.media) && !extra.media.length ? 'empty-attachment-list' : 'malformed-attachment';
    else if (!object(item) || typeof item.url !== 'string' || !item.url) status = 'malformed-attachment';
    else if ((item.type ?? 'image') !== 'image') status = 'other-media';
    else if (item.url.startsWith('data:')) status = 'embedded-image';
    else if (!item.url.startsWith('/user/images/')) status = 'external-or-old-location';
    if (mediaIndex >= 0 && extra.media_display === 'gallery' && extra.media_index !== undefined
        && (!Number.isSafeInteger(extra.media_index) || extra.media_index < 0 || extra.media_index >= (extra.media?.length ?? 0))) status = 'invalid-gallery-selection';
    return { index, swipe, mediaIndex, identity, status, mode: item?.neconyan_prompt?.mode ?? 'include',
        hasPromptCopy: typeof item?.neconyan_prompt?.image_url === 'string',
        ...(item?.neconyan_prompt?.caption ? { caption: item.neconyan_prompt.caption } : {}),
        ...(typeof item?.url === 'string' && /^https?:/.test(item.url) && item.url.length <= 4096 ? { proposedSource: item.url } : {}),
        title: typeof item?.title === 'string' ? item.title.slice(0, 240) : '',
        descriptionAvailable: Boolean(item?.title || extra.title),
        // A legacy single image keeps its title on the message; choosing the image's own description reads that title.
        sources: { 'media-title': usableDescription(item?.title ?? (extra.media === undefined ? extra.title : undefined)), 'message-title': usableDescription(extra.title) },
        actions: status === 'other-media' ? [] : mediaIndex < 0 ? ['detach'] : ['display-only', 'caption', 'include', 'detach'] };
}
/** Read-only inventory: neither enrols a chat nor fetches an external image. */
export function scanRoleplayImages(base, input) {
    const locator = normaliseRoleplayLocator(input.locator);
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw repairFailure('Invalid image review page.');
    return withRoleplayAccount(base, input.account ?? null, lease => {
        const { scope } = roleplayLease(lease);
        const { file, records } = readChat(scope, locator);
        const current = observation(scope, locator, file);
        if (input.observation && !same(input.observation, current)) throw repairFailure(uiText('The chat changed while you were reviewing it. List its images again, then choose.'));
        const { locations, total } = attachmentLocations(records);
        const result = { observation: current, total, listed: locations.length, limited: total > 10000, offset,
            chatPreference: records[0].chat_metadata?.neconyan_prompt_media ?? null, issues: [], next: null };
        for (const location of locations.slice(offset, offset + 100)) {
            const item = itemSummary(location);
            if (item.status === 'saved-reference') {
                try {
                    const image = readRoleplayFile(accountImagePath(scope.directories, location.item.url), 1024 * 1024);
                    if (!image) item.status = 'missing-file';
                    else {
                        const size = imageSize(image.bytes);
                        if (!['png', 'jpg', 'webp'].includes(size.type) || size.width > 2048 || size.height > 2048 || !size.width || !size.height) item.status = 'needs-compatible-copy';
                    }
                } catch { item.status = 'unreadable-or-over-limit'; }
            }
            result.issues.push(item);
            if (Buffer.byteLength(JSON.stringify(result)) > 63 * 1024) { result.issues.pop(); break; }
        }
        const next = offset + result.issues.length;
        result.next = next < locations.length ? next : null;
        return result;
    });
}
function assertIdle(lease, source, ownKey = null) {
    const { state } = roleplayLease(lease);
    for (const id of [source.instanceId, roleplayHash(source.locator)]) assertNativeMediaTargetIdle(lease, { kind: 'chat', id });
    for (const [key, receipt] of Object.entries(state.submissions)) {
        if (key !== ownKey && receipt.targetInstanceId === source.instanceId && !['closed', 'void'].includes(receipt.state)) {
            throw repairFailure(uiText('A reply is still being written in this chat. Wait for it to finish or stop it, then try again.'));
        }
    }
    if (state.pending && state.pending.operationKeyHash !== ownKey) throw repairFailure(uiText('An earlier change to this chat is still being saved. Try again in a moment.'));
}
function selectExtra(record, swipe) {
    if (swipe === null) return record.extra;
    if (!Number.isSafeInteger(swipe) || swipe < 0 || !record.swipe_info?.[swipe]) throw repairFailure(uiText('That alternative reply no longer exists. List the images again.'));
    return record.swipe_info[swipe].extra;
}
function normaliseImages(extra) {
    if (extra.media !== undefined) return;
    if (typeof extra.image !== 'string' && !Array.isArray(extra.image_swipes)) throw repairFailure(uiText('This image attachment is damaged. Choose Remove from message for it.'));
    const urls = extra.image_swipes ?? [extra.image];
    if (urls.some(url => typeof url !== 'string' || !url)) throw repairFailure(uiText('This image attachment is damaged. Choose Remove from message for it.'));
    extra.media = urls.map(url => ({ type: 'image', url, ...(typeof extra.title === 'string' ? { title: extra.title } : {}),
        ...(extra.append_title !== undefined ? { append_title: extra.append_title } : {}) }));
    if (extra.image_swipes) { extra.media_display = 'gallery'; extra.media_index = Math.max(0, urls.indexOf(extra.image)); }
    delete extra.image; delete extra.image_swipes;
    // The legacy title belongs to the image. Its inclusion flag moved onto each media item.
    delete extra.append_title;
}
function transform(records, input, scope) {
    const images = [];
    const actions = input.actions ?? [];
    if (!Array.isArray(actions) || actions.length > 128 || !actions.length && input.chatPreference === undefined) throw repairFailure(uiText('Choose between 1 and 128 images to change at once.'));
    const candidate = structuredClone(records);
    if (input.chatPreference !== undefined) {
        validateImagePreference(input.chatPreference);
        candidate[0].chat_metadata.neconyan_prompt_media = structuredClone(input.chatPreference);
    }
    const seen = new Set(), sourceHashes = new WeakMap();
    let descriptionBytes = 0;
    // Edits address original coordinates; detach in descending order afterwards.
    const detachments = [];
    for (const action of actions) {
        const { index, swipe = null, mediaIndex } = action;
        const record = candidate[index + 1];
        const original = records[index + 1];
        if (!Number.isSafeInteger(index) || index < 0 || !original || !Number.isSafeInteger(mediaIndex) || mediaIndex < -1) throw repairFailure('Invalid image coordinates.');
        const sourceExtra = selectExtra(original, swipe);
        if (!object(sourceExtra)) throw repairFailure(uiText('This image changed after it was listed. List the images again, then choose.'));
        if (!sourceHashes.has(sourceExtra)) sourceHashes.set(sourceExtra, roleplayHash(sourceExtra));
        if (action.identity !== roleplayHash([index, swipe, mediaIndex, sourceHashes.get(sourceExtra)])) throw repairFailure(uiText('This image changed after it was listed. List the images again, then choose.'));
        const coordinate = JSON.stringify([index, swipe, mediaIndex]);
        if (seen.has(coordinate)) throw repairFailure('An image was selected twice.');
        seen.add(coordinate);
        const extra = selectExtra(record, swipe);
        if (action.mode === 'detach') { detachments.push({ index, swipe, mediaIndex }); continue; }
        if (!PROMPT_MEDIA_MODES.includes(action.mode)) throw repairFailure('Choose how to use this image.');
        normaliseImages(extra);
        const item = extra.media?.[mediaIndex];
        if (!object(item) || (item.type ?? 'image') !== 'image' || typeof item.url !== 'string') throw repairFailure(uiText('This attachment is not a usable image. Choose Remove from message for it.'));
        if (action.localUrl !== undefined) {
            const file = readRoleplayFile(accountImagePath(scope.directories, action.localUrl), 1024 * 1024);
            if (!file) throw repairFailure(uiText('The image on this server is missing. Choose another option.'));
            const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[imageSize(file.bytes).type];
            decodeCompatibleImage(`data:${mime};base64,${file.bytes.toString('base64')}`);
            item.url = action.localUrl;
        }
        const prior = item.neconyan_prompt;
        const policy = { version: 1, mode: action.mode, attachment_hash: roleplayHash(attachmentIdentity(item)) };
        if (prior?.version === 1 && prior.attachment_hash === policy.attachment_hash
            && /^\/user\/images\/neconyan-repaired\/[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(prior.image_url ?? '')) {
            policy.image_url = prior.image_url;
            if (/^[a-f0-9]{64}$/.test(prior.original_evidence?.rawHash ?? '')) policy.original_evidence = { rawHash: prior.original_evidence.rawHash };
        }
        if (action.selectGallery === true) { extra.media_display = 'gallery'; extra.media_index = mediaIndex; }
        if (action.mode === 'caption') {
            const caption = action.caption;
            if (!object(caption) || !['custom', 'media-title', 'message-title'].includes(caption.source)) throw repairFailure(uiText('Choose or type a description.'));
            const text = caption.source === 'custom' ? caption.text : caption.source === 'media-title' ? item.title : extra.title;
            if (!usableDescription(text)) throw repairFailure(uiText('A description must contain text and be at most 16 KiB.'));
            descriptionBytes += Buffer.byteLength(text);
            if (descriptionBytes > 16 * 1024) throw repairFailure(uiText('Together, the selected descriptions are over 16 KiB. Change fewer images at a time.'));
            policy.caption = caption.source === 'custom' ? { source: 'custom', text } : { source: caption.source };
        }
        if (action.saveCopy === true || input.materialisedImage?.identity === action.identity) {
            let data = item.url;
            if (input.materialisedImage?.identity === action.identity) data = input.materialisedImage.data;
            else if (!item.url.startsWith('data:')) throw repairFailure(uiText('This image cannot be copied as it is. Use Prepare a converted copy for it first.'));
            const image = decodeCompatibleImage(data);
            if (images.reduce((sum, entry) => sum + entry.bytes.length, image.bytes.length) > 64 * 1024 * 1024) throw repairFailure(uiText('The new copies would exceed 64 MiB in one change. Select fewer images.'));
            policy.image_url = managedImageUrl(image);
            if (item.url.startsWith('/user/images/') && action.adoptCopy !== true) {
                const original = inspectRoleplayFile(accountImagePath(scope.directories, item.url), REPAIR_CHAT_LIMIT);
                if (!original) throw repairFailure(uiText('The original image file is missing. Choose Show only, or tick \'Also show this copy in the chat instead of the original\'.'));
                policy.original_evidence = { rawHash: original.rawHash };
            }
            images.push(image);
        }
        if (action.adoptCopy === true) {
            if (!policy.image_url) throw repairFailure(uiText('Prepare a compatible copy first.'));
            if (!images.some(image => managedImageUrl(image) === policy.image_url)) verifyManagedImage(scope.directories, policy.image_url);
            item.url = policy.image_url;
            policy.attachment_hash = roleplayHash(attachmentIdentity(item));
            delete policy.image_url; delete policy.original_evidence;
        }
        item.neconyan_prompt = policy;
    }
    detachments.sort((a, b) => b.mediaIndex - a.mediaIndex).forEach(({ index, swipe, mediaIndex }) => {
        const extra = selectExtra(candidate[index + 1], swipe);
        if (mediaIndex === -1) {
            if (Array.isArray(extra.media) && extra.media.length) throw repairFailure(uiText('Choose a single image to remove.'));
            for (const key of ['media', 'image', 'image_swipes', 'media_index', 'media_display', 'inline_image']) delete extra[key];
        } else {
            normaliseImages(extra);
            if (!Array.isArray(extra.media) || mediaIndex >= extra.media.length) throw repairFailure(uiText('This attachment no longer exists. List the images again.'));
            extra.media.splice(mediaIndex, 1);
            if (!extra.media.length) for (const key of ['media', 'media_index', 'media_display', 'inline_image']) delete extra[key];
            else if (extra.media_index !== undefined) extra.media_index = Math.max(0, Math.min(extra.media.length - 1, Number.isSafeInteger(extra.media_index)
                ? extra.media_index - (extra.media_index >= mediaIndex ? 1 : 0) : 0));
        }
    });
    // Only attachment fields are mirrored. Conflicting active duplicates require a separate explicit choice.
    for (const action of actions.filter(item => (item.swipe ?? null) === null)) {
        const record = candidate[action.index + 1], original = records[action.index + 1];
        const active = record.swipe_info?.[record.swipe_id];
        const oldActive = original.swipe_info?.[original.swipe_id];
        const fields = ['media', 'image', 'image_swipes', 'media_index', 'media_display', 'inline_image'];
        if (original.extra.media === undefined && (typeof original.extra.image === 'string' || Array.isArray(original.extra.image_swipes))) fields.push('append_title');
        if (oldActive?.extra && !same(oldActive.extra, original.extra)) {
            if (fields.some(key => !same(oldActive.extra[key], original.extra[key]))) throw repairFailure(uiText('This reply\'s saved data disagrees about its images. Review the alternative reply listed separately first.'));
        }
        if (active?.extra) for (const key of fields) {
            if (Object.hasOwn(record.extra, key)) active.extra[key] = structuredClone(record.extra[key]); else delete active.extra[key];
        }
    }
    return { candidate, images };
}
function savedCandidate(scope, id, plan) {
    const file = readRoleplayFile(repairPath(scope, id, 'candidate.jsonl'), REPAIR_CHAT_LIMIT);
    if (!file || file.rawHash !== plan.candidateHash) throw integrityFailure('The original repair candidate is missing or changed.');
    const parsed = parseChatJsonl(file.bytes);
    if (parsed.status !== 'ok') throw integrityFailure('The original repair candidate is unreadable.');
    return parsed.records;
}
function execute(lease, id, plan, host, checkpoint) {
    const { scope, state } = roleplayLease(lease);
    const reservation = validateRepairReservation(scope, repairCatalogue(scope).value.entries[id], plan);
    if (reservation.phase !== 'prepared') throw repairFailure(reservation.phase === 'aborted'
        ? uiText('This change was discarded. Make the change again if you still want it.') : uiText('This change did not finish preparing. Discard it in Change history, then try again.'));
    let manifest = readRepairJson(repairPath(scope, id, 'manifest.json'));
    if (manifest.value.planHash !== roleplayHash(plan)) throw integrityFailure('The repair manifest does not match its original plan.');
    if (manifest.value.stage === 'committed') {
        finishRepair(lease, id);
        return { id, ...manifest.value.result, replayed: true };
    }
    const before = readRoleplayFile(repairPath(scope, id, 'before.jsonl'), REPAIR_CHAT_LIMIT, { flush: true });
    if (!before || before.rawHash !== plan.beforeHash) throw integrityFailure('The required repair backup is missing or changed.');
    const records = savedCandidate(scope, id, plan);
    const input = { ...plan.input, records };
    if (!same(roleplayChatWriteIdentity(lease, input), plan.native)) throw integrityFailure('The native repair intent changed.');
    assertIdle(lease, input.source, plan.native.operationKeyHash);
    for (const [index, descriptor] of (plan.images ?? []).entries()) {
        const staged = readRoleplayFile(repairPath(scope, id, `image.${index}.bin`), 1024 * 1024, { flush: true });
        if (!staged || staged.rawHash !== descriptor.rawHash) throw integrityFailure('A prepared image copy is missing or changed.');
        publishManagedImage(scope.directories, { ...descriptor, bytes: staged.bytes });
    }
    pinRepair(lease, id, plan);
    checkpoint('pinned');
    manifest.value.stage = 'native-write-pending';
    manifest.file = writeRepairJson(repairPath(scope, id, 'manifest.json'), manifest.value, REPAIR_LIMIT, manifest.file);
    const receipt = state.submissions[plan.native.operationKeyHash];
    if (receipt && (receipt.intentHash !== plan.native.intentHash || !['closed', 'void'].includes(receipt.state))) throw integrityFailure('The native repair receipt needs recovery.');
    const result = commitSingleChatWriteLocked(lease, input, host);
    checkpoint('native-committed');
    manifest.value.stage = 'committed';
    manifest.value.result = result;
    manifest.file = writeRepairJson(repairPath(scope, id, 'manifest.json'), manifest.value, REPAIR_LIMIT, manifest.file);
    checkpoint('manifest-committed');
    finishRepair(lease, id);
    checkpoint('unpinned');
    return { id, ...result, replayed: false };
}
function operationId(scope, key) {
    if (typeof key !== 'string' || !key || key.length > 128) throw repairFailure('A stable image repair ID is required.');
    return roleplayHash([scope.accountId, scope.dataEpoch, 'image-repair', key]);
}
/** One bounded chat transaction, under the native account lease. No provider calls. */
export function applyRoleplayImageRepair(base, input, host, { checkpoint = () => {} } = {}) {
    if (!input.account) throw repairFailure(uiText('Close this window and open it again to confirm your account.'));
    return withRoleplayAccount(base, input.account, lease => {
        const { scope } = roleplayLease(lease);
        const id = operationId(scope, input.key);
        const requestHash = roleplayHash(input);
        ensureRepairStore(lease);
        const reservation = repairCatalogue(scope).value.entries[id];
        if (reservation) {
            validateRepairReservation(scope, reservation);
            if (reservation.requestHash !== requestHash) throw repairFailure('This repair ID already has different choices.');
            if (reservation.phase === 'aborted') throw repairFailure(uiText('This change was discarded. Make the change again if you still want it.'));
        }
        const existing = readRepairJson(repairPath(scope, id, 'plan.json'), REPAIR_LIMIT, true);
        if (existing) {
            if (existing.value.requestHash !== requestHash) throw repairFailure('This repair ID already has different choices.');
            return execute(lease, id, existing.value, host, checkpoint);
        }
        const locator = normaliseRoleplayLocator(input.observation?.locator);
        const { file, records } = readChat(scope, locator);
        if (!same(input.observation, observation(scope, locator, file))) throw repairFailure(uiText('The chat changed after its images were listed, so nothing was changed. List them again, then choose.'));
        const captured = captureRoleplayStorageSourceLocked(lease, locator);
        if (captured.changed) saveRoleplayAccount(lease);
        assertIdle(lease, captured.source);
        let candidate, images = [];
        if (input.undoOf !== undefined) {
            const original = readRepairJson(repairPath(scope, input.undoOf, 'plan.json')).value;
            const prior = readRepairJson(repairPath(scope, input.undoOf, 'manifest.json')).value;
            if (prior.stage !== 'committed' || prior.result.rawHash !== file.rawHash || prior.result.revision !== captured.source.revision
                || original.input.source.instanceId !== captured.source.instanceId) throw repairFailure(uiText('This chat has changed since, so undoing would lose later work. Download the backup instead.'));
            const backup = readRoleplayFile(repairPath(scope, input.undoOf, 'before.jsonl'), REPAIR_CHAT_LIMIT);
            if (!backup || backup.rawHash !== original.beforeHash) throw repairFailure(uiText('This change\'s backup is no longer available.'));
            candidate = parseChatJsonl(backup.bytes).records;
        } else ({ candidate, images } = transform(records, input, scope));
        const candidateBytes = Buffer.from(candidate.map(record => JSON.stringify(record)).join('\n'));
        if (candidateBytes.length > REPAIR_CHAT_LIMIT) throw repairFailure(uiText('After this change the chat would be too large to save.'));
        const nativeInput = { operationKey: 'image-repair:' + id, mode: 'update', sourceKind: 'storage', source: captured.source, backup: { deferBackup: true } };
        const native = roleplayChatWriteIdentity(lease, { ...nativeInput, records: candidate });
        const plan = { version: 1, requestHash, input: nativeInput, native, beforeHash: file.rawHash, candidateHash: hashBytes(candidateBytes),
            createdAt: new Date().toISOString(), undoOf: input.undoOf ?? null, images: images.map(({ bytes, ...image }) => ({ ...image, size: bytes.length })) };
        // Reservation precedes every payload and remains authoritative across a partial staging failure.
        const reservedBytes = file.bytes.length + candidateBytes.length + 2 * REPAIR_LIMIT + images.reduce((sum, image) => sum + 2 * image.bytes.length, 0);
        const oldReservation = repairCatalogue(scope).value.entries[id];
        if (oldReservation) throw integrityFailure('This repair stopped before its durable plan was saved. Keep its reserved files for recovery.');
        reserveRepair(lease, id, reservedBytes, plan);
        checkpoint('reserved');
        writeRepairJson(repairPath(scope, id, 'plan.json'), plan);
        checkpoint('plan-staged');
        writeRepairBytes(repairPath(scope, id, 'before.jsonl'), file.bytes, REPAIR_CHAT_LIMIT);
        checkpoint('before-staged');
        writeRepairBytes(repairPath(scope, id, 'candidate.jsonl'), candidateBytes, REPAIR_CHAT_LIMIT);
        checkpoint('candidate-staged');
        images.forEach((image, index) => {
            writeRepairBytes(repairPath(scope, id, `image.${index}.bin`), image.bytes, 1024 * 1024);
            checkpoint(`image-${index}-staged`);
        });
        writeRepairJson(repairPath(scope, id, 'manifest.json'), { version: 1, planHash: roleplayHash(plan), stage: 'backup-verified', result: null });
        checkpoint('manifest-staged');
        setRepairPhase(lease, id, 'prepared');
        checkpoint('backup-verified');
        return execute(lease, id, plan, host, checkpoint);
    });
}
export function resumeRoleplayImageRepair(base, input, host) {
    if (!input.account) throw repairFailure(uiText('Close this window and open it again to confirm your account.'));
    return withRoleplayAccount(base, input.account, lease => {
        const { scope } = roleplayLease(lease);
        const entry = validateRepairReservation(scope, repairCatalogue(scope).value.entries[input.id]);
        if (entry.phase === 'aborted') throw repairFailure(uiText('This change was discarded.'));
        const plan = readRepairJson(repairPath(scope, input.id, 'plan.json')).value;
        if (repairCatalogue(scope).value.entries[input.id]?.planHash !== roleplayHash(plan)) throw integrityFailure('The saved repair plan differs from its reservation.');
        return execute(lease, input.id, plan, host, () => {});
    });
}

/** Explicitly discard only verified staging that never acquired native write authority. */
export function discardRoleplayImageRepair(base, input, { checkpoint = () => {} } = {}) {
    if (!input.account) throw repairFailure(uiText('Close this window and open it again to confirm your account.'));
    return withRoleplayAccount(base, input.account, lease => {
        const { scope, state } = roleplayLease(lease), id = input.id;
        const entry = validateRepairReservation(scope, repairCatalogue(scope).value.entries[id]);
        assertRepairUnstarted(scope, state, id, entry);
        const planFile = readRepairJson(repairPath(scope, id, 'plan.json'), REPAIR_LIMIT, true);
        if (planFile) validateRepairReservation(scope, entry, planFile.value);
        const expected = new Map();
        if (planFile) {
            const plan = planFile.value;
            expected.set('before.jsonl', { hash: plan.beforeHash, limit: REPAIR_CHAT_LIMIT });
            expected.set('candidate.jsonl', { hash: plan.candidateHash, limit: REPAIR_CHAT_LIMIT });
            for (const [index, image] of (plan.images ?? []).entries()) expected.set(`image.${index}.bin`, { hash: image.rawHash, limit: 1024 * 1024 });
            const manifest = readRepairJson(repairPath(scope, id, 'manifest.json'), REPAIR_LIMIT, true);
            if (manifest) {
                if (manifest.value.planHash !== entry.planHash || manifest.value.stage !== 'backup-verified' || manifest.value.result) {
                    throw repairFailure(uiText('This change may already have started saving the chat, so it cannot be discarded. Use Finish this change instead.'));
                }
                expected.set('manifest.json', { hash: manifest.file.rawHash, limit: REPAIR_LIMIT });
            }
            expected.set('plan.json', { hash: planFile.file.rawHash, limit: REPAIR_LIMIT });
        }
        const payloads = [];
        for (const name of fs.readdirSync(repairDirectory(scope))) {
            if (!name.startsWith(id + '.')) continue;
            const suffix = name.slice(id.length + 1), descriptor = expected.get(suffix);
            if (!descriptor || entry.phase === 'aborted') throw integrityFailure('Unexpected repair evidence was retained.');
            const filename = repairPath(scope, id, suffix);
            const file = readRoleplayFile(filename, descriptor.limit);
            if (!file || file.rawHash !== descriptor.hash) throw integrityFailure('Changed repair evidence was retained.');
            payloads.push({ filename, file, limit: descriptor.limit, suffix });
        }
        if (entry.phase === 'aborted') return { id, discarded: true, replayed: true };
        // Validate every file before deleting any; retain the plan until all other payloads are gone.
        payloads.sort((a, b) => Number(a.suffix === 'plan.json') - Number(b.suffix === 'plan.json'));
        setRepairPhase(lease, id, 'aborting');
        checkpoint('aborting');
        for (const payload of payloads) {
            checkpoint(`discarding-${payload.suffix}`);
            const current = readRoleplayFile(payload.filename, payload.limit);
            if (!current || current.rawHash !== payload.file.rawHash || !same(current.physical, payload.file.physical)) {
                throw integrityFailure('Repair evidence changed during discard and was retained.');
            }
            fs.unlinkSync(payload.filename);
            fsyncDirectorySync(repairDirectory(scope));
            checkpoint(`discarded-${payload.suffix}`);
        }
        setRepairPhase(lease, id, 'aborted');
        checkpoint('aborted');
        return { id, discarded: true, replayed: false };
    });
}

export function roleplayImageRepairHistory(base, input) {
    return withRoleplayAccount(base, input.account, lease => {
        const { scope } = roleplayLease(lease);
        const catalogue = readRepairJson(path.join(repairDirectory(scope), 'catalogue.json'), REPAIR_LIMIT, true);
        if (!catalogue) return { operations: [], next: null };
        const offset = input.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw repairFailure('Invalid recovery history page.');
        const entries = repairCatalogue(scope).value.entries;
        const ids = Object.keys(entries);
        return { operations: ids.slice(offset, offset + 50).map(id => {
            const plan = readRepairJson(repairPath(scope, id, 'plan.json'), REPAIR_LIMIT, true)?.value;
            const manifest = readRepairJson(repairPath(scope, id, 'manifest.json'), REPAIR_LIMIT, true)?.value;
            return { id, locator: plan?.input.source.locator ?? entries[id].locator ?? null, createdAt: plan?.createdAt ?? entries[id].createdAt ?? null,
                phase: entries[id].phase, stage: entries[id].phase === 'aborted' ? 'discarded' : manifest?.stage ?? 'staging-incomplete', result: manifest?.result ?? null, backupAvailable: manifest?.stage === 'committed' && !manifest.backupRemoved };
        }), next: offset + 50 < ids.length ? offset + 50 : null };
    });
}

export function exportRoleplayImageBackup(base, input) {
    return withRoleplayAccount(base, input.account, lease => {
        const { scope } = roleplayLease(lease);
        const plan = readRepairJson(repairPath(scope, input.id, 'plan.json')).value;
        const manifest = readRepairJson(repairPath(scope, input.id, 'manifest.json')).value;
        if (manifest.stage !== 'committed' || manifest.backupRemoved) throw repairFailure(uiText('This backup is no longer available.'));
        const file = readRoleplayFile(repairPath(scope, input.id, 'before.jsonl'), REPAIR_CHAT_LIMIT);
        if (!file || file.rawHash !== plan.beforeHash) throw integrityFailure('The backup is missing or changed.');
        return file.bytes;
    });
}
export function removeRoleplayImageBackup(base, input) {
    return withRoleplayAccount(base, input.account, lease => {
        const { scope } = roleplayLease(lease);
        const id = input.id;
        const plan = readRepairJson(repairPath(scope, id, 'plan.json')).value;
        const manifest = readRepairJson(repairPath(scope, id, 'manifest.json'));
        if (manifest.value.stage !== 'committed') throw repairFailure(uiText('An unfinished change\'s backup cannot be deleted. Finish or discard the change first.'));
        finishRepair(lease, id);
        const payloads = [{ suffix: 'before.jsonl', hash: plan.beforeHash, limit: REPAIR_CHAT_LIMIT },
            { suffix: 'candidate.jsonl', hash: plan.candidateHash, limit: REPAIR_CHAT_LIMIT },
            ...(plan.images ?? []).map((image, index) => ({ suffix: `image.${index}.bin`, hash: image.rawHash, limit: 1024 * 1024 }))];
        // Record the end of undo availability first. A crash leaves only redundant protected backups.
        manifest.value.backupRemoved = true;
        writeRepairJson(repairPath(scope, id, 'manifest.json'), manifest.value, REPAIR_LIMIT, manifest.file);
        for (const payload of payloads) {
            const filename = repairPath(scope, id, payload.suffix);
            const file = readRoleplayFile(filename, payload.limit);
            if (!file) continue;
            if (file.rawHash !== payload.hash) throw integrityFailure('A backup file changed and was retained.');
            fs.unlinkSync(filename);
            fsyncDirectorySync(repairDirectory(scope));
        }
        const catalogue = repairCatalogue(scope);
        catalogue.value.entries[id].bytes = 2 * REPAIR_LIMIT;
        writeRepairJson(path.join(repairDirectory(scope), 'catalogue.json'), catalogue.value, REPAIR_LIMIT, catalogue.file);
        return { id, removed: true, undoAvailable: false };
    });
}

export function listRoleplayImageChats(base, input) {
    return withRoleplayAccount(base, input.account, lease => {
        const { scope } = roleplayLease(lease), directories = scope.directories;
        const offset = input.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw repairFailure('Invalid chat list page.');
        const locators = [];
        const add = (folder, avatar = null) => {
            readRoleplayFile(path.join(folder, '.image-list-path-check'), 1, { allowMissingParent: true });
            if (!fs.existsSync(folder)) return;
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
                const locator = { group: avatar === null, chat: entry.name.slice(0, -6), ...(avatar ? { avatar } : {}) };
                try { normaliseRoleplayLocator(locator); } catch { continue; }
                locators.push(locator);
                if (locators.length > 10000) throw repairFailure(uiText('You have more than 10,000 chats, too many to list here. Open a chat and review it from Current chat.'));
            }
        };
        readRoleplayFile(path.join(directories.chats, '.image-list-path-check'), 1, { allowMissingParent: true });
        if (fs.existsSync(directories.chats)) for (const folder of fs.readdirSync(directories.chats, { withFileTypes: true })) {
            if (folder.isDirectory()) add(path.join(directories.chats, folder.name), folder.name + '.png');
        }
        add(directories.groupChats);
        locators.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return { chats: locators.slice(offset, offset + 100), next: offset + 100 < locators.length ? offset + 100 : null, total: locators.length };
    });
}
export function readRoleplayImageReviewSource(base, input) {
    return withRoleplayAccount(base, input.account, lease => {
        const { scope } = roleplayLease(lease), locator = normaliseRoleplayLocator(input.observation?.locator);
        const { file, records } = readChat(scope, locator);
        if (!same(input.observation, observation(scope, locator, file))) throw repairFailure(uiText('The chat changed. List its images again.'));
        const found = attachmentLocations(records).locations.find(item => item.identity === input.identity);
        if (!found || typeof found.item?.url !== 'string') throw repairFailure(uiText('That image can no longer be found in the chat. List the images again.'));
        const url = found.item.url;
        if (url.startsWith('/user/images/')) {
            const image = readRoleplayFile(accountImagePath(scope.directories, url), 16 * 1024 * 1024);
            if (!image) throw repairFailure(uiText('The image file is missing. Choose an image file instead.'));
            return { base64: image.bytes.toString('base64'), originalHash: image.rawHash };
        }
        if (url.length > 4 * Math.ceil(16 * 1024 * 1024 / 3) + 128) throw repairFailure(uiText('This image is larger than 16 MiB, too large to convert. Choose an image file instead.'));
        return { url };
    });
}
