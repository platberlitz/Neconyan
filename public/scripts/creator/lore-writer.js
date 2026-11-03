import { element, button, textField } from './fields.js';
import { requestCreatorReply } from './assistant.js';
import { buildCreatorLoreRequest, parseCreatorLoreProposal, acceptCreatorLoreProposal } from './lore-proposals.js';

export function renderLoreWriter(workspace, panel, book) {
    const details = element('details', 'creator-review-item creator-subdetails');
    details.append(element('summary', '', 'Write entries or extract background'));
    let instruction = '';
    let mode = 'keep';
    details.append(textField('What should the lorebook contain?', '', value => { instruction = value; }, { rows: 3 }));
    const choices = element('fieldset', 'creator-fieldset');
    choices.append(element('legend', '', 'Original character description after extraction'));
    const choiceGrid = element('div', 'creator-choice-grid');
    const group = crypto.randomUUID();
    for (const [value, title] of [['keep', 'Keep it all'], ['summarise', 'Shorten it'], ['remove', 'Remove extracted facts only']]) {
        const label = element('label', 'creator-choice-pill');
        const input = element('input'); input.type = 'radio'; input.name = group; input.value = value; input.checked = value === mode;
        input.addEventListener('change', () => { if (input.checked) mode = value; });
        label.append(input, document.createTextNode(title)); choiceGrid.append(label);
    }
    choices.append(choiceGrid);
    details.append(choices, element('p', 'creator-muted', 'The model receives public card fields and unprotected entries. Review the entries and source changes together before applying them to this draft.'));
    const reviews = element('div');
    const show = proposal => {
        const review = element('section', 'creator-review-item');
        review.append(element('h4', '', 'Proposed lorebook changes'));
        for (const item of proposal.coverage) review.append(element('p', '', item));
        const before = JSON.parse(proposal.before);
        for (const [key, entry] of Object.entries(proposal.data.entries)) {
            if (JSON.stringify(before.entries[key]) === JSON.stringify(entry)) continue;
            const change = element('details');
            change.append(element('summary', '', entry.comment || `Entry ${entry.uid}`), element('h5', '', 'Before'), element('pre', 'creator-preview', JSON.stringify(before.entries[key] ?? null, null, 2)), element('h5', '', 'After'), element('pre', 'creator-preview', JSON.stringify(entry, null, 2)));
            review.append(change);
        }
        if (proposal.sourceMode !== 'keep') {
            review.append(element('h5', '', 'Description before'), element('pre', 'creator-preview', proposal.descriptionBefore), element('h5', '', 'Description after'), element('pre', 'creator-preview', proposal.description));
        }
        const actions = element('div', 'creator-actions');
        actions.append(button('Accept entries and source choice', () => workspace.change(draft => acceptCreatorLoreProposal(draft, proposal), true), true), button('Reject proposal', () => workspace.edit(next => { next.proposals = next.proposals.filter(item => item.id !== proposal.id); }, true)));
        review.append(actions);
        reviews.append(review);
    };
    let controller;
    const cancel = button('Cancel request', () => controller?.abort()); cancel.hidden = true;
    const actionBar = element('div', 'creator-actions');
    actionBar.append(button('Propose lorebook changes', () => workspace.run(async () => {
        const draft = structuredClone(workspace.session.draft);
        const selectedMode = mode;
        const messages = buildCreatorLoreRequest(draft, book.id, instruction, selectedMode);
        controller = new AbortController(); cancel.hidden = false;
        try {
            const output = await requestCreatorReply(workspace, draft, messages, { signal: controller.signal });
            const proposal = parseCreatorLoreProposal(draft, book.id, output, selectedMode);
            if (!workspace.edit(next => { next.proposals.push(proposal); })) return;
            if (reviews.isConnected) show(proposal);
            workspace.status('Lorebook proposal saved for review. Your source background is unchanged.');
        } finally { cancel.hidden = true; }
    }), true), cancel);
    details.append(actionBar, reviews);
    for (const proposal of workspace.session.draft.proposals.filter(item => item.kind === 'lore' && item.bookId === book.id)) show(proposal);
    panel.append(details);
}
