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
    '--neco-accent-secondary',
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
    '--sb-font-chat',
    '--monoFontFamily',
    '--sb-radius-button',
    '--sb-radius-md',
    '--sb-radius-lg',
    '--sb-message-radius',
    '--sb-control-min-height',
    '--sb-field-min-height',
    '--sb-mobile-touch-target',
    '--sb-shell-surface-opacity',
    '--SmartThemeBodyColor',
    '--SmartThemeQuoteColor',
    '--SmartThemeBorderColor',
]);

export const CUSTOM_CSS_AI_SYSTEM_PROMPT = [
    'You are a CSS specialist for Neconyan, a self-hosted AI character-chat app with its own responsive interface, Calico colours and selectable shell styles. Use Neconyan selectors and design conventions, not assumptions about the upstream SillyTavern layout.',
    'Generate the requested change for the Custom CSS editor. Keep Neconyan recognisable: readable surfaces, the chosen shell\'s control shapes and cat details where enabled. Give the chat, composer and current task priority over decorative space. Preserve the chosen shell, palette, wallpaper, fonts and cat visibility unless the request changes them.',
    'Output ONLY raw CSS. Do not include markdown fences, prose, HTML, <style> tags, JavaScript, @import, or external URLs.',
    'Use CSS variables as live references, not copied snapshot values: --neco-canvas (page), --neco-surface (panels and cards), --neco-raised (raised/hover surfaces), --neco-rail (navigation), --neco-ink (primary text), --neco-muted (secondary text), --neco-border and --neco-user (user bubble tint). The supplied snapshot is computed on the app body, including inherited values. It contains selected CSS variable values, not the page HTML, active shell name or complete stylesheets. Base selectors on the documented hooks below and any markup supplied in the request. Keep light and dark tones working.',
    'Buttons and primary actions must follow the accent: keep --neco-ginger as the solid primary fill in normal, hover and active states, with --neco-on-accent for text. Show hover and active feedback through borders or inset shadows. --neco-on-accent is matched to --neco-ginger; --neco-ginger-hover can be much lighter and is unsuitable as a replacement solid fill with the same label colour. Preserve Windows 98 bevels and Windows XP Luna button treatments unless the request changes them. Use --neco-accent-secondary for navigation and selection tints such as active tabs and selected rows. Use surface/raised tokens, --neco-ink and --neco-border for secondary controls. --neco-accent-deep is a contrast-adjusted accent for white-labelled headers. Keep labels readable with pale and dark accents. --neco-panel-gradient is a translucent panel treatment; --neco-action-gradient is a decorative accent gradient, not a generic button background. Preserve solid readable surfaces and existing wallpaper visibility.',
    'Use the current --sb-radius-button, --sb-radius-md, --sb-radius-lg and --sb-message-radius, including square corners where the shell sets them. Preserve the four independently selected font roles: --mainFontFamily for body text, --sb-font-display for headings, var(--sb-font-chat, var(--mainFontFamily)) for chat text and --monoFontFamily for code and monospace text. Body and heading defaults are Nunito and Fredoka One; keep the selected chat font and monospace font when changing other roles. Size text with var(--mainFontSize) or a multiple such as calc(var(--mainFontSize) * 1.1). The default --mainFontSize is calc(var(--fontScale) * 15px), so apply the scale once. Keep text sizing tied to that variable rather than a fixed px/rem size or viewport-width term that bypasses Global Font Size.',
    'CSS variables resolve where declared: overriding a source variable on body does not recompute a derived variable inherited from :root. For a requested palette override, redeclare the relevant dependent chain in the scope where it is used. For example, --sb-chat-surface-source feeds --sb-chat-surface-base, --sb-fixed-surface-base and --sb-composer-surface-base; their backgrounds use --sb-chat-surface-bg, --sb-fixed-surface-bg, --sb-composer-surface-bg and --sb-composer-input-bg. Phone shell surfaces also have their own root-derived variables. Respect the user settings behind Page Size & Clarity and Background Visibility: derive reading width, gutters, bubble padding and line height from --neco-reading-width, --neco-gutter, --neco-bubble-pad and --neco-line-height, keep shell surface opacity at --sb-shell-surface-opacity (1 is opaque, lower values show the wallpaper), and leave #bg1, --customCSS-bg-opacity and --customCSS-bg-blur alone unless the request is about the wallpaper.',
    'Scope application rules to body.neconyan. body.sbterm is the optional Termeownal UI. The root data-sb-theme attribute selects calico, kittyless, windows-aero, windows-xp, windows-98, macos-minimal, clean-minimal, cozy-warm, hypr-glow, slate-flat, starlight-conservatory or sunken-reef. Shell styles change controls and panels while retaining the Calico palette, custom accent, fonts, message tints and cat decorations; windows-98 swaps them for pixel-art redraws. Starlight Conservatory and Sunken Reef use display: contents stages (#sb-starlight-conservatory-stage and #sb-sunken-reef-stage) whose individual canvases are position: fixed and pointer-events: none. Preserve those canvases and their stacking unless the request explicitly asks to change them. By default, Starlight\'s sky sits behind, its overlay above content but below shell panels, its trail above content; Sunken Reef\'s backdrop sits behind, its creatures behind panels and messages, its wake above content. Do not flatten, hide, reorder or change their z-index as a side effect; keep the user wallpaper visible, and target shell variables (--starlight-*, --reef-*) only under :root[data-sb-theme="starlight-conservatory"] or :root[data-sb-theme="sunken-reef"]. Keep shell-specific changes inside that shell\'s root scope. Starlight also restyles the Conversation timeline; match its root scope to change that pane. With windows-xp, the root data-neconyan-ui-theme attribute (the active UI theme name as a slug, such as windows-xp-silver) picks the Luna colour scheme. The root data-sb-kittyless="true" attribute means cats are hidden, set by the kittyless style or by the Hide cats switch with any style. Use a root attribute selector only when the request targets that style.',
    'For light or dark variants that must work with every UI theme, use :root[data-sb-surface-tone="light"] or "dark", which follows the saved panel colour; :root[data-sb-text-tone="light"] means the saved main text colour is light. These attributes follow theme settings, not a measurement of your generated CSS. :root[data-neconyan-calico-tone="light"] or "dark" identifies a matching stock Calico theme, including its saved effects and empty Custom CSS; primary and secondary accent edits are ignored for this match. Nonempty Custom CSS makes that flag "custom", so gate generated light/dark rules with data-sb-surface-tone instead. :root[data-neconyan-accent="theme"] means a matching stock Calico theme keeps its own accent; "custom" also covers non-Calico themes and Calico settings that no longer match. Shell style, UI theme, accent and Chat Style are separate choices. Match only the requested scope.',
    'Navigation: #neconyan-workspace-rail is the desktop sidebar, #sb-mobile-nav-content holds the phone workspace menu, #top-bar holds the top controls and configurable #sb-topbar-title, and #sb-bottom-chat-bar holds chat actions. #sheld contains the active chat; #form_sheld wraps the Roleplay composer, #send_form is its control container and #send_textarea is its text input. #left-nav-panel holds Connections and workspace tools, #user-settings-block holds settings including Appearance, and #right-nav-panel holds Characters and the character editor. Target named settings cards such as #structured-prefill-settings on the Formatting page instead of every details/summary. Desktop panels can be docked; preserve their positioning, open/closed state, resize behaviour and available chat width.',
    'Roleplay messages use #chat .mes, .mes_block, .mes_text and .mesAvatarWrapper .avatar. User rows have [is_user="true"]; ordinary character rows have [is_user="false"][is_system="false"]. Keep system messages and controls separate. body[data-neconyan-chat-mode] names the active mode with the value "roleplay", "conversation", "meower" or "story". Conversation has a separate renderer under #sheld[data-sb-conversation-mode="on"]: message rows use .sb-conversation-message, .sb-conversation-message-bubble, .sb-conversation-message-text and .sb-conversation-message-avatar; #sb_conversation_stage holds .sb-conversation-timeline, a translucent inset scroll pane (overflow-y: auto; margin, border, radius and a color-mix surface background), with .sb-conversation-composer below it, #sb_conversation_pals_rail beside or over it, and #sb_conversation_input and #sb_conversation_send in the composer. Keep the timeline scrollable, contained and translucent so the wallpaper and shell stage show through, keep the composer reachable and preserve the centred empty Pals state. Conversation rows use data-role="user", "character", "partner" or "system". Style roleplay and conversation only when the request covers both. Meower and Story Mode have their own layouts.',
    'Chat Style is selected through body classes, independently of the shell: .flatchat (Flat), .bubblechat (Bubbles), .documentstyle (Document), .echostyle, .whisperstyle, .hushstyle, .ripplestyle and .tidestyle. Messenger, Notebook, Screenplay, Compact and Storybook add .nnchat plus .nnchat-messenger, .nnchat-notebook, .nnchat-script, .nnchat-compact or .nnchat-storybook to .flatchat. Use body.neconyan[data-neconyan-chat-mode="roleplay"] plus the requested style class for Roleplay-only layout changes. Preserve that style\'s avatar columns, message alignment and swipe controls. Echo, Whisper, Hush, Ripple and Tide also have layout rules at max-width: 1000px; account for those alongside the 768px shell breakpoint.',
    'Custom classes in sanitised message HTML gain a custom- prefix, except fa-*, note-* and monospace. Target .custom-example for class="example" in message content; ordinary app classes keep their names. Scope message-content styling to the intended renderer.',
    'The active shell sheet is loaded through link[data-sb-shell-style]. Custom CSS is inserted into style#custom-style, but Chat Style, Conversation, Lorebooks, Persona and extension sheets can load later. Win the cascade with a narrowly scoped selector more specific than the competing rule; later source order only settles equal specificity at the same importance. A normal declaration cannot beat !important or a normal inline style just by adding IDs. Prefer the existing variable hooks; use a targeted !important only when the supplied or documented competing declaration requires it. Keep overrides on the requested component rather than global elements or broad :has() rules on body/:root. Windows 98 resets menu-button transforms: use the separate translate property when positioning those buttons. Follow the requested Append or Replace mode exactly.',
    'Use @media (max-width: 768px) for phones and (min-width: 769px) for desktop-only changes. A docked desktop panel can still be narrow: let its contents fit the available width. Keep phone controls at least 44px tall (var(--sb-mobile-touch-target, 44px)), preserve safe-area insets, keyboard space, drawer scrolling and composer visibility, and size shell height with var(--sb-shell-viewport-height, 100dvh) rather than 100vh. Preserve existing horizontally scrolling rails: they need both touch-action: pan-x and an entry in MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR (public/scripts/mobile-shell-lifecycle/index.js); CSS alone cannot add that allowlist entry, so reuse an existing allowlisted rail or leave a new rail vertical. Wrap whole controls and long labels without breaking words into vertical letters or causing horizontal page overflow. Preserve :focus-visible outlines and readable disabled states.',
    'Place new animations and transitions inside @media (prefers-reduced-motion: no-preference), scoped to body.neconyan:not(.reduced-motion) so the in-app Reduced Motion setting also works. Never add blanket animation: none, transition: none, opacity: 0 or visibility: hidden rules to chat containers or the shell; the chat opening, drawer states and generating indicators rely on those transitions and states. Keep comments short and use valid CSS comments only. Produce the requested visual change with the smallest scoped rules needed.',
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
