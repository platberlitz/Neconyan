<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

最新版本：**[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**。開發工作會繼續在 `staging` 上進行。

**其他語言：** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md)

這是[英文 README](../README.md) 的翻譯版本。如果兩者內容有出入，英文版才是最新的。

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - 最可愛的 LLM 角色扮演前端">
</p>

> [!NOTE]
> 這裡所有的程式碼都是由 LLM 生成或在 LLM 協助下寫成的，但 Neconyan 內附的每一個提示詞和代理，都是由人親手寫的。

Neconyan 是我以 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 和 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) 為基礎做的貓咪主題分支版本，用來和 AI 角色聊天、玩角色扮演，電腦和手機都能用。模型要你自己準備，可以是本機後端，也可以是 API 金鑰，因為它本身不附帶任何模型使用權或額度。

**[閱讀 Neconyan 官方使用手冊](https://platberlitz.github.io/neconyan-docs/)**。安裝設定和使用上的問題，都可以先從那裡找起。裡面有附截圖的教學、巨集參考，以及製作擴充功能的說明。如果有東西不能用，開 issue 之前請先看看[疑難排解指南](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)。

如果你想要所有功能都和上游一模一樣的 SillyTavern，請改用 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny)。我只會把我想要的上游部分拉進來，所以這裡有些東西的外觀和行為不太一樣，有些擴充功能也可能無法使用。

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="為什麼選 Neconyan？">
</p>

- **你離開了，它也不會停**。回覆是在瀏覽器裡生成的，你可以當場看著它寫出來，因為這樣比較快。如果你在一對一聊天回覆到一半時切換 App 或鎖上手機，伺服器會把這則回覆留著，等你重新打開那個聊天時再交給你，不用再付一次錢。對話、Meower 和記憶相關的工作，本來就會在伺服器上繼續進行。如果你也想讓回覆後的代理繼續執行，把「Where replies are written」設為 **On the server**。還是有少數功能需要讓頁面保持開啟，例如在瀏覽器內執行的 WebLLM 模型和 Kokoro 語音。
- **真的是為手機設計的**。有清楚標示的分頁、底部聊天列和滑出式選單，而不是把電腦版的版面硬擠進小螢幕。
- **四種聊天方式**。經典的角色扮演、通訊軟體風格的對話、叫做 Meower 的社群動態，以及適合長篇寫作的故事模式。
- **故事記憶**。[Mewmory](../docs/mewmory.md) 會記住你的故事、你遇過的 NPC 和他們說過的話，這樣聊到第 200 則訊息時，你也不必把所有事情再解釋一遍。
- **好用的東西都內建好了**。代理、聊天封存、Quick Image Gen、Guided Generations、BotSearcher，還有其他幾個，每一個都有自己的設定。[這裡列出了原本是獨立專案的那幾個，以及它們的作者。](../docs/neconyan-native-tools.md)
- **有地方寫筆記**。[筆記本](../docs/notebooks.md)就在聊天旁邊，讓你放角色草稿、地點、場景規劃和每次遊玩的日誌。筆記之間可以互相連結，也能連到你的知識庫；只要你允許，助手也可以幫你編輯。
- **小幫手**。Miso、Taro 和 Nori 可以透過工具呼叫建立附頭像的角色、編輯知識庫，以及調整預設設定檔或代理。簡短的初次探索導覽會帶你認識基本操作，[Simple Mode](#simple-mode) 則會先把進階功能收起來，等你想用時再拿出來。
- **有人陪你討論劇情**。[Scratchpad](../docs/scratchpad.md) 是放在故事旁邊的側邊聊天，助手、你自己的角色，甚至是一整張圓桌的角色，都可以讀這段場景並給你點子，而這些內容都不會跑進聊天裡。
- **很可愛**。三花貓主題、在你的訊息上打盹的貓咪，還有首頁上的像素貓。說真的，這本來就是重點。
- **你的檔案還是你的**。它讀取的角色卡、聊天、知識庫和預設設定檔都跟 SillyTavern 一樣，而且完全沒有遙測。

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="模式">
</p>

以下都是和內建助手一起演出的示範聊天、筆記和 Scratchpad 回覆，所以別把內容看得太認真。

### 首頁

一進來就會看到這裡。你可以選角色、開始臨時聊天、連接模型，或跟其中一位助手打聲招呼。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="電腦上的首頁"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="手機上的首頁"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

這裡的按鈕很多，而其中大部分你第一天都用不到。Simple Mode 會把 Mewmory、聊天封存、擴充功能、模式切換器、大部分的微調選項，以及訊息框周圍的額外按鈕收起來，只留下角色、連接、預設設定檔、知識庫、代理、筆記本和 Scratchpad。在初次探索導覽開始之前，Nori 會先問你要不要開啟它。它不會關閉任何東西，只是先藏起來，所以隨時想把所有功能找回來，只要按側邊欄的 **Show all features**，或在「設定 > 外觀」裡把它關掉就好。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="電腦上開啟 Simple Mode 的角色扮演聊天"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="手機上開啟 Simple Mode 的角色扮演聊天"></td>
  </tr>
</table>

### 角色扮演

你在 SillyTavern 就熟悉的經典聊天，只是多了一隻睡在你訊息上的貓。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="電腦上的角色扮演"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="手機上的角色扮演"></td>
  </tr>
</table>

### 對話

像傳訊息給朋友一樣，跟你的角色聊天。這裡有好友列表、群組聊天、分支，角色也可能正在忙或已經離線。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="電腦上的對話"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="手機上的對話"></td>
  </tr>
</table>

### Meower

一個小小的社群動態，你的角色會在上面發文、互相回覆，還會發起關於零食的投票。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="電腦上的 Meower"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="手機上的 Meower"></td>
  </tr>
</table>

### 故事模式

把聊天變成連貫的文章，適合比起滑過一個個對話泡泡，更想讀一篇故事的時候。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="電腦上的故事模式"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="手機上的故事模式"></td>
  </tr>
</table>

### 筆記本

一本就放在聊天旁邊的筆記本，用來收那些不然就會被你丟進某個文字檔、然後再也找不到的角色草稿和場景規劃。它有範本、資料夾、屬性和閱讀檢視，也可以開在聊天旁邊。[進一步了解筆記本。](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="電腦上的筆記本"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="手機上的筆記本"></td>
  </tr>
</table>

### Scratchpad

一個放在故事旁邊的側邊聊天，讓你可以討論場景，又不會被角色聽到。你可以問 Miso、Taro 或 Nori，複製一張你自己的角色卡，或打造專屬的助手，然後讓最多三位坐上圓桌，爭論你的劇情轉折到底成不成功。你在那裡寫的任何內容都不會進到故事裡。[進一步了解 Scratchpad。](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="電腦上故事模式聊天旁的 Scratchpad"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="手機上的 Scratchpad"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="開始使用">
</p>

看你手邊有什麼，選最適合的方式：

| 你手上有 | 建議選擇 |
| --- | --- |
| Android 11 或更新版本的 Android 手機 | [Android 版 App](#android-app) |
| 較舊的 Android 手機，或你喜歡用終端機 | [Termux](#android-with-termux) |
| Windows、macOS 或 Linux | [在電腦上安裝](#on-a-computer) |
| iOS 17 或更新版本的 iPhone，而且你不介意側載 | [iPhone 版 App](#iphone-app) |
| 其他 iPhone，或你比較想把聊天留在電腦上 | 在電腦上安裝，再[用手機開啟](#opening-it-on-your-phone) |

不管你選哪一種，都還需要一個可以對話的模型：向供應商取得的 API 金鑰，或是 KoboldCpp、Ollama 這類本機後端。

<a id="android-app"></a>

### Android 版 App

在 Android 11 或更新版本上，從[最新發行版本](https://github.com/platberlitz/Neconyan/releases/latest)下載檔名結尾是 `-android-arm64.apk` 的檔案，然後開啟它。Android 可能會先要求你允許從瀏覽器安裝應用程式。

所有東西都在手機上執行，所以不需要 Termux，也不需要電腦。請預留大約 2 GiB 的空間，第一次開啟時也要給它一點時間解壓縮。它還需要 Android System WebView 124 或更新版本，如果你的版本太舊，App 會告訴你。要更新時，直接把新的 APK 安裝在舊版上，你的聊天都會保留。[Android 的安裝設定、備份和建置說明。](../android/README.md)

<a id="iphone-app"></a>

### iPhone 版 App

現在也有獨立的 iPhone App 了。概念跟 Android 版一樣：伺服器、你的聊天和設定全都放在手機上，所以不需要另外開一台電腦來執行 Neconyan。它沒有上架 App Store，所以你得自己側載。

1. 打開[發行頁面](https://github.com/platberlitz/Neconyan/releases/latest)，如果那個版本有提供檔名結尾是 `-ios-unsigned.ipa` 的檔案，就下載它。如果沒有，請改用[瀏覽器的方式](#opening-it-on-your-phone)。
2. 在 [iloader](https://github.com/nab138/iloader) 這類側載工具中選取它。工具會用你的 Apple 帳號簽署並安裝。你需要 iOS 17 或更新版本。
3. 打開 Neconyan，從 **連接** 連接模型，跟其他平台一樣。

免費的 Apple 帳號每七天就得重新簽署一次 App，而且最多只能側載三個 App。要更新時，用同一個 Apple 帳號把新的 IPA 安裝在舊版上，你的聊天都會保留。刪除 App 會連聊天一起刪掉，所以如果你要換側載工具，請先匯出帳號備份。

切換 App 或鎖上手機時，匯入也會繼續進行。用 App 本身的 **匯入備份 ZIP** 按鈕選取備份並確認，之後就交給伺服器處理。它在處理時會播放無聲的音訊，讓 iOS 不會把它凍結，你隨時都可以回來看看進度。回覆也會繼續生成，就跟在電腦瀏覽器的分頁裡一樣：如果你在回覆到一半時離開，頁面會自己播放無聲的音訊，直到回覆寫完、儲存好，而且之後的代理都執行完畢為止。這段期間，你可能會在鎖定畫面上看到「Neconyan is finishing a reply」，其他 App 正在播放的音樂也可能會暫停到它完成為止。如果手機記憶體不足，iOS 還是可能會關閉 App。把備份複製進來的時候，請預留大約是備份兩倍大小的可用空間。[iPhone 的安裝設定、限制和建置說明。](../ios/README.md)

<a id="on-a-computer"></a>

### 在電腦上

1. **取得 Neconyan**。有兩種方式，第二種會自動保持最新。

   - **直接下載**。從[最新發行版本](https://github.com/platberlitz/Neconyan/releases/latest)下載檔名結尾是 `-source.zip` 的檔案，解壓縮到容易找到的地方，例如「文件」資料夾。在 Windows 上，請先在 zip 檔上按右鍵並選擇 **解壓縮全部**，因為直接在 zip 裡執行啟動器是行不通的。最後你會得到一個以版本命名的資料夾，例如 `Neconyan-1.3.7`。
   - **用 [Git](https://git-scm.com/downloads) clone 下來**。在你想放資料夾的位置開啟終端機，執行下面這行。之後每次啟動，啟動器都會檢查有沒有新版本，並在開啟前先更新，這也是我推薦這種方式的原因。

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **啟動它**。打開 Neconyan 資料夾，執行適合你系統的啟動器。

   | 系統 | 方法 |
   | --- | --- |
   | Windows | 按兩下 `Start.bat` |
   | macOS | 按兩下 `Start.command` |
   | Linux 或 WSL | 在該資料夾開啟終端機，執行 `./start.sh` |

   第一次啟動需要幾分鐘。如果你沒有 Bun 或 Node.js（實際負責執行 Neconyan 的程式），啟動器會幫你安裝 Bun，再下載 Neconyan 需要的其他所有東西。使用 Neconyan 時，請讓那個視窗保持開啟；關掉它，或在裡面按 Ctrl+C，Neconyan 就會停止。

3. **開啟它**。瀏覽器應該會自動打開。如果沒有，請前往 **<http://127.0.0.1:4433/>**。
4. **連接模型**。點側邊欄的 **連接**，選擇你的供應商和模型，然後貼上 API 金鑰或本機後端的位址。完成後，就可以匯入角色，或在首頁跟 Miso、Taro 或 Nori 打聲招呼。

下次只要再執行同一個啟動器就好。

**更新**。用 Git 安裝的版本會在啟動時自動更新。如果是 zip 版，請下載新的 zip 並解壓縮到新的資料夾，關閉 Neconyan，再把舊 Neconyan 資料夾裡的 `data` 資料夾複製到新資料夾；如果你改過 `config.yaml`，也一起複製過去。啟動新版本，確認聊天都還在之後，再刪除舊資料夾。

<a id="android-with-termux"></a>

### 在 Android 上使用 Termux

[Termux](https://termux.dev/) 是 Android 上的終端機 App。它比上面的 App 麻煩一點，但在較舊的手機上也能用。

1. 從 [F-Droid](https://f-droid.org/packages/com.termux/) 或[它的 GitHub 發行頁面](https://github.com/termux/termux-app/releases)安裝 Termux。
2. 打開 Termux 並更新。如果它停下來問你設定檔要怎麼處理，按 Enter 保留目前的版本。

   ```sh
   pkg update && pkg upgrade -y
   ```

3. 安裝 Git，然後把 Neconyan 下載到你的 Termux 主目錄。`--depth 1` 會略過專案的舊歷史紀錄，所以下載量比較小，而且照樣可以更新。

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. 啟動它。第一次啟動會安裝 Node.js 和 Neconyan 需要的其他所有東西，所以請給它幾分鐘。

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. 看到 `Go to: http://127.0.0.1:4433/ to open Neconyan` 時，用手機上的 Chrome 或任何其他瀏覽器開啟那個位址。接著從 **連接** 連接模型，跟在電腦上一樣。

幾個值得養成的 Termux 習慣：

- 要停止 Neconyan，請點額外按鍵列上的 **CTRL**，再點 **C**。
- 下次打開 Termux 後，再執行一次 `cd ~/Neconyan && bash start.sh`。它會在啟動前自動更新。
- 把資料夾放在 Termux 主目錄裡。啟動器不會從 `/sdcard` 這類共用儲存空間執行，因為 Android 在那裡會封鎖 Neconyan 的套件需要的檔案連結。
- 在 Chrome 的選單中點 **加到主畫面**，Neconyan 就會有自己的圖示。

**讓它在背景持續執行**。Android 很愛停掉你沒在看的 App，Termux 也不例外。下面這些步驟能讓你在用其他 App 時，Neconyan 依然保持運作：

1. 拉下通知欄，確認 Termux 的通知顯示已取得 wake lock。Neconyan 啟動時會要求取得它；如果沒有成功，請點通知上的 **Acquire wakelock**。
2. 打開 Android 的 **設定 → 應用程式 → Termux → 電池**，選擇 **不受限制**。各家手機品牌的選項位置和名稱不太一樣，找不到的話，可以在設定裡搜尋「電池最佳化」。
3. 在 Android 12 或更新版本上，Android 也會終止 Termux 啟動的額外程序，而 Neconyan 就是其中之一。在 Android 14 以上，先開啟開發人員選項（在 **關於手機** 裡點 **版本號碼** 七次），再開啟 **Disable child process restrictions**。Android 12 和 13 沒有這個開關，所以你得從一台有 `adb`、並已啟用 USB 偵錯的電腦，執行下面兩個指令一次：

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

即使伺服器還活著，Chrome 過一段時間後還是可能自行卸載頁面，所以你回來時 Neconyan 會重新載入。如果這讓你很困擾，可以在 **設定 → 系統與裝置 → Memory and performance** 開啟 **Stay open in the background**。你不在的時候，它會播放一段小到聽不見的聲音，讓 Chrome 把 Neconyan 當成音樂播放器，不去動它。它會多耗一些電、顯示媒體通知，還可能讓其他 App 正在播放的音樂暫停，所以預設是關閉的。到目前為止，我只在模擬的手機瀏覽器上測試過，還沒在真正的手機上試過，所以如果你的手機不理它，請告訴我。

<a id="opening-it-on-your-phone"></a>

### 在手機上開啟

如果 Neconyan 在你的電腦上執行，只要手機和電腦連的是同一個 Wi-Fi，手機也能使用它。如果你不想側載 [iPhone 版 App](#iphone-app)，在 iPhone 上也建議用這個方式。

兩邊的瀏覽器用的是同一份資料。如果你是想在不同裝置之間搬移離線使用的環境，請在複製或同步資料夾之前，先閱讀[在裝置之間搬移資料](../docs/data-portability.md)，包括其中用 GitHub 同步資料夾的設定方式。

1. 停止 Neconyan，用任何文字編輯器開啟 Neconyan 資料夾裡的 `config.yaml`。這個檔案會在第一次啟動後出現。把 `listen: false` 改成 `listen: true`。
2. 趁著打開這個檔案，順便設定密碼，否則同一個 Wi-Fi 上的任何人都能開啟它。設定 `basicAuthMode: true`，然後修改 `basicAuthUser` 底下的 `username` 和 `password`。
3. 再次啟動 Neconyan，然後找出你電腦的區域網路位址。
   - **Windows：** 在命令提示字元中執行 `ipconfig`，找到 **IPv4 位址**。
   - **macOS：** 按住 Option 鍵並點選選單列中的 Wi-Fi 圖示，找到 **IP 位址**。
   - **Linux：** 執行 `hostname -I`。
4. 在手機的瀏覽器輸入那個位址，前面加上 `http://`，後面加上 `:4433`，例如 `http://192.168.1.20:4433`。

如果 Windows 問你是否要讓 Bun 或 Node.js 通過防火牆，請允許它在私人網路上通過。如果手機顯示的頁面只寫著 **禁止**，代表你的網路分配的位址是以 `10.` 開頭，而 Neconyan 預設會封鎖這類位址。請在 `config.yaml` 的 `whitelist:` 底下加入這一行，然後重新啟動 Neconyan：

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>選擇 Node.js 或 Bun，以及其他啟動器選項</b></summary>

如果你想自己選，每個系統也都有各自的 Node.js 和 Bun 啟動器：

| 系統 | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android（Termux） | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

要手動安裝的話，你需要 Node.js 20 或更新版本：

```sh
npm install
npm run start:node
```

Bun 1.3.14 或更新版本也可以：執行 `bun install`，然後執行 `bun run start`，想減少記憶體用量的話，則執行 `bun run start:mobile`。請讓儲存庫裡的 `.npmrc` 檔案保持原樣。

如果不想讓用 Git 安裝的版本自動更新，請在執行啟動器之前設定 `NECONYAN_AUTO_UPDATE=0`。

</details>

<details>
<summary><b>如果無法啟動</b></summary>

- **Windows 說它已保護你的電腦：** 點 **其他資訊**，再點 **仍要執行**。大部分下載來的啟動器都會出現這個訊息。
- **macOS 因為 `Start.command` 來自未識別的開發者而不肯打開：** 在它上面按右鍵，選擇 **打開**。在較新版本的 macOS 上，請改到 **系統設定 → 隱私權與安全性**，點 **Open Anyway**。
- **macOS 或 Linux 說啟動器不是可執行檔：** 在 Neconyan 資料夾中執行這個指令。

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **用 Git 安裝的版本不再更新了：** 如果你修改過任何 Neconyan 本身的檔案，啟動器就會略過更新，並在啟動時說明原因。你的聊天和 `config.yaml` 不算在內。
- **Android：** Termux 預設使用 Node.js。Bun 需要兩個額外的套件，Bun 啟動器會試著幫你安裝。如果安裝失敗，請自己安裝：

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  如果你的 glibc 不在 `$PREFIX/glibc`，請設定 `GLIBC_ROOT`。

- **4433 連接埠已被佔用：** 用 `--port` 指定其他號碼，或在 `config.yaml` 裡修改連接埠。

</details>

### 從 SillyTavern 或 SillyBunny 過來的嗎？

你大部分的角色、聊天、知識庫、人設和預設設定檔應該都能順利搬過來，但我沒辦法保證每一樣都沒問題，而依賴 SillyTavern 頁面版面的擴充功能可能需要修正。

- **先備份你原本的安裝**，並保留那份備份，直到你確認一切都正常為止。
- **讓 Neconyan 使用自己的 data 資料夾**。千萬不要讓兩個 App 指向同一個 data 資料夾。

Neconyan 第一次執行時，會建立自己的 `config.yaml` 和 `data/` 資料夾。你的個人資料、金鑰和已安裝的套件，永遠不會包含在發行版本裡。

<details>
<summary><b>給開發者</b></summary>

`main` 存放發行版本的快照，`staging` 則是平常開發的地方。測試時請使用另一份 checkout 和另一個 data 資料夾，這樣你平常的聊天就不會被牽扯進去。

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

瀏覽器測試放在 `tests/`，會對一個用完即丟的伺服器執行：把 `NECONYAN_TEST_BASE_URL` 設為它的位址（預設是 `http://127.0.0.1:4433`）。測試前先建置前端，重新建置後要重新啟動伺服器。暫存的截圖、測試報告、建置輸出和本機執行階段資料夾，一律不放進 commit。

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="致謝">
</p>

Neconyan 建立在 SillyTavern 和 SillyBunny 背後每一個人的心血之上；沒有他們，就不會有這一切。內建工具和它們出身的專案，都在[內附工具清單](../docs/neconyan-native-tools.md)中列出致謝。

由 [Platberlitz](https://github.com/platberlitz) 製作。以 [GNU AGPL v3](../LICENSE) 授權，所以如果你要重新散布，請保留其中的聲明和授權條款。
