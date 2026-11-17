<!-- Translated from README.md at commit 31d628fa (Neconyan 1.5.5). Keep the structure in step with the English README. -->

# Neconyan~

最新版本是 [1.5.5](https://github.com/platberlitz/Neconyan/releases/tag/v1.5.5)。

**用你的语言阅读：** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [繁體中文](readme-zh_tw.md)

本译文可能更新不及时，[英文 README](../README.md) 才是最新的。

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - 最可爱的 LLM 角色扮演前端">
</p>

你好，欢迎光临！Neconyan 是我基于 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 和 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) 做的一个猫咪主题衍生版，用来在电脑或手机上和 AI 角色聊天、玩角色扮演。我做它，是因为我想要一个用起来舒服、在手机上也能好好运行、而且几乎每一页都有猫的前端。请自备 API 密钥或本地模型；应用本身不附带模型访问权限或额度。

**[下载 Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[阅读手册](https://platberlitz.github.io/neconyan-docs/)** · **[获取帮助](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> 这里的所有代码都由 LLM 生成或在 LLM 辅助下编写。Neconyan 自带的每一条提示词和每一个智能体都出自人手。

## 这里有什么？

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="为什么选 Neconyan？">
</p>

- **四种聊天方式**：经典的角色扮演、即时通讯风格的对话、名为 Meower 的社交时间线，以及把聊天读成连贯叙述文字的故事模式。看心情随便挑。
- **专为手机设计的布局**，带有标注清楚的控件、底部聊天栏和侧滑菜单。不用再在小屏幕上眯着眼找桌面版的小按钮。
- **[简易模式](#简易模式)**，给只想好好玩角色扮演、不想面对驾驶舱那么多按钮的你。下面还会详细介绍，因为我真的超级得意。
- **Mewmory** 会记住故事中的事件和角色，让你的搭档不会忘掉重要的细节。**智能体** 可以维护追踪器、检查回复，或者另外写一条“同伴备注”。
- **Catelier** 帮你编写角色卡和世界书。**笔记本** 把你的笔记放在手边，**Scratchpad** 则给你一个独立的聊天，用来把想法聊透。
- **Miso、Taro 和 Nori** 是常驻在这里的助手。他们帮你查找东西，经你允许后还能进行受支持的修改。
- **设备同步** 可以通过加密文件、WebDAV、私密 GitHub Gist 或直接配对，在彼此独立的安装之间转移选定的数据。只有在你要求时才会进行传输。
- **主题、强调色和猫**。猫多得很。你可以把它们藏起来，不过我实在想不通你为什么会想这么做。

你的角色卡、聊天记录、世界书和预设都沿用大家熟悉的 SillyTavern 格式，所以都能直接带过来。没有任何遥测。上游的部分功能和扩展在这里的行为有所不同；我只引入自己想要的那部分。[附带工具列表](../docs/neconyan-native-tools.md)中列出了随 Neconyan 一起打包的项目，并向它们致谢。

## 简易模式

<p align="center">
  <img src="../docs/readme/banner-simple-mode.webp" alt="简易模式？！">
</p>

对高级玩家那一套不感兴趣？只想好好玩角色扮演、开开心心，却不想在成堆的按钮里翻来翻去？那我这儿正好有个最适合你的模式！

**简易模式** 是给只想玩 RP 的人准备的 Neconyan。让 Neconyan 之所以是 *Neconyan* 的一切都还在：猫咪、对手机友好的布局、Miso、Taro 和 Nori、帮你记住故事的记忆，还有在后台继续干活的智能体。去掉的只是那些杂乱的东西：采样器、提示词格式、token 计数器、扩展菜单，以及其他大多数人从来不碰的各种旋钮。

最棒的是：没有任何东西被删除或关闭。每个隐藏的控件只是收起来了，并没有扔掉，你想用的那一刻就会马上回来。

### 上手简单得不能再简单

第一次打开时，Nori 只会问一个问题：**Want to keep things simple?** 按下 **Yes, keep it simple**，一个三步导览就会带你完成连接模型、认识角色和打招呼。就这样，整个设置就完成了。

已经在用完整布局了？随时可以在 **设置 → 外观 → 简易模式** 里打开它。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple-ask.webp" alt="新账户的桌面端上，Nori 在问“Want to keep things simple?”"></td>
  <td width="28%"><img src="../docs/readme/phone-simple-ask.webp" alt="手机上，Nori 在问“Want to keep things simple?”"></td>
</tr></table>

### 聊天才是主角

聊天和输入框占据了大部分空间，侧边栏只留下你真正会打开的几个页面：人物、连接、智能体、世界书、笔记本、Scratchpad、画廊、预设、用户设定和对话颜色。除此之外，你还会得到三个好用的按钮：

- **Find characters** 用来搜索新的角色卡。选中一个，它的聊天就会立刻打开，随时可以开始。
- **记忆** 会打开 **Story so far**，里面有一个开关、一个 **Summarise now** 按钮，以及这段聊天的最新摘要。
- **Updates** 会检查新版本并直接安装，不用离开简易模式。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple-chat.webp" alt="桌面端简易模式下的角色扮演聊天，侧边栏更短"></td>
  <td width="28%"><img src="../docs/readme/phone-simple-menu.webp" alt="手机上更短的简易模式菜单，有记忆、Updates 和显示全部功能"></td>
</tr></table>

### 连接不用做功课

连接页面只显示提供商、你的密钥、模型、**连接** 和 **发送测试消息**。其他所有选项都等在 **More connection options** 后面，留给你好奇的那一天。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="桌面端的简易模式，显示更短的连接页面"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="手机上的简易模式，显示更短的连接页面"></td>
</tr></table>

### 改主意了？没问题

按下侧边栏里的 **显示全部功能**，或者在 **设置 → 外观** 里把它关掉，所有按钮就会立刻回到你原来放的位置。你的聊天、角色、世界书和智能体都不会察觉到任何变化。

[手册中的简易模式](https://platberlitz.github.io/neconyan-docs/workspace/#keep-the-sidebar-simple)

## 来看看

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="模式">
</p>

接下来是剩下的导览！这些桌面端和手机截图是我在 2026 年 11 月 17 日截的，用的是与内置助手的演示聊天和笔记、默认的 Calico Dark 配色，并把 **背景可见性** 调到了 0%。

### 主页

挑一个角色、连接一个模型，或者跟某位助手打个招呼。猫咪们见到你会超开心的。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="桌面端的主页"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="手机上的主页"></td>
</tr></table>

### 角色扮演

写一幕场景，试试另一条回复，或者从之前的聊天停下的地方接着继续。

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

### 智能体

挑一个帮手，决定它何时运行，再给它接上一个连接。我建议先只用一个，别一下子把智能体库里的一半都打开。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-agents.webp" alt="桌面端的智能体，显示回复帮手及其控件"></td>
  <td width="28%"><img src="../docs/readme/phone-agents.webp" alt="手机上的智能体"></td>
</tr></table>

### 生成后的 Proofreader

Proofreader 会在回复送达之后检查它。它可以润色文字和格式，而不必让主模型把这一幕重写一遍。打开 **智能体变更** 就能对比修改内容；如果你更喜欢原文，还可以撤销。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-proofreader.webp" alt="桌面端的 Proofreader 更改历史，对比原回复与修改后的版本"></td>
  <td width="28%"><img src="../docs/readme/phone-proofreader.webp" alt="手机上的 Proofreader 更改历史"></td>
</tr></table>

这个搭建出来的示例用固定的示例回复运行真实的智能体流程。平时使用时，由你连接的模型来写这些修改，而且每一轮都可能多产生一次请求。[手册中的智能体与同伴](https://platberlitz.github.io/neconyan-docs/helpers/agents/)。

<details>
<summary><b>更多截图：对话、Meower、故事模式、笔记本、Scratchpad 和设备同步</b></summary>

### 对话

给你的角色发消息、建群聊，也可以让他们处于忙碌或离线状态，就像真正的朋友一样。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="桌面端的对话模式"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="手机上的对话模式"></td>
</tr></table>

### Meower

一条社交时间线，你的角色会在上面发帖、回复和发起投票。那里常常热闹得一团乱，但乱得恰到好处。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="桌面端的 Meower"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="手机上的 Meower"></td>
</tr></table>

### 故事模式

把聊天当作连贯的叙述文字来读，就像一本你们一起写的书。

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

### 设备同步

在彼此独立的安装之间转移选定的资料库。可以选择加密文件、WebDAV、私密 GitHub Gist 或直接配对；传输会在你要求时才开始。[手册中的设置与恢复](https://platberlitz.github.io/neconyan-docs/help/device-sync/)。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-device-sync.webp" alt="桌面端的设备同步设置"></td>
  <td width="28%"><img src="../docs/readme/phone-device-sync.webp" alt="手机上的设备同步设置"></td>
</tr></table>

</details>

## 开始使用

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="快速上手">
</p>

准备好试一试了吗？选一台你想用的设备吧。

### 在电脑上

1. 从[最新发布页](https://github.com/platberlitz/Neconyan/releases/latest)下载以 **-source.zip** 结尾的文件。请先解压；在 Windows 上，右键单击并选择 **Extract All**。
2. 打开文件夹。在 Windows 上运行 **Start.bat**，在 macOS 上运行 **Start.command**，在 Linux 上则在终端中运行 **bash start.sh**。
3. 第一次启动需要几分钟来安装所需的东西，请耐心等待。使用 Neconyan 期间请保持终端窗口打开。
4. 你的浏览器应该会自动打开。否则，请访问 **http://127.0.0.1:4433/** 这个地址。
5. 打开 **连接**，选择你的提供商和模型，并输入你的 API 密钥或本地模型的地址。然后在主页上打开一个角色或一位助手，就可以出发啦！

下次运行同一个启动器就行。要停止 Neconyan，请在它的终端里按 **Ctrl+C**。

想用 Git 的话，请克隆这个仓库，然后使用同一个启动器：

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[电脑端的安装设置和常见启动问题](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Android 应用

从[最新发布页](https://github.com/platberlitz/Neconyan/releases/latest)下载 **-android-arm64.apk** 文件并打开。如果 Android 询问，请允许从浏览器安装应用。你需要 **Android 11 或更新版本**、**Android System WebView 124 或更新版本**，以及大约 **2 GiB** 的可用空间。

这个应用就在手机本机上运行，不需要 Termux，也不需要电脑。第一次打开时请给它一些时间解包，然后设置 **连接**。更新时请直接覆盖安装到现有的应用上，聊天记录就会保留。

[Android 安装设置](https://platberlitz.github.io/neconyan-docs/start/android/) · [构建说明](../android/README.md)

### iPhone 应用

从[最新发布页](https://github.com/platberlitz/Neconyan/releases/latest)下载 **-ios-unsigned.ipa** 文件，然后用 [iloader](https://github.com/nab138/iloader) 这类侧载工具安装。你需要 **iOS 17 或更新版本**。这个应用把服务器和聊天记录都放在手机上；它没有上架 App Store。

免费的 Apple 账户每七天需要重新签名一次，而且最多只能侧载三个应用。更新时，请用同一个 Apple 账户覆盖安装到现有的应用上。**删除应用会连同数据一起删除**，所以请先导出备份。

[iPhone 安装设置和限制](../ios/README.md)

### 在手机上使用的其他方式

- **在 Android 上使用 Termux**：如果你更喜欢用终端，或者手机比较旧，请参照 [Termux 指南](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux)。
- **使用电脑上已安装的 Neconyan**：请参照[同一 Wi-Fi 指南](https://platberlitz.github.io/neconyan-docs/start/phone/)。两台设备使用同一份已保存的聊天记录，电脑需要保持运行。

## 更新、备份与迁移聊天记录

打开 **服务器 → 更新与重启 → 检查更新**。用 Git 安装的版本和受支持的源码 ZIP 安装版会提供 **更新并重启**。Android 会提供 **Update APK**，并请你批准安装。在简易模式下，侧边栏里的 **Updates** 按钮也能带你到同一个地方。没有更新器的旧版 ZIP 副本需要[手动迁移到较新的文件夹](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation)。

用 Git 安装的版本在启动时也会检查更新。你对应用自身文件所做的改动可能会阻止自动更新；你的聊天记录和设置不算在内。

从 SillyTavern 或 SillyBunny 迁移过来？欢迎！**请先备份**，给 Neconyan 单独准备一个数据文件夹，然后按照[导入你的数据](https://platberlitz.github.io/neconyan-docs/start/imports/)操作。在删除任何东西之前，先检查你的角色和聊天记录。有些扩展可能需要调整。

[备份与恢复](https://platberlitz.github.io/neconyan-docs/help/backups/) · [在设备之间迁移数据](../docs/data-portability.md)

## 需要帮助？

我会先从[手册](https://platberlitz.github.io/neconyan-docs/)看起，或者去主页问问 Miso、Taro 或 Nori；他们随时都乐意帮忙。不过他们也可能出错，所以在做出无法撤销的改动之前，请先核实他们的建议。

找不到某项设置时，可以试试侧边栏里的 **搜索**。遇到错误时，请查看[故障排除指南](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)，或者[提交 issue](https://github.com/platberlitz/Neconyan/issues)，说明你当时在做什么以及显示的错误信息。

## 致谢

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="致谢">
</p>

Neconyan 建立在 SillyTavern 和 SillyBunny 背后每一个人的工作之上；没有他们，就不会有这一切。[附带工具列表](../docs/neconyan-native-tools.md)中注明了他们的原作者。

由 [Platberlitz](https://github.com/platberlitz) 用爱制作。采用 [GNU AGPL v3](../LICENSE) 许可证。如果你再分发它，请保留其中的声明和许可证。

特别感谢 **El Topo**，我最主要的帮手和贡献者。你为 Neconyan 付出的所有心血，我都由衷感激。

玩得开心，替我向猫咪们问声好！
