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
const API = 2
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

const SHORT_RULES = `You turn a coding assistant's chat reply into a short script that a text-to-speech voice reads aloud to the person who asked.

Rules:
- Output plain spoken sentences only. No markdown, bullets, headings, tables, code, emojis or URLs.
- Lead with the outcome: what was done, whether it worked, what the person needs to do next.
- Keep it under 80 words. A short, plain reply can stay almost word for word.
- Never read code, commands, file paths, IDs or hashes character by character. Say what they are ("the config file", "a git command") instead.
- Say numbers, versions and counts naturally.
- If the reply asks the person a question, end with that question.
- Output only the script, nothing before or after it.`

const FULL_RULES = `You turn a coding assistant's chat reply into a script that a text-to-speech voice reads aloud, in full, to the person who asked.

Rules:
- Output plain spoken sentences only. No markdown, bullets, headings, tables, code, emojis or URLs.
- Keep every point of the reply, in the same order. Do not summarize and do not leave points out.
- Turn lists and tables into sentences, one item or row at a time.
- Never read code, commands, file paths, IDs or hashes character by character. Say what they are ("the config file", "a git command") instead.
- Say numbers, versions and counts naturally.
- If the reply asks the person a question, end with that question.
- Output only the script, nothing before or after it.`

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
      const name = rest.join(' ').trim().slice(0, MAX_NAME)
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

    return (
      <Box flexDirection="column" rowGap={1}>
        {above}
        <Box flexDirection="row" gap={1} alignItems="center" borderStyle="round" borderDimColor paddingX={1}>
          <Text dimColor>Voice replies</Text>
          {held.length > 0 && (
            <Text key="waiting">{held.length === 1 ? '1 reply waiting' : `${held.length} replies waiting`}</Text>
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
          <Box flexGrow={1} />
          <Select
            key="voice"
            label={note === '' ? 'Voice' : `Voice (${note})`}
            value={enabled ? chosen : OFF}
            options={[
              { value: OFF, label: 'Off' },
              ...VOICES.map(v => ({ value: v, label: voiceLabel(v) })),
            ]}
            onSelect={(value: string) => void pickVoice($, value)}
          />
          {enabled && (
            <Select
              key="speed"
              label="Speed"
              value={pace}
              options={SPEEDS.map(s => ({ value: s, label: `${s}x` }))}
              onSelect={(value: string) => void setSpeed($, value)}
            />
          )}
          {enabled && (
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
          )}
          {enabled && (
            <Input
              key="call"
              label="Call me"
              placeholder="your name"
              value={you}
              submitLabel="save"
              onSubmit={(value: string) => void setCallMe($, value.trim().slice(0, MAX_NAME))}
            />
          )}
          {now !== 'idle' && <Button key="stop" label="Stop" dimColor onPress={() => stopSpeaking($)} />}
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
  const you = await read($, callMe)
  const spoken = you === '' ? script : `${you}, ${script}`
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

  return clipAtSentence(text.trim(), limit.chars)
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
