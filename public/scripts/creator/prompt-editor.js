import { CREATOR_PROMPTS } from './guidance.js';
import { element, button, textField } from './fields.js';

export function renderCreatorPrompts(workspace, main) {
    main.append(element('h3', '', 'Writing instructions'), element('p', 'creator-muted', 'These prompts guide Dossier conversion, the writing partner, interviews and lorebook writing. Changes belong to this draft. Card prompts stay in the Prompts section.'));
    const labels = { director: 'Director prompt', grounded: 'Grounded prose prompt', macros: 'Macro guidance prompt' };
    for (const [key, fallback] of Object.entries(CREATOR_PROMPTS)) {
        main.append(textField(labels[key], workspace.session.draft.writing?.prompts?.[key] ?? fallback, value => workspace.edit(next => {
            next.writing ??= {}; next.writing.prompts ??= {}; next.writing.prompts[key] = value;
        }), { rows: 8 }));
        main.append(button(`Reset ${labels[key].toLowerCase()}`, () => workspace.edit(next => {
            if (next.writing?.prompts) delete next.writing.prompts[key];
        }, true)));
    }
    main.append(element('p', 'creator-muted', 'Grounded prose applies in Full guidance mode. Empty prompts stay empty. Required response formats and draft permissions still apply.'));
}
