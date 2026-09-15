/**
 * Sample marker blocks in the exact shape the bundled agent prompts ask the model to emit.
 * Used by the preview gallery and by the integration test, so a theme is always previewed
 * against text the real `findRegex` actually matches.
 *
 * Keyed by spec.key. `partial` exercises the optional-capture path, where unmatched groups
 * interpolate to an empty string and rows must collapse.
 */

export const SAMPLES = Object.freeze({
    scene: {
        full: '[SCENE|Rooftop garden|Dusk|Overcast, wind rising]\ndetail: The city hums below. Someone is already here.\n[/SCENE]',
    },
    time: {
        full: '[TIME|Day 12|Thursday|21:40]\nnote: Curfew in twenty minutes.\n[/TIME]',
    },
    item: {
        full: '[ITEM|➕ GAINED|Brass key|Small, warm to the touch]\nnote: Taken from the desk drawer.\n[/ITEM]',
    },
    event: {
        full: '[EVENT|🎯 QUEST|Deliver the sealed letter|Before dawn]\ncontext: Mira is waiting at the docks.\n[/EVENT]',
    },
    world: {
        full: '[WORLD|🏛 CULTURE|Ashfall Quarter]\ndetail: The bells ring twice at dusk, never once.\n[/WORLD]',
    },
    status: {
        full: '[STATUS|Mira|Sprained wrist|🟡 MODERATE]\nnote: Favouring her left hand all evening.\n[/STATUS]',
    },
    secret: {
        full: '[SECRET|Mira|She forged the guild seal|Only the archivist]\ncontext: She fears the guild more than the law.\n[/SECRET]',
    },
    reputation: {
        full: '[REP|Dock workers|Cautiously friendly|📈 RISING]\ncause: You paid for the crate you broke.\n[/REP]',
    },
    achievement: {
        full: '[ACH|First Forgery|★★★ RARE|Passed a forged seal as genuine]\nunlocked: The archivist never looked twice.\n[/ACH]',
    },
    relationship: {
        full: '[METER|Mira|7/10|5/10|Wary ally|🌱 Warming]\nThe shared risk on the rooftop pulled you closer.\n[/METER]',
        nonNumeric: '[METER|Mira|High|Guarded|Wary ally|🌱 Warming]\nShe still counts the exits.\n[/METER]',
    },
    parallel: {
        full: '[PARALLEL|City|High]\n- Docks: The night shift is short two hands.\n- Guild hall: A courier arrives asking for you by name.\n- Barracks: Patrol routes changed at sundown.\n[/PARALLEL]',
        partial: '[PARALLEL|City|Low]\n- Docks: The night shift is short two hands.\n[/PARALLEL]',
    },
    choices: {
        full: '[CHOICES]\n1. Take the ledger and go.\n2. Ask her who sent the courier.\n3. Wait until the bells ring.\n4. Leave the way you came.\n[/CHOICES]',
        partial: '[CHOICES]\n1. Take the ledger and go.\n2. Ask her who sent the courier.\n[/CHOICES]',
    },
    directions: {
        full: '[DIRECTIONS]\nA. Follow the courier down to the docks.\nB. Stay and press Mira for the truth.\nC. Search the archivist\'s desk.\nD. Slip out before the bells.\n[/DIRECTIONS]',
        partial: '[DIRECTIONS]\nA. Follow the courier down to the docks.\nB. Stay and press Mira for the truth.\n[/DIRECTIONS]',
    },
    'npc-major': {
        full: '[NPC:MAJOR|Mira Vance]\nb: Mira Vance, 34, woman, guild archivist\na: Ink-stained cuffs, cropped grey hair, a limp she hides\np: Precise, dry, allergic to being thanked\nh: Fifteen years in the archive; the fire was never explained\nr: Distrusts the guild master; owes the dock foreman a favour\n[/NPC]',
    },
    'npc-support': {
        full: '[NPC:SUPPORT|Dock foreman]\nb: Ezra Kolt, 50s, man, foreman\na: Broad, sunburnt, missing two fingers\np: Blunt but fair\nh: Ran cargo for the guild before the split\nr: Owed a favour by Mira\n[/NPC]',
        partial: '[NPC:SUPPORT|Dock foreman]\nb: Ezra Kolt, 50s, man, foreman\n[/NPC]',
    },
    'npc-upgrade': {
        full: '[NPC:UP|Ezra Kolt|MAJOR]\nb: Ezra Kolt, 54, man, dock foreman and informal broker\na: Broad, sunburnt, missing two fingers on his right hand\np: Blunt, fair, and quietly furious about the split\nh: Ran guild cargo for twenty years before walking out\n[/NPC]',
    },
    'npc-minor': {
        full: '[NPC:MINOR|Ledger clerk]\nb: Unnamed clerk, 20s\na: Too-large coat, chewed pen\np: Nervous, eager to help\n[/NPC]',
    },
    'npc-ref': {
        full: 'She glances up. [NPC:REF|Mira Vance|ink-stained cuffs|guarded] Then back to the ledger.',
    },
    'npc-rel': {
        full: '[NPC:REL|Mira Vance|Now willing to be seen with you in public]',
    },
    chatroom: {
        full: 'CHATROOM_STYLE|dockside\nCHATROOM|ezra|foreman|28|Night shift is short two hands.\nCHATROOM|mira|archivist|312|>implying the guild will notice\nCHATROOM|clerk|new|190|I can cover the ledger until dawn.\nCHATROOM_END',
    },
    'inbox-phone': {
        full: 'PHONE_START|Mira Vance|3 unread\nPHONE_TEXT|Mira|21:41|Are you still on the roof?\nPHONE_TEXT|Mira|21:44|The courier asked for you by name.\nPHONE_END',
    },
    'inbox-letter': {
        full: 'LETTER_START|From the Archive|Sealed at dusk\nLETTER_TEXT|M. Vance|Third bell|The ledger you asked after is no longer in the vault.\nLETTER_END',
    },
    'chat-only': {
        full: 'Mira: You are late.\nEzra: The bells were early.',
    },
    bold: {
        full: 'The seal was **already broken** when you found it.',
    },
});

/** The sample text for a spec, preferring the fullest variant. */
export function sampleFor(spec, variant = 'full') {
    const entry = SAMPLES[spec.key];
    if (!entry) {
        return null;
    }
    return entry[variant] ?? entry.full ?? null;
}
