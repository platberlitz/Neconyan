<!-- Translated from README.md at commit 2921e92 (Neconyan 1.4.1). Keep the structure in step with the English README. -->

# Neconyan 1.4.1

Bản phát hành mới nhất: **[1.4.1](https://github.com/platberlitz/Neconyan/releases/tag/v1.4.1)**. Việc phát triển vẫn tiếp tục trên nhánh `staging`.

**Ngôn ngữ khác:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Đây là bản dịch của [README tiếng Anh](../README.md). Nếu hai bản có chỗ nào khác nhau, bản tiếng Anh là bản mới nhất.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - Frontend nhập vai với LLM dễ thương nhất">
</p>

> [!NOTE]
> Toàn bộ mã nguồn ở đây đều do LLM viết hoặc viết với sự hỗ trợ của LLM, nhưng mọi prompt và tác nhân đi kèm Neconyan đều do con người làm ra.

Neconyan là bản fork mang chủ đề mèo mà mình tách ra từ [SillyTavern](https://github.com/SillyTavern/SillyTavern) và [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny), dùng để trò chuyện và nhập vai với nhân vật AI trên máy tính hoặc trên điện thoại. Mô hình thì bạn tự lo, có thể là một backend chạy cục bộ hoặc một khóa API, vì Neconyan không đi kèm quyền truy cập mô hình hay credit nào.

**[Đọc cẩm nang chính thức của Neconyan](https://platberlitz.github.io/neconyan-docs/).** Hãy bắt đầu từ đó khi cài đặt hoặc khi có thắc mắc về cách dùng Neconyan. Cẩm nang có hướng dẫn kèm ảnh chụp màn hình, phần tra cứu macro và hướng dẫn tự làm tiện ích mở rộng. Nếu có gì đó không chạy, hãy xem [hướng dẫn khắc phục sự cố](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) trước khi mở issue.

Nếu bạn muốn một SillyTavern mà mọi thứ hoạt động y hệt bản gốc, hãy dùng [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny). Mình chỉ lấy về những phần của bản gốc mà mình muốn, nên ở đây có vài thứ trông khác và hoạt động khác, và một số tiện ích mở rộng có thể không chạy được.

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Tại sao chọn Neconyan?">
</p>

- **Vẫn chạy tiếp khi bạn rời đi.** Câu trả lời được viết ngay trong trình duyệt trong lúc bạn xem, vì như vậy nhanh hơn. Nếu bạn chuyển sang ứng dụng khác hoặc khóa điện thoại giữa chừng trong một cuộc trò chuyện tay đôi, máy chủ sẽ giữ lại câu trả lời và trao cho bạn khi bạn mở lại cuộc trò chuyện đó, mà không bị tính tiền hai lần. Hội thoại, Meower và việc cập nhật bộ nhớ thì vốn đã chạy tiếp trên máy chủ. Nếu bạn muốn các Tác nhân chạy sau câu trả lời cũng tiếp tục, hãy đặt “Where replies are written” thành **On the server**. Vẫn còn vài thứ cần để trang mở, như các mô hình WebLLM chạy trong trình duyệt và giọng đọc Kokoro.
- **Thật sự dành cho điện thoại.** Có các tab ghi nhãn đàng hoàng, thanh trò chuyện ở dưới cùng và một menu trượt, chứ không phải bố cục máy tính bị bóp nhỏ lại.
- **Bốn cách trò chuyện.** Nhập vai kiểu cổ điển, Hội thoại kiểu ứng dụng nhắn tin, một dòng thời gian mạng xã hội tên là Meower, và Chế độ câu chuyện để viết truyện dài.
- **Bộ nhớ cho câu chuyện.** [Mewmory](../docs/mewmory.md) ghi nhớ diễn biến câu chuyện, những NPC bạn đã gặp và những gì họ đã nói, để 200 tin nhắn sau bạn không phải giải thích lại mọi thứ từ đầu.
- **Những thứ hay ho được tích hợp sẵn.** Tác nhân, Lưu trữ trò chuyện, Quick Image Gen, Guided Generations, BotSearcher và vài công cụ khác, cái nào cũng có phần cài đặt riêng. [Đây là những công cụ khởi đầu là dự án riêng, kèm tên những người đã làm ra chúng.](../docs/neconyan-native-tools.md)
- **Một chỗ để ghi chép.** [Sổ ghi chép](../docs/notebooks.md) cho bạn chỗ để viết nháp nhân vật, địa điểm, kế hoạch cho từng cảnh và nhật ký mỗi buổi chơi, ngay cạnh các cuộc trò chuyện. Các ghi chú có thể liên kết với nhau và với lorebook của bạn, và các trợ lý có thể chỉnh sửa chúng nếu bạn cho phép.
- **Những trợ thủ nhỏ.** Miso, Taro và Nori có thể gọi công cụ để tạo nhân vật kèm ảnh chân dung, chỉnh sửa lorebook và điều chỉnh preset hay tác nhân. Chuyến tham quan First paws ngắn gọn sẽ dẫn bạn làm quen với những điều cơ bản, còn [Simple Mode](#simple-mode) cất bớt những thứ nâng cao sang một bên cho đến khi bạn cần tới.
- **Có người để cùng bàn về câu chuyện.** [Scratchpad](../docs/scratchpad.md) là một khung trò chuyện phụ nằm cạnh câu chuyện của bạn, nơi các trợ lý, nhân vật của chính bạn hoặc cả một bàn tròn gồm nhiều người trong số họ có thể đọc cảnh truyện và gợi ý cho bạn, mà không có gì trong đó lọt vào cuộc trò chuyện.
- **Dễ thương nữa chứ.** Các chủ đề Calico, những chú mèo ngủ trưa trên tin nhắn của bạn và một chú mèo pixel ở Trang chủ. Nói thật, mục đích ngay từ đầu chỉ có vậy thôi.
- **Tệp của bạn vẫn là của bạn.** Neconyan đọc được cùng loại thẻ nhân vật, cuộc trò chuyện, lorebook và preset như SillyTavern, và không hề có telemetry.

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Các chế độ">
</p>

Đây là các cuộc trò chuyện, ghi chú và câu trả lời Scratchpad được dàn dựng để minh họa với các trợ lý đi kèm, nên bạn đừng để tâm quá nhiều vào nội dung nhé.

### Trang chủ

Nơi bạn đặt chân đến đầu tiên. Chọn một nhân vật, bắt đầu một cuộc trò chuyện tạm thời, kết nối mô hình hoặc chào một trong các trợ lý.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="Trang chủ trên máy tính"></td>
    <td width="28%"><img src="../docs/readme/phone-home.webp" alt="Trang chủ trên điện thoại"></td>
  </tr>
</table>

<a id="simple-mode"></a>

### Simple Mode

Ở đây có rất nhiều nút, và ngày đầu tiên bạn chẳng cần đến phần lớn trong số đó. Simple Mode cất gọn Mewmory, Lưu trữ trò chuyện, Tiện ích, nút chuyển chế độ, phần lớn mục Tinh chỉnh và các nút phụ quanh ô soạn tin, chỉ để lại nhân vật, kết nối, preset, lorebook, Tác nhân, Sổ ghi chép và Scratchpad. Nori sẽ hỏi bạn có muốn bật nó không trước khi chuyến tham quan First paws bắt đầu. Không có gì bị tắt cả, chỉ là được ẩn đi, nên khi nào muốn lấy lại mọi thứ, bạn chỉ cần bấm **Show all features** ở thanh bên hoặc tắt nó trong Cài đặt > Giao diện.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Một cuộc trò chuyện Nhập vai khi bật Simple Mode, trên máy tính"></td>
    <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Một cuộc trò chuyện Nhập vai khi bật Simple Mode, trên điện thoại"></td>
  </tr>
</table>

### Nhập vai

Kiểu trò chuyện cổ điển bạn đã quen từ SillyTavern, thêm một chú mèo nằm ngủ trên tin nhắn của bạn.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Nhập vai trên máy tính"></td>
    <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Nhập vai trên điện thoại"></td>
  </tr>
</table>

### Hội thoại

Nhắn tin với nhân vật như nhắn cho một người bạn. Có danh sách Bạn bè, trò chuyện nhóm, phân nhánh, và nhân vật có thể bận hoặc ngoại tuyến.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Hội thoại trên máy tính"></td>
    <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Hội thoại trên điện thoại"></td>
  </tr>
</table>

### Meower

Một dòng thời gian mạng xã hội tí hon, nơi các nhân vật của bạn đăng bài, trả lời nhau và mở bình chọn về đồ ăn vặt.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower trên máy tính"></td>
    <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower trên điện thoại"></td>
  </tr>
</table>

### Chế độ câu chuyện

Cuộc trò chuyện được chuyển thành văn xuôi liền mạch, cho những lúc bạn muốn đọc một câu chuyện hơn là lướt qua từng bong bóng chat.

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Chế độ câu chuyện trên máy tính"></td>
    <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Chế độ câu chuyện trên điện thoại"></td>
  </tr>
</table>

### Sổ ghi chép

Một cuốn sổ nằm ngay cạnh các cuộc trò chuyện, dành cho những bản nháp nhân vật và kế hoạch cảnh truyện mà nếu không có nó, bạn sẽ để thất lạc trong một tệp văn bản nào đó. Sổ có mẫu, thư mục, thuộc tính và chế độ đọc, và bạn có thể mở nó bên cạnh một cuộc trò chuyện. [Tìm hiểu thêm về Sổ ghi chép.](../docs/notebooks.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Sổ ghi chép trên máy tính"></td>
    <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Sổ ghi chép trên điện thoại"></td>
  </tr>
</table>

### Scratchpad

Một khung trò chuyện phụ nằm cạnh câu chuyện của bạn, cho những lúc bạn muốn bàn về cảnh truyện mà không để các nhân vật nghe thấy. Hãy hỏi Miso, Taro hoặc Nori, sao chép một thẻ nhân vật của bạn, hoặc tự tạo trợ lý riêng, rồi cho tối đa ba người trong số đó ngồi vào một bàn tròn và để họ cãi nhau xem cú twist của bạn có thuyết phục không. Không điều gì bạn viết ở đó lọt vào câu chuyện. [Tìm hiểu thêm về Scratchpad.](../docs/scratchpad.md)

<table>
  <tr>
    <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad bên cạnh một cuộc trò chuyện ở Chế độ câu chuyện, trên máy tính"></td>
    <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad trên điện thoại"></td>
  </tr>
</table>

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Bắt đầu">
</p>

Hãy chọn cách hợp với thiết bị bạn đang có:

| Bạn đang có | Nên chọn |
| --- | --- |
| Điện thoại chạy Android 11 trở lên | [Ứng dụng Android](#android-app) |
| Điện thoại Android đời cũ hơn, hoặc bạn thích dùng terminal | [Termux](#android-with-termux) |
| Windows, macOS hoặc Linux | [Cài trên máy tính](#on-a-computer) |
| iPhone chạy iOS 17 trở lên, và bạn không ngại sideload | [Ứng dụng iPhone](#iphone-app) |
| Mọi iPhone khác, hoặc bạn muốn giữ các cuộc trò chuyện trên máy tính | Cài trên máy tính, rồi [mở trên điện thoại](#opening-it-on-your-phone) |

Dù chọn cách nào, bạn vẫn cần một mô hình để trò chuyện cùng: một khóa API từ nhà cung cấp, hoặc một backend chạy cục bộ như KoboldCpp hay Ollama.

<a id="android-app"></a>

### Ứng dụng Android

Trên Android 11 trở lên, hãy tải tệp có đuôi `-android-arm64.apk` từ [bản phát hành mới nhất](https://github.com/platberlitz/Neconyan/releases/latest) rồi mở nó. Nhiều khả năng Android sẽ yêu cầu bạn cho phép trình duyệt cài đặt ứng dụng trước.

Mọi thứ chạy ngay trên điện thoại, nên không cần đến Termux hay máy tính. Hãy để trống khoảng 2 GiB và kiên nhẫn chờ ở lần mở đầu tiên để ứng dụng giải nén. Ứng dụng cũng cần Android System WebView 124 trở lên, và sẽ báo cho bạn biết nếu phiên bản trên máy bạn quá cũ. Để cập nhật, hãy cài APK mới đè lên bản cũ, các cuộc trò chuyện của bạn vẫn còn nguyên. [Cài đặt, sao lưu và hướng dẫn build cho Android.](../android/README.md)

<a id="iphone-app"></a>

### Ứng dụng iPhone

Giờ đã có cả ứng dụng iPhone độc lập. Ý tưởng giống bản Android: máy chủ, các cuộc trò chuyện và cài đặt của bạn đều nằm trên điện thoại, nên bạn không cần một máy tính chạy Neconyan. Ứng dụng không có trên App Store, nên bạn phải tự sideload.

1. Mở [trang phát hành](https://github.com/platberlitz/Neconyan/releases/latest) và tải tệp có đuôi `-ios-unsigned.ipa` nếu bản phát hành đó có. Nếu không có, hãy dùng [cách thiết lập qua trình duyệt](#opening-it-on-your-phone).
2. Chọn tệp đó trong một công cụ sideload như [iloader](https://github.com/nab138/iloader). Công cụ sẽ ký ứng dụng bằng tài khoản Apple của bạn rồi cài đặt. Bạn cần iOS 17 trở lên.
3. Mở Neconyan và kết nối một mô hình từ **Kết nối**, giống như ở mọi nơi khác.

Với tài khoản Apple miễn phí, ứng dụng phải được ký lại sau mỗi bảy ngày và bạn chỉ được sideload ba ứng dụng. Để cập nhật, hãy cài IPA mới đè lên bản cũ bằng cùng một tài khoản Apple, các cuộc trò chuyện của bạn vẫn còn nguyên. Xóa ứng dụng là xóa luôn các cuộc trò chuyện, nên nếu định đổi công cụ sideload, hãy xuất một bản sao lưu tài khoản trước.

Quá trình nhập dữ liệu vẫn tiếp tục khi bạn chuyển ứng dụng hoặc khóa điện thoại. Hãy chọn bản sao lưu bằng chính nút **Nhập ZIP sao lưu** của ứng dụng, xác nhận, và máy chủ sẽ lo phần còn lại, phát một đoạn âm thanh im lặng để iOS không đóng băng máy chủ trong lúc xử lý, còn bạn thì có thể quay lại xem bất cứ lúc nào. Câu trả lời cũng chạy tiếp, giống như trong một tab trình duyệt trên máy tính: nếu bạn rời đi giữa chừng, trang sẽ tự phát một âm thanh im lặng cho đến khi câu trả lời được viết xong, được lưu lại và mọi Tác nhân chạy sau đó đã chạy xong. Trong lúc đó, bạn có thể thấy dòng “Neconyan is finishing a reply” trên màn hình khóa, và nhạc từ ứng dụng khác có thể tạm dừng cho đến khi xong. iOS vẫn có thể đóng ứng dụng nếu điện thoại thiếu RAM. Trong lúc bản sao lưu đang được chép vào, hãy để trống dung lượng khoảng gấp đôi kích thước của nó. [Cài đặt, giới hạn và hướng dẫn build cho iPhone.](../ios/README.md)

<a id="on-a-computer"></a>

### Trên máy tính

1. **Tải Neconyan về.** Có hai cách, và cách thứ hai tự cập nhật được.

   - **Tải xuống.** Lấy tệp có đuôi `-source.zip` từ [bản phát hành mới nhất](https://github.com/platberlitz/Neconyan/releases/latest) và giải nén vào chỗ nào dễ tìm, như thư mục Documents. Trên Windows, hãy nhấp chuột phải vào tệp zip và chọn **Extract All** trước, vì chạy trình khởi động từ bên trong tệp zip sẽ không được. Bạn sẽ có một thư mục mang tên phiên bản, như `Neconyan-1.3.7`.
   - **Clone bằng [Git](https://git-scm.com/downloads).** Mở terminal ở nơi bạn muốn đặt thư mục và chạy dòng bên dưới. Từ đó, mỗi lần bạn khởi động, trình khởi động sẽ kiểm tra xem có phiên bản mới không và cập nhật trước khi mở, nên nếu là mình thì mình sẽ chọn cách này.

     ```sh
     git clone https://github.com/platberlitz/Neconyan.git
     ```

2. **Khởi động.** Mở thư mục Neconyan và chạy trình khởi động dành cho hệ điều hành của bạn.

   | Hệ điều hành | Cách làm |
   | --- | --- |
   | Windows | Nhấp đúp vào `Start.bat` |
   | macOS | Nhấp đúp vào `Start.command` |
   | Linux hoặc WSL | Mở terminal trong thư mục và chạy `./start.sh` |

   Lần khởi động đầu tiên mất vài phút. Nếu máy bạn chưa có Bun hoặc Node.js (các chương trình thực sự chạy Neconyan), trình khởi động sẽ cài Bun cho bạn, rồi tải mọi thứ khác mà Neconyan cần. Hãy để cửa sổ đó mở trong suốt lúc dùng Neconyan; đóng cửa sổ, hoặc nhấn Ctrl+C trong đó, sẽ làm Neconyan dừng lại.

3. **Mở Neconyan.** Trình duyệt sẽ tự mở ra. Nếu không, hãy truy cập **http://127.0.0.1:4433/**.
4. **Kết nối mô hình.** Nhấp **Kết nối** ở thanh bên, chọn nhà cung cấp và mô hình, rồi dán khóa API hoặc địa chỉ backend cục bộ của bạn. Sau đó, hãy nhập một nhân vật hoặc chào Miso, Taro hay Nori ở Trang chủ.

Lần sau, bạn chỉ cần chạy lại đúng trình khởi động đó.

**Cập nhật.** Bản cài bằng Git tự cập nhật mỗi khi bạn khởi động. Với bản zip, hãy tải bản mới và giải nén vào một thư mục mới, đóng Neconyan, rồi sao chép thư mục `data` từ thư mục Neconyan cũ sang thư mục mới, kèm cả `config.yaml` nếu bạn đã chỉnh sửa nó. Khởi động bản mới và kiểm tra các cuộc trò chuyện vẫn còn đủ trước khi xóa thư mục cũ.

<a id="android-with-termux"></a>

### Android qua Termux

[Termux](https://termux.dev/) là một ứng dụng terminal cho Android. Cách này lỉnh kỉnh hơn ứng dụng ở trên, nhưng chạy được cả trên điện thoại đời cũ.

1. Cài Termux từ [F-Droid](https://f-droid.org/packages/com.termux/) hoặc [trang phát hành trên GitHub của Termux](https://github.com/termux/termux-app/releases).
2. Mở Termux và cập nhật. Nếu nó dừng lại để hỏi về một tệp cấu hình, hãy nhấn Enter để giữ tệp hiện tại.

   ```sh
   pkg update && pkg upgrade -y
   ```

3. Cài Git, rồi tải Neconyan về thư mục home của Termux. `--depth 1` bỏ qua lịch sử cũ của dự án nên lượng dữ liệu tải về nhỏ hơn, mà việc cập nhật vẫn hoạt động bình thường.

   ```sh
   pkg install -y git
   ```

   ```sh
   git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan
   ```

4. Khởi động. Lần đầu tiên sẽ cài Node.js và mọi thứ khác mà Neconyan cần, nên hãy chờ vài phút.

   ```sh
   cd ~/Neconyan && bash start.sh
   ```

5. Khi thấy `Go to: http://127.0.0.1:4433/ to open Neconyan`, hãy mở địa chỉ đó trong Chrome hoặc trình duyệt bất kỳ trên điện thoại. Sau đó kết nối mô hình từ **Kết nối**, giống như trên máy tính.

Vài thói quen nên tập khi dùng Termux:

- Để dừng Neconyan, chạm **CTRL** trên hàng phím phụ, rồi chạm **C**.
- Lần sau, hãy mở Termux và chạy lại `cd ~/Neconyan && bash start.sh`. Nó sẽ tự cập nhật trước khi khởi động.
- Hãy để thư mục nằm trong home của Termux. Trình khởi động sẽ từ chối chạy từ bộ nhớ dùng chung như `/sdcard`, vì ở đó Android chặn các liên kết tệp mà các gói của Neconyan cần.
- Trong menu của Chrome, **Thêm vào màn hình chính** sẽ cho Neconyan một biểu tượng riêng.

**Giữ Neconyan chạy nền.** Android rất thích dừng những ứng dụng bạn không để mắt tới, và Termux cũng không ngoại lệ. Các bước sau giúp Neconyan sống sót trong lúc bạn dùng ứng dụng khác:

1. Kéo thanh thông báo xuống và kiểm tra xem thông báo của Termux có ghi là đang giữ wake lock không. Neconyan tự xin wake lock khi khởi động; nếu chưa giữ được, hãy chạm **Acquire wakelock** ngay ở thông báo đó.
2. Mở **Cài đặt → Ứng dụng → Termux → Pin** của Android và chọn **Không hạn chế**. Tên các mục mỗi hãng điện thoại một khác, nên nếu không tìm thấy, hãy tìm “tối ưu hóa pin” trong Cài đặt.
3. Từ Android 12 trở lên, Android còn tắt các tiến trình phụ mà Termux khởi chạy, và Neconyan là một trong số đó. Trên Android 14 trở lên, hãy bật Tùy chọn cho nhà phát triển (chạm vào **Số bản dựng** trong **Giới thiệu về điện thoại** bảy lần), rồi bật **Disable child process restrictions**. Trên Android 12 và 13 không có công tắc này, nên bạn phải chạy hai lệnh sau một lần từ máy tính có `adb` và đã bật gỡ lỗi USB:

   ```sh
   adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent"
   ```

   ```sh
   adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   ```

Ngay cả khi máy chủ vẫn đang chạy, sau một lúc Chrome vẫn có thể tự giải phóng trang, nên Neconyan sẽ tải lại khi bạn quay lại. Nếu điều đó làm bạn khó chịu, hãy bật **Stay open in the background** trong **Cài đặt → Hệ thống & Thiết bị → Memory and performance**. Tính năng này phát một âm thanh nhỏ đến mức không nghe thấy trong lúc bạn đi vắng, nên Chrome coi Neconyan như một trình phát nhạc và để yên cho nó. Đổi lại, nó tốn thêm chút pin, hiện một thông báo phát nội dung đa phương tiện và có thể làm dừng nhạc đang phát trong ứng dụng khác, nên mặc định nó được tắt. Đến giờ mình mới chỉ thử nó trên trình duyệt điện thoại giả lập, chưa thử trên điện thoại thật, nên nếu điện thoại của bạn phớt lờ nó thì báo mình biết nhé.

<a id="opening-it-on-your-phone"></a>

### Mở trên điện thoại

Nếu Neconyan chạy trên máy tính của bạn, điện thoại cũng dùng được, miễn là cả hai cùng kết nối một mạng Wi-Fi. Đây cũng là cách nên dùng trên iPhone nếu bạn không muốn sideload [ứng dụng iPhone](#iphone-app).

Cả hai trình duyệt dùng chung dữ liệu. Còn nếu bạn cần chuyển một bản cài ngoại tuyến giữa các thiết bị, hãy đọc [Chuyển dữ liệu giữa các thiết bị](../docs/data-portability.md), kể cả phần thiết lập thư mục dữ liệu trên GitHub, trước khi sao chép hay đồng bộ thư mục.

1. Dừng Neconyan và mở `config.yaml` trong thư mục Neconyan bằng trình soạn thảo văn bản bất kỳ. Tệp này xuất hiện sau lần khởi động đầu tiên. Đổi `listen: false` thành `listen: true`.
2. Nhân tiện, hãy bật mật khẩu, vì nếu không thì bất kỳ ai dùng chung Wi-Fi với bạn cũng mở được. Đặt `basicAuthMode: true`, rồi đổi `username` và `password` bên dưới `basicAuthUser`.
3. Khởi động lại Neconyan và tìm địa chỉ cục bộ của máy tính.
   - **Windows:** chạy `ipconfig` trong Command Prompt và tìm dòng **IPv4 Address**.
   - **macOS:** giữ phím Option và nhấp vào biểu tượng Wi-Fi trên thanh menu, rồi tìm **IP Address**.
   - **Linux:** chạy `hostname -I`.
4. Trên trình duyệt của điện thoại, nhập địa chỉ đó với `http://` ở đầu và `:4433` ở cuối, ví dụ `http://192.168.1.20:4433`.

Nếu Windows hỏi có cho Bun hoặc Node.js đi qua tường lửa không, hãy cho phép trên mạng riêng tư. Nếu điện thoại hiện một trang chỉ ghi **Bị cấm**, nghĩa là mạng của bạn cấp các địa chỉ bắt đầu bằng `10.`, loại địa chỉ mà Neconyan chặn theo mặc định. Hãy thêm dòng này bên dưới `whitelist:` trong `config.yaml`, rồi khởi động lại Neconyan:

```yaml
  - 10.0.0.0/8
```

<details>
<summary><b>Chọn Node.js hay Bun, và các tùy chọn khác của trình khởi động</b></summary>

Mỗi hệ điều hành còn có trình khởi động riêng cho Node.js và cho Bun, nếu bạn muốn tự chọn:

| Hệ điều hành | Node.js | Bun |
| --- | --- | --- |
| Windows | `Start-Node.bat` | `Start-Bun.bat` |
| macOS | `Start-Node.command` | `Start-Bun.command` |
| Linux / WSL | `./start-node.sh` | `./start-bun.sh` |
| Android (Termux) | `bash start-termux-node.sh` | `bash start-termux-bun.sh` |

Để cài thủ công, bạn cần Node.js 20 trở lên:

```sh
npm install
npm run start:node
```

Bun 1.3.14 trở lên cũng được: chạy `bun install`, rồi `bun run start`, hoặc `bun run start:mobile` để dùng ít bộ nhớ hơn. Hãy giữ nguyên tệp `.npmrc` của repo.

Để bản cài bằng Git thôi tự cập nhật, hãy đặt `NECONYAN_AUTO_UPDATE=0` trước khi chạy trình khởi động.

</details>

<details>
<summary><b>Nếu có gì đó không khởi động được</b></summary>

- **Windows báo đã bảo vệ PC của bạn:** nhấp **More info**, rồi **Run anyway**. Windows báo như vậy với hầu hết các trình khởi động tải từ mạng về.
- **macOS không mở `Start.command` vì nó đến từ một nhà phát triển không xác định:** nhấp chuột phải vào tệp và chọn **Open**. Trên các phiên bản macOS mới hơn, thay vào đó, hãy vào **System Settings → Privacy & Security** và nhấp **Open Anyway**.
- **macOS hoặc Linux báo trình khởi động không có quyền thực thi:** chạy lệnh này trong thư mục Neconyan.

  ```sh
  chmod +x Start*.command start*.sh scripts/*.sh
  ```

- **Bản cài bằng Git không tự cập nhật nữa:** trình khởi động sẽ bỏ qua việc cập nhật nếu bạn đã sửa bất kỳ tệp nào của chính Neconyan, và sẽ nói lý do khi khởi động. Các cuộc trò chuyện và `config.yaml` của bạn không tính.
- **Android:** Node.js là lựa chọn mặc định trong Termux. Bun cần thêm hai gói, và trình khởi động Bun sẽ thử cài chúng giúp bạn. Nếu không được, hãy tự cài:

  ```sh
  pkg update && pkg install -y glibc-repo && pkg install -y glibc-runner
  ```

  Hãy đặt `GLIBC_ROOT` nếu glibc của bạn nằm ở chỗ khác ngoài `$PREFIX/glibc`.

- **Cổng 4433 đã bị chiếm:** thêm `--port` với một số khác, hoặc đổi cổng trong `config.yaml`.

</details>

### Bạn chuyển từ SillyTavern hoặc SillyBunny sang?

Phần lớn nhân vật, cuộc trò chuyện, lorebook, persona và preset của bạn sẽ chuyển sang ổn thỏa, nhưng mình không dám hứa là mọi thứ đều vậy, và các tiện ích mở rộng dựa vào bố cục trang của SillyTavern có thể sẽ cần sửa.

- **Hãy sao lưu bản cài cũ trước**, và giữ bản sao lưu đó cho đến khi bạn đã kiểm tra mọi thứ đều chạy ổn.
- **Cho Neconyan một thư mục dữ liệu riêng.** Đừng bao giờ để hai ứng dụng dùng chung một thư mục.

Neconyan tự tạo `config.yaml` và thư mục `data/` riêng ở lần chạy đầu tiên. Dữ liệu cá nhân, khóa và các gói đã cài của bạn không bao giờ nằm trong bản phát hành.

<details>
<summary><b>Dành cho nhà phát triển</b></summary>

`main` chứa các bản chụp của từng lần phát hành, còn `staging` là nơi công việc diễn ra. Hãy dùng một bản checkout và thư mục dữ liệu riêng để thử nghiệm, để các cuộc trò chuyện thường ngày của bạn không bị lẫn vào.

```sh
npm run lint
npm run build:frontend
npm run check:frontend-budgets
npm --prefix tests install
npm --prefix tests run test:unit
```

Các bài kiểm thử trình duyệt nằm trong `tests/` và chạy trên một máy chủ dùng một lần rồi bỏ: đặt `NECONYAN_TEST_BASE_URL` thành địa chỉ của máy chủ đó (mặc định là `http://127.0.0.1:4433`). Hãy build frontend trước khi chạy kiểm thử, và khởi động lại máy chủ sau khi build lại. Ảnh chụp màn hình tạm, báo cáo kiểm thử, kết quả build và các thư mục runtime cục bộ không được đưa vào commit.

</details>

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Ghi công">
</p>

Neconyan được xây dựng trên công sức của tất cả những người đứng sau SillyTavern và SillyBunny; không có họ thì sẽ không có những thứ này. Các công cụ đi kèm và những dự án gốc của chúng được ghi công trong [danh sách công cụ đi kèm](../docs/neconyan-native-tools.md).

Do [Platberlitz](https://github.com/platberlitz) làm ra. Phát hành theo giấy phép [GNU AGPL v3](../LICENSE), nên nếu bạn phân phối lại, hãy giữ nguyên các thông báo và giấy phép.
