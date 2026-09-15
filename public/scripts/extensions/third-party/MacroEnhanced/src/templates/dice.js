/** Data only. installed as ordinary editable custom macros via the gallery. */
export default {
    id: 'dice',
    name: 'Dice & game mechanics',
    description: 'Skill checks and once-per-story rolls, built on the cache-friendly dice macros.',
    macros: [
        {
            name: 'statroll',
            description: 'Rolls 3d6 for a named stat once, then keeps that value for the whole chat.',
            template: '{{rollonce::stat-{{stat}}::3d6}}',
            args: [{ name: 'stat' }],
        },
        {
            name: 'skillcheck',
            description: 'Rolls a d20 against a difficulty and prints success or failure. Re-rolls every evaluation. volatile by nature.',
            template: '{{if {{gte::{{roll::d20}}::{{difficulty}}}}}}success{{else}}failure{{/if}}',
            args: [{ name: 'difficulty' }],
        },
        {
            name: 'coinflip',
            description: 'Heads or tails. Re-flips every evaluation. cache-volatile on purpose.',
            template: '{{random::heads::tails}}',
            args: [],
        },
        {
            name: 'luckystat',
            description: 'A lucky number from 1-100, rolled once per chat.',
            template: '{{rollonce::lucky::d100}}',
            args: [],
        },
    ],
};
