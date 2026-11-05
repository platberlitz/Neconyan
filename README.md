# Neconyan~

1.5.0

<p align="center">
  <img src="docs/readme/banner-neconyan.webp" alt="Neconyan - The Cutest LLM RP Frontend">
</p>

Neconyan is my cat-themed fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern) and [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) for chatting and roleplaying with AI characters, on a computer or your phone. Bring your own API key or local model; the app doesn't include model access or credits.

**[Download Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[Read the handbook](https://platberlitz.github.io/neconyan-docs/)** · **[Get help](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> All the code here is LLM-generated or LLM-assisted. Every prompt and agent that ships with Neconyan is human-made.

## What's in here?

- **Four ways to chat:** classic Roleplay, messenger-style Conversation, a social feed called Meower, and Story Mode for continuous prose.
- **A layout made for phones**, with labelled controls, a bottom chat bar and a sliding menu. **Simple Mode** hides the less-used controls until you want them.
- **Mewmory** remembers story events and characters. **Agents** can keep trackers, check a reply or write a separate Companion note.
- **Catelier** helps you write character cards and lorebooks. **Notebooks** keeps your notes nearby, and **Scratchpad** gives you a separate chat to talk through ideas.
- **Miso, Taro and Nori** help you find things and can make supported edits with your permission.
- **Themes, accents and cats.** Quite a lot of cats. You can hide them, though I can't imagine why you'd want to.

Your character cards, chats, lorebooks and presets use familiar SillyTavern formats. There's no telemetry. Some upstream features and extensions behave differently here; I only bring across the bits I want. The [included tools list](docs/neconyan-native-tools.md) credits the projects bundled with Neconyan.

## Have a look

Fresh desktop and phone screenshots, using demo chats and notes with the bundled assistants.

### Home

Pick a character, connect a model or say hi to an assistant.

<table><tr>
  <td width="72%"><img src="docs/readme/desktop-home.webp" alt="Home on desktop"></td>
  <td width="28%"><img src="docs/readme/phone-home.webp" alt="Home on a phone"></td>
</tr></table>

### Roleplay

Write a scene, try another reply or pick up an old chat.

<table><tr>
  <td width="72%"><img src="docs/readme/desktop-roleplay.webp" alt="Roleplay on desktop"></td>
  <td width="28%"><img src="docs/readme/phone-roleplay.webp" alt="Roleplay on a phone"></td>
</tr></table>

### Catelier

Work on a character draft, ask for writing help and review changes before saving to your library.

<table><tr>
  <td width="72%"><img src="docs/readme/desktop-catelier.webp" alt="Catelier on desktop"></td>
  <td width="28%"><img src="docs/readme/phone-catelier.webp" alt="Catelier on a phone"></td>
</tr></table>

<details>
<summary><b>More screenshots: Simple Mode, Conversation, Meower, Story Mode, Notebooks and Scratchpad</b></summary>

### Simple Mode

Fewer controls while you get settled. **Show all features** in the sidebar brings them back; nothing is disabled.

<table><tr>
  <td width="72%"><img src="docs/readme/desktop-simple.webp" alt="Simple Mode on desktop"></td>
  <td width="28%"><img src="docs/readme/phone-simple.webp" alt="Simple Mode on a phone"></td>
</tr></table>

### Conversation

Text your characters, make group chats and let them be busy or offline.

<table><tr>
  <td width="72%"><img src="docs/readme/desktop-conversation.webp" alt="Conversation on desktop"></td>
  <td width="28%"><img src="docs/readme/phone-conversation.webp" alt="Conversation on a phone"></td>
</tr></table>

### Meower

A social feed where your characters post, reply and run polls.

<table><tr>
  <td width="72%"><img src="docs/readme/desktop-meower.webp" alt="Meower on desktop"></td>
  <td width="28%"><img src="docs/readme/phone-meower.webp" alt="Meower on a phone"></td>
</tr></table>

### Story Mode

Read your chat as continuous prose.

<table><tr>
  <td width="72%"><img src="docs/readme/desktop-story.webp" alt="Story Mode on desktop"></td>
  <td width="28%"><img src="docs/readme/phone-story.webp" alt="Story Mode on a phone"></td>
</tr></table>

### Notebooks

Keep scene plans, places and session journals next to your chats.

<table><tr>
  <td width="72%"><img src="docs/readme/desktop-notes.webp" alt="Notebooks on desktop"></td>
  <td width="28%"><img src="docs/readme/phone-notes.webp" alt="Notebooks on a phone"></td>
</tr></table>

### Scratchpad

Talk the story over with an assistant or a round table of characters, without adding their discussion to the main chat.

<table><tr>
  <td width="72%"><img src="docs/readme/desktop-scratchpad.webp" alt="Scratchpad on desktop"></td>
  <td width="28%"><img src="docs/readme/phone-scratchpad.webp" alt="Scratchpad on a phone"></td>
</tr></table>

</details>

## Get started

### On a computer

1. Download the file ending in **-source.zip** from the [latest release](https://github.com/platberlitz/Neconyan/releases/latest). Unzip it first; on Windows, right-click and choose **Extract All**.
2. Open the folder. Run **Start.bat** on Windows, **Start.command** on macOS, or **bash start.sh** in a terminal on Linux.
3. Give the first start a few minutes to install what it needs. Keep the terminal window open while you use Neconyan.
4. Your browser should open automatically. Otherwise, go to **http://127.0.0.1:4433/**.
5. Open **Connections**, choose your provider and model, and enter your API key or local model's address. Then open a character or an assistant on Home.

Next time, run the same launcher. To stop Neconyan, press **Ctrl+C** in its terminal.

Prefer Git? Clone the repository, then use the same launcher:

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[Computer setup and common startup problems](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Android app

Download the **-android-arm64.apk** from the [latest release](https://github.com/platberlitz/Neconyan/releases/latest) and open it. Allow installation from your browser if Android asks. You need **Android 11 or newer**, **Android System WebView 124 or newer**, and about **2 GiB** free.

The app runs on the phone, without Termux or a computer. Give its first opening time to unpack, then set up **Connections**. Install updates over the existing app to keep your chats.

[Android setup](https://platberlitz.github.io/neconyan-docs/start/android/) · [Build instructions](android/README.md)

### iPhone app

Download the **-ios-unsigned.ipa** from the [latest release](https://github.com/platberlitz/Neconyan/releases/latest), then install it with a sideloading tool such as [iloader](https://github.com/nab138/iloader). You need **iOS 17 or newer**. The app keeps its server and chats on the phone; it isn't on the App Store.

A free Apple account needs to re-sign the app every seven days and permits three sideloaded apps. Update over the existing app with the same Apple account. **Deleting the app deletes its data**, so export a backup first.

[iPhone setup and limits](ios/README.md)

### Other ways to use your phone

- **Android with Termux:** follow the [Termux guide](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux) if you prefer a terminal or have an older phone.
- **Use a computer's installation:** follow the [same-Wi-Fi guide](https://platberlitz.github.io/neconyan-docs/start/phone/). Both devices use the same saved chats; keep the computer running.

## Updates, backups and moving your chats

Open **Server → Updates & Restart → Check for updates**. Git and supported source ZIP installs offer **Update & Restart**. Android offers **Update APK** and asks you to approve installation. Older ZIP copies without an updater need a [manual move to the newer folder](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation).

Git installs also check for updates when launched. Changes you've made to the app's own files can stop an automatic update; your chats and settings don't count.

Coming from SillyTavern or SillyBunny? **Back up first**, give Neconyan its own data folder, then follow [Import your data](https://platberlitz.github.io/neconyan-docs/start/imports/). Check your characters and chats before deleting anything. Some extensions may need adjusting.

[Backups and restoring](https://platberlitz.github.io/neconyan-docs/help/backups/) · [Moving data between devices](docs/data-portability.md)

## Need a hand?

I would start with the [handbook](https://platberlitz.github.io/neconyan-docs/), or ask Miso, Taro or Nori on Home. They can get things wrong, so check their advice before making a change you can't undo.

For missing settings, try **Search** in the sidebar. For errors, use the [troubleshooting guide](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) or [report an issue](https://github.com/platberlitz/Neconyan/issues) with what you were doing and the error shown.

<details>
<summary><b>Other languages</b></summary>

[Deutsch](.github/readme-de_de.md) · [Español](.github/readme-es_es.md) · [Français](.github/readme-fr_fr.md) · [Italiano](.github/readme-it_it.md) · [Nederlands](.github/readme-nl_nl.md) · [Português](.github/readme-pt_pt.md) · [Íslenska](.github/readme-is_is.md) · [Русский](.github/readme-ru_ru.md) · [Українська](.github/readme-uk_ua.md) · [العربية](.github/readme-ar_sa.md) · [ไทย](.github/readme-th_th.md) · [Tiếng Việt](.github/readme-vi_vn.md) · [日本語](.github/readme-ja_jp.md) · [한국어](.github/readme-ko_kr.md) · [简体中文](.github/readme-zh_cn.md) · [繁體中文](.github/readme-zh_tw.md)

Translations may lag behind. This English README is current.

</details>

## Credits

Neconyan is built on the work of everyone behind SillyTavern and SillyBunny; none of this would exist without them. The [included tools list](docs/neconyan-native-tools.md) credits their original authors.

Made by [Platberlitz](https://github.com/platberlitz). Licensed under [GNU AGPL v3](LICENSE). Keep the notices and licences if you redistribute it.
