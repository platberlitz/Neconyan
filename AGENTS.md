# Working on Neconyan

Read `PRODUCT.md` (what it is, who it is for, tone) and `DESIGN.md` (tokens, type, phone rules) before touching UI.

UI work, in short:

- Design for what the user actually works with: the chat, the composer and the task on screen get the space and the first tap; rare settings step back (see 'Design for what people actually use' in `DESIGN.md`).
- Buttons are accent-aware: fills, borders and states come from `--neco-ginger`/`--neco-ginger-hover`, text on an accent fill uses `--neco-on-accent`, and no button carries a hex colour (see 'Accent-aware buttons' in `DESIGN.md`).

## Test and check commands

- Unit tests (Jest, 300+ suites): `npm run test:unit --prefix tests`. Use Node 24. On a machine with limited memory the full run can run out of memory, so cap it: `NODE_OPTIONS=--max-old-space-size=4096 npm run test:unit --prefix tests -- --maxWorkers=2 --workerIdleMemoryLimit=512MB`.
- Single suites: `npm run test:unit --prefix tests -- <pattern>`. Plain `npx jest` fails every suite because it skips `--experimental-vm-modules`.
- Run the full Jest suite, the Node suite and browser tests one after another, not at the same time. Running them together causes timeouts in unchanged tests. A timeout seen only in a combined run is not a regression until it also fails when run on its own. `tests/jobs-client.test.js` is timing-sensitive and can fail under load; rerun it alone before blaming a change.
- Node tests for server modules: `node --test tests/*.node.js`
- Lint: `npm run lint` (root), `npm run lint --prefix tests` (tests folder, not in CI)
- Frontend budgets: `npm run check:frontend-budgets` (blocking CSS bytes, script count and size)
- E2E (needs a running server): from `tests/`, `NECONYAN_TEST_BASE_URL=http://127.0.0.1:PORT npx playwright test <file> --reporter=line`. Several suites fail in a preview without an API key; compare against the baseline before blaming a change. Run `neconyan-agents-workspace.e2e.js` with `--workers=1` (its tests edit the same data). Suites built on `tests/neconyan-conversation-durable-fixture.js` start their own server and need `NECONYAN_CONVERSATION_TEST_DISPOSABLE=1` instead of a base URL.
- Probing a running server that uses basic auth: use `node:http`/`node:https`, not built-in `fetch`. `fetch` sends a `Sec-Fetch-Mode` header, so the auth middleware returns 401 even with correct credentials.
- Local preview that serves `public/` live: `node server.js --configPath <config> --dataRoot <data> --port <port> --browserLaunchEnabled false`. With `performance.frontendBuild.enabled: true` the server serves the hashed build in `dist/frontend` instead, so either run `npm run build:frontend` or disable that flag while iterating.
- Translations: `node scripts/build-interface-locales.js` inventories UI strings; `--list` prints the keys and `--write-catalogue` refreshes `public/locales/neconyan/en.json`, neither touching a translator. Set `NECONYAN_TRANSLATION_COMMAND` to a translator command to fill `public/locales/neconyan/<lang>.json`, and `NECONYAN_TRANSLATION_LANGS=pt-pt` (comma-separated) to fill one language at a time. Coverage audit: `node --test tests/locale-coverage.node.js`.

## Browser CI rerun scope

- Choose the rerun scope from what changed. Preserve passing shard results (a shard is one test group); an isolated failure isn't a reason to restart the whole suite.
- With no code changes, inspect the failure first. If the evidence supports an intermittent failure, rerun only failed jobs with `gh run rerun <run-id> --failed`.
- After an isolated test fix, run the affected tests or shards against the new commit. GitHub's failed-job rerun reuses the original commit and cannot validate later fixes. A new commit alone doesn't justify another full run.
- Use a full rerun when application behaviour, shared test setup or workflow changes have broad or uncertain effects. State the reason before starting it.
- If a failure repeats, return to diagnosis before another retry. Keep the logs and distinguish a corrected test from an unchanged test that passed on retry; don't weaken assertions or skip failures to get a green result.
- Record the commit and scope each result covers. Reuse unaffected results honestly and state what still needs checking, rather than repeatedly spending an hour on the entire matrix.

## CSS shipping rules

- Blocking stylesheets share a 1 MiB budget and sit within a couple of KiB of it. Delete dead rules before adding; the phone-gated sheets (`mobile-styles.css`, `neconyan-paper-theme.css`, `neconyan-mobile-shell.css`) do not count towards bytes. Non-critical styles can go in a deferred sheet instead (`<link rel="preload" as="style" data-sb-deferred-style data-sb-media="all">` in `public/index.html`, as `neconyan-menus.css` and `neconyan-help.css` do); budgets ignore it, but a new sheet with transitions must be listed in `tests/ui-motion-css-compliance.test.js`.
- `!important` counts are capped per sheet by `tests/mobile-css-budgets.test.js` and are at the ceiling in `neconyan-mobile-shell.css`, `neconyan-tabs.css`, `neconyan-theme.css`, `neconyan-paper-theme.css` and `neconyan-chat-styles.css`. Win with specificity, not `!important`. `neconyan.css` and `neconyan-calico.css` are unbudgeted for the count but blocking for bytes.
- No `//` comments in CSS. Use `/* */`.
- Phone-only rules go in `neconyan-mobile-shell.css`; both-viewport rules in `neconyan.css`; Calico palette and cat decorations in `neconyan-calico.css`.
- Some sheets load after the core ones: extension `style.css` files, `neconyan-conversation.css`, `world-info.css`, `personas.css`. Overrides need one more id or class than the rule they beat.
- Every CSS change ships with a cache bump: `NN_SW_CACHE_VERSION` in `public/sw.js` and the `?v=` query on the five core stylesheet links in `public/index.html` (style.css, neconyan-tabs.css, neconyan.css, neconyan-home.css, neconyan-calico.css). Webfont and image `?v=` strings are pinned by tests; leave them. Bump the other stylesheet `?v=` strings in `public/index.html` (theme, paper, mobile shell, shell-style and kittyless loaders) and `NN_SHELL_STYLE_STYLESHEET_VERSION` in `public/scripts/neconyan-tabs.js` to the same value.
- After rebasing onto staging, compare `public/sw.js` with staging's copy. If staging already uses the same cache version, the rebase applies cleanly but your bump does nothing; bump again.
- Known cascade traps:
  - `public/css/shell-styles/windows-98.css` sets `transform: none` on every `.menu_button`. Position buttons with the separate `translate:` property, not `transform: translate...`.
  - `#left-nav-panel select` has `z-index: var(--sb-z-raised)` (10). Dropdowns and popovers inside left-panel pages need 11 or more, or a select shows through them.
  - Chat message HTML is sanitised by DOMPurify: every class gains a `custom-` prefix (except `fa-*`, `note-*`, `monospace`), so CSS targets `.custom-<class>`, and HTML that will be sanitised must use the plain class name.
- A floating element appended to `document.body` beside a drawer (tour cards, popovers) closes that drawer when pressed unless its selector is in `forbiddenTargets` in `public/script.js`.
- New `transition`/`animation` declarations need a reduced-motion guard.
- Horizontal rails on phones need `touch-action: pan-x` plus an entry in `MOBILE_DOCUMENT_PAN_HORIZONTAL_SCROLL_SELECTOR` (`public/scripts/mobile-shell-lifecycle/index.js`) and the matching row in `tests/mobile-shell-lifecycle-wiring.test.js`.

## Verification standard

- Reproduce before fixing: read the cascade or the code path end to end, then change the one place all callers route through.
- Verify in a browser, not by reading alone: drive Chromium (the Playwright copy in `tests/node_modules`) at 393x852 with touch for phones and 1280x900 for desktop, and measure computed styles and geometry. iOS behaviour verified this way is inferred and must be labelled as such.
- Real WebKit (Safari's browser engine) is also available through Playwright and catches what Chromium hides, such as timing, animation and layout behaviour that differs between Blink and WebKit. If it fails to launch with missing libraries, install them once from `tests/`: `sudo env PATH="$(dirname "$(command -v node)"):$PATH" npx playwright install-deps webkit` (with Node 24 on `PATH`). Then use `require('@playwright/test').webkit.launch()` in place of `chromium`, headless, or headed under `xvfb-run -a -s "-screen 0 1400x1000x24"`. The iOS helpers below work with it, but `applyIOSOnlyCss(page)` is still needed because desktop WebKit does not support `-webkit-touch-callout` either. WebKit on Linux can be slow (a few frames per second in the full app), so judge smoothness from a small page that loads the real module, and use the full app for logic and timing traces. It is still desktop WebKit on Linux, not an iPhone, so label results as inferred for iOS.
- For anything an iPhone user reports, emulate iOS with `tests/ios-safari-emulation.js`: `IPHONE_SAFARI_CONTEXT` + `installIPhoneSafari(context, { standalone })` spoof the user agent, `navigator.platform`, touch points and home-screen mode (so `body.safari`, `body.PWA` and `isIOSWebKitPlatform()` behave as on a phone), and `applyIOSOnlyCss(page)` re-applies the `@supports (-webkit-touch-callout: none)` / `-webkit-overflow-scrolling` rules Chromium skips. Call it again after late sheets such as `world-info.css` load. Those rules lift the right-hand drawers to `--sb-z-popout` (4000), so floating UI that looks fine in plain Chromium can sit hidden underneath on iPhones.
- For a new or restyled button, check it with the theme's default accent, a pale accent and a dark accent (Accent Profiles), and measure that the label contrast holds.
- Take screenshots of every visible change whenever possible: phone (393x852) and desktop (1280x900), before and after. Save them in `/screenshots/` at the repo root (git ignores it) and never commit them. Include them in the change report and attach them to the pull request.
- Run the unit suite, lint and budgets before calling anything done. Add or update the test that pins the behaviour you changed.
- Never report a guess as a result. Say what was verified, how, and what is inferred.

## Git and attribution

- Commit only when asked, with a local `git commit`.
- Commit subjects and PR titles follow Conventional Commits: `type(optional-scope): subject`, for example `fix(composer): keep Send above the keyboard`.
  - Types: `feat` (new behaviour), `fix` (bug fix), `docs`, `style` (formatting only, no behaviour change), `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
  - Subject in the lower-case imperative, no full stop, 72 characters at most. Add `!` after the type or scope for a breaking change (`feat(api)!: ...`) and explain the break in the body.
  - PR titles pass the same rule; the `PR Metadata` workflow (`.github/workflows/pr-metadata.yml`) rejects titles that do not.
- Pull requests: one change each, targeting `staging`. Include screenshots for any visible change, phone and desktop, before and after.
- No `Co-Authored-By` trailers, no 'Generated with' footers and no commits made through the GitHub web interface (they record `web-flow` as committer). PR titles and bodies are written by the author, not generated (see `.github/pull_request_template.md`); draft them only on request.
- Never commit `data/`, `.local-runtime/`, `dist/` or secrets. `default/config.yaml` is the template; real config lives outside the repo.
- Keep separate UI changes in separate commits, one per change.
- Before pushing to staging, fetch the GitHub staging branch and check `git log <fetched>..HEAD`. If it lists commits that are not yours (a local staging branch can hold unpushed work), cherry-pick only your commits onto the fetched staging and push that.

## Worktrees

- Give every new worktree its own root `node_modules`. A symlink to another checkout's `node_modules` makes 3 tests fail (`persona-card.test.js` x2, `character-card-metadata-preservation.test.js` x1, 'Requested file path is outside of the server directory') because the PNG library loads its WASM file from outside the checkout and `src/fetch-patch.js` rejects it. Use a hardlinked copy: `cp -al <main checkout>/node_modules node_modules`. `tests/node_modules` may stay a symlink.
- Those 3 failures always mean the worktree setup is wrong. They are never pre-existing app bugs, so do not report them as a baseline, and do not weaken `fetch-patch.js`. Check `ls -ld node_modules` before running tests.

## Reporting changes

- Lead with what was wrong and what changed, then how it was verified, then caveats.
- Define any unavoidable jargon in the same sentence.
- File paths, function names and commands go in their own section at the end.
- Project copy uses British spelling, single quotes and no em dashes.

## Architecture map

- `public/index.html`, `public/script.js`: upstream core (chat, generation, characters). `public/scripts/openai.js`, `textgen-*.js`: backends.
- `public/scripts/neconyan-tabs.js`: the shell. Top bar, sheets, bottom chat bar, composer control placement, settings drawers, mode switching, bundled tool definitions (`NECONYAN_NATIVE_TOOL_DEFINITIONS`) and their sidebar buttons.
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

## Release process: staging into main

A release from staging into main covers every step below, including the handbook, assistant help, signed Android downloads and the next staging version.

**Resolve and verify every E2E failure before publishing.** E2E means end-to-end browser or app checks. A pending run or an unresolved test-only failure is not an acceptable release result. Preserve valid passing groups as described in 'Browser CI rerun scope'; record which commits and tests the combined results cover. Keep existing skips visible, and never add skips or weaken assertions to make a release pass.

1. **Prepare the candidate.** Fetch the remote branches, inspect local changes and check the release history against `package.json`. Use a release worktree so the main checkout stays on `staging`, tracking `origin/staging`, and update that checkout by fast-forward only. Preserve unrelated work. Use the existing normal release version; fixes to an already published `X.Y.Z` use `X.Y.Z.A`. Keep published tags intact. Release preparation does not deploy to any running instance.
2. **Refresh the official handbook.** Review the changes since the previous release in the separate `platberlitz/neconyan-docs` repository. Update the affected guides and their review/version information. Run `.venv/bin/mkdocs build --strict`, `.venv/bin/python scripts/check_site.py` and `.venv/bin/python scripts/browser_check.py` there. Check phone and desktop pages, publish the documentation, wait for Pages to succeed and verify the changed pages on the live site. Historical snapshot versions stay historical.
3. **Refresh the assistants and changelog.** Update `public/scripts/neconyan-assistant-knowledge/*.js`, increment `KNOWLEDGE_REVISION`, and add retrieval cases in `tests/neconyan-assistant-knowledge-cases.js`. Keep browser revision expectations in sync. Verify source anchors, topic budgets and retrieval across all nine assistant variants, including focused phone and desktop checks in `tests/neconyan-assistant-knowledge.e2e.js`. Add release highlights at the top of `changelog.md`, preserving its merged-PR list. Keep the assistant refresh and changelog in separate conventional commits. Published copy follows the tone in `PRODUCT.md`.
4. **Start browser CI early and run local checks.** Staging pushes do not start release E2E automatically; dispatch `gh workflow run release-e2e.yml --ref staging` once the candidate is on the remote. Run the full unit and Node suites, `npm run test:mewmory`, root and test lint, frontend budgets and `npm run build:frontend`, using Node 24 and the commands above. Run the large local suites one after another. Verify every later fix with the affected checks; retain unaffected results with their original commit and scope.
5. **Resolve failures before the final build.** Read failed logs and retained browser/emulator diagnostics before changing code or retrying. Separate application defects, outdated test fixtures, control timing and runner failures. For unchanged intermittent failures, use `gh run rerun <run-id> --failed`, or `gh run rerun --job <job-id>` for one job. Fixes need a new run at the corrected commit. The browser workflow accepts selected groups, for example `gh workflow run release-e2e.yml --ref <branch> -f 'shards=[7,8]'`, while keeping the 16-group split. Check group membership if the test inventory changes. Another dispatch on the same branch cancels its running workflow; wait or use another pushed ref when preserving a run. Watch CI with `gh run watch <run-id> --interval 60 --exit-status`. Keep real crash and security assertions; diagnose missing browsers or platform incompatibilities rather than skipping those checks.
6. **Promote the settled candidate.** Fetch again, inspect the outgoing commits and fast-forward `main` to the intended staging commit, without a merge commit. Apply the staging push checks in 'Git and attribution'. If the main push queues a duplicate full browser run, cancel only that duplicate when the retained runs and focused checks cover the candidate. Never cancel the run whose results are still needed. Record the exact release commit.
7. **Build signed Android downloads.** Dispatch `gh workflow run android-release.yml --ref main`. This workflow creates build artifacts; it does not publish a release. Require the signed build, WebView fixture and Android 11, 13 and 15 lifecycle/native checks to pass. Inspect failures before retrying; preserve passing jobs when only an unchanged infrastructure failure needs a retry. Label emulator verification accurately, without claiming a physical-phone test. Any later change to the intended release commit requires fresh matching APKs and source, even if it only changes tests or CI. Finish those corrections before the final build where possible.
8. **Independently verify the nine release assets.** Download the artifact for the recorded commit. It must contain the ARM64 and x86_64 APKs, the source ZIP, `SHA256SUMS`, `provenance.json`, and signature/alignment reports for both ABIs (`arm64-v8a` and `x86_64`). Verify all eight listed checksums, both APK signatures against the existing official signing identity, and native 16 KiB alignment. Run `python3 scripts/verify-android-release.py --commit <commit> --version <version> <arm64-apk> <x86_64-apk>` and compare its output with the supplied provenance. Check the embedded version, commit and frontend files. Compare every source ZIP file with `git archive` of the same commit, not raw Git blobs: `.gitattributes` can convert `.bat` and `.cmd` line endings.
9. **Tag and publish.** Only after all required checks pass, create an annotated `v<version>` tag on that exact commit, with message `Neconyan <version>`, and push it. Publish the GitHub release with `--verify-tag`, all nine verified assets and release notes under 'What's changed', 'Downloads' and 'Checks'. Report actual results, existing skips and the commit/scope of reused browser results. Do not leave pending placeholders. Download all nine published assets again, compare them byte for byte with the verified build files and verify GitHub's SHA-256 digests. Confirm the release is public and marked latest.
10. **Start the next staging version and record the result.** Bump the root version in `package.json` and both root entries in `package-lock.json`, plus the expectations in `tests/neconyan-project-boundaries.test.js`. Run the six boundary tests with `npm run test:unit --prefix tests -- --runTestsByPath neconyan-project-boundaries.test.js --maxWorkers=2` and lint that test. Add a dated entry to `docs/server-migration-handover.md` covering the release/tag commit, documentation publication, checks and run IDs, fixes versus unchanged retries, asset verification and next version. Commit and push the bump and handover to staging, then fast-forward the clean main checkout. If the README mirror workflow adds a commit to main, merge it back into staging so the branches do not diverge. Finish by checking branch/version alignment, clean checkouts and the public release link.

## Deploy recipe (generic)

1. List changed files against the last deployed commit: `git diff --name-only --diff-filter=AM <deployed>..HEAD`; note deletions separately.
2. On the server, tar a backup of exactly those paths before overwriting.
3. Copy the files with rsync over SSH; compare sha256 of the list on both sides.
4. Restart the service and wait for it to bind; an authentication challenge on the root URL means it is up.
5. Fetch a few changed assets through the public URL and check for a marker string from each change.
6. Keep hostnames, paths, keys and credentials out of the repository.
