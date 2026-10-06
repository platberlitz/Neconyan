import { accountStorage } from '../util/AccountStorage.js';
import { getCurrentUserHandle } from '../user.js';
import { NOTE_TEMPLATES, normaliseTemplates } from './templates.js';

const KEY = 'neconyan_note_templates';

export function savedTemplates() {
    const raw = accountStorage.getItem(KEY);
    if (!raw) return NOTE_TEMPLATES.map(item => ({ ...item }));
    try {
        const data = JSON.parse(raw);
        if (data.version !== 1) throw new Error('Unknown format.');
        return [{ ...NOTE_TEMPLATES[0] }, ...normaliseTemplates(data.templates)];
    } catch {
        throw new Error('Saved templates could not be read. No templates have been replaced.');
    }
}

export function saveTemplates(items, expectedAccount) {
    if (getCurrentUserHandle() !== expectedAccount) throw new Error('The account changed. Open Templates again.');
    const templates = normaliseTemplates(items);
    accountStorage.setItem(KEY, JSON.stringify({ version: 1, templates }));
    return [{ ...NOTE_TEMPLATES[0] }, ...templates];
}
