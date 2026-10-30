/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { defaultConfig, validateConfig } = await import('../src/mewmory/models.js');
const { getCounter } = await import('../src/mewmory/tokens.js');

function messageFor(mutate) {
    const config = defaultConfig();
    mutate(config);
    try {
        validateConfig(config);
    } catch (error) {
        return error.message;
    }
    throw new Error('Expected the settings to be rejected.');
}

test('settings validation names the labels shown in Mewmory settings', () => {
    assert.equal(messageFor(config => { config.recentMessages = 0; }),
        'Keep at least this many recent messages must be between 1 and 100000.');
    assert.equal(messageFor(config => { config.historyBatchMessages = 0; }),
        'Remove older chat in groups of must be between 1 and 10000.');
    assert.equal(messageFor(config => { config.autoHideTokens = 100; }),
        'Hide older messages at this chat size, tokens must be between 1024 and 2000000.');
});

test('retrieval validation names the search settings instead of internal keys', () => {
    assert.equal(messageFor(config => { config.retrieval.chunkSize = 1; }),
        'Maximum passage length, characters must be between 256 and 12000.');
    assert.equal(messageFor(config => { config.retrieval.batchSize = 11; }),
        'Passages per meaning-index request must be between 1 and 10.');
    assert.equal(messageFor(config => { config.retrieval.semanticWeight = -1; }),
        'Preference for meaning matches must be between 0 and 1.');
    assert.equal(messageFor(config => { config.retrieval.minSimilarity = 2; }),
        'Minimum meaning match score must be between 0 and 1.');
    assert.equal(messageFor(config => { Object.assign(config.retrieval, { chunkSize: 600, chunkOverlap: 300 }); }),
        'Text repeated between passages must be less than half the maximum passage length.');
});

test('token counter errors point at the replies setting', async () => {
    assert.equal(messageFor(config => { config.writerTokenizer = 'invented'; }),
        'Choose a token counter for replies from the list.');
    await assert.rejects(getCounter('auto', { tokenizerKey: 'api_current' }), /Choose a Token counter for replies/);
});
