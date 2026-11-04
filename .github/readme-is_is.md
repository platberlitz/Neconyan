<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

Nýjasta útgáfa: **[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**. Þróunin heldur áfram á `staging`.

**Önnur tungumál:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Þetta er þýðing á [enska README-skjalinu](../README.md). Ef þeim ber einhvern tímann ekki saman er það enska nýjast.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - krúttlegasti framendinn fyrir hlutverkaleiki með mállíkönum">
</p>

> [!NOTE]
> Allur kóðinn hér er skrifaður af mállíkönum eða með aðstoð þeirra, en hver einasta kvaðning og hver einasti umboðsmaður sem fylgir Neconyan er mannanna verk.

Neconyan er afleggjarinn minn af [SillyTavern](https://github.com/SillyTavern/SillyTavern) og [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny), með kattaþema, til að spjalla og fara í hlutverkaleiki með gervigreindarpersónum, í tölvunni eða í símanum. Líkanið kemur frá þér, annaðhvort úr staðbundnum bakenda eða með API-lykli, því hvorki aðgangur að líkani né inneign fylgir með.

**[Lestu opinberu handbókina um Neconyan](https://platberlitz.github.io/neconyan-docs/).** Byrjaðu þar þegar þú setur Neconyan upp eða ert með spurningar um notkunina. Þar eru leiðbeiningar með skjámyndum, uppflettirit um fjölva og leiðbeiningar um hvernig á að búa til viðbætur. Ef eitthvað virkar ekki skaltu prófa [leiðbeiningarnar um bilanaleit](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) áður en þú tilkynnir vandamál.

Ef þú vilt SillyTavern þar sem allt virkar nákvæmlega eins og í upprunaverkefninu skaltu frekar nota [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny). Ég tek bara inn þá hluta upprunaverkefnisins sem ég vil hafa, svo sumt lítur öðruvísi út og hagar sér öðruvísi hér, og sumar viðbætur virka hugsanlega ekki.

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Af hverju Neconyan?">
</p>

- **Það heldur áfram þegar þú ferð.** Svörin eru skrifuð í vafranum á meðan þú fylgist með, því það er fljótlegra. Ef þú skiptir yfir í annað app eða læsir símanum í miðju spjalli við eina persónu geymir þjónninn svarið og afhendir það þegar þú opnar spjallið aftur, án þess að þú borgir tvisvar fyrir það. Samtal, Meower og minnisvinnslan halda hvort eð er áfram á þjóninum. Ef þú vilt að umboðsmenn sem keyra eftir svar haldi líka áfram skaltu stilla „Where replies are written“ á **On the server**. Fáein atriði þurfa samt að hafa síðuna opna, eins og WebLLM-líkön sem keyra í vafranum og Kokoro-raddir.
- **Það er í alvöru gert fyrir síma.** Almennilegir flipar með heitum, spjallstika neðst og valmynd sem rennur inn, ekki tölvuútlitið kreist saman.
- **Fjórar leiðir til að spjalla.** Klassískur Hlutverkaleikur, Samtal í anda skilaboðaforrita, samfélagsmiðlastraumur sem heitir Meower og Söguháttur fyrir lengri skrif.
- **Minni fyrir söguna.** [Mewmory](../docs/mewmory.md) heldur utan um söguna þína, aukapersónurnar sem þú hefur hitt og það sem þær sögðu, svo þú þurfir ekki að útskýra allt upp á nýtt 200 skilaboðum síðar.
- **Það besta fylgir með.** Umboðsmenn, Spjallsafn, Quick Image Gen, Guided Generations, BotSearcher og nokkur til viðbótar, hvert með sínar eigin stillingar. [Hér eru þau sem byrjuðu sem sjálfstæð verkefni, og hverjir gerðu þau.](../docs/neconyan-native-tools.md)
- **Staður fyrir glósur.** [Minnisbækur](../docs/notebooks.md) gefa þér pláss fyrir persónudrög, staði, senuáætlanir og dagbækur yfir spilalotur, rétt hjá spjöllunum þínum. Glósurnar tengjast hver annarri og fræðibókunum þínum, og aðstoðarmennirnir geta breytt þeim ef þú leyfir það.
- **Litlir hjálparar.** Miso, Taro og Nori geta notað verkfæraköll til að búa til persónur með andlitsmyndum, breyta fræðibókum og laga forstillingar eða umboðsmenn. Stutta „First paws“-kynningin fer yfir grunnatriðin með þér, og [Simple Mode](#simple-mode) heldur flóknari hlutunum úr vegi þangað til þú vilt fá þá.
- **Einhver til að ræða söguna við.** [Scratchpad](../docs/scratchpad.md) er hliðarspjall við hliðina á sögunni þinni þar sem aðstoðarmennirnir, þínar eigin persónur eða heilt hringborð af þeim geta lesið senuna og gefið þér hugmyndir, án þess að neitt af því endi í spjallinu.
- **Það er krúttlegt.** Calico-þemu, kettir sem blunda á skilaboðunum þínum og pixlaköttur á forsíðunni. Það var nú eiginlega allur tilgangurinn.
- **Skrárnar þínar eru áfram þínar.** Það les sömu persónuspjöld, spjöll, fræðibækur og forstillingar og SillyTavern, og það er engin fjarmæling.

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Hamir">
</p>

Þetta eru sviðsett sýnispjöll, glósur og Scratchpad-svör með innbyggðu aðstoðarmönnunum, svo ekki lesa of mikið í þau.

### Heim

Hér lendirðu. Veldu persónu, byrjaðu tímabundið spjall, tengdu líkan eða heilsaðu upp á einhvern aðstoðarmannanna.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="Heim í tölvu"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="Heim í síma"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

Hér eru ansi margir hnappar og þú þarft ekki á flestum þeirra að halda fyrsta daginn. Simple Mode felur Mewmory, Spjallsafn, Viðbætur, hamaskiptinn, mestalla Fínstillingu og aukahnappana í kringum skilaboðareitinn, og eftir standa persónur, tengingar, forstillingar, fræðibækur, Umboðsmenn, Minnisbækur og Scratchpad. Nori spyr hvort þú viljir nota Simple Mode áður en „First paws“-kynningin hefst. Það er ekki slökkt á neinu, það er bara falið, svo ýttu á **Show all features** í hliðarstikunni eða slökktu á Simple Mode undir Stillingar > Útlit hvenær sem þú vilt fá allt aftur.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Spjall í Hlutverkaleik með kveikt á Simple Mode, í tölvu"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Spjall í Hlutverkaleik með kveikt á Simple Mode, í síma"></td>
  </tr>
</table>

### Hlutverkaleikur

Klassíska spjallið sem þú þekkir úr SillyTavern, með kött sofandi ofan á skilaboðunum þínum.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Hlutverkaleikur í tölvu"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Hlutverkaleikur í síma"></td>
  </tr>
</table>

### Samtal

Þú sendir persónunum þínum skilaboð eins og þú myndir senda vini. Þar er listinn Félagar, hópspjall, greinar og persónur sem geta verið uppteknar eða ótengdar.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Samtal í tölvu"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Samtal í síma"></td>
  </tr>
</table>

### Meower

Pínulítill samfélagsmiðill þar sem persónurnar þínar birta færslur, svara hver annarri og halda skoðanakannanir um snarl.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower í tölvu"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower í síma"></td>
  </tr>
</table>

### Söguháttur

Spjallið verður að samfelldri frásögn, fyrir þau skipti þegar þú vilt frekar lesa sögu en fletta í gegnum talblöðrur.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Söguháttur í tölvu"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Söguháttur í síma"></td>
  </tr>
</table>

### Minnisbækur

Minnisbók sem býr við hliðina á spjöllunum þínum, fyrir persónudrögin og senuáætlanirnar sem myndu annars týnast í einhverri textaskrá. Hún býður upp á sniðmát, möppur, eiginleika og lestrarsýn, og þú getur opnað hana við hliðina á spjalli. [Meira um Minnisbækur.](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Minnisbækur í tölvu"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Minnisbækur í síma"></td>
  </tr>
</table>

### Scratchpad

Hliðarspjall rétt hjá sögunni þinni, fyrir þau skipti þegar þú vilt ræða senuna án þess að persónurnar heyri til. Spurðu Miso, Taro eða Nori, afritaðu eitt af persónuspjöldunum þínum eða búðu til þinn eigin aðstoðarmann, settu svo allt að þrjá þeirra við hringborð og leyfðu þeim að rífast um hvort óvænta vendingin þín hitti í mark. Ekkert sem þú skrifar þar fer inn í söguna. [Meira um Scratchpad.](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad við hliðina á spjalli í Söguhætti, í tölvu"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad í síma"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Fyrstu skrefin">
</p>

Veldu það sem passar við það sem þú ert með:

| Þú ert með | Veldu |
| --- | --- |
| Android-síma með Android 11 eða nýrra | [Android-appið](#android-app) |
| Eldri Android-síma, eða þér líkar vel við skipanalínuna | [Termux](#android-with-termux) |
| Windows, macOS eða Linux | [Uppsetningu á tölvu](#on-a-computer) |
| iPhone með iOS 17 eða nýrra, og hliðhleðsla er ekkert mál fyrir þig | [iPhone-appið](#iphone-app) |
| Einhvern annan iPhone, eða þú vilt frekar geyma spjöllin þín á tölvu | Uppsetningu á tölvu, og [opnaðu hana svo í símanum](#opening-it-on-your-phone) |

Hvað sem þú velur þarftu samt líkan til að tala við: API-lykil frá veitu eða staðbundinn bakenda eins og KoboldCpp eða Ollama.

<a id="android-app"></a>

### Android-appið

Á Android 11 eða nýrra skaltu sækja skrána sem endar á `-android-arm64.apk` af [nýjustu útgáfunni](https://github.com/platberlitz/Neconyan/releases/latest) og opna hana. Android biður þig líklega fyrst um að leyfa uppsetningu forrita úr vafranum.

Allt keyrir í símanum, svo hvorki Termux né tölva kemur við sögu. Hafðu um 2 GiB laus og gefðu appinu tíma til að pakka sér út þegar það er opnað í fyrsta sinn. Það þarf líka Android System WebView 124 eða nýrra, og appið lætur þig vita ef þín útgáfa er of gömul. Til að uppfæra seturðu nýju APK-skrána upp yfir þá gömlu, og spjöllin þín haldast á sínum stað. [Uppsetning á Android, öryggisafrit og leiðbeiningar um smíði.](../android/README.md)

<a id="iphone-app"></a>

### iPhone-appið

Nú er líka til sjálfstætt iPhone-app. Sama hugmynd og með Android-appið: þjónninn, spjöllin þín og stillingarnar eru öll geymd í símanum, svo þú þarft enga tölvu sem keyrir Neconyan. Það er ekki í App Store, svo þú þarft að hliðhlaða því inn á símann.

1. Opnaðu [útgáfusíðuna](https://github.com/platberlitz/Neconyan/releases/latest) og sæktu skrána sem endar á `-ios-unsigned.ipa` ef hún fylgir þeirri útgáfu. Ef ekki skaltu frekar fara [vafraleiðina](#opening-it-on-your-phone).
2. Veldu skrána í hliðhleðslutóli eins og [iloader](https://github.com/nab138/iloader). Tólið undirritar hana með Apple-aðganginum þínum og setur appið upp. Þú þarft iOS 17 eða nýrra.
3. Opnaðu Neconyan og tengdu líkan undir **Tengingar**, eins og alls staðar annars staðar.

Með ókeypis Apple-aðgangi þarf að undirrita appið aftur á sjö daga fresti og aðeins er hægt að hliðhlaða þremur öppum. Til að uppfæra seturðu nýju IPA-skrána upp yfir þá gömlu með sama Apple-aðgangi, og spjöllin þín haldast á sínum stað. Ef þú eyðir appinu eyðast spjöllin þín með því, svo flyttu fyrst út öryggisafrit af reikningi ef þú ætlar að skipta um hliðhleðslutól.

Innflutningur heldur áfram þótt þú skiptir yfir í annað app eða læsir símanum. Veldu öryggisafritið með hnappnum **Flytja inn öryggisafrits-ZIP** í appinu sjálfu, staðfestu, og þjónninn sér um afganginn. Hann spilar þögn svo iOS frysti hann ekki á meðan hann vinnur, og þú getur litið á stöðuna hvenær sem er. Svörin halda líka áfram, alveg eins og í vafraflipa í tölvu: ef þú ferð í miðju svari spilar vefsíðan sitt eigið þögla hljóð þangað til svarið hefur verið skrifað og vistað og allir umboðsmenn sem keyra á eftir því hafa lokið sér af. Á meðan gætirðu séð „Neconyan is finishing a reply“ á lásskjánum, og tónlist í öðru appi getur farið í bið þangað til þessu er lokið. iOS getur samt lokað appinu ef símann vantar minni. Hafðu um tvöfalda stærð öryggisafritsins lausa á meðan það er afritað inn. [Uppsetning á iPhone, takmarkanir og leiðbeiningar um smíði.](../ios/README.md)

<a id="on-a-computer"></a>

### Á tölvu

1. **Náðu í Neconyan.** Það eru tvær leiðir, og sú seinni heldur sér sjálf uppfærðri.

   - **Sæktu það.** Náðu í skrána sem endar á `-source.zip` af [nýjustu útgáfunni](https://github.com/platberlitz/Neconyan/releases/latest) og afþjappaðu hana einhvers staðar þar sem auðvelt er að finna hana, til dæmis í skjalamöppunni þinni. Í Windows skaltu fyrst hægrismella á zip-skrána og velja **Extract All**, því það virkar ekki að keyra ræsiforritið innan úr zip-skránni. Þá færðu möppu sem heitir eftir útgáfunni, til dæmis `Neconyan-1.3.7`.
   - **Klónaðu það með [Git](https://git-scm.com/downloads).** Opnaðu skipanalínu þar sem þú vilt hafa möppuna og keyrðu línuna hér fyrir neðan. Ræsiforritið athugar þá í hvert sinn sem þú ræsir það hvort ný útgáfa sé komin og uppfærir áður en það opnast, og þess vegna myndi ég fara þessa leið.

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **Ræstu það.** Opnaðu Neconyan-möppuna og keyrðu ræsiforritið fyrir þitt stýrikerfi.

   | Kerfi | Hvernig |
   | --- | --- |
   | Windows | Tvísmelltu á `Start.bat` |
   | macOS | Tvísmelltu á `Start.command` |
   | Linux eða WSL | Opnaðu skipanalínu í möppunni og keyrðu `./start.sh` |

   Fyrsta ræsingin tekur nokkrar mínútur. Ef þú ert hvorki með Bun né Node.js (forritin sem keyra Neconyan í raun) setur ræsiforritið Bun upp fyrir þig og sækir svo allt annað sem Neconyan þarf. Hafðu gluggann opinn á meðan þú notar Neconyan; ef þú lokar honum, eða ýtir á Ctrl+C í honum, stöðvast Neconyan.

3. **Opnaðu það.** Vafrinn ætti að opnast af sjálfu sér. Ef hann gerir það ekki skaltu fara á **http://127.0.0.1:4433/**.
4. **Tengdu líkan.** Smelltu á **Tengingar** í hliðarstikunni, veldu veitu og líkan og límdu svo inn API-lykilinn þinn eða slóð staðbundna bakendans. Eftir það geturðu flutt inn persónu eða heilsað upp á Miso, Taro eða Nori á forsíðunni.

Næst keyrirðu einfaldlega sama ræsiforritið aftur.

**Uppfærslur.** Git-uppsetningar uppfæra sig sjálfar þegar þú ræsir þær. Ef þú notaðir zip-skrána sækirðu nýju skrána og afþjappar hana í nýja möppu, lokar Neconyan og afritar svo `data`-möppuna úr gömlu Neconyan-möppunni yfir í þá nýju, ásamt `config.yaml` ef þú breyttir henni. Ræstu nýju útgáfuna og athugaðu hvort spjöllin þín séu á sínum stað áður en þú eyðir gömlu möppunni.

<a id="android-with-termux"></a>

### Android með Termux

[Termux](https://termux.dev/) er skipanalínuforrit fyrir Android. Það er meira vesen en appið hér fyrir ofan, en það virkar líka á eldri símum.

1. Settu Termux upp af [F-Droid](https://f-droid.org/packages/com.termux/) eða af [útgáfusíðu þess á GitHub](https://github.com/termux/termux-app/releases).
2. Opnaðu Termux og uppfærðu það. Ef það stoppar og spyr um stillingaskrá skaltu ýta á Enter til að halda þeirri sem fyrir er.

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Settu upp Git og sæktu svo Neconyan inn í heimamöppuna þína í Termux. `--depth 1` sleppir gamalli sögu verkefnisins, svo niðurhalið verður minna, og uppfærslur virka samt.

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. Ræstu það. Í fyrstu ræsingu er Node.js sett upp ásamt öllu öðru sem Neconyan þarf, svo gefðu því nokkrar mínútur.

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. Þegar þú sérð `Go to: http://127.0.0.1:4433/ to open Neconyan` skaltu opna þá slóð í Chrome eða öðrum vafra í símanum. Tengdu svo líkan undir **Tengingar**, alveg eins og á tölvu.

Nokkrir Termux-siðir sem gott er að temja sér:

- Til að stöðva Neconyan ýtirðu á **CTRL** í röðinni með aukahnöppunum og svo á **C**.
- Næst opnarðu Termux og keyrir `cd ~/Neconyan && bash start.sh` aftur. Það uppfærir sig sjálft áður en það ræsist.
- Geymdu möppuna í heimamöppunni í Termux. Ræsiforritið neitar að keyra úr sameiginlegu geymslurými eins og `/sdcard`, því Android leyfir ekki skráatenglana sem pakkar Neconyan þurfa þar.
- Í valmyndinni í Chrome gefur **Add to home screen** Neconyan sitt eigið tákn.

**Að halda því gangandi í bakgrunni.** Android á það til að stöðva öpp sem þú ert ekki að horfa á, og Termux er engin undantekning. Þessi skref halda lífi í Neconyan á meðan þú ert í öðru appi:

1. Dragðu niður tilkynningarnar og athugaðu hvort Termux-tilkynningin segi „wake lock held“. Neconyan biður um vökulásinn við ræsingu; ef hann hélst ekki inni skaltu ýta þar á **Acquire wakelock**.
2. Opnaðu **Stillingar → Forrit → Termux → Rafhlaða** í Android og veldu **Unrestricted**. Heitin eru á mismunandi stöðum eftir símaframleiðendum, svo leitaðu að „battery optimisation“ í Stillingum ef þú finnur þetta ekki.
3. Í Android 12 og nýrri útgáfum drepur Android líka aukaferla sem Termux ræsir, og Neconyan er einn þeirra. Í Android 14 og nýrri skaltu kveikja á Developer options (ýttu sjö sinnum á **Build number** í **About phone**) og kveikja svo á **Disable child process restrictions**. Í Android 12 og 13 er enginn slíkur rofi, svo þú þarft að keyra þessar tvær skipanir einu sinni úr tölvu með `adb` og USB-villuleit:

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

Jafnvel þótt þjónninn sé á lífi getur Chrome samt hent síðunni sjálfri úr minni eftir dálitla stund, svo Neconyan endurhleðst þegar þú kemur aftur. Ef það fer í taugarnar á þér skaltu kveikja á **Stay open in the background** undir **Stillingar → Kerfi og tæki → Memory and performance**. Á meðan þú ert í burtu spilar það hljóð sem er of lágt til að heyrast, svo Chrome lítur á Neconyan sem tónlistarspilara og lætur það í friði. Það tekur dálítið af rafhlöðunni, birtir margmiðlunartilkynningu og getur gert hlé á tónlist í öðrum öppum, og þess vegna er slökkt á því sjálfgefið. Hingað til hef ég bara prófað þetta í hermdum símavafra, ekki í alvörusíma, svo láttu mig vita ef síminn þinn hunsar það.

<a id="opening-it-on-your-phone"></a>

### Að opna Neconyan í símanum

Ef Neconyan keyrir á tölvunni þinni getur síminn líka notað það, svo lengi sem bæði tækin eru á sama Wi-Fi-neti. Þetta er líka leiðin á iPhone ef þú vilt síður hliðhlaða [iPhone-appinu](#iphone-app).

Báðir vafrarnir nota sömu gögnin. Ef þú þarft frekar að flytja uppsetningu sem keyrir án nettengingar á milli tækja skaltu lesa [Að flytja gögn á milli tækja](../docs/data-portability.md), þar á meðal kaflann um að geyma gagnamöppuna á GitHub, áður en þú afritar eða samstillir möppuna.

1. Stöðvaðu Neconyan og opnaðu `config.yaml` í Neconyan-möppunni í hvaða textaritli sem er. Skráin birtist eftir fyrstu ræsingu. Breyttu `listen: false` í `listen: true`.
2. Á meðan þú ert þarna skaltu setja upp lykilorð, því annars getur hver sem er á Wi-Fi-netinu þínu opnað það. Stilltu `basicAuthMode: true` og breyttu svo `username` og `password` undir `basicAuthUser`.
3. Ræstu Neconyan aftur og finndu staðbundið vistfang tölvunnar.
   - **Windows:** keyrðu `ipconfig` í Command Prompt og leitaðu að **IPv4 Address**.
   - **macOS:** haltu Option niðri og smelltu á Wi-Fi-táknið í valmyndastikunni, og leitaðu svo að **IP Address**.
   - **Linux:** keyrðu `hostname -I`.
4. Sláðu þetta vistfang inn í vafranum í símanum með `http://` fyrir framan og `:4433` fyrir aftan, til dæmis `http://192.168.1.20:4433`.

Ef Windows spyr hvort hleypa eigi Bun eða Node.js í gegnum eldvegginn skaltu leyfa það á einkanetum. Ef síminn sýnir síðu þar sem stendur bara **Bannað** úthlutar netið þitt vistföngum sem byrja á `10.`, og Neconyan lokar sjálfgefið á þau. Bættu þessari línu við undir `whitelist:` í `config.yaml` og endurræstu svo Neconyan:

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Að velja á milli Node.js og Bun, og aðrir kostir ræsiforritsins</b></summary>

Fyrir hvert kerfi eru líka sérstök ræsiforrit fyrir Node.js og Bun, ef þú vilt frekar ráða því:

| Kerfi | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

Til að setja upp handvirkt þarftu Node.js 20 eða nýrra:

```sh
npm install
npm run start:node
```

Bun 1.3.14 eða nýrra virkar líka: keyrðu `bun install` og svo `bun run start`, eða `bun run start:mobile` til að nota minna minni. Láttu `.npmrc`-skrá verkefnisins vera eins og hún er.

Til að koma í veg fyrir að Git-uppsetning uppfæri sig sjálf skaltu stilla `NECONYAN_AUTO_UPDATE=0` áður en þú keyrir ræsiforritið.

</details>

<details>
<summary><b>Ef eitthvað fer ekki í gang</b></summary>

- **Windows segist hafa varið tölvuna þína:** smelltu á **More info** og svo á **Run anyway**. Það segir þetta um flest ræsiforrit sem hlaðið er niður.
- **macOS vill ekki opna `Start.command` af því að það er frá óþekktum forritara:** hægrismelltu á það og veldu **Open**. Í nýrri útgáfum af macOS skaltu frekar fara í **System Settings → Privacy & Security** og smella á **Open Anyway**.
- **macOS eða Linux segir að ræsiforritið sé ekki keyranlegt:** keyrðu þetta í Neconyan-möppunni.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Git-uppsetning er hætt að uppfærast:** ræsiforritið sleppir uppfærslum ef þú hefur breytt einhverjum af skrám Neconyan sjálfs, og segir af hverju þegar það ræsist. Spjöllin þín og `config.yaml` teljast ekki með.
- **Android:** Node.js er sjálfgefið í Termux. Bun þarf tvo aukapakka, sem Bun-ræsiforritið reynir að setja upp fyrir þig. Ef það tekst ekki skaltu setja þá upp handvirkt:

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  Stilltu `GLIBC_ROOT` ef glibc er annars staðar en í `$PREFIX/glibc`.

- **Gátt 4433 er upptekin:** notaðu `--port` með öðru númeri, eða breyttu gáttinni í `config.yaml`.

</details>

### Kemurðu frá SillyTavern eða SillyBunny?

Persónurnar þínar, spjöllin, fræðibækurnar, persónugervin og forstillingarnar ættu að mestu að skila sér án vandræða, en ég get ekki lofað að allt geri það, og viðbætur sem treysta á síðuuppsetningu SillyTavern gætu þurft lagfæringar.

- **Taktu fyrst öryggisafrit af gömlu uppsetningunni**, og geymdu það þangað til þú hefur gengið úr skugga um að allt virki.
- **Láttu Neconyan hafa sína eigin gagnamöppu.** Láttu aldrei tvö forrit vísa á sömu möppuna.

Neconyan býr til sína eigin `config.yaml` og `data/`-möppu í fyrsta sinn sem það keyrir. Persónuleg gögn þín, lyklar og uppsettir pakkar eru aldrei hluti af útgáfunni.

<details>
<summary><b>Fyrir forritara</b></summary>

`main` geymir útgáfuskyndimyndir og `staging` er þar sem vinnan fer fram. Notaðu sérstakt vinnuafrit og sérstaka gagnamöppu fyrir prófanir, svo hversdagsspjöllin þín komi hvergi nærri.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

Vafraprófanir eru í `tests/` og keyra gegn einnota þjóni: stilltu `NECONYAN_TEST_BASE_URL` á vistfang hans (sjálfgefið er `http://127.0.0.1:4433`). Smíðaðu framendann áður en þú prófar og endurræstu þjóninn eftir hverja nýja smíði. Tímabundnar skjámyndir, prófunarskýrslur, smíðaúttak og staðbundnar keyrslumöppur fara aldrei með í commit.

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Þakkir">
</p>

Neconyan byggir á vinnu allra sem standa að SillyTavern og SillyBunny; ekkert af þessu væri til án þeirra. Innbyggðu verkfærin og verkefnin sem þau komu úr eru tilgreind í [listanum yfir verkfærin sem fylgja með](../docs/neconyan-native-tools.md).

Gert af [Platberlitz](https://github.com/platberlitz). Gefið út undir [GNU AGPL v3](../LICENSE), svo haltu tilkynningum og leyfisskilmálum á sínum stað ef þú dreifir því áfram.
