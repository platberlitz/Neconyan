import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCreatorReplyNotRefused } from '../public/scripts/creator/refusal.js';
import { requestCreatorConnection } from '../public/scripts/creator/connection.js';

const refusal = 'I cannot help with this request.';
const messages = [{ role: 'user', content: JSON.stringify({ text: 'A patient shipwright.' }) }];

test('Catelier rejects plain, fenced and nested JSON refusals using the Agent guard', () => {
    for (const output of [refusal, JSON.stringify({ fields: { description: refusal } }), '```json\n' + JSON.stringify({ fields: { description: 'Good prose. '.repeat(100), alternate_greetings: [refusal] } }) + '\n```']) {
        assert.throws(() => assertCreatorReplyNotRefused(output, messages), { code: 'CREATOR_REFUSAL' });
    }
});

test('Catelier preserves refusal phrases already present in the source', () => {
    const text = '"I cannot help with this request," she said.\nShe closed the door.';
    assert.doesNotThrow(() => assertCreatorReplyNotRefused(JSON.stringify({ fields: { first_mes: text } }), [{ role: 'user', content: JSON.stringify({ existingFields: { first_mes: text } }) }]));
    assert.doesNotThrow(() => assertCreatorReplyNotRefused('A careful shipwright.', messages));
    assert.throws(() => assertCreatorReplyNotRefused(refusal, [{ role: 'system', content: refusal }, ...messages]), { code: 'CREATOR_REFUSAL' });
});

test('A refused Catelier reply tries the configured fallback and never returns rejected text', async () => {
    const calls = [];
    const result = await requestCreatorConnection({ writing: { connection: { fallbacks: ['backup'] } } }, {
        validate() {},
        async send(profile) {
            calls.push(profile);
            const output = profile ? 'A careful shipwright.' : refusal;
            assertCreatorReplyNotRefused(output, messages);
            return output;
        },
    });
    assert.deepEqual(calls, ['', 'backup']);
    assert.equal(result, 'A careful shipwright.');
    await assert.rejects(requestCreatorConnection({}, {
        validate() {},
        async send() { assertCreatorReplyNotRefused(refusal, messages); },
    }), error => /Current connection: The model refused/.test(error.message) && !/API key/.test(error.message));
});
