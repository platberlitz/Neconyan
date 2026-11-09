import { escapeHtml } from '../../../utils.js';
import { getPlotCompassIdentity } from './plot-compass-context.js';
import { getPlotCompassObjective, getPlotCompassScopeKey, isPlotCompassObjectiveEnabled, PLOT_COMPASS_OBJECTIVE_MAX_CHARS, PLOT_COMPASS_SCOPES } from './companion-shared.js';

export function buildPlotCompassControls(agent, { panel = false, editor = false, identity = getPlotCompassIdentity() } = {}) {
    const settings = agent.settings ?? {};
    const labels = { global: 'Global', character: identity.groupId ? 'This group' : 'This character card', chat: 'This chat only' };
    const layers = PLOT_COMPASS_SCOPES.map(scope => {
        const available = Boolean(getPlotCompassScopeKey(scope, identity));
        const objective = escapeHtml(getPlotCompassObjective(settings, identity, scope));
        const enabled = isPlotCompassObjectiveEnabled(settings, identity, scope);
        return `<div class="ica--plot-objective-layer">
            <label class="checkbox_label"><input type="checkbox" data-role="plot-compass-enabled" data-plot-scope="${scope}" data-plot-saved-value="${enabled}" aria-label="Include ${labels[scope]} objective"${enabled ? ' checked' : ''}${available ? '' : ' disabled'}><span>${labels[scope]}</span></label>
            <textarea class="text_pole textarea_compact" rows="1" data-role="plot-compass-objective" data-plot-scope="${scope}" data-plot-available="${available}" data-plot-saved-value="${objective}" maxlength="${PLOT_COMPASS_OBJECTIVE_MAX_CHARS}" placeholder="${available ? 'Where should the story go?' : 'Open a chat to set this objective'}" aria-label="${labels[scope]} Plot Objective"${available ? '' : ' disabled'}>${objective}</textarea>
        </div>`;
    }).join('');
    return `
        <div class="ica--plot-objective-composer ${editor ? '' : panel ? 'ica--tpanel-plot-objective' : 'ica--companion-plot-objective'}">
            <div class="ica--regex-note">Enabled objectives add together. Empty objectives do nothing. ${editor ? 'Save the agent to apply changes.' : 'Save and run to apply changes.'}</div>
            <div class="ica--plot-objective-list">${layers}</div>
            ${editor ? '' : `<button type="button" class="menu_button menu_button_primary ica--plot-objective-save ${panel ? '' : 'ica--companion-control-action'}" data-action="${panel ? 'panel-plot-compass-save' : 'plot-compass-save'}" title="Save objectives and run Plot Compass"><i class="fa-solid fa-compass"></i><span>Save and run</span></button>`}
        </div>`;
}

export function readPlotCompassControls(element) {
    return [...element.querySelectorAll('[data-role="plot-compass-objective"]')]
        .filter(input => input.dataset.plotAvailable !== 'false')
        .map(input => ({
            scope: input.dataset.plotScope,
            objective: input.value,
            enabled: element.querySelector(`[data-role="plot-compass-enabled"][data-plot-scope="${input.dataset.plotScope}"]`).checked,
        }));
}

export function submitPlotCompassOnEnter(event) {
    if (event.key !== 'Enter' || event.isComposing || event.originalEvent?.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.closest('.ica--plot-objective-composer')?.querySelector('[data-action]')?.click();
}
