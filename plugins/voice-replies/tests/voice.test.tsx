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
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 } as never,
} as const

const TURN = { durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const
const START = { cwd: '.', surface: 'desktop', isInteractive: true } as const
const SCRIPT = 'Done. All three tests pass.'
// What the server hears with each /speak from session s1 in the claude-plugins repo.
const FROM_S1 = { session: 'session:s1', tag: 'claude plugins' } as const

type Options = {
  saved?: Record<string, unknown>
  sessionId?: string
  isKokoroUp?: boolean
  isStatusBroken?: boolean
  // Another session is speaking: /speak with when "idle" answers busy.
  isBusy?: boolean
  // The API the running server reports; 1 is a server from before 1.3.0.
  api?: number
  surfaces?: string[]
  installResult?: 'ok' | 'fails'
  modelText?: string
}

type Spoken = { text: string; voice: string; speed: number; session: string; tag: string; when: string }

// The engine beneath the mod: a store we can read back, the session, the turn, the model
// (returns a fixed speech script), the Kokoro server and the Windows voice (both record what they were told).
function fakeEngine(
  on: On,
  {
    saved = {},
    sessionId = 's1',
    isKokoroUp = true,
    isStatusBroken = false,
    isBusy = false,
    api = 2,
    surfaces = ['desktop'],
    installResult = 'ok',
    modelText = SCRIPT,
  }: Options = {},
) {
  const store = new Map<string, unknown>(Object.entries(saved))
  const server = { api }
  const kokoro: Spoken[] = []
  const stops: Record<string, unknown>[] = []
  const windows: string[] = []
  const prompts: string[] = []
  const models: { system: string; maxTokens: number }[] = []
  const installs: (readonly string[])[] = []
  const runs: string[] = []
  const toasts: string[] = []
  const notices: string[] = []
  const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
  on('env.get', ($, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : 'C:\\Users\\test' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sessionId }))
  on('session.repo', () => ({
    value: { root: 'C:\\work\\claude-plugins', remote: null, internal: false, name: null },
  }))
  on('session.root', () => ({ value: 'C:\\work\\worktrees\\nice-bhabha' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.notify', ($, e) => (notices.push(e.text), { value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('ui.status', () => ({ value: undefined }))
  // What another mod (session-brief) draws in the same band.
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>Brief panel</Text>
      </Box>
    )
  })
  on('session.surfaces', () => ({ value: surfaces }) as never)
  on('fs.stat', () => ({ value: { isFile: true } }) as never)
  on('http.fetch', ($, e) => {
    if (!isKokoroUp) throw new Error('connection refused')
    if (e.url.endsWith('/health')) return ok(server.api >= 2 ? `{"ok":true,"api":${server.api}}` : '{"ok":true}')
    if (e.url.endsWith('/speak')) {
      const body = JSON.parse(e.init?.body ?? '{}') as Spoken
      if (isBusy && body.when === 'idle') return ok('{"ok":true,"id":null,"state":"busy","by":"other"}')
      kokoro.push(body)
      return ok(`{"ok":true,"id":${kokoro.length},"state":"queued"}`)
    }
    if (e.url.endsWith('/stop')) {
      stops.push(JSON.parse(e.init?.body ?? '{}'))
      return ok('{"ok":true}')
    }
    if (e.url.includes('/status')) {
      if (isStatusBroken) throw new Error('request timed out')
      return ok('{"ok":true,"state":"done"}')
    }
    return ok('{"ok":true}')
  })
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    models.push({ system: JSON.stringify(e.system), maxTokens: e.maxTokens ?? 0 })
    return { value: { isAnswered: true, text: modelText, usage: USAGE } }
  })
  on('process.spawn', async function* ($, e) {
    // The installer, server\setup.ps1. Its output arrives in pieces that split mid-line.
    if (e.argv.some(a => a.endsWith('setup.ps1'))) {
      installs.push(e.argv)
      yield { stream: 'stdout', text: '==> Checking this machine\r\n    Kokoro will run on the CPU (no NVIDIA GPU found)\r\n==> Install' }
      yield { stream: 'stdout', text: 'ing Kokoro\r\n' }
      if (installResult === 'fails') {
        yield { stream: 'stderr', text: 'Kokoro did not run on the CPU. The output above says why.\r\n' }
        return { value: { code: 1, signal: null } }
      }
      yield { stream: 'stdout', text: 'DONE: Kokoro runs on the CPU.\r\n' }
      return { value: { code: 0, signal: null } }
    }
    windows.push(e.input ?? '')
    yield { stream: 'stdout', text: '4242\n' }
    return { value: { code: 0, signal: null } }
  })
  on('process.run', ($, e) => {
    const line = e.argv.join(' ')
    runs.push(line)
    // Starting the server brings up the plugin's own (current) copy.
    if (line.includes('Start-Process')) server.api = 2
    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  return { store, kokoro, stops, windows, prompts, models, installs, runs, toasts, notices }
}

async function settle(clock: { advance: (ms: number) => Promise<void> }) {
  for (let i = 0; i < 8; i += 1) await clock.advance(1000)
}

test('the voice dropdown turns voice replies off and on for this session only', async ($, on) => {
  const fake = fakeEngine(on)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'voice-replies', surface, ...BAND })
    await ui.select({ key: 'voice', value: 'off' })
    expect(fake.store.get('session:s1')).toMatchObject({ isOn: false })
    expect((await ui.find({ key: 'speed' })) === undefined).toBe(true)
    await ui.select({ key: 'voice', value: 'af_heart' })
    expect(fake.store.get('session:s1')).toMatchObject({ isOn: true })
    expect((await ui.find({ key: 'speed' })) !== undefined).toBe(true)
    await ui.unmount()
  }
  // The default for new sessions is untouched.
  expect(fake.store.get('isOn')).toBe(undefined)
})

test('the voice panel keeps what other mods draw in the band, above it', async ($, on) => {
  fakeEngine(on)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'voice-replies', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /Brief panel/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Voice replies/ })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

test('picking a voice and speed in the band is used for the next reply and saved for this session', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'voice-replies', surface: 'desktop', ...BAND })
  await ui.select({ key: 'voice', value: 'bm_george' })
  await ui.select({ key: 'speed', value: '1.2' })
  expect(fake.store.get('session:s1')).toMatchObject({ voice: 'bm_george', speed: '1.2' })
  expect(fake.store.get('voice')).toBe(undefined)

  await $.turn.complete({ ...TURN, answer: '## Result\n\n- `npm test` passed' })
  await settle(clock)

  expect(fake.prompts[0]).toContain('npm test')
  expect(fake.kokoro).toEqual([{ text: SCRIPT, voice: 'bm_george', speed: 1.2, ...FROM_S1, when: 'idle' }])
  expect(fake.windows).toEqual([])
  await ui.unmount()
})

test('a session started again keeps its own voice over the default', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, {
    saved: { voice: 'af_bella', 'session:s1': { voice: 'bm_george', speed: '1.2' } },
  })
  await $.session.start(START)

  await $.turn.complete({ ...TURN, answer: 'All good.' })
  await settle(clock)

  expect(fake.kokoro).toEqual([{ text: SCRIPT, voice: 'bm_george', speed: 1.2, ...FROM_S1, when: 'idle' }])
})

test('a new session starts with the default voice, not another session\'s', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, {
    sessionId: 's2',
    saved: { voice: 'af_bella', 'session:s1': { voice: 'bm_george', speed: '1.2' } },
  })
  await $.session.start(START)

  await $.turn.complete({ ...TURN, answer: 'All good.' })
  await settle(clock)

  expect(fake.kokoro).toEqual([
    { text: SCRIPT, voice: 'af_bella', speed: 1, session: 'session:s2', tag: 'claude plugins', when: 'idle' },
  ])
})

test('/voice default makes this session\'s choices the default for new sessions', async ($, on) => {
  const fake = fakeEngine(on)
  await $.session.start(START)

  await $.command.run({ command: 'voice', args: 'voice bm_lewis' } as never)
  await $.command.run({ command: 'voice', args: 'length full' } as never)
  expect(fake.store.get('voice')).toBe(undefined)
  await $.command.run({ command: 'voice', args: 'default' } as never)

  expect(fake.store.get('voice')).toBe('bm_lewis')
  expect(fake.store.get('length')).toBe('full')
  expect(fake.store.get('isOn')).toBe(true)
})

test('while another session speaks, the reply waits for Play and a notification names the session', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { isBusy: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'voice-replies', surface: 'desktop', ...BAND })

  await $.turn.complete({ ...TURN, answer: 'All good.' })
  await settle(clock)

  // Nothing played, and the Windows voice did not step in.
  expect(fake.kokoro).toEqual([])
  expect(fake.windows).toEqual([])
  expect(fake.notices).toEqual(['claude-plugins has a reply waiting. Press Play in that session to hear it.'])
  expect((await ui.find({ type: 'Text', text: /1 reply waiting/ })) !== undefined).toBe(true)
  // Every stop this session sent named this session, so other sessions kept speaking.
  expect(fake.stops.length > 0).toBe(true)
  expect(fake.stops.every(s => s.session === 'session:s1')).toBe(true)

  await ui.press({ key: 'play' })
  await settle(clock)

  expect(fake.kokoro).toEqual([{ text: SCRIPT, voice: 'af_heart', speed: 1, ...FROM_S1, when: 'queue' }])
  expect((await ui.find({ type: 'Text', text: /reply waiting/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('Replay in the band speaks the last reply again after it played', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'voice-replies', surface: 'desktop', ...BAND })
  // Nothing has played yet, so there is nothing to replay.
  expect((await ui.find({ key: 'replay' })) === undefined).toBe(true)

  await $.turn.complete({ ...TURN, answer: 'All good.' })
  await settle(clock)
  expect(fake.kokoro.length).toBe(1)

  await ui.press({ key: 'replay' })
  await settle(clock)

  expect(fake.kokoro[1]).toEqual({ text: SCRIPT, voice: 'af_heart', speed: 1, ...FROM_S1, when: 'queue' })
  // Haiku wrote the script once; Replay does not ask again.
  expect(fake.prompts.length).toBe(1)
  await ui.unmount()
})

test('Replay is not shown while a reply waits for Play', async ($, on) => {
  const clock = mock.clock(on)
  fakeEngine(on, { isBusy: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'voice-replies', surface: 'desktop', ...BAND })

  await $.turn.complete({ ...TURN, answer: 'All good.' })
  await settle(clock)

  expect((await ui.find({ key: 'play' })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'replay' })) === undefined).toBe(true)
  await ui.unmount()
})

test('a session started again can still replay its last reply', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { saved: { 'session:s1': { last: 'Earlier reply.' } } })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'voice-replies', surface: 'desktop', ...BAND })

  await ui.press({ key: 'replay' })
  await settle(clock)

  expect(fake.kokoro).toEqual([{ text: 'Earlier reply.', voice: 'af_heart', speed: 1, ...FROM_S1, when: 'queue' }])
  await ui.unmount()
})

test('a new prompt drops the waiting reply', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { isBusy: true })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'voice-replies', surface: 'desktop', ...BAND })

  await $.turn.complete({ ...TURN, answer: 'All good.' })
  await settle(clock)
  expect((await ui.find({ type: 'Text', text: /1 reply waiting/ })) !== undefined).toBe(true)

  await $.prompt.submit({ text: 'next thing' } as never)
  await settle(clock)

  expect((await ui.find({ type: 'Text', text: /reply waiting/ })) === undefined).toBe(true)
  const reply = await $.command.run({ command: 'voice', args: 'play' } as never)
  expect(JSON.stringify(reply)).toContain('No reply is waiting')
  expect(fake.kokoro).toEqual([])
  await ui.unmount()
})

test('/voice stop stops this session only; /voice stop all stops every session', async ($, on) => {
  const fake = fakeEngine(on)
  await $.session.start(START)

  await $.command.run({ command: 'voice', args: 'stop' } as never)
  await $.command.run({ command: 'voice', args: 'stop all' } as never)

  expect(fake.stops).toEqual([{ session: 'session:s1' }, {}])
})

test('/voice name sets what the voice says when it moves to this session', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on)
  await $.session.start(START)

  await $.command.run({ command: 'voice', args: 'name Voice Fixes' } as never)
  await $.turn.complete({ ...TURN, answer: 'All good.' })
  await settle(clock)

  expect(fake.store.get('session:s1')).toMatchObject({ label: 'Voice Fixes' })
  expect(fake.kokoro[0]?.tag).toBe('Voice Fixes')
})

test('Full length asks Haiku for the whole reply with room to say it', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'voice-replies', surface: 'desktop', ...BAND })

  await ui.select({ key: 'length', value: 'full' })
  await $.turn.complete({ ...TURN, answer: 'A long answer.' })
  await settle(clock)

  expect(fake.store.get('session:s1')).toMatchObject({ length: 'full' })
  expect(fake.models[0]?.maxTokens).toBe(4000)
  expect(fake.models[0]?.system).toContain('Keep every point of the reply')
  await ui.unmount()
})

test('a script over the limit ends at a full sentence, not mid-word', async ($, on) => {
  const clock = mock.clock(on)
  const sentence = 'The build passed on the second try. '
  const fake = fakeEngine(on, { modelText: sentence.repeat(60) })
  await $.session.start(START)

  await $.turn.complete({ ...TURN, answer: 'A long answer.' })
  await settle(clock)

  const spoken = fake.kokoro[0]?.text ?? ''
  expect(spoken.length <= 1500).toBe(true)
  expect(spoken.length > 1000).toBe(true)
  expect(spoken.endsWith('second try.')).toBe(true)
})

test('an older voice server is restarted once from the plugin\'s own copy', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { api: 1 })
  await $.session.start(START)

  await $.turn.complete({ ...TURN, answer: 'All good.' })
  await settle(clock)

  const restarts = fake.runs.filter(r => r.includes('Stop-Process'))
  expect(restarts.length).toBe(1)
  expect(restarts[0]).toContain('Copy-Item')
  expect(restarts[0]).toContain('\\server\\server.py')
  expect(fake.kokoro.length).toBe(1)
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
  expect(fake.store.get('session:s1')).toMatchObject({ isOn: true })
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

test('/voice install runs the installer, which picks GPU or CPU, then starts Kokoro', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on)
  await $.session.start(START)

  const reply = await $.command.run({ command: 'voice', args: 'install' } as never)
  expect(JSON.stringify(reply)).toContain('Installing Kokoro')
  await settle(clock)

  expect(fake.installs.length).toBe(1)
  const argv = (fake.installs[0] ?? []).join(' ')
  expect(argv).toContain('\\server\\setup.ps1')
  expect(argv).toContain('-Device auto')
  expect(fake.toasts).toContain('Kokoro runs on the CPU.')
})

test('/voice install cpu and gpu force the device; anything else is refused', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on)
  await $.session.start(START)

  await $.command.run({ command: 'voice', args: 'install cpu' } as never)
  await settle(clock)
  await $.command.run({ command: 'voice', args: 'install gpu' } as never)
  await settle(clock)
  const bad = await $.command.run({ command: 'voice', args: 'install amd' } as never)

  expect(fake.installs.length).toBe(2)
  expect((fake.installs[0] ?? []).join(' ')).toContain('-Device cpu')
  expect((fake.installs[1] ?? []).join(' ')).toContain('-Device gpu')
  expect(JSON.stringify(bad)).toContain('/voice install cpu')
})

test('a failed install says why and keeps the Windows voice', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { installResult: 'fails' })
  await $.session.start(START)

  await $.command.run({ command: 'voice', args: 'install' } as never)
  await settle(clock)

  const failed = fake.toasts.find(t => t.startsWith('Kokoro install failed')) ?? ''
  expect(failed).toContain('did not run on the CPU')
  expect(failed).toContain('install.log')
})
