// Kept independent of the app modules so launch intent is captured before autoload.
export const CHAT_NAVIGATION_OWNS_LAUNCH = true;
export const chatNavigationLaunchUrl = typeof location === 'undefined' ? '' : location.href;
let blocked = false;
export const isChatNavigationBlocked = () => blocked;
export function setChatNavigationBlocked(value) { blocked = Boolean(value); }

export function hasChatNavigationDraft(mode = 'roleplay') {
    if (typeof document === 'undefined') return false;
    const input = document.getElementById(mode === 'conversation' ? 'sb_conversation_input' : 'send_textarea');
    return Boolean(input?.value?.trim()) || [...document.querySelectorAll('#send_form input[type="file"], #sheld input[type="file"]')].some(field => field.files?.length);
}
