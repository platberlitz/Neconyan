<!-- Translated from README.md at commit 19874db1 (Neconyan 1.5.4). Keep the structure in step with the English README. -->

# Neconyan~

Последняя версия: [1.5.4](https://github.com/platberlitz/Neconyan/releases/tag/v1.5.4).

**Читайте на своём языке:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Перевод может отставать от оригинала. Актуален [английский README](../README.md).

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan: самый милый фронтенд для ролевых игр с LLM">
</p>

Neconyan — мой форк [SillyTavern](https://github.com/SillyTavern/SillyTavern) и [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) в кошачьем стиле для общения и ролевых игр с ИИ-персонажами на компьютере или на телефоне. Понадобится ваш собственный API-ключ или локальная модель: ни доступа к моделям, ни кредитов в приложении нет.

**[Скачать Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[Читать руководство](https://platberlitz.github.io/neconyan-docs/)** · **[Получить помощь](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> Весь код здесь сгенерирован LLM или написан с её помощью. Каждый промпт и каждый агент, которые поставляются с Neconyan, созданы человеком.

## Что здесь есть?

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Почему Neconyan?">
</p>

- **Четыре способа общаться:** классическая «Ролевая игра», «Беседа» в стиле мессенджера, лента соцсети под названием Meower и «Режим истории» для сплошной прозы.
- **Интерфейс, сделанный для телефонов**, с подписанными элементами управления, нижней панелью чата и выдвижным меню. **Simple Mode** прячет реже используемые элементы, пока они вам не понадобятся.
- **Mewmory** помнит события истории и персонажей. **Агенты** могут вести трекеры, проверять ответ или писать отдельную заметку компаньона.
- **Catelier** помогает писать карточки персонажей и лорбуки. **Блокноты** хранят ваши заметки под рукой, а **Scratchpad** даёт отдельный чат, чтобы обсудить идеи.
- **Miso, Taro и Nori** помогают находить нужное и, если вы разрешите, могут вносить поддерживаемые правки.
- **Device sync** переносит выбранные данные между отдельными установками с помощью зашифрованных файлов, WebDAV, секретных GitHub Gist или прямого сопряжения. Перенос выполняется, когда вы его запускаете.
- **Темы, акцентные цвета и кошки.** Кошек довольно много. Их можно скрыть, хотя я не представляю, зачем вам это.

Ваши карточки персонажей, чаты, лорбуки и пресеты используют привычные форматы SillyTavern. Телеметрии нет. Некоторые функции и расширения оригинала ведут себя здесь иначе: я переношу только то, что мне нужно. [Список встроенных инструментов](../docs/neconyan-native-tools.md) отдаёт должное проектам, которые входят в состав Neconyan.

## Загляните

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Режимы">
</p>

Скриншоты с компьютера и телефона из версии 1.5.4: демо-чаты и заметки со встроенными ассистентами.

### Главная

Выберите персонажа, подключите модель или поздоровайтесь с одним из ассистентов.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="Главная на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="Главная на телефоне"></td>
</tr></table>

### Ролевая игра

Напишите сцену, попробуйте другой ответ или продолжите старый чат.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Ролевая игра на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Ролевая игра на телефоне"></td>
</tr></table>

### Catelier

Работайте над черновиком персонажа, просите помощи в написании текста и проверяйте изменения, прежде чем сохранить их в библиотеку.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-catelier.webp" alt="Catelier на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-catelier.webp" alt="Catelier на телефоне"></td>
</tr></table>

### Агенты

Выберите помощника, решите, когда он запускается, и задайте ему подключение. Советую начать с одного, а не включать сразу половину библиотеки.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-agents.webp" alt="Агенты на компьютере: помощники для ответов и их настройки"></td>
  <td width="28%"><img src="../docs/readme/phone-agents.webp" alt="Агенты на телефоне"></td>
</tr></table>

### Proofreader после генерации

Proofreader проверяет ответ после того, как он пришёл. Он может поправить стиль и форматирование, не прося основную модель заново писать сцену. Откройте **Изменения агента**, чтобы сравнить правку с оригиналом и отменить её, если оригинал вам нравится больше.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-proofreader.webp" alt="История изменений Proofreader на компьютере: исходный ответ и его отредактированная версия"></td>
  <td width="28%"><img src="../docs/readme/phone-proofreader.webp" alt="История изменений Proofreader на телефоне"></td>
</tr></table>

Этот постановочный пример запускает настоящий рабочий процесс агентов, но с заранее заданным ответом. Обычно правки пишет ваша подключённая модель, и каждый проход может стоить ещё одного запроса. [Агенты и компаньоны в руководстве](https://platberlitz.github.io/neconyan-docs/helpers/agents/).

<details>
<summary><b>Ещё скриншоты: Simple Mode, «Беседа», Meower, «Режим истории», «Блокноты», Scratchpad и Device sync</b></summary>

### Simple Mode

Меньше элементов управления, пока вы осваиваетесь. **Show all features** на боковой панели возвращает их; ничего не отключено.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Simple Mode на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Simple Mode на телефоне"></td>
</tr></table>

### Беседа

Переписывайтесь с персонажами, создавайте групповые чаты и пусть они бывают заняты или не в сети.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Беседа на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Беседа на телефоне"></td>
</tr></table>

### Meower

Лента соцсети, где ваши персонажи публикуют посты, отвечают и проводят опросы.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower на телефоне"></td>
</tr></table>

### Режим истории

Читайте свой чат как сплошную прозу.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Режим истории на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Режим истории на телефоне"></td>
</tr></table>

### Блокноты

Храните планы сцен, локации и журналы сессий рядом с чатами.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Блокноты на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Блокноты на телефоне"></td>
</tr></table>

### Scratchpad

Обсудите историю с ассистентом или с несколькими персонажами за круглым столом, не добавляя их разговор в основной чат.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad на телефоне"></td>
</tr></table>

### Device sync

Переносите выбранные библиотеки между отдельными установками. Выберите зашифрованные файлы, WebDAV, секретный GitHub Gist или прямое сопряжение; перенос начинается, когда вы его запускаете. [Настройка и восстановление в руководстве](https://platberlitz.github.io/neconyan-docs/help/device-sync/).

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-device-sync.webp" alt="Настройки Device sync на компьютере"></td>
  <td width="28%"><img src="../docs/readme/phone-device-sync.webp" alt="Настройки Device sync на телефоне"></td>
</tr></table>

</details>

## С чего начать

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="С чего начать">
</p>

### На компьютере

1. Скачайте со страницы [последнего релиза](https://github.com/platberlitz/Neconyan/releases/latest) файл, имя которого заканчивается на **-source.zip**. Сначала распакуйте его; в Windows щёлкните по нему правой кнопкой мыши и выберите **Извлечь все**.
2. Откройте папку. Запустите **Start.bat** в Windows, **Start.command** в macOS или **bash start.sh** в терминале в Linux.
3. При первом запуске подождите несколько минут, пока установится всё необходимое. Пока вы пользуетесь Neconyan, не закрывайте окно терминала.
4. Браузер должен открыться сам. Если этого не произошло, перейдите по адресу **http://127.0.0.1:4433/**.
5. Откройте **Связи**, выберите провайдера и модель и введите свой API-ключ или адрес локальной модели. Затем откройте персонажа или ассистента на «Главной».

В следующий раз запустите тот же лаунчер. Чтобы остановить Neconyan, нажмите **Ctrl+C** в его терминале.

Предпочитаете Git? Клонируйте репозиторий, а затем запустите тот же лаунчер:

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[Установка на компьютер и типичные проблемы при запуске](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Приложение для Android

Скачайте со страницы [последнего релиза](https://github.com/platberlitz/Neconyan/releases/latest) файл **-android-arm64.apk** и откройте его. Если Android спросит, разрешите установку из браузера. Нужны **Android 11 или новее**, **Android System WebView 124 или новее** и около **2 GiB** свободного места.

Приложение работает на самом телефоне, без Termux и без компьютера. Дайте ему время распаковаться при первом открытии, а затем настройте **Связи**. Чтобы сохранить чаты, устанавливайте обновления поверх существующего приложения.

[Настройка на Android](https://platberlitz.github.io/neconyan-docs/start/android/) · [Инструкции по сборке](../android/README.md)

### Приложение для iPhone

Скачайте **-ios-unsigned.ipa** со страницы [последнего релиза](https://github.com/platberlitz/Neconyan/releases/latest), а затем установите его с помощью программы для сайдлоадинга, например [iloader](https://github.com/nab138/iloader). Нужна **iOS 17 или новее**. Приложение хранит свой сервер и чаты на телефоне; в App Store его нет.

С бесплатным аккаунтом Apple приложение нужно переподписывать каждые семь дней, а через сайдлоадинг можно установить не больше трёх приложений. Устанавливайте обновления поверх существующего приложения, используя тот же аккаунт Apple. **Вместе с приложением удаляются и его данные**, поэтому сначала экспортируйте резервную копию.

[Настройка на iPhone и ограничения](../ios/README.md)

### Другие способы использовать телефон

- **Android с Termux:** следуйте [руководству по Termux](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux), если вы предпочитаете терминал или у вас старый телефон.
- **Использовать установку на компьютере:** следуйте [руководству для одной сети Wi-Fi](https://platberlitz.github.io/neconyan-docs/start/phone/). На обоих устройствах будут одни и те же сохранённые чаты; компьютер должен оставаться включённым.

## Обновления, резервные копии и перенос чатов

Откройте **Сервер → Обновления и перезапуск → Проверить обновления**. Установки через Git и поддерживаемые установки из ZIP-архива предлагают **Обновить и перезапустить**. На Android предлагается **Update APK**, и вас попросят подтвердить установку. Для старых копий из ZIP-архива без средства обновления нужен [ручной перенос в папку новой версии](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation).

Установки через Git также проверяют обновления при запуске. Изменения, которые вы внесли в собственные файлы приложения, могут помешать автоматическому обновлению; ваши чаты и настройки в счёт не идут.

Переходите с SillyTavern или SillyBunny? **Сначала сделайте резервную копию**, выделите Neconyan отдельную папку данных, а затем следуйте руководству [Импорт ваших данных](https://platberlitz.github.io/neconyan-docs/start/imports/). Прежде чем что-либо удалять, проверьте своих персонажей и чаты. Некоторые расширения, возможно, придётся доработать.

[Резервные копии и восстановление](https://platberlitz.github.io/neconyan-docs/help/backups/) · [Перенос данных между устройствами](../docs/data-portability.md)

## Нужна помощь?

Советую начать с [руководства](https://platberlitz.github.io/neconyan-docs/) или спросить Miso, Taro или Nori на «Главной». Они могут ошибаться, поэтому проверяйте их советы, прежде чем вносить изменения, которые нельзя отменить.

Если не можете найти нужную настройку, попробуйте **Поиск** на боковой панели. При ошибках воспользуйтесь [руководством по решению проблем](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) или [сообщите о проблеме](https://github.com/platberlitz/Neconyan/issues), указав, что вы делали и какая ошибка появилась.

## Благодарности

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Благодарности">
</p>

Neconyan построен на труде всех, кто стоит за SillyTavern и SillyBunny; без них ничего этого бы не было. В [списке встроенных инструментов](../docs/neconyan-native-tools.md) указаны их первоначальные авторы.

Автор: [Platberlitz](https://github.com/platberlitz). Распространяется по лицензии [GNU AGPL v3](../LICENSE). Если будете распространять Neconyan дальше, сохраняйте все уведомления и лицензии.

Особая благодарность **El Topo**, моему главному помощнику и участнику проекта. Я очень ценю всё, что вы вложили в Neconyan.
