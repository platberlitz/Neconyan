import { creatorPublicationCard } from './embedded-book.js';
import { element, button } from './fields.js';

export function creatorCardExport(draft) {
    return creatorPublicationCard(draft, { ccv3: true });
}

export function downloadCreatorJson(value, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = element('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderCreatorPreview(workspace, main) {
    const draft = workspace.session.draft;
    const card = creatorCardExport(draft);
    main.append(element('h3', '', 'What leaves your draft'), element('p', 'creator-muted', 'The card contains the public fields below, its extensions and its portable lorebook. Your dossier, private notes, interview and draft history stay in Catelier. Linked book files and additional local links are not bundled into a character JSON file.'));
    const count = element('p', 'creator-muted', 'Count tokens using your selected tokenizer when you need an estimate. This is not a complete chat prompt.');
    const actionBar = element('div', 'creator-actions');
    actionBar.append(
        button('Download character JSON', () => downloadCreatorJson(card, 'character.json'), true),
        button('Count public text tokens', () => workspace.run(async () => {
            const { getTokenCountAsync } = await import('../tokenizers.js');
            const text = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'].map(field => card.data[field] ?? '').join('\n');
            const tokens = await getTokenCountAsync(text);
            if (count.isConnected) count.textContent = `${text.length.toLocaleString()} characters · approximately ${tokens.toLocaleString()} tokens in these public text fields.`;
        })),
    );
    main.append(actionBar, count);
    const backup = element('details', 'creator-review-item creator-subdetails');
    backup.append(element('summary', '', 'Private draft backup'), element('p', 'creator-muted', 'This backup includes your dossier, private notes, portrait candidates, proposals and history. Keep it private.'), button('Download private draft backup', () => downloadCreatorJson({ format: 'neconyan-creator-backup', version: 1, draft: workspace.session.draft }, 'creator-private-draft.json')));
    main.append(backup);
    const display = element('pre', 'creator-preview'); display.textContent = JSON.stringify(card, null, 2);
    main.append(display);
}
