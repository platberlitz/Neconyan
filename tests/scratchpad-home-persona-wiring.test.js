import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const personas = read('public/scripts/personas.js');
const tabs = read('public/scripts/neconyan-tabs.js');
const chrome = read('public/scripts/neconyan-conversation/chrome.js');
const welcome = read('public/scripts/welcome-screen.js');
const hopper = read('public/scripts/extensions/third-party/Neconyan-Hopper/src/api.js');
const scratchpadSend = read('public/scripts/scratchpad/index.js');

describe('persona switches say whether the user made them', () => {
    test('setUserAvatar emits the automatic flag as a second argument, defaulting to a user pick', () => {
        expect(personas).toContain('navigationGuard = () => true, automatic = false } = {}) {');
        expect(personas).toContain('await eventSource.emit(event_types.PERSONA_CHANGED, user_avatar, { automatic });');
    });

    test.each([
        ['the chat-load persona search', 'await setUserAvatar(userAvatars[0], { toastPersonaNameChange: false, navigateToCurrent: true, automatic: true });'],
        ['the chat-load persona selection', 'await setUserAvatar(chatPersona, { toastPersonaNameChange: false, navigateToCurrent: true, automatic: true });'],
        ['autoSelectPersona', 'await setUserAvatar(persona.avatar, { automatic: true });'],
        ['the /persona command by avatar', 'await setUserAvatar(avatarMatch[0], { automatic: true });'],
    ])('%s passes automatic: true', (_label, line) => {
        expect(personas).toContain(line);
    });

    test('a Hopper session activation passes automatic: true', () => {
        expect(hopper).toContain('await setUserAvatar(targetPersonaId, { toastPersonaNameChange: false, automatic: true });');
    });

    test('the persona list click records the hand pick before the switch, so re-clicking the selected persona counts', () => {
        expect(personas).toContain('        const imgfile = $(this).attr(\'data-avatar-id\');\n        noteHomePersonaChoice(imgfile);\n        await setUserAvatar(imgfile);');
    });

    test('the Conversation persona picker records the hand pick and leaves its switch unflagged', () => {
        expect(chrome).toContain('                    noteHomePersonaChoice(avatarId);\n                    if (!await switchConversationPersona(avatarId)) {');
        expect(chrome).toContain('switchConversationPersona(personaId, { readOnlyRoute: savedOnly, navigationGuard, automatic: true })');
    });

    test('a conversation opened from a route is flagged as automatic', () => {
        expect(chrome).toMatch(/export async function selectConversationThread[\s\S]*?switchConversationPersona\(personaId, \{ readOnlyRoute: savedOnly, navigationGuard, automatic: true \}\)/);
    });

    test('leaving Home clears the hand-picked persona', () => {
        const conceal = welcome.slice(welcome.indexOf('export function concealWelcomeHome'), welcome.indexOf('globalThis.NeconyanWelcome'));
        expect(conceal).toMatch(/if \(wasVisible\) \{\s*clearHomePersonaChoice\(\);/);
        expect(welcome).toContain('import { clearHomePersonaChoice } from \'./scratchpad/home-persona.js\';');
    });
});

describe('the Home persona listeners are registered at boot', () => {
    test('neconyan-tabs.js imports and calls wireHomePersonaChoice at module load, not only when Scratchpad opens', () => {
        expect(tabs).toContain('import { wireHomePersonaChoice } from \'./scratchpad/home-persona.js\';');
        expect(tabs).toMatch(/\nwireHomePersonaChoice\(\);\n/);
    });
});

describe('the persona save before a reply', () => {
    test('the connection save runs once, and the persona save only for a Roleplay chat whose connections were not saved', () => {
        expect(scratchpadSend).toContain('const connectionsSaved = !(chatProfileId || assistants.every(assistant => assistantConnection(settings, assistant).kind === \'profile\'));');
        expect(scratchpadSend).toContain('const acknowledgement = connectionsSaved ? await acknowledge() : undefined;');
        expect(scratchpadSend).toContain('const personaSaved = !context.capabilities.persona || !needsSavedPersonaSelection(source, connectionsSaved) || await saveSelectedPersona();');
        expect(scratchpadSend.match(/saveSelectedPersona\(\)/g)).toHaveLength(1);
    });

    test('when the persona cannot be saved the reply is still sent, without the persona proposal capability, and the user is told', () => {
        expect(scratchpadSend).toContain('if (!personaSaved) toastr.warning(');
        expect(scratchpadSend).toContain('const capabilities = personaSaved ? context.capabilities : Object.fromEntries(Object.entries(context.capabilities).filter(([key]) => key !== \'persona\'));');
        expect(scratchpadSend).toContain('capabilities: { ...capabilities, image: app.imageAvailability.image },');
    });
});
