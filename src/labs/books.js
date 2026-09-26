import fs from 'node:fs';
import path from 'node:path';
import { getExistingWorldInfoFilename, getWorldInfoFilename, getWorldInfoName } from '../endpoints/worldinfo.js';
import { authoringEvidence, readAuthoringFileLocked, stageAuthoringFileLocked, publishAuthoringFileLocked } from '../authoring-store.js';
import { roleplayHash, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { appendWorldInfoCommit, newWorldInfoHistory, readWorldInfoHistory, worldInfoHistoryPath, worldInfoRevision } from '../world-info-history.js';
import { newWorldInfoEntryTemplate } from '../../public/scripts/world-info-entry.js';
import { isNativeLorebook, syncLorebookOriginalEntry } from '../../public/scripts/neconyan-lorebook-tools-core.js';
import { labError, mutateLabRecordLocked, readLabRecord, withLabRecord } from './store.js';

export function captureLabBookLocked(lease, requestedName, { create = false } = {}) {
    const { scope } = roleplayLease(lease);
    if (typeof requestedName !== 'string' || !requestedName || requestedName !== getWorldInfoName(requestedName)) throw labError('Choose a valid saved lorebook name.', 400);
    const directories = scope.directories;
    const existing = getExistingWorldInfoFilename(directories, requestedName);
    if (create && (existing || fs.readdirSync(directories.worlds).some(name => name.toLowerCase() === `${requestedName}.json`.toLowerCase()))) {
        throw labError('A lorebook with that name already exists.');
    }
    const filename = path.join(directories.worlds, existing || getWorldInfoFilename(requestedName));
    const file = readAuthoringFileLocked(lease, filename);
    if (!file && !create) throw labError('The selected lorebook no longer exists.');
    let book;
    try { book = file ? JSON.parse(file.bytes.toString('utf8')) : { entries: {} }; } catch { throw labError('The selected lorebook is unreadable.'); }
    if (!isNativeLorebook(book)) throw labError('The selected lorebook is invalid.');
    return { name: requestedName, relative: path.relative(directories.root, filename), book, create,
        revision: file ? worldInfoRevision(book) : null, evidence: authoringEvidence(file) };
}

export function captureLabBook(base, account, name, options) {
    return withRoleplayAccount(base, account, lease => captureLabBookLocked(lease, name, options));
}

/** A reviewed subset may edit its text, but cannot name another proposal or destination. */
function appendReviewedEntries(book, proposals, selected) {
    if (!Array.isArray(selected) || !selected.length || selected.length > proposals.length) throw labError('Select the proposed entries to add.', 400);
    const seen = new Set();
    for (const item of selected) {
        if (!Number.isSafeInteger(item.id) || !proposals.some(proposal => proposal.id === item.id) || seen.has(item.id)
            || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500
            || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 12000
            || !Array.isArray(item.keys) || !item.keys.length || item.keys.length > 32
            || item.keys.some(key => typeof key !== 'string' || !key.trim() || key.length > 500)) throw labError('A reviewed entry is invalid.', 400);
        seen.add(item.id);
        let uid = 0;
        while (Object.hasOwn(book.entries, uid)) uid++;
        book.entries[uid] = { ...structuredClone(newWorldInfoEntryTemplate), uid, comment: item.title.trim(),
            content: item.content.trim(), key: [...new Set(item.keys.map(key => key.trim()))], displayIndex: Object.keys(book.entries).length };
        syncLorebookOriginalEntry(book, String(uid));
    }
    return [...seen];
}

export function captureLabApply(base, account, input) {
    const proposal = readLabRecord(base, input.proposalKey);
    if (!proposal || proposal.state !== 'completed' || proposal.resultHash !== input.resultHash || !proposal.result?.target) throw labError('The reviewed proposal is missing or changed.');
    if (proposal.kind === 'apply') throw labError('An applied result is not a new proposal.', 400);
    const target = proposal.review?.target ?? proposal.result.target;
    const book = structuredClone(target.book);
    let selected = [];
    if (proposal.kind === 'distill') {
        selected = appendReviewedEntries(book, proposal.result.proposals, input.selected);
        if (selected.some(id => proposal.review?.usedIds?.includes(id))) throw labError('A selected proposal has already been added.');
    } else if (['lorestitch', 'world-info.batch', 'world-info.case'].includes(proposal.kind)) {
        if (Object.keys(proposal.review?.applies ?? {}).length) throw labError('This proposal has already been applied.');
        if (!isNativeLorebook(proposal.result.book)) throw labError('The proposed lorebook is invalid.');
        Object.keys(book).forEach(key => delete book[key]);
        Object.assign(book, structuredClone(proposal.result.book));
    } else throw labError('This result does not support a lorebook apply.', 400);
    return { proposalKey: proposal.key, proposalHash: proposal.resultHash, reviewHash: roleplayHash(proposal.review ?? null), selected, target, book,
        afterRevision: worldInfoRevision(book), account };
}

/** Save physical witnesses before publishing history or book; replay never repeats a done write. */
export function applyLabBook(context, { afterPublication } = {}) {
    return withLabRecord(context, ({ lease, value, save, base }) => {
        if (value.state === 'completed') return value.result;
        const plan = value.plan;
        if (!value.effects.book) {
            mutateLabRecordLocked(lease, plan.proposalKey, proposal => {
                if (proposal.resultHash !== plan.proposalHash || roleplayHash(proposal.review ?? null) !== plan.reviewHash) throw labError('This proposal was applied or changed after the selection was submitted.');
                return { unchanged: true };
            });
            const current = captureLabBookLocked(lease, plan.target.name, { create: plan.target.create });
            if (current.relative !== plan.target.relative || current.revision !== plan.target.revision
                || roleplayHash(current.evidence) !== roleplayHash(plan.target.evidence)) throw labError('The lorebook changed while this proposal was being reviewed. Review a new proposal before applying it.');
            const filename = path.join(base.directories.root, current.relative);
            const history = readWorldInfoHistory(filename, lease) || newWorldInfoHistory();
            if (!current.create) appendWorldInfoCommit(history, current.book, 'Before reviewed Labs changes');
            appendWorldInfoCommit(history, plan.book, 'Apply reviewed Labs changes');
            value.effects.history = { state: 'prepared', staged: stageAuthoringFileLocked(lease, worldInfoHistoryPath(filename), JSON.stringify(history)) };
            value.effects.book = { state: 'prepared', staged: stageAuthoringFileLocked(lease, filename, JSON.stringify(plan.book), { expected: current.evidence }) };
            save();
        }
        for (const name of ['history', 'book']) {
            const effect = value.effects[name];
            if (effect.state === 'done') continue;
            publishAuthoringFileLocked(lease, effect.staged);
            afterPublication?.(name);
            effect.state = 'done';
            save();
        }
        mutateLabRecordLocked(lease, plan.proposalKey, proposal => {
            if (proposal.review?.applies?.[value.key]) return { unchanged: true };
            if (proposal.resultHash !== plan.proposalHash || roleplayHash(proposal.review ?? null) !== plan.reviewHash) throw labError('The applied proposal bookkeeping needs recovery.');
            proposal.review = { usedIds: [...new Set([...(proposal.review?.usedIds ?? []), ...plan.selected])],
                applies: { ...proposal.review?.applies, [value.key]: plan.afterRevision },
                target: { ...plan.target, create: false, book: plan.book, revision: plan.afterRevision, evidence: value.effects.book.staged.after } };
        });
        const result = { name: plan.target.name, revision: plan.afterRevision, proposalKey: plan.proposalKey, selected: plan.selected };
        value.result = result;
        value.resultHash = roleplayHash(result);
        value.state = 'completed';
        save();
        return result;
    });
}
