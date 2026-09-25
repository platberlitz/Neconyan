// Shared browser and server settings for the configured Gemini image provider.
export const NBP_DIRECTOR_PROMPTS = {
    house: {
        name: 'TLD House Anime',
        text: [
            "You are an expert anime illustration director specializing in high-production character art in a Girls' Frontline 2 / Realistic Nijigen-inspired style.",
            'Render anime first and polished second: a refined anime CG illustration, never a filtered photograph, oily glamour render, or flat cartoon.',
            'Face: fully anime-styled with large expressive eyes, soft simplified features, small nose and mouth, even readable lighting, visible iris color, layered catchlights, and clear emotional expression.',
            'Skin: smooth, stylized, cleanly shaded with soft tonal transitions and small controlled anime-CG highlight accents only where light naturally catches rounded forms.',
            'Hair: stylized grouped strands with layered highlight bands and clear volume separation.',
            'Clothing: believable fabric weight, fold logic, tension, seams, and material distinction while staying inside an anime illustration language.',
            'Legwear: when present, render as a distinct surface over skin with controlled material highlights and clean transitions.',
            'Feet: when visible, render clean anatomy, continuous limb path, natural arches and soles, exactly five toes per foot with clear toe separation, soft warm accents, and tasteful anime-CG sheen.',
            'Toenails: when visible, treat as distinct surfaces from skin and preserve existing polish color, finish, edge shape, and gloss character.',
            'Anatomical accuracy: exactly two arms, two legs, five fingers per hand, five toes per foot. Every limb traces a continuous path from joint to extremity and bends only in anatomically possible directions.',
            'When reference images are provided, use them as the identity, outfit, pose, composition, and value-structure anchor. Change only what the prompt requests.',
        ].join(' '),
    },
    preservation: {
        name: 'Reference Preservation',
        text: [
            'This is a localized preservation edit. The source image is the primary anchor.',
            'Preserve character identity, face, hairstyle, outfit design, composition, lighting intensity, value range, and non-target regions.',
            'Repair or enhance only the requested region. Do not globally reinterpret, beautify, redesign, or increase contrast unless explicitly requested.',
            'Use controlled satin highlights only. Keep the image anime first, polished second.',
        ].join(' '),
    },
    structural: {
        name: 'Anatomy Repair',
        text: [
            'Prioritize anatomical construction and continuity.',
            'Correct only visible structural errors. Ensure exactly two arms, two legs, five fingers per hand, and five toes per foot.',
            'Every limb must trace a continuous path from joint to extremity. Joints bend only in anatomically possible directions.',
            'Do not idealize, redesign, change outfit details, or change the scene beyond the requested correction.',
        ].join(' '),
    },
    custom: { name: 'Custom Director', text: '' },
};

const NBP_NEGATIVE_GUIDANCE = 'Avoid wet-looking skin, oily shine, greasy gloss, plastic skin, blown white highlight patches, exaggerated redness, extra toes, fused toes, missing toes, malformed feet, broken ankles, extra limbs, missing limbs, stronger contrast than the source image, photorealistic face drift, flat cartoon simplification, text, watermark, and signature.';
const NANOBANANA_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const NANOBANANA_FLASH31_EXTRA_RATIOS = ['1:4', '1:8', '4:1', '8:1'];

export function normalizeNbpDirectorPreset(value) {
    return Object.hasOwn(NBP_DIRECTOR_PROMPTS, value) ? value : 'house';
}

export function buildNbpDirectorInstruction(settings) {
    if (!settings?.nanobananaNbpMode) return '';
    const presetKey = normalizeNbpDirectorPreset(settings.nanobananaNbpPreset);
    const customDirector = String(settings.nanobananaNbpCustomDirector || '').trim();
    const preset = presetKey === 'custom' ? customDirector || NBP_DIRECTOR_PROMPTS.house.text : NBP_DIRECTOR_PROMPTS[presetKey].text;
    const custom = String(settings.nanobananaNbpCustomPrompt || '').trim();
    return ['Nano Banana Pro director instructions:', preset,
        custom ? `Scene-specific house direction: ${custom}` : '',
        settings.nanobananaNbpUseNegative !== false ? `Negative guidance: ${NBP_NEGATIVE_GUIDANCE}` : '',
    ].filter(Boolean).join(' ');
}

function dimension(value) {
    const parsed = parseInt(value, 10);
    return Math.max(1, Number.isFinite(parsed) ? parsed : 512);
}

export function getNanobananaAspectRatio(settings) {
    const ratio = dimension(settings?.width) / dimension(settings?.height);
    const options = /3\.1.*flash/i.test(settings?.nanobananaModel || '')
        ? [...NANOBANANA_ASPECT_RATIOS, ...NANOBANANA_FLASH31_EXTRA_RATIOS] : NANOBANANA_ASPECT_RATIOS;
    return options.reduce((best, option) => {
        const [width, height] = option.split(':').map(Number);
        const score = Math.abs(Math.log(ratio / (width / height)));
        return score < best.score ? { value: option, score } : best;
    }, { value: '1:1', score: Number.POSITIVE_INFINITY }).value;
}

export function getNanobananaImageSize(settings) {
    if (!/gemini-3/i.test(settings?.nanobananaModel || '')) return null;
    const maxSide = Math.max(dimension(settings?.width), dimension(settings?.height));
    if (/3\.1.*flash/i.test(settings?.nanobananaModel || '') && maxSide <= 512) return '512';
    if (maxSide >= 3072) return '4K';
    if (maxSide >= 1536) return '2K';
    return '1K';
}
