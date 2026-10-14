/* global globalThis */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Dialogue Colors reaches the host only through st-api.js, which imports paths that resolve
// inside a running app. Stubbing that one module lets the real extension code run here.
const stApiStub = `
export const converter = { makeHtml: value => String(value) };
export const power_user = { quote_text_color: '#888888', encode_tags: false, personas: {} };
export const escapeHtml = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export const escapeRegex = value => String(value).replace(/[/\\-\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
export const extension_settings = {};
export const getContext = () => globalThis.__dcExclusionsContext ?? { chat: [], chatMetadata: {} };
export const eventSource = { on() {}, emit() {} };
export const event_types = {};
export const setExtensionPrompt = () => {};
export const saveSettings = () => {};
export const saveSettingsDebounced = () => {};
export const saveCharacterDebounced = () => {};
export const getCharacters = () => [];
export const extension_prompt_types = {};
export const extension_prompt_roles = {};
export const generateQuietPrompt = async options => globalThis.__dcExclusionsQuiet?.(options) ?? '';
export const registerMacro = () => {};
export const getRequestHeaders = () => ({});
export const saveMetadata = () => {};
export const saveMetadataDebounced = () => {};
export const promptManager = null;
`;

function createStubElement() {
    return {
        id: '',
        innerHTML: '',
        style: { cssText: '', display: 'none' },
        classList: { add() {}, remove() {}, contains: () => false },
        appendChild() {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        contains: () => false,
        closest: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    };
}

globalThis.document ??= {
    body: createStubElement(),
    activeElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: createStubElement,
    addEventListener() {},
};
globalThis.getComputedStyle ??= () => ({ backgroundColor: 'rgb(0, 0, 0)' });
globalThis.window ??= { innerWidth: 1024, innerHeight: 768, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.fetch ??= async () => ({ ok: true, status: 200, json: async () => ({}) });

const EXTENSION = '../public/scripts/extensions/third-party/sillytavern-character-colors/src';
const stApiUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(stApiStub)}`;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === './st-api.js') return { url: stApiUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const { buildColorRenderingLookup, processColorPairs } = await import(`${EXTENSION}/color-blocks.js`);
const { buildCharacterEntry } = await import(`${EXTENSION}/palettes.js`);
const { buildExcludedSpeakerPromptRule, buildMinimalPromptInstruction, filterPromptCharacterEntries } = await import(`${EXTENSION}/prompts.js`);
const { attributeDialogueSegments } = await import(`${EXTENSION}/attribution.js`);
const {
    addExcludedSpeakerName,
    getExcludedSpeakerNames,
    isExcludedSpeakerName,
    normalizeExcludedSpeakerNames,
    removeExcludedSpeakerName,
} = await import(`${EXTENSION}/speaker-exclusions.js`);
const state = await import(`${EXTENSION}/state.js`);
const { setCharacterColors, settings } = state;
const { normalizeHexColor } = await import(`${EXTENSION}/utils.js`);
hooks.deregister();

const NARRATOR_RED = '#cc2244';
const MIRA_GREEN = '#22aa66';

function withSettings(overrides, run) {
    const previous = {};
    for (const key of Object.keys(overrides)) previous[key] = settings[key];
    Object.assign(settings, overrides);
    try {
        return run();
    } finally {
        Object.assign(settings, previous);
    }
}

function seedMira() {
    const { key, entry } = buildCharacterEntry('Mira', { color: MIRA_GREEN, origin: 'manual' });
    setCharacterColors({ [key]: entry });
}

test.beforeEach(() => {
    globalThis.__dcExclusionsContext = { chat: [], chatMetadata: {}, name1: 'You', name2: 'Narrator' };
    setCharacterColors({});
});

test('a card named Narrator is skipped by default and the option can turn that off', () => {
    assert.equal(settings.skipNarratorCard, true);
    assert.equal(isExcludedSpeakerName('Narrator'), true);
    assert.equal(isExcludedSpeakerName('  narrator '), true);
    assert.equal(isExcludedSpeakerName('Mira'), false);
    withSettings({ skipNarratorCard: false }, () => {
        assert.equal(isExcludedSpeakerName('Narrator'), false);
    });
});

test('a Narrator colour written by the model is flagged so its font tags render plain', () => {
    seedMira();
    const raw = `<font color="${NARRATOR_RED}">"Night falls."</font> <font color="${MIRA_GREEN}">"Hi."</font>\n[COLORS:Narrator=${NARRATOR_RED},Mira=${MIRA_GREEN}]`;
    const narratorColor = normalizeHexColor(NARRATOR_RED, null);
    const miraColor = normalizeHexColor(MIRA_GREEN, null);

    const lookup = buildColorRenderingLookup(raw);
    assert.equal(lookup.get(narratorColor)?.excluded, true);
    assert.equal(lookup.get(miraColor)?.entry?.name, 'Mira');

    withSettings({ skipNarratorCard: false }, () => {
        assert.equal(buildColorRenderingLookup(raw).get(narratorColor)?.excluded, undefined);
    });
});

test('a Narrator pair in a colour block never becomes a character', () => {
    processColorPairs(`Narrator=${NARRATOR_RED}`);
    assert.deepEqual(Object.values(state.characterColors).map(entry => entry.name), []);
});

test('the colouring prompt tells the model to leave Narrator plain', () => {
    seedMira();
    const legacyNarrator = { name: 'Narrator', baseColor: NARRATOR_RED };
    const entries = filterPromptCharacterEntries([...Object.values(state.characterColors), legacyNarrator]);
    assert.deepEqual(entries.map(entry => entry.name), ['Mira']);

    const rule = buildExcludedSpeakerPromptRule();
    assert.match(rule, /"Narrator"/);
    assert.ok(buildMinimalPromptInstruction().includes(rule));

    withSettings({ skipNarratorCard: false }, () => {
        assert.equal(buildExcludedSpeakerPromptRule(), '');
    });
});

const SCENARIO = 'Your Wife Wants To Divorce You';
const TITLED = 'Leonard | Actor';

test('the not-a-character list is cleaned, deduplicated and leaves Narrator to its own option', () => {
    const cleaned = normalizeExcludedSpeakerNames([`  ${SCENARIO} `, SCENARIO.toUpperCase(), TITLED, 'Narrator', '', 42, null]);
    assert.deepEqual(cleaned, [SCENARIO, TITLED]);
    assert.deepEqual(normalizeExcludedSpeakerNames('not a list'), []);
});

test('listed names are not characters, whatever their case', () => {
    withSettings({ excludedSpeakerNames: [SCENARIO, TITLED] }, () => {
        assert.equal(isExcludedSpeakerName(SCENARIO.toLowerCase()), true);
        assert.equal(isExcludedSpeakerName(TITLED), true);
        assert.equal(isExcludedSpeakerName('Leonard'), false);
        assert.equal(buildCharacterEntry(TITLED, { color: MIRA_GREEN, origin: 'detected' }).entry, null);
        assert.ok(buildCharacterEntry('Leonard', { color: MIRA_GREEN, origin: 'detected' }).entry);
    });
});

test('adding and removing names updates the list and the Narrator option', () => {
    withSettings({ excludedSpeakerNames: [], skipNarratorCard: true }, () => {
        assert.equal(addExcludedSpeakerName(SCENARIO), true);
        assert.equal(addExcludedSpeakerName(SCENARIO.toLowerCase()), false);
        assert.deepEqual(getExcludedSpeakerNames(), [SCENARIO]);
        assert.equal(removeExcludedSpeakerName(SCENARIO), true);
        assert.deepEqual(getExcludedSpeakerNames(), []);

        assert.equal(removeExcludedSpeakerName('Narrator'), true);
        assert.equal(settings.skipNarratorCard, false);
        assert.equal(addExcludedSpeakerName('Narrator'), true);
        assert.equal(settings.skipNarratorCard, true);
    });
});

test('a listed card name is never coloured, detected or sent to the model as a character', () => {
    globalThis.__dcExclusionsContext.name2 = SCENARIO;
    withSettings({ excludedSpeakerNames: [SCENARIO, TITLED] }, () => {
        seedMira();
        const scenarioBlue = '#3355ee';
        processColorPairs(`${SCENARIO}=${scenarioBlue},${TITLED}=#aa7711,Mira=${MIRA_GREEN}`);
        assert.deepEqual(Object.values(state.characterColors).map(entry => entry.name), ['Mira']);

        const raw = `<font color="${scenarioBlue}">"Sign here."</font>\n[COLORS:${SCENARIO}=${scenarioBlue},Mira=${MIRA_GREEN}]`;
        assert.equal(buildColorRenderingLookup(raw).get(normalizeHexColor(scenarioBlue, null))?.excluded, true);

        attributeDialogueSegments('"Sign the papers," she said.', SCENARIO, { autoAddMessageSpeaker: true });
        assert.deepEqual(Object.values(state.characterColors).map(entry => entry.name), ['Mira']);

        const rule = buildExcludedSpeakerPromptRule();
        assert.match(rule, new RegExp(SCENARIO));
        assert.ok(rule.includes(JSON.stringify(TITLED)));
    });
});
