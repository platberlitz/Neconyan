<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

최신 릴리스: **[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**. 개발은 `staging`에서 계속 이어지고 있어요.

**다른 언어:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

이 문서는 [영어 README](../README.md)를 번역한 거예요. 두 문서의 내용이 다를 때는 영어 쪽이 최신이에요.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - 가장 귀여운 LLM RP 프런트엔드">
</p>

> [!NOTE]
> 여기 있는 코드는 전부 LLM이 생성했거나 LLM의 도움을 받아 작성했지만, Neconyan에 함께 들어 있는 프롬프트와 에이전트는 모두 사람이 직접 만들었어요.

Neconyan은 제가 [SillyTavern](https://github.com/SillyTavern/SillyTavern)과 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny)를 바탕으로 만든 고양이 테마 포크로, 데스크톱이나 휴대폰에서 AI 캐릭터와 채팅하고 역할극을 즐길 수 있어요. 모델 접근 권한이나 크레딧은 들어 있지 않으니, 로컬 백엔드든 API 키든 모델은 직접 준비해 주세요.

**[공식 Neconyan 안내서를 읽어 보세요](https://platberlitz.github.io/neconyan-docs/).** 설치 방법이나 사용하면서 생긴 궁금증은 여기서부터 찾아보세요. 스크린샷이 들어간 가이드, 매크로 레퍼런스, 확장 기능 만드는 법도 담겨 있어요. 뭔가 제대로 작동하지 않는다면 이슈를 열기 전에 [문제 해결 가이드](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)부터 확인해 주세요.

모든 게 업스트림과 똑같이 작동하는 SillyTavern을 원한다면 대신 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny)를 쓰세요. 저는 업스트림에서 원하는 부분만 골라 가져오기 때문에, 여기서는 생김새나 동작이 다른 부분이 있고 일부 확장 기능은 작동하지 않을 수도 있어요.

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="왜 Neconyan일까요?">
</p>

- **자리를 비워도 멈추지 않아요.** 답변은 지켜보는 동안 브라우저에서 작성돼요. 그쪽이 더 빠르거든요. 1:1 채팅 도중에 다른 앱으로 넘어가거나 휴대폰을 잠가도, 서버가 답변을 받아 두었다가 그 채팅을 다시 열면 넘겨줘요. 비용을 두 번 낼 필요도 없고요. 대화, Meower, 기억 작업은 어차피 서버에서 계속 진행돼요. 답변 뒤에 실행되는 에이전트까지 계속 돌아가게 하고 싶다면 'Where replies are written'을 **On the server**로 설정하세요. 브라우저 안에서 돌리는 WebLLM 모델이나 Kokoro 음성처럼, 여전히 페이지를 열어 둬야 하는 기능도 몇 가지 있어요.
- **정말로 휴대폰에 맞춰 만들었어요.** 데스크톱 화면을 억지로 줄여 놓은 게 아니라, 이름이 제대로 붙은 탭과 하단 채팅 바, 옆으로 밀어 여는 메뉴가 있어요.
- **채팅하는 방법이 네 가지예요.** 클래식 역할극, 메신저 같은 대화, Meower라는 소셜 타임라인, 그리고 긴 글을 위한 스토리 모드가 있어요.
- **이야기를 기억해요.** [Mewmory](../docs/mewmory.md)가 이야기의 흐름과 지금까지 만난 NPC, 그들이 한 말을 기록해 두니까, 메시지가 200개쯤 쌓인 뒤에 모든 걸 다시 설명할 필요가 없어요.
- **좋은 기능은 처음부터 들어 있어요.** 에이전트, 채팅 아카이브, Quick Image Gen, Guided Generations, BotSearcher 등이 있고, 각각 따로 설정할 수 있어요. [원래 별도 프로젝트로 시작한 도구들과 만든 사람은 여기서 볼 수 있어요.](../docs/neconyan-native-tools.md)
- **메모해 둘 곳이 있어요.** [노트북](../docs/notebooks.md)에는 캐릭터 초안, 장소, 장면 계획, 세션 일지를 채팅 바로 옆에 적어 둘 수 있어요. 노트끼리, 그리고 로어북과도 서로 연결되고, 허락하면 어시스턴트가 노트를 편집할 수도 있어요.
- **작은 도우미들.** Miso, Taro, Nori는 도구 호출로 초상화가 있는 캐릭터를 만들고, 로어북을 편집하고, 프리셋이나 에이전트를 조정할 수 있어요. 짧은 첫 발자국 투어가 기본 사용법을 안내해 주고, [Simple Mode](#simple-mode)는 원할 때까지 고급 기능을 치워 둬요.
- **이야기를 함께 의논할 상대가 있어요.** [Scratchpad](../docs/scratchpad.md)는 이야기 옆에 붙은 사이드 채팅이에요. 어시스턴트나 내 캐릭터, 혹은 이들을 한자리에 모은 라운드테이블이 장면을 읽고 아이디어를 주는데, 그 내용은 채팅에 하나도 남지 않아요.
- **귀여워요.** Calico 테마, 메시지 위에서 낮잠 자는 고양이들, 홈 화면의 픽셀 고양이까지. 사실 애초에 이게 목적이었어요.
- **내 파일은 여전히 내 거예요.** SillyTavern과 같은 캐릭터 카드, 채팅, 로어북, 프리셋을 그대로 읽고, 텔레메트리도 전혀 없어요.

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="모드">
</p>

아래 화면은 기본 제공 어시스턴트들과 함께 연출한 데모 채팅, 노트, Scratchpad 답변이니 너무 깊게 의미를 두지는 마세요.

### 홈

처음 도착하는 곳이에요. 캐릭터를 고르거나, 임시 채팅을 시작하거나, 모델을 연결하거나, 어시스턴트 중 하나에게 인사해 보세요.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="데스크톱에서 본 홈"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="휴대폰에서 본 홈"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

여기에는 버튼이 정말 많지만, 첫날부터 그 대부분이 필요하지는 않아요. Simple Mode는 Mewmory, 채팅 아카이브, 확장, 모드 전환 메뉴, 미세 조정의 대부분, 그리고 메시지 입력창 주변의 추가 버튼을 숨기고 캐릭터, 연결, 프리셋, 로어북, 에이전트, 노트북, Scratchpad만 남겨 둬요. 첫 발자국 투어가 시작되기 전에 Nori가 이 모드를 쓸지 물어봐요. 꺼지는 건 하나도 없고 숨겨지기만 하니까, 전부 다시 보고 싶을 땐 언제든 사이드바에서 **Show all features**를 누르거나 설정 > 모양에서 끄면 돼요.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="데스크톱에서 Simple Mode를 켠 역할극 채팅"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="휴대폰에서 Simple Mode를 켠 역할극 채팅"></td>
  </tr>
</table>

### 역할극

SillyTavern에서 익숙한 바로 그 채팅이에요. 다만 메시지 위에서 고양이가 자고 있죠.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="데스크톱에서 본 역할극"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="휴대폰에서 본 역할극"></td>
  </tr>
</table>

### 대화

친구에게 메시지를 보내듯 캐릭터와 문자를 주고받아요. 친구 목록, 그룹 채팅, 분기가 있고, 캐릭터가 바쁘거나 오프라인일 때도 있어요.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="데스크톱에서 본 대화"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="휴대폰에서 본 대화"></td>
  </tr>
</table>

### Meower

캐릭터들이 글을 올리고, 서로 답글을 달고, 간식 투표를 여는 작은 소셜 타임라인이에요.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="데스크톱에서 본 Meower"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="휴대폰에서 본 Meower"></td>
  </tr>
</table>

### 스토리 모드

채팅을 하나로 이어지는 글로 바꿔 줘요. 말풍선을 넘겨 보기보다 이야기를 읽고 싶을 때 좋아요.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="데스크톱에서 본 스토리 모드"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="휴대폰에서 본 스토리 모드"></td>
  </tr>
</table>

### 노트북

채팅 바로 옆에 있는 노트예요. 어딘가의 텍스트 파일에 적어 두면 잃어버리기 쉬운 캐릭터 초안이나 장면 계획을 여기에 모아 두세요. 템플릿, 폴더, 속성, 읽기 화면이 있고, 채팅 옆에 나란히 열어 둘 수도 있어요. [노트북 더 알아보기.](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="데스크톱에서 본 노트북"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="휴대폰에서 본 노트북"></td>
  </tr>
</table>

### Scratchpad

이야기 옆에 붙어 있는 사이드 채팅으로, 캐릭터들이 듣지 않는 곳에서 장면 이야기를 하고 싶을 때 써요. Miso, Taro, Nori에게 물어보거나, 내 캐릭터 카드를 하나 복사하거나, 나만의 어시스턴트를 만든 다음, 최대 세 명을 라운드테이블에 앉혀 내 플롯 반전이 먹힐지 토론하게 해 보세요. 여기서 쓴 내용은 이야기에 전혀 들어가지 않아요. [Scratchpad 더 알아보기.](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="데스크톱에서 스토리 모드 채팅 옆에 연 Scratchpad"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="휴대폰에서 본 Scratchpad"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="시작하기">
</p>

내 환경에 맞는 방법을 고르세요.

| 가지고 있는 것 | 추천 방법 |
| --- | --- |
| Android 11 이상인 Android 휴대폰 | [Android 앱](#android-app) |
| 그보다 오래된 Android 휴대폰, 또는 터미널이 편하다면 | [Termux](#android-with-termux) |
| Windows, macOS 또는 Linux | [컴퓨터에 설치](#on-a-computer) |
| iOS 17 이상인 iPhone, 그리고 사이드로딩이 괜찮다면 | [iPhone 앱](#iphone-app) |
| 그 밖의 iPhone, 또는 채팅을 컴퓨터에 두고 싶다면 | 컴퓨터에 설치한 다음 [휴대폰에서 열기](#opening-it-on-your-phone) |

어떤 방법을 고르든 대화할 모델은 따로 있어야 해요. 제공업체에서 받은 API 키나, KoboldCpp, Ollama 같은 로컬 백엔드가 필요해요.

<a id="android-app"></a>

### Android 앱

Android 11 이상이라면 [최신 릴리스](https://github.com/platberlitz/Neconyan/releases/latest)에서 `-android-arm64.apk`로 끝나는 파일을 내려받아 여세요. 아마 그 전에 Android가 브라우저에서 앱을 설치하도록 허용할지 물어볼 거예요.

모든 게 휴대폰 안에서 돌아가니 Termux도 컴퓨터도 필요 없어요. 저장 공간을 2 GiB 정도 비워 두고, 처음 열 때는 압축을 푸는 동안 기다려 주세요. Android System WebView 124 이상도 필요한데, 설치된 버전이 너무 오래됐으면 앱이 알려 줘요. 업데이트할 때는 새 APK를 기존 앱 위에 설치하면 되고, 채팅은 그대로 남아요. [Android 설치, 백업, 빌드 방법 안내.](../android/README.md)

<a id="iphone-app"></a>

### iPhone 앱

이제 단독으로 돌아가는 iPhone 앱도 있어요. Android 앱과 같은 방식으로 서버, 채팅, 설정이 모두 휴대폰 안에 있어서 Neconyan을 실행할 컴퓨터가 필요 없어요. App Store에는 없으니 직접 사이드로딩해야 해요.

1. [릴리스 페이지](https://github.com/platberlitz/Neconyan/releases/latest)를 열고, 그 릴리스에 `-ios-unsigned.ipa`로 끝나는 파일이 있다면 내려받으세요. 없다면 대신 [브라우저로 쓰는 방법](#opening-it-on-your-phone)을 따라 주세요.
2. [iloader](https://github.com/nab138/iloader) 같은 사이드로딩 도구에서 그 파일을 고르세요. 도구가 내 Apple 계정으로 서명해서 설치해 줘요. iOS 17 이상이 필요해요.
3. Neconyan을 열고, 다른 기기에서와 마찬가지로 **연결**에서 모델을 연결하세요.

무료 Apple 계정은 7일마다 앱에 다시 서명해야 하고, 사이드로딩할 수 있는 앱도 세 개까지예요. 업데이트할 때는 같은 Apple 계정으로 새 IPA를 기존 앱 위에 설치하면 되고, 채팅은 그대로 남아요. 앱을 삭제하면 채팅도 함께 지워지니, 사이드로딩 도구를 바꿀 때는 먼저 계정 백업을 내보내 두세요.

다른 앱으로 넘어가거나 휴대폰을 잠가도 가져오기는 계속 진행돼요. 앱에 있는 **백업 ZIP 가져오기** 버튼으로 백업을 고르고 확인하면 그다음은 서버가 맡아요. 작업하는 동안 iOS가 앱을 멈추지 않도록 무음을 재생하고, 진행 상황은 아무 때나 다시 와서 확인하면 돼요. 답변도 데스크톱 브라우저 탭에서처럼 계속 진행돼요. 답변 도중에 앱을 벗어나면, 답변이 다 작성되어 저장되고 그 뒤의 에이전트까지 모두 실행될 때까지 페이지가 직접 무음을 재생해요. 그동안 잠금 화면에 'Neconyan is finishing a reply'가 보일 수 있고, 다른 앱에서 듣던 음악은 끝날 때까지 멈출 수 있어요. 그래도 휴대폰 메모리가 부족해지면 iOS가 앱을 닫을 수 있어요. 백업을 복사해 넣는 동안에는 백업 크기의 두 배 정도 공간을 비워 두세요. [iPhone 설치, 제한 사항, 빌드 방법 안내.](../ios/README.md)

<a id="on-a-computer"></a>

### 컴퓨터에서

1. **Neconyan 받기.** 방법은 두 가지이고, 두 번째 방법은 알아서 최신 상태를 유지해요.

   - **내려받기.** [최신 릴리스](https://github.com/platberlitz/Neconyan/releases/latest)에서 `-source.zip`으로 끝나는 파일을 받아, 문서 폴더처럼 찾기 쉬운 곳에 압축을 푸세요. Windows에서는 zip 파일 안에서 런처를 실행하면 작동하지 않으니, 먼저 zip 파일을 마우스 오른쪽 버튼으로 클릭하고 **모두 압축 풀기**를 선택하세요. 그러면 `Neconyan-1.3.7`처럼 버전 이름이 붙은 폴더가 생겨요.
   - **[Git](https://git-scm.com/downloads)으로 클론하기.** 폴더를 만들 위치에서 터미널을 열고 아래 줄을 실행하세요. 이렇게 하면 런처가 시작할 때마다 새 버전이 있는지 확인하고 열기 전에 업데이트해요. 그래서 저라면 이 방법을 쓸 거예요.

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **실행하기.** Neconyan 폴더를 열고 사용하는 시스템에 맞는 런처를 실행하세요.

   | 시스템 | 방법 |
   | --- | --- |
   | Windows | `Start.bat` 더블클릭 |
   | macOS | `Start.command` 더블클릭 |
   | Linux 또는 WSL | 폴더에서 터미널을 열고 `./start.sh` 실행 |

   처음 시작할 때는 몇 분 걸려요. Bun이나 Node.js(실제로 Neconyan을 돌리는 프로그램)가 없으면 런처가 Bun을 설치해 준 다음, Neconyan에 필요한 나머지를 모두 내려받아요. Neconyan을 쓰는 동안에는 그 창을 열어 두세요. 창을 닫거나 그 창에서 Ctrl+C를 누르면 Neconyan이 멈춰요.

3. **열기.** 브라우저가 저절로 열릴 거예요. 열리지 않으면 **http://127.0.0.1:4433/** 주소로 접속하세요.
4. **모델 연결하기.** 사이드바에서 **연결**을 클릭하고 제공업체와 모델을 고른 다음, API 키나 로컬 백엔드 주소를 붙여 넣으세요. 그다음 캐릭터를 가져오거나 홈에서 Miso, Taro, Nori에게 인사해 보세요.

다음부터는 같은 런처를 다시 실행하면 돼요.

**업데이트하기.** Git으로 설치했다면 시작할 때 알아서 업데이트돼요. zip으로 설치했다면 새 zip을 내려받아 새 폴더에 압축을 풀고, Neconyan을 닫은 다음, 기존 Neconyan 폴더의 `data` 폴더를 새 폴더로 복사하세요. `config.yaml`을 바꿨다면 그 파일도 함께 복사하세요. 새 버전을 실행해서 채팅이 그대로 있는지 확인한 뒤에 기존 폴더를 지우세요.

<a id="android-with-termux"></a>

### Termux로 Android에서 실행하기

[Termux](https://termux.dev/)는 Android용 터미널 앱이에요. 위의 앱보다 손이 더 가지만, 오래된 휴대폰에서도 작동해요.

1. [F-Droid](https://f-droid.org/packages/com.termux/)나 [Termux의 GitHub 릴리스](https://github.com/termux/termux-app/releases)에서 Termux를 설치하세요.
2. Termux를 열고 업데이트하세요. 설정 파일에 대해 물어보며 멈추면 Enter를 눌러 지금 파일을 그대로 두세요.

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Git을 설치한 다음 Termux 홈 폴더에 Neconyan을 내려받으세요. `--depth 1`은 프로젝트의 지난 기록을 건너뛰어서 내려받는 양이 줄어들고, 업데이트도 문제없이 돼요.

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. 실행하세요. 처음 시작할 때 Node.js를 비롯해 Neconyan에 필요한 모든 걸 설치하니 몇 분 기다려 주세요.

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. `Go to: http://127.0.0.1:4433/ to open Neconyan`이 보이면, 휴대폰의 Chrome이나 다른 브라우저에서 그 주소를 여세요. 그다음 컴퓨터에서와 마찬가지로 **연결**에서 모델을 연결하세요.

Termux에서 익혀 두면 좋은 습관 몇 가지:

- Neconyan을 멈추려면 추가 키 줄에서 **CTRL**을 누른 다음 **C**를 누르세요.
- 다음부터는 Termux를 열고 `cd ~/Neconyan && bash start.sh`를 다시 실행하세요. 시작하기 전에 알아서 업데이트해요.
- 폴더는 Termux 홈 폴더에 두세요. `/sdcard` 같은 공유 저장소에서는 런처가 실행을 거부해요. Neconyan의 패키지에 필요한 파일 링크를 Android가 그곳에서 막기 때문이에요.
- Chrome 메뉴에서 **홈 화면에 추가**를 누르면 Neconyan 전용 아이콘이 생겨요.

**백그라운드에서 계속 실행하기.** Android는 화면에 보이지 않는 앱을 멈추려고 하고, Termux도 예외가 아니에요. 아래 단계를 따르면 다른 앱을 쓰는 동안에도 Neconyan이 계속 살아 있어요.

1. 알림 창을 내려서 Termux 알림에 wake lock이 유지되고 있다고 나오는지 확인하세요. Neconyan이 시작할 때 요청하지만, 제대로 걸리지 않았다면 그 알림에서 **Acquire wakelock**을 누르세요.
2. Android **설정 → 앱 → Termux → 배터리**를 열고 **제한 없음**을 고르세요. 메뉴 이름은 휴대폰 제조사마다 다르니, 찾기 어렵다면 설정에서 '배터리 최적화'를 검색해 보세요.
3. Android 12 이상에서는 Termux가 시작한 추가 프로세스도 Android가 종료하는데, Neconyan도 그중 하나예요. Android 14 이상이라면 개발자 옵션을 켜고(**휴대전화 정보**에서 **빌드 번호**를 일곱 번 탭), **Disable child process restrictions**를 켜세요. Android 12와 13에는 이런 스위치가 없어서, `adb`와 USB 디버깅을 쓸 수 있는 컴퓨터에서 아래 두 명령을 한 번 실행해야 해요.

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

서버가 살아 있어도 시간이 지나면 Chrome이 페이지 자체를 메모리에서 내려 버릴 수 있어서, 돌아오면 Neconyan이 다시 로드돼요. 그게 거슬린다면 **설정 → 시스템 및 기기 → Memory and performance**에서 **Stay open in the background**를 켜세요. 자리를 비운 동안 들리지 않을 만큼 작은 소리를 재생해서, Chrome이 Neconyan을 음악 플레이어처럼 여기고 건드리지 않게 해요. 배터리를 좀 쓰고, 미디어 알림이 뜨고, 다른 앱에서 재생 중인 음악을 멈출 수 있어서 기본값은 꺼짐이에요. 아직 실제 휴대폰이 아니라 에뮬레이션한 휴대폰 브라우저에서만 테스트해 봤으니, 쓰고 있는 휴대폰에서 효과가 없다면 알려 주세요.

<a id="opening-it-on-your-phone"></a>

### 휴대폰에서 열기

컴퓨터에서 Neconyan을 실행하고 있다면, 두 기기가 같은 Wi-Fi에 연결되어 있는 한 휴대폰에서도 쓸 수 있어요. [iPhone 앱](#iphone-app)을 사이드로딩하고 싶지 않다면 iPhone에서도 이 방법을 쓰면 돼요.

두 브라우저는 같은 데이터를 써요. 오프라인 환경을 기기 사이에서 옮겨야 한다면, 폴더를 복사하거나 동기화하기 전에 GitHub 데이터 폴더 설정을 포함해 [기기 간 데이터 옮기기](../docs/data-portability.md)를 읽어 보세요.

1. Neconyan을 멈추고, Neconyan 폴더에 있는 `config.yaml`을 아무 텍스트 편집기로 여세요. 이 파일은 처음 실행한 뒤에 생겨요. `listen: false`를 `listen: true`로 바꾸세요.
2. 연 김에 비밀번호도 켜 두세요. 그러지 않으면 같은 Wi-Fi에 있는 누구나 열 수 있어요. `basicAuthMode: true`로 설정한 다음, `basicAuthUser` 아래의 `username`과 `password`를 바꾸세요.
3. Neconyan을 다시 시작하고 컴퓨터의 로컬 주소를 찾으세요.
   - **Windows:** 명령 프롬프트에서 `ipconfig`를 실행하고 **IPv4 주소**를 찾으세요.
   - **macOS:** Option 키를 누른 채 메뉴 막대의 Wi-Fi 아이콘을 클릭하고 **IP 주소**를 찾으세요.
   - **Linux:** `hostname -I`를 실행하세요.
4. 휴대폰 브라우저에 그 주소를 입력하되, 앞에 `http://`, 뒤에 `:4433`을 붙이세요. 예를 들면 `http://192.168.1.20:4433`처럼요.

Windows가 Bun이나 Node.js의 방화벽 통과를 허용할지 물어보면 개인 네트워크에서 허용하세요. 휴대폰에 **금지됨**이라고만 적힌 페이지가 뜬다면, 네트워크가 `10.`으로 시작하는 주소를 나눠 주고 있는 거예요. Neconyan은 이런 주소를 기본적으로 막아요. `config.yaml`의 `whitelist:` 아래에 다음 줄을 추가한 뒤 Neconyan을 다시 시작하세요.

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Node.js와 Bun 중에 고르기, 그 밖의 런처 옵션</b></summary>

직접 고르고 싶다면, 시스템마다 Node.js용과 Bun용 런처도 따로 있어요.

| 시스템 | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

직접 설치하려면 Node.js 20 이상이 필요해요.

```sh
npm install
npm run start:node
```

Bun 1.3.14 이상도 돼요. `bun install`을 실행한 다음 `bun run start`를 실행하거나, 메모리를 덜 쓰려면 `bun run start:mobile`을 실행하세요. 저장소의 `.npmrc` 파일은 그대로 두세요.

Git으로 설치한 버전이 스스로 업데이트하지 않게 하려면, 런처를 실행하기 전에 `NECONYAN_AUTO_UPDATE=0`을 설정하세요.

</details>

<details>
<summary><b>실행되지 않을 때</b></summary>

- **Windows에서 PC를 보호했다는 메시지가 뜰 때:** **추가 정보**를 클릭한 다음 **실행**을 클릭하세요. 인터넷에서 받은 런처는 대부분 이 메시지가 떠요.
- **macOS에서 확인되지 않은 개발자의 앱이라며 `Start.command`를 열어 주지 않을 때:** 마우스 오른쪽 버튼으로 클릭하고 **열기**를 선택하세요. 최신 macOS에서는 대신 **시스템 설정 → 개인정보 보호 및 보안**으로 가서 **그래도 열기**를 클릭하세요.
- **macOS나 Linux에서 런처를 실행할 수 없다고 나올 때:** Neconyan 폴더에서 이 명령을 실행하세요.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Git으로 설치한 버전이 더 이상 업데이트되지 않을 때:** Neconyan 자체 파일을 하나라도 수정하면 런처가 업데이트를 건너뛰고, 시작할 때 그 이유를 알려 줘요. 채팅과 `config.yaml`은 여기에 해당하지 않아요.
- **Android:** Termux에서는 Node.js가 기본이에요. Bun을 쓰려면 추가 패키지 두 개가 필요한데, Bun 런처가 대신 설치를 시도해요. 실패하면 직접 설치하세요.

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  glibc가 `$PREFIX/glibc`가 아닌 다른 곳에 있다면 `GLIBC_ROOT`를 설정하세요.

- **4433 포트를 이미 쓰고 있을 때:** `--port`로 다른 번호를 넘기거나, `config.yaml`에서 포트를 바꾸세요.

</details>

### SillyTavern이나 SillyBunny에서 넘어오셨나요?

캐릭터, 채팅, 로어북, 페르소나, 프리셋은 대부분 문제없이 넘어올 거예요. 하지만 전부 된다고 장담할 수는 없고, SillyTavern의 페이지 레이아웃에 의존하는 확장 기능은 손봐야 할 수도 있어요.

- **먼저 기존 설치본을 백업하고**, 모든 게 제대로 작동하는지 확인할 때까지 그 백업을 보관하세요.
- **Neconyan에는 따로 데이터 폴더를 마련해 주세요.** 두 앱이 같은 데이터 폴더를 가리키게 하면 절대 안 돼요.

Neconyan은 처음 실행할 때 자체 `config.yaml`과 `data/` 폴더를 만들어요. 개인 데이터, 키, 설치한 패키지는 절대 릴리스에 포함되지 않아요.

<details>
<summary><b>개발자용</b></summary>

`main`에는 릴리스 스냅샷이 있고, 실제 작업은 `staging`에서 이뤄져요. 테스트할 때는 별도의 체크아웃과 데이터 폴더를 써서 평소 채팅이 섞이지 않게 하세요.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

브라우저 테스트는 `tests/`에 있고, 테스트용으로 쓰고 버릴 서버를 대상으로 실행돼요. `NECONYAN_TEST_BASE_URL`을 그 서버 주소로 설정하세요(기본값은 `http://127.0.0.1:4433`). 테스트하기 전에 프런트엔드를 빌드하고, 다시 빌드한 뒤에는 서버를 재시작하세요. 임시 스크린샷, 테스트 보고서, 빌드 결과물, 로컬 런타임 폴더는 커밋에 넣지 않아요.

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="크레딧">
</p>

Neconyan은 SillyTavern과 SillyBunny를 만든 모든 분의 작업을 바탕으로 만들어졌어요. 그분들이 없었다면 이 모든 건 존재하지 않았을 거예요. 함께 들어 있는 도구와 그 도구가 나온 프로젝트는 [포함된 도구 목록](../docs/neconyan-native-tools.md)에 밝혀 두었어요.

[Platberlitz](https://github.com/platberlitz)가 만들었어요. [GNU AGPL v3](../LICENSE) 라이선스를 따르니, 재배포할 때는 고지 사항과 라이선스를 그대로 남겨 두세요.
