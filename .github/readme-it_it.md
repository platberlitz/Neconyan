<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

Ultima release: **[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**. Lo sviluppo continua su `staging`.

**Altre lingue:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Questa è una traduzione del [README in inglese](../README.md). Se un giorno le due versioni non dovessero coincidere, quella aggiornata è quella inglese.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - Il frontend RP per LLM più carino che ci sia">
</p>

> [!NOTE]
> Tutto il codice di questo progetto è generato da un LLM o scritto con il suo aiuto, ma ogni prompt e ogni agente incluso in Neconyan è opera umana.

Neconyan è il mio fork a tema gatti di [SillyTavern](https://github.com/SillyTavern/SillyTavern) e [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) per chattare e fare roleplay con personaggi IA, dal computer o dal telefono. Il modello lo porti tu, con un backend locale o una chiave API, perché non include l'accesso a nessun modello né crediti.

**[Leggi il manuale ufficiale di Neconyan](https://platberlitz.github.io/neconyan-docs/).** Parti da lì per l'installazione e per qualsiasi dubbio sull'uso di Neconyan. Contiene guide con screenshot, un riferimento delle macro e le istruzioni per creare estensioni. Se qualcosa non funziona, prova la [guida alla risoluzione dei problemi](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) prima di aprire una issue.

Se vuoi un SillyTavern che funzioni in tutto e per tutto come l'originale, usa invece [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny). Dal progetto originale prendo solo le parti che mi interessano, quindi qui alcune cose hanno un aspetto e un comportamento diversi, e alcune estensioni potrebbero non funzionare.

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Perché Neconyan?">
</p>

- **Va avanti anche quando esci.** Le risposte vengono scritte nel browser mentre guardi, perché così è più veloce. Se cambi app o blocchi il telefono a metà di una chat a tu per tu, il server tiene da parte la risposta e te la consegna quando riapri quella chat, senza fartela pagare due volte. Conversazione, Meower e il lavoro sulla memoria proseguono comunque sul server. Se vuoi che vadano avanti anche gli Agenti che partono dopo la risposta, imposta «Where replies are written» su **On the server**. Alcune cose hanno ancora bisogno della pagina aperta, come i modelli WebLLM nel browser e le voci Kokoro.
- **È fatto davvero per i telefoni.** Schede vere con le loro etichette, una barra della chat in basso e un menu a scomparsa, non il layout desktop schiacciato.
- **Quattro modi di chattare.** Il classico Roleplay, Conversazione in stile app di messaggistica, una timeline social chiamata Meower e la Modalità storia per scrivere testi lunghi.
- **Memoria della storia.** [Mewmory](../docs/mewmory.md) tiene traccia della tua storia, degli NPC che hai incontrato e di quello che hanno detto, così non devi rispiegare tutto da capo dopo 200 messaggi.
- **Il meglio è già incluso.** Agenti, Archivio chat, Quick Image Gen, Guided Generations, BotSearcher e qualcun altro, ognuno con le sue impostazioni. [Ecco quelli nati come progetti separati, e chi li ha creati.](../docs/neconyan-native-tools.md)
- **Un posto per gli appunti.** [Taccuini](../docs/notebooks.md) ti dà spazio per bozze di personaggi, luoghi, piani delle scene e diari delle sessioni, proprio accanto alle tue chat. Le note si collegano tra loro e ai tuoi lorebook, e gli assistenti possono modificarle se glielo permetti.
- **Piccoli aiutanti.** Miso, Taro e Nori possono usare le chiamate agli strumenti per creare personaggi con tanto di ritratto, modificare i lorebook e regolare preset o agenti. Il breve tour dei primi passi felpati ti mostra le basi, e la [Simple Mode](#simple-mode) tiene da parte le funzioni avanzate finché non ti servono.
- **Qualcuno con cui parlare della storia.** [Scratchpad](../docs/scratchpad.md) è una chat laterale accanto alla tua storia, dove gli assistenti, i tuoi personaggi o un'intera tavola rotonda formata da loro possono leggere la scena e darti idee, senza che niente di tutto questo finisca nella chat.
- **È carino.** Temi Calico, gatti che sonnecchiano sui tuoi messaggi e un gatto in pixel art nella Home. In fondo era proprio questo lo scopo.
- **I tuoi file restano tuoi.** Legge le stesse schede personaggio, chat, lorebook e preset di SillyTavern, e non c'è telemetria.

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Modalità">
</p>

Sono esempi messi in scena: chat, note e risposte di Scratchpad con gli assistenti inclusi, quindi non darci troppo peso.

### Home

È da qui che si parte. Scegli un personaggio, avvia una chat temporanea, collega un modello o saluta uno degli assistenti.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="La Home su desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="La Home su un telefono"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

Qui dentro ci sono un sacco di pulsanti, e il primo giorno la maggior parte non ti serve. La Simple Mode mette da parte Mewmory, Archivio chat, Estensioni, il selettore delle modalità, quasi tutta la Regolazione fine e i pulsanti extra intorno alla casella del messaggio, e ti lascia personaggi, connessioni, preset, lorebook, Agenti, Taccuini e Scratchpad. Nori ti chiede se la vuoi prima che parta il tour dei primi passi felpati. Non viene disattivato niente, è solo nascosto, quindi quando vuoi riavere tutto premi **Show all features** nella barra laterale o disattivala in Impostazioni > Aspetto.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Una chat Roleplay con la Simple Mode attiva, su desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Una chat Roleplay con la Simple Mode attiva, su un telefono"></td>
  </tr>
</table>

### Roleplay

La classica chat che conosci da SillyTavern, con un gatto addormentato sopra i tuoi messaggi.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Roleplay su desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Roleplay su un telefono"></td>
  </tr>
</table>

### Conversazione

Scrivi ai tuoi personaggi come scriveresti a un amico. C'è la lista «Amici», ci sono le chat di gruppo, le ramificazioni e personaggi che possono essere occupati o offline.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Conversazione su desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Conversazione su un telefono"></td>
  </tr>
</table>

### Meower

Una piccola timeline social dove i tuoi personaggi pubblicano post, si rispondono a vicenda e lanciano sondaggi sugli spuntini.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower su desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower su un telefono"></td>
  </tr>
</table>

### Modalità storia

La chat trasformata in prosa continua, per quando preferisci leggere una storia invece di scorrere tra le nuvolette.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Modalità storia su desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Modalità storia su un telefono"></td>
  </tr>
</table>

### Taccuini

Un taccuino che vive accanto alle tue chat, per le bozze dei personaggi e i piani delle scene che altrimenti perderesti in qualche file di testo chissà dove. Ha modelli, cartelle, proprietà e una vista di lettura, e puoi aprirlo accanto a una chat. [Scopri di più su Taccuini.](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Taccuini su desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Taccuini su un telefono"></td>
  </tr>
</table>

### Scratchpad

Una chat laterale che sta accanto alla tua storia, per quando vuoi parlare della scena senza che i personaggi ti sentano. Chiedi a Miso, Taro o Nori, copia una delle tue schede personaggio o crea un assistente tutto tuo, poi mettine fino a tre attorno a una tavola rotonda e lasciali discutere se il tuo colpo di scena funziona. Niente di quello che scrivi lì finisce nella storia. [Scopri di più su Scratchpad.](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad accanto a una chat in Modalità storia, su desktop"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad su un telefono"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Per iniziare">
</p>

Scegli la strada che fa per te in base a quello che hai:

| Hai | Scegli |
| --- | --- |
| Un telefono Android con Android 11 o successivo | [L'app Android](#android-app) |
| Un telefono Android più vecchio, oppure ti piace il terminale | [Termux](#android-with-termux) |
| Windows, macOS o Linux | [Un'installazione sul computer](#on-a-computer) |
| Un iPhone con iOS 17 o successivo, e il sideloading non ti spaventa | [L'app per iPhone](#iphone-app) |
| Qualsiasi altro iPhone, oppure preferisci tenere le chat su un computer | Un'installazione sul computer, poi [aprilo dal telefono](#opening-it-on-your-phone) |

Qualunque strada tu scelga, ti serve comunque un modello con cui parlare: una chiave API di un provider, oppure un backend locale come KoboldCpp o Ollama.

<a id="android-app"></a>

### App Android

Su Android 11 o successivo, scarica il file che termina con `-android-arm64.apk` dall'[ultima release](https://github.com/platberlitz/Neconyan/releases/latest) e aprilo. Probabilmente Android ti chiederà prima di consentire l'installazione di app dal browser.

Tutto gira sul telefono, quindi non servono né Termux né un computer. Lascia liberi circa 2 GiB e dai alla prima apertura il tempo di scompattare tutto. Serve anche Android System WebView 124 o successivo, e se la tua è troppo vecchia te lo dice l'app. Per aggiornare, installa il nuovo APK sopra il vecchio: le tue chat restano dove sono. [Configurazione Android, backup e istruzioni per la compilazione.](../android/README.md)

<a id="iphone-app"></a>

### App per iPhone

Adesso c'è anche un'app per iPhone indipendente. L'idea è la stessa di quella Android: il server, le tue chat e le tue impostazioni stanno tutti sul telefono, quindi non ti serve un computer con Neconyan in esecuzione. Non è sull'App Store, quindi la installi tu in sideloading.

1. Apri la [pagina della release](https://github.com/platberlitz/Neconyan/releases/latest) e scarica il file che termina con `-ios-unsigned.ipa`, se quella release lo include. Se non c'è, usa invece la [configurazione tramite browser](#opening-it-on-your-phone).
2. Selezionalo in uno strumento di sideloading come [iloader](https://github.com/nab138/iloader). Lo strumento lo firma con il tuo account Apple e lo installa. Ti serve iOS 17 o successivo.
3. Apri Neconyan e collega un modello da **Connessioni**, come da qualsiasi altra parte.

Con un account Apple gratuito devi rifirmare l'app ogni sette giorni e puoi installare in sideloading solo tre app. Per aggiornare, installa il nuovo IPA sopra il vecchio con lo stesso account Apple: le tue chat restano dove sono. Se elimini l'app elimini anche le chat, quindi se cambi strumento di sideloading esporta prima un backup dell'account.

Le importazioni vanno avanti anche se cambi app o blocchi il telefono. Scegli il backup con il pulsante **Importa backup ZIP** dell'app, conferma, e al resto pensa il server: riproduce del silenzio perché iOS non lo congeli mentre lavora, e tu puoi ricontrollare quando vuoi. Anche le risposte vanno avanti, come in una scheda del browser su desktop: se esci a metà di una risposta, la pagina riproduce un suo suono silenzioso finché la risposta non è scritta e salvata e gli eventuali Agenti che seguono non hanno finito. Nel frattempo potresti vedere «Neconyan is finishing a reply» sulla schermata di blocco, e la musica di un'altra app potrebbe andare in pausa fino alla fine. iOS può comunque chiudere l'app se il telefono resta a corto di memoria. Mentre il backup viene copiato, lascia libero circa il doppio della sua dimensione. [Configurazione iPhone, limiti e istruzioni per la compilazione.](../ios/README.md)

<a id="on-a-computer"></a>

### Su un computer

1. **Procurati Neconyan.** Ci sono due modi, e il secondo si tiene aggiornato da solo.

   - **Scaricalo.** Prendi il file che termina con `-source.zip` dall'[ultima release](https://github.com/platberlitz/Neconyan/releases/latest) ed estrailo in un posto facile da trovare, come la cartella Documenti. Su Windows, prima fai clic destro sullo zip e scegli **Estrai tutto**, perché lo script di avvio non funziona se lo lanci da dentro lo zip. Alla fine avrai una cartella con il nome della versione, per esempio `Neconyan-1.3.7`.
   - **Clonalo con [Git](https://git-scm.com/downloads).** Apri un terminale nel punto in cui vuoi la cartella ed esegui il comando qui sotto. Da quel momento lo script di avvio controlla se c'è una nuova versione ogni volta che lo lanci e si aggiorna prima di aprirsi: per questo è la strada che sceglierei io.

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **Avvialo.** Apri la cartella di Neconyan ed esegui lo script di avvio per il tuo sistema.

   | Sistema | Come |
   | --- | --- |
   | Windows | Fai doppio clic su `Start.bat` |
   | macOS | Fai doppio clic su `Start.command` |
   | Linux o WSL | Apri un terminale nella cartella ed esegui `./start.sh` |

   Il primo avvio richiede qualche minuto. Se non hai Bun o Node.js (i programmi che fanno davvero girare Neconyan), lo script di avvio installa Bun per te e poi scarica tutto il resto che serve a Neconyan. Tieni aperta quella finestra mentre usi Neconyan: se la chiudi, o se premi Ctrl+C al suo interno, Neconyan si ferma.

3. **Aprilo.** Il browser dovrebbe aprirsi da solo. Se non succede, vai su **http://127.0.0.1:4433/**.
4. **Collega un modello.** Fai clic su **Connessioni** nella barra laterale, scegli il provider e il modello, poi incolla la tua chiave API o l'indirizzo del tuo backend locale. Dopodiché importa un personaggio o saluta Miso, Taro o Nori nella Home.

La prossima volta, esegui di nuovo lo stesso script di avvio.

**Aggiornamenti.** Le installazioni fatte con Git si aggiornano da sole quando le avvii. Con lo zip, scarica quello nuovo ed estrailo in una nuova cartella, chiudi Neconyan, poi copia la cartella `data` dalla vecchia cartella di Neconyan a quella nuova, insieme a `config.yaml` se l'hai modificato. Avvia la nuova installazione e controlla che le chat ci siano prima di eliminare la vecchia cartella.

<a id="android-with-termux"></a>

### Android con Termux

[Termux](https://termux.dev/) è un'app terminale per Android. È più macchinosa dell'app descritta sopra, ma funziona anche sui telefoni più vecchi.

1. Installa Termux da [F-Droid](https://f-droid.org/packages/com.termux/) o dalle [sue release su GitHub](https://github.com/termux/termux-app/releases).
2. Apri Termux e aggiornalo. Se si ferma a chiederti qualcosa su un file di configurazione, premi Invio per tenere quello attuale.

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Installa Git, poi scarica Neconyan nella home di Termux. `--depth 1` salta la vecchia cronologia del progetto, così il download è più leggero, e gli aggiornamenti funzionano lo stesso.

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. Avvialo. Il primo avvio installa Node.js e tutto il resto che serve a Neconyan, quindi dagli qualche minuto.

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. Quando vedi `Go to: http://127.0.0.1:4433/ to open Neconyan`, apri quell'indirizzo in Chrome o in un altro browser sul telefono. Poi collega un modello da **Connessioni**, come su un computer.

Qualche abitudine utile con Termux:

- Per fermare Neconyan, tocca **CTRL** nella riga dei tasti extra, poi **C**.
- La prossima volta, apri Termux ed esegui di nuovo `cd ~/Neconyan && bash start.sh`. Si aggiorna da solo prima di avviarsi.
- Tieni la cartella nella home di Termux. Lo script di avvio si rifiuta di partire dalla memoria condivisa, come `/sdcard`, perché lì Android blocca i collegamenti ai file di cui hanno bisogno i pacchetti di Neconyan.
- Nel menu di Chrome, **Aggiungi a schermata Home** dà a Neconyan un'icona tutta sua.

**Tenerlo attivo in background.** Ad Android piace fermare le app che non stai guardando, e Termux non fa eccezione. Questi passaggi tengono in vita Neconyan mentre sei in un'altra app:

1. Abbassa la tendina delle notifiche e controlla che quella di Termux dica che il wake lock è attivo. Neconyan lo richiede all'avvio; se non ha funzionato, tocca **Acquire wakelock** nella notifica.
2. Apri **Impostazioni → App → Termux → Batteria** di Android e scegli **Senza restrizioni**. I nomi cambiano da una marca di telefono all'altra, quindi se non lo trovi cerca «ottimizzazione batteria» nelle Impostazioni.
3. Da Android 12 in poi, Android chiude anche i processi aggiuntivi avviati da Termux, e Neconyan è uno di questi. Su Android 14 e successivi, attiva le Opzioni sviluppatore (tocca sette volte **Numero build** in **Informazioni sul telefono**), poi attiva **Disable child process restrictions**. Su Android 12 e 13 quell'opzione non c'è, quindi devi eseguire una volta questi due comandi da un computer con `adb` e il debug USB attivo:

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

Anche con il server attivo, dopo un po' Chrome può comunque togliere la pagina dalla memoria, e così Neconyan si ricarica quando torni. Se ti dà fastidio, attiva **Stay open in the background** in **Impostazioni → Sistema e dispositivo → Memory and performance**. Mentre sei via riproduce un suono troppo debole per essere sentito, così Chrome tratta Neconyan come un lettore musicale e lo lascia in pace. Consuma un po' di batteria, mostra una notifica multimediale e può mettere in pausa la musica di altre app: per questo è disattivato di default. Finora l'ho provato solo nel browser di un telefono emulato, non su un telefono vero, quindi fammi sapere se il tuo telefono lo ignora.

<a id="opening-it-on-your-phone"></a>

### Aprirlo dal telefono

Se Neconyan gira sul tuo computer, puoi usarlo anche dal telefono, purché siano tutti e due sulla stessa rete Wi-Fi. È anche la strada giusta su iPhone se preferisci non installare in sideloading l'[app per iPhone](#iphone-app).

I due browser usano gli stessi dati. Se invece devi spostare un'installazione offline da un dispositivo all'altro, leggi [Spostare i dati tra dispositivi](../docs/data-portability.md), compresa la configurazione della cartella dati su GitHub, prima di copiare o sincronizzare la cartella.

1. Ferma Neconyan e apri `config.yaml` nella cartella di Neconyan con un editor di testo qualsiasi. Il file compare dopo il primo avvio. Cambia `listen: false` in `listen: true`.
2. Già che ci sei, attiva una password, perché altrimenti chiunque sia sulla tua rete Wi-Fi può aprirlo. Imposta `basicAuthMode: true`, poi cambia `username` e `password` sotto `basicAuthUser`.
3. Riavvia Neconyan e trova l'indirizzo locale del computer.
   - **Windows:** esegui `ipconfig` nel Prompt dei comandi e cerca **Indirizzo IPv4**.
   - **macOS:** tieni premuto il tasto Opzione e fai clic sull'icona del Wi-Fi nella barra dei menu, poi cerca **Indirizzo IP**.
   - **Linux:** esegui `hostname -I`.
4. Nel browser del telefono, digita quell'indirizzo con `http://` davanti e `:4433` dopo, per esempio `http://192.168.1.20:4433`.

Se Windows ti chiede se lasciar passare Bun o Node.js attraverso il firewall, consentilo sulle reti private. Se il telefono mostra una pagina con scritto solo **Vietato**, la tua rete assegna indirizzi che iniziano con `10.`, che Neconyan blocca di default. Aggiungi questa riga sotto `whitelist:` in `config.yaml`, poi riavvia Neconyan:

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Scegliere tra Node.js e Bun, e altre opzioni di avvio</b></summary>

Ogni sistema ha anche script di avvio separati per Node.js e per Bun, se preferisci scegliere tu:

| Sistema | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

Per installarlo a mano, ti serve Node.js 20 o successivo:

```sh
npm install
npm run start:node
```

Funziona anche Bun 1.3.14 o successivo: esegui `bun install`, poi `bun run start`, oppure `bun run start:mobile` per usare meno memoria. Lascia il file `.npmrc` del repository così com'è.

Per impedire a un'installazione Git di aggiornarsi da sola, imposta `NECONYAN_AUTO_UPDATE=0` prima di eseguire lo script di avvio.

</details>

<details>
<summary><b>Se qualcosa non si avvia</b></summary>

- **Windows dice di aver protetto il PC:** fai clic su **Ulteriori informazioni**, poi su **Esegui comunque**. Succede con la maggior parte degli script di avvio scaricati.
- **macOS non apre `Start.command` perché proviene da uno sviluppatore non identificato:** fai clic destro sul file e scegli **Apri**. Nelle versioni più recenti di macOS, vai invece in **Impostazioni di Sistema → Privacy e sicurezza** e fai clic su **Apri comunque**.
- **macOS o Linux dicono che lo script di avvio non è eseguibile:** esegui questo comando nella cartella di Neconyan.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Un'installazione Git ha smesso di aggiornarsi:** lo script di avvio salta gli aggiornamenti se hai modificato uno qualsiasi dei file di Neconyan, e all'avvio ti dice perché. Le tue chat e `config.yaml` non contano.
- **Android:** in Termux si usa Node.js di default. Bun ha bisogno di due pacchetti in più, che lo script di avvio per Bun prova a installare per te. Se non ci riesce, installali tu:

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  Imposta `GLIBC_ROOT` se la tua glibc si trova in un percorso diverso da `$PREFIX/glibc`.

- **La porta 4433 è occupata:** passa `--port` con un altro numero, oppure cambia la porta in `config.yaml`.

</details>

### Arrivi da SillyTavern o SillyBunny?

La maggior parte di personaggi, chat, lorebook, personas e preset dovrebbe passare senza problemi, ma non posso garantire che funzionerà tutto, e le estensioni che dipendono dal layout della pagina di SillyTavern potrebbero aver bisogno di qualche correzione.

- **Prima fai un backup della vecchia installazione**, e tienilo finché non hai verificato che tutto funziona.
- **Dai a Neconyan una cartella dati tutta sua.** Non far mai puntare due app alla stessa.

Neconyan crea il proprio `config.yaml` e la propria cartella `data/` al primo avvio. I tuoi dati personali, le chiavi e i pacchetti installati non fanno mai parte della release.

<details>
<summary><b>Per gli sviluppatori</b></summary>

`main` contiene gli snapshot delle release e `staging` è dove si lavora. Per i test usa un checkout e una cartella dati separati, così le tue chat di tutti i giorni restano fuori.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

I test nel browser stanno in `tests/` e girano su un server usa e getta: imposta `NECONYAN_TEST_BASE_URL` sul suo indirizzo (il predefinito è `http://127.0.0.1:4433`). Compila il frontend prima dei test e riavvia il server dopo ogni nuova compilazione. Screenshot temporanei, report dei test, output di build e cartelle runtime locali restano fuori dai commit.

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Riconoscimenti">
</p>

Neconyan è costruito sul lavoro di tutte le persone dietro SillyTavern e SillyBunny; senza di loro niente di tutto questo esisterebbe. Gli strumenti inclusi e i progetti da cui provengono sono citati nell'[elenco degli strumenti inclusi](../docs/neconyan-native-tools.md).

Creato da [Platberlitz](https://github.com/platberlitz). Distribuito con licenza [GNU AGPL v3](../LICENSE), quindi se lo ridistribuisci lascia al loro posto gli avvisi e le licenze.
