import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ClrouterDecision, ClrouterMode } from '../types'
import {
  CLASSIFIER_LABELS,
  TIERS,
  effortFor,
  isClassifiable,
  kindOfTier,
  modelTitle,
  route,
  tierInText,
  typedText,
  tierOfLabel,
  tierOfModel,
  tierRank,
  tierTitle,
} from './router'
import type { Effort, Kind, Route, Tier } from './router'
import {
  LEDGER_MAX,
  WARM_MS,
  describeMove,
  expectedOutput,
  learn,
  moveOf,
  priced,
  pricedOnSession,
  summarize,
  switchPays,
} from './ledger'
import type { Pref, TurnRecord } from './ledger'

const MODES: readonly ClrouterMode[] = ['ask', 'auto', 'suggest', 'off']
const JUDGES = ['heuristic', 'hybrid', 'model'] as const
type Judge = (typeof JUDGES)[number]
const EFFORT_MODES = ['auto', 'off'] as const
type EffortMode = (typeof EFFORT_MODES)[number]

// Who typed it: the person at a terminal, a phone or web client, an SDK host.
// Notifications, peers, schedules and plugins keep the session's model.
const ROUTED_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const CLASSIFIER_CHARS = 4000

// `turn.step` sends the model name it is given as is, so an alias is
// resolved here: the provider's own pin first (ANTHROPIC_DEFAULT_*_MODEL,
// as Bedrock and Vertex setups set), else the first-party id.
const ALIAS_IDS: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

const sessionMode = atom({ plugin: 'clrouter', key: 'mode' } as const, null)
const lastDecision = atom({ plugin: 'clrouter', key: 'last' } as const, null)

type Config = {
  mode: ClrouterMode
  judge: Judge
  effort: EffortMode
  models: Record<Tier, string>
}

// A turn's route: the model to send it to (null keeps the session's), the
// effort to send it at (null keeps the session's), and what the ledger
// records about how the call was made.
type Pending = {
  model: string | null
  tier: Tier | null
  effort: Effort | null
  kind: Kind
  from: Tier | null
  asked: boolean
  accepted: boolean | null
  /** The move a learned rule applied, so an interrupt can take it back. */
  learnedMove: string | null
}

// The session's spend and five-hour window, as the status line has them.
type Reading = { spent: number | null; fiveHour: number | null; resetsAt: string | null }

const LEDGER_KEY = 'ledger'
const PREFS_KEY = 'prefs'

async function reading($: EngineInterface): Promise<Reading> {
  try {
    const usage = await $.session.usage()
    const window = usage.rateLimits.find(w => w.kind === 'five_hour')
    return {
      spent: usage.cost?.usd ?? null,
      fiveHour: window?.percentUsed ?? null,
      resetsAt: window?.resetsAt ?? null,
    }
  } catch {
    return { spent: null, fiveHour: null, resetsAt: null }
  }
}

async function readLedger($: EngineInterface): Promise<TurnRecord[]> {
  const value = await $.store.get(LEDGER_KEY)
  return Array.isArray(value) ? (value as TurnRecord[]) : []
}

async function readPrefs($: EngineInterface): Promise<Record<string, Pref>> {
  const value = await $.store.get(PREFS_KEY)
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Pref>)
    : {}
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find(one => one === value) ?? fallback
}

function readConfig(options: PluginOptions): Config {
  const model = (key: string, fallback: string): string => {
    const value = options[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }

  return {
    mode: pick(options.mode, MODES, 'ask'),
    judge: pick(options.judge, JUDGES, 'hybrid'),
    effort: pick(options.effort, EFFORT_MODES, 'auto'),
    models: {
      haiku: model('haikuModel', 'haiku'),
      sonnet: model('sonnetModel', 'sonnet'),
      opus: model('opusModel', 'opus'),
    },
  }
}

async function resolveModel($: EngineInterface, name: string): Promise<string> {
  const alias = TIERS.find(tier => tier === name.toLowerCase())
  if (alias === undefined) {
    return name
  }
  const pinned =
    alias === 'haiku'
      ? await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')
      : alias === 'sonnet'
        ? await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')
        : await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL')

  return pinned !== undefined && pinned.trim() !== '' ? pinned.trim() : ALIAS_IDS[alias]
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

/**
 * The keywords' verdict, handed to the small model when they are unsure or
 * found nothing. The model may send a prompt up, never below the floor the
 * keywords set, and never to Haiku unless the keywords saw an answer-type
 * prompt: a cheap model that is wrong looks the same as one that is right.
 */
async function judge(
  $: EngineInterface,
  text: string,
  config: Config,
): Promise<{ route: Route; judge: 'heuristic' | 'model' } | null> {
  const heuristic = route(text)
  const shouldAsk =
    config.judge === 'model'
      ? heuristic !== null || isClassifiable(text)
      : config.judge === 'hybrid' &&
        (heuristic === null ? isClassifiable(text) : heuristic.confidence === 'low')
  if (!shouldAsk) {
    return heuristic === null ? null : { route: heuristic, judge: 'heuristic' }
  }

  try {
    const label = await $.model.classify(
      `A user sent this request to an AI coding assistant:\n\n${typedText(text).slice(0, CLASSIFIER_CHARS)}`,
      TIERS.map(tier => CLASSIFIER_LABELS[tier]),
    )
    const said = tierOfLabel(label)
    if (said !== undefined) {
      const floor: Tier = heuristic?.floor ?? 'sonnet'
      const isHaikuAllowed = heuristic?.tier === 'haiku'
      if (said === 'haiku' && !isHaikuAllowed) {
        return heuristic === null ? null : { route: heuristic, judge: 'heuristic' }
      }
      const tier: Tier = tierRank(said) < tierRank(floor) ? floor : said
      const reasons =
        heuristic !== null && heuristic.tier === tier ? heuristic.reasons : [`classifier: ${label}`]
      const kind =
        heuristic !== null && heuristic.tier === tier
          ? heuristic.kind
          : kindOfTier(tier, heuristic?.kind === 'exact')
      return {
        route: { tier, kind, confidence: 'high', reasons, score: heuristic?.score ?? 0, floor },
        judge: 'model',
      }
    }
  } catch (error) {
    $.ui.log(`clrouter: classifier unavailable (${String(error)})`, { to: 'debug' })
  }

  return heuristic === null ? null : { route: heuristic, judge: 'heuristic' }
}

type Answer = 'use' | 'keep' | 'other' | 'dismissed'

/** Puts the choice to the person; resolves the tier to run on, or null to keep. */
async function askPerson(
  $: EngineInterface,
  recommended: Route,
  current: string,
  contextTokens: number,
  effort: Effort | null,
): Promise<{ tier: Tier | null; answer: Answer; mode?: ClrouterMode }> {
  const target = tierTitle(recommended.tier)
  const keep = modelTitle(current)
  const why = recommended.reasons.slice(0, 2).join(', ')
  const cacheNote =
    contextTokens >= 10000
      ? ` (~${Math.round(contextTokens / 1000)}k tokens of context get re-read uncached)`
      : ''

  const useLabel = `Use ${target} for this prompt`
  const keepLabel = `Keep ${keep}`
  const autoLabel = 'Auto-route this session'
  const offLabel = 'Turn off this session'

  let answer: string
  try {
    answer = await $.ui.ask(
      `${target} fits this prompt (${why}). Run it on ${target}${effort === null ? '' : ` at ${effort} effort`} instead of ${keep}${cacheNote}?`,
      { header: 'CLRouter', options: [useLabel, keepLabel, autoLabel, offLabel] },
    )
  } catch {
    // Dismissed, or nobody to ask (a -p run): leave the model alone.
    return { tier: null, answer: 'dismissed' }
  }

  if (answer === useLabel) {
    return { tier: recommended.tier, answer: 'use' }
  }
  if (answer === autoLabel) {
    return { tier: recommended.tier, answer: 'use', mode: 'auto' }
  }
  if (answer === offLabel) {
    return { tier: null, answer: 'other', mode: 'off' }
  }
  if (answer === keepLabel) {
    return { tier: null, answer: 'keep' }
  }

  return { tier: tierInText(answer) ?? null, answer: 'other' }
}

/**
 * Whether the session's model has this conversation cached: it ran a turn
 * here within the hour. A conversation continued or resumed in a new
 * process has earlier turns this process never saw; then the last ledger
 * row within the hour stands in, so a saving is never overstated.
 */
async function isCacheWarm($: EngineInterface, warmSince: number | null, now: number): Promise<boolean> {
  if (warmSince !== null) {
    return now - warmSince < WARM_MS
  }
  if ((await $.session.turns()) <= 1) {
    return false
  }
  const last = (await readLedger($)).at(-1)
  return last !== undefined && now - last.at < WARM_MS
}

// One ledger row per main turn: what it cost, what staying would have
// cost, and how much of the five-hour window it used.
async function keepRecord(
  $: EngineInterface,
  config: Config,
  warmSince: number | null,
  e: { usage?: { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }; isAborted: boolean },
  route: Pending | null,
  start: Reading,
): Promise<TurnRecord> {
  const end = await reading($)
  const now = await $.clock.now()
  const isWarm = await isCacheWarm($, warmSince, now)
  const usage = e.usage
  const tokens =
    usage === undefined
      ? null
      : {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheWrite: usage.cache_creation_input_tokens,
        }
  const from = route?.from ?? tierOfModel(await $.session.model(), config.models) ?? null
  const ran = usage === undefined ? null : (tierOfModel(usage.model, config.models) ?? null)
  const routed = route !== null && route.tier !== null && ran === route.tier
  const window =
    start.fiveHour !== null &&
    end.fiveHour !== null &&
    start.resetsAt === end.resetsAt &&
    end.fiveHour >= start.fiveHour
      ? Math.round((end.fiveHour - start.fiveHour) * 10) / 10
      : null

  const row: TurnRecord = {
    at: now,
    kind: route?.kind ?? null,
    from,
    ran,
    routed,
    effort: route?.effort ?? null,
    asked: route?.asked ?? false,
    accepted: route?.accepted ?? null,
    aborted: e.isAborted,
    usd: tokens !== null && ran !== null ? priced(tokens, ran) : 0,
    would:
      routed && tokens !== null && from !== null
        ? isWarm
          ? pricedOnSession(tokens, from)
          : priced(tokens, from)
        : null,
    quota: window,
    spent: start.spent !== null && end.spent !== null ? Math.max(0, end.spent - start.spent) : null,
    out: tokens?.output ?? null,
  }
  const ledger = await readLedger($)
  await $.store.set(LEDGER_KEY, [...ledger, row].slice(-LEDGER_MAX))

  // An interrupt on a turn a learned rule routed: the rule was wrong here.
  if (e.isAborted && route?.learnedMove != null) {
    const prefs = await readPrefs($)
    const { [route.learnedMove]: _, ...rest } = prefs
    await $.store.set(PREFS_KEY, rest)
    $.ui.toast(`CLRouter asks again before ${describeMove(route.learnedMove)}.`)
  }

  return row
}

export const register: Register = (on, options) => {
  const config = readConfig(options)

  // The route chosen at submit, waiting for its turn to start; the routes
  // of turns in flight, by turn id; and each main turn's opening reading
  // for the ledger. Plain variables: they live as long as a turn.
  let pending: Pending | null = null
  const routes = new Map<string, Pending>()
  const turns = new Map<string, { route: Pending | null; start: Reading }>()
  // When a main turn last ran on the session's own model: its cache is warm
  // for an hour after, which decides what staying would have cost.
  let warmSince: number | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'clrouter',
      description: 'Model router: status, savings, mode, or test a prompt',
      argumentHint: '[stats [days]|ask|auto|suggest|off|reset|forget|test <prompt>]',
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!ROUTED_ORIGINS.has(e.origin.kind) || e.turnId !== undefined) {
      return next(e)
    }

    const mode = (await read($, sessionMode)) ?? config.mode
    if (mode === 'off') {
      return next(e)
    }

    // A call the router isn't sure of changes nothing: no popup, no switch.
    const verdict = await judge($, e.text, config)
    if (verdict === null || verdict.route.confidence === 'low') {
      return next(e)
    }

    const recommended = verdict.route
    const current = await $.session.model()
    const currentTier = tierOfModel(current, config.models) ?? null
    const isEffortAuto = config.effort === 'auto' && mode !== 'suggest'

    // The tier to switch this turn to; null keeps the session's model.
    let tier: Tier | null = null
    let asked = false
    let accepted: boolean | null = null
    let learnedMove: string | null = null
    if (currentTier !== recommended.tier) {
      // A cheaper model re-reads the whole conversation into its own cache.
      // Move only when that, plus its cheaper output, costs less than
      // staying on the session's model. Upgrades are about quality: always.
      const { context } = await $.session.usage()
      const contextTokens = context.tokens ?? 0
      const isCheaper =
        currentTier !== null && tierRank(recommended.tier) < tierRank(currentTier)
      const isWarm = await isCacheWarm($, warmSince, await $.clock.now())
      const pays =
        !isCheaper ||
        currentTier === null ||
        switchPays(
          currentTier,
          recommended.tier,
          contextTokens,
          expectedOutput(await readLedger($), recommended.kind),
          isWarm,
        )
      const move = moveOf(recommended.kind, currentTier, recommended.tier)
      if (pays) {
        if (mode === 'suggest') {
          $.ui.toast(
            `${tierTitle(recommended.tier)} fits this one: ${recommended.reasons[0]}. /model to switch.`,
          )
        } else if (mode === 'auto') {
          tier = recommended.tier
        } else {
          // Ask, unless the person's answers already settled this move.
          const prefs = await readPrefs($)
          const rule = prefs[move]?.rule ?? null
          if (rule === 'auto') {
            tier = recommended.tier
            learnedMove = move
          } else if (rule === null) {
            const offered = isEffortAuto ? effortFor(recommended.kind, recommended.tier) : null
            const choice = await askPerson($, recommended, current, contextTokens, offered)
            asked = choice.answer !== 'dismissed'
            tier = choice.tier
            if (choice.answer === 'use' || choice.answer === 'keep') {
              accepted = choice.answer === 'use'
              const after = learn(prefs[move], accepted)
              await $.store.set(PREFS_KEY, { ...prefs, [move]: after })
              if (after.rule === 'auto') {
                $.ui.toast(`From now on, ${describeMove(move)} without asking. /clrouter forget undoes it.`)
              } else if (after.rule === 'never') {
                $.ui.toast(`CLRouter stops offering ${describeMove(move)}. /clrouter forget undoes it.`)
              }
            }
            if (choice.mode !== undefined) {
              await update($, sessionMode, () => choice.mode ?? null)
            }
            if (choice.mode === 'off') {
              return next(e)
            }
          }
        }
      }
    }

    // The effort fits the work and the model that will actually run it.
    const effort = isEffortAuto ? effortFor(recommended.kind, tier ?? currentTier ?? undefined) : null
    const model = tier === null ? null : await resolveModel($, config.models[tier])
    const decision: ClrouterDecision = {
      prompt: firstLine(typedText(e.text)),
      chars: { typed: typedText(e.text).length, sent: e.text.length },
      recommended: recommended.tier,
      reasons: recommended.reasons,
      judge: verdict.judge,
      routedTo: model,
      effort,
    }
    await update($, lastDecision, () => decision)

    pending = { model, tier, effort, kind: recommended.kind, from: currentTier, asked, accepted, learnedMove }
    try {
      return await next(e)
    } finally {
      pending = null
    }
  })

  // Raised for the main loop alone, inside the submit's `next`.
  on('turn.start', async ($, e, next) => {
    const route = pending
    pending = null
    turns.set(e.turnId, { route, start: await reading($) })

    if (route !== null && (route.model !== null || route.effort !== null)) {
      const { model, tier, effort } = route
      routes.set(e.turnId, route)
      const at = effort === null ? '' : ` at ${effort} effort`
      $.ui.status(
        tier === null ? `CLRouter: ${effort} effort` : `CLRouter → ${tierTitle(tier)}${effort === null ? '' : ` · ${effort}`}`,
      )
      if (model !== null) {
        $.ui.log(`CLRouter: this prompt runs on ${model}${at}`)
      }
    }

    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    const routed = e.agentId === undefined ? routes.get(e.turnId) : undefined
    if (routed === undefined) {
      return yield* next(e)
    }

    const effort = routed.effort === null ? {} : { effort: routed.effort }
    if (routed.model === null) {
      return yield* next({ ...e, ...effort })
    }

    // A model that answers nothing at all (a wrong id, no access) must not
    // cost the person their turn: send the request again on the session's.
    const stream = next({ ...e, ...effort, model: routed.model })
    let hasAnswered = false
    for await (const chunk of stream) {
      hasAnswered ||= chunk.kind !== 'engine'
      yield chunk
    }
    const result = await stream.result
    if (hasAnswered || result.stopReason !== null || next.signal.aborted) {
      return result
    }

    routes.delete(e.turnId)
    $.ui.status(undefined)
    $.ui.log(`CLRouter: ${routed.model} did not answer, so this prompt runs on ${e.model}`)

    return yield* next({ ...e, ...effort })
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    if (routes.delete(e.turnId)) {
      $.ui.status(undefined)
    }
    const turn = turns.get(e.turnId)
    turns.delete(e.turnId)

    const result = await next(e)
    if (turn !== undefined) {
      try {
        const row = await keepRecord($, config, warmSince, e, turn.route, turn.start)
        if (!row.routed && row.ran !== null && row.ran === row.from) {
          warmSince = row.at
        }
      } catch (error) {
        $.ui.log(`clrouter: ledger not written (${String(error)})`, { to: 'debug' })
      }
    }
    return result
  })

  on('command.run', { command: 'clrouter' }, async ($, e) => {
    const args = e.args.trim()
    const [verb = '', ...rest] = args.split(/\s+/)

    if (verb === 'test') {
      const text = args.slice('test'.length).trim()
      if (text === '') {
        return { text: 'Usage: /clrouter test <prompt>' }
      }
      const verdict = await judge($, text, config)
      if (verdict === null) {
        return { text: 'No call: too little signal. CLRouter keeps the current model.' }
      }
      const { tier, kind, confidence, reasons, score } = verdict.route
      return {
        text: `${tierTitle(tier)} (${config.models[tier]}) at ${effortFor(kind, tier)} effort, ${kind} work, ${confidence} confidence, score ${score}, by ${verdict.judge}: ${reasons.join(', ')}`,
      }
    }

    if (verb === 'stats') {
      const days = Math.max(1, Math.round(Number(rest[0] ?? 7)) || 7)
      return { text: summarize(await readLedger($), await $.clock.now(), days) }
    }

    if (verb === 'forget') {
      await $.store.delete(PREFS_KEY)
      return { text: 'CLRouter forgot your answers: it asks again for every kind of work.' }
    }

    if (verb === 'reset') {
      await update($, sessionMode, () => null)
      return { text: `CLRouter mode reset to the configured one: ${config.mode}.` }
    }

    const asked = MODES.find(mode => mode === verb)
    if (asked !== undefined && rest.length === 0) {
      await update($, sessionMode, () => asked)
      return { text: `CLRouter mode for this session: ${asked}.` }
    }

    if (verb !== '' && verb !== 'status') {
      return { text: `Unknown: "${verb}". Try /clrouter [stats [days]|ask|auto|suggest|off|reset|forget|test <prompt>].` }
    }

    const mode = (await read($, sessionMode)) ?? config.mode
    const last = await read($, lastDecision)
    const models = TIERS.map(tier => `${tier}=${config.models[tier]}`).join(', ')
    const lines = [
      `CLRouter mode: ${mode}${mode === config.mode ? '' : ` (configured: ${config.mode})`}`,
      `Judge: ${config.judge}. Effort: ${config.effort}. Models: ${models}.`,
      `Session model: ${await $.session.model()}.`,
    ]
    if (last !== null) {
      lines.push(
        `Last call: "${last.prompt}" (${last.chars.typed} of ${last.chars.sent} chars scored) → ${last.recommended} (${last.reasons.join(', ')}), ${last.routedTo === null ? 'kept the session model' : `ran on ${last.routedTo}`}${last.effort === null ? '' : ` at ${last.effort} effort`}.`,
      )
    }

    const rules = Object.entries(await readPrefs($)).filter(([, pref]) => pref.rule !== null)
    for (const [move, pref] of rules) {
      lines.push(`Learned: ${describeMove(move)} ${pref.rule === 'auto' ? 'without asking' : 'is no longer offered'}.`)
    }

    return { text: lines.join('\n') }
  })
}
