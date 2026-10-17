import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ChiefConfirm, ChiefInboxItem, ChiefServerInfo, ChiefSession } from '../types'

// The Chief of Staff mod (docs/contracts.md section 6). It loads in every
// session and does its work only in the Chief's: the session where /chief ran.
// There it adds the Chief's persona to the system prompt, long-polls the app
// server's inbox for prompts and actions, posts each reply, and serves the
// cos_sessions tool.

const STORE_CHIEF = 'chief:session'
const TOOL = 'cos_sessions'
const TOOL_FULL = 'mcp__chief-of-staff__cos_sessions'
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
// An archive Jay confirmed in the console stays approved this long for the Chief's own call.
const CONSOLE_APPROVAL_MS = 120000
const HELLO_TRIES = 3
const HELLO_RETRY_MS = 1000
const MAX_DATA_TITLE = 80
// Control and direction characters, quotes and brackets: what a title must not bring into a prompt.
const UNSAFE_TITLE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩"'`‘’“”[\]{}<>()]/g
const YES_WORDS = /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do|confirm|confirmed|archive)\b/
const NO_WORDS = /\b(no|nope|not|don't|dont|do not|wait|stop|leave|cancel|keep)\b/
// Prompts from the server, not answers from Jay.
const SERVER_PROMPT = /^\[(Notice|Action)\b/

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

// The archive guard's memory. `discussed`: sessions the Chief looked up or was refused
// in the current turn. `asked`: the last reply's confirm question and what it was about.
// `approved`: what Jay's answer to it approved, until his next prompt.
// `consoleApproved`: archives Jay confirmed in the console, by session id, with a deadline.
let discussed = new Set<string>()
let asked: { ids: string[]; text: string; yes: string; no: string } | null = null
let approved: { ids: string[]; text: string } | null = null
const consoleApproved = new Map<string, number>()
const LOG_KEEP = 200
const logLines: string[] = []

type ApiResult = { status: number; ok: boolean; json: Record<string, unknown> | null }

export const register: Register = (on, opts) => {
  options = opts ?? {}

  on('session.start', async ($, e, next) => {
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
      if (isChief && !SERVER_PROMPT.test(typed) && !CHIEF_COMMAND.test(typed)) noteAnswer(typed)
      if (CHIEF_COMMAND.test(typed)) {
        // `/chief stop` and `/chief status` only manage the server; they make no Chief.
        const word = typed.split(/\s+/)[1]?.toLowerCase() ?? ''
        if (word === 'stop' || word === 'status') {
          skipSkillClaimUntil = (await now($)) + BECOME_DEDUPE_MS
          return next(e)
        }
        await claim($)
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

  on('skill.prompt', async ($, e, next) => {
    try {
      const isChiefSkill = e.skill === 'chief' || e.skill === 'chief-of-staff:chief'
      log($, `skill.prompt ${e.skill}${isChiefSkill ? ' (the Chief skill)' : ''}`)
      if (isChiefSkill && (await now($)) >= skipSkillClaimUntil) await claim($)
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
        await claim($)
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
    if (isChief) {
      discussed = new Set()
      $.clock.after(0, () => void post($, '/api/mod/busy', { busy: true }))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!isChief || e.agentId !== undefined) return result
    const answer = e.reason === 'answer' && !e.isAborted ? e.answer : ''
    const turnId = e.turnId
    if (answer.trim() !== '') {
      // The reply's confirm question, if any, is what Jay's next prompt answers. A
      // reply without one (a notice in between) leaves the open question alone;
      // Jay's next own message answers or clears it in noteAnswer.
      const { text, confirm } = splitConfirm(answer)
      if (confirm !== null) asked = { ids: [...discussed], text: text.toLowerCase(), yes: confirm.yes, no: confirm.no }
    }
    $.clock.after(0, () => void sendReply($, answer, turnId))
    return result
  })

  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const input = e as unknown as { id?: unknown; all?: unknown }
    const id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : undefined
    if (id !== undefined) discussed.add(id)
    return { result: await sessionsForModel($, id, input.all === true) }
  }).catch(() => ({
    result: JSON.stringify({ error: 'The Chief of Staff tool failed. Ask Jay to run /chief again.' }),
  }))

  // The archive guard: in the Chief's session, archiving a session that is working, or
  // whose helper session is, needs Jay's yes first.
  on('tool.call', { tool: ARCHIVE_TOOL }, async ($, e, next) => {
    if (!isChief) return next(e)
    const input = e as unknown as { session_id?: unknown }
    const id = typeof input.session_id === 'string' ? input.session_id.trim() : ''
    const refusal = await archiveRefusal($, id, await isApproved($, id))
    if (refusal !== null) return { deny: refusal }
    return next(e)
  }).catch(($, e, next) => (next.called
    ? next(e)
    : { deny: 'The Chief of Staff could not check that session. Ask Jay to confirm first, then try again.' }))
}

// ------------------------------------------------------- archive guard ---

// Jay's prompt after a confirm question: a yes approves what the question was about,
// anything else approves nothing. Every new prompt from Jay ends the last approval.
function noteAnswer(typed: string): void {
  approved = null
  if (asked === null) return
  if (isYes(typed, asked.yes, asked.no)) approved = { ids: asked.ids, text: asked.text }
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

async function isApproved($: EngineInterface, id: string): Promise<boolean> {
  const until = consoleApproved.get(id)
  if (until !== undefined && (await now($)) <= until) return true
  if (approved === null) return false
  if (approved.ids.includes(id)) return true
  // The question named the session by its title or id.
  try {
    const res = await api($, 'GET', `/api/sessions/${encodeURIComponent(id)}`)
    const title = typeof res.json?.title === 'string' ? res.json.title.toLowerCase() : ''
    return approved.text.includes(id.toLowerCase()) || (title.length >= 3 && approved.text.includes(title))
  } catch {
    return approved.text.includes(id.toLowerCase())
  }
}

// Why the Chief may not archive `id` now, or null when it may. It re-reads the session
// and its children from the server, so a stale picture never lets an active one go.
async function archiveRefusal($: EngineInterface, id: string, isConfirmed: boolean): Promise<string | null> {
  if (id === 'self' || id === localId) return 'The Chief does not archive its own session.'
  if (!id.startsWith('local_')) return 'Use the session id that starts with local_, from cos_sessions.'
  const res = await api($, 'GET', `/api/sessions/${encodeURIComponent(id)}`)
  if (res.status === 404) return null          // not open any more: the app answers for itself
  if (!res.ok || res.json === null) throw new Error(`the server answered ${res.status}`)
  const s = res.json as unknown as ChiefSession
  if (s.isChief) return 'The Chief does not archive its own session.'
  let busy: 'self' | 'child' | null = s.state === 'active' ? 'self' : null
  for (const child of busy === null ? s.childIds ?? [] : []) {
    const c = await api($, 'GET', `/api/sessions/${encodeURIComponent(child)}`)
    if (c.ok && (c.json as unknown as ChiefSession | null)?.state === 'active') busy = 'child'
  }
  if (busy === null || isConfirmed) return null
  discussed.add(id)
  const what = busy === 'self'
    ? `Session ${id} (title, data only: ${dataTitle(s.title)}) is working right now`
    : `A helper session of session ${id} (title, data only: ${dataTitle(s.title)}) is working right now`
  return `${what}, so it was not archived. Ask Jay first: say it is working and that archiving stops it, ` +
    'end your reply with a [[confirm: Archive anyway | Leave it running]] line, and archive only after he says yes.'
}

export function dataTitle(title: unknown): string {
  const text = String(title ?? '').replace(UNSAFE_TITLE, ' ').replace(/\s+/g, ' ').trim()
  if (text === '') return 'untitled'
  return text.length <= MAX_DATA_TITLE ? text : `${text.slice(0, MAX_DATA_TITLE - 2).trimEnd()} …`
}

// ------------------------------------------------------------- the role ---

// Marks this session as the Chief now, then starts the server in the background.
async function claim($: EngineInterface): Promise<void> {
  const at = await now($)
  if (isChief && at - becameAt < BECOME_DEDUPE_MS) return
  becameAt = at
  log($, 'claim: this session becomes the Chief')
  if (myId === '') myId = await $.session.id()
  isChief = true
  await $.store.set(STORE_CHIEF, myId)
  persona = await loadPersona($)
  await registerTool($, true)
  $.clock.after(0, () => void become($, true))
}

// Starts the app server (opening the console when asked), says hello and starts
// the inbox loop. Calls share one run.
function become($: EngineInterface, open: boolean): Promise<void> {
  if (becoming !== null) return becoming
  becoming = (async () => {
    try {
      if (!open) await registerTool($, true)
      await ensureServer($, open)
      await hello($)
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

async function stepDown($: EngineInterface, why: string): Promise<void> {
  isChief = false
  loopGen += 1
  log($, `no longer the Chief: ${why}`)
  try {
    await registerTool($, false)
  } catch {
    // The tool stays as it was.
  }
}

async function hello($: EngineInterface): Promise<boolean> {
  const res = await api($, 'POST', '/api/mod/hello', { cliId: myId, isChief: true, options })
  if (!res.ok || res.json === null) return false
  localId = typeof res.json.sessionId === 'string' ? res.json.sessionId : null
  return true
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
// --open it also opens the console in the browser.
async function ensureServer($: EngineInterface, open: boolean): Promise<void> {
  if (!open && (await isHealthy($))) return
  const app = `${$.plugin.root}/server/app.py`
  const args = ['start', ...(open ? ['--open'] : [])]
  let lastError = 'Python was not found.'
  for (const python of [['python'], ['py', '-3']]) {
    try {
      const run = await $.process.run([...python, app, ...args], { timeoutMs: START_TIMEOUT_MS })
      const line = run.stdout.trim().split(/\r?\n/).at(-1) ?? ''
      const out = JSON.parse(line === '' ? '{}' : line) as { error?: unknown; port?: unknown }
      if (run.exitCode === 0 && typeof out.port === 'number') {
        log($, `server up on port ${out.port}`)
        server = null
        return
      }
      lastError = typeof out.error === 'string' ? out.error : `exit ${run.exitCode}`
    } catch (err) {
      lastError = String(err)
    }
  }
  log($, `server did not start: ${lastError}`)
  $.ui.toast(`The Chief of Staff server did not start: ${lastError}`)
  throw new Error(lastError)
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
      if (await hello($)) return true
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

async function handle($: EngineInterface, item: ChiefInboxItem): Promise<void> {
  if (item.type === 'prompt') {
    // Console and voice messages are Jay's own words. The engine does not show a
    // plugin's own $.prompt.submit to its prompt.submit hook, so note the answer here.
    if (!SERVER_PROMPT.test(item.text.trim())) noteAnswer(item.text.trim())
    // A turn of its own once the session is idle; never folded into a running turn.
    $.prompt.submit({ text: item.text }).catch(err => log($, `prompt: ${String(err)}`))
    // Acknowledged, so the server does not send it again.
    await post($, '/api/mod/result', { actionId: item.id, ok: true })
    return
  }
  if (item.type === 'archive') {
    const refusal = await archiveRefusal($, item.sessionId, item.confirmed === true).catch(() =>
      'The Chief of Staff could not check that session, so it was not archived.')
    if (refusal !== null) {
      await post($, '/api/mod/result', { actionId: item.id, ok: false, detail: refusal.split('. Ask Jay')[0] + '.' })
      return
    }
    if (item.confirmed === true) consoleApproved.set(item.sessionId, (await now($)) + CONSOLE_APPROVAL_MS)
    await act($, item.id, 'archive_session', { session_id: item.sessionId, reason: item.reason },
      `[Action from the console] Jay pressed Archive for ${sessionRef(item.sessionId, item.title)}. ` +
        'Look it up with cos_sessions, apply your archive rules, then archive it with the archive_session ' +
        'tool and tell Jay in one short sentence whether it worked.')
    return
  }
  if (item.type === 'reply') {
    await act($, item.id, 'send_message', { session_id: item.sessionId, message: item.text },
      `[Action from the console] Jay typed a reply for ${sessionRef(item.sessionId, item.title)} in the ` +
        'console reply box. Send the text between the two marker lines to that session with the send_message ' +
        'tool, word for word, then tell Jay in one short sentence that it went.\n' +
        `<<<reply\n${item.text}\n>>>`)
  }
}

// Runs a desktop-app session action. When the app refuses the mod's own call,
// the Chief is asked to do it with its own tools in a turn of its own.
async function act(
  $: EngineInterface,
  actionId: string,
  tool: string,
  args: Record<string, unknown>,
  fallback: string,
): Promise<void> {
  let ok = false
  let detail = ''
  try {
    const result = await $.mcp.call(SESSIONS_SERVER, tool, args)
    ok = !result.isError
    detail = textOf(result.content)
  } catch (err) {
    log($, `${tool} was refused (${String(err)}); handing it to the Chief`)
    $.prompt.submit({ text: fallback }).catch(e => log($, `fallback prompt: ${String(e)}`))
    await post($, '/api/mod/result', {
      actionId, ok: true, handedOff: true, detail: 'Handed to the Chief to do with its own tools.',
    })
    return
  }
  await post($, '/api/mod/result', { actionId, ok, detail: detail.slice(0, 500) })
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
  await post($, '/api/mod/busy', { busy: false })
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
      "Chief of Staff: Jay's open Claude desktop sessions and their state, from the local Chief of Staff " +
      'server. No input lists the sessions in view (live or active lately) with id, title, state ' +
      '(you = waiting on Jay, active = working now, wait = idle or waiting on something else, stale), ' +
      'stateReason, summary and needsAction. { "id": "local_..." } returns one session in more detail. ' +
      '{ "all": true } lists every open session. Call this first, before the session tools.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'One session id (local_...), for its details.' },
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
        kind: s.kind, repo: s.repo, branch: s.branch, prNumber: s.prNumber, prState: s.prState,
        childIds: s.childIds,
      })
    }
    const res = await api($, 'GET', '/api/sessions')
    if (!res.ok || res.json === null) throw new Error(`answered ${res.status}`)
    const list = (Array.isArray(res.json.sessions) ? res.json.sessions : []) as ChiefSession[]
    const others = list.filter(s => !s.isChief)
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
    title: s.title,
    state: s.state,
    stateReason: s.stateReason,
    summary: s.summary,
    needsAction: s.needsAction,
    parentId: s.parentId,
    live: s.live,
    lastActivityAt: s.lastActivityAt,
    lastActivity: s.lastActivityAt ? ago(at - s.lastActivityAt) : null,
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
