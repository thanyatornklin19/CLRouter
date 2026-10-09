<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <img alt="CLRouter: เลือกโมเดลและ effort ให้เหมาะกับทุก prompt" src="assets/banner-light.svg">
</picture>

<p align="center">
  <a href="#ติดตั้ง">ติดตั้ง</a> ·
  <a href="docs/how-it-works.md">ทำงานอย่างไร</a> ·
  <a href="bench/thai-tax">ผลวัด</a> ·
  <a href="README.md">English</a>
</p>

ใช้ Opus ที่ effort สูงกับทุก prompt คือค่าเริ่มต้นที่แพงที่สุด CLRouter เลือกโมเดลและ effort ให้ทีละ prompt ตามที่วัดมาแล้วว่าแต่ละตัวเก่งงานแบบไหน และถามคุณก่อนเปลี่ยนทุกครั้ง

```
 CLRouter
 Haiku fits this prompt (question or explanation). Run it on Haiku at low effort instead of Opus?

 ❯ 1. Use Haiku for this prompt
   2. Keep Opus
   3. Auto-route this session
   4. Turn off this session
```

## วัดจริง ไม่ได้เดา

โจทย์เดียวกันคือสร้างเว็บคำนวณภาษีเงินได้ ให้แต่ละโมเดลทำ แล้วตรวจด้วยเทสต์ลับ 20 ข้อ:

| โมเดลและ effort | ราคา | เทสต์ลับ | หมายเหตุ |
| :-- | --: | :-: | :-- |
| Opus · high | $0.56 | 19/20 | |
| **Sonnet · medium** | **$0.16** | **20/20** | |
| Haiku · medium | $0.07 | 18/20 | หน้าเว็บดูเสร็จสมบูรณ์ แต่คำนวณภาษีผิด |

งานโค้ดจึงไป Sonnet งานตอบคำถามไป Haiku ส่วนงานที่มีกฎภาษีหรือเรื่องเงิน ไม่ส่งไป Haiku เด็ดขาด [ดูผลทั้งหมด →](bench/thai-tax)

## ติดตั้ง

พิมพ์ใน Claude Code:

```
/plugin install clrouter --marketplace thanyatornklin19/CLRouter
```

ใช้ได้ทั้งกับ API key และแผน Pro/Max

## ทำอะไรได้บ้าง

- **เลือกโมเดล**: ตอบคำถามไป Haiku, งานโค้ดและงานที่มีกฎตายตัวไป Sonnet, งานออกแบบระบบและตรวจความปลอดภัยไป Opus
- **เลือก effort**: งานตอบคำถามใช้ low, งานโค้ดใช้ medium, งานยากใช้ high และไม่ใช้ max เด็ดขาด
- **เปลี่ยนโมเดลเฉพาะตอนที่ถูกกว่าจริง** โดยคิดรวมค่า cache ที่ต้องสร้างใหม่ด้วย
- **จำคำตอบของคุณ**: ตอบตกลงสองครั้ง จะเลิกถาม ปฏิเสธสามครั้ง จะเลิกเสนอ
- **บอกว่าประหยัดไปเท่าไร** ทั้งเป็นเงิน และเป็นโควตา 5 ชั่วโมงที่ใช้ไป:

```
› /clrouter stats
CLRouter, last 7 days: 212 turns.
- Sent to another model: 64 (Haiku 51, Sonnet 13). Effort only: 98. Left alone: 50.
- Those turns cost $0.41. On your session's model they'd have cost at least $2.90: saved at least $2.49.
- Five-hour window used per turn: Haiku 0.1%, Sonnet 0.8%, Opus 2.3%.
```

<sub>เป็นตัวอย่างเท่านั้น ตัวเลขจริงมาจากการใช้งานของคุณเอง</sub>

## คำสั่ง

| คำสั่ง | ทำอะไร |
| :-- | :-- |
| `/clrouter` | แสดงโหมด สิ่งที่จำไว้ และการตัดสินใจครั้งล่าสุด |
| `/clrouter stats [วัน]` | แสดงค่าใช้จ่าย เงินที่ประหยัด และโควตา 5 ชั่วโมง |
| `/clrouter test <ข้อความ>` | บอกว่า prompt นี้จะได้โมเดลและ effort อะไร พร้อมเหตุผล |
| `/clrouter ask \| auto \| suggest \| off` | ตั้งโหมดสำหรับ session นี้ |
| `/clrouter forget` | ล้างคำตอบที่จำไว้ |
| `/clrouter:dev <งาน>` | เขียนเทสต์แล้วล็อกไว้ จากนั้นให้โมเดลถูกที่สุดที่ทำผ่านเป็นคนเขียนโค้ด (ทดลอง) |

## ควรรู้

- **ยังเป็นเบต้า** สร้างบน plugin API ของ Claude Code ที่ยังเป็น early access (ทดสอบบน 2.1.295) API นี้อาจเปลี่ยนได้
- **ความแม่น**: กับ prompt ที่ไม่ได้ใช้ปรับมาก่อน เลือกถูก 14 จาก 20 ครั้ง และไม่เคยส่งงานโค้ดหรืองานที่มีกฎตายตัวไป Haiku
- **ตัวเลขประหยัดเป็นค่าขั้นต่ำ** ไม่บอกเกินจริง และถ้าขาดทุนจะบอกว่าขาดทุน
- **ยังไม่ได้วัด**: การเลือกงานระดับ Opus และการอ่านโควตา 5 ชั่วโมงบนบัญชี Pro จริง

<sub>[ทำงานอย่างไร](docs/how-it-works.md) · [ผลวัด](bench/thai-tax) · MIT</sub>
