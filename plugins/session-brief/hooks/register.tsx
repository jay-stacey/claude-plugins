import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Brief, BriefStatus } from '../types'

const brief = atom({ plugin: 'session-brief', key: 'brief' } as const, null as Brief | null)
const status = atom({ plugin: 'session-brief', key: 'status' } as const, 'idle' as BriefStatus)
const isCollapsed = atom({ plugin: 'session-brief', key: 'isCollapsed' } as const, false)
const isHidden = atom({ plugin: 'session-brief', key: 'isHidden' } as const, false)

// The desktop app's own session tools. "self" is the session this mod runs in.
const SESSION_SERVER = 'ccd_session_mgmt'
const MAX_DIGEST_CHARS = 40000

export const BRIEF_RULES = `You write a short brief of a Claude Code working session, so the person can come back to it days later and know at once what it was about.

You get a digest of the session: how it opened, and the last part of the conversation. Return JSON only, no prose and no code fence, in this shape:
{"title": string, "started": string, "leftOff": string, "next": string[], "know": string[]}

Rules:
- title: at most 60 characters, sentence case, no trailing punctuation. Say the KIND of work and its subject, so it is clear without opening the session: "Triage DP1 queue: 7 routed, 3 held", "Plan duplicate-email check (DP1-687)", "Fix deal tax rounding (NEO-412)". Put a ticket key in brackets at the end only when one ticket is the subject. Never a bare ticket key. If a current title is given and still fits, return it unchanged.
- started: one sentence. Name the slash command or skill the session opened with (for example /dealerpull-engineering:triage-queue) and what it was asked to do. If it opened with a plain request, say what was asked.
- leftOff: one or two sentences. Where the work stopped: what is done, what is not, and whether the last turn waits on the person (a question, an approval, a choice).
- next: at most 3 items, most important first. Concrete actions with the exact command, ticket key or file. If the session was planning or triage, say so and keep "go implement" as one option, not the default. Empty array when nothing is pending.
- know: at most 3 items. Things the person must know before going on: decisions waiting on them, risks, blockers, open questions, things that were NOT done or NOT verified. Skip anything already in leftOff. Empty array when there is nothing.
- Each item under 140 characters. Plain words. No markdown, no emojis.
- Never include customer personal data: names, emails, phone numbers, addresses, VINs, payment details.`

// Drops stale runs: a newer turn starts a newer brief.
let runId = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'brief',
      description: 'Session brief: refresh, show, hide, rename, or autorename on|off',
      argumentHint: '[refresh|show|hide|rename|autorename on|off]',
    })
    // A reload cuts off a brief in progress: never start stuck on "updating".
    await update($, status, () => 'idle')
    const id = await $.session.id()
    const saved = await $.store.get(`brief:${id}`)
    if (isBrief(saved)) await update($, brief, () => saved)

    // A resumed session with no brief yet gets one; a new session waits for its first turn.
    if (!isBrief(saved) && (await $.session.surfaces()).length > 0) {
      $.clock.after(0, () => void refresh($, { isForced: false }))
    }

    return next(e)
  })

  on('command.run', { command: 'brief' }, async ($, e) => {
    const [word = 'refresh', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'hide') {
      await update($, isHidden, () => true)
      return { text: 'Session brief hidden. Type /brief show to bring it back.' }
    }
    if (word === 'show') {
      await update($, isHidden, () => false)
      return { text: 'Session brief shown.' }
    }
    if (word === 'autorename') {
      const want = value !== 'off'
      await $.store.set('autoRename', want)
      return { text: want ? 'Sessions will be renamed to match the work.' : 'Automatic renaming is off.' }
    }
    if (word === 'rename') {
      const current = await read($, brief)
      if (current === null) return { text: 'No brief yet. Type /brief to write one first.' }
      const isDone = await applyTitle($, current.title, { isForced: true })
      return { text: isDone ? `Renamed to "${current.title}".` : 'Could not rename this session.' }
    }
    await update($, isHidden, () => false)
    $.clock.after(0, () => void refresh($, { isForced: true }))

    return { text: 'Writing the session brief.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted) return result
    if ((await $.session.surfaces()).length === 0) return result
    // The brief outlasts the hook's time budget, so it runs on a timer of its own.
    $.clock.after(0, () => void refresh($, { isForced: false }))

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Other mods may draw in this band too: keep theirs, under the brief.
    const below = await next(e)
    // `view` may be absent on some surfaces: read it with care, or the hook throws and is skipped.
    if (e.props.hasSurvey || e.props.view?.agentId !== undefined) return below
    if (await read($, isHidden)) return below

    const current = await read($, brief)
    const now = await read($, status)
    if (current === null && now === 'idle') return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const collapsed = await read($, isCollapsed)
    const age = current === null ? '' : ago((await $.clock.now()) - current.at)
    const note = now === 'writing' ? 'updating…' : now === 'failed' ? 'update failed' : `updated ${age}`

    const header = (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text bold>Session brief</Text>
        <Text dimColor>{note}</Text>
        <Box flexGrow={1} />
        <Button
          key="collapse"
          label={collapsed ? 'Expand' : 'Collapse'}
          dimColor
          onPress={() => update($, isCollapsed, c => !c)}
        />
        <Button key="refresh" label="Refresh" dimColor onPress={() => void refresh($, { isForced: true })} />
        <Button key="hide" label="Hide" dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )

    const body =
      current === null ? null : collapsed ? (
        <Text dimColor wrap="truncate-end">
          Left off: {current.leftOff}
        </Text>
      ) : (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="column">
            <Text>
              <Text bold>Started: </Text>
              {current.started}
            </Text>
            <Text>
              <Text bold>Left off: </Text>
              {current.leftOff}
            </Text>
          </Box>
          {current.next.length > 0 && (
            <Box flexDirection="column">
              <Text bold>Next</Text>
              {current.next.map((step, i) => (
                <Text key={`next-${i}`}>
                  {'  '}
                  {i + 1}. {step}
                </Text>
              ))}
            </Box>
          )}
          {current.know.length > 0 && (
            <Box flexDirection="column">
              <Text bold>You should know</Text>
              {current.know.map((fact, i) => (
                <Text key={`know-${i}`} color="warning">
                  {'  - '}
                  {fact}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column" rowGap={1} borderStyle="round" borderDimColor paddingX={1}>
          {header}
          {body}
        </Box>
        {below}
      </Box>
    )
  }).catch(($, e, next) => {
    // A band that fails is skipped with no sign on the desktop: say why, once per load.
    if (!hasWarnedRender && next.error !== undefined && next.error.kind !== 're-entry') {
      hasWarnedRender = true
      try {
        $.ui.toast(`session-brief: the band failed to draw (${next.error.kind}). Type /brief to retry.`)
      } catch {
        // Nothing to show it on.
      }
    }
    return next(e)
  })
}

let hasWarnedRender = false

async function refresh($: EngineInterface, { isForced }: { isForced: boolean }): Promise<void> {
  runId += 1
  const id = runId
  const messages = await $.session.messages()
  if (!Array.isArray(messages) || messages.length < 2) return
  const previous = await read($, brief)
  if (!isForced && previous !== null && previous.messages === messages.length) return

  await update($, status, () => 'writing')
  const written = await writeBrief($, messages, previous)
  if (id !== runId) return
  if (written === undefined) {
    await update($, status, () => 'failed')
    return
  }
  await update($, brief, () => written)
  await update($, status, () => 'idle')
  await $.store.set(`brief:${await $.session.id()}`, written)

  if ((await $.store.get('autoRename')) !== false) {
    await applyTitle($, written.title, { isForced: false })
  }
}

export async function writeBrief(
  $: EngineInterface,
  messages: readonly SessionMessage[],
  previous: Brief | null,
): Promise<Brief | undefined> {
  const currentTitle = (await $.store.get(`title:${await $.session.id()}`)) as string | undefined
  const prompt = [
    currentTitle === undefined ? 'No current title.' : `Current title: ${currentTitle}`,
    '',
    digest(messages),
  ].join('\n')
  const reply = await $.model.complete({
    model: 'haiku',
    system: [{ text: BRIEF_RULES, cache: true }],
    prompt,
    maxTokens: 800,
    effort: 'low',
    timeoutMs: 30000,
  })
  if (!reply.isAnswered) {
    $.ui.log(`session-brief: no brief (${reply.reason})`, { to: 'debug' })
    return undefined
  }
  const parsed = parseBrief(reply.text)
  if (parsed === undefined) {
    $.ui.log('session-brief: the model did not return a brief in JSON', { to: 'debug' })
    return previous ?? undefined
  }

  return { ...parsed, messages: messages.length, at: await $.clock.now() }
}

// The opening (where the commands and skills are) plus the latest stretch of the conversation.
export function digest(messages: readonly SessionMessage[]): string {
  const opening = messages.slice(0, 4)
  const tailStart = Math.max(opening.length, messages.length - 16)
  const tail = messages.slice(tailStart)
  const parts = ['## How the session opened', ...opening.map(m => line(m, 2000))]
  if (tailStart > opening.length) {
    parts.push(`\n(${tailStart - opening.length} messages left out)\n`)
  }
  parts.push('## The latest part of the session', ...tail.map(m => line(m, 3000)))
  const text = parts.filter(part => part !== '').join('\n')

  return text.length > MAX_DIGEST_CHARS ? text.slice(-MAX_DIGEST_CHARS) : text
}

function line(m: SessionMessage, max: number): string {
  const who = m.role === 'user' ? 'USER' : 'ASSISTANT'
  const text = m.text.trim()
  const body = text.length > max ? `${text.slice(0, max)}…` : text
  const tools = m.toolUses.map(useLabel).filter(t => t !== '')
  const used = tools.length > 0 ? `\n  [tools: ${unique(tools).join(', ')}]` : ''
  if (body === '' && used === '') return ''

  return `${who}: ${body}${used}`
}

function useLabel(use: SessionMessage['toolUses'][number]): string {
  const input = use.input
  if (use.tool === 'Skill' && typeof input.skill === 'string') return `skill ${input.skill}`
  if (use.tool === 'Agent' && typeof input.subagent_type === 'string') return `agent ${input.subagent_type}`

  return use.tool.startsWith('mcp__') ? `mcp:${use.tool.split('__').slice(2).join('__')}` : use.tool
}

function unique(list: string[]): string[] {
  return [...new Set(list)]
}

export function parseBrief(text: string): Omit<Brief, 'messages' | 'at'> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const title = clean(raw.title, 60)
    const started = clean(raw.started, 400)
    const leftOff = clean(raw.leftOff, 500)
    if (title === '' || leftOff === '') return undefined

    return {
      title,
      started,
      leftOff,
      next: list(raw.next, 3),
      know: list(raw.know, 3),
    }
  } catch {
    return undefined
  }
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function list(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []

  return value
    .map(item => clean(item, 200))
    .filter(item => item !== '')
    .slice(0, max)
}

// Renames through the desktop app's own session tool. A title the person typed themselves
// makes the app ask them first, so an automatic rename only runs when the title changed.
async function applyTitle(
  $: EngineInterface,
  title: string,
  { isForced }: { isForced: boolean },
): Promise<boolean> {
  const id = await $.session.id()
  const applied = await $.store.get(`title:${id}`)
  if (!isForced && applied === title) return true
  try {
    const result = await $.mcp.call(SESSION_SERVER, 'set_session_title', {
      session_id: 'self',
      title,
    })
    if (result.isError) {
      $.ui.log(`session-brief: rename refused: ${textOf(result.content)}`, { to: 'debug' })
      return false
    }
    await $.store.set(`title:${id}`, title)
    return true
  } catch (err) {
    $.ui.log(`session-brief: rename failed: ${String(err)}`, { to: 'debug' })
    return false
  }
}

function textOf(content: readonly { type: string }[]): string {
  return content
    .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join(' ')
    .slice(0, 300)
}

function isBrief(value: unknown): value is Brief {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>

  return typeof v.title === 'string' && typeof v.leftOff === 'string' && Array.isArray(v.next)
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`

  return `${Math.round(hours / 24)} days ago`
}
