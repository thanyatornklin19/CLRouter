import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CLASSIFIER_LABELS } from '../hooks/router'

const SESSION_MODEL = 'claude-opus-5-5'
const HAIKU = 'claude-haiku-5-5'
const OPTIONS = { options: { judge: 'heuristic' } }

type World = {
  asked: string[]
  answer: string
  contextTokens: number
  turns: number
  sent: string[]
  efforts: string[]
  /** The session's cost ledger and five-hour window, as the status line reads them. */
  spent: number
  fiveHour: number
}

// The engine beneath the plugin: the session's model and context, the
// person answering the dialog, a submit that starts a turn, and a model
// request that records which model it was sent to.
function world(
  engine: Engine,
  on: On,
  answer: string,
  contextTokens = 1000,
  env: Record<string, string> = {},
): World {
  const state: World = {
    asked: [],
    answer,
    contextTokens,
    turns: 0,
    sent: [],
    efforts: [],
    spent: 0,
    fiveHour: 10,
  }
  mock.env(on, env)
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('session.model', () => ({ value: SESSION_MODEL }))
  on('session.turns', () => ({ value: state.turns }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: state.contextTokens, window: 200000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: state.fiveHour, resetsAt: '2026-10-09T12:00:00Z' }],
      cost: { usd: state.spent },
    },
  }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    state.asked.push(question)
    return { result: { questions: e.questions, answers: { [question]: state.answer } } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    state.sent.push(e.model)
    state.efforts.push(String(e.effort ?? 'unset'))
    // A model id the API does not know gets no response at all.
    const stopReason = e.model.includes('nope') ? null : 'end_turn'
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason, usage: null }
  })
  on('prompt.submit', async ($, e) => {
    state.turns += 1
    await engine.turn.start({ text: e.text, turnId: `t${state.turns}` })
    return { text: e.text }
  })
  return state
}

// Runs the latest turn's first request, ends the turn (with the API's
// usage, the spend and the five-hour window moved on), and answers which
// model the request was sent to.
const TURN_TOKENS = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000 }
async function runTurn($: Engine, state: World, isAborted = false): Promise<string | undefined> {
  const turnId = `t${state.turns}`
  for await (const _ of $.turn.step({ turnId, index: 0, model: SESSION_MODEL, messageCount: 1 })) {
    // drain
  }
  const model = state.sent.at(-1) ?? SESSION_MODEL
  state.spent += 0.05
  state.fiveHour += 1
  await $.turn.complete({
    turnId,
    answer: '',
    durationMs: 1,
    isAborted,
    reason: isAborted ? 'aborted' : 'answer',
    usage: { model, ...TURN_TOKENS },
  })
  return model
}

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('asks before switching and runs the turn on the model chosen', OPTIONS, async ($, on) => {
  const state = world($, on, 'Use Haiku for this prompt')
  await $.prompt.submit(submit('what is a closure in JavaScript?'))

  expect(state.asked).toHaveLength(1)
  expect(state.asked[0]).toContain('Run it on Haiku at low effort instead of Opus?')
  expect(await runTurn($, state)).toBe(HAIKU)
  expect(state.efforts.at(-1)).toBe('low')
})

test('keeps the session model when the person says keep', OPTIONS, async ($, on) => {
  const state = world($, on, 'Keep Opus')
  await $.prompt.submit(submit('what is a closure in JavaScript?'))

  expect(await runTurn($, state)).toBe(SESSION_MODEL)
})

test('does not ask when the session model already fits', OPTIONS, async ($, on) => {
  const state = world($, on, 'Use Opus for this prompt')
  await $.prompt.submit(
    submit('Design the architecture for a multi-tenant billing system and plan the migration'),
  )

  expect(state.asked).toHaveLength(0)
  expect(await runTurn($, state)).toBe(SESSION_MODEL)
})

test('moves to Haiku even on a large context: it writes cache for less than Opus reads it', OPTIONS, async ($, on) => {
  const state = world($, on, 'Use Haiku for this prompt', 120000)
  await $.prompt.submit(submit('ok do it'))
  await runTurn($, state)
  await $.prompt.submit(submit('what is a closure in JavaScript?'))

  expect(state.asked).toHaveLength(1)
  expect(await runTurn($, state)).toBe(HAIKU)
})

test("doesn't offer Opus → Sonnet on a large context Opus has cached", OPTIONS, async ($, on) => {
  const state = world($, on, 'Use Sonnet for this prompt', 120000)
  await $.prompt.submit(submit('ok do it'))
  await runTurn($, state)
  await $.prompt.submit(submit('add a loading spinner to the submit button component'))

  expect(state.asked).toHaveLength(0)
  expect(await runTurn($, state)).toBe(SESSION_MODEL)
  expect(state.efforts.at(-1)).toBe('medium')
})

test('offers Opus → Sonnet when the cache is cold anyway', OPTIONS, async ($, on) => {
  const state = world($, on, 'Use Sonnet for this prompt', 120000)
  await $.prompt.submit(submit('add a loading spinner to the submit button component'))

  expect(state.asked).toHaveLength(1)
  expect(await runTurn($, state)).toBe('claude-sonnet-5-5')
})

test('auto-routes without asking after "Auto-route this session"', OPTIONS, async ($, on) => {
  const state = world($, on, 'Auto-route this session')
  await $.prompt.submit(submit('what is a closure in JavaScript?'))
  expect(await runTurn($, state)).toBe(HAIKU)

  await $.prompt.submit(submit('fix the typo in the README'))
  expect(state.asked).toHaveLength(1)
  expect(await runTurn($, state)).toBe(HAIKU)
})

test('leaves prompts from notifications and peers alone', OPTIONS, async ($, on) => {
  const state = world($, on, 'Use Haiku for this prompt')
  await $.prompt.submit({
    text: 'what is a closure in JavaScript?',
    wait: false,
    origin: { kind: 'task-notification' },
  })

  expect(state.asked).toHaveLength(0)
  expect(await runTurn($, state)).toBe(SESSION_MODEL)
})

test('/clrouter sets the mode and tests a prompt', OPTIONS, async ($, on) => {
  world($, on, 'Keep Opus')
  const presentation = { isFullscreen: false, columns: 80 }
  const run = (args: string) =>
    $.command.run({ command: 'clrouter', args, origin: { kind: 'composer' }, presentation })

  expect((await run('off')).text).toBe('CLRouter mode for this session: off.')
  expect((await run('status')).text).toContain('CLRouter mode: off (configured: ask)')
  expect((await run('test what is a monad?')).text).toMatch(/^Haiku \(haiku\)/)
  expect((await run('reset')).text).toContain('configured one: ask')
})

test('honors a provider pin for the alias', OPTIONS, async ($, on) => {
  const state = world($, on, 'Use Haiku for this prompt', 1000, {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-5-5-v1:0',
  })
  await $.prompt.submit(submit('what is a closure in JavaScript?'))

  expect(await runTurn($, state)).toBe('us.anthropic.claude-haiku-5-5-v1:0')
})

test(
  'falls back to the session model when the routed one never answers',
  { options: { judge: 'heuristic', haikuModel: 'claude-nope-0' } },
  async ($, on) => {
    const state = world($, on, 'Use Haiku for this prompt')
    await $.prompt.submit(submit('what is a closure in JavaScript?'))

    expect(await runTurn($, state)).toBe(SESSION_MODEL)
    expect(state.sent).toEqual(['claude-nope-0', SESSION_MODEL])
  },
)

describe('effort', () => {
  test('keeps Opus when asked to, at the effort the work needs', OPTIONS, async ($, on) => {
    const state = world($, on, 'Keep Opus')
    await $.prompt.submit(submit('what is a closure in JavaScript?'))

    expect(await runTurn($, state)).toBe(SESSION_MODEL)
    expect(state.efforts.at(-1)).toBe('low')
  })

  test('is set without asking when the model already fits', OPTIONS, async ($, on) => {
    const state = world($, on, 'Use Haiku for this prompt')
    await $.prompt.submit(submit('Design the architecture for a multi-tenant billing system'))

    expect(state.asked).toHaveLength(0)
    expect(await runTurn($, state)).toBe(SESSION_MODEL)
    expect(state.efforts.at(-1)).toBe('high')
  })

  test('is left alone when set to off', { options: { judge: 'heuristic', effort: 'off' } }, async ($, on) => {
    const state = world($, on, 'Use Haiku for this prompt')
    await $.prompt.submit(submit('what is a closure in JavaScript?'))

    expect(state.asked[0]).toContain('Run it on Haiku instead of Opus?')
    expect(await runTurn($, state)).toBe(HAIKU)
    expect(state.efforts.at(-1)).toBe('unset')
  })

  test('is left alone on a follow-up', OPTIONS, async ($, on) => {
    const state = world($, on, 'Use Haiku for this prompt')
    await $.prompt.submit(submit('ok do it'))

    expect(await runTurn($, state)).toBe(SESSION_MODEL)
    expect(state.efforts.at(-1)).toBe('unset')
  })
})

describe('the classifier', () => {
  const presentation = { isFullscreen: false, columns: 80 }
  const testPrompt = ($: Engine, prompt: string) =>
    $.command.run({ command: 'clrouter', args: `test ${prompt}`, origin: { kind: 'composer' }, presentation })
  const classifierSays = (on: On, tier: 'haiku' | 'sonnet' | 'opus') => {
    const calls = { count: 0 }
    on('model.classify', () => {
      calls.count += 1
      return { value: CLASSIFIER_LABELS[tier] }
    })
    return calls
  }
  const HYBRID = { options: { judge: 'hybrid' } }

  test('decides what the keywords could not, upward', HYBRID, async ($, on) => {
    world($, on, 'Keep Opus')
    classifierSays(on, 'opus')
    const { text } = await testPrompt($, 'give me 5 name ideas for a coffee shop')
    expect(text).toMatch(/^Opus .* by model/)
  })

  test('cannot send an unrecognized prompt to Haiku', HYBRID, async ($, on) => {
    world($, on, 'Keep Opus')
    classifierSays(on, 'haiku')
    const { text } = await testPrompt($, 'give me 5 name ideas for a coffee shop')
    expect(text).toMatch(/^No call/)
  })

  test('cannot overrule the keywords down to Haiku', HYBRID, async ($, on) => {
    world($, on, 'Keep Opus')
    const calls = classifierSays(on, 'haiku')
    const { text } = await testPrompt($, 'the login button does nothing on mobile Safari, can you look into it')
    expect(calls.count).toBe(1)
    expect(text).toMatch(/^Sonnet .* by heuristic/)
  })

  test('cannot take exact rules below Sonnet, even when always asked', { options: { judge: 'model' } }, async ($, on) => {
    world($, on, 'Keep Opus')
    const calls = classifierSays(on, 'haiku')
    const { text } = await testPrompt($, 'what is the VAT on 12,500 baht?')
    expect(calls.count).toBe(1)
    expect(text).toMatch(/^Sonnet /)
  })

  test('is not asked when the keywords are sure', HYBRID, async ($, on) => {
    world($, on, 'Keep Opus')
    const calls = classifierSays(on, 'haiku')
    await testPrompt($, 'what is the VAT on 12,500 baht?')
    expect(calls.count).toBe(0)
  })
})

describe('the ledger', () => {
  const presentation = { isFullscreen: false, columns: 80 }
  const command = ($: Engine, args: string) =>
    $.command.run({ command: 'clrouter', args, origin: { kind: 'composer' }, presentation })

  test('records a routed turn and what staying would have cost', OPTIONS, async ($, on) => {
    const state = world($, on, 'Use Haiku for this prompt')
    await $.prompt.submit(submit('what is a closure in JavaScript?'))
    await runTurn($, state)

    const { text } = await command($, 'stats')
    expect(text).toContain('Sent to another model: 1 (Haiku 1)')
    // 1,000 in, 500 out, 20,000 written to Haiku's cache: $0.00285. The
    // session had no Opus turn yet, so its cache was cold too: $0.114.
    expect(text).toContain('cost $0.003. On your session\'s model they\'d have cost at least $0.114: saved at least $0.111')
    expect(text).toContain('Five-hour window used per turn: Haiku 1.0%')
    expect(text).toContain('Asked 1 times: you switched 1, kept 0')
  })

  test("counts a warm cache on the session's model as reads", OPTIONS, async ($, on) => {
    const state = world($, on, 'Keep Opus')
    await $.prompt.submit(submit('ok do it'))
    await runTurn($, state)
    state.answer = 'Use Haiku for this prompt'
    await $.prompt.submit(submit('what is a closure in JavaScript?'))
    await runTurn($, state)

    // Opus ran a turn just before, so staying would have read the 20,000
    // tokens from its cache: at least $0.018.
    expect((await command($, 'stats')).text).toContain("they'd have cost at least $0.018: saved at least $0.015")
  })

  test('says so when there is nothing yet', OPTIONS, async ($, on) => {
    world($, on, 'Keep Opus')
    expect((await command($, 'stats')).text).toBe('CLRouter has no turns recorded in the last 7 days.')
  })
})

describe('learning from answers', () => {
  const ANSWERS = [
    'what is a closure in JavaScript?',
    'explain the difference between let and const',
    'how does useEffect cleanup work?',
    'what does HTTP 429 mean',
  ]
  const presentation = { isFullscreen: false, columns: 80 }

  test('stops asking after two yeses for the same move', OPTIONS, async ($, on) => {
    const state = world($, on, 'Use Haiku for this prompt')
    for (const prompt of ANSWERS.slice(0, 3)) {
      await $.prompt.submit(submit(prompt))
      await runTurn($, state)
    }
    expect(state.asked).toHaveLength(2)
    expect(state.sent.at(-1)).toBe(HAIKU)
  })

  test('stops offering after three noes for the same move', OPTIONS, async ($, on) => {
    const state = world($, on, 'Keep Opus')
    for (const prompt of ANSWERS) {
      await $.prompt.submit(submit(prompt))
      await runTurn($, state)
    }
    expect(state.asked).toHaveLength(3)
    expect(state.sent.at(-1)).toBe(SESSION_MODEL)
    expect(state.efforts.at(-1)).toBe('low')
  })

  test('asks again after you interrupt a turn it routed on its own', OPTIONS, async ($, on) => {
    const state = world($, on, 'Use Haiku for this prompt')
    await $.prompt.submit(submit(ANSWERS[0] ?? ''))
    await runTurn($, state)
    await $.prompt.submit(submit(ANSWERS[1] ?? ''))
    await runTurn($, state)
    await $.prompt.submit(submit(ANSWERS[2] ?? ''))
    await runTurn($, state, true)
    expect(state.asked).toHaveLength(2)

    await $.prompt.submit(submit(ANSWERS[3] ?? ''))
    expect(state.asked).toHaveLength(3)
  })

  test('forgets on /clrouter forget', OPTIONS, async ($, on) => {
    const state = world($, on, 'Use Haiku for this prompt')
    for (const prompt of ANSWERS.slice(0, 2)) {
      await $.prompt.submit(submit(prompt))
      await runTurn($, state)
    }
    await $.command.run({ command: 'clrouter', args: 'forget', origin: { kind: 'composer' }, presentation })
    await $.prompt.submit(submit(ANSWERS[2] ?? ''))
    expect(state.asked).toHaveLength(3)
  })

  test('never asks on a call it is unsure of', OPTIONS, async ($, on) => {
    const state = world($, on, 'Use Sonnet for this prompt')
    await $.prompt.submit(submit('the login button does nothing on mobile Safari, can you look into it'))

    expect(state.asked).toHaveLength(0)
    expect(await runTurn($, state)).toBe(SESSION_MODEL)
    expect(state.efforts.at(-1)).toBe('unset')
  })
})
