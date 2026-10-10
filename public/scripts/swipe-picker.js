import { branchChat } from './bookmarks.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE } from './constants.js';
import { t } from './i18n.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { power_user } from './power-user.js';
import { isMobile } from './RossAscends-mods.js';
import { getTokenCountAsync } from './tokenizers.js';
import { addLongPressEvent, clamp, copyText, timestampToMoment } from './utils.js';
import { chat, deleteSwipe, ensureSwipes, getChatExportOwnerKey, getChatGeneration, getCurrentChatId, isMessageSwipeable, isSwipingAllowed, swipe, syncMesToSwipe } from '/script.js';

/**
 * Returns whether a swipe picker can be opened for the message.
 * Unlike message swiping, this supports historical AI messages for inspection and branching.
 * @param {number} messageId
 * @returns {boolean}
 */
export function canOpenSwipePickerForMessage(messageId) {
    const message = chat[messageId];

    if (!message) {
        return false;
    }

    if (ensureSwipes(message)) {
        syncMesToSwipe(messageId);
    }

    return Boolean(
        message?.swipes?.length > 1 &&
        !message?.is_user &&
        !(message?.extra?.isSmallSys) &&
        !(message?.extra?.swipeable === false),
    );
}

/**
 * Returns whether the picker can actively jump to a different swipe.
 * Historical AI messages can open the picker, but only the currently swipeable message may jump.
 * @param {number} messageId
 * @returns {boolean}
 */
export function canJumpToSwipeForMessage(messageId) {
    const message = chat[messageId];
    return canOpenSwipePickerForMessage(messageId) && isSwipingAllowed() && isMessageSwipeable(messageId, message);
}

/**
 * Builds a labelled action button for a swipe card.
 * @param {string} className Action class, for example 'swipe_picker_copy'.
 * @param {string} iconClass Font Awesome icon classes.
 * @param {string} label Visible label.
 * @param {string} [title] Longer tooltip.
 * @returns {HTMLButtonElement}
 */
function createSwipeAction(className, iconClass, label, title = label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('swipe_picker_action', className);
    button.title = title;

    const icon = document.createElement('i');
    icon.classList.add('fa-fw', ...iconClass.split(' '));
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.classList.add('swipe_picker_action_label');
    text.textContent = label;

    button.append(icon, text);
    return button;
}

/**
 * Opens a popup for viewing or jumping to a specific swipe on a message.
 * @param {number} messageId
 * @returns {Promise<void>}
 */
async function openSwipePicker(messageId) {
    const message = chat[messageId];
    const pickerScope = { ownerKey: getChatExportOwnerKey(), chatId: getCurrentChatId(), generation: getChatGeneration(), messageRef: message };
    const isPickerScopeCurrent = (generation = pickerScope.generation) => chat[messageId] === pickerScope.messageRef
        && getChatExportOwnerKey() === pickerScope.ownerKey
        && getCurrentChatId() === pickerScope.chatId
        && getChatGeneration() === generation;

    if (!canOpenSwipePickerForMessage(messageId)) {
        toastr.info(t`This message has no alternate swipes yet.`, t`Jump to Swipe`);
        return;
    }

    const canJumpToSwipe = canJumpToSwipeForMessage(messageId);
    const getShownSwipeId = () => clamp(Number(message.swipe_id ?? 0), 0, message.swipes.length - 1);
    let selectedSwipeId = getShownSwipeId();

    const wrapper = document.createElement('div');
    wrapper.classList.add('swipe_picker');

    const header = document.createElement('div');
    header.classList.add('swipe_picker_header');

    const heading = document.createElement('h3');
    heading.classList.add('swipe_picker_title');
    const headingText = document.createElement('span');
    headingText.textContent = t`Swipes`;
    const swipeCount = document.createElement('span');
    swipeCount.classList.add('swipe_picker_count');
    heading.append(headingText, swipeCount);

    const hint = document.createElement('p');
    hint.classList.add('swipe_picker_hint');
    hint.textContent = canJumpToSwipe
        ? t`Pick a version, then show it in the chat.`
        : t`This is an earlier reply. You can read, copy or branch from any version.`;

    header.append(heading, hint);
    wrapper.appendChild(header);

    const listContainer = document.createElement('div');
    listContainer.classList.add('swipe_picker_div');
    listContainer.setAttribute('role', 'list');
    listContainer.setAttribute('aria-label', t`Swipes`);
    wrapper.appendChild(listContainer);

    /** @type {Popup} */
    let popup;
    /** @type {number|null} */
    let branchActionSwipeId = null;
    let measureFrame = 0;

    function getSwipeCard(swipeId) {
        const card = listContainer.querySelector(`.swipe_picker_block[data-swipe-id="${swipeId}"]`);
        return card instanceof HTMLElement ? card : null;
    }

    function syncConfirmButton() {
        if (!canJumpToSwipe || !popup?.okButton) {
            return;
        }
        const swipeNumber = selectedSwipeId + 1;
        popup.okButton.textContent = selectedSwipeId === getShownSwipeId()
            ? t`Keep swipe #${swipeNumber}`
            : t`Show swipe #${swipeNumber}`;
    }

    function setSelectedSwipe(nextSwipeId) {
        selectedSwipeId = clamp(Number(nextSwipeId), 0, message.swipes.length - 1);
        listContainer.querySelectorAll('.swipe_picker_block').forEach((element) => {
            const isSelected = Number(element.getAttribute('data-swipe-id')) === selectedSwipeId;
            if (isSelected) {
                element.setAttribute('highlight', 'true');
                element.setAttribute('aria-current', 'true');
            } else {
                element.removeAttribute('highlight');
                element.removeAttribute('aria-current');
            }
        });
        syncConfirmButton();
    }

    function scrollToSelectedSwipe() {
        getSwipeCard(selectedSwipeId)?.scrollIntoView({ block: 'nearest' });
    }

    // Only offer 'Read all' on cards whose text is actually cut short.
    function measureExpandButtons() {
        listContainer.querySelectorAll('.swipe_picker_block').forEach((card) => {
            const text = card.querySelector('.swipe_picker_text');
            const expandButton = card.querySelector('.swipe_picker_expand');
            if (!(text instanceof HTMLElement) || !(expandButton instanceof HTMLElement)) {
                return;
            }
            const isExpanded = card.classList.contains('expanded');
            expandButton.hidden = !isExpanded && text.scrollHeight <= text.clientHeight + 1;
        });
    }

    function scheduleMeasure() {
        cancelAnimationFrame(measureFrame);
        measureFrame = requestAnimationFrame(measureExpandButtons);
    }

    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleMeasure) : null;

    function canDeleteSwipeFromPicker(swipeId) {
        if ((message?.swipes?.length ?? 0) <= 1) {
            return false;
        }

        return canJumpToSwipe || swipeId !== getShownSwipeId();
    }

    async function deleteSwipeFromPicker(index) {
        if (!canDeleteSwipeFromPicker(index) || !isPickerScopeCurrent()) {
            if (!isPickerScopeCurrent()) {
                toastr.warning(t`This chat changed, so the deletion cannot be safely undone.`);
                await popup?.completeCancelled();
            }
            return;
        }

        const nextSelectedSwipeId = index < selectedSwipeId
            ? selectedSwipeId - 1
            : index > selectedSwipeId
                ? selectedSwipeId
                : Math.min(selectedSwipeId, message.swipes.length - 2);

        const expectedGeneration = pickerScope.generation + Number(index === Number(message.swipe_id));
        let restoredDuringDelete = false;
        const newSwipeId = await deleteSwipe(index, messageId, {
            askConfirmation: power_user.confirm_message_delete,
            offerUndo: true,
            onRestored: async ({ restoredSwipeId }) => {
                if (!isPickerScopeCurrent(expectedGeneration) || !popup?.dlg?.isConnected) {
                    return;
                }
                pickerScope.generation = expectedGeneration;
                restoredDuringDelete = true;

                selectedSwipeId = clamp(Number(restoredSwipeId), 0, message.swipes.length - 1);
                const rendered = await renderSwipeList();
                if (!rendered || !isPickerScopeCurrent()) {
                    return;
                }
                const restoredRow = getSwipeCard(selectedSwipeId);
                if (restoredRow) {
                    restoredRow.tabIndex = -1;
                    return restoredRow;
                }
            },
        });

        if (restoredDuringDelete || !Number.isInteger(newSwipeId) || !isPickerScopeCurrent(expectedGeneration)) {
            return;
        }

        pickerScope.generation = expectedGeneration;
        selectedSwipeId = clamp(nextSelectedSwipeId, 0, message.swipes.length - 1);

        await renderSwipeList();
    }

    /**
     * @param {number} index
     * @returns {Promise<HTMLElement>}
     */
    async function buildSwipeCard(index) {
        const swipeText = String(message.swipes[index] ?? '');
        const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info[index] : null;
        const sendDate = swipeInfo?.send_date ? timestampToMoment(swipeInfo.send_date).format('lll') : '';
        const hasText = swipeText.trim().length > 0;
        const tokenCount = swipeInfo?.extra?.token_count ?? await getTokenCountAsync(swipeText, 0);
        const isShown = index === getShownSwipeId();

        const card = document.createElement('div');
        card.classList.add('swipe_picker_block');
        card.setAttribute('role', 'listitem');
        card.setAttribute('data-swipe-id', String(index));
        card.tabIndex = 0;

        const cardHead = document.createElement('div');
        cardHead.classList.add('swipe_picker_card_head');

        const number = document.createElement('span');
        number.classList.add('swipe_picker_number');
        number.textContent = `#${index + 1}`;
        cardHead.appendChild(number);

        if (isShown) {
            const badge = document.createElement('span');
            badge.classList.add('swipe_picker_badge');
            badge.textContent = t`Showing`;
            badge.title = t`This is the version shown in the chat.`;
            cardHead.appendChild(badge);
        }

        const details = [sendDate, tokenCount ? t`${tokenCount} tokens` : ''].filter(Boolean);
        if (details.length) {
            const meta = document.createElement('span');
            meta.classList.add('swipe_picker_meta');
            meta.textContent = details.join(' · ');
            cardHead.appendChild(meta);
        }

        const text = document.createElement('div');
        text.classList.add('swipe_picker_text');
        text.classList.toggle('swipe_picker_text_empty', !hasText);
        text.textContent = hasText ? swipeText.trim() : t`(empty swipe)`;

        const actions = document.createElement('div');
        actions.classList.add('swipe_picker_actions');

        const expandButton = createSwipeAction('swipe_picker_expand', 'fa-solid fa-chevron-down', t`Read all`);
        expandButton.setAttribute('aria-expanded', 'false');
        expandButton.hidden = true;
        expandButton.addEventListener('click', () => {
            const isExpanded = card.classList.toggle('expanded');
            expandButton.setAttribute('aria-expanded', String(isExpanded));
            expandButton.title = isExpanded ? t`Show less` : t`Read all`;
            expandButton.querySelector('.swipe_picker_action_label').textContent = expandButton.title;
            if (!isExpanded) {
                card.scrollIntoView({ block: 'nearest' });
            }
        });

        const copyButton = createSwipeAction('swipe_picker_copy', 'fa-regular fa-copy', t`Copy`, t`Copy this swipe`);
        copyButton.addEventListener('click', async () => {
            await copyText(swipeText);
            toastr.info(t`Copied!`, '', { timeOut: 5000 });
        });

        const branchButton = createSwipeAction('swipe_picker_branch', 'fa-solid fa-code-branch', t`Branch`, t`Start a new chat branch from this swipe`);
        branchButton.addEventListener('click', async () => {
            setSelectedSwipe(index);
            branchActionSwipeId = index;
            await popup.completeCancelled();
        });

        actions.append(expandButton, copyButton, branchButton);

        if (canDeleteSwipeFromPicker(index)) {
            const deleteButton = createSwipeAction('swipe_picker_delete', 'fa-regular fa-trash-can', t`Delete`, t`Delete this swipe`);
            deleteButton.addEventListener('click', () => deleteSwipeFromPicker(index));
            actions.appendChild(deleteButton);
        }

        // Buttons act on their own; only taps on the card body change the selection.
        actions.addEventListener('click', (event) => event.stopPropagation());
        actions.addEventListener('dblclick', (event) => event.stopPropagation());

        card.append(cardHead, text, actions);

        card.addEventListener('click', () => setSelectedSwipe(index));
        card.addEventListener('dblclick', async () => {
            if (!canJumpToSwipe) {
                return;
            }

            setSelectedSwipe(index);
            await popup.completeAffirmative();
        });

        return card;
    }

    async function renderSwipeList() {
        const swipeCards = await Promise.all(message.swipes.map((_swipe, index) => buildSwipeCard(index)));

        if (!isPickerScopeCurrent()) return false;
        listContainer.replaceChildren(...swipeCards);
        swipeCount.textContent = String(swipeCards.length);
        swipeCount.title = t`${swipeCards.length} swipes`;
        setSelectedSwipe(selectedSwipeId);
        scheduleMeasure();

        if (swipeCards.length === 0) {
            const empty = document.createElement('div');
            empty.classList.add('swipe_picker_empty');
            empty.textContent = t`No swipes available.`;
            listContainer.replaceChildren(empty);
        }
        return true;
    }

    listContainer.addEventListener('keydown', (event) => {
        const card = event.target instanceof HTMLElement && event.target.classList.contains('swipe_picker_block') ? event.target : null;
        if (!card) {
            return;
        }

        const lastSwipeId = message.swipes.length - 1;
        const currentSwipeId = Number(card.getAttribute('data-swipe-id'));
        const targetSwipeId = {
            ArrowDown: currentSwipeId + 1,
            ArrowUp: currentSwipeId - 1,
            Home: 0,
            End: lastSwipeId,
        }[event.key];

        if (targetSwipeId === undefined) {
            return;
        }

        event.preventDefault();
        setSelectedSwipe(targetSwipeId);
        const targetCard = getSwipeCard(selectedSwipeId);
        if (targetCard) {
            targetCard.focus({ preventScroll: true });
            targetCard.scrollIntoView({ block: 'nearest' });
        }
    });

    popup = new Popup(wrapper, POPUP_TYPE.CONFIRM, '', {
        okButton: canJumpToSwipe ? t`Show swipe` : false,
        cancelButton: false,
        wider: true,
        allowVerticalScrolling: true,
        onOpen: function () {
            resizeObserver?.observe(listContainer);
            measureExpandButtons();
            scrollToSelectedSwipe();
            getSwipeCard(selectedSwipeId)?.focus({ preventScroll: true });
        },
        onClosing: function (popup) {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }
            if (!isPickerScopeCurrent()) {
                toastr.warning(t`This chat changed, so the action was cancelled.`);
                return false;
            }
            return true;
        },
        onClose: function () {
            resizeObserver?.disconnect();
            cancelAnimationFrame(measureFrame);
        },
    });

    popup.dlg.classList.add('swipe_picker_popup');
    popup.closeButton.style.display = '';
    popup.closeButton.title = t`Close`;
    popup.closeButton.setAttribute('aria-label', t`Close`);
    // The label follows the selected swipe, so the static translation key must not reset it.
    delete popup.okButton.dataset.i18n;
    if (!canJumpToSwipe) {
        popup.buttonControls.style.display = 'none';
    }

    if (!await renderSwipeList()) return;

    const popupResult = await popup.show();

    if (branchActionSwipeId !== null) {
        if (!isPickerScopeCurrent()) {
            toastr.warning(t`This chat changed, so the action was cancelled.`);
            return;
        }
        await branchChat(messageId, { swipeId: branchActionSwipeId });
        return;
    }

    if (popupResult !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    if (!canJumpToSwipe || !isPickerScopeCurrent()) {
        if (!isPickerScopeCurrent()) {
            toastr.warning(t`This chat changed, so the action was cancelled.`);
        }
        return;
    }

    const targetSwipeId = clamp(selectedSwipeId, 0, message.swipes.length - 1);
    const currentSwipeId = getShownSwipeId();

    if (targetSwipeId === currentSwipeId) {
        return;
    }

    const direction = targetSwipeId > currentSwipeId ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
    await swipe(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: messageId, forceSwipeId: targetSwipeId });
}

export function initSwipePicker() {
    /**
     * Click handler for opening the swipe picker when clicking on the swipe counter.
     * @param {JQuery.Event | Event} e Event object
     */
    async function onSwipeCounterClick(e) {
        e.preventDefault();
        e.stopPropagation();

        const mesId = Number($(this).closest('.mes').attr('mesid'));
        await openSwipePicker(mesId);
    }

    if (isMobile()) {
        addLongPressEvent('.swipes-counter.swipe-picker-enabled', onSwipeCounterClick);
    } else {
        $(document).on('click', '.swipes-counter.swipe-picker-enabled', onSwipeCounterClick);
    }
    $(document).on('keydown', '.swipes-counter.swipe-picker-enabled', async function (e) {
        if (e.key !== ' ') {
            return;
        }

        onSwipeCounterClick.call(this, e);
    });
    $(document).on('click', '.mes_swipe_picker', async function (e) {
        e.preventDefault();
        e.stopPropagation();

        const mesId = Number($(this).closest('.mes').attr('mesid'));
        await openSwipePicker(mesId);
    });
}
