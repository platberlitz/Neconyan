import express from 'express';

export const router = express.Router();

// Legacy untracked writes and retry redirects cannot share the durable native index publisher.
router.post(['/', '/insert', '/delete', '/query', '/query-multi', '/list', '/purge', '/purge-all'], (_request, response) => {
    response.status(409).json({ code: 'NATIVE_OPERATION_REQUIRED',
        error: 'Use the saved vector workflow in /api/operations/submit. Existing indexes have been kept.' });
});
