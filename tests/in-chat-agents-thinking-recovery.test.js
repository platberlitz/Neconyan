import { describe, expect, test } from '@jest/globals';

const {
    buildThinkingRecoveryMessages,
    cleanThinkingRecoveryOutput,
    isThinkingRecoveryAgent,
    isThinkingRecoveryEligible,
    THINKING_RECOVERY_TEMPLATE_ID,
} = await import('../public/scripts/extensions/in-chat-agents/thinking-recovery.js');

const completedThinking = { text: '', reasoning: 'Nova opens the door and says hello.' };

describe('thinking reply recovery trigger', () => {
    test('a completed reply with only thinking is eligible', () => {
        expect(isThinkingRecoveryEligible(completedThinking)).toBe(true);
    });

    test('a written reply, missing thinking or whitespace-only text is never a recovery case', () => {
        expect(isThinkingRecoveryEligible({ text: 'Hello', reasoning: 'Plan' })).toBe(false);
        expect(isThinkingRecoveryEligible({ text: '', reasoning: '' })).toBe(false);
        expect(isThinkingRecoveryEligible({ text: '  \n', reasoning: 'Plan' })).toBe(true);
        expect(isThinkingRecoveryEligible({ text: undefined, reasoning: 'Plan' })).toBe(false);
    });

    test.each([
        ['a stopped generation', { stopped: true }],
        ['a tool-only turn', { toolTurn: true }],
        ['unclosed inline thinking', { unclosed: true }],
        ['a provider or content-filter error', { outcome: { status: 'error', reason: 'provider' } }],
        ['thinking cut off by the token limit', { finishReason: 'length' }],
        ['thinking cut off by the token limit (Gemini)', { finishReason: 'MAX_TOKENS' }],
    ])('%s is excluded', (_label, extra) => {
        expect(isThinkingRecoveryEligible({ ...completedThinking, ...extra })).toBe(false);
    });

    test('only the recovery template is recognised, by id or saved template id', () => {
        expect(THINKING_RECOVERY_TEMPLATE_ID).toBe('tpl-thinking-reply-recovery');
        expect(isThinkingRecoveryAgent({ id: 'tpl-thinking-reply-recovery' })).toBe(true);
        expect(isThinkingRecoveryAgent({ id: 'copy-1', sourceTemplateId: 'tpl-thinking-reply-recovery' })).toBe(true);
        expect(isThinkingRecoveryAgent({ id: 'tpl-continuity-corrector' })).toBe(false);
    });
});

describe('thinking reply recovery output', () => {
    const reasoning = 'Nova opens the door.';

    test('keeps the prose and removes closed leading thinking and an assistant_response wrapper', () => {
        expect(cleanThinkingRecoveryOutput('<thinking>plan</thinking>\n<assistant_response>Nova opens the door.</assistant_response>', { reasoning }))
            .toBe('Nova opens the door.');
    });

    test.each([
        ['an unclosed thinking block', '<thinking>Still planning', 'done'],
        ['a stray closing tag', 'Nova opens the door.</thinking>', 'done'],
        ['an unclosed wrapper', '<assistant_response>Nova opens the door.', 'done'],
        ['empty output', '   ', 'done'],
        ['a truncated provider stop', 'Nova opens', 'length-limited'],
    ])('rejects %s', (_label, output, status) => {
        expect(cleanThinkingRecoveryOutput(output, { status, reasoning })).toBe('');
    });

    test('the refusal check follows the user refusal guard setting', () => {
        const refusal = 'I cannot fulfill this request. The prompt contains instructions I will not follow.';
        expect(cleanThinkingRecoveryOutput(refusal, { reasoning })).toBe('');
        expect(cleanThinkingRecoveryOutput(refusal, { reasoning, refusalGuard: false })).toBe(refusal);
    });

    test('a continuation keeps all leading whitespace, including paragraph breaks, and still rejects a blank reply', () => {
        expect(cleanThinkingRecoveryOutput('\n\nShe closes the door.', { reasoning, continuation: true })).toBe('\n\nShe closes the door.');
        expect(cleanThinkingRecoveryOutput(' \n ', { reasoning, continuation: true })).toBe('');
    });

    test('a continuation keeps its leading space, which the saved prefix needs', () => {
        expect(cleanThinkingRecoveryOutput(' and the door closed.', { reasoning, continuation: true })).toBe(' and the door closed.');
        expect(cleanThinkingRecoveryOutput(' and the door closed.', { reasoning })).toBe('and the door closed.');
    });

    test('a failed or stopped attempt never yields text, even when the body looks complete', () => {
        expect(cleanThinkingRecoveryOutput('Nova opens the door.', { status: 'error', reasoning })).toBe('');
        expect(cleanThinkingRecoveryOutput('Nova opens the door.', { status: 'stopped', reasoning })).toBe('');
    });
});

describe('thinking reply recovery prompt', () => {
    test('the completed thinking and recent chat travel in the user turn, the agent prompt in the system turn', () => {
        const [system, user] = buildThinkingRecoveryMessages('AGENT PROMPT', {
            reasoning: 'Nova opens the door.', assistantName: 'Nova', generationType: 'normal', recentChat: 'User: Knock.',
        });
        expect(system).toEqual({ role: 'system', content: expect.stringContaining('AGENT PROMPT') });
        expect(user.content).toContain('<thinking>\nNova opens the door.\n</thinking>');
        expect(user.content).toContain('<recent_chat>\nUser: Knock.\n</recent_chat>');
        expect(user.content).toContain('Assistant name: Nova');
    });
});
