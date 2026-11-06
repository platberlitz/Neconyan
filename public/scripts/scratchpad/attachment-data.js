/** Portable, inline attachments: the same checks apply to sends and session imports. */
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
export const attachmentBytes = value => new TextEncoder().encode(value).length;

function fail(message, status = 400) {
    return Object.assign(new Error(message), { code: 'SCRATCHPAD_ATTACHMENT_INVALID', status });
}

export function normaliseAttachments(input = []) {
    if (!Array.isArray(input) || input.length > MAX_ATTACHMENTS) throw fail('Attach up to eight files per message.');
    const attachments = input.map(file => {
        const name = typeof file?.name === 'string' ? file.name.replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
        if (!name || name.length > 255
            || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) {
            throw fail('That attachment is invalid. Choose files up to 32 MiB each.');
        }
        const base = { name, size: file.size, kind: file.kind };
        if (file.kind === 'text') {
            if (typeof file.text !== 'string' || attachmentBytes(file.text) > MAX_DOCUMENT_BYTES) throw fail('A document can contain up to 1 MiB of text. Choose a smaller file.', 413);
            return { ...base, mimeType: file.mimeType === 'application/pdf' ? 'application/pdf' : 'text/plain', text: file.text };
        }
        if (file.kind !== 'image' || typeof file.dataUrl !== 'string' || file.dataUrl.length > MAX_ATTACHMENT_BYTES) throw fail('That image is invalid or too large.', 413);
        const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(file.dataUrl);
        if (!match || match[2].length % 4 !== 0) throw fail('Attach a PNG, JPEG, WebP or GIF image.');
        const signature = { png: 'iVBORw0KGgo', jpeg: '/9j/', webp: 'UklGR', gif: 'R0lGOD' }[match[1]];
        if (!match[2].startsWith(signature)) throw fail('The image contents do not match its file type.');
        return { ...base, mimeType: `image/${match[1]}`, dataUrl: file.dataUrl };
    });
    if (attachmentBytes(JSON.stringify(attachments)) > MAX_ATTACHMENT_BYTES) throw fail('These attachments are too large together. Send fewer files at a time (2 MiB of prepared content per message).', 413);
    return attachments;
}

/** Documents stay literal text; image bytes travel as actual vision input. */
export function attachmentContent(text, attachments = []) {
    if (!attachments.length) return text;
    const parts = [{ type: 'text', text: text || 'Please read the attached files.' }];
    for (const file of attachments) {
        const label = `Attached file: ${JSON.stringify(file.name)}`;
        parts.push({ type: 'text', text: file.kind === 'text' ? [label, file.text, '[End of attached file]'].join('\n') : label });
        if (file.kind === 'image') parts.push({ type: 'image_url', image_url: { url: file.dataUrl, detail: 'auto' } });
    }
    return attachments.some(file => file.kind === 'image') ? parts : parts.map(part => part.text).join('\n\n');
}
