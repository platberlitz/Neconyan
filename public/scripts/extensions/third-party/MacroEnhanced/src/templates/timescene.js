/** Data only. installed as ordinary editable custom macros via the gallery. */
export default {
    id: 'timescene',
    name: 'Time & scene helpers',
    description: 'Cache-safe scene setters built on the coarse time macros.',
    macros: [
        {
            name: 'scenetime',
            description: 'A cache-friendly scene-time line. changes a few times a day, not every minute.',
            template: 'It is {{timeofday}}, in {{season}}.',
            args: [],
        },
        {
            name: 'daygreeting',
            description: 'A greeting that matches the time of day.',
            template: '{{switch::{{timeofday}}::morning=Good morning::afternoon=Good afternoon::evening=Good evening::default=Up late, are we?}}',
            args: [],
        },
        {
            name: 'chatage',
            description: 'How long this story has been running.',
            template: 'This story has run for {{chatdays}} day(s) and {{usermsgcount}} of your messages.',
            args: [],
        },
        {
            name: 'dailyweather',
            description: 'Picks the day\'s weather once per calendar day. random flavor without cache damage.',
            template: '{{daily::weather::{{random::clear skies::steady rain::rolling fog::harsh wind}}}}',
            args: [],
        },
    ],
};
