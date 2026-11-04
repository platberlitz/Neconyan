import { element, textField } from './fields.js';

/** Ephemeral output, never written into the draft or used as a proposal before completion. */
export function renderCreatorLiveReply(workspace, main) {
    main.querySelector('[data-creator-live-reply]')?.remove();
    const reply = workspace.liveReply;
    if (!reply || reply.draftId !== workspace.session.draft?.id) return;
    const panel = element('details', 'creator-fieldset');
    panel.dataset.creatorLiveReply = '';
    panel.open = true;
    panel.append(element('summary', '', 'Live model output'));
    const status = element('p', 'creator-muted', reply.status);
    status.dataset.creatorLiveStatus = '';
    status.setAttribute('role', 'status');
    panel.append(status);
    for (const [key, label] of [['reasoning', 'Model reasoning'], ['text', 'Model reply']]) {
        const field = textField(label, reply[key], () => {}, { rows: key === 'text' ? 8 : 4 });
        const input = field.querySelector('textarea');
        input.readOnly = true;
        input.dataset.creatorLiveField = key;
        field.hidden = key === 'reasoning' && !reply.reasoning;
        panel.append(field);
    }
    // Streaming output leads the section so it stays visible while the model writes.
    main.prepend(panel);
}

export function updateCreatorLiveReply(workspace, change) {
    if (change.draftId) workspace.liveReply = { ...change };
    else if (workspace.liveReply) Object.assign(workspace.liveReply, change);
    const reply = workspace.liveReply;
    if (!reply || reply.draftId !== workspace.session.draft?.id) return;
    const main = workspace.host?.querySelector('.creator-content');
    if (!main) return;
    if (!main.querySelector('[data-creator-live-reply]')) renderCreatorLiveReply(workspace, main);
    main.querySelector('[data-creator-live-status]').textContent = reply.status;
    for (const input of main.querySelectorAll('[data-creator-live-field]')) {
        const following = input.scrollTop + input.clientHeight >= input.scrollHeight - 24;
        input.value = reply[input.dataset.creatorLiveField] || '';
        input.closest('.creator-field').hidden = input.dataset.creatorLiveField === 'reasoning' && !input.value;
        if (following) input.scrollTop = input.scrollHeight;
        input.dispatchEvent(new Event('creator-output'));
    }
}
