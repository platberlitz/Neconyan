/** Data only. installed as ordinary editable custom macros via the gallery. */
export default {
    id: 'rp-state',
    name: 'RP state trackers',
    description: 'Mood, relationship and outfit trackers backed by chat variables, so they persist per story.',
    macros: [
        {
            name: 'mood',
            description: 'The character\'s current mood (neutral until set). Set it with {{moodset::...}}.',
            template: '{{default::{{getvar::me_mood}}::neutral}}',
            args: [],
        },
        {
            name: 'moodset',
            description: 'Sets the mood tracker.',
            template: '{{setvar::me_mood::{{value}}}}',
            args: [{ name: 'value' }],
        },
        {
            name: 'affinity',
            description: 'A relationship meter, 0 until changed. Move it with {{affinityadd::...}}.',
            template: '{{default::{{getvar::me_affinity}}::0}}',
            args: [],
        },
        {
            name: 'affinityadd',
            description: 'Raises the relationship meter (negative numbers lower it).',
            template: '{{addvar::me_affinity::{{amount}}}}',
            args: [{ name: 'amount' }],
        },
        {
            name: 'outfit',
            description: 'The tracked outfit (everyday clothes until set). Set it with {{outfitset::...}}.',
            template: '{{default::{{getvar::me_outfit}}::everyday clothes}}',
            args: [],
        },
        {
            name: 'outfitset',
            description: 'Sets the outfit tracker.',
            template: '{{setvar::me_outfit::{{value}}}}',
            args: [{ name: 'value' }],
        },
        {
            name: 'statusline',
            description: 'One line with mood, affinity and outfit. install the other trackers from this pack too.',
            template: 'Mood: {{mood}} | Affinity: {{affinity}} | Outfit: {{outfit}}',
            args: [],
        },
    ],
};
