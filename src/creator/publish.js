import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { roleplayLease, roleplayError, readRoleplayFile, roleplayHash } from '../roleplay-store.js';
import { readAuthoringFileLocked, writeAuthoringFileLocked, stageAuthoringFileLocked, publishAuthoringFileLocked, authoringEvidence } from '../authoring-store.js';
import { commitRoleplayLifecycleLocked } from '../roleplay-lifecycle.js';
import { write as writeCharacterCard } from '../character-card-parser.js';
import { assertNativeMediaTargetIdle } from '../generation/media-jobs.js';
import { isValidWorldInfoData } from '../endpoints/worldinfo.js';
import { worldInfoRevision } from '../world-info-history.js';
import { getCreatorDraft, saveCreatorDraft, deleteCreatorDraft } from './store.js';
import { creatorCharacterSource, creatorBookSource } from './resources.js';
import { creatorPublicationCard } from '../../public/scripts/creator/embedded-book.js';
import { creatorAdditionalBooks, publishCreatorBindings } from './bindings.js';
import { isDeepStrictEqual } from 'node:util';

const MAX_CARD = 64 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const conflict = message => roleplayError('CREATOR_PUBLISH_CONFLICT', message, 409);

function receiptPath(lease, operationId) {
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(operationId)) throw roleplayError('CREATOR_OPERATION', 'Choose a valid save operation.', 400);
    return path.join(roleplayLease(lease).scope.directories.root, 'creator', 'receipts', `${operationId}.json`);
}

function publicationPath(lease, id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw roleplayError('CREATOR_ID', 'Choose a valid Creator draft.', 400);
    return path.join(roleplayLease(lease).scope.directories.root, 'creator', 'publications', `${digest(id)}.json`);
}

/** A server-side pointer survives loss of browser storage and a second device's retry. */
export function getCreatorPublication(lease, id) {
    const file = readRoleplayFile(publicationPath(lease, id), 4096, { allowMissingParent: true });
    return file ? JSON.parse(file.bytes.toString('utf8')) : null;
}

/** A second device must not discard the only draft that can recover a frozen save. */
export function discardCreatorDraft(lease, { id, expectedRevision }) {
    const publication = getCreatorPublication(lease, id);
    if (publication && !publication.acknowledged) throw conflict('This draft has an unfinished library save. Open it and recover the save before discarding.');
    return deleteCreatorDraft(lease, id, expectedRevision);
}

function result(receipt) {
    return { operationId: receipt.operationId, state: receipt.state, avatar: receipt.avatar,
        revision: receipt.cardHash, binding: receipt.binding ? { books: receipt.binding.after, state: receipt.binding.state, settingsWrite: receipt.binding.settingsWrite } : null,
        books: receipt.books.map(book => ({ id: book.id, name: book.name, state: book.state, revision: book.revision })) };
}

function characterStep(receipt, bytes) {
    return { operationKey: `creator:${receipt.operationId}`, action: receipt.copy ? 'character-create' : 'character-update',
        intent: { manifest: receipt.manifest, rawHash: receipt.cardHash },
        steps: [{ op: receipt.copy ? 'create' : 'update', kind: 'character', locator: { avatar: receipt.avatar }, bytes }] };
}

/** Receipts are server-owned. Repeating a save resumes its frozen resources, not a changed draft. */
export function publishCreatorDraft(lease, { id, expectedRevision, operationId, copy = false }, host = {}) {
    receiptPath(lease, operationId);
    const previous = getCreatorPublication(lease, id);
    if (previous) {
        if (!previous.acknowledged && previous.expectedRevision === expectedRevision && previous.copy === copy) operationId = previous.operationId;
        else {
            const priorFile = readRoleplayFile(receiptPath(lease, previous.operationId), MAX_CARD, { allowMissingParent: true });
            if (priorFile && !['done', 'stopped'].includes(JSON.parse(priorFile.bytes.toString('utf8')).state)) throw conflict('This draft has an interrupted save. Resume it or recover it for comparison before starting another review.');
        }
    }
    const filename = receiptPath(lease, operationId);
    const { scope, state } = roleplayLease(lease);
    // A lifecycle interruption blocks authoring reads. Only its own saved receipt can resume it.
    const saved = readRoleplayFile(filename, MAX_CARD, { allowMissingParent: true });
    let receipt = saved ? JSON.parse(saved.bytes.toString('utf8')) : null;
    if (receipt && (receipt.id !== id || receipt.draftRevision !== expectedRevision || receipt.requestedCopy !== copy)) throw conflict('This save operation belongs to a different review. Start a new review.');
    if (receipt && ['recovering', 'stopped'].includes(receipt.state)) throw conflict('This save was stopped for comparison. Reopen the recovered draft.');
    if (state.pending) {
        if (!receipt?.characterPrepared) throw conflict('Another saved operation needs recovery first.');
        commitRoleplayLifecycleLocked(lease, characterStep(receipt, Buffer.alloc(0)));
    }
    const persist = () => writeAuthoringFileLocked(lease, filename, JSON.stringify(receipt));
    if (!receipt) {
        const item = getCreatorDraft(lease, id);
        if (item.revision !== expectedRevision) throw conflict('The draft changed after review. Review it again before saving.');
        const draft = item.draft;
        const card = creatorPublicationCard(draft);
        if (typeof card.data.name !== 'string' || !card.data.name.trim() || card.data.name.length > 200) throw roleplayError('CREATOR_NAME', 'Give your character a name of up to 200 characters.', 400);
        const source = draft.source.avatar ? creatorCharacterSource(lease, draft.source.avatar) : null;
        if (source && !copy && source.revision !== draft.source.revision) throw conflict('The original character changed. Compare changes or save a copy.');
        const creating = copy || !source;
        const avatar = creating ? previous?.reservedAvatar ?? `Creator-${randomUUID()}.png` : source.avatar;
        let additional = draft.additionalBooks ?? source?.extraBooks ?? [];
        if (!Array.isArray(additional) || additional.length > 100 || additional.some(name => typeof name !== 'string' || !name.trim() || name.length > 255)) throw roleplayError('CREATOR_BINDINGS', 'Choose valid additional lorebooks.', 400);
        if (source && !copy && !isDeepStrictEqual(source.extraBooks, draft.source.extraBooks ?? source.extraBooks)) throw conflict('Additional lorebook links changed. Compare them before saving.');
        const bindingBefore = creatorAdditionalBooks(lease, avatar);
        const books = [];
        const names = new Set();
        const canonicalNames = new Map();
        for (const book of draft.books) {
            if (book.mode === 'embedded' || book.detached) continue;
            if (!['linked', 'copy'].includes(book.mode) || !isValidWorldInfoData(book.data)) throw roleplayError('CREATOR_BOOK', 'Review the attached lorebook before saving.', 400);
            const target = creatorBookSource(lease, book.name, { allowMissing: true });
            if (names.has(target.name)) throw conflict('Two draft lorebooks have the same saved name. Give each a different name.');
            names.add(target.name);
            canonicalNames.set(book.name, target.name);
            const expected = book.mode === 'copy' ? null : book.revision;
            if (target.revision !== expected) throw conflict(`The lorebook ${target.name} changed. Compare it before saving.`);
            assertNativeMediaTargetIdle(lease, { kind: 'lorebook', id: target.filename });
            books.push({ id: book.id, name: target.name, filename: target.filename, data: book.data,
                before: authoringEvidence(target.file), revision: worldInfoRevision(book.data), state: 'waiting', staged: null });
        }
        if (card.data.extensions?.world && canonicalNames.has(card.data.extensions.world)) card.data.extensions.world = canonicalNames.get(card.data.extensions.world);
        additional = [...new Set(additional.map(name => canonicalNames.get(name) ?? name))];
        const binding = isDeepStrictEqual(bindingBefore, additional) ? null : { before: bindingBefore, after: additional, state: 'waiting', staged: null };
        let image = source ? readRoleplayFile(path.join(scope.directories.characters, source.avatar), MAX_CARD).bytes
            : fs.readFileSync(new URL('../../public/img/ai4.png', import.meta.url));
        if (!source && previous?.reservedAvatar) {
            const prior = JSON.parse(readRoleplayFile(receiptPath(lease, previous.operationId), MAX_CARD).bytes.toString('utf8'));
            if (prior.cardBytes) image = Buffer.from(prior.cardBytes, 'base64');
        }
        if (draft.selectedMedia) {
            const media = draft.media.find(item => item.id === draft.selectedMedia);
            if (!media || typeof media.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(media.dataUrl)) throw roleplayError('CREATOR_MEDIA', 'Select a valid PNG portrait before saving.', 400);
            image = Buffer.from(media.dataUrl.split(',')[1], 'base64');
            if (image.length > 8 * 1024 * 1024) throw roleplayError('CREATOR_MEDIA', 'Use a portrait smaller than 8 MiB.', 413);
        }
        // Preserve opaque imported metadata. Only normalise aliases already present in the card.
        for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'tags']) {
            if (Object.hasOwn(card, field)) card[field] = card.data[field];
        }
        if (Object.hasOwn(card, 'creatorcomment')) card.creatorcomment = card.data.creator_notes;
        const bytes = writeCharacterCard(image, JSON.stringify(card));
        if (bytes.length > MAX_CARD) throw roleplayError('CREATOR_CARD_SIZE', 'This character card is too large.', 413);
        receipt = { schema: 1, operationId, id, draftRevision: expectedRevision, requestedCopy: copy, copy: creating,
            avatar, sourceRevision: source?.revision ?? null, state: 'saving', characterPrepared: false,
            cardHash: digest(bytes), card, cardBytes: bytes.toString('base64'), books, binding,
            manifest: digest(JSON.stringify({ card, books, avatar, binding })), createdAt: new Date().toISOString() };
        writeAuthoringFileLocked(lease, publicationPath(lease, id), JSON.stringify({ id, expectedRevision, operationId, copy }));
        persist();
    }
    if (receipt.state === 'done') return result(receipt);
    for (const book of receipt.books) {
        if (book.state === 'done') continue;
        const target = path.join(scope.directories.worlds, book.filename);
        assertNativeMediaTargetIdle(lease, { kind: 'lorebook', id: book.filename });
        if (!book.staged) {
            book.staged = stageAuthoringFileLocked(lease, target, JSON.stringify(book.data, null, 4), { expected: book.before });
            persist();
        }
        publishAuthoringFileLocked(lease, book.staged, { checkpoint: persist });
        book.state = 'done';
        persist();
        host.afterBook?.(book);
    }
    publishCreatorBindings(lease, receipt, persist);
    host.afterBindings?.();
    const target = path.join(scope.directories.characters, receipt.avatar);
    const current = readRoleplayFile(target, MAX_CARD, { allowMissingParent: true });
    const ownOutput = receipt.characterPrepared && current?.rawHash === receipt.cardHash;
    if (!ownOutput && (receipt.copy ? current !== null : current?.rawHash !== receipt.sourceRevision)) throw conflict('The character changed while its lorebooks were being saved. Saved books are retained; compare the character before continuing.');
    if (!receipt.characterPrepared) {
        receipt.characterPrepared = true;
        persist();
    }
    commitRoleplayLifecycleLocked(lease, characterStep(receipt, Buffer.from(receipt.cardBytes, 'base64')));
    const published = readRoleplayFile(target, MAX_CARD);
    if (published?.rawHash !== receipt.cardHash) throw conflict('The saved character no longer matches this publication receipt.');
    host.afterCharacter?.();
    receipt.state = 'done';
    delete receipt.cardBytes;
    persist();
    return result(receipt);
}

/** Acknowledge only after the saved draft has adopted the publication's identity. */
export function acknowledgeCreatorPublication(lease, { id, operationId }) {
    const publication = getCreatorPublication(lease, id);
    if (!publication || publication.operationId !== operationId) throw conflict('The save changed. Reopen the draft.');
    const { draft } = getCreatorDraft(lease, id);
    const file = readAuthoringFileLocked(lease, receiptPath(lease, operationId));
    const receipt = file ? JSON.parse(file.bytes.toString('utf8')) : null;
    if (receipt?.state !== 'done' || draft.journal?.operationId !== operationId || draft.source.avatar !== receipt.avatar || draft.source.revision !== receipt.cardHash) {
        throw conflict('Save the recovered draft before acknowledging this operation.');
    }
    writeAuthoringFileLocked(lease, publicationPath(lease, id), JSON.stringify({ ...publication, acknowledged: true }));
    return { acknowledged: true };
}

/** Stop frozen work explicitly, retaining committed identities and comparison baselines. */
export function recoverCreatorPublication(lease, { id, operationId, expectedRevision }) {
    const publication = getCreatorPublication(lease, id);
    if (!publication || publication.operationId !== operationId) throw conflict('The save changed. Reopen the draft.');
    const filename = receiptPath(lease, operationId);
    const file = readRoleplayFile(filename, MAX_CARD, { allowMissingParent: true });
    if (!file) throw conflict('The save receipt is unavailable. Retry the original save.');
    const receipt = JSON.parse(file.bytes.toString('utf8'));
    if (receipt.id !== id) throw conflict('This receipt belongs to another draft.');
    // Finish only an already-started lifecycle transaction, never start a new write here.
    const { state } = roleplayLease(lease);
    const lifecycleKey = roleplayHash([state.accountId, 'lifecycle', `creator:${operationId}`]);
    if (state.pending?.operationKeyHash === lifecycleKey) commitRoleplayLifecycleLocked(lease, characterStep(receipt, Buffer.alloc(0)));
    const characterCommitted = receipt.state === 'done' || !!state.submissions[lifecycleKey];
    let item = getCreatorDraft(lease, id);
    const acknowledge = () => writeAuthoringFileLocked(lease, publicationPath(lease, id), JSON.stringify({ ...publication, acknowledged: true,
        ...(!characterCommitted && receipt.copy ? { reservedAvatar: receipt.avatar } : {}) }));
    if (receipt.state === 'stopped') { acknowledge(); return item; }
    const persist = () => writeAuthoringFileLocked(lease, filename, JSON.stringify(receipt));
    const recoveryFilename = filename.replace(/\.json$/, '.recovery.json');
    if (!receipt.recoveryPrepared && !receipt.recoveryDraft) {
        if (item.revision !== expectedRevision) throw conflict('The draft changed elsewhere. Reopen it before recovering the save.');
        const draft = structuredClone(item.draft);
        const publishedCard = receipt.card ?? creatorPublicationCard(draft);
        if (characterCommitted) {
            draft.source = { avatar: receipt.avatar, revision: receipt.cardHash, original: publishedCard, extraBooks: receipt.binding?.after ?? draft.additionalBooks ?? [] };
        } else if (receipt.copy) {
            draft.source = { avatar: null, revision: null, original: null, extraBooks: [] };
        }
        for (const savedBook of receipt.books) {
            const book = draft.books.find(book => savedBook.id ? book.id === savedBook.id : book.name === savedBook.name);
            if (!book) continue;
            const current = creatorBookSource(lease, savedBook.name, { allowMissing: true });
            const committed = savedBook.state === 'done' || savedBook.staged?.after?.rawHash === current.file?.rawHash;
            if (committed) {
                book.mode = 'linked'; book.revision = savedBook.revision;
                book.original = structuredClone(savedBook.data ?? book.data);
            } else if (current.file && book.mode === 'copy') {
                // A crash may have followed the rename before the receipt checkpoint.
                // Force comparison with the existing file before another publication.
                book.mode = 'linked'; book.revision = null;
                book.original ??= { entries: {} };
            }
            if (draft.card.data.extensions?.world === book.name) draft.card.data.extensions.world = savedBook.name;
            draft.additionalBooks = (draft.additionalBooks ?? []).map(name => name === book.name ? savedBook.name : name);
            book.name = savedBook.name;
        }
        if (receipt.binding?.state === 'done') draft.source.extraBooks = structuredClone(receipt.binding.after);
        draft.journal = { ...result(receipt), recovered: true };
        draft.history = []; draft.future = [];
        // Keep the snapshot separate so a valid large draft does not double the receipt.
        writeAuthoringFileLocked(lease, recoveryFilename, JSON.stringify(draft));
        receipt.recoveryPrepared = true;
        receipt.recoveryRevision = expectedRevision;
        receipt.state = 'recovering';
        persist();
    }
    if (item.draft.journal?.operationId !== operationId || !item.draft.journal?.recovered) {
        const recovered = receipt.recoveryDraft ?? JSON.parse(readAuthoringFileLocked(lease, recoveryFilename).bytes.toString('utf8'));
        item = saveCreatorDraft(lease, recovered, receipt.recoveryRevision);
    }
    receipt.state = 'stopped';
    persist();
    acknowledge();
    return item;
}

export function getCreatorReceipt(lease, operationId) {
    const file = readAuthoringFileLocked(lease, receiptPath(lease, operationId));
    if (!file) throw roleplayError('CREATOR_RECEIPT', 'This save has not started.', 404);
    return result(JSON.parse(file.bytes.toString('utf8')));
}
