<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

Última versión: **[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**. El desarrollo continúa en `staging`.

**Otros idiomas:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Esta es una traducción del [README en inglés](../README.md). Si alguna vez no coinciden, el que está al día es el inglés.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - El frontend de rol con LLM más mono">
</p>

> [!NOTE]
> Todo el código de este proyecto está generado o asistido por LLM, pero cada prompt y cada agente que incluye Neconyan lo ha hecho una persona.

Neconyan es mi fork con temática gatuna de [SillyTavern](https://github.com/SillyTavern/SillyTavern) y [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) para chatear y hacer rol con personajes de IA, en el ordenador o en el móvil. El modelo lo pones tú, ya sea un backend local o una clave API, porque no incluye acceso a ningún modelo ni créditos.

**[Lee el manual oficial de Neconyan](https://platberlitz.github.io/neconyan-docs/).** Empieza por ahí para la instalación y las dudas sobre cómo usar Neconyan. Incluye guías con capturas de pantalla, una referencia de macros e instrucciones para crear extensiones. Si algo no funciona, echa un vistazo a la [guía de solución de problemas](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) antes de abrir una incidencia.

Si quieres SillyTavern con todo funcionando exactamente igual que en el proyecto original, usa [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny). Yo solo incorporo las partes del original que me interesan, así que aquí algunas cosas se ven y se comportan de otra manera, y puede que algunas extensiones no funcionen.

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="¿Por qué Neconyan?">
</p>

- **Sigue trabajando cuando te vas.** Las respuestas se escriben en el navegador mientras miras, porque así es más rápido. Si cambias de app o bloqueas el móvil a mitad de un chat individual, el servidor guarda la respuesta y te la entrega cuando vuelves a abrir ese chat, sin que tengas que pagarla dos veces. Conversación, Meower y el trabajo de memoria siguen en el servidor de todos modos. Si quieres que los Agentes que se ejecutan después de cada respuesta también sigan, pon «Where replies are written» en **On the server**. Algunas cosas todavía necesitan la página abierta, como los modelos WebLLM que funcionan dentro del navegador y las voces de Kokoro.
- **Está pensado de verdad para el móvil.** Pestañas en condiciones y con nombre, una barra de chat abajo y un menú deslizante, no la versión de escritorio apretujada.
- **Cuatro formas de chatear.** El Juego de rol clásico, Conversación al estilo de una app de mensajería, una red social llamada Meower y el Modo historia para escribir textos largos.
- **Memoria de la historia.** [Mewmory](../docs/mewmory.md) lleva la cuenta de tu historia, de los PNJ que has conocido y de lo que dijeron, para que no tengas que volver a explicarlo todo 200 mensajes después.
- **Lo bueno viene de serie.** Agentes, Archivo de chat, Quick Image Gen, Guided Generations, BotSearcher y algunos más, cada uno con sus propios ajustes. [Aquí tienes los que empezaron como proyectos independientes y quién los hizo.](../docs/neconyan-native-tools.md)
- **Un sitio para tus notas.** [Cuadernos](../docs/notebooks.md) te da espacio para borradores de personajes, lugares, planes de escenas y diarios de sesión, justo al lado de tus chats. Las notas se enlazan entre sí y con tus lorebooks, y los asistentes pueden editarlas si les dejas.
- **Pequeños ayudantes.** Miso, Taro y Nori pueden usar llamadas a herramientas para crear personajes con retrato, editar lorebooks y retocar preajustes o agentes. El breve recorrido de Primeros pasos te enseña lo básico, y [Simple Mode](#simple-mode) deja lo avanzado a un lado hasta que lo quieras.
- **Alguien con quien comentar la historia.** [Scratchpad](../docs/scratchpad.md) es un chat lateral junto a tu historia donde los asistentes, tus propios personajes o toda una mesa redonda de ellos pueden leer la escena y darte ideas, sin que nada de eso acabe en el chat.
- **Es mono.** Temas Calico, gatos echándose la siesta sobre tus mensajes y un gato pixelado en Inicio. De eso se trataba, la verdad.
- **Tus archivos siguen siendo tuyos.** Lee las mismas fichas de personaje, chats, lorebooks y preajustes que SillyTavern, y no hay telemetría.

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Modos">
</p>

Son chats de demostración preparados para la ocasión, notas y respuestas de Scratchpad con los asistentes incluidos, así que no les des más importancia de la que tienen.

### Inicio

Lo primero que ves al entrar. Elige un personaje, empieza un chat temporal, conecta un modelo o saluda a uno de los asistentes.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="Inicio en el ordenador"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="Inicio en el móvil"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

Aquí dentro hay un montón de botones, y el primer día no necesitas la mayoría. Simple Mode esconde Mewmory, Archivo de chat, Extensiones, el selector de modos, casi todo lo de Ajuste fino y los botones extra que rodean el cuadro de mensaje, y te deja con los personajes, las conexiones, los preajustes, los lorebooks, Agentes, Cuadernos y Scratchpad. Nori te pregunta si lo quieres antes de que empiece el recorrido de Primeros pasos. No se desactiva nada, solo se oculta, así que pulsa **Show all features** en la barra lateral o desactívalo en Ajustes > Apariencia cuando quieras recuperarlo todo.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Un chat de Juego de rol con Simple Mode activado, en el ordenador"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Un chat de Juego de rol con Simple Mode activado, en el móvil"></td>
  </tr>
</table>

### Juego de rol

El chat clásico que ya conoces de SillyTavern, con un gato dormido encima de tus mensajes.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Juego de rol en el ordenador"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Juego de rol en el móvil"></td>
  </tr>
</table>

### Conversación

Escribirles a tus personajes como le escribirías a un amigo. Hay una lista de Amigos, chats grupales, ramas y personajes que pueden estar ocupados o desconectados.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Conversación en el ordenador"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Conversación en el móvil"></td>
  </tr>
</table>

### Meower

Una red social en miniatura donde tus personajes publican, se responden entre ellos y hacen encuestas sobre tentempiés.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower en el ordenador"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower en el móvil"></td>
  </tr>
</table>

### Modo historia

El chat convertido en prosa continua, para cuando prefieras leer una historia en vez de ir pasando burbujas.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Modo historia en el ordenador"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Modo historia en el móvil"></td>
  </tr>
</table>

### Cuadernos

Un cuaderno que vive junto a tus chats, para esos borradores de personajes y planes de escenas que, si no, acabarías perdiendo en algún archivo de texto. Tiene plantillas, carpetas, propiedades y una vista de lectura, y puedes abrirlo al lado de un chat. [Más sobre Cuadernos.](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Cuadernos en el ordenador"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Cuadernos en el móvil"></td>
  </tr>
</table>

### Scratchpad

Un chat lateral que se queda junto a tu historia, para cuando quieres hablar de la escena sin que los personajes se enteren. Pregúntale a Miso, Taro o Nori, copia una de tus fichas de personaje o crea tu propio asistente, y luego sienta hasta a tres de ellos en una mesa redonda y deja que discutan si tu giro de guion funciona. Nada de lo que escribas ahí pasa a la historia. [Más sobre Scratchpad.](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad junto a un chat en Modo historia, en el ordenador"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad en el móvil"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Primeros pasos">
</p>

Elige la opción que mejor encaje con lo que tienes:

| Tienes | Elige |
| --- | --- |
| Un móvil con Android 11 o posterior | [La app para Android](#android-app) |
| Un móvil Android más antiguo, o te gusta usar la terminal | [Termux](#android-with-termux) |
| Windows, macOS o Linux | [Una instalación en el ordenador](#on-a-computer) |
| Un iPhone con iOS 17 o posterior, y no te importa instalar apps por sideloading | [La app para iPhone](#iphone-app) |
| Cualquier otro iPhone, o prefieres tener tus chats en un ordenador | Una instalación en el ordenador y, después, [abrirlo en el móvil](#opening-it-on-your-phone) |

Elijas lo que elijas, sigues necesitando un modelo con el que hablar: una clave API de un proveedor o un backend local como KoboldCpp u Ollama.

<a id="android-app"></a>

### App para Android

En Android 11 o posterior, descarga el archivo que termina en `-android-arm64.apk` de la [última versión](https://github.com/platberlitz/Neconyan/releases/latest) y ábrelo. Lo más probable es que Android te pida antes que permitas instalar apps desde el navegador.

Todo funciona en el propio móvil, así que no hacen falta ni Termux ni un ordenador. Deja unos 2 GiB libres y ten paciencia la primera vez que la abras, mientras se descomprime. También necesita Android System WebView 124 o posterior, y la app te avisa si tu versión de WebView es demasiado antigua. Para actualizar, instala el APK nuevo encima del antiguo y tus chats se quedan donde estaban. [Instalación en Android, copias de seguridad e instrucciones de compilación.](../android/README.md)

<a id="iphone-app"></a>

### App para iPhone

Ahora también hay una app independiente para iPhone. La idea es la misma que con la de Android: el servidor, tus chats y tus ajustes viven en el móvil, así que no necesitas un ordenador con Neconyan en marcha. No está en la App Store, así que tienes que instalarla por tu cuenta mediante sideloading.

1. Abre la [página de la versión](https://github.com/platberlitz/Neconyan/releases/latest) y descarga el archivo que termina en `-ios-unsigned.ipa`, si esa versión lo incluye. Si no, usa la [opción del navegador](#opening-it-on-your-phone).
2. Selecciónalo en una herramienta de sideloading como [iloader](https://github.com/nab138/iloader). La herramienta lo firma con tu cuenta de Apple y lo instala. Necesitarás iOS 17 o posterior.
3. Abre Neconyan y conecta un modelo desde **Conexiones**, como en cualquier otro sitio.

Con una cuenta de Apple gratuita tienes que volver a firmar la app cada siete días, y solo puedes instalar tres apps por sideloading. Para actualizar, instala el IPA nuevo encima del antiguo con la misma cuenta de Apple, y tus chats se quedan donde estaban. Si borras la app, tus chats se borran con ella, así que exporta antes una copia de seguridad de la cuenta si vas a cambiar de herramienta de sideloading.

Las importaciones siguen adelante aunque cambies de app o bloquees el móvil. Elige la copia de seguridad con el botón **Importar ZIP de respaldo** de la propia app, confirma, y el servidor se encarga del resto: reproduce silencio para que iOS no lo congele mientras trabaja, y puedes volver a mirar cuando quieras. Las respuestas también siguen, igual que en una pestaña del navegador en el ordenador: si te vas a mitad de una respuesta, la página reproduce su propio sonido silencioso hasta que la respuesta esté escrita y guardada y se hayan ejecutado los Agentes que vayan después. Mientras tanto puede que veas «Neconyan is finishing a reply» en la pantalla de bloqueo, y la música de otra app puede quedarse en pausa hasta que termine. Aun así, iOS puede cerrar la app si el móvil se queda corto de memoria. Mientras se carga la copia de seguridad, deja libre más o menos el doble de lo que ocupa. [Instalación en iPhone, límites e instrucciones de compilación.](../ios/README.md)

<a id="on-a-computer"></a>

### En un ordenador

1. **Consigue Neconyan.** Hay dos maneras, y la segunda se mantiene al día sola.

   - **Descárgalo.** Coge el archivo que termina en `-source.zip` de la [última versión](https://github.com/platberlitz/Neconyan/releases/latest) y descomprímelo en algún sitio fácil de encontrar, como tu carpeta Documentos. En Windows, haz clic derecho en el zip y elige primero **Extraer todo**, porque ejecutar el lanzador desde dentro del zip no funciona. Acabarás con una carpeta con el nombre de la versión, como `Neconyan-1.3.7`.
   - **Clónalo con [Git](https://git-scm.com/downloads).** Abre una terminal donde quieras tener la carpeta y ejecuta la línea de abajo. Así, el lanzador busca una versión nueva cada vez que lo inicias y se actualiza antes de abrirse, y por eso yo iría por aquí.

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **Arráncalo.** Abre la carpeta de Neconyan y ejecuta el lanzador de tu sistema.

   | Sistema | Cómo |
   | --- | --- |
   | Windows | Haz doble clic en `Start.bat` |
   | macOS | Haz doble clic en `Start.command` |
   | Linux o WSL | Abre una terminal en la carpeta y ejecuta `./start.sh` |

   El primer arranque tarda unos minutos. Si no tienes Bun ni Node.js (los programas que de verdad hacen funcionar Neconyan), el lanzador te instala Bun y luego descarga todo lo demás que Neconyan necesita. Deja esa ventana abierta mientras usas Neconyan; si la cierras, o pulsas Ctrl+C en ella, Neconyan se detiene.

3. **Ábrelo.** El navegador debería abrirse solo. Si no lo hace, ve a **http://127.0.0.1:4433/**.
4. **Conecta un modelo.** Haz clic en **Conexiones** en la barra lateral, elige tu proveedor y tu modelo, y pega tu clave API o la dirección de tu backend local. Después, importa un personaje o saluda a Miso, Taro o Nori en Inicio.

La próxima vez, vuelve a ejecutar el mismo lanzador.

**Actualizar.** Las instalaciones con Git se actualizan solas al arrancar. Con el zip, descarga el nuevo y descomprímelo en una carpeta nueva, cierra Neconyan y copia la carpeta `data` de la carpeta antigua de Neconyan a la nueva, junto con `config.yaml` si lo has cambiado. Arranca la versión nueva y comprueba que tus chats están ahí antes de borrar la carpeta antigua.

<a id="android-with-termux"></a>

### Android con Termux

[Termux](https://termux.dev/) es una app de terminal para Android. Da más guerra que la app de arriba, pero también funciona en móviles más antiguos.

1. Instala Termux desde [F-Droid](https://f-droid.org/packages/com.termux/) o desde [sus versiones en GitHub](https://github.com/termux/termux-app/releases).
2. Abre Termux y actualízalo. Si se para a preguntarte por un archivo de configuración, pulsa Intro para conservar el actual.

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Instala Git y luego descarga Neconyan en tu carpeta personal de Termux. `--depth 1` se salta el historial antiguo del proyecto, así que la descarga es más pequeña, y las actualizaciones siguen funcionando.

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. Arráncalo. El primer arranque instala Node.js y todo lo demás que Neconyan necesita, así que dale unos minutos.

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. Cuando veas `Go to: http://127.0.0.1:4433/ to open Neconyan`, abre esa dirección en Chrome o en cualquier otro navegador del móvil. Luego conecta un modelo desde **Conexiones**, igual que en un ordenador.

Unas cuantas costumbres de Termux que conviene coger:

- Para detener Neconyan, toca **CTRL** en la fila de teclas extra y luego **C**.
- La próxima vez, abre Termux y vuelve a ejecutar `cd ~/Neconyan && bash start.sh`. Se actualiza solo antes de arrancar.
- Deja la carpeta en tu carpeta personal de Termux. El lanzador se niega a ejecutarse desde el almacenamiento compartido, como `/sdcard`, porque ahí Android bloquea los enlaces de archivos que necesitan los paquetes de Neconyan.
- En el menú de Chrome, **Añadir a pantalla de inicio** le da a Neconyan su propio icono.

**Mantenerlo en marcha en segundo plano.** A Android le gusta detener las apps que no estás mirando, y Termux no es ninguna excepción. Estos pasos mantienen vivo Neconyan mientras estás en otra app:

1. Despliega las notificaciones y comprueba que la de Termux indica que el wake lock está activo. Neconyan lo pide al arrancar; si no se ha quedado puesto, toca **Acquire wakelock** ahí mismo.
2. Abre **Ajustes → Aplicaciones → Termux → Batería** de Android y elige **Sin restricciones**. Los nombres cambian de una marca de móvil a otra, así que busca «optimización de batería» en Ajustes si no lo encuentras.
3. En Android 12 o posterior, Android también mata los procesos extra que inicia Termux, y Neconyan es uno de ellos. En Android 14 y posteriores, activa las opciones para desarrolladores (toca siete veces **Número de compilación** en **Información del teléfono**) y luego activa **Disable child process restrictions**. En Android 12 y 13 no hay ningún interruptor, así que tienes que ejecutar estos dos comandos una vez desde un ordenador con `adb` y la depuración USB:

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

Aunque el servidor siga vivo, Chrome puede sacar la página de memoria al cabo de un rato, así que Neconyan se recarga cuando vuelves. Si eso te molesta, activa **Stay open in the background** en **Ajustes → Sistema y dispositivo → Memory and performance**. Mientras no estás, reproduce un sonido tan bajo que no se oye, así que Chrome trata a Neconyan como un reproductor de música y lo deja en paz. Gasta algo de batería, muestra una notificación multimedia y puede pausar la música que suene en otras apps, y por eso viene desactivado por defecto. De momento solo lo he probado en un navegador de móvil emulado, no en un móvil de verdad, así que avísame si tu móvil no le hace caso.

<a id="opening-it-on-your-phone"></a>

### Abrirlo en el móvil

Si Neconyan funciona en tu ordenador, tu móvil también puede usarlo, siempre que los dos estén conectados a la misma wifi. Es también la opción para iPhone si prefieres no instalar la [app para iPhone](#iphone-app) por sideloading.

Los dos navegadores usan los mismos datos. Si lo que necesitas es mover una instalación sin conexión de un dispositivo a otro, lee [Mover datos entre dispositivos](../docs/data-portability.md), incluida la configuración de la carpeta de datos en GitHub, antes de copiar o sincronizar la carpeta.

1. Detén Neconyan y abre `config.yaml` en la carpeta de Neconyan con cualquier editor de texto. Aparece después del primer arranque. Cambia `listen: false` por `listen: true`.
2. Ya que estás ahí, activa una contraseña, porque si no cualquiera que esté en tu wifi puede abrirlo. Pon `basicAuthMode: true` y luego cambia `username` y `password` dentro de `basicAuthUser`.
3. Vuelve a arrancar Neconyan y busca la dirección local de tu ordenador.
   - **Windows:** ejecuta `ipconfig` en el Símbolo del sistema y busca **Dirección IPv4**.
   - **macOS:** mantén pulsada la tecla Opción y haz clic en el icono de wifi de la barra de menús; luego busca **Dirección IP**.
   - **Linux:** ejecuta `hostname -I`.
4. En el navegador del móvil, escribe esa dirección con `http://` delante y `:4433` detrás, por ejemplo `http://192.168.1.20:4433`.

Si Windows te pregunta si quieres dejar pasar a Bun o Node.js por el cortafuegos, permítelo en las redes privadas. Si el móvil muestra una página que solo dice **Prohibido**, tu red reparte direcciones que empiezan por `10.`, y Neconyan las bloquea por defecto. Añade esta línea debajo de `whitelist:` en `config.yaml` y reinicia Neconyan:

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Elegir entre Node.js y Bun, y otras opciones del lanzador</b></summary>

Cada sistema tiene también lanzadores separados para Node.js y para Bun, por si prefieres elegir tú:

| Sistema | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

Para instalarlo a mano, necesitas Node.js 20 o posterior:

```sh
npm install
npm run start:node
```

Bun 1.3.14 o posterior también funciona: ejecuta `bun install` y luego `bun run start`, o `bun run start:mobile` para usar menos memoria. Deja el archivo `.npmrc` del repositorio tal como está.

Para que una instalación con Git no se actualice sola, define `NECONYAN_AUTO_UPDATE=0` antes de ejecutar el lanzador.

</details>

<details>
<summary><b>Si algo no arranca</b></summary>

- **Windows dice que ha protegido tu PC:** haz clic en **Más información** y luego en **Ejecutar de todas formas**. Lo dice de casi todos los lanzadores descargados.
- **macOS no abre `Start.command` porque es de un desarrollador no identificado:** haz clic derecho sobre él y elige **Abrir**. En las versiones más recientes de macOS, ve a **Ajustes del Sistema → Privacidad y seguridad** y haz clic en **Abrir igualmente**.
- **macOS o Linux dice que el lanzador no es ejecutable:** ejecuta esto en la carpeta de Neconyan.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Una instalación con Git ha dejado de actualizarse:** el lanzador se salta las actualizaciones si has editado alguno de los archivos propios de Neconyan, y te dice por qué al arrancar. Tus chats y `config.yaml` no cuentan.
- **Android:** en Termux, Node.js es la opción por defecto. Bun necesita dos paquetes extra, que el lanzador de Bun intenta instalarte. Si no lo consigue, instálalos tú:

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  Define `GLIBC_ROOT` si tu glibc está en otro sitio que no sea `$PREFIX/glibc`.

- **El puerto 4433 está ocupado:** pasa `--port` con otro número, o cambia el puerto en `config.yaml`.

</details>

### ¿Vienes de SillyTavern o SillyBunny?

La mayoría de tus personajes, chats, lorebooks, personas y preajustes deberían pasar sin problemas, pero no puedo prometer que todo lo haga, y puede que haya que arreglar las extensiones que dependen de la estructura de la página de SillyTavern.

- **Haz antes una copia de seguridad de tu instalación anterior** y guárdala hasta que hayas comprobado que todo funciona.
- **Dale a Neconyan su propia carpeta de datos.** Nunca hagas que dos apps apunten a la misma.

Neconyan crea su propio `config.yaml` y su propia carpeta `data/` la primera vez que se ejecuta. Tus datos personales, tus claves y los paquetes que hayas instalado nunca forman parte de una versión publicada.

<details>
<summary><b>Para desarrolladores</b></summary>

`main` guarda las instantáneas de cada versión y `staging` es donde se trabaja. Usa un checkout y una carpeta de datos aparte para las pruebas, para que tus chats de todos los días queden al margen.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

Las pruebas de navegador están en `tests/` y se ejecutan contra un servidor desechable: pon su dirección en `NECONYAN_TEST_BASE_URL` (por defecto es `http://127.0.0.1:4433`). Compila el frontend antes de hacer pruebas y reinicia el servidor después de volver a compilar. Las capturas temporales, los informes de pruebas, los archivos de compilación y las carpetas locales de ejecución no entran en los commits.

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Créditos">
</p>

Neconyan se apoya en el trabajo de todas las personas que hay detrás de SillyTavern y SillyBunny; nada de esto existiría sin ellas. Las herramientas incluidas y los proyectos de los que salieron aparecen acreditados en [la lista de herramientas incluidas](../docs/neconyan-native-tools.md).

Hecho por [Platberlitz](https://github.com/platberlitz). Con licencia [GNU AGPL v3](../LICENSE), así que mantén los avisos y las licencias si lo redistribuyes.
