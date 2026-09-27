import express from 'express';

/** Maintenance now requires a permanent report and a separately accepted reviewed deletion. */
export const router = express.Router();
router.use((_request, response) => response.status(409).json({ code: 'NATIVE_OPERATION_REQUIRED',
    error: 'Submit a saved maintenance report or reviewed deletion through /api/operations/submit.' }));
