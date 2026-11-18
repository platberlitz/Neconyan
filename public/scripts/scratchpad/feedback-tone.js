/** Feedback tone choices shared by the Scratchpad page and server. */
export const FEEDBACK_TONES = Object.freeze(['nicer', 'neutral', 'harsher', 'critical']);
export const DEFAULT_FEEDBACK_TONE = 'neutral';

export function isFeedbackTone(value) {
    return FEEDBACK_TONES.includes(value);
}

export function normaliseFeedbackTone(value) {
    return isFeedbackTone(value) ? value : DEFAULT_FEEDBACK_TONE;
}

/** The tone one assistant uses: its own override, else the shared session tone. */
export function assistantFeedbackTone(settings, assistant) {
    const override = settings?.assistantTones?.[assistant];
    if (isFeedbackTone(override)) return override;
    return normaliseFeedbackTone(settings?.feedbackTone);
}
