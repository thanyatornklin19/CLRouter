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
import type { Effort, Route, Tier } from './router'

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
  downgradeMaxContext: number
}

// A turn's route: the model to send it to (null keeps the session's) and
// the effort to send it at (null keeps the session's).
type Pending = { model: string | null; tier: Tier | null; effort: Effort | null }

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find(one => one === value) ?? fallback
}

function readConfig(options: PluginOptions): Config {
  const model = (key: string, fallback: string): string => {
    const value = options[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  const max = options.downgradeMaxContext

  return {
    mode: pick(options.mode, MODES, 'ask'),
    judge: pick(options.judge, JUDGES, 'hybrid'),
    effort: pick(options.effort, EFFORT_MODES, 'auto'),
    models: {
      haiku: model('haikuModel', 'haiku'),
      sonnet: model('sonnetModel', 'sonnet'),
      opus: model('opusModel', 'opus'),
    },
    downgradeMaxContext: typeof max === 'number' && max >= 0 ? max : 30000,
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

/** Puts the choice to the person; resolves the tier to run on, or null to keep. */
async function askPerson(
  $: EngineInterface,
  recommended: Route,
  current: string,
  contextTokens: number,
  effort: Effort | null,
): Promise<{ tier: Tier | null; mode?: ClrouterMode }> {
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
    return { tier: null }
  }

  if (answer === useLabel) {
    return { tier: recommended.tier }
  }
  if (answer === autoLabel) {
    return { tier: recommended.tier, mode: 'auto' }
  }
  if (answer === offLabel) {
    return { tier: null, mode: 'off' }
  }
  if (answer === keepLabel) {
    return { tier: null }
  }

  return { tier: tierInText(answer) ?? null }
}

export const register: Register = (on, options) => {
  const config = readConfig(options)

  // The route chosen at submit, waiting for its turn to start; then the
  // routes of turns in flight, by turn id. Plain variables: a route only
  // lives as long as its turn.
  let pending: Pending | null = null
  const routes = new Map<string, Pending>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'clrouter',
      description: 'Model router: show status, set the mode, or test a prompt',
      argumentHint: '[ask|auto|suggest|off|reset|test <prompt>]',
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

    const verdict = await judge($, e.text, config)
    if (verdict === null) {
      return next(e)
    }

    const recommended = verdict.route
    const current = await $.session.model()
    const currentTier = tierOfModel(current, config.models)
    const isEffortAuto = config.effort === 'auto' && mode !== 'suggest'

    // The tier to switch this turn to; null keeps the session's model.
    let tier: Tier | null = null
    if (currentTier !== recommended.tier) {
      // A cheaper model reads the whole conversation uncached: past a point
      // that costs more than the cached read on the current model saves.
      const { context } = await $.session.usage()
      const contextTokens = context.tokens ?? 0
      const isDowngrade =
        currentTier !== undefined && tierRank(recommended.tier) < tierRank(currentTier)
      if (!(isDowngrade && contextTokens > config.downgradeMaxContext)) {
        if (mode === 'suggest') {
          $.ui.toast(
            `${tierTitle(recommended.tier)} fits this one: ${recommended.reasons[0]}. /model to switch.`,
          )
        } else if (mode === 'ask') {
          const offered = isEffortAuto ? effortFor(recommended.kind, recommended.tier) : null
          const choice = await askPerson($, recommended, current, contextTokens, offered)
          tier = choice.tier
          if (choice.mode !== undefined) {
            await update($, sessionMode, () => choice.mode ?? null)
          }
          if (choice.mode === 'off') {
            return next(e)
          }
        } else {
          tier = recommended.tier
        }
      }
    }

    // The effort fits the work and the model that will actually run it.
    const effort = isEffortAuto ? effortFor(recommended.kind, tier ?? currentTier) : null
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

    if (model === null && effort === null) {
      return next(e)
    }

    pending = { model, tier, effort }
    try {
      return await next(e)
    } finally {
      pending = null
    }
  })

  // Raised for the main loop alone, inside the submit's `next`.
  on('turn.start', ($, e, next) => {
    if (pending !== null) {
      const { model, tier, effort } = pending
      routes.set(e.turnId, pending)
      const at = effort === null ? '' : ` at ${effort} effort`
      $.ui.status(
        tier === null ? `CLRouter: ${effort} effort` : `CLRouter → ${tierTitle(tier)}${effort === null ? '' : ` · ${effort}`}`,
      )
      if (model !== null) {
        $.ui.log(`CLRouter: this prompt runs on ${model}${at}`)
      }
      pending = null
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

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && routes.delete(e.turnId)) {
      $.ui.status(undefined)
    }

    return next(e)
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
      return { text: `Unknown: "${verb}". Try /clrouter [ask|auto|suggest|off|reset|test <prompt>].` }
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

    return { text: lines.join('\n') }
  })
}
