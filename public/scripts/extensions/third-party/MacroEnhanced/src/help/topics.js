/**
 * The written guides shown at the top of the Reference tab.
 *
 * Macro descriptions explain what one macro does. These explain the things no
 * single macro description can: why the cache-friendly macros exist at all,
 * which scope wins when two macros share a name, what the sandbox does and does
 * not save. Without them the reference answers "how do I call this" but not
 * "why would I".
 *
 * Data only -- installed like the template packs (src/templates/*.js). `see`
 * lists macro names that become links into the macro index below.
 */

export const TOPICS = Object.freeze([
    {
        id: 'getting-started',
        title: 'Getting started',
        body: [
            'Macro Enhanced adds macros to Neconyan\'s experimental macro engine. They work anywhere ordinary macros do: preset prompts, character cards, lorebook entries, and your own messages.',
            'Everything on this page can be tried without consequences. Open the Playground tab, type a macro, and the result appears as you type. nothing you do there touches a real variable or a saved value.',
            'Three places to look: this reference for what exists, the Playground for trying it, and the Cache Audit for finding macros that are quietly costing you money.',
        ],
        see: ['upper', 'calc', 'freeze'],
    },
    {
        id: 'prompt-caching',
        title: 'Why prompt caching matters',
        body: [
            'Every generation re-sends your presets, character card, lorebooks and chat history to the model. Providers discount that re-sent text heavily. but only when it arrives byte-for-byte identical to last time.',
            'Macros are re-evaluated on every generation, so a single changing value near the top of the prompt rewrites it and cancels the discount. One {{time}} in a character card is enough to lose it every minute.',
            'The state macros give you the same flavour without the churn. {{freeze}} evaluates something once and returns that answer forever after; {{sticky}} refreshes every N messages; {{daily}} refreshes once a day. Their values are stored inside the chat and survive reloads.',
            'Where a value has to vary, prefer the coarse version: {{timeofday}} instead of {{time}}, {{season}} instead of {{date}}, {{listpick}} instead of {{random}}, {{rollonce}} instead of {{roll}}.',
            'The Cache Audit tab scans your actual setup and tells you which macros are breaking it, and which are sitting harmlessly far enough down the prompt not to matter.',
        ],
        see: ['freeze', 'sticky', 'daily', 'timeofday', 'season', 'listpick', 'rollonce'],
    },
    {
        id: 'conditions',
        title: 'Conditions written the ordinary way',
        body: [
            'Neconyan\'s {{if}} does not compare anything. It asks one question: is the condition non-empty? Empty text, "false", "off" and "0" count as no; everything else counts as yes.',
            'That matters because a condition written the way most people would write it is text, and text is not empty. {{if::{{.hp}} > 0}} hands {{if}} the words "0 > 0", which are not empty, so the block always runs. Nothing warns you. it simply behaves as though the test passed.',
            'Turn on "Work out comparisons in {{if}} conditions" in the Macro Enhanced settings drawer and conditions like that are worked out properly. You can use == != > >= < <= && || ! and brackets. Values with spaces should be quoted: {{if::{{.name}} == "Selphie Windsong"}}.',
            'Conditions without a comparison are untouched, so turning this on cannot change what your existing prompts do. {{if::{{getchatvar::location}}}} still just asks whether the value is set, and {{if !personality}} still inverts.',
            'You can also use {{expr}} directly at any time, without the setting, which is the safer choice if you only need it in one place: {{if::{{expr::{{.hp}} > 0}}}}. The setting exists for content written elsewhere that you would rather not edit.',
        ],
        see: ['expr', 'and', 'or', 'not', 'gt', 'eq'],
    },
    {
        id: 'imported-syntax',
        title: 'Macros written for other apps',
        body: [
            'Cards and lorebooks written for a different chat app often carry macro spellings this engine has no syntax for. They do not fail loudly. The engine cannot read them, so it hands them back as plain text and the model is shown {{@name}} verbatim, in the middle of a description that otherwise works.',
            'Three spellings account for almost all of it. {{@name}} reads a variable, but @ is not one of this engine\'s markers, so it never registers as a macro at all. {{!setvar name value}} separates its arguments with spaces, which arrive here as one argument, so the call is the wrong shape whichever way you read it. And a single space used as an argument. {{split::sentence:: ::0}}. vanishes before the macro sees it, because spaces between argument separators are discarded.',
            'Turn on "Repair macro spellings this engine cannot read" in the Macro Enhanced settings drawer and each of those is translated on its way into the engine: a chat-variable read, a proper {{setvar}}, and {{space}}. Nothing else is touched. text that already works is passed through byte for byte, so turning this on cannot change what your existing prompts do.',
            'It is off by default because it rewrites text app-wide, and a setting that quietly edits every prompt should be one you chose. If you would rather fix the files themselves, scripts/convert-import.js in this extension applies exactly the same rewrites to an exported world book or regex bundle, and also repairs the file shapes Neconyan\'s importer cannot read.',
            'One thing it cannot repair: || inside an argument. A single | starts an output filter, so the macro fails before anything can be substituted, and there is no rewrite that is safe in every case. Where the meaning is unambiguous. inside a condition. compat mode already expresses it as {{or::a::b}}.',
        ],
        see: ['getchatvar', 'setchatvar', 'space', 'split', 'or'],
    },
    {
        id: 'chat-variables',
        title: 'Chat variables and looping over them',
        body: [
            '{{setchatvar}} stores a value that stays with the chat. {{getchatvar}} reads it back, {{haschatvar}} asks whether it was ever set, {{addchatvar}} adds to it, and {{deletechatvar}} removes it. They write nothing into the prompt themselves.',
            'These are a separate store from the host\'s own {{setvar}}, on purpose. {{foreachChatVar}} walks every chat variable whose name starts with a prefix, and content that does that almost always also uses {{setvar}} for scratch values under the same prefix. Sharing one store would make those scratch values show up as loop items.',
            'One consequence worth knowing: the built-in /getchatvar slash command is an alias for the host\'s variables and will not see these. Use /me-chatvar to read, set, list or delete them.',
            'A loop looks like {{foreachChatVar::satiety_::p}}…{{/foreachChatVar}}. Inside, {{.p}} is the name with the prefix removed, {{.p_key}} is the full name and {{.p_value}} is the value. Names are visited in alphabetical order, so the same data always renders the same way. which is what keeps a loop from breaking prompt caching.',
        ],
        see: ['setchatvar', 'getchatvar', 'haschatvar', 'addchatvar', 'deletechatvar', 'foreachChatVar'],
    },
    {
        id: 'custom-macros',
        title: 'Writing your own macros',
        body: [
            'A custom macro is a name plus a template. the text it expands to. No coding. Open Extensions → Macro Enhanced → Your custom macros.',
            'Templates can use other macros, including this extension\'s. A macro named "greet" with the template "Hello {{user}}, it is {{timeofday}}." expands wherever you write {{greet}}.',
            'Arguments are optional. Add an argument named "who" and it becomes available inside the template as {{who}}. or as {{arg1}} by position. Callers pass values with the :: separator: {{greet::Alice}}. Optional arguments can have a default.',
            'The editor shows the exact call signature as you type, checks the name as you go, and "Test in Workbench" saves the macro and opens it in the Playground.',
            'A macro that includes itself is stopped with a console warning rather than looping forever.',
        ],
        see: [],
    },
    {
        id: 'scopes',
        title: 'Where custom macros are saved',
        body: [
            'Every custom macro is saved in one of three places. Global macros are available everywhere. Character macros exist only while that character is open, and travel with the character card when you share it. Chat macros exist only inside one chat, stored in the chat file itself.',
            'When the same name exists in more than one scope, the most specific wins: chat beats character, character beats global. That is how you override one global macro for a single scene without touching it everywhere else.',
            'Names are checked as you type. You cannot take a name belonging to another extension, one of this extension\'s built-ins, or anything starting with "me-". that prefix is reserved.',
        ],
        see: [],
    },
    {
        id: 'sandbox',
        title: 'What the Workbench does and does not save',
        body: [
            'The Playground is sandboxed. Variable macros write to a throwaway copy, and the state macros ({{freeze}}, {{sticky}}, {{daily}}, {{rollonce}}) do too. so previewing a frozen value does not freeze it for real.',
            'The panel on the right lists every chat and global variable, plus the changes your text would have made if it ran for real, shown as "hp: 50 → 35". "Reset sandbox" throws those pending changes away.',
            'One caveat worth knowing: the shorthand writes ({{.x = 5}}, {{$y++}}) reach past the sandbox, so they touch the real value for a split second before being put back. Another extension watching for variable changes at that exact moment could notice.',
            'Counters like {{usermsgcount}} are never bumped by evaluation, in the Playground or anywhere else. they only move on real chat events.',
        ],
        see: ['freeze', 'usermsgcount'],
    },
    {
        id: 'nesting-and-args',
        title: 'Arguments, nesting and truthiness',
        body: [
            'Arguments are separated by ::. so a literal :: cannot appear inside one. That is an engine limitation, not something this extension can work around.',
            'Macros nest freely: {{calc::max({{getvar::hp}}, 0)}} resolves the inner macro first. Nesting inside a {{switch}} branch is lazy. only the winning branch\'s macros ever run.',
            'The comparison macros return the literal text "true" or "false", which is exactly what {{if}} expects, so they slot straight in: {{if {{gt::{{getvar::hp}}::0}}}}…{{/if}}.',
            'For {{if}} and the logic macros, a value counts as false when it is empty, "off", "false" or "0" after trimming. Everything else is true.',
        ],
        see: ['switch', 'eq', 'gt', 'and', 'calc'],
    },
    {
        id: 'lorebook-lookup',
        title: 'How lorebook entries are found',
        body: [
            'Entries are looked up by their title (the memo/comment field) or by uid. Without an explicit book, they are searched in order: the chat lorebook first, then the character\'s books, then the global books.',
            'Add a book name as the second argument to target one directly: {{lore::Kingdom::My World}}.',
            'Books load in the background, so immediately after opening a chat the first use of a book can come back empty. It works from the next evaluation onward. this is normal, not a failure.',
        ],
        see: ['lore', 'lorekeys', 'loreexists', 'lorebooks'],
    },
    {
        id: 'pronouns',
        title: 'Pronouns',
        body: [
            'Cards written on JanitorAI say "{{sub}} adjusted {{poss}} coat" so they read correctly whoever is chatting. Neconyan holds no pronoun anywhere, so imported cards used to send that text to the model as-is. These macros fill the gap.',
            'The five names are the JanitorAI ones: {{sub}} (she, he, they), {{obj}} (her, him, them), {{poss}} (her, his, their), {{poss_p}} (hers, his, theirs) and {{ref}} (herself, himself, themself). They follow your persona. The same five with a "char" in front. {{charsub}}, {{charposs}} and so on. follow the character instead.',
            'Capitalize the macro to capitalize the word: {{Sub}} gives "She" where {{sub}} gives "she". Handy at the start of a sentence.',
            'Verbs are the part that quietly breaks: text written for she/her reads wrong the moment a they/them persona loads it. {{pverb::is::are}} picks the form that agrees, and there is a {{charpverb}} for the character.',
            'Pronouns are set in the Macro Enhanced settings panel. yours against the persona, the character\'s onto its card, so they travel with it when you share it. {{setpronouns::he/him}} overrides either one for the current chat only.',
            'Anything left unset is they/them. Beyond the four presets you can write all five forms out: xe/xem/xyr/xyrs/xemself. Add "/plural" or "/singular" on the end if the verb agreement comes out wrong.',
        ],
        see: ['sub', 'obj', 'poss', 'poss_p', 'ref', 'charsub', 'pverb', 'pronouns', 'setpronouns'],
    },
    {
        id: 'name-collisions',
        title: 'When Neconyan claims a name',
        body: [
            'If a future Neconyan update ships a macro with the same name as one of this extension\'s, the extension steps aside rather than overwriting it. Its own version is renamed with a "me-" prefix, and the settings panel says which ones moved.',
            'Every macro also has a hidden me- alias from day one. Writing {{me-count}} instead of {{count}} means your prompts keep working no matter what upstream does later.',
            'The same protection runs the other way: this extension never takes a name another extension already registered.',
        ],
        see: [],
    },
    {
        id: 'packs-and-gallery',
        title: 'Template gallery and sharing',
        body: [
            'The template gallery ships four starter packs. RP state trackers, dice and game mechanics, prompt-style guards, and time and scene helpers. Installing one copies its macros into whichever scope you pick, where they become ordinary custom macros you can open and edit.',
            'Nothing is ever overwritten. A name that already exists gets a -2 suffix instead.',
            'Custom macros can be exported per scope as a small JSON pack file and imported on another machine or shared with someone else. /me-export scope=chat prints the same JSON for scripting.',
        ],
        see: [],
    },
]);

/**
 * One guide by id.
 *
 * @param {string} id
 * @returns {object|undefined}
 */
export function getTopic(id) {
    return TOPICS.find(topic => topic.id === id);
}
