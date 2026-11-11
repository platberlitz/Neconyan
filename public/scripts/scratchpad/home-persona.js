import { event_types, eventSource } from '../events.js';

let choice = '';

/** Only a persona the user picks on Home counts; a chat's automatic pick stays hidden. */
export function noteHomePersonaChoice(avatar, { automatic = false } = {}) {
    choice = !automatic && avatar && globalThis.document?.body?.classList.contains('neconyan-home-visible') ? String(avatar) : '';
}

export function clearHomePersonaChoice() {
    choice = '';
}

export function homePersonaChoice() {
    return choice;
}

/** Registered at startup, so a switch made before Scratchpad opens still counts. */
export function wireHomePersonaChoice() {
    eventSource.on(event_types.PERSONA_CHANGED, (avatar, options) => noteHomePersonaChoice(avatar, options));
    eventSource.on(event_types.CHAT_CHANGED, clearHomePersonaChoice);
}
