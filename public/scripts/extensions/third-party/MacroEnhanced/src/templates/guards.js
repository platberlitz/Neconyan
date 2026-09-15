/** Data only. installed as ordinary editable custom macros via the gallery. */
export default {
    id: 'guards',
    name: 'Prompt-style guards',
    description: 'Format, point-of-view and length reminders to drop into a preset prompt or Author\'s Note.',
    macros: [
        {
            name: 'replyformat',
            description: 'A reply-format instruction. Pass a style, or leave it for third person past tense.',
            template: 'Write in {{default::{{style}}::third person, past tense}}, staying in character as {{char}}.',
            args: [{ name: 'style', optional: true, defaultValue: '' }],
        },
        {
            name: 'povguard',
            description: 'Keeps the AI from speaking or acting for you.',
            template: 'Never write {{user}}\'s actions, thoughts or dialogue. leave those to {{user}}.',
            args: [],
        },
        {
            name: 'lengthhint',
            description: 'Asks for replies under a word budget (300 unless you pass one).',
            template: 'Keep the reply under {{default::{{words}}::300}} words.',
            args: [{ name: 'words', optional: true, defaultValue: '' }],
        },
        {
            name: 'sceneanchor',
            description: 'Freezes an opening-scene line the first time it runs, so it never breaks the prompt cache afterwards.',
            template: '{{freeze::scene-anchor::The scene opened on a {{timeofday}} in {{season}}.}}',
            args: [],
        },
    ],
};
