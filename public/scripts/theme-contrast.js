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
    // Opaque, pure-black presets must stay black, including after saving or renaming.
    const amoled = backgrounds.every(key => {
        const channels = colour(theme[key]);
        return channels.slice(0, 3).every(channel => channel === 0) && (channels[3] ?? 1) === 1;
    });
    const surfaces = amoled ? backgrounds.map(() => canvas) : [canvas, surface(0.03), surface(0.06), surface(0.03)];
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
    if (amoled) {
        result.custom_css += `
:root:root:root body.neconyan:not(.sbterm),
:root:root:root body.neconyan:not(.sbterm) :is(#sheld, #form_sheld, #send_form, #sb-bottom-chat-bar, .sb-shell-frame, .sb-shell-main, .sb-shell-nav, .sb-character-shell-nav, dialog.popup) { --neco-surface: var(--SmartThemeChatTintColor); --neco-rail: var(--SmartThemeBlurTintColor); --neco-raised: var(--SmartThemeChatTintColor); --neco-panel-gradient: var(--SmartThemeChatTintColor); --neco-canvas-gradient: var(--SmartThemeBlurTintColor); --neco-action-gradient: var(--SmartThemeChatTintColor); --neco-on-accent: var(--SmartThemeBodyColor); --neco-border: var(--SmartThemeBorderColor); }
:root body.neconyan::before { display: none; }
:root body.neconyan :is(#bg1, #bg_custom) { visibility: hidden; }
:root:root:root body.neconyan:not(.sbterm) :is(#top-bar, #neconyan-workspace-rail, #sb-mobile-nav-content, #sb-mobile-nav, #sb-bottom-chat-bar, #send_form, .sb-shell-frame, .sb-shell-main, .sb-shell-nav, .sb-character-shell-nav, .sb-shell-header, dialog.popup, .neconyan-home-layout-bar, .neconyan-assistant-picker, .neconyan-assistant-row, .neconyan-home-actions > button, .neconyan-assistant-open, .menu_button, .sb-proxy-button, .sb-shell-tab, .sb-settings-tab-btn, .neconyan-rail-button, .neconyan-mode-button, input:not([type='checkbox'], [type='radio'], [type='range'], [type='color']), textarea, select, .mes .mes_block, .sb-conversation-message .sb-conversation-message-bubble, #rm_print_characters_block > :is(.character_select, .group_select)):not(#bg1):not(#bg_custom) { background: var(--SmartThemeChatTintColor); }
:root:root:root body.neconyan:not(.sbterm) :is(.neconyan-home-actions > button, .neconyan-assistant-open, .menu_button_primary, .popup-button-ok) { color: var(--SmartThemeBodyColor); border-color: var(--SmartThemeBorderColor); }`;
        result.custom_css += `
:root:root:root body.neconyan:not(.sbterm) #neconyan-home-host :is(.neconyan-home-intro, .welcomeRecentShell, button),
:root:root:root body.neconyan:not(.sbterm) .neconyan-home-layout button { background: var(--SmartThemeChatTintColor); color: var(--SmartThemeBodyColor); }
:root:root:root body.neconyan:not(.sbterm) #neconyan-workspace-rail .neconyan-rail-new:not(#bg1):not(#bg_custom) { background: var(--SmartThemeChatTintColor); color: var(--SmartThemeBodyColor); border-color: var(--SmartThemeBorderColor); }
:root:root:root body.neconyan:not(.sbterm) #form_sheld { background: var(--SmartThemeChatTintColor); }`;
    }
    return result;
}
