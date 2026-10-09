export type VoiceStatus = 'idle' | 'writing' | 'speaking'
export type VoiceEngine = 'kokoro' | 'windows' | 'starting'

declare module 'claude-code' {
  interface PluginState {
    'voice-replies': {
      isOn: boolean
      status: VoiceStatus
      voice: string
      speed: string
      engine: VoiceEngine
    }
  }
}
