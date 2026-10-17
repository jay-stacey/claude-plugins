// The Chief of Staff mod's contract: the shapes it trades with the app server
// (docs/contracts.md sections 4 and 5). The mod keeps no $.state values.

export type ChiefInboxItem =
  | { id: string; type: 'prompt'; text: string; hint?: string; jev?: JevDecision }
  | { id: string; type: 'archive'; sessionId: string; title: string; reason: string; confirmed?: boolean }
  | { id: string; type: 'reply'; sessionId: string; title: string; text: string }

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

export type ChiefSession = {
  id: string
  cliId: string | null
  title: string
  kind: 'interactive' | 'background'
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
