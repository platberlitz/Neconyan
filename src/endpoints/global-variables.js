import express from 'express';

import { findUnusedGlobalVariables } from '../global-variable-usage.js';

export const router = express.Router();

const MAX_NAMES = 5000;

router.post('/unused', async (request, response) => {
    const names = request.body?.names;
    if (!Array.isArray(names) || names.length > MAX_NAMES) {
        return response.status(400).send({ error: 'Send the global variable names to check as a list.' });
    }

    try {
        const result = await findUnusedGlobalVariables({ directories: request.user.directories, names });
        return response.send(result);
    } catch (error) {
        console.error('Could not check global variable usage:', error);
        return response.status(500).send({ error: 'Could not check global variable usage.' });
    }
});
