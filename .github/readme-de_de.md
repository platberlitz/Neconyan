<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

Neueste Version: **[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**. Die Entwicklung geht auf `staging` weiter.

**Andere Sprachen:** [English](../README.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Dies ist eine Übersetzung der [englischen README](../README.md). Falls die beiden einmal voneinander abweichen, ist die englische auf dem aktuellen Stand.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - Das niedlichste LLM-RP-Frontend">
</p>

> [!NOTE]
> Der gesamte Code hier wurde von LLMs geschrieben oder mit ihrer Hilfe erstellt, aber jeder Prompt und jeder Agent, der mit Neconyan ausgeliefert wird, ist von Menschen gemacht.

Neconyan ist mein Fork von [SillyTavern](https://github.com/SillyTavern/SillyTavern) und [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) im Katzen-Look, zum Chatten und für Rollenspiele mit KI-Charakteren, am Desktop oder auf dem Handy. Das Modell bringst du selbst mit, entweder als lokales Backend oder über einen API-Schlüssel, denn es sind weder Modellzugang noch Guthaben dabei.

**[Lies das offizielle Neconyan-Handbuch](https://platberlitz.github.io/neconyan-docs/).** Dort fängst du am besten an, wenn es um die Einrichtung oder um Fragen zur Nutzung von Neconyan geht. Es enthält Anleitungen mit Screenshots, eine Makro-Referenz und eine Anleitung zum Erstellen von Erweiterungen. Wenn etwas nicht funktioniert, schau in die [Anleitung zur Fehlerbehebung](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/), bevor du ein Issue eröffnest.

Wenn du ein SillyTavern willst, bei dem alles genau wie im Original funktioniert, nimm stattdessen [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny). Ich übernehme aus dem Original nur die Teile, die ich haben will. Deshalb sehen manche Dinge hier anders aus und verhalten sich anders, und manche Erweiterungen funktionieren vielleicht nicht.

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Warum Neconyan?">
</p>

- **Es läuft weiter, wenn du gehst.** Antworten werden im Browser geschrieben, während du zusiehst, weil das schneller geht. Wenn du mitten in einem Einzelchat die App wechselst oder dein Handy sperrst, hebt der Server die Antwort auf und gibt sie dir, sobald du den Chat wieder öffnest, ohne dass du sie zweimal bezahlst. Konversation, Meower und das Gedächtnis arbeiten ohnehin auf dem Server weiter. Wenn auch die Agenten nach der Antwort weiterlaufen sollen, stell „Where replies are written“ auf **On the server**. Ein paar Dinge brauchen trotzdem die offene Seite, zum Beispiel WebLLM-Modelle im Browser und Kokoro-Stimmen.
- **Es ist wirklich fürs Handy gemacht.** Richtig beschriftete Tabs, eine Chatleiste unten und ein Schiebemenü statt eines zusammengequetschten Desktop-Layouts.
- **Vier Arten zu chatten.** Klassisches Rollenspiel, Konversation im Messenger-Stil, eine Social-Media-Timeline namens Meower und der Story-Modus für längere Texte.
- **Ein Gedächtnis für deine Geschichte.** [Mewmory](../docs/mewmory.md) behält deine Geschichte im Blick, dazu die NPCs, denen du begegnet bist, und was sie gesagt haben. So musst du nach 200 Nachrichten nicht alles noch einmal erklären.
- **Die guten Sachen sind schon eingebaut.** Agenten, Chat-Archiv, Quick Image Gen, Guided Generations, BotSearcher und noch ein paar mehr, jeweils mit eigenen Einstellungen. [Hier sind die, die als eigene Projekte angefangen haben, und wer sie gemacht hat.](../docs/neconyan-native-tools.md)
- **Ein Platz für Notizen.** [Notizbücher](../docs/notebooks.md) bieten dir Raum für Charakterentwürfe, Orte, Szenenpläne und Sitzungstagebücher, direkt neben deinen Chats. Notizen verlinken aufeinander und auf deine Lorebooks, und die Assistenten können sie bearbeiten, wenn du sie lässt.
- **Kleine Helfer.** Miso, Taro und Nori können über Tool-Aufrufe Charaktere mit Porträts erstellen, Lorebooks bearbeiten und Voreinstellungen oder Agenten anpassen. Die kurze Tour „Erste Pfotenschritte“ zeigt dir die Grundlagen, und [Simple Mode](#simple-mode) hält dir die fortgeschrittenen Sachen vom Leib, bis du sie haben willst.
- **Jemand, mit dem du die Geschichte durchsprechen kannst.** [Scratchpad](../docs/scratchpad.md) ist ein Nebenchat neben deiner Geschichte. Dort können die Assistenten, deine eigenen Charaktere oder gleich mehrere von ihnen an einem runden Tisch die Szene lesen und dir Ideen geben, ohne dass etwas davon im Chat landet.
- **Es ist niedlich.** Calico-Themes, Katzen, die auf deinen Nachrichten schlafen, und eine Pixelkatze auf der Startseite. Darum ging es ja eigentlich.
- **Deine Dateien bleiben deine Dateien.** Neconyan liest dieselben Charakterkarten, Chats, Lorebooks und Voreinstellungen wie SillyTavern, und es gibt keine Telemetrie.

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Modi">
</p>

Das hier sind gestellte Demo-Chats, Notizen und Scratchpad-Antworten mit den mitgelieferten Assistenten, also lies nicht zu viel hinein.

### Startseite

Hier landest du. Wähle einen Charakter, starte einen temporären Chat, verbinde ein Modell oder sag einem der Assistenten Hallo.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="Startseite am Desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="Startseite auf dem Handy"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

Hier gibt es eine Menge Knöpfe, und die meisten davon brauchst du am ersten Tag nicht. Simple Mode räumt Mewmory, das Chat-Archiv, die Erweiterungen, die Modusauswahl, den Großteil der Feinabstimmung und die zusätzlichen Knöpfe rund um das Nachrichtenfeld beiseite. Übrig bleiben Charaktere, Verbindungen, Voreinstellungen, Lorebooks, Agenten, Notizbücher und Scratchpad. Nori fragt dich vor der Tour „Erste Pfotenschritte“, ob du Simple Mode nutzen möchtest. Nichts wird abgeschaltet, alles ist nur ausgeblendet. Drück also **Show all features** in der Seitenleiste oder schalte ihn unter Einstellungen > Darstellung aus, wann immer du alles zurückhaben willst.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Ein Rollenspiel-Chat mit eingeschaltetem Simple Mode am Desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Ein Rollenspiel-Chat mit eingeschaltetem Simple Mode auf dem Handy"></td>
  </tr>
</table>

### Rollenspiel

Der klassische Chat, den du von SillyTavern kennst, mit einer Katze, die oben auf deinen Nachrichten schläft.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Rollenspiel am Desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Rollenspiel auf dem Handy"></td>
  </tr>
</table>

### Konversation

Du schreibst deinen Charakteren Nachrichten, so wie du sie auch Freunden schreibst. Es gibt eine Liste „Freunde“, Gruppenchats, Zweige und Charaktere, die beschäftigt oder offline sein können.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Konversation am Desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Konversation auf dem Handy"></td>
  </tr>
</table>

### Meower

Eine winzige Social-Media-Timeline, in der deine Charaktere posten, einander antworten und Umfragen über Snacks starten.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower am Desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower auf dem Handy"></td>
  </tr>
</table>

### Story-Modus

Der Chat als durchgehender Fließtext, für die Momente, in denen du lieber eine Geschichte liest, als dich durch Sprechblasen zu scrollen.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Story-Modus am Desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Story-Modus auf dem Handy"></td>
  </tr>
</table>

### Notizbücher

Ein Notizbuch, das gleich neben deinen Chats wohnt, für die Charakterentwürfe und Szenenpläne, die du sonst irgendwo in einer Textdatei verlieren würdest. Es hat Vorlagen, Ordner, Eigenschaften und eine Leseansicht, und du kannst es neben einem Chat öffnen. [Mehr zu Notizbüchern.](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Notizbücher am Desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Notizbücher auf dem Handy"></td>
  </tr>
</table>

### Scratchpad

Ein Nebenchat neben deiner Geschichte, für die Momente, in denen du über die Szene reden willst, ohne dass die Charaktere mithören. Frag Miso, Taro oder Nori, kopiere eine deiner Charakterkarten oder bau dir einen eigenen Assistenten. Dann setz bis zu drei von ihnen an einen runden Tisch und lass sie darüber streiten, ob dein Plot-Twist zündet. Nichts, was du dort schreibst, landet in der Geschichte. [Mehr zum Scratchpad.](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad neben einem Chat im Story-Modus am Desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad auf dem Handy"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Erste Schritte">
</p>

Nimm einfach den Weg, der zu dem passt, was du hast:

| Was du hast | Der passende Weg |
| --- | --- |
| Ein Android-Handy mit Android 11 oder neuer | [Die Android-App](#android-app) |
| Ein älteres Android-Handy, oder du magst Terminals | [Termux](#android-with-termux) |
| Windows, macOS oder Linux | [Eine Installation auf dem Computer](#on-a-computer) |
| Ein iPhone mit iOS 17 oder neuer, und Sideloading ist für dich in Ordnung | [Die iPhone-App](#iphone-app) |
| Jedes andere iPhone, oder du behältst deine Chats lieber auf einem Computer | Eine Installation auf dem Computer, dann [auf dem Handy öffnen](#opening-it-on-your-phone) |

Egal, wofür du dich entscheidest, du brauchst trotzdem ein Modell, mit dem du reden kannst: einen API-Schlüssel von einem Anbieter oder ein lokales Backend wie KoboldCpp oder Ollama.

<a id="android-app"></a>

### Android-App

Lade unter Android 11 oder neuer die Datei mit der Endung `-android-arm64.apk` aus dem [neuesten Release](https://github.com/platberlitz/Neconyan/releases/latest) herunter und öffne sie. Android fragt dich wahrscheinlich zuerst, ob du das Installieren von Apps aus deinem Browser erlauben willst.

Alles läuft auf dem Handy, Termux oder ein Computer sind also nicht nötig. Lass etwa 2 GiB frei und gib dem ersten Start Zeit zum Entpacken. Außerdem braucht die App Android System WebView 124 oder neuer und sagt dir Bescheid, wenn deine Version zu alt ist. Zum Aktualisieren installierst du die neue APK über die alte, und deine Chats bleiben erhalten. [Einrichtung, Backups und Build-Anleitung für Android.](../android/README.md)

<a id="iphone-app"></a>

### iPhone-App

Inzwischen gibt es auch eine eigenständige iPhone-App. Die Idee ist dieselbe wie bei der Android-App: Der Server, deine Chats und deine Einstellungen liegen alle auf dem Handy, du brauchst also keinen Computer, auf dem Neconyan läuft. Sie ist nicht im App Store, deshalb installierst du sie selbst per Sideloading.

1. Öffne die [Release-Seite](https://github.com/platberlitz/Neconyan/releases/latest) und lade die Datei mit der Endung `-ios-unsigned.ipa` herunter, falls das Release eine enthält. Falls nicht, nimm stattdessen die [Einrichtung über den Browser](#opening-it-on-your-phone).
2. Wähle sie in einem Sideloading-Tool wie [iloader](https://github.com/nab138/iloader) aus. Das Tool signiert sie mit deinem Apple-Account und installiert sie. Du brauchst iOS 17 oder neuer.
3. Öffne Neconyan und verbinde unter **Verbindungen** ein Modell, genau wie überall sonst.

Mit einem kostenlosen Apple-Account musst du die App alle sieben Tage neu signieren, und du kannst nur drei Apps per Sideloading installieren. Zum Aktualisieren installierst du die neue IPA mit demselben Apple-Account über die alte, und deine Chats bleiben erhalten. Wenn du die App löschst, sind auch deine Chats weg. Exportiere also zuerst ein Konto-Backup, wenn du das Sideloading-Tool wechselst.

Importe laufen weiter, wenn du die App wechselst oder das Handy sperrst. Wähle das Backup über den App-eigenen Knopf **Backup-ZIP importieren** aus, bestätige, und der Server übernimmt den Rest. Dabei spielt er Stille ab, damit iOS ihn während der Arbeit nicht einfriert, und du kannst jederzeit wieder nachsehen. Antworten laufen ebenfalls weiter, genau wie in einem Browser-Tab am Desktop: Wenn du mitten in einer Antwort weggehst, spielt die Seite ihren eigenen stummen Ton ab, bis die Antwort geschrieben und gespeichert ist und alle Agenten danach gelaufen sind. Währenddessen siehst du auf dem Sperrbildschirm vielleicht „Neconyan is finishing a reply“, und Musik aus einer anderen App kann so lange pausieren. iOS kann die App trotzdem schließen, wenn dem Handy der Arbeitsspeicher knapp wird. Lass etwa doppelt so viel Platz frei, wie das Backup groß ist, solange es hineinkopiert wird. [Einrichtung, Einschränkungen und Build-Anleitung für das iPhone.](../ios/README.md)

<a id="on-a-computer"></a>

### Auf dem Computer

1. **Neconyan holen.** Es gibt zwei Wege, und der zweite hält sich von selbst aktuell.

   - **Herunterladen.** Lade die Datei mit der Endung `-source.zip` aus dem [neuesten Release](https://github.com/platberlitz/Neconyan/releases/latest) herunter und entpacke sie an einem Ort, den du leicht wiederfindest, etwa in deinem Dokumente-Ordner. Unter Windows klickst du die ZIP-Datei zuerst mit der rechten Maustaste an und wählst **Alle extrahieren**, denn direkt aus der ZIP-Datei heraus funktioniert das Startskript nicht. Am Ende hast du einen Ordner, der nach der Version benannt ist, etwa `Neconyan-1.3.7`.
   - **Mit [Git](https://git-scm.com/downloads) klonen.** Öffne ein Terminal dort, wo der Ordner hin soll, und führe die Zeile unten aus. Das Startskript prüft dann bei jedem Start, ob es eine neue Version gibt, und aktualisiert Neconyan vor dem Öffnen. Deshalb würde ich diesen Weg nehmen.

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **Starten.** Öffne den Neconyan-Ordner und führe das Startskript für dein System aus.

   | System | So geht's |
   | --- | --- |
   | Windows | Doppelklick auf `Start.bat` |
   | macOS | Doppelklick auf `Start.command` |
   | Linux oder WSL | Öffne ein Terminal im Ordner und führe `./start.sh` aus |

   Der erste Start dauert ein paar Minuten. Wenn du weder Bun noch Node.js hast (die Programme, die Neconyan eigentlich ausführen), installiert das Startskript Bun für dich und lädt dann alles andere herunter, was Neconyan braucht. Lass dieses Fenster offen, solange du Neconyan benutzt. Wenn du es schließt oder darin Strg+C drückst, wird Neconyan beendet.

3. **Öffnen.** Dein Browser sollte sich von selbst öffnen. Falls nicht, ruf **http://127.0.0.1:4433/** auf.
4. **Ein Modell verbinden.** Klick in der Seitenleiste auf **Verbindungen**, wähle deinen Anbieter und dein Modell und füge dann deinen API-Schlüssel oder die Adresse deines lokalen Backends ein. Danach importierst du einen Charakter oder sagst Miso, Taro oder Nori auf der Startseite Hallo.

Beim nächsten Mal startest du einfach wieder dasselbe Startskript.

**Aktualisieren.** Git-Installationen aktualisieren sich beim Start selbst. Bei der ZIP-Version lädst du die neue herunter, entpackst sie in einen neuen Ordner und schließt Neconyan. Dann kopierst du den Ordner `data` aus dem alten Neconyan-Ordner in den neuen, dazu `config.yaml`, falls du die Datei geändert hast. Starte die neue Version und prüf, ob deine Chats da sind, bevor du den alten Ordner löschst.

<a id="android-with-termux"></a>

### Android mit Termux

[Termux](https://termux.dev/) ist eine Terminal-App für Android. Der Weg ist fummeliger als mit der App oben, funktioniert aber auch auf älteren Handys.

1. Installiere Termux über [F-Droid](https://f-droid.org/packages/com.termux/) oder [die GitHub-Releases von Termux](https://github.com/termux/termux-app/releases).
2. Öffne Termux und bring es auf den neuesten Stand. Wenn es anhält und nach einer Konfigurationsdatei fragt, drück Enter, um die aktuelle zu behalten.

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Installiere Git und lade Neconyan dann in dein Termux-Home-Verzeichnis herunter. `--depth 1` lässt die alte Versionsgeschichte des Projekts weg, dadurch ist der Download kleiner, und Updates funktionieren trotzdem.

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. Starte es. Beim ersten Start werden Node.js und alles andere installiert, was Neconyan braucht, gib ihm also ein paar Minuten.

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. Wenn du `Go to: http://127.0.0.1:4433/ to open Neconyan` siehst, öffne diese Adresse in Chrome oder einem anderen Browser auf dem Handy. Verbinde dann unter **Verbindungen** ein Modell, genau wie auf dem Computer.

Ein paar Termux-Gewohnheiten, die sich lohnen:

- Um Neconyan zu beenden, tippst du in der Reihe mit den Zusatztasten auf **CTRL** und dann auf **C**.
- Beim nächsten Mal öffnest du Termux und führst wieder `cd ~/Neconyan && bash start.sh` aus. Vor dem Start aktualisiert es sich selbst.
- Lass den Ordner in deinem Termux-Home-Verzeichnis. Das Startskript weigert sich, aus dem gemeinsamen Speicher wie `/sdcard` heraus zu laufen, weil Android dort die Dateiverknüpfungen blockiert, die Neconyans Pakete brauchen.
- Im Chrome-Menü gibt **Zum Startbildschirm hinzufügen** Neconyan ein eigenes Symbol.

**Im Hintergrund am Laufen halten.** Android beendet gern Apps, die du gerade nicht ansiehst, und Termux ist da keine Ausnahme. Mit diesen Schritten bleibt Neconyan am Leben, während du in einer anderen App bist:

1. Zieh die Benachrichtigungen herunter und prüf, ob die Termux-Benachrichtigung meldet, dass der Wake Lock aktiv ist. Neconyan fordert ihn beim Start an. Falls das nicht geklappt hat, tipp dort auf **Acquire wakelock**.
2. Öffne in Android **Einstellungen → Apps → Termux → Akku** und wähle **Uneingeschränkt**. Je nach Handyhersteller heißen und liegen die Menüpunkte etwas anders, such also in den Einstellungen nach „Akkuoptimierung“, wenn du es nicht findest.
3. Ab Android 12 beendet Android außerdem zusätzliche Prozesse, die Termux startet, und Neconyan ist einer davon. Ab Android 14 schaltest du die Entwickleroptionen ein (tipp dazu unter **Über das Telefon** siebenmal auf **Build-Nummer**) und aktivierst dann **Disable child process restrictions**. Unter Android 12 und 13 gibt es keinen solchen Schalter. Dort musst du diese beiden Befehle einmal von einem Computer aus mit `adb` und USB-Debugging ausführen:

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

Selbst wenn der Server weiterläuft, kann Chrome die Seite nach einer Weile trotzdem entladen, sodass Neconyan neu lädt, wenn du zurückkommst. Wenn dich das stört, schalte **Stay open in the background** unter **Einstellungen → System & Gerät → Memory and performance** ein. Dann spielt Neconyan, während du weg bist, einen Ton ab, der zu leise ist, um ihn zu hören, und Chrome behandelt es wie einen Musikplayer und lässt es in Ruhe. Das kostet etwas Akku, zeigt eine Medienbenachrichtigung an und kann Musik in anderen Apps pausieren, deshalb ist es standardmäßig aus. Ich habe es bisher nur in einem emulierten Handy-Browser getestet, nicht auf einem echten Handy. Sag mir also Bescheid, wenn dein Handy es ignoriert.

<a id="opening-it-on-your-phone"></a>

### Auf dem Handy öffnen

Wenn Neconyan auf deinem Computer läuft, kann dein Handy es auch nutzen, solange beide im selben WLAN sind. Auf dem iPhone ist das außerdem der richtige Weg, wenn du die [iPhone-App](#iphone-app) lieber nicht per Sideloading installieren willst.

Beide Browser nutzen dieselben Daten. Wenn du stattdessen eine Offline-Installation zwischen Geräten umziehen willst, lies [Daten zwischen Geräten umziehen](../docs/data-portability.md), auch den Teil zur Einrichtung des Datenordners über GitHub, bevor du den Ordner kopierst oder synchronisierst.

1. Beende Neconyan und öffne `config.yaml` im Neconyan-Ordner mit einem beliebigen Texteditor. Die Datei entsteht beim ersten Start. Ändere `listen: false` in `listen: true`.
2. Wenn du schon mal dabei bist, richte ein Passwort ein, denn sonst kann jeder in deinem WLAN Neconyan öffnen. Setz `basicAuthMode: true` und ändere dann `username` und `password` unter `basicAuthUser`.
3. Starte Neconyan wieder und finde die lokale Adresse deines Computers heraus.
   - **Windows:** Führe in der Eingabeaufforderung `ipconfig` aus und such nach **IPv4-Adresse**.
   - **macOS:** Halte die Wahltaste gedrückt, klick in der Menüleiste auf das WLAN-Symbol und such nach **IP-Adresse**.
   - **Linux:** Führe `hostname -I` aus.
4. Gib im Browser deines Handys diese Adresse ein, mit `http://` davor und `:4433` dahinter, zum Beispiel `http://192.168.1.20:4433`.

Wenn Windows fragt, ob Bun oder Node.js durch die Firewall dürfen, erlaube es für private Netzwerke. Wenn dein Handy eine Seite anzeigt, auf der nur **Forbidden** steht, vergibt dein Netzwerk Adressen, die mit `10.` beginnen, und die blockiert Neconyan standardmäßig. Füg diese Zeile unter `whitelist:` in `config.yaml` hinzu und starte Neconyan dann neu:

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Node.js oder Bun wählen und weitere Optionen für das Startskript</b></summary>

Für jedes System gibt es außerdem eigene Startskripte für Node.js und Bun, falls du lieber selbst wählen willst:

| System | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

Für eine Installation von Hand brauchst du Node.js 20 oder neuer:

```sh
npm install
npm run start:node
```

Bun 1.3.14 oder neuer funktioniert auch: Führe `bun install` aus und dann `bun run start`, oder `bun run start:mobile`, wenn es weniger Arbeitsspeicher verbrauchen soll. Lass die Datei `.npmrc` des Repos so, wie sie ist.

Damit sich eine Git-Installation nicht mehr selbst aktualisiert, setz `NECONYAN_AUTO_UPDATE=0`, bevor du das Startskript ausführst.

</details>

<details>
<summary><b>Wenn etwas nicht startet</b></summary>

- **Windows meldet, dass es deinen PC geschützt hat:** Klick auf **Weitere Informationen** und dann auf **Trotzdem ausführen**. Das meldet Windows bei den meisten heruntergeladenen Startskripten.
- **macOS öffnet `Start.command` nicht, weil es von einem nicht verifizierten Entwickler stammt:** Klick es mit der rechten Maustaste an und wähle **Öffnen**. Bei neueren macOS-Versionen gehst du stattdessen zu **Systemeinstellungen → Datenschutz & Sicherheit** und klickst auf **Dennoch öffnen**.
- **macOS oder Linux meldet, dass das Startskript nicht ausführbar ist:** Führe das hier im Neconyan-Ordner aus.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Eine Git-Installation aktualisiert sich nicht mehr:** Das Startskript überspringt Updates, wenn du eine von Neconyans eigenen Dateien bearbeitet hast, und sagt dir beim Start, warum. Deine Chats und `config.yaml` zählen nicht dazu.
- **Android:** In Termux ist Node.js der Standard. Bun braucht zwei zusätzliche Pakete, die das Bun-Startskript für dich zu installieren versucht. Wenn das nicht klappt, installiere sie selbst:

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  Setz `GLIBC_ROOT`, wenn dein glibc woanders liegt als unter `$PREFIX/glibc`.

- **Port 4433 ist belegt:** Gib `--port` mit einer anderen Nummer an oder ändere den Port in `config.yaml`.

</details>

### Du kommst von SillyTavern oder SillyBunny?

Die meisten deiner Charaktere, Chats, Lorebooks, Personas und Voreinstellungen sollten problemlos mitkommen, aber ich kann nicht versprechen, dass alles klappt. Erweiterungen, die sich auf das Seitenlayout von SillyTavern verlassen, müssen eventuell angepasst werden.

- **Sichere zuerst deine alte Installation** und behalte das Backup, bis du geprüft hast, dass alles funktioniert.
- **Gib Neconyan einen eigenen Datenordner.** Lass nie zwei Apps auf denselben zeigen.

Neconyan legt beim ersten Start seine eigene `config.yaml` und seinen eigenen Ordner `data/` an. Deine persönlichen Daten, Schlüssel und installierten Pakete sind nie Teil des Releases.

<details>
<summary><b>Für Entwickler</b></summary>

`main` enthält die Release-Stände, und auf `staging` wird gearbeitet. Nimm zum Testen einen separaten Checkout und Datenordner, damit deine alltäglichen Chats außen vor bleiben.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

Browsertests liegen in `tests/` und laufen gegen einen Wegwerf-Server: Setz `NECONYAN_TEST_BASE_URL` auf seine Adresse (Standard ist `http://127.0.0.1:4433`). Bau das Frontend vor dem Testen und starte den Server nach jedem neuen Build neu. Temporäre Screenshots, Testberichte, Build-Ausgaben und lokale Laufzeitordner kommen nicht in Commits.

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Danksagung">
</p>

Neconyan baut auf der Arbeit aller auf, die hinter SillyTavern und SillyBunny stehen. Ohne sie gäbe es nichts von alledem. Die mitgelieferten Tools und die Projekte, aus denen sie stammen, werden in [der Liste der enthaltenen Tools](../docs/neconyan-native-tools.md) gewürdigt.

Gemacht von [Platberlitz](https://github.com/platberlitz). Lizenziert unter [GNU AGPL v3](../LICENSE). Wenn du es weiterverbreitest, lass also die Hinweise und Lizenzen drin.
