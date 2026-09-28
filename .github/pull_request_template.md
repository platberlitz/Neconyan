<!--
Thanks for your pull request. Before you open it:

- Target `staging`. `main` only moves when a release goes out.
- Start the title with `fix:`, `feat:` or `chore:`, then say what changes in the imperative, for example 'fix: keep the composer above the keyboard'.
- Write the description yourself. AI-generated code is welcome if it follows AGENTS.md, DESIGN.md and PRODUCT.md; AI-written descriptions are not.
- Keep the diff to the change you describe. Leave formatting, renames and tidy-ups for their own pull request.
-->

## What you changed

<!-- One or two sentences. What does someone notice after this is merged? -->

## Why

<!-- The problem you fixed or the need you met. Link the issue if there is one. -->

## How to test it

<!-- The steps you want me to follow, and what I should see. -->

## Checks you ran

- [ ] Unit tests: `npm run test:unit --prefix tests`
- [ ] Server tests, if you touched `src/`: `node --test tests/*.node.js`
- [ ] Lint: `npm run lint`
- [ ] Frontend budgets: `npm run check:frontend-budgets`
- [ ] You added or updated a test that pins the behaviour you changed
- [ ] UI changes: you checked a phone (393x852, touch) and desktop (1280x900) in the browser
- [ ] CSS changes: you bumped `NN_SW_CACHE_VERSION` in `public/sw.js` and the `?v=` on the five core stylesheets in `public/index.html`

<!-- Screenshots help for anything visual. Show the phone and the desktop. -->
