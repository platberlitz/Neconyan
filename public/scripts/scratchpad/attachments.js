import { t } from '../i18n.js';
import { MAX_FILE_BYTES, MAX_DOCUMENT_BYTES, attachmentBytes, normaliseAttachments } from './attachment-data.js';

async function imageData(file) {
    const url = URL.createObjectURL(file);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const png = canvas.toDataURL('image/png');
        if (png.length <= 1024 * 1024) return png;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.85, 0.65, 0.45]) {
            const jpeg = canvas.toDataURL('image/jpeg', quality);
            if (jpeg.length <= 1024 * 1024) return jpeg;
        }
        throw new Error(t`This image is too detailed to attach. Choose a smaller image.`);
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function pdfText(buffer) {
    const pdfjs = await import('../../lib/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.mjs';
    const task = pdfjs.getDocument({ data: buffer });
    try {
        const pdf = await task.promise;
        if (pdf.numPages > 300) throw new Error(t`This PDF has more than 300 pages. Attach a shorter document.`);
        const pages = [];
        let size = 0;
        for (let number = 1; number <= pdf.numPages; number++) {
            const page = await pdf.getPage(number);
            const content = await page.getTextContent();
            const text = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
            size += attachmentBytes(text);
            if (size > MAX_DOCUMENT_BYTES) throw new Error(t`This PDF contains too much text. Attach a shorter document.`);
            pages.push(`[Page ${number}]\n${text}`);
            page.cleanup();
        }
        if (!pages.some(page => page.replace(/^\[Page \d+\]/, '').trim())) throw new Error(t`This PDF has no readable text. Attach its pages as images or use a PDF with selectable text.`);
        return pages.join('\n\n');
    } finally {
        await task.destroy();
    }
}

/** Read locally before sending; unsupported binary files never become garbled prompts. */
export async function prepareAttachment(file) {
    if (file.size > MAX_FILE_BYTES) throw new Error(t`Choose files up to 32 MiB each.`);
    const base = { name: file.name, size: file.size };
    const buffer = await file.arrayBuffer();
    const header = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 12));
    const signature = String.fromCharCode(...header);
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name);
    let attachment;
    if (isImage) {
        attachment = { ...base, kind: 'image', dataUrl: await imageData(file) };
    } else if (signature.startsWith('%PDF-') || file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        attachment = { ...base, kind: 'text', mimeType: 'application/pdf', text: await pdfText(buffer) };
    } else {
        let text;
        try {
            const encoding = header[0] === 255 && header[1] === 254 ? 'utf-16le' : header[0] === 254 && header[1] === 255 ? 'utf-16be' : 'utf-8';
            text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
            if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error('Binary file');
        } catch {
            throw new Error(t`This file is not readable text. Attach a text file, JSON, CSV, Markdown, PDF or image.`);
        }
        attachment = { ...base, kind: 'text', mimeType: 'text/plain', text };
    }
    return normaliseAttachments([attachment])[0];
}
