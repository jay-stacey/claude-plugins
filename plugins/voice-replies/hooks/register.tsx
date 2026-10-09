import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VoiceEngine, VoiceStatus } from '../types'

const isOn = atom({ plugin: 'voice-replies', key: 'isOn' } as const, true)
const status = atom({ plugin: 'voice-replies', key: 'status' } as const, 'idle' as VoiceStatus)
const voice = atom({ plugin: 'voice-replies', key: 'voice' } as const, 'af_heart')
const speed = atom({ plugin: 'voice-replies', key: 'speed' } as const, '1.0')
const engine = atom({ plugin: 'voice-replies', key: 'engine' } as const, 'starting' as VoiceEngine)

const MAX_SPOKEN_CHARS = 1500
const SERVER = 'http://127.0.0.1:47861'

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

const SPEECH_RULES = `You turn a coding assistant's chat reply into a short script that a text-to-speech voice reads aloud to the person who asked.

Rules:
- Output plain spoken sentences only. No markdown, bullets, headings, tables, code, emojis or URLs.
- Lead with the outcome: what was done, whether it worked, what the person needs to do next.
- Keep it under 80 words. A short, plain reply can stay almost word for word.
- Never read code, commands, file paths, IDs or hashes character by character. Say what they are ("the config file", "a git command") instead.
- Say numbers, versions and counts naturally.
- If the reply asks the person a question, end with that question.
- Output only the script, nothing before or after it.`

// A speech run in flight. `runId` drops stale work; `speakerPid` lets Stop kill the Windows voice.
let runId = 0
let speakerPid: number | undefined
let hasWarnedSetup = false

function voiceLabel(name: string): string {
  const accent = name.startsWith('b') ? 'UK' : 'US'
  const gender = name[1] === 'm' ? 'male' : 'female'
  const first = name.slice(3)
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} (${accent} ${gender})`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await Promise.all([
      $.store.get('isOn'),
      $.store.get('voice'),
      $.store.get('speed'),
    ])
    const [savedOn, savedVoice, savedSpeed] = saved
    if (typeof savedOn === 'boolean') await update($, isOn, () => savedOn)
    if (typeof savedVoice === 'string' && (VOICES as readonly string[]).includes(savedVoice)) {
      await update($, voice, () => savedVoice)
    }
    if (typeof savedSpeed === 'string' && (SPEEDS as readonly string[]).includes(savedSpeed)) {
      await update($, speed, () => savedSpeed)
    }
    await update($, status, () => 'idle')
    await $.command.register({
      name: 'voice',
      description: 'Voice replies: on, off, stop, voice <name>, speed <0.8-1.5>, voices, test',
      argumentHint: '[on|off|stop|voice <name>|speed <n>|voices|test]',
    })
    // Warm the server up only where someone is watching; elsewhere it starts on first use.
    if ((await $.session.surfaces()).length > 0) $.clock.after(0, () => void ensureServer($))

    return next(e)
  })

  on('command.run', { command: 'voice' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (word === 'stop') {
      await stopSpeaking($)
      return { text: 'Stopped speaking.' }
    }
    if (word === 'voices') {
      return { text: `Voices: ${VOICES.map(v => `${v} = ${voiceLabel(v)}`).join(', ')}` }
    }
    if (word === 'voice') {
      if (!(VOICES as readonly string[]).includes(value)) {
        return { text: `Unknown voice "${value}". Type /voice voices to list them.` }
      }
      await setVoice($, value)
      return { text: `Voice set to ${voiceLabel(value)}.` }
    }
    if (word === 'speed') {
      if (!(SPEEDS as readonly string[]).includes(value)) {
        return { text: `Speed must be one of ${SPEEDS.join(', ')}.` }
      }
      await setSpeed($, value)
      return { text: `Speed set to ${value}.` }
    }
    if (word === 'test') {
      $.clock.after(0, () => void speakScript($, 'This is how voice replies will sound.'))
      return { text: 'Playing a test phrase.' }
    }
    const want = word === 'on' ? true : word === 'off' ? false : !(await read($, isOn))
    await setOn($, want)

    return { text: want ? 'Voice replies are on.' : 'Voice replies are off.' }
  })

  // A new prompt means the person moved on: stop talking over them.
  on('prompt.submit', ($, e, next) => {
    void stopSpeaking($)

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
    if (Select === undefined) return above

    const enabled = await read($, isOn)
    const now = await read($, status)
    const chosen = await read($, voice)
    const pace = await read($, speed)
    const via = await read($, engine)
    // Say the engine only when it is not the normal one (Kokoro on the GPU).
    const note =
      now === 'writing' ? 'preparing' : now === 'speaking' ? 'speaking' : via === 'windows' ? 'Windows voice' : via === 'starting' ? 'starting' : ''

    return (
      <Box flexDirection="column" rowGap={1}>
        {above}
        <Box flexDirection="row" gap={1} alignItems="center" borderStyle="round" borderDimColor paddingX={1}>
          <Text dimColor>Voice replies</Text>
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
          {now !== 'idle' && <Button key="stop" label="Stop" dimColor onPress={() => stopSpeaking($)} />}
        </Box>
      </Box>
    )
  })
}

async function setOn($: EngineInterface, value: boolean): Promise<void> {
  await update($, isOn, () => value)
  await $.store.set('isOn', value)
  if (!value) await stopSpeaking($)
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
  await $.store.set('voice', value)
}

async function setSpeed($: EngineInterface, value: string): Promise<void> {
  await update($, speed, () => value)
  await $.store.set('speed', value)
}

async function isServerUp($: EngineInterface): Promise<boolean> {
  try {
    const res = await $.http.fetch(`${SERVER}/health`)
    return res.ok
  } catch {
    return false
  }
}

// Starts the shared Kokoro server if it is not running. It runs hidden, outlives this
// session, and exits by itself after two idle hours.
async function ensureServer($: EngineInterface): Promise<boolean> {
  if (await isServerUp($)) {
    await update($, engine, () => 'kokoro')
    return true
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
      $.ui.toast('Kokoro is not set up, so replies use the Windows voice. Run server\\setup.ps1 from the voice-replies plugin.')
    }
    return false
  }
  await update($, engine, () => 'starting')
  try {
    await $.process.run(
      [
        'powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -WindowStyle Hidden -FilePath '${dir}\\venv\\Scripts\\pythonw.exe' -ArgumentList '"${dir}\\server.py"' -WorkingDirectory '${dir}'`,
      ],
      { timeoutMs: 15000 },
    )
  } catch {
    await update($, engine, () => 'windows')
    return false
  }
  // The model takes a few seconds to load onto the GPU.
  for (let i = 0; i < 60; i += 1) {
    await wait($, 1000)
    if (await isServerUp($)) {
      await update($, engine, () => 'kokoro')
      return true
    }
  }
  await update($, engine, () => 'windows')
  return false
}

// A pause built on $.clock.after, which runs outside any hook's time budget.
function wait($: EngineInterface, ms: number): Promise<void> {
  return new Promise(resolve => void $.clock.after(ms, resolve))
}

async function stopSpeaking($: EngineInterface): Promise<void> {
  runId += 1
  const pid = speakerPid
  speakerPid = undefined
  await update($, status, () => 'idle')
  try {
    await $.http.fetch(`${SERVER}/stop`, { method: 'POST' })
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
  await playScript($, script, id)
}

async function speakScript($: EngineInterface, script: string): Promise<void> {
  await stopSpeaking($)
  await playScript($, script, runId)
}

async function playScript($: EngineInterface, script: string, id: number): Promise<void> {
  if (script === '') {
    await update($, status, () => 'idle')
    return
  }
  await update($, status, () => 'speaking')
  try {
    const spoke = await speakKokoro($, script, id)
    if (!spoke && id === runId) await speakWindows($, script, id)
  } catch (err) {
    $.ui.log(`voice-replies: could not speak: ${String(err)}`, { to: 'debug' })
  } finally {
    if (id === runId) await update($, status, () => 'idle')
  }
}

async function toSpeech($: EngineInterface, answer: string): Promise<string> {
  const reply = await $.model.complete({
    model: 'haiku',
    system: [{ text: SPEECH_RULES, cache: true }],
    prompt: `Reply to convert:\n\n${answer.slice(0, 20000)}`,
    maxTokens: 400,
    effort: 'low',
    timeoutMs: 15000,
  })
  const text = reply.isAnswered ? reply.text : stripMarkdown(answer)

  return text.trim().slice(0, MAX_SPOKEN_CHARS)
}

// Kokoro on the GPU. Returns false only when the server did not take the text, so the
// caller falls back to the Windows voice. Once Kokoro has taken the text it never falls
// back: the server answers /speak at once and this polls /status until the voice ends.
async function speakKokoro($: EngineInterface, text: string, id: number): Promise<boolean> {
  if (!(await isServerUp($)) && !(await ensureServer($))) return false
  let job: number
  try {
    const res = await $.http.fetch(`${SERVER}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: await read($, voice),
        speed: Number(await read($, speed)),
      }),
    })
    const body = res.ok ? (JSON.parse(res.text) as { id?: unknown }) : {}
    if (typeof body.id !== 'number') {
      $.ui.log(`voice-replies: Kokoro said ${res.status}: ${res.text}`, { to: 'debug' })
      await update($, engine, () => 'windows')
      return false
    }
    job = body.id
  } catch {
    await update($, engine, () => 'windows')
    return false
  }
  await update($, engine, () => 'kokoro')

  // Kokoro has it now. Wait until it ends, is stopped, or the server goes quiet.
  let misses = 0
  for (let i = 0; i < 1200 && id === runId; i += 1) {
    await wait($, 500)
    try {
      const res = await $.http.fetch(`${SERVER}/status?id=${job}`)
      const { state } = JSON.parse(res.text) as { state?: string }
      misses = 0
      if (state !== 'queued' && state !== 'speaking') break
    } catch {
      misses += 1
      if (misses >= 6) break
    }
  }
  return true
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
