# Working on Neconyan

Read `PRODUCT.md` (what it is, who it is for, tone) and `DESIGN.md` (tokens, type, phone rules) before touching UI.

## Test and check commands

- Unit tests (Jest, 300+ suites): `npm run test:unit --prefix tests`
- Node tests for server modules: `node --test tests/*.node.js`
- Lint: `npm run lint` (root), `npm run lint --prefix tests` (tests folder, not in CI)
- Frontend budgets: `npm run check:frontend-budgets` (blocking CSS bytes, script count and size)
- E2E (needs a running server): from `tests/`, `NECONYAN_TEST_BASE_URL=http://127.0.0.1:PORT npx playwright test <file> --reporter=line`. Several suites fail in a preview without an API key; compare against the baseline before blaming a change.
- Local preview that serves `public/` live: `node server.js --configPath <config> --dataRoot <data> --port <port> --browserLaunchEnabled false`. With `performance.frontendBuild.enabled: true` the server serves the hashed build in `dist/frontend` instead, so either run `npm run build:frontend` or disable that flag while iterating.
- Translations: `node scripts/build-interface-locales.js` inventories UI strings; set `NECONYAN_TRANSLATION_COMMAND` to a translator command to fill `public/locales/neconyan/<lang>.json`. Coverage audit: `node --test tests/locale-coverage.node.js`.

## CSS shipping rules

- Blocking stylesheets share a 1 MiB budget and sit within a couple of KiB of it. Delete dead rules before adding; the phone-gated sheets (`mobile-styles.css`, `neconyan-paper-theme.css`, `neconyan-mobile-shell.css`) do not count towards bytes.
- `!important` counts are capped per sheet by `tests/mobile-css-budgets.test.js` and are at the ceiling in `neconyan-mobile-shell.css`, `neconyan-tabs.css`, `neconyan-theme.css`, `neconyan-paper-theme.css` and `neconyan-chat-styles.css`. Win with specificity, not `!important`. `neconyan.css` and `neconyan-calico.css` are unbudgeted for the count but blocking for bytes.
- No `//` comments in CSS. Use `/* */`.
- Phone-only rules go in `neconyan-mobile-shell.css`; both-viewport rules in `neconyan.css`; Calico palette and cat decorations in `neconyan-calico.css`.
- Some sheets load after the core ones: extension `style.css` files, `neconyan-conversation.css`, `world-info.css`, `personas.css`. Overrides need one more id or class than the rule they beat.
- Every CSS change ships with a cache bump: `NN_SW_CACHE_VERSION` in `public/sw.js` and the `?v=` query on the five core stylesheet links in `public/index.html` (style.css, neconyan-tabs.css, neconyan.css, neconyan-home.css, neconyan-calico.css). Webfont and image `?v=` strings are pinned by tests; leave them.
- New `transition`/`animation` declarations need a reduced-motion guard.
- Horizontal rails on phones need `touch-action: pan-x` plus an entry in `MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR` (`public/scripts/mobile-shell-lifecycle/index.js`) and the matching row in `tests/mobile-shell-lifecycle-wiring.test.js`.

## Verification standard

- Reproduce before fixing: read the cascade or the code path end to end, then change the one place all callers route through.
- Verify in a browser, not by reading alone: drive Chromium (the Playwright copy in `tests/node_modules`) at 393x852 with touch for phones and 1280x900 for desktop, and measure computed styles and geometry. WebKit cannot run on this machine, so iOS behaviour is inferred from Chromium and must be labelled as such.
- For anything an iPhone user reports, emulate iOS with `tests/ios-safari-emulation.js`: `IPHONE_SAFARI_CONTEXT` + `installIPhoneSafari(context, { standalone })` spoof the user agent, `navigator.platform`, touch points and home-screen mode (so `body.safari`, `body.PWA` and `isIOSWebKitPlatform()` behave as on a phone), and `applyIOSOnlyCss(page)` re-applies the `@supports (-webkit-touch-callout: none)` / `-webkit-overflow-scrolling` rules Chromium skips. Call it again after late sheets such as `world-info.css` load. Those rules lift the right-hand drawers to `--sb-z-popout` (4000), so floating UI that looks fine in plain Chromium can sit hidden underneath on iPhones.
- Run the unit suite, lint and budgets before calling anything done. Add or update the test that pins the behaviour you changed.
- Never report a guess as a result. Say what was verified, how, and what is inferred.

## Git and attribution

- Commit only when asked, with a local `git commit`. Subject line in the imperative, `fix:`/`feat:`/`chore:` prefix as the history does.
- No `Co-Authored-By` trailers, no 'Generated with' footers, no web-flow commits. The owner writes PR titles and bodies.
- Never commit `data/`, `.local-runtime/`, `dist/` or secrets. `default/config.yaml` is the template; real config lives outside the repo.

## Reporting style

- Plain language for a technical non-programmer. Lead with what was wrong and what changed, then how it was verified, then caveats.
- Define any unavoidable jargon in the same sentence. No metaphors.
- File paths, function names and commands go in their own section at the end.
- British spelling, single quotes, no em dashes.

## Architecture map

- `public/index.html`, `public/script.js`: upstream core (chat, generation, characters). `public/scripts/openai.js`, `textgen-*.js`: backends.
- `public/scripts/neconyan-tabs.js`: the shell. Top bar, sheets, bottom chat bar, composer control placement, settings drawers, mode switching, Included tools.
- `public/scripts/welcome-screen.js`: workspace rail (desktop sidebar, phone drawer) and the Home panel.
- `public/scripts/neconyan-conversation/`: Conversation mode (timeline, chrome, settings drawer, notifications).
- `public/scripts/mobile-shell-lifecycle/index.js`: DOM-free phone policy (touch guard, drawer bounds, overlay exclusivity).
- `public/scripts/mewmory/` + `src/mewmory/` + `src/endpoints/mewmory.js`: Mewmory memory. Model roles can use saved connection profiles (`src/mewmory/connection-profiles.js`).
- `public/scripts/neconyan-assistant-tools.js`: assistant tool calls (including character creation with a Quick Image Gen avatar).
- Bundled extensions: `public/scripts/extensions/in-chat-agents` (Agents), `guided-generations`, `input-history`, `neconyan-chats-archive`, `quick-image-gen`, `connection-manager`. Third-party but shipped: `Neconyan-Hopper` (Meower), `Neconyan-Story-Mode`, `Neconyan-BotSearcher`, `Neconyan-Terminal-UI`.
- `src/server-main.js`: Express boot. `src/middleware/basicAuth.js` + `sessionAuth.js`: HTTP basic auth with a 30-day remembered session stored hashed on disk. `src/resumable-generations.js`: replies that outlive the client connection. `src/import-progress.js`: NDJSON progress for data imports.
- `public/scripts/i18n.js` + `public/locales/*.json` (upstream dictionaries) + `public/locales/neconyan/*.json` (generated supplements) + `public/scripts/ui-localization.js` (runtime control labels).
- `default/content/themes/*.json`: bundled themes; `public/scripts/theme-contrast.js` enforces contrast on load. Error pages: `default/content/errors/*.html`.
- Tests: `tests/*.test.js` (Jest), `tests/*.node.js` (node test runner), `tests/*.e2e.js` (Playwright).

## Deploy recipe (generic)

1. List changed files against the last deployed commit: `git diff --name-only --diff-filter=AM <deployed>..HEAD`; note deletions separately.
2. On the server, tar a backup of exactly those paths before overwriting.
3. Copy the files with rsync over SSH; compare sha256 of the list on both sides.
4. Restart the service and wait for it to bind; an authentication challenge on the root URL means it is up.
5. Fetch a few changed assets through the public URL and check for a marker string from each change.
6. Keep hostnames, paths, keys and credentials out of this file and out of the repo.
