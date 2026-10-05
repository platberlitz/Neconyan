/* global globalThis */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

let state;
let invites;
let addTourInvitationDismiss;
let dismissTourInvitation;
let restoreTourInvitations;
let ready;
let settingsLoaded;

function node() {
    return { dataset: {}, hidden: false, children: [], attrs: {}, events: {},
        append(...items) { this.children.push(...items); },
        setAttribute(key, value) { this.attrs[key] = value; },
        addEventListener(key, callback) { this.events[key] = callback; },
    };
}

beforeAll(async () => {
    await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings[0] }));
    await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: {
        get isReady() { return ready; },
        getItem: key => state[key] ?? null,
        setItem: (key, value) => { state[key] = value; },
        removeItem: key => { delete state[key]; },
        getState: () => ({ ...state }),
    } }));
    await jest.unstable_mockModule('../public/scripts/events.js', () => ({
        event_types: { SETTINGS_LOADED: 'settings_loaded' },
        eventSource: { once: (_event, callback) => { settingsLoaded.push(callback); } },
    }));
    ({ addTourInvitationDismiss, dismissTourInvitation, restoreTourInvitations } = await import('../public/scripts/neconyan-tour-invitations.js'));
});

beforeEach(() => {
    state = {};
    invites = [];
    ready = true;
    settingsLoaded = [];
    globalThis.document = { createElement: () => node(), querySelectorAll: () => invites };
});

describe('page-tour invitation dismissal', () => {
    test.each(['neconyanToolTourInvite.connections', 'neconyanToolTourInvite.character-library', 'neconyanLorebookTourInvite'])('restores dismissal after settings arrive for an early-mounted %s invitation', key => {
        ready = false;
        const invite = node();
        addTourInvitationDismiss(invite, key, null);
        state[key] = 'seen';
        ready = true;
        settingsLoaded.forEach(callback => callback());
        expect(invite.hidden).toBe(true);
        expect(state).toEqual({ [key]: 'seen' });
    });

    test('keeps invitations hidden while settings load, then shows only undismissed pages', () => {
        ready = false;
        const dismissed = node();
        const fresh = node();
        addTourInvitationDismiss(dismissed, 'neconyanToolTourInvite.sampling', null);
        addTourInvitationDismiss(fresh, 'neconyanToolTourInvite.persona', null);
        expect(dismissed.hidden).toBe(true);
        expect(fresh.hidden).toBe(true);
        state['neconyanToolTourInvite.sampling'] = 'seen';
        ready = true;
        settingsLoaded.forEach(callback => callback());
        expect(dismissed.hidden).toBe(true);
        expect(fresh.hidden).toBe(false);
        expect(state).toEqual({ 'neconyanToolTourInvite.sampling': 'seen' });
    });

    test('X hides only that page, persists across remount and leaves the manual Tour available', () => {
        const invite = node();
        const other = node();
        invites.push(invite, other);
        const focus = jest.fn();
        const root = { querySelector: () => ({ focus }) };
        addTourInvitationDismiss(invite, 'neconyanToolTourInvite.sampling', root);
        addTourInvitationDismiss(other, 'neconyanToolTourInvite.persona', root);
        expect(invite.hidden).toBe(false);
        const close = invite.children[0];
        expect(close.attrs['aria-label']).toContain('Settings');
        expect(close.children[0].children[0].className).toBe('fa-solid fa-xmark');
        close.events.click();
        expect(invite.hidden).toBe(true);
        expect(other.hidden).toBe(false);
        expect(state['neconyanToolTourInvite.sampling']).toBe('seen');
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        const remounted = node();
        addTourInvitationDismiss(remounted, 'neconyanToolTourInvite.sampling', root);
        expect(remounted.hidden).toBe(true);
    });

    test('Settings restores seen tool and Lorebooks invitations, even when not mounted', () => {
        state = { 'neconyanToolTourInvite.sampling': 'seen', 'neconyanToolTourInvite.server': 'seen', neconyanLorebookTourInvite: 'seen', firstPaws: 'seen', unrelated: 'keep' };
        const invite = node();
        addTourInvitationDismiss(invite, 'neconyanLorebookTourInvite', null);
        invites.push(invite);
        restoreTourInvitations();
        expect(invite.hidden).toBe(false);
        expect(state).toEqual({ firstPaws: 'seen', unrelated: 'keep' });
        const remounted = node();
        addTourInvitationDismiss(remounted, 'neconyanToolTourInvite.server', null);
        expect(remounted.hidden).toBe(false);
    });

    test('Not now and starting a tour share the permanent dismissal state', () => {
        const invite = node();
        addTourInvitationDismiss(invite, 'neconyanLorebookTourInvite', null);
        invites.push(invite);
        dismissTourInvitation('neconyanLorebookTourInvite');
        expect(invite.hidden).toBe(true);
        restoreTourInvitations();
        expect(invite.hidden).toBe(false);
    });

    test('both page types register the X and Settings offers a searchable restore action', () => {
        const read = name => readFileSync(new URL(`../public/scripts/${name}.js`, import.meta.url), 'utf8');
        expect(read('neconyan-tool-tour')).toContain('addTourInvitationDismiss(invite, `${TOOL_TOUR_INVITE_PREFIX}${page.key}`, heading ?? root)');
        expect(read('neconyan-lorebook-tour')).toContain('addTourInvitationDismiss(invite, LOREBOOK_TOUR_INVITE_KEY, root)');
        expect(read('neconyan-tabs')).toContain('id: \'sb-restore-tour-invitations\'');
        expect(read('neconyan-tabs')).toContain('restoreTourInvitations();');
        const css = readFileSync(new URL('../public/css/neconyan.css', import.meta.url), 'utf8');
        expect(css).toMatch(/#sb-restore-tour-invitations\s*\{[^}]*min-height:\s*44px/);
    });

    test('Settings can hide every tour button and bring them back', () => {
        const tabs = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
        expect(tabs).toContain('tourButtonsHidden: \'sb-tour-buttons-hidden\'');
        expect(tabs).toContain('id: \'sb-hide-tour-buttons-input\'');
        expect(tabs).toContain('onChange: input => setTourButtonsHidden(input.checked)');
        expect(tabs).toContain('setTourButtonsHidden(nnState.tourButtonsHidden, { persist: false });');
        const selector = tabs.match(/const NN_TOUR_BUTTON_SELECTOR = '([^']+)'/)?.[1] ?? '';
        for (const target of ['.neconyan-tool-tour-button', '.neconyan-lorebook-tour-button', '.neconyan-tool-tour-invite', '.neconyan-lorebook-tour-invite', '[data-action="replay-tutorial"]']) {
            expect(selector).toContain(target);
        }
        expect(tabs).toMatch(/delete document\.documentElement\.dataset\.sbTourButtonsHidden;\s*style\?\.remove\(\);/);
    });
});
