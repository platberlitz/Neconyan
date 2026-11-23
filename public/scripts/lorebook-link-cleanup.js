import {
    characters,
    chat_metadata,
    getChatGeneration,
    getCurrentChatId,
    getOneCharacter,
    getRequestHeaders,
    loadRoleplayChat,
    saveMetadata,
    saveRoleplayChatRequest,
    saveSettingsDebounced,
    this_chid,
} from '../script.js';
import { selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { clearLorebookNotice } from './lorebook-links.js';
import {
    linkPointsAt,
    planCardLinkRewrites,
    rewriteCharLore,
    rewriteChatLorebook,
    rewriteConversationOverrides,
    runLorebookLinkSteps,
} from './lorebook-link-rewrite.js';
import { beginRoleplaySave, finishRoleplaySave } from './roleplay-save-chain.js';
import { escapeHtml, uuidv4 } from './utils.js';
import { world_info } from './world-info.js';

const METADATA_KEY = 'world_info';

/** The chat that is open, as the chat list names it, so the sweep of closed chats leaves it to the page. */
function isOpenChat(item) {
    const chatId = getCurrentChatId();
    if (chatId === undefined || chatId === null || String(item.file_id) !== String(chatId)) return false;
    if (item.group) return Boolean(selected_group) && String(item.group) === String(selected_group);
    return this_chid !== undefined && characters[this_chid]?.avatar === item.avatar;
}

async function rewriteOpenChat(from, to) {
    const { changed, value } = rewriteChatLorebook(chat_metadata, from, to);
    if (!changed) return 0;
    const generation = getChatGeneration();
    if (value === null) {
        delete chat_metadata[METADATA_KEY];
        $('.chat_lorebook_button').removeClass('world_set');
    } else {
        chat_metadata[METADATA_KEY] = value;
    }
    if (generation !== getChatGeneration()) throw new Error(t`The chat changed while its lorebook link was updated.`);
    if (await saveMetadata() === false) throw new Error(t`The chat could not be saved.`);
    return 1;
}

function rewriteExtraBooks(from, to) {
    const { charLore, cards } = rewriteCharLore(world_info.charLore, from, to);
    if (!cards.length) return 0;
    Object.assign(world_info, { charLore });
    saveSettingsDebounced();
    return cards.length;
}

async function rewriteCard({ avatar, update }) {
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar, data: update }),
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.message || t`The server answered ${response.status}.`);
    }
    await getOneCharacter(avatar);
    return 1;
}

async function listChats() {
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ metadata: true }),
    });
    if (!response.ok) throw new Error(t`The server answered ${response.status}.`);
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error(t`The chat list was not readable.`);
    return list;
}

/** Edits one chat that is not open: reads it with its save authority, changes only the header's link and saves it back. */
async function rewriteClosedChat(item, from, to) {
    const chat = String(item.file_id);
    const locator = item.group ? { group: true, chat } : { group: false, avatar: item.avatar, chat };
    const { records, evidence } = await loadRoleplayChat(locator);
    const header = records[0]?.chat_metadata;
    const { changed, value } = rewriteChatLorebook(header, from, to);
    if (!changed) return 0;
    if (value === null) delete header[METADATA_KEY];
    else header[METADATA_KEY] = value;
    const token = beginRoleplaySave(locator, { operationKey: uuidv4(), evidence });
    try {
        const payload = item.group
            ? { id: chat, chat: records }
            : { ch_name: characters.find(card => card?.avatar === item.avatar)?.name ?? item.avatar, file_name: chat, chat: records, avatar_url: item.avatar };
        const saved = await saveRoleplayChatRequest(token, payload);
        if (!saved.ok) throw new Error(t`The server refused the save.`);
    } finally {
        await finishRoleplaySave(token);
    }
    return 1;
}

async function closedChatSteps(from, to) {
    const steps = [];
    for (const item of await listChats()) {
        if (!item?.file_id || !(item.avatar || item.group) || !rewriteChatLorebook(item.chat_metadata, from, to).changed) continue;
        const where = item.group ? t`group chat ${item.file_id}` : t`chat ${item.file_id} of ${characters.find(card => card?.avatar === item.avatar)?.name ?? item.avatar}`;
        steps.push({
            label: where,
            run: () => (isOpenChat(item) ? rewriteOpenChat(from, to) : rewriteClosedChat(item, from, to)),
        });
    }
    return steps;
}

async function rewriteConversation(from, to) {
    const { refreshConversationStore, flushConversationStore } = await import('./neconyan-conversation/store-sync.js');
    const { getConversationStore } = await import('./neconyan-conversation/context.js');
    const refreshed = await refreshConversationStore();
    if (refreshed?.conflict) throw new Error(t`The Conversation settings changed on another device. Reload the page and try again.`);
    const changed = rewriteConversationOverrides(getConversationStore(), from, to);
    if (!changed.length) return 0;
    if (!await flushConversationStore()) throw new Error(t`The Conversation settings could not be saved.`);
    const select = document.getElementById('sb_conv_lorebook_override');
    if (select instanceof HTMLSelectElement && linkPointsAt(select.value, from)) {
        if (to) {
            if (!Array.from(select.options).some(option => option.value === to)) select.append(new Option(to, to));
            select.value = to;
        } else {
            select.value = '';
        }
        Array.from(select.options).filter(option => option.value === from).forEach(option => option.remove());
    }
    return changed.length;
}

function reportFailures(from, to, failed) {
    const list = failed.map(item => `<li>${escapeHtml(item.label)}: ${escapeHtml(item.reason)}</li>`).join('');
    const intro = to === null
        ? t`'${from}' was deleted, but these links to it could not be removed. Everything else was updated.`
        : t`'${from}' was renamed to '${to}', but these links could not be moved. Everything else was updated.`;
    const advice = t`Until they are fixed, the missing-lorebook notice names them when you open them. Try again, or choose another lorebook there.`;
    toastr.error(`${escapeHtml(intro)}<ul class="justifyLeft">${list}</ul>${escapeHtml(advice)}`, t`Lorebook links not fully updated`, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        escapeHtml: false,
    });
}

/**
 * Moves every link to a lorebook to its new name, or removes it when the lorebook is deleted: the open chat, the
 * extra lorebooks of cards, the main lorebook of each card (saved through the card's own route, changing only that
 * link), the chats that are not open, and the Conversation 'Lorebook Override' of every thread. A step that fails
 * is reported in one error and the rest still run.
 * @param {string} from Name that was renamed or deleted
 * @param {string|null} [to] New name, or null for a delete
 * @returns {Promise<{ moved: number, failed: Array<{ label: string, reason: string }> }>}
 */
export async function rewriteLorebookLinks(from, to = null) {
    const steps = [
        { label: t`this chat`, run: () => rewriteOpenChat(from, to) },
        { label: t`extra lorebooks of characters`, run: async () => rewriteExtraBooks(from, to) },
        ...planCardLinkRewrites(characters, from, to).map(plan => ({ label: plan.owner || plan.avatar, run: () => rewriteCard(plan) })),
    ];
    const cardsAndSettings = await runLorebookLinkSteps(steps);
    let chatSteps = [];
    const chatListing = await runLorebookLinkSteps([{ label: t`the list of chats`, run: async () => { chatSteps = await closedChatSteps(from, to); } }]);
    const chats = await runLorebookLinkSteps(chatSteps);
    const conversation = await runLorebookLinkSteps([{ label: t`Conversation lorebook overrides`, run: () => rewriteConversation(from, to) }]);
    const results = [cardsAndSettings, chatListing, chats, conversation];
    const moved = results.reduce((sum, result) => sum + result.moved, 0);
    const failed = results.flatMap(result => result.failed);
    clearLorebookNotice(link => linkPointsAt(link.name, from));
    if (failed.length) {
        for (const item of failed) console.error('[WI] Could not update a lorebook link', item.label, item.reason);
        reportFailures(from, to, failed);
    } else if (moved) {
        toastr.success(to === null ? t`Removed ${moved} link(s) to the deleted lorebook.` : t`Moved ${moved} link(s) to '${to}'.`);
    }
    return { moved, failed };
}
