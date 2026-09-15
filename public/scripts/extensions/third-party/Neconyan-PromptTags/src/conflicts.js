// Defaults as shipped in openai.js (default_wi_format / default_personality_format /
// default_scenario_format). A non-default value means the section already carries a wrapper,
// so adding tags on top of it would nest them.
export const DEFAULT_WI_FORMAT = '{0}';
export const DEFAULT_PERSONALITY_FORMAT = '{{personality}}';
export const DEFAULT_SCENARIO_FORMAT = '{{scenario}}';

export const FIX_WI_FORMAT = 'wi_format';
export const FIX_PERSONALITY_FORMAT = 'personality_format';
export const FIX_SCENARIO_FORMAT = 'scenario_format';

/**
 * Finds settings that would double-wrap a section this profile already tags.
 *
 * @param {{wiFormat: string, personalityFormat: string, scenarioFormat: string,
 *          storyString: string, rules: Record<string, object>}} input
 * @returns {Array<{id: string, message: string, fix: string|null}>}
 */
export function detectConflicts(input) {
    const { rules = {} } = input;
    const found = [];
    const on = id => !!rules[id]?.enabled;

    if ((on('worldInfoBefore') || on('worldInfoAfter')) && String(input.wiFormat ?? DEFAULT_WI_FORMAT) !== DEFAULT_WI_FORMAT) {
        found.push({
            id: FIX_WI_FORMAT,
            message: 'World Info Format already adds formatting. Prompt Tags would create nested wrappers.',
            fix: FIX_WI_FORMAT,
            currentValue: String(input.wiFormat ?? ''),
        });
    }

    if (on('charPersonality') && String(input.personalityFormat ?? DEFAULT_PERSONALITY_FORMAT) !== DEFAULT_PERSONALITY_FORMAT) {
        found.push({
            id: FIX_PERSONALITY_FORMAT,
            message: 'Personality Format already adds formatting. Prompt Tags would create nested wrappers.',
            fix: FIX_PERSONALITY_FORMAT,
            currentValue: String(input.personalityFormat ?? ''),
        });
    }

    if (on('scenario') && String(input.scenarioFormat ?? DEFAULT_SCENARIO_FORMAT) !== DEFAULT_SCENARIO_FORMAT) {
        found.push({
            id: FIX_SCENARIO_FORMAT,
            message: 'Scenario Format already adds formatting. Prompt Tags would create nested wrappers.',
            fix: FIX_SCENARIO_FORMAT,
            currentValue: String(input.scenarioFormat ?? ''),
        });
    }

    const storyString = String(input.storyString ?? '');
    if (/^\s*#{1,6}\s+\S/m.test(storyString)) {
        found.push({
            id: 'story_string_headers',
            message: 'The context template adds Markdown headings. Tagged sections will remain inside them.',
            fix: null,
        });
    }

    return found;
}

/** Reads the live values and reports what currently conflicts. */
export function detectLiveConflicts(rules) {
    const ctx = SillyTavern.getContext();
    return detectConflicts({
        wiFormat: ctx.chatCompletionSettings?.wi_format,
        personalityFormat: ctx.chatCompletionSettings?.personality_format,
        scenarioFormat: ctx.chatCompletionSettings?.scenario_format,
        storyString: ctx.powerUserSettings?.context?.story_string,
        rules,
    });
}

const fixDetails = {
    [FIX_WI_FORMAT]: { defaultValue: DEFAULT_WI_FORMAT, input: '#wi_format_textarea', label: 'World Info Format' },
    [FIX_PERSONALITY_FORMAT]: { defaultValue: DEFAULT_PERSONALITY_FORMAT, input: '#personality_format_textarea', label: 'Personality Format' },
    [FIX_SCENARIO_FORMAT]: { defaultValue: DEFAULT_SCENARIO_FORMAT, input: '#scenario_format_textarea', label: 'Scenario Format' },
};

function getPresetName(ctx) {
    const name = ctx.getPresetManager?.('openai')?.getSelectedPresetName?.();
    return typeof name === 'string' ? name : '';
}

/** Captures the exact host settings object and preset that a conflict belongs to. */
export function captureFixTarget(fix) {
    const ctx = SillyTavern.getContext();
    if (!fixDetails[fix] || !ctx.chatCompletionSettings) {
        return null;
    }

    return {
        fix,
        settings: ctx.chatCompletionSettings,
        mainApi: String(ctx.mainApi ?? ''),
        presetName: getPresetName(ctx),
        currentValue: String(ctx.chatCompletionSettings[fix] ?? ''),
    };
}

function isCurrentTarget(ctx, target) {
    return target?.settings === ctx.chatCompletionSettings
        && target.mainApi === String(ctx.mainApi ?? '')
        && target.presetName === getPresetName(ctx)
        && target.currentValue === String(ctx.chatCompletionSettings?.[target.fix] ?? '');
}

function writeFormat(ctx, fix, value) {
    const details = fixDetails[fix];
    if (!details || !ctx.chatCompletionSettings) {
        return false;
    }

    ctx.chatCompletionSettings[fix] = value;

    const input = typeof document !== 'undefined' ? document.querySelector(details.input) : null;
    if (input) {
        input.value = value;
        if (typeof Event === 'function') {
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    ctx.saveSettingsDebounced();
    return true;
}

/** Replaces one overlapping format and returns the exact value needed for a guarded undo. */
export function applyFix(fix, target = captureFixTarget(fix)) {
    const ctx = SillyTavern.getContext();
    const details = fixDetails[fix];
    if (!details || target?.fix !== fix || !isCurrentTarget(ctx, target)) {
        return false;
    }

    const previousValue = target.currentValue;
    if (!writeFormat(ctx, fix, details.defaultValue)) {
        return false;
    }
    return {
        fix,
        label: details.label,
        previousValue,
        appliedValue: details.defaultValue,
        settings: target.settings,
        mainApi: target.mainApi,
        presetName: target.presetName,
    };
}

/** Restores a conflict fix only when the host value has not changed in the meantime. */
export function undoFix(token) {
    const ctx = SillyTavern.getContext();
    const details = fixDetails[token?.fix];
    if (!details || !ctx.chatCompletionSettings || typeof token.previousValue !== 'string') {
        return { ok: false, error: 'That formatting change can no longer be undone.' };
    }
    if (token.settings !== ctx.chatCompletionSettings
        || token.mainApi !== String(ctx.mainApi ?? '')
        || token.presetName !== getPresetName(ctx)) {
        return { ok: false, error: `${details.label} belongs to a different preset, so Prompt Tags did not overwrite it.` };
    }
    if (String(ctx.chatCompletionSettings[token.fix] ?? '') !== token.appliedValue) {
        return { ok: false, error: `${details.label} changed after the reset, so Prompt Tags did not overwrite it.` };
    }
    if (!writeFormat(ctx, token.fix, token.previousValue)) {
        return { ok: false, error: `Could not restore ${details.label}.` };
    }
    return { ok: true };
}
