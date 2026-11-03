import { element, button, textField } from './fields.js';
import { requestCreatorReply } from './assistant.js';
import { buildCreatorLoreRequest, parseCreatorLoreProposal, acceptCreatorLoreProposal } from './lore-proposals.js';

export function renderLoreWriter(workspace, panel, book) {
    const details = element('details', 'creator-review-item creator-subdetails');
    details.append(element('summary', '', 'Create entries from Dossier or character'));
    const bracketLabel = element('label', 'creator-choice-pill');
    const bracketInput = element('input');
    bracketInput.type = 'checkbox';
    bracketInput.checked = workspace.session.draft.writing?.loreBrackets !== false;
    bracketInput.addEventListener('change', () => workspace.edit(next => { next.writing ??= {}; next.writing.loreBrackets = bracketInput.checked; }));
    bracketLabel.append(bracketInput, document.createTextNode('Wrap new entry content in square brackets'));
    details.append(bracketLabel);
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
    details.append(choices, element('p', 'creator-muted', 'Create entries from Dossier sends your Dossier and keeps it intact. Propose lorebook changes uses your character fields and the description choice above. Both include unprotected entries for context. Review titles, keywords and content before applying.'));
    const reviews = element('div');
    const show = proposal => {
        const review = element('section', 'creator-review-item');
        review.append(element('h4', '', 'Proposed lorebook changes'));
        for (const item of proposal.coverage) review.append(element('p', '', item));
        const before = JSON.parse(proposal.before);
        for (const [key, entry] of Object.entries(proposal.data.entries)) {
            if (JSON.stringify(before.entries[key]) === JSON.stringify(entry)) continue;
            const change = element('details');
            change.open = true;
            change.append(element('summary', '', entry.comment || `Entry ${entry.uid}`));
            if (before.entries[key]) change.append(element('h5', '', 'Previous content'), element('pre', 'creator-preview', before.entries[key].content));
            const save = () => workspace.edit(next => {
                const stored = next.proposals.find(item => item.id === proposal.id);
                if (stored) stored.data = structuredClone(proposal.data);
            });
            change.append(textField('Entry title', entry.comment, value => { entry.comment = value; save(); }),
                textField('Activation keywords, one per line', entry.key.join('\n'), value => { entry.key = value.split('\n').map(key => key.trim()).filter(Boolean); save(); }),
                textField('Entry content', entry.content, value => { entry.content = value; save(); }, { rows: 8 }));
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
    const feedback = element('p', 'creator-muted');
    feedback.setAttribute('role', 'status');
    actionBar.append(button('Create entries from Dossier', () => workspace.run(async () => {
        const draft = structuredClone(workspace.session.draft);
        controller = new AbortController(); cancel.hidden = false;
        try {
            const messages = buildCreatorLoreRequest(draft, book.id, instruction || 'Extract useful setting, people, places and background from the Dossier. Generate precise activation keywords.', 'keep', 'dossier');
            feedback.textContent = 'Creating entries and keywords from the Dossier…';
            const output = await requestCreatorReply(workspace, draft, messages, { signal: controller.signal });
            const proposal = parseCreatorLoreProposal(draft, book.id, output, 'keep', 'dossier');
            acceptCreatorLoreProposal(workspace.session.draft, proposal);
            if (!workspace.edit(next => { next.proposals.push(proposal); })) return;
            if (reviews.isConnected) show(structuredClone(proposal));
            feedback.textContent = 'Review the titles, keywords and content before accepting.';
        } catch (error) { feedback.textContent = error.message || String(error); throw error; } finally { cancel.hidden = true; }
    }), true));
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
    details.append(actionBar, feedback, reviews);
    for (const proposal of workspace.session.draft.proposals.filter(item => item.kind === 'lore' && item.bookId === book.id)) show(structuredClone(proposal));
    panel.append(details);
}
