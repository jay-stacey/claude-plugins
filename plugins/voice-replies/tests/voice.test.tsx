import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } as never,
} as const

const TURN = { durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const
const START = { cwd: '.', surface: 'desktop', isInteractive: true } as const
const SCRIPT = 'Done. All three tests pass.'

type Options = {
  saved?: Record<string, unknown>
  isKokoroUp?: boolean
  isStatusBroken?: boolean
  surfaces?: string[]
}

// The engine beneath the mod: a store we can read back, the session, the turn, the model
// (returns a fixed speech script), the Kokoro server and the Windows voice (both record what they were told).
function fakeEngine(
  on: On,
  { saved = {}, isKokoroUp = true, isStatusBroken = false, surfaces = ['desktop'] }: Options = {},
) {
  const store = new Map<string, unknown>(Object.entries(saved))
  const kokoro: { text: string; voice: string; speed: number }[] = []
  const windows: string[] = []
  const prompts: string[] = []
  const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', () => ({ value: 'C:\\Users\\test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: surfaces }) as never)
  on('fs.stat', () => ({ value: { isFile: true } }) as never)
  on('http.fetch', ($, e) => {
    if (!isKokoroUp) throw new Error('connection refused')
    if (e.url.endsWith('/speak')) {
      kokoro.push(JSON.parse(e.init?.body ?? '{}'))
      return ok(`{"ok":true,"id":${kokoro.length}}`)
    }
    if (e.url.includes('/status')) {
      if (isStatusBroken) throw new Error('request timed out')
      return ok('{"ok":true,"state":"done"}')
    }
    return ok('{"ok":true}')
  })
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: SCRIPT, usage: USAGE } }
  })
  on('process.spawn', async function* ($, e) {
    windows.push(e.input ?? '')
    yield { stream: 'stdout', text: '4242\n' }
    return { value: { code: 0, signal: null } }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  return { store, kokoro, windows, prompts }
}

async function settle(clock: { advance: (ms: number) => Promise<void> }) {
  for (let i = 0; i < 8; i += 1) await clock.advance(1000)
}

test('the band toggles voice replies and remembers the choice', async ($, on) => {
  const fake = fakeEngine(on)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'voice-replies', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /Voice replies/ }))?.text).toContain('on')
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ type: 'Text', text: /Voice replies/ }))?.text).toContain('off')
    expect(fake.store.get('isOn')).toBe(false)
    await ui.press({ key: 'toggle' })
    expect(fake.store.get('isOn')).toBe(true)
    await ui.unmount()
  }
})

test('picking a voice and speed in the band is used for the next reply', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'voice-replies', surface: 'desktop', ...BAND })
  await ui.select({ key: 'voice', value: 'bm_george' })
  await ui.select({ key: 'speed', value: '1.2' })
  expect(fake.store.get('voice')).toBe('bm_george')

  await $.turn.complete({ ...TURN, answer: '## Result\n\n- `npm test` passed' })
  await settle(clock)

  expect(fake.prompts[0]).toContain('npm test')
  expect(fake.kokoro).toEqual([{ text: SCRIPT, voice: 'bm_george', speed: 1.2 }])
  expect(fake.windows).toEqual([])
  await ui.unmount()
})

test('with the Kokoro server down, the Windows voice speaks instead', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { isKokoroUp: false })
  await $.session.start(START)

  await $.turn.complete({ ...TURN, answer: 'All good.' })
  // The mod waits up to 60 s for the server to start, then falls back.
  for (let i = 0; i < 130; i += 1) await clock.advance(1000)

  expect(fake.kokoro).toEqual([])
  expect(fake.windows).toEqual([SCRIPT])
})

test('subagent turns, and turns while off, stay silent', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { saved: { isOn: false } })
  await $.session.start(START)

  await $.turn.complete({ ...TURN, answer: 'hello' })
  await $.command.run({ command: 'voice', args: 'on' } as never)
  expect(fake.store.get('isOn')).toBe(true)
  await $.turn.complete({ ...TURN, answer: 'from a subagent', agentId: 'a1' })
  await settle(clock)

  expect(fake.prompts).toEqual([])
  expect(fake.kokoro).toEqual([])
  expect(fake.windows).toEqual([])
})

test('once Kokoro takes the text, the Windows voice never also speaks', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { isStatusBroken: true })
  await $.session.start(START)

  await $.turn.complete({ ...TURN, answer: 'A long answer.' })
  for (let i = 0; i < 30; i += 1) await clock.advance(1000)

  expect(fake.kokoro.length).toBe(1)
  expect(fake.windows).toEqual([])
})

test('sessions nobody is watching (claude -p, scheduled tasks) stay silent', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { surfaces: [] })
  await $.session.start(START)

  await $.turn.complete({ ...TURN, answer: 'Background job finished.' })
  await settle(clock)

  expect(fake.prompts).toEqual([])
  expect(fake.kokoro).toEqual([])
  expect(fake.windows).toEqual([])
})
