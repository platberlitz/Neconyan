import { t } from './i18n.js';

/** Keep protected-storage failures actionable without weakening the read guard. */
export function roleplayLoadErrorMessage(error) {
    if (['ROLEPLAY_SOURCE_CHANGED', 'ROLEPLAY_FOREIGN_SOURCE', 'ROLEPLAY_RECOVERY_REQUIRED'].includes(error?.code)) {
        return t`These saved files need recovery. Open Settings > System & Device > Import & Restore > Repair transferred data.`;
    }
    if (error?.code === 'ROLEPLAY_ACCOUNT_CHANGED') return t`The account changed. Reload the page before opening or saving chats.`;
    return t`Could not load chat data. Try reloading the page.`;
}
