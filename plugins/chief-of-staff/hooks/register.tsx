import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type {
  ActionOutcomeKind, ActionVerb, ChiefCaps, ChiefConfirm, ChiefHost, ChiefInboxItem, ChiefServerInfo, ChiefSession,
  ChiefSessionActions, ChiefSessionKind,
} from '../types'

// The Chief of Staff mod (docs/contracts.md section 6). It loads in every
// session and does its work only in the Chief's: the session where /chief ran.
// There it adds the Chief's persona to the system prompt, long-polls the app
// server's inbox for prompts and actions, posts each reply, and serves the
// cos_sessions and cos_act tools. Every session action, from the console or
// from the model, goes through one guarded router, runAction.

const STORE_CHIEF = 'chief:session'
const TOOL = 'cos_sessions'
const TOOL_FULL = 'mcp__chief-of-staff__cos_sessions'
const ACT_TOOL = 'cos_act'
const ACT_TOOL_FULL = 'mcp__chief-of-staff__cos_act'
const SESSIONS_SERVER = 'ccd_session_mgmt'
const PERSONA_ID = 'chief-of-staff:persona'
const POLL_WAIT_S = 25
// A pause between long polls, so a server that answers at once never spins the loop.
const POLL_GAP_MS = 250
const BACKOFF_FIRST_MS = 2000
const BACKOFF_MAX_MS = 30000
// /chief from the prompt and the skill's own load both start the Chief; one is enough.
const BECOME_DEDUPE_MS = 15000
const START_TIMEOUT_MS = 30000
const CHIEF_COMMAND = /^\/(?:chief-of-staff:)?chief(?:\s|$)/
const CONFIRM_LINE = /^\s*\[\[\s*confirm\s*:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]\]\s*$/i
const ARCHIVE_TOOL = 'mcp__ccd_session_mgmt__archive_session'
const SEND_TOOL = 'mcp__ccd_session_mgmt__send_message'
const START_TOOL = 'mcp__ccd_session__start_session'
// A yes, or an action Jay confirmed in the console, stays approved this long.
const APPROVAL_MS = 120000
// A hand-off to the Chief's own tools is settled by its own call within this time.
const HANDOFF_MS = 300000
const STOP_TIMEOUT_MS = 30000
const BG_START_TIMEOUT_MS = 10000
const AGENTS_TIMEOUT_MS = 5000
const RECENT_START_MS = 120000
const RESULT_RETRY_MS = [1000, 4000, 15000]
const DONE_ITEM_MS = 600000
const HELLO_TRIES = 3
const HELLO_RETRY_MS = 1000
const MAX_DATA_TITLE = 80
const MAX_START_TEXT = 4000
// A background id or a start name that claude takes as one argument: never read as a flag.
const ARG_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
// The server's session id pattern.
const SESSION_ID = /^(local|cli|bg)_[A-Za-z0-9-]{1,80}$/
const START_MODELS = new Set(['haiku', 'sonnet', 'opus'])
// Control and direction characters, quotes and brackets: what a title must not bring into a prompt.
const UNSAFE_TITLE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩"'`‘’“”[\]{}<>()]/g
const YES_WORDS = /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do|confirm|confirmed|archive)\b/
const NO_WORDS = /\b(no|nope|not|don't|dont|do not|wait|stop|leave|cancel|keep)\b/
// Prompts from the server, not answers from Jay.
const SERVER_PROMPT = /^\[(Notice|Action)\b/
const NOTICE_PROMPT = /^\[Notice\b/
// A hint, not a wall (plan D9): it steers a model that reaches for the shell back to cos_act.
const KILL_COMMAND = /\bclaude(?:\.exe|\.cmd)?["']?(?:\s+--?[\w-]+(?:[= ][^\s]+)?)*\s+(?:stop|kill|rm|respawn)\b|\b(?:taskkill|stop-process|spps|pkill|killall|tskill)\b|\.kill\s*\(|\bwmic\b[^\n]*\bprocess\b|(?:^|[;&|(]\s*)kill\s+-?\w/i
const SHELL_REFUSAL = 'The Chief does not stop, remove or kill sessions or processes from the shell. Use the ' +
  'cos_act tool: it checks whether the session is working and asks Jay first.'
const SHELL_UNCHECKED = 'The Chief of Staff could not check that command, so it did not run.'
const OUT_OF_DATE = 'The Chief of Staff server is out of date. Type /chief to update it.'
const NOT_CHECKED = 'The Chief of Staff could not check that session, so nothing was done.'
const SETTINGS_BLOCK = 'Your settings block this, so nothing was done.'
const SETTINGS_UNCHECKED = 'The Chief of Staff could not check your settings, so nothing was done.'
const NOT_JAY = 'Only Jay can ask the Chief to act. Another session asked for this, so nothing was done.'
const MIXED_TURN = "Another session's message arrived in the same turn, so I did not act. Ask me again."
// Kinds of prompt or delivery that come from another session: they never count as Jay.
const PEER_KINDS = new Set(['peer', 'peer-send-message', 'unclassified'])

// Module state. A reload starts it over; session.start then restores the role
// from the store, so a Chief stays the Chief across reloads.
let myId = ''
let localId: string | null = null
let isChief = false
let persona = ''
let loopGen = 0
let backoffMs = 0
let server: ChiefServerInfo | null = null
let becameAt = -Infinity
let becoming: Promise<void> | null = null
let options: PluginOptions = {}
// True once a prompt.compose hook ran here, so the persona is in the system prompt.
let composeSeen = false
// Set by `/chief stop` or `/chief status`, so the skill's own load does not claim the role.
let skipSkillClaimUntil = -Infinity
// The last refused claim: /chief from the prompt and the skill's own load get the same answer.
let refused: { at: number; text: string } | null = null
// What this session can do, and where it draws (plan 5.1).
let host: ChiefHost | null = null
let startSurface: ChiefHost['surface'] = null

// Who counts as Jay (plan 5.9). Each prompt since the last turn start, with its trust level;
// the trust of the running main turn; whether Jay ever typed here.
type Level = 'typed' | 'press' | 'none'
let originsSinceTurn: { kind: string; level: Level }[] = []
let turnTrust: 'ok' | 'mixed' | 'none' = 'none'
let isTurnRunning = false
let hasTypedOrigin = false

// The guard's memory (plan 5.7). `discussed`: sessions the Chief looked up or was refused in
// the current turn. `pendingAsks`: the session|verb keys a refusal asked Jay about since the last
// reply. `asked`: the last reply's confirm question and its keys. `approvals`: what Jay's yes, or a
// console confirm, approved, by session|verb, until used once or expired.
type Approval = { until: number; source: 'typed' | 'press'; isFromYes: boolean }
let discussed = new Set<string>()
const pendingAsks = new Set<string>()
let asked: { keys: string[]; yes: string; no: string } | null = null
const approvals = new Map<string, Approval>()
// Hand-offs to the Chief's own tools, settled by its own call (plan 6.4).
const handoffs = new Map<string, { verb: ActionVerb; sessionId: string; until: number }>()
// Inbox items handled once (plan 5.10), and starts in flight or just made, by tag.
const doneItems = new Map<string, { body: Record<string, unknown>; at: number }>()
const runningItems = new Set<string>()
const recentStarts = new Map<string, number>()
// The console or voice prompt Jev advised on, until the Chief starts a session for it or
// its turn ends: what the Chief really did goes to Jev's log. A prompt that arrives while
// another turn runs may be scored on that turn; the log is a measure, not a control.
let jevPending: string | null = null
const LOG_KEEP = 200
const logLines: string[] = []

type ApiResult = { status: number; ok: boolean; json: Record<string, unknown> | null }
type Origin = 'console' | 'model'
type ActionRequest = {
  verb: ActionVerb
  id?: string
  text?: string
  reason?: string
  confirmed?: boolean
  cwd?: string
  title?: string
  model?: string
  origin: Origin
}
type ActionOutcome = { outcome: ActionOutcomeKind; detail: string; needsJay?: string }
type SessionAction = keyof ChiefSessionActions

export const register: Register = (on, opts) => {
  options = opts ?? {}

  on('session.start', async ($, e, next) => {
    const surface = (e as { surface?: unknown }).surface
    if (surface === 'terminal' || surface === 'desktop' || surface === 'vscode' || surface === 'mobile') {
      startSurface = surface
    }
    const result = await next(e)
    try {
      myId = await $.session.id()
      log($, `loaded in session ${myId}`)
      // Deferred everywhere else, so it costs other sessions nothing until asked for.
      await registerTool($, false)
      if ((await $.store.get(STORE_CHIEF)) === myId) {
        isChief = true
        persona = await loadPersona($)
        $.clock.after(0, () => void become($, false))
      }
    } catch (err) {
      log($, `session.start: ${String(err)}`)
    }
    return result
  })

  // /chief makes this session the Chief. The persona and the tool are in place
  // before the turn starts, so the /chief turn itself already has them.
  on('prompt.submit', async ($, e, next) => {
    try {
      const typed = e.text.trim()
      const origin = (e as { origin?: { kind?: unknown; name?: unknown } }).origin
      const kind = typeof origin?.kind === 'string' ? origin.kind : 'unclassified'
      const isOwn = kind === 'plugin' && origin?.name === 'chief-of-staff'
      const level = levelOf(kind, isOwn, typed)
      if (kind === 'composer') hasTypedOrigin = true
      noteOrigin(isOwn && NOTICE_PROMPT.test(typed) ? 'notice' : kind, level,
        e.turnId !== undefined || isTurnRunning)
      if (isChief && level !== 'none' && !isOwn && !SERVER_PROMPT.test(typed) && !CHIEF_COMMAND.test(typed)) {
        await noteAnswer($, typed, level)
      }
      if (CHIEF_COMMAND.test(typed)) {
        // `/chief stop` and `/chief status` only manage the server; they make no Chief.
        const word = typed.split(/\s+/)[1]?.toLowerCase() ?? ''
        if (word === 'stop' || word === 'status') {
          skipSkillClaimUntil = (await now($)) + BECOME_DEDUPE_MS
          return next(e)
        }
        const refusal = await claim($)
        if (refusal !== null) return next({ ...e, context: [...(e.context ?? []), refusal] })
        // Where prompt.compose does not reach this plugin (an organization's managed
        // settings), the persona rides along with the /chief prompt instead.
        if (!composeSeen && persona !== '') {
          const context = `Chief of Staff persona for this session:\n\n${persona}`
          return next({ ...e, context: [...(e.context ?? []), context] })
        }
      }
    } catch (err) {
      log($, `prompt.submit: ${String(err)}`)
    }
    return next(e)
  })

  // Another session's message arriving while Jay's turn runs taints that turn (plan 5.9).
  // The Chief's own subagents (agentId), coordinator messages and task notices are neutral.
  on('session.receive', async ($, e, next) => {
    try {
      if (e.agentId === undefined && PEER_KINDS.has(e.origin.kind)) noteOrigin(e.origin.kind, 'none', isTurnRunning)
    } catch (err) {
      log($, `session.receive: ${String(err)}`)
    }
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    try {
      const isChiefSkill = e.skill === 'chief' || e.skill === 'chief-of-staff:chief'
      log($, `skill.prompt ${e.skill}${isChiefSkill ? ' (the Chief skill)' : ''}`)
      if (isChiefSkill && (await now($)) >= skipSkillClaimUntil) {
        // Refused: the skill's own steps would start the server and act as the Chief.
        const refusal = await claim($)
        if (refusal !== null) return next({ ...e, text: refusal })
      }
    } catch (err) {
      log($, `skill.prompt: ${String(err)}`)
    }
    return next(e)
  })

  // The model can run /chief through the Skill tool. Once the skill is loaded in a
  // session the engine does not expand it again, so skill.prompt does not fire;
  // the tool call always does. claim() drops a second call within 15 s.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    try {
      const call = e as unknown as { skill?: unknown; args?: unknown }
      const isChiefSkill = call.skill === 'chief' || call.skill === 'chief-of-staff:chief'
      const word = typeof call.args === 'string' ? call.args.trim().split(/\s+/)[0]?.toLowerCase() ?? '' : ''
      if (isChiefSkill && word !== 'stop' && word !== 'status') {
        log($, `Skill tool call ${String(call.skill)}`)
        const refusal = await claim($)
        if (refusal !== null) return { deny: refusal }
      }
    } catch (err) {
      log($, `Skill tool call: ${String(err)}`)
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    composeSeen = true
    const result = await next(e)
    if (!isChief || persona === '') return result
    const sections = result.sections.filter(s => s.id !== PERSONA_ID)
    return { ...result, sections: [...sections, { id: PERSONA_ID, text: persona, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      turnTrust = trustOf(originsSinceTurn)
      originsSinceTurn = []
      isTurnRunning = true
      if (isChief) {
        discussed = new Set()
        $.clock.after(0, () => void post($, '/api/mod/busy', { busy: true, cliId: myId }))
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isTurnRunning = false
    if (!isChief) return result
    const answer = e.reason === 'answer' && !e.isAborted ? e.answer : ''
    const turnId = e.turnId
    if (jevPending !== null) {
      const id = jevPending
      jevPending = null
      $.clock.after(0, () => void post($, '/api/mod/jev-outcome', { id, route: 'chief', model: null }))
    }
    if (answer.trim() !== '') {
      // The reply's confirm question, if any, is what Jay's next prompt answers, and it is
      // about what the Chief was refused since its last reply. A reply without one (a notice
      // in between) leaves the open question alone; Jay's next own message answers or clears it.
      const { confirm } = splitConfirm(answer)
      if (confirm !== null) asked = { keys: [...pendingAsks], yes: confirm.yes, no: confirm.no }
      pendingAsks.clear()
    }
    $.clock.after(0, () => void sendReply($, answer, turnId))
    return result
  })

  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const input = e as unknown as { id?: unknown; all?: unknown }
    const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : undefined
    if (id !== undefined) {
      discussed.add(id)
      // As in 0.2.2: a confirm question after looking a desktop session up is about archiving it.
      if (isChief) pendingAsks.add(keyOf(id, 'archive'))
    }
    return { result: await sessionsForModel($, id, input.all === true) }
  }).catch(() => ({
    result: JSON.stringify({ error: 'The Chief of Staff tool failed. Ask Jay to run /chief again.' }),
  }))

  // The one guarded road for the model: archive, stop, reply, open and start.
  on('tool.call', { tool: ACT_TOOL_FULL }, async ($, e) => {
    return { result: JSON.stringify(await actForModel($, e as unknown as Record<string, unknown>)) }
  }).catch(() => ({
    result: JSON.stringify({ ok: false, outcome: 'failed', detail: 'The Chief of Staff tool failed, so nothing was done.' }),
  }))

  // A session the Chief starts for a console or voice prompt is what it did with Jev's advice.
  on('tool.call', { tool: START_TOOL }, async ($, e, next) => {
    if (isChief && jevPending !== null) {
      const input = e as unknown as { model?: unknown }
      const id = jevPending
      jevPending = null
      await post($, '/api/mod/jev-outcome', {
        id, route: 'new_session', model: typeof input.model === 'string' ? input.model : null,
      })
    }
    return next(e)
  })

  // The archive guard: in the Chief's session, archiving a session that is working, or
  // whose helper session is, needs Jay's yes first. Only Jay's turns may archive.
  on('tool.call', { tool: ARCHIVE_TOOL }, async ($, e, next) => {
    if (!isChief) return next(e)
    const input = e as unknown as { session_id?: unknown }
    const id = typeof input.session_id === 'string' ? input.session_id.trim() : ''
    const distrust = trustRefusal()
    if (distrust !== null) {
      logAct($, 'archive', id, turnTrust === 'mixed' ? 'mixed' : 'peer', 'refused', distrust)
      return { deny: distrust }
    }
    const { refusal, session } = await actionRefusal($, 'archive', id, await peekApproval($, id, 'archive'), true)
    if (refusal !== null) return { deny: refusal }
    if (session === null) {
      logAct($, 'archive', id, 'model', 'allowed404', 'The server did not know the session; the app decides.')
    } else if (kindOf(session) !== 'desktop') {
      return { deny: 'Use cos_act for terminal and background sessions.' }
    }
    useApproval(id, 'archive')
    const result = await next(e)
    await settleHandoff($, 'archive', id, result)
    return result
  }).catch(($, e, next) => (next.called
    ? next(e)
    : { deny: 'The Chief of Staff could not check that session. Ask Jay to confirm first, then try again.' }))

  // The Chief's own desktop send: only in Jay's turns, and it settles a reply hand-off.
  on('tool.call', { tool: SEND_TOOL }, async ($, e, next) => {
    if (!isChief) return next(e)
    const input = e as unknown as { session_id?: unknown }
    const id = typeof input.session_id === 'string' ? input.session_id.trim() : ''
    const distrust = trustRefusal()
    if (distrust !== null) {
      logAct($, 'reply', id, turnTrust === 'mixed' ? 'mixed' : 'peer', 'refused', distrust)
      return { deny: distrust }
    }
    const result = await next(e)
    await settleHandoff($, 'reply', id, result)
    return result
  }).catch(($, e, next) => (next.called
    ? next(e)
    : { deny: 'The Chief of Staff could not check that send, so it did not go.' }))

  // The Chief's shell does not stop, remove or kill sessions (plan 5.6). A hint only.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (isShellAllowed(e.command) ? next(e) : { deny: SHELL_REFUSAL }))
    .catch(($, e, next) => (next.called ? next(e) : { deny: SHELL_UNCHECKED }))
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => (isShellAllowed(e.command) ? next(e) : { deny: SHELL_REFUSAL }))
    .catch(($, e, next) => (next.called ? next(e) : { deny: SHELL_UNCHECKED }))
}

function isShellAllowed(command: unknown): boolean {
  return !isChief || !KILL_COMMAND.test(String(command ?? ''))
}

// ------------------------------------------------------- who counts as Jay ---

// TYPED: Jay typed it here. PRESS: the console, the voice, Remote Control or the desktop
// host's own turns; it passes the busy guard only. NONE: anything else (plan 5.9).
function levelOf(kind: string, isOwn: boolean, text: string): Level {
  if (kind === 'composer') return 'typed'
  if (kind === 'bridge' || kind === 'sdk') return 'press'
  // The mod's own prompts: a console hand-off may run tools; a notice never may.
  if (isOwn) return NOTICE_PROMPT.test(text) ? 'none' : 'press'
  return 'none'
}

// One prompt or delivery. Inside a running turn, another session's taints that turn; one
// for the next turn joins the set the next turn start reads.
function noteOrigin(kind: string, level: Level, isInTurn: boolean): void {
  if (isInTurn && level === 'none') {
    if (PEER_KINDS.has(kind) && turnTrust === 'ok') turnTrust = 'mixed'
    return
  }
  originsSinceTurn.push({ kind, level })
}

function trustOf(origins: { level: Level }[]): 'ok' | 'mixed' | 'none' {
  if (origins.length === 0 || origins.every(o => o.level === 'none')) return 'none'
  return origins.some(o => o.level === 'none') ? 'mixed' : 'ok'
}

function trustRefusal(): string | null {
  if (turnTrust === 'ok') return null
  return turnTrust === 'mixed' ? MIXED_TURN : NOT_JAY
}

// ----------------------------------------------------------- approvals ---

function keyOf(id: string, verb: ActionVerb): string {
  return `${id === '' ? '-' : id}|${verb}`
}

// Jay's prompt after a confirm question: a yes approves what the question was about, at
// the prompt's trust level; anything else approves nothing. Every new prompt from Jay ends
// the approvals his last yes gave.
async function noteAnswer($: EngineInterface, typed: string, level: 'typed' | 'press'): Promise<void> {
  for (const [key, a] of approvals) if (a.isFromYes) approvals.delete(key)
  if (asked === null) return
  if (isYes(typed, asked.yes, asked.no)) {
    const until = (await now($)) + APPROVAL_MS
    for (const key of asked.keys) approvals.set(key, { until, source: level, isFromYes: true })
  }
  asked = null
}

function normal(text: string): string {
  return text.toLowerCase().replace(/[.!?,;:]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function isYes(typed: string, yes: string, no: string): boolean {
  const said = normal(typed)
  if (said === normal(yes)) return true
  if (said === normal(no) || said.includes(normal(no))) return false
  return YES_WORDS.test(said) && !NO_WORDS.test(said)
}

// Reads an approval and never uses it up. `typed` asks for one from Jay's own typing.
async function peekApproval($: EngineInterface, id: string, verb: ActionVerb, need: 'any' | 'typed' = 'any'): Promise<boolean> {
  const a = approvals.get(keyOf(id, verb))
  if (a === undefined) return false
  if ((await now($)) > a.until) {
    approvals.delete(keyOf(id, verb))
    return false
  }
  return need === 'any' || a.source === 'typed'
}

// Uses an approval up, right before the effect it guards runs. Returns it, so an effect
// that never ran can put it back.
function useApproval(id: string, verb: ActionVerb): Approval | undefined {
  const key = keyOf(id, verb)
  const a = approvals.get(key)
  approvals.delete(key)
  return a
}

// ---------------------------------------------------------------- guard ---

function kindOf(s: ChiefSession): ChiefSessionKind {
  if (s.kind === 'desktop' || s.kind === 'cli' || s.kind === 'bg') return s.kind
  if (s.id.startsWith('cli_')) return 'cli'
  if (s.id.startsWith('bg_')) return 'bg'
  return 'desktop'
}

function isOwnId(id: string): boolean {
  return id === 'self' || (localId !== null && id === localId) || id === `cli_${myId}` || id === `bg_${myId}`
}

// Why the Chief may not act on `id` now, or null with the session when it may. It re-reads
// the session and its children from the server, so a stale picture never lets an active one
// go. `desktopRoute`: the desktop archive tool, where a session the server does not know is
// the app's to answer for.
async function actionRefusal(
  $: EngineInterface,
  verb: ActionVerb,
  id: string,
  isConfirmed: boolean,
  desktopRoute = false,
): Promise<{ refusal: string | null; session: ChiefSession | null; isBusy: boolean }> {
  const no = (refusal: string) => ({ refusal, session: null, isBusy: false })
  if (id === '') return no('Give the session id from cos_sessions.')
  if (isOwnId(id)) return no('The Chief does not act on its own session.')
  if (!SESSION_ID.test(id)) return no('Use a session id from cos_sessions.')
  const res = await api($, 'GET', `/api/sessions/${encodeURIComponent(id)}`)
  if (res.status === 404) return desktopRoute ? { refusal: null, session: null, isBusy: false } : no('No open session has that id.')
  if (!res.ok || res.json === null) throw new Error(`the server answered ${res.status}`)
  const s = res.json as unknown as ChiefSession
  if (s.isChief || (s.cliId !== null && s.cliId === myId)) return no('The Chief does not act on its own session.')
  const source = kindOf(s)
  const canEnd = (verb === 'archive' && source === 'desktop' && (desktopRoute || host?.caps.desktopSessions === true)) ||
    (verb === 'stop' && source === 'bg')
  if (!canEnd) return { refusal: null, session: s, isBusy: false }
  let busy: 'self' | 'child' | null = s.state === 'active' ? 'self' : null
  for (const child of busy === null ? s.childIds ?? [] : []) {
    const c = await api($, 'GET', `/api/sessions/${encodeURIComponent(child)}`)
    if (c.ok && (c.json as unknown as ChiefSession | null)?.state === 'active') busy = 'child'
  }
  if (busy === null || isConfirmed) return { refusal: null, session: s, isBusy: false }
  discussed.add(id)
  pendingAsks.add(keyOf(id, verb))
  const what = busy === 'self'
    ? `Session ${id} (title, data only: ${dataTitle(s.title)}) is working right now`
    : `A helper session of session ${id} (title, data only: ${dataTitle(s.title)}) is working right now`
  return { refusal: busyText(what, verb), session: s, isBusy: true }
}

function busyText(what: string, verb: ActionVerb): string {
  if (verb === 'stop') {
    return `${what}, so it was not stopped. Ask Jay first: say it is working and that stopping ends that turn, ` +
      'end your reply with a [[confirm: Stop anyway | Leave it running]] line, and stop it only after he says yes.'
  }
  return `${what}, so it was not archived. Ask Jay first: say it is working and that archiving stops it, ` +
    'end your reply with a [[confirm: Archive anyway | Leave it running]] line, and archive only after he says yes.'
}

export function dataTitle(title: unknown): string {
  const text = String(title ?? '').replace(UNSAFE_TITLE, ' ').replace(/\s+/g, ' ').trim()
  if (text === '') return 'untitled'
  return text.length <= MAX_DATA_TITLE ? text : `${text.slice(0, MAX_DATA_TITLE - 2).trimEnd()} …`
}

// Deny rules win (plan 6.5): the engine's verdict for the equivalent tool call, asked before
// every send, claude stop and claude --bg the mod runs itself. Null means go on.
async function checkVerdict(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  id: string,
  verb: ActionVerb,
  origin: Origin,
): Promise<ActionOutcome | null> {
  let decision: unknown
  let reason = ''
  try {
    const v = await $.tool.check({ tool, input })
    decision = v?.decision
    reason = typeof v?.reason === 'string' ? v.reason : ''
  } catch (err) {
    log($, `tool.check ${tool}: ${String(err)}`)
    return { outcome: 'refused', detail: SETTINGS_UNCHECKED }
  }
  if (decision === 'allow') return null
  if (decision === 'ask') {
    if (await peekApproval($, id, verb, 'typed')) return null
    if (isDesktopChief() && !hasTypedOrigin) {
      return {
        outcome: 'refused',
        detail: 'Your settings ask before this runs. In the desktop app the Chief cannot tell your typed yes from ' +
          'other messages. Use /chief-setup permissions to set this to allow or deny.',
        needsJay: 'Run /chief-setup permissions.',
      }
    }
    pendingAsks.add(keyOf(id, verb))
    if (origin === 'console') return { outcome: 'needsConfirm', detail: "Your settings ask first. Answer in the Chief's session." }
    const label = { reply: 'Send', archive: 'Archive', stop: 'Stop', open: 'Open', start: 'Start' }[verb]
    return {
      outcome: 'needsConfirm',
      detail: `Your settings ask before this runs. Ask Jay first, and end your reply with a [[confirm: ${label} it | Leave it]] line.`,
      needsJay: 'Say yes to let it run.',
    }
  }
  if (decision === 'deny') {
    log($, `tool.check ${tool} denied: ${cleanLine(reason, 160)}`)
    return { outcome: 'refused', detail: SETTINGS_BLOCK }
  }
  return { outcome: 'refused', detail: SETTINGS_UNCHECKED }
}

function isDesktopChief(): boolean {
  return host?.surface === 'desktop' || startSurface === 'desktop'
}

// ------------------------------------------------------------ capabilities ---

// What this session can do, not which app hosts it (plan D1). It never throws.
async function detectCaps($: EngineInterface): Promise<ChiefHost> {
  let names: string[] = []
  let surfaces: readonly string[] = []
  try {
    names = (await $.tool.list()).map(t => t.name)
  } catch (err) {
    log($, `tool.list: ${String(err)}`)
  }
  try {
    surfaces = await $.session.surfaces()
  } catch {
    surfaces = []
  }
  const isListed = names.includes(ARCHIVE_TOOL)
  const isDesktopSurface = surfaces.includes('desktop') || startSurface === 'desktop'
  const first = surfaces[0]
  const surface = first === 'terminal' || first === 'desktop' || first === 'vscode' || first === 'mobile' ? first : startSurface
  const caps: ChiefCaps = {
    desktopSessions: isListed || isDesktopSurface,
    desktopListed: isListed,
    desktopStart: names.includes(START_TOOL) || isDesktopSurface,
    // Constants in v1: contract.md names the fields; a refusal shows per send or per run.
    sendMessage: true,
    listAgents: names.includes('ListAgents'),
    cliStop: true,
    cliStart: !(isListed || isDesktopSurface),
  }
  return { surface, caps }
}

// Re-reads the caps before an action, and tells the server when the desktop tools came or went.
async function refreshCaps($: EngineInterface): Promise<ChiefHost> {
  const before = host
  host = await detectCaps($)
  if (before !== null && before.caps.desktopSessions !== host.caps.desktopSessions) {
    void post($, '/api/mod/caps', { cliId: myId, host })
  }
  return host
}

// ---------------------------------------------------------------- router ---

// Every session action goes through here, from the console and from cos_act. The server's
// actions map decides yes, app or no (plan-b.md 4.1); the mod's own checks only make it stricter.
async function runAction($: EngineInterface, req: ActionRequest): Promise<ActionOutcome> {
  const h = await refreshCaps($)
  if (req.verb === 'start') return startSession($, req)
  const verb = req.verb as SessionAction
  const id = (req.id ?? '').trim()
  const isConfirmed = (req.origin === 'console' && req.confirmed === true) || (await peekApproval($, id, verb))
  let guard: Awaited<ReturnType<typeof actionRefusal>>
  try {
    guard = await actionRefusal($, verb, id, isConfirmed)
  } catch {
    return { outcome: 'refused', detail: NOT_CHECKED }
  }
  if (guard.refusal !== null) {
    if (!guard.isBusy) return { outcome: 'refused', detail: guard.refusal }
    return {
      outcome: 'needsConfirm',
      detail: req.origin === 'console' ? `${guard.refusal.split('. Ask Jay')[0]}.` : guard.refusal,
      needsJay: verb === 'stop' ? 'Say yes to stop it while it works.' : 'Say yes to archive it while it works.',
    }
  }
  const s = guard.session!
  // A console confirm approves this action once, for this route and for a hand-off's own call.
  if (req.origin === 'console' && req.confirmed === true && verb !== 'reply') {
    approvals.set(keyOf(id, verb), { until: (await now($)) + APPROVAL_MS, source: 'press', isFromYes: false })
  }
  if (verb === 'reply' && (req.text ?? '').trim() === '') return { outcome: 'refused', detail: 'Say what the reply should say.' }
  const source = kindOf(s)
  const avail = s.actions?.[verb]
  if (avail === 'no') return { outcome: 'refused', detail: s.actionNotes?.[verb] ?? 'The server gave no reason.' }
  if (avail === 'app') {
    // For console presses the server opens the app itself; an item that meets app is stale.
    if (req.origin === 'console') {
      return { outcome: 'unsupported', detail: 'The session changed since the console asked, so nothing was done. Try again.' }
    }
    return openInApp($, s, verb)
  }
  if (avail === undefined) {
    // An old server with no actions map: only the desktop app's own archive and reply run.
    const isOldPath = source === 'desktop' && (verb === 'archive' || verb === 'reply') && h.caps.desktopSessions
    if (!isOldPath) return { outcome: 'refused', detail: OUT_OF_DATE }
  }
  const changed = (): ActionOutcome => {
    void post($, '/api/mod/caps', { cliId: myId, host: h })
    return { outcome: 'unsupported', detail: "The Chief's tools changed since the server last heard. Try again." }
  }
  switch (`${source}:${verb}`) {
    case 'desktop:archive': return h.caps.desktopSessions ? archiveDesktop($, s, req) : changed()
    case 'desktop:reply': return h.caps.desktopSessions ? replyDesktop($, s, req) : sendTo($, s, req.text!, req.origin)
    case 'desktop:open': return openInApp($, s, 'open')
    case 'cli:reply': case 'bg:reply': return sendTo($, s, req.text!, req.origin)
    case 'bg:stop': return stopBackground($, s, isConfirmed, req.origin)
    default: return { outcome: 'unsupported', detail: 'The Chief cannot take that route now.' }
  }
}

// Row 1: the desktop app's own archive.
async function archiveDesktop($: EngineInterface, s: ChiefSession, req: ActionRequest): Promise<ActionOutcome> {
  const approval = useApproval(s.id, 'archive')
  try {
    const result = await $.mcp.call(SESSIONS_SERVER, 'archive_session', { session_id: s.id, reason: req.reason ?? '' })
    const text = textOf(result.content)
    return result.isError ? { outcome: 'failed', detail: text || 'The app did not archive it.' } : { outcome: 'done', detail: text || 'Archived.' }
  } catch (err) {
    log($, `archive_session was refused (${String(err)})`)
    // Nothing ran, so the approval stays for the Chief's own call.
    if (approval !== undefined) approvals.set(keyOf(s.id, 'archive'), approval)
    if (req.origin === 'model') {
      return { outcome: 'failed', detail: 'The app refused the archive. Try mcp__ccd_session_mgmt__archive_session.' }
    }
    handOff($, `[Action from the console] Jay pressed Archive for ${sessionRef(s.id, s.title)}. ` +
      'Look it up with cos_sessions, apply your archive rules, then archive it with the archive_session ' +
      'tool and tell Jay in one short sentence whether it worked.')
    return { outcome: 'handedOff', detail: 'Asked the Chief to archive it with its own tools. Its reply says whether it worked.' }
  }
}

// Row 4: a desktop Chief's reply: the app's send, then a send by CLI id, then a hand-off.
async function replyDesktop($: EngineInterface, s: ChiefSession, req: ActionRequest): Promise<ActionOutcome> {
  const text = req.text!
  try {
    const result = await $.mcp.call(SESSIONS_SERVER, 'send_message', { session_id: s.id, message: text })
    const said = textOf(result.content)
    return result.isError ? { outcome: 'failed', detail: said || 'The app did not send it.' } : { outcome: 'done', detail: said || 'Sent.' }
  } catch (err) {
    log($, `send_message was refused (${String(err)})`)
  }
  if (s.cliId !== null && s.cliId !== '') {
    const verdict = await checkVerdict($, 'SendMessage', { to: s.cliId, message: text }, s.id, 'reply', req.origin)
    if (verdict !== null) return verdict
    useApproval(s.id, 'reply')
    // Never by name: a string address is a name as ListAgents lists it (plan 5.2).
    const sent = await $.session.send({ to: { sessionId: s.cliId }, text }).catch(() => null)
    if (sent?.isDelivered === true) return { outcome: 'done', detail: 'Sent.' }
    if (sent !== null && sent.isDelivered === false) log($, `session.send: ${cleanLine(sent.reason, 160)}`)
  }
  if (req.origin === 'model') return { outcome: 'failed', detail: 'The app refused the send. Try again in a moment.' }
  handOff($, `[Action from the console] Jay typed a reply for ${sessionRef(s.id, s.title)} in the ` +
    'console reply box. Send the text between the two marker lines to that session with the send_message ' +
    'tool, word for word, then tell Jay in one short sentence that it went.\n' +
    `<<<reply\n${text}\n>>>`)
  return { outcome: 'handedOff', detail: 'Asked the Chief to send it with its own tools.' }
}

// The Chief does it with its own tools, in a turn of its own once the session is idle.
function handOff($: EngineInterface, text: string): void {
  originsSinceTurn.push({ kind: 'console-action', level: 'press' })
  $.prompt.submit({ text }).catch(err => log($, `hand-off prompt: ${String(err)}`))
}

const SEND_FAILED: Record<ChiefSessionKind, string> = {
  desktop: 'That desktop session could not be reached from this terminal. Open it in the app to reply there.',
  cli: 'That terminal session did not take the message. It may have closed, or it holds messages for approval.',
  bg: 'That background session did not take the message. It may have stopped.',
}

// Rows 5, 8 and 12: the engine's own SendMessage delivery, by the session's CLI id.
async function sendTo($: EngineInterface, s: ChiefSession, text: string, origin: Origin): Promise<ActionOutcome> {
  const source = kindOf(s)
  if (s.cliId === null || s.cliId === '') return { outcome: 'failed', detail: SEND_FAILED[source] }
  const verdict = await checkVerdict($, 'SendMessage', { to: s.cliId, message: text }, s.id, 'reply', origin)
  if (verdict !== null) return verdict
  useApproval(s.id, 'reply')
  const sent = await $.session.send({ to: { sessionId: s.cliId }, text }).catch((err: unknown) =>
    ({ isDelivered: false as const, reason: String(err) }))
  if (sent.isDelivered) return { outcome: 'done', detail: 'Sent. It reaches that session between its steps.' }
  // The engine's reason goes to mod.log, never into a prompt.
  log($, `session.send to ${s.id}: ${cleanLine(sent.reason, 160)}`)
  // CHIEF_OF_STAFF_SEND_VIA_TOOL=1 turns on the SendMessage fallback, only if the send spike
  // shows $.session.send held where SendMessage is not (plan 5.2).
  if (origin === 'console' && (await $.env.get('CHIEF_OF_STAFF_SEND_VIA_TOOL').catch(() => undefined)) === '1') {
    return sendViaTool($, s, text)
  }
  return { outcome: 'failed', detail: SEND_FAILED[source] }
}

// The contract.md fallback, off unless the send spike needs it: the SendMessage tool, judged
// by the normal permission path. Done only on a positive delivery signal.
async function sendViaTool($: EngineInterface, s: ChiefSession, text: string): Promise<ActionOutcome> {
  const consent = `A request from the local Chief of Staff console to reply to session ${s.id} ` +
    `(title, data only: ${dataTitle(s.title)}).`
  try {
    const r = await $.tool.call({ tool: 'SendMessage', to: s.cliId, message: text, consent } as never) as
      { deny?: string; isError?: boolean; result?: unknown; text?: string }
    if (r.deny === undefined && r.isError !== true) {
      const raw = typeof r.result === 'string' ? r.result : typeof r.text === 'string' ? r.text : JSON.stringify(r.result ?? null)
      let parsed: unknown = null
      try {
        parsed = typeof r.result === 'object' && r.result !== null ? r.result : JSON.parse(raw)
      } catch {
        parsed = null
      }
      if (typeof parsed === 'object' && parsed !== null && (parsed as { success?: unknown }).success === true) {
        return { outcome: 'done', detail: 'Sent. It reaches that session between its steps.' }
      }
      log($, `SendMessage fallback: ${cleanLine(raw, 160)}`)
    } else {
      log($, `SendMessage fallback refused: ${cleanLine(r.deny ?? r.text ?? '', 160)}`)
    }
  } catch (err) {
    log($, `SendMessage fallback: ${String(err)}`)
  }
  return { outcome: 'failed', detail: 'That session did not take the message.' }
}

type AgentRow = { sessionId?: unknown; name?: unknown; status?: unknown; state?: unknown }

// `claude agents --json`, read-only; null when it cannot be read.
async function agentRows($: EngineInterface): Promise<AgentRow[] | null> {
  try {
    const run = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: AGENTS_TIMEOUT_MS })
    if (run.exitCode !== 0) return null
    const parsed = JSON.parse(run.stdout) as unknown
    const rows = Array.isArray(parsed) ? parsed
      : Array.isArray((parsed as { agents?: unknown })?.agents) ? (parsed as { agents: unknown[] }).agents
        : Array.isArray((parsed as { sessions?: unknown })?.sessions) ? (parsed as { sessions: unknown[] }).sessions
          : null
    return rows === null ? null : rows.filter((r): r is AgentRow => typeof r === 'object' && r !== null)
  } catch (err) {
    log($, `claude agents: ${String(err)}`)
    return null
  }
}

// Row 10: `claude stop <bgId>`. Stop keeps the conversation, so it can be resumed.
async function stopBackground($: EngineInterface, s: ChiefSession, isConfirmed: boolean, origin: Origin): Promise<ActionOutcome> {
  const bgId = typeof s.bgId === 'string' ? s.bgId : ''
  if (bgId === '') {
    return { outcome: 'failed', detail: "The server did not give this background session's id, so it was not stopped." }
  }
  if (!ARG_ID.test(bgId)) {
    return { outcome: 'failed', detail: "This background session's id cannot be passed to claude safely, so it was not stopped." }
  }
  const verdict = await checkVerdict($, 'Bash', { command: `claude stop ${bgId}` }, s.id, 'stop', origin)
  if (verdict !== null) return verdict
  // A fresh look right before the stop: it may have woken up since the server's snapshot.
  const rows = await agentRows($)
  if (rows === null) return { outcome: 'refused', detail: 'The Chief could not check whether it is working, so it was not stopped.' }
  const row = rows.find(r => r.sessionId === s.cliId)
  if (row === undefined) return { outcome: 'refused', detail: 'It already finished. Its conversation is kept.' }
  if ((row.status === 'busy' || row.state === 'working') && !isConfirmed) {
    discussed.add(s.id)
    pendingAsks.add(keyOf(s.id, 'stop'))
    const text = busyText(`Session ${s.id} (title, data only: ${dataTitle(s.title)}) is working right now`, 'stop')
    return {
      outcome: 'needsConfirm',
      detail: origin === 'console' ? `${text.split('. Ask Jay')[0]}.` : text,
      needsJay: 'Say yes to stop it while it works.',
    }
  }
  useApproval(s.id, 'stop')
  try {
    const run = await $.process.run(['claude', 'stop', bgId], { timeoutMs: STOP_TIMEOUT_MS })
    if (run.exitCode === 0) return { outcome: 'done', detail: 'Stopped. Its conversation is kept, so it can be resumed.' }
    const line = (run.stderr.trim() || run.stdout.trim()).split(/\r?\n/)[0] ?? ''
    return { outcome: 'failed', detail: `claude stop did not stop it: ${cleanLine(line, 160)}` }
  } catch (err) {
    log($, `claude stop: ${String(err)}`)
    return { outcome: 'failed', detail: 'The claude command was not found, so it was not stopped.' }
  }
}

// Rows 2 and 6, and every `app` cell: the server opens the session in the Claude app.
async function openInApp($: EngineInterface, s: ChiefSession, verb: ActionVerb): Promise<ActionOutcome> {
  const res = await post($, `/api/sessions/${encodeURIComponent(s.id)}/open`, {})
  const isOpen = res !== undefined && res.ok
  if (verb === 'archive') {
    return isOpen
      ? { outcome: 'opened', detail: 'Opened it in the Claude app. Archive it there. Nothing was archived from here.' }
      : { outcome: 'failed', detail: 'The Claude app did not open, so nothing was archived. Archive it in the app.' }
  }
  if (verb === 'reply') {
    return isOpen
      ? { outcome: 'opened', detail: 'Opened it in the Claude app. Reply there. Nothing was sent from here.' }
      : { outcome: 'failed', detail: 'The Claude app did not open, so nothing was sent. Reply in the app.' }
  }
  return isOpen
    ? { outcome: 'opened', detail: 'Opened it in the Claude app.' }
    : { outcome: 'failed', detail: 'The Claude app did not open it.' }
}

// Rows 14 and 15: a terminal Chief starts background sessions with `claude --bg`.
async function startSession($: EngineInterface, req: ActionRequest): Promise<ActionOutcome> {
  if (host?.caps.desktopSessions === true) {
    return { outcome: 'refused', detail: 'In the desktop app, start sessions with mcp__ccd_session__start_session.' }
  }
  const cwd = (req.cwd ?? '').trim()
  const isDir = cwd !== '' && (await $.fs.stat(cwd).then(st => st.kind === 'dir', () => false))
  if (!isDir) return { outcome: 'refused', detail: 'That folder does not exist.' }
  const text = (req.text ?? '').trim()
  if (text === '') return { outcome: 'refused', detail: 'Say what the new session should do.' }
  if (text.length > MAX_START_TEXT) return { outcome: 'refused', detail: 'The task text is too long. Keep it under 4000 characters.' }
  if (text.startsWith('-')) return { outcome: 'refused', detail: 'The task text cannot start with a dash.' }
  const { name, tag } = startName(req.title ?? '', cwd, text)
  if (!ARG_ID.test(name)) return { outcome: 'refused', detail: 'That title cannot be used as a session name.' }
  const model = typeof req.model === 'string' && START_MODELS.has(req.model) ? req.model : undefined
  // The same request inside two minutes is the same start: the tag is reserved before any wait.
  const at = await now($)
  const recent = recentStarts.get(tag)
  if (recent !== undefined && at - recent < RECENT_START_MS) return { outcome: 'done', detail: `That session is already starting: ${name}.` }
  recentStarts.set(tag, at)
  const free = (o: ActionOutcome): ActionOutcome => (recentStarts.delete(tag), o)
  const rows = await agentRows($)
  if (rows === null) log($, 'start: the duplicate check could not read claude agents')
  const running = rows?.find(r => typeof r.name === 'string' && r.name.endsWith(`-${tag}`))
  if (running !== undefined) return { outcome: 'done', detail: `That session is already running: ${String(running.name)}.` }
  const argv = ['claude', '--bg', '--name', name, ...(model !== undefined ? ['--model', model] : []), '--', text]
  const verdict = await checkVerdict($, 'Bash', { command: shellLine(argv) }, '', 'start', 'model')
  if (verdict !== null) return free(verdict)
  useApproval('', 'start')
  let result: ActionOutcome
  try {
    const run = await $.process.run(argv, { cwd, timeoutMs: BG_START_TIMEOUT_MS })
    if (run.exitCode !== 0) {
      const line = (run.stderr.trim() || run.stdout.trim()).split(/\r?\n/)[0] ?? ''
      return free({ outcome: 'failed', detail: `claude --bg did not start it: ${cleanLine(line, 160)}` })
    }
    recentStarts.set(tag, await now($))
    result = { outcome: 'done', detail: `Starting ${name}. It shows in the console within a minute.` }
  } catch (err) {
    // A timeout, or a worker that kept the pipe open: look once, and keep the tag reserved.
    log($, `claude --bg: ${String(err)}`)
    const after = await agentRows($)
    const seen = after?.some(r => typeof r.name === 'string' && r.name.endsWith(`-${tag}`)) === true
    if (!seen) {
      return {
        outcome: 'failed',
        detail: 'claude --bg did not answer in time. It may still be starting, so check cos_sessions before you ask again.',
      }
    }
    result = { outcome: 'done', detail: `Starting ${name}. It shows in the console within a minute.` }
  }
  if (jevPending !== null) {
    const id = jevPending
    jevPending = null
    await post($, '/api/mod/jev-outcome', { id, route: 'new_session', model: model ?? null })
  }
  return result
}

// The one name format: a slug of the title, then a tag that the same folder and task always give.
function startName(title: string, cwd: string, text: string): { name: string; tag: string } {
  const tag = `chief-${shortHash(`${cwd}\n${text}`)}`
  const slug = (title.trim() || 'task').replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 50)
  return { name: `${slug === '' ? 'task' : slug}-${tag}`, tag }
}

function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0').slice(0, 6)
}

// The command as the permission check reads it. The run itself is argv, with no shell.
function shellLine(argv: readonly string[]): string {
  return argv.map(a => (/^[A-Za-z0-9_./:=-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(' ')
}

// ---------------------------------------------------------------- cos_act ---

async function actForModel($: EngineInterface, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = typeof input.action === 'string' ? input.action : ''
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const reply = (o: ActionOutcome) => ({ ok: o.outcome === 'done', ...o })
  if (!isChief) return reply({ outcome: 'refused', detail: 'This session is not the Chief of Staff.' })
  if (!['archive', 'stop', 'reply', 'open', 'start'].includes(action)) {
    return reply({ outcome: 'refused', detail: 'Use one of archive, stop, reply, open or start.' })
  }
  const verb = action as ActionVerb
  const distrust = trustRefusal()
  if (distrust !== null) {
    logAct($, verb, id, turnTrust === 'mixed' ? 'mixed' : 'peer', 'refused', distrust)
    return reply({ outcome: 'refused', detail: distrust })
  }
  if (verb !== 'start' && id === '') return reply({ outcome: 'refused', detail: 'Give the session id from cos_sessions.' })
  if (id !== '') discussed.add(id)
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  // `confirmed` is not read: only Jay confirms.
  const o = await runAction($, {
    verb, id, text: str(input.text), reason: str(input.reason), cwd: str(input.cwd), title: str(input.title),
    model: str(input.model), origin: 'model',
  })
  if (o.needsJay === undefined) {
    if (o.outcome === 'opened' && verb === 'archive') o.needsJay = 'Archive it in the Claude app.'
    if (o.outcome === 'opened' && verb === 'reply') o.needsJay = 'Reply to it in the Claude app.'
    if (o.outcome === 'refused' && (verb === 'archive' || verb === 'stop') && id.startsWith('cli_')) {
      o.needsJay = 'Close that terminal session yourself: type /exit in it.'
    }
  }
  logAct($, verb, id, 'model', o.outcome, o.detail)
  if (verb !== 'start') {
    await settleHandoff($, verb, id, o.outcome === 'done' ? { result: o.detail } : { deny: o.detail })
  }
  return reply(o)
}

async function registerActTool($: EngineInterface, isActive: boolean): Promise<void> {
  await $.tool.register({
    name: ACT_TOOL,
    description:
      "Chief of Staff: act on one of Jay's sessions, with the Chief's guard. archive (desktop sessions), stop " +
      '(background sessions, ends the running turn, keeps the conversation), reply (send text to a session), open ' +
      '(open a desktop session in the Claude app) and start (a new background session in a folder, from a terminal ' +
      'Chief). Ids come from cos_sessions. The result says done, refused, failed, needsConfirm or opened; ' +
      'needsConfirm means ask Jay first, and needsJay says what he must do.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['archive', 'stop', 'reply', 'open', 'start'], description: 'What to do.' },
        id: { type: 'string', description: 'The session id (local_, cli_ or bg_) from cos_sessions. Required except for start.' },
        text: { type: 'string', description: "The reply's exact words, or the new session's task for start." },
        reason: { type: 'string', description: 'Why, in a few words (archive).' },
        cwd: { type: 'string', description: 'The absolute folder the new session runs in (start).' },
        title: { type: 'string', description: "The new session's short name (start)." },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], description: 'The model for the new session (start).' },
      },
      required: ['action'],
    },
    isDeferred: !isActive,
  })
}

// ------------------------------------------------------------- the role ---

// Marks this session as the Chief now, then starts the server in the background.
// One Chief runs on a machine: while another session holds the role, the claim is
// refused, and the answer is what the model is told instead of the Chief's steps.
async function claim($: EngineInterface): Promise<string | null> {
  const at = await now($)
  if (isChief && at - becameAt < BECOME_DEDUPE_MS) return null
  if (refused !== null && at - refused.at < BECOME_DEDUPE_MS) return refused.text
  if (myId === '') myId = await $.session.id()
  const holder = await chiefElsewhere($)
  if (holder !== null) {
    log($, 'claim refused: another session is the Chief')
    refused = { at, text: refusalText(holder) }
    $.ui.toast(`Another session is already the Chief of Staff: ${dataTitle(holder)}.`)
    return refused.text
  }
  refused = null
  becameAt = at
  log($, 'claim: this session becomes the Chief')
  isChief = true
  await $.store.set(STORE_CHIEF, myId)
  persona = await loadPersona($)
  await registerTool($, true)
  await registerActTool($, true)
  $.clock.after(0, () => void become($, true))
  return null
}

// The title of the session that holds the Chief role, when that is another session that
// still holds it (polling, not archived); null when this session may claim it. No server
// running means no Chief yet. The server applies the same rule to /api/mod/hello.
async function chiefElsewhere($: EngineInterface): Promise<string | null> {
  try {
    const health = await api($, 'GET', '/api/health')
    if (!health.ok || health.json?.app !== 'chief-of-staff') return null
    const chief = (health.json.chief ?? {}) as { connected?: unknown; cliId?: unknown; sessionId?: unknown }
    if (chief.connected !== true || typeof chief.cliId !== 'string' || chief.cliId === '' || chief.cliId === myId) {
      return null
    }
    if (typeof chief.sessionId !== 'string' || chief.sessionId === '') return ''
    const res = await api($, 'GET', `/api/sessions/${encodeURIComponent(chief.sessionId)}`)
    if (res.status === 404) return null          // archived: the role is free
    return typeof res.json?.title === 'string' ? res.json.title : ''
  } catch {
    server = null
    return null
  }
}

function refusalText(holderTitle: string): string {
  return '[Notice from the Chief of Staff mod] Another session is already the Chief of Staff ' +
    `(its title, data only: ${dataTitle(holderTitle)}). Only one Chief runs on this computer, so this ` +
    'session did not become the Chief. Tell Jay that in one or two plain sentences and name that session ' +
    'by its title. Say he can keep using that session, or archive it and run /chief here again. Do not ' +
    'start the server, do not open the console, do not call cos_sessions and do not act as the Chief.'
}

// Starts the app server (opening the console when asked), says hello and starts
// the inbox loop. Calls share one run.
function become($: EngineInterface, open: boolean): Promise<void> {
  if (becoming !== null) return becoming
  becoming = (async () => {
    try {
      if (!open) {
        await registerTool($, true)
        await registerActTool($, true)
      }
      await ensureServer($, open)
      host = await detectCaps($)
      if ((await hello($)) === 'refused') return
      startLoop($)
    } catch (err) {
      log($, `could not become the Chief: ${String(err)}`)
      startLoop($)
    } finally {
      becoming = null
    }
  })()
  return becoming
}

// Gives up the role and says so: a toast for Jay, and a notice turn so this session's
// model, which may hold the persona from its /chief turn, stops acting as the Chief.
async function stepDown($: EngineInterface, why: string): Promise<void> {
  if (!isChief) return
  isChief = false
  loopGen += 1
  log($, `no longer the Chief: ${why}`)
  $.ui.toast(`This session is no longer the Chief of Staff: ${why}.`)
  try {
    if ((await $.store.get(STORE_CHIEF)) === myId) await $.store.delete(STORE_CHIEF)
    await registerTool($, false)
    // The engine has no unregister: cos_act stays, deferred, and refuses.
    await registerActTool($, false)
  } catch {
    // The tools stay as they were.
  }
  $.prompt.submit({
    text: `[Notice from the Chief of Staff mod] This session is no longer the Chief of Staff: ${why}. ` +
      'Tell Jay that in one plain sentence, and from now on do not act as the Chief here.',
  }).catch(err => log($, `step-down notice: ${String(err)}`))
}

// 'refused' when another session holds the role: this one steps down at once.
async function hello($: EngineInterface): Promise<'ok' | 'refused' | 'failed'> {
  const res = await api($, 'POST', '/api/mod/hello', { cliId: myId, isChief: true, options, host })
  if (res.status === 409 && res.json?.refused === true) {
    const chief = (res.json.chief ?? {}) as { title?: unknown }
    const title = typeof chief.title === 'string' ? chief.title : ''
    await stepDown($, `another session is already the Chief (${dataTitle(title)})`)
    return 'refused'
  }
  if (!res.ok || res.json === null) return 'failed'
  localId = typeof res.json.sessionId === 'string' ? res.json.sessionId : null
  return 'ok'
}

// --------------------------------------------------------------- server ---

async function serverJsonPath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const sep = home.includes('\\') ? '\\' : '/'
  return [home, '.claude', 'chief-of-staff', 'run', 'server.json'].join(sep)
}

async function serverInfo($: EngineInterface): Promise<ChiefServerInfo> {
  if (server !== null) return server
  const text = await $.fs.read(await serverJsonPath($))
  const info = JSON.parse(typeof text === 'string' ? text : '{}') as { port?: unknown; token?: unknown }
  if (typeof info.port !== 'number' || typeof info.token !== 'string') throw new Error('server.json is incomplete')
  server = { port: info.port, token: info.token }
  return server
}

async function api($: EngineInterface, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult> {
  const info = await serverInfo($)
  const headers: Record<string, string> = { 'X-COS-Token': info.token }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await $.http.fetch(`http://127.0.0.1:${info.port}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  // A new run of the server has a new token and maybe a new port.
  if (res.status === 401 || res.status === 403) server = null
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(res.text)
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json }
}

async function post($: EngineInterface, path: string, body: unknown): Promise<ApiResult | undefined> {
  try {
    return await api($, 'POST', path, body)
  } catch (err) {
    server = null
    log($, `${path}: ${String(err)}`)
    return undefined
  }
}

async function isHealthy($: EngineInterface): Promise<boolean> {
  try {
    const res = await api($, 'GET', '/api/health')
    return res.ok && res.json?.app === 'chief-of-staff'
  } catch {
    server = null
    return false
  }
}

// `python app.py start` brings the server up, or reports the one running; with
// --open it also opens the console in the browser. The server never restarts itself:
// an older one answers stale, and only an explicit /chief restarts it (plan 6.6).
async function ensureServer($: EngineInterface, open: boolean): Promise<void> {
  if (!open && (await isHealthy($))) return
  const app = `${$.plugin.root}/server/app.py`
  const args = ['start', ...(open ? ['--open'] : [])]
  let lastError = 'Python was not found.'
  for (const python of [['python'], ['py', '-3']]) {
    try {
      const out = await runApp($, [...python, app, ...args])
      if (out.port !== null) {
        if (out.isStale && open) {
          log($, 'the running server is older: restarting it')
          const again = await runApp($, [...python, app, 'restart', '--open'])
          if (again.port === null) throw new Error(again.error)
        } else if (out.isStale) {
          $.ui.toast('An older Chief of Staff server is running. Run /chief stop, then /chief, to update.')
        }
        log($, `server up on port ${out.port}`)
        server = null
        return
      }
      lastError = out.error
    } catch (err) {
      lastError = String(err)
    }
  }
  log($, `server did not start: ${lastError}`)
  $.ui.toast(`The Chief of Staff server did not start: ${lastError}`)
  throw new Error(lastError)
}

async function runApp($: EngineInterface, argv: string[]): Promise<{ port: number | null; isStale: boolean; error: string }> {
  const run = await $.process.run(argv, { timeoutMs: START_TIMEOUT_MS })
  const line = run.stdout.trim().split(/\r?\n/).at(-1) ?? ''
  const out = JSON.parse(line === '' ? '{}' : line) as { error?: unknown; port?: unknown; stale?: unknown }
  const port = run.exitCode === 0 && typeof out.port === 'number' ? out.port : null
  return { port, isStale: out.stale === true, error: typeof out.error === 'string' ? out.error : `exit ${run.exitCode}` }
}

// ----------------------------------------------------------- inbox loop ---

function startLoop($: EngineInterface): void {
  loopGen += 1
  backoffMs = 0
  const gen = loopGen
  $.clock.after(0, () => void poll($, gen))
}

async function poll($: EngineInterface, gen: number): Promise<void> {
  if (gen !== loopGen || !isChief) return
  let delay = POLL_GAP_MS
  try {
    const query = `wait=${POLL_WAIT_S}&cli=${encodeURIComponent(myId)}` +
      (localId !== null ? `&session=${encodeURIComponent(localId)}` : '')
    const res = await api($, 'GET', `/api/mod/inbox?${query}`)
    if (!res.ok || res.json === null) throw new Error(`inbox answered ${res.status}`)
    if (res.json.isChief === false) {
      if (!(await reclaim($))) {
        await stepDown($, 'another session ran /chief')
        return
      }
    } else {
      backoffMs = 0
      const at = await now($)
      for (const [id, d] of doneItems) if (at - d.at > DONE_ITEM_MS) doneItems.delete(id)
      const items = Array.isArray(res.json.items) ? (res.json.items as ChiefInboxItem[]) : []
      for (const item of items) {
        if (gen !== loopGen) return
        await handle($, item)
      }
    }
  } catch (err) {
    server = null
    backoffMs = backoffMs === 0 ? BACKOFF_FIRST_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS)
    delay = backoffMs
    log($, `inbox: ${String(err)}; trying again in ${delay / 1000} s`)
  }
  if (gen === loopGen && isChief) $.clock.after(delay, () => void poll($, gen))
}

// The server forgot the Chief (it restarted): say hello again, up to three times.
// Another session holding the role means this one steps down at once.
async function reclaim($: EngineInterface): Promise<boolean> {
  const health = await api($, 'GET', '/api/health')
  const chief = (health.json?.chief ?? {}) as { cliId?: unknown }
  if (typeof chief.cliId === 'string' && chief.cliId !== '' && chief.cliId !== myId) return false
  for (let i = 0; i < HELLO_TRIES; i += 1) {
    if (i > 0) await wait($, HELLO_RETRY_MS)
    try {
      const said = await hello($)
      if (said === 'ok') return true
      if (said === 'refused') return false
    } catch (err) {
      log($, `hello: ${String(err)}`)
    }
  }
  return false
}

function wait($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => void $.clock.after(ms, resolve))
}

// Session titles come from other sessions: a prompt carries the id, and the title only
// cleaned and marked as data. The app's reasons never go into a prompt.
function sessionRef(id: string, title: string): string {
  return `session ${id} (title, data only: ${dataTitle(title)})`
}

// Each inbox item runs once (plan 5.10): one in flight is skipped, one already done posts
// its stored result again, and the result is stored before it is posted.
async function handle($: EngineInterface, item: ChiefInboxItem): Promise<void> {
  const id = String(item.id)
  if (runningItems.has(id)) return
  const done = doneItems.get(id)
  if (done !== undefined) {
    await sendResult($, done.body, 0)
    return
  }
  runningItems.add(id)
  try {
    const body = await handleItem($, item)
    doneItems.set(id, { body, at: await now($) })
    await sendResult($, body, 0)
  } finally {
    runningItems.delete(id)
  }
}

async function handleItem($: EngineInterface, item: ChiefInboxItem): Promise<Record<string, unknown>> {
  if (item.type === 'prompt') {
    const text = item.text.trim()
    // Console and voice messages are Jay's own words, at press level; a notice, an old server's
    // item with no `from`, or anything else is not. The engine does not show a plugin's own
    // $.prompt.submit to its prompt.submit hook, so the answer is noted here.
    const isJay = (item.from === 'console' || item.from === 'voice') && !NOTICE_PROMPT.test(text)
    originsSinceTurn.push({ kind: isJay ? String(item.from) : 'notice', level: isJay ? 'press' : 'none' })
    if (isJay && !SERVER_PROMPT.test(text)) await noteAnswer($, text, 'press')
    // Jev's advice rides on its own line after Jay's words, never inside them, so the
    // yes or no check above reads only what Jay said.
    const hint = typeof item.hint === 'string' ? item.hint.trim() : ''
    if (item.jev !== undefined) jevPending = item.id
    const full = hint === '' ? item.text : `${item.text}

${hint}`
    // A turn of its own once the session is idle; never folded into a running turn.
    $.prompt.submit({ text: full }).catch(err => log($, `prompt: ${String(err)}`))
    // Acknowledged, so the server does not send it again.
    return { actionId: item.id, ok: true }
  }
  if (item.type === 'archive' || item.type === 'stop' || item.type === 'reply') {
    const o = await runAction($, {
      verb: item.type,
      id: item.sessionId,
      text: item.type === 'reply' ? item.text : undefined,
      reason: item.type === 'reply' ? undefined : item.reason,
      confirmed: item.type !== 'reply' && item.confirmed === true,
      origin: 'console',
    })
    if (o.outcome === 'handedOff') {
      handoffs.set(item.id, { verb: item.type, sessionId: item.sessionId, until: (await now($)) + HANDOFF_MS })
    }
    logAct($, item.type, item.sessionId, 'console', o.outcome, o.detail)
    return resultBody(item.id, o)
  }
  const unknown = item as { id: string; type?: unknown }
  const o: ActionOutcome = { outcome: 'unsupported', detail: 'The Chief does not know that kind of request.' }
  logAct($, String(unknown.type ?? '?'), '-', 'console', o.outcome, o.detail)
  return resultBody(unknown.id, o)
}

function resultBody(actionId: string, o: ActionOutcome): Record<string, unknown> {
  return { actionId, ok: o.outcome === 'done', outcome: o.outcome, detail: o.detail.slice(0, 500) }
}

// Posts a result, and tries again after 1, 4 and 15 s when the server does not take it.
// A late result is fine: the server publishes it after its own expiry.
async function sendResult($: EngineInterface, body: Record<string, unknown>, attempt: number): Promise<void> {
  const res = await post($, '/api/mod/result', body)
  if (res !== undefined && res.ok) return
  const delay = RESULT_RETRY_MS[attempt]
  if (delay === undefined) {
    log($, `result ${String(body.actionId)} was not taken after ${attempt + 1} tries`)
    return
  }
  $.clock.after(delay, () => void sendResult($, body, attempt + 1))
}

// The Chief's own call that matches a hand-off posts its second, final result (plan 6.4).
async function settleHandoff(
  $: EngineInterface,
  verb: ActionVerb,
  sessionId: string,
  result: { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown },
): Promise<void> {
  const at = await now($)
  for (const [actionId, h] of handoffs) {
    if (at > h.until) {
      handoffs.delete(actionId)
      continue
    }
    if (h.verb !== verb || h.sessionId !== sessionId) continue
    handoffs.delete(actionId)
    const isOk = result.deny === undefined && result.isError !== true
    const said = typeof result.deny === 'string' ? result.deny : typeof result.text === 'string' ? result.text
      : typeof result.result === 'string' ? result.result : ''
    const o: ActionOutcome = { outcome: isOk ? 'done' : 'failed', detail: said.trim() || (isOk ? 'Done.' : 'It did not work.') }
    logAct($, verb, sessionId, 'handoff', o.outcome, o.detail)
    await sendResult($, resultBody(actionId, o), 0)
    return
  }
}

function textOf(content: readonly unknown[]): string {
  return content
    .map(b => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text'
      ? String((b as { text?: unknown }).text ?? '')
      : ''))
    .filter(t => t !== '')
    .join(' ')
    .trim()
}

// --------------------------------------------------------------- replies ---

async function sendReply($: EngineInterface, answer: string, turnId: string): Promise<void> {
  await post($, '/api/mod/busy', { busy: false, cliId: myId })
  if (answer.trim() === '') return
  const { text, confirm } = splitConfirm(answer)
  if (text === '' && confirm === null) return
  await post($, '/api/mod/reply', { text, turnId, ...(confirm !== null ? { confirm } : {}) })
}

// Takes the [[confirm: yes | no]] line off a reply: the console draws it as two
// buttons and the voice never reads it.
export function splitConfirm(answer: string): { text: string; confirm: ChiefConfirm | null } {
  const lines = answer.replace(/\r\n/g, '\n').split('\n')
  let confirm: ChiefConfirm | null = null
  const kept: string[] = []
  for (const line of lines) {
    const m = CONFIRM_LINE.exec(line)
    if (m === null) {
      kept.push(line)
      continue
    }
    confirm = { question: '', yes: m[1]!.trim(), no: m[2]!.trim() }
  }
  const text = kept.join('\n').trim()
  if (confirm !== null) {
    const asks = text.match(/[^.!?\n]*\?/g)
    confirm.question = asks !== null ? asks[asks.length - 1]!.trim() : ''
  }
  return { text, confirm }
}

// ------------------------------------------------------------------ tool ---

async function registerTool($: EngineInterface, inPrompt: boolean): Promise<void> {
  await $.tool.register({
    name: TOOL,
    description:
      "Chief of Staff: Jay's open Claude sessions (desktop app, terminal and background) and their state, from " +
      'the local Chief of Staff server. No input lists the sessions in view (live or active lately) with id, ' +
      'kind, title, state (you = waiting on Jay, active = working now, wait = idle or waiting on something else, ' +
      'stale), stateReason, summary, needsAction and which actions the Chief can take. { "id": "local_..." } ' +
      'returns one session in more detail. { "all": true } lists every open session. Call this first, before ' +
      'cos_act or the session tools.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One session id (local_, cli_ or bg_), for its details.' },
        all: { type: 'boolean', description: 'List every open session, not only those in view.' },
      },
      additionalProperties: false,
    },
    isDeferred: !inPrompt,
  })
}

const STATE_ORDER: Record<string, number> = { you: 0, active: 1, wait: 2, stale: 3 }

async function sessionsForModel($: EngineInterface, id: string | undefined, all: boolean): Promise<string> {
  if (becoming !== null) await becoming
  try {
    const at = await now($)
    if (id !== undefined) {
      const res = await api($, 'GET', `/api/sessions/${encodeURIComponent(id)}?by=chief`)
      if (res.status === 404) return JSON.stringify({ error: 'No open session has that id.' })
      if (!res.ok || res.json === null) throw new Error(`answered ${res.status}`)
      const s = res.json as unknown as ChiefSession
      return JSON.stringify({
        ...compact(s, at),
        repo: s.repo, branch: s.branch, prNumber: s.prNumber, prState: s.prState,
        childIds: s.childIds,
      })
    }
    const res = await api($, 'GET', '/api/sessions')
    if (!res.ok || res.json === null) throw new Error(`answered ${res.status}`)
    const list = (Array.isArray(res.json.sessions) ? res.json.sessions : []) as ChiefSession[]
    // The Chief never lists itself, also before the server knows its desktop id.
    const others = list.filter(s => !s.isChief && s.id !== localId && s.cliId !== myId)
    const shown = all ? others : others.filter(s => s.inView !== false)
    shown.sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
      (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    return JSON.stringify({
      counts: res.json.countsInView ?? res.json.counts,
      liveStatusMayBeOld: res.json.liveStale === true,
      sessions: shown.map(s => compact(s, at)),
      notShown: others.length - shown.length,
    })
  } catch (err) {
    server = null
    return JSON.stringify({
      error: 'The Chief of Staff server is not answering. Ask Jay to run /chief again.',
      detail: String(err),
    })
  }
}

function compact(s: ChiefSession, at: number) {
  return {
    id: s.id,
    kind: s.kind,
    bgId: s.bgId,
    title: s.title,
    state: s.state,
    stateReason: s.stateReason,
    summary: s.summary,
    needsAction: s.needsAction,
    parentId: s.parentId,
    live: s.live,
    lastActivityAt: s.lastActivityAt,
    lastActivity: s.lastActivityAt ? ago(at - s.lastActivityAt) : null,
    actions: s.actions,
    actionNotes: s.actionNotes,
  }
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
}

// --------------------------------------------------------------- helpers ---

// The chief_name setting as the prompt may hold it: letters, digits, spaces, apostrophes
// and hyphens, at most 30 characters; "Chief" when empty. The server cleans it the same way.
export function chiefName(value: unknown): string {
  const text = String(value ?? '').replace(/[^A-Za-z0-9 '-]/g, ' ').replace(/\s+/g, ' ').slice(0, 30).trim()
  return text === '' ? 'Chief' : text
}

async function loadPersona($: EngineInterface): Promise<string> {
  try {
    const raw = await $.fs.read(`${$.plugin.root}/agents/chief.md`)
    const text = typeof raw === 'string' ? raw : ''
    // The agent file's body, without its frontmatter, with the Chief's name filled in.
    const name = chiefName(options.chief_name)
    return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim().replace(/\{name\}/g, name)
  } catch (err) {
    log($, `could not read the persona: ${String(err)}`)
    return ''
  }
}

async function now($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

// One line of text from elsewhere, safe for a log line: no newlines, quotes or brackets.
function cleanLine(text: unknown, max: number): string {
  const line = String(text ?? '').replace(UNSAFE_TITLE, ' ').replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : line.slice(0, max)
}

// One line per action for /chief-setup's check (plan 6.8):
// act: <verb> <sessionId|-> <origin> <outcome> <detail>
function logAct($: EngineInterface, verb: string, id: string, origin: string, outcome: string, detail: string): void {
  log($, `act: ${verb} ${cleanLine(id, 90) || '-'} ${origin} ${outcome} ${cleanLine(detail, 160)}`)
}

function log($: EngineInterface, text: string): void {
  try {
    $.ui.log(`chief-of-staff: ${text}`, { to: 'debug' })
  } catch {
    // Logging never matters more than the work.
  }
  logLines.push(`${new Date().toISOString()} ${text}`)
  if (logLines.length > LOG_KEEP) logLines.splice(0, logLines.length - LOG_KEEP)
  void writeLog($)
}

// The last LOG_KEEP lines go to HOME\logs\mod.log too, so a /chief that does not
// start can be read without the engine's debug log.
async function writeLog($: EngineInterface): Promise<void> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    if (home === '') return
    const sep = home.includes('\\') ? '\\' : '/'
    await $.fs.write([home, '.claude', 'chief-of-staff', 'logs', 'mod.log'].join(sep), logLines.join('\n') + '\n')
  } catch {
    // Same as above.
  }
}
