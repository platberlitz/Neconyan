import { afterAll, expect, jest, test } from '@jest/globals';

global.document = { hasFocus: () => true };
afterAll(() => { delete global.document; });

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: { smooth_streaming_speed: 100 } }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ delay: async () => {} }));

const { default: EventSourceStream, SmoothEventSourceStream } = await import('../public/scripts/sse-stream.js');

async function readEvents(chunks, Stream = EventSourceStream) {
    const encoder = new TextEncoder();
    const input = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
    const events = [];
    for await (const event of input.pipeThrough(new Stream())) events.push(event);
    return events;
}

test('SSE keeps Unicode separators and ignores comments across split CRLF lines', async () => {
    const content = JSON.stringify({ text: 'one\u2028two\u2029three' });
    const events = await readEvents([`id: 14\r\ndata: ${content}\r`, '\n:data: not a reply\r', '\n\r', '\ndata: [DONE]']);
    expect(events.map(event => [event.data, event.lastEventId])).toEqual([[content, '14'], ['[DONE]', '14']]);
});

test('smooth streaming forwards tool, probability and completion data only once', async () => {
    const toolCalls = [{ index: 0, function: { name: 'roll', arguments: '{"sides":6}' } }];
    const logprobs = { content: [{ token: 'Okay', logprob: -0.1 }] };
    const usage = { completion_tokens: 1 };
    const input = { choices: [{ index: 0, delta: { content: 'Okay', tool_calls: toolCalls }, logprobs, finish_reason: 'tool_calls' }], usage };
    const events = (await readEvents([`data: ${JSON.stringify(input)}\n\n`], SmoothEventSourceStream)).map(event => JSON.parse(event.data));
    expect(events.map(event => event.choices[0].delta.content)).toEqual(['O', 'k', 'a', 'y']);
    expect(events.flatMap(event => event.choices[0].delta.tool_calls ?? [])).toEqual(toolCalls);
    expect(events.map(event => event.choices[0].logprobs).filter(Boolean)).toEqual([logprobs]);
    expect(events.map(event => event.choices[0].finish_reason).filter(Boolean)).toEqual(['tool_calls']);
    expect(events.map(event => event.usage).filter(Boolean)).toEqual([usage]);
});
