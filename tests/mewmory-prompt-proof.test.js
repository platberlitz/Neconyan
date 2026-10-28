import { buildMewmoryMacros } from '../public/scripts/extensions/in-chat-agents/agent-context-macros.js';
import { createMewmoryBudgetMessage, finaliseMewmoryContext, wrapMewmoryContext } from '../public/scripts/mewmory/prompt-proof.js';

const marker = { open: '[memory test begin]', close: '[memory test end]' };
const primary = wrapMewmoryContext('primary', marker);
const fallback = wrapMewmoryContext('fallback', marker);
const context = { memoryText: primary, npcText: '', suppression: {
    marker, fallbackMemoryText: fallback, proof: [{ passageText: 'the original passage' }], proposedPassagesSkipped: 1,
} };

test('keeps the filtered memory when the original remains in the delivered chat', () => {
    const prompt = [{ role: 'system', content: primary }, { role: 'user', content: 'the original passage' }];
    expect(finaliseMewmoryContext(prompt, context)).toEqual({ prompt: [{ ...prompt[0], content: 'primary' }, prompt[1]], memoryText: 'primary', choice: 'primary', skipped: 1 });
});

test('uses the prepared fallback without reformatting the rest of the prompt', () => {
    const prompt = [{ role: 'system', content: primary }, { role: 'user', content: 'transformed passage' }];
    const result = finaliseMewmoryContext(prompt, context);
    expect(result.choice).toBe('fallback');
    expect(result.skipped).toBe(0);
    expect(result.prompt).toEqual([{ role: 'system', content: 'fallback' }, prompt[1]]);
    expect(prompt[0].content).toBe(primary);
});

test('does not treat memory or character reference text as proof', () => {
    const result = finaliseMewmoryContext(primary + '\n' + 'the original passage', { ...context, npcText: 'the original passage' });
    expect(result.choice).toBe('fallback');
});

test('rejects an absent or duplicated memory slot', () => {
    expect(() => finaliseMewmoryContext('the original passage', context)).toThrow(/Mewmory block/);
    expect(() => finaliseMewmoryContext(primary + primary, context)).toThrow(/Mewmory block/);
});


test('keeps private markers for an intermediate Agent pass and removes them after the final proof', () => {
    const working = finaliseMewmoryContext(primary + '\nthe original passage', context, { phase: 'working' });
    expect(working.prompt).toContain(primary);
    const terminal = finaliseMewmoryContext(working.prompt, context);
    expect(terminal.prompt).toBe('primary\nthe original passage');
});

test('cleans a multimodal primary slot without modifying other parts', () => {
    const image = { type: 'image_url', image_url: { url: 'example' } };
    const prompt = [{ role: 'user', content: [{ type: 'text', text: primary }, image, { type: 'text', text: 'the original passage [Sources: keep this]' }] }];
    const result = finaliseMewmoryContext(prompt, context);
    expect(result.prompt[0].content).toEqual([{ type: 'text', text: 'primary' }, image, prompt[0].content[2]]);
    expect(result.memoryText).toBe('primary');
});

test('an active memory macro forces conservative fallback even when it repeats proof text', () => {
    const result = finaliseMewmoryContext(primary + '\nthe original passage', { ...context, mewmoryMacrosUsed: true });
    expect(result.choice).toBe('fallback');
    expect(result.prompt).toBe('fallback\nthe original passage');
});


test('Agent macro presentation removes only the active private slot markers', () => {
    const macros = buildMewmoryMacros({ ...context, enabled: true, npcText: 'Mara', factsText: 'Fact [Sources: keep this]', interviewText: 'View' });
    expect(macros['full-mewmory']).toBe('Mara\n\nprimary');
    expect(macros['mewmory-facts']).toBe('Fact [Sources: keep this]');
    expect(macros['mewmory-interview']).toBe('View');
    expect(context.memoryText).toBe(primary);
});


test.each(['\r\n', ''])('strips exact markers even when boundary whitespace is %j', separator => {
    const working = marker.open + separator + 'primary' + separator + marker.close;
    const result = finaliseMewmoryContext(working + '\nthe original passage', { ...context, memoryText: working });
    expect(result.prompt).toBe('primary\nthe original passage');
    expect(result.memoryText).toBe('primary');
});


test('terminal cleanup preserves unrelated marker-like and bracketed story text byte for byte', () => {
    const fiction = '[Mewmory context another-request begin] [Sources: keep this] event:harbour';
    const prompt = [{ role: 'system', content: primary }, { role: 'user', content: fiction }];
    const result = finaliseMewmoryContext(prompt, context);
    expect(result.choice).toBe('fallback');
    expect(result.prompt[0].content).toBe('fallback');
    expect(result.prompt[1].content).toBe(fiction);
});


test('the working Message reserves clean-token budget before retained history is checked', async () => {
    const budget = 'primary'.length;
    const create = async (role, content, identifier, countContent) => ({ role, content, identifier, tokens: countContent.length });
    const message = await createMewmoryBudgetMessage(create, primary, 'mewmory-context', marker);
    expect(primary.length).toBeGreaterThan(budget);
    expect(message.tokens).toBe(budget);
    expect(message.content).toBe(primary);
});
