<!-- Translated from README.md at commit de66c177 (Neconyan 1.5.0). Keep the structure in step with the English README. -->

# Neconyan~

最新版本是 [1.5.0](https://github.com/platberlitz/Neconyan/releases/latest)。

**用你的語言閱讀：** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md)

這份翻譯可能會跟不上更新，[英文 README](../README.md) 才是最新的。

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - 最可愛的 LLM 角色扮演前端">
</p>

Neconyan 是我以 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 和 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) 為基礎做的貓咪主題分支版本，用來和 AI 角色聊天、玩角色扮演，電腦和手機都能用。請自備 API 金鑰或本機模型，因為這個 App 本身不附帶任何模型使用權或額度。

**[下載 Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[閱讀使用手冊](https://platberlitz.github.io/neconyan-docs/)** · **[取得協助](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> 這裡所有的程式碼都是由 LLM 生成或在 LLM 協助下寫成的，但 Neconyan 內附的每一個提示詞和代理，都是由人親手寫的。

## 這裡有什麼？

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="為什麼選 Neconyan？">
</p>

- **四種聊天方式**：經典的角色扮演、通訊軟體風格的對話、叫做 Meower 的社群動態，以及把聊天讀成連貫文章的故事模式。
- **專為手機設計的版面**，有文字標示的按鈕、底部聊天列和滑出式選單。**Simple Mode** 會先把比較少用到的按鈕收起來，等你想用時再拿出來。
- **Mewmory** 會記住故事裡發生的事件和出現過的角色。**代理** 可以維護追蹤器、檢查回覆，或另外寫一則「同伴備註」。
- **Catelier** 協助你撰寫角色卡和知識庫。**筆記本** 讓你把筆記放在手邊，**Scratchpad** 則提供一個獨立的聊天，讓你把點子討論清楚。
- **Miso、Taro 和 Nori** 能幫你找東西，也能在你允許後，進行它們支援的修改。
- **主題、強調色和貓咪**。貓咪還真不少。你可以把牠們藏起來，不過我實在想不通你為什麼會想這麼做。

你的角色卡、聊天、知識庫和預設設定檔，都沿用你熟悉的 SillyTavern 格式。這裡沒有遙測。有些上游的功能和擴充功能在這裡的行為不太一樣；我只會把我想要的部分拉進來。[內附工具清單](../docs/neconyan-native-tools.md)向 Neconyan 內附的各個專案致謝。

## 先來看看

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="模式">
</p>

以下是全新的電腦版和手機版截圖，內容是和內建助手一起做的示範聊天和筆記。

### 首頁

選一個角色、連接模型，或跟助手打聲招呼。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="電腦上的首頁"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="手機上的首頁"></td>
</tr></table>

### 角色扮演

寫一段場景、換個回覆試試，或是接續一個舊的聊天。

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

<details>
<summary><b>更多截圖：Simple Mode、對話、Meower、故事模式、筆記本和 Scratchpad</b></summary>

### Simple Mode

在你適應之前，先讓按鈕少一點。按側邊欄的 **Show all features** 就能全部找回來；沒有任何東西被停用。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="電腦上的 Simple Mode"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="手機上的 Simple Mode"></td>
</tr></table>

### 對話

用傳訊息的方式跟你的角色聊天、建立群組聊天，也可以讓角色處於忙碌或離線狀態。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="電腦上的對話"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="手機上的對話"></td>
</tr></table>

### Meower

一個社群動態，你的角色會在上面發文、回覆和發起投票。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="電腦上的 Meower"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="手機上的 Meower"></td>
</tr></table>

### 故事模式

把你的聊天當成連貫的文章來閱讀。

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

</details>

## 開始使用

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="開始使用">
</p>

### 在電腦上

1. 從[最新發行版本](https://github.com/platberlitz/Neconyan/releases/latest)下載檔名結尾是 **-source.zip** 的檔案。請先把它解壓縮；在 Windows 上，請按右鍵並選擇 **Extract All**。
2. 打開資料夾。在 Windows 上執行 **Start.bat**，在 macOS 上執行 **Start.command**，在 Linux 上則在終端機中執行 **bash start.sh**。
3. 第一次啟動需要幾分鐘來安裝所需的東西，請給它一點時間。使用 Neconyan 時，請讓終端機視窗保持開啟。
4. 瀏覽器應該會自動開啟。如果沒有，請前往 **http://127.0.0.1:4433/**
5. 打開 **連接**，選擇你的供應商和模型，然後輸入 API 金鑰或本機模型的位址。接著在首頁打開一個角色或助手。

下次只要執行同一個啟動器就好。要停止 Neconyan，請在它的終端機中按 **Ctrl+C**。

比較喜歡用 Git 的話，請 clone 儲存庫，再使用同一個啟動器：

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[電腦安裝設定與常見的啟動問題](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Android 版 App

從[最新發行版本](https://github.com/platberlitz/Neconyan/releases/latest)下載 **-android-arm64.apk** 並開啟它。如果 Android 詢問，請允許從瀏覽器安裝。你需要 **Android 11 或更新版本**、**Android System WebView 124 或更新版本**，以及大約 **2 GiB** 的可用空間。

這個 App 直接在手機上執行，不需要 Termux，也不需要電腦。第一次開啟時請給它一點時間解壓縮，然後設定 **連接**。更新時，請直接安裝在現有的 App 上，你的聊天就會保留。

[Android 安裝設定](https://platberlitz.github.io/neconyan-docs/start/android/) · [建置說明](../android/README.md)

### iPhone 版 App

從[最新發行版本](https://github.com/platberlitz/Neconyan/releases/latest)下載 **-ios-unsigned.ipa**，再用 [iloader](https://github.com/nab138/iloader) 這類側載工具安裝。你需要 **iOS 17 或更新版本**。這個 App 的伺服器和聊天都存放在手機上；它沒有上架 App Store。

免費的 Apple 帳號每七天就得重新簽署一次這個 App，而且最多只能側載三個 App。更新時，請用同一個 Apple 帳號直接安裝在現有的 App 上。**刪除 App 就會刪除它的資料**，所以請先匯出備份。

[iPhone 安裝設定與限制](../ios/README.md)

### 用手機的其他方式

- **在 Android 上使用 Termux**：如果你偏好用終端機，或手機比較舊，請參考 [Termux 指南](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux)。
- **使用電腦上已安裝的版本**：請參考[同一個 Wi-Fi 的指南](https://platberlitz.github.io/neconyan-docs/start/phone/)。兩部裝置會使用同一份已儲存的聊天，請讓電腦保持執行。

## 更新、備份和搬移你的聊天

打開 **伺服器 → 更新與重啟 → 檢查更新**。用 Git 安裝的版本，以及支援的原始碼 ZIP 安裝版本，會提供 **更新並重啟**。Android 版會提供 **Update APK**，並要求你同意安裝。沒有更新功能的舊版 ZIP 副本，則需要[手動搬到較新的資料夾](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation)。

用 Git 安裝的版本在啟動時也會檢查更新。如果你修改過 App 本身的檔案，可能會讓自動更新無法進行；你的聊天和設定不算在內。

從 SillyTavern 或 SillyBunny 過來的嗎？**請先備份**，讓 Neconyan 使用自己的 data 資料夾，再依照[匯入你的資料](https://platberlitz.github.io/neconyan-docs/start/imports/)操作。在刪除任何東西之前，請先檢查你的角色和聊天。有些擴充功能可能需要調整。

[備份與還原](https://platberlitz.github.io/neconyan-docs/help/backups/) · [在裝置之間搬移資料](../docs/data-portability.md)

## 需要幫忙嗎？

我建議先看看[使用手冊](https://platberlitz.github.io/neconyan-docs/)，或是到首頁問 Miso、Taro 或 Nori。它們可能會出錯，所以在做出無法復原的更動之前，請先確認它們的建議。

找不到某項設定時，可以試試側邊欄的 **搜尋**。遇到錯誤時，請參考[疑難排解指南](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)，或[回報問題](https://github.com/platberlitz/Neconyan/issues)，並附上你當時正在做的事和顯示的錯誤訊息。

## 致謝

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="致謝">
</p>

Neconyan 建立在 SillyTavern 和 SillyBunny 背後每一個人的心血之上；沒有他們，就不會有這一切。[內附工具清單](../docs/neconyan-native-tools.md)向這些專案的原作者致謝。

由 [Platberlitz](https://github.com/platberlitz) 製作。以 [GNU AGPL v3](../LICENSE) 授權。如果你要重新散布，請保留其中的聲明和授權條款。
