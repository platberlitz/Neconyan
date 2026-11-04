<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

最新リリース：**[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**。開発は`staging`で続いています。

**ほかの言語：** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

これは[英語版README](../README.md)の翻訳です。内容が食い違うときは、英語版のほうが最新です。

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - いちばんかわいいLLMロールプレイ用フロントエンド">
</p>

> [!NOTE]
> ここにあるコードはすべてLLMが生成したか、LLMの手を借りて書いたものです。ただし、Neconyanに同梱しているプロンプトとエージェントは、どれも人間が作りました。

Neconyanは、[SillyTavern](https://github.com/SillyTavern/SillyTavern)と[SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny)をもとに私が作った、猫がテーマのフォークです。パソコンでもスマホでも、AIキャラクターとのチャットやロールプレイを楽しめます。モデルへのアクセス権やクレジットは付いていないので、モデルはローカルのバックエンドかAPIキーで自分で用意してください。

**[Neconyan公式ハンドブックを読む](https://platberlitz.github.io/neconyan-docs/)**。セットアップや使い方で困ったら、まずはこちらから。スクリーンショット付きのガイド、マクロのリファレンス、拡張機能の作り方も載っています。うまく動かないときは、issueを立てる前に[トラブルシューティングガイド](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)を確認してみてください。

本家とまったく同じように動くSillyTavernが欲しいなら、代わりに[SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny)を使ってください。私は本家の変更のうち欲しいものだけを取り込んでいるので、ここでは見た目や動きが違うところがあり、動かない拡張機能もあるかもしれません。

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Neconyanを選ぶ理由">
</p>

- **離れても止まりません**。見ている間の返信は、そのほうが速いのでブラウザで生成します。1対1のチャットの途中でアプリを切り替えたりスマホをロックしたりしても、サーバーが返信を預かっておき、そのチャットを開き直したときに渡してくれます。二重に料金がかかることもありません。「会話」、Meower、記憶まわりの処理は、もともとサーバー側で続きます。返信後に動くエージェントも止めたくない場合は、「Where replies are written」を**On the server**にしてください。ブラウザ内で動くWebLLMモデルやKokoroの音声など、ページを開いたままにしておく必要があるものもまだ少しあります。
- **ちゃんとスマホ向けに作っています**。デスクトップのレイアウトをただ縮めたものではなく、ラベル付きのタブ、画面下のチャットバー、スライドして出てくるメニューがあります。
- **チャットの楽しみ方は4通り**。定番の「ロールプレイ」、メッセンジャー風の「会話」、MeowerというSNS風タイムライン、そして長い物語を書くための「ストーリーモード」です。
- **物語を覚えておく記憶機能**。[Mewmory](../docs/mewmory.md)が物語の流れや、出会ったNPC、その人たちが言ったことを覚えておくので、200メッセージ後に一から説明し直す必要はありません。
- **便利な機能は最初から入っています**。エージェント、チャットアーカイブ、Quick Image Gen、Guided Generations、BotSearcherなどがあり、それぞれに専用の設定があります。[もともと別のプロジェクトだったものと、その作者の一覧はこちらです。](../docs/neconyan-native-tools.md)
- **メモを置いておける場所**。[ノートブック](../docs/notebooks.md)には、キャラクターの下書き、場所、シーンの構想、セッションの記録などを、チャットのすぐ隣に置いておけます。ノート同士やロアブックにリンクでき、許可すればアシスタントが編集することもできます。
- **小さなお手伝いさんたち**。Miso、Taro、Noriはツール呼び出しを使って、画像付きのキャラクターを作ったり、ロアブックを編集したり、プリセットやエージェントを調整したりできます。短い「最初の肉球ツアー」が基本を案内してくれますし、[Simple Mode](#simple-mode)を使えば、必要になるまで高度な機能をしまっておけます。
- **物語の相談相手**。[Scratchpad](../docs/scratchpad.md)は物語の横に置けるサイドチャットです。アシスタントや自分のキャラクター、あるいは何人も集めたラウンドテーブルがシーンを読んでアイデアをくれます。そのやり取りがチャット本文に入ることはありません。
- **かわいい**。キャリコのテーマ、メッセージの上で昼寝する猫たち、ホームにはドット絵の猫。正直なところ、それがいちばんの目的でした。
- **ファイルはこれからもあなたのもの**。SillyTavernと同じキャラクターカード、チャット、ロアブック、プリセットを読み込めますし、テレメトリーもありません。

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="モード">
</p>

ここに載せているのは、同梱のアシスタントを使って用意したデモ用のチャット、ノート、Scratchpadの返信です。あまり深読みしないでくださいね。

### ホーム

最初に表示される画面です。キャラクターを選んだり、一時チャットを始めたり、モデルを接続したり、アシスタントのひとりにあいさつしたりできます。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="デスクトップでのホーム"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="スマホでのホーム"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

ここにはボタンがたくさんありますが、使い始めたばかりのうちは、そのほとんどは要りません。Simple Modeにすると、Mewmory、チャットアーカイブ、拡張機能、モードの切り替え、「微調整」の大部分、メッセージ入力欄まわりの追加ボタンがしまわれ、キャラクター、接続、プリセット、ロアブック、エージェント、ノートブック、Scratchpadが残ります。「最初の肉球ツアー」が始まる前に、Simple Modeを使うかどうかNoriが聞いてくれます。機能がオフになるわけではなく隠れているだけなので、全部を元に戻したくなったら、いつでもサイドバーの**Show all features**を押すか、「設定 > 外観」でオフにしてください。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Simple Modeをオンにしたロールプレイのチャット（デスクトップ）"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Simple Modeをオンにしたロールプレイのチャット（スマホ）"></td>
  </tr>
</table>

### ロールプレイ

SillyTavernでおなじみの定番チャットです。メッセージの上では猫が丸くなって眠っています。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="デスクトップでのロールプレイ"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="スマホでのロールプレイ"></td>
  </tr>
</table>

### 会話

友だちにメッセージを送るような感覚で、キャラクターとやり取りできます。「仲間」リスト、グループチャット、分岐があり、キャラクターが忙しかったりオフラインだったりすることもあります。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="デスクトップでの会話"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="スマホでの会話"></td>
  </tr>
</table>

### Meower

キャラクターたちが投稿したり、お互いに返信したり、おやつについてのアンケートを取ったりする、小さなSNS風タイムラインです。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="デスクトップでのMeower"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="スマホでのMeower"></td>
  </tr>
</table>

### ストーリーモード

チャットをひと続きの文章に変えたものです。吹き出しをスクロールするより、物語として読みたいときにどうぞ。

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="デスクトップでのストーリーモード"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="スマホでのストーリーモード"></td>
  </tr>
</table>

### ノートブック

チャットの隣に置いておけるノートです。放っておくとどこかのテキストファイルに埋もれてしまう、キャラクターの下書きやシーンの構想をまとめておけます。テンプレート、フォルダ、プロパティ、閲覧表示があり、チャットの横に並べて開くこともできます。[ノートブックについて詳しくはこちら。](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="デスクトップでのノートブック"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="スマホでのノートブック"></td>
  </tr>
</table>

### Scratchpad

物語の横に置いておけるサイドチャットです。キャラクターに聞かれずにシーンについて話したいときに使います。Miso、Taro、Noriに聞いてもいいし、自分のキャラクターカードをコピーしても、自分だけのアシスタントを作ってもかまいません。最大3人までラウンドテーブルに座らせて、あなたの考えたどんでん返しがうまく決まるかどうか、言い合いをさせることもできます。ここに書いたことが物語に入ることはありません。[Scratchpadについて詳しくはこちら。](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="デスクトップでストーリーモードのチャットの横に開いたScratchpad"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="スマホでのScratchpad"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="はじめかた">
</p>

手元の環境に合うものを選んでください。

| 手元にあるもの | おすすめ |
| --- | --- |
| Android 11以降のAndroidスマホ | [Androidアプリ](#android-app) |
| もっと古いAndroidスマホ、またはターミナルが好き | [Termux](#android-with-termux) |
| Windows、macOS、Linux | [パソコンにインストール](#on-a-computer) |
| iOS 17以降のiPhoneで、サイドロードしてもかまわない | [iPhoneアプリ](#iphone-app) |
| それ以外のiPhone、またはチャットをパソコンに置いておきたい | パソコンにインストールしてから、[スマホで開く](#opening-it-on-your-phone) |

どれを選んでも、話し相手になるモデルは別に必要です。プロバイダーのAPIキーか、KoboldCppやOllamaのようなローカルのバックエンドを用意してください。

<a id="android-app"></a>

### Androidアプリ

Android 11以降なら、[最新リリース](https://github.com/platberlitz/Neconyan/releases/latest)から`-android-arm64.apk`で終わるファイルをダウンロードして開いてください。開くと、インストールの前に、ブラウザからのアプリのインストールを許可するようAndroidに求められると思います。

すべてスマホの中で動くので、Termuxもパソコンも要りません。空き容量を2 GiBほど確保して、初回の起動時は展開が終わるまで少し待ってあげてください。Android System WebView 124以降も必要で、古すぎる場合はアプリが教えてくれます。アップデートするときは、新しいAPKを古いものの上からインストールすれば、チャットはそのまま残ります。[Androidのセットアップ、バックアップ、ビルド手順はこちら。](../android/README.md)

<a id="iphone-app"></a>

### iPhoneアプリ

単体で動くiPhoneアプリもできました。考え方はAndroid版と同じで、サーバーもチャットも設定もすべてスマホの中にあるので、Neconyanを動かすパソコンは要りません。App Storeには出していないので、自分でサイドロードしてください。

1. [リリースページ](https://github.com/platberlitz/Neconyan/releases/latest)を開き、そのリリースに含まれていれば`-ios-unsigned.ipa`で終わるファイルをダウンロードします。含まれていなければ、代わりに[ブラウザでのセットアップ](#opening-it-on-your-phone)を使ってください。
2. [iloader](https://github.com/nab138/iloader)などのサイドロードツールで、そのファイルを選びます。ツールがあなたのAppleアカウントで署名して、インストールしてくれます。iOS 17以降が必要です。
3. Neconyanを開いて、ほかの環境と同じように**接続**からモデルをつなぎます。

無料のAppleアカウントでは、7日ごとにアプリを署名し直す必要があり、サイドロードできるアプリも3つまでです。アップデートするときは、同じAppleアカウントで新しいIPAを古いものの上からインストールすれば、チャットはそのまま残ります。アプリを削除するとチャットも一緒に消えるので、サイドロードツールを乗り換えるときは、先にアカウントのバックアップを書き出しておいてください。

インポートは、アプリを切り替えたりスマホをロックしたりしても続きます。アプリ内の**バックアップZIPをインポート**ボタンでバックアップを選んで確定すれば、あとはサーバーが引き受けます。作業中にiOSに止められないよう無音を再生し続けるので、好きなときに様子を見に戻ってきてください。返信も、デスクトップのブラウザのタブと同じように続きます。返信の途中で離れても、返信が書き終わって保存され、そのあとのエージェントが動き終わるまで、ページ自身が無音のオーディオを再生し続けます。その間、ロック画面に「Neconyan is finishing a reply」と表示されることがあり、ほかのアプリで流している音楽は終わるまで止まることがあります。それでも、スマホのメモリが足りなくなるとiOSがアプリを閉じてしまうことはあります。バックアップを取り込んでいる間は、バックアップのサイズの2倍ほどの空き容量を確保しておいてください。[iPhoneのセットアップ、制限事項、ビルド手順はこちら。](../ios/README.md)

<a id="on-a-computer"></a>

### パソコンで使う

1. **Neconyanを手に入れる**。方法は2つあり、2つ目なら自動で最新の状態に保たれます。

   - **ダウンロードする**。[最新リリース](https://github.com/platberlitz/Neconyan/releases/latest)から`-source.zip`で終わるファイルを取ってきて、「ドキュメント」フォルダなど見つけやすい場所に展開します。Windowsでは、先にZIPを右クリックして**すべて展開**を選んでください。ZIPの中から起動スクリプトを実行してもうまく動きません。`Neconyan-1.3.7`のように、バージョン名の付いたフォルダができます。
   - **[Git](https://git-scm.com/downloads)でクローンする**。フォルダを置きたい場所でターミナルを開き、下のコマンドを実行します。こうしておくと、起動スクリプトが起動のたびに新しいバージョンを確認し、開く前にアップデートしてくれます。私がこちらをおすすめするのはそのためです。

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **起動する**。Neconyanフォルダを開いて、お使いのシステム用の起動スクリプトを実行します。

   | システム | 方法 |
   | --- | --- |
   | Windows | `Start.bat`をダブルクリック |
   | macOS | `Start.command`をダブルクリック |
   | LinuxまたはWSL | フォルダでターミナルを開いて`./start.sh`を実行 |

   初回の起動には数分かかります。BunもNode.js（Neconyanを実際に動かすプログラム）も入っていなければ、起動スクリプトがBunをインストールし、続けてNeconyanに必要なほかのものもすべてダウンロードします。Neconyanを使っている間は、そのウィンドウを開いたままにしておいてください。ウィンドウを閉じたり、そこでCtrl+Cを押したりするとNeconyanが止まります。

3. **開く**。ブラウザが自動で開くはずです。開かないときは **http://127.0.0.1:4433/** にアクセスしてください。
4. **モデルをつなぐ**。サイドバーの**接続**をクリックし、プロバイダーとモデルを選んでから、APIキーかローカルのバックエンドのアドレスを貼り付けます。そのあとは、キャラクターをインポートするか、ホームでMiso、Taro、Noriにあいさつしてみてください。

次からは、同じ起動スクリプトをもう一度実行するだけです。

**アップデート**。Gitでインストールした場合は、起動するときに自動でアップデートされます。ZIPの場合は、新しいZIPをダウンロードして新しいフォルダに展開し、Neconyanを閉じてから、古いNeconyanフォルダの`data`フォルダを新しいほうにコピーします。`config.yaml`を変更していた場合は、それも一緒にコピーしてください。新しいほうを起動してチャットが揃っていることを確かめてから、古いフォルダを削除してください。

<a id="android-with-termux"></a>

### AndroidでTermuxを使う

[Termux](https://termux.dev/)はAndroid用のターミナルアプリです。上のアプリより手間はかかりますが、古いスマホでも動きます。

1. [F-Droid](https://f-droid.org/packages/com.termux/)か[GitHubのリリース](https://github.com/termux/termux-app/releases)からTermuxをインストールします。
2. Termuxを開いてアップデートします。途中で設定ファイルについて聞かれて止まったら、Enterを押して今のファイルをそのまま使ってください。

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Gitをインストールしてから、NeconyanをTermuxのホームにダウンロードします。`--depth 1`を付けるとプロジェクトの古い履歴を省くのでダウンロードが小さくなり、アップデートもちゃんとできます。

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. 起動します。初回の起動ではNode.jsとNeconyanに必要なほかのものがすべてインストールされるので、数分待ってください。

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. `Go to: http://127.0.0.1:4433/ to open Neconyan`と表示されたら、スマホのChromeなどのブラウザでそのアドレスを開きます。あとはパソコンのときと同じように、**接続**からモデルをつなぎます。

身につけておくと便利なTermuxの習慣をいくつか：

- Neconyanを止めるには、追加キーの列にある**CTRL**をタップしてから**C**をタップします。
- 次からは、Termuxを開いてもう一度`cd ~/Neconyan && bash start.sh`を実行します。起動する前に自動でアップデートされます。
- フォルダはTermuxのホームに置いたままにしてください。`/sdcard`のような共有ストレージからだと、起動スクリプトは実行を拒否します。Neconyanのパッケージに必要なファイルリンクを、Androidがそこではブロックするためです。
- Chromeのメニューにある**ホーム画面に追加**を使うと、Neconyan専用のアイコンを置けます。

**バックグラウンドで動かし続けるには**。Androidは見ていないアプリを止めたがりますし、Termuxも例外ではありません。次の手順で、ほかのアプリを使っている間もNeconyanを動かし続けられます。

1. 通知を引き下ろして、Termuxの通知でウェイクロックが保持されていることを確認します。Neconyanは起動時にウェイクロックを要求しますが、保持されていなければ、その通知の**Acquire wakelock**をタップしてください。
2. Androidの**設定 → アプリ → Termux → バッテリー**を開き、**制限なし**を選びます。項目の名前はスマホのメーカーによって違うので、見つからなければ設定で「バッテリーの最適化」を検索してください。
3. Android 12以降では、Termuxが起動した追加のプロセスもAndroidに終了させられてしまい、Neconyanもその1つです。Android 14以降なら、開発者向けオプションをオンにして（**デバイス情報**の**ビルド番号**を7回タップします）、**Disable child process restrictions**をオンにしてください。Android 12と13にはこのスイッチがないので、`adb`とUSBデバッグが使えるパソコンから、次の2つのコマンドを一度だけ実行する必要があります。

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

サーバーが動き続けていても、しばらくするとChromeがページ自体を破棄してしまうことがあり、その場合、戻ってくるとNeconyanが再読み込みされます。それが気になるなら、**設定 → システムとデバイス → Memory and performance**で**Stay open in the background**をオンにしてください。離れている間、聞こえないほど小さな音を流すので、ChromeがNeconyanを音楽プレーヤーのように扱って、そっとしておいてくれます。バッテリーを少し使い、メディアの通知が出て、ほかのアプリで流している音楽が止まることもあるので、初期設定ではオフにしています。今のところエミュレートしたスマホのブラウザでしか試しておらず、実機ではまだなので、お使いのスマホで効かなかったら教えてください。

<a id="opening-it-on-your-phone"></a>

### スマホで開く

パソコンでNeconyanを動かしているなら、両方が同じWi-Fiにつながっている限り、スマホからも使えます。[iPhoneアプリ](#iphone-app)をサイドロードしたくない場合も、iPhoneではこの方法がおすすめです。

どちらのブラウザも同じデータを使います。そうではなく、オフラインで使っている環境を端末の間で移したい場合は、フォルダをコピーしたり同期したりする前に、GitHubのデータフォルダの設定も含めて[端末間でのデータの移動](../docs/data-portability.md)を読んでください。

1. Neconyanを止めて、Neconyanフォルダにある`config.yaml`を好きなテキストエディターで開きます。このファイルは初回の起動後にできます。`listen: false`を`listen: true`に変更します。
2. ついでにパスワードもオンにしておきましょう。そうしないと、同じWi-Fiにいる人なら誰でも開けてしまいます。`basicAuthMode: true`にしてから、`basicAuthUser`の下にある`username`と`password`を変更します。
3. Neconyanをもう一度起動して、パソコンのローカルアドレスを調べます。
   - **Windows：** コマンド プロンプトで`ipconfig`を実行し、**IPv4 アドレス**を探します。
   - **macOS：** Optionキーを押しながらメニューバーのWi-Fiアイコンをクリックし、**IPアドレス**を探します。
   - **Linux：** `hostname -I`を実行します。
4. スマホのブラウザで、そのアドレスの前に`http://`、後ろに`:4433`を付けて入力します。たとえば`http://192.168.1.20:4433`のようになります。

BunやNode.jsにファイアウォールの通過を許可するかWindowsに聞かれたら、プライベートネットワークで許可してください。スマホに**禁止**とだけ書かれたページが出る場合は、お使いのネットワークが`10.`で始まるアドレスを割り当てていて、Neconyanが初期設定でそれをブロックしています。`config.yaml`の`whitelist:`の下に次の行を追加してから、Neconyanを再起動してください。

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Node.jsかBunかを選ぶ方法と、そのほかの起動オプション</b></summary>

自分で選びたい場合のために、どのシステムにもNode.js用とBun用の起動スクリプトが別々に用意されています。

| システム | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android（Termux） | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

手動でインストールするには、Node.js 20以降が必要です。

```sh
npm install
npm run start:node
```

Bun 1.3.14以降でも動きます。`bun install`を実行してから`bun run start`を、メモリの使用量を抑えたいときは`bun run start:mobile`を実行してください。リポジトリの`.npmrc`ファイルはそのままにしておいてください。

Gitでインストールしたものが自動でアップデートしないようにするには、起動スクリプトを実行する前に`NECONYAN_AUTO_UPDATE=0`を設定します。

</details>

<details>
<summary><b>起動しないときは</b></summary>

- **Windowsに「PCが保護されました」と表示される：** **詳細情報**をクリックしてから、**実行**をクリックします。ダウンロードした起動スクリプトの多くで、この表示が出ます。
- **macOSで、開発元が未確認のため`Start.command`を開けない：** 右クリックして**開く**を選びます。新しいmacOSでは、代わりに**システム設定 → プライバシーとセキュリティ**を開いて、**このまま開く**をクリックしてください。
- **macOSやLinuxで、起動スクリプトが実行可能ではないと言われる：** Neconyanフォルダで次のコマンドを実行します。

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Gitでインストールしたものがアップデートされなくなった：** Neconyan自体のファイルを編集していると、起動スクリプトはアップデートを見送り、起動時にその理由を表示します。チャットや`config.yaml`はこれに含まれません。
- **Android：** TermuxではNode.jsが標準です。Bunには追加のパッケージが2つ必要で、Bun用の起動スクリプトが自動でインストールを試みます。うまくいかなければ、自分でインストールしてください。

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  glibcが`$PREFIX/glibc`以外の場所にある場合は、`GLIBC_ROOT`を設定してください。

- **ポート4433がすでに使われている：** `--port`で別の番号を指定するか、`config.yaml`でポートを変更してください。

</details>

### SillyTavernやSillyBunnyから移ってきた方へ

キャラクター、チャット、ロアブック、ペルソナ、プリセットのほとんどは問題なく移せるはずですが、すべてがうまくいくとは約束できません。また、SillyTavernのページレイアウトに頼っている拡張機能は、手直しが必要になるかもしれません。

- **まず古い環境をバックアップしてください**。すべてちゃんと動くことを確かめるまで、そのバックアップは残しておきましょう。
- **Neconyanには専用のデータフォルダを用意してください**。2つのアプリに同じフォルダを使わせるのは、絶対にやめてください。

Neconyanは初回の起動時に、自分用の`config.yaml`と`data/`フォルダを作ります。あなたの個人データ、キー、インストールしたパッケージがリリースに含まれることはありません。

<details>
<summary><b>開発者向け</b></summary>

`main`にはリリースのスナップショットが置かれ、作業は`staging`で進めています。テストには別のチェックアウトとデータフォルダを使って、普段のチャットを巻き込まないようにしてください。

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

ブラウザテストは`tests/`にあり、使い捨てのサーバーに対して実行します。`NECONYAN_TEST_BASE_URL`にそのアドレスを設定してください（初期値は`http://127.0.0.1:4433`）。テストの前にフロントエンドをビルドし、ビルドし直したらサーバーを再起動してください。一時的なスクリーンショット、テストレポート、ビルドの出力、ローカルの実行時フォルダはコミットに含めません。

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="クレジット">
</p>

Neconyanは、SillyTavernとSillyBunnyを作ってきたすべての人の仕事の上に成り立っています。その人たちがいなければ、ここにあるものは何ひとつ存在しなかったはずです。同梱のツールとその元になったプロジェクトのクレジットは、[同梱ツールの一覧](../docs/neconyan-native-tools.md)に載せています。

作者は[Platberlitz](https://github.com/platberlitz)です。ライセンスは[GNU AGPL v3](../LICENSE)なので、再配布するときは著作権表示などの表記とライセンス文をそのまま残してください。
