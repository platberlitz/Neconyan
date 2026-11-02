import { element, button } from './fields.js';
import { CREATOR_FORMATS } from './formats.js';

export function renderCreatorFormat(workspace, main) {
    const group = element('fieldset', 'creator-fieldset');
    group.append(element('legend', '', 'Character writing format'));
    const row = element('div', 'creator-actions creator-chip-strip');
    for (const [id, format] of Object.entries(CREATOR_FORMATS)) {
        const choice = button(format.label, () => workspace.edit(next => { next.style = id; }, true), false, 'creator-chip-btn');
        choice.setAttribute('aria-pressed', String((workspace.session.draft.style || 'plain') === id));
        choice.title = format.hint;
        row.append(choice);
    }
    group.append(row, element('p', 'creator-muted', 'Used by Dossier conversion, Generate and the Writing partner. Choosing a format does not replace existing text.'));
    const feedback = element('p', 'creator-muted');
    feedback.setAttribute('role', 'status');
    let controller;
    const cancel = button('Cancel conversion', () => controller?.abort(), false, 'creator-chip-btn');
    cancel.hidden = true;
    const convert = button('Review conversion of existing text', () => workspace.run(async () => {
        try {
            const source = structuredClone(workspace.session.draft);
            const fields = ['description', 'personality', 'scenario', 'mes_example'].filter(field => source.card.data[field]?.trim() && !source.locks.includes(field));
            if (!fields.length) throw new Error('Add descriptive text or example dialogue first, or convert your Dossier into fields. Locked fields are left alone.');
            const { buildCreatorWritingRequest, requestCreatorReply } = await import('./assistant.js');
            const { dossierProposal } = await import('./dossier.js');
            const instruction = 'Convert the selected existing fields to the selected writing format. Preserve every established fact, literal macro, secret boundary and meaningful voice detail. Do not add new facts. In coverage, identify what was kept, reworded or omitted; questions must identify anything that cannot be converted faithfully.';
            const request = buildCreatorWritingRequest(source, instruction, fields);
            convert.disabled = true; cancel.hidden = false; controller = new AbortController();
            feedback.textContent = 'Converting existing text. Your fields stay unchanged until you accept the proposal.';
            const output = await requestCreatorReply(workspace, source, request.messages, { signal: controller.signal });
            const proposal = dossierProposal(source, output, fields);
            delete proposal.dossierBefore;
            proposal.formatBefore = source.style;
            proposal.label = `${CREATOR_FORMATS[source.style]?.label || 'Natural description'} conversion`;
            workspace.proposal(proposal);
            feedback.textContent = 'Conversion ready for review.';
        } catch (error) {
            feedback.textContent = error?.message || String(error);
            throw error;
        } finally { convert.disabled = false; cancel.hidden = true; }
    }), false, 'creator-chip-btn');
    group.append(convert, cancel, feedback);
    main.append(group);
}
