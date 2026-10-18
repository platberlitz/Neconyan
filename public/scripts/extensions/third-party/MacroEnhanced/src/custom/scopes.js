/**
 * Scope rules shared by the macro editor, the template gallery and the slash
 * commands. Pure data and plain checks: no DOM, no Neconyan imports.
 */
import { SCOPE_BROWSER, SCOPE_CHARACTER, SCOPE_CHAT, SCOPE_GLOBAL } from './store.js';
import { browserScopeAvailability, getBrowserIdentity } from './browser-store.js';

export const SCOPE_COPY = Object.freeze({
    [SCOPE_GLOBAL]: {
        title: 'Everywhere',
        hint: 'Available in every character and chat.',
    },
    [SCOPE_BROWSER]: {
        title: 'This browser',
        hint: 'Kept on this device for this account. Not synced or backed up. Export to move it.',
    },
    [SCOPE_CHARACTER]: {
        title: 'This character',
        hint: 'Travels with the character card when you share it.',
    },
    [SCOPE_CHAT]: {
        title: 'This chat',
        hint: 'Stored in this chat file only.',
    },
});

function currentBrowserAccount(ctx = SillyTavern.getContext()) {
    try {
        return getBrowserIdentity({ ctx });
    } catch {
        return null;
    }
}

function browserScopeState(ctx = SillyTavern.getContext()) {
    return browserScopeAvailability({ ctx });
}

/** A stable description of where the editor was opened. */
export function snapshotContext(ctx = SillyTavern.getContext()) {
    const character = ctx.characters?.[ctx.characterId];
    return {
        characterId: ctx.characterId ?? null,
        characterAvatar: character?.avatar ?? null,
        groupId: ctx.groupId ?? null,
        chatId: ctx.chatId ?? null,
        chatKey: `${ctx.groupId ?? ''}:${ctx.chatId ?? ''}`,
        browserAccount: currentBrowserAccount(ctx),
        userAvatar: ctx.userAvatar ?? null,
    };
}

function currentCharacterAvatar(ctx = SillyTavern.getContext()) {
    return ctx.characters?.[ctx.characterId]?.avatar ?? null;
}

/** Whether a character scope means one visible character right now. */
export function characterScopeAvailable(ctx = SillyTavern.getContext()) {
    if (ctx.groupId) {
        return { available: false, reason: 'Group chats have several characters, so there is no single character card to save on.' };
    }
    if (ctx.characterId === undefined || ctx.characterId === null || !ctx.characters?.[ctx.characterId]) {
        return { available: false, reason: 'Open a single-character chat first.' };
    }
    return { available: true, reason: '' };
}

export function chatScopeAvailable(ctx = SillyTavern.getContext()) {
    if (!ctx.chatMetadata || ctx.chatId === undefined || ctx.chatId === null || ctx.chatId === '') {
        return { available: false, reason: 'Open a chat first.' };
    }
    return { available: true, reason: '' };
}

/**
 * @param {object} [ctx]
 * @returns {Record<string, {available: boolean, reason: string, title: string, hint: string}>}
 */
export function scopeAvailability(ctx = SillyTavern.getContext()) {
    const browser = browserScopeState(ctx);
    const character = characterScopeAvailable(ctx);
    const chat = chatScopeAvailable(ctx);
    return {
        [SCOPE_GLOBAL]: { ...SCOPE_COPY[SCOPE_GLOBAL], available: true, reason: '' },
        [SCOPE_BROWSER]: { ...SCOPE_COPY[SCOPE_BROWSER], ...browser },
        [SCOPE_CHARACTER]: { ...SCOPE_COPY[SCOPE_CHARACTER], ...character },
        [SCOPE_CHAT]: { ...SCOPE_COPY[SCOPE_CHAT], ...chat },
    };
}

/** Why the current target cannot be saved, or '' when it can. */
export function validateScopeForSave({ scope, persistedScope = null, snapshot, ctx = SillyTavern.getContext() }) {
    const availability = scopeAvailability(ctx);
    if (!availability[scope]?.available) {
        return availability[scope]?.reason || 'That scope is not available right now.';
    }

    if (persistedScope === SCOPE_BROWSER) {
        const account = currentBrowserAccount(ctx);
        if (!account || snapshot.browserAccount !== account) {
            return 'This macro was saved for a different account. Sign back into that account to move it; your draft is still here.';
        }
    }
    if (persistedScope === SCOPE_CHARACTER) {
        if (snapshot.groupId !== (ctx.groupId ?? null)
            || snapshot.characterAvatar !== currentCharacterAvatar(ctx)
            || Boolean(snapshot.groupId)) {
            return 'This macro was saved for a different character. Open that character again to move it; your draft is still here.';
        }
    }
    if (persistedScope === SCOPE_CHAT) {
        if (snapshot.chatKey !== `${ctx.groupId ?? ''}:${ctx.chatId ?? ''}`) {
            return 'This macro was saved for a different chat. Open that chat again to move it; your draft is still here.';
        }
    }
    if (scope === SCOPE_BROWSER && snapshot.browserAccount !== currentBrowserAccount(ctx)) {
        return 'The account changed while you were editing. Sign back into the account you started in to save this draft there.';
    }
    if (scope === SCOPE_CHARACTER
        && (snapshot.groupId !== (ctx.groupId ?? null) || snapshot.characterAvatar !== currentCharacterAvatar(ctx))) {
        return 'The character changed while you were editing. Open the chat you started in to save this draft for that character.';
    }
    if (scope === SCOPE_CHAT
        && snapshot.chatKey !== `${ctx.groupId ?? ''}:${ctx.chatId ?? ''}`) {
        return 'The chat changed while you were editing. Open the chat you started in to save this draft there, or save it everywhere.';
    }
    return '';
}
