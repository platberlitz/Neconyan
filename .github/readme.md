<!-- This file mirrors the root README so GitHub renders the correct project homepage copy. -->

# Neconyan

<img src="../public/img/neconyan-pixel-cat.webp" width="180" alt="An animated calico cat">

Neconyan is a fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern) and [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny), with its own interface, defaults and direction. It brings character chats, writing tools and model settings into a cat-themed workspace for desktop and mobile.

**Neconyan has less upstream parity.** Features, layouts and behaviour can differ from both parent projects. Updates are adopted selectively; keeping every SillyTavern feature and extension working exactly as upstream is not a project goal.

**For a modernised SillyTavern with upstream parity, use [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) instead.** Choose Neconyan if you want its particular workspace and are comfortable with those differences.

## What is here

- A persistent sidebar on desktop and a sliding menu on mobile, with search and optional Advanced controls.
- Roleplay, Conversation, Meower and Story Mode workspaces.
- Character and persona editors, organised lorebooks, generation presets and agents.
- Included tools with their own settings, plus an Extensions page for third-party additions.
- Miso, Taro and Nori: three assistants with male, female and neutral variants, and a short First paws tour.
- Calico themes, an animated cat, local fonts and a collection of backgrounds.

Neconyan is a frontend for model services. You need a supported local backend or an API connection to generate replies. No model access or API credits are included.

## Getting started

Extract the release into its own folder. Run the launcher for your platform, then open the address printed in the terminal. The default is **http://127.0.0.1:4433/**.

| Platform | Automatic launcher | Node.js launcher | Bun launcher |
| --- | --- | --- | --- |
| Windows | `Start.bat` | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start.command` | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start.sh` | `./start-node.sh` | `./start-bun.sh` |
| Android / Termux | `bash start.sh` | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

The launchers check the runtime and install dependencies. For a manual installation, use Node.js 20 or later and npm:

```sh
npm install
npm run start:node
```

Bun 1.3.14 or later is also supported: after installing dependencies, run `bun run start`. `bun run start:mobile` enables Bun's lower-memory mode. Keep the repository's `.npmrc` installation settings.

On macOS or Linux, if an extracted launcher is not executable, run `chmod +x Start*.command start*.sh scripts/*.sh`. On Android, keep the folder inside Termux home rather than shared storage. The Node.js launcher is the default on Termux; the Bun option needs `glibc-repo` and `glibc-runner`.

For Bun on Termux, install the repository before the runner:

```sh
pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
```

Set `GLIBC_ROOT` if your glibc installation is outside `$PREFIX/glibc`.

On first launch, open **Model → Connections** to choose a provider and model. Then import or create a character, choose an assistant on Home, or start a temporary chat. The First paws tour walks through these steps and can be hidden and reopened from Home layout.

## Existing data and extensions

Neconyan retains many of the character-card, chat, lorebook, persona and preset formats inherited from its parents. That is a starting point for compatibility, not a promise of complete interchangeability. Extensions which depend on SillyTavern's or SillyBunny's page layout may need changes.

Back up your original installation before importing anything. Use a separate Neconyan data folder and keep the original backup until you have checked your characters, chats, presets and extensions. Do not run two applications against the same data directory.

The app creates `config.yaml` and `data/` when needed. An existing `config.yaml` or a `--port` argument overrides the default port. Personal data, keys and installed dependencies are not part of the release source.

## Development and releases

`main` holds the prepared release snapshot. `staging` is where development continues. Keep separate checkouts: `Neconyan` on `main`, and `Neconyan-draft` on `staging`. Test changes in the draft before promoting them to the release checkout.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

Run browser tests from `tests/` against a disposable server. Set `NECONYAN_TEST_BASE_URL` to its address; the default is `http://127.0.0.1:4433`. Build the frontend before checking it, and restart the server after rebuilding packaged assets.

Generated screenshots, test reports, build output and local runtime profiles belong outside the committed release. The release folder and draft are independent Git checkouts; their branches can move separately after a release is prepared.

## Credits and licence

Neconyan builds on the work of the SillyTavern and SillyBunny contributors. Their code, ideas and tools make this fork possible. See [included tool credits](../docs/neconyan-native-tools.md) for the bundled extensions and their original projects.

Maintained by [Platberlitz](https://github.com/platberlitz). Licensed under [GNU AGPL v3](../LICENSE). Preserve the applicable notices and licences when redistributing it.
