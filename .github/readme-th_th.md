<!-- Translated from README.md at commit de66c177 (Neconyan 1.5.0). Keep the structure in step with the English README. -->

# Neconyan~

เวอร์ชันล่าสุดคือ [1.5.0](https://github.com/platberlitz/Neconyan/releases/latest)

**อ่านในภาษาของคุณ:** [English](../README.md) · [Deutsch](readme-de_de.md) · [Español](readme-es_es.md) · [Français](readme-fr_fr.md) · [Italiano](readme-it_it.md) · [Nederlands](readme-nl_nl.md) · [Português](readme-pt_pt.md) · [Íslenska](readme-is_is.md) · [Русский](readme-ru_ru.md) · [Українська](readme-uk_ua.md) · [العربية](readme-ar_sa.md) · [Tiếng Việt](readme-vi_vn.md) · [日本語](readme-ja_jp.md) · [한국어](readme-ko_kr.md) · [简体中文](readme-zh_cn.md) · [繁體中文](readme-zh_tw.md)

ฉบับแปลนี้อาจตามหลังต้นฉบับอยู่บ้าง [README ภาษาอังกฤษ](../README.md) เป็นฉบับล่าสุด

<p align="center">
  <img src="../docs/readme/banner-neconyan.webp" alt="Neconyan - ฟรอนต์เอนด์ RP สำหรับ LLM ที่น่ารักที่สุด">
</p>

Neconyan คือ fork ธีมแมวของฉันที่แยกมาจาก [SillyTavern](https://github.com/SillyTavern/SillyTavern) และ [SillyBunny](https://github.com/SillyBunnyTeam/SillyBunny) เอาไว้แชทและสวมบทบาทกับตัวละคร AI ได้ทั้งบนคอมพิวเตอร์และบนโทรศัพท์ คุณต้องนำคีย์ API หรือโมเดลในเครื่องของคุณเองมาใช้ เพราะแอปไม่ได้รวมสิทธิ์เข้าถึงโมเดลหรือเครดิตมาให้

**[ดาวน์โหลด Neconyan](https://github.com/platberlitz/Neconyan/releases/latest)** · **[อ่านคู่มือ](https://platberlitz.github.io/neconyan-docs/)** · **[ขอความช่วยเหลือ](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/)**

> โค้ดทั้งหมดในนี้เขียนโดย LLM หรือเขียนโดยมี LLM ช่วย แต่พรอมต์และเอเจนต์ทุกตัวที่มากับ Neconyan สร้างขึ้นโดยมนุษย์

## มีอะไรอยู่ในนี้บ้าง

<p align="center">
  <img src="../docs/readme/banner-why.webp" alt="ทำไมต้อง Neconyan?">
</p>

- **แชทได้สี่แบบ:** สวมบทบาทแบบคลาสสิก โหมดสนทนาสไตล์แอปแชท ไทม์ไลน์โซเชียลชื่อ Meower และโหมดเรื่องราวสำหรับงานร้อยแก้วต่อเนื่อง
- **เลย์เอาต์ที่ทำมาเพื่อโทรศัพท์** มีปุ่มควบคุมพร้อมชื่อกำกับ แถบแชทด้านล่าง และเมนูแบบเลื่อนออก **Simple Mode** จะซ่อนปุ่มที่ใช้ไม่บ่อยไว้จนกว่าคุณจะอยากใช้
- **Mewmory** จดจำเหตุการณ์ในเรื่องและตัวละคร ส่วน **เอเจนต์** ช่วยดูแลตัวติดตาม ตรวจคำตอบ หรือเขียน “บันทึกของเพื่อนร่วมทาง” แยกต่างหากได้
- **Catelier** ช่วยคุณเขียนการ์ดตัวละครและ lorebook **Notebooks** เก็บโน้ตของคุณไว้ใกล้มือ ส่วน **Scratchpad** ให้แชทแยกไว้คุยทบทวนไอเดีย
- **Miso, Taro และ Nori** ช่วยคุณหาสิ่งที่ต้องการ และแก้ไขในส่วนที่รองรับได้เมื่อคุณอนุญาต
- **ธีม สีเน้น และแมว** แมวเยอะมากทีเดียว ซ่อนได้นะ แต่ฉันนึกไม่ออกเลยว่าคุณจะอยากซ่อนไปทำไม

การ์ดตัวละคร แชท lorebook และพรีเซ็ตของคุณใช้รูปแบบที่คุ้นเคยจาก SillyTavern และไม่มีการเก็บ telemetry ใด ๆ บางฟีเจอร์และส่วนขยายจากต้นทางทำงานต่างออกไปที่นี่ ฉันดึงมาจากต้นทางเฉพาะส่วนที่ฉันอยากได้ [รายชื่อเครื่องมือที่มาในตัว](../docs/neconyan-native-tools.md) ระบุเครดิตโปรเจกต์ที่รวมมากับ Neconyan

## ลองดูหน้าตา

<p align="center">
  <img src="../docs/readme/banner-modes.webp" alt="โหมดต่าง ๆ">
</p>

ภาพหน้าจอเดสก์ท็อปและโทรศัพท์ชุดใหม่ ใช้แชทและโน้ตตัวอย่างกับผู้ช่วยที่มาในตัว

### หน้าแรก

เลือกตัวละคร เชื่อมต่อโมเดล หรือทักทายผู้ช่วยสักตัว

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-home.webp" alt="หน้าแรกบนเดสก์ท็อป"></td>
  <td width="28%"><img src="../docs/readme/phone-home.webp" alt="หน้าแรกบนโทรศัพท์"></td>
</tr></table>

### สวมบทบาท

เขียนฉาก ลองขอคำตอบอีกแบบ หรือกลับไปคุยแชทเก่าต่อ

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-roleplay.webp" alt="สวมบทบาทบนเดสก์ท็อป"></td>
  <td width="28%"><img src="../docs/readme/phone-roleplay.webp" alt="สวมบทบาทบนโทรศัพท์"></td>
</tr></table>

### Catelier

ทำงานกับร่างตัวละคร ขอให้ช่วยเขียน และตรวจการเปลี่ยนแปลงก่อนบันทึกลงคลังของคุณ

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-catelier.webp" alt="Catelier บนเดสก์ท็อป"></td>
  <td width="28%"><img src="../docs/readme/phone-catelier.webp" alt="Catelier บนโทรศัพท์"></td>
</tr></table>

<details>
<summary><b>ภาพหน้าจอเพิ่มเติม: Simple Mode, สนทนา, Meower, โหมดเรื่องราว, Notebooks และ Scratchpad</b></summary>

### Simple Mode

ปุ่มควบคุมน้อยลงระหว่างที่คุณยังทำความคุ้นเคย กด **Show all features** ในแถบด้านข้างเพื่อเรียกทุกอย่างกลับมา ไม่มีอะไรถูกปิดการทำงาน

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-simple.webp" alt="Simple Mode บนเดสก์ท็อป"></td>
  <td width="28%"><img src="../docs/readme/phone-simple.webp" alt="Simple Mode บนโทรศัพท์"></td>
</tr></table>

### สนทนา

ส่งข้อความหาตัวละครของคุณ สร้างแชทกลุ่ม และปล่อยให้ตัวละครยุ่งหรือออฟไลน์ได้

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-conversation.webp" alt="สนทนาบนเดสก์ท็อป"></td>
  <td width="28%"><img src="../docs/readme/phone-conversation.webp" alt="สนทนาบนโทรศัพท์"></td>
</tr></table>

### Meower

ไทม์ไลน์โซเชียลที่ตัวละครของคุณโพสต์ ตอบกันไปมา และตั้งโพล

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-meower.webp" alt="Meower บนเดสก์ท็อป"></td>
  <td width="28%"><img src="../docs/readme/phone-meower.webp" alt="Meower บนโทรศัพท์"></td>
</tr></table>

### โหมดเรื่องราว

อ่านแชทของคุณเป็นร้อยแก้วต่อเนื่อง

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-story.webp" alt="โหมดเรื่องราวบนเดสก์ท็อป"></td>
  <td width="28%"><img src="../docs/readme/phone-story.webp" alt="โหมดเรื่องราวบนโทรศัพท์"></td>
</tr></table>

### Notebooks

เก็บแผนฉาก สถานที่ และบันทึกประจำเซสชันไว้ข้าง ๆ แชทของคุณ

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-notes.webp" alt="Notebooks บนเดสก์ท็อป"></td>
  <td width="28%"><img src="../docs/readme/phone-notes.webp" alt="Notebooks บนโทรศัพท์"></td>
</tr></table>

### Scratchpad

คุยเรื่องราวกับผู้ช่วย หรือกับตัวละครทั้งวงที่นั่งล้อมโต๊ะกลม โดยไม่เอาการพูดคุยของพวกเขาไปใส่ในแชทหลัก

<table><tr>
  <td width="72%"><img src="../docs/readme/desktop-scratchpad.webp" alt="Scratchpad บนเดสก์ท็อป"></td>
  <td width="28%"><img src="../docs/readme/phone-scratchpad.webp" alt="Scratchpad บนโทรศัพท์"></td>
</tr></table>

</details>

## เริ่มต้นใช้งาน

<p align="center">
  <img src="../docs/readme/banner-getting-started.webp" alt="เริ่มต้นใช้งาน">
</p>

### บนคอมพิวเตอร์

1. ดาวน์โหลดไฟล์ที่ลงท้ายด้วย **-source.zip** จาก[รีลีสล่าสุด](https://github.com/platberlitz/Neconyan/releases/latest) แล้วแตกไฟล์ออกมาก่อน บน Windows ให้คลิกขวาแล้วเลือก **Extract All**
2. เปิดโฟลเดอร์ แล้วรัน **Start.bat** บน Windows, **Start.command** บน macOS หรือ **bash start.sh** ในเทอร์มินัลบน Linux
3. การเปิดครั้งแรกจะใช้เวลาสักสองสามนาทีเพื่อติดตั้งสิ่งที่ต้องใช้ เปิดหน้าต่างเทอร์มินัลค้างไว้ตลอดที่ใช้ Neconyan
4. เบราว์เซอร์ของคุณน่าจะเปิดขึ้นมาเอง ถ้าไม่เปิด ให้ไปที่ **http://127.0.0.1:4433/**
5. เปิด **การเชื่อมต่อ** เลือกผู้ให้บริการและโมเดล แล้วใส่คีย์ API หรือที่อยู่ของโมเดลในเครื่องของคุณ จากนั้นเปิดตัวละครหรือผู้ช่วยที่หน้าแรก

ครั้งต่อไปก็แค่รันตัวเปิดโปรแกรมเดิมอีกครั้ง จะหยุด Neconyan ให้กด **Ctrl+C** ในเทอร์มินัลของ Neconyan

ถ้าชอบ Git มากกว่า ให้โคลนรีโพซิทอรี แล้วใช้ตัวเปิดโปรแกรมเดิม:

```sh
git clone https://github.com/platberlitz/Neconyan.git
```

[การติดตั้งบนคอมพิวเตอร์และปัญหาที่พบบ่อยตอนเริ่มรัน](https://platberlitz.github.io/neconyan-docs/start/computer/)

### แอป Android

ดาวน์โหลดไฟล์ **-android-arm64.apk** จาก[รีลีสล่าสุด](https://github.com/platberlitz/Neconyan/releases/latest) แล้วเปิดไฟล์นั้น ถ้า Android ถาม ให้อนุญาตการติดตั้งแอปจากเบราว์เซอร์ของคุณ คุณต้องมี **Android 11 ขึ้นไป**, **Android System WebView 124 ขึ้นไป** และพื้นที่ว่างประมาณ **2 GiB**

แอปทำงานบนโทรศัพท์ โดยไม่ต้องใช้ Termux หรือคอมพิวเตอร์ ให้เวลาแอปแตกไฟล์ตอนเปิดครั้งแรก แล้วจึงตั้งค่า **การเชื่อมต่อ** เวลาอัปเดตให้ติดตั้งทับแอปที่มีอยู่ แชทของคุณจะได้อยู่ครบ

[การติดตั้งบน Android](https://platberlitz.github.io/neconyan-docs/start/android/) · [วิธีบิลด์](../android/README.md)

### แอป iPhone

ดาวน์โหลดไฟล์ **-ios-unsigned.ipa** จาก[รีลีสล่าสุด](https://github.com/platberlitz/Neconyan/releases/latest) แล้วติดตั้งด้วยเครื่องมือไซด์โหลดอย่าง [iloader](https://github.com/nab138/iloader) คุณต้องมี **iOS 17 ขึ้นไป** แอปเก็บเซิร์ฟเวอร์และแชทไว้บนโทรศัพท์ และไม่มีใน App Store

บัญชี Apple แบบฟรีต้องเซ็นแอปใหม่ทุกเจ็ดวัน และไซด์โหลดได้แค่สามแอป เวลาอัปเดตให้ติดตั้งทับแอปที่มีอยู่ด้วยบัญชี Apple เดียวกัน **การลบแอปจะลบข้อมูลของแอปไปด้วย** ดังนั้นให้ส่งออกข้อมูลสำรองไว้ก่อน

[การติดตั้งบน iPhone และข้อจำกัด](../ios/README.md)

### วิธีอื่นในการใช้งานบนโทรศัพท์

- **Android กับ Termux:** ทำตาม[คู่มือ Termux](https://platberlitz.github.io/neconyan-docs/start/android/#prefer-termux) ถ้าคุณชอบใช้เทอร์มินัลหรือมีโทรศัพท์รุ่นเก่า
- **ใช้การติดตั้งบนคอมพิวเตอร์:** ทำตาม[คู่มือการใช้ Wi-Fi เดียวกัน](https://platberlitz.github.io/neconyan-docs/start/phone/) ทั้งสองอุปกรณ์ใช้แชทที่บันทึกไว้ชุดเดียวกัน และต้องปล่อยให้คอมพิวเตอร์ทำงานอยู่

## การอัปเดต การสำรองข้อมูล และการย้ายแชทของคุณ

เปิด **เซิร์ฟเวอร์ → การอัปเดตและรีสตาร์ท → ตรวจสอบการอัปเดต** แบบที่ติดตั้งด้วย Git และแบบที่ติดตั้งจาก source ZIP ที่รองรับ จะมี **อัปเดตและรีสตาร์ท** ให้เลือก ส่วน Android จะมี **Update APK** และจะขอให้คุณอนุมัติการติดตั้ง สำเนา ZIP รุ่นเก่าที่ไม่มีตัวอัปเดตต้อง[ย้ายไปยังโฟลเดอร์ใหม่ด้วยตัวเอง](https://platberlitz.github.io/neconyan-docs/help/backups/#update-a-zip-installation)

แบบที่ติดตั้งด้วย Git จะเช็กอัปเดตตอนเปิดด้วย การเปลี่ยนแปลงที่คุณทำกับไฟล์ของแอปเองอาจทำให้อัปเดตอัตโนมัติไม่ได้ แต่แชทและการตั้งค่าของคุณไม่นับรวม

ย้ายมาจาก SillyTavern หรือ SillyBunny? **สำรองข้อมูลก่อน** ให้ Neconyan มีโฟลเดอร์ข้อมูลของตัวเอง แล้วทำตามหน้า[นำเข้าข้อมูลของคุณ](https://platberlitz.github.io/neconyan-docs/start/imports/) ตรวจตัวละครและแชทของคุณให้ครบก่อนลบอะไรทิ้ง ส่วนขยายบางตัวอาจต้องปรับแก้

[การสำรองข้อมูลและการกู้คืน](https://platberlitz.github.io/neconyan-docs/help/backups/) · [การย้ายข้อมูลระหว่างอุปกรณ์](../docs/data-portability.md)

## ต้องการความช่วยเหลือไหม

ถ้าเป็นฉัน ฉันจะเริ่มจาก[คู่มือ](https://platberlitz.github.io/neconyan-docs/) หรือถาม Miso, Taro หรือ Nori ที่หน้าแรก พวกเขาตอบผิดได้ ดังนั้นควรตรวจคำแนะนำของพวกเขาก่อนจะเปลี่ยนอะไรที่ย้อนกลับไม่ได้

ถ้าหาการตั้งค่าไม่เจอ ลองใช้ **ค้นหา** ในแถบด้านข้าง ถ้าเจอข้อผิดพลาด ให้ดู[คู่มือแก้ปัญหา](https://platberlitz.github.io/neconyan-docs/help/troubleshooting/) หรือ[เปิด issue](https://github.com/platberlitz/Neconyan/issues) พร้อมบอกว่าคุณกำลังทำอะไรอยู่และเห็นข้อผิดพลาดอะไร

## เครดิต

<p align="center">
  <img src="../docs/readme/banner-credits.webp" alt="เครดิต">
</p>

Neconyan สร้างขึ้นบนผลงานของทุกคนที่อยู่เบื้องหลัง SillyTavern และ SillyBunny ถ้าไม่มีพวกเขา สิ่งเหล่านี้คงไม่เกิดขึ้น [รายชื่อเครื่องมือที่มาในตัว](../docs/neconyan-native-tools.md) ระบุเครดิตผู้สร้างต้นฉบับของเครื่องมือเหล่านั้น

สร้างโดย [Platberlitz](https://github.com/platberlitz) เผยแพร่ภายใต้สัญญาอนุญาต [GNU AGPL v3](../LICENSE) ถ้าคุณนำไปเผยแพร่ต่อ โปรดคงประกาศและสัญญาอนุญาตต่าง ๆ ไว้ตามเดิม
