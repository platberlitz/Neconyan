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
        content: 'Open Settings → Appearance → Theme Colors → Quote Text. On a phone, open Settings through the workspace menu. The change applies immediately and saves to account settings; saving a named theme is separate. Quote Text is the same colour as Primary Accent under Presets, so choosing an Accent Colors swatch or applying an Accent Profile replaces it (and Underlined Text). Explicit font-colour tags from Dialogue Colors can take precedence. Use Included tools → Dialogue Colors → Settings → Characters when you want different colours for named speakers. User Message and AI Message are background tints, not independent speaker-text colours.',
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
        id: 'appearance.theme', title: 'Themes, palettes and named theme presets', keys: ['theme', 'Calico', 'dark mode', 'light mode', 'theme preset'],
        sources: [html, theme, 'public/scripts/theme-contrast.js', 'public/scripts/neconyan-tabs.js', 'public/scripts/neconyan-settings-tabs.js'], anchors: ['Theme Colors', 'Calico Dark', 'Save as a new theme', 'Custom RGB Accent', 'Shell Style', 'Windows Aero'],
        content: 'Open Settings → Appearance. UI Theme holds the saved theme list with Import, Export, Delete, Update a theme file and Save as a new theme. Presets holds Neconyan palettes; Reset returns colours to Neconyan Calico Dark. Shell Style separately chooses how controls and panels look. A theme is interface appearance, not a model preset. Colour edits apply immediately; saving a named theme is separate. Loading a theme other than Calico Dark can adjust its colours for contrast. Custom CSS and message colour tags can override a theme.',
    },
    {
        id: 'appearance.shell-style', title: 'Changing Shell Style while keeping Calico colours', keys: ['shell style', 'Windows Aero', 'macOS Minimal', 'Clean Minimal', 'Cozy Warm', 'Hypr Glow', 'Slate Flat'],
        sources: ['public/scripts/neconyan-tabs.js', 'public/css/shell-styles/windows-aero.css', 'public/css/shell-styles/kittyless.css', 'public/css/shell-styles/windows-98.css', 'public/css/neconyan-calico.css'], anchors: ['Shell Style', 'Kittyless', 'Windows Aero', 'Windows 98', '--neco-ginger'],
        content: 'Settings → Appearance → UI Theme → Shell Style offers Calico, Kittyless, Windows Aero, Windows 98, macOS Minimal, Clean Minimal, Cozy Warm, Hypr Glow and Slate Flat. Each changes controls, panels and navigation while keeping the Calico light/dark palette, chosen accent, fonts and message tints. Kittyless hides decorative animals; Windows 98 replaces the bundled decorations and assistant portraits with pixel art. Other styles keep the cat decorations. Your chosen wallpaper remains selected. Custom RGB Accent also colours the selected shell style. Shell Style is separate from Chat Style, which changes messages, and from a saved model preset. Switching appearance makes no model request.',
    },
    {
        id: 'appearance.kittyless', title: 'Kittyless, hidden cats and loading artwork', keys: ['Kittyless', 'hide cats', 'hide paws', 'Show assistants', 'Kittyless loading screen', 'woodland railway'],
        sources: ['public/css/shell-styles/kittyless.css', 'public/scripts/welcome-screen.js', 'public/scripts/neconyan-tabs.js'], anchors: ['Show assistants', 'loader-kittyless-wide.webp', 'loader-kittyless-tall.webp'],
        content: 'Choose Settings → Appearance → UI Theme → Shell Style → Kittyless for solid rounded panels and pill actions without decorative cats, ears, whiskers, paw textures or sleeping animals. Home folds assistant choices behind Show assistants; character and assistant portraits remain available. The default background is a quiet woodland railway at dusk. Kittyless also has dedicated wide and tall loading artwork in place of the startup mascot. A wallpaper you selected stays selected, including any animals in that image. Your light/dark palette, accent and fonts stay available. This appearance change makes no model request and does not remove assistant cards or chats.',
    },
    {
        id: 'appearance.windows-98', title: 'Windows 98 shell and pixel-art assistants', keys: ['Windows 98', 'retro', 'pixel art', 'pixel-art portraits', 'pixel cats'],
        sources: ['public/css/shell-styles/windows-98.css', 'public/scripts/neconyan-tabs.js', 'public/scripts/welcome-screen.js'], anchors: ['Windows 98', 'windows-98'],
        content: 'Choose Settings → Appearance → UI Theme → Shell Style → Windows 98 for grey bevelled windows, navy title bars and square buttons. Bundled cats, ears, paws, sleeping animals, the startup cat, assistant portraits and assistant icons use 256-colour pixel-art redraws, with a pixel cloud-sky default background. Portraits of characters you made or imported are unchanged. Your chosen wallpaper remains selected, and light/dark palettes, accents and fonts are still available. These are display changes, not new assistant identities or replacement cards; changing the style makes no model request.',
    },
    {
        id: 'appearance.accent', title: 'Accent colours and saved accent profiles', keys: ['accent colour', 'accent color', 'Custom RGB Accent', 'accent profile', 'Accent Colors'],
        sources: [html, theme, 'public/scripts/neconyan-tabs.js'], anchors: ['Custom RGB Accent', 'Accent Profiles', 'Save Current'],
        content: 'Settings → Appearance → Presets offers Accent Colors swatches, Custom RGB Accent and Accent Profiles → Save Current. Use these for the shared interface accent, including the active Shell Style. The accent also replaces Quote Text and Underlined Text; explicit Dialogue Colors tags can still override quoted dialogue. Colour changes apply immediately. Save Current stores an accent profile, while Save as a new theme stores a broader appearance preset. Neither changes the selected text model or makes a model request.',
    },
    {
        id: 'appearance.backgrounds', title: 'Message backgrounds and wallpaper', keys: ['background colour', 'background color', 'AI message color', 'user message color', 'wallpaper', 'chat background', 'main text'],
        sources: [html, theme, 'public/scripts/backgrounds.js'], anchors: ['Main Text', 'User Message', 'AI Message', 'Chat Background', 'Add Background', 'Background Fitting'],
        content: 'Settings → Appearance → Theme Colors has Main Text for general text, User Message and AI Message for message-background tints, and Chat Background for theme surfaces. Their visible effect depends on chat style and transparency. Wallpaper images are chosen in Fine-tuning → Background instead: Global and Chat tabs, Add Background, New Folder, a fitting menu (Classic, Cover, Contain, Stretch, Center) and Auto-select, which asks the model to pick one from the chat context (one model request). Highlight dialogue in Dialogue Colors affects passages rather than whole message backgrounds. Ask which of these the user wants when they say only \'change the background colour\'.',
    },
    {
        id: 'appearance.background-visibility', title: 'Calico cloud art, background visibility and blur', keys: ['cloud art', 'kitty clouds', 'background visibility', 'background blur', 'background opacity', 'chat field blur', 'wallpaper not showing', 'see my background', 'Midnight Cat Cafe', 'Moonlit Greenhouse'],
        sources: [html, 'public/scripts/neconyan-tabs.js', 'public/css/neconyan-calico.css', 'default/content/index.json'], anchors: ['Background Visibility', 'Background Blur', 'Background Opacity', 'Chat Field Blur', 'kitty-clouds', 'Neconyan - Moonlit Greenhouse.jpg'],
        content: 'Neconyan shows its soft cloud artwork behind the app only while no background picture is chosen; picking a background in Fine-tuning → Background paints over the clouds. The bundled set includes Neconyan - Midnight Cat Cafe and Neconyan - Moonlit Greenhouse. If your picture is hard to see, raise Settings → Appearance → UI Theme → Interface → Background Visibility, which makes the home and chat surfaces more transparent. Settings → Appearance → Page Size & Clarity has Background Blur and Background Opacity for the picture itself and Chat Field Blur for the area behind the chat. These are display settings only and make no model requests.',
    },
    {
        id: 'appearance.chat-style', title: 'Chat styles, avatars and text sizing', keys: ['chat style', 'bubbles', 'document style', 'avatar size', 'font size', 'text size', 'text bigger', 'larger text', 'smaller text', 'line spacing', 'Whisper style', 'Hush style'],
        sources: [html, 'public/scripts/neconyan-tabs.js', 'public/scripts/neconyan-settings-tabs.js', 'public/css/neconyan-chat-styles.css'], anchors: ['Bubbles', 'Document', 'Whisper', 'Hush', 'Global Font Size', 'Line Spacing', 'Avatar &amp; Chat Styles'],
        content: 'Settings → Appearance → Avatar & Chat Styles has Avatars (Circle, Square, Rounded, Rectangle), Chat Style (Flat, Bubbles, Document, Echo, Whisper, Hush, Ripple, Tide), Media Style and Notifications position. Whisper and Hush mark messages with a small accent bar on the right edge. For readability use Settings → Appearance → Page Size & Clarity: Page Width, Global Font Size, Line Spacing and Margin Size. These change display only, not the model\'s reply settings. Roleplay and Conversation render messages differently, so a Roleplay style is not a promise of identical DM layout. Avatar artwork comes from the card or persona; the style only changes its shape.',
    },
    {
        id: 'appearance.fonts', title: 'Interface fonts and remote fonts', keys: ['font', 'Nunito', 'Fredoka', 'Google Fonts', 'change typeface', 'Google Font'],
        sources: ['DESIGN.md', html, theme], anchors: ['Nunito', 'Default (Nunito + Fredoka One)', 'Or type any Google Font name...'],
        content: 'Neconyan bundles Nunito for body text and Fredoka One for headings. To change the body font open Settings → Appearance → Google Font: pick a Preset (Default (Nunito + Fredoka One), Nunito, Fredoka One, Figtree, Inter, JetBrains Mono, Roboto, Public Sans, Source Serif 4) or type any Google Font name in Custom and press the tick. Non-bundled fonts are downloaded from Google Fonts, an external request. Dialogue Colors styles individual speakers separately and has its own remote-font permission, so a dialogue font is not the interface font. Story Mode has its own Serif font in the manuscript option.',
    },
    {
        id: 'appearance.accessibility', title: 'Reduced motion and readable layouts', keys: ['reduced motion', 'animations', 'accessibility', 'contrast', 'keyboard focus'],
        sources: [html, 'DESIGN.md', 'public/scripts/theme-contrast.js'], anchors: ['Reduced Motion', 'Visual Toggles', 'No Blur Effect'],
        content: 'Settings → Appearance → Visual Toggles includes Reduced Motion, which disables animations and transitions, plus No Blur Effect and No Text Shadows. Operating-system motion preferences are also respected by supported styles. For readability raise Global Font Size or Line Spacing in Page Size & Clarity and keep contrasting text and background colours. Keyboard focus should remain visible on controls. Custom CSS may override accessibility styles, so remove or narrow the offending rule when diagnosing unreadable text or hidden focus.',
    },
    {
        id: 'appearance.custom-css', title: 'Custom CSS and appearance troubleshooting', keys: ['custom CSS', 'style override', 'broken theme', 'unreadable text', 'colour not changing', 'generate CSS with AI'],
        sources: [html, theme, 'public/style.css', 'public/scripts/neconyan-settings-tabs.js', 'src/operations/custom-css.js'], anchors: ['CustomCSS-block', 'Generate CSS with AI', 'append'],
        content: 'Settings → Appearance → Custom CSS applies your own rules on top of the active palette and shell. The Generate CSS with AI wand asks for the change and uses a model, costing a request; typing CSS yourself does not. Replace requests a complete updated stylesheet; Append requests only additions to keep the existing rules. Generation runs as a saved server operation and applies only if the saved CSS has not changed meanwhile. Keep a copy and test desktop and phone. Roleplay, Conversation and Story Mode have different message layouts. For a colour that will not change, distinguish text, quoted dialogue, message tint and wallpaper, then inspect explicit colour tags and custom CSS. Ask for the relevant rules or a screenshot instead of guessing them.',
    },
];
