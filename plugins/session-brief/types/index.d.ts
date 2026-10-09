export type Brief = {
  /** Short session title that says what the work is. */
  title: string
  /** How the session started: the first commands or skills, and what they were for. */
  started: string
  /** Where the session stopped. */
  leftOff: string
  /** Next steps, most important first. Empty when nothing is pending. */
  next: string[]
  /** Facts, risks or open questions worth knowing before going on. */
  know: string[]
  /** Main-thread messages the brief was written from. */
  messages: number
  /** When it was written, in $.clock.now() milliseconds. */
  at: number
}

export type BriefStatus = 'idle' | 'writing' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'session-brief': {
      brief: Brief | null
      status: BriefStatus
      isCollapsed: boolean
      isHidden: boolean
    }
  }
}
