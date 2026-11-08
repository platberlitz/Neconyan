import { escapeHtml } from '../../../utils.js';
import { getPlotCompassIdentity } from './plot-compass-context.js';
import { getPlotCompassObjective, getPlotCompassScopeKey, normalizePlotCompassScope, PLOT_COMPASS_OBJECTIVE_MAX_CHARS } from './companion-shared.js';

export function buildPlotCompassControls(agent, { panel = false } = {}) {
    const settings = agent.settings ?? {};
    const identity = getPlotCompassIdentity();
    const scope = normalizePlotCompassScope(settings.plotCompassScope);
    const options = [
        ['chat', 'This chat'],
        ['character', identity.groupId ? 'This group' : 'This character'],
        ['global', 'All chats'],
    ].map(([value, label]) => `<option value="${value}"${value === scope ? ' selected' : ''}${getPlotCompassScopeKey(value, identity) ? '' : ' disabled'}>${label}</option>`).join('');
    return `
        <div class="ica--plot-objective-composer ${panel ? 'ica--tpanel-plot-objective' : 'ica--companion-plot-objective'}">
            <label><span>Plot Objective</span>
                <input type="text" class="text_pole ica--plot-objective-input" data-role="plot-compass-objective" data-plot-scope="${scope}" data-plot-saved-scope="${scope}" data-plot-saved-value="${escapeHtml(getPlotCompassObjective(settings, identity, scope))}" maxlength="${PLOT_COMPASS_OBJECTIVE_MAX_CHARS}" placeholder="Where should the story go?" value="${escapeHtml(getPlotCompassObjective(settings, identity, scope))}" aria-label="Plot Objective">
            </label>
            <button type="button" class="menu_button menu_button_icon ica--plot-objective-save ${panel ? '' : 'ica--companion-control-action'}" data-action="${panel ? 'panel-plot-compass-save' : 'plot-compass-save'}" title="Save objective and run Plot Compass" aria-label="Save objective and run Plot Compass"><i class="fa-solid fa-compass"></i></button>
            <label style="grid-column: 1 / -1"><span>Objective for</span><select class="text_pole" data-role="plot-compass-scope" aria-label="Plot objective scope">${options}</select></label>
        </div>`;
}

export function changePlotCompassScope(select, agent) {
    const composer = select.closest('.ica--plot-objective-composer');
    const input = composer?.querySelector('[data-role="plot-compass-objective"]');
    if (!input || !agent) return;
    const drafts = input.plotCompassDrafts ??= {};
    if (input.value === getPlotCompassObjective(agent.settings, getPlotCompassIdentity(), input.dataset.plotScope)) delete drafts[input.dataset.plotScope];
    else drafts[input.dataset.plotScope] = input.value;
    const scope = normalizePlotCompassScope(select.value);
    input.value = Object.hasOwn(drafts, scope) ? drafts[scope] : getPlotCompassObjective(agent.settings, getPlotCompassIdentity(), scope);
    input.dataset.plotScope = scope;
}

export function submitPlotCompassOnEnter(event) {
    if (event.key !== 'Enter' || event.isComposing || event.originalEvent?.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.closest('.ica--plot-objective-composer')?.querySelector('[data-action]')?.click();
}
