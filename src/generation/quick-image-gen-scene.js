import { decode } from 'html-entities';

function sceneText(value) {
    let text = String(value || '').trim();
    if (!/<\/?[A-Za-z][^>]*>/.test(text)) return text;
    if (/menu_button|drawer-opener|data-target=|fa-solid|inline-flex|extensions-settings-button|sys-settings-button|rightNavHolder/i.test(text)) return '';
    text = text.replace(/<br\b[^>]*>/gi, '\n').replace(/<\/(?:p|div|li|tr|section|article|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, '');
    return decode(text).replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function imageSceneMessage(record) {
    const swipe = Array.isArray(record.swipes) ? record.swipes[Number.isInteger(record.swipe_id) ? record.swipe_id : 0] : '';
    return [record.extra?.display_text, record.mes, swipe, record.extra?.reasoning_display_text, record.extra?.reasoning]
        .map(sceneText).find(Boolean) || '';
}
