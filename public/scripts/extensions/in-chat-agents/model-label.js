import { getShortModelName } from '../../../script.js';
import { power_user } from '../../power-user.js';

const MAIN_MODEL_LABEL = 'Main model';
const PLAIN_MODEL_ID_RE = /^(?:\[[^\]]*\]\s*)*\S+$/;

/**
 * Formats one or more model ids (comma-separated) for display, following Short Model Name in Visual Toggles.
 *
 * @param {unknown} model - Model id, or several joined by commas.
 * @returns {string} Display text, empty when no model is known
 */
export function formatAgentModelName(model) {
    return String(model ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(Boolean)
        .map(name => power_user?.timestamp_model_name_short ? getShortModelName(name) : name)
        .join(', ');
}

/**
 * Picks the model an agent result was produced with. Records saved before `model` existed keep the id in
 * `modelLabel` (server runs and model overrides); older composite labels such as 'model (Profile)' are kept as written.
 *
 * @param {{ model?: string, modelLabel?: string }} [entry] - Stored companion result or change-history entry.
 * @returns {string} Display text for the model, empty when unknown
 */
export function getAgentResultModelName(entry) {
    const model = String(entry?.model ?? '').trim();
    if (model) {
        return formatAgentModelName(model);
    }

    const legacyLabel = String(entry?.modelLabel ?? '').trim();
    if (!legacyLabel || legacyLabel === MAIN_MODEL_LABEL) {
        return '';
    }
    return PLAIN_MODEL_ID_RE.test(legacyLabel) ? formatAgentModelName(legacyLabel) : legacyLabel;
}

/**
 * Describes the model and saved connection behind an agent run, such as 'kimi-k3 (Work profile)'.
 *
 * @param {{ model?: string, modelLabel?: string, profileLabel?: string }} [entry] - Run, result or history entry.
 * @returns {string} Description, empty when neither a model nor a profile is known
 */
export function describeAgentRunModel(entry) {
    const profileLabel = String(entry?.profileLabel ?? '').trim();
    const modelName = getAgentResultModelName(entry);
    if (!modelName) {
        return profileLabel;
    }
    const hasModelId = Boolean(String(entry?.model ?? '').trim());
    return hasModelId && profileLabel && profileLabel !== MAIN_MODEL_LABEL
        ? `${modelName} (${profileLabel})`
        : modelName;
}
