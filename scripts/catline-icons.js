/** Catline: original 24-unit drawings, with plain counterparts for Kittyless. */
const strokeWidth = 2;
const n = v => +(+v).toFixed(2);
const p = d => `<path d="${d}"/>`;
const c = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;
const e = (x, y, rx, ry) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}"/>`;
const r = (x, y, w, h, radius = 2) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}"/>`;
const filled = drawing => `<g fill="currentColor" stroke="none">${drawing}</g>`;
const dots = (...points) => points.map(([x, y]) => `M${x} ${y}h.01`).join('');
const down = (drawing, dy) => `<g transform="translate(0 ${dy})">${drawing}</g>`;

// A round head with two soft ears. Every cat-headed drawing uses this outline.
function catHead(cx, cy, R) {
    const s = R / 8;
    const t = Math.min(1, s * 1.5);
    const X = v => n(cx + v * s);
    const Y = v => n(cy + v * s);
    const tip = `a${n(.7 * t)} ${n(.7 * t)} 0 0 1 ${n(1.1 * t)}`;
    return `M${X(-7)} ${Y(-4)}V${n(cy - 9.1 * s + .6 * t)}${tip} ${n(-.6 * t)}L${X(-2.6)} ${Y(-7.57)}a${R} ${R} 0 0 1 ${n(5.2 * s)} 0L${n(cx + 7 * s - 1.1 * t)} ${Y(-9.1)}${tip} ${n(.6 * t)}V${Y(-4)}a${R} ${R} 0 1 1 ${n(-14 * s)} 0Z`;
}

// A rounded box whose top corners rise into ears.
function earBox(x, y, w, h, radius = 2, ear = 3.4) {
    return `M${x} ${n(y + radius + 1)}V${n(y - 1.8)}a.7.7 0 0 1 1.1-.6L${n(x + ear + 1.1)} ${y}h${n(w - 2 * ear - 2.2)}l${ear}-2.4a.7.7 0 0 1 1.1.6V${n(y + h - radius)}a${radius} ${radius} 0 0 1-${radius} ${radius}H${n(x + radius)}a${radius} ${radius} 0 0 1-${radius}-${radius}Z`;
}

// One small ear standing on a horizontal edge, for cats peeking over things.
const ear = (x, y, w = 3.4, h = 2.9) => `M${x} ${y}l${n(w / 2 - .45)} ${n(.35 - h)}a.5.5 0 0 1 .9 0L${n(x + w)} ${y}`;

function polygon(points) {
    return points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join('') + 'Z';
}
const polar = (cx, cy, radius, degrees) => [cx + radius * Math.cos(degrees * Math.PI / 180), cy + radius * Math.sin(degrees * Math.PI / 180)];

function starPath(cx, cy, outer, inner) {
    return polygon(Array.from({ length: 10 }, (_, i) => polar(cx, cy, i % 2 ? inner : outer, -90 + i * 36)));
}

function gearPath(cx, cy, root, tipRadius, teeth = 8, rotation = 0, earTeeth = []) {
    const points = [];
    for (let i = 0; i < teeth; i++) {
        const a = rotation + i * 360 / teeth;
        const spread = 360 / teeth / 3;
        points.push(polar(cx, cy, root, a - spread));
        if (earTeeth.includes(i)) points.push(polar(cx, cy, tipRadius + 1.7, a));
        else points.push(polar(cx, cy, tipRadius, a - spread / 2), polar(cx, cy, tipRadius, a + spread / 2));
        points.push(polar(cx, cy, root, a + spread));
    }
    return polygon(points);
}

function lifePath(cx, cy, length, width) {
    const points = [];
    for (let k = 0; k < 6; k++) {
        const a = k * 60 - 90;
        const half = Math.atan2(width / 2, length) * 180 / Math.PI;
        const reach = Math.hypot(length, width / 2);
        points.push(polar(cx, cy, reach, a - half), polar(cx, cy, reach, a + half), polar(cx, cy, width, a + 30));
    }
    return polygon(points);
}

// Each entry is [cat drawing, neutral drawing]. Existing fa-* names remain aliases,
// so stored quick replies, extensions and class-based state changes keep working.
export const icons = {};
function add(name, plain, cat = plain) { icons[name] = [cat, plain]; }
function path(name, d, cat = d) { add(name, p(d), p(cat)); }
function variant(name, base, extra) { icons[name] = icons[base].map(d => d + extra); }

// Boxes that start near the top edge shrink slightly so their ears stay on the artboard.
function box(name, x, y, w, h, radius, inner = '', pivot = 21.5) {
    const cat = p(earBox(x, y, w, h, radius)) + inner;
    if (y >= 5.4) return add(name, r(x, y, w, h, radius) + inner, cat);
    const scale = n((pivot - 3.6) / (pivot - y + 2.4));
    add(name, r(x, y, w, h, radius) + inner, `<g transform="translate(${n(12 * (1 - scale))} ${n(pivot * (1 - scale))}) scale(${scale})" stroke-width="${(strokeWidth / scale).toFixed(3)}">${cat}</g>`);
}

const head = catHead(12, 12.8, 8.5);
function badge(name, d = '') {
    add(name, c(12, 12, 9) + (d && p(`M12 12${d}`)), p(head) + (d && p(`M12 13${d}`)));
}
function squareBadge(name, d = '') {
    add(name, r(3, 3, 18, 18, 3) + (d && p(`M12 12${d}`)), p(earBox(3, 5.5, 18, 15.5, 3)) + (d && p(`M12 13.2${d}`)));
}

// Cat, paw and people.
const eyes = y => p(dots([9, y], [15, y]));
const shoulders = cx => `M${cx - 7} 21v-1.5a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4V21`;
const person = cx => [p(catHead(cx, 8, 4.2) + shoulders(cx)), c(cx, 7.5, 4) + p(shoulders(cx))];
const pawShapes = p('M12 10.5c2.6 0 3.3 2.2 4.8 3.6 1.3 1.2 2.7 2.2 2.7 4 0 2.2-1.9 3.4-3.9 3.4-1.4 0-2.4-.6-3.6-.6s-2.2.6-3.6.6c-2 0-3.9-1.2-3.9-3.4 0-1.8 1.4-2.8 2.7-4 1.5-1.4 2.2-3.6 4.8-3.6Z')
    + e(4.5, 10, 2.1, 2.6) + e(9.2, 5.2, 2.1, 2.6) + e(14.8, 5.2, 2.1, 2.6) + e(19.5, 10, 2.1, 2.6);
const plane = 'M21 3 3 10l7.5 3.5L14 21ZM21 3 10.5 13.5';

add('cat', c(12, 7.5, 4) + p(shoulders(12)), p(head) + eyes(11.5) + p('M12 14.2h.01M9.8 16.4q1.1 1.3 2.2 0q1.1 1.3 2.2 0'));
add('paw', p(plane), filled(pawShapes));
add('paper-plane', p(plane), p(plane + 'M8 16.5c-.6 3.6-5 4-5 1.2'));
icons.user = person(12);
for (const [role, mark] of Object.entries({
    plus: 'M19 7.5v6M16 10.5h6',
    check: 'm16 10.5 2 2 4-4.5',
    pen: 'm16.5 14 .5-2.5 4-4a1.06 1.06 0 0 1 1.5 1.5l-4 4Z',
    shield: 'M19 6.5l3 1.2V11c0 2-1.5 3.2-3 3.8-1.5-.6-3-1.8-3-3.8V7.7Z',
})) icons[`user-${role}`] = person(9.5).map(d => d + p(mark));
icons['user-slash'] = person(12).map(d => d + p('m3.5 3.5 17 17'));
icons['user-tie'] = person(12).map(d => d + p('m12 15.5-1.3 3.2 1.3 1.6 1.3-1.6Z'));
add('user-graduate', p('M4 5.5 12 2.5l8 3-8 3ZM20 5.5v4M8 8.2v2.3a4 4 0 0 0 8 0V8.2' + shoulders(12)));
add('user-astronaut', c(12, 8, 5) + p('M9 8h6M9.5 18.5h5' + shoulders(12)), p(catHead(12, 8.6, 5) + 'M9 9h6M9.5 18.5h5' + shoulders(12)));
add('user-secret', p('M3 9.5h18M7 9.5 8.5 4h7L17 9.5M9 13h.01M15 13h.01M9.5 13h5' + shoulders(12)));
const smallGear = p(gearPath(18.5, 9, 2.5, 3.9, 6, 30));
icons['user-gear'] = person(9.5).map(d => d + smallGear);
icons.users = [
    p(catHead(9, 8, 4.2) + shoulders(9) + 'M16.2 6.2 18.9 4.2a.6.6 0 0 1 1 .5V8a4.2 4.2 0 0 1-2.8 4M22 21v-1.5a4 4 0 0 0-3-3.85'),
    c(9, 7.5, 4) + p(shoulders(9) + 'M16 3.6a4 4 0 0 1 0 7.8M22 21v-1.5a4 4 0 0 0-3-3.85'),
];
icons['users-gear'] = person(9.5).map(d => d + smallGear + p('M22 21v-1.5a4 4 0 0 0-3-3.85'));
add('people-arrows',
    c(5, 7, 2.2) + c(19, 7, 2.2) + p('M2 18v-3a3 3 0 0 1 6 0v3M16 18v-3a3 3 0 0 1 6 0v3M10 14.5h4m-2.5-1.5L10 14.5l1.5 1.5m1-3 1.5 1.5-1.5 1.5'),
    p(catHead(5, 7.4, 2.4) + catHead(19, 7.4, 2.4) + 'M2 18v-3a3 3 0 0 1 6 0v3M16 18v-3a3 3 0 0 1 6 0v3M10 14.5h4m-2.5-1.5L10 14.5l1.5 1.5m1-3 1.5 1.5-1.5 1.5'));
const runner = 'M6 11.5 9.5 9l4-.5 2.5 4 3.5 1M13.5 8.5 11 14l3.5 3-1 4.5M11 14l-2 3.5H5';
add('person-running', c(15.5, 4.5, 2) + p(runner), p(catHead(15.5, 5, 2.3) + runner));
add('address-card', r(2.5, 5, 19, 14, 2.5) + c(8.5, 10.8, 2.2) + p('M5 16.5a3.5 3.5 0 0 1 7 0M15 10h3.5M15 14h3.5'),
    r(2.5, 5, 19, 14, 2.5) + p(catHead(8.5, 11, 2.4) + 'M5 16.5a3.5 3.5 0 0 1 7 0M15 10h3.5M15 14h3.5'));
add('id-badge', r(5, 3, 14, 18, 2.5) + c(12, 10.5, 2.5) + p('M10 3v1.5h4V3M8 17.5a4 4 0 0 1 8 0'),
    r(5, 3, 14, 18, 2.5) + p(catHead(12, 11, 2.7) + 'M10 3v1.5h4V3M8 17.5a4 4 0 0 1 8 0'));
add('address-book', r(5, 3, 14, 18, 2.5) + c(12, 10, 2.5) + p('M3 8h2M3 12h2M3 16h2M8.5 17a3.5 3.5 0 0 1 7 0'),
    r(5, 3, 14, 18, 2.5) + p(catHead(12, 10.5, 2.7) + 'M3 8h2M3 12h2M3 16h2M8.5 17a3.5 3.5 0 0 1 7 0'));
add('passport', r(5, 3, 14, 18, 2.5) + c(12, 10, 3.5) + p('M8.5 10h7M9 17h6'),
    r(5, 3, 14, 18, 2.5) + p(catHead(12, 10.6, 3.4) + 'M9 17h6'));

// Speech.
const bubble = 'M21 6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1v3.5l4.5-3.5H19a2 2 0 0 0 2-2Z';
const catBubble = 'M3 9V4.2a.7.7 0 0 1 1.1-.6L7.5 6h9l3.4-2.4a.7.7 0 0 1 1.1.6V15a2 2 0 0 1-2 2h-8.5L6 20.5V17H5a2 2 0 0 1-2-2Z';
path('comment', bubble, catBubble);
add('comment-dots', p(bubble + dots([8, 10.5], [12, 10.5], [16, 10.5])), p(catBubble + dots([8, 11.5], [12, 11.5], [16, 11.5])));
variant('comment-slash', 'comment', p('m3.5 2.5 17 19'));
const backBubble = 'M20 9.6a2 2 0 0 1 1 1.7V17a2 2 0 0 1-2 2h-.5v2.5L15 19h-3.5';
path('comments', 'M15 4H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h.5v3L9 14h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z' + backBubble,
    'M3 7.5V3.7a.7.7 0 0 1 1.1-.6L7 5.5h6l2.9-2.4a.7.7 0 0 1 1.1.6V12a2 2 0 0 1-2 2H9l-3.5 3v-3H5a2 2 0 0 1-2-2Z' + backBubble);

// Navigation and actions. Direction stays the whole silhouette, so these carry no decoration.
path('chevron-down', 'm6 9 6 6 6-6');
path('chevron-up', 'm6 15 6-6 6 6');
path('chevron-left', 'm15 6-6 6 6 6');
path('chevron-right', 'm9 6 6 6-6 6');
path('angles-down', 'm7 6 5 5 5-5M7 13l5 5 5-5');
path('angles-up', 'm7 11 5-5 5 5M7 18l5-5 5 5');
path('angles-left', 'm11 7-5 5 5 5M18 7l-5 5 5 5');
path('angles-right', 'm6 7 5 5-5 5M13 7l5 5-5 5');
path('arrow-left', 'M20 12H4m6-6-6 6 6 6');
path('arrow-right', 'M4 12h16m-6-6 6 6-6 6');
path('arrow-up', 'M12 20V4m-6 6 6-6 6 6');
path('arrow-down', 'M12 4v16m-6-6 6 6 6-6');
path('minus', 'M5 12h14');
path('plus', 'M5 12h14M12 5v14');
path('xmark', 'm6 6 12 12M18 6 6 18');
path('check', 'm4 12.5 5 5L20 6.5');
path('check-double', 'm2 12.5 4.5 4.5L17 6.5M12 16.5l1 1L22 7.5');
path('bars', 'M4 6h16M4 12h16M4 18h16');
path('grip-lines', 'M4 9h16M4 15h16');
add('grip', [6, 12, 18].flatMap(x => [9, 15].map(y => c(x, y, 1))).join(''));
add('grip-vertical', [9, 15].flatMap(x => [6, 12, 18].map(y => c(x, y, 1))).join(''));
add('ellipsis', c(5, 12, 1) + c(12, 12, 1) + c(19, 12, 1));
add('ellipsis-vertical', c(12, 5, 1) + c(12, 12, 1) + c(12, 19, 1));
path('arrow-pointer', 'M4.5 4.5l5.6 14.6 2.4-6.2 6.2-2.4ZM13.5 13.5l5 5');
path('up-down-left-right', 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3');
path('arrows-up-down', 'M8 4v16M4.5 7.5 8 4l3.5 3.5M16 20V4m-3.5 12.5L16 20l3.5-3.5');
path('right-left', 'M20 8H4m3.5-3.5L4 8l3.5 3.5M4 16h16m-3.5-3.5L20 16l-3.5 3.5');
path('arrows-left-right-to-line', 'M3 5v14M21 5v14M7 12h10M10 9l-3 3 3 3m4-6 3 3-3 3');
path('arrow-turn-up', 'M5 20h7a2 2 0 0 0 2-2V4m-5 5 5-5 5 5');
path('reply', 'm9 7-5 5 5 5M4 12h11a5 5 0 0 1 5 5v1');
path('share', 'm15 7 5 5-5 5M20 12H9a5 5 0 0 0-5 5v1');
path('right-from-bracket', 'M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M10 12h11m-4-4 4 4-4 4');
path('arrow-right-to-bracket', 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M3 12h11m-4-4 4 4-4 4');
path('arrow-up-right-from-square', 'M14 4h6v6M20 4l-9 9M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4');
path('upload', 'M12 15V3M7 8l5-5 5 5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3');
path('download', 'M12 3v12m-5-5 5 5 5-5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3');
path('rotate-right', 'M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 3.5v5h-5');
path('rotate-left', 'M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 3.5v5h5');
path('arrows-rotate', 'M4 11a8 8 0 0 1 14-4.3L20 9M20 4v5h-5M20 13a8 8 0 0 1-14 4.3L4 15M4 20v-5h5');
path('repeat', 'm17 3 3 3-3 3M4 11v-1a4 4 0 0 1 4-4h12M7 21l-3-3 3-3m13-2v1a4 4 0 0 1-4 4H4');
path('shuffle', 'M3 7h2.5c6 0 6.5 10 12.5 10h3m-3-3 3 3-3 3M3 17h2.5c2 0 3.3-1.1 4.4-2.6M21 7h-3c-2 0-3.3 1.1-4.4 2.6M18 4l3 3-3 3');
path('maximize', 'M4 9V6a2 2 0 0 1 2-2h3m6 0h3a2 2 0 0 1 2 2v3m0 6v3a2 2 0 0 1-2 2h-3m-6 0H6a2 2 0 0 1-2-2v-3');
path('compress', 'M9 4v3a2 2 0 0 1-2 2H4m16 0h-3a2 2 0 0 1-2-2V4m0 16v-3a2 2 0 0 1 2-2h3M4 15h3a2 2 0 0 1 2 2v3');
path('up-right-and-down-left-from-center', 'M14 4h6v6M20 4l-6.5 6.5M10 20H4v-6m0 6 6.5-6.5');
path('down-left-and-up-right-to-center', 'M20 4l-6 6m0-5v5h5M4 20l6-6m-5 0h5v5');

// Status marks sit inside a round cat head; the plain set keeps the circle.
for (const [name, d] of Object.entries({
    check: 'm-3.6.3 2.4 2.4 4.8-5.2', xmark: 'm-3-3 6 6m0-6-6 6', minus: 'm-3.5 0h7', plus: 'm-3.5 0h7m-3.5-3.5v7',
    question: 'm-2.9-2.6a3 3 0 0 1 5.8 1c0 2-2.9 2.3-2.9 3.6m0 2.5h.01', exclamation: 'm0-4.2v4.7m0 3.5h.01', info: 'm0-.5v4.5m0-8h.01',
    play: 'm-2-3.5 5.5 3.5-5.5 3.5z',
    'chevron-down': 'm-3.5-1.7 3.5 3.5 3.5-3.5', 'chevron-up': 'm-3.5 1.7 3.5-3.5 3.5 3.5',
    'chevron-right': 'm-1.7-3.5 3.5 3.5-3.5 3.5', 'chevron-left': 'm1.7-3.5-3.5 3.5 3.5 3.5',
})) badge(`circle-${name}`, d);
badge('circle');
add('circle-dot', c(12, 12, 9) + c(12, 12, 1.5), p(head) + c(12, 13, 1.5));
add('circle-half-stroke', c(12, 12, 9) + filled(p('M12 6.5a5.5 5.5 0 0 1 0 11Z')), p(head) + filled(p('M12 7.5a5.5 5.5 0 0 1 0 11Z')));
badge('clock', 'm0-4.5v4.5l3 1.8');
badge('compass', 'm3.2-3.2-1.7 4.7-4.7 1.7 1.7-4.7z');
add('ban', c(12, 12, 9) + p('m5.7 5.7 12.6 12.6'), p(head + 'M6 6.8l12 12'));
path('crosshairs', 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM12 2v4M12 18v4M2 12h4M18 12h4M12 12h.01');
path('clock-rotate-left', 'M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 3.5v5h5M12 8v4.5l3 1.5');
squareBadge('square');
squareBadge('square-check', 'm-4 .3 2.7 2.7 5.3-5.7');
squareBadge('square-plus', 'm-4 0h8m-4-4v8');
squareBadge('square-poll-horizontal', 'm-4-3.5h8m-8 3.5h4.5m-4.5 3.5h6.5');
squareBadge('square-poll-vertical', 'm-4 3.5v-3m4 3v-7m4 7v-5');
add('face-smile', c(12, 12, 9) + eyes(11) + p('M8 15q4 4 8 0'), p(head) + eyes(11.5) + p('M8 15q2 4 4 0q2 4 4 0'));
add('face-smile-beam', c(12, 12, 9) + p('M7.5 11q1.5-2 3 0m3 0q1.5-2 3 0M8 15q4 4 8 0'), p(head) + p('M7.5 11.5q1.5-2 3 0m3 0q1.5-2 3 0M8 15q2 4 4 0q2 4 4 0'));
path('question', 'M8.5 8.5a3.5 3.5 0 1 1 5.5 3c-1.2.8-2 1.5-2 3M12 18.5h.01');
path('asterisk', 'M12 4v16M5 8l14 8M5 16l14-8');
path('triangle-exclamation', 'M10.3 4.3 2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0ZM12 9.5v4M12 17h.01');
path('spinner', 'M21 12a9 9 0 1 1-6.2-8.56');

// The solid square stays recognisable, with ears outside its top edge.
add('stop', filled(r(5, 5, 14, 14, 3)), filled(p('M5 10V3.8a.8.8 0 0 1 1.3-.65L10.5 6.5h3l4.2-3.35a.8.8 0 0 1 1.3.65V17.5a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 5 17.5Z')));
icons['circle-stop'] = [...icons.stop];
path('play', 'M7 5v14l12-7Z');
add('pause', r(6, 5, 4, 14, 1.5) + r(14, 5, 4, 14, 1.5));
path('forward', 'M3 6.5v11l8-5.5ZM13 6.5v11l8-5.5Z');
path('forward-fast', 'M3 7v10l6.5-5ZM11 7v10l6.5-5ZM21 6v12');
path('forward-step', 'M5 5.5v13L16 12ZM19 6v12');

// Hearts, stars and things that look back.
const starTail = 'M14.6 16.4c1.5 4.6 7.4 5 7.4.6 0-2.5-3.2-2.7-3.2-.5';
path('star', starPath(12, 12.7, 9.6, 4.3), starPath(10.6, 10.6, 8.4, 3.8) + starTail);
path('heart', 'M12 20.5 4.4 13C2.2 10.8 2.6 7 5 5.4c2.4-1.6 5.4-.7 7 1.8 1.6-2.5 4.6-3.4 7-1.8 2.4 1.6 2.8 5.4.6 7.6Z',
    'M12 20.5 4.4 13.2c-1.3-1.3-1.9-2.9-1.9-4.5V4.2a.7.7 0 0 1 1.1-.6l3.2 2.2c2-.3 4 .6 5.2 2.4 1.2-1.8 3.2-2.7 5.2-2.4l3.2-2.2a.7.7 0 0 1 1.1.6v4.5c0 1.6-.6 3.2-1.9 4.5Z');
variant('heart-pulse', 'heart', p('M3 11.5h4.5l1.5-2.5 3 5.5 1.5-3h7'));
const eyeOutline = 'M2.5 12S6 5.5 12 5.5s9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z';
add('eye', p(eyeOutline) + c(12, 12, 3), p(eyeOutline + 'M12 8.5c1.5 1.4 1.5 5.6 0 7-1.5-1.4-1.5-5.6 0-7Z'));
variant('eye-slash', 'eye', p('m4 4 16 16'));
path('bell', 'M6 9.5a6 6 0 0 1 12 0c0 4 1.2 5.5 2 6.5.4.5 0 1-.5 1h-15c-.5 0-.9-.5-.5-1 .8-1 2-2.5 2-6.5ZM10 20.5a2.2 2.2 0 0 0 4 0',
    'M6 10V5.5a.7.7 0 0 1 1.1-.6L9.8 7a6 6 0 0 1 4.4 0l2.7-2.1a.7.7 0 0 1 1.1.6V10c0 3.6 1.2 5 2 6 .4.5 0 1-.5 1h-15c-.5 0-.9-.5-.5-1 .8-1 2-2.4 2-6ZM10 20.5a2.2 2.2 0 0 0 4 0');
path('flag', 'M5 21V4.5c5-2.5 8 2.5 14 0V14c-6 2.5-9-2.5-14 0');
variant('flag-checkered', 'flag', p(dots([9, 7.5], [13.5, 6.5], [11, 10.5], [16, 10])));

// Documents, folders and reading.
const filePlain = 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM14 3v3.5A1.5 1.5 0 0 0 15.5 8H19';
// One ear up, and the folded corner as the other ear.
const fileCat = 'M5 8.5V3.7a.7.7 0 0 1 1.1-.6l3.4 2.4H14l5 5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2ZM14 5.5V9a1.5 1.5 0 0 0 1.5 1.5H19';
path('file', filePlain, fileCat);
for (const [name, d] of Object.entries({
    lines: 'M9 13.5h6M9 17h6', 'arrow-up': 'M12 18.5v-6m-2.5 2.5 2.5-2.5 2.5 2.5', 'arrow-down': 'M12 12.5v6m-2.5-2.5 2.5 2.5 2.5-2.5',
    import: 'M2 15.5h10m-3-3 3 3-3 3', export: 'M12 15.5h10m-3-3 3 3-3 3', zipper: dots([12, 12.5], [12, 15.5], [12, 18.5]),
    'circle-plus': 'M9 15.5h6m-3-3v6', shield: 'M12 12l3.5 1.2v2.3c0 1.8-1.7 2.9-3.5 3.5-1.8-.6-3.5-1.7-3.5-3.5v-2.3Z',
})) variant(`file-${name}`, 'file', p(d));
const bookBody = top => `M5 19V${top + 2.5}A2.5 2.5 0 0 1 7.5 ${top}H18a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H7.5a2.5 2.5 0 0 1 0-5H19`;
const books = extra => [p(bookBody(5.5) + ear(6.5, 5.5, 3) + ear(14.5, 5.5, 3)) + down(extra, 1.5), p(bookBody(3)) + extra];
icons.book = books('');
icons['book-bookmark'] = books(p('M10.5 4v6.5l2-1.5 2 1.5V4'));
icons['book-medical'] = books(p('M12.5 6.5v6m-3-3h6'));
icons['book-atlas'] = books(c(12.5, 9.5, 3) + p('M9.5 9.5h6'));
path('book-open', 'M12 7.5V20M12 7.5C10.5 5.5 8 5 4 5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1c-4 0-6.5.5-8 2.5',
    'M12 9v11.5M12 9c-1.5-1.5-3-2-5-2L4.1 4.6a.7.7 0 0 0-1.1.6V17a1 1 0 0 0 1 1c4 0 6.5.5 8 2.5 1.5-2 4-2.5 8-2.5a1 1 0 0 0 1-1V5.2a.7.7 0 0 0-1.1-.6L17 7c-2 0-3.5.5-5 2');
const readerBook = 'M12 12v9M12 12c-2-1.5-4.5-2-8-2v8.5c3.5 0 6 .5 8 2.5 2-2 4.5-2.5 8-2.5V10c-3.5 0-6 .5-8 2';
add('book-open-reader', c(12, 5, 2.5) + p(readerBook), p(catHead(12, 5.8, 2.8) + readerBook));
path('bookmark', 'M7 4h10a1 1 0 0 1 1 1v15.5l-6-4-6 4V5a1 1 0 0 1 1-1Z',
    'M6 20.5V4.2a.7.7 0 0 1 1.1-.6L10 5.5h4l2.9-1.9a.7.7 0 0 1 1.1.6V20.5l-6-4Z');
const folderBody = 'M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l1.3 1.7H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z';
// A cat peeks over the back of the folder, level with the tab.
path('folder', folderBody, folderBody + ear(12.6, 7.5, 3.2, 2.8) + ear(16.2, 7.5, 3.2, 2.8));
variant('folder-plus', 'folder', p('M12 11.5v5M9.5 14h5'));
variant('folder-minus', 'folder', p('M9.5 14h5'));
const folderOpen = 'M3 18V7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l1.3 1.7H17a2 2 0 0 1 2 2V11M3 18l2.3-5.6A2 2 0 0 1 7.1 11H20a1.5 1.5 0 0 1 1.4 2l-2 5.6a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2';
path('folder-open', folderOpen, folderOpen + ear(11.4, 7.5, 2.9, 2.7) + ear(14.5, 7.5, 2.9, 2.7));
const miniFolder = (x, y) => `M${x} ${y + 1}a1 1 0 0 1 1-1h1.8l1.2 1.3h3a1 1 0 0 1 1 1v2.7a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1Z`;
path('folder-tree', 'M5 3v14a2 2 0 0 0 2 2h6M5 8.5h8' + miniFolder(13, 5) + miniFolder(13, 15.5));
const board = 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2';
const clipCat = 'M9 7V3a.6.6 0 0 1 1-.5L11.8 4h.4L14 2.5a.6.6 0 0 1 1 .5v4Z';
const clipboards = extra => [p(board + clipCat + extra), p(board + extra) + r(9, 3, 6, 4, 1.5)];
icons['clipboard-list'] = clipboards('M9 12h6M9 16h6');
icons['clipboard-check'] = clipboards('M9 14.5l2 2 4-4.5');
const backSheet = 'M5 15h-.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5';
add('copy', r(9, 9, 12, 12, 2) + p(backSheet), p(earBox(9, 10.5, 12, 10.5, 2, 2.8) + backSheet));
const pasteBoard = 'M8 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h1.5M14 5h2a2 2 0 0 1 2 2v.5';
add('paste', r(8, 3, 6, 4, 1.5) + r(11, 11, 10, 10, 2) + p(pasteBoard), r(11, 11, 10, 10, 2) + p(pasteBoard + 'M8 7V3a.6.6 0 0 1 1-.5L10.8 4h.4L13 2.5a.6.6 0 0 1 1 .5v4Z'));
path('note-sticky', 'M5 3h14a2 2 0 0 1 2 2v9l-7 7H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM14 21v-5a2 2 0 0 1 2-2h5',
    'M3 9V4.2a.7.7 0 0 1 1.1-.6L7.5 6h9l3.4-2.4a.7.7 0 0 1 1.1.6v10.3L14.5 21H6a3 3 0 0 1-3-3ZM14.5 21v-4.5a2 2 0 0 1 2-2H21');
icons['notes-medical'] = [icons['note-sticky'][0] + p('M7.5 12.5h6m-3-3v6'), icons['note-sticky'][1] + p('M7.5 11h6m-3-3v6')];
path('scroll', 'M8 21h11a2 2 0 0 0 2-2v-1.5H10V19a2 2 0 0 1-4 0V5a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2h4M4 3h11a2 2 0 0 1 2 2v12.5M10 8h3.5M10 12h3.5');
path('receipt', 'M5 3v18l2.3-1.5L9.7 21l2.3-1.5 2.3 1.5 2.4-1.5L19 21V3l-2.3 1.5L14.3 3 12 4.5 9.7 3 7.3 4.5ZM9 9h6M9 13h6',
    'M5 21V4.2a.7.7 0 0 1 1.1-.6L9 5.5h6l2.9-1.9a.7.7 0 0 1 1.1.6V21l-2.3-1.5-2.4 1.5-2.3-1.5L9.7 21l-2.4-1.5ZM9 10h6M9 14h6');
path('floppy-disk', 'M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM7 3v5h8V3M7 21v-7h10v7',
    'M3 9V4.2a.7.7 0 0 1 1.1-.6L7.5 6H16l5 4.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM8.5 6v4h6.5V6M7 21v-6h10v6');
const archiveBody = y => `M5 ${y}v${19.5 - y}a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V${y}M10 ${y + 4}h4`;
add('box-archive', r(3, 4, 18, 5, 1.5) + p(archiveBody(9)), p(earBox(3, 6, 18, 4.5, 1.5) + archiveBody(10.5)));
const openBox = 'M4 9.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19V9.5M4 9.5h16M4 9.5 2.5 5.5M20 9.5l1.5-4';
// The classic: ears coming up out of the open box.
path('box-open', openBox + 'M12 9.5v4', openBox + 'M7.5 9.5V5.8a.6.6 0 0 1 1-.5l2.3 2h2.4l2.3-2a.6.6 0 0 1 1 .5v3.7');

// Writing and formatting. Letterforms stay undecorated so they read as text tools.
path('pencil', 'M4 20l1-4.5L16.5 4a2.12 2.12 0 0 1 3 3L8 18.5ZM14.5 6l3 3');
path('pen-to-square', 'M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5M17.5 3.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z');
add('pen-nib', p('M12 3 7 12.5l3.5 6.5h3l3.5-6.5ZM12 3v8M10 21.5h4') + c(12, 12.5, 1.5));
path('feather', 'M20 4c-7 0-12 4-12 10v2.5h2.5C16 16.5 20 11.5 20 4ZM4 20 14 10M8 16.5h5.5');
path('eraser', 'M12.5 20h-6L3 16.5a1.5 1.5 0 0 1 0-2.1L13 4.4a1.5 1.5 0 0 1 2.1 0L20.6 10a1.5 1.5 0 0 1 0 2.1ZM8 9.5l7.5 7.5M12.5 20H21');
path('highlighter', 'm10 13.5 7.5-9a1.5 1.5 0 0 1 2.2-.1l.9.9a1.5 1.5 0 0 1-.1 2.2l-9 7.5ZM10 13.5 8 17l-3.5 3.5h4L10 19l3.5-2M3 21h4');
path('bold', 'M7 5h6a3.5 3.5 0 0 1 0 7H7ZM7 12h7a3.5 3.5 0 0 1 0 7H7Z');
path('italic', 'M10 5h8M6 19h8M14.5 5l-5 14');
path('strikethrough', 'M4 12h16M16.5 7.5C16 5.5 14.3 4.5 12 4.5c-2.5 0-4.5 1.3-4.5 3.5 0 1.5 1 2.5 2.5 3M7.5 16c.3 2.2 2.2 3.5 4.5 3.5 2.6 0 4.5-1.3 4.5-3.5 0-.7-.2-1.3-.6-1.8');
path('font', 'M5 19 12 4.5 19 19M7.5 14h9');
path('heading', 'M6 5v14M18 5v14M6 12h12');
path('text-height', 'M3 6V5h10v1M8 5v14M6 19h4M19 5v14m-2.5-11.5L19 5l2.5 2.5m-5 9L19 19l2.5-2.5');
path('i-cursor', 'M8 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1M8 20h1a3 3 0 0 0 3-3 3 3 0 0 0 3 3h1M12 7v10M10 12h4');
path('align-left', 'M4 6h16M4 10h10M4 14h16M4 18h10');
path('list', 'M9 6h11M9 12h11M9 18h11' + dots([4.5, 6], [4.5, 12], [4.5, 18]));
path('list-ol', 'M10 6h10M10 12h10M10 18h10M4.5 5 6 4v4M4.5 8h3M4.5 14c0-1.3 3-1.3 3 0 0 1-3 2-3 3.5h3');
path('list-check', 'm3 6 1.5 1.5L7 4.5M3 12l1.5 1.5L7 10.5M3 18l1.5 1.5L7 16.5M11 6h9M11 12h9M11 18h9');
path('indent', 'M4 5h16M4 19h16M12 9.5h8M12 14.5h8M4 9l3.5 3L4 15');
path('outdent', 'M4 5h16M4 19h16M12 9.5h8M12 14.5h8M7.5 9 4 12l3.5 3');
path('quote-left', 'M4 14a3 3 0 1 0 3-3H4.5c0-2.5 1.5-4.5 4.5-5M14 14a3 3 0 1 0 3-3h-2.5c0-2.5 1.5-4.5 4.5-5');
path('code', 'm8 7-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14');
path('terminal', 'm5 7 5 5-5 5M12.5 18h7');
path('language', 'M3 6h10M8 4v2M11 6c-.5 4-3 7.5-7.5 9.5M5.5 9.5c1 2.5 3 4.5 6 6M13 20l4-9 4 9M14.3 17h5.4');
add('at', c(12, 12, 3.5) + p('M15.5 8.5V13a2.5 2.5 0 0 0 5 0v-1a8.5 8.5 0 1 0-3.5 6.9'));

// Media, devices and connections.
const speaker = 'M11 5.5 6.5 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.5l4.5 3.5Z';
path('volume-off', speaker);
path('volume-low', speaker + 'M15 9.5a3.5 3.5 0 0 1 0 5');
path('volume-high', speaker + 'M15 9.5a3.5 3.5 0 0 1 0 5M18 6.5a8 8 0 0 1 0 11');
path('volume-xmark', speaker + 'M16 9.5l5 5m0-5-5 5');
const micStand = 'M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9.5 21h5';
add('microphone-lines', r(9, 3, 6, 11, 3) + p(micStand), p('M9 6.5V3.2a.6.6 0 0 1 1-.5L11.6 4h.8L14 2.7a.6.6 0 0 1 1 .5V11a3 3 0 0 1-6 0Z' + micStand));
add('music', c(6.5, 17.5, 2.5) + c(17.5, 15, 2.5) + p('M9 17.5V6l11-2.5V15'));
const cups = 'M4 15v-3a8 8 0 0 1 16 0v3M4 14h1.5A1.5 1.5 0 0 1 7 15.5v3A1.5 1.5 0 0 1 5.5 20H5a1 1 0 0 1-1-1ZM20 14h-1.5a1.5 1.5 0 0 0-1.5 1.5v3a1.5 1.5 0 0 0 1.5 1.5H19a1 1 0 0 0 1-1Z';
// Cat-ear headphones.
path('headphones-simple', cups, cups + 'M5.8 7 5.6 3.5a.6.6 0 0 1 1-.5L9.3 4.5M18.2 7l.2-3.5a.6.6 0 0 0-1-.5L14.7 4.5');
add('camera', p('M5 7h2l1.5-2.5h7L17 7h2a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z') + c(12, 13, 3.5),
    p(earBox(3, 7, 18, 12.5, 2) + 'M17.5 10.5h.01') + c(11.5, 13.5, 3.2));
box('image', 3, 3, 18, 18, 2.5, c(9, 9, 1.8) + p('m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 20'));
const stack = 'M8 3h11a2 2 0 0 1 2 2v11';
add('images', r(3, 7, 14, 14, 2) + c(7.5, 11.5, 1.3) + p(stack + 'M17 17l-2.6-2.6a2 2 0 0 0-2.8 0L5.5 20.5'),
    p(earBox(3, 9.5, 14, 11.5, 2, 2.8) + 'M9.5 4.5H19a2 2 0 0 1 2 2V16m-4 1.5-2.6-2.6a2 2 0 0 0-2.8 0L6 20.5') + c(7.5, 13.5, 1.2));
box('panorama', 2, 5.5, 20, 14, 2.5, p('m2 16 5-5 4.5 4.5 3-3 7.5 7'));
box('film', 3, 3, 18, 18, 2, p('M8 3v18M16 3v18M3 8h5M3 12h18M3 16h5M16 8h5M16 16h5'));
path('clapperboard', 'M4 11h16v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2ZM4 11l-.7-2.7a1 1 0 0 1 .7-1.2l13.5-3.6a1 1 0 0 1 1.2.7L19.5 7 4 11M8.5 6l2.5 3.2M13.5 4.7l2.5 3.2');
add('photo-film', r(3, 8, 13, 13, 2) + c(7.5, 12.5, 1.3) + p('M8 4h11a2 2 0 0 1 2 2v11M12 4v2M16.5 4v2M21 9.5h-2M21 14h-2m-3 4-2.4-2.4a2 2 0 0 0-2.8 0L6 21'),
    p(earBox(3, 10, 13, 11, 2, 2.6) + 'M9.5 4.5H19a2 2 0 0 1 2 2V17M13.5 4.5v2M17.5 4.5v2M21 10h-2M21 14.5h-2m-3 4-2.4-2.4a2 2 0 0 0-2.8 0L6 21') + c(7.5, 14, 1.2));
box('desktop', 3, 4, 18, 12, 2, p('M12 16v4M8 20h8'), 21);
box('mobile-screen', 6, 2.5, 12, 19, 2.5, p('M11 18h2'), 22);
box('laptop-code', 4, 4.5, 16, 11.5, 2, p('M2.5 19.5h19M10 8l-2 2 2 2M14 8l2 2-2 2'), 20.5);
box('keyboard', 2.5, 6, 19, 12, 2, p(dots([6.5, 10], [10, 10], [14, 10], [17.5, 10], [6.5, 14], [17.5, 14]) + 'M10 14h4'));
add('server', r(3, 3.5, 18, 7, 2) + r(3, 13.5, 18, 7, 2) + p(dots([7, 7], [7, 17])), p(earBox(3, 6, 18, 6, 2)) + r(3, 14.5, 18, 6, 2) + p(dots([7, 9], [7, 17.5])));
path('database', 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3');
const chipPins = 'M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3';
add('microchip', r(6, 6, 12, 12, 2) + r(9.5, 9.5, 5, 5, 1) + p('M9 3v3M15 3v3' + chipPins), p(earBox(6, 6, 12, 12, 2, 3) + chipPins) + r(9.5, 9.5, 5, 5, 1));
box('memory', 3, 6, 18, 10, 2, r(6.5, 9, 4, 4, 1) + r(13.5, 9, 4, 4, 1) + p('M7 16v3M12 16v3M17 16v3'));
path('sd-card', 'M8 3h9a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7ZM10 6.5V9M13 6.5V9M16 6.5V9');
path('hard-drive', 'M5.5 5h13l3 8.5V18a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18v-4.5ZM2.5 13.5h19M6.5 16.5h.01M10 16.5h.01');
// Connections: a solid plug with a curled tail, and no inner detail.
add('plug', p('M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0ZM12 18v3'),
    filled(p('M5.5 8.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1V12a5.5 5.5 0 0 1-11 0Z')) + p('M8.5 3v4.5M13.5 3v4.5M11 17.5c0 3.5 10 4.5 10 0 0-3-3.5-3-3.5-.8'));
const smallPlug = 'M4.5 7h10v3.5a5 5 0 0 1-10 0Z';
const prongs = 'M7 3v4M12 3v4';
for (const [name, mark] of Object.entries({ check: 'M14.5 18l2 2 4-4.5', exclamation: 'M18 13.5v4M18 21h.01' })) {
    add(`plug-circle-${name}`, p(smallPlug + prongs + 'M9.5 15.5V19' + mark), filled(p(smallPlug)) + p(prongs + 'M9.5 15.5V19' + mark));
}
path('power-off', 'M12 3v8M7 6.3a8 8 0 1 0 10 0');
const chain = 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4L11.5 6M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.5-1.4';
path('link', chain);
path('link-slash', chain + 'M4 4l16 16');
path('paperclip', 'M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7');
path('cloud-arrow-down', 'M7 17.5a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 10a3.8 3.8 0 0 1-.5 7.5M12 11.5v9m-3-3 3 3 3-3');
box('radio', 3, 8, 18, 12, 2.5, c(8.5, 14, 2.5) + p('M14 12.5h4M14 15.5h4'));
icons.radio[1] += p('M6 8 17 3.5');
path('signal', 'M4 20v-3M9.5 20v-7M15 20V9M20.5 20V4');
path('wave-square', 'M3 16h4.5V8H12v8h4.5V8H21');

// Layout and data.
box('table', 3, 4, 18, 16, 2, p('M3 10h18M9 10v10M15 10v10M3 15h18'), 20.5);
box('table-columns', 3, 4, 18, 16, 2, p('M3 9h18M12 9v11'), 20.5);
box('table-cells-large', 3, 3, 18, 18, 2.5, p('M12 3v18M3 12h18'));
box('window-maximize', 3, 4, 18, 16, 2, p('M3 9h18'), 20.5);
add('window-restore', r(3, 8, 13, 13, 2) + p('M3 12.5h13M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3'));
path('chart-line', 'M4 4v14a2 2 0 0 0 2 2h14M8 15l3.5-4.5 3 2.5L20 6.5');
add('chart-simple', r(4, 12, 4, 8, 1) + r(10, 4, 4, 16, 1) + r(16, 8, 4, 12, 1));
path('pie-chart', 'M13.5 3.5v7h7a7 7 0 0 0-7-7ZM10 6.5A7.5 7.5 0 1 0 17.5 14H10Z');
path('arrow-down-wide-short', 'M6 4v16m-3-3 3 3 3-3M12 6h9M12 12h6.5M12 18h4');
path('arrow-down-a-z', 'M6 4v16m-3-3 3 3 3-3M14 10l3-6.5 3 6.5M15 8h4M14.5 14h5l-5 6h5');
add('arrow-down-9-1', c(17, 6.5, 2.5) + p('M6 4v16m-3-3 3 3 3-3M19.5 6.5V8c0 1.7-1.2 2.5-2.8 2.5M15.5 15l2-1v6M15.5 20h4'));
path('filter', 'M3.5 5h17L14 13v5.5L10 20v-7Z');
path('filter-circle-xmark', 'M3 5h15l-6 7.5V19l-3-1.5v-5ZM16 16l5 5m0-5-5 5');
path('layer-group', 'M12 3.5 3 8l9 4.5L21 8ZM3 12.5 12 17l9-4.5M3 16.5 12 21l9-4.5');
add('object-group', r(4, 4, 10, 10, 1.5) + r(10, 10, 10, 10, 1.5));
add('diagram-project', r(3, 3, 6, 6, 1.5) + r(15, 3, 6, 6, 1.5) + r(9, 15, 6, 6, 1.5) + p('M9 6h6M6 9v1.5a2 2 0 0 0 2 2h2a2 2 0 0 1 2 2V15'));
add('code-branch', c(6, 5, 2.2) + c(6, 19, 2.2) + c(18, 7, 2.2) + p('M6 7.2v9.6M18 9.2c0 4-12 2.5-12 7.6'));
add('code-merge', c(6, 5, 2.2) + c(6, 19, 2.2) + c(18, 14, 2.2) + p('M6 7.2v9.6M6 7.2c0 5 5 6.8 9.8 6.8'));
add('code-compare', c(6, 6, 2.2) + c(18, 18, 2.2) + p('M6 8.2V20M18 15.8V9a2 2 0 0 0-2-2h-3.5m2.5-2.5L12 7l2.5 2.5'));
add('circle-nodes', c(12, 5.5, 2.5) + c(5.5, 18, 2.5) + c(18.5, 18, 2.5) + p('M10.8 7.7 6.7 15.8M13.2 7.7l4.1 8.1M8 18h8'));

// Tools, objects and places.
path('house', 'M4 10.5 12 3.5l8 7V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2ZM9.5 21v-4.5a2.5 2.5 0 0 1 5 0V21');
path('door-open', 'M13 4h4a1 1 0 0 1 1 1v16M3 21h18M6 21V5.8a1 1 0 0 1 .8-1L12 3.5a1 1 0 0 1 1 1V21M9.5 12.5h.01');
path('door-closed', 'M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M3 21h18M14.5 12.5h.01',
    'M6 21V4a.7.7 0 0 1 1.1-.6L10 5.5h4l2.9-2.1A.7.7 0 0 1 18 4v17M3 21h18M14.5 13h.01');
add('key', c(8, 15.5, 4.5) + p('M11.2 12.3 20 3.5M17 6.5 19.5 9M14 9.5l2 2'));
const keyhole = 'M12 15v1.5';
add('lock', r(4, 10.5, 16, 10.5, 2.5) + p('M8 10.5v-3a4 4 0 0 1 8 0v3' + keyhole));
add('lock-open', r(4, 10.5, 16, 10.5, 2.5) + p('M8 10.5v-3a4 4 0 0 1 7.5-2' + keyhole));
path('shield-halved', 'M12 3 5 5.5v6c0 4.5 3 7.5 7 9.5 4-2 7-5 7-9.5v-6ZM12 3v18',
    'M12 5.5 9.5 6 6.1 3.6a.7.7 0 0 0-1.1.6v7.3c0 4.5 3 7.5 7 9.5 4-2 7-5 7-9.5V4.2a.7.7 0 0 0-1.1-.6L14.5 6ZM12 5.5V21');
path('wrench', 'M20.5 7.5 17 11l-4-4 3.5-3.5a5.5 5.5 0 0 0-6.8 7L3.5 16.7a2.65 2.65 0 0 0 3.8 3.8l6.2-6.2a5.5 5.5 0 0 0 7-6.8Z');
path('screwdriver-wrench', 'M3.5 3.5l2.8.7 3 3.8-1.5 1.5-3.8-3ZM9 9l4.5 4.5M13 14.5l1.5-1.5 6 6a2.12 2.12 0 0 1-3 3ZM20.5 6 18 8.5 15.5 6 18 3.5a4 4 0 0 0-5.2 5.2L4.5 17a1.77 1.77 0 0 0 2.5 2.5l3.5-3.5');
add('scissors', c(6, 6.5, 2.5) + c(6, 17.5, 2.5) + p('M8 8.3 20 19M8 15.7 20 5'));
path('paintbrush', 'M18.5 3.5a2.1 2.1 0 0 1 3 3l-8 8-3-3ZM9.5 13.5c-2.5 0-4 1.5-4 3.5 0 1.5-1 2.5-2.5 3 3 1 7.5.5 8.5-3 .3-1.3-.5-3.5-2-3.5Z');
path('broom', 'M12 3v8M8.5 11h7l2 10h-11ZM10 21v-4M14 21v-4');
path('palette', 'M12 3a9 9 0 0 0 0 18c1.5 0 2.5-1 2.5-2.3 0-.6-.3-1.2-.6-1.6-.4-.4-.6-.9-.6-1.5a2.3 2.3 0 0 1 2.3-2.3H18a3 3 0 0 0 3-3c0-4-4-7.3-9-7.3Z' + dots([7.5, 12], [9, 8], [13.5, 7], [17, 10]));
add('swatchbook', r(3, 3, 6.5, 18, 2) + p('M6.25 17h.01M9.5 7 13 3.5a1.5 1.5 0 0 1 2.1 0l3.4 3.4a1.5 1.5 0 0 1 0 2.1L9.5 18M13.5 14.5h6A1.5 1.5 0 0 1 21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H6.25'));
path('fill-drip', 'M9 3.5l10 10-6.5 6.5a2 2 0 0 1-2.8 0L4 14.3a2 2 0 0 1 0-2.8L11.5 4M4 13h14.5M20.5 16.5s-1.5 2-1.5 3.2a1.5 1.5 0 0 0 3 0c0-1.2-1.5-3.2-1.5-3.2Z');
add('toolbox', r(3, 8, 18, 12, 2) + p('M9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8M3 13.5h18M12 12v3'), p(earBox(3, 8, 18, 12, 2) + 'M3 13.5h18M12 12v3'));
path('ruler-combined', 'M4 4h5v11h11v5H4ZM4 8h2M4 12h2M4 16h2M12 20v-2M16 20v-2');
path('thumbtack', 'M9 4h6M10 4v5.5l-3 4V15h10v-1.5l-3-4V4M12 15v6');
path('tags', 'M3 4.5V11l9 9a1.5 1.5 0 0 0 2.1 0l5.4-5.4a1.5 1.5 0 0 0 0-2.1l-9-9H4.5A1.5 1.5 0 0 0 3 4.5ZM7.5 8h.01');
path('puzzle-piece', 'M4 9h4.2a2.6 2.6 0 1 1 4.6 0H17v4.2a2.6 2.6 0 1 1 0 4.6V21H4Z');
const cube = (cx, cy, h) => `M${cx} ${n(cy - h)}l${n(h * .87)} ${n(h / 2)}v${h}l${n(-h * .87)} ${n(h / 2)}${n(-h * .87)} ${n(-h / 2)}v${-h}ZM${n(cx - h * .87)} ${n(cy - h / 2)}l${n(h * .87)} ${n(h / 2)} ${n(h * .87)} ${n(-h / 2)}M${cx} ${cy}v${h}`;
path('cube', 'M12 3 4 7.5v9l8 4.5 8-4.5v-9ZM4 7.5l8 4.5 8-4.5M12 12v9');
path('cubes', cube(12, 6.7, 3.7) + cube(7.2, 15.2, 3.7) + cube(16.8, 15.2, 3.7));
add('shapes', p('M7.5 3.5 11.5 10h-8Z') + r(14, 3.5, 6.5, 6.5, 1.5) + c(7.5, 17, 3.8), p('M7.5 3.5 11.5 10h-8Z' + catHead(7.5, 17.3, 3.7)) + r(14, 3.5, 6.5, 6.5, 1.5));
add('globe', c(12, 12, 9) + p('M3 12h18M12 3c-3 2.5-4 5.5-4 9s1 6.5 4 9c3-2.5 4-5.5 4-9s-1-6.5-4-9Z'),
    p(head + 'M3.5 12.8h17M12 4.3c-2.8 2.4-3.8 5.2-3.8 8.5s1 6.1 3.8 8.5c2.8-2.4 3.8-5.2 3.8-8.5s-1-6.1-3.8-8.5Z'));
path('map', 'M9 4 3.5 6.5v14L9 18l6 2.5 5.5-2.5V4L15 6.5ZM9 4v14M15 6.5v14');
add('location-dot', p('M12 21.5s7-6.5 7-11.5a7 7 0 0 0-14 0c0 5 7 11.5 7 11.5Z') + c(12, 10, 2.5),
    p('M5 10V4.7a.7.7 0 0 1 1.1-.6L9 6.2a7 7 0 0 1 6 0l2.9-2.1a.7.7 0 0 1 1.1.6V10c0 5-7 11.5-7 11.5S5 15 5 10Z') + c(12, 11, 2.5));
path('map-location-dot', 'M12.5 5.3 9 4 3.5 6.5v14L9 18l6 2.5 5.5-2.5v-3.5M9 4v14M15 15.5v5M18 12.5s3.5-3 3.5-5.5a3.5 3.5 0 0 0-7 0c0 2.5 3.5 5.5 3.5 5.5ZM18 7h.01');
add('route', c(6, 18.5, 2.5) + c(18, 6.5, 2.5) + p('M8.5 18.5H16a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h7.5'));
path('signs-post', 'M12 3v2M12 9v3M12 16v5M5 5h12.5L20 7l-2.5 2H5ZM19 12H6.5L4 14l2.5 2H19Z');
path('diamond-turn-right', 'M12 2.5 21.5 12 12 21.5 2.5 12ZM8.5 14.5V12a1 1 0 0 1 1-1h5.5m-2-2.5 2.5 2.5-2.5 2.5');
const calendarDots = dots([8, 14.5], [12, 14.5], [16, 14.5], [8, 17.8], [12, 17.8]);
// The binder rings become ears.
add('calendar-days', r(3, 5, 18, 16, 2.5) + p('M3 10.5h18M8 3v4M16 3v4' + calendarDots), p(earBox(3, 6, 18, 15, 2.5) + 'M3 11h18' + calendarDots));
path('hourglass-half', 'M6 3h12M6 21h12M7 3v3.5c0 2 5 4 5 5.5s-5 3.5-5 5.5V21M17 3v3.5c0 2-5 4-5 5.5s5 3.5 5 5.5V21M9.5 18h5');

// Creative, natural and specialist actions.
path('wand-magic-sparkles', 'M5 21 3 19 15 7l2 2ZM12.5 9.5l2 2M19 3v4M17 5h4M8 3v2M7 4h2M20 13v2M19 14h2');
path('bolt', 'M13 3 5 13.5h6L10 21l9-11h-6.5Z');
path('fire', 'M12 21.5c4 0 7-2.8 7-7 0-3-1.5-5-3-6.5-.5 2-1.5 3-2.5 3.5C14 8 12.5 4.5 9.5 2.5 10 6 5 9 5 14.5c0 4.2 3 7 7 7Z');
path('moon', 'M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z');
path('droplet', 'M12 3S5.5 9.5 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 9.5 12 3 12 3Z');
path('seedling', 'M12 21v-8M12 13c0-4-3-6.5-8-6.5 0 4 3 6.5 8 6.5ZM12 11c0-3.5 2.5-6 7.5-6 0 3.5-2.5 6-7.5 6Z');
path('lightbulb', 'M9 18h6M10 21h4M8.5 14.5C7 13.5 6 11.5 6 9.5a6 6 0 0 1 12 0c0 2-1 4-2.5 5-.4.3-.5.7-.5 1.2V16H9v-.3c0-.5-.1-.9-.5-1.2Z',
    catHead(12, 10.2, 6.6) + 'M9 19.5h6M10.5 22h3');
path('brain', 'M12 5.5v13M12 5.5A3 3 0 0 0 6.5 5a3 3 0 0 0-2 4.5A3.5 3.5 0 0 0 5 15a3.5 3.5 0 0 0 7 3.5M12 5.5A3 3 0 0 1 17.5 5a3 3 0 0 1 2 4.5A3.5 3.5 0 0 1 19 15a3.5 3.5 0 0 1-7 3.5M6.5 12.5c1.5 0 2.5-.8 2.5-2.3M17.5 12c-1.5 0-2.5.9-2.5 2.5');
add('robot', r(4, 8, 16, 12, 3) + p('M12 8V4.5M12 4h.01M9 13v1.5M15 13v1.5M2 13.5v2M22 13.5v2'),
    p(earBox(4, 8, 16, 12, 3) + 'M9 12.5V14M15 12.5V14M10 17h4M2 13.5v2M22 13.5v2'));
const ghostHem = 'l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2L5 21Z';
path('ghost', 'M5 21V10.5a7 7 0 0 1 14 0V21' + ghostHem + dots([9.5, 10.5], [14.5, 10.5]),
    'M5 21V4.2a.7.7 0 0 1 1.1-.6L9.3 6a7 7 0 0 1 5.4 0l3.2-2.4a.7.7 0 0 1 1.1.6V21' + ghostHem + dots([9.5, 11.5], [14.5, 11.5]));
const skullJaw = 'c0 2.5-1 4-2.5 5.5V19a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19v-2.5C5 15 4 13.5 4 11';
add('skull', p('M20 11a8 8 0 0 0-16 0M20 11' + skullJaw + 'M10 20.5V18M14 20.5V18') + c(9, 12, 1.3) + c(15, 12, 1.3),
    p('M4 11V4.7a.7.7 0 0 1 1.1-.6l3.4 2.4a8 8 0 0 1 7 0l3.4-2.4a.7.7 0 0 1 1.1.6V11' + skullJaw + 'M10 20.5V18M14 20.5V18') + c(9, 12, 1.3) + c(15, 12, 1.3));
const bug = 'M8 10a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0ZM9.5 6.5a2.5 2.5 0 0 1 5 0M12 11v8M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2.5M19 19l-3-2.5';
path('bug', bug);
path('bug-slash', bug + 'M3.5 3.5l17 17');
add('rocket', p('M12 15.5 8.5 12c.5-3 2-6 4.5-7.5C15.5 3 18.5 3 20.5 3.5c.5 2 .5 5-1 7.5-1.5 2.5-4.5 4-7.5 4.5ZM8.5 12H5l-1.5 2.5 3.5 1M12 15.5V19l2.5-1.5 1-3.5M5.5 18.5l-2 2') + c(15.5, 8.5, 1.5));
path('hat-wizard', 'M13 3 8 15.5h8.5L13 9l2.5-1.5ZM3 19.5c0-2 3.5-4 9-4s9 2 9 4c0 1-3.5 1.5-9 1.5s-9-.5-9-1.5Z');
path('crown', 'M3.5 7.5 8 12l4-7 4 7 4.5-4.5L19 18.5H5Z');
path('trophy', 'M8 4h8v6a4 4 0 0 1-8 0ZM8 5.5H5.5A1.5 1.5 0 0 0 4 7v.5A3.5 3.5 0 0 0 7.5 11H8M16 5.5h2.5A1.5 1.5 0 0 1 20 7v.5a3.5 3.5 0 0 1-3.5 3.5H16M12 14v6.5M8 20.5h8');
path('ranking-star', 'M3 21v-6h6v6M9 21V11h6v10M15 21v-4h6v4' + starPath(12, 5, 3.4, 1.5));
const pawnBody = 'M10.2 10 8.5 16h7l-1.7-6M6.5 20.5h11M7.5 20.5l1-4.5M16.5 20.5l-1-4.5';
add('chess', c(12, 6.5, 3) + p(pawnBody), p(catHead(12, 7, 3.2) + pawnBody));
box('dice', 3, 3, 18, 18, 3, p(dots([8, 8], [16, 8], [12, 12], [8, 16], [16, 16])));
path('dice-d20', 'M12 2.5 20.5 7.5v9L12 21.5 3.5 16.5v-9ZM12 7.5 7 15.5h10ZM12 2.5v5M7 15.5l-3.5 1M17 15.5l3.5 1');
// Expressions: a chubby happy :3 cat and a sad 3: cat.
add('masks-theater',
    p('M3 4.5h9V10a4.5 4.5 0 0 1-9 0ZM12 12.5V10h9v5.5a4.5 4.5 0 0 1-8.5 2M5.5 10.5q2 2 4 0M14.5 17.5q2-2 4 0' + dots([6, 7.5], [9, 7.5], [15, 13.5], [18, 13.5])),
    p(catHead(7.5, 8.6, 4.6) + catHead(16.5, 16, 4.6))
    + filled(c(6, 8.2, .75) + c(9, 8.2, .75) + c(15, 15.6, .75) + c(18, 15.6, .75))
    + '<path stroke-width="1.5" d="M5.5 10.3q1 1.6 2 0 1 1.6 2 0M14.5 18.6q1-1.6 2 0 1-1.6 2 0"/>');
path('flask', 'M9.5 3h5M10 3v6l-5.5 9.5a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3M7.5 15h9');
path('vial', 'm16 5-10.5 10.5a2.83 2.83 0 0 0 4 4L20 9M14.5 3.5l6 6M9.5 11.5h7');
path('vials', 'M5 3h6M6 3v15.5a2 2 0 0 0 4 0V3M6 11h4M13 3h6M14 3v15.5a2 2 0 0 0 4 0V3M14 13h4');
path('syringe', 'm18 2.5 3.5 3.5M19.5 4.5l-3 3M14 5l5 5M17 8l-9 9-3.5.5.5-3.5 9-9M5 19l-2.5 2.5M10 9.5l2 2M7.5 12l2 2');
add('stethoscope', c(19, 11, 2.5) + p('M6 3H5a1 1 0 0 0-1 1v5a5 5 0 0 0 10 0V4a1 1 0 0 0-1-1h-1M9 14v2a5 5 0 0 0 10 0v-2.5'));
path('star-of-life', lifePath(12, 12, 9, 4));
// A cat's fingerprint is a paw print.
add('fingerprint', p('M5 15.5c.2-1.5 0-2.5 0-4a7 7 0 0 1 14 0c0 2-.1 3.5-.5 5.5M8 17c.2-1.5 0-3.5 0-5.5a4 4 0 0 1 8 0c0 3-.3 6-1.2 8.5M12 11.5c0 3.5-.5 6.5-1.5 9'),
    p('M12 12c2 0 2.6 1.7 3.8 2.8 1 1 2.2 1.8 2.2 3.2 0 1.8-1.5 2.7-3.1 2.7-1.1 0-1.9-.5-2.9-.5s-1.8.5-2.9.5C7.5 20.7 6 19.8 6 18c0-1.4 1.2-2.2 2.2-3.2C9.4 13.7 10 12 12 12Z') + e(4.6, 11.4, 1.1, 1.6) + e(9.2, 6.6, 1.1, 1.6) + e(14.8, 6.6, 1.1, 1.6) + e(19.4, 11.4, 1.1, 1.6));
const hand = 'M8 12.5V6a1.5 1.5 0 0 1 3 0v5M11 10.5v-6a1.5 1.5 0 0 1 3 0v6M14 11V6a1.5 1.5 0 0 1 3 0v8.5c0 4-2.5 7-6.5 7-3 0-4.5-1.5-6-4l-2-3.5a1.5 1.5 0 0 1 2.6-1.5L8 14.5';
path('hand', hand);
path('hand-sparkles', hand + 'M20.5 2.5v3M19 4h3M3.5 4v2M2.5 5h2');
path('hand-pointer', 'M9 13V5a1.5 1.5 0 0 1 3 0v5.5l5 1a2.5 2.5 0 0 1 2 2.5v2c0 3-2.5 5.5-5.5 5.5h-1c-2 0-3.5-.8-4.6-2.5L5 15a1.5 1.5 0 0 1 2.5-1.7L9 15');
path('thumbs-up', 'M7 10.5v10M7 10.5l3.5-7a2.2 2.2 0 0 1 3 2.5l-.8 4h5.3a2 2 0 0 1 2 2.4l-1.3 6.5a2 2 0 0 1-2 1.6H4.5A1.5 1.5 0 0 1 3 19v-7a1.5 1.5 0 0 1 1.5-1.5H7');
path('scale-balanced', 'M12 4v16M8 20h8M5 7h14M6 7l-3 7a3 3 0 0 0 6 0ZM18 7l-3 7a3 3 0 0 0 6 0Z');
path('bullhorn', 'M4 9.5h3.5L18 4.5v15L7.5 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1ZM7.5 14.5l1.5 5.5h3l-1.5-5M21 10v4');
path('envelope-open-text', 'M3 10 12 3.5l9 6.5v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 10l9 6 9-6M9.5 9h5M9.5 12h5');
add('binoculars', c(6.5, 16, 3.5) + c(17.5, 16, 3.5) + p('M4 13 6 5.5h3l1 7M20 13l-2-7.5h-3l-1 7M10 14h4'));
add('bomb', c(10.5, 14, 7) + p('M15.5 9 18 6.5c0-2 1-3 3-3'));
path('recycle', 'M7 19H4.8a1.8 1.8 0 0 1-1.6-2.7L7 9.5M11 19h8.2a1.8 1.8 0 0 0 1.6-2.7L19.5 14M14 16l-3 3 3 3M8.3 13.6 7 9l-4.4 1.2M9.5 5.5l1-1.6a1.8 1.8 0 0 1 3.1 0L17.5 11M13 9.7l4.6 1.2 1.2-4.5');
path('cookie-bite', 'M12 3a9 9 0 1 0 9 9 4 4 0 0 1-4.5-4.5A4 4 0 0 1 12 3Z' + dots([8.5, 9], [8, 15], [12, 12.5], [13.5, 17]));
// Kittyless keeps the drumstick; the cat gets a fish.
add('drumstick-bite', c(4.8, 17.4, 1.3) + c(6.6, 19.2, 1.3) + p('M17 4.6a5.5 5.5 0 1 0 2.4 2.4 2 2 0 0 1-2.4-2.4ZM10.5 13.5 7 17'),
    p('M3 12c2.5-4 7.5-6 12-3l5.5-3.5v13L15 15c-4.5 3-9.5 1-12-3ZM7.5 11.5h.01'));
const miniPaw = (x, y) => `<g transform="translate(${x} ${y}) scale(.46)">${pawShapes}</g>`;
// Footprints become paw prints.
add('shoe-prints', p('M7 3.5c2 0 3 2.5 3 5.5s-1 4.5-3 4.5-2.5-2-2.5-5 .5-5 2.5-5ZM5 16.5h4V18a2 2 0 0 1-4 0ZM17 5.5c2 0 2.5 2 2.5 5s-.5 5-2.5 5-3-1.5-3-4.5 1-5.5 3-5.5ZM15 18h4v.5a2 2 0 0 1-4 0Z'),
    filled(miniPaw(1, .5) + miniPaw(11.5, 11)));
path('plane-slash', 'M12 3c1 0 1.5 1 1.5 2.5v4l7 4.5v2l-7-2v4l2 1.5V21L12 20l-3.5 1v-1.5l2-1.5v-4l-7 2v-2l7-4.5v-4C10.5 4 11 3 12 3ZM3.5 3.5l17 17');
add('truck-arrow-right', c(7, 18, 2) + c(17, 18, 2) + p('M3 6.5A1.5 1.5 0 0 1 4.5 5H13v11.5H3ZM13 9h4l3.5 3.5v4H13M5.5 10.5h5m-2-2 2 2-2 2'));
const can = 'M6 7l.8 12a2 2 0 0 0 2 1.9h6.4a2 2 0 0 0 2-1.9L18 7M4 7h16';
const canHandle = 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2';
// Ears on the lid, and the two slats read as eyes.
const canEars = ear(6.6, 7, 3.6, 3.2) + ear(13.8, 7, 3.6, 3.2);
path('trash-can', can + canHandle + 'M10 11v5.5M14 11v5.5', can + canEars + 'M10 11v5.5M14 11v5.5');
path('trash-arrow-up', can + canHandle + 'M12 17v-6m-2.5 2.5L12 11l2.5 2.5', can + canEars + 'M12 17v-6m-2.5 2.5L12 11l2.5 2.5');
const catPill = 'M2 12V5.2a.7.7 0 0 1 1.1-.6L6.5 7h11l3.4-2.4a.7.7 0 0 1 1.1.6V13a6 6 0 0 1-6 6H8a6 6 0 0 1-6-6Z';
add('toggle-off', r(2, 6, 20, 12, 6) + c(8, 12, 2.5), p(catPill) + c(8, 13, 2.5));
add('toggle-on', r(2, 6, 20, 12, 6) + filled(c(16, 12, 3.5)), p(catPill) + filled(c(16, 13, 3.5)));
add('gear', p(gearPath(12, 12, 6.3, 9, 8)) + c(12, 12, 2.8), p(gearPath(12, 12.6, 6.1, 8.6, 8, 22.5, [5, 6])) + c(12, 12.6, 2.7));
add('sliders', c(15, 6, 2) + c(9, 12, 2) + c(15, 18, 2) + p('M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3'));
add('magnifying-glass', c(10.5, 10.5, 6.5) + p('m15.5 15.5 5 5'), p(catHead(10.5, 11, 6.2) + 'M15.3 15.8l5.2 4.7'));

// Outlined service marks, recognisable letters/silhouettes with the same stroke.
add('github', p(catHead(12, 10.8, 7.2) + 'M9 17.8V21M15 17.8V21M9 19.5c-3 1-4-1.5-6-2') + p(dots([9.5, 10.5], [14.5, 10.5])));
add('discord', p('M8 6.5c2.5-1 5.5-1 8 0L17.5 5c1.5.5 2.5 1 3.5 2 1 3.5 1 7 .5 10.5-1.5 1-3 1.5-4.5 2l-1-2c-2.5.8-5.5.8-8 0l-1 2c-1.5-.5-3-1-4.5-2C2 14 2 10.5 3 7c1-1 2-1.5 3.5-2Z') + c(9, 12.3, 1.2) + c(15, 12.3, 1.2));
add('youtube', r(2.5, 5, 19, 14, 4) + p('M10 9.5v5l4.5-2.5Z'), p(earBox(2.5, 6.5, 19, 13, 4) + 'M10 10.5v5l4.5-2.5Z'));
path('wikipedia-w', 'm3 6 4.5 12L12 8.5 16.5 18 21 6');
const markdownGlyph = p('M5.5 15V9l3 3.5 3-3.5v6M17 9v6m-2.5-2.5L17 15l2.5-2.5');
add('markdown', r(2, 5, 20, 14, 2.5) + markdownGlyph, p(earBox(2, 6.5, 20, 13, 2.5)) + down(markdownGlyph, 1));

export const aliases = {
    'address-card': ['id-card'], 'arrow-left': ['arrow-left-long', 'left-long'], 'arrow-right': ['arrow-right-long'],
    'arrow-up-right-from-square': ['up-right-from-square'], upload: ['arrow-up-from-bracket'],
    'rotate-right': ['redo', 'arrow-rotate-right'], 'rotate-left': ['undo'], 'arrows-rotate': ['sync', 'rotate'],
    repeat: ['retweet'], 'up-down-left-right': ['arrows-alt'], maximize: ['expand'], compress: ['minimize'],
    'chevron-down': ['angle-down', 'caret-down'], 'chevron-up': ['caret-up'], 'chevron-right': ['caret-right'],
    'circle-check': ['check-circle'], 'circle-xmark': ['times-circle'], 'circle-info': ['info-circle'],
    'circle-question': ['question-circle'], 'circle-exclamation': ['exclamation-circle'],
    'triangle-exclamation': ['exclamation-triangle'], 'circle-stop': ['stop-circle'],
    'circle-chevron-right': ['arrow-alt-circle-right'], 'square-check': ['check-square'], 'square-plus': ['plus-square'],
    xmark: ['times', 'close', 'x'], gear: ['cog'], 'magnifying-glass': ['search'],
    'trash-can': ['trash', 'trash-alt'], 'pen-to-square': ['edit', 'file-edit'], pencil: ['pen'],
    feather: ['feather-pointed'], paintbrush: ['brush'], scissors: ['cut'],
    'file-lines': ['file-alt'], 'floppy-disk': ['save'], copy: ['clone'], list: ['list-ul'],
    'wand-magic-sparkles': ['magic-wand-sparkles', 'wand-magic'],
    desktop: ['display'], 'mobile-screen': ['mobile-screen-button'], 'hard-drive': ['hdd'],
    'lock-open': ['unlock'], 'user-gear': ['user-cog'], users: ['user-group', 'people-group'],
    'id-badge': ['image-portrait'], 'table-cells-large': ['table-cells'],
    'calendar-days': ['calendar'], crosshairs: ['location-crosshairs'],
    link: ['chain'], 'link-slash': ['chain-broken'], thumbtack: ['thumb-tack'],
    comment: ['message'], spinner: ['circle-notch'], cubes: ['cubes-stacked'], shapes: ['icons'],
};

export function renderIcon(body) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
}
