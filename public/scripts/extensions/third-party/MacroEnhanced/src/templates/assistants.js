/** Data only. installed as ordinary editable custom macros via the gallery. */
export default {
    id: 'assistants',
    name: 'Miso, Taro & Nori',
    description: 'Small macros inspired by the assistants: greetings, scene starters, checks, trims, puns and writing nudges. They install as ordinary custom macros, so they need experimental macros turned on in User Settings and a prompt built in the browser. Server-built Roleplay prompts refuse custom macros.',
    macros: [
        {
            name: 'misohello',
            description: 'Miso\'s greeting, picked from the real time of day and addressed to your persona. It changes a few times a day, not every minute.',
            template: '{{switch::{{timeofday}}::morning=Good morning, {{user}}. I hope the day is being kind to you so far.::afternoon=Good afternoon, {{user}}. How is the day treating you?::evening=Good evening, {{user}}. Ready to unwind?::default=Still awake, {{user}}? I\'ll keep you company.}}',
            args: [],
        },
        {
            name: 'misostarter',
            description: 'A one-line opening direction for the genre you pass. Try fantasy, romance, mystery, horror or science fiction; anything else gets a general start.',
            template: '{{switch::{{lower::{{genre}}}}::fantasy=Open on a place where magic costs something. Show the cost before anyone names it.::romance=Open on two people who want to speak and choose the wrong words.::mystery=Open on one small detail that does not fit. Let the reader notice it first.::horror=Open on something ordinary that is one degree wrong.::sci-fi=Open on a routine that only makes sense on this world.::science fiction=Open on a routine that only makes sense on this world.::default=Open in the middle of a scene already in motion, with one concrete detail and one thing left unsaid.}}',
            args: [{ name: 'genre' }],
        },
        {
            name: 'misocheer',
            description: 'One cheer for this chat, picked once and kept. The same line returns until you start a new chat, so it does not break the prompt cache.',
            template: '{{listpick::miso-cheer::You\'re doing better than you think. Keep going.;The scene is lucky to have you in it.;Take the next step at your own pace. I\'m right here.;That was a good idea. Trust it.;You don\'t have to get it perfect. Just keep the story moving.::;}}',
            args: [],
        },
        {
            name: 'tarodebug',
            description: 'The live model, the character name, the prompt and context ceilings, and a labelled estimate of the last message. It reports no invented numbers.',
            template: 'Model: {{model}}; character: {{char}}; prompt limit: {{maxPrompt}} tokens; context limit: {{maxContext}} tokens; last message: about {{tokencount::{{lastMessage}}}} tokens (estimate, roughly 4 characters per token).',
            args: [],
        },
        {
            name: 'tarocheck',
            description: 'Checks a host local variable, the same store as {{setvar}} and {{getvar}}, and says whether it is set and what it holds.',
            template: '{{if::{{hasvar::{{name}}}}}}Local variable \'{{name}}\' is set to \'{{getvar::{{name}}}}\'.{{else}}Local variable \'{{name}}\' is not set in this chat.{{/if}}',
            args: [{ name: 'name' }],
        },
        {
            name: 'tarotrim',
            description: 'Taro\'s trim check: counts the last message in words and asks for a tighter reply when it is over your budget. Pass the word limit as an argument.',
            template: 'The last message is {{wordcount::{{lastMessage}}}} words. {{if::{{gt::{{wordcount::{{lastMessage}}}}::{{words}}}}}}That is over the {{words}}-word budget: trim repeated description first and keep the action and last line of dialogue.{{else}}That fits the {{words}}-word budget; keep the next reply just as tight.{{/if}}',
            args: [{ name: 'words' }],
        },
        {
            name: 'taropun',
            description: 'A Taro-grade pun, fixed for this chat so the joke does not change under every prompt rebuild.',
            template: '{{listpick::taro-pun::I tried to count the scene\'s words. It was a total sentence.;The local variable walked into a bar. The bartender asked whether it was set.;I would tell you a joke about context limits, but I am afraid it would not fit.;Why did the macro cross the road? It wanted to expand its horizons.;The prompt cache and I have an understanding. Neither of us likes surprises.::;}}',
            args: [],
        },
        {
            name: 'noritwist',
            description: 'Nori\'s plot twist seed for this chat, fixed by a list pick so it stays put across prompt rebuilds.',
            template: '{{listpick::nori-twist::A trusted ally is hiding one small, specific lie.;The safest place in the scene is the one nobody can open.;Someone arrives with a message meant for a different story.;The item everyone came for is already gone, and the room is too calm about it.;A rule the characters have followed all along turns out to have an exception tonight.;The person asking the questions already knows the answer.::;}}',
            args: [],
        },
        {
            name: 'noriprank',
            description: 'Nori\'s occasional complication. It refreshes after each of your messages, stays the same across swipes, and often does nothing at all.',
            template: '{{sticky::1::nori-prank::{{random::No new complication this turn.::No new complication this turn.::No new complication this turn.::A small complication: something slips, breaks or arrives at the worst possible moment.::A small complication: someone nearby mishears and acts on the wrong version.::A small complication: a familiar object is missing from where it should be.::A small complication: a door that was closed is now open.}}}}',
            args: [],
        },
        {
            name: 'norisense',
            description: 'One sensory detail Nori wants in the scene, fixed for this chat.',
            template: '{{listpick::nori-sense::The room smells faintly of rain on warm stone.;Somewhere nearby, a clock is a beat behind the one in the hall.;The air tastes of dust and cold metal.;A chair scrapes once, then stops before anyone sits down.;The light is the colour of late afternoon, even indoors.;Something soft brushes past an ankle, too lightly to be a person.;The floor is warmer than the walls.::;}}',
            args: [],
        },
        {
            name: 'noridare',
            description: 'A small writing dare from Nori, fixed for this chat.',
            template: '{{listpick::nori-dare::Dare: let a character refuse something they usually accept.;Dare: end the next reply on a question nobody answers.;Dare: have someone tell the truth and be disbelieved.;Dare: make the next kindness cost something.;Dare: let a background object become important without explanation.;Dare: give the scene one awkward silence and do not fill it.::;}}',
            args: [],
        },
    ],
};
