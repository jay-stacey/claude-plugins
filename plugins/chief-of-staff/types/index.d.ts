// The Chief of Staff mod's contract: the shapes it trades with the app server
// (docs/contracts.md sections 4 and 5). The mod keeps no $.state values.

export type ChiefInboxItem =
  | { id: string; type: 'prompt'; text: string; from?: 'console' | 'voice' | 'notice'; hint?: string; jev?: JevDecision }
  | { id: string; type: 'archive'; sessionId: string; title: string; kind?: ChiefSessionKind; reason: string; confirmed?: boolean }
  | { id: string; type: 'stop'; sessionId: string; title: string; kind?: ChiefSessionKind; reason?: string; confirmed?: boolean }
  | { id: string; type: 'reply'; sessionId: string; title: string; kind?: ChiefSessionKind; text: string }

// Jev's advice for one request (server/cos/jev/decision.py).
export type JevDecision = {
  model: 'haiku' | 'sonnet' | 'opus'
  route: 'chief' | 'new_session'
  background: boolean
  estimate_s: number
  filler: 'lookup' | 'work' | 'chat'
  source: 'rules' | 'user' | 'local' | 'hosted'
  ms: number
  override: boolean
}

export type ChiefConfirm = { question: string; yes: string; no: string }

export type ChiefSessionState = 'you' | 'active' | 'wait' | 'stale'

// desktop: a Claude app session (local_ id). cli: an interactive terminal session (cli_).
// bg: a background session (bg_), stopped with `claude stop <bgId>`.
export type ChiefSessionKind = 'desktop' | 'cli' | 'bg'

// yes: the Chief can do it now. app: only by opening the session in the Claude app.
// no: not possible; the matching actionNotes entry says why.
export type Avail = 'yes' | 'app' | 'no'

export type ActionVerb = 'reply' | 'archive' | 'stop' | 'open' | 'start'

export type ChiefSessionActions = { reply: Avail; archive: Avail; stop: Avail; open: Avail }

export type ChiefActionNotes = Partial<Record<keyof ChiefSessionActions, string>>

// expired is the server's alone: a hand-off or an action with no result in time.
export type ActionOutcomeKind =
  | 'done' | 'refused' | 'failed' | 'needsConfirm' | 'opened' | 'handedOff' | 'unsupported' | 'expired'

export type ChiefCaps = {
  desktopSessions: boolean
  desktopListed: boolean
  desktopStart: boolean
  sendMessage: boolean
  listAgents: boolean
  cliStop: boolean
  cliStart: boolean
}

export type ChiefHost = { surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' | null; caps: ChiefCaps }

export type ChiefSession = {
  id: string
  cliId: string | null
  title: string
  // Older servers sent interactive or background; the id prefix decides then.
  kind: ChiefSessionKind | 'interactive' | 'background'
  bgId?: string
  actions?: ChiefSessionActions
  actionNotes?: ChiefActionNotes
  state: ChiefSessionState
  stateReason: string
  live: boolean
  liveStatus: 'busy' | 'idle' | 'waiting' | null
  parentId: string | null
  childIds: string[]
  repo: string | null
  branch: string | null
  prNumber: number | null
  prState: string | null
  lastActivityAt: number | null
  summary: string | null
  needsAction: string | null
  isChief: boolean
  inView?: boolean
}

export type ChiefServerInfo = { port: number; token: string }
