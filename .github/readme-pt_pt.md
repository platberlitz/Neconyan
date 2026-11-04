<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

Versão mais recente: **[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**. O desenvolvimento continua em `staging`.

**Outros idiomas:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Esta é uma tradução do [README em inglês](../README.md). Se alguma vez as duas não coincidirem, a versão em inglês é a que está em dia.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - O frontend de RP com LLM mais fofo">
</p>

> [!NOTE]
> Todo o código deste projeto foi gerado por LLM ou escrito com a ajuda de LLM, mas todos os prompts e agentes que vêm com o Neconyan foram feitos por pessoas.

O Neconyan é o meu fork com tema de gatos do [SillyTavern](https://github.com/SillyTavern/SillyTavern) e do [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny), para conversar e fazer roleplay com personagens de IA, no computador ou no telemóvel. O modelo fica por sua conta, seja um backend local ou uma chave de API, porque o Neconyan não traz acesso a nenhum modelo nem créditos.

**[Leia o manual oficial do Neconyan](https://platberlitz.github.io/neconyan-docs/).** Comece por aí para a instalação e para dúvidas sobre como usar o Neconyan. Tem guias com capturas de ecrã, uma referência de macros e instruções para criar extensões. Se alguma coisa não estiver a funcionar, experimente o [guia de resolução de problemas](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) antes de abrir uma issue.

Se quiser o SillyTavern com tudo a funcionar exatamente como no original, use antes o [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny). Eu só vou buscar ao upstream as partes que me interessam, por isso aqui algumas coisas têm outro aspeto e comportam-se de outra maneira, e algumas extensões podem não funcionar.

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Porquê o Neconyan?">
</p>

- **Continua a trabalhar quando sai.** As respostas são escritas no navegador enquanto as vê, porque assim é mais rápido. Se mudar de aplicação ou bloquear o telemóvel a meio de um chat individual, o servidor guarda a resposta e entrega-a quando voltar a abrir esse chat, sem ter de a pagar duas vezes. A Conversa, o Meower e o trabalho de memória continuam no servidor de qualquer forma. Se quiser que os Agentes que correm depois de cada resposta também continuem, defina «Where replies are written» como **On the server**. Algumas coisas ainda precisam da página aberta, como os modelos WebLLM que correm no navegador e as vozes Kokoro.
- **Foi mesmo feito a pensar nos telemóveis.** Separadores a sério, com nome, uma barra de chat em baixo e um menu deslizante, e não a versão de computador espremida.
- **Quatro maneiras de conversar.** O Roleplay clássico, a Conversa ao estilo de uma aplicação de mensagens, um feed social chamado Meower e o Modo história para escrita mais longa.
- **Memória da história.** O [Mewmory](../docs/mewmory.md) acompanha a sua história, os NPCs que já conheceu e o que disseram, para não ter de voltar a explicar tudo 200 mensagens depois.
- **O melhor já vem incluído.** Agentes, Arquivo de chats, Quick Image Gen, Guided Generations, BotSearcher e mais alguns, cada um com as suas próprias opções. [Aqui estão os que começaram como projetos à parte, e quem os fez.](../docs/neconyan-native-tools.md)
- **Um sítio para guardar notas.** Os [Cadernos](../docs/notebooks.md) dão-lhe espaço para rascunhos de personagens, lugares, planos de cenas e diários de sessão, mesmo ao lado dos seus chats. As notas ligam-se umas às outras e aos seus lorebooks, e os assistentes podem editá-las se os deixar.
- **Pequenos ajudantes.** Miso, Taro e Nori podem usar chamadas de ferramentas para criar personagens com retrato, editar lorebooks e ajustar presets ou agentes. O curto tour das primeiras patinhas mostra-lhe o básico, e o [Simple Mode](#simple-mode) tira as coisas avançadas do caminho até as querer.
- **Alguém com quem falar sobre a história.** O [Scratchpad](../docs/scratchpad.md) é um chat paralelo, ao lado da sua história, onde os assistentes, as suas próprias personagens ou uma mesa-redonda inteira delas podem ler a cena e dar-lhe ideias, sem que nada disso acabe no chat.
- **É fofo.** Temas Calico, gatos a dormir a sesta em cima das suas mensagens e um gato em pixel art no Início. No fundo, a ideia era mesmo essa.
- **Os seus ficheiros continuam a ser seus.** Lê os mesmos cartões de personagem, chats, lorebooks e presets que o SillyTavern, e não há telemetria.

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Modos">
</p>

Estes chats, notas e respostas do Scratchpad com os assistentes incluídos são demonstrações encenadas, por isso não lhes dê demasiada importância.

### Início

É aqui que chega. Escolha uma personagem, inicie um chat temporário, ligue um modelo ou diga olá a um dos assistentes.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="Início no computador"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="Início num telemóvel"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

Há muitos botões por aqui, e no primeiro dia não precisa da maior parte deles. O Simple Mode arruma o Mewmory, o Arquivo de chats, as Extensões, o seletor de modos, a maior parte do Ajuste fino e os botões extra à volta da caixa de mensagem, e deixa-lhe as personagens, as conexões, os presets, os lorebooks, os Agentes, os Cadernos e o Scratchpad. Nori pergunta-lhe se o quer antes de começar o tour das primeiras patinhas. Nada é desligado, fica apenas escondido, por isso carregue em **Show all features** na barra lateral ou desative-o em Configurações > Aparência sempre que quiser tudo de volta.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Um chat de Roleplay com o Simple Mode ativado, no computador"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Um chat de Roleplay com o Simple Mode ativado, num telemóvel"></td>
  </tr>
</table>

### Roleplay

O chat clássico que conhece do SillyTavern, com um gato a dormir em cima das suas mensagens.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Roleplay no computador"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Roleplay num telemóvel"></td>
  </tr>
</table>

### Conversa

Trocar mensagens com as suas personagens como faria com um amigo. Há uma lista de Amigos, chats de grupo, ramificações e personagens que podem estar ocupadas ou offline.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Conversa no computador"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Conversa num telemóvel"></td>
  </tr>
</table>

### Meower

Um pequeno feed social onde as suas personagens publicam, respondem umas às outras e fazem sondagens sobre petiscos.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower no computador"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower num telemóvel"></td>
  </tr>
</table>

### Modo história

O chat transformado em prosa contínua, para quando prefere ler uma história a percorrer balões de mensagens.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Modo história no computador"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Modo história num telemóvel"></td>
  </tr>
</table>

### Cadernos

Um caderno que vive ao lado dos seus chats, para os rascunhos de personagens e os planos de cenas que, de outra forma, acabaria por perder num ficheiro de texto algures. Tem modelos, pastas, propriedades e um modo de leitura, e pode abri-lo ao lado de um chat. [Mais sobre os Cadernos.](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Cadernos no computador"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Cadernos num telemóvel"></td>
  </tr>
</table>

### Scratchpad

Um chat paralelo que fica ao lado da sua história, para quando quer falar sobre a cena sem que as personagens oiçam. Fale com Miso, Taro ou Nori, copie um dos seus cartões de personagem ou crie o seu próprio assistente, e depois sente até três deles a uma mesa-redonda e deixe-os discutir se a sua reviravolta no enredo resulta. Nada do que escrever ali entra na história. [Mais sobre o Scratchpad.](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad ao lado de um chat no Modo história, no computador"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad num telemóvel"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Primeiros passos">
</p>

Escolha a opção que melhor se adapta ao que tem:

| O que tem | Opção |
| --- | --- |
| Um telemóvel com Android 11 ou mais recente | [A aplicação Android](#android-app) |
| Um telemóvel Android mais antigo, ou gosta de usar um terminal | [Termux](#android-with-termux) |
| Windows, macOS ou Linux | [Uma instalação no computador](#on-a-computer) |
| Um iPhone com iOS 17 ou mais recente, e não se importa de fazer sideload | [A aplicação para iPhone](#iphone-app) |
| Qualquer outro iPhone, ou prefere manter os seus chats num computador | Uma instalação no computador, e depois [abrir o Neconyan no telemóvel](#opening-it-on-your-phone) |

Seja qual for a escolha, continua a precisar de um modelo com quem conversar: uma chave de API de um fornecedor ou um backend local como o KoboldCpp ou o Ollama.

<a id="android-app"></a>

### Aplicação Android

No Android 11 ou mais recente, transfira o ficheiro que termina em `-android-arm64.apk` a partir da [versão mais recente](https://github.com/platberlitz/Neconyan/releases/latest) e abra-o. O Android vai provavelmente pedir-lhe primeiro que autorize a instalação de aplicações a partir do navegador.

Tudo corre no telemóvel, por isso não é preciso Termux nem computador. Deixe cerca de 2 GiB livres e dê algum tempo à primeira abertura, enquanto tudo é descompactado. Também precisa do Android System WebView 124 ou mais recente, e a aplicação avisa-o se o seu for demasiado antigo. Para atualizar, instale o novo APK por cima do antigo e os seus chats ficam onde estão. [Configuração do Android, cópias de segurança e instruções de compilação.](../android/README.md)

<a id="iphone-app"></a>

### Aplicação para iPhone

Agora também há uma aplicação autónoma para iPhone. A ideia é a mesma da aplicação Android: o servidor, os seus chats e as suas definições ficam todos no telemóvel, por isso não precisa de ter um computador a correr o Neconyan. Não está na App Store, por isso tem de fazer o sideload por conta própria.

1. Abra a [página da versão](https://github.com/platberlitz/Neconyan/releases/latest) e transfira o ficheiro que termina em `-ios-unsigned.ipa`, se essa versão o incluir. Se não incluir, use antes a [configuração pelo navegador](#opening-it-on-your-phone).
2. Escolha-o numa ferramenta de sideload como o [iloader](https://github.com/nab138/iloader). A ferramenta assina-o com a sua conta Apple e instala-o. Vai precisar do iOS 17 ou mais recente.
3. Abra o Neconyan e ligue um modelo em **Conexões**, tal como em qualquer outro lado.

Com uma conta Apple gratuita, tem de voltar a assinar a aplicação de sete em sete dias e só pode fazer sideload de três aplicações. Para atualizar, instale o novo IPA por cima do antigo com a mesma conta Apple, e os seus chats ficam onde estão. Apagar a aplicação apaga também os seus chats, por isso exporte primeiro uma cópia de segurança da conta se for mudar de ferramenta de sideload.

As importações continuam quando muda de aplicação ou bloqueia o telemóvel. Escolha a cópia de segurança com o botão **Importar ZIP de backup** da própria aplicação, confirme, e o servidor trata do resto, a reproduzir silêncio para que o iOS não o congele enquanto trabalha; pode ir ver como está quando quiser. As respostas também continuam, tal como num separador do navegador no computador: se sair a meio de uma resposta, a página reproduz o seu próprio som silencioso até a resposta estar escrita e guardada e até terem corrido os Agentes que vêm depois dela. Entretanto, pode aparecer «Neconyan is finishing a reply» no ecrã de bloqueio, e a música de outra aplicação pode ficar em pausa até a resposta terminar. Mesmo assim, o iOS pode fechar a aplicação se o telemóvel ficar com pouca memória. Enquanto a cópia de segurança é transferida para a aplicação, deixe livre cerca do dobro do tamanho dela. [Configuração do iPhone, limites e instruções de compilação.](../ios/README.md)

<a id="on-a-computer"></a>

### Num computador

1. **Obtenha o Neconyan.** Há duas formas, e a segunda mantém-se atualizada sozinha.

   - **Transfira-o.** Vá buscar o ficheiro que termina em `-source.zip` à [versão mais recente](https://github.com/platberlitz/Neconyan/releases/latest) e descompacte-o num sítio fácil de encontrar, como a pasta Documentos. No Windows, clique com o botão direito do rato no zip e escolha primeiro **Extrair Tudo**, porque executar o iniciador a partir de dentro do zip não funciona. Vai ficar com uma pasta com o nome da versão, como `Neconyan-1.3.7`.
   - **Clone-o com o [Git](https://git-scm.com/downloads).** Abra um terminal no sítio onde quer a pasta e execute a linha abaixo. A partir daí, o iniciador verifica se há uma versão nova sempre que o abre e atualiza-se antes de arrancar, e é por isso que eu escolheria este caminho.

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **Inicie-o.** Abra a pasta do Neconyan e execute o iniciador do seu sistema.

   | Sistema | Como |
   | --- | --- |
   | Windows | Faça duplo clique em `Start.bat` |
   | macOS | Faça duplo clique em `Start.command` |
   | Linux ou WSL | Abra um terminal na pasta e execute `./start.sh` |

   O primeiro arranque demora alguns minutos. Se não tiver o Bun nem o Node.js (os programas que, na prática, põem o Neconyan a funcionar), o iniciador instala o Bun por si e depois transfere tudo o resto de que o Neconyan precisa. Mantenha essa janela aberta enquanto usa o Neconyan; se a fechar, ou se carregar em Ctrl+C dentro dela, o Neconyan para.

3. **Abra-o.** O navegador deve abrir sozinho. Se não abrir, vá a **http://127.0.0.1:4433/**.
4. **Ligue um modelo.** Clique em **Conexões** na barra lateral, escolha o fornecedor e o modelo, e depois cole a sua chave de API ou o endereço do seu backend local. A seguir, importe uma personagem ou diga olá a Miso, Taro ou Nori no Início.

Da próxima vez, basta executar o mesmo iniciador.

**Atualizar.** As instalações feitas com Git atualizam-se sozinhas quando as inicia. Se usou o zip, transfira o novo e descompacte-o numa pasta nova, feche o Neconyan e depois copie a pasta `data` da pasta antiga do Neconyan para a nova, e também o `config.yaml`, se o tiver alterado. Inicie a versão nova e confirme que os seus chats lá estão antes de apagar a pasta antiga.

<a id="android-with-termux"></a>

### Android com Termux

O [Termux](https://termux.dev/) é uma aplicação de terminal para Android. Dá mais trabalho do que a aplicação acima, mas também funciona em telemóveis mais antigos.

1. Instale o Termux a partir do [F-Droid](https://f-droid.org/packages/com.termux/) ou das [versões publicadas no GitHub](https://github.com/termux/termux-app/releases).
2. Abra o Termux e atualize-o. Se parar para perguntar algo sobre um ficheiro de configuração, carregue em Enter para manter o atual.

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Instale o Git e depois transfira o Neconyan para a sua pasta pessoal do Termux. `--depth 1` deixa de fora o histórico antigo do projeto, por isso a transferência é mais pequena, e as atualizações continuam a funcionar.

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. Inicie-o. O primeiro arranque instala o Node.js e tudo o resto de que o Neconyan precisa, por isso dê-lhe alguns minutos.

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. Quando vir `Go to: http://127.0.0.1:4433/ to open Neconyan`, abra esse endereço no Chrome ou noutro navegador qualquer do telemóvel. Depois ligue um modelo em **Conexões**, tal como num computador.

Alguns hábitos do Termux que vale a pena ganhar:

- Para parar o Neconyan, toque em **CTRL** na fila de teclas extra e depois em **C**.
- Da próxima vez, abra o Termux e execute outra vez `cd ~/Neconyan && bash start.sh`. O Neconyan atualiza-se antes de arrancar.
- Mantenha a pasta na sua pasta pessoal do Termux. O iniciador recusa-se a correr a partir do armazenamento partilhado, como `/sdcard`, porque aí o Android bloqueia as ligações de ficheiros de que os pacotes do Neconyan precisam.
- No menu do Chrome, **Adicionar ao ecrã principal** dá ao Neconyan um ícone próprio.

**Mantê-lo a correr em segundo plano.** O Android gosta de parar as aplicações que não está a usar, e o Termux não é exceção. Estes passos mantêm o Neconyan vivo enquanto está noutra aplicação:

1. Puxe as notificações para baixo e confirme que a do Termux diz que o wake lock está ativo. O Neconyan pede-o quando arranca; se não tiver ficado ativo, toque aí em **Acquire wakelock**.
2. Abra **Definições → Aplicações → Termux → Bateria** no Android e escolha **Sem restrições**. Os nomes mudam de marca para marca, por isso, se não encontrar a opção, pesquise «otimização da bateria» nas Definições.
3. No Android 12 ou mais recente, o Android também termina os processos extra que o Termux inicia, e o Neconyan é um deles. No Android 14 ou mais recente, ative as Opções de programador (toque sete vezes em **Número de compilação**, em **Acerca do telefone**) e depois ligue **Disable child process restrictions**. No Android 12 e 13 não existe essa opção, por isso tem de executar estes dois comandos uma vez, a partir de um computador com `adb` e a depuração USB ativada:

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

Mesmo com o servidor vivo, o próprio Chrome pode tirar a página da memória ao fim de algum tempo, e por isso o Neconyan recarrega quando volta à página. Se isso o incomodar, ative **Stay open in the background** em **Configurações → Sistema e dispositivo → Memory and performance**. Enquanto está fora, a página reproduz um som tão baixo que não se ouve, para que o Chrome trate o Neconyan como um leitor de música e o deixe em paz. Gasta alguma bateria, mostra uma notificação de multimédia e pode pôr em pausa a música que esteja a tocar noutras aplicações, e é por isso que vem desligado por predefinição. Até agora só o testei no navegador de um telemóvel emulado, não num telemóvel a sério, por isso diga-me se o seu telemóvel ignorar esta opção.

<a id="opening-it-on-your-phone"></a>

### Abrir o Neconyan no telemóvel

Se o Neconyan estiver a correr no seu computador, o telemóvel também o pode usar, desde que os dois estejam na mesma rede Wi-Fi. Também é o caminho a seguir num iPhone, se preferir não fazer sideload da [aplicação para iPhone](#iphone-app).

Os dois navegadores usam os mesmos dados. Se, em vez disso, precisar de passar uma instalação offline de um dispositivo para outro, leia [Mover dados entre dispositivos](../docs/data-portability.md), incluindo a configuração da pasta de dados no GitHub, antes de copiar ou sincronizar a pasta.

1. Pare o Neconyan e abra o `config.yaml` na pasta do Neconyan com um editor de texto qualquer. O ficheiro aparece depois do primeiro arranque. Mude `listen: false` para `listen: true`.
2. Já que está aí, ative uma palavra-passe, porque senão qualquer pessoa na sua rede Wi-Fi o pode abrir. Defina `basicAuthMode: true` e depois altere o `username` e a `password` em `basicAuthUser`.
3. Volte a iniciar o Neconyan e descubra o endereço local do seu computador.
   - **Windows:** execute `ipconfig` na Linha de Comandos e procure **Endereço IPv4**.
   - **macOS:** mantenha a tecla Option premida e clique no ícone do Wi-Fi na barra de menus, e depois procure **Endereço IP**.
   - **Linux:** execute `hostname -I`.
4. No navegador do telemóvel, escreva esse endereço com `http://` à frente e `:4433` no fim, por exemplo `http://192.168.1.20:4433`.

Se o Windows perguntar se deve deixar o Bun ou o Node.js passar pela firewall, permita-o nas redes privadas. Se o telemóvel mostrar uma página que diz apenas **Acesso negado**, a sua rede atribui endereços começados por `10.`, que o Neconyan bloqueia por predefinição. Acrescente esta linha por baixo de `whitelist:` no `config.yaml` e depois reinicie o Neconyan:

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Escolher entre Node.js e Bun, e outras opções do iniciador</b></summary>

Cada sistema também tem iniciadores separados para Node.js e para Bun, se preferir escolher:

| Sistema | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

Para instalar à mão, precisa do Node.js 20 ou mais recente:

```sh
npm install
npm run start:node
```

O Bun 1.3.14 ou mais recente também funciona: execute `bun install` e depois `bun run start`, ou `bun run start:mobile` para usar menos memória. Deixe o ficheiro `.npmrc` do repositório tal como está.

Para impedir que uma instalação feita com Git se atualize sozinha, defina `NECONYAN_AUTO_UPDATE=0` antes de executar o iniciador.

</details>

<details>
<summary><b>Se alguma coisa não arrancar</b></summary>

- **O Windows diz que protegeu o seu PC:** clique em **More info** e depois em **Run anyway**. Diz isto da maioria dos iniciadores transferidos.
- **O macOS não abre o `Start.command` por ser de um programador não identificado:** clique nele com o botão direito e escolha **Abrir**. Nas versões mais recentes do macOS, vá antes a **Definições do Sistema → Privacidade e segurança** e clique em **Abrir mesmo assim**.
- **O macOS ou o Linux dizem que o iniciador não é executável:** execute isto na pasta do Neconyan.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Uma instalação feita com Git deixou de se atualizar:** o iniciador salta as atualizações se algum dos ficheiros do próprio Neconyan tiver sido editado, e explica porquê ao arrancar. Os seus chats e o `config.yaml` não contam.
- **Android:** no Termux, o Node.js é a opção predefinida. O Bun precisa de dois pacotes extra, que o iniciador do Bun tenta instalar por si. Se isso falhar, instale-os manualmente:

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  Defina `GLIBC_ROOT` se a sua glibc estiver noutro sítio que não `$PREFIX/glibc`.

- **A porta 4433 está ocupada:** passe `--port` com outro número, ou altere a porta no `config.yaml`.

</details>

### Vem do SillyTavern ou do SillyBunny?

A maior parte das suas personagens, chats, lorebooks, personas e presets deve passar sem problemas, mas não posso prometer que tudo passe, e as extensões que dependem da estrutura da página do SillyTavern podem precisar de ser corrigidas.

- **Faça primeiro uma cópia de segurança da instalação antiga**, e guarde-a até confirmar que está tudo a funcionar.
- **Dê ao Neconyan uma pasta de dados só dele.** Nunca ponha duas aplicações a usar a mesma.

O Neconyan cria o seu próprio `config.yaml` e a pasta `data/` da primeira vez que é executado. Os seus dados pessoais, chaves e pacotes instalados nunca fazem parte da versão publicada.

<details>
<summary><b>Para programadores</b></summary>

`main` guarda os snapshots das versões publicadas e `staging` é onde se trabalha. Para testes, use um checkout e uma pasta de dados à parte, para que os chats do dia a dia fiquem de fora.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

Os testes de navegador estão em `tests/` e correm contra um servidor descartável: defina `NECONYAN_TEST_BASE_URL` com o endereço dele (por predefinição, `http://127.0.0.1:4433`). Compile o frontend antes de testar e reinicie o servidor depois de recompilar. Capturas de ecrã temporárias, relatórios de testes, resultados de compilação e pastas de runtime locais ficam fora dos commits.

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Créditos">
</p>

O Neconyan assenta no trabalho de todas as pessoas por trás do SillyTavern e do SillyBunny; nada disto existiria sem elas. As ferramentas incluídas e os projetos de onde vieram estão creditados na [lista de ferramentas incluídas](../docs/neconyan-native-tools.md).

Feito por [Platberlitz](https://github.com/platberlitz). Licenciado sob a [GNU AGPL v3](../LICENSE), por isso mantenha os avisos e as licenças se o redistribuir.
