import { DOMPurify, showdown } from '../../../../lib.js';
import { chat, chat_metadata, characters, this_chid, changeMessageBelowReader, changeMessagesBelowReader, runWhenChatScrollSettles, saveChatDebounced, substituteParams, substituteParamsExtended } from '../../../../script.js';
import { encodeStyleTags, decodeStyleTags, isExternalMediaAllowed } from '../../../chats.js';
import { bindPortraitUrls } from '../../../portrait-urls.js';
import { eventSource, event_types } from '../../../events.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import { attachTextareaFullscreen } from '../textarea-fullscreen.js';
import { getAgentResultModelName } from '../model-label.js';
import { withReadOnlyVariables } from '../../../variable-read-only.js';
import { stripTrackerMandatoryMarkers } from '../../../tracker-mandatory-marker.js';
import { captureMessageTargetState, isMessageTargetCurrent } from '../agent-runner.js';
import { replaceCompanionView, runCompanionViewAction } from './view-state.js';
import {
    areAgentsGloballyEnabled,
    getAgentById,
    getAgentRegexScripts,
    getCompanionConfig,
    getEnabledAgents,
    isAgentHidden,
    isCompanionAgent,
    saveAgent,
} from '../agent-store.js';
import { AGENT_REGEX_PLACEMENT, applyRegexScriptList } from '../regex-scripts.js';
import { resolveCompanionContentMacros } from './companion-macros.js';
import { buildPlotCompassControls, readPlotCompassControls, submitPlotCompassOnEnter } from './plot-compass-controls.js';
import { getPlotCompassIdentity } from './plot-compass-context.js';
import { CHATROOM_FEED_PROBE_RE, buildChatroomReplyRunOptions, normalizeChatroomField, foldChatroomGreentextLines, normalizeChatroomGeneratedLine } from './chatroom-feed.js';
import { foldMessageInboxLines } from './message-inbox-feed.js';
import { isLorebookAgent, sendCompanionResultToLorebook } from './lorebook-sender.js';
import { isMemoryShardTarget } from './memory-shard-format.js';
import { createMemoryShardEditor } from './memory-shard-editor.js';
import {
    COMPANION_RESULTS_UPDATED_EVENT,
    MAX_COMPANION_RESULT_CHARS,
    captureCompanionResultTarget,
    collectRecentCompanionResults,
    deleteCompanionResult,
    emitCompanionResultsUpdated,
    getCompanionResults,
    getDisplayedCompanionResults,
    getLatestAssistantCompanionMessageIndex,
    isCompanionRunStoppable,
    isServerReplyCompanionStopping,
    runCompanionAgentOnMessage,
    runCompanionsOnMessage,
    stopCompanionRun,
    stopServerReplyCompanion,
    updateCompanionResult,
} from './companion-runner.js';
import {
    CHAT_ONLY_INPUT_MAX_CHARS,
    CHATROOM_REPLY_MAX_CHARS,
    CHATROOM_STYLE_VALUES,
    appendChatOnlyUserMessage,
    holdsReadableCompanionResults,
    isAssistantMessage,
    isChatOnlyAgent,
    isChatroomAgent,
    isDiceRollerAgent,
    isMessageInboxAgent,
    getPlotCompassChoice,
    getPlotCompassOpeningNote,
    isPlotCompassAgent,
    isSuppressedCompanionResult,
    isValidCompanionMessage,
    normalizeChatOnlyInput,
    normalizeChatroomReply,
    normalizePlotCompassChoiceText,
    parsePlotCompassChoices,
    PLOT_COMPASS_OPENING_NOTES_KEY,
    setPlotCompassObjectives,
} from './companion-shared.js';
import {
    buildDiceCompanionCardHtml,
    captureDiceCompanionWidget,
    notifyDiceCompanionHostsChanged,
    restoreDiceCompanionWidget,
} from './dice-companion-view.js';

let companionUiInitialized = false;
let companionMarkdownConverter = null;
const companionMessageRuns = new Set();

// Hues the template instructs the model to use.
const CHATROOM_VALID_TONES = new Set(['18', '42', '92', '150', '205', '265', '315']);

function normalizeChatroomContent(content = '') {
    const text = String(content ?? '').replaceAll(/\r\n?/g, '\n').trim();
    if (!text) {
        return content;
    }

    if (CHATROOM_FEED_PROBE_RE.test(text)) {
        return foldChatroomGreentextLines(text.split('\n').map(normalizeChatroomGeneratedLine).join('\n'));
    }

    // Expect first line: `style|...` (may have the style value duplicated after the pipe)
    const styleMatch = text.match(/^\s*([^|\n]+)\|([\s\S]*)$/);
    const style = styleMatch?.[1]?.trim().toLowerCase() || '';
    if (!CHATROOM_STYLE_VALUES.has(style)) {
        return content;
    }

    let rest = styleMatch[2].trim();

    // Strip duplicated style prefix emitted by some models: "mixed|mixed @..." → "@..."
    if (rest.toLowerCase().startsWith(style)) {
        rest = rest.slice(style.length).trim();
    }

    // Split into individual post tokens on @ boundaries.
    // Each model post looks like: @Handle/meta/HUE/message text[/mood]
    const rawTokens = rest.split(/(?=@[A-Za-z])/).map(t => t.trim()).filter(Boolean);

    const rows = [];
    for (const token of rawTokens) {
        // Strip leading @
        const t = token.startsWith('@') ? token.slice(1) : token;
        const parts = t.split('/');
        if (parts.length < 4) continue;

        const speaker = parts[0].trim();
        const meta = parts[1].trim();
        const tone = parts[2].trim();
        if (!speaker || !CHATROOM_VALID_TONES.has(tone)) continue;

        // Remaining parts joined as message (model may put a mood word as last slash-token)
        const message = parts.slice(3).join(' ').trim();
        if (!message) continue;

        rows.push(`chatroom|${normalizeChatroomField(speaker)}|${normalizeChatroomField(meta)}|${tone}|${normalizeChatroomField(message)}`);
    }

    if (!rows.length) {
        return content;
    }

    return ['chatroom-style|' + style, ...rows, 'chatroom-end'].join('\n');
}

function getMarkdownConverter() {
    if (!companionMarkdownConverter) {
        companionMarkdownConverter = new showdown.Converter({
            simpleLineBreaks: true,
            tables: true,
            strikethrough: true,
        });
    }

    return companionMarkdownConverter;
}

function getMessageIndexFromElement(element) {
    const messageIndex = Number($(element).closest('.mes').attr('mesid'));
    return Number.isFinite(messageIndex) ? messageIndex : -1;
}

// Panel and card redraws sanitise the same notes again; themed notes carry large stylesheets
// whose rewrite takes most of that time, so reuse the result while the inputs are unchanged.
const SANITIZED_HTML_CACHE_LIMIT = 200;
const SANITIZED_HTML_CACHE_MAX_INPUT = 256 * 1024;
const SANITIZED_HTML_CACHE_MAX_CHARACTERS = 4 * 1024 * 1024;
const sanitizedHtmlCache = new Map();
let sanitizedHtmlCacheCharacters = 0;

export function sanitizeCompanionHtml(html = '', { prefix = '.ica--companion-body ' } = {}) {
    const source = String(html ?? '');
    const cacheKey = source.length <= SANITIZED_HTML_CACHE_MAX_INPUT
        ? `${isExternalMediaAllowed() ? 1 : 0}\u0000${prefix}\u0000${source}`
        : null;
    const cached = cacheKey === null ? undefined : sanitizedHtmlCache.get(cacheKey);
    if (cached !== undefined) {
        sanitizedHtmlCache.delete(cacheKey);
        sanitizedHtmlCache.set(cacheKey, cached);
        return cached;
    }

    const result = sanitizeCompanionHtmlUncached(source, prefix);
    if (cacheKey !== null) {
        sanitizedHtmlCache.set(cacheKey, result);
        sanitizedHtmlCacheCharacters += cacheKey.length + result.length;
        while (sanitizedHtmlCache.size > SANITIZED_HTML_CACHE_LIMIT || sanitizedHtmlCacheCharacters > SANITIZED_HTML_CACHE_MAX_CHARACTERS) {
            const [oldestKey, oldestResult] = sanitizedHtmlCache.entries().next().value;
            sanitizedHtmlCache.delete(oldestKey);
            sanitizedHtmlCacheCharacters -= oldestKey.length + oldestResult.length;
        }
    }
    return result;
}

function sanitizeCompanionHtmlUncached(html, prefix) {
    const encoded = encodeStyleTags(html);
    const sanitized = DOMPurify.sanitize(encoded, {
        MESSAGE_SANITIZE: true,
        ADD_TAGS: ['custom-style'],
        ADD_ATTR: ['style', 'target', 'rel'],
        // Note bodies must never carry the panel/dashboard action attribute; delegated
        // click handlers would otherwise treat generated content as a trusted control.
        FORBID_ATTR: ['data-action'],
    });
    return decodeStyleTags(sanitized, { prefix });
}

function applyAgentRegexToCompanionContent(agentId, content, message) {
    const agent = getAgentById(agentId);
    const scripts = agent ? getAgentRegexScripts(agent) : [];
    if (scripts.length === 0) {
        return content;
    }

    // Same semantics as the chat message display path: a converted tracker's beautifier
    // regex keeps working on its note card. Sanitization happens after, in the format step.
    const normalizedContent = isChatroomAgent(agent)
        ? normalizeChatroomContent(content)
        : isMessageInboxAgent(agent) ? foldMessageInboxLines(content) : content;
    return withReadOnlyVariables(() => applyRegexScriptList(normalizedContent, scripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
        characterOverride: String(message?.name ?? '').trim(),
        isMarkdown: true,
        substituteParamsFn: substituteParams,
        substituteParamsExtendedFn: substituteParamsExtended,
    }));
}

function getCompanionPortraitCharacter(message) {
    // Assistant messages carry the speaking card's file identity, including group members.
    if (message && !message.is_user && message.original_avatar) {
        return { name: message.name, avatar: message.original_avatar };
    }

    const current = characters?.[this_chid];
    const messageName = String(message?.name ?? '').trim();
    if (!messageName || current?.name === messageName) {
        return current;
    }

    return characters?.find(character => character?.name === messageName) ?? current;
}

export function formatCompanionContent(agentId, result = {}, message = null, stylePrefix = '.ica--companion-body ') {
    const rawContent = String(result.content ?? '').trim();
    if (isSuppressedCompanionResult(agentId, result)) {
        return '';
    }

    if (!rawContent) {
        return '<div class="ica--companion-empty">No note returned.</div>';
    }

    const stripped = stripTrackerMandatoryMarkers(rawContent);
    const content = applyAgentRegexToCompanionContent(agentId, stripped, message);
    const resolved = resolveCompanionContentMacros(content, message);
    const resolvedRaw = content === stripped ? resolved : resolveCompanionContentMacros(stripped, message);
    const sanitizeOptions = { prefix: stylePrefix };
    const portraitCharacter = getCompanionPortraitCharacter(message);
    const bindPortraits = html => bindPortraitUrls(html, portraitCharacter);

    const decorate = html => {
        const lines = decorateChoiceLines(html);
        return isPlotCompassAgent(getAgentById(agentId)) ? decoratePlotCompassChoices(lines, agentId, result, message, resolvedRaw) : lines;
    };

    if (result.format === 'html') {
        return decorate(sanitizeCompanionHtml(bindPortraits(resolved), sanitizeOptions));
    }

    if (result.format === 'text') {
        return `<pre class="ica--companion-text">${escapeHtml(resolved)}</pre>`;
    }

    return decorate(sanitizeCompanionHtml(bindPortraits(getMarkdownConverter().makeHtml(resolved)), sanitizeOptions));
}

function getResultStatus(result = {}) {
    return ['pending', 'done', 'error', 'cancelled'].includes(result.status) ? result.status : 'done';
}

function getStatusLabel(status) {
    switch (status) {
        case 'pending': return 'Running';
        case 'error': return 'Error';
        case 'cancelled': return 'Cancelled';
        default: return 'Ready';
    }
}

function getResultSortValue(result = {}) {
    const timestamp = Date.parse(result.updatedAt ?? '');
    return Number.isFinite(timestamp) ? timestamp : 0;
}

const OFF_LEDGER_DISPLAY_MODES = new Set(['hidden', 'panel']);

export function isHiddenCompanionResult(agentId, result = {}) {
    if (isSuppressedCompanionResult(agentId, result)) {
        return true;
    }

    const agent = getAgentById(agentId);
    return OFF_LEDGER_DISPLAY_MODES.has(agent ? getCompanionConfig(agent).displayMode : result.displayMode);
}

export function isSilentCompanionAgent(agent = {}) {
    return isMessageInboxAgent(agent);
}

export { isSuppressedCompanionResult };

function getRenderableCompanionEntries(message) {
    return Object.entries(getDisplayedCompanionResults(message))
        .filter(([agentId, result]) => result && typeof result === 'object' && !isHiddenCompanionResult(agentId, result))
        .sort(([, left], [, right]) => getResultSortValue(left) - getResultSortValue(right));
}

function buildCompanionBody(agentId, result, message) {
    const status = getResultStatus(result);

    if (status === 'pending') {
        return '<div class="ica--companion-pending"><i class="fa-solid fa-spinner fa-spin"></i><span>Companion is writing a note.</span></div>';
    }

    if (status === 'error') {
        return `<div class="ica--companion-error">${escapeHtml(result.error || 'Companion run failed.')}</div>`;
    }

    if (status === 'cancelled') {
        return '<div class="ica--companion-empty">Companion run was cancelled.</div>';
    }

    return buildLastRunErrorNotice(result) + formatCompanionContent(agentId, result, message);
}

export function buildLastRunErrorNotice(result = {}) {
    const failure = String(result?.lastRunError ?? '').trim();
    return failure
        ? `<div class="ica--companion-error">Last run failed (${escapeHtml(failure)}). Showing the previous note.</div>`
        : '';
}

function buildChatOnlyCardComposer(agentId) {
    const agent = getAgentById(agentId);
    if (!isChatOnlyAgent(agent)) {
        return '';
    }

    return `
        <div class="ica--chatonly-composer ica--companion-chatonly-composer">
            <label>
                <span class="ica--chatonly-live ica--companion-chatonly-live"><i class="fa-solid fa-circle"></i><span>Private side chat</span></span>
                <input type="text" class="text_pole ica--chatonly-input ica--companion-chatonly-input" data-role="chat-only-input" maxlength="${CHAT_ONLY_INPUT_MAX_CHARS}" placeholder="Type an aside..." aria-label="Private side chat">
            </label>
            <button type="button" class="menu_button menu_button_icon ica--chatonly-send ica--companion-control-action" data-action="chat-only-send" title="Send this aside to Chat Only" aria-label="Send aside">
                <i class="fa-solid fa-paper-plane"></i>
            </button>
        </div>
    `;
}

function buildChatroomReplyComposer(agentId) {
    const agent = getAgentById(agentId);
    if (!isChatroomAgent(agent)) {
        return '';
    }

    return `
        <div class="ica--chatonly-composer ica--companion-chatroom-reply">
            <label>
                <input type="text" class="text_pole ica--chatonly-input ica--companion-chatroom-reply-input" data-role="chatroom-reply-input" maxlength="${CHATROOM_REPLY_MAX_CHARS}" placeholder="Respond to the chatroom..." aria-label="Respond to the chatroom">
            </label>
            <button type="button" class="menu_button menu_button_icon ica--chatonly-send ica--companion-control-action" data-action="chatroom-reply-send" title="Send your reply to the chatroom" aria-label="Send reply">
                <i class="fa-solid fa-paper-plane"></i>
            </button>
        </div>
    `;
}

function buildPlotCompassObjectiveComposer(agentId) {
    const agent = getAgentById(agentId);
    if (!isPlotCompassAgent(agent)) {
        return '';
    }

    return buildPlotCompassControls(agent);
}

function buildCompanionCardControls(agentId) {
    return [
        buildPlotCompassObjectiveComposer(agentId),
        buildChatOnlyCardComposer(agentId),
        buildChatroomReplyComposer(agentId),
    ].filter(Boolean).join('');
}

const RAW_ID_LABEL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAILING_ID_IN_NAME_RE = /\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i;

function isReadableLabel(label) {
    return Boolean(label) && !RAW_ID_LABEL_RE.test(label);
}

/** Imported/AI-generated agents sometimes carry a uuid suffix in their name; never display it. */
export function cleanCompanionAgentName(name) {
    return String(name ?? '').replace(TRAILING_ID_IN_NAME_RE, '').trim() || 'Companion';
}

const CHOICE_PREFIX_RE = /^(?:[-*•→>]|\d+[.):]|[a-z][.)])\s+/i;
// Detection requires a real enumerator (1. / 2) / B)) — plain bullets are how trackers
// format state lines, and wrapping those turned ordinary panel taps into inserts.
const CHOICE_LINE_RE = /^(?:\d+[.):]|[a-z][.)])\s+\S/i;

/** Normalizes a clicked choice line: collapse whitespace and strip list enumeration. */
export function extractChoiceText(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim().replace(CHOICE_PREFIX_RE, '').trim();
}

function buildChoiceButtonHtml(innerHtml) {
    return `<button type="button" class="ica--choice-line" title="Put this choice in the message box">${innerHtml}</button>`;
}

function wrapChoiceSegment(segment) {
    if (Array.isArray(segment)) {
        const probe = document.createElement('div');
        for (const node of segment) {
            probe.appendChild(node.cloneNode(true));
        }
        const text = (probe.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!CHOICE_LINE_RE.test(text) || probe.querySelector('button, a, details, input, select, textarea, style, svg, math')) {
            return segment;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ica--choice-line';
        button.title = 'Put this choice in the message box';
        for (const node of segment) {
            button.appendChild(node);
        }
        return [button];
    }

    const probe = document.createElement('div');
    probe.innerHTML = segment;
    const text = probe.textContent.replace(/\s+/g, ' ').trim();
    if (!CHOICE_LINE_RE.test(text) || probe.querySelector('button, a, details, style, svg, math')) {
        return segment;
    }

    return buildChoiceButtonHtml(segment);
}

/** Give bundled choice rows real controls after the message sanitiser has run. */
function decorateStyledChoiceRows(container) {
    if (!container) return;
    for (const row of container.querySelectorAll('div.pura-choice, div.custom-pura-choice')) {
        if (row.closest('button, a') || row.querySelector('button, a, input, select, textarea, details')) continue;
        const label = row.cloneNode(true);
        const badge = label.firstElementChild;
        let prefix = '';
        if (badge && /^(?:\d+|[a-z])[.):]?$/i.test(badge.textContent.trim())) {
            prefix = badge.textContent.trim().replace(/[.):]$/, '') + '. ';
            badge.remove();
        }
        if (!label.textContent.trim()) continue;
        const text = prefix + label.textContent;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${row.className} ica--choice-line ica--choice-row`;
        button.title = 'Put this choice in the message box';
        button.setAttribute('aria-label', extractChoiceText(text));
        button.dataset.icaChoiceText = text;
        if (row.hasAttribute('style')) button.setAttribute('style', row.getAttribute('style'));
        while (row.firstChild) button.appendChild(row.firstChild);
        row.replaceWith(button);
    }
}

/**
 * Wraps choice-looking lines in real buttons so they are tappable everywhere (iOS included).
 * Three passes cover the shapes companion output takes: proper markdown lists; enumerated
 * lines left as <br>-separated text inside one block by showdown's simpleLineBreaks (raw
 * CYOA/direction output); and enumerated lines inside arbitrary styled markup produced by
 * agent beautifier regexes. Runs after sanitization; only our own button wrapper is added.
 */
export function decorateChoiceLines(html) {
    if (typeof document === 'undefined' || typeof document?.createElement !== 'function') {
        return html;
    }

    const makeChoiceButton = (nodes) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ica--choice-line';
        button.title = 'Put this choice in the message box';
        for (const node of nodes) {
            button.appendChild(node);
        }
        return button;
    };

    const container = document.createElement('div');
    container.innerHTML = html;
    decorateStyledChoiceRows(container);

    for (const item of container.querySelectorAll('ol > li')) {
        if (!item.querySelector('button, a, ul, ol, style, svg, math') && item.textContent.trim()) {
            const button = makeChoiceButton(Array.from(item.childNodes));
            item.replaceChildren(button);
        }
    }

    for (const block of container.querySelectorAll('p, div')) {
        if (block.querySelector('button, a, p, div, ul, ol, style, svg, math')) {
            continue;
        }

        const childNodes = Array.from(block.childNodes);
        const groups = [[]];
        const brNodes = [];
        for (const node of childNodes) {
            if (node.nodeType === 1 && node.tagName.toUpperCase() === 'BR') {
                brNodes.push(node);
                groups.push([]);
            } else {
                groups[groups.length - 1].push(node);
            }
        }

        if (groups.length > 1) {
            const fragment = document.createDocumentFragment();
            groups.forEach((group, index) => {
                for (const node of wrapChoiceSegment(group)) {
                    fragment.appendChild(node);
                }
                if (index < brNodes.length) {
                    fragment.appendChild(document.createElement('br'));
                }
            });
            block.replaceChildren(fragment);
        }
    }

    const nonInteractiveChoiceAncestorSelector = 'button, a, details, summary, style, script, svg, math, textarea, option, select, code, pre, custom-style';
    // Deepest-match pass for beautified markup: wrap any innermost element whose own text
    // reads as a single enumerated choice (e.g. a styled row div emitted by a regex script).
    const candidates = [...container.querySelectorAll('*')].filter(element => {
        if (element.namespaceURI && element.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
            return false;
        }
        if (element.closest(nonInteractiveChoiceAncestorSelector) || element.querySelector('button, a, br, details, input, select, textarea, style, svg, math')) {
            return false;
        }

        return CHOICE_LINE_RE.test(element.textContent.replace(/\s+/g, ' ').trim());
    });

    for (const element of candidates) {
        const hasMatchingDescendant = candidates.some(other => other !== element && element.contains(other));
        if (hasMatchingDescendant) {
            continue;
        }

        const button = makeChoiceButton(Array.from(element.childNodes));
        element.replaceChildren(button);
    }

    return container.innerHTML;
}

const PLOT_COMPASS_CHOICE_ATTRIBUTES = ['data-plot-compass-choice', 'data-plot-compass-agent', 'data-plot-compass-message'];

// Only the newest note reaches the next reply, so only its directions take a pick.
function getPlotCompassChoiceHost(agentId, result, message) {
    const messageIndex = message ? chat.indexOf(message) : -1;
    const stored = message
        ? (messageIndex >= 0 ? getCompanionResults(message)[agentId] : null)
        : getPlotCompassOpeningNote(chat_metadata, agentId);
    if (!stored || stored !== result) return null;
    return collectRecentCompanionResults(agentId, { depth: 1 })[0]?.messageIndex === messageIndex ? messageIndex : null;
}

function getPlotCompassStoredResult(agentId, messageIndex) {
    if (messageIndex === -1) return getPlotCompassOpeningNote(chat_metadata, agentId);
    const message = chat[messageIndex];
    return message ? getCompanionResults(message)[agentId] ?? null : null;
}

/**
 * Turns the numbered directions of a Plot Compass note into picks. A pick steers the next
 * reply; with none picked the main model follows the note's own Next move.
 */
export function decoratePlotCompassChoices(html, agentId, result = {}, message = null, displayContent = '') {
    if (typeof document === 'undefined' || typeof document?.createElement !== 'function') {
        return html;
    }
    const container = document.createElement('div');
    container.innerHTML = html;
    for (const attribute of PLOT_COMPASS_CHOICE_ATTRIBUTES) {
        container.querySelectorAll(`[${attribute}]`).forEach(element => element.removeAttribute(attribute));
    }

    const saved = parsePlotCompassChoices(result.content);
    const messageIndex = saved.choices.length ? getPlotCompassChoiceHost(agentId, result, message) : null;
    if (messageIndex === null) {
        return container.innerHTML;
    }

    const shown = parsePlotCompassChoices(displayContent);
    const key = text => normalizePlotCompassChoiceText(extractChoiceText(text)).toLowerCase();
    const labels = new Map();
    for (const choice of saved.choices) {
        const display = shown.choices.find(entry => entry.number === choice.number)?.text;
        labels.set(key(display ?? choice.text), choice.number);
        labels.set(key(choice.text), choice.number);
    }

    const chosen = getPlotCompassChoice(result)?.number ?? null;
    const matched = [];
    for (const button of container.querySelectorAll('button.ica--choice-line')) {
        const clone = button.cloneNode(true);
        clone.querySelectorAll('.ica--plot-choice-tag').forEach(tag => tag.remove());
        const choiceText = button.dataset.icaChoiceText;
        const number = (choiceText ? labels.get(key(choiceText)) : undefined) ?? labels.get(key(clone.textContent));
        if (!number || matched.some(entry => entry.number === number)) continue;
        matched.push({ button, number });
    }
    if (matched.length < 2) {
        return container.innerHTML;
    }

    for (const { button, number } of matched) {
        const picked = chosen === number;
        button.classList.add('ica--plot-choice');
        button.dataset.plotCompassChoice = String(number);
        button.dataset.plotCompassAgent = agentId;
        button.dataset.plotCompassMessage = String(messageIndex);
        button.setAttribute('aria-pressed', picked ? 'true' : 'false');
        button.title = picked ? 'Your pick. Select it again to let Plot Compass choose.' : 'Steer the next reply this way';
        const tagLabel = picked ? 'Your pick' : (saved.pick === number ? 'Suggested' : '');
        if (tagLabel) {
            const tag = document.createElement('span');
            tag.className = `ica--plot-choice-tag${picked ? ' ica--plot-choice-tag-picked' : ''}`;
            tag.textContent = tagLabel;
            button.append(' ', tag);
        }
    }

    const last = matched[matched.length - 1].button;
    const anchor = last.closest('ol, ul') ?? last.closest('p, div') ?? last;
    const hint = document.createElement('p');
    hint.className = 'ica--plot-choice-hint';
    hint.textContent = chosen
        ? 'The next reply follows your pick. Select it again to let Plot Compass choose.'
        : 'Pick a direction for the next reply, or leave it and Plot Compass goes with its suggestion.';
    anchor.after(hint);
    return container.innerHTML;
}

/**
 * Saves or clears the user's pick on a Plot Compass note.
 * @returns {Promise<boolean>} Whether the button was a Plot Compass pick.
 */
export async function togglePlotCompassChoice(button) {
    const agentId = button?.dataset?.plotCompassAgent ?? '';
    const messageIndex = Number(button?.dataset?.plotCompassMessage);
    const number = Number(button?.dataset?.plotCompassChoice);
    if (!agentId || !Number.isInteger(messageIndex) || messageIndex < -1 || !Number.isInteger(number)) {
        return false;
    }
    const result = getPlotCompassStoredResult(agentId, messageIndex);
    const choice = result?.status === 'done' && isPlotCompassAgent(getAgentById(agentId))
        ? parsePlotCompassChoices(result.content).choices.find(entry => entry.number === number)
        : null;
    if (!choice) {
        return true;
    }

    const next = getPlotCompassChoice(result)?.number === number ? null : { number, text: choice.text };
    if (messageIndex === -1) {
        const note = { ...result };
        if (next) note.plotCompassChoice = next;
        else delete note.plotCompassChoice;
        chat_metadata[PLOT_COMPASS_OPENING_NOTES_KEY] = { ...chat_metadata[PLOT_COMPASS_OPENING_NOTES_KEY], [agentId]: note };
    } else {
        // Keep updatedAt, so the note's time still says when Plot Compass wrote it.
        updateCompanionResult(chat[messageIndex], agentId, { plotCompassChoice: next ?? undefined, updatedAt: result.updatedAt });
        const stored = getCompanionResults(chat[messageIndex])[agentId];
        if (!next && stored) delete stored.plotCompassChoice;
    }
    saveChatDebounced({ deferBackup: false });
    await emitCompanionResultsUpdated(messageIndex, agentId);
    return true;
}

/**
 * Puts a clicked companion choice (CYOA option, direction, suggestion) into the message box:
 * replaces an empty box, appends on a new line otherwise.
 * @returns {boolean} Whether anything was inserted.
 */
export function insertChoiceIntoMessageInput(rawText) {
    const choice = extractChoiceText(rawText);
    if (!choice) {
        return false;
    }

    const textarea = document.getElementById('send_textarea');
    if (!textarea) {
        toastr.warning('Could not find the message box.');
        return false;
    }

    const current = String(textarea.value ?? '');
    textarea.value = current.trim() ? `${current.replace(/\s+$/, '')}\n${choice}` : choice;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus({ preventScroll: true });
    toastr.success('Added to the message box.');
    return true;
}

function buildCompanionStopButton(stoppable) {
    return `<button type="button" class="ica--companion-action ica--companion-stop" data-action="stop" title="Stop this companion" aria-label="Stop this companion"${stoppable ? '' : ' disabled'}><i class="fa-solid fa-stop"></i></button>`;
}

function buildCompanionCard(agentId, result, message, isPreview = false, { stoppable = false } = {}) {
    const status = getResultStatus(result);
    const agent = getAgentById(agentId);
    const runnable = !isPreview && Boolean(agent) && isValidCompanionMessage(message);
    // While a note is being written, and while the reply it belongs to is still
    // a preview, every action stays in place but only Stop can be pressed.
    const locked = isPreview || status === 'pending';
    const lockedAttribute = locked ? ' disabled' : '';
    const runDisabled = !areAgentsGloballyEnabled() || locked ? ' disabled' : '';
    const showRun = runnable || (isPreview && Boolean(agent));
    const agentName = cleanCompanionAgentName(result.agentName);
    const icon = String(result.icon ?? '').trim() || 'fa-user-astronaut';
    const profileLabel = String(result.profileLabel ?? '').trim();
    const modelName = getAgentResultModelName(result);
    // Results saved before profile labels were resolved to names may carry raw profile ids.
    // The model leads so it survives truncation; 'Main model' adds nothing once the model is named.
    const shownProfileLabel = modelName && profileLabel === 'Main model' ? '' : profileLabel;
    const meta = [modelName, shownProfileLabel].filter(isReadableLabel).join(' / ');
    const fullModelName = modelName ? String(result.model || result.modelLabel || '').trim() : '';
    const metaTitle = [fullModelName, shownProfileLabel].filter(isReadableLabel).join(' / ');
    const openAttribute = result.collapsed ? '' : ' open';
    const lorebookButton = isLorebookAgent(agent) && (status === 'done' || status === 'pending')
        ? `<button type="button" class="ica--companion-action" data-action="send-to-lorebook" title="Send companion note to lorebook" aria-label="Send companion note to lorebook"${lockedAttribute}><i class="fa-solid fa-book-medical"></i></button>`
        : '';

    return `
        <details class="ica--companion-card ica--companion-card--${escapeHtml(status)}" data-agent-id="${escapeHtml(agentId)}"${openAttribute}>
            <summary class="ica--companion-summary">
                <span class="ica--companion-title">
                    <i class="fa-solid ${escapeHtml(icon)}"></i>
                    <span>${escapeHtml(agentName)}</span>
                </span>
                <span class="ica--companion-summary-spacer"></span>
                ${meta ? `<span class="ica--companion-meta" title="${escapeHtml(metaTitle || meta)}">${escapeHtml(meta)}</span>` : ''}
                <span class="ica--companion-status">${escapeHtml(getStatusLabel(status))}</span>
                <span class="ica--companion-actions">
                    ${status === 'pending' ? buildCompanionStopButton(stoppable) : ''}
                    ${showRun ? `<button type="button" class="ica--companion-action" data-action="regenerate" title="Regenerate companion note" aria-label="Regenerate companion note"${runDisabled}><i class="fa-solid fa-rotate-right"></i></button>` : ''}
                    ${showRun ? `<button type="button" class="ica--companion-action" data-action="fix" title="Fix this companion note with strict output enforcement" aria-label="Fix companion note"${runDisabled}><i class="fa-solid fa-wrench"></i></button>` : ''}
                    <button type="button" class="ica--companion-action" data-action="edit" title="Edit companion note" aria-label="Edit companion note"${lockedAttribute}><i class="fa-solid fa-pen-to-square"></i></button>
                    ${lorebookButton}
                    <button type="button" class="ica--companion-action" data-action="copy" title="Copy companion note" aria-label="Copy companion note"${lockedAttribute}><i class="fa-solid fa-copy"></i></button>
                    <button type="button" class="ica--companion-action caution" data-action="delete" title="Delete companion note" aria-label="Delete companion note"${lockedAttribute}><i class="fa-solid fa-trash"></i></button>
                </span>
            </summary>
            <div class="ica--companion-body">${buildCompanionBody(agentId, result, message)}</div>
            ${runnable ? buildCompanionCardControls(agentId) : ''}
        </details>
    `;
}

function getDiceCardAgents() {
    if (!areAgentsGloballyEnabled()) {
        return [];
    }

    return getEnabledAgents().filter(agent => isDiceRollerAgent(agent)
        && getCompanionConfig(agent).displayMode === 'card'
        && !isAgentHidden(agent.id));
}

/** Notes under replies live under the newest assistant reply, never a user message. */
export function pruneDiceCardsExcept(keepMessageIndex) {
    // One query is enough to skip the whole scan while the agent is off and no
    // old shell exists, including every row of a full redraw.
    if (!document.querySelector('#chat .ica--companion-card--dice')) {
        return;
    }
    for (const row of document.querySelectorAll('#chat > .mes[mesid]')) {
        const rowIndex = Number(row.getAttribute('mesid'));
        if (rowIndex === keepMessageIndex) {
            continue;
        }
        for (const card of row.querySelectorAll?.('.ica--companion-card--dice') ?? []) {
            card.remove();
        }
        const ledger = row.querySelector?.('.ica--companion-ledger');
        if (ledger && !ledger.querySelector('.ica--companion-card')) {
            ledger.remove();
        }
    }
}

function getDiceCardState() {
    const latestAssistant = getLatestAssistantCompanionMessageIndex();
    const allDiceAgents = getDiceCardAgents();
    return { latestAssistant, allDiceAgents, keepMessageIndex: allDiceAgents.length > 0 ? latestAssistant : -1 };
}

function renderCompanionResultsForRow(message, messageElement, messageIndex, preview, { prune = true, diceCardState = null } = {}) {
    const textElement = messageElement.find('.mes_text').first();
    decorateStyledChoiceRows(textElement[0]);

    const entries = holdsReadableCompanionResults(message) ? getRenderableCompanionEntries(message) : [];
    const diceState = preview ? null : (diceCardState ?? getDiceCardState());
    const latestAssistant = diceState?.latestAssistant ?? -1;
    const diceAgents = messageIndex === latestAssistant ? diceState?.allDiceAgents ?? [] : [];
    if (!preview && prune && diceState) {
        // Keep the card on the newest assistant reply while other rows redraw.
        // With no card-mode Dice Roller, remove every stale host.
        pruneDiceCardsExcept(diceState.keepMessageIndex);
    }
    let ledger = messageElement.find('.ica--companion-ledger');

    if (entries.length === 0 && diceAgents.length === 0) {
        ledger.remove();
        notifyDiceCompanionHostsChanged();
        return;
    }

    if (!ledger.length) {
        ledger = $('<div class="ica--companion-ledger" aria-label="Companion notes"></div>');
        if (textElement.length) {
            textElement.after(ledger);
        } else {
            messageElement.find('.mes_block').first().append(ledger);
        }
    }

    const previewJob = preview ? String(preview.jobId ?? preview.element?.dataset?.roleplayJob ?? '') : '';
    const cards = entries.map(([agentId, result]) => buildCompanionCard(agentId, result, message, Boolean(preview), {
        stoppable: getResultStatus(result) === 'pending' && (preview
            ? Boolean(previewJob) && !isServerReplyCompanionStopping(previewJob, agentId)
            : isCompanionRunStoppable(message, agentId)),
    }));
    cards.push(...diceAgents.map(agent => buildDiceCompanionCardHtml(agent, { messageIndex })));
    const target = captureMessageTargetState(message);
    const liveDice = preview ? null : captureDiceCompanionWidget(ledger[0]);
    replaceCompanionView(ledger, cards.join(''),
        () => preview ? preview.element.isConnected : isMessageTargetCurrent(message, target, messageIndex, { text: false, revision: false }));
    if (liveDice) {
        restoreDiceCompanionWidget(ledger[0], liveDice);
    }
    notifyDiceCompanionHostsChanged();
}

/** Redraws chat note cards after an Agent save or the global Agents switch. */
export function refreshCompanionCards() {
    renderAllCompanionResults();
    updateCompanionButtonVisibility();
}

export function renderCompanionResultsForMessage(messageIndex, preview = null, { element: rowElement = null } = {}) {
    const message = preview?.message ?? chat[messageIndex];
    if (!message) {
        return;
    }
    const messageElement = rowElement ? $(rowElement) : preview ? $(preview.element) : $(`.mes[mesid="${messageIndex}"]`);

    if (!messageElement.length) {
        return;
    }

    const applyResults = () => renderCompanionResultsForRow(message, messageElement, messageIndex, preview);

    // A saved note grows the reply below the reader. Preserve the visible
    // message instead of letting the resize observer pin the chat to the
    // bottom; the preview keeps its own streaming scroll policy. Prepared rows
    // are detached, so they cannot move the live viewport and need no scan.
    if (preview || !messageElement[0]?.isConnected) applyResults();
    else changeMessageBelowReader(messageElement, applyResults);
}

function renderAllCompanionResults() {
    const rows = [...document.querySelectorAll('#chat > .mes[mesid]')]
        .map(element => ({ element, messageIndex: Number(element.getAttribute('mesid')) }))
        .filter(row => Number.isInteger(row.messageIndex) && row.messageIndex >= 0 && chat[row.messageIndex]);

    if (rows.length === 0) {
        notifyDiceCompanionHostsChanged();
        return;
    }

    // One prune and one anchor read for the whole chat, not a full document scan
    // for every row in it.
    const diceCardState = getDiceCardState();
    pruneDiceCardsExcept(diceCardState.keepMessageIndex);
    changeMessagesBelowReader(rows.map(row => row.element), () => {
        for (const { messageIndex } of rows) {
            renderCompanionResultsForRow(chat[messageIndex], $(`.mes[mesid="${messageIndex}"]`), messageIndex, null,
                { prune: false, diceCardState });
        }
    });
    notifyDiceCompanionHostsChanged();
}

let renderAllCompanionResultsQueued = false;

// Cleanup removes older notes above the reader. Wait for their scroll to stop
// so the anchor restore lands (iOS Safari drops it mid-scroll), and fold
// several cleanups into one redraw.
function scheduleRenderAllCompanionResults() {
    if (renderAllCompanionResultsQueued) return;
    renderAllCompanionResultsQueued = true;
    runWhenChatScrollSettles(() => {
        renderAllCompanionResultsQueued = false;
        renderAllCompanionResults();
    });
}

function hasRunnableCompanionAgents() {
    return areAgentsGloballyEnabled() && getEnabledAgents().some(agent => {
        return isCompanionAgent(agent) && !isDiceRollerAgent(agent) && String(agent.prompt ?? '').trim();
    });
}

export function updateCompanionButtonVisibility() {
    const shouldShow = hasRunnableCompanionAgents();
    $('.mes_run_companions').each(function () {
        const messageElement = $(this).closest('.mes');
        const isSystem = messageElement.attr('is_system') === 'true';
        $(this).toggle(shouldShow && !isSystem);
    });
}

async function copyText(text) {
    if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

async function runCompanionsFromMessageButton(messageIndex, button) {
    if (!isValidCompanionMessage(chat[messageIndex])) {
        toastr.warning('Companions cannot run on this message.');
        return;
    }

    if (!hasRunnableCompanionAgents()) {
        toastr.info('No enabled companion agents are ready to run.');
        updateCompanionButtonVisibility();
        return;
    }

    const runKey = String(messageIndex);
    if (companionMessageRuns.has(runKey)) {
        return;
    }

    companionMessageRuns.add(runKey);
    const buttonElement = $(button);
    buttonElement.addClass('mes_run_companions--running').prop('disabled', true);

    try {
        const results = await runCompanionsOnMessage(messageIndex);
        renderCompanionResultsForMessage(messageIndex);
        if (!Object.keys(results ?? {}).length) {
            toastr.info('No companion agents ran for this reply.');
        }
    } finally {
        companionMessageRuns.delete(runKey);
        buttonElement.removeClass('mes_run_companions--running').prop('disabled', false);
        updateCompanionButtonVisibility();
    }
}

async function sendChatOnlyAside({ agentId, messageIndex, transcript = '', userInput = '', button = null, inputField = null } = {}) {
    const agent = getAgentById(agentId);
    if (!agent || !isChatOnlyAgent(agent)) {
        toastr.warning('Chat Only is not available.');
        return;
    }

    const normalizedInput = normalizeChatOnlyInput(userInput);
    if (!normalizedInput) {
        toastr.warning('Type an aside first.');
        return;
    }

    if (!isAssistantMessage(chat[messageIndex])) {
        toastr.warning('No assistant reply yet to chat beside.');
        return;
    }

    const nextTranscript = appendChatOnlyUserMessage(transcript, normalizedInput);
    button?.prop?.('disabled', true);
    inputField?.prop?.('disabled', true);
    try {
        const result = await runCompanionAgentOnMessage(agentId, messageIndex, {
            pendingContent: nextTranscript,
            extraContextSections: [{
                title: 'Chat Only side chat',
                content: nextTranscript,
            }],
        });
        if (result?.status === 'done' && !result.lastRunError) inputField?.val?.('');
        renderCompanionResultsForMessage(messageIndex);
    } finally {
        button?.prop?.('disabled', false);
        inputField?.prop?.('disabled', false);
    }
}

export function getChatroomReplyRunOptions(agentId, messageIndex, viewerText) {
    const previousContent = getCompanionResults(chat[messageIndex])?.[agentId]?.content ?? '';
    let viewerName = '';
    try {
        viewerName = substituteParams('{{user}}');
    } catch {
        viewerName = '';
    }
    return buildChatroomReplyRunOptions({ previousContent, viewerName, viewerText });
}

const CHATROOM_POLL_OPTION_SELECTOR = '.custom-chatroom-poll-option';

/** Puts a vote for a tapped poll option into that chatroom's reply box. */
export function prefillChatroomPollVote(optionElement) {
    const labelElement = optionElement?.querySelector?.('.custom-chatroom-poll-label');
    const label = String(labelElement?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const inputElement = optionElement?.closest?.('.ica--companion-card, .ica--tpanel-agent')
        ?.querySelector?.('[data-role="chatroom-reply-input"]');
    if (!label || !inputElement) {
        return false;
    }

    inputElement.value = normalizeChatroomReply(`I vote ${label}`);
    inputElement.focus?.();
    return true;
}

async function sendChatroomUserReply({ agentId, messageIndex, userInput = '', button = null, inputField = null } = {}) {
    const agent = getAgentById(agentId);
    if (!agent || !isChatroomAgent(agent)) {
        toastr.warning('Chatroom reply is not available.');
        return;
    }

    const normalizedInput = normalizeChatroomReply(userInput);
    if (!normalizedInput) {
        toastr.warning('Type a reply first.');
        return;
    }

    if (!isAssistantMessage(chat[messageIndex])) {
        toastr.warning('No assistant reply yet to respond to.');
        return;
    }

    button?.prop?.('disabled', true);
    inputField?.prop?.('disabled', true);
    try {
        const result = await runCompanionAgentOnMessage(
            agentId,
            messageIndex,
            getChatroomReplyRunOptions(agentId, messageIndex, normalizedInput),
        );
        if (result?.status === 'done' && !result.lastRunError) inputField?.val?.('');
        renderCompanionResultsForMessage(messageIndex);
    } finally {
        button?.prop?.('disabled', false);
        inputField?.prop?.('disabled', false);
    }
}

async function savePlotCompassObjective({ agentId, messageIndex, objectives, button = null, inputField = null } = {}) {
    const agent = getAgentById(agentId);
    if (!agent || !isPlotCompassAgent(agent)) {
        toastr.warning('Plot Compass is not available.');
        return;
    }

    if (!isValidCompanionMessage(chat[messageIndex])) {
        toastr.warning('No message yet to plan from.');
        return;
    }

    const targetMessage = chat[messageIndex];
    const target = captureMessageTargetState(targetMessage);
    button?.prop?.('disabled', true);
    inputField?.prop?.('disabled', true);
    try {
        const identity = getPlotCompassIdentity();
        await saveAgent(agent.id, { update: draft => {
            if (!draft) return null;
            draft.settings = setPlotCompassObjectives(draft.settings, identity, objectives);
            return draft;
        } });
        if (!isMessageTargetCurrent(targetMessage, target, messageIndex)) {
            toastr.warning('The chat changed while saving, so the objective was saved but not run.');
            return;
        }
        await runCompanionAgentOnMessage(agentId, messageIndex);
        renderCompanionResultsForMessage(messageIndex);
        toastr.success('Plot Objectives saved.');
    } finally {
        button?.prop?.('disabled', false);
        inputField?.prop?.('disabled', false);
    }
}

function getCompanionActionContext(element) {
    const card = $(element).closest('.ica--companion-card');
    const messageIndex = getMessageIndexFromElement(element);
    const agentId = card.attr('data-agent-id') || '';
    const message = chat[messageIndex];
    const result = getCompanionResults(message)[agentId];

    return { card, messageIndex, agentId, message, result };
}

export async function editCompanionResult(messageIndex, agentId, message, result) {
    const isCurrent = captureCompanionResultTarget(messageIndex, agentId);
    const agent = getAgentById(agentId);
    const initialContent = result?.content ?? '';
    const useMemoryShardEditor = isMemoryShardTarget({ agent, content: initialContent });

    let editor;
    let memoryShardEditor = null;
    if (useMemoryShardEditor) {
        memoryShardEditor = createMemoryShardEditor({
            initialContent,
            maxLength: MAX_COMPANION_RESULT_CHARS,
        });
        editor = $(`
            <div class="ica--companion-edit-popup ica--companion-edit-popup-shard">
                <div class="ica--regex-note">Edit sections below or switch to Raw Markdown. Regenerate to ask the model again.</div>
                <div data-role="ms-editor-mount"></div>
                <div role="alert" data-role="note-error" hidden></div>
            </div>
        `);
        editor.find('[data-role="ms-editor-mount"]').append(memoryShardEditor.root);
    } else {
        editor = $(`
            <div class="ica--companion-edit-popup">
                <div class="ica--regex-note">Edit only this saved card. Regenerate to ask the model again.</div>
                <textarea class="text_pole textarea_compact" rows="12" aria-label="Saved companion note">${escapeHtml(initialContent)}</textarea>
                <div role="alert" data-role="note-error" hidden></div>
            </div>
        `);
        attachTextareaFullscreen(editor);
    }

    await new Popup(editor, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save Note',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
        onClosing: async popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const content = memoryShardEditor
                ? memoryShardEditor.getValue()
                : String(editor.find('textarea').val() ?? '');
            const error = !isCurrent()
                ? 'This note changed while you were editing. Copy your changes, then reopen it.'
                : content.length > MAX_COMPANION_RESULT_CHARS
                    ? 'Keep the note within 65,536 characters. Your draft is still here.'
                    : '';
            editor.find('[data-role="note-error"]').text(error).prop('hidden', !error);
            if (error) return false;
            updateCompanionResult(message, agentId, { status: 'done', content, error: '' });
            saveChatDebounced({ deferBackup: false });
            await emitCompanionResultsUpdated(messageIndex, agentId);
            renderCompanionResultsForMessage(messageIndex);
            return true;
        },
    }).show();
}

async function deleteCompanionCard(messageIndex, agentId, message) {
    const isCurrent = captureCompanionResultTarget(messageIndex, agentId);
    const popupResult = await new Popup('Delete this companion note?', POPUP_TYPE.CONFIRM).show();
    if (popupResult !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }
    if (!isCurrent()) {
        toastr.warning('That message changed while the confirmation was open, so the note was kept.');
        return;
    }

    deleteCompanionResult(message, agentId);
    saveChatDebounced({ deferBackup: false });
    await emitCompanionResultsUpdated(messageIndex, agentId);
    renderCompanionResultsForMessage(messageIndex);
}

const latestPreviewDetails = new WeakMap();

async function stopCompanionCard(button) {
    const agentId = $(button).closest('.ica--companion-card').attr('data-agent-id') || '';
    if (!agentId) return;
    const previewElement = $(button).closest('[data-roleplay-job]')[0] ?? null;
    let stopped;
    if (previewElement) {
        stopped = await stopServerReplyCompanion(previewElement.dataset.roleplayJob, agentId);
        const detail = latestPreviewDetails.get(previewElement);
        if (detail?.element?.isConnected) renderCompanionResultsForMessage(null, detail);
    } else {
        const messageIndex = getMessageIndexFromElement(button);
        stopped = await stopCompanionRun(messageIndex, agentId);
        renderCompanionResultsForMessage(messageIndex);
    }
    if (!stopped) toastr.info('This companion cannot be stopped yet. Try again in a moment.');
}

async function handleCompanionAction(event) {
    event.preventDefault();
    event.stopPropagation();

    const action = $(event.currentTarget).attr('data-action');
    if (action === 'stop') {
        await stopCompanionCard(event.currentTarget);
        return;
    }
    const { messageIndex, agentId, message, result } = getCompanionActionContext(event.currentTarget);
    if (!holdsReadableCompanionResults(message) || !agentId) {
        toastr.warning('Invalid companion note.');
        return;
    }

    if (action === 'regenerate') {
        await runCompanionAgentOnMessage(agentId, messageIndex);
        renderCompanionResultsForMessage(messageIndex);
        return;
    }

    if (action === 'fix') {
        const button = $(event.currentTarget);
        button.prop('disabled', true);
        try {
            await runCompanionAgentOnMessage(agentId, messageIndex, { repair: true });
        } finally {
            button.prop('disabled', false);
            renderCompanionResultsForMessage(messageIndex);
        }
        return;
    }

    if (action === 'chat-only-send') {
        const card = $(event.currentTarget).closest('.ica--companion-card');
        const inputField = card.find('[data-role="chat-only-input"]');
        await sendChatOnlyAside({
            agentId,
            messageIndex,
            transcript: result?.content ?? '',
            userInput: inputField.val(),
            button: $(event.currentTarget),
            inputField,
        });
        return;
    }

    if (action === 'chatroom-reply-send') {
        const card = $(event.currentTarget).closest('.ica--companion-card');
        const inputField = card.find('[data-role="chatroom-reply-input"]');
        await sendChatroomUserReply({
            agentId,
            messageIndex,
            userInput: inputField.val(),
            button: $(event.currentTarget),
            inputField,
        });
        return;
    }

    if (action === 'plot-compass-save') {
        const card = $(event.currentTarget).closest('.ica--companion-card');
        const inputField = card.find('[data-role="plot-compass-objective"]:not(:disabled), [data-role="plot-compass-enabled"]:not(:disabled)');
        await savePlotCompassObjective({
            agentId,
            messageIndex,
            objectives: readPlotCompassControls(card[0]),
            button: $(event.currentTarget),
            inputField,
        });
        return;
    }

    if (action === 'edit') {
        await editCompanionResult(messageIndex, agentId, message, result);
        return;
    }

    if (action === 'copy') {
        await copyText(String(result?.content ?? ''));
        toastr.success('Companion note copied.');
        return;
    }

    if (action === 'send-to-lorebook') {
        const button = $(event.currentTarget);
        button.prop('disabled', true);
        try {
            await sendCompanionResultToLorebook(result?.content);
        } finally {
            button.prop('disabled', false);
        }
        return;
    }

    if (action === 'delete') {
        await deleteCompanionCard(messageIndex, agentId, message);
    }
}

function persistCompanionCollapseState(event) {
    const details = event.target;
    const messageIndex = getMessageIndexFromElement(details);
    const agentId = $(details).attr('data-agent-id') || '';
    const message = chat[messageIndex];

    if (!holdsReadableCompanionResults(message) || !agentId) {
        return;
    }

    // Rendering a card as <details open> fires 'toggle' too. Only a real
    // change of state is saved, so redrawing cards never rewrites the chat.
    const collapsed = !details.open;
    const stored = getCompanionResults(message)[agentId];
    if (!stored || Boolean(stored.collapsed) === collapsed) {
        return;
    }

    const result = updateCompanionResult(message, agentId, { collapsed });
    if (result) {
        saveChatDebounced({ deferBackup: false });
    }
}

export function initCompanionCardUi() {
    if (companionUiInitialized) {
        return;
    }

    companionUiInitialized = true;
    const previewResults = new WeakMap();
    document.addEventListener('neconyan:roleplay-preview-rendered', ({ detail }) => {
        latestPreviewDetails.set(detail.element, detail);
        const signature = JSON.stringify(detail.message.extra?.inChatAgentCompanionResults ?? {});
        if (previewResults.get(detail.element) === signature) return;
        previewResults.set(detail.element, signature);
        renderCompanionResultsForMessage(null, detail);
    });
    // The saved reply replaces the preview in one DOM update. Render its notes
    // while the new rows are still detached, so they arrive at their final
    // height instead of growing the chat after it has been scrolled.
    document.addEventListener('neconyan:chat-rows-prepared', ({ detail }) => {
        const elements = Array.isArray(detail?.elements) ? detail.elements : [];
        for (const element of elements) {
            const messageIndex = Number(element?.getAttribute?.('mesid'));
            if (Number.isInteger(messageIndex) && messageIndex >= 0) {
                renderCompanionResultsForMessage(messageIndex, null, { element });
            }
        }
    });
    $(document).on('click', '.mes_run_companions', async function () {
        const messageIndex = getMessageIndexFromElement(this);
        if (messageIndex < 0) {
            toastr.warning('Invalid message.');
            return;
        }
        await runCompanionsFromMessageButton(messageIndex, this);
    });
    $(document).on('click', '.ica--companion-action, .ica--companion-control-action', event =>
        runCompanionViewAction(event.currentTarget, () => handleCompanionAction(event)));
    $(document).on('keydown', '.ica--companion-card [data-role="plot-compass-objective"]', submitPlotCompassOnEnter);
    // Document-level catch-all: covers cards and any other surface rendering companion
    // bodies. The panel binds its own element-level handler first (to close itself), and
    // its stopPropagation keeps this one from double-inserting.
    $(document).on('click', '.ica--choice-line', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (this.classList?.contains('ica--plot-choice')) {
            void togglePlotCompassChoice(this);
            return;
        }
        insertChoiceIntoMessageInput(this.dataset?.icaChoiceText ?? this.textContent);
    });
    $(document).on('click', CHATROOM_POLL_OPTION_SELECTOR, function (event) {
        if (prefillChatroomPollVote(this)) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
    document.addEventListener('toggle', event => {
        if (event.target?.classList?.contains('ica--companion-card')) {
            persistCompanionCollapseState(event);
        }
    }, true);

    eventSource.on(COMPANION_RESULTS_UPDATED_EVENT, ({ messageIndex } = {}) => {
        if (Number.isInteger(messageIndex)) {
            renderCompanionResultsForMessage(messageIndex);
        } else {
            scheduleRenderAllCompanionResults();
        }
        updateCompanionButtonVisibility();
    });

    const renderEvents = [
        event_types.CHAT_CHANGED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.MORE_MESSAGES_LOADED,
    ].filter(Boolean);

    for (const eventName of renderEvents) {
        eventSource.on(eventName, (messageIndex = null) => {
            if (Number.isInteger(messageIndex)) {
                renderCompanionResultsForMessage(messageIndex);
            } else {
                renderAllCompanionResults();
            }
            updateCompanionButtonVisibility();
        });
    }

    if (event_types.MESSAGE_DELETED) {
        // The payload is the deleted index, but every later message shifts down — re-render all.
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            renderAllCompanionResults();
            updateCompanionButtonVisibility();
        });
    }

    renderAllCompanionResults();
    updateCompanionButtonVisibility();
}
