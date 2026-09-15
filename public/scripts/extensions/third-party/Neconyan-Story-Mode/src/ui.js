/**
 * DOM layer: the story bar, the selection-rewrite row, block stamping, the
 * tap-to-edit bridge into the host's own message editor, the wand entry and
 * the settings drawer. The manuscript look itself is style.css under body.sbstory.
 */
import * as api from './api.js';
import { BODY_CLASS, DEFAULT_RULES, classifyBlock, computeJoins, formatDuration } from './core.js';

const BAR_ID = 'sbstory-bar';
const ROW_ID = 'sbstory-transforms';
const MENU_ITEM_ID = 'sbstory-menu-item';
const DRAWER_ID = 'sbstory-settings';
const HINT_KEY = 'SillyBunnyStoryMode_editHintShown';

let bar = null;
let directionWrap = null;
let directionInput = null;
let wordCount = null;
let barStatus = null;
let row = null;
let rowStatus = null;
let rowStop = null;
let transformRequest = null;
let customInstruction = '';
let rowSizeObserver = null;
let thinkingPopup = null;
let menuItem = null;
let nativeModeButton = null;
let drawer = null;
let drawerHandlers = { onChatToggle: null, onChange: null };
let menuToggle = null;
let lastEditor = null;
let cancelEditorReveal = null;
let selectionFrame = 0;
let listenerController = null;
let drawerIconObserver = null;
let drawerRerenderPending = false;
let drawerCharacter = undefined;
let editHintShown = false;
const cardDrafts = new Map();

function sameChat(context) {
    const current = api.ctx();
    return current.chat === context.chat && current.chatId === context.chatId
        && current.characterId === context.characterId && current.groupId === context.groupId;
}

/** Keep host shortcuts outside our popups, without cancelling native keys or Popup's own Enter handler. */
function containPopupKeys(event) {
    event.stopPropagation();
}

export function el(tag, { className = '', text = '', attrs = {} } = {}) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text) {
        node.textContent = text;
    }
    for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) {
            continue;
        }
        node.setAttribute(key, value === true ? '' : String(value));
    }
    return node;
}

function iconButton({ id, icon, label, title, className = 'menu_button menu_button_icon sbstory-btn', onClick }) {
    const button = el('button', { className, attrs: { type: 'button', id, title: title || label, 'aria-label': label } });
    button.append(
        el('i', { className: `fa-solid ${icon}`, attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'sbstory-btn-label', text: label }),
    );
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.stopPropagation();
        }
    });
    button.addEventListener('click', (event) => {
        event.preventDefault();
        void onClick(event);
    });
    return button;
}

// ---------------------------------------------------------------- story bar

export function mountBar() {
    if (bar) {
        placeBar();
        return bar;
    }
    bar = el('div', { className: 'flex-container flexGap5 sbstory-bar', attrs: { id: BAR_ID, hidden: true, role: 'group', 'aria-label': 'Story Mode', 'aria-busy': 'false' } });
    directionWrap = el('div', { className: 'sbstory-direction-wrap', attrs: { id: 'sbstory-direction-wrap', hidden: true } });
    directionInput = el('input', {
        className: 'text_pole sbstory-direction',
        attrs: {
            id: 'sbstory-direction',
            type: 'text',
            placeholder: 'Where should the next passage go?',
            'aria-label': 'Direction for the next passage',
            autocomplete: 'off',
        },
    });
    directionInput.addEventListener('keydown', (event) => {
        if (event.isComposing) {
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopImmediatePropagation();
            void onContinue();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            toggleDirection();
            document.getElementById('send_textarea')?.focus();
        }
    });
    directionInput.addEventListener('input', refreshDirectionToggle);
    directionWrap.append(directionInput);
    // fa-signs-post, not fa-compass: the host's own action row one line below already uses a compass.
    const directionToggle = iconButton({ id: 'sbstory-direction-toggle', icon: 'fa-signs-post', label: 'Direction', title: 'Tell the model where the next passage should go. Used once.', onClick: toggleDirection });
    directionToggle.setAttribute('aria-controls', 'sbstory-direction-wrap');
    directionToggle.setAttribute('aria-expanded', 'false');
    wordCount = el('small', { className: 'sbstory-words', attrs: { id: 'sbstory-words', title: 'Words in the manuscript (hidden blocks left out)' } });
    barStatus = el('span', { className: 'sbstory-status', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
    bar.append(
        iconButton({ id: 'sbstory-continue', icon: 'fa-feather-pointed', label: 'Continue', title: 'Continue the story from where the text stops. Text in the box is added first. (Alt+Enter)', onClick: onContinue }),
        iconButton({ id: 'sbstory-retry', icon: 'fa-arrows-rotate', label: 'Retry', title: 'Redo the last continuation (Alt+R)', onClick: () => runHistoryAction('retry', 'Retry') }),
        iconButton({ id: 'sbstory-undo', icon: 'fa-rotate-left', label: 'Undo', title: 'Remove the last continuation (Alt+Z)', onClick: () => runHistoryAction('undo', 'Undo') }),
        iconButton({ id: 'sbstory-redo', icon: 'fa-rotate-right', label: 'Redo', title: 'Put the last removed continuation back (Alt+Y)', onClick: () => runHistoryAction('redo', 'Redo') }),
        directionToggle,
        wordCount,
        iconButton({ id: 'sbstory-export', icon: 'fa-file-arrow-down', label: 'Export', title: 'Download the manuscript as plain text: no speaker names, hidden blocks left out.', onClick: exportManuscript }),
        directionWrap,
        barStatus,
    );
    placeBar();
    return bar;
}

/** Plain-text download of the manuscript; the host has no export without `Name:` prefixes. */
function exportManuscript() {
    const { text, fileName } = api.manuscript();
    if (!text) {
        api.toast('info', 'Nothing to export yet.');
        return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = el('a', { attrs: { href: url, download: fileName } });
    link.click();
    URL.revokeObjectURL(url);
}

function placeBar() {
    const sendForm = document.getElementById('send_form');
    const anchor = document.getElementById('nonQRFormItems');
    if (!sendForm || !bar) {
        return;
    }
    if (anchor && anchor.parentElement === sendForm) {
        if (bar.nextElementSibling !== anchor) {
            sendForm.insertBefore(bar, anchor);
        }
    } else if (bar.parentElement !== sendForm) {
        sendForm.prepend(bar);
    }
}

async function onContinue() {
    if (api.isBusy()) {
        return;
    }
    if (barStatus) barStatus.textContent = '';
    const textarea = document.getElementById('send_textarea');
    const hasText = Boolean(textarea && String(textarea.value).length);
    const direction = directionInput?.value?.trim() ?? '';
    await api.continueStory({ hasText, direction });
}

async function runHistoryAction(kind, label) {
    if (api.isBusy()) return;
    const context = { ...api.ctx() };
    if (barStatus) barStatus.textContent = '';
    try {
        const completed = await api[kind]();
        if (completed === true && sameChat(context) && barStatus && !bar.hidden && !barStatus.textContent) {
            barStatus.textContent = `${label} complete.`;
        }
    } catch (error) {
        console.error(`[Story Mode] ${kind} failed`, error);
        if (sameChat(context) && barStatus && !bar.hidden) {
            api.toast('error', `${label} failed. Try again.`);
        }
    }
}

/** Called from afterGeneration, not from streamed-token updates. */
export function reportGenerationResult(action) {
    if (action?.success && action.context && sameChat(action.context) && barStatus && !bar.hidden) {
        barStatus.textContent = 'Continuation added.';
    }
}

function toggleDirection() {
    if (!directionWrap) {
        return;
    }
    directionWrap.hidden = !directionWrap.hidden;
    document.getElementById('sbstory-direction-toggle')?.setAttribute('aria-expanded', String(!directionWrap.hidden));
    refreshDirectionToggle();
    if (!directionWrap.hidden) {
        directionInput.focus();
    }
}

/** The toggle lights up while a direction is typed but the panel is closed, so an armed Continue is visible. */
function refreshDirectionToggle() {
    const toggle = document.getElementById('sbstory-direction-toggle');
    if (!toggle || !directionWrap || !directionInput) {
        return;
    }
    const armed = directionWrap.hidden && directionInput.value.trim().length > 0;
    toggle.toggleAttribute('data-set', armed);
    toggle.title = armed
        ? `Next Continue is steered: "${directionInput.value.trim()}"`
        : 'Tell the model where the next passage should go. Used once.';
}

export function clearDirectionInput(submitted) {
    if (submitted === undefined && barStatus) barStatus.textContent = '';
    if (directionInput && (submitted === undefined || directionInput.value.trim() === submitted)) {
        directionInput.value = '';
        refreshDirectionToggle();
    }
}

export function setBusy(busy) {
    setRowBusy(busy);
    refreshMenuItem(api.isEnabled());
    if (!bar) {
        return;
    }
    bar.toggleAttribute('data-busy', Boolean(busy));
    bar.setAttribute('aria-busy', String(Boolean(busy)));
    for (const id of ['sbstory-continue', 'sbstory-retry', 'sbstory-undo', 'sbstory-redo', 'sbstory-direction-toggle', 'sbstory-direction']) {
        const button = document.getElementById(id);
        if (button) {
            button.disabled = Boolean(busy);
        }
    }
    if (!busy) {
        refreshBar();
    }
}

/** Undo/Retry/Redo only light up when the last block can actually be taken back or put back; the word count follows the chat. */
export function refreshBar() {
    if (!bar || bar.hidden || bar.hasAttribute('data-busy')) {
        return;
    }
    const revertable = api.canUndo();
    // ponytail: the whole manuscript is rebuilt on every refresh; cache per block if long chats ever make this noticeable.
    const { words } = api.manuscript();
    if (wordCount) {
        wordCount.replaceChildren(
            el('span', { className: 'sbstory-words-num', text: words.toLocaleString() }),
            el('span', { className: 'sbstory-words-unit', text: ` ${words === 1 ? 'word' : 'words'}` }),
        );
    }
    for (const [id, enabled] of [['sbstory-undo', revertable], ['sbstory-retry', revertable], ['sbstory-redo', api.canRedo()], ['sbstory-export', words > 0]]) {
        const button = document.getElementById(id);
        if (button) {
            button.disabled = !enabled;
        }
    }
}

// ---------------------------------------------------------------- selection rewrites (inside the host editor)

export function mountTransformRow() {
    if (row) {
        return row;
    }
    row = el('div', { className: 'sbstory-transforms', attrs: { id: ROW_ID, hidden: true, role: 'group', 'aria-label': 'Rewrite the selected text' } });
    for (const [kind, label, icon, title] of [
        ['rewrite', 'Rewrite', 'fa-pen-nib', 'Rewrite the selection for clarity and flow'],
        ['expand', 'Expand', 'fa-up-right-and-down-left-from-center', 'Expand the selection with more detail'],
        ['compress', 'Compress', 'fa-down-left-and-up-right-to-center', 'Tighten the selection'],
        ['custom', 'Custom…', 'fa-wand-magic-sparkles', 'Change the selection with your own instruction'],
    ]) {
        row.append(iconButton({ icon, label, title, className: 'menu_button sbstory-tbtn', onClick: () => runTransform(kind) }));
    }
    rowStop = iconButton({ icon: 'fa-stop', label: 'Stop', title: 'Stop waiting for the rewrite', className: 'menu_button sbstory-tbtn sbstory-stop', onClick: () => cancelTransform({ restoreFocus: true }) });
    rowStop.hidden = true;
    rowStatus = el('small', { className: 'sbstory-tstatus' });
    row.append(rowStop, rowStatus);
    rowSizeObserver = new ResizeObserver(() => {
        // Include the margin, sticky offset and breathing room, even when controls or status wrap.
        const height = row.hidden || !row.isConnected ? 0 : Math.ceil(row.getBoundingClientRect().height) + 20;
        document.body.style.setProperty('--sbstory-row-slot', `${height}px`);
    });
    rowSizeObserver.observe(row);
    return row;
}

function currentEditSelection() {
    const textarea = document.getElementById('curEditTextarea');
    if (!textarea) {
        return null;
    }
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    return end > start ? { textarea, start, end, direction: textarea.selectionDirection } : null;
}

function setStatus(text) {
    if (rowStatus && rowStatus.textContent !== text) {
        rowStatus.textContent = text;
    }
    // One live result survives the selection row closing; the visible row stays quiet.
    if (text && barStatus && !bar.hidden && barStatus.textContent !== text) {
        barStatus.textContent = text;
    }
}

export function refreshTransformRow() {
    if (!row) {
        return;
    }
    if (!document.body.classList.contains(BODY_CLASS)) {
        cancelTransform();
        hideRow();
        return;
    }
    const selection = currentEditSelection();
    const textarea = selection?.textarea ?? document.getElementById('curEditTextarea');
    if (!textarea || (!selection && !transformRequest)) {
        hideRow();
        return;
    }
    const host = textarea.parentElement;
    if (host && (row.parentElement !== host || row.previousElementSibling !== textarea)) {
        host.insertBefore(row, textarea.nextSibling);
    }
    row.hidden = false;
    setRowBusy(api.isBusy());
}

function hideRow() {
    if (row) {
        row.hidden = true;
    }
    document.body.style.removeProperty('--sbstory-row-slot');
    if (!transformRequest) {
        setStatus('');
    }
}

function setRowBusy(busy) {
    if (!row) {
        return;
    }
    row.toggleAttribute('data-busy', busy);
    row.setAttribute('aria-busy', String(Boolean(busy)));
    for (const button of row.querySelectorAll('.sbstory-tbtn:not(.sbstory-stop)')) {
        button.disabled = Boolean(busy);
    }
    if (rowStop) {
        rowStop.hidden = !transformRequest;
    }
}

function currentTransform(request) {
    const { textarea, context, character, message, mesid } = request;
    return transformRequest === request && !request.controller.signal.aborted
        && document.body.classList.contains(BODY_CLASS) && sameChat(context)
        && api.currentCharacter() === character && context.chat?.[mesid] === message
        && textarea.isConnected && textarea === document.getElementById('curEditTextarea');
}

function originalSelection(request) {
    return request.textarea.value === request.value
        && request.textarea.selectionStart === request.start && request.textarea.selectionEnd === request.end;
}

function restoreTransformFocus(request) {
    if (currentTransform(request) && originalSelection(request)) {
        request.textarea.focus({ preventScroll: true });
        request.textarea.setSelectionRange(request.start, request.end, request.direction);
    }
}

async function askInstruction(request) {
    const { context } = request;
    if (typeof context.Popup === 'function') {
        const content = el('div');
        content.append(
            el('h3', { text: 'Custom rewrite', attrs: { id: 'sbstory-custom-title' } }),
            el('p', { text: 'What should change in the selected passage?', attrs: { id: 'sbstory-custom-help' } }),
        );
        const popup = new context.Popup(content, context.POPUP_TYPE.INPUT, customInstruction, { okButton: 'Rewrite', cancelButton: 'Cancel' });
        popup.dlg.setAttribute('aria-labelledby', 'sbstory-custom-title');
        popup.mainInput.setAttribute('aria-labelledby', 'sbstory-custom-title');
        popup.mainInput.setAttribute('aria-describedby', 'sbstory-custom-help');
        popup.dlg.addEventListener('keydown', containPopupKeys);
        const cancel = () => void popup.completeCancelled();
        request.controller.signal.addEventListener('abort', cancel, { once: true });
        try {
            return await popup.show();
        } finally {
            request.controller.signal.removeEventListener('abort', cancel);
            restoreTransformFocus(request);
        }
    }
    return globalThis.prompt?.('What should change in the selected passage?', customInstruction) ?? null;
}

async function runTransform(kind) {
    const selection = currentEditSelection();
    if (!selection || transformRequest || api.isBusy() || !document.body.classList.contains(BODY_CLASS)) {
        return;
    }
    const { textarea, start, end } = selection;
    const value = textarea.value;
    const controller = new AbortController();
    const context = { ...api.ctx() };
    const mesid = Number(textarea.closest('.mes')?.getAttribute('mesid'));
    const request = { ...selection, value, controller, context, mesid, message: context.chat?.[mesid], character: api.currentCharacter() };
    transformRequest = request;
    api.setTransformBusy(true);
    try {
        let instruction = '';
        if (kind === 'custom') {
            setStatus('Waiting for your instruction.');
            const answer = await askInstruction(request);
            if (!currentTransform(request)) {
                return;
            }
            if (answer === null || answer === undefined || answer === false || !String(answer).trim()) {
                restoreTransformFocus(request);
                setStatus('Rewrite cancelled. Your text is unchanged.');
                return;
            }
            instruction = String(answer);
            customInstruction = instruction;
        }
        if (!currentTransform(request) || !originalSelection(request)) {
            if (currentTransform(request)) {
                setStatus('The text or selection changed. Select the passage again to rewrite it.');
            }
            return;
        }
        setStatus('Working...');
        const result = await api.runTransform({ kind, instruction, value, start, end, signal: controller.signal });
        if (!currentTransform(request)) {
            return;
        }
        if (!result) {
            setStatus('Nothing came back. Your text is unchanged; try again.');
            return;
        }
        if (!originalSelection(request)) {
            setStatus('The text or selection changed while waiting, so nothing was replaced.');
            return;
        }
        textarea.focus();
        textarea.setSelectionRange(start, end);
        let undoable = false;
        try {
            undoable = document.execCommand?.('insertText', false, result) === true;
        } catch {
            // Fall back below when the browser does not support undoable scripted insertion.
        }
        if (!undoable) {
            textarea.setRangeText(result, start, end, 'select');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        textarea.setSelectionRange(start, start + result.length);
        if (kind === 'custom') {
            customInstruction = '';
        }
        setStatus(undoable ? 'Replaced. Ctrl+Z undoes it; Done or Escape keeps it.' : 'Replaced. Done or Escape keeps it.');
    } catch (error) {
        if (!currentTransform(request)) {
            return;
        }
        if (error?.name === 'AbortError') {
            setStatus('Stopped.');
        } else {
            console.error('[Story Mode] rewrite failed', error);
            setStatus('Rewrite failed. Your text is unchanged; try again.');
        }
    } finally {
        if (transformRequest === request) {
            transformRequest = null;
            api.setTransformBusy(false);
            refreshTransformRow();
        }
    }
}

export function cancelTransform({ restoreFocus = false } = {}) {
    const request = transformRequest;
    if (!request) {
        return;
    }
    if (restoreFocus) {
        restoreTransformFocus(request);
    }
    transformRequest = null;
    request.controller.abort();
    api.setTransformBusy(false);
    setStatus(sameChat(request.context) ? 'Stopped. No text was replaced.' : '');
    refreshTransformRow();
}

function scheduleSelectionRefresh() {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(() => refreshTransformRow());
}

export function bindSelectionWatch() {
    if (document.documentElement.dataset.sbstorySelection) {
        return;
    }
    listenerController ??= new AbortController();
    const { signal } = listenerController;
    document.documentElement.dataset.sbstorySelection = '1';
    document.addEventListener('selectionchange', scheduleSelectionRefresh, { signal });
    for (const type of ['mouseup', 'keyup', 'touchend', 'select']) {
        document.addEventListener(type, (event) => {
            if (event.target instanceof Element && event.target.id === 'curEditTextarea') {
                scheduleSelectionRefresh();
            }
        }, { capture: true, signal });
    }
}

/** Called from the #chat mutation observer: notices a host editor opening so an unchanged close keeps its cuts. */
export function checkEditor() {
    if (!document.body.classList.contains(BODY_CLASS)) {
        return;
    }
    for (const reasoning of document.querySelectorAll('#chat .reasoning_edit_textarea')) {
        reasoning.setAttribute('aria-label', 'Edit reasoning');
        const details = reasoning.closest('details');
        if (details) {
            details.open = true;
        }
    }
    const textarea = document.getElementById('curEditTextarea');
    if (transformRequest && !currentTransform(transformRequest)) {
        cancelTransform();
    }
    if (lastEditor?.textarea === textarea) {
        return;
    }
    cancelEditorReveal?.();
    if (lastEditor && !textarea && sameChat(lastEditor.context) && !api.isBusy()) {
        const focused = document.activeElement;
        if (!focused || focused === document.body || lastEditor.mes.contains(focused) || row?.contains(focused)) {
            lastEditor.mes.querySelector('.mes_edit')?.focus({ preventScroll: true });
        }
    }
    lastEditor = null;
    if (!textarea) {
        hideRow();
        return;
    }
    const mes = textarea.closest('.mes');
    const mesid = Number(mes?.getAttribute('mesid'));
    if (!Number.isInteger(mesid)) {
        return;
    }
    textarea.setAttribute('aria-label', `Edit passage ${mesid + 1}`);
    lastEditor = { textarea, mes, context: { ...api.ctx() } };
    api.noteEditOpened(mesid);
    revealEditor(textarea);
}

// ---------------------------------------------------------------- block stamping (origin, joins, model-tail shading)

export function stampBlocks() {
    const context = api.ctx();
    const chat = context.chat;
    if (!Array.isArray(chat)) {
        return;
    }
    const joins = computeJoins(chat);
    const shading = api.getSettings().shading;
    for (const mesEl of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(mesEl.getAttribute('mesid'));
        const message = chat[index];
        if (!message) {
            continue;
        }
        const { origin, cut } = classifyBlock(message);
        mesEl.dataset.sbstoryOrigin = origin;
        if (joins.has(index)) {
            mesEl.dataset.sbstoryJoin = '';
        } else {
            delete mesEl.dataset.sbstoryJoin;
        }
        if (origin === 'mixed' && shading) {
            wrapTail(mesEl, message, index, cut);
        } else {
            unwrapTail(mesEl);
        }
        updateThinkingButton(mesEl, message);
    }
}

export function cleanupStamps() {
    for (const mesEl of document.querySelectorAll('#chat .mes[data-sbstory-origin]')) {
        delete mesEl.dataset.sbstoryOrigin;
        delete mesEl.dataset.sbstoryJoin;
        unwrapTail(mesEl);
    }
    for (const btn of document.querySelectorAll('.sbstory-thinking-btn')) {
        btn.remove();
    }
    const popup = thinkingPopup;
    thinkingPopup = null;
    void popup?.completeCancelled();
}

function unwrapTail(mesEl) {
    const text = mesEl.querySelector('.mes_text');
    if (!text || !text.querySelector('.sbstory-model')) {
        return;
    }
    for (const span of text.querySelectorAll('.sbstory-model')) {
        span.replaceWith(...span.childNodes);
    }
    text.normalize();
    delete text.dataset.sbstoryWrapped;
}

/**
 * Shades the model's part of a block the user started. The user's prefix is
 * rendered the same way the host renders the block, and its visible length is
 * used to find the split point in the rendered text.
 * ponytail: markup that spans the cut moves the shading by a few characters.
 */
function wrapTail(mesEl, message, index, cut) {
    const text = mesEl.querySelector('.mes_text');
    if (!text || text.querySelector('#curEditTextarea')) {
        return;
    }
    const key = `${cut}:${String(message.mes ?? '').length}`;
    if (text.dataset.sbstoryWrapped === key && text.querySelector('.sbstory-model')) {
        return;
    }
    unwrapTail(mesEl);
    let prefixLength = 0;
    try {
        const html = api.ctx().messageFormatting(String(message.mes ?? '').slice(0, cut), message.name, message.is_system, message.is_user, index, {}, false);
        const probe = document.createElement('div');
        probe.innerHTML = html;
        prefixLength = probe.textContent.replace(/\s+$/u, '').length;
    } catch (error) {
        console.warn('[Story Mode] could not measure the user prefix', error);
        return;
    }
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    const tail = [];
    let seen = 0;
    let node;
    while ((node = walker.nextNode())) {
        const length = node.nodeValue.length;
        if (seen + length <= prefixLength) {
            seen += length;
            continue;
        }
        if (seen < prefixLength) {
            node.splitText(prefixLength - seen);
            seen = prefixLength;
            continue;
        }
        tail.push(node);
    }
    for (const textNode of tail) {
        if (!textNode.nodeValue) {
            continue;
        }
        const span = document.createElement('span');
        span.className = 'sbstory-model';
        textNode.replaceWith(span);
        span.append(textNode);
    }
    text.dataset.sbstoryWrapped = key;
}

// ---------------------------------------------------------------- consolidated reasoning dialog & button

export function updateThinkingButton(mesEl, message) {
    const buttons = mesEl.querySelector('.mes_buttons');
    if (!buttons) {
        return;
    }
    let btn = buttons.querySelector('.sbstory-thinking-btn');
    const reasonings = api.getMessageReasonings(message);
    if (!reasonings || reasonings.length === 0) {
        btn?.remove();
        return;
    }
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mes_button sbstory-thinking-btn fa-solid fa-brain';
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            const index = Number(mesEl.getAttribute('mesid'));
            const msg = api.ctx().chat?.[index] ?? message;
            void openThinkingDialog(msg, btn);
        });
        btn.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.stopPropagation();
            }
        });
        buttons.appendChild(btn);
    }
    const count = reasonings.length;
    const duration = reasonings.reduce((sum, r) => sum + (Number(r.duration) || 0), 0);
    const timeStr = duration > 0 ? ` (${formatDuration(duration)})` : '';
    btn.title = count > 1
        ? `View ${count} reasoning thoughts${timeStr}`
        : `View reasoning trace${timeStr}`;
    btn.setAttribute('aria-label', btn.title);
}

async function copyReasoning(text) {
    const focused = document.activeElement;
    try {
        const context = api.ctx();
        const { copyText } = typeof context.copyText === 'function' ? context : await import('/scripts/utils.js');
        const clipboard = typeof globalThis.navigator?.clipboard?.writeText === 'function';
        const execCommand = document.execCommand;
        let copied = false;
        let result;
        try {
            if (!clipboard) {
                // The host's synchronous fallback drops this result. Restore the method before awaiting anything.
                document.execCommand = function (...args) {
                    try {
                        const success = execCommand?.apply(this, args) === true;
                        if (args[0] === 'copy') copied = success;
                        return success;
                    } catch {
                        return false;
                    }
                };
            }
            result = copyText(text);
        } finally {
            if (!clipboard) document.execCommand = execCommand;
        }
        const outcome = await result;
        if (outcome === false || (!clipboard && !copied && outcome !== true)) {
            throw new Error('The browser did not confirm the copy.');
        }
        api.toast('success', 'Reasoning copied.');
    } catch (error) {
        console.warn('[Story Mode] copy failed', error);
        api.toast('error', 'Could not copy. Select the text and copy it manually.');
    } finally {
        if (focused?.isConnected && document.activeElement === document.body) {
            focused.focus({ preventScroll: true });
        }
    }
}

export async function openThinkingDialog(message, opener = document.activeElement) {
    const reasonings = api.getMessageReasonings(message);
    if (!reasonings.length || thinkingPopup) {
        return;
    }
    const context = { ...api.ctx() };
    const content = el('div', { className: 'sbstory-dialog-content' });
    const header = el('div', { className: 'sbstory-dialog-header' });
    const titleWrap = el('div', { className: 'sbstory-dialog-title-wrap' });
    titleWrap.append(
        el('i', { className: 'fa-solid fa-brain', attrs: { 'aria-hidden': 'true' } }),
        el('h3', { text: 'Reasoning Trace', attrs: { id: 'sbstory-thinking-title' } }),
    );
    const actions = el('div', { className: 'sbstory-dialog-header-actions' });
    const copyBtn = el('button', { className: 'menu_button sbstory-dialog-btn fa-solid fa-copy', attrs: { type: 'button', title: 'Copy all reasoning', 'aria-label': 'Copy all reasoning' } });
    copyBtn.addEventListener('click', async () => {
        const fullText = reasonings.map((r, i) => {
            const label = reasonings.length > 1
                ? `[${i === 0 ? 'Passage 1' : 'Continuation ' + i}${r.duration ? ' - ' + formatDuration(r.duration) : ''}]\n`
                : '';
            return `${label}${r.text}`;
        }).join('\n\n');
        await copyReasoning(fullText);
    });

    const closeBtn = el('button', { className: 'menu_button sbstory-dialog-btn fa-solid fa-xmark', attrs: { type: 'button', title: 'Close', 'aria-label': 'Close reasoning', autofocus: true } });
    actions.append(copyBtn, closeBtn);
    header.append(titleWrap, actions);

    const body = el('div', { className: 'sbstory-dialog-body', attrs: { tabindex: '0', role: 'region', 'aria-label': 'Reasoning history' } });

    reasonings.forEach((entry, i) => {
        const entryEl = document.createElement('details');
        entryEl.className = 'sbstory-thought-entry';
        entryEl.open = true;

        const summary = document.createElement('summary');
        summary.className = 'sbstory-thought-summary';

        const label = document.createElement('span');
        label.className = 'sbstory-thought-label';
        label.textContent = reasonings.length > 1
            ? (i === 0 ? 'Passage 1' : `Continuation ${i}`)
            : 'Thoughts';
        summary.appendChild(label);

        if (entry.duration) {
            const dur = document.createElement('span');
            dur.className = 'sbstory-thought-duration';
            dur.textContent = formatDuration(entry.duration);
            summary.appendChild(dur);
        }

        const stepCopy = document.createElement('button');
        stepCopy.type = 'button';
        stepCopy.className = 'sbstory-thought-copy fa-solid fa-copy';
        stepCopy.title = 'Copy this thought';
        stepCopy.setAttribute('aria-label', `Copy ${label.textContent.toLowerCase()}`);
        stepCopy.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await copyReasoning(entry.text);
        });
        summary.appendChild(stepCopy);

        const textDiv = document.createElement('div');
        textDiv.className = 'sbstory-thought-text';
        textDiv.textContent = entry.text;

        entryEl.append(summary, textDiv);
        body.appendChild(entryEl);
    });

    content.append(header, body);
    const popup = new context.Popup(content, context.POPUP_TYPE.DISPLAY, '', { leftAlign: true });
    thinkingPopup = popup;
    popup.dlg.id = 'sbstory-thinking-dialog';
    popup.dlg.classList.add('sbstory-dialog');
    popup.dlg.setAttribute('aria-labelledby', 'sbstory-thinking-title');
    popup.dlg.addEventListener('keydown', containPopupKeys);
    popup.closeButton.style.display = 'none';
    closeBtn.addEventListener('click', () => void popup.completeCancelled());
    popup.dlg.addEventListener('click', (event) => {
        if (event.target !== popup.dlg) return;
        const rect = popup.dlg.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
            void popup.completeCancelled();
        }
    });
    try {
        await popup.show();
    } finally {
        if (thinkingPopup === popup) {
            thinkingPopup = null;
            if (sameChat(context) && opener?.isConnected && document.body.classList.contains(BODY_CLASS)) {
                opener.focus({ preventScroll: true });
            }
        }
    }
}

// ---------------------------------------------------------------- tap to edit, Escape saves

function showEditHintOnce() {
    if (editHintShown) {
        return;
    }
    editHintShown = true;
    const storage = api.ctx().accountStorage;
    try {
        if (storage?.getItem?.(HINT_KEY)) {
            return;
        }
        storage?.setItem?.(HINT_KEY, '1');
    } catch {
        // The hint still works when account storage is unavailable.
    }
    api.toast('info', 'Tap a paragraph to edit, or Tab to its Edit button. Select text to rewrite it. Done or Escape saves.');
}

export function bindClickToEdit() {
    const chat = document.getElementById('chat');
    if (!chat || chat.dataset.sbstoryBound) {
        return;
    }
    listenerController ??= new AbortController();
    chat.dataset.sbstoryBound = '1';
    document.addEventListener('click', (event) => {
        if (!transformRequest || !(event.target instanceof Element)) {
            return;
        }
        if (event.target.closest('.mes_edit, .mes_edit_done, .mes_edit_cancel, .mes_edit_up, .mes_edit_down, .mes_edit_copy, .mes_edit_delete, .mes_delete, .mes_hide, .mes_unhide, .mes_swipe_picker, .mes_reasoning_edit, .mes_reasoning_edit_done, .mes_reasoning_edit_cancel, .mes_edit_add_reasoning, .mes_reasoning_delete, #mes_stop')) {
            // Host controls commit synchronously before their first await. Cancel before they see the click.
            cancelTransform();
        } else if (event.target.closest('#send_but, #mes_continue, #option_continue, #option_regenerate, #mes_impersonate, #option_impersonate, #sb_prose_polisher_but, .swipe_left, .swipe_right, .mes_delete_add_swipe')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            setStatus('Stop the rewrite before changing the story.');
        }
    }, { capture: true, signal: listenerController.signal });
    chat.addEventListener('click', (event) => {
        if (!document.body.classList.contains(BODY_CLASS)) {
            return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        if (target.closest('#curEditTextarea, #sbstory-transforms, a, img, video, audio, summary, details, button, input, textarea, select, label, [role="button"], [tabindex], [contenteditable], .interactable, .mes_buttons, .mes_edit_buttons, .swipe_left, .swipeRightBlock, .code-copy, .mes_reasoning_details')) {
            return;
        }
        if (api.isBusy()) {
            if (transformRequest) setStatus('Stop the rewrite before editing another passage.');
            return;
        }
        const editing = document.getElementById('curEditTextarea');
        const mes = target.closest('.mes');
        if (!mes) {
            if (editing) {
                editing.closest('.mes')?.querySelector('.mes_edit_done')?.click();
            }
            return;
        }
        if (!target.closest('.mes_text')) {
            return;
        }
        if (editing && editing.closest('.mes') === mes) {
            return;
        }
        if (String(globalThis.getSelection?.() ?? '').length > 0) {
            return;
        }
        const button = mes.querySelector('.mes_edit');
        if (!button) {
            return;
        }
        button.click();
    }, { signal: listenerController.signal });
}

/**
 * The host keeps the chat's scroll position when an editor opens, so a tap near
 * the bottom leaves the box off-screen. It also re-anchors the chat for eight
 * frames after every resize of the block (and, on narrow viewports, restores the
 * old position 200ms after opening), undoing any earlier scroll; reveal the box
 * once the block has stopped resizing and that window has passed.
 */
function revealEditor(textarea) {
    cancelEditorReveal?.();
    const mes = textarea.closest('.mes');
    if (!mes) {
        return;
    }
    const notBefore = performance.now() + 260;
    const context = { ...api.ctx() };
    let frame = 0;
    let frames = 0;
    let done = false;
    let timeout;
    const observer = new ResizeObserver(() => arm());
    const cancel = () => {
        done = true;
        observer.disconnect();
        cancelAnimationFrame(frame);
        clearTimeout(timeout);
        if (cancelEditorReveal === cancel) cancelEditorReveal = null;
    };
    const reveal = () => {
        if (done) return;
        cancel();
        if (sameChat(context) && textarea.isConnected && textarea === document.getElementById('curEditTextarea') && document.body.classList.contains(BODY_CLASS)) {
            textarea.scrollIntoView({ block: 'nearest' });
        }
    };
    const tick = () => {
        frames++;
        if (frames >= 10 && performance.now() >= notBefore) {
            reveal();
            return;
        }
        frame = requestAnimationFrame(tick);
    };
    const arm = () => {
        cancelAnimationFrame(frame);
        frames = 0;
        frame = requestAnimationFrame(tick);
    };
    cancelEditorReveal = cancel;
    observer.observe(mes);
    arm();
    timeout = setTimeout(reveal, 1500);
}

/** Alt+letter runs the matching bar button (physical keys, so the layout does not matter). */
const HOTKEY_BUTTONS = { KeyR: 'sbstory-retry', KeyZ: 'sbstory-undo', KeyY: 'sbstory-redo' };

/** Match the host's swipe condition, including focused buttons, but leave text fields' arrow keys alone. */
function composerIdle() {
    const composer = document.getElementById('send_textarea');
    const focused = document.activeElement;
    if (composer && String(composer.value) !== '') {
        return false;
    }
    return focused === composer || !(focused instanceof Element)
        || !focused.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), video');
}

/** Keyboard layer: Alt+Enter continue, Alt+R/Z/Y, host swipe keys held off, Escape keeps an edit. */
export function bindEscapeSave() {
    if (document.documentElement.dataset.sbstoryEscape) {
        return;
    }
    listenerController ??= new AbortController();
    document.documentElement.dataset.sbstoryEscape = '1';
    document.addEventListener('keydown', (event) => {
        if (event.isComposing || !document.body.classList.contains(BODY_CLASS)) {
            return;
        }
        const popupOpen = Boolean(document.querySelector('dialog[open]'));
        if (popupOpen) {
            return;
        }
        const editButton = event.target instanceof Element ? event.target.closest('.mes_edit') : null;
        if (event.key === ' ' && editButton && !editButton.classList.contains('disabled') && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            event.stopImmediatePropagation();
            editButton.click();
            return;
        }
        if (transformRequest && ((event.key === 'Enter' && (event.altKey || event.ctrlKey || (event.target?.id === 'send_textarea' && !event.shiftKey)))
            || (event.key === 'ArrowUp' && composerIdle()))) {
            event.preventDefault();
            event.stopImmediatePropagation();
            setStatus('Stop the rewrite before changing the story.');
            return;
        }
        if (event.altKey && !event.metaKey) {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!api.isBusy()) {
                    void onContinue();
                }
                return;
            }
            // Ctrl+Alt is how Windows reports AltGr, which international layouts use to type ordinary characters.
            const buttonId = event.ctrlKey ? null : HOTKEY_BUTTONS[event.code];
            if (buttonId) {
                event.preventDefault();
                event.stopImmediatePropagation();
                document.getElementById(buttonId)?.click();
                return;
            }
        }
        // The host swipes the whole last block on a bare ArrowLeft/ArrowRight; in a manuscript that is a stray keypress away from losing a passage.
        if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && composerIdle()) {
            event.stopImmediatePropagation();
            return;
        }
        if (event.key !== 'Escape') {
            return;
        }
        if (transformRequest) {
            event.preventDefault();
            event.stopImmediatePropagation();
            cancelTransform({ restoreFocus: true });
            return;
        }
        const textarea = document.getElementById('curEditTextarea');
        const editingMessage = textarea?.closest('.mes');
        const focused = document.activeElement;
        if (!textarea || (focused !== textarea && !row?.contains(focused) && !editingMessage?.contains(focused))) {
            return;
        }
        if (document.querySelector('.autoComplete-wrap[data-macros-autocomplete-style], .autoComplete-detailsWrap[data-macros-autocomplete-style]')) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        textarea.closest('.mes')?.querySelector('.mes_edit_done')?.click();
    }, { capture: true, signal: listenerController.signal });
}

// ---------------------------------------------------------------- wand entry

export function ensureMenuItem({ onToggle }) {
    const host = document.getElementById('extensionsMenu');
    if (!host) {
        return;
    }
    menuToggle = onToggle;
    const modes = document.getElementById('sb_character_mode_toggle');
    if (document.body.classList.contains('neconyan') && modes && !nativeModeButton) {
        nativeModeButton = el('button', {
            className: 'sb-character-shell-mode-button',
            attrs: { id: 'sbstory-mode-button', type: 'button', 'aria-pressed': 'false' },
        });
        nativeModeButton.append(
            el('i', { className: 'fa-solid fa-book-open', attrs: { 'aria-hidden': 'true' } }),
            el('span', { text: 'Story Mode' }),
        );
        nativeModeButton.addEventListener('click', async () => {
            nativeModeButton.disabled = true;
            try {
                const chatVisible = Boolean(document.getElementById('chat')?.getClientRects().length);
                const changed = await menuToggle?.(chatVisible ? undefined : true);
                if (changed) document.getElementById('sb_character_shell_close')?.click();
            } finally {
                refreshMenuItem(api.isEnabled());
            }
        });
        modes.insertAdjacentElement('afterend', nativeModeButton);
        window.addEventListener('neconyan:hopper-state-changed', refreshNativeMode);
        window.addEventListener('sb:conversation-workspace-state-changed', refreshNativeMode);
    }
    if (!menuItem) {
        // Wand entries must be divs: the host styles `#extensionsMenu > div`.
        menuItem = el('div', { className: 'list-group-item flex-container flexGap5 interactable', attrs: { id: MENU_ITEM_ID, role: 'button', tabindex: '0' } });
        menuItem.append(
            el('div', { className: 'fa-solid fa-feather-pointed extensionsMenuExtensionButton', attrs: { 'aria-hidden': 'true' } }),
            el('span', { className: 'sbstory-menu-label', text: 'Story Mode' }),
            el('span', { className: 'sbstory-menu-state' }),
        );
        const activate = (event) => {
            event.preventDefault();
            void menuToggle?.();
        };
        menuItem.addEventListener('click', activate);
        menuItem.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation();
                activate(event);
            }
        });
    }
    if (menuItem.parentElement !== host) {
        host.append(menuItem);
    }
    refreshMenuItem(api.isEnabled());
    // a11y.js restamps every `.options-content .list-group-item` as a listitem a tick later.
    setTimeout(() => menuItem?.setAttribute('role', 'button'), 0);
}

function refreshNativeMode() {
    refreshMenuItem(api.isEnabled());
}

export function refreshMenuItem(enabled) {
    if (nativeModeButton) {
        nativeModeButton.disabled = !api.hasChat() || api.isBusy();
        const visible = enabled && Boolean(document.getElementById('chat')?.getClientRects().length);
        nativeModeButton.setAttribute('aria-pressed', String(Boolean(visible)));
        nativeModeButton.title = !api.hasChat() ? 'Open a chat to use Story Mode'
            : visible ? 'Turn Story Mode off for this chat' : 'Write this chat as a continuous story';
    }
    if (!menuItem) {
        return;
    }
    const state = menuItem.querySelector('.sbstory-menu-state');
    if (state) {
        state.textContent = enabled ? 'On' : 'Off';
        state.toggleAttribute('data-on', Boolean(enabled));
    }
    menuItem.title = enabled ? 'Turn Story Mode off for this chat' : 'Turn Story Mode on for this chat';
    menuItem.setAttribute('aria-pressed', String(Boolean(enabled)));
    menuItem.setAttribute('role', 'button');
}

// ---------------------------------------------------------------- settings drawer

export function ensureDrawer(handlers) {
    drawerHandlers = { ...drawerHandlers, ...handlers };
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        return;
    }
    if (!drawer) {
        drawer = el('div', { className: 'inline-drawer sbstory-drawer', attrs: { id: DRAWER_ID, 'data-extension-name': 'SillyBunny-Story-Mode' } });
        // Same markup as every bundled drawer so host and theme CSS style it; the host toggles it on click.
        const toggle = el('div', { className: 'inline-drawer-toggle inline-drawer-header', attrs: { role: 'button', tabindex: '0', 'aria-expanded': 'false', 'aria-controls': `${DRAWER_ID}-content` } });
        // tabindex -1: keyboard.js would otherwise make the icon a second, silent tab stop inside the header button.
        const icon = el('div', { className: 'fa-solid fa-circle-chevron-down inline-drawer-icon down', attrs: { 'aria-hidden': 'true', tabindex: '-1' } });
        toggle.append(el('b', { text: 'Story Mode' }), icon);
        toggle.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                toggle.click();
            }
        });
        // The host flips the icon's classes on click and when it restores a remembered open state; mirror that into ARIA.
        drawerIconObserver = new MutationObserver(() => toggle.setAttribute('aria-expanded', String(icon.classList.contains('up'))));
        drawerIconObserver.observe(icon, { attributes: true, attributeFilter: ['class'] });
        const content = el('div', { className: 'inline-drawer-content', attrs: { id: `${DRAWER_ID}-content` } });
        content.addEventListener('focusout', () => {
            // Change/blur handlers start their save before this deferred rebuild checks for it.
            queueMicrotask(() => {
                if (drawerRerenderPending) renderDrawer();
            });
        });
        drawer.append(toggle, content);
    }
    if (drawer.parentElement !== host) {
        host.append(drawer);
    }
    renderDrawer();
}

function checkboxRow({ id, label, checked, onChange }) {
    const wrap = el('label', { className: 'checkbox_label sbstory-row', attrs: { for: id } });
    const input = el('input', { attrs: { type: 'checkbox', id } });
    input.checked = Boolean(checked);
    input.addEventListener('change', async () => {
        const next = input.checked;
        input.disabled = true;
        input.setAttribute('data-sbstory-saving', '');
        try {
            if (await onChange(next) === false) {
                input.checked = !next;
            }
        } catch (error) {
            console.error('[Story Mode] setting could not be saved', error);
            input.checked = !next;
            api.toast('error', 'That Story Mode setting could not be saved.');
        } finally {
            input.disabled = false;
            input.removeAttribute('data-sbstory-saving');
            if (input.isConnected) renderDrawer();
        }
    });
    wrap.append(input, el('span', { text: label }));
    return wrap;
}

function field(labelText, control, hint = '') {
    const wrap = el('div', { className: 'sbstory-field' });
    const label = el('label', { text: labelText, attrs: { for: control.id } });
    wrap.append(label, control);
    if (hint) {
        const id = `${control.id}-hint`;
        control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
        wrap.append(el('small', { text: hint, attrs: { id } }));
    }
    return wrap;
}

function agentLabel(agent) {
    return !agent.enabled ? `${agent.name} (switched off in Agents)`
        : agent.paused ? `${agent.name} (paused by Story Mode)` : agent.name;
}

export function renderDrawer() {
    if (!drawer) {
        return;
    }
    const content = drawer.querySelector('.inline-drawer-content');
    if (!content) {
        return;
    }
    const settings = api.getSettings();
    const character = api.currentCharacter();
    const card = api.getCardConfig();
    const hasChat = api.hasChat();
    const cardRulesActive = Boolean(character && (card?.instruction ?? '').trim());
    const rulesLabel = cardRulesActive ? 'General rules (not used while this card has its own)' : 'Rules sent before the block being continued';
    const chatLabel = hasChat ? 'Story Mode in this chat' : 'Story Mode in this chat (open a chat first)';
    // Keep the actual focused node and caret. Labels can refresh without rebuilding the form.
    const focused = document.activeElement;
    const editing = focused instanceof HTMLElement && content.contains(focused) && focused.matches('textarea, input:not([type="checkbox"]), select');
    if (character === drawerCharacter && (editing || content.querySelector('[data-sbstory-saving]'))) {
        drawerRerenderPending = true;
        const chatToggle = content.querySelector('#sbstory-opt-chat');
        if (chatToggle && !chatToggle.hasAttribute('data-sbstory-saving')) {
            chatToggle.checked = hasChat && api.isEnabled();
            chatToggle.disabled = !hasChat;
            chatToggle.closest('label').querySelector('span').textContent = chatLabel;
        }
        const label = content.querySelector('label[for="sbstory-opt-rules"]');
        if (label) label.textContent = rulesLabel;
        content.querySelector('#sbstory-opt-rules')?.classList.toggle('sbstory-muted', cardRulesActive);
        for (const agent of api.listAgents() ?? []) {
            const input = document.getElementById(`sbstory-opt-agent-${agent.id}`);
            const text = input?.closest('label')?.querySelector('span');
            if (text) text.textContent = agentLabel(agent);
        }
        return;
    }
    drawerRerenderPending = false;
    drawerCharacter = character;
    content.replaceChildren();

    const chatToggle = checkboxRow({
        id: 'sbstory-opt-chat',
        label: chatLabel,
        checked: hasChat && api.isEnabled(),
        onChange: (value) => drawerHandlers.onChatToggle?.(value, { renderDrawer: true }),
    });
    chatToggle.querySelector('input').disabled = !hasChat;
    content.append(chatToggle);

    content.append(checkboxRow({
        id: 'sbstory-opt-default',
        label: 'Start chats in Story Mode unless the card or chat says otherwise',
        checked: settings.defaultOn,
        onChange: (value) => {
            api.updateSettings({ defaultOn: value });
            drawerHandlers.onChange?.();
        },
    }));

    if (character) {
        const cardKey = character.avatar || character;
        const isCurrentCard = () => {
            const current = api.currentCharacter();
            return (current?.avatar || current) === cardKey;
        };
        const section = el('div');
        section.append(el('h4', { text: `This card: ${character.name ?? 'character'}` }));
        section.append(el('small', { text: 'Saved inside the card, so they travel with it.' }));
        const cardDefault = el('select', { className: 'text_pole', attrs: { id: 'sbstory-opt-card-default' } });
        for (const [value, text] of [['', 'Use global default'], ['true', 'On'], ['false', 'Off']]) {
            cardDefault.append(el('option', { text, attrs: { value } }));
        }
        let previousDefault = typeof card?.default === 'boolean' ? String(card.default) : '';
        cardDefault.value = previousDefault;
        cardDefault.addEventListener('change', async () => {
            const value = cardDefault.value === '' ? undefined : cardDefault.value === 'true';
            cardDefault.disabled = true;
            cardDefault.setAttribute('data-sbstory-saving', '');
            try {
                if (await api.setCardConfig({ default: value }, character) === false) {
                    cardDefault.value = previousDefault;
                    api.toast('info', 'The card changed before this setting could be saved.');
                } else if (isCurrentCard()) {
                    previousDefault = value === undefined ? '' : String(value);
                    drawerHandlers.onChange?.();
                }
            } catch (error) {
                console.error('[Story Mode] card default could not be saved', error);
                cardDefault.value = previousDefault;
                api.toast('error', 'That card default could not be saved. Try again.');
            } finally {
                cardDefault.disabled = false;
                cardDefault.removeAttribute('data-sbstory-saving');
                if (cardDefault.isConnected) renderDrawer();
            }
        });
        section.append(field('Story Mode for this card', cardDefault, 'A saved choice for an individual chat still takes priority.'));

        const instruction = el('textarea', { className: 'text_pole sbstory-textarea', attrs: { id: 'sbstory-opt-card-rules', rows: '4', placeholder: 'Leave empty to use the rules below.' } });
        instruction.value = cardDrafts.get(cardKey)?.value ?? card?.instruction ?? '';
        const feedback = el('small', { attrs: { id: 'sbstory-card-rules-status', role: 'status', 'aria-atomic': 'true' } });
        instruction.setAttribute('aria-describedby', feedback.id);
        const saveRules = async () => {
            if (instruction.readOnly) return;
            const draft = { value: instruction.value, error: '' };
            cardDrafts.set(cardKey, draft);
            instruction.readOnly = true;
            instruction.setAttribute('data-sbstory-saving', '');
            saveRulesButton.disabled = true;
            feedback.textContent = 'Saving...';
            try {
                const saved = await api.setCardConfig({ instruction: draft.value.trim() }, character);
                if (saved === false) {
                    draft.error = 'Not saved: the card changed. Reopen this card to save your draft before reloading.';
                } else {
                    if (cardDrafts.get(cardKey) === draft) cardDrafts.delete(cardKey);
                    if (isCurrentCard()) drawerHandlers.onChange?.();
                }
            } catch (error) {
                console.error('[Story Mode] card rules could not be saved', error);
                draft.error = 'Not saved. Your rules are still here; use Save rules to try again.';
            } finally {
                instruction.readOnly = false;
                instruction.removeAttribute('data-sbstory-saving');
                refreshDraft();
                if (instruction.isConnected) renderDrawer();
            }
        };
        const saveRulesButton = iconButton({ id: 'sbstory-save-card-rules', icon: 'fa-check', label: 'Save rules', title: 'Save these card rules', className: 'menu_button sbstory-reset sbstory-save-rules', onClick: saveRules });
        const refreshDraft = () => {
            const draft = cardDrafts.get(cardKey);
            const text = draft ? draft.error || 'Unsaved changes.' : '';
            if (feedback.textContent !== text) feedback.textContent = text;
            instruction.setAttribute('aria-invalid', String(Boolean(draft?.error)));
            saveRulesButton.hidden = !draft;
            saveRulesButton.disabled = instruction.readOnly;
        };
        instruction.addEventListener('input', () => {
            cardDrafts.set(cardKey, { value: instruction.value, error: '' });
            refreshDraft();
        });
        instruction.addEventListener('change', saveRules);
        const rulesField = field('Co-writing rules for this card (optional)', instruction, 'Replaces the general rules when this card is open. {{length}} becomes the length hint.');
        rulesField.append(feedback, saveRulesButton);
        refreshDraft();
        section.append(rulesField);
        content.append(section);
    }

    // Writing: what the model is told and how much it writes. Grouped so the two rules boxes sit together
    // and the rewrite option is not orphaned after Agents.
    content.append(el('h4', { text: 'Writing' }));

    // When the open card carries its own rules, the general box is not what the model sees: say so on the label.
    const rules = el('textarea', { className: `text_pole sbstory-textarea${cardRulesActive ? ' sbstory-muted' : ''}`, attrs: { id: 'sbstory-opt-rules', rows: '6' } });
    rules.value = settings.rules;
    rules.addEventListener('change', () => {
        api.updateSettings({ rules: rules.value.trim() || DEFAULT_RULES });
        drawerHandlers.onChange?.();
    });
    const rulesField = field(
        rulesLabel,
        rules,
        '{{length}} becomes the length hint; {{user}} is the usual macro.',
    );
    const reset = el('button', { className: 'menu_button sbstory-reset', text: 'Reset rules', attrs: { type: 'button' } });
    reset.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.stopPropagation();
        }
    });
    reset.addEventListener('click', () => {
        rules.value = DEFAULT_RULES;
        api.updateSettings({ rules: DEFAULT_RULES });
        drawerHandlers.onChange?.();
    });
    rulesField.append(reset);
    content.append(rulesField);

    const length = el('input', { className: 'text_pole', attrs: { id: 'sbstory-opt-length', type: 'text' } });
    length.value = settings.lengthHint;
    length.addEventListener('change', () => {
        api.updateSettings({ lengthHint: length.value.trim() || undefined });
        drawerHandlers.onChange?.();
    });
    content.append(field('How much to write per continuation', length, 'Plain words, e.g. "about a paragraph" or "two short paragraphs".'));

    const cap = el('input', { className: 'text_pole', attrs: { id: 'sbstory-opt-maxtokens', type: 'number', min: '0', step: '10', inputmode: 'numeric' } });
    cap.value = String(settings.maxTokens);
    cap.addEventListener('change', () => {
        const next = api.updateSettings({ maxTokens: cap.value });
        cap.value = String(next.maxTokens);
        drawerHandlers.onChange?.();
    });
    content.append(field('Longest continuation, in tokens', cap, 'The reply is cut off here, like NovelAI\'s output length; press Continue again to keep going. 0 uses your preset\'s response length.'));

    content.append(checkboxRow({
        id: 'sbstory-opt-fullctx',
        label: 'Rewrites see the whole story (slower, costs more, matches voice better)',
        checked: settings.transformsUseFullContext,
        onChange: (value) => {
            api.updateSettings({ transformsUseFullContext: value });
        },
    }));

    content.append(el('h4', { text: 'Appearance' }));
    content.append(checkboxRow({
        id: 'sbstory-opt-shading',
        label: 'Shade the model\'s text',
        checked: settings.shading,
        onChange: (value) => {
            api.updateSettings({ shading: value });
            drawerHandlers.onChange?.();
        },
    }));
    content.append(checkboxRow({
        id: 'sbstory-opt-serif',
        label: 'Serif font in the manuscript',
        checked: settings.serif,
        onChange: (value) => {
            api.updateSettings({ serif: value });
            drawerHandlers.onChange?.();
        },
    }));

    const agentSection = el('div');
    agentSection.append(el('h4', { text: 'In-Chat Agents' }));
    const agents = api.listAgents();
    if (agents === null) {
        agentSection.append(el('small', { text: 'In-Chat Agents is not available, so every agent behaves as usual.' }));
    } else {
        agentSection.append(checkboxRow({
            id: 'sbstory-opt-agent-gate',
            label: 'Only the agents ticked below run while Story Mode is on',
            checked: settings.agentGate,
            onChange: (value) => {
                api.updateSettings({ agentGate: value });
                drawerHandlers.onChange?.();
            },
        }));
        if (agents.length === 0) {
            agentSection.append(el('small', { text: 'You have no agents yet. Add some in the Agents tab and they will show up here.' }));
        }
        const allowed = new Set(settings.allowedAgents);
        for (const agent of agents) {
            agentSection.append(checkboxRow({
                id: `sbstory-opt-agent-${agent.id}`,
                label: agentLabel(agent),
                checked: allowed.has(agent.id),
                onChange: (value) => {
                    const next = new Set(api.getSettings().allowedAgents);
                    if (value) {
                        next.add(agent.id);
                    } else {
                        next.delete(agent.id);
                    }
                    api.updateSettings({ allowedAgents: [...next] });
                    api.applyAgentGate();
                },
            }));
        }
        if (agents.length > 0) {
            agentSection.append(el('small', { text: 'Unticked agents are paused while Story Mode is on. Their saved on/off settings do not change.' }));
        }
    }
    content.append(agentSection);
}

// ---------------------------------------------------------------- mode application / teardown

export function applyState(enabled) {
    const settings = api.getSettings();
    document.body.classList.toggle(BODY_CLASS, enabled);
    document.body.classList.toggle('sbstory-serif', enabled && settings.serif);
    document.body.classList.toggle('sbstory-shade', enabled && settings.shading);
    if (bar) {
        placeBar();
        bar.hidden = !enabled;
        refreshBar();
    }
    refreshMenuItem(enabled);
    if (enabled) {
        showEditHintOnce();
        checkEditor();
        refreshTransformRow();
        stampBlocks();
    } else {
        cancelTransform();
        cancelEditorReveal?.();
        lastEditor = null;
        cleanupStamps();
        hideRow();
    }
}

export function unmountAll() {
    cancelTransform();
    cancelEditorReveal?.();
    rowSizeObserver?.disconnect();
    rowSizeObserver = null;
    document.body.style.removeProperty('--sbstory-row-slot');
    listenerController?.abort();
    listenerController = null;
    cancelAnimationFrame(selectionFrame);
    selectionFrame = 0;
    delete document.documentElement.dataset.sbstorySelection;
    delete document.documentElement.dataset.sbstoryEscape;
    const chat = document.getElementById('chat');
    if (chat) {
        delete chat.dataset.sbstoryBound;
    }
    document.body.classList.remove(BODY_CLASS, 'sbstory-serif', 'sbstory-shade');
    cleanupStamps();
    drawerIconObserver?.disconnect();
    drawerIconObserver = null;
    bar?.remove();
    row?.remove();
    menuItem?.remove();
    nativeModeButton?.remove();
    window.removeEventListener('neconyan:hopper-state-changed', refreshNativeMode);
    window.removeEventListener('sb:conversation-workspace-state-changed', refreshNativeMode);
    drawer?.remove();
    bar = null;
    directionWrap = null;
    directionInput = null;
    wordCount = null;
    barStatus = null;
    row = null;
    rowStatus = null;
    rowStop = null;
    menuItem = null;
    nativeModeButton = null;
    drawer = null;
    drawerRerenderPending = false;
    drawerCharacter = undefined;
    lastEditor = null;
}
