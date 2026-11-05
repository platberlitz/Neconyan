<!-- Translated from README.md at commit de66c177 (Neconyan 1.5.0). Keep the structure in step with the English README. -->

# Neconyan~

最新版本是 [1.5.0](https://github.com/platberlitz/Neconyan/releases/latest)。

**用你的语言阅读：** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [繁體中文](readme-zh_tw.md)

本译文可能更新不及时，[英文 README](../README.md) 才是最新的。

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - 最可爱的 LLM 角色扮演前端">
</p>

Neconyan 是我基于 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 和 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) 做的一个猫咪主题衍生版，用来在电脑或手机上和 AI 角色聊天、玩角色扮演。请自备 API 密钥或本地模型；应用本身不附带模型访问权限或额度。

**[下载 Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[阅读手册](https://platberlitz.github.io/neconyan-docs/)** · **[获取帮助](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> 这里的所有代码都由 LLM 生成或在 LLM 辅助下编写。Neconyan 自带的每一条提示词和每一个代理都出自人手。

## 这里有什么？

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="为什么选 Neconyan？">
</p>

- **四种聊天方式**：经典的角色扮演、即时通讯风格的对话、名为 Meower 的社交时间线，以及把聊天读成连贯叙述文字的故事模式。
- **专为手机设计的布局**，带有标注清楚的控件、底部聊天栏和侧滑菜单。**Simple Mode** 会把不常用的控件收起来，等你想用时再拿出来。
- **Mewmory** 会记住故事中的事件和角色。**代理**可以维护追踪器、检查回复，或者另外写一条“同伴备注”。
- **Catelier** 帮你编写角色卡和世界书。**笔记本**把你的笔记放在手边，**Scratchpad** 则给你一个独立的聊天，用来把想法聊透。
- **Miso、Taro 和 Nori** 帮你查找东西，经你允许后还能进行受支持的修改。
- **主题、强调色和猫**。猫多得很。你可以把它们藏起来，不过我实在想不通你为什么会想这么做。

你的角色卡、聊天记录、世界书和预设都沿用大家熟悉的 SillyTavern 格式。没有任何遥测。上游的部分功能和扩展在这里的行为有所不同；我只引入自己想要的那部分。[附带工具列表](../docs/neconyan-native-tools.md)中列出了随 Neconyan 一起打包的项目，并向它们致谢。

## 来看看

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="模式">
</p>

全新的桌面端和手机截图，用的是与内置助手的演示聊天和笔记。

### 主页

挑一个角色、连接一个模型，或者跟某位助手打个招呼。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="桌面端的主页"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="手机上的主页"></td>
</tr></table>

### 角色扮演

写一幕场景，试试另一条回复，或者接着之前的聊天继续。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="桌面端的角色扮演模式"></td>
  <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="手机上的角色扮演模式"></td>
</tr></table>

### Catelier

修改角色草稿，请求写作上的帮助，并在保存到你的资料库之前先检查改动。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-catelier.webp" alt="桌面端的 Catelier"></td>
  <td width="28%"><img src="../docs/readme/phone-catelier.webp" alt="手机上的 Catelier"></td>
</tr></table>

<details>
<summary><b>更多截图：Simple Mode、对话、Meower、故事模式、笔记本和 Scratchpad</b></summary>

### Simple Mode

刚上手时，控件会少一些。侧边栏里的 **Show all features** 可以把它们找回来；没有任何功能被关闭。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="桌面端的 Simple Mode"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="手机上的 Simple Mode"></td>
</tr></table>

### 对话

给你的角色发消息、建群聊，也可以让他们处于忙碌或离线状态。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="桌面端的对话模式"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="手机上的对话模式"></td>
</tr></table>

### Meower

一条社交时间线，你的角色会在上面发帖、回复和发起投票。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="桌面端的 Meower"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="手机上的 Meower"></td>
</tr></table>

### 故事模式

把聊天当作连贯的叙述文字来读。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="桌面端的故事模式"></td>
  <td width="28%"><img src="../docs/readme/phone-story.webp" alt="手机上的故事模式"></td>
</tr></table>

### 笔记本

把场景规划、地点和会话日志放在聊天旁边。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="桌面端的笔记本"></td>
  <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="手机上的笔记本"></td>
</tr></table>

### Scratchpad

和一位助手，或者围坐圆桌讨论的一群角色，一起聊聊故事，而且他们的讨论不会进入主聊天。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="桌面端的 Scratchpad"></td>
  <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="手机上的 Scratchpad"></td>
</tr></table>

</details>

## 开始使用

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="快速上手">
</p>

### 在电脑上

1. 从[最新发布页](https://github.com/platberlitz/Neconyan/releases/latest)下载以 **-source.zip** 结尾的文件。请先解压；在 Windows 上，右键单击并选择 **Extract All**。
2. 打开文件夹。在 Windows 上运行 **Start.bat**，在 macOS 上运行 **Start.command**，在 Linux 上则在终端中运行 **bash start.sh**。
3. 第一次启动需要几分钟来安装所需的东西，请耐心等待。使用 Neconyan 期间请保持终端窗口打开。
4. 你的浏览器应该会自动打开。否则，请访问 **http://127.0.0.1:4433/** 这个地址。
5. 打开 **链接**，选择你的提供商和模型，并输入你的 API 密钥或本地模型的地址。然后在主页上打开一个角色或一位助手。

下次运行同一个启动器就行。要停止 Neconyan，请在它的终端里按 **Ctrl+C**。

想用 Git 的话，请克隆这个仓库，然后使用同一个启动器：

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[电脑端的安装设置和常见启动问题](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Android 应用

从[最新发布页](https://github.com/platberlitz/Neconyan/releases/latest)下载 **-android-arm64.apk** 文件并打开。如果 Android 询问，请允许从浏览器安装应用。你需要 **Android 11 或更新版本**、**Android System WebView 124 或更新版本**，以及大约 **2 GiB** 的可用空间。

这个应用直接在手机上运行，不需要 Termux，也不需要电脑。第一次打开时请给它一些时间解包，然后设置 **链接**。更新时请直接覆盖安装到现有的应用上，聊天记录就会保留。

[Android 安装设置](https://platberlitz.github.io/neconyan-docs/start/android/) · [构建说明](../android/README.md)

### iPhone 应用

从[最新发布页](https://github.com/platberlitz/Neconyan/releases/latest)下载 **-ios-unsigned.ipa** 文件，然后用 [iloader](https://github.com/nab138/iloader) 这类侧载工具安装。你需要 **iOS 17 或更新版本**。这个应用把服务器和聊天记录都放在手机上；它没有上架 App Store。

免费的 Apple 账户每七天需要重新签名一次，而且最多只能侧载三个应用。更新时，请用同一个 Apple 账户覆盖安装到现有的应用上。**删除应用会连同数据一起删除**，所以请先导出备份。

[iPhone 安装设置和限制](../ios/README.md)

### 在手机上使用的其他方式

- **在 Android 上使用 Termux**：如果你更喜欢用终端，或者手机比较旧，请参照 [Termux 指南](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux)。
- **使用电脑上已安装的 Neconyan**：请参照[同一 Wi-Fi 指南](https://platberlitz.github.io/neconyan-docs/start/phone/)。两台设备使用同一份已保存的聊天记录，电脑需要保持运行。

## 更新、备份与迁移聊天记录

打开 **服务器 → 更新与重启 → 检查更新**。用 Git 安装的版本和受支持的源码 ZIP 安装版会提供 **更新并重启**。Android 会提供 **Update APK**，并请你批准安装。没有更新器的旧版 ZIP 副本需要[手动迁移到较新的文件夹](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation)。

用 Git 安装的版本在启动时也会检查更新。你对应用自身文件所做的改动可能会阻止自动更新；你的聊天记录和设置不算在内。

从 SillyTavern 或 SillyBunny 迁移过来？**请先备份**，给 Neconyan 单独准备一个数据文件夹，然后按照[导入你的数据](https://platberlitz.github.io/neconyan-docs/start/imports/)操作。在删除任何东西之前，先检查你的角色和聊天记录。有些扩展可能需要调整。

[备份与恢复](https://platberlitz.github.io/neconyan-docs/help/backups/) · [在设备之间迁移数据](../docs/data-portability.md)

## 需要帮助？

我会先从[手册](https://platberlitz.github.io/neconyan-docs/)看起，或者去主页问问 Miso、Taro 或 Nori。他们也可能出错，所以在做出无法撤销的改动之前，请先核实他们的建议。

找不到某项设置时，可以试试侧边栏里的 **搜索**。遇到错误时，请查看[故障排除指南](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)，或者[提交 issue](https://github.com/platberlitz/Neconyan/issues)，说明你当时在做什么以及显示的错误信息。

## 致谢

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="致谢">
</p>

Neconyan 建立在 SillyTavern 和 SillyBunny 背后每一个人的工作之上；没有他们，就不会有这一切。[附带工具列表](../docs/neconyan-native-tools.md)中注明了他们的原作者。

由 [Platberlitz](https://github.com/platberlitz) 制作。采用 [GNU AGPL v3](../LICENSE) 许可证。如果你再分发它，请保留其中的声明和许可证。
