import { characters, chat_metadata, getOneCharacter, getRequestHeaders, saveMetadata, saveSettingsDebounced, select_selected_character, this_chid } from '../script.js';
import { t } from './i18n.js';
import { Popup, POPUP_RESULT } from './popup.js';
import { escapeHtml } from './utils.js';
import { setWorldInfoButtonClass, world_info } from './world-info.js';
import {
    LOREBOOK_LINK_KIND,
    findMissingLorebookLinks,
    isLorebookChatCurrent,
    takeUntoldLorebookLinks,
} from './lorebook-links.js';

const METADATA_KEY = 'world_info';

/** The lorebook names the server has right now, or null when it could not say. Changes nothing in the page. */
async function fetchLorebookNames() {
    try {
        const response = await fetch('/api/settings/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ sections: ['worlds'] }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        return Array.isArray(data?.world_names) ? data.world_names.map(String) : null;
    } catch {
        return null;
    }
}

/** The lookup a reply makes when it loads a lorebook: true when the file opens, false on 'not found', null when unsure. */
async function lorebookFileExists(name) {
    try {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });
        if (response.ok) return true;
        return response.status === 404 ? false : null;
    } catch {
        return null;
    }
}

function describeLink(link) {
    const name = link.name;
    const owner = link.owner || t`this character`;
    switch (link.kind) {
        case LOREBOOK_LINK_KIND.cardMain: return t`'${name}' is the main lorebook of ${owner}.`;
        case LOREBOOK_LINK_KIND.cardExtra: return t`'${name}' is an extra lorebook of ${owner}.`;
        case LOREBOOK_LINK_KIND.chat: return t`'${name}' is this chat's lorebook.`;
        default: return t`'${name}' is this Conversation's lorebook override.`;
    }
}

function linkListHtml(links) {
    return `<ul class="justifyLeft">${links.map(link => `<li>${escapeHtml(describeLink(link))}</li>`).join('')}</ul>`;
}

/** Takes one dead link away. Each branch checks the link is still there, so a link already fixed is left alone. */
async function removeLink(link) {
    switch (link.kind) {
        case LOREBOOK_LINK_KIND.chat: {
            if (chat_metadata[METADATA_KEY] !== link.name) return false;
            delete chat_metadata[METADATA_KEY];
            $('.chat_lorebook_button').removeClass('world_set');
            await saveMetadata();
            return true;
        }
        case LOREBOOK_LINK_KIND.cardExtra: {
            const filename = String(link.avatar ?? '').replace(/\.[^.]+$/, '');
            const charLore = world_info.charLore ?? [];
            const index = charLore.findIndex(entry => entry.name === filename);
            const books = index === -1 ? [] : charLore[index].extraBooks ?? [];
            if (!books.includes(link.name)) return false;
            const next = books.filter(book => book !== link.name);
            if (next.length) charLore[index] = { ...charLore[index], extraBooks: next };
            else charLore.splice(index, 1);
            Object.assign(world_info, { charLore });
            saveSettingsDebounced();
            return true;
        }
        case LOREBOOK_LINK_KIND.cardMain: {
            const character = characters.find(item => item?.avatar === link.avatar);
            if (!character || character.data?.extensions?.world !== link.name) return false;
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar: link.avatar, data: { extensions: { world: '' } } }),
            });
            if (!response.ok) throw new Error(`Merge API returned ${response.status}`);
            await getOneCharacter(link.avatar);
            if (characters[this_chid]?.avatar === link.avatar) {
                select_selected_character(this_chid, { switchMenu: false });
                setWorldInfoButtonClass(this_chid, false);
            }
            return true;
        }
        default: {
            const { getSettings, saveSettings } = await import('./neconyan-conversation/settings-store.js');
            const { conversationState } = await import('./neconyan-conversation/state.js');
            const { getConversationGroupById } = await import('./neconyan-conversation/context.js');
            const avatar = conversationState.conversationSelectedAvatar;
            const groupId = conversationState.conversationSelectedGroupId || null;
            if (!avatar) return false;
            const members = groupId ? getConversationGroupById(groupId)?.members ?? [] : [avatar];
            let changed = false;
            for (const member of members) {
                const settings = getSettings(member, { groupId });
                if (settings.lorebook_override !== link.name) continue;
                settings.lorebook_override = '';
                saveSettings(member, settings, { groupId });
                changed = true;
            }
            const select = document.getElementById('sb_conv_lorebook_override');
            if (changed && select instanceof HTMLSelectElement) select.value = '';
            return changed;
        }
    }
}

function relinkHints(links) {
    const kinds = new Set(links.map(link => link.kind === LOREBOOK_LINK_KIND.cardExtra ? LOREBOOK_LINK_KIND.cardMain : link.kind));
    const hints = [];
    if (kinds.has(LOREBOOK_LINK_KIND.cardMain)) hints.push(t`To link another lorebook to a card, open its editor and choose 'Link to Lorebook' in the 'More...' menu.`);
    if (kinds.has(LOREBOOK_LINK_KIND.chat)) hints.push(t`To link another lorebook to this chat, Shift-click or long-press the chat lorebook button in the character or group editor.`);
    if (kinds.has(LOREBOOK_LINK_KIND.conversation)) hints.push(t`To pick another lorebook for this Conversation, open its settings, go to Prompt & context and change 'Lorebook Override'.`);
    return hints.map(hint => `<p>${escapeHtml(hint)}</p>`).join('');
}

async function askAndRemove(links) {
    const result = await Popup.show.confirm(
        t`Remove missing lorebook links?`,
        `<p>${escapeHtml(t`Only the links are removed. No lorebook is deleted.`)}</p>${linkListHtml(links)}${relinkHints(links)}`,
        { okButton: t`Remove links`, cancelButton: t`Keep them` },
    );
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    let removed = 0;
    for (const link of links) {
        try {
            if (await removeLink(link)) removed++;
        } catch (error) {
            console.error('[WI] Could not remove a missing lorebook link', link, error);
            toastr.error(t`Could not remove the link to '${link.name}'.`);
        }
    }
    if (removed) toastr.success(t`Removed ${removed} missing lorebook link(s).`);
}

function showNotice(links) {
    const buttonClass = 'lorebook-link-notice-review';
    const content = `${escapeHtml(t`These lorebooks are linked here but no longer exist, so nothing is loaded from them. Nothing has been changed.`)}${linkListHtml(links)}<button type="button" class="menu_button ${buttonClass}">${escapeHtml(t`Review links`)}</button>`;
    toastr.warning(content, t`Missing lorebook links`, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        escapeHtml: false,
        onShown() {
            const toast = this instanceof HTMLElement ? this : this?.[0];
            toast?.querySelector?.(`.${buttonClass}`)?.addEventListener('click', () => {
                toastr.clear($(toast), { force: true });
                void askAndRemove(links);
            });
        },
    });
}

/**
 * Looks at links the quick in-page check could not place, asks the server, and shows one notice for those
 * that really are gone. A list that fails to load or a lookup that errors says nothing: no warning, and the
 * link stays untold so the next open asks again.
 * @param {{ chatKey: string, candidates: import('./lorebook-links.js').LorebookLink[] }} options
 * @returns {Promise<import('./lorebook-links.js').LorebookLink[]>} the links the notice named
 */
export async function reportMissingLorebookLinks({ chatKey, candidates }) {
    if (!isLorebookChatCurrent(chatKey)) return [];
    const names = await fetchLorebookNames();
    if (!names || !isLorebookChatCurrent(chatKey)) return [];

    const missing = findMissingLorebookLinks(candidates, names);
    const settled = candidates.filter(link => !missing.includes(link));
    const gone = [];
    const answers = new Map();
    for (const link of missing) {
        if (!answers.has(link.name)) answers.set(link.name, await lorebookFileExists(link.name));
        if (!isLorebookChatCurrent(chatKey)) return [];
        const answer = answers.get(link.name);
        if (answer === false) gone.push(link);
        else if (answer === true) settled.push(link);
    }

    takeUntoldLorebookLinks(chatKey, settled);
    const fresh = takeUntoldLorebookLinks(chatKey, gone);
    if (fresh.length) showNotice(fresh);
    return fresh;
}
