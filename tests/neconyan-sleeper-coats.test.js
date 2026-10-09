import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
    SLEEPER_COAT_CHANGE_EVENT,
    SLEEPER_COAT_GROUPS,
    SLEEPER_COAT_PAIRS,
    SLEEPER_COAT_STORAGE_KEYS,
    SLEEPER_COATS,
    dressSleeper,
    getSleeperCoat,
    getSleeperCoatPair,
    setSleeperCoat,
    setSleeperCoatPair,
    sleeperCoatArt,
} from '../public/scripts/neconyan-sleeper-coats.js';

class FakeImage {
    constructor(isUser = false) {
        this.attributes = new Map([['src', '/img/neconyan/sleeping-calico-left.webp']]);
        this.classes = new Set(isUser ? ['neconyan-message-sleeper', 'is-user'] : ['neconyan-message-sleeper']);
        this.dataset = {};
        this.classList = {
            contains: name => this.classes.has(name),
            toggle: (name, force) => (force ? this.classes.add(name) : this.classes.delete(name), force),
        };
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

describe('sleeping cat coats', () => {
    let store;
    let images;
    let events;

    beforeEach(() => {
        store = new Map();
        images = [];
        events = [];
        global.localStorage = {
            getItem: key => store.get(key) ?? null,
            setItem: (key, value) => store.set(key, String(value)),
        };
        global.document = {
            querySelectorAll: () => images,
            dispatchEvent: event => events.push(event),
        };
    });

    afterEach(() => {
        delete global.localStorage;
        delete global.document;
    });

    test('keeps the calico on character messages and the ginger tabby on yours by default', () => {
        expect(getSleeperCoat('character')).toBe('calico');
        expect(getSleeperCoat('user')).toBe('tiger');
        expect(sleeperCoatArt('calico', false)).toEqual({ coat: 'calico', src: '/img/neconyan/sleeping-calico-left.webp', mirrored: false });
        expect(sleeperCoatArt('tiger', true)).toEqual({ coat: 'tiger', src: '/img/neconyan/sleeping-tiger-right.webp', mirrored: false });
    });

    test('mirrors any coat onto the side it was not painted for', () => {
        expect(sleeperCoatArt('leopard', true)).toEqual({ coat: 'leopard', src: '/img/neconyan/sleeping-leopard-left.webp', mirrored: true });
        expect(sleeperCoatArt('tiger', false)).toEqual({ coat: 'tiger', src: '/img/neconyan/sleeping-tiger-right.webp', mirrored: true });
        expect(sleeperCoatArt('calico', true).mirrored).toBe(true);
    });

    test('falls back to the side default for unknown or stale saved coats', () => {
        store.set(SLEEPER_COAT_STORAGE_KEYS.user, 'dragon');
        expect(getSleeperCoat('user')).toBe('tiger');
        expect(sleeperCoatArt('dragon', false).coat).toBe('calico');
    });

    test('mixes and matches the two sides and redresses cats already on screen', () => {
        const character = new FakeImage(false);
        const user = new FakeImage(true);
        images.push(character, user);

        expect(setSleeperCoat('user', 'grey-tabby')).toBe('grey-tabby');
        expect(setSleeperCoat('character', 'leopard')).toBe('leopard');

        expect(store.get(SLEEPER_COAT_STORAGE_KEYS.user)).toBe('grey-tabby');
        expect(store.get(SLEEPER_COAT_STORAGE_KEYS.character)).toBe('leopard');
        expect(user.getAttribute('src')).toBe('/img/neconyan/sleeping-grey-tabby-left.webp');
        expect(user.classList.contains('is-mirrored')).toBe(true);
        expect(user.dataset.sleeperCoat).toBe('grey-tabby');
        expect(character.getAttribute('src')).toBe('/img/neconyan/sleeping-leopard-left.webp');
        expect(character.classList.contains('is-mirrored')).toBe(false);
        expect(events.map(event => [event.type, event.detail])).toEqual([
            [SLEEPER_COAT_CHANGE_EVENT, { role: 'user', coat: 'grey-tabby' }],
            [SLEEPER_COAT_CHANGE_EVENT, { role: 'character', coat: 'leopard' }],
        ]);
    });

    test('dresses a fresh sleeper for the side it is given', () => {
        store.set(SLEEPER_COAT_STORAGE_KEYS.user, 'tuxedo');
        const img = new FakeImage(false);
        expect(dressSleeper(img, true)).toBe('/img/neconyan/sleeping-tuxedo-left.webp');
        expect(img.classList.contains('is-user')).toBe(true);
        expect(img.classList.contains('is-mirrored')).toBe(true);
    });

    test('offers every coat in a group and only pairs made of real, different coats', () => {
        const ids = SLEEPER_COATS.map(coat => coat.id);
        const groups = SLEEPER_COAT_GROUPS.map(group => group.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(SLEEPER_COATS.every(coat => groups.includes(coat.group))).toBe(true);
        expect(new Set(SLEEPER_COAT_PAIRS.map(pair => pair.id)).size).toBe(SLEEPER_COAT_PAIRS.length);
        expect(new Set(SLEEPER_COAT_PAIRS.map(pair => `${pair.user}/${pair.character}`)).size).toBe(SLEEPER_COAT_PAIRS.length);
        for (const pair of SLEEPER_COAT_PAIRS) {
            expect(ids).toContain(pair.user);
            expect(ids).toContain(pair.character);
            expect(pair.user).not.toBe(pair.character);
        }
        expect(SLEEPER_COAT_PAIRS[0]).toMatchObject({ id: 'classic', user: 'tiger', character: 'calico' });
    });

    test('a pair sets both cats, and changing one cat turns it back into your own mix', () => {
        expect(getSleeperCoatPair()).toBe('classic');
        expect(setSleeperCoatPair('snow-cats')).toBe('snow-cats');
        expect(getSleeperCoat('user')).toBe('snow-leopard');
        expect(getSleeperCoat('character')).toBe('white-tiger');
        expect(getSleeperCoatPair()).toBe('snow-cats');
        setSleeperCoat('character', 'calico');
        expect(getSleeperCoatPair()).toBeNull();
        expect(setSleeperCoatPair('no-such-pair')).toBeNull();
        expect(getSleeperCoat('character')).toBe('calico');
    });

    test('exposes the dresser to bundled extensions without an import', () => {
        expect(typeof global.NeconyanSleepers.dress).toBe('function');
        expect(global.NeconyanSleepers.coats.map(coat => coat.id)).toContain('russian-blue');
    });
});
