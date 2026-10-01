import { accountStorage } from './util/AccountStorage.js';
import { eventSource, event_types } from './events.js';

export const PAGE_INTRO_EXPANDED_PREFIX = 'neconyanPageIntroExpanded.';

/** Build a compact page introduction, keeping its Tour button available at all times. */
export function createPageIntro(key, kicker, description, launch) {
    const intro = document.createElement('div');
    intro.className = 'neconyan-tool-page-intro neconyan-cat-panel';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'neconyan-page-intro-toggle';
    const icon = document.createElement('i');
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'neconyan-native-kicker';
    label.textContent = kicker;
    toggle.append(icon, label);

    const copy = document.createElement('div');
    copy.className = 'neconyan-tool-page-copy';
    copy.id = `neconyan-page-intro-${key}`;
    toggle.setAttribute('aria-controls', copy.id);
    const text = document.createElement('p');
    text.className = 'neconyan-tool-page-description';
    text.textContent = description;
    copy.append(text);

    const storageKey = `${PAGE_INTRO_EXPANDED_PREFIX}${key}`;
    const update = expanded => {
        intro.dataset.expanded = String(expanded);
        toggle.setAttribute('aria-expanded', String(expanded));
        icon.className = expanded ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-right';
        copy.hidden = !expanded;
    };
    update(accountStorage.getItem(storageKey) === 'true');
    // A saved shell tab can build its introduction before account settings arrive.
    if (!accountStorage.isReady) {
        eventSource.once(event_types.SETTINGS_LOADED, () => update(accountStorage.getItem(storageKey) === 'true'));
    }
    toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') !== 'true';
        update(expanded);
        accountStorage.setItem(storageKey, String(expanded));
    });
    intro.append(toggle, launch, copy);
    return intro;
}
