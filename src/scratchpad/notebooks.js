import { hash } from '../mewmory/core.js';
import { canonical } from '../jobs/store.js';
import { roleplayAccountStamp } from '../roleplay-store.js';
import * as notebooks from '../notebooks/store.js';
import * as assistant from '../notebooks/assistant.js';
import { assistantCan, assistantCanPublish } from '../notebooks/permissions.js';
import { notifyNotebookChanged } from '../notebooks/events.js';
import { splitReply } from '../../public/scripts/scratchpad/proposals.js';
import { NOTE_TOOL_NOTICE } from '../../public/scripts/notebooks/assistant-note-tools.js';
import { findMessage, findSession, readBucketLocked, ScratchpadError, withScratchpad, writeBucketLocked } from './store.js';

const MAX_CONTEXT_BYTES = 320 * 1024;

/** Notebook scans run outside short account leases, just as on the Notes routes. */
export async function withNotebookPreparation(base, operation) {
    for (let attempt = 0; ; attempt++) {
        try {
            return withScratchpad(base, operation);
        } catch (error) {
            if (error.code !== 'NOTEBOOK_RECONCILING' || !error.notebookId || attempt >= notebooks.MAX_NOTEBOOKS) throw error;
            await notebooks.prepareNotebook(base, error.notebookId, { stamp: roleplayAccountStamp(base), force: true });
        }
    }
}

/** Only the server reads notes for a reply; browser text cannot broaden note access. */
export function notebookContextLocked(lease, settings) {
    const destinations = assistant.captureNoteToolLocked(lease, { tool: 'notebooks', args: {} }).response.notebooks;
    const grants = assistant.listGrantsLocked(lease);
    const notes = (settings.notes ?? []).map(ref => {
        try {
            const note = assistant.captureNoteToolLocked(lease, { tool: 'read-note', args: ref }).response;
            const policies = notebooks.readPoliciesLocked(lease, ref.notebookId);
            const grant = grants.find(item => item.id === ref.grantId);
            const selection = note.scope === 'selection';
            return { ...note, reference: ref, policyRevision: policies.revision,
                canEdit: selection ? note.canEdit === true : grant ? grant.operations.includes('edit') : assistantCan(policies, ref.noteId, 'edit'),
                canAppend: !selection && (grant ? grant.operations.includes('append') : assistantCan(policies, ref.noteId, 'edit')),
                canPublishLore: !selection && !grant && assistantCanPublish(policies, ref.noteId),
            };
        } catch (error) {
            if (![403, 404, 409].includes(error.status) || error.code === 'NOTEBOOK_RECONCILING') throw error;
            return { reference: ref, unavailable: true, notice: 'This note or selection is no longer shared, has changed, or cannot be found. Share it again from Notes if needed.' };
        }
    });
    const payload = { notice: NOTE_TOOL_NOTICE, notebooks: destinations, notes };
    const text = destinations.length || notes.length ? JSON.stringify(payload, null, 2) : '';
    if (Buffer.byteLength(text) > MAX_CONTEXT_BYTES) throw new ScratchpadError('SCRATCHPAD_NOTES_TOO_LARGE', 'Share fewer notes or choose a section before sending.', 413);
    return { ...payload, text, fingerprint: hash(canonical(payload)) };
}

function noteChange(bucket, body) {
    const session = findSession(bucket, body.sessionId);
    const message = findMessage(session, body.messageId);
    const part = splitReply(message.text).find(item => item.type === 'change' && item.index === body.index);
    if (message.role !== 'assistant' || message.state !== 'done' || part?.change?.type !== 'notebook') {
        throw new ScratchpadError('SCRATCHPAD_PROPOSAL_INVALID', 'That note change is not part of a finished reply.');
    }
    return { session, message, part, changeHash: hash(canonical(part.change)) };
}

/** Shares the very same immutable review with Notes > Assistant changes. Never auto-applies. */
export function prepareNotebookProposalLocked(lease, source, body, { bucket = readBucketLocked(lease, source), save = true } = {}) {
    const { session, message, part, changeHash } = noteChange(bucket, body);
    const tool = part.change.action;
    const args = part.change.args;
    const callId = `scratchpad:${hash(canonical([source.kind, source.key, session.id, message.id, part.index, changeHash]))}`;
    const ref = message.notebookProposals?.[part.index];
    let item = ref?.changeHash === changeHash ? assistant.readProposalLocked(lease, ref.id)
        : assistant.proposalForCallLocked(lease, { callId, tool, args });
    if (!item) {
        const captured = assistant.captureNoteToolLocked(lease, { tool, args });
        if (captured.response) return { ...captured.response, bucket };
        const stored = assistant.storeProposalLocked(lease, { proposal: captured.proposal, callId, request: { tool, args }, origin: 'scratchpad' });
        item = assistant.readProposalLocked(lease, stored.proposalId);
    }
    message.notebookProposals = { ...message.notebookProposals, [part.index]: { id: item.id, changeHash } };
    if (save) writeBucketLocked(lease, bucket);
    return { proposalId: item.id, proposalHash: item.hash, state: item.state,
        summary: assistant.proposalSummary(item.proposal), before: item.proposal.before ?? '', after: item.proposal.after ?? '',
        result: item.result ?? null, bucket };
}

/** Valid finished suggestions appear in both workspaces without saving their changes. */
export function captureReplyNotebookProposalsLocked(lease, bucket, session, message) {
    const results = [];
    for (const part of splitReply(message.text)) {
        if (part.change?.type !== 'notebook') continue;
        try {
            results.push(prepareNotebookProposalLocked(lease, bucket.source,
                { sessionId: session.id, messageId: message.id, index: part.index }, { bucket, save: false }));
        } catch (error) {
            if (error.code === 'NOTEBOOK_RECONCILING' || ![400, 403, 404, 409, 413].includes(error.status)) throw error;
            /* An invalid or no-longer-authorised suggestion must not discard the answer. Review reports its exact error. */
        }
    }
    return results;
}

export function decideNotebookProposalLocked(lease, source, body, actor) {
    const bucket = readBucketLocked(lease, source);
    const { message, part, changeHash } = noteChange(bucket, body);
    const ref = message.notebookProposals?.[part.index];
    if (!ref || ref.changeHash !== changeHash) throw new ScratchpadError('SCRATCHPAD_PROPOSAL_INVALID', 'Review this change again before saving it.', 409);
    const item = assistant.readProposalLocked(lease, ref.id);
    const result = { notebookId: item.proposal.notebookId, ...assistant.decideProposalLocked(lease, { proposalId: ref.id, proposalHash: body.proposalHash, decision: body.decision, actor }) };
    message.proposals = { ...message.proposals, [part.index]: result.committed ? 'applied' : 'rejected' };
    writeBucketLocked(lease, bucket);
    return { result, bucket };
}

/** A review approved or declined in Notes also updates its Scratchpad card. */
export function projectNotebookProposalsLocked(lease, bucket) {
    if (!bucket.sessions.some(session => session.messages.some(message => Object.keys(message.notebookProposals ?? {}).length))) return bucket;
    const proposals = new Map(assistant.listProposalsLocked(lease, { state: null }).map(item => [item.id, item]));
    for (const session of bucket.sessions) {
        for (const message of session.messages) {
            for (const [index, ref] of Object.entries(message.notebookProposals ?? {})) {
                const item = proposals.get(ref.id);
                if (!item) continue;
                if (item.state === 'applied' || item.state === 'denied') {
                    message.proposals = { ...message.proposals, [index]: item.state === 'applied' ? 'applied' : 'rejected' };
                }
            }
        }
    }
    return bucket;
}

export function notifyScratchpadNotebookResult(base, result) {
    const item = result.result;
    const notebookId = item?.notebookId ?? result.summary?.notebookId;
    if (notebookId) notifyNotebookChanged({ owner: base.owner, kind: item?.committed && !item.replayed ? 'note' : 'proposal', notebookId,
        noteId: item?.noteId, revision: item?.revision });
}
