<!-- Translated from README.md at commit de66c177 (Neconyan 1.5.0). Keep the structure in step with the English README. -->

# Neconyan~

Bản phát hành mới nhất là [1.5.0](https://github.com/platberlitz/Neconyan/releases/latest).

**Đọc bằng ngôn ngữ của bạn:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [ไทย](readme-th_th.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

Bản dịch này có thể cập nhật chậm hơn. [README tiếng Anh](../README.md) là bản mới nhất.

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - Frontend nhập vai với LLM dễ thương nhất">
</p>

Neconyan là bản fork mang chủ đề mèo mà mình tách ra từ [SillyTavern](https://github.com/SillyTavern/SillyTavern) và [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny), dùng để trò chuyện và nhập vai với nhân vật AI trên máy tính hoặc trên điện thoại. Khóa API hay mô hình cục bộ thì bạn tự lo; ứng dụng không đi kèm quyền truy cập mô hình hay credit nào.

**[Tải Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[Đọc cẩm nang](https://platberlitz.github.io/neconyan-docs/)** · **[Nhờ trợ giúp](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> Toàn bộ mã nguồn ở đây đều do LLM viết hoặc viết với sự hỗ trợ của LLM. Mọi prompt và tác nhân đi kèm Neconyan đều do con người làm ra.

## Bên trong có gì?

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="Tại sao chọn Neconyan?">
</p>

- **Bốn cách trò chuyện:** Nhập vai kiểu cổ điển, Hội thoại kiểu ứng dụng nhắn tin, một bảng tin mạng xã hội tên là Meower, và Chế độ câu chuyện cho văn xuôi liền mạch.
- **Bố cục được làm riêng cho điện thoại**, với các nút điều khiển có ghi nhãn, thanh trò chuyện ở dưới cùng và một menu trượt. **Simple Mode** ẩn bớt những nút ít dùng cho đến khi bạn cần đến.
- **Mewmory** ghi nhớ các diễn biến và nhân vật trong câu chuyện. **Tác nhân** có thể duy trì các trình theo dõi, kiểm tra một câu trả lời hoặc viết một Ghi chú đồng hành riêng.
- **Catelier** giúp bạn viết thẻ nhân vật và lorebook. **Sổ ghi chép** giữ ghi chú của bạn ngay trong tầm tay, còn **Scratchpad** cho bạn một khung trò chuyện riêng để bàn bạc ý tưởng.
- **Miso, Taro và Nori** giúp bạn tìm những thứ bạn cần và có thể thực hiện những chỉnh sửa được hỗ trợ nếu bạn cho phép.
- **Chủ đề, màu nhấn và mèo.** Khá nhiều mèo. Bạn có thể ẩn chúng đi, dù mình không tưởng tượng nổi vì sao bạn lại muốn thế.

Thẻ nhân vật, cuộc trò chuyện, lorebook và preset của bạn dùng các định dạng quen thuộc của SillyTavern. Không có telemetry. Một số tính năng và tiện ích mở rộng của bản gốc hoạt động khác ở đây; mình chỉ lấy về những phần mình muốn. [Danh sách công cụ đi kèm](../docs/neconyan-native-tools.md) ghi công các dự án đi kèm Neconyan.

## Xem qua một chút

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="Các chế độ">
</p>

Ảnh chụp màn hình mới trên máy tính và điện thoại, dùng các cuộc trò chuyện và ghi chú demo cùng với các trợ lý đi kèm.

### Trang chủ

Chọn một nhân vật, kết nối mô hình hoặc chào một trợ lý.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="Trang chủ trên máy tính"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="Trang chủ trên điện thoại"></td>
</tr></table>

### Nhập vai

Viết một cảnh truyện, thử một câu trả lời khác hoặc tiếp tục một cuộc trò chuyện cũ.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="Nhập vai trên máy tính"></td>
  <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="Nhập vai trên điện thoại"></td>
</tr></table>

### Catelier

Soạn bản nháp nhân vật, nhờ hỗ trợ viết lách và xem lại các thay đổi trước khi lưu vào thư viện của bạn.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-catelier.webp" alt="Catelier trên máy tính"></td>
  <td width="28%"><img src="../docs/readme/phone-catelier.webp" alt="Catelier trên điện thoại"></td>
</tr></table>

<details>
<summary><b>Thêm ảnh chụp màn hình: Simple Mode, Hội thoại, Meower, Chế độ câu chuyện, Sổ ghi chép và Scratchpad</b></summary>

### Simple Mode

Ít nút điều khiển hơn trong lúc bạn làm quen. **Show all features** ở thanh bên sẽ đưa chúng trở lại; không có gì bị tắt cả.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Simple Mode trên máy tính"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Simple Mode trên điện thoại"></td>
</tr></table>

### Hội thoại

Nhắn tin với nhân vật của bạn, tạo trò chuyện nhóm và để họ có lúc bận hoặc ngoại tuyến.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="Hội thoại trên máy tính"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="Hội thoại trên điện thoại"></td>
</tr></table>

### Meower

Một bảng tin mạng xã hội nơi các nhân vật của bạn đăng bài, trả lời và mở bình chọn.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower trên máy tính"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower trên điện thoại"></td>
</tr></table>

### Chế độ câu chuyện

Đọc cuộc trò chuyện của bạn như văn xuôi liền mạch.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="Chế độ câu chuyện trên máy tính"></td>
  <td width="28%"><img src="../docs/readme/phone-story.webp" alt="Chế độ câu chuyện trên điện thoại"></td>
</tr></table>

### Sổ ghi chép

Giữ kế hoạch cảnh truyện, địa điểm và nhật ký mỗi buổi chơi ngay cạnh các cuộc trò chuyện của bạn.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Sổ ghi chép trên máy tính"></td>
  <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Sổ ghi chép trên điện thoại"></td>
</tr></table>

### Scratchpad

Bàn về câu chuyện với một trợ lý hoặc cả một bàn tròn gồm các nhân vật, mà không đưa cuộc thảo luận của họ vào cuộc trò chuyện chính.

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad trên máy tính"></td>
  <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad trên điện thoại"></td>
</tr></table>

</details>

## Bắt đầu

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="Bắt đầu">
</p>

### Trên máy tính

1. Tải tệp có đuôi **-source.zip** từ [bản phát hành mới nhất](https://github.com/platberlitz/Neconyan/releases/latest). Hãy giải nén nó trước; trên Windows, nhấp chuột phải và chọn **Extract All**.
2. Mở thư mục. Chạy **Start.bat** trên Windows, **Start.command** trên macOS, hoặc **bash start.sh** trong terminal trên Linux.
3. Hãy cho lần khởi động đầu tiên vài phút để cài những thứ cần thiết. Giữ cửa sổ terminal luôn mở trong lúc bạn dùng Neconyan.
4. Trình duyệt của bạn sẽ tự mở ra. Nếu không, hãy truy cập **http://127.0.0.1:4433/**.
5. Mở **Kết nối**, chọn nhà cung cấp và mô hình, rồi nhập khóa API hoặc địa chỉ của mô hình cục bộ. Sau đó, hãy mở một nhân vật hoặc một trợ lý ở Trang chủ.

Lần sau, bạn chỉ cần chạy lại đúng trình khởi động đó. Để dừng Neconyan, nhấn **Ctrl+C** trong terminal của nó.

Bạn thích dùng Git hơn? Hãy clone repository, rồi dùng cùng trình khởi động đó:

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[Cài đặt trên máy tính và các sự cố khởi động thường gặp](https://platberlitz.github.io/neconyan-docs/start/computer/)

### Ứng dụng Android

Tải tệp **-android-arm64.apk** từ [bản phát hành mới nhất](https://github.com/platberlitz/Neconyan/releases/latest) rồi mở nó. Nếu Android hỏi, hãy cho phép trình duyệt của bạn cài đặt ứng dụng. Bạn cần **Android 11 trở lên**, **Android System WebView 124 trở lên** và còn trống khoảng **2 GiB**.

Ứng dụng chạy ngay trên điện thoại, không cần Termux hay máy tính. Hãy để lần mở đầu tiên có thời gian giải nén, rồi thiết lập **Kết nối**. Hãy cài bản cập nhật đè lên ứng dụng hiện có để giữ lại các cuộc trò chuyện của bạn.

[Cài đặt Android](https://platberlitz.github.io/neconyan-docs/start/android/) · [Hướng dẫn build](../android/README.md)

### Ứng dụng iPhone

Tải tệp **-ios-unsigned.ipa** từ [bản phát hành mới nhất](https://github.com/platberlitz/Neconyan/releases/latest), rồi cài nó bằng một công cụ sideload như [iloader](https://github.com/nab138/iloader). Bạn cần **iOS 17 trở lên**. Ứng dụng giữ máy chủ và các cuộc trò chuyện của nó ngay trên điện thoại; nó không có trên App Store.

Với tài khoản Apple miễn phí, ứng dụng phải được ký lại sau mỗi bảy ngày và bạn chỉ được sideload ba ứng dụng. Hãy cài bản cập nhật đè lên ứng dụng hiện có bằng cùng một tài khoản Apple. **Xóa ứng dụng là xóa luôn dữ liệu của nó**, nên hãy xuất một bản sao lưu trước.

[Cài đặt iPhone và các giới hạn](../ios/README.md)

### Những cách khác để dùng trên điện thoại

- **Android qua Termux:** hãy làm theo [hướng dẫn Termux](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux) nếu bạn thích dùng terminal hoặc có điện thoại đời cũ.
- **Dùng bản cài trên máy tính:** hãy làm theo [hướng dẫn cùng mạng Wi-Fi](https://platberlitz.github.io/neconyan-docs/start/phone/). Cả hai thiết bị dùng chung các cuộc trò chuyện đã lưu; hãy để máy tính luôn chạy.

## Cập nhật, sao lưu và chuyển các cuộc trò chuyện

Mở **Máy chủ → Cập nhật & Khởi động lại → Kiểm tra cập nhật**. Bản cài bằng Git và bản cài từ ZIP mã nguồn được hỗ trợ sẽ có **Cập nhật & Khởi động lại**. Android có **Update APK** và sẽ yêu cầu bạn xác nhận việc cài đặt. Các bản ZIP cũ không có trình cập nhật cần [chuyển thủ công sang thư mục mới hơn](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation).

Bản cài bằng Git cũng tự kiểm tra cập nhật khi khởi động. Những thay đổi bạn đã làm với các tệp của chính ứng dụng có thể khiến việc cập nhật tự động bị dừng; các cuộc trò chuyện và cài đặt của bạn thì không tính.

Bạn chuyển từ SillyTavern hoặc SillyBunny sang? **Hãy sao lưu trước**, cho Neconyan một thư mục dữ liệu riêng, rồi làm theo [Nhập dữ liệu của bạn](https://platberlitz.github.io/neconyan-docs/start/imports/). Hãy kiểm tra nhân vật và các cuộc trò chuyện của bạn trước khi xóa bất cứ thứ gì. Một số tiện ích mở rộng có thể cần chỉnh sửa.

[Sao lưu và khôi phục](https://platberlitz.github.io/neconyan-docs/help/backups/) · [Chuyển dữ liệu giữa các thiết bị](../docs/data-portability.md)

## Cần giúp một tay?

Nếu là mình, mình sẽ bắt đầu từ [cẩm nang](https://platberlitz.github.io/neconyan-docs/), hoặc hỏi Miso, Taro hay Nori ở Trang chủ. Họ có thể nhầm lẫn, nên hãy kiểm tra lời khuyên của họ trước khi thực hiện một thay đổi mà bạn không thể hoàn tác.

Nếu không thấy một cài đặt nào đó, hãy thử **Tìm kiếm** ở thanh bên. Nếu gặp lỗi, hãy xem [hướng dẫn khắc phục sự cố](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) hoặc [mở một issue](https://github.com/platberlitz/Neconyan/issues) kèm theo việc bạn đang làm và lỗi được hiển thị.

## Ghi công

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="Ghi công">
</p>

Neconyan được xây dựng trên công sức của tất cả những người đứng sau SillyTavern và SillyBunny; không có họ thì sẽ không có những thứ này. [Danh sách công cụ đi kèm](../docs/neconyan-native-tools.md) ghi công các tác giả gốc của chúng.

Do [Platberlitz](https://github.com/platberlitz) làm ra. Phát hành theo giấy phép [GNU AGPL v3](../LICENSE). Nếu bạn phân phối lại, hãy giữ nguyên các thông báo và giấy phép.
