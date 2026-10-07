# Contributing to Neconyan

Thanks for wanting to help. Neconyan stays small on purpose, and so should your pull request.

For questions about using Neconyan, start with the [official handbook](https://platberlitz.github.io/neconyan-docs/). The [extension authoring guide](https://platberlitz.github.io/neconyan-docs/extensions/) explains how to build an extension. Report missing or unclear documentation in the [handbook repository](https://github.com/platberlitz/neconyan-docs/issues).

## Keep it simple

- One change per pull request. A bug fix is a bug fix; it doesn't bring a refactor along.
- Make the smallest diff that does the job. Don't reformat, rename or reorder code you didn't need to touch.
- Fix the cause, not the symptom. Find the one place every caller goes through and change it there.
- Reuse what's already here before adding a helper, a dependency or a setting. A new toggle is a last resort.
- Delete before you add. The blocking CSS sits right at its budget, so a new rule usually means removing a dead one.
- Match the code around you: its naming, its structure and how often it comments (usually not much).

If a pull request is hard to review, I'll ask you to split it.

## AI-generated code

AI-generated code is fine. I use it too. It follows the same rules as everything else:

- [`AGENTS.md`](AGENTS.md): the checks to run, the CSS rules, how to verify a change, commit style.
- [`DESIGN.md`](DESIGN.md): tokens, type and the phone rules.
- [`PRODUCT.md`](PRODUCT.md): what Neconyan is, who it's for and how it should feel.

If you point an agent at the repo, have it read all three first. If a change ignores them, I'll ask you to fix it or close the pull request, whoever or whatever wrote it. The description is the exception: write that yourself.

## Pull requests

All pull requests target `staging`. `main` only moves when a release goes out, and a check will fail if you target it.

Before you open one:

1. Run the unit tests, the server tests if you touched `src/`, lint and the frontend budgets. The commands are in `AGENTS.md`.
2. Add or update the test that pins the behaviour you changed.
3. Check UI changes in a browser on a phone (393x852, touch) and on desktop (1280x900).
4. Add screenshots of anything visible: phone and desktop, before and after. Attach them to the pull request; don't commit them.
5. Write the title as a [Conventional Commit](https://www.conventionalcommits.org/): `type(optional-scope): subject`, lower-case imperative, no full stop. For example `fix(composer): keep Send above the keyboard` or `feat(mewmory): add a summary length setting`. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`; add `!` for a breaking change. Your commit messages follow the same rule.
6. Fill in the template: what changed, why, and how I can test it.

A check rejects titles that don't follow the format, so you'll know straight away.

## Designing UI

Read [`DESIGN.md`](DESIGN.md) before you change anything people can see. Two rules catch most pull requests:

- Build for what people actually use. The chat, the composer and whatever the user is working on get the room and the first tap. Settings people touch once a month don't get prime space.
- Buttons follow the accent. People pick their own accent colour, so buttons take theirs from the accent tokens, never from a hex colour. Check yours with a pale and a dark accent profile before you open the pull request.

The same checks run automatically on every pull request. A red check means it isn't ready yet.

## Things to leave out

- Anything under `data/`, `.local-runtime/` or `dist/`, and any keys, passwords or personal config.
- Unrelated dependency upgrades or lockfile churn.
- `Co-Authored-By` trailers and 'Generated with' footers.
