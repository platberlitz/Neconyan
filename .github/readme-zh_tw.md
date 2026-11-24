<!-- Translated from README.md at commit 31d628fa (Neconyan 1.5.5). Keep the structure in step with the English README. -->

# Neconyan~

最新版本是 [1.5.5](https://github.com/platberlitz/Neconyan/releases/tag/v1.5.5)。

**用你的語言閱讀：** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Türkçe](readme-tr_tr.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md)

這份翻譯可能會跟不上更新，[英文 README](../README.md) 才是最新的。

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - 最可愛的 LLM 角色扮演前端">
</p>

嗨，歡迎光臨！Neconyan 是我以 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 和 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) 為基礎做的貓咪主題分支版本，用來和 AI 角色聊天、玩角色扮演，電腦和手機都能用。我會做它，是因為我想要一個用起來舒服、在手機上也能好好運作，而且幾乎每一頁都有貓咪的前端。請自備 API 金鑰或本機模型，因為這個 App 本身不附帶任何模型使用權或額度。

**[下載 Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[閱讀使用手冊](https://platberlitz.github.io/neconyan-docs/)** · **[取得協助](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> 這裡所有的程式碼都是由 LLM 生成或在 LLM 協助下寫成的，但 Neconyan 內附的每一個提示詞和代理，都是由人親手寫的。

## 這裡有什麼？

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="為什麼選 Neconyan？">
</p>

- **四種聊天方式**：經典的角色扮演、通訊軟體風格的對話、叫做 Meower 的社群動態，以及把聊天讀成連貫文章的故事模式。看當下的心情挑一個就好。
- **專為手機設計的版面**，有文字標示的按鈕、底部聊天列和滑出式選單。不必在小螢幕上瞇著眼睛找電腦版的小按鈕。
- **[簡易模式](#簡易模式)**，給只想好好玩角色扮演、不想面對駕駛艙那麼多按鈕的你。下面會再詳細介紹，因為我真的超得意的。
- **Mewmory** 會記住故事裡發生的事件和出現過的角色，讓你的搭檔不會忘記重要的細節。**代理** 可以維護追蹤器、檢查回覆，或另外寫一則「夥伴備註」。
- **Catelier** 協助你撰寫角色卡和知識庫。**筆記本** 讓你把筆記放在手邊，**Scratchpad** 則提供一個獨立的聊天，讓你把點子討論清楚。
- **Miso、Taro 和 Nori** 是常駐在這裡的助手。它們能幫你找東西，也能在你允許後，進行它們支援的修改。
- **裝置同步** 能用加密檔案、WebDAV、私密 GitHub Gist 或直接配對，在各自獨立的安裝之間移動你選好的資料。傳輸只會在你要求時才進行。
- **主題、強調色和貓咪**。貓咪還真不少。你可以把牠們藏起來，不過我實在想不通你為什麼會想這麼做。

你的角色卡、聊天、知識庫和預設設定檔，都沿用你熟悉的 SillyTavern 格式，所以都能直接帶過來。這裡沒有遙測。有些上游的功能和擴充功能在這裡的行為不太一樣；我只會把我想要的部分拉進來。[內附工具清單](../docs/neconyan-native-tools.md)向 Neconyan 內附的各個專案致謝。

## 簡易模式

<p align="center">
  <img src="../docs/readme/banner-simple-mode.webp" alt="簡易模式？！">
</p>

對進階玩家那一套沒興趣？只想好好玩角色扮演、開開心心，卻不想在一大堆按鈕裡翻來翻去？那我這裡剛好有最適合你的模式！

**簡易模式** 是給只想玩 RP 的人用的 Neconyan。讓 Neconyan 之所以是 *Neconyan* 的一切都還在：貓咪、對手機友善的版面、Miso、Taro 和 Nori、幫你記住故事的記憶，還有在背景繼續工作的代理。拿掉的只有那些雜亂的東西：取樣器、提示詞格式、token 計數器、擴充功能選單，還有其他大多數人從來不碰的各種旋鈕。

最棒的是：沒有任何東西被刪除或關閉。每個隱藏的按鈕都只是收起來，不是丟掉，你想用的那一刻就會馬上回來。

### 上手簡單到不行

第一次來的時候，Nori 只會問一個問題：**Want to keep things simple?** 按下 **Yes, keep it simple**，三個步驟的導覽就會帶你連接模型、認識角色、打聲招呼。就這樣，整個設定就完成了。

已經在用完整版面了嗎？隨時都能在 **設定 → 外觀 → 簡易模式** 裡打開它。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple-ask.webp" alt="新帳號的電腦上，Nori 正在問「Want to keep things simple?」"></td>
  <td width="28%"><img src="../docs/readme/phone-simple-ask.webp" alt="手機上，Nori 正在問「Want to keep things simple?」"></td>
</tr></table>

### 聊天才是主角

聊天和輸入框佔了大部分空間，側邊欄只留下你真的會打開的幾個頁面：角色、連線、代理、知識庫、筆記本、Scratchpad、圖庫、預設設定檔、使用者角色和對話色彩。除此之外，還有三個好用的按鈕：

- **Find characters** 用來搜尋新的角色卡。選一個，它的聊天就會馬上打開，隨時可以開始。
- **記憶** 會打開 **Story so far**，裡面有一個開關、一個 **Summarise now** 按鈕，還有這段聊天的最新摘要。
- **Updates** 會檢查新版本並直接安裝，不必離開簡易模式。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple-chat.webp" alt="電腦上簡易模式的角色扮演聊天，側邊欄變短了"></td>
  <td width="28%"><img src="../docs/readme/phone-simple-menu.webp" alt="手機上變短的簡易模式選單，有記憶、Updates 和顯示所有功能"></td>
</tr></table>

### 連線不必做功課

連線頁面只會顯示供應商、你的金鑰、模型、**連線** 和 **測試訊息**。其他的一切都在 **More connection options** 後面，等你哪天好奇了再說。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="電腦上的簡易模式，顯示變短的連線頁面"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="手機上的簡易模式，顯示變短的連線頁面"></td>
</tr></table>

### 改變主意了？沒問題

按側邊欄的 **顯示所有功能**，或在 **設定 → 外觀** 裡把它關掉，所有按鈕就會馬上回到你原本放的地方。你的聊天、角色、知識庫和代理完全不會察覺。

[手冊中的簡易模式](https://platberlitz.github.io/neconyan-docs/workspace/#keep-the-sidebar-simple)

## 先來看看

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="模式">
</p>

接下來是其餘的導覽！這些電腦版和手機版截圖是我在 2026 年 11 月 17 日拍的，內容是和內建助手一起做的示範聊天和筆記，使用預設的 Calico Dark 配色，並把 **背景可見性** 設為 0%。

### 首頁

選一個角色、連接模型，或跟助手打聲招呼。貓咪們看到你一定超開心。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="電腦上的首頁"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="手機上的首頁"></td>
</tr></table>

### 角色扮演

寫一段場景、換個回覆試試，或是從舊的聊天上次停下的地方接著繼續。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="電腦上的角色扮演"></td>
  <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="手機上的角色扮演"></td>
</tr></table>

### Catelier

處理角色草稿、尋求寫作上的協助，並在儲存到你的收藏庫之前先檢視修改。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-catelier.webp" alt="電腦上的 Catelier"></td>
  <td width="28%"><img src="../docs/readme/phone-catelier.webp" alt="手機上的 Catelier"></td>
</tr></table>

### 代理

選一個幫手、決定它什麼時候執行，再給它一個連線。我建議先從一個開始，不要一次打開代理庫裡的一半。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-agents.webp" alt="電腦上的代理，顯示回覆幫手和它們的控制項"></td>
  <td width="28%"><img src="../docs/readme/phone-agents.webp" alt="手機上的代理"></td>
</tr></table>

### 生成後的 Proofreader

Proofreader 會在回覆送達之後檢查它。它可以整理文字和格式，而不必叫主要模型把場景重寫一遍。開啟 **Agent 變更** 就能比較修改前後的內容；如果你比較喜歡原版，也可以復原。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-proofreader.webp" alt="電腦上的 Proofreader 變更記錄，比較原始回覆和修改後的版本"></td>
  <td width="28%"><img src="../docs/readme/phone-proofreader.webp" alt="手機上的 Proofreader 變更記錄"></td>
</tr></table>

這個預先安排的示範，是用固定的範例回應來執行真正的代理工作流程。正常使用時，修改是由你連接的模型來寫，而且每一輪都可能多花一次請求。[手冊中的代理與夥伴](https://platberlitz.github.io/neconyan-docs/helpers/agents/)。

<details>
<summary><b>更多截圖：對話、Meower、故事模式、筆記本、Scratchpad 和裝置同步</b></summary>

### 對話

用傳訊息的方式跟你的角色聊天、建立群組聊天，也可以讓角色處於忙碌或離線狀態，就像真正的朋友一樣。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="電腦上的對話"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="手機上的對話"></td>
</tr></table>

### Meower

一個社群動態，你的角色會在上面發文、回覆和發起投票。裡面常常熱鬧到一團亂，但亂得剛剛好。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="電腦上的 Meower"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="手機上的 Meower"></td>
</tr></table>

### 故事模式

把你的聊天當成連貫的文章來閱讀，就像一本你們一起寫的書。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="電腦上的故事模式"></td>
  <td width="28%"><img src="../docs/readme/phone-story.webp" alt="手機上的故事模式"></td>
</tr></table>

### 筆記本

把場景規劃、地點和每次遊玩的日誌，放在聊天旁邊。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="電腦上的筆記本"></td>
  <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="手機上的筆記本"></td>
</tr></table>

### Scratchpad

跟一位助手，或圍坐在圓桌旁的一群角色，一起討論這個故事，而且他們的討論不會被加進主要聊天裡。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="電腦上的 Scratchpad"></td>
  <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="手機上的 Scratchpad"></td>
</tr></table>

### 裝置同步

把選好的收藏庫，在各自獨立的安裝之間移動。你可以選擇加密檔案、WebDAV、私密 GitHub Gist 或直接配對；傳輸會在你要求時才開始。[手冊中的設定與復原](https://platberlitz.github.io/neconyan-docs/help/device-sync/)。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-device-sync.webp" alt="電腦上的裝置同步設定"></td>
  <td width="28%"><img src="../docs/readme/phone-device-sync.webp" alt="手機上的裝置同步設定"></td>
</tr></table>

</details>

## 開始使用

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="開始使用">
</p>

準備好試試看了嗎？選一部你想用的裝置吧。

### 在電腦上

1. 從[最新發行版本](https://github.com/platberlitz/Neconyan/releases/latest)下載檔名結尾是 **-source.zip** 的檔案。請先把它解壓縮；在 Windows 上，請按右鍵並選擇 **Extract All**。
2. 打開資料夾。在 Windows 上執行 **Start.bat**，在 macOS 上執行 **Start.command**，在 Linux 上則在終端機中執行 **bash start.sh**。
3. 第一次啟動需要幾分鐘來安裝所需的東西，請給它一點時間。使用 Neconyan 時，請讓終端機視窗保持開啟。
4. 瀏覽器應該會自動開啟。如果沒有，請前往 **http://127.0.0.1:4433/**
5. 打開 **連線**，選擇你的供應商和模型，然後輸入 API 金鑰或本機模型的位址。接著在首頁打開一個角色或助手，就可以出發囉！

下次只要執行同一個啟動器就好。要停止 Neconyan，請在它的終端機中按 **Ctrl+C**。

比較喜歡用 Git 的話，請 clone 儲存庫，再使用同一個啟動器：

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[電腦安裝設定與常見的啟動問題](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Android 版 App

從[最新發行版本](https://github.com/platberlitz/Neconyan/releases/latest)下載 **-android-arm64.apk** 並開啟它。如果 Android 詢問，請允許從瀏覽器安裝。你需要 **Android 11 或更新版本**、**Android System WebView 124 或更新版本**，以及大約 **2 GiB** 的可用空間。

這個 App 直接在手機本身上執行，不需要 Termux，也不需要電腦。第一次開啟時請給它一點時間解壓縮，然後設定 **連線**。更新時，請直接安裝在現有的 App 上，你的聊天就會保留。

[Android 安裝設定](https://platberlitz.github.io/neconyan-docs/start/android/) · [建置說明](../android/README.md)

### iPhone 版 App

從[最新發行版本](https://github.com/platberlitz/Neconyan/releases/latest)下載 **-ios-unsigned.ipa**，再用 [iloader](https://github.com/nab138/iloader) 這類側載工具安裝。你需要 **iOS 17 或更新版本**。這個 App 的伺服器和聊天都存放在手機上；它沒有上架 App Store。

免費的 Apple 帳號每七天就得重新簽署一次這個 App，而且最多只能側載三個 App。更新時，請用同一個 Apple 帳號直接安裝在現有的 App 上。**刪除 App 就會刪除它的資料**，所以請先匯出備份。

[iPhone 安裝設定與限制](../ios/README.md)

### 用手機的其他方式

- **在 Android 上使用 Termux**：如果你偏好用終端機，或手機比較舊，請參考 [Termux 指南](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux)。
- **使用電腦上已安裝的版本**：請參考[同一個 Wi-Fi 的指南](https://platberlitz.github.io/neconyan-docs/start/phone/)。兩部裝置會使用同一份已儲存的聊天，請讓電腦保持執行。

## 更新、備份和搬移你的聊天

打開 **伺服器 → 更新與重啟 → 檢查更新**。用 Git 安裝的版本，以及支援的原始碼 ZIP 安裝版本，會提供 **更新並重啟**。Android 版會提供 **Update APK**，並要求你同意安裝。在簡易模式下，側邊欄的 **Updates** 按鈕也會帶你到同一個地方。沒有更新功能的舊版 ZIP 副本，則需要[手動搬到較新的資料夾](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation)。

用 Git 安裝的版本在啟動時也會檢查更新。如果你修改過 App 本身的檔案，可能會讓自動更新無法進行；你的聊天和設定不算在內。

從 SillyTavern 或 SillyBunny 過來的嗎？歡迎！**請先備份**，讓 Neconyan 使用自己的 data 資料夾，再依照[匯入你的資料](https://platberlitz.github.io/neconyan-docs/start/imports/)操作。在刪除任何東西之前，請先檢查你的角色和聊天。有些擴充功能可能需要調整。

[備份與還原](https://platberlitz.github.io/neconyan-docs/help/backups/) · [在裝置之間搬移資料](../docs/data-portability.md)

## 需要幫忙嗎？

我建議先看看[使用手冊](https://platberlitz.github.io/neconyan-docs/)，或是到首頁問 Miso、Taro 或 Nori；它們隨時都很樂意幫忙。不過它們也可能會出錯，所以在做出無法復原的更動之前，請先確認它們的建議。

找不到某項設定時，可以試試側邊欄的 **搜尋**。遇到錯誤時，請參考[疑難排解指南](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)，或[回報問題](https://github.com/platberlitz/Neconyan/issues)，並附上你當時正在做的事和顯示的錯誤訊息。

## 致謝

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="致謝">
</p>

Neconyan 建立在 SillyTavern 和 SillyBunny 背後每一個人的心血之上；沒有他們，就不會有這一切。[內附工具清單](../docs/neconyan-native-tools.md)向這些專案的原作者致謝。

由 [Platberlitz](https://github.com/platberlitz) 用愛製作。以 [GNU AGPL v3](../LICENSE) 授權。如果你要重新散布，請保留其中的聲明和授權條款。

特別感謝 **El Topo**，我最主要的幫手和貢獻者。你為 Neconyan 付出的每一分心力，我都由衷感激。

玩得開心，也幫我跟貓咪們打聲招呼！
