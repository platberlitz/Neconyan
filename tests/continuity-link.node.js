import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const {
    buildContinuityCorrectionsText,
    continuityCorrectionsFromRuns,
    describeTextCorrections,
    latestContinuityNotes,
} = await import('../public/scripts/extensions/in-chat-agents/continuity-link.js');

const templates = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);
const readTemplate = name => JSON.parse(fs.readFileSync(new URL(name, templates), 'utf8'));
const corrector = { id: 'fixer', enabled: true, sourceTemplateId: 'tpl-continuity-corrector' };
const companion = { id: 'notes', enabled: true, sourceTemplateId: 'tpl-continuity-companion' };

test('corrections list only the sentences a rewrite changed, removed or added', () => {
    const before = 'Mara pulls on both gloves. The bell rings. She runs.';
    const after = 'Mara pulls on her right glove. The bell rings. She runs. The gate creaks.';
    assert.deepEqual(describeTextCorrections(before, after), [
        { before: 'Mara pulls on both gloves.', after: 'Mara pulls on her right glove.' },
        { before: '', after: 'The gate creaks.' },
    ]);
    assert.deepEqual(describeTextCorrections(before, before), []);
    assert.deepEqual(describeTextCorrections(before, ''), []);
});

test('very long corrections are shortened and a heavy rewrite is summed up', () => {
    const [change] = describeTextCorrections('Short.', `${'a'.repeat(400)}.`);
    assert.equal(change.after.length, 300);
    assert.ok(change.after.endsWith('…'));
    const many = Array.from({ length: 401 }, (_, index) => `Line ${index}.`).join(' ');
    assert.deepEqual(describeTextCorrections(many, 'Gone.'), [{ before: '', after: 'The reply was rewritten too heavily to list each change.' }]);
});

test('only finished runs of a switched-on Corrector count as fixes', () => {
    const runs = [
        { agentId: 'fixer', corrections: [{ before: 'A.', after: 'B.' }] },
        { agentId: 'other', corrections: [{ before: 'C.', after: 'D.' }] },
    ];
    assert.deepEqual(continuityCorrectionsFromRuns(runs, [corrector]), [{ before: 'A.', after: 'B.' }]);
    assert.equal(continuityCorrectionsFromRuns(runs, [{ ...corrector, enabled: false }]), null);
    assert.equal(continuityCorrectionsFromRuns([{ agentId: 'fixer', status: 'failed' }], [corrector]), null);
    const browserRun = { agentId: 'fixer', beforeText: 'She waits. It rains.', nextMessageText: 'She waits. It snows.' };
    assert.deepEqual(continuityCorrectionsFromRuns([browserRun], [corrector]), [{ before: 'It rains.', after: 'It snows.' }]);
});

test('the Companion is told what was fixed, that nothing was, or nothing at all', () => {
    assert.equal(buildContinuityCorrectionsText(null), '');
    assert.equal(buildContinuityCorrectionsText([]), 'The Continuity Corrector made no changes to this reply.');
    assert.equal(buildContinuityCorrectionsText([
        { before: 'A.', after: 'B.' }, { before: 'C.', after: '' }, { before: '', after: 'D.' },
    ]), '- Changed "A." to "B."\n- Removed "C."\n- Added "D."');
});

test('the Corrector reads the newest finished note of a switched-on Continuity Companion', () => {
    const messages = [
        { is_user: false, extra: { inChatAgentCompanionResults: { notes: { status: 'done', content: 'Older note' } } } },
        { is_user: false, extra: { inChatAgentCompanionResults: { notes: { status: 'done', content: 'Newer note' } } } },
        { is_user: false, extra: { inChatAgentCompanionResults: { notes: { status: 'failed', content: 'Broken note' } } } },
        { is_user: true, extra: { inChatAgentCompanionResults: { notes: { status: 'done', content: 'User note' } } } },
    ];
    assert.equal(latestContinuityNotes(messages, [companion]), 'Newer note');
    assert.equal(latestContinuityNotes(messages, [{ ...companion, enabled: false }]), '');
    assert.equal(latestContinuityNotes(messages, [corrector]), '');
});

test('the linked prompts carry their blocks', () => {
    assert.match(readTemplate('continuity-corrector.json').prompt, /<continuity_notes>\n\{\{continuity-notes\}\}\n<\/continuity_notes>/);
    assert.match(readTemplate('continuity-companion.json').prompt, /<corrector_fixes>\n\{\{continuity-corrections\}\}\n<\/corrector_fixes>/);
});
