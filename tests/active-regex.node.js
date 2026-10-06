import assert from 'node:assert/strict';
import test from 'node:test';

const { prepareActiveRegex } = await import('../src/generation/active-regex.js');
const { AGENT_REGEX_PLACEMENT } = await import('../public/scripts/extensions/in-chat-agents/regex-scripts.js');

const script = (id, findRegex) => ({ id, findRegex, replaceString: '', placement: [AGENT_REGEX_PLACEMENT.AI_OUTPUT] });
const material = {
    regexPolicy: {
        disabled: false,
        global: [script('global', '/global/g')],
        characterAllowed: ['Nova.png'],
        presetAllowed: {},
        preset: null,
        presetScripts: [],
    },
};
const nova = { extensions: { regex_scripts: [script('nova', '/nova/g')] } };

test('a request without its captured character is refused when character transformations are allowed', () => {
    assert.throws(() => prepareActiveRegex(material, { extra: {} }), /needs its captured character/);
});

test('a request that speaks as a character applies that character\'s transformations', () => {
    const scripts = prepareActiveRegex(material, { extra: { characterAvatar: 'Nova.png', character: nova } });
    assert.deepEqual(scripts.map(item => item.id), ['global', 'nova']);
});

test('a characterless request keeps global transformations and skips character ones', () => {
    const scripts = prepareActiveRegex(material, { extra: { characterScope: 'none', characterAvatar: 'Nova.png', character: nova } });
    assert.deepEqual(scripts.map(item => item.id), ['global']);
});
