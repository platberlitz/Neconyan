import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

function createElement(tag) {
    const listeners = new Map();
    const element = {
        tagName: tag.toUpperCase(),
        style: {},
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
                finish: () => listeners.get('finish')?.(),
            };
        }),
    };
    element.animation = () => ({ finish: () => listeners.get('finish')?.() });
    return element;
}

const listeners = {};
const appended = [];
const pendingFrames = [];
const paint = () => pendingFrames.splice(0).forEach(callback => callback());
const sendButton = {
    id: 'send_but',
    contains: node => node === sendButton,
    closest: selector => (selector.includes('#send_but') ? sendButton : null),
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 40, height: 40 }),
};
const elsewhere = { contains: () => false, closest: () => null };
let hitTarget = sendButton;
let sendNya;

beforeAll(async () => {
    jest.useFakeTimers();
    global.window = { matchMedia: () => ({ matches: false }), requestAnimationFrame: callback => pendingFrames.push(callback) };
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

    test('a press released on the button pops one cat sound at the pointer', () => {
        press(sendButton, { x: 111, y: 222 });
        expect(appended).toHaveLength(1);
        const [pop] = appended;
        expect(['nya!', 'mrrp?', 'mrrah', 'mew', 'purr']).toContain(pop.textContent);
        expect(pop.className).toBe('neconyan-send-nya');
        expect(pop.attributes['aria-hidden']).toBe('true');
        expect(pop.style).toMatchObject({ position: 'fixed', left: '111px', top: '222px', pointerEvents: 'none' });
        paint();
        expect(pop.options.duration).toBe(900);
    });

    for (const [index, sound] of ['nya!', 'mrrp?', 'mrrah', 'mew', 'purr'].entries()) {
        test(`random selection can produce ${sound}`, () => {
            expect(sendNya.popNya(5, 5, { random: () => (index + 0.5) / 5 }).textContent).toBe(sound);
        });
    }

    test('busy message preparation cannot expire a pop before its first paint', () => {
        const pop = sendNya.popNya(5, 5);
        jest.advanceTimersByTime(2000);
        expect(pop.removed).toBe(false);
        expect(pop.animate).not.toHaveBeenCalled();
        paint();
        expect(pop.animate).toHaveBeenCalledTimes(1);
        expect(pop.removed).toBe(false);
        jest.advanceTimersByTime(1200);
        expect(pop.removed).toBe(true);
    });

    test('finishing the animation removes the pop and releases its slot only once', () => {
        const pop = sendNya.popNya(5, 5);
        paint();
        pop.animation().finish();
        expect(pop.removed).toBe(true);
        jest.advanceTimersByTime(1200);
        appended.length = 0;
        for (let i = 0; i < 9; i++) sendNya.popNya(5, 5);
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

    test('a keyboard press pops from the middle of the button', () => {
        listeners.click({ target: sendButton, isTrusted: true, detail: 0 });
        expect(appended).toHaveLength(1);
        expect(appended[0].style).toMatchObject({ left: '120px', top: '220px' });
    });

    test('a cancelled pointer still pops once from the iOS fast-tap touch sequence', () => {
        const touch = { identifier: 7, clientX: 111, clientY: 222 };
        const event = { target: sendButton, isTrusted: true, changedTouches: [touch] };
        listeners.pointerdown({ target: sendButton, isTrusted: true, button: 0, pointerId: 7, pointerType: 'touch' });
        listeners.touchstart(event);
        listeners.pointercancel({ pointerId: 7 });
        listeners.touchend(event);
        expect(appended).toHaveLength(1);
        expect(appended[0].style).toMatchObject({ left: '111px', top: '222px' });
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

    test('reduced motion fades in place without movement', () => {
        const pop = sendNya.popNya(0, 0, { reduced: true });
        paint();
        expect(pop.options.duration).toBe(700);
        expect(pop.frames.every(frame => !('transform' in frame))).toBe(true);
    });

    test('rapid presses are capped so the screen never fills with pops', () => {
        for (let i = 0; i < 20; i++) press(sendButton, { pointerId: i });
        expect(appended).toHaveLength(8);
    });
});
