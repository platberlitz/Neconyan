// Starlight Conservatory stage: the interactive night sky that belongs to the shell style
// of the same name. Three stacked canvases give the glass depth: a deep starfield with
// nebulae and shooting stars behind the panels, named constellations and accent sparkles in
// front of them, and a starlit wake that follows the pointer above everything else.
//
// The shell imports this module through a dynamic import only while the style is active, so
// every other Shell Style loads none of it. Reduced Motion stops the frame loop and leaves a
// single calm still frame on screen.

const STAGE_ID = 'sb-starlight-conservatory-stage';
const SKY_ID = 'sb-starlight-conservatory-sky';
const OVERLAY_ID = 'sb-starlight-conservatory-overlay';
const TRAIL_ID = 'sb-starlight-conservatory-trail';
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const TRAIL_IDLE_MS = 1400;
const SPARKLE_REFRESH_MS = 2600;

const state = {
    mounted: false,
    rafId: 0,
    observers: [],
    listeners: [],
    palette: null,
    sprites: null,
    sky: null,
    sparkles: [],
    constellations: [],
    trail: [],
    novae: [],
    companion: null,
    layers: null,
    width: 0,
    height: 0,
    elapsed: 0,
    previous: 0,
    lastSparkleRefresh: -Infinity,
    lastPointer: null,
    lastPointerAt: -Infinity,
    lastTrailAt: 0,
    still: false,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (from, to, amount) => from + (to - from) * amount;
const randomBetween = (min, max) => min + Math.random() * (max - min);

function rgba(color, alpha) {
    const r = Math.round(color.r);
    const g = Math.round(color.g);
    const b = Math.round(color.b);
    return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1).toFixed(3)})`;
}

function whiteMix(color, amount) {
    return {
        r: lerp(color.r, 255, amount),
        g: lerp(color.g, 255, amount),
        b: lerp(color.b, 248, amount),
    };
}

function deepen(color, amount) {
    return {
        r: lerp(color.r, 24, amount),
        g: lerp(color.g, 34, amount),
        b: lerp(color.b, 60, amount),
    };
}

// Custom properties can hold color-mix() and var() chains that canvas cannot parse, so a probe
// element inside the body resolves them through the cascade first, then a 1x1 paint turns the
// result into plain sRGB numbers.
const probeCanvas = document.createElement('canvas');
probeCanvas.width = 1;
probeCanvas.height = 1;
const probeContext = probeCanvas.getContext('2d', { willReadFrequently: true });
const probeElement = document.createElement('span');
probeElement.setAttribute('aria-hidden', 'true');
probeElement.style.cssText = 'position:fixed;left:-20px;top:-20px;width:1px;height:1px;opacity:0;pointer-events:none;';

function parseRgb(text) {
    const match = String(text).match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2] };
}

function resolveColour(property) {
    if (!document.body) return { r: 255, g: 208, b: 140 };
    if (!probeElement.isConnected) document.body.append(probeElement);
    probeElement.style.color = '';
    probeElement.style.color = `var(${property})`;
    const resolved = window.getComputedStyle(probeElement).color;
    const parsed = parseRgb(resolved);
    if (parsed) return parsed;
    if (!probeContext) return { r: 255, g: 208, b: 140 };
    probeContext.clearRect(0, 0, 1, 1);
    probeContext.fillStyle = 'rgba(0, 0, 0, 0)';
    probeContext.fillStyle = resolved;
    probeContext.fillRect(0, 0, 1, 1);
    const data = probeContext.getImageData(0, 0, 1, 1).data;
    return { r: data[0], g: data[1], b: data[2] };
}

function readPalette() {
    // The light tone is a morning conservatory: the same brass and accents, deepened so the
    // stars still read against cream glass instead of disappearing into it.
    const lightTone = document.documentElement.dataset.sbSurfaceTone === 'light';
    const pick = (property, amount) => {
        const colour = resolveColour(property);
        return lightTone ? deepen(colour, amount) : colour;
    };
    const brass = pick('--starlight-brass', 0.46);
    const celeste = pick('--starlight-celeste', 0.52);
    const primary = pick('--neco-ginger', 0.42);
    const secondary = pick('--neco-accent-secondary', 0.48);
    return {
        lightTone,
        brass,
        celeste,
        primary,
        secondary,
        gold: whiteMix(brass, 0.45),
        starlight: lightTone ? { r: 58, g: 72, b: 104 } : { r: 255, g: 244, b: 214 },
    };
}

/* ---------------------------------------------------------------------------
   Sprite baking
   Every glint is pre-rendered once per palette, so a frame only blits images.
   --------------------------------------------------------------------------- */

function bakeGlint(colour, points, spread) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const centre = size / 2;
    const radius = centre * (spread ?? 0.94);

    const halo = context.createRadialGradient(centre, centre, 0, centre, centre, centre);
    halo.addColorStop(0, rgba(colour, 0.62));
    halo.addColorStop(0.16, rgba(colour, 0.3));
    halo.addColorStop(0.42, rgba(colour, 0.08));
    halo.addColorStop(1, rgba(colour, 0));
    context.fillStyle = halo;
    context.fillRect(0, 0, size, size);

    const arms = points;
    const inner = centre * 0.06;
    context.beginPath();
    for (let index = 0; index < arms * 2; index += 1) {
        const angle = (Math.PI / arms) * index - Math.PI / 2;
        const distance = index % 2 === 0 ? radius : inner;
        const x = centre + Math.cos(angle) * distance;
        const y = centre + Math.sin(angle) * distance;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
    }
    context.closePath();
    const core = context.createRadialGradient(centre, centre, 0, centre, centre, radius);
    core.addColorStop(0, 'rgba(255, 255, 255, 0.98)');
    core.addColorStop(0.22, rgba(whiteMix(colour, 0.55), 0.92));
    core.addColorStop(0.55, rgba(colour, 0.55));
    core.addColorStop(1, rgba(colour, 0));
    context.fillStyle = core;
    context.fill();

    return canvas;
}

function bakeNebula(colour) {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    for (let index = 0; index < 7; index += 1) {
        const x = randomBetween(size * 0.2, size * 0.8);
        const y = randomBetween(size * 0.2, size * 0.8);
        const radius = randomBetween(size * 0.16, size * 0.4);
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, rgba(colour, randomBetween(0.1, 0.2)));
        gradient.addColorStop(0.5, rgba(colour, 0.05));
        gradient.addColorStop(1, rgba(colour, 0));
        context.fillStyle = gradient;
        context.fillRect(0, 0, size, size);
    }
    return canvas;
}

function buildSprites(palette) {
    return {
        tiny: bakeGlint(palette.starlight, 4, 0.9),
        brass4: bakeGlint(palette.brass, 4, 0.92),
        brass8: bakeGlint(palette.brass, 8, 0.94),
        celeste4: bakeGlint(palette.celeste, 4, 0.92),
        celeste8: bakeGlint(palette.celeste, 8, 0.94),
        accent4: bakeGlint(palette.secondary, 4, 0.92),
        accent8: bakeGlint(palette.secondary, 8, 0.94),
        primary4: bakeGlint(palette.primary, 4, 0.92),
        white4: bakeGlint(whiteMix(palette.secondary, 0.6), 4, 0.9),
        nebulae: [bakeNebula(palette.celeste), bakeNebula(palette.secondary), bakeNebula(palette.brass)],
    };
}

/* ---------------------------------------------------------------------------
   Constellations
   --------------------------------------------------------------------------- */

const CONSTELLATIONS = [
    {
        id: 'felis-somnus',
        label: 'Felis Somnus',
        tone: 'brass',
        stars: [
            [0.10, 0.62], [0.20, 0.52], [0.30, 0.50], [0.42, 0.42], [0.55, 0.40],
            [0.68, 0.36], [0.78, 0.40], [0.86, 0.34], [0.90, 0.46], [0.86, 0.56],
            [0.76, 0.58], [0.70, 0.68], [0.56, 0.72], [0.40, 0.68], [0.26, 0.66],
            [0.16, 0.72],
        ],
        edges: [
            [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8],
            [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15], [15, 0],
        ],
    },
    {
        id: 'corona-felis',
        label: 'Corona Felis',
        tone: 'celeste',
        stars: [
            [0.10, 0.66], [0.30, 0.42], [0.50, 0.62], [0.70, 0.36], [0.90, 0.62],
            [0.82, 0.76], [0.18, 0.76], [0.50, 0.24],
        ],
        edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0], [2, 7], [7, 3]],
    },
    {
        id: 'stellata-palma',
        label: 'Stellata Palma',
        tone: 'brass',
        stars: [
            [0.50, 0.92], [0.50, 0.74], [0.50, 0.56], [0.50, 0.38], [0.50, 0.20], [0.50, 0.06],
            [0.28, 0.80], [0.72, 0.80], [0.24, 0.64], [0.76, 0.64], [0.28, 0.48],
            [0.72, 0.48], [0.34, 0.32], [0.66, 0.32], [0.40, 0.18], [0.60, 0.18],
        ],
        edges: [
            [0, 1], [1, 2], [2, 3], [3, 4], [4, 5],
            [1, 6], [1, 7], [2, 8], [2, 9], [3, 10], [3, 11], [4, 12], [4, 13], [5, 14], [5, 15],
        ],
    },
    {
        id: 'lyra-mystax',
        label: 'Lyra Mystax',
        tone: 'accent',
        stars: [
            [0.20, 0.30], [0.20, 0.70], [0.34, 0.82], [0.50, 0.86], [0.66, 0.82],
            [0.80, 0.70], [0.80, 0.30], [0.50, 0.22], [0.50, 0.52],
            [0.16, 0.56], [0.84, 0.56], [0.22, 0.64], [0.78, 0.64],
        ],
        edges: [
            [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 0],
            [0, 8], [6, 8], [8, 3], [8, 9], [8, 10], [8, 11], [8, 12],
        ],
    },
    {
        id: 'horologium-muris',
        label: 'Horologium Muris',
        tone: 'celeste',
        stars: [
            [0.50, 0.16], [0.726, 0.274], [0.82, 0.48], [0.726, 0.686], [0.50, 0.80],
            [0.274, 0.686], [0.18, 0.48], [0.274, 0.274],
            [0.30, 0.06], [0.70, 0.06], [0.94, 0.66], [0.84, 0.86], [0.66, 0.90],
            [0.50, 0.48],
        ],
        edges: [
            [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 0],
            [7, 8], [1, 9], [3, 10], [10, 11], [11, 12], [13, 0], [13, 2],
        ],
    },
    {
        id: 'caelum-caudae',
        label: 'Caelum Caudae',
        tone: 'primary',
        stars: [
            [0.06, 0.30], [0.20, 0.24], [0.36, 0.26], [0.52, 0.34], [0.66, 0.46],
            [0.78, 0.60], [0.88, 0.72], [0.94, 0.86], [0.80, 0.88], [0.70, 0.76],
        ],
        edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 6]],
    },
];

const DESKTOP_LAYOUT = [
    { id: 'corona-felis', x: 0.87, y: 0.13, size: 164 },
    { id: 'stellata-palma', x: 0.26, y: 0.18, size: 158 },
    { id: 'horologium-muris', x: 0.88, y: 0.48, size: 156 },
    { id: 'lyra-mystax', x: 0.25, y: 0.54, size: 148 },
    { id: 'felis-somnus', x: 0.27, y: 0.85, size: 174 },
    { id: 'caelum-caudae', x: 0.85, y: 0.85, size: 180 },
];

const PHONE_LAYOUT = [
    { id: 'corona-felis', x: 0.84, y: 0.055, size: 108 },
    { id: 'stellata-palma', x: 0.16, y: 0.09, size: 116 },
    { id: 'horologium-muris', x: 0.85, y: 0.25, size: 98 },
    { id: 'lyra-mystax', x: 0.15, y: 0.29, size: 94 },
    { id: 'felis-somnus', x: 0.24, y: 0.79, size: 122 },
    { id: 'caelum-caudae', x: 0.79, y: 0.85, size: 124 },
];

const SPARKLE_GROUPS = [
    { selector: '#top-bar', count: 3, reach: 18 },
    { selector: '.neconyan-home-intro', count: 3, reach: 12 },
    { selector: '.neconyan-assistant-picker', count: 2, reach: 12 },
    { selector: '.neconyan-home-cat', count: 3, reach: 14 },
    { selector: '.neconyan-home-actions', count: 2, reach: 10 },
    { selector: '#send_form', count: 3, reach: 14 },
    { selector: '#neconyan-workspace-rail', count: 2, reach: 12 },
];

/* ---------------------------------------------------------------------------
   Canvas plumbing
   --------------------------------------------------------------------------- */

function makeLayer(id) {
    const canvas = document.createElement('canvas');
    canvas.id = id;
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d');
    return { canvas, context };
}

function sizeLayers() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    for (const layer of Object.values(state.layers)) {
        if (layer.canvas.width !== pixelWidth || layer.canvas.height !== pixelHeight) {
            layer.canvas.width = pixelWidth;
            layer.canvas.height = pixelHeight;
        }
        layer.context.setTransform(dpr, 0, 0, dpr, 0, 0);
        layer.context.clearRect(0, 0, width, height);
    }
    state.width = width;
    state.height = height;
}

function seedSky() {
    const width = state.width;
    const height = state.height;
    const density = clamp(Math.round((width * height) / 5600), 90, 260);
    const stars = [];
    for (let index = 0; index < density; index += 1) {
        stars.push({
            x: Math.random(),
            y: Math.random(),
            radius: randomBetween(0.5, 2),
            base: randomBetween(0.24, 0.86),
            phase: randomBetween(0, Math.PI * 2),
            speed: randomBetween(0.35, 1.5),
            drift: randomBetween(-0.0022, 0.0022),
            tint: index % 11 === 0 ? 'celeste' : 'starlight',
        });
    }
    const glass = [];
    for (let index = 0; index < 54; index += 1) {
        glass.push({
            x: Math.random(),
            y: Math.random(),
            radius: randomBetween(0.5, 1.3),
            base: randomBetween(0.14, 0.42),
            phase: randomBetween(0, Math.PI * 2),
            speed: randomBetween(0.3, 1.2),
            glint: Math.random() < 0.12,
            drift: randomBetween(-0.0009, 0.0009),
        });
    }
    state.sky = { stars, glass, shooting: null, nextShooting: randomBetween(2.5, 6) };
}

function seedSparkles() {
    state.sparkles = [];
    for (const group of SPARKLE_GROUPS) {
        for (let index = 0; index < group.count; index += 1) {
            state.sparkles.push({
                group: group.selector,
                x: 0,
                y: 0,
                placed: false,
                size: randomBetween(9, 22),
                phase: randomBetween(0, Math.PI * 2),
                speed: randomBetween(0.4, 1.1),
                spin: randomBetween(-0.35, 0.35),
                rotation: randomBetween(0, Math.PI * 2),
                tone: Math.random() < 0.55 ? 'brass' : (Math.random() < 0.6 ? 'celeste' : 'accent'),
                points: Math.random() < 0.4 ? 8 : 4,
                life: randomBetween(1.4, 5.2),
                lifeMax: 0,
                power: randomBetween(0.45, 0.8),
            });
            const sparkle = state.sparkles[state.sparkles.length - 1];
            sparkle.lifeMax = sparkle.life;
        }
    }
    for (let index = 0; index < 12; index += 1) {
        const sparkle = {
            group: null,
            x: Math.random(),
            y: Math.random() * 0.85,
            normalized: true,
            placed: true,
            size: randomBetween(8, 18),
            phase: randomBetween(0, Math.PI * 2),
            speed: randomBetween(0.4, 1.1),
            spin: randomBetween(-0.25, 0.25),
            rotation: randomBetween(0, Math.PI * 2),
            tone: Math.random() < 0.5 ? 'celeste' : 'accent',
            points: 4,
            life: randomBetween(2, 6),
            lifeMax: 0,
            power: randomBetween(0.35, 0.8),
        };
        sparkle.lifeMax = sparkle.life;
        state.sparkles.push(sparkle);
    }
    placeSparkles(true);
}

function placeSparkles(force) {
    const width = state.width;
    const height = state.height;
    const rects = new Map();
    for (const sparkle of state.sparkles) {
        if (sparkle.normalized) continue;
        if (!force && sparkle.placed && sparkle.life > 0) continue;
        if (!rects.has(sparkle.group)) {
            const element = document.querySelector(sparkle.group);
            rects.set(sparkle.group, element ? element.getBoundingClientRect() : null);
        }
        const rect = rects.get(sparkle.group);
        if (!rect || !rect.width || !rect.height || rect.bottom < 0 || rect.top > height) {
            sparkle.placed = false;
            sparkle.life = 0;
            continue;
        }
        const along = Math.random();
        const edge = Math.random();
        const reach = 12;
        if (edge < 0.3) {
            sparkle.x = rect.left + rect.width * along;
            sparkle.y = rect.top - randomBetween(2, reach);
        } else if (edge < 0.6) {
            sparkle.x = rect.left + rect.width * along;
            sparkle.y = rect.bottom + randomBetween(2, reach);
        } else if (edge < 0.8) {
            sparkle.x = rect.left - randomBetween(2, reach);
            sparkle.y = rect.top + rect.height * along;
        } else {
            sparkle.x = rect.right + randomBetween(2, reach);
            sparkle.y = rect.top + rect.height * along;
        }
        sparkle.x = clamp(sparkle.x, 4, width - 4);
        sparkle.y = clamp(sparkle.y, 4, height - 4);
        sparkle.placed = true;
        sparkle.life = randomBetween(2.2, 6);
        sparkle.lifeMax = sparkle.life;
        sparkle.phase = randomBetween(0, Math.PI * 2);
        sparkle.size = randomBetween(9, 22);
        sparkle.tone = Math.random() < 0.52 ? 'brass' : (Math.random() < 0.6 ? 'celeste' : 'accent');
        sparkle.points = Math.random() < 0.42 ? 8 : 4;
    }
}

function seedConstellations() {
    const layout = state.width < 760 ? PHONE_LAYOUT : DESKTOP_LAYOUT;
    const scale = state.width < 760 ? 1 : clamp(state.width / 1440, 0.82, 1.15);
    state.constellations = layout.map((slot, index) => {
        const definition = CONSTELLATIONS.find(item => item.id === slot.id);
        return {
            definition,
            x: slot.x * state.width,
            y: slot.y * state.height,
            size: slot.size * scale,
            offset: index * 7,
            cycle: 42,
            window: 0.32,
        };
    });
}

function resizeStage() {
    sizeLayers();
    seedSky();
    seedConstellations();
    placeSparkles(true);
    if (state.still) drawStill();
}

/* ---------------------------------------------------------------------------
   Sky
   --------------------------------------------------------------------------- */

function drawSky(delta) {
    const { context } = state.layers.sky;
    const width = state.width;
    const height = state.height;
    const sprites = state.sprites;
    context.clearRect(0, 0, width, height);

    // Nebulae sit in three corners so the middle of the workspace stays calm behind chat text.
    const nebulae = [
        { sprite: sprites.nebulae[0], x: 0.14, y: 0.2, scale: 0.75, alpha: 0.38, phase: 0 },
        { sprite: sprites.nebulae[1], x: 0.86, y: 0.28, scale: 0.68, alpha: 0.32, phase: 1.7 },
        { sprite: sprites.nebulae[2], x: 0.76, y: 0.9, scale: 0.72, alpha: 0.3, phase: 3.1 },
    ];
    for (const nebula of nebulae) {
        const size = Math.max(width, height) * nebula.scale;
        const breathe = 0.72 + 0.28 * Math.sin(state.elapsed * 0.11 + nebula.phase);
        context.globalAlpha = nebula.alpha * breathe;
        context.drawImage(nebula.sprite, nebula.x * width - size / 2, nebula.y * height - size / 2, size, size);
    }
    context.globalAlpha = 1;

    const stars = state.sky?.stars ?? [];
    for (const star of stars) {
        star.x += star.drift * delta;
        if (star.x < -0.02) star.x += 1.04;
        if (star.x > 1.02) star.x -= 1.04;
        const twinkle = 0.55 + 0.45 * Math.sin(state.elapsed * star.speed + star.phase);
        const alpha = star.base * twinkle;
        const colour = star.tint === 'celeste' ? state.palette.celeste : state.palette.starlight;
        const radius = star.radius;
        if (radius > 1.2) {
            const sprite = star.tint === 'celeste' ? sprites.celeste4 : sprites.tiny;
            const size = radius * 11;
            context.globalAlpha = alpha * 0.85;
            context.drawImage(sprite, star.x * width - size / 2, star.y * height - size / 2, size, size);
            continue;
        }
        context.globalAlpha = alpha;
        context.fillStyle = rgba(colour, 1);
        context.beginPath();
        context.arc(star.x * width, star.y * height, radius, 0, Math.PI * 2);
        context.fill();
    }
    context.globalAlpha = 1;

    for (const entry of state.constellations) drawConstellation(entry);
    drawSparkles(delta, context, true);
    drawShootingStar(delta);
}

function drawShootingStar(delta) {
    const sky = state.sky;
    if (!sky) return;
    const { context } = state.layers.sky;

    if (!sky.shooting) {
        sky.nextShooting -= delta;
        if (sky.nextShooting > 0) return;
        const fromRight = Math.random() < 0.62;
        sky.shooting = {
            x: fromRight ? randomBetween(0.55, 1) : randomBetween(0, 0.45),
            y: randomBetween(0.05, 0.32),
            vx: fromRight ? -randomBetween(0.5, 0.78) : randomBetween(0.5, 0.78),
            vy: randomBetween(0.2, 0.34),
            life: 1,
            length: randomBetween(0.09, 0.16),
        };
        sky.nextShooting = randomBetween(9, 18);
        return;
    }

    const shot = sky.shooting;
    shot.life -= delta * 1.35;
    shot.x += shot.vx * delta;
    shot.y += shot.vy * delta;
    if (shot.life <= 0) {
        sky.shooting = null;
        return;
    }

    const x = shot.x * state.width;
    const y = shot.y * state.height;
    const tailX = x - shot.vx * state.width * shot.length;
    const tailY = y - shot.vy * state.height * shot.length;
    const fade = Math.sin(Math.PI * (1 - shot.life));

    const gradient = context.createLinearGradient(tailX, tailY, x, y);
    gradient.addColorStop(0, rgba(state.palette.starlight, 0));
    gradient.addColorStop(0.7, rgba(state.palette.celeste, 0.5 * fade));
    gradient.addColorStop(1, rgba(state.palette.starlight, 0.95 * fade));
    context.strokeStyle = gradient;
    context.lineWidth = 1.6;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(tailX, tailY);
    context.lineTo(x, y);
    context.stroke();

    const size = 26 * fade;
    context.globalAlpha = fade;
    context.drawImage(state.sprites.white4, x - size / 2, y - size / 2, size, size);
    context.globalAlpha = 1;
}

/* ---------------------------------------------------------------------------
   Constellations and sparkles
   --------------------------------------------------------------------------- */

function constellationPhase(entry) {
    const local = (state.elapsed + entry.offset) % entry.cycle;
    const progress = local / entry.cycle;
    if (progress > entry.window) return { visible: false, progress: 0 };
    return { visible: true, progress: progress / entry.window };
}

function constellationAlpha(progress) {
    if (progress <= 0) return 0;
    if (progress < 0.12) return progress / 0.12;
    if (progress < 0.8) return 1;
    return clamp((1 - progress) / 0.2, 0, 1);
}

function drawConstellation(entry) {
    const { context } = state.layers.sky;
    const phase = constellationPhase(entry);
    if (!phase.visible) return 0;
    const alpha = constellationAlpha(phase.progress);
    if (alpha <= 0.001) return 0;

    const definition = entry.definition;
    const tone = definition.tone;
    const colour = tone === 'celeste' ? state.palette.celeste
        : tone === 'accent' ? state.palette.secondary
            : tone === 'primary' ? state.palette.primary
                : state.palette.brass;
    const sprite = tone === 'celeste' ? state.sprites.celeste4
        : tone === 'accent' ? state.sprites.accent4
            : tone === 'primary' ? state.sprites.primary4
                : state.sprites.brass4;

    const trace = clamp((phase.progress - 0.16) / 0.26, 0, 1);
    const fade = alpha;
    const point = (star) => ({
        x: entry.x + (star[0] - 0.5) * entry.size,
        y: entry.y + (star[1] - 0.5) * entry.size,
    });

    // A faint breath of night air behind the figure lifts it off busy wallpaper.
    const bloomRadius = entry.size * 0.9;
    const bloom = context.createRadialGradient(entry.x, entry.y, 0, entry.x, entry.y, bloomRadius);
    bloom.addColorStop(0, rgba(colour, 0.1 * fade));
    bloom.addColorStop(0.55, rgba(colour, 0.035 * fade));
    bloom.addColorStop(1, rgba(colour, 0));
    context.fillStyle = bloom;
    context.beginPath();
    context.arc(entry.x, entry.y, bloomRadius, 0, Math.PI * 2);
    context.fill();

    // Gossamer threads draw themselves star by star while the figure wakes up.
    const total = definition.edges.length;
    context.save();
    context.globalAlpha = 1;
    context.lineWidth = 1;
    context.lineCap = 'round';
    context.strokeStyle = rgba(colour, 0.5 * fade);
    context.setLineDash([2, 5]);
    context.lineDashOffset = -state.elapsed * 1.5;
    for (let index = 0; index < total; index += 1) {
        const progress = clamp(trace * total - index, 0, 1);
        if (progress <= 0) break;
        const [from, to] = definition.edges[index];
        const start = point(definition.stars[from]);
        const end = point(definition.stars[to]);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(lerp(start.x, end.x, progress), lerp(start.y, end.y, progress));
        context.stroke();
    }
    context.setLineDash([]);
    context.restore();

    // Each star flares on its own short delay, so a figure lights up like a struck match.
    for (let index = 0; index < definition.stars.length; index += 1) {
        const delay = (index / definition.stars.length) * 0.14;
        const flare = clamp((phase.progress - delay) / 0.14, 0, 1);
        if (flare <= 0) continue;
        const { x, y } = point(definition.stars[index]);
        const shimmer = 0.75 + 0.25 * Math.sin(state.elapsed * 1.1 + index * 0.9);
        const size = entry.size * 0.11 * lerp(0.4, 1, flare) * shimmer;
        context.globalAlpha = flare * fade * 0.85;
        context.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    }
    context.globalAlpha = 1;

    // The figure's name fades in under it like an engraved brass plate. Phones drop the
    // plate so the small screen keeps its text columns clear.
    if (phase.progress > 0.34 && state.width >= 760) {
        const labelAlpha = clamp((phase.progress - 0.34) / 0.16, 0, 1) * fade * 0.5;
        context.save();
        context.globalAlpha = labelAlpha;
        context.fillStyle = rgba(colour, 1);
        context.font = `600 ${Math.max(8, entry.size * 0.046)}px 'Iowan Old Style', 'Palatino Linotype', Georgia, serif`;
        context.textAlign = 'center';
        context.textBaseline = 'top';
        if ('letterSpacing' in context) context.letterSpacing = `${Math.max(1, entry.size * 0.008)}px`;
        context.fillText(definition.label.toUpperCase(), entry.x, entry.y + entry.size * 0.54);
        context.restore();
    }

    return alpha;
}

function drawSparkles(delta, context, drifting) {
    for (const sparkle of state.sparkles) {
        if (Boolean(sparkle.normalized) !== drifting) continue;
        if (sparkle.normalized) {
            sparkle.y -= delta * 0.004;
            if (sparkle.y < -0.05) sparkle.y = 1.02;
        }
        if (!sparkle.placed) continue;
        sparkle.life -= delta;
        if (sparkle.life <= 0) {
            if (sparkle.normalized) {
                sparkle.life = randomBetween(2, 6);
                sparkle.lifeMax = sparkle.life;
                sparkle.phase = randomBetween(0, Math.PI * 2);
            } else {
                sparkle.placed = false;
                sparkle.life = 0;
            }
            continue;
        }
        const age = 1 - sparkle.life / sparkle.lifeMax;
        const envelope = Math.sin(Math.PI * clamp(age, 0, 1));
        const twinkle = 0.55 + 0.45 * Math.sin(state.elapsed * sparkle.speed * 2.2 + sparkle.phase);
        const flare = Math.pow(envelope * twinkle, 1.4) * sparkle.power;
        if (flare <= 0.02) continue;
        sparkle.rotation += sparkle.spin * delta;

        const sprite = sparkle.tone === 'celeste' ? (sparkle.points === 8 ? state.sprites.celeste8 : state.sprites.celeste4)
            : sparkle.tone === 'accent' ? (sparkle.points === 8 ? state.sprites.accent8 : state.sprites.accent4)
                : (sparkle.points === 8 ? state.sprites.brass8 : state.sprites.brass4);
        const size = sparkle.size * (0.6 + 0.6 * envelope);
        const x = sparkle.normalized ? sparkle.x * state.width : sparkle.x;
        const y = sparkle.normalized ? sparkle.y * state.height : sparkle.y;

        context.save();
        context.globalAlpha = clamp(flare * 0.8, 0, 1);
        context.translate(x, y);
        context.rotate(sparkle.rotation);
        context.drawImage(sprite, -size / 2, -size / 2, size, size);
        context.restore();
    }
}

function drawGlassStars() {
    const { context } = state.layers.overlay;
    const glass = state.sky?.glass ?? [];
    for (const star of glass) {
        const twinkle = 0.6 + 0.4 * Math.sin(state.elapsed * star.speed + star.phase);
        const alpha = star.base * twinkle;
        if (alpha <= 0.03) continue;
        const x = star.x * state.width;
        const y = star.y * state.height;
        if (star.glint) {
            const size = star.radius * 12;
            context.globalAlpha = alpha * 0.8;
            context.drawImage(state.sprites.tiny, x - size / 2, y - size / 2, size, size);
            continue;
        }
        context.globalAlpha = alpha;
        context.fillStyle = rgba(state.palette.starlight, 1);
        context.beginPath();
        context.arc(x, y, star.radius * 0.85, 0, Math.PI * 2);
        context.fill();
    }
    context.globalAlpha = 1;
}

function drawOverlay(delta) {
    const { context } = state.layers.overlay;
    context.clearRect(0, 0, state.width, state.height);
    drawGlassStars();
    drawSparkles(delta, context, false);
}

/* ---------------------------------------------------------------------------
   Pointer trail
   --------------------------------------------------------------------------- */

function spawnTrailStar(x, y, options = {}) {
    const toneRoll = Math.random();
    const tone = options.tone ?? (toneRoll < 0.4 ? 'brass' : toneRoll < 0.72 ? 'celeste' : toneRoll < 0.88 ? 'accent' : 'primary');
    const kind = options.kind ?? (Math.random() < 0.12 ? 'paw' : Math.random() < 0.4 ? 'eight' : 'four');
    const star = {
        x,
        y,
        vx: options.vx ?? randomBetween(-26, 26),
        vy: options.vy ?? randomBetween(-30, 6),
        life: options.life ?? randomBetween(0.9, 1.7),
        lifeMax: 0,
        size: options.size ?? randomBetween(12, 28),
        rotation: randomBetween(0, Math.PI * 2),
        spin: randomBetween(-2.4, 2.4),
        tone,
        kind,
        anchor: Boolean(options.anchor),
    };
    star.lifeMax = star.life;
    state.trail.push(star);
    if (state.trail.length > 120) state.trail.splice(0, state.trail.length - 120);
    return star;
}

function spawnNova(x, y) {
    state.novae.push({ x, y, life: 1, lifeMax: 1, rays: 8, rotation: randomBetween(0, Math.PI) });
    for (let index = 0; index < 8; index += 1) {
        const angle = (Math.PI * 2 * index) / 8 + randomBetween(-0.16, 0.16);
        const speed = randomBetween(60, 180);
        spawnTrailStar(x, y, {
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: randomBetween(0.6, 1.3),
            size: randomBetween(10, 22),
            kind: index % 4 === 0 ? 'eight' : 'four',
            anchor: true,
        });
    }
}

function trailToneColour(tone) {
    if (tone === 'celeste') return state.palette.celeste;
    if (tone === 'accent') return state.palette.secondary;
    if (tone === 'primary') return state.palette.primary;
    return state.palette.brass;
}

function drawPaw(context, star, alpha) {
    const colour = trailToneColour(star.tone);
    const scale = star.size / 26;
    context.globalAlpha = alpha * 0.9;
    context.fillStyle = rgba(colour, 1);
    context.beginPath();
    context.ellipse(star.x, star.y + 2 * scale, 5.4 * scale, 4.4 * scale, 0, 0, Math.PI * 2);
    context.fill();
    for (let index = 0; index < 3; index += 1) {
        const angle = -Math.PI / 2 + (index - 1) * 0.62;
        context.beginPath();
        context.arc(star.x + Math.cos(angle) * 6.6 * scale, star.y + Math.sin(angle) * 6.6 * scale, 2.2 * scale, 0, Math.PI * 2);
        context.fill();
    }
    context.globalAlpha = 1;
}

function drawTrail(delta) {
    const { context } = state.layers.trail;
    const width = state.width;
    const height = state.height;
    context.clearRect(0, 0, width, height);

    // A bright companion star glides after the pointer and keeps it company while it rests.
    if (state.companion?.visible) {
        const companion = state.companion;
        const ease = 1 - Math.pow(0.001, delta);
        companion.x = lerp(companion.x, companion.targetX, ease);
        companion.y = lerp(companion.y, companion.targetY, ease);
        const bob = Math.sin(state.elapsed * 1.8) * 3;
        const size = 32;
        context.save();
        context.globalAlpha = 0.8;
        context.translate(companion.x, companion.y + bob);
        context.rotate(state.elapsed * 0.35);
        context.drawImage(state.sprites.accent8, -size / 2, -size / 2, size, size);
        context.restore();
        const orbit = state.elapsed * 1.5;
        const moteSize = 11;
        context.globalAlpha = 0.65;
        context.drawImage(
            state.sprites.brass4,
            companion.x + Math.cos(orbit) * 18 - moteSize / 2,
            companion.y + bob + Math.sin(orbit) * 12 - moteSize / 2,
            moteSize,
            moteSize,
        );
        context.globalAlpha = 1;
    }

    // Gossamer threads turn the last few pointer stars into a constellation of their own.
    const anchors = state.trail.filter(star => star.anchor).slice(-9);
    if (anchors.length > 1) {
        context.save();
        context.lineWidth = 0.8;
        context.setLineDash([1.5, 4]);
        context.lineDashOffset = -state.elapsed * 26;
        for (let index = 1; index < anchors.length; index += 1) {
            const from = anchors[index - 1];
            const to = anchors[index];
            const alpha = 0.28 * (1 - index / anchors.length);
            context.strokeStyle = rgba(state.palette.celeste, alpha);
            context.beginPath();
            context.moveTo(from.x, from.y);
            context.quadraticCurveTo((from.x + to.x) / 2, (from.y + to.y) / 2 - 12, to.x, to.y);
            context.stroke();
        }
        context.setLineDash([]);
        context.restore();
    }

    for (let index = state.trail.length - 1; index >= 0; index -= 1) {
        const star = state.trail[index];
        star.life -= delta;
        if (star.life <= 0) {
            state.trail.splice(index, 1);
            continue;
        }
        star.x += star.vx * delta;
        star.y += star.vy * delta;
        star.vy += 26 * delta;
        star.vx *= 1 - delta * 1.05;
        star.vy *= 1 - delta * 0.7;
        star.rotation += star.spin * delta;

        const age = 1 - star.life / star.lifeMax;
        const alpha = (Math.sin(Math.PI * clamp(age, 0, 1)) ** 0.8) * 0.75;
        if (star.kind === 'paw') {
            drawPaw(context, star, alpha);
            continue;
        }
        const sprite = star.kind === 'eight'
            ? (star.tone === 'celeste' ? state.sprites.celeste8 : star.tone === 'accent' ? state.sprites.accent8 : state.sprites.brass8)
            : (star.tone === 'celeste' ? state.sprites.celeste4 : star.tone === 'accent' ? state.sprites.accent4 : state.sprites.brass4);
        const size = star.size * (1 + age * 0.4);
        context.save();
        context.globalAlpha = clamp(alpha, 0, 1);
        context.translate(star.x, star.y);
        context.rotate(star.rotation);
        context.drawImage(sprite, -size / 2, -size / 2, size, size);
        context.restore();
    }

    for (let index = state.novae.length - 1; index >= 0; index -= 1) {
        const nova = state.novae[index];
        nova.life -= delta * 1.5;
        if (nova.life <= 0) {
            state.novae.splice(index, 1);
            continue;
        }
        const progress = 1 - nova.life / nova.lifeMax;
        const alpha = Math.sin(Math.PI * progress) * 0.6;
        const radius = 10 + progress * 80;
        context.save();
        context.strokeStyle = rgba(state.palette.secondary, alpha * 0.7);
        context.lineWidth = 1.4;
        context.beginPath();
        context.arc(nova.x, nova.y, radius, 0, Math.PI * 2);
        context.stroke();
        for (let ray = 0; ray < nova.rays; ray += 1) {
            const angle = (Math.PI * 2 * ray) / nova.rays + nova.rotation;
            const inner = radius * 0.5;
            const outer = radius * (ray % 2 === 0 ? 1.18 : 0.92);
            context.strokeStyle = rgba(state.palette.brass, alpha * (ray % 2 === 0 ? 0.8 : 0.4));
            context.beginPath();
            context.moveTo(nova.x + Math.cos(angle) * inner, nova.y + Math.sin(angle) * inner);
            context.lineTo(nova.x + Math.cos(angle) * outer, nova.y + Math.sin(angle) * outer);
            context.stroke();
        }
        context.restore();
    }
}

/* ---------------------------------------------------------------------------
   Frame loop and motion policy
   --------------------------------------------------------------------------- */

function isStill() {
    return window.matchMedia(MOTION_QUERY).matches || document.body.classList.contains('reduced-motion');
}

function refreshPalette() {
    state.palette = readPalette();
    state.sprites = buildSprites(state.palette);
}

function drawStill() {
    const overlay = state.layers.overlay.context;
    const sky = state.layers.sky.context;
    const trail = state.layers.trail.context;
    sky.clearRect(0, 0, state.width, state.height);
    overlay.clearRect(0, 0, state.width, state.height);
    trail.clearRect(0, 0, state.width, state.height);
    const stars = state.sky?.stars ?? [];
    for (const star of stars) {
        const alpha = star.base * 0.7;
        sky.globalAlpha = alpha;
        sky.fillStyle = rgba(star.tint === 'celeste' ? state.palette.celeste : state.palette.starlight, 1);
        sky.beginPath();
        sky.arc(star.x * state.width, star.y * state.height, star.radius, 0, Math.PI * 2);
        sky.fill();
    }
    sky.globalAlpha = 1;
    for (const entry of state.constellations) {
        const definition = entry.definition;
        const sprite = state.sprites.brass4;
        const colour = definition.tone === 'celeste' ? state.palette.celeste : state.palette.brass;
        sky.save();
        sky.strokeStyle = rgba(colour, 0.2);
        sky.lineWidth = 0.9;
        sky.setLineDash([2, 5]);
        for (const [from, to] of definition.edges) {
            const start = definition.stars[from];
            const end = definition.stars[to];
            sky.beginPath();
            sky.moveTo(entry.x + (start[0] - 0.5) * entry.size, entry.y + (start[1] - 0.5) * entry.size);
            sky.lineTo(entry.x + (end[0] - 0.5) * entry.size, entry.y + (end[1] - 0.5) * entry.size);
            sky.stroke();
        }
        sky.setLineDash([]);
        for (const star of definition.stars) {
            const x = entry.x + (star[0] - 0.5) * entry.size;
            const y = entry.y + (star[1] - 0.5) * entry.size;
            const size = entry.size * 0.065;
            sky.globalAlpha = 0.5;
            sky.drawImage(sprite, x - size / 2, y - size / 2, size, size);
        }
        sky.restore();
    }
}

function frame(timestamp) {
    if (!state.mounted) return;
    state.rafId = window.requestAnimationFrame(frame);
    if (state.still) return;
    if (!state.previous) state.previous = timestamp;
    const delta = clamp((timestamp - state.previous) / 1000, 0, 0.05);
    state.previous = timestamp;
    if (document.hidden) return;
    state.elapsed += delta;

    if (state.elapsed - state.lastSparkleRefresh > SPARKLE_REFRESH_MS / 1000) {
        state.lastSparkleRefresh = state.elapsed;
        placeSparkles(false);
    }
    if (state.lastPointer && state.elapsed * 1000 - state.lastPointerAt > TRAIL_IDLE_MS) {
        state.lastPointer = null;
        state.companion.visible = false;
    }

    drawSky(delta);
    drawOverlay(delta);
    drawTrail(delta);
}

function syncMotion() {
    if (!state.mounted) return;
    const still = isStill();
    if (still === state.still) return;
    state.still = still;
    const stage = document.getElementById(STAGE_ID);
    if (stage) stage.dataset.starlightMotion = still ? 'still' : 'active';
    if (still) {
        state.trail.length = 0;
        state.novae.length = 0;
        if (state.companion) state.companion.visible = false;
        drawStill();
    } else {
        state.previous = 0;
        drawStill();
    }
}

/* ---------------------------------------------------------------------------
   Pointer handling
   --------------------------------------------------------------------------- */

function onPointerMove(event) {
    if (state.still) return;
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    const x = event.clientX;
    const y = event.clientY;
    state.lastPointer = { x, y };
    state.lastPointerAt = state.elapsed * 1000;
    if (!state.companion.visible) {
        state.companion.visible = true;
        state.companion.x = x;
        state.companion.y = y;
    }
    state.companion.targetX = x;
    state.companion.targetY = y;

    const now = performance.now();
    if (now - state.lastTrailAt < 16) return;
    state.lastTrailAt = now;
    const distance = state.lastSpawn
        ? Math.hypot(x - state.lastSpawn.x, y - state.lastSpawn.y)
        : Infinity;
    if (distance < 14) return;
    state.lastSpawn = { x, y };
    spawnTrailStar(x, y, { anchor: true, vx: randomBetween(-12, 12), vy: randomBetween(-8, 8) });
    if (Math.random() < 0.35) {
        spawnTrailStar(x + randomBetween(-10, 10), y + randomBetween(-10, 10), {
            life: randomBetween(0.5, 1),
            size: randomBetween(7, 13),
            kind: 'four',
        });
    }
}

function onPointerDown(event) {
    if (state.still) return;
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    spawnNova(event.clientX, event.clientY);
}

/* ---------------------------------------------------------------------------
   Public API
   --------------------------------------------------------------------------- */

export function mountStarlightConservatory() {
    if (state.mounted || typeof document === 'undefined' || !document.body) return;
    if (document.getElementById(STAGE_ID)) {
        state.mounted = true;
        return;
    }
    if (document.documentElement.dataset.sbTheme !== 'starlight-conservatory') return;

    const stage = document.createElement('div');
    stage.id = STAGE_ID;
    stage.dataset.starlightStage = 'starlight-conservatory';
    stage.setAttribute('aria-hidden', 'true');
    stage.dataset.starlightMotion = 'active';

    state.layers = {
        sky: makeLayer(SKY_ID),
        overlay: makeLayer(OVERLAY_ID),
        trail: makeLayer(TRAIL_ID),
    };
    stage.append(state.layers.sky.canvas, state.layers.overlay.canvas, state.layers.trail.canvas);
    document.body.append(stage);

    state.mounted = true;
    state.still = false;
    state.elapsed = 0;
    state.previous = 0;
    state.lastSparkleRefresh = -Infinity;
    state.lastSpawn = null;
    state.trail = [];
    state.novae = [];
    state.companion = { x: 0, y: 0, targetX: 0, targetY: 0, visible: false };

    refreshPalette();
    sizeLayers();
    seedSky();
    seedSparkles();
    seedConstellations();
    if (isStill()) {
        state.still = true;
        stage.dataset.starlightMotion = 'still';
        drawStill();
    } else {
        state.rafId = window.requestAnimationFrame(frame);
    }

    const resize = () => resizeStage();
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    state.listeners.push(
        () => window.removeEventListener('resize', resize),
        () => window.removeEventListener('pointermove', onPointerMove),
        () => window.removeEventListener('pointerdown', onPointerDown),
    );

    const motionQuery = window.matchMedia(MOTION_QUERY);
    motionQuery.addEventListener('change', syncMotion);
    state.listeners.push(() => motionQuery.removeEventListener('change', syncMotion));

    const bodyObserver = new MutationObserver(syncMotion);
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    state.observers.push(bodyObserver);

    const accentObserver = new MutationObserver(() => {
        refreshPalette();
        if (state.still) drawStill();
    });
    accentObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-neconyan-accent', 'data-sb-surface-tone', 'data-neconyan-palette'],
    });
    state.observers.push(accentObserver);
}

export function unmountStarlightConservatory() {
    if (!state.mounted) return;
    state.mounted = false;
    window.cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    for (const dispose of state.listeners) dispose();
    state.listeners = [];
    for (const observer of state.observers) observer.disconnect();
    state.observers = [];
    state.trail = [];
    state.novae = [];
    state.sparkles = [];
    state.constellations = [];
    state.layers = null;
    state.palette = null;
    document.getElementById(STAGE_ID)?.remove();
}

export function snapshotStarlightConservatory() {
    if (!state.mounted || !state.palette) return { mounted: false };
    const constellations = state.constellations.map(entry => {
        const phase = constellationPhase(entry);
        return {
            id: entry.definition.id,
            label: entry.definition.label,
            visible: phase.visible,
            progress: Number(phase.progress.toFixed(3)),
        };
    });
    return {
        mounted: true,
        motion: state.still ? 'still' : 'active',
        palette: {
            primary: rgba(state.palette.primary, 1),
            secondary: rgba(state.palette.secondary, 1),
            brass: rgba(state.palette.brass, 1),
            celeste: rgba(state.palette.celeste, 1),
        },
        constellations,
        sparkles: state.sparkles.filter(sparkle => sparkle.placed).length,
        trail: state.trail.length,
        visibleConstellations: constellations.filter(item => item.visible).length,
        companion: Boolean(state.companion?.visible),
        layers: Object.fromEntries(Object.entries(state.layers).map(([name, layer]) => [name, Boolean(layer.canvas.isConnected)])),
    };
}

if (typeof window !== 'undefined') {
    window.NeconyanStarlightConservatory = Object.freeze({
        mount: mountStarlightConservatory,
        unmount: unmountStarlightConservatory,
        snapshot: snapshotStarlightConservatory,
    });
}
