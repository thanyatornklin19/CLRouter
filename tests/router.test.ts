import { describe, expect, test } from 'claude-code/testing'

import { modelTitle, route, tierInText, tierOfModel } from '../hooks/router'

const MODELS = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' }

describe('route', () => {
  test('sends quick questions and small edits to Haiku', async () => {
    for (const prompt of [
      'what is a closure in JavaScript?',
      'fix the typo in the README',
      'translate this sentence to English: ขอบคุณมาก',
      'rename getUser to fetchUser',
      'summarize this file',
      'Closure ใน JavaScript คืออะไร',
      'ช่วยแปลประโยคนี้เป็นภาษาอังกฤษ',
    ]) {
      expect(route(prompt)?.tier).toBe('haiku')
    }
  })

  test('keeps routine coding on Sonnet', async () => {
    for (const prompt of [
      'Implement a REST endpoint for user signup with validation and unit tests',
      'add a loading spinner to the submit button component',
      'why does this throw?\n```ts\nconst x: string = undefined as any\nx.length\n```',
    ]) {
      expect(route(prompt)?.tier).toBe('sonnet')
    }
  })

  test('sends architecture, deep debugging and wide changes to Opus', async () => {
    for (const prompt of [
      'Design the architecture for a multi-tenant billing system and plan the migration from our monolith',
      'Refactor the auth flow across the entire codebase to use the new session API',
      'Investigate the root cause of the race condition in the payment worker under load',
      'ช่วยออกแบบสถาปัตยกรรมระบบ microservices สำหรับร้านค้าออนไลน์ และวางแผนการย้ายระบบ',
      'Update src/api/user.ts, src/api/order.ts, src/db/schema.sql and web/pages/cart.tsx to add soft deletes',
    ]) {
      expect(route(prompt)?.tier).toBe('opus')
    }
  })

  test('abstains on follow-ups and bare requests that need the conversation', async () => {
    for (const prompt of ['yes', 'ok do it', 'continue', 'ทำต่อ', 'โอเค', 'and the other one', '']) {
      expect(route(prompt)).toBeNull()
    }
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
