import { chat } from '../../../../script.js';
import { eventSource } from '../../../events.js';
import { Popup, POPUP_RESULT, POPUP_TYPE, fixToastrForDialogs } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import { captureMessageTargetState, isMessageTargetCurrent } from '../agent-runner.js';
import { changeSelectedCompanionLinks } from '../quick-settings.js';
import { replaceCompanionView, runCompanionViewAction } from './view-state.js';
import {
    areAgentsGloballyEnabled,
    getAgentById,
    getCompanionConfig,
    isAgentEnabledForCurrentScope,
    isCompanionAgent,
    isToolAgent,
} from '../agent-store.js';
import {
    COMPANION_RESULTS_UPDATED_EVENT,
    cleanUpCompanionNotes,
    getAutomaticCompanionAgents,
    getCompanionBatchGroups,
    getCompanionResults,
    getLatestAssistantCompanionMessageIndex,
    getLatestCompanionResultsMessageIndex,
    getLatestValidCompanionMessageIndex,
    getRetryableCompanionAgents,
    retryFailedCompanionsOnMessage,
    runAutomaticCompanionsOnMessage,
    runCompanionAgentOnMessage,
    runCompanionsOnMessage,
} from './companion-runner.js';
import { resolveCompanionContentMacros } from './companion-macros.js';
import { isConversationModeActive, openCompanionPanel } from './companion-panel.js';
import {
    MEMORY_SHARD_TEMPLATE_ID,
    getCompanionReferenceIds,
    getCompanionResultFailure,
    isSuppressedCompanionResult,
    holdsReadableCompanionResults,
    planCompanionNoteCleanup,
} from './companion-shared.js';

const RECENT_NOTES_LIMIT = 20;
const NOTE_SNIPPET_LENGTH = 120;
const CLEANUP_UNDO_TIMEOUT_MS = 12000;

/**
 * Behavior owned by index.js (editor, list rendering, conversion flow) arrives through this seam
 * so the dashboard never imports index.js back.
 * @type {{
 *   openEditor: (agentId: string) => void,
 *   openCompanionDraftEditor: (options?: { autoOpenCompanionMaker?: boolean }) => void,
 *   toggleAgentEnabled: (agent: object) => Promise<void>,
 *   convertAgent: (agent: object, targetExecution: 'companion'|'inline') => Promise<boolean>,
 *   getVisibleAgents: () => object[],
 *   getLastAssistantMessageIndex: () => number,
 *   saveCompanionAgents: (drafts: object[], name: string) => Promise<void>,
 *   reorderCompanionAgents: (orderedIds: string[]) => Promise<void>,
 * }|null}
 */
let dashboardHooks = null;
let activeDashboardPopup = null;
/** @type {'normal'|'select'|'reorder'} */
let dashboardMode = 'normal';
const selectedDashboardIds = new Set();
let dashboardDragging = false;
// Agent saves go through one library write at a time; a second save started mid-write is rejected.
let dashboardSaving = false;
const SAVING_ACTIONS = new Set([
    'toggle',
    'toggle-history',
    'to-inline',
    'to-companion',
    'move-up',
    'move-down',
    'bulk-batch',
    'bulk-unbatch',
    'bulk-history-on',
    'bulk-history-off',
]);

function scrollChatMessageIntoView(messageElement) {
    const chatRoot = document.getElementById('chat');

    if (!(messageElement instanceof HTMLElement) || !(chatRoot instanceof HTMLElement) || !chatRoot.contains(messageElement)) {
        return;
    }

    const chatRect = chatRoot.getBoundingClientRect();
    const messageRect = messageElement.getBoundingClientRect();
    const delta = (messageRect.top - chatRect.top) - ((chatRect.height - messageRect.height) / 2);

    chatRoot.scrollTo({
        top: Math.min(Math.max(chatRoot.scrollTop + delta, 0), Math.max(0, chatRoot.scrollHeight - chatRoot.clientHeight)),
        behavior: 'smooth',
    });
}

export function configureCompanionDashboard(hooks) {
    dashboardHooks = hooks;
}

function getAgentOrder(agent) {
    return Number(agent?.injection?.order) || 0;
}

function countLabel(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

function withCompanionConfig(agent, patch) {
    const draft = structuredClone(agent);
    draft.companion = { ...getCompanionConfig(draft), ...patch };
    return draft;
}

function partitionDashboardAgents(agents = []) {
    const companions = [];
    const convertible = [];

    for (const agent of agents) {
        if (isToolAgent(agent)) {
            continue;
        }

        if (isCompanionAgent(agent)) {
            companions.push(agent);
        } else {
            convertible.push(agent);
        }
    }

    // Neconyan: list companions in run order, the order Reorder changes.
    companions.sort((a, b) => getAgentOrder(a) - getAgentOrder(b));
    return { companions, convertible };
}

function getDashboardCompanions() {
    return partitionDashboardAgents(dashboardHooks?.getVisibleAgents?.() ?? []).companions;
}

function normalizeTokenCount(value) {
    const tokenCount = Number(value);
    return Number.isFinite(tokenCount) && tokenCount > 0 ? Math.round(tokenCount) : 0;
}

function formatTokenCount(value) {
    return normalizeTokenCount(value).toLocaleString();
}

function buildCompanionTokenUsagePillsHtml(result = {}) {
    const inputTokens = normalizeTokenCount(result?.tokenUsage?.inputTokens);
    const outputTokens = normalizeTokenCount(result?.tokenUsage?.outputTokens);

    return [
        inputTokens ? `<span class="ica--card-pill ica--card-pill--tokens" title="Estimated input tokens" aria-label="Input tokens ${escapeHtml(formatTokenCount(inputTokens))}"><span>Input</span><strong>${escapeHtml(formatTokenCount(inputTokens))}</strong></span>` : '',
        outputTokens ? `<span class="ica--card-pill ica--card-pill--tokens" title="Estimated output tokens" aria-label="Output tokens ${escapeHtml(formatTokenCount(outputTokens))}"><span>Output</span><strong>${escapeHtml(formatTokenCount(outputTokens))}</strong></span>` : '',
    ].filter(Boolean).join('');
}

function buildPillHtml(label, { title = '', modifier = '' } = {}) {
    const className = modifier ? `ica--card-pill ${modifier}` : 'ica--card-pill';
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<span class="${className}"${titleAttribute}>${escapeHtml(label)}</span>`;
}

/**
 * Which enabled companions share a request, numbered in list order, so each row can say so.
 * @param {object[]} companions
 */
function buildBatchSummary(companions) {
    const { groups, mismatched } = getCompanionBatchGroups(companions.filter(agent => isAgentEnabledForCurrentScope(agent)));
    const groupByAgent = new Map();
    groups.forEach((ids, index) => {
        for (const id of ids) {
            groupByAgent.set(id, { number: index + 1, ids });
        }
    });
    return { groupByAgent, mismatched: mismatched ?? new Set() };
}

function buildBatchPillsHtml(agent, companion, batchSummary) {
    const pills = [];
    const group = batchSummary?.groupByAgent?.get(agent.id);
    if (group) {
        const partners = group.ids.filter(id => id !== agent.id).map(id => getAgentById(id)?.name || 'another companion');
        pills.push(buildPillHtml(`batch group ${group.number}`, {
            title: `Runs in one request with ${partners.join(', ')}`,
            modifier: 'ica--card-pill--batch',
        }));
    }
    if (batchSummary?.mismatched?.has(agent.id)) {
        pills.push(buildPillHtml('batch: settings differ', {
            title: 'Linked for batching, but its connection, model or context settings differ from a partner, so they run in separate requests.',
            modifier: 'ica--card-pill--warning',
        }));
    } else if (!group && companion.batch) {
        pills.push(buildPillHtml(isAgentEnabledForCurrentScope(agent) ? 'batch: runs alone' : 'batch', {
            title: 'Batching is on, but no enabled companion linked to it can share its request.',
        }));
    }
    return pills.join('');
}

function getLatestDashboardResult(agentId) {
    for (let messageIndex = chat.length - 1; messageIndex >= 0; messageIndex--) {
        const message = chat[messageIndex];
        if (!holdsReadableCompanionResults(message)) {
            continue;
        }

        const result = getCompanionResults(message)[agentId];
        if (result && typeof result === 'object' && !isSuppressedCompanionResult(agentId, result)) {
            return result;
        }
    }

    return null;
}

function buildFailureNoticeHtml(result) {
    const failure = getCompanionResultFailure(result);
    if (!failure || failure.kind === 'cancelled') {
        return '';
    }

    const lead = failure.keptNote ? 'Last run failed, older note kept:' : 'Last run failed:';
    return `<div class="ica--cdash-row-failure"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>${escapeHtml(lead)} ${escapeHtml(failure.message)}</span></div>`;
}

function buildRowActionHtml(action, icon, label, { title = '', ariaLabel = '', disabled = false, pressed = null } = {}) {
    const attributes = [
        title ? ` title="${escapeHtml(title)}"` : '',
        ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : '',
        pressed === null ? '' : ` aria-pressed="${pressed}"`,
        disabled || (dashboardSaving && SAVING_ACTIONS.has(action)) ? ' disabled' : '',
    ].join('');
    return `<button type="button" class="ica--cdash-action" data-action="${action}"${attributes}><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></button>`;
}

/**
 * @param {object} agent
 * @param {{ mode?: 'normal'|'select'|'reorder', batchSummary?: object|null, position?: number, total?: number }} [options]
 */
export function buildCompanionAgentRowHtml(agent, { mode = 'normal', batchSummary = null, position = 0, total = 1 } = {}) {
    const companion = getCompanionConfig(agent);
    const enabled = isAgentEnabledForCurrentScope(agent);
    const latestResult = getLatestDashboardResult(agent.id);
    const name = agent.name || 'Untitled Companion';
    const keptInHistory = Boolean(companion.includeInChatHistory);
    const configPills = [
        companion.trigger === 'manual' ? 'manual' : 'auto',
        ['panel', 'hidden'].includes(companion.displayMode) ? companion.displayMode : 'card',
        companion.format,
        companion.feedback.enabled ? `feedback ×${companion.feedback.depth}` : '',
        mode !== 'normal' && keptInHistory ? 'in history' : '',
        mode !== 'normal' && !enabled ? 'off' : '',
    ].filter(Boolean).map(label => buildPillHtml(label)).join('');
    const pills = `${configPills}${buildBatchPillsHtml(agent, companion, batchSummary)}${buildCompanionTokenUsagePillsHtml(latestResult)}`;
    const rowClass = `ica--cdash-row${enabled ? ' is-enabled' : ''}`;
    const agentIdAttribute = escapeHtml(agent.id);
    const mainHtml = `
            <div class="ica--cdash-row-main">
                <div class="ica--cdash-row-name">${escapeHtml(name)}</div>
                <div class="ica--cdash-row-pills">${pills}</div>
                ${buildFailureNoticeHtml(latestResult)}
            </div>`;

    if (mode === 'select') {
        const selected = selectedDashboardIds.has(agent.id);
        return `
        <label class="${rowClass} ica--cdash-row--select${selected ? ' is-selected' : ''}" data-agent-id="${agentIdAttribute}">
            <span class="ica--cdash-select"><input type="checkbox" class="ica--cdash-select-input" data-select-agent="${agentIdAttribute}" aria-label="Select ${escapeHtml(name)}"${selected ? ' checked' : ''}></span>
            ${mainHtml}
        </label>
    `;
    }

    if (mode === 'reorder') {
        return `
        <div class="${rowClass} ica--cdash-row--reorder" data-agent-id="${agentIdAttribute}">
            <span class="ica--cdash-drag-handle" title="Drag to reorder" aria-hidden="true"><i class="fa-solid fa-grip-vertical"></i></span>
            ${mainHtml}
            <div class="ica--cdash-row-actions">
                ${buildRowActionHtml('move-up', 'fa-arrow-up', 'Up', { ariaLabel: `Move ${name} up`, disabled: position <= 0 })}
                ${buildRowActionHtml('move-down', 'fa-arrow-down', 'Down', { ariaLabel: `Move ${name} down`, disabled: position >= total - 1 })}
            </div>
        </div>
    `;
    }

    const runDisabled = !areAgentsGloballyEnabled() || latestResult?.status === 'pending';

    return `
        <div class="${rowClass}" data-agent-id="${agentIdAttribute}">
            <button type="button" class="ica--cdash-toggle" data-action="toggle" title="${enabled ? 'Disable companion' : 'Enable companion'}" aria-pressed="${enabled}"${dashboardSaving ? ' disabled' : ''}>
                <i class="fa-solid ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
            </button>
            ${mainHtml}
            <div class="ica--cdash-row-actions">
                ${buildRowActionHtml('toggle-history', 'fa-clock-rotate-left', 'Keep in history', { title: keptInHistory ? 'Its notes are sent with later prompts. Press to stop.' : 'Send its notes with later prompts', pressed: keptInHistory })}
                ${buildRowActionHtml('run', 'fa-play', 'Run', { title: 'Run this companion on the last assistant reply', ariaLabel: 'Run companion', disabled: runDisabled })}
                ${buildRowActionHtml('edit', 'fa-pen-to-square', 'Edit', { title: 'Edit companion', ariaLabel: 'Edit companion' })}
                ${buildRowActionHtml('to-inline', 'fa-right-left', 'To prompt or reply', { title: 'Make this a prompt or reply agent again', ariaLabel: 'Make prompt or reply agent' })}
            </div>
        </div>
    `;
}

export function buildConvertibleAgentRowHtml(agent) {
    return `
        <div class="ica--cdash-row" data-agent-id="${escapeHtml(agent.id)}">
            <div class="ica--cdash-row-main">
                <div class="ica--cdash-row-name">${escapeHtml(agent.name || 'Untitled Agent')}</div>
                <div class="ica--cdash-row-pills">
                    <span class="ica--card-pill">${escapeHtml(agent.category || 'custom')}</span>
                    <span class="ica--card-pill">${escapeHtml(agent.phase || 'pre')}</span>
                </div>
            </div>
            <div class="ica--cdash-row-actions">
                <button type="button" class="ica--cdash-action" data-action="to-companion" title="Make this a companion (it writes a separate note beside replies and never edits the reply)" aria-label="Make companion"${dashboardSaving ? ' disabled' : ''}><i class="fa-solid fa-user-astronaut" aria-hidden="true"></i><span>To companion</span></button>
            </div>
        </div>
    `;
}

export function collectRecentNoteEntries(limit = RECENT_NOTES_LIMIT) {
    const entries = [];

    for (let messageIndex = chat.length - 1; messageIndex >= 0 && entries.length < limit; messageIndex--) {
        const message = chat[messageIndex];
        if (!holdsReadableCompanionResults(message)) {
            continue;
        }

        for (const [agentId, result] of Object.entries(getCompanionResults(message))) {
            if (entries.length >= limit) {
                break;
            }

            if (!result || typeof result !== 'object' || result.status !== 'done' || isSuppressedCompanionResult(agentId, result)) {
                continue;
            }

            const content = resolveCompanionContentMacros(String(result.content ?? ''), message).replace(/\s+/g, ' ').trim();
            entries.push({
                messageIndex,
                agentId,
                agentName: String(result.agentName ?? '').trim() || getAgentById(agentId)?.name || 'Companion',
                snippet: content.length > NOTE_SNIPPET_LENGTH ? `${content.slice(0, NOTE_SNIPPET_LENGTH)}…` : content,
            });
        }
    }

    return entries;
}

function buildRecentNotesHtml(entries) {
    if (entries.length === 0) {
        return '<div class="ica--cdash-empty">No companion notes in this chat yet. Notes appear under assistant replies once a companion runs.</div>';
    }

    return entries.map(entry => `
        <button type="button" class="ica--cdash-note" data-action="jump" data-message-index="${entry.messageIndex}" title="Scroll to this message">
            <span class="ica--cdash-note-head">
                <i class="fa-solid fa-note-sticky"></i>
                <span>${escapeHtml(entry.agentName)}</span>
                <span class="ica--cdash-note-index">#${entry.messageIndex}</span>
            </span>
            <span class="ica--cdash-note-snippet">${escapeHtml(entry.snippet)}</span>
        </button>
    `).join('');
}

function buildToolbarButtonHtml({ action, icon, label, title, disabled = false, badge = 0 }) {
    const badgeHtml = badge > 0 ? `<span class="ica--cdash-badge">${badge}</span>` : '';
    return `
                <button type="button" class="menu_button menu_button_icon" data-action="${action}" title="${escapeHtml(title)}"${disabled ? ' disabled' : ''}>
                    <i class="fa-solid ${icon}" aria-hidden="true"></i>
                    <span>${escapeHtml(label)}</span>${badgeHtml}
                </button>`;
}

function buildToolbarHtml({ globallyEnabled, totalNotes }) {
    const replyIndex = getLatestAssistantCompanionMessageIndex();
    const automaticCount = globallyEnabled && replyIndex >= 0 ? getAutomaticCompanionAgents(replyIndex).length : 0;
    const retryIndex = getLatestCompanionResultsMessageIndex();
    const retryCount = globallyEnabled && retryIndex >= 0 ? getRetryableCompanionAgents(retryIndex).length : 0;

    return [
        buildToolbarButtonHtml({ action: 'run-all', icon: 'fa-play', label: 'Run enabled companions', title: 'Run every enabled companion on the last message', disabled: !globallyEnabled }),
        buildToolbarButtonHtml({
            action: 'run-auto',
            icon: 'fa-bolt',
            label: 'Run automatic companions',
            title: 'Run only the enabled companions set to run after each reply, on the latest reply. Manual companions are skipped.',
            disabled: automaticCount === 0,
            badge: automaticCount,
        }),
        buildToolbarButtonHtml({
            action: 'retry-failed',
            icon: 'fa-rotate-right',
            label: 'Retry failed',
            title: retryCount > 0
                ? `Run again the companions on message #${retryIndex} that failed from a connection error, a blank reply or an interruption`
                : 'Nothing failed on the latest message',
            disabled: retryCount === 0,
            badge: retryCount,
        }),
        buildToolbarButtonHtml({ action: 'clean-up', icon: 'fa-broom', label: 'Clean up notes', title: 'Remove old companion notes from this chat', disabled: totalNotes === 0 }),
        buildToolbarButtonHtml({ action: 'open-panel', icon: 'fa-user-astronaut', label: 'Open Companion panel', title: 'Open the Companion panel with the latest notes' }),
        buildToolbarButtonHtml({ action: 'new-companion', icon: 'fa-plus', label: 'Create companion', title: 'Create a new companion from scratch' }),
        buildToolbarButtonHtml({ action: 'ai-maker', icon: 'fa-wand-magic-sparkles', label: 'Draft with AI', title: 'Describe a companion and let AI draft it' }),
    ].join('');
}

function buildSectionModeHtml(mode, companionCount) {
    return `
                <div class="ica--cdash-section-actions">
                    ${buildRowActionHtml('mode-select', 'fa-list-check', 'Select', { title: 'Pick companions to batch, keep in history or clean up together', pressed: mode === 'select', disabled: companionCount === 0 })}
                    ${buildRowActionHtml('mode-reorder', 'fa-arrows-up-down', 'Reorder', { title: 'Change the order companions run and appear in', pressed: mode === 'reorder', disabled: companionCount < 2 })}
                </div>`;
}

function buildBulkBarHtml(companions, noteCounts) {
    const selected = companions.filter(agent => selectedDashboardIds.has(agent.id));
    const count = selected.length;
    const selectedNotes = selected.reduce((sum, agent) => sum + (noteCounts.get(agent.id) ?? 0), 0);

    return `
            <div class="ica--cdash-bulkbar" role="toolbar" aria-label="Selected companions">
                <span class="ica--cdash-bulk-count">${count} selected</span>
                ${buildRowActionHtml('select-all', 'fa-check-double', 'All', { title: 'Select every companion' })}
                ${buildRowActionHtml('select-none', 'fa-xmark', 'None', { title: 'Clear the selection' })}
                ${buildRowActionHtml('bulk-batch', 'fa-layer-group', 'Batch together', { title: 'Run the selected companions in one request', disabled: count < 2 })}
                ${buildRowActionHtml('bulk-unbatch', 'fa-link-slash', 'Stop batching', { title: 'Run each selected companion in its own request', disabled: count === 0 })}
                ${buildRowActionHtml('bulk-history-on', 'fa-clock-rotate-left', 'Keep in history', { title: 'Send the selected companions\' notes with later prompts', disabled: count === 0 })}
                ${buildRowActionHtml('bulk-history-off', 'fa-eye-slash', 'Stop keeping', { title: 'Stop sending the selected companions\' notes with later prompts', disabled: count === 0 })}
                ${buildRowActionHtml('bulk-clean', 'fa-broom', 'Clean up notes', { title: 'Remove saved notes from the selected companions', disabled: selectedNotes === 0 })}
            </div>
            <p class="ica--cdash-hint">Batched companions share one request when their connection, model and context settings match. Notes kept in history are sent with later prompts.</p>`;
}

export function buildDashboardHtml() {
    const globallyEnabled = areAgentsGloballyEnabled();
    const agents = dashboardHooks?.getVisibleAgents?.() ?? [];
    const { companions, convertible } = partitionDashboardAgents(agents);
    const companionIds = new Set(companions.map(agent => agent.id));
    for (const id of [...selectedDashboardIds]) {
        if (!companionIds.has(id)) selectedDashboardIds.delete(id);
    }
    const mode = companions.length === 0 ? 'normal' : dashboardMode;
    const notePlan = planCompanionNoteCleanup(chat, { keepLatest: false });
    const batchSummary = buildBatchSummary(companions);
    const noticeHtml = globallyEnabled
        ? ''
        : '<div class="ica--cdash-notice"><i class="fa-solid fa-power-off"></i> In-Chat Agents are globally disabled. Companions will not run until they are re-enabled.</div>';
    const modeHtml = mode === 'select'
        ? buildBulkBarHtml(companions, notePlan.counts)
        : mode === 'reorder'
            ? '<p class="ica--cdash-hint">Drag a companion by its grip, or use Up and Down. This order sets the Companion panel order and the run order when companions run one at a time.</p>'
            : '';

    return `
        <div class="ica--cdash-header">
            <div class="ica--cdash-title"><i class="fa-solid fa-user-astronaut" aria-hidden="true"></i> Companion activity</div>
            <div class="ica--cdash-subtitle">See what companion agents produced, run them again, or turn an existing agent into a companion. Companion notes stay separate from the assistant reply.</div>
            ${noticeHtml}
            <div class="ica--cdash-toolbar">${buildToolbarHtml({ globallyEnabled, totalNotes: notePlan.total })}
            </div>
        </div>
        <div class="ica--cdash-section" data-section="companions" data-mode="${mode}">
            <div class="ica--cdash-section-head">
                <div class="ica--cdash-section-title">Companions <span class="ica--cdash-count">${companions.length}</span></div>${buildSectionModeHtml(mode, companions.length)}
            </div>${modeHtml}
            <div class="ica--cdash-rows">
                ${companions.length > 0
        ? companions.map((agent, position) => buildCompanionAgentRowHtml(agent, { mode, batchSummary, position, total: companions.length })).join('')
        : '<div class="ica--cdash-empty">No companion agents yet. Create one above, install one from Templates, or convert an existing agent below.</div>'}
            </div>
        </div>
        <div class="ica--cdash-section" data-section="convertible">
            <div class="ica--cdash-section-title">Agents you can turn into companions <span class="ica--cdash-count">${convertible.length}</span></div>
            <div class="ica--cdash-rows">
                ${convertible.length > 0
        ? convertible.map(buildConvertibleAgentRowHtml).join('')
        : '<div class="ica--cdash-empty">Every eligible agent already runs as a companion.</div>'}
            </div>
        </div>
        <div class="ica--cdash-section" data-section="notes">
            <div class="ica--cdash-section-title">Latest results</div>
            <div class="ica--cdash-rows">${buildRecentNotesHtml(collectRecentNoteEntries())}</div>
        </div>
    `;
}

async function closeDashboard() {
    const popup = activeDashboardPopup;
    if (popup) {
        await popup.completeAffirmative();
    }
}

function jumpToMessage(messageIndex) {
    const messageElement = document.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (messageElement) {
        scrollChatMessageIntoView(messageElement);
    } else {
        toastr.info('That message is above the rendered window. Scroll up in the chat to load it.');
    }
}

function reportRetryOutcome(results = []) {
    if (results.length === 0) {
        toastr.info('The chat changed before the retry finished.');
        return;
    }

    const failedAgain = results.filter(result => result?.status !== 'done' || result?.lastRunError).length;
    if (failedAgain > 0) {
        toastr.warning(`${countLabel(failedAgain, 'companion')} failed again. Check the connection, then retry.`);
    } else {
        toastr.success(`Retried ${countLabel(results.length, 'companion')}.`);
    }
}

/**
 * Stop batching for the chosen companions: they lose their links, and other companions stop
 * pointing at them. Returns only the companions that change.
 * @param {object[]} selected
 * @returns {object[]}
 */
function buildUnbatchDrafts(selected) {
    const selectedIds = new Set(selected.map(agent => agent.id));
    const selectedReferences = new Set(selected.flatMap(agent => getCompanionReferenceIds(agent)));
    const drafts = [];

    for (const agent of getDashboardCompanions()) {
        const companion = getCompanionConfig(agent);
        const links = Array.isArray(companion.batchAgentIds) ? companion.batchAgentIds : [];
        if (selectedIds.has(agent.id)) {
            if (companion.batch || links.length > 0) {
                drafts.push(withCompanionConfig(agent, { batch: false, batchAgentIds: [] }));
            }
            continue;
        }

        const kept = links.filter(id => !selectedReferences.has(id));
        if (kept.length !== links.length) {
            drafts.push(withCompanionConfig(agent, { batchAgentIds: kept, batch: Boolean(companion.batch) && kept.length > 0 }));
        }
    }

    return drafts;
}

async function saveCompanionDrafts(drafts, name) {
    if (drafts.length > 0) {
        await dashboardHooks.saveCompanionAgents(drafts, name);
    }
}

async function handleBulkAction(action) {
    const selected = getDashboardCompanions().filter(agent => selectedDashboardIds.has(agent.id));
    if (selected.length === 0) {
        toastr.info('Select at least one companion first.');
        return;
    }

    if (action === 'bulk-clean') {
        await openCompanionCleanupDialog({ preselectedIds: selected.map(agent => agent.id) });
        return;
    }

    if (action === 'bulk-history-on' || action === 'bulk-history-off') {
        const enabled = action === 'bulk-history-on';
        const drafts = selected
            .filter(agent => Boolean(getCompanionConfig(agent).includeInChatHistory) !== enabled)
            .map(agent => withCompanionConfig(agent, { includeInChatHistory: enabled }));
        await saveCompanionDrafts(drafts, 'Chat history');
        toastr.success(enabled
            ? `${countLabel(selected.length, 'companion')} now keep their notes in chat history.`
            : `${countLabel(selected.length, 'companion')} no longer keep their notes in chat history.`);
        return;
    }

    if (action === 'bulk-batch') {
        if (selected.length < 2) {
            toastr.info('Select at least two companions to batch them together.');
            return;
        }

        const drafts = selected.map(agent => structuredClone(agent));
        changeSelectedCompanionLinks(drafts, 'batchAgentIds', true);
        await saveCompanionDrafts(drafts, 'Companion batch');
        const saved = selected.map(agent => getAgentById(agent.id)).filter(Boolean);
        const { groups } = getCompanionBatchGroups(saved);
        if (groups.some(ids => saved.every(agent => ids.includes(agent.id)))) {
            toastr.success(`${countLabel(saved.length, 'companion')} now run in one request.`);
        } else {
            toastr.warning('Linked, but some of these use a different connection, model or context setting, so they still run in separate requests. Match those settings to share one request.');
        }
        return;
    }

    if (action === 'bulk-unbatch') {
        await saveCompanionDrafts(buildUnbatchDrafts(selected), 'Companion batch');
        toastr.success(`${countLabel(selected.length, 'companion')} now run in their own requests.`);
    }
}

async function moveCompanion(agent, direction) {
    const ids = getDashboardCompanions().map(item => item.id);
    const index = ids.indexOf(agent.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) {
        return;
    }

    [ids[index], ids[target]] = [ids[target], ids[index]];
    await dashboardHooks.reorderCompanionAgents(ids);
}

async function handleDashboardAction(event, root, rerender) {
    const button = $(event.currentTarget);
    const action = button.attr('data-action');
    const agentId = button.closest('.ica--cdash-row').attr('data-agent-id') || '';
    const agent = agentId ? getAgentById(agentId) : null;

    if (action === 'run-all') {
        const lastIndex = getLatestValidCompanionMessageIndex();
        if (lastIndex < 0) {
            toastr.warning('No message yet to run companions on.');
            return;
        }
        button.prop('disabled', true);
        try {
            const results = await runCompanionsOnMessage(lastIndex);
            if (!Object.keys(results ?? {}).length) {
                toastr.info('No companion agents ran for this message.');
            }
        } finally {
            button.prop('disabled', false);
        }
        return;
    }

    if (action === 'run-auto') {
        const replyIndex = getLatestAssistantCompanionMessageIndex();
        if (replyIndex < 0) {
            toastr.warning('No reply yet to run companions on.');
            return;
        }
        button.prop('disabled', true);
        try {
            const results = await runAutomaticCompanionsOnMessage(replyIndex);
            if (!results?.length) {
                toastr.info('No automatic companions are ready to run on the latest reply.');
            }
        } finally {
            button.prop('disabled', false);
        }
        return;
    }

    if (action === 'retry-failed') {
        const messageIndex = getLatestCompanionResultsMessageIndex();
        if (messageIndex < 0 || getRetryableCompanionAgents(messageIndex).length === 0) {
            toastr.info('Nothing to retry on the latest message.');
            return;
        }
        button.prop('disabled', true);
        try {
            reportRetryOutcome(await retryFailedCompanionsOnMessage(messageIndex));
        } finally {
            button.prop('disabled', false);
        }
        return;
    }

    if (action === 'clean-up') {
        await openCompanionCleanupDialog();
        return;
    }

    if (action === 'mode-select' || action === 'mode-reorder') {
        const nextMode = action === 'mode-select' ? 'select' : 'reorder';
        dashboardMode = dashboardMode === nextMode ? 'normal' : nextMode;
        selectedDashboardIds.clear();
        rerender();
        return;
    }

    if (action === 'select-all' || action === 'select-none') {
        selectedDashboardIds.clear();
        if (action === 'select-all') {
            getDashboardCompanions().forEach(item => selectedDashboardIds.add(item.id));
        }
        rerender();
        return;
    }

    if (action?.startsWith('bulk-')) {
        await handleBulkAction(action);
        return;
    }

    if (action === 'open-panel') {
        await closeDashboard();
        openCompanionPanel();
        return;
    }

    if (action === 'new-companion') {
        await closeDashboard();
        dashboardHooks.openCompanionDraftEditor();
        return;
    }

    if (action === 'ai-maker') {
        await closeDashboard();
        dashboardHooks.openCompanionDraftEditor({ autoOpenCompanionMaker: true });
        return;
    }

    if (action === 'jump') {
        const messageIndex = Number(button.attr('data-message-index'));
        await closeDashboard();
        if (Number.isInteger(messageIndex)) {
            jumpToMessage(messageIndex);
        }
        return;
    }

    if (!agent) {
        toastr.warning('That agent no longer exists.');
        rerender();
        return;
    }

    if (action === 'toggle') {
        await dashboardHooks.toggleAgentEnabled(agent);
        rerender();
        return;
    }

    if (action === 'toggle-history') {
        const enabled = !getCompanionConfig(agent).includeInChatHistory;
        await saveCompanionDrafts([withCompanionConfig(agent, { includeInChatHistory: enabled })], 'Chat history');
        return;
    }

    if (action === 'move-up' || action === 'move-down') {
        await moveCompanion(agent, action === 'move-up' ? -1 : 1);
        return;
    }

    if (action === 'run') {
        const lastIndex = getLatestValidCompanionMessageIndex();
        if (lastIndex < 0) {
            toastr.warning('No message yet to run this companion on.');
            return;
        }
        button.prop('disabled', true);
        try {
            await runCompanionAgentOnMessage(agent.id, lastIndex);
        } finally {
            button.prop('disabled', false);
        }
        return;
    }

    if (action === 'edit') {
        await closeDashboard();
        dashboardHooks.openEditor(agent.id);
        return;
    }

    if (action === 'to-companion' || action === 'to-inline') {
        await dashboardHooks.convertAgent(agent, action === 'to-companion' ? 'companion' : 'inline');
        rerender();
    }
}

// Moving a companion to either end disables the button that moved it; keep focus in the row.
function restoreMoveFocus(root, action, agentId) {
    const rootElement = root[0];
    if (!agentId || !['move-up', 'move-down'].includes(action) || rootElement.contains(document.activeElement)) {
        return;
    }

    const row = [...rootElement.querySelectorAll('.ica--cdash-row[data-agent-id]')].find(element => element.dataset.agentId === agentId);
    row?.querySelector('[data-action="move-up"]:not(:disabled), [data-action="move-down"]:not(:disabled)')?.focus();
}

function setupDashboardSortable(root, rerender) {
    if (dashboardMode !== 'reorder' || typeof root.find !== 'function') {
        return;
    }

    const rows = root.find('[data-section="companions"] .ica--cdash-rows');
    if (!rows.length || typeof rows.sortable !== 'function') {
        return;
    }

    rows.sortable({
        disabled: dashboardSaving,
        items: '> .ica--cdash-row',
        handle: '.ica--cdash-drag-handle',
        axis: 'y',
        tolerance: 'pointer',
        distance: 5,
        placeholder: 'ica--cdash-row-placeholder',
        forcePlaceholderSize: true,
        start: (_event, ui) => {
            dashboardDragging = true;
            ui.placeholder.height(ui.item.outerHeight());
        },
        stop: async () => {
            const orderedIds = rows.children('.ica--cdash-row').map((_, element) => element.dataset.agentId).get().filter(Boolean);
            dashboardDragging = false;
            dashboardSaving = true;
            try {
                await dashboardHooks.reorderCompanionAgents(orderedIds);
            } catch (error) {
                console.error('[InChatAgents] Companion reorder failed:', error);
                toastr.error(error?.message || 'The new order could not be saved. Try again.');
            } finally {
                dashboardSaving = false;
                rerender();
            }
        },
    });
}

function isMemoryShardCompanion(agentId) {
    const agent = getAgentById(agentId);
    return agent ? getCompanionReferenceIds(agent).includes(MEMORY_SHARD_TEMPLATE_ID) : agentId === MEMORY_SHARD_TEMPLATE_ID;
}

function buildCleanupEntries() {
    const oldPlan = planCompanionNoteCleanup(chat, { keepLatest: true });
    const allPlan = planCompanionNoteCleanup(chat, { keepLatest: false });

    return [...allPlan.counts.keys()].map(agentId => {
        const agent = getAgentById(agentId);
        return {
            agentId,
            name: agent?.name || allPlan.names.get(agentId) || 'Deleted companion',
            order: agent ? getAgentOrder(agent) : Number.MAX_SAFE_INTEGER,
            oldCount: oldPlan.counts.get(agentId) ?? 0,
            allCount: allPlan.counts.get(agentId) ?? 0,
            memoryShard: isMemoryShardCompanion(agentId),
        };
    }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function buildCleanupDialogHtml(entries, preselected) {
    const rows = entries.map(entry => {
        const checked = preselected ? preselected.has(entry.agentId) : !entry.memoryShard;
        const warning = entry.memoryShard
            ? '<small class="ica--cclean-warning">Its older notes summarise messages you hid. Removing them loses those summaries.</small>'
            : '';
        return `
            <label class="ica--cclean-agent" data-agent-id="${escapeHtml(entry.agentId)}">
                <input type="checkbox" data-cclean-agent="${escapeHtml(entry.agentId)}"${checked ? ' checked' : ''}>
                <span class="ica--cclean-agent-text">
                    <span class="ica--cclean-agent-name">${escapeHtml(entry.name)}</span>
                    <span class="ica--cclean-agent-count"></span>
                    ${warning}
                </span>
            </label>`;
    }).join('');

    return `
        <div class="ica--cclean">
            <h3 class="ica--cclean-title">Clean up companion notes</h3>
            <p class="ica--cclean-intro">Removed notes are deleted from this chat and stop being sent with later prompts. You can undo for a few seconds afterwards.</p>
            <fieldset class="ica--cclean-group">
                <legend>What to remove</legend>
                <label class="ica--cclean-choice">
                    <input type="radio" name="ica-cclean-mode" value="old" checked>
                    <span><strong>Old notes</strong><small>Keeps each companion's newest note</small></span>
                </label>
                <label class="ica--cclean-choice">
                    <input type="radio" name="ica-cclean-mode" value="all">
                    <span><strong>Every note</strong><small>Removes all notes from the chosen companions</small></span>
                </label>
            </fieldset>
            <fieldset class="ica--cclean-group">
                <legend>Companions</legend>
                <label class="ica--cclean-agent ica--cclean-agent--all">
                    <input type="checkbox" data-cclean-all>
                    <span class="ica--cclean-agent-text"><span class="ica--cclean-agent-name">All companions</span></span>
                </label>
                ${rows}
            </fieldset>
            <p class="ica--cclean-summary" aria-live="polite"></p>
        </div>`;
}

function showCleanupUndoToast({ removed, messages, undo }) {
    const reducedMotion = document.body?.classList?.contains('reduced-motion')
        || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const text = `Removed ${countLabel(removed, 'note')} from ${countLabel(messages, 'message')}.`;
    fixToastrForDialogs();
    const toast = toastr.success(text, '', {
        timeOut: CLEANUP_UNDO_TIMEOUT_MS,
        extendedTimeOut: CLEANUP_UNDO_TIMEOUT_MS / 2,
        tapToDismiss: false,
        escapeHtml: true,
        showDuration: reducedMotion ? 0 : 250,
        hideDuration: reducedMotion ? 0 : 250,
        onHidden: () => fixToastrForDialogs(),
    });
    const messageNode = toast?.[0]?.querySelector?.('.toast-message');
    if (!messageNode) {
        return;
    }

    toast[0].classList.add('neconyan-undo-toast');
    const row = document.createElement('div');
    row.className = 'neconyan-undo-row';
    const label = document.createElement('span');
    label.className = 'neconyan-undo-message';
    label.textContent = text;
    const actions = document.createElement('span');
    actions.className = 'neconyan-undo-actions';
    const undoButton = document.createElement('button');
    undoButton.type = 'button';
    undoButton.className = 'neconyan-undo-action';
    undoButton.textContent = 'Undo';
    const dismissButton = document.createElement('button');
    dismissButton.type = 'button';
    dismissButton.className = 'neconyan-undo-dismiss';
    dismissButton.textContent = 'Dismiss';
    dismissButton.setAttribute('aria-label', 'Dismiss Undo');
    actions.append(undoButton, dismissButton);
    row.append(label, actions);
    messageNode.replaceChildren(row);

    dismissButton.addEventListener('click', () => toastr.clear(toast));
    undoButton.addEventListener('click', async () => {
        undoButton.disabled = true;
        dismissButton.disabled = true;
        let restored = 0;
        try {
            restored = await undo();
        } catch (error) {
            console.error('[InChatAgents] Could not put companion notes back.', error);
        }
        toastr.clear(toast);
        if (restored > 0) {
            toastr.success(`Put back ${countLabel(restored, 'note')}.`);
        } else {
            toastr.warning('Those notes could not be put back because the chat changed.');
        }
    });
}

/**
 * Lets the user pick which companions lose saved notes and whether each keeps its newest one.
 * @param {{ preselectedIds?: string[]|null }} [options]
 * @returns {Promise<{ removed: number, messages: number }|null>}
 */
export async function openCompanionCleanupDialog({ preselectedIds = null } = {}) {
    const entries = buildCleanupEntries();
    if (entries.length === 0) {
        toastr.info('This chat has no saved companion notes to clean up.');
        return null;
    }

    const entryById = new Map(entries.map(entry => [entry.agentId, entry]));
    const content = $(buildCleanupDialogHtml(entries, preselectedIds ? new Set(preselectedIds) : null));
    let popup = null;

    const readChoice = () => {
        const keepLatest = content.find('input[name="ica-cclean-mode"]:checked').val() !== 'all';
        const agentIds = content.find('input[data-cclean-agent]:checked').map((_, input) => input.dataset.ccleanAgent).get();
        const counts = agentIds.map(id => (keepLatest ? entryById.get(id)?.oldCount : entryById.get(id)?.allCount) ?? 0);
        return {
            keepLatest,
            agentIds,
            total: counts.reduce((sum, count) => sum + count, 0),
            companions: counts.filter(count => count > 0).length,
        };
    };

    const sync = () => {
        const { keepLatest, total, companions } = readChoice();
        content.find('.ica--cclean-agent[data-agent-id]').each((_, label) => {
            const entry = entryById.get(label.dataset.agentId);
            const count = keepLatest ? entry?.oldCount : entry?.allCount;
            label.classList.toggle('is-empty', !(count > 0));
            label.querySelector('.ica--cclean-agent-count').textContent = count > 0
                ? countLabel(count, 'note')
                : (keepLatest ? 'Nothing old to remove' : 'No notes');
        });
        const boxes = content.find('input[data-cclean-agent]');
        const checkedCount = boxes.filter(':checked').length;
        const allBox = content.find('input[data-cclean-all]')[0];
        if (allBox) {
            allBox.checked = checkedCount === boxes.length;
            allBox.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
        }
        content.find('.ica--cclean-summary').text(total > 0
            ? `Removes ${countLabel(total, 'note')} from ${countLabel(companions, 'companion')}.`
            : 'Nothing to remove with these choices.');
        popup?.okButton?.classList?.toggle('disabled', total === 0);
        popup?.okButton?.setAttribute?.('aria-disabled', String(total === 0));
    };

    content.on('change', 'input[data-cclean-all]', event => {
        content.find('input[data-cclean-agent]').prop('checked', event.currentTarget.checked);
        sync();
    });
    content.on('change', 'input[data-cclean-agent], input[name="ica-cclean-mode"]', sync);

    popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Remove notes',
        cancelButton: 'Cancel',
        allowVerticalScrolling: true,
        onOpen: () => sync(),
        onClosing: current => {
            if (current.result === POPUP_RESULT.AFFIRMATIVE && readChoice().total === 0) {
                toastr.info('Choose at least one companion with notes to remove.');
                return false;
            }
            return true;
        },
    });
    sync();

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    const { keepLatest, agentIds } = readChoice();
    const outcome = await cleanUpCompanionNotes({ agentIds, keepLatest });
    if (outcome.removed === 0) {
        toastr.info('Nothing needed removing.');
    } else {
        showCleanupUndoToast(outcome);
    }
    return { removed: outcome.removed, messages: outcome.messages };
}

export async function openCompanionDashboard() {
    if (!dashboardHooks) {
        console.warn('[InChatAgents] Companion dashboard opened before configuration.');
        return;
    }

    if (isConversationModeActive()) {
        return;
    }

    if (activeDashboardPopup) {
        return;
    }

    dashboardMode = 'normal';
    selectedDashboardIds.clear();
    dashboardDragging = false;
    dashboardSaving = false;

    const root = $('<div class="ica--cdash"></div>');
    const rerender = () => {
        // A rerender mid-drag would drop the row the user is holding; the drop rerenders.
        if (dashboardDragging) {
            return;
        }
        const scrollContainer = root[0]?.closest?.('.popup-content');
        const scrollTop = scrollContainer?.scrollTop ?? 0;
        const scope = {};
        const target = captureMessageTargetState(scope);
        replaceCompanionView(root, buildDashboardHtml(), () => isMessageTargetCurrent(scope, target));
        setupDashboardSortable(root, rerender);
        if (scrollContainer) {
            scrollContainer.scrollTop = scrollTop;
        }
    };

    rerender();
    root.on('click', '[data-action]', async event => {
        event.preventDefault();
        event.stopPropagation();
        const action = event.currentTarget?.dataset?.action ?? '';
        const agentId = event.currentTarget?.closest?.('[data-agent-id]')?.dataset?.agentId ?? '';
        const saves = SAVING_ACTIONS.has(action);
        if (saves && dashboardSaving) {
            toastr.info('Still saving the last change. Try again in a moment.');
            return;
        }
        try {
            await runCompanionViewAction(event.currentTarget, () => {
                if (saves) {
                    // Rerender after the button is marked busy so it survives while the others lock.
                    dashboardSaving = true;
                    rerender();
                }
                return handleDashboardAction(event, root, rerender);
            });
        } catch (error) {
            console.error('[InChatAgents] Companion dashboard action failed:', error);
            toastr.error(error?.message || 'That change could not be saved. Try again.');
        } finally {
            if (saves) {
                dashboardSaving = false;
            }
        }
        // The busy button was kept through any rerender during the action; refresh it now.
        if (activeDashboardPopup && root[0]?.isConnected) {
            rerender();
            restoreMoveFocus(root, action, agentId);
        }
    });
    root.on('change', 'input[data-select-agent]', event => {
        const agentId = event.currentTarget.dataset.selectAgent;
        if (!agentId) {
            return;
        }
        if (event.currentTarget.checked) {
            selectedDashboardIds.add(agentId);
        } else {
            selectedDashboardIds.delete(agentId);
        }
        rerender();
    });

    let rerenderTimeout = null;
    const onResultsUpdated = () => {
        clearTimeout(rerenderTimeout);
        rerenderTimeout = setTimeout(rerender, 100);
    };
    eventSource.on(COMPANION_RESULTS_UPDATED_EVENT, onResultsUpdated);

    const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    activeDashboardPopup = popup;

    try {
        await popup.show();
    } finally {
        activeDashboardPopup = null;
        dashboardDragging = false;
        dashboardSaving = false;
        clearTimeout(rerenderTimeout);
        eventSource.removeListener(COMPANION_RESULTS_UPDATED_EVENT, onResultsUpdated);
    }
}

export function initCompanionWandMenuItem() {
    if ($('#ica_companions_wand_item').length) {
        return;
    }

    const menuItem = $(`
        <div id="ica_companions_wand_item" class="list-group-item flex-container flexGap5 interactable" title="Open Companion activity" tabindex="0">
            <div class="fa-solid fa-user-astronaut extensionsMenuExtensionButton"></div>
            <span>Companion activity</span>
        </div>
    `);
    menuItem.on('click', () => openCompanionDashboard());
    menuItem.toggle?.(!isConversationModeActive());
    $('#extensionsMenu').append(menuItem);
}
