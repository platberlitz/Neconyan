import { element, button, textField } from './fields.js';
import { updateCreatorLiveReply } from './live-reply.js';
import { creatorTargetsSignature } from './formats.js';
import { acceptCreatorField } from './field-generation.js';
import { editCreatorDraft } from './model.js';
import { parseCreatorLoreProposal, acceptCreatorLoreProposal } from './lore-proposals.js';

const finished = job => ['completed', 'failed', 'interrupted', 'cancelled', 'conflict'].includes(job.state);

export function recoverCreatorServerReply(draft, result) {
    const { source, recovery, text } = result;
    if (draft.id !== source?.id) throw new Error('Open the original draft before recovering this reply.');
    if (recovery.kind === 'field') {
        const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
        return acceptCreatorField(draft, source, recovery.target, parsed.value);
    }
    return editCreatorDraft(draft, next => {
        if (recovery.kind === 'lore') {
            const proposal = parseCreatorLoreProposal(source, recovery.bookId, text, recovery.mode, recovery.source);
            acceptCreatorLoreProposal(next, proposal);
            next.proposals.push(proposal);
        } else if (recovery.kind === 'interview') {
            if (JSON.stringify(next.interview?.turns ?? []) !== JSON.stringify(source.interview?.turns ?? [])) throw new Error('The interview changed. The saved reply is still available to copy.');
            if (!text.trim() || text.length > 100000 || (next.interview?.turns?.length ?? 0) >= 100) throw new Error('The reply or interview is too long.');
            next.interview ??= { turns: [], assistants: [] };
            next.interview.turns.push({ id: crypto.randomUUID(), speaker: 'Interviewer', text: recovery.question }, { id: crypto.randomUUID(), speaker: recovery.speaker, text });
        }
    });
}

export async function creatorUsesServer() {
    const { prefersServerReplies } = await import('../browser-reply-routing.js');
    return prefersServerReplies();
}

export function importCreatorServerProposal(draft, result) {
    const index = draft.proposals.findIndex(item => item.id === result.proposal?.id);
    if (index < 0 || JSON.stringify(draft.proposals[index]) !== JSON.stringify(result.before)) throw new Error('This proposal changed while the server was writing. The saved server result is still available.');
    const proposal = result.proposal;
    if ((proposal.dossierBefore !== undefined && proposal.dossierBefore !== draft.dossier)
        || (proposal.formatBefore !== undefined && proposal.formatBefore !== draft.style)
        || (proposal.targetsBefore !== undefined && proposal.targetsBefore !== creatorTargetsSignature(draft))) throw new Error('The Dossier or writing format changed. The saved server result is still available.');
    draft.proposals[index] = structuredClone(proposal);
}

/** Closing the page only drops observation; Cancel explicitly stops the saved job. */
export async function requestCreatorServer(workspace, draft, request, { signal, isCurrent = () => true } = {}) {
    const { saveSettings, getActiveGenerationAcknowledgement } = await import('../../script.js');
    const current = () => {
        workspace.session.assertOwner();
        if (workspace.session.draft?.id !== draft.id || !isCurrent()) throw new Error('The source changed. The server result remains available in Server requests.');
    };
    current(); signal?.throwIfAborted();
    clearTimeout(workspace.timer);
    await workspace.session.save();
    if (!await saveSettings(0, { returnResult: true })) throw new Error('Save your connection settings before starting server generation.');
    current(); signal?.throwIfAborted();
    if (request.recovery && ['card', 'dossier', 'style', 'writing', 'books', 'interview', 'locks'].some(key => JSON.stringify(draft[key]) !== JSON.stringify(workspace.session.draft[key]))) {
        throw new Error('The draft changed before the request was saved. Generate again from the current draft.');
    }
    const { job } = await workspace.session.request('generate', { id: draft.id, expectedRevision: workspace.session.revision,
        submissionKey: crypto.randomUUID(), acknowledgement: getActiveGenerationAcknowledgement(), ...request });
    workspace.serverJob = job.id;
    updateCreatorLiveReply(workspace, { draftId: draft.id, text: '', reasoning: '', status: 'Writing on the server. You can close this page and return to Server requests.' });
    try {
        while (true) {
            if (signal?.aborted) {
                await workspace.session.request('generation', { id: draft.id, jobId: job.id, cancel: true });
                throw new Error('Cancelled. Finished steps remain in Server requests.');
            }
            current();
            const state = await workspace.session.request('generation', { id: draft.id, jobId: job.id });
            current();
            if (state.preview) updateCreatorLiveReply(workspace, { ...state.preview, status: state.job.stage || 'Writing on the server…' });
            if (finished(state.job)) {
                if (state.result?.proposal) {
                    if (!workspace.edit(next => importCreatorServerProposal(next, state.result), false, { record: false })) throw new Error(workspace.message);
                    clearTimeout(workspace.timer);
                    await workspace.session.save();
                }
                if (state.job.state !== 'completed') throw new Error(state.job.error?.message || 'The server request stopped. Finished work remains in Server requests.');
                return state.result;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } finally {
        if (workspace.serverJob === job.id) workspace.serverJob = null;
    }
}

export async function continueCreatorServerWriting(workspace, id, signal, reviseField) {
    const source = structuredClone(workspace.session.draft);
    const controller = new AbortController();
    workspace.requestController = controller;
    workspace.writingProposal = id;
    workspace.syncRequestControls();
    try {
        await requestCreatorServer(workspace, source, { proposalId: id, reviseField }, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
        workspace.status('Server writing finished. Review the proposal before accepting it.');
    } finally {
        workspace.requestController = null;
        workspace.writingProposal = null;
        workspace.syncRequestControls();
        const proposal = workspace.session.draft?.id === source.id && workspace.session.draft.proposals.find(item => item.id === id);
        if (proposal) workspace.proposal(proposal);
    }
}

export function renderCreatorServerRequests(workspace, actions) {
    actions.append(button('Server requests', () => workspace.run(async () => {
        const id = workspace.session.draft.id;
        const { jobs } = await workspace.session.request('generation', { id });
        if (workspace.session.draft.id !== id) return;
        const main = workspace.host.querySelector('.creator-content');
        main.querySelector('[data-creator-server-requests]')?.remove();
        const panel = element('section', 'creator-review-item');
        panel.dataset.creatorServerRequests = '';
        panel.append(element('h3', '', 'Server requests'), element('p', 'creator-muted', 'Saved writing keeps running when this page closes. Review returned proposals before accepting them.'));
        if (!jobs.length) panel.append(element('p', 'creator-muted', 'No saved requests for this draft. Choose On the server in Where replies are written to use server generation.'));
        for (const job of jobs.toReversed()) {
            const row = element('section', 'creator-review-item');
            row.append(element('h4', '', `${job.label}: ${job.state}`));
            row.append(button('Check result', () => workspace.run(async () => {
                const state = await workspace.session.request('generation', { id, jobId: job.id });
                if (workspace.session.draft.id !== id || !row.isConnected) return;
                row.querySelector('[data-creator-server-result]')?.remove();
                const result = element('div'); result.dataset.creatorServerResult = '';
                result.append(element('p', 'creator-muted', state.job.error?.message || state.job.stage || state.job.state));
                const text = state.result?.text ?? (state.result?.proposal ? JSON.stringify(state.result.proposal, null, 2) : state.preview?.text);
                if (text) {
                    const field = textField('Saved server output', text, () => {}, { rows: 8 });
                    field.querySelector('textarea').readOnly = true;
                    result.append(field);
                }
                if (state.result?.proposal && finished(state.job)) result.append(button('Recover proposal for review', () => workspace.run(async () => {
                    if (!workspace.edit(next => importCreatorServerProposal(next, state.result))) return;
                    clearTimeout(workspace.timer); await workspace.session.save();
                    workspace.proposal(state.result.proposal);
                }), true));
                if (state.result?.recovery && state.result.complete) result.append(button(state.result.recovery.kind === 'field' ? 'Use saved suggestion' : 'Recover saved reply', () => workspace.run(async () => {
                    if (!workspace.change(next => recoverCreatorServerReply(next, state.result))) return;
                    clearTimeout(workspace.timer); await workspace.session.save();
                    workspace.render();
                    workspace.status('Saved reply recovered. Your library has not changed.');
                }), true));
                row.append(result);
            }), false, 'creator-chip-btn'));
            if (!finished(job)) row.append(button('Cancel server request', () => workspace.run(async () => {
                await workspace.session.request('generation', { id, jobId: job.id, cancel: true });
                workspace.status('Cancellation requested. Finished work stays available.');
            }), false, 'creator-chip-btn'));
            panel.append(row);
        }
        main.prepend(panel);
    }), false, 'creator-chip-btn'));
}
