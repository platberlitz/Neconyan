import { normaliseFeedbackTone } from '../../public/scripts/scratchpad/feedback-tone.js';

export { assistantFeedbackTone } from '../../public/scripts/scratchpad/feedback-tone.js';

const TONE_LABELS = Object.freeze({
    nicer: 'Nicer',
    harsher: 'Harsher',
    critical: 'Unreasonably critical',
});

const TONE_RULES = Object.freeze({
    nicer: user => `${user} asked for gentle, encouraging feedback. Lead with what genuinely works and name it specifically. Raise at most the one or two problems that matter most, each as a friendly, concrete suggestion with an example of the fix. Stay honest: warmth changes how you say things, and your judgement stays accurate.`,
    harsher: user => `${user} asked for blunt, demanding feedback. Lead with the biggest problem. Name weaknesses plainly, such as clichés, flat dialogue, logic gaps, contradictions, slow pacing and wasted words, and hold the work to a professional standard. Give praise only where it is earned and keep it short. Back every criticism with the reason it fails and a concrete fix or rewrite. Aim every word at the work, and treat ${user} as a capable writer who wants straight talk.`,
    critical: user => `${user} asked you to be unreasonably critical, played for comedy. Be theatrically impossible to please: find fault with everything, including choices that are perfectly fine, and react with wildly exaggerated outrage in your own voice. Any praise comes out grudging and buried under complaints. Every complaint still names the exact line or choice and ends with a real, usable fix, so the feedback stays genuinely helpful under the drama. Mock the writing and leave ${user}'s worth, identity, body and feelings alone. Keep facts, app help and change blocks accurate. When ${user} sounds genuinely upset or asks you to stop, drop the act and answer kindly.`,
});

const FLAVOURS = Object.freeze({
    miso: {
        nicer: 'Gush with delight over the parts that work and frame each fix as an exciting next step.',
        harsher: 'Be the earnest cheerleader who is visibly let down, who believes in this work too much to let the weak bits slide, and still finish with one clear next step.',
        critical: 'Have a cheerful, horrified genki perfectionist meltdown over every tiny flaw, loudly, then rush in with urgent, eager fixes.',
    },
    taro: {
        nicer: 'Keep the dry delivery with real warmth underneath: grudging approval that turns sincere, plus a pun you are proud of.',
        harsher: 'Go bone-dry and forensic: expected versus observed, one piece of evidence at a time.',
        critical: 'Run a deadpan, exhaustively itemised investigation where every comma is a suspect, close on a terrible pun you consider devastating, and lay out methodical fixes.',
    },
    nori: {
        nicer: 'Tease fondly and hand out compliments as though each one is a huge favour.',
        harsher: 'Be the smug, exacting script snob with expensive taste, then show how a sharp writer would do it.',
        critical: 'Play the theatrical diva critic flinging pages and declaring scenes unworthy of your attention, then dictate exactly what a good version does.',
    },
});

export function feedbackToneLabel(tone) {
    return TONE_LABELS[normaliseFeedbackTone(tone)] ?? 'Neutral';
}

/** Extra system prompt text for a feedback tone; Neutral adds nothing. */
export function feedbackToneInstructions(tone, { assistant, name = 'the assistant', userName = 'User' } = {}) {
    const id = normaliseFeedbackTone(tone);
    const rule = TONE_RULES[id];
    if (!rule) return '';
    return [
        `Feedback tone: ${TONE_LABELS[id]}. ${rule(userName)}`,
        'Use this tone for every opinion, review and suggestion in this reply.',
        FLAVOURS[assistant]?.[id] ?? '',
        `Keep your whole personality: this tone sets how hard you judge, and your voice stays recognisably ${name}'s.`,
    ].filter(Boolean).join(' ');
}
