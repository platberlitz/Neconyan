import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';

const readPublic = file => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

function sliceFunction(source, signature) {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf('\nfunction ', start + signature.length);
    return source.slice(start, next === -1 ? undefined : next);
}

describe('transient toasts dismiss themselves', () => {
    test('post-generation agent running toasts close after 2 seconds while intercept toasts stay', () => {
        const source = readPublic('scripts/extensions/in-chat-agents/agent-runner.js');
        expect(source).toMatch(/const POST_GEN_RUNNING_TOAST_TIMEOUT_MS = 2000;/);

        const body = sliceFunction(source, 'function showPromptTransformRunningToast');
        expect(body).toMatch(/const dismissDelay = kind === 'postGen' \? POST_GEN_RUNNING_TOAST_TIMEOUT_MS : 0;/);
        expect(body).toMatch(/timeOut: dismissDelay,/);
        expect(body).toMatch(/extendedTimeOut: dismissDelay,/);
        expect(body).toMatch(/onHidden\(\) \{[\s\S]*?activePromptTransformToasts\.delete\(toast\)/);
    });

});
