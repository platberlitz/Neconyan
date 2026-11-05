<!-- Translated from README.md at commit de66c177 (Neconyan 1.5.0). Keep the structure in step with the English README. -->

# Neconyan~

De nieuwste versie is [1.5.0](https://github.com/platberlitz/Neconyan/releases/latest).

**Lees in je eigen taal:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Deze vertaling kan achterlopen. De [Engelse README](../README.md) is actueel.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - De schattigste LLM-RP-frontend">
</p>

Neconyan is mijn fork met kattenthema van [SillyTavern](https://github.com/SillyTavern/SillyTavern) en [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny), om te chatten en te roleplayen met AI-personages, op je computer of op je telefoon. Een API-sleutel of lokaal model neem je zelf mee; de app bevat geen toegang tot een model en geen tegoed.

**[Neconyan downloaden](https://github.com/platberlitz/Neconyan/releases/latest)** · **[Het handboek lezen](https://platberlitz.github.io/neconyan-docs/)** · **[Hulp krijgen](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> Alle code hier is door een LLM gegenereerd of met hulp van een LLM geschreven. Elke prompt en elke agent die met Neconyan wordt meegeleverd, is door mensen gemaakt.

## Wat zit er allemaal in?

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Waarom Neconyan?">
</p>

- **Vier manieren om te chatten:** klassieke Roleplay, Gesprek in de stijl van een berichtenapp, een sociale tijdlijn genaamd Meower en Story Mode voor doorlopend proza.
- **Een indeling die voor telefoons is gemaakt**, met gelabelde bedieningselementen, een chatbalk onderin en een uitschuifmenu. **Simple Mode** verbergt de minder gebruikte bedieningselementen tot je ze wilt gebruiken.
- **Mewmory** onthoudt gebeurtenissen en personages uit je verhaal. **Agents** kunnen trackers bijhouden, een antwoord controleren of een aparte Metgezel-notitie schrijven.
- **Catelier** helpt je bij het schrijven van personagekaarten en lorebooks. **Notitieboeken** houdt je notities binnen handbereik, en **Scratchpad** geeft je een aparte chat om ideeën door te praten.
- **Miso, Taro en Nori** helpen je dingen te vinden en kunnen met jouw toestemming ondersteunde bewerkingen uitvoeren.
- **Thema's, accentkleuren en katten.** Best veel katten. Je kunt ze verbergen, al kan ik me niet voorstellen waarom je dat zou willen.

Je personagekaarten, chats, lorebooks en voorinstellingen gebruiken vertrouwde SillyTavern-formaten. Er is geen telemetrie. Sommige functies en extensies van upstream werken hier anders; ik neem alleen de onderdelen over die ik wil hebben. De [lijst met meegeleverde tools](../docs/neconyan-native-tools.md) bevat de bronvermelding voor de projecten die met Neconyan worden meegeleverd.

## Neem een kijkje

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Modi">
</p>

Nieuwe screenshots van de computer en de telefoon, gemaakt met demochats, notities en de meegeleverde assistenten.

### Startpagina

Kies een personage, verbind een model of zeg hallo tegen een assistent.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="De Startpagina op de computer"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="De Startpagina op een telefoon"></td>
</tr></table>

### Roleplay

Schrijf een scène, probeer een ander antwoord of pak een oude chat weer op.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Roleplay op de computer"></td>
  <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Roleplay op een telefoon"></td>
</tr></table>

### Catelier

Werk aan een personageconcept, vraag om hulp bij het schrijven en bekijk de wijzigingen voordat je ze in je bibliotheek opslaat.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-catelier.webp" alt="Catelier op de computer"></td>
  <td width="28%"><img src="../docs/readme/phone-catelier.webp" alt="Catelier op een telefoon"></td>
</tr></table>

<details>
<summary><b>Meer screenshots: Simple Mode, Gesprek, Meower, Story Mode, Notitieboeken en Scratchpad</b></summary>

### Simple Mode

Minder bedieningselementen terwijl je wegwijs wordt. **Show all features** in de zijbalk haalt ze terug; er wordt niets uitgezet.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Simple Mode op de computer"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Simple Mode op een telefoon"></td>
</tr></table>

### Gesprek

Stuur je personages een appje, maak groepschats en laat ze bezig of offline zijn.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Gesprek op de computer"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Gesprek op een telefoon"></td>
</tr></table>

### Meower

Een sociale tijdlijn waar je personages berichten plaatsen, reageren en peilingen houden.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower op de computer"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower op een telefoon"></td>
</tr></table>

### Story Mode

Lees je chat als doorlopend proza.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Story Mode op de computer"></td>
  <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Story Mode op een telefoon"></td>
</tr></table>

### Notitieboeken

Bewaar scèneplannen, locaties en sessiedagboeken naast je chats.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Notitieboeken op de computer"></td>
  <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Notitieboeken op een telefoon"></td>
</tr></table>

### Scratchpad

Praat het verhaal door met een assistent of een ronde tafel van personages, zonder dat hun discussie in de hoofdchat belandt.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad op de computer"></td>
  <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad op een telefoon"></td>
</tr></table>

</details>

## Aan de slag

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Aan de slag">
</p>

### Op een computer

1. Download het bestand dat eindigt op **-source.zip** uit de [nieuwste release](https://github.com/platberlitz/Neconyan/releases/latest). Pak het eerst uit; klik op Windows met de rechtermuisknop en kies **Alles uitpakken**.
2. Open de map. Voer **Start.bat** uit op Windows, **Start.command** op macOS, of **bash start.sh** in een terminal op Linux.
3. Geef de eerste start een paar minuten de tijd om te installeren wat nodig is. Houd het terminalvenster open zolang je Neconyan gebruikt.
4. Je browser zou vanzelf moeten openen. Gebeurt dat niet, ga dan naar **http://127.0.0.1:4433/**.
5. Open **Verbindingen**, kies je aanbieder en model, en voer je API-sleutel of het adres van je lokale model in. Open daarna op de Startpagina een personage of een assistent.

De volgende keer voer je hetzelfde startscript uit. Om Neconyan te stoppen, druk je in de bijbehorende terminal op **Ctrl+C**.

Liever Git? Clone de repository en gebruik daarna hetzelfde startscript:

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[Installatie op de computer en veelvoorkomende opstartproblemen](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Android-app

Download het bestand **-android-arm64.apk** uit de [nieuwste release](https://github.com/platberlitz/Neconyan/releases/latest) en open het. Sta installatie vanuit je browser toe als Android daarom vraagt. Je hebt **Android 11 of nieuwer**, **Android System WebView 124 of nieuwer** en ongeveer **2 GiB** vrije ruimte nodig.

De app draait op de telefoon, zonder Termux of computer. Geef de app de eerste keer de tijd om alles uit te pakken en stel daarna **Verbindingen** in. Installeer updates over de bestaande app heen, dan blijven je chats staan.

[Android-installatie](https://platberlitz.github.io/neconyan-docs/start/android/) · [Bouwinstructies](../android/README.md)

### iPhone-app

Download het bestand **-ios-unsigned.ipa** uit de [nieuwste release](https://github.com/platberlitz/Neconyan/releases/latest) en installeer het daarna met een sideloadtool zoals [iloader](https://github.com/nab138/iloader). Je hebt **iOS 17 of nieuwer** nodig. De app bewaart de server en je chats op de telefoon; de app staat niet in de App Store.

Met een gratis Apple-account moet je de app elke zeven dagen opnieuw ondertekenen en kun je maximaal drie apps sideloaden. Installeer updates met hetzelfde Apple-account over de bestaande app heen. **Als je de app verwijdert, ben je ook je gegevens kwijt**, dus exporteer eerst een back-up.

[iPhone-installatie en beperkingen](../ios/README.md)

### Andere manieren om je telefoon te gebruiken

- **Android met Termux:** volg de [Termux-gids](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux) als je liever een terminal gebruikt of een oudere telefoon hebt.
- **De installatie van een computer gebruiken:** volg de [gids voor gebruik via hetzelfde wifinetwerk](https://platberlitz.github.io/neconyan-docs/start/phone/). Beide apparaten gebruiken dezelfde opgeslagen chats; laat de computer aanstaan.

## Updates, back-ups en je chats verhuizen

Open **Server → Updates & Herstarten → Controleren op updates**. Git-installaties en ondersteunde zip-installaties van de broncode bieden **Bijwerken & Herstarten** aan. Android biedt **Update APK** aan en vraagt je de installatie goed te keuren. Oudere zip-kopieën zonder updater hebben een [handmatige verhuizing naar de nieuwere map](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation) nodig.

Git-installaties controleren ook bij het opstarten op updates. Wijzigingen die je in de eigen bestanden van de app hebt aangebracht, kunnen een automatische update tegenhouden; je chats en instellingen tellen niet mee.

Kom je van SillyTavern of SillyBunny? **Maak eerst een back-up**, geef Neconyan een eigen datamap en volg daarna [Je gegevens importeren](https://platberlitz.github.io/neconyan-docs/start/imports/). Controleer je personages en chats voordat je iets verwijdert. Sommige extensies moeten misschien worden aangepast.

[Back-ups en herstellen](https://platberlitz.github.io/neconyan-docs/help/backups/) · [Gegevens verplaatsen tussen apparaten](../docs/data-portability.md)

## Hulp nodig?

Ik zou beginnen met het [handboek](https://platberlitz.github.io/neconyan-docs/), of het vragen aan Miso, Taro of Nori op de Startpagina. Zij kunnen zich vergissen, dus controleer hun advies voordat je iets verandert wat je niet ongedaan kunt maken.

Als je een instelling niet kunt vinden, probeer dan **Zoekopdracht** in de zijbalk. Bij fouten kun je de [gids voor probleemoplossing](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) gebruiken of [een issue melden](https://github.com/platberlitz/Neconyan/issues) en erbij zetten wat je aan het doen was en welke fout je zag.

## Met dank aan

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Met dank aan">
</p>

Neconyan bouwt voort op het werk van iedereen achter SillyTavern en SillyBunny; zonder hen zou dit allemaal niet bestaan. De [lijst met meegeleverde tools](../docs/neconyan-native-tools.md) vermeldt de oorspronkelijke auteurs van die tools.

Gemaakt door [Platberlitz](https://github.com/platberlitz). Uitgebracht onder [GNU AGPL v3](../LICENSE). Laat de vermeldingen en licenties staan als je het verder verspreidt.
