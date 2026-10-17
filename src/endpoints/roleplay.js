import { verifyPromptImageCopy } from '../managed-image-files.js';
import { uiText } from '../../public/scripts/ui-text.js';
import { withRoleplayAccount, roleplayLease } from '../roleplay-store.js';
import { captureSavedRoleplayImages } from '../generation/world-info.js';
import { scanRoleplayImages, applyRoleplayImageRepair, resumeRoleplayImageRepair, discardRoleplayImageRepair, roleplayImageRepairHistory, exportRoleplayImageBackup, removeRoleplayImageBackup, listRoleplayImageChats, readRoleplayImageReviewSource } from '../roleplay-image-recovery.js';
import { roleplayNativeHost } from './chats.js';
import express from 'express';
import { validateOwner } from '../jobs/store.js';
import { noteOwner } from '../jobs/runner.js';
import { acceptRoleplayGroupTurn, acceptRoleplayNamedWorkflow, readRoleplayWorkflowReceipt } from '../generation/roleplay-acceptance.js';
import { inspectTransferredRoleplay, repairTransferredRoleplay } from '../roleplay-transfer-recovery.js';

export const router = express.Router();

// These remain reachable when protected chats or groups cannot be loaded.
router.post('/recovery/check', (request, response) => {
    try { return response.json(inspectTransferredRoleplay(scope(request))); } catch (error) { return fail(response, error); }
});

router.post('/recovery/repair', (request, response) => {
    try { return response.json(repairTransferredRoleplay(scope(request), request.body?.token)); } catch (error) { return fail(response, error); }
});

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
    return response.status(error.status ?? 500).json({ error: error.message, code: error.code ?? error.apiError ?? null, ...(error.imageIssue ? { imageIssue: { reason: error.imageIssue.reason, index: error.imageIssue.index, mediaIndex: error.imageIssue.mediaIndex, actions: error.imageIssue.actions } } : {}) });
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

router.post('/group/submit', async (request, response) => {
    try {
        scope(request);
        const accepted = await acceptRoleplayGroupTurn(request, request.body || {});
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

router.post('/images/scan', (request, response) => {
    try { return response.json(scanRoleplayImages(scope(request), request.body)); } catch (error) { return fail(response, error); }
});
router.post(['/images/apply', '/images/materialise'], (request, response) => {
    try {
        if (request.path === '/images/apply' && request.body.materialisedImage) throw Object.assign(new Error('Use the image materialisation endpoint.'), { status: 400 });
        return response.json(applyRoleplayImageRepair(scope(request), request.body, roleplayNativeHost));
    } catch (error) { return fail(response, error); }
});
router.post('/images/resume', (request, response) => {
    try { return response.json(resumeRoleplayImageRepair(scope(request), request.body, roleplayNativeHost)); } catch (error) { return fail(response, error); }
});
router.post('/images/discard', (request, response) => {
    try { return response.json(discardRoleplayImageRepair(scope(request), request.body)); } catch (error) { return fail(response, error); }
});
router.post('/images/history', (request, response) => {
    try { return response.json(roleplayImageRepairHistory(scope(request), request.body)); } catch (error) { return fail(response, error); }
});

router.post('/images/backup/export', (request, response) => {
    try { return response.type('application/octet-stream').attachment('chat-before-image-repair.jsonl').send(exportRoleplayImageBackup(scope(request), request.body)); } catch (error) { return fail(response, error); }
});
router.post('/images/backup/remove', (request, response) => {
    try { return response.json(removeRoleplayImageBackup(scope(request), request.body)); } catch (error) { return fail(response, error); }
});

router.post('/images/chats', (request, response) => {
    try { return response.json(listRoleplayImageChats(scope(request), request.body)); } catch (error) { return fail(response, error); }
});
router.post('/images/source', (request, response) => {
    try { return response.json(readRoleplayImageReviewSource(scope(request), request.body)); } catch (error) { return fail(response, error); }
});

router.post('/images/check', (request, response) => {
    try {
        let url = request.body.url;
        if (typeof url !== 'string' || url.length > 4096) throw Object.assign(new Error(uiText('This image needs a compatible copy before it can be sent.')), { status: 409 });
        if (/^https?:/.test(url)) {
            const parsed = new URL(url), origin = `${request.protocol}://${request.get('host')}`;
            if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash) throw Object.assign(new Error(uiText('This image is on another website. Save a compatible copy of it before sending it.')), { status: 409 });
            url = parsed.pathname;
        }
        const result = withRoleplayAccount(scope(request), request.body.account, lease => {
            const { scope: current } = roleplayLease(lease);
            const [image] = captureSavedRoleplayImages(current.directories, [{}, { extra: { media: [{ type: 'image', url }] } }], 'list');
            return { url, width: image.width, height: image.height, rawHash: image.rawHash };
        });
        return response.json(result);
    } catch (error) { return fail(response, error); }
});

router.post('/images/check-copies', (request, response) => {
    try {
        const copies = request.body.copies;
        if (!Array.isArray(copies) || !copies.length || copies.length > 6) throw Object.assign(new Error('Select up to six saved image copies.'), { status: 400 });
        withRoleplayAccount(scope(request), request.body.account, lease => {
            const { scope: current } = roleplayLease(lease);
            for (const copy of copies) verifyPromptImageCopy(current.directories, copy);
        });
        return response.json({ valid: true });
    } catch (error) { return fail(response, error); }
});
