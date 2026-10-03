/* Static note templates. They are plain text: nothing in them is run, expanded or evaluated. */
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

export function templateById(id) {
    return NOTE_TEMPLATES.find(item => item.id === id) ?? NOTE_TEMPLATES[0];
}
