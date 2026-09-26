import express from 'express';
import { acceptMeowerJob } from '../generation/meower-jobs.js';

export const router = express.Router();
for (const kind of ['refresh', 'profile']) {
    router.post(`/${kind}/submit`, async (request, response) => {
        try {
            const accepted = await acceptMeowerJob(request, request.body, kind);
            response.set('X-Neconyan-Job', accepted.job.id);
            response.set('Cache-Control', 'no-store');
            return response.status(accepted.created ? 202 : 200).json(accepted);
        } catch (error) {
            return response.status(error.status ?? 500).json({ error: error.message, code: error.code ?? null });
        }
    });
}
