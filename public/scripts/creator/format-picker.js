import { element, button, textField } from './fields.js';
import { CREATOR_FORMATS, CREATOR_TENSES, CREATOR_POVS, CREATOR_CANON_MODES, CREATOR_NSFW_GUIDANCE, CREATOR_TARGET_DEFAULTS, creatorTargetValue } from './formats.js';

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
    const row = element('div', 'creator-choice-grid creator-choice-grid--formats');
    const current = workspace.session.draft.style || 'plain';
    for (const [id, format] of Object.entries(CREATOR_FORMATS)) {
        const label = element('label', 'creator-choice-pill');
        const radio = element('input');
        radio.type = 'radio';
        radio.name = 'creator-format';
        radio.value = id;
        radio.checked = current === id;
        radio.addEventListener('change', () => workspace.edit(next => { next.style = id; }, true));
        label.title = format.hint;
        label.append(radio, element('span', 'creator-choice-label', format.label));
        if (id !== 'purachina') {
            row.append(label);
            continue;
        }
        const wrap = element('span', 'creator-format-info');
        const toggle = element('button', 'creator-info-btn', '?');
        toggle.type = 'button';
        toggle.setAttribute('aria-label', 'What is purachina’s recommended?');
        toggle.setAttribute('aria-controls', 'creator-recommended-help');
        toggle.setAttribute('aria-expanded', 'false');
        const tip = element('span', 'creator-info-tip');
        tip.id = 'creator-recommended-help';
        tip.setAttribute('role', 'tooltip');
        tip.hidden = true;
        tip.append(element('strong', '', 'purachina’s recommended'), element('span', '', 'Description is an interview, with the character answering in their own voice. A short, square-bracketed profile goes in Character’s Note. Personality and Scenario stay brief, and greetings use third-person, present-tense narration with the character’s real name.'));
        const close = () => {
            tip.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
            document.removeEventListener('pointerdown', outside, true);
        };
        const outside = event => { if (!wrap.contains(event.target) || !wrap.isConnected) close(); };
        toggle.addEventListener('click', event => {
            event.stopPropagation();
            if (!tip.hidden) return close();
            tip.hidden = false;
            toggle.setAttribute('aria-expanded', 'true');
            const bounds = (wrap.closest('fieldset') ?? wrap).getBoundingClientRect();
            const anchor = wrap.getBoundingClientRect();
            const center = toggle.getBoundingClientRect().left + toggle.offsetWidth / 2;
            const width = tip.offsetWidth;
            const left = Math.max(bounds.left + 8, Math.min(center - 24, bounds.right - 8 - width));
            tip.style.insetInlineStart = `${Math.round(left - anchor.left)}px`;
            tip.style.setProperty('--creator-tip-arrow', `${Math.round(center - left)}px`);
            document.addEventListener('pointerdown', outside, true);
        });
        wrap.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !tip.hidden) {
                close();
                toggle.focus();
                event.stopPropagation();
            }
        });
        wrap.append(label, toggle, tip);
        row.append(wrap);
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
            const { buildCreatorWritingRequest } = await import('./assistant.js');
            const { startCreatorWriting } = await import('./conversion.js');
            const instruction = 'Convert the selected existing fields to the selected writing format. Preserve every established fact, literal macro, secret boundary and meaningful voice detail. Do not add new facts. In coverage, identify what was kept, reworded or omitted; questions must identify anything that cannot be converted faithfully.';
            const request = buildCreatorWritingRequest(source, instruction, fields);
            convert.disabled = true; cancel.hidden = false; controller = new AbortController();
            feedback.textContent = 'Converting existing text. Your fields stay unchanged until you accept the proposal.';
            const proposal = startCreatorWriting(source, request, `${CREATOR_FORMATS[source.style]?.label || 'Natural description'} conversion`);
            if (!workspace.edit(next => { next.proposals.push(proposal); })) return;
            await workspace.continueWriting(proposal.id, controller.signal);
            feedback.textContent = workspace.message;
        } catch (error) {
            feedback.hidden = false;
            feedback.textContent = error?.message || String(error);
            throw error;
        } finally { convert.disabled = false; cancel.hidden = true; }
    }), false, 'creator-chip-btn');
    const convertActions = element('div', 'creator-actions');
    convertActions.append(convert, cancel);
    group.append(row, convertActions, element('p', 'creator-muted', 'Used by Dossier conversion, Generate and the Writing partner. Choosing a format does not replace existing text.'), feedback);
    group.append(textField('Custom writing format instructions', workspace.session.draft.writing?.formatInstruction ?? '', value => workspace.edit(next => {
        next.writing ??= {}; next.writing.formatInstruction = value;
    }), { rows: 2, hint: workspace.session.draft.style === 'custom' ? 'Your only writing format. Built-in formats, prose guidance and style targets are omitted. The greeting count and required response structure still apply. Kept private to this draft.' : 'Add your own structure, formatting and style rules. Choose Custom to use these alone; otherwise they accompany the selected format. Kept private to this draft.' }));
    if (workspace.session.draft.style === 'plist') {
        const destinations = element('div', 'creator-choice-subgroup');
        destinations.append(element('span', 'creator-choice-subheading', 'Place the PList in'));
        const destinationGrid = element('div', 'creator-choice-grid creator-choice-grid--pair');
        for (const [id, label] of [['description', 'Description'], ['depth_prompt', 'Character’s Note']]) {
            const choice = element('label', 'creator-choice-pill');
            const radio = element('input');
            radio.type = 'radio';
            radio.name = 'creator-plist-destination';
            radio.value = id;
            radio.checked = (workspace.session.draft.writing?.plistDestination ?? 'description') === id;
            radio.addEventListener('change', () => workspace.edit(next => {
                next.writing ??= {}; next.writing.plistDestination = id;
            }, true));
            choice.append(radio, element('span', 'creator-choice-label', label));
            destinationGrid.append(choice);
        }
        destinations.append(destinationGrid);
        group.append(destinations, element('p', 'creator-muted', 'Applies when converting the Dossier or existing description, or requesting description changes from the Writing partner. Character’s Note is the depth prompt on the Prompts page. Existing text changes only after review.'));
    }
    renderCreatorTargets(workspace, group, { open: false });
    main.append(group);
}
