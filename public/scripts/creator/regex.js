import { sanitizeMessageHtml } from '../../script.js';
import { element, button, textField } from './fields.js';
import { creatorGuidance } from './guidance.js';
import { requestCreatorReply } from './assistant.js';

export function previewCreatorRegex(pattern, replacement, sample) {
    if ([pattern, replacement, sample].some(value => typeof value !== 'string' || value.length > 100000)) throw new Error('Keep each preview field within 100,000 characters.');
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./regex-worker.js', import.meta.url));
        const finish = (error, result) => { clearTimeout(timer); worker.terminate(); error ? reject(new Error(error)) : resolve(result); };
        const timer = setTimeout(() => finish('The pattern took too long. Simplify it before using it.'), 1000);
        worker.onmessage = ({ data }) => finish(data.error, data);
        worker.onerror = event => finish(event.message || 'The pattern could not be checked.');
        worker.postMessage({ pattern, replacement, sample });
    });
}

export function renderPrettyHtml(workspace, main) {
    const draft = workspace.session.draft;
    main.append(element('h3', '', 'Pretty HTML, with a matching text format'), element('p', 'creator-muted', 'Create character-scoped display rules. Your existing regex permissions still decide whether they run in chat. Preview keeps macros literal and never changes chat variables.'));
    let instruction = '';
    main.append(textField('Describe the display you want', '', value => { instruction = value; }, { rows: 2, hint: 'For example: a compact status card with trust, stamina and the current quest, readable on a phone.' }));
    let controller;
    const cancel = button('Cancel design', () => controller?.abort()); cancel.hidden = true;
    const designBar = element('div', 'creator-actions');
    designBar.append(button('Design a display', () => workspace.run(async () => {
        if (!instruction.trim()) throw new Error('Describe the display first.');
        const source = structuredClone(workspace.session.draft);
        controller = new AbortController(); cancel.hidden = false;
        try {
            const output = await requestCreatorReply(workspace, source, [
                { role: 'system', content: `Design one character-scoped regex display. Return only JSON {"name":"...","pattern":"/.../g","replacement":"HTML with $1 captures","sample":"example raw output","instructions":"exact output format to add to the character prompt"}. Keep the format and regex consistent. Use inline HTML/CSS, no scripts, frames, event handlers or external assets. Use var(--neco-*) theme colours with readable fallbacks, flexible widths, wrapping text and phone-safe layouts. Preserve captured text as text; avoid broad catch-all matching. Use plain class names in HTML, custom-prefixed names in any CSS selectors because chat sanitisation prefixes classes. Avoid macro evaluation in the pattern or replacement. ${creatorGuidance(source)}` },
                { role: 'user', content: instruction },
            ], { signal: controller.signal });
            const kit = JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
            if (['name', 'pattern', 'replacement', 'sample', 'instructions'].some(key => typeof kit[key] !== 'string' || kit[key].length > 100000)) throw new Error('The model returned an incomplete display. Nothing was applied.');
            workspace.edit(next => { next.displayKit = kit; }, true);
        } finally { cancel.hidden = true; }
    }), true), cancel);
    main.append(designBar);
    const kit = structuredClone(draft.displayKit ?? { name: 'Character status', pattern: '/\\[STATUS: ([^\\]]+)\\]/g', replacement: '<aside style="padding:1em;border:1px solid currentColor;border-radius:12px">$1</aside>', sample: '[STATUS: Ready to explore]', instructions: 'When status changes, append [STATUS: a short factual status].' });
    const topGrid = element('div', 'creator-form-grid');
    for (const [key, label] of [['name', 'Display title'], ['pattern', 'Find pattern']]) {
        topGrid.append(textField(label, kit[key], value => { kit[key] = value; workspace.edit(next => { next.displayKit = structuredClone(kit); }); }, { rows: 1, className: key === 'pattern' ? 'creator-mono-field' : '' }));
    }
    main.append(topGrid);
    for (const [key, label] of [['replacement', 'HTML replacement'], ['sample', 'Example raw output'], ['instructions', 'Output format instructions']]) {
        main.append(textField(label, kit[key], value => { kit[key] = value; workspace.edit(next => { next.displayKit = structuredClone(kit); }); }, { rows: 2, className: key === 'replacement' ? 'creator-mono-field' : '' }));
    }
    const preview = element('section', 'creator-display-preview');
    const actionRow = element('div', 'creator-actions');
    actionRow.append(button('Preview display', () => workspace.run(async () => {
        const result = await previewCreatorRegex(kit.pattern, kit.replacement, kit.sample);
        preview.replaceChildren(element('p', '', `${result.matches} matches. Static preview: macros, trim strings and live chat settings are not evaluated.`));
        const frame = element('iframe', 'creator-preview-frame');
        frame.title = 'Sanitised character display preview'; frame.setAttribute('sandbox', '');
        const html = sanitizeMessageHtml(result.output, {}, workspace.session.draft.card);
        frame.srcdoc = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"></head><body><div class="mes_text">${html}</div></body></html>`;
        preview.append(frame, element('pre', '', result.output));
    })), button('Add display to draft', () => workspace.run(async () => {
        const result = await previewCreatorRegex(kit.pattern, kit.replacement, kit.sample);
        if (!result.matches) throw new Error('The pattern must match your sample before adding this display.');
        if (workspace.session.draft.locks.includes('post_history_instructions')) throw new Error('Unlock post-history instructions before adding the matching output format.');
        if (!workspace.edit(next => {
            next.card.data.extensions ??= {};
            next.card.data.extensions.regex_scripts ??= [];
            next.card.data.extensions.regex_scripts.push({ id: crypto.randomUUID(), scriptName: kit.name, findRegex: kit.pattern, replaceString: kit.replacement, trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null });
            next.card.data.post_history_instructions += `\n\n${kit.instructions}`;
        }, true)) return;
        workspace.status('Display and output instructions added to the draft. Review & save publishes them; chat regex permissions still apply.');
    }), true));
    main.append(actionRow, preview);
    for (const script of draft.card.data.extensions?.regex_scripts ?? []) {
        const row = element('section', 'creator-fact');
        row.append(element('h4', '', script.scriptName || 'Unnamed display'));
        workspace.jsonField(row, 'Existing display settings', script, value => {
            if (!value || typeof value.findRegex !== 'string' || typeof value.replaceString !== 'string') throw new Error('Keep a find pattern and replacement string.');
            if (value.id !== script.id) throw new Error('Keep the existing display ID so later edits reach the same rule.');
            workspace.edit(next => {
                const index = next.card.data.extensions.regex_scripts.findIndex(item => item.id === script.id);
                if (index >= 0) next.card.data.extensions.regex_scripts[index] = value;
            });
        });
        main.append(row);
    }
}
