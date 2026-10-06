/* Templates are plain text: nothing in them is run, expanded or evaluated. */
export const NOTE_TEMPLATES = Object.freeze([
    { id: 'blank', label: 'Blank note', title: '', text: '' },
    {
        id: 'character', label: 'Character draft', title: 'New character',
        text: '---\ntype: character\ntags: [character]\n---\n# New character\n\n## Look\n\n## Personality\n\n## Wants and fears\n\n## Relationships\n\n## Open questions\n',
    },
    {
        id: 'location', label: 'Location', title: 'New location',
        text: '---\ntype: location\ntags: [location]\n---\n# New location\n\n## What it looks like\n\n## Who is here\n\n## History\n\n## Hooks\n',
    },
    {
        id: 'scene', label: 'Scene plan', title: 'Scene plan',
        text: '---\ntype: scene\ntags: [scene]\n---\n# Scene plan\n\n## Goal\n\n## Who is in it\n\n## Beats\n- [ ] Opening\n- [ ] Turn\n- [ ] Ending\n\n## Notes\n',
    },
    {
        id: 'journal', label: 'Session journal', title: 'Session journal',
        text: '---\ntype: journal\ntags: [journal]\n---\n# Session journal\n\n## What happened\n\n## Threads to pick up\n\n## Ideas for next time\n',
    },
]);

export const TEMPLATE_LIMITS = Object.freeze({ count: 40, textBytes: 64 * 1024, totalBytes: 512 * 1024 });

export function normaliseTemplates(items) {
    if (!Array.isArray(items) || items.length > TEMPLATE_LIMITS.count) throw new Error('Keep at most 40 saved templates.');
    const seen = new Set(['blank']);
    const encoder = new TextEncoder();
    const templates = items.map(item => {
        if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) || seen.has(item.id)) throw new Error('Each template needs a unique identifier. Blank note is kept separately.');
        seen.add(item.id);
        if (typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 80) throw new Error('Give each template a name of up to 80 characters.');
        if (typeof item.title !== 'string' || item.title.length > 160 || typeof item.text !== 'string') throw new Error('Keep the suggested note name within 160 characters.');
        if (item.text.length > TEMPLATE_LIMITS.textBytes || encoder.encode(item.text).length > TEMPLATE_LIMITS.textBytes) throw new Error('Keep each template within 64 KiB of text.');
        return { id: item.id, label: item.label.trim(), title: item.title, text: item.text.replace(/\r\n?/g, '\n') };
    });
    if (encoder.encode(JSON.stringify(templates)).length > TEMPLATE_LIMITS.totalBytes) throw new Error('Keep the saved templates within 512 KiB in total.');
    return templates;
}

export function templateById(id, templates = NOTE_TEMPLATES) {
    return templates.find(item => item.id === id) ?? NOTE_TEMPLATES[0];
}
