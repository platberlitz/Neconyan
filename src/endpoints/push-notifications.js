import express from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { notificationCapabilities, setNotificationDevice, sendSystemNotification } from '../push-notifications.js';

export const router = express.Router();
const limiter = new RateLimiterMemory({ points: 60, duration: 60 });
router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!request.user?.profile?.handle) return response.sendStatus(401);
    if (request.get('X-Neconyan-Account') !== request.user.profile.handle) return response.sendStatus(409);
    next();
});
router.post('/capabilities', (request, response) => {
    try { response.json(notificationCapabilities(request.user.directories)); } catch { response.status(503).json({ error: 'Notification storage is unavailable.' }); }
});
router.post('/device', (request, response) => {
    try { setNotificationDevice(request.user.directories, request.body || {}); response.sendStatus(204); } catch { response.status(400).json({ error: 'The notification device could not be saved.' }); }
});
router.post('/toast', async (request, response) => {
    const { device, title, body } = request.body || {};
    if (typeof device !== 'string' || !/^[a-f0-9-]{36}$/i.test(device) || typeof body !== 'string' || body.length > 2000 || (title && typeof title !== 'string')) return response.sendStatus(400);
    try { await limiter.consume(request.user.profile.handle); } catch { return response.sendStatus(429); }
    void sendSystemNotification(request.user.directories, request.user.profile.handle, { title, body }, device);
    return response.sendStatus(204);
});
