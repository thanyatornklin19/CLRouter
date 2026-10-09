import { describe, expect, test } from 'claude-code/testing'

import { modelTitle, route, tierInText, tierOfModel } from '../hooks/router'

const MODELS = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' }

describe('route', () => {
  test('sends answering, explaining, translating and small edits to Haiku', async () => {
    for (const prompt of [
      'what is a closure in JavaScript?',
      'explain the difference between let and const',
      'how does useEffect cleanup work?',
      'fix the typo in the README',
      'rename getUser to fetchUser',
      'summarize this file',
      'translate this sentence to English: ขอบคุณมาก',
      'draft a polite email to my landlord about the broken heater',
      'Closure ใน JavaScript คืออะไร',
      'อธิบาย async/await สั้นๆ',
      'ช่วยแปลประโยคนี้เป็นภาษาอังกฤษ',
      'ช่วยเขียนแคปชั่นโพสต์ขายเสื้อให้หน่อย',
    ]) {
      expect(route(prompt)?.tier).toBe('haiku')
    }
  })

  test('sends building and changing code to Sonnet', async () => {
    for (const prompt of [
      'Implement a REST endpoint for user signup with validation and unit tests',
      'add a loading spinner to the submit button component',
      'why does this throw?\n```ts\nconst x: string = undefined as any\nx.length\n```',
      'Update src/api/user.ts, src/api/order.ts, src/db/schema.sql and web/pages/cart.tsx to add soft deletes',
      'convert this CSV to JSON with Python',
      'review this PR for bugs',
      'ทำหน้า login ด้วย React พร้อม validate ฟอร์ม',
      'แปลงไฟล์ CSV เป็น JSON ด้วย Python',
      'ช่วยแก้ให้ปุ่มบันทึกทำงาน มันกดแล้วไม่เกิดอะไร',
    ]) {
      expect(route(prompt)?.tier).toBe('sonnet')
    }
  })

  test('never sends exact rules (tax, money, law) below Sonnet', async () => {
    for (const prompt of [
      'what is the VAT on 12,500 baht?',
      'how much income tax do I pay on 800,000 baht a year?',
      'write a function that calculates compound interest for a loan',
      'สร้างเว็บคำนวณภาษีเงินได้บุคคลธรรมดา ปี 2567',
      'คำนวณภาษีจากเงินเดือน 50,000 บาทต่อเดือน มีประกันสังคม',
      'คิดค่าส่วนลดและ VAT 7% ในตะกร้าสินค้าให้ถูก',
    ]) {
      const verdict = route(prompt)
      expect(verdict?.tier).toBe('sonnet')
      expect(verdict?.floor).toBe('sonnet')
      expect(verdict?.reasons[0]).toBe('exact rules (tax, money, law)')
    }
  })

  test('sends architecture, root causes, security audits and codebase-wide work to Opus', async () => {
    for (const prompt of [
      'Design the architecture for a multi-tenant billing system and plan the migration from our monolith',
      'Refactor the auth flow across the entire codebase to use the new session API',
      'Investigate the root cause of the race condition in the payment worker under load',
      'do a security audit of the login and session handling',
      'we keep getting duplicate charges in production, figure out why across the payment and webhook services',
      'ช่วยออกแบบสถาปัตยกรรมระบบ microservices สำหรับร้านค้าออนไลน์ และวางแผนการย้ายระบบ',
      'ตรวจหาช่องโหว่ในระบบ login ของเรา',
    ]) {
      expect(route(prompt)?.tier).toBe('opus')
    }
  })

  test('a language name is code work in a command, not in a question', async () => {
    expect(route('what is a closure in JavaScript?')?.tier).toBe('haiku')
    expect(route('convert this CSV to JSON with Python')?.tier).toBe('sonnet')
  })

  test('abstains on follow-ups and bare requests that need the conversation', async () => {
    for (const prompt of ['yes', 'ok do it', 'continue', 'ทำต่อ', 'โอเค', 'and the other one', '']) {
      expect(route(prompt)).toBeNull()
    }
  })

  test('scores only what was typed, not the host\'s wrapped blocks', async () => {
    const brief = 'Design the architecture and plan the migration. '.repeat(100)
    const wrapped = `<system-reminder>\n${brief}\n</system-reminder>\nyo`
    expect(route(wrapped)?.tier).toBe('haiku')
    expect(route(`<system-reminder>${brief}</system-reminder>\nok do it`)).toBeNull()
    expect(route(`<ide_selection>${brief}</ide_selection>`)).toBeNull()
  })

  test('never puts pasted code on Haiku by keywords alone', async () => {
    const verdict = route('what is wrong here?\n```py\nprint(1\n```')
    expect(verdict?.tier).toBe('sonnet')
    expect(verdict?.reasons).toContain('includes code')
  })

  test('names the reasons that decided it', async () => {
    const verdict = route('Design the architecture for a multi-tenant billing system')
    expect(verdict?.reasons[0]).toBe('architecture / system design')
    expect(verdict?.confidence).toBe('high')
  })
})

describe('model names', () => {
  test('reads the tier from a model id or a configured name', async () => {
    expect(tierOfModel('claude-opus-5-5', MODELS)).toBe('opus')
    expect(tierOfModel('claude-haiku-5-5', MODELS)).toBe('haiku')
    expect(tierOfModel('my-gateway-model', { ...MODELS, sonnet: 'my-gateway-model' })).toBe('sonnet')
    expect(tierOfModel('claude-fable-5-1', MODELS)).toBeUndefined()
  })

  test('titles a model by its family', async () => {
    expect(modelTitle('claude-sonnet-5-5')).toBe('Sonnet')
    expect(modelTitle('claude-fable-5-1')).toBe('Fable')
    expect(modelTitle('custom')).toBe('custom')
  })

  test('reads a tier typed under Other', async () => {
    expect(tierInText('use sonnet please')).toBe('sonnet')
    expect(tierInText('whatever')).toBeUndefined()
  })
})
