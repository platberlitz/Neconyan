import { IMAGE_INPUT_SETTINGS_CHANGED } from '../../../prompt-media-policy.js';

export const WORKSPACE_STATE_CHANGED = 'sb:conversation-workspace-state-changed';
// The 'Send inline media' checkbox in the Chat Completion settings; it has no event of its own.
export const INLINE_MEDIA_CHECKBOX_ID = 'openai_media_inlining';
// App events after which the 'Right now' line can be out of date: another chat, another main API, or a preset or connection
// profile that sets 'Send inline media'.
export const IMAGE_INPUT_REFRESH_EVENTS = ['CHAT_CHANGED', 'MAIN_API_CHANGED', 'OAI_PRESET_CHANGED_AFTER', 'CONNECTION_PROFILE_LOADED'];

/**
 * Refreshes the 'Right now' line on the app's own events. Nothing polls; each event runs the refresh once.
 * @param {{subscribe: Function}} lifecycle A lifecycle scope (lib/lifecycle.js)
 * @param {object} eventSource The app's event source
 * @param {Record<string, string>} eventTypes The app's event names
 * @param {() => void} refresh
 */
export function bindImageInputRefreshEvents(lifecycle, eventSource, eventTypes, refresh) {
    for (const name of IMAGE_INPUT_REFRESH_EVENTS) {
        if (eventTypes?.[name]) lifecycle.subscribe(eventSource, eventTypes[name], refresh);
    }
}

/**
 * Refreshes the line on the page's own signals: Conversation opening or closing, a setting changed in the review dialogs or User
 * Settings (prompt-media-ui.js sends IMAGE_INPUT_SETTINGS_CHANGED), and the 'Send inline media' checkbox being toggled. The
 * checkbox's own handler has already stored the new value by the time the event reaches the document.
 * @param {{listen: Function}} lifecycle A lifecycle scope (lib/lifecycle.js)
 * @param {{window: EventTarget, document: EventTarget, defer?: (callback: () => void) => void}} page
 * @param {() => void} refresh
 */
export function bindImageInputRefreshPage(lifecycle, { window: pageWindow, document: pageDocument, defer = callback => requestAnimationFrame(callback) }, refresh) {
    lifecycle.listen(pageWindow, WORKSPACE_STATE_CHANGED, () => { defer(refresh); });
    lifecycle.listen(pageWindow, IMAGE_INPUT_SETTINGS_CHANGED, () => { refresh(); });
    lifecycle.listen(pageDocument, 'input', event => { if (event.target?.id === INLINE_MEDIA_CHECKBOX_ID) refresh(); });
}
