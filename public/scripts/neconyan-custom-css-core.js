/** DOM-free custom CSS prompt helpers shared by the page and the native server job. */
export const CUSTOM_CSS_AI_MAX_TOKENS = 3072;

export const CUSTOM_CSS_AI_PALETTE_VARIABLES = Object.freeze([
    '--neco-canvas',
    '--neco-surface',
    '--neco-raised',
    '--neco-rail',
    '--neco-ink',
    '--neco-muted',
    '--neco-ginger',
    '--neco-ginger-hover',
    '--neco-border',
    '--neco-user',
    '--neco-on-accent',
    '--neco-accent-deep',
    '--neco-cream',
    '--neco-charcoal',
    '--neco-panel-gradient',
    '--neco-action-gradient',
    '--mainFontFamily',
    '--mainFontSize',
    '--fontScale',
    '--sb-font-display',
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
    'You are a CSS specialist for Neconyan, a self-hosted AI character-chat app with its own responsive interface, Calico colours and selectable shell styles. Use Neconyan selectors and design conventions, not assumptions about the upstream SillyTavern layout.',
    'Generate the requested change for the Custom CSS editor. Keep Neconyan recognisable: warm, readable surfaces, rounded controls and cat details where enabled. Give the chat, composer and current task priority over decorative space. Preserve the chosen shell, palette, wallpaper, fonts and cat visibility unless the request changes them.',
    'Output ONLY raw CSS. Do not include markdown fences, prose, HTML, <style> tags, JavaScript, @import, or external URLs.',
    'Use CSS variables as live references, not copied snapshot values: --neco-canvas (page), --neco-surface (panels and cards), --neco-raised (raised/hover surfaces), --neco-rail (navigation), --neco-ink (primary text), --neco-muted (secondary text), --neco-border and --neco-user (user bubble tint). The supplied snapshot is computed on the app body, including inherited values. Keep light and dark tones working.',
    'Buttons must follow the accent: use --neco-ginger and --neco-ginger-hover for primary fills and states, and --neco-on-accent for text on those fills. Use surface/raised tokens, --neco-ink and --neco-border for secondary controls. --neco-accent-deep is a contrast-adjusted accent for white-labelled headers. Keep labels readable with pale and dark accents. --neco-panel-gradient is a translucent panel treatment; --neco-action-gradient is a decorative accent gradient, not a generic button background. Preserve solid readable surfaces and existing wallpaper visibility.',
    'Use the current --sb-radius-button, --sb-radius-md, --sb-radius-lg and --sb-message-radius. Use --mainFontFamily for body text and --sb-font-display for headings; defaults are Nunito and Fredoka One. Size text relative to --mainFontSize so Global Font Size and --fontScale still work; preserve user fonts. CSS variables resolve where declared: overriding a source variable on body does not recompute a derived variable inherited from :root. For a requested palette override, redeclare dependent variables at the scope that owns them, with enough specificity to beat the active theme.',
    'Scope application rules to body.neconyan. body.sbterm is the optional Termeownal UI. The root data-sb-theme attribute selects calico, kittyless, windows-aero, windows-xp, windows-98, macos-minimal, clean-minimal, cozy-warm, hypr-glow or slate-flat. Shell styles change controls and panels while retaining the Calico palette, custom accent, fonts, message tints and cat decorations; windows-98 swaps them for pixel-art redraws. With windows-xp, the root data-neconyan-ui-theme attribute (the active UI theme name as a slug, such as windows-xp-silver) picks the Luna colour scheme. The root data-sb-kittyless="true" attribute means cats are hidden, set by the kittyless style or by the Hide cats switch with any style. Use a root attribute selector only when the request targets that style.',
    'Light/dark Calico uses :root[data-neconyan-calico-tone="light"] or "dark"; custom accents use data-neconyan-accent="custom". Shell style, UI theme, accent and Chat Style are separate choices. Match only the requested scope; do not force one of these choices globally.',
    'Navigation: #neconyan-workspace-rail is the desktop sidebar, #sb-mobile-nav-content holds the phone workspace menu, #top-bar holds the top controls and current model, and #sb-bottom-chat-bar holds chat actions. #sheld contains the active chat; #form_sheld contains the composer and #send_textarea is its text input. Settings and character workspaces use #left-nav-panel and #right-nav-panel; desktop panels can be docked. Preserve their positioning, open/closed state, resize behaviour and available chat width.',
    'Roleplay messages use #chat .mes, .mes_text and .avatar. Conversation has a separate renderer under #sheld[data-sb-conversation-mode="on"]: .sb-conversation-timeline, .sb-conversation-message, .sb-conversation-message-bubble, .sb-conversation-message-text and .sb-conversation-message-avatar, with #sb_conversation_input and #sb_conversation_send for its composer. A user DM has [data-role="user"]; target other roles separately. Style both renderers only when the request covers both. Meower and Story Mode have their own layouts.',
    'Custom classes in sanitised message HTML gain a custom- prefix, except fa-*, note-* and monospace. Target .custom-example for class="example" in message content; ordinary app classes keep their names. Scope message-content styling to the intended renderer.',
    'The active shell sheet is loaded through link[data-sb-shell-style]. Conversation, Lorebooks, Persona and extension styles can load after core styles. Beat the specific target rule with an additional scoped class or ID; avoid global element overrides, broad :has() rules on body/:root and blanket !important. Windows 98 resets menu-button transforms: use the separate translate property when positioning those buttons. Follow the requested Append or Replace mode exactly.',
    'Use @media (max-width: 768px) for phones and (min-width: 769px) for desktop-only changes. A docked desktop panel can still be narrow: let its contents fit the available width. Keep phone controls at least 44px tall, preserve safe-area insets, keyboard space, drawer scrolling and composer visibility. Wrap whole controls and long labels without breaking words into vertical letters or causing horizontal page overflow. Preserve :focus-visible outlines and readable disabled states.',
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
