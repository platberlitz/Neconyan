<p align="center">
  <img src="docs/readme/banner-neconyan.webp" alt="Neconyan - The Cutest LLM RP Frontend">
</p>

> [!NOTE]
> All of the code here is LLM-generated or LLM-assisted, but every prompt and agent that ships with Neconyan is human-made.

Neconyan is my cat-themed fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern) and [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) for chatting and roleplaying with AI characters, on desktop or on your phone. You bring the model, either a local backend or an API key, since no model access or credits come with it.

If you want SillyTavern with everything working exactly like upstream, use [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) instead. I only pull in the upstream bits I want, so some things look and behave differently here, and some extensions might not work.

<p align="center">
  <img src="docs/readme/banner-why.webp" alt="Why Neconyan?">
</p>

- **It keeps going when you leave.** Almost everything runs on the server now, so you can send a message on your phone, switch apps or lock the screen, and the reply will be sitting there when you come back. A few things still need the page open, like in-browser WebLLM models and Kokoro voices.
- **It's actually made for phones.** Proper labelled tabs, a bottom chat bar and a sliding menu, not the desktop layout squished down.
- **Four ways to chat.** Classic Roleplay, messenger-style Conversation, a social timeline called Meower, and Story Mode for long-form writing.
- **Memory that remembers.** [Mewmory](docs/mewmory.md) keeps track of your story, the NPCs you've met and what they said, so you're not re-explaining everything 200 messages later.
- **The good stuff comes built in.** Agents, Chat Archive, Quick Image Gen, Guided Generations, BotSearcher and a few more, each with their own settings. [Here's the full list and who made them.](docs/neconyan-native-tools.md)
- **Little helpers.** Miso, Taro and Nori are assistants that can help you set things up, and the short First paws tour walks you through the basics.
- **It's cute.** Calico themes, cats napping on your messages and a pixel cat on Home. That was the whole point, really.
- **Your files are still your files.** It reads the same character cards, chats, lorebooks and presets as SillyTavern, and there's no telemetry.

<p align="center">
  <img src="docs/readme/banner-modes.webp" alt="Modes">
</p>

These are staged demo chats with the bundled assistants, so don't read too much into the replies.

### Home

Where you land. Pick a character, start a temporary chat, connect a model or say hi to one of the assistants.

<table>
  <tr>
    <td width="72%"><img src="docs/readme/desktop-home.webp" alt="Home on desktop"></td>
    <td width="28%"><img src="docs/readme/phone-home.webp" alt="Home on a phone"></td>
  </tr>
</table>

### Roleplay

The classic chat you know from SillyTavern, with a cat asleep on top of your messages.

<table>
  <tr>
    <td width="72%"><img src="docs/readme/desktop-roleplay.webp" alt="Roleplay on desktop"></td>
    <td width="28%"><img src="docs/readme/phone-roleplay.webp" alt="Roleplay on a phone"></td>
  </tr>
</table>

### Conversation

Texting your characters like you'd text a friend. There's a Pals list, group chats, branches and characters who can be busy or offline.

<table>
  <tr>
    <td width="72%"><img src="docs/readme/desktop-conversation.webp" alt="Conversation on desktop"></td>
    <td width="28%"><img src="docs/readme/phone-conversation.webp" alt="Conversation on a phone"></td>
  </tr>
</table>

### Meower

A tiny social timeline where your characters post, reply to each other and run polls about snacks.

<table>
  <tr>
    <td width="72%"><img src="docs/readme/desktop-meower.webp" alt="Meower on desktop"></td>
    <td width="28%"><img src="docs/readme/phone-meower.webp" alt="Meower on a phone"></td>
  </tr>
</table>

### Story Mode

The chat turned into continuous prose, for when you'd rather read a story than scroll through bubbles.

<table>
  <tr>
    <td width="72%"><img src="docs/readme/desktop-story.webp" alt="Story Mode on desktop"></td>
    <td width="28%"><img src="docs/readme/phone-story.webp" alt="Story Mode on a phone"></td>
  </tr>
</table>

<p align="center">
  <img src="docs/readme/banner-getting-started.webp" alt="Getting Started">
</p>

1. Extract the release into its own folder.
2. Run the launcher for your system (the table below).
3. Open **http://127.0.0.1:4433/** in your browser.
4. Go to **Model → Connections** and pick your provider and model.
5. Import or make a character, or just chat with an assistant from Home.

| System | Launcher |
| --- | --- |
| Windows | `Start.bat` |
| macOS | `Start.command` |
| Linux / WSL | `./start.sh` |
| Android (Termux) | `bash start.sh` |

The launcher checks what you've got installed and sets everything up for you.

<details>
<summary><b>Picking Node.js or Bun yourself</b></summary>

Every system also has a Node.js launcher and a Bun launcher, if you'd rather choose:

| System | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

To install by hand, you need Node.js 20 or newer:

```sh
npm install
npm run start:node
```

Bun 1.3.14 or newer works too: install the dependencies, then run `bun run start`, or `bun run start:mobile` to use less memory. Keep the repo's `.npmrc` file as it is.

</details>

<details>
<summary><b>If something won't start</b></summary>

- **macOS or Linux says the launcher isn't executable:** run this in the Neconyan folder.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Android:** keep the folder inside your Termux home, not shared storage. Node.js is the default there. Bun needs two extra packages first:

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  Set `GLIBC_ROOT` if your glibc lives somewhere other than `$PREFIX/glibc`.

- **Port 4433 is taken:** pass `--port` with another number, or change the port in `config.yaml`.

</details>

### Coming from SillyTavern or SillyBunny?

Most of your characters, chats, lorebooks, personas and presets should come across fine, but I can't promise everything will, and extensions that rely on SillyTavern's page layout might need fixing. So:

- **Back up your old install first**, and keep that backup until you've checked everything works.
- **Give Neconyan its own data folder.** Never point two apps at the same one.

Neconyan makes its own `config.yaml` and `data/` folder the first time it runs. Your personal data, keys and installed packages are never part of the release.

<details>
<summary><b>For developers</b></summary>

`main` is the release snapshot and `staging` is where work happens. I keep them as two separate checkouts, `Neconyan` on `main` and `Neconyan-draft` on `staging`, and test in the draft before anything gets promoted.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

Browser tests live in `tests/` and run against a throwaway server: set `NECONYAN_TEST_BASE_URL` to its address (the default is `http://127.0.0.1:4433`). Build the frontend before testing, and restart the server after rebuilding. Screenshots, test reports, build output and local runtime folders stay out of commits.

</details>

<p align="center">
  <img src="docs/readme/banner-credits.webp" alt="Credits">
</p>

Neconyan is built on the work of everyone behind SillyTavern and SillyBunny; none of this would exist without them. The bundled tools and the projects they came from are credited in [the included tools list](docs/neconyan-native-tools.md).

Made by [Platberlitz](https://github.com/platberlitz). Licensed under [GNU AGPL v3](LICENSE), so keep the notices and licences in place if you redistribute it.
