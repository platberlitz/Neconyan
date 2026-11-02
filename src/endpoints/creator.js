import express from 'express';
import { roleplayAccountBase, roleplayAccountStamp, roleplayError, withRoleplayAccount } from '../roleplay-store.js';
import { listCreatorDrafts, getCreatorDraft, saveCreatorDraft } from '../creator/store.js';
import { creatorCharacterSource, creatorBookSource } from '../creator/resources.js';
import { publishCreatorDraft, getCreatorReceipt, getCreatorPublication, acknowledgeCreatorPublication, recoverCreatorPublication, discardCreatorDraft } from '../creator/publish.js';
import { previewCreatorMacros } from '../creator/macro-preview.js';

export const router = express.Router();

function route(handler) {
    return (request, response) => {
        try {
            const base = roleplayAccountBase(request.user?.directories);
            const owner = request.get('X-Neconyan-Account');
            if (!base || base.owner !== request.user?.profile?.handle || (owner !== undefined && owner !== base.owner)) throw roleplayError('CREATOR_ACCOUNT', 'The account changed. Reload Creator before continuing.', 409);
            const result = withRoleplayAccount(base, roleplayAccountStamp(base), lease => handler(lease, request.body ?? {}));
            response.json({ owner: base.owner, ...result });
        } catch (error) {
            const status = error.status || 500;
            response.status(status).json({ code: error.code || 'CREATOR_FAILED', message: status >= 500 ? 'Creator could not finish this request. Your local draft is still available.' : error.message });
        }
    };
}

router.post('/list', route(lease => ({ drafts: listCreatorDrafts(lease) })));
router.post('/get', route((lease, body) => {
    const item = getCreatorDraft(lease, body.id);
    const publication = getCreatorPublication(lease, body.id);
    return { ...item, publication: publication?.acknowledged ? null : publication };
}));
router.post('/save', route((lease, body) => saveCreatorDraft(lease, body.draft, body.expectedRevision)));
router.post('/delete', route((lease, body) => discardCreatorDraft(lease, body)));
router.post('/character', route((lease, body) => creatorCharacterSource(lease, body.avatar)));
router.post('/book', route((lease, body) => {
    const { name, data, revision } = creatorBookSource(lease, body.name);
    return { name, data, revision };
}));
router.post('/publish', route((lease, body) => publishCreatorDraft(lease, body)));
router.post('/acknowledge', route((lease, body) => acknowledgeCreatorPublication(lease, body)));
router.post('/recover', route((lease, body) => recoverCreatorPublication(lease, body)));
router.post('/receipt', route((lease, body) => {
    const publication = body.id ? getCreatorPublication(lease, body.id) : null;
    const operationId = publication?.expectedRevision === body.expectedRevision && publication?.copy === body.copy ? publication.operationId : body.operationId;
    return getCreatorReceipt(lease, operationId);
}));

router.post('/macro-preview', async (request, response) => {
    try {
        const owner = request.user?.profile?.handle;
        if (!owner || request.get('X-Neconyan-Account') !== owner) throw roleplayError('CREATOR_ACCOUNT', 'The account changed. Reopen Creator.', 409);
        const result = await previewCreatorMacros(request.body ?? {});
        response.json({ owner, ...result });
    } catch (error) {
        response.status(error.status || 500).json({ message: error.status ? error.message : 'The macro preview could not finish.' });
    }
});
