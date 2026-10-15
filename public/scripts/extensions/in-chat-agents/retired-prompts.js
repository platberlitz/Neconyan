import { getStringHash } from '../../macro-primitives.js';

/**
 * Fingerprints of bundled prompts that a later release rewrote. A saved agent whose prompt
 * still matches one exactly was never edited, so it can take the current wording even when
 * the agent is locked against template refreshes.
 */
const RETIRED_BUNDLED_PROMPTS = Object.freeze([
    // Director's Commentary before it became a neutral, sceptical critic.
    Object.freeze({ templateId: 'tpl-directors-commentary-companion', hash: 8744971503937750, length: 823 }),
]);

/**
 * Whether a saved prompt is an unedited copy of a retired bundled prompt for the template.
 * @param {string} templateId Template the agent was created from.
 * @param {unknown} prompt Saved prompt text.
 * @returns {boolean}
 */
export function isRetiredBundledPrompt(templateId, prompt) {
    const text = String(prompt ?? '');
    return RETIRED_BUNDLED_PROMPTS.some(entry => entry.templateId === templateId
        && entry.length === text.length
        && entry.hash === getStringHash(text));
}
