import type { EngineInterface, Register } from 'claude-code'

import { PROJECTS } from './projects'
import type { Project } from './projects'

// Auto-file: after a turn ends, put THIS session into the sidebar section for
// its project (config/projects.json). It only moves itself ("self"), which the
// app allows without a prompt. It never moves a session the user already filed
// or pinned, and never touches other sessions. /organize does the bulk sort.

const SESSION_SERVER = 'ccd_session_mgmt'
const SIDEBAR_SERVER = 'ccd_sidebar'
// Titles start generic and get better after a few turns (session-brief renames
// them), so keep trying for a few turns before giving up.
const MAX_ATTEMPTS = 6
const DEFAULT_TITLE = /^(new session|untitled|session)$/i

type Section = { id: string; kind: string; name: string }
type SessionInfo = { title?: string; cwd?: string; branch?: string; worktreeBranch?: string; group?: { id: string } | null; pinned?: boolean }

// Module state. A reload starts over, which only costs one more check.
let isDone = false
let attempts = 0
let isRunning = false

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted || isDone || isRunning) return result
    if ((await $.session.surfaces()).length === 0) return result
    isRunning = true
    // Runs after the turn; never holds the turn up or fails it.
    $.clock.after(0, () => void autoFile($).finally(() => (isRunning = false)))
    return result
  })

  on('command.run', { command: 'organize-self' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    if (word === 'off' || word === 'on') {
      await $.store.set('autofile:off', word === 'off')
      return { text: word === 'off' ? 'Auto-file is off for all sessions. Type /organize-self on to turn it back on.' : 'Auto-file is on.' }
    }
    isDone = false
    attempts = 0
    const text = await autoFile($, true)
    return { text }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'organize-self',
      description: 'File this session into its project section now, or turn auto-file on|off',
      argumentHint: '[on|off]',
    })
    return next(e)
  })
}

export async function autoFile($: EngineInterface, isForced = false): Promise<string> {
  try {
    if ((await $.store.get('autofile:off')) === true && !isForced) {
      isDone = true
      return 'Auto-file is off.'
    }
    attempts += 1
    if (attempts > MAX_ATTEMPTS && !isForced) {
      isDone = true
      return 'Gave up: no project matched.'
    }

    const self = await callJson<SessionInfo>($, SESSION_SERVER, 'get_session', { session_id: 'self' })
    if (self === undefined) return 'Could not read this session.'
    // The key is missing while the app has not reported groups: unknown, so wait.
    if (!('group' in self)) return 'Sidebar groups not known yet.'
    if (self.group !== null && self.group !== undefined) {
      isDone = true
      return 'Already in a section. Left as is.'
    }
    if (self.pinned === true) {
      isDone = true
      return 'Pinned. Left as is, because a move would unpin it.'
    }
    const title = (self.title ?? '').trim()
    if (title === '' || DEFAULT_TITLE.test(title)) return 'No title yet.'

    const project = matchProject(PROJECTS,[title, self.worktreeBranch ?? self.branch ?? '', self.cwd ?? ''])
    if (project === undefined) return `No project matched "${title}".`

    const sections = await callJson<Section[]>($, SIDEBAR_SERVER, 'list_sections', {})
    if (!Array.isArray(sections)) return 'Could not read the sidebar sections.'
    let sectionId = findSection(sections, project)?.id
    if (sectionId === undefined) {
      const created = await $.mcp.call(SIDEBAR_SERVER, 'create_section', { name: project.section })
      if (created.isError === true) return `Could not create section ${project.section}.`
      const after = await callJson<Section[]>($, SIDEBAR_SERVER, 'list_sections', {})
      sectionId = Array.isArray(after) ? findSection(after, project)?.id : undefined
      if (sectionId === undefined) return `Could not find section ${project.section} after creating it.`
    }

    const moved = await $.mcp.call(SIDEBAR_SERVER, 'move_sessions', {
      session_ids: ['self'],
      section_id: sectionId,
    })
    if (moved.isError === true) return `Could not move this session to ${project.section}.`
    isDone = true
    $.ui.toast(`Filed under ${project.section}`)
    return `Filed under ${project.section}.`
  } catch {
    // App tools missing (terminal, older app): stop quietly.
    isDone = true
    return 'Sidebar tools are not available here.'
  }
}

export function matchProject(projects: readonly Project[], fields: readonly string[]): Project | undefined {
  const haystack = fields.join(' \n ')
  return projects.find(p =>
    p.patterns.some(source => {
      try {
        return new RegExp(source, 'i').test(haystack)
      } catch {
        return false
      }
    }),
  )
}

export function findSection(sections: readonly Section[], project: Project): Section | undefined {
  const names = [project.section, ...project.aliases].map(n => n.toLowerCase())
  return sections.find(s => s.kind === 'manual' && names.includes(s.name.toLowerCase()))
}

async function callJson<T>($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<T | undefined> {
  const result = await $.mcp.call(server, tool, args)
  if (result.isError === true) return undefined
  const text = (result.content as readonly { type: string; text?: string }[])
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}
