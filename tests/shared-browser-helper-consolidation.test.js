import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAbortLikeError } from '../public/scripts/util/abort-error.js';
import { escapeRegex } from '../public/scripts/util/escape-regex.js';
import { trackNavigationErrors } from './chat-scroll-regression-helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(relativePath) {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('shared browser helper consolidation', () => {
    test('navigation ignores only the verified caught fetch cancellations', async () => {
        let emit;
        const tracker = trackNavigationErrors({ on: (_event, listener) => { emit = listener; } });
        const history = 'Fetch API cannot load http://localhost/api/settings/get due to access control checks.\n at post (/scripts/extensions/third-party/Neconyan-Time-Machine/src/api.js:1)';
        const chats = 'Fetch API cannot load http://localhost/api/characters/chats due to access control checks.\n at fetchCharacterChatFiles (/scripts/neconyan-tabs.js:1)';
        await tracker.navigate(async () => {
            emit({ stack: history });
            emit({ stack: chats });
            emit({ stack: 'Unexpected application error' });
        });
        emit({ stack: history });
        emit({ stack: chats });
        expect(tracker.errors).toEqual(['Unexpected application error', history, chats]);
    });

    test('identifies abort-like failures without classifying unrelated errors', () => {
        expect(isAbortLikeError(new Error('request failed'), { aborted: true })).toBe(true);
        expect(isAbortLikeError({ name: 'AbortError' })).toBe(true);
        expect(isAbortLikeError(new Error('request cancelled by user'))).toBe(true);
        expect(isAbortLikeError('operation aborted')).toBe(true);
        expect(isAbortLikeError(new Error('network timeout'), { aborted: false })).toBe(false);
        expect(isAbortLikeError(null)).toBe(false);
    });

    test('all abort consumers import the shared utility', () => {
        const consumers = [
            ['public/scripts/extensions/in-chat-agents/pathfinder/llm-sidecar.js', 'from \'../../../util/abort-error.js\';'],
            ['public/scripts/extensions/in-chat-agents/pathfinder/prompts/pipeline-runner.js', 'from \'../../../../util/abort-error.js\';'],
            ['public/scripts/extensions/in-chat-agents/pathfinder/sidecar-retrieval.js', 'from \'../../../util/abort-error.js\';'],
            ['public/scripts/neconyan-conversation/generation.js', 'from \'../util/abort-error.js\';'],
            ['public/scripts/neconyan-custom-css-ai.js', 'from \'./util/abort-error.js\';'],
        ];

        for (const [relativePath, importSource] of consumers) {
            const source = readRepoFile(relativePath);
            expect(source).toContain('import { isAbortLikeError }');
            expect(source).toContain(importSource);
            expect(source).not.toContain('function isAbortLikeError(');
        }

        expect(readRepoFile('public/scripts/neconyan-custom-css-ai.js')).toContain('export { isAbortLikeError };');
    });

    test('named regex consumers import the shared escape helper', () => {
        const chatLabelSource = readRepoFile('public/scripts/chat-label.js');
        const summarizeSource = readRepoFile('public/scripts/extensions/in-chat-agents/pathfinder/tools/summarize.js');
        const partnersSource = readRepoFile('public/scripts/neconyan-conversation/partners-utils.js');
        const tabsSource = readRepoFile('public/scripts/neconyan-tabs.js');
        const trackerSource = readRepoFile('public/scripts/extensions/in-chat-agents/tracker-state.js');

        expect(chatLabelSource).toContain('import { escapeRegex } from \'./util/escape-regex.js\';');
        expect(summarizeSource).toContain('import { escapeRegex } from \'../../../../util/escape-regex.js\';');
        expect(partnersSource).toContain('import { escapeRegex } from \'../util/escape-regex.js\';');
        expect(tabsSource).toContain('import { escapeRegex } from \'./util/escape-regex.js\';');
        expect(trackerSource).toContain('import { escapeRegex } from \'../../util/escape-regex.js\';');

        expect(chatLabelSource).not.toContain('function escapeRegExp(');
        expect(summarizeSource).not.toContain('function escapeRegExp(');
        expect(tabsSource).not.toContain('function escapeRegExp(');
        expect(trackerSource).not.toContain('function escapeRegex(');
        expect(partnersSource).toContain('return escapeRegex(String(value || \'\'));\n');
        expect(escapeRegex('a+b?')).toBe('a\\+b\\?');
    });
});
