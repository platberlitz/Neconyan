// Theme colours are opaque so wallpaper cannot lower their measured contrast.
const dark = [20, 21, 20];
const light = [250, 247, 240];
const colour = value => {
    const hex = String(value).match(/^#([a-f\d]{6})$/i);
    if (hex) return hex[1].match(/../g).map(part => parseInt(part, 16));
    const numbers = String(value).match(/[\d.]+/g)?.map(Number);
    return numbers?.length >= 3 ? numbers : [...dark];
};
const mix = (a, b, amount) => a.slice(0, 3).map((channel, index) => Math.round(channel * (1 - amount) + b[index] * amount));
const css = value => `rgb(${value.slice(0, 3).join(', ')})`;
const luminance = value => colour(value).slice(0, 3).map(channel => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);

export function contrastRatio(a, b) {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
}

function readable(value, surfaces, ratio) {
    const original = colour(value);
    const score = candidate => Math.min(...surfaces.map(surface => contrastRatio(css(candidate), css(surface))));
    const target = score(dark) >= score(light) ? dark : light;
    for (let step = 0; step <= 100; step++) {
        const candidate = mix(original, target, step / 100);
        if (score(candidate) >= ratio) return css(candidate);
    }
    return css(target);
}

/** Rebuild a theme's paint, preserving its palette and layout settings, not legacy CSS overrides. */
export function accessibleTheme(theme) {
    if (!theme || theme.name === 'Neconyan Calico Dark') return theme;
    const result = { ...theme };
    const base = colour(theme.blur_tint_color);
    const canvas = mix(luminance(css(base)) > 0.4 ? light : dark, base, base[3] ?? 1);
    // Keep message surfaces in the same luminance range as the canvas.
    const surface = amount => mix(canvas, luminance(css(canvas)) > 0.4 ? dark : light, amount);
    const backgrounds = ['blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color'];
    const surfaces = [canvas, surface(0.03), surface(0.06), surface(0.03)];
    backgrounds.forEach((key, index) => { result[key] = css(surfaces[index]); });
    for (const key of ['main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color']) {
        result[key] = readable(theme[key] || theme.main_text_color, surfaces, 4.5);
    }
    result.border_color = readable(theme.border_color, surfaces, 3);
    result.blur_strength = 0;
    result.shadow_width = 0;
    // Legacy themes hard-code font families, black backgrounds and inaccessible link colours.
    result.custom_css = `body.neconyan { color-scheme: ${luminance(css(canvas)) > 0.4 ? 'light' : 'dark'}; }
body.neconyan :is(a, code) { color: var(--SmartThemeQuoteColor); }
body.neconyan ::selection { color: var(--SmartThemeBlurTintColor); background: var(--SmartThemeBodyColor); }`;
    return result;
}
