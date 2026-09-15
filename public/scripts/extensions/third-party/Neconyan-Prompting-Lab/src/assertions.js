import { ASSERTION, MAX_REGEX_LENGTH, SECTION_LABEL } from './constants.js';
import { contentToText, messagesToText } from './message-content.js';
import { regexSafetyProblem, testRegexSafely } from './safe-regex.js';

const INEXACT_CAPTURE_MESSAGE = 'The observed dry-run prompt did not match its section metrics, so this check was left unchecked.';

/**
 * Checks a finished run against the expectations saved with a test case.
 *
 * Pure: every rule reads the run record and nothing else, so the whole engine
 * is testable without a running Neconyan.
 *
 * A check reports pass true, pass false, or pass null. Null means the check
 * could not be made at all, which is deliberately not a failure: a missing
 * measurement is not evidence of a broken prompt, and reporting it as one would
 * teach users to ignore red.
 */

function sectionLabel(id) {
    return SECTION_LABEL[id] ?? id;
}

function findSection(run, id) {
    return run?.capture?.sections?.find(section => section?.id === id) ?? null;
}

/** The whole prompt as text, for checks that are not tied to one section. */
export function finalText(run) {
    const messages = run?.capture?.messages;
    if (Array.isArray(messages) && messages.length) {
        return messagesToText(messages);
    }
    if (typeof run?.capture?.combinedPrompt === 'string') {
        return run.capture.combinedPrompt;
    }
    return '';
}

function scopeText(run, scope) {
    if (!scope || scope === 'final') {
        return { text: finalText(run), missing: false };
    }
    const section = findSection(run, scope);
    return { text: contentToText(section?.content), missing: !section };
}

function countOccurrences(haystack, needle) {
    if (!needle) {
        return 0;
    }
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

function allWorldInfoEntries(run) {
    return (run?.capture?.wiPasses ?? []).flat().filter(Boolean);
}

const EVALUATORS = {
    [ASSERTION.SECTION_PRESENT](assertion, run) {
        const section = findSection(run, assertion.section);
        const present = Boolean(section && contentToText(section.content).trim());
        return {
            pass: present,
            actual: present ? section.tokens : 0,
            message: present
                ? `"${sectionLabel(assertion.section)}" is in the prompt.`
                : `"${sectionLabel(assertion.section)}" is not in the prompt.`,
        };
    },

    [ASSERTION.SECTION_ABSENT](assertion, run) {
        const section = findSection(run, assertion.section);
        const present = Boolean(section && contentToText(section.content).trim());
        return {
            pass: !present,
            actual: present ? section.tokens : 0,
            message: present
                ? `"${sectionLabel(assertion.section)}" is in the prompt, but should not be.`
                : `"${sectionLabel(assertion.section)}" is not in the prompt, as expected.`,
        };
    },

    [ASSERTION.SECTION_UNIQUE](assertion, run) {
        const section = findSection(run, assertion.section);
        const content = contentToText(section?.content).trim();
        if (!content) {
            return {
                pass: null,
                actual: 0,
                message: `"${sectionLabel(assertion.section)}" is not in the prompt, so it could not be checked for duplicates.`,
            };
        }
        const count = countOccurrences(finalText(run), content);
        return {
            pass: count <= 1,
            actual: count,
            message: count <= 1
                ? `"${sectionLabel(assertion.section)}" appears once.`
                : `"${sectionLabel(assertion.section)}" appears ${count} times in the prompt.`,
        };
    },

    [ASSERTION.TOKEN_CEILING](assertion, run) {
        const scope = assertion.scope || 'total';
        let used = 0;
        if (scope === 'total') {
            used = Number(run?.capture?.tokenTable?.total ?? 0);
        } else {
            const section = findSection(run, scope);
            if (!section) {
                return {
                    pass: null,
                    actual: 0,
                    message: `"${sectionLabel(scope)}" is not in the prompt, so its size could not be checked.`,
                };
            }
            used = Number(section.tokens ?? 0);
        }
        const label = scope === 'total' ? 'The whole prompt' : `"${sectionLabel(scope)}"`;
        return {
            pass: used <= assertion.max,
            actual: used,
            message: used <= assertion.max
                ? `${label} uses ${used.toLocaleString()} tokens, within the limit of ${assertion.max.toLocaleString()}.`
                : `${label} uses ${used.toLocaleString()} tokens, over the limit of ${assertion.max.toLocaleString()}.`,
        };
    },

    [ASSERTION.CONTENT_MATCH](assertion, run) {
        const { text, missing } = scopeText(run, assertion.scope);
        const where = !assertion.scope || assertion.scope === 'final'
            ? 'the prompt'
            : `"${sectionLabel(assertion.scope)}"`;
        if (missing) {
            return {
                pass: null,
                actual: null,
                message: `${where} is not in the prompt, so the text could not be looked for.`,
            };
        }
        const finish = (found) => {
            const pass = assertion.negate ? !found : found;
            const expectation = assertion.negate ? 'should not appear' : 'should appear';
            return {
                pass,
                actual: found,
                message: pass
                    ? `"${assertion.value}" ${assertion.negate ? 'does not appear' : 'appears'} in ${where}.`
                    : `"${assertion.value}" ${expectation} in ${where}, but ${found ? 'it does' : 'it does not'}.`,
            };
        };
        if (assertion.mode === 'regex') {
            if (String(assertion.value ?? '').length > MAX_REGEX_LENGTH) {
                return {
                    pass: null,
                    actual: null,
                    message: `That search pattern is too long. Keep it to ${MAX_REGEX_LENGTH} characters or fewer.`,
                };
            }
            try {
                new RegExp(assertion.value);
            } catch (error) {
                return {
                    pass: null,
                    actual: null,
                    message: `That search pattern is not valid: ${error?.message ?? error}`,
                };
            }
            const safetyProblem = regexSafetyProblem(assertion.value);
            if (safetyProblem) {
                return {
                    pass: null,
                    actual: null,
                    message: safetyProblem,
                };
            }
            return testRegexSafely(assertion.value, text).then((result) => {
                if (result.status === 'timeout') {
                    return {
                        pass: null,
                        actual: null,
                        message: 'That search pattern took too long and was stopped, so this check was left unchecked.',
                    };
                }
                if (result.status !== 'ok') {
                    return {
                        pass: null,
                        actual: null,
                        message: result.status === 'invalid'
                            ? `That search pattern is not valid: ${result.error}`
                            : 'That search pattern could not be run safely in this browser, so this check was left unchecked.',
                    };
                }
                return finish(result.found);
            });
        }
        return finish(text.includes(assertion.value));
    },

    [ASSERTION.WI_ACTIVATED](assertion, run) {
        const entries = allWorldInfoEntries(run);
        if (!entries.length && !run?.capture?.wiPasses?.length) {
            // No scan ran at all. A scan that ran and activated nothing is
            // recorded as an empty pass and handled below as a real answer.
            return {
                pass: null,
                actual: 0,
                message: 'No lorebook scan ran during this run, so this could not be checked.',
            };
        }
        const wanted = String(assertion.entryKey);
        const matches = entries.filter((entry) => {
            if (assertion.worldName && entry.world !== assertion.worldName) {
                return false;
            }
            return String(entry.uid) === wanted
                || entry.comment === wanted
                || (Array.isArray(entry.keys) && entry.keys.includes(wanted));
        });
        const found = matches.length > 0;
        const pass = assertion.negate ? !found : found;
        return {
            pass,
            actual: matches.length,
            message: pass
                ? `The lorebook entry "${wanted}" ${found ? 'was used' : 'was not used'}, as expected.`
                : `The lorebook entry "${wanted}" ${found ? 'was used but should not have been' : 'was not used'}.`,
        };
    },

    [ASSERTION.CACHE_PREFIX_STABLE](assertion, run) {
        const cache = run?.cache ?? {};
        if (cache.source === 'unknown') {
            return {
                pass: null,
                actual: null,
                message: 'The prompt caching depth is not known, so the cached part of the prompt could not be checked. Set it in Prompting Lab settings.',
            };
        }
        if (!cache.predictedBreakpoints?.length) {
            return {
                pass: null,
                actual: null,
                message: 'This conversation is too short for the server to place a cache boundary yet, so there is no cached part to check.',
            };
        }
        const unstable = (cache.volatileSpans ?? []).filter(span => span?.aboveBreakpoint);
        return {
            pass: unstable.length === 0,
            actual: unstable.length,
            message: unstable.length === 0
                ? 'The cached part of the prompt stays the same between runs.'
                : `${unstable.length} piece${unstable.length === 1 ? '' : 's'} of the cached part of the prompt change between runs, so the server cannot reuse its cache.`,
        };
    },
};

/** Evaluates one check against a run. */
export function evaluateAssertion(assertion, run) {
    const evaluator = EVALUATORS[assertion?.type];
    if (!evaluator) {
        return {
            pass: null,
            actual: null,
            message: 'This check type is not supported by this version of Prompting Lab.',
        };
    }
    const couldNotEvaluate = error => ({
        pass: null,
        actual: null,
        message: `This check could not be made: ${error?.message ?? error}`,
    });
    try {
        if (run?.capture?.metricsComplete === false) {
            return {
                pass: null,
                actual: null,
                message: INEXACT_CAPTURE_MESSAGE,
            };
        }
        const result = evaluator(assertion, run);
        return typeof result?.then === 'function' ? result.catch(couldNotEvaluate) : result;
    } catch (error) {
        return couldNotEvaluate(error);
    }
}

/** Evaluates every check on a test case and returns one result per check. */
export async function evaluateAssertions(assertions, run) {
    const results = await Promise.all((assertions ?? []).map(async (assertion, index) => ({
        index,
        type: assertion?.type ?? '',
        ...await evaluateAssertion(assertion, run),
    })));
    if (!results.length && run?.capture?.metricsComplete === false) {
        results.push({
            index: 0,
            type: 'capture-exactness',
            pass: null,
            actual: null,
            message: INEXACT_CAPTURE_MESSAGE,
        });
    }
    return results;
}

/** True when at least one check definitely failed. */
export function hasFailures(results) {
    return (results ?? []).some(result => result?.pass === false);
}

/** Checks that could not be made at all. */
export function unevaluated(results) {
    return (results ?? []).filter(result => result?.pass === null);
}
