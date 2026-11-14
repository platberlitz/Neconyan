import path from 'node:path';
import { normaliseAttachments } from '../../public/scripts/scratchpad/attachment-data.js';
import { detectImageFormat } from '../../public/scripts/extensions/quick-image-gen/lib/image-metadata.js';
import { readRoleplayFile, roleplayHash } from '../roleplay-store.js';
import { generatedImageReceipts } from './image-history.js';
import { ScratchpadError } from './store.js';

const invalid = () => new ScratchpadError('SCRATCHPAD_IMAGE_SOURCE_CHANGED', 'The source image is missing or changed. Ask for a new image edit using an attachment or a saved image from this session.', 409);

/** Source selectors name earlier messages in this session, never model-supplied paths. */
export function resolveScratchpadImageSource(directories, session, reply, source) {
    const index = session.messages.findIndex(message => message.id === source.messageId);
    const replyIndex = session.messages.findIndex(message => message.id === reply.id);
    if (index < 0 || index >= replyIndex) throw invalid();
    const message = session.messages[index];
    if (source.kind === 'attachment' && message.role === 'user') {
        const attachment = normaliseAttachments(message.attachments)[source.index];
        if (attachment?.kind !== 'image') throw invalid();
        return { reference: attachment.dataUrl, hash: roleplayHash(attachment) };
    }
    if (source.kind === 'generated') {
        const receipt = generatedImageReceipts(message).find(image => image.index === source.index);
        if (!receipt) throw invalid();
        const file = readRoleplayFile(path.join(directories.root, receipt.url.replace(/^\//, '')), 20 * 1024 * 1024, { allowMissingParent: true });
        if (!file || file.rawHash !== receipt.imageHash || !detectImageFormat(file.bytes)) throw invalid();
        return { reference: receipt.url, hash: roleplayHash({ id: receipt.id, url: receipt.url, imageHash: receipt.imageHash, changeHash: receipt.changeHash }) };
    }
    throw invalid();
}

/** Labels stay available to text-only models without claiming the picture is visible. */
export function scratchpadImageSourceLabels(messageId, attachments = [], images = []) {
    if (!messageId) return '';
    return [
        ...attachments.flatMap((file, index) => file.kind === 'image' ? [`Image source ${JSON.stringify({ messageId, kind: 'attachment', index })}: attached file ${JSON.stringify(file.name)}.`] : []),
        ...images.map(image => `Image source ${JSON.stringify({ messageId, kind: 'generated', index: image.index })}: saved image from proposal ${image.index + 1}.`),
    ].join('\n');
}
