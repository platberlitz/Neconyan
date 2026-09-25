import { roleplayError, roleplayHash } from '../roleplay-store.js';

export const MAX_CAPTION_BYTES = 64 * 1024;

/** Apply only the admitted media items, after validating every original record before any change. */
export function applyCaptionRecords(original, items, results) {
    const invalid = () => roleplayError('ROLEPLAY_CAPTION_RECOVERY', 'The saved captions do not match their accepted media.', 503);
    if (!Array.isArray(items) || !items.length || !Array.isArray(results) || results.length !== items.length) throw invalid();
    const selected = new Set();
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const record = Number.isSafeInteger(item?.index) && item.index >= 0 ? original[item.index + 1] : null;
        const media = Number.isSafeInteger(item?.mediaIndex) && item.mediaIndex >= 0 ? record?.extra?.media?.[item.mediaIndex] : null;
        const result = results[index];
        if (!record || !media || roleplayHash(record) !== item.recordHash || roleplayHash(media) !== item.mediaHash
            || selected.has(`${item.index}:${item.mediaIndex}`)
            || ['caption', 'title'].some(key => typeof result?.[key] !== 'string' || !result[key].trim()
                || Buffer.byteLength(result[key]) > MAX_CAPTION_BYTES)) throw invalid();
        selected.add(`${item.index}:${item.mediaIndex}`);
    }
    const records = structuredClone(original);
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const record = records[item.index + 1];
        const media = record.extra.media[item.mediaIndex];
        const title = results[index].title;
        if (!String(record.mes ?? '').trim()) {
            record.mes = title;
            record.extra.inline_image = false;
        } else {
            media.append_title = true;
            record.extra.inline_image = true;
        }
        media.title = title;
        media.captioned = true;
    }
    return records;
}
