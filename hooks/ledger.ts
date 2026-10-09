// What CLRouter's choices cost and saved, and what it learned from the
// person's answers. Pure functions over plain records; register.ts reads
// the engine and keeps the records in $.store.

import type { Effort, Kind, Tier } from './router'
import { TIERS, tierTitle } from './router'

type Price = { input: number; output: number; cacheRead: number }

// Dollars per million tokens: first-party list prices (Claude API reference,
// cached 2026-10-06). A cache write is priced at 1.25× input, the 5-minute
// rate. Haiku 5.5's cache read isn't listed; it's taken as 0.1× input, the
// ratio the others follow.
export const PRICES: Record<Tier, Price> = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2 },
  opus: { input: 4, output: 20, cacheRead: 0.2 },
}

const CACHE_WRITE = 1.25

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** What these tokens cost on this tier. */
export function priced(tokens: Tokens, tier: Tier): number {
  const p = PRICES[tier]
  return (
    (tokens.input * p.input +
      tokens.cacheWrite * p.input * CACHE_WRITE +
      tokens.cacheRead * p.cacheRead +
      tokens.output * p.output) /
    1e6
  )
}

/** How long the session's model keeps its cache warm, at the longest TTL. */
export const WARM_MS = 3_600_000

/**
 * At least what a routed turn would have cost had it stayed on the
 * session's tier, whose cache is warm: it ran within the last hour. A
 * switch makes the new model write the conversation to its own cache; on
 * the session's model that context was already cached, so those tokens
 * are priced as cache reads. Some of them were new content, which would
 * have been a write there too: so this is a floor, and a saving computed
 * from it is never overstated. With a cold cache (a new session, an hour
 * idle), staying would have written the cache too: price the turn as is.
 */
export function pricedOnSession(tokens: Tokens, tier: Tier): number {
  const p = PRICES[tier]
  return (
    (tokens.input * p.input + (tokens.cacheRead + tokens.cacheWrite) * p.cacheRead + tokens.output * p.output) /
    1e6
  )
}

export type TurnRecord = {
  /** When the turn ended, in $.clock.now() milliseconds. */
  at: number
  /** The kind of work, or null when CLRouter made no call. */
  kind: Kind | null
  /** The session's tier, and the tier that answered (null: not a known family). */
  from: Tier | null
  ran: Tier | null
  /** CLRouter sent the turn to another model. */
  routed: boolean
  /** The effort CLRouter set, or null for the session's. */
  effort: Effort | null
  /** A popup asked, and what the person chose (null when not asked). */
  asked: boolean
  accepted: boolean | null
  /** The person interrupted the turn. */
  aborted: boolean
  /** The turn's own tokens priced on the tier that answered. */
  usd: number
  /** Routed turns: at least what the session's tier would have cost. */
  would: number | null
  /** Points of the five-hour window this turn used; null without a clean reading. */
  quota: number | null
  /** What the session's cost ledger grew by, subagents included. */
  spent: number | null
  /** Output tokens the turn wrote, thinking included. */
  out: number | null
}

// Output tokens a turn of each kind writes, until the person's own turns
// say otherwise.
const OUTPUT_GUESS: Record<Kind, number> = { answer: 1000, build: 8000, exact: 8000, deep: 12000 }

/** The output a turn of this kind is likely to write: the person's last 50 such turns, once there are 5. */
export function expectedOutput(records: readonly TurnRecord[], kind: Kind): number {
  const mine = records.filter(r => r.kind === kind && typeof r.out === 'number').slice(-50)
  return mine.length >= 5 ? sum(mine.map(r => r.out ?? 0)) / mine.length : OUTPUT_GUESS[kind]
}

/**
 * Whether moving a turn from `from` to the cheaper `to` costs less, cache
 * included. The new model writes the whole context to its cache; staying
 * reads it from a warm cache, or writes it too when the cache is cold.
 * The output is where the cheaper model saves.
 *
 * Opus 5.5 reads its cache at Sonnet's price, so mid-session Opus → Sonnet
 * only pays on a small context or a long answer. Haiku writes cache for
 * less than Opus reads it, so Opus → Haiku always pays.
 */
export function switchPays(
  from: Tier,
  to: Tier,
  contextTokens: number,
  outputTokens: number,
  isWarm: boolean,
): boolean {
  const stay = PRICES[from]
  const move = PRICES[to]
  const stayCost =
    contextTokens * (isWarm ? stay.cacheRead : stay.input * CACHE_WRITE) + outputTokens * stay.output
  const moveCost = contextTokens * move.input * CACHE_WRITE + outputTokens * move.output
  return moveCost < stayCost
}

/** Records kept, newest last: about 300 KB of the store's 4 MiB. */
export const LEDGER_MAX = 1500

// Learned answers, per move: a kind of work going from one tier to another.
export type Pref = { yes: number; no: number; rule: 'auto' | 'never' | null }

export const AUTO_AFTER = 2
export const NEVER_AFTER = 3

export const moveOf = (kind: Kind, from: Tier | null, to: Tier): string =>
  `${kind}:${from ?? 'other'}>${to}`

/** The preference after one more answer: two yeses in a row stop the asking, three noes stop the offer. */
export function learn(pref: Pref | undefined, accepted: boolean): Pref {
  const p = pref ?? { yes: 0, no: 0, rule: null }
  if (accepted) {
    const yes = p.yes + 1
    return { yes, no: 0, rule: yes >= AUTO_AFTER ? 'auto' : null }
  }
  const no = p.no + 1
  return { yes: 0, no, rule: no >= NEVER_AFTER ? 'never' : null }
}

/** A move in words: "build work on Opus → Sonnet". */
export function describeMove(move: string): string {
  const match = /^(\w+):(\w+)>(\w+)$/.exec(move)
  if (match === null) {
    return move
  }
  const [, kind, from, to] = match
  const title = (tier: string) => (TIERS.some(t => t === tier) ? tierTitle(tier as Tier) : 'another model')
  return `${kind} work on ${title(from ?? '')} → ${title(to ?? '')}`
}

const money = (usd: number): string => (Math.abs(usd) < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`)
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)
const DAY_MS = 86_400_000

/** The `/clrouter stats` report over the last `days` days. */
export function summarize(records: readonly TurnRecord[], now: number, days: number): string {
  const recent = records.filter(r => r.at >= now - days * DAY_MS)
  if (recent.length === 0) {
    return `CLRouter has no turns recorded in the last ${days} days.`
  }

  const routed = recent.filter(r => r.routed)
  const effortOnly = recent.filter(r => !r.routed && r.effort !== null)
  const untouched = recent.length - routed.length - effortOnly.length
  const toCounts = TIERS.map(t => [t, routed.filter(r => r.ran === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${tierTitle(t)} ${n}`)
    .join(', ')

  const lines = [
    `CLRouter, last ${days} days: ${recent.length} turns.`,
    `- Sent to another model: ${routed.length}${toCounts === '' ? '' : ` (${toCounts})`}. Effort only: ${effortOnly.length}. Left alone: ${untouched}.`,
  ]

  let saved = 0
  if (routed.length > 0) {
    const actual = sum(routed.map(r => r.usd))
    const would = sum(routed.map(r => r.would ?? r.usd))
    saved = would - actual
    lines.push(
      saved >= 0
        ? `- Those turns cost ${money(actual)}. On your session's model they'd have cost at least ${money(would)}: saved at least ${money(saved)}.`
        : `- Those turns cost ${money(actual)}, ${money(-saved)} more than staying would have: re-reading the conversation on another model outweighed its lower price.`,
    )
  }

  const spentKnown = recent.filter(r => r.spent !== null)
  if (spentKnown.length > 0) {
    lines.push(`- Session cost recorded: ${money(sum(spentKnown.map(r => r.spent ?? 0)))} (subagents included).`)
  }

  const withQuota = recent.filter(r => r.quota !== null && r.ran !== null)
  if (withQuota.length > 0) {
    const perTier = TIERS.map(t => {
      const turns = withQuota.filter(r => r.ran === t)
      return turns.length === 0 ? null : `${tierTitle(t)} ${(sum(turns.map(r => r.quota ?? 0)) / turns.length).toFixed(1)}%`
    })
      .filter(s => s !== null)
      .join(', ')
    lines.push(`- Five-hour window used per turn: ${perTier}.`)

    const paired = withQuota.filter(r => r.spent !== null && (r.spent ?? 0) > 0)
    const quotaPerUsd = sum(paired.map(r => r.quota ?? 0)) / sum(paired.map(r => r.spent ?? 0))
    if (saved > 0 && paired.length >= 5 && Number.isFinite(quotaPerUsd) && quotaPerUsd > 0) {
      lines.push(
        `- About ${(saved * quotaPerUsd).toFixed(1)}% of a five-hour window saved (estimate: assumes your plan's usage tracks API prices, calibrated on your own turns).`,
      )
    }
  }

  const asked = recent.filter(r => r.asked)
  if (asked.length > 0) {
    const switched = asked.filter(r => r.accepted === true).length
    lines.push(`- Asked ${asked.length} times: you switched ${switched}, kept ${asked.length - switched}.`)
  }

  const interrupted = routed.filter(r => r.aborted).length
  if (interrupted > 0) {
    lines.push(`- You interrupted ${interrupted} routed turns: a sign the model was wrong for them.`)
  }

  return lines.join('\n')
}
