// A deterministic model provider for the simulator. Never included in the app payload.
import http from 'node:http';
import { setTimeout } from 'node:timers/promises';

http.createServer(async (request, response) => {
    try {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
            response.writeHead(404).end();
            return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.messages?.at(-1)?.content !== 'Test the standalone reply.') {
            response.writeHead(400).end('Unexpected test prompt');
            return;
        }
        if (body.stream) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const content of ['Standalone ', 'reply received.']) {
                response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
                await setTimeout(50);
            }
            response.end('data: [DONE]\n\n');
        } else {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Standalone reply received.' }, finish_reason: 'stop' }] }));
        }
    } catch (error) {
        console.error(error);
        response.writeHead(500).end();
    }
}).listen(28194, '127.0.0.1', () => console.log('Simulator model fixture ready'));
