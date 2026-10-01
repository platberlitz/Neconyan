import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { getAssistantIconSrc } from './neconyan-assistant-art.js';

export const TOOL_TOUR_INVITE_PREFIX = 'neconyanToolTourInvite.';

const ASSISTANT_NAMES = Object.freeze({ miso: 'Miso', taro: 'Taro', nori: 'Nori' });

const TOOL_PAGES = Object.freeze({
    pathfinder: {
        assistant: 'taro',
        name: 'Pawthfinder',
        kicker: 'Lore helper',
        description: 'Let the model choose which lorebook entries matter for each reply, instead of waiting for keywords.',
        invite: 'Taro will show you what each part of this page does, one step at a time.',
        emptyWhen: '#pf--lorebook-list .pf--empty-state',
        steps: [
            {
                id: 'welcome',
                targets: ['#pf--quickstart', '.neconyan-tool-page-intro'],
                title: 'What Pawthfinder does',
                body: 'A normal lorebook wakes an entry only when one of its **keywords** appears in the chat. Pawthfinder lets the model pick the entries that matter instead, so lore turns up even when nobody says the exact word.\nIt only ever reads the lorebooks you choose on this page. Press **Next** and I will take you through it in order.',
                hint: 'I read all my notes before I act. I expect the same from the model.',
            },
            {
                id: 'status',
                targets: ['#pf--status-banner'],
                title: 'The status line',
                body: 'This line says whether Pawthfinder is ready. **Not configured** means no lorebook is chosen yet. **Disabled** means the main switch is off.\nLook here first whenever lore stops turning up.',
                hint: 'Read the sign before you knock. It saves us both time.',
            },
            {
                id: 'switch',
                targets: ['.pf--master-section'],
                title: 'The main switch',
                body: '**Enable Pawthfinder for all chats** turns the whole feature on or off. Changing other settings never flips it, so it stays where you left it.',
                hint: 'One switch. On or off. I like things that know what they are.',
            },
            {
                id: 'lorebooks',
                targets: ['#pf--lorebook-section'],
                open: '#pf--lorebook-section > .pf--collapsible-header',
                title: 'Step 1: choose the lorebooks',
                body: 'Tick each lorebook Pawthfinder may read. This step is required: with nothing ticked, it has nothing to search.\n**Automatically use attached character/chat lorebooks** adds the books already linked to the current character or chat, so you do not have to tick them again for every story.',
                emptyBody: 'Tick each lorebook Pawthfinder may read. This step is required: with nothing ticked, it has nothing to search.\nYou have no lorebooks yet. Make one on the **Lorebooks** page first, then come back and tick it here.',
                hint: 'No books, no lore. I cannot find what was never written down.',
            },
            {
                id: 'mode',
                targets: ['#pf--mode-section'],
                open: '#pf--mode-section > .pf--collapsible-header',
                title: 'Step 2: choose how it works',
                body: '**Tool Mode** lets the model search and edit your lorebook by itself while it writes a reply. Your connection must support tool calls.\n**Predictive Pipeline** runs a quick, separate check before each reply and adds the entries it expects you need. It works with any connection.\nYou can turn on both, but that uses more tokens.',
                hint: 'Tools if your model can hold a pen. Pipeline if it cannot. Do not make it complicated.',
            },
            {
                id: 'pipeline',
                optional: true,
                targets: ['#pf--pipeline-settings'],
                open: '#pf--pipeline-settings > .pf--collapsible-header',
                title: 'Pipeline settings',
                body: 'These appear once the Predictive Pipeline is on. **Max Candidates** limits how many entries it may add to one reply.\n**Connection Profile for Pipeline** lets that check use a cheaper, faster model than your main chat.',
                hint: 'A cheap model for the errands. Keep the good one for the conversation.',
            },
            {
                id: 'summaries',
                targets: ['#pf--memory-summary-settings'],
                open: '#pf--memory-summary-settings > .pf--collapsible-header',
                title: 'Memory summaries',
                body: 'Pawthfinder can write short summaries of what happened and keep them with your lore.\n**Auto-track summary interval** reminds it every **Summary Interval** messages. The **Latest memory summary** box shows the newest one, and you can edit it before you press **Save Summary**.',
                hint: 'Short notes, kept current. That is how nothing important gets lost.',
            },
            {
                id: 'tools',
                targets: ['#pf--tool-settings'],
                open: '#pf--tool-settings > .pf--collapsible-header',
                title: 'Tool settings',
                body: 'These matter in Tool Mode. Choose which tools the model may use, and whether it may **write** or **delete** lorebook entries.\nTools ticked under **Ask Before Executing** show you a confirmation first, so nothing changes without your say.',
                hint: 'Nobody gets delete rights on their first day. Not even me.',
            },
            {
                id: 'diagnostics',
                targets: ['.pf--section:has(#pf--diagnostics-body)'],
                open: '.pf--section:has(#pf--diagnostics-body) > .pf--collapsible-header',
                title: 'When something seems wrong',
                body: '**Run Diagnostics** checks your setup and lists anything missing. **Copy Diagnostics** copies that report, so you can paste it when you ask for help.\nThe **Retrieval Log** just below shows what Pawthfinder actually picked for recent replies.',
                hint: 'Evidence first, opinions after. It is why I am right so often.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Choose a lorebook, choose a mode, then send a message. Everything here saves as you change it.\nPress **Tour** at the top of the page whenever you want this walk again.',
                hint: 'I will be outside having a smoke. Call me if it misbehaves.',
            },
        ],
    },
    expressions: {
        assistant: 'miso',
        name: 'Character Expressions',
        kicker: 'Faces and moods',
        description: 'Show a picture of the character that changes with the mood of each reply: happy, sad, surprised and more.',
        invite: 'Miso will show you what each part of this page does, one step at a time.',
        emptyWhen: '.expression_section_sprites:has(#open_chat_expressions[style*="display: none"])',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What expressions are',
                body: 'An **expression** is one picture of the character showing one feeling, such as **joy**, **anger** or **surprise**. These pictures are called **sprites**.\nAfter each reply, Neconyan works out the feeling in the text and shows the matching sprite beside the chat. Press **Next** and I will show you how.',
                hint: 'I have a sprite for every mood. Most of them are me asking for a snack.',
            },
            {
                id: 'classifier',
                targets: ['.expression_api_block'],
                title: 'Who reads the mood',
                body: '**Classifier API** chooses what reads each reply and picks the feeling.\n**[ None ]** never changes the picture by itself; you set it by hand. **Local** runs a small mood reader on your Neconyan server for free, and it understands English only. **Main API** asks your chat model. **WebLLM** runs a model inside this browser tab, so keep the page open. **In-Chat Agent** uses the bundled Expressions Agent, which can also draw missing sprites for you.',
                hint: 'Local is free and quick. Like me finding the treat cupboard.',
            },
            {
                id: 'agent',
                optional: true,
                targets: ['.expression_agent_block'],
                title: 'The Expressions Agent',
                body: 'These settings appear when the Classifier API is **In-Chat Agent**. The status line says whether the agent is ready.\n**Auto-generate missing sprites during chat** asks **Quick Image Gen** to draw a sprite the first time a feeling has no picture. **Sprite framing** keeps every picture at the same crop, so the faces line up.',
                hint: 'If the status says it is not ready, switch on the Expressions Agent on the Agents page. I believe in you!',
            },
            {
                id: 'prompt',
                optional: true,
                targets: ['.expression_llm_prompt_block'],
                title: 'The mood question',
                body: 'These settings appear for **Main API** and **WebLLM**. **LLM Prompt** is the instruction the model gets when it picks a feeling; the **{{labels}}** macro becomes the list of feelings it may choose from.\n**Filter expressions for available sprites** only offers feelings that have a picture, so the model never picks one you cannot show.',
                hint: 'Fewer choices means quicker answers. That is how I order dinner.',
            },
            {
                id: 'translate',
                targets: ['label[for="expression_translate"]'],
                title: 'Chats in other languages',
                body: '**Translate text to English before classification** sends each reply through the Chat Translation extension first. Turn it on with **Local** if your chats are not in English, because that mood reader only understands English.',
                hint: 'I understand every language as long as the word is "dinner".',
            },
            {
                id: 'choices',
                targets: ['.expression_section_behaviour'],
                title: 'Sprite choices',
                body: '**Allow multiple sprites per expression** lets one feeling have several pictures, and one is picked at random each time. **Re-roll if same sprite is used again** avoids showing the same one twice in a row.\n**Default / Fallback Expression** is shown when no feeling matches. **Custom Expressions** adds your own feelings beyond the built-in list; you can also switch to one with the **/emote** command.',
                hint: 'My custom expression is "belly rub, please". It gets used a lot.',
            },
            {
                id: 'sprites',
                targets: ['.expression_section_sprites'],
                title: 'This character\'s sprites',
                body: 'Every feeling has a tile here. Click a tile to show it now. The small buttons on each tile **upload** a picture, **generate** one with Quick Image Gen, or **delete** it.\nThe buttons above the tiles work on the whole set: **Generate missing sprites**, **Upload character sheet** to cut one big picture into sprites, or **Upload sprite pack (ZIP)**. **Sprite Folder Override** points this chat at a different folder of pictures.',
                emptyBody: 'Every feeling gets a tile here once a chat is open. Open a chat with a character, then come back to upload, generate or delete their sprites.',
                hint: 'Generate missing sprites is my favourite button. Pictures appear and I did not even have to get up.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is everything',
                body: 'Choose who reads the mood, add a few sprites, then chat as normal. Everything here saves as you change it.\nPress **Tour** at the top of the page whenever you want this walk again.',
                hint: 'You did so well! That deserves a treat. For both of us, ideally.',
            },
        ],
    },
    'quick-image-gen': {
        assistant: 'nori',
        name: 'Quick Image Gen',
        kicker: 'Picture maker',
        description: 'Make pictures of your characters and scenes with an image service, then drop them straight into the chat.',
        invite: 'Nori will show you what each part of this page does, one step at a time.',
        steps: [
            {
                id: 'actions',
                targets: ['#qig-settings .qig-action-bar'],
                title: 'The buttons you will use most',
                body: '**Generate** makes a picture with the settings below. The keyboard shortcut is shown on the button.\n**Quick Setup** walks you through choosing an image service and pasting its key. **Logs** shows what happened on recent tries, **Gallery** keeps the pictures you made, and **Prompts** lists the prompts you used before.',
                hint: 'Gallery is my portfolio. Every picture in it is priceless. Mostly because none of them cost anything.',
            },
            {
                id: 'status',
                targets: ['#qig-settings .qig-menu-hero'],
                title: 'Is it ready?',
                body: 'This strip says whether Quick Image Gen can make a picture right now, then lists the image service, model, size and prompt source it will use.\nIf something is missing, such as an API key, a warning appears here saying exactly where to fix it.',
                hint: 'Read it before you press Generate. I am not explaining a blank picture to anyone.',
            },
            {
                id: 'configuration',
                targets: ['#qig-settings .qig-field:has(#qig-config-select)'],
                title: 'Configurations',
                body: 'A **configuration** is one complete setup saved under a name: image service, key, model and generation settings.\nUse the floppy disk to save the current setup as a new one, the arrows to overwrite the selected one, and the bin to delete it. Switching between them is quicker than retyping everything.',
                hint: 'I keep one called Fancy and one called Fancy But Free. Guess which one I use.',
            },
            {
                id: 'prompt',
                targets: ['#qig-settings .qig-field:has(#qig-prompt)'],
                title: 'The prompt',
                body: 'Describe the picture you want. You can use **{{char}}** and **{{user}}** for the character and your persona names.\nWhen the prompt source below is **Chat scene**, this box is skipped and the selected chat messages are used instead.',
                hint: 'Be specific. "Cute cat" gets you any cat. "Tuxedo cat on velvet, smug" gets you me.',
            },
            {
                id: 'source',
                targets: ['#qig-settings .qig-field:has(.qig-prompt-source)'],
                title: 'Where the prompt comes from',
                body: '**Manual** sends the prompt box as it is. **Chat scene** turns the selected chat messages into the scene, and can let your text model rewrite them into an image prompt.\n**AI-tagged** asks your text model to add image tags to its replies. Turn on **Auto-generate** under **Automation & Delivery** so those tags make pictures.',
                hint: 'Chat scene is for when you are lazy. I respect that.',
            },
            {
                id: 'style',
                targets: ['#qig-settings .qig-field:has(#qig-style)'],
                title: 'Style',
                body: 'A style adds a look to every prompt, such as anime or photo. Choose **None** to send your prompt without additions.',
                hint: 'Taste cannot be taught. Luckily, it can be picked from a list.',
            },
            {
                id: 'more',
                targets: ['#qig-settings .qig-settings-search-shell', '#qig-setup-toggle'],
                open: '#qig-setup-toggle',
                title: 'More settings',
                body: '**More settings** holds everything else, in four sections. Lost? Type a word such as **resolution**, **key** or **negative** into the search box and only the matching settings stay visible.',
                hint: 'Search first. Scrolling through all of that is beneath both of us.',
            },
            {
                id: 'provider',
                targets: ['#qig-settings .qig-flow-provider'],
                open: ['#qig-setup-toggle', '#qig-section-provider-toggle'],
                title: 'Image service and output',
                body: 'Choose the **image service** that draws your pictures, paste its key if it needs one, then pick the model, picture size and how many pictures to make at once.\nSome **Pollinations** models work without a key, so it is a good first try. The status strip warns you if the model you picked needs one.',
                hint: 'Free is my favourite price. It is also my only price.',
            },
            {
                id: 'prompting',
                targets: ['#qig-settings .qig-menu-section--prompt'],
                open: ['#qig-setup-toggle', '#qig-section-create-toggle'],
                title: 'Prompting tools',
                body: 'These turn a plain description into a proper image prompt, or let your text model rewrite a prompt before it is sent. Use them when your pictures keep missing the point.',
                hint: 'A good prompt is like a good outfit. Most people need help with both.',
            },
            {
                id: 'context',
                targets: ['#qig-settings .qig-flow-context'],
                open: ['#qig-setup-toggle', '#qig-section-context-toggle'],
                title: 'Context rules and media',
                body: 'Give a character their own prompt, style, picture size and reference pictures, so every picture of them matches.\nThis section also manages saved pictures and videos that can be shown in chats.',
                hint: 'Consistency matters. I have looked this good in every single picture.',
            },
            {
                id: 'automation',
                targets: ['#qig-settings .qig-flow-automation'],
                open: ['#qig-setup-toggle', '#qig-section-automation-toggle'],
                title: 'Automation and delivery',
                body: 'Choose whether pictures are made automatically, for example every few replies or when the text model adds image tags, and set the keyboard shortcuts.\nLeave automatic pictures off until you know what each one costs on your image service.',
                hint: 'Automatic pictures on a paid service is how I ended up broke. Learn from me.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is everything',
                body: 'Choose an image service, write a prompt or pick a scene, then press **Generate**. Settings save as you change them.\nPress **Tour** at the top of the page whenever you want me again.',
                hint: 'You will want me again. Everybody does. Hehe.',
            },
        ],
    },
});

/**
 * Finds the full-page tool that matches an Included tool id or label.
 * @param {string} id Tool id such as 'pathfinder' or 'third-party/Name'
 * @returns {string} Page key, or '' when the tool has no full page
 */
export function getToolPageKey(id) {
    const wanted = String(id ?? '').trim().replace(/^third-party[\\/]/i, '').toLowerCase();
    if (!wanted) return '';
    return Object.keys(TOOL_PAGES).find(key => wanted === key || wanted.endsWith(`/${key}`)) || '';
}

/**
 * Returns the page details and tour for a full-page tool.
 * @param {string} id Tool id or page key
 * @returns {object|null} Page details, or null
 */
export function getToolPage(id) {
    const key = getToolPageKey(id);
    return key ? { key, ...TOOL_PAGES[key] } : null;
}

/**
 * Lists the tour steps for a page, dropping optional steps whose control is not on screen.
 * @param {string} id Tool id or page key
 * @param {{ isShown?: (step: object) => boolean, empty?: boolean }} [state] What is visible right now
 * @returns {object[]} Steps in order
 */
export function getToolTourSteps(id, { isShown = () => true, empty = false } = {}) {
    const page = getToolPage(id);
    if (!page) return [];
    return page.steps
        .filter(step => !step.optional || isShown(step))
        .map(step => ({ ...step, body: empty && step.emptyBody ? step.emptyBody : step.body }));
}

/**
 * Splits tour copy into paragraphs of text and bold runs, so it never needs HTML strings.
 * @param {string} text Copy with newline paragraphs and **bold** runs
 * @returns {{ text: string, bold: boolean }[][]} Paragraphs of runs
 */
export function parseToolTourCopy(text) {
    return String(text ?? '').split('\n').filter(line => line.trim()).map(line =>
        line.split('**').map((segment, index) => ({ text: segment, bold: index % 2 === 1 })).filter(run => run.text));
}

function translateCopy(text) {
    return String(text ?? '').split('\n').map(line => line.trim() && t([line.trim()])).join('\n');
}

const tour = {
    key: '',
    root: null,
    card: null,
    stepId: '',
    target: null,
    watch: 0,
    token: 0,
    opener: null,
    spacer: null,
};

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function portrait(assistant) {
    const image = element('img', 'neconyan-tool-tour-portrait');
    image.src = getAssistantIconSrc(assistant);
    image.alt = '';
    image.width = 48;
    image.height = 48;
    return image;
}

function isShown(node) {
    return node instanceof HTMLElement && node.getClientRects().length > 0;
}

function findShown(root, selector) {
    try {
        return [...root.querySelectorAll(selector)].find(isShown) || null;
    } catch {
        return null;
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function prefersReducedMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function coveredByCard(node) {
    const card = tour.card?.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (!card) return false;
    return rect.bottom > card.top && rect.top < card.bottom && rect.right > card.left && rect.left < card.right;
}

function currentSteps() {
    const root = tour.root;
    const emptyWhen = TOOL_PAGES[tour.key]?.emptyWhen;
    const empty = Boolean(emptyWhen && root?.querySelector(emptyWhen));
    return getToolTourSteps(tour.key, {
        empty,
        isShown: step => Boolean(root && step.targets.some(selector => findShown(root, selector))),
    });
}

function clearTarget() {
    tour.target?.classList.remove('neconyan-tool-tour-target');
    tour.target = null;
}

function openStep(step) {
    if (!step.open || !tour.root) return;
    for (const selector of [].concat(step.open)) {
        const header = findShown(tour.root, selector);
        if (header?.getAttribute('aria-expanded') === 'false') header.click();
    }
}

function renderCopy(host, text) {
    host.replaceChildren(...parseToolTourCopy(text).map(runs => {
        const paragraph = element('p');
        for (const run of runs) paragraph.append(run.bold ? element('strong', '', run.text) : document.createTextNode(run.text));
        return paragraph;
    }));
}

async function show(stepId) {
    if (!tour.card) return;
    const token = ++tour.token;
    const steps = currentSteps();
    const step = steps.find(item => item.id === stepId) || steps[0];
    if (!step) return;
    clearTarget();
    tour.stepId = step.id;
    openStep(step);
    const index = Math.max(0, steps.findIndex(item => item.id === step.id));
    const card = tour.card;
    card.dataset.step = step.id;
    card.querySelector('.neconyan-tool-tour-count').textContent = t`Step ${index + 1} of ${steps.length}`;
    card.querySelector('.neconyan-tool-tour-title').textContent = t([step.title]);
    renderCopy(card.querySelector('.neconyan-tool-tour-body'), translateCopy(step.body));
    card.querySelector('.neconyan-tool-tour-hint').textContent = t([step.hint]);
    card.querySelector('[data-tool-tour-back]').disabled = index === 0;
    card.querySelector('[data-tool-tour-next]').textContent = index === steps.length - 1 ? t`Done` : t`Next`;
    if (tour.spacer) {
        tour.root.append(tour.spacer);
        tour.spacer.style.height = `${Math.ceil(card.getBoundingClientRect().height) + 24}px`;
    }
    await wait(60);
    if (token !== tour.token) return;
    const target = step.targets.map(selector => findShown(tour.root, selector)).find(Boolean);
    if (!target) return;
    tour.target = target;
    target.classList.add('neconyan-tool-tour-target');
    const reduced = prefersReducedMotion();
    target.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    await wait(reduced ? 50 : 500);
    if (token === tour.token && coveredByCard(target)) target.scrollIntoView({ block: 'start' });
}

async function move(delta) {
    const steps = currentSteps();
    const index = steps.findIndex(step => step.id === tour.stepId);
    const nextIndex = index + delta;
    if (nextIndex >= steps.length) {
        endToolTour();
        return;
    }
    await show(steps[Math.max(0, nextIndex)].id);
}

function rememberInvite(key) {
    accountStorage.setItem(`${TOOL_TOUR_INVITE_PREFIX}${key}`, 'seen');
    document.querySelectorAll(`.neconyan-tool-tour-invite[data-tool-page="${key}"]`).forEach(invite => { invite.hidden = true; });
}

function onKeydown(event) {
    if (event.key === 'Escape' && tour.card) {
        event.stopPropagation();
        event.preventDefault();
        endToolTour();
    }
}

function buildCard(page) {
    const card = element('aside', 'neconyan-tool-tour');
    card.id = 'neconyan-tool-tour';
    card.dataset.toolPage = page.key;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', 'neconyan-tool-tour-title');
    card.setAttribute('aria-describedby', 'neconyan-tool-tour-body');
    card.tabIndex = -1;

    const head = element('div', 'neconyan-tool-tour-head');
    const heading = element('div', 'neconyan-tool-tour-heading');
    const count = element('span', 'neconyan-tool-tour-count');
    count.setAttribute('aria-live', 'polite');
    const title = element('strong', 'neconyan-tool-tour-title');
    title.id = 'neconyan-tool-tour-title';
    const speaker = t([`${ASSISTANT_NAMES[page.assistant]}'s ${page.name} tour`]);
    heading.append(element('span', 'neconyan-tool-tour-speaker', speaker), title, count);
    const close = element('button', 'menu_button menu_button_icon neconyan-tool-tour-close');
    close.type = 'button';
    close.setAttribute('aria-label', t`End the tour`);
    close.title = t`End tour`;
    const closeIcon = element('i', 'fa-solid fa-xmark');
    closeIcon.setAttribute('aria-hidden', 'true');
    close.append(closeIcon);
    close.addEventListener('click', () => endToolTour());
    head.append(portrait(page.assistant), heading, close);

    const body = element('div', 'neconyan-tool-tour-body');
    body.id = 'neconyan-tool-tour-body';
    body.setAttribute('aria-live', 'polite');
    const hint = element('p', 'neconyan-tool-tour-hint');

    const actions = element('div', 'neconyan-tool-tour-actions');
    const back = element('button', 'menu_button', t`Back`);
    back.type = 'button';
    back.dataset.toolTourBack = '';
    back.addEventListener('click', () => void move(-1));
    const next = element('button', 'menu_button neconyan-tool-tour-next', t`Next`);
    next.type = 'button';
    next.dataset.toolTourNext = '';
    next.addEventListener('click', () => void move(1));
    actions.append(back, next);

    card.append(head, body, hint, actions);
    return card;
}

/**
 * Opens the assistant's step-by-step tour for a full-page tool.
 * @param {string} id Tool id or page key
 * @param {HTMLElement} root The page that holds the tool's controls
 */
export function startToolTour(id, root) {
    const page = getToolPage(id);
    if (!page || !(root instanceof HTMLElement)) return;
    endToolTour({ restoreFocus: false });
    rememberInvite(page.key);
    tour.key = page.key;
    tour.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    tour.root = root;
    tour.card = buildCard(page);
    document.body.append(tour.card);
    document.addEventListener('keydown', onKeydown, true);
    document.body.classList.add('neconyan-tool-tour-active');
    tour.spacer = element('div', 'neconyan-tool-tour-spacer');
    tour.spacer.setAttribute('aria-hidden', 'true');
    tour.watch = setInterval(() => {
        if (!isShown(tour.root)) endToolTour({ restoreFocus: false });
    }, 1000);
    void show(page.steps[0].id).then(() => tour.card?.focus({ preventScroll: true }));
}

/**
 * Closes the tool tour and removes its highlight.
 * @param {{ restoreFocus?: boolean }} [options] Whether focus returns to the control that opened it
 */
export function endToolTour({ restoreFocus = true } = {}) {
    tour.token++;
    clearInterval(tour.watch);
    tour.spacer?.remove();
    tour.spacer = null;
    clearTarget();
    tour.card?.remove();
    tour.card = null;
    tour.stepId = '';
    tour.key = '';
    tour.root = null;
    document.removeEventListener('keydown', onKeydown, true);
    document.body.classList.remove('neconyan-tool-tour-active');
    if (restoreFocus && isShown(tour.opener)) tour.opener.focus({ preventScroll: true });
    tour.opener = null;
}

function buildInvite(page, root) {
    const invite = element('div', 'neconyan-tool-tour-invite');
    invite.dataset.toolPage = page.key;
    invite.setAttribute('role', 'note');
    const copy = element('p');
    copy.append(element('strong', '', t([`New to ${page.name}?`])), document.createTextNode(` ${t([page.invite])}`));
    const actions = element('div', 'neconyan-tool-tour-invite-actions');
    const start = element('button', 'menu_button neconyan-tool-tour-next', t`Show me around`);
    start.type = 'button';
    start.addEventListener('click', () => startToolTour(page.key, root));
    const later = element('button', 'menu_button', t`Not now`);
    later.type = 'button';
    later.addEventListener('click', () => rememberInvite(page.key));
    actions.append(start, later);
    invite.append(portrait(page.assistant), copy, actions);
    invite.hidden = accountStorage.getItem(`${TOOL_TOUR_INVITE_PREFIX}${page.key}`) === 'seen';
    return invite;
}

/**
 * Builds the page introduction, Tour button and first-visit invitation for a full-page tool.
 * @param {string} id Tool id or page key
 * @param {HTMLElement} heading Where the introduction goes
 * @param {HTMLElement} root The page that holds the tool's controls
 * @returns {boolean} Whether the tool has a full page
 */
export function mountToolPage(id, heading, root) {
    const page = getToolPage(id);
    heading?.querySelector('.neconyan-tool-page-intro')?.remove();
    heading?.querySelector('.neconyan-tool-tour-invite')?.remove();
    if (!page || !(heading instanceof HTMLElement)) return false;
    const intro = element('div', 'neconyan-tool-page-intro neconyan-cat-panel');
    const copy = element('div', 'neconyan-tool-page-copy');
    copy.append(element('span', 'neconyan-native-kicker', t([page.kicker])), element('p', 'neconyan-tool-page-description', t([page.description])));
    const launch = element('button', 'menu_button menu_button_icon neconyan-tool-tour-button');
    launch.type = 'button';
    launch.setAttribute('aria-label', t([`Start ${ASSISTANT_NAMES[page.assistant]}'s ${page.name} tour`]));
    launch.title = t([`A guided walk through ${page.name}`]);
    const icon = element('i', 'fa-solid fa-paw');
    icon.setAttribute('aria-hidden', 'true');
    launch.append(icon, element('span', '', t`Tour`));
    launch.addEventListener('click', () => startToolTour(page.key, root));
    intro.append(copy, launch);
    heading.append(intro, buildInvite(page, root));
    return true;
}
