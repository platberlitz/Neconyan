/* global globalThis */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

let state;
let createPageIntro;
let ready;
let settingsLoaded;
function node() {
    return { dataset: {}, children: [], attrs: {}, events: {}, hidden: false,
        append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this.attrs[name] = value; },
        getAttribute(name) { return this.attrs[name]; },
        addEventListener(name, callback) { this.events[name] = callback; },
    };
}
beforeAll(async () => {
    await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: {
        get isReady() { return ready; },
        getItem: key => state[key] ?? null,
        setItem: (key, value) => { state[key] = value; },
    } }));
    await jest.unstable_mockModule('../public/scripts/events.js', () => ({
        event_types: { SETTINGS_LOADED: 'settings_loaded' },
        eventSource: { once: (_event, callback) => { settingsLoaded = callback; } },
    }));
    ({ createPageIntro } = await import('../public/scripts/neconyan-page-intro.js'));
});
beforeEach(() => {
    state = {};
    ready = true;
    settingsLoaded = null;
    globalThis.document = { createElement: node };
});

describe('compact page introductions', () => {
    test('starts on one row with an accessible toggle and a separate usable Tour button', () => {
        const launch = node();
        const intro = createPageIntro('mewmory', 'Long-term memory', 'Full description', launch);
        const [toggle, tour, copy] = intro.children;
        expect(toggle.type).toBe('button');
        expect(toggle.attrs['aria-expanded']).toBe('false');
        expect(toggle.attrs['aria-controls']).toBe(copy.id);
        expect(copy.hidden).toBe(true);
        expect(tour).toBe(launch);
        expect(tour.hidden).toBe(false);
        expect(toggle.children[1].textContent).toBe('Long-term memory');
        expect(state).toEqual({});
    });

    test('remembers expansion and collapse independently per page across remounts', () => {
        const make = key => createPageIntro(key, 'Title', 'Description', node());
        make('mewmory').children[0].events.click();
        const reopened = make('mewmory');
        expect(reopened.children[0].attrs['aria-expanded']).toBe('true');
        expect(reopened.children[2].hidden).toBe(false);
        expect(make('sampling').children[2].hidden).toBe(true);
        reopened.children[0].events.click();
        expect(make('mewmory').children[2].hidden).toBe(true);
        expect(state).toEqual({ 'neconyanPageIntroExpanded.mewmory': 'false' });
    });

    test('leaves invitation dismissal and restoration preferences untouched', () => {
        state = { 'neconyanToolTourInvite.mewmory': 'seen' };
        createPageIntro('mewmory', 'Title', 'Description', node()).children[0].events.click();
        expect(state['neconyanToolTourInvite.mewmory']).toBe('seen');
    });

    test('restores saved expansion when a tab was built before account settings arrived', () => {
        ready = false;
        const intro = createPageIntro('mewmory', 'Title', 'Description', node());
        expect(intro.children[2].hidden).toBe(true);
        state['neconyanPageIntroExpanded.mewmory'] = 'true';
        ready = true;
        settingsLoaded();
        expect(intro.children[0].attrs['aria-expanded']).toBe('true');
        expect(intro.children[2].hidden).toBe(false);
    });

    test('header blurbs stay visible without a redundant kicker or remembered collapse', () => {
        state = { 'neconyanPageIntroExpanded.connections': 'false' };
        const launch = node();
        const intro = createPageIntro('connections', 'Your model', 'Choose your model.', launch, { header: true });
        expect(intro.className).toBe('neconyan-tool-page-intro neconyan-page-intro-header');
        expect(intro.children).toHaveLength(2);
        expect(intro.children[0].hidden).toBe(false);
        expect(intro.children[0].children[0].textContent).toBe('Choose your model.');
        expect(intro.children[1]).toBe(launch);
        expect(state).toEqual({ 'neconyanPageIntroExpanded.connections': 'false' });
        expect(settingsLoaded).toBeNull();
    });

    test('all tool page intros use the shared control with a header option', () => {
        const read = file => readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
        expect(read('scripts/neconyan-tool-tour.js')).toContain('createPageIntro(page.key, t([page.kicker]), t([page.description]), launch, { header: Boolean(headerHeading) })');
        expect(read('css/neconyan-tool-pages.css')).toContain('grid-template-columns: minmax(0, 1fr) auto');
        expect(read('css/neconyan-tool-pages.css')).toContain('.neconyan-tool-page-copy[hidden]');
    });
});
