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
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, view: {} } as never,
} as const

const TURN = { durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', answer: 'Done.' } as const
const START = { cwd: '.', surface: 'desktop', isInteractive: true } as const

const REPLY = JSON.stringify({
  title: 'Triage DP1 queue: 7 routed, 3 held',
  started: 'Opened with /dealerpull-engineering:triage-queue on the DP1 team.',
  leftOff: 'Seven issues routed; three held for a person to review.',
  next: ['Run /dealerpull-engineering:implement DP1-676 only if you want to build it now'],
  know: ['DP1-562 and DP1-557 need manual Stripe and Key Vault steps'],
})

const MESSAGES = [
  {
    role: 'user',
    text: '/dealerpull-engineering:triage-queue DP1',
    toolUses: [],
  },
  {
    role: 'assistant',
    text: 'Loading the triage queue.',
    toolUses: [{ tool_use_id: 'u1', tool: 'Skill', input: { skill: 'dealerpull-engineering:triage-queue' } }],
  },
  { role: 'user', text: 'go', toolUses: [] },
  { role: 'assistant', text: 'Phase 6 of 6. 7 routed, 3 held.', toolUses: [] },
]

type Options = { saved?: Record<string, unknown>; reply?: string; isRenameRefused?: boolean }

// The engine beneath the mod: a store we can read back, a fixed transcript, the model
// (returns a fixed brief) and the desktop app's session tool (records each rename).
function fakeEngine(on: On, { saved = {}, reply = REPLY, isRenameRefused = false }: Options = {}) {
  const store = new Map<string, unknown>(Object.entries(saved))
  const prompts: string[] = []
  const renames: unknown[] = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.surfaces', () => ({ value: ['desktop'] }) as never)
  on('session.messages', () => ({ value: MESSAGES }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.log', () => ({ value: undefined }))
  // The engine's own band: empty, as when no other mod draws there.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('mcp.call', ($, e) => {
    renames.push({ server: e.server, tool: e.tool, args: e.args })
    return {
      value: { content: [{ type: 'text', text: isRenameRefused ? 'no' : 'ok' }], isError: isRenameRefused },
    } as never
  })
  return { store, prompts, renames }
}

async function settle(clock: { advance: (ms: number) => Promise<void> }) {
  for (let i = 0; i < 5; i += 1) await clock.advance(1000)
}

test('a resumed session with no brief gets one, shown in the band, and is renamed', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on)
  await $.session.start(START)
  await settle(clock)

  expect(fake.prompts.length).toBe(1)
  expect(fake.prompts[0]).toContain('skill dealerpull-engineering:triage-queue')
  expect(fake.renames).toEqual([
    {
      server: 'ccd_session_mgmt',
      tool: 'set_session_title',
      args: { session_id: 'self', title: 'Triage DP1 queue: 7 routed, 3 held' },
    },
  ])
  expect((fake.store.get('brief:s1') as { leftOff: string }).leftOff).toContain('Seven issues')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-brief', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /Seven issues routed/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Key Vault/ })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

test('the band draws when the surface sends no view', async ($, on) => {
  const clock = mock.clock(on)
  fakeEngine(on)
  await $.session.start(START)
  await settle(clock)

  const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 } as never
  const ui = await $.ui.mount({ plugin: 'session-brief', surface: 'desktop', component: 'AbovePrompt', props })
  expect((await ui.find({ type: 'Text', text: /Seven issues routed/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a saved brief loads at start with no model call, and an unchanged transcript is not re-summarised', async ($, on) => {
  const clock = mock.clock(on)
  const saved = {
    title: 'Old title',
    started: 'Opened with /plan.',
    leftOff: 'Waiting on a decision.',
    next: [],
    know: [],
    messages: MESSAGES.length,
    at: 0,
  }
  const fake = fakeEngine(on, { saved: { 'brief:s1': saved, 'title:s1': 'Old title' } })
  await $.session.start(START)
  await $.turn.complete(TURN)
  await settle(clock)

  expect(fake.prompts).toEqual([])
  expect(fake.renames).toEqual([])
  const ui = await $.ui.mount({ plugin: 'session-brief', surface: 'desktop', ...BAND })
  expect((await ui.find({ type: 'Text', text: /Waiting on a decision/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('the brief opens expanded, and Collapse folds it to the left-off line', async ($, on) => {
  const clock = mock.clock(on)
  fakeEngine(on)
  await $.session.start(START)
  await settle(clock)

  const ui = await $.ui.mount({ plugin: 'session-brief', surface: 'desktop', ...BAND })
  expect((await ui.find({ type: 'Text', text: /Key Vault/ })) !== undefined).toBe(true)
  await ui.press({ key: 'collapse' })
  expect((await ui.find({ type: 'Text', text: /Key Vault/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Left off: Seven issues/ })) !== undefined).toBe(true)
  await ui.press({ key: 'collapse' })
  expect((await ui.find({ type: 'Text', text: /Key Vault/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('Hide removes the band and /brief show brings it back', async ($, on) => {
  const clock = mock.clock(on)
  fakeEngine(on)
  await $.session.start(START)
  await settle(clock)

  const ui = await $.ui.mount({ plugin: 'session-brief', surface: 'desktop', ...BAND })
  await ui.press({ key: 'hide' })
  expect((await ui.find({ type: 'Text', text: /Session brief/ })) === undefined).toBe(true)
  await $.command.run({ command: 'brief', args: 'show' } as never)
  expect((await ui.find({ type: 'Text', text: /Session brief/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('autorename off stops the rename but still writes the brief', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { saved: { autoRename: false } })
  await $.session.start(START)
  await settle(clock)

  expect(fake.prompts.length).toBe(1)
  expect(fake.renames).toEqual([])
})

test('a reply that is not JSON leaves no brief and the band says the update failed', async ($, on) => {
  const clock = mock.clock(on)
  const fake = fakeEngine(on, { reply: 'Sorry, I cannot.' })
  await $.session.start(START)
  await settle(clock)

  expect(fake.store.has('brief:s1')).toBe(false)
  expect(fake.renames).toEqual([])
  const ui = await $.ui.mount({ plugin: 'session-brief', surface: 'desktop', ...BAND })
  expect((await ui.find({ type: 'Text', text: /update failed/ })) !== undefined).toBe(true)
  await ui.unmount()
})
