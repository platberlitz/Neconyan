import { element, button, textField } from './fields.js';

const CORE = ['{{char}}', '{{user}}', '{{getvar::trust}}', '{{hasvar::trust}}', '{{random::sunny::rainy}}', '{{roll::1d20}}'];
const ENHANCED = ['{{sub}}', '{{obj}}', '{{poss}}', '{{poss_p}}', '{{ref}}', '{{charsub}}', '{{charobj}}', '{{charposs}}', '{{charposs_p}}', '{{charref}}', '{{pverb::is::are}}', '{{charpverb::is::are}}', '{{freeze::weather::{{random::sunny::rainy}}}}', '{{rollonce::luck::1d20}}'];

export function renderMacroTools(workspace, main) {
    const draft = workspace.session.draft;
    main.append(element('h3', '', 'Try macros before using them'), element('p', 'creator-muted', 'A macro is a placeholder that becomes text when a chat runs. For example, {{char}} becomes the character’s name. Paste a sentence here, choose example values, then preview the result. This is a scratch area: it does not add text to your character card or change your chat.'));
    const input = textField('Sentence to preview', draft.macroText ?? '{{char}} meets {{user}}.', value => workspace.edit(next => { next.macroText = value; }), { rows: 3, hint: 'Try {{char}} meets {{user}}. The preview below replaces those placeholders with your draft’s name and the example user name.' });
    const row = element('div', 'creator-form-grid');
    row.append(textField('Example user name', draft.macroUser ?? 'Interviewer', value => workspace.edit(next => { next.macroUser = value; }), { rows: 1 }));
    workspace.jsonField(row, 'Example local variables', draft.macroVariables ?? {}, value => {
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Use a JSON object of variable names and values.');
        workspace.edit(next => { next.macroVariables = value; });
    });
    main.append(input, row);
    for (const [title, snippets] of [['Built-in macros', CORE], ['Macro Enhanced', ENHANCED]]) {
        main.append(element('h4', '', title));
        const palette = element('div', 'creator-actions creator-chip-strip');
        for (const snippet of snippets) palette.append(button(snippet, () => {
            const field = input.querySelector('textarea');
            field.setRangeText(snippet, field.selectionStart, field.selectionEnd, 'end');
            field.dispatchEvent(new Event('input', { bubbles: true })); field.focus({ preventScroll: true });
        }, false, 'creator-chip-btn'));
        main.append(palette);
    }
    main.append(element('p', 'creator-muted', 'Macro Enhanced snippets need that extension and experimental macros enabled. Set persona and character pronouns there; unset pronouns use they/them. This core preview does not load extensions, custom macros or lore. Use the extension’s Playground to check those dependencies.'));
    const output = element('pre', 'creator-preview');
    main.append(button('Preview built-in macros', () => workspace.run(async () => {
        const current = workspace.session.draft;
        const result = await workspace.session.request('macro-preview', { text: current.macroText ?? '{{char}} meets {{user}}.', user: current.macroUser ?? 'Interviewer', character: current.card.data.name || 'Character', variables: current.macroVariables ?? {} });
        if (output.isConnected) output.textContent = result.output;
    }), true), output, element('p', 'creator-muted', 'Ask the Writing partner to make a field macro-aware. It proposes reviewed changes instead of silently replacing names or pronouns. Initialisers belong in deliberate actions; a comment removes its contents, and a zero value still exists.'));
}
