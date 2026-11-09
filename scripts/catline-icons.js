/** Catline: original 24-unit drawings, with plain counterparts for Kittyless. */
const p = d => `<path d="${d}"/>`;
const c = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;
const r = (x, y, w, h, radius = 2) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}"/>`;
const head = p('M5 9V3l4 3h6l4-3v6c2 2 2 7-1 9-3 2-9 2-12 0-3-2-3-7-1-9Z');
const tinyHead = p('M8 7V3l3 2h2l3-2v4a4 4 0 0 1-8 0Z');
const face = c(8.5, 12, 0.5) + c(15.5, 12, 0.5) + p('m11 15 1 1 1-1');
const bubble = p('M3 11V4l5 3h8l5-3v10a4 4 0 0 1-4 4H9l-5 3v-5a4 4 0 0 1-1-5Z');
const normalBubble = p('M7 4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H9l-5 3v-5a4 4 0 0 1-1-3V8a4 4 0 0 1 4-4Z');
const person = p('M4 21v-2c0-4 3-6 8-6s8 2 8 6v2');
const warning = p('m12 3 10 17H2Z M12 9v5') + c(12, 17, 0.5);
const book = p('M12 6v15M3 5c3-1 6-1 9 1 3-2 6-2 9-1v14c-3-1-6-1-9 2-3-3-6-3-9-2Z');
const tail = p('M17 20c5 3 7-3 4-4');

// Each entry is [cat drawing, neutral drawing]. Existing fa-* names remain aliases,
// so stored quick replies, extensions and class-based state changes keep working.
export const icons = {
    cat: [head + face + p('M2 13h3m14 0h3M2 17l3-1m14 0 3 1'), c(12, 8, 4) + p('M4 21v-2a8 8 0 0 1 16 0v2')],
    paw: [p('M7 15c2-1 2-4 5-4s3 3 5 4c4 4-1 7-5 5-4 2-9-1-5-5Z') + '<ellipse cx="5" cy="9" rx="2" ry="2.5"/><ellipse cx="10" cy="5" rx="2" ry="2.5"/><ellipse cx="16" cy="5.5" rx="2" ry="2.5"/><ellipse cx="20" cy="10" rx="2" ry="2.5"/>', p('m3 11 18-8-8 18-3-8Z M10 13 21 3')],
    'paper-plane': [p('m5 9 17-7-7 18-4-7Z M11 13 22 2M9 17c-1 5-7 5-7 1 0-2 3-2 3 0'), p('m2 10 20-8-8 20-4-8Z M10 14 22 2')],
    comment: [bubble, normalBubble],
    comments: [p('M2 9V3l4 2h8l4-2v10a3 3 0 0 1-3 3H8l-5 3v-5a3 3 0 0 1-1-2Z M21 9v10l1 3-5-2h-5'), p('M5 3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8l-5 3v-5a3 3 0 0 1-1-2V6a3 3 0 0 1 3-3Z M21 9v10l1 3-5-2h-5')],
    user: [tinyHead + person, c(12, 7, 4) + person],
    users: [p('M4 8V4l3 2 3-2v4a3 3 0 0 1-6 0ZM14 8V4l3 2 3-2v4a3 3 0 0 1-6 0ZM1 21v-3c0-6 12-6 12 0v3M15 14c4-1 8 1 8 4v3'), c(7, 7, 3) + c(17, 7, 3) + p('M1 21v-3c0-6 12-6 12 0v3M15 14c4-1 8 1 8 4v3')],
    gear: [p('M7 7 6 2l5 3h2l5-3-1 5 4 2-1 3 1 3-4 2-2 4-3-1-3 1-2-4-4-2 1-3-1-3Z') + c(12, 12, 3), p('m10 2-1 3-3 1-3-1-1 4 3 2v3l-3 2 2 3 3-1 3 2 1 2h3l1-3 3-1 3 1 1-4-3-2v-3l3-2-2-3-3 1-3-2-1-2Z') + c(12, 12, 3)],
    sliders: [p('M5 3v5m0 7v6M12 3v11m0 5v2M19 3v3m0 7v8M2 8l3 2 3-2v4a3 3 0 0 1-6 0Z') + r(9, 14, 6, 4) + r(16, 7, 6, 4), p('M5 3v5m0 7v6M12 3v11m0 5v2M19 3v3m0 7v8') + r(2, 9, 6, 4) + r(9, 14, 6, 4) + r(16, 7, 6, 4)],
    'magnifying-glass': [p('M4 9V2l4 3h4l4-3v7a6 6 0 0 1-12 0Zm11 6 6 6'), c(10, 10, 6) + p('m15 15 6 6')],
    plus: [p('M4 12h16M12 3v16c0 4 8 3 7-1'), p('M4 12h16M12 4v16')],
    xmark: [p('m5 5 13 13c3 3 5-1 3-3M19 5 5 19'), p('m5 5 14 14M19 5 5 19')],
    check: [p('M3 10c-3 0-1 4 2 6l3 3L21 5'), p('m3 12 5 6L21 5')],
    'chevron-down': [p('m5 9 7 7 7-7M5 6V3l3 2m8 0 3-2v3'), p('m5 9 7 7 7-7')],
    'arrow-left': [p('m9 5-7 7 7 7M2 12h15c5 0 6-7 2-7-2 0-2 2-1 3'), p('m9 5-7 7 7 7M2 12h20')],
    'trash-can': [p('M3 7h18M7 7V2l5 3 5-3v5M5 7l1 14h12l1-14M10 11v6m4-6v6'), p('M3 7h18M8 7V3h8v4M5 7l1 14h12l1-14M10 11v6m4-6v6')],
    'pen-to-square': [p('M10 4H3v17h17v-9M16 4l2-2 4 4-2 2M16 4l-9 9-1 5 5-1 9-9M16 4l4 4M3 7V2l4 2'), p('M10 4H3v17h17v-9M16 4l2-2 4 4-2 2M16 4l-9 9-1 5 5-1 9-9M16 4l4 4')],
    folder: [p('M2 9V3l5 3 5-3v4h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9h20'), p('M2 9V5a2 2 0 0 1 2-2h5l3 4h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9h20')],
    'book-open': [p('M12 7v14M3 8V3l5 3 4 1 4-1 5-3v16c-3-1-6-1-9 2-3-3-6-3-9-2Z M6 11l3 1m6 0 3-1'), book + p('M6 10l3 1m6 0 3-1')],
    image: [p('M3 10V3l5 3h8l5-3v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M3 17l5-5 5 5 3-3 5 5') + c(15, 10, 1), r(3, 3, 18, 18) + p('m3 17 5-5 5 5 3-3 5 5') + c(15, 8, 1)],
    lock: [r(4, 10, 16, 12) + p('M7 10V2l5 3 5-3v8M12 15v3'), r(4, 10, 16, 12) + p('M7 10V7a5 5 0 0 1 10 0v3M12 15v3')],
    'circle-info': [head + p('M12 12v4') + c(12, 9, 0.5), c(12, 12, 9) + p('M12 12v4') + c(12, 8, 0.5)],
    'triangle-exclamation': [warning + p('M5 20v-4l4 4m6 0 4-4v4'), warning],
    spinner: [p('M20 11a8 8 0 1 1-8-7M12 4l4-2v6l-4-4'), p('M20 11a8 8 0 1 1-8-7')],
};

function add(name, plain, cat = plain + tail) { icons[name] = [cat, plain]; }
function path(name, d, cat) { add(name, p(d), cat ? p(cat) : undefined); }
function badge(name, symbol, square = false) {
    add(name, (square ? r(3, 3, 18, 18) : c(12, 12, 9)) + symbol, (square ? p('M3 9V3l5 3h8l5-3v18H3Z') : head) + symbol);
}
function variant(name, base, symbol) { icons[name] = icons[base].map(d => d + symbol); }
function turn(name, base, degrees) { icons[name] = icons[base].map(d => `<g transform="rotate(${degrees} 12 12)">${d}</g>`); }
function small(d) { return `<g transform="translate(1 1) scale(.72)">${d}</g>`; }

// Navigation and actions. Direction remains the dominant silhouette.
turn('arrow-right', 'arrow-left', 180);
turn('arrow-down', 'arrow-left', -90);
turn('arrow-up', 'arrow-left', 90);
turn('chevron-up', 'chevron-down', 180);
turn('chevron-left', 'chevron-down', 90);
turn('chevron-right', 'chevron-down', -90);
for (const [direction, d] of Object.entries({ down: 'm7 6 5 5 5-5m-10 7 5 5 5-5', up: 'm7 11 5-5 5 5m-10 7 5-5 5 5', left: 'm11 6-5 6 5 6m7-12-5 6 5 6', right: 'm6 6 5 6-5 6m7-12 5 6-5 6' })) path(`angles-${direction}`, d);
path('minus', 'M4 12h16', 'M4 12h13c6 0 5 7 1 6');
path('bars', 'M3 5h18M3 12h18M3 19h18', 'M3 5h18M3 12h18M3 19h14c5 0 6-5 3-5');
path('grip-lines', 'M4 9h16M4 15h16');
add('grip', [5, 12, 19].flatMap(x => [7, 16].map(y => c(x, y, 1))).join(''));
turn('grip-vertical', 'grip', 90);
add('ellipsis', c(4, 12, 1) + c(12, 12, 1) + c(20, 12, 1));
turn('ellipsis-vertical', 'ellipsis', 90);
path('arrow-pointer', 'm4 3 16 10-8 1-4 7Z');
path('up-down-left-right', 'M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4', 'M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4M3 3v3l3-3');
path('arrows-up-down', 'M8 3v18M4 7l4-4 4 4M16 21V3m-4 14 4 4 4-4');
turn('right-left', 'arrows-up-down', 90);
path('arrows-left-right-to-line', 'M2 5v14M22 5v14M5 12h14M9 8l-4 4 4 4m6-8 4 4-4 4');
path('arrow-turn-up', 'M4 21h8V3m-5 5 5-5 5 5');
path('reply', 'm9 4-7 7 7 6v-5c7 0 11 3 13 8 0-10-4-13-13-13Z', 'm9 4-7 7 7 6v-5c7 0 11 3 13 8 0-10-4-13-13-13Z M16 6V2l4 3');
icons.share = icons.reply.map(d => `<g transform="translate(24 0) scale(-1 1)">${d}</g>`);
path('right-from-bracket', 'M10 3H3v18h7M8 12h14m-5-5 5 5-5 5', 'M10 3H3v18h7M8 12h14m-5-5 5 5-5 5M3 6l4-3 3 3');
turn('arrow-right-to-bracket', 'right-from-bracket', 180);
path('arrow-up-right-from-square', 'M14 3h7v7M10 14 21 3M10 4H3v17h17v-7', 'M14 3h7v7M10 14 21 3M10 4H3v17h17v-7M3 7V2l4 2');
path('upload', 'M12 16V2M6 8l6-6 6 6M3 15v6h18v-6', 'M12 16V2M6 8l6-6 6 6M3 15v6h18v-6M3 15l3 2 3-2');
path('download', 'M12 2v14m-6-6 6 6 6-6M3 15v6h18v-6', 'M12 2v14m-6-6 6 6 6-6M3 15v6h18v-6M3 15l3 2 3-2');
path('rotate-right', 'M20 8a9 9 0 1 0 1 9M20 2v6h-6', 'M20 8a9 9 0 1 0 1 9M20 2v6h-6M4 7V2l4 3');
icons['rotate-left'] = icons['rotate-right'].map(d => `<g transform="translate(24 0) scale(-1 1)">${d}</g>`);
path('arrows-rotate', 'M3 10a9 9 0 0 1 16-5l2 3M21 2v6h-6M21 14A9 9 0 0 1 5 19l-2-3M3 22v-6h6', 'M3 10a9 9 0 0 1 16-5l2 3M21 2v6h-6M21 14A9 9 0 0 1 5 19l-2-3M3 22v-6h6M9 4V1l3 2');
path('repeat', 'm17 2 4 4-4 4M3 10V6h18M7 22l-4-4 4-4m14 0v4H3', 'm17 2 4 4-4 4M3 10V6h18M7 22l-4-4 4-4m14 0v4H3M3 6V2l4 3');
path('shuffle', 'M3 5h3c6 0 6 14 12 14h3m-4-4 4 4-4 4M3 19h3c6 0 6-14 12-14h3m-4-4 4 4-4 4', 'M3 5h3c6 0 6 14 12 14h3m-4-4 4 4-4 4M3 19h3c6 0 6-14 12-14h3m-4-4 4 4-4 4M3 5V2l4 2');
path('maximize', 'M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6', 'M3 9V3l3 2 3-2m6 0 3 2 3-2v6M3 15v6h6m6 0h6v-6');
path('compress', 'M9 3v6H3m12-6v6h6M3 15h6v6m6 0v-6h6', 'M9 3v6H3m12-6v6h6M3 15h6v6m6 0v-6h6M3 2l3 2 3-2');
path('up-right-and-down-left-from-center', 'M14 3h7v7M21 3l-7 7M3 14v7h7m-7 0 7-7');
path('down-left-and-up-right-to-center', 'M3 3l7 7m-7 0h7V3m11 18-7-7m7 0h-7v7');

// Status symbols retain a clear centre and a feline outline.
for (const [name, d] of Object.entries({ check: 'm8 12 3 3 5-6', xmark: 'm9 10 6 6m0-6-6 6', minus: 'M8 12h8', plus: 'M8 12h8m-4-4v8', question: 'M9 10a3 3 0 1 1 5 2l-2 1v1m0 3h.01', exclamation: 'M12 9v4m0 4h.01', play: 'm10 9 6 4-6 4Z', stop: 'M9 10h6v6H9Z', 'chevron-down': 'm8 11 4 4 4-4', 'chevron-up': 'm8 15 4-4 4 4', 'chevron-right': 'm10 9 4 4-4 4', 'chevron-left': 'm14 9-4 4 4 4' })) badge(`circle-${name}`, p(d));
badge('square-check', p('m7 12 3 3 7-7'), true);
badge('square-plus', p('M7 12h10M12 7v10'), true);
badge('circle', '');
badge('circle-dot', c(12, 12, 2));
badge('square', '', true);
badge('circle-half-stroke', p('M12 6v13m3-11v9m3-7v5'));
path('question', 'M7 7a5 5 0 1 1 8 4l-3 2v2M12 20h.01');
path('ban', 'm5 5 14 14');
icons.ban = icons.ban.map((d, i) => (i ? c(12, 12, 9) : head) + d);
path('check-double', 'm2 12 4 4L17 5m-6 11 3 3 9-10', 'M2 10c-3 0 0 4 4 6L17 5m-6 11 3 3 9-10');
path('asterisk', 'M12 3v18M4 7l16 10M4 17 20 7');
path('star', 'm12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z', 'm12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z M6 8V3l4 3');
path('heart', 'M12 21 3 12C-3 4 8-1 12 6c4-7 15-2 9 6Z', 'M12 21 3 12C-3 4 8-1 12 6c4-7 15-2 9 6Z M3 7V2l4 2m10 0 4-2v5');
variant('heart-pulse', 'heart', p('M3 12h5l2-3 3 7 2-4h6'));
badge('clock', p('M12 8v5l4 2'));
variant('clock-rotate-left', 'clock', p('M2 6v5h5'));
badge('face-smile', c(9, 11, .5) + c(15, 11, .5) + p('M8 15q4 4 8 0'));
badge('face-smile-beam', p('M7 11q2-3 4 0m2 0q2-3 4 0M8 15q4 4 8 0'));
add('eye', p('M2 12C7 2 17 2 22 12 17 22 7 22 2 12Z') + c(12, 12, 3), p('M2 12C7 2 17 2 22 12 17 22 7 22 2 12ZM5 8V3l4 3m6 0 4-3v5') + c(12, 12, 3));
variant('eye-slash', 'eye', p('m2 2 20 20'));
path('bell', 'M4 17h16l-2-4V9A6 6 0 0 0 6 9v4Zm5 4h6', 'M4 17h16l-2-4V3l-6 3-6-3v10Zm5 4h6');
path('flag', 'M4 22V3c6-4 10 4 16 0v11c-6 4-10-4-16 0', 'M4 22V3l4 2 4-3 2 3 6-2v11c-6 4-10-4-16 0');
variant('flag-checkered', 'flag', p('M8 5v8m6-8v9M5 8l14 1'));

// Documents, folders and reading.
const file = p('M5 2h9l5 5v15H5ZM14 2v6h5');
const catFile = p('M5 9V2l4 3 5-3 5 5v15H5ZM14 2v6h5');
add('file', file, catFile);
for (const [name, d] of Object.entries({ lines: 'M8 12h8M8 16h8', 'arrow-up': 'M12 19V11m-3 3 3-3 3 3', 'arrow-down': 'M12 11v8m-3-3 3 3 3-3', import: 'M2 14h12m-4-4 4 4-4 4', export: 'M10 14h12m-4-4 4 4-4 4', zipper: 'M12 9v2m0 3v2m0 3v1M10 12h4M10 17h4', 'circle-plus': 'M8 16h8m-4-4v8', shield: 'm12 11 5 2v4l-5 4-5-4v-4Z' })) variant(`file-${name}`, 'file', p(d));
path('book', 'M5 3h15v18H5a2 2 0 0 1 0-4h15M3 19V5a2 2 0 0 1 2-2', 'M5 3h15v18H5a2 2 0 0 1 0-4h15M3 19V3l4 3 4-3');
variant('book-bookmark', 'book', p('M11 3v9l3-2 3 2V3'));
variant('book-medical', 'book', p('M9 10h7m-3.5-3.5v7'));
variant('book-atlas', 'book', c(12, 10, 4) + p('M8 10h8M12 6v8'));
add('book-open-reader', small(icons['book-open'][1]) + c(18, 5, 3) + p('M15 12h7v10'), small(icons['book-open'][0]) + p('M15 5V2l3 2 3-2v3a3 3 0 0 1-6 0ZM15 12h7v10'));
path('bookmark', 'M6 3h12v19l-6-5-6 5Z', 'M6 3l6 3 6-3v19l-6-5-6 5Z');
path('folder-open', 'M2 18V4h7l3 3h8v4M2 21l3-10h18l-3 10Z', 'M2 18V3l5 3 5-3v4h8v4M2 21l3-10h18l-3 10Z');
variant('folder-plus', 'folder', p('M8 15h8m-4-4v8'));
variant('folder-minus', 'folder', p('M8 15h8'));
path('folder-tree', 'M3 3h6v5H3ZM15 9h7v5h-7ZM15 17h7v5h-7ZM6 8v12h9M6 11h9', 'M3 3l3 2 3-2v5H3ZM15 9h7v5h-7ZM15 17h7v5h-7ZM6 8v12h9M6 11h9');
path('clipboard-list', 'M8 3H4v19h16V3h-4M8 2h8v4H8ZM8 11h8M8 16h8', 'M8 3H4v19h16V3h-4M8 2l4 2 4-2v4H8ZM8 11h8M8 16h8');
path('clipboard-check', 'M8 3H4v19h16V3h-4M8 2h8v4H8ZM7 14l3 3 7-7', 'M8 3H4v19h16V3h-4M8 2l4 2 4-2v4H8ZM7 14l3 3 7-7');
path('copy', 'M8 8h13v13H8ZM4 16H2V2h14v2', 'M8 8l4 2 5-2h4v13H8ZM4 16H2V2l4 3 4-3h6v2');
path('paste', 'M9 3H3v18h6M9 2h8v4H9ZM12 10h10v12H12Z', 'M9 3H3v18h6M9 2l4 2 4-2v4H9ZM12 10h10v12H12Z');
path('note-sticky', 'M3 3h18v12l-6 6H3ZM15 21v-6h6', 'M3 3l5 3h8l5-3v12l-6 6H3ZM15 21v-6h6');
variant('notes-medical', 'note-sticky', p('M7 11h7m-3.5-3.5v7'));
path('scroll', 'M5 4h12c4 0 4 5 0 5h-1M5 4c-4 0-4 5 0 5h2V4v15h10V9m0 10c4 0 4-5 0-5h-3', 'M5 4h12c4 0 4 5 0 5h-1M5 4c-4 0-4 5 0 5h2V4v15h10V9m0 10c4 0 4-5 0-5h-3M7 4V1l4 3 3-3v3');
path('receipt', 'M5 2l3 2 4-2 4 2 3-2v20l-3-2-4 2-4-2-3 2ZM8 9h8M8 14h8', 'M5 2l3 3 4-2 4 2 3-3v20l-3-2-4 2-4-2-3 2ZM8 9h8M8 14h8');
path('floppy-disk', 'M3 3h15l3 3v15H3ZM7 3v6h9V3M7 21v-8h10v8', 'M3 3l4 3 4-3h7l3 3v15H3ZM7 3v6h9V3M7 21v-8h10v8');
path('box-archive', 'M2 3h20v5H2ZM4 8v13h16V8M9 12h6', 'M2 3l5 2 5-2 5 2 5-2v5H2ZM4 8v13h16V8M9 12h6');
path('box-open', 'm2 8 5-5 5 4 5-4 5 5-5 4-5-5-5 5ZM4 12v6l8 4 8-4v-6M12 14v8', 'm2 8 5-5 5 4 5-4 5 5-5 4-5-5-5 5ZM4 12v6l8 4 8-4v-6M12 14v8M7 3V1l3 2m4 0 3-2v2');

// Writing and formatting.
path('pencil', 'm15 3 6 6M4 15 16 3a3 3 0 0 1 5 5L9 20l-7 2Z', 'm15 3 6 6M4 15 16 3a3 3 0 0 1 5 5L9 20l-7 2ZM3 18V13l4 2');
path('pen-nib', 'm3 21 5-16 8-3 6 6-3 8ZM3 21l9-9') ;
icons['pen-nib'] = icons['pen-nib'].map(d => d + c(13, 11, 2));
path('feather', 'M3 22 17 8M6 17C-1 8 12 1 21 2c1 9-5 20-15 15Zm5-5h6', 'M3 22 17 8M6 17C-1 8 12 1 21 2c1 9-5 20-15 15Zm5-5h6M8 8V3l4 2');
path('eraser', 'm3 13 10-10 9 9-9 9H7Zm5-5 9 9M13 21h9', 'm3 13 10-10 9 9-9 9H7Zm5-5 9 9M13 21h9M3 13V8l4 2');
path('highlighter', 'm8 3 13 6-6 12-8-4-4 4-3-2 4-4Z M7 17l8 4');
path('bold', 'M6 3h7a5 5 0 0 1 0 10H6Zm0 10h8a4 4 0 0 1 0 8H6Z', 'M6 3h7a5 5 0 0 1 0 10H6Zm0 10h8a4 4 0 0 1 0 8H6ZM6 6V2l4 2');
path('italic', 'M10 3h10M4 21h10M15 3 9 21');
path('strikethrough', 'M18 5c-7-7-15 2-6 6m-6 8c7 7 15-2 6-6M2 12h20');
path('font', 'M3 21 12 2l9 19M7 14h10', 'M3 21 12 2l9 19M7 14h10M8 10V4l4 2');
path('heading', 'M5 3v18M19 3v18M5 12h14', 'M5 3v18M19 3v18M5 12h14M5 3l3 2 3-2');
path('text-height', 'M2 4h12M8 4v16M5 20h6M19 3v18m-3-15 3-3 3 3m-6 12 3 3 3-3', 'M2 4h12M8 4v16M5 20h6M19 3v18m-3-15 3-3 3 3m-6 12 3 3 3-3M2 4V1l3 2');
path('i-cursor', 'M7 3h2l3 2 3-2h2M12 5v14m-5 2h2l3-2 3 2h2');
path('align-left', 'M3 4h18M3 9h12M3 14h18M3 19h12');
path('list', 'M8 5h14M8 12h14M8 19h14M2 5h.01M2 12h.01M2 19h.01', 'M8 5h14M8 12h14M8 19h14M2 5V2l3 2M2 12h.01M2 19h.01');
path('list-ol', 'M9 5h13M9 12h13M9 19h13M2 3h2v4M2 10h3v2l-3 2h3M2 17h3v4H2m0-2h3', 'M9 5h13M9 12h13M9 19h13M2 3h2v4M2 10h3v2l-3 2h3M2 17h3v4H2m0-2h3M9 5V2l3 2');
path('list-check', 'm2 5 2 2 3-4m-5 9 2 2 3-4m-5 9 2 2 3-4M11 5h11M11 12h11M11 19h11', 'm2 5 2 2 3-4m-5 9 2 2 3-4m-5 9 2 2 3-4M11 5h11M11 12h11M11 19h11M11 5V2l3 2');
path('indent', 'M2 3h20M2 21h20M11 8h11M11 16h11M2 8l5 4-5 4');
path('outdent', 'M2 3h20M2 21h20M11 8h11M11 16h11M7 8l-5 4 5 4');
path('quote-left', 'M10 4C4 4 2 8 2 14v5h8v-8H4m18-7c-6 0-8 4-8 10v5h8v-8h-6', 'M10 4C4 4 2 8 2 14v5h8v-8H4m18-7c-6 0-8 4-8 10v5h8v-8h-6M2 11V7l4 2');
path('code', 'm8 5-6 7 6 7m8-14 6 7-6 7M14 2l-4 20', 'm8 5-6 7 6 7m8-14 6 7-6 7M14 2l-4 20M3 6V2l4 2');
path('terminal', 'm4 5 7 7-7 7m9 0h8', 'm4 5 7 7-7 7m9 0h5c5 0 5-5 2-5');
path('language', 'M2 5h12M8 2v3m4 0c0 7-4 10-10 12M4 8c1 4 4 7 8 8M13 22l5-12 5 12m-8-4h6', 'M2 5h12M8 2v3m4 0c0 7-4 10-10 12M4 8c1 4 4 7 8 8M13 22l5-12 5 12m-8-4h6M2 5V2l3 2');
path('at', 'M16 8v7c0 4 6 3 6-3A10 10 0 1 0 17 21M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0', 'M16 8v7c0 4 6 3 6-3A10 10 0 1 0 17 21M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0M5 5V1l4 2');

// Media, devices and connections.
add('play', p('m6 3 16 9-16 9Z'), p('m6 3 16 9-16 9ZM6 3l5-1v4'));
add('pause', p('M6 3h3v18H6ZM15 3h3v18h-3Z'), p('M6 3l3 2v16H6ZM15 5l3-2v18h-3Z'));
badge('stop', '', true);
path('forward', 'm2 4 10 8-10 8Zm10 0 10 8-10 8Z', 'm2 4 10 8-10 8Zm10 0 10 8-10 8ZM2 4V1l4 2');
variant('forward-fast', 'forward', p('M22 3v18'));
variant('forward-step', 'play', p('M22 3v18'));
path('volume-off', 'M3 9h4l6-6v18l-6-6H3Z', 'M3 9h4l6-6v18l-6-6H3ZM7 9V4l4 2');
variant('volume-low', 'volume-off', p('M17 8q5 4 0 8'));
variant('volume-high', 'volume-low', p('M20 4q6 8 0 16'));
variant('volume-xmark', 'volume-off', p('m17 9 5 6m0-6-5 6'));
path('microphone-lines', 'M8 5a4 4 0 0 1 8 0v8a4 4 0 0 1-8 0ZM4 11v2a8 8 0 0 0 16 0v-2M12 21v2M8 7h8M8 11h8', 'M8 5V1l4 3 4-3v12a4 4 0 0 1-8 0ZM4 11v2a8 8 0 0 0 16 0v-2M12 21v2M8 7h8M8 11h8');
path('music', 'M9 18V5l12-3v14M9 9l12-3M9 18c0-4-7-4-7 0s7 4 7 0Zm12-2c0-4-7-4-7 0s7 4 7 0Z', 'M9 18V5l12-3v14M9 9l12-3M9 18c0-4-7-4-7 0s7 4 7 0Zm12-2c0-4-7-4-7 0s7 4 7 0ZM9 5V1l4 3');
path('headphones-simple', 'M3 15v-4a9 9 0 0 1 18 0v4M3 13h4v8H3ZM17 13h4v8h-4Z', 'M3 15V2l5 3q4-2 8 0l5-3v13M3 13h4v8H3ZM17 13h4v8h-4Z');
add('camera', r(2, 6, 20, 15) + c(12, 13, 4) + p('M7 6l2-4h6l2 4'), p('M2 6l5 2 3-6h4l3 6 5-2v15H2Z') + c(12, 13, 4));
add('images', small(icons.image[1]) + p('M7 21h15V7'), small(icons.image[0]) + p('M7 21h15V7'));
path('panorama', 'M2 5q10 4 20 0v15q-10-4-20 0Zm0 12 6-6 5 5 4-3 5 4', 'M2 5l4 3 4-3q6 3 12 0v15q-10-4-20 0Zm0 12 6-6 5 5 4-3 5 4');
path('film', 'M3 3h18v18H3ZM7 3v18M17 3v18M3 8h4m-4 8h4M17 8h4m-4 8h4M7 12h10', 'M3 3l4 2 4-2h10v18H3ZM7 3v18M17 3v18M3 8h4m-4 8h4M17 8h4m-4 8h4M7 12h10');
path('clapperboard', 'm2 7 18-5 2 6-18 5ZM4 13h18v9H4ZM7 6l4 5m2-7 4 5', 'm2 7 18-5 2 6-18 5ZM4 13h18v9H4ZM7 6l4 5m2-7 4 5M2 7V3l4 2');
add('photo-film', small(icons.film[1]) + `<g transform="translate(10 10) scale(.55)">${icons.image[1]}</g>`, small(icons.film[0]) + `<g transform="translate(10 10) scale(.55)">${icons.image[0]}</g>`);
path('desktop', 'M2 3h20v14H2ZM12 17v5M7 22h10', 'M2 3l5 3 5-3 5 3 5-3v14H2ZM12 17v5M7 22h10');
path('mobile-screen', 'M6 2h12v20H6ZM10 5h4M11 19h2', 'M6 2l6 3 6-3v20H6ZM10 5h4M11 19h2');
path('laptop-code', 'M4 3h16v14H4ZM4 17l-3 4h22l-3-4M10 7l-3 3 3 3m4-6 3 3-3 3', 'M4 3l4 2 4-2h8v14H4ZM4 17l-3 4h22l-3-4M10 7l-3 3 3 3m4-6 3 3-3 3');
path('keyboard', 'M2 5h20v15H2ZM5 9h.01M10 9h.01M15 9h.01M19 9h.01M5 13h.01M10 13h.01M15 13h.01M19 13h.01M7 17h10', 'M2 5l4 2 4-2h12v15H2ZM5 9h.01M10 9h.01M15 9h.01M19 9h.01M5 13h.01M10 13h.01M15 13h.01M19 13h.01M7 17h10');
path('server', 'M3 3h18v7H3ZM3 14h18v7H3ZM6 6h.01M6 17h.01M10 6h7m-7 11h7', 'M3 3l4 2 4-2h10v7H3ZM3 14h18v7H3ZM6 6h.01M6 17h.01M10 6h7m-7 11h7');
path('database', 'M3 6c0-5 18-5 18 0s-18 5-18 0Zm0 0v12c0 5 18 5 18 0V6M3 12c0 5 18 5 18 0', 'M3 6c0-5 18-5 18 0s-18 5-18 0Zm0 0v12c0 5 18 5 18 0V6M3 12c0 5 18 5 18 0M6 6V1l4 3');
path('microchip', 'M6 6h12v12H6ZM9 9h6v6H9ZM8 2v4m4-4v4m4-4v4M8 18v4m4-4v4m4-4v4M2 8h4m-4 4h4m-4 4h4m12-8h4m-4 4h4m-4 4h4', 'M6 6l3 2 3-2h6v12H6ZM9 9h6v6H9ZM8 2v4m4-4v4m4-4v4M8 18v4m4-4v4m4-4v4M2 8h4m-4 4h4m-4 4h4m12-8h4m-4 4h4m-4 4h4');
path('memory', 'M2 6h20v12H2ZM5 10h4v4H5ZM15 10h4v4h-4ZM5 18v4m4-4v4m6-4v4m4-4v4', 'M2 6l4 2 4-2h12v12H2ZM5 10h4v4H5ZM15 10h4v4h-4ZM5 18v4m4-4v4m6-4v4m4-4v4');
path('sd-card', 'M8 2h12v20H4V6ZM9 3v5m4-5v5m4-5v5', 'M8 2l4 2 4-2h4v20H4V6ZM9 3v5m4-5v5m4-5v5');
path('hard-drive', 'M5 4h14l3 11v6H2v-6ZM2 15h20M16 18h.01M19 18h.01', 'M5 4l4 2 5-2h5l3 11v6H2v-6ZM2 15h20M16 18h.01M19 18h.01');
path('plug', 'M6 2v6m12-6v6M3 8h18M5 8v6a7 7 0 0 0 14 0V8M12 21v2', 'M6 2v6m12-6v6M3 8h18M5 8l4 3 3-3 3 3 4-3v6a7 7 0 0 1-14 0M12 21v2');
variant('plug-circle-check', 'plug', p('m9 15 2 2 4-4'));
variant('plug-circle-exclamation', 'plug', p('M12 12v3m0 3h.01'));
path('power-off', 'M12 2v10M6 5a9 9 0 1 0 12 0', 'M12 2v10M6 5a9 9 0 1 0 12 0M4 8V2l4 3');
path('link', 'm9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0', 'm9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0M15 4V1l4 2');
variant('link-slash', 'link', p('m2 2 20 20'));
path('paperclip', 'm15 7-7 7a3 3 0 0 0 4 4l8-8a5 5 0 0 0-7-7l-9 9a6 6 0 0 0 9 9l7-7', 'm15 7-7 7a3 3 0 0 0 4 4l8-8a5 5 0 0 0-7-7l-9 9a6 6 0 0 0 9 9l7-7M13 3V1l4 2');
path('cloud-arrow-down', 'M7 17H5C-1 17 0 8 6 8c1-9 14-8 14 1 5 0 5 8 0 8M12 12v10m-4-4 4 4 4-4', 'M7 17H5C-1 17 0 8 6 8V2l5 3 5-3q4 1 4 7c5 0 5 8 0 8M12 12v10m-4-4 4 4 4-4');

// Identity: compact head plus a separate role mark, rather than a generic cat face.
for (const [role, mark] of Object.entries({ plus: p('M15 17h8m-4-4v8'), check: p('m15 17 3 3 5-6'), pen: p('m15 22 1-4 5-5 2 2-5 5Z'), shield: p('m19 12 4 2v5l-4 3-4-3v-5Z'), slash: p('m2 2 20 20'), tie: p('m10 14 2 2 2-2m-2 2-2 5h4Z'), graduate: p('m12 1 10 4-10 4L2 5Zm10 4v6'), astronaut: c(12, 7, 6) + p('M16 17h5v5h-5'), secret: p('M4 7h16M7 7l2-5h6l2 5M8 9h3m2 0h3') })) {
    icons[`user-${role}`] = icons.user.map(d => (['plus', 'check', 'pen', 'shield'].includes(role) ? small(d) : d) + mark);
}
icons['user-gear'] = icons.user.map((d, i) => small(d) + `<g transform="translate(13 13) scale(.43)">${icons.gear[i]}</g>`);
icons['users-gear'] = icons.users.map((d, i) => small(d) + `<g transform="translate(13 13) scale(.43)">${icons.gear[i]}</g>`);
add('address-card', r(2, 4, 20, 16) + c(8, 10, 2) + p('M4 17q4-6 8 0m3-7h4m-4 4h4'), p('M2 4l4 2 4-2h12v16H2ZM6 10V7l2 1 2-1v3a2 2 0 0 1-4 0M4 17q4-6 8 0m3-7h4m-4 4h4'));
path('id-badge', 'M5 3h14v19H5ZM10 3V1h4v2M9 10a3 3 0 1 0 6 0 3 3 0 0 0-6 0M8 19q4-5 8 0', 'M5 3l4 2 3-2h7v19H5ZM10 3V1h4v2M9 10V7l3 2 3-2v3a3 3 0 0 1-6 0M8 19q4-5 8 0');
add('address-book', icons.book[1] + small(icons.user[1]), icons.book[0] + small(icons.user[0]));
path('passport', 'M4 2h16v20H4ZM8 18h8M7 10a5 5 0 1 0 10 0 5 5 0 0 0-10 0M7 10h10M12 5v10', 'M4 2l4 2 4-2h8v20H4ZM8 18h8M7 10a5 5 0 1 0 10 0 5 5 0 0 0-10 0M7 10h10M12 5v10');
path('people-arrows', 'M3 4h.01M21 4h.01M3 8v13M1 12l2-4 3 4m12 0 3-4 2 4M21 8v13M8 10h8m-3-3 3 3-3 3M16 17H8m3-3-3 3 3 3', 'M3 4h.01M21 4h.01M3 8v13M1 12l2-4 3 4m12 0 3-4 2 4M21 8v13M8 10h8m-3-3 3 3-3 3M16 17H8m3-3-3 3 3 3M1 5V1l2 2 2-2v4');
add('person-running', c(16, 4, 2) + p('m4 10 6-3 6 5 5-1M10 7 8 14l6 3-3 5M8 14l-3 5H1'), p('M14 4V1l2 2 2-2v3a2 2 0 0 1-4 0m-10 6 6-3 6 5 5-1M10 7 8 14l6 3-3 5M8 14l-3 5H1'));

// Layout and data.
path('table', 'M2 3h20v18H2ZM2 9h20M9 9v12M16 9v12M2 15h20', 'M2 3l5 2 5-2h10v18H2ZM2 9h20M9 9v12M16 9v12M2 15h20');
path('table-columns', 'M2 3h20v18H2ZM2 8h20M9 8v13M16 8v13', 'M2 3l5 2 5-2h10v18H2ZM2 8h20M9 8v13M16 8v13');
path('table-cells-large', 'M2 2h8v8H2ZM14 2h8v8h-8ZM2 14h8v8H2ZM14 14h8v8h-8Z', 'M2 2l4 2 4-2v8H2ZM14 2h8v8h-8ZM2 14h8v8H2ZM14 14h8v8h-8Z');
path('window-maximize', 'M2 3h20v18H2ZM2 8h20', 'M2 3l5 2 5-2h10v18H2ZM2 8h20');
path('window-restore', 'M2 8h15v14H2ZM7 8V2h15v14h-5M2 12h15', 'M2 8l4 2 4-2h7v14H2ZM7 8V2h15v14h-5M2 12h15');
path('chart-line', 'M3 2v19h19M6 15l5-6 5 3 6-8', 'M3 2v19h19M6 15l5-6 5 3 6-8M3 6l3-3 3 3');
path('chart-simple', 'M3 21V11h4v10Zm7 0V3h4v18Zm7 0V7h4v14Z', 'M3 21V11h4v10Zm7 0V3l2 2 2-2v18Zm7 0V7h4v14Z');
path('pie-chart', 'M13 2v9h9a9 9 0 0 0-9-9ZM9 3a10 10 0 1 0 12 12H9Z', 'M13 2v9h9a9 9 0 0 0-9-9ZM9 3a10 10 0 1 0 12 12H9ZM3 8V2l5 3');
badge('square-poll-horizontal', p('M7 9h10M7 13h6M7 17h8'), true);
badge('square-poll-vertical', p('M7 17v-5m5 5V9m5 8v-7'), true);
path('arrow-down-wide-short', 'M4 3v18m-3-3 3 3 3-3M10 5h12M10 12h8M10 19h4', 'M4 3v18m-3-3 3 3 3-3M10 5h12M10 12h8M10 19h4M10 5V2l4 2');
path('arrow-down-a-z', 'M4 3v18m-3-3 3 3 3-3M12 9l4-7 4 7m-6-3h4M12 13h8l-8 8h8', 'M4 3v18m-3-3 3 3 3-3M12 9l4-7 4 7m-6-3h4M12 13h8l-8 8h8M12 13l2 2 2-2');
path('arrow-down-9-1', 'M4 3v18m-3-3 3 3 3-3M12 4c0-4 8-4 8 0s-8 4-8 0Zm8 0v6h-5M14 15l3-2v8m-3 0h6', 'M4 3v18m-3-3 3 3 3-3M12 4c0-4 8-4 8 0s-8 4-8 0Zm8 0v6h-5M14 15l3-2v8m-3 0h6M12 4V1l3 2');
path('filter', 'M2 3h20l-8 9v8l-4 2V12Z', 'M2 3l5 2 5-2 5 2 5-2-8 9v8l-4 2V12Z');
variant('filter-circle-xmark', 'filter', p('m16 15 6 6m0-6-6 6'));
path('layer-group', 'm12 2 10 5-10 5L2 7Zm-10 10 10 5 10-5M2 17l10 5 10-5', 'm12 2 10 5-10 5L2 7Zm-10 10 10 5 10-5M2 17l10 5 10-5M5 5V1l4 3');
path('object-group', 'M3 3h12v12H3ZM9 9h12v12H9ZM1 1h.01M23 23h.01', 'M3 3l4 2 4-2h4v12H3ZM9 9h12v12H9ZM1 1h.01M23 23h.01');
path('diagram-project', 'M2 2h6v6H2ZM16 2h6v6h-6ZM9 16h6v6H9ZM8 5h8M5 8v4h7v4', 'M2 2l3 2 3-2v6H2ZM16 2h6v6h-6ZM9 16h6v6H9ZM8 5h8M5 8v4h7v4');
add('code-branch', c(5, 4, 2) + c(5, 20, 2) + c(19, 4, 2) + p('M5 6v12M19 6v3c0 6-14 3-14 9'), p('M3 4V1l2 2 2-2v3a2 2 0 0 1-4 0M5 6v12M19 6v3c0 6-14 3-14 9') + c(5, 20, 2) + c(19, 4, 2));
turn('code-merge', 'code-branch', 180);
path('code-compare', 'M5 2v20M19 2v20M5 7h10m-3-3 3 3-3 3M19 17H9m3-3-3 3 3 3', 'M5 2v20M19 2v20M5 7h10m-3-3 3 3-3 3M19 17H9m3-3-3 3 3 3M5 2l3 2 3-2');
add('circle-nodes', c(4, 5, 3) + c(20, 5, 3) + c(12, 20, 3) + p('M7 5h10M5 8l5 9m8-9-4 9'), p('M1 5V1l3 2 3-2v4a3 3 0 0 1-6 0M7 5h10M5 8l5 9m8-9-4 9') + c(20, 5, 3) + c(12, 20, 3));

// Tools, objects and places. Cat cues stay outside the working detail.
path('house', 'm2 11 10-9 10 9M5 8v14h14V8M9 22v-8h6v8', 'm2 11 10-9 10 9M5 8V2l5 2m4 0 5-2v20H5V8M9 22v-8h6v8');
path('door-open', 'M3 22V2h14v20M5 22l12-4V2L5 6ZM12 12h.01M17 22h5');
path('door-closed', 'M4 22V2h16v20M1 22h22M15 12h.01', 'M4 22V2l5 3 5-3h6v20M1 22h22M15 12h.01');
path('key', 'M14 10a6 6 0 1 0-4 4l12 8v-5h-4v-4Z', 'M14 10c2-8-8-12-12-6-4 6 3 13 8 10l12 8v-5h-4v-4ZM2 5V1l4 3') ;
icons.key = icons.key.map(d => d + c(6, 7, 1));
path('lock-open', 'M7 10V7a5 5 0 0 1 9-3M4 10h16v12H4ZM12 15v3', 'M7 10V2l5 3 5-3v4M4 10h16v12H4ZM12 15v3');
path('shield-halved', 'm12 2 9 4v8c0 4-9 8-9 8s-9-4-9-8V6ZM12 2v20', 'm3 3 5 3 4-3 4 3 5-3v11c0 4-9 8-9 8s-9-4-9-8ZM12 3v19');
path('wrench', 'M15 2a7 7 0 0 0-7 9l-7 7 5 5 7-8a7 7 0 0 0 9-8l-5 5-5-5Z', 'M15 2a7 7 0 0 0-7 9l-7 7 5 5 7-8a7 7 0 0 0 9-8l-5 5-5-5ZM1 18v-4l4 1');
path('screwdriver-wrench', 'm2 2 4 1 3 5-1 1 13 12M4 22 1 19l9-9M15 2a5 5 0 0 0 6 7l-4-1-1-4Z', 'm2 2 4 1 3 5-1 1 13 12M4 22 1 19l9-9M15 2a5 5 0 0 0 6 7l-4-1-1-4ZM1 19v-5l4 2');
add('scissors', c(5, 6, 3) + c(5, 18, 3) + p('m7 8 14 13M7 16 21 3'), p('M2 6V2l3 2 3-2v4a3 3 0 0 1-6 0m5 2 14 13M7 16 21 3') + c(5, 18, 3));
path('paintbrush', 'M9 13 18 2c4-3 6 1 3 4l-9 9ZM9 13c-7-3-2 8-7 8 9 3 13-3 10-6', 'M9 13 18 2c4-3 6 1 3 4l-9 9ZM9 13c-7-3-2 8-7 8 9 3 13-3 10-6M6 15v-4l4 2');
path('broom', 'M13 11 21 2M4 13l8-3 4 4-3 8H2Zm3 1-3 7m6-6-2 6', 'M13 11 21 2M4 13l8-3 4 4-3 8H2Zm3 1-3 7m6-6-2 6M4 13V8l4 3');
add('palette', p('M12 2a10 10 0 1 0 0 20c5 0-2-6 3-6h3c8 0 5-14-6-14Z') + c(7, 8, 1) + c(13, 6, 1) + c(18, 10, 1) + c(6, 14, 1), p('M12 2a10 10 0 1 0 0 20c5 0-2-6 3-6h3c8 0 5-14-6-14ZM4 6V1l5 3') + c(7, 8, 1) + c(13, 6, 1) + c(18, 10, 1) + c(6, 14, 1));
path('swatchbook', 'M3 2h6v18a3 3 0 0 1-6 0ZM9 4l5-2 6 16-8 3M9 21h13v-6M3 8h6m-6 6h6', 'M3 2l3 2 3-2v18a3 3 0 0 1-6 0ZM9 4l5-2 6 16-8 3M9 21h13v-6M3 8h6m-6 6h6');
path('fill-drip', 'm3 10 9-8 9 9-9 10-9-9ZM3 10h18M8 2l5 10m9 3-2 4c-2 4 4 4 3 0Z', 'm3 10 9-8 9 9-9 10-9-9ZM3 10h18M8 2l5 10m9 3-2 4c-2 4 4 4 3 0ZM3 10V5l4 2');
path('toolbox', 'M2 8h20v14H2ZM8 8V3h8v5M2 13h20M7 11v5m10-5v5', 'M2 8h20v14H2ZM8 8V2l4 3 4-3v6M2 13h20M7 11v5m10-5v5');
path('ruler-combined', 'M2 2h6v14h14v6H2ZM2 7h3m-3 5h3m-3 5h3m7 2v3m5-3v3', 'M2 2l3 2 3-2v14h14v6H2ZM2 7h3m-3 5h3m-3 5h3m7 2v3m5-3v3');
path('thumbtack', 'M8 2h8l-1 7 4 5H5l4-5ZM12 14v8', 'M8 2l4 3 4-3-1 7 4 5H5l4-5ZM12 14v8');
path('tags', 'M2 3h8l10 10-8 8L2 11ZM6 7h.01M14 3l9 10-5 5', 'M2 3l4 2 4-2 10 10-8 8L2 11ZM6 7h.01M14 3l9 10-5 5');
path('puzzle-piece', 'M3 3h6c-3 6 9 6 6 0h6v6c-6-3-6 9 0 6v6h-6c3-6-9-6-6 0H3v-6c6 3 6-9 0-6Z', 'M3 3h6c-3 6 9 6 6 0h6v6c-6-3-6 9 0 6v6h-6c3-6-9-6-6 0H3v-6c6 3 6-9 0-6ZM3 3V1l3 2');
path('cube', 'm12 2 10 5v10l-10 5-10-5V7Zm0 10v10M2 7l10 5 10-5', 'm12 2 10 5v10l-10 5-10-5V7Zm0 10v10M2 7l10 5 10-5M5 5V1l4 3');
add('cubes', `<g transform="scale(.55)">${icons.cube[1]}</g><g transform="translate(11 11) scale(.55)">${icons.cube[1]}</g>`, `<g transform="scale(.55)">${icons.cube[0]}</g><g transform="translate(11 11) scale(.55)">${icons.cube[0]}</g>`);
add('shapes', p('m6 2 5 8H1ZM14 3h8v7h-8Z') + c(8, 18, 4), p('m6 2 5 8H1ZM14 3l4 2 4-2v7h-8Z') + c(8, 18, 4));
path('globe', 'M2 12a10 10 0 1 0 20 0 10 10 0 0 0-20 0ZM2 12h20M12 2c-6 6-6 14 0 20 6-6 6-14 0-20Z', 'M2 12a10 10 0 1 0 20 0 10 10 0 0 0-20 0ZM2 12h20M12 2c-6 6-6 14 0 20 6-6 6-14 0-20ZM4 6V1l5 3');
path('map', 'm2 5 7-3 6 3 7-3v17l-7 3-6-3-7 3ZM9 2v17M15 5v17', 'm2 5 7-3 6 3 7-3v17l-7 3-6-3-7 3ZM9 2v17M15 5v17M2 5V1l4 2');
add('location-dot', p('M12 22S3 13 3 9a9 9 0 0 1 18 0c0 4-9 13-9 13Z') + c(12, 9, 3), p('M12 22S3 13 3 9V2l5 3h8l5-3v7c0 4-9 13-9 13Z') + c(12, 9, 3));
add('map-location-dot', small(icons.map[1]) + `<g transform="translate(12 10) scale(.55)">${icons['location-dot'][1]}</g>`, small(icons.map[0]) + `<g transform="translate(12 10) scale(.55)">${icons['location-dot'][0]}</g>`);
badge('compass', p('m16 8-3 6-5 2 2-6Z'));
badge('crosshairs', p('M12 1v6m0 10v6M1 12h6m10 0h6'));
path('route', 'M4 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm16 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM4 6v6c0 6 16-6 16 0v6', 'M2 4V1l2 1 2-1v3a2 2 0 0 1-4 0m18 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM4 6v6c0 6 16-6 16 0v6');
path('signs-post', 'M12 2v20M2 4h16l4 4-4 4H2ZM22 13H6l-4 4 4 4h16', 'M12 2v20M2 4l4 2 4-2h8l4 4-4 4H2ZM22 13H6l-4 4 4 4h16');
path('diamond-turn-right', 'm12 1 11 11-11 11L1 12ZM7 16v-6h10m-3-3 3 3-3 3', 'm12 1 11 11-11 11L1 12ZM7 16v-6h10m-3-3 3 3-3 3M5 8V3l4 2');
path('calendar-days', 'M3 5h18v17H3ZM7 2v6m10-6v6M3 11h18M7 15h.01m5 0h.01m5 0h.01M7 19h.01m5 0h.01m5 0h.01', 'M3 5l4 2 5-2h9v17H3ZM7 2v6m10-6v6M3 11h18M7 15h.01m5 0h.01m5 0h.01M7 19h.01m5 0h.01m5 0h.01');
path('hourglass-half', 'M5 2h14M5 22h14M7 2v5l5 5-5 5v5m10-20v5l-5 5 5 5v5M8 18h8', 'M5 2h14M5 22h14M7 2v5l5 5-5 5v5m10-20v5l-5 5 5 5v5M8 18h8M7 2l5 3 5-3');

// Creative, natural and specialist actions.
path('wand-magic-sparkles', 'm2 19 14-14 4 4L6 23Zm10-10 4 4M4 2v6M1 5h6M19 1v4M17 3h4M21 14v6m-3-3h6', 'm2 19 14-14 4 4L6 23Zm10-10 4 4M4 2v6M1 5h6M19 1v4M17 3h4M21 14v6m-3-3h6M2 19v-5l4 2');
path('bolt', 'M14 1 3 14h8l-1 9L21 9h-8Z', 'M14 1 3 14h8l-1 9L21 9h-8ZM5 11V5l4 2');
path('fire', 'M13 2c3 7-6 8-2 12 4-1 5-3 5-6 11 10 2 16-4 15C0 22 0 12 6 8c-1 4 1 5 2 5-2-6 4-6 5-11Z', 'M13 2c3 7-6 8-2 12 4-1 5-3 5-6 11 10 2 16-4 15C0 22 0 12 6 8c-1 4 1 5 2 5-2-6 4-6 5-11ZM4 14V8l4 3');
path('moon', 'M21 15A10 10 0 0 1 9 2a10 10 0 1 0 12 13Z', 'M21 15A10 10 0 0 1 9 2a10 10 0 1 0 12 13ZM4 6V1l4 3');
path('droplet', 'M12 2C10 7 4 10 4 15a8 8 0 0 0 16 0c0-5-6-8-8-13Z', 'M12 2C10 7 4 10 4 15a8 8 0 0 0 16 0c0-5-6-8-8-13ZM4 14V8l4 3');
path('seedling', 'M12 22V12C3 15 1 9 2 3c7-1 12 2 10 9ZM12 16c9 2 11-4 10-10-7-1-12 3-10 10Z', 'M12 22V12C3 15 1 9 2 3c7-1 12 2 10 9ZM12 16c9 2 11-4 10-10-7-1-12 3-10 10ZM2 3l4 2 4-2');
path('lightbulb', 'M8 17c0-3-4-4-4-9a8 8 0 0 1 16 0c0 5-4 6-4 9ZM8 21h8M10 23h4', 'M8 17c0-3-4-4-4-9V1l5 3h6l5-3v7c0 5-4 6-4 9ZM8 21h8M10 23h4');
path('brain', 'M12 4C7-3 2 4 4 8c-7 4-2 10 2 9-2 6 5 7 6 2 1 5 8 4 6-2 4 1 9-5 2-9 2-4-3-11-8-4ZM12 4v15M4 8l4 2m-2 7 2-4m12-5-4 2m2 7-2-4', 'M12 4C7-3 2 4 4 8c-7 4-2 10 2 9-2 6 5 7 6 2 1 5 8 4 6-2 4 1 9-5 2-9 2-4-3-11-8-4ZM12 4v15M4 8l4 2m-2 7 2-4m12-5-4 2m2 7-2-4M4 5V1l4 2');
add('robot', r(3, 6, 18, 16) + c(8, 12, 1) + c(16, 12, 1) + p('M12 6V2M8 18h8'), p('M3 6V2l5 4h8l5-4v20H3ZM12 6V2M8 18h8') + c(8, 12, 1) + c(16, 12, 1));
path('ghost', 'M3 22V11a9 9 0 0 1 18 0v11l-5-3-4 3-4-3ZM8 10h.01M16 10h.01M10 15h4', 'M3 22V2l5 4h8l5-4v20l-5-3-4 3-4-3ZM8 10h.01M16 10h.01M10 15h4');
path('skull', 'M8 21v-4C-3 17 0 2 12 2s15 15 4 15v4ZM10 18v3m4-3v3M12 14h.01', 'M8 21v-4C-3 17 0 2 12 2s15 15 4 15v4ZM10 18v3m4-3v3M12 14h.01M4 6V1l4 3');
icons.skull = icons.skull.map(d => d + c(7, 11, 2) + c(17, 11, 2));
add('bug', p('M6 10h12v6a6 6 0 0 1-12 0ZM8 10V7a4 4 0 0 1 8 0v3M12 10v12M2 9l4 3m-5 4h5m-4 6 4-3m12-7 4-3m-4 7h5m-5 3 4 3'), p('M6 10h12v6a6 6 0 0 1-12 0ZM8 10V2l4 3 4-3v8M12 10v12M2 9l4 3m-5 4h5m-4 6 4-3m12-7 4-3m-4 7h5m-5 3 4 3'));
variant('bug-slash', 'bug', p('m2 2 20 20'));
path('rocket', 'M9 17 7 10c3-5 8-8 15-8 0 7-3 12-8 15ZM7 10H3l-2 6 8 1m5 0 1 6 6-2v-7M6 19l-4 3', 'M9 17 7 10c3-5 8-8 15-8 0 7-3 12-8 15ZM7 10H3l-2 6 8 1m5 0 1 6 6-2v-7M6 19l-4 3M11 6V1l4 3');
icons.rocket = icons.rocket.map(d => d + c(16, 8, 2));
path('hat-wizard', 'm12 2 7 15H5Zm-7 15-4 5h22l-4-5M10 12h4', 'm12 2 7 15H5Zm-7 15-4 5h22l-4-5M10 12h4M5 17v-6l4 3m6 0 4-3v6');
path('crown', 'M3 5l5 5 4-7 4 7 5-5-2 15H5Z', 'M3 5l5 5 4-7 4 7 5-5-2 15H5ZM3 5V1l4 3m10 0 4-3v4');
path('trophy', 'M7 2h10v8a5 5 0 0 1-10 0ZM7 4H2v4c0 4 5 4 5 4m10-8h5v4c0 4-5 4-5 4M12 15v7M7 22h10', 'M7 2l5 3 5-3v8a5 5 0 0 1-10 0ZM7 4H2v4c0 4 5 4 5 4m10-8h5v4c0 4-5 4-5 4M12 15v7M7 22h10');
path('ranking-star', 'M2 22V12h6v10m0 0V8h8v14m0 0v-7h6v7M12 1l1 2 3 1-2 2v2l-2-1-2 1V6L8 4l3-1Z', 'M2 22V12l3 2 3-2v10m0 0V8h8v14m0 0v-7h6v7M12 1l1 2 3 1-2 2v2l-2-1-2 1V6L8 4l3-1Z');
path('chess', 'M7 22h14l-2-5v-6c4-9-8-12-9-8L3 10l4 4 6-4-4 7ZM10 7h.01M9 17h10', 'M7 22h14l-2-5v-6c4-9-8-12-9-8L3 10l4 4 6-4-4 7ZM10 7h.01M9 17h10M10 3V1l3 2');
add('dice', r(2, 2, 20, 20) + c(7, 7, 1) + c(17, 7, 1) + c(12, 12, 1) + c(7, 17, 1) + c(17, 17, 1), p('M2 2l5 3 5-3 5 3 5-3v20H2Z') + c(7, 8, 1) + c(17, 8, 1) + c(12, 13, 1) + c(7, 18, 1) + c(17, 18, 1));
path('dice-d20', 'm12 1 10 6v11l-10 5-10-5V7ZM2 7h20L12 1 5 18h14L12 1M2 18l3 0 7 5 7-5h3', 'm12 1 10 6v11l-10 5-10-5V7ZM2 7h20L12 1 5 18h14L12 1M2 18l3 0 7 5 7-5h3M4 6V1l4 3');
path('masks-theater', 'M2 2q5 4 10 0v9c0 6-10 8-10 0ZM5 7h.01M9 7h.01M5 12q2-2 4 0M14 8q4 3 8 0v9c0 6-10 7-10 0M15 13h.01M19 13h.01M15 17q2 3 4 0', 'M2 2l5 3 5-3v9c0 6-10 8-10 0ZM5 7h.01M9 7h.01M5 12q2-2 4 0M14 8q4 3 8 0v9c0 6-10 7-10 0M15 13h.01M19 13h.01M15 17q2 3 4 0');
path('flask', 'M8 2h8M9 2v7L2 21h20L15 9V2M6 15h12', 'M8 2h8M9 2v7L2 21h20L15 9V2M6 15h12M6 15v-4l4 2');
path('vial', 'm15 2 7 7M17 4 3 18c-4 4 1 9 5 5L22 9M9 12l5 5', 'm15 2 7 7M17 4 3 18c-4 4 1 9 5 5L22 9M9 12l5 5M3 18v-5l4 2');
add('vials', `<g transform="scale(.65)">${icons.vial[1]}</g><g transform="translate(9 7) scale(.65)">${icons.vial[1]}</g>`, `<g transform="scale(.65)">${icons.vial[0]}</g><g transform="translate(9 7) scale(.65)">${icons.vial[0]}</g>`);
path('syringe', 'm15 1 8 8m-6-6-4 4m-3-3 10 10M11 5 2 14l8 8 9-9M2 22l3-3M7 9l3 3m-6 0 3 3', 'm15 1 8 8m-6-6-4 4m-3-3 10 10M11 5 2 14l8 8 9-9M2 22l3-3M7 9l3 3m-6 0 3 3M2 14V9l4 2');
path('stethoscope', 'M3 2v8a5 5 0 0 0 10 0V2M1 2h4m6 0h4M8 15v3a6 6 0 0 0 12 0v-4', 'M3 2v8a5 5 0 0 0 10 0V2M1 2l3 2 3-2m2 0 3 2 3-2M8 15v3a6 6 0 0 0 12 0v-4');
icons.stethoscope = icons.stethoscope.map(d => d + c(20, 11, 3));
path('star-of-life', 'M9 2h6v6l5-3 3 5-5 2 5 3-3 5-5-3v5H9v-5l-5 3-3-5 5-3-5-2 3-5 5 3Z', 'M9 2l3 2 3-2v6l5-3 3 5-5 2 5 3-3 5-5-3v5H9v-5l-5 3-3-5 5-3-5-2 3-5 5 3Z');
path('fingerprint', 'M3 10c0-12 18-12 18 0M7 12c0-9 10-9 10 0 0 6-2 8-4 10M3 14c0 3-1 5-2 6m20-6c0 3-1 6-2 8M12 9v5c0 5-3 6-5 8M7 16l-2 3', 'M3 10c0-12 18-12 18 0M7 12c0-9 10-9 10 0 0 6-2 8-4 10M3 14c0 3-1 5-2 6m20-6c0 3-1 6-2 8M12 9v5c0 5-3 6-5 8M7 16l-2 3M4 6V1l4 3');
path('hand', 'M8 12V4c0-3 4-3 4 0v8m0-8c0-3 4-3 4 0v8m0-5c0-3 4-3 4 0v10c0 8-10 8-13 2l-5-7c-2-3 1-5 3-2l3 3', 'M8 12V4c0-3 4-3 4 0v8m0-8c0-3 4-3 4 0v8m0-5c0-3 4-3 4 0v10c0 8-10 8-13 2l-5-7c-2-3 1-5 3-2l3 3M9 19c5 5 11 4 13 0');
path('hand-pointer', 'M9 14V3c0-3 4-3 4 0v7c5-4 9 1 9 6l-2 6H9l-7-9c-3-4 1-6 4-3Z', 'M9 14V3c0-3 4-3 4 0v7c5-4 9 1 9 6l-2 6H9l-7-9c-3-4 1-6 4-3ZM9 22c-6 0-7-5-4-5');
add('hand-sparkles', small(icons.hand[1]) + p('M19 1v6m-3-3h6M20 12v4m-2-2h4'), small(icons.hand[0]) + p('M19 1v6m-3-3h6M20 12v4m-2-2h4'));
path('thumbs-up', 'M8 10 12 2c5-1 3 6 3 7h6l-2 13H8ZM2 10h6v12H2Z', 'M8 10 12 2c5-1 3 6 3 7h6l-2 13H8ZM2 10l3 2 3-2v12H2Z');
path('scale-balanced', 'M12 2v20M7 22h10M2 7h20M5 7l-4 9h8Zm14 0-4 9h8Z', 'M12 2v20M7 22h10M2 7h20M5 7l-4 9h8Zm14 0-4 9h8ZM2 7V2l4 3m12 0 4-3v5');
path('bullhorn', 'M2 8h7l11-6v18L9 14H2ZM5 14l2 8h5l-3-8M23 8v6', 'M2 8h7l11-6v18L9 14H2ZM5 14l2 8h5l-3-8M23 8v6M2 8V3l4 3');
path('envelope-open-text', 'm2 9 10-7 10 7v13H2Zm0 0 10 8 10-8M6 12V5h12v7M9 9h6', 'm2 9 10-7 10 7v13H2Zm0 0 10 8 10-8M6 12V3l3 3 3-3h6v9M9 9h6');
path('radio', 'M2 8h20v14H2ZM3 8l17-6M13 12h6m-6 4h6M4 15a3 3 0 1 0 6 0 3 3 0 0 0-6 0', 'M2 8l4 2 4-2h12v14H2ZM3 8l17-6M13 12h6m-6 4h6M4 15a3 3 0 1 0 6 0 3 3 0 0 0-6 0');
path('signal', 'M3 21v-4m6 4V12m6 9V7m6 14V2', 'M3 21v-4m6 4V12m6 9V7m6 14V2M3 17l3 2');
path('wave-square', 'M1 17h5V5h6v12h6V5h5', 'M1 17h5V5l3 2 3-2v12h6V5h5');
path('binoculars', 'M2 17 5 4h4l2 13m2 0 2-13h4l3 13M10 10h4', 'M2 17 5 4l2 2 2-2 2 13m2 0 2-13 2 2 2-2 3 13M10 10h4');
icons.binoculars = icons.binoculars.map(d => d + c(6, 17, 4) + c(18, 17, 4));
path('bomb', 'M15 7c8 9-5 21-12 11C-3 10 7 2 15 7Zm0 0 3-3m-1-3 3 3m0-3v3m3 0h-3m3 3-3-3', 'M15 7c8 9-5 21-12 11C-3 10 7 2 15 7Zm0 0 3-3m-1-3 3 3m0-3v3m3 0h-3m3 3-3-3M3 9V3l4 3');
path('recycle', 'm8 6 4-5 5 8m-4-1 4 1 1-4M20 12l3 7H13m3-3-3 3 3 3M9 19H1l5-8m1 4-1-4-4 1', 'm8 6 4-5 5 8m-4-1 4 1 1-4M20 12l3 7H13m3-3-3 3 3 3M9 19H1l5-8m1 4-1-4-4 1M8 6V2l3 2');
path('cookie-bite', 'M13 2c-2 5 1 8 5 7-1 4 1 6 4 5C20 27-1 23 2 11 3 5 7 2 13 2ZM7 9h.01M8 16h.01M15 18h.01', 'M13 2c-2 5 1 8 5 7-1 4 1 6 4 5C20 27-1 23 2 11 3 5 7 2 13 2ZM7 9h.01M8 16h.01M15 18h.01M3 7V2l5 2');
path('drumstick-bite', 'M10 15c-8-8 5-18 7-11-2 4 0 6 5 6 0 7-8 10-12 5Zm0 0-5 5c-5 7-9-4-3-3l5-5', 'M10 15c-8-8 5-18 7-11-2 4 0 6 5 6 0 7-8 10-12 5Zm0 0-5 5c-5 7-9-4-3-3l5-5M9 8V2l4 3');
path('shoe-prints', 'M4 2c5 0 6 13 1 13S-1 2 4 2Zm-2 16h5v4H2ZM17 1c5 0 6 13 1 13s-6-13-1-13Zm-2 16h5v4h-5Z', 'M4 2c5 0 6 13 1 13S-1 2 4 2Zm-2 16h5v4H2ZM17 1c5 0 6 13 1 13s-6-13-1-13Zm-2 16h5v4h-5ZM2 4V1l3 2');
path('plane-slash', 'M12 2v7l9 6v3l-9-3-9 3v-3l9-6M12 15v7m-4 0 4-3 4 3M2 2l20 20', 'M12 2v7l9 6v3l-9-3-9 3v-3l9-6M12 15v7m-4 0 4-3 4 3M2 2l20 20M3 15v-5l4 2');
path('truck-arrow-right', 'M2 3h13v15H2ZM15 9h5l3 5v4h-8M7 9h5m-2-2 2 2-2 2', 'M2 3l4 2 4-2h5v15H2ZM15 9h5l3 5v4h-8M7 9h5m-2-2 2 2-2 2');
icons['truck-arrow-right'] = icons['truck-arrow-right'].map(d => d + c(6, 20, 2) + c(19, 20, 2));
variant('trash-arrow-up', 'trash-can', p('M12 18v-7m-3 3 3-3 3 3'));
add('toggle-off', r(1, 5, 22, 14, 7) + c(8, 12, 4), p('M1 12V4l5 3h10l5-3v8a7 7 0 0 1-7 7H8a7 7 0 0 1-7-7Z') + c(8, 12, 4));
add('toggle-on', r(1, 5, 22, 14, 7) + c(16, 12, 4), p('M1 12V4l5 3h10l5-3v8a7 7 0 0 1-7 7H8a7 7 0 0 1-7-7Z') + c(16, 12, 4));
variant('comment-dots', 'comment', c(7, 12, .5) + c(12, 12, .5) + c(17, 12, .5));
variant('comment-slash', 'comment', p('m2 2 20 20'));

// Outlined service marks, recognisable letters/silhouettes with the same stroke.
add('github', head + face + p('M7 21c-7 1-5-6-7-6M9 23v-4m6 4v-4'), head + face + p('M7 21c-7 1-5-6-7-6M9 23v-4m6 4v-4'));
add('discord', p('M6 5h12l4 14-5 2-2-3H9l-2 3-5-2Z') + c(8, 12, 1) + c(16, 12, 1), p('M6 5V2l4 3h4l4-3v3l4 14-5 2-2-3H9l-2 3-5-2Z') + c(8, 12, 1) + c(16, 12, 1));
add('youtube', r(1, 4, 22, 16, 4) + p('m10 8 6 4-6 4Z'), p('M1 9V3l5 3h12l5-3v13a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4ZM10 8l6 4-6 4Z'));
path('wikipedia-w', 'm1 5 6 15 5-12 5 12 6-15M1 5h5m12 0h5M8 5h8', 'm1 5 6 15 5-12 5 12 6-15M1 5h5m12 0h5M8 5h8M1 5V1l4 3');
path('markdown', 'M1 4h22v16H1ZM4 16V8l4 4 4-4v8M18 8v8m-3-3 3 3 3-3', 'M1 4l4 2 4-2h14v16H1ZM4 16V8l4 4 4-4v8M18 8v8m-3-3 3 3 3-3');

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

// Leave room for the rounded stroke at the edge of the 24-unit artboard.
// These wider silhouettes need a small optical inset, including their plain versions.
for (const name of ['brain', 'cloud-arrow-down', 'drumstick-bite', 'github', 'highlighter', 'lightbulb', 'link', 'link-slash', 'location-dot', 'map-location-dot', 'paperclip', 'stethoscope', 'vial', 'vials', 'wand-magic-sparkles']) {
    icons[name] = icons[name].map(d => `<g transform="translate(2.4 1.8) scale(.83)" stroke-width="2.41">${d}</g>`);
}

export function renderIcon(body) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
}
