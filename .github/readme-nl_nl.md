<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

Nieuwste versie: **[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**. De ontwikkeling gaat verder op `staging`.

**Andere talen:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Dit is een vertaling van de [Engelse README](../README.md). Als de twee ooit van elkaar verschillen, is de Engelse de actuele.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - De schattigste LLM-RP-frontend">
</p>

> [!NOTE]
> Alle code hier is door een LLM gegenereerd of met hulp van een LLM geschreven, maar elke prompt en elke agent die met Neconyan wordt meegeleverd, is door mensen gemaakt.

Neconyan is mijn fork met kattenthema van [SillyTavern](https://github.com/SillyTavern/SillyTavern) en [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny), om te chatten en te roleplayen met AI-personages, op je computer of op je telefoon. Het model regel je zelf, met een lokale backend of een API-sleutel, want er zit geen toegang tot een model of tegoed bij.

**[Lees het officiële Neconyan-handboek](https://platberlitz.github.io/neconyan-docs/).** Begin daar voor de installatie en voor vragen over het gebruik van Neconyan. Je vindt er handleidingen met screenshots, een overzicht van alle macro's en uitleg over het maken van extensies. Werkt er iets niet, kijk dan eerst in de [gids voor probleemoplossing](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) voordat je een issue opent.

Wil je SillyTavern waarin alles precies zo werkt als upstream, gebruik dan liever [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny). Ik neem alleen de onderdelen van upstream over die ik wil hebben, dus sommige dingen zien er hier anders uit en werken anders, en sommige extensies werken misschien niet.

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Waarom Neconyan?">
</p>

- **Het gaat door als je weggaat.** Antwoorden worden in de browser geschreven terwijl je meekijkt, omdat dat sneller is. Wissel je halverwege een één-op-één-chat van app of vergrendel je je telefoon, dan bewaart de server het antwoord en krijg je het zodra je die chat weer opent, zonder dat je er twee keer voor betaalt. Op de server lopen Gesprek, Meower en het geheugenwerk sowieso door. Wil je dat de Agents die na een antwoord draaien ook doorwerken, zet ‘Where replies are written’ dan op **On the server**. Voor een paar dingen moet de pagina nog wel open blijven, zoals WebLLM-modellen in de browser en Kokoro-stemmen.
- **Echt gemaakt voor telefoons.** Echte tabbladen met labels, een chatbalk onderin en een uitschuifmenu, en niet de desktopindeling in elkaar geperst.
- **Vier manieren om te chatten.** Klassieke Roleplay, Gesprek in de stijl van een berichtenapp, een sociale tijdlijn genaamd Meower, en Story Mode voor lange verhalen.
- **Verhaalgeheugen.** [Mewmory](../docs/mewmory.md) houdt je verhaal bij, de NPC's die je bent tegengekomen en wat ze zeiden, zodat je niet 200 berichten later alles opnieuw hoeft uit te leggen.
- **Het goede spul zit er al in.** Agents, Chat-archief, Quick Image Gen, Guided Generations, BotSearcher en nog een paar, elk met eigen instellingen. [Hier staan de tools die als losse projecten zijn begonnen, en wie ze heeft gemaakt.](../docs/neconyan-native-tools.md)
- **Een plek voor aantekeningen.** [Notitieboeken](../docs/notebooks.md) geeft je ruimte voor personageconcepten, locaties, scèneplannen en sessiedagboeken, direct naast je chats. Notities linken naar elkaar en naar je lorebooks, en de assistenten kunnen ze bewerken als je dat toestaat.
- **Kleine helpers.** Miso, Taro en Nori kunnen met tool-aanroepen personages met een portret maken, lorebooks bewerken en voorinstellingen of agents aanpassen. De korte Eerste pootjes-rondleiding laat je de basis zien, en [Simple Mode](#simple-mode) houdt de geavanceerde dingen uit beeld tot je ze wilt hebben.
- **Iemand om het verhaal mee door te nemen.** [Scratchpad](../docs/scratchpad.md) is een zijchat naast je verhaal waarin de assistenten, je eigen personages of een hele ronde tafel van hen de scène kunnen lezen en je ideeën kunnen geven, zonder dat er iets van in de chat terechtkomt.
- **Het is schattig.** Calico-thema's, katten die op je berichten liggen te slapen en een pixelkat op de Startpagina. Daar ging het eigenlijk allemaal om.
- **Je bestanden blijven gewoon van jou.** Neconyan leest dezelfde personagekaarten, chats, lorebooks en voorinstellingen als SillyTavern, en er is geen telemetrie.

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Modi">
</p>

Dit zijn in scène gezette demochats, notities en Scratchpad-antwoorden met de meegeleverde assistenten, dus zoek er niet te veel achter.

### Startpagina

Hier kom je binnen. Kies een personage, start een tijdelijke chat, verbind een model of zeg hallo tegen een van de assistenten.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="De Startpagina op de computer"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="De Startpagina op een telefoon"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

Er zitten hier heel wat knoppen in, en de meeste heb je op dag één niet nodig. Simple Mode stopt Mewmory, Chat-archief, Uitbreidingen, de moduskiezer, het grootste deel van Fijnafstemming en de extra knoppen rond het berichtvak weg, en laat je personages, verbindingen, voorinstellingen, lorebooks, Agents, Notitieboeken en Scratchpad over. Nori vraagt of je het wilt voordat de Eerste pootjes-rondleiding begint. Er wordt niets uitgezet, het is alleen verborgen, dus druk op **Show all features** in de zijbalk of zet Simple Mode uit in Instellingen > Weergave wanneer je alles terug wilt.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Een Roleplay-chat met Simple Mode aan, op de computer"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Een Roleplay-chat met Simple Mode aan, op een telefoon"></td>
  </tr>
</table>

### Roleplay

De klassieke chat die je kent van SillyTavern, met een kat die boven op je berichten ligt te slapen.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Roleplay op de computer"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Roleplay op een telefoon"></td>
  </tr>
</table>

### Gesprek

Je personages appen zoals je een vriend appt. Er is een lijst met Vrienden, er zijn groepschats en vertakkingen, en personages kunnen bezig of offline zijn.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Gesprek op de computer"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Gesprek op een telefoon"></td>
  </tr>
</table>

### Meower

Een piepkleine sociale tijdlijn waar je personages berichten plaatsen, op elkaar reageren en peilingen houden over snacks.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower op de computer"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower op een telefoon"></td>
  </tr>
</table>

### Story Mode

De chat omgezet in doorlopend proza, voor als je liever een verhaal leest dan door tekstballonnetjes scrolt.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Story Mode op de computer"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Story Mode op een telefoon"></td>
  </tr>
</table>

### Notitieboeken

Een notitieboek dat naast je chats woont, voor de personageconcepten en scèneplannen die je anders ergens in een tekstbestand kwijtraakt. Het heeft sjablonen, mappen, eigenschappen en een leesweergave, en je kunt het naast een chat openen. [Meer over Notitieboeken.](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Notitieboeken op de computer"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Notitieboeken op een telefoon"></td>
  </tr>
</table>

### Scratchpad

Een zijchat naast je verhaal, voor als je over de scène wilt praten zonder dat de personages meeluisteren. Vraag het aan Miso, Taro of Nori, kopieer een van je personagekaarten of maak je eigen assistent, zet er dan maximaal drie aan een ronde tafel en laat ze erover bekvechten of je plotwending echt werkt. Niets wat je daar schrijft komt in het verhaal terecht. [Meer over Scratchpad.](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad naast een Story Mode-chat op de computer"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad op een telefoon"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Aan de slag">
</p>

Kies wat past bij wat je hebt:

| Wat je hebt | Kies voor |
| --- | --- |
| Een Android-telefoon met Android 11 of nieuwer | [De Android-app](#android-app) |
| Een oudere Android-telefoon, of je houdt van een terminal | [Termux](#android-with-termux) |
| Windows, macOS of Linux | [Een installatie op je computer](#on-a-computer) |
| Een iPhone met iOS 17 of nieuwer, en sideloaden vind je geen probleem | [De iPhone-app](#iphone-app) |
| Een andere iPhone, of je houdt je chats liever op een computer | Een installatie op je computer, en die dan [openen op je telefoon](#opening-it-on-your-phone) |

Wat je ook kiest, je hebt altijd nog een model nodig om mee te praten: een API-sleutel van een aanbieder, of een lokale backend zoals KoboldCpp of Ollama.

<a id="android-app"></a>

### Android-app

Download op Android 11 of nieuwer het bestand dat eindigt op `-android-arm64.apk` uit de [nieuwste release](https://github.com/platberlitz/Neconyan/releases/latest) en open het. Android vraagt waarschijnlijk eerst of je het installeren van apps via je browser wilt toestaan.

Alles draait op de telefoon zelf, dus er komt geen Termux of computer aan te pas. Houd ongeveer 2 GiB vrij en geef de app de eerste keer de tijd om alles uit te pakken. Je hebt ook Android System WebView 124 of nieuwer nodig, en de app laat het je weten als jouw versie te oud is. Om bij te werken installeer je de nieuwe APK over de oude heen, en je chats blijven gewoon staan. [Android: installatie, back-ups en bouwinstructies.](../android/README.md)

<a id="iphone-app"></a>

### iPhone-app

Er is nu ook een losse iPhone-app. Hetzelfde idee als bij Android: de server, je chats en je instellingen staan allemaal op de telefoon, dus je hebt geen computer nodig waarop Neconyan draait. De app staat niet in de App Store, dus je sideloadt hem zelf.

1. Open de [releasepagina](https://github.com/platberlitz/Neconyan/releases/latest) en download het bestand dat eindigt op `-ios-unsigned.ipa`, als die release er een heeft. Zo niet, gebruik dan de [installatie via de browser](#opening-it-on-your-phone).
2. Kies het bestand in een sideloadtool zoals [iloader](https://github.com/nab138/iloader). De tool ondertekent het met je Apple-account en installeert het. Je hebt iOS 17 of nieuwer nodig.
3. Open Neconyan en verbind een model via **Verbindingen**, net als overal elders.

Met een gratis Apple-account moet je de app elke zeven dagen opnieuw ondertekenen, en kun je maar drie apps sideloaden. Om bij te werken installeer je de nieuwe IPA over de oude heen met hetzelfde Apple-account, en je chats blijven gewoon staan. Als je de app verwijdert, ben je ook je chats kwijt, dus exporteer eerst een accountback-up als je overstapt naar een andere sideloadtool.

Importeren gaat door als je van app wisselt of de telefoon vergrendelt. Kies de back-up met de knop **Back-up-ZIP importeren** in de app zelf, bevestig, en de server doet de rest. De server speelt daarbij stilte af, zodat iOS hem niet bevriest terwijl hij bezig is, en je kunt kijken hoe het gaat wanneer je maar wilt. Antwoorden gaan ook door, net als in een browsertabblad op de computer: ga je halverwege een antwoord weg, dan speelt de pagina zelf een stil geluid af tot het antwoord geschreven en opgeslagen is en eventuele Agents die daarna draaien klaar zijn. Je ziet dan misschien ‘Neconyan is finishing a reply’ op het vergrendelscherm, en muziek uit een andere app kan pauzeren tot het klaar is. iOS kan de app nog steeds sluiten als de telefoon te weinig geheugen heeft. Houd ongeveer twee keer de grootte van de back-up vrij terwijl die wordt binnengehaald. [iPhone: installatie, beperkingen en bouwinstructies.](../ios/README.md)

<a id="on-a-computer"></a>

### Op een computer

1. **Neconyan ophalen.** Dat kan op twee manieren, en de tweede werkt zichzelf bij.

   - **Downloaden.** Download het bestand dat eindigt op `-source.zip` uit de [nieuwste release](https://github.com/platberlitz/Neconyan/releases/latest) en pak het uit op een plek die je makkelijk terugvindt, zoals je map Documenten. Klik op Windows eerst met de rechtermuisknop op de zip en kies **Alles uitpakken**, want het startscript werkt niet als je het vanuit de zip opent. Je krijgt dan een map met het versienummer in de naam, zoals `Neconyan-1.3.7`.
   - **Clonen met [Git](https://git-scm.com/downloads).** Open een terminal op de plek waar je de map wilt hebben en voer de regel hieronder uit. Het startscript kijkt dan elke keer dat je het start of er een nieuwe versie is en werkt alles bij voordat het opent. Daarom zou ik voor deze manier gaan.

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **Starten.** Open de Neconyan-map en voer het startscript voor jouw systeem uit.

   | Systeem | Hoe |
   | --- | --- |
   | Windows | Dubbelklik op `Start.bat` |
   | macOS | Dubbelklik op `Start.command` |
   | Linux of WSL | Open een terminal in de map en voer `./start.sh` uit |

   De eerste keer starten duurt een paar minuten. Heb je geen Bun of Node.js (de programma's waar Neconyan eigenlijk op draait), dan installeert het startscript Bun voor je en downloadt het daarna alles wat Neconyan verder nodig heeft. Houd dat venster open zolang je Neconyan gebruikt; als je het sluit of daarin op Ctrl+C drukt, stopt Neconyan.

3. **Openen.** Je browser zou vanzelf moeten openen. Gebeurt dat niet, ga dan naar **http://127.0.0.1:4433/**.
4. **Een model verbinden.** Klik op **Verbindingen** in de zijbalk, kies je aanbieder en model, en plak je API-sleutel of het adres van je lokale backend. Importeer daarna een personage of zeg hallo tegen Miso, Taro of Nori op de Startpagina.

De volgende keer voer je gewoon hetzelfde startscript weer uit.

**Bijwerken.** Git-installaties werken zichzelf bij als je ze start. Bij de zip download je de nieuwe en pak je die uit in een nieuwe map, sluit je Neconyan en kopieer je de map `data` uit de oude Neconyan-map naar de nieuwe, plus `config.yaml` als je die hebt aangepast. Start de nieuwe versie en controleer of je chats er zijn voordat je de oude map verwijdert.

<a id="android-with-termux"></a>

### Android met Termux

[Termux](https://termux.dev/) is een terminalapp voor Android. Het is meer gepriegel dan de app hierboven, maar het werkt ook op oudere telefoons.

1. Installeer Termux via [F-Droid](https://f-droid.org/packages/com.termux/) of [de releases op GitHub](https://github.com/termux/termux-app/releases).
2. Open Termux en werk het bij. Als het stopt en iets vraagt over een configuratiebestand, druk dan op Enter om het huidige te houden.

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Installeer Git en download Neconyan daarna naar je thuismap in Termux. `--depth 1` slaat de oude geschiedenis van het project over, dus de download is kleiner, en bijwerken werkt nog steeds.

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. Start het. De eerste keer worden Node.js en alles wat Neconyan verder nodig heeft geïnstalleerd, dus geef het een paar minuten.

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. Zie je `Go to: http://127.0.0.1:4433/ to open Neconyan`, open dat adres dan in Chrome of een andere browser op de telefoon. Verbind daarna een model via **Verbindingen**, net als op een computer.

Een paar Termux-gewoontes die handig zijn om aan te leren:

- Om Neconyan te stoppen tik je op **CTRL** in de rij extra toetsen en daarna op **C**.
- Open de volgende keer Termux en voer `cd ~/Neconyan && bash start.sh` opnieuw uit. Het werkt zichzelf bij voordat het start.
- Laat de map in je thuismap in Termux staan. Het startscript weigert te draaien vanaf gedeelde opslag zoals `/sdcard`, omdat Android daar de bestandskoppelingen blokkeert die de pakketten van Neconyan nodig hebben.
- In het menu van Chrome geeft **Toevoegen aan startscherm** Neconyan een eigen pictogram.

**Op de achtergrond laten draaien.** Android stopt graag apps waar je niet naar kijkt, en Termux is geen uitzondering. Met deze stappen blijft Neconyan in leven terwijl je in een andere app zit:

1. Trek je meldingen omlaag en controleer of de melding van Termux zegt dat de wake lock actief is. Neconyan vraagt erom bij het starten; is dat niet gelukt, tik daar dan op **Acquire wakelock**.
2. Open in Android **Instellingen → Apps → Termux → Batterij** en kies **Onbeperkt**. De namen verschillen per telefoonmerk, dus zoek in Instellingen naar ‘batterijoptimalisatie’ als je het niet kunt vinden.
3. Op Android 12 of nieuwer stopt Android ook extra processen die Termux start, en Neconyan is daar een van. Zet op Android 14 en hoger de ontwikkelaarsopties aan (tik zeven keer op **Buildnummer** in **Over de telefoon**) en zet daarna **Disable child process restrictions** aan. Op Android 12 en 13 is er geen schakelaar, dus moet je deze twee commando's één keer uitvoeren vanaf een computer met `adb` en USB-foutopsporing:

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

Ook als de server blijft draaien, kan Chrome na een tijdje de pagina zelf nog uit het geheugen halen, en dan laadt Neconyan opnieuw als je terugkomt. Stoort je dat, zet dan **Stay open in the background** aan in **Instellingen → Systeem en apparaat → Memory and performance**. Neconyan speelt dan een geluid af dat te zacht is om te horen terwijl je weg bent, zodat Chrome het als een muziekspeler behandelt en met rust laat. Het kost wat batterij, toont een mediamelding en kan muziek in andere apps pauzeren, en daarom staat het standaard uit. Ik heb het tot nu toe alleen in een geëmuleerde telefoonbrowser getest, niet op een echte telefoon, dus laat het me weten als je telefoon het negeert.

<a id="opening-it-on-your-phone"></a>

### Openen op je telefoon

Draait Neconyan op je computer, dan kan je telefoon het ook gebruiken, zolang ze allebei op hetzelfde wifinetwerk zitten. Op een iPhone is dit ook de aangewezen weg als je de [iPhone-app](#iphone-app) liever niet sideloadt.

Beide browsers gebruiken dezelfde gegevens. Wil je in plaats daarvan een offline installatie tussen apparaten verhuizen, lees dan eerst [Gegevens verplaatsen tussen apparaten](../docs/data-portability.md), inclusief de opzet met een datamap op GitHub, voordat je de map kopieert of synchroniseert.

1. Stop Neconyan en open `config.yaml` in de Neconyan-map met een teksteditor naar keuze. Het bestand verschijnt na de eerste start. Verander `listen: false` in `listen: true`.
2. Zet, nu je daar toch bent, een wachtwoord aan, want anders kan iedereen op je wifi het openen. Stel `basicAuthMode: true` in en verander daarna `username` en `password` onder `basicAuthUser`.
3. Start Neconyan opnieuw en zoek het lokale adres van je computer op.
   - **Windows:** voer `ipconfig` uit in de Opdrachtprompt en zoek naar **IPv4-adres**.
   - **macOS:** houd Option ingedrukt en klik op het wifi-symbool in de menubalk, en zoek dan naar **IP-adres**.
   - **Linux:** voer `hostname -I` uit.
4. Typ in de browser op je telefoon dat adres met `http://` ervoor en `:4433` erachter, bijvoorbeeld `http://192.168.1.20:4433`.

Vraagt Windows om Bun of Node.js door de firewall te laten, sta dat dan toe op privénetwerken. Toont je telefoon een pagina waarop alleen **Verboden** staat, dan deelt je netwerk adressen uit die beginnen met `10.`, en die blokkeert Neconyan standaard. Zet deze regel onder `whitelist:` in `config.yaml` en start Neconyan daarna opnieuw:

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Kiezen tussen Node.js en Bun, en andere opties voor het startscript</b></summary>

Elk systeem heeft ook aparte startscripts voor Node.js en Bun, als je liever zelf kiest:

| Systeem | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

Voor een handmatige installatie heb je Node.js 20 of nieuwer nodig:

```sh
npm install
npm run start:node
```

Bun 1.3.14 of nieuwer werkt ook: voer `bun install` uit en daarna `bun run start`, of `bun run start:mobile` om minder geheugen te gebruiken. Laat het bestand `.npmrc` uit de repo zoals het is.

Wil je niet dat een Git-installatie zichzelf bijwerkt, stel dan `NECONYAN_AUTO_UPDATE=0` in voordat je het startscript uitvoert.

</details>

<details>
<summary><b>Als iets niet wil starten</b></summary>

- **Windows zegt dat het je pc heeft beschermd:** klik op **Meer informatie** en daarna op **Toch uitvoeren**. Dat zegt Windows over de meeste gedownloade startscripts.
- **macOS wil `Start.command` niet openen omdat het van een onbekende ontwikkelaar komt:** klik er met de rechtermuisknop op en kies **Open**. Ga op nieuwere versies van macOS in plaats daarvan naar **Systeeminstellingen → Privacy en beveiliging** en klik op **Open toch**.
- **macOS of Linux zegt dat het startscript niet uitvoerbaar is:** voer dit uit in de Neconyan-map.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Een Git-installatie werkt zichzelf niet meer bij:** het startscript slaat updates over als je een van de eigen bestanden van Neconyan hebt aangepast, en vertelt bij het starten waarom. Je chats en `config.yaml` tellen niet mee.
- **Android:** in Termux is Node.js de standaard. Bun heeft twee extra pakketten nodig, die het Bun-startscript voor je probeert te installeren. Lukt dat niet, installeer ze dan zelf:

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  Stel `GLIBC_ROOT` in als je glibc ergens anders staat dan in `$PREFIX/glibc`.

- **Poort 4433 is bezet:** geef `--port` mee met een ander nummer, of verander de poort in `config.yaml`.

</details>

### Kom je van SillyTavern of SillyBunny?

De meeste personages, chats, lorebooks, persona's en voorinstellingen zouden zonder problemen mee moeten komen, maar ik kan niet beloven dat alles meekomt, en extensies die afhangen van de pagina-indeling van SillyTavern moeten misschien worden aangepast.

- **Maak eerst een back-up van je oude installatie**, en bewaar die tot je hebt gecontroleerd dat alles werkt.
- **Geef Neconyan een eigen datamap.** Laat nooit twee apps dezelfde map gebruiken.

Neconyan maakt de eerste keer dat het draait zijn eigen `config.yaml` en map `data/` aan. Je persoonlijke gegevens, sleutels en geïnstalleerde pakketten zitten nooit in de release.

<details>
<summary><b>Voor ontwikkelaars</b></summary>

`main` bevat releasesnapshots en `staging` is waar het werk gebeurt. Gebruik een aparte checkout en datamap om te testen, zodat je dagelijkse chats erbuiten blijven.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

Browsertests staan in `tests/` en draaien tegen een wegwerpserver: zet `NECONYAN_TEST_BASE_URL` op het adres daarvan (standaard is dat `http://127.0.0.1:4433`). Bouw de frontend voordat je test, en herstart de server nadat je opnieuw hebt gebouwd. Tijdelijke screenshots, testrapporten, build-uitvoer en lokale runtimemappen blijven buiten commits.

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Met dank aan">
</p>

Neconyan bouwt voort op het werk van iedereen achter SillyTavern en SillyBunny; zonder hen zou dit allemaal niet bestaan. De meegeleverde tools en de projecten waar ze vandaan komen, staan vermeld in [de lijst met meegeleverde tools](../docs/neconyan-native-tools.md).

Gemaakt door [Platberlitz](https://github.com/platberlitz). Uitgebracht onder [GNU AGPL v3](../LICENSE), dus laat de vermeldingen en licenties staan als je het verder verspreidt.
