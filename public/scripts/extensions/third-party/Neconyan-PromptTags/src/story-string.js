import { CONTENT_PLACEHOLDER, resolveTemplate } from './wrap.js';
import { SECTIONS } from './sections.js';

export const SKIP_NOT_REFERENCED = 'not-referenced';
export const SKIP_MULTIPLE = 'multiple';
export const SKIP_ALREADY_TAGGED = 'already-tagged';
export const SKIP_NO_TEMPLATE = 'no-template';

/**
 * Matches `{{var}}` but not `{{#if var}}` or `{{/if}}`, so the Handlebars guards that give
 * Text Completion its empty-section suppression are left intact.
 */
function variablePattern(name) {
    return new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
}

/**
 * Rewrites a context template's story string so each enabled section is wrapped in its tag.
 *
 * The wrapper goes *inside* the existing `{{#if}}` guard, so an empty section still renders
 * nothing rather than an empty tag pair.
 *
 * @param {string} storyString The current `power_user.context.story_string`.
 * @param {Record<string, object>} rules Resolved rules keyed by section id.
 * @returns {{storyString: string, applied: Array, skipped: Array, changed: boolean}}
 */
export function applyTagsToStoryString(storyString, rules) {
    let output = String(storyString ?? '');
    const applied = [];
    const skipped = [];

    for (const section of SECTIONS) {
        if (!section.storyVar) {
            continue;
        }

        const rule = rules?.[section.id];
        if (!rule?.enabled) {
            continue;
        }

        const template = resolveTemplate(rule);
        if (!template) {
            skipped.push({ id: section.id, label: section.label, variable: section.storyVar, reason: SKIP_NO_TEMPLATE });
            continue;
        }

        const wrapped = template.split(CONTENT_PLACEHOLDER).join(`{{${section.storyVar}}}`);
        if (output.includes(wrapped)) {
            skipped.push({ id: section.id, label: section.label, variable: section.storyVar, reason: SKIP_ALREADY_TAGGED });
            continue;
        }

        const matches = output.match(variablePattern(section.storyVar)) ?? [];
        if (matches.length === 0) {
            skipped.push({ id: section.id, label: section.label, variable: section.storyVar, reason: SKIP_NOT_REFERENCED });
            continue;
        }
        if (matches.length > 1) {
            // Rewriting every occurrence would duplicate the block; leave it to the user.
            skipped.push({ id: section.id, label: section.label, variable: section.storyVar, reason: SKIP_MULTIPLE, count: matches.length });
            continue;
        }

        output = output.replace(variablePattern(section.storyVar), () => wrapped);
        applied.push({ id: section.id, label: section.label, variable: section.storyVar });
    }

    return { storyString: output, applied, skipped, changed: output !== String(storyString ?? '') };
}

/**
 * Removes wrappers previously applied by {@link applyTagsToStoryString}, for every section
 * whose rule can still produce the template that was used. Used as a fallback when there is
 * no stored backup to restore.
 */
export function stripTagsFromStoryString(storyString, rules) {
    let output = String(storyString ?? '');

    for (const section of SECTIONS) {
        if (!section.storyVar) {
            continue;
        }

        const rule = rules?.[section.id];
        const template = resolveTemplate({ ...rule, enabled: true });
        if (!template) {
            continue;
        }

        const wrapped = template.split(CONTENT_PLACEHOLDER).join(`{{${section.storyVar}}}`);
        output = output.split(wrapped).join(`{{${section.storyVar}}}`);
    }

    return { storyString: output, changed: output !== String(storyString ?? '') };
}

export function describeSkip(entry) {
    switch (entry.reason) {
        case SKIP_NOT_REFERENCED:
            return `${entry.label}: the template never uses {{${entry.variable}}}`;
        case SKIP_MULTIPLE:
            return `${entry.label}: appears ${entry.count} times, left untouched`;
        case SKIP_ALREADY_TAGGED:
            return `${entry.label}: already tagged`;
        case SKIP_NO_TEMPLATE:
            return `${entry.label}: tag name or template is invalid`;
        default:
            return entry.label;
    }
}
