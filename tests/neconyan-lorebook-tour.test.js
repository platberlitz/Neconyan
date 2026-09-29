import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

let getLorebookTourSteps;
let parseLorebookTourCopy;
let followLorebookTourStep;

beforeAll(async () => {
    await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
        t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), ''),
    }));
    await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: jest.fn(), setItem: jest.fn() } }));
    await jest.unstable_mockModule('../public/scripts/neconyan-assistant-art.js', () => ({ getAssistantIconSrc: () => 'nori.png' }));
    ({ getLorebookTourSteps, parseLorebookTourCopy, followLorebookTourStep } = await import('../public/scripts/neconyan-lorebook-tour.js'));
});

describe('Lorebooks tour follows the user', () => {
    const full = getSteps => getSteps({ hasBooks: true, hasEntries: true });

    test('opening a book from any library step jumps to adding an entry', () => {
        for (const stepId of ['welcome', 'folders', 'create', 'open']) {
            expect(followLorebookTourStep(stepId, { view: 'book', steps: full(getLorebookTourSteps) })).toBe('add-entry');
        }
    });

    test('opening an entry jumps to keywords, going back to the library returns to picking a book', () => {
        const steps = full(getLorebookTourSteps);
        expect(followLorebookTourStep('edit-entry', { view: 'book', entryOpened: true, steps })).toBe('keywords');
        expect(followLorebookTourStep('add-entry', { view: 'book', entryOpened: true, steps })).toBe('keywords');
        expect(followLorebookTourStep('keywords', { view: 'library', steps })).toBe('open');
    });

    test('stays put when nothing relevant changed', () => {
        const steps = full(getLorebookTourSteps);
        expect(followLorebookTourStep('welcome', { view: 'library', steps })).toBe('');
        expect(followLorebookTourStep('health', { view: 'book', entryOpened: true, steps })).toBe('');
        expect(followLorebookTourStep('add-entry', { view: 'book', steps })).toBe('');
    });
});

describe('Lorebooks tour steps', () => {
    test('walks the whole book when there is a book with entries', () => {
        const steps = getLorebookTourSteps({ hasBooks: true, hasEntries: true });
        expect(steps.map(step => step.id)).toEqual([
            'welcome', 'folders', 'create', 'open', 'add-entry', 'edit-entry', 'keywords', 'content', 'health', 'switch-on', 'done',
        ]);
        expect(steps.find(step => step.id === 'create').body).not.toContain('Make one now');
    });

    test('skips steps that need a book and asks for one when the library is empty', () => {
        const steps = getLorebookTourSteps({ hasBooks: false });
        expect(steps.map(step => step.id)).toEqual(['welcome', 'folders', 'create', 'switch-on', 'done']);
        expect(steps.find(step => step.id === 'create').body).toContain('Make one now');
    });

    test('skips entry steps and asks for an entry when the book is empty', () => {
        const steps = getLorebookTourSteps({ hasBooks: true, hasEntries: false });
        expect(steps.map(step => step.id)).not.toContain('keywords');
        expect(steps.find(step => step.id === 'add-entry').body).toContain('no entries yet');
    });

    test('every step points at something and speaks plainly', () => {
        for (const step of getLorebookTourSteps({ hasBooks: true, hasEntries: true })) {
            expect(step.targets.length).toBeGreaterThan(0);
            for (const text of [step.title, step.body, step.hint]) {
                expect(text).toBeTruthy();
                expect(text).not.toMatch(/\u2014/);
            }
        }
    });
});

describe('Lorebooks tour copy', () => {
    test('splits paragraphs and bold runs without markup', () => {
        expect(parseLorebookTourCopy('Press **Add entry** now.\n\nThen **Next**')).toEqual([
            [{ text: 'Press ', bold: false }, { text: 'Add entry', bold: true }, { text: ' now.', bold: false }],
            [{ text: 'Then ', bold: false }, { text: 'Next', bold: true }],
        ]);
        expect(parseLorebookTourCopy('<img src=x>')).toEqual([[{ text: '<img src=x>', bold: false }]]);
    });
});

describe('Lorebooks tour wiring', () => {
    test('mounts with the lorebook workspace', () => {
        expect(read('../public/scripts/neconyan-native-workspaces.js')).toMatch(/import\('\.\/neconyan-lorebook-tour\.js'\)\.then\(\(\{ mountLorebookTour \}\) => mountLorebookTour\(worldInfo\)\)/);
    });

    test('pressing the tour card does not close the Lorebooks drawer', () => {
        const script = read('../public/script.js');
        const list = script.slice(script.indexOf('const forbiddenTargets'), script.indexOf('];', script.indexOf('const forbiddenTargets')));
        expect(list).toContain('\'#neconyan-lorebook-tour\'');
    });

    test('the tour never writes copy through innerHTML', () => {
        expect(read('../public/scripts/neconyan-lorebook-tour.js')).not.toMatch(/innerHTML|insertAdjacentHTML/);
    });

    test('the highlight glow stops for reduced motion', () => {
        const css = read('../public/css/world-info.css');
        expect(css).toMatch(/\.neconyan-lorebook-tour-target\s*\{[^}]*animation:\s*neconyan-lorebook-tour-glow/);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.neconyan-lorebook-tour-target\s*\{\s*animation:\s*none;/);
    });

    test('the card stacks above the drawer layer that iOS lifts to --sb-z-popout', () => {
        const tabsCss = read('../public/css/neconyan-tabs.css');
        expect(tabsCss).toMatch(/@supports \(-webkit-touch-callout: none\)\s*\{\s*#top-settings-holder\s*\{[^}]*z-index:\s*var\(--sb-z-popout\)/);
        const card = read('../public/css/world-info.css').match(/#neconyan-lorebook-tour\.neconyan-lorebook-tour\s*\{([^}]*)\}/)[1];
        expect(card).toMatch(/z-index:\s*calc\(var\(--sb-z-popout, 4000\) \+ \d+\)/);
    });
});
