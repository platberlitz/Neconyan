/*
 * Neconyan — Sunken Reef underwater stage
 *
 * Loaded only while the Sunken Reef shell style is selected, and removed as
 * soon as the user picks another shell style. Three non-interactive canvases
 * submerge the interface without intercepting pointer events:
 *
 *   1. Reef backdrop layer (behind panels): shimmering caustic sunbeams,
 *      deep-sea marine snow, rising bubble columns and distant kelp sway.
 *   2. Marine creature overlay (above panels, below popups): a graceful manta
 *      ray gliding across the upper current, a sleek swordfish cruising past,
 *      a cheerful pink axolotl with feathery gills swimming and bobbing near
 *      the reef shelves, and a small school of bioluminescent reef fish.
 *   3. Water and pointer wake layer (below toasts): flowing refracted light,
 *      subtle click/tap ripples, bioluminescent plankton sparkles,
 *      expanding water ripples and swirling bubble trails with a tiny bubble
 *      companion riding the cursor.
 *
 * Reduced Motion (both Neconyan's setting and prefers-reduced-motion: reduce)
 * stops the animation loop, suppresses the pointer wake and paints one calm,
 * still underwater reef scene.
 */

const THEME_ID = 'sunken-reef';
const STAGE_ID = 'sb-sunken-reef-stage';
const REEF_CANVAS_ID = 'sb-sunken-reef-backdrop';
const CREATURES_CANVAS_ID = 'sb-sunken-reef-creatures';
const WAKE_CANVAS_ID = 'sb-sunken-reef-wake';

const CREATURE_SPECIES = Object.freeze([
    {
        id: 'manta-ray',
        name: 'Abyssal Manta Ray',
        species: 'manta-ray',
        baseY: 0.24,
        speed: 0.036,
        direction: 1,
        scale: 1.05,
        phaseOffset: 0.4,
    },
    {
        id: 'swordfish',
        name: 'Silverblade Swordfish',
        species: 'swordfish',
        baseY: 0.34,
        speed: 0.052,
        direction: -1,
        scale: 0.96,
        phaseOffset: 2.1,
    },
    {
        id: 'axolotl',
        name: 'Coral Reef Axolotl',
        species: 'axolotl',
        baseY: 0.72,
        speed: 0.025,
        direction: 1,
        scale: 1.0,
        phaseOffset: 3.7,
    },
]);

let activeStage = null;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function easeInOutSine(t) {
    return -(Math.cos(Math.PI * clamp(t, 0, 1)) - 1) / 2;
}

function mulberry32(seed) {
    let state = seed >>> 0;
    return function next() {
        state |= 0;
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function isSunkenReefActive() {
    return typeof document !== 'undefined'
        && document.documentElement?.getAttribute('data-sb-theme') === THEME_ID;
}

function isReducedMotionPreferred() {
    if (typeof document === 'undefined') return false;
    if (document.body?.classList?.contains('reduced-motion')) return true;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
}

function createColourProbe(host) {
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    host.appendChild(probe);

    const swatch = document.createElement('canvas');
    swatch.width = 1;
    swatch.height = 1;
    const swatchCtx = swatch.getContext('2d', { willReadFrequently: true });

    function resolve(cssValue, fallback) {
        try {
            probe.style.color = '';
            probe.style.color = cssValue;
            const resolved = window.getComputedStyle(probe).color || fallback;
            if (!swatchCtx) return fallback;
            swatchCtx.clearRect(0, 0, 1, 1);
            swatchCtx.fillStyle = fallback;
            swatchCtx.fillStyle = resolved;
            swatchCtx.fillRect(0, 0, 1, 1);
            const [r, g, b] = swatchCtx.getImageData(0, 0, 1, 1).data;
            return { r, g, b, css: `rgb(${r}, ${g}, ${b})` };
        } catch {
            return { r: 56, g: 232, b: 255, css: fallback };
        }
    }

    return {
        resolve,
        destroy() {
            probe.remove();
        },
    };
}

function rgba(colour, alpha) {
    const a = clamp(alpha, 0, 1);
    return `rgba(${colour.r}, ${colour.g}, ${colour.b}, ${a.toFixed(3)})`;
}

function mixRgb(a, b, weightB = 0.5) {
    const w = clamp(weightB, 0, 1);
    return {
        r: Math.round(lerp(a.r, b.r, w)),
        g: Math.round(lerp(a.g, b.g, w)),
        b: Math.round(lerp(a.b, b.b, w)),
    };
}

function buildBubbles(width, height, seed = 0x52454546) {
    const rand = mulberry32(seed + Math.round(width * 13 + height * 7));
    const area = Math.max(320 * 480, width * height);
    const count = clamp(Math.round(area / 19500), 28, 76);
    const bubbles = [];

    for (let index = 0; index < count; index += 1) {
        const tier = rand();
        const radius = tier > 0.88
            ? 4.6 + rand() * 4.4
            : tier > 0.52
                ? 2.4 + rand() * 2.3
                : 1.2 + rand() * 1.3;
        bubbles.push({
            xRatio: 0.03 + rand() * 0.94,
            yRatio: rand(),
            radius,
            riseSpeed: 0.018 + (6.5 / (radius + 2.5)) * 0.012 + rand() * 0.012,
            swayAmp: 6 + rand() * 18,
            swaySpeed: 0.7 + rand() * 1.4,
            phase: rand() * Math.PI * 2,
            hueMix: rand(),
            shimmer: 0.55 + rand() * 0.45,
        });
    }

    return bubbles;
}

function buildCausticBeams(seed = 0x43415553) {
    const rand = mulberry32(seed);
    const beams = [];
    const count = 7;
    for (let i = 0; i < count; i += 1) {
        beams.push({
            anchorX: 0.1 + (i / (count - 1)) * 0.8 + (rand() - 0.5) * 0.05,
            tilt: -0.18 + (i / (count - 1)) * 0.36,
            topWidth: 0.045 + rand() * 0.045,
            bottomWidth: 0.14 + rand() * 0.11,
            length: 0.68 + rand() * 0.26,
            speed: 0.35 + rand() * 0.45,
            phase: rand() * Math.PI * 2,
            coralTint: rand() * 0.35,
        });
    }
    return beams;
}

function buildReefSchool(seed = 0x46495348) {
    const rand = mulberry32(seed);
    const fish = [];
    for (let i = 0; i < 9; i += 1) {
        fish.push({
            offsetX: (rand() - 0.5) * 110,
            offsetY: (rand() - 0.5) * 46,
            size: 5.5 + rand() * 4.5,
            phase: rand() * Math.PI * 2,
            tint: rand(),
        });
    }
    return fish;
}

function drawBubble(ctx, x, y, radius, mainColour, pearlColour, alpha) {
    if (alpha <= 0.01 || radius <= 0.3) return;
    ctx.save();
    const grad = ctx.createRadialGradient(
        x - radius * 0.32,
        y - radius * 0.34,
        radius * 0.1,
        x,
        y,
        radius * 1.25,
    );
    grad.addColorStop(0, rgba(pearlColour, Math.min(1, alpha * 0.95)));
    grad.addColorStop(0.45, rgba(mainColour, alpha * 0.42));
    grad.addColorStop(0.84, rgba(mainColour, alpha * 0.68));
    grad.addColorStop(1, rgba(mainColour, 0));

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, radius * 1.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = rgba(pearlColour, alpha * 0.72);
    ctx.lineWidth = Math.max(0.75, radius * 0.18);
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.88, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = rgba(pearlColour, Math.min(1, alpha * 0.95));
    ctx.beginPath();
    ctx.arc(x - radius * 0.32, y - radius * 0.32, Math.max(0.7, radius * 0.24), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawMantaRay(ctx, x, y, size, flapPhase, direction, palette, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(direction, 1);
    const wingBeat = Math.sin(flapPhase) * 0.26;
    const tilt = Math.cos(flapPhase) * 0.06;
    ctx.rotate(tilt);

    const bodyColour = mixRgb(palette.lagoon, palette.deepWater, 0.38);
    const wingTipColour = mixRgb(palette.lagoon, palette.coral, 0.42);

    // Soft bioluminescent aura under the manta ray
    const aura = ctx.createRadialGradient(0, 0, size * 0.1, 0, 0, size * 1.35);
    aura.addColorStop(0, rgba(palette.lagoon, alpha * 0.26));
    aura.addColorStop(0.55, rgba(palette.coral, alpha * 0.11));
    aura.addColorStop(1, rgba(palette.lagoon, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, 0, size * 1.35, 0, Math.PI * 2);
    ctx.fill();

    const wingLift = wingBeat * size * 0.48;

    // Upper and lower pectoral wings
    const wingGrad = ctx.createLinearGradient(-size * 0.7, -size * 0.85, size * 0.75, size * 0.85);
    wingGrad.addColorStop(0, rgba(wingTipColour, alpha * 0.86));
    wingGrad.addColorStop(0.5, rgba(bodyColour, alpha * 0.92));
    wingGrad.addColorStop(1, rgba(wingTipColour, alpha * 0.86));

    ctx.fillStyle = wingGrad;
    ctx.strokeStyle = rgba(palette.pearl, alpha * 0.65);
    ctx.lineWidth = 1.35;

    ctx.beginPath();
    // Nose & cephalic fins
    ctx.moveTo(size * 0.78, -size * 0.14);
    ctx.quadraticCurveTo(size * 0.98, -size * 0.22, size * 0.64, -size * 0.24);
    // Upper wing leading edge
    ctx.bezierCurveTo(
        size * 0.34,
        -size * 0.44 - wingLift * 0.35,
        size * 0.02,
        -size * 0.96 - wingLift,
        -size * 0.26,
        -size * 0.84 - wingLift * 0.8,
    );
    // Upper wing trailing edge
    ctx.quadraticCurveTo(-size * 0.38, -size * 0.34, -size * 0.56, -size * 0.08);
    // Lower wing trailing edge
    ctx.quadraticCurveTo(-size * 0.38, size * 0.34, -size * 0.26, size * 0.84 + wingLift * 0.8);
    // Lower wing leading edge
    ctx.bezierCurveTo(
        size * 0.02,
        size * 0.96 + wingLift,
        size * 0.34,
        size * 0.44 + wingLift * 0.35,
        size * 0.64,
        size * 0.24,
    );
    // Lower cephalic lobe back to mouth
    ctx.quadraticCurveTo(size * 0.98, size * 0.22, size * 0.78, size * 0.14);
    ctx.quadraticCurveTo(size * 0.66, 0, size * 0.78, -size * 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Whip tail
    ctx.strokeStyle = rgba(palette.lagoon, alpha * 0.78);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-size * 0.54, 0);
    ctx.quadraticCurveTo(
        -size * 0.96,
        Math.sin(flapPhase * 1.4) * size * 0.16,
        -size * 1.38,
        Math.cos(flapPhase * 1.4) * size * 0.22,
    );
    ctx.stroke();

    // Bioluminescent dorsal markings
    ctx.strokeStyle = rgba(palette.pearl, alpha * 0.58);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(size * 0.34, -size * 0.18);
    ctx.quadraticCurveTo(size * 0.06, -size * 0.42 - wingLift * 0.35, -size * 0.18, -size * 0.48 - wingLift * 0.4);
    ctx.moveTo(size * 0.34, size * 0.18);
    ctx.quadraticCurveTo(size * 0.06, size * 0.42 + wingLift * 0.35, -size * 0.18, size * 0.48 + wingLift * 0.4);
    ctx.stroke();

    ctx.restore();
}

function drawSwordfish(ctx, x, y, size, swimPhase, direction, palette, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(direction, 1);
    const tailSwing = Math.sin(swimPhase * 1.8) * size * 0.14;
    const pitch = Math.sin(swimPhase * 0.7) * 0.04;
    ctx.rotate(pitch);

    const aura = ctx.createRadialGradient(0, 0, size * 0.08, 0, 0, size * 1.3);
    aura.addColorStop(0, rgba(palette.lagoon, alpha * 0.24));
    aura.addColorStop(1, rgba(palette.lagoon, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, 0, size * 1.3, 0, Math.PI * 2);
    ctx.fill();

    // Tall crescent dorsal fin and ventral fin
    ctx.fillStyle = rgba(mixRgb(palette.lagoon, palette.coral, 0.36), alpha * 0.85);
    ctx.beginPath();
    ctx.moveTo(size * 0.22, -size * 0.14);
    ctx.quadraticCurveTo(size * 0.04, -size * 0.58, -size * 0.22, -size * 0.48);
    ctx.quadraticCurveTo(-size * 0.1, -size * 0.22, -size * 0.12, -size * 0.12);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(size * 0.14, size * 0.13);
    ctx.quadraticCurveTo(size * 0.02, size * 0.44, -size * 0.18, size * 0.38);
    ctx.quadraticCurveTo(-size * 0.06, size * 0.2, -size * 0.04, size * 0.12);
    ctx.closePath();
    ctx.fill();

    // Forked crescent tail fin
    ctx.fillStyle = rgba(palette.lagoon, alpha * 0.88);
    ctx.beginPath();
    ctx.moveTo(-size * 0.66, 0);
    ctx.quadraticCurveTo(-size * 0.92, -size * 0.28 + tailSwing, -size * 1.08, -size * 0.46 + tailSwing);
    ctx.quadraticCurveTo(-size * 0.86, 0 + tailSwing * 0.4, -size * 1.08, size * 0.46 + tailSwing);
    ctx.quadraticCurveTo(-size * 0.92, size * 0.28 + tailSwing, -size * 0.66, 0);
    ctx.closePath();
    ctx.fill();

    // Streamlined torpedo body + long sword bill
    const bodyGrad = ctx.createLinearGradient(-size * 0.7, -size * 0.22, size * 0.8, size * 0.22);
    bodyGrad.addColorStop(0, rgba(mixRgb(palette.lagoon, palette.deepWater, 0.32), alpha * 0.94));
    bodyGrad.addColorStop(0.55, rgba(palette.pearl, alpha * 0.92));
    bodyGrad.addColorStop(1, rgba(palette.lagoon, alpha * 0.95));

    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = rgba(palette.pearl, alpha * 0.74);
    ctx.lineWidth = 1.25;

    ctx.beginPath();
    // Tip of the sword bill
    ctx.moveTo(size * 1.42, -size * 0.01);
    ctx.lineTo(size * 0.64, -size * 0.07);
    ctx.quadraticCurveTo(size * 0.2, -size * 0.24, -size * 0.68, -size * 0.04);
    ctx.lineTo(-size * 0.68, size * 0.04);
    ctx.quadraticCurveTo(size * 0.2, size * 0.22, size * 0.64, size * 0.06);
    ctx.lineTo(size * 1.42, size * 0.01);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Lateral bioluminescent stripe & eye
    ctx.strokeStyle = rgba(palette.coral, alpha * 0.72);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(size * 0.48, -size * 0.02);
    ctx.quadraticCurveTo(0, -size * 0.06, -size * 0.56, 0);
    ctx.stroke();

    ctx.fillStyle = rgba(palette.deepWater, alpha * 0.95);
    ctx.beginPath();
    ctx.arc(size * 0.48, -size * 0.03, Math.max(1.8, size * 0.048), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

function drawAxolotl(ctx, x, y, size, swimPhase, direction, palette, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(direction, 1);
    const bob = Math.sin(swimPhase) * 0.05;
    const tailWave = Math.sin(swimPhase * 1.6) * size * 0.16;
    const gillFlutter = Math.sin(swimPhase * 2.1) * 0.12;
    ctx.rotate(bob);

    const pinkBody = mixRgb(palette.coral, palette.pearl, 0.42);
    const gillRose = mixRgb(palette.coral, { r: 255, g: 82, b: 146 }, 0.55);

    // Warm rose-cyan bioluminescent glow around the axolotl
    const aura = ctx.createRadialGradient(0, 0, size * 0.1, 0, 0, size * 1.3);
    aura.addColorStop(0, rgba(palette.coral, alpha * 0.28));
    aura.addColorStop(0.6, rgba(palette.lagoon, alpha * 0.14));
    aura.addColorStop(1, rgba(palette.coral, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, 0, size * 1.3, 0, Math.PI * 2);
    ctx.fill();

    // Translucent finned tail
    ctx.fillStyle = rgba(pinkBody, alpha * 0.52);
    ctx.strokeStyle = rgba(palette.pearl, alpha * 0.62);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-size * 0.18, -size * 0.16);
    ctx.quadraticCurveTo(-size * 0.68, -size * 0.28 + tailWave * 0.5, -size * 1.08, tailWave);
    ctx.quadraticCurveTo(-size * 0.68, size * 0.28 + tailWave * 0.5, -size * 0.18, size * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Little front & back legs
    ctx.strokeStyle = rgba(pinkBody, alpha * 0.9);
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(size * 0.12, size * 0.14);
    ctx.lineTo(size * 0.22, size * 0.34);
    ctx.moveTo(-size * 0.22, size * 0.14);
    ctx.lineTo(-size * 0.32, size * 0.33);
    ctx.stroke();

    // Plump salamander body
    const bodyGrad = ctx.createLinearGradient(-size * 0.5, -size * 0.24, size * 0.55, size * 0.24);
    bodyGrad.addColorStop(0, rgba(pinkBody, alpha * 0.92));
    bodyGrad.addColorStop(1, rgba(mixRgb(pinkBody, palette.pearl, 0.35), alpha * 0.96));
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = rgba(palette.pearl, alpha * 0.75);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(-size * 0.05, 0, size * 0.42, size * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Feathery external gill stalks (3 on top/back of head, 3 lower)
    ctx.strokeStyle = rgba(gillRose, alpha * 0.95);
    ctx.lineWidth = Math.max(1.8, size * 0.075);
    const gillAngles = [-0.85, -0.52, -0.22, 0.32, 0.62, 0.92];
    for (let i = 0; i < gillAngles.length; i += 1) {
        const angle = gillAngles[i] + (i < 3 ? -gillFlutter : gillFlutter);
        const startX = size * 0.26;
        const startY = (i < 3 ? -1 : 1) * size * 0.12;
        const endX = startX - Math.cos(angle) * size * 0.28;
        const endY = startY + Math.sin(angle) * size * 0.34;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        ctx.fillStyle = rgba(palette.lagoon, alpha * 0.85);
        ctx.beginPath();
        ctx.arc(endX, endY, Math.max(1.3, size * 0.045), 0, Math.PI * 2);
        ctx.fill();
    }

    // Rounded axolotl head
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = rgba(palette.pearl, alpha * 0.8);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(size * 0.4, 0, size * 0.25, size * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Cute dark eyes and gentle smile
    ctx.fillStyle = rgba(palette.deepWater, alpha * 0.95);
    ctx.beginPath();
    ctx.arc(size * 0.5, -size * 0.06, Math.max(1.7, size * 0.045), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgba(palette.pearl, alpha * 0.95);
    ctx.beginPath();
    ctx.arc(size * 0.51, -size * 0.07, Math.max(0.8, size * 0.018), 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = rgba(gillRose, alpha * 0.82);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(size * 0.52, size * 0.03, size * 0.07, 0.15, Math.PI * 0.75);
    ctx.stroke();

    ctx.restore();
}

function drawSmallReefFish(ctx, x, y, size, phase, direction, colour, pearl, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(direction, 1);
    const tailWag = Math.sin(phase) * size * 0.22;

    ctx.fillStyle = rgba(colour, alpha * 0.82);
    ctx.beginPath();
    ctx.ellipse(0, 0, size, size * 0.48, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-size * 0.85, 0);
    ctx.lineTo(-size * 1.45, -size * 0.46 + tailWag);
    ctx.lineTo(-size * 1.45, size * 0.46 + tailWag);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = rgba(pearl, alpha * 0.9);
    ctx.beginPath();
    ctx.arc(size * 0.46, -size * 0.08, Math.max(0.9, size * 0.14), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function createStage() {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return null;

    const stage = document.createElement('div');
    stage.id = STAGE_ID;
    stage.setAttribute('aria-hidden', 'true');
    stage.style.cssText = 'display:contents;pointer-events:none;';

    const reefCanvas = document.createElement('canvas');
    reefCanvas.id = REEF_CANVAS_ID;
    reefCanvas.setAttribute('aria-hidden', 'true');
    reefCanvas.style.cssText = [
        'position:fixed',
        'inset:0',
        'width:100vw',
        'height:100vh',
        'pointer-events:none',
        'z-index:-1',
    ].join(';');

    const creaturesCanvas = document.createElement('canvas');
    creaturesCanvas.id = CREATURES_CANVAS_ID;
    creaturesCanvas.setAttribute('aria-hidden', 'true');
    creaturesCanvas.style.cssText = [
        'position:fixed',
        'inset:0',
        'width:100vw',
        'height:100vh',
        'pointer-events:none',
        'z-index:calc(var(--sb-z-shell-panel, 1100) - 1)',
    ].join(';');

    const wakeCanvas = document.createElement('canvas');
    wakeCanvas.id = WAKE_CANVAS_ID;
    wakeCanvas.setAttribute('aria-hidden', 'true');
    wakeCanvas.style.cssText = [
        'position:fixed',
        'inset:0',
        'width:100vw',
        'height:100vh',
        'pointer-events:none',
        'z-index:calc(var(--sb-z-critical, 10000) - 1)',
    ].join(';');

    stage.append(reefCanvas, creaturesCanvas, wakeCanvas);
    body.appendChild(stage);

    const reefCtx = reefCanvas.getContext('2d');
    const creaturesCtx = creaturesCanvas.getContext('2d');
    const wakeCtx = wakeCanvas.getContext('2d');
    const colourProbe = createColourProbe(stage);

    const state = {
        width: 0,
        height: 0,
        dpr: 1,
        bubbles: [],
        causticBeams: buildCausticBeams(),
        reefSchool: buildReefSchool(),
        wakeBubbles: [],
        wakeRipples: [],
        touchRipples: [],
        pointer: {
            x: 0,
            y: 0,
            targetX: 0,
            targetY: 0,
            lastSpawnX: 0,
            lastSpawnY: 0,
            activeUntil: 0,
            hasMoved: false,
        },
        creatures: CREATURE_SPECIES.map(creature => ({
            id: creature.id,
            name: creature.name,
            species: creature.species,
            visible: true,
            x: 0.5,
            y: creature.baseY,
            direction: creature.direction,
        })),
        palette: {
            lagoon: { r: 56, g: 232, b: 255, css: 'rgb(56, 232, 255)' },
            coral: { r: 255, g: 115, b: 152, css: 'rgb(255, 115, 152)' },
            pearl: { r: 228, g: 251, b: 255, css: 'rgb(228, 251, 255)' },
            deepWater: { r: 6, g: 26, b: 42, css: 'rgb(6, 26, 42)' },
            lightSurface: false,
        },
        rafId: 0,
        startTime: performance.now(),
        lastFrameTime: performance.now(),
        lastPaletteTime: 0,
        reducedMotion: false,
        destroyed: false,
    };

    function refreshPalette(now = performance.now()) {
        state.lastPaletteTime = now;
        const lightSurface = root.getAttribute('data-sb-surface-tone') === 'light';
        const customAccent = root.getAttribute('data-neconyan-accent') === 'custom';
        const ginger = colourProbe.resolve('var(--neco-ginger)', '#38e8ff');
        const secondary = colourProbe.resolve('var(--neco-accent-secondary)', '#ff7398');
        const reefLagoon = colourProbe.resolve('var(--reef-lagoon)', lightSurface ? '#0088ab' : '#38e8ff');
        const reefCoral = colourProbe.resolve('var(--reef-coral)', lightSurface ? '#d94b78' : '#ff7398');
        const reefPearl = colourProbe.resolve('var(--reef-pearl)', lightSurface ? '#083044' : '#e4fbff');

        const lagoon = customAccent ? mixRgb(reefLagoon, ginger, 0.58) : reefLagoon;
        const coral = customAccent ? mixRgb(reefCoral, secondary, 0.65) : reefCoral;

        state.palette = {
            lagoon: { ...lagoon, css: `rgb(${lagoon.r}, ${lagoon.g}, ${lagoon.b})` },
            coral: { ...coral, css: `rgb(${coral.r}, ${coral.g}, ${coral.b})` },
            pearl: reefPearl,
            deepWater: lightSurface
                ? { r: 10, g: 56, b: 80, css: 'rgb(10, 56, 80)' }
                : { r: 5, g: 22, b: 36, css: 'rgb(5, 22, 36)' },
            lightSurface,
        };
    }

    function resizeCanvases() {
        const width = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1280);
        const height = Math.max(320, window.innerHeight || document.documentElement.clientHeight || 800);
        const dpr = clamp(window.devicePixelRatio || 1, 1, 2);

        if (width === state.width && height === state.height && dpr === state.dpr && state.bubbles.length > 0) {
            return;
        }

        state.width = width;
        state.height = height;
        state.dpr = dpr;

        for (const [canvas, ctx] of [
            [reefCanvas, reefCtx],
            [creaturesCanvas, creaturesCtx],
            [wakeCanvas, wakeCtx],
        ]) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            if (ctx) {
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }
        }

        state.bubbles = buildBubbles(width, height);
    }

    function spawnWakeAt(x, y, vx, vy, now) {
        const { lagoon, coral, pearl } = state.palette;
        const speed = Math.hypot(vx, vy);
        const count = speed > 22 ? 3 : 2;

        for (let index = 0; index < count; index += 1) {
            const angle = Math.random() * Math.PI * 2;
            const spread = 2 + Math.random() * 10;
            const tint = index % 2 === 0
                ? mixRgb(lagoon, pearl, 0.35)
                : mixRgb(coral, lagoon, 0.45);
            state.wakeBubbles.push({
                x: x + Math.cos(angle) * spread,
                y: y + Math.sin(angle) * spread,
                vx: -vx * 0.06 + (Math.random() - 0.5) * 0.65,
                vy: -0.45 - Math.random() * 0.75,
                radius: 1.8 + Math.random() * 3.1,
                bornAt: now,
                life: 720 + Math.random() * 480,
                colour: tint,
            });
        }

        if (state.wakeRipples.length === 0 || (now - state.wakeRipples[state.wakeRipples.length - 1].bornAt) > 110) {
            state.wakeRipples.push({
                x,
                y,
                bornAt: now,
                life: 780,
                maxRadius: 24 + Math.min(24, speed * 0.45),
            });
        }

        if (state.wakeBubbles.length > 84) {
            state.wakeBubbles.splice(0, state.wakeBubbles.length - 84);
        }
        if (state.wakeRipples.length > 18) {
            state.wakeRipples.splice(0, state.wakeRipples.length - 18);
        }
    }

    function renderReefBackdrop(elapsedSeconds, reducedMotion) {
        if (!reefCtx) return;
        const { width, height, palette } = state;
        reefCtx.clearRect(0, 0, width, height);

        const baseAlpha = palette.lightSurface ? 0.5 : 0.85;

        // Upper ocean caustic sunbeams filtering down through the reef
        for (const beam of state.causticBeams) {
            const wave = reducedMotion ? 0.5 : (0.5 + 0.5 * Math.sin(elapsedSeconds * beam.speed + beam.phase));
            const sway = reducedMotion ? 0 : Math.sin(elapsedSeconds * beam.speed * 0.7 + beam.phase) * 0.03;
            const topX = (beam.anchorX + sway) * width;
            const bottomX = (beam.anchorX + beam.tilt + sway * 1.6) * width;
            const topHalf = beam.topWidth * width * 0.5;
            const bottomHalf = beam.bottomWidth * width * 0.5;
            const beamHeight = beam.length * height;

            const beamColour = mixRgb(palette.lagoon, palette.coral, beam.coralTint);
            const grad = reefCtx.createLinearGradient(topX, 0, bottomX, beamHeight);
            grad.addColorStop(0, rgba(palette.pearl, (0.11 + wave * 0.09) * baseAlpha));
            grad.addColorStop(0.38, rgba(beamColour, (0.08 + wave * 0.07) * baseAlpha));
            grad.addColorStop(1, rgba(beamColour, 0));

            reefCtx.fillStyle = grad;
            reefCtx.beginPath();
            reefCtx.moveTo(topX - topHalf, 0);
            reefCtx.lineTo(topX + topHalf, 0);
            reefCtx.lineTo(bottomX + bottomHalf, beamHeight);
            reefCtx.lineTo(bottomX - bottomHalf, beamHeight);
            reefCtx.closePath();
            reefCtx.fill();
        }

        // Rising underwater bubbles and glowing marine snow
        for (const bubble of state.bubbles) {
            const progress = reducedMotion
                ? bubble.yRatio
                : ((bubble.yRatio - elapsedSeconds * bubble.riseSpeed) % 1 + 1) % 1;
            const sway = reducedMotion
                ? 0
                : Math.sin(elapsedSeconds * bubble.swaySpeed + bubble.phase) * bubble.swayAmp;
            const x = bubble.xRatio * width + sway;
            const y = progress * height;
            const pulse = reducedMotion
                ? 0.8
                : (0.62 + 0.38 * Math.sin(elapsedSeconds * 1.8 + bubble.phase));
            const edgeFade = Math.sin(clamp(progress, 0.02, 0.98) * Math.PI);
            const alpha = bubble.shimmer * pulse * edgeFade * baseAlpha;
            const mainColour = mixRgb(palette.lagoon, palette.coral, bubble.hueMix * 0.45);

            drawBubble(reefCtx, x, y, bubble.radius, mainColour, palette.pearl, alpha);
        }
    }

    function renderCreatures(elapsedSeconds, reducedMotion) {
        if (!creaturesCtx) return;
        const { width, height, palette } = state;
        creaturesCtx.clearRect(0, 0, width, height);

        const baseScale = clamp(Math.min(width, height) / 900, 0.68, 1.24);
        const alpha = palette.lightSurface ? 0.62 : 0.78;

        // Small schooling bioluminescent reef fish drifting in a gentle arc
        const schoolProgress = reducedMotion ? 0.36 : ((elapsedSeconds * 0.022 + 0.25) % 1);
        const schoolX = lerp(width * 0.14, width * 0.86, schoolProgress);
        const schoolY = height * 0.48 + Math.sin(schoolProgress * Math.PI * 2) * height * 0.06;
        for (const member of state.reefSchool) {
            const fishColour = mixRgb(palette.lagoon, palette.coral, member.tint);
            const bob = reducedMotion ? 0 : Math.sin(elapsedSeconds * 2.2 + member.phase) * 5;
            drawSmallReefFish(
                creaturesCtx,
                schoolX + member.offsetX * baseScale,
                schoolY + member.offsetY * baseScale + bob,
                member.size * baseScale,
                reducedMotion ? member.phase : elapsedSeconds * 5 + member.phase,
                1,
                fishColour,
                palette.pearl,
                alpha * 0.65,
            );
        }

        // Featured marine creatures: Manta Ray, Swordfish, and Axolotl
        state.creatures = CREATURE_SPECIES.map((spec, idx) => {
            const cycle = reducedMotion
                ? (0.24 + idx * 0.26)
                : ((elapsedSeconds * spec.speed + spec.phaseOffset * 0.15) % 1);
            const margin = 0.12;
            const rawX = spec.direction > 0
                ? lerp(-margin, 1 + margin, cycle)
                : lerp(1 + margin, -margin, cycle);
            const waveY = reducedMotion
                ? 0
                : Math.sin(elapsedSeconds * 0.9 + spec.phaseOffset) * 0.035;
            const normX = clamp(rawX, 0.05, 0.95);
            const normY = clamp(spec.baseY + waveY, 0.12, 0.88);
            const px = rawX * width;
            const py = normY * height;
            const edgeAlpha = easeInOutSine(clamp(1 - Math.abs(cycle - 0.5) * 1.75, 0.28, 1));
            const creatureAlpha = alpha * edgeAlpha;
            const animPhase = reducedMotion ? spec.phaseOffset : (elapsedSeconds * 2.6 + spec.phaseOffset);

            if (spec.species === 'manta-ray') {
                drawMantaRay(
                    creaturesCtx,
                    px,
                    py,
                    44 * baseScale * spec.scale,
                    animPhase,
                    spec.direction,
                    palette,
                    creatureAlpha,
                );
            } else if (spec.species === 'swordfish') {
                drawSwordfish(
                    creaturesCtx,
                    px,
                    py,
                    42 * baseScale * spec.scale,
                    animPhase,
                    spec.direction,
                    palette,
                    creatureAlpha,
                );
            } else if (spec.species === 'axolotl') {
                drawAxolotl(
                    creaturesCtx,
                    px,
                    py,
                    34 * baseScale * spec.scale,
                    animPhase,
                    spec.direction,
                    palette,
                    creatureAlpha,
                );
            }

            return {
                id: spec.id,
                name: spec.name,
                species: spec.species,
                visible: creatureAlpha > 0.1,
                x: Number(normX.toFixed(3)),
                y: Number(normY.toFixed(3)),
                direction: spec.direction,
            };
        });
    }

    function renderWaterCurrent(elapsedSeconds) {
        const { width, height, palette } = state;
        // Two crossing swells bend the light into slow, travelling ribbons.
        // Paint on the existing foreground canvas so water passes over panels
        // as well as the wallpaper, without moving text or intercepting input.
        const spacing = height / 6;
        const amplitude = Math.min(48, width * 0.055);
        const drift = elapsedSeconds * 24;
        wakeCtx.save();
        wakeCtx.lineJoin = 'round';
        for (let band = -1; band < 8; band += 1) {
            const baseY = band * spacing + Math.sin(elapsedSeconds * 0.23 + band * 0.7) * spacing * 0.4;
            wakeCtx.beginPath();
            for (let x = -32; x <= width + 32; x += 24) {
                const y = baseY
                    + Math.sin((x - drift) / 170 + band * 1.3) * amplitude
                    + Math.sin((x + drift * 0.6) / 85 + band * 0.8) * amplitude * 0.3;
                if (x === -32) wakeCtx.moveTo(x, y);
                else wakeCtx.lineTo(x, y);
            }
            wakeCtx.strokeStyle = rgba(palette.lagoon, palette.lightSurface ? 0.025 : 0.035);
            wakeCtx.lineWidth = 24;
            wakeCtx.stroke();
            wakeCtx.strokeStyle = rgba(palette.pearl, palette.lightSurface ? 0.07 : 0.09);
            wakeCtx.lineWidth = 2;
            wakeCtx.stroke();
        }
        wakeCtx.restore();
    }

    function renderWake(now, dtSeconds, reducedMotion) {
        if (!wakeCtx) return;
        const { width, height, palette, pointer } = state;
        wakeCtx.clearRect(0, 0, width, height);

        if (reducedMotion) {
            state.wakeBubbles.length = 0;
            state.wakeRipples.length = 0;
            state.touchRipples.length = 0;
            return;
        }

        renderWaterCurrent((now - state.startTime) / 1000);

        // A click or completed tap sends out two soft, fading wave fronts.
        for (let i = state.touchRipples.length - 1; i >= 0; i -= 1) {
            const ripple = state.touchRipples[i];
            const progress = (now - ripple.bornAt) / 1100;
            if (progress >= 1) {
                state.touchRipples.splice(i, 1);
                continue;
            }
            for (let ring = 0; ring < 2; ring += 1) {
                const t = (progress - ring * 0.16) / (1 - ring * 0.16);
                if (t < 0) continue;
                const radius = 5 + (1 - (1 - t) ** 2) * 64;
                const alpha = Math.sin(Math.PI * t) * (1 - t) * 0.34;
                wakeCtx.strokeStyle = rgba(palette.lagoon, alpha);
                wakeCtx.lineWidth = 1.4;
                wakeCtx.beginPath();
                wakeCtx.ellipse(ripple.x, ripple.y, radius, radius * 0.82, -0.12, 0, Math.PI * 2);
                wakeCtx.stroke();
            }
        }

        // Expanding water ripples
        for (let i = state.wakeRipples.length - 1; i >= 0; i -= 1) {
            const ripple = state.wakeRipples[i];
            const age = now - ripple.bornAt;
            if (age >= ripple.life) {
                state.wakeRipples.splice(i, 1);
                continue;
            }
            const t = age / ripple.life;
            const radius = lerp(4, ripple.maxRadius, t);
            const alpha = (1 - t) * (palette.lightSurface ? 0.34 : 0.48);
            wakeCtx.strokeStyle = rgba(palette.lagoon, alpha);
            wakeCtx.lineWidth = 1.25;
            wakeCtx.beginPath();
            wakeCtx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
            wakeCtx.stroke();
        }

        // Rising bioluminescent wake bubbles
        for (let i = state.wakeBubbles.length - 1; i >= 0; i -= 1) {
            const bubble = state.wakeBubbles[i];
            const age = now - bubble.bornAt;
            if (age >= bubble.life) {
                state.wakeBubbles.splice(i, 1);
                continue;
            }
            const lifeRatio = 1 - age / bubble.life;
            bubble.x += bubble.vx * (dtSeconds * 60);
            bubble.y += bubble.vy * (dtSeconds * 60);
            bubble.vx *= 0.96;

            drawBubble(
                wakeCtx,
                bubble.x,
                bubble.y,
                bubble.radius * (0.65 + lifeRatio * 0.45),
                bubble.colour,
                palette.pearl,
                lifeRatio * 0.88,
            );
        }

        // Companion pearl-bubble riding near the pointer while active
        if (pointer.hasMoved && now < pointer.activeUntil) {
            const follow = clamp(dtSeconds * 15, 0.08, 0.45);
            pointer.x = lerp(pointer.x, pointer.targetX, follow);
            pointer.y = lerp(pointer.y, pointer.targetY, follow);
            const fade = clamp((pointer.activeUntil - now) / 650, 0, 1);
            const bobX = Math.cos(now * 0.0055) * 9;
            const bobY = Math.sin(now * 0.007) * 7 - 8;

            drawBubble(
                wakeCtx,
                pointer.x + bobX,
                pointer.y + bobY,
                5.4,
                palette.coral,
                palette.pearl,
                fade * 0.92,
            );
        }
    }

    function updateMotionAttribute(reducedMotion) {
        stage.dataset.reefMotion = reducedMotion ? 'still' : 'active';
    }

    function renderFrame(now = performance.now()) {
        if (state.destroyed) return;
        if (!isSunkenReefActive()) {
            unmountSunkenReef();
            return;
        }

        const reducedMotion = isReducedMotionPreferred();
        state.reducedMotion = reducedMotion;
        updateMotionAttribute(reducedMotion);

        if (now - state.lastPaletteTime > 420) {
            refreshPalette(now);
        }

        resizeCanvases();

        const dtSeconds = clamp((now - state.lastFrameTime) / 1000, 0.001, 0.1);
        state.lastFrameTime = now;
        const elapsedSeconds = (now - state.startTime) / 1000;

        renderReefBackdrop(elapsedSeconds, reducedMotion);
        renderCreatures(elapsedSeconds, reducedMotion);
        renderWake(now, dtSeconds, reducedMotion);

        if (!reducedMotion && !document.hidden) {
            state.rafId = window.requestAnimationFrame(renderFrame);
        } else {
            state.rafId = 0;
        }
    }

    function scheduleLoop() {
        if (state.destroyed) return;
        if (state.rafId) {
            window.cancelAnimationFrame(state.rafId);
            state.rafId = 0;
        }
        state.lastFrameTime = performance.now();
        renderFrame(state.lastFrameTime);
    }

    function onPointerMove(event) {
        if (state.destroyed || isReducedMotionPreferred()) return;
        if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return;

        const now = performance.now();
        const x = event.clientX;
        const y = event.clientY;
        const pointer = state.pointer;

        if (!pointer.hasMoved) {
            pointer.hasMoved = true;
            pointer.x = x;
            pointer.y = y;
            pointer.lastSpawnX = x;
            pointer.lastSpawnY = y;
        }

        const dx = x - pointer.lastSpawnX;
        const dy = y - pointer.lastSpawnY;
        const dist = Math.hypot(dx, dy);

        pointer.targetX = x;
        pointer.targetY = y;
        pointer.activeUntil = now + 900;

        if (dist >= 12) {
            spawnWakeAt(x, y, dx, dy, now);
            pointer.lastSpawnX = x;
            pointer.lastSpawnY = y;
        }

        if (!state.rafId && !document.hidden) {
            scheduleLoop();
        }
    }

    function onResize() {
        if (state.destroyed) return;
        resizeCanvases();
        scheduleLoop();
    }

    function onClick(event) {
        // Native click covers mouse, pen and completed touch taps, but not
        // scrolling gestures. Keyboard activation has no pointer location.
        if (state.destroyed || document.hidden || isReducedMotionPreferred()
            || event.detail === 0 || event.button !== 0) return;
        state.touchRipples.push({ x: event.clientX, y: event.clientY, bornAt: performance.now() });
        if (state.touchRipples.length > 8) state.touchRipples.shift();
        if (!state.rafId) scheduleLoop();
    }

    function onVisibilityChange() {
        if (state.destroyed) return;
        if (document.hidden) {
            if (state.rafId) {
                window.cancelAnimationFrame(state.rafId);
                state.rafId = 0;
            }
        } else {
            scheduleLoop();
        }
    }

    const motionMedia = typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    function onMotionChange() {
        if (state.destroyed) return;
        scheduleLoop();
    }

    const observer = new MutationObserver(() => {
        if (state.destroyed) return;
        if (!isSunkenReefActive()) {
            unmountSunkenReef();
            return;
        }
        refreshPalette(performance.now());
        scheduleLoop();
    });

    observer.observe(root, {
        attributes: true,
        attributeFilter: ['data-sb-theme', 'data-sb-surface-tone', 'data-neconyan-accent', 'style', 'class'],
    });
    observer.observe(body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
    });

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('click', onClick, { passive: true, capture: true });
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (motionMedia && typeof motionMedia.addEventListener === 'function') {
        motionMedia.addEventListener('change', onMotionChange);
    }

    refreshPalette(performance.now());
    resizeCanvases();
    scheduleLoop();

    return {
        stage,
        snapshot() {
            const now = performance.now();
            return {
                active: !state.destroyed && isSunkenReefActive(),
                motion: state.reducedMotion ? 'still' : 'active',
                bubbles: state.bubbles.length,
                causticBeams: state.causticBeams.length,
                schoolSize: state.reefSchool.length,
                wakeBubbles: state.wakeBubbles.length,
                wakeRipples: state.wakeRipples.length,
                touchRipples: state.touchRipples.length,
                companion: !state.reducedMotion && state.pointer.hasMoved && now < state.pointer.activeUntil,
                palette: {
                    lagoon: state.palette.lagoon.css,
                    coral: state.palette.coral.css,
                    pearl: state.palette.pearl.css,
                },
                creatures: state.creatures.map(item => ({ ...item })),
                layers: {
                    backdrop: Boolean(document.getElementById(REEF_CANVAS_ID)),
                    creatures: Boolean(document.getElementById(CREATURES_CANVAS_ID)),
                    wake: Boolean(document.getElementById(WAKE_CANVAS_ID)),
                },
            };
        },
        destroy() {
            if (state.destroyed) return;
            state.destroyed = true;
            if (state.rafId) {
                window.cancelAnimationFrame(state.rafId);
                state.rafId = 0;
            }
            observer.disconnect();
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('click', onClick, true);
            window.removeEventListener('resize', onResize);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (motionMedia && typeof motionMedia.removeEventListener === 'function') {
                motionMedia.removeEventListener('change', onMotionChange);
            }
            colourProbe.destroy();
            stage.remove();
        },
    };
}

export function mountSunkenReef() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    if (!isSunkenReefActive()) {
        unmountSunkenReef();
        return null;
    }
    if (!activeStage) {
        activeStage = createStage();
    }
    return activeStage;
}

export function unmountSunkenReef() {
    if (activeStage) {
        activeStage.destroy();
        activeStage = null;
    }
    if (typeof document !== 'undefined') {
        document.getElementById(STAGE_ID)?.remove();
    }
}

export function snapshotSunkenReef() {
    if (!activeStage) {
        return {
            active: false,
            motion: isReducedMotionPreferred() ? 'still' : 'active',
            bubbles: 0,
            causticBeams: 0,
            schoolSize: 0,
            wakeBubbles: 0,
            wakeRipples: 0,
            touchRipples: 0,
            companion: false,
            palette: null,
            creatures: [],
            layers: { backdrop: false, creatures: false, wake: false },
        };
    }
    return activeStage.snapshot();
}

if (typeof window !== 'undefined') {
    window.NeconyanSunkenReef = Object.freeze({
        mount: mountSunkenReef,
        unmount: unmountSunkenReef,
        snapshot: snapshotSunkenReef,
    });
}
