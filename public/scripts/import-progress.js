/** Consume an import stream without treating an interrupted transfer as success. */
export async function readImportProgress(response, onProgress) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result;
    let finished = false;
    try {
        while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            if (done && buffer.trim()) lines.push(buffer);
            for (const line of lines) {
                if (!line.trim()) continue;
                const event = JSON.parse(line);
                if (event.type === 'error') throw new Error(event.error);
                if (event.type === 'progress') onProgress(event);
                if (event.type === 'result') {
                    result = event.result;
                    finished = true;
                    onProgress({ percent: 100, phase: 'Import complete' });
                }
            }
            if (done) break;
        }
        if (!finished) throw new Error('The import connection ended before completion. Check the imported data before retrying.');
        return result;
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
