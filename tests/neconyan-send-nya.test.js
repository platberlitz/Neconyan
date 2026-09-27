import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

function createElement(tag) {
    const listeners = new Map();
    const element = {
        tagName: tag.toUpperCase(),
        style: {
            priorities: {},
            setProperty(name, value, priority) {
                const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
                this[key] = value;
                if (priority) this.priorities[key] = priority;
            },
        },
        attributes: {},
        className: '',
        textContent: '',
        removed: false,
        setAttribute(name, value) { this.attributes[name] = value; },
        remove() { this.removed = true; },
        animate: jest.fn((frames, options) => {
            element.frames = frames;
            element.options = options;
            return {
                addEventListener: (type, handler) => listeners.set(type, handler),
                cancel: () => listeners.get('cancel')?.(),
            };
        }),
    };
    element.animation = () => ({ cancel: () => listeners.get('cancel')?.() });
    return element;
}

const listeners = {};
const appended = [];
const pendingFrames = [];
const paint = () => pendingFrames.splice(0).forEach(callback => callback());
// The paw's row, #rightSendForm: it stays visible when Stop replaces the paw.
const sendRow = {
    style: {},
    computed: { position: 'static', borderRightWidth: '2px', borderBottomWidth: '1px' },
    getBoundingClientRect: () => ({ left: 60, top: 190, right: 160, bottom: 250, width: 100, height: 60 }),
    append: node => appended.push(node),
};
const sendButton = {
    id: 'send_but',
    style: {},
    parentElement: sendRow,
    contains: node => node === sendButton,
    closest: selector => (selector.includes('#send_but') ? sendButton : null),
    getBoundingClientRect: () => ({ left: 100, top: 200, right: 140, bottom: 240, width: 40, height: 40 }),
    append: () => { throw new Error('The pop must not live inside the paw, which hides while sending.'); },
};
// Right: 160 - 2 border - 120 paw centre. Bottom: 250 - 1 border - 200 paw top.
const ABOVE_PAW = { position: 'absolute', right: '38px', bottom: '49px' };
const elsewhere = { contains: () => false, closest: () => null };
let hitTarget = sendButton;
let sendNya;

beforeAll(async () => {
    jest.useFakeTimers();
    global.window = {
        matchMedia: () => ({ matches: false }),
        requestAnimationFrame: callback => pendingFrames.push(callback),
        getComputedStyle: element => element.computed,
    };
    global.document = {
        addEventListener: (type, handler) => { listeners[type] = handler; },
        createElement,
        elementFromPoint: () => hitTarget,
        body: { append: node => appended.push(node) },
    };
    sendNya = await import('../public/scripts/neconyan-send-nya.js');
});

afterAll(() => {
    jest.useRealTimers();
    delete global.window;
    delete global.document;
});

beforeEach(() => {
    paint();
    jest.runAllTimers();
    appended.length = 0;
    hitTarget = sendButton;
});

function press(target, { trusted = true, x = 110, y = 210, pointerId = 1 } = {}) {
    listeners.pointerdown({ target, isTrusted: trusted, button: 0, pointerId });
    listeners.pointerup({ target, isTrusted: trusted, clientX: x, clientY: y, pointerId });
}

describe('paw send button', () => {
    test('both send buttons use the paw icon instead of the paper plane', () => {
        const index = read('../public/index.html');
        const sendBut = index.match(/<div id="send_but"[^>]*>/)[0];
        expect(sendBut).toContain('fa-paw');
        expect(sendBut).not.toContain('fa-paper-plane');

        const timeline = read('../public/scripts/neconyan-conversation/timeline-render.js');
        expect(timeline).toMatch(/id="\$\{CHROME_IDS\.send\}"[^>]*>\s*<i class="fa-solid fa-paw"/);
        expect(read('../public/scripts/neconyan-conversation/constants.js')).toContain('send: \'sb_conversation_send\',');

        expect(read('../public/script.js')).toContain('import \'./scripts/neconyan-send-nya.js\';');
        expect(sendNya.SEND_NYA_SELECTOR).toBe('#send_but, #sb_conversation_send');
    });

    test('a press released on the button pops one cat sound above the button', () => {
        press(sendButton, { x: 111, y: 222 });
        expect(appended).toHaveLength(1);
        const [pop] = appended;
        expect(['nya!', 'mrrp?', 'mrrah', 'mew', 'purr']).toContain(pop.textContent);
        expect(pop.className).toBe('neconyan-send-nya');
        expect(pop.attributes['aria-hidden']).toBe('true');
        expect(pop.style).toMatchObject({
            ...ABOVE_PAW,
            pointerEvents: 'none',
            opacity: '1',
            transform: 'translateX(50%) translateY(0) scale(0.6)',
        });
        expect(sendRow.style).toMatchObject({ position: 'relative' });
        paint();
        expect(pop.options.duration).toBe(900);
    });

    test('an already positioned row keeps its own positioning', () => {
        sendRow.style = {};
        sendRow.computed.position = 'absolute';
        try {
            expect(sendNya.popNya(sendButton).style).toMatchObject(ABOVE_PAW);
            expect(sendRow.style.position).toBeUndefined();
        } finally {
            sendRow.computed.position = 'static';
        }
    });

    test('the sound escapes the inner controls layer through the outer composer', () => {
        const outer = { ...sendRow, append: jest.fn() };
        const anchor = {
            ...sendButton,
            closest: selector => selector === '#form_sheld, #sb_conversation_stage' ? outer : null,
        };
        const pop = sendNya.popNya(anchor);
        expect(outer.append).toHaveBeenCalledWith(pop);
        expect(pop.style).toMatchObject(ABOVE_PAW);
        expect(appended).toHaveLength(0);
    });

    test('the pop asks for its natural size despite the phone sheet', () => {
        // The phone sheets pin every right-rail child to the action square with
        // !important; the pop must outrank that or its text slides sideways.
        const pop = sendNya.popNya(sendButton);
        expect(pop.style).toMatchObject({
            width: 'max-content',
            maxWidth: 'none',
            height: 'auto',
            maxHeight: 'none',
        });
        expect(pop.style.priorities.width).toBe('important');
        expect(pop.style.priorities.maxHeight).toBe('important');
    });

    for (const [index, sound] of ['nya!', 'mrrp?', 'mrrah', 'mew', 'purr'].entries()) {
        test(`random selection can produce ${sound}`, () => {
            expect(sendNya.popNya(sendButton, { random: () => (index + 0.5) / 5 }).textContent).toBe(sound);
        });
    }

    test('busy message preparation cannot expire a pop before its first paint', () => {
        const pop = sendNya.popNya(sendButton);
        jest.advanceTimersByTime(2000);
        expect(pop.removed).toBe(false);
        expect(pop.animate).not.toHaveBeenCalled();
        paint();
        expect(pop.animate).toHaveBeenCalledTimes(1);
        expect(pop.removed).toBe(false);
        jest.advanceTimersByTime(1200);
        expect(pop.removed).toBe(true);
    });

    test('cancelling the float removes the pop and releases its slot only once', () => {
        const pop = sendNya.popNya(sendButton);
        paint();
        pop.animation().cancel();
        expect(pop.removed).toBe(true);
        jest.advanceTimersByTime(1200);
        appended.length = 0;
        for (let i = 0; i < 9; i++) sendNya.popNya(sendButton);
        expect(appended).toHaveLength(8);
    });

    test('script clicks, other buttons and presses dragged off the button do not pop', () => {
        press(sendButton, { trusted: false });
        press(elsewhere);
        hitTarget = elsewhere;
        press(sendButton);
        listeners.click({ target: sendButton, isTrusted: false, detail: 0 });
        listeners.click({ target: sendButton, isTrusted: true, detail: 1 });
        expect(appended).toHaveLength(0);
    });

    test('a keyboard press pops above the middle of the button', () => {
        listeners.click({ target: sendButton, isTrusted: true, detail: 0 });
        expect(appended).toHaveLength(1);
        expect(appended[0].style).toMatchObject(ABOVE_PAW);
    });

    test('a cancelled pointer still pops once from the iOS fast-tap touch sequence', () => {
        const touch = { identifier: 7, clientX: 111, clientY: 222 };
        const event = { target: sendButton, isTrusted: true, changedTouches: [touch] };
        listeners.pointerdown({ target: sendButton, isTrusted: true, button: 0, pointerId: 7, pointerType: 'touch' });
        listeners.touchstart(event);
        listeners.pointercancel({ pointerId: 7 });
        listeners.touchend(event);
        expect(appended).toHaveLength(1);
        expect(appended[0].style).toMatchObject(ABOVE_PAW);
    });

    test('touch and pointer events from one tap do not duplicate the pop', () => {
        const event = {
            target: sendButton, isTrusted: true, button: 0, pointerId: 8, pointerType: 'touch',
            clientX: 111, clientY: 222,
            changedTouches: [{ identifier: 8, clientX: 111, clientY: 222 }],
        };
        listeners.pointerdown(event);
        listeners.touchstart(event);
        listeners.pointerup(event);
        listeners.touchend(event);
        listeners.click({ ...event, detail: 1 });
        expect(appended).toHaveLength(1);
    });

    test('a touch pops above the button whatever point of it was tapped', () => {
        // Every input path funnels through the button itself, so the touch point
        // no longer decides where the pop appears.
        const event = {
            target: sendButton, isTrusted: true,
            changedTouches: [{ identifier: 10, clientX: 5, clientY: 900 }],
        };
        listeners.touchstart(event);
        listeners.touchend(event);
        expect(appended).toHaveLength(1);
        expect(appended[0].style).toMatchObject(ABOVE_PAW);
    });

    test('cancelled, dragged-off and untrusted touches do not pop', () => {
        const event = {
            target: sendButton, isTrusted: true,
            changedTouches: [{ identifier: 9, clientX: 111, clientY: 222 }],
        };
        listeners.touchstart(event);
        listeners.touchcancel(event);
        listeners.touchend(event);
        listeners.touchstart(event);
        hitTarget = elsewhere;
        listeners.touchend(event);
        hitTarget = sendButton;
        listeners.touchstart({ ...event, isTrusted: false });
        listeners.touchend(event);
        expect(appended).toHaveLength(0);
    });

    test('reduced motion shows the sound in place and removes it without movement', () => {
        const pop = sendNya.popNya(sendButton, { reduced: true });
        paint();
        expect(pop.animate).not.toHaveBeenCalled();
        expect(pop.style.transform).toBe('translateX(50%)');
        expect(pop.removed).toBe(false);
        jest.advanceTimersByTime(900);
        expect(pop.removed).toBe(true);
    });

    test('rapid presses are capped so the screen never fills with pops', () => {
        for (let i = 0; i < 20; i++) press(sendButton, { pointerId: i });
        expect(appended).toHaveLength(8);
    });
});
