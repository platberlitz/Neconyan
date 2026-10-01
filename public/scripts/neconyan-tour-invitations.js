import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';

export const TOOL_TOUR_INVITE_PREFIX = 'neconyanToolTourInvite.';
export const LOREBOOK_TOUR_INVITE_KEY = 'neconyanLorebookTourInvite';

/** Remember dismissal for this page without removing its manual Tour button. */
export function dismissTourInvitation(key) {
    accountStorage.setItem(key, 'seen');
    document.querySelectorAll('[data-neconyan-tour-invite-key]').forEach(invite => {
        if (invite.dataset.neconyanTourInviteKey === key) invite.hidden = true;
    });
}

/** Add the persistent X to a page invitation, with the same state as Not now. */
export function addTourInvitationDismiss(invite, key, root) {
    invite.dataset.neconyanTourInviteKey = key;
    invite.hidden = accountStorage.getItem(key) === 'seen';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'menu_button neconyan-tour-invite-dismiss';
    close.title = t`Hide this invitation until restored in Settings`;
    close.setAttribute('aria-label', close.title);
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-xmark';
    icon.setAttribute('aria-hidden', 'true');
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.append(icon);
    close.append(glyph);
    close.addEventListener('click', () => {
        dismissTourInvitation(key);
        root?.querySelector('.neconyan-tool-tour-button, .neconyan-lorebook-tour-button')?.focus({ preventScroll: true });
    });
    invite.append(close);
}

/** Restore only page-tour invitations, never the first-paws tour or other preferences. */
export function restoreTourInvitations() {
    for (const key of Object.keys(accountStorage.getState())) {
        if (key.startsWith(TOOL_TOUR_INVITE_PREFIX) || key === LOREBOOK_TOUR_INVITE_KEY) {
            accountStorage.removeItem(key);
        }
    }
    document.querySelectorAll('[data-neconyan-tour-invite-key]').forEach(invite => { invite.hidden = false; });
}
