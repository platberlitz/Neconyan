<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

最新版本：**[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**。开发工作仍在 `staging` 分支上进行。

**其他语言：** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [繁體中文](readme-zh_tw.md)

本文译自[英文 README](../README.md)。两者如有出入，以英文版为准。

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - 最可爱的 LLM 角色扮演前端">
</p>

> [!NOTE]
> 这里的所有代码都由 LLM 生成或在 LLM 辅助下编写，但 Neconyan 自带的每一条提示词和每一个代理都出自人手。

Neconyan 是我基于 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 和 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) 做的一个猫咪主题衍生版，用来在电脑或手机上和 AI 角色聊天、玩角色扮演。模型需要你自己准备，可以是本地后端，也可以是 API 密钥，因为它本身不附带任何模型访问权限或额度。

**[阅读 Neconyan 官方手册](https://platberlitz.github.io/neconyan-docs/)。** 安装设置和使用上的问题，都请先从这里看起。手册里有带截图的指南、宏参考，还有制作扩展的说明。如果有什么用不了，提交 issue 之前请先看看[故障排除指南](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)。

如果你想要一个各方面都和上游完全一致的 SillyTavern，请改用 [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny)。我只引入自己想要的上游改动，所以这里有些地方的外观和行为会不一样，有些扩展也可能用不了。

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="为什么选 Neconyan？">
</p>

- **你走开了，它也不会停。** 你看着屏幕的时候，回复直接在浏览器里生成，因为这样更快。如果你在一对一聊天进行到一半时切到别的应用或锁了屏，服务器会替你留着这条回复，等你重新打开这个聊天时再交给你，不用为它付两次钱。对话、Meower 和记忆相关的处理本来就会在服务器上继续。如果你希望回复后运行的代理也能继续，请把“Where replies are written”设为 **On the server**。还有少数功能仍需要页面开着，比如浏览器内的 WebLLM 模型和 Kokoro 语音。
- **真正为手机设计。** 有像样的文字标签页、底部聊天栏和侧滑菜单，而不是把桌面布局硬缩成小屏版。
- **四种聊天方式。** 经典的角色扮演、即时通讯风格的对话、名为 Meower 的社交时间线，以及适合长篇写作的故事模式。
- **故事记忆。** [Mewmory](../docs/mewmory.md) 会记住你的故事、你遇到过的 NPC 以及他们说过的话，免得你在 200 条消息之后还得把一切从头解释一遍。
- **好东西都已内置。** 代理、聊天归档、Quick Image Gen、Guided Generations、BotSearcher，还有另外几个，各自都有独立的设置。[这里列出了其中原本是独立项目的那些，以及它们的作者。](../docs/neconyan-native-tools.md)
- **有个地方记笔记。** [笔记本](../docs/notebooks.md)就在聊天旁边，给你放角色草稿、地点、场景规划和会话日志。笔记之间可以互相链接，也能链接到你的世界书；只要你允许，助手们还能编辑它们。
- **小帮手们。** Miso、Taro 和 Nori 可以通过工具调用创建带头像的角色、编辑世界书，以及调整预设或代理。简短的新手导览会带你熟悉基础操作，而 [Simple Mode](#simple-mode) 会先把高级功能收起来，等你想用时再拿出来。
- **有人陪你聊聊剧情。** [Scratchpad](../docs/scratchpad.md) 是故事旁边的一个侧边聊天，助手们、你自己的角色，甚至由他们组成的一整场圆桌讨论，都可以读一读当前场景、给你出出主意，而这些内容都不会进入聊天。
- **它很可爱。** 三花猫主题、趴在你消息上打盹的猫，还有主页上的像素猫。说到底，做它就是为了这个。
- **你的文件还是你的文件。** 它和 SillyTavern 读取的是同样的角色卡、聊天记录、世界书和预设，而且没有任何遥测。

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="模式">
</p>

下面这些是用内置助手摆拍出来的演示聊天、笔记和 Scratchpad 回复，看看就好，别太当真。

### 主页

一打开就会来到这里。你可以挑个角色、开个临时聊天、连接模型，或者跟某位助手打个招呼。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="桌面端的主页"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="手机上的主页"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

这里的按钮很多，而第一天你大多都用不上。Simple Mode 会把 Mewmory、聊天归档、扩展程序、模式切换器、大部分微调选项以及消息框周围的额外按钮收起来，只留下角色、连接、预设、世界书、代理、笔记本和 Scratchpad。Nori 会在新手导览开始前问你要不要开启它。这些功能都没有被关闭，只是藏了起来，所以想把所有功能找回来时，随时在侧边栏按 **Show all features**，或者在“设置 > 外观”里把它关掉就行。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="桌面端开启 Simple Mode 时的角色扮演聊天"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="手机上开启 Simple Mode 时的角色扮演聊天"></td>
  </tr>
</table>

### 角色扮演

你在 SillyTavern 里熟悉的经典聊天，只是消息上面多了一只睡着的猫。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="桌面端的角色扮演模式"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="手机上的角色扮演模式"></td>
  </tr>
</table>

### 对话

像给朋友发消息一样给你的角色发消息。这里有好友列表、群聊和分支，角色也可能在忙或者离线。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="桌面端的对话模式"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="手机上的对话模式"></td>
  </tr>
</table>

### Meower

一个小小的社交时间线，你的角色们会在上面发帖、互相回复，还会发起关于零食的投票。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="桌面端的 Meower"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="手机上的 Meower"></td>
  </tr>
</table>

### 故事模式

把聊天变成连贯的叙述文字，适合你不想一个个气泡往下划、更想读一篇故事的时候。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="桌面端的故事模式"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="手机上的故事模式"></td>
  </tr>
</table>

### 笔记本

一个就放在聊天旁边的笔记本，专门放那些原本会丢在某个文本文件里、最后找不着的角色草稿和场景规划。它有模板、文件夹、属性和阅读视图，还能在聊天旁边打开。[进一步了解笔记本。](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="桌面端的笔记本"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="手机上的笔记本"></td>
  </tr>
</table>

### Scratchpad

一个就在你故事旁边的侧边聊天，适合想讨论场景、又不想让角色们听见的时候。你可以问 Miso、Taro 或 Nori，复制一张你自己的角色卡，或者自己做一个助手，然后让最多三位围坐圆桌，争论你的剧情反转到底奏不奏效。你在这里写的任何内容都不会进入故事。[进一步了解 Scratchpad。](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="桌面端故事模式聊天旁的 Scratchpad"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="手机上的 Scratchpad"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="快速上手">
</p>

按你手头的设备选一种就好：

| 你手上有 | 选这个 |
| --- | --- |
| 一部 Android 11 或更新版本的 Android 手机 | [Android 应用](#android-app) |
| 一部较旧的 Android 手机，或者你喜欢用终端 | [Termux](#android-with-termux) |
| Windows、macOS 或 Linux | [在电脑上安装](#on-a-computer) |
| 一部 iOS 17 或更新版本的 iPhone，而且你不介意侧载 | [iPhone 应用](#iphone-app) |
| 其他任何 iPhone，或者你更想把聊天记录留在电脑上 | 在电脑上安装，然后[在手机上打开](#opening-it-on-your-phone) |

无论选哪种，你都还需要一个能对话的模型：服务商提供的 API 密钥，或者像 KoboldCpp、Ollama 这样的本地后端。

<a id="android-app"></a>

### Android 应用

在 Android 11 或更新版本上，从[最新发布页](https://github.com/platberlitz/Neconyan/releases/latest)下载以 `-android-arm64.apk` 结尾的文件并打开。Android 很可能会先让你允许从浏览器安装应用。

所有东西都在手机上运行，不需要 Termux，也不需要电脑。请预留大约 2 GiB 的空间，第一次打开时要给它一些时间解包。它还需要 Android System WebView 124 或更新版本，如果你的版本太旧，应用会提示你。更新时，直接把新的 APK 覆盖安装到旧版本上，聊天记录都会保留。[Android 的安装设置、备份和构建说明。](../android/README.md)

<a id="iphone-app"></a>

### iPhone 应用

现在也有独立的 iPhone 应用了。思路和 Android 版一样：服务器、你的聊天记录和设置都在手机上，所以不需要一台电脑来运行 Neconyan。它没有上架 App Store，所以需要你自己侧载。

1. 打开[发布页](https://github.com/platberlitz/Neconyan/releases/latest)，如果该版本提供了以 `-ios-unsigned.ipa` 结尾的文件，就下载它。如果没有，请改用[浏览器方式](#opening-it-on-your-phone)。
2. 在 [iloader](https://github.com/nab138/iloader) 这类侧载工具中选择这个文件。工具会用你的 Apple 账户为它签名并安装。你需要 iOS 17 或更新版本。
3. 打开 Neconyan，在 **链接** 中连接一个模型，和在其他平台上一样。

免费的 Apple 账户每七天就得重新签名一次，而且最多只能侧载三个应用。更新时，用同一个 Apple 账户把新的 IPA 覆盖安装到旧版本上，聊天记录会保留。删除应用会连同聊天记录一起删掉，所以如果要换侧载工具，请先导出账户备份。

切换应用或锁屏时，导入也会继续进行。用应用自带的 **导入备份 ZIP** 按钮选择备份并确认，剩下的就交给服务器：它会播放无声音频，防止 iOS 在处理期间把它冻结，你随时回来看看就行。回复也会继续生成，和在桌面浏览器的标签页里一样：如果你在回复生成到一半时离开，页面会自己播放无声音频，直到回复写完、保存好，并且之后的代理都运行完毕。这期间你可能会在锁屏上看到“Neconyan is finishing a reply”，其他应用的音乐也可能会暂停，直到完成为止。如果手机内存不足，iOS 仍然可能关闭应用。复制备份期间，请留出约为备份两倍大小的空闲空间。[iPhone 的安装设置、限制和构建说明。](../ios/README.md)

<a id="on-a-computer"></a>

### 在电脑上

1. **获取 Neconyan。** 有两种方式，第二种会自动保持最新。

   - **直接下载。** 从[最新发布页](https://github.com/platberlitz/Neconyan/releases/latest)下载以 `-source.zip` 结尾的文件，解压到一个好找的地方，比如“文档”文件夹。在 Windows 上，请先右键单击这个 zip 文件并选择 **全部解压缩**，因为直接在压缩包里运行启动器是行不通的。解压后你会得到一个以版本号命名的文件夹，比如 `Neconyan-1.3.7`。
   - **用 [Git](https://git-scm.com/downloads) 克隆。** 在你想放这个文件夹的位置打开终端，运行下面这行命令。这样一来，启动器每次启动时都会检查有没有新版本，并在打开前自动更新，这也是我自己会选这种方式的原因。

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **启动。** 打开 Neconyan 文件夹，运行适合你系统的启动器。

   | 系统 | 方法 |
   | --- | --- |
   | Windows | 双击 `Start.bat` |
   | macOS | 双击 `Start.command` |
   | Linux 或 WSL | 在该文件夹中打开终端，运行 `./start.sh` |

   第一次启动需要几分钟。如果你没有 Bun 或 Node.js（真正用来运行 Neconyan 的程序），启动器会帮你安装 Bun，然后下载 Neconyan 需要的其他所有东西。使用 Neconyan 期间请保持这个窗口打开；关掉它，或者在里面按 Ctrl+C，都会让 Neconyan 停止运行。

3. **打开。** 浏览器应该会自动打开。如果没有，请访问 **<http://127.0.0.1:4433/>**。
4. **连接模型。** 在侧边栏点击 **链接**，选择你的服务商和模型，然后粘贴 API 密钥或本地后端的地址。之后就可以导入角色，或者去主页跟 Miso、Taro 或 Nori 打个招呼。

下次使用时，再运行同一个启动器就行。

**更新。** 用 Git 安装的版本会在启动时自动更新。如果用的是 zip，请下载新的 zip 并解压到一个新文件夹，关闭 Neconyan，然后把旧 Neconyan 文件夹里的 `data` 文件夹复制到新文件夹中；如果你改过 `config.yaml`，也一并复制过去。启动新版本，确认聊天记录都在之后，再删除旧文件夹。

<a id="android-with-termux"></a>

### 在 Android 上使用 Termux

[Termux](https://termux.dev/) 是一款 Android 终端应用。它比上面的应用麻烦一些，但在较旧的手机上也能用。

1. 从 [F-Droid](https://f-droid.org/packages/com.termux/) 或[它的 GitHub 发布页](https://github.com/termux/termux-app/releases)安装 Termux。
2. 打开 Termux 并更新。如果中途停下来询问配置文件怎么处理，按 Enter 保留当前文件即可。

   ```sh
   pkg update && pkg upgrade -y
   ```

3. 安装 Git，然后把 Neconyan 下载到 Termux 的主目录中。`--depth 1` 会跳过项目的旧历史记录，下载量更小，而且照样可以更新。

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. 启动它。第一次启动会安装 Node.js 和 Neconyan 需要的其他所有东西，所以请给它几分钟。

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. 看到 `Go to: http://127.0.0.1:4433/ to open Neconyan` 后，用手机上的 Chrome 或任意其他浏览器打开这个地址。然后在 **链接** 中连接模型，和在电脑上一样。

几个值得养成的 Termux 使用习惯：

- 要停止 Neconyan，先点额外按键行上的 **CTRL**，再点 **C**。
- 下次使用时，打开 Termux 再运行一次 `cd ~/Neconyan && bash start.sh`。它会在启动前自动更新。
- 把文件夹放在 Termux 主目录里。启动器会拒绝在 `/sdcard` 这类共享存储中运行，因为 Android 在那里会阻止 Neconyan 的软件包所需的文件链接。
- 在 Chrome 的菜单中选择 **添加到主屏幕**，就能给 Neconyan 一个单独的图标。

**让它在后台保持运行。** Android 喜欢停掉你没在看的应用，Termux 也不例外。下面这些步骤能让 Neconyan 在你使用其他应用时继续运行：

1. 下拉通知栏，确认 Termux 的通知显示已持有唤醒锁（wake lock）。Neconyan 启动时会申请它；如果没有生效，就点那条通知里的 **Acquire wakelock**。
2. 打开 Android 的 **设置 → 应用 → Termux → 电池**，选择 **不受限制**。不同品牌手机上的名称和位置不太一样，如果找不到，可以在设置里搜索“电池优化”。
3. 从 Android 12 开始，系统还会结束 Termux 启动的额外进程，而 Neconyan 就是其中之一。在 Android 14 及以上版本中，先开启开发者选项（在 **关于手机** 中连续点按 **版本号** 七次），然后打开 **停用子进程限制**。Android 12 和 13 没有这个开关，所以你需要在一台装有 `adb` 的电脑上通过 USB 调试运行下面两条命令，各运行一次即可：

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

即使服务器还在运行，Chrome 过一段时间后仍可能自行卸载页面，所以回来时 Neconyan 会重新加载。如果这让你很烦，可以在 **设置 → 系统与设备 → Memory and performance** 中打开 **Stay open in the background**。它会在你离开时播放一段轻到听不见的声音，让 Chrome 把 Neconyan 当成音乐播放器，不去动它。这会多耗一些电、显示一条媒体通知，还可能暂停其他应用正在播放的音乐，所以默认是关闭的。目前我只在模拟的手机浏览器里测试过，还没在真机上试过，如果你的手机不吃这一套，请告诉我。

<a id="opening-it-on-your-phone"></a>

### 在手机上打开

如果 Neconyan 在你的电脑上运行，只要手机和电脑连的是同一个 Wi-Fi，手机也能用。如果你不想侧载 [iPhone 应用](#iphone-app)，在 iPhone 上也可以用这个办法。

两边的浏览器用的是同一份数据。如果你其实是想在设备之间迁移离线环境，请在复制或同步文件夹之前，先阅读[在设备之间迁移数据](../docs/data-portability.md)，包括其中关于 GitHub 数据文件夹的设置。

1. 停止 Neconyan，用任意文本编辑器打开 Neconyan 文件夹中的 `config.yaml`。这个文件会在第一次启动后出现。把 `listen: false` 改成 `listen: true`。
2. 顺便开启密码保护，否则同一 Wi-Fi 下的任何人都能打开它。设置 `basicAuthMode: true`，然后修改 `basicAuthUser` 下的 `username` 和 `password`。
3. 重新启动 Neconyan，然后找到电脑的局域网地址。
   - **Windows：** 在命令提示符中运行 `ipconfig`，找到 **IPv4 地址**。
   - **macOS：** 按住 Option 键并点击菜单栏中的 Wi-Fi 图标，找到 **IP 地址**。
   - **Linux：** 运行 `hostname -I`。
4. 在手机浏览器中输入这个地址，前面加上 `http://`，后面加上 `:4433`，例如 `http://192.168.1.20:4433`。

如果 Windows 询问是否允许 Bun 或 Node.js 通过防火墙，请允许它在专用网络上通信。如果手机上显示的页面只写着 **已禁止**，说明你的网络分配的是以 `10.` 开头的地址，而 Neconyan 默认会拦截这类地址。请在 `config.yaml` 的 `whitelist:` 下添加这一行，然后重启 Neconyan：

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>选择 Node.js 或 Bun，以及其他启动器选项</b></summary>

如果你想自己选，每个系统也都有单独的 Node.js 和 Bun 启动器：

| 系统 | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android（Termux） | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

如果要手动安装，你需要 Node.js 20 或更新版本：

```sh
npm install
npm run start:node
```

Bun 1.3.14 或更新版本也可以：运行 `bun install`，然后运行 `bun run start`，或者运行 `bun run start:mobile` 以减少内存占用。请保持仓库里的 `.npmrc` 文件不变。

如果不想让 Git 安装版自动更新，请在运行启动器之前设置 `NECONYAN_AUTO_UPDATE=0`。

</details>

<details>
<summary><b>如果启动不了</b></summary>

- **Windows 提示“Windows 已保护你的电脑”：** 点击 **更多信息**，然后点击 **仍要运行**。大多数下载来的启动器都会触发这个提示。
- **macOS 因为 `Start.command` 来自身份不明的开发者而不肯打开：** 右键单击它并选择 **打开**。在较新的 macOS 版本中，请改为前往 **系统设置 → 隐私与安全性**，然后点击 **仍要打开**。
- **macOS 或 Linux 提示启动器不可执行：** 在 Neconyan 文件夹中运行下面这条命令。

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Git 安装版不再自动更新：** 如果你改动过 Neconyan 自己的任何文件，启动器就会跳过更新，并在启动时说明原因。你的聊天记录和 `config.yaml` 不算在内。
- **Android：** Termux 中默认使用 Node.js。Bun 需要两个额外的软件包，Bun 启动器会尝试帮你安装。如果安装失败，请自己手动安装：

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  如果你的 glibc 不在 `$PREFIX/glibc`，请设置 `GLIBC_ROOT`。

- **4433 端口被占用：** 用 `--port` 指定另一个端口号，或者在 `config.yaml` 中修改端口。

</details>

### 从 SillyTavern 或 SillyBunny 迁移过来？

你的大部分角色、聊天记录、世界书、人设和预设应该都能顺利迁移过来，但我不能保证全部都没问题，而且依赖 SillyTavern 页面布局的扩展可能需要修一修。

- **先备份旧的安装**，并在确认一切正常之前一直保留这份备份。
- **给 Neconyan 单独准备一个数据文件夹。** 千万不要让两个应用指向同一个文件夹。

Neconyan 第一次运行时会自己创建 `config.yaml` 和 `data/` 文件夹。你的个人数据、密钥和已安装的软件包永远不会包含在发布版本中。

<details>
<summary><b>面向开发者</b></summary>

`main` 存放发布快照，`staging` 是日常开发所在的分支。测试时请使用单独的检出目录和数据文件夹，免得影响你日常的聊天。

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

浏览器测试位于 `tests/` 中，会针对一个用完即弃的服务器运行：把 `NECONYAN_TEST_BASE_URL` 设为它的地址（默认是 `http://127.0.0.1:4433`）。测试前先构建前端，重新构建后要重启服务器。临时截图、测试报告、构建产物和本地运行时文件夹都不纳入提交。

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="致谢">
</p>

Neconyan 建立在 SillyTavern 和 SillyBunny 背后每一个人的工作之上；没有他们，就不会有这一切。内置工具及其来源项目都在[附带工具列表](../docs/neconyan-native-tools.md)中注明。

由 [Platberlitz](https://github.com/platberlitz) 制作。采用 [GNU AGPL v3](../LICENSE) 许可证，所以如果你再分发它，请保留其中的声明和许可证。
