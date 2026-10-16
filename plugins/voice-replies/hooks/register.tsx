import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VoiceEngine, VoiceLength, VoiceStatus } from '../types'

const isOn = atom({ plugin: 'voice-replies', key: 'isOn' } as const, true)
const status = atom({ plugin: 'voice-replies', key: 'status' } as const, 'idle' as VoiceStatus)
const voice = atom({ plugin: 'voice-replies', key: 'voice' } as const, 'af_heart')
const speed = atom({ plugin: 'voice-replies', key: 'speed' } as const, '1.0')
const length = atom({ plugin: 'voice-replies', key: 'length' } as const, 'short' as VoiceLength)
const engine = atom({ plugin: 'voice-replies', key: 'engine' } as const, 'starting' as VoiceEngine)
// The step `/voice install` is on, or '' when no install runs.
const installing = atom({ plugin: 'voice-replies', key: 'install' } as const, '')
const waiting = atom({ plugin: 'voice-replies', key: 'waiting' } as const, [] as string[])
// Said before the session's speech when the voice moves to it; '' (the default) says nothing.
const label = atom({ plugin: 'voice-replies', key: 'label' } as const, '')
// What the voice calls the person at the start of each reply; '' says no name.
const callMe = atom({ plugin: 'voice-replies', key: 'callMe' } as const, '')
// Also saved in this session's store record, so Replay works after a reload or a restart.
const last = atom({ plugin: 'voice-replies', key: 'last' } as const, '')

const SERVER = 'http://127.0.0.1:47861'
// The server API this module needs. An older server is restarted from the plugin's copy.
// 3: each line of a script is spoken on its own, with a pause between lines.
const API = 3
// Replies kept for Play while another session speaks; older ones drop off.
const MAX_WAITING = 3
// Per-session settings kept in the store; the oldest drop off past this.
const MAX_SAVED_SESSIONS = 200
// How long to follow one job, queue time included: 3600 polls of 500 ms.
const MAX_POLLS = 3600

// Kokoro-82M English voices. First letter: a = American, b = British. Second: f/m.
const VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole',
  'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx',
  'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
] as const
const SPEEDS = ['0.8', '0.9', '1.0', '1.1', '1.2', '1.3', '1.5'] as const
const LENGTHS = ['short', 'full'] as const

// How a person talks, shared by both lengths. The voice reads exactly what it gets, so the
// script must already be written the way it is said.
const SPOKEN_STYLE = `How it must sound:
- Talk like a colleague giving a quick update out loud: warm, direct and plain. Use contractions (it's, I've, you'll, didn't).
- Use short sentences and vary their length. Put commas where a speaker takes a breath.
- Start a new line between separate topics, so the voice pauses there.
- Do not open with filler such as "Sure", "Okay so" or "Great news". Do not use the person's name; the voice adds it.
- Write times, dates and numbers the way people say them: "8:00 AM" is "eight in the morning", "8:30" is "eight thirty", "17:00" is "five in the afternoon", "2026-10-16" is "October sixteenth", "95%" is "ninety-five percent", "v1.5.0" is "version one point five", "3-5 min" is "three to five minutes".
- Say symbols and abbreviations as words: "&" is "and", "e.g." is "for example", "i.e." is "that is", "~" is "about", "->" is "to", "vs" is "versus".
- Never read code, commands, file paths, IDs or hashes character by character. Say what they are ("the config file", "a git command") instead.`

const SHORT_RULES = `You turn a coding assistant's chat reply into a short script that a text-to-speech voice reads aloud to the person who asked.

Rules:
- Output plain spoken sentences only. No markdown, bullets, headings, tables, code, emojis or URLs.
- Lead with the outcome: what was done, whether it worked, what the person needs to do next.
- Keep it under 80 words. A short, plain reply can stay almost word for word.
- If the reply asks the person a question, end with that question.
- Output only the script, nothing before or after it.

${SPOKEN_STYLE}`

const FULL_RULES = `You turn a coding assistant's chat reply into a script that a text-to-speech voice reads aloud, in full, to the person who asked.

Rules:
- Output plain spoken sentences only. No markdown, bullets, headings, tables, code, emojis or URLs.
- Keep every point of the reply, in the same order. Do not summarize and do not leave points out.
- Turn lists and tables into sentences, one item or row at a time.
- If the reply asks the person a question, end with that question.
- Output only the script, nothing before or after it.

${SPOKEN_STYLE}`

// Per length: the rules, the longest script spoken, and the Haiku call's limits.
const LIMITS = {
  short: { rules: SHORT_RULES, chars: 1500, maxTokens: 400, timeoutMs: 15000 },
  full: { rules: FULL_RULES, chars: 12000, maxTokens: 4000, timeoutMs: 60000 },
} as const

type Settings = {
  isOn: boolean
  voice: string
  speed: string
  length: VoiceLength
  callMe: string
  label?: string
  last?: string
}

// The longest name the voice says, for the session or for the person.
const MAX_NAME = 40
// The panel's width, in cells, with every control on one line: the title and its state,
// four labelled controls and the gaps between them. Narrower bands get two rows.
const ONE_LINE_COLUMNS = 150
// Room for the Call me label, a short name and its save button.
const CALL_ME_COLUMNS = 30

// A speech run in flight. `runId` drops stale work; `speakerPid` lets Stop kill the Windows voice.
let runId = 0
let speakerPid: number | undefined
let hasWarnedSetup = false
let hasTriedUpgrade = false
// `session:<id>`: this session's settings key in the store, and its name on the voice server.
let sessionKey = ''

function voiceLabel(name: string): string {
  const accent = name.startsWith('b') ? 'UK' : 'US'
  const gender = name[1] === 'm' ? 'male' : 'female'
  const first = name.slice(3)
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} (${accent} ${gender})`
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionKey = `session:${await $.session.id()}`
    const settings = await loadSettings($)
    await update($, isOn, () => settings.isOn)
    await update($, voice, () => settings.voice)
    await update($, speed, () => settings.speed)
    await update($, length, () => settings.length)
    await update($, callMe, () => settings.callMe)
    await update($, label, () => settings.label ?? '')
    await update($, last, () => settings.last ?? '')
    await update($, status, () => 'idle')
    await $.command.register({
      name: 'voice',
      description:
        'Voice replies for this session: on, off, stop [all], play, clear, replay, voice <name>, ' +
        'speed <0.8-1.5>, length short|full, call <your name>, name <words>, default, voices, test, install [gpu|cpu]',
      argumentHint:
        '[on|off|stop [all]|play|clear|replay|voice <name>|speed <n>|length short|full|call <your name>|name <words>|default|voices|test|install [gpu|cpu]]',
    })
    $.clock.after(0, () => void forgetOldSessions($))
    // Warm the server up only where someone is watching; elsewhere it starts on first use.
    if ((await $.session.surfaces()).length > 0) $.clock.after(0, () => void ensureServer($))

    return next(e)
  })

  on('command.run', { command: 'voice' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    const word = first.toLowerCase()
    const value = rest.join(' ').toLowerCase()
    if (word === 'stop') {
      const isAll = value === 'all'
      await stopSpeaking($, isAll ? 'all' : 'session')
      return { text: isAll ? 'Stopped speaking in every session.' : 'Stopped speaking.' }
    }
    if (word === 'play') {
      if ((await read($, waiting)).length === 0) return { text: 'No reply is waiting.' }
      $.clock.after(0, () => void playWaiting($))
      return { text: 'Playing the waiting reply.' }
    }
    if (word === 'clear') {
      await update($, waiting, () => [])
      return { text: 'Cleared the waiting replies.' }
    }
    if (word === 'replay') {
      if ((await read($, last)) === '') return { text: 'Nothing to replay yet.' }
      $.clock.after(0, () => void replayLast($))
      return { text: 'Replaying the last reply.' }
    }
    if (word === 'voices') {
      return { text: `Voices: ${VOICES.map(v => `${v} = ${voiceLabel(v)}`).join(', ')}` }
    }
    if (word === 'voice') {
      if (!isOneOf(VOICES, value)) {
        return { text: `Unknown voice "${value}". Type /voice voices to list them.` }
      }
      await setVoice($, value)
      return { text: `Voice set to ${voiceLabel(value)} for this session.` }
    }
    if (word === 'speed') {
      if (!isOneOf(SPEEDS, value)) {
        return { text: `Speed must be one of ${SPEEDS.join(', ')}.` }
      }
      await setSpeed($, value)
      return { text: `Speed set to ${value} for this session.` }
    }
    if (word === 'length') {
      if (!isOneOf(LENGTHS, value)) return { text: 'Use /voice length short or /voice length full.' }
      await setLength($, value)
      return {
        text: value === 'full'
          ? 'Replies are read in full in this session.'
          : 'Replies are read as a short summary in this session.',
      }
    }
    if (word === 'call') {
      // Keep the person's own capitals; '' stops saying a name.
      const name = cleanName(rest.join(' '))
      await setCallMe($, name)
      return {
        text: name === ''
          ? 'Replies in this session no longer start with your name.'
          : `Replies in this session start with "${name}".`,
      }
    }
    if (word === 'name') {
      // Keep the person's own capitals; '' stops saying the session's name.
      const name = rest.join(' ').trim().slice(0, MAX_NAME)
      await update($, label, () => name)
      await saveSettings($, { label: name === '' ? undefined : name })
      return {
        text: name === ''
          ? "The voice no longer says this session's name when it moves to it."
          : `The voice says "${name}" when it moves to this session.`,
      }
    }
    if (word === 'default') {
      await $.store.set('isOn', await read($, isOn))
      await $.store.set('voice', await read($, voice))
      await $.store.set('speed', await read($, speed))
      await $.store.set('length', await read($, length))
      await $.store.set('callMe', await read($, callMe))
      return { text: "New sessions now start with this session's voice, speed, length and name for you." }
    }
    if (word === 'install') {
      const mode = value === '' ? 'auto' : value
      if (mode !== 'auto' && mode !== 'gpu' && mode !== 'cpu') {
        return { text: 'Use /voice install, /voice install gpu or /voice install cpu.' }
      }
      if ((await read($, installing)) !== '') return { text: 'Kokoro is already installing.' }
      if ((await $.env.get('OS')) !== 'Windows_NT') {
        return { text: 'The Kokoro installer runs on Windows only. Replies use the system voice here.' }
      }
      await update($, installing, () => 'starting')
      // The install takes minutes, far past a hook's budget, so it runs on a timer of its own.
      $.clock.after(0, () => void installKokoro($, mode))
      return {
        text:
          'Installing Kokoro. It checks your GPU first and uses the CPU if the GPU cannot run it. ' +
          'This takes 5 to 15 minutes; the Windows voice speaks until it is done.',
      }
    }
    if (word === 'test') {
      $.clock.after(0, () => void speakScript($, 'This is how voice replies will sound.'))
      return { text: 'Playing a test phrase.' }
    }
    const want = word === 'on' ? true : word === 'off' ? false : !(await read($, isOn))
    await setOn($, want)

    return { text: want ? 'Voice replies are on in this session.' : 'Voice replies are off in this session.' }
  })

  // A new prompt means the person moved on: stop this session's voice and drop what waits.
  // Other sessions keep speaking.
  on('prompt.submit', ($, e, next) => {
    // Never let the voice block a prompt: errors here are logged, not thrown.
    const quiet = (err: unknown) => $.ui.log(`voice-replies: ${String(err)}`, { to: 'debug' })
    stopSpeaking($).catch(quiet)
    update($, waiting, () => []).catch(quiet)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer' && !e.isAborted
    if (!isMainAnswer || e.answer.trim() === '' || !(await read($, isOn))) return result
    // Stay silent where nobody is watching: `claude -p` runs, scheduled tasks, agents
    // driven over the SDK with no app attached.
    if ((await $.session.surfaces()).length === 0) return result

    // Speaking outlasts the hook's 10 s budget, so it runs on a timer of its own.
    const answer = e.answer
    $.clock.after(0, () => void speakReply($, answer))

    return result
  })

  // The voice controls are a small panel of their own at the foot of the band above the
  // prompt, under anything other mods draw there (session-brief). The desktop app does not
  // draw a mod's tree in the prompt footer, so the band is the one place that works on both.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const above = await next(e)
    if (e.props.hasSurvey) return above
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Select = 'Select' in ui ? ui.Select : undefined
    const Input = 'Input' in ui ? ui.Input : undefined
    if (Select === undefined || Input === undefined) return above

    const enabled = await read($, isOn)
    const now = await read($, status)
    const chosen = await read($, voice)
    const pace = await read($, speed)
    const size = await read($, length)
    const via = await read($, engine)
    const step = await read($, installing)
    const held = await read($, waiting)
    const you = await read($, callMe)
    // Replay is for a reply that already played, maybe while the person was away. A waiting
    // reply has Play instead, and Stop takes the place while the voice is busy.
    const canReplay = enabled && now === 'idle' && held.length === 0 && (await read($, last)) !== ''
    // Say the engine only when it is not the normal one (Kokoro).
    const note =
      now === 'writing' ? 'preparing'
      : now === 'queued' ? 'in line'
      : now === 'speaking' ? 'speaking'
      : step !== '' ? `installing Kokoro: ${step}`
      : via === 'windows' ? 'Windows voice'
      : via === 'starting' ? 'starting'
      : ''

    // Wide enough for everything on one line: one row. Narrower: the title, state and
    // buttons on top, the settings below. Every item keeps its own width (flexShrink 0) and
    // moves to the next line when it does not fit, so labels never draw over each other.
    const isOneLine = e.props.bodyColumns >= ONE_LINE_COLUMNS

    return (
      <Box flexDirection="column" rowGap={1}>
        {above}
        <Box
          flexDirection={isOneLine ? 'row' : 'column'}
          alignItems={isOneLine ? 'center' : 'stretch'}
          justifyContent="space-between"
          columnGap={3}
          rowGap={1}
          borderStyle="round"
          borderDimColor
          paddingX={1}
        >
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2} rowGap={1} flexShrink={0}>
            <Box flexShrink={0}>
              <Text dimColor wrap="truncate">Voice replies</Text>
            </Box>
            {note !== '' && (
              <Box flexShrink={0}>
                <Text key="note" dimColor wrap="truncate">{note}</Text>
              </Box>
            )}
            {held.length > 0 && (
              <Box flexShrink={0}>
                <Text key="waiting" wrap="truncate">
                  {held.length === 1 ? '1 reply waiting' : `${held.length} replies waiting`}
                </Text>
              </Box>
            )}
            {held.length > 0 && (
              <Button key="play" label="Play" onPress={() => void $.clock.after(0, () => void playWaiting($))} />
            )}
            {held.length > 0 && (
              <Button key="dismiss" label="Dismiss" dimColor onPress={() => update($, waiting, () => [])} />
            )}
            {canReplay && (
              <Button key="replay" label="Replay" onPress={() => void $.clock.after(0, () => void replayLast($))} />
            )}
            {now !== 'idle' && <Button key="stop" label="Stop" dimColor onPress={() => stopSpeaking($)} />}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3} rowGap={1}>
            <Box flexShrink={0}>
              <Select
                key="voice"
                label="Voice"
                value={enabled ? chosen : OFF}
                options={[
                  { value: OFF, label: 'Off' },
                  ...VOICES.map(v => ({ value: v, label: voiceLabel(v) })),
                ]}
                onSelect={(value: string) => void pickVoice($, value)}
              />
            </Box>
            {enabled && (
              <Box flexShrink={0}>
                <Select
                  key="speed"
                  label="Speed"
                  value={pace}
                  options={SPEEDS.map(s => ({ value: s, label: `${s}x` }))}
                  onSelect={(value: string) => void setSpeed($, value)}
                />
              </Box>
            )}
            {enabled && (
              <Box flexShrink={0}>
                <Select
                  key="length"
                  label="Length"
                  value={size}
                  options={[
                    { value: 'short', label: 'Short' },
                    { value: 'full', label: 'Full' },
                  ]}
                  onSelect={(value: string) => void (isOneOf(LENGTHS, value) && setLength($, value))}
                />
              </Box>
            )}
            {enabled && (
              <Box flexShrink={0} minWidth={CALL_ME_COLUMNS}>
                <Input
                  key="call"
                  label="Call me"
                  placeholder="your name"
                  value={you}
                  submitLabel="save"
                  onSubmit={(value: string) => void setCallMe($, cleanName(value))}
                />
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    )
  })
}

// Settings: the store's top-level keys are the defaults for new sessions (and what 1.2 saved);
// `session:<id>` holds what this session changed.
async function loadSettings($: EngineInterface): Promise<Settings> {
  const [savedOn, savedVoice, savedSpeed, savedLength, savedCallMe, own] = await Promise.all([
    $.store.get('isOn'),
    $.store.get('voice'),
    $.store.get('speed'),
    $.store.get('length'),
    $.store.get('callMe'),
    $.store.get(sessionKey),
  ])
  const mine = asRecord(own)
  const pick = <T,>(ok: (v: unknown) => v is T, fallback: T, ...values: unknown[]): T =>
    (values.find(ok) as T | undefined) ?? fallback
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

  return {
    isOn: pick(isBool, true, mine.isOn, savedOn),
    voice: pick((v): v is string => isOneOf(VOICES, v), 'af_heart', mine.voice, savedVoice),
    speed: pick((v): v is string => isOneOf(SPEEDS, v), '1.0', mine.speed, savedSpeed),
    length: pick((v): v is VoiceLength => isOneOf(LENGTHS, v), 'short', mine.length, savedLength),
    // '' saved for this session means "no name here", over the default.
    callMe: pick((v): v is string => typeof v === 'string', '', mine.callMe, savedCallMe).slice(0, MAX_NAME),
    label: typeof mine.label === 'string' && mine.label !== '' ? mine.label : undefined,
    last: typeof mine.last === 'string' ? mine.last : undefined,
  }
}

async function saveSettings($: EngineInterface, patch: Partial<Settings>): Promise<void> {
  if (sessionKey === '') return
  const own = asRecord(await $.store.get(sessionKey))
  await $.store.set(sessionKey, { ...own, ...patch, at: await now($) })
}

// Keeps the store small: drops the settings of the sessions used longest ago.
async function forgetOldSessions($: EngineInterface): Promise<void> {
  const keys = (await $.store.keys()).filter(k => k.startsWith('session:'))
  if (keys.length <= MAX_SAVED_SESSIONS) return
  const dated = await Promise.all(
    keys.map(async k => ({ k, at: Number(asRecord(await $.store.get(k)).at ?? 0) })),
  )
  dated.sort((a, b) => a.at - b.at)
  for (const { k } of dated.slice(0, dated.length - MAX_SAVED_SESSIONS)) {
    if (k !== sessionKey) await $.store.delete(k)
  }
}

async function now($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

// The repository's folder name (the main one, for a worktree), else the session's folder.
async function defaultLabel($: EngineInterface): Promise<string> {
  const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  try {
    const repo = await $.session.repo()
    if (repo !== null) return baseName(repo.root)
  } catch {
    // Not a git repository, or git is missing: use the folder.
  }
  try {
    return baseName(await $.session.root())
  } catch {
    return ''
  }
}

async function setOn($: EngineInterface, value: boolean): Promise<void> {
  await update($, isOn, () => value)
  await saveSettings($, { isOn: value })
  if (!value) {
    await stopSpeaking($)
    await update($, waiting, () => [])
  }
}

// The voice dropdown's first option turns voice replies off; any voice turns them on.
const OFF = 'off'

async function pickVoice($: EngineInterface, value: string): Promise<void> {
  if (value === OFF) {
    await setOn($, false)
    return
  }
  await setVoice($, value)
  if (!(await read($, isOn))) await setOn($, true)
}

async function setVoice($: EngineInterface, value: string): Promise<void> {
  await update($, voice, () => value)
  await saveSettings($, { voice: value })
}

async function setSpeed($: EngineInterface, value: string): Promise<void> {
  await update($, speed, () => value)
  await saveSettings($, { speed: value })
}

async function setLength($: EngineInterface, value: VoiceLength): Promise<void> {
  await update($, length, () => value)
  await saveSettings($, { length: value })
}

async function setCallMe($: EngineInterface, value: string): Promise<void> {
  await update($, callMe, () => value)
  await saveSettings($, { callMe: value })
}

async function setStatus($: EngineInterface, value: VoiceStatus): Promise<void> {
  if ((await read($, status)) !== value) await update($, status, () => value)
}

// The server's API version: 0 when it is not running, 1 for a server from before 1.3.0.
async function serverApi($: EngineInterface): Promise<number> {
  try {
    const res = await $.http.fetch(`${SERVER}/health`)
    if (!res.ok) return 0
    const { api } = JSON.parse(res.text) as { api?: unknown }
    return typeof api === 'number' ? api : 1
  } catch {
    return 0
  }
}

// PowerShell single-quoted string.
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

// Starts the shared Kokoro server if it is not running, from the plugin's own server.py, so a
// plugin update reaches the server. A server older than API is stopped and started again, once.
// It runs hidden, outlives this session, and exits by itself after two idle hours.
async function ensureServer($: EngineInterface): Promise<boolean> {
  const api = await serverApi($)
  if (api >= API) {
    await update($, engine, () => 'kokoro')
    return true
  }
  // An old server still speaks; it only lacks the queue. Use it rather than restart again.
  if (api > 0 && hasTriedUpgrade) return true
  // The installer stops the server and rewrites its files: do not start it under it.
  if ((await read($, installing)) !== '') {
    await update($, engine, () => 'windows')
    return false
  }
  const home = await $.env.get('USERPROFILE')
  if (home === undefined) {
    await update($, engine, () => 'windows')
    return false
  }
  const dir = `${home}\\.claude\\voice-replies`
  const isSetUp = await $.fs.stat(`${dir}\\venv\\Scripts\\pythonw.exe`).then(
    () => true,
    () => false,
  )
  if (!isSetUp) {
    await update($, engine, () => 'windows')
    if (!hasWarnedSetup) {
      hasWarnedSetup = true
      $.ui.toast('Kokoro is not set up, so replies use the Windows voice. Type /voice install to set it up.')
    }
    return false
  }
  await update($, engine, () => 'starting')
  const commands = [`$d = ${psQuote(dir)}`]
  if (api > 0) {
    hasTriedUpgrade = true
    $.ui.log('voice-replies: restarting an older voice server', { to: 'debug' })
    // Servers before API 2 have no /shutdown, so stop the process itself.
    commands.push(
      "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*voice-replies*server.py*' -and $_.CommandLine -notlike '*--check*' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      'Start-Sleep -Milliseconds 500',
    )
  }
  commands.push(
    `Copy-Item -LiteralPath ${psQuote(`${$.plugin.root}\\server\\server.py`)} -Destination (Join-Path $d 'server.py') -Force -ErrorAction SilentlyContinue`,
    "Start-Process -WindowStyle Hidden -FilePath (Join-Path $d 'venv\\Scripts\\pythonw.exe') " +
      "-ArgumentList ('\"' + (Join-Path $d 'server.py') + '\"') -WorkingDirectory $d",
  )
  try {
    await $.process.run(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', commands.join('; ')],
      { timeoutMs: 30000 },
    )
  } catch {
    await update($, engine, () => 'windows')
    return false
  }
  // The model takes a few seconds to load onto the GPU.
  for (let i = 0; i < 60; i += 1) {
    await wait($, 1000)
    const up = await serverApi($)
    if (up >= API) {
      await update($, engine, () => 'kokoro')
      return true
    }
  }
  await update($, engine, () => 'windows')
  return false
}

// Runs server\setup.ps1, which checks the GPU, picks GPU or CPU, installs Kokoro and tests it.
// Each "==> step" line shows in the panel and the status line; the last lines explain a failure.
async function installKokoro($: EngineInterface, mode: 'auto' | 'gpu' | 'cpu'): Promise<void> {
  const tail: string[] = []
  let partial = ''
  let done = ''
  let choice = ''
  const onLine = async (raw: string) => {
    const line = raw.trim()
    if (line === '') return
    tail.push(line)
    if (tail.length > 8) tail.shift()
    if (line.startsWith('==> ')) {
      const step = line.slice(4)
      await update($, installing, () => step)
      $.ui.status(`Kokoro install: ${step}`)
    } else if (line.startsWith('Kokoro will run on the ')) {
      choice = line
    } else if (line.startsWith('DONE: ')) {
      done = line.slice(6)
    }
  }

  let code: number | null = null
  try {
    const child = $.process.spawn({
      argv: [
        'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', `${$.plugin.root}\\server\\setup.ps1`, '-Device', mode,
      ],
    })
    for await (const { text } of child) {
      const lines = (partial + text).split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) await onLine(line)
    }
    await onLine(partial)
    code = (await child.result).code
  } catch (err) {
    tail.push(String(err))
  }

  await update($, installing, () => '')
  $.ui.status(undefined)
  if (code === 0 && done !== '') {
    hasWarnedSetup = false
    $.ui.toast(done)
    $.ui.log(`voice-replies: ${choice} ${done}`, { to: 'debug' })
    await ensureServer($)
    return
  }
  const why = tail.filter(l => !l.startsWith('At ') && !l.startsWith('+ ')).slice(-2).join(' ')
  $.ui.toast(`Kokoro install failed: ${why} Full log: %USERPROFILE%\\.claude\\voice-replies\\logs\\install.log`)
  await update($, engine, () => 'windows')
}

// A pause built on $.clock.after, which runs outside any hook's time budget.
function wait($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => void $.clock.after(ms, resolve))
}

// Stops this session's voice, or with 'all' every session's. Other sessions keep their place.
async function stopSpeaking($: EngineInterface, scope: 'session' | 'all' = 'session'): Promise<void> {
  runId += 1
  const pid = speakerPid
  speakerPid = undefined
  await update($, status, () => 'idle')
  try {
    await $.http.fetch(`${SERVER}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scope === 'all' ? {} : { session: sessionKey }),
    })
  } catch {
    // Server not running: nothing to stop there.
  }
  if (pid === undefined) return
  try {
    await $.process.run(['taskkill', '/PID', String(pid), '/T', '/F'], { timeoutMs: 5000 })
  } catch {
    // Already gone, or not Windows: nothing to stop.
  }
}

async function speakReply($: EngineInterface, answer: string): Promise<void> {
  await stopSpeaking($)
  const id = runId
  await update($, status, () => 'writing')

  const script = await toSpeech($, answer)
  if (id !== runId) return
  if (script !== '') {
    await update($, last, () => script)
    await saveSettings($, { last: script })
  }
  await playScript($, script, id, 'idle')
}

async function replayLast($: EngineInterface): Promise<void> {
  const script = await read($, last)
  if (script !== '') await speakScript($, script)
}

// Plays at once, or after what other sessions have queued: /voice test, replay and Play.
async function speakScript($: EngineInterface, script: string): Promise<void> {
  await stopSpeaking($)
  await playScript($, script, runId, 'queue')
}

async function playWaiting($: EngineInterface): Promise<void> {
  const held = await read($, waiting)
  if (held.length === 0) return
  await update($, waiting, () => [])
  await speakScript($, held.join('\n\n'))
}

// 'idle': speak only if no session is speaking, else hold the reply for Play.
// 'queue': speak after what is already queued.
async function playScript($: EngineInterface, script: string, id: number, when: 'idle' | 'queue'): Promise<void> {
  if (script === '') {
    await update($, status, () => 'idle')
    return
  }
  // The person's name goes on at play time, so a held or replayed script never says it twice.
  // It is a line of its own: the voice server pauses between lines, as a person does after
  // saying someone's name.
  const you = cleanName(await read($, callMe))
  const spoken = you === '' ? script : `${you},\n${script}`
  try {
    const outcome = await speakKokoro($, spoken, id, when)
    if (outcome === 'busy') {
      await holdReply($, script)
    } else if (outcome === 'failed' && id === runId) {
      await setStatus($, 'speaking')
      await speakWindows($, spoken, id)
    }
  } catch (err) {
    $.ui.log(`voice-replies: could not speak: ${String(err)}`, { to: 'debug' })
  } finally {
    if (id === runId) await update($, status, () => 'idle')
  }
}

// Another session is speaking: keep the reply for Play and tell the person where it is.
async function holdReply($: EngineInterface, script: string): Promise<void> {
  const held = [...(await read($, waiting)), script].slice(-MAX_WAITING)
  await update($, waiting, () => held)
  $.ui.toast('Another session is speaking. This reply waits: press Play to hear it.')
  // The notification names the session even when the voice does not say its name.
  const name = (await read($, label)) || (await defaultLabel($))
  try {
    await $.ui.notify(
      `${name === '' ? 'A session' : name} has a reply waiting. Press Play in that session to hear it.`,
      { title: 'Voice replies' },
    )
  } catch (err) {
    $.ui.log(`voice-replies: could not notify: ${String(err)}`, { to: 'debug' })
  }
}

async function toSpeech($: EngineInterface, answer: string): Promise<string> {
  const limit = LIMITS[await read($, length)]
  const reply = await $.model.complete({
    model: 'haiku',
    system: [{ text: limit.rules, cache: true }],
    prompt: `Reply to convert:\n\n${answer.slice(0, 20000)}`,
    maxTokens: limit.maxTokens,
    effort: 'low',
    timeoutMs: limit.timeoutMs,
  })
  const text = reply.isAnswered ? reply.text : stripMarkdown(answer)

  return clipAtSentence(speakable(text.trim()), limit.chars)
}

// Cuts a script that is too long at the end of a sentence, never in the middle of a word.
function clipAtSentence(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const end = Math.max(...['. ', '! ', '? ', '.\n', '!\n', '?\n'].map(mark => head.lastIndexOf(mark)))
  if (end >= max / 2) return head.slice(0, end + 1)
  const space = head.lastIndexOf(' ')
  return `${space > 0 ? head.slice(0, space) : head}.`
}

// Kokoro on the GPU. 'failed' only when the server did not take the text, so the caller
// falls back to the Windows voice; 'busy' when `when` is 'idle' and another session speaks.
// Once Kokoro has taken the text it never falls back: the server answers /speak at once and
// this polls /status until the voice ends.
async function speakKokoro(
  $: EngineInterface,
  text: string,
  id: number,
  when: 'idle' | 'queue',
): Promise<'spoken' | 'busy' | 'failed'> {
  if (!(await ensureServer($))) return 'failed'
  let job: number
  try {
    const name = await read($, label)
    const res = await $.http.fetch(`${SERVER}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: await read($, voice),
        speed: Number(await read($, speed)),
        session: sessionKey,
        tag: name.replace(/[-_.]+/g, ' ').trim(),
        when,
      }),
    })
    const body = res.ok ? (JSON.parse(res.text) as { id?: unknown; state?: unknown }) : {}
    if (body.state === 'busy') return 'busy'
    if (typeof body.id !== 'number') {
      $.ui.log(`voice-replies: Kokoro said ${res.status}: ${res.text}`, { to: 'debug' })
      await update($, engine, () => 'windows')
      return 'failed'
    }
    job = body.id
  } catch {
    await update($, engine, () => 'windows')
    return 'failed'
  }
  await update($, engine, () => 'kokoro')

  // Kokoro has it now. Wait until it ends, is stopped, or the server goes quiet.
  let misses = 0
  for (let i = 0; i < MAX_POLLS && id === runId; i += 1) {
    await wait($, 500)
    try {
      const res = await $.http.fetch(`${SERVER}/status?id=${job}`)
      const { state } = JSON.parse(res.text) as { state?: string }
      misses = 0
      if (state !== 'queued' && state !== 'speaking') break
      if (id === runId) await setStatus($, state)
    } catch {
      misses += 1
      if (misses >= 6) break
    }
  }
  return 'spoken'
}

// Windows: the built-in SAPI voice through PowerShell, which prints its PID so Stop can kill it.
// Elsewhere (no powershell.exe): the platform voice through $.audio.speak.
const PS_SPEAK = [
  '[Console]::InputEncoding = [Text.Encoding]::UTF8',
  '[Console]::Out.WriteLine($PID); [Console]::Out.Flush()',
  '$t = [Console]::In.ReadToEnd()',
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.Speak($t)',
].join('; ')

async function speakWindows($: EngineInterface, text: string, id: number): Promise<void> {
  let started = false
  try {
    const child = $.process.spawn({
      argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_SPEAK],
      input: text,
    })
    for await (const { stream, text: out } of child) {
      started = true
      if (stream !== 'stdout' || speakerPid !== undefined) continue
      const pid = Number.parseInt(out.trim(), 10)
      if (Number.isFinite(pid)) speakerPid = pid
      if (id !== runId) await stopSpeaking($)
    }
    if (id === runId) speakerPid = undefined
    return
  } catch (err) {
    if (started) throw err
  }
  await $.audio.speak(text)
}

const SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty']
const ORDINAL: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
}
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// 0 to 59 in words: "seven", "forty-five".
function numberWords(n: number): string {
  if (n < 20) return SMALL[n] ?? String(n)
  const ones = n % 10
  const tens = TENS[Math.floor(n / 10)] ?? String(n)
  return ones === 0 ? tens : `${tens}-${SMALL[ones]}`
}

// 1 to 31 as a spoken ordinal: "first", "sixteenth", "twenty-second".
function ordinalWords(n: number): string {
  const words = numberWords(n)
  const parts = words.split('-')
  const tail = parts.pop() ?? ''
  const said = ORDINAL[tail] ?? (tail.endsWith('y') ? `${tail.slice(0, -1)}ieth` : `${tail}th`)
  return [...parts, said].join('-')
}

// A clock time as a person says it: "eight o'clock", "eight thirty", "eight oh five in the
// morning", "noon". `meridiem` is 'a' or 'p' when the text gave AM or PM.
function sayTime(hour: number, minute: number, meridiem: string | undefined): string {
  const isPm = meridiem === 'p' || (meridiem === undefined && hour > 12)
  const isAm = meridiem === 'a' || (meridiem === undefined && hour === 0)
  let h = hour % 12
  if (h === 0 && (isAm || isPm || hour === 12)) h = 12
  if (minute === 0 && h === 12 && isPm) return 'noon'
  if (minute === 0 && h === 12 && isAm) return 'midnight'
  const mins = minute === 0 ? '' : minute < 10 ? ` oh ${numberWords(minute)}` : ` ${numberWords(minute)}`
  const clock = `${numberWords(h)}${mins}`
  if (!isAm && !isPm) return minute === 0 ? `${clock} o'clock` : clock
  const base = h === 12 ? 0 : h
  const part = isAm
    ? base === 0 ? 'at night' : 'in the morning'
    : base < 6 ? 'in the afternoon' : base < 9 ? 'in the evening' : 'at night'
  return `${clock} ${part}`
}

// Keeps a sentence's full stop when "a.m." or "p.m." ended the sentence.
function keepStop(match: string, rest: string): string {
  return match.endsWith('.') && (rest === '' || /^\s+[A-Z]/.test(rest)) ? '.' : ''
}

// The last pass over every script before the voice gets it: rewrites what text-to-speech
// voices read badly ("8:00" as "eight zero zero") into the words a person would say.
// Haiku is asked to do this too; this catches what it leaves, and the plain-text fallback.
function speakable(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/[*`#]+/g, '')
    // ISO dates: 2026-10-16 -> October sixteenth, 2026
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => {
      const month = MONTHS[Number(mo) - 1]
      const day = Number(d)
      return month === undefined || day < 1 || day > 31 ? m : `${month} ${ordinalWords(day)}, ${y}`
    })
    // Clock times, with or without AM / PM: 8:00 AM, 8:30, 17:45, 9:05 p.m.
    .replace(
      /\b([01]?\d|2[0-3]):([0-5]\d)(?![\d:])(?:\s?([AaPp])\.?\s?[Mm]\b\.?)?/g,
      (m: string, h: string, min: string, ap: string | undefined, at: number, all: string) =>
        sayTime(Number(h), Number(min), ap?.toLowerCase()) + keepStop(m, all.slice(at + m.length)),
    )
    // Whole hours with AM / PM: 8am, 8 PM, 11 p.m.
    .replace(
      /\b(1[0-2]|0?[1-9])\s?([AaPp])\.?\s?[Mm]\b\.?/g,
      (m: string, h: string, ap: string, at: number, all: string) =>
        sayTime(Number(h), 0, ap.toLowerCase()) + keepStop(m, all.slice(at + m.length)),
    )
    // Versions: v1.5.0 -> version 1 point 5 point 0
    .replace(/\bv(\d+(?:\.\d+)+)\b/g, (_m, v: string) => `version ${v.split('.').join(' point ')}`)
    .replace(/\b(\d+)\.(\d+)\.(\d+)\b/g, '$1 point $2 point $3')
    // Ranges and amounts: 5-15 -> 5 to 15, 95% -> 95 percent, 1.2x -> 1.2 times
    .replace(/(\d)\s?[-–]\s?(\d)/g, '$1 to $2')
    .replace(/(\d)\s?%/g, '$1 percent')
    .replace(/\b(\d+(?:\.\d+)?)x\b/g, '$1 times')
    .replace(/~\s?(?=\d)/g, 'about ')
    // Symbols and abbreviations said as words.
    .replace(/\s&\s/g, ' and ')
    .replace(/\s?(?:->|→|=>)\s?/g, ' to ')
    .replace(/\be\.g\.,?/gi, 'for example,')
    .replace(/\bi\.e\.,?/gi, 'that is,')
    .replace(/\betc\./gi, 'and so on.')
    .replace(/\bvs\.?(?=\s)/gi, 'versus')
    .replace(/\bw\/(?=\s)/gi, 'with')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// The name the voice calls the person, without the punctuation the voice adds itself.
function cleanName(name: string): string {
  return name.trim().replace(/[\s,.;:!?\-–—]+$/, '').slice(0, MAX_NAME)
}

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
}
