# Neconyan design system

Neconyan is skinned by four stylesheets loaded in this order: `public/style.css` (upstream base), `public/css/neconyan-tabs.css` (shell), `public/css/neconyan.css` (theme tokens and layout), `public/css/neconyan-calico.css` (the Calico palette and cat decorations). Phone-only rules live in `public/css/neconyan-mobile-shell.css`, which is linked with `media="(max-width: 768px)"`.

## Colour tokens (`--neco-*`)

All colours flow from a small token set on `body.neconyan`. Themes only change SmartTheme colours; the tokens follow.

| Token | Role | Calico dark | Calico light |
|---|---|---|---|
| `--neco-canvas` | Page background behind everything | `#161716` | `#f6f2e8` |
| `--neco-surface` | Panels, sheets, cards, the bottom bar box | `#242420` | `#fffaf0` |
| `--neco-raised` | Hover and active fills, chips | `#302e29` | mix of surface and ink |
| `--neco-rail` | Workspace sidebar and phone drawer | `#1b1c1a` | `#343735` (the rail stays dark) |
| `--neco-ink` | Body text | `#f6edda` | `#303331` |
| `--neco-muted` | Secondary text, hints, icons at rest | `#ddd0bf` | `#66675f` |
| `--neco-ginger` | Accent: active tab, focus ring, Send, links | `#d69270` | `#b86b32` |
| `--neco-ginger-hover` | Accent hover | lighter ginger | darker ginger |
| `--neco-border` | 1px borders everywhere | `#61534d` | `#d5cec0` |
| `--neco-user` | User message bubble tint | warm brown | `#f7e2c3` |
| `--neco-on-accent` | Text on a ginger fill | canvas | surface |
| `--neco-panel-gradient` | Translucent panel fill (surface at 90%) | | |
| `--neco-canvas-gradient` | Canvas with paw prints | | |

Rules:

- Never write a hex colour in a component rule; use a token. Outside Calico the tokens fall back to SmartTheme colours, so custom themes keep working.
- `--sb-*` tokens used by the shell (`--sb-accent`, `--sb-shell-nav-bg`, `--sb-shell-text`, `--sb-shell-text-secondary`, `--sb-button-bg`, `--sb-focus-ring`) are bridged from `--neco-*` unconditionally in `neconyan.css`.
- Surfaces that hold text are solid (`--neco-surface`). Only the canvas and the conversation stage are translucent (`--neco-panel-gradient`), so the paw wallpaper shows through at 67% but never behind copy.
- Every bundled theme is passed through `public/scripts/theme-contrast.js` on load: text reaches 4.5:1 and borders 3:1 against every surface. Calico Dark is the reference and is left untouched.

## Type: Nunito + Fredoka One

- Body: `--mainFontFamily: 'Nunito', 'Figtree', system-ui, ...` (variable weight 200 to 1000, bundled in `public/webfonts/Nunito`). Messages, inputs, lists, settings, buttons.
- Display: `--sb-font-display: 'Fredoka One', var(--mainFontFamily)`. Headings h1 to h6, the top bar title, the rail brand, settings tab labels.
- A font picked in the Google Font drawer lands inline on `:root` and then applies everywhere, headings included. 'Default (Nunito + Fredoka One)' restores the pairing.
- Sizes: 15px body, 13px controls, 12px labels and pills, 11px metadata. Weights: 500 controls, 600 titles, 700 toast titles.

## Shape and spacing

- Radii: 6px inputs and small buttons, 8px cards, 10px pills and menus, 12px bottom bar and composer row buttons, 14px phone buttons (paper theme), 18px for the composer box and the phone bottom bar's top corners, 999px for round icon buttons.
- Touch targets: 44px minimum on phones for anything tappable. Composer action squares are 44px; the extension rows use 36px buttons with a 5px gap.
- Buttons are horizontal and perfectly aligned by default. A label stays on one line, buttons in a group sit side by side and wrap to the next row as whole buttons, and every button in a row shares one height and one alignment. Never let a button get narrower than its label: `.menu_button` sizes to `max-content` capped at `max-width: 100%`, never `min-content`, because the settings drawers inherit `overflow-wrap: anywhere` and min-content there is one letter wide. Cut wasted space, uneven gaps and padding that isn't buying a touch target.
- Spacing scale: 4, 6, 8, 12, 16, 18, 24. Panel padding 18px on desktop, 12px on phones. Message gap 24px desktop, 10px phones.
- Cat ears (`.neconyan-cat-panel::before/::after`) sit on the top edge of one box per screen: the composer on desktop, the whole bottom bar and the sheet tab row on phones.

## Shell Styles

- Shell Styles load a separate sheet from `public/css/shell-styles/` and are scoped to the saved `data-sb-theme`. Keep the chosen palette, fonts, message tints and functional portraits.
- Kittyless is the intentional exception to cat decorations: solid rounded cards, pill actions, no ears, whiskers, paw textures, mascots or sleeping animals. Use neutral default avatars, keep chosen portraits, and collapse Home's assistant choices behind 'Show assistants'. Other styles retain the decorations.
- Windows 98 is the retro exception: grey bevelled boxes (raised controls, sunken fields), navy caption strips, square corners, and every bundled cat, ear, paw, sleeper, startup cat, assistant portrait and assistant icon swapped by CSS `content: url()` for a Sunburst pixel-art redraw in `public/img/neconyan/win98/`. Redraws keep each original's aspect ratio because `content: url()` keeps the image box. Installed assistant cards (characters carrying a `neconyan_assistant` id) get their portrait swapped too, through a small runtime `<style id="sb-shell-style-assistant-art">` that `neconyan-tabs.js` rebuilds from the character list; characters the user made or imported keep their own avatars.
- Windows XP follows Luna: rounded caption gradients with white bold titles, beige faces, white-to-beige push buttons with an orange hover rim, tabs with an orange top line and a green Start-style send button. The colour scheme comes from the bundled UI themes (Windows XP Blue, Olive Green, Silver, Royale, Zune, Royale Noir) through the root `data-neconyan-ui-theme` slug set in `power-user.js`; Calico uses Luna Blue and other themes take their caption hue from the accent. Its wallpaper is the Bliss-style calico hill; Windows Aero has a Sunburst aurora with a sleeping calico.
- Kittyless has a Sunburst woodland railway background without animals. A user-selected background remains above it; never replace the user's selection when switching styles.

## Phone vs desktop rules

- Breakpoint: 768px. Phone stylesheets are gated at the link level; JS uses `isMobileViewport()`.
- Phones: the top bar is 42px and shows the character name (plus context size or custom text when chosen); the hamburger opens the workspace rail as an opaque drawer under the top bar; sheets (`#right-nav-panel`, settings shells) are opaque and their header collapses to a close button beside a labelled, horizontally scrolling tab row; no dropdown section pickers anywhere; the bottom bar (persona, chat pill, extension rows, composer) is one solid box; Create/Import/Filter/Grid/Bulk edit live in one scrolling tool row.
- Any horizontally scrolling rail needs both `touch-action: pan-x` and an entry in `MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR` in `public/scripts/mobile-shell-lifecycle/index.js`, or the capture-phase touch guard cancels the swipe.
- Desktop keeps wrapping tab rows, the labelled Send and Chat tools pills, and the sidebar always visible. The character editor's sections (Basics, Definition, Greetings, Advanced) are a labelled tab row at every width, fullscreen and pinned included, never a dropdown; in a pinned panel the tab icons step aside so all four fit on one row.
- Size layouts inside panels by the panel, not the window: a pinned or MovingUI-resized panel is narrow on a wide screen, so use container queries (`container-type: inline-size` on the box, `@container`) rather than viewport media queries for anything that lives in `#right-nav-panel`.

## Motion and accessibility

- Every `transition`/`animation` has a `prefers-reduced-motion: reduce` guard (a test enforces it). Ear twitch, whisker twitch and the backflipping pixel cat are the only decorative animations.
- Ease out only; no bounce.
- Focus: 2px `--neco-ginger` outline, offset 2px (inset 3px on the composer textarea so it is not clipped).
- Contrast: WCAG 2.2 AA via `theme-contrast.js`; light themes must set `color-scheme: light`.
- Labels beat icons: bare icons get text on phones, or an `aria-label` and a `title` at minimum.

## Component inventory

- Top bar (`#top-bar`, built by `buildTopBar()` in `public/scripts/neconyan-tabs.js`): hamburger, label, edit card, Quick Access shortcuts.
- Workspace rail / phone drawer (`#neconyan-workspace-rail`, `public/scripts/welcome-screen.js`): New chat, Workspace routes, Modes, Fine-tuning, Included tools, Recent, Search, Settings.
- Home (`welcomePanelOnboarding.html`): guide panel, Recent chats box, Chat Archive button.
- Sheets: Characters/Editor (`#right-nav-panel`), Model and Settings shells, Agents, Lorebooks, Extensions.
- Bottom chat bar (`#sb-bottom-chat-bar`): persona, chat pill, up/down, Regenerate, chat manager actions.
- Composer (`#send_form`): Chat tools menu (`#options`), wand, textarea, palette, Send/Stop, agent cancel, Guided Generations and Input History rows.
- Messages: standard chat, Ripple (sticky avatar), reasoning pill, conversation bubbles with the three-dot menu on the name row.
- Feedback: toasts (solid surface, coloured left edge and icon), progress bars for imports, 'Preparing your Neconyan workspace' skeleton.
- Error pages: Unauthorized (401) and Invalid CSRF (403) with the backflipping cat and troubleshooting steps.
