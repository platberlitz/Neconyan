# Contributing to Neconyan

Thanks for wanting to help. I've kept this short on purpose.

## AI-generated code

AI-generated code is fine. I use it too. It has to follow the same rules as everything else:

- [`AGENTS.md`](AGENTS.md) - how to work in the codebase: checks to run, CSS rules, how to verify changes, commit style.
- [`DESIGN.md`](DESIGN.md) - tokens, type and the phone rules.
- [`PRODUCT.md`](PRODUCT.md) - what Neconyan is, who it's for and how it should feel.

If you're pointing an agent at the repo, have it read all three first. If a change ignores them, I'll ask you to fix it or close the PR - doesn't matter who or what wrote it.

## Pull requests

All pull requests target `staging`, not `main`. `main` only moves when a release goes out.

Before you open one:

- Run the unit tests, lint and frontend budgets listed in `AGENTS.md`.
- Check UI changes on both phone and desktop sizes.
- Use a `fix:`, `feat:` or `chore:` prefix on the title.
- Write the description yourself. Say what it changes, why, and how I can test it.
