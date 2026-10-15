export type VoiceStatus = 'idle' | 'writing' | 'queued' | 'speaking'
export type VoiceEngine = 'kokoro' | 'windows' | 'starting'
export type VoiceLength = 'short' | 'full'

declare module 'claude-code' {
  interface PluginState {
    'voice-replies': {
      isOn: boolean
      status: VoiceStatus
      voice: string
      speed: string
      length: VoiceLength
      engine: VoiceEngine
      install: string
      // Speech scripts of this session's replies that wait for Play, oldest first.
      waiting: string[]
      // The last speech script this session spoke or held, for Replay. '' when none yet.
      last: string
      // What the voice says first when it moves to this session from another one.
      label: string
    }
  }
}
