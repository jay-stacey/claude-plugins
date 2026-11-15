import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TURN = { durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', answer: 'Done.' } as const
const START = { cwd: '.', surface: 'desktop', isInteractive: true } as const

type Self = { title: string; group?: { id: string; name: string } | null; pinned?: boolean; cwd?: string }

function fakeEngine(on: On, self: Self, sections: { id: string; kind: string; name: string }[]) {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: ['desktop'] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('store.get', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('mcp.call', ($, e) => {
    const args = (e.args ?? {}) as Record<string, unknown>
    calls.push({ tool: e.tool, args })
    let body: unknown = 'ok'
    if (e.tool === 'get_session') body = self
    if (e.tool === 'list_sections') body = sections
    if (e.tool === 'create_section') {
      sections.push({ id: 'cg-new', kind: 'manual', name: String(args.name) })
      body = { id: 'cg-new' }
    }
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } } as never
  })
  return calls
}

async function settle(clock: { advance: (ms: number) => Promise<void> }) {
  for (let i = 0; i < 5; i += 1) await clock.advance(1000)
}

const moves = (calls: { tool: string; args: Record<string, unknown> }[]) => calls.filter(c => c.tool === 'move_sessions')

test('an ungrouped session is filed into the existing section for its project', async ($, on) => {
  const clock = mock.clock(on)
  const calls = fakeEngine(on, { title: 'Fix DP1-687 duplicate email check', group: null }, [
    { id: 'cg-dp1', kind: 'manual', name: 'DP1' },
  ])
  await $.session.start(START)
  await $.turn.complete(TURN)
  await settle(clock)
  expect(moves(calls)).toEqual([{ tool: 'move_sessions', args: { session_ids: ['self'], section_id: 'cg-dp1' } }])
  expect(calls.some(c => c.tool === 'create_section')).toBe(false)
})

test('a missing section is created first', async ($, on) => {
  const clock = mock.clock(on)
  const calls = fakeEngine(on, { title: 'Inventory feeds dialogs broken after hotfix', group: null }, [])
  await $.session.start(START)
  await $.turn.complete(TURN)
  await settle(clock)
  expect(calls.find(c => c.tool === 'create_section')?.args).toEqual({ name: 'InventoryFeeds' })
  expect(moves(calls)[0].args).toEqual({ session_ids: ['self'], section_id: 'cg-new' })
})

test('a session the user already filed is never moved', async ($, on) => {
  const clock = mock.clock(on)
  const calls = fakeEngine(on, { title: 'dealerpull-api endpoint', group: { id: 'cg-x', name: 'Mine' } }, [])
  await $.session.start(START)
  await $.turn.complete(TURN)
  await settle(clock)
  expect(moves(calls).length).toBe(0)
})

test('a pinned session is never moved', async ($, on) => {
  const clock = mock.clock(on)
  const calls = fakeEngine(on, { title: 'dealerpull-api endpoint', group: null, pinned: true }, [])
  await $.session.start(START)
  await $.turn.complete(TURN)
  await settle(clock)
  expect(moves(calls).length).toBe(0)
})

test('no match leaves the session ungrouped', async ($, on) => {
  const clock = mock.clock(on)
  const calls = fakeEngine(on, { title: 'Weekend grocery list', group: null }, [])
  await $.session.start(START)
  await $.turn.complete(TURN)
  await settle(clock)
  expect(moves(calls).length).toBe(0)
})

test('security work wins over the repo it touches', async ($, on) => {
  const clock = mock.clock(on)
  const calls = fakeEngine(on, { title: 'dealerpull-api user permissions security audit', group: null }, [
    { id: 'cg-sec', kind: 'manual', name: 'Security' },
  ])
  await $.session.start(START)
  await $.turn.complete(TURN)
  await settle(clock)
  expect(moves(calls)[0].args).toEqual({ session_ids: ['self'], section_id: 'cg-sec' })
})
