/** Consume an auxiliary stream while its request's cancellation hooks are still installed. */
export async function collectGenerationStream(stream, { signal, onChunk = () => {} } = {}) {
    let last = { text: '', state: {} };
    let lengthLimited = false;
    for await (const chunk of stream()) {
        signal?.throwIfAborted();
        last = chunk;
        lengthLimited ||= chunk.state?.finishReason === 'length';
        onChunk(chunk);
        if (chunk.state?.outcome) throw new Error('The provider did not complete the reply. Nothing was applied.');
    }
    signal?.throwIfAborted();
    return { choices: [{ message: { content: last.text, reasoning_content: last.state?.reasoning || '' }, finish_reason: lengthLimited ? 'length' : 'stop' }] };
}
