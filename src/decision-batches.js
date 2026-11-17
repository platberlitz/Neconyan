import { NANOGPT_DECISION_PRESETS } from '../public/scripts/mewmory/jev-presets.js';

/** Keep Nano-GPT's per-request question/body limits without changing question IDs. */
export async function requestDecisionBatches(url, body, send) {
    const hostname = new URL(url).hostname.toLowerCase();
    const preset = ['nano-gpt.com', 'api.nano-gpt.com'].includes(hostname)
        ? NANOGPT_DECISION_PRESETS.find(item => item.model === body.model) : null;
    if (!preset) return send(body);
    const maxBytes = body.model.startsWith('eu-jev/') ? 262144 : 1048576;
    const batches = [];
    let questions = {};
    for (const [id, question] of Object.entries(body.questions)) {
        const next = { ...questions, [id]: question };
        if (Object.keys(next).length > preset.maxQuestions || Buffer.byteLength(JSON.stringify({ ...body, questions: next })) > maxBytes) {
            if (Object.keys(questions).length) batches.push({ ...body, questions });
            questions = {};
        }
        questions[id] = question;
        if (Buffer.byteLength(JSON.stringify({ ...body, questions })) > maxBytes) {
            throw Object.assign(new Error('Nano-GPT decision input is too large. Reduce the scene or candidate text.'), { status: 400 });
        }
    }
    batches.push({ ...body, questions });
    if (batches.length === 1) return send(batches[0]);
    const answers = {};
    const usage = { input_tokens: 0, output_tokens: 0 };
    for (const batch of batches) {
        const data = await send(batch);
        // Copy only requested IDs. Missing scores and refusals stay invalid for
        // normal caller validation and are never cached as negative decisions.
        for (const id of Object.keys(batch.questions)) answers[id] = data?.answers?.[id];
        usage.input_tokens += Number(data?.usage?.input_tokens ?? data?.usage?.prompt_tokens) || 0;
        usage.output_tokens += Number(data?.usage?.output_tokens ?? data?.usage?.completion_tokens) || 0;
    }
    return { answers, usage };
}
