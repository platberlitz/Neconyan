<!-- Translated from README.md at commit de66c177 (Neconyan 1.5.0). Keep the structure in step with the English README. -->

# Neconyan~

最新バージョンは[1.5.0](https://github.com/platberlitz/Neconyan/releases/latest)です。

**お使いの言語で読む：** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [Tiếng Việt](readme-vi_vn.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

この翻訳は、更新が遅れていることがあります。[英語版README](../README.md)が最新です。

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - いちばんかわいいLLMロールプレイ用フロントエンド">
</p>

Neconyanは、[SillyTavern](https://github.com/SillyTavern/SillyTavern)と[SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny)をもとに私が作った、猫がテーマのフォークです。パソコンでもスマホでも、AIキャラクターとのチャットやロールプレイを楽しめます。APIキーやローカルモデルはご自分で用意してください。アプリには、モデルへのアクセス権もクレジットも含まれていません。

**[Neconyanをダウンロード](https://github.com/platberlitz/Neconyan/releases/latest)** · **[ハンドブックを読む](https://platberlitz.github.io/neconyan-docs/)** · **[困ったときは](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> ここにあるコードはすべてLLMが生成したか、LLMの手を借りて書いたものです。ただし、Neconyanに同梱しているプロンプトとエージェントは、どれも人間が作りました。

## 何が入っているの？

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Neconyanを選ぶ理由">
</p>

- **チャットの楽しみ方は4通り**：定番の「ロールプレイ」、メッセンジャー風の「会話」、MeowerというSNS風のタイムライン、そしてひと続きの文章で読める「ストーリーモード」です。
- **スマホ向けに作ったレイアウト**です。ラベル付きのボタン、画面下のチャットバー、スライドして出てくるメニューがあります。**Simple Mode**にすると、あまり使わないボタンを必要になるまで隠せます。
- **Mewmory**は物語の出来事やキャラクターを覚えておきます。**エージェント**は、トラッカーを管理したり、返信をチェックしたり、「コンパニオンノート」を別に書いたりできます。
- **Catelier**は、キャラクターカードやロアブックを書くのを手伝ってくれます。**ノートブック**ならメモをすぐ手元に置いておけますし、**Scratchpad**では別のチャットでアイデアを相談できます。
- **Miso、Taro、Nori**が探し物を手伝ってくれます。許可すれば、対応している編集もしてくれます。
- **テーマ、アクセントカラー、そして猫**。猫はかなりたくさんいます。隠すこともできますが、なぜ隠したくなるのか、私には想像がつきません。

キャラクターカード、チャット、ロアブック、プリセットには、SillyTavernでおなじみの形式を使っています。テレメトリーはありません。本家の機能や拡張機能には、ここでは動作が違うものがあります。私が欲しい部分だけを取り込んでいるためです。Neconyanに同梱しているプロジェクトのクレジットは、[同梱ツールの一覧](../docs/neconyan-native-tools.md)に載せています。

## 見てみましょう

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="モード">
</p>

デスクトップとスマホの新しいスクリーンショットです。同梱のアシスタントとのデモ用チャットとノートを使っています。

### ホーム

キャラクターを選んだり、モデルを接続したり、アシスタントにあいさつしたりできます。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="デスクトップでのホーム"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="スマホでのホーム"></td>
</tr></table>

### ロールプレイ

シーンを書いたり、別の返信を試したり、古いチャットの続きから再開したりできます。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="デスクトップでのロールプレイ"></td>
  <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="スマホでのロールプレイ"></td>
</tr></table>

### Catelier

キャラクターの下書きを作り込み、文章の手伝いを頼み、変更を確認してからライブラリに保存します。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-catelier.webp" alt="デスクトップでのCatelier"></td>
  <td width="28%"><img src="../docs/readme/phone-catelier.webp" alt="スマホでのCatelier"></td>
</tr></table>

<details>
<summary><b>スクリーンショットをもっと見る：Simple Mode、会話、Meower、ストーリーモード、ノートブック、Scratchpad</b></summary>

### Simple Mode

慣れるまでは、表示するボタンを減らしておけます。サイドバーの**Show all features**を押すと元に戻ります。機能が無効になっているわけではありません。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="デスクトップでのSimple Mode"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="スマホでのSimple Mode"></td>
</tr></table>

### 会話

キャラクターにメッセージを送ったり、グループチャットを作ったりできます。キャラクターが忙しかったり、オフラインだったりするように設定することもできます。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="デスクトップでの会話"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="スマホでの会話"></td>
</tr></table>

### Meower

キャラクターたちが投稿したり、返信したり、アンケートを取ったりするSNS風のタイムラインです。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="デスクトップでのMeower"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="スマホでのMeower"></td>
</tr></table>

### ストーリーモード

チャットをひと続きの文章として読めます。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="デスクトップでのストーリーモード"></td>
  <td width="28%"><img src="../docs/readme/phone-story.webp" alt="スマホでのストーリーモード"></td>
</tr></table>

### ノートブック

シーンの構想、場所、セッションの記録を、チャットのすぐ隣に置いておけます。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="デスクトップでのノートブック"></td>
  <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="スマホでのノートブック"></td>
</tr></table>

### Scratchpad

アシスタントや、ラウンドテーブルに集まったキャラクターたちと物語について話し合えます。その話し合いがメインのチャットに入ることはありません。

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="デスクトップでのScratchpad"></td>
  <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="スマホでのScratchpad"></td>
</tr></table>

</details>

## はじめかた

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="はじめかた">
</p>

### パソコンで使う

1. [最新リリース](https://github.com/platberlitz/Neconyan/releases/latest)から、**-source.zip** で終わるファイルをダウンロードします。先に展開してください。Windowsでは、右クリックして**すべて展開**を選びます。
2. フォルダを開き、Windowsでは**Start.bat**を、macOSでは**Start.command**を実行します。Linuxでは、ターミナルで**bash start.sh**を実行します。
3. 初回の起動では、必要なものをインストールするために数分かかります。Neconyanを使っている間は、ターミナルのウィンドウを開いたままにしておいてください。
4. ブラウザが自動で開くはずです。開かないときは **http://127.0.0.1:4433/** にアクセスしてください。
5. **接続**を開き、プロバイダーとモデルを選んで、APIキーかローカルモデルのアドレスを入力します。そのあと、ホームでキャラクターかアシスタントを開いてください。

次からは、同じ起動スクリプトを実行するだけです。Neconyanを止めるには、そのターミナルで**Ctrl+C**を押します。

Gitがお好みなら、リポジトリをクローンしてから、同じ起動スクリプトを使ってください：

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[パソコンでのセットアップと、起動時のよくある問題](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Androidアプリ

[最新リリース](https://github.com/platberlitz/Neconyan/releases/latest)から **-android-arm64.apk** をダウンロードして開いてください。Androidに聞かれたら、ブラウザからのインストールを許可してください。**Android 11以降**、**Android System WebView 124以降**、そして約**2 GiB**の空き容量が必要です。

アプリはスマホの中で動くので、Termuxもパソコンも要りません。初回の起動時は展開が終わるまで少し待ってから、**接続**を設定してください。アップデートは、今のアプリの上からインストールすれば、チャットが残ります。

[Androidのセットアップ](https://platberlitz.github.io/neconyan-docs/start/android/) · [ビルド手順](../android/README.md)

### iPhoneアプリ

[最新リリース](https://github.com/platberlitz/Neconyan/releases/latest)から **-ios-unsigned.ipa** をダウンロードし、[iloader](https://github.com/nab138/iloader)などのサイドロードツールでインストールします。**iOS 17以降**が必要です。サーバーもチャットもスマホの中にあり、App Storeには出していません。

無料のAppleアカウントでは、7日ごとにアプリを署名し直す必要があり、サイドロードできるアプリは3つまでです。アップデートは、同じAppleアカウントで今のアプリの上からインストールしてください。**アプリを削除するとデータも削除されます**ので、先にバックアップを書き出しておいてください。

[iPhoneのセットアップと制限事項](../ios/README.md)

### スマホで使うそのほかの方法

- **AndroidでTermuxを使う**：ターミナルが好きな方や、古いスマホをお使いの方は、[Termuxガイド](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux)に従ってください。
- **パソコンにインストールしたものを使う**：[同じWi-Fiで使うためのガイド](https://platberlitz.github.io/neconyan-docs/start/phone/)に従ってください。どちらの端末も同じ保存済みのチャットを使います。パソコンは動かしたままにしておいてください。

## アップデート、バックアップ、チャットの移動

**サーバー → アップデートと再起動 → アップデートを確認**を開きます。Gitでのインストールと、対応しているソースZIPでのインストールでは、**アップデートして再起動**が表示されます。Androidでは**Update APK**が表示され、インストールの承認を求められます。アップデート機能のない古いZIPのコピーは、[新しいフォルダへ手動で移す](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation)必要があります。

Gitでインストールしたものは、起動時にもアップデートを確認します。アプリ自体のファイルを変更していると、自動アップデートができなくなることがあります。チャットや設定は、これには含まれません。

SillyTavernやSillyBunnyから移ってきた方は、**先にバックアップを取り**、Neconyanには専用のデータフォルダを用意してから、[データをインポートする](https://platberlitz.github.io/neconyan-docs/start/imports/)の手順に進んでください。何かを削除する前に、キャラクターとチャットを確認してください。拡張機能によっては、手直しが必要になることがあります。

[バックアップと復元](https://platberlitz.github.io/neconyan-docs/help/backups/) · [端末間でのデータの移動](../docs/data-portability.md)

## 困ったときは

私なら、まず[ハンドブック](https://platberlitz.github.io/neconyan-docs/)を見るか、ホームでMiso、Taro、Noriに聞いてみます。彼らも間違えることがあるので、元に戻せない変更をする前に、そのアドバイスをよく確認してください。

見つからない設定は、サイドバーの**検索**で探してみてください。エラーが出たときは、[トラブルシューティングガイド](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)を参照するか、何をしていたかと表示されたエラーを添えて[issueを報告](https://github.com/platberlitz/Neconyan/issues)してください。

## クレジット

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="クレジット">
</p>

Neconyanは、SillyTavernとSillyBunnyを作ってきたすべての人の仕事の上に成り立っています。その人たちがいなければ、ここにあるものは何ひとつ存在しなかったはずです。元の作者たちのクレジットは、[同梱ツールの一覧](../docs/neconyan-native-tools.md)に載せています。

作者は[Platberlitz](https://github.com/platberlitz)です。ライセンスは[GNU AGPL v3](../LICENSE)なので、再配布するときは著作権表示などの表記とライセンス文をそのまま残してください。
