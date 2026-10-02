import { t } from './i18n.js';
import { getAssistantIconSrc } from './neconyan-assistant-art.js';

import { LOREBOOK_TOUR_INVITE_KEY, addTourInvitationDismiss, dismissTourInvitation } from './neconyan-tour-invitations.js';
export { LOREBOOK_TOUR_INVITE_KEY } from './neconyan-tour-invitations.js';

const ENTRY_EDIT_BUTTON = '#world_popup_entries_list .world_entry .WIEntryHeaderMain > button:first-child';
const ENTRY_KEYWORDS = '.world_entry_edit .keyprimary';
const ENTRY_CONTENT = '.world_entry_edit textarea[name="content"]';

const LOREBOOK_TOUR_STEPS = Object.freeze([
    {
        id: 'welcome',
        view: 'library',
        targets: ['#neconyan-lorebook-library'],
        title: 'What a lorebook does',
        body: 'A lorebook is a notebook of facts about your story: people, places, secrets. Each fact is an **entry** with a few **keywords**.\nWhen one of those words comes up in the chat, Neconyan quietly hands that entry to the model, so it remembers the detail without you repeating it.\nPress **Next** to go step by step. If you open a book or an entry yourself, I will follow along.',
        hint: 'I keep mine in a very expensive leather notebook. Well, I will, once someone buys me one.',
    },
    {
        id: 'folders',
        view: 'library',
        targets: ['.neconyan-lorebook-folders', '.neconyan-lorebook-new-folder'],
        title: 'Folders for a growing pile',
        body: '**New folder** makes a shelf, and the menu beside each book moves it there. The search box finds a book by name.\nDeleting a folder never deletes its books; they simply go back to **Unfiled**.',
        hint: 'Tidy shelves, messy owner. We all have our strengths.',
    },
    {
        id: 'create',
        view: 'library',
        targets: ['#world_create_button'],
        title: 'Start a book',
        body: 'Press **New lorebook** and give it a name, like the town or world it belongs to. **Import** brings in a lorebook file someone shared with you.',
        emptyBody: 'Press **New lorebook** and give it a name, like the town or world it belongs to. **Import** brings in a lorebook file someone shared with you.\nMake one now, then press **Next** and I will show you the inside.',
        hint: 'Go on, click it. I will wait right here and pretend I am not watching.',
    },
    {
        id: 'open',
        view: 'library',
        needs: 'book',
        targets: ['.neconyan-lorebook-book-open', '.neconyan-lorebook-books'],
        title: 'Open a book',
        body: 'Press a book\'s name to open it and see its entries. Try it now, or press **Next** and I will open the first one for you.',
        hint: 'Paws off my diary, though. That one is not a lorebook.',
    },
    {
        id: 'add-entry',
        view: 'book',
        needs: 'book',
        targets: ['#world_popup_new'],
        title: 'One fact, one entry',
        body: '**Add entry** makes a new, blank entry. Give each person, place or secret its own entry, so only the detail that matters joins the reply.',
        emptyBody: 'This book has no entries yet. Press **Add entry** now to make your first one, then press **Next**.',
        hint: 'One big entry about everything is how you end up paying for tokens you never needed. Ask me how I know.',
    },
    {
        id: 'edit-entry',
        view: 'book',
        needs: 'entry',
        targets: [ENTRY_EDIT_BUTTON],
        title: 'Open an entry',
        body: 'Press **Edit** on an entry to see what is inside it. Try it now, or press **Next** and I will open the first one.',
        hint: 'The little switch beside it turns an entry off without deleting it. Very handy for a secret that is not ready yet.',
    },
    {
        id: 'keywords',
        view: 'book',
        needs: 'entry',
        open: 'entry',
        targets: [ENTRY_KEYWORDS],
        title: 'Keywords wake an entry up',
        body: 'These are the **Primary Keywords**. Type a word and press Enter to add it: a name, a nickname, a place.\nWhen any of them appears in the recent messages, this entry is added to what the model reads for its next reply.',
        hint: 'Pick words people actually say. \'Mara\' works. \'The fishmonger with the tragic past\' will never come up, trust me.',
    },
    {
        id: 'content',
        view: 'book',
        needs: 'entry',
        open: 'entry',
        targets: [ENTRY_CONTENT],
        title: 'Content is what the model reads',
        body: 'Write the fact here, short and plain, the way you would leave a note for a friend.\nIf an entry should be included every time, keywords or not, set its status from **Normal** to **Constant**.',
        hint: 'Short notes are cheaper. I like cheap. I mean, efficient.',
    },
    {
        id: 'logic',
        view: 'book',
        needs: 'entry',
        open: 'entry',
        targets: ['.world_entry_edit .keysecondary', '.world_entry_edit select[name="entryLogicType"]'],
        title: 'Narrow it down with a filter',
        body: '**Optional Filter** is a second list of words that is checked after the keywords match. **Logic** decides what it needs.\n**AND ANY** needs at least one filter word as well. **AND ALL** needs every filter word. **NOT ANY** keeps the entry out if any filter word appears, and **NOT ALL** keeps it out only when all of them appear.\nLeave the filter empty and only the keywords count.',
        hint: '\'Mara\' with NOT ANY \'funeral\' keeps her party plans out of the sad scene. I am a very sensitive cat.',
    },
    {
        id: 'placement',
        view: 'book',
        needs: 'entry',
        open: 'entry',
        targets: ['.world_entry_edit .world_entry_placement_controls'],
        title: 'Where it goes and who goes first',
        body: '**Position** picks where the entry sits in what the model reads: before or after the character details, around the example messages or the Author\'s Note, or **@D** to place it inside the chat itself. **Outlet** holds it back for a prompt that asks for it.\n**Depth** only matters for **@D**: 0 puts it after the newest message, 4 puts it four messages back.\n**Order** settles ties when several entries land in the same place: higher numbers go closer to the end, where the model pays them more attention.\n**Trigger probability** is the chance, out of 100, that the entry joins in when its keywords match.',
        hint: 'Depth 0 is shouting it in the model\'s ear. Use it for things that truly cannot be forgotten, like my snack schedule.',
    },
    {
        id: 'advanced',
        view: 'book',
        needs: 'entry',
        open: 'entry',
        expand: 'advanced',
        targets: ['.world_entry_edit .neconyan-entry-advanced > summary'],
        title: 'Advanced entry settings',
        body: 'Everything in here is optional. The defaults suit most entries, so only change what one entry really needs.\nI have opened it for you. Press **Next** and I will go through its three groups: **Activation rules**, **Inclusion and timing** and **Additional matching sources**.',
        hint: 'The scary drawer. Do not worry, nothing in here bites. Except me, occasionally.',
    },
    {
        id: 'recursion',
        view: 'book',
        needs: 'entry',
        open: 'entry',
        expand: 'advanced',
        targets: ['.world_entry_edit .neconyan-entry-advanced-content > .neconyan-entry-flags'],
        title: 'Entries that wake other entries',
        body: 'When an entry joins in, its own text is searched for keywords too, so one entry can wake another. This is called **recursion**, and it needs **Recursive Scan** switched on in the lorebook settings.\n**Non-recursable** means other entries cannot wake this one. **Prevent further recursion** stops this one from waking others. **Delay until recursion** means only another entry can wake it, never the chat.\n**Ignore budget** lets it in even when the lorebook space is full. **Agent blacklisted** hides it from Agents that look things up in your lorebooks.',
        hint: 'A mentions B, B mentions C, and suddenly the whole family tree turns up for dinner. That is recursion.',
    },
    {
        id: 'overrides',
        view: 'book',
        needs: 'entry',
        open: 'entry',
        expand: 'advanced',
        targets: ['.world_entry_edit .neconyan-entry-advanced-content [name="perEntryOverridesBlock"]'],
        title: 'Rules for this entry only',
        body: '**Selective** switches the Optional Filter on or off, and **Use Probability** does the same for Trigger probability.\nThe boxes beside them replace a lorebook-wide setting for this entry alone. Leave them on **Use global** unless this entry should behave differently.\n**Scan Depth** is how many recent messages are searched for its keywords. **Case-Sensitive** and **Whole Words** change how exactly a keyword must match.\n**Outlet Name** names the outlet for the **Outlet** position: write {{outlet::Name}} in a prompt and the entry appears there. **Automation ID** can run a Quick Reply when the entry joins in.',
        hint: 'Whole Words on means \'cat\' will not match \'catastrophe\'. Learned that one the hard way.',
    },
    {
        id: 'timing',
        view: 'book',
        needs: 'entry',
        open: 'entry',
        expand: 'advanced',
        targets: ['.world_entry_edit .neconyan-entry-advanced-content > .flex-container:has(input[name="group"])'],
        title: 'Groups and timing',
        body: 'Entries with the same **Inclusion Group** name take turns: if several match at once, only one joins in. **Group Weight** makes one more likely to be picked, **Prioritize** lets it win outright, and **Group Scoring** picks the one with the most matching keywords.\n**Sticky** keeps an entry in for that many messages after it wakes. **Cooldown** makes it sit out that many messages afterwards. **Delay** keeps it out until the chat has at least that many messages.\n**Filter to Characters or Tags** limits the entry to the characters you list, or keeps it away from them with **Exclude**. **Filter to Generation Triggers** limits it to kinds of reply, such as swipes or continues.',
        hint: 'Three moods for one character, one group, and the model only ever sees one. Very tidy. Very unlike my room.',
    },
    {
        id: 'sources',
        view: 'book',
        needs: 'entry',
        open: 'entry',
        expand: 'advanced',
        targets: ['.world_entry_edit .neconyan-entry-advanced-content > .neconyan-entry-flags:last-child'],
        title: 'Look beyond the chat',
        body: 'Keywords are normally only searched for in the chat messages. Tick any of these to also search the character\'s description, personality, scenario, notes or your persona.\nUse it for an entry that should follow a character around, whatever is being said.',
        hint: 'Now the book can read the character sheet too. Nosy, like me.',
    },
    {
        id: 'health',
        view: 'book',
        needs: 'book',
        targets: ['#neco-lore-health-button'],
        title: 'A quick check-up',
        body: '**Health** looks for problems, such as entries with no keywords, and offers fixes. The battery beside it shows how much of the model\'s reading space your always-included entries take up.',
        hint: 'Free check-ups. The only free thing around here, so enjoy it.',
    },
    {
        id: 'switch-on',
        open: 'settings',
        targets: ['#WIMultiSelector', '.neconyan-lorebook-secondary-settings'],
        title: 'Switch the book on',
        body: 'A book only works once it is switched on. Choose it in this list to use it in every chat.\nTo tie a book to one character instead, open their card and press **Character Lore**.',
        hint: 'A lorebook nobody switched on is just a very well-organised diary. Mine is badly organised, but that is beside the point.',
    },
    {
        id: 'global-budget',
        open: 'settings',
        expand: 'activation',
        targets: ['#wiSliders', '#wiActivationCard'],
        title: 'How much the lorebooks may add',
        body: 'These settings apply to every lorebook at once. **Scan Depth** is how many recent messages are searched for keywords.\n**Context %** and **Budget Cap** limit how much of the model\'s reading space entries may take. When it is full, the rest are left out, so keep this in mind for big books.\n**Min Activations** keeps searching further back until at least that many entries have joined, but never past **Max Depth**. **Max Recursion Steps** limits how many times in a row entries may wake each other.\n**Insertion Strategy** decides whether the character\'s own lorebook or the global ones go first.',
        hint: 'A budget. For words. Even my lorebooks are on a diet.',
    },
    {
        id: 'global-matching',
        open: 'settings',
        expand: 'activation',
        targets: ['#wiCheckboxes'],
        title: 'Matching rules for every book',
        body: '**Include Names** also searches the names of whoever is speaking. **Recursive Scan** lets entries wake other entries.\n**Case Sensitive** and **Match Whole Words** set how exactly keywords must match; an entry can still choose its own. **Use Group Scoring** turns on group scoring everywhere.\n**Alert On Overflow** warns you when entries were left out because the budget was full.',
        hint: 'Turn on the overflow alert. Silent failures are how I lost three naps last week.',
    },
    {
        id: 'done',
        targets: ['.neconyan-lorebook-tour-button'],
        title: 'That is the whole tour',
        body: 'You know the lot now: make a book, add entries with keywords, then switch it on. Press **Tour** any time to see this again.',
        hint: 'Now go write something scandalous. For the story, obviously.',
    },
]);

/**
 * Picks the tour steps that make sense for what the user has right now.
 * @param {{ hasBooks?: boolean, hasEntries?: boolean }} state Current library state
 * @returns {object[]} Steps to show, each with the body text that fits the state
 */
export function getLorebookTourSteps({ hasBooks = false, hasEntries = true } = {}) {
    return LOREBOOK_TOUR_STEPS
        .filter(step => step.needs !== 'book' || hasBooks)
        .filter(step => step.needs !== 'entry' || (hasBooks && hasEntries))
        .map(step => {
            const empty = (step.id === 'create' && !hasBooks) || (step.id === 'add-entry' && !hasEntries);
            return { ...step, body: empty && step.emptyBody ? step.emptyBody : step.body };
        });
}

/**
 * Works out which step the tour should jump to after the user moves around on their own.
 * @param {string} stepId The step on screen
 * @param {{ view: string, entryOpened?: boolean, steps: { id: string }[] }} state What the user did and the steps available
 * @returns {string} Step id to show, or '' to stay put
 */
export function followLorebookTourStep(stepId, { view, entryOpened = false, steps }) {
    const step = LOREBOOK_TOUR_STEPS.find(item => item.id === stepId);
    const has = id => steps.some(item => item.id === id);
    if (!step) return '';
    if (step.view === 'library' && view === 'book' && has('add-entry')) return 'add-entry';
    if (step.view === 'book' && view === 'library') return has('open') ? 'open' : 'create';
    if (entryOpened && (stepId === 'add-entry' || stepId === 'edit-entry') && has('keywords')) return 'keywords';
    return '';
}

/**
 * Splits tour copy into paragraphs of text and bold runs, so it never needs HTML strings.
 * @param {string} text Copy with newline paragraphs and **bold** runs
 * @returns {{ text: string, bold: boolean }[][]} Paragraphs of runs
 */
export function parseLorebookTourCopy(text) {
    return String(text ?? '').split('\n').filter(line => line.trim()).map(line =>
        line.split('**').map((segment, index) => ({ text: segment, bold: index % 2 === 1 })).filter(run => run.text));
}

/**
 * Translates tour copy paragraph by paragraph, since the catalogue keeps one key per paragraph.
 * @param {string} text Copy with newline paragraphs
 * @returns {string} Translated copy with the same paragraphs
 */
export function translateLorebookTourCopy(text) {
    return String(text ?? '').split('\n').map(line => line.trim() && t([line.trim()])).join('\n');
}

const tour = {
    root: null,
    card: null,
    stepId: '',
    target: null,
    watch: 0,
    token: 0,
    opener: null,
    preparing: false,
    entryWasOpen: false,
    followTimer: 0,
    observer: null,
    spacer: null,
};

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function isShown(node) {
    return node instanceof HTMLElement && node.getClientRects().length > 0;
}

function findShown(root, selector) {
    return [...root.querySelectorAll(selector)].find(isShown) || null;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check, timeout = 2000) {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeout) return false;
        await wait(60);
    }
    return true;
}

async function waitForStill(node, timeout = 900) {
    const started = Date.now();
    let last = '';
    while (Date.now() - started < timeout) {
        const rect = node.getBoundingClientRect();
        const now = `${Math.round(rect.top)}:${Math.round(rect.height)}`;
        if (now === last) return;
        last = now;
        await wait(80);
    }
}

function coveredByCard(node) {
    const card = tour.card?.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (!card) return 0;
    const overlaps = rect.bottom > card.top && rect.top < card.bottom && rect.right > card.left && rect.left < card.right;
    return overlaps ? rect.bottom - card.top : 0;
}

function prefersReducedMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function libraryView() {
    return tour.root?.querySelector('#neconyan-lorebook-library')?.dataset.view || 'library';
}

function readState() {
    const root = tour.root;
    const hasBooks = Boolean(root?.querySelector('.neconyan-lorebook-book-open'))
        || [...(document.getElementById('world_editor_select')?.options || [])].some(option => option.value !== '');
    const hasEntries = libraryView() !== 'book' || Boolean(root?.querySelector('#world_popup_entries_list .world_entry'));
    return { hasBooks, hasEntries };
}

function currentSteps() {
    return getLorebookTourSteps(readState());
}

function clearTarget() {
    tour.target?.classList.remove('neconyan-lorebook-tour-target');
    tour.target = null;
}

function entryIsOpen() {
    return Boolean(tour.root && findShown(tour.root, ENTRY_KEYWORDS));
}

function followUser() {
    clearTimeout(tour.followTimer);
    if (!tour.card) return;
    if (tour.preparing) {
        scheduleFollow();
        return;
    }
    const entryOpen = entryIsOpen();
    const next = followLorebookTourStep(tour.stepId, {
        view: libraryView(),
        entryOpened: entryOpen && !tour.entryWasOpen,
        steps: currentSteps(),
    });
    tour.entryWasOpen = entryOpen;
    if (next && next !== tour.stepId) void show(next);
}

function scheduleFollow() {
    clearTimeout(tour.followTimer);
    tour.followTimer = setTimeout(followUser, 450);
}

function onRootClick(event) {
    if (event.isTrusted) scheduleFollow();
}

async function prepare(step) {
    const root = tour.root;
    if (step.view === 'library' && libraryView() === 'book') {
        root.querySelector('.neconyan-lorebook-back')?.click();
        await waitFor(() => libraryView() === 'library', 1000);
    }
    if (step.view === 'book' && libraryView() !== 'book') {
        const open = findShown(root, '.neconyan-lorebook-book-open');
        if (open) {
            open.click();
            await waitFor(() => libraryView() === 'book', 2000);
            await waitFor(() => Boolean(findShown(root, '#world_popup_new')), 2000);
            await waitFor(() => Boolean(root.querySelector('#world_popup_entries_list .world_entry')), 1200);
        }
    }
    if (step.open === 'entry' && !findShown(root, ENTRY_KEYWORDS)) {
        findShown(root, ENTRY_EDIT_BUTTON)?.click();
        await waitFor(() => Boolean(findShown(root, ENTRY_KEYWORDS)), 2000);
    }
    if (step.expand === 'advanced') {
        const advanced = findShown(root, '.world_entry_edit .neconyan-entry-advanced');
        if (advanced instanceof HTMLDetailsElement) advanced.open = true;
    }
    if (step.open === 'settings') {
        const details = root.querySelector('.neconyan-lorebook-secondary-settings');
        if (details instanceof HTMLDetailsElement) details.open = true;
    }
    if (step.expand === 'activation') {
        const card = root.querySelector('#wiActivationCard');
        const content = card?.querySelector('.inline-drawer-content');
        if (content && !isShown(content)) {
            card.querySelector('.inline-drawer-toggle')?.click();
            await waitFor(() => isShown(content), 1500);
        }
    }
}

function renderCopy(host, text) {
    host.replaceChildren(...parseLorebookTourCopy(text).map(runs => {
        const paragraph = element('p');
        for (const run of runs) paragraph.append(run.bold ? element('strong', '', run.text) : document.createTextNode(run.text));
        return paragraph;
    }));
}

async function show(stepId) {
    if (!tour.card) return;
    const token = ++tour.token;
    let steps = currentSteps();
    let step = steps.find(item => item.id === stepId) || steps[0];
    clearTarget();
    tour.stepId = step.id;
    tour.card.setAttribute('aria-busy', 'true');
    tour.preparing = true;
    try {
        await prepare(step);
    } finally {
        if (token === tour.token) tour.preparing = false;
    }
    if (token !== tour.token || !tour.card) return;
    tour.entryWasOpen = entryIsOpen();
    steps = currentSteps();
    step = steps.find(item => item.id === step.id) || step;
    const index = Math.max(0, steps.findIndex(item => item.id === step.id));
    const card = tour.card;
    card.dataset.step = step.id;
    card.querySelector('.neconyan-lorebook-tour-count').textContent = t`Step ${index + 1} of ${steps.length}`;
    card.querySelector('.neconyan-lorebook-tour-title').textContent = t([step.title]);
    renderCopy(card.querySelector('.neconyan-lorebook-tour-body'), translateLorebookTourCopy(step.body));
    card.querySelector('.neconyan-lorebook-tour-hint').textContent = t([step.hint]);
    card.querySelector('[data-lorebook-tour-back]').disabled = index === 0;
    const next = card.querySelector('[data-lorebook-tour-next]');
    next.textContent = index === steps.length - 1 ? t`Done` : t`Next`;
    card.removeAttribute('aria-busy');
    if (tour.spacer) {
        tour.root.append(tour.spacer);
        tour.spacer.style.height = `${Math.ceil(card.getBoundingClientRect().height) + 24}px`;
    }

    const target = step.targets.map(selector => findShown(tour.root, selector)).find(Boolean);
    if (target) {
        tour.target = target;
        target.classList.add('neconyan-lorebook-tour-target');
        await waitForStill(target);
        if (token !== tour.token) return;
        const reduced = prefersReducedMotion();
        target.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
        await wait(reduced ? 50 : 500);
        if (token === tour.token && coveredByCard(target) > 0) target.scrollIntoView({ block: 'start' });
    }
}

async function move(delta) {
    const steps = currentSteps();
    const index = steps.findIndex(step => step.id === tour.stepId);
    const nextIndex = index + delta;
    if (nextIndex >= steps.length) {
        endLorebookTour();
        return;
    }
    await show(steps[Math.max(0, nextIndex)].id);
}

function rememberInvite() {
    dismissTourInvitation(LOREBOOK_TOUR_INVITE_KEY);
    tour.root?.querySelectorAll('.neconyan-lorebook-tour-invite').forEach(invite => { invite.hidden = true; });
}

function onKeydown(event) {
    if (event.key === 'Escape' && tour.card) {
        event.stopPropagation();
        endLorebookTour();
    }
}

function buildCard() {
    const card = element('aside', 'neconyan-lorebook-tour');
    card.id = 'neconyan-lorebook-tour';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', 'neconyan-lorebook-tour-title');
    card.setAttribute('aria-describedby', 'neconyan-lorebook-tour-body');
    card.tabIndex = -1;

    const head = element('div', 'neconyan-lorebook-tour-head');
    const portrait = element('img', 'neconyan-lorebook-tour-portrait');
    portrait.src = getAssistantIconSrc('nori');
    portrait.alt = '';
    portrait.width = 48;
    portrait.height = 48;
    const heading = element('div', 'neconyan-lorebook-tour-heading');
    const count = element('span', 'neconyan-lorebook-tour-count');
    count.setAttribute('aria-live', 'polite');
    const title = element('strong', 'neconyan-lorebook-tour-title');
    title.id = 'neconyan-lorebook-tour-title';
    heading.append(element('span', 'neconyan-lorebook-tour-speaker', t`Nori's lorebook tour`), title, count);
    const close = element('button', 'menu_button menu_button_icon neconyan-lorebook-tour-close');
    close.type = 'button';
    close.dataset.lorebookTourClose = '';
    close.setAttribute('aria-label', t`End the lorebook tour`);
    close.title = t`End tour`;
    const closeIcon = element('i', 'fa-solid fa-xmark');
    closeIcon.setAttribute('aria-hidden', 'true');
    close.append(closeIcon);
    close.addEventListener('click', () => endLorebookTour());
    head.append(portrait, heading, close);

    const body = element('div', 'neconyan-lorebook-tour-body');
    body.id = 'neconyan-lorebook-tour-body';
    body.setAttribute('aria-live', 'polite');
    const hint = element('p', 'neconyan-lorebook-tour-hint');

    const actions = element('div', 'neconyan-lorebook-tour-actions');
    const back = element('button', 'menu_button', t`Back`);
    back.type = 'button';
    back.dataset.lorebookTourBack = '';
    back.addEventListener('click', () => void move(-1));
    const next = element('button', 'menu_button menu_button_primary neconyan-lorebook-tour-next', t`Next`);
    next.type = 'button';
    next.dataset.lorebookTourNext = '';
    next.addEventListener('click', () => void move(1));
    actions.append(back, next);

    card.append(head, body, hint, actions);
    card.addEventListener('keydown', onKeydown);
    return card;
}

/**
 * Opens Nori's step-by-step Lorebooks tour, which highlights the real controls.
 * @param {HTMLElement} [root] The #WorldInfo panel
 */
export function startLorebookTour(root = document.getElementById('WorldInfo')) {
    if (!(root instanceof HTMLElement)) return;
    rememberInvite();
    tour.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    tour.root = root;
    if (!tour.card) {
        tour.card = buildCard();
        document.body.append(tour.card);
        document.addEventListener('keydown', onKeydown);
    }
    document.body.classList.add('neconyan-lorebook-tour-active');
    if (!tour.spacer) {
        tour.spacer = element('div', 'neconyan-lorebook-tour-spacer');
        tour.spacer.setAttribute('aria-hidden', 'true');
    }
    tour.observer?.disconnect();
    root.removeEventListener('click', onRootClick, true);
    root.addEventListener('click', onRootClick, true);
    const library = root.querySelector('#neconyan-lorebook-library');
    if (library) {
        tour.observer = new MutationObserver(scheduleFollow);
        tour.observer.observe(library, { attributes: true, attributeFilter: ['data-view'] });
    }
    clearInterval(tour.watch);
    tour.watch = setInterval(() => {
        if (!isShown(tour.root?.querySelector('#neconyan-lorebook-library'))) endLorebookTour({ restoreFocus: false });
    }, 1000);
    void show(LOREBOOK_TOUR_STEPS[0].id).then(() => tour.card?.focus({ preventScroll: true }));
}

/**
 * Closes the Lorebooks tour and removes its highlight.
 * @param {{ restoreFocus?: boolean }} [options] Whether focus returns to the control that opened it
 */
export function endLorebookTour({ restoreFocus = true } = {}) {
    tour.token++;
    tour.preparing = false;
    clearInterval(tour.watch);
    clearTimeout(tour.followTimer);
    tour.observer?.disconnect();
    tour.observer = null;
    tour.root?.removeEventListener('click', onRootClick, true);
    tour.spacer?.remove();
    tour.spacer = null;
    clearTarget();
    tour.card?.remove();
    tour.card = null;
    tour.stepId = '';
    document.removeEventListener('keydown', onKeydown);
    document.body.classList.remove('neconyan-lorebook-tour-active');
    if (restoreFocus && isShown(tour.opener)) tour.opener.focus({ preventScroll: true });
    tour.opener = null;
}

function buildInvite(root) {
    const invite = element('div', 'neconyan-lorebook-tour-invite');
    invite.setAttribute('role', 'note');
    const portrait = element('img', 'neconyan-lorebook-tour-portrait');
    portrait.src = getAssistantIconSrc('nori');
    portrait.alt = '';
    portrait.width = 48;
    portrait.height = 48;
    const copy = element('p');
    copy.append(element('strong', '', t`New to lorebooks?`), document.createTextNode(` ${t`Nori can show you what each part does, one step at a time.`}`));
    const actions = element('div', 'neconyan-lorebook-tour-invite-actions');
    const start = element('button', 'menu_button menu_button_primary neconyan-lorebook-tour-next', t`Show me around`);
    start.type = 'button';
    start.addEventListener('click', () => startLorebookTour(root));
    const later = element('button', 'menu_button', t`Not now`);
    later.type = 'button';
    later.addEventListener('click', () => rememberInvite());
    actions.append(start, later);
    invite.append(portrait, copy, actions);
    addTourInvitationDismiss(invite, LOREBOOK_TOUR_INVITE_KEY, root);
    return invite;
}

/**
 * Adds the Tour button and the first-visit invitation to the Lorebooks library.
 * @param {HTMLElement} root The #WorldInfo panel
 */
export function mountLorebookTour(root) {
    const library = root?.querySelector?.('#neconyan-lorebook-library');
    if (!(library instanceof HTMLElement) || library.dataset.lorebookTour === 'true') return;
    library.dataset.lorebookTour = 'true';
    const launch = element('button', 'menu_button menu_button_icon neconyan-lorebook-tour-button');
    launch.type = 'button';
    launch.setAttribute('aria-label', t`Start the lorebook tour`);
    launch.title = t`A friendly walk through Lorebooks`;
    launch.append(element('i', 'fa-solid fa-paw'), element('span', '', t`Tour`));
    launch.querySelector('i').setAttribute('aria-hidden', 'true');
    launch.addEventListener('click', () => startLorebookTour(root));
    library.querySelector('.neconyan-lorebook-toolbar')?.prepend(launch);
    library.querySelector('.neconyan-native-workspace-heading')?.after(buildInvite(root));
}
