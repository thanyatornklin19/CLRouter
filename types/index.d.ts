export type ClrouterMode = 'ask' | 'auto' | 'suggest' | 'off'

export type ClrouterDecision = {
  /** The first line of the prompt, cut short. */
  prompt: string
  /** Characters scored (the typed prompt) and sent (with the host's blocks). */
  chars: { typed: number; sent: number }
  recommended: 'haiku' | 'sonnet' | 'opus'
  reasons: readonly string[]
  /** `heuristic` or `model`: which judge settled it. */
  judge: 'heuristic' | 'model'
  /** The model the turn was sent to, or null when it kept the session's. */
  routedTo: string | null
}

declare module 'claude-code' {
  interface PluginState {
    clrouter: {
      /** This session's mode, set by `/clrouter <mode>`; null: the configured one. */
      mode: ClrouterMode | null
      last: ClrouterDecision | null
    }
  }
}
