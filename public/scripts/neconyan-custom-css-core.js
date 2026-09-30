/** DOM-free custom CSS prompt helpers shared by the page and the native server job. */
export const CUSTOM_CSS_AI_MAX_TOKENS = 3072;

export const CUSTOM_CSS_AI_PALETTE_VARIABLES = Object.freeze([
    '--neco-canvas',
    '--neco-surface',
    '--neco-raised',
    '--neco-ink',
    '--neco-muted',
    '--neco-ginger',
    '--neco-ginger-hover',
    '--neco-border',
    '--neco-user',
    '--neco-on-accent',
    '--neco-cream',
    '--neco-charcoal',
    '--neco-panel-gradient',
    '--neco-action-gradient',
    '--mainFontFamily',
    '--mainFontSize',
    '--sb-radius-button',
    '--sb-radius-md',
    '--sb-radius-lg',
    '--sb-message-radius',
    '--sb-control-min-height',
    '--sb-field-min-height',
    '--sb-mobile-touch-target',
    '--SmartThemeBodyColor',
    '--SmartThemeQuoteColor',
    '--SmartThemeBorderColor',
]);

export const CUSTOM_CSS_AI_SYSTEM_PROMPT = [
    'You are a CSS specialist for the current Neconyan interface: a responsive character-chat app with Calico colours and selectable shell styles.',
    'Generate custom CSS for the Custom CSS editor.',
    'Output ONLY raw CSS. Do not include markdown fences, prose, HTML, <style> tags, JavaScript, @import, or external URLs.',
    'Style with the theme tokens instead of hard-coded colours so both Calico tones keep working: --neco-canvas (page background), --neco-surface (panels and cards), --neco-raised (hover surfaces), --neco-ink (primary text), --neco-muted (secondary text), --neco-ginger (accent), --neco-ginger-hover, --neco-border, --neco-user (user bubble tint), --neco-on-accent (text on the accent), --neco-panel-gradient and --neco-action-gradient (translucent panel/button fills).',
    'Use the current values of --sb-radius-button, --sb-radius-md, --sb-radius-lg and --sb-message-radius rather than assuming fixed radii. Use --mainFontFamily and --mainFontSize; the bundled default is Nunito for body text and Fredoka One for headings.',
    'Scope application rules to body.neconyan. body.sbterm is the optional Termeownal UI. The root data-sb-theme attribute selects calico, kittyless, windows-aero, windows-98, macos-minimal, clean-minimal, cozy-warm, hypr-glow or slate-flat. Shell styles change controls and panels while retaining the Calico palette, custom accent, fonts, message tints and cat decorations; kittyless hides the decorations and windows-98 swaps them for pixel-art redraws. Use a root attribute selector only when the request targets that style.',
    'Light/dark Calico uses :root[data-neconyan-calico-tone="light"] or "dark"; custom accents use data-neconyan-accent="custom". Preserve translucent fills and the chosen wallpaper unless the request changes them. Keep text readable in both tones.',
    'Navigation: #neconyan-workspace-rail is the desktop sidebar, #sb-mobile-nav-content holds the phone workspace menu, #top-bar holds the top controls and current model, and #sb-bottom-chat-bar holds chat actions. #sheld contains the active chat; #form_sheld contains the composer and #send_textarea is its text input. Settings and character workspaces use #left-nav-panel and #right-nav-panel; desktop panels can be docked. Preserve their positioning, open/closed state, resize behaviour and available chat width.',
    'Roleplay messages use #chat .mes, .mes_text and .avatar. Conversation has a separate renderer under #sheld[data-sb-conversation-mode="on"]: .sb-conversation-timeline, .sb-conversation-message, .sb-conversation-message-bubble, .sb-conversation-message-text and .sb-conversation-message-avatar, with #sb_conversation_input and #sb_conversation_send for its composer. A user DM has [data-role="user"]; target other roles separately. Style both renderers only when the request covers both. Meower and Story Mode have their own layouts.',
    'The active shell sheet is loaded through link[data-sb-shell-style]. Conversation, Lorebooks, Persona and extension styles can load after core styles. Beat the specific target rule with one additional scoped class or ID; avoid global element overrides and blanket !important. Keep unrelated current custom CSS when returning a replacement stylesheet.',
    'Use @media (max-width: 768px) for phones and (min-width: 769px) for desktop-only changes. Keep phone controls at least 44px tall, preserve safe-area insets, keyboard space, drawer scrolling and composer visibility, and allow long labels to wrap without horizontal page overflow. Preserve :focus-visible outlines and readable disabled states.',
    'Place new animations and transitions inside @media (prefers-reduced-motion: no-preference), scoped to body.neconyan:not(.reduced-motion) so the in-app Reduced Motion setting also works. Keep comments short and use valid CSS comments only. Produce the requested visual change with the smallest scoped rules needed.',
].join(' ');

export function stripCssMarkdownFences(text = '') {
    const value = String(text ?? '').trim();
    const fencedBlock = value.match(/```(?:css)?\s*([\s\S]*?)```/i);
    if (fencedBlock) {
        return fencedBlock[1].trim();
    }

    return value
        .replace(/^```(?:css)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

export function normalizeGeneratedCustomCss(text = '') {
    return stripCssMarkdownFences(text)
        .replace(/^<style[^>]*>/i, '')
        .replace(/<\/style>$/i, '')
        .trim();
}

export function buildCustomCssAIMessages({ instruction = '', currentCss = '', paletteSnapshot = '', mode = 'replace' } = {}) {
    const request = String(instruction ?? '').trim();
    const current = String(currentCss ?? '').trim();
    const palette = String(paletteSnapshot ?? '').trim();

    const userContent = [
        `Request:\n${request}`,
        `Current custom CSS:\n${current || '/* No custom CSS is currently set. */'}`,
        palette ? `Current theme CSS variables:\n${palette}` : '',
        mode === 'append'
            ? 'Append mode: return only the new rules. The application will append them to the existing CSS; omit copies of existing rules.'
            : 'Replace mode: return the complete updated stylesheet, preserving unrelated existing rules.',
        'Return CSS that can be pasted directly into the Custom CSS textarea.',
    ].filter(Boolean).join('\n\n');

    return [
        { role: 'system', content: CUSTOM_CSS_AI_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
    ];
}
