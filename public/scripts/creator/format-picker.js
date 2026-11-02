import { element, button, textField } from './fields.js';
import { CREATOR_FORMATS, CREATOR_TENSES, CREATOR_POVS, CREATOR_CANON_MODES, creatorTargetsSignature } from './formats.js';

export function renderCreatorTargets(workspace, host, { open = false } = {}) {
    const targets = workspace.session.draft.writing?.targets ?? {};
    const setTarget = (key, value, redraw = false) => workspace.edit(next => {
        next.writing ??= {};
        next.writing.targets ??= {};
        if (value === '' || value === undefined || value === null || (key === 'tense' && value === 'unset') || (key === 'pov' && value === 'unset') || (key === 'canon' && value === 'source_only')) {
            delete next.writing.targets[key];
        } else {
            next.writing.targets[key] = value;
        }
    }, redraw);

    const details = element('details', 'creator-subdetails creator-targets-panel');
    details.open = open;
    details.append(element('summary', '', 'Conversion targets & style'));
    const body = element('div', 'creator-subdetails-body');
    body.append(element('p', 'creator-muted', 'Approximate writing targets for Dossier conversion, per-field generation and Writing partner requests. Unset fields leave length and style open; provider output token limits still apply separately.'));

    const pillRow = (title, options, currentKey, defaultVal, key) => {
        const group = element('div', 'creator-target-group');
        group.append(element('span', 'creator-target-label', title));
        const strip = element('div', 'creator-actions creator-chip-strip');
        for (const [id, item] of Object.entries(options)) {
            const btn = button(item.label, () => setTarget(key, id, true), false, 'creator-chip-btn');
            btn.setAttribute('aria-pressed', String((currentKey || defaultVal) === id));
            strip.append(btn);
        }
        group.append(strip);
        return group;
    };

    const togglesGrid = element('div', 'creator-targets-toggles');
    togglesGrid.append(
        pillRow('Narrative tense', CREATOR_TENSES, targets.tense, 'unset', 'tense'),
        pillRow('Narrative POV', CREATOR_POVS, targets.pov, 'unset', 'pov'),
        pillRow('Canon supplementation', CREATOR_CANON_MODES, targets.canon, 'source_only', 'canon'),
    );
    body.append(togglesGrid);

    const lengthGrid = element('div', 'creator-targets-grid');
    lengthGrid.append(
        textField('Word target', targets.words ?? '', val => setTarget('words', val), { rows: 1, placeholder: 'e.g. 2500-4000 words' }),
        textField('Paragraph target', targets.paragraphs ?? '', val => setTarget('paragraphs', val), { rows: 1, placeholder: 'e.g. 3-5 paragraphs' }),
        textField('Approximate token target', targets.tokens ?? '', val => setTarget('tokens', val), { rows: 1, placeholder: 'e.g. ~1200 tokens' }),
    );
    body.append(lengthGrid);

    const taskGrid = element('div', 'creator-form-grid');
    taskGrid.append(
        textField('Interview question count', targets.interviewQuestions ?? '', val => setTarget('interviewQuestions', val), { rows: 1, placeholder: 'e.g. 5-10 questions' }),
        textField('PList category focus', targets.plistCategories ?? '', val => setTarget('plistCategories', val), { rows: 1, placeholder: 'e.g. persona, body, quirks' }),
    );
    body.append(taskGrid);
    body.append(textField('Opening scenario mix', targets.openingScenarios ?? '', val => setTarget('openingScenarios', val), { rows: 2, placeholder: 'e.g. 4 everyday scenarios grounded in routine, varied emotional arcs, sensation-first hooks' }));

    details.append(body);
    host.append(details);
}

export function renderCreatorFormat(workspace, main) {
    const group = element('fieldset', 'creator-fieldset creator-format-box');
    group.append(element('legend', '', 'Character writing format'));
    const topBar = element('div', 'creator-format-bar');
    const row = element('div', 'creator-actions creator-chip-strip');
    for (const [id, format] of Object.entries(CREATOR_FORMATS)) {
        const choice = button(format.label, () => workspace.edit(next => { next.style = id; }, true), false, 'creator-chip-btn');
        choice.setAttribute('aria-pressed', String((workspace.session.draft.style || 'plain') === id));
        choice.title = format.hint;
        row.append(choice);
    }
    const feedback = element('p', 'creator-muted creator-inline-status');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    let controller;
    const cancel = button('Cancel conversion', () => controller?.abort(), false, 'creator-chip-btn');
    cancel.hidden = true;
    const convert = button('Review conversion of existing text', () => workspace.run(async () => {
        try {
            feedback.hidden = false;
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
            proposal.targetsBefore = creatorTargetsSignature(source);
            proposal.label = `${CREATOR_FORMATS[source.style]?.label || 'Natural description'} conversion`;
            workspace.proposal(proposal);
            feedback.textContent = 'Conversion ready for review.';
        } catch (error) {
            feedback.hidden = false;
            feedback.textContent = error?.message || String(error);
            throw error;
        } finally { convert.disabled = false; cancel.hidden = true; }
    }), false, 'creator-chip-btn');
    const convertActions = element('div', 'creator-actions');
    convertActions.append(convert, cancel);
    topBar.append(row, convertActions);
    group.append(topBar, element('p', 'creator-muted', 'Used by Dossier conversion, Generate and the Writing partner. Choosing a format does not replace existing text.'), feedback);
    renderCreatorTargets(workspace, group, { open: false });
    main.append(group);
}
