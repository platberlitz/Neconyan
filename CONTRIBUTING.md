# Contributing to Neconyan

Thanks for wanting to help. Neconyan stays small on purpose, and so should your pull request.

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
4. Start the title with `fix:`, `feat:` or `chore:` and describe the change in the imperative.
5. Fill in the template: what changed, why, and how I can test it.

The same checks run automatically on every pull request. A red check means it isn't ready yet.

## Things to leave out

- Anything under `data/`, `.local-runtime/` or `dist/`, and any keys, passwords or personal config.
- Unrelated dependency upgrades or lockfile churn.
- `Co-Authored-By` trailers and 'Generated with' footers.
