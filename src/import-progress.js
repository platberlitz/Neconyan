/** Stream measured import progress only to clients which request it. */
export function importProgress(request, response) {
    const streaming = request.get('accept')?.includes('application/x-ndjson');
    const send = value => {
        if (!response.headersSent) {
            response.type('application/x-ndjson');
            response.set({ 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        }
        if (!response.destroyed) response.write(JSON.stringify(value) + '\n');
    };
    return {
        report(completed, total, phase) {
            if (streaming) send({ type: 'progress', completed, total, phase, percent: total ? Math.min(99, Math.floor(completed * 100 / total)) : null });
        },
        finish(result) {
            if (!streaming) return response.json(result);
            send({ type: 'result', percent: 100, result });
            response.end();
        },
        fail(message) {
            if (!streaming || !response.headersSent) return response.status(400).json({ error: message });
            send({ type: 'error', error: message });
            response.end();
        },
    };
}
