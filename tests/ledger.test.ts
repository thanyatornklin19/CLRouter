import { describe, expect, test } from 'claude-code/testing'

import { expectedOutput, learn, priced, pricedOnSession, summarize, switchPays } from '../hooks/ledger'
import type { TurnRecord } from '../hooks/ledger'

const TOKENS = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 20000 }

const row = (overrides: Partial<TurnRecord>): TurnRecord => ({
  at: 1_000_000,
  kind: 'build',
  from: 'opus',
  ran: 'opus',
  routed: false,
  effort: null,
  asked: false,
  accepted: null,
  aborted: false,
  usd: 0.01,
  would: null,
  quota: 1,
  spent: 0.01,
  out: 500,
  ...overrides,
})

describe('pricing', () => {
  test('prices a turn on the tier that ran it', async () => {
    expect(Math.round(priced(TOKENS, 'haiku') * 1e6)).toBe(2850)
    expect(Math.round(priced(TOKENS, 'sonnet') * 1e6)).toBe(57000)
  })

  test("prices the switch's cache writes as warm reads on the session's tier", async () => {
    expect(Math.round(pricedOnSession(TOKENS, 'opus') * 1e6)).toBe(18000)
  })
})

describe('switchPays', () => {
  test('Opus → Haiku pays at any context, warm or cold', async () => {
    expect(switchPays('opus', 'haiku', 200_000, 1000, true)).toBe(true)
    expect(switchPays('opus', 'haiku', 200_000, 1000, false)).toBe(true)
  })

  test('Opus → Sonnet on a warm cache pays only on a small context', async () => {
    expect(switchPays('opus', 'sonnet', 10_000, 8000, true)).toBe(true)
    expect(switchPays('opus', 'sonnet', 60_000, 8000, true)).toBe(false)
    expect(switchPays('opus', 'sonnet', 60_000, 8000, false)).toBe(true)
  })

  test('learns the output to expect from the last turns of that kind', async () => {
    expect(expectedOutput([], 'build')).toBe(8000)
    const mine = Array.from({ length: 5 }, () => row({ kind: 'build', out: 2000 }))
    expect(expectedOutput(mine, 'build')).toBe(2000)
  })
})

describe('learn', () => {
  test('two yeses in a row stop the asking', async () => {
    const once = learn(undefined, true)
    expect(once.rule).toBeNull()
    expect(learn(once, true).rule).toBe('auto')
  })

  test('three noes in a row stop the offer, and a yes resets the count', async () => {
    const twice = learn(learn(undefined, false), false)
    expect(twice.rule).toBeNull()
    expect(learn(twice, false).rule).toBe('never')
    expect(learn(learn(twice, true), false).rule).toBeNull()
  })
})

describe('summarize', () => {
  test('owns up when routing cost more than staying', async () => {
    const text = summarize([row({ routed: true, ran: 'sonnet', usd: 0.05, would: 0.03 })], 1_000_000, 7)
    expect(text).toContain('$0.020 more than staying would have')
  })

  test('averages the five-hour window per tier and skips turns without a clean reading', async () => {
    const text = summarize(
      [row({ ran: 'opus', quota: 2 }), row({ ran: 'opus', quota: 4 }), row({ ran: 'haiku', quota: null })],
      1_000_000,
      7,
    )
    expect(text).toContain('Five-hour window used per turn: Opus 3.0%.')
  })

  test('only counts the days asked for', async () => {
    const day = 86_400_000
    const text = summarize([row({ at: 1_000_000 }), row({ at: 1_000_000 + 10 * day })], 1_000_000 + 10 * day, 7)
    expect(text).toContain('last 7 days: 1 turns')
  })

  test('estimates window points saved only with enough turns to calibrate', async () => {
    const routedTurn = row({ routed: true, ran: 'haiku', usd: 0.01, would: 0.11, quota: 0.5, spent: 0.05 })
    const few = summarize([routedTurn], 1_000_000, 7)
    expect(few).not.toContain('of a five-hour window saved')
    const many = summarize(Array.from({ length: 5 }, () => routedTurn), 1_000_000, 7)
    // 0.5 points per $0.05 spent = 10 points per dollar; $0.50 saved.
    expect(many).toContain('About 5.0% of a five-hour window saved')
  })
})
