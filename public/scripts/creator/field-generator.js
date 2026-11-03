import { element, button, textField } from './fields.js';
import { requestCreatorReply } from './assistant.js';
import { buildCreatorFieldRequest, acceptCreatorField } from './field-generation.js';

export function attachCreatorGenerator(workspace, node, target) {
    let controller;
    const feedback = element('p', 'creator-muted');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    const cancel = button('Cancel', () => controller?.abort(), false, 'creator-chip-btn');
    cancel.hidden = true;
    const generate = button('Generate', () => workspace.run(async () => {
        try {
            feedback.hidden = false;
            if (workspace.session.pending || workspace.session.publishing) throw new Error('Finish saving before generating.');
            const source = structuredClone(workspace.session.draft);
            const messages = buildCreatorFieldRequest(source, target);
            controller = new AbortController(); generate.disabled = true; cancel.hidden = false;
            feedback.textContent = 'Generating a suggestion…';
            const output = await requestCreatorReply(workspace, source, messages, { signal: controller.signal });
            const parsed = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
            // Validate against the current draft before showing, and again when accepted.
            acceptCreatorField(workspace.session.draft, source, target, parsed.value);
            if (!node.isConnected) { workspace.status('The field page changed. Generate again on that page.'); return; }
            node.querySelector('.creator-generated-field')?.remove();
            const review = element('section', 'creator-review-item creator-generated-field');
            let value = parsed.value;
            review.append(textField('Generated suggestion', value, text => { value = text; }),
                button('Use suggestion', () => workspace.change(current => acceptCreatorField(current, source, target, value), true), true, 'creator-chip-btn'),
                button('Discard suggestion', () => review.remove(), false, 'creator-chip-btn'));
            node.append(review);
            feedback.textContent = 'Suggestion ready. Review it before applying.';
        } catch (error) {
            feedback.textContent = error?.message || String(error);
            throw error;
        } finally { generate.disabled = false; cancel.hidden = true; }
    }), false, 'creator-chip-btn');
    generate.setAttribute('aria-label', `Generate ${node.querySelector('label')?.textContent || target}`);
    generate.title = 'Generate from your Dossier and this field. Review the suggestion before replacing the text.';
    generate.disabled = workspace.session.draft.locks.includes(target.split(':')[0]);
    if (generate.disabled) generate.title = 'Unlock this field to generate a suggestion.';
    node.querySelector('.creator-field-heading').append(generate, cancel);
    node.append(feedback);
    return node;
}
