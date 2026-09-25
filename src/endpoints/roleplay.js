import express from 'express';
import { validateOwner } from '../jobs/store.js';
import { noteOwner } from '../jobs/runner.js';
import { acceptRoleplayNamedWorkflow, readRoleplayWorkflowReceipt } from '../generation/roleplay-acceptance.js';

export const router = express.Router();

/**
 * The native acceptance surface for named Roleplay workflows. The generic job
 * endpoint refuses `media.*` and `roleplay.*` types precisely because these
 * routes are the only way to start them: a workflow captures its own source,
 * connection and capacity, and a plain intent could not.
 */
function scope(request) {
    const owner = validateOwner(request.user?.profile?.handle);
    const expected = request.get('X-Neconyan-Account');
    if (expected !== undefined && expected !== owner) {
        throw Object.assign(new Error('account_changed'), { status: 409 });
    }
    noteOwner(owner);
    return { owner, directories: request.user.directories };
}

function fail(response, error) {
    return response.status(error.status ?? 500).json({ error: error.message, code: error.code ?? error.apiError ?? null });
}

router.post('/workflow/submit', async (request, response) => {
    try {
        scope(request);
        const accepted = await acceptRoleplayNamedWorkflow(request, request.body || {});
        response.set('X-Neconyan-Job', accepted.jobId ?? '');
        return response.status(accepted.created ? 202 : 200).json(accepted);
    } catch (error) {
        return fail(response, error);
    }
});

/** The owner's readback: a reopened page recovers a result instead of resubmitting it. */
router.get('/workflow/receipt', (request, response) => {
    try {
        scope(request);
        return response.json(readRoleplayWorkflowReceipt(request, request.query?.key));
    } catch (error) {
        return fail(response, error);
    }
});
