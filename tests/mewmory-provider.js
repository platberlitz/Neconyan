import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/** A deterministic local provider for exercising the real HTTP and browser paths without story/model credentials. */
export async function createMewmoryProvider(port = 0) {
    const calls = [];
    const mode = { fail: false, invalidSelector: false, hold: '' };
    const held = new Set();
    const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'GET') {
            if (request.url === '/fixture/calls') return response.end(JSON.stringify(calls));
            return response.end(JSON.stringify({ object: 'list', model_name: 'mewmory-writer', result: 'mewmory-writer', data: [{ id: 'mewmory-writer', object: 'model' }] }));
        }
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        if (request.url === '/fixture/hold') {
            mode.hold = body.model;
            return response.end('{}');
        }
        if (request.url === '/fixture/release') {
            mode.hold = '';
            for (const release of held) release();
            held.clear();
            return response.end('{}');
        }
        const name = typeof body.prompt === 'string' ? 'text-writer' : body.model;
        const call = { model: name, messages: body.messages, prompt: body.prompt, tools: body.tools, headers: request.headers, url: request.url, startedAt: Date.now(), completedAt: null };
        calls.push(call);
        if ([].concat(mode.hold).includes(name)) await new Promise(resolve => held.add(resolve));
        call.completedAt = Date.now();
        if (mode.redirect) {
            response.writeHead(mode.redirectStatus || 307, { Location: mode.redirect });
            return response.end('{}');
        }
        if (mode.reply) return response.end(JSON.stringify(typeof mode.reply === 'function' ? mode.reply(body) : mode.reply));
        if (mode.fail) {
            response.statusCode = 503;
            return response.end(JSON.stringify({ error: 'Fixture provider unavailable.' }));
        }
        if (request.url.endsWith('/embeddings')) {
            const values = Array.isArray(body.input) ? body.input : [body.input];
            return response.end(JSON.stringify({
                data: values.map((value, index) => ({ index, embedding: [Number(/gift|kept/i.test(value)), Number(/Mara/.test(value)), 1] })),
                usage: { prompt_tokens: values.length * 10 },
            }));
        }
        let output;
        const input = ['mewmory-writer', 'text-writer'].includes(name) ? null : JSON.parse(body.messages.at(-1).content);
        if (name === 'extractor') {
            const scene = input.sources.filter(source => source.type === 'chat');
            const introduction = scene.find(source => source.text.includes('Mara has silver eyes'));
            const gift = scene.find(source => source.text.includes('Mara accepts the gift.'));
            const receipt = scene.find(source => source.text.includes('Mara reads the date on the receipt.'));
            const ownerId = input.sources.find(source => source.type === 'character')?.entityId
                || input.existing.find(record => record.kind === 'entity' && record.name === 'Mara')?.entityId || 'npc:mara';
            const refs = source => [{ id: source.id, revision: source.revision }];
            const records = [];
            const interviews = [];
            if (introduction) records.push({
                id: 'entity:' + ownerId, kind: 'entity', entityId: ownerId, name: 'Mara', text: 'Mara, an ink-stained archivist.',
                isCharacter: true, appearance: 'Silver eyes and ink-stained fingers.', speech: 'Clipped, formal sentences.',
                subjectIds: [ownerId], refs: refs(introduction),
            });
            if (gift) {
                records.push({
                    id: 'event:gift', kind: 'event', text: 'Mara accepted the gift and placed it in her bag.',
                    evidenceStatus: 'established', subjectIds: ['gift'], refs: refs(gift),
                }, {
                    id: 'event:pity-claim', kind: 'event', text: 'Mara said she did not need pity.',
                    evidenceStatus: 'reported', subjectIds: ['gift'], refs: refs(gift),
                }, {
                    id: 'knowledge:gift', kind: 'knowledge', ownerId, subjectIds: ['gift'], method: 'witnessed',
                    text: 'Mara accepted the gift and objected that she did not need pity.',
                    evidenceText: 'Mara accepts the gift.', refs: refs(gift),
                });
                interviews.push({ ownerId, subjectIds: ['gift'], knowledgeIds: ['knowledge:gift'], refs: refs(gift),
                    significance: 'medium', evidenceRefs: refs(gift), reason: 'She kept the gift while objecting.' });
            }
            if (receipt) {
                records.push({
                    id: 'knowledge:receipt', kind: 'knowledge', ownerId, subjectIds: ['gift'], method: 'read',
                    text: 'Mara learned the gift’s purchase date was before the accident.',
                    evidenceText: 'Mara reads the date on the receipt.', refs: refs(receipt),
                });
                interviews.push({ ownerId, subjectIds: ['gift'], knowledgeIds: ['knowledge:receipt'], refs: refs(receipt),
                    significance: 'medium', evidenceRefs: refs(receipt), reason: 'The receipt corrects her earlier assumption.' });
            }
            output = { records, interviews, activeNpcIds: introduction || input.existing.some(record => record.entityId === ownerId) ? [ownerId] : [] };
        } else if (name === 'pawspective') {
            const revised = input.knownFacts.some(fact => fact.text.includes('purchase date'));
            const answer = revised ? '"Perhaps I judged you too quickly." She suppresses a smile.' : '"I do not need pity." She grips the imaginary armchair.';
            output = input.priorInterviews.some(interview => interview.interview.some(turn => turn.answer === answer))
                ? { changed: false } : {
                    changed: true,
                    interview: [{ question: revised ? 'What do you think of the gift now?' : 'Why did you keep it?', answer }],
                    searchDescription: 'SEARCH ONLY: ' + (revised ? 'gift reinterpreted after learning purchase date' : 'gift kept despite objection to pity'),
                    changeExplanation: revised ? 'She learned from the receipt that it was chosen before the accident.' : '',
                    overviews: [{ subjectId: 'gift', status: revised ? 'resolved' : 'active', text: revised
                        ? 'Her objection has softened after learning the purchase date. This does not establish complete trust.'
                        : 'She suspects pity but kept the gift.' }],
                };
        } else if (['selector', 'fallback'].includes(name)) {
            const candidate = input.candidates.find(candidate => candidate.kind === 'interview' && candidate.searchDescription.includes('pity'))
                || input.candidates.find(candidate => candidate.recordId === 'event:gift');
            output = mode.invalidSelector && name === 'selector' ? { replaceMemory: 'Invalid replacement' }
                : {
                    status: 'complete', selections: candidate && input.scene.length ? [{
                        recordId: candidate.recordId, relevanceType: 'direct', currentCueRefs: [input.scene.at(-1).id],
                        memoryEvidenceRefs: [candidate.sourceRefs[0]],
                        justification: 'INSPECT ONLY: the same retained gift is discussed; its present interpretation must accompany the earlier objection.',
                    }] : [], rejections: [], needsEvidence: [],
                };
        } else {
            output = 'Mara touches the bag. "Of course I kept it. Do not make a fuss."';
        }
        if (body.stream && name === 'mewmory-writer') {
            response.setHeader('Content-Type', 'text/event-stream');
            call.firstTokenAt = Date.now();
            response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }] }) + '\n\n');
            return response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        }
        response.end(JSON.stringify({
            choices: [{ text: typeof output === 'string' ? output : JSON.stringify(output),
                message: { role: 'assistant', content: typeof output === 'string' ? output : JSON.stringify(output) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 40 },
        }));
    });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    return { server, calls, mode, url: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const provider = await createMewmoryProvider(Number(process.env.MEWMORY_FIXTURE_PORT) || 4491);
    console.log('Mewmory fixture provider: ' + provider.url);
}
