/**
 * A local reimplementation of the interpolation half of In-Chat Agents'
 * `applyRegexScript` (regex-scripts.js:205-254), so the preview gallery can render without
 * importing anything from the host. test/interpolate.test.js asserts it agrees with the
 * real engine for every spec and theme.
 *
 * The behaviours that matter and are easy to get wrong:
 *  - `{{match}}` is rewritten to `$0` before interpolation.
 *  - An unmatched or empty group becomes '', never 'undefined'.
 *  - `$<name>` named groups are supported.
 */

/** Mirrors public/scripts/utils.js regexFromString, including its flagless fallback. */
export function regexFromString(input) {
    try {
        const match = String(input ?? '').match(/(\/?)(.+)\1([a-z]*)/i);
        if (!match) {
            return null;
        }
        if (match[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(match[3])) {
            return new RegExp(String(input));
        }
        return new RegExp(match[2], match[3]);
    } catch {
        return null;
    }
}

/**
 * @param {string} text Source text.
 * @param {string} findRegex The script's pattern, in `/…/flags` or bare form.
 * @param {string} replaceString The script's replacement.
 * @param {(value: string) => string} [substituteParams] Macro expander.
 */
export function applyOne(text, findRegex, replaceString, substituteParams = value => value) {
    const compiled = regexFromString(findRegex);
    if (!compiled) {
        return text;
    }

    return text.replace(compiled, function replacer(...args) {
        const groups = args;
        const template = String(replaceString).replace(/{{match}}/gi, '$0');
        const interpolated = template.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, index, name) => {
            const value = index
                ? groups[Number(index)]
                : (groups.at(-1) && typeof groups.at(-1) === 'object' ? groups.at(-1)[name] : undefined);
            return value ? String(value) : '';
        });
        return substituteParams(interpolated);
    });
}

/** Runs a themed script list in order, as the display pipeline does. */
export function applyList(text, scripts, substituteParams = value => value) {
    let out = String(text);
    for (const script of scripts) {
        if (script.disabled || script.promptOnly) {
            continue;
        }
        out = applyOne(out, script.findRegex, script.replaceString, substituteParams);
    }
    return out;
}
