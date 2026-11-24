/**
 * Keeps saved Plot Compass agents in step with the bundled tracker scripts.
 *
 * Plot Compass shipped without regex scripts. The HTML card scripts were added to the
 * bundled template without a version bump, so the usual version-based template refresh
 * skips existing v2 installs. Agents whose objectives were edited are phase locked,
 * which also excludes them from the generic bundled-script migration. This plan adds
 * only the scripts an install is missing and leaves its saved prompt and objectives
 * untouched.
 */

export const PLOT_COMPASS_TEMPLATE_ID = 'tpl-plot-compass-companion';

/**
 * @param {object|null|undefined} agent A saved agent.
 * @param {object|null|undefined} template The bundled template matched to that agent.
 * @returns {object[]} Copies of the template scripts the agent does not already have.
 */
export function planMissingPlotCompassScripts(agent, template) {
    if (!agent || !template || String(template.id ?? '').trim() !== PLOT_COMPASS_TEMPLATE_ID) {
        return [];
    }

    const desired = Array.isArray(template.regexScripts) ? template.regexScripts : [];
    if (desired.length === 0) {
        return [];
    }

    const existingIds = new Set(
        (Array.isArray(agent.regexScripts) ? agent.regexScripts : [])
            .map(script => String(script?.id ?? '').trim())
            .filter(Boolean),
    );

    return desired
        .filter(script => {
            const id = String(script?.id ?? '').trim();
            return id && !existingIds.has(id);
        })
        .map(script => structuredClone(script));
}
