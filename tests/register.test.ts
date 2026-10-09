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
  const state: World = { asked: [], answer, contextTokens, turns: 0, sent: [], efforts: [] }
  mock.env(on, env)
  on('session.model', () => ({ value: SESSION_MODEL }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: state.contextTokens, window: 200000 },
      rateLimits: [],
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

// Runs the latest turn's first request, ends the turn, and answers which
// model the request was sent to.
async function runTurn($: Engine, state: World): Promise<string | undefined> {
  const turnId = `t${state.turns}`
  for await (const _ of $.turn.step({ turnId, index: 0, model: SESSION_MODEL, messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  return state.sent.at(-1)
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

test('skips a downgrade once the context is large', OPTIONS, async ($, on) => {
  const state = world($, on, 'Use Haiku for this prompt', 120000)
  await $.prompt.submit(submit('what is a closure in JavaScript?'))

  expect(state.asked).toHaveLength(0)
  expect(await runTurn($, state)).toBe(SESSION_MODEL)
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
