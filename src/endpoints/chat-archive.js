import express from 'express';

export const router = express.Router();

router.use((_request, response) => response.status(409).json({
    code: 'NATIVE_OPERATION_REQUIRED',
    error: 'Use /api/operations/submit to read or search the saved archive. Accepted results remain available after the page closes.',
}));
