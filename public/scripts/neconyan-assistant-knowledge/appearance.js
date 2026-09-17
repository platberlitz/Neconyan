const html = 'public/index.html';
const theme = 'public/scripts/power-user.js';
const colors = 'public/scripts/extensions/third-party/sillytavern-character-colors/src/';

export default [
    {
        id: 'appearance.dialogue', title: 'Changing individual speakers’ dialogue colours', keys: ['dialogue colours', 'dialogue colors', 'speaker colours', 'character colors', 'speech colours', 'speech color', 'different colour for each character'],
        covers: ['extension:third-party/sillytavern-character-colors'], sources: [colors + 'ui.js', 'public/scripts/neconyan-tabs.js'], anchors: ['Primary color', 'Add current card'],
        content: 'For individual speakers in Roleplay: open Included tools → Dialogue Colors → Settings → Characters. On a phone, first open the top-bar workspace menu. Select the colour swatch beside the speaker, or Edit → Primary color to enter a hex colour. If absent, type the speaker\'s name and choose Add; Advanced offers Add current card and Add my persona. Committing the colour applies it and saves automatically; there is no general Save button for each swatch. Colors saved chooses Per chat, Per card or Global scope. For ordinary quoted text instead, use Settings → Appearance → Theme Colors → Quote Text.',
    },
    {
        id: 'appearance.quote', title: 'Changing the ordinary quotation colour', keys: ['quote text', 'quote colour', 'quote color', 'quoted dialogue', 'quotation colour', 'dialogue colours', 'dialogue colors'],
        covers: ['settings:appearance'], sources: [html, theme, 'public/style.css'], anchors: ['Quote Text', 'quote-color-picker'],
        content: 'Open Settings → Appearance → Theme Colors → Quote Text. On a phone, open Settings through the workspace menu. The change applies immediately and saves to account settings; saving a named theme is separate. Quote Text affects normally formatted quotations and is also tied to the primary accent. Explicit font-colour tags from Dialogue Colors can take precedence. Use Included tools → Dialogue Colors → Settings → Characters when you want different colours for named speakers. User Message and AI Message are background tints, not independent speaker-text colours.',
    },
    {
        id: 'appearance.dialogue-scope', title: 'Where Dialogue Colors saves assignments', keys: ['colors saved', 'per chat colour', 'per card colour', 'global colours', 'dialogue colors scope', 'only this chat', 'only for this chat', 'save colours to card'],
        sources: [colors + 'ui.js', colors + 'storage.js', colors + 'state.js'], anchors: ['Save to card', 'Storage & transfer'],
        content: 'In Dialogue Colors → Settings, Colors saved selects Per chat, Per card or Global. Per chat keeps a table for that chat; Per card reuses its card identity, with a separate group identity; Global shares a table across the account. Scope changes offer copy/start-empty or destination/merge/replace choices. Ordinary changes save to account settings. Per card does not embed colours in an exported card: use Storage & transfer → Save to card explicitly. Enable auto-sync is separate from ordinary server saving and starts off. Wait for save verification; use the shown error if a write fails.',
    },
    {
        id: 'appearance.dialogue-method', title: 'Dialogue Colors: stored tags versus local display', keys: ['local coloring', 'DOM only', 'LLM coloring', 'colorize', 'verify speakers', 'auto recolor', 'dialogue colors method'],
        sources: [colors + 'live-colors.js', colors + 'state.js', colors + 'ui.js'], anchors: ['LLM', 'Auto-recolor'],
        content: 'Dialogue Colors offers LLM colouring and Local (DOM-only). LLM colouring can store font-colour tags in chat; Auto-recolor after changes can rewrite existing saved colour tags. Local colours the displayed page without rewriting message text, though speaker assignments can still be saved as chat metadata. Gradients are local appearance. Colorize and Verify are separate actions from manually changing a swatch; optional attribution verification can call a model even with local colouring. The shipped defaults enable the tool, Per card scope, LLM colouring and automatic recolouring.',
    },
    {
        id: 'appearance.dialogue-palette', title: 'Dialogue palettes, locks, brightness and fonts', keys: ['new color palette', 'regenerate unlocked', 'lock colours', 'keep character colour', 'dialogue brightness', 'highlight dialogue', 'dialogue font'],
        sources: [colors + 'ui.js', colors + 'state.js'], anchors: ['Regenerate unlocked', 'Highlight dialogue'],
        content: 'New-color palette affects future assignments; it does not regenerate the existing cast. Use Regenerate unlocked for that. Lock protects against regeneration, not deliberate manual edits. Keep protects an entry from clearing/deletion. Color brightness can follow the theme automatically, making the displayed colour lighter or darker than the stored hex colour. Highlight dialogue adds colour behind dialogue passages, not behind whole messages. Speaker editing also offers typography/gradient options. Remote Google Fonts are opt-in; local fonts and remote font consent are different settings.',
    },
    {
        id: 'appearance.theme', title: 'Themes, palettes and named theme presets', keys: ['theme', 'Calico', 'dark mode', 'light mode', 'theme preset', 'accent colour', 'accent color'],
        sources: [html, theme, 'public/scripts/theme-contrast.js'], anchors: ['Theme Colors', 'Calico Dark'],
        content: 'Open Settings → Appearance for theme presets and Theme Colors. A theme changes interface appearance; it is not a model preset or agent setup. Colour edits apply immediately, while saving a named theme preset is an explicit separate operation. Bundled theme loading can adjust colours for contrast; Calico Dark has its own handling. Custom CSS and explicit message colour tags can override a theme. If a change looks ineffective, identify the actual coloured element and check those overrides.',
    },
    {
        id: 'appearance.backgrounds', title: 'Message backgrounds and wallpaper', keys: ['background colour', 'background color', 'AI message color', 'user message color', 'wallpaper', 'chat background', 'main text'],
        sources: [html, theme, 'public/scripts/backgrounds.js'], anchors: ['Main Text', 'User Message', 'AI Message', 'Chat Background'],
        content: 'Settings → Appearance → Theme Colors has Main Text for general text, User Message and AI Message for message-background tints, and Chat Background for theme surfaces. Their visible effect depends on chat style and transparency. The Background workspace chooses wallpaper images instead. Highlight dialogue in Dialogue Colors affects passages rather than whole message backgrounds. Ask which of these the user wants when they say only \'change the background colour\'.',
    },
    {
        id: 'appearance.chat-style', title: 'Chat styles, avatars and text sizing', keys: ['chat style', 'bubbles', 'document style', 'avatar size', 'font size', 'text size', 'text bigger', 'larger text', 'smaller text', 'line spacing'],
        sources: [html, 'public/scripts/neconyan-tabs.js', 'public/css/neconyan-chat-styles.css'], anchors: ['Bubbles', 'Document'],
        content: 'Use Settings → Appearance for chat/avatar styles and text/layout controls. Flat, Bubbles and Document are layout choices; theme colours and wallpaper remain separate. Adjust text size/spacing for readability rather than changing the model\'s reply settings. Roleplay and Conversation render messages differently, so a Roleplay style setting is not a promise of identical DM layout. Avatar artwork comes from the card/persona; style and size control its presentation.',
    },
    {
        id: 'appearance.fonts', title: 'Interface fonts and remote fonts', keys: ['font', 'Nunito', 'Fredoka', 'Google Fonts', 'change typeface'],
        sources: ['DESIGN.md', html, theme], anchors: ['Nunito'],
        content: 'Neconyan bundles Nunito for body text and Fredoka One for headings. Appearance contains font controls, while Dialogue Colors can style individual speakers. Choosing a font for dialogue is not the same as changing the interface font. Remote font options can make external requests and may need consent; an unavailable font may fall back to a local one. Use the exact font field shown in the relevant panel instead of assuming every mode shares one control.',
    },
    {
        id: 'appearance.accessibility', title: 'Reduced motion and readable layouts', keys: ['reduced motion', 'animations', 'accessibility', 'contrast', 'keyboard focus'],
        sources: [html, 'DESIGN.md', 'public/scripts/theme-contrast.js'], anchors: ['Reduced Motion'],
        content: 'Settings → Appearance includes Reduced Motion. Enable it to reduce decorative movement; operating-system motion preferences are also respected by supported styles. Use readable text sizes and contrasting text/background colours. Keyboard focus should remain visible on controls. Custom CSS may override accessibility styles, so remove or narrow the offending rule when diagnosing unreadable text or hidden focus.',
    },
    {
        id: 'appearance.custom-css', title: 'Custom CSS and appearance troubleshooting', keys: ['custom CSS', 'style override', 'broken theme', 'unreadable text', 'colour not changing'],
        sources: [html, theme, 'public/style.css'], anchors: ['CustomCSS-block'],
        content: 'Custom CSS in Appearance changes styling rules. Keep a copy before editing it and test both desktop and phone. When colours do not change, check whether you changed text, quote colour, message tint or wallpaper, then check explicit colour tags and custom CSS. A selector that affects one chat renderer may not affect Conversation or Story Mode. The assistant cannot infer your custom rules without seeing them; ask for the relevant rule or a screenshot.',
    },
];
