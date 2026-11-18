import { t } from '../i18n.js';
import { h } from '../notebooks/dom.js';
import { FEEDBACK_TONES, normaliseFeedbackTone } from './feedback-tone.js';

export function feedbackToneLabel(tone) {
    switch (normaliseFeedbackTone(tone)) {
        case 'nicer': return t`Nicer`;
        case 'harsher': return t`Harsher`;
        case 'critical': return t`Unreasonably critical`;
        default: return t`Neutral`;
    }
}

export function feedbackToneDescription(tone) {
    switch (normaliseFeedbackTone(tone)) {
        case 'nicer': return t`Encouraging. Leads with what works and suggests one or two gentle fixes.`;
        case 'harsher': return t`Blunt. Leads with the biggest problem and holds the work to a professional standard.`;
        case 'critical': return t`Impossible to please, played for laughs. Every complaint still comes with a real fix.`;
        default: return t`Each assistant's usual honest feedback.`;
    }
}

/**
 * A four-stop range for the feedback tone. Dragging previews the label; letting go (or a key press, or a tap on a stop
 * name) commits through onChange. The returned element has setTone(tone) and setDisabled(disabled) for redraws.
 */
export function feedbackToneSlider({ id, tone, onChange, compact = false, describe = false }) {
    const range = h('input', {
        id,
        type: 'range',
        class: 'scratchpad-tone-range',
        min: '0',
        max: String(FEEDBACK_TONES.length - 1),
        step: '1',
        'aria-describedby': describe ? `${id}-description` : null,
    });
    const current = h('output', { class: 'scratchpad-tone-value', for: id, 'aria-live': 'polite' });
    const description = describe ? h('p', { id: `${id}-description`, class: 'scratchpad-muted scratchpad-tone-description' }) : null;
    let committed = normaliseFeedbackTone(tone);

    const show = value => {
        range.value = String(FEEDBACK_TONES.indexOf(value));
        range.setAttribute('aria-valuetext', feedbackToneLabel(value));
        range.style.setProperty('--tone-fill', `${(FEEDBACK_TONES.indexOf(value) / (FEEDBACK_TONES.length - 1)) * 100}%`);
        current.textContent = feedbackToneLabel(value);
        if (description) description.textContent = feedbackToneDescription(value);
        for (const stop of stops) stop.classList.toggle('is-selected', stop.dataset.tone === value);
        root.dataset.tone = value;
    };
    const commit = value => {
        show(value);
        if (value === committed) return;
        committed = value;
        onChange(value);
    };
    const stops = compact ? [] : FEEDBACK_TONES.map(value => h('button', {
        type: 'button',
        class: 'scratchpad-tone-stop',
        // The range is the accessible control; the names are a larger pointer target for the same stops.
        tabindex: '-1',
        'aria-hidden': 'true',
        dataset: { tone: value },
        text: feedbackToneLabel(value),
        onclick: () => {
            if (!range.disabled) commit(value);
        },
    }));

    range.addEventListener('input', () => show(FEEDBACK_TONES[Number(range.value)] ?? committed));
    range.addEventListener('change', () => commit(FEEDBACK_TONES[Number(range.value)] ?? committed));

    const root = h('div', { class: `scratchpad-tone${compact ? ' is-compact' : ''}` },
        h('div', { class: 'scratchpad-tone-head' },
            h('label', { for: id, class: 'scratchpad-tone-label', text: t`Feedback tone` }),
            current),
        range,
        stops.length ? h('div', { class: 'scratchpad-tone-stops' }, stops) : null,
        description);
    root.setTone = value => {
        committed = normaliseFeedbackTone(value);
        show(committed);
    };
    root.setDisabled = disabled => {
        range.disabled = Boolean(disabled);
        root.classList.toggle('is-disabled', Boolean(disabled));
    };
    show(committed);
    return root;
}
