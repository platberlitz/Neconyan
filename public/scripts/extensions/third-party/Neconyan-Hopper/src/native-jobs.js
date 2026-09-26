// The page submits and observes. Only the server performs generation and commits activity.
export function createMeowerJobClient({ request, listJobs, observeJob, cancelJob, account, uuid, pendingStorage, prepareInput = input => input }) {
    return async function run(kind, input, { signal, onSnapshot = async () => {} } = {}) {
        signal?.throwIfAborted();
        const operation = kind === 'profile' ? `:${input.mode}:${input.accountKey || ''}` : '';
        const storageKey = `meower-job:${account}:${kind}:${input.sessionId}${operation}`;
        const retained = pendingStorage.getItem(storageKey);
        let pending;
        if (retained) {
            try { pending = JSON.parse(retained); } catch { throw new Error('The pending Meower operation needs recovery.'); }
            if (!pending || typeof pending !== 'object' || (!pending.jobId && typeof pending.submissionKey !== 'string')) throw new Error('The pending Meower operation needs recovery.');
        }
        const jobs = await listJobs({ account });
        signal?.throwIfAborted();
        const matches = job => job.type === `meower.${kind}` && job.target?.id === input.sessionId
            && (kind !== 'profile' || job.intent?.plan?.input?.mode === input.mode && (input.mode !== 'character' || job.intent.plan.input.accountKey === input.accountKey));
        let job = pending?.jobId ? jobs.find(job => job.id === pending.jobId && matches(job))
            : !pending && jobs.find(job => matches(job) && ['queued', 'running', 'waiting'].includes(job.state));
        if (pending?.jobId && !job) throw new Error('The accepted Meower job is no longer available. It will not be repeated.');
        if (!job) {
            const body = pending || { ...await prepareInput(input), submissionKey: uuid() };
            // Keep an unacknowledged submission across reloads. Reposting its key is idempotent.
            pendingStorage.setItem(storageKey, JSON.stringify(body));
            try {
                const accepted = await request(`/api/meower/${kind}/submit`, { method: 'POST', body: JSON.stringify(body) });
                job = accepted.job;
            } catch (error) {
                if (error.status >= 400 && error.status < 500 && error.status !== 408) pendingStorage.removeItem(storageKey);
                throw error;
            }
        }
        pendingStorage.setItem(storageKey, JSON.stringify({ jobId: job.id }));
        let cancellation;
        const cancel = () => {
            if (signal?.reason === 'user-stop') {
                cancellation ??= cancelJob(job.id, { account }).then(() => pendingStorage.removeItem(storageKey), cause => {
                    throw Object.assign(new Error('Stop could not be saved. The server may still be working; reopen Meower to try Stop again.', { cause }), { code: 'MEOWER_STOP_FAILED' });
                });
                // The observation promise reports this failure, including acceptance after Stop.
                void cancellation.catch(() => {});
            }
        };
        if (signal?.aborted) { cancel(); await cancellation; signal.throwIfAborted(); }
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            return await new Promise((resolve, reject) => {
                observeJob(job.id, { account, signal, intervalMs: 750, onSnapshot,
                    onDone: async finished => {
                        if (finished.state !== 'completed') { reject(new Error(finished.error?.message || `Meower work ${finished.state}. Review it in Jobs before retrying.`)); return; }
                        try {
                            const result = await request(`/api/jobs/${encodeURIComponent(job.id)}/result`);
                            pendingStorage.removeItem(storageKey);
                            resolve(result);
                        } catch (error) { reject(error); }
                    },
                    onStop: async reason => {
                        if (reason === 'done') return;
                        try { await cancellation; } catch (error) { reject(error); return; }
                        reject(reason === 'aborted' ? signal.reason : new Error(`Meower observation stopped: ${reason}.`));
                    },
                });
            });
        } finally { signal?.removeEventListener('abort', cancel); }
    };
}
