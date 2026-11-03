import { element, button, textField } from './fields.js';
import { CREATOR_FORMATS, CREATOR_TENSES, CREATOR_POVS, CREATOR_CANON_MODES, CREATOR_NSFW_GUIDANCE, CREATOR_TARGET_DEFAULTS, creatorTargetValue, creatorTargetsSignature } from './formats.js';

export function renderCreatorTargets(workspace, host, { open = false } = {}) {
    const targets = workspace.session.draft.writing?.targets ?? {};
    const setTarget = (key, value, redraw = false) => workspace.edit(next => {
        next.writing ??= {};
        next.writing.targets ??= {};
        // Older drafts kept one shared length target; it now belongs to the character fields.
        if (key === 'characterWords') delete next.writing.targets.words;
        if (key === 'characterTokens') delete next.writing.targets.tokens;
        if (key in CREATOR_TARGET_DEFAULTS) {
            next.writing.targets[key] = String(value ?? '');
        } else if (value === '' || value === undefined || value === null || (key === 'tense' && value === 'unset') || (key === 'pov' && value === 'unset') || (key === 'canon' && value === 'source_only')) {
            delete next.writing.targets[key];
        } else {
            next.writing.targets[key] = value;
        }
    }, redraw);

    const details = element('details', 'creator-subdetails creator-targets-panel');
    details.open = open;
    details.append(element('summary', '', 'Length, tense and style'));
    const body = element('div', 'creator-subdetails-body');
    body.append(element('p', 'creator-muted', 'Guides Convert, Generate and the Writing partner. Lengths are rough targets, not hard limits. Clear a box to drop that target.'));

    const pillRow = (title, options, currentKey, defaultVal, key) => {
        const group = element('div', 'creator-target-group');
        group.append(element('span', 'creator-target-label', title));
        const strip = element('div', 'creator-actions creator-chip-strip');
        const selected = options[currentKey || defaultVal];
        for (const [id, item] of Object.entries(options)) {
            const btn = button(item.label, () => setTarget(key, id, true), false, 'creator-chip-btn');
            btn.setAttribute('aria-pressed', String((currentKey || defaultVal) === id));
            if (item.hint) btn.title = item.hint;
            strip.append(btn);
        }
        group.append(strip);
        if (selected?.hint) group.append(element('p', 'creator-muted', selected.hint));
        return group;
    };

    const togglesGrid = element('div', 'creator-targets-toggles');
    togglesGrid.append(
        pillRow('Narrative tense', CREATOR_TENSES, targets.tense, 'unset', 'tense'),
        pillRow('Point of view', CREATOR_POVS, targets.pov, 'unset', 'pov'),
        pillRow('Where details come from', CREATOR_CANON_MODES, targets.canon, 'source_only', 'canon'),
    );
    body.append(togglesGrid);

    const lengthGrid = element('div', 'creator-targets-grid');
    lengthGrid.append(
        textField('Description & personality words', creatorTargetValue(targets, 'characterWords'), val => setTarget('characterWords', val), { rows: 1, placeholder: 'e.g. 600-900 words' }),
        textField('Description & personality tokens', creatorTargetValue(targets, 'characterTokens'), val => setTarget('characterTokens', val), { rows: 1, placeholder: 'e.g. ~1200 tokens' }),
        textField('Greeting words', creatorTargetValue(targets, 'greetingWords'), val => setTarget('greetingWords', val), { rows: 1, placeholder: 'e.g. ~500 words each' }),
        textField('Greeting tokens', creatorTargetValue(targets, 'greetingTokens'), val => setTarget('greetingTokens', val), { rows: 1, placeholder: 'e.g. ~700 tokens each' }),
    );
    const countField = textField('Number of greetings', creatorTargetValue(targets, 'greetingCount'), val => setTarget('greetingCount', creatorTargetValue({ greetingCount: val }, 'greetingCount')), {
        rows: 1, hint: 'Whole numbers from 1 to 101; default: 1. Includes the first greeting and all alternatives. Applies when creating greetings, not when editing just one.',
    });
    const countInput = countField.querySelector('textarea, input');
    countInput.inputMode = 'numeric';
    countInput.addEventListener('blur', () => { countInput.value = creatorTargetValue(workspace.session.draft.writing?.targets, 'greetingCount'); });
    body.append(countField, lengthGrid, textField('Paragraph target', creatorTargetValue(targets, 'paragraphs'), val => setTarget('paragraphs', val), { rows: 1, placeholder: 'e.g. 3-5 paragraphs' }));

    const taskGrid = element('div', 'creator-form-grid');
    taskGrid.append(
        textField('ALIchat questions', creatorTargetValue(targets, 'interviewQuestions'), val => setTarget('interviewQuestions', val), { rows: 1, placeholder: 'e.g. 5-10 questions' }),
        textField('PList categories', creatorTargetValue(targets, 'plistCategories'), val => setTarget('plistCategories', val), { rows: 1, placeholder: 'e.g. persona, body, quirks' }),
    );
    body.append(taskGrid);
    body.append(textField('What each greeting should do', creatorTargetValue(targets, 'openingScenarios'), val => setTarget('openingScenarios', val), { rows: 2, placeholder: 'e.g. 4 everyday scenarios grounded in routine, varied emotional arcs, sensation-first hooks' }));

    body.append(button('Reset lengths and lists to defaults', () => workspace.edit(next => {
        for (const key of [...Object.keys(CREATOR_TARGET_DEFAULTS), 'words', 'tokens']) delete next.writing?.targets?.[key];
    }, true), false, 'creator-chip-btn'));

    const nsfw = workspace.session.draft.writing?.nsfw ?? {};
    const nsfwGroup = element('div', 'creator-target-group');
    nsfwGroup.append(element('span', 'creator-target-label', 'NSFW instructions'));
    const nsfwStrip = element('div', 'creator-actions creator-chip-strip');
    for (const [enabled, label] of [[false, 'Off'], [true, 'On']]) {
        const choice = button(label, () => workspace.edit(next => {
            next.writing ??= {};
            next.writing.nsfw = { ...next.writing.nsfw, enabled };
        }, true), false, 'creator-chip-btn');
        choice.setAttribute('aria-pressed', String(Boolean(nsfw.enabled) === enabled));
        nsfwStrip.append(choice);
    }
    nsfwGroup.append(nsfwStrip);
    body.append(nsfwGroup);
    if (nsfw.enabled) {
        const field = textField('NSFW instructions for descriptions and greetings', typeof nsfw.instruction === 'string' ? nsfw.instruction : CREATOR_NSFW_GUIDANCE, val => workspace.edit(next => {
            next.writing.nsfw = { ...next.writing.nsfw, instruction: val };
        }), { rows: 5, hint: 'Based on the Director preset’s NSFW Mode. Sent only while this is on, and kept private to this draft.' });
        const reset = button('Reset default', () => workspace.edit(next => {
            if (next.writing?.nsfw) delete next.writing.nsfw.instruction;
        }, true), false, 'creator-chip-btn');
        reset.setAttribute('aria-label', 'Reset NSFW instructions');
        field.querySelector('.creator-field-heading')?.append(reset);
        const fetishes = textField('Fetishes to focus on (greetings only)', nsfw.fetishes ?? '', val => workspace.edit(next => {
            next.writing ??= {};
            next.writing.nsfw = { ...next.writing.nsfw, fetishes: val };
        }), {
            rows: 2,
            placeholder: 'e.g. sloppy kissing, body worship, cockwarming, oral sex',
            hint: 'Applied only to first and alternate greetings when NSFW instructions are on. Never added to description, personality, Character’s Note or lorebooks.',
        });
        body.append(field, fetishes);
    }

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
            const proposal = dossierProposal(source, output, request.fields);
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
    group.append(textField('Custom writing format instructions', workspace.session.draft.writing?.formatInstruction ?? '', value => workspace.edit(next => {
        next.writing ??= {}; next.writing.formatInstruction = value;
    }), { rows: 2, hint: 'Add your own structure, formatting and style rules. Used alongside the selected format; kept private to this draft.' }));
    if (workspace.session.draft.style === 'plist') {
        const destinations = element('div', 'creator-actions');
        destinations.append(element('span', 'creator-muted', 'Place the PList in:'));
        for (const [id, label] of [['description', 'Description'], ['depth_prompt', 'Character’s Note']]) {
            const choice = button(label, () => workspace.edit(next => {
                next.writing ??= {}; next.writing.plistDestination = id;
            }, true), false, 'creator-chip-btn');
            choice.setAttribute('aria-pressed', String((workspace.session.draft.writing?.plistDestination ?? 'description') === id));
            destinations.append(choice);
        }
        group.append(destinations, element('p', 'creator-muted', 'Applies when converting the Dossier or existing description, or requesting description changes from the Writing partner. Character’s Note is the depth prompt on the Prompts page. Existing text changes only after review.'));
    }
    renderCreatorTargets(workspace, group, { open: false });
    main.append(group);
}
