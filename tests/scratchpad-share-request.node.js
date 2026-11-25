import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { normaliseCapabilities, shareOffer } = await import('../src/scratchpad/jobs.js');
const { buildScratchpadSystemPrompt, shareRequestInstructions } = await import('../src/scratchpad/prompt.js');

const ALL = ['card', 'persona', 'authorsNote', 'mewmory', 'lore', 'preset', 'problems', 'appEvidence', 'appSource', 'lastPrompt', 'agents', 'companionNotes', 'regex', 'cssSnippets', 'dialogueColors', 'hidden'];
after(() => cancelAutoSaves());

const HOSTILE = [...ALL, 'webSearch', 'prefill', 'config', 'hiddenLore', 'assistantConnections', 'autoSummary', '__proto__', 'constructor', 42, null];

test('share capabilities keep only switches the source mode offers', () => {
    const roleplay = normaliseCapabilities({ shareable: HOSTILE, shareDepth: 12 }, 'roleplay', {});
    assert.deepEqual(roleplay.shareable, ALL);
    assert.equal(roleplay.shareDepth, 12);

    const conversation = normaliseCapabilities({ shareable: HOSTILE, shareDepth: 30 }, 'conversation', {});
    assert.deepEqual(conversation.shareable, ['card', 'persona', 'lore', 'preset', 'problems', 'appEvidence', 'appSource', 'lastPrompt', 'agents', 'regex', 'cssSnippets', 'dialogueColors', 'hidden']);
    assert.equal(conversation.shareDepth, 30);

    const general = normaliseCapabilities({ shareable: HOSTILE, shareDepth: 30 }, 'general', {});
    assert.deepEqual(general.shareable, ['persona', 'preset', 'problems', 'appEvidence', 'appSource', 'agents', 'regex', 'cssSnippets', 'dialogueColors']);
    assert.equal(general.shareDepth, undefined);

    const generalWithCard = normaliseCapabilities({ shareable: ['card', 'mewmory'] }, 'general', { avatar: 'miso.png' });
    assert.deepEqual(generalWithCard.shareable, ['card']);

    const notebook = normaliseCapabilities({ shareable: ALL, shareDepth: 5 }, 'notebook', {});
    assert.equal(notebook.shareable, undefined);
    assert.equal(notebook.shareDepth, undefined);
});

test('share capabilities reject malformed values', () => {
    for (const shareDepth of [-1, 200, 2.5, '12', NaN, Infinity]) {
        assert.equal(normaliseCapabilities({ shareDepth }, 'roleplay', {}).shareDepth, undefined, String(shareDepth));
    }
    assert.equal(normaliseCapabilities({ shareable: 'preset' }, 'roleplay', {}).shareable, undefined);
    assert.equal(normaliseCapabilities({ shareable: [] }, 'roleplay', {}).shareable, undefined);
    assert.deepEqual(normaliseCapabilities({ shareable: ['preset', 'preset'] }, 'roleplay', {}).shareable, ['preset']);
});

test('the share offer follows the session switches the server holds', () => {
    const settings = { depth: 40, picked: [], include: { card: true, persona: true, preset: false, lastPrompt: false } };
    assert.deepEqual(shareOffer({ shareable: ['card', 'preset', 'lastPrompt'], shareDepth: 10 }, settings), { shareable: ['preset', 'lastPrompt'], shareDepth: 40 });
    assert.deepEqual(shareOffer({ shareable: ['card', 'persona'] }, settings), {});
    assert.deepEqual(shareOffer({ shareDepth: 10 }, { ...settings, picked: [{ id: 1 }] }), {});
    assert.deepEqual(shareOffer({ shareDepth: 10 }, { ...settings, depth: 200 }), {});
    assert.deepEqual(shareOffer({}, settings), {});
});

test('the prompt lists only the switches that are off', () => {
    const text = shareRequestInstructions({ shareable: ['preset', 'lastPrompt'], shareDepth: 20 });
    assert.match(text, /^Asking the user to share more context:/);
    assert.match(text, /- preset: Current preset/);
    assert.match(text, /- lastPrompt: Last prompt sent/);
    assert.match(text, /- depth: Recent messages to read \(now 20; ask for a larger number, up to 200\)/);
    assert.match(text, /```neconyan-share-request/);
    assert.match(text, /nothing is shared until they press it/);
    for (const key of ALL.filter(key => !['preset', 'lastPrompt'].includes(key))) {
        assert.doesNotMatch(text, new RegExp(`^- ${key}:`, 'm'), key);
    }
    assert.doesNotMatch(shareRequestInstructions({ shareable: ['preset'] }), /- depth:/);
    assert.equal(shareRequestInstructions({}), '');
    assert.equal(shareRequestInstructions({ shareable: ['webSearch', 'config'] }), '');
    assert.equal(shareRequestInstructions({ shareDepth: 200 }), '');
});

test('the system prompt is unchanged when nothing can be asked for', () => {
    const capabilities = { lore: true, character: true, chat: true, members: [] };
    for (const options of [{}, { customPrompt: 'Help me edit things.' }, { sourceKind: 'general' }, { sourceKind: 'conversation' }]) {
        const base = buildScratchpadSystemPrompt({ assistant: 'miso', ...options, capabilities }).text;
        const empty = buildScratchpadSystemPrompt({ assistant: 'miso', ...options, capabilities: { ...capabilities, shareable: [] } }).text;
        assert.equal(empty, base, JSON.stringify(options));
        const asking = buildScratchpadSystemPrompt({ assistant: 'miso', ...options, capabilities: { ...capabilities, shareable: ['persona'] } }).text;
        const block = shareRequestInstructions({ shareable: ['persona'] });
        assert.ok(asking.includes(block), JSON.stringify(options));
        assert.equal(asking.replace(`${block}\n\n`, ''), base, JSON.stringify(options));
    }
});
