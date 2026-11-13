<!-- Translated from README.md at commit 19874db1 (Neconyan 1.5.4). Keep the structure in step with the English README. -->

# Neconyan~

Остання версія: [1.5.4](https://github.com/platberlitz/Neconyan/releases/tag/v1.5.4).

**Читай своєю мовою:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Цей переклад може відставати. Актуальним є [англійський README](../README.md).

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan: наймиліший фронтенд для рольових ігор з LLM">
</p>

Neconyan — це мій котячий форк [SillyTavern](https://github.com/SillyTavern/SillyTavern) і [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) для спілкування та рольових ігор з ШІ-персонажами на комп'ютері чи телефоні. Модель потрібна своя: API-ключ або локальна модель; доступу до моделей чи кредитів у застосунку немає.

**[Завантажити Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[Прочитати посібник](https://platberlitz.github.io/neconyan-docs/)** · **[Отримати допомогу](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> Увесь код тут згенеровано LLM або написано за її допомогою. Кожен промпт і кожен агент, що постачаються з Neconyan, створила людина.

## Що тут є?

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Чому Neconyan?">
</p>

- **Чотири способи спілкуватися:** класична «Рольова гра», «Розмова» у стилі месенджера, соціальна стрічка Meower і «Режим історії» для суцільної прози.
- **Інтерфейс, створений для телефонів**, з підписаними елементами керування, нижньою панеллю чату й висувним меню. **Simple Mode** ховає рідше потрібні елементи, доки вони тобі не знадобляться.
- **Mewmory** запам'ятовує події історії та персонажів. **Агенти** можуть вести трекери, перевіряти відповідь або писати окрему «Супровідну нотатку».
- **Catelier** допомагає писати картки персонажів і лорбуки. **Блокноти** тримають твої нотатки під рукою, а **Scratchpad** дає окремий чат, щоб обговорити ідеї.
- **Miso, Taro і Nori** допомагають знаходити потрібне й за твого дозволу можуть вносити підтримувані зміни.
- **Device sync** переносить вибрані дані між окремими встановленнями за допомогою зашифрованих файлів, WebDAV, секретних GitHub Gist або прямого сполучення. Перенесення запускаються, лише коли ти про це просиш.
- **Теми, акцентні кольори й коти.** Котів чимало. Їх можна приховати, хоча я не уявляю, навіщо тобі це.

Твої картки персонажів, чати, лорбуки й пресети використовують знайомі формати SillyTavern. Телеметрії немає. Деякі функції та розширення з оригінального проєкту тут поводяться інакше; я переношу лише те, що хочу. [Список вбудованих інструментів](../docs/neconyan-native-tools.md) віддає належне проєктам, що постачаються з Neconyan.

## Зазирни досередини

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Режими">
</p>

Скриншоти для комп'ютера й телефона з версії 1.5.4; використано демо-чати та нотатки з вбудованими асистентами.

### Головна

Обери персонажа, під'єднай модель або привітайся з асистентом.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="«Головна» на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="«Головна» на телефоні"></td>
</tr></table>

### Рольова гра

Напиши сцену, спробуй іншу відповідь або продовж старий чат.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="«Рольова гра» на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="«Рольова гра» на телефоні"></td>
</tr></table>

### Catelier

Працюй над чернеткою персонажа, проси допомоги з текстом і переглядай зміни, перш ніж зберегти їх у своїй бібліотеці.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-catelier.webp" alt="Catelier на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-catelier.webp" alt="Catelier на телефоні"></td>
</tr></table>

### Агенти

Обери помічника, визнач, коли він запускається, і дай йому з'єднання. Раджу почати з одного помічника, а не вмикати одразу пів бібліотеки.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-agents.webp" alt="«Агенти» на комп'ютері: помічники для відповідей і їхні елементи керування"></td>
  <td width="28%"><img src="../docs/readme/phone-agents.webp" alt="«Агенти» на телефоні"></td>
</tr></table>

### Proofreader після генерації

Proofreader перевіряє відповідь після того, як вона надійшла. Він може причесати прозу та форматування, не просячи основну модель знову писати сцену. Відкрий **Зміни агента**, щоб порівняти правку з оригіналом і скасувати її, якщо тобі більше до вподоби оригінал.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-proofreader.webp" alt="Історія змін Proofreader на комп'ютері: початкова відповідь поруч із відредагованою версією"></td>
  <td width="28%"><img src="../docs/readme/phone-proofreader.webp" alt="Історія змін Proofreader на телефоні"></td>
</tr></table>

Цей показовий приклад запускає справжній робочий процес агентів із фіксованою зразковою відповіддю. У звичайному користуванні правки пише твоя підключена модель, а кожен прохід може коштувати ще одного запиту. [Агенти та супутники в посібнику](https://platberlitz.github.io/neconyan-docs/helpers/agents/).

<details>
<summary><b>Ще скриншоти: Simple Mode, «Розмова», Meower, «Режим історії», «Блокноти», Scratchpad та Device sync</b></summary>

### Simple Mode

Менше елементів керування, поки ти освоюєшся. **Show all features** на бічній панелі повертає їх; нічого не вимкнено.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Simple Mode на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Simple Mode на телефоні"></td>
</tr></table>

### Розмова

Листуйся з персонажами, створюй групові чати й дозволяй їм бути зайнятими або офлайн.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="«Розмова» на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="«Розмова» на телефоні"></td>
</tr></table>

### Meower

Соціальна стрічка, де твої персонажі публікують пости, відповідають і влаштовують опитування.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower на телефоні"></td>
</tr></table>

### Режим історії

Читай свій чат як суцільну прозу.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="«Режим історії» на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-story.webp" alt="«Режим історії» на телефоні"></td>
</tr></table>

### Блокноти

Тримай плани сцен, локації та журнали сесій поруч зі своїми чатами.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="«Блокноти» на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="«Блокноти» на телефоні"></td>
</tr></table>

### Scratchpad

Обговорюй історію з асистентом або за круглим столом із персонажами, а їхня дискусія не потрапить в основний чат.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad на телефоні"></td>
</tr></table>

### Device sync

Переноси вибрані бібліотеки між окремими встановленнями. Обери зашифровані файли, WebDAV, секретний GitHub Gist або пряме сполучення; перенесення починається, коли ти про це просиш. [Налаштування й відновлення в посібнику](https://platberlitz.github.io/neconyan-docs/help/device-sync/).

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-device-sync.webp" alt="Налаштування Device sync на комп'ютері"></td>
  <td width="28%"><img src="../docs/readme/phone-device-sync.webp" alt="Налаштування Device sync на телефоні"></td>
</tr></table>

</details>

## Початок роботи

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Початок роботи">
</p>

### На комп'ютері

1. Завантаж із [останнього релізу](https://github.com/platberlitz/Neconyan/releases/latest) файл, назва якого закінчується на **-source.zip**. Спершу розпакуй його; у Windows клацни файл правою кнопкою й вибери **Видобути все**.
2. Відкрий папку. Запусти **Start.bat** у Windows, **Start.command** у macOS або **bash start.sh** у терміналі в Linux.
3. Дай першому запуску кілька хвилин, щоб встановити все потрібне. Не закривай вікно терміналу, поки користуєшся Neconyan.
4. Браузер має відкритися сам. Якщо ні, перейди на **http://127.0.0.1:4433/**.
5. Відкрий **З'єднання**, обери провайдера й модель та введи свій API-ключ або адресу локальної моделі. Потім відкрий на «Головній» персонажа чи асистента.

Наступного разу запусти той самий лаунчер. Щоб зупинити Neconyan, натисни **Ctrl+C** у його терміналі.

Хочеш через Git? Склонуй репозиторій, а потім скористайся тим самим лаунчером:

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[Налаштування на комп'ютері та типові проблеми із запуском](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Застосунок для Android

Завантаж **-android-arm64.apk** з [останнього релізу](https://github.com/platberlitz/Neconyan/releases/latest) і відкрий його. Якщо Android попросить, дозволь встановлення з браузера. Тобі потрібен **Android 11 або новіший**, **Android System WebView 124 або новіший** і близько **2 GiB** вільного місця.

Застосунок працює на самому телефоні, без Termux і комп'ютера. Дай першому відкриттю час на розпакування, а потім налаштуй **З'єднання**. Щоб зберегти чати, встановлюй оновлення поверх наявного застосунку.

[Налаштування Android](https://platberlitz.github.io/neconyan-docs/start/android/) · [Інструкції зі збирання](../android/README.md)

### Застосунок для iPhone

Завантаж **-ios-unsigned.ipa** з [останнього релізу](https://github.com/platberlitz/Neconyan/releases/latest), а потім встанови його через інструмент для сайдлоадингу, як-от [iloader](https://github.com/nab138/iloader). Тобі потрібна **iOS 17 або новіша**. Сервер і чати застосунку лишаються на телефоні; в App Store його немає.

З безкоштовним обліковим записом Apple застосунок потрібно підписувати заново кожні сім днів, а сайдлоадити можна лише три застосунки. Встановлюй оновлення поверх наявного застосунку, використовуючи той самий обліковий запис Apple. **Якщо видалити застосунок, його дані зникнуть**, тож спершу експортуй резервну копію.

[Налаштування iPhone та обмеження](../ios/README.md)

### Інші способи користуватися телефоном

- **Android із Termux:** скористайся [посібником із Termux](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux), якщо тобі більше до вподоби термінал або в тебе старіший телефон.
- **Через встановлення на комп'ютері:** дотримуйся [посібника для однієї мережі Wi-Fi](https://platberlitz.github.io/neconyan-docs/start/phone/). Обидва пристрої працюють з одними й тими самими збереженими чатами; залиш комп'ютер увімкненим.

## Оновлення, резервні копії та перенесення чатів

Відкрий **Сервер → Оновлення та перезапуск → Перевірити наявність оновлень**. Для встановлень через Git і підтримуваних встановлень із ZIP-архіву вихідного коду є **Оновити та перезапустити**. На Android є **Update APK**, і система попросить підтвердити встановлення. Старіші ZIP-копії без засобу оновлення потребують [ручного перенесення в новішу папку](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation).

Встановлення через Git також перевіряють наявність оновлень під час запуску. Зміни у власних файлах застосунку, зроблені тобою, можуть зупинити автоматичне оновлення; твої чати й налаштування не враховуються.

Переходиш із SillyTavern або SillyBunny? **Спершу зроби резервну копію**, дай Neconyan окрему папку даних, а тоді дотримуйся інструкції [Імпорт твоїх даних](https://platberlitz.github.io/neconyan-docs/start/imports/). Перш ніж щось видаляти, перевір своїх персонажів і чати. Деякі розширення, можливо, доведеться підправити.

[Резервні копії та відновлення](https://platberlitz.github.io/neconyan-docs/help/backups/) · [Перенесення даних між пристроями](../docs/data-portability.md)

## Потрібна допомога?

Раджу почати з [посібника](https://platberlitz.github.io/neconyan-docs/) або спитати Miso, Taro чи Nori на «Головній». Вони можуть помилятися, тож перевіряй їхні поради, перш ніж робити зміну, яку не можна скасувати.

Якщо не знаходиш потрібного налаштування, спробуй **Пошук** на бічній панелі. Якщо виникла помилка, скористайся [посібником з усунення проблем](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) або [створи issue](https://github.com/platberlitz/Neconyan/issues), додавши опис своїх дій і текст помилки.

## Подяки

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Подяки">
</p>

Neconyan тримається на праці всіх, хто стоїть за SillyTavern і SillyBunny; без них нічого цього не було б. [Список вбудованих інструментів](../docs/neconyan-native-tools.md) називає їхніх першоавторів.

Автор: [Platberlitz](https://github.com/platberlitz). Поширюється за ліцензією [GNU AGPL v3](../LICENSE). Якщо поширюєш Neconyan далі, залиш усі повідомлення й ліцензії на місці.

Особлива подяка **El Topo**, моєму головному помічнику й дописувачу. Я дуже ціную всю працю, вкладену тобою в Neconyan.
